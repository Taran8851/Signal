/* Signal conversations: the research agent's chats, listed in the sidebar like a chat app.
   Loaded on every console page; the chat itself runs in agent.js on research.html.

   Store: signal_demo_chats { list: [{ id, title, created, updated, transcript, meta }], current }
   The single chat older versions kept (signal_demo_research_chat) becomes the first entry. */
(function (global) {
  "use strict";

  var KEY = "signal_demo_chats";
  var OLD = "signal_demo_research_chat";
  var MAX_CHATS = 60;

  function read() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (v && Array.isArray(v.list)) return v;
    v = { list: [], current: null };
    try {
      var old = JSON.parse(localStorage.getItem(OLD));
      if (old && Array.isArray(old.transcript) && old.transcript.length) {
        var c = blank();
        c.transcript = old.transcript; c.meta = old.meta || {};
        c.title = titleOf(c); c.updated = c.created = Date.now();
        v.list.push(c); v.current = c.id;
      }
    } catch (e) {}
    write(v);
    return v;
  }
  function write(v) {
    v.list = v.list.slice(0, MAX_CHATS);
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
  }
  function blank() {
    return { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: "", created: Date.now(), updated: Date.now(), transcript: [], meta: {} };
  }
  function titleOf(c) {
    var first = (c.transcript || []).filter(function (x) { return x.role === "user"; })[0];
    var t = first ? String(first.content).replace(/\s+/g, " ").trim() : "";
    return t.length > 48 ? t.slice(0, 46).replace(/\s+\S*$/, "") + "…" : t;
  }
  function emit() { try { global.dispatchEvent(new CustomEvent("signal:chats")); } catch (e) {} }

  function list() { return read().list.filter(function (c) { return c.transcript.length; }); }
  function get(id) { return read().list.filter(function (c) { return c.id === id; })[0] || null; }

  /* The chat to show: the current one, or a new empty one. */
  function current() {
    var v = read();
    return (v.current && get(v.current)) || create();
  }
  function create() {
    var v = read();
    // Reuse an empty chat instead of piling them up.
    var empty = v.list.filter(function (c) { return !c.transcript.length; })[0];
    var c = empty || blank();
    if (!empty) v.list.unshift(c);
    v.current = c.id;
    write(v); emit();
    return c;
  }
  function setCurrent(id) { var v = read(); if (get(id)) { v.current = id; write(v); emit(); } }
  function save(c) {
    var v = read();
    c.title = c.title || titleOf(c);
    c.updated = Date.now();
    v.list = [c].concat(v.list.filter(function (x) { return x.id !== c.id; }));
    v.current = c.id;
    write(v); emit();
  }
  function remove(id) {
    var v = read();
    v.list = v.list.filter(function (c) { return c.id !== id; });
    if (v.current === id) v.current = null;
    write(v); emit();
  }

  /* Sidebar: Today / Yesterday / Previous 7 days / Older. */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  function group(t) {
    var d = new Date(); d.setHours(0, 0, 0, 0);
    var day = 86400000;
    if (t >= d.getTime()) return "Today";
    if (t >= d.getTime() - day) return "Yesterday";
    if (t >= d.getTime() - 7 * day) return "Previous 7 days";
    return "Older";
  }
  function renderSidebar() {
    var box = document.querySelector("[data-chat-history]");
    if (!box) return;
    var onResearch = /research\.html$/.test(location.pathname);
    var cur = read().current;
    var items = list();
    if (!items.length) {
      box.innerHTML = '<p class="history-empty">Your questions will show up here.</p>';
      return;
    }
    var html = [], last = "";
    items.forEach(function (c) {
      var g = group(c.updated);
      if (g !== last) { html.push('<p class="history-group">' + g + "</p>"); last = g; }
      var active = onResearch && c.id === cur;
      html.push('<div class="history-item"><a href="research.html#chat=' + esc(c.id) + '"' + (active ? ' aria-current="page"' : "") + ' title="' + esc(c.title || "Untitled") + '">' + esc(c.title || "Untitled") + "</a>" +
        '<button class="history-delete" type="button" aria-label="Delete “' + esc(c.title || "Untitled") + '”" data-delete-chat="' + esc(c.id) + '">×</button></div>');
    });
    box.innerHTML = html.join("");
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-delete-chat]") : null;
    if (!b) return;
    e.preventDefault();
    if (!b.getAttribute("data-armed")) { b.setAttribute("data-armed", "1"); b.textContent = "Delete?"; return; }
    var id = b.getAttribute("data-delete-chat");
    remove(id);
    renderSidebar();
    if (/research\.html$/.test(location.pathname) && location.hash === "#chat=" + id) location.hash = "#new";
  });
  global.addEventListener("signal:chats", renderSidebar);
  document.addEventListener("DOMContentLoaded", renderSidebar);

  global.SignalChats = { list: list, get: get, current: current, create: create, setCurrent: setCurrent, save: save, remove: remove, renderSidebar: renderSidebar };
})(window);
