/* Inbox ordering. Mirrors ORDER in reference/signal/signals.ts L221-L225 and the fallback at L245.
   Values are compared as strings, like SQLite TEXT columns (ISO dates sort lexicographically). */

import type { SignalRow } from "./constants.ts";

export const SORTS = ["recent", "deadline", "score"] as const;
export type SortKey = (typeof SORTS)[number];

type Sortable = Pick<SignalRow, "received_at" | "deadline" | "score">;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** received_at DESC */
export const byRecent = (a: Sortable, b: Sortable): number => cmpStr(b.received_at, a.received_at);

/** deadline IS NULL, deadline ASC, received_at DESC */
export const byDeadline = (a: Sortable, b: Sortable): number => {
  const an = a.deadline == null, bn = b.deadline == null;
  if (an !== bn) return an ? 1 : -1;
  if (!an && !bn) { const c = cmpStr(a.deadline as string, b.deadline as string); if (c) return c; }
  return byRecent(a, b);
};

/** score DESC, received_at DESC */
export const byScore = (a: Sortable, b: Sortable): number => b.score - a.score || byRecent(a, b);

export const COMPARATORS: Record<SortKey, (a: Sortable, b: Sortable) => number> = {
  recent: byRecent, deadline: byDeadline, score: byScore,
};

export const normalizeSort = (s: unknown): SortKey =>
  typeof s === "string" && (SORTS as readonly string[]).includes(s) ? (s as SortKey) : "recent";

/** Returns a new sorted array; unknown sort keys fall back to "recent". */
export function sortSignals<R extends Sortable>(rows: readonly R[], sort?: string): R[] {
  return [...rows].sort(COMPARATORS[normalizeSort(sort)]);
}
