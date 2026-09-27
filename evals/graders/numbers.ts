// Number-hallucination checker (spec 13): every number in the agent's answer must be traceable to the analysis JSON
// or to the user's prompt. Catches invented numbers and the agent's own arithmetic (ratios, differences) alike.

export interface Reading {
  value: number;
  /** digits after the decimal separator as written (0 for integers and scaled numbers) */
  decimals: number;
  /** scaled numbers: the value of one unit in the last written digit ("5,7 тис." → 100, "6 тис." → 1000) */
  step?: number;
}

export interface ExtractedNumber extends Reading {
  raw: string;
  percent: boolean;
  /** written with a multiplier: "5,7 тис.", "5.7k", "3 млн" (value is already multiplied) */
  scaled: boolean;
  /** other readings of an ambiguous separator: "5,712" is 5712 or 5.712 */
  alternatives: Reading[];
}

/** Thresholds that SKILL.md itself states (±5%/yr, p < 0.1, "per million"), so an agent may quote them. */
export const DOCUMENTED_CONSTANTS = [5, 0.1, 1_000_000];

// Things that contain digits but are not quantities. Order matters: run ids before dates, dates before years.
const SCRUB: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/\]\([^)\s]*\)/g, "]"], // markdown link and image targets
  [/\b(?:https?|file):\/\/\S+/gi, " "],
  [/(^|[\s(\[`'"«])(?:~\/|\.\/|\/)\S*/g, (_m, pre) => `${pre} `], // absolute / relative paths (not "%/yr")
  [/\S*\.(?:pdf|svg|png|json|md)\b/gi, " "], // file names
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " "], // session ids
  [/\b\d{8}-\d{6}\b/g, " "], // run ids (output dir stamps)
  [/\bQ\d+\b/g, " "], // Wikidata QIDs
  [/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " "], // YYYY-MM(-DD)
  [/(?<![\d.,])\b(?:19|20)\d{2}\b(?![.,]?\d)/g, " "], // bare years
  [/(?<![\w-])--[a-z][\w-]*(?:[= ](?!-)\S+)?/gi, " "], // CLI flags with their value
];

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(?:тис\.?|тисяч\p{L}*|thousand|k|K)$/u, 1e3],
  [/^(?:млн\.?|мільйон\p{L}*|million|mln|M)$/u, 1e6],
  [/^(?:млрд\.?|мільярд\p{L}*|billion|bn)$/u, 1e9],
];

// sign, integer part (space-grouped thousands or plain digits), further [.,]digits groups, percent, multiplier
const NUMBER =
  /(?<![\p{L}\p{N}_.,]|\p{L}-)([+\-−]?)(\d{1,3}(?:[   ]\d{3})+(?![\d])|\d+)((?:[.,]\d+)*)(\s?(?:%|відсот\p{L}*|percent|п\.\s?п\.|pp(?!\p{L})))?(?:\s?(тис\.?|тисяч\p{L}*|thousand|млн\.?|мільйон\p{L}*|million|mln|млрд\.?|мільярд\p{L}*|billion|bn|[kKM])(?![\p{L}]))?/gu;

export function scrub(text: string): string {
  let s = text;
  for (const [re, rep] of SCRUB) s = s.replace(re, rep as string);
  return s;
}

/** Readings of integer part + separator groups: "5" ",712" → 5712 (thousands) and 5.712 (decimal comma). */
function readings(intPart: string, rest: string): Reading[] {
  const int = intPart.replace(/[   ]/g, "");
  const groups = [...rest.matchAll(/([.,])(\d+)/g)].map(([, sep, digits]) => ({ sep: sep!, digits: digits! }));
  if (!groups.length) return [{ value: Number(int), decimals: 0 }];
  const last = groups[groups.length - 1]!;
  const head = groups.slice(0, -1);
  const allThousands = groups.every((g) => g.digits.length === 3) && int !== "0" && int.length <= 3 && int === intPart;
  if (head.length) {
    // 1,234,567 or 1.234.567: thousands; 1,234.5 or 1.234,5: thousands then decimal
    const sameSep = groups.every((g) => g.sep === groups[0]!.sep);
    if (sameSep && allThousands) return [{ value: Number(int + groups.map((g) => g.digits).join("")), decimals: 0 }];
    return [{ value: Number(`${int}${head.map((g) => g.digits).join("")}.${last.digits}`), decimals: last.digits.length }];
  }
  const decimal: Reading = { value: Number(`${int}.${last.digits}`), decimals: last.digits.length };
  if (!allThousands) return [decimal];
  const thousands: Reading = { value: Number(int + last.digits), decimals: 0 };
  // "5,712" reads as thousands first (the CLI's own format), "5.712" as a decimal first
  return last.sep === "," ? [thousands, decimal] : [decimal, thousands];
}

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of scrub(text).matchAll(NUMBER)) {
    const [raw, sign, intPart, rest, pct, mult] = m as unknown as [string, string, string, string, string?, string?];
    const factor = mult ? (MULTIPLIERS.find(([re]) => re.test(mult))?.[1] ?? 1) : 1;
    const neg = sign === "-" || sign === "−" ? -1 : 1;
    const [first, ...others] = readings(intPart, rest).map((r) =>
      factor === 1 ? { value: neg * r.value, decimals: r.decimals } : { value: neg * r.value * factor, decimals: 0, step: factor / 10 ** r.decimals },
    );
    out.push({ raw: raw.trim(), ...first!, percent: !!pct, scaled: factor !== 1, alternatives: others });
  }
  return out;
}

/** Bare integers ≤ 12 without % are counts, list numbering, "2 роки": not checked. */
export function isIgnored(n: ExtractedNumber): boolean {
  return !n.percent && !n.scaled && n.decimals === 0 && Number.isInteger(n.value) && Math.abs(n.value) <= 12;
}

/**
 * Every number the agent may quote: numbers anywhere in the given JSON values (analysis JSON, data.json), including
 * numbers inside strings (findings, reasons, caveats), and in the prompts. `monthly` arrays are skipped: the agent
 * never sees them. Absolute values: a sign in the answer is usually written as a word ("падіння на 12%").
 */
export function collectAllowed(values: unknown[], prompts: string[] = []): number[] {
  const out = new Set<number>(DOCUMENTED_CONSTANTS);
  const addText = (s: string) => {
    for (const n of extractNumbers(s)) for (const r of [n, ...n.alternatives]) out.add(Math.abs(r.value));
  };
  const walk = (v: unknown): void => {
    if (typeof v === "number") {
      if (Number.isFinite(v)) out.add(Math.abs(v));
    } else if (typeof v === "string") addText(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (k !== "monthly") walk(x);
    }
  };
  values.forEach(walk);
  prompts.forEach(addText);
  return [...out];
}

const EPS = 1e-9;

/** Does one reading of an answer number match an allowed value under the tolerance rules? */
function matches(r: Reading, n: ExtractedNumber, a: number): boolean {
  const v = Math.abs(r.value);
  if (v === a) return true;
  if (r.decimals <= 1 && Math.abs(v - a) <= 0.051 + EPS) return true; // rounded to 1 decimal
  if (r.decimals === 0 && Number.isInteger(v) && Math.abs(v - a) <= 0.5 + EPS) return true; // rounded to an integer
  if (a !== 0 && n.scaled && Math.abs(v - a) / a <= 0.05) return true; // "5,7 тис."
  if (r.step && Math.abs(v - a) <= r.step / 2 + EPS) return true; // "6 тис." for 5712: rounded to the written unit
  if (a !== 0 && r.decimals === 0 && v >= 100 && v % 100 === 0 && Math.abs(v - a) / a <= 0.02) return true; // "about 9000"
  if (a > 0 && a <= 1 && Math.abs(v - a * 100) <= 0.5 + EPS) return true; // a 0–1 score quoted ×100
  return false;
}

export function isSupported(n: ExtractedNumber, allowed: readonly number[]): boolean {
  return [n, ...n.alternatives].some((r) => allowed.some((a) => matches(r, n, a)));
}

export interface NumbersResult {
  /** numbers that were checked (ignored ones excluded) */
  checked: number;
  /** raw text of each unsupported number, in answer order */
  unsupported: string[];
}

export function checkNumbers(answer: string, allowed: readonly number[]): NumbersResult {
  const nums = extractNumbers(answer).filter((n) => !isIgnored(n));
  return { checked: nums.length, unsupported: nums.filter((n) => !isSupported(n, allowed)).map((n) => n.raw) };
}
