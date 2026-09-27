# 04 — Spike detection

## Why
A single month with news (a celebrity's death, a Google Doodle, a viral post, a TV series), or a bot that Wikimedia did not filter out, can double a yearly total. YoY then shows "+40%" even though the steady interest did not change.

Spikes must be:
1. **found** and shown to the user;
2. **excluded** from the trend calculation (05);
3. **measured**: how much the result depends on them. For this, YoY is computed with and without spikes, and 06 compares the two.

## Scope
- **In:**
  - the detector;
  - the cleaned series;
  - YoY with and without spikes;
  - the `spikes` field;
  - marks on the chart.
- **Out:** downward dips (data-collection outages): upward spikes only.

## Code changes

### `scripts/src/metrics/config.ts`

```ts
spikes: {
  window: 7,        // centred rolling-median window, months
  zThreshold: 3.5,  // robust z-score on log residuals
  minRatio: 1.8,    // AND at least this many times the baseline
  minScale: 0.05,   // floor for the robust scale (flat series)
},
```

### `scripts/src/metrics/spikes.ts` (new)

```ts
export function rollingMedian(xs: readonly number[], window: number): number[]

export interface Spike { index: number; value: number; baseline: number; ratio: number }

export function detectSpikes(xs: readonly number[], opts = CONFIG.spikes): { spikes: Spike[]; cleaned: number[] }
```

`rollingMedian`: for each `i`, the median of `xs[max(0, i−half) .. min(n−1, i+half)]`, where `half = floor(window/2)`. At the edges the window simply gets shorter.

`detectSpikes`:
1. `b = rollingMedian(xs, window)` — the baseline. A median is not pulled towards the spike itself: one ×5 among 7 values barely moves it.
2. `r[i] = ln(1 + xs[i]) − ln(1 + b[i])` — log residual. The log makes "×2" the same for an article with 100 views and one with 100,000.
3. `scale = max(1.4826 × mad(r), minScale)`. MAD is a robust analogue of the standard deviation: spikes do not inflate it. The factor 1.4826 makes it comparable to σ for a normal distribution.
4. `z[i] = (r[i] − median(r)) / scale`.
5. It is a spike if `z[i] > zThreshold` **and** `b[i] > 0` **and** `xs[i] / b[i] ≥ minRatio`. The ratio condition filters out seasonal peaks (×1.3–1.5, e.g. September for education topics), which can have a large z on an otherwise flat series.
6. `cleaned` = a copy of `xs` where every spike is replaced by `b[i]`.

### `scripts/src/metrics/index.ts`
Order inside `computeLanguageMetrics`:
1. `{ spikes, cleaned } = detectSpikes(views)`. Spikes are detected on **raw views**, because they are events in the article itself.
2. `share = sharePerMillion(views, edition)`; `shareClean = sharePerMillion(cleaned, edition)`.
3. `yoy.sharePct` is computed on `shareClean`; the new field `yoy.sharePctWithSpikes` on `share`. `yoy.viewsPct` uses `cleaned`, `yoy.editionPct` uses `edition`.
4. `sharePerMillion.median/last12Avg` use `share` as is: they describe facts, not the trend.

New fields:

```ts
spikes: Array<{ month: Month; views: number; xBaseline: number }>; // top 5 by ratio; xBaseline = ratio rounded to 1 decimal
yoy: { ...; sharePctWithSpikes: number | null } | null;
```

`points[i].spike: boolean` — for the chart.

### `scripts/src/charts.ts`
Add a second Vega-Lite layer: `transform: [{ filter: "datum.spike" }]`, `mark: { type: "point", size: 70, strokeWidth: 2, filled: false }`, same colour scale. The rings show the months excluded from the trend.

Do not duplicate the legend: use the same colour encoding in both layers. Check the PNG.

### `scripts/src/report.ts`
- Small caption under the chart: en "Rings = one-off spikes, excluded from YoY and trend." / uk "Кільця = разові сплески, виключені з рік-до-року і тренду."
- Remove the MVP caveat saying one-off news spikes are included.

## Output

```jsonc
"metrics": {
  ...,
  "yoy": { "method": "last12_vs_prev12", "sharePct": 3.3, "sharePctWithSpikes": 21.7, "viewsPct": 3.5, "editionPct": 0.3 },
  "spikes": [{ "month": "2025-10", "views": 17798, "xBaseline": 5.4 }]   // illustrative
}
```

## SKILL.md
> If `metrics.spikes` is non-empty, name the months: these are one-off events (news etc.) and are excluded from YoY and trend. If `yoy.sharePctWithSpikes` differs a lot from `yoy.sharePct`, say that the apparent change was driven by spikes.

## Edge cases
- Series with zeros (small article): `ln(1+0)` is fine; `b[i] = 0` → never a spike.
- Two spikes in a row: a median of 7 values survives 3 outliers, so both are found.
- Spike in the first or last month: the window is shorter; the algorithm still works.

## Verification
Use `gen` from `specs/README.md`.
1. `const flat = gen(36, 0, 0, 0.05, 1000); flat[20] *= 5;` → `detectSpikes(flat)`:
   - exactly one spike: `index: 20`, `value: 5185`, `baseline: 1021`, `ratio ≈ 5.08`;
   - `cleaned[20] = 1021`.
2. `detectSpikes(gen(36, 10, 0.35, 0.05, 1000)).spikes.length` → `0` (seasonal peaks are not spikes).
3. `rollingMedian([1, 9, 1, 1, 1], 3)` → `[5, 1, 1, 1, 1]`.
4. Real run for a topic with a known news event (e.g. an article about a person who died last year): the spike is found in the right month and the chart has a ring there.
