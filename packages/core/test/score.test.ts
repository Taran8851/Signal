import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { termRe, scoreText, explainScore, PREF_DEFAULTS, type SignalPrefs } from "../src/index.ts";

const P = (interests: string[] = [], boost: string[] = [], exclude: string[] = []) => ({ interests, boost, exclude });
const hit = (term: string, text: string) => termRe(term).test(text);

describe("termRe", () => {
  test('"AI" does not match "said"', () => {
    assert.equal(hit("AI", "she said so"), false);
    assert.equal(hit("AI", "edge AI chips"), true);
  });
  test('"IoT" does not match "idiot"', () => {
    assert.equal(hit("IoT", "what an idiot"), false);
    assert.equal(hit("IoT", "IoT devices"), true);
  });
  test("case-insensitive", () => {
    assert.equal(hit("Computer Vision", "COMPUTER VISION lab"), true);
    assert.equal(hit("iot", "IOT"), true);
  });
  test("plurals: s, es, 's", () => {
    assert.equal(hit("hackathon", "Upcoming hackathons"), true);
    assert.equal(hit("internship", "Summer internships open"), true);
    assert.equal(hit("box", "sandboxes and boxes"), true);
    assert.equal(hit("MLH", "MLH's new season"), true);
    assert.equal(hit("hackathon", "hackathoning"), false);
    assert.equal(hit("intern", "internship"), false);
  });
  test("digit boundaries", () => {
    assert.equal(hit("AI", "AI2 institute"), false);
    assert.equal(hit("5G", "5G networks"), true);
    assert.equal(hit("G", "5G"), false);
  });
  test("regex special characters are escaped", () => {
    assert.equal(hit("C++", "We use C++ daily"), true);
    assert.equal(hit("C++", "CCC"), false);
    assert.equal(hit("node.js", "node.js backend"), true);
    assert.equal(hit("node.js", "nodexjs backend"), false);
    assert.equal(hit("(ML)", "Intro (ML) course"), true);
    assert.equal(hit("a|b", "a"), false);
    assert.equal(hit("$100", "win $100 prize"), true);
  });
  test("unicode letter boundaries", () => {
    assert.equal(hit("caf", "café"), false);
    assert.equal(hit("vision", "révision"), false);
    assert.equal(hit("vision", "é vision é"), true);
    assert.equal(hit("über", "Über Lab"), true);
    assert.equal(hit("ai", "Straßenbahnai"), false);
    assert.equal(hit("robotics", "роботехника robotics"), true);
  });
  test("non-global regex: repeated tests are stable", () => {
    const re = termRe("AI");
    assert.equal(re.test("AI"), true);
    assert.equal(re.test("AI"), true);
  });
});

describe("scoreText", () => {
  test("interest in title = +4", () => {
    assert.deepEqual(scoreText(P(["security"]), "Security fellowship", ""), { score: 4, matched: ["security"], excluded: false });
  });
  test("interest in body only = +3", () => {
    assert.equal(scoreText(P(["security"]), "Fellowship", "work on security").score, 3);
  });
  test("interest in both = +4, not additive", () => {
    assert.equal(scoreText(P(["security"]), "Security", "more security").score, 4);
  });
  test("boost = +2 in title or body, once", () => {
    assert.equal(scoreText(P([], ["stipend"]), "Stipend", "").score, 2);
    assert.equal(scoreText(P([], ["stipend"]), "x", "stipend").score, 2);
    assert.equal(scoreText(P([], ["stipend"]), "stipend", "stipend stipend").score, 2);
  });
  test("multiple terms sum; matched = interests then boost, in list order", () => {
    const r = scoreText(P(["embedded", "security"], ["stipend", "internship"]),
      "Internship in security", "embedded systems, paid stipend");
    assert.equal(r.score, 4 + 3 + 2 + 2);
    assert.deepEqual(r.matched, ["embedded", "security", "stipend", "internship"]);
  });
  test("same term in both lists counts in both", () => {
    const r = scoreText(P(["hackathon"], ["hackathon"]), "Hackathon", "");
    assert.equal(r.score, 6);
    assert.deepEqual(r.matched, ["hackathon", "hackathon"]);
  });
  test("no match = 0", () => {
    assert.deepEqual(scoreText(P(["security"], ["stipend"]), "Bake sale", "cookies"), { score: 0, matched: [], excluded: false });
  });
  test("exclude hit in title or body → excluded, score still computed", () => {
    const t = scoreText(P(["security"], [], ["unpaid"]), "Unpaid security role", "");
    assert.equal(t.excluded, true);
    assert.equal(t.score, 4);
    const b = scoreText(P(["security"], [], ["5+ years"]), "Security role", "needs 5+ years experience");
    assert.equal(b.excluded, true);
    assert.equal(b.score, 4);
  });
  test("defaults: one interest anywhere clears threshold 3", () => {
    const r = scoreText(PREF_DEFAULTS, "Workshop", "on neuromorphic hardware");
    assert.ok(r.score >= PREF_DEFAULTS.threshold);
  });
});

describe("explainScore agrees with scoreText", () => {
  const prefs: SignalPrefs = { ...PREF_DEFAULTS, exclude: ["unpaid", "5+ years"] };
  const cases: [string, string][] = [
    ["", ""],
    ["Edge AI hackathon", "win a stipend; security track"],
    ["Research internship in computer vision", "summer research, IoT, embedded, AI safety"],
    ["She said the idiot", "nothing here"],
    ["Unpaid internship", "cybersecurity"],
    ["Call for papers: neuromorphic", "spiking neural networks and LLM agents; fellowship; 5+ years"],
    ["security", "security"],
  ];
  for (const [title, body] of cases) {
    test(JSON.stringify(title), () => {
      const s = scoreText(prefs, title, body);
      const e = explainScore(prefs, title, body);
      assert.equal(e.score, s.score);
      assert.deepEqual(e.matched, s.matched);
      assert.equal(e.excluded, s.excluded);
      assert.equal(e.hits.reduce((n, h) => n + h.points, 0), s.score);
    });
  }
  test("breakdown details", () => {
    const e = explainScore(P(["security", "embedded"], ["stipend"], ["unpaid", "remote"]), "Security stipend", "embedded, unpaid");
    assert.deepEqual(e.hits, [
      { term: "security", list: "interest", where: "title", points: 4 },
      { term: "embedded", list: "interest", where: "body", points: 3 },
      { term: "stipend", list: "boost", where: "title", points: 2 },
    ]);
    assert.deepEqual(e.excludedBy, ["unpaid"]);
  });
});
