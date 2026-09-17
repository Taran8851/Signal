/* Research-side sources: WikiCFP calls for papers, any RSS/Atom feed (Google Alerts, job boards,
   lab blogs), and a page watcher for fellowship and program pages that publish no feed at all. */

import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { guessKind, isKnown, isoDate } from "../../src/lib/signals.ts";
import { getText, htmlToText, sleep, type Found, type Poller } from "../util.ts";

const HOURS = 3_600_000;
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });
const arr = <T,>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : v?.["#text"] != null ? String(v["#text"]) : "";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const seenList = (cursor: string): Set<string> => {
  try { return new Set(JSON.parse(cursor)); } catch { return new Set(); }
};

/* ---------------- WikiCFP ---------------- */

/** The submission deadline is only on the event page, and is often "TBD". */
async function cfpDeadline(url: string): Promise<string | null> {
  const html = await getText(url);
  const i = html.indexOf("Submission Deadline</th>");
  if (i < 0) return null;
  const cell = html.slice(i, i + 600).split("</td>")[0];
  const m = cell.match(/content="(\d{4}-\d{2}-\d{2})/) ?? cell.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  return m ? isoDate(m[1] ?? m[0]) : null;
}

export const wikicfp: Poller = {
  id: "wikicfp",
  everyMs: 6 * HOURS,
  missing: () => null,
  async poll({ prefs, cursor, setCursor, warn }) {
    const seen = seenList(cursor);
    const out: Found[] = [];
    let pageBudget = 15; // event-page fetches per run — WikiCFP is a small volunteer site
    for (const cat of prefs.cfpCategories) {
      try {
        // http only: wikicfp.com doesn't listen on 443
        const feed = xml.parse(await getText(`http://www.wikicfp.com/cfp/rss?cat=${encodeURIComponent(cat)}`));
        for (const it of arr<any>(feed.rss?.channel?.item)) {
          const id = txt(it.guid) || txt(it.link);
          const url = txt(it.link);
          let deadline: string | null = null;
          if (!isKnown("wikicfp", id) && pageBudget-- > 0) {
            deadline = await cfpDeadline(url).catch(() => null);
            await sleep(800);
          }
          out.push({
            // the category goes in author, not body: in the body it would score every CFP in a
            // category against the interest of the same name
            external_id: id, kind: "cfp", title: txt(it.title), url, deadline,
            body: txt(it.description), author: `WikiCFP · ${cat}`,
            quiet: !seen.has(cat), // a category you just added shouldn't dump its whole backlog on your phone
          });
        }
        seen.add(cat);
      } catch (e) {
        warn(`${cat}: ${(e as Error).message}`);
      }
    }
    setCursor(JSON.stringify([...seen]));
    return out;
  },
};

/* ---------------- RSS / Atom ---------------- */

/** Google Alerts wraps every link in a google.com/url redirect — unwrap it. */
function unwrap(u: string) {
  try {
    const p = new URL(u);
    if (p.hostname.endsWith("google.com") && p.pathname === "/url") return p.searchParams.get("url") ?? u;
  } catch {}
  return u;
}

type Entry = { id: string; title: string; url: string; body: string; date: string };

function parseFeed(raw: string): Entry[] {
  const doc = xml.parse(raw);
  if (doc.rss) {
    return arr<any>(doc.rss.channel?.item).map((it) => ({
      id: txt(it.guid) || txt(it.link), title: txt(it.title), url: txt(it.link),
      body: txt(it.description) || txt(it["content:encoded"]), date: txt(it.pubDate),
    }));
  }
  if (doc.feed) {
    return arr<any>(doc.feed.entry).map((e) => {
      const links = arr<any>(e.link);
      const alt = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
      return {
        id: txt(e.id) || alt?.["@href"] || "", title: txt(e.title), url: alt?.["@href"] ?? "",
        body: txt(e.content) || txt(e.summary), date: txt(e.updated) || txt(e.published),
      };
    });
  }
  if (doc["rdf:RDF"]) {
    return arr<any>(doc["rdf:RDF"].item).map((it) => ({
      id: txt(it.link), title: txt(it.title), url: txt(it.link), body: txt(it.description), date: txt(it["dc:date"]),
    }));
  }
  throw new Error("not an RSS or Atom feed");
}

export const feeds: Poller = {
  id: "feeds",
  everyMs: 30 * 60_000,
  missing: () => null,
  async poll({ prefs, cursor, setCursor, warn }) {
    const seen = seenList(cursor);
    const out: Found[] = [];
    for (const f of prefs.feeds) {
      try {
        for (const e of parseFeed(await getText(f.url)).slice(0, 50)) {
          const url = unwrap(e.url);
          const title = htmlToText(e.title);
          const body = htmlToText(e.body);
          const when = e.date ? new Date(e.date) : null;
          out.push({
            external_id: sha(`${f.url}|${e.id || url}`),
            kind: /linkedin\.com\//.test(url) ? "post" : guessKind(`${title}\n${body}`),
            title, url, body, author: f.label,
            received_at: when && !Number.isNaN(when.getTime()) ? when.toISOString() : undefined,
            quiet: !seen.has(f.url),
          });
        }
        seen.add(f.url);
      } catch (e) {
        warn(`${f.label}: ${(e as Error).message}`);
      }
    }
    setCursor(JSON.stringify([...seen]));
    return out;
  },
};

/* ---------------- page watch ---------------- */

type Snapshot = { hash: string; lines: string[] };

/** Diff a page's visible text line by line and report only what's new. First sight is the baseline. */
export const watch: Poller = {
  id: "watch",
  everyMs: 6 * HOURS,
  missing: () => null,
  async poll({ prefs, cursor, setCursor, warn }) {
    let prev: Record<string, Snapshot> = {};
    try { prev = cursor ? JSON.parse(cursor) : {}; } catch {}
    const next: Record<string, Snapshot> = {};
    const out: Found[] = [];
    for (const w of prefs.watch) {
      try {
        const lines = [...new Set(
          htmlToText(await getText(w.url)).split("\n").map((l) => l.trim().slice(0, 300)).filter((l) => l.length >= 3)
        )].slice(0, 800);
        const hash = sha(lines.join("\n"));
        const before = prev[w.url];
        next[w.url] = { hash, lines };
        if (!before || before.hash === hash) continue;
        const old = new Set(before.lines);
        const added = lines.filter((l) => !old.has(l));
        if (!added.length) continue; // only removals — nothing new to read
        out.push({
          external_id: `${w.url}#${hash.slice(0, 16)}`,
          kind: "page",
          title: `${w.label} changed`,
          url: w.url,
          author: w.label,
          body: "New on the page:\n" + added.slice(0, 20).join("\n"),
        });
      } catch (e) {
        warn(`${w.label}: ${(e as Error).message}`);
        if (prev[w.url]) next[w.url] = prev[w.url]; // keep the baseline through a transient failure
      }
    }
    setCursor(JSON.stringify(next));
    return out;
  },
};
