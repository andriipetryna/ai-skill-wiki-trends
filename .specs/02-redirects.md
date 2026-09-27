# 02 — Pageviews of redirects

## Why
When an article is renamed, the old title becomes a redirect. Some readers (external links, bookmarks, search engines) keep arriving through the old title, and those views are counted **on the redirect**, not on the article. The article's series then shows an artificial drop and the trend comes out wrong. This is data quality rather than a metric, but without it the metrics lie.

## Scope
- **In:**
  - fetching the list of redirects;
  - summing their views into the article;
  - a flag to turn it off;
  - a note in the JSON and the report.
- **Out:** analysing individual redirects.

## Code changes

### `scripts/src/client.ts`

```ts
/** Titles in namespace 0 that redirect to `title`, capped. */
export async function redirects(lang: string, title: string, cap = 25): Promise<string[]>
```

- Request via the existing `mw()` (MediaWiki Action API): `action=query&titles={title}&prop=redirects&rdnamespace=0&rdlimit={cap}`.
- Response (formatversion=2): `query.pages[0].redirects: [{ ns: 0, title }]`, or the field is missing.
- The cap of 25 titles per article bounds the number of pageview requests. The rest (rare redirects with negligible traffic) is dropped.

### `scripts/src/collect.ts`
- `CollectParams.redirects: boolean` (default `true`).
- Per language:
  - `titles` = the articles;
  - if `redirects` is on, add each article's redirects (deduplicated with a `Set`);
  - views of **all** titles are summed per month;
  - manual `--article` titles get their redirects too.
- `LanguageResult.redirectsIncluded: number` — how many redirect titles were added.
- A failure to fetch redirects for one article must not fail the analysis: log to stderr and continue without that article's redirects.

### `scripts/src/cli.ts`
- `--no-redirects` flag: `parseArgs` with `allowNegative: true` and option `redirects: { type: "boolean", default: true }`.
- `query.redirects: boolean` in the output JSON.
- Add the flag to `--help`.

### `scripts/src/report.ts`
One caveat depending on the flag:
- **On.** en: "Views of redirects (alternative titles, up to 25 per article) are included." uk: "Враховано перегляди перенаправлень (альтернативних назв, до 25 на статтю)."
- **Off.** en: "Redirect views are excluded; renamed articles may show artificial drops." uk: "Перенаправлення не враховано; перейменовані статті можуть показувати штучне падіння."

Pass the flag to the report through `ReportInput.redirects: boolean`.

## Output

```jsonc
{ "lang": "pl", "articles": ["Głodówka lecznicza"], "redirectsIncluded": 3, ... }
```

## SKILL.md
Nothing required. Optionally one line in the flags section: "`--no-redirects` excludes views of alternative titles (rarely needed)."

## Edge cases
- A redirect for which pageviews returns 404: it contributes zeros (existing `articleMonthly` → `null` logic).
- The same redirect points to two articles of a basket: counted once thanks to deduplication.
- A redirect equals the title of another basket topic's article: also deduplicated.

## Verification
1. Real run: `scripts/wt analyze --topic "Astronomy" --langs en --years 1` → `perLanguage[0].redirectsIncluded` > 0 (the en article Astronomy has redirects).
2. Same run with `--no-redirects` → `redirectsIncluded` = 0, `query.redirects` = false, and `totalViews` is not larger than in run 1.
3. `npm run typecheck`.
