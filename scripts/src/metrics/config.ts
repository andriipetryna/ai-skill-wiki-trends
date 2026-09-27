// All metric thresholds live here. Later specs add theirs.
export const CONFIG = {
  yoy: {
    /** series at least this long compare the last 12 months with the previous 12 */
    fullMonths: 24,
    /** shorter series (down to this length) fall back to second half vs first half; below it there is no YoY */
    minMonths: 6,
  },
  spikes: {
    /** centred rolling-median window, months */
    window: 7,
    /** robust z-score on log residuals */
    zThreshold: 3.5,
    /** AND at least this many times the baseline (filters out seasonal peaks) */
    minRatio: 1.8,
    /** floor for the robust scale (flat series) */
    minScale: 0.05,
    /** how many spikes (by ratio) are listed in the output */
    maxListed: 5,
  },
  trend: {
    /** below this: plain Theil–Sen + plain Mann–Kendall (no seasonal pairs to compare) */
    seasonalMinMonths: 24,
    /** months per seasonal cycle */
    period: 12,
  },
  verdict: {
    /** |trend| below this (%/yr) → flat, whatever the p-value */
    flatPctPerYear: 5,
    /** growing/declining need p below this; otherwise inconclusive */
    maxP: 0.1,
  },
  confidence: {
    /** median views/month: below → −0.5 and forced low */
    veryLowVolume: 100,
    /** below → −0.3 and capped at medium */
    lowVolume: 1000,
    /** months: below → seasonality cannot be separated from trend */
    shortHistory: 24,
    pStrong: 0.05,
    pWeak: 0.2,
    /** spike-driven when |yoyWithSpikes − yoy| > this many pp ... */
    spikeDrivenPp: 10,
    /** ... AND > this share of |yoyWithSpikes| */
    spikeDrivenShare: 0.5,
    /** min |%| for the sign-disagreement rules */
    signalPct: 5,
    /** more than this share of zero months → gaps */
    gapsShare: 0.1,
    /** score thresholds for the levels */
    levels: { high: 0.7, medium: 0.4 },
  },
  ranking: {
    /** growth (trend %/yr) is clamped to [growthMin, growthMax] so one extreme value does not flatten the rest */
    growthMin: -100,
    growthMax: 200,
    /** floors before log10: median views/month and share per million */
    volumeFloor: 1,
    shareFloor: 1e-6,
    /** max − min below this → the component is equal for everyone (0.5) */
    minRange: 1e-12,
  },
  findings: {
    /** |edition trend| (%/yr) from which a finding explains that share, not raw views, is the fair measure */
    editionShiftPctPerYear: 10,
  },
} as const;
