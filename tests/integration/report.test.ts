// The PDF is always exactly one A4 page, in both languages and under overflow (spec 11).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gens } from "../fake/noise.ts";
import { demoWorld, type FakeWorld } from "../fake/world.ts";
import { analyze, pdfPageCount, pdfText, setupFake } from "./helpers.ts";

const ENGLISH = ["--topic", "English language", "--topic", "English as a second or foreign language", "--langs", "pl,cs,uk,de,hu,ro"];
const HEADINGS = {
  en: { table: "By language", after: ["Interpretation (written by the AI agent)", "Assumptions & limitations"] },
  uk: { table: "За мовами", after: ["Інтерпретація (написав AI-агент)", "Припущення та обмеження"] },
};

/** Text lines of a report section: after `heading`, up to the next of `next` (or the end of the page). */
function section(lines: string[], heading: string, next: readonly string[]): string[] {
  const start = lines.indexOf(heading);
  expect(start, `"${heading}" in ${lines.join(" | ")}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && next.includes(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The numbers in the report's table. */
function tableNumbers(pdf: string, lang: keyof typeof HEADINGS): string[] {
  return section(pdfText(pdf), HEADINGS[lang].table, HEADINGS[lang].after).flatMap((l) => l.match(/[+\-−]?\d[\d,.]*/g) ?? []);
}

/** demoWorld plus fr, es, it, nl, so that English language has an article in 10 editions. */
function tenLanguageWorld(): FakeWorld {
  const w = demoWorld();
  const extra: Array<[string, string, number, number]> = [
    ["fr", "Anglais", 20_000, -3],
    ["es", "Idioma inglés", 25_000, 2],
    ["it", "Lingua inglese", 9_000, -1],
    ["nl", "Engels", 6_000, 4],
  ];
  extra.forEach(([code, title, base, growth], i) => {
    w.editions[code] = {
      views: gens.growth(300_000_000, -3, { season: 0.05, noise: 0.02, seed: 8000 + i * 100 }),
      articles: { [title]: { qid: "Q1860", views: gens.growth(base, growth, { season: 0.2, peak: 10, noise: 0.05, seed: 8050 + i * 100 }) } },
    };
  });
  return w;
}

describe("report", () => {
  beforeEach(() => {
    setupFake();
  });

  it("en and uk reports of the same run: one page each, identical table numbers", async () => {
    const en = await analyze([...ENGLISH, "--report", "--report-lang", "en"]);
    const uk = await analyze([...ENGLISH, "--report", "--report-lang", "uk"]);
    expect(pdfPageCount(en.files.report!)).toBe(1);
    expect(pdfPageCount(uk.files.report!)).toBe(1);

    const nums = tableNumbers(en.files.report!, "en");
    expect(nums).toContain("26,528"); // uk median views/month, from the JSON
    expect(nums.length).toBeGreaterThan(20);
    expect(tableNumbers(uk.files.report!, "uk")).toEqual(nums);
  });

  it("10 languages: still one page", async () => {
    setupFake(tenLanguageWorld());
    const out = await analyze(["--topic", "English language", "--topic", "English as a second or foreign language", "--langs", "pl,cs,uk,de,hu,ro,fr,es,it,nl", "--report", "--report-lang", "uk"]);
    expect(out.perLanguage.filter((x) => x.status === "ok")).toHaveLength(10);
    expect(pdfPageCount(out.files.report!)).toBe(1);
  });

  it("--notes with 2,000 characters: still one page, notes truncated", async () => {
    const notes = "Interest in English grows fastest in Ukrainian Wikipedia while the edition itself shrinks. ".repeat(23).slice(0, 2000);
    const out = await analyze([...ENGLISH, "--report", "--notes", notes]);
    expect(pdfPageCount(out.files.report!)).toBe(1);
    const shown = section(pdfText(out.files.report!), HEADINGS.en.after[0]!, HEADINGS.en.after).join(" ");
    expect(shown.length).toBeGreaterThan(100);
    expect(shown.length).toBeLessThanOrEqual(600 + 20); // NOTES_MAX_CHARS, plus the spaces joining lines
  });

  it("synthetic mode: the SYNTHETIC caveat is in the PDF", async () => {
    vi.stubEnv("WT_FAKE_API", "1");
    const out = await analyze(["--topic", "Astronomy", "--langs", "uk", "--report"]);
    expect(out.caveats[0]).toMatch(/^SYNTHETIC TEST DATA/);
    expect(pdfText(out.files.report!).join("\n")).toContain("SYNTHETIC TEST DATA");
  });
});
