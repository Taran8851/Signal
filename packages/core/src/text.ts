/* Text helpers. clip/safeUrl/isoDate/guessKind mirror reference/signal/signals.ts L74-L102;
   decodeEntities/htmlToText/firstLine mirror reference/signal/collector/util.ts L42-L71. */

import type { Kind } from "./constants.ts";

/** Truncate to n characters total, ending in an ellipsis when cut. */
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Only http(s) survives — a javascript: link would run in the app origin. Returns "" otherwise. */
export function safeUrl(u: string | undefined | null): string {
  if (!u) return "";
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : "";
  } catch {
    return "";
  }
}

/**
 * Anything Date can parse → YYYY-MM-DD in the process's local time zone, else null.
 * A bare YYYY-MM-DD is returned unchanged (Date would read it as UTC midnight and it could slip a day).
 */
export function isoDate(v: unknown): string | null {
  if (!v) return null;
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

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Good-enough HTML → text for scoring and previews. The result must never be rendered as HTML. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

/** First non-blank line, clipped to n. */
export const firstLine = (s: string, n = 120): string => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};
