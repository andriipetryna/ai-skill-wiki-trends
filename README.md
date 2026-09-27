# wiki-trends (MVP)

A skill in the [Agent Skills](https://agentskills.io/specification) format for an AI agent. For a given topic it finds the matching articles across several Wikipedia language editions, pulls monthly pageviews from the Wikimedia Pageviews API, shows the change between periods, draws a chart and produces a one-page PDF report.

This is a minimum viable version: no trend metrics, no caching and no tests. These are deliberately deferred to later iterations.

## Running

```bash
node --version                        # requires >= 22.18 (TypeScript runs natively, no build step)
export WT_CONTACT=you@example.com     # Wikimedia requires a contact in the User-Agent
scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2 --report --report-lang uk
```

The first run executes `npm ci --omit=dev` from `package-lock.json` on its own. To make the skill visible to the agent, copy or symlink this directory into `.claude/skills/wiki-trends` (Claude Code) or the equivalent location for another agent.

## Structure

```
wiki-trends/
├── SKILL.md              # instructions for the agent
├── package.json / package-lock.json / tsconfig.json / .nvmrc
└── scripts/
    ├── wt                # entry point (bash): checks Node, installs dependencies
    └── src/
        ├── cli.ts        # resolve | analyze → a single JSON object on stdout
        ├── resolve.ts    # topic → Wikidata QID → article title in each language
        ├── client.ts     # Wikimedia REST (per-article + edition aggregate), MediaWiki API (incl. redirects), Wikidata; retry on 429/5xx
        ├── collect.ts    # monthly views (article + its redirects) + edition traffic, a "basket" of several topics, 12-month periods and % change
        ├── dates.ts      # month handling
        ├── charts.ts     # Vega-Lite → SVG (share per million), resvg → PNG
        ├── report.ts     # pdfkit → one-page PDF (en/uk, Cyrillic via DejaVu)
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
| `analyze --topic T [--topic T2] --langs pl,cs [--years N \| --months N \| --from YYYY-MM --to YYYY-MM] [--article pl="Tytuł"] [--no-redirects] [--report --report-lang uk --title ... --notes ...] [--out-dir DIR]` | data, chart (SVG+PNG), optional PDF |

What `analyze` returns for each language:
- `totalViews` and `avgMonthlyViews` — view volume, including views of the article's redirects (old / alternative titles, up to 25 per article; `--no-redirects` turns this off);
- `redirectsIncluded` — how many redirect titles were summed in;
- `periods` — totals for consecutive 12-month blocks ending at the last complete month;
- `metrics.yoy` — year-over-year change: last 12 months vs the previous 12 (`method: "last12_vs_prev12"`; second half vs first half for ranges under 2 years). `sharePct` is on share per million with one-off spikes excluded (the headline number), `sharePctWithSpikes` on the share as is, `viewsPct` on raw views (spikes excluded) and `editionPct` on the whole edition, to explain why they can differ; `null` when there is nothing to compare with;
- `metrics.spikes` — one-off upward spikes (news, a Google Doodle, unfiltered bots): up to 5 months, by how many times (`xBaseline`) they exceed the 7-month rolling median. They are replaced by that baseline for YoY and marked with rings on the chart;
- `metrics.sharePerMillion` — views per million pageviews of the whole language edition (`median`, `last12Avg`); this is what makes languages comparable and removes edition-wide traffic shifts. The chart plots this share;
- `status: "no_article"` + `suggestions` — Wikidata has no article in this language, so the CLI searches for candidates in the edition itself; the chosen article can be passed via `--article pl="…"`.

Verified against real API responses: for "Intermittent fasting" (Q1666254) Wikidata has no Polish article; the closest is the broader "Głodówka lecznicza". So the first example from the task requires a decision from the user.

## Deliberately out of scope for the MVP (next steps)

1. **Metrics:**
   - seasonal trend and significance (seasonal Sen / Mann–Kendall);
   - confidence score with explanations;
   - ranking languages by user-defined weights.
2. **Caching.** Past months never change, so they can be cached forever; this will speed up follow-up queries.
3. **Tests and evals:**
   - unit tests on synthetic data with a known answer;
   - e2e tests against a fake API;
   - agent runs on a cheap model, checking that every number in the answer is present in the JSON.
