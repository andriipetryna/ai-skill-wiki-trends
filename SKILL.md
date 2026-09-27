---
name: wiki-trends
description: Fetch and compare Wikipedia pageviews for a topic across language editions (Wikimedia Pageviews API), with a chart and a one-page PDF report. Use when a user asks whether interest in a topic is growing, compares interest between languages, or wants a shareable report on topic interest from Wikipedia.
compatibility: Requires Node.js >= 22.18 and network access to wikimedia.org, wikipedia.org, wikidata.org and the npm registry (first run only).
metadata:
  version: "0.14.0"
---

# Wikipedia interest trends

All data work is done by the bundled CLI. **Never** call Wikimedia APIs yourself and never write analysis code: run the CLI and read its JSON.

Run from this skill's directory (the one containing this file):

```bash
scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2
```

The first run installs dependencies automatically (`npm ci`, ~30 s). The command prints one JSON object to stdout; read it directly.

## Workflow

1. **Map the request to flags.**
   - `--topic`: the **English Wikipedia article title**, e.g. "інтервальне голодування" → `"Intermittent fasting"`, "астрономія" → `"Astronomy"`. Repeat `--topic` to sum several related articles, e.g. learning English → `--topic "English language" --topic "English as a second or foreign language"`. A Wikidata QID (`Q333`) also works. For a title in another language add `--from-lang uk`.
   - `--langs`: Wikipedia language codes, comma-separated (uk, pl, cs, de, fr, es, it, pt, ro, hu, tr, en …). Ukrainian is `uk`, not `ua`.
   - `--article pl="Tytuł"` (repeatable): use this exact article for that language instead of the Wikidata link, e.g. after the user picked one of `suggestions`.
   - `--no-redirects` excludes views of alternative titles (rarely needed).
   - `--weights` sets what the language `ranking` values (defaults `volume=1,growth=1,confidence=1,share=0`; give only the keys you change). User says growth / momentum matters most → `--weights growth=3`; audience size → `--weights volume=3`; audiences where the topic takes a larger share of attention → `--weights share=1`.
   - Period: `--years N` (default 3), `--months N`, or `--from YYYY-MM --to YYYY-MM`. Only complete months are used.
   - Report: add `--report --report-lang uk` (or `en`, matching the user's language) when the user wants something to share. Optional `--title "..."` and `--notes "..."` (at most 3 sentences of your interpretation, with no new numbers).
2. **Run `scripts/wt analyze ...`** as a single command.
3. **If `ok` is false:**
   - `candidates` present: the topic is ambiguous. Show the candidates to the user, ask which one they mean, and rerun with `--topic "<exact title>"` or `--topic Q...`.
   - Anything else: report `error` and `hint` to the user.
4. **If `ok` is true, answer from the JSON.** Start from the three agent-facing fields; they are generated for this exact result:
   - `answerChecklist`: what your reply must contain, item by item (see "Rules for the answer").
   - `findings`: ready-made English sentences with all the key numbers (per language, relative interest, ranking, edition-wide traffic shifts). Paraphrase them in the user's language; don't change the numbers.
   - `caveats`: data-dependent limitations, already rendered in English.

   Field reference, for details or follow-up questions (per language in `perLanguage[]`; `metrics` is null for `no_article` / `no_data`):
   - `metrics.trend.sharePctPerYear` (headline): robust growth per year of the topic's share of the edition's traffic over the whole range, spikes excluded; `pValue` from the (seasonal) Mann–Kendall test, quoted as "p<0.001" below 0.001. `viewsPctPerYear` (raw views) and `editionPctPerYear` (whole edition) explain differences. `test: "mann_kendall"` = under 2 years, seasonality not controlled.
   - `metrics.yoy.sharePct`: last 12 months vs the previous 12 on the same share (`second_half_vs_first_half` if under 2 years); `sharePctWithSpikes`, `viewsPct`, `editionPct` for context; null = nothing to compare with (say so, don't guess).
   - `metrics.verdict`: `growing` / `declining` / `flat` / `inconclusive`. `metrics.confidence`: `level` + `reasons` (`"+ …"` / `"- …"`).
   - `metrics.spikes`: one-off months (`xBaseline` = times above the usual level), excluded from YoY and trend; rings on the chart.
   - `metrics.sharePerMillion.last12Avg`: views per million pageviews of that edition (not per million people): the only fair cross-language level.
   - `medianMonthlyViews`, `avgMonthlyViews`, `totalViews`, `periods`: volume within one language only.
   - `status: "no_article"` + `suggestions`: Wikidata links no article; show the suggestions and offer `--article <lang>="<title>"`. Never pick one silently.
   - `resolution[].matchedBy: "search"`: say which article was used and list `alternatives`.
   - `ranking` (top level): suggested order to investigate, `score` 0–1 and `components` (`volume`, `growth`, `confidence`, `share`, each 0–1 relative to this run); weights in `query.weights`; `[]` with fewer than 2 languages with data. With two languages the scores are always 1 and 0: say which leads and why (components).
   - How a number is computed (formulas, thresholds): read `references/methodology.md`, only when the user asks.
5. **Always show the files (every run with `ok: true`).** The user can't see files unless you surface them:
   - **Open the chart image.** Read `files.chartPng` with your file/image-reading tool (e.g. `Read`). The image then appears in the conversation, and you can check your answer matches it. Never skip this step.
   - **Embed and link in your reply.** Put the chart right after the direct answer, and the links at the end. Use the absolute paths from `files`:
     ```markdown
     ![Chart](/abs/path/chart.png)

     Files: [chart.png](/abs/path/chart.png) · [report-uk.pdf](/abs/path/report-uk.pdf)
     ```
     Include the PDF link only when `files.report` is not null (i.e. `--report` was used). Don't give paths as plain text or in code blocks; they must be markdown links.
   - **Hosts with a user-visible outputs folder** (Claude Desktop / Cowork): add `--out-dir "<that folder>"` to the command, so the PNG and PDF are written where the user can open them.

## Rules for the answer

**Work through `answerChecklist` from the output, item by item.** It is generated for this exact result. Also:

- Every number you state must appear in the JSON. Copy it exactly; never recompute, estimate or compute ratios. `findings` has ready-made sentences — paraphrase them in the user's language.
- The headline metric is `trend.sharePctPerYear` (growth of the topic's share of the edition's traffic). Mention `viewsPctPerYear` only when it differs in direction or a lot; `editionPctPerYear` explains why.
- `verdict`: growing/declining = significant (p < 0.1) and beyond ±5%/yr; flat = within ±5%/yr; inconclusive = large but not reliable. Never upgrade "inconclusive".
- Trust question → `confidence.level` + `reasons`. For `low`, say the data does not support a conclusion.
- Never compare raw view counts between languages. Views per million = per million pageviews of the edition, not per million people.
- If `spikes` is non-empty, name the months (one-off events, excluded from the trend).
- `ranking` is relative to the compared languages and weights; state the weights, offer to change them.
- Include at least two `caveats`, one of them: pageviews show interest, not willingness to pay.
- Keep it short: direct answer → per language → caveats → one next step.

## Follow-up requests

Change the flags and rerun `analyze` (and show the new chart/PDF again, as in step 5) ("for 5 years" → `--years 5`; "add Hungarian" → add `hu`; "report in English" → `--report --report-lang en`; "growth matters most to us" → `--weights growth=3`).

## Examples

| User request | Command |
|---|---|
| Compare growth of interest in intermittent fasting in pl vs cs Wikipedia over two years | `scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2` |
| Is interest in astronomy growing in Ukrainian Wikipedia? | `scripts/wt analyze --topic "Astronomy" --langs uk --years 3` |
| Compare interest in learning English in our editions + short report | `scripts/wt analyze --topic "English language" --topic "English as a second or foreign language" --langs pl,cs,uk,de,hu,ro --report --report-lang uk` |
| (after "pl: no article … Closest: «Głodówka lecznicza»") Use Głodówka lecznicza for Polish | `scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2 --article pl="Głodówka lecznicza"` |
| Which audiences should we research next for astronomy? Growth matters most to us | `scripts/wt analyze --topic "Astronomy" --langs uk,pl,cs,de,hu --weights growth=3` |
