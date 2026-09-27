# 06 — Verdict and confidence

## Why
- **Verdict.** A weak model misreads a "slope + p-value" pair. A ready-made word (`growing` / `declining` / `flat` / `inconclusive`) reduces mistakes.
- **Confidence.** This directly answers the brief's question "how far can this growth be trusted?". The p-value covers only one part. Confidence also depends on volume, spikes, series length and whether the signals agree.

Confidence is rule-based rather than one formula: every reason is returned as text, so the agent can explain it to a person ("confidence is medium because of a one-off ×5 spike in October"), and every rule can be checked separately.

## Scope
- **In:** `verdictFor`, `assessConfidence`, the `verdict` and `confidence` fields, report columns.
- **Out:** ranking (07), ready-made sentences (08).

## Code changes

### `scripts/src/metrics/config.ts`

```ts
verdict: { flatPctPerYear: 5, maxP: 0.1 },
confidence: {
  veryLowVolume: 100,    // median views/month: below → forced low
  lowVolume: 1000,       // below → −0.3 and capped at medium
  shortHistory: 24,      // months
  pStrong: 0.05, pWeak: 0.2,
  spikeDrivenPp: 10,     // |yoyWithSpikes − yoy| > 10 pp ...
  spikeDrivenShare: 0.5, // ... AND > 50% of |yoyWithSpikes|
  signalPct: 5,          // min |%| for the sign-disagreement rules
  gapsShare: 0.1,        // > 10% zero months
  levels: { high: 0.7, medium: 0.4 },
},
```

### `scripts/src/metrics/confidence.ts` (new)

```ts
export type Verdict = "growing" | "declining" | "flat" | "inconclusive";
export function verdictFor(trendPctPerYear: number, pValue: number): Verdict
```

| Condition | Verdict |
|---|---|
| `|trend| < flatPctPerYear` | `flat` |
| otherwise, `p < maxP` | `growing` (trend > 0) / `declining` |
| otherwise | `inconclusive` |

```ts
export interface ConfidenceInput {
  medianMonthlyViews: number;
  months: number;
  pValue: number;
  trendPctPerYear: number;         // share, cleaned
  viewsTrendPctPerYear: number;    // raw views, cleaned
  yoyPct: number | null;           // share, cleaned
  yoyPctWithSpikes: number | null; // share, raw
  spikesInLast12: number;
  zeroMonthsShare: number;         // 0..1
}
export interface ConfidenceReason { code: string; effect: "+" | "-"; message: string }
export interface Confidence { level: "high" | "medium" | "low"; score: number; reasons: ConfidenceReason[] }
export function assessConfidence(c: ConfidenceInput): Confidence
```

Algorithm: `score = 1`, `cap = "high"`. Apply the rules **in this order**; reasons are appended in the same order. `v` = median rounded to integer; `P(p)` = `p<0.001` if p < 0.001, otherwise `p=` with 3 decimals.

| # | code | Condition | Δscore | Cap | message |
|---|---|---|---|---|---|
| 1 | `very_low_volume` | v < veryLowVolume | −0.5 | low | `Median {v} views/month: too few for a reliable trend` |
| 1 | `low_volume` | else v < lowVolume | −0.3 | medium | `Median {v} views/month: small sample, noisy` |
| 1 | `volume_ok` | else | 0 | — | `Median {v} views/month` |
| 2 | `short_history` | months < shortHistory | −0.15 | — | `Only {months} months: seasonality cannot be separated from trend` |
| 3 | `significant` | p < pStrong | 0 | — | `Trend is statistically significant ({P})` |
| 3 | `weak_significance` | else p < pWeak | −0.25 | — | `Trend is only weakly significant ({P})` |
| 3 | `not_significant` | else | −0.45 | — | `No statistically significant trend ({P})` |
| 4 | `spike_driven` | both yoy ≠ null and d = \|yoyWithSpikes − yoy\| > spikeDrivenPp and d > spikeDrivenShare × \|yoyWithSpikes\| | −0.4 | medium | `A large part of the apparent change comes from one-off spikes` |
| 4 | `recent_spike` | else spikesInLast12 > 0 | −0.1 | — | `{k} spike month(s) in the last 12 months` |
| 5 | `inconsistent_signals` | yoyPct ≠ null, \|yoyPct\| > signalPct, \|trend\| > signalPct, opposite signs | −0.2 | — | `Year-over-year change and long-run trend point in different directions` |
| 6 | `normalisation_flips_sign` | \|viewsTrend\| > signalPct, \|trend\| > signalPct, opposite signs | −0.1 | — | `Raw views and share of edition traffic move in opposite directions` |
| 7 | `gaps` | zeroMonthsShare > gapsShare | −0.2 | — | `{pct}% of months have zero views` |

Then:
- `effect = "+"` if Δ ≥ 0, otherwise `"-"`;
- `score = clamp(score, 0, 1)`, rounded to 2 decimals;
- level from score: ≥ levels.high → high, ≥ levels.medium → medium, otherwise low;
- **apply the cap:** final level = the lower of "level from score" and `cap`.

**Why caps exist.** Without them a median of 500 views gives 1 − 0.3 = 0.7 = high, which is wrong for such a small sample. And "the change came from spikes" should never end up as high whatever else holds.

### `scripts/src/metrics/index.ts`

```ts
verdict: Verdict; // verdictFor(trend.sharePctPerYear, trend.pValue) — on full-precision values
confidence: { level; score; reasons: string[] }; // reasons as "{effect} {message}", e.g. "- Median 74 views/month: too few ..."
```

`assessConfidence` receives **unrounded** values from 03–05. `spikesInLast12` = number of spikes with `index ≥ n − 12`. `zeroMonthsShare` = share of months whose raw views = 0.

### `scripts/src/report.ts`
- Columns "Verdict" / "Висновок" and "Confidence" / "Довіра".
- Translations:
  - uk verdicts: зростає / спадає / стабільний / неоднозначно;
  - uk levels: висока / середня / низька;
  - en as is.
- To make the columns fit, "Article" gets narrower. Long titles are truncated with "…", as `fit()` already does.

## Output

```jsonc
"verdict": "growing",
"confidence": { "level": "medium", "score": 0.6, "reasons": ["+ Median 20000 views/month", "+ Trend is statistically significant (p=0.001)", "- A large part of the apparent change comes from one-off spikes"] }
```

## SKILL.md
> Use `verdict` words as they are; never upgrade `inconclusive` to "growing".
> For "can we trust this?" answer with `confidence.level` and its `reasons`. For `low`, say clearly that the data does not support a conclusion. Name every language with `low` confidence.

## Verification
Base input `B = { medianMonthlyViews: 20000, months: 36, pValue: 0.001, trendPctPerYear: 25, viewsTrendPctPerYear: 20, yoyPct: 22, yoyPctWithSpikes: 23, spikesInLast12: 0, zeroMonthsShare: 0 }`.

| Input | level | score | Codes (in order) |
|---|---|---|---|
| B | high | 1 | `volume_ok`, `significant` |
| {...B, medianMonthlyViews: 500} | **medium** (cap) | 0.7 | `low_volume`, `significant` |
| {...B, medianMonthlyViews: 40} | low | 0.5 | `very_low_volume`, `significant` |
| {...B, yoyPct: 3, yoyPctWithSpikes: 45} | medium | 0.6 | `volume_ok`, `significant`, `spike_driven` |
| {...B, pValue: 0.12} | high | 0.75 | `volume_ok`, `weak_significance` |
| {...B, pValue: 0.5, trendPctPerYear: 30, yoyPct: 28, yoyPctWithSpikes: 28} | medium | 0.55 | `volume_ok`, `not_significant` |
| {...B, months: 18} | high | 0.85 | `volume_ok`, `short_history`, `significant` |
| {...B, yoyPct: −10, yoyPctWithSpikes: −10} | high | 0.8 | `volume_ok`, `significant`, `inconsistent_signals` |

The last row shows that disagreeing signals lower the score (1 − 0.2 = 0.8) but on their own do not change the level.

Verdicts: `verdictFor(20, 0.01)` → growing; `(−20, 0.01)` → declining; `(3, 0.5)` → flat; `(30, 0.4)` → inconclusive; `(4.9, 0.0001)` → flat.

Real run with several languages, one of them with very low volume (e.g. `--topic "English as a second or foreign language" --langs en,uk,ro`): the language with median < 100 is `low` with reason `very_low_volume`.
