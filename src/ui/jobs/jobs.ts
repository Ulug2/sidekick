// The Jobs page: every posting found on company job boards, whether you can take it and why,
// today's batch, where each application stands, companies, sponsor lists, CSV export.
// Titles, company names and places come from the web: rendered as text only, never HTML.
import { $ } from "../shared/dom.js";
import { readLocal } from "../../core/storage/schema.js";
import { updateLocal } from "../../core/storage/update.js";
import { DEFAULT_CAPS, overCap, spendFor } from "../../core/llm/budget.js";
import { readLog } from "../../orchestrator/log.js";
import type { ActionLogEntry } from "../../orchestrator/types.js";
import { boardFromUrl, changeCompanies, companyKey, DEFAULT_JOB_SETTINGS, getCompanies, getJobs, jobStats, jobsCsv, pickBatch, queueJobs, setJobStatus } from "../../jobs/store.js";
import { discoverCompanies, loadSponsors, rejudgeJobs, scanCompanies, topSponsors } from "../../jobs/scan.js";
import { downloadSponsorLists } from "../../jobs/sponsors.js";
import { normalizeLevel } from "../../jobs/sponsorship.js";
import { approveSpread, BATCH_TZ, cancelApplication, syncDailyAlarm } from "../../jobs/daily.js";
import { resolveNeedsYou } from "../../jobs/needs-you.js";
import { chromeHost } from "../../orchestrator/host.js";
import { meterEl } from "../shared/meter.js";
import type { Company, Job, JobStatus, Region } from "../../jobs/types.js";

type Tab = "apply" | "batch" | "applied" | "needs" | "filtered" | "companies" | "activity";

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (t?: number) => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const day = (t?: number) => t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
const REGION: Record<Region, string> = { usa: "USA", europe: "Europe", canada: "Canada", uae: "UAE" };
const SPONSOR: Record<string, string> = { confirmed: "sponsors", likely: "likely sponsors", unknown: "unknown", no: "no sponsorship" };

let tab: Tab = "apply";
let jobs: Job[] = [];
let companies: Company[] = [];
let settings = { ...DEFAULT_JOB_SETTINGS };
let caps = { ...DEFAULT_CAPS };
let actions: ActionLogEntry[] = [];
let running: AbortController | null = null;
const unapprovedOf = (list: Job[]) => list.filter(j => j.status === "queued" && !j.scheduledAt).length;

// ---------- one job ----------
export function renderJob(j: Job): HTMLElement {
  const level = normalizeLevel(j.sponsor);
  const li = h("li", { class: `job ${level}`, "data-id": j.id });
  const main = h("div", { class: "main" },
    h("a", { class: "title", href: j.url, target: "_blank", rel: "noopener noreferrer" }, j.title), " ", h("span", { class: "co" }, `· ${j.company}`),
    h("div", { class: "meta" },
      j.regions.length ? h("span", { class: "chip" }, j.regions.map(r => REGION[r]).join(" · ")) : "",
      h("span", { class: `chip sponsor-${level}`, title: [`Priority ${j.score}`, ...(j.evidence || []).map(e => `${e.confidence}: ${e.text} (${e.source}${e.date ? `, ${e.date}` : ""})`)].join("\n") }, SPONSOR[level] || level),
      j.status === "queued" ? h("span", { class: "chip" }, j.scheduledAt ? `at ${new Date(j.scheduledAt).toLocaleString("en-US", { timeZone: BATCH_TZ, weekday: "short", hour: "numeric", minute: "2-digit" })} ET` : "not approved") : "",
      j.status !== "found" ? h("span", { class: `chip status-${j.status}` }, j.status.replace("_", " ")) : "",
      h("span", {}, j.location || "no location"),
      j.postedAt ? h("span", {}, `posted ${day(j.postedAt)}`) : "",
      j.appliedAt ? h("span", {}, `applied ${day(j.appliedAt)}`) : ""
    ),
    h("div", { class: `why${j.ok ? "" : " blocked"}` }, j.ok ? (j.evidence?.length ? j.evidence.map(e => `${e.confidence}: ${e.text}${e.date && !e.text.includes(e.date) ? ` (${e.date})` : ""}`) : j.why).join(" · ") : j.blocked || ""),
    j.note && j.status !== "found" ? h("div", { class: `why${j.status === "needs_you" ? " blocked" : ""}` }, j.note) : ""
  );
  if (j.coverLetter) main.append(h("details", { class: "letter" }, h("summary", {}, "Cover letter"), h("pre", {}, j.coverLetter)));
  if (j.status === "needs_you" && j.needsYou) main.append(needsYouCard(j));
  if (j.answers?.length || j.shot) {
    const d = h("details", { class: "letter sent" }, h("summary", {}, `What was sent${j.answers?.length ? ` (${j.answers.length} fields)` : ""}${j.shot ? " + confirmation" : ""}`),
      j.answers?.length ? h("ul", {}, ...j.answers.map(a => h("li", {}, a))) : "");
    if (j.shot) d.addEventListener("toggle", async () => {
      if (!(d as HTMLDetailsElement).open || d.querySelector("img")) return;
      const url = (await chrome.storage.local.get(j.shot!))[j.shot!];
      if (typeof url === "string" && url.startsWith("data:image/")) d.append(h("img", { src: url, alt: `Confirmation page after applying to ${j.company}` }));
    });
    main.append(d);
  }
  const acts = h("div", { class: "acts" });
  const row = h("div", { class: "row" });
  const btn = (label: string, fn: () => Promise<void>, cls = "small") => { const b = h("button", { type: "button", class: cls }, label); b.onclick = () => fn().then(render); return b; };
  if (j.status === "found" && j.ok) row.append(btn("Add to batch", () => queueJobs([j.id])), btn("Skip", () => setJobStatus(j.id, "skipped")));
  if (j.status === "queued") row.append(btn("Remove from batch", async () => { await cancelApplication(chromeHost, j.id); await setJobStatus(j.id, "found"); }), btn("Skip", async () => { await cancelApplication(chromeHost, j.id); await setJobStatus(j.id, "skipped"); }));
  if (["found", "queued", "needs_you"].includes(j.status)) row.append(btn("Applied by hand", async () => { await cancelApplication(chromeHost, j.id); await setJobStatus(j.id, "applied", { needsYou: undefined }); }));
  if (j.status === "skipped" || (j.status === "found" && !j.ok)) row.append(btn(j.ok ? "Unskip" : "Keep anyway", () => updateLocal("jobs", (list = []) => list.map(x => x.id !== j.id ? x : { ...x, ok: true, why: x.ok ? x.why : ["You kept it"], blocked: undefined, status: "found", statusAt: Date.now() }))));
  if (["applied", "interview", "offer", "rejected"].includes(j.status)) {
    const sel = h("select", { "aria-label": "Status" }) as HTMLSelectElement;
    for (const s of ["applied", "interview", "offer", "rejected"] as JobStatus[]) sel.append(h("option", { value: s, ...(s === j.status && { selected: "" }) }, s));
    sel.onchange = () => setJobStatus(j.id, sel.value as JobStatus).then(render);
    row.append(sel);
  }
  row.append(h("a", { class: "act-link", href: j.applyUrl, target: "_blank", rel: "noopener noreferrer" }, "Open form ↗"));
  if (j.traceId) row.append(h("a", { class: "act-link", href: `runs.html#${encodeURIComponent(j.traceId)}`, target: "_blank" }, "Replay"));
  acts.append(row);
  const note = h("input", { type: "text", class: "note", placeholder: "Note" }) as HTMLInputElement;
  note.value = j.note || "";
  note.onchange = () => updateLocal("jobs", (list = []) => list.map(x => x.id !== j.id ? x : { ...x, note: note.value.trim() }));
  acts.append(note);
  li.append(main, acts);
  return li;
}

// The card: the literal question(s) the form asked, one input each (the form's own options as a
// list), then Save & resume: answers go to the answer bank and the job runs again now.
export function needsYouCard(j: Job): HTMLElement {
  const item = j.needsYou!;
  const box = h("div", { class: "needs", role: "group", "aria-label": `Needs you: ${j.company}` });
  const inputs: (HTMLInputElement | HTMLSelectElement | null)[] = [];
  item.questions.forEach((q, i) => {
    if (q.fieldType === "human" || q.fieldType === "file") {
      inputs.push(null);
      box.append(h("div", { class: "q" }, h("span", {}, q.question), h("span", { class: "hint" }, q.fieldType === "file" ? "Upload it on the form yourself (Open form ↗), then resume." : "Only you can do this (sign-in or a human check): open the form, do it, then resume.")));
      return;
    }
    const id = `ny-${j.id.replace(/[^a-z0-9]/gi, "")}-${i}`;
    let input: HTMLInputElement | HTMLSelectElement;
    if (q.fieldType === "select" && q.options?.length) {
      input = h("select", { id }) as HTMLSelectElement;
      input.append(h("option", { value: "" }, "Choose…"), ...q.options.map(o => h("option", { value: o }, o)));
    } else input = h("input", { id, type: "text", autocomplete: "off" }) as HTMLInputElement;
    inputs.push(input);
    box.append(h("label", { class: "q", for: id }, h("span", {}, q.question), input));
  });
  const status = h("span", { class: "hint", role: "status" });
  const go = h("button", { type: "button", class: "small primary" }, "Save & resume") as HTMLButtonElement;
  go.onclick = async () => {
    go.disabled = true;
    const answers: Record<number, string> = {};
    inputs.forEach((el, i) => { if (el) answers[i] = el.value; });
    const r = await resolveNeedsYou(j.id, answers);
    if (r.missing.length) { status.textContent = `Answer this first: ${r.missing[0]}`; go.disabled = false; return; }
    status.textContent = r.saved ? `Saved ${r.saved} answer${r.saved > 1 ? "s" : ""} for every later form. Applying again…` : "Applying again…";
    const windowId = (await chrome.windows?.getCurrent?.().catch(() => null))?.id;
    await chrome.storage.session.set({ jobBatch: { ts: Date.now(), windowId, only: [j.id] } });
  };
  box.append(h("div", { class: "row" }, go, status), h("span", { class: "hint" }, `Stopped ${when(item.since)}. Answers are saved to Memory, so other forms with the same question won't ask again.`));
  return box;
}

function renderCompany(c: Company): HTMLElement {
  const li = h("li", { class: "company" }, h("span", { class: "name" }, c.name), h("span", { class: "board" }, `${c.ats} · ${c.board}${c.eu ? " (EU)" : ""} · ${c.jobs ?? "?"} matching · scanned ${ago(c.lastScan)}`));
  if (c.lastError) li.append(h("span", { class: "err" }, c.lastError));
  const del = h("button", { type: "button", class: "small" }, "Remove");
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
    filtered: j => (!j.ok && j.status === "found") || j.status === "skipped" || j.status === "closed", companies: () => false, activity: () => false
  };
  return jobs.filter(byTab[tab]).filter(j => !region || j.regions.includes(region)).filter(j => !q || `${j.company} ${j.title} ${j.location}`.toLowerCase().includes(q))
    .sort((a, b) => tab === "applied" ? (b.appliedAt || 0) - (a.appliedAt || 0) : b.score - a.score || (b.postedAt || 0) - (a.postedAt || 0));
}

export async function render(): Promise<void> {
  [jobs, companies, actions] = await Promise.all([getJobs(), getCompanies(), readLog(200)]);
  const { lists } = await loadSponsors();
  const { usage = {}, capDaily, capMonthly } = await readLocal(["usage", "capDaily", "capMonthly"]);
  caps = { daily: capDaily ?? DEFAULT_CAPS.daily, monthly: capMonthly ?? DEFAULT_CAPS.monthly };
  const stats = jobStats(jobs);
  const spend = spendFor(usage);
  const lastScan = Math.max(0, ...companies.map(c => c.lastScan || 0));
  $("#sysline").replaceChildren(
    "Sponsor lists ", h("b", {}, lists ? `UK ${lists.ukDate || "?"} · US H-1B FY${lists.usYears || "?"}` : "not downloaded"),
    " · ", h("b", {}, String(companies.length)), ` compan${companies.length === 1 ? "y" : "ies"} · last scan `, h("b", {}, ago(lastScan)));
  $("#meters").replaceChildren(meterEl("API today", spend.today, caps.daily), meterEl("This month", spend.month, caps.monthly));
  const tile = (v: string | number, k: string, s = "", cls = "", of = "") => h("div", { class: `tile ${cls}` }, h("div", { class: "v" }, String(v), of ? h("small", {}, of) : ""), h("span", { class: "k" }, k), s ? h("span", { class: "s" }, s) : "");
  $("#hud").replaceChildren(
    tile(stats.eligible, "to apply", `${stats.companies} companies`), tile(stats.queued, "today's batch", stats.queued ? (unapprovedOf(jobs) ? "ready to approve" : "approved") : "press Build", "accent"),
    tile(stats.appliedToday, "applied today", `${stats.queued} in the batch`, "", ` / ${settings.dailyCap}`),
    tile(stats.applied, "applied", `${stats.rejected} rejected`), tile(stats.interviews, "interviews", `${stats.offers} offers`), tile(stats.needsYou, "need you", stats.needsYou ? "a question, sign-in or check" : "", stats.needsYou ? "alert" : "")
  );
  const { jobBatch } = await chrome.storage.session.get("jobBatch").catch(() => ({ jobBatch: undefined }));
  const batchActive = !!jobBatch || jobs.some(j => j.status === "applying");
  const unapproved = unapprovedOf(jobs);
  $("#approve").hidden = !unapproved || !!running || batchActive;
  $("#start").hidden = !stats.queued || !!running || batchActive;
  $("#stop").hidden = !running && !batchActive;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs [role=tab]")) {
    const t = b.dataset.tab as Tab;
    b.setAttribute("aria-selected", String(t === tab));
    const n = t === "companies" ? companies.length : t === "activity" ? actions.length : jobs.filter(j => ({ apply: j.ok && j.status === "found", batch: ["queued", "applying"].includes(j.status), applied: ["applied", "interview", "offer", "rejected"].includes(j.status), needs: j.status === "needs_you", filtered: (!j.ok && j.status === "found") || ["skipped", "closed"].includes(j.status) } as Record<string, boolean>)[t]).length;
    b.querySelector(".n")!.textContent = String(n);
  }
  const warn = $("#warning");
  const over = overCap(spend, caps);
  warn.hidden = !over;
  warn.textContent = over ? `${over.message} The batch won't start until then.` : "";
  const isCompanies = tab === "companies", isActivity = tab === "activity";
  $("#companiesBox").hidden = !isCompanies;
  $("#activity").hidden = !isActivity;
  $("#filters").hidden = isCompanies || isActivity;
  $("#list").hidden = isCompanies || isActivity;
  if (isCompanies) { $("#companies").replaceChildren(...companies.map(renderCompany)); $("#empty").hidden = true; return; }
  if (isActivity) {
    $("#activity").replaceChildren(...actions.map(e => h("li", { class: "company" }, h("span", { class: "board" }, `${when(e.at)} · ${e.worker ? `Agent ${e.worker} · ` : ""}${e.kind}`), h("span", { class: "name", style: "min-width:0;font-weight:500" }, e.what), e.why ? h("span", { class: "board" }, e.why) : "")));
    $("#empty").textContent = actions.length ? "" : "No actions yet. Every submit, upload and send lands here, with which agent did it and why.";
    $("#empty").hidden = !!actions.length;
    return;
  }
  const rows = visible();
  $("#list").replaceChildren(...rows.slice(0, 300).map(renderJob));
  const empty = { apply: lists ? "No eligible jobs yet. Press Scan job boards." : "Download the sponsor lists first (Update sponsor lists), then Scan job boards.", batch: "No batch yet. Press Build today's batch.", applied: "Nothing applied yet.", needs: "Nothing waiting for you.", filtered: "Nothing filtered out yet.", companies: "", activity: "" }[tab];
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
    const loadSettings = async () => {
      settings = { ...DEFAULT_JOB_SETTINGS, ...((await readLocal("jobSettings")).jobSettings || {}) };
      $("#dailyCap").value = String(settings.dailyCap);
      const { capDaily, capMonthly } = await readLocal(["capDaily", "capMonthly"]);
      $("#capDaily").value = String(capDaily ?? DEFAULT_CAPS.daily); $("#capMonthly").value = String(capMonthly ?? DEFAULT_CAPS.monthly);
      $("#internships").checked = !!settings.internships;
      $("#dailyBatch").checked = settings.dailyBatch !== false;
      $("#batchSize").value = String(settings.batchSize);
    };
    await loadSettings();
    const saveSettings = async () => {
      const internshipsWas = !!settings.internships;
      const mine = { dailyCap: Math.max(1, Math.min(50, Number($("#dailyCap").value) || DEFAULT_JOB_SETTINGS.dailyCap)), internships: !!$("#internships").checked, dailyBatch: !!$("#dailyBatch").checked, batchSize: Math.max(1, Math.min(30, Number($("#batchSize").value) || DEFAULT_JOB_SETTINGS.batchSize)) };
      $("#batchSize").value = String(mine.batchSize);
      $("#dailyCap").value = String(mine.dailyCap);
      // The spend caps are Settings fields (core/llm/budget.ts reads them before every model call).
      // An emptied field means "the default", never 0 (0 = no cap).
      const capOf = (v: string, dflt: number, max: number) => { const n = Number(v); return Math.max(0, Math.min(max, String(v).trim() !== "" && Number.isFinite(n) ? n : dflt)); };
      const capDaily = capOf($("#capDaily").value, DEFAULT_CAPS.daily, 50), capMonthly = capOf($("#capMonthly").value, DEFAULT_CAPS.monthly, 500);
      $("#capDaily").value = String(capDaily); $("#capMonthly").value = String(capMonthly);
      // Only this page's fields, merged under the lock: Settings → Jobs writes the same key.
      await updateLocal("jobSettings", cur => ({ ...DEFAULT_JOB_SETTINGS, ...(cur || {}), ...mine }));
      settings = { ...DEFAULT_JOB_SETTINGS, ...((await readLocal("jobSettings")).jobSettings || {}) };
      await chrome.storage.local.set({ capDaily, capMonthly });
      syncDailyAlarm(chromeHost).catch(() => {}); // sets or clears the 8 AM alarm
      if (internshipsWas !== settings.internships) {
        const n = await rejudgeJobs();
        $("#progress").textContent = settings.internships ? `Internships will be kept from the next scan on. Press Scan job boards.` : `Internships off: ${n} moved to Filtered out.`;
      }
      render();
    };
    $("#dailyCap").onchange = saveSettings;
    $("#capDaily").onchange = saveSettings;
    $("#capMonthly").onchange = saveSettings;
    $("#internships").onchange = saveSettings;
    $("#dailyBatch").onchange = saveSettings;
    $("#batchSize").onchange = saveSettings;
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
      const ids = pickBatch(list, room, Date.now(), settings.companyDays);
      await queueJobs(ids);
      return ids.length ? `${ids.length} jobs in today's batch. Look them over, then press Approve & spread over the day (or Start now).` : room ? `No eligible jobs left to add (one per company every ${settings.companyDays} days).` : `Today's limit of ${settings.dailyCap} is used up.`;
    });
    $("#start").onclick = async () => {
      const windowId = (await chrome.windows?.getCurrent?.().catch(() => null))?.id;
      if (windowId !== undefined) chrome.sidePanel.open({ windowId }).catch(() => {});
      await chrome.storage.session.remove("jobBatchStop");
      await chrome.storage.session.set({ jobBatch: { ts: Date.now(), windowId } });
      $("#progress").textContent = "Batch started: Sidekick opens its own Chrome window behind this one and applies there, one job at a time. Keep using this window; you'll be asked only when something needs you (Needs you tab).";
    };
    $("#approve").onclick = () => withProgress("Approving…", async () => {
      const plan = await approveSpread(chromeHost);
      if (!plan.length) return "Nothing to approve.";
      const fmt = (t: number) => new Date(t).toLocaleString("en-US", { timeZone: BATCH_TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
      return `Approved ${plan.length}: they run at random times from ${fmt(plan[0].at)} to ${fmt(plan[plan.length - 1].at)} ET (logged in Activity). Keep Chrome open with Sidekick's side panel open; nothing is asked unless something needs you.`;
    });
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
    chrome.storage.onChanged.addListener((changes, area) => { if ((area === "local" && (changes.jobs || changes.jobCompanies || changes.sponsorLists || changes.usage || changes.actionLog || changes.capDaily || changes.capMonthly)) || (area === "session" && changes.jobBatch)) render();
      // Settings → Jobs changed something: show it (unless he's typing in these controls).
      if (area === "local" && changes.jobSettings && !document.activeElement?.closest?.(".controls")) loadSettings().then(render);
    });
    await render();
  })();
}
