// The contracts between the brain, the workers and the rest of Sidekick (docs/ARCHITECTURE.md §3).
import type { Role } from "../core/llm/models.js";
import type { Job, JobStatus } from "../jobs/types.js";
import type { AgentFile } from "../agent/types.js";

// How much a worker may do without asking (docs/BUGS.md 3; policy.ts decides per action).
//  ask-final: the normal side-panel run: submits, sends, uploads and new sites ask.
//  approved-batch: an application batch Ulugbek reviewed: submits, Enter, uploads and typing on the
//    job's own sites run; payments, deleting, posting are refused; human checks go to Needs You.
//  read-only: course sites and email reading: no final action at all.
//  every-click: Settings "ask before every click".
export type AutonomyLevel = "ask-final" | "approved-batch" | "read-only" | "every-click";

export type WorkerKind = "apply" | "read" | "write" | "classify";
export type WorkerStatus = "queued" | "working" | "needs_you" | "done" | "failed" | "stopped";
export interface WorkerTask {
  id: string;
  n: number; // Agent 1, Agent 2, …
  kind: WorkerKind;
  role: Role; // which model (core/llm/models.ts)
  title: string; // "Apply: Software Engineer at Stripe"
  goal: string; // what the agent is told
  policy: AutonomyLevel;
  approvedSites?: string[]; // for approved-batch: the job's ATS and company sites
  context?: WorldSlice; // the part of the world state this worker gets
  files?: Record<string, AgentFile>;
  jobId?: string;
  countries?: string[]; // where the job is (honesty checks: "authorized to work here?")
  tabId?: number;
  maxCost?: number;
  resumeFrom?: { questions: NeedsYouQuestion[]; answers: Record<string, string> };
}
export interface WorkerResult {
  taskId: string;
  status: WorkerStatus;
  summary: string;
  traceId?: string;
  cost: number;
  needsYou?: NeedsYouItem;
  error?: string;
}
// What the Powerhouse shows for a worker, written to storage as the run goes.
export interface WorkerRecord { id: string; n: number; kind: WorkerKind; title: string; model: string; status: WorkerStatus; step: string; startedAt: number; updatedAt: number; cost: number; traceId?: string; jobId?: string; error?: string; tabId?: number; steps?: number } // steps: how many steps it has logged (the Powerhouse's step pulses)

// A question the worker could not answer from memory (docs/DESIGN.md §3).
export interface NeedsYouQuestion { question: string; fieldType: "text" | "select" | "radio" | "checkbox" | "file" | "date" | "human"; options?: string[]; fieldId?: string }
export interface NeedsYouItem { jobId?: string; workerId: string; since: number; stoppedAt: string; questions: NeedsYouQuestion[]; tabId?: number; url?: string }

// The shared state every part can read (world.ts builds it from storage).
export interface JobBrief { id: string; company: string; title: string; status: JobStatus; appliedAt?: number; score: number; location: string }
export interface WorldState {
  now: number;
  jobs: { queued: JobBrief[]; applying: JobBrief[]; applied: JobBrief[]; needsYou: JobBrief[]; eligible: number; companiesApplied30d: string[] };
  needsYou: NeedsYouItem[];
  assignments: { id: string; course: string; title: string; due: number; status: string }[];
  reminders: { id: string; text: string; at: number }[];
  workers: WorkerRecord[];
  spend: { today: number; month: number; capDaily: number; capMonthly: number; paused: string | null };
  lastBatchAt?: number;
}
// What a worker gets: only what its kind needs.
export interface WorldSlice { text: string; companiesApplied30d: string[]; queuedCompanies: string[] }

export type ActionKind = "submit" | "send" | "trash" | "upload" | "visit" | "share" | "site_tool" | "undo" | "schedule" | "needs_you";
export interface ActionLogEntry { id: string; at: number; worker: number | null; kind: ActionKind; what: string; why: string; site?: string; jobId?: string; undo?: { kind: "untrash"; messageId: string; label?: string } }

export type FullJob = Job;
