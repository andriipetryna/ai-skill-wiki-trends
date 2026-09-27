// Data pipeline: topics -> articles per language -> monthly views + edition traffic -> metrics.
import { articleMonthly, editionMonthly, redirects } from "./client.ts";
import { monthRange, type Month } from "./dates.ts";
import { computeLanguageMetrics, type LanguageMetrics, type MetricPoint } from "./metrics/index.ts";
import { DEFAULT_WEIGHTS, rankLanguages, type RankInput, type RankRow, type Weights } from "./metrics/ranking.ts";
import { resolveTopic, searchEdition, type Candidate, type Resolution } from "./resolve.ts";

export const VERSION = "0.13.0";

export interface CollectParams {
  topics: string[];
  langs: string[];
  fromLang: string;
  /** manual overrides: lang -> article titles in that edition */
  articles: Record<string, string[]>;
  from: Month;
  to: Month;
  /** add views of redirects (old / alternative titles) to each article; default true */
  redirects?: boolean;
  /** weights for the language ranking; default DEFAULT_WEIGHTS */
  weights?: Weights;
}

export interface Period {
  from: Month;
  to: Month;
  views: number;
}

export interface LanguageResult {
  lang: string;
  status: "ok" | "no_article" | "no_data";
  articles: string[];
  /** how many redirect titles were added to `articles` (their views are summed in) */
  redirectsIncluded: number;
  missingTopics: string[];
  /** when a topic has no linked article in this language: search results from that edition */
  suggestions?: Candidate[];
  totalViews: number;
  avgMonthlyViews: number;
  /** consecutive 12-month blocks ending at `to` (two halves if the range is < 24 months) */
  periods: Period[];
  /** null for no_article / no_data */
  metrics: LanguageMetrics | null;
  monthly: MetricPoint[];
}

export class ResolveError extends Error {
  readonly resolution: Resolution;
  constructor(r: Resolution) {
    super(r.status === "ambiguous" ? `Topic "${r.input}" is ambiguous` : `No Wikipedia article found for "${r.input}"`);
    this.resolution = r;
  }
}

export async function collect(p: CollectParams): Promise<{ resolution: Resolution[]; perLanguage: LanguageResult[]; ranking: RankRow[] }> {
  const months = monthRange(p.from, p.to);
  const resolution = p.topics.length ? await Promise.all(p.topics.map((t) => resolveTopic(t, p.fromLang, p.langs))) : [];
  for (const r of resolution) if (r.status !== "ok") throw new ResolveError(r);

  // full-precision ranking inputs of the languages that have metrics, kept out of the output
  const rankInputs = new Map<string, RankInput>();
  const perLanguage = await Promise.all(
    p.langs.map(async (lang): Promise<LanguageResult> => {
      const manual = p.articles[lang];
      const titles = manual ?? Array.from(new Set(resolution.map((r) => r.articles[lang]).filter((t): t is string => !!t)));
      const missing = manual ? [] : resolution.filter((r) => !r.articles[lang]);
      const missingTopics = missing.map((r) => r.input);
      // Wikidata may simply lack the link (or the edition covers the topic in a broader article): search it
      const suggestions = missing.length ? await searchEdition(lang, missing[0]!.label ?? missing[0]!.input).catch(() => []) : [];
      const empty = {
        lang,
        articles: titles,
        redirectsIncluded: 0,
        missingTopics,
        ...(suggestions.length ? { suggestions } : {}),
        totalViews: 0,
        avgMonthlyViews: 0,
        periods: [],
        metrics: null,
        monthly: [],
      };
      if (titles.length === 0) return { ...empty, status: "no_article" };

      // Renamed articles keep receiving views through their old titles: count those too.
      // A Set dedupes redirects shared by several basket articles (or equal to another article).
      const norm = (t: string) => t.replace(/_/g, " ");
      const all = new Set(titles.map(norm));
      const articleCount = all.size;
      if (p.redirects ?? true) {
        const found = await Promise.all(
          titles.map((t) =>
            redirects(lang, t).catch((e: Error) => {
              process.stderr.write(`wiki-trends: redirects of ${lang}:"${t}" skipped: ${e.message}\n`);
              return [];
            }),
          ),
        );
        for (const r of found.flat()) all.add(norm(r));
      }
      const redirectsIncluded = all.size - articleCount;

      // Several topics = a basket: views are summed per month. Edition traffic is the normalisation base.
      const [edition, ...series] = await Promise.all([
        editionMonthly(lang, p.from, p.to),
        ...[...all].map((t) => articleMonthly(lang, t, p.from, p.to)),
      ]);
      const views = sumSeries(months, series);
      if (views.every((v) => v === 0)) return { ...empty, redirectsIncluded, status: "no_data" };

      const total = views.reduce((a, b) => a + b, 0);
      const periods = splitPeriods(months, views);
      const { metrics, points, rankInput } = computeLanguageMetrics(months, views, months.map((m) => edition.get(m) ?? 0));
      rankInputs.set(lang, { lang, ...rankInput });
      return {
        ...empty,
        status: "ok",
        redirectsIncluded,
        totalViews: total,
        avgMonthlyViews: Math.round(total / months.length),
        periods,
        metrics,
        monthly: points,
      };
    }),
  );
  // Ranking is relative to the compared languages: meaningless with fewer than two. Inputs in --langs order.
  const ranked = p.langs.flatMap((l) => rankInputs.get(l) ?? []);
  const ranking = ranked.length >= 2 ? rankLanguages(ranked, p.weights ?? DEFAULT_WEIGHTS) : [];
  return { resolution, perLanguage, ranking };
}

/** Basket: views of several titles summed per month; null (no data) and missing months count as 0. */
export function sumSeries(months: readonly Month[], series: ReadonlyArray<ReadonlyMap<Month, number> | null>): number[] {
  return months.map((m) => series.reduce((acc, s) => acc + (s?.get(m) ?? 0), 0));
}

/** Consecutive blocks ending at the last month: 12 months if n >= 24, else two halves; leftover leading months are dropped. */
export function splitPeriods(months: readonly Month[], views: readonly number[]): Period[] {
  const n = months.length;
  const size = n >= 24 ? 12 : Math.floor(n / 2);
  const out: Period[] = [];
  for (let end = n; end - size >= 0; end -= size) {
    out.unshift({ from: months[end - size]!, to: months[end - 1]!, views: views.slice(end - size, end).reduce((a, b) => a + b, 0) });
  }
  return out;
}
