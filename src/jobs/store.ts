// The job list ("jobs") and the companies whose boards are read ("jobCompanies"), in
// chrome.storage.local. Every change is read-modify-write under a storage lock.
import type { Company, Job, JobStatus } from "./types.js";
import type { Posting } from "./sources.js";
import type { Verdict } from "./eligibility.js";
import { SEED_COMPANIES } from "./seed.js";
import { updateLocal } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";

export const UNSEEN_DROP_DAYS = 30;
export const DEFAULT_JOB_SETTINGS = { dailyCap: 20, monthlyCap: 25 }; // applications per day; dollars of API per month // postings filtered out and gone this long are forgotten

export async function getJobs(): Promise<Job[]> { return (await readLocal("jobs")).jobs || []; }
export async function getCompanies(): Promise<Company[]> {
  const { jobCompanies } = await readLocal("jobCompanies");
  if (jobCompanies) return jobCompanies;
  const now = Date.now();
  const seed = SEED_COMPANIES.map(([name, ats, board, eu]): Company => ({ name, ats, board, ...(eu && { eu }), added: now, source: "seed" }));
  await updateLocal("jobCompanies", cur => cur || seed);
  return (await readLocal("jobCompanies")).jobCompanies || seed;
}
export const companyKey = (c: Pick<Company, "ats" | "board">) => `${c.ats}:${c.board.toLowerCase()}`;
export function changeCompanies(fn: (list: Company[]) => Company[] | undefined): Promise<void> {
  return updateLocal("jobCompanies", list => fn(list || []));
}

// A careers link → its board ("https://jobs.ashbyhq.com/ramp/123" → ashby / ramp).
export function boardFromUrl(url: string): Pick<Company, "ats" | "board" | "eu"> | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  const seg = u.pathname.split("/").filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const b = u.searchParams.get("for") || (seg[0] === "embed" ? u.searchParams.get("for") : seg[0]);
    return b ? { ats: "greenhouse", board: b } : null;
  }
  if (/^jobs\.(eu\.)?lever\.co$/.test(host) && seg[0]) return { ats: "lever", board: seg[0], ...(host.includes(".eu.") && { eu: true }) };
  if (host === "jobs.ashbyhq.com" && seg[0]) return { ats: "ashby", board: seg[0] };
  if (host === "apply.workable.com" && seg[0] && seg[0] !== "j") return { ats: "workable", board: seg[0] };
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && seg[0]) return { ats: "smartrecruiters", board: seg[0] };
  return null;
}

// One company's scan → the job list. Kept postings keep their status; postings no longer on the
// board are marked closed (unless already applied); filtered-out postings keep no text.
export function mergeScan(list: Job[], company: Pick<Company, "ats" | "board">, postings: (Posting & { verdict: Verdict })[], now = Date.now()): Job[] {
  const prefix = `${company.ats}:${company.board}:`;
  const byId = new Map(list.map(j => [j.id, j]));
  const seen = new Set<string>();
  for (const p of postings) {
    seen.add(p.id);
    const v = p.verdict;
    const old = byId.get(p.id);
    const fields = { ...p, text: v.ok ? p.text : undefined, ok: v.ok, regions: v.regions, countries: v.countries, sponsor: v.sponsor, why: v.why, blocked: v.blocked, score: v.score, lastSeen: now };
    delete (fields as { verdict?: Verdict }).verdict;
    if (old) byId.set(p.id, { ...old, ...fields, status: old.status === "closed" ? "found" : old.status });
    else byId.set(p.id, { ...fields, status: "found", firstSeen: now });
  }
  for (const j of byId.values()) {
    if (!j.id.startsWith(prefix) || seen.has(j.id)) continue;
    if (j.status === "found" || j.status === "queued") byId.set(j.id, { ...j, status: "closed", statusAt: now });
  }
  return [...byId.values()].filter(j => j.ok || !["found", "closed"].includes(j.status) || now - j.lastSeen < UNSEEN_DROP_DAYS * 864e5);
}

// Today's batch: the best eligible jobs, one per company, skipping companies applied to in the
// last ONE_PER_COMPANY_DAYS (a second application to the same company in a month looks like spam
// and rarely helps). Pure: returns the ids to queue.
export const ONE_PER_COMPANY_DAYS = 30;
export function pickBatch(list: Job[], n: number, now = Date.now()): string[] {
  const key = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const busy = new Set(list.filter(j => ["queued", "applying", "needs_you"].includes(j.status) || (j.appliedAt && now - j.appliedAt < ONE_PER_COMPANY_DAYS * 864e5)).map(j => key(j.company)));
  const picked: string[] = [];
  for (const j of list.filter(j => j.ok && j.status === "found").sort((a, b) => b.score - a.score || (b.postedAt || 0) - (a.postedAt || 0))) {
    if (picked.length >= n) break;
    const k = key(j.company);
    if (busy.has(k)) continue;
    busy.add(k);
    picked.push(j.id);
  }
  return picked;
}
export function queueJobs(ids: string[]): Promise<void> {
  const now = Date.now();
  return updateLocal("jobs", (list = []) => list.map(j => ids.includes(j.id) && j.status === "found" ? { ...j, status: "queued", statusAt: now } : j));
}

export function setJobStatus(id: string, status: JobStatus, extra: Partial<Job> = {}): Promise<void> {
  const now = Date.now();
  return updateLocal("jobs", (list = []) => list.map(j => j.id !== id ? j : { ...j, ...extra, status, statusAt: now, ...(status === "applied" && !j.appliedAt && { appliedAt: now }) }));
}

// What the dashboard counts.
export function jobStats(list: Job[], now = Date.now()) {
  const day = new Date(now).toDateString();
  const count = (s: JobStatus[]) => list.filter(j => s.includes(j.status)).length;
  return {
    eligible: list.filter(j => j.ok && j.status === "found").length,
    filtered: list.filter(j => !j.ok && j.status === "found").length,
    queued: count(["queued", "applying"]),
    applied: count(["applied", "interview", "offer", "rejected"]),
    appliedToday: list.filter(j => j.appliedAt && new Date(j.appliedAt).toDateString() === day).length,
    interviews: count(["interview", "offer"]),
    offers: count(["offer"]),
    rejected: count(["rejected"]),
    needsYou: count(["needs_you"]),
    companies: new Set(list.filter(j => j.ok).map(j => j.company)).size
  };
}

// CSV for a spreadsheet (Excel, Numbers, Google Sheets: File → Import).
export function jobsCsv(list: Job[]): string {
  const cols = ["status", "priority", "company", "title", "location", "region", "sponsorship", "why", "posted", "applied", "link", "apply_link", "note"];
  const q = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const d = (t?: number) => t ? new Date(t).toLocaleDateString("en-CA") : ""; // local dates, YYYY-MM-DD
  return [cols.join(","), ...list.map(j => [j.status, j.score, j.company, j.title, j.location, j.regions.join(" "), j.sponsor, j.ok ? j.why.join("; ") : j.blocked, d(j.postedAt), d(j.appliedAt), j.url, j.applyUrl, j.note].map(q).join(","))].join("\n") + "\n";
}
