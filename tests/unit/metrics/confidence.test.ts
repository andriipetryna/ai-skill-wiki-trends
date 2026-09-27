// Spec 06 "Verification": the confidence table and the verdict cases.
import { describe, expect, it } from "vitest";
import { assessConfidence, verdictFor, type ConfidenceInput, type ConfidenceLevel } from "../../../scripts/src/metrics/confidence.ts";

const B: ConfidenceInput = {
  medianMonthlyViews: 20000,
  months: 36,
  pValue: 0.001,
  trendPctPerYear: 25,
  viewsTrendPctPerYear: 20,
  yoyPct: 22,
  yoyPctWithSpikes: 23,
  spikesInLast12: 0,
  zeroMonthsShare: 0,
};

describe("assessConfidence", () => {
  const table: Array<[string, ConfidenceInput, ConfidenceLevel, number, string[]]> = [
    ["base", B, "high", 1, ["volume_ok", "significant"]],
    ["low volume caps at medium", { ...B, medianMonthlyViews: 500 }, "medium", 0.7, ["low_volume", "significant"]],
    ["very low volume", { ...B, medianMonthlyViews: 40 }, "low", 0.5, ["very_low_volume", "significant"]],
    ["spike-driven", { ...B, yoyPct: 3, yoyPctWithSpikes: 45 }, "medium", 0.6, ["volume_ok", "significant", "spike_driven"]],
    ["weakly significant", { ...B, pValue: 0.12 }, "high", 0.75, ["volume_ok", "weak_significance"]],
    ["not significant", { ...B, pValue: 0.5, trendPctPerYear: 30, yoyPct: 28, yoyPctWithSpikes: 28 }, "medium", 0.55, ["volume_ok", "not_significant"]],
    ["short history", { ...B, months: 18 }, "high", 0.85, ["volume_ok", "short_history", "significant"]],
    ["YoY vs trend disagree (score only)", { ...B, yoyPct: -10, yoyPctWithSpikes: -10 }, "high", 0.8, ["volume_ok", "significant", "inconsistent_signals"]],
  ];
  for (const [name, input, level, score, codes] of table) {
    it(`${name} → ${level}, ${score}, [${codes.join(", ")}]`, () => {
      const r = assessConfidence(input);
      expect(r.level).toBe(level);
      expect(r.score).toBe(score);
      expect(r.reasons.map((x) => x.code)).toEqual(codes);
    });
  }

  it("the remaining rules: recent spike, sign flip by normalisation, gaps", () => {
    const r = assessConfidence({ ...B, spikesInLast12: 1, viewsTrendPctPerYear: -15, zeroMonthsShare: 0.2 });
    expect(r.reasons.map((x) => x.code)).toEqual(["volume_ok", "significant", "recent_spike", "normalisation_flips_sign", "gaps"]);
    expect(r.score).toBe(0.6);
    expect(r.level).toBe("medium");
    expect(r.reasons.find((x) => x.code === "gaps")?.message).toBe("20% of months have zero views");
  });

  it("reasons carry an effect sign", () => {
    const r = assessConfidence({ ...B, medianMonthlyViews: 40 });
    expect(r.reasons.map((x) => x.effect)).toEqual(["-", "+"]);
  });

  it("score is clamped to [0, 1]", () => {
    const r = assessConfidence({ ...B, medianMonthlyViews: 10, months: 6, pValue: 0.9, yoyPct: 3, yoyPctWithSpikes: 45, zeroMonthsShare: 0.5 });
    expect(r.score).toBe(0);
    expect(r.level).toBe("low");
  });
});

describe("verdictFor", () => {
  const cases: Array<[number, number, string]> = [
    [20, 0.01, "growing"],
    [-20, 0.01, "declining"],
    [3, 0.5, "flat"],
    [30, 0.4, "inconclusive"],
    [4.9, 0.0001, "flat"],
  ];
  for (const [trend, p, verdict] of cases) {
    it(`(${trend}, ${p}) → ${verdict}`, () => expect(verdictFor(trend, p)).toBe(verdict));
  }

  it("NaN input → inconclusive", () => {
    expect(verdictFor(NaN, NaN)).toBe("inconclusive");
  });
});
