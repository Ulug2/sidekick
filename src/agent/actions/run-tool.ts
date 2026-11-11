// Runs one tool call: safety gates first, then the action, then the updated page.
import type { AgentState, AgentUI, PageActionResult, ToolOutcome } from "../types.js";
import { skPageAct } from "../../page/act.js";
import { logApplication, type Profile } from "../../assistant/profile-core.js";
import { factsFromAnswer } from "../../assistant/session.js";
import { addMemory } from "../../assistant/memory/memory.js";
import { describeSafe, describeCall, quote } from "./describe.js";
import { RISKY_WORDS, siteBlocked, gateShare, gateVisit, CAPTCHA_RE, policyContext, inPlan } from "../safety/gates.js";
import { decide } from "../../orchestrator/policy.js";
import { logAction } from "../../orchestrator/log.js";
import { buildWorld, worldQuery } from "../../orchestrator/world.js";
import { sleep, waitForTab, hostOf, pageScript } from "../page-calls.js";
import { snapshotTab, groupRepeats } from "../perception/format.js";
import { trustedInput, actInPage, viaTrusted, disarmLeavePrompt } from "./input.js";
import { redactSecrets, untrusted } from "../../core/security/guard.js";
import { replayShortcut } from "./replay.js";
import { skWebMCPCall } from "../../page/webmcp.js";
import { captureTab, stripOffscreen } from "../perception/capture.js";
import { webSearchFallback } from "../../core/web/web.js";
import { planText } from "../loop/plan.js";
import { cropImage, pageTimeout, shrinkImage } from "../../core/browser/screen.js";
import { addToAgentGroup } from "../loop/tab-group.js";
import { questionOfLine, nthOf, roleFamily, getAdapters, changeAdapters, adaptersFor } from "../skills/shortcuts.js";
import { siteOf } from "../../core/security/sites.js";
import { personalDetailsIn } from "../../core/security/personal-data.js";
import type { ToolCall } from "../../core/llm/types.js";

export const CHECK_BEFORE_DONE = "Not finished yet: you typed values after looking at a screenshot and haven't looked since. Take a screenshot, zoom into every graph, chart, table or number you read a value from, and compare each typed value with what's really there (read each figure's own scale; never assume two figures share one). Fix any mistake, then call done again.";
// Zoomed views are drawn so their long side is about this many pixels.
export const ZOOM_EDGE = 1200;
export const ACTING_TOOLS = new Set(["click", "click_at", "type", "select_option", "pick_date", "set_checked", "upload_file", "press_key", "site_tool"]);
// Tools that end by showing the updated page.
export const SNAPSHOT_TOOLS = new Set(["click", "click_at", "type", "select_option", "pick_date", "set_checked", "upload_file", "press_key", "scroll", "navigate", "go_back", "open_tab", "switch_tab", "wait", "fill_fields", "use_shortcut", "site_tool"]);
// Successful actions that are recorded to learn a shortcut.
export const LEARNABLE = new Set(["click", "type", "select_option", "set_checked", "upload_file", "press_key"]);

// Records every successful action (by meaning: role, label, question, section) for learning,
// and every failure for the site notes.
export async function runTool(call: ToolCall, state: AgentState, ui: AgentUI, profile: Profile, takeTabNote: () => string): Promise<ToolOutcome> {
  const a = call.args || {};
  const id = String(a.id ?? "");
  const el = state.elements[id];
  const target = el && { role: el.role, label: el.label, question: questionOfLine(el.line), section: el.section || "", nth: nthOf(state.elements, id), host: el.host, site: siteOf("https://" + el.host) };
  const safe = describeSafe(call, el);
  const r = await runToolInner(call, state, ui, profile, takeTabNote);
  state.safeSteps.push(safe + (r.failed ? (r.declined ? " (declined)" : " (failed)") : ""));
  // Values never go into learning: only what was done, where, and what went wrong.
  if (r.failed && !r.declined) state.errors.push(`${safe}: ${String(r.errorMsg || "").replace(/"[^"]{1,200}"/g, "\"…\"").slice(0, 160)}`);
  if (!r.failed && LEARNABLE.has(call.name) && target) {
    const value = call.name === "type" ? a.text : call.name === "select_option" ? a.option : call.name === "set_checked" ? !!a.checked : call.name === "press_key" ? a.key : call.name === "upload_file" ? a.file : undefined;
    const final = !!a.final_action || RISKY_WORDS.test(target.label) || RISKY_WORDS.test(a.description || "");
    state.actionLog.push({ tool: call.name, ...target, value, final, description: a.description || "" });
  }
  return r;
}

export async function runToolInner(call: ToolCall, state: AgentState, ui: AgentUI, profile: Profile, takeTabNote: () => string): Promise<ToolOutcome> {
  const a = call.args || {};
  const label = describeCall(call, state);
  // Checklist updates show in the checklist itself, not as steps.
  const quiet = call.name === "plan";
  const step = quiet ? { done() {}, waiting() {} } : ui.step(label, call.name);
  if (!quiet) state.steps.push(label);
  const fail = (msg: string): ToolOutcome => { step.done(false, msg); return { text: `Error: ${msg}`, failed: true, errorMsg: msg }; };
  const withSnapshot = async (prefix = "", opts = {}) => {
    if (state.deferSnapshot) {
      await sleep(120);
      return { text: `${prefix}Done. (The updated page comes after your last action this turn.)` };
    }
    await waitForTab(state.tabId);
    const text = `${prefix}${takeTabNote()}${await snapshotTab(state, opts)}`;
    return { text, snapshot: state.lastSnapshotKind };
  };

  const declined = () => {
    step.done(false, "You declined");
    return { text: "The user declined this action. Don't retry it. Ask what they'd like instead, or finish with done.", failed: true, declined: true };
  };
  const askApproval = async (title: string, detail: string) => {
    step.waiting();
    return ui.approve({ title, detail });
  };
  // A web page can trick the model into "visiting" a URL that carries your data to someone
  // else (https://evil.example/?d=your@email). Such URLs need your OK.
  const urlLooksSafe = async (url: string) => {
    const personal = personalDetailsIn(url, profile);
    let longData = false;
    try { const u = new URL(url); longData = (u.search + u.hash).length > 300; } catch {}
    if (!personal.length && !longData) return true;
    return askApproval(`Open ${hostOf(url) || "this link"}? The link ${personal.length ? `contains your ${personal.join(", ")}` : "carries a lot of data"}`, `\`${String(url).slice(0, 300)}\``);
  };

  try {
    if (["click", "click_at", "press_key", "site_tool", "type", "select_option"].includes(call.name)) state.lastActionAt = Date.now();
    if (state.lookedAt && ["type", "select_option", "pick_date"].includes(call.name)) state.typedAfterLook = Date.now();
    // Site rules and "ask before every action" mode.
    if (ACTING_TOOLS.has(call.name)) {
      const tab = await chrome.tabs.get(state.tabId);
      const blocked = siteBlocked(state, tab.url || "");
      if (blocked) return fail(`${blocked} is on your "never act on" list in Settings, so I can read this page but not click or type here. Ask the user to do this step.`);
      // Re-check the site right before acting: if the tab moved to another site since the page
      // view the model is acting on, its ids belong to the old page. Don't act; show the new one.
      const nowHost = hostOf(tab.url || "");
      if (state.lastSnapHost && nowHost && nowHost !== state.lastSnapHost) {
        const msg = `The tab moved to ${nowHost} since your last look (it was ${state.lastSnapHost}), so nothing was done.`;
        step.done(false, msg);
        return { text: `Error: ${msg} Here's the page now:\n${await snapshotTab(state)}`, failed: true, errorMsg: msg, snapshot: state.lastSnapshotKind };
      }
      // Your personal details on a site for the first time: checked against your request.
      const typed = call.name === "type" ? a.text : call.name === "select_option" ? a.option : "";
      if (typed) {
        const kinds = personalDetailsIn(String(typed), profile);
        const el = state.elements[String(a.id)];
        const site = siteOf(el?.host ? "https://" + el.host : tab.url || "");
        if (kinds.length && !(await gateShare(state, site, kinds, el?.label || "a field", askApproval))) return declined();
      }
      const alwaysAsk = state.settings.approvalMode === "every" && !["click", "click_at", "site_tool"].includes(call.name);
      if (alwaysAsk && !(await askApproval(label, ""))) return declined();
    }
    const everyClick = state.settings.approvalMode === "every";

    switch (call.name) {
      case "click": {
        const el = state.elements[String(a.id)];
        if (!el) return fail(`Element [${a.id}] isn't in the latest snapshot.`);
        // A "prove you're human" check is for the human. Sidekick never tries to pass one (rule in code, not only in the prompt).
        if (CAPTCHA_RE.test(`${el.label} ${el.section} ${a.description || ""}`)) return fail("That's a CAPTCHA or a 'verify you are human' check. Sidekick never tries to pass those. Use ask_user so the user does it, then continue.");
        if (everyClick || a.final_action || RISKY_WORDS.test(el.label) || RISKY_WORDS.test(a.description || "")) {
          const site = siteOf(el.host ? "https://" + el.host : (await chrome.tabs.get(state.tabId)).url || "");
          const d = decide({ kind: "final-click", site, label: el.label, description: a.description }, await policyContext(state));
          if (d.verdict === "refuse") return fail(d.reason);
          if (d.verdict === "run") ui.note(d.note || `Submitting without asking: ${a.description || el.label}`);
          else if (!(await askApproval(`Click ${quote(el.label)} on ${el.host || "this page"}`, a.description || ""))) return declined();
          if (a.final_action || RISKY_WORDS.test(el.label)) logAction({ worker: state.task?.n, kind: "submit", what: `Clicked “${el.label}” on ${site}`, why: a.description || "", site, jobId: state.task?.jobId, ...(d.verdict === "run" && { why: `${a.description || ""} (pre-approved)` }) }).catch(() => {});
        }
        const input = el.frameId === 0 ? await trustedInput(state) : null;
        if (input) {
          const loc = await actInPage(state, { op: "locate", id: a.id });
          if (!loc.ok) return fail(loc.error);
          if (await viaTrusted(state, () => input.click(loc.x!, loc.y!))) {
            state.lastActionAt = Date.now();
            step.done(true);
            return withSnapshot(loc.covered ? `Note: "${loc.covered}" was on top of that element, so the click may have hit it instead.\n\n` : "");
          }
        }
        const r = await actInPage(state, { op: "click", id: a.id });
        if (!r.ok) return fail(r.error);
        step.done(true);
        return withSnapshot(r.note ? r.note + "\n\n" : "");
      }
      case "click_at": {
        const x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fail("click_at needs numeric x and y.");
        if (state.viewport && (x < 0 || y < 0 || x > state.viewport.width || y > state.viewport.height)) return fail(`(${x}, ${y}) is outside the visible page (${state.viewport.width}×${state.viewport.height}). Coordinates must come from the latest screenshot, and scrolling moves everything: after a scroll, take a new screenshot first. Better: use the element's id from the snapshot (click, select_option, pick_date).`);
        const what = await actInPage(state, { op: "describe_point", x, y });
        if (!what.ok) return fail(what.error);
        if (everyClick || a.final_action || RISKY_WORDS.test(what.label!) || RISKY_WORDS.test(a.description || "")) {
          if (!(await askApproval(`Click ${quote(what.label)} at (${x}, ${y})`, a.description || ""))) return declined();
        }
        const input = await trustedInput(state);
        if (!input || !(await viaTrusted(state, () => input.click(x, y)))) {
          const r = await actInPage(state, { op: "click_point", x, y });
          if (!r.ok) return fail(r.error);
        }
        state.lastActionAt = Date.now();
        step.done(true);
        return withSnapshot(`Clicked ${quote(what.label)} at (${x}, ${y}).\n\n`);
      }
      case "type": {
        const el = state.elements[String(a.id)];
        if (!el) return fail(`Element [${a.id}] isn't in the latest snapshot.`);
        if (redactSecrets(a.text || "").count) return fail("That text contains a card number, ID number or key. Sidekick never types those. Ask the user.");
        const input = await trustedInput(state);
        if (input) {
          const prep = await actInPage(state, { op: "prepare_type", id: a.id, text: a.text, clear: a.clear });
          if (!prep.ok) return fail(prep.error);
          // Math boxes (MathQuill) are cleared like a person would: End, then Backspace.
          const typeIt = async () => {
            if (prep.math && prep.erase) {
              await input.key("End");
              for (let i = 0; i < Math.min(prep.erase + 2, 80); i++) await input.key("Backspace");
            }
            await input.insertText(String(a.text ?? ""));
          };
          if (await viaTrusted(state, typeIt)) {
            step.done(true);
            return withSnapshot();
          }
        }
        const r = await actInPage(state, { op: "type", ...a });
        if (!r.ok) return fail(r.error);
        step.done(true);
        return withSnapshot(r.note ? r.note + "\n\n" : "");
      }
      case "press_key": {
        const input = await trustedInput(state);
        if (input && (!a.id || state.elements[String(a.id)]?.frameId === 0 || String(a.id).includes(":"))) {
          const info = await actInPage(state, { op: "enter_check", id: a.id });
          // A real Enter submits forms, so it counts as a final action in bigger forms.
          if (a.key === "Enter" && info.ok && info.formFields! > 2 && !info.inTextarea) {
            const tabNow = await chrome.tabs.get(state.tabId);
            const site = siteOf(tabNow.url || "");
            const buttons = Object.values(state.elements).filter(e => /button|submit/.test(e.role)).map(e => e.label).slice(0, 40).join(" ");
            const d = decide({ kind: "enter-submit", site, context: `${tabNow.title || ""} ${tabNow.url || ""} ${buttons}` }, await policyContext(state));
            if (d.verdict === "refuse") return fail(d.reason);
            if (d.verdict === "run") ui.note(d.note || "Pressing Enter to submit, as you approved");
            else if (!(await askApproval("Press Enter, which will submit this form", ""))) return declined();
            logAction({ worker: state.task?.n, kind: "submit", what: `Pressed Enter to submit a form on ${site}`, why: d.verdict === "run" ? "pre-approved" : "approved", site, jobId: state.task?.jobId }).catch(() => {});
          }
          if (await viaTrusted(state, () => input.key(a.key))) {
            state.lastActionAt = Date.now();
            step.done(true);
            return withSnapshot();
          }
        }
        const r = await actInPage(state, { op: "press_key", ...a });
        if (!r.ok) return fail(r.error);
        step.done(true);
        return withSnapshot(r.note ? r.note + "\n\n" : "");
      }
      case "select_option":
      case "pick_date":
      case "set_checked":
      case "scroll": {
        if (call.name !== "scroll" && !state.elements[String(a.id)]) {
          return fail(`Element [${a.id}] isn't in the latest snapshot.`);
        }
        const r = await actInPage(state, { op: call.name, ...a });
        if (!r.ok) return fail(r.error);
        // Show what was actually chosen ("Selected “Dulles International Airport(IAD)…”").
        step.done(true, call.name === "select_option" || call.name === "pick_date" ? r.note : undefined);
        return withSnapshot(r.note ? r.note + "\n\n" : "");
      }
      case "fill_fields": {
        const fields = Array.isArray(a.fields) ? a.fields.slice(0, 40) : [];
        if (!fields.length) return fail("fill_fields needs a list of {id, value}.");
        const problems = [];
        let filled = 0;
        const deferWas = state.deferSnapshot;
        for (const f of fields) {
          const fid = String(f?.id ?? "");
          const el = state.elements[fid];
          if (!el) { problems.push(`[${fid}] isn't in the latest snapshot`); continue; }
          const v = f.value == null ? "" : String(f.value);
          const fam = roleFamily(el.role);
          const sub = fam === "choice" || (/^\d{4}-\d{2}-\d{2}$/.test(v) && fam !== "check" && fam !== "radio" && fam !== "file") ? { name: "select_option", args: { id: fid, option: v } }
            : fam === "check" || fam === "radio" ? { name: "set_checked", args: { id: fid, checked: !/^(false|no|off|0|unchecked)$/i.test(v) } }
            : fam === "file" ? { name: "upload_file", args: { id: fid, file: /cover/i.test(v) ? "cover_letter" : "resume" } }
            : fam === "text" ? { name: "type", args: { id: fid, text: v } }
            : null;
          if (!sub) { problems.push(`[${fid}] ${el.role} "${el.label}" isn't a form field; use click`); continue; }
          state.deferSnapshot = true;
          const r = await runTool({ id: `${call.id}_${fid}`, name: sub.name, args: sub.args }, state, ui, profile, () => "");
          state.deferSnapshot = deferWas;
          if (r.failed) problems.push(`[${fid}] "${el.label}": ${r.declined ? "you declined" : r.errorMsg}`);
          else filled++;
        }
        if (!filled) return fail(`Couldn't fill any field:\n${problems.map(p => "- " + p).join("\n")}`);
        step.done(true, problems.length ? `${problems.length} field${problems.length > 1 ? "s" : ""} need attention` : undefined);
        return withSnapshot(`Filled ${filled} of ${fields.length} fields.${problems.length ? `\nProblems:\n${problems.map(p => "- " + p).join("\n")}` : ""}\n\n`);
      }
      case "use_shortcut": {
        // A shortcut only ever runs on the site it was learned on: a greenhouse.io shortcut on
        // another site would type your details into someone else's form.
        const here = siteOf((await chrome.tabs.get(state.tabId)).url || "");
        const shortcut = (await getAdapters()).find(x => x.id === a.shortcut_id);
        if (!shortcut) return fail(`No shortcut "${a.shortcut_id}" for this site.`);
        if (shortcut.site !== here) return fail(`That shortcut is for ${shortcut.site}, not ${here}. Shortcuts only run on the site they were learned on.`);
        step.done(true);
        const r = await replayShortcut(shortcut, state, ui, profile);
        const ok = !r.failedAt;
        await changeAdapters(list => {
          const saved = list.find(x => x.id === shortcut.id);
          if (!saved) return undefined;
          saved.replays = (saved.replays || 0) + 1;
          if (ok) saved.replayOk = (saved.replayOk || 0) + 1;
          return list;
        });
        const head = `Shortcut "${shortcut.title}": did ${r.done.length} of ${shortcut.steps.length} steps${r.done.length ? ` (${r.done.slice(0, 20).join("; ")})` : ""}.\n${r.stop ? `Stopped: ${r.stop}` : "All steps done."}\nContinue the task from here.\n\n`;
        return withSnapshot(head, { forceFull: true });
      }
      case "site_tool": {
        const t = state.siteTools?.[a.name];
        if (!t) return fail(`This page doesn't offer a tool named "${a.name}". Use the tools listed in the snapshot.`);
        const args = a.arguments && typeof a.arguments === "object" && !Array.isArray(a.arguments) ? a.arguments : {};
        if (redactSecrets(JSON.stringify(args)).count) return fail("Those arguments contain a card number, ID number or key. Sidekick never sends those. Ask the user.");
        const missing = (t.inputSchema?.required || []).filter(k => args[k] === undefined || args[k] === "");
        if (missing.length) return fail(`Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
        const tab = await chrome.tabs.get(state.tabId);
        const host = hostOf(tab.url || "") || "this site";
        // Read-only tools run without asking, unless the arguments carry your personal details:
        // sending your email or phone to a site is never automatic.
        const personal = personalDetailsIn(JSON.stringify(args), profile);
        {
          const d = decide({ kind: "site-tool", site: siteOf(tab.url || ""), name: t.name, description: t.description || "", readOnly: !!t.readOnly, autosubmit: !!t.autosubmit, personal: personal.length > 0 }, await policyContext(state));
          if (d.verdict === "refuse") return fail(d.reason);
          if (d.verdict === "ask" || (everyClick && !t.readOnly)) {
            const detail = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n").slice(0, 600);
            if (!(await askApproval(`Use ${host}'s “${t.name}” tool${t.autosubmit ? " (submits the form)" : ""}${personal.length ? ` (sends your ${personal.join(", ")})` : ""}`, detail))) return declined();
          }
          if (!t.readOnly) logAction({ worker: state.task?.n, kind: "site_tool", what: `Used ${host}'s “${t.name}” tool${t.autosubmit ? " (submitted)" : ""}`, site: siteOf(tab.url || ""), jobId: state.task?.jobId }).catch(() => {});
        }
        if (t.source === "form") {
          const r = await actInPage(state, { op: "fill_form_tool", id: t.form, values: args, submit: !!t.autosubmit });
          if (!r.ok) return fail(r.error);
          step.done(true);
          return withSnapshot(`Filled the site's "${t.name}" form (${r.filled!.join(", ") || "nothing"})${r.missing!.length ? `; couldn't fill: ${r.missing!.join(", ")}` : ""}. ${r.submitted ? "It was submitted." : "Not submitted yet: click the form's submit button to send it (that click needs approval)."}\n\n`);
        }
        const [res] = await pageScript({ target: { tabId: state.tabId, frameIds: [0] }, world: "MAIN", func: skWebMCPCall, args: [{ name: t.name, args }] });
        const out = res?.result || { ok: false, error: "The page didn't respond." };
        if (!out.ok) return fail(`The site's tool failed: ${out.error}`);
        step.done(true);
        return withSnapshot(`The site's "${t.name}" tool returned:\n${untrusted(host, out.text || "(nothing)")}\n\n`);
      }
      case "upload_file": {
        const which = a.file === "cover_letter" ? "cover_letter" : "resume";
        const extra = which !== "resume" ? state.files?.[which] : null;
        if (which !== "resume" && !extra) return fail("This task has no cover letter file. Paste the cover letter text into a text field if there is one, or skip it.");
        if (which === "resume" && !profile.resume?.dataUrl) return fail("No resume is saved. Ask the user to add one in their Sidekick profile, or to attach it themselves.");
        const fileName = extra ? extra.name : profile.resume!.name;
        // Your resume is personal data: the first upload on a site in each run needs your OK,
        // unless a shortcut you've used on this site already attaches it.
        {
          // The site that receives the file: the frame the upload field is in (e.g. a greenhouse.io
          // form embedded in a company's careers page), else the tab.
          const tab = await chrome.tabs.get(state.tabId);
          const host = state.elements[String(a.id)]?.host;
          const where = host ? "https://" + host : tab.url || "";
          const site = siteOf(where);
          state.uploadOk ||= new Set();
          // A learned shortcut with an upload step means you already approved it on this site.
          const known = (await adaptersFor(where)).some(x => x.steps.some(st => st.tool === "upload_file"));
          if (!state.uploadOk.has(site) && !known) {
            const d = decide({ kind: "upload", site, file: extra ? "cover letter" : "resume" }, await policyContext(state));
            if (d.verdict === "refuse") return fail(d.reason);
            if (d.verdict === "ask" && !(await askApproval(`Attach your ${extra ? "cover letter" : "resume"} (${fileName}) on ${site}?`, "Sidekick asks the first time it sends your files to a site."))) return declined();
          }
          state.uploadOk.add(site);
          logAction({ worker: state.task?.n, kind: "upload", what: `Attached ${fileName} on ${site}`, site, jobId: state.task?.jobId }).catch(() => {});
        }
        const file = extra ? extra : (() => { const [, type, base64] = profile.resume!.dataUrl.match(/^data:([^;]*);base64,(.*)$/s)!; return { name: profile.resume!.name, type: type || profile.resume!.type, base64 }; })();
        const r = await actInPage(state, { op: "upload_file", id: a.id, file });
        if (!r.ok) return fail(r.error);
        step.done(true);
        return withSnapshot(r.note ? r.note + "\n\n" : "");
      }
      case "find": {
        const words = String(a.query || "").toLowerCase().split(/[\s,]+/).filter(w => w.length > 1).slice(0, 6);
        if (!words.length) return fail("find needs some words to look for.");
        const cap = await captureTab(state, { maxElements: 2500, maxText: 300000 });
        if (cap.error) return fail(cap.error);
        const all = (l: string) => words.every(w => l.toLowerCase().includes(w));
        const any = (l: string) => words.some(w => l.toLowerCase().includes(w));
        const els = cap.frames.flatMap(f => f.lines.filter(l => l.startsWith("[")).map(stripOffscreen));
        let hitEls = els.filter(all);
        if (!hitEls.length) hitEls = els.filter(any);
        const textLines = cap.frames.flatMap(f => String(f.text || "").split("\n").map(t => t.trim()).filter(t => t && t.length < 400));
        let hitText = textLines.filter(all);
        if (!hitText.length) hitText = textLines.filter(any);
        hitText = [...new Set(hitText)];
        step.done(true, `${hitEls.length} element${hitEls.length === 1 ? "" : "s"}, ${hitText.length} text line${hitText.length === 1 ? "" : "s"}`);
        const out = [`Searched the whole page for "${words.join(" ")}".`,
          hitEls.length ? `Matching elements (ids work with click/type):\n${groupRepeats(hitEls.slice(0, 60)).join("\n")}${hitEls.length > 60 ? `\n…${hitEls.length - 60} more; use more specific words` : ""}` : "No matching elements.",
          hitText.length ? `Matching text:\n${hitText.slice(0, 25).map(t => "- " + t).join("\n")}${hitText.length > 25 ? `\n…${hitText.length - 25} more` : ""}` : "No matching text."];
        return { text: untrusted(cap.url, out.join("\n\n")) };
      }
      case "web_search": {
        const q = String(a.query || "").trim();
        if (!q) return fail("web_search needs a query.");
        if (personalDetailsIn(q, profile).length) return fail("That search would send the user's personal details to a search engine. Search without them.");
        const results = await webSearchFallback(q, 6, { signal: state.signal });
        step.done(true, `${results.length} results`);
        return { text: untrusted(`web search: ${q}`, results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n") || "No results.") };
      }
      case "plan": {
        if (Array.isArray(a.items) && a.items.length) {
          const items: string[] = a.items.slice(0, 12).map((t: unknown) => String(t).slice(0, 120));
          const sites = [...new Set([state.startSite, ...(Array.isArray(a.sites) ? a.sites : []).map((d: string) => siteOf(/^https?:/.test(d) ? d : "https://" + String(d).trim()))].filter(Boolean))].slice(0, 10);
          // Several tasks: you approve the plan once (tasks + sites) instead of step by step.
          const covered = state.planApproval && sites.every(x => inPlan(state, x));
          if (items.length >= 2 && ui.approvePlan && !covered) {
            step.waiting();
            const r = await ui.approvePlan({ items, sites });
            if (!r?.ok) {
              step.done(false, "You asked for changes");
              const said = await ui.ask("What should I change in the plan?");
              return { text: `The user didn't approve the plan. They said: ${said}\nMake a new plan (call plan with items and sites) or use ask_user.`, failed: true, declined: true };
            }
            state.planApproval = { sites: new Set([...(state.planApproval?.sites || []), ...sites]), autoSubmit: !!r.autoSubmit };
            for (const x of sites) state.visitOk.add(x);
          }
          state.plan = items.map(t => ({ text: t, status: "todo" }));
        } else if (a.update && state.plan?.[Number(a.update.item) - 1]) {
          Object.assign(state.plan[Number(a.update.item) - 1], { status: a.update.status, note: String(a.update.note || "").slice(0, 160) });
        } else return fail(state.plan ? `There's no item ${a.update?.item}; the plan has ${state.plan.length}.` : "Start the plan with items.");
        ui.plan?.(state.plan!.map(x => ({ ...x })));
        step.done(true);
        const approvedNote = a.items && state.planApproval ? `\nThe user approved this plan for ${[...state.planApproval.sites].join(", ")}. ${state.planApproval.autoSubmit ? "Submits on those sites won't ask again (still mark them final_action: true); anything with payment, deleting or posting still asks." : "Each submit still needs their OK (final_action: true)."} Going to other sites needs their OK.` : "";
        return { text: `Checklist:\n${planText(state.plan!)}${approvedNote}` };
      }
      case "read_text": {
        step.done(true);
        return { text: await readAllText(state) };
      }
      case "screenshot": {
        // Only the visible tab can be photographed. If you've switched to another tab, the agent
        // doesn't pull you back (or photograph your tab by mistake); it works from the page text.
        const tab = await chrome.tabs.get(state.tabId);
        if (tab.active === false) return fail("The page is in a background tab (the agent's own tab, or the user switched tabs), so it can't be photographed right now. Work from the snapshot and read_text; if you truly need to see it, use ask_user to have them switch to it.");
        const input = await trustedInput(state);
        let shot: { dataUrl: string; width: number; height: number } | null = null;
        if (input) {
          try { shot = await input.screenshot(); } catch (err: any) { if (err.name !== "TrustedInputTimeout") throw err; }
        }
        if (!shot) {
          const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75 });
          shot = await shrinkImage(raw, 99999, state.viewport?.width);
        }
        step.done(true);
        state.lookedAt = Date.now();
        return { text: `Screenshot of the visible part of the tab is attached (${shot.width}×${shot.height} px; click_at uses these coordinates).`, images: [shot.dataUrl] };
      }
      case "zoom": {
        const tab = await chrome.tabs.get(state.tabId);
        if (tab.active === false) return fail("The page is in a background tab, so it can't be photographed right now. Work from the snapshot and read_text, or use ask_user to have them switch to it.");
        const vw = state.viewport?.width || 0, vh = state.viewport?.height || 0;
        const x = Math.max(0, Number(a.x) || 0), y = Math.max(0, Number(a.y) || 0);
        const r = { x, y, width: Math.min(Number(a.width) || 0, vw ? vw - x : Infinity), height: Math.min(Number(a.height) || 0, vh ? vh - y : Infinity) };
        if (!(r.width >= 10 && r.height >= 10)) return fail(`That area (${Math.round(r.width)}×${Math.round(r.height)} px) is too small or outside the screen${vw ? ` (${vw}×${vh})` : ""}. Use coordinates from the latest screenshot.`);
        const scale = Math.max(1, Math.min(4, ZOOM_EDGE / Math.max(r.width, r.height)));
        const input = await trustedInput(state);
        let img: { dataUrl: string; width: number; height: number } | null = null;
        if (input) {
          try { img = await input.screenshotRegion(r, scale); } catch (err: any) { if (err.name !== "TrustedInputTimeout") throw err; }
        }
        if (!img) {
          // Without the debugger: crop Chrome's own capture (sharper on Retina screens, where it has
          // more pixels than the page has CSS pixels).
          const raw = await pageTimeout(chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }));
          const bmp = await createImageBitmap(await (await fetch(raw)).blob());
          const k = vw ? bmp.width / vw : 1;
          img = await cropImage(raw, { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }, Math.round(r.width * scale), Math.round(r.height * scale));
        }
        step.done(true);
        state.lookedAt = Date.now();
        return { text: `Enlarged view (${scale.toFixed(1)}×) of the area at (${Math.round(r.x)}, ${Math.round(r.y)}), ${Math.round(r.width)}×${Math.round(r.height)} px of the screenshot, is attached. It's for reading only: click_at uses the full screenshot's coordinates.`, images: [img.dataUrl] };
      }
      case "navigate": {
        if (!/^https?:\/\//i.test(a.url || "")) return fail("Only http(s) URLs are allowed.");
        if (!(await urlLooksSafe(a.url))) return declined();
        if (!(await gateVisit(state, a.url, askApproval))) return declined();
        await disarmLeavePrompt(state);
        await chrome.tabs.update(state.tabId, { url: a.url });
        await sleep(300);
        step.done(true);
        return withSnapshot();
      }
      case "go_back": {
        await disarmLeavePrompt(state);
        await chrome.tabs.goBack(state.tabId).catch(() => {});
        await sleep(300);
        step.done(true);
        return withSnapshot();
      }
      case "open_tab": {
        if (!/^https?:\/\//i.test(a.url || "")) return fail("Only http(s) URLs are allowed.");
        if (!(await urlLooksSafe(a.url))) return declined();
        if (!(await gateVisit(state, a.url, askApproval))) return declined();
        // The agent works in its own tabs and never switches the tab you're looking at.
        const t = await chrome.tabs.create({ url: a.url, active: false });
        state.tabId = t.id!;
        await addToAgentGroup(state, t.id!);
        await sleep(300);
        step.done(true);
        return withSnapshot();
      }
      case "list_tabs": {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        step.done(true);
        return { text: tabs.map(t => `${t.id === state.tabId ? "* " : ""}tab_id ${t.id}: ${t.title} — ${t.url}`).join("\n") + "\n(* = current)" };
      }
      case "switch_tab": {
        const t = await chrome.tabs.get(Number(a.tab_id)).catch(() => null);
        if (!t) return fail("No tab with that id.");
        // Works there in the background: the tab you're looking at stays in front.
        state.tabId = t.id!;
        step.done(true);
        return withSnapshot();
      }
      case "wait": {
        await sleep(Math.min(10, Math.max(1, Number(a.seconds) || 2)) * 1000);
        step.done(true);
        return withSnapshot();
      }
      case "ask_user": {
        step.waiting();
        const answer = await ui.ask(a.question || "");
        state.answers.push(String(a.question || "").slice(0, 160));
        step.done(true);
        // A lasting fact in the answer ("I can start June 2027") is remembered for the next form; in the background, never blocking the run.
        if (state.settings.memoryAuto) {
          factsFromAnswer({ question: String(a.question || ""), answer: String(answer || ""), userName: profile.preferredName || profile.fullName?.split(/\s+/)[0] || "the user", signal: state.signal })
            .then(async facts => { for (const f of facts) { const r = await addMemory(f.text, "application", f.kind).catch(() => null); if (r && !r.updated) ui.note(`Remembered for next time: ${f.text}`); } })
            .catch(() => {});
        }
        return withSnapshot(`The user answered: ${answer}\n\nCurrent page:\n`);
      }
      case "log_application": {
        const tab = await chrome.tabs.get(state.tabId);
        await logApplication({ company: a.company, role: a.role, status: a.status || "submitted", notes: a.notes || "", url: tab.url });
        step.done(true);
        return { text: "Logged." };
      }
      case "world_query": {
        step.done(true);
        // Company names and titles come from job boards: fenced like any outside text.
        return { text: untrusted("Sidekick's job records (names and titles from job boards)", worldQuery(await buildWorld(), String(a.question || ""))) };
      }
      case "done": {
        // Values typed after reading them off a screenshot (a graph, a chart, a scanned table) get
        // one look back before the run ends: the 2026-11-09 MyOpenMath run assumed a graph's scale
        // from a cut-off view and typed it without checking.
        if (state.typedAfterLook && (state.lookedAt || 0) < state.typedAfterLook && !state.checkAsked) {
          state.checkAsked = true;
          step.done(true, "Checking the typed values first");
          return { text: CHECK_BEFORE_DONE };
        }
        step.done(true);
        return { text: "Finished.", done: true, summary: a.summary || "Done." };
      }
      default:
        return fail(`Unknown tool ${call.name}.`);
    }
  } catch (err: any) {
    if (err.name === "AbortError") { step.done(false, "Stopped"); throw err; }
    return fail(err.message || String(err));
  }
}

// The page's text and the text of every frame embedded in it (homework, forms and job boards often
// sit in a frame from another site). Frames it can't read are named, never skipped silently.
export async function readAllText(state: AgentState, max = 15000): Promise<string> {
  const tab = await chrome.tabs.get(state.tabId);
  const results = (await pageScript({ target: { tabId: state.tabId, allFrames: true }, func: skPageAct, args: [{ op: "read_text", max }] }))
    .filter(r => r.result?.ok).sort((x, y) => x.frameId - y.frameId);
  const parts: string[] = [];
  let left = max, cut = false;
  const readHosts = new Set<string>();
  for (const r of results) {
    const res = r.result as Extract<PageActionResult, { ok: true }>;
    if (r.frameId !== 0) readHosts.add(hostOf(res.url || ""));
    const text = String(res.text || "").trim();
    if (!text || left <= 0) { cut ||= !!text; continue; }
    const piece = text.slice(0, left);
    left -= piece.length;
    cut ||= piece.length < text.length || !!res.truncated;
    const where = r.frameId === 0 ? "Page text" : `Text inside an embedded frame from ${hostOf(res.url || "") || "this page"}`;
    parts.push(untrusted(res.url || tab.url, `${where}:\n${piece}`));
  }
  // Visible frames listed by their parents, minus the ones that answered.
  const seen = results.flatMap(r => (r.result as { frames?: string[] }).frames || []);
  const missing = seen.length - results.filter(r => r.frameId !== 0).length;
  const hosts = [...new Set(seen.filter(h => h && !readHosts.has(h)))];
  const notes: string[] = [];
  if (!parts.length) notes.push("The page has no readable text: its content may be pictures, a canvas or a PDF. Use screenshot to see it (and zoom to read small print).");
  if (cut) notes.push("The text was shortened.");
  if (missing > 0) notes.push(`Couldn't read ${missing} embedded frame${missing > 1 ? "s" : ""}${hosts.length ? ` (from ${hosts.join(", ")})` : ""}: Chrome kept Sidekick out, or it's still loading. Use screenshot to see it.`);
  return [...parts, ...notes].join("\n\n");
}

