/* Shared plumbing for the collector's sources. */

import type { NewSignal, SignalPrefs } from "../src/lib/signals.ts";

// An honest User-Agent. Devpost 403s a bare "Mozilla/5.0" but serves this fine.
export const UA = "signals-collector/0.1 (personal opportunity tracker)";

/** quiet: store it but don't push — e.g. the first fetch of a feed you just added. */
export type Found = Omit<NewSignal, "source"> & { source?: string; quiet?: boolean };

export type PollContext = {
  prefs: SignalPrefs;
  cursor: string;
  setCursor: (v: string) => void;
  /** a partial failure (one feed of five) — shown in the console, the run still counts as ok */
  warn: (msg: string) => void;
};

export type Poller = {
  id: string;
  everyMs: number;
  /** null when ready to run, otherwise what's missing. */
  missing: () => string | null;
  poll: (ctx: PollContext) => Promise<Found[]>;
};

async function get(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res;
}

export const getJson = async <T = any>(url: string, init: RequestInit = {}): Promise<T> =>
  (await get(url, { ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } })).json() as Promise<T>;

export const getText = async (url: string) => (await get(url)).text();

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Good-enough HTML → text for scoring and previews. Never rendered as HTML. */
export function htmlToText(html: string) {
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

export const firstLine = (s: string, n = 120) => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
