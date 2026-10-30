// The service worker. Clicking the toolbar icon (or pressing the shortcut) opens the side panel.
import type { SessionSchema } from "../core/storage/schema.js";

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
