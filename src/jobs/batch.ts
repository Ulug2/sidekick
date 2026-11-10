// What one application run did, read from its trace (pure, so it can be tested without a panel).
import type { RunTrace } from "../agent/trace/trace.js";
import type { Job } from "./types.js";

// What the run did, from its trace: applied (a submit went through or it logged the application),
// a question or approval that waited for you, or a failure.
export function judgeRun(t: RunTrace | null): { status: Job["status"]; note: string } {
  if (!t) return { status: "needs_you", note: "The run wasn't recorded." };
  const actions = t.steps.flatMap(s => s.actions);
  const submitted = actions.some(a => a.ok && (a.tool === "log_application" || ((a.tool === "click" || a.tool === "click_at") && (a.args as { final_action?: boolean } | null)?.final_action)));
  // A question or approval nobody answered: still waiting, or the run was stopped while it waited.
  const waited = t.steps.flatMap(s => s.events).find(e => (e.kind === "ask" || e.kind === "approve") && (!e.answer || ["waiting…", "stopped", "no answer"].includes(e.answer)));
  if (t.outcome === "done" && submitted) return { status: "applied", note: String(t.summary || "").slice(0, 300) };
  if (waited) return { status: "needs_you", note: `Waiting for you: ${waited.text.slice(0, 200)}` };
  const summary = String(t.summary || "");
  // The agent read the posting and found he can't take it (citizens only, clearance, US person).
  if (t.outcome === "done" && /\b(citizen|citizenship|clearance|u\.?s\.? person|not eligible|cannot legally|didn't apply|did not apply)\b/i.test(summary)) return { status: "skipped", note: `Not eligible, not sent: ${summary.slice(0, 240)}` };
  if (t.outcome === "done") return { status: "needs_you", note: `Stopped before submitting: ${summary.slice(0, 240)}` };
  return { status: "needs_you", note: `${t.outcome.replace("_", " ")}${t.error ? `: ${t.error.slice(0, 200)}` : t.summary ? `: ${String(t.summary).slice(0, 200)}` : ""}` };
}

