// Triggering evals (spec 14): does the agent pick the skill from its frontmatter `description` at the right time?
// Each labelled prompt in evals/trigger-prompts.json runs through `claude -p` (3 turns max) in a workspace with the
// skill installed; a run "triggered" when it used the Skill tool on it, read its SKILL.md or ran scripts/wt.
// See evals/README.md.
//
//   node evals/trigger.ts [--model haiku] [--runs 3] [--split dev|holdout|all] [--only id,id] [--concurrency 4]
//                         [--timeout 180] [--description "..."] [--regrade evals/results/<stamp>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { triggerMetrics, triggerSignals, validatePrompts, type Split, type TriggerMetrics, type TriggerPrompt, type TriggerRun } from "./graders/trigger.ts";
import { parseStream } from "./transcript.ts";
import { AGENT_TOOLS, CLAUDE, claudeAvailable, createWorkspace, gitCommit, ISOLATION_ARGS, pool, removeWorkspace, REPO, RESULTS, round, runClaude, SKILL_NAME, stampOf } from "./workspace.ts";

/** Enough to see the decision (spec 14); keeps the cost low. */
const MAX_TURNS = 3;

interface Options {
  model: string;
  runs: number;
  split: Split | "all";
  only: string[] | null;
  concurrency: number;
  timeoutMs: number;
  /** replaces the SKILL.md description in the installed copy; null = the description as committed */
  description: string | null;
  regrade: string | null;
}

interface Meta {
  startedAt: string;
  model: string;
  runs: number;
  maxTurns: number;
  gitCommit: string;
  /** the description the agent saw */
  description: string;
  descriptionOverridden: boolean;
}

const USAGE = `Usage: node evals/trigger.ts [--model haiku] [--runs 3] [--split dev|holdout|all] [--only id,id] [--concurrency 4]
                             [--timeout 180] [--description "..."] [--regrade evals/results/<stamp>]`;

function parseOptions(argv: string[]): Options {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      model: { type: "string", default: "haiku" },
      runs: { type: "string", default: "3" },
      split: { type: "string", default: "all" },
      only: { type: "string" },
      concurrency: { type: "string", default: "4" },
      timeout: { type: "string", default: "180" },
      description: { type: "string" },
      regrade: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (v.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const int = (name: string, raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive integer, got "${raw}"`);
    return n;
  };
  if (!["dev", "holdout", "all"].includes(v.split)) die(`--split must be dev, holdout or all, got "${v.split}"`);
  if (v.description !== undefined && !v.description.trim()) die("--description must not be empty");
  return {
    model: v.model,
    runs: int("runs", v.runs),
    split: v.split as Options["split"],
    only: v.only ? v.only.split(",").map((s) => s.trim()).filter(Boolean) : null,
    concurrency: int("concurrency", v.concurrency),
    timeoutMs: int("timeout", v.timeout) * 1000,
    description: v.description ?? null,
    regrade: v.regrade ? resolve(v.regrade) : null,
  };
}

function die(msg: string): never {
  console.error(`evals: ${msg}\n${USAGE}`);
  process.exit(2);
}

function loadPrompts(opts: Options): TriggerPrompt[] {
  const all = JSON.parse(readFileSync(join(REPO, "evals", "trigger-prompts.json"), "utf8")) as TriggerPrompt[];
  const problems = validatePrompts(all);
  if (problems.length) die(`evals/trigger-prompts.json: ${problems.join("; ")}`);
  const unknown = opts.only?.filter((id) => !all.some((p) => p.id === id)) ?? [];
  if (unknown.length) die(`unknown prompt id(s): ${unknown.join(", ")}`);
  return all.filter((p) => (!opts.only || opts.only.includes(p.id)) && (opts.split === "all" || p.split === opts.split));
}

const committedDescription = () => /^description:\s*(.*)$/m.exec(readFileSync(join(REPO, "SKILL.md"), "utf8"))?.[1]?.trim() ?? "";

// ---- running and grading

async function runOne(p: TriggerPrompt, run: number, opts: Options, resultsDir: string): Promise<string> {
  const runDir = join(resultsDir, p.id, `run-${run}`);
  mkdirSync(runDir, { recursive: true });
  const ws = createWorkspace({ description: opts.description });
  const env: NodeJS.ProcessEnv = { ...process.env, WT_FAKE_API: "1", WT_OUT_DIR: ws.outDir };
  try {
    const args = ["-p", p.prompt, "--model", opts.model, "--output-format", "stream-json", "--verbose", "--max-turns", String(MAX_TURNS)];
    args.push("--allowedTools", AGENT_TOOLS, ...ISOLATION_ARGS, "--no-session-persistence");
    const res = await runClaude(args, ws.dir, env, opts.timeoutMs);
    writeFileSync(join(runDir, "transcript.jsonl"), res.stdout);
    const stderr = (res.timedOut ? `evals: killed after ${opts.timeoutMs / 1000} s\n` : "") + res.stderr;
    if (stderr.trim()) writeFileSync(join(runDir, "stderr.txt"), stderr);
  } finally {
    removeWorkspace(ws);
  }
  return runDir;
}

function gradeRun(p: TriggerPrompt, run: number, runDir: string): TriggerRun {
  const file = join(runDir, "transcript.jsonl");
  const turn = parseStream(existsSync(file) ? readFileSync(file, "utf8") : "");
  const signals = triggerSignals([turn], SKILL_NAME);
  // error_max_turns is expected here (the run is cut at MAX_TURNS); only a missing result event is an error
  const error = turn.resultSubtype === null ? (existsSync(join(runDir, "stderr.txt")) ? readFileSync(join(runDir, "stderr.txt"), "utf8").trim().slice(0, 300) : "no result event") : null;
  const r: TriggerRun = {
    id: p.id,
    split: p.split,
    shouldTrigger: p.shouldTrigger,
    run,
    triggered: signals.length > 0,
    signals,
    error,
    costUsd: turn.costUsd,
    seconds: turn.durationMs / 1000,
  };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(r, null, 1));
  return r;
}

// ---- reporting

function summarize(meta: Meta, prompts: TriggerPrompt[], runs: TriggerRun[]) {
  const listed = (want: boolean) =>
    runs.filter((r) => !r.error && r.shouldTrigger === want && r.triggered !== want).map((r) => ({ id: r.id, split: r.split, run: r.run, signals: r.signals, prompt: prompts.find((p) => p.id === r.id)!.prompt }));
  const splits: Record<Split | "all", TriggerMetrics> = {
    dev: triggerMetrics(runs.filter((r) => r.split === "dev")),
    holdout: triggerMetrics(runs.filter((r) => r.split === "holdout")),
    all: triggerMetrics(runs),
  };
  return {
    meta,
    splits,
    falseNegatives: listed(true),
    falsePositives: listed(false),
    errors: runs.filter((r) => r.error).map((r) => ({ id: r.id, run: r.run, error: r.error })),
    prompts: prompts.map((p) => {
      const rs = runs.filter((r) => r.id === p.id && !r.error);
      const signals: Record<string, number> = {};
      for (const s of rs.flatMap((r) => r.signals)) signals[s] = (signals[s] ?? 0) + 1;
      return { id: p.id, split: p.split, shouldTrigger: p.shouldTrigger, triggered: rs.filter((r) => r.triggered).length, of: rs.length, signals, prompt: p.prompt };
    }),
    costUsd: round(runs.reduce((n, r) => n + r.costUsd, 0)),
  };
}

type Summary = ReturnType<typeof summarize>;

function printSummary(s: Summary): void {
  const header = ["prompt", "split", "expect", "triggered", "signals", "ok"];
  const rows = s.prompts.map((p) => [
    p.id,
    p.split,
    p.shouldTrigger ? "yes" : "no",
    `${p.triggered}/${p.of}`,
    Object.entries(p.signals).map(([k, n]) => `${k}×${n}`).join(" ") || "-",
    (p.shouldTrigger ? p.triggered === p.of : p.triggered === 0) ? "" : "✗",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log("\n" + line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  rows.forEach((r) => console.log(line(r)));

  const list = (title: string, xs: Summary["falseNegatives"]) => {
    if (!xs.length) return;
    console.log(`\n${title}:`);
    for (const x of xs) console.log(`  ${x.id} run-${x.run} (${x.split})${x.signals.length ? ` [${x.signals.join(", ")}]` : ""}: ${x.prompt}`);
  };
  list("false negatives (should have used the skill)", s.falseNegatives);
  list("false positives (should not have used the skill)", s.falsePositives);
  if (s.errors.length) {
    console.log(`\nerrors (not counted):`);
    for (const e of s.errors) console.log(`  ${e.id} run-${e.run}: ${e.error}`);
  }

  const pct = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
  const m = (k: Split | "all") => {
    const x = s.splits[k];
    return `${k.padEnd(7)} recall ${pct(x.recall)}  precision ${pct(x.precision)}  (tp ${x.tp} fp ${x.fp} fn ${x.fn} tn ${x.tn}, ${x.runs} runs)`;
  };
  console.log("\n" + ["dev", "holdout", "all"].map((k) => m(k as Split | "all")).join("\n"));
  const d = s.meta.descriptionOverridden ? ` · description overridden (${s.meta.description.length} chars)` : ` · description ${s.meta.description.length} chars`;
  console.log(`cost $${s.costUsd.toFixed(2)} · ${s.meta.model} · ${s.meta.runs} run(s) · max ${s.meta.maxTurns} turns${d} · ${s.meta.gitCommit}`);
}

// ---- main

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const prompts = loadPrompts(opts);
  if (!prompts.length) die("no prompts selected");

  if (opts.regrade) {
    const dir = opts.regrade;
    const summaryFile = join(dir, "trigger-summary.json");
    const prev = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, "utf8")) as Summary).meta : null;
    const graded = prompts.flatMap((p) =>
      (existsSync(join(dir, p.id)) ? readdirSync(join(dir, p.id)) : []).flatMap((name) => {
        const m = /^run-(\d+)$/.exec(name);
        return m ? [gradeRun(p, Number(m[1]), join(dir, p.id, name))] : [];
      }),
    );
    if (!graded.length) die(`no stored runs of the selected prompts in ${dir}`);
    const meta: Meta = prev ?? { startedAt: basename(dir), model: opts.model, runs: opts.runs, maxTurns: MAX_TURNS, gitCommit: gitCommit(), description: committedDescription(), descriptionOverridden: false };
    const summary = summarize(meta, prompts.filter((p) => graded.some((r) => r.id === p.id)), graded);
    writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
    printSummary(summary);
    console.log(`regraded: ${summaryFile}`);
    return;
  }

  if (!claudeAvailable()) die(`"${CLAUDE}" not found: install Claude Code or set CLAUDE_BIN`);
  const startedAt = new Date();
  const resultsDir = join(RESULTS, stampOf(startedAt));
  mkdirSync(resultsDir, { recursive: true });
  const meta: Meta = {
    startedAt: startedAt.toISOString(),
    model: opts.model,
    runs: opts.runs,
    maxTurns: MAX_TURNS,
    gitCommit: gitCommit(),
    description: opts.description ?? committedDescription(),
    descriptionOverridden: opts.description !== null,
  };
  const jobs = prompts.flatMap((p) => Array.from({ length: opts.runs }, (_, i) => ({ p, run: i + 1 })));
  const pos = prompts.filter((p) => p.shouldTrigger).length;
  console.error(`evals: ${jobs.length} trigger runs (${pos} positive + ${prompts.length - pos} negative prompts × ${opts.runs}), ${opts.model} → ${resultsDir}`);

  let done = 0;
  const runs = await pool(jobs, opts.concurrency, async ({ p, run }) => {
    const r = gradeRun(p, run, await runOne(p, run, opts, resultsDir));
    const verdict = r.error ? `ERROR (${r.error.split("\n")[0]})` : r.triggered === p.shouldTrigger ? "ok" : r.triggered ? "FALSE POSITIVE" : "FALSE NEGATIVE";
    console.error(`[${++done}/${jobs.length}] ${p.id} run-${run}: ${r.triggered ? `triggered (${r.signals.join(", ")})` : "not triggered"} · ${verdict} · $${r.costUsd.toFixed(3)}`);
    return r;
  });

  const summary = summarize(meta, prompts, runs);
  writeFileSync(join(resultsDir, "trigger-summary.json"), JSON.stringify(summary, null, 1));
  printSummary(summary);
  console.log(`results: ${resultsDir}`);
}

await main();
