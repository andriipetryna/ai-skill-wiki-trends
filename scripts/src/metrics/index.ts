// The single place where metrics are applied, in order. Full precision inside; rounding only here at the boundary.
import type { Month } from "../dates.ts";
import { sharePerMillion } from "./normalize.ts";
import { mean, median, round } from "./stats.ts";

export interface LanguageMetrics {
  months: number;
  /** rounded to integer */
  medianMonthlyViews: number;
  /** views per million pageviews of the edition, 2 decimals; last12Avg = mean of the last min(12, n) months */
  sharePerMillion: { median: number; last12Avg: number };
}

export interface MetricPoint {
  month: Month;
  views: number;
  editionViews: number;
  /** 3 decimals */
  sharePerMillion: number;
}

/** `months`, `views` and `edition` are aligned series of equal length. */
export function computeLanguageMetrics(months: Month[], views: number[], edition: number[]): { metrics: LanguageMetrics; points: MetricPoint[] } {
  const share = sharePerMillion(views, edition);
  const metrics: LanguageMetrics = {
    months: months.length,
    medianMonthlyViews: round(median(views), 0),
    sharePerMillion: { median: round(median(share), 2), last12Avg: round(mean(share.slice(-12)), 2) },
  };
  const points = months.map((month, i) => ({ month, views: views[i]!, editionViews: edition[i]!, sharePerMillion: round(share[i]!, 3) }));
  return { metrics, points };
}
