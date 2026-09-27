# 12 — Live smoke tests and fixture recording

## Why
The fake API proves the code is right for the responses we *think* the APIs return. Only the real API proves that assumption, and that it still holds. Real-world surprises this skill has already met:
- Wikidata has **no Polish sitelink** for "Intermittent fasting";
- search results come back unsorted;
- 404 is used for "no data".

Live tests are few, slow and run manually or weekly, never on every commit.

## Scope
- **In:** a handful of live assertions, a fixture recorder that refreshes the fake world's response shapes from reality.
- **Out:** asserting exact view counts (they change).

## Code changes

### `tests/live/smoke.test.ts`
Skipped unless `WT_LIVE=1`; requires `WT_CONTACT`. No fetch stubbing; real `runCli` with a temp `--out-dir`.

Assert **stable facts**, not numbers:
1. `resolve --topic Astronomy --langs uk,pl` → QID `Q333`, uk title `Астрономія`, pl title present.
2. `resolve --topic Mercury --langs en` → an ambiguous result (disambiguation page).
3. `analyze --topic "Intermittent fasting" --langs pl,cs --years 2`:
   - `ok: true`, cs is `ok` with `totalViews > 0`;
   - pl is either `no_article` with non-empty `suggestions` or `ok`. If Wikidata gains the sitelink one day, the test must not fail, but it logs the change.
4. The same `analyze` with `--report` → 1-page PDF and non-empty PNG.
5. A non-existent article via `--article pl="Zzzz nonexistent 12345"` → pl is `no_data` or `no_article`, not an error.
6. After spec 01: `metrics.sharePerMillion.last12Avg` is between 0.01 and 10,000 for every ok language (sanity range).

Keep the total under ~40 HTTP requests.

### `tests/live/record-fixtures.ts` (script, not a test)
`WT_CONTACT=… node tests/live/record-fixtures.ts` fetches one real response of each route type from the table in spec 09 and saves it to `tests/fake/recorded/<route>.json`:
- the exact-title query;
- search;
- redirects;
- wbgetentities;
- per-article (existing and 404);
- aggregate.

### `tests/unit/fake-shapes.test.ts`
For every recorded file, request the same kind of URL from `createFakeFetch(demoWorld())` and assert the fake's JSON has the **same key structure** (compare a recursive key/type skeleton, ignore values and array lengths). When Wikimedia changes a format, re-recording makes this test fail until the fake is updated.

## CLAUDE.md
Add under Testing: "Run `npm run test:live` before a release and after touching `client.ts` or `resolve.ts`; re-record fixtures when it fails on shape."

## Verification
- `WT_CONTACT=you@example.com npm run test:live` passes on a machine with network access.
- `npm test` (without `WT_LIVE`) reports the live project as skipped, not failed.
- Edit one recorded fixture (rename `pageprops` → `props`) and confirm `fake-shapes.test.ts` fails; then revert.
