// The real-site benchmark's pure parts: task settings and goals, automatic checks, scoring per
// version, this month's spend, CSV export.
import { describe, expect, it } from "vitest";
import { BENCH_TASKS, noFinalAction, paramsFor, taskById } from "../../src/bench/tasks.js";
import { benchCsv, estimateCost, monthSpend, passed, scoreByVersion, type BenchRun } from "../../src/bench/results.js";
import type { RunTrace } from "../../src/agent/trace/trace.js";

const today = new Date(2026, 10, 1); // Nov 1, 2026
const trace = (events: { kind: "approve" | "ask" | "plan" | "note"; text: string; answer?: string }[] = [], actions: { tool: string; ok: boolean }[] = []): RunTrace => ({
  id: "t", version: "0.9.6", goal: "", startedAt: 0, endedAt: 1000, outcome: "done", start: { url: "", title: "" },
  config: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", approvalMode: "final", trustedInput: true },
  steps: [{ n: 1, at: 0, url: "", title: "", side: [], events: events.map(e => ({ at: 0, ...e })), actions: actions.map(a => ({ ...a, args: {}, label: "", result: "", ms: 1 })) }],
  totals: { calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, costKnown: true }, shotKeys: []
});

describe("tasks", () => {
  it("are the ten from the plan, numbered 1 to 10, with unique ids", () => {
    expect(BENCH_TASKS.map(t => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(BENCH_TASKS.map(t => t.id)).size).toBe(10);
  });
  it("fill dates from today and list required settings that are missing", () => {
    const ta = paramsFor(taskById("turkish-multicity")!, {}, today);
    expect(ta.params).toEqual({ d1: "2026-12-01", d2: "2026-12-08", d3: "2026-12-22" });
    expect(taskById("turkish-multicity")!.goal(ta.params, today)).toMatch(/IAD.*IST.*December 1, 2026.*IST.*ALA.*December 8, 2026.*ALA.*IAD.*December 22, 2026/s);
    expect(paramsFor(taskById("moodle-due")!, {}, today).missing).toEqual(["Your Moodle dashboard"]);
    expect(paramsFor(taskById("moodle-due")!, { url: " https://moodle.example.edu/my/ " }, today).params.url).toBe("https://moodle.example.edu/my/");
  });
  it("every goal says to stop before the final step", () => {
    for (const t of BENCH_TASKS.filter(t => t.mode === "agent" && !["moodle-due"].includes(t.id))) {
      expect(t.goal(paramsFor(t, { url: "https://x.example", from: "a", what: "b" }, today).params, today), t.id).toMatch(/don't (book|add|apply|click send|press submit|click submit|select a fare)|stop before submitting|leave it as a draft/i);
    }
  });
});

describe("checks", () => {
  it("an allowed submit, send or booking fails the task; a declined one doesn't", () => {
    expect(noFinalAction(trace([{ kind: "approve", text: "Click “Submit application”?", answer: "allowed" }])).ok).toBe(false);
    expect(noFinalAction(trace([{ kind: "approve", text: "Click “Submit application”?", answer: "declined" }])).ok).toBe(true);
    expect(noFinalAction(trace([{ kind: "approve", text: "Attach your resume on boards.greenhouse.io?", answer: "allowed" }])).ok).toBe(true);
  });
  it("price, list and memory checks read the answer", () => {
    const ta = taskById("turkish-multicity")!.check({ summary: "Cheapest total: USD 1,243.30 (TK8, TK350, TK351)", trace: trace(), memoriesAdded: [] });
    expect(ta.every(c => c.ok)).toBe(true);
    expect(taskById("job-search")!.check({ summary: "1. A\n2. B\n3. C\n4. D", trace: trace(), memoriesAdded: [] })[1].ok).toBe(false);
    const art = taskById("article-dates")!.check({ summary: "x".repeat(300), trace: null, memoriesAdded: ["Apollo 11 launched on July 16, 1969", "Landed on the Moon July 20, 1969"] });
    expect(art.every(c => c.ok)).toBe(true);
  });
});

const run = (o: Partial<BenchRun>): BenchRun => ({ id: Math.random().toString(36), taskId: "amazon-compare", version: "0.9.6", startedAt: 1, mode: "agent", model: "claude-sonnet-5-5", params: {}, outcome: "done", steps: 10, ms: 60000, cost: 0.2, costKnown: true, interventions: 0, summary: "", checks: [], ...o });

describe("scoring", () => {
  it("passes only with your OK and at most one intervention", () => {
    expect(passed(run({ verdict: "pass", interventions: 1 }))).toBe(true);
    expect(passed(run({ verdict: "pass", interventions: 2 }))).toBe(false);
    expect(passed(run({ verdict: "fail" }))).toBe(false);
    expect(passed(run({}))).toBe(false);
  });
  it("counts each task once per version, by its latest graded run", () => {
    const [s] = scoreByVersion([
      run({ taskId: "amazon-compare", startedAt: 1, verdict: "fail", steps: 30, cost: 0.9 }),
      run({ taskId: "amazon-compare", startedAt: 2, verdict: "pass", steps: 10, cost: 0.2 }),
      run({ taskId: "google-flights", startedAt: 3, verdict: "fail", steps: 20, cost: 0.4 }),
      run({ taskId: "moodle-due", startedAt: 4, steps: 5, cost: 0.1 }) // not graded: cost only
    ]);
    expect(s).toMatchObject({ version: "0.9.6", graded: 2, passedTasks: 1, tasksRun: 3, runs: 4, medianSteps: 15, medianCost: 0.30000000000000004 });
    expect(s.totalCost).toBeCloseTo(1.6, 10);
  });
  it("sorts versions newest first", () => {
    expect(scoreByVersion([run({ version: "0.9.6" }), run({ version: "0.10.0" }), run({ version: "0.9.10" })]).map(s => s.version)).toEqual(["0.10.0", "0.9.10", "0.9.6"]);
  });
});

it("this month's spend counts priced models and names the others", () => {
  const usage = { "2026-11-01": { "claude-sonnet-5-5": { calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, "gpt-6-astra": { calls: 1, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }, "2026-10-31": { "claude-sonnet-5-5": { calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  expect(monthSpend(usage, today)).toEqual({ cost: 2, unpriced: ["gpt-6-astra"] });
});

it("estimates and CSV", () => {
  expect(estimateCost(10).low).toBeLessThan(estimateCost(10).high);
  const csv = benchCsv([run({ verdict: "pass", note: 'said "ok", then stopped' })]);
  expect(csv.split("\n")[0]).toBe("version,task,started,outcome,verdict,passed,interventions,steps,seconds,cost_usd,model,note");
  expect(csv).toContain('"said ""ok"", then stopped"');
  expect(csv).toContain("7 Amazon: compare 3 products");
});
