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

npm run typecheck   # tsc --noEmit — the only check; there are no tests yet
npm run wt -- ...   # same as scripts/wt but without the Node-version guard / auto-install
```

- **No build step.** TypeScript runs directly on Node >= 22.18 via native type stripping. `.ts` files import each other with explicit `.ts` extensions (`allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly` — so no enums/namespaces/param properties).
- `WT_CONTACT` (email or URL) should be set; it goes into the Wikimedia `User-Agent`. Without it requests may be blocked (HTTP 403).
- There are no tests, no linter, and no caching — deliberately deferred (see README "next steps").

## Architecture

Pipeline lives in `scripts/src/`, entry point `cli.ts`. Data flows one direction:

```
cli.ts        parse args, own the period window, write output files, format the stdout JSON
  └─ resolve.ts   topic (title or Qxxx) → Wikidata QID → article title per language
  └─ collect.ts   articles (+ their redirects) + edition traffic → monthly views → 12-month period totals + metrics
       └─ client.ts   all HTTP: Pageviews REST (per-article, aggregate), MediaWiki Action API (incl. redirects), Wikidata; retry, no cache
       └─ metrics/index.ts   computeLanguageMetrics(): applies metrics in order, rounds at the output boundary
            └─ stats.ts (median/mean/mad/normalCdf/round/safeLog), normalize.ts (share per million), yoy.ts (periodChange), spikes.ts (rollingMedian/detectSpikes), config.ts (thresholds)
  └─ charts.ts   perLanguage → Vega-Lite (sharePerMillion line + rings on spike months) → SVG string; svgToPng via resvg
  └─ report.ts   SVG + data → one-page A4 PDF (pdfkit + svg-to-pdfkit)
dates.ts        Month = 'YYYY-MM' UTC string; all date math goes through here
```

Key invariants — respect these when editing:

- **Every command prints exactly one JSON object to stdout** and nothing else (logs/errors go to stderr). Callers parse stdout. `ok: true|false` gates the shape.
- **Complete months only.** `lastCompleteMonth` steps back so in-progress months are never fetched; `FIRST_AVAILABLE_MONTH` (2015-07) clamps the start. Periods are consecutive 12-month blocks ending at `to` (`splitPeriods`), kept as transparent sums.
- **Multiple `--topic` = a basket**: their monthly views are summed per language.
- **Normalisation base**: for every language with an article, `editionMonthly` fetches the whole edition's user pageviews; 404 there is an `ApiError`. `metrics.sharePerMillion` = views / edition × 1e6 (edition 0 → 0). `metrics: null` for `no_article` / `no_data`.
- **YoY** (`metrics.yoy`): `periodChange` compares the sum of the last 12 months with the previous 12 (n ≥ 24, earlier months ignored) or second half vs first half (6 ≤ n < 24, no seasonality control); `null` if shorter or the base is 0. `sharePct` (on the spike-cleaned share, the headline) is computed first; `yoy` is `null` whenever it is. `sharePctWithSpikes` (on share as is), `viewsPct` (cleaned views) and `editionPct` give context.
- **Spikes** (`metrics.spikes`, `monthly[].spike`): `detectSpikes` runs on **raw views** first: 7-month centred rolling median as baseline, robust z-score (MAD) of log residuals > 3.5 **and** ≥ 1.8× baseline; upward only. `cleaned` replaces spikes with the baseline and feeds YoY (and later the trend); `sharePerMillion.median/last12Avg` stay on the raw share. Output lists the top 5 by ratio; the chart draws rings on every spike month, and the report caption about rings appears only when there are some.
- **Metric functions are pure** (`scripts/src/metrics/`): number arrays in, numbers out, full precision; rounding only in `metrics/index.ts`. Thresholds go in `metrics/config.ts`. Specs for upcoming metrics are in `.specs/`.
- **Redirects** (on by default, `--no-redirects` turns off): per language, each article's ns-0 redirects (≤ 25 per article, `client.redirects`) are added to the title set (deduplicated) and their views summed in; `redirectsIncluded` counts them. A failed redirects lookup is logged to stderr and skipped, never fatal. The report caveat follows the flag (`redirectsCaveat`).
- **`--article lang="Title"`** overrides the Wikidata-resolved article for that language (used after a user picks a `suggestion`).
- Failure modes are typed: `ResolveError` (ambiguous / not-found topic → exit 2, returns `candidates`) and `ApiError` (network/HTTP → exit 1). `cli.ts` maps them to `{ok:false, error, hint}`.
- Language handling: Wikipedia code → Wikidata sitelink key via `siteFor` (`uk` → `ukwiki`). Ukrainian is `uk`, not `ua`.

## Output

Each `analyze` run writes to `output/<YYYYMMDD-HHMMSS>/` (or `<DIR>/wiki-trends-<stamp>/` with `--out-dir DIR`): `data.json` (full data incl. per-month `monthly` series of `{month, views, editionViews, sharePerMillion}`), `chart.svg`, `chart.png` (resvg, DejaVu fonts — this is what the agent displays in chat, since hosts can't show SVG), and `report-<lang>.pdf` if `--report`. SKILL.md step 5 requires the agent to Read the PNG and embed/link the chart and PDF in every reply. `output/` is gitignored. Note the stdout JSON **strips the `monthly` arrays** (kept only in `data.json`) to keep the agent's context small.

## Report/chart notes

- Fonts: bundled DejaVu (`dejavu-fonts-ttf`) for Cyrillic support; PDF registers them as `"R"`/`"B"`.
- Report + chart are bilingual (`en`/`uk`) via the `LABELS` table in `report.ts`; `--report-lang` selects, default `en`.
- Never compare raw view counts across languages in output — editions differ hugely in size; compare `metrics.sharePerMillion.last12Avg` (level) and `metrics.yoy.sharePct` (direction). This rule is enforced in `SKILL.md`'s answer guidance.
