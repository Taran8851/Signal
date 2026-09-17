/* Keyword scoring. Mirrors reference/signal/signals.ts L160-L181. */

import type { SignalPrefs } from "./prefs.ts";

export const WEIGHTS = { interestTitle: 4, interestBody: 3, boost: 2 } as const;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Case-insensitive, letter/digit (Unicode) boundaries so "AI" doesn't fire on "said" and "IoT" doesn't
 * fire on "idiot"; an optional plural (s, es, 's) so "hackathon" still finds "hackathons".
 */
export const termRe = (t: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?:s|es|'s)?(?![\\p{L}\\p{N}])`, "iu");

export type Scored = { score: number; matched: string[]; excluded: boolean };

export function scoreText(prefs: Pick<SignalPrefs, "interests" | "boost" | "exclude">, title: string, body: string): Scored {
  let score = 0;
  const matched: string[] = [];
  for (const t of prefs.interests) {
    const re = termRe(t);
    const inTitle = re.test(title);
    if (inTitle || re.test(body)) { score += inTitle ? WEIGHTS.interestTitle : WEIGHTS.interestBody; matched.push(t); }
  }
  for (const t of prefs.boost) {
    const re = termRe(t);
    if (re.test(title) || re.test(body)) { score += WEIGHTS.boost; matched.push(t); }
  }
  const excluded = prefs.exclude.some((t) => { const re = termRe(t); return re.test(title) || re.test(body); });
  return { score, matched, excluded };
}

export type ScoreHit = { term: string; list: "interest" | "boost"; where: "title" | "body"; points: number };
export type ScoreExplanation = Scored & { hits: ScoreHit[]; excludedBy: string[] };

/**
 * Same result as scoreText plus a per-term breakdown. `where` is "title" whenever the title matched
 * (title is checked first, as in the reference). `excludedBy` lists every exclude term that hit.
 */
export function explainScore(prefs: Pick<SignalPrefs, "interests" | "boost" | "exclude">, title: string, body: string): ScoreExplanation {
  const hits: ScoreHit[] = [];
  for (const t of prefs.interests) {
    const re = termRe(t);
    if (re.test(title)) hits.push({ term: t, list: "interest", where: "title", points: WEIGHTS.interestTitle });
    else if (re.test(body)) hits.push({ term: t, list: "interest", where: "body", points: WEIGHTS.interestBody });
  }
  for (const t of prefs.boost) {
    const re = termRe(t);
    if (re.test(title)) hits.push({ term: t, list: "boost", where: "title", points: WEIGHTS.boost });
    else if (re.test(body)) hits.push({ term: t, list: "boost", where: "body", points: WEIGHTS.boost });
  }
  const excludedBy = prefs.exclude.filter((t) => { const re = termRe(t); return re.test(title) || re.test(body); });
  return {
    score: hits.reduce((n, h) => n + h.points, 0),
    matched: hits.map((h) => h.term),
    excluded: excludedBy.length > 0,
    hits,
    excludedBy,
  };
}
