// Can this employer give Ulugbek (F-1, Kazakhstan, STEM degree) a work visa for this job? Evidence
// per country, each with its source and date, and one confidence (v1 Phase 4, docs/PLAN.md):
//   confirmed: the posting says it sponsors, the employer holds a licence that exists for exactly
//              this (UK Skilled Worker register, Dutch IND recognised sponsor), or the UAE (every
//              employer arranges the visa).
//   likely:    the employer filed for it recently (DOL LCA certifications, USCIS H-1B approvals,
//              Canadian positive LMIAs), or a European posting offers relocation / a work permit.
//   unknown:   nothing either way (or the data is stale). Not batched.
//   no:        the posting rules him out (no sponsorship, citizens / permanent residents only,
//              clearance, "U.S. person").
// Only confirmed and likely enter batches. All of it is code: no model calls.
import type { SponsorLevel } from "./types.js";

export type Confidence = Extract<SponsorLevel, "confirmed" | "likely" | "unknown" | "no">;
export type EvidenceSource = "posting" | "uscis-h1b" | "dol-lca" | "uk-register" | "ind" | "lmia" | "uae";
export interface Evidence { source: EvidenceSource; text: string; date?: string; country: string; confidence: Confidence }

export interface SponsorData {
  h1b: (company: string) => number; // USCIS H-1B approvals found for this employer (0 = none)
  ukSponsor: (company: string) => boolean; // on the UK Skilled Worker register
  // Optional lists (Phase 4): DOL LCA certifications, the IND register, Canadian positive LMIAs.
  lca?: (company: string) => number;
  nlSponsor?: (company: string) => boolean;
  caLmia?: (company: string) => number;
  dates?: { h1b?: string; uk?: string; lca?: string; ind?: string; lmia?: string };
  lcaStale?: boolean; // older than LCA_STALE_DAYS: shown, not counted
}
export const LCA_STALE_DAYS = 120;

// ---------- what the posting says ----------
// "Executive sponsor", "sponsorship deals" and the like don't count: only visa wording does.
export const NO_SPONSOR = [
  /\b(unable|not able|cannot|can ?not|can't|do not|don't|does not|doesn't|will not|won't|are not able|is not able|not in a position|no longer)\b[^.]{0,40}\b(sponsor|sponsorship)\b[^.]{0,40}\b(visa|work|employment|immigration|h-?1b|authori[sz]ation|candidates|applicants|this (role|position))/i,
  /\b(visa|immigration|employment|work)[- ]?(visa )?sponsorship\b[^.]{0,30}\b(is |are |will )?(currently )?(not (be )?(available|provided|offered|possible|supported)|unavailable)/i,
  /\b(unable|not able|cannot|can ?not|can't|do not|don't|does not|doesn't|will not|won't|are not able|is not able)( to)?( currently)? (sponsor|offer( any)?( visa)? sponsorship|provide( any)?( visa)? sponsorship|support( visa)? sponsorship)\b/i,
  /\bwithout (the need for |requiring |needing |the need of )?(current or future |now or in the future |any |future )?(employer |visa |immigration |employment |company )?sponsorship\b/i,
  /\bno (visa|immigration|employment|work[- ]?visa|h-?1b) sponsorship\b/i,
  /\bsponsorship (is )?not (available|provided|offered)\b/i,
  /\b(now or in the future|currently or in the future)\b[^.]{0,30}\b(require|need)\b[^.]{0,20}\bsponsorship\b[^.]{0,40}\b(not eligible|ineligible|will not be considered|cannot be considered)/i
];
export const CITIZENS_ONLY = [
  /\b(must be|be) (a )?(u\.?s\.?|united states) citizens?\b/i,
  /\bu\.?s\.? citizenship (is )?(required|needed|mandatory)\b/i,
  /\b(only )?(u\.?s\.? citizens|green card holders)( (and|or) (green card holders|permanent residents|u\.?s\.? citizens))?( only| are eligible)\b/i,
  /\b(must be|requires|required to be|only|open to|restricted to|limited to)\b[^.]{0,40}\b(citizens?|nationals?) (or|and) (lawful |legal )?permanent residents?\b/i,
  // "requires", never "require": "we do not require a green card" must not match.
  /(?<!\b(?:not|never|n't)\s)\b(must be|must hold|must have|requires|required to (?:be|hold|have))\b[^.]{0,20}\b(a |an )?(lawful |legal )?(permanent residen(?:t|cy)|green card)( status)?\b/i,
  /\b(active|current|ability to obtain|eligible for|obtain and maintain) (a |an )?(u\.?s\.? )?(government |dod |secret |top secret |ts\/sci |security )+clearance\b/i,
  /\b(itar|export control)[^.]{0,80}\b(u\.?s\.? person|citizen|permanent resident)/i,
  /\b(require[sd]?|must be|only|eligib\w+|restricted to|limited to|open to)\b[^.]{0,60}\bu\.?s\.? persons?\b/i,
  /\bu\.?s\.? persons?\b[^.]{0,40}\b(only|required|status|as defined)\b/i,
  /\bmust (already )?have (the )?(full |existing |unrestricted )?right to work in (the )?(uk|united kingdom|eu|european union|canada|germany|ireland|the netherlands|netherlands)\b/i,
  /\b(must be|be) (a |an )?(canadian|british|uk|eu|german|dutch|irish|emirati|uae) (citizen|national)s?\b/i,
  /\b(canadian|british|uk|eu|eea|german|dutch|irish|emirati|uae) (citizens?|nationals?|citizenship)( (or|and) [^.]{0,30})?( only| required| is required)\b/i
];
export const SPONSORS = [
  /\b(we|will|can|able to|happy to|do|does)\b[^.]{0,30}\bsponsor\b[^.]{0,30}\b(visas|visa|work permits?|h-?1bs?|immigration|relocation)\b/i,
  /\b(visa|immigration|work permit|h-?1b|blue card|skilled worker)[- ]?(sponsorship|support)\b[^.]{0,30}\b(is |are )?(available|provided|offered|possible)\b/i,
  /\b(offer|offers|provide|provides|including|includes|with|plus)\b[^.]{0,30}\b(visa|immigration|work permit|blue card) (sponsorship|support|assistance)\b/i,
  /\b(sponsorship|visa support) for (international|non-eu|non-uk) (candidates|applicants|hires)\b/i,
  /\bglobal talent stream\b/i
];
// A relocation package is a good sign in Europe (the employer helps with the move and the
// permit), not proof: likely, never confirmed.
const RELOCATION = /\brelocation (package|support|assistance|bonus)\b/i;

// An offer only counts when nothing negates it just before ("We do not offer visa sponsorship").
const NEGATOR = /\b(not|no|never|unable|cannot|can't|won't|don't|doesn't|without|neither|nor)\b/i;
export function offerSentence(text: string): string | undefined {
  const t = String(text || "");
  for (const re of SPONSORS) {
    const m = re.exec(t);
    if (!m) continue;
    const before = t.slice(Math.max(0, t.lastIndexOf(".", m.index) + 1, m.index - 40), m.index);
    if (NEGATOR.test(before) || NEGATOR.test(m[0])) continue;
    return m[0];
  }
  return undefined;
}
export const sentences = (text: string, re: RegExp[]) => re.map(r => String(text || "").match(r)?.[0]).filter(Boolean) as string[];
const rank: Record<Confidence, number> = { no: 0, unknown: 1, likely: 2, confirmed: 3 };
export const better = (a: Confidence, b: Confidence): Confidence => rank[a] >= rank[b] ? a : b;
// Old stored values (before Phase 4): "strong" meant confirmed, "possible" meant unknown.
export function normalizeLevel(s: string | undefined): Confidence {
  return s === "strong" ? "confirmed" : s === "possible" || !s ? "unknown" : (s as Confidence);
}

export interface Sponsorship {
  confidence: Confidence;
  evidence: Evidence[];
  blocked?: string; // the posting's sentence that rules him out
  stale?: string; // a data source that was too old to count
}

// countries: ISO-ish codes from whereIs (US, UK, DE, NL, IE, CA, AE, …; "EU" when only "Europe").
export function sponsorshipFor(company: string, text: string, countries: string[], data: SponsorData): Sponsorship {
  const citizen = sentences(text, CITIZENS_ONLY)[0];
  if (citizen) return { confidence: "no", evidence: [], blocked: `Says: “${citizen.trim()}”` };
  const refuses = sentences(text, NO_SPONSOR)[0];
  const offers = offerSentence(text);
  const relocation = RELOCATION.test(text);
  const evidence: Evidence[] = [];
  const add = (country: string, confidence: Confidence, source: EvidenceSource, line: string, date?: string) => {
    if (!evidence.some(e => e.text === line)) evidence.push({ country, confidence, source, text: line, ...(date && { date }) });
  };
  const d = data.dates || {};
  const h1b = data.h1b(company), lca = data.lcaStale ? 0 : data.lca?.(company) || 0;
  let stale: string | undefined;
  if (data.lcaStale && data.lca?.(company)) stale = `DOL LCA data (${d.lca || "date unknown"}) is out of date; refresh it to count it`;

  for (const c of countries.length ? countries : ["EU"]) {
    if (c === "AE") { add(c, "confirmed", "uae", "UAE: the employer arranges the work visa"); continue; }
    if (refuses) continue; // a job that refuses sponsorship gets nothing anywhere but the UAE
    if (offers) add(c, "confirmed", "posting", `Posting: “${offers.trim()}”`);
    if (c === "US") {
      if (lca) add(c, "likely", "dol-lca", `${lca} certified LCA${lca > 1 ? "s" : ""} ${d.lca ? `FY${d.lca}` : "(DOL)"}`, d.lca);
      if (h1b) add(c, "likely", "uscis-h1b", `Sponsored ${h1b} H-1B visa${h1b > 1 ? "s" : ""} (USCIS ${d.h1b ? `FY${d.h1b}` : "data"})`, d.h1b);
    } else if (c === "UK") {
      if (data.ukSponsor(company)) add(c, "confirmed", "uk-register", "Licensed UK Skilled Worker sponsor (Home Office register)", d.uk);
    } else if (c === "NL") {
      if (data.nlSponsor?.(company)) add(c, "confirmed", "ind", "IND recognised sponsor (Netherlands)", d.ind);
      else if (relocation) add(c, "likely", "posting", "Posting offers relocation support");
    } else if (c === "CA") {
      const n = data.caLmia?.(company) || 0;
      if (n) add(c, "likely", "lmia", `${n} positive LMIA${n > 1 ? "s" : ""} (Canada, ${d.lmia || "ESDC"})`, d.lmia);
    } else if (relocation) add(c, "likely", "posting", "Posting offers relocation support");
  }
  const confidence = evidence.reduce<Confidence>((a, e) => better(a, e.confidence), "unknown");
  if (refuses && confidence === "unknown") return { confidence: "no", evidence, blocked: `Says: “${refuses.trim()}”` };
  return { confidence, evidence, ...(stale && { stale }) };
}

// One line for the dashboard: "likely: 42 certified LCAs FY2025".
export function evidenceLine(s: Pick<Sponsorship, "confidence" | "evidence">): string {
  const best = s.evidence.filter(e => e.confidence === s.confidence)[0] || s.evidence[0];
  return best ? `${s.confidence}: ${best.text}` : s.confidence;
}
