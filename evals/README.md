# Task evals

Tests show the CLI computes the right numbers. They can't show that **an agent using the skill** gives the user a right answer. Task evals run the real agent (Claude Code, `claude -p`) with the skill installed. Each run takes a fixed scenario against the synthetic world (`WT_FAKE_API=1`), and the transcript is graded automatically. Spec: `.specs/13-task-evals.md`.

These evals are not run in CI because they cost money. Run them on every change to `SKILL.md` or to the stdout JSON, and before releases.

## Running

```bash
npm run eval                                        # = node evals/run.ts: all scenarios × 3 runs on Haiku
node evals/run.ts --only astronomy-trust --runs 1   # one scenario, one run (~$0.03)
node evals/run.ts --split dev                       # while tuning SKILL.md: never look at holdout
node evals/run.ts --baseline                        # also run every scenario without the skill
node evals/run.ts --judge                           # + LLM judge on the rubric items (Sonnet)
node evals/run.ts --regrade evals/results/<stamp>   # re-grade stored transcripts: free, no agent runs
```

| Flag | Default | |
|---|---|---|
| `--model` | `haiku` | the agent's model |
| `--runs` | `3` | runs per scenario |
| `--only id,id` | all | scenario ids |
| `--split` | `all` | `dev`, `holdout` or `all` |
| `--judge` / `--judge-model` | off / `sonnet` | LLM judge for `expect.rubric`; verdicts cached in `evals/.cache/judge/` |
| `--baseline` | off | the same scenarios in a workspace without the skill |
| `--live` | off | real Wikimedia APIs instead of the synthetic world (set `WT_CONTACT`) |
| `--concurrency` | `3` | parallel agent runs |
| `--timeout` | `600` | seconds per user turn |
| `--regrade DIR` | | grade the transcripts stored in `DIR` again with the current graders and `scenarios.json` |

Requires `claude` on `PATH` (or `CLAUDE_BIN`), logged in.

### What one run does
1. It creates a workspace in `os.tmpdir()` and symlinks the repo into `<ws>/.claude/skills/wiki-trends`. The workspace is never inside the repo, because a symlink to the skill inside the skill makes Glob/Grep loop.
2. It sets `WT_FAKE_API=1` (unless `--live`) and `WT_OUT_DIR=<ws>/out`. The CLI uses `WT_OUT_DIR` when the agent gives no `--out-dir`, so every run's files are separate. `WT_CONTACT` is passed through.
3. For each user turn it runs `claude -p "<prompt>" --model <model> --output-format stream-json --verbose --allowedTools "Bash Read Glob Grep Skill" --setting-sources project,local --strict-mcp-config`. A follow-up turn adds `--resume <session_id>`. User-level settings, hooks, skills and MCP servers are left out, so runs are comparable across machines.
4. It copies the transcripts and the out-dir into `results/`, grades them, and deletes the workspace and its Claude Code session.

### Results

```
evals/results/<stamp>/
├── summary.json                  # per scenario: pass rate, per-check rates, means, unsupported numbers; overall per split
└── <scenario>/run-<n>/           # (baseline-run-<n>/ for --baseline)
    ├── transcript-<turn>.jsonl   # raw stream-json events, one file per user turn
    ├── stderr-<turn>.txt         # only if the CLI wrote to stderr
    ├── answer.md                 # all assistant text of all turns (what was graded)
    ├── out/                      # data.json, chart.png/svg, report PDF
    └── grades.json               # every check, numbers, judge verdicts, stats
```

## Scenarios (`scenarios.json`)

```jsonc
{
  "id": "fasting-pl-cs",
  "split": "dev",                 // "dev" | "holdout": holdout is never looked at while editing SKILL.md
  "prompt": "Порівняй зростання інтересу до …",
  "followUp": null,               // optional second user turn (run with --resume)
  "expect": {
    "commands": ["analyze", "Intermittent fasting", "--langs[ =]\"?[a-z,]*cs"], // regexes over the scripts/wt commands
    "maxWtCalls": 2,              // default: 1 per user turn
    "mentions": ["\\bpl\\b|польськ"], // regexes over the answer, case-insensitive
    "report": false,              // true: a PDF must be produced and linked or sent
    "caveat": true,               // true: the interest ≠ willingness-to-pay caveat
    "rubric": ["Says Polish Wikipedia has no linked article and offers the suggestions."] // for --judge
  }
}
```

`tests/unit/eval-graders.test.ts` checks that every scenario's `commands` regexes accept the commands `SKILL.md` prescribes for it. When you add a scenario, add its canonical commands there too. Note that `\b` does not work next to Cyrillic in JS regexes; use `(^|[^а-яіїєґ])` instead.

## Graders

Each check is `true` or a failure message. A run passes when every check that applies is `true`.

| Check | Fails when |
|---|---|
| `command` | an `expect.commands` regex matches no `scripts/wt` command |
| `wtCalls` | more `scripts/wt` calls than `maxWtCalls` (default: 1 per user turn) |
| `mentions` | an `expect.mentions` regex does not match the answer |
| `report` | (`expect.report`) no `.pdf` in the out-dir, or the answer neither contains `.pdf` nor sent a file |
| `chart` | (after a successful `analyze`) the answer neither embeds/links `chart.png` nor sent a PNG (SKILL.md step 5) |
| `caveat` | (`expect.caveat`) no interest ≠ willingness-to-pay caveat (broad regex: `готовн\|купівел\|…\|willingness\|not .*pay`) |
| `noOwnCode` | a Bash command matches `python\|node -e\|curl\|wget\|wikimedia\.org\|wikipedia\.org/w/api` |
| `numbers` | a number in the answer cannot be traced to the analysis JSON or the prompts |
| `judge` | (`--judge`) the judge failed a rubric item. Unparsable judge output counts as unknown, not as a failure |
| `completed` | a turn ended without a `success` result (timeout, crash, max turns) |

**The answer** is all assistant `text` blocks of all turns joined. The `result` event holds only the last block, and agents often write the answer before a final tool call. Files delivered through a tool whose name matches `/send.*file/i` are appended as `[file sent: …]`.

**Numbers** (`graders/numbers.ts`, tested in `tests/unit/numbers.test.ts`):
- **Allowed values:** every number the agent could have seen: the stdout JSON of every `scripts/wt` call, every `data.json` in the out-dir (without the `monthly` arrays), numbers inside strings (`findings`, `reasons`, `caveats`), the prompts, and the thresholds that `SKILL.md` itself states (5, 0.1, 1 000 000).
- **Scrubbed from the answer before extraction:** URLs, markdown link targets, paths (tokens starting with `/`, `./`, `~/`), file names, run ids, session ids, QIDs, `YYYY-MM(-DD)`, bare years 1900–2099, and CLI flags with their value.
- **Formats understood:** `+39,6%`, `5 712` (also with no-break or thin spaces), `5,712` (read both as 5712 and 5.712), `0,001`, `5,7 тис.`, `5.7k`, `млн`, and the Unicode minus `−`. Signs are compared by magnitude, because "падіння на 12%" is −12.
- **Supported** if it matches an allowed value in one of these ways:
  - exactly;
  - within 0.051 when written with ≤ 1 decimal;
  - within 0.5 when written as an integer;
  - within 5% when scaled (`тис.`), or within half a unit of its last written digit ("6 тис." for 5 712);
  - within 2% when it is a round hundred;
  - as a 0–1 score quoted ×100.
- **Ignored:** bare integers ≤ 12 without `%` (counts, list numbering, "2 роки").

## Best practices

1. **Read failing transcripts before changing anything.** Several "failures" in practice were grader bugs: grading only the last text block, or a regex that was too literal. When the answer was right, fix the grader, not the skill. Then use `--regrade` to re-grade the stored runs for free.
2. **Prefer fixing the cause in code over adding SKILL.md rules.** Invented ratios disappeared when the CLI started emitting a ready-made relative-interest finding plus an `answerChecklist`, not when a rule was added.
3. **Don't look at holdout scenarios while tuning `SKILL.md`** (use `--split dev`). Run them before merging to catch overfitting.
4. **Always do ≥ 3 runs per scenario before drawing conclusions.** The model is non-deterministic.
5. **Every new failure seen in manual use becomes a scenario.**
6. Evals are not in CI by default (cost). Run them on every change to `SKILL.md` or to the stdout JSON, and before releases.

## Recorded results

### 2026-09-27 · v0.14.0 · Haiku 4.5 · synthetic · 3 runs · `--baseline`, no judge

| Scenario | Split | With skill | Baseline | Failures with the skill |
|---|---|---|---|---|
| fasting-pl-cs | dev | 3/3 | 0/3 | |
| fasting-article-followup | dev | 3/3 | 0/3 | |
| astronomy-trust | dev | 1/3 | 0/3 | "140–165 per million": median 140.72 truncated, not rounded; interest caveat paraphrased as "curiosity, not actual learning" (no willingness to pay) |
| english-report | dev | 2/3 | 0/3 | its own "recommended audiences" instead of `ranking`; weights not stated |
| ambiguous-mercury | dev | 3/3 | 0/3 | |
| missing-language | holdout | 2/3 | 0/3 | caveat paraphrased without willingness to pay |
| followup-add-lang | dev | 3/3 | 0/3 | |
| custom-weights | holdout | 2/3 | 0/3 | "growth matters more" not mapped to `--weights` |

- **Pass rate:** dev 83% (15/18), holdout 67% (4/6); baseline 0% on both.
- **CLI calls:** every run made ≤ 1 `scripts/wt` call per user turn. No run bypassed the CLI, and no run invented a number (the one `numbers` failure is a truncation).
- **Cost:** $1.57 for all 48 runs. With the skill: ≈ $0.03 and 24 s per single-turn scenario, ≈ $0.05 and 35–50 s with a follow-up.
- **Grader fix after reading the transcripts:** english-report accepted only "низьк|low" for low confidence, but one correct answer said "ненадійна" (unreliable). The regex was widened and the runs regraded, which moved dev from 78% to 83%.
- **What to fix next (in the CLI, per best practice 2):** the answer paraphrases the interest ≠ willingness-to-pay caveat until "pay" is lost, and Haiku sometimes replaces `ranking` with its own reasoning.
