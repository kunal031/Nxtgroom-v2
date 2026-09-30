import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoDocumentClient } from "../config/dynamo.js";
import { conditionExpression, matchesFilter, sortDocuments } from "./dynamoFilter.js";
import { fromItem, isConditionFailure, toItem, upsertExpression } from "./dynamoItems.js";

/**
 * A DynamoDB table that answers the MongoDB collection calls the application
 * makes (findOne, countDocuments, updateOne, findOneAndUpdate, deleteOne,
 * deleteMany), so code written against a MongoDB collection runs unchanged.
 *
 * Items are keyed by `_id`. Lookups by anything else are answered from
 * sparse indexes over derived attributes, which the definition computes
 * from each document (derive). A filter is checked twice: in JavaScript to
 * choose candidates, then as a ConditionExpression on the write itself, so
 * a claim or guarded delete is atomic even though index reads may lag.
 *
 * Every write bumps `rev`. After a write, the derived attributes are brought
 * in line with the new document, on condition that no later write has
 * happened in between; if one has, its own follow-up does the same.
 */

const MAX_CLAIM_CANDIDATES = 25;

function unsupported(what) {
  return new Error(`Unsupported for DynamoDB: ${what}`);
}

function idOf(filter) {
  const id = filter?._id;
  if (typeof id === "string") return id;
  if (id?._bsontype === "ObjectId") return id.toHexString();
  return undefined;
}

function withoutId(filter) {
  const { _id: _ignored, ...rest } = filter || {};
  return rest;
}

/**
 * @param {object} definition
 * @param {() => string} definition.tableName
 * @param {(document: object) => object} definition.derive derived attributes; undefined removes one
 * @param {{ indexName: string, attribute: string, values: string[] }} definition.active
 *   the sparse index listing documents that non-key queries may need
 * @param {{ indexName: string, attribute: string, field: string }} [definition.byField]
 *   an index answering equality on one field (e.g. attendance_id)
 */
export function dynamoCollection(definition) {
  const client = () => getDynamoDocumentClient();
  const derivedNames = () => Object.keys(definition.derive({}));

  // rev 2 on items written whole (copy, mirror), so the next update of one
  // is never mistaken for the write that created it.
  function itemFromDocument(document) {
    const item = { ...toItem(document), rev: 2 };
    for (const [name, value] of Object.entries(definition.derive(document))) {
      if (value === undefined) delete item[name];
      else item[name] = value;
    }
    return item;
  }

  function documentFromItem(item) {
    if (!item) return null;
    const document = fromItem(item);
    delete document.rev;
    for (const name of derivedNames()) delete document[name];
    return document;
  }

  async function syncDerived(item) {
    const document = documentFromItem(item);
    const wanted = definition.derive(document);
    const expression = upsertExpression();
    const sets = [];
    const removes = [];
    for (const [name, value] of Object.entries(wanted)) {
      if (value === undefined) {
        if (item[name] !== undefined) removes.push(expression.name(name));
      } else if (item[name] !== value) {
        sets.push(`${expression.name(name)} = ${expression.value(value)}`);
      }
    }
    if (!sets.length && !removes.length) return;
    try {
      await client().send(new UpdateCommand({
        TableName: definition.tableName(),
        Key: { _id: item._id },
        UpdateExpression: [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""]
          .filter(Boolean).join(" "),
        ConditionExpression: `${expression.name("rev")} = ${expression.value(item.rev)}`,
        ExpressionAttributeNames: expression.names,
        ExpressionAttributeValues: expression.values,
      }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  async function get(id) {
    const { Item } = await client().send(new GetCommand({
      TableName: definition.tableName(),
      Key: { _id: id },
      ConsistentRead: true,
    }));
    return Item || null;
  }

  async function queryIndex(indexName, attribute, value) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await client().send(new QueryCommand({
        TableName: definition.tableName(),
        IndexName: indexName,
        KeyConditionExpression: "#key = :value",
        ExpressionAttributeNames: { "#key": attribute },
        ExpressionAttributeValues: { ":value": value },
        ExclusiveStartKey,
      }));
      items.push(...(page.Items || []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  /** Documents matching a filter that has no _id, read from the indexes. */
  async function candidates(filter) {
    const byField = definition.byField;
    const pinned = byField ? filter[byField.field] : undefined;
    let items;
    if (typeof pinned === "string" || pinned?._bsontype === "ObjectId") {
      items = await queryIndex(byField.indexName, byField.attribute, toItem(pinned));
    } else {
      const { indexName, attribute, values } = definition.active;
      items = (await Promise.all(values.map((value) => queryIndex(indexName, attribute, value)))).flat();
    }
    return items.map(documentFromItem).filter((document) => matchesFilter(document, filter));
  }

  /**
   * One conditional UpdateItem for MongoDB's { $set, $unset, $inc,
   * $setOnInsert }. Returns the new item, or null when the condition failed.
   */
  async function update(id, filter, mongoUpdate, { upsert = false } = {}) {
    for (const operator of Object.keys(mongoUpdate)) {
      if (!["$set", "$unset", "$inc", "$setOnInsert"].includes(operator)) throw unsupported(`update ${operator}`);
    }
    const expression = upsertExpression({
      set: mongoUpdate.$set || {},
      setOnInsert: upsert ? mongoUpdate.$setOnInsert : undefined,
    });
    const removes = Object.keys(mongoUpdate.$unset || {})
      .filter((field) => !(field in (mongoUpdate.$set || {})))
      .map((field) => expression.name(field));
    const adds = Object.entries(mongoUpdate.$inc || {})
      .map(([field, amount]) => `${expression.name(field)} ${expression.value(amount)}`);
    adds.push(`${expression.name("rev")} ${expression.value(1)}`);

    const rest = withoutId(filter);
    if (upsert && Object.keys(rest).length) throw unsupported("upsert with conditions other than _id");
    const condition = conditionExpression(rest, expression);
    const conditions = [
      ...(upsert ? [] : [`attribute_exists(${expression.name("_id")})`]),
      ...(condition ? [condition] : []),
    ];

    try {
      const { Attributes } = await client().send(new UpdateCommand({
        TableName: definition.tableName(),
        Key: { _id: id },
        UpdateExpression: [
          expression.clauses.length ? `SET ${expression.clauses.join(", ")}` : "",
          removes.length ? `REMOVE ${removes.join(", ")}` : "",
          `ADD ${adds.join(", ")}`,
        ].filter(Boolean).join(" "),
        ...(conditions.length ? { ConditionExpression: conditions.join(" AND ") } : {}),
        ExpressionAttributeNames: expression.names,
        ExpressionAttributeValues: expression.values,
        ReturnValues: "ALL_NEW",
      }));
      await syncDerived(Attributes);
      return Attributes;
    } catch (error) {
      if (isConditionFailure(error)) return null;
      throw error;
    }
  }

  async function deleteWhere(id, filter) {
    const expression = upsertExpression();
    const condition = conditionExpression(withoutId(filter), expression);
    try {
      const { Attributes } = await client().send(new DeleteCommand({
        TableName: definition.tableName(),
        Key: { _id: id },
        ...(condition ? {
          ConditionExpression: condition,
          ExpressionAttributeNames: expression.names,
          ...(Object.keys(expression.values).length ? { ExpressionAttributeValues: expression.values } : {}),
        } : {}),
        ReturnValues: "ALL_OLD",
      }));
      return Attributes ? 1 : 0;
    } catch (error) {
      if (isConditionFailure(error)) return 0;
      throw error;
    }
  }

  return {
    itemFromDocument,
    documentFromItem,

    async findOne(filter = {}, { sort } = {}) {
      const id = idOf(filter);
      if (id !== undefined) {
        const document = documentFromItem(await get(id));
        return document && matchesFilter(document, withoutId(filter)) ? document : null;
      }
      return sortDocuments(await candidates(filter), sort)[0] || null;
    },

    async countDocuments(filter = {}) {
      const id = idOf(filter);
      if (id !== undefined) return (await this.findOne(filter)) ? 1 : 0;
      return (await candidates(filter)).length;
    },

    async updateOne(filter, mongoUpdate, options = {}) {
      const id = idOf(filter);
      if (id === undefined) throw unsupported("updateOne without _id");
      const item = await update(id, filter, mongoUpdate, options);
      if (!item) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      // rev is 1 only after the update that created the item; items written
      // whole (copy, mirror) start at 2.
      const inserted = Boolean(options.upsert) && item.rev === 1;
      return { matchedCount: inserted ? 0 : 1, modifiedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    },

    async findOneAndUpdate(filter, mongoUpdate, { sort, returnDocument = "before", upsert = false } = {}) {
      if (returnDocument !== "after") throw unsupported("findOneAndUpdate returning the document before");
      const id = idOf(filter);
      if (id !== undefined) return documentFromItem(await update(id, filter, mongoUpdate, { upsert }));
      if (upsert) throw unsupported("findOneAndUpdate upsert without _id");
      // Oldest first, as MongoDB's sort would; a candidate another worker
      // took first fails its condition and the next one is tried.
      const ordered = sortDocuments(await candidates(filter), sort).slice(0, MAX_CLAIM_CANDIDATES);
      for (const candidate of ordered) {
        const item = await update(candidate._id, { ...filter, _id: candidate._id }, mongoUpdate);
        if (item) return documentFromItem(item);
      }
      return null;
    },

    async deleteOne(filter) {
      const id = idOf(filter);
      if (id !== undefined) return { deletedCount: await deleteWhere(id, filter) };
      const [first] = await candidates(filter);
      return { deletedCount: first ? await deleteWhere(first._id, { ...filter, _id: first._id }) : 0 };
    },

    async deleteMany(filter = {}) {
      const id = idOf(filter);
      if (id !== undefined) return { deletedCount: await deleteWhere(id, filter) };
      let deletedCount = 0;
      for (const document of await candidates(filter)) {
        deletedCount += await deleteWhere(document._id, { ...filter, _id: document._id });
      }
      return { deletedCount };
    },

    /** Replaces a whole document, for copying and mirroring. */
    async putDocument(document) {
      await client().send(new PutCommand({
        TableName: definition.tableName(),
        Item: { ...itemFromDocument(document), rev: 2 },
      }));
    },

    async getDocument(id) {
      return documentFromItem(await get(id));
    },

    async deleteDocument(id) {
      await deleteWhere(id, {});
    },

    /** The ids a filter matches, for mirroring a deleteMany. */
    async findIds(filter = {}) {
      const id = idOf(filter);
      if (id !== undefined) return (await this.findOne(filter)) ? [id] : [];
      return (await candidates(filter)).map((document) => document._id);
    },
  };
}
