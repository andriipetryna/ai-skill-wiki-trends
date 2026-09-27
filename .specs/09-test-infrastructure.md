# 09 — Test infrastructure: vitest, testable CLI, fake Wikimedia API

## Why
Everything else in testing (unit, integration, evals) needs three things the MVP does not have:
1. a test runner;
2. a CLI that can be called in-process with a fixed clock and a temp output dir;
3. a **deterministic fake Wikimedia API** that returns responses in the exact real shapes, so the whole pipeline runs offline with known right answers.

The fake API is also what makes agent evals (13) reproducible: the "correct answer" is known because we generated the data.

## Scope
- **In:** vitest setup, `runCli` export, injectable retry delay, fake API + fake world, `WT_FAKE_API=1` mode, npm scripts, CI workflow.
- **Out:** the tests themselves (10–12) and evals (13–14).

## Dependencies (explicitly allowed by this spec)
Dev dependencies only, pinned exactly:
- `vitest` `5.0.2` (4.x had an npm peer-resolution error and a security advisory at the time of writing — check `npm audit` after install);
- `zod` `4.1.12` (used by contract tests in 11; dev-only).

No runtime dependencies are added.

## Code changes

### `scripts/src/cli.ts`
- Export the command logic as a function; the entry point stays a thin wrapper:

  ```ts
  export interface CliResult { code: number; output: Record<string, unknown> }
  export async function runCli(argv: string[]): Promise<CliResult>
  ```

- The entry guard must compare real paths (skills are installed via symlinks; Node resolves the main module's path). Keep the existing `realpathSync` check. If it is missing, add it:

  ```ts
  function isMain(): boolean {
    try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename); }
    catch { return false; }
  }
  ```

- Tests pass `--out-dir <tmp>` so nothing is written into the repo.
- The current month comes from `new Date()`; tests control it with `vi.setSystemTime()`. No clock injection needed.

### `scripts/src/client.ts`
Make the retry backoff configurable so tests do not sleep:

```ts
export const CLIENT_CONFIG = { retryBaseMs: 500, maxRetries: 3 };
```

The retry loop reads `CLIENT_CONFIG` at call time. Tests set `CLIENT_CONFIG.retryBaseMs = 0`.

### `tests/fake/` (new)

```
tests/fake/
├── noise.ts     # the deterministic noise() and gen() from specs/README.md, plus genSeries(opts)
├── world.ts     # FakeWorld type + demoWorld(): articles, editions, disambiguations
└── fetch.ts     # createFakeFetch(world): a fetch-compatible function routing by URL
```

`createFakeFetch(world)` returns `(input: string | URL, init?) => Promise<Response>` (use the global `Response` class) and records calls in `.calls: string[]`. Tests install it with `vi.stubGlobal("fetch", fake)`.

**Routes and response shapes.** These must match the real APIs exactly (verified against live responses):

| Request | Real response shape to reproduce |
|---|---|
| `wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{lang}.wikipedia/all-access/user/{Title_Underscored}/monthly/{YYYYMMDD}/{YYYYMMDD}` | `200 { items: [{ project, article, granularity: "monthly", timestamp: "2024090100", access, agent, views }] }`. **Months with 0 views are omitted.** Unknown title → `404 { detail: "The date(s) you used are valid, but we either do not have data ..." }` |
| `.../aggregate/{lang}.wikipedia/all-access/user/monthly/{start}/{end}` | same `items` shape (after spec 01) |
| `{lang}.wikipedia.org/w/api.php?action=query&titles=T&redirects=1&prop=pageprops\|description&ppprop=wikibase_item\|disambiguation&format=json&formatversion=2` | `{ query: { pages: [{ pageid, ns: 0, title, pageprops: { wikibase_item: "Q…" }, description, descriptionsource: "local" }] } }`. Missing → `pages: [{ title, missing: true }]`. Disambiguation → `pageprops: { disambiguation: "", wikibase_item }` |
| same host, `generator=search&gsrsearch=Q&gsrlimit=N&...` | `{ query: { pages: [{ title, index, pageprops: { wikibase_item }, description? }] } }` — `pages` is **not** sorted by `index`; the fake returns them shuffled |
| same host, `prop=redirects&titles=T&rdnamespace=0&rdlimit=N` (after spec 02) | `{ query: { pages: [{ title, redirects?: [{ ns: 0, title }] }] } }` |
| `www.wikidata.org/w/api.php?action=wbgetentities&ids=Q&props=sitelinks\|labels&...` | `{ entities: { Q: { labels: { en: { language, value } }, sitelinks: { cswiki: { site, title, badges: [] } } } }, success: 1 }`. Unknown id → `entities: { Q: { id, missing: "" } }` |
| anything else | `404 { error: "unknown fake route", url }`. Tests fail loudly on unexpected requests |

Options: `failFirst?: number` (answer the first N requests with `429` and `retry-after: 0`) for retry tests.

**`demoWorld()` content.** Mirror real situations, with known generated series. Ground truth lives next to the data as comments.

| Topic (QID) | Languages and series | What it exercises |
|---|---|---|
| Intermittent fasting (Q1666254) | en; cs `Přerušovaný půst` with a ×6 spike in 2025-10; **no pl sitelink** (as in reality); pl search returns `Stres oksydacyjny`, `Głodówka lecznicza` (index 1, 2); `Głodówka lecznicza` has its own series +35%/yr | missing sitelink → `suggestions`, `--article`, spikes |
| Astronomy (Q333) | uk `Астрономія` +4%/yr raw, uk edition −12%/yr; pl `Astronomia` flat | normalization |
| English language (Q1860) + English as a second or foreign language (Q1321) | pl, cs, uk, de, hu, ro; ro median ≈ 70 views/month; Q1321 missing in cs, de, hu, ro | basket, low volume, missing topics, ranking |
| Mercury | disambiguation page; search hits `Mercury (planet)` (Q308), `Mercury (element)` (Q925) | ambiguous topic |
| Editions | en, pl, cs, uk, de, hu, ro with their own trends | normalization base |

Generator formula: `gens.growth(base, pctPerYear, { season, noise, seed, spikes })` with growth anchored at a fixed month (e.g. 2024-07), so levels stay realistic whatever period is requested.

### `scripts/src/cli.ts` — synthetic mode
If `process.env.WT_FAKE_API === "1"`, the entry point dynamically imports `../../tests/fake/fetch.ts` and `world.ts` and installs the fake as `globalThis.fetch` before running. It also adds a first caveat:

- en: `SYNTHETIC TEST DATA (WT_FAKE_API=1). Not real Wikipedia numbers; do not use for decisions.`
- uk: `СИНТЕТИЧНІ ТЕСТОВІ ДАНІ (WT_FAKE_API=1). Це не реальні цифри Wikipedia; не використовувати для рішень.`

The caveat must show in the JSON and the PDF, so an agent (or a person) can never mistake fake data for real. This mode exists for evals and demos; document it in README, not in SKILL.md.

### `package.json`

```jsonc
"scripts": {
  "typecheck": "tsc --noEmit",
  "test": "npm run typecheck && vitest run --project unit --project integration",
  "test:unit": "vitest run --project unit",
  "test:integration": "vitest run --project integration",
  "test:live": "WT_LIVE=1 vitest run --project live",
  "eval": "node evals/run.ts",
  "eval:trigger": "node evals/trigger.ts"
}
```

### `vitest.config.ts` (new)
Three projects:
- `unit`: `tests/unit/**/*.test.ts`;
- `integration`: `tests/integration/**/*.test.ts`, timeout 30 s;
- `live`: `tests/live/**/*.test.ts`, timeout 120 s, only runs when `WT_LIVE=1`.

### `tsconfig.json`
Include `tests`, `evals` and `vitest.config.ts` so they are type-checked too.

### `.github/workflows/test.yml` (new)
Node 22.18+, `npm ci`, `npm test`. No live tests and no evals in CI (network and cost).

## CLAUDE.md
Update "Commands" (test scripts) and the "no tests" line. Add a short "Testing" section: layers (unit / integration / live / evals), `WT_FAKE_API=1`, and where the fake world lives.

## Verification
1. `npm ci && npm test` runs (with zero or placeholder tests) and passes.
2. A throwaway test with `vi.stubGlobal("fetch", createFakeFetch(demoWorld()))` and `await runCli(["analyze", "--topic", "Astronomy", "--langs", "uk", "--out-dir", tmp])` returns `code: 0` and `ok: true`.
3. `WT_FAKE_API=1 scripts/wt analyze --topic "Mercury" --langs uk` → exit 2 with two candidates.
4. `WT_FAKE_API=1 scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2` → pl is `no_article` with `suggestions` containing `Głodówka lecznicza`; the first caveat is the SYNTHETIC one.
5. `npm audit` reports no high/critical issues from the new dev dependencies.
