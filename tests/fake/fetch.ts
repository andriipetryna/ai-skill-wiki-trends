// A fetch-compatible fake of the Wikimedia APIs the skill calls. Responses reproduce the real shapes
// (see the route table in .specs/09-test-infrastructure.md); the numbers come from a FakeWorld.
import { siteFor } from "../../scripts/src/client.ts";
import { apiStart, FIRST_AVAILABLE_MONTH, monthRange, type Month } from "../../scripts/src/dates.ts";
import type { FakeArticle, FakeEdition, FakeWorld } from "./world.ts";

export interface FakeFetchOptions {
  /** answer the first N requests with `failStatus` (retry tests) */
  failFirst?: number;
  /** status of those failures; default 429 (sent with `retry-after: 0`) */
  failStatus?: number;
}

export type FakeFetch = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
  /** every requested URL, in order (failed ones included) */
  calls: string[];
  /** requested URLs that matched no route; tests should expect this to be empty */
  unknown: string[];
};

const PAGEVIEWS = "/api/rest_v1/metrics/pageviews/";
const NO_DATA =
  "The date(s) you used are valid, but we either do not have data for those date(s), or the project you asked for is not loaded yet. Please check documentation for more information";

export function createFakeFetch(world: FakeWorld, opts: FakeFetchOptions = {}): FakeFetch {
  const calls: string[] = [];
  const unknown: string[] = [];
  const fake = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (calls.length <= (opts.failFirst ?? 0)) {
      const status = opts.failStatus ?? 429;
      return json(status, { error: "fake failure", status }, status === 429 ? { "retry-after": "0" } : {});
    }
    const res = route(world, new URL(url));
    if (res) return res;
    unknown.push(url);
    return json(404, { error: "unknown fake route", url });
  };
  return Object.assign(fake, { calls, unknown });
}

function route(world: FakeWorld, u: URL): Response | null {
  if (u.hostname === "wikimedia.org" && u.pathname.startsWith(PAGEVIEWS)) return pageviews(world, u);
  if (u.pathname !== "/w/api.php" || u.searchParams.get("format") !== "json" || u.searchParams.get("formatversion") !== "2") return null;
  if (u.hostname === "www.wikidata.org") return wikidata(world, u.searchParams);
  const lang = /^([a-z][a-z-]*)\.wikipedia\.org$/.exec(u.hostname)?.[1];
  const edition = lang ? world.editions[lang] : undefined;
  return edition ? actionApi(edition, u.searchParams) : null;
}

// ---- Pageviews REST: per-article and aggregate, monthly, all-access, agent=user

function pageviews(world: FakeWorld, u: URL): Response | null {
  // split before decoding: titles may contain an encoded "/"
  const seg = u.pathname.slice(PAGEVIEWS.length).split("/").map(decodeURIComponent);
  const [kind, project, access, agent] = seg;
  const rest = kind === "per-article" && seg.length === 8 ? seg.slice(4) : kind === "aggregate" && seg.length === 7 ? [undefined, ...seg.slice(4)] : null;
  if (!rest || access !== "all-access" || agent !== "user" || rest[1] !== "monthly") return null;
  const [article, , start, end] = rest;
  const lang = /^([a-z][a-z-]*)\.wikipedia$/.exec(project ?? "")?.[1];
  if (!lang || !start || !end || !/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return null;

  const edition = world.editions[lang];
  const title = article?.replace(/_/g, " ");
  const series = title === undefined ? edition?.views : edition?.articles[title]?.views;
  if (!series) return notFound(u);

  const from = toMonth(start) < FIRST_AVAILABLE_MONTH ? FIRST_AVAILABLE_MONTH : toMonth(start);
  const to = toMonth(end);
  // the real API omits months with 0 views, and answers 404 when nothing is left
  const items = (from <= to ? monthRange(from, to) : [])
    .map((m) => ({ m, views: series(m) }))
    .filter((x) => x.views > 0)
    .map(({ m, views }) => ({
      project: `${lang}.wikipedia`,
      ...(article === undefined ? {} : { article }),
      granularity: "monthly",
      timestamp: `${apiStart(m)}00`,
      access: "all-access",
      agent: "user",
      views,
    }));
  return items.length ? json(200, { items }) : notFound(u);
}

function toMonth(yyyymmdd: string): Month {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}`;
}

function notFound(u: URL): Response {
  const uri = u.pathname.replace("/api/rest_v1", "");
  return json(404, { detail: NO_DATA, method: "get", status: 404, title: "Not Found", type: "about:blank", uri });
}

// ---- MediaWiki Action API: exact title lookup, full-text search, redirects

function actionApi(ed: FakeEdition, q: URLSearchParams): Response | null {
  if (q.get("action") !== "query") return null;
  const titles = Object.keys(ed.articles);
  const pageid = (title: string) => 1000 + titles.indexOf(title);
  const props = (q.get("prop") ?? "").split("|");
  const ppprops = (q.get("ppprop") ?? "").split("|");

  /** a page object with only the requested props, like the real API */
  const page = (title: string, a: FakeArticle, extra: Record<string, unknown> = {}) => {
    const pp: Record<string, string> = {};
    if (props.includes("pageprops")) {
      if (a.disambiguation && ppprops.includes("disambiguation")) pp.disambiguation = "";
      if (a.qid && ppprops.includes("wikibase_item")) pp.wikibase_item = a.qid;
    }
    return {
      pageid: pageid(title),
      ns: 0,
      title,
      ...extra,
      ...(Object.keys(pp).length ? { pageprops: pp } : {}),
      ...(props.includes("description") && a.description ? { description: a.description, descriptionsource: "local" } : {}),
    };
  };

  if (q.get("generator") === "search") {
    const query = (q.get("gsrsearch") ?? "").trim().toLowerCase();
    const limit = Number(q.get("gsrlimit") ?? 10);
    const all = ed.search?.[query] ?? titles.filter((t) => !ed.articles[t]!.redirectTo && t.toLowerCase().includes(query));
    const hits = all.slice(0, limit);
    if (!hits.length) return json(200, { batchcomplete: true });
    const pages = hits.map((t, i) => page(t, ed.articles[t]!, { index: i + 1 }));
    // more hits than the limit: the real API offers the next page (the client never follows it)
    const more = all.length > limit ? { continue: { gsroffset: limit, continue: "gsroffset||" } } : {};
    // the real API does not order `pages` by `index`
    return json(200, { batchcomplete: true, ...more, query: { pages: shuffle(pages) } });
  }

  const requested = (q.get("titles") ?? "").split("|").filter(Boolean);
  if (!requested.length) return null;
  const normalized: Array<{ fromencoded: boolean; from: string; to: string }> = [];
  const redirects: Array<{ from: string; to: string }> = [];
  const pages = requested.map((raw) => {
    let title = normalizeTitle(raw);
    if (title !== raw) normalized.push({ fromencoded: false, from: raw, to: title });
    let a = ed.articles[title];
    if (a?.redirectTo && q.get("redirects") === "1") {
      redirects.push({ from: title, to: a.redirectTo });
      title = a.redirectTo;
      a = ed.articles[title];
    }
    if (!a) return { ns: 0, title, missing: true };

    if (props.includes("redirects")) {
      const limit = Number(q.get("rdlimit") ?? 10);
      const rd = titles.filter((t) => ed.articles[t]!.redirectTo === title).slice(0, limit);
      return { pageid: pageid(title), ns: 0, title, ...(rd.length ? { redirects: rd.map((t) => ({ pageid: pageid(t), ns: 0, title: t })) } : {}) };
    }
    return page(title, a, a.redirectTo ? { redirect: true } : {});
  });
  return json(200, {
    batchcomplete: true,
    query: { ...(normalized.length ? { normalized } : {}), ...(redirects.length ? { redirects } : {}), pages },
  });
}

/** MediaWiki title normalization: underscores → spaces, first letter upper case. */
function normalizeTitle(t: string): string {
  const s = t.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Deterministic permutation that is never the identity for n ≥ 2 (rotate by one). */
function shuffle<T>(xs: T[]): T[] {
  return xs.length < 2 ? xs : [...xs.slice(1), xs[0]!];
}

// ---- Wikidata: wbgetentities (labels, sitelinks)

function wikidata(world: FakeWorld, q: URLSearchParams): Response | null {
  if (q.get("action") !== "wbgetentities") return null;
  const ids = (q.get("ids") ?? "").split("|").filter(Boolean);
  if (!ids.length) return null;
  const props = (q.get("props") ?? "labels|sitelinks").split("|");
  const languages = q.get("languages")?.split("|");

  const entities = Object.fromEntries(
    ids.map((id) => {
      const e = world.entities[id];
      if (!e) return [id, { id, missing: "" }];
      const labels = Object.fromEntries(
        Object.entries(e.labels)
          .filter(([l]) => !languages || languages.includes(l))
          .map(([l, value]) => [l, { language: l, value }]),
      );
      const sitelinks: Record<string, { site: string; title: string; badges: string[] }> = {};
      for (const [lang, ed] of Object.entries(world.editions)) {
        const title = Object.keys(ed.articles).find((t) => ed.articles[t]!.qid === id && !ed.articles[t]!.redirectTo);
        if (title) sitelinks[siteFor(lang)] = { site: siteFor(lang), title, badges: [] };
      }
      return [
        id,
        { type: "item", id, ...(props.includes("labels") ? { labels } : {}), ...(props.includes("sitelinks") ? { sitelinks } : {}) },
      ];
    }),
  );
  return json(200, { entities, success: 1 });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
