import { readLocal } from "../../core/storage/schema.js";
import { updateLocal } from "../../core/storage/update.js";
import { DEFAULT_SETTINGS, effectiveProvider, getSettings, modelFor, type Settings } from "../../core/llm/settings.js";
import { DEFAULT_CAPS, spendFor } from "../../core/llm/budget.js";
import { ALL_REGIONS, DEFAULT_JOB_SETTINGS } from "../../jobs/store.js";
import { rejudgeJobs } from "../../jobs/scan.js";
import { syncDailyAlarm } from "../../jobs/daily.js";
import { chromeHost } from "../../orchestrator/host.js";
import type { Region } from "../../jobs/types.js";
import { meterEl } from "../shared/meter.js";

// Settings fields are <input>, <select> and <textarea> elements, keyed by setting name.
export const el = (id: string) => document.getElementById(id) as HTMLInputElement;
export const FIELDS = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).filter(k => el(k));

// ---------- the section nav ----------
// Buttons, not links: a click scrolls to the section and moves focus to its heading; the button of
// the section in view is marked (aria-current) while scrolling; arrow keys, Home and End move
// between buttons, and Tab reaches every one.
export function setupNav(nav: HTMLElement): (id: string) => void {
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>("button[data-target]")];
  const sectionOf = (b: HTMLButtonElement) => document.getElementById(b.dataset.target!);
  // After a click, keep that item marked while the page scrolls there (the last sections can't
  // reach the top); released when the scroll settles, or at once when he scrolls himself.
  let pinned = false, pinnedTo: HTMLElement | null = null, release: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    pinned = false;
    const t = pinnedTo?.getBoundingClientRect().top;
    if (t === undefined || t < -10 || t > window.innerHeight * 0.6) spy(); // scrolled away meanwhile
  };
  const unpinAfter = (ms: number) => { clearTimeout(release); release = setTimeout(settle, ms); };
  const mark = (b: HTMLButtonElement | undefined) => {
    if (!b) return;
    for (const x of buttons) if (x === b) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current");
    // In the narrow layout the nav is one sideways row: keep the marked pill in view.
    if (nav.scrollWidth > nav.clientWidth) nav.scrollTo?.({ left: Math.max(0, b.offsetLeft - nav.clientWidth / 2 + b.offsetWidth / 2) });
  };
  const go = (id: string, focus = true) => {
    const b = buttons.find(x => x.dataset.target === id);
    const sec = b && sectionOf(b);
    if (!b || !sec) return;
    pinned = true;
    pinnedTo = sec;
    unpinAfter(1000);
    mark(b);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sec.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
    if (focus) sec.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    history.replaceState(null, "", `#${id}`);
  };
  for (const b of buttons) b.addEventListener("click", () => go(b.dataset.target!));
  nav.addEventListener("keydown", e => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length].focus();
  });
  const spy = () => {
    if (pinned) return;
    const top = (nav.getBoundingClientRect().bottom > 0 && getComputedStyle(nav).flexDirection === "row" ? nav.getBoundingClientRect().bottom : 72) + 24;
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let cur = buttons[0];
    for (const b of buttons) { const sec = sectionOf(b); if (sec && sec.getBoundingClientRect().top <= top) cur = b; }
    mark(atEnd && window.scrollY > 0 ? buttons[buttons.length - 1] : cur);
  };
  let queued = false;
  window.addEventListener("scroll", () => { if (pinned) { unpinAfter(200); return; } if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; spy(); }); } }, { passive: true });
  for (const ev of ["wheel", "touchmove", "pointerdown"]) window.addEventListener(ev, e => { if (!nav.contains(e.target as Node)) pinned = false; }, { passive: true });
  window.addEventListener("keydown", e => { if (!nav.contains(e.target as Node) && /^(Arrow|Page|Home|End| )/.test(e.key)) pinned = false; });
  const fromHash = location.hash.slice(1);
  if (buttons.some(b => b.dataset.target === fromHash)) go(fromHash, false); else mark(buttons[0]);
  return go;
}

// ---------- Settings → Jobs (stored in jobSettings, next to the Jobs page's own controls) ----------
type JobField = { id: string; key: "batchHour" | "batchSize" | "dailyCap" | "spreadHours" | "needsYouWaitMinutes" | "companyDays"; min: number; max: number };
export const JOB_NUMBERS: JobField[] = [
  { id: "jBatchHour", key: "batchHour", min: 0, max: 23 }, { id: "jBatchSize", key: "batchSize", min: 1, max: 30 },
  { id: "jDailyCap", key: "dailyCap", min: 1, max: 50 }, { id: "jSpread", key: "spreadHours", min: 2, max: 24 },
  { id: "jWait", key: "needsYouWaitMinutes", min: 1, max: 120 }, { id: "jCompanyDays", key: "companyDays", min: 7, max: 180 }
];
const regionBoxes = () => [...document.querySelectorAll<HTMLInputElement>("#jRegions input[type=checkbox]")];
async function loadJobSettings() {
  const j = { ...DEFAULT_JOB_SETTINGS, ...((await readLocal("jobSettings")).jobSettings || {}) };
  for (const f of JOB_NUMBERS) el(f.id).value = String(j[f.key]);
  el("jDailyBatch").checked = j.dailyBatch !== false;
  el("jInternships").checked = !!j.internships;
  const regions = j.regions?.length ? j.regions : ALL_REGIONS;
  for (const b of regionBoxes()) b.checked = regions.includes(b.value as Region);
}
// The values on the page, clamped; null when no place to look is ticked.
function jobPatch() {
  const regions = regionBoxes().filter(b => b.checked).map(b => b.value as Region);
  if (!regions.length) return null;
  const patch: Record<string, unknown> = { dailyBatch: el("jDailyBatch").checked, internships: el("jInternships").checked, regions };
  for (const f of JOB_NUMBERS) {
    const n = Math.round(Number(el(f.id).value));
    patch[f.key] = Number.isFinite(n) && el(f.id).value.trim() !== "" ? Math.max(f.min, Math.min(f.max, n)) : DEFAULT_JOB_SETTINGS[f.key];
    el(f.id).value = String(patch[f.key]);
  }
  return patch;
}

const syncEmailAuto = () => { (document.getElementById("emailAuto") as HTMLFieldSetElement).disabled = el("emailReplyMode").value !== "some"; };

export async function renderMeters() {
  const { usage, capDaily, capMonthly } = await readLocal(["usage", "capDaily", "capMonthly"]);
  const spend = spendFor(usage);
  el("meters").replaceChildren(meterEl("Today", spend.today, Number(capDaily ?? DEFAULT_CAPS.daily)), meterEl("This month", spend.month, Number(capMonthly ?? DEFAULT_CAPS.monthly)));
}

if (document.getElementById("sidenav")) setupNav(document.getElementById("sidenav")!);

(async () => {
  const s = await getSettings();
  for (const k of FIELDS) {
    if (el(k).type === "checkbox") el(k).checked = !!s[k];
    else el(k).value = String(s[k] ?? "");
  }
  await loadJobSettings();
  syncEmailAuto();
  el("emailReplyMode").addEventListener("change", syncEmailAuto);
  renderUsage();
  renderMeters();
  renderEvalStatus();
})();

el("save").onclick = async () => {
  const jobs = jobPatch();
  if (!jobs) {
    el("status").textContent = "Jobs: choose at least one place to look. Nothing was saved.";
    setTimeout(() => (el("status").textContent = ""), 6000);
    document.querySelector<HTMLButtonElement>('#sidenav [data-target="sec-jobs"]')?.click();
    return;
  }
  const data: Record<string, any> = {};
  for (const k of FIELDS) data[k] = el(k).type === "checkbox" ? el(k).checked : el(k).type === "number" ? Number(el(k).value) : el(k).value.trim();
  // Spend caps: dollars, 0 = no cap (core/llm/budget.ts).
  // An emptied field means "the default", never 0 (0 = no cap).
  data.capDaily = Math.max(0, Math.min(50, el("capDaily").value.trim() !== "" && Number.isFinite(data.capDaily) ? data.capDaily : DEFAULT_CAPS.daily));
  data.capMonthly = Math.max(0, Math.min(500, el("capMonthly").value.trim() !== "" && Number.isFinite(data.capMonthly) ? data.capMonthly : DEFAULT_CAPS.monthly));
  el("capDaily").value = String(data.capDaily); el("capMonthly").value = String(data.capMonthly);
  // Empty model fields fall back to the defaults.
  for (const k of ["anthropicFast", "anthropicSmart", "openaiFast", "openaiSmart", "anthropicBest", "openaiBest", "assistantName"]) if (!data[k]) data[k] = DEFAULT_SETTINGS[k as keyof Settings];
  // If only one key is filled in, select that provider.
  if (data.openaiKey && !data.anthropicKey) data.provider = "openai";
  if (data.anthropicKey && !data.openaiKey) data.provider = "anthropic";
  el("provider").value = data.provider;
  const before = await getSettings();
  await chrome.storage.local.set(data);
  // Job settings: merged under the lock (the Jobs page writes the same key).
  let was: Record<string, any> = {};
  await updateLocal("jobSettings", cur => { was = { ...DEFAULT_JOB_SETTINGS, ...(cur || {}) }; return { ...was, ...jobs } as typeof cur & object; });
  const notes: string[] = [];
  if (was.dailyBatch !== jobs.dailyBatch || was.batchHour !== jobs.batchHour) syncDailyAlarm(chromeHost).catch(() => {});
  const placesWas = [...(was.regions?.length ? was.regions : ALL_REGIONS)].sort().join(), places = [...(jobs.regions as Region[])].sort().join();
  if (placesWas !== places || !!was.internships !== jobs.internships) {
    const n = await rejudgeJobs().catch(() => 0);
    const added = (jobs.regions as Region[]).some(r => !placesWas.split(",").includes(r)) || (!was.internships && jobs.internships);
    notes.push(added ? "Scan the job boards (Jobs page) to find jobs in what you added." : `${n} job${n === 1 ? "" : "s"} moved to Filtered out.`);
  }
  const changedBrain = ["customInstructions", "anthropicFast", "anthropicSmart", "openaiFast", "openaiSmart", "provider", "personality"].some(k => before[k as keyof Settings] !== data[k]);
  el("status").textContent = [changedBrain ? "Saved. Run the quality checks to make sure everything still works." : "Saved.", ...notes].join(" ");
  setTimeout(() => (el("status").textContent = ""), 6000);
  renderEvalStatus();
  renderMeters();
};

export async function renderUsage() {
  const { usage = {} } = await readLocal("usage");
  const days = Object.keys(usage).sort().reverse();
  const today = new Date().toLocaleDateString("en-CA");
  const since = (n: number) => new Date(Date.now() - n * 86400000).toLocaleDateString("en-CA");
  const sum = (from: string) => {
    const by: Record<string, { calls: number; input: number; output: number; cacheRead: number }> = {};
    for (const d of days) {
      if (d < from) continue;
      for (const [model, u] of Object.entries(usage[d])) {
        const m = (by[model] ||= { calls: 0, input: 0, output: 0, cacheRead: 0 });
        m.calls += u.calls; m.input += u.input + (u.cacheWrite || 0); m.output += u.output; m.cacheRead += u.cacheRead;
      }
    }
    return by;
  };
  const fmt = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  const box = el("usage");
  if (!days.length) { box.innerHTML = `<p class="muted small">No usage yet.</p>`; return; }
  box.innerHTML = "";
  for (const [label, from] of [["Today", today], ["Last 7 days", since(6)], ["Last 30 days", since(29)]]) {
    const by = sum(from);
    if (!Object.keys(by).length) continue;
    const h = document.createElement("p");
    h.className = "small";
    h.innerHTML = `<strong></strong>`;
    h.firstChild!.textContent = label;
    box.appendChild(h);
    const t = document.createElement("table");
    t.className = "usage";
    t.innerHTML = `<thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Cached</th><th>Output</th></tr></thead><tbody></tbody>`;
    for (const [model, u] of Object.entries(by)) {
      const tr = document.createElement("tr");
      for (const v of [model, u.calls, fmt(u.input), fmt(u.cacheRead), fmt(u.output)]) {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.appendChild(td);
      }
      t.tBodies[0].appendChild(tr);
    }
    box.appendChild(t);
  }
}

export async function renderEvalStatus() {
  const { evalRuns = [] } = await readLocal("evalRuns");
  const last = evalRuns[0];
  const pill = el("evalStatus");
  if (!last) { pill.textContent = "Not run yet"; pill.className = "pill"; return; }
  const s = await getSettings();
  const stale = last.configKey !== evalConfigKey(s);
  pill.textContent = `${last.passed}/${last.total} passed on ${new Date(last.date).toLocaleDateString()}${stale ? " · settings changed since" : ""}`;
  pill.className = "pill " + (stale ? "" : last.passed / last.total >= 0.85 ? "good" : "bad");
}

// Same key the eval page uses to tell whether results still match the settings.
export function evalConfigKey(s: Settings): string {
  return [effectiveProvider(s), modelFor(s, "fast"), modelFor(s, "smart"), s.smartEffort, s.fastEffort, s.personality, s.customInstructions].join("|");
}
