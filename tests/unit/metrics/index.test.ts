// Property-style checks of the whole metric pipeline (spec 10), on series from genSeries().
import { describe, expect, it } from "vitest";
import { monthRange } from "../../../scripts/src/dates.ts";
import { computeLanguageMetrics } from "../../../scripts/src/metrics/index.ts";
import { genSeries, noise } from "../../fake/noise.ts";

const MONTHS = monthRange("2023-09", "2026-08");
const N = MONTHS.length;
const EDITION = genSeries({ n: N, base: 80_000_000, growth: -3, season: 0.1, noise: 0.02, seed: 500 });
const run = (views: number[], edition = EDITION, months = MONTHS) => computeLanguageMetrics(months, views, edition);
const spikeMonths = (r: ReturnType<typeof run>) => r.points.filter((p) => p.spike).map((p) => p.month);

describe("property: spike robustness (one ×8 spike: detected, share trend moves < 1 pp)", () => {
  for (const seed of [0, 100, 200]) {
    it(`seed ${seed}`, () => {
      const opts = { n: N, base: 4000, growth: 15, season: 0.3, noise: 0.05, seed };
      const plain = run(genSeries(opts));
      // deterministic "random" indices from the shared noise, plus both edges (shorter rolling-median windows)
      const picks = [1, 2, 3, 4].map((k) => Math.floor(((noise(seed + k * 7) + 1) / 2) * N));
      for (const idx of new Set([0, ...picks, N - 1])) {
        const spiked = run(genSeries({ ...opts, spikes: { [idx]: 8 } }));
        expect(spiked.points[idx]!.spike, `index ${idx}`).toBe(true);
        const d = Math.abs(spiked.metrics.trend!.sharePctPerYear - plain.metrics.trend!.sharePctPerYear);
        expect(d, `index ${idx}`).toBeLessThan(1);
      }
    });
  }
});

describe("property: scale invariance (views × 1000)", () => {
  for (const seed of [0, 100, 200]) {
    it(`seed ${seed}: same trend %, p, verdict and spike months`, () => {
      const views = genSeries({ n: N, base: 2000, growth: 20, season: 0.35, noise: 0.08, seed, spikes: { 14: 6 } });
      const a = run(views);
      const b = run(views.map((v) => v * 1000));
      expect(b.metrics.trend).toEqual(a.metrics.trend);
      expect(b.metrics.verdict).toBe(a.metrics.verdict);
      expect(spikeMonths(b)).toEqual(spikeMonths(a));
      expect(spikeMonths(a)).toContain(MONTHS[14]);
      expect(b.metrics.yoy?.sharePct).toBe(a.metrics.yoy?.sharePct);
    });
  }
});

describe("property: normalisation (views +4%/yr, edition −12%/yr → share 18.2 ± 1.5 %/yr)", () => {
  for (const seed of [0, 100, 200]) {
    it(`seed ${seed}`, () => {
      const views = genSeries({ n: N, base: 5000, growth: 4, season: 0.2, noise: 0.03, seed });
      const edition = genSeries({ n: N, base: 50_000_000, growth: -12, season: 0.05, noise: 0.01, seed: seed + 1000 });
      const t = run(views, edition).metrics.trend!;
      expect(Math.abs(t.sharePctPerYear - 18.2)).toBeLessThan(1.5);
      expect(t.editionPctPerYear).toBeCloseTo(-12, -0.5);
    });
  }
});

/** Every number anywhere in the value is finite. Returns the paths of the ones that are not. */
function nonFinite(x: unknown, path = "$"): string[] {
  if (typeof x === "number") return Number.isFinite(x) ? [] : [`${path} = ${x}`];
  if (Array.isArray(x)) return x.flatMap((v, i) => nonFinite(v, `${path}[${i}]`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) => nonFinite(v, `${path}.${k}`));
  return [];
}

describe("property: no NaN/Infinity in computeLanguageMetrics output", () => {
  const cases: Array<[string, number[], number[], string[]]> = [
    ["all zeros except one month", MONTHS.map((_, i) => (i === 20 ? 500 : 0)), EDITION, MONTHS],
    ["6 months", genSeries({ n: 6, base: 300, growth: 10, noise: 0.1 }), EDITION.slice(-6), MONTHS.slice(-6)],
    [
      "30% zero months",
      genSeries({ n: N, base: 200, growth: 10, season: 0.3, noise: 0.2 }).map((v, i) => (noise(i + 77) < -0.4 ? 0 : v)),
      EDITION,
      MONTHS,
    ],
  ];
  for (const [name, views, edition, months] of cases) {
    it(name, () => {
      if (name === "30% zero months") {
        const zeros = views.filter((v) => v === 0).length / views.length;
        expect(zeros).toBeGreaterThan(0.2);
        expect(zeros).toBeLessThan(0.4);
      }
      expect(nonFinite(run(views, edition, months))).toEqual([]);
    });
  }
});
