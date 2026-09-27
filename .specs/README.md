# Specs: metrics for the wiki-trends skill

Goal: turn the MVP (raw monthly pageviews + `changePct`) into a skill that answers three questions:
1. Is interest in the topic growing, once changes in the whole language edition's traffic are accounted for?
2. Is it a trend, noise, or a one-off spike?
3. How far can we trust it, and which language should be researched next?

## Implementation order

Each spec leaves the skill in a working state, so they can be merged one at a time.

| # | File | Adds | Depends on |
|---|---|---|---|
| 01 | `01-normalization.md` | edition traffic, share per million, the `metrics/` skeleton | — |
| 02 | `02-redirects.md` | pageviews of redirects (data quality) | — |
| 03 | `03-yoy.md` | year-over-year on share, replacing `changePct` | 01 |
| 04 | `04-spikes.md` | spike detection, cleaned series | 01, 03 |
| 05 | `05-trend-significance.md` | seasonal Sen slope, seasonal Mann–Kendall | 01, 04 |
| 06 | `06-verdict-confidence.md` | verdict, confidence with reasons | 03, 04, 05 |
| 07 | `07-ranking.md` | ranking of languages with user weights | 06 |
| 08 | `08-agent-output.md` | ready-made findings, answer checklist, SKILL.md, final PDF | 01–07 |

02 is independent and can be done at any point.

## How to give a spec to Claude Code

One spec per session / PR:

```
Read CLAUDE.md, specs/README.md and specs/03-yoy.md. Implement specs/03-yoy.md completely.
Then run the "Verification" section of the spec and show the results.
```

## Target code layout (after 08)

```
scripts/src/
├── cli.ts            # (changed) --weights, --no-redirects flags; JSON output
├── client.ts         # (changed) editionMonthly(), redirects()
├── collect.ts        # (changed) redirects, edition traffic, calls computeLanguageMetrics
├── resolve.ts
├── dates.ts          # (+ monthOfYear)
├── charts.ts         # (changed) share per million, rings on spikes (SVG → PNG unchanged)
├── report.ts         # (changed) new columns, findings
├── text.ts           # (new, 08) findings and caveats en/uk, answer checklist
└── metrics/
    ├── config.ts     # all thresholds
    ├── stats.ts      # median, mean, sum, mad, normalCdf, round, safeLog
    ├── normalize.ts  # 01
    ├── yoy.ts        # 03
    ├── spikes.ts     # 04
    ├── trend.ts      # 05
    ├── confidence.ts # 06
    ├── ranking.ts    # 07
    └── index.ts      # computeLanguageMetrics(): order in which metrics are applied
```

## Conventions (in addition to CLAUDE.md)

- **All numbers are computed by code.** The consuming agent (a cheap model such as Haiku) must never recompute, estimate or derive ratios. Anything it needs to say must already be in the JSON.
- **Metric functions are pure.** Arrays of numbers in, numbers or objects out. No network, no dates, no global state. This makes them easy to verify now and to cover with tests later.
- **Thresholds live in one place:** `scripts/src/metrics/config.ts`. No magic numbers in metric code.
- **Series** are arrays of equal length aligned to `monthRange(from, to)`. Months without data are zero-filled (the MVP already does this).
- **Round only at the output boundary** (`metrics/index.ts` and the JSON builder). Use full precision internally, including as input to later metrics.

  | What | Precision |
  |---|---|
  | percentages | 1 decimal |
  | p-values | 3 decimals |
  | share per million | 2 decimals |
  | scores | 2 decimals |
  | views | integer |

- **JSON field names** are camelCase English. Code comments and JSON messages are English. Report texts are en/uk via the existing `LABELS` pattern in `report.ts` (moved to `text.ts` in 08).
- **Chart.** `charts.ts` renders an SVG that is also rasterised to `chart.png` (resvg). Changes to the Vega-Lite spec therefore apply to both files automatically. After a chart change, look at the PNG.
- **Deterministic noise for verification** (shared by all specs):

  ```ts
  const noise = (i: number) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  // n months, growth g %/yr, seasonal amplitude season, noise level nz, base level base, phase shift phase
  const gen = (n: number, g: number, season: number, nz: number, base: number, phase = 0) =>
    Array.from({ length: n }, (_, i) =>
      Math.round(base * (1 + g / 100) ** (i / 12) * (1 + season * Math.cos((2 * Math.PI * (i + phase)) / 12)) * (1 + nz * noise(i))));
  ```

## Verification without tests

There is no test framework yet. Each spec has a "Verification" section:
1. Write a throwaway script in `/tmp` (do not commit it) that imports functions from `scripts/src/metrics/*.ts` and prints the results.
2. Run it with `node --disable-warning=ExperimentalWarning /tmp/check.ts`.
3. Compare against the expected values in the spec.

The expected numbers were produced by a reference implementation. Tolerance is the last rounded digit unless stated otherwise. Also always run `npm run typecheck` and do one manual `scripts/wt analyze` run on real data.

When tests are added later, the "Verification" sections become ready-made test cases.

## Definition of Done (every spec)

- [ ] Everything in "Code changes" and "Output" is implemented.
- [ ] `npm run typecheck` passes.
- [ ] Every item in "Verification" produces the expected values.
- [ ] `scripts/wt analyze ... --report --report-lang uk` works on real data; the PDF has exactly one page; `chart.png` looks right.
- [ ] `SKILL.md` is updated where the agent-facing output changed; `metadata.version` and `VERSION` are bumped (minor).
- [ ] `CLAUDE.md` "Architecture" is updated if modules were added.
- [ ] No new dependencies.
