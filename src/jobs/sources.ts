// Reading company job boards through their public APIs: Greenhouse, Lever, Ashby, Workable and
// SmartRecruiters publish every open posting as JSON for anyone, with no login, which is how
// their own career pages load them. One request per company per scan, a few at a time.
// (Endpoints as listed by career-ops, MIT, github.com/career-ops-hq/career-ops, checked 2026-11-08.)
import type { Ats, Company, Job } from "./types.js";
import { webFetchOpts } from "../core/web/web.js";

export type Posting = Pick<Job, "id" | "ats" | "board" | "company" | "title" | "location" | "url" | "applyUrl" | "postedAt" | "text">;
export const TEXT_MAX = 6000; // enough for the checks and a cover letter; keeps storage small

const enc = encodeURIComponent;
export function boardApi(c: Pick<Company, "ats" | "board" | "eu">): string {
  switch (c.ats) {
    case "greenhouse": return `https://boards-api.greenhouse.io/v1/boards/${enc(c.board)}/jobs?content=true`;
    case "lever": return `https://api.${c.eu ? "eu." : ""}lever.co/v0/postings/${enc(c.board)}?mode=json`;
    case "ashby": return `https://api.ashbyhq.com/posting-api/job-board/${enc(c.board)}`;
    case "workable": return `https://apply.workable.com/api/v1/widget/accounts/${enc(c.board)}?details=true`;
    case "smartrecruiters": return `https://api.smartrecruiters.com/v1/companies/${enc(c.board)}/postings?limit=100`;
  }
}

// HTML (Greenhouse sends it escaped once more) → plain text.
export function htmlText(html: string): string {
  let s = String(html || "");
  if (/&lt;\/?[a-z]/i.test(s)) s = new DOMParser().parseFromString(s, "text/html").documentElement.textContent || "";
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/?(br|p|li|h\d|div|tr|section|ul|ol)\b[^>]*>/gi, "\n");
  const t = new DOMParser().parseFromString(s, "text/html").body?.textContent || "";
  return t.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
const time = (v: unknown) => { const t = typeof v === "number" ? v : Date.parse(String(v || "")); return Number.isFinite(t) && t > 0 ? t : undefined; };
const short = (s: string) => s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + "…" : s;

export function parseBoard(c: Pick<Company, "ats" | "board" | "name">, data: any): Posting[] {
  const base = (id: string) => ({ id: `${c.ats}:${c.board}:${id}`, ats: c.ats as Ats, board: c.board });
  switch (c.ats) {
    case "greenhouse":
      return (data?.jobs || []).map((j: any) => {
        const own = /greenhouse\.io/.test(j.absolute_url || "") ? j.absolute_url : `https://job-boards.greenhouse.io/${c.board}/jobs/${j.id}`;
        return { ...base(String(j.id)), company: j.company_name || c.name, title: String(j.title || "").trim(), location: j.location?.name || "", url: j.absolute_url || own, applyUrl: own, postedAt: time(j.first_published || j.updated_at), text: short(htmlText(j.content || "")) };
      });
    case "lever":
      return (Array.isArray(data) ? data : []).map((j: any) => ({
        ...base(String(j.id)), company: c.name, title: String(j.text || "").trim(),
        location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i).join("; "),
        url: j.hostedUrl, applyUrl: j.applyUrl || `${j.hostedUrl}/apply`, postedAt: time(j.createdAt),
        text: short([j.descriptionPlain, ...(j.lists || []).map((l: any) => `${l.text}\n${htmlText(l.content || "")}`), j.additionalPlain].filter(Boolean).join("\n\n"))
      }));
    case "ashby":
      return (data?.jobs || []).filter((j: any) => j.isListed !== false).map((j: any) => ({
        ...base(String(j.id)), company: c.name, title: String(j.title || "").trim(),
        location: [j.location, ...(j.secondaryLocations || []).map((s: any) => s.location)].filter(Boolean).join("; "),
        url: j.jobUrl, applyUrl: j.applyUrl || j.jobUrl, postedAt: time(j.publishedAt), text: short(String(j.descriptionPlain || htmlText(j.descriptionHtml || "")))
      }));
    case "workable":
      return (data?.jobs || []).map((j: any) => ({
        ...base(String(j.shortcode)), company: data.name || c.name, title: String(j.title || "").trim(),
        location: (j.locations?.length ? j.locations : [j]).map((l: any) => [l.city, l.country].filter(Boolean).join(", ")).join("; ") + (j.telecommuting ? " (remote)" : ""),
        url: j.url, applyUrl: j.application_url || j.url, postedAt: time(j.published_on || j.created_at), text: short(htmlText(j.description || ""))
      }));
    case "smartrecruiters":
      return (data?.content || []).map((j: any) => ({
        ...base(String(j.id)), company: j.company?.name || c.name, title: String(j.name || "").trim(),
        location: j.location?.fullLocation || [j.location?.city, j.location?.country].filter(Boolean).join(", "),
        url: `https://jobs.smartrecruiters.com/${c.board}/${j.id}`, applyUrl: `https://jobs.smartrecruiters.com/${c.board}/${j.id}`, postedAt: time(j.releasedDate), text: ""
      }));
  }
}

export async function fetchBoard(c: Company, signal?: AbortSignal): Promise<Posting[]> {
  const res = await fetch(boardApi(c), { ...webFetchOpts(signal, 25000), credentials: "omit" });
  if (res.status === 404) throw new Error(`${c.name} has no ${c.ats} board called “${c.board}”`);
  if (!res.ok) throw new Error(`${c.ats} answered ${res.status} for ${c.name}`);
  return parseBoard(c, await res.json());
}

// Runs fn over items, `limit` at a time (polite to the job boards).
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// A company's name → the slugs its board most likely has ("Scale AI, Inc." → scaleai, scale-ai,
// scale; "Jane Street Capital LLC" → janestreetcapital, janestreet, jane-street, jane).
export function slugGuesses(name: string): string[] {
  const clean = String(name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ")
    .replace(/\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|bv|b\.v|sa|s\.a|sas|srl|the|dba)\b\.?/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const core = clean.filter(w => !/^(holdings?|group|technologies|technology|labs?|capital|partners|ventures|systems|software)$/.test(w));
  const words = core.length ? core : clean;
  if (!words.length) return [];
  return [...new Set([clean.join(""), words.join(""), words.join("-"), words[0]].filter(s => s.length >= 2))];
}
