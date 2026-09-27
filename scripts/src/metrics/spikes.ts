// One-off upward spikes (news, doodles, unfiltered bots): found on raw views, replaced by the local baseline.
import { CONFIG } from "./config.ts";
import { mad, median } from "./stats.ts";

/** For each i, the median of xs[i-half .. i+half] (half = floor(window/2)); the window gets shorter at the edges. */
export function rollingMedian(xs: readonly number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return xs.map((_, i) => median(xs.slice(Math.max(0, i - half), Math.min(xs.length, i + half + 1))));
}

export interface Spike {
  index: number;
  value: number;
  baseline: number;
  /** value / baseline */
  ratio: number;
}

/**
 * A month is a spike when its log residual from the rolling-median baseline has a robust z-score above
 * zThreshold AND it is at least minRatio times the baseline (a positive one). Downward dips are ignored.
 * `cleaned` is a copy of xs with every spike replaced by its baseline.
 */
export function detectSpikes(xs: readonly number[], opts: typeof CONFIG.spikes = CONFIG.spikes): { spikes: Spike[]; cleaned: number[] } {
  const b = rollingMedian(xs, opts.window);
  const r = xs.map((x, i) => Math.log1p(x) - Math.log1p(b[i]!));
  const scale = Math.max(1.4826 * mad(r), opts.minScale);
  const center = median(r);
  const spikes: Spike[] = [];
  const cleaned = [...xs];
  xs.forEach((x, i) => {
    const base = b[i]!;
    if ((r[i]! - center) / scale > opts.zThreshold && base > 0 && x / base >= opts.minRatio) {
      spikes.push({ index: i, value: x, baseline: base, ratio: x / base });
      cleaned[i] = base;
    }
  });
  return { spikes, cleaned };
}
