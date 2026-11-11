// The Powerhouse scene (docs/DESIGN.md §1, "The contract"): the one place that turns orchestrator
// state into what is drawn. Pure: no DOM, no storage, no clock (now is passed in). Every figure
// comes from a worker record; nothing is drawn without a real source.
import type { NeedsYouItem, WorkerRecord } from "../../orchestrator/types.js";
import { liveBrainCalls, type BrainCall } from "../../orchestrator/activity.js";
import { overCap, type Spend } from "../../core/llm/budget.js";

export type Pose = "pull" | "push" | "situp" | "sit" | "raise" | "slump";
export type Area = "bar" | "mat" | "bench" | "floor";
export type Coach = "idle" | "thinking" | "shouting" | "paused";
export interface Figure {
  id: string; n: number; pose: Pose; area: Area; slot: number; x: number; y: number;
  status: WorkerRecord["status"]; label: string; title: string; step: string; model: string; cost: number;
  startedAt: number; updatedAt: number; error?: string; traceId?: string; jobId?: string; tabId?: number;
  tag?: "?" | "!" | "done" | "stopped" | "finishing" | "no news"; animate: boolean; onStage: boolean;
}
export interface Scene {
  coach: Coach; coachTag?: string; thinkingAbout?: string;
  shout?: { text: string; workerId: string; from: { x: number; y: number }; to: { x: number; y: number }; facing: "left" | "right" };
  figures: Figure[]; // everything to list, in order; onStage says whether it is drawn
  hiddenCount: number; // on the list but no free slot on stage
  needsYou: number; working: number;
  chip: { text: string; tone: "run" | "pause" | "warn" | "idle" };
  nextChange: number | null; // ms until something changes by time alone (a shout ends, a worker leaves)
}
export interface SceneInput {
  now: number; workers: WorkerRecord[]; needsYou?: NeedsYouItem[]; paused?: string | null; brainCalls?: BrainCall[];
  lastShout?: { text: string; at: number; workerId: string }; spend: Spend; caps: { daily: number; monthly: number };
  nextBatchAt?: number | null; batchOn?: boolean; dismissed?: string[]; formatTime?: (t: number) => string;
}

export const SHOUT_MS = 6000, LEAVE_MS = 30000, FAILED_KEEP_MS = 24 * 3600e3, QUIET_MS = 15 * 60000;
export const SCALE = 0.8, FLOOR_Y = 760, BENCH_Y = 668;
// Slot x positions in the 1600×900 scene (docs/design/powerhouse-mockup.html).
export const SLOTS: Record<Area, number[]> = { bar: [262, 372, 482], mat: [920, 1110], bench: [1290, 1390, 1490], floor: [40, 620] };
const AREA_Y: Record<Area, number> = { bar: FLOOR_Y, mat: FLOOR_Y, bench: BENCH_Y, floor: FLOOR_Y };
export const COACH = { x: 800, y: FLOOR_Y };

const KIND_WORD: Record<WorkerRecord["kind"], string> = { apply: "applying", read: "reading", write: "writing", classify: "sorting" };

export function deriveScene(i: SceneInput): Scene {
  const now = i.now;
  const needIds = new Set((i.needsYou || []).map(x => x.workerId));
  const dismissed = new Set(i.dismissed || []);
  const userPause = i.paused === "you";
  const cap = overCap(i.spend, i.caps);
  const paused = userPause || !!cap;
  let nextChange: number | null = null;
  const soon = (t: number) => { const d = t - now; if (d > 0 && (nextChange === null || d < nextChange)) nextChange = d; };

  const figures: Figure[] = [];
  for (const w of [...i.workers].sort((a, b) => a.startedAt - b.startedAt || a.n - b.n)) {
    const base = { id: w.id, n: w.n, status: w.status, title: w.title, step: w.step, model: w.model, cost: w.cost, startedAt: w.startedAt, updatedAt: w.updatedAt, ...(w.error && { error: w.error }), ...(w.traceId && { traceId: w.traceId }), ...(w.jobId && { jobId: w.jobId }), ...(w.tabId && { tabId: w.tabId }) };
    const needs = w.status === "needs_you" || (needIds.has(w.id) && w.status !== "done" && w.status !== "failed");
    if (needs) { figures.push({ ...base, pose: "raise", area: "bench", label: `${KIND_WORD[w.kind]}, needs you`, tag: "?", animate: false, slot: -1, x: 0, y: 0, onStage: false }); continue; }
    if (w.status === "working") {
      // No step for 15 min: the run is probably gone (its side panel closed). It is not counted as
      // working and sits on the bench with "no news" until its record changes (Phase 9's watchdog
      // ends such runs). Pause doesn't cut a running application off mid-form: it finishes this
      // job and no new one starts.
      if (now - w.updatedAt > QUIET_MS) {
        figures.push({ ...base, pose: "sit", area: "bench", label: `${KIND_WORD[w.kind]}, no news for ${Math.round((now - w.updatedAt) / 60000)} min`, tag: "no news", animate: false, slot: -1, x: 0, y: 0, onStage: false });
        continue;
      }
      const pose: Pose = w.kind === "apply" ? "pull" : w.kind === "write" ? "situp" : "push";
      figures.push({ ...base, pose, area: pose === "pull" ? "bar" : "mat", label: paused ? `${KIND_WORD[w.kind]}, finishing this one` : KIND_WORD[w.kind], ...(paused && { tag: "finishing" as const }), animate: !paused, slot: -1, x: 0, y: 0, onStage: false });
      soon(w.updatedAt + QUIET_MS);
      continue;
    }
    if (w.status === "failed" && !dismissed.has(w.id) && now - w.updatedAt < FAILED_KEEP_MS) {
      figures.push({ ...base, pose: "slump", area: "floor", label: "failed", tag: "!", animate: false, slot: -1, x: 0, y: 0, onStage: false });
      soon(w.updatedAt + FAILED_KEEP_MS);
      continue;
    }
    if ((w.status === "done" || w.status === "stopped" || w.status === "queued") && (w.status === "queued" || now - w.updatedAt < LEAVE_MS)) {
      figures.push({ ...base, pose: "sit", area: "bench", label: w.status === "queued" ? "waiting" : w.status, ...(w.status !== "queued" && { tag: w.status as "done" | "stopped" }), animate: false, slot: -1, x: 0, y: 0, onStage: false });
      if (w.status !== "queued") soon(w.updatedAt + LEAVE_MS);
    }
  }

  // Slots: first come, first placed, per area; the rest are only on the list.
  const used: Record<Area, number> = { bar: 0, mat: 0, bench: 0, floor: 0 };
  // Who needs him gets a bench slot first.
  const order = [...figures].sort((a, b) => Number(b.pose === "raise") - Number(a.pose === "raise"));
  for (const f of order) {
    const k = used[f.area];
    if (k >= SLOTS[f.area].length) continue;
    used[f.area]++;
    f.slot = k; f.x = SLOTS[f.area][k]; f.y = AREA_Y[f.area]; f.onStage = true;
  }

  // Sidekick: paused > a brain call > a fresh shout > idle.
  const calls = liveBrainCalls(i.brainCalls, now);
  for (const c of calls) soon(c.startedAt + 3 * 60000);
  const target = i.lastShout && now - i.lastShout.at < SHOUT_MS && now >= i.lastShout.at - 2000 ? figures.find(f => f.id === i.lastShout!.workerId && f.onStage) : undefined;
  if (target) soon(i.lastShout!.at + SHOUT_MS);
  let coach: Coach = "idle", coachTag: string | undefined, shout: Scene["shout"];
  if (paused) { coach = "paused"; coachTag = userPause ? "paused by you" : `spend cap: ${cap!.which}`; }
  else if (calls.length) coach = "thinking";
  else if (target) {
    coach = "shouting";
    const facing = target.x < COACH.x ? "left" : "right";
    const hand = { x: COACH.x + (facing === "left" ? -62 : 62), y: COACH.y - 126 };
    shout = { text: i.lastShout!.text, workerId: target.id, from: hand, to: { x: target.x, y: target.y - (target.area === "bench" ? 110 : 120) * SCALE }, facing };
  }

  const working = figures.filter(f => f.status === "working" && f.pose !== "raise" && f.tag !== "no news").length;
  const needsYou = figures.filter(f => f.pose === "raise").length;
  const fmt = i.formatTime || ((t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  const chip: Scene["chip"] = userPause ? { text: working ? `Paused by you · ${working} finishing` : "Paused by you", tone: "pause" }
    : cap ? { text: `Spend cap reached (${cap.which})`, tone: "warn" }
    : working ? { text: `Running · ${working} working${needsYou ? ` · ${needsYou} need${needsYou === 1 ? "s" : ""} you` : ""}`, tone: "run" }
    : needsYou ? { text: `${needsYou} need${needsYou === 1 ? "s" : ""} you`, tone: "warn" }
    : calls.length ? { text: "Thinking", tone: "run" }
    : i.batchOn !== false && i.nextBatchAt ? { text: `Sleeping until ${fmt(i.nextBatchAt)}`, tone: "idle" }
    : { text: "Idle", tone: "idle" };
  return { coach, ...(coachTag && { coachTag }), ...(calls.length && { thinkingAbout: calls[0].what }), ...(shout && { shout }), figures, hiddenCount: figures.filter(f => !f.onStage).length, needsYou, working, chip, nextChange };
}

// One line per figure for the list and screen readers.
export function describe(f: Figure): string {
  return `Agent ${f.n}, ${f.label}: ${f.title}${f.step && f.status === "working" ? `. Step: ${f.step}` : ""}${f.error ? `. Error: ${f.error}` : ""}`;
}
