// Spec 05 "Verification" items 1–6. Percentages ±0.05, p ±0.0005 (toBeCloseTo with 1 / 3 digits).
import { describe, expect, it } from "vitest";
import { mannKendall, monthlyTrend, seasonalMannKendall, seasonalSen, theilSen } from "../../../scripts/src/metrics/trend.ts";
import { gen, genSeries } from "../../fake/noise.ts";

const pct = (slope: number) => (Math.exp(slope * 12) - 1) * 100;

describe("mannKendall", () => {
  it("[1..5]: s 10, varS 16.667, z 2.2045, p 0.0275", () => {
    const r = mannKendall([1, 2, 3, 4, 5]);
    expect(r.s).toBe(10);
    expect(r.varS).toBeCloseTo(16.667, 3);
    expect(r.z).toBeCloseTo(2.2045, 4);
    expect(r.p).toBeCloseTo(0.0275, 4);
  });

  it("[1,2,2,3] with the tie correction: s 5, varS 7.667, z 1.4446, p 0.1486", () => {
    const r = mannKendall([1, 2, 2, 3]);
    expect(r.s).toBe(5);
    expect(r.varS).toBeCloseTo(7.667, 3);
    expect(r.z).toBeCloseTo(1.4446, 4);
    expect(r.p).toBeCloseTo(0.1486, 4);
  });

  it("flat series: s 0, varS 0, z 0, p 1", () => {
    expect(mannKendall([5, 5, 5, 5])).toEqual({ s: 0, varS: 0, z: 0, p: 1 });
  });

  it("decreasing series gives a negative z", () => {
    const r = mannKendall([5, 4, 3, 2, 1]);
    expect(r.s).toBe(-10);
    expect(r.z).toBeCloseTo(-2.2045, 4);
  });
});

describe("seasonalMannKendall", () => {
  it("sums S over calendar months: two years of a strictly rising cycle → S = 12", () => {
    const y = Array.from({ length: 24 }, (_, i) => Math.cos((2 * Math.PI * i) / 12) + i / 100);
    const r = seasonalMannKendall(y, 0);
    expect(r.s).toBe(12);
    expect(r.varS).toBeCloseTo(12 * ((2 * 1 * 9) / 18), 10);
  });
});

describe("theilSen", () => {
  it("one wild outlier does not move the slope: y = 2i + 1, y[7] = 500 → exactly 2", () => {
    const y = Array.from({ length: 20 }, (_, i) => 2 * i + 1);
    y[7] = 500;
    expect(theilSen(y)).toBe(2);
  });

  it("NaN with fewer than 2 points", () => {
    expect(theilSen([1])).toBeNaN();
  });
});

describe("regression: plain Theil–Sen is biased by seasonality", () => {
  // +4%/yr with a 35% seasonal cycle, phase 4, 24 months
  const y = Array.from({ length: 24 }, (_, i) => Math.log(1000 * 1.04 ** (i / 12) * (1 + 0.35 * Math.cos((2 * Math.PI * (i + 4)) / 12))));

  it("seasonalSen recovers 4.00 %/yr", () => {
    expect(pct(seasonalSen(y))).toBeCloseTo(4.0, 1);
  });

  it("theilSen reports 24.61 %/yr on the same data", () => {
    expect(pct(theilSen(y))).toBeCloseTo(24.61, 1);
  });

  it("monthlyTrend uses the seasonal slope for 24+ months", () => {
    const values = y.map(Math.exp);
    expect(monthlyTrend(values, 4).pctPerYear).toBeCloseTo(4.0, 1);
  });
});

describe("monthlyTrend", () => {
  // gen(36, g, 0.35, 0.05, 5000), startMonth 0
  const table: Array<[number, number, number]> = [
    [-20, -20.47, 0],
    [0, -0.6, 0.8802],
    [15, 14.3, 0],
    [40, 39.16, 0],
  ];
  for (const [g, pctPerYear, pValue] of table) {
    it(`g = ${g} → ${pctPerYear} %/yr, p ${pValue}`, () => {
      const r = monthlyTrend(gen(36, g, 0.35, 0.05, 5000), 0);
      expect(r.test).toBe("seasonal_mann_kendall");
      expect(r.pctPerYear).toBeCloseTo(pctPerYear, 1);
      expect(r.pValue).toBeCloseTo(pValue, 3);
    });
  }

  it("fewer than 24 months → plain Theil–Sen + Mann–Kendall", () => {
    const r = monthlyTrend(gen(18, 20, 0, 0.02, 5000), 0);
    expect(r.test).toBe("mann_kendall");
    expect(r.pctPerYear).toBeCloseTo(20, -0.5);
  });

  it("pctPerYear is NaN with fewer than 2 months", () => {
    expect(monthlyTrend([100], 0).pctPerYear).toBeNaN();
  });
});

describe("property: trend recovery (|pctPerYear − g| < 3, 36 months, noise 0.05)", () => {
  for (const g of [-30, -10, 0, 10, 30, 60]) {
    for (const season of [0, 0.35]) {
      it(`g = ${g}, season = ${season}`, () => {
        for (const seed of [0, 100, 200, 300]) {
          for (const phase of [0, 5]) {
            const r = monthlyTrend(genSeries({ n: 36, base: 3000, growth: g, season, noise: 0.05, seed, phase }), 0);
            expect(Math.abs(r.pctPerYear - g), `seed ${seed}, phase ${phase}: ${r.pctPerYear}`).toBeLessThan(3);
          }
        }
      });
    }
  }
});
