// Parsing of stream-json transcripts for the task evals (evals/transcript.ts, spec 13).
import { describe, expect, it } from "vitest";
import { checkReport } from "../../evals/graders/deterministic.ts";
import { checkNumbers, collectAllowed } from "../../evals/graders/numbers.ts";
import { answerText, bashCommands, parseStream, sentFiles, wtCalls, wtOutputs } from "../../evals/transcript.ts";

// ---- a minimal stream-json transcript, in the shape `claude -p --output-format stream-json --verbose` writes

type Obj = Record<string, unknown>;
const jsonl = (...events: Obj[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const init = { type: "system", subtype: "init", session_id: "sess-1", tools: ["Bash", "Read"] };
const assistant = (content: Obj[], parent: string | null = null) => ({ type: "assistant", session_id: "sess-1", parent_tool_use_id: parent, message: { content } });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: Obj) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: "user",
  session_id: "sess-1",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});
const result = (last: string, extra: Obj = {}) => ({ type: "result", subtype: "success", result: last, session_id: "sess-1", num_turns: 4, total_cost_usd: 0.05, duration_ms: 30_000, ...extra });

const WT_OUT = {
  ok: true,
  perLanguage: [{ lang: "uk", metrics: { trend: { sharePctPerYear: 16.8, viewsPctPerYear: 3.1 }, yoy: { sharePct: 15.3 } } }],
  findings: ["uk: growing — share of edition traffic +16.8%/yr (p<0.001), YoY +15.3%, median 9,263 views/month; confidence high."],
  files: { data: "/ws/out/wiki-trends-20260927-182956/data.json", chartPng: "/ws/out/wiki-trends-20260927-182956/chart.png", report: null },
};
const WT_CMD = "cd .claude/skills/wiki-trends && scripts/wt analyze --topic Astronomy --langs uk --years 3";

/** The agent writes its answer, then makes a final tool call and closes with a short line. */
function transcript(answer: string): string {
  return jsonl(
    init,
    assistant([toolUse("t1", "Skill", { skill: "wiki-trends" })]),
    toolResult("t1", "Launching skill: wiki-trends"),
    assistant([text("Запускаю аналіз."), toolUse("t2", "Bash", { command: WT_CMD })]),
    toolResult("t2", [{ type: "text", text: `wiki-trends: WT_FAKE_API=1, serving synthetic data\n${JSON.stringify(WT_OUT)}` }]),
    assistant([text(answer), toolUse("t3", "Read", { file_path: WT_OUT.files.chartPng })]),
    toolResult("t3", [{ type: "image" }]),
    assistant([text("Графік вище.")]),
    result("Графік вище."),
  );
}

const ANSWER = "Так, інтерес зростає: частка +16,8 %/рік, рік до року +15,3 %. Перегляди — це цікавість, не готовність платити.";

describe("parseStream", () => {
  it("session id, tool calls with their results, and result stats", () => {
    const t = parseStream(transcript(ANSWER));
    expect(t.sessionId).toBe("sess-1");
    expect(t.tools.map((c) => c.name)).toEqual(["Skill", "Bash", "Read"]);
    expect(t.tools[1]!.result).toContain('"ok":true');
    expect(t).toMatchObject({ numTurns: 4, costUsd: 0.05, durationMs: 30_000, resultSubtype: "success" });
  });

  it("regression: only the last text block was graded (the answer was written before a final tool call)", () => {
    const answer = answerText([parseStream(transcript(ANSWER))]);
    expect(answer).toContain(ANSWER);
    expect(answer).toContain("Графік вище.");
    expect(answer.indexOf("Запускаю")).toBeLessThan(answer.indexOf(ANSWER));
  });

  it("skips subagent text and survives a truncated last line", () => {
    const t = parseStream(jsonl(init, assistant([text("inner")], "task-1"), assistant([text("outer")])) + '{"type":"assis');
    expect(t.texts).toEqual(["outer"]);
    expect(t.resultSubtype).toBeNull();
  });

  it("joins turns with a rule", () => {
    const a = parseStream(jsonl(assistant([text("first")]), result("first")));
    const b = parseStream(jsonl(assistant([text("second")]), result("second")));
    expect(answerText([a, b])).toBe("first\n\n---\n\nsecond");
  });
});

describe("scripts/wt calls and their output", () => {
  const turns = [parseStream(transcript(ANSWER))];

  it("finds the Bash commands and the parsed stdout JSON", () => {
    expect(bashCommands(turns)).toEqual([WT_CMD]);
    expect(wtCalls(turns)).toHaveLength(1);
    expect(wtOutputs(turns)).toEqual([WT_OUT]);
  });

  it("an error exit still yields the JSON (Bash prefixes the exit code)", () => {
    const err = { ok: false, error: 'Ambiguous topic "Mercury"', candidates: [{ title: "Mercury (planet)", qid: "Q308" }] };
    const t = parseStream(jsonl(assistant([toolUse("t1", "Bash", { command: "scripts/wt analyze --topic Mercury --langs uk" })]), toolResult("t1", `Exit code 2\n${JSON.stringify(err)}`, true)));
    expect(wtOutputs([t])).toEqual([err]);
  });
});

describe("the numbers grader on a stored transcript", () => {
  it("a hand-edited answer with an invented number is flagged: 'зросло на 52%'", () => {
    const edited = transcript(ANSWER.replace("рік до року +15,3 %", "за два роки зросло на 52%"));
    const turns = [parseStream(edited)];
    const res = checkNumbers(answerText(turns), collectAllowed(wtOutputs(turns)));
    expect(res.unsupported).toEqual(["52%"]);
  });

  it("the unedited answer is clean", () => {
    const turns = [parseStream(transcript(ANSWER))];
    expect(checkNumbers(answerText(turns), collectAllowed(wtOutputs(turns))).unsupported).toEqual([]);
  });
});

describe("files sent as attachments", () => {
  it("any tool matching /send.*file/i; its paths are appended to the answer, so the report check passes", () => {
    const t = parseStream(
      jsonl(
        assistant([text("Звіт у вкладенні."), toolUse("t1", "mcp__host__send_user_file", { files: ["/ws/out/x/report-uk.pdf"], message: "Ось звіт" })]),
        toolResult("t1", "sent"),
        result("Звіт у вкладенні."),
      ),
    );
    expect(sentFiles([t])).toEqual(["/ws/out/x/report-uk.pdf"]);
    const answer = answerText([t]);
    expect(answer).toContain("[file sent: /ws/out/x/report-uk.pdf]");
    expect(checkReport(["/ws/out/x/report-uk.pdf"], answer, sentFiles([t]))).toBe(true);
  });
});
