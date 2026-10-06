/* Signal demo console — auth guard, local store, appearance, and per-page behaviour.
   Everything here is a client-side illusion: no network requests, no real accounts.
   State lives in this browser's localStorage.

   Contents
   1. Store (rows, preferences, appearance, session)
   2. Wording helpers — every user-facing phrase about time, deadlines and matches
   3. Shell — theme switcher, logout, nav count
   4. Page: sign in
   5. Page: signals (list + overlay)
   6. Shared helpers for page scripts (preferences.js) */
(function () {
  "use strict";

  var D = window.SignalData;

  /* =====================================================================
     1. Store
  ===================================================================== */
  var KEYS = {
    session: "signal_demo_session",
    rows: "signal_demo_rows",
    prefs: "signal_demo_prefs",
    appearance: "signal_demo_appearance"
  };

  function read(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function getRows() {
    var rows = read(KEYS.rows, null);
    if (!Array.isArray(rows)) { rows = clone(D.START_ROWS); write(KEYS.rows, rows); }
    // Installs before 0.2.8 started from the website's sample rows. Drop them once, by their fixed
    // ids; real signals never use those.
    if (window.__TAURI__ && !read("signal_demo_rows_cleared", false)) {
      var sample = D.RAW_ROWS.map(function (r) { return r.id; });
      rows = rows.filter(function (r) { return sample.indexOf(r.id) === -1; });
      write(KEYS.rows, rows);
      write("signal_demo_rows_cleared", true);
    }
    return rows;
  }
  function saveRows(rows) { write(KEYS.rows, rows); }

  function getPrefs() {
    var saved = read(KEYS.prefs, {});
    var p = Object.assign(clone(D.DEFAULT_PREFS), saved && typeof saved === "object" ? saved : {});
    delete p.desktop; // the hosted app has no desktop channel (AGENTS.md)
    return p;
  }
  function savePrefs(p) { write(KEYS.prefs, p); }

  function getAppearance() {
    return Object.assign({ mode: "system", glass: "frosted", density: "comfortable" }, read(KEYS.appearance, {}));
  }

  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function applyAppearance(a) {
    var dark = a.mode === "dark" || (a.mode === "system" && darkQuery && darkQuery.matches);
    var root = document.documentElement;
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.setAttribute("data-glass", a.glass);
    root.setAttribute("data-density", a.density);
    syncRadios("quick-mode", a.mode);
    syncRadios("appearance-mode", a.mode);
    syncRadios("appearance-glass", a.glass);
    syncRadios("appearance-density", a.density);
  }
  function setAppearance(patch) {
    var a = Object.assign(getAppearance(), patch);
    write(KEYS.appearance, a);
    applyAppearance(a);
  }

  function isAuthed() { return read(KEYS.session, null) === 1; }

  /* =====================================================================
     2. Wording helpers
  ===================================================================== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function syncRadios(name, value) {
    $all('input[name="' + name + '"]').forEach(function (r) { r.checked = r.value === value; });
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  function humanList(items) {
    var q = items.map(function (t) { return "“" + t + "”"; });
    if (q.length <= 1) return q.join("");
    return q.slice(0, -1).join(", ") + " and " + q[q.length - 1];
  }

  function timeAgo(ts) {
    var mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (mins < 60) return plural(mins, "minute") + " ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return plural(hrs, "hour") + " ago";
    var days = Math.round(hrs / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(iso) {
    var d = new Date(iso + "T12:00:00");
    var s = d.getDate() + " " + MONTHS[d.getMonth()];
    return d.getFullYear() === new Date().getFullYear() ? s : s + " " + d.getFullYear();
  }

  /* Deadline in words. `days` counts whole days left, 0 = closes today. */
  function deadlineInfo(iso) {
    if (!iso) return null;
    var end = new Date(iso + "T23:59:59").getTime();
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var days = Math.floor((end - today.getTime()) / 86400000);
    if (end < Date.now()) return { days: -1, text: "Closed " + shortDate(iso), cls: "chip-closed" };
    if (days === 0) return { days: 0, text: "Closes today", cls: "chip-warn" };
    if (days === 1) return { days: 1, text: "Closes tomorrow", cls: "chip-warn" };
    if (days <= 7) return { days: days, text: "Closes in " + days + " days", cls: days <= 3 ? "chip-warn" : "chip-ok" };
    return { days: days, text: "Closes " + shortDate(iso), cls: "" };
  }

  /* Custom sources (app/frontend/sources.js, optional). Every call is guarded: the file may be missing. */
  function customSources() {
    try {
      if (window.SignalSources && typeof window.SignalSources.list === "function") {
        var list = window.SignalSources.list();
        return Array.isArray(list) ? list.filter(function (x) { return x && x.id; }) : [];
      }
    } catch (e) {}
    return [];
  }

  function sourceLabel(id) {
    if (id === "manual") return "Added by you";
    if (id === "research") return "Research agent";
    if (typeof id === "string" && id.indexOf("auto:") === 0) {
      var auto = window.SignalAutomations && window.SignalAutomations.get(id);
      return auto ? "Automation: " + auto.name : "Automation";
    }
    if (typeof id === "string" && id.indexOf("custom:") === 0) {
      try {
        if (window.SignalSources && typeof window.SignalSources.label === "function") {
          var name = window.SignalSources.label(id);
          if (name) return String(name);
        }
      } catch (e) {}
      return "Your source";
    }
    var s = D.SOURCES.filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }
  function kindLabel(k) { return D.KIND_LABELS[k] || "Other"; }

  /* Score a row against the current preferences and describe the result in words.
     Scores are recomputed on every render, so preference changes show up immediately. */
  function describeMatch(row, prefs) {
    var s = D.scoreItem(row, prefs);
    var t = prefs.threshold;
    var level;
    if (s.excluded) level = { label: "Blocked by Never show", cls: "chip-warn" };
    else if (s.score <= 0) level = { label: "No match", cls: "" };
    else if (s.score >= t + 3) level = { label: "Strong match", cls: "chip-good" };
    else if (s.score >= t) level = { label: "Good match", cls: "chip-ok" };
    else level = { label: "Weak match", cls: "" };
    s.level = level;
    s.alwaysNotify = D.ALWAYS_NOTIFY.indexOf(row.kind) !== -1;
    s.wouldNotify = !s.excluded && (s.alwaysNotify || s.score >= t);
    return s;
  }

  function shortWhy(m) {
    if (m.excluded) return "Contains " + humanList(m.excludedBy) + " from your Never show list";
    if (m.alwaysNotify) return "Messages and page changes always reach you";
    if (!m.matched.length) return "None of your topics or words appear in it";
    return "Matches " + humanList(m.matched);
  }

  var toastTimer;
  function toast(text) {
    var el = $("[data-toast]");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  var ICONS = {
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg>',
    bookmarked: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  /* =====================================================================
     3. Shell
  ===================================================================== */
  function initShell() {
    applyAppearance(getAppearance());

    $all('input[name="quick-mode"], input[name="appearance-mode"]').forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) setAppearance({ mode: r.value }); });
    });
    if (darkQuery) {
      var onSystemChange = function () { if (getAppearance().mode === "system") applyAppearance(getAppearance()); };
      if (darkQuery.addEventListener) darkQuery.addEventListener("change", onSystemChange);
      else if (darkQuery.addListener) darkQuery.addListener(onSystemChange);
    }

    $all("[data-logout]").forEach(function (b) {
      b.addEventListener("click", function () {
        try { localStorage.removeItem(KEYS.session); } catch (e) {}
        location.href = "login.html";
      });
    });

    updateNavCount();

    // Blur the page while any sheet is open (see app.css: dialogs can't blur what's behind them).
    var sheets = $all("dialog");
    function syncSheetBlur() {
      document.documentElement.classList.toggle("sheet-open", sheets.some(function (d) { return d.open; }));
    }
    if (sheets.length && typeof MutationObserver === "function") {
      var mo = new MutationObserver(syncSheetBlur);
      sheets.forEach(function (d) { mo.observe(d, { attributes: true, attributeFilter: ["open"] }); d.addEventListener("close", syncSheetBlur); });
    }
  }

  function updateNavCount() {
    var prefs = getPrefs();
    var n = getRows().filter(function (r) { return r.status === "new" && !D.scoreItem(r, prefs).excluded; }).length;
    $all("[data-nav-count]").forEach(function (el) {
      el.textContent = n;
      el.hidden = n === 0;
      el.setAttribute("aria-label", plural(n, "new signal"));
    });
  }

  /* =====================================================================
     4. Page: sign in
  ===================================================================== */
  function initLogin() {
    if (isAuthed()) { location.replace("inbox.html"); return; }
    var form = $("[data-login-form]");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      write(KEYS.session, 1);
      location.href = "inbox.html";
    });
  }

  /* =====================================================================
     5. Page: signals
  ===================================================================== */
  function initInbox() {
    var state = { status: "new", kind: "", source: "", q: "", sort: "recent", closingSoon: false };
    var AI = window.SignalAI || null;
    var run = null; // { stop: bool } while "Score all with AI" runs
    var rowsEl = $("[data-rows]");

    /* ---------- list ---------- */
    function customSources() {
      try { return window.SignalSources ? window.SignalSources.list() : []; } catch (e) { return []; }
    }
    function isOffCustom(id) {
      if (!id || String(id).indexOf("custom:") !== 0) return false;
      var src = customSources().filter(function (c) { return c.id === id; })[0];
      return !!src && src.enabled === false;
    }
    function visible(rows, prefs) {
      var q = state.q.trim().toLowerCase();
      return rows.map(function (r) { return { row: r, m: describeMatch(r, prefs), d: deadlineInfo(r.deadline) }; })
        .filter(function (x) {
          var r = x.row;
          // Rows from one of your own sources that you switched off stay hidden.
          if (isOffCustom(r.source)) return false;
          // An excluded row belongs in Archived no matter what its stored status is.
          var status = x.m.excluded ? "archived" : r.status;
          if (state.status !== "all" && status !== state.status) return false;
          if (state.closingSoon && !(x.d && x.d.days >= 0 && x.d.days <= 7)) return false;
          // "bigtech" is not a kind: it is hackathons that name a big tech company (app-data.js, BIG_TECH).
          if (state.kind === "bigtech") { if (!D.isBigTechHackathon(r)) return false; }
          else if (state.kind && r.kind !== state.kind) return false;
          if (state.source && r.source !== state.source) return false;
          if (q && (r.title + " " + r.body + " " + (r.note || "")).toLowerCase().indexOf(q) === -1) return false;
          return true;
        })
        .sort(function (a, b) {
          if (state.sort === "deadline") {
            var ad = a.d && a.d.days >= 0 ? a.row.deadline : null;
            var bd = b.d && b.d.days >= 0 ? b.row.deadline : null;
            if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
            if (ad) return -1;
            if (bd) return 1;
            return b.row.received_at - a.row.received_at;
          }
          if (state.sort === "score") return b.m.score - a.m.score || b.row.received_at - a.row.received_at;
          if (state.sort === "relevance") {
            var ar = llmRelevance(a.row), br = llmRelevance(b.row);
            return br - ar || b.m.score - a.m.score || b.row.received_at - a.row.received_at;
          }
          return b.row.received_at - a.row.received_at;
        });
    }

    function aiLabel(r) {
      if (!AI) return null;
      try { return AI.scoreLabel(r, getPrefs()); } catch (e) { return null; }
    }
    /* -1 when the row has no model result, so it sorts after every scored row. */
    function llmRelevance(r) {
      var l = aiLabel(r);
      return l && l.source === "llm" ? l.relevance : -1;
    }

    /* When the user's model has scored a row (app/frontend/ai.js), show its relevance next to the keyword
       match; when the model was asked and failed, say the keyword score is a fallback. */
    function aiChip(label) {
      if (!label) return "";
      if (label.source === "llm") {
        return '<span class="ai-badge" data-source="llm" title="' + esc("Relevance " + label.relevance + " of 10 from " + (label.model || "your model")) + '">' + esc(label.text) + "</span>";
      }
      if (label.source === "fallback") {
        return '<span class="chip chip-warn" title="' + esc(label.reason) + '">Keyword fallback</span>';
      }
      return "";
    }

    function rowHtml(x) {
      var r = x.row, m = x.m, d = x.d;
      var label = m.excluded ? null : aiLabel(r);
      var llmSummary = label && label.source === "llm" && label.summary ? label.summary : "";
      var saved = r.status === "saved";
      var archived = r.status === "archived" || m.excluded;
      return (
        '<article class="row' + (m.excluded ? " is-excluded" : "") + '">' +
          '<button class="row-open" type="button" data-open="' + esc(r.id) + '"><span class="visually-hidden">Open ' + esc(r.title) + "</span></button>" +
          '<div class="row-main">' +
            '<div class="row-top"><span class="chip">' + esc(kindLabel(r.kind)) + "</span>" +
              "<span>" + esc(sourceLabel(r.source)) + " · " + esc(timeAgo(r.received_at)) + "</span></div>" +
            '<h2 class="row-title">' + esc(r.title) + "</h2>" +
            (llmSummary
              ? '<p class="row-why is-llm">' + esc(llmSummary) + "</p>"
              : '<p class="row-why">' + esc(shortWhy(m)) + "</p>") +
            (r.note ? '<p class="row-note">Note: ' + esc(r.note) + "</p>" : "") +
          "</div>" +
          '<div class="row-side">' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">' +
              (d ? '<span class="chip ' + d.cls + '">' + esc(d.text) + "</span>" : "") +
              '<span class="chip ' + m.level.cls + '" title="' + esc(m.score + " points") + '">' + esc(m.level.label) + "</span>" +
              aiChip(label) +
            "</div>" +
            '<div class="row-actions">' +
              (m.excluded ? "" :
                '<button class="icon-button" type="button" data-quick="' + (saved ? "new" : "saved") + '" data-id="' + esc(r.id) + '" aria-label="' + (saved ? "Remove from Saved" : "Save for later") + '" title="' + (saved ? "Remove from Saved" : "Save for later") + '">' + (saved ? ICONS.bookmarked : ICONS.bookmark) + "</button>" +
                '<button class="icon-button" type="button" data-quick="' + (archived ? "new" : "archived") + '" data-id="' + esc(r.id) + '" aria-label="' + (archived ? "Move back to New" : "Archive") + '" title="' + (archived ? "Move back to New" : "Archive") + '">' + (archived ? ICONS.restore : ICONS.archive) + "</button>") +
            "</div>" +
          "</div>" +
        "</article>"
      );
    }

    var EMPTY = {
      "new": ["You're all caught up", "New matches will show up here as Signal finds them."],
      saved: ["Nothing saved yet", "Open a signal and mark it Saved to keep it here."],
      applied: ["No applications tracked", "Mark a signal as Applied to keep track of what you've sent."],
      archived: ["Archive is empty", "Signals you archive, and anything caught by Never show, land here."],
      all: ["No signals yet", "Once sources are running, everything Signal stores appears here."]
    };

    function render() {
      var prefs = getPrefs();
      var rows = getRows();
      var scored = rows.map(function (r) { return { row: r, m: describeMatch(r, prefs), d: deadlineInfo(r.deadline) }; });

      // Counts per tab (excluded rows count as archived)
      var counts = { "new": 0, saved: 0, applied: 0, archived: 0, all: rows.length };
      scored.forEach(function (x) { counts[x.m.excluded ? "archived" : x.row.status]++; });
      $all("[data-tab-count]").forEach(function (el) { el.textContent = counts[el.getAttribute("data-tab-count")]; });

      // Summary cards and the sentence under the heading
      var soon = scored.filter(function (x) {
        return !x.m.excluded && x.row.status !== "archived" && x.d && x.d.days >= 0 && x.d.days <= 7;
      }).length;
      $("[data-summary-count=new]").textContent = counts["new"];
      $("[data-summary-count=soon]").textContent = soon;
      $("[data-summary-count=saved]").textContent = counts.saved;
      var lede = counts["new"]
        ? plural(counts["new"], "new signal") + " waiting for you."
        : "You're all caught up.";
      if (soon) lede += " " + (soon === 1 ? "1 closes" : soon + " close") + " in the next 7 days.";
      $("[data-lede]").textContent = lede;

      // Source summary in the list header
      var enabled = D.SOURCES.filter(function (s) { return prefs.disabled.indexOf(s.id) === -1; });
      var working = enabled.filter(function (s) { return s.status === "ready"; }).length;
      var setup = enabled.filter(function (s) { return s.status === "setup"; }).length;
      var mine = customSources();
      var mineOn = mine.filter(function (c) { return c.enabled !== false; }).length;
      $("[data-sources-summary]").innerHTML =
        "Watching " + (working + mineOn) + " of " + (D.SOURCES.length + mine.length) + " sources" +
        (setup ? ' · <a href="preferences.html#sources">' + plural(setup, "needs setup", "need setup").replace(/^\d+ /, setup + " ") + "</a>" : "");

      syncSourceFilter();
      syncRelevanceSort();

      // The list
      var list = visible(rows, prefs);
      lastVisible = list;
      var filtered = !!(state.q || state.kind || state.source || state.closingSoon);
      $("[data-list-count]").textContent = plural(list.length, "signal") + (state.closingSoon ? " closing in 7 days" : "");
      rowsEl.innerHTML = list.map(rowHtml).join("");

      var empty = $("[data-empty]");
      empty.hidden = list.length > 0;
      if (!list.length) {
        var copy = filtered ? ["Nothing matches", "Try a different search, or clear the filters."] : EMPTY[state.status];
        $("[data-empty-title]").textContent = copy[0];
        $("[data-empty-text]").textContent = copy[1];
        $("[data-clear-filters]").hidden = !filtered;
      }
      syncScoreAll();
      updateNavCount();
    }

    var lastVisible = [];

    /* Custom sources go at the end of the source filter, in their own group. */
    function syncSourceFilter() {
      var select = $("[data-source-filter]");
      if (!select) return;
      var old = select.querySelector("optgroup[data-custom-sources]");
      var list = customSources();
      var sig = JSON.stringify(list.map(function (x) { return [x.id, x.name]; }));
      if (old && old.getAttribute("data-sig") === sig) return;
      if (old) old.remove();
      if (!list.length) {
        if (state.source.indexOf("custom:") === 0) { state.source = ""; select.value = ""; }
        return;
      }
      var group = document.createElement("optgroup");
      group.label = "Your sources";
      group.setAttribute("data-custom-sources", "");
      group.setAttribute("data-sig", sig);
      list.forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.id;
        o.textContent = x.name || sourceLabel(x.id);
        group.appendChild(o);
      });
      select.appendChild(group);
      select.value = state.source;
    }

    /* "Relevance" sort appears once any row has a model result. */
    function syncRelevanceSort() {
      var select = $("[data-sort]");
      if (!select) return;
      var opt = select.querySelector('option[value="relevance"]');
      var any = false;
      try { any = !!(AI && AI.hasLLMResults()); } catch (e) {}
      if (any && !opt) {
        opt = document.createElement("option");
        opt.value = "relevance";
        opt.textContent = "Relevance (your model)";
        select.appendChild(opt);
      } else if (!any && opt) {
        opt.remove();
        if (state.sort === "relevance") state.sort = "recent";
      }
      select.value = state.sort;
    }

    /* ---------- Score all with AI ---------- */
    var scoreAllBtn = $("[data-score-all]");
    var scoreAllNote = $("[data-score-all-note]");
    var runBar = $("[data-ai-run]");
    var runText = $("[data-ai-run-text]");
    var runFill = $("[data-ai-run-fill]");
    var runStop = $("[data-ai-run-stop]");
    var runClose = $("[data-ai-run-close]");

    function syncScoreAll() {
      if (!scoreAllBtn) return;
      if (!AI) { scoreAllBtn.hidden = true; return; }
      if (run) { scoreAllBtn.disabled = true; scoreAllNote.hidden = true; return; }
      var ready = AI.readiness();
      var none = !lastVisible.length;
      scoreAllBtn.disabled = !ready.ok || none;
      if (!ready.ok) {
        scoreAllNote.innerHTML = esc(ready.note.replace(/ in Settings/, "")) + ' <a href="preferences.html#scoring">Open scoring settings</a>';
      } else if (none) {
        scoreAllNote.textContent = "No signals in this view to score.";
      }
      scoreAllNote.hidden = ready.ok && !none;
    }

    function runSentence(done, total, model) {
      return "Reading " + Math.min(done + 1, total) + " of " + plural(total, "signal") + " with " + model + "…";
    }

    function startScoreAll() {
      if (!AI || run) return;
      var ready = AI.readiness();
      if (!ready.ok) { syncScoreAll(); return; }
      var rows = lastVisible.map(function (x) { return x.row; });
      if (!rows.length) return;
      var settings = AI.getSettings();
      run = { stop: false };
      runBar.hidden = false;
      runBar.setAttribute("data-state", "running");
      runStop.hidden = false; runStop.disabled = false; runStop.textContent = "Stop";
      runClose.hidden = true;
      runFill.style.width = "0%";
      runText.textContent = runSentence(0, rows.length, settings.model);
      syncScoreAll();
      AI.rescoreAll(rows, getPrefs(), function (p) {
        runFill.style.width = Math.round(p.done / p.total * 100) + "%";
        runText.textContent = p.done < p.total && !run.stop ? runSentence(p.done, p.total, settings.model) : "Finishing…";
      }, { shouldStop: function () { return !!(run && run.stop); } }).then(function (res) {
        var sm = res.summary;
        var parts = [];
        parts.push(plural(sm.llm, "brief") + " from " + settings.model);
        if (sm.cached) parts[0] += " (" + sm.cached + " from this browser's cache)";
        if (sm.belowPrefilter) parts.push(sm.belowPrefilter + " below the Hybrid prefilter kept keyword scores");
        if (sm.excluded) parts.push(sm.excluded + " excluded, never sent");
        if (sm.fallbacks) parts.push(plural(sm.fallbacks, "keyword fallback") + " where the model failed or its reply did not fit the format");
        var head = sm.stopped ? "Stopped after " + plural(res.results.length, "signal") + ". " : "Done. ";
        var detail = sm.stoppedBy ? firstError(res.results) : (sm.fallbacks ? firstError(res.results) : "");
        runText.innerHTML = esc(head + parts.join(". ") + ".") +
          "<small>" + esc((detail ? detail + " " : "") + "Used today: " + sm.usage.calls + " of " + sm.usage.cap + " model calls.") + "</small>";
      }, function () {
        runText.textContent = "Scoring stopped because of an error. Scores you already had are unchanged.";
      }).then(function () {
        run = null;
        runBar.setAttribute("data-state", "done");
        runFill.style.width = "100%";
        runStop.hidden = true;
        runClose.hidden = false;
        render();
        refreshOpenSheet();
        runClose.focus();
      });
    }

    function firstError(results) {
      var r = results.filter(function (x) { return x.fallback && x.error; })[0];
      return r ? "First problem: " + r.error : "";
    }

    if (scoreAllBtn) scoreAllBtn.addEventListener("click", startScoreAll);
    if (runStop) runStop.addEventListener("click", function () {
      if (!run) return;
      run.stop = true;
      runStop.disabled = true;
      runStop.textContent = "Stopping…";
    });
    if (runClose) runClose.addEventListener("click", function () { runBar.hidden = true; if (scoreAllBtn && !scoreAllBtn.disabled) scoreAllBtn.focus(); });

    function setStatus(id, status) {
      var rows = getRows();
      var row = rows.filter(function (r) { return r.id === id; })[0];
      if (!row) return;
      row.status = status;
      saveRows(rows);
    }

    /* ---------- list events ---------- */
    $all('input[name="status"]').forEach(function (r) {
      r.addEventListener("change", function () { state.status = r.value; state.closingSoon = false; render(); });
    });
    $("[data-search]").addEventListener("input", function (e) { state.q = e.target.value; render(); });
    $("[data-kind-filter]").addEventListener("change", function (e) { state.kind = e.target.value; render(); });
    $("[data-source-filter]").addEventListener("change", function (e) { state.source = e.target.value; render(); });
    $("[data-sort]").addEventListener("change", function (e) { state.sort = e.target.value; render(); });

    $all("[data-summary]").forEach(function (b) {
      b.addEventListener("click", function () {
        var which = b.getAttribute("data-summary");
        state.closingSoon = which === "soon";
        state.status = which === "soon" ? "all" : which;
        if (which === "soon") { state.sort = "deadline"; $("[data-sort]").value = "deadline"; }
        syncRadios("status", state.status);
        render();
      });
    });

    $("[data-clear-filters]").addEventListener("click", function () {
      state.q = ""; state.kind = ""; state.source = ""; state.closingSoon = false;
      $("[data-search]").value = ""; $("[data-kind-filter]").value = ""; $("[data-source-filter]").value = "";
      render();
    });

    rowsEl.addEventListener("click", function (e) {
      var quick = e.target.closest("[data-quick]");
      if (quick) {
        var to = quick.getAttribute("data-quick");
        setStatus(quick.getAttribute("data-id"), to);
        render();
        toast({ saved: "Saved for later", archived: "Archived", "new": "Moved to New" }[to]);
        return;
      }
      var open = e.target.closest("[data-open]");
      if (open) openSheet(open.getAttribute("data-open"));
    });

    $all("[data-add-signal]").forEach(function (b) { b.addEventListener("click", openAdd); });

    /* ---------- overlay ---------- */
    var sheet = $("[data-sheet]");
    var editForm = $("[data-edit-form]");
    var noteEl = $("[data-sheet-note]");
    var currentId = null;
    var noteTimer;
    var insight = null; // handle returned by SignalAI.mountRowInsight
    var insightEl = $("[data-ai-insight]");
    var whySection = $("[data-why-section]");
    var briefSection = $("[data-brief-section]");

    /* Show the brief when a model result exists, and move the Ask control with it. */
    function syncBrief(row) {
      var result = null;
      try { result = AI && row ? AI.getResult(row.id) : null; } catch (e) {}
      var excluded = row ? D.scoreItem(row, getPrefs()).excluded : false;
      var has = !!(result && result.source === "llm" && !excluded);
      briefSection.hidden = !has;
      $("[data-ai-brief]").innerHTML = has ? AI.briefHtml(result) : "";
      $("[data-why-heading]").textContent = has ? "Keyword check" : "Why it's here";
      var home = has ? briefSection : whySection;
      if (insightEl.parentNode !== home) home.appendChild(insightEl);
    }

    function refreshOpenSheet() {
      if (!currentId || !sheet.open) return;
      var row = getRows().filter(function (r) { return r.id === currentId; })[0];
      if (row) syncBrief(row);
    }

    function showSheet() {
      if (sheet.open) return;
      if (typeof sheet.showModal === "function") sheet.showModal();
      else sheet.setAttribute("open", "");
    }
    function closeSheet() {
      if (typeof sheet.close === "function" && sheet.open) sheet.close();
      else { sheet.removeAttribute("open"); onClosed(); }
    }
    function onClosed() {
      clearTimeout(noteTimer);
      flushNote();
      currentId = null;
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      render();
    }

    function setMode(isAdd) {
      $all("[data-view-only]", sheet).forEach(function (el) { el.hidden = isAdd; });
      $("[data-delete-area]", sheet).hidden = isAdd;
      $("[data-edit-summary]", sheet).hidden = isAdd;
      $("[data-edit-submit]", sheet).textContent = isAdd ? "Add signal" : "Save changes";
      $("[data-edit-block]", sheet).open = isAdd;
      $("[data-edit-error]", sheet).hidden = true;
      $("[data-confirm]", sheet).hidden = true;
      $("[data-delete]", sheet).hidden = false;
    }

    function fillEditForm(row) {
      editForm.title.value = row ? row.title : "";
      editForm.kind.value = row ? row.kind : "other";
      editForm.deadline.value = row && row.deadline ? row.deadline : "";
      editForm.url.value = row ? row.url || "" : "";
      editForm.body.value = row ? row.body || "" : "";
    }

    function fillSheet(row) {
      var prefs = getPrefs();
      var m = describeMatch(row, prefs);
      var d = deadlineInfo(row.deadline);

      $("[data-sheet-kicker]").innerHTML =
        '<span class="chip">' + esc(kindLabel(row.kind)) + "</span>" +
        (d ? '<span class="chip ' + d.cls + '">' + esc(d.text) + "</span>" : "") +
        '<span class="chip ' + m.level.cls + '">' + esc(m.level.label) + "</span>";
      $("[data-sheet-title]").textContent = row.title;
      $("[data-sheet-meta]").textContent =
        "From " + sourceLabel(row.source) + " · found " + timeAgo(row.received_at) +
        (row.deadline ? " · deadline " + shortDate(row.deadline) : "");

      // Why it's here: one plain sentence, then the arithmetic behind it
      var summary;
      if (m.excluded) {
        summary = "It contains " + humanList(m.excludedBy) + ", which is on your Never show list, so Signal archives it as soon as it arrives.";
      } else if (m.alwaysNotify) {
        summary = "Messages sent to you and changes on pages you watch always reach you, whatever they score.";
      } else if (!m.breakdown.length) {
        summary = "None of your topics or words appear in it. It's listed because Signal stores everything it finds, but it would not notify you.";
      } else {
        summary = "It matched " + humanList(m.matched) + " for " + plural(m.score, "point") + ". " +
          "You get notified at " + prefs.threshold + " or more, so this one " +
          (m.wouldNotify ? "would notify you." : "stays quietly in your list.");
      }
      $("[data-why-summary]").textContent = summary;

      // The brief from the user's model (app/frontend/ai.js) sits above the keyword check; "Ask the model" follows it
      if (AI) {
        if (insight) insight.destroy();
        insight = AI.mountRowInsight(insightEl, row, prefs, { showBrief: false });
      }
      syncBrief(row);
      $("[data-why-list]").innerHTML = m.breakdown.length
        ? m.breakdown.map(function (b) {
            var what = b.list === "topic" ? "Topic" : "Boost word";
            return "<li><span>" + what + " “" + esc(b.term) + "” in the " + b.where + "</span><b>+" + b.points + "</b></li>";
          }).join("") +
          '<li class="why-total"><span>Total · you\'re notified at ' + prefs.threshold + " or more</span><b>" + plural(m.score, "point") + "</b></li>"
        : "";

      syncRadios("sheet-status", m.excluded ? "archived" : row.status);
      noteEl.value = row.note || "";
      $("[data-note-status]").textContent = "";

      var hasBody = !!(row.body && row.body.trim());
      $("[data-description-section]").hidden = !hasBody;
      $("[data-sheet-description]").textContent = row.body || "";

      var link = $("[data-open-original]");
      link.hidden = !row.url;
      if (row.url) link.href = row.url;

      fillEditForm(row);
    }

    function openSheet(id) {
      var row = getRows().filter(function (r) { return r.id === id; })[0];
      if (!row) { toast("That signal no longer exists."); return; }
      currentId = id;
      setMode(false);
      fillSheet(row);
      history.replaceState(null, "", "#signal=" + encodeURIComponent(id));
      showSheet();
      $("[data-sheet-title]").focus();
    }

    function openAdd() {
      currentId = null;
      setMode(true);
      $("[data-sheet-kicker]").innerHTML = '<span class="chip">Added by you</span>';
      $("[data-sheet-title]").textContent = "Add a signal";
      $("[data-sheet-meta]").textContent = "For things you found yourself: a LinkedIn post, a lab page, a poster in the corridor.";
      $("[data-open-original]").hidden = true;
      fillEditForm(null);
      history.replaceState(null, "", "#new");
      showSheet();
      setTimeout(function () { editForm.title.focus(); }, 0);
    }

    function flushNote() {
      if (!currentId) return;
      var rows = getRows();
      var row = rows.filter(function (r) { return r.id === currentId; })[0];
      if (row && row.note !== noteEl.value) {
        row.note = noteEl.value;
        saveRows(rows);
        $("[data-note-status]").textContent = "Saved";
      }
    }

    noteEl.addEventListener("input", function () {
      $("[data-note-status]").textContent = "Saving…";
      clearTimeout(noteTimer);
      noteTimer = setTimeout(flushNote, 500);
    });

    $all('input[name="sheet-status"]').forEach(function (r) {
      r.addEventListener("change", function () {
        if (!currentId || !r.checked) return;
        setStatus(currentId, r.value);
        render();
        toast({ "new": "Marked as New", saved: "Saved for later", applied: "Marked as Applied", archived: "Archived" }[r.value]);
      });
    });

    editForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var err = $("[data-edit-error]");
      var title = editForm.title.value.trim();
      var url = editForm.url.value.trim();
      if (!title) { err.textContent = "Give it a title so you can find it later."; err.hidden = false; editForm.title.focus(); return; }
      if (url && !/^https?:\/\//i.test(url)) { err.textContent = "Links need to start with http:// or https://"; err.hidden = false; editForm.url.focus(); return; }
      err.hidden = true;

      var payload = {
        title: title.slice(0, 300),
        kind: editForm.kind.value,
        deadline: editForm.deadline.value || null,
        url: url,
        body: editForm.body.value
      };
      var rows = getRows();
      if (!currentId) {
        var row = Object.assign({ id: "manual-" + Date.now(), source: "manual", status: "saved", note: "", received_at: Date.now() }, payload);
        rows.push(row);
        saveRows(rows);
        closeSheet();
        toast("Signal added to Saved");
        return;
      }
      var target = rows.filter(function (r) { return r.id === currentId; })[0];
      Object.assign(target, payload);
      saveRows(rows);
      fillSheet(target);
      $("[data-edit-block]").open = false;
      render();
      toast("Changes saved");
    });

    $("[data-delete]").addEventListener("click", function () {
      $("[data-delete]").hidden = true;
      $("[data-confirm]").hidden = false;
      $("[data-confirm-no]").focus();
    });
    $("[data-confirm-no]").addEventListener("click", function () {
      $("[data-confirm]").hidden = true;
      $("[data-delete]").hidden = false;
    });
    $("[data-confirm-yes]").addEventListener("click", function () {
      var id = currentId;
      currentId = null; // nothing left to flush
      saveRows(getRows().filter(function (r) { return r.id !== id; }));
      closeSheet();
      toast("Signal deleted");
    });

    $("[data-sheet-close]").addEventListener("click", closeSheet);
    sheet.addEventListener("close", onClosed);
    // Tapping the dimmed area outside the panel closes it
    sheet.addEventListener("click", function (e) {
      if (e.target !== sheet) return;
      var box = sheet.getBoundingClientRect();
      var inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      if (!inside) closeSheet();
    });

    function openFromHash() {
      var h = location.hash;
      if (h.indexOf("#signal=") === 0) openSheet(decodeURIComponent(h.slice(8)));
      else if (h === "#new") openAdd();
    }

    /* ---------- automatic checks of your own sources ---------- */
    var SCH = window.SignalSchedule || null;
    var schedBar = $("[data-schedule]");
    var schedWasRunning = false;
    function syncSchedule() {
      if (!SCH || !schedBar) return;
      var st = SCH.status();
      schedBar.hidden = false;
      $("[data-schedule-text]", schedBar).textContent = SCH.describe(st);
      var now = $("[data-schedule-now]", schedBar);
      now.disabled = st.running || !st.sources;
      now.textContent = st.running ? "Checking…" : "Check now";
      // A check just finished: new rows and briefs are in storage.
      if (schedWasRunning && !st.running) render();
      schedWasRunning = st.running;
    }
    if (SCH && schedBar) {
      $("[data-schedule-now]", schedBar).addEventListener("click", function () {
        SCH.checkNow().then(function (r) {
          if (r && r.checked != null) toast(r.added ? "Added " + plural(r.added, "signal") + " from your sources" : "No new signals from your sources");
        });
        syncSchedule();
      });
      window.addEventListener("signal:schedule", syncSchedule);
      setInterval(syncSchedule, 30000);
      syncSchedule();
    }

    // Scores from the model change the list labels
    window.addEventListener("signal-ai-change", function (e) {
      if (run && e.detail && e.detail.what === "usage") return; // the run re-renders when it ends
      render();
      refreshOpenSheet();
    });

    render();
    openFromHash();
  }

  /* =====================================================================
     6. Shared helpers for page scripts loaded after this file (preferences.js)
  ===================================================================== */
  window.SignalApp = {
    getRows: getRows, getPrefs: getPrefs, savePrefs: savePrefs,
    getAppearance: getAppearance, setAppearance: setAppearance,
    describeMatch: describeMatch, esc: esc, plural: plural, toast: toast,
    updateNavCount: updateNavCount, ICONS: ICONS, $: $, $all: $all,
    clone: clone, syncRadios: syncRadios
  };

  /* =====================================================================
     Dispatch
  ===================================================================== */
  document.addEventListener("DOMContentLoaded", function () {
    var page = document.body.getAttribute("data-page");
    if (page !== "login" && !isAuthed()) { location.replace("login.html"); return; }
    initShell();
    if (page === "login") initLogin();
    if (page !== "login" && window.SignalSchedule) window.SignalSchedule.start();
    if (page === "inbox") initInbox();
    if (page === "preferences" && window.SignalPreferences) window.SignalPreferences.init();
  });
})();
