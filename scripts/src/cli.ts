// CLI entry point. Every command prints exactly one JSON object to stdout.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCliArgs } from "./args.ts";
import { renderViewsChart, svgToPng } from "./charts.ts";
import { ApiError } from "./client.ts";
import { collect, ResolveError, VERSION } from "./collect.ts";
import { writeReport } from "./report.ts";
import { resolveTopic } from "./resolve.ts";
import { buildAnswerChecklist, buildCaveats, buildFindings, LABELS, renderCaveat, type Caveat } from "./text.ts";

const SKILL_ROOT = resolve(import.meta.dirname, "../..");

const HELP = `wiki-trends ${VERSION}
  resolve  --topic T [--topic T2] --langs pl,cs [--from-lang en]
  analyze  --topic T [--topic T2 ...] --langs pl,cs [--from-lang en]
           [--years 2 | --months 18 | --from YYYY-MM --to YYYY-MM] [--article pl="Tytuł"]
           [--no-redirects]  exclude views of redirects (old/alternative titles; included by default)
           [--weights volume=1,growth=1,confidence=1,share=0]  ranking weights; any subset, the rest keep these defaults
           [--report] [--report-lang uk|en] [--title "..."] [--notes "..."] [--out file.pdf]
           [--out-dir DIR]   write files to DIR/wiki-trends-<timestamp>/ (default: $WT_OUT_DIR, else <skill>/output/<timestamp>/)
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
  const parsed = parseCliArgs(argv, new Date());
  if (!parsed.ok) return fail(2, parsed.error, parsed.hint);
  const a = parsed.args;
  if (a.help) return { code: 0, output: { ok: true, help: HELP } };
  const { cmd, topics, articles, langs, fromLang, weights, redirects } = a;

  try {
    if (cmd === "resolve") {
      const resolution = await Promise.all(topics.map((t) => resolveTopic(t, fromLang, langs)));
      return { code: 0, output: { ok: true, resolution } };
    }
    if (cmd !== "analyze" || !a.period) return fail(2, `Unknown command "${cmd}"`, "Commands: resolve, analyze");

    const { from, to } = a.period;
    const data = await collect({ topics, langs, fromLang, articles, from, to, redirects, weights });
    const uiLang = a.reportLang;
    const query = { topics, articles, langs, fromLang, from, to, redirects, weights };
    const result = { query, ...data };
    // synthetic data must never pass for real numbers: first caveat, in the JSON and in the PDF
    const caveats: Caveat[] = [...(syntheticMode() ? [{ code: "synthetic" } as const] : []), ...buildCaveats(result)];

    // Output files: data.json (incl. monthly series and caveat codes), chart.svg + chart.png, optional report PDF
    // WT_OUT_DIR (evals: the agent chooses the flags, the harness chooses where files go) is the default --out-dir
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const outBase = a.outDir ?? (process.env.WT_OUT_DIR || undefined);
    const outDir = outBase ? join(resolve(process.cwd(), outBase), `wiki-trends-${stamp}`) : join(SKILL_ROOT, "output", stamp);
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
    if (a.report) {
      reportPath = await writeReport({
        out: a.out ? resolve(process.cwd(), a.out) : join(outDir, `report-${uiLang}.pdf`),
        lang: uiLang,
        result,
        caveats,
        ...(a.title ? { title: a.title } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
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
