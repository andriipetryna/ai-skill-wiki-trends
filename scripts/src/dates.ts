// Month helpers. A "Month" is always a 'YYYY-MM' string in UTC.
export type Month = string;

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function parseMonth(m: Month): { y: number; mo: number } {
  const match = MONTH_RE.exec(m);
  if (!match) throw new Error(`Invalid month "${m}", expected YYYY-MM`);
  const y = Number(match[1]);
  const mo = Number(match[2]);
  if (mo < 1 || mo > 12) throw new Error(`Invalid month "${m}"`);
  return { y, mo };
}

export function formatMonth(y: number, mo: number): Month {
  return `${y}-${String(mo).padStart(2, "0")}`;
}

export function addMonths(m: Month, delta: number): Month {
  const { y, mo } = parseMonth(m);
  const idx = y * 12 + (mo - 1) + delta;
  return formatMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

export function monthDiff(from: Month, to: Month): number {
  const a = parseMonth(from);
  const b = parseMonth(to);
  return (b.y - a.y) * 12 + (b.mo - a.mo);
}

export function monthRange(from: Month, to: Month): Month[] {
  const n = monthDiff(from, to);
  if (n < 0) throw new Error(`Empty range ${from}..${to}`);
  return Array.from({ length: n + 1 }, (_, i) => addMonths(from, i));
}

/** Calendar month index 0..11 */
export function monthOfYear(m: Month): number {
  return parseMonth(m).mo - 1;
}

/**
 * Last month whose data is complete. Pageviews for a month are published a day
 * or so after it ends, so during the first 2 days we step back one more month.
 */
export function lastCompleteMonth(now: Date): Month {
  const back = now.getUTCDate() <= 2 ? 2 : 1;
  return addMonths(formatMonth(now.getUTCFullYear(), now.getUTCMonth() + 1), -back);
}

/** Earliest month the Pageviews API covers (per-article & aggregate, agent=user). */
export const FIRST_AVAILABLE_MONTH: Month = "2015-07";

export function apiStart(m: Month): string {
  return m.replace("-", "") + "01";
}

export function apiEnd(m: Month): string {
  const { y, mo } = parseMonth(m);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return m.replace("-", "") + String(last).padStart(2, "0");
}

/** '2024010100' -> '2024-01' */
export function monthFromTimestamp(ts: string): Month {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}`;
}
