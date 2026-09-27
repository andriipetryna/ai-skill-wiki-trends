// The stdout JSON is the contract with the consuming agent: shape (zod), size (no monthly series) and every field
// that SKILL.md tells the agent to read (spec 11).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ErrorOutputSchema, ResolveOutputSchema } from "../contract/schema.ts";
import { analyze, extractNumbers, numbersIn, run, setupFake } from "./helpers.ts";

const FASTING = ["--topic", "Intermittent fasting", "--langs", "pl,cs", "--years", "2"];
const ENGLISH = ["--topic", "English language", "--topic", "English as a second or foreign language", "--langs", "pl,cs,uk,de,hu,ro", "--report"];

beforeEach(() => {
  setupFake();
});

describe("stdout vs data.json", () => {
  it("stdout has no monthly arrays; data.json has them for every ok language", async () => {
    const out = await analyze(ENGLISH);
    expect(JSON.stringify(out)).not.toContain('"monthly"');

    const data = JSON.parse(readFileSync(out.files.data, "utf8")) as { perLanguage: Array<{ lang: string; status: string; monthly: unknown[]; metrics: { months: number } | null }> };
    const ok = data.perLanguage.filter((x) => x.status === "ok");
    expect(ok.length).toBe(6);
    for (const x of ok) expect(x.monthly.length, x.lang).toBe(x.metrics!.months);
  });

  it("resolve output parses with ResolveOutputSchema", async () => {
    const res = await run(["resolve", "--topic", "Astronomy", "--langs", "uk,pl"]);
    expect(res.code).toBe(0);
    const out = ResolveOutputSchema.parse(res.output);
    expect(out.resolution[0]!.articles).toEqual({ uk: "Астрономія", pl: "Astronomia" });
  });
});

// ---- SKILL.md field references

/** Backticked tokens in SKILL.md prose (fenced code blocks skipped). */
function skillTokens(): string[] {
  const md = readFileSync(join(import.meta.dirname, "../../SKILL.md"), "utf8").replace(/```[\s\S]*?```/g, "");
  return [...new Set([...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!))];
}

/** Values and words SKILL.md backticks that are not fields and do not occur as string values in the outputs below. */
const NOT_FIELDS = new Set(["Read", "analyze", "ua", "Q333", "declining", "inconclusive", "no_data", "second_half_vs_first_half"]);

/** `a.b[].c` / `a.b: "value"` → ["a", "b", "[]", "c"]; null when the token is not a field reference (a flag, a command...). */
function fieldPath(token: string): string[] | null {
  const path = token.replace(/:\s*.*$/, "");
  if (!/^[A-Za-z_]\w*(\[\])?(\.[A-Za-z_]\w*(\[\])?)*$/.test(path)) return null;
  return path.split(".").flatMap((seg) => (seg.endsWith("[]") ? [seg.slice(0, -2), "[]"] : [seg]));
}

/** Does `path` resolve from some node of the tree? `[]` = any element of an array. A present key with null counts. */
function resolvesAnywhere(root: unknown, path: string[]): boolean {
  const follow = (node: unknown, i: number): boolean => {
    if (i === path.length) return true;
    if (path[i] === "[]") return Array.isArray(node) && node.some((x) => follow(x, i + 1));
    return !!node && typeof node === "object" && !Array.isArray(node) && path[i]! in node && follow((node as Record<string, unknown>)[path[i]!], i + 1);
  };
  const nodes: unknown[] = [];
  const walk = (n: unknown) => {
    nodes.push(n);
    if (n && typeof n === "object") Object.values(n).forEach(walk);
  };
  walk(root);
  return nodes.some((n) => follow(n, 0));
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

describe("SKILL.md", () => {
  it("every field it mentions exists in a real output", async () => {
    const outputs = [await analyze(FASTING), await analyze(ENGLISH), (await run(["analyze", "--topic", "Mercury", "--langs", "uk"])).output];
    ErrorOutputSchema.parse(outputs[2]);
    const values = new Set(outputs.flatMap(stringValues));

    const checked: string[] = [];
    const missing: string[] = [];
    for (const token of skillTokens()) {
      const path = fieldPath(token);
      if (!path || NOT_FIELDS.has(token) || (path.length === 1 && values.has(token))) continue;
      checked.push(token);
      if (!outputs.some((o) => resolvesAnywhere(o, path))) missing.push(token);
    }
    expect(missing, "fields SKILL.md mentions but no output has").toEqual([]);
    // guards the parser itself: these must be among the checked references
    expect(checked).toEqual(expect.arrayContaining(["metrics.trend.sharePctPerYear", "metrics.sharePerMillion.last12Avg", "files.chartPng", "query.weights", 'resolution[].matchedBy: "search"', "candidates"]));
  });
});

// ---- findings only copy numbers

describe("findings", () => {
  it("every number in findings appears in perLanguage, ranking or query", async () => {
    for (const out of [await analyze(FASTING), await analyze([...FASTING, "--article", "pl=Głodówka lecznicza"]), await analyze(ENGLISH)]) {
      const allowed = numbersIn([out.perLanguage, out.ranking, out.query]);
      const unsupported = out.findings.flatMap((f) =>
        // "last 12 months" is the fixed window of the relative-interest sentence, not a result
        extractNumbers(f.replace("last 12 months", "")).filter((x) => !allowed.some((a) => Math.abs(a - x) < 1e-9)).map((x) => `${x} in "${f}"`),
      );
      expect(unsupported).toEqual([]);
    }
  });
});
