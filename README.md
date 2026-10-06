# Signal

Most students miss opportunities not because none exist, but because they decide they are too
early, or they never go looking. Signal watches the places opportunities appear, in the fields
you choose, and tells you plainly which ones fit where you are now: hackathons, calls for papers,
research programmes, fellowships, open-source and community programmes, and internships. It
weighs each one by how it fits you, not by prestige.

Signal is not a job board, an internship listing site or a placement service. It promises no
outcome. It is a filter, not a feed: it finds you less.

Signal is a desktop app (Tauri 2). It runs on your laptop, with your own model key. There is no
account and no Signal server in a build made from this repo.

There are two ways to decide, on one pipeline:

- **LLM socket.** Plug in any compatible model (Anthropic, an OpenAI-compatible endpoint, or a
  local server such as Ollama or LM Studio). Each opportunity gets a relevance from 0 to 10 and a
  brief: why it fits you, whether your stage is enough, what you would gain, what it asks for,
  rough effort, and first steps. Every brief is labelled as coming from the model.
- **Heuristic search.** Keyword rules, no key: interest terms +4 in a title or +3 in the body,
  boost terms +2, exclude terms archive the item, default threshold 3, dedupe on source and ID,
  sort by recent (default), deadline or match strength. Fast, free and explainable.

Sources are open. Beyond the built-in sources you can add your own: an RSS/Atom feed, a JSON API
with a field mapping, a page to watch, or a social feed through a feed URL (for example an X
account via an RSS bridge). Only add URLs you are allowed to read. Signal identifies itself
honestly, refuses pages whose robots.txt disallows them, and always refuses private network
addresses.

Two research features are the exception, and both are **off by default**: the `ddgs` metasearch
provider and Stealth reading. When you turn them on, Signal presents itself as a normal browser.
The app says so next to each switch. Built-in sources and scheduled checks never use them unless
you turn them on.

Signal is module 01 of Student OS. No other module is built.

## Build it

You need:

- **Node 22** or newer
- **Rust** (stable), from https://rustup.rs
- **cmake** and **clang**. One dependency builds V8 and BoringSSL.
- Linux (Debian/Ubuntu):

  ```sh
  sudo apt-get install -y build-essential cmake libclang-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf
  ```

- Windows: the Visual Studio C++ build tools, WebView2 (ships with Windows 11) and
  [NASM](https://www.nasm.us) on your `PATH`.

Then:

```sh
git clone https://github.com/Taran8851/signal.git
cd signal/app/desktop
npm ci
npx tauri dev                          # run it
npx tauri build                        # Linux: .deb and AppImage
npx tauri build --bundles nsis,msi     # Windows installers
```

The first build is slow, because it compiles V8. Installers land in
`app/desktop/src-tauri/target/release/bundle/`.

`.github/workflows/desktop.yml` runs the same build for Windows and Linux on every push to
`main`. It works in a fork with no secrets set; the insider and upload steps skip themselves.

An Android project is in `app/desktop/src-tauri/gen/android/`. Building it needs the Android SDK
and NDK (`npx tauri android build`). macOS has not been built or tested.

### Run the console in a browser

The UI is plain HTML, CSS and JavaScript, with no build step. From the repo root:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000/app/frontend/login.html (any email and password). In a browser
the console keeps everything in `localStorage` and can only read sources that allow cross-origin
requests; the desktop app reads them through its own fetcher instead.

### Tests for the shared rules

```sh
cd packages/core && npm test
```

Needs Node 22.18 or newer. No install step: the package has no dependencies.

## Use the research tools from an MCP client

`signal-desktop --mcp` serves Signal's `search_web` and `read_page` tools over stdio, for Claude
Code, Claude Desktop or any MCP client. It uses the same search providers, keys and limits you
set on the app's Research page.

## What works today, and what does not

| Part | State |
|---|---|
| Desktop app (`app/desktop/`) | **Works** on Linux and Windows. Tray, background checks, system notifications, single instance. |
| Console (`app/frontend/`) | **Works.** Signals, notes, statuses, preferences and your own sources are stored on your machine. |
| Heuristic search | **Works, no key.** Every row says which terms matched. Default scoring mode. Sends nothing. |
| LLM socket with brief (`app/frontend/ai.js`) | **Works, with your own model.** Scoring mode Keyword / Hybrid / LLM, a daily call cap, fallback to the keyword score on errors, and "Suggest my terms" with a dry run. Requests go straight from the app to your provider. |
| Custom sources (`app/frontend/sources.js`) | **Works.** RSS/Atom, JSON API with field mapping, web page to watch, social feed via a feed URL. |
| Research agent (`app/frontend/agent.js`) | **Works, with your own model.** Searches the web and reads pages. What it finds is added to the inbox only when you press Add. Web search needs a Firecrawl key or one of the opt-in providers. |
| Shared scoring rules (`packages/core/`) | **In progress.** TypeScript re-implementation of the reference rules, with tests. Not used by any page yet. |
| Collector (`reference/signal/`) | **Reference code only.** The earlier single-user collector (SQLite, keyword scoring, Telegram). It is not built or run from this repo. |
| Hosted app with accounts | **Not built.** |
| Insider builds | The code path exists (an invite code instead of a key). It needs a gateway address this repo does not contain, so a build from source never uses it. |

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
  implemented in the reference collector; any figure from this run covers seven.
- **"2 notified" is not a filtering result.** It is low because the first run stores
  everything and notifies about nothing (backfill). It shows the backfill rule works, nothing more.

There is no other measured figure. The keyword score is called match strength. Nothing has been
measured about how good LLM relevance is.

## Repo layout

```
app/
  frontend/          the console: pages, scripts, styles. No build step.
  desktop/           Tauri 2 project. scripts/copy-app.mjs copies ../frontend into dist/;
                     src-tauri/ is the Rust side (fetcher, search, page reading, MCP server).
packages/core/       shared scoring rules and tests (in progress)
reference/signal/    the earlier collector and its admin UI, read-only reference
ref/                 design tokens the styles are built from
.github/workflows/   the Windows and Linux build
```

The website is not in this repo.

## Credits and licences

Signal is released under the [MIT licence](LICENSE).

- **[Tauri](https://tauri.app)** (MIT / Apache-2.0) is the app shell.
- **[Obscura](https://github.com/h4ckf0r0day/obscura)** (Apache-2.0) is linked in to read pages
  that need JavaScript. It is pinned to one commit in `Cargo.toml`.
- Other Rust crates are listed in `app/desktop/src-tauri/Cargo.toml`, each under its own licence.
- **Newsreader** (Production Type) and **Geist Mono** (Vercel), loaded from Google Fonts. Both
  are licensed under the SIL Open Font License 1.1.
- The console itself uses no JavaScript libraries.
