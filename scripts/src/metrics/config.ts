// All metric thresholds live here. Later specs add theirs.
export const CONFIG = {
  yoy: {
    /** series at least this long compare the last 12 months with the previous 12 */
    fullMonths: 24,
    /** shorter series (down to this length) fall back to second half vs first half; below it there is no YoY */
    minMonths: 6,
  },
} as const;
