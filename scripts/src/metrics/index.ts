// The single place where metrics are applied, in order. Full precision inside; rounding only here at the boundary.
import type { Month } from "../dates.ts";
import { sharePerMillion } from "./normalize.ts";
import { mean, median, round } from "./stats.ts";
import { periodChange, type PeriodChange } from "./yoy.ts";

export interface LanguageMetrics {
  months: number;
  /** rounded to integer */
  medianMonthlyViews: number;
  /** views per million pageviews of the edition, 2 decimals; last12Avg = mean of the last min(12, n) months */
  sharePerMillion: { median: number; last12Avg: number };
  /** % change, last 12 months vs the previous 12 (or halves if < 24 months), 1 decimal; null when periodChange(share) is null */
  yoy: {
    method: PeriodChange["method"];
    /** on share per million: the headline YoY */
    sharePct: number;
    /** on raw views */
    viewsPct: number | null;
    /** on the whole edition's views */
    editionPct: number | null;
  } | null;
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
  const yoy = periodChange(share);
  const pct = (c: PeriodChange | null) => (c ? round(c.pct, 1) : null);
  const metrics: LanguageMetrics = {
    months: months.length,
    medianMonthlyViews: round(median(views), 0),
    sharePerMillion: { median: round(median(share), 2), last12Avg: round(mean(share.slice(-12)), 2) },
    yoy: yoy && { method: yoy.method, sharePct: round(yoy.pct, 1), viewsPct: pct(periodChange(views)), editionPct: pct(periodChange(edition)) },
  };
  const points = months.map((month, i) => ({ month, views: views[i]!, editionViews: edition[i]!, sharePerMillion: round(share[i]!, 3) }));
  return { metrics, points };
}
