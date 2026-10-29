// Skills: procedures Sidekick learns while working with you (procedural memory), e.g.
// "MyOpenMath answers: round to 4 decimals, separate multiple answers with commas" or
// "Optimization word problems: write the cost function, minimize with bounds, report x and y".
// Facts about you live in memories; skills are *how to do* a kind of task the way you want it.
// - Learned at the end of a chat (with the memory review) from your corrections, a fixed
//   mistake, or a multi-step method that worked. Never from web pages or files.
// - The system prompt lists only names and when to use them; a skill's full text is added to a
//   message when it clearly matches, or loaded with the use_skill tool. So many skills cost
//   almost nothing.
// - You can read, edit, add and delete them on your profile page.

const SKILLS_MAX = 30;
const SKILL_BODY_MAX = 1500;

async function getSkills() {
  const { skills = [] } = await chrome.storage.local.get("skills");
  return skills;
}
async function saveSkills(list) {
  await chrome.storage.local.set({ skills: list.slice(0, SKILLS_MAX) });
}

const skillName = s => String(s || "").replace(/[^\p{L}\p{N} _.,:()/&+-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
const sameName = (a, b) => skillName(a).toLowerCase() === skillName(b).toLowerCase();

// Skill text must never carry secrets or instructions copied from outside content.
function skillTextProblem(text) {
  const t = String(text || "");
  if (!t.trim()) return "empty";
  if (redactSecrets(t).count) return "contains a password, card, ID number or key";
  if (/<\/?untrusted_content|<\/?context>|<\/?system>|ignore (all |any )?(previous|prior|above) instructions/i.test(t)) return "looks like injected instructions";
  return "";
}

async function addSkill({ name, when, body, source = "learned" }) {
  name = skillName(name);
  when = String(when || "").replace(/\s+/g, " ").trim().slice(0, 200);
  body = String(body || "").trim().slice(0, SKILL_BODY_MAX);
  const problem = skillTextProblem(`${name}\n${when}\n${body}`);
  if (!name || !body || problem) throw new Error(`Can't save that skill${problem ? `: it ${problem}` : ""}.`);
  const list = await getSkills();
  const now = Date.now();
  const existing = list.find(s => sameName(s.name, name));
  if (existing) {
    if (existing.body === body && (!when || existing.when === when)) return { skill: existing, updated: false, unchanged: true };
    Object.assign(existing, { when: when || existing.when, body, updated: now, version: (existing.version || 1) + 1 });
    await saveSkills([existing, ...list.filter(s => s !== existing)]);
    return { skill: existing, updated: true };
  }
  const skill = { id: "k_" + Math.random().toString(36).slice(2, 8), name, when, body, created: now, updated: now, uses: 0, version: 1, source };
  await saveSkills([skill, ...list]);
  return { skill, updated: false };
}

// A small edit instead of a rewrite, so a skill that works isn't lost (old text → new text).
async function patchSkill(name, oldText, newText) {
  const list = await getSkills();
  const s = list.find(x => sameName(x.name, name));
  if (!s) throw new Error(`No skill named "${name}".`);
  const old = String(oldText || ""), neu = String(newText || "");
  let body;
  if (old && s.body.includes(old)) body = s.body.replace(old, neu);
  else if (!old && neu) body = `${s.body}\n${neu}`;
  else throw new Error("The text to change isn't in that skill.");
  body = body.trim().slice(0, SKILL_BODY_MAX);
  const problem = skillTextProblem(body);
  if (problem) throw new Error(`Can't save that change: it ${problem}.`);
  Object.assign(s, { body, updated: Date.now(), version: (s.version || 1) + 1 });
  await saveSkills(list);
  return s;
}

async function updateSkill(id, fields) {
  const list = await getSkills();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  const next = { ...s, ...fields };
  next.name = skillName(next.name) || s.name;
  next.body = String(next.body || "").trim().slice(0, SKILL_BODY_MAX);
  const problem = skillTextProblem(`${next.name}\n${next.when}\n${next.body}`);
  if (problem) throw new Error(`Can't save that skill: it ${problem}.`);
  Object.assign(s, next, { updated: Date.now() });
  await saveSkills(list);
  return s;
}

async function deleteSkill(id) {
  await saveSkills((await getSkills()).filter(s => s.id !== id));
}

async function markSkillUsed(id) {
  const list = await getSkills();
  const s = list.find(x => x.id === id);
  if (s) { s.uses = (s.uses || 0) + 1; s.lastUsed = Date.now(); await saveSkills(list); }
}

// The skill that clearly fits this message, if any (keyword ranking on name + when + body).
async function skillFor(query, list, { minScore = 2.2 } = {}) {
  list ||= await getSkills();
  if (!list.length || !String(query || "").trim()) return null;
  const docs = list.map(s => ({ id: s.id, text: `${s.name} ${s.name} ${s.when} ${s.when} ${s.body}`, skill: s }));
  const [best] = bm25(docs, query, 1);
  return best && best.score >= minScore ? best.skill : null;
}

async function findSkill(name) {
  const list = await getSkills();
  return list.find(s => sameName(s.name, name)) || list.find(s => skillName(s.name).toLowerCase().includes(skillName(name).toLowerCase())) || null;
}

function skillsIndexText(list) {
  return list.slice(0, SKILLS_MAX).map(s => `- ${s.name}: ${s.when || "(no description)"}`).join("\n");
}

// Applies the skill changes a chat review asked for. ops: [{op: "create"|"patch", name, when, body, old, new}]
async function applySkillOps(ops) {
  const done = [];
  for (const o of (Array.isArray(ops) ? ops : []).slice(0, 2)) {
    try {
      if (o.op === "patch") { const s = await patchSkill(o.name, o.old, o.new); done.push({ op: "patched", name: s.name }); }
      else if (o.op === "create") { const r = await addSkill({ name: o.name, when: o.when, body: o.body }); done.push({ op: r.updated ? "updated" : "created", name: r.skill.name }); }
    } catch (err) {
      console.warn("Skipped a skill change:", err.message);
    }
  }
  return done;
}
