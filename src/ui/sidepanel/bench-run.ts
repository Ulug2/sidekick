// Runs a benchmark task handed over by the Benchmark page (chrome.storage.session "benchPending"):
// a new chat on the task's tab, the goal sent as you'd send it (Agent mode, or a chat message for
// chat tasks), then a result record for grading on the Benchmark page.
import { busy, chat, send, sendAgent, setAgentMode, startNewChat } from "./sidepanel.js";
import { addError } from "./messages.js";
import { getMemories } from "../../assistant/memory/memory.js";
import { loadTrace } from "../../agent/trace/store.js";
import { benchRunFromTrace, saveBenchRun, type BenchPending, type BenchRun } from "../../bench/results.js";
import { taskById } from "../../bench/tasks.js";
import { watchModelCalls } from "../../core/llm/call.js";
import { costOf } from "../../core/llm/prices.js";
import { getSettings, modelFor } from "../../core/llm/settings.js";
import { sleepMs } from "../../core/browser/screen.js";

export const BENCH_PENDING_MS = 60000; // a hand-off older than this is ignored (the panel was closed)
export const TAB_LOAD_MS = 20000;

// Taken by one panel only (a lock shared by the extension's pages), so a task never runs twice.
async function takePending(): Promise<BenchPending | null> {
  const take = async () => {
    const { benchPending: p } = (await chrome.storage.session.get("benchPending")) as { benchPending?: BenchPending };
    if (!p) return null;
    await chrome.storage.session.remove("benchPending");
    return Date.now() - p.ts > BENCH_PENDING_MS ? null : p;
  };
  return navigator.locks ? navigator.locks.request("sidekick-bench-pending", take) : take();
}

export async function checkBenchPending(): Promise<void> {
  const p = await takePending();
  if (!p) return;
  const task = taskById(p.taskId);
  if (!task) return;
  if (busy) { addError(`Benchmark task ${task.n} didn't start: Sidekick is busy. Stop the current task and press Run again.`); return; }
  // The task's tab must be loaded and in front: the agent starts on the active tab.
  const t0 = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(p.tabId).catch(() => null);
    if (!tab) { addError(`Benchmark task ${task.n} didn't start: its tab was closed.`); return; }
    if (tab.status === "complete" || Date.now() - t0 > TAB_LOAD_MS) break;
    await sleepMs(300);
  }
  await chrome.tabs.update(p.tabId, { active: true }).catch(() => {});
  const memoriesBefore = new Set((await getMemories()).map(m => m.id));
  const version = chrome.runtime.getManifest().version;
  startNewChat();
  let run: BenchRun | null = null;
  if (p.mode === "agent") {
    setAgentMode(true);
    const r = await sendAgent(p.goal, { maxCost: p.maxCost, tabId: p.tabId });
    const trace = r?.traceId ? await loadTrace(r.traceId) : null;
    const added = (await getMemories()).filter(m => !memoriesBefore.has(m.id)).map(m => m.text);
    if (trace) run = benchRunFromTrace(p, trace, version, added);
  } else {
    setAgentMode(false);
    const started = Date.now();
    const calls: { cost: number | null; model: string }[] = [];
    let unwatch = () => {};
    await send(p.goal, { onSignal: signal => { unwatch = watchModelCalls(signal, r => calls.push({ cost: costOf(r.model, r.usage), model: r.model })); } });
    unwatch();
    const last = chat.messages.at(-1);
    // No reply: the error the panel showed is the result (never an empty record).
    const error = last?.role === "assistant" ? "" : document.querySelector("#messages .msg.error:last-of-type")?.textContent?.trim() || "No reply (stopped or failed before answering).";
    const summary = last?.role === "assistant" ? String(last.text || "") : `Error: ${error}`;
    const added = (await getMemories()).filter(m => !memoriesBefore.has(m.id)).map(m => m.text);
    run = {
      id: `${Date.now().toString(36)}-chat`, taskId: p.taskId, version, startedAt: started, mode: "chat", model: [...new Set(calls.map(c => c.model))].join(" + ") || modelFor(await getSettings(), "fast"), params: p.params,
      outcome: error ? "failed" : last?.stopped ? "stopped" : "done", steps: calls.length, ms: Date.now() - started,
      cost: calls.reduce((a, c) => a + (c.cost || 0), 0), costKnown: calls.every(c => c.cost != null), interventions: 0, summary,
      checks: task.check({ summary, trace: null, memoriesAdded: added })
    };
  }
  if (run) await saveBenchRun(run);
}
