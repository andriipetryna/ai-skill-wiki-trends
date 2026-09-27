// Triggering evals (spec 14): did the agent pick the skill, and precision/recall over labelled prompts. Pure.
import type { Turn } from "../transcript.ts";
import { isWtCommand } from "./deterministic.ts";

/** How the skill was picked up: the Skill tool, a read of its SKILL.md, or a scripts/wt call. */
export type TriggerSignal = "skill" | "read" | "wt";

export type Split = "dev" | "holdout";

export interface TriggerPrompt {
  id: string;
  shouldTrigger: boolean;
  split: Split;
  prompt: string;
}

export interface TriggerRun {
  id: string;
  split: Split;
  shouldTrigger: boolean;
  run: number;
  triggered: boolean;
  signals: TriggerSignal[];
  /** the `claude -p` process ended without a result event (crash, timeout, auth): not counted in the metrics */
  error: string | null;
  costUsd: number;
  seconds: number;
}

export interface TriggerMetrics {
  /** counted runs (errors excluded) */
  runs: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** tp / (tp + fn); null without positive runs */
  recall: number | null;
  /** tp / (tp + fp); null when nothing triggered */
  precision: number | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way the transcript shows the skill `name` in use, in a fixed order, deduplicated. */
export function triggerSignals(turns: Turn[], name: string): TriggerSignal[] {
  const skillMd = new RegExp(`(^|[/\\\\\\s"'])${escape(name)}[/\\\\]SKILL\\.md\\b`);
  const found = new Set<TriggerSignal>();
  for (const call of turns.flatMap((t) => t.tools)) {
    const input = call.input;
    if (call.name === "Skill" && typeof input.skill === "string" && (input.skill === name || input.skill.endsWith(`:${name}`))) found.add("skill");
    if (call.name === "Read" && typeof input.file_path === "string" && skillMd.test(input.file_path)) found.add("read");
    if (call.name === "Bash" && typeof input.command === "string") {
      if (skillMd.test(input.command)) found.add("read"); // cat/head of SKILL.md is a read too
      if (isWtCommand(input.command)) found.add("wt");
    }
  }
  return (["skill", "read", "wt"] as const).filter((s) => found.has(s));
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);

export function triggerMetrics(runs: TriggerRun[]): TriggerMetrics {
  const counted = runs.filter((r) => !r.error);
  const n = (want: boolean, got: boolean) => counted.filter((r) => r.shouldTrigger === want && r.triggered === got).length;
  const tp = n(true, true);
  const fp = n(false, true);
  const fn = n(true, false);
  const tn = n(false, false);
  return { runs: counted.length, tp, fp, fn, tn, recall: ratio(tp, tp + fn), precision: ratio(tp, tp + fp) };
}

/** Checks the labelled prompt set: unique ids, both labels and both splits present. Returns problems, [] when fine. */
export function validatePrompts(prompts: TriggerPrompt[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of prompts) {
    if (ids.has(p.id)) problems.push(`duplicate id ${p.id}`);
    ids.add(p.id);
    if (typeof p.shouldTrigger !== "boolean") problems.push(`${p.id}: shouldTrigger must be true or false`);
    if (p.split !== "dev" && p.split !== "holdout") problems.push(`${p.id}: split must be dev or holdout`);
    if (typeof p.prompt !== "string" || !p.prompt.trim()) problems.push(`${p.id}: empty prompt`);
  }
  return problems;
}
