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

export const WORKERS_KEEP = 30;
export const ROLE_FOR_KIND: Record<WorkerKind, Role> = { apply: "browser", read: "browser", write: "writer", classify: "classifier" };

// A new task with the next agent number (numbers restart each day: "Agent 1" every morning).
export async function newTask(t: Omit<WorkerTask, "id" | "n" | "role" | "context"> & { role?: Role }): Promise<WorkerTask> {
  const day = new Date().toLocaleDateString("en-CA");
  let n = 1;
  await updateLocal("orchestrator", (o = {}) => { n = o.counterDay === day ? (o.counter || 0) + 1 : 1; return { ...o, counterDay: day, counter: n }; });
  const context = t.kind === "apply" || t.kind === "read" ? sliceFor(await buildWorld(), t.kind) : undefined;
  return { ...t, id: `w-${Date.now().toString(36)}-${n}`, n, role: t.role || ROLE_FOR_KIND[t.kind], context };
}
// For an approved batch: the job's own sites (the form's ATS, the company's posting) are pre-approved.
export const approvedSitesFor = (urls: string[]) => [...new Set(urls.map(u => siteOf(u)).filter(Boolean))];

export async function upsertWorker(rec: Partial<WorkerRecord> & { id: string }): Promise<void> {
  await updateLocal("orchestrator", (o = {}) => {
    const list = (o.workers || []).filter(w => w.id !== rec.id);
    const old = (o.workers || []).find(w => w.id === rec.id);
    const next: WorkerRecord = { n: 0, kind: "apply", title: "", model: "", status: "queued", step: "", startedAt: Date.now(), cost: 0, ...old, ...rec, updatedAt: Date.now() } as WorkerRecord;
    return { ...o, workers: [next, ...list].slice(0, WORKERS_KEEP) };
  });
}
export async function startWorker(task: WorkerTask): Promise<WorkerRecord> {
  const s = await getSettings();
  const rec: WorkerRecord = { id: task.id, n: task.n, kind: task.kind, title: task.title, model: modelForRole(s, task.role).model, status: "working", step: "Starting", startedAt: Date.now(), updatedAt: Date.now(), cost: 0, jobId: task.jobId };
  await upsertWorker(rec);
  return rec;
}
export const workerStep = (id: string, step: string, cost?: number) => upsertWorker({ id, step: step.slice(0, 160), ...(cost != null && { cost }) });
export const finishWorker = (id: string, status: WorkerStatus, extra: Partial<WorkerRecord> = {}) => upsertWorker({ id, status, ...extra });
export async function listWorkers(): Promise<WorkerRecord[]> { return (await readLocal("orchestrator")).orchestrator?.workers || []; }
