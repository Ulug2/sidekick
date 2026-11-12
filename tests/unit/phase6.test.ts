// v1 Phase 6: what feeds the Powerhouse from the orchestrator: brain calls tracked from start to end
// (Sidekick lifts while one is in flight), and the dispatch text is the real title, plain and
// redacted. The city's scene contract and view parts are tested in scene.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackBrain, liveBrainCalls, BRAIN_STALE_MS } from "../../src/orchestrator/activity.js";
import { shoutFor } from "../../src/orchestrator/workers.js";

const NOW = Date.parse("2026-11-11T15:00:00Z");

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

describe("the dispatch text", () => {
  it("is the real title, plain text, no fence, no secrets", () => {
    expect(shoutFor(3, "Apply: Backend Engineer at Stripe")).toBe("Agent 3! Apply: Backend Engineer at Stripe");
    const s = shoutFor(1, "Apply: x sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(s).not.toMatch(/sk-ant-api03-A{20}/);
  });
});
