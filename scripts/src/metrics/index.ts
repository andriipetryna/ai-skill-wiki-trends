// The single place where metrics are applied, in order. Full precision inside; rounding only here at the boundary.
import type { Month } from "../dates.ts";
import { CONFIG } from "./config.ts";
import { sharePerMillion } from "./normalize.ts";
import { detectSpikes } from "./spikes.ts";
import { mean, median, round } from "./stats.ts";
import { periodChange, type PeriodChange } from "./yoy.ts";

export interface LanguageMetrics {
  months: number;
  /** rounded to integer */
  medianMonthlyViews: number;
  /** views per million pageviews of the edition, 2 decimals, spikes included; last12Avg = mean of the last min(12, n) months */
  sharePerMillion: { median: number; last12Avg: number };
  /** % change, last 12 months vs the previous 12 (or halves if < 24 months), 1 decimal; null when periodChange(cleaned share) is null */
  yoy: {
    method: PeriodChange["method"];
    /** on share per million with spikes replaced by their baseline: the headline YoY */
    sharePct: number;
    /** on share per million as is, spikes included; compare with sharePct to see how much spikes drive the change */
    sharePctWithSpikes: number | null;
    /** on raw views, spikes replaced */
    viewsPct: number | null;
    /** on the whole edition's views */
    editionPct: number | null;
  } | null;
  /** one-off upward spikes in raw views, top `CONFIG.spikes.maxListed` by ratio; xBaseline = views / baseline, 1 decimal */
  spikes: Array<{ month: Month; views: number; xBaseline: number }>;
}

export interface MetricPoint {
  month: Month;
  views: number;
  editionViews: number;
  /** 3 decimals, spikes included */
  sharePerMillion: number;
  /** excluded from YoY and trend (drawn as a ring on the chart) */
  spike: boolean;
}

/** `months`, `views` and `edition` are aligned series of equal length. */
export function computeLanguageMetrics(months: Month[], views: number[], edition: number[]): { metrics: LanguageMetrics; points: MetricPoint[] } {
  // Spikes are events in the article itself, so they are found on raw views, before normalisation
  const { spikes, cleaned } = detectSpikes(views);
  const share = sharePerMillion(views, edition);
  const shareClean = sharePerMillion(cleaned, edition);
  const yoy = periodChange(shareClean);
  const pct = (c: PeriodChange | null) => (c ? round(c.pct, 1) : null);
  const spikeAt = new Set(spikes.map((s) => s.index));
  const metrics: LanguageMetrics = {
    months: months.length,
    medianMonthlyViews: round(median(views), 0),
    sharePerMillion: { median: round(median(share), 2), last12Avg: round(mean(share.slice(-12)), 2) },
    yoy: yoy && {
      method: yoy.method,
      sharePct: round(yoy.pct, 1),
      sharePctWithSpikes: pct(periodChange(share)),
      viewsPct: pct(periodChange(cleaned)),
      editionPct: pct(periodChange(edition)),
    },
    spikes: [...spikes]
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, CONFIG.spikes.maxListed)
      .map((s) => ({ month: months[s.index]!, views: s.value, xBaseline: round(s.ratio, 1) })),
  };
  const points = months.map((month, i) => ({
    month,
    views: views[i]!,
    editionViews: edition[i]!,
    sharePerMillion: round(share[i]!, 3),
    spike: spikeAt.has(i),
  }));
  return { metrics, points };
}
