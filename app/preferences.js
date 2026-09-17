/* Signal demo console — Preferences page.
   Loaded after app.js, which exposes shared helpers on window.SignalApp and calls
   SignalPreferences.init() for data-page="preferences".

   Contents
   1. Draft state and the unsaved-changes bar
   2. Tag inputs (interests, boost, exclude, WikiCFP categories, Discord channels)
   3. Pickiness stops + live preview
   4. Sources (rows with their setup editors) and link lists
   5. Notifications and appearance
   6. Save / discard / reset
   7. Section index with scroll-spy */
(function () {
  "use strict";

  function init() {
    var A = window.SignalApp;
    var D = window.SignalData;
    var $ = A.$, $all = A.$all, esc = A.esc, plural = A.plural;

    var main = $(".prefs-main");
    var saved = A.getPrefs();
    var draft = A.clone(saved);

    /* =====================================================================
       1. Draft state
    ===================================================================== */
    function normalized(p) {
      return JSON.stringify({
        interests: p.interests, boost: p.boost, exclude: p.exclude, threshold: p.threshold,
        cfpCategories: p.cfpCategories, discordChannels: p.discordChannels, telegram: !!p.telegram,
        disabled: p.disabled.slice().sort(),
        feeds: p.feeds.filter(function (l) { return l.url || l.label; }),
        watch: p.watch.filter(function (l) { return l.url || l.label; })
      });
    }

    function changed() {
      $("[data-save-bar]").hidden = normalized(draft) === normalized(saved);
      renderPreview();
      renderSourceCounts();
    }

    /* =====================================================================
       2. Tag inputs — events are delegated from <main>, so boxes can be re-rendered freely
    ===================================================================== */
    var TAG_RULES = {
      discordChannels: { test: /^\d{5,25}$/, error: "Channel IDs are numbers only. In Discord, right-click a channel → Copy Channel ID." },
      cfpCategories: { lower: true }
    };

    function addTag(key, raw) {
      var value = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (!value) return true;
      var rule = TAG_RULES[key] || {};
      if (rule.lower) value = value.toLowerCase();
      var errEl = $('[data-tags-error="' + key + '"]');
      if (rule.test && !rule.test.test(value)) {
        if (errEl) { errEl.textContent = rule.error; errEl.hidden = false; }
        return false;
      }
      if (errEl) errEl.hidden = true;
      var exists = draft[key].some(function (t) { return t.toLowerCase() === value.toLowerCase(); });
      if (!exists) draft[key].push(value);
      return true;
    }

    function renderTags(key) {
      var box = $('[data-tags="' + key + '"]');
      if (!box) return;
      box.innerHTML = draft[key].map(function (t, i) {
        return '<span class="tag">' + esc(t) +
          '<button type="button" data-remove-tag="' + i + '" aria-label="Remove ' + esc(t) + '">' + A.ICONS.close + "</button></span>";
      }).join("") +
        '<input type="text" aria-label="' + esc(box.getAttribute("data-label")) + '" placeholder="' + esc(box.getAttribute("data-placeholder")) + '">';
      renderSuggestions(key);
      renderDisclosure();
    }

    function renderSuggestions(key) {
      var el = $('[data-suggest="' + key + '"]');
      if (!el) return;
      var have = draft[key].map(function (t) { return t.toLowerCase(); });
      var left = (D.SUGGESTIONS[key] || []).filter(function (s) { return have.indexOf(s.toLowerCase()) === -1; });
      el.innerHTML = left.length
        ? '<span class="suggestions-label">Try</span>' + left.map(function (s) {
            return '<button class="suggestion" type="button" data-suggestion="' + esc(s) + '" aria-label="Add ' + esc(s) + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>' + esc(s) + "</button>";
          }).join("")
        : "";
    }

    function tagBox(target) { return target.closest ? target.closest("[data-tags]") : null; }
    function refocus(box) { var i = $("input", box); if (i) i.focus(); }

    main.addEventListener("click", function (e) {
      var box = tagBox(e.target);
      if (box) {
        var key = box.getAttribute("data-tags");
        var rm = e.target.closest("[data-remove-tag]");
        if (rm) {
          draft[key].splice(Number(rm.getAttribute("data-remove-tag")), 1);
          renderTags(key); changed(); refocus(box);
          return;
        }
        if (e.target === box) refocus(box);
        return;
      }
      var sug = e.target.closest("[data-suggestion]");
      if (sug) {
        var skey = sug.closest("[data-suggest]").getAttribute("data-suggest");
        addTag(skey, sug.getAttribute("data-suggestion"));
        renderTags(skey); changed();
      }
    });

    main.addEventListener("keydown", function (e) {
      var box = tagBox(e.target);
      if (!box || e.target.tagName !== "INPUT") return;
      var key = box.getAttribute("data-tags");
      var input = e.target;
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        if (addTag(key, input.value)) { renderTags(key); changed(); refocus(box); }
      } else if (e.key === "Backspace" && !input.value && draft[key].length) {
        draft[key].pop();
        renderTags(key); changed(); refocus(box);
      }
    });

    // Pasting "a, b, c" adds all three
    main.addEventListener("paste", function (e) {
      var box = tagBox(e.target);
      if (!box) return;
      var text = (e.clipboardData || window.clipboardData).getData("text");
      if (!/[,\n]/.test(text)) return;
      e.preventDefault();
      var key = box.getAttribute("data-tags");
      text.split(/[,\n]/).forEach(function (t) { addTag(key, t); });
      renderTags(key); changed(); refocus(box);
    });

    // Typing a term and clicking away still keeps it
    main.addEventListener("focusout", function (e) {
      var box = tagBox(e.target);
      if (!box || e.target.tagName !== "INPUT" || !e.target.value.trim() || box.contains(e.relatedTarget)) return;
      var key = box.getAttribute("data-tags");
      if (addTag(key, e.target.value)) { renderTags(key); changed(); }
    });

    /* =====================================================================
       3. Pickiness + preview
    ===================================================================== */
    var stopsEl = $("[data-threshold-choices]");

    function renderThreshold() {
      stopsEl.innerHTML = D.THRESHOLDS.map(function (t) {
        return '<label class="stop">' +
          '<input type="radio" name="threshold" value="' + t.value + '"' + (draft.threshold === t.value ? " checked" : "") + ">" +
          '<span class="stop-dot" aria-hidden="true"></span>' +
          '<span class="stop-name">' + esc(t.name) + "</span>" +
          '<span class="stop-pts">' + t.value + "+ points</span>" +
        "</label>";
      }).join("");
      syncThreshold();
    }

    function syncThreshold() {
      var idx = 0;
      D.THRESHOLDS.forEach(function (t, i) { if (t.value === draft.threshold) idx = i; });
      $all(".stop", stopsEl).forEach(function (el, i) { el.classList.toggle("is-passed", i < idx); });
      $("[data-stops-fill]").style.width = (idx / (D.THRESHOLDS.length - 1) * 100) + "%";
      var t = D.THRESHOLDS[idx];
      $("[data-threshold-meaning]").innerHTML =
        '<span class="stops-meaning-name">' + esc(t.name) + "</span>" + esc(t.text) +
        (t.value === D.DEFAULT_PREFS.threshold ? ' <span class="chip">Default</span>' : "");
    }

    stopsEl.addEventListener("change", function (e) {
      if (e.target.name !== "threshold") return;
      draft.threshold = Number(e.target.value);
      syncThreshold();
      changed();
    });

    var MARKS = {
      on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
      off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 12h10"/></svg>',
      blocked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>'
    };

    function renderPreview() {
      var rows = A.getRows().map(function (r) { return { row: r, m: A.describeMatch(r, draft) }; });
      var notify = rows.filter(function (x) { return x.m.wouldNotify; }).length;
      var blocked = rows.filter(function (x) { return x.m.excluded; }).length;

      var sentence = "With these settings, " + notify + " of your " + plural(rows.length, "signal") + " would notify you." +
        (blocked ? " " + blocked + (blocked === 1 ? " is" : " are") + " blocked by Never show." : "");
      var summaryEl = $("[data-threshold-preview]");
      if (summaryEl.textContent !== sentence) summaryEl.textContent = sentence;

      rows.sort(function (a, b) {
        var an = a.m.wouldNotify ? 1 : 0, bn = b.m.wouldNotify ? 1 : 0;
        if (an !== bn) return bn - an;
        if (a.m.excluded !== b.m.excluded) return a.m.excluded ? 1 : -1;
        return b.m.score - a.m.score;
      });

      $("[data-preview-list]").innerHTML = rows.map(function (x) {
        var state = x.m.excluded ? "blocked" : x.m.wouldNotify ? "on" : "off";
        var spoken = { on: "Would notify: ", off: "Stays quiet: ", blocked: "Blocked: " }[state];
        var side = x.m.excluded
          ? '<span class="chip chip-warn">Blocked</span>'
          : (x.m.alwaysNotify ? '<span class="chip">Always</span>' : "") +
            '<span class="pv-score">' + plural(x.m.score, "pt", "pts") + "</span>";
        return '<li class="pv pv-' + state + '">' +
          '<span class="pv-mark">' + MARKS[state] + "</span>" +
          '<span class="pv-title"><span class="visually-hidden">' + spoken + "</span>" + esc(x.row.title) + "</span>" +
          '<span class="pv-kind">' + esc(D.KIND_LABELS[x.row.kind] || "Other") + "</span>" +
          '<span class="pv-side">' + side + "</span>" +
        "</li>";
      }).join("");
    }

    /* =====================================================================
       4. Sources
    ===================================================================== */
    var STATUS = {
      ready: { word: "Working", cls: "chip-good" },
      setup: { word: "Needs setup", cls: "chip-warn" },
      soon: { word: "Not available yet", cls: "" }
    };
    var CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    var hasSetup = { wikicfp: true, feeds: true, watch: true, discord: true };
    var open = {};
    var listEl = $("[data-source-list]");

    function setupSummary(id) {
      if (id === "wikicfp") return draft.cfpCategories.length ? plural(draft.cfpCategories.length, "category", "categories") : "No categories yet";
      if (id === "feeds") { var f = draft.feeds.filter(function (l) { return l.url.trim(); }).length; return f ? plural(f, "feed") : "No feeds yet"; }
      if (id === "watch") { var w = draft.watch.filter(function (l) { return l.url.trim(); }).length; return w ? plural(w, "page") : "No pages yet"; }
      if (id === "discord") return draft.discordChannels.length ? plural(draft.discordChannels.length, "channel") : "Every channel the bot can see";
      return "";
    }

    function renderSources() {
      var html = "";
      ["Inbound", "Hackathons", "Research"].forEach(function (group) {
        html += '<p class="group-label" id="grp-' + group + '">' + group + "</p>" +
          '<div class="group glass" role="group" aria-labelledby="grp-' + group + '">';
        D.SOURCES.filter(function (s) { return s.group === group; }).forEach(function (s) {
          var st = STATUS[s.status];
          html +=
            '<div class="src" data-src-row="' + s.id + '">' +
              '<div class="grow">' +
                '<i class="dot dot-' + s.status + '" aria-hidden="true"></i>' +
                '<div class="grow-text">' +
                  '<p class="grow-label"><span id="src-' + s.id + '">' + esc(s.label) + "</span>" +
                    '<span class="chip ' + st.cls + '">' + st.word + "</span></p>" +
                  '<p class="grow-help">' + esc(s.note) + "</p>" +
                  (hasSetup[s.id]
                    ? '<button class="disclose" type="button" data-disclose="' + s.id + '" aria-controls="setup-' + s.id + '">' +
                        CHEVRON + '<span data-disclose-text="' + s.id + '"></span></button>'
                    : "") +
                "</div>" +
                '<label class="switch"><input type="checkbox" data-source="' + s.id + '"' +
                  (s.status === "soon" ? " disabled" : "") + ' aria-labelledby="src-' + s.id + '"><span></span></label>' +
              "</div>" +
              (hasSetup[s.id] ? '<div class="src-setup" id="setup-' + s.id + '" data-setup-slot="' + s.id + '"></div>' : "") +
            "</div>";
        });
        html += "</div>";
      });
      listEl.innerHTML = html;

      // Move each setup editor into its source row
      $all("[data-setup-templates] [data-setup]").forEach(function (node) {
        var slot = $('[data-setup-slot="' + node.getAttribute("data-setup") + '"]');
        if (slot) slot.appendChild(node);
      });

      // Open by default when a source still needs something added
      open.wikicfp = !draft.cfpCategories.length;
      open.feeds = !draft.feeds.length;
      open.watch = !draft.watch.length;
      open.discord = !draft.discordChannels.length;
    }

    function syncSources() {
      D.SOURCES.forEach(function (s) {
        var input = $('[data-source="' + s.id + '"]');
        var on = draft.disabled.indexOf(s.id) === -1 && s.status !== "soon";
        input.checked = on;
        $('[data-src-row="' + s.id + '"]').classList.toggle("is-off", !on);
      });
      renderDisclosure();
      renderSourceCounts();
    }

    function renderDisclosure() {
      Object.keys(hasSetup).forEach(function (id) {
        var btn = $('[data-disclose="' + id + '"]');
        if (!btn) return;
        btn.setAttribute("aria-expanded", open[id] ? "true" : "false");
        $('[data-setup-slot="' + id + '"]').hidden = !open[id];
        var text = setupSummary(id);
        var el = $('[data-disclose-text="' + id + '"]');
        if (el.textContent !== text) el.textContent = text;
      });
    }

    function renderSourceCounts() {
      var enabled = D.SOURCES.filter(function (s) { return draft.disabled.indexOf(s.id) === -1; });
      var working = enabled.filter(function (s) { return s.status === "ready"; }).length;
      var setup = enabled.filter(function (s) { return s.status === "setup"; }).length;
      var text = "Watching " + working + " of " + D.SOURCES.length + (setup ? " · " + setup + (setup === 1 ? " needs" : " need") + " setup" : "");
      var el = $("[data-sources-count]");
      if (el.textContent !== text) el.textContent = text;
    }

    listEl.addEventListener("change", function (e) {
      var id = e.target.getAttribute("data-source");
      if (!id) return;
      draft.disabled = draft.disabled.filter(function (x) { return x !== id; });
      if (!e.target.checked) draft.disabled.push(id);
      $('[data-src-row="' + id + '"]').classList.toggle("is-off", !e.target.checked);
      changed();
    });

    listEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-disclose]");
      if (!btn) return;
      var id = btn.getAttribute("data-disclose");
      open[id] = !open[id];
      renderDisclosure();
    });

    /* ---------- feeds and watched pages ---------- */
    function renderLinks(key) {
      var el = $('[data-links="' + key + '"]');
      var noun = el.getAttribute("data-noun");
      el.innerHTML = draft[key].length
        ? draft[key].map(function (l, i) {
            return '<div class="link-row">' +
              '<input class="input" data-link-field="label" data-index="' + i + '" placeholder="Name, e.g. Research intern alerts" aria-label="' + noun + " " + (i + 1) + ' name" value="' + esc(l.label) + '">' +
              '<input class="input" type="url" data-link-field="url" data-index="' + i + '" placeholder="https://" aria-label="' + noun + " " + (i + 1) + ' link" value="' + esc(l.url) + '">' +
              '<button class="icon-button" type="button" data-remove-link="' + i + '" aria-label="Remove ' + noun + " " + (i + 1) + '">' + A.ICONS.close + "</button>" +
            "</div>";
          }).join("")
        : '<p class="link-empty">No ' + noun + "s yet.</p>";
      renderDisclosure();
    }

    function wireLinks(key) {
      var el = $('[data-links="' + key + '"]');
      el.addEventListener("input", function (e) {
        var i = e.target.getAttribute("data-index");
        if (i == null) return;
        draft[key][Number(i)][e.target.getAttribute("data-link-field")] = e.target.value;
        e.target.removeAttribute("aria-invalid");
        $('[data-links-error="' + key + '"]').hidden = true;
        renderDisclosure();
        changed();
      });
      el.addEventListener("click", function (e) {
        var rm = e.target.closest("[data-remove-link]");
        if (!rm) return;
        draft[key].splice(Number(rm.getAttribute("data-remove-link")), 1);
        renderLinks(key); changed();
      });
      $('[data-add-link="' + key + '"]').addEventListener("click", function () {
        draft[key].push({ label: "", url: "" });
        renderLinks(key); changed();
        var inputs = $all("input", el);
        inputs[inputs.length - 2].focus();
      });
    }

    /* =====================================================================
       5. Notifications and appearance
    ===================================================================== */
    var telegram = $("[data-telegram]");
    telegram.addEventListener("change", function () { draft.telegram = telegram.checked; changed(); });

    // Theme radios (name="appearance-mode") are wired by the shell in app.js.
    [["appearance-glass", "glass"], ["appearance-density", "density"]].forEach(function (pair) {
      $all('input[name="' + pair[0] + '"]').forEach(function (r) {
        r.addEventListener("change", function () {
          if (!r.checked) return;
          var patch = {}; patch[pair[1]] = r.value;
          A.setAppearance(patch);
        });
      });
    });

    /* =====================================================================
       6. Save / discard / reset
    ===================================================================== */
    function validLinks(key) {
      var bad = [];
      draft[key].forEach(function (l, i) {
        if (l.url.trim() && !/^https?:\/\/\S+\.\S+/i.test(l.url.trim())) bad.push(i);
      });
      var errEl = $('[data-links-error="' + key + '"]');
      if (!bad.length) return true;
      var id = key === "feeds" ? "feeds" : "watch";
      open[id] = true;
      renderDisclosure();
      bad.forEach(function (i) {
        var input = $('[data-links="' + key + '"] [data-link-field="url"][data-index="' + i + '"]');
        if (input) input.setAttribute("aria-invalid", "true");
      });
      errEl.textContent = "Links need to start with http:// or https://. Check " + plural(bad.length, "entry", "entries") + ".";
      errEl.hidden = false;
      return false;
    }

    function commit() {
      var feedsOk = validLinks("feeds");
      var watchOk = validLinks("watch");
      if (!feedsOk || !watchOk) {
        A.toast("Fix the highlighted links first");
        return;
      }
      ["feeds", "watch"].forEach(function (key) {
        draft[key] = draft[key]
          .filter(function (l) { return l.url.trim(); })
          .map(function (l) {
            var url = l.url.trim();
            var label = l.label.trim();
            if (!label) { try { label = new URL(url).hostname; } catch (e) { label = url; } }
            return { label: label.slice(0, 60), url: url };
          });
        renderLinks(key);
      });
      A.savePrefs(draft);
      saved = A.clone(draft);
      changed();
      A.updateNavCount();
      A.toast("Preferences saved");
    }

    function renderAll() {
      ["interests", "boost", "exclude", "cfpCategories", "discordChannels"].forEach(renderTags);
      $all("[data-tags-error], [data-links-error]").forEach(function (el) { el.hidden = true; });
      renderThreshold();
      renderLinks("feeds");
      renderLinks("watch");
      syncSources();
      telegram.checked = !!draft.telegram;
    }

    $("[data-save]").addEventListener("click", commit);
    $("[data-discard]").addEventListener("click", function () {
      draft = A.clone(saved);
      renderAll();
      changed();
      A.toast("Changes discarded");
    });
    $("[data-reset]").addEventListener("click", function () {
      if (!window.confirm("Reset interests, pickiness, sources and notifications to the defaults? Appearance is kept.")) return;
      draft = A.clone(D.DEFAULT_PREFS);
      A.savePrefs(draft);
      saved = A.clone(draft);
      renderAll();
      changed();
      A.updateNavCount();
      A.toast("Preferences reset");
    });

    window.addEventListener("beforeunload", function (e) {
      if (normalized(draft) === normalized(saved)) return;
      e.preventDefault();
      e.returnValue = "";
    });

    /* =====================================================================
       7. Section index with scroll-spy
    ===================================================================== */
    var indexEl = $("[data-index]");
    var sections = $all(".pset");
    var current = null;

    function setCurrent(id) {
      if (id === current) return;
      current = id;
      $all("[data-index-link]", indexEl).forEach(function (a) {
        var on = a.getAttribute("data-index-link") === id;
        if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
        // On phones the index is a scrolling row of pills: keep the current one in view
        if (on && indexEl.scrollWidth > indexEl.clientWidth + 1) {
          indexEl.scrollLeft = a.offsetLeft - (indexEl.clientWidth - a.offsetWidth) / 2;
        }
      });
    }

    function spy() {
      var line = Math.min(window.innerHeight * 0.3, 200);
      var id = sections[0].id;
      sections.forEach(function (s) { if (s.getBoundingClientRect().top <= line) id = s.id; });
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) id = sections[sections.length - 1].id;
      setCurrent(id);
    }

    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { ticking = false; spy(); });
    }, { passive: true });
    window.addEventListener("resize", spy);
    indexEl.addEventListener("click", function (e) {
      var a = e.target.closest("[data-index-link]");
      if (a) setCurrent(a.getAttribute("data-index-link"));
    });

    /* ---------- first render ---------- */
    renderSources();
    wireLinks("feeds");
    wireLinks("watch");
    renderAll();
    A.syncRadios("appearance-mode", A.getAppearance().mode);
    changed();
    spy();
  }

  window.SignalPreferences = { init: init };
})();
