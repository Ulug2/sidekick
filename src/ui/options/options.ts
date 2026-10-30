import { readLocal } from "../../core/storage/schema.js";
import { DEFAULT_SETTINGS, effectiveProvider, getSettings, modelFor, type Settings } from "../../core/llm/settings.js";

// Settings fields are <input>, <select> and <textarea> elements, keyed by setting name.
export const el = (id: string) => document.getElementById(id) as HTMLInputElement;
export const FIELDS = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).filter(k => el(k));

(async () => {
  const s = await getSettings();
  for (const k of FIELDS) {
    if (el(k).type === "checkbox") el(k).checked = !!s[k];
    else el(k).value = String(s[k] ?? "");
  }
  renderUsage();
  renderEvalStatus();
})();

el("save").onclick = async () => {
  const data: Record<string, any> = {};
  for (const k of FIELDS) data[k] = el(k).type === "checkbox" ? el(k).checked : el(k).value.trim();
  // Empty model fields fall back to the defaults.
  for (const k of ["anthropicFast", "anthropicSmart", "openaiFast", "openaiSmart", "anthropicBest", "openaiBest", "assistantName"]) if (!data[k]) data[k] = DEFAULT_SETTINGS[k as keyof Settings];
  // If only one key is filled in, select that provider.
  if (data.openaiKey && !data.anthropicKey) data.provider = "openai";
  if (data.anthropicKey && !data.openaiKey) data.provider = "anthropic";
  el("provider").value = data.provider;
  const before = await getSettings();
  await chrome.storage.local.set(data);
  const changedBrain = ["customInstructions", "anthropicFast", "anthropicSmart", "openaiFast", "openaiSmart", "provider", "personality"].some(k => before[k as keyof Settings] !== data[k]);
  el("status").textContent = changedBrain ? "Saved. Run the quality checks to make sure everything still works." : "Saved";
  setTimeout(() => (el("status").textContent = ""), 4000);
  renderEvalStatus();
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
