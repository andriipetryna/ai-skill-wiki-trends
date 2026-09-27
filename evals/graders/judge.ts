// Optional LLM-as-judge for `expect.rubric` (spec 13): meaning-level checks that strings cannot express.
// The judge sees the prompts, the answer, the compact analysis JSON and the rubric, never the other grades.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JudgeItem {
  item: string;
  /** null = unknown (the judge failed or skipped the item); never counted as a failure */
  pass: boolean | null;
  reason: string;
}

export interface JudgeInput {
  prompts: string[];
  answer: string;
  /** compact analysis JSON (stdout of scripts/wt, no `monthly`) */
  analysis: unknown[];
  rubric: string[];
}

export function buildJudgePrompt(x: JudgeInput): string {
  const turns = x.prompts.map((p, i) => `User turn ${i + 1}:\n${p}`).join("\n\n");
  return [
    "You grade the reply of an AI assistant that answered a user's question about Wikipedia pageview trends using a CLI tool.",
    "The analysis JSON below is exactly what the tool returned; the data in it is synthetic test data, which is expected.",
    "Judge each rubric item strictly and independently, only from the reply and the JSON.",
    "",
    "=== User prompts ===",
    turns,
    "",
    "=== Assistant reply (all turns) ===",
    x.answer || "(empty)",
    "",
    "=== Analysis JSON returned by the tool ===",
    x.analysis.length ? x.analysis.map((a) => JSON.stringify(a)).join("\n") : "(the tool was not run)",
    "",
    "=== Rubric ===",
    x.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n"),
    "",
    'Reply with strict JSON only, no prose and no code fences: [{ "item": "<rubric item text>", "pass": true|false, "reason": "<one sentence>" }], one entry per rubric item, in order.',
  ].join("\n");
}

/** The judge's reply → one item per rubric entry; anything unparsable becomes "unknown". */
export function parseJudgeOutput(text: string, rubric: string[]): JudgeItem[] {
  const unknown = (reason: string) => rubric.map((item) => ({ item, pass: null, reason }));
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return unknown("judge reply has no JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return unknown("judge reply is not valid JSON");
  }
  if (!Array.isArray(parsed)) return unknown("judge reply is not a JSON array");
  const rows = parsed as Array<{ item?: unknown; pass?: unknown; reason?: unknown }>;
  return rubric.map((item, i) => {
    const row = rows.find((r) => r?.item === item) ?? rows[i];
    if (!row || typeof row.pass !== "boolean") return { item, pass: null, reason: "judge gave no verdict for this item" };
    return { item, pass: row.pass, reason: typeof row.reason === "string" ? row.reason : "" };
  });
}

export interface JudgeOptions {
  model: string;
  cacheDir: string;
  timeoutMs?: number;
}

export interface JudgeResult {
  items: JudgeItem[];
  costUsd: number;
  cached: boolean;
}

/** Runs the judge (`claude -p --output-format json`, no tools) or returns the cached verdict for (model, answer, rubric). */
export async function judge(x: JudgeInput, opts: JudgeOptions): Promise<JudgeResult> {
  const key = createHash("sha256").update(JSON.stringify([opts.model, x.answer, x.rubric])).digest("hex").slice(0, 32);
  const cacheFile = join(opts.cacheDir, `${key}.json`);
  if (existsSync(cacheFile)) return { items: JSON.parse(readFileSync(cacheFile, "utf8")) as JudgeItem[], costUsd: 0, cached: true };

  // an empty directory and no settings/tools/MCP: the judge only reads the prompt
  const cwd = mkdtempSync(join(tmpdir(), "wt-judge-"));
  const args = ["-p", buildJudgePrompt(x), "--model", opts.model, "--output-format", "json", "--tools", "", "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence"];
  let stdout = "";
  try {
    stdout = await new Promise<string>((resolve) => {
      const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.resume();
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 180_000);
      child.on("error", () => resolve(""));
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  let text = "";
  let costUsd = 0;
  try {
    const res = JSON.parse(stdout) as { result?: string; total_cost_usd?: number; is_error?: boolean };
    text = res.is_error ? "" : (res.result ?? "");
    costUsd = res.total_cost_usd ?? 0;
  } catch {
    // no JSON from the CLI at all: every item is unknown
  }
  const items = parseJudgeOutput(text, x.rubric);
  // only definite verdicts are cached, so a flaky judge call is retried next time
  if (items.every((i) => i.pass !== null)) {
    mkdirSync(opts.cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(items, null, 1));
  }
  return { items, costUsd, cached: false };
}
