// Pure numeric helpers shared by all metrics. Arrays in, numbers out; no rounding unless asked.

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** NaN for an empty array. */
export function mean(xs: readonly number[]): number {
  return xs.length ? sum(xs) / xs.length : NaN;
}

/** Mean of the two middle values for even length; NaN for an empty array. */
export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation from the median, unscaled. */
export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Standard normal CDF via the Abramowitz–Stegun 7.1.26 erf approximation (error < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Round to `digits` decimals; infinities (and NaN) are returned as is. */
export function round(x: number, digits = 1): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * ln(max(x, floor)), where floor is half the smallest positive value (1 if there is none).
 * Keeps zero months from producing -Infinity.
 */
export function safeLog(xs: readonly number[]): number[] {
  const positive = xs.filter((x) => x > 0);
  const floor = positive.length ? Math.min(...positive) / 2 : 1;
  return xs.map((x) => Math.log(Math.max(x, floor)));
}
