/* Signal demo console — Preferences page.
   Loaded after app.js, which exposes shared helpers on window.SignalApp and calls
   SignalPreferences.init() for data-page="preferences".

   Contents
   1. Draft state and the unsaved-changes bar
   2. Tag inputs (interests, boost, exclude, WikiCFP categories, Discord channels)
   3. Pickiness stops + live preview
   4. Sources (rows with their setup editors) and link lists
   4b. Your sources — custom feeds, APIs and pages (app/sources.js), saved immediately
   5. Notifications and appearance
   6. Save / discard / reset
   7. Section index with scroll-spy */
(function () {
  "use strict";

  function init() {
    var A = window.SignalApp;
    var D = window.SignalData;
    var S = window.SignalSources;
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
      var custom = S ? S.list() : [];
      var customOn = custom.filter(function (c) { return c.enabled; }).length;
      var text = "Watching " + (working + customOn) + " of " + (D.SOURCES.length + custom.length) + (setup ? " · " + setup + (setup === 1 ? " needs" : " need") + " setup" : "");
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


    /* =====================================================================
       4b. Your sources — definitions live in app/sources.js and save immediately,
           like Appearance. Imported signals go straight into the Signals list.
    ===================================================================== */
    var customEl = $("[data-custom-sources]");
    var TYPE_ICONS = {
      rss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1.4" fill="currentColor"/></svg>',
      json: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4c-2 0-3 1-3 3v2.5C5 11 4 12 3 12c1 0 2 1 2 2.5V17c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2.5c0 1.5 1 2.5 2 2.5-1 0-2 1-2 2.5V17c0 2-1 3-3 3"/></svg>',
      page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 13h6M7 16h10"/></svg>',
      social: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>'
    };
    var removing = null; // id of the row showing its remove confirmation

    function ago(ts) {
      if (!ts) return "Not fetched yet";
      var mins = Math.round((Date.now() - ts) / 60000);
      if (mins < 1) return "Fetched just now";
      if (mins < 60) return "Fetched " + mins + " min ago";
      var hours = Math.round(mins / 60);
      if (hours < 24) return "Fetched " + plural(hours, "hour") + " ago";
      return "Fetched " + plural(Math.round(hours / 24), "day") + " ago";
    }

    function renderCustom() {
      if (!S) { customEl.hidden = true; return; }
      var list = S.list();
      var rows = list.map(function (c) {
        var t = S.typeInfo(c.type);
        var where = c.url ? S.hostOf(c.url) : "Pasted sample";
        var sid = "csrc-" + c.id.replace(/[^a-z0-9-]/gi, "-");
        var confirm = removing === c.id
          ? '<div class="csrc-confirm" role="group" aria-label="Remove ' + esc(c.name) + '">' +
              "<p>Remove " + esc(c.name) + "?" + (c.itemCount ? " Its " + plural(c.itemCount, "signal") + " can stay in Signals or go with it." : "") + "</p>" +
              '<div class="csrc-actions">' +
                '<button class="button button-quiet button-small" type="button" data-csrc="cancel-remove" data-id="' + esc(c.id) + '">Keep it</button>' +
                (c.itemCount ? '<button class="button button-secondary button-small" type="button" data-csrc="remove-keep" data-id="' + esc(c.id) + '">Remove source only</button>' : "") +
                '<button class="button button-danger button-small" type="button" data-csrc="remove-all" data-id="' + esc(c.id) + '">' + (c.itemCount ? "Remove with " + plural(c.itemCount, "signal") : "Remove") + "</button>" +
              "</div></div>"
          : "";
        return '<div class="src csrc' + (c.enabled ? "" : " is-off") + '" data-csrc-row="' + esc(c.id) + '">' +
          '<div class="grow">' +
            '<span class="tile tile-mint csrc-icon" aria-hidden="true">' + (TYPE_ICONS[c.type] || TYPE_ICONS.rss) + "</span>" +
            '<div class="grow-text">' +
              '<p class="grow-label"><i class="dot ' + (c.enabled ? "dot-ready" : "dot-soon") + '" aria-hidden="true"></i><span id="' + sid + '">' + esc(c.name) + "</span>" +
                '<span class="chip">' + esc(t.short) + "</span></p>" +
              '<p class="grow-help csrc-meta"><span>' + esc(where) + "</span><span>" + plural(c.itemCount, "signal") + "</span><span>" + esc(ago(c.lastFetched)) + "</span></p>" +
              '<div class="csrc-actions">' +
                '<button class="button button-secondary button-small" type="button" data-csrc="fetch" data-id="' + esc(c.id) + '">Fetch now</button>' +
                '<button class="button button-quiet button-small" type="button" data-csrc="edit" data-id="' + esc(c.id) + '">Edit</button>' +
                '<button class="button button-quiet button-small csrc-remove" type="button" data-csrc="remove" data-id="' + esc(c.id) + '">Remove</button>' +
              "</div>" +
            "</div>" +
            '<label class="switch"><input type="checkbox" data-csrc-toggle="' + esc(c.id) + '"' + (c.enabled ? " checked" : "") + ' aria-labelledby="' + sid + '"><span></span></label>' +
          "</div>" + confirm +
        "</div>";
      }).join("");

      customEl.innerHTML =
        '<div class="group-label-row"><p class="group-label" id="grp-custom">Your sources</p><p class="group-label-note">Saved as soon as you change them</p></div>' +
        '<div class="group glass" role="group" aria-labelledby="grp-custom">' +
          (rows || '<div class="grow csrc-empty"><div class="grow-text"><p class="grow-label">Nothing of your own yet</p>' +
            '<p class="grow-help">Add a feed, a JSON API, a page to watch, or a social feed URL. Only links you are allowed to read.</p></div></div>') +
          '<div class="grow csrc-add">' +
            '<button class="button button-secondary button-small" type="button" data-csrc="add">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>Add a source</button>' +
            '<p class="grow-help">RSS or Atom, JSON APIs, pages, or a social feed URL.</p>' +
          "</div>" +
        "</div>";
      renderSourceCounts();
    }

    function afterImport() {
      renderCustom();
      renderPreview();
      A.updateNavCount();
    }

    function importMessage(name, r) {
      if (r.added) return "Added " + plural(r.added, "signal") + " from " + name;
      if (r.duplicates) return "No new signals from " + name + ". " + plural(r.duplicates, "item") + " already in Signals.";
      return "Nothing to add from " + name + " yet";
    }

    customEl.addEventListener("change", function (e) {
      var id = e.target.getAttribute("data-csrc-toggle");
      if (!id) return;
      S.update(id, { enabled: e.target.checked });
      renderCustom();
      A.toast((e.target.checked ? "Turned on " : "Turned off ") + S.label(id));
    });

    customEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-csrc]");
      if (!btn) return;
      var action = btn.getAttribute("data-csrc");
      var id = btn.getAttribute("data-id");
      if (action === "add") return openEditor(null);
      if (action === "edit") return openEditor(id);
      if (action === "remove") { removing = id; renderCustom(); var k = $('[data-csrc="cancel-remove"]', customEl); if (k) k.focus(); return; }
      if (action === "cancel-remove") { removing = null; renderCustom(); return; }
      if (action === "remove-keep" || action === "remove-all") {
        var name = S.label(id);
        var r = S.remove(id, { removeRows: action === "remove-all" });
        removing = null;
        afterImport();
        A.toast("Removed " + name + (r.removedRows ? " and " + plural(r.removedRows, "signal") : ""));
        return;
      }
      if (action === "fetch") {
        var def = S.get(id);
        if (!def) return;
        btn.disabled = true;
        btn.textContent = "Fetching…";
        S.fetchPreview(def).then(function (res) {
          if (!res.ok) {
            renderCustom();
            if (res.corsBlocked) { openEditor(id, { cors: true }); return; }
            A.toast(def.name + ": " + res.error);
            return;
          }
          var r = S.importItems(id, res.items);
          afterImport();
          A.toast(importMessage(def.name, r));
        });
      }
    });

    /* ---------- the add / edit panel ---------- */
    var sheet = $("[data-src-sheet]");
    var form = $("[data-src-form]", sheet);
    var ed = { id: null, tested: null, busy: false };

    $("[data-src-preset-list]", sheet).innerHTML = S ? S.PRESETS.map(function (p) {
      return '<button class="preset" type="button" data-src-preset="' + p.id + '">' +
        '<span class="tile tile-sky" aria-hidden="true">' + TYPE_ICONS[p.def.type] + "</span>" +
        '<span class="preset-text"><span class="preset-name">' + esc(p.label) + "</span>" +
        '<span class="preset-help">' + esc(p.help) + " Works offline.</span></span></button>";
    }).join("") : "";

    $("[data-src-types]", sheet).innerHTML = S ? S.TYPES.map(function (t) {
      return '<label class="type-card"><input type="radio" name="src-type" value="' + t.id + '">' +
        '<span class="type-card-head"><span class="tile tile-mint" aria-hidden="true">' + TYPE_ICONS[t.id] + "</span>" +
        '<span class="type-name">' + esc(t.name) + "</span></span>" +
        '<span class="type-help">' + esc(t.help) + "</span></label>";
    }).join("") : "";

    var PASTE_LABELS = { rss: "Feed XML", social: "Feed XML", json: "JSON response", page: "Page HTML" };
    var URL_HOLDERS = { rss: "https://example.org/feed.xml", social: "https://your-rss-bridge.example/x/account", json: "https://api.example.org/opportunities", page: "https://example.org/fellowships" };

    function field(name) { return $('[data-src-field="' + name + '"]', sheet); }
    function checkedValue(name) { var r = $('input[name="' + name + '"]:checked', sheet); return r ? r.value : ""; }

    function readForm() {
      var mapping = {};
      $all("[data-map]", sheet).forEach(function (i) { mapping[i.getAttribute("data-map")] = i.value.trim(); });
      return {
        name: field("name").value.trim(),
        type: checkedValue("src-type") || "rss",
        mode: checkedValue("src-mode") || "fetch",
        url: (function () {
          // Accept "unstop.com" by assuming https://, and show the fixed link in the field.
          var el = field("url"), v = el.value.trim();
          if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s\/]+\.[^\s\/]+/.test(v)) { v = "https://" + v.replace(/^\/+/, ""); el.value = v; }
          return v;
        })(),
        sample: field("sample").value,
        mapping: mapping
      };
    }

    function fillForm(def) {
      field("name").value = def.name || "";
      field("url").value = def.url || "";
      field("sample").value = def.sample || "";
      A.syncRadios("src-type", def.type || "rss");
      A.syncRadios("src-mode", def.mode || "fetch");
      var m = def.mapping || {};
      $all("[data-map]", sheet).forEach(function (i) { i.value = m[i.getAttribute("data-map")] || ""; });
    }

    function syncForm() {
      var def = readForm();
      var paste = def.mode === "paste";
      $("[data-src-social-note]", sheet).hidden = def.type !== "social";
      $("[data-src-json]", sheet).hidden = def.type !== "json";
      $("[data-src-paste]", sheet).hidden = !paste;
      $("[data-src-paste-label]", sheet).textContent = PASTE_LABELS[def.type];
      $("[data-src-url-label]", sheet).textContent = paste ? "Link (optional, for your reference)" : "Link";
      field("url").placeholder = URL_HOLDERS[def.type];
      $("[data-src-ai]", sheet).hidden = !(S && S.hasAI());
    }

    function setError(text) {
      var el = $("[data-src-error]", sheet);
      el.textContent = text || "";
      el.hidden = !text;
    }
    function setMapStatus(text) { $("[data-src-map-status]", sheet).textContent = text || ""; }
    function showCors(on) {
      $("[data-src-cors]", sheet).hidden = !on;
      if (on) $("[data-src-cors-text]", sheet).textContent = S.CORS_MESSAGE;
    }

    function invalidate() {
      if (!ed.tested) return;
      ed.tested = null;
      var pv = $("[data-src-preview]", sheet);
      pv.classList.add("is-stale");
      $("[data-src-preview-summary]", sheet).textContent = "Changed since the last test. Press Test again.";
    }

    function openEditor(id, opts) {
      if (!S) return;
      opts = opts || {};
      ed = { id: id, tested: null, busy: false };
      var def = id ? S.get(id) : { name: "", type: "rss", mode: "fetch", url: "", sample: "", mapping: S.EMPTY_MAPPING };
      fillForm(def);
      if (opts.cors) A.syncRadios("src-mode", "paste");
      $("[data-src-title]", sheet).textContent = id ? "Edit " + def.name : "Add a source";
      $("[data-src-submit]", sheet).textContent = id ? "Save source" : "Add source";
      $("[data-src-presets]", sheet).hidden = !!id;
      $("[data-src-preview]", sheet).hidden = true;
      setError("");
      setMapStatus("");
      showCors(!!opts.cors);
      syncForm();
      if (typeof sheet.showModal === "function") { if (!sheet.open) sheet.showModal(); }
      else sheet.setAttribute("open", "");
      $("[data-src-title]", sheet).focus();
      $(".sheet-body", sheet).scrollTop = 0;
    }

    function closeEditor() {
      if (typeof sheet.close === "function" && sheet.open) sheet.close();
      else sheet.removeAttribute("open");
    }

    function validateDef(def) {
      if (!def.name) return { msg: "Give the source a name.", focus: field("name") };
      if (def.mode === "fetch" && !def.url) return { msg: "Add the link Signal should read.", focus: field("url") };
      if (def.url && !S.validUrl(def.url)) return { msg: "Links need to start with http:// or https://.", focus: field("url") };
      if (def.mode === "paste" && !def.sample.trim()) return { msg: "Paste a sample first.", focus: field("sample") };
      return null;
    }

    function renderEditorPreview(items) {
      var pv = $("[data-src-preview]", sheet);
      pv.hidden = false;
      pv.classList.remove("is-stale");
      var first = items.slice(0, 5);
      var notify = first.filter(function (it) { return A.describeMatch(it, draft).wouldNotify; }).length;
      $("[data-src-preview-summary]", sheet).textContent = items.length
        ? "Found " + plural(items.length, "item") + ". " + (items.length > 5 ? "Of the first 5, " : "") + notify + " would notify you with your current preferences."
        : "The source is readable but has no items right now.";
      $("[data-src-preview-list]", sheet).innerHTML = first.map(function (it) {
        var m = A.describeMatch(it, draft);
        var state = m.excluded ? "blocked" : m.wouldNotify ? "on" : "off";
        var spoken = { on: "Would notify: ", off: "Stays quiet: ", blocked: "Blocked: " }[state];
        return '<li class="pv pv-' + state + '">' +
          '<span class="pv-mark">' + MARKS[state] + "</span>" +
          '<span class="pv-main"><span class="pv-title"><span class="visually-hidden">' + spoken + "</span>" + esc(it.title) + "</span>" +
            '<span class="pv-sub">' + esc(D.KIND_LABELS[it.kind] || "Other") + (it.deadline ? ' · <span>Deadline ' + esc(it.deadline) + "</span>" : "") + "</span></span>" +
          '<span class="pv-side">' + (m.excluded ? '<span class="chip chip-warn">Blocked</span>'
            : (m.alwaysNotify ? '<span class="chip">Always</span>' : "") + '<span class="pv-score">' + plural(m.score, "pt", "pts") + "</span>") + "</span>" +
        "</li>";
      }).join("");
    }

    function runTest() {
      var def = readForm();
      var bad = validateDef(def);
      if (bad) { setError(bad.msg); bad.focus.focus(); return Promise.resolve(null); }
      setError("");
      showCors(false);
      var testBtn = $("[data-src-test]", sheet);
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
      return S.fetchPreview(def).then(function (res) {
        testBtn.disabled = false;
        testBtn.textContent = "Test";
        if (!res.ok) {
          if (res.corsBlocked) {
            showCors(true);
            A.syncRadios("src-mode", "paste");
            syncForm();
            field("sample").focus();
          } else {
            setError(res.error);
          }
          $("[data-src-preview]", sheet).hidden = true;
          return null;
        }
        ed.tested = { items: res.items, key: JSON.stringify(def) };
        renderEditorPreview(res.items);
        return ed.tested;
      });
    }

    function submit() {
      if (ed.busy) return;
      var def = readForm();
      var ready = ed.tested && ed.tested.key === JSON.stringify(def) ? Promise.resolve(ed.tested) : runTest();
      ed.busy = true;
      ready.then(function (tested) {
        ed.busy = false;
        if (!tested) return;
        var saved;
        try {
          saved = ed.id ? S.update(ed.id, def) : S.add(Object.assign({ enabled: true }, def));
        } catch (e) { setError(e.message); return; }
        var r = S.importItems(saved.id, tested.items);
        closeEditor();
        afterImport();
        if (ed.id) A.toast("Saved " + saved.name + (r.added ? ". Added " + plural(r.added, "signal") : ""));
        else A.toast(r.added ? "Added " + plural(r.added, "signal") + " from " + saved.name : "Added " + saved.name + ". No signals found yet");
      });
    }

    sheet.addEventListener("click", function (e) {
      if (e.target === sheet) return closeEditor(); // backdrop
      if (e.target.closest("[data-src-close]")) return closeEditor();
      if (e.target.closest("[data-src-test]")) return runTest();
      if (e.target.closest("[data-src-submit]")) return submit();
      var preset = e.target.closest("[data-src-preset]");
      if (preset) {
        var p = S.PRESETS.filter(function (x) { return x.id === preset.getAttribute("data-src-preset"); })[0];
        fillForm(p.def);
        syncForm();
        showCors(false);
        setError("");
        setMapStatus(p.def.type === "json" ? "Press Detect fields to fill the mapping." : "");
        invalidate();
        $("[data-src-preview]", sheet).hidden = true;
        return;
      }
      if (e.target.closest("[data-src-detect]")) {
        var text = readForm().sample;
        var detect = function (t) {
          try {
            var d = S.detectMapping(t);
            fillForm(Object.assign(readForm(), { mapping: d.mapping }));
            setMapStatus("Found a list of " + plural(d.count, "item") + " at " + (d.mapping.items || "the top level") + ". Check the fields, then press Test.");
            setError("");
            invalidate();
          } catch (err) { setMapStatus(""); setError(err.message); }
        };
        if (readForm().mode === "paste") return detect(text);
        setMapStatus("Reading the response…");
        // Fetch mode: read the raw response once to inspect it
        var def0 = readForm();
        if (!S.validUrl(def0.url)) { setMapStatus(""); setError("Enter a link that starts with http:// or https://."); return; }
        fetch(def0.url, { credentials: "omit" }).then(function (r) { return r.text(); }).then(detect).catch(function () {
          setMapStatus("");
          showCors(true);
          A.syncRadios("src-mode", "paste");
          syncForm();
        });
        return;
      }
      var aiBtn = e.target.closest("[data-src-ai]");
      if (aiBtn) {
        var sample = readForm().sample;
        if (readForm().mode !== "paste" || !sample.trim()) { setError("Paste a sample of the JSON first, so the model can see its fields."); return; }
        aiBtn.disabled = true;
        setMapStatus("Asking your model…");
        S.mapWithAI(sample).then(function (out) {
          fillForm(Object.assign(readForm(), { mapping: out.mapping }));
          setMapStatus("Proposed by " + (out.model || "your model") + (out.dropped.length ? ", minus " + out.dropped.join(", ") + " which didn't match the data" : "") + ". Check the fields, then press Test.");
          setError("");
          invalidate();
        }).catch(function (err) {
          setMapStatus("");
          setError(err && err.message ? err.message : "The model couldn't propose a mapping.");
        }).then(function () { aiBtn.disabled = false; });
      }
    });

    form.addEventListener("input", function () { setError(""); invalidate(); });
    form.addEventListener("change", function (e) {
      if (e.target.name === "src-type" || e.target.name === "src-mode") { syncForm(); showCors(false); invalidate(); }
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    sheet.addEventListener("close", function () { removing = null; });
    window.addEventListener("signal:sources", function () { if (!sheet.open) renderCustom(); });
    window.addEventListener("storage", function (e) { if (e.key === (S && S.KEY)) renderCustom(); });

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

    /* ---------- AI scoring and "Suggest my terms" (app/ai.js) ---------- */
    if (window.SignalAI) {
      window.SignalAI.mountSettings($("[data-ai-settings]"));
      window.SignalAI.mountSuggest($("[data-ai-suggest]"), {
        getPrefs: function () { return draft; },
        getRows: A.getRows,
        // Accepted suggestions go into the draft like typed terms; the user still presses Save.
        onApply: function (patch) {
          var added = 0;
          ["interests", "boost", "exclude", "cfpCategories"].forEach(function (key) {
            (patch[key] || []).forEach(function (term) {
              var before = draft[key].length;
              addTag(key, term);
              added += draft[key].length - before;
            });
            renderTags(key);
          });
          renderSources();
          changed();
          var queries = (patch.alertQueries || []).length;
          // One toast only: a second call would replace the first before anyone reads it.
          var msg = added ? plural(added, "term") + " added. Press Save to keep them." : "Those terms are already in your lists.";
          if (queries) msg += " Alert queries go into google.com/alerts; add the feed under Sources.";
          A.toast(msg);
        }
      });
    }

    /* ---------- first render ---------- */
    renderCustom();
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
