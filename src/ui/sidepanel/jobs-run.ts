// Today's application batch, handed over by the Jobs page (chrome.storage.session "jobBatch"):
// one agent run per queued job, in order, with a cover letter written first, at a human pace.
// You approved the batch on the Jobs page, so submits on each job's own site don't ask again;
// anything else that needs you (a sign-in, a CAPTCHA, a question the profile can't answer) waits a
// while, then the job is marked "needs you" and the batch moves on. Stop: the Jobs page's Stop
// button (removes the hand-off) or the panel's own Stop.
import { busy, sendAgent, setAgentMode, startNewChat, stop } from "./sidepanel.js";
import { addError, showToast } from "./messages.js";
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

export const BATCH_PENDING_MS = 60000;
export const MAX_COST_PER_APPLICATION = 0.6; // dollars; the run stops there (needs a priced model)
export const PAUSE_BETWEEN_MS: [number, number] = [120000, 240000]; // a human pace between applications
export const ASK_WAIT_MS = 8 * 60000; // how long a question or approval may wait before the job is set aside
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

async function takeBatch(): Promise<boolean> {
  const take = async () => {
    const { jobBatch: b } = (await chrome.storage.session.get("jobBatch")) as { jobBatch?: { ts: number } };
    if (!b) return false;
    await chrome.storage.session.remove("jobBatch");
    return Date.now() - b.ts <= BATCH_PENDING_MS;
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

// Stops the run when a question or approval has waited too long (unattended batch).
function watchForStall(signal: AbortSignal): void {
  let since = 0;
  const tick = setInterval(() => {
    const open = document.querySelector(".agent-card.question:not(.answered), .agent-card.approve:not(.answered)");
    if (!open) { since = 0; return; }
    since ||= Date.now();
    if (Date.now() - since > (globalThis.SK_ASK_WAIT_MS ?? ASK_WAIT_MS)) { clearInterval(tick); stop(); }
  }, 5000);
  signal.addEventListener("abort", () => clearInterval(tick), { once: true });
}

export async function checkJobBatch(): Promise<void> {
  if (!(await takeBatch())) return;
  if (busy || batchRunning) { addError("The application batch didn't start: Sidekick is busy. Stop the current task and press Approve & start batch again."); return; }
  batchRunning = true;
  await chrome.storage.session.remove("jobBatchStop");
  const profile = await getProfile();
  let done = 0, setAside = 0, reason = "";
  try {
    for (;;) {
      if (await stopRequested()) { reason = "you pressed Stop"; break; }
      if ((reason = await cap())) break;
      const job = (await getJobs()).filter(j => j.status === "queued").sort((a, b) => b.score - a.score)[0];
      if (!job) { reason = done || setAside ? "the batch is finished" : "the batch is empty"; break; }
      await setJobStatus(job.id, "applying");
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
First read the posting: if it requires US citizenship, permanent residency, a security clearance or "U.S. person" status, or says it can't sponsor a visa, don't apply: call done and say which sentence rules it out.${letter ? `\n\nCover letter (use it exactly). Put it in the cover letter field: a text box, or upload_file with file "cover_letter" where only a file is accepted. If there's no field called cover letter, use the "Additional information", "Anything else you'd like us to know", "Message" or "Notes" box (their placeholder or hint often says a cover letter can go there). Only skip it if the form has none of these.\n\n${letter}` : ""}`;
      // One numbered worker per application: the approved batch pre-approves this job's own sites.
      const task = await newTask({ kind: "apply", title: `Apply: ${job.title} at ${job.company}`, goal, policy: "approved-batch", approvedSites: approvedSitesFor([job.applyUrl, job.url]), files, jobId: job.id, tabId: tab.id!, maxCost: MAX_COST_PER_APPLICATION });
      const controller = new AbortController();
      watchForStall(controller.signal);
      const r = await sendAgent(goal, { tabId: tab.id!, maxCost: MAX_COST_PER_APPLICATION, task });
      controller.abort();
      const verdict = judgeRun(r?.traceId ? await loadTrace(r.traceId) : null);
      await setJobStatus(job.id, verdict.status, { note: verdict.note, ...(r?.traceId && { traceId: r.traceId }) });
      if (verdict.status === "applied") { done++; await chrome.tabs.remove(tab.id!).catch(() => {}); }
      else setAside++;
      if (await stopRequested()) { reason = "you pressed Stop"; break; }
      const [lo, hi] = PAUSE_BETWEEN_MS;
      await sleepMs(globalThis.SK_BATCH_PAUSE_MS ?? lo + Math.random() * (hi - lo));
    }
  } finally {
    batchRunning = false;
    showToast(`Applications: ${done} sent, ${setAside} need you${reason ? ` (${reason})` : ""}. Details on the Jobs page.`);
  }
}
