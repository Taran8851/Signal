/* Signal desktop bridge. Loaded first on every console page. Does nothing in a plain browser;
   inside the desktop app (Tauri, window.__TAURI__) it:
   - skips the demo sign-in (one person, their own laptop)
   - gives sources.js a fetcher that goes through the app (no CORS, no fetch helper; the app
     applies the helper's rules: public addresses only, robots.txt honoured)
   - drives the schedule from the app's 60 s tick, so checks run while the window is hidden
   - connects the tray (Check now, Pause checks) and sends a notification for new signals
     that would notify you, which opens the signal when clicked. */
(function (global) {
  "use strict";

  var T = global.__TAURI__;
  if (!T || !T.core || !T.event) return;
  var invoke = T.core.invoke;
  var listen = T.event.listen;

  // Desktop-only styles (app.css, "Desktop app"): no live blur, which stutters in WebKitGTK.
  document.documentElement.classList.add("is-desktop");
  try { localStorage.setItem("signal_demo_session", "1"); } catch (e) {}
  if (/login\.html$/.test(location.pathname)) { location.replace("research.html"); return; }

  // First run: send the user through setup once. setup.js writes signal_demo_setup on finish.
  var setupDone = false;
  try { setupDone = !!(JSON.parse(localStorage.getItem("signal_demo_setup") || "{}") || {}).done; } catch (e) {}
  // Insider builds: an install that finished setup before it had the invite step (an update over
  // the plain app) goes through setup once more, or the model and search never get set up.
  if (setupDone && global.SignalInsider) {
    try { setupDone = !!(JSON.parse(localStorage.getItem("signal_demo_setup") || "{}") || {}).insider; } catch (e) {}
  }
  if (!setupDone && !/setup\.html$/.test(location.pathname)) { location.replace("setup.html"); return; }

  // A fresh launch (sessionStorage is per run of the app): a check can't be running yet, so
  // drop any lock left by a check the app was quit in the middle of.
  try {
    if (!sessionStorage.getItem("signal_desktop_launched")) {
      sessionStorage.setItem("signal_desktop_launched", "1");
      var st = JSON.parse(localStorage.getItem("signal_demo_schedule_state") || "{}") || {};
      if (st.running) { delete st.running; localStorage.setItem("signal_demo_schedule_state", JSON.stringify(st)); }
    }
  } catch (e) {}

  var tickFns = [];
  global.SignalDesktop = {
    /* Same answer shape as the fetch helper: { ok, body, engine, error }. */
    fetch: function (def) {
      return invoke("fetch_url", {
        req: { url: String(def.url || "").trim(), method: def.method || "GET", body: def.body || "", accept: def.accept || "*/*", render: def.type === "page" }
      });
    },
    onTick: function (fn) { tickFns.push(fn); },
    /* Model API calls (ai.js) go through the app: no CORS, so any endpoint works. */
    modelPost: function (url, headers, body) {
      return invoke("model_request", { url: url, headers: headers || {}, body: body });
    }
  };

  listen("signal://tick", function () {
    tickFns.forEach(function (fn) { try { fn(); } catch (e) {} });
  });

  function schedule() { return global.SignalSchedule || null; }

  listen("signal://check-now", function () {
    if (schedule()) schedule().checkNow();
  });
  listen("signal://set-checks", function (e) {
    if (schedule()) schedule().saveSettings({ on: !!e.payload });
  });

  // Keep the tray's "Pause checks / Resume checks" label in step with Preferences.
  var lastOn = null;
  function syncTray() {
    var s = schedule();
    if (!s) return;
    var on = s.getSettings().on;
    if (on === lastOn) return;
    lastOn = on;
    invoke("set_checks_on", { on: on }).catch(function () {});
  }
  global.addEventListener("signal:schedule", syncTray);

  /* After a check: notify about new signals that clear your threshold (or always notify).
     A backfill (a source's first check) never reaches here: the scheduler stores it quietly. */
  global.addEventListener("signal:checked", function (e) {
    var A = global.SignalApp;
    var ids = (e.detail && e.detail.newIds) || [];
    if (!A || !ids.length) return;
    // Pressing Check now in the open window shows the result there already.
    if (e.detail.reason === "manual" && !document.hidden && document.hasFocus()) return;
    var wanted = {};
    ids.forEach(function (id) { wanted[id] = true; });
    var prefs = A.getPrefs();
    var hits = A.getRows().filter(function (r) { return wanted[r.id] && A.describeMatch(r, prefs).wouldNotify; });
    if (!hits.length) return;
    var label = function (r) {
      var D = global.SignalData;
      var src = D && D.SOURCES ? D.SOURCES.filter(function (s) { return s.id === r.source; })[0] : null;
      return r.title + (src ? " (" + src.label + ")" : "");
    };
    if (hits.length === 1) {
      invoke("notify", { title: "New signal", body: label(hits[0]), signalId: hits[0].id }).catch(function () {});
    } else {
      var body = hits.slice(0, 3).map(label).join("\n") + (hits.length > 3 ? "\nand " + (hits.length - 3) + " more" : "");
      invoke("notify", { title: hits.length + " new signals", body: body, signalId: null }).catch(function () {});
    }
  });

  listen("signal://open", function (e) {
    var id = e.payload;
    var target = "inbox.html" + (id ? "#signal=" + encodeURIComponent(id) : "");
    var onInbox = /inbox\.html$/.test(location.pathname);
    location.href = target;
    if (onInbox) location.reload();
  });

  // Web links open in the user's browser; the window itself only shows the console.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    invoke("open_external", { url: href }).catch(function () {});
  }, true);

  // Website-only parts of the shell: the link back to the landing page and "Log out".
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-logout]").forEach(function (b) { b.hidden = true; });
    document.querySelectorAll("a.brand").forEach(function (a) { a.setAttribute("href", "research.html"); });
    document.querySelectorAll(".demo-note").forEach(function (p) { p.textContent = "Everything stays on this device."; });
    document.querySelectorAll("[data-desktop-only]").forEach(function (el) { el.hidden = false; });
    syncTray();
    if (global.SignalInsider) addFeedback();
  });

  /* Insider builds: "Send feedback" goes to the gateway with the invite, and nowhere else. In the
     sidebar on desktop (hidden on phones, where the sidebar is the tab bar) and in Settings. */
  function addFeedback() {
    var INS = global.SignalInsider;
    var sheet = document.createElement("dialog");
    sheet.className = "sheet glass feedback-sheet";
    sheet.setAttribute("aria-labelledby", "feedback-title");
    sheet.innerHTML =
      '<form class="sheet-body" method="dialog">' +
      '<div class="sheet-head"><div class="sheet-head-text"><p class="sheet-kicker">' + (INS.name || "Signal") + '</p>' +
      '<h2 class="sheet-title" id="feedback-title" tabindex="-1">Send feedback</h2></div></div>' +
      '<div class="field"><label class="field-label" for="feedback-text">What worked, what didn\'t, what you wanted it to do</label>' +
      '<textarea class="textarea" id="feedback-text" rows="6" maxlength="4000" data-feedback-text></textarea></div>' +
      '<p class="grow-help" data-feedback-status aria-live="polite">Goes to the Signal team with the app version and this page. Nothing else is sent.</p>' +
      '<div class="sheet-foot"><button class="button button-quiet" type="button" data-feedback-cancel>Cancel</button>' +
      '<button class="button button-primary" type="submit">Send</button></div></form>';
    document.body.appendChild(sheet);
    var text = sheet.querySelector("[data-feedback-text]"), status = sheet.querySelector("[data-feedback-status]");
    var help = status.textContent;
    function open() { status.textContent = help; sheet.showModal(); text.focus(); }
    sheet.querySelector("[data-feedback-cancel]").addEventListener("click", function () { sheet.close(); });
    sheet.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      var body = text.value.trim();
      if (!body) { status.textContent = "Write something first."; return; }
      var token = "";
      try { token = localStorage.getItem("signal_demo_ai_key") || ""; } catch (err) {}
      if (!/^sig-/.test(token)) { status.textContent = "Enter your invite in setup first (Settings → Run setup again)."; return; }
      status.textContent = "Sending…";
      var version = T.app && T.app.getVersion ? T.app.getVersion() : Promise.resolve("");
      version.catch(function () { return ""; }).then(function (v) {
        var page = (location.pathname.split("/").pop() || "").replace(".html", "");
        return invoke("model_request", { url: INS.gateway + "/feedback",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ text: body, version: v, page: page }) });
      }).then(function (r) {
        if (r.status !== 200) throw new Error("status " + r.status);
        text.value = "";
        sheet.close();
        if (global.SignalApp && global.SignalApp.toast) global.SignalApp.toast("Thanks. Your feedback was sent.");
      }).catch(function () { status.textContent = "It couldn't be sent. Check your connection and try again."; });
    });

    var foot = document.querySelector(".sidebar-foot");
    if (foot) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "button button-quiet button-small feedback-open";
      b.textContent = "Send feedback";
      b.addEventListener("click", open);
      foot.insertBefore(b, foot.firstChild);
    }
    var reset = document.querySelector(".reset-group");
    if (reset) {
      var row = document.createElement("div");
      row.className = "grow";
      row.innerHTML = '<div class="grow-text"><p class="grow-label">Send feedback</p>' +
        '<p class="grow-help">Tell the Signal team what worked and what didn\'t.</p></div>';
      var rb = document.createElement("button");
      rb.type = "button";
      rb.className = "button button-secondary button-small";
      rb.textContent = "Write feedback";
      rb.addEventListener("click", open);
      row.appendChild(rb);
      reset.insertBefore(row, reset.firstChild);
    }
  }
})(window);
