# 13 — Task evals: the agent on a cheap model, end to end

## Why
Tests prove the CLI is right. They cannot prove that **an agent using the skill** gives the user a right answer. Everything below was observed in real Haiku runs of an earlier version, and none of it was visible to unit tests:
- 8 tool calls instead of 1 (the empty-output symlink bug);
- invented ratios computed from raw views ("2.3× more");
- "views per million **residents**";
- a one-line chat reply when a PDF was produced, without caveats or the file path.

A task eval runs the real agent (Claude Code, `claude -p`) with the skill installed on a fixed set of scenarios against the synthetic world, and grades the transcript automatically.

## Scope
- **In:** scenario format, runner, deterministic graders, number-hallucination checker, optional LLM judge, repeated runs, baselines, results storage.
- **Out:** skill triggering (14).

## Layout

```
evals/
├── scenarios.json
├── run.ts                # runner
├── graders/
│   ├── numbers.ts        # extractNumbers(), checkNumbers()
│   ├── deterministic.ts  # command / mentions / files / noOwnCode checks
│   └── judge.ts          # optional LLM-as-judge with a rubric
└── results/<timestamp>/  # per-scenario transcripts, answers, outputs + summary.json
```

## Scenario format (`evals/scenarios.json`)

```jsonc
{
  "id": "fasting-pl-cs",
  "split": "dev",                   // "dev" | "holdout" — holdout is never looked at while editing SKILL.md
  "prompt": "Порівняй зростання інтересу до інтервального голодування в польськомовній та чеськомовній Wikipedia за останні два роки.",
  "followUp": null,                 // optional second user turn (run with --resume)
  "expect": {
    "commands": ["analyze", "Intermittent fasting", "--langs[ =]\"?[a-z,]*cs"], // regexes over the scripts/wt commands
    "maxWtCalls": 2,
    "mentions": ["pl|польськ|польщ", "Głodówka|найближч|suggest|немає статті"], // regexes, case-insensitive
    "report": false,
    "caveat": true,
    "rubric": ["Says Polish Wikipedia has no linked article and offers the suggested articles instead of silently picking one."]
  }
}
```

Minimum set (Ukrainian prompts, like real users; at least 2 marked `holdout`):

| id | Prompt idea | Key expectations |
|---|---|---|
| `fasting-pl-cs` | brief example 1 | pl no article → suggestions offered; cs result; caveat |
| `fasting-article-followup` | same, follow-up "так, візьми Głodówka lecznicza" | second call uses `--article pl=`; spike mentioned (after 04) |
| `astronomy-trust` | brief example 2 | confidence + reasons; share/normalization explained (after 01/06) |
| `english-report` | brief example 3 with 6 languages + report | PDF delivered; ro low confidence named; ranking with weights (after 07) |
| `ambiguous-mercury` | "інтерес до теми Mercury в uk" | asks planet vs element; no analysis before the answer |
| `missing-language` | astronomy uk + hu | hu without article mentioned |
| `followup-add-lang` | astronomy uk, then "додай польську і зроби PDF англійською" | second call with pl and `--report-lang en` |
| `custom-weights` | "для нас важливіше зростання, ніж розмір аудиторії" | `--weights` with growth > volume (after 07) |

## Runner (`evals/run.ts`)
Usage: `node evals/run.ts [--model haiku] [--runs 3] [--only id,id] [--split dev|holdout|all] [--judge] [--baseline] [--live]`.

For every scenario × run:
1. **Workspace outside the repo.** Create `mkdtemp(os.tmpdir())` and symlink the repo into `<ws>/.claude/skills/<skill-name>`. Never put the workspace inside the repo: a symlink to the skill inside the skill loops for Glob/Grep.
2. **Environment:** `WT_FAKE_API=1` (unless `--live`), `WT_OUT_DIR` or `--out-dir` pointing into the workspace, and `WT_CONTACT` from the caller's env.
3. **Run:**

   ```
   claude -p "<prompt>" --model <model> --output-format stream-json --verbose --allowedTools "Bash Read Glob Grep Skill"
   ```

   - spawn with `stdio: ["ignore", "pipe", "pipe"]` (otherwise the CLI waits for stdin);
   - for `followUp`, run again with `--resume <session_id>` from the first run's events.
4. **Parse the stream-json events:**
   - `session_id`;
   - every `tool_use` (name + input), in particular Bash commands containing `scripts/wt`;
   - **all** assistant `text` blocks, joined — the `result` event holds only the **last** block, and agents often write the answer before a final tool call;
   - files delivered through any tool whose name matches `/send.*file/i` (append `[file sent: <paths>]` to the answer so "PDF path given" passes when the file was delivered as an attachment);
   - `num_turns`, `total_cost_usd`, `duration_ms` from the `result` event.
5. **Grade** (below) and write `<results>/<id>/run-<n>/`: `transcript-<turn>.jsonl`, `answer.md`, the out-dir contents, `grades.json`.
6. Print a table and write `summary.json`.

`--baseline` runs the same scenarios in a workspace **without** the skill, to show what the skill adds. Expect low scores there; report them next to the main run.

## Graders

### Deterministic (`graders/deterministic.ts`)
Each returns `true` or a failure string:
- `command`: every regex in `expect.commands` matches at least one `scripts/wt` command.
- `wtCalls`: number of `scripts/wt` calls ≤ `maxWtCalls` (default 1 per user turn).
- `mentions`: every regex in `expect.mentions` matches the answer.
- `report`: a `.pdf` exists in the scenario's out-dir, **and** the answer contains `.pdf` or a file was sent.
- `caveat`: the answer contains an interest-≠-willingness-to-pay caveat. Match broadly (`готовн|купівел|спроможн|потреб|не означає|не дорівнює|≠|willingness|not .*pay`); regexes that are too literal produced false failures in practice.
- `noOwnCode`: no Bash command matches `python|node -e|curl|wget|wikimedia\.org|wikipedia\.org/w/api` (the agent must not bypass the CLI).

### Numbers (`graders/numbers.ts`)
**Every number in the answer must be traceable to the analysis JSON or the user's prompt.** This single grader catches both hallucination and the agent doing its own arithmetic.

- `extractNumbers(text)`:
  - first scrub: URLs, file paths (only tokens starting with `/`, `./`, `~/`, or ending in `.pdf|.svg|.png|.json|.md`; not every token containing `/`, because `%/yr` must survive), run ids, QIDs, `YYYY-MM(-DD)`, bare years 1900–2099, CLI flags;
  - handle `+39,6%`, `5 712`, `5,712`, `0,001` (decimal comma), `5,7 тис.` / `5.7k` / `млн` multipliers, and the Unicode minus `−`;
  - return `{ raw, value, percent, scaled }`.
- `collectAllowed(json)`:
  - every number in every `data.json` of the scenario, excluding the `monthly` arrays (the agent never saw them);
  - numbers inside strings (`findings`, `reasons`, `caveats`);
  - numbers from the prompt(s).
- A number is supported if it matches an allowed value:
  - exactly;
  - within 0.051 (rounded to 1 decimal);
  - within 0.5 when the answer's value is an integer;
  - within 5% when scaled (`тис.`);
  - within 2% when it is a round hundred ("about 9000" for 9011);
  - or as a 0–1 score quoted ×100.
- Ignore bare integers ≤ 12 without `%` (counts, list numbering, "2 роки").
- Unit-test the grader itself (`tests/unit/numbers.test.ts`): Ukrainian and English formats, scrubbing, and the tolerance rules.

### LLM judge (`graders/judge.ts`, optional `--judge`)
For `expect.rubric` items only: things that are about meaning, not strings. Run `claude -p` with a stronger model (default `sonnet`, flag `--judge-model`) and `--output-format json`, passing:
- the user prompt(s);
- the answer;
- the compact analysis JSON (no `monthly`);
- the rubric items.

Ask for strict JSON: `[{ "item": "...", "pass": true|false, "reason": "..." }]`.

Rules:
- the judge never sees the grader's other results;
- temperature is left default, but results are cached per (answer hash, rubric) so re-grading is free;
- a judge failure (bad JSON) counts as "unknown", not "fail".

## Reporting (`summary.json` + console)
Per scenario, aggregated over `--runs`:
- pass rate (all checks) and per-check pass rates;
- mean `wtCalls`, tool calls, turns, cost and seconds;
- numbers checked and unsupported numbers (listed).

Overall: pass rate for `dev` and `holdout` separately, total cost, model, data mode (synthetic/live), git commit.

## Best practices baked into the process (document in `evals/README.md`)
1. **Read failing transcripts before changing anything.** In practice several "failures" were grader bugs (last text block only; a too-literal regex). Fix the grader, not the skill, when the answer was right.
2. **Prefer fixing the cause in code over adding SKILL.md rules.** Invented ratios disappeared when the CLI started emitting a ready-made relative-interest finding plus an `answerChecklist`, not when a rule was added.
3. **Holdout scenarios are not looked at while tuning `SKILL.md`.** Run them before merging to catch overfitting.
4. **Always ≥ 3 runs per scenario before drawing conclusions.** The model is non-deterministic.
5. **Every new failure seen in manual use becomes a scenario.**
6. Evals are not in CI by default (cost). Run them on every change to `SKILL.md` or to the stdout JSON, and before releases.

## Verification
- `node evals/run.ts --only astronomy-trust --runs 1` completes, writes results and prints a summary line.
- Copy a stored transcript with a hand-edited answer containing an invented number ("зросло на 52%"): the numbers grader flags `52%`.
- Hand-edit an answer that is written before a final tool call: the answer collector still grades it (regression for "last text block only").
- A full `node evals/run.ts --runs 3` on Haiku: each scenario uses ≤ 1 `scripts/wt` call per user turn; record the pass rate and cost in `evals/README.md`.
