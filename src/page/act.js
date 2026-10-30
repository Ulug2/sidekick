// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

// Performs one action on the element with the given data-sk-id, after briefly highlighting it.
export async function skPageAct(a) {
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
