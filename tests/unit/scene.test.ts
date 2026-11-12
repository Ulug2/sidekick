// Silicon City scene contract (docs/powerhouse-redesign/04-state-mapping.md): every rule of every
// table, the boundaries (6 s, 30 s, 15 min, 24 h), slots and overflow, determinism, animates,
// traffic, chip and line texts, plain text, the next deadline. Pure: no DOM, no storage, no clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveScene, nextDeadline, activityOf, DISPATCH_MS, LEAVE_MS, NO_NEWS_MS, FAILED_KEEP_MS, type CityInput } from "../../src/ui/powerhouse/scene.js";
import { CAPACITY, SPOTS, LANE, LANE_PHASES, along, lanePosition, polylineLength, yawOf, ROUTES, ROADS } from "../../src/ui/powerhouse/city-layout.js";
import type { WorkerRecord } from "../../src/orchestrator/types.js";

const NOW = Date.parse("2026-11-12T15:00:00Z");
const w = (o: Partial<WorkerRecord>): WorkerRecord => ({ id: "w1", n: 1, kind: "apply", title: "Apply: SWE at Acme", model: "m", status: "working", step: "Page 1", startedAt: NOW - 60000, updatedAt: NOW - 1000, cost: 0, ...o });
const input = (o: Partial<CityInput> = {}): CityInput => ({ now: NOW, workers: [], paused: null, ...o });
const scene = (o: Partial<CityInput> = {}) => deriveScene(input(o));
const act = (rec: Partial<WorkerRecord>, o: Partial<CityInput> = {}) => activityOf(w(rec), input(o), new Set((o.needsYou || []).map(x => x.workerId)));

describe("worker → activity (04 table, first match wins)", () => {
  it.each([
    ["dismissed", { status: "failed" }, { dismissed: ["w1"] }, null],
    ["failed under 24 h", { status: "failed", updatedAt: NOW - FAILED_KEEP_MS }, {}, "fail"],
    ["failed over 24 h", { status: "failed", updatedAt: NOW - FAILED_KEEP_MS - 1 }, {}, null],
    ["needs you", { status: "needs_you" }, {}, "ask"],
    ["working with a Needs-You item", { status: "working" }, { needsYou: [{ workerId: "w1", since: NOW, stoppedAt: "", questions: [] }] }, "ask"],
    ["done at exactly 30 s", { status: "done", updatedAt: NOW - LEAVE_MS }, {}, "done"],
    ["done after 30 s", { status: "done", updatedAt: NOW - LEAVE_MS - 1 }, {}, null],
    ["stopped", { status: "stopped", updatedAt: NOW - 5000 }, {}, "stopped"],
    ["stopped after 30 s", { status: "stopped", updatedAt: NOW - LEAVE_MS - 1 }, {}, null],
    ["no news at exactly 15 min", { status: "working", updatedAt: NOW - NO_NEWS_MS }, {}, "nonews"],
    ["news just under 15 min", { status: "working", updatedAt: NOW - NO_NEWS_MS + 1 }, {}, "apply"],
    ["queued", { status: "queued" }, {}, "wait"],
    ["dispatched 5.999 s ago", {}, { lastDispatch: { workerId: "w1", at: NOW - DISPATCH_MS + 1 } }, "start"],
    ["dispatched exactly 6 s ago", {}, { lastDispatch: { workerId: "w1", at: NOW - DISPATCH_MS } }, "apply"],
    ["another worker was dispatched", {}, { lastDispatch: { workerId: "w9", at: NOW } }, "apply"],
    ["applying", { kind: "apply" }, {}, "apply"],
    ["reading", { kind: "read" }, {}, "read"],
    ["classifying reads", { kind: "classify" }, {}, "read"],
    ["writing", { kind: "write" }, {}, "write"]
  ] as const)("%s", (_n, rec, o, want) => {
    expect(act(rec as Partial<WorkerRecord>, o as Partial<CityInput>)).toBe(want);
  });
  it("tags and list pills follow the activity; paused while running → finishing (gold)", () => {
    const s = scene({ workers: [w({ id: "a", n: 1, status: "failed", error: "Boom" }), w({ id: "b", n: 2, status: "needs_you" }), w({ id: "c", n: 3, status: "done" }), w({ id: "d", n: 4, status: "queued" }), w({ id: "e", n: 5, kind: "read" })] });
    expect(s.workers.map(x => [x.activity, x.tag, x.pill.text, x.pill.tone])).toEqual([
      ["fail", "!", "failed", "red"], ["ask", "?", "needs you", "amber"], ["done", "done", "done", "grey"], ["wait", "z z", "waiting", "grey"], ["read", "", "reading", "cyan"]
    ]);
    expect(s.workers[0].step).toBe("Error: Boom");
    const p = scene({ workers: [w({ kind: "write" })], paused: "user" });
    expect(p.workers[0]).toMatchObject({ activity: "write", finishing: true, tag: "finishing", pill: { text: "finishing", tone: "gold" } });
  });
  it("stepKey is the step count, so every logged step changes it", () => {
    expect(scene({ workers: [w({ steps: 7 })] }).workers[0].stepKey).toBe("7");
    expect(scene({ workers: [w({})] }).workers[0].stepKey).toBe("0");
  });
  it("titles stay plain strings (the view must use textContent)", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const s = scene({ workers: [w({ title: evil })], lastDispatch: { workerId: "w1", at: NOW } });
    expect(s.workers[0].title).toBe(evil);
    expect(s.sidekick.bubble).toBe(evil);
  });
});

describe("Sidekick → mode, mood, animates (04)", () => {
  const reader = w({ kind: "read" });
  it.each([
    ["paused wins over everything", { paused: "user", workers: [reader], brainCalls: [{ id: "b", what: "x", startedAt: NOW }], lastDispatch: { workerId: "w1", at: NOW } }, "rest", "paused", false],
    ["spend cap is a pause", { paused: "spendCap", workers: [reader] }, "rest", "paused", false],
    ["dispatch beats lifting", { workers: [reader], brainCalls: [{ id: "b", what: "x", startedAt: NOW }], lastDispatch: { workerId: "w1", at: NOW - 100 } }, "whistle", "live", true],
    ["a dispatch to a worker not in the scene is ignored", { workers: [reader], lastDispatch: { workerId: "gone", at: NOW } }, "coach", "live", true],
    ["brain call alone: lift", { brainCalls: [{ id: "b", what: "x", startedAt: NOW }] }, "lift", "live", true],
    ["a stale brain call does not count", { brainCalls: [{ id: "b", what: "x", startedAt: NOW - 4 * 60000 }] }, "sleep", "idle", false],
    ["one reader: coach", { workers: [reader] }, "coach", "live", true],
    ["only a worker that needs you: asleep, still", { workers: [w({ status: "needs_you" })] }, "sleep", "idle", false],
    ["only a failed worker: asleep, still", { workers: [w({ status: "failed" })] }, "sleep", "idle", false],
    ["nothing: asleep", {}, "sleep", "idle", false]
  ] as const)("%s", (_n, o, mode, mood, animates) => {
    const s = scene(o as Partial<CityInput>);
    expect([s.sidekick.mode, s.mood, s.animates]).toEqual([mode, mood, animates]);
  });
  it("whistle names the worker and carries its title for the bubble", () => {
    const s = scene({ workers: [w({ n: 3, title: "Apply: Backend at Ramp" })], lastDispatch: { workerId: "w1", at: NOW } });
    expect(s.sidekick).toMatchObject({ mode: "whistle", dispatchTo: "w1", bubble: "Apply: Backend at Ramp", row: "Started worker 3" });
    expect(s.line).toEqual(["Sidekick started worker 3:", "Apply: Backend at Ramp"]);
  });
});

describe("slots (04 › Slots)", () => {
  it("5 readers: 3 on the rack, 2 in overflow, and the status line says so", () => {
    const s = scene({ workers: [1, 2, 3, 4, 5].map(n => w({ id: `r${n}`, n, kind: "read" })) });
    expect(s.workers.map(x => x.slot)).toEqual([0, 1, 2].map(index => ({ zone: "rack", index })));
    expect(s.overflow.map(x => x.n)).toEqual([4, 5]);
    expect(s.line).toEqual(["2 more workers", "than there is room for on the card: all are in the list below."]);
  });
  it("couriers get lane phases in slot order; capacities match the layout", () => {
    const s = scene({ workers: [1, 2, 3, 4, 5].map(n => w({ id: `a${n}`, n })) });
    expect(s.workers.map(x => x.phase)).toEqual(LANE_PHASES);
    expect(s.overflow).toHaveLength(1);
    for (const zone of ["rack", "terminal", "entrance", "bench", "silos"] as const) expect(SPOTS[zone]).toHaveLength(CAPACITY[zone]);
    expect(LANE_PHASES).toHaveLength(CAPACITY.lane);
  });
  it("the bench seats who needs you first, then by number", () => {
    const s = scene({ workers: [w({ id: "d", n: 1, status: "done" }), w({ id: "q", n: 7, status: "needs_you" }), w({ id: "s", n: 2, status: "stopped" })] });
    const bench = s.workers.filter(x => x.slot?.zone === "bench").sort((a, b) => a.slot!.index - b.slot!.index).map(x => x.id);
    expect(bench).toEqual(["q", "d", "s"]);
  });
  it("is deterministic: shuffled input gives the same slots", () => {
    const list = [1, 2, 3, 4, 5, 6, 7, 8].map(n => w({ id: `x${n}`, n, kind: n % 2 ? "read" : "apply", status: n === 8 ? "needs_you" : "working" }));
    const a = scene({ workers: list }), b = scene({ workers: [...list].reverse() });
    expect(b.workers.map(x => [x.id, x.slot])).toEqual(a.workers.map(x => [x.id, x.slot]));
    expect(b.overflow.map(x => x.id)).toEqual(a.overflow.map(x => x.id));
  });
});

describe("traffic, chip, line", () => {
  it("packets only while live: archive for readers and writers, docks for couriers, plant for anyone working, ring while lifting", () => {
    const s = scene({ workers: [w({ id: "r", n: 1, kind: "read" }), w({ id: "wr", n: 2, kind: "write" }), w({ id: "a", n: 3 })], brainCalls: [{ id: "b", what: "x", startedAt: NOW }] });
    expect(s.traffic).toEqual({ archive: 7, docks: 5, plant: 7, ring: 4 });
    expect(scene({ workers: [1, 2, 3, 4, 5].map(n => w({ id: `r${n}`, n, kind: "read" })) }).traffic.archive).toBe(9); // max 9
    expect(scene({ workers: [w({})], paused: "user" }).traffic).toEqual({ archive: 0, docks: 0, plant: 0, ring: 0 });
    expect(scene({}).traffic).toEqual({ archive: 0, docks: 0, plant: 0, ring: 0 });
  });
  it("chip texts", () => {
    expect(scene({ workers: [w({ id: "a", n: 1 }), w({ id: "q", n: 2, status: "needs_you" })] }).chip).toEqual({ text: "Running · 1 working · 1 needs you", tone: "run" });
    expect(scene({ workers: [w({})], paused: "user" }).chip).toEqual({ text: "Paused by you · 1 finishing", tone: "pause" });
    expect(scene({ paused: "spendCap", capWhich: "monthly" }).chip).toEqual({ text: "Spend cap reached (monthly)", tone: "warn" });
    expect(scene({ sleepingUntil: NOW + 3600e3, formatTime: () => "8:00 AM ET" }).chip).toEqual({ text: "Sleeping until 8:00 AM ET", tone: "idle" });
    expect(scene({}).chip).toEqual({ text: "Idle", tone: "idle" });
  });
  it("status lines", () => {
    expect(scene({ brainCalls: [{ id: "b", what: "Ranking 14 postings", startedAt: NOW }] }).line).toEqual(["Sidekick is thinking:", "Ranking 14 postings"]);
    expect(scene({ paused: "user" }).line[0]).toBe("Paused.");
    expect(scene({ sleepingUntil: NOW + 1, formatTime: () => "8:00 AM ET" }).line).toEqual(["Everyone is asleep.", "The next batch is built at 8:00 AM ET."]);
  });
});

describe("next deadline (04 › Timers)", () => {
  it("the earliest future one of: dispatch +6 s, done/stopped +30 s, running +15 min, failed +24 h, the next batch", () => {
    const i = input({ workers: [w({ id: "r", updatedAt: NOW - 1000 }), w({ id: "d", status: "done", updatedAt: NOW - 10000 }), w({ id: "f", status: "failed", updatedAt: NOW })], lastDispatch: { workerId: "r", at: NOW - 2000 }, sleepingUntil: NOW + 5 * 3600e3 });
    expect(nextDeadline(i)).toBe(NOW - 2000 + DISPATCH_MS);
    expect(nextDeadline({ ...i, lastDispatch: null })).toBe(NOW - 10000 + LEAVE_MS);
    expect(nextDeadline(input({ workers: [w({ status: "failed", updatedAt: NOW })] }))).toBe(NOW + FAILED_KEEP_MS);
    expect(nextDeadline(input())).toBeNull();
  });
});

describe("city layout (pure)", () => {
  it("along() walks a polyline; lanePosition ping-pongs and carries the crate only outbound", () => {
    expect(along([[0, 0], [10, 0], [10, 10]], 0.75)).toEqual({ x: 10, z: 5, dir: [0, 1] });
    const len = polylineLength(LANE);
    const out = lanePosition(0.2, 0), back = lanePosition(0.2, (1.2 * len) / 4.2); // u 0.4 → 1.6: the same point, coming back
    expect(out.outbound).toBe(true);
    expect(back.outbound).toBe(false);
    expect(back.x).toBeCloseTo(out.x); expect(back.z).toBeCloseTo(out.z); // same place, other direction
    expect(back.dir[0]).toBeCloseTo(-out.dir[0]); expect(back.dir[1]).toBeCloseTo(-out.dir[1]);
    expect(yawOf([0, 1])).toBe(0); expect(yawOf([1, 0])).toBeCloseTo(Math.PI / 2);
  });
  it("every route point and road stays on the board", () => {
    for (const p of [...ROADS, ...Object.values(ROUTES).flatMap(r => r.paths)].flat()) { expect(Math.abs(p[0])).toBeLessThanOrEqual(100); expect(Math.abs(p[1])).toBeLessThanOrEqual(60); }
  });
});

describe("worker records count their steps", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("workerStep adds one per logged step, under the same write", async () => {
    let store: Record<string, unknown> = { orchestrator: { workers: [w({ steps: 2 })] } };
    vi.stubGlobal("chrome", { storage: { local: { get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).map(x => [x, store[x]])), set: async (o: Record<string, unknown>) => { store = { ...store, ...o }; } } } });
    const { workerStep } = await import("../../src/orchestrator/workers.js");
    await workerStep("w1", "Page 2");
    await workerStep("w1", "Page 2");
    const rec = (store.orchestrator as { workers: WorkerRecord[] }).workers[0];
    expect(rec.steps).toBe(4);
    expect(rec.step).toBe("Page 2");
  });
});

// ---------- M2: the city (pure parts) ----------
import * as THREE from "three";
import { skyline, roadDist, EXCL, mergeStatic } from "../../src/ui/powerhouse/city.js";

describe("the city on the card", () => {
  it("the skyline is the same on every load, on the board, off the roads and out of every exclusion zone", () => {
    const a = skyline(), b = skyline();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(50); // 65 with the doc's exclusion zones
    for (const s of a) {
      expect(Math.abs(s.x) + s.w / 2).toBeLessThanOrEqual(97);
      expect(Math.abs(s.z) + s.d / 2).toBeLessThanOrEqual(58);
      expect(roadDist(s.x, s.z)).toBeGreaterThanOrEqual(Math.max(s.w, s.d) / 2 + 2.3);
      const m = Math.max(s.w, s.d) / 2;
      expect(EXCL.some(([x0, x1, z0, z1]) => s.x > x0 - m && s.x < x1 + m && s.z > z0 - m && s.z < z1 + m)).toBe(false);
      if (s.x > -66 && s.x < -30) expect(s.h).toBeLessThanOrEqual(5.5); // the archive robots stay visible
      if (s.z > 30) expect(s.h).toBeLessThanOrEqual(7); // the docks stay visible
    }
  });
  it("static meshes with one material and the same shadow flags merge into one; kept ones stay", () => {
    const g = new THREE.Group(), mat = new THREE.MeshStandardMaterial(), other = new THREE.MeshStandardMaterial();
    for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); m.position.x = i * 3; m.castShadow = true; g.add(m); }
    const kept = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); g.add(kept);
    g.add(new THREE.Mesh(new THREE.SphereGeometry(1), other));
    mergeStatic(g, new Set([kept]));
    expect(g.children).toHaveLength(3); // the 5 boxes as one, the kept box, the lone sphere
    const merged = g.children.find(c => c !== kept && (c as THREE.Mesh).material === mat) as THREE.Mesh;
    expect(merged.castShadow).toBe(true);
    merged.geometry.computeBoundingBox();
    expect(merged.geometry.boundingBox!.max.x).toBeCloseTo(12.5); // positions baked in
  });
});
