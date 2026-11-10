// The Jobs page: every posting found on company job boards, whether you can take it and why,
// today's batch, where each application stands, companies, sponsor lists, CSV export.
// Titles, company names and places come from the web: rendered as text only, never HTML.
import { $ } from "../shared/dom.js";
import { readLocal } from "../../core/storage/schema.js";
import { updateLocal } from "../../core/storage/update.js";
import { formatCost } from "../../core/llm/prices.js";
import { monthSpend } from "../../bench/results.js";
import { boardFromUrl, changeCompanies, companyKey, DEFAULT_JOB_SETTINGS, getCompanies, getJobs, jobStats, jobsCsv, pickBatch, queueJobs, setJobStatus } from "../../jobs/store.js";
import { discoverCompanies, loadSponsors, rejudgeJobs, scanCompanies, topSponsors } from "../../jobs/scan.js";
import { downloadSponsorLists } from "../../jobs/sponsors.js";
import type { Company, Job, JobStatus, Region } from "../../jobs/types.js";

type Tab = "apply" | "batch" | "applied" | "needs" | "filtered" | "companies";

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const ago = (t?: number) => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const day = (t?: number) => t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
const REGION: Record<Region, string> = { usa: "USA", europe: "Europe", uae: "UAE" };
const SPONSOR: Record<string, string> = { strong: "sponsors", likely: "likely sponsors", possible: "may sponsor", unknown: "unknown", no: "no sponsorship" };

let tab: Tab = "apply";
let jobs: Job[] = [];
let companies: Company[] = [];
let settings = { ...DEFAULT_JOB_SETTINGS };
let running: AbortController | null = null;

// ---------- one job ----------
export function renderJob(j: Job): HTMLElement {
  const li = h("li", { class: `job ${j.sponsor}`, "data-id": j.id });
  const main = h("div", { class: "main" },
    h("a", { class: "title", href: j.url, target: "_blank", rel: "noopener noreferrer" }, j.title), " ", h("span", { class: "co" }, `· ${j.company}`),
    h("div", { class: "meta" },
      ...j.regions.map(r => h("span", { class: "chip" }, REGION[r])),
      h("span", { class: `chip sponsor-${j.sponsor}` }, SPONSOR[j.sponsor] || j.sponsor),
      j.status !== "found" ? h("span", { class: `chip status-${j.status}` }, j.status.replace("_", " ")) : "",
      h("span", {}, j.location || "no location"),
      j.postedAt ? h("span", {}, `posted ${day(j.postedAt)}`) : "",
      j.appliedAt ? h("span", {}, `applied ${day(j.appliedAt)}`) : "",
      h("span", { class: "chip", title: "priority" }, `P${j.score}`)
    ),
    h("div", { class: `why${j.ok ? "" : " blocked"}` }, j.ok ? j.why.join(" · ") : j.blocked || ""),
    j.note && j.status !== "found" ? h("div", { class: `why${j.status === "needs_you" ? " blocked" : ""}` }, j.note) : ""
  );
  if (j.coverLetter) main.append(h("details", { class: "letter" }, h("summary", {}, "Cover letter"), h("pre", {}, j.coverLetter)));
  const acts = h("div", { class: "acts" });
  const row = h("div", { class: "row" });
  const btn = (label: string, fn: () => Promise<void>, cls = "mini") => { const b = h("button", { type: "button", class: cls }, label); b.onclick = () => fn().then(render); return b; };
  if (j.status === "found" && j.ok) row.append(btn("Add to batch", () => queueJobs([j.id])), btn("Skip", () => setJobStatus(j.id, "skipped")));
  if (j.status === "queued") row.append(btn("Remove from batch", () => setJobStatus(j.id, "found")), btn("Skip", () => setJobStatus(j.id, "skipped")));
  if (["found", "queued", "needs_you"].includes(j.status)) row.append(btn("Applied by hand", () => setJobStatus(j.id, "applied")));
  if (j.status === "skipped" || (j.status === "found" && !j.ok)) row.append(btn(j.ok ? "Unskip" : "Keep anyway", () => updateLocal("jobs", (list = []) => list.map(x => x.id !== j.id ? x : { ...x, ok: true, why: x.ok ? x.why : ["You kept it"], blocked: undefined, status: "found", statusAt: Date.now() }))));
  if (["applied", "interview", "offer", "rejected"].includes(j.status)) {
    const sel = h("select", { "aria-label": "Status" }) as HTMLSelectElement;
    for (const s of ["applied", "interview", "offer", "rejected"] as JobStatus[]) sel.append(h("option", { value: s, ...(s === j.status && { selected: "" }) }, s));
    sel.onchange = () => setJobStatus(j.id, sel.value as JobStatus).then(render);
    row.append(sel);
  }
  row.append(h("a", { class: "mini", href: j.applyUrl, target: "_blank", rel: "noopener noreferrer", style: "font-size:12px" }, "Open form ↗"));
  if (j.traceId) row.append(h("a", { class: "mini", href: `runs.html#${encodeURIComponent(j.traceId)}`, target: "_blank", style: "font-size:12px" }, "Replay"));
  acts.append(row);
  const note = h("input", { type: "text", class: "note", placeholder: "Note" }) as HTMLInputElement;
  note.value = j.note || "";
  note.onchange = () => updateLocal("jobs", (list = []) => list.map(x => x.id !== j.id ? x : { ...x, note: note.value.trim() }));
  acts.append(note);
  li.append(h("div", { class: "bar" }), main, acts);
  return li;
}

function renderCompany(c: Company): HTMLElement {
  const li = h("li", { class: "company" }, h("span", { class: "name" }, c.name), h("span", { class: "board" }, `${c.ats} · ${c.board}${c.eu ? " (EU)" : ""} · ${c.jobs ?? "?"} matching · scanned ${ago(c.lastScan)}`));
  if (c.lastError) li.append(h("span", { class: "err" }, c.lastError));
  const del = h("button", { type: "button", class: "mini" }, "Remove");
  del.onclick = () => changeCompanies(list => list.filter(x => companyKey(x) !== companyKey(c))).then(render);
  li.append(del);
  return li;
}

// ---------- the page ----------
function visible(): Job[] {
  const q = String($("#search").value || "").trim().toLowerCase();
  const region = String($("#region").value || "") as Region | "";
  const byTab: Record<Tab, (j: Job) => boolean> = {
    apply: j => j.ok && j.status === "found", batch: j => ["queued", "applying"].includes(j.status),
    applied: j => ["applied", "interview", "offer", "rejected"].includes(j.status), needs: j => j.status === "needs_you",
    filtered: j => (!j.ok && j.status === "found") || j.status === "skipped" || j.status === "closed", companies: () => false
  };
  return jobs.filter(byTab[tab]).filter(j => !region || j.regions.includes(region)).filter(j => !q || `${j.company} ${j.title} ${j.location}`.toLowerCase().includes(q))
    .sort((a, b) => tab === "applied" ? (b.appliedAt || 0) - (a.appliedAt || 0) : b.score - a.score || (b.postedAt || 0) - (a.postedAt || 0));
}

export async function render(): Promise<void> {
  [jobs, companies] = await Promise.all([getJobs(), getCompanies()]);
  const { lists } = await loadSponsors();
  const { usage = {} } = await readLocal("usage");
  const stats = jobStats(jobs);
  const spend = monthSpend(usage);
  const lastScan = Math.max(0, ...companies.map(c => c.lastScan || 0));
  $("#sysline").replaceChildren(
    "SPONSOR LISTS ", h("b", {}, lists ? `UK ${lists.ukDate || "?"} · US H-1B FY${lists.usYears || "?"}` : "not downloaded"),
    "  ·  COMPANIES ", h("b", {}, String(companies.length)), "  ·  LAST SCAN ", h("b", {}, ago(lastScan)),
    "  ·  API THIS MONTH ", h("b", {}, `${formatCost(spend.cost)} of $${settings.monthlyCap}`));
  const tile = (v: string | number, k: string, s = "", cls = "") => h("div", { class: `tile ${cls}` }, h("div", { class: "v" }, String(v)), h("span", { class: "k" }, k), s ? h("span", { class: "s" }, s) : "");
  const today = h("div", { class: "tile green" }, h("div", { class: "v" }, String(stats.appliedToday), h("small", {}, ` / ${settings.dailyCap}`)), h("span", { class: "k" }, "applied today"), h("span", { class: "s" }, `${stats.queued} in the batch`));
  $("#hud").replaceChildren(
    tile(stats.eligible, "to apply", `${stats.companies} companies`), tile(stats.queued, "today's batch", stats.queued ? "ready to approve" : "press Build", "amber"), today,
    tile(stats.applied, "applied", `${stats.rejected} rejected`), tile(stats.interviews, "interviews", `${stats.offers} offers`, "amber"), tile(stats.needsYou, "need you", stats.needsYou ? "login, CAPTCHA or a question" : "", stats.needsYou ? "red" : "")
  );
  const { jobBatch } = await chrome.storage.session.get("jobBatch").catch(() => ({ jobBatch: undefined }));
  const batchActive = !!jobBatch || jobs.some(j => j.status === "applying");
  $("#start").hidden = !stats.queued || !!running || batchActive;
  $("#stop").hidden = !running && !batchActive;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs [role=tab]")) {
    const t = b.dataset.tab as Tab;
    b.setAttribute("aria-selected", String(t === tab));
    const n = t === "companies" ? companies.length : jobs.filter(j => ({ apply: j.ok && j.status === "found", batch: ["queued", "applying"].includes(j.status), applied: ["applied", "interview", "offer", "rejected"].includes(j.status), needs: j.status === "needs_you", filtered: (!j.ok && j.status === "found") || ["skipped", "closed"].includes(j.status) } as Record<string, boolean>)[t]).length;
    b.querySelector(".n")!.textContent = String(n);
  }
  const warn = $("#warning");
  const over = spend.cost >= settings.monthlyCap;
  warn.hidden = !over;
  warn.textContent = over ? `This month's API spend (${formatCost(spend.cost)}) has reached your limit of $${settings.monthlyCap}; the batch won't start until next month or a higher limit.` : "";
  const isCompanies = tab === "companies";
  $("#companiesBox").hidden = !isCompanies;
  $("#filters").hidden = isCompanies;
  $("#list").hidden = isCompanies;
  if (isCompanies) { $("#companies").replaceChildren(...companies.map(renderCompany)); $("#empty").hidden = true; return; }
  const rows = visible();
  $("#list").replaceChildren(...rows.slice(0, 300).map(renderJob));
  const empty = { apply: lists ? "No eligible jobs yet. Press Scan job boards." : "Download the sponsor lists first (Update sponsor lists), then Scan job boards.", batch: "No batch yet. Press Build today's batch.", applied: "Nothing applied yet.", needs: "Nothing waiting for you.", filtered: "Nothing filtered out yet.", companies: "" }[tab];
  $("#empty").textContent = rows.length ? "" : empty;
  $("#empty").hidden = !!rows.length;
}

async function withProgress(label: string, fn: (signal: AbortSignal, say: (s: string) => void) => Promise<string>): Promise<void> {
  if (running) return;
  running = new AbortController();
  const say = (s: string) => { $("#progress").textContent = s; };
  for (const id of ["scan", "build", "sponsors", "discover"]) ($(`#${id}`) as HTMLButtonElement).disabled = true;
  $("#stop").hidden = false;
  say(label);
  try { say(await fn(running.signal, say)); }
  catch (err: any) { say(err.name === "AbortError" ? "Stopped." : `${label} failed: ${err.message}`); }
  finally {
    running = null;
    for (const id of ["scan", "build", "sponsors", "discover"]) ($(`#${id}`) as HTMLButtonElement).disabled = false;
    await render();
  }
}

function download(name: string, text: string, type: string) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

if ($("#jobsApp")) {
  (async () => {
    settings = { ...DEFAULT_JOB_SETTINGS, ...((await readLocal("jobSettings")).jobSettings || {}) };
    $("#dailyCap").value = String(settings.dailyCap);
    $("#monthlyCap").value = String(settings.monthlyCap);
    $("#internships").checked = !!settings.internships;
    const saveSettings = async () => {
      const internshipsWas = !!settings.internships;
      settings = { dailyCap: Math.max(1, Math.min(50, Number($("#dailyCap").value) || DEFAULT_JOB_SETTINGS.dailyCap)), monthlyCap: Math.max(1, Math.min(200, Number($("#monthlyCap").value) || DEFAULT_JOB_SETTINGS.monthlyCap)), internships: !!$("#internships").checked };
      $("#dailyCap").value = String(settings.dailyCap); $("#monthlyCap").value = String(settings.monthlyCap);
      await chrome.storage.local.set({ jobSettings: settings });
      if (internshipsWas !== settings.internships) {
        const n = await rejudgeJobs();
        $("#progress").textContent = settings.internships ? `Internships will be kept from the next scan on. Press Scan job boards.` : `Internships off: ${n} moved to Filtered out.`;
      }
      render();
    };
    $("#dailyCap").onchange = saveSettings;
    $("#monthlyCap").onchange = saveSettings;
    $("#internships").onchange = saveSettings;
    for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs [role=tab]")) b.onclick = () => { tab = b.dataset.tab as Tab; render(); };
    $("#search").oninput = render;
    $("#region").onchange = render;
    $("#scan").onclick = () => withProgress("Scanning job boards…", async (signal, say) => {
      const p = await scanCompanies(undefined, x => say(`Scanning ${x.done} of ${x.total} boards (${x.company})… ${x.found} eligible so far`), signal);
      return `Scanned ${p.done} boards: ${p.found} eligible jobs${p.errors.length ? `; ${p.errors.length} board${p.errors.length > 1 ? "s" : ""} failed (see Companies)` : ""}.`;
    });
    $("#sponsors").onclick = () => withProgress("Updating sponsor lists…", async (signal, say) => {
      const lists = await downloadSponsorLists(say, signal);
      await chrome.storage.local.set({ sponsorLists: lists });
      return `Sponsor lists updated: ${lists.uk.length.toLocaleString()} UK sponsors (${lists.ukDate}), ${Object.keys(lists.us).length.toLocaleString()} US H-1B employers (FY${lists.usYears}). Scan the boards again to re-check every job.`;
    });
    $("#discover").onclick = () => withProgress("Looking for more companies…", async (signal, say) => {
      const { lists } = await loadSponsors();
      if (!lists) throw new Error("download the sponsor lists first.");
      const found = await discoverCompanies(topSponsors(lists), say, signal);
      return found.length ? `Added ${found.length} companies with public job boards: ${found.slice(0, 8).map(c => c.name).join(", ")}${found.length > 8 ? "…" : ""}. Press Scan job boards.` : "No new companies with public job boards among the top H-1B sponsors.";
    });
    $("#build").onclick = () => withProgress("Building today's batch…", async () => {
      const list = await getJobs();
      const room = Math.max(0, settings.dailyCap - jobStats(list).appliedToday - jobStats(list).queued);
      const ids = pickBatch(list, room);
      await queueJobs(ids);
      return ids.length ? `${ids.length} jobs in today's batch. Look them over, then press Approve & start batch.` : room ? "No eligible jobs left to add (one per company per month)." : `Today's limit of ${settings.dailyCap} is used up.`;
    });
    $("#start").onclick = async () => {
      const windowId = (await chrome.windows?.getCurrent?.().catch(() => null))?.id;
      if (windowId !== undefined) chrome.sidePanel.open({ windowId }).catch(() => {});
      await chrome.storage.session.remove("jobBatchStop");
      await chrome.storage.session.set({ jobBatch: { ts: Date.now(), windowId } });
      $("#progress").textContent = "Batch started: Sidekick opens its own Chrome window behind this one and applies there, one job at a time. Keep using this window; you'll be asked only when something needs you (Needs you tab).";
    };
    $("#stop").onclick = () => { running?.abort(); chrome.storage.session.remove("jobBatch"); chrome.storage.session.set({ jobBatchStop: true }); };
    $("#exportCsv").onclick = async () => download(`sidekick-jobs-${new Date().toISOString().slice(0, 10)}.csv`, jobsCsv(await getJobs()), "text/csv");
    ($("#addCompany") as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      const b = boardFromUrl($("#careersUrl").value);
      if (!b) { $("#progress").textContent = "That link isn't a Greenhouse, Lever, Ashby, Workable or SmartRecruiters job board. Open the company's careers page, click a job, and paste that link."; return; }
      const name = String($("#companyName").value || "").trim() || b.board;
      const c: Company = { name, ...b, added: Date.now(), source: "you" };
      await changeCompanies(list => list.some(x => companyKey(x) === companyKey(c)) ? undefined : [...list, c]);
      $("#careersUrl").value = ""; $("#companyName").value = "";
      await withProgress(`Scanning ${name}…`, async (signal) => { const p = await scanCompanies([c], () => {}, signal); return p.errors[0] ? `Couldn't read ${name}'s board: ${p.errors[0]}` : `${name} added: ${p.found} eligible jobs.`; });
    };
    chrome.storage.onChanged.addListener((changes, area) => { if ((area === "local" && (changes.jobs || changes.jobCompanies || changes.sponsorLists || changes.usage)) || (area === "session" && changes.jobBatch)) render(); });
    await render();
  })();
}
