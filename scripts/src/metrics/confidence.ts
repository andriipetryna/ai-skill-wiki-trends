// Verdict (one word for the trend) and rule-based confidence with a reason per rule, so the agent can explain it.
import { CONFIG } from "./config.ts";
import { round } from "./stats.ts";

export type Verdict = "growing" | "declining" | "flat" | "inconclusive";

/** flat if |trend| < flatPctPerYear; else growing/declining if p < maxP; else inconclusive (also for NaN input). */
export function verdictFor(trendPctPerYear: number, pValue: number, opts: typeof CONFIG.verdict = CONFIG.verdict): Verdict {
  if (Math.abs(trendPctPerYear) < opts.flatPctPerYear) return "flat";
  if (pValue < opts.maxP) return trendPctPerYear > 0 ? "growing" : "declining";
  return "inconclusive";
}

export interface ConfidenceInput {
  medianMonthlyViews: number;
  months: number;
  pValue: number;
  /** share, cleaned */
  trendPctPerYear: number;
  /** raw views, cleaned */
  viewsTrendPctPerYear: number;
  /** share, cleaned */
  yoyPct: number | null;
  /** share, raw */
  yoyPctWithSpikes: number | null;
  spikesInLast12: number;
  /** 0..1 */
  zeroMonthsShare: number;
}

export interface ConfidenceReason {
  code: string;
  effect: "+" | "-";
  message: string;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Confidence {
  level: ConfidenceLevel;
  /** 0..1, 2 decimals */
  score: number;
  reasons: ConfidenceReason[];
}

const RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * Start at score 1, cap high; apply the rules in order (volume, history, significance, spikes, YoY vs trend,
 * views vs share, gaps). Each rule adds a reason and may lower the score and the cap.
 * Final level = the lower of the level from the clamped score and the cap.
 */
export function assessConfidence(c: ConfidenceInput, opts: typeof CONFIG.confidence = CONFIG.confidence): Confidence {
  let score = 1;
  let cap: ConfidenceLevel = "high";
  const reasons: ConfidenceReason[] = [];
  const add = (code: string, delta: number, message: string, capAt?: ConfidenceLevel) => {
    score += delta;
    if (capAt && RANK[capAt] < RANK[cap]) cap = capAt;
    reasons.push({ code, effect: delta >= 0 ? "+" : "-", message });
  };
  const opposite = (a: number, b: number) => Math.abs(a) > opts.signalPct && Math.abs(b) > opts.signalPct && Math.sign(a) !== Math.sign(b);

  // 1. Volume
  const v = Math.round(c.medianMonthlyViews);
  if (v < opts.veryLowVolume) add("very_low_volume", -0.5, `Median ${v} views/month: too few for a reliable trend`, "low");
  else if (v < opts.lowVolume) add("low_volume", -0.3, `Median ${v} views/month: small sample, noisy`, "medium");
  else add("volume_ok", 0, `Median ${v} views/month`);

  // 2. History length
  if (c.months < opts.shortHistory) add("short_history", -0.15, `Only ${c.months} months: seasonality cannot be separated from trend`);

  // 3. Significance
  const p = c.pValue < 0.001 ? "p<0.001" : `p=${c.pValue.toFixed(3)}`;
  if (c.pValue < opts.pStrong) add("significant", 0, `Trend is statistically significant (${p})`);
  else if (c.pValue < opts.pWeak) add("weak_significance", -0.25, `Trend is only weakly significant (${p})`);
  else add("not_significant", -0.45, `No statistically significant trend (${p})`);

  // 4. Spikes
  const d = c.yoyPct !== null && c.yoyPctWithSpikes !== null ? Math.abs(c.yoyPctWithSpikes - c.yoyPct) : null;
  if (d !== null && d > opts.spikeDrivenPp && d > opts.spikeDrivenShare * Math.abs(c.yoyPctWithSpikes!)) {
    add("spike_driven", -0.4, "A large part of the apparent change comes from one-off spikes", "medium");
  } else if (c.spikesInLast12 > 0) {
    add("recent_spike", -0.1, `${c.spikesInLast12} spike month(s) in the last 12 months`);
  }

  // 5. YoY vs long-run trend
  if (c.yoyPct !== null && opposite(c.yoyPct, c.trendPctPerYear)) {
    add("inconsistent_signals", -0.2, "Year-over-year change and long-run trend point in different directions");
  }

  // 6. Raw views vs share
  if (opposite(c.viewsTrendPctPerYear, c.trendPctPerYear)) {
    add("normalisation_flips_sign", -0.1, "Raw views and share of edition traffic move in opposite directions");
  }

  // 7. Zero months
  if (c.zeroMonthsShare > opts.gapsShare) add("gaps", -0.2, `${Math.round(c.zeroMonthsShare * 100)}% of months have zero views`);

  score = round(Math.min(1, Math.max(0, score)), 2);
  const fromScore: ConfidenceLevel = score >= opts.levels.high ? "high" : score >= opts.levels.medium ? "medium" : "low";
  return { level: RANK[fromScore] <= RANK[cap] ? fromScore : cap, score, reasons };
}
