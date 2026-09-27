// Spec 01 "Verification" item 1.
import { describe, expect, it } from "vitest";
import { sharePerMillion } from "../../../scripts/src/metrics/normalize.ts";

describe("sharePerMillion", () => {
  it("views / edition × 1e6; edition 0 → 0", () => {
    expect(sharePerMillion([9000, 0, 150], [120_000_000, 100_000_000, 0])).toEqual([75, 0, 0]);
  });
});
