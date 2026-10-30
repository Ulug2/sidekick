// Web access for the assistant: search (used with OpenAI; Claude has built-in search)
// and reading a web page or PDF by URL. Results are fenced as untrusted content.
import { extractDocText } from "./docs.js";

export const UA_FETCH = { credentials: "omit", redirect: "follow" };
export const WEB_TIMEOUT_MS = 20000;

// Fetch options that give up after a while and also stop when you press Stop.
export function webFetchOpts(signal, ms = globalThis.SK_WEB_MS || WEB_TIMEOUT_MS) {
  const limit = AbortSignal.timeout(ms);
  return { ...UA_FETCH, signal: signal ? AbortSignal.any([signal, limit]) : limit };
}
// A timeout reads as "the site was slow", never as a crash; Stop stays a Stop.
export function webError(err, what, signal) {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return new Error(`${what} didn't answer within ${Math.round((globalThis.SK_WEB_MS || WEB_TIMEOUT_MS) / 1000)} s. Try again, or try another source.`);
  return err;
}

export function htmlToText(doc) {
  doc.querySelectorAll("script, style, noscript, svg, iframe, nav, footer, header, aside, form, [aria-hidden=true], [hidden]").forEach(e => e.remove());
  const root = doc.querySelector("article, main, [role=main]") || doc.body;
  if (!root) return "";
  const BLOCK = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|BLOCKQUOTE|PRE|BR|TABLE|UL|OL|DD|DT|FIGCAPTION)$/;
  let out = "";
  const walk = n => {
    if (n.nodeType === 3) { out += n.data; return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === "TD" || n.tagName === "TH") out += " | ";
    for (const c of n.childNodes) walk(c);
    if (BLOCK.test(n.tagName)) out += "\n";
  };
  walk(root);
  return out.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Your own machine and local network: routers, printers, NAS boxes, dev servers.
// (URL parsing already turns tricks like http://2130706433/ into 127.0.0.1.)
export function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/.test(h)
    || /^(0|127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
    || h === "::1" || h === "::" || /^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(h) || /^::ffff:/.test(h)
    || /^\d+$/.test(h);
}

export async function fetchUrlText(url, { max = 15000, signal } = {}) {
  try { return await fetchUrlTextInner(url, { max, signal }); }
  catch (err) { throw webError(err, "The site", signal); }
}

export async function fetchUrlTextInner(url, { max, signal }) {
  let u;
  try { u = new URL(url); } catch { throw new Error("That isn't a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links can be read.");
  if (isPrivateHost(u.hostname)) throw new Error("Sidekick doesn't read local network addresses.");
  const res = await fetch(u.href, webFetchOpts(signal));
  // A public link that redirects into your network (router, printer, NAS) is refused too.
  try { if (res.url && isPrivateHost(new URL(res.url).hostname)) throw new Error("redirect"); } catch { throw new Error("That link redirects to a local network address, which Sidekick doesn't read."); }
  if (!res.ok) throw new Error(`The site answered ${res.status} ${res.statusText}.`);
  const type = res.headers.get("content-type") || "";
  let title = u.hostname, text;
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
export async function webSearchFallback(query, limit = 6, { signal } = {}) {
  const tries = [
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
  let lastErr;
  for (const t of tries) {
    try {
      const results = (await t()).filter(r => /^https?:/.test(r.url)).slice(0, limit);
      if (results.length) return results;
    } catch (err) { if (signal?.aborted) throw webError(err, "", signal); lastErr = webError(err, "The search engine", signal); }
  }
  throw new Error("Web search didn't return results" + (lastErr ? ` (${lastErr.message})` : "") + ". Try different words, or open a site directly.");
}
