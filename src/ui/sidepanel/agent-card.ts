// The agent's card in the chat: steps, checklist, approval and plan cards, questions, and the
// bridge (AgentUI) between the agent loop and the panel.
import { clearEmpty } from "./messages.js";
import { LOGO, STEP_ICON } from "./icons.js";
import { messagesEl, autoScroll, controller, input, resizeInput, agentMode, refreshSend, stop } from "./sidepanel.js";
import { renderMarkdown } from "./markdown.js";
import { untrusted } from "../../core/security/guard.js";
import type { PlanItem, AgentUI } from "../../agent/types.js";
import { notifyUser, clearNotice } from "./notify.js";
import { runAgent } from "../../agent/loop/run.js";

export let agentRun: { el: HTMLElement; approve?: ((ok: boolean) => void) | null; answer?: ((text: string) => void) | null } | null = null;       // the running agent: { answer?: fn, approve?: fn, el }

// The live card for one agent run: a header, the list of steps, and the final summary.
export function addAgentRun(parent?: HTMLElement) {
  clearEmpty();
  const el = document.createElement("div");
  el.className = parent ? "agent-run nested" : "msg ai agent-run";
  el.innerHTML = `
    <div class="agent-head">${LOGO}<span class="agent-status">Working…</span><span class="spacer"></span>
      <button type="button" class="agent-stop">Stop</button></div>
    <div class="agent-think" aria-live="polite"></div>
    <ol class="agent-plan" hidden></ol>
    <ol class="agent-steps"></ol>
    <div class="md"></div>`;
  if (parent) parent.insertBefore(el, parent.querySelector(":scope > .md"));
  else messagesEl.appendChild(el);
  const list = el.querySelector(".agent-steps");
  (el.querySelector(".agent-stop") as any).onclick = stop;

  const statusEl = el.querySelector(".agent-status");
  const thinkEl = el.querySelector(".agent-think");
  let thought = "";
  const addStep = (text: any) => {
    text = String(text || "").trim() || "Working";
    statusEl!.textContent = `Working: ${text}`;
    thought = "";
    thinkEl!.textContent = "";
    const li = document.createElement("li");
    li.className = "step running";
    li.innerHTML = `<span class="st-icon">${STEP_ICON.running}</span><span class="st-body"><span class="st-text"></span><span class="st-detail"></span></span>`;
    li.querySelector(".st-text")!.textContent = text;
    list!.appendChild(li);
    autoScroll();
    const setState = (cls: any, icon: any) => { li.className = "step " + cls; li.querySelector(".st-icon")!.innerHTML = icon; };
    return {
      waiting: () => setState("waiting", STEP_ICON.waiting),
      done: (ok: any, detail?: any) => {
        setState(ok ? "ok" : "fail", ok ? STEP_ICON.ok : STEP_ICON.fail);
        if (detail) li.querySelector(".st-detail")!.textContent = detail;
      }
    };
  };

  const planEl = el.querySelector(".agent-plan");
  let planItems = null;
  const PLAN_LABEL: Record<string, string> = { todo: "To do", doing: "Working on it", done: "Done", failed: "Couldn't do it", skipped: "Skipped" };
  return {
    el,
    addStep,
    // The checklist for multi-part tasks ("apply to these 4 jobs").
    plan(items: any) {
      planItems = items;
      (planEl as any).hidden = false;
      planEl!.innerHTML = "";
      for (const it of items) {
        const li = document.createElement("li");
        li.className = "plan-item " + it.status;
        li.innerHTML = `<span class="pi-mark" aria-hidden="true"></span><span class="pi-text"></span><span class="pi-note"></span>`;
        li.querySelector(".pi-mark")!.textContent = ({ todo: "○", doing: "→", done: "✓", failed: "✗", skipped: "–" } as Record<string, string>)[it.status] || "○";
        li.querySelector(".pi-text")!.textContent = it.text;
        li.querySelector(".pi-note")!.textContent = it.note ? ` · ${it.note}` : "";
        li.title = PLAN_LABEL[it.status] || "";
        planEl!.appendChild(li);
      }
      const finished = items.filter((x: any) => !["todo", "doing"].includes(x.status)).length;
      if (!el.classList.contains("finished")) statusEl!.textContent = `Working: ${finished} of ${items.length} done`;
    },
    // The agent's latest thought, one line, while it decides the next step.
    think(chunk: any) {
      if (el.classList.contains("finished")) return;
      statusEl!.textContent = "Working: thinking";
      thought += chunk.replace(/\*\*/g, "");
      const line = thought.trim().split(/\n+/).pop();
      thinkEl!.textContent = line!.length > 140 ? "…" + line!.slice(-138) : line as string;
    },
    note(text: any) {
      const li = document.createElement("li");
      li.className = "step note";
      li.textContent = text;
      list!.appendChild(li);
      autoScroll();
    },
    // A card inside the run with the given content and buttons; resolves with the clicked value.
    card(className: any, build: any) {
      const card = document.createElement("div");
      card.className = "agent-card " + className;
      el.insertBefore(card, el.querySelector(":scope > .md")); // the run's own summary area, not a card's
      build(card);
      autoScroll();
      return card;
    },
    finish(state: any, summary: any) {
      el.classList.add("finished");
      thinkEl!.remove();
      el.querySelector(".agent-status")!.textContent = state === "done" ? "Done" : state === "stopped" ? "Stopped" : "Couldn't finish";
      el.querySelector(".agent-stop")!.remove();
      el.querySelectorAll(".step.running, .step.waiting").forEach(li => {
        li.className = "step fail";
        li.querySelector(".st-icon")!.innerHTML = STEP_ICON.fail;
      });
      if (summary) renderMarkdown(el.querySelector(":scope > .md"), summary);
      // Collapse long step lists once finished.
      const steps = el.querySelectorAll(".step:not(.note)");
      if (steps.length > 6) {
        el.classList.add("collapsed");
        const t = document.createElement("button");
        t.type = "button";
        t.className = "steps-toggle";
        t.textContent = `Show all ${steps.length} steps`;
        t.onclick = () => {
          const c = el.classList.toggle("collapsed");
          t.textContent = c ? `Show all ${steps.length} steps` : "Hide steps";
        };
        el.querySelector(".agent-head")!.after(t);
      }
    }
  };
}

export const INTERRUPTED = "Interrupted: Sidekick was closed or reloaded before this finished. The steps above were done; the page may be part-way through.";

// The chat so far, for the agent: follow-ups ("apply for the backend one", "you know which
// position") only make sense with it. Recent messages, shortened; replies may quote web pages,
// so the whole thing is fenced as data.
export function agentHistory(messages: any, notes: string[] = []) {
  const lines = [];
  for (const m of messages.slice(-12)) {
    if (m.role === "user") lines.push(`User: ${String(m.display?.prompt ?? m.text ?? "").slice(0, 600)}`);
    else {
      let t = String(m.text || "").replace(/```setup[\s\S]*?```/g, "").trim();
      if (t === INTERRUPTED) t = "(this task was interrupted)";
      const steps = m.agentSteps?.length ? `\n  Steps taken: ${m.agentSteps.slice(-15).join("; ")}` : "";
      lines.push(`Sidekick: ${t.slice(0, 1500)}${steps}`);
    }
  }
  if (!lines.length && !notes.length) return "";
  const pinned = notes.length ? `Pinned notes for this chat:\n${notes.map(n => `- ${n}`).join("\n")}\n\n` : "";
  return untrusted("earlier messages in this chat", pinned + lines.join("\n"));
}

// Runs the browser agent with a live card. Used by Agent mode and by the chat's
// operate_browser tool (then the card sits inside the chat reply). Returns { summary, steps, state, plan }.
// opts: { history, progress(partial) } — progress gets the steps and checklist as they change.
export async function runAgentCard(goal: string, parent?: HTMLElement, opts: { history?: string; userMessages?: string[]; progress?: (p: Record<string, unknown>) => void } = {}) {
  const run = addAgentRun(parent);
  const signal = (controller! as any).signal;
  agentRun = { el: run.el };
  const liveSteps: string[] = [];
  let livePlan: PlanItem[] | null = null;

  // Pending approval/answer promises are rejected when you press Stop.
  const onAbort = (reject: any) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });

  const ui: AgentUI = {
    signal,
    step: (text: any) => {
      liveSteps.push(text);
      (opts as any).progress?.({ agentSteps: [...liveSteps], ...(livePlan && { agentPlan: livePlan }) });
      return run.addStep(text);
    },
    note: (text: any) => run.note(text),
    thinking: (chunk: any) => run.think(chunk),
    plan: (items: any) => {
      livePlan = items;
      run.plan(items);
      (opts as any).progress?.({ agentSteps: [...liveSteps], agentPlan: items });
    },
    approve: ({ title, detail }) => new Promise<boolean>((resolve, reject) => {
      onAbort(reject);
      const notice = notifyUser("approve", "Sidekick needs your OK", title);
      const resolveWas = resolve;
      resolve = v => { notice.then(clearNotice); resolveWas(v); };
      const card = run.card("approve", (c: any) => {
        c.innerHTML = `<div class="ac-label">Approve this action?</div><div class="ac-title"></div><div class="ac-detail md"></div>
          <div class="ac-buttons"><button type="button" class="ac-deny">Don't do it</button><button type="button" class="ac-allow">Allow</button></div>`;
        c.querySelector(".ac-title").textContent = title;
        if (detail) renderMarkdown(c.querySelector(".ac-detail"), detail);
        else c.querySelector(".ac-detail").remove();
      });
      const answer = (ok: any) => {
        card.classList.add("answered", ok ? "allowed" : "denied");
        card.querySelector(".ac-buttons")!.innerHTML = `<span class="ac-result">${ok ? "Allowed" : "Declined"}</span>`;
        if (agentRun) (agentRun as any).approve = null;
        resolve(ok);
      };
      (card.querySelector(".ac-allow") as any).onclick = () => answer(true);
      (card.querySelector(".ac-deny") as any).onclick = () => answer(false);
      (agentRun! as any).approve = answer;
      (card.querySelector(".ac-allow") as any).focus();
    }),
    approvePlan: ({ items, sites }) => new Promise<{ ok: boolean; autoSubmit?: boolean }>((resolve, reject) => {
      onAbort(reject);
      const notice = notifyUser("approve", "Sidekick has a plan for you to approve", `${items.length} tasks on ${sites.join(", ")}`);
      const card = run.card("approve plan-card", (c: any) => {
        c.innerHTML = `<div class="ac-label">Approve the plan?</div><ol class="pc-items"></ol>
          <div class="pc-sites"><span class="pc-k">Sites</span> <span class="pc-v"></span></div>
          <label class="pc-auto"><input type="checkbox"> <span>Also submit each one without asking me (never for payments, deleting or posting)</span></label>
          <div class="ac-hint">Approving lets Sidekick work through these without stopping for every step. Going to any other site still asks.</div>
          <div class="ac-buttons"><button type="button" class="ac-deny">Change it</button><button type="button" class="ac-allow">Approve plan</button></div>`;
        for (const it of items) { const li = document.createElement("li"); li.textContent = it; c.querySelector(".pc-items").appendChild(li); }
        c.querySelector(".pc-v").textContent = sites.join(", ") || "this site";
      });
      const answer = (ok: any) => {
        const auto = ok && (card.querySelector(".pc-auto input") as any).checked;
        card.classList.add("answered", ok ? "allowed" : "denied");
        card.querySelector(".pc-auto")!.remove();
        card.querySelector(".ac-buttons")!.innerHTML = `<span class="ac-result">${ok ? (auto ? "Approved · submits without asking" : "Approved") : "You asked for changes"}</span>`;
        if (agentRun) (agentRun as any).approve = null;
        notice.then(clearNotice);
        resolve({ ok, autoSubmit: auto });
      };
      (card.querySelector(".ac-allow") as any).onclick = () => answer(true);
      (card.querySelector(".ac-deny") as any).onclick = () => answer(false);
      (agentRun! as any).approve = answer;
      (card.querySelector(".ac-allow") as any).focus();
    }),
    ask: (question: any) => new Promise((resolve, reject) => {
      onAbort(reject);
      const notice = notifyUser("ask", "Sidekick has a question", question);
      const resolveWas = resolve;
      resolve = v => { notice.then(clearNotice); resolveWas(v); };
      const card = run.card("question", (c: any) => {
        c.innerHTML = `<div class="ac-label">Needs your input</div><div class="md"></div><div class="ac-hint">Reply in the box below.</div>`;
        renderMarkdown(c.querySelector(".md"), question);
      });
      input.placeholder = "Reply here";
      (agentRun! as any).answer = (text: any) => {
        card.classList.add("answered");
        card.querySelector(".ac-hint")!.textContent = `You: ${text}`;
        (agentRun! as any).answer = null;
        input.value = "";
        resizeInput();
        input.placeholder = agentMode ? "Tell Sidekick what to do on this page" : "Ask anything";
        refreshSend();
        resolve(text);
      };
      refreshSend();
      input.focus();
    })
  };

  let summary, steps = [], state = "done", plan = null;
  try {
    const result = await runAgent(goal, ui, { history: opts.history, userMessages: opts.userMessages });
    summary = result.summary;
    steps = result.steps;
    plan = result.plan || null;
    // What Sidekick learned from this run, so you know why the next one is faster.
    const l = result.learned;
    if (l?.shortcut) run.note(`Saved a shortcut for ${l.shortcut.site}: next time ${l.shortcut.automatic} of ${l.shortcut.steps} steps run instantly. Manage it on your profile page (Site skills).`);
    if (l?.notes?.length) run.note(`Learned ${l.notes.length} note${l.notes.length > 1 ? "s" : ""} about this site for next time.`);
  } catch (err: any) {
    if (err.name === "AbortError") {
      state = "stopped";
      summary = "Stopped. The page is left as it was; nothing else was submitted.";
    } else {
      state = "failed";
      summary = `Something went wrong: ${err.message}`;
    }
    steps = [...run.el.querySelectorAll(".step:not(.note) .st-text")].map(e => e.textContent);
    plan = livePlan;
  } finally {
    agentRun = null;
    refreshSend();
  }
  run.finish(state, parent ? "" : summary);
  notifyUser("done", state === "done" ? "Sidekick finished" : state === "stopped" ? "Sidekick stopped" : "Sidekick couldn't finish", String(summary || "").split("\n").find(l => l.trim()) || "");
  if (state === "stopped" && parent) throw new DOMException("Stopped", "AbortError");
  return { summary, steps, state, plan };
}
