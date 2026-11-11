// A scan: read every company's job board, judge each posting, and merge it into the job list.
// No model calls; each company's board is one request.
import type { Company } from "./types.js";
import { fetchBoard, pool, slugGuesses, boardApi } from "./sources.js";
import { judgeJob, DEFAULT_ROLES, type JudgeOptions, type SponsorData } from "./eligibility.js";
import { sponsorLookup, normCompany, type SponsorLists } from "./sponsors.js";
import { changeCompanies, companyKey, getCompanies, mergeScan } from "./store.js";
import { updateLocal } from "../core/storage/update.js";
import { readLocal } from "../core/storage/schema.js";
import { getProfile } from "../assistant/profile-core.js";
import { cancelApplication } from "./daily.js";
import { chromeHost, type Host } from "../orchestrator/host.js";
import { webFetchOpts } from "../core/web/web.js";

export const SCAN_PARALLEL = 4;

// The profile's target roles ("Software Engineer, Mobile Developer"), or the defaults.
export async function targetRoles(): Promise<string[]> {
  const p = await getProfile();
  const own = String(p.desiredRoles || "").split(/[,;\n]|\bor\b/).map(s => s.replace(/\b(intern(ship)?|new grad|junior|entry[- ]level)\b/gi, "").trim().toLowerCase()).filter(s => s.length >= 3);
  return own.length ? [...new Set(own)] : DEFAULT_ROLES;
}
export async function loadSponsors(): Promise<{ data: SponsorData; lists: SponsorLists | null }> {
  const { sponsorLists } = await readLocal("sponsorLists");
  const lists = sponsorLists ? { ...sponsorLists, ...(await shippedLca()) } : null;
  return { data: sponsorLookup(lists), lists };
}
// DOL LCA counts shipped with the extension (public/data/lca.json, scripts/sponsors/build-lca.mjs).
// Absent until built: then the US evidence is USCIS H-1B data only.
let lcaCache: Pick<SponsorLists, "lca" | "lcaYears" | "lcaBuilt"> | null = null;
export async function shippedLca(): Promise<Pick<SponsorLists, "lca" | "lcaYears" | "lcaBuilt">> {
  if (lcaCache) return lcaCache;
  try {
    const res = await fetch(chrome.runtime.getURL("data/lca.json"));
    if (!res.ok) return (lcaCache = {});
    const d = await res.json() as { fy?: string; built?: number; counts?: Record<string, number> };
    const lca: Record<string, number> = {};
    for (const [name, n] of Object.entries(d.counts || {})) { const k = normCompany(name); if (k) lca[k] = (lca[k] || 0) + Number(n || 0); }
    return (lcaCache = { lca, lcaYears: String(d.fy || ""), lcaBuilt: Number(d.built) || 0 });
  } catch { return (lcaCache = {}); }
}

export async function judgeOptions(): Promise<JudgeOptions> {
  const { jobSettings } = await readLocal("jobSettings");
  return { internships: !!jobSettings?.internships, ...(jobSettings?.regions?.length && { regions: jobSettings.regions }) };
}
// Re-checks the jobs already in the list against the current rules without reading the boards
// (an internship switched off disappears from "To apply" at once). Jobs filtered out earlier kept
// no text, so switching internships on needs a scan.
// A queued job that leaves the batch this way loses its approved time and its alarm (an approval
// is never carried over to a later re-queue: LESSONS 20).
export async function rejudgeJobs(host: Host = chromeHost): Promise<number> {
  const [{ data }, roles, opts] = await Promise.all([loadSponsors(), targetRoles(), judgeOptions()]);
  let changed = 0;
  const unqueued: string[] = [];
  await updateLocal("jobs", (list = []) => list.map(j => {
    if (!["found", "queued"].includes(j.status) || (!j.ok && !j.text)) return j;
    const v = judgeJob(j, data, roles, Date.now(), opts);
    if (v.ok === j.ok && v.blocked === j.blocked) return j;
    changed++;
    if (j.status === "queued") unqueued.push(j.id);
    return { ...j, ok: v.ok, regions: v.regions, countries: v.countries, sponsor: v.sponsor, why: v.why, evidence: v.evidence, blocked: v.blocked, score: v.score, text: v.ok ? j.text : undefined, status: "found" as const, scheduledAt: undefined };
  }));
  for (const id of unqueued) await cancelApplication(host, id).catch(() => {});
  return changed;
}
export interface ScanProgress { done: number; total: number; company: string; found: number; errors: string[] }
export async function scanCompanies(only?: Company[], onProgress: (p: ScanProgress) => void = () => {}, signal?: AbortSignal): Promise<ScanProgress> {
  const companies = only || await getCompanies();
  const [{ data }, roles, opts] = await Promise.all([loadSponsors(), targetRoles(), judgeOptions()]);
  const prog: ScanProgress = { done: 0, total: companies.length, company: "", found: 0, errors: [] };
  await pool(companies, SCAN_PARALLEL, async c => {
    if (signal?.aborted) return;
    prog.company = c.name;
    let error = "", count = 0;
    try {
      const postings = await fetchBoard(c, signal);
      const judged = postings.map(p => ({ ...p, verdict: judgeJob(p, data, roles, Date.now(), opts) }));
      count = judged.filter(p => p.verdict.ok).length;
      await updateLocal("jobs", (list = []) => mergeScan(list, c, judged));
      prog.found += count;
    } catch (err: any) {
      if (err.name === "AbortError") return;
      error = String(err.message || err).slice(0, 160);
      prog.errors.push(`${c.name}: ${error}`);
    }
    await changeCompanies(list => list.map(x => companyKey(x) !== companyKey(c) ? x : { ...x, lastScan: Date.now(), jobs: count, lastError: error || undefined }));
    prog.done++;
    onProgress({ ...prog });
  });
  return prog;
}

// Employers from the sponsor lists whose job boards we don't know yet: tries the likely board names
// on each job board (one request each, a few at a time) and adds the ones that answer with jobs.
export async function discoverCompanies(names: string[], onProgress: (s: string) => void = () => {}, signal?: AbortSignal): Promise<Company[]> {
  const known = new Set((await getCompanies()).map(c => normCompany(c.name)));
  const todo = names.filter(n => !known.has(normCompany(n)));
  const found: Company[] = [];
  let i = 0;
  await pool(todo, SCAN_PARALLEL, async name => {
    if (signal?.aborted) return;
    onProgress(`Checking ${++i} of ${todo.length}: ${name}`);
    for (const board of slugGuesses(name)) {
      for (const ats of ["greenhouse", "ashby", "lever"] as const) {
        try {
          const res = await fetch(boardApi({ ats, board }), { ...webFetchOpts(signal, 15000), credentials: "omit" });
          if (!res.ok) continue;
          const d = await res.json();
          const n = ats === "lever" ? (Array.isArray(d) ? d.length : 0) : (d?.jobs?.length || 0);
          if (n) { found.push({ name: titleCase(name), ats, board, added: Date.now(), source: "found" }); return; }
        } catch (err: any) { if (err.name === "AbortError") return; }
      }
    }
  });
  if (found.length) await changeCompanies(list => { const have = new Set(list.map(companyKey)); return [...list, ...found.filter(c => !have.has(companyKey(c)))]; });
  return found;
}
const titleCase = (s: string) => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());

// The biggest H-1B sponsors (most approvals), as names to look for.
export function topSponsors(lists: SponsorLists | null, n = 120): string[] {
  return Object.entries(lists?.us || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
