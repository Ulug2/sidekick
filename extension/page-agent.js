// These two functions are injected into web pages with chrome.scripting.executeScript.
// They must be fully self-contained: no references to anything outside their own body.

// Builds a numbered list of everything you can interact with in this frame, plus some page
// text. Each element gets a stable data-sk-id attribute so actions can find it again.
function skPageSnapshot(opts = {}) {
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
  const isMath = el => el.classList && el.classList.contains("mq-editable-field");

  const clean = (s, n = 100) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  // Collect candidates, including inside open shadow roots.
  const found = [];
  const walk = root => {
    root.querySelectorAll(SEL).forEach(el => found.push(el));
    root.querySelectorAll("*").forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);

  const isShown = el => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const textOf = el => clean(el.innerText || el.textContent || "");
  const byIds = ids => ids.split(/\s+/).map(id => (el => el && textOf(el))(document.getElementById(id))).filter(Boolean).join(" ");

  const labelOf = el => {
    if (isMath(el)) {
      const ta = el.querySelector("textarea");
      const own = ta && (ta.getAttribute("aria-label") || (ta.getAttribute("aria-labelledby") && byIds(ta.getAttribute("aria-labelledby"))));
      if (own) return clean(own);
      const prev = el.previousElementSibling;
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
      return clean(el.getAttribute("aria-label") || (prev && prev.tagName === "LABEL" && prev.innerText) || "");
    }
    if (el.getAttribute("aria-labelledby")) { const t = byIds(el.getAttribute("aria-labelledby")); if (t) return t; }
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (el.labels && el.labels.length) { const t = clean([...el.labels].map(l => l.innerText).join(" ")); if (t) return t; }
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
  const questionOf = el => {
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (lg && textOf(lg)) return textOf(lg); }
    const group = el.closest("[role=radiogroup],[role=group]");
    if (group) {
      const t = group.getAttribute("aria-label") || (group.getAttribute("aria-labelledby") && byIds(group.getAttribute("aria-labelledby")));
      if (t) return clean(t);
    }
    // Look a few levels up for the question text, but never past the form itself, and never
    // take a section heading ("Personal info") for a question.
    const headingText = new Set([...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")].map(h => clean(h.innerText || h.textContent)));
    let node = el.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body && node.tagName !== "FORM"; i++, node = node.parentElement) {
      const t = (node.innerText || "").trim();
      if (t && t.length < 400) {
        const first = t.split("\n").map(x => x.trim()).find(x => x && x !== labelOf(el) && !headingText.has(clean(x)));
        if (first && first.length > 3) return clean(first, 140);
      }
    }
    return "";
  };

  const roleOf = el => {
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
  const hiddenFromPeople = el => {
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
    .map(h => ({ el: h, text: clean(h.innerText || h.textContent, 60) })).filter(h => h.text);
  const sectionOf = el => {
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
  const ordered = dialog ? [...found.filter(e => dialog.contains(e)), ...found.filter(e => !dialog.contains(e))] : found;

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
    if (!el.dataset.skId) el.dataset.skId = String(window.__skNext++);

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
      const opts = [...el.options].map(o => clean(o.text, 40)).filter(Boolean);
      bits.push(`selected: "${clean(el.selectedOptions[0]?.text, 60)}"`);
      bits.push(`options: ${opts.slice(0, 25).map(o => `"${o}"`).join(", ")}${opts.length > 25 ? `, …${opts.length - 25} more` : ""}`);
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
  const byKey = {};
  for (const x of listed) (byKey[x.key] ||= []).push(x);
  for (const group of Object.values(byKey)) {
    if (group.length < 2 || group.length > 12) continue;
    for (const x of group) {
      let row = null;
      for (let p = x.el.parentElement, i = 0; p && p !== document.body && i < 8; p = p.parentElement, i++) {
        if (group.some(o => o !== x && p.contains(o.el))) break;
        row = p;
      }
      // Fields always; buttons only in rows that hold fields (each leg's "Dates"), not lists of
      // cards where identical buttons ("Save" ×6) are grouped instead.
      const isFieldEl = /^(INPUT|SELECT|TEXTAREA)$/.test(x.el.tagName) || /combobox|textbox|listbox|spinbutton/.test(x.key);
      if (!isFieldEl && !(row && row.querySelector("input:not([type=hidden]), select, textarea, [role=combobox]"))) continue;
      const first = row ? clean((row.innerText || "").split("\n").find(t => t.trim()) || "") : "";
      if (first && first.length <= 40 && first.toLowerCase() !== x.label.toLowerCase()) lines[x.at] += `${lines[x.at].endsWith('"') ? "" : ","} row: "${first}"`;
    }
  }

  // Forms the site has declared as tools for AI agents (WebMCP declarative API).
  const formTools = [...document.querySelectorAll("form[toolname], form[tool-name]")].slice(0, 10).map(f => {
    if (!f.dataset.skId) f.dataset.skId = String(window.__skNext++);
    const params = [...f.querySelectorAll("input[name], select[name], textarea[name]")]
      .filter(i => !/^(hidden|submit|button|reset|password)$/i.test(i.type || ""))
      .map(i => ({
        name: i.name,
        description: clean(i.getAttribute("toolparamdescription") || i.getAttribute("tool-param-description") || labelOf(i), 100),
        required: !!i.required,
        type: i.tagName === "SELECT" ? "select" : (i.type || i.tagName).toLowerCase(),
        options: i.tagName === "SELECT" ? [...i.options].map(o => clean(o.value || o.text, 40)).filter(Boolean).slice(0, 20) : undefined
      }));
    const uniq = [...new Map(params.map(x => [x.name, x])).values()];
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
    .filter(isShown).map(textOf).filter(t => t && t.length < 200).slice(0, 10);

  const main = document.querySelector("main, [role=main], article") || document.body;
  const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

  // Embedded frames big enough to matter, so the agent can tell when Chrome kept it out of one.
  const frames = [...document.querySelectorAll("iframe, frame")].filter(f => { const r = f.getBoundingClientRect(); return r.width >= 120 && r.height >= 80; })
    .map(f => { let host = ""; try { host = new URL(f.src || f.getAttribute("src") || "about:blank", location.href).hostname; } catch {} return { host, title: clean(f.title || f.name || "", 60) }; });

  return {
    title: document.title,
    url: location.href,
    isTop: window === window.top,
    frames,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: vh, width: vw },
    dialog: dialog ? clean(dialog.getAttribute("aria-label") || textOf(dialog), 80) : "",
    headings: [...document.querySelectorAll("h1, h2, h3")].filter(isShown).map(h => clean(h.innerText, 80)).filter(Boolean).slice(0, 15),
    errors,
    elements: lines,
    formTools,
    skipped,
    traps,
    text: text.slice(0, MAX_TEXT),
    textLength: text.length
  };
}

// Performs one action on the element with the given data-sk-id, after briefly highlighting it.
async function skPageAct(a) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deepFind = (root, sel) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { const h = deepFind(el.shadowRoot, sel); if (h) return h; }
    }
    return null;
  };
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();
  const isMathBox = el => !!(el && el.classList && el.classList.contains("mq-editable-field"));

  if (a.op === "read_text") {
    const main = document.querySelector("main, [role=main], article") || document.body;
    const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    return { ok: true, text: text.slice(0, a.max || 15000), truncated: text.length > (a.max || 15000) };
  }

  // One call instead of many "scroll down" steps: go to the bottom until the page stops growing
  // (lists that load as you scroll), then back to the top. Everything is in the next snapshot.
  if (a.op === "scroll" && !a.id && a.direction === "all") {
    let last = -1, rounds = 0;
    while (rounds < 12) {
      const h = document.documentElement.scrollHeight;
      if (h === last) break;
      last = h;
      scrollTo({ top: h });
      rounds++;
      await sleep(450);
    }
    scrollTo({ top: 0 });
    await sleep(150);
    return { ok: true, note: `Went through the whole page${rounds > 2 ? ` (it kept loading more ${rounds - 1} times)` : ""}; everything on it is in this snapshot.` };
  }

  if (a.op === "scroll" && !a.id) {
    const dy = a.direction === "up" ? -0.8 * innerHeight : 0.8 * innerHeight;
    if (a.direction === "top") scrollTo({ top: 0 });
    else if (a.direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight });
    else scrollBy({ top: dy });
    await sleep(250);
    return { ok: true };
  }

  // ---- coordinate ops, for pages where the element list isn't enough (canvas apps etc.) ----
  if (a.op === "describe_point" || a.op === "click_point") {
    const hit = document.elementFromPoint(a.x, a.y);
    if (!hit) return { ok: false, error: `Nothing at (${a.x}, ${a.y}); it's outside the visible page.` };
    const target = hit.closest("a[href],button,[role=button],[role=link],input,select,textarea,label,[onclick],[role=option],[role=menuitem],[role=tab],[role=checkbox],[role=radio]") || hit;
    const label = clean(target.getAttribute("aria-label") || target.innerText || target.value || target.getAttribute("title") || target.getAttribute("alt") || target.tagName.toLowerCase()).slice(0, 80);
    const dot = document.createElement("div");
    dot.style.cssText = `all:initial;position:fixed;z-index:2147483647;pointer-events:none;left:${a.x - 9}px;top:${a.y - 9}px;width:18px;height:18px;border-radius:50%;border:2px solid #c8a96a;box-shadow:0 0 0 5px rgba(200,169,106,.28);transition:opacity .4s;`;
    document.documentElement.appendChild(dot);
    setTimeout(() => { dot.style.opacity = "0"; setTimeout(() => dot.remove(), 450); }, 800);
    if (a.op === "describe_point") return { ok: true, label, tag: target.tagName.toLowerCase(), isFrame: hit.tagName === "IFRAME" };
    await sleep(200);
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: a.x, clientY: a.y, button: 0 };
    for (const type of ["pointerover", "pointerdown", "mousedown"]) target.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts));
    target.focus?.({ preventScroll: true });
    for (const type of ["pointerup", "mouseup"]) target.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts));
    target.click?.();
    return { ok: true, label };
  }

  let el = a.id ? deepFind(document, `[data-sk-id="${CSS.escape(String(a.id))}"]`) : document.activeElement;
  if (!el) return { ok: false, error: `Element [${a.id}] isn't on the page anymore. Use the new snapshot.` };

  // ---- safety: never type secrets, whatever the model asks ----
  const SECRET_FIELD = /pass(word|code)?|pwd|cc-|card.?(number|num|no)|cvc|cvv|security.?code|ssn|social.?security|routing|account.?number|iban|pin\b/i;
  const fieldHints = [el.type, el.name, el.id, el.autocomplete, el.getAttribute("aria-label"), el.placeholder].join(" ");
  const SECRET_VALUE = /\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]?){13,19}\b/;
  if (a.op === "type" || a.op === "prepare_type" || a.op === "select_option") {
    if (el.type === "password" || SECRET_FIELD.test(fieldHints)) {
      return { ok: false, error: "This looks like a password, payment, or ID-number field. Sidekick never fills those. Ask the user to type it themselves." };
    }
    if ((a.op === "type" || a.op === "prepare_type") && SECRET_VALUE.test(a.text || "")) {
      return { ok: false, error: "That text looks like a card or Social Security number. Sidekick never types those. Ask the user." };
    }
  }

  // ---- highlight so the user can see what's happening ----
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  await sleep(60);
  const showBox = target => {
    const r = target.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `all:initial;position:fixed;z-index:2147483647;pointer-events:none;left:${r.left - 4}px;top:${r.top - 4}px;` +
      `width:${r.width + 8}px;height:${r.height + 8}px;border:2px solid #c8a96a;border-radius:8px;` +
      `box-shadow:0 0 0 4px rgba(200,169,106,.25);transition:opacity .4s;`;
    document.documentElement.appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; setTimeout(() => box.remove(), 450); }, 700);
  };

  const clickLike = target => {
    const r = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    target.dispatchEvent(new PointerEvent("pointerover", opts));
    target.dispatchEvent(new PointerEvent("pointerdown", opts));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.focus?.({ preventScroll: true });
    target.dispatchEvent(new PointerEvent("pointerup", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.click();
  };
  // Hidden custom checkboxes/radios: click their visible label instead.
  const visibleTarget = t => {
    const r = t.getBoundingClientRect();
    if ((r.width < 2 || r.height < 2 || getComputedStyle(t).opacity === "0") && t.labels && t.labels.length) return t.labels[0];
    return t;
  };

  const setNativeValue = (target, value) => {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(target, value);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };

  const isShown = n => {
    if (n.checkVisibility && !n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = n.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  // How well an option matches what was asked. Sites word things their own way ("Dulles
  // International Airport(IAD) (11 km),Washington DC" for "Washington DC (IAD)"), so this scores
  // instead of demanding the same text: exact > same code (IAD, IST) > starts/contains > shared words.
  const norm = t => clean(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").toLowerCase();
  const codesIn = t => [...String(t || "").matchAll(/\(([A-Z0-9]{2,4})\)|\b([A-Z]{3})\b/g)].map(m => m[1] || m[2]);
  const optionScore = (text, want) => {
    const t = norm(text), w = norm(want);
    if (!t || !w) return 0;
    if (t === w) return 100;
    const codes = codesIn(want);
    if (codes.some(c => new RegExp(`\\(${c}\\)|\\b${c}\\b`).test(clean(text)))) return 95;
    if (t.startsWith(w)) return 90;
    if (t.includes(w)) return 85;
    if (w.length > 3 && t.length > 2 && w.includes(t)) return 70;
    const lowCodes = codes.map(c => c.toLowerCase());
    const words = w.split(/[^a-z0-9]+/).filter(x => x.length > 1 && !lowCodes.includes(x));
    if (!words.length) return 0;
    const share = words.filter(x => t.includes(x)).length / words.length;
    return share >= 0.5 ? Math.round(40 + 40 * share) : 0;
  };
  const optionMatch = (candidates, want) => {
    let best = null, bestScore = 0;
    for (const c of candidates) {
      const sc = Math.max(optionScore(c.text, want), c.label ? optionScore(c.label, want) : 0);
      if (sc > bestScore) { best = c; bestScore = sc; }
    }
    return bestScore >= 50 ? Object.assign(best, { score: bestScore }) : null;
  };

  // Options of a custom dropdown/autocomplete: the list the field points to (aria-controls /
  // aria-owns), else visible options near the field. Never menus in the page header or nav.
  const OPTION_SEL = '[role=option], [role=menuitem], [role=listbox] li, [id*="-option-"], ul[class*="menu"] li, [class*="option"]:not(select):not(option)';
  const optionsFor = field => {
    const inp = field.matches("input, textarea") ? field : field.querySelector("input, textarea");
    const ids = [field, inp].filter(Boolean).flatMap(x => [x.getAttribute("aria-controls"), x.getAttribute("aria-owns")]).filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
    const boxes = ids.map(id => document.getElementById(id)).filter(Boolean);
    let opts = (boxes.length ? boxes : [document]).flatMap(b => [...b.querySelectorAll(OPTION_SEL)]).filter(isShown);
    opts = opts.filter(o => !opts.some(p => p !== o && p.contains(o)));
    if (!boxes.length) {
      const fr = field.getBoundingClientRect();
      opts = opts.filter(o => !o.closest("nav, header, footer, [role=navigation], [role=banner]") && Math.abs(o.getBoundingClientRect().top - fr.bottom) < 700);
    }
    return opts.map(o => ({ el: o, text: o.innerText || o.textContent || "", label: o.getAttribute("aria-label") || "" }));
  };
  // What to type to make an autocomplete show the right suggestion: a code first, then the name.
  const queriesFor = want => {
    const w = clean(want);
    const before = clean(w.split(/[(,]/)[0]);
    return [...new Set([...codesIn(w), before, before.split(" ")[0], w].filter(q => q && q.length >= 2))];
  };

  // ---- calendars ----
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const isoOf = text => {
    const t = clean(text);
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(t);
    if (isNaN(d) || !/[a-z]{3}|\d{1,2}\/\d{1,2}\/\d{4}/i.test(t)) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const pickDate = async (field, iso) => {
    const [y, mo, dd] = iso.split("-").map(Number);
    if (field.tagName === "INPUT" && field.type === "date") { setNativeValue(field, iso); return { ok: true, note: `Set the date to ${iso}.` }; }
    const mon = MONTHS[mo - 1], cap = mon[0].toUpperCase() + mon.slice(1), short = cap.slice(0, 3);
    const dayRe = new RegExp(`\\b(${cap}|${short})\\.?\\s+${dd}\\b[^0-9]{0,24}${y}|\\b${dd}\\.?\\s+(${cap}|${short})\\.?[^0-9]{0,24}${y}|${iso}|\\b0?${mo}/0?${dd}/${y}\\b`, "i");
    const CELL = "button, td, [role=gridcell], [role=button], [role=option], a, [tabindex]";
    const findDay = () => {
      for (const c of document.querySelectorAll("button, td, [role=gridcell], [role=button], [role=option], a, abbr, time, [data-date], [data-day], [aria-label]")) {
        if (!isShown(c)) continue;
        const attrs = ["aria-label", "title", "data-date", "data-day", "datetime", "data-value", "data-iso"].map(n => c.getAttribute(n)).filter(Boolean).join(" | ");
        if (attrs && dayRe.test(attrs)) return c.closest(CELL) || c;
      }
      // A month heading ("December 2026") whose own grid has exactly one cell "10".
      const capRe = new RegExp(`^(${cap}|${short})\\.?\\s+${y}$`, "i");
      for (const h of document.querySelectorAll("*")) {
        if (h.children.length > 2 || !isShown(h) || !capRe.test(clean(h.innerText))) continue;
        for (let box = h.parentElement, i = 0; box && i < 5; box = box.parentElement, i++) {
          const cells = [...box.querySelectorAll("button, td, [role=gridcell]")].filter(c => isShown(c) && clean(c.innerText) === String(dd));
          if (cells.length === 1) return cells[0];
          if (cells.length > 1) break;
        }
      }
      return null;
    };
    const shownMonths = () => [...document.querySelectorAll("*")].filter(e => e.children.length <= 2 && isShown(e))
      .map(e => clean(e.innerText).match(/^([A-Za-z]+)\.?\s+(\d{4})$/)).filter(m => m && MONTHS.some(x => x.startsWith(m[1].toLowerCase().slice(0, 3))))
      .map(m => Number(m[2]) * 12 + MONTHS.findIndex(x => x.startsWith(m[1].toLowerCase().slice(0, 3))));
    const navButton = dir => {
      const want = dir > 0 ? /next|following|forward|ileri|siguiente|suivant/i : /prev|previous|back|geri|anterior|précédent/i;
      const arrows = dir > 0 ? /^[›»>→❯▶]$/ : /^[‹«<←❮◀]$/;
      const cands = [...document.querySelectorAll("button, [role=button], a")].filter(isShown);
      const named = c => [c.getAttribute("aria-label"), c.getAttribute("title"), String(c.className)].join(" ");
      return cands.find(c => /month/i.test(named(c)) && want.test(named(c)))
        || cands.find(c => want.test(named(c)) && !/slide|carousel|banner|page|step/i.test(named(c)) && c.closest("[class*=alendar], [class*=icker], [role=dialog], [role=grid]"))
        || cands.find(c => arrows.test(clean(c.innerText)) && c.closest("[class*=alendar], [class*=icker], [role=dialog]"));
    };
    let day = findDay();
    // Some sites open the calendar by themselves (Turkish Airlines does right after you pick the
    // destination). Clicking the field then would close it again; only open it if none is showing.
    if (!day && !shownMonths().length) { clickLike(visibleTarget(field)); await sleep(500); day = findDay(); }
    const target = y * 12 + mo - 1;
    for (let i = 0; !day && i < 24; i++) {
      const months = shownMonths();
      if (!months.length) break;
      const dir = target > Math.max(...months) ? 1 : target < Math.min(...months) ? -1 : 0;
      if (!dir) break;
      const nav = navButton(dir);
      if (!nav) return { ok: false, error: `The calendar is open but I couldn't find its ${dir > 0 ? "next" : "previous"}-month button. Take a screenshot and click it, then call pick_date again.` };
      clickLike(nav);
      await sleep(300);
      day = findDay();
    }
    if (!day) return { ok: false, error: `Couldn't find ${cap} ${dd}, ${y} in the calendar. Take a screenshot to see it.` };
    if (day.disabled || day.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(String(day.className))) return { ok: false, error: `${cap} ${dd}, ${y} can't be chosen on this site (it's greyed out).` };
    showBox(day);
    await sleep(150);
    clickLike(day);
    await sleep(300);
    return { ok: true, note: `Picked ${cap} ${dd}, ${y}.` };
  };

  switch (a.op) {
    // Highlights the element and returns its center, for a real (debugger) click.
    case "locate": {
      const t = visibleTarget(el);
      showBox(t);
      await sleep(250);
      const r = t.getBoundingClientRect();
      const x = Math.round(r.left + Math.min(r.width / 2, Math.max(4, r.width - 4)));
      const y = Math.round(r.top + r.height / 2);
      if (r.width < 1 || r.height < 1) return { ok: false, error: "That element isn't visible." };
      // Is something (a cookie banner, a modal) covering it?
      const top = document.elementFromPoint(x, y);
      const covered = top && top !== t && !t.contains(top) && !top.contains(t) && !(t.labels && [...t.labels].some(l => l.contains(top)));
      return { ok: true, x, y, covered: covered ? clean(top.innerText || top.getAttribute("aria-label") || top.tagName).slice(0, 80) : "" };
    }

    // Focuses a field and selects what's in it, so real typing replaces it.
    case "prepare_type": {
      if (isMathBox(el)) {
        const ta = el.querySelector("textarea");
        showBox(el);
        clickLike(el);
        ta?.focus({ preventScroll: true });
        // MathQuill can't be "selected all" from here; the agent erases with Backspace first.
        const existing = clean((el.querySelector(".mq-root-block") || el).innerText || "").length;
        return { ok: true, math: true, erase: a.clear === false ? 0 : existing };
      }
      if (el.tagName === "SELECT") return { ok: false, error: "That's a dropdown. Use select_option." };
      if (el.tagName === "INPUT" && /^(checkbox|radio|file|submit|button)$/i.test(el.type)) return { ok: false, error: `Can't type into a ${el.type}. Use the matching tool.` };
      if (!el.isContentEditable && !("value" in el)) return { ok: false, error: "That element doesn't accept text." };
      showBox(el);
      el.focus({ preventScroll: true });
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        if (a.clear === false) range.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (a.clear === false) {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      } else {
        try { el.select(); } catch {}
      }
      return { ok: true, focused: document.activeElement === el || el.contains(document.activeElement) };
    }

    // How many fields the focused element's form has (Enter submits forms for real).
    case "enter_check": {
      el.focus?.({ preventScroll: true });
      const form = el.form || el.closest?.("form");
      const fields = form ? form.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select").length : 0;
      return { ok: true, formFields: fields, inTextarea: el.tagName === "TEXTAREA" || !!el.isContentEditable };
    }

    case "click": {
      const t = visibleTarget(el);
      showBox(t);
      await sleep(250);
      clickLike(t);
      return { ok: true };
    }

    case "type": {
      if (isMathBox(el)) {
        // Without real typing, MathQuill can't be driven from here: fill the plain answer field
        // MyOpenMath keeps next to the box (it's what gets submitted).
        const prev = el.previousElementSibling, next = el.nextElementSibling;
        const hidden = i => i && i.tagName === "INPUT" && (getComputedStyle(i).display === "none" || i.type === "hidden" || i.offsetParent === null);
        const host = el.closest("[id^=qnwrap], .question") || el.parentElement;
        const plain = hidden(prev) ? prev : hidden(next) ? next : host && [...host.querySelectorAll("input")].find(hidden);
        if (!plain) return { ok: false, error: "This math box needs real typing, which isn't available right now (the tab may be in the background). Ask the user to switch to the tab, then try again." };
        setNativeValue(plain, a.text ?? "");
        showBox(el);
        return { ok: true, note: "Filled the box's answer field directly; the box may only show it after the page refreshes." };
      }
      if (el.tagName === "SELECT") return { ok: false, error: "That's a dropdown. Use select_option." };
      if (el.tagName === "INPUT" && /^(checkbox|radio|file|submit|button)$/i.test(el.type)) return { ok: false, error: `Can't type into a ${el.type}. Use the matching tool.` };
      showBox(el);
      el.focus({ preventScroll: true });
      const text = a.text ?? "";
      if (el.isContentEditable) {
        if (a.clear !== false) document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
      } else if ("value" in el) {
        setNativeValue(el, a.clear === false ? el.value + text : text);
      } else {
        return { ok: false, error: "That element doesn't accept text." };
      }
      return { ok: true };
    }

    case "select_option": {
      showBox(el);
      if (el.tagName === "SELECT") {
        const opt = optionMatch([...el.options], a.option);
        if (!opt) return { ok: false, error: `No option like "${a.option}". Options: ${[...el.options].map(o => `"${clean(o.text)}"`).join(", ")}` };
        setNativeValue(el, opt.value);
        return { ok: true, note: `Selected "${clean(opt.text)}".` };
      }
      // A date on a calendar field ("December 10, 2026") goes to the date picker.
      const iso = isoOf(a.option || "");
      if (iso && !el.matches("[role=combobox], [aria-autocomplete]")) return pickDate(el, iso);
      // Custom dropdown / autocomplete (React Select, airport and city pickers): open it, take a
      // clear match if one shows; otherwise type the code, then the name, to filter, and pick the
      // best match among the field's own options.
      clickLike(el);
      await sleep(350);
      let opts = optionsFor(el);
      let hit = optionMatch(opts, a.option);
      const input = el.matches("input, textarea") ? el : el.querySelector("input, textarea");
      if ((!hit || hit.score < 85) && input && a.option) {
        for (const q of queriesFor(a.option)) {
          input.focus();
          setNativeValue(input, q);
          let found = null;
          for (let waited = 0; waited < 1500; waited += 150) {
            await sleep(150);
            opts = optionsFor(el);
            found = optionMatch(opts, a.option);
            if (found && found.score >= 85) break;
          }
          if (found && (!hit || found.score > hit.score)) hit = found;
          if (hit && hit.score >= 85) break;
        }
      }
      if (!hit) {
        return { ok: false, error: `Opened the dropdown but found no option like "${a.option}".` + (opts.length ? ` Its options: ${opts.slice(0, 12).map(o => `"${clean(o.text).slice(0, 80)}"`).join(", ")}. Call select_option again with the exact wording of the one you want.` : " No options appeared. Use type to enter part of the name, then click the suggestion from the new snapshot.") };
      }
      showBox(hit.el);
      clickLike(hit.el);
      await sleep(250);
      const shows = input ? clean(input.value) : clean(el.innerText);
      return { ok: true, note: `Selected "${clean(hit.text).slice(0, 100)}"${shows ? `; the field shows "${shows.slice(0, 60)}"` : ""}.` };
    }

    case "pick_date": {
      const iso = isoOf(a.date || "");
      if (!iso) return { ok: false, error: `"${a.date}" isn't a date I can read. Use YYYY-MM-DD.` };
      return pickDate(el, iso);
    }

    case "set_checked": {
      const current = el.checked ?? (el.getAttribute("aria-checked") === "true");
      if (current === !!a.checked) return { ok: true, note: "Already in that state." };
      const t = visibleTarget(el);
      showBox(t);
      await sleep(200);
      clickLike(t);
      return { ok: true };
    }

    case "upload_file": {
      let input = el.matches('input[type="file"]') ? el : el.querySelector('input[type="file"]');
      for (let n = el.parentElement, i = 0; !input && n && i < 5; n = n.parentElement, i++) input = n.querySelector('input[type="file"]');
      if (!input) return { ok: false, error: "No file upload field found there." };
      const bytes = Uint8Array.from(atob(a.file.base64), c => c.charCodeAt(0));
      const file = new File([bytes], a.file.name, { type: a.file.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      showBox(visibleTarget(input).getBoundingClientRect().height > 1 ? visibleTarget(input) : el);
      return { ok: true, note: `Attached ${a.file.name}.` };
    }

    case "press_key": {
      const key = a.key;
      const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8, Space: 32 };
      const init = { key: key === "Space" ? " " : key, code: key === "Space" ? "Space" : key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true, composed: true };
      const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
      if (key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      // Synthetic Enter doesn't submit forms by itself. Submit only small search-style forms;
      // anything bigger must be submitted by clicking its button (which goes through approval).
      if (key === "Enter" && down && el.form) {
        const fields = el.form.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select");
        if (fields.length <= 2) el.form.requestSubmit();
        else return { ok: true, note: "Pressed Enter. This form has several fields, so click its submit button instead if needed." };
      }
      return { ok: true };
    }

    // A form the site declared as an agent tool: fill its fields by name (and submit if asked).
    case "fill_form_tool": {
      if (el.tagName !== "FORM") return { ok: false, error: "That tool's form isn't on the page anymore." };
      const filled = [], missing = [];
      for (const [name, raw] of Object.entries(a.values || {})) {
        const value = raw == null ? "" : String(raw);
        const fields = [...el.elements].filter(f => f.name === name);
        if (!fields.length) { missing.push(name); continue; }
        const f = fields[0];
        const hints = [f.type, f.name, f.id, f.autocomplete, f.getAttribute("aria-label"), f.placeholder].join(" ");
        if (f.type === "password" || SECRET_FIELD.test(hints) || SECRET_VALUE.test(value)) return { ok: false, error: `"${name}" is a password, payment or ID field. Sidekick never fills those.` };
        if (f.type === "radio") {
          const r = fields.find(x => x.value === value) || fields.find(x => clean(x.labels?.[0]?.innerText).toLowerCase() === value.toLowerCase());
          if (!r) { missing.push(`${name}=${value}`); continue; }
          r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (f.type === "checkbox") {
          f.checked = /^(true|yes|on|1|checked)$/i.test(value); f.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (f.tagName === "SELECT") {
          const o = [...f.options].find(x => x.value === value) || optionMatch([...f.options], value);
          if (!o) { missing.push(`${name}=${value}`); continue; }
          setNativeValue(f, o.value);
        } else {
          setNativeValue(f, value);
        }
        filled.push(name);
      }
      showBox(el);
      if (a.submit && !missing.length) { await sleep(150); el.requestSubmit(); }
      return { ok: true, filled, missing, submitted: !!(a.submit && !missing.length) };
    }

    case "scroll": {
      const dy = a.direction === "up" ? -0.8 * el.clientHeight : 0.8 * el.clientHeight;
      el.scrollBy({ top: dy });
      await sleep(250);
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown action ${a.op}` };
  }
}

// ---------- WebMCP: tools a website offers to AI agents ----------
// These run in the page's own JavaScript world (world: "MAIN"), where the site registered its
// tools with navigator.modelContext. webmcp-capture.js records them as they're registered.

async function skWebMCPList() {
  const out = [];
  const seen = new Set();
  const add = (t, source) => {
    if (!t || !t.name || seen.has(t.name)) return;
    seen.add(t.name);
    let schema = t.inputSchema || t.parameters || { type: "object", properties: {} };
    if (typeof schema === "string") { try { schema = JSON.parse(schema); } catch { schema = { type: "object", properties: {} }; } }
    out.push({
      name: String(t.name).slice(0, 64),
      description: String(t.description || "").replace(/\s+/g, " ").slice(0, 300),
      inputSchema: JSON.parse(JSON.stringify(schema || {})),
      readOnly: !!(t.annotations && t.annotations.readOnlyHint),
      source
    });
  };
  try { const reg = window.__skWebMCP; if (reg && reg.tools) for (const t of reg.tools.values()) add(t, "page"); } catch {}
  try {
    const testing = navigator.modelContextTesting;
    if (testing && typeof testing.listTools === "function") for (const t of (await testing.listTools()) || []) add(t, "chrome");
  } catch {}
  return out.slice(0, 30);
}

async function skWebMCPCall(req) {
  const name = req && req.name;
  const args = (req && req.args) || {};
  try {
    const t = window.__skWebMCP && window.__skWebMCP.tools && window.__skWebMCP.tools.get(name);
    let result;
    if (t && typeof t.execute === "function") {
      const client = { requestUserInteraction: async cb => (typeof cb === "function" ? cb() : undefined) };
      result = await t.execute(args, client);
    } else if (navigator.modelContextTesting && typeof navigator.modelContextTesting.executeTool === "function") {
      result = await navigator.modelContextTesting.executeTool(name, JSON.stringify(args));
    } else {
      return { ok: false, error: `The page doesn't offer the tool "${name}" anymore.` };
    }
    let text;
    if (result && Array.isArray(result.content)) text = result.content.map(c => (c && c.type === "text" ? c.text : `[${c && c.type}]`)).join("\n");
    else if (typeof result === "string") text = result;
    else { try { text = JSON.stringify(result === undefined ? null : result); } catch { text = String(result); } }
    text = String(text).slice(0, 8000);
    if (result && result.isError) return { ok: false, error: text.slice(0, 500) };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
}
