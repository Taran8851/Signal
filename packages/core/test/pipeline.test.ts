import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  statusOnInsert, shouldNotify, isBackfill, isFailing, nextWaitMs, isDue, RETRY_MS,
  planNotifications, scoreText, decideScoring, normalizeScoringMode, ALWAYS_NOTIFY,
  type Kind, type NotifyRow,
} from "../src/index.ts";

describe("statusOnInsert", () => {
  test("excluded → archived, else new", () => {
    const s = scoreText({ interests: [], boost: [], exclude: ["unpaid"] }, "Unpaid role", "");
    assert.equal(statusOnInsert(s), "archived");
    assert.equal(statusOnInsert({ excluded: false }), "new");
  });
});

describe("shouldNotify", () => {
  const prefs = { threshold: 3 };
  const base = { kind: "job" as Kind, score: 0, excluded: false, quiet: false };
  test("threshold uses >=", () => {
    assert.equal(shouldNotify({ ...base, score: 3 }, prefs), true);
    assert.equal(shouldNotify({ ...base, score: 2 }, prefs), false);
    assert.equal(shouldNotify({ ...base, score: 9 }, prefs), true);
  });
  test("ALWAYS_NOTIFY kinds notify with score 0", () => {
    assert.deepEqual([...ALWAYS_NOTIFY], ["message", "page"]);
    assert.equal(shouldNotify({ ...base, kind: "message" }, prefs), true);
    assert.equal(shouldNotify({ ...base, kind: "page" }, prefs), true);
    assert.equal(shouldNotify({ ...base, kind: "hackathon" }, prefs), false);
  });
  test("excluded never notifies, even messages", () => {
    assert.equal(shouldNotify({ ...base, score: 20, excluded: true }, prefs), false);
    assert.equal(shouldNotify({ ...base, kind: "message", excluded: true }, prefs), false);
  });
  test("first run (backfill) never notifies", () => {
    const quiet = isBackfill({ last_ok_at: null });
    assert.equal(quiet, true);
    assert.equal(isBackfill({ last_ok_at: 1 }), false);
    assert.equal(shouldNotify({ ...base, score: 20, quiet }, prefs), false);
    assert.equal(shouldNotify({ ...base, kind: "message", quiet }, prefs), false);
  });
  test("item-level quiet never notifies", () => {
    assert.equal(shouldNotify({ ...base, score: 20, itemQuiet: true }, prefs), false);
    assert.equal(shouldNotify({ ...base, kind: "page", itemQuiet: true }, prefs), false);
  });
});

describe("schedule", () => {
  const p = { everyMs: 60 * 60_000 };
  test("never run: not failing, due", () => {
    const s = { last_run_at: null, last_ok_at: null };
    assert.equal(isFailing(s), false);
    assert.equal(nextWaitMs(p, s), p.everyMs);
    assert.equal(isDue(p, s, 0), true);
  });
  test("ran but never ok → failing, retry at min(everyMs, 15 min)", () => {
    const s = { last_run_at: 1000, last_ok_at: null };
    assert.equal(isFailing(s), true);
    assert.equal(nextWaitMs(p, s), RETRY_MS);
    assert.equal(nextWaitMs({ everyMs: 5 * 60_000 }, s), 5 * 60_000);
  });
  test("last ok older than last run → failing", () => {
    assert.equal(isFailing({ last_run_at: 2000, last_ok_at: 1000 }), true);
  });
  test("last ok at/after last run → healthy", () => {
    const s = { last_run_at: 1000, last_ok_at: 1500 };
    assert.equal(isFailing(s), false);
    assert.equal(nextWaitMs(p, s), p.everyMs);
    assert.equal(isFailing({ last_run_at: 1000, last_ok_at: 1000 }), false);
  });
  test("isDue boundary", () => {
    const s = { last_run_at: 1000, last_ok_at: 1500 };
    assert.equal(isDue(p, s, 1000 + p.everyMs - 1), false);
    assert.equal(isDue(p, s, 1000 + p.everyMs), true);
    assert.equal(isDue(p, { last_run_at: 1000, last_ok_at: null }, 1000 + RETRY_MS), true);
  });
});

describe("planNotifications", () => {
  let id = 0;
  const row = (kind: Kind, score = 0, title = `t${id}`): NotifyRow => ({ id: ++id, kind, score, title });

  test("empty → no notes", () => assert.deepEqual(planNotifications([]), []));
  test("6 direct messages → 5 singles + 1 more note", () => {
    const rows = Array.from({ length: 6 }, () => row("message"));
    const notes = planNotifications(rows);
    assert.equal(notes.length, 6);
    assert.deepEqual(notes.slice(0, 5).map((n) => n.type), Array(5).fill("single"));
    assert.deepEqual(notes.slice(0, 5).map((n) => n.type === "single" && n.row), rows.slice(0, 5));
    assert.equal(notes[5].type, "more");
    assert.equal(notes[5].type === "more" && notes[5].count, 1);
    assert.equal(notes[5].title, "💬 1 more messages");
  });
  test("5 direct → 5 singles, no more note; page counts as direct", () => {
    const notes = planNotifications([row("message"), row("page"), row("message"), row("page"), row("message")]);
    assert.deepEqual(notes.map((n) => n.type), Array(5).fill("single"));
  });
  test("3 discovered → 3 singles", () => {
    const notes = planNotifications([row("job", 3), row("cfp", 5), row("hackathon", 4)]);
    assert.deepEqual(notes.map((n) => n.type), ["single", "single", "single"]);
  });
  test("4 discovered → 1 digest sorted by score", () => {
    const rows = [row("job", 3), row("cfp", 9), row("hackathon", 4), row("research", 7)];
    const notes = planNotifications(rows);
    assert.equal(notes.length, 1);
    const d = notes[0];
    assert.equal(d.type, "digest");
    if (d.type !== "digest") return;
    assert.equal(d.total, 4);
    assert.equal(d.more, 0);
    assert.deepEqual(d.top.map((r) => r.score), [9, 7, 4, 3]);
    assert.equal(d.title, "📡 4 new matches");
  });
  test("12 discovered → digest of top 8, 4 more; ties keep input order", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row("job", i < 6 ? 5 : i));
    const d = planNotifications(rows)[0];
    assert.equal(d.type, "digest");
    if (d.type !== "digest") return;
    assert.equal(d.top.length, 8);
    assert.equal(d.more, 4);
    assert.deepEqual(d.top.map((r) => r.score), [11, 10, 9, 8, 7, 6, 5, 5]);
    assert.deepEqual(d.top.slice(6), rows.slice(0, 2));
  });
  test("mixed: direct notes come before discovered", () => {
    const notes = planNotifications([row("job", 5), row("message"), row("cfp", 4)]);
    assert.deepEqual(notes.map((n) => n.type === "single" && n.row.kind), ["message", "job", "cfp"]);
  });
  test("single title clips at 90 with icon", () => {
    const n = planNotifications([row("hackathon", 3, "x".repeat(200))])[0];
    assert.equal(n.title, `🏁 ${"x".repeat(89)}…`);
  });
  test("does not mutate input", () => {
    const rows = [row("job", 1), row("job", 9), row("job", 2), row("job", 8)];
    const before = [...rows];
    planNotifications(rows);
    assert.deepEqual(rows, before);
  });
});

describe("decideScoring", () => {
  test("keyword mode never calls the LLM", () => {
    assert.equal(decideScoring("keyword", { score: 30, excluded: false }), false);
  });
  test("llm mode: every non-excluded item", () => {
    assert.equal(decideScoring("llm", { score: 0, excluded: false }), true);
    assert.equal(decideScoring("llm", { score: 10, excluded: true }), false);
  });
  test("hybrid: score >= prefilter (default 1)", () => {
    assert.equal(decideScoring("hybrid", { score: 0, excluded: false }), false);
    assert.equal(decideScoring("hybrid", { score: 1, excluded: false }), true);
    assert.equal(decideScoring("hybrid", { score: 3, excluded: false }, 4), false);
    assert.equal(decideScoring("hybrid", { score: 4, excluded: false }, 4), true);
    assert.equal(decideScoring("hybrid", { score: 9, excluded: true }), false);
  });
  test("unknown mode → keyword", () => {
    assert.equal(normalizeScoringMode("magic"), "keyword");
    assert.equal(decideScoring("magic", { score: 9, excluded: false }), false);
  });
});
