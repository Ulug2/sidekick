// Messages in the chat: the empty state and suggestions, user and assistant bubbles, the live
// status line and thinking, sources, the Details trace, action buttons, tool chips and toasts.
import { messagesEl, PROMPTS, busy, sendAgent, attachPage, send, autoScroll, replaceSelectionOnPage, speak } from "./sidepanel.js";
import { LOGO, ICON } from "./icons.js";
import { getProfile, profileIsEmpty } from "../../assistant/profile-core.js";
import { activeTab } from "../../core/browser/screen.js";
import { renderMarkdown } from "./markdown.js";
import { deleteMemory } from "../../assistant/memory/memory.js";
import { $ } from "../shared/dom.js";
import { getSettings } from "../../core/llm/settings.js";

// ---------- toasts ----------

export function showToast(text: string, action?: { label: string; onClick: () => void }) {
  const t = $("#toast");
  t.innerHTML = `<span></span>`;
  t.firstChild.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = () => { action.onClick(); t.classList.remove("show"); };
    t.appendChild(b);
  }
  t.classList.add("show");
  clearTimeout((showToast as any).timer);
  (showToast as any).timer = setTimeout(() => t.classList.remove("show"), 8000);
}

// ---------- messages ----------

export function showEmpty() {
  messagesEl.innerHTML = `
    <div class="empty">
      ${LOGO}
      <h1 id="greeting">How can I help?</h1>
      <p>Ask anything, or try one of these.</p>
      <div class="suggestions" id="suggestions"></div>
    </div>`;
  renderGreeting().catch(() => {});
}

// "Good evening, Ulugbek" plus suggestions that fit the page you're on.
export async function renderGreeting() {
  const [s, profile] = await Promise.all([getSettings(), getProfile()]);
  const first = (s.addressAs || profile.preferredName || profile.fullName || "").trim().split(/\s+/)[0];
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const g = $("#greeting");
  if (g) g.textContent = first ? `${part}, ${first}.` : `${part}.`;
  const box = $("#suggestions");
  if (!box) return;
  let tab = null;
  try { tab = await activeTab(); } catch {}
  for (const sug of suggestionsFor(tab, profileIsEmpty(profile))) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "suggestion";
    b.textContent = sug.label;
    b.onclick = () => runSuggestion(sug);
    box.appendChild(b);
  }
}

export function suggestionsFor(tab: any, noProfile: any) {
  const url = (tab?.url || "").toLowerCase();
  const title = (tab?.title || "").toLowerCase();
  const out = [];
  const normal = /^https?:/.test(url);
  if (normal && (/greenhouse\.io|lever\.co|myworkdayjobs|workday|ashbyhq|smartrecruiters|icims|linkedin\.com\/jobs|indeed\.com|wellfound|handshake|\/jobs?\/|\/careers?\//.test(url) || /\b(job|careers?|intern(ship)?|hiring|apply)\b/.test(title))) {
    out.push({ label: "How well do I fit this role?", prompt: "How well do I fit this role? Compare it with my profile: strengths, gaps, and whether it's worth applying.", page: true });
    out.push({ label: "Apply to this job", agent: PROMPTS.apply });
  } else if (/mail\.google\.com|outlook\.(live|office)/.test(url)) {
    out.push({ label: "Draft a reply to this email", prompt: "Draft a reply to the email I have open, in my voice. Keep it short.", page: true });
    out.push({ label: "Summarize this thread", prompt: "Summarize this email thread and list anything I need to do.", page: true });
  } else if (/instructure|canvas|blackboard|moodle|gradescope|brightspace|d2l/.test(url)) {
    out.push({ label: "What's due soon?", prompt: "List everything due on this page with dates, soonest first.", page: true });
    out.push({ label: "Make a study plan", prompt: "Make a short study plan for what's on this page, given today's date.", page: true });
  } else if (/github\.com/.test(url)) {
    out.push({ label: "Explain this code", prompt: "Explain what this repository or file does, briefly, then point out anything notable.", page: true });
  } else if (/youtube\.com\/watch/.test(url)) {
    out.push({ label: "What's this video about?", prompt: "Based on this page, what's this video about and is it worth watching for me?", page: true });
  } else if (normal) {
    out.push({ label: "Summarize this page", prompt: PROMPTS.summarize, page: true });
    out.push({ label: "Explain my screen", prompt: PROMPTS.screen, screen: true });
  }
  out.push(noProfile ? { label: "Set up my profile", openProfile: true } : { label: "What do you know about me?", prompt: "What do you know about me? Include what's in my profile and memories, briefly." });
  return out.slice(0, 4);
}

export async function runSuggestion(sug: any) {
  if (busy) return;
  if (sug.openProfile) return chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") });
  if (sug.agent) return sendAgent(sug.agent);
  if (sug.page) {
    try { await attachPage(); } catch (err: any) { /* fall back to letting the model read it */ }
  }
  send(sug.prompt, { forceScreen: !!sug.screen });
}

export function clearEmpty() {
  messagesEl.querySelector(".empty")?.remove();
}

export function addUserMessage(d: any) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg user";
  if (d.images?.length) {
    const row = document.createElement("div");
    row.className = "shots";
    for (const src of d.images) {
      const img = document.createElement("img");
      img.className = "shot";
      img.src = src;
      img.alt = "Attached image";
      img.onclick = () => img.classList.toggle("expanded");
      row.appendChild(img);
    }
    div.appendChild(row);
  }
  const tags = [
    ...(d.agent ? [{ icon: ICON.agent, text: "Agent" }] : []),
    ...(d.page ? [{ icon: ICON.page, text: d.page }] : []),
    ...(d.files || []).map((f: any) => ({ icon: ICON.file, text: f }))
  ];
  if (tags.length) {
    const row = document.createElement("div");
    row.className = "tags";
    for (const t of tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.innerHTML = t.icon + "<span></span>";
      tag.lastChild!.textContent = t.text;
      row.appendChild(tag);
    }
    div.appendChild(row);
  }
  if (d.quote) {
    const q = document.createElement("div");
    q.className = "quote";
    q.textContent = d.quote;
    div.appendChild(q);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = d.prompt;
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  return div;
}

// The live status at the top of a reply: what Sidekick is doing right now, a preview of its
// latest thought and the time so far. Click it to read the full thinking. When the reply is
// done it collapses into "Thought for 12s" (kept with the chat), or disappears for quick replies.
export function createStatus(ai: any) {
  const d = ai.thinking;
  const label = d.querySelector(".st-label"), preview = d.querySelector(".st-preview"), time = d.querySelector(".st-time"), body = d.querySelector(".thought-text");
  const t0 = Date.now();
  let phase: string | null = null, raw = "", ended = false;
  const secs = () => Math.max(1, Math.round((Date.now() - t0) / 1000));
  const tick = setInterval(() => { if (Date.now() - t0 > 1500) time.textContent = `${secs()}s`; }, 500);
  const api = {
    set(text: any) { if (!ended && text) label.textContent = text; },
    think(chunk: any, ph = "Answer") {
      if (ended || !chunk) return;
      if (ph !== phase) {
        phase = ph;
        if (raw || ph !== "Answer") {
          const h = document.createElement("div");
          h.className = "thought-phase";
          h.textContent = ph;
          body.appendChild(h);
        }
        const p = document.createElement("div");
        p.className = "thought-chunk";
        body.appendChild(p);
      }
      body.lastChild.textContent += chunk.replace(/\*\*/g, "");
      raw += (raw && ph !== (api as any)._last ? `\n\n[${ph}]\n` : "") + chunk;
      (api as any)._last = ph;
      d.classList.add("has-thoughts");
      const line = raw.replace(/\*\*/g, "").trim().split(/\n+/).pop()!.replace(/[#`>_]/g, "").trim();
      preview.textContent = line.length > 120 ? "…" + line.slice(-118) : line;
    },
    end({ keep = true } = {}) {
      if (ended) return api.thoughts();
      ended = true;
      clearInterval(tick);
      d.classList.remove("live");
      d.open = false;
      const n = secs();
      if (!keep || (!raw && n < 4)) { d.remove(); return api.thoughts(); }
      label.textContent = raw ? `Thought for ${n}s` : `Worked for ${n}s`;
      preview.textContent = "";
      time.textContent = "";
      if (!raw) d.classList.add("no-body");
      return api.thoughts();
    },
    thoughts: () => (raw ? { text: raw.slice(0, 20000), secs: secs() } : null)
  };
  return api;
}

// A finished reply's saved thinking, collapsed (for reopened chats).
export function restoreThoughts(ai: any, thoughts: any) {
  const d = ai.thinking;
  if (!thoughts?.text) { d.remove(); return; }
  d.classList.remove("live");
  d.classList.add("has-thoughts");
  d.querySelector(".st-label").textContent = `Thought for ${thoughts.secs || 1}s`;
  const p = document.createElement("div");
  p.className = "thought-chunk";
  p.textContent = thoughts.text.replace(/\*\*/g, "");
  d.querySelector(".thought-text").appendChild(p);
}

export function addAiMessage() {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg ai";
  div.innerHTML = `<details class="thinking live"><summary>${LOGO}<span class="st-label">Thinking</span><span class="st-preview"></span><span class="st-time"></span></summary><div class="thought-text"></div></details><div class="tool-chips"></div><div class="md"></div>`;
  messagesEl.appendChild(div);
  return { el: div, md: div.querySelector(":scope > .md"), thinking: div.querySelector(".thinking"), chips: div.querySelector(".tool-chips") };
}

export function addError(text: any) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg error";
  div.innerHTML = ICON.alert;
  const span = document.createElement("span");
  span.textContent = text;
  div.appendChild(span);
  messagesEl.appendChild(div);
  autoScroll();
}

export function addSources(div: any, citations: any) {
  if (!citations?.length) return;
  const box = document.createElement("div");
  box.className = "sources";
  for (const c of citations.slice(0, 8)) {
    if (!/^https?:\/\//i.test(String(c.url || ""))) continue;
    const a = document.createElement("a");
    a.href = c.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "source";
    let host = c.url;
    try { host = new URL(c.url).hostname.replace(/^www\./, ""); } catch {}
    a.title = c.title || c.url;
    a.innerHTML = `${ICON.link}<span></span>`;
    a.querySelector("span")!.textContent = host;
    box.appendChild(a);
  }
  div.appendChild(box);
}

export function fmtTokens(n: any) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n || 0); }

// "Details": which model answered and why, each tool call, tokens and time.
export function traceView(trace: any) {
  const box = document.createElement("div");
  box.className = "trace hidden";
  const u = trace.usage || {};
  const head = document.createElement("div");
  head.className = "trace-head";
  head.textContent = `${trace.route?.model} · ${trace.route?.tier} (${trace.route?.reason}) · effort ${trace.route?.effort} · ${(trace.ms / 1000).toFixed(1)}s · ${fmtTokens(u.input + u.cacheRead + u.cacheWrite)} in${u.cacheRead ? ` (${fmtTokens(u.cacheRead)} cached)` : ""} / ${fmtTokens(u.output)} out`;
  box.appendChild(head);
  if (trace.verification) {
    const v = document.createElement("div");
    v.className = "trace-head";
    const tv = trace.verification;
    v.textContent = `Double-check${tv.model ? ` (${tv.model})` : ""}: ${tv.verdict}${tv.corrected ? " (answer corrected)" : ""}${tv.outcome ? ` · outcome: ${tv.outcome}` : ""}${tv.reason ? ` · ${tv.reason}` : ""}${tv.evidence ? ` · evidence: ${tv.evidence}` : ""}`;
    box.appendChild(v);
    if (tv.tieBreak) {
      const t = document.createElement("div");
      t.className = "trace-head";
      t.textContent = `Third solve (${tv.tieBreak.model}): ${String(tv.tieBreak.answer || "").replace(/\s+/g, " ").slice(0, 200)}`;
      box.appendChild(t);
    }
  }
  const tools = [...(trace.rounds || []).flatMap((r: any) => r.tools || []), ...(trace.verification?.tools || []).map((t: any) => ({ ...t, name: `${t.name} (double-check)` })), ...(trace.verification?.tieBreak?.tools || []).map((t: any) => ({ ...t, name: `${t.name} (third solve)` }))];
  for (const t of tools) {
    const d = document.createElement("details");
    d.className = "trace-tool" + (t.error ? " err" : "");
    d.innerHTML = `<summary></summary><pre></pre>`;
    d.querySelector("summary")!.textContent = `${t.name}${t.ms ? ` · ${t.ms} ms` : ""}${t.error ? " · error" : ""}`;
    d.querySelector("pre")!.textContent = `Input: ${JSON.stringify(t.args, null, 1)}\n\nResult: ${t.result}`;
    box.appendChild(d);
  }
  if (!tools.length) {
    const p = document.createElement("div");
    p.className = "trace-none";
    p.textContent = "No tools used.";
    box.appendChild(p);
  }
  return box;
}

export function actButton(icon: any, label: any, title: any, onclick: any) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "act";
  b.title = title || label;
  b.setAttribute("aria-label", b.title);
  b.innerHTML = `${icon}${label ? `<span class="act-label">${label}</span>` : ""}`;
  b.onclick = onclick;
  return b;
}

export function addActions(div: any, text: any, canReplace: any, stopped: any, extra = {}) {
  addSources(div, (extra as any).citations);
  const actions = document.createElement("div");
  actions.className = "actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "act";
  copy.title = "Copy";
  copy.innerHTML = `${ICON.copy}<span class="act-label">Copy</span>`;
  copy.onclick = async () => {
    await navigator.clipboard.writeText(text);
    copy.innerHTML = `${ICON.check}<span class="act-label">Copied</span>`;
    setTimeout(() => (copy.innerHTML = `${ICON.copy}<span class="act-label">Copy</span>`), 1400);
  };
  actions.appendChild(copy);

  if (canReplace) {
    const rep = document.createElement("button");
    rep.type = "button";
    rep.className = "act";
    rep.title = "Replace the selected text on the page";
    rep.innerHTML = `${ICON.replace}<span class="act-label">Replace on page</span>`;
    rep.onclick = async () => {
      const ok = await replaceSelectionOnPage(text);
      if (!ok) await navigator.clipboard.writeText(text);
      rep.innerHTML = `${ok ? ICON.check : ICON.copy}<span>${ok ? "Replaced" : "Not editable, copied instead"}</span>`;
    };
    actions.appendChild(rep);
  }
  actions.appendChild(actButton(ICON.speak, "", "Read aloud", () => speak(text, true)));
  if ((extra as any).retry) {
    actions.appendChild(actButton(ICON.retry, "", "Try again with the smart model", () => (extra as any).retry("smart")));
  }
  if ((extra as any).trace) {
    const tv = traceView((extra as any).trace);
    const tierTag = document.createElement("span");
    tierTag.className = "tier-tag";
    tierTag.textContent = (extra as any).trace.route?.tier === "smart" ? "smart" : "fast";
    tierTag.title = `${(extra as any).trace.route?.model}: ${(extra as any).trace.route?.reason}`;
    actions.appendChild(actButton(ICON.info, "", "Details: model, tools, tokens", () => tv.classList.toggle("hidden")));
    actions.appendChild(tierTag);
    div.appendChild(actions);
    div.appendChild(tv);
  } else {
    div.appendChild(actions);
  }

  if (stopped) {
    const note = document.createElement("div");
    note.className = "stopped-note";
    note.textContent = "Stopped";
    div.appendChild(note);
  }
}

// ---------- smooth streaming reveal ----------
// Network chunks arrive in uneven bursts. This releases text a few characters per
// animation frame and speeds up when far behind, so it reads like very fast typing
// that flows top to bottom. Markdown is re-rendered on each frame.
export function createTypewriter(el: any) {
  let target = "";
  let shown = 0;
  let ended = false;
  let raf: number | null = null;
  let resolveFinished!: (value?: unknown) => void;
  const finished = new Promise(r => (resolveFinished = r));

  function paint() {
    renderMarkdown(el, target.slice(0, shown));
    autoScroll();
  }

  function tick() {
    const remaining = target.length - shown;
    if (remaining > 0) {
      shown = Math.min(target.length, shown + Math.max(2, Math.ceil(remaining / 8)));
      const code = target.charCodeAt(shown - 1); // don't split an emoji in half
      if (code >= 0xd800 && code <= 0xdbff && shown < target.length) shown++;
      paint();
    }
    if (shown < target.length || !ended) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
      resolveFinished();
    }
  }

  const start = () => { if (!raf) raf = requestAnimationFrame(tick); };

  return {
    push(text: any) { target += text; start(); },
    end() { ended = true; start(); },
    // Show everything received so far immediately and stop animating.
    flush() {
      ended = true;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      shown = target.length;
      paint();
      resolveFinished();
    },
    finished
  };
}

// ---------- sending ----------

export const TOOL_LABEL: Record<string, string[]> = {
  calculate: [ICON.calc, "Calculating", "Calculated"],
  web_search: [ICON.search, "Searching the web", "Searched the web"],
  read_url: [ICON.link, "Reading a page", "Read"],
  read_page: [ICON.page, "Reading this page", "Read this page"],
  look_at_screen: [ICON.eye, "Looking at your screen", "Looked at your screen"],
  remember: [ICON.brain, "Saving to memory", "Saved to memory"],
  recall: [ICON.brain, "Checking memory", "Checked memory"],
  forget: [ICON.brain, "Forgetting", "Forgot"],
  operate_browser: [ICON.agent, "Working on the page", "Worked on the page"],
  verify: [ICON.check, "Double-checking the answer", "Double-checked"],
  tiebreak: [ICON.check, "Solving it a third time to break the tie", "Third solve"]
};

export function addToolChip(container: any, name: any, args: any) {
  const [icon, running, done] = TOOL_LABEL[name] || [ICON.info, name, name];
  const chip = document.createElement("div");
  chip.className = "tool-chip running";
  chip.innerHTML = `${icon}<span class="tc-label"></span><span class="tc-detail"></span>`;
  const label = chip.querySelector(".tc-label"), detail = chip.querySelector(".tc-detail");
  label!.textContent = running;
  if (name === "web_search" && args?.query) detail!.textContent = `“${args.query}”`;
  if (name === "read_url" && args?.url) { try { detail!.textContent = new URL(args.url).hostname.replace(/^www\./, ""); } catch {} }
  container.appendChild(chip);
  autoScroll();
  return {
    el: chip,
    done(summary: any) {
      chip.className = "tool-chip";
      label!.textContent = done;
      if (summary && ["calculate", "remember", "forget"].includes(name)) detail!.textContent = String(summary).replace(/^.*→\s*/, "").slice(0, 80);
      if (summary && name === "web_search" && !detail!.textContent) detail!.textContent = summary;
      if (summary && name === "read_url") detail!.textContent = String(summary).slice(0, 60);
      if (summary && (name === "verify" || name === "tiebreak")) {
        detail!.textContent = String(summary).slice(0, 120);
        chip.title = summary;
        if (/^Fixed/.test(summary)) chip.classList.add("fixed");
        if (/^Solves disagree|^Still disagrees/.test(summary)) chip.classList.add("warn");
      }
    },
    fail(msg: any) {
      chip.className = "tool-chip failed";
      label!.textContent = `${done.replace(/^(Calculated|Read|Searched|Saved|Checked|Looked|Forgot|Worked)/, "Couldn't finish:")}`;
      detail!.textContent = String(msg || "").slice(0, 90);
      chip.title = msg || "";
    }
  };
}

// Memory chips get an Undo.
export function memoryChip(container: any, evt: any) {
  const chip = [...container.querySelectorAll(".tool-chip")].pop();
  if (!chip || evt.type !== "saved") return;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "tc-undo";
  undo.textContent = "Undo";
  undo.onclick = async () => {
    await deleteMemory(evt.memory.id);
    chip.classList.add("undone");
    chip.querySelector(".tc-label").textContent = "Not saved";
    undo.remove();
  };
  chip.appendChild(undo);
}
