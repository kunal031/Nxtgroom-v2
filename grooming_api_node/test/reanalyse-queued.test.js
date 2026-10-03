import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROUTES = new URL("../src/routes/attendanceRoutes.js", import.meta.url);

/**
 * The source of one route handler, from its own `attendanceRouter.<verb>(` to
 * the next route of any verb.
 *
 * Matched on verb and path together: "/:attendanceId" is registered twice, as
 * a GET and a DELETE, so a path-only search silently returns the wrong handler.
 */
async function routeSource(pathLiteral, verb = "post") {
  const source = await readFile(ROUTES, "utf8");
  const opener = `attendanceRouter.${verb}(`;
  for (let at = source.indexOf(opener); at >= 0; at = source.indexOf(opener, at + 1)) {
    const after = source.slice(at + opener.length);
    const nextOffset = after.search(/attendanceRouter\.(get|post|put|patch|delete)\(/);
    const body = nextOffset < 0 ? after : after.slice(0, nextOffset);
    // The path is the first argument, so it sits before any nested route text.
    if (body.slice(0, 200).includes(`"${pathLiteral}"`)) return body;
  }
  throw new assert.AssertionError({
    message: `${verb.toUpperCase()} ${pathLiteral} must remain identifiable`,
    actual: false,
    expected: true,
  });
}

test("a re-analysed check-out is queued for the worker, not analysed in the request", async () => {
  const route = await routeSource("/:attendanceId/reanalyse");

  /**
   * Re-analysis deletes the half's stored report before asking for a new one.
   *
   * That is fine while the new report is produced by a durable job, and was a
   * data-loss bug while the check-out half ran its vision call inside the
   * request: a Gemini timeout or a 429 left the record with no report and
   * nothing queued to produce one, so the only remedy was another re-analysis
   * that could fail exactly the same way.
   */
  assert.ok(
    route.includes("enqueueEvaluation(db"),
    "re-analysis must queue a durable job"
  );
  assert.equal(
    route.includes("evaluateCheckoutNow("),
    false,
    "re-analysis must not run a vision call inside the request"
  );
  assert.ok(
    route.includes("kind,"),
    "the queued job must follow the requested half rather than hard-coding one"
  );
  assert.ok(
    route.includes("checkOutTime: attendance.check_out_time"),
    "a checkout job must carry the check-out time so its report can state it"
  );
  assert.ok(
    route.includes("deadlineAt:"),
    "the job must be bounded by a deadline like every other queued evaluation"
  );
  assert.equal(
    route.includes("Re-analysis completed."),
    false,
    "re-analysis is now asynchronous for both halves, so nothing may claim it finished"
  );
});

