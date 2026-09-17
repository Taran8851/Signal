# Signal

Signal is an opportunity filter for students. It watches places where hackathons, calls for
papers and similar openings appear, scores each item against the topics you chose, and shows
you only the ones that clear your threshold. It is a filter, not a feed: it finds you less.

Signal is module 01 of Student OS. No other module is built.

## What works today, and what does not

| Part | State |
|---|---|
| Landing page (`index.html`) | **Works.** Static HTML and CSS. The "Tune your filter" widget rescores 10 real public rows in the browser with the same matching rules as the collector. |
| Demo console (`app/`) | **Works, as a demo.** Static pages. Sign-in accepts anything and only sets a flag. Signals, notes, statuses and preferences live in this browser's `localStorage`. No real accounts and no real collection. |
| AI in the demo console (`app/ai.js`) | **Works, with your own key.** Scoring mode (Keyword / Hybrid / LLM), 0–10 relevance per signal, daily call cap, fallback to the keyword score on errors, and "Suggest my terms" (a no-LLM history engine plus an LLM engine, with a dry run). The key is kept in `localStorage` and requests go straight from the browser to the provider (Anthropic or an OpenAI-compatible endpoint). Default mode is Keyword, which sends nothing. |
| Collector | **Exists as reference code** in `reference/signal/`: the shipped single-user collector (SQLite, keyword scoring, Telegram). It is not deployed from this repo and the demo console does not talk to it. |
| Shared scoring rules (`packages/core/`) | **In progress.** TypeScript re-implementation of the reference rules with tests. Not used by any page yet. |
| Hosted app and backend (`/console`, `/api`) | **Planned.** SvelteKit app, Postgres and collector on a VPS behind a Vercel rewrite. `deploy/` holds unverified scaffolding. See `docs/platform_plan.md` §9. |
| Server-side LLM scoring with encrypted keys, developer mode, themes editor | **Planned.** Specified in `AGENTS.md`, not built. |
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

There is no other measured figure. There is no "winnability" score; the keyword score is called
match strength.

## Repo layout

```
index.html, shared.css, tokens.css   landing page
filter.js, wave.js, motion.js        landing scripts: filter widget, hero wave, reveals
app/                                 static demo console (login, inbox, preferences, ai.js)
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
`signal_demo_ai_results`.

Tests for the shared rules (Node 22.18 or newer):

```sh
cd packages/core && npm test
```

## Deploy the static site to Vercel

1. Import the repo in Vercel.
2. Framework preset: **Other**. Build command: none. Output directory: the repo root (`.`).
3. Deploy.

`vercel.json` adds security headers and rewrites `/console/*` and `/api/*` to a VPS. Until the
app exists, replace `VPS_HOSTNAME` or those two paths will fail; the landing page and `/app/`
are unaffected. `.vercelignore` keeps `deploy/`, `reference/`, `docs/`, `packages/` and the rule
files out of the published site.

## Credits and licences

- **Newsreader** (Production Type) and **Geist Mono** (Vercel), loaded from Google Fonts. Both
  are licensed under the SIL Open Font License 1.1.
- The hero wave is hand-written WebGL with no libraries.
- No other third-party code runs on the landing page or the demo console.
