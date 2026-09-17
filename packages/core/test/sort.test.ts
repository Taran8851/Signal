import { test } from "node:test";
import assert from "node:assert/strict";
import { sortSignals, normalizeSort } from "../src/index.ts";

const rows = [
  { id: "a", received_at: "2026-09-11T11:00:00.000Z", deadline: null, score: 4 },
  { id: "b", received_at: "2026-09-11T12:00:00.000Z", deadline: "2026-10-01", score: 9 },
  { id: "c", received_at: "2026-09-11T13:00:00.000Z", deadline: null, score: 9 },
  { id: "d", received_at: "2026-09-11T10:00:00.000Z", deadline: "2026-09-20", score: 0 },
  { id: "e", received_at: "2026-09-11T14:00:00.000Z", deadline: "2026-10-01", score: 4 },
];
const ids = (xs: { id: string }[]) => xs.map((r) => r.id).join("");

test("recent: received_at desc", () => assert.equal(ids(sortSignals(rows, "recent")), "ecbad"));
test("deadline: soonest first, ties by received_at desc, nulls last (recent first)", () =>
  assert.equal(ids(sortSignals(rows, "deadline")), "debca"));
test("score: score desc then received_at desc", () => assert.equal(ids(sortSignals(rows, "score")), "cbead"));
test("default and unknown sort → recent", () => {
  assert.equal(ids(sortSignals(rows)), "ecbad");
  assert.equal(ids(sortSignals(rows, "bogus")), "ecbad");
  assert.equal(normalizeSort("__proto__"), "recent");
});
test("does not mutate input", () => {
  const copy = [...rows];
  sortSignals(rows, "score");
  assert.deepEqual(rows, copy);
});
