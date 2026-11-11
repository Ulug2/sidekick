// v1 Phase 5: the settings that now reach the pipeline: where to look (regions), one application per
// company every N days, which background notifications show, quiet hours. No network, no models.
import { describe, expect, it } from "vitest";
import { sponsorLookup } from "../../src/jobs/sponsors.js";
import { DEFAULT_ROLES, judgeJob } from "../../src/jobs/eligibility.js";
import { mergeScan, pickBatch } from "../../src/jobs/store.js";
import { allowNotify, quietEndsAt } from "../../src/orchestrator/host.js";
import type { Job } from "../../src/jobs/types.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const DAY = 864e5;
const data = sponsorLookup({ uk: ["acme"], us: {}, updated: NOW, lca: { acme: 42 }, lcaYears: "2025", lcaBuilt: NOW - 5 * DAY }, NOW);
const posting = (location: string, text = "Build things.") => ({ title: "Software Engineer, New Grad", company: "Acme", location, text, postedAt: NOW });

describe("Settings → Jobs: where to look", () => {
  it("a US job is filtered out when he turned the US off, with the reason and where to change it", () => {
    const v = judgeJob(posting("New York, NY"), data, DEFAULT_ROLES, NOW, { regions: ["europe", "canada"] });
    expect(v.ok).toBe(false);
    expect(v.blocked).toBe("In the US, which you turned off (Settings → Jobs)");
  });
  it("the same job is kept when the US is on, and with no regions set (all four)", () => {
    expect(judgeJob(posting("New York, NY"), data, DEFAULT_ROLES, NOW, { regions: ["usa"] }).ok).toBe(true);
    expect(judgeJob(posting("New York, NY"), data, DEFAULT_ROLES, NOW, {}).ok).toBe(true);
  });
  it("a job in two places is kept when one of them is on", () => {
    const v = judgeJob(posting("New York, NY or London, UK", "We sponsor visas."), data, DEFAULT_ROLES, NOW, { regions: ["europe"] });
    expect(v.ok).toBe(true);
  });
});

describe("Settings → Jobs: one application per company every N days", () => {
  const j = (id: string, company: string, over: Partial<Job> = {}): Job => ({ id, ats: "greenhouse", board: company, company, title: "SWE", location: "NYC", url: "u", applyUrl: "u", ok: true, regions: ["usa"], countries: ["US"], sponsor: "likely", why: [], score: 50, status: "found", firstSeen: 1, lastSeen: 1, ...over } as Job);
  const list = [j("a2", "Acme"), j("b1", "Bravo"), j("a1", "Acme", { status: "applied", appliedAt: NOW - 20 * DAY })];
  it("30 days (default): Acme, applied to 20 days ago, is left out", () => {
    expect(pickBatch(list, 5, NOW)).toEqual(["b1"]);
  });
  it("14 days: Acme is allowed again", () => {
    expect(pickBatch(list, 5, NOW, 14).sort()).toEqual(["a2", "b1"]);
  });
});

describe("Settings → Notifications", () => {
  const at = (h: number) => new Date(2026, 10, 11, h, 30);
  it("a kind he turned off never shows; the others do", () => {
    const s = { notifyBatch: false, notifyNeedsYou: true, notifyDue: true, quietFrom: "", quietTo: "" };
    expect(allowNotify("batch", s, at(9))).toBe(false);
    expect(allowNotify("needs_you", s, at(9))).toBe(true);
    expect(allowNotify("due", s, at(9))).toBe(true);
  });
  it("quiet hours that wrap midnight (22 → 7) silence every kind inside, none outside", () => {
    const s = { quietFrom: "22", quietTo: "7" };
    expect([21, 22, 23, 0, 6, 7, 12].map(h => allowNotify("needs_you", s, at(h)))).toEqual([true, false, false, false, false, true, true]);
  });
  it("quiet hours within a day (13 → 15), and quiet hours off when either end is Off or both are equal", () => {
    expect([12, 13, 14, 15].map(h => allowNotify("batch", { quietFrom: "13", quietTo: "15" }, at(h)))).toEqual([true, false, false, true]);
    expect(allowNotify("batch", { quietFrom: "22", quietTo: "" }, at(23))).toBe(true);
    expect(allowNotify("batch", { quietFrom: "8", quietTo: "8" }, at(8))).toBe(true);
  });
  it("hour 0 counts as a real hour, not Off", () => {
    expect(allowNotify("due", { quietFrom: "0", quietTo: "6" }, at(3))).toBe(false);
  });
  it("defaults (nothing saved) allow everything", () => {
    expect(allowNotify("needs_you", {}, at(3))).toBe(true);
  });
});

describe("quiet hours end", () => {
  it("22 → 7: at 23:30 they end at 7:00 the next morning; at 3:30 at 7:00 the same day; outside, null", () => {
    const s = { quietFrom: "22", quietTo: "7" };
    expect(quietEndsAt(s, new Date(2026, 10, 11, 23, 30))).toBe(new Date(2026, 10, 12, 7, 0).getTime());
    expect(quietEndsAt(s, new Date(2026, 10, 12, 3, 30))).toBe(new Date(2026, 10, 12, 7, 0).getTime());
    expect(quietEndsAt(s, new Date(2026, 10, 12, 7, 0))).toBeNull();
  });
});

describe("a rescan that rejects a queued job", () => {
  it("takes it out of the batch with its approved time (a later re-queue needs a new approval)", () => {
    const old = { id: "greenhouse:acme:1", ats: "greenhouse", board: "acme", company: "Acme", title: "SWE", location: "NYC", url: "u", applyUrl: "u", ok: true, regions: ["usa"], countries: ["US"], sponsor: "likely", why: [], score: 50, status: "queued", scheduledAt: NOW + 3600e3, firstSeen: 1, lastSeen: 1 } as Job;
    const verdict = { ok: false, regions: ["usa"], countries: ["US"], sponsor: "no", why: [], evidence: [], blocked: "Says: no sponsorship", score: 0 } as never;
    const [j] = mergeScan([old], { ats: "greenhouse", board: "acme" }, [{ id: old.id, title: "SWE", company: "Acme", location: "NYC", url: "u", applyUrl: "u", verdict } as never], NOW);
    expect(j).toMatchObject({ status: "found", ok: false, blocked: "Says: no sponsorship" });
    expect(j.scheduledAt).toBeUndefined();
  });
});
