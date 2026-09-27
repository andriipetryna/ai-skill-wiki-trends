# Methodology

Read this only when the user asks how a number is computed. Everything here is done by the CLI; never recompute any of it yourself.

## Data

- **Source:** Wikimedia Pageviews REST API, monthly, `agent=user`, `all-access`. Known bots are excluded; some automated traffic may remain.
- **Articles:** the topic is resolved to a Wikidata item (exact title → QID; otherwise the first full-text search hit, reported as `matchedBy: "search"`), then to its sitelink in each language. `--article lang="Title"` overrides that for one language.
- **Redirects** (on by default, `--no-redirects` turns them off): up to 25 namespace-0 redirects per article are added, deduplicated, and their views summed in, so renamed articles don't show artificial drops.
- **Basket:** several `--topic` values are summed per language and month.
- **Period:** complete months only, from 2015-07 at the earliest. `--years 3` (default) = the last 36 complete months.
- **Normalisation base:** monthly user pageviews of the whole language edition (`{lang}.wikipedia`).

## Share per million

`share[m] = views[m] / editionViews[m] × 1,000,000` (0 when the edition total is 0). This is views per million pageviews **of the edition**, not per million people.

It removes edition-wide traffic shifts (apps, AI answers in search, audience changes) and makes languages comparable. `sharePerMillion.median` is over the whole range; `last12Avg` is the mean of the last 12 months. Both include spikes.

## Spikes

Detected on **raw views**, upward only:

1. baseline `b` = 7-month centred rolling median (the window gets shorter at the edges);
2. log residual `r = ln(1 + views) − ln(1 + b)`;
3. robust scale `= max(1.4826 × MAD(r), 0.05)`, and `z = (r − median(r)) / scale`;
4. a month is a spike if `z > 3.5` **and** `b > 0` **and** `views / b ≥ 1.8`. The ratio condition keeps seasonal peaks (×1.3–1.5) from being flagged.

The **cleaned** series replaces each spike with its baseline. YoY and trend use the cleaned series. The top 5 spikes by ratio are listed (`xBaseline` = views / baseline), and the chart marks every spike month with a ring.

## Year-over-year (`yoy`)

On cleaned share, n = number of months:

- n ≥ 24: `(sum of the last 12 / sum of the previous 12 − 1) × 100` (`last12_vs_prev12`; earlier months are ignored). Each block contains every calendar month once, so seasonality cancels out.
- 6 ≤ n < 24: second half vs first half (`second_half_vs_first_half`); seasonality is not controlled.
- null if n < 6 or the base period is 0.

`sharePctWithSpikes` is the same on uncleaned share. `viewsPct` is on cleaned raw views and `editionPct` on the edition total.

## Trend (`trend`)

On `ln` of cleaned share, with zeros floored at half the smallest positive value:

- **n ≥ 24:** seasonal Sen slope = median of the slopes between pairs exactly k·12 months apart (the same calendar month in different years). Significance comes from the **seasonal Mann–Kendall** test (Hirsch et al., 1982): S and Var(S) are computed per calendar month and summed.
- **n < 24:** plain Theil–Sen (median slope over all pairs) + plain Mann–Kendall (`test: "mann_kendall"`).
- `%/yr = (e^(12 · slope) − 1) × 100`.
- Mann–Kendall: `S = Σ sign(y[j] − y[i])`; tie-corrected `Var(S) = [n(n−1)(2n+5) − Σ t(t−1)(2t+5)] / 18`; `z = (S ∓ 1)/√Var` (continuity correction); two-sided `p = 2(1 − Φ(|z|))`.

Why these methods: a Sen slope is robust to outliers, and the seasonal variant does not mistake the yearly cycle for growth. On synthetic data with a true +4%/yr and strong seasonality, plain Theil–Sen gave +24.6% while seasonal Sen gave +4.0%.

`viewsPctPerYear` and `editionPctPerYear` are the same slope on cleaned raw views and on the edition total.

## Verdict

On full-precision trend and p:

| Condition | Verdict |
|---|---|
| \|trend\| < 5 %/yr | `flat` |
| else p < 0.1 | `growing` / `declining` |
| else | `inconclusive` |

## Confidence

The score starts at 1. Rules are applied in order, and each one adds a reason:

| Rule | Δ score | Caps level at |
|---|---|---|
| median views/month < 100 | −0.5 | low |
| else < 1000 | −0.3 | medium |
| < 24 months | −0.15 | |
| p ≥ 0.2 (not significant) / 0.05 ≤ p < 0.2 (weak) | −0.45 / −0.25 | |
| spike-driven: \|YoY with spikes − YoY\| > 10 pp and > 50% of \|YoY with spikes\| | −0.4 | medium |
| else a spike in the last 12 months | −0.1 | |
| YoY and trend both beyond ±5% with opposite signs | −0.2 | |
| raw-views trend and share trend both beyond ±5% with opposite signs | −0.1 | |
| > 10% of months with zero views | −0.2 | |

The score is clamped to 0–1. Level from the score: ≥ 0.7 high, ≥ 0.4 medium, otherwise low. The final level is the lower of that and the cap.

## Ranking

Only computed when at least 2 languages have data. Each language gets four raw components, each min-max normalised across the languages of this run (0.5 for everyone when a component does not vary):

| Component | Raw value |
|---|---|
| volume | log10(max(1, median monthly views)) |
| growth | trend %/yr clamped to [−100, 200] |
| confidence | confidence score |
| share | log10(max(1e-6, last-12-month share per million)) |

`score = Σ w·c / Σ w`, with default weights volume=1, growth=1, confidence=1, share=0 (`--weights`). Ties are broken by confidence, then volume, then language code. The ranking is relative to the compared languages and the weights, never an absolute rating.

## Rounding

Everything is computed at full precision and rounded only in the output:

| What | Precision |
|---|---|
| percentages | 1 decimal |
| p-values | 3 decimals |
| share per million | 2 decimals |
| scores | 2 decimals |
| views | integer |
