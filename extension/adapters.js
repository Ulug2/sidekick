// Learned site skills ("adapters"): after the agent finishes a task, the steps that worked are
// compiled into a shortcut for that site. Next time, use_shortcut replays the routine steps
// (navigation, profile fields, resume upload) in milliseconds without calling the model.
// Steps that need judgment (written answers, terms checkboxes, anything not from the profile)
// and final actions (submit, pay, send) are always handed back to the model and to you.
// Each site also keeps a few short notes learned from earlier runs ("the Location field is a
// custom dropdown: type the city, then pick the first option").
// Stored only in this browser (chrome.storage.local "adapters" and "siteNotes").

const ADAPTERS_MAX = 40;
const ADAPTER_STEPS_MAX = 60;
const SITE_NOTES_MAX = 8;

// "boards.greenhouse.io" and "job-boards.greenhouse.io" are the same site: greenhouse.io.
// Keeps three labels for country domains like "jobs.example.co.uk".
function siteOf(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = String(url || "").toLowerCase(); }
  host = host.replace(/^www\./, "").replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host; // IP addresses stay whole
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const sld = parts.at(-2);
  const keep = /^(co|com|ac|edu|gov|org|net)$/.test(sld) && parts.at(-1).length === 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

async function getAdapters() {
  const { adapters = [] } = await chrome.storage.local.get("adapters");
  return adapters;
}
async function saveAdapters(list) {
  await chrome.storage.local.set({ adapters: list.slice(0, ADAPTERS_MAX) });
}
async function deleteAdapter(id) {
  await saveAdapters((await getAdapters()).filter(a => a.id !== id));
}
async function adaptersFor(url) {
  const site = siteOf(url);
  return (await getAdapters()).filter(a => a.site === site);
}

async function getSiteNotes(site) {
  const { siteNotes = {} } = await chrome.storage.local.get("siteNotes");
  return site ? siteNotes[site] || [] : siteNotes;
}
async function saveSiteNotes(site, notes) {
  const { siteNotes = {} } = await chrome.storage.local.get("siteNotes");
  if (notes.length) siteNotes[site] = notes.slice(-SITE_NOTES_MAX);
  else delete siteNotes[site];
  await chrome.storage.local.set({ siteNotes });
}

// ---------- matching elements by meaning, not by id ----------

const normLabel = t => String(t || "").toLowerCase().replace(/[*:•✱]+/g, " ").replace(/\(required\)|\brequired\b/g, " ").replace(/\s+/g, " ").trim();

function roleFamily(role) {
  const r = String(role || "");
  if (/^(textbox|textarea|searchbox|spinbutton)/.test(r)) return "text";
  if (/^(select|combobox|listbox)$/.test(r)) return "choice";
  if (r === "checkbox" || r === "switch") return "check";
  if (r === "radio") return "radio";
  if (r === "file") return "file";
  return "click"; // button, link, clickable, tab, option, menuitem, summary…
}

function questionOfLine(line) {
  const m = String(line || "").match(/question: "([^"]*)"/);
  return m ? m[1] : "";
}

// Which element in the current snapshot is this step's target? Returns an id or null.
// elements: { id: { role, label, line, section } }
function findTarget(elements, step) {
  const want = normLabel(step.label);
  const fam = roleFamily(step.role);
  const q = normLabel(step.question);
  const scored = [];
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
const idOrder = id => { const [f, n] = String(id).includes(":") ? String(id).split(":").map(Number) : [0, Number(id)]; return f * 1e6 + n; };

// Position of an element among same-looking ones (same role family and label), for findTarget.
function nthOf(elements, id) {
  const e = elements[id];
  if (!e) return 0;
  const same = Object.keys(elements).filter(k => roleFamily(elements[k].role) === roleFamily(e.role) && normLabel(elements[k].label) === normLabel(e.label) && questionOfLine(elements[k].line) === questionOfLine(e.line)).sort((a, b) => idOrder(a) - idOrder(b));
  return Math.max(0, same.indexOf(id));
}

// ---------- profile values, for {{templates}} ----------

function profileValues(p = {}) {
  const parts = String(p.fullName || "").trim().split(/\s+/).filter(Boolean);
  const v = {
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
  return v;
}

// Which of your personal details (name, email, phone, address, links…) appear in this text?
// Used to stop data leaving through a URL or a site's tool without your OK.
function personalDetailsIn(text, profile) {
  const t = String(text || "").toLowerCase();
  let decoded = t;
  try { decoded = decodeURIComponent(t.replace(/\+/g, " ")); } catch {}
  const vals = profileValues(profile || {});
  return Object.entries(vals)
    .filter(([k, v]) => v && v.length >= 4 && !/^(yes|no|decline to self-identify|remote|hybrid|on-site)$/i.test(v) && !/^(eeo|workMode|willingToRelocate|workAuthorized|needsSponsorship)/.test(k))
    .filter(([, v]) => t.includes(v.toLowerCase()) || decoded.includes(v.toLowerCase()) || (v.includes("@") && decoded.includes(encodeURIComponent(v).toLowerCase())))
    .map(([k]) => PERSONAL_LABELS[k] || k);
}
const PROFILE_FIELD_NAMES = { workAuthorized: "work authorization", needsSponsorship: "sponsorship", willingToRelocate: "relocation", workMode: "work mode", eeoGender: "gender (self-ID)", eeoRace: "race/ethnicity (self-ID)", eeoVeteran: "veteran status", eeoDisability: "disability status" };
const PERSONAL_LABELS = { firstName: "first name", lastName: "last name", fullName: "full name", preferredName: "preferred name", email: "email", phone: "phone number", address: "street address", city: "city", state: "state", zip: "ZIP code", country: "country", location: "location", linkedin: "LinkedIn", github: "GitHub", portfolio: "portfolio link", citizenship: "citizenship", salaryExpectation: "salary expectation", startDate: "start date", howHeard: "referral source", pronouns: "pronouns" };

// Words in a question that tell profile fields with the same value apart ("Yes" for
// authorization vs. "Yes" for relocation).
const KEY_HINTS = {
  firstName: /first|given/, lastName: /last|family|surname/, fullName: /full name|^name$|your name/,
  email: /e-?mail/, phone: /phone|mobile/, city: /city|town/, state: /state|province|region/, zip: /zip|postal/,
  country: /country/, location: /location|where.*(live|based)/, linkedin: /linkedin/, github: /github/, portfolio: /portfolio|website/,
  workAuthorized: /authori[sz]|eligib|legally/, needsSponsorship: /sponsor|visa/, willingToRelocate: /relocat/,
  workMode: /remote|hybrid|on-?site|work mode/, salaryExpectation: /salary|compensation|pay/, startDate: /start|available|notice/,
  howHeard: /hear about|how did you|source|referr/, eeoGender: /gender|sex/, eeoRace: /race|ethnic|hispanic/,
  eeoVeteran: /veteran|military/, eeoDisability: /disab/
};

// Which profile field produced this value? Null if none, or if it's ambiguous.
function profileKeyFor(value, vals, context) {
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
const CONSENT = /\b(agree|terms|consent|certif|acknowledg|attest|privacy|policy|authori[sz]e .* to|i understand|declare)\b/i;
// Popups that may or may not be there next time.
const OPTIONAL_CLICK = /\b(cookie|accept all|accept cookies|got it|dismiss|no thanks|close|maybe later|not now|skip)\b/i;

// One successful action → a replayable step (or a step the model must do).
// entry: { tool, role, label, question, section, nth, value, final, description, host }
function compileStep(entry, vals) {
  // Click descriptions are kept for ordinary clicks only ("Open the application form"); a final
  // click's description summarizes your answers, so it isn't stored.
  const description = entry.tool === "click" && !entry.final ? redactSecrets(String(entry.description || "")).text.slice(0, 80) : "";
  const s = { tool: entry.tool, role: entry.role, label: entry.label, question: entry.question || "", section: entry.section || "", nth: entry.nth || 0, description };
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
function compileFlow(log, profile, goal) {
  if (!log?.length) return null;
  const bySite = {};
  for (const e of log) bySite[e.site] = (bySite[e.site] || 0) + 1;
  const site = Object.entries(bySite).sort((a, b) => b[1] - a[1])[0][0];
  const vals = profileValues(profile);
  const steps = [];
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

function titleFor(goal, site) {
  const g = String(goal || "").replace(/\s+/g, " ").trim();
  const short = g.length > 70 ? g.slice(0, 67).replace(/\s+\S*$/, "") + "…" : g;
  return short || `Routine on ${site}`;
}

// How alike two step lists are (share of targets in common), to update instead of duplicate.
function flowSimilarity(a, b) {
  const key = s => `${s.tool}|${roleFamily(s.role)}|${normLabel(s.label)}`;
  const A = new Set(a.map(key)), B = new Set(b.map(key));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

// Saves or updates the shortcut for a finished run. Returns the saved adapter (or null).
async function learnFlow(log, profile, goal) {
  const flow = compileFlow(log, profile, goal);
  if (!flow) return null;
  const list = await getAdapters();
  const same = list.find(a => a.site === flow.site && flowSimilarity(a.steps, flow.steps) >= 0.6);
  const now = Date.now();
  let saved;
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

// Learns 1–4 short, reusable notes about a site from a run that hit problems (errors, retries,
// your corrections). Uses the fast model; costs a fraction of a cent.
async function learnSiteNotes({ site, goal, steps, errors, answers, signal }) {
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
  let notes = [];
  try { notes = JSON.parse(r.text.match(/\{[\s\S]*\}/)[0]).notes || []; } catch { return []; }
  notes = notes.map(n => String(n).trim().slice(0, 240)).filter(n => n && !redactSecrets(n).count && !existing.some(e => normLabel(e.text) === normLabel(n))).slice(0, 3);
  if (notes.length) await saveSiteNotes(site, [...existing, ...notes.map(text => ({ text, added: Date.now() }))]);
  return notes;
}

// The short text the agent sees for a site: shortcuts it can run and notes from earlier runs.
function siteKnowledgeText(adapters, notes) {
  const out = [];
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
