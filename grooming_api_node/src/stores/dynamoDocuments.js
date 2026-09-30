import { randomUUID } from "node:crypto";
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { dynamoTableName, getDynamoDocumentClient } from "../config/dynamo.js";
import { getPath, matchesFilter, sortDocuments } from "./dynamoFilter.js";
import { fromItem, isConditionFailure, toItem } from "./dynamoItems.js";
import { applyUpdate, documentsEqual, project, upsertDocument } from "./dynamoUpdate.js";

/**
 * DynamoDB tables for the collections that take part in MongoDB
 * transactions and unique indexes: attendance, instructors, users, boas,
 * colleges, password_resets. Each answers the MongoDB collection calls the
 * application makes, so the routes keep their MongoDB-shaped code.
 *
 * Writes read the document, apply the MongoDB update in JavaScript
 * (dynamoUpdate.js) and write it back on condition that its version, rev,
 * is unchanged; a lost race is retried. Inside a transaction (a session
 * from withDynamoTransaction) the writes are collected and committed
 * together in one TransactWriteItems, with every document the transaction
 * read checked unchanged: the guarantee MongoDB's snapshot transactions
 * gave the guarded create, update and delete paths.
 *
 * Unique indexes become reservation items in the unique_keys table, written
 * in the same TransactWriteItems as the document. A reservation that
 * already exists raises the same error as MongoDB (code 11000), so every
 * existing duplicate handler keeps working.
 *
 * Reads are planned per collection: a filter pinning _id reads those items;
 * one the collection's plan() recognises queries an index; anything else
 * scans, which only small collections allow.
 */

const MAX_WRITE_ATTEMPTS = 6;
const BATCH_GET_SIZE = 100;
export const UNIQUE_KEYS_STORE = "unique_keys";

export function duplicateKeyError(detail) {
  const error = new Error(`E11000 duplicate key error: ${detail}`);
  error.name = "MongoServerError";
  error.code = 11000;
  return error;
}

export function writeConflictError(detail) {
  const error = new Error(`Write conflict: ${detail}`);
  error.name = "WriteConflict";
  error.code = 112;
  return error;
}

function client() {
  return getDynamoDocumentClient();
}

function idString(id) {
  if (id?._bsontype === "ObjectId") return id.toHexString();
  return typeof id === "string" ? id : undefined;
}

/** The ids a filter pins _id to, or undefined when it does not. */
function pinnedIds(filter) {
  const condition = filter?._id;
  if (condition === undefined) return undefined;
  const single = idString(condition);
  if (single !== undefined) return [single];
  if (condition && typeof condition === "object" && Array.isArray(condition.$in)) {
    const ids = condition.$in.map(idString);
    if (ids.every((id) => id !== undefined)) return [...new Set(ids)];
  }
  return undefined;
}

function sessionKey(table, id) {
  return `${table}\u0000${id}`;
}

/** Items for many ids, consistent, in batches. */
async function batchGet(table, ids) {
  const found = [];
  for (let start = 0; start < ids.length; start += BATCH_GET_SIZE) {
    let keys = ids.slice(start, start + BATCH_GET_SIZE).map((id) => ({ _id: id }));
    for (let attempt = 1; keys.length; attempt += 1) {
      if (attempt > 8) throw new Error(`${table}: DynamoDB kept returning unprocessed keys`);
      const { Responses, UnprocessedKeys } = await client().send(new BatchGetCommand({
        RequestItems: { [table]: { Keys: keys, ConsistentRead: true } },
      }));
      found.push(...(Responses?.[table] || []));
      keys = UnprocessedKeys?.[table]?.Keys || [];
      if (keys.length) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 50 * 2 ** attempt)));
    }
  }
  return found;
}

async function paginate(command) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await client().send(command(ExclusiveStartKey));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * @param {object} definition
 * @param {string} definition.store collection name
 * @param {(document: object) => object} [definition.derive] index keys computed from a document
 * @param {Record<string, {attribute: string, sortAttribute?: string, include?: string[]}>} [definition.indexes]
 * @param {(filter: object) => (null | {queries: Array<{index: string, key: string, from?: string, to?: string}>})} [definition.plan]
 * @param {Array<{name: string, key: (document: object) => (string|null)}>} [definition.uniques]
 * @param {boolean} [definition.scanOk] whether an unplanned filter may scan (small collections only)
 * @param {() => string} [definition.newId] id for an upserted document
 */
export function documentCollection(definition) {
  const table = () => dynamoTableName(definition.store);
  const uniquesTable = () => dynamoTableName(UNIQUE_KEYS_STORE);
  const derive = definition.derive || (() => ({}));
  const derivedNames = Object.keys(derive({}));
  const uniques = definition.uniques || [];

  function itemFromDocument(document, rev) {
    const item = toItem(document);
    for (const [name, value] of Object.entries(derive(document))) {
      if (value === undefined || value === null || value === "") delete item[name];
      else item[name] = value;
    }
    if (rev !== undefined) item.rev = rev;
    return item;
  }

  function documentFromItem(item) {
    if (!item) return null;
    const document = fromItem(item);
    delete document.rev;
    for (const name of derivedNames) delete document[name];
    return document;
  }

  function reservationsOf(document) {
    const keys = new Map();
    if (!document) return keys;
    for (const unique of uniques) {
      const key = unique.key(document);
      if (key !== null && key !== undefined && key !== "") keys.set(`${definition.store}.${unique.name}#${key}`, unique.name);
    }
    return keys;
  }

  // ------------------------------------------------------------- reading

  /**
   * Full items matching a filter, with rev, overlaid with the session's own
   * uncommitted writes. Records what it read in the session.
   */
  async function readItems(filter, { session } = {}) {
    const ids = pinnedIds(filter);
    let items;
    if (ids) {
      items = ids.length === 1
        ? [(await client().send(new GetCommand({ TableName: table(), Key: { _id: ids[0] }, ConsistentRead: true }))).Item]
          .filter(Boolean)
        : await batchGet(table(), ids);
    } else {
      const plan = definition.plan?.(filter) || null;
      if (plan) {
        const keys = new Set();
        for (const query of plan.queries) {
          for (const item of await queryIndex(query)) keys.add(item._id);
        }
        items = await batchGet(table(), [...keys]);
      } else {
        if (!definition.scanOk) {
          throw new Error(`${definition.store}: no DynamoDB index answers ${JSON.stringify(Object.keys(filter || {}))}`);
        }
        items = await paginate((ExclusiveStartKey) => new ScanCommand({
          TableName: table(),
          ConsistentRead: true,
          ExclusiveStartKey,
        }));
      }
    }

    if (session) {
      for (const item of items) session.recordRead(table(), item._id, item.rev);
      if (ids) {
        for (const id of ids) {
          if (!items.some((item) => item._id === id)) session.recordRead(table(), id, null);
        }
      }
      items = session.overlay(table(), items, (item) => matchesFilter(documentFromItem(item), filter), ids);
    }
    return items.filter((item) => matchesFilter(documentFromItem(item), filter));
  }

  function keyCondition(query, index) {
    const names = { "#pk": index.attribute };
    const values = { ":pk": query.key };
    let expression = "#pk = :pk";
    if (index.sortAttribute && (query.from !== undefined || query.to !== undefined)) {
      names["#sk"] = index.sortAttribute;
      if (query.from !== undefined && query.to !== undefined) {
        expression += " AND #sk BETWEEN :from AND :to";
        values[":from"] = query.from;
        values[":to"] = query.to;
      } else if (query.from !== undefined) {
        expression += " AND #sk >= :from";
        values[":from"] = query.from;
      } else {
        expression += " AND #sk <= :to";
        values[":to"] = query.to;
      }
    }
    return { expression, names, values };
  }

  async function queryIndex(query) {
    const index = definition.indexes[query.index];
    const { expression, names, values } = keyCondition(query, index);
    return paginate((ExclusiveStartKey) => new QueryCommand({
      TableName: table(),
      IndexName: query.index,
      KeyConditionExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ExclusiveStartKey,
    }));
  }

  /**
   * Documents from index entries alone, when every field the filter, sort
   * and projection touch is copied into the index (its include list). Used
   * for read-only listings and statistics over many records; never inside
   * a transaction, since index entries can lag the table briefly.
   */
  function coveredQueries(filter, { sort, projection } = {}) {
    const plan = pinnedIds(filter) ? null : definition.plan?.(filter) || null;
    if (!plan) return null;
    const fields = new Set([...fieldsOf(filter), ...Object.keys(sort || {}), ...Object.keys(projection || {})]);
    if (!projection || !Object.keys(projection).length) return null;
    for (const query of plan.queries) {
      const include = new Set(["_id", ...(definition.indexes[query.index].include || [])]);
      for (const field of fields) if (!include.has(field.split(".")[0])) return null;
    }
    return plan.queries;
  }

  async function readDocuments(filter, options = {}) {
    const covered = options.session ? null : coveredQueries(filter, options);
    if (covered) {
      const byId = new Map();
      for (const query of covered) {
        for (const item of await queryIndex(query)) byId.set(item._id, item);
      }
      return [...byId.values()].map(documentFromItem).filter((document) => matchesFilter(document, filter));
    }
    return (await readItems(filter, options)).map(documentFromItem);
  }

  // ------------------------------------------------------------- writing

  /**
   * Writes one document change: before (null to insert) -> after (null to
   * delete). Outside a session it is written now; inside, queued for commit.
   * Returns false when the document changed since it was read.
   */
  async function write(beforeItem, after, { session, force = false } = {}) {
    const id = after?._id !== undefined ? idString(after._id) ?? String(after._id) : beforeItem?._id;
    const before = documentFromItem(beforeItem);
    const oldReservations = reservationsOf(before);
    const newReservations = reservationsOf(after);
    const operations = [];

    const guard = force ? {} : beforeItem
      ? { ConditionExpression: "#rev = :rev", ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": beforeItem.rev } }
      : { ConditionExpression: "attribute_not_exists(#id)", ExpressionAttributeNames: { "#id": "_id" } };
    if (after) {
      operations.push({ Put: { TableName: table(), Item: itemFromDocument({ ...after, _id: id }, (beforeItem?.rev || 0) + 1), ...guard } });
    } else {
      operations.push({ Delete: { TableName: table(), Key: { _id: id }, ...guard } });
    }
    for (const [key] of oldReservations) {
      if (!newReservations.has(key)) {
        operations.push({ Delete: { TableName: uniquesTable(), Key: { _id: key } } });
      }
    }
    for (const [key, name] of newReservations) {
      if (oldReservations.has(key)) continue;
      operations.push({
        Put: {
          TableName: uniquesTable(),
          Item: { _id: key, owner_store: definition.store, owner_id: id, unique: name },
          ...(force ? {} : {
            // A reservation this document already holds is its own; any
            // other owner is a duplicate.
            ConditionExpression: "attribute_not_exists(#id) OR (#store = :store AND #owner = :owner)",
            ExpressionAttributeNames: { "#id": "_id", "#store": "owner_store", "#owner": "owner_id" },
            ExpressionAttributeValues: { ":store": definition.store, ":owner": id },
          }),
        },
        duplicate: `${definition.store} ${name}`,
      });
    }

    if (session) {
      session.queue(table(), id, after ? { item: itemFromDocument({ ...after, _id: id }, (beforeItem?.rev || 0) + 1) } : null, operations);
      return true;
    }
    if (operations.length === 1) {
      const [{ Put, Delete }] = operations;
      try {
        await client().send(Put ? new PutCommand(Put) : new DeleteCommand(Delete));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) {
          if (!beforeItem && after && !force) throw duplicateKeyError(`${definition.store} _id ${id}`);
          return false;
        }
        throw error;
      }
    }
    return commitOperations(operations, { force });
  }

  function fieldsOf(filter) {
    const fields = [];
    for (const [field, condition] of Object.entries(filter || {})) {
      if (field === "$and" || field === "$or") for (const part of condition) fields.push(...fieldsOf(part));
      else fields.push(field);
    }
    return fields;
  }

  /** Read-modify-write, retried while another writer keeps winning. */
  async function modify(filter, change, { session, sort } = {}) {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const candidates = await readItems(filter, { session });
      const ordered = sort
        ? sortDocuments(candidates.map((item) => ({ item, ...documentFromItem(item) })), sort).map((entry) => entry.item)
        : candidates;
      const beforeItem = ordered[0] || null;
      const outcome = change(beforeItem);
      if (!outcome.write) return outcome.result;
      if (await write(beforeItem, outcome.after, { session })) return outcome.result;
      if (session) return outcome.result;
    }
    throw writeConflictError(`${definition.store} kept changing`);
  }

  function updateChange(filter, update, { upsert = false } = {}) {
    return (beforeItem) => {
      if (!beforeItem) {
        if (!upsert) return { write: false, result: { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, document: null } };
        const inserted = upsertDocument(filter, update);
        if (inserted._id === undefined) inserted._id = definition.newId ? definition.newId() : randomUUID();
        return {
          write: true,
          after: inserted,
          result: { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: inserted._id, document: inserted, before: null },
        };
      }
      const before = documentFromItem(beforeItem);
      const after = applyUpdate(before, update);
      const changed = !documentsEqual(before, after);
      return {
        write: changed,
        after,
        result: { matchedCount: 1, modifiedCount: changed ? 1 : 0, upsertedCount: 0, document: after, before },
      };
    };
  }

  // ---------------------------------------------------------- the calls

  const collection = {
    store: definition.store,
    itemFromDocument,
    documentFromItem,

    async findOne(filter = {}, options = {}) {
      const documents = sortDocuments(await readDocuments(filter, options), options.sort);
      return documents[0] ? project(documents[0], options.projection) : null;
    },

    find(filter = {}, options = {}) {
      let sort = options.sort;
      let skip = options.skip || 0;
      let limit = options.limit || 0;
      let projection = options.projection;
      const run = async () => {
        let documents = sortDocuments(await readDocuments(filter, { session: options.session, sort, projection }), sort);
        if (skip) documents = documents.slice(skip);
        if (limit) documents = documents.slice(0, limit);
        return documents.map((document) => project(document, projection));
      };
      const cursor = {
        sort(value) { sort = value; return cursor; },
        skip(value) { skip = value; return cursor; },
        limit(value) { limit = value; return cursor; },
        project(value) { projection = value; return cursor; },
        toArray: run,
        async* [Symbol.asyncIterator]() { yield* await run(); },
      };
      return cursor;
    },

    async countDocuments(filter = {}, options = {}) {
      return (await readDocuments(filter, { ...options, projection: { _id: 1 } })).length;
    },

    async distinct(field, filter = {}) {
      const values = new Map();
      for (const document of await readDocuments(filter, { projection: { [field]: 1 } })) {
        const value = getPath(document, field);
        if (value === undefined) continue;
        values.set(JSON.stringify(toItem(value)), value);
      }
      return [...values.values()];
    },

    async insertOne(document, { session } = {}) {
      const inserted = { ...document, _id: document._id ?? (definition.newId ? definition.newId() : randomUUID()) };
      const written = await write(null, inserted, { session });
      if (!written) throw duplicateKeyError(`${definition.store} _id ${inserted._id}`);
      return { acknowledged: true, insertedId: inserted._id };
    },

    async updateOne(filter, update, options = {}) {
      const { document: _document, before: _before, ...result } = await modify(filter, updateChange(filter, update, options), options);
      return { acknowledged: true, ...result };
    },

    async findOneAndUpdate(filter, update, options = {}) {
      const result = await modify(filter, updateChange(filter, update, options), options);
      const document = options.returnDocument === "after" ? result.document : result.before;
      return document ? project(document, options.projection) : null;
    },

    async updateMany(filter, update, options = {}) {
      let matchedCount = 0;
      let modifiedCount = 0;
      for (const document of await readDocuments(filter, { session: options.session })) {
        const result = await collection.updateOne({ ...filter, _id: document._id }, update, { session: options.session });
        matchedCount += result.matchedCount;
        modifiedCount += result.modifiedCount;
      }
      return { acknowledged: true, matchedCount, modifiedCount };
    },

    async deleteOne(filter, options = {}) {
      return modify(filter, (beforeItem) => (beforeItem
        ? { write: true, after: null, result: { acknowledged: true, deletedCount: 1 } }
        : { write: false, result: { acknowledged: true, deletedCount: 0 } }), options);
    },

    async deleteMany(filter, options = {}) {
      let deletedCount = 0;
      for (const document of await readDocuments(filter, { session: options.session })) {
        deletedCount += (await collection.deleteOne({ ...filter, _id: document._id }, options)).deletedCount;
      }
      return { acknowledged: true, deletedCount };
    },

    /** The bulk updates the roster sync issues: updateOne operations only. */
    async bulkWrite(operations) {
      const result = { upsertedCount: 0, modifiedCount: 0, matchedCount: 0 };
      const errors = [];
      for (const operation of operations) {
        const spec = operation.updateOne;
        if (!spec) throw new Error(`${definition.store}: only updateOne operations are supported in bulkWrite`);
        try {
          const outcome = await collection.updateOne(spec.filter, spec.update, { upsert: spec.upsert });
          result.upsertedCount += outcome.upsertedCount;
          result.modifiedCount += outcome.modifiedCount;
          result.matchedCount += outcome.matchedCount;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        const error = new Error(`${errors.length} bulk write operation(s) failed: ${errors[0].message}`);
        error.code = errors[0].code;
        error.result = result;
        throw error;
      }
      return result;
    },

    aggregate() {
      throw new Error(`${definition.store}: aggregate() has no DynamoDB form; use the store's statistics function`);
    },

    // Whole-document operations, for copying and mirroring from MongoDB.
    async getDocument(id) {
      const { Item } = await client().send(new GetCommand({ TableName: table(), Key: { _id: idString(id) ?? String(id) }, ConsistentRead: true }));
      return documentFromItem(Item);
    },
    async putDocument(document) {
      const id = idString(document._id) ?? String(document._id);
      const { Item } = await client().send(new GetCommand({ TableName: table(), Key: { _id: id }, ConsistentRead: true }));
      await write(Item || null, { ...document, _id: id }, { force: true });
    },
    async deleteDocument(id) {
      const key = idString(id) ?? String(id);
      const { Item } = await client().send(new GetCommand({ TableName: table(), Key: { _id: key }, ConsistentRead: true }));
      if (Item) await write(Item, null, { force: true });
    },
    async findIds(filter = {}) {
      return (await readDocuments(filter, { projection: { _id: 1 } })).map((document) => document._id);
    },
  };
  return collection;
}

/**
 * Writes operations in one TransactWriteItems. A failed reservation is a
 * duplicate (code 11000); any other failed condition means a document
 * changed since it was read (false, so the caller retries).
 */
export async function commitOperations(operations, { force = false } = {}) {
  if (operations.length > 100) throw new Error("A DynamoDB transaction holds at most 100 writes");
  try {
    await client().send(new TransactWriteCommand({
      TransactItems: operations.map(({ duplicate: _duplicate, ...operation }) => operation),
    }));
    return true;
  } catch (error) {
    if (error?.name !== "TransactionCanceledException") throw error;
    const reasons = error.CancellationReasons || [];
    const failedReservation = reasons.findIndex((reason, index) => (
      reason?.Code === "ConditionalCheckFailed" && operations[index]?.duplicate
    ));
    if (failedReservation > -1 && !force) throw duplicateKeyError(operations[failedReservation].duplicate);
    if (reasons.some((reason) => ["ConditionalCheckFailed", "TransactionConflict"].includes(reason?.Code))) return false;
    throw error;
  }
}

export { sessionKey };
