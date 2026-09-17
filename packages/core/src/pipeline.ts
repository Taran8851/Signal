/* Ingest, schedule and notification rules.
   statusOnInsert   ← reference/signal/signals.ts L211-L212 (insertSignal)
   shouldNotify     ← reference/signal/collector/index.ts L35-L36 (ingest), quiet from L54
   isFailing / nextWaitMs / isDue ← reference/signal/collector/index.ts L22, L76-L78 (tick)
   planNotifications ← reference/signal/collector/notify.ts L43-L97 (single, digest, notify) */

import { ALWAYS_NOTIFY, type Kind, type SignalRow, type Status } from "./constants.ts";
import type { SignalPrefs } from "./prefs.ts";
import type { Scored } from "./score.ts";
import { clip } from "./text.ts";

/** Excluded items are still stored (so they stay deduped) but go straight to archived. */
export const statusOnInsert = (scored: Pick<Scored, "excluded">): Status => (scored.excluded ? "archived" : "new");

export type SourceState = { last_run_at: number | null | undefined; last_ok_at: number | null | undefined };

/** The first successful run of a source is a backfill: store everything, notify about nothing. */
export const isBackfill = (state: Pick<SourceState, "last_ok_at">): boolean => !state.last_ok_at;

export type NotifyInput = {
  kind: Kind;
  score: number;
  excluded: boolean;
  /** run-level quiet — true on a backfill run (see isBackfill) */
  quiet: boolean;
  /** item-level quiet, e.g. the first fetch of a feed just added */
  itemQuiet?: boolean;
};

export function shouldNotify(it: NotifyInput, prefs: Pick<SignalPrefs, "threshold">): boolean {
  if (it.quiet || it.itemQuiet || it.excluded) return false;
  return ALWAYS_NOTIFY.includes(it.kind) || it.score >= prefs.threshold;
}

/** A failing source retries sooner than its normal interval. */
export const RETRY_MS = 15 * 60_000;

export type PollerTiming = { everyMs: number };

export const isFailing = (s: SourceState): boolean =>
  !!s.last_run_at && (!s.last_ok_at || s.last_ok_at < s.last_run_at);

export const nextWaitMs = (p: PollerTiming, s: SourceState): number =>
  isFailing(s) ? Math.min(p.everyMs, RETRY_MS) : p.everyMs;

/** Whether tick() would start this poller now (ignoring the "already running" guard). */
export const isDue = (p: PollerTiming, s: SourceState, now: number): boolean =>
  !s.last_run_at || now - s.last_run_at >= nextWaitMs(p, s);

/* ---------------- notification plan ---------------- */

export const MAX_DIRECT = 5;
export const DIGEST_AFTER = 3;
export const DIGEST_TOP = 8;

export const ICON: Record<string, string> = {
  message: "💬", research: "🔬", cfp: "📄", hackathon: "🏁", job: "💼", post: "📣", page: "🔁", other: "•",
};

export type NotifyRow = Pick<SignalRow, "id" | "kind" | "title" | "score"> &
  Partial<Pick<SignalRow, "source" | "author" | "deadline" | "url" | "body">>;

export type PlannedNote<R extends NotifyRow = NotifyRow> =
  | { type: "single"; row: R; title: string }
  | { type: "more"; count: number; title: string }
  | { type: "digest"; total: number; top: R[]; more: number; title: string };

/**
 * Direct items (ALWAYS_NOTIFY kinds) go out one by one, max 5, then one "N more messages" note.
 * Discovered items: ≤3 → singles; >3 → one digest listing the top 8 by score (stable on ties).
 * Titles follow the reference wording; rendering to Telegram HTML is left to the caller.
 */
export function planNotifications<R extends NotifyRow>(rows: readonly R[]): PlannedNote<R>[] {
  if (!rows.length) return [];
  const single = (r: R): PlannedNote<R> => ({ type: "single", row: r, title: `${ICON[r.kind] ?? "•"} ${clip(r.title, 90)}` });
  const direct = rows.filter((r) => ALWAYS_NOTIFY.includes(r.kind));
  const found = rows.filter((r) => !ALWAYS_NOTIFY.includes(r.kind));
  const notes: PlannedNote<R>[] = direct.slice(0, MAX_DIRECT).map(single);
  if (direct.length > MAX_DIRECT) {
    const count = direct.length - MAX_DIRECT;
    notes.push({ type: "more", count, title: `💬 ${count} more messages` });
  }
  if (found.length > DIGEST_AFTER) {
    const top = [...found].sort((a, b) => b.score - a.score).slice(0, DIGEST_TOP);
    notes.push({ type: "digest", total: found.length, top, more: found.length - top.length, title: `📡 ${found.length} new matches` });
  } else {
    notes.push(...found.map(single));
  }
  return notes;
}
