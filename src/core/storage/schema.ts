// Everything Sidekick keeps in chrome.storage, in one place. Storage is chrome.storage.local
// (unencrypted, like every extension), plus one hand-off value in chrome.storage.session.
// readLocal() is chrome.storage.local.get with these types; writes still go through
// chrome.storage.local.set at each owner (see the module named next to each key).
import type { Application, Profile } from "../../assistant/profile-core.js";
import type { DocChunks, DocIndexEntry, Memory } from "../../assistant/memory/memory.js";
import type { Skill } from "../../assistant/skills.js";
import type { UserModel } from "../../assistant/session.js";
import type { Shortcut, SiteNote } from "../../agent/types.js";
import type { Settings } from "../llm/settings.js";
import type { UsageLog } from "../llm/usage.js";
import type { RunTrace } from "../../agent/trace/trace.js";
import type { TraceIndexEntry } from "../../agent/trace/store.js";
import type { BenchPending, BenchRun } from "../../bench/results.js";
import type { Company, Job, Region } from "../../jobs/types.js";
import type { ActionLogEntry, NeedsYouItem, WorkerRecord } from "../../orchestrator/types.js";
import type { Scheduled } from "../../orchestrator/scheduler.js";
import type { StoredFact } from "../../memory/facts.js";
import type { SavedAnswer } from "../../memory/answers.js";
import type { SponsorLists } from "../../jobs/sponsors.js";

// ---------- chats (ui/sidepanel) ----------
export interface ChatIndexEntry { id: string; title: string; updatedAt: number }
export interface ChatDisplay { prompt?: string; quote?: string; page?: string; files?: string[]; images?: string[]; agent?: boolean }
// A saved message. User messages carry what was shown (display); assistant messages carry
// what's needed to show the reply again (trace, citations, review, thinking, agent runs).
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  display?: ChatDisplay;
  canReplace?: boolean;
  quickAction?: string;
  attachmentKinds?: { kind: string }[];
  tier?: string;
  trace?: any; // brain's TurnTrace
  citations?: { url: string; title: string }[];
  review?: any; // brain's math review result
  thoughts?: any;
  agentRuns?: any[];
  agentSteps?: string[];
  agentPlan?: any[];
  traceId?: string; // the agent run's trace (Agent runs page)
  stopped?: boolean;
  [extra: string]: unknown;
}
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  notes?: string[]; // pinned notes for this chat (assistant/session)
  reflected?: boolean;
  [extra: string]: unknown;
}

// ---------- quality checks (ui/evals) ----------
export interface EvalRun { date: number; configKey: string; passed: number; total: number; models: string[]; results: Record<string, { pass: boolean; note?: string }> }

// ---------- the schema ----------
export interface LocalSchema extends Settings {
  profile: Profile; // assistant/profile-core
  applications: Application[]; // assistant/profile-core
  memories: Memory[]; // assistant/memory/memory
  docIndex: DocIndexEntry[]; // assistant/memory/memory; each document's text is under doc:<id>
  skills: Skill[]; // assistant/skills
  userModel: UserModel; // assistant/session
  adapters: Shortcut[]; // agent/skills/adapters (learned site shortcuts)
  siteNotes: Record<string, SiteNote[]>; // agent/skills/adapters, by site
  chatIndex: ChatIndexEntry[]; // ui/sidepanel; each chat is under chat:<id>
  usage: UsageLog; // core/llm
  evalRuns: EvalRun[]; // ui/evals
  traceIndex: TraceIndexEntry[]; // agent/trace/store: one line per recorded agent run, newest first
  benchRuns: BenchRun[]; // bench/results: one record per benchmark run, graded on the Benchmark page
  benchParams: Record<string, Record<string, string>>; // ui/bench: what you entered per task (URLs, dates…)
  benchMaxCost: number; // ui/bench: dollar limit per benchmark run
  jobs: Job[]; // jobs/store: every posting found, whether you can take it, and its status
  jobCompanies: Company[]; // jobs/store: the companies whose job boards are read
  sponsorLists: SponsorLists; // jobs/sponsors: UK Skilled Worker sponsors and US H-1B approvals by employer
  jobSettings: { dailyCap: number; monthlyCap: number; internships?: boolean; dailyBatch?: boolean; batchHour?: number; batchSize?: number; spreadHours?: number; needsYouWaitMinutes?: number; regions?: Region[]; companyDays?: number }; // ui/jobs, Settings → Jobs: applications per day, (monthlyCap: old; capMonthly is the real cap), internships too?
  // ---------- orchestrator (docs/ARCHITECTURE.md §3) ----------
  orchestrator: { workers?: WorkerRecord[]; needsYou?: NeedsYouItem[]; paused?: string | null; lastBatchAt?: number; counter?: number; counterDay?: string }; // orchestrator/workers, world
  actionLog: ActionLogEntry[]; // orchestrator/log: every irreversible action, newest first
  scheduled: Scheduled[]; // orchestrator/scheduler: alarms to recreate after a restart
  heldNotices: { title: string; message: string; at: number }[]; // orchestrator/host: notifications held back in quiet hours, shown when they end
  firedAlarms: { name: string; at: number }[]; // orchestrator/scheduler: fired by the service worker, drained by the orchestrator page
  facts: Record<string, StoredFact>; // memory/facts: facts the profile has no field for (high school, graduation…)
  answers: SavedAnswer[]; // memory/answers: every form question answered once, matched by meaning
  assignments: { id: string; course: string; title: string; due: number; status: string; weight?: number; url?: string }[]; // school (Phase 7)
  reminders: { id: string; text: string; at: number; source?: string }[]; // school/email (Phases 7–8)
  [chat: `chat:${string}`]: Chat;
  [doc: `doc:${string}`]: DocChunks;
  [trace: `trace:${string}`]: RunTrace; // a run without its images
  [shot: `traceShot:${string}`]: string; // a screenshot (JPEG data URL), written once
  [jobShot: `jobShot:${string}`]: string; // jobs-run: the confirmation page after an application (JPEG data URL)
}
export interface SessionSchema {
  // The context menu's hand-off to the panel (background → sidepanel).
  pending: { mode: "rewrite" | "ask"; text: string; ts: number };
  // Run a benchmark task (ui/bench → sidepanel).
  benchPending: BenchPending;
  // Start today's application batch (ui/jobs → sidepanel): the queued jobs, in order.
  jobBatch: { ts: number; windowId?: number; only?: string[] }; // only: these job ids (Save & resume)
  jobBatchStop: boolean; // the Jobs page's Stop: the panel ends the batch after the current job
}

export async function readLocal<K extends keyof LocalSchema>(keys: K | K[]): Promise<Partial<Pick<LocalSchema, K>>> {
  return (await chrome.storage.local.get(keys as any)) as Partial<Pick<LocalSchema, K>>;
}
