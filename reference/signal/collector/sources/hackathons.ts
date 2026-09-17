/* Hackathon listings. Each is the public listing endpoint the site's own frontend calls — no account,
   no login. Dedup is by the listing's own id, so re-seeing an event on the next poll costs nothing. */

import { clip, isoDate } from "../../src/lib/signals.ts";
import { getJson, getText, htmlToText, type Found, type Poller } from "../util.ts";

const HOURS = 3_600_000;
const names = (xs: any[] | undefined, key = "name") =>
  (xs ?? []).map((x) => (typeof x === "string" ? x : x?.[key])).filter(Boolean).join(", ");

/** "Sep 11, 2026" · "Aug 12 - Sep 30, 2026" · "Sep 12 - 30, 2026" · "Dec 15, 2026 - Jan 10, 2027" */
function devpostEnd(s: string | undefined): string | null {
  if (!s) return null;
  const parts = s.split(/\s+-\s+/);
  let end = parts[parts.length - 1].trim();
  if (/^\d{1,2}, \d{4}$/.test(end)) end = `${parts[0].trim().split(" ")[0]} ${end}`; // "30, 2026" borrows the month
  return isoDate(end);
}

export const devpost: Poller = {
  id: "devpost",
  everyMs: 3 * HOURS,
  missing: () => null,
  async poll() {
    const out: Found[] = [];
    for (let page = 1; page <= 4; page++) {
      const j = await getJson<{ hackathons?: any[] }>(
        `https://devpost.com/api/hackathons?page=${page}&status[]=upcoming&status[]=open&order_by=recently-added`
      );
      const list = j.hackathons ?? [];
      for (const h of list) {
        if (h.invite_only) continue;
        out.push({
          external_id: String(h.id),
          kind: "hackathon",
          title: h.title,
          url: h.url,
          author: h.organization_name ?? "",
          deadline: devpostEnd(h.submission_period_dates),
          body: [
            h.submission_period_dates && `Submissions: ${h.submission_period_dates}`,
            h.displayed_location?.location,
            h.prize_amount && `Prizes: ${htmlToText(h.prize_amount)}`,
            h.themes?.length && `Themes: ${names(h.themes)}`,
            h.registrations_count != null && `${h.registrations_count} registered`,
          ].filter(Boolean).join("\n"),
        });
      }
      if (list.length < 9) break; // Devpost pages are 9 long
    }
    return out;
  },
};

export const devfolio: Poller = {
  id: "devfolio",
  everyMs: 3 * HOURS,
  missing: () => null,
  async poll() {
    const j = await getJson<any>("https://api.devfolio.co/api/search/hackathons", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "application_open", from: 0, size: 50 }),
    });
    return (j.hits?.hits ?? []).map(({ _source: h }: any): Found => {
      const s = h.hackathon_setting ?? {};
      return {
        external_id: h.uuid,
        kind: "hackathon",
        title: h.name,
        url: s.subdomain ? `https://${s.subdomain}.devfolio.co/` : "https://devfolio.co/hackathons",
        deadline: isoDate(s.reg_ends_at),
        body: [
          h.tagline,
          h.is_online ? "Online" : [h.city, h.state, h.country].filter(Boolean).join(", "),
          h.starts_at && `Runs ${isoDate(h.starts_at)} → ${isoDate(h.ends_at)}`,
          h.themes?.length && `Themes: ${names(h.themes)}`,
          h.desc && clip(h.desc, 1500),
        ].filter(Boolean).join("\n"),
      };
    });
  },
};

export const unstop: Poller = {
  id: "unstop",
  everyMs: 3 * HOURS,
  missing: () => null,
  async poll() {
    const out: Found[] = [];
    for (let page = 1; page <= 2; page++) {
      const j = await getJson<any>(
        `https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&page=${page}&per_page=30&oppstatus=open`
      );
      for (const o of j.data?.data ?? []) {
        const eligible = (o.filters ?? []).filter((f: any) => f.type === "eligible");
        out.push({
          external_id: String(o.id),
          kind: "hackathon",
          title: o.title,
          url: o.seo_url ?? `https://unstop.com/${o.public_url}`,
          author: o.organisation?.name ?? "",
          deadline: isoDate(o.regnRequirements?.end_regn_dt ?? o.end_date),
          body: [
            o.region && `Mode: ${o.region}`,
            o.address_with_country_logo?.city,
            eligible.length && `Eligible: ${names(eligible)}`,
            o.required_skills?.length && `Skills: ${names(o.required_skills, "skill_name")}`,
            o.isPaid && "Paid entry",
            clip(htmlToText(o.details ?? ""), 1500),
          ].filter(Boolean).join("\n"),
        });
      }
      if (page >= (j.data?.last_page ?? 1)) break;
    }
    return out;
  },
};

export const mlh: Poller = {
  id: "mlh",
  everyMs: 12 * HOURS,
  missing: () => null,
  async poll() {
    const now = new Date();
    const season = now.getFullYear() + (now.getMonth() >= 6 ? 1 : 0); // seasons roll over in summer
    const html = await getText(`https://www.mlh.com/seasons/${season}/events`);
    // an Inertia page: the props ride along as JSON in a script tag
    const m = html.match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error("MLH page layout changed — no embedded event data");
    const events: any[] = JSON.parse(m[1]).props?.upcomingEvents ?? [];
    return events.map((e): Found => ({
      external_id: String(e.id ?? e.slug),
      kind: "hackathon",
      title: e.name,
      url: e.url ? new URL(e.url, "https://www.mlh.com").href : e.websiteUrl,
      deadline: isoDate(e.startsAt), // MLH has no separate registration close — the start is the deadline
      body: [
        e.dateRange,
        typeof e.location === "string" ? e.location : e.location?.name,
        e.formatType && `Format: ${e.formatType}`,
        e.region,
      ].filter(Boolean).join("\n"),
    }));
  },
};
