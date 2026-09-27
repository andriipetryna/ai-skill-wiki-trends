// The three examples of the brief, end to end on the fake world (spec 11). Expected values: tests/fake/world.ts.
import { existsSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { analyze, lang, pdfPageCount, setupFake } from "./helpers.ts";

const FASTING = ["--topic", "Intermittent fasting", "--langs", "pl,cs", "--years", "2"];
const ENGLISH = ["--topic", "English language", "--topic", "English as a second or foreign language", "--langs", "pl,cs,uk,de,hu,ro"];

beforeEach(() => {
  setupFake();
});

describe("Intermittent fasting, pl vs cs, 2 years", () => {
  it("pl has no article and gets suggestions; cs has a spike that does not make it growing", async () => {
    const out = await analyze(FASTING);
    expect(out.query).toMatchObject({ from: "2024-09", to: "2026-08" });

    const pl = lang(out, "pl");
    expect(pl.status).toBe("no_article");
    expect(pl.metrics).toBeNull();
    expect(pl.suggestions?.map((s) => s.title)).toContain("Głodówka lecznicza");

    const cs = lang(out, "cs");
    expect(cs.status).toBe("ok");
    expect(cs.metrics!.spikes.map((s) => s.month)).toContain("2025-10");
    expect(cs.metrics!.verdict).not.toBe("growing");
    // the spike inflates the change when it is left in
    expect(cs.metrics!.yoy!.sharePctWithSpikes!).toBeGreaterThan(cs.metrics!.yoy!.sharePct);
  });

  it('--article pl="Głodówka lecznicza" makes pl ok and growing', async () => {
    const out = await analyze([...FASTING, "--article", "pl=Głodówka lecznicza"]);
    const pl = lang(out, "pl");
    expect(pl.status).toBe("ok");
    expect(pl.articles).toEqual(["Głodówka lecznicza"]);
    expect(pl.metrics!.verdict).toBe("growing");
  });
});

describe("Astronomy, uk", () => {
  it("share grows much faster than raw views: normalization in action", async () => {
    const uk = lang(await analyze(["--topic", "Astronomy", "--langs", "uk"]), "uk");
    expect(uk.status).toBe("ok");
    expect(uk.metrics!.sharePerMillion.last12Avg).toBeGreaterThan(0);
    const t = uk.metrics!.trend!;
    expect(t.sharePctPerYear).toBeGreaterThanOrEqual(14);
    expect(t.sharePctPerYear).toBeLessThanOrEqual(22);
    expect(t.viewsPctPerYear).toBeGreaterThanOrEqual(2);
    expect(t.viewsPctPerYear).toBeLessThanOrEqual(6);
  });
});

describe("Learning English, basket of 6 languages, uk report", () => {
  it("missing topics, low confidence for ro, uk ranks first, one-page report and chart files", async () => {
    const out = await analyze([...ENGLISH, "--report", "--report-lang", "uk"]);

    for (const code of ["cs", "de", "hu", "ro"]) {
      expect(lang(out, code).missingTopics, code).toContain("English as a second or foreign language");
    }
    for (const code of ["pl", "uk"]) expect(lang(out, code).missingTopics, code).toEqual([]);
    expect(lang(out, "ro").metrics!.confidence.level).toBe("low");
    expect(out.ranking[0]!.lang).toBe("uk");

    expect(out.files.report).toMatch(/report-uk\.pdf$/);
    expect(pdfPageCount(out.files.report!)).toBe(1);
    for (const f of [out.files.chart, out.files.chartPng, out.files.data]) {
      expect(f && existsSync(f), String(f)).toBe(true);
      expect(statSync(f!).size).toBeGreaterThan(0);
    }
  });
});
