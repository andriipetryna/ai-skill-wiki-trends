---
name: wiki-trends
description: Fetch and compare Wikipedia pageviews for a topic across language editions (Wikimedia Pageviews API), with a chart and a one-page PDF report. Use when a user asks whether interest in a topic is growing, compares interest between languages, or wants a shareable report on topic interest from Wikipedia.
compatibility: Requires Node.js >= 22.18 and network access to wikimedia.org, wikipedia.org, wikidata.org and the npm registry (first run only).
metadata:
  version: "0.10.0"
---

# Wikipedia interest trends (MVP)

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
   - Period: `--years N` (default 3), `--months N`, or `--from YYYY-MM --to YYYY-MM`. Only complete months are used.
   - Report: add `--report --report-lang uk` (or `en`, matching the user's language) when the user wants something to share. Optional `--title "..."` and `--notes "..."` (at most 3 sentences of your interpretation, with no new numbers).
2. **Run `scripts/wt analyze ...`** as a single command.
3. **If `ok` is false:**
   - `candidates` present: the topic is ambiguous. Show the candidates to the user, ask which one they mean, and rerun with `--topic "<exact title>"` or `--topic Q...`.
   - Anything else: report `error` and `hint` to the user.
4. **If `ok` is true, answer from the JSON.**
   - `metrics.yoy.sharePct` = change of the topic's share of edition traffic, last 12 months vs the previous 12, with one-off spikes excluded. `viewsPct` (raw views, spikes excluded) and `editionPct` (whole edition) explain differences: if the edition shrinks, raw views can fall while interest (share) grows.
   - If `metrics.spikes` is non-empty, name the months: these are one-off events (news etc.) and are excluded from YoY and trend. `xBaseline` is how many times above the usual level that month was. If `yoy.sharePctWithSpikes` differs a lot from `yoy.sharePct`, say that the apparent change was driven by spikes. The chart marks spike months with rings.
   - `metrics.trend.sharePctPerYear` is the robust growth rate of the topic's share per year over the whole period (spikes excluded); `pValue` < 0.05 means the trend is unlikely to be noise. Quote p < 0.001 as "p<0.001". `viewsPctPerYear` and `editionPctPerYear` give the same context as in YoY. YoY compares only the last two years; the trend uses every month, so when they disagree, say both. `test: "mann_kendall"` means the range is under 2 years, so seasonality is not controlled. `trend` is null only when there are fewer than 2 months.
   - `metrics.verdict` is the one-word answer for the trend (`growing` / `declining` / `flat` / `inconclusive`). Use the verdict words as they are; never upgrade `inconclusive` to "growing" (or "declining").
   - `metrics.confidence` answers "can we trust this?": `level` (`high` / `medium` / `low`) and `reasons` (each starts with `+` or `-`). Explain the level with its reasons, e.g. "confidence is medium: a large part of the apparent change comes from one-off spikes". For `low`, say clearly that the data does not support a conclusion.
   - If `yoy.method` is `second_half_vs_first_half`, say the period is shorter than 2 years, so seasonality is not controlled.
   - `metrics.yoy` is null when there is nothing to compare with (e.g. the article is new and the previous period has no views): say so, don't guess a change.
   - `avgMonthlyViews`, `totalViews` and `periods` (12-month totals) show volume.
   - `metrics.sharePerMillion` is the article's share of its edition's traffic: `last12Avg` (mean of the last 12 months) and `median` (whole range), in views per million pageviews of that edition. The chart plots this share. `metrics` is null when there is no article or no data.
   - `status: "no_article"`: Wikidata links no article in that language. If `suggestions` are present, show them to the user (they may be a broader or differently named article) and offer to rerun with `--article <lang>="<title>"`. Never pick one silently.
   - If `resolution[].matchedBy` is `"search"`, tell the user which article was used and list the `alternatives`.
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

- Every number you state must appear in the JSON. Copy it; never compute new numbers or ratios.
- **Do not compare raw view counts between languages** ("Polish readers view it 2× more"): editions differ hugely in size. Compare `metrics.yoy.sharePct` (direction of change) instead.
- For comparing languages use `metrics.sharePerMillion.last12Avg` (views per million pageviews of that edition, NOT per million people). Never compare raw views between languages.
- For a trust question, answer with `metrics.confidence.level` and its `reasons` (not the p-value alone). Name every language whose confidence is `low`.
- State direction with `metrics.verdict` words; never call an `inconclusive` language growing or declining.
- Always mention that pageviews show interest, not willingness to pay, plus one more item from `caveats`.
- Keep it short: a direct answer first, then the chart, then per language, then caveats, then file links.

## Follow-up requests

Change the flags and rerun `analyze` (and show the new chart/PDF again, as in step 5) ("for 5 years" → `--years 5`; "add Hungarian" → add `hu`; "report in English" → `--report --report-lang en`).

## Examples

| User request | Command |
|---|---|
| Compare growth of interest in intermittent fasting in pl vs cs Wikipedia over two years | `scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2` |
| Is interest in astronomy growing in Ukrainian Wikipedia? | `scripts/wt analyze --topic "Astronomy" --langs uk --years 3` |
| Compare interest in learning English in our editions + short report | `scripts/wt analyze --topic "English language" --topic "English as a second or foreign language" --langs pl,cs,uk,de --report --report-lang uk` |
