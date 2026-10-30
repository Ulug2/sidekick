// Replaying a learned shortcut through the normal tools (every safety rule still applies).
import type { Shortcut, AgentState, AgentUI } from "../types.js";
import type { Profile } from "../../assistant/profile-core.js";
import { profileValues, findTarget } from "../skills/adapters.js";
import { captureTab } from "../perception/capture.js";
import { sleep, waitForTab } from "../page-calls.js";
import { runTool } from "./run-tool.js";

// ---------- replaying a learned shortcut ----------

export const stepWhat = (s: Shortcut["steps"][number]) => {
  const target = `${s.role} “${String(s.label || "").slice(0, 50)}”${s.question ? ` (${String(s.question).slice(0, 60)})` : ""}`;
  switch (s.tool) {
    case "type": return `type into ${target}`;
    case "select_option": return `choose in ${target}`;
    case "set_checked": return `${s.value === false ? "uncheck" : "check"} ${target}`;
    case "upload_file": return `attach the resume to ${target}`;
    case "press_key": return `press ${s.value} in ${target}`;
    default: return s.description ? `${s.description} (${target})` : `click ${target}`;
  }
};

// Runs the routine steps of a shortcut through the normal tools (so every safety rule and
// approval still applies), matching each step to the page by role, label and question.
// Returns { done: [labels], stop: why it stopped, failedAt: step index if a step failed }.
export async function replayShortcut(shortcut: Shortcut, state: AgentState, ui: AgentUI, profile: Profile): Promise<{ done: string[]; stop: string; failedAt?: number }> {
  const vals = profileValues(profile);
  const done = [];
  await captureTab(state);
  for (let i = 0; i < shortcut.steps.length; i++) {
    const s = shortcut.steps[i];
    const what = stepWhat(s);
    if (ui.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    if (s.final) return { done, stop: `step ${i + 1} is a final action (${what}). Review the form, then do it yourself; the user will be asked to approve.` };
    if (s.needsModel) return { done, stop: `step ${i + 1} needs your judgment: ${what}${s.hint ? ` (last time: ${s.hint})` : ""}. Do it, then carry on with the rest of the task.` };
    let value = s.value;
    if (s.valueKey) {
      value = vals[s.valueKey];
      if (!value) return { done, stop: `step ${i + 1} (${what}) needs "${s.valueKey}", which isn't in the profile. Ask the user or skip it.` };
    }
    const target = { ...s };
    if (s.labelKey) {
      if (!vals[s.labelKey]) return { done, stop: `step ${i + 1} (${what}) needs "${s.labelKey}", which isn't in the profile.` };
      target.label = vals[s.labelKey];
    }
    let id = findTarget(state.elements, target);
    if (!id) { await sleep(500); await captureTab(state); id = findTarget(state.elements, target); }
    if (!id) {
      if (s.optional) continue;
      return { done, stop: `couldn't find ${what} for step ${i + 1}; the page may be different from last time. Finish the task normally.`, failedAt: i };
    }
    // Already done (e.g. the site remembered the field)? Skip it.
    const line = state.elements[id].line || "";
    if (s.tool === "type" && value && line.includes(`value: "${String(value).slice(0, 40)}`)) { done.push(`${what} (already filled)`); continue; }
    if (s.tool === "set_checked" && new RegExp(`\\b${s.value === false ? "unchecked" : "checked"}\\b`).test(line) && !(s.value !== false && /\bunchecked\b/.test(line))) { done.push(`${what} (already set)`); continue; }

    const call = {
      id: `sc_${i}`,
      name: s.tool,
      args: s.tool === "type" ? { id, text: String(value) }
        : s.tool === "select_option" ? { id, option: String(value) }
        : s.tool === "set_checked" ? { id, checked: s.value !== false }
        : s.tool === "upload_file" ? { id, file: "resume" }
        : s.tool === "press_key" ? { id, key: value }
        : { id, description: s.description || `Click ${s.label}`, final_action: false }
    };
    state.deferSnapshot = true;
    const r = await runTool(call, state, ui, profile, () => "");
    state.deferSnapshot = false;
    if (r.failed) return { done, stop: `step ${i + 1} (${what}) didn't work: ${r.declined ? "the user declined" : r.errorMsg}. Finish the task normally.`, failedAt: i };
    done.push(what);
    if (["click", "press_key", "select_option", "upload_file"].includes(s.tool)) {
      await waitForTab(state.tabId);
      await captureTab(state);
    }
  }
  return { done, stop: "" };
}
