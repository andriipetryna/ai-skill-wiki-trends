// Deterministic synthetic series: no randomness, no clock. Shared by unit tests and the fake Wikimedia API.
import { monthDiff, monthOfYear, type Month } from "../../scripts/src/dates.ts";

/** Deterministic pseudo-noise in [-1, 1) (the formula from .specs/README.md). */
export const noise = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/** n months, growth g %/yr, seasonal amplitude season, noise level nz, base level base, phase shift phase (verbatim from .specs/README.md). */
export const gen = (n: number, g: number, season: number, nz: number, base: number, phase = 0): number[] =>
  Array.from({ length: n }, (_, i) =>
    Math.round(base * (1 + g / 100) ** (i / 12) * (1 + season * Math.cos((2 * Math.PI * (i + phase)) / 12)) * (1 + nz * noise(i))));

export interface SeriesOptions {
  n: number;
  base: number;
  /** %/yr, default 0 */
  growth?: number;
  /** seasonal amplitude, default 0 */
  season?: number;
  /** noise level, default 0 */
  noise?: number;
  /** seasonal phase shift in months, default 0 */
  phase?: number;
  /** shifts the noise index; series with seeds ≥ 100 apart are practically independent. Default 0 */
  seed?: number;
  /** index -> multiplier (planted spikes) */
  spikes?: Record<number, number>;
}

/** gen() with named options, a noise seed and planted spikes. With seed 0 and no spikes it equals gen(). */
export function genSeries(o: SeriesOptions): number[] {
  const { n, base, growth = 0, season = 0, noise: nz = 0, phase = 0, seed = 0, spikes = {} } = o;
  return Array.from({ length: n }, (_, i) =>
    Math.round(
      base *
        (1 + growth / 100) ** (i / 12) *
        (1 + season * Math.cos((2 * Math.PI * (i + phase)) / 12)) *
        (1 + nz * noise(i + seed)) *
        (spikes[i] ?? 1),
    ));
}

/** Monthly views as a function of the month: what the fake API serves for any requested period. */
export type MonthSeries = (m: Month) => number;

/** Growth is anchored here, so levels stay realistic whatever period is requested. */
export const ANCHOR: Month = "2024-07";

export interface GrowthOptions {
  /** seasonal amplitude, default 0 */
  season?: number;
  /** calendar month of the seasonal peak, 0 = January; default 0 */
  peak?: number;
  /** noise level, default 0 */
  noise?: number;
  /** shifts the noise index (see SeriesOptions.seed); default 0 */
  seed?: number;
  /** month -> multiplier (planted spikes) */
  spikes?: Record<Month, number>;
}

export const gens = {
  /** `base` views in ANCHOR, compounding at `pctPerYear`; seasonality follows the calendar month. */
  growth(base: number, pctPerYear: number, o: GrowthOptions = {}): MonthSeries {
    const { season = 0, peak = 0, noise: nz = 0, seed = 0, spikes = {} } = o;
    return (m) => {
      const i = monthDiff(ANCHOR, m);
      const v =
        base *
        (1 + pctPerYear / 100) ** (i / 12) *
        (1 + season * Math.cos((2 * Math.PI * (monthOfYear(m) - peak)) / 12)) *
        (1 + nz * noise(i + seed)) *
        (spikes[m] ?? 1);
      return Math.max(0, Math.round(v));
    };
  },
  /** growth(base, 0, o) */
  flat(base: number, o: GrowthOptions = {}): MonthSeries {
    return gens.growth(base, 0, o);
  },
};
