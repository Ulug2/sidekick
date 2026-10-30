// The chat's tools: definitions the model sees, and what each one does.
import type { Provider, ToolDef, ToolCall } from "../core/llm/ai.js";
import type { ChatToolEnv, ChatToolResult, ChatMemoryStore } from "./types.js";
import { calcEngine } from "../core/calc/calc.js";
import { webSearchFallback, fetchUrlText } from "../core/web/web.js";
import { untrusted } from "../core/security/guard.js";
import { personalDetailsIn } from "../core/security/personal-data.js";
import { getProfile } from "./profile-core.js";
import { readPageText, captureScreen } from "../core/browser/screen.js";
import { getSkills, markSkillUsed } from "./skills.js";
import { addMemory, getMemories, deleteMemory, searchPersonal, memoriesFor, standingMemories, upcomingMemories } from "./memory/memory.js";
import { getUserModel } from "./session.js";

// ---------- tools ----------

export function chatTools({ provider, webSearchServer, hasTab, hasAgent }: { provider?: Provider; webSearchServer?: boolean; hasTab?: boolean; hasAgent?: boolean }): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: "calculate",
      description: "Exact math engine (math.js + computer algebra). Use for any non-trivial arithmetic, percentages, money, unit conversion, statistics, algebra and calculus. One statement per line; variables and functions persist across lines. Symbolic helpers take plain math without quotes: diff(expr, x[, n]), integrate(expr, x), defint(expr, x, a, b), limit(expr, x, value) (inf for infinity), solve(expr_or_equation, x), solveSystem([eq1, eq2]), factor, expand, sum(expr, k, a, b). Numeric methods work on anything (square roots, trig, logs): minimize(f, [x, y][, [x0, y0]][, [[xlo, xhi], [ylo, yhi]]]), maximize(...), nsolve(equation, x[, guess][, [lo, hi]]), nsolveSystem([eq1, eq2], [x, y][, [x0, y0]]). solve and solveSystem fall back to numeric automatically. scanCurve(f, g = c, x, y): walks along a 2-variable constraint curve (near and very far) and reports the largest/smallest f and whether each is reached or only approached (DNE). Always write multiplication explicitly (2*x, x*(20 - 2*x)). Returns each line's result.",
      parameters: { type: "object", properties: { lines: { type: "array", items: { type: "string" }, description: "Statements, e.g. [\"f(x) = x^3 sin(x)\", \"diff(f(x), x)\", \"defint(f(x), x, 0, pi)\"]" } }, required: ["lines"] }
    },
    {
      name: "read_url",
      description: "Read a web page or PDF by URL and return its text.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    },
    {
      name: "remember",
      description: "Save one lasting fact about the user to long-term memory, written in third person. Give a due date for deadlines, exams and appointments.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string" },
          due: { type: "string", description: "YYYY-MM-DD, for anything with a date (deadline, exam, appointment)." },
          stated: { type: "boolean", description: "true if the user said this directly; false if you inferred it." }
        },
        required: ["fact"]
      }
    },
    {
      name: "recall",
      description: "Search the user's memories, uploaded documents (notes, syllabi, resumes…) and past chats.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, scope: { type: "string", enum: ["all", "memories", "documents", "chats"] } },
        required: ["query"]
      }
    },
    {
      name: "use_skill",
      description: "Load the full text of one of your saved skills (procedures learned with the user, listed in the system prompt) by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    },
    {
      name: "forget",
      description: "Delete a memory by its id (the 8-character id shown in brackets in the context or recall results).",
      parameters: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] }
    }
  ];
  if (!webSearchServer) {
    tools.push({
      name: "web_search",
      description: "Search the web for current information. Returns titles, links and snippets; use read_url to read a result in full.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    });
  }
  if (hasTab) {
    tools.push(
      { name: "read_page", description: "Read the text of the tab the user is looking at.", parameters: { type: "object", properties: {} } },
      { name: "look_at_screen", description: "Take a screenshot of the visible part of the user's current tab.", parameters: { type: "object", properties: {} } }
    );
  }
  if (hasAgent) {
    tools.push({
      name: "operate_browser",
      description: "Have your browser agent carry out a task in the current tab by clicking, typing and filling forms (it asks the user before anything final). Use only when the user asks you to do something on a page.",
      parameters: { type: "object", properties: { task: { type: "string", description: "Complete, specific instructions for the agent." } }, required: ["task"] }
    });
  }
  return tools;
}

export const clip = (s: unknown, n = 400): string => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };

export async function executeChatTool(call: ToolCall, env: ChatToolEnv): Promise<ChatToolResult> {
  const a = call.args || {};
  switch (call.name) {
    case "calculate": {
      const lines = Array.isArray(a.lines) ? a.lines : String(a.lines || a.expression || "").split("\n");
      const out = await calcEngine.run(lines);
      return { text: out, summary: out.split("\n").slice(-1)[0] };
    }
    case "web_search": {
      const results = await webSearchFallback(String(a.query || ""), 6, { signal: env.signal });
      const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
      env.addCitations(results.map(r => ({ url: r.url, title: r.title })));
      return { text: untrusted(`web search: ${a.query}`, text), summary: `${results.length} results` };
    }
    case "read_url": {
      // A page could trick the model into "reading" a link that carries your data away.
      const leaked = typeof personalDetailsIn === "function" && typeof getProfile === "function" ? personalDetailsIn(String(a.url || ""), await getProfile()) : [];
      if (leaked.length) return { text: `Not opened: that link contains the user's ${leaked.join(", ")}. If they really want it, they can open it themselves.`, isError: true };
      const page = await fetchUrlText(String(a.url || ""), { signal: env.signal });
      env.addCitations([{ url: page.url, title: page.title }]);
      return { text: untrusted(page.url, `Title: ${page.title}\n\n${page.text}${page.truncated ? "\n[shortened]" : ""}`), summary: page.title };
    }
    case "read_page": {
      const page = await readPageText(40000);
      if (!page?.text) return { text: "This page has no readable text. Try look_at_screen." };
      return { text: untrusted(page.url, `Title: ${page.title}\n\n${page.text}${page.truncated ? "\n[shortened]" : ""}`), summary: page.title };
    }
    case "look_at_screen": {
      const img = await captureScreen();
      return { text: "Screenshot of the user's current tab is attached.", images: [img], summary: "Captured" };
    }
    case "remember": {
      const { memory, updated } = await env.memory.add(String(a.fact || ""), { due: a.due, origin: a.stated === false ? "inferred" : "stated" });
      env.onMemory?.({ type: "saved", memory, updated });
      return { text: `${updated ? "Updated" : "Saved"} memory [${memory.id.slice(0, 8)}]: ${memory.text}`, summary: memory.text };
    }
    case "recall": {
      const scope = a.scope && a.scope !== "all" ? [a.scope] : undefined;
      const hits = await env.memory.search(String(a.query || ""), scope);
      if (!hits.length) return { text: "Nothing relevant found in memories, documents or past chats.", summary: "Nothing found" };
      const text = hits.map(h => h.kind === "memory" ? `[memory ${h.id.slice(0, 8)}] ${h.text}` : `[${h.title}]\n${h.text}`).join("\n\n");
      return { text: hits.some(h => h.kind !== "memory") ? untrusted("your documents and past chats", text) : text, summary: `${hits.length} found` };
    }
    case "use_skill": {
      const list = await (env.memory.skills || getSkills)();
      const want = String(a.name || "").toLowerCase().trim();
      const s = list.find(x => x.name.toLowerCase() === want) || list.find(x => x.name.toLowerCase().includes(want) && want.length > 2);
      if (!s) return { text: `No skill named "${a.name}". Saved skills: ${list.map(x => x.name).join(", ") || "none"}.`, isError: true };
      if (!env.memory.skills) markSkillUsed(s.id).catch(() => {});
      return { text: `Skill "${s.name}" (${s.when || "saved procedure"}):\n${s.body}`, summary: s.name };
    }
    case "forget": {
      const removed = await env.memory.remove(String(a.memory_id || ""));
      if (!removed) return { text: `No memory with id ${a.memory_id}.`, isError: true };
      env.onMemory?.({ type: "forgot", memory: removed });
      return { text: `Forgot: ${removed.text}`, summary: removed.text };
    }
    case "operate_browser": {
      const summary = await env.runAgent!(String(a.task || ""));
      return { text: `Agent finished. Its report:\n${summary}`, summary: "Done" };
    }
    default:
      return { text: `Unknown tool ${call.name}.`, isError: true };
  }
}

// Real memory store (the eval runner swaps in a temporary one).
export const realMemoryStore: ChatMemoryStore = {
  add: (text, extra = {}) => addMemory(text, "chat", extra.kind || "fact", extra),
  remove: async shortId => {
    const m = (await getMemories()).find(x => x.id.startsWith(shortId.replace(/[\[\]\s]/g, "")));
    return m ? deleteMemory(m.id) : null;
  },
  search: (q, scopes) => searchPersonal(q, { scopes }),
  relevant: q => memoriesFor(q),
  standing: () => standingMemories(),
  upcoming: () => upcomingMemories(),
  skills: undefined, // real skills (getSkills) are used when this is unset
  about: async () => (await getUserModel()).text
};
