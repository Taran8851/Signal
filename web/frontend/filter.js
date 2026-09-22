/* Signal homepage interactions. Demo data is kept in one editable array. */
(function () {
  "use strict";

  var DEMO_OPPORTUNITIES = [
    { id: "unstop-1", source: "unstop", title: "Hack Devengers 2.0", body: "AI machine learning hackathon", deadline: "2026-09-18", received: 10 },
    { id: "unstop-2", source: "unstop", title: "PARANOVA", body: "student hackathon", deadline: "2026-09-14", received: 9 },
    { id: "mlh-1", source: "mlh", title: "Diamondhacks", body: "AI hackathon", deadline: "2027-04-04", received: 8 },
    { id: "mlh-2", source: "mlh", title: "MakeCU", body: "build and research hackathon", deadline: "2026-11-07", received: 7 },
    { id: "mlh-3", source: "mlh", title: "HackNex Season 2", body: "security hackathon", deadline: "2026-09-25", received: 6 },
    { id: "devpost-1", source: "devpost", title: "RoadStar Hackathon", body: "AI hackathon", deadline: "2026-09-13", received: 5 },
    { id: "wikicfp-1", source: "wikicfp", title: "ICDS 2026: Digital Sovereignty", body: "security research call for papers", deadline: "2026-08-31", received: 4 },
    { id: "wikicfp-2", source: "wikicfp", title: "ICAIIT 2027: Applied Innovations in IT", body: "AI research conference", deadline: "2027-01-10", received: 3 },
    { id: "wikicfp-3", source: "wikicfp", title: "9th AccML 2027: Accelerated Machine Learning", body: "machine learning research workshop", deadline: null, received: 2 },
    { id: "wikicfp-4", source: "wikicfp", title: "PCS 2027: Picture Coding Symposium", body: "computer vision research", deadline: null, received: 1 }
  ];

  function terms(value) {
    return value.split(",").map(function (term) { return term.trim().toLowerCase(); }).filter(Boolean);
  }

  /* Same matching as the real scorer (reference/signal/signals.ts, termRe): case-insensitive,
     letter/digit boundaries on both sides, optional plural ("s", "es", "'s").
     So "AI" does not fire on "said", "IoT" does not fire on "idiot",
     and "hackathon" still finds "hackathons". */
  function escapeRe(term) {
    return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function contains(text, term) {
    var re = new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(term) + "(?:s|es|'s)?(?![\\p{L}\\p{N}])", "iu");
    return re.test(text);
  }

  function score(item, interests, boost, exclude) {
    var total = 0;
    var excluded = exclude.some(function (term) {
      return contains(item.title, term) || contains(item.body, term);
    });

    interests.forEach(function (term) {
      if (contains(item.title, term)) total += 4;
      else if (contains(item.body, term)) total += 3;
    });

    boost.forEach(function (term) {
      if (contains(item.title, term) || contains(item.body, term)) total += 2;
    });

    return { score: total, excluded: excluded };
  }

  function updateDemo() {
    var sourceInputs = Array.prototype.slice.call(document.querySelectorAll("[data-source]"));
    var enabled = sourceInputs.filter(function (input) { return input.checked; }).map(function (input) { return input.value; });
    var interests = terms(document.querySelector("[data-interests]").value);
    var boost = terms(document.querySelector("[data-boost]").value);
    var exclude = terms(document.querySelector("[data-exclude]").value);
    var threshold = Number(document.querySelector('input[name="threshold"]:checked').value);
    var sort = document.querySelector('input[name="sort"]:checked').value;
    var list = document.querySelector("[data-opportunity-list]");

    var evaluated = DEMO_OPPORTUNITIES.map(function (item) {
      var result = score(item, interests, boost, exclude);
      return {
        item: item,
        score: result.score,
        visible: enabled.indexOf(item.source) !== -1 && !result.excluded && result.score >= threshold
      };
    });

    evaluated.sort(function (a, b) {
      if (sort === "score") return b.score - a.score || b.item.received - a.item.received;
      if (sort === "deadline") {
        if (!a.item.deadline) return 1;
        if (!b.item.deadline) return -1;
        return a.item.deadline.localeCompare(b.item.deadline);
      }
      return b.item.received - a.item.received;
    });

    evaluated.forEach(function (entry) {
      var row = document.querySelector('[data-id="' + entry.item.id + '"]');
      row.classList.toggle("is-filtered", !entry.visible);
      row.querySelector("[data-score]").textContent = entry.score;
      row.setAttribute("aria-label", entry.visible ? "Cleared filter" : "Filtered out");
      list.appendChild(row);
    });

    document.querySelector("[data-visible-count]").textContent = evaluated.filter(function (entry) { return entry.visible; }).length;
  }

  function animateCount(el) {
    var target = Number(el.getAttribute("data-count-to"));
    if (!target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var progress = Math.min((now - start) / 1800, 1);
      el.textContent = Math.round(target * progress);
      if (progress < 1) requestAnimationFrame(frame);
    }
    el.textContent = "0";
    requestAnimationFrame(frame);
  }

  function init() {
    document.querySelectorAll("[data-count-to]").forEach(animateCount);

    var demoControls = document.querySelectorAll("[data-source], [data-interests], [data-boost], [data-exclude], input[name='threshold'], input[name='sort']");
    demoControls.forEach(function (control) {
      control.addEventListener(control.type === "text" ? "input" : "change", updateDemo);
    });
    updateDemo();

    var close = document.querySelector("[data-close-announcement]");
    if (close) close.addEventListener("click", function () {
      document.getElementById("announcement").classList.add("is-hidden");
    });

    var form = document.querySelector("[data-preview-form]");
    if (form) form.addEventListener("submit", function (event) {
      event.preventDefault();
      form.querySelector("[data-form-status]").textContent = "UI preview only — no email was sent or stored.";
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
