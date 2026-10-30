// The agent's tab group: tabs it opens sit in one "Sidekick" group.
import type { AgentState } from "../types.js";

// ---------- the agent's tab group ----------
// Tabs the agent opens are kept in one "Sidekick" group, so you can see where it's working.
export async function addToAgentGroup(state: AgentState, tabId: number): Promise<void> {
  if (state.settings.agentTabGroup === false || !chrome.tabs.group || !chrome.tabGroups) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (state.groupId != null) { await chrome.tabs.group({ groupId: state.groupId, tabIds: [tabId] }); return; }
      state.groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(state.groupId, { title: "Sidekick · working", color: "orange" });
      return;
    } catch { state.groupId = null; } // you closed the group: start a new one
  }
}
export async function finishAgentGroup(state: AgentState, ok: boolean | undefined): Promise<void> {
  if (state.groupId == null) return;
  try { await chrome.tabGroups.update(state.groupId, { title: ok ? "Sidekick ✓" : "Sidekick" }); } catch {}
}
