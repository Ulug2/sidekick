// Chrome notifications when the agent needs you or finishes while you're looking elsewhere.
import { getSettings } from "../../core/llm/settings.js";

// ---------- notifications ----------
// While the agent works you're often in another tab or app. When it needs you or finishes, a
// Chrome notification says so (only when the panel isn't what you're looking at).
export const notifyIds = new Set();
export async function notifyUser(kind: any, title: any, message: any) {
  try {
    if (!chrome.notifications?.create) return null;
    const s = await getSettings();
    if (s.notifyAgent === false) return null;
    if (document.visibilityState === "visible" && document.hasFocus()) return null;
    const id = `sk-${kind}-${Date.now()}`;
    await chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message: String(message || "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").slice(0, 240), priority: kind === "done" ? 0 : 2, requireInteraction: kind !== "done" });
    notifyIds.add(id);
    return id;
  } catch { return null; }
}
export function clearNotice(id: any) { if (id) { chrome.notifications?.clear?.(id); notifyIds.delete(id); } }
