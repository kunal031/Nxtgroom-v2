import assert from "node:assert/strict";
import { test } from "node:test";
import { DATE_FIELDS, fromItem, toItem, toStoredItem, upsertCommandInput } from "../src/stores/dynamoItems.js";

const ISO = "2024-01-02T03:04:05.123Z";

test("text that looks like a timestamp stays text", () => {
  // The bug this guards: a stored string and a stored Date were both bare
  // ISO strings, so reading one back had to guess, and guessed Date.
  for (const field of ["name", "remark", "note", "label", "institute_name", "ai_summary", "employee_id"]) {
    const document = fromItem(toStoredItem({ [field]: ISO }));
    assert.equal(typeof document[field], "string", `${field} must survive as a string`);
    assert.equal(document[field], ISO);
  }
});

test("dates come back as dates, however deeply they sit", () => {
  const when = new Date(ISO);
  const document = fromItem(toStoredItem({
    created_at: when,
    nested: { at: when, note: ISO },
    rows: [{ seen_at: when, text: ISO }],
  }));

  assert.ok(document.created_at instanceof Date);
  assert.equal(document.created_at.getTime(), when.getTime());
  assert.ok(document.nested.at instanceof Date);
  assert.equal(typeof document.nested.note, "string", "a sibling string is untouched");
  assert.ok(document.rows[0].seen_at instanceof Date, "inside an array too");
  assert.equal(typeof document.rows[0].text, "string");
});

test("the date fields are recorded, and never handed back to the caller", () => {
  const item = toStoredItem({ _id: "x", created_at: new Date(ISO), name: ISO });
  assert.deepEqual(item[DATE_FIELDS], ["created_at"], "only the real date is listed");
  assert.equal(item.created_at, ISO, "stored plainly, so DynamoDB can compare and sort it");
  assert.ok(!(DATE_FIELDS in fromItem(item)), "the bookkeeping field is stripped on read");
});

test("an upsert records the date fields it writes", () => {
  const input = upsertCommandInput("t", { _id: "x" }, {
    set: { label: ISO, updated_at: new Date(ISO) },
    setOnInsert: { created_at: new Date(ISO) },
  });
  const listed = Object.entries(input.ExpressionAttributeNames)
    .find(([, name]) => name === DATE_FIELDS)?.[0]
    ?.replace("#f", ":v");
  const values = input.ExpressionAttributeValues;
  const recorded = Object.values(values).find((value) => Array.isArray(value));
  assert.ok(listed, "the list is written with the fields");
  assert.deepEqual(recorded.sort(), ["created_at", "updated_at"], "label is not a date");
  assert.ok(Object.values(values).includes(ISO), "the date is still a plain comparable string");
});

test("rows written before the fields were recorded still read as dates", () => {
  // The ten app_settings rows already in production have no list.
  const legacy = { _id: "config_settings", created_at: ISO, updated_at: ISO };
  const document = fromItem(legacy);
  assert.ok(document.created_at instanceof Date);
  assert.ok(document.updated_at instanceof Date);
});

test("a timestamp written outside the list is still read as one", () => {
  // recordDeliveryOutcome sets updated_at with its own UpdateExpression and
  // does not touch the list, so the field name has to carry it.
  const item = { _id: "run", [DATE_FIELDS]: ["created_at"], created_at: ISO, updated_at: ISO };
  const document = fromItem(item);
  assert.ok(document.updated_at instanceof Date, "a field named like a time is a time");
  assert.ok(document.created_at instanceof Date);
});

test("a listed field wins over the name, and an unlisted name-like field never fabricates a date", () => {
  const document = fromItem({ _id: "x", [DATE_FIELDS]: [], name: ISO, note: ISO });
  assert.equal(typeof document.name, "string");
  assert.equal(typeof document.note, "string");
});

test("toItem is unchanged, because index keys and conditions compare plain strings", () => {
  const when = new Date(ISO);
  assert.equal(toItem(when), ISO);
  assert.deepEqual(toItem({ at: when }), { at: ISO });
  assert.ok(!(DATE_FIELDS in toItem({ at: when })), "no bookkeeping in a key or filter value");
});

test("other types are left alone", () => {
  const document = fromItem(toStoredItem({
    n: 5, ok: true, nothing: null, list: [1, "two", false],
  }));
  assert.deepEqual(document, { n: 5, ok: true, nothing: null, list: [1, "two", false] });
});

test("an invalid date does not become the string \"Invalid Date\"", () => {
  const item = toStoredItem({ created_at: new Date("nonsense") });
  assert.equal(item.created_at, null, "stored as null rather than unparseable text");
});
