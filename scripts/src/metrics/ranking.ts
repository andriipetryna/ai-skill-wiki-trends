// Ranking of languages by user-weighted components, each min-max normalised across the languages of one run.
import { CONFIG } from "./config.ts";
import { round } from "./stats.ts";

export interface Weights {
  volume: number;
  growth: number;
  confidence: number;
  share: number;
}

export const DEFAULT_WEIGHTS: Weights = { volume: 1, growth: 1, confidence: 1, share: 0 };
export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[];

export interface RankInput {
  lang: string;
  medianMonthlyViews: number;
  trendPctPerYear: number;
  confidenceScore: number;
  sharePerMillion: number;
}

export interface RankRow {
  rank: number;
  lang: string;
  /** 0..1, 2 decimals */
  score: number;
  /** normalised to 0..1 across the run, 2 decimals */
  components: Weights;
}

/** (x − min) / (max − min); everyone gets 0.5 when the component does not vary. */
function minMax(xs: readonly number[], opts: typeof CONFIG.ranking): number[] {
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return max - min < opts.minRange ? xs.map(() => 0.5) : xs.map((x) => (x - min) / (max - min));
}

/**
 * Raw components: volume = log10(max(1, median views)), growth = trend %/yr clamped to [−100, 200],
 * confidence = score, share = log10(max(1e-6, share per million)); then min-max normalised.
 * score = Σ w·c / Σw (divisor 1 when Σw = 0). Sorted on full precision by score, confidence, volume desc, lang asc;
 * rounded afterwards. A non-finite trend counts as 0 growth.
 */
export function rankLanguages(rows: readonly RankInput[], w: Weights, opts: typeof CONFIG.ranking = CONFIG.ranking): RankRow[] {
  const clamp = (x: number) => (Number.isFinite(x) ? Math.min(opts.growthMax, Math.max(opts.growthMin, x)) : 0);
  const volume = minMax(rows.map((r) => Math.log10(Math.max(opts.volumeFloor, r.medianMonthlyViews))), opts);
  const growth = minMax(rows.map((r) => clamp(r.trendPctPerYear)), opts);
  const confidence = minMax(rows.map((r) => r.confidenceScore), opts);
  const share = minMax(rows.map((r) => Math.log10(Math.max(opts.shareFloor, r.sharePerMillion))), opts);
  const total = WEIGHT_KEYS.reduce((acc, k) => acc + w[k], 0) || 1;

  const scored = rows.map((r, i) => {
    const c: Weights = { volume: volume[i]!, growth: growth[i]!, confidence: confidence[i]!, share: share[i]! };
    const score = WEIGHT_KEYS.reduce((acc, k) => acc + w[k] * c[k], 0) / total;
    return { lang: r.lang, score, components: c };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.components.confidence - a.components.confidence ||
      b.components.volume - a.components.volume ||
      (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    lang: s.lang,
    score: round(s.score, 2),
    components: {
      volume: round(s.components.volume, 2),
      growth: round(s.components.growth, 2),
      confidence: round(s.components.confidence, 2),
      share: round(s.components.share, 2),
    },
  }));
}
