# 05 — Trend and significance: seasonal Sen + seasonal Mann–Kendall

## Why
YoY (03) compares only two points — two yearly blocks. We also need:
- **The size of the trend over the whole period** in percent per year. Here: the seasonal Sen slope.
- **Whether it is just noise.** For an article with 300 views, +10% a year can be chance. Here: the p-value of the seasonal Mann–Kendall test.

Why these methods:
- **Log.** A slope on `ln(share)` is directly a relative change: `%/yr = (e^(12·slope) − 1) × 100`.
- **Sen instead of least squares.** The Sen slope is the median of slopes between pairs of points, so one outlier barely affects it. Least squares pulls the line towards the outlier.
- **Seasonal variant.** Plain Theil–Sen uses all pairs, including "September–January", whose difference is seasonal. On synthetic data with a true +4%/yr, strong seasonality and 24 months it gave **+24.6%**. The seasonal variant uses only "same calendar month, different years" pairs and gave exactly **4.0%**.
- **Mann–Kendall.** Non-parametric: no normality assumption, it only looks at the signs of changes, robust to outliers and scale. The seasonal version (Hirsch et al., 1982) runs the test per calendar month and sums the results, so a yearly cycle is not mistaken for a trend. It is the standard companion of the seasonal Sen slope.

## Scope
- **In:** trend and test functions, the `metrics.trend` field, report columns.
- **Out:** verdict and confidence (06).

## Code changes

### `scripts/src/dates.ts`

```ts
/** Calendar month index 0..11 of a 'YYYY-MM' month. */
export function monthOfYear(m: Month): number
```

### `scripts/src/metrics/config.ts`

```ts
trend: {
  seasonalMinMonths: 24, // below this: plain Theil–Sen + plain Mann–Kendall
  period: 12,
},
```

### `scripts/src/metrics/trend.ts` (new)

```ts
/** Median of slopes over all pairs i<j: (y[j]-y[i])/(j-i). NaN if < 2 points. */
export function theilSen(y: readonly number[]): number

/** Median of slopes over pairs exactly k·period apart (k ≥ 1). NaN if none. */
export function seasonalSen(y: readonly number[], period = 12): number

export interface MkResult { s: number; varS: number; z: number; p: number }

/** Mann–Kendall trend test, two-sided p, normal approximation, tie correction. */
export function mannKendall(y: readonly number[]): MkResult

/** Seasonal Mann–Kendall: MK per calendar month, S and Var(S) summed. startMonth = monthOfYear of y[0]. */
export function seasonalMannKendall(y: readonly number[], startMonth: number, period = 12): MkResult

export interface TrendResult { pctPerYear: number; pValue: number; test: "seasonal_mann_kendall" | "mann_kendall" }

/** Robust growth + significance on log(values). */
export function monthlyTrend(values: readonly number[], startMonth: number): TrendResult
```

**Mann–Kendall** (series of length n):
1. `S = Σ_{i<j} sign(y[j] − y[i])`, where sign ∈ {−1, 0, +1}.
2. Tie correction: for every group of `t > 1` equal values,
   `Var(S) = [n(n−1)(2n+5) − Σ t(t−1)(2t+5)] / 18`.
3. If `Var(S) ≤ 0`, return `{ s, varS, z: 0, p: 1 }`.
4. `z = (S − 1)/√Var` if S > 0; `(S + 1)/√Var` if S < 0; `0` if S = 0 (continuity correction).
5. `p = 2 × (1 − normalCdf(|z|))`, clamped to [0, 1].

**Seasonal Mann–Kendall.**
- For each season `s ∈ 0..11`, take the sub-series of `y[i]` with `(startMonth + i) % 12 === s`.
- Skip sub-series with < 2 values.
- For the rest, compute S and Var(S) (steps 1–2) and sum both over seasons.
- Compute z and p from the sums (steps 3–5).

**`monthlyTrend`:**
1. `logs = safeLog(values)`.
2. `seasonal = values.length >= CONFIG.trend.seasonalMinMonths`.
3. `slope = seasonal ? seasonalSen(logs) : theilSen(logs)` (per month).
4. `pctPerYear = (exp(slope × 12) − 1) × 100`.
5. `mk = seasonal ? seasonalMannKendall(logs, startMonth) : mannKendall(logs)`.
6. Return `{ pctPerYear, pValue: mk.p, test }`.

Complexity is O(n²) pairs. For n ≤ 132 (11 years) that is up to ~8,700 pairs, which is fine; no optimisation needed.

### `scripts/src/metrics/index.ts`

```ts
trend: {
  sharePctPerYear: number;   // monthlyTrend(shareClean) — HEADLINE
  viewsPctPerYear: number;   // monthlyTrend(cleaned views)
  editionPctPerYear: number; // monthlyTrend(edition)
  pValue: number;            // from the share trend, 3 decimals
  test: TrendResult["test"];
}
```

`startMonth = monthOfYear(months[0])`. Percentages are rounded to 1 decimal.

### `scripts/src/report.ts`
Add columns "Trend/yr" / "Тренд/рік" (`metrics.trend.sharePctPerYear`, signed) and "p" (`<0.001` if p < 0.001, otherwise 3 decimals).

To make the table fit, drop the "Total views" and "Last 12 mo" columns. Remaining: Lang | Article | Avg / month | Per million | YoY share | Trend/yr | p.

## Output

```jsonc
"trend": { "sharePctPerYear": 17.9, "viewsPctPerYear": 3.5, "editionPctPerYear": -12.3, "pValue": 0, "test": "seasonal_mann_kendall" }   // illustrative
```

## SKILL.md
> `metrics.trend.sharePctPerYear` is the robust growth rate of the topic's share per year over the whole period; `pValue` < 0.05 means the trend is unlikely to be noise. Quote p < 0.001 as "p<0.001".

## Edge cases
- All values equal: `S = 0` and the tie-corrected `Var` can be 0 → `p = 1`.
- A season with a single value (18-month series): that season is skipped, but for < 24 months plain MK is used anyway.
- Zeros in the series: handled by `safeLog`.

## Verification
Use `gen` from `specs/README.md`. Percentages ±0.05, p ±0.0005.
1. `mannKendall([1,2,3,4,5])` → `s: 10`, `varS: 16.667`, `z: 2.2045`, `p: 0.0275`.
2. `mannKendall([1,2,2,3])` → `s: 5`, `varS: 7.667`, `z: 1.4446`, `p: 0.1486` (tie correction).
3. `mannKendall([5,5,5,5])` → `{ s: 0, varS: 0, z: 0, p: 1 }`.
4. `theilSen` on `y = 2i + 1` (20 points) with `y[7] = 500` → exactly 2.
5. Seasonal bias (regression case):

   ```ts
   const y = Array.from({ length: 24 }, (_, i) => Math.log(1000 * 1.04 ** (i / 12) * (1 + 0.35 * Math.cos((2 * Math.PI * (i + 4)) / 12))));
   ```

   - `(exp(seasonalSen(y)·12) − 1)·100` → 4.00;
   - `(exp(theilSen(y)·12) − 1)·100` → 24.61.
6. `monthlyTrend(gen(36, g, 0.35, 0.05, 5000), 0)`, all with `test: "seasonal_mann_kendall"`:

   | g | pctPerYear | pValue |
   |---|---|---|
   | −20 | −20.47 | 0 |
   | 0 | −0.60 | 0.8802 |
   | 15 | 14.30 | 0 |
   | 40 | 39.16 | 0 |

7. Real run: `trend` is present for every language with an article; the report columns fit.
