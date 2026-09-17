import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizePrefs, normalizePrefsDetailed, PREF_DEFAULTS, SOURCES } from "../src/index.ts";

describe("PREF_DEFAULTS", () => {
  test("reference values", () => {
    assert.equal(PREF_DEFAULTS.threshold, 3);
    assert.equal(PREF_DEFAULTS.interests.length, 11);
    assert.equal(PREF_DEFAULTS.boost.length, 10);
    assert.deepEqual(PREF_DEFAULTS.exclude, []);
    assert.deepEqual(PREF_DEFAULTS.cfpCategories, ["security", "computer vision", "machine learning", "embedded systems"]);
    assert.equal(PREF_DEFAULTS.desktop, true);
    assert.equal(PREF_DEFAULTS.telegram, true);
  });
  test("SOURCES ids and labels", () => {
    assert.deepEqual(SOURCES.map((s) => s.id), ["gmail", "discord", "devpost", "devfolio", "unstop", "mlh", "wikicfp", "feeds", "watch"]);
    assert.equal(SOURCES[0].label, "Gmail + LinkedIn mail");
    assert.equal(SOURCES[7].label, "RSS / Google Alerts");
  });
});

describe("normalizePrefs", () => {
  test("empty / garbage input → defaults (a fresh copy)", () => {
    assert.deepEqual(normalizePrefs({}), PREF_DEFAULTS);
    assert.deepEqual(normalizePrefs(null), PREF_DEFAULTS);
    assert.deepEqual(normalizePrefs("x"), PREF_DEFAULTS);
    const p = normalizePrefs(undefined);
    p.interests.push("mutated");
    assert.equal(PREF_DEFAULTS.interests.includes("mutated"), false);
  });
  test("merges over defaults: missing fields keep defaults", () => {
    const p = normalizePrefs({ exclude: ["unpaid"] });
    assert.deepEqual(p.exclude, ["unpaid"]);
    assert.deepEqual(p.interests, PREF_DEFAULTS.interests);
    assert.equal(p.threshold, 3);
  });
  test("lists: trimmed, empties dropped, deduped (case-sensitive), 80-char terms, max 80", () => {
    const p = normalizePrefs({ interests: ["  AI ", "AI", "ai", "", "   ", "x".repeat(100)] });
    assert.deepEqual(p.interests, ["AI", "ai", "x".repeat(80)]);
    const many = normalizePrefs({ boost: Array.from({ length: 120 }, (_, i) => `t${i}`) });
    assert.equal(many.boost.length, 80);
    assert.equal(many.boost[79], "t79");
  });
  test("dedupe happens after truncation", () => {
    const p = normalizePrefs({ interests: ["x".repeat(80) + "a", "x".repeat(80) + "b"] });
    assert.deepEqual(p.interests, ["x".repeat(80)]);
  });
  test("textarea strings split on newlines and commas", () => {
    assert.deepEqual(normalizePrefs({ interests: "security\n edge AI , IoT\n\n" }).interests, ["security", "edge AI", "IoT"]);
  });
  test("non-string list entries are ignored", () => {
    assert.deepEqual(normalizePrefs({ exclude: ["ok", null, { a: 1 }, 42] }).exclude, ["ok", "42"]);
    assert.deepEqual(normalizePrefs({ exclude: "nope-not-array-but-string" }).exclude, ["nope-not-array-but-string"]);
    assert.deepEqual(normalizePrefs({ exclude: 5 }).exclude, []);
  });
  test("threshold clamped 1–30, rounded, default on NaN", () => {
    const t = (v: unknown) => normalizePrefs({ threshold: v }).threshold;
    assert.equal(t(0), 1);
    assert.equal(t(-4), 1);
    assert.equal(t(31), 30);
    assert.equal(t(1e9), 30);
    assert.equal(t(4.4), 4);
    assert.equal(t(4.5), 5);
    assert.equal(t("7"), 7);
    assert.equal(t(NaN), 3);
    assert.equal(t("abc"), 3);
    assert.equal(t(Infinity), 3);
    assert.equal(t(null), 3);
    assert.equal(t({}), 3);
  });
  test("cfpCategories lowercased, max 20", () => {
    const p = normalizePrefs({ cfpCategories: ["Machine Learning", "SECURITY", ...Array.from({ length: 30 }, (_, i) => `c${i}`)] });
    assert.equal(p.cfpCategories[0], "machine learning");
    assert.equal(p.cfpCategories[1], "security");
    assert.equal(p.cfpCategories.length, 20);
  });
  test("links: http(s) only, bare URL gets hostname label, label ≤ 60, bad lines reported", () => {
    const r = normalizePrefsDetailed({
      feeds: "Alerts | https://www.google.com/alerts/feeds/1\nhttps://lab.example.edu/blog\nEvil | javascript:alert(1)\n\nnot a url",
      watch: [{ label: "y".repeat(100), url: "http://example.org/p" }, { label: "", url: "https://devpost.com/x" }, "https://mlh.io", { url: "ftp://x" }],
    });
    assert.deepEqual(r.prefs.feeds, [
      { label: "Alerts", url: "https://www.google.com/alerts/feeds/1" },
      { label: "lab.example.edu", url: "https://lab.example.edu/blog" },
    ]);
    assert.deepEqual(r.prefs.watch, [
      { label: "y".repeat(60), url: "http://example.org/p" },
      { label: "devpost.com", url: "https://devpost.com/x" },
      { label: "mlh.io", url: "https://mlh.io/" },
    ]);
    assert.deepEqual(r.skippedLinks, ["Evil | javascript:alert(1)", "not a url", "ftp://x"]);
  });
  test("links capped at 50", () => {
    const p = normalizePrefs({ feeds: Array.from({ length: 60 }, (_, i) => `https://e.com/${i}`) });
    assert.equal(p.feeds.length, 50);
  });
  test("discordChannels: digits 5–25 only", () => {
    const p = normalizePrefs({ discordChannels: ["123456789012345678", "1234", "12345", "1".repeat(25), "1".repeat(26), "abc12345", " 998877 "] });
    assert.deepEqual(p.discordChannels, ["123456789012345678", "12345", "1".repeat(25), "998877"]);
  });
  test("disabled: only known source ids", () => {
    assert.deepEqual(normalizePrefs({ disabled: ["gmail", "twitter", "mlh", "gmail", "__proto__"] }).disabled, ["gmail", "mlh"]);
  });
  test("booleans: only real booleans override defaults", () => {
    const p = normalizePrefs({ desktop: false, telegram: "no" });
    assert.equal(p.desktop, false);
    assert.equal(p.telegram, true);
  });
  test("unknown keys are dropped", () => {
    const p = normalizePrefs({ evil: 1, threshold: 5 }) as Record<string, unknown>;
    assert.equal("evil" in p, false);
    assert.deepEqual(Object.keys(p).sort(), Object.keys(PREF_DEFAULTS).sort());
  });
  test("idempotent", () => {
    const once = normalizePrefs({ interests: " a ,b", threshold: "40", feeds: "https://x.org" });
    assert.deepEqual(normalizePrefs(once), once);
  });
});
