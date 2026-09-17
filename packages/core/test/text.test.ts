import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clip, safeUrl, isoDate, guessKind, decodeEntities, htmlToText, firstLine } from "../src/index.ts";

describe("safeUrl", () => {
  test("keeps http(s), normalized", () => {
    assert.equal(safeUrl("https://devpost.com"), "https://devpost.com/");
    assert.equal(safeUrl("http://example.org/a?b=1"), "http://example.org/a?b=1");
  });
  test("rejects javascript: and other schemes", () => {
    assert.equal(safeUrl("javascript:alert(1)"), "");
    assert.equal(safeUrl("JavaScript:alert(1)"), "");
    assert.equal(safeUrl("data:text/html,<b>x</b>"), "");
    assert.equal(safeUrl("ftp://example.org"), "");
    assert.equal(safeUrl("mailto:a@b.c"), "");
  });
  test("rejects empty and unparseable", () => {
    assert.equal(safeUrl(""), "");
    assert.equal(safeUrl(null), "");
    assert.equal(safeUrl(undefined), "");
    assert.equal(safeUrl("not a url"), "");
    assert.equal(safeUrl("devpost.com"), "");
  });
});

describe("isoDate", () => {
  test("bare YYYY-MM-DD unchanged", () => {
    assert.equal(isoDate("2026-10-01"), "2026-10-01");
    assert.equal(isoDate("2026-01-01"), "2026-01-01");
  });
  test("garbage and empty → null", () => {
    assert.equal(isoDate("soon"), null);
    assert.equal(isoDate(""), null);
    assert.equal(isoDate(null), null);
    assert.equal(isoDate(undefined), null);
    assert.equal(isoDate(0), null);
  });
  test("parseable date → local YYYY-MM-DD", () => {
    const d = new Date(2026, 9, 1, 12, 0, 0);
    assert.equal(isoDate(d.toString()), "2026-10-01");
    assert.match(isoDate("Oct 1, 2026") ?? "", /^\d{4}-\d{2}-\d{2}$/);
  });
});

test("clip", () => {
  assert.equal(clip("hello", 5), "hello");
  assert.equal(clip("hello!", 5), "hell…");
  assert.equal(clip("hello!", 5).length, 5);
});

test("guessKind", () => {
  assert.equal(guessKind("Global Hackathon 2026"), "hackathon");
  assert.equal(guessKind("Hack Week"), "hackathon");
  assert.equal(guessKind("Call for Papers: USENIX"), "cfp");
  assert.equal(guessKind("CFP open"), "cfp");
  assert.equal(guessKind("PhD position in vision"), "research");
  assert.equal(guessKind("Summer internship"), "job");
  assert.equal(guessKind("We are hiring"), "job");
  assert.equal(guessKind("Bake sale"), "other");
  assert.equal(guessKind("hackathon research internship"), "hackathon");
});

test("decodeEntities", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;"), `a & b <c> "d" 'e' A`);
  assert.equal(decodeEntities("&AMP; &nbsp;"), "&  ");
  assert.equal(decodeEntities("&unknown; &#0; &#x110000;"), "&unknown; &#0; &#x110000;");
});

test("htmlToText", () => {
  const html = `<html><head><title>x</title></head><body><script>evil()</script><style>p{}</style>
    <h1>Title</h1><p>Hello&nbsp;&amp; welcome</p><ul><li>one</li><li>two</li></ul>line<br>break</body></html>`;
  assert.equal(htmlToText(html), "Title\nHello & welcome\n• one\n• two\nline\nbreak");
});

test("firstLine", () => {
  assert.equal(firstLine("\n  \nfirst\nsecond"), "first");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("abcdef", 4), "abc…");
});
