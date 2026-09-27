// Every failure is one JSON object with ok:false, never a thrown exception or a stack trace (spec 11).
import { describe, expect, it } from "vitest";
import { ErrorOutputSchema } from "../contract/schema.ts";
import { demoWorld } from "../fake/world.ts";
import { assertKnownRoutes, run, setupFake } from "./helpers.ts";

async function failure(args: string[], code: number) {
  const res = await run(args);
  expect(res.code, JSON.stringify(res.output)).toBe(code);
  return ErrorOutputSchema.parse(res.output);
}

describe("resolve errors", () => {
  it("--topic Mercury is ambiguous: exit 2 with the two candidates", async () => {
    setupFake();
    const out = await failure(["analyze", "--topic", "Mercury", "--langs", "uk"], 2);
    expect(out.candidates?.map((c) => c.qid)).toEqual(["Q308", "Q925"]);
    expect(out.hint).toBeDefined();
  });
});

describe("usage errors: exit 2 before any request", () => {
  const cases: Array<[string, string[]]> = [
    ["invalid language code", ["analyze", "--topic", "Astronomy", "--langs", "UA!"]],
    ["missing --topic", ["analyze", "--langs", "uk"]],
    ["missing --langs", ["analyze", "--topic", "Astronomy"]],
    ["--years 0", ["analyze", "--topic", "Astronomy", "--langs", "uk", "--years", "0"]],
    ["--from after --to", ["analyze", "--topic", "Astronomy", "--langs", "uk", "--from", "2026-05", "--to", "2026-01"]],
    ["unknown command", ["frobnicate", "--topic", "Astronomy", "--langs", "uk"]],
  ];
  it.each(cases)("%s", async (_name, args) => {
    const { fake } = setupFake();
    await failure(args, 2);
    expect(fake.calls).toEqual([]);
  });
});

describe("network errors", () => {
  it("retries: failFirst 2 succeeds with exactly 2 extra requests", async () => {
    const args = ["analyze", "--topic", "Astronomy", "--langs", "uk"];
    const clean = setupFake();
    expect((await run(args)).code).toBe(0);
    const flaky = setupFake(demoWorld(), { failFirst: 2 });
    expect((await run(args)).code).toBe(0);
    expect(flaky.fake.calls.length).toBe(clean.fake.calls.length + 2);
  });

  it("500 on every request: exit 1 with a hint", async () => {
    setupFake(demoWorld(), { failFirst: Infinity, failStatus: 500 });
    const out = await failure(["analyze", "--topic", "Astronomy", "--langs", "uk"], 1);
    expect(out.error).toMatch(/HTTP 500/);
    expect(out.hint).toBeTruthy();
  });

  it("a request to an unknown fake route fails the test and names the URL", async () => {
    const { fake } = setupFake();
    const url = "https://wikimedia.org/api/rest_v1/metrics/unique-devices/uk.wikipedia/all-sites/monthly/20240101/20240201";
    await fetch(url);
    expect(() => assertKnownRoutes(fake)).toThrow(url);
    fake.unknown.length = 0; // handled: keep the afterEach guard quiet
  });
});
