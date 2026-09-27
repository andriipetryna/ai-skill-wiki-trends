// Spec 01 "Verification" items 2–4.
import { describe, expect, it } from "vitest";
import { mad, mean, median, normalCdf, round, safeLog, sum } from "../../../scripts/src/metrics/stats.ts";

describe("stats", () => {
  it("median: odd and even length; NaN when empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it("mad([1,1,2,2,4,6,9]) → 1", () => {
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });

  it("sum and mean; mean of empty is NaN", () => {
    expect(sum([1, 2, 3.5])).toBe(6.5);
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNaN();
  });

  it("normalCdf(0) → 0.5 (6 decimals), normalCdf(1.959964) → 0.975 (4 decimals), symmetric", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });

  it("safeLog([0, 4, 8]) → [ln 2, ln 4, ln 8]: zero floored at half the smallest positive", () => {
    const r = safeLog([0, 4, 8]);
    [Math.log(2), Math.log(4), Math.log(8)].forEach((x, i) => expect(r[i]).toBeCloseTo(x, 12));
  });

  it("safeLog of all zeros is finite (floor 1)", () => {
    expect(safeLog([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("round keeps non-finite values", () => {
    expect(round(1.25, 1)).toBe(1.3);
    expect(round(-4.449, 1)).toBe(-4.4);
    expect(round(Infinity, 1)).toBe(Infinity);
    expect(round(NaN, 1)).toBeNaN();
  });
});
