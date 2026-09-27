# 01 — Normalization: share of the language edition's traffic

## Why
Traffic of whole Wikipedia editions changes a lot for reasons unrelated to any topic: mobile apps, AI answers in search, audience shifts. If the whole edition loses 12% a year and the article loses 2%, interest in the topic has relatively **grown**. Raw views cannot show this.

Share per million pageviews of the edition:
- removes this effect;
- makes languages comparable (raw 20,000 views in de and 3,000 in hu cannot be compared).

## Scope
- **In:**
  - fetching the edition's total traffic;
  - computing the share;
  - the `scripts/src/metrics/` skeleton;
  - share in the chart and the report.
- **Out:** trend, YoY, spikes (later specs).

## Code changes

### `scripts/src/client.ts`
Add:

```ts
/** Monthly user pageviews of a whole language edition (normalisation base), zero-filled. */
export async function editionMonthly(lang: string, from: Month, to: Month): Promise<Map<Month, number>>
```

- URL: `https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/{lang}.wikipedia/all-access/user/monthly/{apiStart(from)}/{apiEnd(to)}`.
- Response shape is the same as per-article: `{ items: [{ timestamp: "2024090100", views }] }`.
- 404 → throw `ApiError` ("No aggregate data for {lang}.wikipedia"): normalization is impossible without the base.
- Zero-fill exactly like `articleMonthly` (extract a shared `fillMonths` helper).

### `scripts/src/metrics/stats.ts` (new)
Pure helpers that every later spec needs:
- `median(xs)`: mean of the two middle values for even length; `NaN` for an empty array;
- `mean(xs)`;
- `sum(xs)`;
- `mad(xs)`: median absolute deviation from the median, unscaled;
- `normalCdf(z)`: via the Abramowitz–Stegun 7.1.26 erf approximation, error < 1.5e-7;
- `round(x, digits = 1)`: `Math.round(x * 10^d) / 10^d`, infinities returned as is;
- `safeLog(xs)`: `ln(max(x, floor))`, where `floor` is half the smallest positive value (or 1 if there is none). Keeps zero months from producing `-Infinity`.

### `scripts/src/metrics/config.ts` (new)
For now just `export const CONFIG = {} as const;`. Later specs add their thresholds here.

### `scripts/src/metrics/normalize.ts` (new)

```ts
/** views / edition views × 1e6. Months with edition = 0 give 0. */
export function sharePerMillion(views: readonly number[], edition: readonly number[]): number[]
```

### `scripts/src/metrics/index.ts` (new)
The single place where metrics are applied in the right order. Later specs extend this function.

```ts
export interface LanguageMetrics {
  months: number;
  medianMonthlyViews: number;                             // rounded to integer
  sharePerMillion: { median: number; last12Avg: number }; // 2 decimals; last12Avg = mean of the last min(12, n) months
}

export function computeLanguageMetrics(months: Month[], views: number[], edition: number[]): {
  metrics: LanguageMetrics;
  points: Array<{ month: Month; views: number; editionViews: number; sharePerMillion: number }>; // share rounded to 3 decimals
}
```

### `scripts/src/collect.ts`
- For every language with an article, fetch `editionMonthly(lang, from, to)` in parallel with the articles.
- `LanguageResult`:
  - add `metrics: LanguageMetrics | null`;
  - `monthly` becomes `Array<{ month, views, editionViews, sharePerMillion }>` (the `points` from `computeLanguageMetrics`);
  - `totalViews`, `avgMonthlyViews`, `periods`, `changePct` stay as they are for now (`changePct` is removed by 03).
- `no_article` / `no_data` → `metrics: null`.

### `scripts/src/charts.ts`
- The chart plots `sharePerMillion` instead of raw views. Y axis title: en "Views per million pageviews of the edition", uk "Переглядів на мільйон переглядів розділу".
- Everything else (palette, legend, PNG rasterisation) is unchanged.

### `scripts/src/report.ts`
- Add a "Per million" / "На мільйон" column with `metrics.sharePerMillion.last12Avg` (1 decimal), between "Avg / month" and "Last 12 mo".
- Make sure the columns still fit in 523 pt of width; narrow "Article" if needed.
- In `caveatList`, replace the "no normalisation" item with:
  - en: "Share = article views per million pageviews of the whole language edition (not per million people)."
  - uk: "Частка = переглядів статті на мільйон усіх переглядів мовного розділу (не на мільйон людей)."

## Output (`analyze` JSON, per language)

```jsonc
{
  "lang": "uk",
  "status": "ok",
  "totalViews": 329923, "avgMonthlyViews": 9165, "periods": [...], "changePct": 3.1,
  "metrics": {
    "months": 36,
    "medianMonthlyViews": 9011,
    "sharePerMillion": { "median": 81.3, "last12Avg": 97.54 }   // illustrative values
  }
}
```

`monthly` is still stripped from stdout (kept only in `data.json`).

## SKILL.md
Add to "Rules for the answer":
> For comparing languages use `metrics.sharePerMillion.last12Avg` (views per million pageviews of that edition, NOT per million people). Never compare raw views between languages.

## Edge cases
- Edition total is 0 in some month (theoretical): share is 0, no division by zero.
- Language without an article: no `aggregate` request is made.

## Verification
1. `sharePerMillion([9000, 0, 150], [120_000_000, 100_000_000, 0])` → `[75, 0, 0]`.
2. `median([3,1,2])` → 2; `median([4,1,2,3])` → 2.5; `mad([1,1,2,2,4,6,9])` → 1.
3. `normalCdf(0)` → 0.5 (6 decimals); `normalCdf(1.959964)` → 0.975 (4 decimals).
4. `safeLog([0, 4, 8])` → `[ln 2, ln 4, ln 8]`.
5. Real run `scripts/wt analyze --topic Astronomy --langs uk,pl --report --report-lang uk`:
   - `metrics.sharePerMillion` is filled for both languages;
   - the chart (SVG and PNG) shows share;
   - the PDF has one page.
