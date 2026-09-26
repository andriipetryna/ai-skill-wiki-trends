import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import type { LanguageResult } from "./collect.ts";

// Categorical palette in fixed order (colour-vision-deficiency safe on white)
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

/** Line chart of monthly views per language. Returns an SVG string. */
export async function renderViewsChart(perLanguage: LanguageResult[], langs: string[], yTitle: string): Promise<string | null> {
  const ordered = langs.filter((l) => perLanguage.find((r) => r.lang === l)?.monthly.length);
  if (!ordered.length) return null;
  const values = ordered.flatMap((lang) => perLanguage.find((r) => r.lang === lang)!.monthly.map((p) => ({ lang, ...p })));

  const spec: TopLevelSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: 500,
    height: 220,
    background: "#ffffff",
    padding: 4,
    config: {
      font: "DejaVu Sans",
      view: { stroke: null },
      axis: { labelColor: "#52514e", titleColor: "#52514e", domainColor: "#e6e5e1", tickColor: "#e6e5e1", labelFontSize: 9, titleFontSize: 9, titleFontWeight: "normal" },
      legend: { labelColor: "#0b0b0b", labelFontSize: 10 },
    },
    data: { values },
    mark: { type: "line", strokeWidth: 2, interpolate: "monotone" },
    encoding: {
      x: { field: "month", type: "temporal", timeUnit: "yearmonth", title: null, axis: { format: "%b %Y", labelAngle: 0, tickCount: 6, grid: false } },
      y: { field: "views", type: "quantitative", title: yTitle, axis: { gridColor: "#e6e5e1", tickCount: 5 } },
      color: {
        field: "lang",
        type: "nominal",
        scale: { domain: ordered, range: PALETTE.slice(0, ordered.length) },
        legend: ordered.length > 1 ? { orient: "top", title: null, symbolType: "stroke", symbolStrokeWidth: 3 } : null,
      },
    },
  };
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
  const svg = await view.toSVG();
  view.finalize();
  return svg;
}
