// The world state: what Sidekick knows right now, built from storage, read by the brain whole and
// by workers in slices (docs/BUGS.md 4). No model calls; worldQuery answers from storage.
import type { JobBrief, WorldSlice, WorldState } from "./types.js";
import type { Job } from "../jobs/types.js";
import { readLocal } from "../core/storage/schema.js";
import { DEFAULT_CAPS, spendFor } from "../core/llm/budget.js";

const DAY = 864e5;
const brief = (j: Job): JobBrief => ({ id: j.id, company: j.company, title: j.title, status: j.status, appliedAt: j.appliedAt, score: j.score, location: j.location });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function buildWorld(now = Date.now()): Promise<WorldState> {
  const [{ jobs = [] }, { usage }, { orchestrator }, { capDaily, capMonthly }, { assignments = [] }, { reminders = [] }] = await Promise.all([
    readLocal("jobs"), readLocal("usage"), readLocal("orchestrator"), readLocal(["capDaily", "capMonthly"]), readLocal("assignments"), readLocal("reminders")
  ]);
  const spend = spendFor(usage, new Date(now));
  const appliedLike = (j: Job) => ["applied", "interview", "offer", "rejected"].includes(j.status);
  return {
    now,
    jobs: {
      queued: jobs.filter(j => j.status === "queued").map(brief), applying: jobs.filter(j => j.status === "applying").map(brief),
      applied: jobs.filter(appliedLike).sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0)).map(brief), needsYou: jobs.filter(j => j.status === "needs_you").map(brief),
      eligible: jobs.filter(j => j.ok && j.status === "found").length,
      companiesApplied30d: [...new Set(jobs.filter(j => j.appliedAt && now - j.appliedAt < 30 * DAY).map(j => j.company))]
    },
    needsYou: orchestrator?.needsYou || [],
    assignments: assignments.map(a => ({ id: a.id, course: a.course, title: a.title, due: a.due, status: a.status })),
    reminders: reminders.map(r => ({ id: r.id, text: r.text, at: r.at })),
    workers: orchestrator?.workers || [],
    spend: { today: spend.today, month: spend.month, capDaily: capDaily ?? DEFAULT_CAPS.daily, capMonthly: capMonthly ?? DEFAULT_CAPS.monthly, paused: orchestrator?.paused || null },
    lastBatchAt: orchestrator?.lastBatchAt
  };
}

const when = (t?: number) => t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
// A short text for prompts (under ~2K tokens): counts, the most recent applications, what's waiting.
export function summarize(w: WorldState): string {
  const lines = [
    `Jobs: ${w.jobs.eligible} eligible, ${w.jobs.queued.length} in today's batch, ${w.jobs.applying.length} applying now, ${w.jobs.applied.length} applied, ${w.jobs.needsYou.length} waiting for Ulugbek.`,
    w.jobs.applied.length ? `Applied recently: ${w.jobs.applied.slice(0, 15).map(j => `${j.company} (${j.title}, ${when(j.appliedAt)}, ${j.status})`).join("; ")}.` : "",
    w.jobs.queued.length ? `Queued: ${w.jobs.queued.slice(0, 20).map(j => `${j.company} (${j.title})`).join("; ")}.` : "",
    w.jobs.needsYou.length ? `Waiting for him: ${w.jobs.needsYou.map(j => `${j.company} (${j.title})`).join("; ")}.` : "",
    w.assignments.length ? `Assignments due soon: ${w.assignments.filter(a => a.status !== "done").sort((a, b) => a.due - b.due).slice(0, 8).map(a => `${a.course}: ${a.title} (${when(a.due)})`).join("; ")}.` : "",
    w.workers.filter(x => x.status === "working").length ? `Working now: ${w.workers.filter(x => x.status === "working").map(x => `Agent ${x.n} (${x.title})`).join("; ")}.` : "",
    `Spend: $${w.spend.today.toFixed(2)} today of $${w.spend.capDaily}, $${w.spend.month.toFixed(2)} this month of $${w.spend.capMonthly}${w.spend.paused ? `; paused (${w.spend.paused})` : ""}.`
  ].filter(Boolean);
  return lines.join("\n");
}

// What a browser worker gets: enough to not apply twice and to answer "did I apply here?".
export function sliceFor(w: WorldState, kind: "apply" | "read" | "write" | "classify"): WorldSlice {
  const applied30 = w.jobs.companiesApplied30d;
  const queued = [...new Set(w.jobs.queued.map(j => j.company))];
  const text = kind === "apply"
    ? `Companies applied to in the last 30 days: ${applied30.join(", ") || "none"}. Also in today's batch: ${queued.join(", ") || "none"}. Never apply twice to the same company in a month; if this form is for a company already applied to, finish with done and say so.`
    : `${w.jobs.applied.length} applications sent so far; ${w.jobs.queued.length} queued today.`;
  return { text, companiesApplied30d: applied30, queuedCompanies: queued };
}

// The world_query tool: a question about the job board, answered from storage (no model).
export function worldQuery(w: WorldState, question: string): string {
  const q = norm(question);
  const all = [...w.jobs.applied, ...w.jobs.queued, ...w.jobs.applying, ...w.jobs.needsYou];
  const companies = [...new Set(all.map(j => j.company))].filter(c => c && q.includes(norm(c)));
  if (companies.length) {
    return companies.map(c => {
      const mine = all.filter(j => j.company === c);
      return `${c}: ${mine.map(j => `${j.title}: ${j.status}${j.appliedAt ? ` (applied ${when(j.appliedAt)})` : ""}`).join("; ")}`;
    }).join("\n");
  }
  if (/\b(applied|sent|application)\b/.test(q)) return w.jobs.applied.length ? `Applied (${w.jobs.applied.length}): ${w.jobs.applied.slice(0, 30).map(j => `${j.company} (${j.title}, ${when(j.appliedAt)}, ${j.status})`).join("; ")}` : "No applications sent yet.";
  if (/\b(queue|queued|batch|today)\b/.test(q)) return w.jobs.queued.length ? `Today's batch (${w.jobs.queued.length}): ${w.jobs.queued.map(j => `${j.company} (${j.title})`).join("; ")}` : "The batch is empty.";
  if (/\b(need|waiting|stuck)\b/.test(q)) return w.jobs.needsYou.length ? `Waiting for Ulugbek: ${w.jobs.needsYou.map(j => `${j.company} (${j.title})`).join("; ")}` : "Nothing is waiting for him.";
  if (/\b(spend|cost|budget|money)\b/.test(q)) return `$${w.spend.today.toFixed(2)} today (cap $${w.spend.capDaily}), $${w.spend.month.toFixed(2)} this month (cap $${w.spend.capMonthly}).`;
  if (/\b(assignment|due|homework|exam|quiz)\b/.test(q)) return w.assignments.length ? w.assignments.sort((a, b) => a.due - b.due).slice(0, 15).map(a => `${a.course}: ${a.title}, due ${new Date(a.due).toLocaleString()} (${a.status})`).join("\n") : "No assignments recorded yet.";
  return summarize(w);
}
