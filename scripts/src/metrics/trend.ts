// Trend over the whole period: robust slope (seasonal Sen) + significance (seasonal Mann–Kendall), both on log values.
import { CONFIG } from "./config.ts";
import { median, normalCdf, safeLog } from "./stats.ts";

/** Median of slopes over all pairs i<j: (y[j]-y[i])/(j-i). NaN if < 2 points. */
export function theilSen(y: readonly number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < y.length; i++) for (let j = i + 1; j < y.length; j++) slopes.push((y[j]! - y[i]!) / (j - i));
  return median(slopes);
}

/** Median of slopes over pairs exactly k·period apart (k ≥ 1). NaN if none. */
export function seasonalSen(y: readonly number[], period = CONFIG.trend.period): number {
  const slopes: number[] = [];
  for (let i = 0; i < y.length; i++) for (let j = i + period; j < y.length; j += period) slopes.push((y[j]! - y[i]!) / (j - i));
  return median(slopes);
}

export interface MkResult {
  s: number;
  varS: number;
  z: number;
  p: number;
}

/** S = Σ sign(y[j] − y[i]) over i<j, and its variance with the tie correction. */
function mkSum(y: readonly number[]): { s: number; varS: number } {
  const n = y.length;
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += Math.sign(y[j]! - y[i]!);
  const counts = new Map<number, number>();
  for (const v of y) counts.set(v, (counts.get(v) ?? 0) + 1);
  let ties = 0;
  for (const t of counts.values()) if (t > 1) ties += t * (t - 1) * (2 * t + 5);
  return { s, varS: (n * (n - 1) * (2 * n + 5) - ties) / 18 };
}

/** z with continuity correction and two-sided p from summed S and Var(S). */
function mkTest(s: number, varS: number): MkResult {
  if (varS <= 0) return { s, varS, z: 0, p: 1 };
  const z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0;
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
  return { s, varS, z, p };
}

/** Mann–Kendall trend test, two-sided p, normal approximation, tie correction. */
export function mannKendall(y: readonly number[]): MkResult {
  const { s, varS } = mkSum(y);
  return mkTest(s, varS);
}

/** Seasonal Mann–Kendall: MK per calendar month, S and Var(S) summed. startMonth = monthOfYear of y[0]. */
export function seasonalMannKendall(y: readonly number[], startMonth: number, period = CONFIG.trend.period): MkResult {
  let s = 0;
  let varS = 0;
  for (let season = 0; season < period; season++) {
    const sub = y.filter((_, i) => (startMonth + i) % period === season);
    if (sub.length < 2) continue;
    const r = mkSum(sub);
    s += r.s;
    varS += r.varS;
  }
  return mkTest(s, varS);
}

export interface TrendResult {
  /** full precision */
  pctPerYear: number;
  pValue: number;
  test: "seasonal_mann_kendall" | "mann_kendall";
}

/**
 * Robust growth + significance on log(values).
 * n >= seasonalMinMonths: seasonal Sen + seasonal MK (only same-calendar-month pairs, so the yearly cycle is not a trend);
 * shorter: plain Theil–Sen + plain MK. pctPerYear is NaN with < 2 points.
 */
export function monthlyTrend(values: readonly number[], startMonth: number): TrendResult {
  const logs = safeLog(values);
  const seasonal = values.length >= CONFIG.trend.seasonalMinMonths;
  const slope = seasonal ? seasonalSen(logs) : theilSen(logs);
  const mk = seasonal ? seasonalMannKendall(logs, startMonth) : mannKendall(logs);
  return {
    pctPerYear: (Math.exp(slope * CONFIG.trend.period) - 1) * 100,
    pValue: mk.p,
    test: seasonal ? "seasonal_mann_kendall" : "mann_kendall",
  };
}
