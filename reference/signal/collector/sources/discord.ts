/* Discord, through a bot you create. What a bot can see:
     - messages in servers it's been added to (adding it needs Manage Server — so, in practice, your own)
     - announcement channels from other servers that you "Follow" into your server
     - DMs people send to the bot itself
   What it can't see is your personal DMs. That takes a self-bot, and Discord bans accounts for it. */

import { ChannelType, Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { scoreText, updateSource, type SignalPrefs } from "../../src/lib/signals.ts";
import { firstLine, type Found } from "../util.ts";

export const discordMissing = () => (process.env.DISCORD_BOT_TOKEN ? null : "set DISCORD_BOT_TOKEN in .env");

function textOf(m: Message) {
  // followed announcements and bot posts often carry everything in embeds
  const embeds = m.embeds.map((e) =>
    [e.title, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join("\n")
  );
  return [m.content, ...embeds].filter(Boolean).join("\n\n");
}

export function startDiscord(getPrefs: () => SignalPrefs, ingest: (items: Found[]) => void): Client | null {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return null;
  const me = process.env.DISCORD_USER_ID?.trim(); // so an @mention of *you* counts as a message

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // DM channels aren't cached, so their events arrive as partials
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`  discord: signed in as ${c.user.tag}, in ${c.guilds.cache.size} server(s)`);
    updateSource("discord", {
      configured: 1, last_run_at: Date.now(), last_ok_at: Date.now(), last_error: "",
      detail: `${c.user.tag} · ${c.guilds.cache.size} server(s)`,
    });
  });

  client.on(Events.MessageCreate, (m) => {
    // not m.author.bot: followed announcements arrive through webhooks, which count as bots
    if (m.author.id === client.user?.id) return;
    const prefs = getPrefs();
    const dm = m.channel.type === ChannelType.DM;
    const mentioned = !!me && m.mentions.users.has(me);
    const listed = prefs.discordChannels.includes(m.channelId);
    if (!dm && !mentioned && prefs.discordChannels.length && !listed) return;

    const body = textOf(m);
    if (!body.trim()) return;
    // with no channel list, every channel is in scope — keep only chatter that matches something
    if (!dm && !mentioned && !listed && scoreText(prefs, body, "").score === 0) return;

    const where = dm ? "DM" : `${m.guild?.name ?? "server"} #${"name" in m.channel ? m.channel.name : "?"}`;
    ingest([{
      external_id: m.id,
      kind: dm || mentioned ? "message" : "post",
      title: dm ? `DM from ${m.author.displayName}` : `${where}: ${firstLine(body, 100)}`,
      body,
      url: m.url,
      author: `${m.author.username} · ${where}`,
      received_at: m.createdAt.toISOString(),
    }]);
  });

  client.on(Events.Error, (e) => updateSource("discord", { last_error: e.message }));

  client.login(token).catch((e: Error) => {
    console.error("  discord:", e.message);
    updateSource("discord", {
      configured: 1,
      last_run_at: Date.now(),
      last_error: /disallowed intents/i.test(e.message)
        ? "Turn on MESSAGE CONTENT INTENT: Developer Portal → your app → Bot → Privileged Gateway Intents"
        : e.message,
    });
  });

  return client;
}
