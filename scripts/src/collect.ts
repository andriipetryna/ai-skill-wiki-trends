// Data pipeline: topics -> articles per language -> monthly views -> simple period totals.
// Deliberately minimal (MVP): no normalisation, trend tests or confidence yet.
import { articleMonthly } from "./client.ts";
import { monthRange, type Month } from "./dates.ts";
import { resolveTopic, searchEdition, type Candidate, type Resolution } from "./resolve.ts";

export const VERSION = "0.4.0";

export interface CollectParams {
  topics: string[];
  langs: string[];
  fromLang: string;
  /** manual overrides: lang -> article titles in that edition */
  articles: Record<string, string[]>;
  from: Month;
  to: Month;
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
  missingTopics: string[];
  /** when a topic has no linked article in this language: search results from that edition */
  suggestions?: Candidate[];
  totalViews: number;
  avgMonthlyViews: number;
  /** consecutive 12-month blocks ending at `to` (two halves if the range is < 24 months) */
  periods: Period[];
  /** % change of the last period vs the previous one */
  changePct: number | null;
  monthly: Array<{ month: Month; views: number }>;
}

export class ResolveError extends Error {
  readonly resolution: Resolution;
  constructor(r: Resolution) {
    super(r.status === "ambiguous" ? `Topic "${r.input}" is ambiguous` : `No Wikipedia article found for "${r.input}"`);
    this.resolution = r;
  }
}

export async function collect(p: CollectParams): Promise<{ resolution: Resolution[]; perLanguage: LanguageResult[] }> {
  const months = monthRange(p.from, p.to);
  const resolution = p.topics.length ? await Promise.all(p.topics.map((t) => resolveTopic(t, p.fromLang, p.langs))) : [];
  for (const r of resolution) if (r.status !== "ok") throw new ResolveError(r);

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
        missingTopics,
        ...(suggestions.length ? { suggestions } : {}),
        totalViews: 0,
        avgMonthlyViews: 0,
        periods: [],
        changePct: null,
        monthly: [],
      };
      if (titles.length === 0) return { ...empty, status: "no_article" };

      // Several topics = a basket: views are summed per month
      const series = await Promise.all(titles.map((t) => articleMonthly(lang, t, p.from, p.to)));
      const views = months.map((m) => series.reduce((acc, s) => acc + (s?.get(m) ?? 0), 0));
      if (views.every((v) => v === 0)) return { ...empty, status: "no_data" };

      const total = views.reduce((a, b) => a + b, 0);
      const periods = splitPeriods(months, views);
      const last = periods.at(-1);
      const prev = periods.at(-2);
      return {
        ...empty,
        status: "ok",
        totalViews: total,
        avgMonthlyViews: Math.round(total / months.length),
        periods,
        changePct: last && prev && prev.views > 0 ? Math.round((last.views / prev.views - 1) * 1000) / 10 : null,
        monthly: months.map((m, i) => ({ month: m, views: views[i]! })),
      };
    }),
  );
  return { resolution, perLanguage };
}

function splitPeriods(months: Month[], views: number[]): Period[] {
  const n = months.length;
  const size = n >= 24 ? 12 : Math.floor(n / 2);
  const out: Period[] = [];
  for (let end = n; end - size >= 0; end -= size) {
    out.unshift({ from: months[end - size]!, to: months[end - 1]!, views: views.slice(end - size, end).reduce((a, b) => a + b, 0) });
  }
  return out;
}
