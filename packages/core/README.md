# @signal/core

Pure TypeScript rules for Signal, shared by the web app and the collector. It has no I/O, no
database, no network access and no runtime dependencies.

This package re-implements the behaviour of `reference/signal/` without importing from it. When
this package and the reference disagree, the reference is correct and this package has a bug.

## Run the tests

```sh
cd packages/core
npm test            # = node --test "test/**/*.test.ts"
```

This needs Node ≥ 22.18, which runs `.ts` files directly by stripping the types. Only erasable
syntax is used: no enums, no namespaces and no parameter properties. Imports use explicit `.ts`
extensions. Tests use only `node:test` and `node:assert/strict`.

## Map to the reference

| Export | File | Reference |
|---|---|---|
| `KINDS`, `STATUSES`, `ALWAYS_NOTIFY`, `SOURCES`, `SignalRow`, `NewSignal` | `src/constants.ts` | `signals.ts` L40-L69 |
| `clip`, `safeUrl`, `isoDate`, `guessKind` | `src/text.ts` | `signals.ts` L74-L102 |
| `decodeEntities`, `htmlToText`, `firstLine` | `src/text.ts` | `collector/util.ts` L42-L71 |
| `SignalPrefs`, `Link`, `PREF_DEFAULTS` | `src/prefs.ts` | `signals.ts` L106-L140 |
| `normalizePrefs`, `normalizePrefsDetailed`, `sanitizeList`, `sanitizeLinks`, `sanitizeThreshold` | `src/prefs.ts` | merge: `getPrefs()` `signals.ts` L142-L150; sanitizing: `admin-ui/preferences.astro` L9-L48 |
| `termRe`, `scoreText`, `WEIGHTS` | `src/score.ts` | `signals.ts` L160-L181 |
| `explainScore` (new, additive) | `src/score.ts` | Gives the same result as `scoreText`, with a breakdown per term |
| `statusOnInsert` | `src/pipeline.ts` | `insertSignal` `signals.ts` L211-L212 |
| `isBackfill`, `shouldNotify` | `src/pipeline.ts` | `collector/index.ts` L35-L36, L54 |
| `RETRY_MS`, `isFailing`, `nextWaitMs`, `isDue` | `src/pipeline.ts` | `collector/index.ts` L22, L76-L78 |
| `planNotifications`, `ICON` | `src/pipeline.ts` | `collector/notify.ts` L43-L97. Returns note data, not Telegram HTML |
| `sortSignals`, `byRecent`, `byDeadline`, `byScore` | `src/sort.ts` | `ORDER` `signals.ts` L221-L225, fallback L245 |
| `decideScoring`, `SCORING_MODES`, `LlmVerdict` | `src/scoring-mode.ts` | AGENTS.md "Scoring modes"; `docs/platform_plan.md` §2. No LLM call |

## Notes

- `normalizePrefs(input)` merges over the defaults. A missing field keeps its default value.
  A field that is present is sanitized the same way the preferences form sanitizes it. List
  fields accept either an array or a textarea string, which is split on newlines and commas.
  Link fields accept `"Label | url"` lines, `{label, url}` objects or bare URL strings.
- `desktop` is kept so prefs match the reference. The hosted app has no desktop and ignores it.
- `isoDate` formats in the process's local time zone, as the reference does. Run servers in UTC.
- `decideScoring(mode, { score, excluded }, prefilter = 1)` takes the keyword result, not a bare
  score, because it has to know whether the item was excluded. An excluded item is never sent to
  the LLM.
