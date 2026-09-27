// Spec 04 "Verification" items 1–3.
import { describe, expect, it } from "vitest";
import { detectSpikes, rollingMedian } from "../../../scripts/src/metrics/spikes.ts";
import { gen } from "../../fake/noise.ts";

describe("detectSpikes", () => {
  it("finds the ×5 spike at index 20 of a flat noisy series and replaces it with the baseline", () => {
    const flat = gen(36, 0, 0, 0.05, 1000);
    flat[20]! *= 5;
    const { spikes, cleaned } = detectSpikes(flat);
    expect(spikes).toHaveLength(1);
    const s = spikes[0]!;
    expect(s.index).toBe(20);
    expect(s.value).toBe(5185);
    expect(s.baseline).toBe(1021);
    expect(s.ratio).toBeCloseTo(5.08, 2);
    expect(cleaned[20]).toBe(1021);
    expect(cleaned.filter((_, i) => i !== 20)).toEqual(flat.filter((_, i) => i !== 20));
  });

  it("seasonal peaks are not spikes", () => {
    expect(detectSpikes(gen(36, 10, 0.35, 0.05, 1000)).spikes).toHaveLength(0);
  });

  it("downward dips are ignored", () => {
    const xs = gen(36, 0, 0, 0.05, 1000);
    xs[15] = 100;
    expect(detectSpikes(xs).spikes).toHaveLength(0);
  });
});

describe("rollingMedian", () => {
  it("edge windows are shorter: [1, 9, 1, 1, 1], window 3 → [5, 1, 1, 1, 1]", () => {
    expect(rollingMedian([1, 9, 1, 1, 1], 3)).toEqual([5, 1, 1, 1, 1]);
  });

  it("window 7 at the edges uses 4, 5, 6 values", () => {
    expect(rollingMedian([1, 2, 3, 4, 5, 6, 7, 8], 7)).toEqual([2.5, 3, 3.5, 4, 5, 5.5, 6, 6.5]);
  });
});
