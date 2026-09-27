// Year-over-year change: last 12 months vs the previous 12 (seasonality cancels out, one of each month per block).
import { CONFIG } from "./config.ts";
import { sum } from "./stats.ts";

export interface PeriodChange {
  method: "last12_vs_prev12" | "second_half_vs_first_half";
  /** full precision */
  pct: number;
}

/**
 * Works on any series (share, raw views, edition traffic).
 * n >= 24: last 12 vs the previous 12 (earlier months are ignored).
 * 6 <= n < 24: second half vs first half; does not control for seasonality.
 * null when the series is shorter or the base block sums to 0.
 */
export function periodChange(values: readonly number[]): PeriodChange | null {
  const n = values.length;
  if (n >= CONFIG.yoy.fullMonths) {
    const last = sum(values.slice(n - 12));
    const prev = sum(values.slice(n - 24, n - 12));
    return prev > 0 ? { method: "last12_vs_prev12", pct: (last / prev - 1) * 100 } : null;
  }
  if (n >= CONFIG.yoy.minMonths) {
    const h = Math.floor(n / 2);
    const first = sum(values.slice(0, h));
    const second = sum(values.slice(n - h));
    return first > 0 ? { method: "second_half_vs_first_half", pct: (second / first - 1) * 100 } : null;
  }
  return null;
}
