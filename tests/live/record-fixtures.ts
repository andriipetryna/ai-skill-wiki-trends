// Records one real response of each Wikimedia route the client uses (spec 12) into tests/fake/recorded/<route>.json.
// tests/unit/fake-shapes.test.ts replays each recorded URL against the fake API and compares the key structure,
// so re-recording after a format change makes that test fail until tests/fake/fetch.ts is updated.
//
//   WT_CONTACT=you@example.com node tests/live/record-fixtures.ts
//
// The requests go through the real client functions (a pass-through fetch only captures the responses), so the
// recorded URLs are exactly what the CLI sends. Every title and QID used here exists both on Wikipedia and in
// demoWorld(); keep it that way, or the fake cannot answer the replayed URL.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { articleMonthly, editionMonthly, redirects } from "../../scripts/src/client.ts";
import { resolveTopic } from "../../scripts/src/resolve.ts";

type Route = "exact-title" | "search" | "redirects" | "wbgetentities" | "per-article" | "per-article-404" | "aggregate";

interface Recorded {
  route: Route;
  recordedAt: string;
  url: string;
  status: number;
  body: unknown;
}

const OUT_DIR = join(import.meta.dirname, "../fake/recorded");

function routeOf(url: URL, status: number): Route | null {
  if (url.pathname.includes("/pageviews/per-article/")) return status === 404 ? "per-article-404" : "per-article";
  if (url.pathname.includes("/pageviews/aggregate/")) return "aggregate";
  if (url.hostname === "www.wikidata.org") return url.searchParams.get("action") === "wbgetentities" ? "wbgetentities" : null;
  if (url.searchParams.get("generator") === "search") return "search";
  if (url.searchParams.get("prop") === "redirects") return "redirects";
  if (url.searchParams.has("titles")) return "exact-title";
  return null;
}

async function main(): Promise<void> {
  if (!process.env.WT_CONTACT) {
    process.stderr.write("WT_CONTACT is required (your email or URL for the Wikimedia User-Agent)\n");
    process.exitCode = 2;
    return;
  }

  const recorded = new Map<Route, Recorded>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await realFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const route = routeOf(url, res.status);
    if (route && !recorded.has(route) && (res.status === 200 || res.status === 404)) {
      const body: unknown = await res.clone().json();
      recorded.set(route, { route, recordedAt: new Date().toISOString(), url: url.href, status: res.status, body });
    }
    return res;
  };

  // exact-title, search, wbgetentities
  await resolveTopic("Astronomy", "en", ["uk", "pl"]);
  // has redirects (under the cap of 25, so no continuation) both on uk.wikipedia and in demoWorld()
  await redirects("uk", "Англійська мова");
  await articleMonthly("cs", "Přerušovaný půst", "2024-01", "2024-12");
  await articleMonthly("pl", "Zzzz nonexistent 12345", "2024-01", "2024-12");
  await editionMonthly("cs", "2024-01", "2024-12");
  globalThis.fetch = realFetch;

  mkdirSync(OUT_DIR, { recursive: true });
  for (const r of recorded.values()) {
    const path = join(OUT_DIR, `${r.route}.json`);
    writeFileSync(path, JSON.stringify(r, null, 1) + "\n");
    process.stderr.write(`recorded ${r.route} (HTTP ${r.status}) -> ${path}\n`);
  }
  const all: Route[] = ["exact-title", "search", "redirects", "wbgetentities", "per-article", "per-article-404", "aggregate"];
  const missing = all.filter((r) => !recorded.has(r));
  if (missing.length) {
    process.stderr.write(`not recorded: ${missing.join(", ")}\n`);
    process.exitCode = 1;
  }
}

await main();
