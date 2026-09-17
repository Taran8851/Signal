/* The collector: polls every source on its own schedule, stores what's new, scores it against your
   preferences, and pushes what matters to Telegram and the desktop. Runs beside the site and shares
   its SQLite file — start it from the project root.

     npm run signals                        run forever
     npm run signals -- --once              poll every source once, then exit (Discord skipped)
     npm run signals -- --test-notify       send a test notification to every channel
     npm run signals -- --telegram-chats    list chat ids your bot has seen, for TELEGRAM_CHAT_ID  */

import "./env.ts"; // must stay first — see env.ts
import {
  ALWAYS_NOTIFY, getPrefs, insertSignal, scoreText, sourceState, updateSource, type SignalRow,
} from "../src/lib/signals.ts";
import { findTelegramChats, notify, telegramReady, testNotify } from "./notify.ts";
import type { Found, Poller } from "./util.ts";
import { gmail } from "./sources/gmail.ts";
import { discordMissing, startDiscord } from "./sources/discord.ts";
import { devfolio, devpost, mlh, unstop } from "./sources/hackathons.ts";
import { feeds, watch, wikicfp } from "./sources/research.ts";

const POLLERS: Poller[] = [gmail, devpost, devfolio, unstop, mlh, wikicfp, feeds, watch];
const RETRY_MS = 15 * 60_000; // a failing source retries sooner than its normal interval
const args = new Set(process.argv.slice(2));

/** Store and score; returns [newly stored, of which worth a notification]. */
function ingest(source: string, items: Found[], quiet: boolean): [number, SignalRow[]] {
  const prefs = getPrefs();
  let stored = 0;
  const ring: SignalRow[] = [];
  for (const it of items) {
    const s = scoreText(prefs, it.title, it.body ?? "");
    const row = insertSignal({ ...it, source: it.source ?? source }, s);
    if (!row) continue;
    stored++;
    if (quiet || it.quiet || s.excluded) continue;
    if (ALWAYS_NOTIFY.includes(row.kind) || row.score >= prefs.threshold) ring.push(row);
  }
  return [stored, ring];
}

async function runPoller(p: Poller) {
  const prefs = getPrefs();
  const missing = p.missing();
  if (missing || prefs.disabled.includes(p.id)) {
    updateSource(p.id, { configured: missing ? 0 : 1, detail: missing ?? "switched off in preferences" });
    return;
  }
  const state = sourceState(p.id);
  const started = Date.now();
  const warnings: string[] = [];
  let cursor = state.cursor;
  try {
    const items = await p.poll({ prefs, cursor, setCursor: (v) => { cursor = v; }, warn: (m) => warnings.push(m) });
    const quiet = !state.last_ok_at; // the first successful run is a backfill — store it, don't ring
    const [stored, ring] = ingest(p.id, items, quiet);
    updateSource(p.id, {
      configured: 1, cursor, last_run_at: started, last_ok_at: Date.now(),
      last_error: warnings.join(" · ").slice(0, 500),
      detail: `${items.length} seen · ${stored} new${quiet ? " · first run, stored without alerts" : ` · ${ring.length} notified`}`,
    });
    console.log(`  ${p.id.padEnd(8)} ${items.length} seen, ${stored} new, ${ring.length} to notify${warnings.length ? ` (${warnings.length} warning)` : ""}`);
    await notify(prefs, ring);
  } catch (e) {
    const msg = (e as Error).message;
    updateSource(p.id, { configured: 1, last_run_at: started, last_error: msg.slice(0, 500) });
    console.error(`  ${p.id.padEnd(8)} failed: ${msg}`);
  }
}

const running = new Set<string>();

function tick() {
  for (const p of POLLERS) {
    if (running.has(p.id)) continue;
    const s = sourceState(p.id);
    const failing = !!s.last_run_at && (!s.last_ok_at || s.last_ok_at < s.last_run_at);
    const wait = failing ? Math.min(p.everyMs, RETRY_MS) : p.everyMs;
    if (s.last_run_at && Date.now() - s.last_run_at < wait) continue;
    running.add(p.id);
    runPoller(p).finally(() => running.delete(p.id));
  }
}

async function main() {
  if (args.has("--telegram-chats")) {
    const chats = await findTelegramChats();
    if (!chats.length) console.log("\n  No chats yet. Send your bot any message in Telegram, then run this again.\n");
    for (const [id, name] of chats) console.log(`  TELEGRAM_CHAT_ID=${id}    (${name})`);
    return;
  }
  if (args.has("--test-notify")) {
    await testNotify(getPrefs());
    console.log(`  sent — desktop via notify-send${telegramReady() ? ", Telegram" : " (Telegram not configured)"}`);
    return;
  }

  const prefs = getPrefs();
  console.log("\n  signal collector");
  for (const p of POLLERS) {
    const missing = p.missing();
    console.log(`  ${prefs.disabled.includes(p.id) ? "○" : missing ? "·" : "●"} ${p.id.padEnd(8)} ${missing ?? (prefs.disabled.includes(p.id) ? "off" : `every ${Math.round(p.everyMs / 60_000)} min`)}`);
  }
  console.log(`  ${discordMissing() ? "·" : "●"} discord  ${discordMissing() ?? "live"}`);
  if (!telegramReady()) console.log("  (Telegram not configured — desktop notifications only)");
  console.log("");

  if (args.has("--once")) {
    await Promise.all(POLLERS.map(runPoller));
    return;
  }

  const bot = startDiscord(getPrefs, (items) => {
    if (getPrefs().disabled.includes("discord")) return;
    const [, ring] = ingest("discord", items, false);
    notify(getPrefs(), ring).catch((e) => console.error("  notify:", e.message));
  });
  if (!bot) updateSource("discord", { configured: 0, detail: discordMissing() ?? "" });

  tick();
  setInterval(tick, 20_000);

  const stop = () => { bot?.destroy(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
