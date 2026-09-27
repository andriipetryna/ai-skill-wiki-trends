// All human-facing language: report labels, ready-made findings, caveats (en/uk) and the answer checklist (en, for the agent).
// Every number here is copied from the computed result; nothing is recomputed.
import { basename } from "node:path";
import type { LanguageResult } from "./collect.ts";
import { monthRange, type Month } from "./dates.ts";
import type { ConfidenceLevel, Verdict } from "./metrics/confidence.ts";
import { CONFIG } from "./metrics/config.ts";
import { WEIGHT_KEYS, type RankRow, type Weights } from "./metrics/ranking.ts";
import type { Resolution } from "./resolve.ts";

export type UiLang = "en" | "uk";

export const LABELS = {
  en: {
    findings: "Key findings",
    table: "By language",
    chart: "Monthly share of the edition's traffic",
    notes: "Interpretation (written by the AI agent)",
    caveats: "Assumptions & limitations",
    cols: ["Lang", "Article", "Views/mo (median)", "Per million", "YoY share", "Trend/yr", "p", "Verdict", "Confidence"],
    verdicts: { growing: "growing", declining: "declining", flat: "flat", inconclusive: "inconclusive" },
    levels: { high: "high", medium: "medium", low: "low" },
    ranking: "Suggested order to investigate",
    weights: "weights",
    weightNames: { volume: "volume", growth: "growth", confidence: "confidence", share: "share" },
    meta: (langs: string, from: string, to: string, date: string) => `Wikipedia pageviews · ${langs} · ${from} – ${to} · generated ${date}`,
    defaultTitle: (t: string) => `Interest in “${t}” on Wikipedia`,
    noArticle: "no article",
    noData: "no data",
    yTitle: "Views per million pageviews of the edition",
    footer: "Data: Wikimedia Pageviews API (agent=user, all-access), monthly.",
    spikeFooter: "Rings = spike months excluded from the trend.",
  },
  uk: {
    findings: "Основні висновки",
    table: "За мовами",
    chart: "Частка в трафіку розділу за місяць",
    notes: "Інтерпретація (написав AI-агент)",
    caveats: "Припущення та обмеження",
    cols: ["Мова", "Стаття", "Медіана перегл./міс", "На мільйон", "Рік-до-року", "Тренд/рік", "p", "Висновок", "Довіра"],
    verdicts: { growing: "зростає", declining: "спадає", flat: "стабільний", inconclusive: "неоднозначно" },
    levels: { high: "висока", medium: "середня", low: "низька" },
    ranking: "Порядок для подальшого дослідження",
    weights: "ваги",
    weightNames: { volume: "обсяг", growth: "зростання", confidence: "довіра", share: "частка" },
    meta: (langs: string, from: string, to: string, date: string) => `Перегляди Wikipedia · ${langs} · ${from} – ${to} · створено ${date}`,
    defaultTitle: (t: string) => `Інтерес до «${t}» у Wikipedia`,
    noArticle: "немає статті",
    noData: "немає даних",
    yTitle: "Переглядів на мільйон переглядів розділу",
    footer: "Дані: Wikimedia Pageviews API (agent=user, all-access), щомісяця.",
    spikeFooter: "Кільця = місяці-сплески, виключені з тренду.",
  },
} as const;

/** What the text builders read: the `analyze` result (the per-month series is not needed). */
export interface AnalysisResult {
  query: { topics: string[]; articles: Record<string, string[]>; langs: string[]; from: Month; to: Month; redirects: boolean; weights: Weights };
  resolution: Resolution[];
  perLanguage: Omit<LanguageResult, "monthly">[];
  /** empty when fewer than two languages have metrics */
  ranking: RankRow[];
}

// ---- 1. Formatting and translation

export function tVerdict(v: Verdict, lang: UiLang): string {
  return LABELS[lang].verdicts[v];
}

export function tLevel(level: ConfidenceLevel, lang: UiLang): string {
  return LABELS[lang].levels[level];
}

/** +12.3% / -4.5% / n/a */
export function signed(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return `${x > 0 ? "+" : ""}${x.toFixed(1)}%`;
}

/** p<0.001 / p=0.123 */
export function pfmt(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "p=n/a";
  return p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`;
}

/** 12,345 */
export function int(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

const quoteList = (xs: string[]) => xs.map((x) => `«${x}»`).join(", ");

// ---- 2. Findings

/** Ready-made sentences with all the numbers, in a fixed order: per language, relative interest, ranking, edition shifts. */
export function buildFindings(r: AnalysisResult, lang: UiLang): string[] {
  const uk = lang === "uk";
  const rows = orderedRows(r);
  const out: string[] = [];

  // a. one per language, in --langs order
  for (const x of rows) {
    const m = x.metrics;
    if (x.status === "ok" && m) {
      const trend = signed(m.trend?.sharePctPerYear);
      const p = pfmt(m.trend?.pValue);
      const yoy = signed(m.yoy?.sharePct);
      const median = int(m.medianMonthlyViews);
      out.push(
        uk
          ? `${x.lang}: ${tVerdict(m.verdict, lang)} — частка переглядів ${trend}/рік (${p}), рік-до-року ${yoy}, медіана ${median} переглядів/міс; довіра ${tLevel(m.confidence.level, lang)}.`
          : `${x.lang}: ${tVerdict(m.verdict, lang)} — share of edition traffic ${trend}/yr (${p}), YoY ${yoy}, median ${median} views/month; confidence ${tLevel(m.confidence.level, lang)}.`,
      );
    } else if (x.status === "no_article") {
      const closest = x.suggestions?.length ? ` ${uk ? "Найближчі" : "Closest"}: ${quoteList(x.suggestions.map((s) => s.title))}.` : "";
      out.push(`${x.lang}: ${uk ? "статті на цю тему немає." : "no article on this topic."}${closest}`);
    } else {
      out.push(`${x.lang}: ${uk ? "немає даних про перегляди." : "no pageview data."}`);
    }
  }

  // b. relative interest: the only fair cross-language comparison of level
  const withMetrics = rows.flatMap((x) => (x.metrics ? [{ lang: x.lang, share: x.metrics.sharePerMillion.last12Avg }] : []));
  if (withMetrics.length >= 2) {
    const list = [...withMetrics].sort((a, b) => b.share - a.share).map((x) => `${x.lang} ${x.share.toFixed(2)}`).join(", ");
    out.push(
      uk
        ? `Відносний інтерес (переглядів статті на мільйон переглядів розділу, а не на мільйон людей; останні 12 місяців): ${list}. Сирі перегляди не можна порівнювати між мовами.`
        : `Relative interest (article views per million pageviews of the edition, not per million people; last 12 months): ${list}. Raw views are not comparable across languages.`,
    );
  }

  // c. ranking with the weights used
  const order = rankingLine(r.ranking, r.query.weights, lang);
  if (order) out.push(order);

  // d. edition-wide traffic shifts that make raw views misleading
  for (const x of rows) {
    const t = x.metrics?.trend;
    if (!t || Math.abs(t.editionPctPerYear) < CONFIG.findings.editionShiftPctPerYear) continue;
    out.push(
      uk
        ? `Загальний трафік ${x.lang}.wikipedia змінюється на ${signed(t.editionPctPerYear)}/рік (сирі перегляди статті ${signed(t.viewsPctPerYear)}/рік), тому частка — чесніша міра.`
        : `${x.lang}.wikipedia overall traffic changes ${signed(t.editionPctPerYear)}/yr (raw article views ${signed(t.viewsPctPerYear)}/yr), so share is the fairer measure.`,
    );
  }
  return out;
}

/** "Suggested order to investigate: uk (0.97) > de (0.77); weights volume=1, …." or null with < 2 ranked languages. */
export function rankingLine(ranking: RankRow[], weights: Weights, lang: UiLang): string | null {
  if (ranking.length < 2) return null;
  const t = LABELS[lang];
  const order = ranking.map((x) => `${x.lang} (${x.score.toFixed(2)})`).join(" > ");
  const w = WEIGHT_KEYS.map((k) => `${t.weightNames[k]}=${weights[k]}`).join(", ");
  return `${t.ranking}: ${order}; ${t.weights} ${w}.`;
}

function orderedRows(r: AnalysisResult): AnalysisResult["perLanguage"] {
  return r.query.langs.flatMap((l) => r.perLanguage.find((x) => x.lang === l) ?? []);
}

// ---- 3. Caveats

export type Caveat =
  | { code: "synthetic" | "interest_not_demand" | "share_normalisation" | "short_period" | "redirects_on" | "redirects_off" | "single_article" | "cross_language" | "bots" }
  | { code: "period"; params: { from: Month; to: Month } }
  | { code: "search_resolved"; params: { input: string; label: string; qid: string; alternatives: string[] } }
  | { code: "missing_articles"; params: { topic: string; langs: string[] } }
  | { code: "manual_article"; params: { lang: string; title: string } };

/** Data-dependent caveats as codes (stored in data.json), so they can be rendered in any language. */
export function buildCaveats(r: AnalysisResult): Caveat[] {
  const q = r.query;
  const out: Caveat[] = [{ code: "interest_not_demand" }, { code: "share_normalisation" }, { code: "period", params: { from: q.from, to: q.to } }];
  if (monthRange(q.from, q.to).length < 24) out.push({ code: "short_period" });
  for (const x of r.resolution) {
    if (x.matchedBy !== "search") continue;
    out.push({ code: "search_resolved", params: { input: x.input, label: x.label ?? x.input, qid: x.qid ?? "", alternatives: x.alternatives.map((a) => a.title) } });
  }
  for (const topic of q.topics) {
    const langs = orderedRows(r).filter((x) => x.missingTopics.includes(topic)).map((x) => x.lang);
    if (langs.length) out.push({ code: "missing_articles", params: { topic, langs } });
  }
  for (const lang of q.langs) {
    const titles = q.articles[lang];
    if (titles?.length) out.push({ code: "manual_article", params: { lang, title: titles.join(" + ") } });
  }
  out.push({ code: q.redirects ? "redirects_on" : "redirects_off" });
  if (q.topics.length === 1 && !Object.keys(q.articles).length) out.push({ code: "single_article" });
  if (q.langs.length > 1) out.push({ code: "cross_language" });
  out.push({ code: "bots" });
  return out;
}

export function renderCaveat(c: Caveat, lang: UiLang): string {
  const uk = lang === "uk";
  switch (c.code) {
    case "synthetic":
      return uk
        ? "СИНТЕТИЧНІ ТЕСТОВІ ДАНІ (WT_FAKE_API=1). Це не реальні цифри Wikipedia; не використовувати для рішень."
        : "SYNTHETIC TEST DATA (WT_FAKE_API=1). Not real Wikipedia numbers; do not use for decisions.";
    case "interest_not_demand":
      return uk
        ? "Перегляди вимірюють цікавість і увагу, а не готовність платити. Сприймайте результати як сигнал для подальшої перевірки."
        : "Pageviews measure curiosity and attention, not willingness to pay. Treat results as a signal for further validation.";
    case "share_normalisation":
      return uk
        ? "Тренд = зміна частки теми в усіх переглядах цього розділу (переглядів на мільйон переглядів розділу, а не на мільйон людей); разові сплески спершу вилучено."
        : "Trend = change in the topic's share of all pageviews of that edition (views per million pageviews, not per million people); spikes are removed first.";
    case "period":
      return uk ? `Лише повні місяці: ${c.params.from} – ${c.params.to}.` : `Complete months only: ${c.params.from} – ${c.params.to}.`;
    case "short_period":
      return uk ? "Період коротший за 24 місяці: сезонність не контролюється." : "Period is shorter than 24 months: seasonality is not controlled.";
    case "search_resolved": {
      const p = c.params;
      const alts = p.alternatives.length ? (uk ? ` Альтернативи: ${quoteList(p.alternatives)}.` : ` Alternatives: ${quoteList(p.alternatives)}.`) : "";
      return uk
        ? `«${p.input}» зіставлено через пошук зі статтею «${p.label}» (${p.qid}).${alts}`
        : `"${p.input}" was matched via search to "${p.label}" (${p.qid}).${alts}`;
    }
    case "missing_articles":
      return uk
        ? `Немає статті «${c.params.topic}» у розділах: ${c.params.langs.join(", ")}. Відсутність статті сама може свідчити про низький інтерес.`
        : `No article for "${c.params.topic}" in: ${c.params.langs.join(", ")}. Missing coverage may itself signal low interest.`;
    case "manual_article":
      return uk ? `Для ${c.params.lang} статтю обрано вручну: «${c.params.title}».` : `For ${c.params.lang} the article was chosen manually: "${c.params.title}".`;
    case "redirects_on":
      return uk ? "Враховано перегляди перенаправлень (альтернативних назв, до 25 на статтю)." : "Views of redirects (alternative titles, up to 25 per article) are included.";
    case "redirects_off":
      return uk
        ? "Перенаправлення не враховано; перейменовані статті можуть показувати штучне падіння."
        : "Redirect views are excluded; renamed articles may show artificial drops.";
    case "single_article":
      return uk ? "Одна стаття — лише проксі теми." : "A single article is a proxy for the topic.";
    case "cross_language":
      return uk
        ? "Перегляди на мільйон порівнюють відносний інтерес між розділами; абсолютний обсяг відображає розмір аудиторії розділу, а не розмір ринку."
        : "Views per million compare relative interest across editions; absolute volume reflects the edition's audience size, not the market size.";
    case "bots":
      return uk
        ? "Лише трафік agent=user. Відомих ботів виключено, але частина автоматизованого трафіку може залишатися."
        : "Only agent=user traffic. Known bots are excluded, but some automated traffic may remain.";
  }
}

// ---- 4. Answer checklist (English, for the agent)

/** What the agent's reply must contain for this exact result; the report item goes first because weak models drop the tail. */
export function buildAnswerChecklist(r: AnalysisResult, reportPath: string | null, chartPngPath: string | null = null): string[] {
  const out: string[] = [];
  if (reportPath) {
    out.push(`Write the full PDF path in your reply: ${reportPath}. The reply must still contain the full answer below; the PDF does not replace it.`);
  }
  if (chartPngPath) {
    const links = [`[chart.png](${chartPngPath})`, ...(reportPath ? [`[${basename(reportPath)}](${reportPath})`] : [])].join(" · ");
    out.push(
      `Read the chart image ${chartPngPath} with your file/image-reading tool, embed it right after the direct answer as ![Chart](${chartPngPath}), and end the reply with markdown links: ${links}.`,
    );
  }
  out.push("Start with a one-sentence direct answer to the user's question, in the user's language.");
  out.push("Summarise every language: verdict, trend.sharePctPerYear, confidence level. Copy numbers from this JSON, never compute new ones.");

  for (const x of r.resolution) {
    if (x.matchedBy !== "search") continue;
    const alts = x.alternatives.length ? `; offer alternatives: ${x.alternatives.map((a) => `"${a.title}"`).join(", ")}` : "";
    out.push(`Say the topic "${x.input}" was matched via search to "${x.label ?? x.input}"${alts}.`);
  }

  const rows = orderedRows(r);
  const low = rows.filter((x) => x.metrics?.confidence.level === "low");
  if (low.length) {
    const why = low.map((x) => {
      const reason = x.metrics!.confidence.reasons.find((s) => s.startsWith("-"))?.replace(/^-\s*/, "");
      return reason ? `${x.lang} (${reason})` : x.lang;
    });
    out.push(`Say clearly that confidence is LOW for: ${why.join("; ")}.`);
  }

  const spiky = rows.filter((x) => x.metrics?.spikes.length);
  if (spiky.length) {
    const list = spiky.map((x) => `${x.lang} ${x.metrics!.spikes.map((s) => s.month).sort().join(", ")}`);
    out.push(`Mention one-off spikes (excluded from the trend): ${list.join("; ")}.`);
  }

  const noArticle = rows.filter((x) => x.status === "no_article").map((x) => x.lang);
  if (noArticle.length) {
    out.push(`Mention languages without an article: ${noArticle.join(", ")}. Show their suggestions and offer --article; never pick one silently.`);
  }

  if (r.query.langs.length > 1) {
    out.push("Compare languages only by sharePerMillion or the 'Relative interest' finding, never by raw views or ratios.");
  }
  if (r.ranking.length >= 2) out.push("Give the ranking, state the weights used and offer to change them.");
  out.push("Include the caveat that pageviews show interest, not willingness to pay, plus at least one more caveat from caveats.");
  return out;
}
