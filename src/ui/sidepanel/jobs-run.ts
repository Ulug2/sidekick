// Applications, run in the side panel one at a time from a queue (v1 Phase 4). Jobs enter it from
// three places: "Start now" on the Jobs page (session "jobBatch": every queued job, or `only` some),
// an approved job's alarm firing at its random time (jobs/daily.ts → firedAlarms), and Save &
// resume on a Needs You card. Each run: a cover letter first, then the agent, then a verdict from
// the trace, the exact answers it entered and a screenshot of the confirmation page.
// You approved the batch on the Jobs page, so submits on each job's own site don't ask again;
// anything else that needs you (a sign-in, a CAPTCHA, a question the profile can't answer) waits a
// while, then the job is marked "needs you" and the batch moves on. Stop: the Jobs page's Stop
// button (removes the hand-off) or the panel's own Stop.
import { busy, sendAgent, setAgentMode, startNewChat, stop } from "./sidepanel.js";
import { showToast } from "./messages.js";
import { loadTrace } from "../../agent/trace/store.js";
import { getProfile } from "../../assistant/profile-core.js";
import { readLocal } from "../../core/storage/schema.js";
import { sleepMs } from "../../core/browser/screen.js";
import { currentSpend, overCap } from "../../core/llm/budget.js";
import { getSettings } from "../../core/llm/settings.js";
import { approvedSitesFor, newTask } from "../../orchestrator/workers.js";
import { DEFAULT_JOB_SETTINGS, getJobs, jobStats, setJobStatus } from "../../jobs/store.js";
import { letterFileName, writeCoverLetter } from "../../jobs/cover.js";
import { judgeRun } from "../../jobs/batch.js";
import { textPdf } from "../../jobs/pdf.js";
import { updateLocal } from "../../core/storage/update.js";
import { takeFired } from "../../orchestrator/scheduler.js";
import { chromeHost } from "../../orchestrator/host.js";
import { logAction } from "../../orchestrator/log.js";
import { APPLY_PREFIX, cancelApplication } from "../../jobs/daily.js";
import { setNeedsYou, waitMs } from "../../jobs/needs-you.js";
import { redactSecrets } from "../../core/security/guard.js";
import type { RunTrace } from "../../agent/trace/trace.js";
import type { Job } from "../../jobs/types.js";

export const BATCH_PENDING_MS = 60000;
export const MAX_COST_PER_APPLICATION = 0.6; // dollars; the run stops there (needs a priced model)
export const PAUSE_BETWEEN_MS: [number, number] = [120000, 240000]; // a human pace between applications
export const ASK_WAIT_MS = 8 * 60000; // how long an approval may wait, beyond the Needs You wait, before the job is set aside
export const TAB_LOAD_MS = 20000;
let batchRunning = false;
// The batch works in its own Chrome window, opened behind yours and never focused, so you keep
// using Chrome while it applies (its tabs are the active ones of that window, so real clicks,
// typing and screenshots work there).
let batchWindowId: number | undefined;
export async function batchTab(url: string): Promise<chrome.tabs.Tab> {
  if (batchWindowId !== undefined && !(await chrome.windows.get(batchWindowId).catch(() => null))) batchWindowId = undefined;
  if (batchWindowId === undefined) {
    const w = await chrome.windows.create({ url, focused: false, type: "normal", width: 1100, height: 900 });
    if (!w?.id) throw new Error("Chrome didn't open a window for the batch.");
    batchWindowId = w.id;
    return w.tabs?.[0] || (await chrome.tabs.query({ windowId: w.id }))[0];
  }
  return chrome.tabs.create({ url, windowId: batchWindowId, active: true });
}

async function takeBatch(): Promise<{ only?: string[] } | null> {
  const take = async () => {
    const { jobBatch: b } = (await chrome.storage.session.get("jobBatch")) as { jobBatch?: { ts: number; only?: string[] } };
    if (!b) return null;
    await chrome.storage.session.remove("jobBatch");
    return Date.now() - b.ts <= BATCH_PENDING_MS ? { ...(b.only && { only: b.only }) } : null;
  };
  return navigator.locks ? navigator.locks.request("sidekick-job-batch", take) : take();
}
// The Jobs page's Stop removes the hand-off and sets this flag; the panel checks it between jobs.
const stopRequested = async () => !!(await chrome.storage.session.get("jobBatchStop")).jobBatchStop;

async function cap(): Promise<string> {
  const [{ jobSettings }, settings] = await Promise.all([readLocal("jobSettings"), getSettings()]);
  const s = { ...DEFAULT_JOB_SETTINGS, ...(jobSettings || {}) };
  const over = overCap(await currentSpend(), { daily: Number(settings.capDaily) || 0, monthly: Number(settings.capMonthly) || 0 });
  if (over) return over.message;
  if (jobStats(await getJobs()).appliedToday >= s.dailyCap) return `today's ${s.dailyCap} applications are done`;
  return "";
}

// Stops the run when an approval has waited too long (unattended batch). Questions end the run
// themselves after the Needs You wait (jobs/needs-you.ts), so they get a minute more here.
function watchForStall(signal: AbortSignal, questionMs: number): void {
  let since = 0;
  const tick = setInterval(() => {
    const open = document.querySelector(".agent-card.question:not(.answered), .agent-card.approve:not(.answered)");
    if (!open) { since = 0; return; }
    since ||= Date.now();
    const limit = open.matches(".question") ? questionMs + 60000 : (globalThis.SK_ASK_WAIT_MS ?? ASK_WAIT_MS);
    if (Date.now() - since > limit) { clearInterval(tick); stop(); }
  }, 5000);
  signal.addEventListener("abort", () => clearInterval(tick), { once: true });
}

// Exactly what the run typed, chose and uploaded (from its trace), secrets masked.
export function answersFrom(t: RunTrace | null): string[] {
  if (!t) return [];
  const tools = new Set(["type", "select_option", "pick_date", "set_checked", "upload_file", "fill_fields"]);
  return t.steps.flatMap(s => s.actions).filter(a => a.ok && tools.has(a.tool)).flatMap(a => a.label.split(" · ")).map(l => redactSecrets(l).text.slice(0, 300)).filter(Boolean).slice(0, 80);
}
// The confirmation page, as a small JPEG kept with the job (storage key jobShot:<id>).
async function confirmationShot(tab: chrome.tabs.Tab, jobId: string): Promise<string | undefined> {
  try {
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
    if (!url) return undefined;
    const key = `jobShot:${jobId}`;
    await chrome.storage.local.set({ [key]: url });
    return key;
  } catch { return undefined; }
}

// ---------- the queue ----------
const queue: string[] = [];
let stats = { done: 0, setAside: 0 };
function enqueue(ids: string[]): void { for (const id of ids) if (!queue.includes(id)) queue.push(id); }

// Alarms that fired for approved applications (also the ones that fired while the panel was closed).
export async function runDueApplications(): Promise<void> {
  const fired = await takeFired(APPLY_PREFIX);
  if (!fired.length) return;
  const jobs = await getJobs();
  // Only jobs still approved for that time: queued, with a time set, and the alarm is theirs.
  enqueue(fired.filter(f => jobs.some(j => j.id === f.name.slice(APPLY_PREFIX.length) && j.status === "queued" && j.scheduledAt && j.scheduledAt <= f.at + 60000)).map(f => f.name.slice(APPLY_PREFIX.length)));
  await drain();
}

export async function checkJobBatch(): Promise<void> {
  const b = await takeBatch();
  if (!b) return;
  const queued = (await getJobs()).filter(j => j.status === "queued").sort((x, y) => y.score - x.score).map(j => j.id);
  enqueue(b.only ? b.only.filter(id => queued.includes(id)) : queued);
  await drain();
}

async function drain(): Promise<void> {
  if (batchRunning) return; // the running loop picks the new jobs up
  batchRunning = true;
  await chrome.storage.session.remove("jobBatchStop");
  stats = { done: 0, setAside: 0 };
  let reason = "";
  try {
    while (queue.length) {
      if (await stopRequested()) { reason = "you pressed Stop"; queue.length = 0; break; }
      if ((reason = await cap())) { queue.length = 0; break; }
      // A chat or agent run of yours goes first; the application waits for it.
      if (busy) { await sleepMs(globalThis.SK_BUSY_POLL_MS ?? 15000); continue; }
      const id = queue.shift()!;
      const job = (await getJobs()).find(j => j.id === id && j.status === "queued");
      if (!job) continue;
      await applyOne(job);
      if (queue.length && !(await stopRequested())) {
        const [lo, hi] = PAUSE_BETWEEN_MS;
        await sleepMs(globalThis.SK_BATCH_PAUSE_MS ?? lo + Math.random() * (hi - lo));
      }
    }
  } finally {
    batchRunning = false;
    if (stats.done || stats.setAside || reason) showToast(`Applications: ${stats.done} sent, ${stats.setAside} need you${reason ? ` (${reason})` : ""}. Details on the Jobs page.`);
  }
}

async function applyOne(job: Job): Promise<void> {
  const profile = await getProfile();
  await cancelApplication(chromeHost, job.id); // it runs now: its alarm is no longer needed
  await setJobStatus(job.id, "applying", { needsYou: undefined });
  // The cover letter first (smart model, about a cent), saved with the job so you can read it.
  let files: Record<string, { name: string; type: string; base64: string }> | undefined;
  let letter = job.coverLetter || "";
  if (!letter && job.text) {
    try { letter = await writeCoverLetter(job, profile); await updateLocal("jobs", (list = []) => list.map(j => j.id !== job.id ? j : { ...j, coverLetter: letter })); }
    catch (err: any) { showToast(`No cover letter for ${job.company}: ${err.message}`); }
  }
  if (letter) files = { cover_letter: { name: letterFileName(profile, job.company), type: "application/pdf", base64: textPdf(letter, { title: `Cover letter – ${job.company}` }).base64 } };
  const tab = await batchTab(job.applyUrl);
  const t0 = Date.now();
  while (Date.now() - t0 < TAB_LOAD_MS) { const t = await chrome.tabs.get(tab.id!).catch(() => null); if (!t || t.status === "complete") break; await sleepMs(300); }
  startNewChat();
  setAgentMode(true);
  const goal = `Apply for this job using my profile: ${job.title} at ${job.company} (${job.location}). The application form is on this page (open it if there's an "Apply" button). I've already approved submitting this one, so submit it when every required field is filled.
First read the posting: if it requires US citizenship, permanent residency, a security clearance or "U.S. person" status, or says it can't sponsor a visa, don't apply: call done and say which sentence rules it out.
Work authorization, visa sponsorship and voluntary self-identification answers come only from my profile (Sidekick checks them). When you ask_user about one form field with fixed choices, pass the choices as options.${letter ? `\n\nCover letter (use it exactly). Put it in the cover letter field: a text box, or upload_file with file "cover_letter" where only a file is accepted. If there's no field called cover letter, use the "Additional information", "Anything else you'd like us to know", "Message" or "Notes" box (their placeholder or hint often says a cover letter can go there). Only skip it if the form has none of these.\n\n${letter}` : ""}`;
  // One numbered worker per application: the approved batch pre-approves this job's own sites.
  const task = await newTask({ kind: "apply", title: `Apply: ${job.title} at ${job.company}`, goal, policy: "approved-batch", approvedSites: approvedSitesFor([job.applyUrl, job.url]), files, jobId: job.id, countries: job.countries, tabId: tab.id!, maxCost: MAX_COST_PER_APPLICATION });
  // A question card left open by an earlier job (set aside after its wait) isn't this job's.
  for (const c of document.querySelectorAll(".agent-card.question:not(.answered), .agent-card.approve:not(.answered)")) c.classList.add("answered", "stale");
  const controller = new AbortController();
  watchForStall(controller.signal, await waitMs());
  const r = await sendAgent(goal, { tabId: tab.id!, maxCost: MAX_COST_PER_APPLICATION, task });
  controller.abort();
  const trace = r?.traceId ? await loadTrace(r.traceId) : null;
  const verdict = judgeRun(trace);
  const answers = answersFrom(trace);
  const shot = verdict.status === "applied" ? await confirmationShot(tab, job.id) : undefined;
  const now = (await getJobs()).find(j => j.id === job.id);
  // A run that stopped at a question without a card (an approval, Stop, an error) still gets one.
  if (verdict.status === "needs_you" && !now?.needsYou) await setNeedsYou(job.id, { jobId: job.id, workerId: task.id, since: Date.now(), stoppedAt: tab.url || job.applyUrl, url: job.applyUrl, questions: [{ question: verdict.note, fieldType: "human" }] });
  await setJobStatus(job.id, verdict.status, { note: verdict.note, answers, ...(shot && { shot }), ...(r?.traceId && { traceId: r.traceId }) });
  if (verdict.status === "applied") {
    stats.done++;
    await logAction({ worker: task.n, kind: "submit", what: `Applied: ${job.title} at ${job.company}`, why: `${answers.length} fields entered${shot ? "; confirmation screenshot saved" : ""}`, jobId: job.id }).catch(() => {});
    await chrome.tabs.remove(tab.id!).catch(() => {});
  } else stats.setAside++;
}
