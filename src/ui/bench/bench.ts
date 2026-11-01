// The Benchmark page (Phase F): the ten real-site tasks with their settings, Run (hands the task to
// the side panel, which runs it and records the result), grading, and the score per version.
// Run results contain page text and model output: shown as text only.
import { $ } from "../shared/dom.js";
import { formatCost } from "../../core/llm/prices.js";
import { getSettings, modelFor } from "../../core/llm/settings.js";
import { readLocal } from "../../core/storage/schema.js";
import { BENCH_TASKS, paramsFor, type BenchTask } from "../../bench/tasks.js";
import { benchCsv, DEFAULT_MAX_COST, deleteBenchRun, estimateCost, gradeBenchRun, isPriced, listBenchRuns, MAX_INTERVENTIONS, monthSpend, passed, scoreByVersion, type BenchPending, type BenchRun } from "../../bench/results.js";

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const secs = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

let windowId: number | undefined;
let saved: Record<string, Record<string, string>> = {};
let modelPriced = true;
let model = "";

// ---------- one task ----------
export function renderTask(task: BenchTask, runs: BenchRun[]): HTMLElement {
  const est = estimateCost(task.estSteps);
  const li = h("li", { class: "task", id: `task-${task.id}` });
  const fields = h("div", { class: "params" });
  const { params } = paramsFor(task, saved[task.id]);
  for (const p of task.params) {
    const input = h("input", { type: p.date ? "date" : "text", "data-key": p.key, placeholder: p.placeholder || "", spellcheck: "false" }) as HTMLInputElement;
    input.value = params[p.key] || "";
    input.onchange = async () => {
      saved[task.id] = { ...saved[task.id], [p.key]: input.value.trim() };
      await chrome.storage.local.set({ benchParams: saved });
    };
    fields.append(h("label", {}, p.label, input));
  }
  const status = h("p", { class: "small status", role: "status" });
  const run = h("button", { type: "button", class: "primary run" }, "Run") as HTMLButtonElement;
  run.disabled = !modelPriced;
  run.onclick = () => startTask(task, status);
  li.append(
    h("div", { class: "task-head" }, h("span", { class: "n" }, String(task.n)), h("div", { class: "grow" }, h("div", { class: "title" }, task.title),
      h("div", { class: "small muted" }, [task.site, task.mode === "chat" ? "chat (not Agent mode)" : "", task.login ? "sign in first" : "", `about ${formatCost(est.low)}–${formatCost(est.high)}`].filter(Boolean).join(" · "))), run),
    h("p", { class: "small success" }, h("strong", {}, "Success: "), task.success),
    task.params.length ? fields : "",
    status
  );
  const mine = runs.filter(r => r.taskId === task.id).slice(0, 5);
  if (mine.length) li.append(h("ol", { class: "runs" }, ...mine.map(renderRun)));
  return li;
}

function renderRun(r: BenchRun): HTMLElement {
  const verdictCls = r.verdict ? (passed(r) ? "pass" : "fail") : "ungraded";
  const li = h("li", { class: `run ${verdictCls}`, "data-run": r.id },
    h("div", { class: "small" }, h("strong", {}, r.verdict ? (passed(r) ? "Passed" : "Failed") : "Not graded"), " · ",
      [when(r.startedAt), `v${r.version}`, r.outcome, `${r.steps} step${r.steps === 1 ? "" : "s"}`, secs(r.ms), r.costKnown ? formatCost(r.cost) : `${formatCost(r.cost)}+`, `${r.interventions} intervention${r.interventions === 1 ? "" : "s"}${r.interventions > MAX_INTERVENTIONS ? " (too many to pass)" : ""}`].join(" · ")),
    h("ul", { class: "checks small" }, ...r.checks.map(c => h("li", { class: c.ok ? "ok" : "bad" }, `${c.ok ? "✓" : "✗"} ${c.note}`))),
    r.summary ? h("details", {}, h("summary", { class: "small" }, "Its answer"), h("pre", {}, r.summary)) : ""
  );
  const note = h("input", { type: "text", class: "note", placeholder: "Note (what went wrong?)" }) as HTMLInputElement;
  note.value = r.note || "";
  note.onchange = () => gradeBenchRun(r.id, r.verdict, note.value.trim());
  const pass = h("button", { type: "button", class: `grade-pass${r.verdict === "pass" ? " on" : ""}` }, "Did the job");
  const fail = h("button", { type: "button", class: `grade-fail${r.verdict === "fail" ? " on" : ""}` }, "Didn't");
  pass.onclick = () => gradeBenchRun(r.id, r.verdict === "pass" ? undefined : "pass", note.value.trim());
  fail.onclick = () => gradeBenchRun(r.id, r.verdict === "fail" ? undefined : "fail", note.value.trim());
  const del = h("button", { type: "button", class: "ghost small del" }, "Delete");
  del.onclick = () => deleteBenchRun(r.id);
  li.append(h("div", { class: "grade" }, pass, fail, note, r.traceId ? h("a", { class: "small", href: `runs.html#${encodeURIComponent(r.traceId)}`, target: "_blank" }, "Replay") : "", del));
  return li;
}

// Run: the side panel opens (only possible right inside the click), the task opens in a new tab,
// and the panel picks the task up from session storage.
function startTask(task: BenchTask, status: HTMLElement) {
  const { params, missing } = paramsFor(task, saved[task.id]);
  if (missing.length) { status.textContent = `Fill in: ${missing.join(", ")}.`; return; }
  const url = task.start(params);
  if (!/^https?:\/\//i.test(url)) { status.textContent = "The page address must start with https://"; return; }
  if (windowId !== undefined) chrome.sidePanel.open({ windowId }).catch(() => {});
  status.textContent = "Opening the task… watch the side panel.";
  const maxCost = Number(($("#maxCost") as HTMLInputElement).value) || DEFAULT_MAX_COST;
  chrome.tabs.create({ url, active: true, ...(windowId !== undefined && { windowId }) }).then(tab => {
    const pending: BenchPending = { taskId: task.id, goal: task.goal(params, new Date()), mode: task.mode, params, maxCost, tabId: tab.id!, ts: Date.now() };
    return chrome.storage.session.set({ benchPending: pending });
  }).catch(err => { status.textContent = `Couldn't start: ${err.message}`; });
}

// ---------- the page ----------
async function renderSpend() {
  const { usage = {} } = await readLocal("usage");
  const spend = monthSpend(usage);
  $("#monthSpend").textContent = `${formatCost(spend.cost)}${spend.unpriced.length ? ` (not counted, no price: ${spend.unpriced.join(", ")})` : ""}`;
}
export async function render(): Promise<void> {
  const runs = await listBenchRuns();
  const { benchParams = {} } = await readLocal("benchParams");
  saved = benchParams;
  await renderSpend();
  const warn = $("#priceWarning");
  warn.hidden = modelPriced;
  warn.textContent = modelPriced ? "" : `The agent model (${model}) has no price in Sidekick, so the per-run limit can't work. Pick a priced model in Settings (Claude Haiku/Sonnet/Opus 5.5, GPT-5.6 Luna or Terra) to run the benchmark.`;
  const tbody = $("#scores tbody");
  tbody.replaceChildren(...scoreByVersion(runs).map(s => h("tr", {}, h("td", {}, `v${s.version}`), h("td", {}, `${s.passedTasks} of ${s.graded}`), h("td", {}, `${s.graded} of ${BENCH_TASKS.length}`), h("td", {}, String(s.medianSteps)), h("td", {}, secs(s.medianMs)), h("td", {}, formatCost(s.medianCost)), h("td", {}, formatCost(s.totalCost)))));
  $("#noScores").hidden = runs.some(r => r.verdict);
  $("#tasks").replaceChildren(...BENCH_TASKS.map(t => renderTask(t, runs)));
}

function download(name: string, text: string, type: string) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

if ($("#benchApp")) {
  (async () => {
    windowId = (await chrome.windows?.getCurrent?.().catch(() => null))?.id;
    model = modelFor(await getSettings(), "smart");
    modelPriced = isPriced(model);
    const { benchMaxCost } = await readLocal("benchMaxCost");
    $("#maxCost").value = String(benchMaxCost || DEFAULT_MAX_COST);
    $("#maxCost").onchange = () => { const v = Math.max(0.05, Math.min(5, Number($("#maxCost").value) || DEFAULT_MAX_COST)); $("#maxCost").value = String(v); chrome.storage.local.set({ benchMaxCost: v }); };
    $("#exportCsv").onclick = async () => download(`sidekick-benchmark-${new Date().toISOString().slice(0, 10)}.csv`, benchCsv(await listBenchRuns()), "text/csv");
    $("#exportJson").onclick = async () => download(`sidekick-benchmark-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await listBenchRuns(), null, 1), "application/json");
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.benchParams) saved = (changes.benchParams.newValue as typeof saved) || {}; // edited in another tab
      if (changes.benchRuns) render();
      else if (changes.usage) renderSpend();
    });
    await render();
  })();
}
