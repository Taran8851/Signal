/* Applies the saved appearance before the page paints, so there is no flash of the wrong
   theme. Loaded synchronously in <head>. app.js owns changing these later. */
(function () {
  "use strict";
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem("signal_demo_appearance") || "{}") || {}; } catch (e) {}
  var mode = saved.mode || "system";
  var dark = mode === "dark" ||
    (mode === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-glass", saved.glass || "frosted");
  root.setAttribute("data-density", saved.density || "comfortable");
})();
