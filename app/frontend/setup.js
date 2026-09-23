/* First-run setup. Writes the same keys Settings writes — no setup-only settings:
     signal_demo_prefs     { interests, boost, exclude, threshold, disabled, cfpCategories,
                             feeds, watch, … }                                    (app-data.js DEFAULT_PREFS)
     signal_demo_schedule  { on, every, brief }                                    (scheduler.js DEFAULTS)
     signal_demo_ai        { provider, model, baseUrl, localBaseUrl, mode, … }     (ai.js DEFAULT_SETTINGS)
     signal_demo_ai_key    the key, a plain string                                 (ai.js setKey)
     signal_demo_profile   { cv, facts, about }                                    (profile.js save)
     search settings       the Firecrawl key, in the app's own file                (search.rs, desktop only)
     signal_demo_setup     { done, at }                                            (this file only)

   Order: welcome, model, about you, topics, sources, pickiness. The model comes first so the
   topics step can suggest words from the profile (SignalAI.suggestFromDescription) instead of
   starting from a blank keyword box. The model step also asks what the model may spend calls
   on (scoring mode, briefs), so connecting one never turns on spending silently.
   Suggested words are never applied on their own: each one is added or dismissed. */
(function (global) {
  "use strict";

  var D = global.SignalData;
  var AI = global.SignalAI;
  var P = global.SignalProfile;
  var core = global.__TAURI__ && global.__TAURI__.core ? global.__TAURI__.core : null;
  /* Insider builds (insider-config.js): the model and search come from Signal's gateway, unlocked
     with an invite code. The gateway holds the keys; the app only ever has the invite. */
  var INS = global.SignalInsider || null;
  var KEYS = {
    prefs: "signal_demo_prefs",
    schedule: "signal_demo_schedule",
    ai: "signal_demo_ai",
    aiKey: "signal_demo_ai_key",
    setup: "signal_demo_setup"
  };

  /* Model providers, matching ai.js PROVIDERS. Kept to what setup needs: a label, whether it
     takes an address, and a default model. */
  var MODEL_PROVIDERS = [
    { id: "anthropic", label: "Anthropic", model: "claude-haiku-4-5", baseUrl: null,
      hint: "Starts with sk-ant-. Stored on this device, sent only to Anthropic." },
    { id: "openai-compatible", label: "OpenAI-compatible endpoint", model: "", baseUrl: "https://api.openai.com/v1",
      hint: "Sent as a Bearer token to the address above." },
    { id: "local", label: "Local (Ollama, LM Studio)", model: "", baseUrl: "http://127.0.0.1:11434/v1",
      hint: "A local server usually needs no key. Leave it empty if yours doesn't." }
  ];

  /* Scoring modes, as ai.js runs them (shouldCallLLM). Keyword scoring is always computed. */
  var MODES = [
    { id: "keyword", n: "Words", text: "Your words decide. The model is used only when you ask it something.", tag: "no calls" },
    { id: "hybrid", n: "Hybrid", text: "Your words first; only what matches at least one of them goes to the model.", tag: "a few calls" },
    { id: "llm", n: "Model", text: "Every new opportunity that isn't ruled out goes to the model.", tag: "most calls" }
  ];

  /* Threshold values and what they actually mean, from the scoring rules:
     interests +4 in title / +3 in body, boost +2 anywhere. */
  var THRESHOLDS = [
    { n: 2, text: "Anything one of your boost words touches.", tag: "widest" },
    { n: 3, text: "One topic word anywhere in it.", tag: "default" },
    { n: 4, text: "A topic word in the title.", tag: "" },
    { n: 6, text: "A topic word in the title, plus a boost word.", tag: "strictest" }
  ];

  var EVERY = [15, 30, 60, 180];

  /* One-click starting points. Nothing is applied until the user clicks one. */
  var STARTERS = [
    { label: "CS / AI", interests: ["AI", "machine learning", "security"], boost: ["hackathon", "open source", "internship"] },
    { label: "Biology / lab", interests: ["biology", "genomics", "neuroscience"], boost: ["research", "fellowship", "summer programme"] },
    { label: "Design", interests: ["design", "UI", "human-computer interaction"], boost: ["portfolio", "studio", "internship"] },
    { label: "Policy / economics", interests: ["policy", "economics", "climate"], boost: ["fellowship", "research", "essay"] }
  ];

  var MAX_DESCRIPTION = 5800;       /* ai.js refuses descriptions over 6000 characters */
  var URL_RE = /^https?:\/\/\S+\.\S+/i;

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function has(list, term) {
    return list.some(function (t) { return t.toLowerCase() === term.toLowerCase(); });
  }
  function $(sel) { return document.querySelector(sel); }

  /* Setup 0.2.2 stored the key JSON-encoded ("\"sk-…\""), which ai.js sends quotes and all.
     Unwrap a key saved that way. */
  try {
    var rawKey = localStorage.getItem(KEYS.aiKey);
    if (rawKey && rawKey.charAt(0) === '"' && rawKey.charAt(rawKey.length - 1) === '"') {
      localStorage.setItem(KEYS.aiKey, JSON.parse(rawKey));
    }
  } catch (e) {}

  /* ---------- state: starts from whatever is already stored ---------- */
  var defaults = (D && D.DEFAULT_PREFS) || { interests: [], boost: [], exclude: [], threshold: 3, disabled: [] };
  var stored = read(KEYS.prefs, null) || {};
  function urls(list) {
    return (list || []).map(function (x) { return typeof x === "string" ? x : x && x.url; }).filter(Boolean);
  }
  var storedAI = read(KEYS.ai, null);
  var state = {
    interests: (stored.interests || []).slice(),
    boost: (stored.boost || []).slice(),
    exclude: (stored.exclude || []).slice(),
    cfpCategories: (stored.cfpCategories || []).slice(),      /* no CS defaults for a first run */
    feeds: urls(stored.feeds),
    watch: urls(stored.watch),
    threshold: stored.threshold || 3,
    disabled: (stored.disabled || []).slice(),
    schedule: read(KEYS.schedule, { on: true, every: 30, brief: true }),
    mode: storedAI && storedAI.mode ? storedAI.mode : "hybrid"
  };

  var STEP_MODEL = 1, STEP_ABOUT = 2, STEP_TOPICS = 3;
  var STEPS = 6;
  var step = 0;
  var modelReady = false;          /* true once a model answered the connection test */
  var steps = [].slice.call(document.querySelectorAll("[data-step]"));
  var stepCount = $("[data-step-count]");
  var backBtn = $("[data-back]");
  var skipBtn = $("[data-skip]");
  var nextBtn = $("[data-next]");
  var topicsNote = $("[data-topics-note]");
  var urlNote = $("[data-url-note]");

  /* ---------- chip inputs (terms, and links for feeds / watch) ---------- */
  function tagBox(box) {
    var field = box.getAttribute("data-tags");
    var isUrl = box.hasAttribute("data-url");
    var input = el("input");
    input.type = isUrl ? "url" : "text";
    input.placeholder = box.getAttribute("data-placeholder") || "";
    input.setAttribute("aria-label", box.getAttribute("data-placeholder") || field);

    function render() {
      [].slice.call(box.querySelectorAll(".chip")).forEach(function (c) { box.removeChild(c); });
      state[field].forEach(function (term, i) {
        var chip = el("span", "chip");
        chip.appendChild(el("span", null, term));
        var x = el("button", null, "×");
        x.type = "button";
        x.setAttribute("aria-label", "Remove " + term);
        x.addEventListener("click", function () {
          state[field].splice(i, 1);
          render();
          validate();
        });
        chip.appendChild(x);
        box.insertBefore(chip, input);
      });
    }

    function add(raw) {
      var bad = false;
      String(raw).split(isUrl ? /\s+/ : ",").forEach(function (part) {
        var term = part.trim();
        if (!term) return;
        if (isUrl && !URL_RE.test(term)) { bad = true; return; }
        if (!has(state[field], term)) state[field].push(term);
      });
      if (isUrl && urlNote) urlNote.hidden = !bad;
      input.value = bad ? raw.trim() : "";
      render();
      validate();
    }

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || (!isUrl && e.key === ",")) { e.preventDefault(); add(input.value); }
      else if (e.key === "Backspace" && !input.value && state[field].length) {
        state[field].pop(); render(); validate();
      }
    });
    input.addEventListener("blur", function () { if (input.value.trim()) add(input.value); });
    box.addEventListener("click", function (e) { if (e.target === box) input.focus(); });

    box.appendChild(input);
    render();
    return { render: render };
  }

  var boxes = {};
  [].slice.call(document.querySelectorAll("[data-tags]")).forEach(function (box) {
    boxes[box.getAttribute("data-tags")] = tagBox(box);
  });

  /* ---------- starters ---------- */
  var startersWrap = $("[data-starters]");
  STARTERS.forEach(function (s) {
    var b = el("button", "button button-secondary button-small", s.label);
    b.type = "button";
    b.addEventListener("click", function () {
      s.interests.forEach(function (t) { if (!has(state.interests, t)) state.interests.push(t); });
      s.boost.forEach(function (t) { if (!has(state.boost, t)) state.boost.push(t); });
      boxes.interests.render();
      boxes.boost.render();
      validate();
    });
    startersWrap.appendChild(b);
  });

  /* ---------- radio lists (mode, threshold) ---------- */
  function radios(wrap, name, items, isChecked, onPick) {
    items.forEach(function (t) {
      var label = el("label");
      var input = el("input");
      input.type = "radio";
      input.name = name;
      input.value = String(t.id || t.n);
      input.checked = isChecked(t);
      input.addEventListener("change", function () { onPick(t); });
      var span = el("span");
      span.appendChild(el("span", "choice-n", String(t.n)));
      var text = el("span", "choice-text", t.text);
      if (t.tag) text.appendChild(el("span", "choice-tag", "(" + t.tag + ")"));
      span.appendChild(text);
      label.appendChild(input);
      label.appendChild(span);
      wrap.appendChild(label);
    });
  }

  var briefLine = $("[data-brief-line]");
  var briefInput = $("[data-brief]");
  briefInput.checked = state.schedule.brief !== false;
  briefInput.addEventListener("change", function () { state.schedule.brief = briefInput.checked; });
  function syncBrief() { briefLine.hidden = state.mode === "keyword"; }
  radios($("[data-mode]"), "mode", MODES, function (m) { return m.id === state.mode; },
    function (m) { state.mode = m.id; syncBrief(); });
  syncBrief();

  radios($("[data-threshold]"), "threshold", THRESHOLDS, function (t) { return state.threshold === t.n; },
    function (t) { state.threshold = t.n; });

  /* ---------- sources ---------- */
  var sourcesWrap = $("[data-sources]");
  var lastGroup = null;
  ((D && D.SOURCES) || []).forEach(function (s) {
    if (s.group !== lastGroup) {
      sourcesWrap.appendChild(el("p", "source-group", s.group));
      lastGroup = s.group;
    }
    var row = el("div", "source");
    var text = el("div");
    text.appendChild(el("p", "source-label", s.label));       /* label verbatim, never paraphrased */
    text.appendChild(el("p", "source-note", s.note || ""));
    row.appendChild(text);

    var wrap = el("label", "switch");
    var input = el("input");
    input.type = "checkbox";
    input.checked = s.status !== "soon" && state.disabled.indexOf(s.id) === -1;
    input.disabled = s.status === "soon";                      /* not available yet: shown, never hidden */
    input.setAttribute("aria-label", s.label);
    input.addEventListener("change", function () {
      var i = state.disabled.indexOf(s.id);
      if (input.checked && i !== -1) state.disabled.splice(i, 1);
      else if (!input.checked && i === -1) state.disabled.push(s.id);
      row.setAttribute("data-off", input.checked ? "0" : "1");
    });
    wrap.appendChild(input);
    wrap.appendChild(el("span"));
    row.appendChild(wrap);
    if (!input.checked) row.setAttribute("data-off", "1");
    sourcesWrap.appendChild(row);
  });

  /* ---------- schedule ---------- */
  var everyWrap = $("[data-every]");
  EVERY.forEach(function (m) {
    var label = el("label");
    var input = el("input");
    input.type = "radio";
    input.name = "every";
    input.value = String(m);
    input.checked = Number(state.schedule.every) === m;
    input.addEventListener("change", function () { state.schedule.every = m; });
    label.appendChild(input);
    label.appendChild(el("span", null, m < 60 ? m + " minutes" : (m / 60) + (m === 60 ? " hour" : " hours")));
    everyWrap.appendChild(label);
  });

  var scheduleOn = $("[data-schedule-on]");
  scheduleOn.checked = state.schedule.on !== false;
  scheduleOn.addEventListener("change", function () { state.schedule.on = scheduleOn.checked; });

  /* ---------- model ---------- */
  var providerSel = $("[data-provider]");
  var modelInput = $("[data-model]");
  var baseUrlField = $("[data-baseurl-field]");
  var baseUrlInput = $("[data-baseurl]");
  var keyInput = $("[data-key]");
  var keyHint = $("[data-key-hint]");
  var modelStatus = $("[data-model-status]");
  var modelStatusDefault = modelStatus.textContent;

  MODEL_PROVIDERS.forEach(function (p) {
    var o = el("option", null, p.label);
    o.value = p.id;
    providerSel.appendChild(o);
  });

  function provider() {
    return MODEL_PROVIDERS.filter(function (p) { return p.id === providerSel.value; })[0] || MODEL_PROVIDERS[0];
  }
  function syncProvider() {
    var p = provider();
    modelInput.value = p.model;
    modelInput.placeholder = p.model || "Model name";
    baseUrlField.hidden = !p.baseUrl;
    baseUrlInput.value = p.baseUrl || "";
    keyHint.textContent = p.hint;
  }
  providerSel.addEventListener("change", syncProvider);
  syncProvider();

  /* A model already stored (setup run again): show it, and keep its key unless a new one is pasted. */
  if (AI && AI.hasKey() && storedAI) {
    providerSel.value = storedAI.provider || providerSel.value;
    syncProvider();
    if (storedAI.model) modelInput.value = storedAI.model;
    if (storedAI.provider === "openai-compatible" && storedAI.baseUrl) baseUrlInput.value = storedAI.baseUrl;
    if (storedAI.provider === "local" && storedAI.localBaseUrl) baseUrlInput.value = storedAI.localBaseUrl;
    keyInput.placeholder = "Key saved (" + AI.maskedKey() + "). Paste a new one to replace it.";
  }

  /* Saves the model choice so ai.js can use it. Returns false when nothing usable was entered. */
  function saveModel() {
    var p = provider();
    var key = keyInput.value.trim();
    if (!key && p.id !== "local" && !AI.hasKey()) return false;
    var ai = read(KEYS.ai, null) || {};
    ai.provider = p.id;
    ai.model = modelInput.value.trim() || p.model;
    if (p.id === "openai-compatible") ai.baseUrl = baseUrlInput.value.trim() || p.baseUrl;
    if (p.id === "local") ai.localBaseUrl = baseUrlInput.value.trim() || p.baseUrl;
    ai.mode = state.mode;
    write(KEYS.ai, ai);
    if (key) AI.setKey(key);                           /* plain string, as ai.js reads it — not JSON */
    return true;
  }

  /* Firecrawl (desktop only). The app never hands keys back, only whether one is set. */
  var fcField = $("[data-firecrawl-field]");
  var fcInput = $("[data-firecrawl]");
  var fcProviders = null;
  if (core) {
    core.invoke("search_settings").then(function (s) {
      fcProviders = s.providers || [];
      fcField.hidden = false;
      var set = fcProviders.some(function (p) { return /^firecrawl/.test(p.id) && p.hasKey; });
      if (set) {
        $("[data-firecrawl-help]").textContent = "Firecrawl is already set up. Paste a key only to replace the cloud one.";
        fcInput.placeholder = "Key saved";
      }
    }, function () {});
  }
  function saveFirecrawl() {
    var key = fcInput.value.trim();
    if (!core || !fcProviders || !key) return Promise.resolve();
    var list = fcProviders.map(function (p) {
      return { id: p.id, on: p.id === "firecrawl" ? true : p.on, perDay: p.perDay,
               key: p.id === "firecrawl" ? key : null, url: null };
    });
    return core.invoke("save_search_settings", { providers: list, stealth: null }).then(function () {
      fcInput.value = "";
    });
  }

  /* ---------- insider: invite code ---------- */
  var inviteField = $("[data-invite-field]");
  var inviteInput = $("[data-invite]");
  function deviceId() {
    var id = null;
    try { id = localStorage.getItem("signal_insider_device"); } catch (e) {}
    if (!id) {
      var b = new Uint8Array(12);
      global.crypto.getRandomValues(b);
      id = "dev-" + Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      try { localStorage.setItem("signal_insider_device", id); } catch (e) {}
    }
    return id;
  }
  function gatewayPost(route, token, body) {
    var headers = { "content-type": "application/json", authorization: "Bearer " + token };
    var send = global.SignalDesktop && global.SignalDesktop.modelPost
      ? global.SignalDesktop.modelPost(INS.gateway + route, headers, JSON.stringify(body || {}))
      : fetch(INS.gateway + route, { method: "POST", headers: headers, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); });
    return send.then(function (r) {
      var j = {};
      try { j = JSON.parse(r.text); } catch (e) {}
      if (r.status !== 200) throw new Error((j.error && j.error.message) || "Signal's server answered " + r.status + ".");
      return j;
    });
  }
  function connectInsider() {
    var code = inviteInput.value.trim().toLowerCase();
    if (!/^sig-[0-9a-f]{12}$/.test(code)) {
      modelStatus.textContent = "An invite code looks like sig- followed by 12 letters and numbers.";
      return;
    }
    var token = code + "." + deviceId();
    nextBtn.disabled = true;
    modelStatus.textContent = "Checking your invite…";
    gatewayPost("/activate", token).then(function (r) {
      var ai = read(KEYS.ai, null) || {};
      ai.provider = "openai-compatible";
      ai.baseUrl = INS.gateway + "/v1";
      ai.model = r.model || INS.model;
      ai.mode = state.mode;
      write(KEYS.ai, ai);
      AI.setKey(token);
      if (!core) return r;
      // Search and page reads: the gateway stands in for "Firecrawl (your server)", tried first.
      return core.invoke("search_settings").then(function (sset) {
        var list = (sset.providers || []).map(function (p) {
          var own = p.id === "firecrawl_self";
          return { id: p.id, on: own, perDay: own ? 1000 : p.perDay, key: own ? token : null, url: own ? INS.gateway + "/firecrawl" : null };
        }).sort(function (a, b) { return (b.id === "firecrawl_self") - (a.id === "firecrawl_self"); });
        return core.invoke("save_search_settings", { providers: list, stealth: null });
      }).then(function () { return r; });
    }).then(function (r) {
      modelReady = true;
      modelStatus.textContent = "You're in" + (r.name ? ", " + r.name : "") + ". This invite is on " + r.devices + " of " + r.maxDevices + " devices.";
      show(STEP_ABOUT);
    }, function (err) {
      modelReady = false;
      modelStatus.textContent = (err && err.message) || "Signal's server couldn't be reached.";
    }).then(function () { nextBtn.disabled = false; });
  }

  /* Next on the model step: save, then check the model answers before moving on. A failure
     puts back whatever was stored before, so skipping leaves no half-working model behind. */
  function connectModel() {
    if (INS) return connectInsider();
    var before = { ai: localStorage.getItem(KEYS.ai), key: localStorage.getItem(KEYS.aiKey) };
    var fc = saveFirecrawl().catch(function () {
      modelStatus.textContent = "The Firecrawl key couldn't be saved. Add it later in Settings → Search & reading.";
    });
    if (!saveModel()) {
      fc.then(function () { modelStatus.textContent = "Paste a key, or choose Skip for now."; });
      return;
    }
    nextBtn.disabled = true;
    modelStatus.textContent = "Checking the model answers…";
    AI.testConnection().then(function (r) {
      modelReady = true;
      modelStatus.textContent = "Connected to " + (r.model || AI.getSettings().model) + ".";
      show(STEP_ABOUT);
    }, function (err) {
      modelReady = false;
      try {
        if (before.ai == null) localStorage.removeItem(KEYS.ai); else localStorage.setItem(KEYS.ai, before.ai);
        if (before.key == null) localStorage.removeItem(KEYS.aiKey); else localStorage.setItem(KEYS.aiKey, before.key);
      } catch (e) {}
      modelStatus.textContent = ((err && err.message) || "The model did not answer.") +
        " Fix it and try again, or choose Skip for now.";
      nextBtn.disabled = false;
    });
  }

  /* ---------- about you (profile.js) ---------- */
  var cvText = $("[data-cv-text]");
  var aboutInput = $("[data-about]");
  var factInputs = [].slice.call(document.querySelectorAll("[data-fact]"));
  var profile = P ? P.get() : { cv: "", facts: {}, about: "" };
  cvText.value = profile.cv;
  aboutInput.value = profile.about || "";
  factInputs.forEach(function (i) { i.value = profile.facts[i.getAttribute("data-fact")] || ""; });

  if (core) {
    /* Same reader as Settings → Your profile (agent.js): the app extracts the text. */
    var cvFile = $("[data-cv-file]");
    var cvStatus = $("[data-cv-status]");
    $("[data-cv-pick-wrap]").hidden = false;
    $("[data-cv-pick]").addEventListener("click", function () { cvFile.click(); });
    cvFile.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { cvStatus.textContent = "That file is larger than 10 MB."; return; }
      cvStatus.textContent = "Reading " + file.name + "…";
      var reader = new FileReader();
      reader.onload = function () {
        core.invoke("extract_document", { name: file.name, data: String(reader.result) }).then(function (text) {
          cvText.value = text;
          cvStatus.textContent = "Read " + file.name + ". Check the text below.";
        }, function (err) { cvStatus.textContent = String(err); });
      };
      reader.onerror = function () { cvStatus.textContent = "That file couldn't be read."; };
      reader.readAsDataURL(file);
    });
  }

  function saveProfile() {
    if (!P) return;
    var facts = Object.assign({}, P.get().facts);
    factInputs.forEach(function (i) {
      var v = String(i.value || "").trim().slice(0, 120);
      var k = i.getAttribute("data-fact");
      if (v) facts[k] = v; else delete facts[k];
    });
    P.save({ cv: String(cvText.value || "").slice(0, 20000), facts: facts,
             about: String(aboutInput.value || "").trim().slice(0, 4000) });
  }

  /* What the model reads to suggest words: facts, the student's own words, then the start of
     the CV — never the whole CV — kept under ai.js's description limit. */
  function profileDescription() {
    var p = P.get();
    var parts = [];
    var facts = P.factsText(p.facts);
    if (facts) parts.push(facts);
    if (p.about.trim()) parts.push("In their own words:\n" + p.about.trim());
    var text = parts.join("\n\n");
    var room = MAX_DESCRIPTION - text.length - 40;
    if (p.cv.trim() && room > 200) text += (text ? "\n\n" : "") + "Start of their CV:\n" + p.cv.trim().slice(0, room);
    return text;
  }

  /* ---------- suggestions ---------- */
  var describe = $("[data-describe]");
  var suggestBtn = $("[data-suggest]");
  var suggestStatus = $("[data-suggest-status]");
  var suggestionsWrap = $("[data-suggestions]");
  var cfpWrap = $("[data-cfp-suggestions]");
  var alertHints = $("[data-alert-hints]");
  var SUGGEST_GROUPS = [
    { list: "interests", label: "Topics" },
    { list: "boost", label: "Worth a look" },
    { list: "exclude", label: "Rule out" }
  ];
  var suggestions = [];            /* { term, list } still waiting for a decision */
  var alertQueries = [];

  function chip(item, label, onDecide) {
    var c = el("span", "chip suggestion");
    var add = el("button", "suggestion-add", "+ " + item.term);
    add.type = "button";
    add.setAttribute("aria-label", "Add " + item.term + " to " + label);
    add.addEventListener("click", function () { onDecide(item, true); });
    var x = el("button", null, "×");
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss " + item.term);
    x.addEventListener("click", function () { onDecide(item, false); });
    c.appendChild(add);
    c.appendChild(x);
    return c;
  }

  function renderSuggestions() {
    suggestionsWrap.innerHTML = "";
    var mine = suggestions.filter(function (x) { return x.list !== "cfpCategories"; });
    suggestionsWrap.hidden = !mine.length;
    SUGGEST_GROUPS.forEach(function (g) {
      var items = mine.filter(function (x) { return x.list === g.list; });
      if (!items.length) return;
      var group = el("div", "suggestion-group");
      group.appendChild(el("p", "suggestion-label", g.label));
      var row = el("div", "suggestion-row");
      items.forEach(function (item) { row.appendChild(chip(item, g.label, decide)); });
      group.appendChild(row);
      suggestionsWrap.appendChild(group);
    });

    /* WikiCFP categories wait on the sources step, next to the WikiCFP box. */
    cfpWrap.innerHTML = "";
    var cfp = suggestions.filter(function (x) { return x.list === "cfpCategories"; });
    cfpWrap.hidden = !cfp.length;
    cfp.forEach(function (item) { cfpWrap.appendChild(chip(item, "WikiCFP categories", decide)); });

    /* Alerts queries can't be added for the student: Google makes the feed link. Shown as hints. */
    alertHints.innerHTML = "";
    alertHints.hidden = !alertQueries.length;
    if (alertQueries.length) {
      alertHints.appendChild(el("p", "suggestion-label", "Queries worth an alert, from your model"));
      alertQueries.forEach(function (q) { alertHints.appendChild(el("code", "alert-query", q)); });
    }
  }

  function decide(item, keep) {
    suggestions = suggestions.filter(function (x) { return x !== item; });
    if (keep && !has(state[item.list], item.term)) {
      state[item.list].push(item.term);
      boxes[item.list].render();
      validate();
    }
    renderSuggestions();
  }

  suggestBtn.addEventListener("click", function () {
    var text = profileDescription();
    if (!text.trim()) {
      suggestStatus.textContent = "Your profile is empty. Go back a step and add a few lines about you.";
      return;
    }
    suggestBtn.disabled = true;
    suggestStatus.textContent = "Asking " + (AI.getSettings().model || "your model") + "…";
    var prefs = { interests: state.interests, boost: state.boost, exclude: state.exclude, cfpCategories: state.cfpCategories };
    AI.suggestFromDescription(text, prefs).then(function (r) {
      suggestions = [];
      SUGGEST_GROUPS.concat([{ list: "cfpCategories" }]).forEach(function (g) {
        (r.lists[g.list] || []).forEach(function (t) { suggestions.push({ term: t, list: g.list }); });
      });
      alertQueries = (r.lists.alertQueries || []).slice(0, 5);
      var here = suggestions.filter(function (x) { return x.list !== "cfpCategories"; }).length;
      var later = suggestions.length - here;
      suggestStatus.textContent = suggestions.length
        ? here + " suggested here" + (later ? ", " + later + (later === 1 ? " WikiCFP category" : " WikiCFP categories") + " on the sources step" : "") + ". Add the ones that fit."
        : "The model had nothing new to add.";
      renderSuggestions();
    }, function (err) {
      suggestStatus.textContent = (err && err.message) || "The request failed.";
    }).then(function () { suggestBtn.disabled = false; });
  });

  /* ---------- step machine ---------- */
  function validate() {
    var ok = step !== STEP_TOPICS || state.interests.length > 0;
    nextBtn.disabled = !ok;
    nextBtn.style.opacity = ok ? "" : ".5";
    if (topicsNote) topicsNote.hidden = step !== STEP_TOPICS || ok;
  }

  function show(n) {
    step = Math.max(0, Math.min(STEPS - 1, n));
    steps.forEach(function (s) { s.hidden = Number(s.getAttribute("data-step")) !== step; });
    stepCount.textContent = "Step " + (step + 1) + " of " + STEPS;
    backBtn.hidden = step === 0;
    skipBtn.hidden = step !== STEP_MODEL;
    if (step === STEP_TOPICS) describe.hidden = !modelReady;
    nextBtn.textContent = step === 0 ? "Start" : (step === STEPS - 1 ? "Save and finish" : "Continue");
    $(".setup-body").scrollTop = 0;
    validate();
  }

  function savePrefs() {
    var prefs = read(KEYS.prefs, null) || JSON.parse(JSON.stringify(defaults));
    prefs.interests = state.interests;
    prefs.boost = state.boost;
    prefs.exclude = state.exclude;
    prefs.cfpCategories = state.cfpCategories;
    /* Keep labels already given to a link in Settings; new links get none. */
    function links(key) {
      var old = prefs[key] || [];
      return state[key].map(function (u) {
        var hit = old.filter(function (x) { return x && typeof x === "object" && x.url === u; })[0];
        return hit || { url: u, label: "" };
      });
    }
    prefs.feeds = links("feeds");
    prefs.watch = links("watch");
    prefs.threshold = state.threshold;
    prefs.disabled = state.disabled;
    write(KEYS.prefs, prefs);
    write(KEYS.schedule, { on: state.schedule.on !== false, every: Number(state.schedule.every) || 30,
                           brief: state.schedule.brief !== false });
  }

  function finish() {
    savePrefs();
    /* insider: "invite" or "skipped", so desktop-bridge.js knows setup saw the invite step. */
    write(KEYS.setup, { done: true, at: new Date().toISOString(), insider: INS ? (modelReady ? "invite" : "skipped") : undefined });
    location.href = "inbox.html";
  }

  nextBtn.addEventListener("click", function () {
    if (step === STEPS - 1) { finish(); return; }
    if (step === STEP_MODEL) { connectModel(); return; }
    if (step === STEP_ABOUT) saveProfile();
    show(step + 1);
  });
  backBtn.addEventListener("click", function () {
    if (step === STEP_ABOUT) saveProfile();
    show(step - 1);
  });
  skipBtn.addEventListener("click", function () {
    modelReady = false;
    modelStatus.textContent = modelStatusDefault;
    saveFirecrawl().catch(function () {});
    show(STEP_ABOUT);
  });

  if (INS) {
    inviteField.hidden = false;
    [].slice.call(document.querySelectorAll("[data-own-model]")).forEach(function (el) { el.hidden = true; });
    baseUrlField.hidden = true;
    fcField.remove();                                   /* search comes with the invite */
    var stepModel = $('[data-step="1"]');
    stepModel.querySelector("h1").textContent = "Enter your invite";
    stepModel.querySelector(".lede").textContent = "You're trying " + (INS.name || "Signal") + " early. Your invite brings Signal's own model and web search, so there's no key to set up.";
    modelStatus.textContent = modelStatusDefault = "No invite? Skip this step. Signal still works by your words alone.";
    var savedKey = AI && AI.hasKey() ? (localStorage.getItem(KEYS.aiKey) || "") : "";
    var m = /^(sig-[0-9a-f]{12})\./.exec(savedKey);
    if (m) { inviteInput.value = m[1]; modelReady = true; }
  }

  show(0);
})(window);
