import { extractDocText, isDocFile } from "../../core/docs/docs.js";
import { exportMemoryMarkdown, importMemoryMarkdown } from "../../assistant/memory/memory-io.js";
import { addDocument, addMemory, bm25, deleteDocument, deleteMemory, getDocIndex, getMemories, setMemories, updateMemory } from "../../assistant/memory/memory.js";
import { DECLINE, DEFAULT_PROFILE, PROFILE_SECTIONS, deleteApplication, getApplications, getProfile, saveProfile } from "../../assistant/profile-core.js";
import { getUserModel, setUserModel } from "../../assistant/session.js";
import { addSkill, deleteSkill, getSkills, updateSkill } from "../../assistant/skills.js";
import type { Profile } from "../../assistant/profile-core.js";
import { PERSONAL_LABELS, PROFILE_FIELD_NAMES } from "../../core/security/personal-data.js";
import { deleteAdapter, getAdapters } from "../../agent/skills/shortcuts.js";
import { deleteSiteNote, getSiteNotes } from "../../agent/skills/site-notes.js";
import { $ } from "../shared/dom.js";
import { callModel } from "../../core/llm/call.js";
import { getSettings } from "../../core/llm/settings.js";

export const params = new URLSearchParams(location.search);
export const isOnboarding = params.get("welcome") === "1";

// Indexed by field key while editing, so it's also a plain record.
export let profile: Profile & Record<string, any> = { ...DEFAULT_PROFILE };

export const FIELD_UI: Record<string, { type?: string; options?: string[]; placeholder?: string; autocomplete?: AutoFill; wide?: boolean; tall?: boolean }> = {
  fullName: { autocomplete: "name" }, preferredName: {}, pronouns: { placeholder: "e.g. he/him" },
  email: { type: "email", autocomplete: "email" }, phone: { type: "tel", autocomplete: "tel" },
  address: { wide: true, autocomplete: "street-address" }, city: {}, state: {}, zip: {}, country: {},
  linkedin: { type: "url", placeholder: "https://linkedin.com/in/..." }, github: { type: "url", placeholder: "https://github.com/..." },
  portfolio: { type: "url" }, otherLinks: { type: "textarea", wide: true, placeholder: "One per line" },
  headline: { wide: true, placeholder: "e.g. Computer Science student and full-stack developer" },
  summary: { type: "textarea", wide: true, placeholder: "2–4 sentences about you as a professional" },
  education: { type: "textarea", wide: true, placeholder: "One school per line, e.g.\nState University — B.S. Computer Science, GPA 3.5 (expected May 2027)" },
  experience: { type: "textarea", wide: true, tall: true, placeholder: "One role per line, with dates and results, e.g.\nAcme Corp — Software Engineering Intern (Jun–Aug 2025): built X, cut load time 30%" },
  projects: { type: "textarea", wide: true, placeholder: "Name — what it is, your role, tech used, results" },
  skills: { type: "textarea", wide: true, placeholder: "Languages, frameworks, tools" },
  languages: { placeholder: "e.g. English (fluent), Russian (native)" }, certifications: {},
  workAuthorized: { type: "select", options: ["", "Yes", "No"] },
  needsSponsorship: { type: "select", options: ["", "No", "Yes"] },
  citizenship: {},
  workAuthNotes: { type: "textarea", wide: true, placeholder: "Anything employers ask about, e.g. visa type, OPT/CPT eligibility, dates" },
  desiredRoles: { wide: true, placeholder: "e.g. Software Engineer Intern, Full-stack Developer" },
  desiredLocations: { wide: true, placeholder: "e.g. New York, remote (US)" },
  workMode: { type: "select", options: ["", "Remote", "Hybrid", "On-site", "Any"] },
  salaryExpectation: { placeholder: "e.g. $35/hr, or 'Open / negotiable'" },
  startDate: { placeholder: "e.g. June 2026, or 'Two weeks after offer'" },
  willingToRelocate: { type: "select", options: ["", "Yes", "No", "Depends on the role"] },
  howHeard: { placeholder: "e.g. LinkedIn" },
  eeoGender: { type: "select", options: [DECLINE, "Male", "Female", "Non-binary"] },
  eeoRace: { type: "select", options: [DECLINE, "American Indian or Alaska Native", "Asian", "Black or African American", "Hispanic or Latino", "Native Hawaiian or Other Pacific Islander", "White", "Two or more races"] },
  eeoVeteran: { type: "select", options: [DECLINE, "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"] },
  eeoDisability: { type: "select", options: [DECLINE, "No, I do not have a disability", "Yes, I have a disability (or previously had one)"] },
  standardAnswers: { type: "textarea", wide: true, tall: true, placeholder: "Answers to reuse, one question per paragraph, e.g.\n\nWhy are you interested in this field?\nI started building apps in high school because…\n\nGreatest strength?\n…\n\nYears of experience with Python: 3" },
  coverLetterStyle: { type: "textarea", wide: true, placeholder: "How your cover letters and answers should sound, e.g. 'Short and direct, no clichés, mention my side projects'" },
  aboutMe: { type: "textarea", wide: true, tall: true, placeholder: "Anything else Sidekick should know: where you're from, your story, interests, what you're looking for, how you like to write." }
};

export const SECTION_HINTS: Record<string, string> = {
  "Work eligibility": "Asked on most US applications. Answer exactly as you would on the form.",
  "Voluntary self-identification (use these exact answers)": "US employers ask these optionally. Sidekick uses exactly what you pick here; 'Decline' is always safe.",
  "Saved answers to common questions": "Sidekick reuses these instead of writing new ones, and adapts them to each company.",
  "More about me": "Free-form context. The more you write, the more Sidekick sounds like you."
};

export const slug = (s: any) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// ---------- render ----------

// Which field sections belong under "Applications" (what forms ask for) rather than "About you".
export const APPLICATION_SECTIONS = /^(Work eligibility|Job preferences|Voluntary self-identification|Saved answers|Cover letter)/;
export function renderFields() {
  $("#fieldSections").innerHTML = "";
  $("#appSections").innerHTML = "";
  for (const [title, fields] of PROFILE_SECTIONS) {
    const wrap = APPLICATION_SECTIONS.test(title) ? $("#appSections") : $("#fieldSections");
    const sec = document.createElement("section");
    sec.className = "card";
    sec.id = "sec-" + slug(title);
    sec.innerHTML = `<h2></h2>${SECTION_HINTS[title] ? `<p class="muted small hint"></p>` : ""}<div class="grid two"></div>`;
    sec.querySelector("h2")!.textContent = title;
    if (SECTION_HINTS[title]) sec.querySelector(".hint")!.textContent = SECTION_HINTS[title];
    const grid = sec.querySelector(".grid");
    for (const [label, key] of fields) {
      const ui = FIELD_UI[key] || {};
      const lab = document.createElement("label");
      if (ui.wide || ui.type === "textarea" || !label) lab.className = "wide";
      if (label) lab.append(label);
      let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (ui.type === "textarea") {
        el = document.createElement("textarea");
        if (ui.tall) el.className = "tall";
      } else if (ui.type === "select") {
        el = document.createElement("select");
        for (const o of ui.options!) {
          const opt = document.createElement("option");
          opt.value = o;
          opt.textContent = o || "Select…";
          el.appendChild(opt);
        }
      } else {
        el = document.createElement("input");
        el.type = ui.type || "text";
        if (ui.autocomplete) el.autocomplete = ui.autocomplete;
      }
      if (ui.placeholder) (el as HTMLInputElement).placeholder = ui.placeholder;
      if (!label) el.setAttribute("aria-label", title);
      el.id = "f-" + key;
      el.dataset.key = key;
      el.value = (profile as Record<string, any>)[key] ?? "";
      el.addEventListener("input", () => { (profile as Record<string, any>)[key] = el.value; scheduleSave(); });
      lab.appendChild(el);
      grid!.appendChild(lab);
    }
    wrap.appendChild(sec);
  }
}

// The section menu, in the page's four groups.
export function renderToc() {
  const field = (re: RegExp) => PROFILE_SECTIONS.filter(([t]) => re.test(t)).map(([t]) => [t.replace(/ \(.*\)$/, ""), "sec-" + slug(t)]);
  const groups: [string, string[][]][] = [
    ["About you", [...(!$("#sec-key").hidden ? [["AI model", "sec-key"]] : []), ["Resume", "sec-resume"], ...field(/^(?!Work eligibility|Job preferences|Voluntary|Saved answers|Cover letter)/)]],
    ["Applications", [...field(APPLICATION_SECTIONS), ["Site skills", "sec-sites"], ["Applications sent", "sec-apps"]]],
    ["Memory", [["Memories", "sec-memories"], ["Skills", "sec-skills"], ["Documents", "sec-docs"]]],
    ["Privacy", [["Privacy and use", "sec-privacy"]]]
  ];
  $("#toc").innerHTML = "";
  for (const [group, items] of groups) {
    const g = document.createElement("span");
    g.className = "toc-group";
    g.textContent = group;
    $("#toc").appendChild(g);
    for (const [label, id] of items) {
      const a = document.createElement("a");
      a.href = "#" + id;
      a.textContent = label;
      $("#toc").appendChild(a);
    }
  }
}

export function renderResume() {
  const r = profile.resume;
  $("#resumeDrop").hidden = !!r;
  $("#resumeInfo").hidden = !r;
  if (r) {
    $("#resumeName").textContent = r.name;
    const words = (r.text || "").split(/\s+/).filter(Boolean).length;
    $("#resumeMeta").textContent = `${Math.max(1, Math.round(r.size! / 1024))} KB · ${words} words read · updated ${new Date(r.updatedAt!).toLocaleDateString()}`;
  }
}

export async function renderSteps() {
  if (!isOnboarding) return;
  $("#onboardSteps").hidden = false;
  $("#heroTitle").textContent = "Welcome to Sidekick";
  const s = await getSettings();
  const done: Record<string, boolean> = {
    key: !!(s.anthropicKey || s.openaiKey),
    resume: !!profile.resume,
    review: !!(profile.fullName && profile.email)
  };
  document.querySelectorAll("#onboardSteps li").forEach(li => li.classList.toggle("done", !!done[(li as any).dataset.step]));
}

// Learned shortcuts and notes, grouped by site.
export async function renderSites() {
  const box = $("#sitesList");
  const [adapters, notes] = await Promise.all([getAdapters(), getSiteNotes()]);
  const sites = [...new Set([...adapters.map(a => a.site), ...Object.keys(notes)])].sort();
  box.innerHTML = "";
  if (!sites.length) {
    box.innerHTML = `<p class="empty-apps">Nothing yet. After the agent finishes a task on a site (for example a job application), its shortcut shows up here.</p>`;
    return;
  }
  const xBtn = (label: any) => {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
    return b;
  };
  for (const site of sites) {
    const group = document.createElement("div");
    group.className = "site-group";
    const h = document.createElement("h3");
    h.textContent = site;
    group.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "mem-list";
    for (const a of adapters.filter(x => x.site === site)) {
      const li = document.createElement("li");
      const auto = a.steps.filter(st => !st.needsModel && !st.final && !st.optional).length;
      const body = document.createElement("div");
      body.className = "site-item";
      body.innerHTML = `<div class="site-title"></div><div class="muted small site-meta"></div><details class="site-steps"><summary class="small">Steps</summary><ol></ol></details>`;
      body.querySelector(".site-title")!.textContent = `Shortcut: ${a.title}`;
      body.querySelector(".site-meta")!.textContent = `${a.steps.length} steps, ${auto} automatic · learned from ${a.runs || 1} run${(a.runs || 1) > 1 ? "s" : ""}${a.replays ? ` · worked in ${a.replayOk || 0} of ${a.replays} replay${a.replays > 1 ? "s" : ""}` : ""} · updated ${new Date(a.updated).toLocaleDateString()}`;
      for (const st of a.steps) {
        const item = document.createElement("li");
        const field = (k: any) => PERSONAL_LABELS[k] || PROFILE_FIELD_NAMES[k] || k;
        const how = st.final ? "you approve" : st.needsModel ? "the agent decides each time" : st.valueKey ? `from your profile (${field(st.valueKey)})` : st.labelKey ? `your profile's answer (${field(st.labelKey)})` : st.optional ? "only if it shows up" : "automatic";
        const verb = { click: "Click", type: "Type into", select_option: "Choose in", set_checked: st.role === "radio" ? "Choose" : st.value === false ? "Uncheck" : "Check", upload_file: "Attach your resume to", press_key: `Press ${st.value || "a key"} in` }[st.tool] || st.tool;
        item.textContent = `${verb} “${String(st.label || "").slice(0, 60)}”${st.question ? ` for “${String(st.question).slice(0, 70)}”` : ""} — ${how}`;
        body.querySelector("ol")!.appendChild(item);
      }
      const del = xBtn("Delete shortcut");
      del.onclick = async () => { await deleteAdapter(a.id); renderSites(); };
      li.append(body, del);
      ul.appendChild(li);
    }
    (notes[site] || []).forEach(n => {
      const li = document.createElement("li");
      const body = document.createElement("div");
      body.className = "site-item";
      body.innerHTML = `<div class="site-note"></div>`;
      body.firstChild!.textContent = `Note: ${n.text}`;
      const del = xBtn("Delete note");
      del.onclick = async () => {
        await deleteSiteNote(site, n.text);
        renderSites();
      };
      li.append(body, del);
      ul.appendChild(li);
    });
    group.appendChild(ul);
    box.appendChild(group);
  }
}

export async function renderApps() {
  const apps = await getApplications();
  const box = $("#appsTable");
  if (!apps.length) {
    box.innerHTML = `<p class="empty-apps">No applications yet. Open a job posting, turn on Agent in Sidekick, and choose "Apply to this job".</p>`;
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Date</th><th>Company</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody></tbody>`;
  for (const a of apps) {
    const tr = document.createElement("tr");
    const cells = [new Date(a.date).toLocaleDateString(), a.company || "—", a.role || "—"];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    if (a.url) {
      const link = document.createElement("a");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = tr.children[2].textContent;
      tr.children[2].textContent = "";
      tr.children[2].appendChild(link);
    }
    const st = document.createElement("td");
    st.innerHTML = `<span class="status"></span>`;
    st.firstChild!.textContent = a.status;
    if (a.notes) st.title = a.notes;
    tr.appendChild(st);
    const del = document.createElement("td");
    del.innerHTML = `<button class="icon-btn" type="button" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    (del.firstChild as any).onclick = async () => {
      await deleteApplication(a.id);
      renderApps();
    };
    tr.appendChild(del);
    table.tBodies[0].appendChild(tr);
  }
  box.innerHTML = "";
  box.appendChild(table);
}

// ---------- saving ----------

export let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleSave() {
  $("#saveState").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveProfile(profile);
    $("#saveState").textContent = "All changes saved";
    renderSteps();
  }, 400);
}

// ---------- resume ----------

export async function handleResume(file: any) {
  if (!file) return;
  const status = $("#fillStatus");
  status.classList.remove("err");
  if (!isDocFile(file) && !/^text\//.test(file.type) && !/\.(txt|md)$/i.test(file.name)) {
    status.classList.add("err");
    status.textContent = "Please upload a PDF, Word (.docx) or text file.";
    return;
  }
  if (file.size > 8_000_000) {
    status.classList.add("err");
    status.textContent = "That file is over 8 MB. Export a smaller PDF and try again.";
    return;
  }
  status.textContent = "Reading your resume…";
  try {
    const { text } = await extractDocText(file, { maxChars: 40_000 });
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    profile.resume = { name: file.name, type: file.type || "application/octet-stream", size: file.size, dataUrl, text, updatedAt: Date.now() };
    await saveProfile(profile);
    renderResume();
    renderSteps();
    await fillFromResume();
  } catch (err: any) {
    status.classList.add("err");
    status.textContent = err.message;
  }
}

export const RESUME_KEYS: Record<string, string> = {
  fullName: "full name", email: "email", phone: "phone", address: "street address", city: "city", state: "state or region",
  zip: "ZIP/postal code", country: "country", linkedin: "LinkedIn URL", github: "GitHub URL", portfolio: "portfolio/website URL",
  otherLinks: "other links, one per line", headline: "one-line professional headline",
  summary: "2-4 sentence professional summary in first person, based only on the resume",
  education: "one school per line: School — Degree, field, GPA if listed (dates)",
  experience: "one role per line: Company — Title (dates): key responsibilities and results",
  projects: "one project per line: Name — what it is, role, tech, results",
  skills: "comma-separated skills", languages: "spoken languages with level if listed", certifications: "certifications"
};

export async function fillFromResume() {
  const status = $("#fillStatus");
  status.classList.remove("err");
  if (!profile.resume?.text) return;
  const s = await getSettings();
  if (!s.anthropicKey && !s.openaiKey) {
    status.textContent = "Resume saved. Add an API key above, then click 'Fill profile from resume'.";
    return;
  }
  status.textContent = "Filling in your profile from the resume…";
  $("#resumeFill").disabled = true;
  try {
    const instructions =
      "Extract profile fields from the resume below. Reply with one JSON object and nothing else. " +
      "Use exactly these keys; each value is a string. Use an empty string when the resume doesn't say. " +
      "Copy facts exactly; never guess or invent anything.\n\nKeys:\n" +
      Object.entries(RESUME_KEYS).map(([k, d]) => `- ${k}: ${d}`).join("\n") +
      `\n\nResume:\n"""\n${profile.resume.text}\n"""`;
    // (useProfile has never been read by callModel; kept so the request stays exactly as before.)
    const reply = await callModel([{ role: "user", text: instructions }], () => {}, undefined, {
      system: "You extract structured data from documents. You output only valid JSON.",
      useProfile: false
    } as Parameters<typeof callModel>[3]);
    const json = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
    let filled = 0, kept = 0;
    for (const key of Object.keys(RESUME_KEYS)) {
      const val = typeof json[key] === "string" ? json[key].trim() : "";
      if (!val) continue;
      if (String(profile[key] || "").trim()) { kept++; continue; }
      profile[key] = val;
      const el = document.getElementById("f-" + key);
      if (el) {
        (el as any).value = val;
        el.classList.remove("filled");
        void el.offsetWidth;
        el.classList.add("filled");
      }
      filled++;
    }
    await saveProfile(profile);
    renderSteps();
    status.textContent = `Filled ${filled} field${filled === 1 ? "" : "s"} from your resume` +
      (kept ? `, kept ${kept} you'd already entered` : "") + ". Check them below and add the rest.";
  } catch (err: any) {
    status.classList.add("err");
    status.textContent = `Couldn't fill from the resume: ${err.message}`;
  } finally {
    $("#resumeFill").disabled = false;
  }
}

// ---------- memories ----------

export const X_ICON = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

export async function renderMemories() {
  const list = await getMemories();
  const q = $("#memSearch").value.trim();
  const shown = q ? bm25(list, q, 200) : list;
  $("#memCount").textContent = list.length ? `${list.length} saved` : "";
  const ul = $("#memList");
  ul.innerHTML = "";
  if (!shown.length) {
    ul.innerHTML = `<li class="mem-empty">${q ? "No matching memories." : "Nothing yet. Sidekick saves things here as you chat, or add your own above."}</li>`;
    return;
  }
  for (const m of shown) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="mem-main"><div class="mem-text" contenteditable="plaintext-only" spellcheck="false"></div><div class="mem-badges"></div></div><span class="mem-kind"></span><span class="mem-meta"></span><button class="icon-btn mem-done" type="button"></button><button class="icon-btn" type="button" aria-label="Delete memory">${X_ICON}</button>`;
    const t = li.querySelector(".mem-text");
    t!.textContent = m.text;
    if (m.status === "done") li.classList.add("done");
    const badges = li.querySelector(".mem-badges");
    const badge = (text: any, cls = "") => { const b = document.createElement("span"); b.className = "mem-badge " + cls; b.textContent = text; badges!.appendChild(b); return b; };
    if (m.due) badge(`due ${new Date(m.due + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`, "due");
    if (m.status === "done") badge("done");
    if (m.origin === "inferred") badge("inferred", "inferred").title = "Sidekick concluded this; you didn't say it directly. Edit or delete it if it's wrong.";
    if (m.url) { const a = document.createElement("a"); a.className = "mem-badge"; a.href = m.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "source"; badges!.appendChild(a); }
    const doneBtn = li.querySelector(".mem-done");
    doneBtn!.setAttribute("aria-label", m.status === "done" ? "Mark as not done" : "Mark as done");
    (doneBtn as any).title = doneBtn!.getAttribute("aria-label");
    doneBtn!.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
    (doneBtn as any).onclick = async () => { await updateMemory(m.id, null, null, { status: m.status === "done" ? "active" : "done" }); renderMemories(); };
    li.querySelector(".mem-kind")!.textContent = { preference: "how you like answers", pattern: "habit", goal: "goal" }[m.kind] || "fact";
    li.querySelector(".mem-meta")!.textContent = new Date(m.updated).toLocaleDateString();
    (t as any).onblur = async () => {
      const v = t!.textContent.trim();
      if (!v) { await deleteMemory(m.id); renderMemories(); }
      else if (v !== m.text) { await updateMemory(m.id, v); $("#saveState").textContent = "Memory updated"; }
    };
    (t as any).onkeydown = (e: any) => { if (e.key === "Enter") { e.preventDefault(); (t as any).blur(); } };
    (li.querySelector('button[aria-label="Delete memory"]') as any).onclick = async () => { await deleteMemory(m.id); renderMemories(); };
    ul.appendChild(li);
  }
}

// ---------- skills ----------

export async function renderSkills() {
  const list = await getSkills();
  $("#skillCount").textContent = list.length ? `${list.length} saved` : "";
  const ul = $("#skillList");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = `<li class="mem-empty">No skills yet. When you correct how Sidekick does something, it saves the better way here at the end of the chat.</li>`;
    return;
  }
  for (const s of list) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="skill-head"><input class="skill-name" type="text" aria-label="Skill name" /><span class="mem-meta"></span><button class="icon-btn" type="button" aria-label="Delete skill">${X_ICON}</button></div>
      <input class="skill-when" type="text" aria-label="When to use it" placeholder="When to use it" />
      <textarea class="skill-body" aria-label="Steps" spellcheck="false"></textarea>
      <div class="skill-foot"><button type="button" class="small skill-save" hidden>Save changes</button><span class="muted small skill-msg" role="status"></span></div>`;
    (li.querySelector(".skill-name") as any).value = s.name;
    (li.querySelector(".skill-when") as any).value = s.when || "";
    (li.querySelector(".skill-body") as any).value = s.body;
    li.querySelector(".mem-meta")!.textContent = `${s.source === "learned" ? "learned" : s.source === "import" ? "imported" : "yours"} · v${s.version || 1}${s.uses ? ` · used ${s.uses}×` : ""}`;
    const save = li.querySelector(".skill-save");
    li.querySelectorAll("input, textarea").forEach(el => ((el as any).oninput = () => { (save as any).hidden = false; }));
    (save as any).onclick = async () => {
      try {
        await updateSkill(s.id, { name: (li.querySelector(".skill-name") as any).value, when: (li.querySelector(".skill-when") as any).value, body: (li.querySelector(".skill-body") as any).value });
        (save as any).hidden = true;
        li.querySelector(".skill-msg")!.textContent = "Saved";
      } catch (err: any) {
        li.querySelector(".skill-msg")!.textContent = err.message;
      }
    };
    (li.querySelector('button[aria-label="Delete skill"]') as any).onclick = async () => { await deleteSkill(s.id); renderSkills(); };
    ul.appendChild(li);
  }
}

// ---------- documents ----------

export async function renderDocs() {
  const index = await getDocIndex();
  const ul = $("#docList");
  ul.innerHTML = "";
  for (const d of index) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="mem-text"></div><span class="mem-meta"></span><button class="icon-btn" type="button" aria-label="Remove document">${X_ICON}</button>`;
    li.querySelector(".mem-text")!.textContent = d.name;
    li.querySelector(".mem-meta")!.textContent = `${Math.round(d.chars / 1000)}k chars · ${new Date(d.added).toLocaleDateString()}`;
    li.querySelector("button")!.onclick = async () => { await deleteDocument(d.id); renderDocs(); };
    ul.appendChild(li);
  }
}

export async function addDocs(files: any) {
  const status = $("#docStatus");
  status.classList.remove("err");
  for (const f of files) {
    status.textContent = `Reading ${f.name}…`;
    try {
      if (f.size > 25_000_000) throw new Error(`${f.name} is over 25 MB.`);
      const { text } = await extractDocText(f, { maxChars: 2_000_000 });
      await addDocument(f.name, text);
      status.textContent = `Added ${f.name}.`;
    } catch (err: any) {
      status.classList.add("err");
      status.textContent = err.message;
    }
  }
  renderDocs();
}

// ---------- wiring ----------

export function wire() {
  const pick = () => $("#resumeInput").click();
  $("#resumeDrop").onclick = pick;
  $("#resumeDrop").onkeydown = (e: any) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  $("#resumeReplace").onclick = pick;
  $("#resumeInput").onchange = (e: any) => { handleResume(e.target.files[0]); e.target.value = ""; };
  $("#resumeFill").onclick = fillFromResume;
  $("#resumeRemove").onclick = async () => {
    profile.resume = null;
    await saveProfile(profile);
    renderResume();
    renderSteps();
    $("#fillStatus").textContent = "";
  };
  const drop = $("#resumeDrop");
  drop.ondragover = (e: any) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e: any) => { e.preventDefault(); drop.classList.remove("over"); handleResume(e.dataTransfer.files[0]); };

  $("#useInChat").onchange = (e: any) => { profile.useInChat = e.target.checked; scheduleSave(); };

  $("#memAdd").onclick = async () => {
    const v = $("#memNew").value.trim();
    if (!v) return;
    try {
      await addMemory(v, "user");
      $("#memNew").value = "";
    } catch (err: any) {
      $("#saveState").textContent = err.message;
    }
    renderMemories();
  };
  $("#memNew").onkeydown = (e: any) => { if (e.key === "Enter") $("#memAdd").click(); };
  $("#memSearch").oninput = renderMemories;
  $("#memClear").onclick = async () => {
    if (!confirm("Delete all memories and the 'How Sidekick sees you' summary? This can't be undone.")) return;
    await setMemories([]);
    await setUserModel("");
    $("#userModel").value = "";
    renderMemories();
  };
  let umTimer: ReturnType<typeof setTimeout> | undefined;
  $("#userModel").oninput = () => {
    clearTimeout(umTimer);
    $("#saveState").textContent = "Saving…";
    umTimer = setTimeout(async () => { await setUserModel($("#userModel").value); $("#saveState").textContent = "All changes saved"; }, 500);
  };

  const pickDocs = () => $("#docInput").click();
  $("#docDrop").onclick = pickDocs;
  $("#docDrop").onkeydown = (e: any) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickDocs(); } };
  $("#docInput").onchange = (e: any) => { addDocs([...e.target.files]); e.target.value = ""; };
  const dd = $("#docDrop");
  dd.ondragover = (e: any) => { e.preventDefault(); dd.classList.add("over"); };
  dd.ondragleave = () => dd.classList.remove("over");
  dd.ondrop = (e: any) => { e.preventDefault(); dd.classList.remove("over"); addDocs([...e.dataTransfer.files]); };

  $("#keySave").onclick = async () => {
    const key = $("#keyValue").value.trim();
    if (!key) return ($("#keyStatus").textContent = "Paste a key first.");
    const provider = $("#keyProvider").value;
    await chrome.storage.local.set({ provider, [provider === "openai" ? "openaiKey" : "anthropicKey"]: key });
    $("#keyStatus").textContent = "Saved.";
    $("#keyValue").value = "";
    renderSteps();
    if (profile.resume && !profile.fullName) fillFromResume();
  };

  $("#exportApps").onclick = async () => {
    const apps = await getApplications();
    const cols = ["date", "company", "role", "status", "url", "notes"];
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...apps.map(a => cols.map(c => esc((a as unknown as Record<string, unknown>)[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "sidekick-applications.csv" });
    a.click();
    URL.revokeObjectURL(url);
  };

  $("#skillAdd").onclick = async () => {
    try {
      await addSkill({ name: $("#skillNewName").value, when: $("#skillNewWhen").value, body: $("#skillNewBody").value, source: "you" });
      $("#skillNewName").value = $("#skillNewWhen").value = $("#skillNewBody").value = "";
      $("#skillState").textContent = "Added";
      renderSkills();
    } catch (err: any) {
      $("#skillState").textContent = err.message;
    }
  };

  $("#memExport").onclick = async () => {
    const md = await exportMemoryMarkdown();
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `sidekick-memory-${new Date().toLocaleDateString("en-CA")}.md` });
    a.click();
    URL.revokeObjectURL(url);
    $("#memIoState").textContent = "Exported.";
  };
  $("#memImport").onchange = async (e: any) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.size > 2_000_000) throw new Error("That file is over 2 MB.");
      const r = await importMemoryMarkdown(await f.text());
      const n = (k: any, one: any, many: any) => `${k} ${k === 1 ? one : many}`;
      $("#memIoState").textContent = `Imported ${n(r.memories, "memory", "memories")}, ${n(r.skills, "skill", "skills")}, ${n(r.notes, "site note", "site notes")}${r.about ? ", and how Sidekick sees you" : ""}.${r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.slice(0, 2).join("; ")}` : ""}`;
      renderMemories(); renderSkills(); renderSites();
      $("#userModel").value = (await getUserModel()).text;
    } catch (err: any) {
      $("#memIoState").textContent = err.message;
    }
    e.target.value = "";
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.applications) renderApps();
    if (area === "local" && (changes.adapters || changes.siteNotes)) renderSites();
    if (area === "local" && changes.skills && !document.activeElement?.closest?.(".skill-list, .skill-new")) renderSkills();
    if (area === "local" && changes.memories && !document.activeElement?.classList.contains("mem-text")) renderMemories();
  });
}

(async () => {
  profile = await getProfile();
  const s = await getSettings();
  $("#sec-key").hidden = !!(s.anthropicKey || s.openaiKey) && !isOnboarding;
  if (!$("#sec-key").hidden && (s.anthropicKey || s.openaiKey)) $("#keyStatus").textContent = "A key is already saved. Paste a new one to replace it.";
  $("#keyProvider").value = s.provider;
  $("#useInChat").checked = profile.useInChat !== false;
  renderFields();
  renderToc();
  renderResume();
  renderSteps();
  renderApps();
  renderSites();
  renderMemories();
  renderSkills();
  renderDocs();
  $("#userModel").value = (await getUserModel()).text;
  wire();
})();
