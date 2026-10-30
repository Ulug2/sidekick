// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

// Replaces the selected text (in a text field or an editable element) with t.
export const pageReplaceSelection = (t: string): boolean => {
  const el = document.activeElement as HTMLInputElement | null;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
    el.focus();
    if (document.execCommand("insertText", false, t)) return true;
    const s = el.selectionStart as number, e = el.selectionEnd as number;
    el.value = el.value.slice(0, s) + t + el.value.slice(e);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  const sel = window.getSelection()!;
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const node = (sel.anchorNode!.nodeType === 1 ? sel.anchorNode : sel.anchorNode!.parentElement) as HTMLElement | null;
  if (node && node.isContentEditable) return document.execCommand("insertText", false, t);
  return false;
};
