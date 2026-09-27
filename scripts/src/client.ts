import { apiEnd, apiStart, monthFromTimestamp, monthRange, type Month } from "./dates.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

const REST = "https://wikimedia.org/api/rest_v1/metrics/pageviews";

/** Wikimedia requires a descriptive User-Agent with contact info. */
function userAgent(): string {
  const contact = process.env.WT_CONTACT ?? "contact not set; set WT_CONTACT env var";
  return `wiki-trends-skill/0.3 (${contact})`;
}

/** Wikipedia language code -> Wikidata sitelink key ('uk' -> 'ukwiki'). */
export function siteFor(lang: string): string {
  if (lang === "be-tarask") return "be_x_oldwiki";
  return `${lang.replace(/-/g, "_")}wiki`;
}

function encodeTitle(title: string): string {
  return encodeURIComponent(title.replace(/ /g, "_"));
}

/**
 * GET JSON. Returns null on 404 (the Pageviews API uses 404 for "no data").
 * Retries a few times on 429/5xx/network errors; no caching.
 */
async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const res = await fetch(url, { headers: { "User-Agent": userAgent(), "Api-User-Agent": userAgent(), Accept: "application/json" } });
      status = res.status;
      if (status === 200) return (await res.json()) as T;
      if (status === 404) return null;
      if (status !== 429 && status < 500) {
        const body = await res.text().catch(() => "");
        throw new ApiError(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`, status, url);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (attempt >= 3) throw new ApiError(`Network error for ${url}: ${(err as Error).message}`, 0, url);
    }
    if (attempt >= 3) throw new ApiError(`HTTP ${status} after ${attempt + 1} attempts for ${url}`, status, url);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

type ViewItems = { items: Array<{ timestamp: string; views: number }> };

/** Every month of from..to, zero-filled for months the API omits. */
function fillMonths(items: ViewItems["items"], from: Month, to: Month): Map<Month, number> {
  const out = new Map<Month, number>(monthRange(from, to).map((m) => [m, 0]));
  for (const it of items) {
    const m = monthFromTimestamp(it.timestamp);
    if (out.has(m)) out.set(m, out.get(m)! + it.views);
  }
  return out;
}

/** Monthly user pageviews of one article, zero-filled for months the API omits. Null = no data. */
export async function articleMonthly(lang: string, title: string, from: Month, to: Month): Promise<Map<Month, number> | null> {
  const url = `${REST}/per-article/${lang}.wikipedia/all-access/user/${encodeTitle(title)}/monthly/${apiStart(from)}/${apiEnd(to)}`;
  const data = await getJson<ViewItems>(url);
  return data === null ? null : fillMonths(data.items, from, to);
}

/** Monthly user pageviews of a whole language edition (normalisation base), zero-filled. */
export async function editionMonthly(lang: string, from: Month, to: Month): Promise<Map<Month, number>> {
  const url = `${REST}/aggregate/${lang}.wikipedia/all-access/user/monthly/${apiStart(from)}/${apiEnd(to)}`;
  const data = await getJson<ViewItems>(url);
  // normalisation is impossible without the base
  if (data === null) throw new ApiError(`No aggregate data for ${lang}.wikipedia`, 404, url);
  return fillMonths(data.items, from, to);
}

/** MediaWiki Action API on a language edition. */
export async function mw<T>(lang: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const url = `https://${lang}.wikipedia.org/w/api.php?${qs.toString()}`;
  const data = await getJson<T>(url);
  if (data === null) throw new ApiError(`Unknown wiki "${lang}"`, 404, url);
  return data;
}

export async function wikidata<T>(params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const url = `https://www.wikidata.org/w/api.php?${qs.toString()}`;
  const data = await getJson<T>(url);
  if (data === null) throw new ApiError("Wikidata request failed", 404, url);
  return data;
}
