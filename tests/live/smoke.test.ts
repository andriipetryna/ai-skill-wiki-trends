// Live smoke tests against the real Wikimedia APIs (spec 12). Skipped unless WT_LIVE=1 (npm run test:live).
// They assert stable facts, never view counts. 15 HTTP requests in total; keep it under ~40.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, type CliResult } from "../../scripts/src/cli.ts";
import { AnalysisOutputSchema, ResolveOutputSchema, type AnalysisOutput } from "../contract/schema.ts";
import { lang, pdfPageCount } from "../integration/helpers.ts";

const LIVE = process.env.WT_LIVE === "1";
if (LIVE && !process.env.WT_CONTACT) throw new Error("Live tests need WT_CONTACT (your email or URL for the Wikimedia User-Agent)");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe.skipIf(!LIVE)("live Wikimedia APIs", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "wt-live-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** runCli with a fresh output directory per call. */
  async function run(args: string[]): Promise<CliResult> {
    return runCli([...args, "--out-dir", mkdtempSync(join(tmp, "run-"))]);
  }

  async function analyze(args: string[]): Promise<AnalysisOutput> {
    const res = await run(["analyze", ...args]);
    expect(res.code, JSON.stringify(res.output)).toBe(0);
    return AnalysisOutputSchema.parse(res.output);
  }

  /** sharePerMillion.last12Avg of every ok language lies in a sane range: catches a broken normalisation base. */
  function expectSaneShare(out: AnalysisOutput): void {
    for (const l of out.perLanguage.filter((x) => x.status === "ok")) {
      expect(l.metrics!.sharePerMillion.last12Avg, l.lang).toBeGreaterThanOrEqual(0.01);
      expect(l.metrics!.sharePerMillion.last12Avg, l.lang).toBeLessThanOrEqual(10_000);
    }
  }

  describe("resolve", () => {
    it("Astronomy → Q333, uk Астрономія, a pl title", async () => {
      const res = await run(["resolve", "--topic", "Astronomy", "--langs", "uk,pl"]);
      expect(res.code, JSON.stringify(res.output)).toBe(0);
      const [r] = ResolveOutputSchema.parse(res.output).resolution;
      expect(r!.status).toBe("ok");
      expect(r!.qid).toBe("Q333");
      expect(r!.articles.uk).toBe("Астрономія");
      expect(r!.articles.pl).toBeTruthy();
    });

    it("Mercury (en) is a disambiguation page → ambiguous with candidates", async () => {
      const res = await run(["resolve", "--topic", "Mercury", "--langs", "en"]);
      expect(res.code, JSON.stringify(res.output)).toBe(0);
      const [r] = ResolveOutputSchema.parse(res.output).resolution;
      expect(r!.status).toBe("ambiguous");
      expect(r!.alternatives.length).toBeGreaterThan(0);
    });
  });

  describe("analyze Intermittent fasting, pl vs cs, 2 years, with report", () => {
    let out: AnalysisOutput;
    beforeAll(async () => {
      // one run serves every check below (request budget)
      out = await analyze(["--topic", "Intermittent fasting", "--langs", "pl,cs", "--years", "2", "--report"]);
    });

    it("cs is ok with views", () => {
      const cs = lang(out, "cs");
      expect(cs.status).toBe("ok");
      expect(cs.totalViews).toBeGreaterThan(0);
    });

    it("pl has no Wikidata sitelink and gets suggestions (or has gained one)", () => {
      const pl = lang(out, "pl");
      if (pl.status === "ok") {
        console.warn(`live: Wikidata now links "Intermittent fasting" to pl "${pl.articles.join(", ")}"; the fake world still has no pl sitelink`);
        return;
      }
      expect(pl.status).toBe("no_article");
      expect(pl.suggestions?.length ?? 0).toBeGreaterThan(0);
    });

    it("writes a one-page PDF and a non-empty PNG", () => {
      expect(out.files.report).toBeTruthy();
      expect(existsSync(out.files.report!)).toBe(true);
      expect(pdfPageCount(out.files.report!)).toBe(1);
      const png = readFileSync(out.files.chartPng!);
      expect(png.length).toBeGreaterThan(PNG_SIGNATURE.length);
      expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    });

    it("share per million is in a sane range for every ok language", () => {
      expectSaneShare(out);
    });
  });

  describe("--article with a non-existent title", () => {
    it("is no_data or no_article, not an error", async () => {
      const out = await analyze(["--langs", "pl", "--article", "pl=Zzzz nonexistent 12345", "--years", "2"]);
      expect(["no_data", "no_article"]).toContain(lang(out, "pl").status);
      expectSaneShare(out);
    });
  });
});
