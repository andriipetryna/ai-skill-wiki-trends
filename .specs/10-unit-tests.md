# 10 — Unit tests

## Why
Metric code is where silent, plausible-looking errors live. A biased slope or an over-eager spike detector still produces reasonable-looking numbers. The only reliable check is **synthetic data with a known answer**: generate a series with a planted growth rate, seasonality, noise and spikes, and assert the code recovers them.

This already caught a real bug: plain Theil–Sen on seasonal data reported +24.6%/yr for a true +4%/yr.

## Scope
- **In:** unit tests for pure modules: `dates.ts`, argument parsing, `collect.ts` helpers, every module in `scripts/src/metrics/`, `text.ts` formatting.
- **Out:** HTTP, CLI, PDF (11), live API (12).

## Rules
- Location: `tests/unit/<module>.test.ts`, one file per source module.
- Pure functions only: no network, no filesystem, no `Date.now()` (use `vi.setSystemTime` where the function reads the clock).
- Series come from `gen()` / `genSeries()` in `tests/fake/noise.ts` (spec 09), never from hand-typed arrays longer than ~10 values.
- Every tolerance is explicit: `toBeCloseTo(x, digits)` or `Math.abs(a - b) < tol` with the tolerance in the test name when it is not obvious.
- **Port every item of the "Verification" section of each implemented spec 01–08 as a test.** Those values come from a reference implementation. If a ported test fails, first check the implementation against the spec; change a number only with an explanation in the commit message.
- Every future bug fix adds a regression test named `regression: <what broke>`.

## Test list

### `tests/unit/dates.test.ts`
- `addMonths("2024-11", 3)` → `2025-02`; `addMonths("2024-01", -1)` → `2023-12`.
- `monthRange("2024-11", "2025-02")` → 4 months in order; `from > to` throws.
- `apiEnd("2024-02")` → `20240229` (leap year); `apiEnd("2023-02")` → `20230228`.
- `lastCompleteMonth`: on 2026-09-26 → `2026-08`; on 2026-09-01 and 2026-09-02 → `2026-07` (data publication lag).
- `monthFromTimestamp("2024090100")` → `2024-09`.
- `monthOfYear("2024-01")` → 0 (after spec 05).

### `tests/unit/cli-args.test.ts`
Extract argument parsing into a pure function if it is not one already (e.g. `parseAnalyzeArgs(argv, now)`), then test:
- `--years 2` at 2026-09-26 → `from 2024-09`, `to 2026-08`;
- `--months 18`; explicit `--from/--to`; `--from 2010-01` clamps to `2015-07`;
- `--langs "PL, cs"` → `["pl", "cs"]`; `--langs ua!` → error mentioning `uk`;
- `--article pl="Głodówka lecznicza"` → `{ pl: ["Głodówka lecznicza"] }`; `--article nope` → error;
- `--weights growth=3` merges with defaults; unknown key or negative value → error (after spec 07).

### `tests/unit/collect-helpers.test.ts`
- `splitPeriods` for 36, 30, 24, 18 and 6 months: block sizes, boundaries and sums.
- Basket summing: two series are summed per month (test the pure summing helper; extract one if needed).
- `siteFor("uk")` → `ukwiki`; `siteFor("zh-yue")` → `zh_yuewiki`; `siteFor("be-tarask")` → `be_x_oldwiki`.
- Title encoding: `"Post przerywany"` → `Post_przerywany`; `"AC/DC"` → `AC%2FDC`.

### `tests/unit/metrics/*.test.ts` (one file per module, after the matching spec)
Port the "Verification" items from:
- **01 `stats`, `normalize`**: median, mad, normalCdf, safeLog, sharePerMillion.
- **03 `yoy`**: four `periodChange` cases.
- **04 `spikes`**:
  - the ×5 spike at index 20 (exact value, baseline, ratio, cleaned value);
  - no spikes on seasonal data;
  - `rollingMedian` edge windows.
- **05 `trend`**:
  - Mann–Kendall exact S/Var/z/p cases, including ties and a flat series;
  - Theil–Sen robustness;
  - **`regression: plain Theil–Sen is biased by seasonality`** (seasonalSen 4.00 vs theilSen 24.61);
  - the `monthlyTrend` table for g ∈ {−20, 0, 15, 40}.
- **06 `confidence`**:
  - every row of the table (level, score and the ordered list of codes);
  - the verdict cases.
- **07 `ranking`**:
  - three weight sets, including the tie-break;
  - all-equal component → 0.5.

Add these property-style checks on top (loop over a few seeds and parameters):
- **Trend recovery:** for g ∈ {−30, −10, 0, 10, 30, 60}, season ∈ {0, 0.35}, 36 months, noise 0.05 → `|pctPerYear − g| < 3`.
- **Spike robustness:** adding one ×8 spike at a random index changes `sharePctPerYear` by < 1 pp and the spike is detected.
- **Scale invariance:** multiplying all views by 1000 does not change trend %, p, verdict or spike months.
- **Normalization:** views +4%/yr with an edition −12%/yr → share trend within 18.2 ± 1.5 %/yr (1.04 / 0.88 − 1).
- **No NaN/Infinity** anywhere in `computeLanguageMetrics` output for: all zeros except one month, 6 months, series with 30% zero months.

### `tests/unit/text.test.ts` (after spec 08)
- `signed(12.34)` → `+12.3%`; `signed(-4.5)` → `-4.5%`; `signed(null)` → `n/a`; `pfmt(0.0004)` → `p<0.001`; `pfmt(0.1234)` → `p=0.123`.
- `buildFindings` on a fixed `LanguageResult[]`:
  - one sentence per language, in `--langs` order;
  - the relative-interest line is present only with ≥ 2 languages, and it says "not per million people";
  - **every number in every finding appears in the input object** (use the number extractor from spec 13).
- `buildAnswerChecklist`:
  - the PDF item comes first when a report path is given;
  - a LOW item names each low-confidence language;
  - the `--article` item appears when any language is `no_article`.
- `renderCaveat` exists for every caveat code in both `en` and `uk` (loop over the code list; no missing keys).

## Verification
- `npm run test:unit` passes and runs in < 5 s.
- Deliberately break one thing (e.g. make `monthlyTrend` use `theilSen` always) and confirm the regression test fails; then revert.
