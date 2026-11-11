// The Powerhouse page (docs/DESIGN.md §1): draws deriveScene() over the static room in
// powerhouse.html. Figures are keyed by worker id (one <g> each, updated in place); the worker list
// is the accessible path and opens the drawer; Pause/Resume sets orchestrator.paused. Everything a
// worker title or step contains came from the web: text only, never markup.
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
import type { Job } from "../../jobs/types.js";
import { COACH, SCALE, deriveScene, describe, type Figure, type Pose, type Scene } from "./scene.js";
import { speak } from "./voice.js";

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string | number> = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const BADGE: Record<Pose, [number, number]> = { pull: [0, -268], push: [74, -136], situp: [30, -150], sit: [-34, -150], raise: [-38, -150], slump: [-16, -150] };
const POSE_DX: Partial<Record<Pose, number>> = { situp: 40 };
const etTime = (t: number) => new Date(t).toLocaleString("en-US", { timeZone: BATCH_TZ, hour: "numeric", minute: "2-digit" }) + " ET";
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

let scene: Scene | null = null;
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

const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

// ---------- state ----------
export async function load(now = Date.now()): Promise<Scene> {
  const [{ orchestrator = {} }, { usage, capDaily, capMonthly }, { jobSettings }] = await Promise.all([
    readLocal("orchestrator"), readLocal(["usage", "capDaily", "capMonthly"]), readLocal("jobSettings")
  ]);
  const { brainCalls = [] } = await chrome.storage.session.get("brainCalls").catch(() => ({})) as { brainCalls?: BrainCall[] };
  // The job list can be large and changes on every scan: read it only for Sidekick's drawer.
  if (drawerFor === "sk") jobs = (await readLocal("jobs")).jobs || [];
  const js = { ...DEFAULT_JOB_SETTINGS, ...(jobSettings || {}) };
  const spend = spendFor(usage, new Date(now));
  const caps = { daily: Number(capDaily ?? DEFAULT_CAPS.daily), monthly: Number(capMonthly ?? DEFAULT_CAPS.monthly) };
  $("#meters").replaceChildren(meterEl("Today", spend.today, caps.daily), meterEl("This month", spend.month, caps.monthly));
  spendLine = `${formatCost(spend.today)} today, ${formatCost(spend.month)} this month`;
  pausedNow = orchestrator.paused === "you";
  return deriveScene({
    now, workers: orchestrator.workers || [], needsYou: orchestrator.needsYou, paused: orchestrator.paused, brainCalls,
    ...(orchestrator.lastShout && { lastShout: orchestrator.lastShout }), spend, caps, dismissed: orchestrator.dismissed,
    batchOn: js.dailyBatch !== false, nextBatchAt: js.dailyBatch !== false ? nextAt(now, js.batchHour) : null, formatTime: etTime
  });
}

// ---------- drawing ----------
function figureEl(f: Figure): SVGGElement {
  const g = svg("g", { class: "wk", "data-id": f.id }) as SVGGElement;
  g.style.setProperty("--d", `${-((f.n * 0.37) % 1.2).toFixed(2)}s`); // out of step with each other
  g.addEventListener("click", () => openDrawer(f.id));
  return g;
}
function drawFigure(g: SVGGElement, f: Figure): void {
  const key = [f.pose, f.x, f.y, f.tag, f.animate, f.n, f.label].join("|");
  g.classList.toggle("anim", f.animate);
  g.classList.toggle("wave", f.pose === "raise");
  const title = describe(f);
  if (g.dataset.key === key) { g.querySelector("title")!.textContent = title; return; }
  g.dataset.key = key;
  g.setAttribute("transform", `translate(${f.x + (POSE_DX[f.pose] || 0)} ${f.y}) scale(${SCALE})`);
  const [bx, by] = BADGE[f.pose];
  const badge = svg("g", { class: "badge", transform: `translate(${bx} ${by})` });
  const num = svg("text", { y: 7, "text-anchor": "middle", "font-size": 20, "font-weight": 700 }); num.textContent = String(f.n);
  badge.append(svg("circle", { r: 19 }), num);
  const parts: Element[] = [svg("title"), svg("use", { href: `#p-${f.pose}` }), badge];
  parts[0].textContent = title;
  if (f.tag === "?" || f.tag === "!") {
    const t = svg("g", { class: f.tag === "?" ? "tag-q" : "tag-err", transform: f.tag === "?" ? "translate(-6 -205)" : "translate(44 -150)" });
    const tx = svg("text", { y: 9, "text-anchor": "middle", "font-size": 28, "font-weight": 800 }); tx.textContent = f.tag;
    t.append(svg("rect", { x: -20, y: -22, width: 40, height: 40, rx: 10 }), tx);
    parts.push(t);
  } else if (f.tag) {
    const w = 16 + f.tag.length * 13;
    const t = svg("g", { class: "tag-word", transform: `translate(${bx} ${by - 40})` });
    const tx = svg("text", { y: 6, "text-anchor": "middle", "font-size": 18, "font-weight": 600 }); tx.textContent = f.tag;
    t.append(svg("rect", { x: -w / 2, y: -16, width: w, height: 30, rx: 15 }), tx);
    parts.push(t);
  }
  g.replaceChildren(...parts);
}

export function render(s: Scene): void {
  scene = s;
  const chip = $("#chip");
  chip.textContent = s.chip.text; chip.dataset.tone = s.chip.tone;
  $("#pause").textContent = pausedNow ? "Resume" : "Pause";
  $("#pause").setAttribute("aria-pressed", String(pausedNow));
  // Sidekick
  const coach = $("#coach");
  coach.dataset.coach = s.coach;
  $("#coachPoint").setAttribute("transform", s.shout?.facing === "right" ? "scale(-1 1)" : "");
  $("#coachTag").textContent = s.coachTag || "";
  $("#coachTagBox").setAttribute("width", String(28 + (s.coachTag || "").length * 10));
  $("#coachTag").setAttribute("x", String((28 + (s.coachTag || "").length * 10) / 2));
  $("#coachTagG").setAttribute("transform", `translate(${-(28 + (s.coachTag || "").length * 10) / 2} -205)`);
  $("#thinking").textContent = s.coach === "thinking" ? `Sidekick is thinking: ${s.thinkingAbout || "a decision"}.` : "";
  // the shout and its trace
  const wire = $("#wire"), bubble = $("#bubble");
  if (s.shout) {
    const { from, to } = s.shout;
    wire.setAttribute("d", `M${from.x} ${from.y} V740 H${to.x} V${to.y}`);
    wire.removeAttribute("hidden"); // SVG elements have no .hidden property
    bubble.textContent = s.shout.text;
    bubble.style.left = `${(COACH.x / 1600) * 100}%`;
    bubble.style.top = `${((COACH.y - 200) / 900) * 100}%`;
    bubble.hidden = false;
    const key = s.shout.workerId + s.shout.text;
    if (lastShoutKey !== key) { lastShoutKey = key; speak(s.shout.text); }
  } else { wire.setAttribute("hidden", ""); wire.setAttribute("d", ""); bubble.hidden = true; }
  // figures, keyed by worker id
  const layer = $("#figures");
  const keep = new Set<string>();
  for (const f of s.figures.filter(x => x.onStage)) {
    keep.add(f.id);
    let g = ([...layer.children] as SVGGElement[]).find(x => x.dataset.id === f.id) || null;
    if (!g) { g = figureEl(f); layer.append(g); }
    drawFigure(g, f);
  }
  for (const g of [...layer.children] as SVGGElement[]) if (!keep.has(g.dataset.id!)) g.remove();
  $("#moreChip").toggleAttribute("hidden", !s.hiddenCount);
  $("#moreText").textContent = `+${s.hiddenCount} more below`;
  // step logs
  for (const f of s.figures) {
    const log = logs.get(f.id) || [];
    if (f.step && log.at(-1) !== f.step) { log.push(f.step); logs.set(f.id, log.slice(-60)); }
  }
  for (const id of logs.keys()) if (!s.figures.some(f => f.id === id)) logs.delete(id);
  renderList(s);
  if (drawerFor) fillDrawer();
  // time alone changes the scene (a shout ends, a worker leaves): one timer, only when needed
  clearTimeout(tick);
  if (s.nextChange !== null) tick = setTimeout(refresh, Math.min(s.nextChange + 50, 60000));
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
async function openDrawer(id: string): Promise<void> {
  drawerFor = id;
  openerId = id;
  actionsKey = "";
  const d = $("#drawer");
  d.inert = false;
  d.classList.add("open");
  if (id === "sk") jobs = (await readLocal("jobs")).jobs || [];
  fillDrawer();
  $("#closeDrawer").focus();
}
function closeDrawer(): void {
  const d = $("#drawer");
  d.classList.remove("open");
  d.inert = true;
  drawerFor = null;
  ($$("#workerList button").find(b => b.dataset.open === openerId) || $("#workerList button"))?.focus?.();
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
  const s = await load();
  if (seq === loadSeq) render(s);
}

if ($("#powerhouseApp")) {
  // Timers are throttled in background tabs: catch up when the tab is seen again.
  const setLive = () => { const on = document.visibilityState === "visible"; $("#stage").classList.toggle("live", on); if (on) refresh(); };
  $("#stage").classList.toggle("live", document.visibilityState === "visible");
  document.addEventListener("visibilitychange", setLive);
  $("#pause").onclick = async () => { await setPaused(!pausedNow); await refresh(); };
  $("#closeDrawer").onclick = closeDrawer;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && drawerFor) { e.preventDefault(); closeDrawer(); } });
  let queued = false;
  const soon = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; refresh(); }, 150); };
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.orchestrator || c.usage || c.capDaily || c.capMonthly || c.jobSettings || (c.jobs && drawerFor === "sk"))) soon();
    if (area === "session" && c.brainCalls) soon();
  });
  refresh();
}
