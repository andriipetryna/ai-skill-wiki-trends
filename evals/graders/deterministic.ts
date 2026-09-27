// Deterministic graders (spec 13). Each check returns true or a failure message.

export type Check = true | string;

export interface Expect {
  /** regexes (case-insensitive); each must match at least one scripts/wt command */
  commands?: string[];
  /** default: one scripts/wt call per user turn */
  maxWtCalls?: number;
  /** regexes (case-insensitive); each must match the answer */
  mentions?: string[];
  /** a PDF must be produced and delivered */
  report?: boolean;
  /** the answer must carry the interest ≠ willingness-to-pay caveat */
  caveat?: boolean;
  /** meaning-level items for the optional LLM judge */
  rubric?: string[];
}

/** What the graders look at, extracted from the transcripts and the out-dir. */
export interface RunRecord {
  userTurns: number;
  /** every Bash command, including those that are not scripts/wt */
  bashCommands: string[];
  /** Bash commands that run scripts/wt */
  wtCommands: string[];
  wtCalls: number;
  /** all assistant text of all turns, plus a "[file sent: …]" line per delivered file */
  answer: string;
  sentFiles: string[];
  /** files in the scenario's out-dir (absolute paths) */
  outFiles: string[];
  /** a successful analyze produced a chart */
  chartProduced: boolean;
}

// Broad on purpose: literal regexes produced false failures in practice (spec 13, best practice 1)
const CAVEAT = /готовн|купівел|спроможн|потреб|не означає|не дорівнює|≠|willingness|not .*pay/i;
const OWN_CODE = /python|node -e|curl|wget|wikimedia\.org|wikipedia\.org\/w\/api/i;
const WT_CALL = /scripts\/wt(?![\w./-])/g;

export function countWtCalls(commands: string[]): number {
  return commands.reduce((n, c) => n + (c.match(WT_CALL)?.length ?? 0), 0);
}

export function isWtCommand(command: string): boolean {
  return countWtCalls([command]) > 0;
}

export function checkCommands(wtCommands: string[], patterns: string[]): Check {
  const missing = patterns.filter((p) => !wtCommands.some((c) => new RegExp(p, "i").test(c)));
  if (!missing.length) return true;
  return `no scripts/wt command matches ${missing.map((p) => `/${p}/`).join(", ")}; commands: ${wtCommands.length ? wtCommands.join(" | ") : "(none)"}`;
}

export function checkWtCalls(calls: number, max: number): Check {
  return calls <= max ? true : `${calls} scripts/wt calls, max ${max}`;
}

export function checkMentions(answer: string, patterns: string[]): Check {
  const missing = patterns.filter((p) => !new RegExp(p, "i").test(answer));
  return missing.length ? `answer does not mention ${missing.map((p) => `/${p}/`).join(", ")}` : true;
}

export function checkReport(outFiles: string[], answer: string, sentFiles: string[]): Check {
  if (!outFiles.some((f) => /\.pdf$/i.test(f))) return "no PDF in the out-dir";
  if (!/\.pdf/i.test(answer) && !sentFiles.length) return "PDF produced but neither linked in the answer nor sent";
  return true;
}

export function checkChart(answer: string, sentFiles: string[]): Check {
  return /chart\.png/i.test(answer) || sentFiles.some((f) => /\.png$/i.test(f)) ? true : "chart.png neither embedded/linked nor sent";
}

export function checkCaveat(answer: string): Check {
  return CAVEAT.test(answer) ? true : "no interest ≠ willingness-to-pay caveat";
}

export function checkNoOwnCode(bashCommands: string[]): Check {
  const bad = bashCommands.filter((c) => OWN_CODE.test(c));
  return bad.length ? `bypassed the CLI: ${bad.join(" | ")}` : true;
}

/** All applicable deterministic checks, keyed by name. Checks that do not apply are absent. */
export function gradeDeterministic(expect: Expect, r: RunRecord): Record<string, Check> {
  const out: Record<string, Check> = {};
  if (expect.commands?.length) out.command = checkCommands(r.wtCommands, expect.commands);
  out.wtCalls = checkWtCalls(r.wtCalls, expect.maxWtCalls ?? r.userTurns);
  if (expect.mentions?.length) out.mentions = checkMentions(r.answer, expect.mentions);
  if (expect.report) out.report = checkReport(r.outFiles, r.answer, r.sentFiles);
  if (r.chartProduced) out.chart = checkChart(r.answer, r.sentFiles);
  if (expect.caveat) out.caveat = checkCaveat(r.answer);
  out.noOwnCode = checkNoOwnCode(r.bashCommands);
  return out;
}
