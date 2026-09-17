/* Gmail over IMAP with an app password (Google Account → Security → 2-Step Verification → App passwords).

   LinkedIn has no API for your messages, but it emails you about every one — so LinkedIn rides in
   here: messages, InMail, mentions and job alerts all arrive as mail from linkedin.com. */

import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { clip, guessKind, scoreText, type Kind, type SignalPrefs } from "../../src/lib/signals.ts";
import { decodeEntities, htmlToText, type Found, type Poller } from "../util.ts";

const FIRST_RUN_DAYS = 3;
const MAX_PER_RUN = 150;
const BULK_SENDER = /no-?reply|notifications?@|newsletter|mailer|digest|updates?@|news@|marketing|promo/i;

type Cursor = { uidValidity: string; lastUid: number };

/** What kind of LinkedIn mail is this? null = profile-view nags and marketing. */
function linkedinKind(from: string, subject: string): Kind | null {
  if (/messages-noreply|inmail|messaging/i.test(from)) return "message";
  if (/sent you a (new )?message|new message|inmail|replied|mentioned you|tagged you/i.test(subject)) return "message";
  if (/jobalerts|jobs-listings|jobs-noreply/i.test(from) || /\bjobs?\b|hiring|is looking for/i.test(subject)) return "job";
  if (/posted|shared a post|new post/i.test(subject)) return "post";
  return null;
}

/** The deep link LinkedIn put in the mail, minus its query string — those carry tracking and login tokens. */
function linkedinLink(html: string): string {
  const m = html.match(/href="(https:\/\/www\.linkedin\.com\/comm\/(?:messaging|jobs\/view|feed\/update|in)\/[^"]*)"/i);
  if (!m) return "";
  try {
    const u = new URL(decodeEntities(m[1]));
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

export function classify(mail: ParsedMail, prefs: SignalPrefs): Found | null {
  const sender = mail.from?.value?.[0];
  const from = (sender?.address ?? "").toLowerCase();
  if (from && from === process.env.GMAIL_USER?.toLowerCase()) return null;
  const subject = mail.subject?.trim() || "(no subject)";
  const html = typeof mail.html === "string" ? mail.html : "";
  const text = (mail.text || htmlToText(html)).trim();
  const msgId = mail.messageId?.replace(/^<|>$/g, "");
  const base = {
    external_id: mail.messageId || `${from}|${subject}|${mail.date?.toISOString()}`,
    title: subject,
    body: clip(text, 8000),
    author: sender?.name ? `${sender.name} <${from}>` : from,
    // opens this exact mail in Gmail's web UI
    url: msgId ? `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(msgId)}` : "",
    received_at: (mail.date ?? new Date()).toISOString(),
  };
  const s = scoreText(prefs, subject, text);

  if (from.endsWith("linkedin.com")) {
    const kind = linkedinKind(from, subject);
    if (!kind && s.score < prefs.threshold) return null;
    return { ...base, source: "linkedin", kind: kind ?? "post", url: linkedinLink(html) || base.url };
  }

  // mailparser folds every List-* header into one "list" key
  const bulk = mail.headers.has("list") || /bulk|list|junk/i.test(String(mail.headers.get("precedence") ?? "")) || BULK_SENDER.test(from);
  // A person writing about something you care about, or replying to you (a professor answering a cold email)
  if (!bulk && (s.score > 0 || /^re:/i.test(subject))) return { ...base, kind: "message" };
  // Bulk mail has to look like an opportunity, not merely mention a field — or every "Security alert" would ring
  if (bulk && s.matched.some((t) => prefs.boost.includes(t))) return { ...base, kind: guessKind(`${subject}\n${text}`) };
  return null;
}

export const gmailMissing = () =>
  process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD ? null : "set GMAIL_USER and GMAIL_APP_PASSWORD in .env";

export const gmail: Poller = {
  id: "gmail",
  everyMs: 2 * 60_000,
  missing: gmailMissing,
  async poll({ prefs, cursor, setCursor }) {
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      // Google displays app passwords as "abcd efgh ijkl mnop"
      auth: { user: process.env.GMAIL_USER!, pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s+/g, "") },
      logger: false,
    });
    try {
      await client.connect();
    } catch (e: any) {
      if (e?.authenticationFailed) {
        throw new Error("Gmail rejected the login — it needs an App Password (2-Step Verification on), not your account password");
      }
      throw e;
    }

    const out: Found[] = [];
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const box = client.mailbox;
        if (!box) throw new Error("INBOX did not open");
        const validity = String(box.uidValidity);
        const uidNext = box.uidNext;
        let prev: Cursor | null = null;
        try { prev = cursor ? JSON.parse(cursor) : null; } catch {}
        if (prev && prev.uidValidity !== validity) prev = null; // mailbox rebuilt — UIDs mean nothing now

        if (prev && uidNext <= prev.lastUid + 1) return out; // nothing new since last time

        let uids = prev
          // "N:*" always matches the newest message even when its UID is below N — hence the filter
          ? ((await client.search({ uid: `${prev.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > prev!.lastUid)
          : (await client.search({ since: new Date(Date.now() - FIRST_RUN_DAYS * 86400_000) }, { uid: true })) || [];
        uids = uids.sort((a, b) => a - b).slice(-MAX_PER_RUN);

        if (uids.length) {
          // the first 512 KB is plenty for headers and text; skips downloading attachments
          for await (const msg of client.fetch(uids.join(","), { uid: true, source: { maxLength: 512 * 1024 } }, { uid: true })) {
            if (!msg.source) continue;
            const found = classify(await simpleParser(msg.source), prefs);
            if (found) out.push(found);
          }
        }
        setCursor(JSON.stringify({ uidValidity: validity, lastUid: Math.max(prev?.lastUid ?? 0, uidNext - 1) }));
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    return out;
  },
};
