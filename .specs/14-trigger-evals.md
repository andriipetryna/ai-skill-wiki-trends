# 14 — Triggering evals: does the agent pick the skill at the right time?

## Why
Before the agent reads `SKILL.md`, it only sees the skill's `name` and `description` from the frontmatter, and decides from those whether to use the skill. A perfect CLI is useless if the description never triggers. A description that triggers on everything is noise. This is tested separately from task quality (13), because the fix is different: you edit the `description`, not the code.

## Scope
- **In:** a labelled set of prompts, a runner that detects whether the skill was used, precision/recall reporting.
- **Out:** answer quality (13).

## Code changes

### `evals/trigger-prompts.json` (new)

```jsonc
[
  { "id": "t-pos-01", "shouldTrigger": true,  "split": "dev", "prompt": "Чи зростає інтерес до астрономії в українській Вікіпедії?" }
]
```

At least 12 positive and 10 negative prompts, mixed Ukrainian and English, at least 3 of each marked `holdout`.

**Positives** (should use the skill):
- trend in one language ("is interest in X growing on Wikipedia?");
- comparison between languages;
- "which language should we localize our app into next, based on Wikipedia interest";
- "make a one-page report on interest in X across pl, cs, sk";
- indirect phrasing ("people in Poland — are they reading about keto more than before?");
- a follow-up-style prompt that names Wikipedia pageviews.

**Negatives** (near misses that must not trigger):
- "what is intermittent fasting?" (a knowledge question);
- "edit this Wikipedia article";
- "Google Trends for keto in Poland" (a different source; the agent may mention the skill as an alternative but must not run it silently);
- "translate this paragraph into Polish";
- "how many articles does Ukrainian Wikipedia have?";
- "write a blog post about astronomy";
- "analyze our app's own download stats";
- general web research about a market.

### `evals/trigger.ts` (new)
Usage: `node evals/trigger.ts [--model haiku] [--runs 3] [--split dev|holdout|all]`.

For each prompt × run:
1. Workspace exactly as in 13: temp dir, skill symlinked into `.claude/skills/`, `WT_FAKE_API=1`.
2. Run `claude -p "<prompt>" --model <model> --output-format stream-json --verbose --max-turns 3 --allowedTools "Bash Read Glob Grep Skill"`. Three turns are enough to see the decision; this keeps cost low.
3. **Triggered** = the transcript contains a `Skill` tool use for this skill, **or** a Read of its `SKILL.md`, **or** a Bash call to `scripts/wt`.
4. Store the transcript and `{ id, shouldTrigger, triggered }`.

Report:
- **recall** = triggered positives / positives;
- **precision** = triggered positives / all triggered;
- the list of false negatives and false positives with their prompts;
- per split, over all runs.

Write `evals/results/<timestamp>/trigger-summary.json`.

## How to use the results
- **False negatives:** add the missing intent to `description` in the user's words ("localize", "which language to launch", "interest in a topic"), not implementation words ("Wikimedia AQS").
- **False positives:** add what the skill is **not** for ("not for general knowledge questions about the topic itself").
- Keep `description` under ~1,024 characters; re-run both `dev` and `holdout` after each edit.
- Target: recall ≥ 0.9 and precision ≥ 0.9 on `holdout` with the cheap model.

## Verification
- `node evals/trigger.ts --runs 1` completes and prints recall and precision.
- Temporarily replace `description` with something unrelated ("Formats Markdown tables") → recall drops close to 0. Revert.
- Record the baseline recall and precision in `evals/README.md`.
