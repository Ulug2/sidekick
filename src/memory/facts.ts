// The fact store: the canonical answers about Ulugbek that forms ask for, each with when it was set
// and where it came from (docs/ARCHITECTURE.md §3.3). Profile fields are facts too (read through,
// never copied); facts the profile has no field for (high school, graduation month, visa status…)
// live in "facts". Workers get the whole store in their context, so a known fact is never asked.
import { getProfile, type Profile } from "../assistant/profile-core.js";
import { readLocal } from "../core/storage/schema.js";
import { updateLocal } from "../core/storage/update.js";
import { redactSecrets } from "../core/security/guard.js";

export type FactSource = "profile" | "resume" | "chat" | "application" | "you";
export interface Fact { key: string; label: string; value: string; updatedAt: number; source: FactSource }
export interface StoredFact { value: string; updatedAt: number; source: FactSource }

// Facts the profile has no field for, with the label forms tend to use.
export const EXTRA_FACTS: Record<string, string> = {
  university: "University / college",
  degree: "Degree",
  major: "Major",
  gpa: "GPA",
  graduationDate: "College graduation date (month and year)",
  highSchool: "High school (secondary school) name",
  highSchoolCity: "High school city and country",
  highSchoolYear: "High school graduation year",
  visaStatus: "Current US visa / immigration status",
  dateOfBirth: "Date of birth",
  nationality: "Nationality",
  languagesSpoken: "Languages spoken (and level)",
  noticePeriod: "Earliest start / notice period",
  pronounsShort: "Pronouns",
  referral: "Referred by (if anyone)"
};
// Profile fields that are facts (label as forms ask).
const PROFILE_FACTS: [keyof Profile, string][] = [
  ["fullName", "Full name"], ["preferredName", "Preferred name"], ["email", "Email"], ["phone", "Phone"], ["address", "Street address"], ["city", "City"],
  ["state", "State"], ["zip", "ZIP / postal code"], ["country", "Country of residence"], ["linkedin", "LinkedIn"], ["github", "GitHub"], ["portfolio", "Portfolio / website"],
  ["workAuthorized", "Legally authorized to work in the US"], ["needsSponsorship", "Will need visa sponsorship now or in the future"], ["citizenship", "Citizenship"],
  ["workAuthNotes", "Work authorization notes"], ["desiredLocations", "Preferred locations"], ["workMode", "Work mode"], ["salaryExpectation", "Salary expectation"],
  ["startDate", "Earliest start date"], ["willingToRelocate", "Willing to relocate"], ["howHeard", "How did you hear about us (default)"],
  ["eeoGender", "Gender (voluntary)"], ["eeoRace", "Race / ethnicity (voluntary)"], ["eeoVeteran", "Veteran status (voluntary)"], ["eeoDisability", "Disability status (voluntary)"]
];
export const FACT_KEYS = [...PROFILE_FACTS.map(([k]) => String(k)), ...Object.keys(EXTRA_FACTS)];
export const labelOf = (key: string) => (Object.hasOwn(EXTRA_FACTS, key) ? EXTRA_FACTS[key] : "") || PROFILE_FACTS.find(([k]) => k === key)?.[1] || key;

export async function getFacts(): Promise<Fact[]> {
  const [profile, { facts = {} }] = await Promise.all([getProfile(), readLocal("facts")]);
  const out: Fact[] = [];
  for (const [k, label] of PROFILE_FACTS) {
    const v = String(profile[k] ?? "").trim();
    if (v) out.push({ key: String(k), label, value: v, updatedAt: (profile as any).updatedAt || 0, source: "profile" });
  }
  for (const [k, f] of Object.entries(facts)) if (f?.value) out.push({ key: k, label: labelOf(k), value: f.value, updatedAt: f.updatedAt, source: f.source });
  return out;
}

// Sets a fact. Profile keys are written to the profile (the profile page stays the editor for those).
export async function setFact(key: string, value: string, source: FactSource): Promise<void> {
  const v = String(value || "").trim().slice(0, 500);
  if (redactSecrets(v).count || /\d{12,}/.test(v.replace(/(?<=\d)[\s-](?=\d)/g, ""))) throw new Error("That looks like a card, ID or account number. Sidekick never stores those.");
  if (PROFILE_FACTS.some(([k]) => k === key)) {
    await updateLocal("profile", (p = {} as Profile) => ({ ...p, [key]: v }));
    return;
  }
  if (!Object.hasOwn(EXTRA_FACTS, key)) throw new Error(`Unknown fact "${key}".`);
  await updateLocal("facts", (f = {}) => {
    const next = { ...f };
    if (v) next[key] = { value: v, updatedAt: Date.now(), source }; else delete next[key];
    return next;
  });
}

// For prompts: one line per known fact.
export const factsText = (facts: Fact[]) => facts.map(f => `- ${f.label}: ${f.value}`).join("\n");
