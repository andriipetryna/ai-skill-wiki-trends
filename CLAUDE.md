# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`**wiki-trends**` is an **Agent Skill** (see `SKILL.md`), not a general app. It is a bundled CLI that, for a topic, finds the matching Wikipedia articles across language editions, pulls monthly pageviews from the Wikimedia Pageviews API, computes year-over-year change of the topic's share of edition traffic, and optionally renders a chart and a one-page PDF report. `SKILL.md` is the contract the consuming agent reads; keep it in sync with CLI behaviour and the `metadata.version` / `VERSION` fields.

## Commands

```bash
# Run the CLI (bash launcher — checks Node >= 22.18, runs `npm ci --omit=dev` on first run)
scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2
scripts/wt resolve --topic "Astronomy" --langs uk,pl
scripts/wt --help

npm run typecheck         # tsc --noEmit (also covers tests/, evals/, vitest.config.ts)
npm test                  # typecheck + vitest unit + integration projects (offline); what CI runs
npm run test:unit         # vitest --project unit
npm run test:integration  # vitest --project integration
npm run test:live         # WT_LIVE=1, real Wikimedia APIs; never in CI
npx vitest run tests/unit/fake-noise.test.ts   # a single file
npm run wt -- ...         # same as scripts/wt but without the Node-version guard / auto-install
WT_FAKE_API=1 scripts/wt analyze ...           # real CLI on synthetic data, no network (see Testing)
```

- **No build step.** TypeScript runs directly on Node >= 22.18 via native type stripping. `.ts` files import each other with explicit `.ts` extensions (`allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly` — so no enums/namespaces/param properties).
- `WT_CONTACT` (email or URL) goes into the Wikimedia `User-Agent`; unset or empty → `skill@gmail.com` (`DEFAULT_CONTACT` in `client.ts`). Set your own to avoid being blocked (HTTP 403) or rate-limited along with everyone else using the default.
- There is no linter and no caching — deliberately deferred (see README "next steps").

## Architecture

Pipeline lives in `scripts/src/`, entry point `cli.ts`. Data flows one direction:

```
cli.ts        runCli(argv) → { code, output }: dispatch the command, write output files, format the stdout JSON
  └─ args.ts      parseCliArgs(argv, now) → options (incl. the period window, --weights) or a usage error; pure
  └─ resolve.ts   topic (title or Qxxx) → Wikidata QID → article title per language
  └─ collect.ts   articles (+ their redirects) + edition traffic → monthly views → 12-month period totals + metrics
       └─ client.ts   all HTTP: Pageviews REST (per-article, aggregate), MediaWiki Action API (incl. redirects), Wikidata; retry, no cache
       └─ metrics/index.ts   computeLanguageMetrics(): applies metrics in order, rounds at the output boundary
            └─ stats.ts (median/mean/mad/normalCdf/round/safeLog), normalize.ts (share per million), yoy.ts (periodChange), spikes.ts (rollingMedian/detectSpikes), trend.ts (theilSen/seasonalSen/mannKendall/seasonalMannKendall/monthlyTrend), confidence.ts (verdictFor/assessConfidence), ranking.ts (rankLanguages), config.ts (thresholds)
  └─ charts.ts   perLanguage → Vega-Lite (sharePerMillion line + rings on spike months) → SVG string; svgToPng via resvg
  └─ text.ts     all human-facing text: LABELS (en/uk), formatters, buildFindings, buildCaveats/renderCaveat, buildAnswerChecklist
  └─ report.ts   data → one-page A4 PDF (pdfkit + svg-to-pdfkit); renders its own chart at a page-fitting height
dates.ts        Month = 'YYYY-MM' UTC string; all date math goes through here
```

Key invariants — respect these when editing:

- **Every command prints exactly one JSON object to stdout** and nothing else (logs/errors go to stderr). Callers parse stdout. `ok: true|false` gates the shape.
- **Complete months only.** `lastCompleteMonth` steps back so in-progress months are never fetched; `FIRST_AVAILABLE_MONTH` (2015-07) clamps the start. Periods are consecutive 12-month blocks ending at `to` (`splitPeriods`), kept as transparent sums.
- **Multiple `--topic` = a basket**: their monthly views are summed per language.
- **Normalisation base**: for every language with an article, `editionMonthly` fetches the whole edition's user pageviews; 404 there is an `ApiError`. `metrics.sharePerMillion` = views / edition × 1e6 (edition 0 → 0). `metrics: null` for `no_article` / `no_data`.
- **YoY** (`metrics.yoy`): `periodChange` compares the sum of the last 12 months with the previous 12 (n ≥ 24, earlier months ignored) or second half vs first half (6 ≤ n < 24, no seasonality control); `null` if shorter or the base is 0. `sharePct` (on the spike-cleaned share, the headline) is computed first; `yoy` is `null` whenever it is. `sharePctWithSpikes` (on share as is), `viewsPct` (cleaned views) and `editionPct` give context.
- **Spikes** (`metrics.spikes`, `monthly[].spike`): `detectSpikes` runs on **raw views** first: 7-month centred rolling median as baseline, robust z-score (MAD) of log residuals > 3.5 **and** ≥ 1.8× baseline; upward only. `cleaned` replaces spikes with the baseline and feeds YoY and the trend; `sharePerMillion.median/last12Avg` stay on the raw share. Output lists the top 5 by ratio; the chart draws rings on every spike month, and the report footer's note about rings appears only when there are some.
- **Trend** (`metrics.trend`): `monthlyTrend` on `safeLog` values; n ≥ 24 → seasonal Sen slope (pairs exactly k·12 months apart) + seasonal Mann–Kendall (per calendar month, `startMonth = monthOfYear(months[0])`, S and Var(S) summed); shorter → plain Theil–Sen + plain MK (`test` says which). `%/yr = (e^(12·slope) − 1) × 100`. `sharePctPerYear` (cleaned share, the headline) and its `pValue` (3 decimals); `viewsPctPerYear` (cleaned views) and `editionPctPerYear` for context. `null` with < 2 months. Report columns "Trend/yr" and "p" (`<0.001`).
- **Verdict & confidence** (`metrics.verdict`, `metrics.confidence`): `verdictFor(trend %/yr, p)` on full-precision values: |trend| < 5 → `flat`, else p < 0.1 → `growing`/`declining`, else `inconclusive` (also with < 2 months). `assessConfidence` is rule-based: score starts at 1, rules applied in a fixed order (volume, short history, significance, spike-driven / recent spike, YoY vs trend signs, views vs share signs, zero months), each appends a reason; level from score (≥ 0.7 high, ≥ 0.4 medium), then capped (volume < 100 → low, < 1000 → medium, spike-driven → medium). It gets **unrounded** YoY/trend inputs. JSON `reasons` are strings `"{+|-} {message}"`. Report columns "Verdict"/"Confidence", translated via `LABELS.verdicts/levels`.
- **Ranking** (top-level `ranking`, `query.weights`): `collect` keeps full-precision `rankInput` per language from `computeLanguageMetrics` (median views, share trend %/yr, confidence score, last-12 share; not in the JSON) and calls `rankLanguages` only when ≥ 2 languages have metrics, else `[]`. Components: volume = log10(max(1, views)), growth = trend clamped to [−100, 200], confidence = score, share = log10(max(1e-6, share)); each min-max normalised across the run (range < 1e-12 → 0.5). `score = Σ w·c / Σw` (Σw = 0 → divisor 1); sorted on full precision by score, confidence, volume desc, lang asc, then rounded to 2 decimals. `--weights k=v,...` (keys volume/growth/confidence/share, non-negative; missing keys from `DEFAULT_WEIGHTS` = 1/1/1/0) is validated in `args.ts` before any request (exit 2 + hint). The report table is sorted by rank (no-data languages last in `--langs` order); the "Suggested order to investigate" line (`rankingLine`, `LABELS.ranking/weights/weightNames`) is one of the findings.
- **Metric functions are pure** (`scripts/src/metrics/`): number arrays in, numbers out, full precision; rounding only in `metrics/index.ts`. Thresholds go in `metrics/config.ts`. Specs for upcoming metrics are in `.specs/`.
- **Redirects** (on by default, `--no-redirects` turns off): per language, each article's ns-0 redirects (≤ 25 per article, `client.redirects`) are added to the title set (deduplicated) and their views summed in; `redirectsIncluded` counts them. A failed redirects lookup is logged to stderr and skipped, never fatal. The caveat follows the flag (`redirects_on` / `redirects_off`).
- **Agent-facing output** (`text.ts`, spec 08): `analyze` stdout adds `findings` (ready-made English sentences with every key number: per language in `--langs` order, "Relative interest" by `last12Avg` when ≥ 2 languages have metrics, the ranking line, and an edition-shift note when |`editionPctPerYear`| ≥ `CONFIG.findings.editionShiftPctPerYear`), `answerChecklist` (English instructions for this exact result; the PDF-path item first when `--report`, then the chart item) and `caveats` (English strings). Caveats are built as codes (`{ code, params? }`, `buildCaveats`) and stored that way in `data.json`, then rendered with `renderCaveat(c, lang)`. Findings/checklist only format numbers already in the result (`signed`, `pfmt`, `int`); never compute new ones there.
- **`--article lang="Title"`** overrides the Wikidata-resolved article for that language (used after a user picks a `suggestion`).
- Failure modes are typed: `ResolveError` (ambiguous / not-found topic → exit 2, returns `candidates`) and `ApiError` (network/HTTP → exit 1). `cli.ts` maps them to `{ok:false, error, hint}`.
- Language handling: Wikipedia code → Wikidata sitelink key via `siteFor` (`uk` → `ukwiki`). Ukrainian is `uk`, not `ua`.

## Testing

Specs 09–14 in `.specs/`. Layers (vitest projects in `vitest.config.ts`):
- **unit** (`tests/unit/`, one file per source module; `tests/unit/metrics/` mirrors `scripts/src/metrics/`): pure functions; series from `gen()` / `genSeries()` in `tests/fake/noise.ts`, never long hand-typed arrays. Every "Verification" item of specs 01–08 is ported as a test (spec 10); a failing ported value means check the code against the spec first. Every bug fix adds a test named `regression: <what broke>`.
- **integration** (`tests/integration/`, 30 s timeout): `runCli([...args, "--out-dir", tmp])` in-process with `vi.stubGlobal("fetch", createFakeFetch(demoWorld()))`, `vi.setSystemTime(...)` for the clock (the CLI reads `new Date()`) and `CLIENT_CONFIG.retryBaseMs = 0` so retries do not sleep.
- **live** (`tests/live/`, 120 s): real APIs, only collected when `WT_LIVE=1`.
- **evals** (`evals/`, `npm run eval`): the agent end to end on the synthetic world; not in CI.

Fake Wikimedia API (`tests/fake/`): `noise.ts` (deterministic `noise`/`gen`/`genSeries`, and `gens.growth(base, %/yr, {season, peak, noise, seed, spikes})` anchored at 2024-07), `world.ts` (`FakeWorld` + `demoWorld()`; ground truth in the comment above it — change the data and that comment together), `fetch.ts` (`createFakeFetch(world, { failFirst?, failStatus? })`, routes by URL, records `.calls` and `.unknown`; unknown routes get `404 { error: "unknown fake route" }`). Responses must match the real shapes (route table in spec 09): e.g. months with 0 views are omitted, search `pages` are not sorted by `index`. `tests/fake/` must not import dev dependencies: the CLI loads it at runtime.

`WT_FAKE_API=1`: the entry point in `cli.ts` dynamically imports `tests/fake/` and replaces `globalThis.fetch` before `runCli`; `runCli` then prepends the `synthetic` caveat (JSON and PDF). Documented in README only, not in SKILL.md.

## Output

Each `analyze` run writes to `output/<YYYYMMDD-HHMMSS>/` (or `<DIR>/wiki-trends-<stamp>/` with `--out-dir DIR`): `data.json` (full data incl. per-month `monthly` series of `{month, views, editionViews, sharePerMillion, spike}` and the structured `caveats`), `chart.svg`, `chart.png` (resvg, DejaVu fonts — this is what the agent displays in chat, since hosts can't show SVG), and `report-<lang>.pdf` if `--report`. SKILL.md step 5 requires the agent to Read the PNG and embed/link the chart and PDF in every reply. `output/` is gitignored. Note the stdout JSON **strips the `monthly` arrays** (kept only in `data.json`) to keep the agent's context small.

## Report/chart notes

- Fonts: bundled DejaVu (`dejavu-fonts-ttf`) for Cyrillic support; PDF registers them as `"R"`/`"B"`.
- Report + chart are bilingual (`en`/`uk`) via the `LABELS` table in `text.ts`; `--report-lang` selects, default `en`.
- Report layout (one A4 page, never more): title + meta → "Key findings" (`buildFindings`, ≤ 9, 8.8 pt) → chart (target height 270/235/200 pt for ≤ 4 / 5–6 / > 6 findings; `chartForHeight` re-renders with a matching Vega plot height) → table by rank (8 pt, 9 columns summing to 523 pt) → `--notes` (≤ 600 chars, clipped to the space left) → "Assumptions & limitations" (as many caveats as fit) → footer. Every section checks the space left, since pdfkit silently adds a page on overflow.
- svg-to-pdfkit sizes an SVG by its root `width`/`height`, so those are stripped before embedding (only the `viewBox` is kept). The chart's y title is split over two lines: a one-line title longer than the plot stretches the SVG bounds.
- Never compare raw view counts across languages in output — editions differ hugely in size; compare `metrics.sharePerMillion.last12Avg` (level) and `metrics.yoy.sharePct` (direction). This rule is enforced in `SKILL.md`'s answer guidance.
