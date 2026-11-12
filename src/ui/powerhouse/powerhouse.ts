// The Powerhouse page. One load of the real state gives a CityInput; deriveScene() (scene.ts, pure)
// turns it into the Scene the list, the status chip and line, the drawer and the timer use (the
// Silicon City contract, docs/powerhouse-redesign/04). Until the city view replaces it (M6), the 3D
// gym view (gpu3d.ts) still draws from scene-gym.ts, derived from the same load.
// Everything a worker title or step contains came from the web: text only, never markup.
// powerhouse.html#demo shows every state from made-up records, in memory only (no storage writes).
import { $ } from "../shared/dom.js";
import { meterEl } from "../shared/meter.js";
import { readLocal } from "../../core/storage/schema.js";
import { updateLocal } from "../../core/storage/update.js";
import { DEFAULT_CAPS, overCap, spendFor, type Spend } from "../../core/llm/budget.js";
import { formatCost } from "../../core/llm/prices.js";
import { DEFAULT_JOB_SETTINGS } from "../../jobs/store.js";
import { BATCH_TZ, nextAt } from "../../jobs/daily.js";
import { setPaused } from "../../orchestrator/workers.js";
import type { BrainCall } from "../../orchestrator/activity.js";
import type { NeedsYouItem, WorkerRecord } from "../../orchestrator/types.js";
import type { Job } from "../../jobs/types.js";
import { deriveScene, nextDeadline, type CityInput, type Scene, type SceneWorker } from "./scene.js";
import { deriveScene as deriveGym, type Scene as GymScene } from "./scene-gym.js";
import { createView, type PowerhouseView } from "./gpu3d.js";
import { createCityView, type CityView, type DrawInfo } from "./city-view.js";
import { speak } from "./voice.js";
import { MODEL_IDS } from "../../core/llm/models.js";

const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const etTime = (t: number) => new Date(t).toLocaleString("en-US", { timeZone: BATCH_TZ, hour: "numeric", minute: "2-digit" }) + " ET";
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

let scene: Scene | null = null;
let view: PowerhouseView | null = null;
let jobs: Job[] = [];
let lastBubbleKey = "";
let drawerFor: string | null = null; // a worker id, or "sk"
let openerId: string | null = null; // the list row that opened the drawer (rows are rebuilt; keep the id)
let actionsKey = "";
let loadSeq = 0;
let tick: ReturnType<typeof setTimeout> | undefined;
let pausedNow = false;
let spendLine = "";
const logs = new Map<string, string[]>(); // steps seen while this page is open, per worker
const demo = location.hash === "#demo";
// The Silicon City view is behind ?city=1 until it replaces the gym (docs/powerhouse-redesign/06, M6).
const cityMode = new URLSearchParams(location.search).get("city") === "1";
let cityView: CityView | null = null;

// ---------- state ----------
// The raw state, read once: what the city contract needs (04 › Inputs) and what the gym view needs.
interface Raw {
  now: number; workers: WorkerRecord[]; needsYou?: NeedsYouItem[]; pausedFlag?: string | null; brainCalls: BrainCall[];
  lastShout?: { text: string; at: number; workerId: string }; dismissed?: string[]; spend: Spend; caps: { daily: number; monthly: number };
  nextBatchAt: number | null;
}
export function cityInput(r: Raw): CityInput {
  const cap = overCap(r.spend, r.caps);
  return {
    now: r.now, workers: r.workers, needsYou: r.needsYou, brainCalls: r.brainCalls, dismissed: r.dismissed, formatTime: etTime,
    paused: r.pausedFlag === "you" ? "user" : cap ? "spendCap" : null, ...(cap && { capWhich: cap.which }),
    lastDispatch: r.lastShout ? { workerId: r.lastShout.workerId, at: r.lastShout.at } : null,
    sleepingUntil: r.nextBatchAt
  };
}
const gymScene = (r: Raw): GymScene => deriveGym({
  now: r.now, workers: r.workers, needsYou: r.needsYou, paused: r.pausedFlag, brainCalls: r.brainCalls, ...(r.lastShout && { lastShout: r.lastShout }),
  spend: r.spend, caps: r.caps, dismissed: r.dismissed, batchOn: r.nextBatchAt !== null, nextBatchAt: r.nextBatchAt, formatTime: etTime
});

// Reads everything. The page-wide side effects (meters, the Pause button's state) are returned as
// apply(), run only if this load is still the newest (refresh()).
async function load(now = Date.now()): Promise<{ raw: Raw; apply: () => void }> {
  if (demo) {
    const raw = demoRaw(now);
    return { raw, apply: () => { pausedNow = raw.pausedFlag === "you"; $("#meters").replaceChildren(meterEl("Today", raw.spend.today, 1), meterEl("This month", raw.spend.month, 25)); spendLine = "$0.31 today, $6.12 this month (demo)"; } };
  }
  const [{ orchestrator = {} }, { usage, capDaily, capMonthly }, { jobSettings }] = await Promise.all([
    readLocal("orchestrator"), readLocal(["usage", "capDaily", "capMonthly"]), readLocal("jobSettings")
  ]);
  const { brainCalls = [] } = await chrome.storage.session.get("brainCalls").catch(() => ({})) as { brainCalls?: BrainCall[] };
  // The job list can be large and changes on every scan: read it only for Sidekick's drawer.
  if (drawerFor === "sk") jobs = (await readLocal("jobs")).jobs || [];
  const js = { ...DEFAULT_JOB_SETTINGS, ...(jobSettings || {}) };
  const spend = spendFor(usage, new Date(now));
  const caps = { daily: Number(capDaily ?? DEFAULT_CAPS.daily), monthly: Number(capMonthly ?? DEFAULT_CAPS.monthly) };
  const raw: Raw = {
    now, workers: orchestrator.workers || [], needsYou: orchestrator.needsYou, pausedFlag: orchestrator.paused, brainCalls,
    ...(orchestrator.lastShout && { lastShout: orchestrator.lastShout }), dismissed: orchestrator.dismissed, spend, caps,
    nextBatchAt: js.dailyBatch !== false ? nextAt(now, js.batchHour) : null
  };
  const apply = () => {
    $("#meters").replaceChildren(meterEl("Today", spend.today, caps.daily), meterEl("This month", spend.month, caps.monthly));
    spendLine = `${formatCost(spend.today)} today, ${formatCost(spend.month)} this month`;
    pausedNow = orchestrator.paused === "you";
  };
  return { raw, apply };
}

// ---------- demo (made-up records, never stored) ----------
const DEMO_STATES = ["Idle", "Thinking", "Dispatch", "Working", "Needs you", "Failed", "Paused", "Busy day", "Overflow"] as const;
let demoState: (typeof DEMO_STATES)[number] = "Dispatch";
let demoAt = Date.now();
function demoRaw(now: number): Raw {
  const W = (o: Partial<WorkerRecord>): WorkerRecord => ({ id: "d1", n: 1, kind: "apply", title: "Apply: Software Engineer, New Grad at Stripe", model: MODEL_IDS.anthropic.fast, status: "working", step: "Page 2: Education", startedAt: demoAt, updatedAt: now, cost: 0, steps: 3, ...o });
  const crew = [W({}), W({ id: "d2", n: 2, title: "Apply: Backend Engineer at Ramp", startedAt: demoAt + 1 }), W({ id: "d3", n: 3, kind: "write", title: "Cover letter: Plaid", step: "Writing", startedAt: demoAt + 2 }), W({ id: "d4", n: 4, kind: "read", title: "Read: Datadog careers page", step: "Reading the posting", startedAt: demoAt + 3 })];
  const raw: Raw = { now, workers: [], brainCalls: [], spend: { today: 0.31, month: 6.12, unpriced: [] }, caps: { daily: 1, monthly: 25 }, nextBatchAt: nextAt(now, 8) };
  switch (demoState) {
    case "Idle": break;
    case "Thinking": raw.workers = crew.slice(0, 1); raw.brainCalls = [{ id: "b", what: "Pick the best 18 to apply to today", startedAt: now }]; break;
    case "Dispatch": raw.workers = crew; raw.lastShout = { text: "Agent 1! Apply: Software Engineer, New Grad at Stripe", at: now - 500, workerId: "d1" }; break;
    case "Working": raw.workers = crew; break;
    case "Needs you": raw.workers = [...crew.slice(1), W({ status: "needs_you", step: "Waiting for you" })]; break;
    case "Failed": raw.workers = [...crew.slice(0, 2), W({ id: "d5", n: 5, status: "failed", error: "The form wants an account and a password.", title: "Apply: SRE at Delta" }), W({ id: "d6", n: 6, status: "done", step: "Submitted", title: "Apply: Platform Engineer at Bravo" })]; break;
    case "Paused": raw.workers = crew.slice(0, 2); raw.pausedFlag = "you"; break;
    case "Busy day": raw.workers = [...crew, ...[5, 6, 7].map(n => W({ id: `d${n}`, n, title: `Apply: Engineer at Company ${n}`, startedAt: demoAt + n })), W({ id: "d8", n: 8, kind: "read", title: "Read: Ramp careers page", startedAt: demoAt + 8 }), W({ id: "d9", n: 9, status: "needs_you" }), W({ id: "d10", n: 10, status: "failed", error: "Blocked by a CAPTCHA." })]; raw.brainCalls = [{ id: "b", what: "Ranking 14 new postings against your profile", startedAt: now }]; break;
    case "Overflow": raw.workers = Array.from({ length: 12 }, (_, i) => W({ id: `o${i + 1}`, n: i + 1, kind: i % 3 === 0 ? "read" : "apply", title: i % 3 === 0 ? `Read: careers page ${i + 1}` : `Apply: Engineer at Company ${i + 1}`, startedAt: demoAt + i })); break;
  }
  return raw;
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
export function render(s: Scene, gym: GymScene, input: CityInput): void {
  scene = s;
  const chip = $("#chip");
  chip.textContent = s.chip.text; chip.dataset.tone = s.chip.tone;
  $("#pause").textContent = pausedNow ? "Resume" : "Pause";
  $("#pause").setAttribute("aria-pressed", String(pausedNow));
  const lead = document.createElement("b"); lead.textContent = s.line[0];
  $("#thinking").replaceChildren(lead, ` ${s.line[1]}`);
  $("#overlay").dataset.coach = gym.coach; // the gym view (until M6)
  $("#overlay").dataset.mode = s.sidekick.mode;
  if (s.sidekick.bubble) { const key = `${s.sidekick.dispatchTo}:${s.sidekick.bubble}`; if (lastBubbleKey !== key) { lastBubbleKey = key; speak(`Agent ${s.workers.find(w => w.id === s.sidekick.dispatchTo)?.n ?? ""}! ${s.sidekick.bubble}`); } }
  if (cityMode) cityView?.apply(s); else view?.update(gym);
  const everyone = [...s.workers, ...s.overflow];
  for (const w of everyone) {
    const log = logs.get(w.id) || [];
    if (w.rec.step && log.at(-1) !== w.rec.step) { log.push(w.rec.step); logs.set(w.id, log.slice(-60)); }
  }
  for (const id of logs.keys()) if (!everyone.some(w => w.id === id)) logs.delete(id);
  renderList(s);
  if (drawerFor) fillDrawer();
  // time alone changes the scene (a shout ends, a worker leaves): one timeout to the next deadline
  clearTimeout(tick);
  const next = demo ? null : nextDeadline(input);
  if (next !== null) tick = setTimeout(refresh, Math.min(Math.max(0, next - input.now) + 50, 2 ** 31 - 1));
}

function renderList(s: Scene): void {
  const items: HTMLElement[] = [];
  const li = (n: string, title: string, sub: string, pill: SceneWorker["pill"], open: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.open = open;
    const nEl = document.createElement("span"); nEl.className = "wl-n"; nEl.textContent = n; nEl.setAttribute("aria-hidden", "true");
    const main = document.createElement("span"); main.className = "wl-main";
    const t = document.createElement("span"); t.className = "wl-title"; t.textContent = title;
    const sb = document.createElement("span"); sb.className = "wl-sub"; sb.textContent = sub;
    main.append(t, sb);
    const st = document.createElement("span"); st.className = "wl-state"; st.dataset.tone = pill.tone; st.textContent = pill.text;
    b.append(nEl, main, st);
    b.setAttribute("aria-label", `${open === "sk" ? "Sidekick" : `Agent ${n}`}: ${title}. ${sub}. ${pill.text}`);
    b.addEventListener("click", () => openDrawer(open));
    const item = document.createElement("li"); item.append(b);
    return item;
  };
  items.push(li("S", "Sidekick", s.sidekick.row, s.sidekick.pill, "sk"));
  for (const w of [...s.workers, ...s.overflow].sort((a, b) => a.n - b.n)) items.push(li(String(w.n), w.title || "Task", w.step || "", w.pill, w.id));
  const focused = (document.activeElement as HTMLElement | null)?.closest?.("#workerList button") as HTMLElement | null;
  const keepFocus = focused?.dataset.open;
  $("#workerList").replaceChildren(...items);
  if (keepFocus) ($$("#workerList button").find(b => b.dataset.open === keepFocus) || $("#workerList button"))?.focus();
  const empty = $("#emptyList");
  empty.hidden = s.workers.length + s.overflow.length > 0;
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
      p(`${scene.line[0]} ${scene.line[1]}`),
      p(approved.length ? `Next applications: ${approved.slice(0, 3).map(j => `${j.company} at ${etTime(j.scheduledAt!)}`).join(", ")}${approved.length > 3 ? ` and ${approved.length - 3} more` : ""}.` : "No applications scheduled."),
      p(`${waiting ? `${waiting} job${waiting > 1 ? "s" : ""} in today's batch waiting for your approval. ` : ""}${scene.needsYou ? `${scene.needsYou} worker${scene.needsYou > 1 ? "s" : ""} need${scene.needsYou === 1 ? "s" : ""} you.` : ""}`.trim() || "Nothing waiting for you."),
      p(`Spend: ${spendLine}.`)
    );
    log.replaceChildren();
    setActions("sk", () => [link("Jobs page", "jobs.html"), link("Settings", "options.html#sec-jobs")]);
    return;
  }
  const w = [...scene.workers, ...scene.overflow].find(x => x.id === drawerFor);
  if (!w) { $("#drawerTitle").textContent = "This worker has left"; $("#drawerMeta").textContent = ""; body.replaceChildren(p("It finished more than 30 seconds ago. Its run is on the Agent runs page.")); log.replaceChildren(); setActions("gone", () => [link("Agent runs", "runs.html")]); return; }
  const r = w.rec;
  $("#drawerTitle").textContent = `Agent ${w.n} · ${w.title || "Task"}`;
  // Cost is filled in when a run ends (the trace has it); while it runs it isn't known yet.
  $("#drawerMeta").textContent = [r.model || "model ?", `started ${clock(r.startedAt)}`, r.cost > 0 ? formatCost(r.cost) : "", w.pill.text].filter(Boolean).join(" · ");
  body.replaceChildren(...[r.error ? p(`Error: ${r.error}`) : null, w.activity === "ask" ? p("It has a question only you can answer, or a step only you can do. Answer it on the Jobs page (Needs you).") : null].filter(Boolean) as HTMLElement[]);
  // The log grows in place; it follows the newest step only if you were already at the bottom.
  const steps = logs.get(w.id) || [];
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  if (log.dataset.for !== w.id) { log.replaceChildren(); log.dataset.for = w.id; }
  for (const s of steps.slice(log.children.length)) { const li = document.createElement("li"); li.textContent = s; log.append(li); }
  if (atBottom) log.scrollTop = log.scrollHeight;
  const acts: HTMLElement[] = [];
  if (r.tabId && r.status === "working") acts.push(btn("Open its tab", async () => { const t = await chrome.tabs.update(r.tabId!, { active: true }).catch(() => null); if (t?.windowId !== undefined) chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); }));
  if (demo) { setActions("demo", () => [p("Demo: actions are off here; nothing is stored.")]); return; }
  if (r.status === "working" && r.kind === "apply") acts.push(btn("Stop the batch after this job", async () => { await chrome.storage.session.set({ jobBatchStop: true }); $("#drawerMeta").textContent += " · the batch stops after this job"; }));
  if (w.activity === "ask" && r.jobId) acts.push(link("Answer on the Jobs page", "jobs.html"));
  if (r.status === "failed") acts.push(btn("Dismiss", async () => { await updateLocal("orchestrator", (o = {}) => ({ ...o, dismissed: [...(o.dismissed || []), w.id].slice(-100) })); closeDrawer(); }));
  if (r.traceId) acts.push(link("Replay the run", `runs.html#${encodeURIComponent(r.traceId)}`));
  // Rebuilt only when the set of actions changes, so a focused button keeps its focus.
  setActions([w.id, r.status, w.activity, !!r.tabId, r.traceId].join("|"), () => acts);
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
  const input = cityInput(r.raw);
  render(deriveScene(input), gymScene(r.raw), input);
}

// The demo page's render meter: live fps, or stopped with the total frame count (05 › Page).
function showMeter(info: DrawInfo): void {
  let m = document.getElementById("renderMeter");
  if (!m) { m = document.createElement("div"); m.id = "renderMeter"; m.className = "ph-meter"; m.setAttribute("aria-hidden", "true"); $("#stage").append(m); }
  m.textContent = info.running ? `live · ${info.fps} fps · ${info.calls} draws` : `stopped · nothing moving · ${info.frames} frames total · ${info.calls} draws`;
  m.dataset.running = String(info.running); m.dataset.frames = String(info.frames); m.dataset.calls = String(info.calls);
}

if ($("#powerhouseApp")) {
  const reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (cityMode) {
    cityView = createCityView($("#stage"), { onPick: id => openDrawer(id, "canvas"), reducedMotion, ...(demo && { onDraw: showMeter }) });
    if (!cityView) { const n = document.createElement("p"); n.className = "nogl"; n.textContent = "3D view is off because WebGL is not available. The worker list below shows everything."; $("#stage").append(n); }
    addEventListener("pagehide", () => cityView?.dispose());
  } else {
    view = createView($("#stage"), $("#overlay"), { reducedMotion });
    // A pick on the card returns focus to the card when the drawer closes (not to a list row
    // further down the page, which would scroll it).
    view.onPick(id => { view?.focus(id); openDrawer(id, "canvas"); });
  }
  $("#zoomIn").onclick = () => cityMode ? cityView?.zoom(0.75) : view?.zoom(0.75);
  $("#zoomOut").onclick = () => cityMode ? cityView?.zoom(1.33) : view?.zoom(1.33);
  $("#zoomReset").onclick = () => cityMode ? cityView?.resetView() : view?.reset();
  // Timers are throttled in background tabs: catch up when the tab is seen again; draw nothing while
  // hidden (the city view stops its own loop when the tab is hidden).
  const setLive = () => { const on = document.visibilityState === "visible"; view?.setLive(on); if (on) refresh(); };
  view?.setLive(document.visibilityState === "visible");
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
