// Your memory as one readable Markdown file: export it, read or edit it in any editor, import
// it back (or into Sidekick on another computer, or into the Mac app later).
import { getSiteNotes, saveSiteNotes } from "./adapters.js";
import { redactSecrets } from "./guard.js";
import { addMemory, getMemories } from "./memory.js";
import { getUserModel, setUserModel } from "./session.js";
import { addSkill, getSkills } from "./skills.js";

export const KIND_SECTIONS = [
  ["preference", "How you like answers"],
  ["pattern", "Habits"],
  ["fact", "Facts"],
  ["goal", "Goals"]
];

export function memoryTags(m) {
  const t = [];
  if (m.due) t.push(`{due: ${m.due}}`);
  if (m.status === "done") t.push("{done}");
  if (m.origin === "inferred") t.push("{inferred}");
  if (m.url) t.push(`{source: ${m.url}}`);
  return t.length ? " " + t.join(" ") : "";
}

export async function exportMemoryMarkdown() {
  const [memories, about, skills, notes] = await Promise.all([getMemories(), getUserModel(), getSkills(), getSiteNotes()]);
  const out = [
    "# Sidekick memory",
    "",
    `Exported ${new Date().toLocaleDateString("en-CA")}. Edit anything, then import this file on Sidekick's profile page.`,
    "Tags: {due: YYYY-MM-DD} for dates, {done} for finished items, {inferred} for things Sidekick concluded rather than you said.",
    "",
    "## How Sidekick sees you",
    "",
    about.text || "(nothing yet)",
    ""
  ];
  for (const [kind, title] of KIND_SECTIONS) {
    const list = memories.filter(m => (m.kind || "fact") === kind);
    out.push(`## ${title}`, "");
    out.push(...(list.length ? list.map(m => `- ${m.text.replace(/\n/g, " ")}${memoryTags(m)}`) : ["(none)"]), "");
  }
  out.push("## Skills", "");
  if (!skills.length) out.push("(none)", "");
  for (const s of skills) out.push(`### ${s.name}`, "", `When: ${s.when || ""}`, "", s.body.trim(), "");
  out.push("## Site notes", "");
  const sites = Object.keys(notes).sort();
  if (!sites.length) out.push("(none)", "");
  for (const site of sites) out.push(`### ${site}`, "", ...notes[site].map(n => `- ${n.text}`), "");
  return out.join("\n");
}

// Parses an exported file and merges it in. Existing items with nearly the same text are
// updated, not duplicated. Returns counts, and what was skipped (with why).
export async function importMemoryMarkdown(md) {
  const text = String(md || "").replace(/\r\n/g, "\n");
  if (!/^# Sidekick memory/m.test(text)) throw new Error("This doesn't look like a Sidekick memory file (it should start with \"# Sidekick memory\").");
  const sections = {};
  let current = null;
  for (const line of text.split("\n")) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { current = h[1].trim(); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const result = { memories: 0, skills: 0, notes: 0, about: false, skipped: [] };

  const about = (sections["How Sidekick sees you"] || []).join("\n").trim();
  if (about && about !== "(nothing yet)") {
    const cur = (await getUserModel()).text;
    if (about !== cur) { await setUserModel(about); result.about = true; }
  }

  for (const [kind, title] of KIND_SECTIONS) {
    for (const line of sections[title] || []) {
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (!m) continue;
      let body = m[1];
      const extra = {};
      body = body.replace(/\{due:\s*([0-9-]+)\}/i, (_, d) => { extra.due = d; return ""; })
        .replace(/\{done\}/i, () => { extra.status = "done"; return ""; })
        .replace(/\{inferred\}/i, () => { extra.origin = "inferred"; return ""; })
        .replace(/\{source:\s*([^}]+)\}/i, (_, u) => { extra.url = u.trim(); return ""; })
        .trim();
      if (!body || body === "(none)") continue;
      try {
        await addMemory(body, "import", kind, extra);
        result.memories++;
      } catch (err) {
        result.skipped.push(`"${body.slice(0, 50)}": ${err.message}`);
      }
    }
  }

  // Skills: "### Name", a "When:" line, then the steps.
  const skillLines = sections["Skills"] || [];
  let sk = null;
  const flush = async () => {
    if (!sk) return;
    const body = sk.lines.join("\n").trim();
    if (body && body !== "(none)") {
      try { const r = await addSkill({ name: sk.name, when: sk.when, body, source: "import" }); if (!r.unchanged) result.skills++; }
      catch (err) { result.skipped.push(`skill "${sk.name}": ${err.message}`); }
    }
    sk = null;
  };
  for (const line of skillLines) {
    const h = line.match(/^### (.+?)\s*$/);
    if (h) { await flush(); sk = { name: h[1], when: "", lines: [] }; continue; }
    if (!sk) continue;
    const w = line.match(/^When:\s*(.*)$/);
    if (w && !sk.when && !sk.lines.join("").trim()) sk.when = w[1].trim();
    else sk.lines.push(line);
  }
  await flush();

  // Site notes: "### site", then "- note" lines.
  let site = null;
  const add = {};
  for (const line of sections["Site notes"] || []) {
    const h = line.match(/^### (.+?)\s*$/);
    if (h) { site = h[1].trim().toLowerCase(); continue; }
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (site && m && m[1].trim() !== "(none)") (add[site] ||= []).push(m[1].trim().slice(0, 240));
  }
  for (const [s, list] of Object.entries(add)) {
    const existing = await getSiteNotes(s);
    const fresh = list.filter(n => !redactSecrets(n).count && !existing.some(e => e.text.toLowerCase() === n.toLowerCase()));
    if (fresh.length) {
      await saveSiteNotes(s, [...existing, ...fresh.map(t => ({ text: t, added: Date.now() }))]);
      result.notes += fresh.length;
    }
  }
  return result;
}
