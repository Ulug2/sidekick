// Your profile: everything Sidekick knows about you. Stored only in this browser.

const DECLINE = "Decline to self-identify";

const DEFAULT_PROFILE = {
  // basics
  fullName: "", preferredName: "", pronouns: "", email: "", phone: "",
  address: "", city: "", state: "", zip: "", country: "",
  linkedin: "", github: "", portfolio: "", otherLinks: "",
  // background
  headline: "", summary: "", education: "", experience: "", projects: "",
  skills: "", languages: "", certifications: "",
  // work eligibility
  workAuthorized: "", needsSponsorship: "", citizenship: "", workAuthNotes: "",
  // job preferences
  desiredRoles: "", desiredLocations: "", workMode: "", salaryExpectation: "",
  startDate: "", willingToRelocate: "", howHeard: "",
  // voluntary self-identification (US EEO questions)
  eeoGender: DECLINE, eeoRace: DECLINE, eeoVeteran: DECLINE, eeoDisability: DECLINE,
  // writing
  standardAnswers: "", coverLetterStyle: "",
  // anything else
  aboutMe: "",
  // settings
  useInChat: true,
  // { name, type, size, dataUrl, text, updatedAt }
  resume: null
};

async function getProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  return { ...DEFAULT_PROFILE, ...(profile || {}) };
}

async function saveProfile(profile) {
  await chrome.storage.local.set({ profile: { ...DEFAULT_PROFILE, ...profile } });
}

function profileIsEmpty(p) {
  return !p.fullName && !p.email && !p.resume && !p.aboutMe && !p.experience;
}

const PROFILE_SECTIONS = [
  ["Basics", [
    ["Full name", "fullName"], ["Preferred name", "preferredName"], ["Pronouns", "pronouns"],
    ["Email", "email"], ["Phone", "phone"], ["Street address", "address"], ["City", "city"],
    ["State/region", "state"], ["ZIP/postal code", "zip"], ["Country", "country"]
  ]],
  ["Links", [["LinkedIn", "linkedin"], ["GitHub", "github"], ["Portfolio", "portfolio"], ["Other links", "otherLinks"]]],
  ["Background", [
    ["Headline", "headline"], ["Summary", "summary"], ["Education", "education"], ["Experience", "experience"],
    ["Projects", "projects"], ["Skills", "skills"], ["Languages", "languages"], ["Certifications", "certifications"]
  ]],
  ["Work eligibility", [
    ["Legally authorized to work in the US", "workAuthorized"], ["Needs visa sponsorship now or in the future", "needsSponsorship"],
    ["Citizenship", "citizenship"], ["Work authorization notes", "workAuthNotes"]
  ]],
  ["Job preferences", [
    ["Target roles", "desiredRoles"], ["Preferred locations", "desiredLocations"], ["Work mode", "workMode"],
    ["Salary expectation", "salaryExpectation"], ["Earliest start date", "startDate"],
    ["Willing to relocate", "willingToRelocate"], ["Default answer for 'How did you hear about us?'", "howHeard"]
  ]],
  ["Voluntary self-identification (use these exact answers)", [
    ["Gender", "eeoGender"], ["Race/ethnicity", "eeoRace"], ["Veteran status", "eeoVeteran"], ["Disability status", "eeoDisability"]
  ]],
  ["Saved answers to common questions", [["", "standardAnswers"]]],
  ["Cover letter and writing style", [["", "coverLetterStyle"]]],
  ["More about me", [["", "aboutMe"]]]
];

// Turns the profile into readable text for the model. Empty fields are left out.
function profileToPrompt(p, { includeResume = false } = {}) {
  const parts = [];
  for (const [section, fields] of PROFILE_SECTIONS) {
    const lines = fields
      .filter(([, key]) => String(p[key] || "").trim())
      .map(([label, key]) => (label ? `- ${label}: ${String(p[key]).trim()}` : String(p[key]).trim()));
    if (lines.length) parts.push(`### ${section}\n${lines.join("\n")}`);
  }
  if (p.resume) {
    parts.push(`### Resume file\n- "${p.resume.name}" is saved and can be uploaded with the upload_file tool.`);
    if (includeResume && p.resume.text) parts.push(`### Resume text\n"""\n${p.resume.text.slice(0, 12000)}\n"""`);
  }
  return parts.join("\n\n");
}

// ---------- applications log ----------

async function getApplications() {
  const { applications = [] } = await chrome.storage.local.get("applications");
  return applications;
}

async function logApplication(entry) {
  const list = await getApplications();
  list.unshift({ id: crypto.randomUUID(), date: new Date().toISOString(), status: "submitted", ...entry });
  await chrome.storage.local.set({ applications: list.slice(0, 1000) });
  return list[0];
}
