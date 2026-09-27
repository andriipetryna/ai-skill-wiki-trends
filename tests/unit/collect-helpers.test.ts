import { describe, expect, it } from "vitest";
import { encodeTitle, siteFor } from "../../scripts/src/client.ts";
import { splitPeriods, sumSeries } from "../../scripts/src/collect.ts";
import { monthRange } from "../../scripts/src/dates.ts";
import { genSeries } from "../fake/noise.ts";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("splitPeriods", () => {
  // n, expected block sizes, first month of the first block (leading months that do not fill a block are dropped)
  const cases: Array<[number, number[], string]> = [
    [36, [12, 12, 12], "2023-09"],
    [30, [12, 12], "2024-09"], // 2024-03..2024-08 dropped
    [24, [12, 12], "2024-09"],
    [18, [9, 9], "2025-03"],
    [6, [3, 3], "2026-03"],
  ];
  for (const [n, sizes, firstFrom] of cases) {
    it(`${n} months → ${sizes.length} blocks of ${sizes[0]}`, () => {
      const months = monthRange("2023-09", "2026-08").slice(-n);
      const views = genSeries({ n, base: 1000, growth: 10, noise: 0.1 });
      const periods = splitPeriods(months, views);
      expect(periods.map((p) => monthRange(p.from, p.to).length)).toEqual(sizes);
      expect(periods[0]!.from).toBe(firstFrom);
      expect(periods.at(-1)!.to).toBe("2026-08");
      // consecutive, and each sum is the plain sum of its months
      for (let k = 0; k < periods.length; k++) {
        const p = periods[k]!;
        const i = months.indexOf(p.from);
        expect(p.views).toBe(sum(views.slice(i, months.indexOf(p.to) + 1)));
        if (k > 0) expect(months.indexOf(periods[k - 1]!.to)).toBe(i - 1);
      }
    });
  }
});

describe("sumSeries (basket)", () => {
  it("sums per month; missing months and null series count as 0", () => {
    const months = monthRange("2024-01", "2024-04");
    const a = new Map([["2024-01", 10], ["2024-02", 20], ["2024-03", 30], ["2024-04", 40]]);
    const b = new Map([["2024-02", 5], ["2024-04", 1]]);
    expect(sumSeries(months, [a, b, null])).toEqual([10, 25, 30, 41]);
    expect(sumSeries(months, [])).toEqual([0, 0, 0, 0]);
  });
});

describe("siteFor", () => {
  it("maps Wikipedia codes to Wikidata sitelink keys", () => {
    expect(siteFor("uk")).toBe("ukwiki");
    expect(siteFor("zh-yue")).toBe("zh_yuewiki");
    expect(siteFor("be-tarask")).toBe("be_x_oldwiki");
  });
});

describe("encodeTitle", () => {
  it("spaces become underscores, slashes are encoded", () => {
    expect(encodeTitle("Post przerywany")).toBe("Post_przerywany");
    expect(encodeTitle("AC/DC")).toBe("AC%2FDC");
  });
});
