// The eval number checker (spec 13) must read the CLI's own number formats: an answer that copies the findings
// verbatim is fully supported by the numeric fields of data.json alone.
import { readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { checkNumbers, collectAllowed } from "../../evals/graders/numbers.ts";
import { analyze, setupFake } from "./helpers.ts";

beforeEach(() => {
  setupFake();
});

it.each([
  ["fasting", ["--topic", "Intermittent fasting", "--langs", "pl,cs", "--years", "2"]],
  ["astronomy", ["--topic", "Astronomy", "--langs", "uk,pl"]],
  ["english", ["--topic", "English language", "--topic", "English as a second or foreign language", "--langs", "pl,cs,uk,de,hu,ro", "--weights", "growth=3"]],
])("%s: every number in findings is supported by data.json", async (_name, args) => {
  const out = await analyze(args);
  const data = JSON.parse(readFileSync(out.files.data, "utf8")) as unknown;
  const res = checkNumbers(out.findings.join("\n"), collectAllowed([data]));
  expect(res.checked).toBeGreaterThan(0);
  expect(res.unsupported).toEqual([]);
});
