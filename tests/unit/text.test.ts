import { describe, expect, it } from "vitest";
import type { LanguageResult } from "../../scripts/src/collect.ts";
import { monthRange } from "../../scripts/src/dates.ts";
import { computeLanguageMetrics } from "../../scripts/src/metrics/index.ts";
import { DEFAULT_WEIGHTS, rankLanguages, type RankInput } from "../../scripts/src/metrics/ranking.ts";
import { buildAnswerChecklist, buildCaveats, buildFindings, pfmt, renderCaveat, signed, type AnalysisResult, type Caveat, type UiLang } from "../../scripts/src/text.ts";
import { genSeries } from "../fake/noise.ts";

// ---- fixture: a fixed result built from synthetic series (no hand-typed metrics)

const MONTHS = monthRange("2023-09", "2026-08");
const N = MONTHS.length;
type Row = Omit<LanguageResult, "monthly">;

function okRow(lang: string, views: number[], edition: number[], ranks: RankInput[]): Row {
  const { metrics, rankInput } = computeLanguageMetrics(MONTHS, views, edition);
  ranks.push({ lang, ...rankInput });
  const total = views.reduce((a, b) => a + b, 0);
  return { lang, status: "ok", articles: [`Title ${lang}`], redirectsIncluded: 2, missingTopics: [], totalViews: total, avgMonthlyViews: Math.round(total / N), periods: [], metrics };
}

function emptyRow(lang: string, status: "no_article" | "no_data", extra: Partial<Row> = {}): Row {
  return { lang, status, articles: [], redirectsIncluded: 0, missingTopics: [], totalViews: 0, avgMonthlyViews: 0, periods: [], metrics: null, ...extra };
}

/** `langs` picks and orders the languages; perLanguage is deliberately in a different order than query.langs. */
function fixture(langs: string[]): AnalysisResult {
  const flatEdition = genSeries({ n: N, base: 80_000_000, noise: 0.02, seed: 900 });
  const ranks: RankInput[] = [];
  const all: Row[] = [
    okRow("uk", genSeries({ n: N, base: 20_000, growth: 25, season: 0.3, noise: 0.05 }), flatEdition, ranks),
    // very low volume, and an edition shrinking 15%/yr (edition-shift finding)
    okRow("de", genSeries({ n: N, base: 60, growth: 5, noise: 0.2, seed: 100 }), genSeries({ n: N, base: 200_000_000, growth: -15, seed: 300 }), ranks),
    okRow("ro", genSeries({ n: N, base: 40, noise: 0.3, seed: 200 }), flatEdition, ranks),
    emptyRow("pl", "no_article", { missingTopics: ["Intermittent fasting"], suggestions: [{ title: "Głodówka lecznicza", qid: "Q9" }] }),
    emptyRow("cs", "no_data", { articles: ["Přerušovaný půst"] }),
  ];
  const perLanguage = all.filter((x) => langs.includes(x.lang));
  const ranked = langs.flatMap((l) => ranks.find((r) => r.lang === l) ?? []);
  return {
    query: { topics: ["Intermittent fasting"], articles: {}, langs, from: MONTHS[0]!, to: MONTHS.at(-1)!, redirects: true, weights: DEFAULT_WEIGHTS },
    resolution: [
      {
        input: "Intermittent fasting",
        status: "ok",
        matchedBy: "exact_title",
        qid: "Q5",
        label: "Intermittent fasting",
        articles: Object.fromEntries(langs.map((l) => [l, l === "pl" ? null : `Title ${l}`])),
        alternatives: [],
      },
    ],
    perLanguage,
    ranking: ranked.length >= 2 ? rankLanguages(ranked, DEFAULT_WEIGHTS) : [],
  };
}

const FULL = fixture(["pl", "uk", "de", "cs", "ro"]);

// ---- number extraction (minimal; replace with extractNumbers() from spec 13 once evals/graders/numbers.ts exists)

/** Numbers written in a sentence: signs (incl. U+2212), thousands commas, decimals. Fixed-text numbers are scrubbed. */
function extractNumbers(text: string): number[] {
  const scrubbed = text
    .replace(/p<0\.001/g, "") // pfmt's threshold, not a value
    .replace(/last 12 months|останні 12 місяців/g, ""); // fixed wording of the relative-interest line
  return [...scrubbed.matchAll(/[+\-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+\-−]?\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace("−", "-").replace(/,/g, "")));
}

/** Every number in the object: numeric values and numbers inside strings. */
function numbersIn(x: unknown): number[] {
  if (typeof x === "number") return [x];
  if (typeof x === "string") return extractNumbers(x);
  if (Array.isArray(x)) return x.flatMap(numbersIn);
  if (x && typeof x === "object") return Object.values(x).flatMap(numbersIn);
  return [];
}

// ---- tests

describe("formatters", () => {
  it("signed: one decimal with a sign, n/a for null", () => {
    expect(signed(12.34)).toBe("+12.3%");
    expect(signed(-4.5)).toBe("-4.5%");
    expect(signed(null)).toBe("n/a");
    expect(signed(NaN)).toBe("n/a");
  });

  it("pfmt: p<0.001 below the threshold, else 3 decimals", () => {
    expect(pfmt(0.0004)).toBe("p<0.001");
    expect(pfmt(0.1234)).toBe("p=0.123");
    expect(pfmt(null)).toBe("p=n/a");
  });
});

describe("buildFindings", () => {
  for (const lang of ["en", "uk"] as UiLang[]) {
    describe(lang, () => {
      const findings = buildFindings(FULL, lang);

      it("one sentence per language, in --langs order, first", () => {
        expect(findings.slice(0, 5).map((f) => f.split(":")[0])).toEqual(FULL.query.langs);
      });

      it("no_article shows the closest suggestions", () => {
        expect(findings[0]).toContain("«Głodówka lecznicza»");
      });

      it("relative interest is per million pageviews, not per million people", () => {
        const rel = findings.filter((f) => /Relative interest|Відносний інтерес/.test(f));
        expect(rel).toHaveLength(1);
        expect(rel[0]).toMatch(lang === "en" ? /not per million people/ : /а не на мільйон людей/);
      });

      it("has the ranking line and the edition-shift note for de", () => {
        expect(findings.some((f) => f.startsWith(lang === "en" ? "Suggested order to investigate:" : "Порядок для подальшого дослідження:"))).toBe(true);
        expect(findings.filter((f) => f.includes("de.wikipedia"))).toHaveLength(1);
      });

      it("every number in every finding appears in the input object", () => {
        const allowed = numbersIn(FULL);
        for (const f of findings) {
          for (const n of extractNumbers(f)) {
            expect(allowed.some((a) => Math.abs(a - n) < 1e-9), `${n} in "${f}"`).toBe(true);
          }
        }
      });
    });
  }

  it("no relative-interest line with fewer than 2 languages that have metrics", () => {
    for (const langs of [["uk"], ["pl", "uk", "cs"]]) {
      const findings = buildFindings(fixture(langs), "en");
      expect(findings.filter((f) => f.startsWith("Relative interest")), langs.join(",")).toEqual([]);
      expect(findings.filter((f) => f.startsWith("Suggested order")), langs.join(",")).toEqual([]);
    }
  });
});

describe("buildAnswerChecklist", () => {
  it("the PDF item comes first when a report path is given, then the chart item", () => {
    const c = buildAnswerChecklist(FULL, "/out/report-en.pdf", "/out/chart.png");
    expect(c[0]).toContain("/out/report-en.pdf");
    expect(c[1]).toContain("![Chart](/out/chart.png)");
    expect(buildAnswerChecklist(FULL, null, "/out/chart.png")[0]).toContain("![Chart](/out/chart.png)");
    expect(buildAnswerChecklist(FULL, null, null).some((x) => x.includes(".pdf"))).toBe(false);
  });

  it("a LOW item names each low-confidence language with its first negative reason", () => {
    const low = FULL.perLanguage.filter((x) => x.metrics?.confidence.level === "low").map((x) => x.lang);
    expect(low.sort()).toEqual(["de", "ro"]);
    const item = buildAnswerChecklist(FULL, null).find((x) => x.includes("LOW"));
    expect(item).toBeDefined();
    for (const l of low) expect(item).toContain(`${l} (Median`);
    expect(item).not.toContain("uk");
  });

  it("the --article item appears only when a language has no article", () => {
    const item = (r: AnalysisResult) => buildAnswerChecklist(r, null).find((x) => x.includes("--article"));
    expect(item(FULL)).toContain("pl");
    expect(item(fixture(["uk", "de"]))).toBeUndefined();
  });
});

describe("caveats", () => {
  // one sample per code; the mapped type makes typecheck fail when a new code is added without a sample
  const samples: { [K in Caveat["code"]]: Caveat & { code: K } } = {
    synthetic: { code: "synthetic" },
    interest_not_demand: { code: "interest_not_demand" },
    share_normalisation: { code: "share_normalisation" },
    short_period: { code: "short_period" },
    redirects_on: { code: "redirects_on" },
    redirects_off: { code: "redirects_off" },
    single_article: { code: "single_article" },
    cross_language: { code: "cross_language" },
    bots: { code: "bots" },
    period: { code: "period", params: { from: "2024-09", to: "2026-08" } },
    search_resolved: { code: "search_resolved", params: { input: "fasting", label: "Intermittent fasting", qid: "Q5", alternatives: ["Fasting"] } },
    missing_articles: { code: "missing_articles", params: { topic: "Intermittent fasting", langs: ["pl", "cs"] } },
    manual_article: { code: "manual_article", params: { lang: "pl", title: "Głodówka lecznicza" } },
  };

  for (const c of Object.values(samples)) {
    it(`renderCaveat(${c.code}) exists in en and uk`, () => {
      const en = renderCaveat(c, "en");
      const uk = renderCaveat(c, "uk");
      for (const s of [en, uk]) {
        expect(typeof s).toBe("string");
        expect(s.length).toBeGreaterThan(10);
        expect(s).not.toMatch(/undefined|null|NaN|\[object/);
      }
      expect(uk).not.toBe(en);
      expect(uk).toMatch(/[а-яіїєґ]/i);
    });
  }

  it("buildCaveats follows the data", () => {
    const codes = buildCaveats(FULL).map((c) => c.code);
    expect(codes.slice(0, 3)).toEqual(["interest_not_demand", "share_normalisation", "period"]);
    expect(codes).toContain("missing_articles");
    expect(codes).toContain("redirects_on");
    expect(codes).toContain("cross_language");
    expect(codes).not.toContain("short_period");
    expect(codes.at(-1)).toBe("bots");
  });
});
