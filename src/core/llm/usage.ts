// Token usage per model per day (chrome.storage.local "usage"), for the Settings page.
import type { Usage } from "./types.js";

// ---------- usage tracking ----------

// Tokens per day (YYYY-MM-DD) per model; the last 90 days are kept.
export type UsageLog = Record<string, Record<string, Usage & { calls: number }>>;
export let usageQueue: Promise<void> = Promise.resolve();
export function recordUsage(model: string, u: Usage | undefined): Promise<void> {
  if (!u) return Promise.resolve();
  usageQueue = usageQueue.then(async () => {
    const { usage = {} } = (await chrome.storage.local.get("usage")) as { usage?: UsageLog };
    const day = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
    const d = (usage[day] ||= {});
    const m = (d[model] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    m.calls++;
    m.input += u.input || 0;
    m.output += u.output || 0;
    m.cacheRead += u.cacheRead || 0;
    m.cacheWrite += u.cacheWrite || 0;
    const days = Object.keys(usage).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 90))) delete usage[old];
    await chrome.storage.local.set({ usage });
  });
  return usageQueue;
}
