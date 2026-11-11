// Needs You (docs/BUGS.md 2, v1 Phase 4): when an application in an approved batch reaches a
// question memory can't answer, or a step only he can do (sign-in, CAPTCHA), Sidekick notifies him
// and waits needsYouWaitMinutes. Unanswered, the job is set aside with one card question per field
// (the literal question, the form's options). On the Jobs page he answers and presses Save &
// resume: the answers go to the answer bank and the job runs again, which then fills them from
// memory (memory/answers.ts resolves before asking).
import type { NeedsYouItem, NeedsYouQuestion, WorkerTask } from "../orchestrator/types.js";
import { chromeHost } from "../orchestrator/host.js";
import { logAction } from "../orchestrator/log.js";
import { updateLocal } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";
import { learnAnswer } from "../memory/answers.js";
import { setFact } from "../memory/facts.js";
import { honestyKeyFor } from "../memory/honesty.js";
import { siteOf } from "../core/security/sites.js";
import { DEFAULT_JOB_SETTINGS } from "./store.js";

const YES_NO = /^(are|do|will|have|can|did|is|would|were) you\b/i;
export function questionsFor(parts: string[], options: string[] | undefined, human: boolean): NeedsYouQuestion[] {
  const qs = parts.map(p => p.replace(/^\s*[-•\d.)]+\s*/, "").trim()).filter(p => p.length > 2).slice(0, 12);
  if (human) return [{ question: qs.join(" ") || "A step only you can do (sign-in or a human check).", fieldType: "human" }];
  return qs.map(q => options?.length && qs.length === 1 ? { question: q, fieldType: "select", options: options.slice(0, 40) }
    : YES_NO.test(q) && q.length < 200 ? { question: q, fieldType: "select", options: ["Yes", "No"] }
    : /\b(upload|attach)\b/i.test(q) ? { question: q, fieldType: "file" }
    : { question: q, fieldType: "text" });
}

export async function waitMs(): Promise<number> {
  const hook = globalThis.SK_NEEDS_YOU_MS;
  if (hook !== undefined) return hook;
  const s = (await readLocal("jobSettings")).jobSettings;
  return Math.max(1, Number(s?.needsYouWaitMinutes ?? DEFAULT_JOB_SETTINGS.needsYouWaitMinutes)) * 60000;
}

// The answer if he gives it in time (in the panel), or null once the job was set aside.
export async function needsYouWait(answer: Promise<string>, o: { task: WorkerTask; questions: string[]; options?: string[]; human: boolean; url?: string; signal?: AbortSignal }): Promise<string | null> {
  const ms = await waitMs();
  chromeHost.notify("Sidekick needs you", `${o.task.title.replace(/^Apply: /, "")}: ${o.questions.join(" ").slice(0, 160)} (waiting ${Math.round(ms / 60000)} min, then it's on the Jobs page)`, "needs_you").catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(res => { timer = setTimeout(() => res(null), ms); });
  const aborted = new Promise<never>((_, rej) => o.signal?.addEventListener("abort", () => rej(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true }));
  try {
    const got = await Promise.race([answer.then(String), timeout, aborted]);
    if (got !== null) return got;
  } finally { clearTimeout(timer); }
  const item: NeedsYouItem = { jobId: o.task.jobId, workerId: o.task.id, since: Date.now(), stoppedAt: o.url || "", questions: questionsFor(o.questions, o.options, o.human), ...(o.task.tabId && { tabId: o.task.tabId }), ...(o.url && { url: o.url }) };
  await setNeedsYou(o.task.jobId!, item);
  await logAction({ worker: o.task.n, kind: "needs_you", what: `Set aside for you: ${o.questions.join(" ").slice(0, 200)}`, why: `no answer within ${Math.round(ms / 60000)} min`, jobId: o.task.jobId, ...(o.url && { site: siteOf(o.url) }) });
  return null;
}

export async function setNeedsYou(jobId: string, item: NeedsYouItem): Promise<void> {
  await updateLocal("jobs", (list = []) => list.map(j => j.id === jobId ? { ...j, needsYou: item } : j));
  await updateLocal("orchestrator", (o = {}) => ({ ...o, needsYou: [...(o.needsYou || []).filter(x => x.jobId !== jobId), item].slice(-50) }));
}

// Save & resume: each answer goes to the answer bank (with the form's options), the card goes
// away, and the job is queued to run again now. Human steps need no answer.
export async function resolveNeedsYou(jobId: string, answers: Record<number, string>): Promise<{ saved: number; missing: string[] }> {
  const job = ((await readLocal("jobs")).jobs || []).find(j => j.id === jobId);
  const item = job?.needsYou;
  if (!job || !item) return { saved: 0, missing: [] };
  const missing = item.questions.filter((q, i) => q.fieldType !== "human" && q.fieldType !== "file" && !String(answers[i] ?? "").trim()).map(q => q.question);
  if (missing.length) return { saved: 0, missing };
  let saved = 0;
  const site = siteOf(job.applyUrl);
  for (const [i, q] of item.questions.entries()) {
    const a = String(answers[i] ?? "").trim();
    if (!a || q.fieldType === "human" || q.fieldType === "file") continue;
    if (await learnAnswer(q.question, a, { fieldType: q.fieldType === "select" ? "select" : "text", ...(q.options && { options: q.options }), site })) saved++;
    // Sponsorship, US work authorization and self-identification answers also go to his profile:
    // the honesty check (memory/honesty.ts) reads only the profile.
    const key = honestyKeyFor(q.question);
    if (key) await setFact(key, a, "you").catch(() => {});
  }
  const now = Date.now();
  await updateLocal("jobs", (list = []) => list.map(j => j.id !== jobId ? j : { ...j, needsYou: undefined, status: "queued", statusAt: now, scheduledAt: undefined, note: "You answered; applying again." }));
  await updateLocal("orchestrator", (o = {}) => ({ ...o, needsYou: (o.needsYou || []).filter(x => x.jobId !== jobId) }));
  return { saved, missing: [] };
}
