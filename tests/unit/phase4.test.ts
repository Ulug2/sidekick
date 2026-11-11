// v1 Phase 4: sponsorship evidence and confidence, the honesty rules, the 8 AM clock, the Needs You
// questions. No network, no model calls.
import { describe, expect, it } from "vitest";
import { evidenceLine, normalizeLevel, sponsorshipFor } from "../../src/jobs/sponsorship.js";
import { sponsorLookup } from "../../src/jobs/sponsors.js";
import { DEFAULT_ROLES, judgeJob } from "../../src/jobs/eligibility.js";
import { atHourOn, nextAt } from "../../src/jobs/daily.js";
import { checkAnswer, polarity, honestyKeyFor, questionFor } from "../../src/memory/honesty.js";
import { questionsFor } from "../../src/jobs/needs-you.js";
import { spreadTimes, MIN_GAP_MS } from "../../src/orchestrator/scheduler.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const none = { h1b: () => 0, ukSponsor: () => false };
const job = (over: Record<string, unknown>) => ({ title: "Software Engineer, New Grad", company: "Acme", location: "New York, NY", text: "Build things.", postedAt: NOW, ...over });

describe("sponsorship evidence", () => {
  it("a job with LCA evidence shows 'likely: 42 certified LCAs FY2025'", () => {
    const data = sponsorLookup({ uk: [], us: {}, updated: NOW, lca: { acme: 42 }, lcaYears: "2025", lcaBuilt: NOW - 5 * 864e5 }, NOW);
    const s = sponsorshipFor("Acme, Inc.", "Build things.", ["US"], data);
    expect(s.confidence).toBe("likely");
    expect(evidenceLine(s)).toBe("likely: 42 certified LCAs FY2025");
    expect(s.evidence[0]).toMatchObject({ source: "dol-lca", date: "2025", country: "US" });
    const v = judgeJob(job({}), data, DEFAULT_ROLES, NOW);
    expect(v).toMatchObject({ ok: true, sponsor: "likely", why: ["42 certified LCAs FY2025"] });
  });
  it("stale LCA data doesn't count, and says so", () => {
    const data = sponsorLookup({ uk: [], us: {}, updated: NOW, lca: { acme: 42 }, lcaYears: "2025", lcaBuilt: NOW - 200 * 864e5 }, NOW);
    const s = sponsorshipFor("Acme", "", ["US"], data);
    expect(s.confidence).toBe("unknown");
    expect(s.stale).toMatch(/out of date/);
    expect(judgeJob(job({}), data, DEFAULT_ROLES, NOW)).toMatchObject({ ok: false, blocked: "No sign they sponsor visas" });
  });
  it("drops a job whose posting rules out sponsorship, with the sentence", () => {
    const v = judgeJob(job({ text: "Candidates must be authorized to work in the US without sponsorship now or in the future." }), { ...none, h1b: () => 90 }, DEFAULT_ROLES, NOW);
    expect(v.ok).toBe(false);
    expect(v.blocked).toBe("Says: “without sponsorship”");
    expect(judgeJob(job({ text: "This role requires permanent residency or a green card." }), { ...none, h1b: () => 90 }, DEFAULT_ROLES, NOW).ok).toBe(false);
    expect(judgeJob(job({ text: "Must be a U.S. citizen or permanent resident." }), { ...none, h1b: () => 90 }, DEFAULT_ROLES, NOW).ok).toBe(false);
    expect(judgeJob(job({ location: "Toronto, ON", text: "Must be a Canadian citizen." }), none, DEFAULT_ROLES, NOW).ok).toBe(false);
    // Not a requirement: "we do not require a green card".
    expect(judgeJob(job({ text: "We do not require a green card. We sponsor H-1B visas." }), none, DEFAULT_ROLES, NOW)).toMatchObject({ ok: true, sponsor: "confirmed" });
  });
  it("negated offers are not offers (review 2026-11-11)", () => {
    const h1b = { ...none, h1b: () => 90 };
    for (const t of ["We do not offer visa sponsorship.", "Visa sponsorship is currently not available.", "We do not offer sponsorship at this time.", "We are unable to sponsor.", "We are not able to provide sponsorship for this role."]) {
      const s = sponsorshipFor("Acme", t, ["US"], h1b);
      expect(s.confidence, t).toBe("no");
      expect(judgeJob(job({ text: t }), h1b, DEFAULT_ROLES, NOW).ok, t).toBe(false);
    }
    expect(sponsorshipFor("Acme", "We sponsor H-1B visas for new grads.", ["US"], none).confidence).toBe("confirmed");
  });
  it("Canada: positive LMIAs or Global Talent Stream wording; the Netherlands: the IND register", () => {
    const data = sponsorLookup({ uk: [], us: {}, updated: NOW, ca: { shopify: 12 }, caDate: "2025 Q4", nl: ["booking com"], nlDate: "2026-11" }, NOW);
    expect(judgeJob(job({ company: "Shopify", location: "Toronto, Canada" }), data, DEFAULT_ROLES, NOW)).toMatchObject({ ok: true, sponsor: "likely", regions: ["canada"], why: ["12 positive LMIAs (Canada, 2025 Q4)"] });
    expect(judgeJob(job({ company: "Other", location: "Vancouver, BC", text: "We hire through the Global Talent Stream." }), data, DEFAULT_ROLES, NOW)).toMatchObject({ ok: true, sponsor: "confirmed" });
    expect(judgeJob(job({ company: "Other", location: "Vancouver, BC" }), data, DEFAULT_ROLES, NOW).ok).toBe(false);
    expect(judgeJob(job({ company: "Booking.com", location: "Amsterdam, Netherlands" }), data, DEFAULT_ROLES, NOW)).toMatchObject({ ok: true, sponsor: "confirmed", why: ["IND recognised sponsor (Netherlands)"] });
  });
  it("reads old stored levels", () => {
    expect(normalizeLevel("strong")).toBe("confirmed");
    expect(normalizeLevel("possible")).toBe("unknown");
    expect(normalizeLevel("likely")).toBe("likely");
  });
});

describe("honesty rules", () => {
  const me = { needsSponsorship: "Yes", workAuthorized: "Yes", citizenship: "Kazakhstan", eeoGender: "Male", eeoRace: "Asian", eeoVeteran: "", eeoDisability: "Prefer not to answer" };
  it("reads yes/no answers", () => {
    expect(polarity("Yes")).toBe("yes");
    expect(polarity("No, I will not")).toBe("no");
    expect(polarity("I will require sponsorship")).toBe("yes");
    expect(polarity("I will not require sponsorship")).toBe("no");
    expect(polarity("F-1 student on OPT")).toBe("unknown");
  });
  it("sponsorship: only the truthful answer, also when the question is turned around", () => {
    expect(checkAnswer("Will you now or in the future require visa sponsorship?", "Yes", me).ok).toBe(true);
    expect(checkAnswer("Will you now or in the future require visa sponsorship?", "No", me)).toMatchObject({ ok: false, topic: "sponsorship" });
    expect(checkAnswer("Are you able to work without employer sponsorship?", "No", me).ok).toBe(true);
    expect(checkAnswer("Are you able to work without employer sponsorship?", "Yes", me).ok).toBe(false);
    expect(checkAnswer("Do you require sponsorship for employment visa status?", "Yes", { ...me, needsSponsorship: "" })).toMatchObject({ ok: false, reason: expect.stringMatching(/ask_user/) });
  });
  it("work authorization: per country; an unnamed country means the job's", () => {
    expect(checkAnswer("Are you legally authorized to work in the United States?", "Yes", me).ok).toBe(true);
    expect(checkAnswer("Are you legally authorized to work in the United Kingdom?", "Yes", me).ok).toBe(false);
    expect(checkAnswer("Are you legally authorized to work in the United Kingdom?", "No", me).ok).toBe(true);
    expect(checkAnswer("Are you legally authorized to work in the country where this job is located?", "Yes", me, ["UK"]).ok).toBe(false);
    expect(checkAnswer("Are you legally authorized to work in the country where this job is located?", "Yes", me, ["US"]).ok).toBe(true);
  });
  it("self-identification: the saved choice or 'prefer not to answer'", () => {
    expect(checkAnswer("Gender", "Male", me).ok).toBe(true);
    expect(checkAnswer("Gender", "Female", me).ok).toBe(false);
    expect(checkAnswer("Gender", "Decline to self-identify", me).ok).toBe(true);
    expect(checkAnswer("Veteran status", "I am a protected veteran", me).ok).toBe(false); // nothing saved
    expect(checkAnswer("Veteran status", "I don't wish to answer", me).ok).toBe(true);
    expect(checkAnswer("Disability status", "No, I don't have a disability", me).ok).toBe(false); // he chose not to answer
    expect(checkAnswer("Are you Hispanic or Latino?", "No", me).ok).toBe(true);
    expect(checkAnswer("Are you Hispanic or Latino?", "Yes", me).ok).toBe(false);
    expect(checkAnswer("Favorite color", "Blue", me).ok).toBe(true);
  });
  it("reads whole options, checkbox labels and plain wording (review 2026-11-11)", () => {
    // Profile: needs sponsorship.
    expect(checkAnswer("I do not require sponsorship", "I do not require sponsorship", me).ok).toBe(false);
    expect(checkAnswer("I will require sponsorship", "I will require sponsorship", me).ok).toBe(true);
    expect(checkAnswer("Will you require sponsorship?", "I am authorized to work in the US and do not require sponsorship", me).ok).toBe(false);
    expect(checkAnswer("Do you need sponsorship?", "No", me)).toMatchObject({ ok: false, topic: "sponsorship" });
    expect(checkAnswer("Are you a protected veteran?", "No", { ...me, eeoVeteran: "I am not a protected veteran" }).ok).toBe(true);
    expect(checkAnswer("Are you a protected veteran?", "Yes", { ...me, eeoVeteran: "I am not a protected veteran" }).ok).toBe(false);
    expect(checkAnswer("Gender", "Man", me).ok).toBe(true);
    expect(checkAnswer("Gender", "Woman", me).ok).toBe(false);
    expect(checkAnswer("Describe your work authorization", "I am on F-1 OPT", { ...me, workAuthorized: "No" }).ok).toBe(true);
    expect(honestyKeyFor("Will you now or in the future require visa sponsorship?")).toBe("needsSponsorship");
    expect(honestyKeyFor("Are you able to work without sponsorship?")).toBe(null); // turned around: not stored as-is
    expect(honestyKeyFor("Are you legally authorized to work in the UK?")).toBe(null);
    expect(honestyKeyFor("Gender")).toBe("eeoGender");
  });
  it("finds the question of a radio button from the snapshot line", () => {
    expect(questionFor({ label: "Yes", line: '[12] radio "Yes" question: "Will you require sponsorship?" unchecked' })).toBe("Will you require sponsorship? Yes");
  });
});

describe("the 8 AM batch clock", () => {
  it("is 8:00 in New York, across daylight saving", () => {
    expect(new Date(atHourOn(Date.parse("2026-11-11T15:00:00Z"), 8)).toISOString()).toBe("2026-11-11T13:00:00.000Z"); // EST
    expect(new Date(atHourOn(Date.parse("2026-07-01T15:00:00Z"), 8)).toISOString()).toBe("2026-07-01T12:00:00.000Z"); // EDT
    expect(new Date(nextAt(Date.parse("2026-11-11T14:00:00Z"), 8)).toISOString()).toBe("2026-11-12T13:00:00.000Z");
    expect(new Date(nextAt(Date.parse("2026-11-11T12:00:00Z"), 8)).toISOString()).toBe("2026-11-11T13:00:00.000Z");
    expect(new Date(nextAt(Date.parse("2026-03-07T14:00:00Z"), 8)).toISOString()).toBe("2026-03-08T12:00:00.000Z"); // the DST switch day
    expect(new Date(nextAt(Date.parse("2026-11-12T03:30:00Z"), 8)).toISOString()).toBe("2026-11-12T13:00:00.000Z"); // 10:30 PM ET: tomorrow, not the day after
    expect(new Date(nextAt(Date.parse("2026-11-12T04:59:00Z"), 8)).toISOString()).toBe("2026-11-12T13:00:00.000Z"); // 11:59 PM ET
  });
  it("spreads 18 applications over 20 hours, random and at least 15 minutes apart", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const t = spreadTimes(18, NOW, 20, rnd);
    expect(t).toHaveLength(18);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(t[17]).toBeLessThanOrEqual(NOW + 20 * 3600e3);
    expect(new Set(t.map((x, i) => i ? x - t[i - 1] : 0)).size).toBeGreaterThan(10); // not a fixed rhythm
  });
});

describe("Needs You questions", () => {
  it("one input per question: the form's options, yes/no, text, human steps", () => {
    expect(questionsFor(["Which office would you prefer?"], ["New York", "Remote"], false)).toEqual([{ question: "Which office would you prefer?", fieldType: "select", options: ["New York", "Remote"] }]);
    expect(questionsFor(["- Have you worked here before?", "- What's your expected salary?"], undefined, false)).toEqual([
      { question: "Have you worked here before?", fieldType: "select", options: ["Yes", "No"] },
      { question: "What's your expected salary?", fieldType: "text" }
    ]);
    expect(questionsFor(["Please sign in to Workday, then tell me"], undefined, true)[0].fieldType).toBe("human");
  });
});
