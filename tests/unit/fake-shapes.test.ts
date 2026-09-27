// The fake Wikimedia API answers in the shapes of the real one (spec 12). Every response recorded from the real APIs
// by tests/live/record-fixtures.ts is replayed against the fake (same URL), and the two bodies must have the same
// key/type skeleton; values and array lengths are ignored. When this fails after re-recording, update tests/fake/fetch.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeFetch } from "../fake/fetch.ts";
import { demoWorld } from "../fake/world.ts";

const DIR = join(import.meta.dirname, "../fake/recorded");
const ROUTES = ["exact-title", "search", "redirects", "wbgetentities", "per-article", "per-article-404", "aggregate"];

interface Recorded {
  route: string;
  url: string;
  status: number;
  body: unknown;
}

type Skeleton = string | Skeleton[] | { [key: string]: Skeleton };

/** Objects keyed by data (QIDs, sites, languages), not by field names: their values are merged like array elements. */
const MAPS = new Set(["entities", "labels", "sitelinks"]);
/**
 * Keys whose presence depends on the data, not the format: `continue` (more search hits than the limit),
 * `disambiguation` (the page is a disambiguation page). Compared only when both sides have them.
 */
const DATA_DEPENDENT = new Set(["continue", "disambiguation"]);

function skeleton(v: unknown): Skeleton {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [v.map(skeleton).reduce(merge)] : [];
  if (typeof v !== "object") return typeof v;
  const entries = Object.entries(v as Record<string, unknown>).map(([k, x]): [string, Skeleton] => {
    if (!MAPS.has(k) || !x || typeof x !== "object") return [k, skeleton(x)];
    const values = Object.values(x).map(skeleton);
    return [k, values.length ? { "*": values.reduce(merge) } : {}];
  });
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/** Union of two skeletons: keys of both objects, element skeletons of both arrays, `a|b` for differing types. */
function merge(a: Skeleton, b: Skeleton): Skeleton {
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [merge(a[0]!, b[0]!)] : a.length ? a : b;
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return Object.fromEntries(keys.map((k) => [k, a[k] === undefined ? b[k]! : b[k] === undefined ? a[k] : merge(a[k], b[k])]));
  }
  if (a === b) return a;
  return [...new Set(`${JSON.stringify(a)}|${JSON.stringify(b)}`.split("|"))].sort().join("|");
}

/**
 * Makes the two skeletons comparable where they differ only by data: drops a data-dependent key present on one side
 * only, and treats an empty array as matching any array (its element type is unknown).
 */
function alignDataDependent(real: Skeleton, fake: Skeleton): void {
  if (Array.isArray(real) && Array.isArray(fake)) {
    if (real.length && fake.length) alignDataDependent(real[0]!, fake[0]!);
    else real.length = fake.length = 0;
    return;
  }
  if (typeof real !== "object" || typeof fake !== "object" || Array.isArray(real) || Array.isArray(fake)) return;
  for (const k of new Set([...Object.keys(real), ...Object.keys(fake)])) {
    if (real[k] !== undefined && fake[k] !== undefined) alignDataDependent(real[k], fake[k]);
    else if (DATA_DEPENDENT.has(k)) {
      delete real[k];
      delete fake[k];
    }
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const recorded = files.map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Recorded);

describe("skeleton", () => {
  it("ignores values and array lengths, merges map values", () => {
    const a = skeleton({ items: [{ views: 1 }, { views: 2 }], sitelinks: { cswiki: { title: "A" }, plwiki: { title: "B" } } });
    const b = skeleton({ items: [{ views: 9 }], sitelinks: { enwiki: { title: "C" } } });
    expect(a).toEqual(b);
  });

  it("sees a renamed key and a changed type", () => {
    expect(skeleton({ pages: [{ pageprops: {} }] })).not.toEqual(skeleton({ pages: [{ props: {} }] }));
    expect(skeleton({ views: 1 })).not.toEqual(skeleton({ views: "1" }));
  });

  it("aligns data-dependent differences only", () => {
    const pair = (real: unknown, fake: unknown) => {
      const [r, f] = [skeleton(real), skeleton(fake)];
      alignDataDependent(r, f);
      return [r, f];
    };
    const [r1, f1] = pair({ continue: { gsroffset: 6 }, badges: ["x"], pp: { disambiguation: "" } }, { badges: [], pp: {} });
    expect(f1).toEqual(r1);
    const [r2, f2] = pair({ status: 404, title: "t" }, { title: "t" });
    expect(f2).not.toEqual(r2);
  });
});

describe("fake API vs recorded real responses", () => {
  it("every route is recorded", () => {
    expect(recorded.map((r) => r.route).sort()).toEqual([...ROUTES].sort());
  });

  it.each(recorded.map((r) => [r.route, r] as const))("%s: same status and key structure", async (_route, r) => {
    const fake = createFakeFetch(demoWorld());
    const res = await fake(r.url);
    expect(fake.unknown).toEqual([]);
    expect(res.status).toBe(r.status);
    const real = skeleton(r.body);
    const got = skeleton(await res.json());
    alignDataDependent(real, got);
    expect(got).toEqual(real);
  });
});
