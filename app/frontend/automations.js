/* Signal research automations: a saved search that runs on a schedule. Desktop app only (the
   search and page reading are done by the app, see app/desktop/src-tauri/src/search.rs and page.rs).

   Made only when the user asks for one: the research agent can put one forward
   (schedule_search), and nothing is saved until the user confirms it on the Research page.

   Shape: { id: "auto:<slug>", name, goal, queries: [..], site, everyHours, on, createdAt }
   A run: search each query -> the first pages found -> read each page -> the same extractor and
   guardrails as a watched page (sources.js readPage: an item's link has to be on the page, and
   a deadline has to be in its text) -> the scheduler imports them as source "auto:<slug>", with
   the normal dedupe, threshold and notifications. A first run is stored quietly, like every source.

   Store: signal_demo_automations. Loaded before scheduler.js, which asks targets() for sources. */
(function (global) {
  "use strict";

  var KEY = "signal_demo_automations";
  var EVERY_HOURS = [6, 12, 24, 72, 168];
  var MAX_QUERIES = 3;
  var RESULTS_PER_QUERY = 5;
  var MAX_PAGES = 6;

  function read() {
    try { var v = JSON.parse(global.localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function write(list) {
    try { global.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
    try { global.dispatchEvent(new CustomEvent("signal:automations")); } catch (e) {}
  }
  function desktop() { return global.__TAURI__ && global.__TAURI__.core ? global.__TAURI__.core : null; }

  function slug(s) {
    return String(s || "search").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "search";
  }

  /* Cleans a draft from the agent or the form. Throws Error with a sentence for the UI. */
  function clean(d) {
    d = d || {};
    var name = String(d.name || "").trim().slice(0, 80);
    if (!name) throw new Error("Give the search a name.");
    var queries = (Array.isArray(d.queries) ? d.queries : String(d.queries || "").split("\n"))
      .map(function (q) { return String(q || "").trim().slice(0, 200); }).filter(Boolean).slice(0, MAX_QUERIES);
    if (!queries.length) throw new Error("Add at least one search query.");
    var site = String(d.site || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").slice(0, 100);
    var every = Number(d.everyHours) || 24;
    if (EVERY_HOURS.indexOf(every) === -1) every = 24;
    return { name: name, goal: String(d.goal || "").trim().slice(0, 300), queries: queries, site: site, everyHours: every };
  }

  function list() { return read(); }
  function get(id) { return read().filter(function (a) { return a.id === id; })[0] || null; }

  function add(draft) {
    var a = clean(draft);
    var all = read();
    var base = "auto:" + slug(a.name), id = base, n = 2;
    while (all.some(function (x) { return x.id === id; })) id = base + "-" + n++;
    a.id = id;
    a.on = true;
    a.createdAt = Date.now();
    all.push(a);
    write(all);
    return a;
  }
  function update(id, patch) {
    var all = read();
    all.forEach(function (a, i) {
      if (a.id !== id) return;
      var next = Object.assign({}, a, patch || {});
      if (patch && ("name" in patch || "queries" in patch || "site" in patch || "everyHours" in patch)) {
        var c = clean(next);
        next = Object.assign(next, c);
      }
      all[i] = next;
    });
    write(all);
  }
  function remove(id) { write(read().filter(function (a) { return a.id !== id; })); }

  /* One run: search, read, extract. Resolves to { items, note }. */
  function run(a, warn) {
    var core = desktop();
    var S = global.SignalSources;
    if (!core || !S) return Promise.reject(new Error("Automations run in the desktop app."));
    var urls = [], seen = {}, notes = [];
    var qi = 0;
    function nextQuery() {
      if (qi >= a.queries.length || urls.length >= MAX_PAGES) return Promise.resolve();
      var q = a.queries[qi++];
      return core.invoke("search_web", { query: q, site: a.site || null, count: RESULTS_PER_QUERY }).then(function (res) {
        if (!res.results.length) notes.push("“" + q + "”: " + (res.notes.join(" ") || "no results"));
        res.results.forEach(function (h) {
          if (urls.length < MAX_PAGES && !seen[h.url]) { seen[h.url] = true; urls.push(h.url); }
        });
        return nextQuery();
      });
    }
    var items = [];
    var pi = 0;
    function nextPage() {
      if (pi >= urls.length) return Promise.resolve();
      var url = urls[pi++];
      return core.invoke("read_page", { url: url }).then(function (p) {
        if (!p.ok || !p.html) return;
        return S.readPage({ id: a.id, url: p.url, name: a.name }, p.html).then(function (r) {
          items = items.concat(r.items || []);
        });
      }).catch(function () {}).then(nextPage);
    }
    return nextQuery().then(function () {
      if (!urls.length) throw new Error(notes[0] || "The search found no pages.");
      return nextPage();
    }).then(function () {
      if (notes.length && warn) notes.forEach(warn);
      return { items: items, pages: urls.length };
    });
  }

  /* Sources for the scheduler: every automation that is switched on. */
  function targets() {
    if (!desktop()) return [];
    return read().filter(function (a) { return a.on !== false; }).map(function (a) {
      return {
        id: a.id,
        name: "Automation: " + a.name,
        everyMs: a.everyHours * 3600 * 1000,
        poll: function (ctx) { return run(a, ctx && ctx.warn).then(function (r) { return r.items; }); }
      };
    });
  }

  function everyLabel(h) {
    return { 6: "Every 6 hours", 12: "Twice a day", 24: "Every day", 72: "Every 3 days", 168: "Every week" }[h] || "Every day";
  }

  global.SignalAutomations = {
    EVERY_HOURS: EVERY_HOURS,
    everyLabel: everyLabel,
    list: list,
    get: get,
    add: add,
    update: update,
    remove: remove,
    clean: clean,
    run: run,
    targets: targets
  };
})(window);
