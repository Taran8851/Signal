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
    document.querySelectorAll(".demo-note").forEach(function (p) { p.textContent = "Everything stays on this laptop."; });
    document.querySelectorAll("[data-desktop-only]").forEach(function (el) { el.hidden = false; });
    syncTray();
  });
})(window);
