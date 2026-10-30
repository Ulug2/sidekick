import { DEFAULT_SETTINGS, effectiveProvider, getSettings, modelFor } from "../../core/llm/ai.js";

export const el = id => document.getElementById(id);
export const FIELDS = Object.keys(DEFAULT_SETTINGS).filter(k => el(k));

(async () => {
  const s = await getSettings();
  for (const k of FIELDS) {
    if (el(k).type === "checkbox") el(k).checked = !!s[k];
    else el(k).value = s[k] ?? "";
  }
  renderUsage();
  renderEvalStatus();
})();

el("save").onclick = async () => {
  const data = {};
  for (const k of FIELDS) data[k] = el(k).type === "checkbox" ? el(k).checked : el(k).value.trim();
  // Empty model fields fall back to the defaults.
  for (const k of ["anthropicFast", "anthropicSmart", "openaiFast", "openaiSmart", "anthropicBest", "openaiBest", "assistantName"]) if (!data[k]) data[k] = DEFAULT_SETTINGS[k];
  // If only one key is filled in, select that provider.
  if (data.openaiKey && !data.anthropicKey) data.provider = "openai";
  if (data.anthropicKey && !data.openaiKey) data.provider = "anthropic";
  el("provider").value = data.provider;
  const before = await getSettings();
  await chrome.storage.local.set(data);
  const changedBrain = ["customInstructions", "anthropicFast", "anthropicSmart", "openaiFast", "openaiSmart", "provider", "personality"].some(k => before[k] !== data[k]);
  el("status").textContent = changedBrain ? "Saved. Run the quality checks to make sure everything still works." : "Saved";
  setTimeout(() => (el("status").textContent = ""), 4000);
  renderEvalStatus();
};

export async function renderUsage() {
  const { usage = {} } = await chrome.storage.local.get("usage");
  const days = Object.keys(usage).sort().reverse();
  const today = new Date().toLocaleDateString("en-CA");
  const since = n => new Date(Date.now() - n * 86400000).toLocaleDateString("en-CA");
  const sum = (from) => {
    const by = {};
    for (const d of days) {
      if (d < from) continue;
      for (const [model, u] of Object.entries(usage[d])) {
        const m = (by[model] ||= { calls: 0, input: 0, output: 0, cacheRead: 0 });
        m.calls += u.calls; m.input += u.input + (u.cacheWrite || 0); m.output += u.output; m.cacheRead += u.cacheRead;
      }
    }
    return by;
  };
  const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  const box = el("usage");
  if (!days.length) { box.innerHTML = `<p class="muted small">No usage yet.</p>`; return; }
  box.innerHTML = "";
  for (const [label, from] of [["Today", today], ["Last 7 days", since(6)], ["Last 30 days", since(29)]]) {
    const by = sum(from);
    if (!Object.keys(by).length) continue;
    const h = document.createElement("p");
    h.className = "small";
    h.innerHTML = `<strong></strong>`;
    h.firstChild.textContent = label;
    box.appendChild(h);
    const t = document.createElement("table");
    t.className = "usage";
    t.innerHTML = `<thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Cached</th><th>Output</th></tr></thead><tbody></tbody>`;
    for (const [model, u] of Object.entries(by)) {
      const tr = document.createElement("tr");
      for (const v of [model, u.calls, fmt(u.input), fmt(u.cacheRead), fmt(u.output)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      }
      t.tBodies[0].appendChild(tr);
    }
    box.appendChild(t);
  }
}

export async function renderEvalStatus() {
  const { evalRuns = [] } = await chrome.storage.local.get("evalRuns");
  const last = evalRuns[0];
  const pill = el("evalStatus");
  if (!last) { pill.textContent = "Not run yet"; pill.className = "pill"; return; }
  const s = await getSettings();
  const stale = last.configKey !== evalConfigKey(s);
  pill.textContent = `${last.passed}/${last.total} passed on ${new Date(last.date).toLocaleDateString()}${stale ? " · settings changed since" : ""}`;
  pill.className = "pill " + (stale ? "" : last.passed / last.total >= 0.85 ? "good" : "bad");
}

// Same key the eval page uses to tell whether results still match the settings.
export function evalConfigKey(s) {
  return [effectiveProvider(s), modelFor(s, "fast"), modelFor(s, "smart"), s.smartEffort, s.fastEffort, s.personality, s.customInstructions].join("|");
}
