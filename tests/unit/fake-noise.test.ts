import { describe, expect, it } from "vitest";
import { gen, gens, genSeries, noise } from "../fake/noise.ts";

describe("fake/noise", () => {
  it("noise() is deterministic and in [-1, 1)", () => {
    const xs = Array.from({ length: 500 }, (_, i) => noise(i));
    expect(xs).toEqual(Array.from({ length: 500 }, (_, i) => noise(i)));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it("genSeries() with seed 0 and no spikes equals gen()", () => {
    expect(genSeries({ n: 36, base: 1000, growth: 15, season: 0.3, noise: 0.05, phase: 2 })).toEqual(gen(36, 15, 0.3, 0.05, 1000, 2));
  });

  it("genSeries() plants spikes as multipliers", () => {
    const plain = genSeries({ n: 24, base: 500 });
    const spiked = genSeries({ n: 24, base: 500, spikes: { 20: 5 } });
    expect(spiked[20]).toBe(plain[20]! * 5);
    expect(spiked.filter((_, i) => i !== 20)).toEqual(plain.filter((_, i) => i !== 20));
  });

  it("gens.growth() is anchored: base in 2024-07, compounding per year", () => {
    const s = gens.growth(1000, 10);
    expect(s("2024-07")).toBe(1000);
    expect(s("2025-07")).toBe(1100);
    expect(s("2023-07")).toBe(909);
  });
});
