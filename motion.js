/* Signal homepage motion layer: scroll reveals + pipeline draw-in.
   Additive to filter.js — this file never touches the filter widget's state.

   Visibility contract (DESIGN.md §5): the page is fully visible without this file. CSS only
   hides content under html.motion-ready, which is set here. IntersectionObserver always
   reports once for every observed element right after observe(); if that first report has
   not arrived within SAFETY_MS (a renderer that never runs observers), motion-ready is
   removed and everything shows. Once the observer is alive, reveals keep working for the
   whole visit. */
(function () {
  "use strict";

  var SAFETY_MS = 2500;
  var root = document.documentElement;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduced || !("IntersectionObserver" in window)) return; // no motion: nothing is ever hidden

  var observerAlive = false;
  root.classList.add("motion-ready");
  setTimeout(function () {
    if (!observerAlive) root.classList.remove("motion-ready");
  }, SAFETY_MS);

  /* ---- scroll reveals ------------------------------------------------- */
  var revealTargets = document.querySelectorAll(
    ".section-heading, .feature-card, .audience-grid > article, " +
    ".honesty-grid > article, .module-map > article, .faq-list > details, " +
    ".metric-number, .console-shell"
  );

  var io = new IntersectionObserver(
    function (entries) {
      observerAlive = true;
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.2, rootMargin: "0px 0px -80px 0px" }
  );

  revealTargets.forEach(function (el, i) {
    el.classList.add("reveal");
    el.style.setProperty("--reveal-delay", Math.min(i % 4, 3) * 0.08 + "s");
    io.observe(el);
  });

  /* ---- hero pipeline draw-in ------------------------------------------ */
  var pipeline = document.querySelector(".hero-pipeline");
  if (!pipeline) return;

  var lineGroups = pipeline.querySelectorAll(".pipeline-lines");
  lineGroups.forEach(function (svg) {
    svg.querySelectorAll("path").forEach(function (path) {
      path.style.setProperty("--len", path.getTotalLength());
    });
  });

  // Runs once on load — the hero is already in view, so this is a load
  // sequence rather than a scroll trigger. setTimeout alone (no rAF) so it
  // still fires in background tabs and headless renderers.
  setTimeout(function () {
    lineGroups.forEach(function (svg) { svg.classList.add("is-drawn"); });
    pipeline.classList.add("is-drawn");
  }, 150);
})();
