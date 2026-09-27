// Normalisation: an article's share of its language edition's traffic.

/** views / edition views × 1e6. Months with edition = 0 give 0. */
export function sharePerMillion(views: readonly number[], edition: readonly number[]): number[] {
  return views.map((v, i) => {
    const e = edition[i] ?? 0;
    return e > 0 ? (v / e) * 1e6 : 0;
  });
}
