// CLI entry point. Every command prints exactly one JSON object to stdout.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderViewsChart, svgToPng } from "./charts.ts";
import { ApiError } from "./client.ts";
import { collect, ResolveError, VERSION } from "./collect.ts";
import { addMonths, FIRST_AVAILABLE_MONTH, lastCompleteMonth } from "./dates.ts";
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, type Weights } from "./metrics/ranking.ts";
import { writeReport } from "./report.ts";
import { resolveTopic } from "./resolve.ts";
import { buildAnswerChecklist, buildCaveats, buildFindings, LABELS, renderCaveat, type Caveat, type UiLang } from "./text.ts";

const SKILL_ROOT = resolve(import.meta.dirname, "../..");
const LANG_RE = /^[a-z]{2,3}(-[a-z]+)*$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const WEIGHTS_HINT = `Use --weights key=number[,key=number...] with keys ${WEIGHT_KEYS.join(", ")} (non-negative numbers; missing keys default to ${WEIGHT_KEYS.map((k) => `${k}=${DEFAULT_WEIGHTS[k]}`).join(",")}).`;

const HELP = `wiki-trends ${VERSION}
  resolve  --topic T [--topic T2] --langs pl,cs [--from-lang en]
  analyze  --topic T [--topic T2 ...] --langs pl,cs [--from-lang en]
           [--years 2 | --months 18 | --from YYYY-MM --to YYYY-MM] [--article pl="Tytuł"]
           [--no-redirects]  exclude views of redirects (old/alternative titles; included by default)
           [--weights volume=1,growth=1,confidence=1,share=0]  ranking weights; any subset, the rest keep these defaults
           [--report] [--report-lang uk|en] [--title "..."] [--notes "..."] [--out file.pdf]
           [--out-dir DIR]   write files to DIR/wiki-trends-<timestamp>/ (default: <skill>/output/<timestamp>/)
Topic = English Wikipedia title (or title in --from-lang) or a Wikidata QID.\n--article lang=Title uses that article in that language instead of the Wikidata link.`;

type Output = Record<string, unknown>;

export interface CliResult {
  code: number;
  output: Output;
}

/** WT_FAKE_API=1: every request is answered from the synthetic world in tests/fake/ (evals, demos). */
function syntheticMode(): boolean {
  return process.env.WT_FAKE_API === "1";
}

/** Runs one command in-process. The entry point below only prints the result and sets the exit code. */
export async function runCli(argv: string[]): Promise<CliResult> {
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
    return fail(2, (e as Error).message, "Run with --help for usage.");
  }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0];
  if (!cmd || v.help || cmd === "help") return { code: 0, output: { ok: true, help: HELP } };

  const topics = v.topic ?? [];
  const langs = (v.langs ?? "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const fromLang = v["from-lang"] ?? "en";
  const articles: Record<string, string[]> = {};
  for (const a of v.article ?? []) {
    const i = a.indexOf("=");
    if (i < 1) return fail(2, `--article must look like lang=Title, got "${a}"`);
    (articles[a.slice(0, i).trim().toLowerCase()] ??= []).push(a.slice(i + 1).trim());
  }
  if (!topics.length && !Object.keys(articles).length) return fail(2, "--topic is required");
  if (!langs.length) return fail(2, "--langs is required, e.g. --langs pl,cs");
  const badLang = [...langs, fromLang].find((l) => !LANG_RE.test(l));
  if (badLang) return fail(2, `Invalid language code "${badLang}"`, "Use Wikipedia codes like uk, pl, cs (Ukrainian is 'uk', not 'ua').");
  const weights = parseWeights(v.weights);
  if (typeof weights === "string") return fail(2, weights, WEIGHTS_HINT);

  try {
    if (cmd === "resolve") {
      const resolution = await Promise.all(topics.map((t) => resolveTopic(t, fromLang, langs)));
      return { code: 0, output: { ok: true, resolution } };
    }
    if (cmd !== "analyze") return fail(2, `Unknown command "${cmd}"`, "Commands: resolve, analyze");

    // Period: complete months only
    const to = v.to ?? lastCompleteMonth(new Date());
    let from = v.from;
    if (!from) {
      const span = v.months ? Number(v.months) : Number(v.years ?? 3) * 12;
      if (!Number.isInteger(span) || span < 6) return fail(2, "--years/--months must give at least 6 months");
      from = addMonths(to, -(span - 1));
    }
    if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || from > to) return fail(2, "--from/--to must be YYYY-MM and from <= to");
    if (from < FIRST_AVAILABLE_MONTH) from = FIRST_AVAILABLE_MONTH;

    const redirects = v.redirects;
    const data = await collect({ topics, langs, fromLang, articles, from, to, redirects, weights });
    const uiLang: UiLang = v["report-lang"] === "uk" ? "uk" : "en";
    const query = { topics, articles, langs, fromLang, from, to, redirects, weights };
    const result = { query, ...data };
    // synthetic data must never pass for real numbers: first caveat, in the JSON and in the PDF
    const caveats: Caveat[] = [...(syntheticMode() ? [{ code: "synthetic" } as const] : []), ...buildCaveats(result)];

    // Output files: data.json (incl. monthly series and caveat codes), chart.svg + chart.png, optional report PDF
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const outDir = v["out-dir"] ? join(resolve(process.cwd(), v["out-dir"]), `wiki-trends-${stamp}`) : join(SKILL_ROOT, "output", stamp);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "data.json"), JSON.stringify({ version: VERSION, query, ...data, caveats }, null, 1));
    const chartSvg = await renderViewsChart(data.perLanguage, langs, LABELS[uiLang].yTitle);
    const chartPath = chartSvg ? join(outDir, "chart.svg") : null;
    const chartPngPath = chartSvg ? join(outDir, "chart.png") : null;
    if (chartSvg && chartPath && chartPngPath) {
      writeFileSync(chartPath, chartSvg);
      writeFileSync(chartPngPath, svgToPng(chartSvg));
    }

    let reportPath: string | null = null;
    if (v.report) {
      reportPath = await writeReport({
        out: v.out ? resolve(process.cwd(), v.out) : join(outDir, `report-${uiLang}.pdf`),
        lang: uiLang,
        result,
        caveats,
        ...(v.title ? { title: v.title } : {}),
        ...(v.notes ? { notes: v.notes } : {}),
      });
    }

    return {
      code: 0,
      output: {
        ok: true,
        query,
        resolution: data.resolution,
        // monthly series stays in data.json to keep the agent's context small
        perLanguage: data.perLanguage.map(({ monthly: _m, ...rest }) => rest),
        ranking: data.ranking,
        findings: buildFindings(result, "en"),
        answerChecklist: buildAnswerChecklist(result, reportPath, chartPngPath),
        caveats: caveats.map((c) => renderCaveat(c, "en")),
        files: { data: join(outDir, "data.json"), chart: chartPath, chartPng: chartPngPath, report: reportPath },
      },
    };
  } catch (e) {
    if (e instanceof ResolveError) {
      return {
        code: 2,
        output: {
          ok: false,
          error: e.message,
          hint: "Ask the user which one they mean, then rerun with --topic <exact title> or --topic <QID>.",
          candidates: e.resolution.alternatives,
        },
      };
    }
    if (e instanceof ApiError) {
      const hint = e.status === 403 ? "Blocked: set WT_CONTACT to your own email/URL for the User-Agent (the default one may be blocked) and check network access." : "Retry later.";
      return fail(1, e.message, hint);
    }
    return fail(1, (e as Error).message);
  }
}

/** "growth=2,share=1" → full weights (missing keys from DEFAULT_WEIGHTS), or an error message. */
function parseWeights(spec: string | undefined): Weights | string {
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

function fail(code: number, error: string, hint?: string): CliResult {
  return { code, output: { ok: false, error, ...(hint ? { hint } : {}) } };
}

// realpath: skills are often installed as symlinks, and Node resolves the main module's path
function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

/** Swaps the global fetch for the fake Wikimedia API. Loaded lazily: tests/fake/ is not needed otherwise. */
async function installFakeApi(): Promise<void> {
  const [{ createFakeFetch }, { demoWorld }] = await Promise.all([import("../../tests/fake/fetch.ts"), import("../../tests/fake/world.ts")]);
  globalThis.fetch = createFakeFetch(demoWorld());
  process.stderr.write("wiki-trends: WT_FAKE_API=1, serving synthetic data (not real Wikipedia numbers)\n");
}

async function entry(argv: string[]): Promise<CliResult> {
  if (syntheticMode()) {
    try {
      await installFakeApi();
    } catch (e) {
      return fail(1, `WT_FAKE_API=1, but the fake API could not be loaded: ${(e as Error).message}`, "Unset WT_FAKE_API to use the real Wikimedia APIs.");
    }
  }
  return runCli(argv);
}

if (isMain()) {
  const res = await entry(process.argv.slice(2));
  process.stdout.write(JSON.stringify(res.output) + "\n");
  process.exitCode = res.code;
}
