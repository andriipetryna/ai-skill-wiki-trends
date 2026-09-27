// One-page A4 PDF: title, table per language, chart, caveats. All numbers come from the collected data.
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { FONT_DIR, PALETTE } from "./charts.ts";
import type { LanguageResult } from "./collect.ts";
import type { Resolution } from "./resolve.ts";

export type UiLang = "en" | "uk";

const INK = "#0b0b0b";
const INK_2 = "#52514e";
const MUTED = "#8a8984";
const RULE = "#e6e5e1";

export const LABELS = {
  en: {
    table: "By language",
    chart: "Monthly share of the edition's traffic",
    notes: "Interpretation (written by the AI agent)",
    caveats: "Limitations",
    cols: ["Lang", "Article", "Total views", "Avg / month", "Per million", "Last 12 mo", "YoY share"],
    meta: (langs: string, from: string, to: string, date: string) => `Wikipedia pageviews · ${langs} · ${from} – ${to} · generated ${date}`,
    defaultTitle: (t: string) => `Interest in “${t}” on Wikipedia`,
    noArticle: "no article",
    noData: "no data",
    yTitle: "Views per million pageviews of the edition",
    footer: "Data: Wikimedia Pageviews API (agent=user, all-access). YoY = last 12 months vs the previous 12, on share per million.",
    caveatList: [
      "Pageviews show curiosity, not willingness to pay: a signal for further validation.",
      "Raw views are not comparable across languages: editions differ greatly in size.",
      "Share = article views per million pageviews of the whole language edition (not per million people).",
      "A single article is a proxy for the topic.",
    ],
    redirectsCaveat: (on: boolean) =>
      on
        ? "Views of redirects (alternative titles, up to 25 per article) are included."
        : "Redirect views are excluded; renamed articles may show artificial drops.",
  },
  uk: {
    table: "За мовами",
    chart: "Частка в трафіку розділу за місяць",
    notes: "Інтерпретація (написав AI-агент)",
    caveats: "Обмеження",
    cols: ["Мова", "Стаття", "Усього", "Сер. / міс", "На мільйон", "Ост. 12 міс", "Рік-до-року"],
    meta: (langs: string, from: string, to: string, date: string) => `Перегляди Wikipedia · ${langs} · ${from} – ${to} · створено ${date}`,
    defaultTitle: (t: string) => `Інтерес до «${t}» у Wikipedia`,
    noArticle: "немає статті",
    noData: "немає даних",
    yTitle: "Переглядів на мільйон переглядів розділу",
    footer: "Дані: Wikimedia Pageviews API (agent=user, all-access). Рік-до-року = останні 12 міс. проти попередніх 12, на частці на мільйон.",
    caveatList: [
      "Перегляди відображають цікавість, а не готовність платити: це сигнал для подальшої перевірки.",
      "Сирі перегляди не порівнюються між мовами: розділи дуже різні за розміром.",
      "Частка = переглядів статті на мільйон усіх переглядів мовного розділу (не на мільйон людей).",
      "Одна стаття — лише проксі теми.",
    ],
    redirectsCaveat: (on: boolean) =>
      on
        ? "Враховано перегляди перенаправлень (альтернативних назв, до 25 на статтю)."
        : "Перенаправлення не враховано; перейменовані статті можуть показувати штучне падіння.",
  },
} as const;

export interface ReportInput {
  out: string;
  lang: UiLang;
  title?: string;
  notes?: string;
  chartSvg: string | null;
  resolution: Resolution[];
  perLanguage: LanguageResult[];
  langs: string[];
  from: string;
  to: string;
  /** whether redirect views were summed into the articles */
  redirects: boolean;
}

export async function writeReport(r: ReportInput): Promise<string> {
  const t = LABELS[r.lang];
  const doc = new PDFDocument({ size: "A4", margins: { top: 36, bottom: 16, left: 36, right: 36 } });
  doc.registerFont("R", join(FONT_DIR, "DejaVuSans.ttf"));
  doc.registerFont("B", join(FONT_DIR, "DejaVuSans-Bold.ttf"));
  const stream = createWriteStream(r.out);
  doc.pipe(stream);

  const X = 36;
  const W = doc.page.width - 72;
  const FOOTER_Y = doc.page.height - 34;
  let y = 36;

  const label = r.resolution.map((x) => x.label ?? x.input).join(" + ") || r.perLanguage.flatMap((x) => x.articles).join(" + ");
  const title = r.title ?? t.defaultTitle(label);
  doc.font("B").fontSize(16).fillColor(INK).text(title, X, y, { width: W });
  y = doc.y + 2;
  doc.font("R").fontSize(8).fillColor(MUTED).text(t.meta(r.langs.join(", "), r.from, r.to, new Date().toISOString().slice(0, 10)), X, y, { width: W });
  y = doc.y + 12;

  // Table
  y = heading(doc, t.table, X, y);
  const widths = [36, 127, 72, 72, 72, 72, 72]; // sums to W = 523
  const aligns = ["left", "left", "right", "right", "right", "right", "right"] as const;
  doc.font("B").fontSize(7.8).fillColor(INK_2);
  let cx = X;
  t.cols.forEach((c, i) => {
    doc.text(c, cx + 2, y, { width: widths[i]! - 4, align: aligns[i], lineBreak: false });
    cx += widths[i]!;
  });
  y += 12;
  doc.moveTo(X, y).lineTo(X + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 4;
  for (const row of r.perLanguage.slice(0, 12)) {
    const last = row.periods.at(-1);
    const cells =
      row.status === "ok"
        ? [
            row.lang,
            row.articles.join(" + "),
            fmt(row.totalViews),
            fmt(row.avgMonthlyViews),
            row.metrics ? row.metrics.sharePerMillion.last12Avg.toFixed(1) : "—",
            last ? fmt(last.views) : "—",
            signed(row.metrics?.yoy?.sharePct ?? null),
          ]
        : [row.lang, row.articles.join(" + ") || "—", "—", "—", "—", "—", row.status === "no_article" ? t.noArticle : t.noData];
    cx = X;
    cells.forEach((c, i) => {
      doc.font(i === 0 ? "B" : "R").fontSize(8.5).fillColor(i === 0 ? PALETTE[r.langs.indexOf(row.lang) % PALETTE.length]! : INK);
      doc.text(fit(doc, c, widths[i]! - 4), cx + 2, y, { width: widths[i]! - 4, align: aligns[i], lineBreak: false });
      cx += widths[i]!;
    });
    y += 14;
  }
  y += 8;

  // Chart (svg-to-pdfkit sizes by the root width/height attributes, so keep only the viewBox)
  if (r.chartSvg) {
    y = heading(doc, t.chart, X, y);
    const [sw, sh] = svgSize(r.chartSvg);
    const svg = r.chartSvg.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
      let a = attrs.replace(/\s(width|height)="[^"]*"/g, "");
      if (!/viewBox=/.test(a)) a += ` viewBox="0 0 ${sw} ${sh}"`;
      return `<svg${a}>`;
    });
    const h = Math.min(280, (W * sh) / sw);
    SVGtoPDF(doc, svg, X, y, { width: (h * sw) / sh, height: h, fontCallback: (_f: string, bold: boolean) => (bold ? "B" : "R") });
    y += h + 10;
  }

  // Optional agent-written interpretation, clearly labelled
  if (r.notes) {
    const notes = r.notes.slice(0, 700);
    y = heading(doc, t.notes, X, y);
    doc.font("R").fontSize(8.8).fillColor(INK).text(notes, X, y, { width: W });
    y = doc.y + 10;
  }

  // Limitations: as many as fit on the page
  y = heading(doc, t.caveats, X, y);
  doc.font("R").fontSize(8).fillColor(INK_2);
  const caveats = [...t.caveatList, t.redirectsCaveat(r.redirects), ...missingNotes(r)];
  for (const c of caveats) {
    if (y + doc.heightOfString(c, { width: W - 10 }) > FOOTER_Y - 6) break;
    doc.text("•", X, y, { width: 10 });
    doc.text(c, X + 10, y, { width: W - 10 });
    y = doc.y + 2;
  }

  doc.moveTo(X, FOOTER_Y - 4).lineTo(X + W, FOOTER_Y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font("R").fontSize(7).fillColor(MUTED).text(t.footer, X, FOOTER_Y, { width: W });

  doc.end();
  await new Promise<void>((res, rej) => {
    stream.on("finish", () => res());
    stream.on("error", rej);
  });
  return resolve(r.out);
}

function missingNotes(r: ReportInput): string[] {
  return r.perLanguage
    .filter((x) => x.missingTopics.length)
    .map((x) => (r.lang === "uk" ? `${x.lang}: немає статті для «${x.missingTopics.join("», «")}».` : `${x.lang}: no article for "${x.missingTopics.join('", "')}".`));
}

function heading(doc: PDFKit.PDFDocument, text: string, x: number, y: number): number {
  doc.font("B").fontSize(10.5).fillColor(INK).text(text, x, y);
  return doc.y + 4;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function signed(x: number | null): string {
  if (x === null) return "—";
  return x > 0 ? `+${x.toFixed(1)}%` : `${x.toFixed(1)}%`;
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
