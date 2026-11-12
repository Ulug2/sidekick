// Workers: numbered, task-scoped runs on cheaper models. A browser worker is one agent run with a
// WorkerTask; a writer or classifier is one model call. Each worker has a record in storage
// ("orchestrator.workers") that the Powerhouse and the world state read.
import type { WorkerKind, WorkerRecord, WorkerStatus, WorkerTask } from "./types.js";
import { modelForRole, type Role } from "../core/llm/models.js";
import { getSettings } from "../core/llm/settings.js";
import { updateLocal } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";
import { buildWorld, sliceFor } from "./world.js";
import { siteOf } from "../core/security/sites.js";
import { redactSecrets, stripWrappers } from "../core/security/guard.js";

export const WORKERS_KEEP = 30;
export const ROLE_FOR_KIND: Record<WorkerKind, Role> = { apply: "browser", read: "browser", write: "writer", classify: "classifier" };

// The next agent number (numbers restart each day: "Agent 1" every morning).
async function nextNumber(): Promise<number> {
  const day = new Date().toLocaleDateString("en-CA");
  let n = 1;
  await updateLocal("orchestrator", (o = {}) => { n = o.counterDay === day ? (o.counter || 0) + 1 : 1; return { ...o, counterDay: day, counter: n }; });
  return n;
}
// A new task with the next agent number.
export async function newTask(t: Omit<WorkerTask, "id" | "n" | "role" | "context"> & { role?: Role }): Promise<WorkerTask> {
  const n = await nextNumber();
  const context = t.kind === "apply" || t.kind === "read" ? sliceFor(await buildWorld(), t.kind) : undefined;
  return { ...t, id: `w-${Date.now().toString(36)}-${n}`, n, role: t.role || ROLE_FOR_KIND[t.kind], context };
}
// For an approved batch: the job's own sites (the form's ATS, the company's posting) are pre-approved.
export const approvedSitesFor = (urls: string[]) => [...new Set(urls.map(u => siteOf(u)).filter(Boolean))];

export async function upsertWorker(rec: Partial<WorkerRecord> & { id: string }, newStep = false): Promise<void> {
  await updateLocal("orchestrator", (o = {}) => {
    const list = (o.workers || []).filter(w => w.id !== rec.id);
    const old = (o.workers || []).find(w => w.id === rec.id);
    const next: WorkerRecord = { n: 0, kind: "apply", title: "", model: "", status: "queued", step: "", startedAt: Date.now(), cost: 0, ...old, ...rec, updatedAt: Date.now() } as WorkerRecord;
    if (newStep) next.steps = (old?.steps || 0) + 1; // counted under the same lock as the write
    return { ...o, workers: [next, ...list].slice(0, WORKERS_KEEP) };
  });
}
// What Sidekick shouts when it dispatches a worker (the Powerhouse bubble, 6 s): the task's real
// title, never a template. Titles carry job-board text: no markup, no secrets, plain text only.
export function shoutFor(n: number, title: string): string {
  return `Agent ${n}! ${redactSecrets(stripWrappers(title)).text.replace(/\s+/g, " ").trim()}`.slice(0, 200);
}
async function dispatched(rec: WorkerRecord): Promise<void> {
  await upsertWorker(rec);
  await updateLocal("orchestrator", (o = {}) => ({ ...o, lastShout: { text: shoutFor(rec.n, rec.title), at: Date.now(), workerId: rec.id } }));
}
export async function startWorker(task: WorkerTask): Promise<WorkerRecord> {
  const s = await getSettings();
  const rec: WorkerRecord = { id: task.id, n: task.n, kind: task.kind, title: task.title, model: modelForRole(s, task.role).model, status: "working", step: "Starting", startedAt: Date.now(), updatedAt: Date.now(), cost: 0, jobId: task.jobId, ...(task.tabId && { tabId: task.tabId }) };
  await dispatched(rec);
  return rec;
}
// A worker that is one model call (a writer, a classifier): numbered, recorded from start to end,
// so the Powerhouse shows it (sit-ups for writing) only while the call really runs.
export async function runAsWorker<T>(kind: Exclude<WorkerKind, "apply" | "read">, title: string, fn: () => Promise<T>, extra: Partial<WorkerRecord> = {}): Promise<T> {
  const n = await nextNumber();
  const s = await getSettings();
  const id = `w-${Date.now().toString(36)}-${n}`;
  // The record is only for showing: a storage error here never stops or discards the work.
  await dispatched({ id, n, kind, title, model: modelForRole(s, ROLE_FOR_KIND[kind]).model, status: "working", step: "Writing", startedAt: Date.now(), updatedAt: Date.now(), cost: 0, ...extra }).catch(() => {});
  let out: T;
  try { out = await fn(); }
  catch (err: any) {
    await finishWorker(id, err?.name === "AbortError" || err?.name === "SpendCapError" ? "stopped" : "failed", { error: String(err?.message || err).slice(0, 200) }).catch(() => {});
    throw err;
  }
  await finishWorker(id, "done", { step: "Done" }).catch(() => {});
  return out;
}

// Pause (the Powerhouse button): no new application starts until Resume. One already running
// finishes (stopping a form half-filled would be worse); the runner checks before each job and
// again after the cover letter, before the form opens. The spend
// cap is not a pause flag: it is read live (core/llm/budget.ts), so it ends by itself.
export const USER_PAUSE = "you";
export async function setPaused(on: boolean): Promise<void> {
  await updateLocal("orchestrator", (o = {}) => ({ ...o, paused: on ? USER_PAUSE : null }));
}
export async function pausedByYou(): Promise<boolean> {
  return (await readLocal("orchestrator")).orchestrator?.paused === USER_PAUSE;
}
export const workerStep = (id: string, step: string, cost?: number) => upsertWorker({ id, step: step.slice(0, 160), ...(cost != null && { cost }) }, true);
export const finishWorker = (id: string, status: WorkerStatus, extra: Partial<WorkerRecord> = {}) => upsertWorker({ id, status, ...extra });
export async function listWorkers(): Promise<WorkerRecord[]> { return (await readLocal("orchestrator")).orchestrator?.workers || []; }
