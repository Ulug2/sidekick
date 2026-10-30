// Site notes: a few short tips per site, learned by the fast model from a run that hit problems
// ("the Location field is a custom dropdown: type the city, then pick the first option").
// Learned from value-free step lists only. Stored in chrome.storage.local "siteNotes".
import type { SiteNote, Shortcut } from "../types.js";
import { readLocal } from "../../core/storage/schema.js";
import { redactSecrets } from "../../core/security/guard.js";
import { normLabel } from "./shortcuts.js";
import { modelCall } from "../../core/llm/call.js";

export const SITE_NOTES_MAX = 8;

// With a site: that site's notes. Without: every site's notes.
export async function getSiteNotes(site: string): Promise<SiteNote[]>;
export async function getSiteNotes(): Promise<Record<string, SiteNote[]>>;
export async function getSiteNotes(site?: string): Promise<SiteNote[] | Record<string, SiteNote[]>> {
  const { siteNotes = {} } = await readLocal("siteNotes");
  return site ? siteNotes[site] || [] : siteNotes;
}
export async function saveSiteNotes(site: string, notes: SiteNote[]): Promise<void> {
  const { siteNotes = {} } = await readLocal("siteNotes");
  if (notes.length) siteNotes[site] = notes.slice(-SITE_NOTES_MAX);
  else delete siteNotes[site];
  await chrome.storage.local.set({ siteNotes });
}

// Learns 1–4 short, reusable notes about a site from a run that hit problems (errors, retries,
// your corrections). Uses the fast model; costs a fraction of a cent.
export async function learnSiteNotes({ site, goal, steps, errors, answers, signal }: { site: string; goal: string; steps: string[]; errors: string[]; answers: string[]; signal?: AbortSignal }): Promise<string[]> {
  if (!site || (!errors.length && !answers.length)) return [];
  const existing = await getSiteNotes(site);
  const log = steps.slice(-40).map((s, i) => `${i + 1}. ${redactSecrets(s).text}`).join("\n");
  const prompt = `A browser agent just finished this task on ${site}: "${String(goal).slice(0, 200)}"

Steps it took:
${log}

Problems it hit:
${errors.slice(-10).map(e => `- ${e}`).join("\n") || "- none"}
${answers.length ? `\nThe user had to step in:\n${answers.slice(-5).map(a => `- ${a}`).join("\n")}` : ""}

Notes already saved for this site:
${existing.map(n => `- ${n.text}`).join("\n") || "- none"}

Write up to 3 NEW short notes (one sentence each) that would help an agent do tasks on ${site} faster next time: how tricky widgets work, where things are, what failed and what worked instead. Only lasting facts about the site, not about this one task. Never include personal data (names, emails, answers, numbers). If nothing new is worth saving, return an empty list.
Reply with only JSON: {"notes": ["...", "..."]}`;
  const r = await modelCall({ tier: "fast", system: "You write short, reusable operating notes about websites for a browser agent. Reply with JSON only.", messages: [{ role: "user", text: prompt }], signal, maxTokens: 600 });
  let notes: string[] = [];
  try { notes = JSON.parse(r.text.match(/\{[\s\S]*\}/)![0]).notes || []; } catch { return []; }
  notes = notes.map(n => String(n).trim().slice(0, 240)).filter(n => n && !redactSecrets(n).count && !existing.some(e => normLabel(e.text) === normLabel(n))).slice(0, 3);
  if (notes.length) await saveSiteNotes(site, [...existing, ...notes.map(text => ({ text, added: Date.now() }))]);
  return notes;
}

// The short text the agent sees for a site: shortcuts it can run and notes from earlier runs.
export function siteKnowledgeText(adapters: Shortcut[], notes: SiteNote[]): string {
  const out: string[] = [];
  if (adapters.length) {
    out.push("Sidekick's learned shortcuts for this site (use_shortcut runs the routine steps instantly; it stops for written answers, choices that aren't in the profile, and before any final action):");
    for (const a of adapters.slice(0, 5)) {
      const auto = a.steps.filter(s => !s.needsModel && !s.final && !s.optional).length;
      const record = a.replays ? `, worked in ${a.replayOk || 0} of ${a.replays} replay${a.replays > 1 ? "s" : ""}` : "";
      out.push(`- [${a.id}] ${a.title} (${a.steps.length} steps, ${auto} automatic${record})`);
    }
  }
  if (notes.length) {
    out.push("Notes from earlier runs on this site:");
    for (const n of notes.slice(-SITE_NOTES_MAX)) out.push(`- ${n.text}`);
  }
  return out.join("\n");
}
