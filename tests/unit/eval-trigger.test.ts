// Triggering evals (evals/graders/trigger.ts, evals/trigger-prompts.json, spec 14).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { triggerMetrics, triggerSignals, validatePrompts, type TriggerPrompt, type TriggerRun } from "../../evals/graders/trigger.ts";
import type { ToolCall, Turn } from "../../evals/transcript.ts";
import { withDescription } from "../../evals/workspace.ts";

const REPO = join(import.meta.dirname, "..", "..");

const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `t-${name}`, name, input, nested: false });
const turn = (...tools: ToolCall[]): Turn => ({ sessionId: "s", texts: [], tools, numTurns: 1, costUsd: 0, durationMs: 0, resultSubtype: "success" });
const signals = (...tools: ToolCall[]) => triggerSignals([turn(...tools)], "wiki-trends");

describe("triggerSignals", () => {
  it("detects the Skill tool, also plugin-prefixed", () => {
    expect(signals(call("Skill", { skill: "wiki-trends" }))).toEqual(["skill"]);
    expect(signals(call("Skill", { skill: "my-plugin:wiki-trends", args: "x" }))).toEqual(["skill"]);
  });

  it("ignores other skills", () => {
    expect(signals(call("Skill", { skill: "pdf" }), call("Skill", { skill: "wiki-trends-old" }))).toEqual([]);
  });

  it("detects a read of this skill's SKILL.md, by relative, symlinked or real path, or through Bash", () => {
    expect(signals(call("Read", { file_path: ".claude/skills/wiki-trends/SKILL.md" }))).toEqual(["read"]);
    expect(signals(call("Read", { file_path: "/tmp/wt-eval-x/.claude/skills/wiki-trends/SKILL.md" }))).toEqual(["read"]);
    expect(signals(call("Read", { file_path: "/Users/me/dev/wiki-trends/SKILL.md" }))).toEqual(["read"]);
    expect(signals(call("Bash", { command: "cat .claude/skills/wiki-trends/SKILL.md" }))).toEqual(["read"]);
  });

  it("ignores reads of other files and other skills' SKILL.md", () => {
    expect(signals(call("Read", { file_path: ".claude/skills/pdf/SKILL.md" }), call("Read", { file_path: ".claude/skills/wiki-trends/README.md" }))).toEqual([]);
    expect(signals(call("Glob", { pattern: "**/SKILL.md" }), call("Bash", { command: "ls .claude/skills" }))).toEqual([]);
  });

  it("detects a scripts/wt call; all signals in a fixed order, deduplicated, across turns", () => {
    const wt = call("Bash", { command: "cd .claude/skills/wiki-trends && scripts/wt analyze --topic Astronomy --langs uk" });
    expect(signals(wt)).toEqual(["wt"]);
    const turns = [turn(wt, wt), turn(call("Read", { file_path: ".claude/skills/wiki-trends/SKILL.md" }), call("Skill", { skill: "wiki-trends" }))];
    expect(triggerSignals(turns, "wiki-trends")).toEqual(["skill", "read", "wt"]);
  });

  it("does not count a scripts/wt path that is only mentioned in another tool", () => {
    expect(signals(call("Grep", { pattern: "scripts/wt" }))).toEqual([]);
  });
});

describe("triggerMetrics", () => {
  const run = (shouldTrigger: boolean, triggered: boolean, error: string | null = null): TriggerRun => ({
    id: "x",
    split: "dev",
    shouldTrigger,
    run: 1,
    triggered,
    signals: triggered ? ["skill"] : [],
    error,
    costUsd: 0,
    seconds: 0,
  });

  it("computes recall = tp/positives and precision = tp/triggered", () => {
    const runs = [run(true, true), run(true, true), run(true, true), run(true, false), run(false, true), run(false, false), run(false, false)];
    expect(triggerMetrics(runs)).toEqual({ runs: 7, tp: 3, fp: 1, fn: 1, tn: 2, recall: 0.75, precision: 0.75 });
  });

  it("returns null ratios when undefined, and leaves errored runs out", () => {
    expect(triggerMetrics([run(false, false)])).toMatchObject({ recall: null, precision: null });
    expect(triggerMetrics([run(true, false, "no result event"), run(true, true)])).toMatchObject({ runs: 1, recall: 1, precision: 1 });
    expect(triggerMetrics([])).toMatchObject({ runs: 0, recall: null, precision: null });
  });
});

describe("evals/trigger-prompts.json", () => {
  const prompts = JSON.parse(readFileSync(join(REPO, "evals", "trigger-prompts.json"), "utf8")) as TriggerPrompt[];
  const cyrillic = (p: TriggerPrompt) => /[а-яіїєґ]/i.test(p.prompt);

  it("is valid", () => {
    expect(validatePrompts(prompts)).toEqual([]);
  });

  it("has ≥ 12 positives and ≥ 10 negatives, each mixing Ukrainian and English with ≥ 3 in holdout", () => {
    for (const [label, min] of [[true, 12], [false, 10]] as const) {
      const xs = prompts.filter((p) => p.shouldTrigger === label);
      expect(xs.length).toBeGreaterThanOrEqual(min);
      expect(xs.filter((p) => p.split === "holdout").length).toBeGreaterThanOrEqual(3);
      expect(xs.some(cyrillic)).toBe(true);
      expect(xs.some((p) => !cyrillic(p))).toBe(true);
    }
  });

  it("validatePrompts reports duplicates and bad fields", () => {
    const bad = [
      { id: "a", shouldTrigger: true, split: "dev", prompt: "x" },
      { id: "a", shouldTrigger: "yes", split: "test", prompt: " " },
    ] as unknown as TriggerPrompt[];
    expect(validatePrompts(bad)).toEqual(["duplicate id a", "a: shouldTrigger must be true or false", "a: split must be dev or holdout", "a: empty prompt"]);
  });
});

describe("withDescription", () => {
  it("replaces only the frontmatter description line", () => {
    const md = "---\nname: wiki-trends\ndescription: Old one.\nmetadata:\n  version: \"1\"\n---\n\ndescription: not frontmatter\n";
    expect(withDescription(md, "Formats Markdown tables")).toBe('---\nname: wiki-trends\ndescription: "Formats Markdown tables"\nmetadata:\n  version: "1"\n---\n\ndescription: not frontmatter\n');
  });

  it("works on the real SKILL.md", () => {
    const md = readFileSync(join(REPO, "SKILL.md"), "utf8");
    const out = withDescription(md, "Formats Markdown tables");
    expect(out).toContain('description: "Formats Markdown tables"');
    expect(out.split("\n").length).toBe(md.split("\n").length);
  });
});
