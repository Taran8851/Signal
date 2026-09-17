/* Preferences. Type + defaults mirror reference/signal/signals.ts L106-L140; the merge mirrors
   getPrefs() L142-L150; sanitizing mirrors reference/signal/admin-ui/preferences.astro L9-L48. */

import { SOURCES } from "./constants.ts";
import { safeUrl } from "./text.ts";

export type Link = { label: string; url: string };

export type SignalPrefs = {
  interests: string[];        // fields you work in — 3 points each, 4 in the title
  boost: string[];            // opportunity words — 2 points each
  exclude: string[];          // any hit archives the item on arrival
  threshold: number;          // min score (1–30) before a discovered item pushes a notification
  cfpCategories: string[];    // WikiCFP categories, lowercase
  feeds: Link[];              // RSS/Atom — Google Alerts, job boards, lab blogs
  watch: Link[];              // pages to diff — fellowship and program pages
  discordChannels: string[];  // channel ids to scan; empty = every channel the bot can read
  /** Kept for parity with the reference (notify-send). The hosted app has no desktop and ignores it. */
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

export const defaultPrefs = (): SignalPrefs => structuredClone(PREF_DEFAULTS);

export const LIMITS = {
  termLength: 80,
  terms: 80,
  cfpCategories: 20,
  discordChannels: 100,
  links: 50,
  linkLabel: 60,
  thresholdMin: 1,
  thresholdMax: 30,
} as const;

/** A list field: a textarea string (split on newlines and commas, as the form does) or an array. */
export function sanitizeList(v: unknown, max: number = LIMITS.terms): string[] {
  const parts: unknown[] = typeof v === "string" ? v.split(/[\n,]/) : Array.isArray(v) ? v : [];
  const cleaned = parts
    .filter((t) => typeof t === "string" || typeof t === "number")
    .map((t) => String(t).trim().slice(0, LIMITS.termLength))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, max);
}

/**
 * Links: a textarea string with "Label | https://…" per line, or an array of {label, url} / URL strings.
 * Non-http(s) entries are dropped and reported in `bad`. A missing label becomes the hostname.
 */
export function sanitizeLinks(v: unknown, bad: string[] = []): Link[] {
  const entries: { label: string; rawUrl: string; line: string }[] = [];
  if (typeof v === "string") {
    for (const raw of v.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const bar = line.indexOf("|");
      entries.push({
        label: bar >= 0 ? line.slice(0, bar).trim() : "",
        rawUrl: bar >= 0 ? line.slice(bar + 1).trim() : line,
        line,
      });
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "string") {
        if (item.trim()) entries.push({ label: "", rawUrl: item.trim(), line: item.trim() });
      } else if (item && typeof item === "object") {
        const o = item as { label?: unknown; url?: unknown };
        const rawUrl = typeof o.url === "string" ? o.url.trim() : "";
        const label = typeof o.label === "string" ? o.label.trim() : "";
        entries.push({ label, rawUrl, line: label ? `${label} | ${rawUrl}` : rawUrl });
      }
    }
  }
  const out: Link[] = [];
  for (const e of entries) {
    const url = safeUrl(e.rawUrl);
    if (!url) { bad.push(e.line); continue; }
    out.push({ label: (e.label || new URL(url).hostname).slice(0, LIMITS.linkLabel), url });
  }
  return out.slice(0, LIMITS.links);
}

export function sanitizeThreshold(v: unknown): number {
  if (v === undefined || v === null || v === "") return PREF_DEFAULTS.threshold;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n)
    ? Math.min(LIMITS.thresholdMax, Math.max(LIMITS.thresholdMin, Math.round(n)))
    : PREF_DEFAULTS.threshold;
}

export type NormalizeResult = { prefs: SignalPrefs; skippedLinks: string[] };

/**
 * Merge a partial/untrusted prefs object over the defaults (like getPrefs) and sanitize every field
 * (like the preferences form). Fields absent from `input` keep their default value.
 */
export function normalizePrefsDetailed(input: unknown): NormalizeResult {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const d = defaultPrefs();
  const has = (k: keyof SignalPrefs) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
  const bool = (k: "desktop" | "telegram") => (typeof src[k] === "boolean" ? (src[k] as boolean) : d[k]);
  const known = new Set<string>(SOURCES.map((s) => s.id));
  const skippedLinks: string[] = [];

  const prefs: SignalPrefs = {
    interests: has("interests") ? sanitizeList(src.interests) : d.interests,
    boost: has("boost") ? sanitizeList(src.boost) : d.boost,
    exclude: has("exclude") ? sanitizeList(src.exclude) : d.exclude,
    threshold: has("threshold") ? sanitizeThreshold(src.threshold) : d.threshold,
    cfpCategories: has("cfpCategories")
      ? sanitizeList(src.cfpCategories, LIMITS.cfpCategories).map((c) => c.toLowerCase())
      : d.cfpCategories,
    feeds: has("feeds") ? sanitizeLinks(src.feeds, skippedLinks) : d.feeds,
    watch: has("watch") ? sanitizeLinks(src.watch, skippedLinks) : d.watch,
    discordChannels: has("discordChannels")
      ? sanitizeList(src.discordChannels, LIMITS.discordChannels).filter((x) => /^\d{5,25}$/.test(x))
      : d.discordChannels,
    desktop: bool("desktop"),
    telegram: bool("telegram"),
    disabled: has("disabled") ? sanitizeList(src.disabled, SOURCES.length).filter((id) => known.has(id)) : d.disabled,
  };
  return { prefs, skippedLinks };
}

export const normalizePrefs = (input: unknown): SignalPrefs => normalizePrefsDetailed(input).prefs;
