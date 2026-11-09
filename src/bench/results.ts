// Benchmark results: one record per run ("benchRuns"), graded by you on the Benchmark page, and
// the per-version score (success rate, median steps, time and cost per task). Records keep their
// numbers after the run's trace is gone (only the last 30 traces are kept).
import type { RunTrace } from "../agent/trace/trace.js";
import { costOf, PRICES } from "../core/llm/prices.js";
import type { UsageLog } from "../core/llm/usage.js";
import { BENCH_TASKS, taskById, type CheckResult } from "./tasks.js";
import { storageSettled, updateLocal } from "../core/storage/update.js";

export const DEFAULT_MAX_COST = 0.6; // dollars per run; the agent stops there (Settings: Benchmark page)
export const MAX_INTERVENTIONS = 1;
export interface BenchRun {
  id: string;
  taskId: string;
  version: string;
  startedAt: number;
  mode: "agent" | "chat";
  model: string;
  params: Record<string, string>;
  traceId?: string;
  outcome: string; // the trace's outcome (done, stopped, failed, out_of_steps, over_budget), or chat: done/stopped/failed
  steps: number;
  ms: number;
  cost: number;
  costKnown: boolean;
  interventions: number;
  summary: string;
  checks: CheckResult[];
  verdict?: "pass" | "fail";
  note?: string;
}
// What the side panel hands over when you press Run on the Benchmark page (chrome.storage.session).
export interface BenchPending { taskId: string; goal: string; mode: "agent" | "chat"; params: Record<string, string>; maxCost: number; tabId: number; ts: number }

// Answers you gave during a run: approvals, plans, questions.
export const interventionsIn = (t: RunTrace | null) => (t?.steps || []).flatMap(s => s.events).filter(e => e.kind !== "note").length;
export const passed = (r: BenchRun) => r.verdict === "pass" && r.interventions <= MAX_INTERVENTIONS;

// Under the "benchRuns" lock (core/storage/update): the panel saving a run and the Benchmark page
// grading another are different pages.
const update = (fn: (runs: BenchRun[]) => BenchRun[]) => updateLocal("benchRuns", (runs = []) => fn(runs));
export async function listBenchRuns(): Promise<BenchRun[]> {
  await storageSettled("benchRuns");
  return ((await chrome.storage.local.get("benchRuns")) as { benchRuns?: BenchRun[] }).benchRuns || [];
}
export const saveBenchRun = (run: BenchRun) => update(runs => [run, ...runs.filter(r => r.id !== run.id)]);
export const gradeBenchRun = (id: string, verdict: "pass" | "fail" | undefined, note?: string) =>
  update(runs => runs.map(r => r.id !== id ? r : { ...r, verdict, ...(note !== undefined && { note }) }));
export const deleteBenchRun = (id: string) => update(runs => runs.filter(r => r.id !== id));

// A finished agent run, from its trace.
export function benchRunFromTrace(p: BenchPending, t: RunTrace, version: string, memoriesAdded: string[]): BenchRun {
  const task = taskById(p.taskId)!;
  const summary = String(t.summary || t.error || "");
  return {
    id: t.id, taskId: p.taskId, version, startedAt: t.startedAt, mode: "agent", model: t.config.model, params: p.params, traceId: t.id,
    outcome: t.outcome, steps: t.steps.length, ms: (t.endedAt || Date.now()) - t.startedAt, cost: t.totals.cost, costKnown: t.totals.costKnown,
    interventions: interventionsIn(t), summary, checks: task.check({ summary, trace: t, memoriesAdded })
  };
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export interface VersionScore { version: string; tasksRun: number; passedTasks: number; graded: number; medianSteps: number; medianMs: number; medianCost: number; totalCost: number; runs: number }
// Per version: each task counts once, by its latest graded run (ungraded runs count for cost only).
export function scoreByVersion(runs: BenchRun[]): VersionScore[] {
  const versions = [...new Set(runs.map(r => r.version))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions.map(version => {
    const vr = runs.filter(r => r.version === version);
    const latest = BENCH_TASKS.map(t => vr.filter(r => r.taskId === t.id && r.verdict).sort((a, b) => b.startedAt - a.startedAt)[0]).filter(Boolean) as BenchRun[];
    return {
      version, runs: vr.length, tasksRun: new Set(vr.map(r => r.taskId)).size, graded: latest.length, passedTasks: latest.filter(passed).length,
      medianSteps: median(latest.map(r => r.steps)), medianMs: median(latest.map(r => r.ms)), medianCost: median(latest.map(r => r.cost)),
      totalCost: vr.reduce((a, r) => a + r.cost, 0)
    };
  });
}

// What a run of this task will probably cost: measured ~$0.012 per agent step on small pages
// (real-Chrome suite, 2026-11-01); real sites have bigger pages, so ~$0.025 per step is assumed.
export const COST_PER_STEP = 0.025;
export const estimateCost = (estSteps: number) => ({ low: estSteps * COST_PER_STEP * 0.5, high: estSteps * COST_PER_STEP * 1.6 });

// This month's spend in dollars from the usage log (models in the price table; others are listed, not guessed).
export function monthSpend(usage: UsageLog, now = new Date()): { cost: number; unpriced: string[] } {
  const month = now.toLocaleDateString("en-CA").slice(0, 7);
  let cost = 0;
  const unpriced = new Set<string>();
  for (const [day, models] of Object.entries(usage || {})) {
    if (!day.startsWith(month)) continue;
    for (const [model, u] of Object.entries(models)) {
      const c = costOf(model, u);
      if (c == null) unpriced.add(model); else cost += c;
    }
  }
  return { cost, unpriced: [...unpriced] };
}
export const isPriced = (model: string) => !!PRICES[model];

// One CSV line per run, for a spreadsheet.
export function benchCsv(runs: BenchRun[]): string {
  const cols = ["version", "task", "started", "outcome", "verdict", "passed", "interventions", "steps", "seconds", "cost_usd", "model", "note"];
  const q = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...runs.map(r => [r.version, `${taskById(r.taskId)?.n ?? ""} ${taskById(r.taskId)?.title ?? r.taskId}`, new Date(r.startedAt).toISOString(), r.outcome, r.verdict ?? "", passed(r) ? "yes" : "no", r.interventions, r.steps, Math.round(r.ms / 1000), r.costKnown ? r.cost.toFixed(4) : "", r.model, r.note ?? ""].map(q).join(","))].join("\n") + "\n";
}
