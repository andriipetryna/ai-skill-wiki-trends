import { describe, expect, it } from "vitest";
import { parseCliArgs, type CliArgs } from "../../scripts/src/args.ts";
import { DEFAULT_WEIGHTS } from "../../scripts/src/metrics/ranking.ts";

const NOW = new Date("2026-09-26T09:00:00Z");
const BASE = ["analyze", "--topic", "Astronomy", "--langs", "uk"];

function ok(argv: string[]): CliArgs {
  const r = parseCliArgs(argv, NOW);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.args;
}

function err(argv: string[]): { error: string; hint?: string } {
  const r = parseCliArgs(argv, NOW);
  if (r.ok) throw new Error("expected an error");
  return r;
}

describe("parseCliArgs: period", () => {
  it("--years 2 at 2026-09-26 → 2024-09..2026-08", () => {
    expect(ok([...BASE, "--years", "2"]).period).toEqual({ from: "2024-09", to: "2026-08" });
  });

  it("default is 3 years", () => {
    expect(ok(BASE).period).toEqual({ from: "2023-09", to: "2026-08" });
  });

  it("--months 18", () => {
    expect(ok([...BASE, "--months", "18"]).period).toEqual({ from: "2025-03", to: "2026-08" });
  });

  it("explicit --from/--to", () => {
    expect(ok([...BASE, "--from", "2022-01", "--to", "2023-06"]).period).toEqual({ from: "2022-01", to: "2023-06" });
  });

  it("--from 2010-01 clamps to 2015-07", () => {
    expect(ok([...BASE, "--from", "2010-01", "--to", "2016-12"]).period).toEqual({ from: "2015-07", to: "2016-12" });
  });

  it("fewer than 6 months, bad format or from > to → error", () => {
    expect(err([...BASE, "--months", "5"]).error).toMatch(/at least 6 months/);
    expect(err([...BASE, "--from", "2024-13"]).error).toMatch(/YYYY-MM/);
    expect(err([...BASE, "--from", "2025-01", "--to", "2024-01"]).error).toMatch(/from <= to/);
  });

  it("only analyze gets a period", () => {
    expect(ok(["resolve", "--topic", "Astronomy", "--langs", "uk"]).period).toBeNull();
  });
});

describe("parseCliArgs: languages, articles, weights", () => {
  it('--langs "PL, cs" → ["pl", "cs"]', () => {
    expect(ok(["analyze", "--topic", "X", "--langs", "PL, cs"]).langs).toEqual(["pl", "cs"]);
  });

  it("--langs ua! → error whose hint mentions uk", () => {
    const e = err(["analyze", "--topic", "X", "--langs", "ua!"]);
    expect(e.error).toMatch(/ua!/);
    expect(e.hint).toMatch(/'uk'/);
  });

  it('--article pl="Głodówka lecznicza" → { pl: ["Głodówka lecznicza"] }', () => {
    expect(ok([...BASE, "--article", "pl=Głodówka lecznicza"]).articles).toEqual({ pl: ["Głodówka lecznicza"] });
  });

  it("--article without lang= → error", () => {
    expect(err([...BASE, "--article", "nope"]).error).toMatch(/lang=Title/);
  });

  it("--article alone is enough without --topic", () => {
    expect(ok(["analyze", "--article", "pl=Post przerywany", "--langs", "pl"]).topics).toEqual([]);
  });

  it("--weights growth=3 merges with the defaults", () => {
    expect(ok([...BASE, "--weights", "growth=3"]).weights).toEqual({ ...DEFAULT_WEIGHTS, growth: 3 });
    expect(ok(BASE).weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("unknown weight key, negative or non-numeric value → error with a hint", () => {
    for (const w of ["foo=1", "growth=-1", "growth=abc", "growth"]) {
      const e = err([...BASE, "--weights", w]);
      expect(e.hint, w).toMatch(/--weights/);
    }
  });
});

describe("parseCliArgs: misc", () => {
  it("help needs no other options", () => {
    expect(ok([]).help).toBe(true);
    expect(ok(["help"]).help).toBe(true);
    expect(ok(["analyze", "--help"]).help).toBe(true);
  });

  it("--topic and --langs are required", () => {
    expect(err(["analyze", "--langs", "uk"]).error).toMatch(/--topic/);
    expect(err(["analyze", "--topic", "X"]).error).toMatch(/--langs/);
  });

  it("unknown option → error", () => {
    expect(err([...BASE, "--nope"]).hint).toMatch(/--help/);
  });

  it("--no-redirects and --report-lang", () => {
    expect(ok(BASE)).toMatchObject({ redirects: true, reportLang: "en", report: false });
    expect(ok([...BASE, "--no-redirects", "--report", "--report-lang", "uk"])).toMatchObject({ redirects: false, reportLang: "uk", report: true });
  });
});
