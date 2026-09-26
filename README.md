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
        ├── client.ts     # Wikimedia REST, MediaWiki API, Wikidata; retry on 429/5xx
        ├── collect.ts    # monthly views, a "basket" of several topics, 12-month periods and % change
        ├── dates.ts      # month handling
        ├── charts.ts     # Vega-Lite → SVG
        └── report.ts     # pdfkit → one-page PDF (en/uk, Cyrillic via DejaVu)
```

The results of each run are saved in `output/<timestamp>/`:
- `data.json` — all data, including the per-month series;
- `chart.svg` — the chart;
- `report-<lang>.pdf` — the report, if run with `--report`.

## Commands

| Command | What it does |
|---|---|
| `resolve --topic T --langs pl,cs` | shows which articles match the topic in each language |
| `analyze --topic T [--topic T2] --langs pl,cs [--years N \| --months N \| --from YYYY-MM --to YYYY-MM] [--article pl="Tytuł"] [--report --report-lang uk --title ... --notes ...]` | data, chart, optional PDF |

What `analyze` returns for each language:
- `totalViews` and `avgMonthlyViews` — view volume;
- `periods` — totals for consecutive 12-month blocks ending at the last complete month;
- `changePct` — change of the last block relative to the previous one;
- `status: "no_article"` + `suggestions` — Wikidata has no article in this language, so the CLI searches for candidates in the edition itself; the chosen article can be passed via `--article pl="…"`.

Verified against real API responses: for "Intermittent fasting" (Q1666254) Wikidata has no Polish article; the closest is the broader "Głodówka lecznicza". So the first example from the task requires a decision from the user.

## Deliberately out of scope for the MVP (next steps)

1. **Metrics:**
   - normalization against the language edition's total traffic;
   - seasonal trend and significance (seasonal Sen / Mann–Kendall);
   - detection of one-off spikes;
   - confidence score with explanations;
   - ranking languages by user-defined weights.
2. **Caching.** Past months never change, so they can be cached forever; this will speed up follow-up queries.
3. **Redirects.** Summing views of alternative titles so that renamed articles don't produce an artificial drop.
4. **Tests and evals:**
   - unit tests on synthetic data with a known answer;
   - e2e tests against a fake API;
   - agent runs on a cheap model, checking that every number in the answer is present in the JSON.
