// Parsing of `claude -p --output-format stream-json --verbose` transcripts (spec 13, runner step 4). Pure.
import { isWtCommand } from "./graders/deterministic.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** the tool_result text, when it arrived */
  result?: string;
  isError?: boolean;
  /** called inside a subagent (Task), not by the main agent */
  nested: boolean;
}

/** One user turn = one `claude -p` process. */
export interface Turn {
  sessionId: string | null;
  /** every text block of the main agent, in order. The `result` event holds only the last one. */
  texts: string[];
  tools: ToolCall[];
  numTurns: number;
  costUsd: number;
  durationMs: number;
  /** `result` event subtype ("success", "error_max_turns", …); null when the process died without one */
  resultSubtype: string | null;
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Event = {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: Block[] | string };
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: Block) => (c?.type === "text" ? (c.text ?? "") : "")).join("\n");
  return "";
}

export function parseStream(jsonl: string): Turn {
  const turn: Turn = { sessionId: null, texts: [], tools: [], numTurns: 0, costUsd: 0, durationMs: 0, resultSubtype: null };
  const byId = new Map<string, ToolCall>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue; // a truncated last line when the process was killed
    }
    turn.sessionId ??= e.session_id ?? null;
    const nested = !!e.parent_tool_use_id;
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "assistant") {
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim() && !nested) turn.texts.push(b.text);
        if (b.type === "tool_use" && b.id) {
          const call: ToolCall = { id: b.id, name: b.name ?? "", input: (b.input as Record<string, unknown>) ?? {}, nested };
          byId.set(b.id, call);
          turn.tools.push(call);
        }
      }
    } else if (e.type === "user") {
      for (const b of blocks) {
        const call = b.type === "tool_result" && b.tool_use_id ? byId.get(b.tool_use_id) : undefined;
        if (call) {
          call.result = resultText(b.content);
          call.isError = !!b.is_error;
        }
      }
    } else if (e.type === "result") {
      turn.resultSubtype = e.subtype ?? null;
      turn.numTurns = e.num_turns ?? 0;
      turn.costUsd = e.total_cost_usd ?? 0;
      turn.durationMs = e.duration_ms ?? 0;
    }
  }
  return turn;
}

export function bashCommands(turns: Turn[]): string[] {
  return turns.flatMap((t) => t.tools.filter((c) => c.name === "Bash" && typeof c.input.command === "string").map((c) => c.input.command as string));
}

export function wtCalls(turns: Turn[]): ToolCall[] {
  return turns.flatMap((t) => t.tools.filter((c) => c.name === "Bash" && typeof c.input.command === "string" && isWtCommand(c.input.command)));
}

/** Paths delivered through any tool whose name matches /send.*file/i (host attachment tools). */
export function sentFiles(turns: Turn[]): string[] {
  const strings = (v: unknown): string[] =>
    typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
  return turns.flatMap((t) => t.tools.filter((c) => /send.*file/i.test(c.name)).flatMap((c) => strings(c.input).filter((s) => /[/\\]|\.\w{2,4}$/.test(s))));
}

/** All main-agent text of all turns (turns separated by a rule), plus one "[file sent: …]" line if files were sent. */
export function answerText(turns: Turn[]): string {
  const body = turns.map((t) => t.texts.join("\n\n")).join("\n\n---\n\n");
  const sent = sentFiles(turns);
  return sent.length ? `${body}\n\n[file sent: ${sent.join(", ")}]` : body;
}

/** The JSON objects scripts/wt printed (one per call), parsed out of the Bash results. */
export function wtOutputs(turns: Turn[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of wtCalls(turns)) {
    for (const line of (call.result ?? "").split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{") || !s.includes('"ok"')) continue;
      try {
        out.push(JSON.parse(s) as Record<string, unknown>);
      } catch {
        // a truncated tool result; its numbers still come from data.json
      }
    }
  }
  return out;
}
