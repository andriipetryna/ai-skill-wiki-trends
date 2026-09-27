# 03 — Year-over-year (YoY) on share

## Why
YoY is the most business-friendly number: "interest grew 18% over the last year".

Comparing the sum of the last 12 months with the previous 12 removes seasonality automatically: each block contains exactly one September, one January and so on. It must be computed on **share** (01), not on raw views.

The raw-views and whole-edition variants stay for context. They let the agent explain why conclusions can differ.

The MVP's `changePct` is replaced by `metrics.yoy`.

## Scope
- **In:**
  - `periodChange` function;
  - `metrics.yoy` field;
  - removal of `changePct`;
  - report columns.
- **Out:** cleaning spikes (04 does that and extends `yoy`).

## Code changes

### `scripts/src/metrics/yoy.ts` (new)

```ts
export interface PeriodChange {
  method: "last12_vs_prev12" | "second_half_vs_first_half";
  pct: number; // full precision
}

export function periodChange(values: readonly number[]): PeriodChange | null
```

Algorithm (n = series length):
- **n ≥ 24:** `last = sum(values[n-12 .. n-1])`, `prev = sum(values[n-24 .. n-13])`. If `prev > 0`, return `{ method: "last12_vs_prev12", pct: (last / prev − 1) × 100 }`, else `null`.
- **6 ≤ n < 24:** `h = floor(n / 2)`; `first = sum(values[0 .. h-1])`, `second = sum(values[n-h .. n-1])`. If `first > 0`, return `{ method: "second_half_vs_first_half", pct }`, else `null`. This method does **not** control for seasonality; 06 lowers confidence for it.
- **n < 6:** `null`.

The function works on any series: share, raw views, edition traffic.

### `scripts/src/metrics/index.ts`
Extend `LanguageMetrics`:

```ts
yoy: {
  method: PeriodChange["method"];
  sharePct: number;          // on share per million — the headline YoY
  viewsPct: number | null;   // on raw views
  editionPct: number | null; // on the whole edition's views
} | null;                    // null when periodChange(share) is null
```

Rounded to 1 decimal.

### `scripts/src/collect.ts`
- Remove `changePct` from `LanguageResult` and from the collection code.
- Keep `periods`: they are transparent sums and useful for the table.

### `scripts/src/report.ts`
- Replace the "Change" / "Зміна" column with "YoY share" / "Рік-до-року", value `metrics.yoy.sharePct` with a sign (`+17.8%`, `-4.3%`, `—` if `null`).
- In the footer replace "Change = …" with en "YoY = last 12 months vs the previous 12, on share per million." / uk "Рік-до-року = останні 12 міс. проти попередніх 12, на частці на мільйон."

## Output

```jsonc
"metrics": {
  "months": 36, "medianMonthlyViews": 9011,
  "sharePerMillion": { "median": 81.3, "last12Avg": 97.54 },
  "yoy": { "method": "last12_vs_prev12", "sharePct": 17.8, "viewsPct": 3.5, "editionPct": -12.1 }   // illustrative
}
```

## SKILL.md
- Remove every mention of `changePct` (also in `CLAUDE.md`).
- Add:
  > `metrics.yoy.sharePct` = change of the topic's share of edition traffic, last 12 months vs the previous 12. `viewsPct` (raw views) and `editionPct` (whole edition) explain differences: if the edition shrinks, raw views can fall while interest (share) grows.
  > If `yoy.method` is `second_half_vs_first_half`, say the period is shorter than 2 years, so seasonality is not controlled.

## Edge cases
- The previous block is 0 (article is new): `yoy` = `null`. The agent must say there is nothing to compare with.
- Period is not a multiple of 12 (e.g. 30 months): only the last 24 are used; the first 6 months do not enter YoY.

## Verification
1. `periodChange([...Array(12).fill(100), ...Array(12).fill(150)])` → `{ method: "last12_vs_prev12", pct: 50 }`.
2. `periodChange([1,1,1,2,2,2])` → `{ method: "second_half_vs_first_half", pct: 100 }`.
3. `periodChange([1,2,3])` → `null`.
4. `periodChange([...Array(12).fill(0), ...Array(12).fill(5)])` → `null` (previous block is zero).
5. Real run: every language with an article has `metrics.yoy`, there is no `changePct`, and the PDF shows the "Рік-до-року" column.
