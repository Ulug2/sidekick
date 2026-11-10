// Jobs: postings found on company career sites, whether Ulugbek can take them, and where each
// application stands.

export type Region = "usa" | "europe" | "uae";
// How sure we are the employer can give him a work visa for this job.
export type SponsorLevel = "strong" | "likely" | "possible" | "unknown" | "no";
// found → (queued for a day's batch) → applied → interview → offer, or rejected; skipped by you;
// "needs_you" when Sidekick couldn't finish (a login, a CAPTCHA, a question it won't guess).
export type JobStatus = "found" | "queued" | "applying" | "applied" | "needs_you" | "interview" | "offer" | "rejected" | "skipped" | "closed";
export type Ats = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters";

export interface Job {
  id: string; // "<ats>:<board>:<posting id>"
  ats: Ats;
  board: string; // the company's slug on that job board
  company: string;
  title: string;
  location: string;
  url: string; // the posting
  applyUrl: string; // the application form
  postedAt?: number;
  text?: string; // the posting's text, shortened (for the checks and the cover letter)
  // From judgeJob:
  ok: boolean;
  regions: Region[];
  countries: string[];
  sponsor: SponsorLevel;
  why: string[];
  blocked?: string;
  score: number;
  // Tracking:
  status: JobStatus;
  firstSeen: number;
  lastSeen: number;
  appliedAt?: number;
  statusAt?: number;
  note?: string;
  coverLetter?: string;
  traceId?: string; // the application run (Agent runs page)
}

// A company whose job board Sidekick reads.
export interface Company { name: string; ats: Ats; board: string; eu?: boolean; added: number; source: "seed" | "you" | "found"; lastScan?: number; lastError?: string; jobs?: number }
