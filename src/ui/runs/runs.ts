// The Agent runs page: recorded agent runs (agent/trace), a step-by-step replay of one, export to
// a JSON file and opening an exported file. Everything from a trace is page content or model
// output, so it's shown as text only (never as HTML); images are only JPEG/PNG data URLs.
import { $ } from "../shared/dom.js";
import { formatCost } from "../../core/llm/prices.js";
import { deleteAllTraces, deleteTrace, exportTrace, listTraces, loadShots, loadTrace, parseTraceExport, type TraceIndexEntry } from "../../agent/trace/store.js";
import type { RunTrace, TraceAction, TraceOutcome, TraceStep } from "../../agent/trace/trace.js";

const OUTCOME: Record<TraceOutcome, string> = { running: "Running", done: "Done", out_of_steps: "Ran out of steps", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" };
const IMAGE = /^data:image\/(jpeg|png);base64,/;

// Small DOM builder: text children only.
type Child = Node | string | null | undefined | false;
export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const details = (summary: string, body: string, open = false) => { const d = h("details", {}, h("summary", {}, summary), h("pre", {}, body)) as HTMLDetailsElement; d.open = open; return d; };

export const formatMs = (ms: number | undefined) => {
  if (ms == null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const costText = (cost: number, known: boolean) => known ? formatCost(cost) : `${formatCost(cost)}+ (some prices unknown)`;
const stepCost = (s: TraceStep) => [s.model, ...s.side].reduce<{ cost: number; known: boolean }>((a, c) => c ? { cost: a.cost + (c.cost || 0), known: a.known && c.cost != null } : a, { cost: 0, known: true });
const argsText = (args: unknown) => { try { return JSON.stringify(args ?? {}, null, 1).replace(/\n\s*/g, " "); } catch { return String(args); } };
// Replies are Markdown; here they're plain text, so bold and code markers are dropped.
const plain = (md: string) => md.replace(/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g, (_, a, b, c) => a ?? b ?? c);
const pill = (outcome: TraceOutcome) => h("span", { class: `pill ${outcome}` }, OUTCOME[outcome] || outcome);

// What a step did, in a few words: the actions' labels (or the model's reply when it only talked).
export function stepTitle(s: TraceStep): string {
  const labels = s.actions.map(a => a.label || a.tool).filter(Boolean);
  if (labels.length) return labels.join(" · ");
  if (s.model?.text) return s.model.text.split("\n")[0].slice(0, 120);
  return s.model ? "(no reply text)" : "(no model reply recorded)";
}

// ---------- the list ----------
export function renderList(entries: TraceIndexEntry[], ol: HTMLElement = $("#runList"), status: HTMLElement = $("#listStatus")): void {
  ol.replaceChildren();
  status.textContent = entries.length ? "" : "No runs recorded yet. Turn on Agent mode in the side panel and give it a task.";
  for (const e of entries) {
    const a = h("a", { href: `#${encodeURIComponent(e.id)}`, class: "run-link" },
      h("span", { class: "run-goal" }, e.goal || "(no task)"),
      h("span", { class: "run-meta small muted" }, [e.site, when(e.startedAt), `${e.steps} step${e.steps === 1 ? "" : "s"}`, e.endedAt ? formatMs(e.endedAt - e.startedAt) : "", costText(e.cost, e.costKnown)].filter(Boolean).join(" · ")));
    ol.append(h("li", {}, pill(e.outcome), a));
  }
}

// ---------- one run ----------
// opts.imported: opened from a file (not saved here, so no Delete).
export function renderRun(t: RunTrace, shots: Record<string, string>, root: HTMLElement, opts: { imported?: boolean; onExport?: () => void; onDelete?: () => void } = {}): { show(n: number): void } {
  root.replaceChildren();
  const dur = t.endedAt ? formatMs(t.endedAt - t.startedAt) : "";
  const actions = h("div", { class: "row" });
  if (opts.onExport) { const b = h("button", { type: "button", id: "exportRun" }, "Export"); b.onclick = opts.onExport; actions.append(b); }
  if (opts.onDelete) { const b = h("button", { type: "button", id: "deleteRun", class: "ghost" }, "Delete"); b.onclick = opts.onDelete; actions.append(b); }
  root.append(
    h("a", { href: "#", class: "back small" }, "← All runs"),
    h("h1", { class: "run-title" }, t.goal || "(no task)"),
    h("p", { class: "run-meta small muted" }, pill(t.outcome), " ", [opts.imported ? "opened from a file" : "", when(t.startedAt), dur, `${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`, `${t.totals.calls} AI call${t.totals.calls === 1 ? "" : "s"}`, costText(t.totals.cost, t.totals.costKnown), `${t.config.model} (${t.config.effort})`, t.version && `v${t.version}`].filter(Boolean).join(" · ")),
    t.start.url ? h("p", { class: "small muted run-start" }, `Started on ${t.start.title ? `${t.start.title} — ` : ""}${t.start.url}`) : "",
    t.summary ? h("div", { class: "run-summary" }, plain(t.summary)) : "",
    t.error ? h("div", { class: "run-summary bad" }, `Error: ${t.error}`) : "",
    actions
  );
  if (!t.steps.length) { root.append(h("p", { class: "muted" }, "No steps were recorded.")); return { show() {} }; }

  // The player: one step at a time, with a scrubber, previous/next and play.
  const range = h("input", { type: "range", min: "1", max: String(t.steps.length), value: "1", id: "stepRange", "aria-label": "Step" }) as HTMLInputElement;
  const counter = h("span", { class: "small muted counter", id: "stepCounter" });
  const prev = h("button", { type: "button", id: "prevStep", "aria-label": "Previous step" }, "←");
  const next = h("button", { type: "button", id: "nextStep", "aria-label": "Next step" }, "→");
  const play = h("button", { type: "button", id: "playSteps" }, "Play");
  const stage = h("div", { class: "stage", id: "stage" });
  const list = h("ol", { class: "step-list", id: "stepList" });
  root.append(h("div", { class: "player" }, h("div", { class: "controls" }, prev, range, next, play, counter), stage), h("h2", {}, "All steps"), list);

  let current = 1, timer: ReturnType<typeof setInterval> | undefined;
  const items: HTMLElement[] = [];
  for (const s of t.steps) {
    const failed = s.actions.some(a => !a.ok && !a.declined), declined = s.actions.some(a => a.declined);
    const li = h("li", { class: failed ? "fail" : declined ? "declined" : "" }, h("button", { type: "button" }, h("span", { class: "n" }, String(s.n)), h("span", { class: "t" }, stepTitle(s))));
    (li.firstChild as HTMLElement).onclick = () => { show(s.n); stage.scrollIntoView({ block: "start" }); };
    items.push(li);
    list.append(li);
  }
  const show = (n: number) => {
    current = Math.max(1, Math.min(t.steps.length, n));
    range.value = String(current);
    counter.textContent = `Step ${current} of ${t.steps.length}`;
    items.forEach((li, i) => li.classList.toggle("current", i + 1 === current));
    stage.replaceChildren(renderStep(t.steps[current - 1], shots, t.steps.length));
  };
  const stopPlay = () => { clearInterval(timer); timer = undefined; play.textContent = "Play"; };
  range.oninput = () => { stopPlay(); show(+range.value); };
  prev.onclick = () => { stopPlay(); show(current - 1); };
  next.onclick = () => { stopPlay(); show(current + 1); };
  play.onclick = () => {
    if (timer) return stopPlay();
    if (current >= t.steps.length) show(1);
    play.textContent = "Pause";
    timer = setInterval(() => { if (current >= t.steps.length) stopPlay(); else show(current + 1); }, 1600);
  };
  root.onkeydown = e => {
    if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
    if (e.key === "ArrowLeft") { stopPlay(); show(current - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { stopPlay(); show(current + 1); e.preventDefault(); }
  };
  show(1);
  return { show };
}

export function renderStep(s: TraceStep, shots: Record<string, string>, total: number): HTMLElement {
  const shot = s.shot && shots[s.shot];
  const picture = shot && IMAGE.test(shot)
    ? h("a", { class: "shot", href: "#", title: "Open full size" }, h("img", { src: shot, alt: `The page before step ${s.n}` }))
    : h("div", { class: "shot none small muted" }, s.shotNote ? `No screenshot: ${s.shotNote}` : "No screenshot");
  if (picture.tagName === "A") picture.onclick = e => { e.preventDefault(); openImage(shot as string); };
  const c = stepCost(s);
  const info = h("div", { class: "info" },
    h("div", { class: "where small" }, h("strong", {}, `Step ${s.n} of ${total}`), " · ", s.title || "", s.url ? h("span", { class: "url muted" }, ` ${s.url}`) : ""),
    h("div", { class: "small muted" }, [s.model && `${s.model.model}, ${formatMs(s.model.ms)}`, s.model && `${s.model.usage.input + s.model.usage.cacheRead + s.model.usage.cacheWrite} in / ${s.model.usage.output} out tokens`, `${costText(c.cost, c.known)} this step`].filter(Boolean).join(" · ")),
    s.prompt ? details("What the AI was told", s.prompt) : "",
    s.model?.thinking ? details("Its thinking (summary)", s.model.thinking) : "",
    s.model?.text ? h("div", { class: "said" }, plain(s.model.text)) : "",
    s.actions.length ? h("ol", { class: "actions" }, ...s.actions.map(a => renderAction(a, shots))) : (s.model ? h("p", { class: "small muted" }, "No actions: the reply ended the run or it was sent back to work.") : ""),
    s.events.length ? h("ul", { class: "events" }, ...s.events.map(ev => h("li", { class: ev.kind }, h("strong", {}, ev.kind === "approve" ? "Asked to approve" : ev.kind === "plan" ? "Asked to approve the plan" : ev.kind === "ask" ? "Asked you" : "Note"), ev.answer !== undefined ? ` → ${ev.answer}` : "", h("div", { class: "ev-text" }, ev.text)))) : "",
    s.side.length ? h("p", { class: "small muted side" }, `Other AI calls: ${s.side.map(x => `${x.purpose} (${x.model}, ${formatCost(x.cost)})`).join("; ")}`) : ""
  );
  return h("div", { class: "step-view" }, picture, info);
}

function renderAction(a: TraceAction, shots: Record<string, string>): HTMLElement {
  const state = a.declined ? "declined" : a.ok ? "ok" : "fail";
  const li = h("li", { class: state },
    h("div", { class: "a-head" }, h("span", { class: "a-state" }, a.declined ? "declined" : a.ok ? "✓" : "failed"), " ", a.label || a.tool, h("span", { class: "small muted" }, ` ${formatMs(a.ms)}`)),
    h("code", { class: "a-call" }, `${a.tool}(${argsText(a.args)})`),
    details(a.ok ? "Result" : "What went wrong", a.result || "(empty)", !a.ok && !a.declined));
  for (const key of a.shots || []) {
    const img = shots[key];
    if (img && IMAGE.test(img)) { const link = h("a", { href: "#", class: "a-shot" }, h("img", { src: img, alt: "Screenshot the agent took" })); link.onclick = e => { e.preventDefault(); openImage(img); }; li.append(link); }
  }
  return li;
}

// Full size, in a new tab, without putting the image in a URL anyone else sees.
function openImage(dataUrl: string) {
  fetch(dataUrl).then(r => r.blob()).then(b => window.open(URL.createObjectURL(b), "_blank", "noopener"));
}

function download(name: string, text: string) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL((a as HTMLAnchorElement).href); a.remove(); }, 1000);
}
export const exportName = (t: RunTrace) => `sidekick-run-${new Date(t.startedAt).toISOString().slice(0, 10)}-${(t.goal || "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "run"}.json`;

// ---------- the page ----------
async function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  const listView = $("#listView"), runView = $("#runView");
  if (!id) {
    runView.hidden = true;
    listView.hidden = false;
    renderList(await listTraces());
    return;
  }
  const t = await loadTrace(id);
  listView.hidden = true;
  runView.hidden = false;
  if (!t) { runView.replaceChildren(h("a", { href: "#", class: "back small" }, "← All runs"), h("p", { class: "muted" }, "That run isn't here any more (only the last 30 are kept).")); return; }
  renderRun(t, await loadShots(t.shotKeys || []), runView, {
    onExport: async () => {
      const data = await exportTrace(id);
      if (data) download(exportName(t), JSON.stringify(data));
      $("#exportRun").textContent = "Exported";
      $("#exportRun").title = "The file has the page text and what the agent typed (your details); card numbers and keys are masked. Share it only with people you trust.";
    },
    onDelete: async () => { await deleteTrace(id); location.hash = ""; }
  });
}

if ($("#runsApp")) {
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
  route();
  $("#importFile").onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    try {
      const data = parseTraceExport(await file.text());
      $("#listView").hidden = true;
      $("#runView").hidden = false;
      renderRun(data.trace, data.shots, $("#runView"), { imported: true });
    } catch (err: any) {
      $("#listStatus").textContent = err.message;
    }
  };
  let armed: ReturnType<typeof setTimeout> | undefined;
  $("#deleteAll").onclick = async () => {
    const b = $("#deleteAll");
    if (!armed) {
      b.textContent = "Click again to delete all runs";
      armed = setTimeout(() => { armed = undefined; b.textContent = "Delete all runs"; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    b.textContent = "Delete all runs";
    await deleteAllTraces();
    renderList([]);
  };
}
