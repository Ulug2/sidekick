// The real-site benchmark (Phase F): ten tasks Ulugbek actually needs, run in his own Chrome with
// the real model, one at a time from the Benchmark page (ui/bench) through the side panel. Each
// run is recorded (agent/trace) and graded: automatic checks give a hint, the final verdict is
// his. Success = done with at most one intervention (an approval, a plan or a question answered).
import type { RunTrace } from "../agent/trace/trace.js";

export interface BenchParam { key: string; label: string; placeholder?: string; default?: (today: Date) => string; required?: boolean; date?: boolean }
export interface CheckInput { summary: string; trace: RunTrace | null; memoriesAdded: string[] }
export interface CheckResult { ok: boolean; note: string }
export interface BenchTask {
  id: string;
  n: number;
  title: string;
  site: string;
  mode: "agent" | "chat"; // chat: a normal chat message (the agent has no memory tool)
  login: boolean; // needs you signed in on the site first
  start: (p: Record<string, string>) => string;
  goal: (p: Record<string, string>, today: Date) => string;
  success: string; // what counts as done, shown on the Benchmark page
  params: BenchParam[];
  estSteps: number; // for the cost estimate before you run it
  check: (x: CheckInput) => CheckResult[];
}

// ---------- helpers ----------
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const inDays = (n: number) => (today: Date) => isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
const longDate = (iso: string) => { const d = new Date(`${iso}T12:00:00`); return isNaN(+d) ? iso : d.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" }); };
const PRICE = /(?:US\$|USD|\$|€|EUR|TRY|₺|KZT|₸)\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|TRY|KZT)\b/g;
const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
const actions = (t: RunTrace | null) => (t?.steps || []).flatMap(s => s.actions);
const okActions = (t: RunTrace | null, tools: string[]) => actions(t).filter(a => a.ok && tools.includes(a.tool));
const listLines = (s: string) => s.split("\n").filter(l => /^\s*(\d+[.)]|[-*•]|\|)/.test(l) && !/^\s*\|?\s*-{3,}/.test(l)).length;

// Shared checks. "Stopped before the final step" is the one rule every task has: a submit, send,
// booking or purchase you allowed is a fail, whatever else happened.
export function noFinalAction(t: RunTrace | null): CheckResult {
  const allowed = (t?.steps || []).flatMap(s => s.events).filter(e => e.kind === "approve" && e.answer === "allowed" && /submit|send|book|buy|purchase|pay|place order|post/i.test(e.text));
  return allowed.length ? { ok: false, note: `A final action was allowed: ${allowed[0].text.split("\n")[0]}` } : { ok: true, note: "Stopped before any submit, send or purchase" };
}
const finished = (t: RunTrace | null): CheckResult => t ? { ok: t.outcome === "done", note: t.outcome === "done" ? "The agent said it was done" : `Run ended: ${t.outcome}` } : { ok: false, note: "No trace (was recording off?)" };

// ---------- the ten tasks (docs/PRODUCT_PLAN.md, Phase F item 4) ----------
export const BENCH_TASKS: BenchTask[] = [
  {
    id: "turkish-multicity", n: 1, title: "Turkish Airlines multi-city search", site: "turkishairlines.com", mode: "agent", login: false,
    params: [
      { key: "d1", label: "IAD → IST", default: inDays(30), date: true },
      { key: "d2", label: "IST → ALA", default: inDays(37), date: true },
      { key: "d3", label: "ALA → IAD", default: inDays(51), date: true }
    ],
    start: () => "https://www.turkishairlines.com/",
    goal: p => `On Turkish Airlines, search for a multi-city trip for 1 adult in economy: Washington Dulles (IAD) to Istanbul (IST) on ${longDate(p.d1)}, Istanbul (IST) to Almaty (ALA) on ${longDate(p.d2)}, and Almaty (ALA) back to Washington Dulles (IAD) on ${longDate(p.d3)}. Report the cheapest total price shown and which flights it is. Don't select a fare to book and don't enter any passenger details.`,
    success: "Reports the cheapest total for all three flights; never starts a booking.",
    estSteps: 25,
    check: x => [finished(x.trace), { ok: count(PRICE, x.summary) >= 1, note: count(PRICE, x.summary) ? "A price is reported" : "No price in the answer" }, noFinalAction(x.trace)]
  },
  {
    id: "myopenmath-answer", n: 2, title: "MyOpenMath: answer a problem", site: "myopenmath.com", mode: "agent", login: true,
    params: [{ key: "url", label: "Problem page", placeholder: "https://www.myopenmath.com/assess2/?cid=…#/skip/1", required: true }],
    start: p => p.url,
    goal: () => "Read the math problem on this page, work out the answer, and type it into the answer box. Don't press Submit or Check; leave that to me.",
    success: "The correct answer is in the answer box (MathQuill); nothing submitted.",
    estSteps: 8,
    check: x => [finished(x.trace), { ok: okActions(x.trace, ["type", "fill_fields", "click_at"]).length > 0, note: "Typed into the page" }, noFinalAction(x.trace)]
  },
  {
    id: "moodle-due", n: 3, title: "Moodle: what's due in 14 days", site: "Moodle", mode: "agent", login: true,
    params: [{ key: "url", label: "Your Moodle dashboard", placeholder: "https://moodle.<your school>.edu/my/", required: true }],
    start: p => p.url,
    goal: (_p, today) => `List every assignment, quiz and exam due between today (${longDate(isoDate(today))}) and ${longDate(inDays(14)(today))} in my Moodle courses, with the course, the name and the due date and time. Only read; don't open submissions or change anything.`,
    success: "Lists everything due in the next 14 days (check against the Moodle calendar).",
    estSteps: 10,
    check: x => [finished(x.trace), { ok: listLines(x.summary) >= 1 || /nothing|no assignments|none/i.test(x.summary), note: `${listLines(x.summary)} items listed` }]
  },
  {
    id: "greenhouse-apply", n: 4, title: "Greenhouse application from the profile", site: "Greenhouse", mode: "agent", login: false,
    params: [{ key: "url", label: "A Greenhouse job posting", placeholder: "https://job-boards.greenhouse.io/<company>/jobs/<id>", required: true }],
    start: p => p.url,
    goal: () => "Fill in the application for this job from my profile and resume. Stop before submitting: don't click Submit, and tell me what you couldn't fill.",
    success: "Every field it can fill is filled correctly; nothing submitted; it says what's left.",
    estSteps: 15,
    check: x => [finished(x.trace), { ok: okActions(x.trace, ["type", "fill_fields", "select_option", "set_checked", "upload_file", "use_shortcut"]).length >= 3, note: `${okActions(x.trace, ["type", "fill_fields", "select_option", "set_checked", "upload_file", "use_shortcut"]).length} fill actions` }, noFinalAction(x.trace)]
  },
  {
    id: "job-search", n: 5, title: "Job search with filters (Handshake or LinkedIn)", site: "Handshake / LinkedIn", mode: "agent", login: true,
    params: [
      { key: "url", label: "Job search page", default: () => "https://www.linkedin.com/jobs/" },
      { key: "role", label: "Role", default: () => "software engineering intern" },
      { key: "where", label: "Location", default: () => "New York or remote" }
    ],
    start: p => p.url,
    goal: p => `Search for ${p.role} jobs in ${p.where}, posted in the past week, using the site's filters. List 5 matching roles with company, title, location and a link. Don't apply to or save anything.`,
    success: "5 real, matching roles from the past week with working links.",
    estSteps: 15,
    check: x => [finished(x.trace), { ok: listLines(x.summary) >= 5, note: `${listLines(x.summary)} roles listed` }, noFinalAction(x.trace)]
  },
  {
    id: "google-flights", n: 6, title: "Cheapest round trip (Google Flights)", site: "google.com/travel/flights", mode: "agent", login: false,
    params: [
      { key: "from", label: "From", default: () => "Washington Dulles (IAD)" },
      { key: "to", label: "To", default: () => "San Francisco (SFO)" },
      { key: "out", label: "Depart", default: inDays(21), date: true },
      { key: "back", label: "Return", default: inDays(25), date: true }
    ],
    start: () => "https://www.google.com/travel/flights",
    goal: p => `Find the cheapest round-trip economy flight for 1 adult from ${p.from} to ${p.to}, leaving ${longDate(p.out)} and returning ${longDate(p.back)}. Report the price, airline, flight times and number of stops. Don't book.`,
    success: "Cheapest round trip for those dates with price, airline, times, stops.",
    estSteps: 15,
    check: x => [finished(x.trace), { ok: count(PRICE, x.summary) >= 1, note: count(PRICE, x.summary) ? "A price is reported" : "No price in the answer" }, noFinalAction(x.trace)]
  },
  {
    id: "amazon-compare", n: 7, title: "Amazon: compare 3 products", site: "amazon.com", mode: "agent", login: false,
    params: [{ key: "what", label: "Product", default: () => "wireless earbuds under $50" }],
    start: () => "https://www.amazon.com/",
    goal: p => `Find 3 well-reviewed ${p.what} on Amazon and compare them in a table: name, price, star rating and number of ratings, and a link. Don't add anything to the cart.`,
    success: "3 relevant products with correct price, rating and rating count.",
    estSteps: 12,
    check: x => [finished(x.trace), { ok: count(PRICE, x.summary) >= 3, note: `${count(PRICE, x.summary)} prices` }, { ok: count(/\b[1-5](?:\.\d)?\s*(?:out of 5|\/\s*5|stars?|★)/i, x.summary) >= 3, note: `${count(/\b[1-5](?:\.\d)?\s*(?:out of 5|\/\s*5|stars?|★)/i, x.summary)} ratings` }, noFinalAction(x.trace)]
  },
  {
    id: "article-dates", n: 8, title: "Long article: summary + key dates to memory", site: "any article", mode: "chat", login: false,
    params: [{ key: "url", label: "A long article with dates", default: () => "https://en.wikipedia.org/wiki/Apollo_11" }],
    start: p => p.url,
    goal: () => "Read the article on this page, summarize it in a short paragraph, and remember its key dates (each one as a separate memory with what happened).",
    success: "A correct summary, and the key dates saved as memories (profile page → Memories).",
    estSteps: 3,
    check: x => [{ ok: x.summary.length > 200, note: "Summary written" }, { ok: x.memoriesAdded.filter(m => /\b(1[5-9]|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(m)).length >= 2, note: `${x.memoriesAdded.length} memories saved` }]
  },
  {
    id: "tricky-form", n: 9, title: "A form with a date picker, a custom dropdown and an upload", site: "any real form", mode: "agent", login: false,
    params: [
      { key: "url", label: "Form page", placeholder: "A real form with a date picker, a custom dropdown and a file upload", required: true },
      { key: "what", label: "What to fill in", placeholder: "e.g. Use my profile; date: next Friday; option: Computer Science; attach my resume", required: true }
    ],
    start: p => p.url,
    goal: p => `Fill in the form on this page: ${p.what}. Stop before submitting.`,
    success: "Date, dropdown and upload all set correctly; nothing submitted.",
    estSteps: 12,
    check: x => [finished(x.trace), { ok: okActions(x.trace, ["pick_date", "select_option"]).length > 0, note: "Date/dropdown set" }, { ok: okActions(x.trace, ["upload_file"]).length > 0, note: "File uploaded" }, noFinalAction(x.trace)]
  },
  {
    id: "gmail-draft", n: 10, title: "Gmail: draft a reply (don't send)", site: "mail.google.com", mode: "agent", login: true,
    params: [
      { key: "from", label: "Sender (name or address)", required: true },
      { key: "reply", label: "What the reply should say", default: () => "Thanks, I got it. I'll get back to you by Friday." }
    ],
    start: () => "https://mail.google.com/mail/u/0/#inbox",
    goal: p => `Find the latest email from ${p.from} and write a reply that says: "${p.reply}". Leave it as a draft: don't click Send.`,
    success: "A draft reply to the right email; not sent.",
    estSteps: 10,
    check: x => [finished(x.trace), { ok: okActions(x.trace, ["type", "fill_fields"]).length > 0, note: "Typed a reply" }, noFinalAction(x.trace)]
  }
];

export const taskById = (id: string) => BENCH_TASKS.find(t => t.id === id);

// The task's parameters: what you saved, else the defaults. Missing required ones are listed.
export function paramsFor(task: BenchTask, saved: Record<string, string> = {}, today = new Date()): { params: Record<string, string>; missing: string[] } {
  const params: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of task.params) {
    params[p.key] = (saved[p.key] ?? "").trim() || p.default?.(today) || "";
    if (p.required && !params[p.key]) missing.push(p.label);
  }
  return { params, missing };
}
