// Smoke test of the test infrastructure (spec 09): runCli in-process against the fake Wikimedia API.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../scripts/src/cli.ts";
import { CLIENT_CONFIG } from "../../scripts/src/client.ts";
import { createFakeFetch, type FakeFetch } from "../fake/fetch.ts";
import { demoWorld } from "../fake/world.ts";

let tmp: string;
let fake: FakeFetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wt-test-"));
  fake = createFakeFetch(demoWorld());
  vi.stubGlobal("fetch", fake);
  vi.setSystemTime(new Date("2026-09-26T09:00:00Z"));
  CLIENT_CONFIG.retryBaseMs = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  CLIENT_CONFIG.retryBaseMs = 500;
  rmSync(tmp, { recursive: true, force: true });
});

describe("fake API + runCli", () => {
  it("analyze Astronomy in uk succeeds", async () => {
    const res = await runCli(["analyze", "--topic", "Astronomy", "--langs", "uk", "--out-dir", tmp]);
    expect(res.code).toBe(0);
    expect(res.output.ok).toBe(true);
    expect(res.output.query).toMatchObject({ from: "2023-09", to: "2026-08" });
    expect(fake.unknown).toEqual([]);
  });

  it("Mercury is ambiguous with two candidates", async () => {
    const res = await runCli(["analyze", "--topic", "Mercury", "--langs", "uk", "--out-dir", tmp]);
    expect(res.code).toBe(2);
    expect((res.output.candidates as Array<{ qid: string }>).map((c) => c.qid)).toEqual(["Q308", "Q925"]);
  });

  it("retries through failFirst without sleeping", async () => {
    const flaky = createFakeFetch(demoWorld(), { failFirst: 2 });
    vi.stubGlobal("fetch", flaky);
    const res = await runCli(["resolve", "--topic", "Astronomy", "--langs", "uk"]);
    expect(res.code).toBe(0);
    expect(flaky.calls.length).toBe(2 + 3); // 2 failures + exact title, search, wikidata
  });
});
