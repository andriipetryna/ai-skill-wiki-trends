# wiki-trends (MVP)

A skill in the [Agent Skills](https://agentskills.io/specification) format for an AI agent. For a given topic it finds the matching articles across several Wikipedia language editions, pulls monthly pageviews from the Wikimedia Pageviews API, shows the change between periods, draws a chart and produces a one-page PDF report.

This is a minimum viable version: there is no caching yet (see next steps).

## Running

```bash
node --version                        # requires >= 22.18 (TypeScript runs natively, no build step)
export WT_CONTACT=you@example.com     # contact in the Wikimedia User-Agent (optional; defaults to skill@gmail.com)
scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2 --report --report-lang uk
```

The first run executes `npm ci --omit=dev` from `package-lock.json` on its own. To make the skill visible to the agent, copy or symlink this directory into `.claude/skills/wiki-trends` (Claude Code) or the equivalent location for another agent.

## Structure

```
wiki-trends/
├── SKILL.md              # instructions for the agent
├── references/
│   └── methodology.md    # formulas and thresholds; the agent reads it only when asked
├── package.json / package-lock.json / tsconfig.json / .nvmrc / vitest.config.ts
├── tests/
│   ├── fake/             # fake Wikimedia API: noise.ts (series generators), world.ts (synthetic data), fetch.ts (router)
│   ├── unit/             # pure functions
│   ├── integration/      # the CLI in-process against the fake API
│   └── live/             # smoke tests against the real APIs (WT_LIVE=1)
├── evals/                # task + triggering evals: the agent itself, graded automatically (see evals/README.md)
└── scripts/
    ├── wt                # entry point (bash): checks Node, installs dependencies
    └── src/
        ├── cli.ts        # resolve | analyze → a single JSON object on stdout
        ├── resolve.ts    # topic → Wikidata QID → article title in each language
        ├── client.ts     # Wikimedia REST (per-article + edition aggregate), MediaWiki API (incl. redirects), Wikidata; retry on 429/5xx
        ├── collect.ts    # monthly views (article + its redirects) + edition traffic, a "basket" of several topics, 12-month periods and % change
        ├── dates.ts      # month handling
        ├── charts.ts     # Vega-Lite → SVG (share per million), resvg → PNG
        ├── report.ts     # pdfkit → one-page PDF: findings, chart, table, notes, caveats (en/uk, Cyrillic via DejaVu)
        ├── text.ts       # all human-facing text: labels, findings, caveats (en/uk), answer checklist for the agent
        └── metrics/      # pure metric functions: stats helpers, normalisation; index.ts applies them in order
```

The results of each run are saved in `output/<timestamp>/` (or `<DIR>/wiki-trends-<timestamp>/` with `--out-dir DIR`):
- `data.json` — all data, including the per-month series;
- `chart.svg` and `chart.png` — the chart (the PNG is what the agent shows in chat);
- `report-<lang>.pdf` — the report, if run with `--report`.

## Commands

| Command | What it does |
|---|---|
| `resolve --topic T --langs pl,cs` | shows which articles match the topic in each language |
| `analyze --topic T [--topic T2] --langs pl,cs [--years N \| --months N \| --from YYYY-MM --to YYYY-MM] [--article pl="Tytuł"] [--no-redirects] [--weights growth=3] [--report --report-lang uk --title ... --notes ...] [--out-dir DIR]` | data, chart (SVG+PNG), optional PDF |

What `analyze` returns for each language:
- `totalViews` and `avgMonthlyViews` — view volume, including views of the article's redirects (old / alternative titles, up to 25 per article; `--no-redirects` turns this off);
- `redirectsIncluded` — how many redirect titles were summed in;
- `periods` — totals for consecutive 12-month blocks ending at the last complete month;
- `metrics.yoy` — year-over-year change: last 12 months vs the previous 12 (`method: "last12_vs_prev12"`; second half vs first half for ranges under 2 years). `sharePct` is on share per million with one-off spikes excluded (the headline number), `sharePctWithSpikes` on the share as is, `viewsPct` on raw views (spikes excluded) and `editionPct` on the whole edition, to explain why they can differ; `null` when there is nothing to compare with;
- `metrics.spikes` — one-off upward spikes (news, a Google Doodle, unfiltered bots): up to 5 months, by how many times (`xBaseline`) they exceed the 7-month rolling median. They are replaced by that baseline for YoY and marked with rings on the chart;
- `metrics.trend` — growth per year over the whole range: `sharePctPerYear` (share, spikes excluded; the headline), `viewsPctPerYear`, `editionPctPerYear`, from the seasonal Sen slope (median slope between the same calendar month in different years, so the yearly cycle is not mistaken for growth), plus `pValue` from the seasonal Mann–Kendall test (< 0.05: unlikely to be noise). Under 2 years the plain Theil–Sen / Mann–Kendall are used (`test: "mann_kendall"`);
- `metrics.verdict` — one word for the trend: `growing` / `declining` (|trend| ≥ 5 %/yr and p < 0.1), `flat` (|trend| < 5 %/yr) or `inconclusive`;
- `metrics.confidence` — how far the result can be trusted: `level` (`high` / `medium` / `low`), `score` (0–1) and `reasons` (`"+ …"` / `"- …"`), from rules on volume, history length, significance, spikes, YoY vs trend agreement, raw views vs share agreement and zero months. Low volume caps the level at `medium` (under 1000 views/month) or `low` (under 100), and so does a change driven by spikes (`medium`);
- `metrics.sharePerMillion` — views per million pageviews of the whole language edition (`median`, `last12Avg`); this is what makes languages comparable and removes edition-wide traffic shifts. The chart plots this share;
- `status: "no_article"` + `suggestions` — Wikidata has no article in this language, so the CLI searches for candidates in the edition itself; the chosen article can be passed via `--article pl="…"`.

Across languages, `analyze` also returns `ranking` — a suggested order in which to investigate the languages (only when at least 2 have data, otherwise `[]`). Each language gets four components, min-max normalised to 0–1 across the languages of the run (0.5 for everyone when a component does not vary): `volume` (log10 of median monthly views), `growth` (`trend.sharePctPerYear`, clamped to −100…200), `confidence` (`confidence.score`) and `share` (log10 of `sharePerMillion.last12Avg`). `score` is their weighted mean; the weights are set with `--weights volume=1,growth=1,confidence=1,share=0` (these are the defaults; any subset can be given) and echoed in `query.weights`. The ranking is relative: it only compares the languages of this run, under these weights. The PDF table is sorted by rank, with a "Suggested order to investigate" line under it.

For the agent, `analyze` also returns three fields generated for the exact result, so that even a cheap model answers correctly without computing anything:
- `findings` — ready-made sentences with all the key numbers (per language, relative interest by share per million, the ranking with its weights, edition-wide traffic shifts);
- `answerChecklist` — what the reply must contain (PDF path and chart first, low confidence, spikes, missing articles, how to compare languages, caveats);
- `caveats` — data-dependent limitations (interest ≠ willingness to pay, normalisation, period, search-matched topics, missing articles, manual articles, redirects, single article, cross-language, bots). `data.json` keeps them as codes so the PDF renders them in its own language.

Verified against real API responses: for "Intermittent fasting" (Q1666254) Wikidata has no Polish article; the closest is the broader "Głodówka lecznicza". So the first example from the task requires a decision from the user.

## Testing

```bash
npm test                  # typecheck + unit + integration (offline, against the fake API); live tests show as skipped; what CI runs
npm run test:unit
npm run test:integration
npm run test:live         # real Wikimedia APIs (WT_LIVE=1); set WT_CONTACT
```

**Task evals** (`evals/`, spec 13) run the agent itself (`claude -p`, Haiku by default) with the skill installed. The scenarios run against the synthetic world, and every transcript is graded: the command, one CLI call per turn, mentions, the PDF and chart delivered, the caveat, no own code, and every number in the answer traceable to the JSON. They cost money and are not in CI. Run them on every change to `SKILL.md` or the stdout JSON:

```bash
npm run eval                                        # all scenarios × 3 runs
node evals/run.ts --only astronomy-trust --runs 1   # one scenario
```

**Triggering evals** (spec 14) check that the agent picks the skill from its `description` alone, at the right time. They run labelled prompts (`evals/trigger-prompts.json`) of two kinds: prompts that should use the skill, and near misses that should not. The runner reports recall and precision per split. Run them on every change to the `description`:

```bash
npm run eval:trigger                                # all prompts × 3 runs
node evals/trigger.ts --description "…" --split dev # try a candidate description without editing SKILL.md
```

See `evals/README.md` for flags, graders and recorded results.

Run `npm run test:live` before a release and after touching `client.ts` or `resolve.ts`. It checks stable facts only (QIDs, titles, statuses, a one-page PDF), never view counts. `WT_CONTACT=you@example.com node tests/live/record-fixtures.ts` re-records one real response per API route into `tests/fake/recorded/`; `tests/unit/fake-shapes.test.ts` then checks that the fake API still answers in the same shapes, and fails until `tests/fake/fetch.ts` is updated when Wikimedia changes a format.

Integration tests run the whole pipeline in-process (`runCli` from `scripts/src/cli.ts`) against a fake Wikimedia API: `createFakeFetch(demoWorld())` from `tests/fake/` is installed with `vi.stubGlobal("fetch", …)`. It answers in the exact shapes of the real APIs, and every series in it is generated, so the right answers are known (they are written next to the data in `tests/fake/world.ts`).

**Synthetic mode.** `WT_FAKE_API=1 scripts/wt analyze …` runs the real CLI on the same fake world, with no network. It exists for evals and demos:

```bash
WT_FAKE_API=1 scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2   # pl: no_article + suggestions
WT_FAKE_API=1 scripts/wt analyze --topic "Mercury" --langs uk                            # ambiguous topic, exit 2
```

`WT_OUT_DIR=DIR` makes `DIR` the default `--out-dir` (the evals use it so each agent run writes into its own workspace).

The numbers are made up. Every result in this mode carries the first caveat `SYNTHETIC TEST DATA (WT_FAKE_API=1). Not real Wikipedia numbers; do not use for decisions.`, in the JSON and in the PDF. The fake world covers: Intermittent fasting (Q1666254; en, cs with a spike, pl only via search), Astronomy (Q333; uk, pl), English language (Q1860) + English as a second or foreign language (Q1321) in pl, cs, uk, de, hu, ro, and the ambiguous "Mercury". Any other topic or language is not found.

## Deliberately out of scope for the MVP (next steps)

1. **Caching.** Past months never change, so they can be cached forever; this will speed up follow-up queries.
