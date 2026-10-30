// Injected into web pages with chrome.scripting.executeScript({ func }), which sends the
// function's source text: it must not use anything outside its own body (no imports, no helpers).

// Runs in the page's own world (MAIN): stops a half-filled form's "Leave site?" prompt when the
// agent itself leaves the page.
export const pageDisarmLeavePrompt = () => {
  // The page's handlers can't be removed, but the prompt only appears if one of them cancels
  // the event or sets returnValue. Make both do nothing (only for this page, which we're leaving).
  window.onbeforeunload = null;
  const P = BeforeUnloadEvent.prototype;
  Object.defineProperty(P, "returnValue", { get: () => "", set: () => {}, configurable: true });
  P.preventDefault = function () {};
};
