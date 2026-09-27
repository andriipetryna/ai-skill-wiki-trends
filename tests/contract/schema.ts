// The stdout JSON contract that SKILL.md promises the consuming agent (spec 11). Loose objects: adding a field
// does not break the contract, removing or renaming one does. Test-only (zod is a dev dependency).
import { z } from "zod";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Pct = z.number();
const Unit = z.number().min(0).max(1);
const Count = z.number().int().nonnegative();

export const CandidateSchema = z.looseObject({
  title: z.string(),
  qid: z.string().nullable(),
  description: z.string().optional(),
});

export const ResolutionSchema = z.looseObject({
  input: z.string(),
  status: z.enum(["ok", "ambiguous", "not_found"]),
  matchedBy: z.enum(["qid", "exact_title", "search"]).nullable(),
  qid: z.string().nullable(),
  label: z.string().nullable(),
  articles: z.record(z.string(), z.string().nullable()),
  alternatives: z.array(CandidateSchema),
});

const WeightsSchema = z.looseObject({ volume: z.number().nonnegative(), growth: z.number().nonnegative(), confidence: z.number().nonnegative(), share: z.number().nonnegative() });

export const MetricsSchema = z.looseObject({
  months: Count,
  medianMonthlyViews: Count,
  sharePerMillion: z.looseObject({ median: z.number().nonnegative(), last12Avg: z.number().nonnegative() }),
  yoy: z
    .looseObject({
      method: z.enum(["last12_vs_prev12", "second_half_vs_first_half"]),
      sharePct: Pct,
      sharePctWithSpikes: Pct.nullable(),
      viewsPct: Pct.nullable(),
      editionPct: Pct.nullable(),
    })
    .nullable(),
  trend: z
    .looseObject({
      sharePctPerYear: Pct,
      viewsPctPerYear: Pct,
      editionPctPerYear: Pct,
      pValue: Unit,
      test: z.enum(["seasonal_mann_kendall", "mann_kendall"]),
    })
    .nullable(),
  verdict: z.enum(["growing", "declining", "flat", "inconclusive"]),
  confidence: z.looseObject({
    level: z.enum(["high", "medium", "low"]),
    score: Unit,
    reasons: z.array(z.string().regex(/^[+-] \S/)),
  }),
  spikes: z.array(z.looseObject({ month: Month, views: Count, xBaseline: z.number().positive() })),
});

export const LanguageSchema = z.looseObject({
  lang: z.string(),
  status: z.enum(["ok", "no_article", "no_data"]),
  articles: z.array(z.string()),
  redirectsIncluded: Count,
  missingTopics: z.array(z.string()),
  suggestions: z.array(CandidateSchema).optional(),
  totalViews: Count,
  avgMonthlyViews: Count,
  periods: z.array(z.looseObject({ from: Month, to: Month, views: Count })),
  metrics: MetricsSchema.nullable(),
});

export const RankRowSchema = z.looseObject({
  rank: z.number().int().positive(),
  lang: z.string(),
  score: Unit,
  components: z.looseObject({ volume: Unit, growth: Unit, confidence: Unit, share: Unit }),
});

export const AnalysisOutputSchema = z.looseObject({
  ok: z.literal(true),
  query: z.looseObject({
    topics: z.array(z.string()),
    articles: z.record(z.string(), z.array(z.string())),
    langs: z.array(z.string()).min(1),
    fromLang: z.string(),
    from: Month,
    to: Month,
    redirects: z.boolean(),
    weights: WeightsSchema,
  }),
  resolution: z.array(ResolutionSchema),
  perLanguage: z.array(LanguageSchema),
  ranking: z.array(RankRowSchema),
  findings: z.array(z.string()).min(1),
  answerChecklist: z.array(z.string()).min(1),
  caveats: z.array(z.string()).min(2),
  files: z.looseObject({
    data: z.string(),
    chart: z.string().nullable(),
    chartPng: z.string().nullable(),
    report: z.string().nullable(),
  }),
});

export const ResolveOutputSchema = z.looseObject({
  ok: z.literal(true),
  resolution: z.array(ResolutionSchema),
});

export const ErrorOutputSchema = z.looseObject({
  ok: z.literal(false),
  error: z.string().min(1),
  hint: z.string().optional(),
  candidates: z.array(CandidateSchema).optional(),
});

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;
export type ErrorOutput = z.infer<typeof ErrorOutputSchema>;
