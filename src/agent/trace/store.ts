// Where run traces live: chrome.storage.local "traceIndex" (one line per run), "trace:<id>" (the
// run without images) and "traceShot:<id>:<n>" (screenshots, written once each). The last
// MAX_TRACES runs are kept. Export makes one JSON file with the screenshots inside.
import { redactSecrets } from "../../core/security/guard.js";
import type { RunTrace, TraceOutcome } from "./trace.js";

export const MAX_TRACES = 30;
export const EXPORT_FORMAT = "sidekick-run";
export interface TraceIndexEntry { id: string; goal: string; startedAt: number; endedAt?: number; outcome: TraceOutcome; steps: number; cost: number; costKnown: boolean; site: string }
export interface TraceExport { format: typeof EXPORT_FORMAT; version: 1; exported: string; trace: RunTrace; shots: Record<string, string> }

// Index changes are queued: a run saving a step and the runs page deleting one can't lose each other's write.
let indexQueue: Promise<unknown> = Promise.resolve();
function updateIndex(fn: (index: TraceIndexEntry[]) => TraceIndexEntry[] | Promise<TraceIndexEntry[]>): Promise<void> {
  const next = indexQueue.then(async () => {
    const { traceIndex = [] } = (await chrome.storage.local.get("traceIndex")) as { traceIndex?: TraceIndexEntry[] };
    await chrome.storage.local.set({ traceIndex: await fn(traceIndex) });
  });
  indexQueue = next.catch(() => {});
  return next;
}

export async function listTraces(): Promise<TraceIndexEntry[]> {
  await indexQueue;
  const { traceIndex = [] } = (await chrome.storage.local.get("traceIndex")) as { traceIndex?: TraceIndexEntry[] };
  return traceIndex;
}
export async function loadTrace(id: string): Promise<RunTrace | null> {
  return ((await chrome.storage.local.get(`trace:${id}`)) as Record<string, RunTrace>)[`trace:${id}`] || null;
}
export async function loadShots(keys: string[]): Promise<Record<string, string>> {
  return keys.length ? ((await chrome.storage.local.get(keys)) as Record<string, string>) : {};
}
export const saveShot = (key: string, dataUrl: string) => chrome.storage.local.set({ [key]: dataUrl });

// A new run goes to the top. Runs still marked "running" were cut off (the panel closed or
// Chrome quit; only one run happens at a time), and the oldest beyond MAX_TRACES are deleted.
export function startIndexEntry(entry: TraceIndexEntry): Promise<void> {
  return updateIndex(async index => {
    for (const old of index.filter(e => e.outcome === "running")) {
      old.outcome = "interrupted";
      const t = await loadTrace(old.id);
      if (t) await chrome.storage.local.set({ [`trace:${t.id}`]: { ...t, outcome: "interrupted" } });
    }
    const keep = [entry, ...index];
    for (const gone of keep.splice(MAX_TRACES)) await removeTraceData(gone.id);
    return keep;
  });
}

export async function saveTrace(t: RunTrace): Promise<void> {
  await chrome.storage.local.set({ [`trace:${t.id}`]: t });
  await updateIndex(index => index.map(e => e.id !== t.id ? e : { ...e, outcome: t.outcome, endedAt: t.endedAt, steps: t.steps.length, cost: t.totals.cost, costKnown: t.totals.costKnown }));
}

async function removeTraceData(id: string): Promise<void> {
  const t = await loadTrace(id);
  await chrome.storage.local.remove([`trace:${id}`, ...(t?.shotKeys || [])]);
}
export function deleteTrace(id: string): Promise<void> {
  return updateIndex(async index => { await removeTraceData(id); return index.filter(e => e.id !== id); });
}
export function deleteAllTraces(): Promise<void> {
  return updateIndex(async index => { for (const e of index) await removeTraceData(e.id); return []; });
}

// Card numbers, API keys and ID numbers are masked in every text of an exported run.
function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactSecrets(v).text as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}
export async function exportTrace(id: string): Promise<TraceExport | null> {
  const t = await loadTrace(id);
  if (!t) return null;
  return { format: EXPORT_FORMAT, version: 1, exported: new Date().toISOString(), trace: redactDeep(t), shots: await loadShots(t.shotKeys) };
}

// An exported file someone opens: checked for shape; only JPEG/PNG data URLs are kept as images.
export function parseTraceExport(text: string): TraceExport {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't a Sidekick run (not JSON)."); }
  if (data?.format !== EXPORT_FORMAT || data.version !== 1 || typeof data.trace?.id !== "string" || !Array.isArray(data.trace.steps)) throw new Error("That file isn't a Sidekick run export.");
  const shots: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.shots || {})) if (typeof v === "string" && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v)) shots[k] = v;
  // Missing parts get empty defaults, so a file from another version still opens.
  const t = data.trace;
  const trace: RunTrace = {
    ...t,
    goal: String(t.goal ?? ""),
    start: { url: "", title: "", ...t.start },
    config: { provider: "", model: "unknown model", effort: "", approvalMode: "", trustedInput: false, ...t.config },
    totals: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, ...t.totals },
    steps: t.steps.map((s: any, i: number) => ({ n: i + 1, url: "", title: "", ...s, side: Array.isArray(s?.side) ? s.side : [], actions: Array.isArray(s?.actions) ? s.actions : [], events: Array.isArray(s?.events) ? s.events : [] })),
    shotKeys: Object.keys(shots)
  };
  return { ...data, trace, shots };
}
