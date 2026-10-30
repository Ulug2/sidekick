// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

import type { FrameSnapshot, SnapshotOptions } from "../agent/types.js";

// Builds a numbered list of everything you can interact with in this frame, plus some page
// text. Each element gets a stable data-sk-id attribute so actions can find it again.
export function skPageSnapshot(opts: SnapshotOptions = {}): FrameSnapshot | null {
  const MAX_ELEMENTS = opts.maxElements || 300;
  const MAX_TEXT = opts.maxText || 2500;
  if (window.innerWidth < 40 || window.innerHeight < 40) return null; // tiny frames (ads, trackers)
  window.__skNext = window.__skNext || 1;

  const SEL = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]",
    "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=option]", "[role=combobox]",
    "[role=textbox]", "[role=searchbox]", "[role=listbox]", "[role=slider]", "[role=spinbutton]", "[role=treeitem]",
    '[contenteditable=""]', '[contenteditable="true"]', "[onclick]", '[tabindex]:not([tabindex="-1"])',
    ".mq-editable-field" // MathQuill math answer boxes (MyOpenMath, WebAssign, …)
  ].join(",");
  const isMath = (el: any) => el.classList && el.classList.contains("mq-editable-field");

  const clean = (s?: any, n: any = 100) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  // Collect candidates, including inside open shadow roots.
  const found: any[] = [];
  const walk = (root: any) => {
    root.querySelectorAll(SEL).forEach((el: any) => found.push(el));
    root.querySelectorAll("*").forEach((el: any) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);

  const isShown = (el: any) => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const textOf = (el: any) => clean(el.innerText || el.textContent || "");
  const byIds = (ids: any) => ids.split(/\s+/).map((id: any) => ((el: any) => el && textOf(el))(document.getElementById(id))).filter(Boolean).join(" ");

  const labelOf = (el: any) => {
    if (isMath(el)) {
      const ta = el.querySelector("textarea");
      const own = ta && (ta.getAttribute("aria-label") || (ta.getAttribute("aria-labelledby") && byIds(ta.getAttribute("aria-labelledby"))));
      if (own) return clean(own);
      const prev = el.previousElementSibling;
      if (el.id) { const l = document.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
      return clean(el.getAttribute("aria-label") || (prev && prev.tagName === "LABEL" && prev.innerText) || "");
    }
    if (el.getAttribute("aria-labelledby")) { const t = byIds(el.getAttribute("aria-labelledby")); if (t) return t; }
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (el.labels && el.labels.length) { const t = clean([...el.labels].map((l: any) => l.innerText).join(" ")); if (t) return t; }
    const tag = el.tagName;
    if (tag === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) return clean(el.value);
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      const t = textOf(el);
      if (t) return t;
      const img = el.querySelector("img[alt], svg title");
      if (img) return clean(img.getAttribute?.("alt") || img.textContent);
    }
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "");
  };

  // The question a field answers, when its own label is missing or very short
  // (common in application forms that put the question in a nearby div).
  const questionOf = (el: any) => {
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (lg && textOf(lg)) return textOf(lg); }
    const group = el.closest("[role=radiogroup],[role=group]");
    if (group) {
      const t = group.getAttribute("aria-label") || (group.getAttribute("aria-labelledby") && byIds(group.getAttribute("aria-labelledby")));
      if (t) return clean(t);
    }
    // Look a few levels up for the question text, but never past the form itself, and never
    // take a section heading ("Personal info") for a question.
    const headingText = new Set([...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")].map((h: any) => clean(h.innerText || h.textContent)));
    let node = el.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body && node.tagName !== "FORM"; i++, node = node.parentElement) {
      const t = (node.innerText || "").trim();
      if (t && t.length < 400) {
        const first = t.split("\n").map((x: any) => x.trim()).find((x: any) => x && x !== labelOf(el) && !headingText.has(clean(x)));
        if (first && first.length > 3) return clean(first, 140);
      }
    }
    return "";
  };

  const roleOf = (el: any) => {
    if (isMath(el)) return "textbox:math";
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio" || t === "file" || t === "range") return t === "range" ? "slider" : t;
      if (/^(submit|button|reset|image)$/.test(t)) return "button";
      return t === "text" ? "textbox" : `textbox:${t}`;
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  };

  // Fields Sidekick must never fill (same rule the action side enforces).
  const SECRET = /pass(word|code)|pwd|cc-|card.?(number|num|no)|cvc|cvv|security.?code|ssn|social.?security|routing|account.?number|iban/i;
  const vw = innerWidth, vh = innerHeight;
  let traps = 0;
  const listed = [];
  const hiddenFromPeople = (el: any) => {
    const r = el.getBoundingClientRect();
    if (r.right + scrollX < 0 || r.bottom + scrollY < 0) return true; // left of / above the page: no scrolling reaches it
    if (r.left + scrollX > Math.max(document.documentElement.scrollWidth, vw) + 50) return true;
    const cs = getComputedStyle(el);
    if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\((50|100)%\)/.test(cs.clipPath)) return true;
    if (parseFloat(cs.fontSize) < 2 && r.height < 4) return true;
    return false;
  };
  const seen = new Set();
  const lines = [];
  let count = 0;
  let skipped = 0;

  // Page structure, like a screen reader sees it: each element is listed under the nearest
  // heading before it ("## Education"), so repeated fields ("Start date") are easy to tell apart.
  const heads = [...document.querySelectorAll("h1, h2, h3, h4, [role=heading]")].filter(isShown)
    .map((h: any) => ({ el: h, text: clean(h.innerText || h.textContent, 60) })).filter((h: any) => h.text);
  const sectionOf = (el: any) => {
    let best = "";
    for (const h of heads) {
      if (h.el === el || h.el.contains(el)) continue;
      if (h.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h.text;
      else break;
    }
    return best;
  };
  let lastSection = "";

  // If a modal dialog is open, list its elements first: that's what the user is looking at.
  const dialog = [...document.querySelectorAll('[role=dialog][aria-modal=true], [role=alertdialog], dialog[open]')].find(isShown);
  const ordered = dialog ? [...found.filter((e: any) => dialog.contains(e)), ...found.filter((e: any) => !dialog.contains(e))] : found;

  for (const el of ordered) {
    if (seen.has(el)) continue;
    seen.add(el);
    const tag = el.tagName;
    if (tag === "INPUT" && el.type === "hidden") continue;
    if (el.disabled && tag !== "BUTTON") continue;
    const role = roleOf(el);

    // Custom-styled radios/checkboxes/file inputs are often invisible; use their visible label instead.
    let shown = isShown(el);
    if (!shown && tag === "INPUT" && /^(checkbox|radio)$/.test(el.type) && el.labels && [...el.labels].some(isShown)) shown = true;
    // A field a person can never see (pushed off the page, or clipped to nothing) is a classic
    // trap for AI agents: "fill this in" with data the user never meant to give. Never list it.
    if (shown && /^(INPUT|SELECT|TEXTAREA)$/.test(tag) && !/^(checkbox|radio|file)$/.test(el.type) && hiddenFromPeople(el)) { traps++; continue; }
    if (!shown && !(tag === "INPUT" && el.type === "file")) continue;

    // Skip generic containers that are focusable but aren't controls.
    if (role === "clickable" && !el.hasAttribute("onclick") && textOf(el).length > 150) continue;
    // MathQuill's own hidden textarea is reached through its box; don't list it twice.
    if (tag === "TEXTAREA" && el.closest(".mq-editable-field")) continue;
    // Skip things nested inside a link/button already listed (icons, spans).
    const outer = el.parentElement && el.parentElement.closest("a[href],button,[role=button],[role=link],[role=option],[role=menuitem],[role=tab]");
    if (outer && seen.has(outer) && !/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) continue;

    if (count >= MAX_ELEMENTS) { skipped++; continue; }
    if (!el.dataset.skId) el.dataset.skId = String(window.__skNext!++);

    let label = labelOf(el);
    const bits = [];
    if (role === "file" && label.length < 3) label = questionOf(el) || "file upload";
    const isField = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || /textbox|combobox|checkbox|radio|switch|listbox|searchbox|spinbutton/.test(role);
    if (isField && role !== "file" && (label.length < 2 || role === "radio" || role === "checkbox")) {
      const q = questionOf(el);
      if (q && q !== label) bits.push(`question: "${q}"`);
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const on = el.checked ?? (el.getAttribute("aria-checked") === "true");
      bits.push(on ? "checked" : "unchecked");
    } else if (tag === "SELECT") {
      const opts = [...el.options].map((o: any) => clean(o.text, 40)).filter(Boolean);
      bits.push(`selected: "${clean(el.selectedOptions[0]?.text, 60)}"`);
      bits.push(`options: ${opts.slice(0, 25).map((o: any) => `"${o}"`).join(", ")}${opts.length > 25 ? `, …${opts.length - 25} more` : ""}`);
    } else if (role === "file") {
      bits.push(el.files && el.files.length ? `has file: "${el.files[0].name}"` : "no file");
    } else if (tag === "INPUT" || tag === "TEXTAREA") {
      if (el.type === "password") bits.push("PASSWORD (user must type)");
      else if (SECRET.test([el.name, el.id, el.autocomplete, el.getAttribute("aria-label"), el.placeholder, label].join(" "))) bits.push("SENSITIVE (user must type)");
      else if (el.value) bits.push(`value: "${clean(el.value, 80)}"`);
      else bits.push("empty");
    } else if (isMath(el)) {
      const t = clean((el.querySelector(".mq-root-block") || el).innerText || "", 80);
      bits.push(t ? `value: "${t}"` : "empty", "math box: type plain text like -8103.0839, 2/3, sqrt(5) or DNE");
    } else if (el.isContentEditable) {
      const t = textOf(el);
      bits.push(t ? `value: "${clean(t, 80)}"` : "empty");
    }
    if (el.getAttribute("aria-expanded")) bits.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (tag !== "SELECT" && el.getAttribute("aria-selected") === "true") bits.push("selected");
    if (el.getAttribute("aria-pressed") === "true") bits.push("pressed");
    if (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") bits.push("current");
    if (isField && el.getAttribute("aria-describedby")) {
      const hint = clean(byIds(el.getAttribute("aria-describedby")), 140);
      if (hint && hint !== label && !/^(required|optional)$/i.test(hint)) bits.push(`hint: "${hint}"`);
    }
    if (el.required || el.getAttribute("aria-required") === "true") bits.push("required");
    if (el.getAttribute("aria-invalid") === "true") bits.push("INVALID");
    if (el.disabled) bits.push("disabled");
    if (tag === "A") {
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("#") && !href.startsWith("javascript")) bits.push(`→ ${clean(href, 70)}`);
    }
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) bits.push("offscreen");

    const section = sectionOf(el);
    if (section && section !== lastSection) lines.push(`## ${section}`);
    if (section) lastSection = section;
    lines.push(`[${el.dataset.skId}] ${role} "${label}"${bits.length ? " " + bits.join(", ") : ""}`);
    listed.push({ el, key: role + "|" + label, at: lines.length - 1, label });
    count++;
  }

  // Repeated fields ("From", "To", "Dates" on each leg of a multi-city search; "Start date" in
  // each job): name the row each one is in, from the biggest container holding only that one.
  const byKey: Record<string, any[]> = {};
  for (const x of listed) (byKey[x.key] ||= []).push(x);
  for (const group of Object.values(byKey)) {
    if (group.length < 2 || group.length > 12) continue;
    for (const x of group) {
      let row = null;
      for (let p = x.el.parentElement, i = 0; p && p !== document.body && i < 8; p = p.parentElement, i++) {
        if (group.some((o: any) => o !== x && p.contains(o.el))) break;
        row = p;
      }
      // Fields always; buttons only in rows that hold fields (each leg's "Dates"), not lists of
      // cards where identical buttons ("Save" ×6) are grouped instead.
      const isFieldEl = /^(INPUT|SELECT|TEXTAREA)$/.test(x.el.tagName) || /combobox|textbox|listbox|spinbutton/.test(x.key);
      if (!isFieldEl && !(row && row.querySelector("input:not([type=hidden]), select, textarea, [role=combobox]"))) continue;
      const first = row ? clean((row.innerText || "").split("\n").find((t: any) => t.trim()) || "") : "";
      if (first && first.length <= 40 && first.toLowerCase() !== x.label.toLowerCase()) lines[x.at] += `${lines[x.at].endsWith('"') ? "" : ","} row: "${first}"`;
    }
  }

  // Forms the site has declared as tools for AI agents (WebMCP declarative API).
  const formTools = [...document.querySelectorAll("form[toolname], form[tool-name]")].slice(0, 10).map((f: any) => {
    if (!f.dataset.skId) f.dataset.skId = String(window.__skNext!++);
    const params = [...f.querySelectorAll("input[name], select[name], textarea[name]")]
      .filter((i: any) => !/^(hidden|submit|button|reset|password)$/i.test(i.type || ""))
      .map((i: any) => ({
        name: i.name,
        description: clean(i.getAttribute("toolparamdescription") || i.getAttribute("tool-param-description") || labelOf(i), 100),
        required: !!i.required,
        type: i.tagName === "SELECT" ? "select" : (i.type || i.tagName).toLowerCase(),
        options: i.tagName === "SELECT" ? [...i.options].map((o: any) => clean(o.value || o.text, 40)).filter(Boolean).slice(0, 20) : undefined
      }));
    const uniq = [...new Map(params.map((x: any) => [x.name, x])).values()];
    return {
      name: clean(f.getAttribute("toolname") || f.getAttribute("tool-name"), 64),
      description: clean(f.getAttribute("tooldescription") || f.getAttribute("tool-description"), 240),
      form: f.dataset.skId,
      params: uniq,
      autosubmit: f.hasAttribute("toolautosubmit") || f.hasAttribute("tool-auto-submit")
    };
  });

  // Validation errors are easy to miss; surface them explicitly.
  const errors = [...document.querySelectorAll('[role=alert], [aria-live=assertive], .error, .field-error, .invalid-feedback, [class*="error-message"]')]
    .filter(isShown).map(textOf).filter((t: any) => t && t.length < 200).slice(0, 10);

  const main = document.querySelector<HTMLElement>("main, [role=main], article") || document.body;
  const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

  // Embedded frames big enough to matter, so the agent can tell when Chrome kept it out of one.
  const frames = [...document.querySelectorAll("iframe, frame")].filter((f: any) => { const r = f.getBoundingClientRect(); return r.width >= 120 && r.height >= 80; })
    .map((f: any) => { let host = ""; try { host = new URL(f.src || f.getAttribute("src") || "about:blank", location.href).hostname; } catch {} return { host, title: clean(f.title || f.name || "", 60) }; });

  return {
    title: document.title,
    url: location.href,
    isTop: window === window.top,
    frames,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: vh, width: vw },
    dialog: dialog ? clean(dialog.getAttribute("aria-label") || textOf(dialog), 80) : "",
    headings: [...document.querySelectorAll("h1, h2, h3")].filter(isShown).map((h: any) => clean(h.innerText, 80)).filter(Boolean).slice(0, 15),
    errors,
    elements: lines,
    formTools,
    skipped,
    traps,
    text: text.slice(0, MAX_TEXT),
    textLength: text.length
  };
}
