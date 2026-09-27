// Spec 07 "Verification" items 1–3.
import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, rankLanguages, type RankInput } from "../../../scripts/src/metrics/ranking.ts";

const rows: RankInput[] = [
  { lang: "a", medianMonthlyViews: 100000, trendPctPerYear: 0, confidenceScore: 0.9, sharePerMillion: 10 },
  { lang: "b", medianMonthlyViews: 2000, trendPctPerYear: 40, confidenceScore: 0.9, sharePerMillion: 50 },
  { lang: "c", medianMonthlyViews: 10000, trendPctPerYear: 10, confidenceScore: 0.45, sharePerMillion: 20 },
];

describe("rankLanguages", () => {
  it("default weights → a, b, c; a above b through the tie-break on volume", () => {
    const r = rankLanguages(rows, DEFAULT_WEIGHTS);
    expect(r.map((x) => x.lang)).toEqual(["a", "b", "c"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r[0]).toMatchObject({ score: 0.67, components: { volume: 1, growth: 0, confidence: 1, share: 0 } });
    expect(r[1]!.score).toBe(0.67);
    expect(r[2]).toMatchObject({ score: 0.22, components: { volume: 0.41, growth: 0.25, confidence: 0, share: 0.43 } });
  });

  it("growth: 3 → b (0.8), a (0.4), c (0.23)", () => {
    const r = rankLanguages(rows, { ...DEFAULT_WEIGHTS, growth: 3 });
    expect(r.map((x) => [x.lang, x.score])).toEqual([["b", 0.8], ["a", 0.4], ["c", 0.23]]);
  });

  it("volume: 3 → a (0.8), b (0.4), c (0.3)", () => {
    const r = rankLanguages(rows, { ...DEFAULT_WEIGHTS, volume: 3 });
    expect(r.map((x) => [x.lang, x.score])).toEqual([["a", 0.8], ["b", 0.4], ["c", 0.3]]);
  });

  it("a component that does not vary is 0.5 for everyone", () => {
    const same = rows.map((x) => ({ ...x, confidenceScore: 0.7 }));
    expect(rankLanguages(same, DEFAULT_WEIGHTS).map((x) => x.components.confidence)).toEqual([0.5, 0.5, 0.5]);
  });

  it("all weights 0 → every score 0; order falls back to confidence, volume, lang", () => {
    const r = rankLanguages(rows, { volume: 0, growth: 0, confidence: 0, share: 0 });
    expect(r.map((x) => x.score)).toEqual([0, 0, 0]);
    expect(r.map((x) => x.lang)).toEqual(["a", "b", "c"]);
  });

  it("identical rows are ordered by lang", () => {
    const r = rankLanguages([{ ...rows[0]!, lang: "z" }, { ...rows[0]!, lang: "m" }], DEFAULT_WEIGHTS);
    expect(r.map((x) => x.lang)).toEqual(["m", "z"]);
  });

  it("growth is clamped to [−100, 200]; a non-finite trend counts as 0", () => {
    const r = rankLanguages(
      [
        { ...rows[0]!, lang: "x", trendPctPerYear: 5000 },
        { ...rows[0]!, lang: "y", trendPctPerYear: 50 },
        { ...rows[0]!, lang: "w", trendPctPerYear: NaN },
      ],
      { volume: 0, growth: 1, confidence: 0, share: 0 },
    );
    // raw growth 200, 50, 0 → (x − 0) / 200
    expect(Object.fromEntries(r.map((x) => [x.lang, x.components.growth]))).toEqual({ x: 1, y: 0.25, w: 0 });
  });
});
