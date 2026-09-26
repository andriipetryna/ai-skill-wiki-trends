// CLI entry point. Every command prints exactly one JSON object to stdout.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderViewsChart } from "./charts.ts";
import { ApiError } from "./client.ts";
import { collect, ResolveError, VERSION } from "./collect.ts";
import { addMonths, FIRST_AVAILABLE_MONTH, lastCompleteMonth } from "./dates.ts";
import { LABELS, writeReport, type UiLang } from "./report.ts";
import { resolveTopic } from "./resolve.ts";

const SKILL_ROOT = resolve(import.meta.dirname, "../..");
const LANG_RE = /^[a-z]{2,3}(-[a-z]+)*$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const HELP = `wiki-trends ${VERSION}
  resolve  --topic T [--topic T2] --langs pl,cs [--from-lang en]
  analyze  --topic T [--topic T2 ...] --langs pl,cs [--from-lang en]
           [--years 2 | --months 18 | --from YYYY-MM --to YYYY-MM] [--article pl="Tytuł"]
           [--report] [--report-lang uk|en] [--title "..."] [--notes "..."] [--out file.pdf]
Topic = English Wikipedia title (or title in --from-lang) or a Wikidata QID.\n--article lang=Title uses that article in that language instead of the Wikidata link.`;

type Output = Record<string, unknown>;

async function main(argv: string[]): Promise<{ code: number; output: Output }> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
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

    const data = await collect({ topics, langs, fromLang, articles, from, to });
    const uiLang: UiLang = v["report-lang"] === "uk" ? "uk" : "en";

    // Output files: data.json (incl. monthly series), chart.svg, optional report PDF
    const outDir = join(SKILL_ROOT, "output", new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "data.json"), JSON.stringify({ version: VERSION, query: { topics, langs, fromLang, from, to }, ...data }, null, 1));
    const chartSvg = await renderViewsChart(data.perLanguage, langs, LABELS[uiLang].yTitle);
    const chartPath = chartSvg ? join(outDir, "chart.svg") : null;
    if (chartSvg && chartPath) writeFileSync(chartPath, chartSvg);

    let reportPath: string | null = null;
    if (v.report) {
      reportPath = await writeReport({
        out: v.out ? resolve(process.cwd(), v.out) : join(outDir, `report-${uiLang}.pdf`),
        lang: uiLang,
        chartSvg,
        resolution: data.resolution,
        perLanguage: data.perLanguage,
        langs,
        from,
        to,
        ...(v.title ? { title: v.title } : {}),
        ...(v.notes ? { notes: v.notes } : {}),
      });
    }

    return {
      code: 0,
      output: {
        ok: true,
        query: { topics, articles, langs, fromLang, from, to },
        resolution: data.resolution,
        // monthly series stays in data.json to keep the agent's context small
        perLanguage: data.perLanguage.map(({ monthly: _m, ...rest }) => rest),
        caveats: [...LABELS.en.caveatList],
        files: { data: join(outDir, "data.json"), chart: chartPath, report: reportPath },
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
      const hint = e.status === 403 ? "Blocked: set WT_CONTACT (email/URL) for the User-Agent and check network access." : "Retry later.";
      return fail(1, e.message, hint);
    }
    return fail(1, (e as Error).message);
  }
}

function fail(code: number, error: string, hint?: string): { code: number; output: Output } {
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

if (isMain()) {
  const res = await main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(res.output) + "\n");
  process.exitCode = res.code;
}
