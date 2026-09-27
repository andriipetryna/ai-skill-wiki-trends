# 11 — Integration, contract and launcher tests

## Why
Unit tests do not catch the failures that actually hurt the consuming agent:
- a renamed JSON field that `SKILL.md` still refers to (the agent then silently guesses);
- a PDF that spills onto a second page;
- an error that prints a stack trace instead of JSON;
- a CLI that prints **nothing** when started through a symlink. This happened: Node resolves the main module path, the entry guard did not match, and Haiku spent 8 tool calls working around empty output.

These tests run the whole pipeline in-process against the fake API from spec 09.

## Scope
- **In:** the zod output contract, end-to-end CLI tests on the fake world, error paths, output files (JSON, SVG, PNG, PDF), the launcher.
- **Out:** real network (12), agent behaviour (13–14).

## Code changes

### `tests/contract/schema.ts` (new)
A zod schema of the `analyze` stdout JSON (`AnalysisOutputSchema`), plus `ResolveOutputSchema` and `ErrorOutputSchema` (`{ ok: false, error: string, hint?: string, candidates?: Candidate[] }`).
- Describe every field `SKILL.md` mentions. Mark the rest `.passthrough()` so adding fields does not break the contract, but removing or renaming does.
- Keep the schema in the tests (dev dependency), not in the runtime.

### `tests/integration/helpers.ts` (new)
- `setupFake(world = demoWorld(), opts?)`: stubs `fetch`, sets `CLIENT_CONFIG.retryBaseMs = 0`, sets the system time to `2026-09-26T09:00:00Z`, creates a temp out-dir; `afterEach` restores everything.
- `analyze(args)`: calls `runCli(["analyze", ...args, "--out-dir", tmp])`, asserts `code === 0`, parses with `AnalysisOutputSchema` and returns the typed result.
- `pdfPageCount(path)`: counts `/Type /Page` objects not followed by `s` in the PDF bytes (latin1). Alternatively use `pdfinfo` if present, skipping the assertion otherwise.

## Test list

### `tests/integration/examples.test.ts` — the three brief examples
1. **Intermittent fasting, pl vs cs, 2 years:**
   - `query.from = 2024-09`, `query.to = 2026-08`;
   - pl is `no_article` with `suggestions` including `Głodówka lecznicza`;
   - cs is `ok`. After spec 04: cs has a spike in `2025-10`, and its verdict is not `growing` because of it.
   - Re-run with `--article pl="Głodówka lecznicza"`: pl is `ok`; after spec 06 its verdict is `growing`.
2. **Astronomy, uk:**
   - `ok`. After spec 01: `sharePerMillion` is present.
   - After spec 05: share trend 14–22 %/yr while raw views trend is 2–6 %/yr (normalization in action).
3. **Learning English, basket, 6 languages, `--report --report-lang uk`:**
   - cs, de, hu, ro list `English as a second or foreign language` in `missingTopics`;
   - after spec 06: ro confidence is `low`;
   - after spec 07: `ranking[0].lang = "uk"`;
   - `files.report` exists and has exactly 1 page; `chart.svg` and `chart.png` exist and are non-empty.

### `tests/integration/contract.test.ts`
- Every successful `analyze` result in this suite parses with `AnalysisOutputSchema` (the `analyze()` helper already enforces this).
- stdout JSON has **no** `monthly` arrays; `data.json` has them for every `ok` language.
- `resolve` output parses with `ResolveOutputSchema`.
- Every field path mentioned in `SKILL.md` exists in a real output. Parse `SKILL.md` for backticked paths like `metrics.trend.sharePctPerYear` and resolve each against the fasting/English outputs. This catches SKILL.md drifting away from the code.
- After spec 08: every number in `findings` appears in `perLanguage` or `ranking` (use the extractor from spec 13).

### `tests/integration/errors.test.ts`
All of these return `ErrorOutputSchema` JSON, not a thrown exception:
- `--topic Mercury` → exit 2, two `candidates` with QIDs `Q308`, `Q925`.
- `--langs "UA!"`, missing `--topic`, missing `--langs`, `--years 0`, `--from 2026-05 --to 2026-01`, unknown command → exit 2.
- Fake world with `failFirst: 2` → succeeds; the fake saw exactly 2 extra requests (retries work).
- Fake returns 500 for every request → exit 1 with a `hint`.
- An unknown fake route (unexpected URL) → the test fails and prints the URL (guards against silently hitting new endpoints).

### `tests/integration/report.test.ts`
- `--report-lang en` and `uk` for the same run → both 1 page; the set of numbers in the table is identical. Extract text with a simple PDF text scan, or compare the `data.json` the report was built from.
- A run with 10 languages → still 1 page (overflow is truncated, not paged).
- `--notes` with 2,000 characters → still 1 page (notes truncated).
- After spec 09's synthetic mode: the SYNTHETIC caveat appears in the PDF text.

### `tests/integration/launcher.test.ts`
Runs the real entry point the way agents run it:
1. Create a temp dir, symlink the repo root into it as `skills/wiki-trends`.
2. `execFileSync("<link>/scripts/wt", ["analyze", "--topic", "Astronomy", "--langs", "uk", "--out-dir", tmp], { env: { ...process.env, WT_FAKE_API: "1" } })`.
3. Assert stdout is **exactly one line of valid JSON** with `ok: true`, the first caveat is SYNTHETIC, and stderr contains no stack trace.

Name it `regression: CLI prints nothing when started through a symlink`.

## Verification
- `npm run test:integration` passes in < 30 s, fully offline (disconnect the network to confirm).
- Temporarily rename one field that `SKILL.md` mentions (e.g. `sharePerMillion` → `share`) and confirm the contract test names the missing path; then revert.
- Temporarily remove the `realpathSync` from the entry guard and confirm the launcher test fails; then revert.
