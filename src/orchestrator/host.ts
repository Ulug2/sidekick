// What the orchestrator needs from its surroundings (docs/ARCHITECTURE.md §3.2). The extension
// implements it with chrome.* today; an Electron main process can implement the same interface.
export interface Host {
  now(): number;
  alarms: {
    create(name: string, at: number): Promise<void>; // absolute time, ms
    clear(name: string): Promise<void>;
    list(): Promise<{ name: string; at: number }[]>;
  };
  notify(title: string, message: string): Promise<void>;
}

export const chromeHost: Host = {
  now: () => Date.now(),
  alarms: {
    create: async (name, at) => { await chrome.alarms.create(name, { when: at }); },
    clear: async name => { await chrome.alarms.clear(name); },
    list: async () => (await chrome.alarms.getAll()).map(a => ({ name: a.name, at: a.scheduledTime }))
  },
  notify: async (title, message) => {
    try { await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message }); } catch { /* notifications off */ }
  }
};
