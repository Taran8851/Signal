#!/usr/bin/env node
// Signal fetch helper: lets the demo console read sources that block browser requests.
//
//   node web/backend/fetch-helper.mjs      # listens on http://127.0.0.1:8787
//
// GET  /health                -> { ok, engine }
// GET  /fetch?url=…&render=1  -> { ok, url, status, contentType, body, engine }
// POST /fetch  {url, method, body, accept}  -> the same, for listing APIs that want a POST
//      (JSON bodies only, no caller-supplied headers, same rules as GET)
//
// It renders with Obscura (obscura next to this file, or OBSCURA_BIN) when available, otherwise it
// uses a plain HTTP fetch. Rules, matching AGENTS.md ("Signal doesn't scrape sites that
// forbid it"):
//   - public http(s) only; Obscura's SSRF guard blocks private networks, and so do we
//   - robots.txt is honoured for the Signal user agent
//   - no stealth mode, no proxies, no logins, no cookies
//   - listens on loopback only; CORS allowed for local console origins only
//
// Hosted (web/backend/deploy/lightsail): Caddy proxies https://<site>/helper/* here, so the console calls
// it same-origin. TRUST_PROXY=1 reads the client IP from X-Forwarded-For (set by Caddy only)
// for the per-IP rate limit.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);
const MAX_RENDERS = Number(process.env.MAX_RENDERS || 2);
const UA = "SignalFetchHelper/0.1 (+student demo; respects robots.txt)";
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_S = 20;
const here = path.dirname(fileURLToPath(import.meta.url));
const OBSCURA = process.env.OBSCURA_BIN || path.join(here, "obscura");
const hasObscura = existsSync(OBSCURA);
const ORIGIN_OK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const EXTRA_ORIGINS = (process.env.SIGNAL_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, "That isn't a valid link."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw httpError(400, "Only http and https links are allowed.");
  if (u.username || u.password) throw httpError(400, "Links with credentials aren't allowed.");
  const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw httpError(502, "That site's name doesn't resolve.");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw httpError(403, "Private network addresses aren't allowed.");
  return u;
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Minimal robots.txt check: groups for our agent or "*", longest matching Allow/Disallow wins.
const robotsCache = new Map();
async function robotsAllows(u) {
  const key = u.origin;
  let rules = robotsCache.get(key);
  if (!rules) {
    rules = [];
    try {
      const res = await fetch(key + "/robots.txt", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000), redirect: "follow" });
      if (res.ok) rules = parseRobots(await res.text());
    } catch { /* no robots.txt reachable: allowed */ }
    robotsCache.set(key, rules);
  }
  const target = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    if (r.path === "" ) continue;
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(target) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === "user-agent") {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (field === "allow" || field === "disallow")) cur.rules.push({ allow: field === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && "signalfetchhelper".includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

// A POST body from the console: only a URL, the method, a JSON body and an Accept value.
// No caller-supplied headers, so this can't be used to forge requests with someone's cookies.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(httpError(413, "That request is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("error", () => reject(httpError(400, "That request couldn't be read.")));
    req.on("end", () => {
      let asked;
      try { asked = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(httpError(400, "That request wasn't JSON.")); }
      if (!asked || typeof asked !== "object") return reject(httpError(400, "That request wasn't JSON."));
      const method = String(asked.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "POST") return reject(httpError(400, "Only GET and POST are allowed."));
      const body = asked.body == null ? "" : String(asked.body);
      if (body.length > 16 * 1024) return reject(httpError(413, "That request body is too large."));
      if (method === "POST" && body) {
        try { JSON.parse(body); } catch { return reject(httpError(400, "The request body has to be JSON.")); }
      }
      const accept = String(asked.accept || "*/*").slice(0, 100);
      if (/[\r\n]/.test(accept)) return reject(httpError(400, "That accept value isn't allowed."));
      resolve({ url: String(asked.url || ""), method: method, body: body, accept: accept });
    });
  });
}

function runObscura(url, render) {
  const args = ["fetch", url, "--dump", render ? "html" : "original", "--timeout", String(TIMEOUT_S)];
  if (render) args.push("--wait-until", "networkidle0");
  return new Promise((resolve, reject) => {
    execFile(OBSCURA, args, { maxBuffer: MAX_BYTES + 1024, timeout: (TIMEOUT_S + 10) * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(httpError(502, "Obscura couldn't load that page. " + String(stderr || err.message).split("\n")[0].slice(0, 200)));
      resolve({ status: 200, contentType: render ? "text/html" : "", body: stdout, engine: "obscura" });
    });
  });
}

// Follow redirects by hand so every hop gets the same public-address check.
async function runPlain(url, post) {
  let res;
  for (let hop = 0; ; hop++) {
    const init = { headers: { "user-agent": UA, accept: (post && post.accept) || "*/*" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_S * 1000) };
    if (post && hop === 0) {
      init.method = "POST";
      init.body = post.body;
      init.headers["content-type"] = "application/json";
    }
    res = await fetch(url, init);
    const loc = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (!loc) break;
    if (hop >= 5) throw httpError(502, "Too many redirects.");
    url = (await checkUrl(new URL(loc, url).href)).href;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw httpError(413, "That response is too large.");
  return { status: res.status, contentType: res.headers.get("content-type") || "", body: new TextDecoder().decode(buf), engine: "fetch" };
}

// Per-IP sliding window, and a cap on concurrent Obscura renders (each is a browser).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 60000) hits.delete(k);
  return list.length > RATE_PER_MIN;
}
let rendering = 0;

function send(res, origin, status, obj) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "Origin" };
  if (origin && (ORIGIN_OK.test(origin) || EXTRA_ORIGINS.includes(origin))) {
    headers["access-control-allow-origin"] = origin;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
  if (req.method === "OPTIONS") return send(res, origin, 204, {});
  if (req.method !== "GET" && req.method !== "POST") return send(res, origin, 405, { ok: false, error: "GET or POST only." });
  if (u.pathname === "/health") return send(res, origin, 200, { ok: true, engine: hasObscura ? "obscura" : "fetch" });
  if (u.pathname !== "/fetch") return send(res, origin, 404, { ok: false, error: "Not found." });
  let asked = null;
  if (req.method === "POST") {
    try { asked = await readJsonBody(req); }
    catch (e) { return send(res, origin, e.status || 400, { ok: false, error: e.message }); }
  }
  if (rateLimited(ip)) return send(res, origin, 429, { ok: false, error: "Too many requests. Wait a minute and try again." });
  try {
    const target = await checkUrl((asked && asked.url) || u.searchParams.get("url") || "");
    if (!(await robotsAllows(target))) throw httpError(403, "This site's robots.txt asks automated readers not to fetch that page, so Signal won't.");
    // Feeds and JSON don't need rendering; pages do. A POST is always a plain request:
    // Obscura fetches with GET.
    const render = !asked && u.searchParams.get("render") === "1";
    const post = asked && asked.method === "POST" ? { body: asked.body, accept: asked.accept } : null;
    let out;
    if (post) {
      out = await runPlain(target.href, post);
    } else if (hasObscura) {
      if (render && rendering >= MAX_RENDERS) throw httpError(503, "The helper is busy rendering other pages. Try again in a moment.");
      if (render) rendering++;
      try { out = await runObscura(target.href, render); }
      catch (e) { if (render) throw e; out = await runPlain(target.href); }
      finally { if (render) rendering--; }
    } else {
      out = await runPlain(target.href);
    }
    if (out.body.length > MAX_BYTES) throw httpError(413, "That response is too large.");
    console.log(new Date().toISOString(), out.engine, render ? "render" : post ? "post" : "raw", target.href);
    send(res, origin, 200, { ok: true, url: target.href, ...out });
  } catch (e) {
    console.log(new Date().toISOString(), "error", e.message);
    send(res, origin, e.status || 500, { ok: false, error: e.message || "Fetch failed." });
  }
}).listen(PORT, HOST, () => {
  console.log(`Signal fetch helper on http://${HOST}:${PORT} (engine: ${hasObscura ? "obscura" : "plain fetch"})`);
});
