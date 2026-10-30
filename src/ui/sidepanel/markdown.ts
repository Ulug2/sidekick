// Rendering replies safely: Markdown and math, with nothing that can load from outside (no images,
// styles, frames or forms; links open in a new tab), plus the math setup and review blocks.
import { stripWrappers } from "../../core/security/guard.js";
import { ICON } from "./icons.js";

export const escapeHtml = (s: any) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

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
