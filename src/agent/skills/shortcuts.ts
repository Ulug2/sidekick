// Learned site shortcuts: after the agent finishes a task, the steps that worked are compiled
// into a shortcut for that site. Next time, use_shortcut replays the routine steps (navigation,
// profile fields, resume upload) in milliseconds without calling the model. Steps that need
// judgment (written answers, terms checkboxes, anything not from the profile) and final actions
// (submit, pay, send) are always handed back to the model and to you.
// Stored only in this browser (chrome.storage.local "adapters").
import { redactSecrets } from "../../core/security/guard.js";
import { readLocal } from "../../core/storage/schema.js";
import type { Profile } from "../../assistant/profile-core.js";
import type { ActionLogEntry, ElementInfo, Shortcut, ShortcutStep } from "../types.js";
import { siteOf } from "../../core/security/sites.js";
import { profileValues } from "../../core/security/personal-data.js";

export const ADAPTERS_MAX = 40;
export const ADAPTER_STEPS_MAX = 60;

export async function getAdapters(): Promise<Shortcut[]> {
  const { adapters = [] } = await readLocal("adapters");
  return adapters;
}
export async function saveAdapters(list: Shortcut[]): Promise<void> {
  await chrome.storage.local.set({ adapters: list.slice(0, ADAPTERS_MAX) });
}
export async function deleteAdapter(id: string): Promise<void> {
  await saveAdapters((await getAdapters()).filter(a => a.id !== id));
}
export async function adaptersFor(url: string): Promise<Shortcut[]> {
  const site = siteOf(url);
  return (await getAdapters()).filter(a => a.site === site);
}

// ---------- matching elements by meaning, not by id ----------

export const normLabel = (t: unknown) => String(t || "").toLowerCase().replace(/[*:•✱]+/g, " ").replace(/\(required\)|\brequired\b/g, " ").replace(/\s+/g, " ").trim();

export function roleFamily(role: string): "text" | "choice" | "check" | "radio" | "file" | "click" {
  const r = String(role || "");
  if (/^(textbox|textarea|searchbox|spinbutton)/.test(r)) return "text";
  if (/^(select|combobox|listbox)$/.test(r)) return "choice";
  if (r === "checkbox" || r === "switch") return "check";
  if (r === "radio") return "radio";
  if (r === "file") return "file";
  return "click"; // button, link, clickable, tab, option, menuitem, summary…
}

export function questionOfLine(line: string): string {
  const m = String(line || "").match(/question: "([^"]*)"/);
  return m ? m[1] : "";
}

// Which element in the current snapshot is this step's target? Returns an id or null.
// elements: { id: { role, label, line, section } }
export function findTarget(elements: Record<string, Pick<ElementInfo, "role" | "label" | "line" | "section">>, step: Pick<ShortcutStep, "role" | "label" | "question" | "section" | "nth">): string | null {
  const want = normLabel(step.label);
  const fam = roleFamily(step.role);
  const q = normLabel(step.question);
  const scored: { id: string; score: number }[] = [];
  for (const [id, e] of Object.entries(elements || {})) {
    if (roleFamily(e.role) !== fam) continue;
    const got = normLabel(e.label);
    let score = 0;
    if (want && got === want) score = 10;
    else if (want.length >= 3 && got.length >= 3 && (got.includes(want) || want.includes(got))) score = 5;
    else if (!want && !got) score = 3;
    else continue;
    if (q) {
      const eq = normLabel(questionOfLine(e.line));
      if (eq && eq === q) score += 4;
      else if (eq && q.length > 8 && (eq.includes(q.slice(0, 40)) || q.includes(eq.slice(0, 40)))) score += 2;
      else score -= 6; // a "Yes" under a different question is the wrong "Yes"
    }
    if (step.section && e.section && normLabel(e.section) === normLabel(step.section)) score += 2;
    if (/\bdisabled\b/.test(e.line || "")) score -= 3;
    if (score >= 5) scored.push({ id, score });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map(s => s.score));
  const top = scored.filter(s => s.score === best).sort((a, b) => idOrder(a.id) - idOrder(b.id));
  return top[Math.min(step.nth || 0, top.length - 1)].id;
}
export const idOrder = (id: string) => { const [f, n] = String(id).includes(":") ? String(id).split(":").map(Number) : [0, Number(id)]; return f * 1e6 + n; };

// Position of an element among same-looking ones (same role family and label), for findTarget.
export function nthOf(elements: Record<string, Pick<ElementInfo, "role" | "label" | "line">>, id: string): number {
  const e = elements[id];
  if (!e) return 0;
  const same = Object.keys(elements).filter(k => roleFamily(elements[k].role) === roleFamily(e.role) && normLabel(elements[k].label) === normLabel(e.label) && questionOfLine(elements[k].line) === questionOfLine(e.line)).sort((a, b) => idOrder(a) - idOrder(b));
  return Math.max(0, same.indexOf(id));
}

// Words in a question that tell profile fields with the same value apart ("Yes" for
// authorization vs. "Yes" for relocation).
export const KEY_HINTS: Record<string, RegExp> = {
  firstName: /first|given/, lastName: /last|family|surname/, fullName: /full name|^name$|your name/,
  email: /e-?mail/, phone: /phone|mobile/, city: /city|town/, state: /state|province|region/, zip: /zip|postal/,
  country: /country/, location: /location|where.*(live|based)/, linkedin: /linkedin/, github: /github/, portfolio: /portfolio|website/,
  workAuthorized: /authori[sz]|eligib|legally/, needsSponsorship: /sponsor|visa/, willingToRelocate: /relocat/,
  workMode: /remote|hybrid|on-?site|work mode/, salaryExpectation: /salary|compensation|pay/, startDate: /start|available|notice/,
  howHeard: /hear about|how did you|source|referr/, eeoGender: /gender|sex/, eeoRace: /race|ethnic|hispanic/,
  eeoVeteran: /veteran|military/, eeoDisability: /disab/
};

// Which profile field produced this value? Null if none, or if it's ambiguous.
export function profileKeyFor(value: unknown, vals: Record<string, string>, context: string): string | null {
  const want = normLabel(value);
  if (!want) return null;
  const keys = Object.keys(vals).filter(k => vals[k] && normLabel(vals[k]) === want);
  if (keys.length === 1) return keys[0];
  if (keys.length > 1) {
    const ctx = normLabel(context);
    const hinted = keys.filter(k => KEY_HINTS[k]?.test(ctx));
    if (hinted.length === 1) return hinted[0];
    if (keys.every(k => ["firstName", "fullName", "preferredName"].includes(k)) && keys.includes("firstName")) return KEY_HINTS.firstName.test(ctx) ? "firstName" : keys[0];
  }
  return null;
}

// Checkboxes that agree to something are never replayed: the model must decide each time.
export const CONSENT = /\b(agree|terms|consent|certif|acknowledg|attest|privacy|policy|authori[sz]e .* to|i understand|declare)\b/i;
// Popups that may or may not be there next time.
export const OPTIONAL_CLICK = /\b(cookie|accept all|accept cookies|got it|dismiss|no thanks|close|maybe later|not now|skip)\b/i;

// One successful action → a replayable step (or a step the model must do).
// entry: { tool, role, label, question, section, nth, value, final, description, host }
export function compileStep(entry: ActionLogEntry, vals: Record<string, string>): ShortcutStep | null {
  // Click descriptions are kept for ordinary clicks only ("Open the application form"); a final
  // click's description summarizes your answers, so it isn't stored.
  const description = entry.tool === "click" && !entry.final ? redactSecrets(String(entry.description || "")).text.slice(0, 80) : "";
  const s: ShortcutStep = { tool: entry.tool, role: entry.role, label: entry.label, question: entry.question || "", section: entry.section || "", nth: entry.nth || 0, description };
  const context = [entry.label, entry.question, entry.section].join(" ");
  if (entry.final) return { ...s, final: true };
  switch (entry.tool) {
    case "type":
    case "select_option": {
      const key = profileKeyFor(entry.value, vals, context);
      if (key) return { ...s, valueKey: key };
      // Not from the profile: a written answer or a choice the model made. Never replayed.
      // Typed text is never stored; a short dropdown choice is kept as a hint.
      if (entry.tool === "select_option" && String(entry.value || "").length <= 60 && !redactSecrets(String(entry.value)).count) return { ...s, needsModel: true, hint: `chose "${entry.value}" last time` };
      return { ...s, needsModel: true, hint: entry.role === "textarea" ? "a written answer" : "" };
    }
    case "set_checked": {
      if (entry.value && CONSENT.test(context)) return { ...s, needsModel: true, hint: "checked last time" };
      if (entry.role === "radio") {
        const key = profileKeyFor(entry.label, vals, [entry.question, entry.section].join(" "));
        if (key) return { ...s, labelKey: key, value: true };
        return { ...s, needsModel: true, hint: `chose "${entry.label}" last time` };
      }
      return { ...s, value: !!entry.value };
    }
    case "upload_file": return { ...s, value: "resume" };
    case "press_key": return { ...s, value: entry.value };
    case "click":
      if (entry.role === "radio" || entry.role === "checkbox") return { ...s, needsModel: true, hint: `clicked "${entry.label}" last time` };
      return { ...s, optional: OPTIONAL_CLICK.test(entry.label) };
    default:
      return null;
  }
}

// A finished run's action log → a shortcut for the site where most of the work happened.
export function compileFlow(log: ActionLogEntry[], profile: Profile, goal: string): Pick<Shortcut, "site" | "goal" | "title" | "steps"> | null {
  if (!log?.length) return null;
  const bySite: Record<string, number> = {};
  for (const e of log) bySite[e.site] = (bySite[e.site] || 0) + 1;
  const site = Object.entries(bySite).sort((a, b) => b[1] - a[1])[0][0];
  const vals = profileValues(profile);
  const steps: ShortcutStep[] = [];
  for (const e of log.filter(x => x.site === site)) {
    const s = compileStep(e, vals);
    if (!s) continue;
    // A retry of the same target replaces the earlier attempt.
    const prev = steps.at(-1);
    if (prev && prev.tool === s.tool && normLabel(prev.label) === normLabel(s.label) && prev.question === s.question && s.tool !== "click") steps.pop();
    steps.push(s);
  }
  const replayable = steps.filter(s => !s.needsModel && !s.final && !s.optional).length;
  if (steps.length < 3 || replayable < 2) return null;
  return {
    site,
    goal: String(goal || "").slice(0, 200),
    title: titleFor(goal, site),
    steps: steps.slice(0, ADAPTER_STEPS_MAX)
  };
}

export function titleFor(goal: string, site: string): string {
  const g = String(goal || "").replace(/\s+/g, " ").trim();
  const short = g.length > 70 ? g.slice(0, 67).replace(/\s+\S*$/, "") + "…" : g;
  return short || `Routine on ${site}`;
}

// How alike two step lists are (share of targets in common), to update instead of duplicate.
export function flowSimilarity(a: ShortcutStep[], b: ShortcutStep[]): number {
  const key = (s: ShortcutStep) => `${s.tool}|${roleFamily(s.role)}|${normLabel(s.label)}`;
  const A = new Set(a.map(key)), B = new Set(b.map(key));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

// Saves or updates the shortcut for a finished run. Returns the saved adapter (or null).
export async function learnFlow(log: ActionLogEntry[], profile: Profile, goal: string): Promise<Shortcut | null> {
  const flow = compileFlow(log, profile, goal);
  if (!flow) return null;
  const list = await getAdapters();
  const same = list.find(a => a.site === flow.site && flowSimilarity(a.steps, flow.steps) >= 0.6);
  const now = Date.now();
  let saved: Shortcut;
  if (same) {
    Object.assign(same, { steps: flow.steps, updated: now, runs: (same.runs || 1) + 1 });
    saved = same;
  } else {
    saved = { id: "s_" + Math.random().toString(36).slice(2, 8), ...flow, created: now, updated: now, runs: 1, replays: 0, replayOk: 0 };
    list.unshift(saved);
  }
  // Keep the most useful: recently updated and often used.
  list.sort((a, b) => (b.updated + (b.replayOk || 0) * 864e5) - (a.updated + (a.replayOk || 0) * 864e5));
  await saveAdapters(list);
  return saved;
}
