import { join, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import type { LanguageResult } from "./collect.ts";

// Bundled DejaVu fonts (Cyrillic coverage), shared by the PNG and the PDF report
export const FONT_DIR = join(resolve(import.meta.dirname, "../.."), "node_modules", "dejavu-fonts-ttf", "ttf");

// Categorical palette in fixed order (colour-vision-deficiency safe on white)
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

/**
 * Colour per language that has a series to plot, in --langs order. Shared by the chart and the report table,
 * so both give a language the same colour; languages without data get none.
 */
export function langColors(perLanguage: LanguageResult[], langs: string[]): Map<string, string> {
  const plotted = langs.filter((l) => perLanguage.find((r) => r.lang === l)?.monthly.length);
  return new Map(plotted.map((l, i) => [l, PALETTE[i % PALETTE.length]!]));
}

/**
 * Line chart of monthly share per million pageviews of the edition, per language, with rings on spike months. Returns an SVG string.
 * `plotHeight` is the height of the plot area in px (the report picks it to fit the page).
 */
export async function renderViewsChart(perLanguage: LanguageResult[], langs: string[], yTitle: string, plotHeight = 220): Promise<string | null> {
  const colors = langColors(perLanguage, langs);
  const ordered = [...colors.keys()];
  if (!ordered.length) return null;
  const values = ordered.flatMap((lang) => perLanguage.find((r) => r.lang === lang)!.monthly.map((p) => ({ lang, ...p })));

  const spec: TopLevelSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: 500,
    height: plotHeight,
    background: "#ffffff",
    padding: 4,
    config: {
      font: "DejaVu Sans",
      view: { stroke: null },
      axis: { labelColor: "#52514e", titleColor: "#52514e", domainColor: "#e6e5e1", tickColor: "#e6e5e1", labelFontSize: 9, titleFontSize: 9, titleFontWeight: "normal" },
      legend: { labelColor: "#0b0b0b", labelFontSize: 10 },
    },
    data: { values },
    // Both layers share one encoding (and so one colour scale and legend); rings mark months excluded from YoY and trend
    layer: [
      { mark: { type: "line", strokeWidth: 2, interpolate: "monotone" } },
      { transform: [{ filter: "datum.spike" }], mark: { type: "point", size: 70, strokeWidth: 2, filled: false } },
    ],
    encoding: {
      x: { field: "month", type: "temporal", timeUnit: "yearmonth", title: null, axis: { format: "%b %Y", labelAngle: 0, tickCount: 6, grid: false } },
      // two lines: a one-line title longer than the plot would stretch the SVG bounds above and below it
      y: { field: "sharePerMillion", type: "quantitative", title: twoLines(yTitle), axis: { gridColor: "#e6e5e1", tickCount: 5 } },
      color: {
        field: "lang",
        type: "nominal",
        scale: { domain: ordered, range: [...colors.values()] },
        legend: ordered.length > 1 ? { orient: "top", title: null, symbolType: "stroke", symbolStrokeWidth: 3 } : null,
      },
    },
  };
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
  const svg = await view.toSVG();
  view.finalize();
  return svg;
}

/** Splits a title at the space nearest its middle. */
function twoLines(s: string): string[] {
  const mid = s.length / 2;
  let at = -1;
  for (let i = s.indexOf(" "); i >= 0; i = s.indexOf(" ", i + 1)) if (at < 0 || Math.abs(i - mid) < Math.abs(at - mid)) at = i;
  return at < 0 ? [s] : [s.slice(0, at), s.slice(at + 1)];
}

/** Rasterises the chart SVG to a 2x PNG, which chat hosts and image viewers can display. */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: 2 },
    background: "#ffffff",
    font: {
      fontFiles: [join(FONT_DIR, "DejaVuSans.ttf"), join(FONT_DIR, "DejaVuSans-Bold.ttf")],
      loadSystemFonts: false,
      defaultFontFamily: "DejaVu Sans",
    },
  });
  return resvg.render().asPng();
}
