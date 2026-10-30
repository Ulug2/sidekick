import { pickRegionInPage } from "../../page/region.js";
import { pageReplaceSelection } from "../../page/replace-selection.js";
import { getSettings, modelFor } from "../../core/llm/ai.js";
import { extractDocText, isDocFile } from "../../core/docs/docs.js";
import { redactSecrets, stripWrappers, untrusted } from "../../core/security/guard.js";
import { deleteMemory } from "../../assistant/memory/memory.js";
import { getProfile, profileIsEmpty } from "../../assistant/profile-core.js";
import { activeTab, captureScreen, readPageText, readSelectionFromPage, runInPage } from "../../core/browser/screen.js";
import { reflectOnChat, updateSessionNotes } from "../../assistant/session.js";
import { readLocal, type Chat, type ChatIndexEntry, type ChatMessage } from "../../core/storage/schema.js";
import type { Tier } from "../../core/llm/ai.js";
import { runAgent } from "../../agent/loop/run.js";
import type { AgentUI, PlanItem } from "../../agent/types.js";
import { FAST_ONLY } from "../../assistant/routing.js";
import { runTurn } from "../../assistant/turn.js";

// UI lookups return `any`: the elements are known from the page's own HTML, not checked here.
export const $ = (sel: string): any => document.querySelector(sel);
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
export let agentRun: { el: HTMLElement; approve?: ((ok: boolean) => void) | null; answer?: ((text: string) => void) | null } | null = null;       // the running agent: { answer?: fn, approve?: fn, el }
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

export const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="12" rx="9" ry="4.2"/><ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(120 12 12)"/></g></svg>`;
export const ICON: Record<string, string> = {
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  replace: `<svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>`,
  alert: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>`,
  x: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`,
  selection: `<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7"/></svg>`,
  page: `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>`,
  file: `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>`,
  agent: `<svg viewBox="0 0 24 24"><path d="M5 3l14 7-6 2-2 6Z"/><path d="M13 12l6 6"/></svg>`,
  retry: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`,
  speak: `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`,
  info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>`,
  link: `<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  calc: `<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>`,
  brain: `<svg viewBox="0 0 24 24"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4Z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`
};

export const escapeHtml = (s: any) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

// ---------- markdown ----------

marked.use({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// ---------- math ----------
// Markdown would mangle LaTeX (it eats the backslash in \( and treats _ as italics), so math
// is swapped for placeholders before parsing and rendered with KaTeX afterwards.
// Supports $$…$$ and \[…\] (display) and \(…\) and $…$ (inline). Code is left alone.
export const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/g;

export function extractMath(text: any) {
  const math: { tex: string; display: boolean }[] = [];
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/); // odd indexes are code
  const out = parts
    .map((part: any, i: any) =>
      i % 2
        ? part
        : part.replace(MATH_RE, (_: any, d1: any, d2: any, i1: any, i2: any) => {
            math.push({ tex: d1 ?? d2 ?? i1 ?? i2, display: d1 != null || d2 != null });
            return `KTXMATH${math.length - 1}KTX`;
          })
    )
    .join("");
  return { text: out, math };
}

export function renderTex({ tex, display }: { tex: string; display: boolean }) {
  try {
    const html = katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
    return display ? `<span class="math-display">${html}</span>` : html;
  } catch {
    return escapeHtml(tex);
  }
}

// Model output can contain HTML (or a web page can trick the model into writing some),
// so everything is sanitized before it touches the DOM. KaTeX and highlight.js output is
// added after sanitizing; both escape their input, so they can't inject markup.
// Nothing in a reply may load anything from the network by itself: a web page could trick the
// model into writing an image or style whose URL carries your data out (zero-click leak). So
// images become plain links, and tags/attributes that fetch things are removed. Links open in
// a new tab (never inside the panel) and only http(s)/mailto links are kept.
export const NO_FETCH_TAGS = ["style", "form", "input", "button", "textarea", "select", "img", "picture", "source", "video", "audio", "track", "iframe", "frame", "object", "embed", "svg", "math", "link", "meta", "base", "image"];
export const NO_FETCH_ATTRS = ["style", "srcset", "src", "background", "poster", "action", "formaction", "xlink:href", "ping"];
export function renderMarkdown(el: any, text: any) {
  const { text: mdText0, math } = extractMath(stripWrappers(text));
  const mdText = mdText0.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_: any, alt: any, url: any) => `[🖼 ${alt || "image"}](${url})`);
  const safe = DOMPurify.sanitize(marked.parse(mdText), { FORBID_TAGS: NO_FETCH_TAGS, FORBID_ATTR: NO_FETCH_ATTRS });
  el.innerHTML = math.length ? safe.replace(/KTXMATH(\d+)KTX/g, (_, i) => renderTex(math[+i])) : safe;

  el.querySelectorAll("a").forEach((a: any) => {
    const href = a.getAttribute("href") || "";
    if (!/^(https?:|mailto:)/i.test(href)) { a.replaceWith(...a.childNodes); return; }
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });

  el.querySelectorAll("table").forEach((t: any) => {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });

  el.querySelectorAll("pre").forEach((pre: any) => {
    const code = pre.querySelector("code");
    const lang = (code?.className.match(/language-([\w+#.-]+)/) || [])[1] || "";
    if (lang === "setup") { pre.replaceWith(setupBlock(code.textContent)); return; }
    if (code && lang && window.hljs?.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
      code.classList.add("hljs");
    }
    const block = document.createElement("div");
    block.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const label = document.createElement("span");
    label.textContent = lang || "code";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.innerHTML = `${ICON.copy}<span>Copy</span>`;
    head.append(label, btn);
    pre.replaceWith(block);
    block.append(head, pre);
  });
}

// The model's setup for a math problem (variables, objective, constraints, answer), collapsed,
// so a misread problem is easy to spot even when you asked for just the answer.
export function setupBlock(text: any) {
  const d = document.createElement("details");
  d.className = "setup-block";
  const sum = document.createElement("summary");
  sum.textContent = "How I set it up";
  d.appendChild(sum);
  const body = document.createElement("div");
  body.className = "setup-body";
  for (const line of String(text).trim().split("\n")) {
    const row = document.createElement("div");
    row.className = "setup-row";
    const m = line.match(/^\s*(\w+)\s*:\s*(.*)$/);
    if (m) {
      const k = document.createElement("span");
      k.className = "setup-key";
      k.textContent = m[1];
      const v = document.createElement("span");
      v.className = "setup-val";
      v.textContent = m[2];
      row.append(k, v);
    } else row.textContent = line;
    body.appendChild(row);
  }
  d.appendChild(body);
  return d;
}

// What the double-check changed, shown next to the answer instead of silently swapping it:
// a corrected answer is labeled, with the original kept (collapsed) underneath; when the
// solves still disagree, the other answers are listed with a warning.
export function renderReview(aiEl: any, review: any) {
  if (!review) return;
  const md = aiEl.querySelector(":scope > .md");
  aiEl.querySelectorAll(":scope > .review-label, :scope > .review-box").forEach((n: any) => n.remove());
  const collapsed = (title: any, text: any) => {
    const d = document.createElement("details");
    d.className = "review-alt";
    const sum = document.createElement("summary");
    sum.textContent = title;
    const body = document.createElement("div");
    body.className = "md";
    renderMarkdown(body, text || "_(empty)_");
    d.append(sum, body);
    return d;
  };
  if (review.kind === "corrected") {
    const label = document.createElement("div");
    label.className = "review-label";
    label.innerHTML = `${ICON.check}<span></span>`;
    label.querySelector("span")!.textContent = "Correction after double-check";
    if (review.reason) label.title = review.reason;
    md.before(label);
    const box = document.createElement("div");
    box.className = "review-box";
    if (review.evidence || review.reason) {
      const why = document.createElement("div");
      why.className = "review-why";
      why.textContent = review.reason && review.evidence && review.evidence !== review.reason ? `${review.reason} (${review.evidence})` : review.reason || review.evidence;
      box.appendChild(why);
    }
    box.appendChild(collapsed("Original answer (replaced)", review.original));
    md.after(box);
  } else if (review.kind === "conflict") {
    const box = document.createElement("div");
    box.className = "review-box conflict";
    const head = document.createElement("div");
    head.className = "review-warn";
    head.innerHTML = `${ICON.alert}<span></span>`;
    head.querySelector("span")!.textContent = "Two solves disagree. Compare before you submit.";
    box.appendChild(head);
    if (review.reason) {
      const why = document.createElement("div");
      why.className = "review-why";
      why.textContent = review.reason;
      box.appendChild(why);
    }
    for (const alt of review.alternatives || []) box.appendChild(collapsed(alt.label, alt.text));
    md.after(box);
  }
}

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

// ---------- chat storage ----------
// Chats live in chrome.storage.local: an index ("chatIndex") plus one key per chat.

export function newChat(): Chat {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: "", createdAt: now, updatedAt: now, messages: [] };
}

export async function loadIndex(): Promise<ChatIndexEntry[]> {
  const { chatIndex = [] } = await readLocal("chatIndex");
  return chatIndex;
}

export async function saveChat(c = chat) {
  if (!c.messages.length) return;
  c.updatedAt = Date.now();
  if (!c.title) {
    const first = c.messages.find(m => (m as any).role === "user");
    c.title = ((first as any)?.display?.prompt || "New chat").replace(/\s+/g, " ").slice(0, 60);
  }
  let index = (await loadIndex()).filter((x: any) => x.id !== c.id);
  index.unshift({ id: c.id, title: c.title, updatedAt: c.updatedAt });
  const dropped = index.slice(MAX_CHATS);
  index = index.slice(0, MAX_CHATS);
  await chrome.storage.local.set({ chatIndex: index, ["chat:" + c.id]: c });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((x: any) => "chat:" + x.id));
  if (drawerOpen) renderChatList();
}

// Updates a stored chat's fields without moving it in the history list.
export async function patchStoredChat(id: any, fields: any) {
  const key = "chat:" + id;
  const data = await chrome.storage.local.get(key);
  if (data[key]) await chrome.storage.local.set({ [key]: { ...data[key], ...fields } });
}

// ---------- session memory ----------
// Pinned notes are refreshed in the background after each reply (one cheap call), and the
// next message waits for them, so instructions are never missed.

export const notesPending = new Map(); // chat id → promise

export function refreshNotes(c: any, userMsg: any, replyText: any) {
  const prompt = userMsg?.display?.prompt || userMsg?.text || "";
  if (!prompt.trim() || FAST_ONLY.test(prompt.trim())) return;
  const prev = notesPending.get(c.id) || Promise.resolve();
  const p = prev.then(async () => {
    const s = await getSettings();
    const profile = await getProfile();
    const userName = (profile.preferredName || profile.fullName || "").split(/\s+/)[0] || "the user";
    try {
      c.notes = await updateSessionNotes({ notes: c.notes || [], userText: userMsg.text, replyText, userName });
      if (c === chat) renderPin();
      if (c.messages.length) {
        if (c === chat) await saveChat(c);
        else await patchStoredChat(c.id, { notes: c.notes });
      }
    } catch (err: any) {
      console.warn("Couldn't update pinned notes", err);
    }
  });
  notesPending.set(c.id, p);
  p.finally(() => { if (notesPending.get(c.id) === p) notesPending.delete(c.id); });
}

export async function waitForNotes(c: any) {
  const p = notesPending.get(c.id);
  if (p) await Promise.race([p, new Promise(r => setTimeout(r, 6000))]);
}

// When a chat ends, keep what matters about you long-term (in the background).
export const reflecting = new Set();
export async function reflectChat(c: any, { quiet = false } = {}) {
  if (!c?.messages?.length || reflecting.has(c.id)) return;
  const s = await getSettings();
  if (!s.memoryAuto) return;
  if ((c.reflectedUpTo || 0) >= c.messages.length) return;
  reflecting.add(c.id);
  try {
    await waitForNotes(c);
    const profile = await getProfile();
    const userName = (profile.preferredName || profile.fullName || "").split(/\s+/)[0] || "the user";
    const r = await reflectOnChat(c, { userName });
    c.reflectedUpTo = c.messages.length;
    await patchStoredChat(c.id, { reflectedUpTo: c.reflectedUpTo, notes: c.notes || [] });
    const n = r ? r.added.length + r.updated.length : 0;
    const sk = r?.skills || [];
    if (!quiet && r && (n || r.aboutChanged || sk.length)) {
      const what = [...r.added, ...r.updated].slice(0, 2).map(t => `“${t}”`).join(", ");
      const skillText = sk.length ? `${sk[0].op === "created" ? "Learned a new skill" : "Improved a skill"}: “${sk[0].name}”${sk.length > 1 ? " and 1 more" : ""}.` : "";
      const memText = n ? `Learned ${n} thing${n > 1 ? "s" : ""} about you: ${what}${n > 2 ? "…" : ""}` : r.aboutChanged ? "Updated how I work with you." : "";
      showToast([memText, skillText].filter(Boolean).join(" "), {
        label: "Review", onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL(`profile.html#${sk.length && !n ? "sec-skills" : "sec-memories"}`) })
      });
    }
  } catch (err: any) {
    console.warn("Couldn't review chat", err);
  } finally {
    reflecting.delete(c.id);
  }
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

// Chats that ended without a review (e.g. Chrome was closed) are reviewed on next start.
export async function reflectStaleChats() {
  const index = (await loadIndex()).slice(0, 5);
  const idle = 30 * 60 * 1000;
  for (const entry of index) {
    if (entry.id === chat.id && Date.now() - entry.updatedAt < idle) continue;
    const data = await chrome.storage.local.get("chat:" + entry.id);
    const c = data["chat:" + entry.id];
    if (c && ((c as any).reflectedUpTo || 0) < (c as any).messages.length) await reflectChat(c, { quiet: true });
  }
}

// ---------- pinned notes UI ----------

export function renderPin() {
  const n = (chat.notes || []).length;
  const btn = $("#pinBtn");
  btn.classList.toggle("hidden", !n);
  btn.querySelector(".pin-count").textContent = n;
  btn.title = `${n} pinned note${n === 1 ? "" : "s"} for this chat`;
  if (!$("#pinPop").classList.contains("hidden")) renderPinList();
}

export function renderPinList() {
  const ul = $("#pinList");
  ul.innerHTML = "";
  for (const [i, note] of (chat.notes || []).entries()) {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><button type="button" class="mini-x" aria-label="Remove note">${ICON.x}</button>`;
    li.firstChild!.textContent = note;
    li.querySelector("button")!.onclick = () => {
      chat.notes!.splice(i, 1);
      saveChat().catch(() => {});
      renderPin();
      renderPinList();
    };
    ul.appendChild(li);
  }
}

export function togglePin(open?: boolean) {
  const pop = $("#pinPop");
  const show = open ?? pop.classList.contains("hidden");
  pop.classList.toggle("hidden", !show);
  if (show) renderPinList();
}

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
      run.finish((m as any).stopped ? "stopped" : "done", (m as any).text);
    } else {
      const ai = addAiMessage();
      restoreThoughts(ai, (m as any).thoughts);
      for (const run of (m as any).agentRuns || []) {
        const card = addAgentRun(ai.el);
        for (const t of run.steps) card.addStep(t).done(true);
        card.finish(run.state, "");
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

export async function deleteChat(id: any) {
  const index = (await loadIndex()).filter((c: any) => c.id !== id);
  await chrome.storage.local.set({ chatIndex: index });
  await chrome.storage.local.remove("chat:" + id);
  if (chat.id === id) startNewChat();
  renderChatList();
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

// ---------- history drawer ----------

export let drawerOpen = false;

export function setDrawer(open: any) {
  drawerOpen = open;
  $("#drawer").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
  $("#drawerScrim").classList.toggle("hidden", !open);
  if (open) {
    $("#chatSearch").value = "";
    renderChatList();
    $("#chatSearch").focus();
  }
}

export async function renderChatList() {
  const list = $("#chatList");
  const q = $("#chatSearch").value.trim().toLowerCase();
  const index = (await loadIndex()).filter((c: any) => !q || c.title.toLowerCase().includes(q));
  list.innerHTML = "";
  if (!index.length) {
    list.innerHTML = `<p class="chat-empty">${q ? "No matching chats." : "No saved chats yet."}</p>`;
    return;
  }
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const DAY = 86_400_000;
  const groupOf = (t: any) =>
    t >= startOfToday ? "Today" : t >= startOfToday - DAY ? "Yesterday" : t >= startOfToday - 7 * DAY ? "Previous 7 days" : "Older";
  let lastGroup = "";
  for (const c of index) {
    const g = groupOf(c.updatedAt);
    if (g !== lastGroup) {
      const h = document.createElement("div");
      h.className = "chat-group";
      h.textContent = g;
      list.appendChild(h);
      lastGroup = g;
    }
    const row = document.createElement("div");
    row.className = "chat-row" + (c.id === chat.id ? " current" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "chat-open";
    open.textContent = c.title || "Untitled";
    open.onclick = () => { openChat(c.id); setDrawer(false); };
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.title = "Delete chat";
    del.setAttribute("aria-label", "Delete chat");
    del.innerHTML = ICON.trash;
    del.onclick = () => deleteChat(c.id);
    row.append(open, del);
    list.appendChild(row);
  }
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

// Copy buttons on code blocks (delegated, since blocks are re-rendered while streaming).
messagesEl.addEventListener("click", async (e: any) => {
  const btn = e.target.closest(".code-copy");
  if (!btn) return;
  const code = btn.closest(".code-block").querySelector("pre").textContent;
  await navigator.clipboard.writeText(code);
  btn.innerHTML = `${ICON.check}<span>Copied</span>`;
  setTimeout(() => (btn.innerHTML = `${ICON.copy}<span>Copy</span>`), 1400);
});

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

export async function send(prompt: any, { forceScreen = false, quickAction, tier, retryOf }: { forceScreen?: boolean; quickAction?: string; tier?: Tier; retryOf?: ChatMessage } = {}) {
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
        agentRuns.push({ steps: r.steps, state: r.state });
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

// ---------- agent mode ----------

export const STEP_ICON: Record<string, string> = {
  running: `<span class="spin"></span>`,
  waiting: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  ok: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  fail: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`
};

// The live card for one agent run: a header, the list of steps, and the final summary.
export function addAgentRun(parent?: HTMLElement) {
  clearEmpty();
  const el = document.createElement("div");
  el.className = parent ? "agent-run nested" : "msg ai agent-run";
  el.innerHTML = `
    <div class="agent-head">${LOGO}<span class="agent-status">Working…</span><span class="spacer"></span>
      <button type="button" class="agent-stop">Stop</button></div>
    <div class="agent-think" aria-live="polite"></div>
    <ol class="agent-plan" hidden></ol>
    <ol class="agent-steps"></ol>
    <div class="md"></div>`;
  if (parent) parent.insertBefore(el, parent.querySelector(":scope > .md"));
  else messagesEl.appendChild(el);
  const list = el.querySelector(".agent-steps");
  (el.querySelector(".agent-stop") as any).onclick = stop;

  const statusEl = el.querySelector(".agent-status");
  const thinkEl = el.querySelector(".agent-think");
  let thought = "";
  const addStep = (text: any) => {
    text = String(text || "").trim() || "Working";
    statusEl!.textContent = `Working: ${text}`;
    thought = "";
    thinkEl!.textContent = "";
    const li = document.createElement("li");
    li.className = "step running";
    li.innerHTML = `<span class="st-icon">${STEP_ICON.running}</span><span class="st-body"><span class="st-text"></span><span class="st-detail"></span></span>`;
    li.querySelector(".st-text")!.textContent = text;
    list!.appendChild(li);
    autoScroll();
    const setState = (cls: any, icon: any) => { li.className = "step " + cls; li.querySelector(".st-icon")!.innerHTML = icon; };
    return {
      waiting: () => setState("waiting", STEP_ICON.waiting),
      done: (ok: any, detail?: any) => {
        setState(ok ? "ok" : "fail", ok ? STEP_ICON.ok : STEP_ICON.fail);
        if (detail) li.querySelector(".st-detail")!.textContent = detail;
      }
    };
  };

  const planEl = el.querySelector(".agent-plan");
  let planItems = null;
  const PLAN_LABEL: Record<string, string> = { todo: "To do", doing: "Working on it", done: "Done", failed: "Couldn't do it", skipped: "Skipped" };
  return {
    el,
    addStep,
    // The checklist for multi-part tasks ("apply to these 4 jobs").
    plan(items: any) {
      planItems = items;
      (planEl as any).hidden = false;
      planEl!.innerHTML = "";
      for (const it of items) {
        const li = document.createElement("li");
        li.className = "plan-item " + it.status;
        li.innerHTML = `<span class="pi-mark" aria-hidden="true"></span><span class="pi-text"></span><span class="pi-note"></span>`;
        li.querySelector(".pi-mark")!.textContent = ({ todo: "○", doing: "→", done: "✓", failed: "✗", skipped: "–" } as Record<string, string>)[it.status] || "○";
        li.querySelector(".pi-text")!.textContent = it.text;
        li.querySelector(".pi-note")!.textContent = it.note ? ` · ${it.note}` : "";
        li.title = PLAN_LABEL[it.status] || "";
        planEl!.appendChild(li);
      }
      const finished = items.filter((x: any) => !["todo", "doing"].includes(x.status)).length;
      if (!el.classList.contains("finished")) statusEl!.textContent = `Working: ${finished} of ${items.length} done`;
    },
    // The agent's latest thought, one line, while it decides the next step.
    think(chunk: any) {
      if (el.classList.contains("finished")) return;
      statusEl!.textContent = "Working: thinking";
      thought += chunk.replace(/\*\*/g, "");
      const line = thought.trim().split(/\n+/).pop();
      thinkEl!.textContent = line!.length > 140 ? "…" + line!.slice(-138) : line as string;
    },
    note(text: any) {
      const li = document.createElement("li");
      li.className = "step note";
      li.textContent = text;
      list!.appendChild(li);
      autoScroll();
    },
    // A card inside the run with the given content and buttons; resolves with the clicked value.
    card(className: any, build: any) {
      const card = document.createElement("div");
      card.className = "agent-card " + className;
      el.insertBefore(card, el.querySelector(":scope > .md")); // the run's own summary area, not a card's
      build(card);
      autoScroll();
      return card;
    },
    finish(state: any, summary: any) {
      el.classList.add("finished");
      thinkEl!.remove();
      el.querySelector(".agent-status")!.textContent = state === "done" ? "Done" : state === "stopped" ? "Stopped" : "Couldn't finish";
      el.querySelector(".agent-stop")!.remove();
      el.querySelectorAll(".step.running, .step.waiting").forEach(li => {
        li.className = "step fail";
        li.querySelector(".st-icon")!.innerHTML = STEP_ICON.fail;
      });
      if (summary) renderMarkdown(el.querySelector(":scope > .md"), summary);
      // Collapse long step lists once finished.
      const steps = el.querySelectorAll(".step:not(.note)");
      if (steps.length > 6) {
        el.classList.add("collapsed");
        const t = document.createElement("button");
        t.type = "button";
        t.className = "steps-toggle";
        t.textContent = `Show all ${steps.length} steps`;
        t.onclick = () => {
          const c = el.classList.toggle("collapsed");
          t.textContent = c ? `Show all ${steps.length} steps` : "Hide steps";
        };
        el.querySelector(".agent-head")!.after(t);
      }
    }
  };
}

export async function sendAgent(goal: any) {
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
  const { summary, steps, state, plan } = await runAgentCard(fullGoal, undefined, { history, progress, userMessages });
  clearTimeout(saveTimer);
  controller = null;
  setBusy(false);
  input.placeholder = agentMode ? "Tell Sidekick what to do on this page" : "Ask anything";
  Object.assign(msg, { text: summary, agentSteps: steps, ...(plan && { agentPlan: plan }) });
  if (state === "done") delete msg.stopped;
  saveChat().catch(e => console.warn("Couldn't save chat", e));
  refreshNotes(chat, chat.messages[chat.messages.length - 2], summary);
  autoScroll();
  input.focus();
}

// ---------- notifications ----------
// While the agent works you're often in another tab or app. When it needs you or finishes, a
// Chrome notification says so (only when the panel isn't what you're looking at).
export const notifyIds = new Set();
export async function notifyUser(kind: any, title: any, message: any) {
  try {
    if (!chrome.notifications?.create) return null;
    const s = await getSettings();
    if (s.notifyAgent === false) return null;
    if (document.visibilityState === "visible" && document.hasFocus()) return null;
    const id = `sk-${kind}-${Date.now()}`;
    await chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message: String(message || "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").slice(0, 240), priority: kind === "done" ? 0 : 2, requireInteraction: kind !== "done" });
    notifyIds.add(id);
    return id;
  } catch { return null; }
}
export function clearNotice(id: any) { if (id) { chrome.notifications?.clear?.(id); notifyIds.delete(id); } }
try {
  chrome.notifications?.onClicked?.addListener(async id => {
    if (!notifyIds.has(id)) return;
    clearNotice(id);
    const win = await chrome.windows?.getCurrent?.().catch(() => null);
    if (win) chrome.windows.update(win.id!, { focused: true }).catch(() => {});
  });
} catch {}

export const INTERRUPTED = "Interrupted: Sidekick was closed or reloaded before this finished. The steps above were done; the page may be part-way through.";

// The chat so far, for the agent: follow-ups ("apply for the backend one", "you know which
// position") only make sense with it. Recent messages, shortened; replies may quote web pages,
// so the whole thing is fenced as data.
export function agentHistory(messages: any, notes: string[] = []) {
  const lines = [];
  for (const m of messages.slice(-12)) {
    if (m.role === "user") lines.push(`User: ${String(m.display?.prompt ?? m.text ?? "").slice(0, 600)}`);
    else {
      let t = String(m.text || "").replace(/```setup[\s\S]*?```/g, "").trim();
      if (t === INTERRUPTED) t = "(this task was interrupted)";
      const steps = m.agentSteps?.length ? `\n  Steps taken: ${m.agentSteps.slice(-15).join("; ")}` : "";
      lines.push(`Sidekick: ${t.slice(0, 1500)}${steps}`);
    }
  }
  if (!lines.length && !notes.length) return "";
  const pinned = notes.length ? `Pinned notes for this chat:\n${notes.map(n => `- ${n}`).join("\n")}\n\n` : "";
  return untrusted("earlier messages in this chat", pinned + lines.join("\n"));
}

// Runs the browser agent with a live card. Used by Agent mode and by the chat's
// operate_browser tool (then the card sits inside the chat reply). Returns { summary, steps, state, plan }.
// opts: { history, progress(partial) } — progress gets the steps and checklist as they change.
export async function runAgentCard(goal: string, parent?: HTMLElement, opts: { history?: string; userMessages?: string[]; progress?: (p: Record<string, unknown>) => void } = {}) {
  const run = addAgentRun(parent);
  const signal = (controller! as any).signal;
  agentRun = { el: run.el };
  const liveSteps: string[] = [];
  let livePlan: PlanItem[] | null = null;

  // Pending approval/answer promises are rejected when you press Stop.
  const onAbort = (reject: any) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });

  const ui: AgentUI = {
    signal,
    step: (text: any) => {
      liveSteps.push(text);
      (opts as any).progress?.({ agentSteps: [...liveSteps], ...(livePlan && { agentPlan: livePlan }) });
      return run.addStep(text);
    },
    note: (text: any) => run.note(text),
    thinking: (chunk: any) => run.think(chunk),
    plan: (items: any) => {
      livePlan = items;
      run.plan(items);
      (opts as any).progress?.({ agentSteps: [...liveSteps], agentPlan: items });
    },
    approve: ({ title, detail }) => new Promise<boolean>((resolve, reject) => {
      onAbort(reject);
      const notice = notifyUser("approve", "Sidekick needs your OK", title);
      const resolveWas = resolve;
      resolve = v => { notice.then(clearNotice); resolveWas(v); };
      const card = run.card("approve", (c: any) => {
        c.innerHTML = `<div class="ac-label">Approve this action?</div><div class="ac-title"></div><div class="ac-detail md"></div>
          <div class="ac-buttons"><button type="button" class="ac-deny">Don't do it</button><button type="button" class="ac-allow">Allow</button></div>`;
        c.querySelector(".ac-title").textContent = title;
        if (detail) renderMarkdown(c.querySelector(".ac-detail"), detail);
        else c.querySelector(".ac-detail").remove();
      });
      const answer = (ok: any) => {
        card.classList.add("answered", ok ? "allowed" : "denied");
        card.querySelector(".ac-buttons")!.innerHTML = `<span class="ac-result">${ok ? "Allowed" : "Declined"}</span>`;
        if (agentRun) (agentRun as any).approve = null;
        resolve(ok);
      };
      (card.querySelector(".ac-allow") as any).onclick = () => answer(true);
      (card.querySelector(".ac-deny") as any).onclick = () => answer(false);
      (agentRun! as any).approve = answer;
      (card.querySelector(".ac-allow") as any).focus();
    }),
    approvePlan: ({ items, sites }) => new Promise<{ ok: boolean; autoSubmit?: boolean }>((resolve, reject) => {
      onAbort(reject);
      const notice = notifyUser("approve", "Sidekick has a plan for you to approve", `${items.length} tasks on ${sites.join(", ")}`);
      const card = run.card("approve plan-card", (c: any) => {
        c.innerHTML = `<div class="ac-label">Approve the plan?</div><ol class="pc-items"></ol>
          <div class="pc-sites"><span class="pc-k">Sites</span> <span class="pc-v"></span></div>
          <label class="pc-auto"><input type="checkbox"> <span>Also submit each one without asking me (never for payments, deleting or posting)</span></label>
          <div class="ac-hint">Approving lets Sidekick work through these without stopping for every step. Going to any other site still asks.</div>
          <div class="ac-buttons"><button type="button" class="ac-deny">Change it</button><button type="button" class="ac-allow">Approve plan</button></div>`;
        for (const it of items) { const li = document.createElement("li"); li.textContent = it; c.querySelector(".pc-items").appendChild(li); }
        c.querySelector(".pc-v").textContent = sites.join(", ") || "this site";
      });
      const answer = (ok: any) => {
        const auto = ok && (card.querySelector(".pc-auto input") as any).checked;
        card.classList.add("answered", ok ? "allowed" : "denied");
        card.querySelector(".pc-auto")!.remove();
        card.querySelector(".ac-buttons")!.innerHTML = `<span class="ac-result">${ok ? (auto ? "Approved · submits without asking" : "Approved") : "You asked for changes"}</span>`;
        if (agentRun) (agentRun as any).approve = null;
        notice.then(clearNotice);
        resolve({ ok, autoSubmit: auto });
      };
      (card.querySelector(".ac-allow") as any).onclick = () => answer(true);
      (card.querySelector(".ac-deny") as any).onclick = () => answer(false);
      (agentRun! as any).approve = answer;
      (card.querySelector(".ac-allow") as any).focus();
    }),
    ask: (question: any) => new Promise((resolve, reject) => {
      onAbort(reject);
      const notice = notifyUser("ask", "Sidekick has a question", question);
      const resolveWas = resolve;
      resolve = v => { notice.then(clearNotice); resolveWas(v); };
      const card = run.card("question", (c: any) => {
        c.innerHTML = `<div class="ac-label">Needs your input</div><div class="md"></div><div class="ac-hint">Reply in the box below.</div>`;
        renderMarkdown(c.querySelector(".md"), question);
      });
      input.placeholder = "Reply here";
      (agentRun! as any).answer = (text: any) => {
        card.classList.add("answered");
        card.querySelector(".ac-hint")!.textContent = `You: ${text}`;
        (agentRun! as any).answer = null;
        input.value = "";
        resizeInput();
        input.placeholder = agentMode ? "Tell Sidekick what to do on this page" : "Ask anything";
        refreshSend();
        resolve(text);
      };
      refreshSend();
      input.focus();
    })
  };

  let summary, steps = [], state = "done", plan = null;
  try {
    const result = await runAgent(goal, ui, { history: opts.history, userMessages: opts.userMessages });
    summary = result.summary;
    steps = result.steps;
    plan = result.plan || null;
    // What Sidekick learned from this run, so you know why the next one is faster.
    const l = result.learned;
    if (l?.shortcut) run.note(`Saved a shortcut for ${l.shortcut.site}: next time ${l.shortcut.automatic} of ${l.shortcut.steps} steps run instantly. Manage it on your profile page (Site skills).`);
    if (l?.notes?.length) run.note(`Learned ${l.notes.length} note${l.notes.length > 1 ? "s" : ""} about this site for next time.`);
  } catch (err: any) {
    if (err.name === "AbortError") {
      state = "stopped";
      summary = "Stopped. The page is left as it was; nothing else was submitted.";
    } else {
      state = "failed";
      summary = `Something went wrong: ${err.message}`;
    }
    steps = [...run.el.querySelectorAll(".step:not(.note) .st-text")].map(e => e.textContent);
    plan = livePlan;
  } finally {
    agentRun = null;
    refreshSend();
  }
  run.finish(state, parent ? "" : summary);
  notifyUser("done", state === "done" ? "Sidekick finished" : state === "stopped" ? "Sidekick stopped" : "Sidekick couldn't finish", String(summary || "").split("\n").find(l => l.trim()) || "");
  if (state === "stopped" && parent) throw new DOMException("Stopped", "AbortError");
  return { summary, steps, state, plan };
}

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

export let speakingToggle = false;
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
  setTimeout(() => reflectStaleChats().catch(() => {}), 1500);
  input.focus();
})();
