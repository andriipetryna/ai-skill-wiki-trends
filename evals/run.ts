// Task evals (spec 13): the real agent (`claude -p`) with the skill installed runs fixed scenarios against the
// synthetic world (WT_FAKE_API=1), and the transcripts are graded automatically. See evals/README.md.
//
//   node evals/run.ts [--model haiku] [--runs 3] [--only id,id] [--split dev|holdout|all] [--judge [--judge-model sonnet]]
//                     [--baseline] [--live] [--concurrency 3] [--timeout 600] [--regrade evals/results/<stamp>]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { countWtCalls, gradeDeterministic, type Check, type Expect, type RunRecord } from "./graders/deterministic.ts";
import { judge, type JudgeItem } from "./graders/judge.ts";
import { checkNumbers, collectAllowed, type NumbersResult } from "./graders/numbers.ts";
import { answerText, bashCommands, parseStream, sentFiles, wtCalls, wtOutputs, type Turn } from "./transcript.ts";
import { AGENT_TOOLS, CLAUDE, claudeAvailable, createWorkspace, gitCommit, ISOLATION_ARGS, pool, removeWorkspace, REPO, RESULTS, round, runClaude, stampOf } from "./workspace.ts";

const JUDGE_CACHE = join(REPO, "evals", ".cache", "judge");

type Split = "dev" | "holdout";
type Variant = "skill" | "baseline";

interface Scenario {
  id: string;
  split: Split;
  prompt: string;
  /** optional second user turn, run with --resume */
  followUp: string | null;
  expect: Expect;
}

interface Options {
  model: string;
  runs: number;
  only: string[] | null;
  split: Split | "all";
  judge: boolean;
  judgeModel: string;
  baseline: boolean;
  live: boolean;
  concurrency: number;
  timeoutMs: number;
  regrade: string | null;
}

interface Grades {
  id: string;
  split: Split;
  variant: Variant;
  run: number;
  pass: boolean;
  checks: Record<string, Check>;
  numbers: NumbersResult;
  judge: JudgeItem[] | null;
  stats: { userTurns: number; wtCalls: number; toolCalls: number; turns: number; costUsd: number; judgeCostUsd: number; seconds: number };
}

// ---- options and scenarios

const USAGE = `Usage: node evals/run.ts [--model haiku] [--runs 3] [--only id,id] [--split dev|holdout|all] [--judge] [--judge-model sonnet]
                         [--baseline] [--live] [--concurrency 3] [--timeout 600] [--regrade evals/results/<stamp>]`;

function parseOptions(argv: string[]): Options {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      model: { type: "string", default: "haiku" },
      runs: { type: "string", default: "3" },
      only: { type: "string" },
      split: { type: "string", default: "all" },
      judge: { type: "boolean", default: false },
      "judge-model": { type: "string", default: "sonnet" },
      baseline: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      concurrency: { type: "string", default: "3" },
      timeout: { type: "string", default: "600" },
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
  return {
    model: v.model,
    runs: int("runs", v.runs),
    only: v.only ? v.only.split(",").map((s) => s.trim()).filter(Boolean) : null,
    split: v.split as Options["split"],
    judge: v.judge,
    judgeModel: v["judge-model"],
    baseline: v.baseline,
    live: v.live,
    concurrency: int("concurrency", v.concurrency),
    timeoutMs: int("timeout", v.timeout) * 1000,
    regrade: v.regrade ? resolve(v.regrade) : null,
  };
}

function die(msg: string): never {
  console.error(`evals: ${msg}\n${USAGE}`);
  process.exit(2);
}

function loadScenarios(opts: Options): Scenario[] {
  const all = JSON.parse(readFileSync(join(REPO, "evals", "scenarios.json"), "utf8")) as Scenario[];
  const ids = new Set(all.map((s) => s.id));
  if (ids.size !== all.length) die("duplicate scenario ids in evals/scenarios.json");
  for (const s of all) {
    for (const re of [...(s.expect.commands ?? []), ...(s.expect.mentions ?? [])]) new RegExp(re, "i"); // throws on a bad regex
  }
  const unknown = opts.only?.filter((id) => !ids.has(id)) ?? [];
  if (unknown.length) die(`unknown scenario id(s): ${unknown.join(", ")}`);
  return all.filter((s) => (!opts.only || opts.only.includes(s.id)) && (opts.split === "all" || s.split === opts.split));
}

const promptsOf = (s: Scenario) => [s.prompt, ...(s.followUp ? [s.followUp] : [])];
const runDirName = (variant: Variant, run: number) => (variant === "skill" ? `run-${run}` : `baseline-run-${run}`);

// ---- running the agent

/** One scenario × variant × run: a fresh workspace outside the repo, one `claude -p` per user turn, outputs copied. */
async function runOne(s: Scenario, variant: Variant, run: number, opts: Options, resultsDir: string): Promise<string> {
  const runDir = join(resultsDir, s.id, runDirName(variant, run));
  mkdirSync(runDir, { recursive: true });
  const ws = createWorkspace({ skill: variant === "skill" });
  const { outDir } = ws;
  const env: NodeJS.ProcessEnv = { ...process.env, WT_OUT_DIR: outDir };
  if (opts.live) delete env.WT_FAKE_API;
  else env.WT_FAKE_API = "1";

  const prompts = promptsOf(s);
  let sessionId: string | null = null;
  try {
    for (const [i, prompt] of prompts.entries()) {
      const args = ["-p", prompt, "--model", opts.model, "--output-format", "stream-json", "--verbose", "--allowedTools", AGENT_TOOLS, ...ISOLATION_ARGS];
      if (i > 0) {
        if (!sessionId) break; // the first turn produced no session: the follow-up cannot run (graded as not completed)
        args.push("--resume", sessionId);
      } else if (prompts.length === 1) args.push("--no-session-persistence");
      const res = await runClaude(args, ws.dir, env, opts.timeoutMs);
      writeFileSync(join(runDir, `transcript-${i + 1}.jsonl`), res.stdout);
      const stderr = (res.timedOut ? `evals: killed after ${opts.timeoutMs / 1000} s\n` : "") + res.stderr;
      if (stderr.trim()) writeFileSync(join(runDir, `stderr-${i + 1}.txt`), stderr);
      sessionId = parseStream(res.stdout).sessionId ?? sessionId;
    }
    copyOutputs(runDir, outDir);
  } finally {
    removeWorkspace(ws);
  }
  return runDir;
}

/** The out-dir, plus output dirs the agent chose itself with --out-dir (listed in the scripts/wt JSON). */
function copyOutputs(runDir: string, outDir: string): void {
  const dest = join(runDir, "out");
  cpSync(outDir, dest, { recursive: true });
  const turns = readTurns(runDir);
  for (const o of wtOutputs(turns)) {
    const data = (o.files as { data?: unknown } | undefined)?.data;
    if (typeof data !== "string") continue;
    const dir = dirname(data);
    if (!dir.startsWith(outDir) && existsSync(dir)) cpSync(dir, join(dest, basename(dir)), { recursive: true });
  }
}

// ---- grading (also used by --regrade on stored results)

function readTurns(runDir: string): Turn[] {
  return readdirSync(runDir)
    .flatMap((f) => {
      const m = /^transcript-(\d+)\.jsonl$/.exec(f);
      return m ? [{ n: Number(m[1]), f }] : [];
    })
    .sort((a, b) => a.n - b.n)
    .map(({ f }) => parseStream(readFileSync(join(runDir, f), "utf8")));
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

async function gradeRun(s: Scenario, variant: Variant, run: number, runDir: string, opts: Options): Promise<Grades> {
  const prompts = promptsOf(s);
  const turns = readTurns(runDir);
  const outFiles = listFiles(join(runDir, "out"));
  const outputs = wtOutputs(turns);
  const answer = answerText(turns);
  writeFileSync(join(runDir, "answer.md"), answer + "\n");

  const wt = wtCalls(turns).map((c) => c.input.command as string);
  const record: RunRecord = {
    userTurns: prompts.length,
    bashCommands: bashCommands(turns),
    wtCommands: wt,
    wtCalls: countWtCalls(wt),
    answer,
    sentFiles: sentFiles(turns),
    outFiles,
    chartProduced: outputs.some((o) => o.ok === true && typeof (o.files as { chartPng?: unknown } | undefined)?.chartPng === "string"),
  };
  const checks = gradeDeterministic(s.expect, record);

  const unfinished = prompts.flatMap((_, i) => (turns[i]?.resultSubtype === "success" ? [] : [i + 1]));
  checks.completed = unfinished.length ? `turn ${unfinished.join(", ")} did not finish (${unfinished.map((i) => turns[i - 1]?.resultSubtype ?? "no result: timeout or crash").join(", ")})` : true;

  // numbers the agent could have seen: what scripts/wt printed, every data.json (monthly excluded), the prompts
  const dataJsons = outFiles.filter((f) => basename(f) === "data.json").map((f) => JSON.parse(readFileSync(f, "utf8")) as unknown);
  const numbers = checkNumbers(answer, collectAllowed([...outputs, ...dataJsons], prompts));
  checks.numbers = numbers.unsupported.length ? `unsupported numbers: ${numbers.unsupported.join(", ")}` : true;

  let judged: JudgeItem[] | null = null;
  let judgeCostUsd = 0;
  if (opts.judge && s.expect.rubric?.length) {
    const res = await judge({ prompts, answer, analysis: outputs, rubric: s.expect.rubric }, { model: opts.judgeModel, cacheDir: JUDGE_CACHE });
    judged = res.items;
    judgeCostUsd = res.costUsd;
    const failed = judged.filter((j) => j.pass === false);
    // unknown items (bad judge JSON) are neither pass nor fail; all unknown = not graded
    if (failed.length) checks.judge = `judge: ${failed.map((j) => `${j.item} — ${j.reason}`).join(" | ")}`;
    else if (judged.some((j) => j.pass === true)) checks.judge = true;
  }

  const grades: Grades = {
    id: s.id,
    split: s.split,
    variant,
    run,
    pass: Object.values(checks).every((c) => c === true),
    checks,
    numbers,
    judge: judged,
    stats: {
      userTurns: prompts.length,
      wtCalls: record.wtCalls,
      toolCalls: turns.reduce((n, t) => n + t.tools.filter((c) => !c.nested).length, 0),
      turns: turns.reduce((n, t) => n + t.numTurns, 0),
      costUsd: turns.reduce((n, t) => n + t.costUsd, 0),
      judgeCostUsd,
      seconds: turns.reduce((n, t) => n + t.durationMs, 0) / 1000,
    },
  };
  writeFileSync(join(runDir, "grades.json"), JSON.stringify(grades, null, 1));
  return grades;
}

// ---- reporting

interface Aggregate {
  runs: number;
  passRate: number;
  /** per check: passed / evaluated */
  checks: Record<string, { pass: number; of: number; rate: number }>;
  mean: { wtCalls: number; toolCalls: number; turns: number; costUsd: number; seconds: number };
  numbersChecked: number;
  /** unsupported number (raw text) → how many runs had it */
  unsupported: Record<string, number>;
  /** failure message → count */
  failures: Record<string, number>;
}

function aggregate(gs: Grades[]): Aggregate {
  const checks: Aggregate["checks"] = {};
  const unsupported: Record<string, number> = {};
  const failures: Record<string, number> = {};
  for (const g of gs) {
    for (const [name, c] of Object.entries(g.checks)) {
      const x = (checks[name] ??= { pass: 0, of: 0, rate: 0 });
      x.of++;
      if (c === true) x.pass++;
      else failures[`${name}: ${c}`] = (failures[`${name}: ${c}`] ?? 0) + 1;
    }
    for (const raw of new Set(g.numbers.unsupported)) unsupported[raw] = (unsupported[raw] ?? 0) + 1;
  }
  for (const x of Object.values(checks)) x.rate = round(x.pass / x.of);
  const mean = (f: (g: Grades) => number) => round(gs.reduce((n, g) => n + f(g), 0) / Math.max(1, gs.length));
  return {
    runs: gs.length,
    passRate: round(gs.filter((g) => g.pass).length / Math.max(1, gs.length)),
    checks,
    mean: { wtCalls: mean((g) => g.stats.wtCalls), toolCalls: mean((g) => g.stats.toolCalls), turns: mean((g) => g.stats.turns), costUsd: mean((g) => g.stats.costUsd), seconds: mean((g) => g.stats.seconds) },
    numbersChecked: gs.reduce((n, g) => n + g.numbers.checked, 0),
    unsupported,
    failures,
  };
}

function passRate(gs: Grades[]): { rate: number | null; pass: number; of: number } {
  const pass = gs.filter((g) => g.pass).length;
  return { rate: gs.length ? round(pass / gs.length) : null, pass, of: gs.length };
}

interface Meta {
  startedAt: string;
  model: string;
  dataMode: "synthetic" | "live";
  gitCommit: string;
  runs: number;
  judge: boolean;
  judgeModel: string | null;
  baseline: boolean;
}

function summarize(meta: Meta, scenarios: Scenario[], all: Grades[]) {
  const variants: Variant[] = meta.baseline ? ["skill", "baseline"] : ["skill"];
  const of = (v: Variant, split?: Split) => all.filter((g) => g.variant === v && (!split || g.split === split));
  return {
    meta,
    overall: {
      ...Object.fromEntries(variants.map((v) => [v, { dev: passRate(of(v, "dev")), holdout: passRate(of(v, "holdout")), all: passRate(of(v)) }])),
      costUsd: round(all.reduce((n, g) => n + g.stats.costUsd, 0)),
      judgeCostUsd: round(all.reduce((n, g) => n + g.stats.judgeCostUsd, 0)),
    },
    scenarios: scenarios.map((s) => ({
      id: s.id,
      split: s.split,
      ...Object.fromEntries(variants.map((v) => [v, aggregate(all.filter((g) => g.id === s.id && g.variant === v).sort((a, b) => a.run - b.run))])),
    })),
  };
}

const CHECK_COLUMNS = ["command", "wtCalls", "mentions", "report", "chart", "caveat", "noOwnCode", "numbers", "judge", "completed"];

function printSummary(summary: ReturnType<typeof summarize>): void {
  const header = ["scenario", "split", "pass", ...CHECK_COLUMNS, "wt", "tools", "$/run", "s/run"];
  const rows: string[][] = [];
  for (const sc of summary.scenarios) {
    for (const v of ["skill", "baseline"] as const) {
      const a = (sc as Record<string, unknown>)[v] as Aggregate | undefined;
      if (!a) continue;
      const cell = (name: string) => {
        const c = a.checks[name];
        return c ? `${c.pass}/${c.of}` : "-";
      };
      rows.push([
        v === "skill" ? sc.id : "  └ baseline",
        v === "skill" ? sc.split : "",
        `${Math.round(a.passRate * 100)}%`,
        ...CHECK_COLUMNS.map(cell),
        String(a.mean.wtCalls),
        String(a.mean.toolCalls),
        a.mean.costUsd.toFixed(3),
        String(Math.round(a.mean.seconds)),
      ]);
    }
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log("\n" + line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  rows.forEach((r) => console.log(line(r)));

  for (const sc of summary.scenarios) {
    const a = (sc as Record<string, unknown>).skill as Aggregate | undefined;
    if (!a) continue;
    const fails = Object.entries(a.failures);
    if (!fails.length) continue;
    console.log(`\n${sc.id}:`);
    for (const [msg, n] of fails) console.log(`  ${n}× ${msg.length > 300 ? msg.slice(0, 300) + "…" : msg}`);
  }

  const m = summary.meta;
  const o = summary.overall as Record<string, { dev: ReturnType<typeof passRate>; holdout: ReturnType<typeof passRate> }> & { costUsd: number; judgeCostUsd: number };
  const pr = (x: ReturnType<typeof passRate>) => (x.rate === null ? "n/a" : `${Math.round(x.rate * 100)}% (${x.pass}/${x.of})`);
  const base = o.baseline ? ` · baseline dev ${pr(o.baseline.dev)}, holdout ${pr(o.baseline.holdout)}` : "";
  const judgeCost = o.judgeCostUsd ? ` + judge $${o.judgeCostUsd.toFixed(2)}` : "";
  console.log(`\npass rate: dev ${pr(o.skill!.dev)} · holdout ${pr(o.skill!.holdout)}${base} · cost $${o.costUsd.toFixed(2)}${judgeCost} · ${m.model} · ${m.dataMode} · ${m.gitCommit}`);
}

// ---- main

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const scenarios = loadScenarios(opts);
  if (!scenarios.length) die("no scenarios selected");

  if (opts.regrade) {
    const dir = opts.regrade;
    const prev = existsSync(join(dir, "summary.json")) ? (JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { meta: Meta }).meta : null;
    const jobs = scenarios.flatMap((s) =>
      (existsSync(join(dir, s.id)) ? readdirSync(join(dir, s.id)) : []).flatMap((name) => {
        const m = /^(baseline-)?run-(\d+)$/.exec(name);
        return m ? [{ s, variant: (m[1] ? "baseline" : "skill") as Variant, run: Number(m[2]), runDir: join(dir, s.id, name) }] : [];
      }),
    );
    if (!jobs.length) die(`no stored runs of the selected scenarios in ${dir}`);
    const grades = await pool(jobs, opts.concurrency, (j) => gradeRun(j.s, j.variant, j.run, j.runDir, opts));
    const meta: Meta = { ...(prev ?? { startedAt: basename(dir), model: opts.model, dataMode: opts.live ? "live" : "synthetic", gitCommit: gitCommit(), runs: opts.runs, baseline: false }), judge: opts.judge, judgeModel: opts.judge ? opts.judgeModel : null };
    meta.baseline = grades.some((g) => g.variant === "baseline");
    const summary = summarize(meta, scenarios.filter((s) => jobs.some((j) => j.s === s)), grades);
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));
    printSummary(summary);
    console.log(`regraded: ${join(dir, "summary.json")}`);
    return;
  }

  if (!claudeAvailable()) die(`"${CLAUDE}" not found: install Claude Code or set CLAUDE_BIN`);
  if (opts.live && !process.env.WT_CONTACT) console.error("evals: --live without WT_CONTACT; the shared default contact may be rate-limited");

  const startedAt = new Date();
  const resultsDir = join(RESULTS, stampOf(startedAt));
  mkdirSync(resultsDir, { recursive: true });
  const meta: Meta = {
    startedAt: startedAt.toISOString(),
    model: opts.model,
    dataMode: opts.live ? "live" : "synthetic",
    gitCommit: gitCommit(),
    runs: opts.runs,
    judge: opts.judge,
    judgeModel: opts.judge ? opts.judgeModel : null,
    baseline: opts.baseline,
  };
  const variants: Variant[] = opts.baseline ? ["skill", "baseline"] : ["skill"];
  const jobs = scenarios.flatMap((s) => variants.flatMap((variant) => Array.from({ length: opts.runs }, (_, i) => ({ s, variant, run: i + 1 }))));
  console.error(`evals: ${jobs.length} runs (${scenarios.length} scenarios × ${opts.runs} × ${variants.join("+")}), ${meta.model}, ${meta.dataMode} → ${resultsDir}`);

  let done = 0;
  const grades = await pool(jobs, opts.concurrency, async (j) => {
    const runDir = await runOne(j.s, j.variant, j.run, opts, resultsDir);
    const g = await gradeRun(j.s, j.variant, j.run, runDir, opts);
    const failed = Object.entries(g.checks).filter(([, c]) => c !== true).map(([k]) => k);
    console.error(`[${++done}/${jobs.length}] ${j.s.id} ${runDirName(j.variant, j.run)}: ${g.pass ? "PASS" : `FAIL (${failed.join(", ")})`} · $${g.stats.costUsd.toFixed(3)} · ${Math.round(g.stats.seconds)} s`);
    return g;
  });

  const summary = summarize(meta, scenarios, grades);
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 1));
  printSummary(summary);
  console.log(`results: ${resultsDir}`);
}

await main();
