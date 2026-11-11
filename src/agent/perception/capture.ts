// Seeing the page: a snapshot of every frame, parsed into the elements the model can act on.
import type { AgentState, SnapshotOptions, Capture, FrameSnapshot } from "../types.js";
import { PROTECTED, pageScript, hostOf } from "../page-calls.js";
import { skPageSnapshot } from "../../page/snapshot.js";
import { skWebMCPList } from "../../page/webmcp.js";

// ---------- seeing the page ----------
// captureTab reads every frame (elements, headings, errors, text, the site's own agent tools)
// and updates state.elements. formatSnapshot turns that into text for the model: a full
// snapshot the first time on a page, then only what changed since (ids stay the same), which
// keeps each step small and fast.

export async function captureTab(state: AgentState, opts: SnapshotOptions = {}): Promise<Capture> {
  const tab = await chrome.tabs.get(state.tabId);
  const url = tab.url || tab.pendingUrl || "";
  const cap: Capture = { title: tab.title || "", url, frames: [], siteTools: [] };
  if (PROTECTED.test(url)) { state.elements = {}; state.siteTools = {}; cap.protected = true; return cap; }
  let results: chrome.scripting.InjectionResult<FrameSnapshot | null>[];
  try {
    results = await pageScript({ target: { tabId: state.tabId, allFrames: true }, func: skPageSnapshot, args: [opts] });
  } catch (err: any) {
    cap.error = err.message;
    return cap;
  }
  state.elements = {};
  state.frameHosts = new Set(results.filter(r => r.frameId !== 0 && r.result).map(r => hostOf(r.result!.url)).filter(Boolean));
  const top = results.find(r => r.frameId === 0)?.result;
  // Embedded frames we can see but couldn't get into (Chrome kept Sidekick out, or they're still
  // loading). These are reported, never silently skipped.
  {
    const seen = results.flatMap(r => r.result?.frames || []);
    const read = results.filter(r => r.frameId !== 0 && r.result);
    const readHosts = new Set(read.map(r => hostOf(r.result!.url)));
    if (seen.length > read.length) {
      const hosts = [...new Set(seen.map(f => f.host).filter(h => h && !readHosts.has(h)))];
      cap.blockedFrames = { count: seen.length - read.length, hosts };
    }
  }
  if (top) {
    cap.title = top.title || cap.title;
    cap.url = top.url || url;
    cap.scroll = top.scroll;
    state.viewport = { width: top.scroll.width, height: top.scroll.viewport };
  }
  for (const r of results.sort((a, b) => a.frameId - b.frameId)) {
    const snap = r.result;
    if (!snap || (!snap.isTop && !snap.elements.length)) continue;
    const prefix = r.frameId === 0 ? "" : `${r.frameId}:`;
    let section = "";
    const lines = [];
    for (const raw of snap.elements) {
      if (raw.startsWith("## ")) { section = raw.slice(3); lines.push(raw); continue; }
      const l = prefix ? raw.replace(/^\[(\d+)\]/, `[${prefix}$1]`) : raw;
      const m = l.match(/^\[([\d:]+)\] (\S+) "(.*?)"/);
      if (m) state.elements[m[1]] = { role: m[2], label: m[3], line: l, frameId: r.frameId, host: hostOf(snap.url), section };
      lines.push(l);
    }
    const formTools = (snap.formTools || []).filter(t => t.name).map(t => ({ ...t, form: prefix + t.form, frameId: r.frameId }));
    cap.frames.push({ frameId: r.frameId, url: snap.url, isTop: r.frameId === 0, dialog: snap.dialog, headings: snap.headings || [], errors: snap.errors || [], lines, skipped: snap.skipped, traps: snap.traps || 0, text: snap.text || "", textLength: snap.textLength || 0, formTools });
  }
  // Tools the site offers to AI agents (WebMCP), registered in the page's own JavaScript.
  try {
    const [res] = await pageScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "MAIN", func: skWebMCPList, args: [] });
    if (Array.isArray(res?.result)) cap.siteTools.push(...res.result.filter(t => t && t.name));
  } catch {}
  for (const f of cap.frames) {
    for (const t of f.formTools) {
      const properties: Record<string, object> = {}, required: string[] = [];
      for (const p of t.params) {
        properties[p.name] = { type: p.type === "checkbox" ? "boolean" : p.type === "number" ? "number" : "string", ...(p.description && { description: p.description }), ...(p.options && { enum: p.options }) };
        if (p.required) required.push(p.name);
      }
      if (!cap.siteTools.some(x => x.name === t.name)) cap.siteTools.push({ name: t.name, description: t.description, inputSchema: { type: "object", properties, required }, readOnly: false, source: "form", form: t.form, autosubmit: t.autosubmit });
    }
  }
  state.siteTools = Object.fromEntries(cap.siteTools.map(t => [t.name, t]));
  return cap;
}
export const stripOffscreen = (l: string) => l.replace(/,? offscreen\b/, "").replace(/ $/, "");
