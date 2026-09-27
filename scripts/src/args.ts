// Command-line parsing and validation: pure (argv and the clock in, options or an error out), no I/O.
import { parseArgs } from "node:util";
import { addMonths, FIRST_AVAILABLE_MONTH, lastCompleteMonth, type Month } from "./dates.ts";
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, type Weights } from "./metrics/ranking.ts";
import type { UiLang } from "./text.ts";

const LANG_RE = /^[a-z]{2,3}(-[a-z]+)*$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const WEIGHTS_HINT = `Use --weights key=number[,key=number...] with keys ${WEIGHT_KEYS.join(", ")} (non-negative numbers; missing keys default to ${WEIGHT_KEYS.map((k) => `${k}=${DEFAULT_WEIGHTS[k]}`).join(",")}).`;

export interface CliArgs {
  /** first positional ("" when missing) */
  cmd: string;
  /** no command, "help" or --help: nothing else is validated */
  help: boolean;
  topics: string[];
  /** manual overrides: lang -> article titles */
  articles: Record<string, string[]>;
  langs: string[];
  fromLang: string;
  weights: Weights;
  redirects: boolean;
  /** complete-month period; set for `analyze` only */
  period: { from: Month; to: Month } | null;
  report: boolean;
  reportLang: UiLang;
  title?: string;
  notes?: string;
  out?: string;
  outDir?: string;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string; hint?: string };

/** `now` decides the default period end (last complete month). Every error is a usage error (exit 2). */
export function parseCliArgs(argv: string[], now: Date): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        topic: { type: "string", multiple: true },
        article: { type: "string", multiple: true },
        langs: { type: "string" },
        "from-lang": { type: "string" },
        years: { type: "string" },
        months: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        report: { type: "boolean", default: false },
        "report-lang": { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        out: { type: "string" },
        "out-dir": { type: "string" },
        redirects: { type: "boolean", default: true },
        weights: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    return fail((e as Error).message, "Run with --help for usage.");
  }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0] ?? "";
  const base: CliArgs = {
    cmd,
    help: false,
    topics: v.topic ?? [],
    articles: {},
    langs: (v.langs ?? "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
    fromLang: v["from-lang"] ?? "en",
    weights: { ...DEFAULT_WEIGHTS },
    redirects: v.redirects,
    period: null,
    report: v.report,
    reportLang: v["report-lang"] === "uk" ? "uk" : "en",
    ...(v.title ? { title: v.title } : {}),
    ...(v.notes ? { notes: v.notes } : {}),
    ...(v.out ? { out: v.out } : {}),
    ...(v["out-dir"] ? { outDir: v["out-dir"] } : {}),
  };
  if (!cmd || v.help || cmd === "help") return { ok: true, args: { ...base, help: true } };

  const { topics, articles, langs, fromLang } = base;
  for (const a of v.article ?? []) {
    const i = a.indexOf("=");
    if (i < 1) return fail(`--article must look like lang=Title, got "${a}"`);
    (articles[a.slice(0, i).trim().toLowerCase()] ??= []).push(a.slice(i + 1).trim());
  }
  if (!topics.length && !Object.keys(articles).length) return fail("--topic is required");
  if (!langs.length) return fail("--langs is required, e.g. --langs pl,cs");
  const badLang = [...langs, fromLang].find((l) => !LANG_RE.test(l));
  if (badLang) return fail(`Invalid language code "${badLang}"`, "Use Wikipedia codes like uk, pl, cs (Ukrainian is 'uk', not 'ua').");
  const weights = parseWeights(v.weights);
  if (typeof weights === "string") return fail(weights, WEIGHTS_HINT);
  if (cmd !== "analyze") return { ok: true, args: { ...base, weights } };

  // Period: complete months only
  const to = v.to ?? lastCompleteMonth(now);
  let from = v.from;
  if (!from) {
    const span = v.months ? Number(v.months) : Number(v.years ?? 3) * 12;
    if (!Number.isInteger(span) || span < 6) return fail("--years/--months must give at least 6 months");
    from = addMonths(to, -(span - 1));
  }
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || from > to) return fail("--from/--to must be YYYY-MM and from <= to");
  if (from < FIRST_AVAILABLE_MONTH) from = FIRST_AVAILABLE_MONTH;
  return { ok: true, args: { ...base, weights, period: { from, to } } };
}

/** "growth=2,share=1" → full weights (missing keys from DEFAULT_WEIGHTS), or an error message. */
export function parseWeights(spec: string | undefined): Weights | string {
  const w: Weights = { ...DEFAULT_WEIGHTS };
  for (const part of (spec ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    const key = (i < 0 ? part : part.slice(0, i)).trim();
    const raw = i < 0 ? "" : part.slice(i + 1).trim();
    if (!(WEIGHT_KEYS as string[]).includes(key)) return `Unknown weight "${key}" in --weights`;
    const x = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(x) || x < 0) return `Weight ${key} must be a non-negative number, got "${raw}"`;
    w[key as keyof Weights] = x;
  }
  return w;
}

function fail(error: string, hint?: string): ParseResult {
  return { ok: false, error, ...(hint ? { hint } : {}) };
}
