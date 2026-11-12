// The Powerhouse scene, Silicon City (docs/powerhouse-redesign/01-architecture.md, 04-state-mapping.md):
// the only place that turns the real Sidekick and worker state into what the city shows. Pure: no
// DOM, no storage, no clock (now is passed in). Deterministic: the same input gives the same Scene,
// including slots. No robot exists without a worker record.
import type { NeedsYouItem, WorkerRecord } from "../../orchestrator/types.js";
import { liveBrainCalls, type BrainCall } from "../../orchestrator/activity.js";
import { CAPACITY, LANE_PHASES, type Zone } from "./city-layout.js";

export type SidekickMode =
  | "lift" // brain model call in flight: barbell press on the HQ roof
  | "whistle" // started a worker in the last 6 s: whistle + point + bubble + trace
  | "coach" // something runs, brain not calling: stands with clipboard, watching
  | "rest" // paused by the user / spend cap: sits on the roof, amber, awake
  | "sleep"; // nothing runs: asleep

export type Activity = "read" | "write" | "apply" | "start" | "ask" | "fail" | "done" | "stopped" | "nonews" | "wait";
export interface Slot { zone: Zone; index: number }
export type Tone = "cyan" | "amber" | "red" | "grey" | "gold";

export interface SceneWorker {
  id: string;
  n: number;
  activity: Activity;
  finishing: boolean; // paused while running: frozen pose, amber antenna, tag "finishing"
  title: string; // plain text
  step: string; // plain text: the current step, or the error
  slot: Slot | null; // null: overflow (list only)
  phase: number; // 0..1 lane phase for "apply"; 0 otherwise
  stepKey: string; // changes whenever the worker logs a new step (drives step pulses)
  tag: string; // badge tag: "?", "!", "done", "stopped", "no news", "z z", "finishing", or ""
  pill: { text: string; tone: Tone }; // the list's state pill
  rec: WorkerRecord; // the record, for the details drawer (model, cost, trace, tab)
}

export interface Scene {
  mood: "live" | "paused" | "idle";
  sidekick: { mode: SidekickMode; dispatchTo?: string; bubble?: string; row: string; pill: { text: string; tone: Tone } };
  workers: SceneWorker[]; // only those with a slot, sorted by n
  overflow: SceneWorker[]; // no room on the card; in the list only
  traffic: { archive: number; docks: number; plant: number; ring: number };
  animates: boolean; // true: the render loop may run
  chip: { text: string; tone: "run" | "pause" | "warn" | "idle" };
  line: [string, string]; // status line: bold lead + rest
  working: number; // workers on the job (read, write, apply, start), not finishing
  needsYou: number;
}

export interface CityInput {
  now: number;
  workers: WorkerRecord[];
  needsYou?: NeedsYouItem[];
  paused: "user" | "spendCap" | null;
  capWhich?: "daily" | "monthly"; // which spend cap, when paused by it
  brainCalls?: BrainCall[];
  lastDispatch?: { workerId: string; at: number } | null;
  sleepingUntil?: number | null; // the next batch time when the daily batch is on
  dismissed?: string[];
  formatTime?: (t: number) => string;
}

export const DISPATCH_MS = 6000, LEAVE_MS = 30000, NO_NEWS_MS = 15 * 60000, FAILED_KEEP_MS = 24 * 3600e3;
const RUNNING: Activity[] = ["read", "write", "apply", "start"];
const ZONE_OF: Record<Activity, Zone> = { read: "rack", write: "terminal", apply: "lane", start: "entrance", ask: "bench", done: "bench", stopped: "bench", nonews: "bench", wait: "bench", fail: "silos" };
const PILL: Record<Activity, { text: string; tone: Tone }> = {
  fail: { text: "failed", tone: "red" }, ask: { text: "needs you", tone: "amber" }, done: { text: "done", tone: "grey" }, stopped: { text: "stopped", tone: "grey" },
  nonews: { text: "no news", tone: "grey" }, wait: { text: "waiting", tone: "grey" }, start: { text: "starting", tone: "cyan" },
  apply: { text: "applying", tone: "cyan" }, read: { text: "reading", tone: "cyan" }, write: { text: "writing", tone: "cyan" }
};
const TAG: Partial<Record<Activity, string>> = { fail: "!", ask: "?", done: "done", stopped: "stopped", nonews: "no news", wait: "z z" };

// Worker → activity (04 › Worker → activity): the first rule that matches wins; null = gone.
export function activityOf(w: WorkerRecord, i: CityInput, needIds: Set<string>): Activity | null {
  const age = i.now - w.updatedAt;
  if ((i.dismissed || []).includes(w.id)) return null;
  if (w.status === "failed") return age > FAILED_KEEP_MS ? null : "fail";
  if (w.status === "needs_you" || (w.status === "working" && needIds.has(w.id))) return "ask";
  if (w.status === "done") return age > LEAVE_MS ? null : "done";
  if (w.status === "stopped") return age > LEAVE_MS ? null : "stopped";
  if (w.status === "working" && age >= NO_NEWS_MS) return "nonews";
  if (w.status === "queued") return "wait";
  const d = i.lastDispatch;
  if (d && d.workerId === w.id && i.now - d.at < DISPATCH_MS && i.now >= d.at - 2000) return "start";
  return w.kind === "apply" ? "apply" : w.kind === "write" ? "write" : "read"; // read, classify
}

export function deriveScene(i: CityInput): Scene {
  const needIds = new Set((i.needsYou || []).map(x => x.workerId));
  const all: SceneWorker[] = [];
  for (const w of [...i.workers].sort((a, b) => a.n - b.n || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))) {
    const activity = activityOf(w, i, needIds);
    if (!activity) continue;
    const finishing = i.paused !== null && RUNNING.includes(activity);
    all.push({
      id: w.id, n: w.n, activity, finishing, title: w.title, step: w.error ? `Error: ${w.error}` : w.step,
      slot: null, phase: 0, stepKey: String(w.steps ?? 0), tag: finishing ? "finishing" : TAG[activity] || "",
      pill: finishing ? { text: "finishing", tone: "gold" } : PILL[activity], rec: w
    });
  }
  // Slots: by n; on the bench, who needs him first.
  const used: Record<Zone, number> = { rack: 0, terminal: 0, lane: 0, entrance: 0, bench: 0, silos: 0 };
  const order = [...all].sort((a, b) => Number(b.activity === "ask") - Number(a.activity === "ask") || a.n - b.n);
  for (const w of order) {
    const zone = ZONE_OF[w.activity];
    if (used[zone] >= CAPACITY[zone]) continue;
    w.slot = { zone, index: used[zone]++ };
    if (zone === "lane") w.phase = LANE_PHASES[w.slot.index];
  }
  const workers = all.filter(w => w.slot).sort((a, b) => a.n - b.n);
  const overflow = all.filter(w => !w.slot);

  // Sidekick (04 › Sidekick → mode)
  const calls = liveBrainCalls(i.brainCalls, i.now);
  const d = i.lastDispatch;
  const dispatched = d && i.now - d.at < DISPATCH_MS && i.now >= d.at - 2000 ? workers.find(w => w.id === d.workerId) : undefined;
  const running = all.filter(w => RUNNING.includes(w.activity));
  const mode: SidekickMode = i.paused ? "rest" : dispatched ? "whistle" : calls.length ? "lift" : running.length ? "coach" : "sleep";
  const mood: Scene["mood"] = i.paused ? "paused" : mode === "sleep" ? "idle" : "live";
  const working = i.paused ? 0 : running.length;
  const needsYou = all.filter(w => w.activity === "ask").length;
  const live = mood === "live";
  const readers = all.filter(w => w.activity === "read").length, writers = all.filter(w => w.activity === "write").length, couriers = all.filter(w => w.activity === "apply").length;
  const traffic = {
    archive: live && readers + writers ? Math.min(9, 3 + 2 * (readers + writers)) : 0,
    docks: live && couriers ? Math.min(8, 3 + 2 * couriers) : 0,
    plant: live && working ? Math.min(8, 4 + working) : 0,
    ring: live && mode === "lift" ? 4 : 0
  };
  const animates = live && (["lift", "whistle", "coach"].includes(mode) || running.length > 0);

  const fmt = i.formatTime || ((t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  const s = (k: number, one: string, many: string) => (k === 1 ? one : many);
  const chip: Scene["chip"] = i.paused === "user" ? { text: running.length ? `Paused by you · ${running.length} finishing` : "Paused by you", tone: "pause" }
    : i.paused === "spendCap" ? { text: `Spend cap reached (${i.capWhich || "daily"})`, tone: "warn" }
    : working ? { text: `Running · ${working} working${needsYou ? ` · ${needsYou} ${s(needsYou, "needs", "need")} you` : ""}`, tone: "run" }
    : needsYou ? { text: `${needsYou} ${s(needsYou, "needs", "need")} you`, tone: "warn" }
    : calls.length ? { text: "Thinking", tone: "run" }
    : i.sleepingUntil ? { text: `Sleeping until ${fmt(i.sleepingUntil)}`, tone: "idle" }
    : { text: "Idle", tone: "idle" };
  const line: [string, string] = mode === "lift" ? ["Sidekick is thinking:", calls[0]?.what || "a decision"]
    : mode === "whistle" ? [`Sidekick started worker ${dispatched!.n}:`, dispatched!.title]
    : i.paused === "user" ? ["Paused.", "Workers finish the job they are on; nothing new starts."]
    : i.paused === "spendCap" ? ["Spend cap reached.", "Nothing new starts until it resets or you raise it in Settings → Spend."]
    : overflow.length ? [`${overflow.length} more ${s(overflow.length, "worker", "workers")}`, "than there is room for on the card: all are in the list below."]
    : mode === "coach" ? ["Sidekick is coaching:", `${working} ${s(working, "worker is", "workers are")} on the job.`]
    : ["Everyone is asleep.", i.sleepingUntil ? `The next batch is built at ${fmt(i.sleepingUntil)}.` : "Nothing is running."];
  const row = { lift: "Model call in flight · lifting on the HQ roof", whistle: `Started worker ${dispatched?.n}`, coach: "Coaching from the HQ roof", rest: i.paused === "user" ? "Paused by you" : "Paused: spend cap", sleep: "Sleeping on the HQ roof" }[mode];
  const pill = { lift: { text: "thinking", tone: "cyan" as Tone }, whistle: { text: "dispatching", tone: "cyan" as Tone }, coach: { text: "coaching", tone: "cyan" as Tone }, rest: { text: "resting", tone: "gold" as Tone }, sleep: { text: "asleep", tone: "grey" as Tone } }[mode];
  return {
    mood,
    sidekick: { mode, row, pill, ...(dispatched && { dispatchTo: dispatched.id, bubble: dispatched.title }) },
    workers, overflow, traffic, animates, chip, line, working, needsYou
  };
}

// The next moment time alone changes the scene (04 › Timers): the caller sets one timeout for it.
export function nextDeadline(i: CityInput): number | null {
  const t: number[] = [];
  if (i.lastDispatch) t.push(i.lastDispatch.at + DISPATCH_MS);
  for (const w of i.workers) {
    if (w.status === "done" || w.status === "stopped") t.push(w.updatedAt + LEAVE_MS);
    else if (w.status === "working") t.push(w.updatedAt + NO_NEWS_MS);
    else if (w.status === "failed") t.push(w.updatedAt + FAILED_KEEP_MS);
  }
  for (const c of i.brainCalls || []) t.push(c.startedAt + 3 * 60000); // a stale brain call stops counting
  if (i.sleepingUntil) t.push(i.sleepingUntil);
  const future = t.filter(x => x > i.now);
  return future.length ? Math.min(...future) : null;
}
