/* Signal demo console — sources the user adds themselves.
   Loaded after app-data.js and before app.js. Depends only on window.SignalData
   (and, optionally, window.SignalAI for "Map fields with AI").

   AGENTS.md → "Sources are open": a custom source is an RSS/Atom feed, a JSON API with a
   field mapping, a web page to watch, or a social feed exposed as a feed URL. It is always
   labelled with the user's own name for it and never presented as built-in.

   Contents
   1. Store (signal_demo_sources, signal_demo_rows)
   2. Types, presets, helpers (slug, hash, URL check)
   3. Parsing: kind guess, deadlines, dot paths, RSS/Atom, JSON, web pages
   4. Field detection (heuristic and AI)
   5. Fetch preview and import
   6. Public API: window.SignalSources */
(function (global) {
  "use strict";

  /* =====================================================================
     1. Store
  ===================================================================== */
  var KEYS = { sources: "signal_demo_sources", rows: "signal_demo_rows" };
  var MAX_ITEMS = 50;

  function read(key, fallback) {
    try {
      var v = JSON.parse(global.localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function readDefs() { var d = read(KEYS.sources, []); return Array.isArray(d) ? d : []; }
  function writeDefs(defs) { write(KEYS.sources, defs); emit(); }

  // Same fallback as app.js getRows(): an empty store starts from the demo rows.
  function readRows() {
    var rows = read(KEYS.rows, null);
    if (!Array.isArray(rows)) rows = global.SignalData ? clone(global.SignalData.RAW_ROWS) : [];
    return rows;
  }
  function writeRows(rows) { write(KEYS.rows, rows); }

  function emit() {
    try { global.dispatchEvent(new CustomEvent("signal:sources")); } catch (e) {}
  }

  /* =====================================================================
     2. Types, presets, helpers
  ===================================================================== */
  var TYPES = [
    { id: "rss", name: "RSS / Atom feed", short: "Feed", help: "A feed link. Signal reads each new entry as one opportunity." },
    { id: "json", name: "JSON API", short: "JSON", help: "An API that returns JSON. You tell Signal which fields hold the title, link and deadline." },
    { id: "page", name: "Web page to watch", short: "Page", help: "A page with no feed. Signal tells you when its text changes." },
    { id: "social", name: "Social feed via a feed URL", short: "Social", help: "A feed URL for an account, such as an X account through an RSS bridge. Signal reads the feed, it does not scrape X." }
  ];
  function typeInfo(id) { return TYPES.filter(function (t) { return t.id === id; })[0] || TYPES[0]; }

  var EMPTY_MAPPING = { items: "", title: "", body: "", url: "", id: "", deadline: "" };

  /* Offline examples for the demo. Every item is titled "Sample:" and links to example.org,
     so none of them can be mistaken for a real listing. */
  var PRESETS = [
    {
      id: "sample-rss",
      label: "Sample hackathon feed (RSS)",
      help: "An RSS feed with four sample entries.",
      def: {
        name: "Sample hackathon feed",
        type: "rss",
        mode: "paste",
        url: "",
        sample:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<rss version="2.0"><channel>\n' +
          "  <title>Sample hackathon feed</title>\n" +
          "  <link>https://example.org/</link>\n" +
          "  <description>Sample data for the Signal demo. Not real listings.</description>\n" +
          "  <item>\n" +
          "    <title>Sample: Campus AI hackathon for first-year students</title>\n" +
          "    <link>https://example.org/samples/ai-hackathon</link>\n" +
          "    <guid>sample-rss-1</guid>\n" +
          "    <description>A sample weekend hackathon on machine learning tools. Beginners welcome. Registration deadline: 2026-10-20.</description>\n" +
          "  </item>\n" +
          "  <item>\n" +
          "    <title>Sample: Open-source summer programme</title>\n" +
          "    <link>https://example.org/samples/open-source-summer</link>\n" +
          "    <guid>sample-rss-2</guid>\n" +
          "    <description>A sample mentored programme for contributing to open-source projects, with a stipend. Apply by 15 November 2026.</description>\n" +
          "  </item>\n" +
          "  <item>\n" +
          "    <title>Sample: Security CTF weekend</title>\n" +
          "    <link>https://example.org/samples/ctf-weekend</link>\n" +
          "    <guid>sample-rss-3</guid>\n" +
          "    <description>A sample capture-the-flag event for student teams interested in security.</description>\n" +
          "  </item>\n" +
          "  <item>\n" +
          "    <title>Sample: Design sprint meetup</title>\n" +
          "    <link>https://example.org/samples/design-meetup</link>\n" +
          "    <guid>sample-rss-4</guid>\n" +
          "    <description>A sample evening meetup about product design.</description>\n" +
          "  </item>\n" +
          "</channel></rss>\n"
      }
    },
    {
      id: "sample-json",
      label: "Sample JSON API",
      help: "A JSON response with three sample items and a field mapping to detect.",
      def: {
        name: "Sample research API",
        type: "json",
        mode: "paste",
        url: "",
        mapping: clone(EMPTY_MAPPING),
        sample: JSON.stringify({
          note: "Sample data for the Signal demo. Not real listings.",
          data: {
            results: [
              { uid: "sample-json-1", name: "Sample: Undergraduate research fellowship in AI safety", summary: "A sample paid summer research fellowship. Mentored project, remote.", link: "https://example.org/samples/research-fellowship", closes_on: "2026-11-30" },
              { uid: "sample-json-2", name: "Sample: Call for papers, student workshop on machine learning systems", summary: "A sample call for papers for a student workshop. Short papers welcome.", link: "https://example.org/samples/cfp-workshop", closes_on: "2026-12-12" },
              { uid: "sample-json-3", name: "Sample: Robotics club open day", summary: "A sample open day for a student robotics club.", link: "https://example.org/samples/robotics-open-day", closes_on: null }
            ]
          }
        }, null, 2)
      }
    }
  ];

  function slugify(name) {
    var s = String(name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return s || "source";
  }

  function hash(str) {
    var h = 5381;
    str = String(str);
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /* http(s) only, with a real-looking host. Returns the URL object or null. */
  function validUrl(value) {
    var v = String(value || "").trim();
    if (!/^https?:\/\//i.test(v)) return null;
    try {
      var u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (!u.hostname || (u.hostname.indexOf(".") === -1 && u.hostname !== "localhost")) return null;
      return u;
    } catch (e) { return null; }
  }
  function hostOf(url) { var u = validUrl(url); return u ? u.hostname.replace(/^www\./, "") : ""; }

  function cleanText(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return max && t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : t;
  }

  /* =====================================================================
     3. Parsing
  ===================================================================== */

  /* Same idea as the reference collector's guessKind: the first rule that matches wins. */
  var KIND_RULES = [
    ["cfp", /\b(call for papers|cfp|call for (?:submissions|abstracts|proposals)|workshop paper|submission deadline|conference)\b/i],
    ["hackathon", /\b(hackathons?|hack ?days?|hack ?week|ctf|capture[- ]the[- ]flag|buildathon|game ?jam|codefest)\b/i],
    ["research", /\b(research|fellowships?|phd|lab position|scholarships?|residency|summer school|grants?)\b/i],
    ["job", /\b(internships?|intern|jobs?|hiring|graduate role|apprenticeship|position|vacanc(?:y|ies))\b/i]
  ];
  function guessKind(title, body) {
    var text = (title || "") + " " + (body || "");
    for (var i = 0; i < KIND_RULES.length; i++) if (KIND_RULES[i][1].test(text)) return KIND_RULES[i][0];
    return "other";
  }

  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null; // 31 February and friends
    return y + "-" + pad(m) + "-" + pad(d);
  }
  function monthIndex(word) { return MONTHS.indexOf(String(word).slice(0, 3).toLowerCase()) + 1; }

  /* A date value from a deadline field: ISO, "15 November 2026", "November 15, 2026",
     or a Unix timestamp. Anything else → null. Never guesses a year. */
  function parseDateValue(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && isFinite(value)) {
      var ms = value < 1e11 ? value * 1000 : value;
      var dn = new Date(ms);
      return isNaN(dn) ? null : ymd(dn.getUTCFullYear(), dn.getUTCMonth() + 1, dn.getUTCDate());
    }
    var s = String(value).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
    if (m) return ymd(m[1], m[2], m[3]);
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (m && monthIndex(m[2])) return ymd(m[3], monthIndex(m[2]), m[1]);
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (m && monthIndex(m[1])) return ymd(m[3], monthIndex(m[1]), m[2]);
    if (/^\d{10,13}$/.test(s)) return parseDateValue(Number(s));
    return null;
  }

  /* A deadline mentioned in text. Only dates right after a deadline phrase count, so a
     publish date or an event date is never taken for a deadline. */
  var DEADLINE_PHRASE = "(?:deadline|due(?: date| by| on)?|apply by|applications? (?:close|due)s?(?: on)?|closes?(?: on)?|register by|registration (?:closes|deadline)|submissions? (?:close|due)s?(?: on)?|submit by|until)";
  var DATE_FORMS = "(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})";
  var DEADLINE_RE = new RegExp(DEADLINE_PHRASE + "\\s*[:\\-–]?\\s*(?:is\\s+|on\\s+)?" + DATE_FORMS, "i");
  function deadlineFromText(text) {
    var m = String(text || "").match(DEADLINE_RE);
    return m ? parseDateValue(m[1]) : null;
  }

  /* Dot paths: "data.items", "title", "authors.0.name". "" or "." means the value itself. */
  function getPath(obj, path) {
    if (path == null) return undefined;
    var p = String(path).trim();
    if (p === "" || p === ".") return obj;
    var parts = p.replace(/\[(\d+)\]/g, ".$1").split(".");
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  var PATH_RE = /^(?:[A-Za-z0-9_$@-]+(?:\[\d+\])?)(?:\.[A-Za-z0-9_$@-]+(?:\[\d+\])?)*$/;
  function validPath(p) { return p === "" || PATH_RE.test(p); }

  function asText(v) {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(", ");
    if (typeof v === "object") return asText(v.text || v.value || v.name || v.title || v.href || "");
    return "";
  }

  function stripHtml(html) {
    var s = String(html || "");
    if (global.DOMParser && /<[a-z!\/]/i.test(s)) {
      try {
        var doc = new global.DOMParser().parseFromString(s, "text/html");
        return cleanText(doc.body ? doc.body.textContent : s);
      } catch (e) {}
    }
    return cleanText(s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }

  /* One normalised preview item. `deadline` stays null unless the source says so. */
  function makeItem(o, fallbackKind) {
    var title = cleanText(o.title, 200);
    var body = cleanText(o.body, 600);
    var url = validUrl(o.url) ? String(o.url).trim() : "";
    var deadline = parseDateValue(o.deadline) || deadlineFromText(title + " " + body);
    var external = cleanText(o.external_id, 300) || url || (title ? "t:" + hash(title + "|" + body) : "");
    return {
      title: title,
      body: body,
      url: url,
      deadline: deadline,
      kind: fallbackKind || guessKind(title, body),
      external_id: external
    };
  }

  function parseError(message) { var e = new Error(message); e.signalParse = true; return e; }

  /* RSS 2.0, RSS 1.0 (RDF) and Atom. Needs DOMParser (browsers). */
  function parseFeed(text) {
    if (!global.DOMParser) throw parseError("This browser can't read feeds.");
    var doc = new global.DOMParser().parseFromString(String(text || "").trim(), "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw parseError("That isn't valid RSS or Atom. Check that you pasted the whole feed.");
    var nodes = Array.prototype.slice.call(doc.getElementsByTagName("item"));
    var atom = false;
    if (!nodes.length) { nodes = Array.prototype.slice.call(doc.getElementsByTagName("entry")); atom = true; }
    var root = doc.documentElement ? doc.documentElement.localName : "";
    if (!nodes.length && ["rss", "feed", "RDF"].indexOf(root) === -1) throw parseError("That isn't an RSS or Atom feed.");

    function child(node, names) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 1 && names.indexOf(c.localName) !== -1) return c;
      }
      return null;
    }
    function childText(node, names) { var c = child(node, names); return c ? c.textContent : ""; }

    return nodes.slice(0, MAX_ITEMS).map(function (n) {
      var link = "";
      if (atom) {
        var links = Array.prototype.slice.call(n.childNodes).filter(function (c) { return c.nodeType === 1 && c.localName === "link"; });
        var alt = links.filter(function (l) { return !l.getAttribute("rel") || l.getAttribute("rel") === "alternate"; })[0] || links[0];
        link = alt ? (alt.getAttribute("href") || alt.textContent) : "";
      } else {
        link = childText(n, ["link"]) || (child(n, ["link"]) && child(n, ["link"]).getAttribute("href")) || "";
      }
      var body = childText(n, ["description", "summary", "encoded", "content"]);
      return makeItem({
        title: stripHtml(childText(n, ["title"])),
        body: stripHtml(body),
        url: cleanText(link),
        external_id: childText(n, ["guid", "id"]) || cleanText(link),
        deadline: null // pubDate/updated are publish dates, never deadlines
      });
    });
  }

  function parseJsonText(text) {
    try { return JSON.parse(String(text || "").trim()); }
    catch (e) { throw parseError("That isn't valid JSON. Check that you pasted the whole response."); }
  }

  function parseJson(text, mapping) {
    var data = typeof text === "string" ? parseJsonText(text) : text;
    mapping = Object.assign(clone(EMPTY_MAPPING), mapping || {});
    Object.keys(EMPTY_MAPPING).forEach(function (k) {
      mapping[k] = String(mapping[k] || "").trim();
      if (!validPath(mapping[k])) throw parseError("“" + mapping[k] + "” isn't a field path. Use dots, like data.items.");
    });
    var list = getPath(data, mapping.items);
    if (!Array.isArray(list)) throw parseError(mapping.items ? "Nothing at “" + mapping.items + "” is a list. Try Detect fields." : "The response isn't a list. Set where the items are, or try Detect fields.");
    if (!mapping.title) throw parseError("Choose the field that holds each item's title.");
    var items = list.slice(0, MAX_ITEMS).filter(function (o) { return o && typeof o === "object"; }).map(function (o) {
      return makeItem({
        title: stripHtml(asText(getPath(o, mapping.title))),
        body: mapping.body ? stripHtml(asText(getPath(o, mapping.body))) : "",
        url: mapping.url ? asText(getPath(o, mapping.url)) : "",
        external_id: mapping.id ? asText(getPath(o, mapping.id)) : "",
        deadline: mapping.deadline ? getPath(o, mapping.deadline) : null
      });
    });
    var titled = items.filter(function (i) { return i.title; });
    if (list.length && !titled.length) throw parseError("No item has text at “" + mapping.title + "”. Check the title field.");
    return titled;
  }

  /* A watched page: one item describing its current text. */
  function parsePage(html, url) {
    var s = String(html || "");
    var title = "", desc = "", text = "";
    if (global.DOMParser) {
      var doc = new global.DOMParser().parseFromString(s, "text/html");
      Array.prototype.forEach.call(doc.querySelectorAll("script, style, noscript, template, svg, nav, header, footer, iframe"), function (el) { el.remove(); });
      title = cleanText(doc.title) || cleanText((doc.querySelector("h1") || {}).textContent);
      var meta = doc.querySelector('meta[name="description"], meta[property="og:description"]');
      desc = meta ? cleanText(meta.getAttribute("content")) : "";
      var main = doc.querySelector("main, article, [role=main]") || doc.body;
      text = main ? cleanText(main.textContent) : "";
    } else {
      var t = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = t ? stripHtml(t[1]) : "";
      text = stripHtml(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " "));
    }
    if (!text && !title) throw parseError("That page has no readable text.");
    var host = hostOf(url);
    var label = title || host || "Watched page";
    return [makeItem({
      title: "Page changed: " + label,
      body: cleanText(desc ? desc + " " + text : text, 600),
      url: url || "",
      external_id: "page:" + hash(text || title),
      deadline: null
    }, "page")];
  }

  function parse(def, text) {
    var type = def.type;
    if (type === "json") return parseJson(text, def.mapping);
    if (type === "page") return parsePage(text, def.url);
    return parseFeed(text); // rss and social
  }

  /* =====================================================================
     4. Field detection
  ===================================================================== */
  var FIELD_NAMES = {
    title: ["title", "name", "headline", "subject", "label", "text"],
    body: ["description", "summary", "body", "content", "excerpt", "details", "abstract", "snippet", "text"],
    url: ["url", "link", "href", "permalink", "html_url", "web_url", "website", "apply_url"],
    id: ["id", "uid", "uuid", "guid", "slug", "key", "_id"],
    deadline: ["deadline", "closes_on", "close_date", "closing_date", "due", "due_date", "ends_at", "end_date", "apply_by", "application_deadline", "submission_deadline", "expires_at"]
  };

  /* Largest array of objects anywhere in the first four levels. */
  function findItemsPath(data) {
    var best = null;
    function walk(v, path, depth) {
      if (depth > 4 || v == null || typeof v !== "object") return;
      if (Array.isArray(v)) {
        var objs = v.filter(function (x) { return x && typeof x === "object" && !Array.isArray(x); }).length;
        if (objs && (!best || objs > best.count)) best = { path: path, count: objs };
        return;
      }
      Object.keys(v).forEach(function (k) { if (PATH_RE.test(k)) walk(v[k], path ? path + "." + k : k, depth + 1); });
    }
    walk(data, "", 0);
    return best;
  }

  function flatKeys(obj, prefix, depth, out) {
    out = out || [];
    if (depth > 2 || !obj || typeof obj !== "object" || Array.isArray(obj)) return out;
    Object.keys(obj).forEach(function (k) {
      if (!PATH_RE.test(k)) return;
      var p = prefix ? prefix + "." + k : k;
      var v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) flatKeys(v, p, depth + 1, out);
      else out.push({ path: p, key: k.toLowerCase(), value: v });
    });
    return out;
  }

  /* Propose a mapping from the JSON. Returns { mapping, found, count }. */
  function detectMapping(text) {
    var data = typeof text === "string" ? parseJsonText(text) : text;
    var itemsAt = findItemsPath(data);
    if (!itemsAt) throw parseError("No list of items found in that JSON.");
    var list = getPath(data, itemsAt.path);
    var first = list.filter(function (x) { return x && typeof x === "object"; })[0];
    var keys = flatKeys(first, "", 0);
    var mapping = clone(EMPTY_MAPPING);
    mapping.items = itemsAt.path;
    var used = {};
    ["title", "url", "deadline", "id", "body"].forEach(function (field) {
      var names = FIELD_NAMES[field];
      var pick = null;
      for (var i = 0; i < names.length && !pick; i++) {
        pick = keys.filter(function (k) {
          if (used[k.path]) return false;
          var fits = k.key === names[i] || (field !== "id" && k.key.indexOf(names[i]) !== -1);
          if (!fits) return false;
          if (field === "url") return typeof k.value === "string" && /^https?:\/\//i.test(k.value);
          if (field === "deadline") return parseDateValue(k.value) !== null || k.value == null;
          if (field === "title" || field === "body") return typeof k.value === "string";
          return typeof k.value === "string" || typeof k.value === "number";
        })[0] || null;
      }
      if (pick) { mapping[field] = pick.path; used[pick.path] = true; }
    });
    // A title is required: fall back to the first plain string field
    if (!mapping.title) {
      var str = keys.filter(function (k) { return !used[k.path] && typeof k.value === "string" && !/^https?:/i.test(k.value); })[0];
      if (str) mapping.title = str.path;
    }
    var found = Object.keys(mapping).filter(function (k) { return k !== "items" && mapping[k]; });
    return { mapping: mapping, found: found, count: list.length };
  }

  function hasAI() {
    var AI = global.SignalAI;
    return !!(AI && typeof AI.hasKey === "function" && AI.hasKey() && AI._test && typeof AI._test.callModel === "function");
  }

  var AI_SYSTEM =
    "You map a JSON API response to the fields of an opportunity listing. " +
    "Reply with one JSON object and nothing else: " +
    '{"items": "...", "title": "...", "body": "...", "url": "...", "id": "...", "deadline": "..."}. ' +
    "Each value is a dot path using only keys that exist in the sample. " +
    "\"items\" is the path from the root to the array of items (\"\" if the root is the array). " +
    "The other paths are relative to one item. Use \"\" when no field fits. " +
    "Only use a deadline field if it is clearly a closing or due date, not a publish or event date.";

  /* Shrink a sample so the prompt stays small: long arrays keep two elements, long strings are cut. */
  function trimSample(v, depth) {
    depth = depth || 0;
    if (typeof v === "string") return v.length > 160 ? v.slice(0, 160) + "…" : v;
    if (Array.isArray(v)) return v.slice(0, 2).map(function (x) { return trimSample(x, depth + 1); });
    if (v && typeof v === "object") {
      if (depth > 6) return {};
      var o = {};
      Object.keys(v).slice(0, 40).forEach(function (k) { o[k] = trimSample(v[k], depth + 1); });
      return o;
    }
    return v;
  }

  /* Strict check of a proposed mapping against the data. Returns { mapping, dropped }. */
  function validateMapping(proposal, data) {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw parseError("The model's reply wasn't a field mapping.");
    var mapping = clone(EMPTY_MAPPING);
    var dropped = [];
    Object.keys(EMPTY_MAPPING).forEach(function (k) {
      var v = proposal[k];
      if (v == null) v = "";
      if (typeof v !== "string" || v.length > 120 || !validPath(v.trim())) { if (v) dropped.push(k); return; }
      mapping[k] = v.trim();
    });
    var list = getPath(data, mapping.items);
    if (!Array.isArray(list) || !list.length) throw parseError("The model pointed at a list that isn't in the response.");
    var first = list.filter(function (x) { return x && typeof x === "object"; })[0];
    if (!first) throw parseError("The list the model chose has no items.");
    ["title", "body", "url", "id", "deadline"].forEach(function (k) {
      if (!mapping[k]) return;
      var val = getPath(first, mapping[k]);
      var ok = val !== undefined;
      if (ok && k === "title") ok = typeof val === "string" && val.trim() !== "";
      if (ok && k === "url") ok = typeof val === "string" && /^https?:\/\//i.test(val);
      if (ok && k === "deadline") ok = val === null || parseDateValue(val) !== null;
      if (!ok) { dropped.push(k); mapping[k] = ""; }
    });
    if (!mapping.title) throw parseError("The model didn't find a title field that exists in the response.");
    return { mapping: mapping, dropped: dropped };
  }

  function mapWithAI(text) {
    if (!hasAI()) return Promise.reject(parseError("Add a model key under AI scoring first."));
    var data;
    try { data = parseJsonText(text); } catch (e) { return Promise.reject(e); }
    var AI = global.SignalAI;
    var user = "<sample>\n" + JSON.stringify(trimSample(data), null, 1).slice(0, 6000) + "\n</sample>";
    return AI._test.callModel(AI_SYSTEM, user, 400).then(function (r) {
      var proposal = typeof AI._test.extractJSON === "function" ? AI._test.extractJSON(r.text) : JSON.parse(r.text);
      var out = validateMapping(proposal, data);
      out.model = r.model;
      return out;
    });
  }

  /* =====================================================================
     5. Fetch preview and import
  ===================================================================== */
  var CORS_MESSAGE = "Your browser can't read this site directly. The hosted app fetches sources on the server. For this demo, paste a sample instead.";

  function fetchPreview(def) {
    def = def || {};
    return new Promise(function (resolve) {
      function done(items) { resolve({ ok: true, items: items, error: "", corsBlocked: false }); }
      function fail(message, cors) { resolve({ ok: false, items: [], error: message, corsBlocked: !!cors }); }

      if (def.mode === "paste") {
        if (!String(def.sample || "").trim()) return fail("Paste a sample first.");
        try { return done(parse(def, def.sample)); } catch (e) { return fail(e.signalParse ? e.message : "That sample couldn't be read."); }
      }
      if (!validUrl(def.url)) return fail("Enter a link that starts with http:// or https://.");
      if (typeof global.fetch !== "function") return fail(CORS_MESSAGE, true);

      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
      global.fetch(String(def.url).trim(), { signal: ctrl ? ctrl.signal : undefined, credentials: "omit", redirect: "follow" })
        .then(function (res) {
          clearTimeout(timer);
          if (!res.ok) throw parseError("The site answered with an error (HTTP " + res.status + ").");
          return res.text();
        })
        .then(function (text) {
          if (text.length > 3 * 1024 * 1024) throw parseError("That response is too large to preview.");
          done(parse(def, text));
        })
        .catch(function (e) {
          clearTimeout(timer);
          if (e && e.signalParse) return fail(e.message);
          if (e && e.name === "AbortError") return fail("The site took too long to answer.");
          // fetch() rejects with a TypeError for CORS and network failures alike
          fail(CORS_MESSAGE, true);
        });
    });
  }

  function countRows(sourceId, rows) {
    return (rows || readRows()).filter(function (r) { return r.source === sourceId; }).length;
  }

  function importItems(sourceId, items) {
    var rows = readRows();
    var have = {};
    rows.forEach(function (r) { if (r.source === sourceId && r.external_id) have[r.external_id] = true; });
    var slug = String(sourceId).replace(/^custom:/, "");
    var now = Date.now();
    var added = 0, duplicates = 0;
    (items || []).forEach(function (it, i) {
      if (!it || !cleanText(it.title)) return;
      var ext = cleanText(it.external_id) || "t:" + hash(cleanText(it.title) + "|" + cleanText(it.body));
      if (have[ext]) { duplicates++; return; }
      have[ext] = true;
      rows.unshift({
        id: "custom-" + slug + "-" + hash(ext) + "-" + (now % 1e6).toString(36) + i,
        source: sourceId,
        kind: global.SignalData && global.SignalData.KINDS.indexOf(it.kind) !== -1 ? it.kind : guessKind(it.title, it.body),
        title: cleanText(it.title, 200),
        body: cleanText(it.body, 600),
        url: validUrl(it.url) ? it.url : "",
        deadline: parseDateValue(it.deadline),
        status: "new",
        note: "",
        received_at: now,
        external_id: ext
      });
      added++;
    });
    if (added) writeRows(rows);
    var defs = readDefs();
    defs.forEach(function (d) {
      if (d.id !== sourceId) return;
      d.lastFetched = now;
      d.itemCount = countRows(sourceId, rows);
    });
    writeDefs(defs);
    return { added: added, duplicates: duplicates };
  }

  function removeRows(sourceId) {
    var rows = readRows();
    var keep = rows.filter(function (r) { return r.source !== sourceId; });
    if (keep.length !== rows.length) writeRows(keep);
    return rows.length - keep.length;
  }

  /* =====================================================================
     6. Public API
  ===================================================================== */
  function normalizeDef(def, existing) {
    var d = Object.assign({}, existing || {}, def || {});
    d.name = cleanText(d.name, 60);
    d.type = TYPES.some(function (t) { return t.id === d.type; }) ? d.type : "rss";
    d.mode = d.mode === "paste" ? "paste" : "fetch";
    d.url = String(d.url || "").trim();
    d.sample = d.mode === "paste" ? String(d.sample || "").slice(0, 200000) : "";
    d.mapping = d.type === "json" ? Object.assign(clone(EMPTY_MAPPING), d.mapping || {}) : undefined;
    d.enabled = d.enabled !== false;
    if (!d.name) throw parseError("Give the source a name.");
    if (d.url && !validUrl(d.url)) throw parseError("Links need to start with http:// or https://.");
    if (d.mode === "fetch" && !d.url) throw parseError("Add the link Signal should read.");
    if (d.mode === "paste" && !d.sample.trim()) throw parseError("Paste a sample first.");
    return d;
  }

  function list() {
    var rows = readRows();
    return readDefs().map(function (d) {
      var out = clone(d);
      out.itemCount = countRows(d.id, rows);
      out.lastFetched = d.lastFetched || null;
      out.enabled = d.enabled !== false;
      return out;
    });
  }

  function get(id) { return list().filter(function (d) { return d.id === id; })[0] || null; }

  function label(sourceId) {
    var d = readDefs().filter(function (x) { return x.id === sourceId; })[0];
    return d && d.name ? d.name : "Your source";
  }

  function isCustom(sourceId) { return /^custom:/.test(String(sourceId || "")); }

  function add(def) {
    var defs = readDefs();
    var d = normalizeDef(def);
    var base = slugify(d.name), slug = base, n = 2;
    var taken = function (s) { return defs.some(function (x) { return x.id === "custom:" + s; }); };
    while (taken(slug)) slug = base + "-" + n++;
    d.id = "custom:" + slug;
    d.createdAt = Date.now();
    d.lastFetched = null;
    d.itemCount = 0;
    defs.push(d);
    writeDefs(defs);
    return clone(d);
  }

  function update(id, patch) {
    var defs = readDefs();
    var i = -1;
    defs.forEach(function (d, j) { if (d.id === id) i = j; });
    if (i === -1) return null;
    var safe = Object.assign({}, patch || {});
    delete safe.id;
    defs[i] = normalizeDef(safe, defs[i]);
    defs[i].id = id;
    writeDefs(defs);
    return clone(defs[i]);
  }

  /* opts.removeRows: also delete the signals this source added. The console asks first. */
  function remove(id, opts) {
    var defs = readDefs();
    var keep = defs.filter(function (d) { return d.id !== id; });
    if (keep.length === defs.length) return { removed: false, removedRows: 0 };
    var removedRows = opts && opts.removeRows ? removeRows(id) : 0;
    writeDefs(keep);
    return { removed: true, removedRows: removedRows };
  }

  global.SignalSources = {
    KEY: KEYS.sources,
    TYPES: TYPES,
    PRESETS: PRESETS,
    EMPTY_MAPPING: EMPTY_MAPPING,
    CORS_MESSAGE: CORS_MESSAGE,

    list: list,
    get: get,
    label: label,
    isCustom: isCustom,
    typeInfo: typeInfo,
    add: add,
    update: update,
    remove: remove,
    countRows: function (id) { return countRows(id); },
    removeRows: removeRows,

    fetchPreview: fetchPreview,
    importItems: importItems,
    detectMapping: detectMapping,
    hasAI: hasAI,
    mapWithAI: mapWithAI,

    validUrl: function (u) { return !!validUrl(u); },
    hostOf: hostOf,
    guessKind: guessKind,

    _test: {
      getPath: getPath,
      parseJson: parseJson,
      parseFeed: parseFeed,
      parsePage: parsePage,
      parseDateValue: parseDateValue,
      deadlineFromText: deadlineFromText,
      validateMapping: validateMapping,
      slugify: slugify
    }
  };
})(window);
