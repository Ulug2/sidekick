// v1 Phase 6: the Powerhouse scene contract (docs/DESIGN.md §1): every figure from a real record,
// the shout for 6 s, done/stopped leave after 30 s, failed and needs-you stay, a run with no news
// for 15 min stops moving, the spend cap read live, slots and overflow; brain calls tracked from
// start to end; the shout text is the real title, plain and redacted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveScene, LEAVE_MS, SHOUT_MS, QUIET_MS, SLOTS } from "../../src/ui/powerhouse/scene.js";
import { trackBrain, liveBrainCalls, BRAIN_STALE_MS } from "../../src/orchestrator/activity.js";
import { shoutFor } from "../../src/orchestrator/workers.js";
import type { WorkerRecord } from "../../src/orchestrator/types.js";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const spend = { today: 0.1, month: 2, unpriced: [] };
const caps = { daily: 1, monthly: 25 };
const w = (o: Partial<WorkerRecord>): WorkerRecord => ({ id: "w1", n: 1, kind: "apply", title: "Apply: SWE at Acme", model: "m", status: "working", step: "Starting", startedAt: NOW - 1000, updatedAt: NOW - 1000, cost: 0, ...o });
const scene = (o: Partial<Parameters<typeof deriveScene>[0]> = {}) => deriveScene({ now: NOW, workers: [], spend, caps, ...o });

describe("Powerhouse scene", () => {
  it("nothing running: Sidekick stands, no figures, the chip shows the next batch", () => {
    const s = scene({ batchOn: true, nextBatchAt: NOW + 3600e3, formatTime: () => "8:00 AM ET" });
    expect(s).toMatchObject({ coach: "idle", figures: [], chip: { text: "Sleeping until 8:00 AM ET", tone: "idle" }, nextChange: null });
    expect(scene({ batchOn: false }).chip.text).toBe("Idle");
  });
  it("each kind of work has its pose and area; classify reads like reading", () => {
    const s = scene({ workers: [w({ id: "a" }), w({ id: "r", kind: "read" }), w({ id: "c", kind: "classify" }), w({ id: "wr", kind: "write" })] });
    expect(Object.fromEntries(s.figures.map(f => [f.id, `${f.pose}/${f.area}/${f.animate}`]))).toEqual({ a: "pull/bar/true", r: "push/mat/true", c: "push/mat/true", wr: "situp/mat/true" });
  });
  it("the shout lasts 6 s and only points at a worker on stage; the trace goes from the hand to it", () => {
    const shout = { text: "Agent 1! Apply: SWE at Acme", at: NOW - 1000, workerId: "w1" };
    const s = scene({ workers: [w({})], lastShout: shout });
    expect(s.coach).toBe("shouting");
    expect(s.shout).toMatchObject({ facing: "left", from: { x: 738 }, to: { x: SLOTS.bar[0] } });
    expect(s.nextChange).toBe(SHOUT_MS - 1000);
    expect(scene({ workers: [w({})], lastShout: { ...shout, at: NOW - SHOUT_MS - 1 } }).coach).toBe("idle");
    expect(scene({ workers: [], lastShout: shout }).coach).toBe("idle");
  });
  it("a brain call in flight wins over a shout; a stale one does not count", () => {
    const shout = { text: "x", at: NOW, workerId: "w1" };
    expect(scene({ workers: [w({})], lastShout: shout, brainCalls: [{ id: "b", what: "Pick the best 18", startedAt: NOW - 1000 }] })).toMatchObject({ coach: "thinking", thinkingAbout: "Pick the best 18" });
    expect(scene({ brainCalls: [{ id: "b", what: "x", startedAt: NOW - BRAIN_STALE_MS - 1 }] }).coach).toBe("idle");
  });
  it("done and stopped sit on the bench for 30 s, then leave; failed and needs-you stay", () => {
    const s = scene({ workers: [w({ id: "d", status: "done", updatedAt: NOW - 5000 }), w({ id: "s", status: "stopped", updatedAt: NOW - LEAVE_MS - 1 }), w({ id: "f", status: "failed", updatedAt: NOW - 3600e3 }), w({ id: "n", status: "needs_you", updatedAt: NOW - 3600e3 })] });
    expect(s.figures.map(f => `${f.id}:${f.pose}:${f.tag}`).sort()).toEqual(["d:sit:done", "f:slump:!", "n:raise:?"]);
    expect(s.nextChange).toBe(LEAVE_MS - 5000);
  });
  it("a dismissed failure is gone; a failure older than a day is gone", () => {
    expect(scene({ workers: [w({ status: "failed" })], dismissed: ["w1"] }).figures).toEqual([]);
    expect(scene({ workers: [w({ status: "failed", updatedAt: NOW - 25 * 3600e3 })] }).figures).toEqual([]);
  });
  it("a needsYou item makes a working worker raise its hand (the two keys disagree: trust needsYou)", () => {
    const s = scene({ workers: [w({})], needsYou: [{ workerId: "w1", since: NOW, stoppedAt: "", questions: [] }] });
    expect(s.figures[0]).toMatchObject({ pose: "raise", tag: "?", animate: false });
    expect(s.chip.text).toBe("1 needs you");
  });
  it("a working run with no news for 15 min leaves the bar, sits on the bench with 'no news' and is not counted as working", () => {
    const s = scene({ workers: [w({ updatedAt: NOW - QUIET_MS - 60000 })] });
    expect(s.figures[0]).toMatchObject({ pose: "sit", area: "bench", animate: false, tag: "no news", label: "applying, no news for 16 min" });
    expect(s.working).toBe(0);
    expect(s.chip.text).not.toMatch(/working/);
  });
  it("paused by him: Sidekick sits, a running worker says it is finishing this one (Pause never cuts a form off); the old 'spend-cap' value is ignored", () => {
    const s = scene({ workers: [w({})], paused: "you" });
    expect(s).toMatchObject({ coach: "paused", coachTag: "paused by you", chip: { text: "Paused by you · 1 finishing", tone: "pause" } });
    expect(s.figures[0]).toMatchObject({ animate: false, tag: "finishing", label: "applying, finishing this one" });
    expect(scene({ paused: "spend-cap" }).coach).toBe("idle");
  });
  it("the spend cap is read live from spend, daily or monthly", () => {
    expect(scene({ spend: { today: 1.2, month: 3, unpriced: [] } })).toMatchObject({ coach: "paused", coachTag: "spend cap: daily", chip: { tone: "warn" } });
    expect(scene({ spend: { today: 0.2, month: 26, unpriced: [] } }).coachTag).toBe("spend cap: monthly");
  });
  it("slots: three at the bar, the rest only on the list; who needs him gets a bench slot first", () => {
    const apply = [1, 2, 3, 4, 5].map(n => w({ id: `a${n}`, n, startedAt: NOW - 10000 + n }));
    const s = scene({ workers: apply });
    expect(s.figures.filter(f => f.onStage).map(f => f.x)).toEqual(SLOTS.bar);
    expect(s.hiddenCount).toBe(2);
    const bench = [1, 2, 3].map(n => w({ id: `d${n}`, n, status: "done", updatedAt: NOW - 1000, startedAt: NOW - 9000 + n }));
    const s2 = scene({ workers: [...bench, w({ id: "q", n: 9, status: "needs_you", startedAt: NOW })] });
    expect(s2.figures.find(f => f.id === "q")).toMatchObject({ onStage: true, slot: 0 });
    expect(s2.hiddenCount).toBe(1);
  });
});

describe("brain calls in flight", () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", { storage: { session: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => { Object.assign(store, o); } } } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("listed while the call runs, removed after, also when it throws", async () => {
    let during: unknown;
    await trackBrain("Pick the best 18", async () => { during = structuredClone(store.brainCalls); return 1; });
    expect(during).toMatchObject([{ what: "Pick the best 18" }]);
    expect(store.brainCalls).toEqual([]);
    await expect(trackBrain("x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.brainCalls).toEqual([]);
  });
  it("stale entries (a page closed mid-call) are dropped", () => {
    expect(liveBrainCalls([{ id: "a", what: "x", startedAt: NOW - BRAIN_STALE_MS - 1 }, { id: "b", what: "y", startedAt: NOW - 1000 }], NOW).map(c => c.id)).toEqual(["b"]);
  });
});

describe("the shout text", () => {
  it("is the real title, plain text, no fence, no secrets", () => {
    expect(shoutFor(3, "Apply: Backend Engineer at Stripe")).toBe("Agent 3! Apply: Backend Engineer at Stripe");
    const s = shoutFor(1, "Apply: x sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(s).not.toMatch(/sk-ant-api03-A{20}/);
  });
});

// ---------- the 3D card (gpu-layout.ts): numbers only, no WebGL ----------
import { SPOTS, ZONE_OF, BOARD, HEATPIPE, BODY, PULL, alienWeight, LOD, clampRadius, clampPolar, clampTarget, CAMERA, orbitPosition, placeFigures, FOCUS_AZIMUTH } from "../../src/ui/powerhouse/gpu-layout.js";

describe("3D card layout", () => {
  it("every slot of every area has a spot on its part of the card, inside the board", () => {
    for (const area of Object.keys(SLOTS) as (keyof typeof SLOTS)[]) {
      const spots = SPOTS[ZONE_OF[area]];
      expect(spots.length).toBe(SLOTS[area].length);
      for (const s of spots) { expect(Math.abs(s.x)).toBeLessThanOrEqual(BOARD.w / 2); expect(Math.abs(s.z)).toBeLessThanOrEqual(BOARD.d / 2); }
    }
    expect(Object.keys(FOCUS_AZIMUTH).sort()).toEqual(["caps", "heatpipe", "pcie", "sidekick", "vram"]);
  });
  it("hanging workers grip the heat pipe: at rest and at the top of the pull-up the hands are on it, and the head clears it", () => {
    for (const up of [0, 1.6, 3.2]) {
      const c = ((BODY.reach - PULL.slack) * Math.cos(PULL.forward) - up) / (BODY.reach * Math.cos(PULL.forward));
      const spread = Math.acos(c);
      for (const s of SPOTS.heatpipe) {
        const handY = s.y + up + BODY.hips + BODY.shoulders + BODY.reach * Math.cos(PULL.forward) * Math.cos(spread);
        const handX = s.x - BODY.reach * Math.sin(PULL.forward); // facing -x: forward is toward the pipe
        expect(Math.hypot(handY - HEATPIPE.y, handX - HEATPIPE.x)).toBeLessThanOrEqual(HEATPIPE.r + 0.3);
      }
    }
    const headFront = SPOTS.heatpipe[0].x - 1.9; // the head's front (radius 2 · 0.95)
    expect(headFront).toBeGreaterThan(HEATPIPE.x + HEATPIPE.r - 0.1);
  });
  it("placeFigures puts each on-stage figure on its zone's spot for its slot; off-stage ones stay in the list", () => {
    const s = scene({ workers: [1, 2, 3, 4].map(n => w({ id: `a${n}`, n, startedAt: NOW - 10000 + n })) });
    const placed = placeFigures(s);
    expect(placed.map(p => `${p.zone}:${p.spot.z}`)).toEqual(["heatpipe:-22", "heatpipe:0", "heatpipe:22"]);
  });
  it("zoom levels: the core far away, the alien close up, a crossfade between", () => {
    expect(alienWeight(LOD.near - 1)).toBe(1);
    expect(alienWeight(LOD.far + 1)).toBe(0);
    expect(alienWeight((LOD.near + LOD.far) / 2)).toBeCloseTo(0.5);
    expect(alienWeight(CAMERA.home.radius)).toBe(0); // the overview shows cores
    expect(alienWeight(CAMERA.focus)).toBe(1); // flying to a worker shows the alien
  });
  it("the camera stays in range and over the board", () => {
    expect(clampRadius(1)).toBe(CAMERA.min); expect(clampRadius(1e4)).toBe(CAMERA.max);
    expect(clampPolar(0)).toBe(CAMERA.polarMin); expect(clampPolar(3)).toBe(CAMERA.polarMax);
    expect(clampTarget({ x: 500, y: 90, z: -500 })).toEqual({ x: BOARD.w / 2, y: 30, z: -BOARD.d / 2 });
    const p = orbitPosition({ radius: 100, polar: Math.PI / 2, azimuth: 0, target: { x: 0, y: 0, z: 0 } });
    expect(p.y).toBeCloseTo(0); expect(p.z).toBeCloseTo(100);
  });
});
