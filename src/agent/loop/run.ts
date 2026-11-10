// The agent loop: the model operates a tab through tools, one step at a time, until the task is
// done, it asks you, or it runs out of steps. Learns a shortcut and site notes at the end.
import { memoriesFor } from "../../assistant/memory/memory.js";
import { getProfile, type Profile } from "../../assistant/profile-core.js";
import type { AgentUI, AgentRunResult, AgentState, AgentFile } from "../types.js";
import { agentSystemPrompt } from "../prompt.js";
import { PROTECTED, setAgentSignal } from "../page-calls.js";
import { addToAgentGroup, finishAgentGroup } from "./tab-group.js";
import { snapshotTab } from "../perception/format.js";
import { AGENT_TOOLS } from "../tools.js";
import { planOpen, planText } from "./plan.js";
import { SNAPSHOT_TOOLS, runTool } from "../actions/run-tool.js";
import { learnFlow } from "../skills/shortcuts.js";
import { learnSiteNotes } from "../skills/site-notes.js";
import { siteOf } from "../../core/security/sites.js";
import { callAgentModel, watchModelCalls } from "../../core/llm/call.js";
import { startTrace, type TraceRecorder } from "../trace/trace.js";
import { getSettings } from "../../core/llm/settings.js";
import type { ModelMessage, ToolResult } from "../../core/llm/types.js";

export const AGENT_MAX_STEPS = 40;
export const KEEP_FULL_SNAPSHOTS = 2; // older page snapshots are shortened to save tokens

// ---------- the loop ----------

// ui: { step(text) -> handle {done(ok, detail), note(text)}, note(text), approve({title, detail}) -> Promise<bool>,
//       ask(question) -> Promise<string>, signal }
// opts.history: the chat so far, so a follow-up like "apply for the backend one" knows what
// "the backend one" is and which company you were looking at.
// opts.maxCost: stop once the run has cost this many dollars (benchmark runs); needs a priced model
// and recording, so it turns recording on. opts.record: record even if "Record agent runs" is off.
// opts.tabId: the tab to work in (benchmark runs); otherwise the active tab of this window.
// opts.tier: "fast" runs the whole task on the fast model (job-application batches); default "smart".
// opts.files: files the run may upload besides the resume (a cover letter PDF).
// opts.preApproved: sites where the user approved the work in advance (a batch they reviewed), with
// autoSubmit as in an approved plan: submits there don't ask again (payments, deleting, posting still do).
export async function runAgent(goal: string, ui: AgentUI, opts: { history?: string; userMessages?: string[]; maxCost?: number; record?: boolean; tabId?: number; tier?: "fast" | "smart"; files?: Record<string, AgentFile>; preApproved?: { sites: string[]; autoSubmit: boolean } } = {}): Promise<AgentRunResult> {
  const profile = await getProfile();
  const [tab] = opts.tabId ? [await chrome.tabs.get(opts.tabId)] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  const settings = await getSettings();
  const memories = await memoriesFor(goal, { relevant: 10, recent: 3 }).catch(() => []);
  const state: AgentState = { tabId: tab.id!, elements: {}, steps: [], settings, input: null, actionLog: [], errors: [], answers: [], safeSteps: [], siteTools: {}, shortcuts: {}, goal, visitOk: new Set(), shareOk: new Set() };
  const system = agentSystemPrompt(profile, { memories, assistantName: settings.assistantName });

  // Follow tabs the page opens because of the agent's own action (e.g. "Apply" opening a new
  // tab). Tabs you open yourself (Ctrl+T while looking at this page also counts as "opened by"
  // it in Chrome) are never followed: only within a few seconds of an agent click or key press,
  // and never Chrome's own pages.
  let newTabNote = "";
  const onCreated = (t: chrome.tabs.Tab) => {
    const recent = Date.now() - (state.lastActionAt || 0) < 4000;
    const url = t.pendingUrl || t.url || "";
    if (t.openerTabId === state.tabId && recent && !PROTECTED.test(url) && !/^chrome:\/\/newtab/.test(url)) {
      state.tabId = t.id!;
      addToAgentGroup(state, t.id!);
      newTabNote = "Note: that action opened a new tab; you're now working in it.\n\n";
    }
  };
  chrome.tabs.onCreated.addListener(onCreated);
  // You can keep using Chrome while the agent works: it carries on in its own tab.
  let toldBackground = false;
  const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
    // Tabs the page opens after an agent click can become active; check once it has moved there.
    setTimeout(() => {
      // Only switches in the agent's own window count (a batch works in its own window).
      if ((info.windowId == null || info.windowId === tab.windowId) && info.tabId !== state.tabId && !toldBackground && !state.finished) {
        toldBackground = true;
        ui.note("You switched tabs, so I'll keep working on the page in the background. Switching back isn't needed.");
      }
    }, 600);
  };
  chrome.tabs.onActivated?.addListener(onActivated);

  setAgentSignal(ui.signal);
  state.signal = ui.signal;
  state.tier = opts.tier;
  state.files = opts.files;
  if (opts.preApproved) {
    state.planApproval = { sites: new Set(opts.preApproved.sites), autoSubmit: opts.preApproved.autoSubmit };
    for (const s of opts.preApproved.sites) state.visitOk.add(s);
  }
  state.userContext = opts.userMessages || [];
  // The site you started on is yours to act on; others are checked the first time.
  const startSite = siteOf(tab.url || "");
  state.startSite = startSite;
  state.visitOk = new Set(startSite ? [startSite] : []);
  state.shareOk = new Set(startSite ? [startSite] : []);
  const history = String(opts.history || "").trim();
  const transcript: ModelMessage[] = [{ role: "user", text: `${history ? `Earlier in this chat (context for the task; the user's newest message is the task):\n${history}\n\n` : ""}Task: ${goal}\n\nCurrent page:\n${await snapshotTab(state)}` }];
  let summary = null;
  let nudges = 0;
  let outOfSteps = false, overBudget = false;
  // Several tasks get more steps: 40 for the first, 30 for each one after, up to 160.
  const budget = () => Math.min(160, AGENT_MAX_STEPS + 30 * Math.max(0, (state.plan?.length || 1) - 1));

  // The run's trace (Agent runs page): every step, saved as it happens. Recording never stops a run.
  let rec: TraceRecorder | null = null;
  if (settings.recordRuns !== false || opts.record || opts.maxCost) {
    try { rec = await startTrace(goal, state, system); ui.traceStarted?.(rec.id); ui = rec.wrapUI(ui); }
    catch (err) { console.warn("Couldn't start the run trace", err); rec = null; }
  }
  const unwatch = rec ? watchModelCalls(ui.signal, rec.onCall) : () => {};

  try {
    try {
      for (let step = 1; step <= budget(); step++) {
        if (ui.signal.aborted) throw new DOMException("Stopped", "AbortError");
        if (opts.maxCost && rec && rec.trace.totals.cost >= opts.maxCost) {
          overBudget = true;
          summary = `I stopped at the cost limit for this run ($${opts.maxCost.toFixed(2)}; spent $${rec.trace.totals.cost.toFixed(2)}).${state.plan ? `\n\n${planText(state.plan)}` : ""}\n\nThe page is where I left it.`;
          break;
        }
        trimTranscript(transcript);
        const newest = transcript.at(-1)!;
        await rec?.beginStep(state, newest.role === "user" ? newest.text : undefined);

        const reply = await callAgentModel({ system, transcript, tools: AGENT_TOOLS, signal: ui.signal, onThinking: ui.thinking, tier: state.tier });
        transcript.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
        if (reply.text) ui.note(reply.text);

        if (!reply.toolCalls.length) {
          // A reply without actions ends the run. That's how it used to stop after 1 of 4 jobs
          // ("I'll click Submit. Would you like to proceed?"). If work is left or it's asking in
          // plain text, send it back to work (twice at most).
          const open = planOpen(state.plan);
          const asking = /\?\s*$|\b(would you like|shall i|should i|do you want|let me know|i'll (now )?(click|submit|continue|proceed))\b/i.test(reply.text || "");
          if ((open.length || asking) && nudges < 2) {
            nudges++;
            transcript.push({ role: "user", text: open.length
              ? `Not finished: ${open.length} checklist item${open.length > 1 ? "s are" : " is"} still open:\n${planText(state.plan!)}\nKeep going with tools. If you need the user, use ask_user; for a submit, click it with final_action: true (the user approves there). Call done only when every item is done, failed or skipped.`
              : "A reply without a tool call ends the task. If you need the user's answer or decision, call ask_user (you'll get the answer and can continue). For a submit, click it with final_action: true; the user approves it there. If the task is complete, call done." });
            continue;
          }
          summary = reply.text || "Done.";
          break;
        }

        // Several actions in one turn: only the last one that changes the page returns a snapshot.
        const results = [];
        const calls = reply.toolCalls;
        const lastSnap = calls.map(c => SNAPSHOT_TOOLS.has(c.name)).lastIndexOf(true);
        for (const [i, call] of calls.entries()) {
          state.deferSnapshot = i < lastSnap && SNAPSHOT_TOOLS.has(call.name);
          const t0 = Date.now();
          const r = await runTool(call, state, ui, profile, () => { const n = newTabNote; newTabNote = ""; return n; });
          await rec?.action(call, r, Date.now() - t0);
          state.deferSnapshot = false;
          results.push({ id: call.id, name: call.name, text: r.text, images: r.images, isError: r.failed && !r.declined, snapshot: r.snapshot });
          if (r.done) { summary = r.summary; state.finished = true; }
        }
        transcript.push({ role: "tool", results });
        await rec?.save();
        if (summary !== null) break;

        if (step >= budget()) {
          outOfSteps = true;
          summary = `I stopped after ${step} steps without finishing.${state.plan ? `\n\n${planText(state.plan)}` : ""}\n\nThe page is where I left it; tell me to continue, or finish the rest yourself.`;
        }
      }
    } finally {
      await finishAgentGroup(state, state.finished);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onActivated?.removeListener(onActivated);
      await state.input?.detach();
    }
    const learned = state.finished ? await learnFromRun(state, profile, goal, ui.signal) : null;
    await rec?.finish(overBudget ? "over_budget" : outOfSteps ? "out_of_steps" : "done", summary);
    return { summary: summary as string | null, steps: state.steps, learned, plan: state.plan, ...(rec && { traceId: rec.id }) };
  } catch (err: any) {
    await rec?.finish(err?.name === "AbortError" ? "stopped" : "failed", null, err?.name === "AbortError" ? undefined : String(err?.message || err));
    throw err;
  } finally {
    unwatch();
  }
}

// After a finished task: save the steps that worked as a shortcut for the site, and (if the run
// hit problems) a few notes for next time. Never fails the run.
export async function learnFromRun(state: AgentState, profile: Profile, goal: string, signal?: AbortSignal): Promise<AgentRunResult["learned"]> {
  if (state.settings.learnSites === false) return null;
  const out: NonNullable<AgentRunResult["learned"]> = {};
  try {
    const a = await learnFlow(state.actionLog, profile, goal);
    if (a) out.shortcut = { id: a.id, title: a.title, site: a.site, steps: a.steps.length, automatic: a.steps.filter(s => !s.needsModel && !s.final && !s.optional).length };
  } catch (err) { console.warn("Couldn't save shortcut", err); }
  try {
    const site = state.actionLog.length ? state.actionLog.at(-1)!.site : "";
    if (site && (state.errors.length || state.answers.length)) {
      const notes = await learnSiteNotes({ site, goal, steps: state.safeSteps, errors: state.errors, answers: state.answers, signal });
      if (notes.length) out.notes = notes;
    }
  } catch (err: any) { if (err.name !== "AbortError") console.warn("Couldn't save site notes", err); }
  return out.shortcut || out.notes ? out : null;
}

// Keeps only the latest page snapshots in full; older ones are cut to their first lines.
// The newest full snapshot is never cut: later snapshots only list changes against it.
export function trimTranscript(transcript: ModelMessage[]): void {
  const toolMsgs = transcript.filter(m => m.role === "tool");
  let base: ToolResult | null = null;
  for (const m of toolMsgs) for (const r of m.results) if (r.snapshot === "full") base = r;
  toolMsgs.slice(0, -KEEP_FULL_SNAPSHOTS).forEach(m => {
    for (const r of m.results) {
      if (r.trimmed || r === base) continue;
      const cut = r.text.search(/(^|\n)(<untrusted_content[^>]*>\n)?Tab: /);
      if (cut > -1) r.text = (r.text.slice(0, cut).trim() + "\n[older page snapshot removed]").trim();
      r.images = [];
      r.trimmed = true;
    }
  });
  // The first message's snapshot too, once we're a few steps in.
  const first = transcript[0] as Extract<ModelMessage, { role: "user" }>;
  if (base && toolMsgs.length > KEEP_FULL_SNAPSHOTS && !first.trimmed) {
    first.text = first.text.replace(/\n\nCurrent page:\n[\s\S]*$/, "\n\n[initial page snapshot removed]");
    first.trimmed = true;
  }
}
