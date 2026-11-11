// What the orchestrator needs from its surroundings (docs/ARCHITECTURE.md §3.2). The extension
// implements it with chrome.* today; an Electron main process can implement the same interface.
import { getSettings, type Settings } from "../core/llm/settings.js";
import { updateLocal } from "../core/storage/update.js";

// What a background notification is about; each can be turned off in Settings → Notifications.
export type NotifyKind = "needs_you" | "batch" | "due";
const KIND_SETTING: Record<NotifyKind, keyof Settings> = { needs_you: "notifyNeedsYou", batch: "notifyBatch", due: "notifyDue" };
// Pure. A kind he turned off never shows (the Needs-You card stays on the Jobs page, a due
// application waits for the panel). Quiet hours (local clock, "" = off; may wrap midnight, 22 → 7)
// hold notifications back until they end: chromeHost.notify keeps them and shows them then.
export function kindOn(kind: NotifyKind | undefined, s: Partial<Settings>): boolean {
  return !kind || s[KIND_SETTING[kind]] !== false;
}
const hourOf = (v: unknown) => v === "" || v == null ? NaN : Number(v);
// When the current quiet hours end (ms), or null when it isn't quiet now.
export function quietEndsAt(s: Partial<Settings>, now: Date): number | null {
  const from = hourOf(s.quietFrom), to = hourOf(s.quietTo);
  if (Number.isNaN(from) || Number.isNaN(to) || from === to) return null;
  const h = now.getHours();
  const quiet = from < to ? h >= from && h < to : h >= from || h < to;
  if (!quiet) return null;
  const end = new Date(now);
  end.setHours(to, 0, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime();
}
export function allowNotify(kind: NotifyKind | undefined, s: Partial<Settings>, now: Date): boolean {
  return kindOn(kind, s) && quietEndsAt(s, now) === null;
}
export const QUIET_ALARM = "notify-after-quiet";
// The quiet-hours alarm fired (service worker): one notification for everything held back.
export async function flushQuietNotices(): Promise<void> {
  let held: { title: string; message: string; at: number }[] = [];
  await updateLocal("heldNotices", list => { held = list || []; return []; });
  if (!held.length) return;
  const one = held.length === 1;
  await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: one ? held[0].title : `${held.length} things from quiet hours`, message: one ? held[0].message : held.map(n => n.title).join(" · ").slice(0, 240) });
}
export interface Host {
  now(): number;
  alarms: {
    create(name: string, at: number): Promise<void>; // absolute time, ms
    clear(name: string): Promise<void>;
    list(): Promise<{ name: string; at: number }[]>;
  };
  notify(title: string, message: string, kind?: NotifyKind): Promise<void>;
}

export const chromeHost: Host = {
  now: () => Date.now(),
  alarms: {
    create: async (name, at) => { await chrome.alarms.create(name, { when: at }); },
    clear: async name => { await chrome.alarms.clear(name); },
    list: async () => (await chrome.alarms.getAll()).map(a => ({ name: a.name, at: a.scheduledTime }))
  },
  notify: async (title, message, kind) => {
    try {
      // Settings unreadable: show it (fail open; a missed notice can leave a job waiting unseen).
      const s: Partial<Settings> = await getSettings().catch(() => ({}));
      if (!kindOn(kind, s)) return;
      const until = quietEndsAt(s, new Date());
      if (until !== null) {
        await updateLocal("heldNotices", (list = []) => [...list, { title, message, at: Date.now() }].slice(-20));
        await chrome.alarms.create(QUIET_ALARM, { when: until });
        return;
      }
      await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message });
    } catch { /* notifications off */ }
  }
};
