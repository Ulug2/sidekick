// What the brain is doing right now, for the Powerhouse (docs/DESIGN.md §1): Sidekick does push-ups
// exactly while a brain model call is in flight. Each call is listed in chrome.storage.session
// (shared by every extension page, cleared when Chrome quits) from start to end; an entry older
// than BRAIN_STALE_MS (a page that closed mid-call) no longer counts.
import { withStorageLock } from "../core/storage/update.js";

export interface BrainCall { id: string; what: string; startedAt: number }
export const BRAIN_STALE_MS = 3 * 60000;

async function change(fn: (list: BrainCall[]) => BrainCall[]): Promise<void> {
  await withStorageLock("brainCalls", async () => {
    const { brainCalls = [] } = await chrome.storage.session.get("brainCalls") as { brainCalls?: BrainCall[] };
    await chrome.storage.session.set({ brainCalls: fn(brainCalls) });
  });
}

// Runs fn as one brain call: listed while it runs, removed when it ends (also on error or Stop).
export async function trackBrain<T>(what: string, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const id = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await change(list => [...list.filter(c => now() - c.startedAt < BRAIN_STALE_MS), { id, what: what.slice(0, 120), startedAt: now() }]).catch(() => {});
  try { return await fn(); }
  finally { await change(list => list.filter(c => c.id !== id)).catch(() => {}); }
}

// The calls in flight now (pure).
export function liveBrainCalls(list: BrainCall[] | undefined, now: number): BrainCall[] {
  return (list || []).filter(c => now - c.startedAt < BRAIN_STALE_MS && c.startedAt <= now + 5000);
}
