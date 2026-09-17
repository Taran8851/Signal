/* Signal collector storage — shared by the admin console and the collector worker (collector/).
   A signal is anything worth a look: a DM, a recruiter mail, a hackathon, a CFP, a page that changed. */

import { db } from "./db";

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,             -- gmail | linkedin | discord | devpost | ... | manual
  external_id TEXT NOT NULL,             -- the source's own id, for dedup
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  deadline    TEXT,                      -- YYYY-MM-DD when known
  score       INTEGER NOT NULL DEFAULT 0,
  matched     TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'new',
  note        TEXT NOT NULL DEFAULT '',
  notified    INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_signals_inbox ON signals(status, received_at DESC);

-- one row per collector source: its cursor and last-run health
CREATE TABLE IF NOT EXISTS signal_sources (
  name        TEXT PRIMARY KEY,
  configured  INTEGER NOT NULL DEFAULT 0,
  cursor      TEXT NOT NULL DEFAULT '',
  last_run_at INTEGER,
  last_ok_at  INTEGER,
  last_error  TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''
);
`);

export const KINDS = ["message", "research", "cfp", "hackathon", "job", "post", "page", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ["new", "saved", "applied", "archived"] as const;
export type Status = (typeof STATUSES)[number];

/** Someone wrote to you, or a page you asked to watch changed — these skip the score threshold. */
export const ALWAYS_NOTIFY: readonly Kind[] = ["message", "page"];

export const SOURCES = [
  { id: "gmail",    label: "Gmail + LinkedIn mail", group: "Inbound" },
  { id: "discord",  label: "Discord bot",           group: "Inbound" },
  { id: "devpost",  label: "Devpost",               group: "Hackathons" },
  { id: "devfolio", label: "Devfolio",              group: "Hackathons" },
  { id: "unstop",   label: "Unstop",                group: "Hackathons" },
  { id: "mlh",      label: "MLH",                   group: "Hackathons" },
  { id: "wikicfp",  label: "WikiCFP",               group: "Research" },
  { id: "feeds",    label: "RSS / Google Alerts",   group: "Research" },
  { id: "watch",    label: "Page watch",            group: "Research" },
] as const;
export type SourceId = (typeof SOURCES)[number]["id"];

export type SignalRow = {
  id: number; source: string; external_id: string; kind: Kind; title: string; body: string;
  url: string; author: string; deadline: string | null; score: number; matched: string;
  status: Status; note: string; notified: number; received_at: string; created_at: string;
};

export type NewSignal = {
  source: string; external_id: string; kind: Kind; title: string;
  body?: string; url?: string; author?: string; deadline?: string | null; received_at?: string;
};

/* ---------------- helpers ---------------- */

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Only http(s) survives — a javascript: link inside a scraped message would run in the admin origin. */
export function safeUrl(u: string | undefined | null): string {
  if (!u) return "";
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : "";
  } catch {
    return "";
  }
}

/** Anything Date can parse → YYYY-MM-DD in local time, else null. */
export function isoDate(v: unknown): string | null {
  if (!v) return null;
  // a bare date would be read as UTC midnight and can slip a day in local time
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA");
}

export function guessKind(text: string): Kind {
  if (/hackathon|hack ?week|buildathon|ideathon|datathon/i.test(text)) return "hackathon";
  if (/call for papers|\bcfp\b|submission deadline|paper submission/i.test(text)) return "cfp";
  if (/research|fellowship|\bph\.?d\b|professor|\blab\b|thesis|scholar/i.test(text)) return "research";
  if (/intern(ship)?|hiring|\bjobs?\b|position|vacanc|opening/i.test(text)) return "job";
  return "other";
}

/* ---------------- preferences ---------------- */

export type Link = { label: string; url: string };

export type SignalPrefs = {
  interests: string[];        // fields you work in — 3 points each, 4 in the title
  boost: string[];            // opportunity words — 2 points each
  exclude: string[];          // any hit archives the item on arrival
  threshold: number;          // min score before a discovered item pushes a notification
  cfpCategories: string[];    // WikiCFP categories
  feeds: Link[];              // RSS/Atom — Google Alerts, job boards, lab blogs
  watch: Link[];              // pages to diff — fellowship and program pages
  discordChannels: string[];  // channel ids to scan; empty = every channel the bot can read
  desktop: boolean;
  telegram: boolean;
  disabled: string[];         // source ids switched off
};

export const PREF_DEFAULTS: SignalPrefs = {
  interests: [
    "computer vision", "edge AI", "edge inference", "spiking neural network", "neuromorphic",
    "cybersecurity", "security", "embedded", "IoT", "LLM agents", "AI safety",
  ],
  boost: [
    "research intern", "research internship", "summer research", "research assistant", "fellowship",
    "undergraduate research", "call for papers", "stipend", "internship", "hackathon",
  ],
  exclude: [],
  threshold: 3,
  cfpCategories: ["security", "computer vision", "machine learning", "embedded systems"],
  feeds: [],
  watch: [],
  discordChannels: [],
  desktop: true,
  telegram: true,
  disabled: [],
};

export function getPrefs(): SignalPrefs {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'signal_prefs'").get() as { value: string } | undefined;
  if (!row) return structuredClone(PREF_DEFAULTS);
  try {
    return { ...structuredClone(PREF_DEFAULTS), ...JSON.parse(row.value) };
  } catch {
    return structuredClone(PREF_DEFAULTS);
  }
}

export function setPrefs(p: SignalPrefs) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('signal_prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify(p));
}

/* ---------------- scoring ---------------- */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// letter/digit boundaries, so "AI" doesn't fire on "said" and "IoT" doesn't fire on "idiot" —
// plus an optional plural, so "hackathon" still finds "hackathons" and "internship" "internships"
const termRe = (t: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?:s|es|'s)?(?![\\p{L}\\p{N}])`, "iu");

export type Scored = { score: number; matched: string[]; excluded: boolean };

export function scoreText(prefs: SignalPrefs, title: string, body: string): Scored {
  let score = 0;
  const matched: string[] = [];
  for (const t of prefs.interests) {
    const re = termRe(t);
    const inTitle = re.test(title);
    if (inTitle || re.test(body)) { score += inTitle ? 4 : 3; matched.push(t); }
  }
  for (const t of prefs.boost) {
    const re = termRe(t);
    if (re.test(title) || re.test(body)) { score += 2; matched.push(t); }
  }
  const excluded = prefs.exclude.some((t) => { const re = termRe(t); return re.test(title) || re.test(body); });
  return { score, matched, excluded };
}

/* ---------------- signals ---------------- */

export const getSignal = (id: number) =>
  db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined;

export const isKnown = (source: string, externalId: string) =>
  !!db.prepare("SELECT 1 FROM signals WHERE source = ? AND external_id = ?").get(source, externalId);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO signals
    (source, external_id, kind, title, body, url, author, deadline, score, matched, status, received_at, created_at)
  VALUES
    (@source, @external_id, @kind, @title, @body, @url, @author, @deadline, @score, @matched, @status, @received_at, @created_at)`);

/** Returns the stored row when it's new, null when this (source, external_id) was already seen. */
export function insertSignal(s: NewSignal, scored: Scored): SignalRow | null {
  const now = new Date().toISOString();
  const info = insertStmt.run({
    source: s.source,
    external_id: s.external_id.slice(0, 500),
    kind: (KINDS as readonly string[]).includes(s.kind) ? s.kind : "other",
    title: clip(s.title.trim() || "(untitled)", 300),
    body: clip(s.body ?? "", 20_000),
    url: safeUrl(s.url),
    author: clip(s.author ?? "", 200),
    deadline: s.deadline ?? null,
    score: scored.score,
    matched: JSON.stringify(scored.matched),
    // excluded items are still stored so they stay deduped — just never in the inbox
    status: scored.excluded ? "archived" : "new",
    received_at: s.received_at ?? now,
    created_at: now,
  });
  return info.changes ? getSignal(Number(info.lastInsertRowid)) ?? null : null;
}

export type SignalFilter = { status?: string; kind?: string; source?: string; q?: string; sort?: string };

const ORDER: Record<string, string> = {
  recent: "received_at DESC",
  deadline: "deadline IS NULL, deadline ASC, received_at DESC",
  score: "score DESC, received_at DESC",
};

function where(f: SignalFilter) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.status && f.status !== "all") { clauses.push("status = ?"); params.push(f.status); }
  if (f.kind) { clauses.push("kind = ?"); params.push(f.kind); }
  if (f.source) { clauses.push("source = ?"); params.push(f.source); }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

export function listSignals(f: SignalFilter, limit = 50, offset = 0) {
  const w = where(f);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM signals ${w.sql}`).get(...w.params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT * FROM signals ${w.sql} ORDER BY ${ORDER[f.sort ?? ""] ?? ORDER.recent} LIMIT ? OFFSET ?`
  ).all(...w.params, limit, offset) as SignalRow[];
  return { rows, total };
}

export function archiveMatching(f: SignalFilter): number {
  const w = where(f);
  return db.prepare(`UPDATE signals SET status = 'archived' ${w.sql}`).run(...w.params).changes;
}

export function statusCounts() {
  const out: Record<string, number> = { new: 0, saved: 0, applied: 0, archived: 0, all: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM signals GROUP BY status").all() as { status: string; n: number }[]) {
    out[r.status] = r.n;
    out.all += r.n;
  }
  return out;
}

export function setStatus(id: number, status: Status) {
  db.prepare("UPDATE signals SET status = ? WHERE id = ?").run(status, id);
}

export type SignalEdit = {
  title: string; kind: Kind; url: string; deadline: string | null; body: string; note: string; status: Status;
};

export function updateSignal(id: number, e: SignalEdit) {
  db.prepare(`UPDATE signals SET title=?, kind=?, url=?, deadline=?, body=?, note=?, status=? WHERE id=?`)
    .run(clip(e.title, 300), e.kind, safeUrl(e.url), e.deadline, clip(e.body, 20_000), e.note, e.status, id);
}

/** Something you found yourself — a LinkedIn post, a poster in the corridor. */
export function createManual(e: SignalEdit): number {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO signals (source, external_id, kind, title, body, url, author, deadline, score, matched, status, note, notified, received_at, created_at)
    VALUES ('manual', ?, ?, ?, ?, ?, '', ?, 0, '[]', ?, ?, 1, ?, ?)`)
    .run(crypto.randomUUID(), e.kind, clip(e.title, 300), clip(e.body, 20_000), safeUrl(e.url), e.deadline, e.status, e.note, now, now);
  return Number(info.lastInsertRowid);
}

export function deleteSignal(id: number) {
  db.prepare("DELETE FROM signals WHERE id = ?").run(id);
}

export function markNotified(ids: number[]) {
  const stmt = db.prepare("UPDATE signals SET notified = 1 WHERE id = ?");
  db.transaction(() => ids.forEach((id) => stmt.run(id)))();
}

/* ---------------- source health ---------------- */

export type SourceState = {
  name: string; configured: number; cursor: string; last_run_at: number | null;
  last_ok_at: number | null; last_error: string; detail: string;
};

export function sourceState(name: string): SourceState {
  db.prepare("INSERT OR IGNORE INTO signal_sources (name) VALUES (?)").run(name);
  return db.prepare("SELECT * FROM signal_sources WHERE name = ?").get(name) as SourceState;
}

const SOURCE_COLS = ["configured", "cursor", "last_run_at", "last_ok_at", "last_error", "detail"] as const;

export function updateSource(name: string, patch: Partial<Omit<SourceState, "name">>) {
  sourceState(name);
  const keys = SOURCE_COLS.filter((k) => k in patch);
  if (!keys.length) return;
  db.prepare(`UPDATE signal_sources SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE name = @name`)
    .run({ ...patch, name });
}

export function listSourceStates(): Record<string, SourceState> {
  const out: Record<string, SourceState> = {};
  for (const r of db.prepare("SELECT * FROM signal_sources").all() as SourceState[]) out[r.name] = r;
  return out;
}

/* ---------------- display ---------------- */

export function ago(t: string | number | null | undefined) {
  if (!t) return "never";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function sourceHealth(s: SourceState | undefined): { tone: "off" | "ok" | "failing"; note: string } {
  if (!s || !s.configured) return { tone: "off", note: s?.detail || "not set up" };
  const failing = !!s.last_run_at && (!s.last_ok_at || s.last_ok_at < s.last_run_at);
  if (failing) return { tone: "failing", note: s.last_error };
  return { tone: "ok", note: [ago(s.last_ok_at), s.detail, s.last_error].filter(Boolean).join(" · ") };
}
