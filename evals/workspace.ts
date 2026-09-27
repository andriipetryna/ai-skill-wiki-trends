// Shared by the task evals (run.ts, spec 13) and the triggering evals (trigger.ts, spec 14): a throwaway agent
// workspace with the skill installed, running `claude -p` in it, and small runner utilities.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "..");
export const RESULTS = join(REPO, "evals", "results");
export const AGENT_TOOLS = "Bash Read Glob Grep Skill";
export const CLAUDE = process.env.CLAUDE_BIN || "claude";
export const SKILL_NAME = /^name:\s*(\S+)/m.exec(readFileSync(join(REPO, "SKILL.md"), "utf8"))?.[1] ?? "wiki-trends";

/** User-level settings, hooks, skills and MCP servers stay out, so runs are comparable across machines. */
export const ISOLATION_ARGS = ["--setting-sources", "project,local", "--strict-mcp-config"];

export interface Workspace {
  dir: string;
  outDir: string;
  /** where the skill is installed: `<dir>/.claude/skills/<name>` */
  skillDir: string;
}

export interface WorkspaceOptions {
  /** false: no skill installed (the baseline) */
  skill?: boolean;
  /** replaces the frontmatter `description` in a shadow copy of the skill (SKILL.md copied, everything else symlinked) */
  description?: string | null;
}

/** A fresh workspace outside the repo: a symlink to the skill inside the skill loops for Glob/Grep. */
export function createWorkspace(opts: WorkspaceOptions = {}): Workspace {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-eval-")));
  const outDir = join(dir, "out");
  mkdirSync(outDir);
  const skillDir = join(dir, ".claude", "skills", SKILL_NAME);
  if (opts.skill !== false) {
    mkdirSync(dirname(skillDir), { recursive: true });
    if (opts.description == null) symlinkSync(REPO, skillDir, "dir");
    else {
      mkdirSync(skillDir);
      for (const name of readdirSync(REPO)) {
        if (name !== "SKILL.md" && name !== ".git") symlinkSync(join(REPO, name), join(skillDir, name));
      }
      writeFileSync(join(skillDir, "SKILL.md"), withDescription(readFileSync(join(REPO, "SKILL.md"), "utf8"), opts.description));
    }
  }
  return { dir, outDir, skillDir };
}

/** SKILL.md with its frontmatter `description:` line replaced. */
export function withDescription(skillMd: string, description: string): string {
  const re = /^(---\n[\s\S]*?^description:)[^\n]*$/m;
  if (!re.test(skillMd)) throw new Error("SKILL.md has no frontmatter description line");
  return skillMd.replace(re, (_, head: string) => `${head} ${JSON.stringify(description)}`);
}

export function removeWorkspace(ws: Workspace): void {
  // unlink the skill symlink(s) first so nothing below can ever recurse into the repo
  if (existsSync(ws.skillDir)) {
    if (lstatSync(ws.skillDir).isSymbolicLink()) unlinkSync(ws.skillDir);
    else for (const name of readdirSync(ws.skillDir)) unlinkSync(join(ws.skillDir, name));
  }
  rmSync(ws.dir, { recursive: true, force: true });
  // follow-up scenarios need a persisted session; remove the project dir Claude Code created for this temp workspace
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const sessionDir = join(projects, ws.dir.replace(/[^a-zA-Z0-9]/g, "-"));
  if (basename(sessionDir).includes("wt-eval-") && existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
}

export function runClaude(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((done) => {
    // stdin must be closed, otherwise `claude -p` waits for it
    const child = spawn(CLAUDE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => (stderr += `\nspawn error: ${e.message}`));
    child.on("close", () => {
      clearTimeout(timer);
      done({ stdout, stderr, timedOut });
    });
  });
}

export function claudeAvailable(): boolean {
  return spawnSync(CLAUDE, ["--version"], { encoding: "utf8" }).status === 0;
}

export function gitCommit(): string {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout?.trim() ?? "";
  const head = git("rev-parse", "--short", "HEAD") || "unknown";
  return git("status", "--porcelain") ? `${head}+dirty` : head;
}

/** `YYYYMMDD-HHMMSS` (UTC), the results directory name. */
export const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function pool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
