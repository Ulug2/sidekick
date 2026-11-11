// The action log: every irreversible thing a worker did (submit, send, trash, upload, visit a new
// site, share details), with what, when, why and which agent. Shown on the Jobs page (Activity)
// and later the Powerhouse; email trash entries carry their undo.
import type { ActionLogEntry, ActionKind } from "./types.js";
import { updateLocal } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";
import { redactSecrets } from "../core/security/guard.js";

export const LOG_MAX = 500;
export function logAction(e: { worker?: number | null; kind: ActionKind; what: string; why?: string; site?: string; jobId?: string; undo?: ActionLogEntry["undo"] }): Promise<void> {
  const entry: ActionLogEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), worker: e.worker ?? null, kind: e.kind,
    what: redactSecrets(e.what).text.slice(0, 300), why: redactSecrets(e.why || "").text.slice(0, 300), ...(e.site && { site: e.site }), ...(e.jobId && { jobId: e.jobId }), ...(e.undo && { undo: e.undo })
  };
  return updateLocal("actionLog", (list = []) => [entry, ...list].slice(0, LOG_MAX));
}
export async function readLog(limit = 100): Promise<ActionLogEntry[]> {
  return ((await readLocal("actionLog")).actionLog || []).slice(0, limit);
}
