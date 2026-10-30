// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

// Readable text of the page (its main content when there is one).
export const pageReadText = (max: number) => {
  const main = document.querySelector<HTMLElement>("article, main, [role=main]");
  const root = main && main.innerText.trim().length > 500 ? main : document.body;
  const text = root.innerText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: document.title || location.hostname, url: location.href, text: text.slice(0, max), truncated: text.length > max };
};

// Text of one frame for reading a problem on screen, plus the embedded frames it can see.
export interface ProblemFrame { url: string; text: string; frames: string[] }
export const pageReadProblem = (): ProblemFrame => {
  const main = document.querySelector<HTMLElement>("article, main, [role=main], .question, #questionwrap, form");
  const root = main && main.innerText.trim().length > 200 ? main : document.body;
  const text = (root?.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const frames = [...document.querySelectorAll("iframe, frame")].filter(f => { const r = f.getBoundingClientRect(); return r.width >= 120 && r.height >= 80; })
    .map(f => { try { return new URL((f as HTMLIFrameElement).src || "about:blank", location.href).hostname; } catch { return ""; } });
  return { url: location.href, text, frames };
};

// The selected text, including inside a text field.
export const pageReadSelection = (): string => {
  const el = document.activeElement as HTMLInputElement | null;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && typeof el.selectionStart === "number") {
    return el.value.slice(el.selectionStart, el.selectionEnd as number);
  }
  return window.getSelection()!.toString();
};
