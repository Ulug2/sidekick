// The service worker. Clicking the toolbar icon (or pressing the shortcut) opens the side panel.
import type { SessionSchema } from "../core/storage/schema.js";
import { markFired, restoreAlarms } from "../orchestrator/scheduler.js";
import { chromeHost, QUIET_ALARM, flushQuietNotices } from "../orchestrator/host.js";
import { APPLY_PREFIX, BATCH_ALARM, ensureDailyBatch, onBatchAlarm } from "../jobs/daily.js";
import { readLocal } from "../core/storage/schema.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(details => {
  chrome.contextMenus.create({ id: "sidekick-rewrite", title: "Rewrite with Sidekick", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "sidekick-ask", title: "Ask Sidekick about this", contexts: ["selection"] });
  // First install: onboarding (API key, resume, profile). Updates: nothing pops up.
  if (details.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("profile.html?welcome=1") });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // sidePanel.open must run immediately inside the user gesture, so call it before anything async.
  chrome.sidePanel.open({ windowId: tab!.windowId });
  const pending: SessionSchema["pending"] = {
    mode: info.menuItemId === "sidekick-rewrite" ? "rewrite" : "ask",
    text: info.selectionText || "",
    ts: Date.now()
  };
  chrome.storage.session.set({ pending });
});

// ---------- the orchestrator's clock (docs/ARCHITECTURE.md §3.2) ----------
// Alarms survive Chrome restarts; fired ones are queued in storage for the page that runs them.
// The 8 AM batch is built right here (storage and code only, no model calls).
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === BATCH_ALARM) { onBatchAlarm(chromeHost).catch(console.error); return; }
  if (alarm.name === QUIET_ALARM) { flushQuietNotices().catch(console.error); return; }
  markFired(alarm.name, alarm.scheduledTime).then(() => alarm.name.startsWith(APPLY_PREFIX) ? applicationDue(alarm.name.slice(APPLY_PREFIX.length)) : undefined).catch(console.error);
});
// Applications run in the side panel; if it's closed, say so (it can only be opened by a click).
async function applicationDue(jobId: string): Promise<void> {
  const open = await chrome.runtime.getContexts?.({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] }).catch(() => []);
  if (open?.length) return;
  const job = ((await readLocal("jobs")).jobs || []).find(j => j.id === jobId);
  await chromeHost.notify("An application is due", `${job ? `${job.title} at ${job.company}` : "A job in your batch"}: open Sidekick's side panel and it starts (it waits until then).`, "due");
}
chrome.runtime.onStartup.addListener(() => { restoreAlarms(chromeHost).catch(console.error); });
// Every time the service worker starts (Chrome start, install, any event): keep the 8 AM alarm
// set, and build today's batch if 8 AM passed while Chrome was closed.
ensureDailyBatch(chromeHost).catch(console.error);
