// Honesty rules in code (brief §6.4, docs/PLAN.md Phase 4): a form answer about work
// authorization, visa sponsorship or a voluntary self-identification question must match what
// Ulugbek saved in his profile. The agent's choice is checked right before it types, selects or
// ticks; a contradiction is refused in an approved batch and asked about otherwise. A topic with
// nothing saved is refused too (the agent must use ask_user, which goes to memory first).
// Pure: no storage, no model calls.
import type { Profile } from "../assistant/profile-core.js";

export type Topic = "sponsorship" | "authorization" | "eeo";
export interface HonestyVerdict { ok: boolean; topic?: Topic; reason?: string }

type Polarity = "yes" | "no" | "unknown";
// Only clear answers count; free text the agent writes from the facts ("F-1, OPT from June 2027")
// is unknown and passes.
export function polarity(v: string): Polarity {
  const s = String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  // The whole phrase first: options like "I am authorized to work in the US and do not require
  // sponsorship" are a "no" to "will you require sponsorship?", whatever they start with.
  if (/\b(do not|don't|does not|doesn't|will not|won't|would not|not|never|no longer)\b( currently| now| ever)? (require|need)s?\b[^.]{0,40}\bsponsor/.test(s) || /\bwithout (the need for |needing |requiring )?(any |employer |visa )?sponsorship\b/.test(s)) return "no";
  if (/\b(will|would|do|does|currently|now|in the future)? ?(require|need)s?\b[^.]{0,40}\bsponsor/.test(s) && !/^(no|n|false)\b/.test(s)) return "yes";
  if (/^(yes|y|true)\b/.test(s)) return "yes";
  if (/^(no|n|false)\b/.test(s) || /^i (do not|don't|will not|won't|would not|am not|have not|haven't)\b/.test(s) || /^(not required|do not require|does not require)/.test(s)) return "no";
  // "I am …" / "I have …" mean yes only with a word that answers the question ("I am on F-1 OPT"
  // is a description, not a yes).
  if (/^i (do|will|would|am|have)\b/.test(s) && /\b(authori[sz]ed|eligible|permitted|entitled|allowed|a (u\.?s\.? )?citizen|a protected veteran|a veteran|hispanic|latin[oax])\b/.test(s)) return "yes";
  return "unknown";
}
const flip = (p: Polarity): Polarity => p === "yes" ? "no" : p === "no" ? "yes" : p;

const SPONSOR_Q = /\bsponsor(ship|ed)?\b[^?]{0,80}\b(visa|immigration|employment|work|h-?1b|status|authori[sz]ation)\b|\b(visa|immigration|employment|work|h-?1b)\b[^?]{0,40}\bsponsor(ship)?\b|\b(need|require)s? (visa |employer |immigration |work )?sponsorship\b/i;
const SPONSOR_NEGATED = /\bwithout\b[^?]{0,60}\bsponsor|\b(not|never) (require|need)\b[^?]{0,40}\bsponsor/i;
const AUTH_Q = /\b(legally |lawfully )?(authori[sz]ed|eligible|permitted|entitled|allowed)\b[^?]{0,20}\bto work\b|\bright to work\b|\bwork authori[sz]ation\b|\bwork permit\b/i;
const COUNTRY: Record<string, RegExp> = {
  US: /\b(united states|u\.s\.a?\.?|usa|us|america)\b/i,
  UK: /\b(united kingdom|u\.k\.|uk|britain|england)\b/i,
  CA: /\bcanad(a|ian)\b/i,
  EU: /\b(european union|eu|eea|germany|netherlands|ireland|france|spain|italy|sweden|denmark|poland|portugal|switzerland|austria|belgium)\b/i,
  AE: /\b(united arab emirates|uae|dubai|abu dhabi)\b/i,
  KZ: /\bkazakh(stan)?\b/i
};
const EEO: [RegExp, keyof Profile | null][] = [
  [/\bhispanic\b|\blatin[oax]\b/i, "eeoRace"],
  [/\b(race|racial|ethnicity|ethnic)\b/i, "eeoRace"],
  [/\b(gender|sex)\b(?! offender)/i, "eeoGender"],
  [/\bveteran\b/i, "eeoVeteran"],
  [/\bdisabilit(y|ies)\b/i, "eeoDisability"],
  [/\b(sexual orientation|transgender|lgbtq)\b/i, null]
];
export const DECLINE = /\b(prefer not|decline|don'?t wish|do not wish|choose not|not to (answer|disclose|say|self[- ]identify|specify)|rather not|i don'?t want to answer)\b/i;
// Forms word the same choice differently (Ashby: "Man", Greenhouse: "Male").
const SYN: [RegExp, string][] = [[/\b(man|male)\b/g, "male"], [/\b(woman|female)\b/g, "female"], [/\bnon ?binary\b/g, "nonbinary"]];
const synonyms = (s: string) => SYN.reduce((t, [re, to]) => t.replace(re, to), s);
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// question: the field's label plus its question text; value: what the agent would enter.
// jobCountries: where the job is (an unqualified "authorized to work here?" means those).
export function checkAnswer(question: string, value: string, profile: Partial<Profile>, jobCountries: string[] = []): HonestyVerdict {
  const q = String(question || ""), v = String(value || "").trim();
  if (!v) return { ok: true };
  // A checkbox's question text ends with its own label: the label's wording is the answer, not
  // part of the question ("I do not require sponsorship" must not flip itself).
  const qOnly = q.endsWith(v) ? q.slice(0, q.length - v.length).trim() : q;
  if (SPONSOR_Q.test(q)) {
    const saved = polarity(String(profile.needsSponsorship || ""));
    const said = polarity(v);
    if (said === "unknown") return { ok: true, topic: "sponsorship" };
    if (saved === "unknown") return { ok: false, topic: "sponsorship", reason: "Sponsorship answers come only from his profile, and \"Will need visa sponsorship\" is empty there. Use ask_user." };
    const expected = SPONSOR_NEGATED.test(qOnly) ? flip(saved) : saved;
    return expected === said ? { ok: true, topic: "sponsorship" } : { ok: false, topic: "sponsorship", reason: `“${v}” contradicts his profile (needs visa sponsorship: ${profile.needsSponsorship}). The truthful answer to “${q.slice(0, 120)}” is ${expected === "yes" ? "Yes" : "No"}.` };
  }
  if (AUTH_Q.test(q)) {
    const said = polarity(v);
    if (said === "unknown") return { ok: true, topic: "authorization" };
    const named = Object.keys(COUNTRY).filter(c => COUNTRY[c].test(q));
    const where = named.length ? named : jobCountries.length ? jobCountries.map(c => c === "UK" || c === "US" || c === "CA" || c === "AE" ? c : "EU") : ["US"];
    const citizen = String(profile.citizenship || "");
    const expectFor = (c: string): Polarity => c === "US" ? polarity(String(profile.workAuthorized || "")) : COUNTRY[c]?.test(citizen) ? "yes" : "no";
    const expected = [...new Set(where.map(expectFor))];
    if (expected.includes("unknown")) return { ok: false, topic: "authorization", reason: "Work-authorization answers come only from his profile, and \"Legally authorized to work in the US\" is empty there. Use ask_user." };
    if (expected.length === 1 && expected[0] === said) return { ok: true, topic: "authorization" };
    if (expected.length > 1 && said === "no") return { ok: true, topic: "authorization" }; // several places, not all: "No" is the safe truth
    return { ok: false, topic: "authorization", reason: `“${v}” isn't what his profile says for ${where.join("/")} (authorized in the US: ${profile.workAuthorized || "not set"}; citizenship: ${citizen || "not set"}). Answer truthfully from the profile.` };
  }
  for (const [re, key] of EEO) {
    if (!re.test(q)) continue;
    if (DECLINE.test(v)) return { ok: true, topic: "eeo" };
    const saved = key ? String(profile[key] || "").trim() : "";
    if (!saved) return { ok: false, topic: "eeo", reason: "Voluntary self-identification: nothing saved in his profile, so choose the \"prefer not to answer\" / \"decline\" option." };
    if (DECLINE.test(saved)) return { ok: false, topic: "eeo", reason: "He chose not to answer self-identification questions: choose the \"prefer not to answer\" / \"decline\" option." };
    if (/hispanic|latin/i.test(q.match(re)?.[0] || "") && polarity(v) !== "unknown") {
      const want = /hispanic|latin/i.test(saved) ? "yes" : "no";
      return polarity(v) === want ? { ok: true, topic: "eeo" } : { ok: false, topic: "eeo", reason: `His saved answer is “${saved}”, so the answer here is ${want === "yes" ? "Yes" : "No"}.` };
    }
    // Yes/No questions ("Are you a protected veteran?" → "No") compare meanings.
    if (polarity(v) !== "unknown" && polarity(saved) !== "unknown" && /^(no|yes|n|y)$/i.test(v.trim())) {
      return polarity(v) === polarity(saved) ? { ok: true, topic: "eeo" } : { ok: false, topic: "eeo", reason: `His saved answer is “${saved}”; answer ${polarity(saved) === "yes" ? "Yes" : "No"} or "prefer not to answer".` };
    }
    const a = synonyms(norm(v)), b = synonyms(norm(saved));
    // Whole words only: "male" must not match "female".
    if (a && b && (a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `))) return { ok: true, topic: "eeo" };
    return { ok: false, topic: "eeo", reason: `His saved answer is “${saved}”; use the option that matches it, or "prefer not to answer".` };
  }
  return { ok: true };
}

// The question a snapshot element answers: its label plus the `question: "…"` the snapshot adds
// for radios, checkboxes and unlabeled fields.
export function questionFor(el: { label: string; line: string }): string {
  const q = el.line.match(/question: "([^"]*)"/)?.[1] || "";
  return `${q} ${el.label}`.trim();
}

// The profile field a question's answer belongs in (so an answer he gives on a Needs You card
// satisfies this check next time), or null.
export function honestyKeyFor(question: string): "needsSponsorship" | "workAuthorized" | "eeoGender" | "eeoRace" | "eeoVeteran" | "eeoDisability" | null {
  const q = String(question || "");
  if (SPONSOR_Q.test(q)) return SPONSOR_NEGATED.test(q) ? null : "needsSponsorship";
  if (AUTH_Q.test(q)) { const named = Object.keys(COUNTRY).filter(c => COUNTRY[c].test(q)); return named.length === 1 && named[0] === "US" ? "workAuthorized" : null; }
  for (const [re, key] of EEO) if (re.test(q)) return /hispanic|latin/i.test(q) ? null : key as "eeoGender" | "eeoRace" | "eeoVeteran" | "eeoDisability" | null;
  return null;
}
