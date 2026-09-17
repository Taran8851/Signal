/* Where signals go: Telegram (phone, and Telegram Desktop if you run it) and notify-send on this machine.
   On a VPS there is no desktop session — notify-send quietly fails and Telegram carries everything. */

import { spawn } from "node:child_process";
import { ALWAYS_NOTIFY, clip, markNotified, type SignalPrefs, type SignalRow } from "../src/lib/signals.ts";

const ICON: Record<string, string> = {
  message: "💬", research: "🔬", cfp: "📄", hackathon: "🏁", job: "💼", post: "📣", page: "🔁", other: "•",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
const snippet = (s: string, n = 220) => clip(s.replace(/\s+/g, " ").trim(), n);

export const telegramReady = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

async function telegram(html: string) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: clip(html, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function desktop(title: string, body: string) {
  // argv, never a shell — titles come from strangers. Most notification daemons parse
  // body markup, so it's escaped too.
  const p = spawn("notify-send", ["-a", "Signals", "-i", "mail-message-new", title, esc(body)], { stdio: "ignore" });
  p.on("error", () => {});
}

type Note = { title: string; plain: string; html: string };

const consoleUrl = () => process.env.SIGNALS_CONSOLE_URL?.replace(/\/$/, "") ?? "";

function single(r: SignalRow): Note {
  const meta = [r.source, r.author, r.deadline && `due ${r.deadline}`].filter(Boolean).join(" · ");
  const link = r.url || (consoleUrl() && `${consoleUrl()}/${r.id}`);
  return {
    title: `${ICON[r.kind] ?? "•"} ${clip(r.title, 90)}`,
    plain: [meta, snippet(r.body, 160)].filter(Boolean).join("\n"),
    html: [
      `${ICON[r.kind] ?? "•"} <b>${esc(clip(r.title, 200))}</b>`,
      meta && `<i>${esc(meta)}</i>`,
      r.body && esc(snippet(r.body)),
      link && `<a href="${escAttr(link)}">open</a>`,
    ].filter(Boolean).join("\n"),
  };
}

function digest(rows: SignalRow[]): Note {
  const top = [...rows].sort((a, b) => b.score - a.score).slice(0, 8);
  const head = `${rows.length} new matches`;
  const lines = top.map((r) => {
    const t = esc(clip(r.title, 90));
    const due = r.deadline ? ` — due ${r.deadline}` : "";
    return `${ICON[r.kind] ?? "•"} ${r.url ? `<a href="${escAttr(r.url)}">${t}</a>` : t}${due}`;
  });
  if (rows.length > top.length) lines.push(`…and ${rows.length - top.length} more`);
  if (consoleUrl()) lines.push(`<a href="${escAttr(consoleUrl())}">Open the console</a>`);
  return {
    title: `📡 ${head}`,
    plain: top.slice(0, 4).map((r) => `• ${clip(r.title, 70)}`).join("\n"),
    html: [`📡 <b>${head}</b>`, ...lines].join("\n"),
  };
}

async function send(prefs: SignalPrefs, notes: Note[]) {
  for (const n of notes) {
    if (prefs.desktop) desktop(n.title, n.plain);
    if (prefs.telegram && telegramReady()) {
      try { await telegram(n.html); }
      catch (e) { console.error("  notify:", (e as Error).message); }
    }
  }
}

/** Messages and page changes go out one by one; discovered items collapse into a digest past 3. */
export async function notify(prefs: SignalPrefs, rows: SignalRow[]) {
  if (!rows.length) return;
  const direct = rows.filter((r) => ALWAYS_NOTIFY.includes(r.kind));
  const found = rows.filter((r) => !ALWAYS_NOTIFY.includes(r.kind));
  const notes = direct.slice(0, 5).map(single);
  if (direct.length > 5) notes.push({
    title: `💬 ${direct.length - 5} more messages`, plain: "Open the console to see them.",
    html: `💬 <b>${direct.length - 5} more messages</b> — check the console`,
  });
  if (found.length > 3) notes.push(digest(found));
  else notes.push(...found.map(single));
  await send(prefs, notes);
  markNotified(rows.map((r) => r.id));
}

export async function testNotify(prefs: SignalPrefs) {
  const t = new Date().toLocaleTimeString();
  await send({ ...prefs, desktop: true, telegram: true }, [{
    title: "📡 Signals test",
    plain: `Desktop notifications work (${t}).`,
    html: `📡 <b>Signals test</b>\nTelegram notifications work (${esc(t)}).`,
  }]);
}

/** After you message your bot once, this lists the chat ids it can see. */
export async function findTelegramChats(): Promise<[number, string][]> {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN in .env first.");
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  const j = (await res.json()) as { ok: boolean; description?: string; result?: any[] };
  if (!j.ok) throw new Error(`telegram: ${j.description}`);
  const chats = new Map<number, string>();
  for (const u of j.result ?? []) {
    const c = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (c) chats.set(c.id, c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "?"));
  }
  return [...chats];
}
