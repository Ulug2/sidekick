// Run traces: every step of an agent run, saved as it happens (what the model got, a screenshot
// of the page, the model's reply and thinking, each action and its result, approvals, cost), so a
// run can be replayed on the Agent runs page (ui/runs) and exported. Local only, like all data.
import type { AgentState, AgentUI, ToolOutcome } from "../types.js";
import type { ModelResult, ToolCall, Usage } from "../../core/llm/types.js";
import type { Settings } from "../../core/llm/settings.js";
import { effectiveProvider, modelFor } from "../../core/llm/settings.js";
import { costOf } from "../../core/llm/prices.js";
import { pageTimeout, shrinkImage } from "../../core/browser/screen.js";
import { saveTrace, saveShot, startIndexEntry, type TraceIndexEntry } from "./store.js";

export const TRACE_SHOT_EDGE = 900; // enough to see the page; ~50 KB per step
export const TRACE_SHOT_MS = 4000;

export type TraceOutcome = "running" | "done" | "out_of_steps" | "over_budget" | "stopped" | "failed" | "interrupted";
export interface TraceCall { purpose: string; model: string; ms: number; usage: Usage; cost: number | null; stop: string | null }
export interface TraceAction {
  tool: string;
  args: unknown;
  label: string; // the step(s) as shown in the panel (fill_fields shows one per field, joined with " · ")
  ok: boolean;
  declined?: boolean;
  result: string; // what went back to the model (snapshots included)
  shots?: string[]; // images the agent took itself (screenshot tool)
  ms: number;
}
export interface TraceEvent { at: number; kind: "approve" | "plan" | "ask" | "note"; text: string; answer?: string }
export interface TraceStep {
  n: number;
  at: number;
  url: string;
  title: string;
  shot?: string; // storage key of the page as it looked before the model call
  shotNote?: string; // why there's no screenshot
  prompt?: string; // a message sent to the model this step (the task and first page; nudges)
  model?: TraceCall & { text: string; thinking: string; toolCalls: { name: string; args: unknown }[] };
  side: TraceCall[]; // other model calls during the step (safety checks, site notes)
  actions: TraceAction[];
  events: TraceEvent[];
}
export interface TraceTotals { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; costKnown: boolean }
export interface RunTrace {
  id: string;
  version: string;
  goal: string;
  startedAt: number;
  endedAt?: number;
  outcome: TraceOutcome;
  summary?: string | null;
  error?: string;
  start: { url: string; title: string };
  config: { provider: string; model: string; effort: string; approvalMode: string; trustedInput: boolean };
  steps: TraceStep[];
  totals: TraceTotals;
  shotKeys: string[];
}

const emptyTotals = (): TraceTotals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true });
// The first sentence of a system prompt says what a side call is for.
const purposeOf = (system: string) => (String(system).split(/(?<=[.!?])\s/)[0] || "model call").slice(0, 100);

export class TraceRecorder {
  trace: RunTrace;
  private agentSystem: string;
  private labels: string[] = [];
  // Thinking streams in before the call it belongs to is recorded; it waits here until then.
  private pendingThinking = "";
  private saving: Promise<void> = Promise.resolve();

  constructor(trace: RunTrace, agentSystem: string) {
    this.trace = trace;
    this.agentSystem = agentSystem;
  }
  get id() { return this.trace.id; }
  private get step(): TraceStep | undefined { return this.trace.steps.at(-1); }

  // Saves are queued so a slow write never lands after a newer one.
  save(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.trace)) as RunTrace;
    this.saving = this.saving.then(() => saveTrace(snapshot)).catch(err => console.warn("Couldn't save the run trace", err));
    return this.saving;
  }

  // Before each model call: where the page is and what it looks like.
  async beginStep(state: AgentState, prompt?: string): Promise<void> {
    const n = this.trace.steps.length + 1;
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    const step: TraceStep = { n, at: Date.now(), url: tab?.url || "", title: tab?.title || "", side: [], actions: [], events: [], ...(prompt && { prompt }) };
    this.trace.steps.push(step);
    const shot = await screenshotFor(state, tab);
    if (shot.dataUrl) {
      const key = `traceShot:${this.id}:${n}`;
      await saveShot(key, shot.dataUrl).then(() => { step.shot = key; this.trace.shotKeys.push(key); }, () => { step.shotNote = "couldn't save the screenshot"; });
    } else step.shotNote = shot.note;
    await this.save();
  }

  // Every model call made with the run's Stop signal (see watchModelCalls).
  onCall = (r: ModelResult, system: string): void => {
    const cost = costOf(r.model, r.usage);
    const call: TraceCall = { purpose: system === this.agentSystem ? "agent step" : purposeOf(system), model: r.model, ms: r.ms, usage: { ...r.usage }, cost, stop: r.stop };
    const t = this.trace.totals;
    t.calls++;
    t.input += r.usage?.input || 0;
    t.output += r.usage?.output || 0;
    t.cacheRead += r.usage?.cacheRead || 0;
    t.cacheWrite += r.usage?.cacheWrite || 0;
    if (cost == null) t.costKnown = false; else t.cost += cost;
    const step = this.step;
    if (!step) return;
    if (system === this.agentSystem && !step.model) {
      step.model = { ...call, text: r.text || "", thinking: this.pendingThinking, toolCalls: r.toolCalls.map(c => ({ name: c.name, args: c.args })) };
      this.pendingThinking = "";
      this.save(); // what it decided is stored before it acts
    } else step.side.push(call);
  };

  async action(call: ToolCall, r: ToolOutcome, ms: number): Promise<void> {
    const a: TraceAction = { tool: call.name, args: call.args, label: this.labels.join(" · "), ok: !r.failed, ...(r.declined && { declined: true }), result: r.text, ms };
    this.labels = [];
    const step = this.step!;
    if (r.images?.length) {
      a.shots = [];
      for (const [k, img] of r.images.entries()) {
        const key = `traceShot:${this.id}:${step.n}.${step.actions.length}.${k}`;
        try { await saveShot(key, img); a.shots.push(key); this.trace.shotKeys.push(key); } catch {}
      }
    }
    step.actions.push(a);
  }

  event(kind: TraceEvent["kind"], text: string, answer?: string): TraceEvent {
    const ev: TraceEvent = { at: Date.now(), kind, text, ...(answer !== undefined && { answer }) };
    this.step?.events.push(ev);
    this.save();
    return ev;
  }
  // A question to you is stored while it waits (answer "waiting…"), then with your answer.
  private async waitFor<T>(kind: TraceEvent["kind"], text: string, wait: Promise<T>, answerText: (v: T) => string): Promise<T> {
    const ev = this.event(kind, text, "waiting…");
    try {
      const v = await wait;
      ev.answer = answerText(v);
      return v;
    } catch (err: any) {
      ev.answer = err?.name === "AbortError" ? "stopped" : "no answer";
      throw err;
    } finally { this.save(); }
  }

  async finish(outcome: TraceOutcome, summary?: string | null, error?: string): Promise<void> {
    Object.assign(this.trace, { outcome, endedAt: Date.now(), summary: summary ?? null, ...(error && { error }) });
    await this.save();
  }

  // The panel's UI with every question, approval and note recorded on the way through.
  wrapUI(ui: AgentUI): AgentUI {
    return {
      ...ui,
      signal: ui.signal,
      step: (text, tool) => { this.labels.push(text); return ui.step(text, tool); },
      note: text => { if (text !== this.step?.model?.text) this.event("note", text); ui.note(text); }, // the model's own words are in step.model
      thinking: chunk => {
        const step = this.step;
        if (step?.model) step.model.thinking += chunk; else this.pendingThinking += chunk;
        ui.thinking?.(chunk);
      },
      approve: req => this.waitFor("approve", `${req.title}${req.detail ? `\n${req.detail}` : ""}`, ui.approve(req), ok => (ok ? "allowed" : "declined")),
      ...(ui.approvePlan && {
        approvePlan: req => this.waitFor("plan", `${req.items.map((x, i) => `${i + 1}. ${x}`).join("\n")}\nSites: ${req.sites.join(", ")}`, ui.approvePlan!(req),
          r => (r?.ok ? (r.autoSubmit ? "approved, submits without asking" : "approved") : "changes asked"))
      }),
      ask: question => this.waitFor("ask", question, ui.ask(question), answer => String(answer))
    };
  }
}

export async function startTrace(goal: string, state: AgentState, system: string): Promise<TraceRecorder> {
  const s: Settings = state.settings;
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  const trace: RunTrace = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    version: chrome.runtime?.getManifest?.().version || "",
    goal,
    startedAt: Date.now(),
    outcome: "running",
    start: { url: tab?.url || "", title: tab?.title || "" },
    config: { provider: effectiveProvider(s), model: modelFor(s, "smart"), effort: s.agentEffort, approvalMode: s.approvalMode, trustedInput: !!s.trustedInput },
    steps: [],
    totals: emptyTotals(),
    shotKeys: []
  };
  const entry: TraceIndexEntry = { id: trace.id, goal, startedAt: trace.startedAt, outcome: "running", steps: 0, cost: 0, costKnown: true, site: hostOf(trace.start.url) };
  await startIndexEntry(entry);
  const rec = new TraceRecorder(trace, system);
  await rec.save();
  return rec;
}

export const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

// A small picture of the agent's tab. With the debugger attached (real clicks) Chrome can take
// it even in a background tab; otherwise only when the tab is the one you're looking at.
// Never attaches the debugger just for this, and never waits more than a few seconds.
async function screenshotFor(state: AgentState, tab: chrome.tabs.Tab | null): Promise<{ dataUrl?: string; note?: string }> {
  if (!tab) return { note: "the tab was closed" };
  if (/^(chrome|chrome-extension|edge|about|devtools):/.test(tab.url || "")) return { note: "Chrome doesn't allow screenshots of its own pages" };
  try {
    let raw: string | undefined;
    if (state.input) raw = (await pageTimeout(state.input.screenshot(), TRACE_SHOT_MS).catch(() => null))?.dataUrl;
    if (!raw && tab.active) raw = await pageTimeout(chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }), TRACE_SHOT_MS);
    if (!raw) return { note: "background tab (screenshots there need real clicks and typing on)" };
    return { dataUrl: (await shrinkImage(raw, TRACE_SHOT_EDGE)).dataUrl };
  } catch (err: any) {
    return { note: `no screenshot (${String(err?.message || err).slice(0, 80)})` };
  }
}
