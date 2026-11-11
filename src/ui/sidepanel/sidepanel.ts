// The side panel: page wiring, the chat state, sending messages (chat and agent), attachments,
// voice, and the shortcuts. Rendering, chat history, the agent card and notifications live in
// the other files of this folder.
import { pickRegionInPage } from "../../page/region.js";
import { pageReplaceSelection } from "../../page/replace-selection.js";
import { extractDocText, isDocFile } from "../../core/docs/docs.js";
import { redactSecrets, untrusted } from "../../core/security/guard.js";
import { activeTab, captureScreen, readPageText, readSelectionFromPage, runInPage } from "../../core/browser/screen.js";
import type { Chat, ChatMessage } from "../../core/storage/schema.js";
import { runTurn } from "../../assistant/turn.js";
import { newChat, saveChat, reflectChat, togglePin, renderPin, waitForNotes, refreshNotes, drawerOpen, setDrawer, renderChatList, reflectStaleChats } from "./chats.js";
import { createTypewriter, addError, showToast, addUserMessage, addAiMessage, restoreThoughts, addActions, showEmpty, createStatus, addToolChip, TOOL_LABEL, memoryChip } from "./messages.js";
import { ICON, LOGO } from "./icons.js";
import { addAgentRun, agentRun, runAgentCard, agentHistory, INTERRUPTED } from "./agent-card.js";
import { checkBenchPending } from "./bench-run.js";
import { checkJobBatch } from "./jobs-run.js";
import type { AgentFile } from "../../agent/types.js";
import type { WorkerTask } from "../../orchestrator/types.js";
import { renderMarkdown, renderReview } from "./markdown.js";
import { notifyIds, clearNotice } from "./notify.js";
import { $ } from "../shared/dom.js";
import { getSettings, modelFor } from "../../core/llm/settings.js";
import type { Tier } from "../../core/llm/types.js";

export const scroller = $("#scroller");
export const messagesEl = $("#messages");
export const input = $("#input");
export const sendBtn = $("#send");
export const toBottomBtn = $("#toBottom");
export const tray = $("#tray");

// A chat is saved as { id, title, createdAt, updatedAt, messages }.
// User message:      { role: "user", text, images: [dataURL], display: { prompt, quote, page, files, images }, canReplace }
// Assistant message: { role: "assistant", text, stopped?, canReplace? }
export let chat: Chat = newChat();
export let attachments: any[] = [];      // pending for the next message: { kind: "selection"|"page"|"image"|"file", ... }
export let includeScreen = false; // "Screen" toggle: attach a screenshot to every message
export let busy = false;
export let controller: AbortController | null = null;     // AbortController for the running request
export let currentTw: ReturnType<typeof createTypewriter> | null = null;      // typewriter for the running reply
export let agentMode = false;     // "Agent" toggle: Sidekick acts on the page instead of only chatting
export let lastTier: Tier | null = null;       // tier of the previous reply, so short follow-ups stay on the smart model
export let lastInputWasVoice = false;

export const MAX_IMAGES = 6;
export const MAX_TEXT_FILE = 100_000; // characters
export const MAX_PAGE_TEXT = 60_000;  // characters
export const MAX_CHATS = 200;

export const PROMPTS: Record<string, string> = {
  rewrite: "Rewrite the selected text so it is clearer and more natural. Keep the meaning, tone, and language.",
  shorten: "Make the selected text noticeably shorter while keeping the key points.",
  grammar: "Fix grammar, spelling, and punctuation in the selected text. Change nothing else.",
  summarize: "Summarize this page. Start with a one-sentence takeaway, then the key points.",
  screen: "Look at my screen. Summarize what's on it and point out anything I might want to act on.",
  apply: "Apply to the job on this page for me using my profile. Read the job description first, fill out the whole application, and ask me before submitting.",
  fillform: "Fill out the form on this page with my information from my profile. Ask me about anything my profile doesn't cover, and ask before submitting.",
  findjobs: "Look through the job listings on this page and tell me which ones fit my profile best and why. Open the most promising ones in new tabs. Don't apply to anything."
};
export const AGENT_ACTIONS = new Set(["apply", "fillform", "findjobs"]);
export const TEXT_ACTIONS = new Set(["rewrite", "shorten", "grammar"]);

// ---------- markdown ----------

marked.use({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// ---------- scrolling ----------
// Auto-scroll follows new text only while "stuck" to the bottom. Any upward scroll by the
// user (wheel, trackpad, scrollbar drag, touch) unsticks it immediately, so the panel never
// fights you. Scrolling back to the very bottom, or the arrow button, re-sticks it.

export let stick = true;
export let prevTop = 0;
export let lastAutoTop = 0;
export let smoothing = false; // true while the jump-to-bottom button's smooth scroll is running

export function distanceFromBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

export function autoScroll() {
  if (stick && !smoothing) {
    scroller.scrollTop = scroller.scrollHeight;
    lastAutoTop = scroller.scrollTop;
  }
  updateToBottom();
}

export function updateToBottom() {
  toBottomBtn.classList.toggle("show", distanceFromBottom() > 120);
}

scroller.addEventListener("wheel", (e: any) => {
  if (e.deltaY < 0) { stick = false; smoothing = false; }
}, { passive: true });
scroller.addEventListener("touchmove", () => {
  if (distanceFromBottom() > 4) { stick = false; smoothing = false; }
}, { passive: true });
scroller.addEventListener("scroll", () => {
  const top = scroller.scrollTop;
  const movedDown = top > prevTop;
  prevTop = top;
  if (smoothing) {
    // Our own smooth scroll is running: don't treat it as the user scrolling.
    if (distanceFromBottom() < 8) { smoothing = false; lastAutoTop = top; }
    updateToBottom();
    return;
  }
  if (top < lastAutoTop - 2) stick = false;               // user went up (scrollbar, keys, etc.)
  if (movedDown && distanceFromBottom() < 8) stick = true; // user came back to the bottom
  updateToBottom();
}, { passive: true });
new ResizeObserver(() => autoScroll()).observe(messagesEl);

toBottomBtn.onclick = () => {
  stick = true;
  smoothing = true;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  // If text kept streaming in, the bottom moved during the animation; finish the job.
  setTimeout(() => {
    if (!smoothing) return;
    smoothing = false;
    autoScroll();
  }, 500);
};

// ---------- page helpers ----------

export async function replaceSelectionOnPage(text: any) {
  try {
    return !!(await runInPage(pageReplaceSelection, [text]));
  } catch {
    return false;
  }
}

export async function cropDataUrl(dataUrl: any, rect: any) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bmp.width / rect.vw; // screenshot pixels per CSS pixel (handles Retina and zoom)
  const sx = Math.round(rect.x * scale), sy = Math.round(rect.y * scale);
  const sw = Math.max(1, Math.round(rect.w * scale)), sh = Math.max(1, Math.round(rect.h * scale));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
}

export function blobToDataUrl(blob: any) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Large photos are scaled down (long edge 1568px, what vision models actually use) to keep
// requests fast and cheap. Small images are kept exactly as they are.
export async function prepareImage(blob: any) {
  const bmp = await createImageBitmap(blob);
  const longEdge = Math.max(bmp.width, bmp.height);
  if (longEdge <= 1568 && blob.size <= 3_500_000) return blobToDataUrl(blob);
  const k = Math.min(1, 1568 / longEdge);
  const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 }));
}

// ---------- attachments ----------

export function addAttachment(att: any) {
  if (att.kind === "selection" || att.kind === "page") {
    attachments = attachments.filter(a => (a as any).kind !== att.kind); // only one of each
  }
  if (att.kind === "image" && attachments.filter(a => (a as any).kind === "image").length >= MAX_IMAGES) {
    addError(`You can attach up to ${MAX_IMAGES} images per message.`);
    return;
  }
  attachments.push(att);
  renderTray();
}

export function removeAttachment(att: any) {
  attachments = attachments.filter(a => a !== att);
  renderTray();
}

export function renderTray() {
  tray.innerHTML = "";
  tray.classList.toggle("hidden", attachments.length === 0);
  for (const att of attachments) {
    const item = document.createElement("div");
    item.className = (att as any).kind === "image" ? "att att-image" : "att";
    if ((att as any).kind === "image") {
      item.innerHTML = `<img alt="">`;
      item.querySelector("img")!.src = (att as any).dataUrl;
      item.title = (att as any).name;
    } else {
      const icon = (att as any).kind === "selection" ? ICON.selection : (att as any).kind === "page" ? ICON.page : ICON.file;
      const label = (att as any).kind === "selection" ? (att as any).text : (att as any).kind === "page" ? (att as any).title : (att as any).name;
      const sub = (att as any).kind === "selection" ? "Selection" : (att as any).kind === "page" ? ((att as any).truncated ? "Page text (shortened)" : "Page text") : "File";
      item.innerHTML = `${icon}<div class="att-text"><span class="att-label"></span><span class="att-sub">${sub}</span></div>`;
      item.querySelector(".att-label")!.textContent = label;
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "att-x";
    x.setAttribute("aria-label", "Remove attachment");
    x.innerHTML = ICON.x;
    x.onclick = () => removeAttachment(att);
    item.appendChild(x);
    tray.appendChild(item);
  }
  refreshSend();
}

export async function addFiles(files: any) {
  for (const file of files) {
    try {
      if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        addAttachment({ kind: "image", name: file.name || "Pasted image", dataUrl: await prepareImage(file) });
      } else if (isDocFile(file)) {
        const { text, truncated } = await extractDocText(file, { maxChars: MAX_TEXT_FILE });
        addAttachment({ kind: "file", name: file.name + (truncated ? " (shortened)" : ""), text });
      } else if (isTextFile(file)) {
        let text = await file.text();
        if (text.includes("\u0000")) throw new Error(`${file.name} doesn't look like a text file.`);
        const truncated = text.length > MAX_TEXT_FILE;
        text = text.slice(0, MAX_TEXT_FILE);
        addAttachment({ kind: "file", name: file.name + (truncated ? " (shortened)" : ""), text });
      } else {
        throw new Error(`${file.name || "That file"} isn't supported yet. Attach images (PNG, JPG, WebP, GIF), PDFs, Word (.docx), or text and code files.`);
      }
    } catch (err: any) {
      addError(err.message);
    }
  }
}

export const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|ts|tsx|jsx|py|java|c|cpp|cc|h|hpp|cs|go|rs|rb|php|swift|kt|sql|html?|css|scss|xml|ya?ml|toml|ini|cfg|sh|bash|zsh|tex|log|r|m|lua|dart|vue|svelte)$/i;
export const isTextFile = (f: any) => f.type.startsWith("text/") || /json|xml|javascript|x-sh|x-tex/.test(f.type) || TEXT_EXT.test(f.name);

export async function attachSelection({ quiet = false } = {}) {
  const text = await readSelectionFromPage();
  if (text) addAttachment({ kind: "selection", text });
  else if (!quiet) addError("Nothing is selected on the page.");
  return !!text;
}

export async function attachPage() {
  const page = await readPageText(MAX_PAGE_TEXT);
  if (!page?.text) throw new Error("This page has no readable text. Try Screen or the region tool instead.");
  addAttachment({ kind: "page", ...page });
}

export async function captureRegion() {
  const rect = await runInPage(pickRegionInPage, [], "captured", undefined, 0); // waits for you to drag
  if (!rect) return; // cancelled
  const shot = await captureScreen({ raw: true });
  addAttachment({ kind: "image", name: "Captured area", dataUrl: await cropDataUrl(shot, rect) });
  input.focus();
}

// Builds what the model sees: your prompt plus each attachment, clearly labeled.
export function buildUserText(prompt: any, atts: any) {
  // Card numbers, SSNs and API keys you type are masked too (and you're told), so they never
  // reach the model, chat history or memory.
  const typed = redactSecrets(prompt);
  if (typed.count) showToast(`Hid ${typed.count} sensitive value${typed.count > 1 ? "s" : ""} (card, ID number or key) before sending. Sidekick never sends or stores those.`);
  let text = typed.text;
  for (const a of atts) {
    // Outside content is fenced (and secrets masked) so the model treats it as data.
    if (a.kind === "selection") text += `\n\nSelected text:\n${untrusted("text the user selected on the page", a.text)}`;
    if (a.kind === "page") text += `\n\nPage content from "${a.title}"${a.truncated ? " (shortened)" : ""}:\n${untrusted(a.url, a.text)}`;
    if (a.kind === "file") text += `\n\nFile "${a.name}":\n${untrusted(a.name, a.text)}`;
  }
  return text;
}

// Closing or reloading the panel saves the chat as it is (a reply cut off mid-way is kept and
// marked stopped), so nothing is lost when Sidekick starts fresh next time.
window.addEventListener("pagehide", () => {
  if (!chat.messages.length) return;
  if (busy && (chat.messages.at(-1) as any)?.role === "user") {
    const partial = (document.querySelector(".msg.ai:last-child > .md") as any)?.innerText?.trim();
    if (partial) chat.messages.push({ role: "assistant", text: partial, stopped: true });
  }
  saveChat().catch(() => {});
});

export async function openChat(id: any) {
  if (busy) stop();
  const data = await chrome.storage.local.get("chat:" + id);
  const saved = data["chat:" + id];
  if (!saved) return;
  if (chat.id !== (saved as any).id) reflectChat(chat);
  chat = saved as Chat;
  togglePin(false);
  renderPin();
  attachments = [];
  renderTray();
  messagesEl.innerHTML = "";
  messagesEl.classList.add("restoring");
  for (const m of chat.messages) {
    if ((m as any).role === "user") addUserMessage((m as any).display || { prompt: (m as any).text });
    else if ((m as any).agentSteps) {
      const run = addAgentRun();
      if ((m as any).agentPlan) run.plan((m as any).agentPlan);
      for (const t of (m as any).agentSteps) run.addStep(t).done(true);
      run.finish((m as any).stopped ? "stopped" : "done", (m as any).text, (m as any).traceId);
    } else {
      const ai = addAiMessage();
      restoreThoughts(ai, (m as any).thoughts);
      for (const run of (m as any).agentRuns || []) {
        const card = addAgentRun(ai.el);
        for (const t of run.steps) card.addStep(t).done(true);
        card.finish(run.state, "", run.traceId);
      }
      renderMarkdown(ai.md, (m as any).text || "_(empty reply)_");
      renderReview(ai.el, (m as any).review);
      const userMsg = chat.messages[chat.messages.indexOf(m) - 1];
      addActions(ai.el, (m as any).text, (m as any).canReplace, (m as any).stopped, {
        citations: (m as any).citations,
        trace: (m as any).trace,
        retry: (userMsg as any)?.role === "user" ? (t: any) => regenerate(ai.el, userMsg, m, t) : null
      });
    }
  }
  if (!chat.messages.length) showEmpty();
  requestAnimationFrame(() => messagesEl.classList.remove("restoring"));
  stick = true;
  autoScroll();

}

export function startNewChat() {
  if (busy) stop();
  reflectChat(chat); // the old chat's details are left behind; what matters about you is kept
  chat = newChat();
  togglePin(false);
  renderPin();
  attachments = [];
  renderTray();
  showEmpty();

  input.focus();
}

// Copy buttons on code blocks (delegated, since blocks are re-rendered while streaming).
messagesEl.addEventListener("click", async (e: any) => {
  const btn = e.target.closest(".code-copy");
  if (!btn) return;
  const code = btn.closest(".code-block").querySelector("pre").textContent;
  await navigator.clipboard.writeText(code);
  btn.innerHTML = `${ICON.check}<span>Copied</span>`;
  setTimeout(() => (btn.innerHTML = `${ICON.copy}<span>Copy</span>`), 1400);
});

// ---------- composer ----------

export function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

export function refreshSend() {
  const answering = !!(agentRun as any)?.answer; // the agent asked a question; the composer sends the reply
  const showStop = busy && !answering;
  sendBtn.classList.toggle("stop", showStop);
  sendBtn.title = showStop ? (agentRun ? "Stop the agent" : "Stop generating") : answering ? "Send answer" : "Send";
  sendBtn.setAttribute("aria-label", sendBtn.title);
  sendBtn.disabled = !showStop && !input.value.trim();
}

export function setBusy(v: any) {
  busy = v;
  document.querySelectorAll(".chip").forEach(b => ((b as any).disabled = v));
  refreshSend();
}

export function stop() {
  (controller as any)?.abort();
  (currentTw as any)?.flush();
}

export function setAgentMode(v: any) {
  agentMode = v;
  $("#agentToggle").setAttribute("aria-pressed", String(v));
  document.body.classList.toggle("agent-mode", v);
  input.placeholder = v ? "Tell Sidekick what to do on this page" : "Ask anything";
}

export async function updateBadge() {
  const s = await getSettings();
  const b = $("#modelBadge");
  b.textContent = s.routing === "auto" ? "Auto" : s.routing === "smart" ? "Smart" : "Fast";
  b.title = `Model: ${s.routing === "auto" ? `automatic (fast: ${modelFor(s, "fast")}, smart: ${modelFor(s, "smart")})` : modelFor(s, s.routing as Tier)}. Click to change.`;
}

export async function cycleMode() {
  const s = await getSettings();
  const next = { auto: "fast", fast: "smart", smart: "auto" }[s.routing] || "auto";
  await chrome.storage.local.set({ routing: next });
  updateBadge();
}

export async function currentTabInfo() {
  try {
    const t = await activeTab();
    return /^https?:/.test(t.url || "") ? { title: t.title, url: t.url } : null;
  } catch { return null; }
}

// Runs an async tool action and shows any error in the chat.
export async function tryTool(fn: any) {
  try {
    await fn();
  } catch (err: any) {
    addError(err.message);
  }
}

// onSignal: called with the turn's Stop signal as it starts (the benchmark counts the turn's model calls with it).
export async function send(prompt: any, { forceScreen = false, quickAction, tier, retryOf, onSignal }: { forceScreen?: boolean; quickAction?: string; tier?: Tier; retryOf?: ChatMessage; onSignal?: (signal: AbortSignal) => void } = {}) {
  prompt = prompt.trim();
  if ((agentRun as any)?.answer && prompt) return (agentRun as any).answer(prompt);
  if (busy || !prompt) return;
  if (agentMode) return sendAgent(prompt);
  const viaVoice = lastInputWasVoice;
  lastInputWasVoice = false;
  if (listening) stopDictation();
  stopSpeaking();
  setBusy(true);

  let atts = attachments;
  let images = atts.filter(a => (a as any).kind === "image").map(a => (a as any).dataUrl);
  try {
    if (forceScreen || includeScreen) images.unshift(await captureScreen());
  } catch (err: any) {
    addError(err.message);
    setBusy(false);
    return;
  }

  let userMsg: ChatMessage;
  if (retryOf) {
    // Regenerate: reuse the same user message, drop the old answer.
    userMsg = retryOf;
    images = userMsg.images || [];
    atts = userMsg.attachmentKinds || [];
  } else {
    const selection = atts.find(a => (a as any).kind === "selection");
    const page = atts.find(a => (a as any).kind === "page");
    const display = { prompt: redactSecrets(prompt).text, quote: (selection as any)?.text && redactSecrets((selection as any).text).text, page: (page as any)?.title, files: atts.filter(a => (a as any).kind === "file").map(a => (a as any).name), images };
    userMsg = {
      role: "user", text: buildUserText(prompt, atts), images, display, canReplace: !!selection, quickAction,
      attachmentKinds: atts.map(a => ({ kind: (a as any).kind }))
    };
    chat.messages.push(userMsg);
    addUserMessage(display);
    attachments = [];
    renderTray();
    input.value = "";
    resizeInput();
  }
  stick = true;
  autoScroll();

  const history = chat.messages.slice(0, chat.messages.indexOf(userMsg));
  const ai = addAiMessage();
  const dot = document.createElement("div");
  dot.className = "gen-dot";
  dot.innerHTML = LOGO;
  controller = new AbortController();
  onSignal?.(controller.signal);
  currentTw = null;
  let received = "";
  let holding = false; // "just the answer": nothing is shown until the double-check is done
  const status = createStatus(ai);
  const started = () => {
    if (!dot.isConnected && !holding) ai.el.appendChild(dot);
  };

  const agentRuns: any[] = []; // agent tasks this reply ran, saved so the cards come back when you reopen the chat
  const finish = (reply: any, stopped: any, result = {}) => {
    const thoughts = status.end();
    const msg = { role: "assistant", text: reply, canReplace: userMsg.canReplace, tier: (result as any).trace?.route?.tier, trace: (result as any).trace, citations: (result as any).citations, ...(thoughts && { thoughts }), ...((result as any).review && { review: (result as any).review }), ...(agentRuns.length && { agentRuns }), ...(stopped && { stopped: true }) };
    chat.messages.push(msg);
    lastTier = msg.tier || lastTier;
    addActions(ai.el, reply, userMsg.canReplace, stopped, {
      citations: (result as any).citations,
      trace: (result as any).trace,
      retry: (t: any) => regenerate(ai.el, userMsg, msg, t)
    });
    saveChat().catch(err => console.warn("Couldn't save chat", err));
  };

  const thisChat = chat;
  try {
    await waitForNotes(thisChat);
    const s = await getSettings();
    const result = await runTurn(history, { text: userMsg.text, images, attachments: atts, quickAction: userMsg.quickAction }, {
      sessionNotes: thisChat.notes || [],
      signal: (controller! as any).signal,
      tier: tier || (s.routing !== "auto" ? s.routing as Tier : undefined),
      previousTier: lastTier,
      tabInfo: await currentTabInfo(),
      hasTab: true,
      screenFromTab: !!(forceScreen || includeScreen) && !retryOf,
      onHold: () => {
        holding = true;
        status.set("Solving and double-checking before showing the answer");
      },
      onStatus: text => status.set(text),
      onThinking: (chunk, phase) => status.think(chunk, phase),
      onText: chunk => {
        if (!received) status.set("Writing the answer");
        started();
        currentTw ||= createTypewriter(ai.md);
        received += chunk;
        (currentTw! as any).push(chunk);
      },
      onToolStart: (name, args) => {
        started();
        const chip = addToolChip(ai.chips, name, args);
        status.set((TOOL_LABEL[name] || [null, name])[1]);
        const back = () => status.set(holding ? "Solving and double-checking before showing the answer" : received ? "Writing the answer" : "Thinking");
        return { ...chip, done: x => { chip.done(x); back(); }, fail: x => { chip.fail(x); back(); } };
      },
      onMemory: evt => memoryChip(ai.chips, evt),
      runAgent: async task => {
        const r = await runAgentCard(task, ai.el);
        agentRuns.push({ steps: r.steps, state: r.state, ...(r.traceId && { traceId: r.traceId }) });
        return r.summary;
      }
    });
    if (currentTw) {
      (currentTw as any).end();
      await (currentTw as any).finished;
    }
    holding = false;
    if (!result.text) renderMarkdown(ai.md, "_(no reply)_");
    else if (!currentTw || result.corrected) renderMarkdown(ai.md, result.text);
    renderReview(ai.el, result.review);
    finish(result.text, false, result);
    refreshNotes(thisChat, userMsg, result.text);
    if (s.readAloud || viaVoice) speak(result.text);
  } catch (err: any) {
    (currentTw as any)?.flush();
    if (err.name === "AbortError") {
      if (received) finish(received, true);
      else { ai.el.remove(); if (!retryOf) chat.messages.pop(); }
    } else {
      ai.el.remove();
      if (!retryOf) chat.messages.pop(); // drop the failed user turn so a retry doesn't duplicate it
      addError(err.message);
    }
  } finally {
    status.end();
    dot.remove();
    controller = null;
    currentTw = null;
    setBusy(false);
    autoScroll();
    input.focus();
  }
}

// Re-asks the same question (optionally with the smart model), replacing the old answer.
export async function regenerate(aiEl: any, userMsg: any, oldMsg: any, tier: any) {
  if (busy) return;
  if (chat.messages[chat.messages.length - 1] !== oldMsg) {
    addError("Only the latest answer can be retried. Ask again below instead.");
    return;
  }
  const i = chat.messages.indexOf(oldMsg);
  if (i > -1) chat.messages.splice(i, 1);
  aiEl.remove();
  await send(userMsg.display?.prompt || userMsg.text, { tier, retryOf: userMsg });
}

export async function runAction(action: any) {
  if (busy) return;
  try {
    if (TEXT_ACTIONS.has(action) && !attachments.some(a => (a as any).kind === "selection")) {
      if (!(await attachSelection({ quiet: true }))) return addError("Select some text on the page first.");
    }
    if (action === "summarize" && !attachments.some(a => (a as any).kind === "page")) await attachPage();
  } catch (err: any) {
    return addError(err.message);
  }
  if (AGENT_ACTIONS.has(action)) return sendAgent(PROMPTS[action]);
  send(PROMPTS[action], { forceScreen: action === "screen", quickAction: action });
}

// opts.maxCost: dollar limit for the run; opts.tabId: the tab to work in (benchmark). Returns what runAgentCard returned.
export async function sendAgent(goal: any, opts: { maxCost?: number; tabId?: number; tier?: "fast" | "smart"; files?: Record<string, AgentFile>; preApproved?: { sites: string[]; autoSubmit: boolean }; task?: WorkerTask } = {}) {
  if (busy) return;
  if (listening) stopDictation();
  const atts = attachments;
  const fullGoal = buildUserText(goal, atts.filter(a => (a as any).kind !== "image"));
  const display = { prompt: goal, agent: true, quote: (atts.find(a => (a as any).kind === "selection") as any)?.text, files: atts.filter(a => (a as any).kind === "file").map(a => (a as any).name) };
  chat.messages.push({ role: "user", text: fullGoal, images: [], display });
  addUserMessage(display);
  attachments = [];
  renderTray();
  input.value = "";
  resizeInput();
  stick = true;

  // The run is saved as it goes, so closing the panel or a crash mid-run never loses it.
  const history = agentHistory(chat.messages.slice(0, -1), chat.notes);
  const msg: ChatMessage = { role: "assistant", text: INTERRUPTED, agentSteps: [], stopped: true };
  chat.messages.push(msg);
  saveChat().catch(e => console.warn("Couldn't save chat", e));
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const progress = (p: any) => {
    Object.assign(msg, p);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveChat().catch(() => {}), 600);
  };

  controller = new AbortController();
  setBusy(true);
  const userMessages = chat.messages.slice(0, -2).filter(m => (m as any).role === "user").slice(-6).map(m => (m as any).display?.prompt ?? (m as any).text ?? "");
  const result = await runAgentCard(fullGoal, undefined, { history, progress, userMessages, maxCost: opts.maxCost, tabId: opts.tabId, tier: opts.tier, files: opts.files, preApproved: opts.preApproved, task: opts.task });
  const { summary, steps, state, plan, traceId } = result;
  clearTimeout(saveTimer);
  controller = null;
  setBusy(false);
  input.placeholder = agentMode ? "Tell Sidekick what to do on this page" : "Ask anything";
  Object.assign(msg, { text: summary, agentSteps: steps, ...(plan && { agentPlan: plan }), ...(traceId && { traceId }) });
  if (state === "done") delete msg.stopped;
  saveChat().catch(e => console.warn("Couldn't save chat", e));
  refreshNotes(chat, chat.messages[chat.messages.length - 2], summary);
  autoScroll();
  input.focus();
  return result;
}
try {
  chrome.notifications?.onClicked?.addListener(async id => {
    if (!notifyIds.has(id)) return;
    clearNotice(id);
    const win = await chrome.windows?.getCurrent?.().catch(() => null);
    if (win) chrome.windows.update(win.id!, { focused: true }).catch(() => {});
  });
} catch {}

// ---------- reading aloud ----------

export function plainForSpeech(md: any) {
  return String(md)
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/\$\$[\s\S]*?\$\$/g, " (equation) ")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

export const speakingToggle = false;
export function speak(text: any, toggle = false) {
  if (!("speechSynthesis" in window)) return;
  if (toggle && speechSynthesis.speaking) { stopSpeaking(); return; }
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(plainForSpeech(text).slice(0, 4000));
  const voices = speechSynthesis.getVoices();
  const lang = navigator.language || "en-US";
  u.voice = voices.find(v => v.lang === lang && /Daniel|Samantha|Google|Natural|Premium|Enhanced/i.test(v.name)) || voices.find(v => v.lang === lang) || null;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}
export function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- voice input ----------
// Uses Chrome's built-in speech recognition. The side panel can't show the microphone
// permission prompt itself, so the first time it opens a small tab that asks for it.

export const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export let recognizer = null;
export let listening = false;

export function setListening(v: any) {
  listening = v;
  $("#micBtn").setAttribute("aria-pressed", String(v));
  $("#micBtn").classList.toggle("listening", v);
  $("#micBtn").title = v ? "Stop dictating" : "Dictate";
}

export function stopDictation() {
  (recognizer as any)?.stop();
  setListening(false);
}

export function startDictation() {
  if (!Recognition) return addError("Voice input isn't available in this browser.");
  const base = input.value.trim();
  recognizer = new Recognition();
  (recognizer! as any).lang = navigator.language || "en-US";
  (recognizer! as any).continuous = true;
  (recognizer! as any).interimResults = true;
  (recognizer! as any).onresult = (e: any) => {
    lastInputWasVoice = true;
    let said = "";
    for (const r of e.results) said += r[0].transcript;
    input.value = (base ? base + " " : "") + said.trim();
    resizeInput();
    refreshSend();
  };
  (recognizer! as any).onerror = (e: any) => {
    setListening(false);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
      addError("Sidekick needs microphone access. Click Allow in the tab that just opened, then press the mic again.");
    } else if (e.error === "no-speech") {
      // Silence; nothing to report.
    } else if (e.error !== "aborted") {
      addError(`Voice input stopped: ${e.error}.`);
    }
  };
  (recognizer! as any).onend = () => setListening(false);
  (recognizer! as any).start();
  setListening(true);
  input.focus();
}

if (!Recognition) $("#micBtn").classList.add("hidden");

// ---------- drag and drop, paste ----------

export let dragDepth = 0;
export const hasFiles = (e: any) => [...(e.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragenter", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("#dropZone").classList.remove("hidden");
});
document.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("dragleave", e => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $("#dropZone").classList.add("hidden"); }
});
document.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dropZone").classList.add("hidden");
  addFiles([...e.dataTransfer!.files]);
});
input.addEventListener("paste", (e: any) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return; // plain text paste works as usual
  e.preventDefault();
  addFiles(files);
});

// ---------- context-menu hand-off ----------

export async function checkPending() {
  const { pending } = await chrome.storage.session.get("pending");
  if (!pending || Date.now() - (pending as any).ts > 15000) return;
  await chrome.storage.session.remove("pending");
  if ((pending as any).text) addAttachment({ kind: "selection", text: (pending as any).text });
  if ((pending as any).mode === "rewrite") runAction("rewrite");
  else input.focus();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pending?.newValue) checkPending();
  if (area === "session" && changes.benchPending?.newValue) checkBenchPending().catch(err => addError(`Benchmark: ${err.message}`));
  if (area === "session" && changes.jobBatch?.newValue) checkJobBatch().catch(err => addError(`Applications: ${err.message}`));
  if (area === "local" && Object.keys(changes).some(k => !k.startsWith("chat"))) updateBadge();
});

// ---------- wiring ----------

sendBtn.onclick = () => (busy && !(agentRun as any)?.answer ? stop() : send(input.value));
input.addEventListener("input", () => { resizeInput(); refreshSend(); });
input.addEventListener("keydown", (e: any) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy || (agentRun as any)?.answer) send(input.value);
  }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (drawerOpen) setDrawer(false);
  else if (busy) stop();
  else if (listening) stopDictation();
});
document.querySelectorAll(".chip").forEach(b => ((b as any).onclick = () => runAction((b as any).dataset.action)));
$("#attachBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = (e: any) => { addFiles([...e.target.files]); e.target.value = ""; };
$("#grab").onclick = () => tryTool(() => attachSelection());
$("#pageBtn").onclick = () => tryTool(attachPage);
$("#regionBtn").onclick = () => tryTool(captureRegion);
$("#screenToggle").onclick = (e: any) => {
  includeScreen = !includeScreen;
  e.currentTarget.setAttribute("aria-pressed", String(includeScreen));
};
$("#micBtn").onclick = () => (listening ? stopDictation() : startDictation());
$("#settings").onclick = () => chrome.runtime.openOptionsPage();
$("#profileBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") });
$("#agentToggle").onclick = () => setAgentMode(!agentMode);
$("#modelBadge").onclick = cycleMode;
$("#clear").onclick = startNewChat;
$("#historyBtn").onclick = () => setDrawer(!drawerOpen);
$("#pinBtn").onclick = (e: any) => { e.stopPropagation(); togglePin(); };
document.addEventListener("click", e => { if (!(e.target as any).closest("#pinPop, #pinBtn")) togglePin(false); });
$("#drawerClose").onclick = () => setDrawer(false);
$("#drawerScrim").onclick = () => setDrawer(false);
$("#chatSearch").addEventListener("input", renderChatList);

// ---------- start ----------

(async () => {
  showEmpty();
  updateBadge();
  refreshSend();
  // Reopen the chat you were in if the panel was closed and reopened (same browser session).
  // Every time Sidekick opens (or reloads after an update) it starts a new chat. The last one is
  // already saved in history (open it from the menu) and gets its end-of-chat review below.
  await checkPending();
  checkBenchPending().catch(err => addError(`Benchmark: ${err.message}`));
  checkJobBatch().catch(err => addError(`Applications: ${err.message}`));
  setTimeout(() => reflectStaleChats().catch(() => {}), 1500);
  input.focus();
})();
