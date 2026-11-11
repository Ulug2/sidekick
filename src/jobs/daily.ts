// The day's batch on a clock (v1 Phase 4): at 8 AM Eastern the service worker builds the batch
// (code only: the best eligible jobs, one per company, no model calls) and notifies him. Nothing is
// sent until he approves it on the Jobs page; approving gives each job a random time over the next
// hours (never two within 15 minutes) and an alarm. When an alarm fires, the side panel runs that
// application (ui/sidepanel/jobs-run.ts). If Chrome was closed at 8, the first wake after builds it.
import type { Host } from "../orchestrator/host.js";
import { schedule, listScheduled, spreadTimes, unschedule } from "../orchestrator/scheduler.js";
import { logAction } from "../orchestrator/log.js";
import { updateLocal, withStorageLock } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";
import { DEFAULT_JOB_SETTINGS, getJobs, jobStats, pickBatch } from "./store.js";

export const BATCH_ALARM = "batch-8am";
export const APPLY_PREFIX = "apply:";
export const BATCH_TZ = "America/New_York";

// Milliseconds to add to UTC to get the wall clock in tz at instant t.
function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(t)).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
// hour:00 in tz on the day of `t` (tz's calendar day).
export function atHourOn(t: number, hour: number, tz = BATCH_TZ): number {
  const local = new Date(t + tzOffset(t, tz));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour);
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
}
// The next hour:00 in tz strictly after now (DST-safe: computed per day, not now + 24 h).
export function nextAt(now: number, hour: number, tz = BATCH_TZ): number {
  const today = atHourOn(now, hour, tz);
  return today > now ? today : atHourOn(today + 30 * 3600e3, hour, tz); // tomorrow (midday +/- DST)
}

export interface DailySettings { dailyBatch: boolean; batchHour: number; batchSize: number; spreadHours: number; dailyCap: number }
export async function dailySettings(): Promise<DailySettings> {
  const s = { ...DEFAULT_JOB_SETTINGS, ...((await readLocal("jobSettings")).jobSettings || {}) };
  return { dailyBatch: s.dailyBatch !== false, batchHour: s.batchHour, batchSize: s.batchSize, spreadHours: s.spreadHours, dailyCap: s.dailyCap };
}

// Builds the day's batch: up to batchSize (and what's left of the daily cap), one job per company.
export async function buildDailyBatch(host: Host): Promise<string[]> {
  const s = await dailySettings();
  const now = host.now();
  let ids: string[] = [];
  await updateLocal("jobs", (list = []) => {
    const st = jobStats(list, now);
    ids = pickBatch(list, Math.max(0, Math.min(s.batchSize, s.dailyCap - st.appliedToday - st.queued)), now);
    return list.map(j => ids.includes(j.id) ? { ...j, status: "queued" as const, statusAt: now } : j);
  });
  await updateLocal("orchestrator", (o = {}) => ({ ...o, lastBatchAt: now }));
  const queued = (await getJobs()).filter(j => j.status === "queued" && !j.scheduledAt).length;
  if (queued) await host.notify("Today's job batch is ready", `${queued} job${queued > 1 ? "s" : ""}, one per company. Look them over and approve on the Jobs page; nothing is sent before that.`);
  return ids;
}

// Keeps the 8 AM alarm set, and builds a missed batch (Chrome was closed at 8). Called when the
// service worker starts and after the alarm fires.
// Under one lock: the service worker can start for several events at once.
export function ensureDailyBatch(host: Host): Promise<"built" | "scheduled" | "off"> {
  return withStorageLock("dailyBatch", () => ensureUnlocked(host));
}
async function ensureUnlocked(host: Host): Promise<"built" | "scheduled" | "off"> {
  const s = await dailySettings();
  if (!s.dailyBatch) { await unschedule(host, BATCH_ALARM); return "off"; }
  const now = host.now();
  const today = atHourOn(now, s.batchHour);
  const { orchestrator } = await readLocal("orchestrator");
  let built = false;
  if (now >= today && (orchestrator?.lastBatchAt || 0) < today) { await buildDailyBatch(host); built = true; }
  const have = (await listScheduled()).some(x => x.name === BATCH_ALARM && x.at > now);
  if (!have || built) await schedule(host, { name: BATCH_ALARM, at: nextAt(now, s.batchHour) });
  return built ? "built" : "scheduled";
}
// A settings change: set or clear the alarm only (never builds a batch on the spot).
export async function syncDailyAlarm(host: Host): Promise<void> {
  const s = await dailySettings();
  if (!s.dailyBatch) return unschedule(host, BATCH_ALARM);
  await schedule(host, { name: BATCH_ALARM, at: nextAt(host.now(), s.batchHour) });
}
// The alarm fired: today's batch is built once (a start-up catch-up may have done it already).
export const onBatchAlarm = (host: Host) => ensureDailyBatch(host);

// Approve: every queued job not yet timed gets a random time over the next spreadHours, logged.
export function approveSpread(host: Host, rnd: () => number = Math.random): Promise<{ id: string; at: number }[]> {
  return withStorageLock("dailyBatch", () => spreadUnlocked(host, rnd)); // a double click schedules once
}
async function spreadUnlocked(host: Host, rnd: () => number): Promise<{ id: string; at: number }[]> {
  const s = await dailySettings();
  const now = host.now();
  const todo = (await getJobs()).filter(j => j.status === "queued" && !j.scheduledAt).sort((a, b) => b.score - a.score);
  // Times start after the last one already planned, so two approvals never overlap.
  const last = Math.max(now, ...(await listScheduled()).filter(x => x.name.startsWith(APPLY_PREFIX)).map(x => x.at));
  const times = spreadTimes(todo.length, last, s.spreadHours, rnd);
  const plan = todo.map((j, i) => ({ id: j.id, at: times[i], company: j.company, title: j.title }));
  await updateLocal("jobs", (list = []) => list.map(j => { const p = plan.find(x => x.id === j.id); return p ? { ...j, scheduledAt: p.at } : j; }));
  for (const p of plan) {
    await schedule(host, { name: APPLY_PREFIX + p.id, at: p.at, payload: { jobId: p.id } });
    await logAction({ kind: "schedule", what: `Application to ${p.company} (${p.title}) set for ${new Date(p.at).toLocaleString("en-US", { timeZone: BATCH_TZ, weekday: "short", hour: "numeric", minute: "2-digit" })} ET`, why: "you approved the batch; times are random, at least 15 minutes apart", jobId: p.id });
  }
  return plan.map(({ id, at }) => ({ id, at }));
}
// Taking a job out of the batch (or applying by hand) cancels its alarm.
export async function cancelApplication(host: Host, jobId: string): Promise<void> {
  await unschedule(host, APPLY_PREFIX + jobId);
  // An alarm that already fired (panel closed) must not run it later either.
  await updateLocal("firedAlarms", (list = []) => list.filter(x => x.name !== APPLY_PREFIX + jobId));
  await updateLocal("jobs", (list = []) => list.map(j => j.id === jobId ? { ...j, scheduledAt: undefined } : j));
}
