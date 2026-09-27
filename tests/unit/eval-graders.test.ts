// Deterministic graders and the judge's reply parser of the task evals (evals/graders/, spec 13),
// plus the scenario regexes against the commands SKILL.md prescribes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCaveat,
  checkChart,
  checkCommands,
  checkMentions,
  checkNoOwnCode,
  checkReport,
  countWtCalls,
  gradeDeterministic,
  type Expect,
  type RunRecord,
} from "../../evals/graders/deterministic.ts";
import { buildJudgePrompt, parseJudgeOutput } from "../../evals/graders/judge.ts";

const SCENARIOS = JSON.parse(readFileSync(join(import.meta.dirname, "../../evals/scenarios.json"), "utf8")) as Array<{ id: string; split: string; expect: Expect }>;
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!.expect;

describe("scenarios.json", () => {
  it("unique ids, at least 8 scenarios and 2 holdout, valid regexes", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(8);
    expect(SCENARIOS.filter((s) => s.split === "holdout").length).toBeGreaterThanOrEqual(2);
    for (const s of SCENARIOS) for (const re of [...(s.expect.commands ?? []), ...(s.expect.mentions ?? [])]) expect(() => new RegExp(re, "i"), `${s.id}: ${re}`).not.toThrow();
  });

  // The commands a correct agent runs (SKILL.md examples); a scenario regex that rejects one is a grader bug.
  const GOOD: Record<string, string[]> = {
    "fasting-pl-cs": ['scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2'],
    "fasting-article-followup": [
      'scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2',
      'scripts/wt analyze --topic "Intermittent fasting" --langs pl,cs --years 2 --article pl="Głodówka lecznicza"',
    ],
    "astronomy-trust": ['scripts/wt analyze --topic "Astronomy" --langs uk --years 3'],
    "english-report": [
      'scripts/wt analyze --topic "English language" --topic "English as a second or foreign language" --langs pl,cs,uk,de,hu,ro --report --report-lang uk',
    ],
    "ambiguous-mercury": ['scripts/wt analyze --topic "Mercury" --langs uk'],
    "missing-language": ['scripts/wt analyze --topic "Astronomy" --langs uk,hu'],
    "followup-add-lang": ['scripts/wt analyze --topic "Astronomy" --langs uk', 'scripts/wt analyze --topic "Astronomy" --langs uk,pl --report --report-lang en'],
    "custom-weights": ['scripts/wt analyze --topic "Astronomy" --langs uk,pl --weights growth=3'],
  };

  it.each(SCENARIOS.map((s) => s.id))("%s: accepts the commands SKILL.md prescribes", (id) => {
    expect(GOOD[id], `add the canonical commands for ${id}`).toBeDefined();
    expect(checkCommands(GOOD[id]!, scenario(id).commands ?? [])).toBe(true);
  });

  it("rejects near misses", () => {
    const english = scenario("english-report").commands!;
    expect(checkCommands(['scripts/wt analyze --topic "English language" --langs pl,cs,uk,de,hu --report --report-lang uk'], english)).not.toBe(true);
    expect(checkCommands(['scripts/wt analyze --topic "English language" --langs pl,cs,uk,de,hu,ro --report-lang uk'], english)).not.toBe(true);
    const weights = scenario("custom-weights").commands!;
    expect(checkCommands(['scripts/wt analyze --topic "Astronomy" --langs uk,pl --weights growth=1'], weights)).not.toBe(true);
    expect(checkCommands(['scripts/wt analyze --topic "Astronomy" --langs uk,pl --weights volume=3'], weights)).not.toBe(true);
    expect(checkCommands(['scripts/wt analyze --topic "Astronomy" --langs uk,pl --weights growth=1.5'], weights)).toBe(true);
    expect(checkCommands(['scripts/wt analyze --topic "Astronomy" --langs pl,uk --weights volume=0'], weights)).toBe(true);
    expect(checkCommands(['scripts/wt analyze --topic "Astronomy" --langs uk --report --report-lang uk'], scenario("followup-add-lang").commands!)).not.toBe(true);
  });

  it("the weights mention regex does not match 'увага' (attention)", () => {
    const re = scenario("custom-weights").mentions![0]!;
    expect(checkMentions("Зверніть увагу на тренд.", [re])).not.toBe(true);
    expect(checkMentions("Ваги: зростання=3.", [re])).toBe(true);
    expect(checkMentions("з вагами growth=3", [re])).toBe(true);
  });
});

describe("deterministic checks", () => {
  it("countWtCalls counts invocations, not mentions of other files", () => {
    expect(countWtCalls(["cd .claude/skills/wiki-trends && scripts/wt analyze --topic X --langs uk"])).toBe(1);
    expect(countWtCalls(["scripts/wt resolve --topic X --langs uk; scripts/wt analyze --topic X --langs uk", "ls"])).toBe(2);
    expect(countWtCalls(["cat scripts/wt.bak", "ls scripts/src"])).toBe(0);
  });

  it("checkCommands reports the missing pattern and the commands", () => {
    const res = checkCommands(["scripts/wt analyze --topic Astronomy --langs uk"], ["Astronomy", "--report"]);
    expect(res).toMatch(/\/--report\//);
    expect(res).toMatch(/--langs uk/);
  });

  it("checkMentions is case-insensitive, Cyrillic included", () => {
    expect(checkMentions("ПОЛЬСЬКА Вікіпедія", ["польськ"])).toBe(true);
  });

  it("checkReport: the PDF must exist and be linked or sent", () => {
    expect(checkReport([], "report-uk.pdf", [])).toMatch(/no PDF/);
    expect(checkReport(["/o/report-uk.pdf"], "Готово.", [])).toMatch(/neither linked/);
    expect(checkReport(["/o/report-uk.pdf"], "[report-uk.pdf](/o/report-uk.pdf)", [])).toBe(true);
    expect(checkReport(["/o/report-uk.pdf"], "Готово.", ["/o/report-uk.pdf"])).toBe(true);
  });

  it("checkChart", () => {
    expect(checkChart("![Chart](/o/chart.png)", [])).toBe(true);
    expect(checkChart("Готово.", [])).not.toBe(true);
  });

  it("checkCaveat matches broadly, in Ukrainian and English", () => {
    for (const ok of [
      "Перегляди показують цікавість, а не готовність платити.",
      "Інтерес не означає попит.",
      "Інтерес ≠ купівельна спроможність.",
      "Pageviews measure attention, not willingness to pay.",
      "interest does not mean people will pay",
    ]) {
      expect(checkCaveat(ok), ok).toBe(true);
    }
    expect(checkCaveat("Дані синтетичні.")).not.toBe(true);
  });

  it("checkNoOwnCode", () => {
    expect(checkNoOwnCode(["scripts/wt analyze --topic X --langs uk", "ls -la"])).toBe(true);
    for (const bad of ["curl -s https://wikimedia.org/api/rest_v1/metrics", "python3 -c 'print(1)'", "node -e 'console.log(1)'", "wget https://uk.wikipedia.org/w/api.php"]) {
      expect(checkNoOwnCode([bad]), bad).not.toBe(true);
    }
  });

  it("gradeDeterministic: one scripts/wt call per user turn by default; checks that do not apply are absent", () => {
    const r: RunRecord = {
      userTurns: 2,
      bashCommands: ["scripts/wt analyze a", "scripts/wt analyze b"],
      wtCommands: ["scripts/wt analyze a", "scripts/wt analyze b"],
      wtCalls: 2,
      answer: "не готовність платити",
      sentFiles: [],
      outFiles: [],
      chartProduced: false,
    };
    const g = gradeDeterministic({ caveat: true }, r);
    expect(g).toEqual({ wtCalls: true, caveat: true, noOwnCode: true });
    expect(gradeDeterministic({}, { ...r, userTurns: 1 }).wtCalls).toBe("2 scripts/wt calls, max 1");
    expect(gradeDeterministic({ maxWtCalls: 3 }, { ...r, userTurns: 1 }).wtCalls).toBe(true);
    expect(gradeDeterministic({}, { ...r, chartProduced: true }).chart).not.toBe(true);
  });
});

describe("judge", () => {
  const rubric = ["Asks planet vs element.", "Gives no numbers."];

  it("parses strict JSON, also inside code fences, matching items by text or position", () => {
    const reply = '```json\n[{"item":"Gives no numbers.","pass":false,"reason":"quotes 120"},{"item":"Asks planet vs element.","pass":true,"reason":"asks"}]\n```';
    expect(parseJudgeOutput(reply, rubric)).toEqual([
      { item: "Asks planet vs element.", pass: true, reason: "asks" },
      { item: "Gives no numbers.", pass: false, reason: "quotes 120" },
    ]);
    expect(parseJudgeOutput('[{"item":"x","pass":true,"reason":""}]', rubric).map((i) => i.pass)).toEqual([true, null]);
  });

  it("bad JSON is unknown (null), never a failure", () => {
    for (const bad of ["I think it passes.", "[{pass: yes}]", '{"pass":true}', ""]) {
      expect(parseJudgeOutput(bad, rubric).map((i) => i.pass), bad).toEqual([null, null]);
    }
    expect(parseJudgeOutput('[{"item":"Asks planet vs element.","pass":"yes"}]', rubric)[0]!.pass).toBeNull();
  });

  it("the prompt carries prompts, answer, analysis and rubric", () => {
    const p = buildJudgePrompt({ prompts: ["Mercury?", "планета"], answer: "Планета чи елемент?", analysis: [{ ok: false, candidates: [] }], rubric });
    for (const s of ["User turn 1:\nMercury?", "User turn 2:\nпланета", "Планета чи елемент?", '{"ok":false,"candidates":[]}', "1. Asks planet vs element.", "2. Gives no numbers."]) {
      expect(p).toContain(s);
    }
  });
});
