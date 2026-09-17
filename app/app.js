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
    if (!Array.isArray(rows)) { rows = clone(D.RAW_ROWS); write(KEYS.rows, rows); }
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

  function sourceLabel(id) {
    if (id === "manual") return "Added by you";
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
    var rowsEl = $("[data-rows]");

    /* ---------- list ---------- */
    function visible(rows, prefs) {
      var q = state.q.trim().toLowerCase();
      return rows.map(function (r) { return { row: r, m: describeMatch(r, prefs), d: deadlineInfo(r.deadline) }; })
        .filter(function (x) {
          var r = x.row;
          // An excluded row belongs in Archived no matter what its stored status is.
          var status = x.m.excluded ? "archived" : r.status;
          if (state.status !== "all" && status !== state.status) return false;
          if (state.closingSoon && !(x.d && x.d.days >= 0 && x.d.days <= 7)) return false;
          if (state.kind && r.kind !== state.kind) return false;
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
          return b.row.received_at - a.row.received_at;
        });
    }

    /* When the user's model has scored a row (app/ai.js), show its relevance next to the keyword match. */
    function aiChip(r) {
      if (!window.SignalAI) return "";
      var label = window.SignalAI.scoreLabel(r, getPrefs());
      if (label.source !== "llm") return "";
      return '<span class="chip chip-ok" title="' + esc(label.reason || "Relevance from your model, 0 to 10") + '">' + esc(label.text) + "</span>";
    }

    function rowHtml(x) {
      var r = x.row, m = x.m, d = x.d;
      var saved = r.status === "saved";
      var archived = r.status === "archived" || m.excluded;
      return (
        '<article class="row' + (m.excluded ? " is-excluded" : "") + '">' +
          '<button class="row-open" type="button" data-open="' + esc(r.id) + '"><span class="visually-hidden">Open ' + esc(r.title) + "</span></button>" +
          '<div class="row-main">' +
            '<div class="row-top"><span class="chip">' + esc(kindLabel(r.kind)) + "</span>" +
              "<span>" + esc(sourceLabel(r.source)) + " · " + esc(timeAgo(r.received_at)) + "</span></div>" +
            '<h2 class="row-title">' + esc(r.title) + "</h2>" +
            '<p class="row-why">' + esc(shortWhy(m)) + "</p>" +
            (r.note ? '<p class="row-note">Note: ' + esc(r.note) + "</p>" : "") +
          "</div>" +
          '<div class="row-side">' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">' +
              (d ? '<span class="chip ' + d.cls + '">' + esc(d.text) + "</span>" : "") +
              '<span class="chip ' + m.level.cls + '" title="' + esc(m.score + " points") + '">' + esc(m.level.label) + "</span>" +
              aiChip(r) +
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
      $("[data-sources-summary]").innerHTML =
        "Watching " + working + " of " + D.SOURCES.length + " sources" +
        (setup ? ' · <a href="preferences.html#sources">' + plural(setup, "needs setup", "need setup").replace(/^\d+ /, setup + " ") + "</a>" : "");

      // The list
      var list = visible(rows, prefs);
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
      updateNavCount();
    }

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

      // AI relevance for this signal (app/ai.js): stored result, reasons, and "Ask the model"
      if (window.SignalAI) {
        if (insight) insight.destroy();
        insight = window.SignalAI.mountRowInsight($("[data-ai-insight]"), row, prefs);
      }
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

    // Scores from the model change the list labels
    window.addEventListener("signal-ai-change", function () { render(); });

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
    if (page === "inbox") initInbox();
    if (page === "preferences" && window.SignalPreferences) window.SignalPreferences.init();
  });
})();
