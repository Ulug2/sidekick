// The Powerhouse page (docs/DESIGN.md §1): deriveScene() drawn by the 3D view (gpu3d.ts, loaded
// only on this page), plus the worker list (the accessible path), the drawer and Pause/Resume.
// Everything a worker title or step contains came from the web: text only, never markup.
// powerhouse.html#demo shows every state from made-up records, in memory only (no storage writes).
import { $ } from "../shared/dom.js";
import { meterEl } from "../shared/meter.js";
import { readLocal } from "../../core/storage/schema.js";
import { updateLocal } from "../../core/storage/update.js";
import { DEFAULT_CAPS, spendFor } from "../../core/llm/budget.js";
import { formatCost } from "../../core/llm/prices.js";
import { DEFAULT_JOB_SETTINGS } from "../../jobs/store.js";
import { BATCH_TZ, nextAt } from "../../jobs/daily.js";
import { setPaused } from "../../orchestrator/workers.js";
import type { BrainCall } from "../../orchestrator/activity.js";
import type { WorkerRecord } from "../../orchestrator/types.js";
import type { Job } from "../../jobs/types.js";
import { deriveScene, type Scene, type SceneInput } from "./scene.js";
import { createView, type PowerhouseView } from "./gpu3d.js";
import { speak } from "./voice.js";
import { MODEL_IDS } from "../../core/llm/models.js";

const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const etTime = (t: number) => new Date(t).toLocaleString("en-US", { timeZone: BATCH_TZ, hour: "numeric", minute: "2-digit" }) + " ET";
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

let scene: Scene | null = null;
let view: PowerhouseView | null = null;
let jobs: Job[] = [];
let lastShoutKey = "";
let drawerFor: string | null = null; // a worker id, or "sk"
let openerId: string | null = null; // the list row that opened the drawer (rows are rebuilt; keep the id)
let actionsKey = "";
let loadSeq = 0;
let tick: ReturnType<typeof setTimeout> | undefined;
let pausedNow = false;
let spendLine = "";
const logs = new Map<string, string[]>(); // steps seen while this page is open, per worker
const demo = location.hash === "#demo";

// ---------- state ----------
// Reads everything and derives the scene. The page-wide side effects (meters, the Pause button's
// state) are returned as apply(), run only if this load is still the newest (refresh()).
async function load(now = Date.now()): Promise<{ scene: Scene; apply: () => void }> {
  if (demo) { const scene = demoScene(now); return { scene, apply: () => { pausedNow = demoState === "Paused"; $("#meters").replaceChildren(meterEl("Today", 0.31, 1), meterEl("This month", 6.12, 25)); spendLine = "$0.31 today, $6.12 this month (demo)"; } }; }
  const [{ orchestrator = {} }, { usage, capDaily, capMonthly }, { jobSettings }] = await Promise.all([
    readLocal("orchestrator"), readLocal(["usage", "capDaily", "capMonthly"]), readLocal("jobSettings")
  ]);
  const { brainCalls = [] } = await chrome.storage.session.get("brainCalls").catch(() => ({})) as { brainCalls?: BrainCall[] };
  // The job list can be large and changes on every scan: read it only for Sidekick's drawer.
  if (drawerFor === "sk") jobs = (await readLocal("jobs")).jobs || [];
  const js = { ...DEFAULT_JOB_SETTINGS, ...(jobSettings || {}) };
  const spend = spendFor(usage, new Date(now));
  const caps = { daily: Number(capDaily ?? DEFAULT_CAPS.daily), monthly: Number(capMonthly ?? DEFAULT_CAPS.monthly) };
  const apply = () => {
    $("#meters").replaceChildren(meterEl("Today", spend.today, caps.daily), meterEl("This month", spend.month, caps.monthly));
    spendLine = `${formatCost(spend.today)} today, ${formatCost(spend.month)} this month`;
    pausedNow = orchestrator.paused === "you";
  };
  const scene = deriveScene({
    now, workers: orchestrator.workers || [], needsYou: orchestrator.needsYou, paused: orchestrator.paused, brainCalls,
    ...(orchestrator.lastShout && { lastShout: orchestrator.lastShout }), spend, caps, dismissed: orchestrator.dismissed,
    batchOn: js.dailyBatch !== false, nextBatchAt: js.dailyBatch !== false ? nextAt(now, js.batchHour) : null, formatTime: etTime
  });
  return { scene, apply };
}

// ---------- demo (made-up records, never stored) ----------
const DEMO_STATES = ["Idle", "Thinking", "Dispatch", "Working", "Needs you", "Failed", "Paused", "Busy day"] as const;
let demoState: (typeof DEMO_STATES)[number] = "Dispatch";
let demoAt = Date.now();
function demoScene(now: number): Scene {
  const W = (o: Partial<WorkerRecord>): WorkerRecord => ({ id: "d1", n: 1, kind: "apply", title: "Apply: Software Engineer, New Grad at Stripe", model: MODEL_IDS.anthropic.fast, status: "working", step: "Page 2: Education", startedAt: demoAt, updatedAt: now, cost: 0, ...o });
  const crew = [W({}), W({ id: "d2", n: 2, title: "Apply: Backend Engineer at Ramp", startedAt: demoAt + 1 }), W({ id: "d3", n: 3, kind: "write", title: "Cover letter: Plaid", step: "Writing", startedAt: demoAt + 2 }), W({ id: "d4", n: 4, kind: "read", title: "Read: Datadog careers page", step: "Reading the posting", startedAt: demoAt + 3 })];
  const input: SceneInput = { now, workers: [], spend: { today: 0.31, month: 6.12, unpriced: [] }, caps: { daily: 1, monthly: 25 }, batchOn: true, nextBatchAt: nextAt(now, 8), formatTime: etTime };
  switch (demoState) {
    case "Idle": break;
    case "Thinking": input.workers = crew.slice(0, 1); input.brainCalls = [{ id: "b", what: "Pick the best 18 to apply to today", startedAt: now }]; break;
    case "Dispatch": input.workers = crew; input.lastShout = { text: "Agent 1! Apply: Software Engineer, New Grad at Stripe", at: now - 500, workerId: "d1" }; break;
    case "Working": input.workers = crew; break;
    case "Needs you": input.workers = [...crew.slice(1), W({ status: "needs_you", step: "Waiting for you" })]; break;
    case "Failed": input.workers = [...crew.slice(0, 2), W({ id: "d5", n: 5, status: "failed", error: "The form wants an account and a password.", title: "Apply: SRE at Delta" }), W({ id: "d6", n: 6, status: "done", step: "Submitted", title: "Apply: Platform Engineer at Bravo" })]; break;
    case "Paused": input.workers = crew.slice(0, 2); input.paused = "you"; break;
    case "Busy day": input.workers = [...crew, ...[5, 6, 7, 8].map(n => W({ id: `d${n}`, n, title: `Apply: Engineer at Company ${n}`, startedAt: demoAt + n })), W({ id: "d9", n: 9, status: "needs_you" }), W({ id: "d10", n: 10, status: "failed", error: "Blocked by a CAPTCHA." })]; break;
  }
  return deriveScene(input);
}
function demoBar(): void {
  const bar = $("#demoBar");
  bar.hidden = false;
  const label = document.createElement("span"); label.className = "small muted"; label.textContent = "Demo (made-up workers, nothing is stored):";
  bar.append(label, ...DEMO_STATES.map(s => {
    const b = document.createElement("button"); b.type = "button"; b.className = "small"; b.textContent = s;
    b.setAttribute("aria-pressed", String(s === demoState));
    b.onclick = () => { demoState = s; demoAt = Date.now(); for (const x of bar.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b)); refresh(); };
    return b;
  }));
}

// ---------- drawing ----------
export function render(s: Scene): void {
  scene = s;
  const chip = $("#chip");
  chip.textContent = s.chip.text; chip.dataset.tone = s.chip.tone;
  $("#pause").textContent = pausedNow ? "Resume" : "Pause";
  $("#pause").setAttribute("aria-pressed", String(pausedNow));
  $("#thinking").textContent = s.coach === "thinking" ? `Sidekick is thinking: ${s.thinkingAbout || "a decision"}.` : s.hiddenCount ? `${s.hiddenCount} more worker${s.hiddenCount > 1 ? "s" : ""} than there is room for on the card: all are in the list below.` : "";
  $("#overlay").dataset.coach = s.coach;
  if (s.shout) { const key = s.shout.workerId + s.shout.text; if (lastShoutKey !== key) { lastShoutKey = key; speak(s.shout.text); } }
  view?.update(s);
  for (const f of s.figures) {
    const log = logs.get(f.id) || [];
    if (f.step && log.at(-1) !== f.step) { log.push(f.step); logs.set(f.id, log.slice(-60)); }
  }
  for (const id of logs.keys()) if (!s.figures.some(f => f.id === id)) logs.delete(id);
  renderList(s);
  if (drawerFor) fillDrawer();
  // time alone changes the scene (a shout ends, a worker leaves): one timer, only when needed
  clearTimeout(tick);
  if (s.nextChange !== null && !demo) tick = setTimeout(refresh, Math.min(s.nextChange + 50, 60000));
}

function renderList(s: Scene): void {
  const items: HTMLElement[] = [];
  const li = (n: string, title: string, sub: string, state: string, dataS: string, open: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.open = open;
    const nEl = document.createElement("span"); nEl.className = "wl-n"; nEl.textContent = n; nEl.setAttribute("aria-hidden", "true");
    const main = document.createElement("span"); main.className = "wl-main";
    const t = document.createElement("span"); t.className = "wl-title"; t.textContent = title;
    const sb = document.createElement("span"); sb.className = "wl-sub"; sb.textContent = sub;
    main.append(t, sb);
    const st = document.createElement("span"); st.className = "wl-state"; st.dataset.s = dataS; st.textContent = state;
    b.append(nEl, main, st);
    b.setAttribute("aria-label", `${open === "sk" ? "Sidekick" : `Agent ${n}`}: ${title}. ${sub}. ${state}`);
    b.addEventListener("click", () => openDrawer(open));
    const item = document.createElement("li"); item.append(b);
    return item;
  };
  const coachState = { idle: "standing by", thinking: "thinking", shouting: "dispatching", paused: s.coachTag || "paused" }[s.coach];
  items.push(li("S", "Sidekick", s.coach === "thinking" ? s.thinkingAbout || "Thinking" : s.chip.text, coachState, s.coach === "paused" ? "needs_you" : "", "sk"));
  for (const f of s.figures) items.push(li(String(f.n), f.title || "Task", f.error ? `Error: ${f.error}` : f.step || "", f.label, f.pose === "raise" ? "needs_you" : f.status, f.id));
  const focused = (document.activeElement as HTMLElement | null)?.closest?.("#workerList button") as HTMLElement | null;
  const keepFocus = focused?.dataset.open;
  $("#workerList").replaceChildren(...items);
  if (keepFocus) ($$("#workerList button").find(b => b.dataset.open === keepFocus) || $("#workerList button"))?.focus();
  const empty = $("#emptyList");
  empty.hidden = s.figures.length > 0;
  empty.textContent = "No workers right now. They appear here when an application or a writing task starts, and leave 30 seconds after they finish.";
}

// ---------- the drawer ----------
async function openDrawer(id: string, from: "list" | "canvas" = "list"): Promise<void> {
  drawerFor = id;
  openerId = from === "canvas" ? "canvas" : id;
  actionsKey = "";
  const d = $("#drawer");
  d.inert = false;
  d.classList.add("open");
  if (id === "sk") jobs = (await readLocal("jobs")).jobs || [];
  fillDrawer();
  $("#closeDrawer").focus();
}
function closeDrawer(): void {
  const lastDrawer = drawerFor;
  const d = $("#drawer");
  d.classList.remove("open");
  d.inert = true;
  drawerFor = null;
  const canvas = document.querySelector<HTMLElement>(".ph-canvas");
  if (openerId === "canvas" && canvas) { canvas.focus({ preventScroll: true }); return; }
  // without the 3D canvas (no WebGL), a pick from a label returns to that worker's row
  ($$("#workerList button").find(b => b.dataset.open === (openerId === "canvas" ? lastDrawer : openerId)) || $("#workerList button"))?.focus?.();
}
const p = (text: string) => { const e = document.createElement("p"); e.textContent = text; return e; };
const btn = (label: string, fn: () => void) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = fn; return b; };
const link = (label: string, href: string) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.target = "_blank"; return a; };

function fillDrawer(): void {
  if (!scene || !drawerFor) return;
  const body = $("#drawerBody"), log = $("#drawerLog");
  if (drawerFor === "sk") {
    $("#drawerTitle").textContent = "Sidekick";
    $("#drawerMeta").textContent = scene.chip.text;
    const approved = jobs.filter(j => j.status === "queued" && j.scheduledAt).sort((a, b) => a.scheduledAt! - b.scheduledAt!);
    const waiting = jobs.filter(j => j.status === "queued" && !j.scheduledAt).length;
    body.replaceChildren(
      p(scene.coach === "thinking" ? `Thinking: ${scene.thinkingAbout}.` : scene.coach === "paused" ? `Paused: ${scene.coachTag}. Nothing new starts until ${scene.coachTag === "paused by you" ? "you press Resume" : "the spend cap resets or you raise it in Settings → Spend"}.` : "Standing by."),
      p(approved.length ? `Next applications: ${approved.slice(0, 3).map(j => `${j.company} at ${etTime(j.scheduledAt!)}`).join(", ")}${approved.length > 3 ? ` and ${approved.length - 3} more` : ""}.` : "No applications scheduled."),
      p(`${waiting ? `${waiting} job${waiting > 1 ? "s" : ""} in today's batch waiting for your approval. ` : ""}${scene.needsYou ? `${scene.needsYou} worker${scene.needsYou > 1 ? "s" : ""} need${scene.needsYou === 1 ? "s" : ""} you.` : ""}`.trim() || "Nothing waiting for you."),
      p(`Spend: ${spendLine}.`)
    );
    log.replaceChildren();
    setActions("sk", () => [link("Jobs page", "jobs.html"), link("Settings", "options.html#sec-jobs")]);
    return;
  }
  const f = scene.figures.find(x => x.id === drawerFor);
  if (!f) { $("#drawerTitle").textContent = "This worker has left"; $("#drawerMeta").textContent = ""; body.replaceChildren(p("It finished more than 30 seconds ago. Its run is on the Agent runs page.")); log.replaceChildren(); setActions("gone", () => [link("Agent runs", "runs.html")]); return; }
  $("#drawerTitle").textContent = `Agent ${f.n} · ${f.title || "Task"}`;
  // Cost is filled in when a run ends (the trace has it); while it runs it isn't known yet.
  $("#drawerMeta").textContent = [f.model || "model ?", `started ${clock(f.startedAt)}`, f.cost > 0 ? formatCost(f.cost) : "", f.label].filter(Boolean).join(" · ");
  body.replaceChildren(...[f.error ? p(`Error: ${f.error}`) : null, f.pose === "raise" ? p("It has a question only you can answer, or a step only you can do. Answer it on the Jobs page (Needs you).") : null].filter(Boolean) as HTMLElement[]);
  // The log grows in place; it follows the newest step only if you were already at the bottom.
  const steps = logs.get(f.id) || [];
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  if (log.dataset.for !== f.id) { log.replaceChildren(); log.dataset.for = f.id; }
  for (const s of steps.slice(log.children.length)) { const li = document.createElement("li"); li.textContent = s; log.append(li); }
  if (atBottom) log.scrollTop = log.scrollHeight;
  const acts: HTMLElement[] = [];
  if (f.tabId && f.status === "working") acts.push(btn("Open its tab", async () => { const t = await chrome.tabs.update(f.tabId!, { active: true }).catch(() => null); if (t?.windowId !== undefined) chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); }));
  if (demo) { setActions("demo", () => [p("Demo: actions are off here; nothing is stored.")]); return; }
  if (f.status === "working" && f.pose === "pull") acts.push(btn("Stop the batch after this job", async () => { await chrome.storage.session.set({ jobBatchStop: true }); $("#drawerMeta").textContent += " · the batch stops after this job"; }));
  if (f.pose === "raise" && f.jobId) acts.push(link("Answer on the Jobs page", "jobs.html"));
  if (f.status === "failed") acts.push(btn("Dismiss", async () => { await updateLocal("orchestrator", (o = {}) => ({ ...o, dismissed: [...(o.dismissed || []), f.id].slice(-100) })); closeDrawer(); }));
  if (f.traceId) acts.push(link("Replay the run", `runs.html#${encodeURIComponent(f.traceId)}`));
  // Rebuilt only when the set of actions changes, so a focused button keeps its focus.
  setActions([f.id, f.status, f.pose, !!f.tabId, f.traceId].join("|"), () => acts);
}
function setActions(key: string, make: () => HTMLElement[]): void {
  if (key === actionsKey) return;
  actionsKey = key;
  $("#drawerActions").replaceChildren(...make());
}

// ---------- wiring ----------
// Loads can overlap (a storage change and the timer): only the newest one is drawn.
export async function refresh(): Promise<void> {
  const seq = ++loadSeq;
  const r = await load();
  if (seq !== loadSeq) return; // a newer load has drawn already
  r.apply();
  render(r.scene);
}

if ($("#powerhouseApp")) {
  const reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  view = createView($("#stage"), $("#overlay"), { reducedMotion });
  // A pick on the card returns focus to the card when the drawer closes (not to a list row
  // further down the page, which would scroll it).
  view.onPick(id => { view?.focus(id); openDrawer(id, "canvas"); });
  $("#zoomIn").onclick = () => view?.zoom(0.75);
  $("#zoomOut").onclick = () => view?.zoom(1.33);
  $("#zoomReset").onclick = () => view?.reset();
  // Timers are throttled in background tabs: catch up when the tab is seen again; draw nothing while hidden.
  const setLive = () => { const on = document.visibilityState === "visible"; view?.setLive(on); if (on) refresh(); };
  view.setLive(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", setLive);
  $("#pause").onclick = async () => { if (demo) { demoState = demoState === "Paused" ? "Working" : "Paused"; return refresh(); } await setPaused(!pausedNow); await refresh(); };
  $("#closeDrawer").onclick = closeDrawer;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && drawerFor) { e.preventDefault(); closeDrawer(); } });
  if (demo) demoBar();
  let queued = false;
  const soon = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; refresh(); }, 150); };
  if (!demo) chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.orchestrator || c.usage || c.capDaily || c.capMonthly || c.jobSettings || (c.jobs && drawerFor === "sk"))) soon();
    if (area === "session" && c.brainCalls) soon();
  });
  refresh();
}
