// Personal knowledge: long-term memories, your document library, and past chats.
// Retrieval is local (BM25 keyword ranking), so it works with any provider and costs nothing.
import { redactSecrets } from "./guard.js";

// ---------- text search ----------

export const STOP = new Set("a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its just me my of on or our she so than that the their them then there these they this to too up us was we were what when where which who why will with would you your yours i'm i've it's don't".split(" "));

export function tokenize(text) {
  return (String(text).toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) || [])
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(t => t.length > 4 ? t.replace(/(ies|es|s|ing|ed|ly)$/, "") : t);
}

// docs: [{ id, text, ...anything }] → ranked [{ ...doc, score }]
export function bm25(docs, query, limit = 10) {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map(d => tokenize(d.text));
  const avg = toks.reduce((a, t) => a + t.length, 0) / toks.length || 1;
  const df = {};
  for (const t of toks) for (const w of new Set(t)) df[w] = (df[w] || 0) + 1;
  const N = docs.length, k1 = 1.2, b = 0.75;
  return docs
    .map((d, i) => {
      const tf = {};
      for (const w of toks[i]) tf[w] = (tf[w] || 0) + 1;
      let score = 0;
      for (const w of q) {
        if (!tf[w]) continue;
        const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
        score += idf * (tf[w] * (k1 + 1)) / (tf[w] + k1 * (1 - b + b * toks[i].length / avg));
      }
      return { ...d, score };
    })
    .filter(d => d.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

// ---------- memories ----------

export const MAX_MEMORIES = 500;

export async function getMemories() {
  const { memories = [] } = await chrome.storage.local.get("memories");
  return memories;
}

export async function setMemories(list) {
  await chrome.storage.local.set({ memories: list.slice(0, MAX_MEMORIES) });
}

export function similarity(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

// Kinds: "preference" (how they want answers), "pattern" (how they work, what they ask),
// "fact" and "goal". Preferences and patterns always apply; facts are pulled in when relevant.
// Optional fields on every memory:
//   due: "YYYY-MM-DD" for deadlines, exams, appointments (shown when coming up)
//   status: "active" (default) | "done" (finished; kept but no longer brought up)
//   origin: "stated" (they said it) | "inferred" (Sidekick concluded it)
//   url: the page it came from
export const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function memoryFields(extra = {}) {
  const f = {};
  if (extra.due && DUE_RE.test(String(extra.due).trim()) && !Number.isNaN(Date.parse(extra.due))) f.due = String(extra.due).trim();
  if (extra.status === "done" || extra.status === "active") f.status = extra.status;
  if (extra.origin === "stated" || extra.origin === "inferred") f.origin = extra.origin;
  if (extra.url && /^https?:\/\//i.test(extra.url)) f.url = String(extra.url).slice(0, 300);
  return f;
}

// Adds a memory, or updates a near-duplicate. Returns { memory, updated }.
export async function addMemory(text, source = "chat", kind = "fact", extra = {}) {
  text = String(text || "").trim().replace(/\s+/g, " ").slice(0, 500);
  if (!text) throw new Error("Nothing to remember.");
  const { count } = redactSecrets(text);
  if (count) throw new Error("That contains a password, card number, ID number or key. Sidekick doesn't store those.");
  const list = await getMemories();
  const now = Date.now();
  const fields = memoryFields(extra);
  const dup = list.find(m => similarity(m.text, text) >= 0.8);
  if (dup) {
    dup.text = text;
    dup.updated = now;
    if (kind && kind !== "fact") dup.kind = kind;
    Object.assign(dup, fields);
    await setMemories([dup, ...list.filter(m => m !== dup)]);
    return { memory: dup, updated: true };
  }
  const memory = { id: crypto.randomUUID(), text, created: now, updated: now, source, kind, status: "active", origin: kind === "pattern" ? "inferred" : "stated", ...fields };
  await setMemories([memory, ...list]);
  return { memory, updated: false };
}

export async function updateMemory(id, text, kind, extra = {}) {
  const list = await getMemories();
  const m = list.find(x => x.id === id);
  if (!m) return null;
  if (text != null) m.text = String(text).trim().slice(0, 500);
  if (kind) m.kind = kind;
  Object.assign(m, memoryFields(extra));
  if (extra.due === "") delete m.due;
  m.updated = Date.now();
  await setMemories(list);
  return m;
}

export async function deleteMemory(id) {
  const list = await getMemories();
  const gone = list.find(m => m.id === id);
  await setMemories(list.filter(m => m.id !== id));
  return gone || null;
}

// How they like to work: always part of the system prompt.
export async function standingMemories(limit = 25) {
  return (await getMemories()).filter(m => m.kind === "preference" || m.kind === "pattern").slice(0, limit);
}

export const todayISO = () => new Date().toLocaleDateString("en-CA");
export const daysUntil = due => Math.round((Date.parse(due + "T12:00:00") - Date.parse(todayISO() + "T12:00:00")) / 864e5);

// How a memory looks to the model: "[ab12cd34] Calculus exam in Glatfelter 101 (due Wed, Nov 12 — in 5 days)".
export function memoryLine(m) {
  const bits = [];
  if (m.due) {
    const d = daysUntil(m.due);
    const when = new Date(m.due + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    bits.push(`due ${when}${d === 0 ? " — today" : d === 1 ? " — tomorrow" : d > 1 ? ` — in ${d} days` : ` — ${-d} days ago`}`);
  }
  if (m.status === "done") bits.push("done");
  if (m.origin === "inferred") bits.push("inferred, not stated");
  return `- [${m.id.slice(0, 8)}] ${m.text}${bits.length ? ` (${bits.join("; ")})` : ""}`;
}

// Deadlines in the next two weeks (not done), soonest first. Always shown in the context.
export async function upcomingMemories(days = 14) {
  return (await getMemories())
    .filter(m => m.due && m.status !== "done" && daysUntil(m.due) >= 0 && daysUntil(m.due) <= days)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 8);
}

// Facts for the current message: the most relevant ones plus the newest few. Finished items
// and old deadlines stay out unless they're clearly relevant.
export async function memoriesFor(query, { relevant = 8, recent = 4 } = {}) {
  const list = (await getMemories()).filter(m => m.kind !== "preference" && m.kind !== "pattern");
  if (!list.length) return [];
  const stale = m => m.status === "done" || (m.due && daysUntil(m.due) < -7);
  // Finished items and old deadlines come back only when they match the message.
  const picked = bm25(list, query, relevant);
  for (const m of list.filter(x => !stale(x)).slice(0, recent)) if (!picked.some(p => p.id === m.id)) picked.push(m);
  return picked;
}

// ---------- document library ----------

export const CHUNK = 1400;
export const OVERLAP = 200;

export function chunkText(text) {
  const paras = String(text).split(/\n{2,}/);
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > CHUNK && cur) {
      chunks.push(cur.trim());
      cur = cur.slice(-OVERLAP) + "\n\n" + p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
    while (cur.length > CHUNK * 1.5) {
      chunks.push(cur.slice(0, CHUNK).trim());
      cur = cur.slice(CHUNK - OVERLAP);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

export async function getDocIndex() {
  const { docIndex = [] } = await chrome.storage.local.get("docIndex");
  return docIndex;
}

export async function addDocument(name, text) {
  const { text: clean } = redactSecrets(text);
  const chunks = chunkText(clean);
  if (!chunks.length) throw new Error(`${name} has no readable text.`);
  const id = crypto.randomUUID();
  const entry = { id, name, added: Date.now(), chars: clean.length, chunks: chunks.length };
  const index = await getDocIndex();
  await chrome.storage.local.set({ ["doc:" + id]: { chunks }, docIndex: [entry, ...index] });
  return entry;
}

export async function deleteDocument(id) {
  const index = (await getDocIndex()).filter(d => d.id !== id);
  await chrome.storage.local.set({ docIndex: index });
  await chrome.storage.local.remove("doc:" + id);
}

// ---------- unified search ----------

// scopes: any of "memories", "documents", "chats". Returns [{ kind, title, text, id, score }].
export async function searchPersonal(query, { scopes = ["memories", "documents", "chats"], limit = 8, excludeChatId } = {}) {
  const pool = [];
  if (scopes.includes("memories")) {
    for (const m of await getMemories()) pool.push({ kind: "memory", id: m.id, title: "Memory", text: m.text });
  }
  if (scopes.includes("documents")) {
    const index = await getDocIndex();
    if (index.length) {
      const stored = await chrome.storage.local.get(index.map(d => "doc:" + d.id));
      for (const d of index) {
        (stored["doc:" + d.id]?.chunks || []).forEach((c, i) => pool.push({ kind: "document", id: `${d.id}#${i}`, title: d.name, text: c }));
      }
    }
  }
  if (scopes.includes("chats")) {
    const { chatIndex = [] } = await chrome.storage.local.get("chatIndex");
    const recent = chatIndex.filter(c => c.id !== excludeChatId).slice(0, 60);
    if (recent.length) {
      const stored = await chrome.storage.local.get(recent.map(c => "chat:" + c.id));
      for (const c of recent) {
        const msgs = stored["chat:" + c.id]?.messages || [];
        for (let i = 0; i < msgs.length; i += 2) {
          const q = msgs[i]?.display?.prompt || msgs[i]?.text || "";
          const a = msgs[i + 1]?.text || "";
          if (q || a) pool.push({ kind: "chat", id: `${c.id}#${i}`, title: `Chat "${c.title}" (${new Date(c.updatedAt).toLocaleDateString()})`, text: `You asked: ${q.slice(0, 600)}\nAnswer: ${a.slice(0, 1200)}` });
        }
      }
    }
  }
  return bm25(pool, query, limit);
}
