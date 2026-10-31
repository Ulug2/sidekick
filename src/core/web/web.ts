// Web access for the assistant: search (used with OpenAI; Claude has built-in search)
// and reading a web page or PDF by URL. Results are fenced as untrusted content.
import { extractDocText } from "../docs/docs.js";

export const UA_FETCH: RequestInit = { credentials: "omit", redirect: "follow" };
export interface SearchResult { title: string; url: string; snippet: string }
export const WEB_TIMEOUT_MS = 20000;

// Fetch options that give up after a while and also stop when you press Stop.
export function webFetchOpts(signal: AbortSignal | undefined, ms = globalThis.SK_WEB_MS || WEB_TIMEOUT_MS) {
  const limit = AbortSignal.timeout(ms);
  return { ...UA_FETCH, signal: signal ? AbortSignal.any([signal, limit]) : limit };
}
// A timeout reads as "the site was slow", never as a crash; Stop stays a Stop.
export function webError(err: any, what: string, signal?: AbortSignal): Error {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return new Error(`${what} didn't answer within ${Math.round((globalThis.SK_WEB_MS || WEB_TIMEOUT_MS) / 1000)} s. Try again, or try another source.`);
  return err;
}

export function htmlToText(doc: Document): string {
  doc.querySelectorAll("script, style, noscript, svg, iframe, nav, footer, header, aside, form, [aria-hidden=true], [hidden]").forEach(e => e.remove());
  const root = doc.querySelector("article, main, [role=main]") || doc.body;
  if (!root) return "";
  const BLOCK = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|BLOCKQUOTE|PRE|BR|TABLE|UL|OL|DD|DT|FIGCAPTION)$/;
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out += (n as Text).data; return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.tagName === "TD" || el.tagName === "TH") out += " | ";
    for (const c of n.childNodes) walk(c);
    if (BLOCK.test(el.tagName)) out += "\n";
  };
  walk(root);
  return out.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Your own machine and local network: routers, printers, NAS boxes, dev servers.
// (URL parsing already turns tricks like http://2130706433/ into 127.0.0.1.)
export function isPrivateHost(host: string): boolean {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/.test(h)
    || /^(0|127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
    || h === "::1" || h === "::" || /^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(h) || /^::ffff:/.test(h)
    || /^\d+$/.test(h);
}

export async function fetchUrlText(url: string, { max = 15000, signal }: { max?: number; signal?: AbortSignal } = {}): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  try { return await fetchUrlTextInner(url, { max, signal }); }
  catch (err) { throw webError(err, "The site", signal); }
}

// What Chrome's network layer saw for each request this page made: where a redirect pointed and
// which address answered. fetch hides a redirect's target (redirect: "manual" gives an opaque
// response), so read_url follows redirects itself and learns each target here (webRequest).
interface NetInfo { redirectUrl?: string; ip?: string }
function watchRequests() {
  const wr = globalThis.chrome?.webRequest;
  const seen = new Map<string, NetInfo>();
  const waiters = new Map<string, () => void>();
  const note = (d: { url: string; initiator?: string; redirectUrl?: string; ip?: string }) => {
    if (d.initiator && !d.initiator.startsWith("chrome-extension://")) return; // a web page's request to the same URL
    seen.set(d.url, { redirectUrl: d.redirectUrl, ip: d.ip });
    waiters.get(d.url)?.();
  };
  wr?.onBeforeRedirect.addListener(note, { urls: ["<all_urls>"] });
  wr?.onResponseStarted.addListener(note, { urls: ["<all_urls>"] });
  return {
    // The event can arrive a little after fetch resolves.
    async get(url: string, ms: number): Promise<NetInfo | undefined> {
      if (!seen.has(url) && wr) await new Promise<void>(r => { waiters.set(url, r); setTimeout(r, ms); });
      waiters.delete(url);
      return seen.get(url);
    },
    stop() { wr?.onBeforeRedirect.removeListener(note); wr?.onResponseStarted.removeListener(note); }
  };
}
const MAX_REDIRECTS = 10;
const LOCAL_REDIRECT = "That link redirects to a local network address, which Sidekick doesn't read.";

export async function fetchUrlTextInner(url: string, { max, signal }: { max: number; signal?: AbortSignal }) {
  let u;
  try { u = new URL(url); } catch { throw new Error("That isn't a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links can be read.");
  if (isPrivateHost(u.hostname)) throw new Error("Sidekick doesn't read local network addresses.");
  // Redirects are followed one hop at a time, and each target is checked before it's requested,
  // so a public link can't make Sidekick send a request into your network (router, printer, NAS).
  const opts: RequestInit = { ...webFetchOpts(signal), redirect: "manual" };
  const net = watchRequests();
  let res: Response;
  try {
    for (let hops = 0; ; hops++) {
      res = await fetch(u.href, opts);
      const key = (res.url || u.href).replace(/#.*$/, "");
      if (res.type !== "opaqueredirect") {
        // A public name can point at a private address (127.0.0.1.nip.io, DNS rebinding). The
        // request has gone out by then; the answer is still not read.
        const info = await net.get(key, 500);
        if (info?.ip && isPrivateHost(info.ip) || res.url && isPrivateHost(new URL(res.url).hostname)) throw new Error("That link is served from a local network address, which Sidekick doesn't read.");
        break;
      }
      if (hops >= MAX_REDIRECTS) throw new Error("That link redirects too many times.");
      const info = await net.get(key, 3000);
      if (!info?.redirectUrl) throw new Error("That link redirects somewhere Sidekick couldn't check, so it wasn't followed. Open it in a tab instead.");
      if (info.ip && isPrivateHost(info.ip)) throw new Error(LOCAL_REDIRECT);
      let next;
      try { next = new URL(info.redirectUrl, u); } catch { throw new Error("That link redirects to an invalid address."); }
      if (!/^https?:$/.test(next.protocol)) throw new Error("That link redirects to a non-web address, which Sidekick doesn't follow.");
      if (isPrivateHost(next.hostname)) throw new Error(LOCAL_REDIRECT);
      u = next;
    }
  } finally { net.stop(); }
  if (!res.ok) throw new Error(`The site answered ${res.status} ${res.statusText}.`);
  const type = res.headers.get("content-type") || "";
  let title = u.hostname, text: string;
  if (/pdf/i.test(type) || /\.pdf$/i.test(u.pathname)) {
    const blob = await res.blob();
    const file = new File([blob], u.pathname.split("/").pop() || "document.pdf", { type: "application/pdf" });
    text = (await extractDocText(file, { maxChars: max + 1 })).text;
    title = file.name;
  } else if (/html|xml/i.test(type) || !type) {
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    title = doc.title || title;
    text = htmlToText(doc);
  } else if (/^text\/|json/i.test(type)) {
    text = await res.text();
  } else {
    throw new Error(`Can't read ${type || "this kind of file"}.`);
  }
  return { url: res.url || u.href, title, text: text.slice(0, max), truncated: text.length > max };
}

// Keyless web search through DuckDuckGo's HTML page, with Bing as a fallback.
export async function webSearchFallback(query: string, limit = 6, { signal }: { signal?: AbortSignal } = {}): Promise<SearchResult[]> {
  const tries: (() => Promise<any[]>)[] = [ // result objects, or null for skipped entries (removed by filter(Boolean))
    async () => {
      const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), webFetchOpts(signal));
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      return [...doc.querySelectorAll(".result")].map(r => {
        const a = r.querySelector("a.result__a");
        if (!a) return null;
        let href = a.getAttribute("href") || "";
        const m = href.match(/[?&]uddg=([^&]+)/);
        if (m) href = decodeURIComponent(m[1]);
        if (href.startsWith("//")) href = "https:" + href;
        if (/duckduckgo\.com\/y\.js|ad_domain/.test(href)) return null; // ads
        return { title: a.textContent.trim(), url: href, snippet: r.querySelector(".result__snippet")?.textContent.trim() || "" };
      }).filter(Boolean);
    },
    async () => {
      const res = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(query), webFetchOpts(signal));
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      return [...doc.querySelectorAll("li.b_algo")].map(li => {
        const a = li.querySelector("h2 a");
        if (!a) return null;
        return { title: a.textContent.trim(), url: a.getAttribute("href"), snippet: (li.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_paractl") || {}).textContent?.trim() || "" };
      }).filter(Boolean);
    }
  ];
  let lastErr: any;
  for (const t of tries) {
    try {
      const results = (await t()).filter(r => /^https?:/.test(r.url)).slice(0, limit);
      if (results.length) return results;
    } catch (err) { if (signal?.aborted) throw webError(err, "", signal); lastErr = webError(err, "The search engine", signal); }
  }
  throw new Error("Web search didn't return results" + (lastErr ? ` (${lastErr.message})` : "") + ". Try different words, or open a site directly.");
}
