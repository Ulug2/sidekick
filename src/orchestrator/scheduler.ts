// Scheduling on chrome.alarms, persisted so a Chrome restart recreates everything. Alarm names:
// "batch-8am", "apply:<jobId>", "remind:<id>", "watchdog". The service worker records fired alarms
// in storage; the orchestrator page (Powerhouse, Phase 6) drains them. Handlers are registered by
// the feature that owns the alarm (Phase 4: the batch and the applications).
import type { Host } from "./host.js";
import { updateLocal } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";

export interface Scheduled { name: string; at: number; payload?: Record<string, unknown> }
export const MIN_GAP_MS = 15 * 60000;

// Random times for n applications over the next `hours`, at least MIN_GAP_MS apart, in order.
export function spreadTimes(n: number, from: number, hours = 20, rnd: () => number = Math.random): number[] {
  if (n <= 0) return [];
  const span = hours * 3600e3;
  const gap = Math.min(MIN_GAP_MS, Math.floor(span / Math.max(1, n)));
  const times: number[] = [];
  let cursor = from + 60e3;
  for (let i = 0; i < n; i++) {
    const left = span - (cursor - from);
    const slack = Math.max(0, left - (n - i) * gap);
    const t = cursor + Math.floor(rnd() * Math.min(slack, span / n));
    times.push(t);
    cursor = t + gap;
  }
  return times;
}

export async function schedule(host: Host, s: Scheduled): Promise<void> {
  await updateLocal("scheduled", (list = []) => [...list.filter(x => x.name !== s.name), s].sort((a, b) => a.at - b.at));
  await host.alarms.create(s.name, s.at);
}
export async function unschedule(host: Host, name: string): Promise<void> {
  await updateLocal("scheduled", (list = []) => list.filter(x => x.name !== name));
  await host.alarms.clear(name);
}
export async function listScheduled(): Promise<Scheduled[]> {
  return (await readLocal("scheduled")).scheduled || [];
}
// After a restart: every scheduled item gets its alarm back (an overdue one fires in a minute).
export async function restoreAlarms(host: Host): Promise<number> {
  const list = await listScheduled();
  const have = new Set((await host.alarms.list()).map(a => a.name));
  let n = 0;
  for (const s of list) if (!have.has(s.name)) { await host.alarms.create(s.name, Math.max(s.at, host.now() + 60e3)); n++; }
  return n;
}
// The service worker calls this when an alarm fires; the item moves to the fired queue.
export async function markFired(name: string, at: number): Promise<void> {
  await updateLocal("scheduled", (list = []) => list.filter(x => x.name !== name));
  await updateLocal("firedAlarms", (list = []) => [...list, { name, at }].slice(-200));
}
export async function takeFired(): Promise<{ name: string; at: number }[]> {
  let taken: { name: string; at: number }[] = [];
  await updateLocal("firedAlarms", (list = []) => { taken = list; return []; });
  return taken;
}
