import { defineConfig } from "vitest/config";

// Three layers, selected with --project (see package.json scripts). Live tests hit the real Wikimedia APIs,
// so they skip themselves unless WT_LIVE=1 (reported as skipped, not failed).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { test: { name: "integration", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000 } },
      { test: { name: "live", include: ["tests/live/**/*.test.ts"], testTimeout: 120_000 } },
    ],
  },
});
