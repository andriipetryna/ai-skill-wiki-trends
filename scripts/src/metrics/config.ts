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
} as const;
