import { describe, expect, it } from "vitest";
import { addMonths, apiEnd, lastCompleteMonth, monthFromTimestamp, monthOfYear, monthRange } from "../../scripts/src/dates.ts";

describe("dates", () => {
  it("addMonths crosses year boundaries both ways", () => {
    expect(addMonths("2024-11", 3)).toBe("2025-02");
    expect(addMonths("2024-01", -1)).toBe("2023-12");
  });

  it("monthRange is inclusive and ordered; from > to throws", () => {
    expect(monthRange("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
    expect(() => monthRange("2025-02", "2024-11")).toThrow();
  });

  it("apiEnd is the last day of the month, leap years included", () => {
    expect(apiEnd("2024-02")).toBe("20240229");
    expect(apiEnd("2023-02")).toBe("20230228");
  });

  it("lastCompleteMonth steps back one more month during the first 2 days (publication lag)", () => {
    expect(lastCompleteMonth(new Date("2026-09-26T12:00:00Z"))).toBe("2026-08");
    expect(lastCompleteMonth(new Date("2026-09-01T12:00:00Z"))).toBe("2026-07");
    expect(lastCompleteMonth(new Date("2026-09-02T23:59:00Z"))).toBe("2026-07");
    expect(lastCompleteMonth(new Date("2026-09-03T00:00:00Z"))).toBe("2026-08");
  });

  it("monthFromTimestamp", () => {
    expect(monthFromTimestamp("2024090100")).toBe("2024-09");
  });

  it("monthOfYear is 0-based", () => {
    expect(monthOfYear("2024-01")).toBe(0);
    expect(monthOfYear("2024-12")).toBe(11);
  });
});
