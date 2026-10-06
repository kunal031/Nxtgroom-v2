import { randomUUID } from "node:crypto";
import { BatchGetCommand, DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoTableName, getDynamoDocumentClient } from "../config/dynamo.js";
import { idMatch } from "../middleware/auth.js";
import { fromItem, upsertCommandInput } from "./dynamoItems.js";
import { routedRead, routedWrite } from "./routing.js";

const STORE = "evaluations";
const KINDS = ["checkin", "checkout"];
// BatchGetItem takes at most 100 keys, and each session asks for one key per
// kind, so the session count is derived rather than fixed: adding a kind
// narrows the batch instead of silently exceeding the limit.
const MAX_BATCH_KEYS = 100;
const MAX_BATCH_ATTEMPTS = 8;

function table() {
  return dynamoTableName(STORE);
}

function kindOf(kind) {
  return kind === "checkout" ? "checkout" : "checkin";
}

function keyOf(attendanceId, kind) {
  return { attendance_id: String(attendanceId), kind: kindOf(kind) };
}

export function evaluationFilter(attendanceId, kind = "checkin") {
  return kind === "checkout"
    ? { attendance_id: attendanceId, kind: "checkout" }
    : { attendance_id: attendanceId, kind: { $ne: "checkout" } };
}

export async function getEvaluation(db, attendanceId, kind) {
  return routedRead(STORE, {
    mongo: () => db.collection(STORE).findOne(evaluationFilter(attendanceId, kind)),
    dynamo: async () => {
      const { Item } = await getDynamoDocumentClient().send(new GetCommand({
        TableName: table(),
        Key: keyOf(attendanceId, kind),
        ConsistentRead: true,
      }));
      return Item ? fromItem(Item) : null;
    },
  });
}

export async function saveEvaluation(db, attendanceId, kind, evaluation, now = new Date()) {
  const setOnInsert = { _id: randomUUID(), created_at: now };
  await routedWrite(STORE, "save", {
    mongo: () => db.collection(STORE).updateOne(
      evaluationFilter(attendanceId, kind),
      { $set: evaluation, $setOnInsert: setOnInsert },
      { upsert: true }
    ),
    dynamo: async () => {
      // upsertCommandInput returns null when there is nothing to set, which
      // UpdateCommand rejects; the other stores guard it the same way.
      const input = upsertCommandInput(table(), keyOf(attendanceId, kind), { set: evaluation, setOnInsert });
      if (input) await getDynamoDocumentClient().send(new UpdateCommand(input));
    },
  });
}

export async function deleteEvaluation(db, attendanceId, kind) {
  await routedWrite(STORE, "delete", {
    mongo: () => db.collection(STORE).deleteMany(evaluationFilter(attendanceId, kind)),
    dynamo: () => getDynamoDocumentClient().send(new DeleteCommand({
      TableName: table(),
      Key: keyOf(attendanceId, kind),
    })),
  });
}

export async function deleteEvaluationsForAttendance(db, attendanceId) {
  await routedWrite(STORE, "delete_for_attendance", {
    mongo: () => db.collection(STORE).deleteMany({ attendance_id: String(attendanceId) }),
    dynamo: async () => {
      for (const kind of KINDS) {
        await getDynamoDocumentClient().send(new DeleteCommand({
          TableName: table(),
          Key: keyOf(attendanceId, kind),
        }));
      }
    },
  });
}

const CHECK_GROUPS = [
  "general_idcard_check",
  "grooming_check",
  "attire_check",
  "accessories_check",
  "footwear_check",
];

async function dynamoEvaluationsFor(attendanceIds) {
  const client = getDynamoDocumentClient();
  const ids = [...new Set(attendanceIds.map(String))];
  const found = [];
  const sessionsPerBatch = Math.max(1, Math.floor(MAX_BATCH_KEYS / KINDS.length));
  for (let start = 0; start < ids.length; start += sessionsPerBatch) {
    let keys = ids.slice(start, start + sessionsPerBatch).flatMap((id) => KINDS.map((kind) => keyOf(id, kind)));
    for (let attempt = 1; keys.length; attempt += 1) {
      if (attempt > MAX_BATCH_ATTEMPTS) throw new Error("evaluations: DynamoDB kept returning unprocessed keys");
      const { Responses, UnprocessedKeys } = await client.send(new BatchGetCommand({
        RequestItems: { [table()]: { Keys: keys } },
      }));
      found.push(...(Responses?.[table()] || []));
      keys = UnprocessedKeys?.[table()]?.Keys || [];
      if (keys.length) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 50 * 2 ** attempt)));
    }
  }
  return found.map(fromItem);
}

export async function evaluationsForSessions(db, attendanceIds) {
  if (!attendanceIds.length) return [];
  return routedRead(STORE, {
    mongo: () => db.collection(STORE)
      .find({ attendance_id: { $in: idVariants(attendanceIds) } })
      .toArray(),
    dynamo: () => dynamoEvaluationsFor(attendanceIds),
  });
}

export async function failedCheckpointRows(db, attendanceIds) {
  if (!attendanceIds.length) return [];
  return routedRead(STORE, {
    mongo: () => db.collection(STORE).aggregate([
      { $match: { attendance_id: { $in: idVariants(attendanceIds) } } },
      {
        $project: {
          attendance_id: 1,
          kind: 1,
          rows: { $concatArrays: CHECK_GROUPS.map((group) => ({ $ifNull: [`$${group}`, []] })) },
        },
      },
      { $unwind: "$rows" },
      { $match: { "rows.status": "FAIL" } },
      {
        $project: {
          _id: 0,
          attendance_id: 1,
          kind: 1,
          code: "$rows.code",
          name: "$rows.checkpoint_name",
        },
      },
    ]).toArray(),
    dynamo: async () => (await dynamoEvaluationsFor(attendanceIds)).flatMap((evaluation) => (
      CHECK_GROUPS.flatMap((group) => evaluation[group] || [])
        .filter((row) => row?.status === "FAIL")
        .map((row) => ({
          attendance_id: evaluation.attendance_id,
          kind: evaluation.kind,
          code: row.code,
          name: row.checkpoint_name,
        }))
    )),
  });
}

function idVariants(ids) {
  const seen = new Set();
  const variants = [];
  for (const id of ids) {
    for (const variant of idMatch(String(id)).$in) {
      const key = `${variant?._bsontype || typeof variant}:${String(variant)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push(variant);
    }
  }
  return variants;
}
