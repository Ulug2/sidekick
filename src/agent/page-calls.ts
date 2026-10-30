// Calling into the agent's tab: scripts in the page (with a time limit and Stop), waiting for loads.

// ---------- page plumbing ----------

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Calls into a page can hang forever when the page shows a dialog ("Leave site?", alert()) or
// freezes. That's what froze the agent mid-way through several applications. Never wait forever.
export const PAGE_TIMEOUT_MS = 15000;
export let agentSignal: AbortSignal | null = null; // the running task's Stop signal: Stop works even while a page hangs
export function setAgentSignal(signal: AbortSignal | null): void { agentSignal = signal; }
export function pageScript<R>(details: { target: chrome.scripting.InjectionTarget; func: (...args: any[]) => R; args?: unknown[]; world?: "MAIN" | "ISOLATED" }): Promise<chrome.scripting.InjectionResult<Awaited<R>>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined, onStop!: () => void;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("The page isn't responding. It may be showing a dialog (like \"Leave site?\" or an alert) or be frozen."), { name: "PageTimeout" })), globalThis.SK_PAGE_MS || PAGE_TIMEOUT_MS);
    onStop = () => reject(new DOMException("Stopped", "AbortError"));
    if (agentSignal?.aborted) onStop(); else agentSignal?.addEventListener("abort", onStop, { once: true });
  });
  const run = chrome.scripting.executeScript(details as any) as Promise<chrome.scripting.InjectionResult<Awaited<R>>[]>;
  run.catch(() => {});
  return Promise.race([run, limit]).finally(() => { clearTimeout(timer); agentSignal?.removeEventListener("abort", onStop); });
}

export async function waitForTab(tabId: number, maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("The tab was closed.");
    if (tab.status === "complete") break;
    await sleep(250);
  }
  await sleep(500); // give single-page apps a moment to update
}

export const PROTECTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

export const pageKey = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url || ""); } };

export const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };
