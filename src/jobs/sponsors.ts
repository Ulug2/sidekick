// Who sponsors work visas, from the governments' own public lists:
// - UK: the Home Office "Register of licensed sponsors: workers" (Skilled Worker route), updated
//   most working days; its current CSV is found through GOV.UK's content API.
// - US: USCIS H-1B Employer Data Hub (approvals per employer per fiscal year). The newest yearly
//   file USCIS still publishes is FY2023.
// Both are downloaded on the Jobs page when you press "Update sponsor lists" (about 13 MB), turned
// into a list of names, and kept in chrome.storage.local.
import { LCA_STALE_DAYS, type SponsorData } from "./sponsorship.js";
import { webFetchOpts } from "../core/web/web.js";

export const UK_REGISTER_API = "https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers";
export const H1B_FILES = ["https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2023.csv", "https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2022.csv"];
export interface SponsorLists {
  uk: string[]; us: Record<string, number>; ukDate?: string; usYears?: string; updated: number;
  // Phase 4 (optional until loaded): DOL LCA certifications per employer (public/data/lca.json, built
  // by scripts/sponsors/build-lca.mjs), the Dutch IND register, Canadian positive-LMIA employers.
  lca?: Record<string, number>; lcaYears?: string; lcaBuilt?: number;
  nl?: string[]; nlDate?: string;
  ca?: Record<string, number>; caDate?: string;
}

// "STRIPE, INC." → "stripe"; "Amazon.com Services LLC" → "amazon com services".
const SUFFIX = /\b(incorporated|inc|llc|l l c|llp|lp|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|bv|b v|nv|sa|s a|sas|sarl|srl|spa|ab|as|oy|aps|pty|pte|holdings?|group|the|dba|uk|usa|us|pbc|opco)\b/g;
export function normCompany(name: string): string {
  return String(name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
}
// Words a registered name may add after the company's own name and still be the same employer
// ("Amazon Com Services", "Stripe Payments", "Datadog North America").
const SAME_EMPLOYER = /^(business|bank|brands|networks|interactive|media|studios|cloud|data|platforms?|enterprises|markets|securities|trading|capital|com|services?|technologies|technology|tech|labs?|software|systems|digital|solutions|global|international|north america|america|americas|payments|financial|health|ai|io|hq|operations|europe|emea|uk|london|ireland|deutschland|germany|netherlands|france)( |$)/;

export function sponsorLookup(lists: SponsorLists | null | undefined, now = Date.now()): SponsorData {
  // First word → registered names, to find "amazon com services" from "Amazon".
  const index = (names: Iterable<string>) => {
    const first = new Map<string, string[]>();
    for (const n of names) { const f = n.split(" ")[0]; if (f.length >= 3) (first.get(f) || first.set(f, []).get(f)!).push(n); }
    return (company: string) => {
      const key = normCompany(company);
      return key.length < 3 ? [] : (first.get(key.split(" ")[0]) || []).filter(n => n === key || (n.startsWith(key + " ") && SAME_EMPLOYER.test(n.slice(key.length + 1))));
    };
  };
  const counts = (m: Record<string, number> | undefined) => { const find = index(Object.keys(m || {})); return (c: string) => find(c).reduce((a, n) => a + (m![n] || 0), 0); };
  const member = (list: string[] | undefined) => { const set = new Set(list || []); const find = index(set); return (c: string) => set.has(normCompany(c)) || find(c).length > 0; };
  return {
    h1b: counts(lists?.us),
    ukSponsor: member(lists?.uk),
    ...(lists?.lca && { lca: counts(lists.lca) }),
    ...(lists?.nl && { nlSponsor: member(lists.nl) }),
    ...(lists?.ca && { caLmia: counts(lists.ca) }),
    dates: { h1b: lists?.usYears?.split(",")[0]?.trim(), uk: lists?.ukDate, lca: lists?.lcaYears, ind: lists?.nlDate, lmia: lists?.caDate },
    lcaStale: !!lists?.lca && (!lists.lcaBuilt || now - lists.lcaBuilt > LCA_STALE_DAYS * 864e5)
  };
}

// A CSV file → rows of fields (quotes and commas inside quotes handled).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function ukNamesFromCsv(text: string): string[] {
  const [head, ...rows] = parseCsv(text);
  const name = head.findIndex(h => /organisation name/i.test(h)), route = head.findIndex(h => /^route$/i.test(h.trim()));
  if (name < 0 || route < 0) throw new Error("The UK sponsor register's columns changed (no Organisation Name / Route).");
  return [...new Set(rows.filter(r => /skilled worker/i.test(r[route] || "")).map(r => normCompany(r[name])).filter(Boolean))];
}
export function h1bCountsFromCsv(text: string, into: Record<string, number> = {}): Record<string, number> {
  const [head, ...rows] = parseCsv(text);
  const col = (re: RegExp) => head.findIndex(h => re.test(h));
  const emp = col(/^employer$/i), ia = col(/initial approval/i), ca = col(/continuing approval/i);
  if (emp < 0 || ia < 0) throw new Error("The USCIS H-1B file's columns changed (no Employer / Initial Approval).");
  for (const r of rows) {
    const n = normCompany(r[emp]);
    if (!n) continue;
    const k = (Number(r[ia]) || 0) + (ca >= 0 ? Number(r[ca]) || 0 : 0);
    if (k > 0) into[n] = (into[n] || 0) + k;
  }
  return into;
}

// Downloads both lists (Stop and a time limit apply to every request).
export async function downloadSponsorLists(onStatus: (s: string) => void = () => {}, signal?: AbortSignal): Promise<SponsorLists> {
  onStatus("Finding the latest UK sponsor register…");
  const meta = await (await fetch(UK_REGISTER_API, webFetchOpts(signal, 20000))).json();
  const att = (meta?.details?.attachments || []).find((a: any) => /\.csv$/i.test(a.url || "") && /worker/i.test(`${a.title} ${a.url}`));
  if (!att) throw new Error("GOV.UK didn't list the sponsor register's CSV file.");
  onStatus("Downloading the UK sponsor register (about 11 MB)…");
  const uk = ukNamesFromCsv(await (await fetch(att.url, webFetchOpts(signal, 90000))).text());
  const us: Record<string, number> = {};
  const years: string[] = [];
  for (const url of H1B_FILES) {
    onStatus(`Downloading USCIS H-1B data (${url.match(/(\d{4})\.csv$/)![1]})…`);
    const res = await fetch(url, webFetchOpts(signal, 90000));
    if (!res.ok) continue;
    h1bCountsFromCsv(await res.text(), us);
    years.push(url.match(/(\d{4})\.csv$/)![1]);
  }
  if (!years.length) throw new Error("USCIS's H-1B files couldn't be downloaded.");
  return { uk, us, ukDate: String(meta.public_updated_at || "").slice(0, 10), usYears: years.join(", "), updated: Date.now() };
}
