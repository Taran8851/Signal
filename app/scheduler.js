/* Signal demo console — checks your own sources on a schedule.
   Loaded after sources.js and ai.js, before app.js. Runs while a console page is open
   (everything lives in this browser, so nothing runs when every tab is closed).

   One check (the shape comes from reference/signal/collector/index.ts):
   1. Poll every source that is due: the built-in ones through their own listing APIs
      (providers.js, each with its own interval), and every source you added that is switched
      on and reads from a link. Watched pages you added are read by your model when one is set
      up, otherwise by keyword search over the page's links (sources.js → readPage).
   2. Import what is new (duplicates are skipped by the listing's own id).
   3. A source's first successful poll is a backfill: it is stored quietly, without spending
      model calls on a backlog you have not seen.
   4. New items get a brief from your model when Scoring mode allows it and "Brief new signals"
      is on. Otherwise they keep keyword scores, which the inbox works out as it renders.
   A failing source is retried in 15 minutes instead of waiting for its normal interval, and
   keeps its own last error so Preferences can say which source is broken.

   Settings: signal_demo_schedule { on, every (minutes), brief }
   State:    signal_demo_schedule_state { lastRun, running, last, sources: { <id>: {...} } }
   Events:   "signal:schedule" on window whenever the state changes. */
(function (global) {
  "use strict";

  var KEYS = { settings: "signal_demo_schedule", state: "signal_demo_schedule_state", prefs: "signal_demo_prefs", rows: "signal_demo_rows" };
  var EVERY = [15, 30, 60, 180];
  var DEFAULTS = { on: true, every: 30, brief: true };
  var LOCK_MS = 10 * 60 * 1000; // a check that started this long ago is treated as dead
  var TICK_MS = 60 * 1000;
  var FIRST_CHECK_DELAY_MS = 2000;
  var RETRY_MS = 15 * 60 * 1000; // a failing source is tried again sooner than its interval

  function read(key, fallback) {
    try { var v = JSON.parse(global.localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function getSettings() {
    var s = Object.assign({}, DEFAULTS, read(KEYS.settings, {}) || {});
    s.on = s.on !== false;
    s.brief = s.brief !== false;
    s.every = EVERY.indexOf(Number(s.every)) !== -1 ? Number(s.every) : DEFAULTS.every;
    return s;
  }
  function saveSettings(patch) {
    write(KEYS.settings, Object.assign(getSettings(), patch || {}));
    emit();
  }
  function getState() { var s = read(KEYS.state, {}); return s && typeof s === "object" ? s : {}; }
  function setState(patch) { write(KEYS.state, Object.assign(getState(), patch)); emit(); }

  function emit() {
    try { global.dispatchEvent(new CustomEvent("signal:schedule", { detail: status() })); } catch (e) {}
  }

  function S() { return global.SignalSources || null; }
  function AI() { return global.SignalAI || null; }
  function P() { return global.SignalProviders || null; }

  function sourceState(id) {
    var all = getState().sources || {};
    return all[id] || {};
  }
  function setSourceState(id, patch) {
    var st = getState();
    var all = st.sources || {};
    all[id] = Object.assign({}, all[id] || {}, patch);
    st.sources = all;
    write(KEYS.state, st);
  }

  /* Every source a check can poll: the built-in providers plus your own link sources.
     A built-in one is skipped when Preferences switched it off or it still needs something. */
  function targets() {
    var out = [];
    var p = prefs();
    var off = p.disabled || [];
    if (P()) {
      P().ALL.forEach(function (prov) {
        var missing = prov.missing(p);
        if (missing || off.indexOf(prov.id) !== -1) {
          setSourceState(prov.id, { missing: missing || "switched off in Preferences" });
          return;
        }
        setSourceState(prov.id, { missing: null });
        out.push({ id: prov.id, name: sourceLabel(prov.id), everyMs: prov.everyMs, provider: prov });
      });
    }
    if (S()) {
      S().list().forEach(function (d) {
        if (d.enabled === false || d.mode === "paste" || !d.url) return;
        out.push({ id: d.id, name: d.name, everyMs: getSettings().every * 60000, custom: d });
      });
    }
    return out;
  }

  function sourceLabel(id) {
    var D = global.SignalData;
    var s = D && D.SOURCES ? D.SOURCES.filter(function (x) { return x.id === id; })[0] : null;
    return s ? s.label : id;
  }

  /* Sources the user can see being checked, for the "nothing to check yet" wording. */
  function checkable() { return targets(); }

  /* The demo rows that ship with the console have no external_id. Once a built-in source
     answers for real, its sample rows go, so the inbox isn't half real and half made up. */
  function dropSampleRows(sourceId) {
    var rows = read(KEYS.rows, null);
    if (!Array.isArray(rows)) return 0;
    var keep = rows.filter(function (r) { return !(r.source === sourceId && !r.external_id); });
    if (keep.length === rows.length) return 0;
    write(KEYS.rows, keep);
    return rows.length - keep.length;
  }

  function prefs() {
    var D = global.SignalData;
    var saved = read(KEYS.prefs, {});
    return Object.assign(D ? JSON.parse(JSON.stringify(D.DEFAULT_PREFS)) : {}, saved && typeof saved === "object" ? saved : {});
  }

  function isRunning(state) {
    return !!(state.running && Date.now() - state.running.at < LOCK_MS);
  }

  function nextAt(settings, state) {
    if (!settings.on) return null;
    return state.lastRun ? state.lastRun + settings.every * 60000 : Date.now();
  }

  /* How pages get read right now, for labels. */
  function readerNote() {
    return S() && S().modelReadyForPages && S().modelReadyForPages() ? "model" : "search";
  }

  function status() {
    var settings = getSettings(), state = getState();
    return {
      settings: settings,
      running: isRunning(state),
      lastRun: state.lastRun || null,
      nextAt: nextAt(settings, state),
      last: state.last || null,
      sources: checkable().length,
      reader: readerNote()
    };
  }

  function runOnce(reason, opts) {
    opts = opts || {};
    var state = getState();
    if (isRunning(state)) return Promise.resolve({ skipped: "running" });
    var all = targets();
    var due = opts.force ? all : all.filter(function (t) { return isDue(t); });
    if (!all.length || !due.length) {
      setState({ lastRun: Date.now(), last: { at: Date.now(), reason: reason, checked: 0, added: 0, briefed: 0, errors: [], methods: {}, notes: [], nothingDue: !!all.length } });
      return Promise.resolve({ skipped: all.length ? "nothing_due" : "no_sources", checked: 0, added: 0 });
    }
    setState({ running: { at: Date.now(), reason: reason, done: 0, total: due.length } });

    var summary = { at: Date.now(), reason: reason, checked: 0, added: 0, briefed: 0, quiet: 0, errors: [], methods: {}, notes: [] };
    var newIds = [];
    var i = 0;

    function pollOne(t) {
      var started = Date.now();
      var warnings = [];
      var seeded = !!sourceState(t.id).lastOk;
      setSourceState(t.id, { lastRun: started });
      var got;
      if (t.provider) {
        got = Promise.resolve().then(function () {
          return t.provider.poll({
            prefs: prefs(),
            cursor: sourceState(t.id).cursor || "",
            setCursor: function (v) { setSourceState(t.id, { cursor: v }); },
            warn: function (m) { warnings.push(m); }
          });
        }).then(function (items) { return { items: items, method: t.id }; });
      } else {
        got = S().fetchPreview(t.custom).then(function (res) {
          if (!res.ok) throw new Error(res.error);
          if (res.note) warnings.push(res.note);
          return { items: res.items, method: res.method };
        });
      }
      return got.then(function (r) {
        summary.checked++;
        if (!seeded && t.provider) dropSampleRows(t.id);
        var imported = S().importItems(t.id, r.items);
        summary.added += imported.added;
        // A source's first poll is a backfill: store it, don't spend model calls on it.
        if (seeded) newIds = newIds.concat(imported.addedIds || []);
        else summary.quiet += imported.added;
        if (r.method) summary.methods[r.method] = (summary.methods[r.method] || 0) + 1;
        warnings.forEach(function (w) { summary.notes.push(t.name + ": " + w); });
        setSourceState(t.id, {
          lastOk: Date.now(),
          lastError: warnings.length ? warnings.join(" · ").slice(0, 300) : null,
          detail: r.items.length + " seen · " + imported.added + " new" + (seeded ? "" : " · first check, stored quietly")
        });
      }, function (e) {
        summary.checked++;
        var message = (e && e.message) || "That source couldn't be read.";
        summary.errors.push({ source: t.name, message: message });
        setSourceState(t.id, { lastError: String(message).slice(0, 300), detail: "" });
      });
    }

    function nextSource() {
      if (i >= due.length) return Promise.resolve();
      var t = due[i++];
      return pollOne(t).then(function () {
        setState({ running: { at: Date.now(), reason: reason, done: i, total: due.length } });
        return nextSource();
      });
    }

    function brief() {
      var settings = getSettings();
      var ai = AI();
      if (!newIds.length || !settings.brief || !ai || !ai.readiness().ok) return Promise.resolve();
      var wanted = {};
      newIds.forEach(function (id) { wanted[id] = true; });
      var rows = (read(KEYS.rows, []) || []).filter(function (r) { return wanted[r.id]; });
      return ai.rescoreAll(rows, prefs()).then(function (res) {
        summary.briefed = res.summary.llm;
        if (res.summary.fallbacks) summary.notes.push(res.summary.fallbacks + " new signals kept keyword scores because the model failed.");
      });
    }

    return nextSource().then(brief).catch(function (e) {
      summary.errors.push({ source: "", message: (e && e.message) || "The check stopped because of an error." });
    }).then(function () {
      var st = getState();
      delete st.running;
      st.lastRun = Date.now();
      st.last = summary;
      write(KEYS.state, st);
      emit();
      return summary;
    });
  }

  function checkNow() { return runOnce("manual", { force: true }); }

  /* Due when it has never run, or its interval has passed. A source whose last run failed is
     retried after RETRY_MS instead of waiting for its full interval. */
  function isDue(t) {
    var st = sourceState(t.id);
    if (!st.lastRun) return true;
    var failing = !st.lastOk || st.lastOk < st.lastRun;
    var wait = failing ? Math.min(t.everyMs, RETRY_MS) : t.everyMs;
    return Date.now() - st.lastRun >= wait;
  }

  function tick() {
    var settings = getSettings();
    if (!settings.on || document.hidden) return;
    var at = nextAt(settings, getState());
    if (at !== null && Date.now() >= at) runOnce("schedule");
  }

  /* Per-source rows for Preferences: what each source did last time. */
  function sources() {
    return targets().map(function (t) {
      var st = sourceState(t.id);
      return {
        id: t.id, name: t.name, custom: !!t.custom, everyMs: t.everyMs,
        lastRun: st.lastRun || null, lastOk: st.lastOk || null,
        lastError: st.lastError || null, detail: st.detail || "", due: isDue(t)
      };
    });
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    setTimeout(tick, FIRST_CHECK_DELAY_MS);
    setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
    // Another tab finished a check or changed the schedule.
    global.addEventListener("storage", function (e) { if (e.key === KEYS.state || e.key === KEYS.settings) emit(); });
  }

  /* "3 min ago", "in 27 min". */
  function relative(ms) {
    var abs = Math.abs(ms), past = ms < 0;
    var text = abs < 60000 ? "under a minute" : abs < 3600000 ? Math.round(abs / 60000) + " min" : (Math.round(abs / 360000) / 10) + " h";
    if (abs < 60000) return past ? "just now" : "in under a minute";
    return past ? text + " ago" : "in " + text;
  }

  /* One sentence for the inbox and Preferences. */
  function describe(st) {
    st = st || status();
    if (!st.sources) return "Add a source that reads from a link and Signal will check it for you.";
    if (st.running) {
      var r = getState().running || {};
      return "Checking your sources… " + (r.total ? Math.min(r.done + 1, r.total) + " of " + r.total : "");
    }
    var parts = [];
    var reader = st.reader === "model" ? "Pages are read by your model." : "Pages are searched by keyword (add a model key to have your model read them).";
    if (st.last && st.last.at) {
      var l = st.last;
      if (l.checked) {
        parts.push("Checked " + l.checked + (l.checked === 1 ? " source " : " sources ") + relative(l.at - Date.now()) +
          ": " + (l.added ? l.added + " new" : "nothing new") +
          (l.quiet ? " (" + l.quiet + " stored quietly on a first check)" : "") +
          (l.briefed ? ", " + l.briefed + " briefed by your model" : "") + ".");
      } else if (l.nothingDue) {
        parts.push("Nothing due " + relative(l.at - Date.now()) + "; each source has its own interval.");
      }
      if (l.errors && l.errors.length) parts.push(l.errors.length + (l.errors.length === 1 ? " source" : " sources") + " couldn't be read (" + l.errors[0].source + ": " + String(l.errors[0].message).split(/(?<=\.)\s/)[0] + ").");
    }
    parts.push(st.settings.on ? "Next check " + relative(Math.max(0, st.nextAt - Date.now())) + "." : "Automatic checks are off.");
    parts.push(reader);
    return parts.join(" ");
  }

  global.SignalSchedule = {
    EVERY: EVERY,
    getSettings: getSettings,
    saveSettings: saveSettings,
    status: status,
    sources: sources,
    describe: describe,
    checkNow: checkNow,
    start: start,
    _test: { runOnce: runOnce, tick: tick, KEYS: KEYS }
  };
})(window);
