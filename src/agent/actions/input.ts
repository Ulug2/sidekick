// Acting on the page: page events through page/act.ts, or real input through Chrome's debugger.
import type { AgentState, PageAction, PageActionResult } from "../types.js";
import { pageScript } from "../page-calls.js";
import { skPageAct } from "../../page/act.js";
import { TrustedInput } from "../../core/browser/cdp.js";
import { pageDisarmLeavePrompt } from "../../page/leave-prompt.js";

export async function actInPage(state: AgentState, action: PageAction): Promise<PageActionResult> {
  const id = String(action.id ?? "");
  const [frameId, elId] = id.includes(":") ? [Number(id.split(":")[0]), id.split(":")[1]] : [0, id];
  const [res] = await pageScript({
    target: { tabId: state.tabId, frameIds: [frameId] },
    func: skPageAct,
    args: [{ ...action, id: elId || undefined }]
  });
  return res?.result || { ok: false, error: "The page didn't respond." };
}

// Real clicks/typing through Chrome's debugger, attached to whichever tab we're working in.
// In a background tab (you switched to another one) the agent uses page events instead: the
// debugger's input can stall there until the tab is visible again.
export async function trustedInput(state: AgentState): Promise<TrustedInput | null> {
  if (!state.settings.trustedInput) return null;
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (tab && tab.active === false) return null;
  if (state.inputTimedOut) return null;
  if (state.input?.attached && state.input.target.tabId === state.tabId) return state.input;
  if (state.input && state.input.target.tabId !== state.tabId) { await state.input.detach(); state.input = null; }
  if (state.inputFailedFor === state.tabId) return null;
  state.input = await TrustedInput.attach(state.tabId);
  if (!state.input) state.inputFailedFor = state.tabId;
  return state.input;
}

// Runs a real-input action; if the debugger stalls (background tab), stops using it for this run
// and returns false so the caller does the same action with page events instead.
export async function viaTrusted(state: AgentState, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); return true; }
  catch (err: any) {
    if (err.name !== "TrustedInputTimeout" && !/debugger|detached|not attached|Trusted input/i.test(err.message || "")) throw err;
    state.inputTimedOut = true;
    await state.input?.detach().catch(() => {});
    state.input = null;
    return false;
  }
}

// When the agent itself leaves a page (navigate, go back), a half-filled form's "Leave site?"
// prompt would block the tab and freeze the run. The agent chose to leave, so turn it off first.
export async function disarmLeavePrompt(state: AgentState): Promise<void> {
  try {
    await pageScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "MAIN", func: pageDisarmLeavePrompt });
  } catch {}
}
