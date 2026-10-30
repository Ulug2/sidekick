// Your personal details (from the profile) and where they appear: used to stop data leaving
// through a URL, a search or a site's tool without your OK.
import type { Profile } from "../../assistant/profile-core.js";

// ---------- profile values, for {{templates}} ----------

export function profileValues(p: Partial<Profile> = {}): Record<string, string> {
  const parts = String(p.fullName || "").trim().split(/\s+/).filter(Boolean);
  const v: Record<string, unknown> = {
    firstName: parts[0] || "", lastName: parts.length > 1 ? parts.at(-1) : "", fullName: p.fullName,
    preferredName: p.preferredName, pronouns: p.pronouns, email: p.email, phone: p.phone,
    address: p.address, city: p.city, state: p.state, zip: p.zip, country: p.country,
    location: [p.city, p.state].filter(Boolean).join(", "),
    linkedin: p.linkedin, github: p.github, portfolio: p.portfolio,
    workAuthorized: p.workAuthorized, needsSponsorship: p.needsSponsorship, citizenship: p.citizenship,
    workMode: p.workMode, salaryExpectation: p.salaryExpectation, startDate: p.startDate,
    willingToRelocate: p.willingToRelocate, howHeard: p.howHeard,
    eeoGender: p.eeoGender, eeoRace: p.eeoRace, eeoVeteran: p.eeoVeteran, eeoDisability: p.eeoDisability
  };
  for (const k of Object.keys(v)) v[k] = String(v[k] || "").trim();
  return v as Record<string, string>;
}

// Which of your personal details (name, email, phone, address, links…) appear in this text?
// Used to stop data leaving through a URL or a site's tool without your OK.
export function personalDetailsIn(text: unknown, profile: Partial<Profile> | null | undefined): string[] {
  const t = String(text || "").toLowerCase();
  let decoded = t;
  try { decoded = decodeURIComponent(t.replace(/\+/g, " ")); } catch {}
  const vals = profileValues(profile || {});
  return Object.entries(vals)
    .filter(([k, v]) => v && v.length >= 4 && !/^(yes|no|decline to self-identify|remote|hybrid|on-site)$/i.test(v) && !/^(eeo|workMode|willingToRelocate|workAuthorized|needsSponsorship)/.test(k))
    .filter(([, v]) => t.includes(v.toLowerCase()) || decoded.includes(v.toLowerCase()) || (v.includes("@") && decoded.includes(encodeURIComponent(v).toLowerCase())))
    .map(([k]) => PERSONAL_LABELS[k] || k);
}
export const PROFILE_FIELD_NAMES: Record<string, string> = { workAuthorized: "work authorization", needsSponsorship: "sponsorship", willingToRelocate: "relocation", workMode: "work mode", eeoGender: "gender (self-ID)", eeoRace: "race/ethnicity (self-ID)", eeoVeteran: "veteran status", eeoDisability: "disability status" };
export const PERSONAL_LABELS: Record<string, string> = { firstName: "first name", lastName: "last name", fullName: "full name", preferredName: "preferred name", email: "email", phone: "phone number", address: "street address", city: "city", state: "state", zip: "ZIP code", country: "country", location: "location", linkedin: "LinkedIn", github: "GitHub", portfolio: "portfolio link", citizenship: "citizenship", salaryExpectation: "salary expectation", startDate: "start date", howHeard: "referral source", pronouns: "pronouns" };
