/* Seam for hosted-app scoring modes (AGENTS.md "Scoring modes in the hosted app",
   docs/platform_plan.md §2). No LLM call lives here — only the pure routing decision. */

import type { Scored } from "./score.ts";

export const SCORING_MODES = ["keyword", "hybrid", "llm"] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];
export const DEFAULT_SCORING_MODE: ScoringMode = "keyword";
export const DEFAULT_PREFILTER = 1;

/** Keyword threshold is an integer (default 3); LLM relevance is 0–10 (default 6). Never mixed. */
export const DEFAULT_LLM_THRESHOLD = 6;

export type ScoreSource = "KEYWORD" | "LLM";

/** Shape the LLM must return (validated by the caller). */
export type LlmVerdict = { relevance: number; reasons: string[]; deadline?: string };

export const normalizeScoringMode = (m: unknown): ScoringMode =>
  typeof m === "string" && (SCORING_MODES as readonly string[]).includes(m) ? (m as ScoringMode) : DEFAULT_SCORING_MODE;

/**
 * Should this item be sent to the user's LLM? Exclude always runs first, so excluded items never go.
 * keyword → never; llm → every non-excluded item; hybrid → only when keyword score ≥ prefilter.
 */
export function decideScoring(
  mode: ScoringMode | string,
  keyword: Pick<Scored, "score" | "excluded">,
  prefilter: number = DEFAULT_PREFILTER,
): boolean {
  if (keyword.excluded) return false;
  const m = normalizeScoringMode(mode);
  if (m === "llm") return true;
  if (m === "hybrid") return keyword.score >= (Number.isFinite(prefilter) ? prefilter : DEFAULT_PREFILTER);
  return false;
}
