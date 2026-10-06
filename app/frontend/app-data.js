/* Signal demo console — mock data + scoring.
   One clearly-marked array (RAW_ROWS), per the editability contract in AGENTS.md.
   Rows reuse the public-source titles already approved for the landing-page filter demo
   (filter.js) — no invented product data, no gmail/linkedin rows. */
(function (global) {
  "use strict";

  /* Sources — labels verbatim from reference/signal/signals.ts. `status` is what the hosted
     app can do today (AGENTS.md → "Availability in the hosted app"):
       ready  — works with no setup
       setup  — works once you add something (a feed, a page, a bot invite)
       soon   — not available in the hosted app yet */
  var SOURCES = [
    { id: "gmail", label: "Gmail + LinkedIn mail", group: "Inbound", status: "soon", note: "Not available in the hosted app yet." },
    { id: "discord", label: "Discord bot", group: "Inbound", status: "setup", note: "Invite the Signal bot to your server to start." },
    { id: "devpost", label: "Devpost", group: "Hackathons", status: "ready", note: "Working. Nothing to set up." },
    { id: "devfolio", label: "Devfolio", group: "Hackathons", status: "ready", note: "Working. Nothing to set up." },
    { id: "unstop", label: "Unstop", group: "Hackathons", status: "ready", note: "Working. Nothing to set up." },
    { id: "mlh", label: "MLH", group: "Hackathons", status: "ready", note: "Working. Nothing to set up." },
    { id: "wikicfp", label: "WikiCFP", group: "Research", status: "ready", note: "Working. Uses the categories you pick below." },
    { id: "feeds", label: "RSS / Google Alerts", group: "Research", status: "setup", note: "Add a feed link below to start." },
    { id: "watch", label: "Page watch", group: "Research", status: "setup", note: "Add a page below to start." }
  ];

  var KINDS = ["message", "hackathon", "cfp", "job", "research", "post", "page", "other"];
  var KIND_LABELS = {
    message: "Message", hackathon: "Hackathon", cfp: "Call for papers", job: "Job",
    research: "Research", post: "Post", page: "Page change", other: "Other"
  };
  var STATUSES = ["new", "saved", "applied", "archived"];

  /* Someone wrote to you, or a page you watch changed — these notify regardless of score
     (ALWAYS_NOTIFY in signals.ts). */
  var ALWAYS_NOTIFY = ["message", "page"];

  /* Default filter profile for the demo. */
  var DEFAULT_PREFS = {
    interests: ["AI", "machine learning", "security"],
    boost: ["hackathon", "research", "internship"],
    exclude: [],
    threshold: 3,
    cfpCategories: ["security", "machine learning"],
    feeds: [],
    watch: [],
    discordChannels: [],
    telegram: true,
    disabled: []
  };

  /* Suggestions shown under the term inputs — taken from PREF_DEFAULTS in the reference
     collector, so they are terms a real student profile used. */
  var SUGGESTIONS = {
    interests: ["computer vision", "edge AI", "cybersecurity", "embedded", "IoT", "LLM agents", "AI safety"],
    boost: ["research internship", "fellowship", "stipend", "call for papers", "summer research"],
    exclude: ["unpaid", "5+ years"]
  };

  /* The match-strength choices, with their real meaning (AGENTS.md, section 3). */
  var THRESHOLDS = [
    { value: 2, name: "Relaxed", text: "Anything a boost word touches." },
    { value: 3, name: "Balanced", text: "One topic match anywhere is enough." },
    { value: 4, name: "Picky", text: "A topic has to be in the title." },
    { value: 6, name: "Very picky", text: "A topic in the title plus a boost word." }
  ];

  /* Same matching as reference/signal/signals.ts termRe: case-insensitive, letter/digit
     boundaries, optional plural. "AI" does not match "said"; "hackathon" matches "hackathons". */
  function termRe(term) {
    var escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![\\p{L}\\p{N}])" + escaped + "(?:s|es|'s)?(?![\\p{L}\\p{N}])", "iu");
  }

  /* ===== BIG TECH — edit this array to change what the inbox's "Big tech hackathons" filter matches =====
     A filter only: it never changes a score, the order, or what notifies you. Rows carry no
     organiser field, so this looks for the company's name in the title and description. Names
     are matched with their capitals ("Apple", not "apple"; "Meta", not "meta-learning"). */
  var BIG_TECH = ["Google", "Meta", "Facebook", "Amazon", "AWS", "Apple", "Netflix", "Microsoft"];
  var BIG_TECH_RES = BIG_TECH.map(function (name) {
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![\\p{L}\\p{N}-])" + escaped + "(?:'s)?(?![\\p{L}\\p{N}-])", "u");
  });
  function isBigTechHackathon(item) {
    if (!item || item.kind !== "hackathon") return false;
    var text = (item.title || "") + "\n" + (item.body || "");
    return BIG_TECH_RES.some(function (re) { return re.test(text); });
  }

  /* Score one item against a profile. Mirrors scoreText() in signals.ts:
       interest term in the title → +4, in the body only → +3 (not both)
       boost term anywhere        → +2
       exclude term anywhere      → excluded
     Also returns `breakdown`, the per-term reasons shown in the signal overlay. */
  function scoreItem(item, prefs) {
    var title = item.title || "";
    var body = item.body || "";
    var breakdown = [];
    var total = 0;

    (prefs.interests || []).forEach(function (term) {
      var re = termRe(term);
      if (re.test(title)) { total += 4; breakdown.push({ term: term, list: "topic", where: "title", points: 4 }); }
      else if (re.test(body)) { total += 3; breakdown.push({ term: term, list: "topic", where: "description", points: 3 }); }
    });

    (prefs.boost || []).forEach(function (term) {
      var re = termRe(term);
      if (re.test(title) || re.test(body)) {
        total += 2;
        breakdown.push({ term: term, list: "boost", where: re.test(title) ? "title" : "description", points: 2 });
      }
    });

    var excludedBy = (prefs.exclude || []).filter(function (term) {
      var re = termRe(term);
      return re.test(title) || re.test(body);
    });

    return {
      score: total,
      matched: breakdown.map(function (b) { return b.term; }),
      breakdown: breakdown,
      excluded: excludedBy.length > 0,
      excludedBy: excludedBy
    };
  }

  /* Received-at timestamps are relative to "now" so the demo always reads as recent. */
  var HOUR = 3600 * 1000;
  var now = Date.now();

  /* ===== DEMO DATA — edit this array to change the console's sample signals ===== */
  var RAW_ROWS = [
    { id: "unstop-1", source: "unstop", kind: "hackathon", title: "Hack Devengers 2.0", body: "AI machine learning hackathon for student teams.", deadline: "2026-09-18", receivedHoursAgo: 2, status: "new", note: "" },
    { id: "unstop-2", source: "unstop", kind: "hackathon", title: "PARANOVA", body: "A general student hackathon, open track.", deadline: "2026-09-14", receivedHoursAgo: 5, status: "new", note: "" },
    { id: "mlh-1", source: "mlh", kind: "hackathon", title: "Diamondhacks", body: "AI hackathon hosted by a university MLH chapter.", deadline: "2027-04-04", receivedHoursAgo: 9, status: "saved", note: "Team needs one more design person." },
    { id: "mlh-2", source: "mlh", kind: "hackathon", title: "MakeCU", body: "Build and research hackathon with an open track.", deadline: "2026-11-07", receivedHoursAgo: 14, status: "new", note: "" },
    { id: "mlh-3", source: "mlh", kind: "hackathon", title: "HackNex Season 2", body: "Security-focused hackathon with a CTF side track.", deadline: "2026-09-25", receivedHoursAgo: 20, status: "applied", note: "Submitted 15 Sept, waiting to hear back." },
    { id: "devpost-1", source: "devpost", kind: "hackathon", title: "RoadStar Hackathon", body: "AI hackathon focused on transportation.", deadline: "2026-09-13", receivedHoursAgo: 26, status: "new", note: "" },
    { id: "wikicfp-1", source: "wikicfp", kind: "cfp", title: "ICDS 2026 : 3rd International Conference on Digital Sovereignty", body: "Security and policy research call for papers.", deadline: "2026-08-31", receivedHoursAgo: 33, status: "archived", note: "" },
    { id: "wikicfp-2", source: "wikicfp", kind: "cfp", title: "ICAIIT 2027 : International Conference on Applied Innovations in IT", body: "AI research conference, applied track.", deadline: "2027-01-10", receivedHoursAgo: 40, status: "saved", note: "Abstract due before the deadline above." },
    { id: "wikicfp-3", source: "wikicfp", kind: "cfp", title: "9th AccML 2027 : Workshop on Accelerated Machine Learning", body: "Machine learning systems research workshop.", deadline: null, receivedHoursAgo: 48, status: "applied", note: "Poster submitted." },
    { id: "wikicfp-4", source: "wikicfp", kind: "cfp", title: "PCS 2027 : Picture Coding Symposium", body: "Computer vision and picture coding research.", deadline: null, receivedHoursAgo: 55, status: "new", note: "" }
  ].map(function (row) {
    return {
      id: row.id,
      source: row.source,
      kind: row.kind,
      title: row.title,
      body: row.body,
      url: "",
      deadline: row.deadline,
      status: row.status,
      note: row.note,
      received_at: now - row.receivedHoursAgo * HOUR
    };
  });

  global.SignalData = {
    SOURCES: SOURCES,
    KINDS: KINDS,
    KIND_LABELS: KIND_LABELS,
    STATUSES: STATUSES,
    ALWAYS_NOTIFY: ALWAYS_NOTIFY,
    DEFAULT_PREFS: DEFAULT_PREFS,
    SUGGESTIONS: SUGGESTIONS,
    THRESHOLDS: THRESHOLDS,
    RAW_ROWS: RAW_ROWS,
    /* What an empty inbox starts from: the sample rows on the website demo, nothing in the app
       (desktop, Android), where every signal must come from a real check. */
    START_ROWS: global.__TAURI__ ? [] : RAW_ROWS,
    scoreItem: scoreItem,
    BIG_TECH: BIG_TECH,
    isBigTechHackathon: isBigTechHackathon
  };
})(window);
