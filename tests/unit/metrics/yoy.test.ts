// Spec 03 "Verification" items 1–4.
import { describe, expect, it } from "vitest";
import { periodChange } from "../../../scripts/src/metrics/yoy.ts";

const fill = (n: number, x: number) => Array<number>(n).fill(x);

describe("periodChange", () => {
  it("24+ months: last 12 vs previous 12", () => {
    const r = periodChange([...fill(12, 100), ...fill(12, 150)]);
    expect(r?.method).toBe("last12_vs_prev12");
    expect(r?.pct).toBeCloseTo(50, 10);
  });

  it("earlier months are ignored with n > 24", () => {
    expect(periodChange([...fill(6, 999), ...fill(12, 100), ...fill(12, 150)])?.pct).toBeCloseTo(50, 10);
  });

  it("6–23 months: second half vs first half", () => {
    const r = periodChange([1, 1, 1, 2, 2, 2]);
    expect(r?.method).toBe("second_half_vs_first_half");
    expect(r?.pct).toBeCloseTo(100, 10);
  });

  it("fewer than 6 months → null", () => {
    expect(periodChange([1, 2, 3])).toBeNull();
  });

  it("previous block sums to 0 → null", () => {
    expect(periodChange([...fill(12, 0), ...fill(12, 5)])).toBeNull();
  });
});
