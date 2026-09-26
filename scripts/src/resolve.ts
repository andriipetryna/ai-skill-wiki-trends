// Topic -> Wikidata QID -> article title in every requested language.
import { mw, siteFor, wikidata } from "./client.ts";

export interface Candidate {
  title: string;
  qid: string | null;
  description?: string;
}

export interface Resolution {
  input: string;
  status: "ok" | "ambiguous" | "not_found";
  matchedBy: "qid" | "exact_title" | "search" | null;
  qid: string | null;
  label: string | null;
  /** lang -> article title (null = no article in that language) */
  articles: Record<string, string | null>;
  alternatives: Candidate[];
}

interface MwPage {
  title: string;
  missing?: boolean;
  index?: number;
  description?: string;
  pageprops?: { wikibase_item?: string; disambiguation?: string };
}
type MwQuery = { query?: { pages?: MwPage[] } };
type WdEntities = {
  entities?: Record<string, { missing?: string; sitelinks?: Record<string, { title: string }>; labels?: Record<string, { value: string }> }>;
};

export async function resolveTopic(topic: string, fromLang: string, langs: string[]): Promise<Resolution> {
  const empty: Resolution = {
    input: topic,
    status: "not_found",
    matchedBy: null,
    qid: null,
    label: null,
    articles: Object.fromEntries(langs.map((l) => [l, null])),
    alternatives: [],
  };

  let qid: string | null = null;
  let matchedBy: Resolution["matchedBy"] = null;
  let alternatives: Candidate[] = [];

  if (/^Q\d+$/.test(topic)) {
    qid = topic;
    matchedBy = "qid";
  } else {
    const props = { prop: "pageprops|description", ppprop: "wikibase_item|disambiguation" };
    // 1) exact title (following redirects)
    const exact = await mw<MwQuery>(fromLang, { action: "query", titles: topic, redirects: "1", ...props });
    const page = exact.query?.pages?.[0];
    const isDisambig = page?.pageprops?.disambiguation !== undefined;
    if (page && !page.missing && !isDisambig && page.pageprops?.wikibase_item) {
      qid = page.pageprops.wikibase_item;
      matchedBy = "exact_title";
    }
    // 2) full-text search: fallback + alternatives to show the user
    const search = await mw<MwQuery>(fromLang, { action: "query", generator: "search", gsrsearch: topic, gsrlimit: "6", gsrnamespace: "0", ...props });
    const hits = (search.query?.pages ?? [])
      .filter((p) => p.pageprops?.disambiguation === undefined)
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .map<Candidate>((p) => ({ title: p.title, qid: p.pageprops?.wikibase_item ?? null, ...(p.description ? { description: p.description } : {}) }));

    if (qid === null) {
      if (isDisambig && hits.length) return { ...empty, status: "ambiguous", alternatives: hits.slice(0, 5) };
      const first = hits.find((h) => h.qid !== null);
      if (!first) return { ...empty, alternatives: hits.slice(0, 5) };
      qid = first.qid;
      matchedBy = "search";
    }
    alternatives = hits.filter((h) => h.qid !== qid).slice(0, 4);
  }

  const wd = await wikidata<WdEntities>({
    action: "wbgetentities",
    ids: qid!,
    props: "sitelinks|labels",
    languages: Array.from(new Set(["en", fromLang])).join("|"),
  });
  const entity = wd.entities?.[qid!];
  if (!entity || entity.missing !== undefined) return { ...empty, alternatives };

  return {
    input: topic,
    status: "ok",
    matchedBy,
    qid,
    label: entity.labels?.[fromLang]?.value ?? entity.labels?.en?.value ?? null,
    articles: Object.fromEntries(langs.map((l) => [l, entity.sitelinks?.[siteFor(l)]?.title ?? null])),
    alternatives,
  };
}

/** Search one language edition directly: used to suggest articles when Wikidata has no sitelink. */
export async function searchEdition(lang: string, query: string, limit = 3): Promise<Candidate[]> {
  const res = await mw<MwQuery>(lang, {
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(limit + 2),
    gsrnamespace: "0",
    prop: "pageprops|description",
    ppprop: "wikibase_item|disambiguation",
  });
  return (res.query?.pages ?? [])
    .filter((p) => p.pageprops?.disambiguation === undefined)
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
    .slice(0, limit)
    .map((p) => ({ title: p.title, qid: p.pageprops?.wikibase_item ?? null, ...(p.description ? { description: p.description } : {}) }));
}
