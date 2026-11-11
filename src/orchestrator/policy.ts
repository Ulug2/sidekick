// One autonomy policy for every gate (docs/BUGS.md 3). run-tool asks `decide()` before anything
// final; the answer is "run", "ask" (the UI asks, or an unattended batch sets the job aside) or
// "refuse" (never, whatever the model says). Rules live here, not in prompts.
import type { AutonomyLevel } from "./types.js";
import { siteOf } from "../core/security/sites.js";

export type ActionCheck =
  | { kind: "final-click"; site: string; label: string; description?: string }
  | { kind: "enter-submit"; site: string; context: string }
  | { kind: "upload"; site: string; file: string }
  | { kind: "share"; site: string; kinds: string[] }
  | { kind: "visit"; site: string }
  | { kind: "site-tool"; site: string; name: string; description: string; readOnly: boolean; autosubmit: boolean; personal: boolean }
  | { kind: "type"; site: string };
export interface PolicyContext {
  level: AutonomyLevel;
  approvedSites: Set<string>; // the plan's or the batch's sites
  pageSites: Set<string>; // the current tab's site and the sites of the frames on it
  visitedOk: Set<string>;
  sharedOk: Set<string>;
}
export type Decision = { verdict: "run"; note?: string } | { verdict: "ask"; title: string } | { verdict: "refuse"; reason: string };

// Money, deleting and publishing never run by themselves, at any level.
export const NEVER_AUTO = /\b(pay|payment|purchase|buy|order|checkout|check out|donate|transfer|delete|remove|unsubscribe|publish|post)\b|\b(pay|delete|remove|post|publish|purchase|order|transfer)_/i;
// A batch may sign the application it was approved for ("Sign and submit"), nothing else binding.
const BINDING = /\b(sign|agree|consent|attest|certify|accept)\b/i;
const APPLICATION_SUBMIT = /\b(submit|send|apply|finish|complete)\b/i;

// Application systems whose forms companies embed in their own careers pages. A frame from one of
// these on an approved page is part of the application; any other frame (ads, chat widgets,
// payment boxes) is not covered.
export const ATS_SITES = new Set(["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "myworkdayjobs.com", "workday.com", "icims.com", "jobvite.com", "bamboohr.com", "teamtailor.com", "recruitee.com", "breezy.hr", "jazzhr.com", "applytojob.com", "personio.de", "personio.com", "successfactors.com", "taleo.net", "oraclecloud.com", "rippling.com", "dover.com", "pinpointhq.com", "homerun.co", "join.com", "polymer.co"]);
const isAts = (site: string) => ATS_SITES.has(site) || ((globalThis as { SK_EXTRA_ATS?: string[] }).SK_EXTRA_ATS || []).includes(site);
// The site is one the batch covers: approved outright, or an application-system frame on an
// approved page (a Greenhouse board embedded in the company's careers site).
export function siteCovered(site: string, ctx: PolicyContext): boolean {
  if (!site) return false;
  if (ctx.approvedSites.has(site)) return true;
  return isAts(site) && ctx.pageSites.has(site) && [...ctx.pageSites].some(s => ctx.approvedSites.has(s));
}

export function decide(a: ActionCheck, ctx: PolicyContext): Decision {
  const { level } = ctx;
  if (level === "every-click") return { verdict: "ask", title: titleOf(a) };
  if (level === "read-only") {
    if (a.kind === "final-click" || a.kind === "enter-submit" || a.kind === "upload" || (a.kind === "site-tool" && !a.readOnly)) return { verdict: "refuse", reason: "This task is read-only: Sidekick reads and organizes course sites and email, it never submits or uploads there." };
    if (a.kind === "share") return { verdict: "refuse", reason: "This task is read-only: no personal details are typed anywhere." };
    // A new site still gets the visit check (a page could steer a reading task somewhere else).
    if (a.kind === "visit" && !ctx.visitedOk.has(a.site) && !ctx.approvedSites.has(a.site)) return { verdict: "ask", title: titleOf(a) };
    return { verdict: "run" };
  }
  switch (a.kind) {
    case "final-click": {
      const text = `${a.label} ${a.description || ""}`;
      if (NEVER_AUTO.test(text)) return { verdict: "ask", title: titleOf(a) };
      if (level === "approved-batch" && siteCovered(a.site, ctx)) {
        if (BINDING.test(text) && !APPLICATION_SUBMIT.test(text)) return { verdict: "ask", title: titleOf(a) }; // a bare "I agree" button the agent isn't sure about
        return { verdict: "run", note: `Submitting without asking, as you approved this application: ${a.description || a.label}` };
      }
      return { verdict: "ask", title: titleOf(a) };
    }
    case "enter-submit":
      // context: the page's title, address and buttons; a checkout or payment form always asks.
      if (NEVER_AUTO.test(a.context)) return { verdict: "ask", title: titleOf(a) };
      return level === "approved-batch" && siteCovered(a.site, ctx) ? { verdict: "run", note: "Pressing Enter to submit, as you approved this application" } : { verdict: "ask", title: titleOf(a) };
    case "upload":
      return (level === "approved-batch" && siteCovered(a.site, ctx)) || ctx.approvedSites.has(a.site) ? { verdict: "run" } : { verdict: "ask", title: titleOf(a) };
    case "share":
      return (level === "approved-batch" && siteCovered(a.site, ctx)) || ctx.approvedSites.has(a.site) || ctx.sharedOk.has(a.site) ? { verdict: "run" } : { verdict: "ask", title: titleOf(a) };
    case "visit":
      return ctx.visitedOk.has(a.site) || ctx.approvedSites.has(a.site) || (level === "approved-batch" && siteCovered(a.site, ctx)) ? { verdict: "run" } : { verdict: "ask", title: titleOf(a) };
    case "site-tool":
      if (a.readOnly && !a.personal) return { verdict: "run" };
      if (NEVER_AUTO.test(`${a.name} ${a.description}`)) return { verdict: "ask", title: titleOf(a) };
      // Only a form-backed tool that submits the application counts as the batch's submit; any
      // other tool that changes something on the site asks (CLAUDE.md invariant).
      if (a.autosubmit) return decide({ kind: "final-click", site: a.site, label: `${a.name} (submits the form)`, description: a.description }, ctx);
      return { verdict: "ask", title: titleOf(a) };
    case "type":
      return { verdict: "run" };
  }
}

export function titleOf(a: ActionCheck): string {
  switch (a.kind) {
    case "final-click": return `Click “${a.label}” on ${a.site || "this page"}`;
    case "enter-submit": return "Press Enter, which will submit this form";
    case "upload": return `Attach your ${a.file} on ${a.site}?`;
    case "share": return `Share your ${a.kinds.join(", ")} with ${a.site}?`;
    case "visit": return `Go to ${a.site}?`;
    case "site-tool": return `Use ${a.site}'s “${a.name}” tool${a.autosubmit ? " (submits the form)" : ""}${a.personal ? " (sends your details)" : ""}`;
    case "type": return "Type here";
  }
}

export const siteOfUrl = (url: string) => siteOf(url);
