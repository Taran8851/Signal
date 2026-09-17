# Signal

Most students miss opportunities not because none exist, but because they decide they are too
early, or they never go looking. Signal watches the places opportunities appear, in the fields
you choose, and tells you plainly which ones fit where you are now: hackathons, calls for papers,
research programmes, fellowships, open-source and community programmes, and internships. It
weighs each one by how it fits you, not by prestige.

Signal is not a job board, an internship listing site or a placement service. It promises no
outcome. It is a filter, not a feed: it finds you less.

There are two ways to decide, on one pipeline:

- **LLM socket.** Plug in any compatible model (Anthropic, an OpenAI-compatible endpoint, or a
  local server). Each opportunity gets a relevance from 0 to 10 and a brief: why it fits you,
  whether your stage is enough, what you would gain, what it asks for, rough effort, and first
  steps. Every brief is labelled as coming from the model.
- **Heuristic search.** Keyword rules, no key: interest terms +4 in a title or +3 in the body,
  boost terms +2, exclude terms archive the item, default threshold 3, dedupe on source and ID,
  sort by recent (default), deadline or match strength. Fast, free and explainable.

Sources are open. Beyond the nine built-in sources you can add your own: an RSS/Atom feed, a
JSON API with a field mapping, a page to watch, or a social feed through a feed URL (for example
an X account via an RSS bridge). Only add URLs you are allowed to read; Signal does not scrape
sites that forbid it.

Signal is module 01 of Student OS. No other module is built.

## What works today, and what does not

| Part | State |
|---|---|
| Landing page (`index.html`) | **Works.** Static HTML and CSS. The "Tune your filter" widget rescores 10 real public rows in the browser with the same matching rules as the collector. |
| Demo console (`app/`) | **Works, as a demo.** Static pages. Sign-in accepts anything and only sets a flag. Signals, notes, statuses, preferences and your own sources live in this browser's `localStorage`. No real accounts and no server-side collection. |
| Heuristic search in the demo console | **Works, no key.** Keyword scoring with the reference rules; every row says which terms matched. Default scoring mode. Sends nothing. |
| LLM socket with brief (`app/ai.js`) | **Works, with your own model.** Providers: Anthropic, OpenAI-compatible endpoint, Local (Ollama, LM Studio). Scoring mode Keyword / Hybrid / LLM, "Score all with AI" on the Signals page, a per-item brief (fits you, your stage, you'd gain, it asks for, first steps, effort, fields) in the signal overlay, daily call cap, fallback to the keyword score on errors, and "Suggest my terms" (a no-LLM history engine plus an LLM engine, with a dry run). The key is kept in `localStorage` and requests go straight from the browser to the provider. |
| Custom sources (`app/sources.js`) | **Works, in the demo console.** Preferences → Sources → Your sources → Add a source: RSS/Atom, JSON API with field mapping (Detect fields, or Map fields with AI), web page to watch, social feed via a feed URL. Two offline sample presets. Fetching from a link runs in the browser, so sites that block cross-origin requests cannot be read; paste a sample instead. |
| Collector | **Exists as reference code** in `reference/signal/`: the shipped single-user collector (SQLite, keyword scoring, Telegram). It is not deployed from this repo and the demo console does not talk to it. |
| Shared scoring rules (`packages/core/`) | **In progress.** TypeScript re-implementation of the reference rules with tests. Not used by any page yet. |
| Hosted app and backend (`/console`, `/api`) | **Planned.** SvelteKit app, Postgres and collector on a VPS behind a Vercel rewrite; the server will fetch custom sources and run LLM scoring with encrypted keys. `deploy/` holds unverified scaffolding. See `docs/platform_plan.md` §9. |
| Developer mode, themes editor | **Planned.** Specified in `AGENTS.md`, not built. |
| Gmail + LinkedIn mail in the hosted app | **Not available yet.** The reference collector reads it; the hosted app will not at launch. |

## Measured numbers

From one run of the reference collector, 2026-09-11, 11:03 to 20:41 UTC (9 h 38 min).

| Figure | Value |
|---|---|
| Signals collected | 300 |
| Scored 0 (matched nothing in the user's lists) | 170 (57%) |
| Cleared the default threshold of 3 | 59 |
| Carry a real deadline | 219 |
| Actually notified | 2 |

Two constraints on these:

- **Seven sources had data, not nine.** Discord bot, RSS / Google Alerts, Page watch and manual
  entries had zero rows because they need a feed URL, page URL or bot invite. Nine sources are
  implemented; any figure from this run covers seven.
- **"2 notified" is not a filtering result.** It is low because the first run stores
  everything and notifies about nothing (backfill). It shows the backfill rule works, nothing more.

There is no other measured figure. The keyword score is called
match strength.

## Repo layout

```
index.html, shared.css, tokens.css   landing page
filter.js, wave.js, motion.js        landing scripts: filter widget, hero wave, reveals
app/                                 static demo console (login, inbox, preferences, ai.js, sources.js)
vercel.json, .vercelignore           static hosting config
packages/core/                       shared scoring rules + tests (in progress)
deploy/                              VPS scaffolding for the planned app (unverified)
reference/signal/                    the real collector and admin UI (read-only reference)
docs/                                platform plan, demo script
ref/                                 visual design reference
AGENTS.md, DESIGN.md                 product rules and design rules
```

## Run locally

No install and no build step. From the repo root:

```sh
python3 -m http.server 8000
```

Then open:

- http://localhost:8000/index.html (landing page)
- http://localhost:8000/app/login.html (demo console; any email and password)

To reset the demo console, clear these `localStorage` keys in the browser dev tools:
`signal_demo_rows`, `signal_demo_prefs`, `signal_demo_session`, `signal_demo_appearance`, and the AI
keys `signal_demo_ai`, `signal_demo_ai_key`, `signal_demo_ai_usage`, `signal_demo_ai_cache`,
`signal_demo_ai_results`, and `signal_demo_sources` for your own sources.

Tests for the shared rules (Node 22.18 or newer):

```sh
cd packages/core && npm test
```

## Deploy the static site to Vercel

1. Import the repo in Vercel.
2. Framework preset: **Other**. Build command: none. Output directory: the repo root (`.`).
3. Deploy.

`vercel.json` adds security headers only. The rewrites that send `/console/*` and `/api/*` to
the VPS live in `deploy/vercel.rewrites.json`; merge them into `vercel.json` once the server
exists and `VPS_HOSTNAME` is replaced. `.vercelignore` keeps `deploy/`, `reference/`, `docs/`, `packages/` and the rule
files out of the published site.

## Credits and licences

- **Newsreader** (Production Type) and **Geist Mono** (Vercel), loaded from Google Fonts. Both
  are licensed under the SIL Open Font License 1.1.
- The hero wave is hand-written WebGL with no libraries.
- No other third-party code runs on the landing page or the demo console.
