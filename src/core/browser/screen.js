// Seeing the current tab: screenshots and page text, with retries and clear errors.
import { pageReadProblem, pageReadSelection, pageReadText } from "../../page/read.js";

export const PROTECTED_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;
export const MAX_EDGE = 1568; // what vision models actually use; bigger only costs more

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found. Click into a web page, then try again.");
  return tab;
}

export const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// A page showing a dialog ("Leave site?", alert()) or a frozen page never answers a script
// call, and Chrome can stall a capture. Never wait forever: give up with a clear error.
export const PAGE_READ_MS = 15000;
export function pageTimeout(promise, ms = globalThis.SK_PAGE_MS || PAGE_READ_MS) {
  if (!ms) return promise;
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("The page isn't responding. It may be showing a dialog (like \"Leave site?\" or an alert) or be frozen. Close the dialog and try again."), { name: "PageTimeout" })), ms); });
  promise.catch(() => {});
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export function explainCaptureError(reason, url) {
  if (PROTECTED_URL.test(url)) return `Chrome doesn't allow extensions to see this page (${url.split("?")[0]}). Switch to a normal website.`;
  if (url.startsWith("file:")) return "To see local files, turn on 'Allow access to file URLs' in chrome://extensions → Sidekick → Details.";
  if (/permission|all_urls|activeTab|Cannot access/i.test(reason)) return "Chrome blocked Sidekick from this page. In chrome://extensions → Sidekick → Details, set Site access to 'On all sites', then reload the page.";
  if (/dragging|not visible|minimized|hidden/i.test(reason)) return "The window isn't visible right now. Bring the Chrome window to the front and try again.";
  return `Couldn't capture the tab: ${reason}`;
}

// Downscales big Retina screenshots (keeps PNG for crisp text when small enough).
export async function shrinkImage(dataUrl, maxEdge = MAX_EDGE, targetW) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = targetW ? targetW / bmp.width : Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  if (k >= 0.999) return { dataUrl, width: bmp.width, height: bmp.height };
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return { dataUrl: await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }), width: w, height: h };
}

// Screenshot of the visible part of the active tab, ready to send to a model.
// raw: full resolution (for cropping an area), otherwise downscaled for the model.
export async function captureScreen({ tab, raw = false } = {}) {
  tab ||= await activeTab();
  const url = tab.url || tab.pendingUrl || "";
  if (PROTECTED_URL.test(url)) throw new Error(explainCaptureError("", url));
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const shot = await pageTimeout(chrome.tabs.captureVisibleTab(tab.windowId, raw ? { format: "png" } : { format: "jpeg", quality: 80 }));
      return raw ? shot : (await shrinkImage(shot)).dataUrl;
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      // Chrome allows only ~2 captures per second; wait and retry.
      if (/MAX_CAPTURE|quota|rate/i.test(msg)) { await sleepMs(650); continue; }
      if (/dragging|busy/i.test(msg)) { await sleepMs(300); continue; }
      break;
    }
  }
  throw new Error(explainCaptureError(lastErr?.message || String(lastErr), url));
}

// timeoutMs 0: no limit (for scripts that wait for you, like picking an area).
export async function runInPage(func, args = [], what = "read", tabId, timeoutMs) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab();
  const url = tab.url || tab.pendingUrl || "";
  if (PROTECTED_URL.test(url)) throw new Error(explainCaptureError("", url));
  try {
    const [res] = await pageTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }), timeoutMs);
    return res?.result;
  } catch (err) {
    if (err.name === "PageTimeout") throw err;
    if (url.toLowerCase().split("?")[0].endsWith(".pdf")) {
      throw new Error("Chrome's PDF viewer can't be read by extensions. Use 'Explain screen' or the area tool to show it as an image, or give me the PDF's link.");
    }
    throw new Error(explainCaptureError(err?.message || String(err), url));
  }
}

export async function readPageText(limit = 60000) {
  return runInPage(pageReadText, [limit]);
}

// Text of the tab including its frames (MyOpenMath and other LTI tools run inside a Moodle
// iframe from another site). Frames with the most text come first; tiny frames are skipped.
export async function readProblemText(limit = 8000) {
  const tab = await activeTab();
  const url = tab.url || tab.pendingUrl || "";
  if (PROTECTED_URL.test(url)) return null;
  let frames;
  try {
    frames = await pageTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageReadProblem
    }));
  } catch (err) {
    // The whole page is off limits (site access settings, the PDF viewer, …): say so instead of silence.
    return { url, text: `[Sidekick can't read this page: ${explainCaptureError(err?.message || String(err), url)}]`, truncated: false, blocked: [] };
  }
  // Embedded tools (the problem itself) first, biggest first; the outer page (menus, course nav) last.
  // Frames on the page that Sidekick couldn't read (reported to the model, which tells you).
  const seen = (frames || []).flatMap(f => f.result?.frames || []);
  const readN = (frames || []).filter(f => f.frameId !== 0 && f.result).length;
  const readHosts = new Set((frames || []).filter(f => f.frameId !== 0 && f.result).map(f => { try { return new URL(f.result.url).hostname; } catch { return ""; } }));
  const blocked = seen.length > readN ? [...new Set(seen.filter(h => h && !readHosts.has(h)))] : [];
  const blockedNote = seen.length > readN ? `\n\n[Sidekick couldn't read ${seen.length - readN > 1 ? `${seen.length - readN} embedded frames` : "an embedded frame"} on this page${blocked.length ? ` (from ${blocked.join(", ")})` : ""}; Chrome didn't allow access or it was still loading. If the problem may be in there, say so.]` : "";
  const parts = (frames || []).filter(f => f.result && f.result.text && f.result.text.length > 40)
    .sort((a, b) => (a.frameId === 0) - (b.frameId === 0) || b.result.text.length - a.result.text.length)
    .map(f => f.result);
  if (!parts.length) return blockedNote ? { url, text: blockedNote.trim(), truncated: false, blocked } : null;
  let text = "";
  for (const p of parts) {
    if (text.length >= limit) break;
    text += (text ? `\n\n--- frame: ${p.url.split("?")[0]} ---\n` : "") + p.text;
  }
  return { url: parts[0].url, text: text.slice(0, limit) + blockedNote, truncated: text.length > limit, blocked };
}

export async function readSelectionFromPage() {
  const text = await runInPage(pageReadSelection);
  return (text || "").trim();
}
