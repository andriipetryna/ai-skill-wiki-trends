// The eval number-hallucination checker (evals/graders/numbers.ts, spec 13).
import { describe, expect, it } from "vitest";
import { checkNumbers, collectAllowed, extractNumbers, isIgnored, isSupported, scrub, type ExtractedNumber } from "../../evals/graders/numbers.ts";

const one = (text: string): ExtractedNumber => {
  const xs = extractNumbers(text);
  expect(xs, text).toHaveLength(1);
  return xs[0]!;
};
const values = (text: string) => extractNumbers(text).map((n) => n.value);

describe("extractNumbers: formats", () => {
  it("signed percentages with a decimal comma or point", () => {
    expect(one("+39,6%")).toMatchObject({ value: 39.6, percent: true, scaled: false, decimals: 1 });
    expect(one("зросла на +16.8%/рік")).toMatchObject({ value: 16.8, percent: true });
    expect(one("−12,0 %")).toMatchObject({ value: -12, percent: true });
    expect(one("-4%")).toMatchObject({ value: -4, percent: true });
    expect(one("15 відсотків")).toMatchObject({ value: 15, percent: true });
  });

  it("thousands separated by spaces (incl. no-break and thin spaces) or commas", () => {
    expect(one("5 712 переглядів").value).toBe(5712);
    expect(one("5 712").value).toBe(5712);
    expect(one("5 712").value).toBe(5712);
    expect(one("1 234 567").value).toBe(1_234_567);
    expect(one("1,234,567").value).toBe(1_234_567);
    expect(one("1 234,5").value).toBe(1234.5);
    expect(one("1,234.5").value).toBe(1234.5);
  });

  it("an ambiguous comma or point before three digits keeps both readings", () => {
    const comma = one("5,712");
    expect(comma.value).toBe(5712);
    expect(comma.alternatives.map((a) => a.value)).toEqual([5.712]);
    const point = one("5.712");
    expect(point.value).toBe(5.712);
    expect(point.alternatives.map((a) => a.value)).toEqual([5712]);
  });

  it("a leading zero is always a decimal: 0,001 and p<0.001", () => {
    expect(one("0,001")).toMatchObject({ value: 0.001, alternatives: [] });
    expect(one("p<0.001")).toMatchObject({ value: 0.001, decimals: 3 });
    expect(one("p = 0,009").value).toBe(0.009);
  });

  it("multipliers: тис., k, млн, million", () => {
    expect(one("5,7 тис. переглядів")).toMatchObject({ value: 5700, scaled: true });
    expect(one("5.7k")).toMatchObject({ value: 5700, scaled: true });
    expect(one("близько 9 тисяч")).toMatchObject({ value: 9000, scaled: true });
    expect(one("3 млн")).toMatchObject({ value: 3_000_000, scaled: true });
    expect(one("1.5 million")).toMatchObject({ value: 1_500_000, scaled: true });
    expect(one("12 Mann–Kendall").scaled).toBe(false);
  });

  it("numbers glued to words are not quantities", () => {
    expect(values("COVID-19 і mp3")).toEqual([]);
    expect(values("у 1,8× вище за базовий рівень")).toEqual([1.8]);
  });
});

describe("scrub", () => {
  it("removes URLs, paths, file names, run ids, QIDs, dates, years and CLI flags", () => {
    const text = [
      "![Chart](/var/folders/x/T/wt-eval-a1/out/wiki-trends-20260927-182956/chart.png)",
      "[report-uk.pdf](/tmp/out/wiki-trends-20260927-182956/report-uk.pdf)",
      "Дивіться https://uk.wikipedia.org/wiki/Астрономія?x=12345 та ./out/data.json і ~/Downloads/r2.pdf",
      "Стаття Q1666254, період 2023-09 – 2026-08, сплеск 2025-10-01, у 2025 році",
      "`scripts/wt analyze --topic Astronomy --langs uk --months 18 --weights growth=3`",
      "run 20260927-182956",
    ].join("\n");
    expect(values(text)).toEqual([]);
  });

  it("keeps %/yr: only tokens starting with / are paths", () => {
    expect(values("+16.8%/yr and 3.1 %/рік")).toEqual([16.8, 3.1]);
    expect(scrub("a /tmp/x b")).not.toContain("tmp");
  });

  it("keeps thousands that merely look like years inside a grouped number", () => {
    expect(values("1,950 views")).toEqual([1950]);
  });
});

describe("isIgnored: bare integers ≤ 12 are counts", () => {
  it("ignores counts and list numbering, not percentages or decimals", () => {
    expect(isIgnored(one("2 роки"))).toBe(true);
    expect(isIgnored(one("12 місяців"))).toBe(true);
    expect(isIgnored(one("13 місяців"))).toBe(false);
    expect(isIgnored(one("12%"))).toBe(false);
    expect(isIgnored(one("2.5"))).toBe(false);
    expect(isIgnored(one("5 тис."))).toBe(false);
  });
});

describe("isSupported: tolerance rules", () => {
  const ok = (text: string, allowed: number[]) => isSupported(one(text), allowed);

  it("exact, and within 0.051 when written with ≤ 1 decimal", () => {
    expect(ok("16.8%", [16.8])).toBe(true);
    expect(ok("16,8%", [16.83])).toBe(true);
    expect(ok("16.9%", [16.83])).toBe(false);
    // three decimals are not "rounded to 1 decimal": p=0.050 is not supported by p=0
    expect(ok("0.050", [0])).toBe(false);
  });

  it("within 0.5 when the answer is an integer", () => {
    expect(ok("165", [164.59])).toBe(true);
    expect(ok("17%", [16.8])).toBe(true);
    expect(ok("18%", [16.8])).toBe(false);
  });

  it("within 5% when scaled, or rounded to the written unit", () => {
    expect(ok("5,7 тис.", [5712])).toBe(true);
    expect(ok("9.3k", [9263])).toBe(true);
    expect(ok("5,4 тис.", [5712])).toBe(false);
    expect(ok("6 тис.", [5712])).toBe(true); // 5% off, but 5712 rounds to 6 thousand
    expect(ok("7 тис.", [5712])).toBe(false);
  });

  it("within 2% for a round hundred", () => {
    expect(ok("about 9000", [9011])).toBe(true);
    expect(ok("9 300", [9263])).toBe(true);
    expect(ok("9000", [9300])).toBe(false);
    expect(ok("9010", [9011.9])).toBe(false);
  });

  it("a 0–1 score quoted ×100", () => {
    expect(ok("97%", [0.97])).toBe(true);
    expect(ok("97 балів", [0.97])).toBe(true);
    expect(ok("90%", [0.97])).toBe(false);
  });

  it("signs are compared by magnitude: 'падіння на 12%' is supported by −12", () => {
    expect(ok("падіння на 12%", [-12].map(Math.abs))).toBe(true);
    expect(ok("−12%", collectAllowed([{ x: -12 }]))).toBe(true);
  });

  it("either reading of an ambiguous separator", () => {
    expect(ok("5,712", [5.712])).toBe(true);
    expect(ok("5,712", [5712])).toBe(true);
  });
});

describe("collectAllowed", () => {
  const data = {
    perLanguage: [
      {
        lang: "uk",
        totalViews: 330218,
        monthly: [{ month: "2025-10", views: 77777, sharePerMillion: 123.45 }],
        metrics: { medianMonthlyViews: 9263, confidence: { reasons: ["+ Median 9263 views/month", "+ Trend is statistically significant (p<0.001)"] } },
      },
    ],
    findings: ["uk: growing — share of edition traffic +16.8%/yr (p<0.001), YoY +15.3%, median 9,263 views/month; confidence high."],
  };

  it("numbers and numbers inside strings; monthly arrays skipped", () => {
    const allowed = collectAllowed([data]);
    for (const x of [330218, 9263, 16.8, 15.3, 0.001]) expect(allowed).toContain(x);
    expect(allowed).not.toContain(77777);
    expect(allowed).not.toContain(123.45);
  });

  it("numbers from the prompts", () => {
    expect(collectAllowed([], ["Порівняй за 18 місяців і 250 000 переглядів"])).toEqual(expect.arrayContaining([18, 250000]));
  });

  it("thresholds SKILL.md states may be quoted", () => {
    expect(checkNumbers("flat = у межах ±5%/рік, p < 0,1", collectAllowed([])).unsupported).toEqual([]);
  });
});

describe("checkNumbers", () => {
  const allowed = collectAllowed([{ sharePctPerYear: 16.8, yoy: 15.3, viewsPctPerYear: 3.1, editionPctPerYear: -12, median: 9263, last12Avg: 164.59 }]);

  it("an answer that only copies numbers passes", () => {
    const answer = "Так, інтерес зростає: **+16,8 %/рік** (p<0.001 не потрібне тут), рік до року +15,3 %; медіана 9 263 перегляди, ≈165 на мільйон. Трафік розділу падає на 12 %/рік, сирі перегляди +3,1 %.";
    const res = checkNumbers(answer.replace("(p<0.001 не потрібне тут)", ""), allowed);
    expect(res.unsupported).toEqual([]);
    expect(res.checked).toBe(6);
  });

  it("flags an invented number: 'зросло на 52%'", () => {
    expect(checkNumbers("Інтерес зросло на 52% за два роки, а тренд +16,8%/рік.", allowed).unsupported).toEqual(["52%"]);
  });

  it("flags the agent's own arithmetic (a ratio of views)", () => {
    expect(checkNumbers("В українській у 2,3 раза більше переглядів, різниця 13,7 п.п.", allowed).unsupported).toEqual(["2,3", "13,7 п.п."]);
  });
});
