/* Signal demo console — checks your own sources on a schedule.
   Loaded after sources.js and ai.js, before app.js. Runs while a console page is open
   (everything lives in this browser, so nothing runs when every tab is closed).

   One check:
   1. Fetch every source you added that is switched on and reads from a link.
      Watched pages are read by your model when one is set up, otherwise by keyword search
      over the page's links (sources.js → readPage).
   2. Import new items (duplicates are skipped).
   3. New items get a brief from your model when Scoring mode allows it and "Brief new signals"
      is on. Otherwise they keep keyword scores, which the inbox works out as it renders.

   Settings: signal_demo_schedule { on, every (minutes), brief }
   State:    signal_demo_schedule_state { lastRun, running: { at }, last: {...} }
   Events:   "signal:schedule" on window whenever the state changes. */
(function (global) {
  "use strict";

  var KEYS = { settings: "signal_demo_schedule", state: "signal_demo_schedule_state", prefs: "signal_demo_prefs", rows: "signal_demo_rows" };
  var EVERY = [15, 30, 60, 180];
  var DEFAULTS = { on: true, every: 30, brief: true };
  var LOCK_MS = 10 * 60 * 1000; // a check that started this long ago is treated as dead
  var TICK_MS = 60 * 1000;
  var FIRST_CHECK_DELAY_MS = 2000;

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

  /* Sources a check reads: yours, switched on, fetched from a link (pasted samples never change). */
  function checkable() {
    if (!S()) return [];
    return S().list().filter(function (d) { return d.enabled !== false && d.mode !== "paste" && d.url; });
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

  function runOnce(reason) {
    var state = getState();
    if (isRunning(state)) return Promise.resolve({ skipped: "running" });
    var sources = checkable();
    if (!sources.length) {
      setState({ lastRun: Date.now(), last: { at: Date.now(), reason: reason, checked: 0, added: 0, briefed: 0, errors: [], methods: {} } });
      return Promise.resolve({ skipped: "no_sources" });
    }
    setState({ running: { at: Date.now(), reason: reason, done: 0, total: sources.length } });

    var summary = { at: Date.now(), reason: reason, checked: 0, added: 0, briefed: 0, errors: [], methods: {}, notes: [] };
    var newIds = [];
    var i = 0;

    function nextSource() {
      if (i >= sources.length) return Promise.resolve();
      var def = sources[i++];
      return S().fetchPreview(def).then(function (res) {
        summary.checked++;
        if (!res.ok) {
          summary.errors.push({ source: def.name, message: res.error });
          return;
        }
        var r = S().importItems(def.id, res.items);
        summary.added += r.added;
        newIds = newIds.concat(r.addedIds || []);
        if (res.method) summary.methods[res.method] = (summary.methods[res.method] || 0) + 1;
        if (res.note) summary.notes.push(def.name + ": " + res.note);
      }).then(function () {
        setState({ running: { at: Date.now(), reason: reason, done: i, total: sources.length } });
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

  function checkNow() { return runOnce("manual"); }

  function tick() {
    var settings = getSettings();
    if (!settings.on || document.hidden) return;
    var at = nextAt(settings, getState());
    if (at !== null && Date.now() >= at) runOnce("schedule");
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
      parts.push("Checked " + l.checked + (l.checked === 1 ? " source " : " sources ") + relative(l.at - Date.now()) +
        ": " + (l.added ? l.added + " new" : "nothing new") + (l.briefed ? ", " + l.briefed + " briefed by your model" : "") + ".");
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
    describe: describe,
    checkNow: checkNow,
    start: start,
    _test: { runOnce: runOnce, tick: tick, KEYS: KEYS }
  };
})(window);
