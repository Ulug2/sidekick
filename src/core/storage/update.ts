// Read-modify-write on chrome.storage.local, one at a time. Two saves of the same list at once
// (the end-of-chat reflection adding a memory while the profile page deletes one, the side panel
// saving a benchmark run while the Benchmark page grades another) would otherwise both read the
// old list and the second write would drop the first one's change.
// The lock is a Web Lock, shared by every Sidekick page and the service worker (same origin), so
// it also orders writes from different pages. Where Web Locks don't exist (the jsdom tests), a
// queue per lock name orders writes inside the page.
import type { LocalSchema } from "./schema.js";

// The names writes are grouped under; a write that touches several keys uses one name for all.
export type StorageLock = "memories" | "docs" | "skills" | "adapters" | "siteNotes" | "applications" | "chats" | "usage" | "traceIndex" | "benchRuns" | "benchParams" | "evalRuns" | "jobs" | "jobCompanies" | "orchestrator" | "actionLog" | "scheduled" | "firedAlarms" | "assignments" | "reminders" | "facts" | "answers" | "profile" | "dailyBatch";

// Waiting longer than this for another page's write means something is stuck: the write goes
// ahead without the lock rather than never (LESSONS rule 4).
export const LOCK_WAIT_MS = 10000;

const queues = new Map<string, Promise<unknown>>();
function queued<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(name) || Promise.resolve()).then(fn);
  queues.set(name, next.catch(() => {}));
  return next;
}

// Runs fn while holding the lock. fn must not take the same lock again (it would wait for itself).
export function withStorageLock<T>(name: StorageLock, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
  if (!locks?.request) return queued(name, fn);
  let started = false;
  const run = () => { started = true; return fn(); };
  return locks.request(`sidekick-storage:${name}`, { signal: AbortSignal.timeout(LOCK_WAIT_MS) }, run).catch(err => {
    if (started) throw err; // fn's own error
    console.warn(`Sidekick: waited ${LOCK_WAIT_MS / 1000} s for the "${name}" storage lock; saving without it.`, err);
    return fn();
  }) as Promise<T>;
}

// Reads one key, lets fn change it, writes it back, all under the key's lock. fn returns the new
// value, or undefined to leave storage as it is.
export function updateLocal<K extends keyof LocalSchema & StorageLock>(key: K, fn: (current: LocalSchema[K] | undefined) => LocalSchema[K] | undefined | Promise<LocalSchema[K] | undefined>): Promise<void> {
  return withStorageLock(key, async () => {
    const current = ((await chrome.storage.local.get(key)) as Partial<LocalSchema>)[key];
    const next = await fn(current);
    if (next !== undefined) await chrome.storage.local.set({ [key]: next });
  });
}

// Waits until every write already started in this page under that name is done (for readers that
// must see them, like the Agent runs list right after a save).
export function storageSettled(name: StorageLock): Promise<void> {
  return withStorageLock(name, async () => {});
}
