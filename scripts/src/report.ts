// One-page A4 PDF: title, key findings, chart, table per language, agent notes, caveats. All numbers come from the collected data.
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { FONT_DIR, langColors, renderViewsChart } from "./charts.ts";
import type { LanguageResult } from "./collect.ts";
import { buildFindings, int, LABELS, pfmt, renderCaveat, signed, type AnalysisResult, type Caveat, type UiLang } from "./text.ts";

const INK = "#0b0b0b";
const INK_2 = "#52514e";
const MUTED = "#8a8984";
const RULE = "#e6e5e1";

const MAX_FINDINGS = 9;
const MAX_ROWS = 12;
const NOTES_MAX_CHARS = 600;
const DEFAULT_PLOT_HEIGHT = 220;

export interface ReportInput {
  out: string;
  lang: UiLang;
  title?: string;
  notes?: string;
  /** the analyze result, with the per-month series (the report draws its own chart) */
  result: AnalysisResult & { perLanguage: LanguageResult[] };
  caveats: Caveat[];
}

export async function writeReport(r: ReportInput): Promise<string> {
  const t = LABELS[r.lang];
  const { query, perLanguage, ranking, resolution } = r.result;
  const doc = new PDFDocument({ size: "A4", margins: { top: 36, bottom: 16, left: 36, right: 36 } });
  doc.registerFont("R", join(FONT_DIR, "DejaVuSans.ttf"));
  doc.registerFont("B", join(FONT_DIR, "DejaVuSans-Bold.ttf"));
  const stream = createWriteStream(r.out);
  doc.pipe(stream);

  const X = 36;
  const W = doc.page.width - 72;
  const FOOTER_Y = doc.page.height - 34;
  const BOTTOM = FOOTER_Y - 6;
  let y = 36;

  // 1. Title and meta
  const label = resolution.map((x) => x.label ?? x.input).join(" + ") || perLanguage.flatMap((x) => x.articles).join(" + ");
  const title = r.title ?? t.defaultTitle(label);
  doc.font("B").fontSize(16).fillColor(INK).text(title, X, y, { width: W });
  y = doc.y + 2;
  doc.font("R").fontSize(8).fillColor(MUTED).text(t.meta(query.langs.join(", "), query.from, query.to, new Date().toISOString().slice(0, 10)), X, y, { width: W });
  y = doc.y + 10;

  // 2. Key findings
  const findings = buildFindings(r.result, r.lang).slice(0, MAX_FINDINGS);
  y = heading(doc, t.findings, X, y);
  doc.font("R").fontSize(8.8).fillColor(INK);
  for (const f of findings) {
    doc.text("•", X, y, { width: 10 });
    doc.text(f, X + 10, y, { width: W - 10 });
    y = doc.y + 1.5;
  }
  y += 8;

  // 3. Chart: its height adapts to the number of findings so everything fits on one page
  const target = findings.length <= 4 ? 270 : findings.length <= 6 ? 235 : 200;
  const chart = await chartForHeight(perLanguage, query.langs, t.yTitle, target, W);
  if (chart) {
    y = heading(doc, t.chart, X, y);
    SVGtoPDF(doc, chart.svg, X, y, { width: chart.w, height: chart.h, fontCallback: (_f: string, bold: boolean) => (bold ? "B" : "R") });
    y += chart.h + 8;
  }

  // 4. Table by rank; languages without a rank (no data) keep their --langs order at the end (the sort is stable)
  y = heading(doc, t.table, X, y);
  const widths = [28, 111, 60, 54, 56, 50, 40, 68, 56]; // sums to W = 523; long titles are truncated by fit()
  const aligns = ["left", "left", "right", "right", "right", "right", "right", "center", "center"] as const;
  doc.font("B").fontSize(8).fillColor(INK_2);
  const headerH = Math.max(...t.cols.map((c, i) => doc.heightOfString(c, { width: widths[i]! - 4 })));
  let cx = X;
  t.cols.forEach((c, i) => {
    doc.text(c, cx + 2, y + headerH - doc.heightOfString(c, { width: widths[i]! - 4 }), { width: widths[i]! - 4, align: aligns[i] });
    cx += widths[i]!;
  });
  y += headerH + 2;
  doc.moveTo(X, y).lineTo(X + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 4;
  const colors = langColors(perLanguage, query.langs);
  const rankOf = new Map(ranking.map((x) => [x.lang, x.rank]));
  const ordered = query.langs.flatMap((l) => perLanguage.find((x) => x.lang === l) ?? []);
  const rows = ordered.sort((a, b) => (rankOf.get(a.lang) ?? Infinity) - (rankOf.get(b.lang) ?? Infinity));
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (y + 12 > BOTTOM) break;
    const m = row.metrics;
    const cells = m
      ? [
          row.lang,
          row.articles.join(" + "),
          int(m.medianMonthlyViews),
          m.sharePerMillion.last12Avg.toFixed(2),
          dash(signed(m.yoy?.sharePct)),
          dash(signed(m.trend?.sharePctPerYear)),
          m.trend ? pfmt(m.trend.pValue).replace(/^p=?/, "") : "—",
          t.verdicts[m.verdict],
          t.levels[m.confidence.level],
        ]
      : [row.lang, row.articles.join(" + ") || "—", "—", "—", "—", "—", "—", row.status === "no_article" ? t.noArticle : t.noData, "—"];
    cx = X;
    cells.forEach((c, i) => {
      doc.font(i === 0 ? "B" : "R").fontSize(8).fillColor(i === 0 ? (colors.get(row.lang) ?? MUTED) : INK);
      doc.text(fit(doc, c, widths[i]! - 4), cx + 2, y, { width: widths[i]! - 4, align: aligns[i], lineBreak: false });
      cx += widths[i]!;
    });
    y += 13;
  }
  y += 8;

  // 5. Optional agent-written interpretation, clearly labelled; clipped to the space left
  if (r.notes && y + 40 < BOTTOM) {
    y = heading(doc, t.notes, X, y);
    doc.font("R").fontSize(8.8).fillColor(INK);
    const room = BOTTOM - y;
    const notes = r.notes.length > NOTES_MAX_CHARS ? `${r.notes.slice(0, NOTES_MAX_CHARS - 1).trimEnd()}…` : r.notes;
    doc.text(notes, X, y, { width: W, height: room, ellipsis: true });
    y = Math.min(doc.y, y + room) + 8;
  }

  // 6. Assumptions & limitations: as many as fit above the footer
  if (y + 30 < BOTTOM) {
    y = heading(doc, t.caveats, X, y);
    doc.font("R").fontSize(8).fillColor(INK_2);
    for (const c of r.caveats.map((c) => renderCaveat(c, r.lang))) {
      if (y + doc.heightOfString(c, { width: W - 10 }) > BOTTOM) break;
      doc.text("•", X, y, { width: 10 });
      doc.text(c, X + 10, y, { width: W - 10 });
      y = doc.y + 2;
    }
  }

  // 7. Footer
  const spikes = perLanguage.some((x) => x.metrics?.spikes.length);
  doc.moveTo(X, FOOTER_Y - 4).lineTo(X + W, FOOTER_Y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font("R").fontSize(7).fillColor(MUTED).text(spikes ? `${t.footer} ${t.spikeFooter}` : t.footer, X, FOOTER_Y, { width: W, lineBreak: false });

  doc.end();
  await new Promise<void>((res, rej) => {
    stream.on("finish", () => res());
    stream.on("error", rej);
  });
  return resolve(r.out);
}

/**
 * Renders the chart so that, scaled to width W, it is about `target` pt tall; returns it ready for svg-to-pdfkit
 * (which sizes an SVG by its root width/height attributes, so only the viewBox is kept).
 */
async function chartForHeight(perLanguage: LanguageResult[], langs: string[], yTitle: string, target: number, W: number) {
  const probe = await renderViewsChart(perLanguage, langs, yTitle);
  if (!probe) return null;
  const [pw, ph] = svgSize(probe);
  // everything but the plot area (axes, legend, padding) keeps its size; grow or shrink only the plot
  const plotHeight = Math.max(80, Math.round(DEFAULT_PLOT_HEIGHT + (target * pw) / W - ph));
  const raw = (await renderViewsChart(perLanguage, langs, yTitle, plotHeight))!;
  const [sw, sh] = svgSize(raw);
  const svg = raw.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    let a = attrs.replace(/\s(width|height)="[^"]*"/g, "");
    if (!/viewBox=/.test(a)) a += ` viewBox="0 0 ${sw} ${sh}"`;
    return `<svg${a}>`;
  });
  const h = Math.min(target, (W * sh) / sw);
  return { svg, w: (h * sw) / sh, h };
}

/** "n/a" from the shared formatters reads as a dash in a table cell */
function dash(s: string): string {
  return s === "n/a" ? "—" : s;
}

function heading(doc: PDFKit.PDFDocument, text: string, x: number, y: number): number {
  doc.font("B").fontSize(10.5).fillColor(INK).text(text, x, y);
  return doc.y + 4;
}

function fit(doc: PDFKit.PDFDocument, s: string, width: number): string {
  if (doc.widthOfString(s) <= width) return s;
  let t = s;
  while (t.length > 1 && doc.widthOfString(t + "…") > width) t = t.slice(0, -1);
  return t + "…";
}

function svgSize(svg: string): [number, number] {
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1];
  const h = /<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1];
  return [Number(w ?? 600), Number(h ?? 260)];
}
