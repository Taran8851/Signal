/* Enumerations and row shapes. Mirrors reference/signal/signals.ts L40-L69. */

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

export const isKind = (k: unknown): k is Kind => (KINDS as readonly unknown[]).includes(k);
export const isStatus = (s: unknown): s is Status => (STATUSES as readonly unknown[]).includes(s);

/** A stored signal. `matched` is kept as a JSON string in the reference schema; storage layers may differ. */
export type SignalRow = {
  id: number | string;
  source: string;
  external_id: string;
  kind: Kind;
  title: string;
  body: string;
  url: string;
  author: string;
  deadline: string | null;   // YYYY-MM-DD when known
  score: number;
  matched: string | string[];
  status: Status;
  note: string;
  notified: number | boolean;
  received_at: string;       // ISO timestamp
  created_at: string;
};

export type NewSignal = {
  source: string; external_id: string; kind: Kind; title: string;
  body?: string; url?: string; author?: string; deadline?: string | null; received_at?: string;
};
