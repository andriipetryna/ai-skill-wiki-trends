// Shared setup for the integration tests (spec 11): runCli in-process against the fake Wikimedia API.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, expect, vi } from "vitest";
import { runCli, type CliResult } from "../../scripts/src/cli.ts";
import { CLIENT_CONFIG } from "../../scripts/src/client.ts";
import { AnalysisOutputSchema, type AnalysisOutput } from "../contract/schema.ts";
import { createFakeFetch, type FakeFetch, type FakeFetchOptions } from "../fake/fetch.ts";
import { demoWorld, type FakeWorld } from "../fake/world.ts";

/** The clock of every integration test: the last complete month is 2026-08. */
export const NOW = new Date("2026-09-26T09:00:00Z");

const DEFAULT_RETRY_BASE_MS = CLIENT_CONFIG.retryBaseMs;

interface FakeState {
  fake: FakeFetch;
  tmp: string;
}
let state: FakeState | null = null;

/** Stubs fetch with the fake API, freezes the clock, disables retry sleeps, creates a temp dir. Undone after each test. */
export function setupFake(world: FakeWorld = demoWorld(), opts?: FakeFetchOptions): FakeState {
  const fake = createFakeFetch(world, opts);
  vi.stubGlobal("fetch", fake);
  vi.setSystemTime(NOW);
  CLIENT_CONFIG.retryBaseMs = 0;
  state = { fake, tmp: state?.tmp ?? mkdtempSync(join(tmpdir(), "wt-it-")) };
  return state;
}

afterEach(() => {
  const s = state;
  state = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  CLIENT_CONFIG.retryBaseMs = DEFAULT_RETRY_BASE_MS;
  if (!s) return;
  rmSync(s.tmp, { recursive: true, force: true });
  assertKnownRoutes(s.fake);
});

/** Fails with the offending URLs when the CLI called an endpoint the fake does not serve (a new, untested request). */
export function assertKnownRoutes(fake: FakeFetch): void {
  if (fake.unknown.length) throw new Error(`Requests to unknown fake routes:\n${fake.unknown.join("\n")}`);
}

function current(): FakeState {
  if (!state) throw new Error("call setupFake() first");
  return state;
}

/** runCli with a fresh output directory per call (the frozen clock would otherwise reuse one timestamped dir). */
export async function run(args: string[]): Promise<CliResult> {
  const out = mkdtempSync(join(current().tmp, "run-"));
  return runCli([...args, "--out-dir", out]);
}

/** `analyze` that must succeed; the output is checked against the contract and returned typed. */
export async function analyze(args: string[]): Promise<AnalysisOutput> {
  const res = await run(["analyze", ...args]);
  expect(res.code, JSON.stringify(res.output)).toBe(0);
  return AnalysisOutputSchema.parse(res.output);
}

export function lang(out: AnalysisOutput, code: string): AnalysisOutput["perLanguage"][number] {
  const x = out.perLanguage.find((l) => l.lang === code);
  if (!x) throw new Error(`no perLanguage entry for ${code}`);
  return x;
}

// ---- PDF inspection (pdfkit output: Type0 fonts, Identity-H, ToUnicode CMaps, Flate streams)

/** Page objects: `/Type /Page` not followed by `s` (that one is the page tree). */
export function pdfPageCount(path: string): number {
  return (readFileSync(path).toString("latin1").match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
}

interface PdfObject {
  dict: string;
  stream?: Buffer;
}

function pdfObjects(s: string): Map<number, PdfObject> {
  const out = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = re.lastIndex;
    const end = s.indexOf("endobj", start);
    const streamAt = s.indexOf("stream", start);
    if (streamAt < 0 || streamAt > end) {
      out.set(Number(m[1]), { dict: s.slice(start, end) });
      re.lastIndex = end;
      continue;
    }
    const dict = s.slice(start, streamAt);
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
    let at = streamAt + "stream".length;
    if (s[at] === "\r") at++;
    if (s[at] === "\n") at++;
    const raw = Buffer.from(s.slice(at, at + length), "latin1");
    out.set(Number(m[1]), { dict, stream: /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw });
    re.lastIndex = at + length;
  }
  return out;
}

/** UTF-16BE hex (whitespace allowed: pdfkit writes ligatures as `<0066 0069>`) -> text */
const utf16 = (hex: string) => String.fromCharCode(...(hex.replace(/\s+/g, "").match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));

/** glyph id -> text, from a ToUnicode CMap (bfchar and both bfrange forms) */
function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const [, body] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of body!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f\s]+)>/gi)) map.set(parseInt(src!, 16), utf16(dst!));
  }
  for (const [, body] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst] of body!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(\[[^\]]*\]|<[0-9a-f]+>)/gi)) {
      const a = parseInt(lo!, 16);
      if (dst!.startsWith("[")) {
        [...dst!.matchAll(/<([0-9a-f\s]+)>/gi)].forEach(([, h], i) => map.set(a + i, utf16(h!)));
      } else {
        const base = parseInt(dst!.slice(1, -1), 16);
        for (let c = a; c <= parseInt(hi!, 16); c++) map.set(c, String.fromCharCode(base + c - a));
      }
    }
  }
  return map;
}

/** Text of every page, one entry per text object (pdfkit writes one per line / table cell), in drawing order. */
export function pdfText(path: string): string[] {
  const objs = pdfObjects(readFileSync(path).toString("latin1"));
  // font resource name -> glyph map; pdfkit names fonts uniquely per document
  const fonts = new Map<string, Map<number, string>>();
  for (const { dict } of objs.values()) {
    for (const [, fontDict] of dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
      for (const [, name, ref] of fontDict!.matchAll(/\/(\S+)\s+(\d+) 0 R/g)) {
        const cmapRef = /\/ToUnicode (\d+) 0 R/.exec(objs.get(Number(ref))?.dict ?? "")?.[1];
        const cmap = objs.get(Number(cmapRef))?.stream;
        if (cmap) fonts.set(name!, parseCMap(cmap.toString("latin1")));
      }
    }
  }
  const lines: string[] = [];
  for (const { dict } of objs.values()) {
    if (!/\/Type\s*\/Page(?!s)\b/.test(dict)) continue;
    const refs = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(dict)?.[1] ?? "";
    for (const [, ref] of refs.matchAll(/(\d+) 0 R/g)) {
      const content = objs.get(Number(ref))?.stream?.toString("latin1") ?? "";
      let font = new Map<number, string>();
      let line = "";
      for (const [, name, tj, tjOne, et] of content.matchAll(/\/(\S+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-f]*)>\s*Tj|\b(ET)\b/gi)) {
        if (name) font = fonts.get(name) ?? new Map();
        const hex = tj !== undefined ? [...tj.matchAll(/<([0-9a-f]*)>/gi)].map((x) => x[1]!).join("") : tjOne;
        if (hex) line += (hex.match(/.{4}/g) ?? []).map((g) => font.get(parseInt(g, 16)) ?? "").join("");
        if (et && line) {
          lines.push(line);
          line = "";
        }
      }
    }
  }
  return lines;
}

// ---- Numbers in text (a minimal extractor for findings; the eval checker of spec 13 is stricter)

/** Signed numbers in a text: "+2.9%", "-12.0%", "1,672", "p=0.009". Dates (YYYY-MM) and "p<0.001" are not numbers. */
export function extractNumbers(text: string): number[] {
  const scrubbed = text.replace(/\b\d{4}-\d{2}\b/g, " ").replace(/p<0\.001/g, " ");
  return [...scrubbed.matchAll(/[+\-−]?\d[\d,]*(?:\.\d+)?/g)].map(([raw]) => Number(raw.replace(/,/g, "").replace("−", "-")));
}

/** Every finite number anywhere in a JSON value (keys excluded). */
export function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return Number.isFinite(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
}
