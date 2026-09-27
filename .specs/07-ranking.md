# 07 — Ranking languages with user weights

## Why
The brief's third example ("which audiences should we research next, and why?") and the requirement that "users will have their own criteria of promise". One founder cares about audience size, another about momentum. The ranking must be transparent: components and weights are visible, and the weights can be changed with a flag.

## Scope
- **In:** `rankLanguages`, the `--weights` flag, the `ranking` field, a line in the report.
- **Out:** choosing weights automatically.

## Code changes

### `scripts/src/metrics/ranking.ts` (new)

```ts
export interface Weights { volume: number; growth: number; confidence: number; share: number }
export const DEFAULT_WEIGHTS: Weights = { volume: 1, growth: 1, confidence: 1, share: 0 };

export interface RankInput { lang: string; medianMonthlyViews: number; trendPctPerYear: number; confidenceScore: number; sharePerMillion: number }
export interface RankRow { rank: number; lang: string; score: number; components: { volume: number; growth: number; confidence: number; share: number } }

export function rankLanguages(rows: RankInput[], w: Weights): RankRow[]
```

Components (raw values before normalisation):

| Component | Raw value | Meaning |
|---|---|---|
| volume | `log10(max(1, medianMonthlyViews))` | audience size; log so that en does not crush everyone |
| growth | `clamp(trendPctPerYear, −100, 200)` | momentum; clamped so one +900% does not flatten the rest |
| confidence | `confidenceScore` | reliability |
| share | `log10(max(1e-6, sharePerMillion))` | how much of the edition's attention the topic gets |

Min-max normalise each component **across the languages of this run**: `(x − min)/(max − min)`. If `max − min < 1e-12`, give everyone 0.5.

`score = (w.volume·c.volume + w.growth·c.growth + w.confidence·c.confidence + w.share·c.share) / Σw`. If Σw = 0, the divisor is 1.

Sort by `score` desc, then `components.confidence` desc, then `components.volume` desc, then `lang` asc. `rank` = 1..n. Round `score` and components to 2 decimals **after** sorting on full precision.

### `scripts/src/cli.ts`
- `--weights volume=1,growth=2,confidence=1,share=0`: any subset of keys; missing ones come from `DEFAULT_WEIGHTS`. An unknown key or a negative / non-numeric value → error with exit code 2 and a `hint` listing the keys.
- `query.weights` — the full weights object in the output JSON.
- Add the flag to `--help`.

### `scripts/src/collect.ts` / `cli.ts`
- `ranking` is computed only when ≥ 2 languages have metrics; otherwise `ranking: []`.
- Input: `medianMonthlyViews`, `trend.sharePctPerYear`, `confidence.score`, `sharePerMillion.last12Avg` — full precision where available.

### `scripts/src/report.ts`
- Sort the table by `rank` (languages without data last, in `--langs` order).
- One line under the table:
  - en: `Suggested order to investigate: uk (0.97) > de (0.77) > hu (0.72); weights volume=1, growth=1, confidence=1, share=0.`
  - uk: `Порядок для подальшого дослідження: … ; ваги …`

## Output

```jsonc
"query": { ..., "weights": { "volume": 1, "growth": 1, "confidence": 1, "share": 0 } },
"ranking": [
  { "rank": 1, "lang": "uk", "score": 0.97, "components": { "volume": 0.9, "growth": 1, "confidence": 1, "share": 1 } }
]
```

## SKILL.md
- Flag: `--weights growth=3` when the user says growth matters most; `volume=3` for audience size; `share=1` to favour audiences where the topic takes a larger share of attention.
- Rule: `ranking` is relative to the compared languages and the weights only. Always state the weights and offer to change them. With two languages scores are always 1 and 0: say which one leads and why (components), not the scores.

## Edge cases
- Only one language has data: `ranking: []`, no line in the report.
- A component is equal across all languages: it becomes 0.5 for everyone and does not affect the order.

## Verification

```ts
const rows = [
  { lang: "a", medianMonthlyViews: 100000, trendPctPerYear: 0,  confidenceScore: 0.9,  sharePerMillion: 10 },
  { lang: "b", medianMonthlyViews: 2000,   trendPctPerYear: 40, confidenceScore: 0.9,  sharePerMillion: 50 },
  { lang: "c", medianMonthlyViews: 10000,  trendPctPerYear: 10, confidenceScore: 0.45, sharePerMillion: 20 },
];
```

1. Default weights → order `a`, `b`, `c`:
   - `a`: 0.67, components volume 1, growth 0, confidence 1, share 0;
   - `b`: 0.67 (below `a` through the tie-break on volume);
   - `c`: 0.22, components volume 0.41, growth 0.25, confidence 0, share 0.43.
2. `{ ...DEFAULT_WEIGHTS, growth: 3 }` → order `b` (0.8), `a` (0.4), `c` (0.23).
3. `{ ...DEFAULT_WEIGHTS, volume: 3 }` → order `a` (0.8), `b` (0.4), `c` (0.3).
4. CLI: `--weights growth=abc` → exit 2; `--weights foo=1` → exit 2 with a hint.
