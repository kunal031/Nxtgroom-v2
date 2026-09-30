import { commitOperations, sessionKey, writeConflictError } from "./dynamoDocuments.js";

/**
 * All-or-nothing writes across DynamoDB tables, in place of MongoDB's
 * transactions.
 *
 * MongoDB reads and writes inside one snapshot and aborts if anything it
 * touched changed. DynamoDB's TransactWriteItems only writes, so a session
 * remembers every document its reads saw, and the commit adds a check that
 * each is still at the version it was read at. If one changed, or two
 * transactions collide, the whole thing is retried from the start, which is
 * what MongoDB's driver does on a transient transaction error.
 *
 * The guard counters the routes bump (_private_assignment_guard_version,
 * _private_attendance_guard_version) keep working unchanged: their $inc is
 * an ordinary write inside the transaction, and the version check makes two
 * concurrent transactions conflict exactly as MongoDB's write conflict did.
 */

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [10, 25, 60, 150];

class DynamoSession {
  constructor() {
    this.reads = new Map();
    this.writes = new Map();
    this.operations = [];
  }

  /** Remembers the version a read saw; the first read of a document wins. */
  recordRead(table, id, rev) {
    const key = sessionKey(table, id);
    if (!this.reads.has(key) && !this.writes.has(key)) this.reads.set(key, { table, id, rev });
  }

  /**
   * Queues one document's writes. DynamoDB refuses a transaction that
   * touches the same item twice, so writing a document again inside the
   * same transaction replaces what was queued for it: the item as it now
   * stands, still guarded against the version first read.
   */
  queue(table, id, write, operations) {
    const key = sessionKey(table, id);
    const previous = this.writes.get(key);
    if (previous) {
      this.operations = this.operations.filter((operation) => !previous.operations.includes(operation));
      // Keep the guard from the first write: it names the version this
      // transaction started from, which is what must still hold at commit.
      const guarded = operations.find((operation) => operation.Put?.TableName === table || operation.Delete?.TableName === table);
      const target = guarded?.Put || guarded?.Delete;
      const firstGuard = previous.guard;
      if (target && firstGuard) {
        target.ConditionExpression = firstGuard.ConditionExpression;
        target.ExpressionAttributeNames = firstGuard.ExpressionAttributeNames;
        if (firstGuard.ExpressionAttributeValues) target.ExpressionAttributeValues = firstGuard.ExpressionAttributeValues;
        else delete target.ExpressionAttributeValues;
      }
    }
    const own = operations.find((operation) => operation.Put?.TableName === table || operation.Delete?.TableName === table);
    const ownTarget = own?.Put || own?.Delete;
    this.writes.set(key, {
      ...write,
      operations,
      guard: previous?.guard || (ownTarget && ownTarget.ConditionExpression
        ? {
          ConditionExpression: ownTarget.ConditionExpression,
          ExpressionAttributeNames: ownTarget.ExpressionAttributeNames,
          ExpressionAttributeValues: ownTarget.ExpressionAttributeValues,
        }
        : null),
    });
    this.operations.push(...operations);
  }

  /** This session's own uncommitted writes, over what the table returned. */
  overlay(table, items, matches, pinnedIds) {
    const result = items.filter((item) => !this.writes.has(sessionKey(table, item._id)));
    for (const [key, write] of this.writes) {
      if (!key.startsWith(`${table}\u0000`)) continue;
      const id = key.slice(table.length + 1);
      if (pinnedIds && !pinnedIds.includes(id)) continue;
      if (write?.item && matches(write.item)) result.push(write.item);
    }
    return result;
  }

  /** Conditions asserting every document read is still as it was read. */
  readChecks() {
    return [...this.reads.values()]
      .filter(({ table, id }) => !this.writes.has(sessionKey(table, id)))
      .map(({ table, id, rev }) => ({
        ConditionCheck: {
          TableName: table,
          Key: { _id: id },
          ...(rev === null || rev === undefined
            ? { ConditionExpression: "attribute_not_exists(#id)", ExpressionAttributeNames: { "#id": "_id" } }
            : { ConditionExpression: "#rev = :rev", ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": rev } }),
        },
      }));
  }
}

export function createDynamoSession() {
  return new DynamoSession();
}

export function isDynamoSession(session) {
  return session instanceof DynamoSession;
}

/**
 * Runs work() with a session, committing its writes together. Nothing is
 * written until work() returns, so a throw leaves the database untouched.
 * A conflict retries the whole of work(), which must therefore be safe to
 * run twice — the same requirement MongoDB's withTransaction makes.
 */
export async function withDynamoTransaction(work) {
  for (let attempt = 1; ; attempt += 1) {
    const session = createDynamoSession();
    const result = await work(session);
    if (!session.operations.length) return result;
    const operations = [...session.readChecks(), ...session.operations];
    if (await commitOperations(operations)) return result;
    if (attempt >= MAX_ATTEMPTS) throw writeConflictError("a DynamoDB transaction kept conflicting");
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
  }
}
