// Which jobs Ulugbek can legally take, and which to apply to first. Everything here is code (no
// model calls), so the whole list costs nothing to filter.
//
// The rules, for an F-1 student with a STEM degree and no EU passport:
// - United States: OPT lets him work for any employer at first; STEM OPT needs an E-Verify
//   employer and staying needs H-1B sponsorship, so only employers that have sponsored H-1Bs
//   (USCIS data) or say they sponsor are kept. Jobs that rule out sponsorship, require US
//   citizenship or a security clearance are dropped.
// - United Kingdom: the employer must hold a Skilled Worker sponsor licence (Home Office register).
// - Rest of Europe: a work permit the employer supports (EU Blue Card and national permits); kept
//   when the posting offers visa sponsorship or relocation, or the employer sponsors elsewhere.
// - United Arab Emirates: every employer arranges the work visa, so every job is open.
import type { Job, SponsorLevel, Region } from "./types.js";
import { sponsorshipFor, type Evidence, type SponsorData } from "./sponsorship.js";
export type { SponsorData } from "./sponsorship.js";
export { sentences } from "./sponsorship.js";

export interface Verdict {
  ok: boolean;
  regions: Region[];
  countries: string[];
  sponsor: SponsorLevel;
  why: string[]; // short reasons, shown in the dashboard
  evidence: Evidence[]; // each with its source and date (jobs/sponsorship.ts)
  blocked?: string; // why it can't be taken, when ok is false
  score: number; // higher first
}

// ---------- where a job is ----------
const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_RE = new RegExp(String.raw`\b(united states|u\.s\.a?\.?|usa|us|america|(?:us|u\.s\.)[- ]remote|remote[- ,(]*(?:us|usa|u\.s\.)|new york|nyc|san francisco|sf|bay area|silicon valley|seattle|chicago|boston|austin|los angeles|denver|atlanta|washington,? d\.?c\.?|palo alto|mountain view|menlo park|sunnyvale|san jose|san diego|cambridge, ma|pittsburgh|philadelphia|miami|dallas|houston|salt lake city|portland, or|raleigh|nashville|minneapolis|detroit|phoenix|columbus|baltimore|arlington, va|reston|mclean|jersey city|brooklyn|honolulu|south san francisco|redmond|bellevue|irvine|santa clara|princeton|new haven|ann arbor|madison, wi|boulder|st\.? louis|kansas city|charlotte|orlando|tampa|indianapolis|cincinnati|cleveland|las vegas|sacramento|oakland|berkeley|stamford|hoboken)\b|,\s*(?:${US_STATES})\b`, "i");
const UAE_RE = /\b(united arab emirates|u\.a\.e\.?|uae|dubai|abu dhabi|sharjah|ajman|ras al khaimah)\b/i;
// Country → names and big cities that identify it.
const EUROPE: Record<string, string> = {
  UK: "united kingdom|u\\.k\\.|uk|england|scotland|wales|northern ireland|great britain|london|manchester|edinburgh|glasgow|birmingham|bristol|leeds|cambridge(?!, ma)|oxford|belfast|reading|brighton|newcastle|liverpool|sheffield|nottingham",
  IE: "ireland|dublin|cork|galway|limerick",
  DE: "germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf|dusseldorf|leipzig|dresden|karlsruhe|heidelberg|nuremberg|nürnberg|bonn",
  NL: "netherlands|holland|amsterdam|rotterdam|the hague|den haag|utrecht|eindhoven|delft|leiden|groningen",
  FR: "france|paris|lyon|toulouse|nice|sophia antipolis|grenoble|bordeaux|lille|nantes|marseille",
  ES: "spain|españa|madrid|barcelona|valencia|seville|sevilla|malaga|málaga|bilbao",
  PT: "portugal|lisbon|lisboa|porto|braga",
  IT: "italy|italia|milan|milano|rome|roma|turin|torino|bologna|florence",
  CH: "switzerland|zurich|zürich|geneva|genève|basel|lausanne|bern|zug",
  AT: "austria|vienna|wien|graz|linz",
  BE: "belgium|brussels|bruxelles|antwerp|ghent|leuven",
  LU: "luxembourg",
  DK: "denmark|copenhagen|aarhus",
  SE: "sweden|stockholm|gothenburg|göteborg|malmö|malmo|lund",
  NO: "norway|oslo|bergen|trondheim",
  FI: "finland|helsinki|espoo|tampere|oulu",
  IS: "iceland|reykjavik",
  PL: "poland|warsaw|warszawa|krakow|kraków|wroclaw|wrocław|gdansk|gdańsk|poznan|poznań|lodz|łódź|katowice",
  CZ: "czech|czechia|prague|praha|brno",
  SK: "slovakia|bratislava",
  HU: "hungary|budapest",
  RO: "romania|bucharest|bucurești|cluj|iasi|iași|timisoara",
  BG: "bulgaria|sofia|plovdiv",
  GR: "greece|athens|thessaloniki",
  HR: "croatia|zagreb|split",
  SI: "slovenia|ljubljana",
  RS: "serbia|belgrade|novi sad",
  EE: "estonia|tallinn|tartu",
  LV: "latvia|riga",
  LT: "lithuania|vilnius|kaunas",
  CY: "cyprus|limassol|nicosia",
  MT: "malta|valletta",
  UA: "ukraine|kyiv|kiev|lviv"
};
const EU_RES = Object.entries(EUROPE).map(([c, names]) => [c, new RegExp(String.raw`(^|[^\p{L}])(${names})(?=$|[^\p{L}])`, "iu")] as const);
const EUROPE_WORD = /\b(europe|emea|eu remote|remote[- ,(]*(eu|europe))\b/i;
// Strings that name a city in another country with the same name as one above.
// "Toronto, CA" is Canada, not California.
const CANADA_CA = /\b(toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo|edmonton|kitchener|mississauga|quebec|québec|winnipeg|halifax|victoria),?\s*(ca|canada|on|bc|qc|ab)\b/gi;
const CANADA_RE = /\b(canada|toronto|vancouver|montreal|montréal|ottawa|calgary|waterloo|edmonton|kitchener|mississauga|winnipeg|halifax|québec|quebec city)\b/i;
const NOT_THERE = /\b(london,? (ontario|on)\b|paris,? (tx|texas)|dublin,? (ca|oh|ohio|california)|cambridge,? (ma|massachusetts)|birmingham,? (al|alabama)|manchester,? (nh|new hampshire)|athens,? (ga|georgia))\b/i;

export function whereIs(location: string): { regions: Region[]; countries: string[] } {
  const loc = String(location || "").replace(/\s+/g, " ").trim();
  const countries = new Set<string>();
  const clean = loc.replace(CANADA_CA, "Canada").replace(NOT_THERE, m => (/,\s*(ca|oh|ohio|california|ma|massachusetts|tx|texas|al|alabama|nh|new hampshire|ga|georgia)\b/i.test(m) ? "United States" : "Canada"));
  if (US_RE.test(clean)) countries.add("US");
  if (UAE_RE.test(clean)) countries.add("AE");
  if (CANADA_RE.test(clean)) countries.add("CA");
  for (const [c, re] of EU_RES) if (re.test(clean)) countries.add(c);
  const regions = new Set<Region>();
  for (const c of countries) regions.add(c === "US" ? "usa" : c === "AE" ? "uae" : c === "CA" ? "canada" : "europe");
  if (!countries.size && EUROPE_WORD.test(clean)) regions.add("europe");
  return { regions: [...regions], countries: [...countries] };
}

const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|vice president|architect|distinguished|fellow|iii|iv|level [3-9]|l[5-9])\b/i;
const NOT_FOR_YOU = /\b(ph\.?d\.?|doctoral|master'?s|mba|high school)\b/i;
const EXPERIENCE = /\b([4-9]|1\d)\+? (or more )?years?\b[^.]{0,40}\b(experience|of professional|in industry|of industry)/i;
// Internships, co-ops and working-student roles: not jobs. Off by default (he graduates May 2027).
export const INTERN_RE = /\b(intern|interns|internship|internships|co-?op|summer analyst|working student|werkstudent|stagiaire|praktikum|praktikant|apprentice|apprenticeship)\b/i;
const ENTRY = /\b(intern|internship|new grad|new graduate|graduate|entry[- ]level|junior|jr\.?|early career|university|campus|associate|apprentice|i\b|level 1|l1|2026|2027)\b/i;
export const DEFAULT_ROLES = ["software engineer", "software developer", "software engineering", "backend", "back-end", "frontend", "front-end", "full stack", "full-stack", "fullstack", "mobile engineer", "ios engineer", "android engineer", "react native", "web developer", "data engineer", "machine learning engineer", "ml engineer", "ai engineer", "platform engineer", "infrastructure engineer", "forward deployed engineer", "solutions engineer", "product engineer", "swe"];


// roles: what to look for in titles (the profile's target roles, or DEFAULT_ROLES).
// regions: the places he chose in Settings → Jobs (all four when unset).
export interface JudgeOptions { internships?: boolean; regions?: Region[] }
const PLACE: Record<Region, string> = { usa: "the US", canada: "Canada", europe: "Europe", uae: "the UAE" };
export function judgeJob(job: Pick<Job, "title" | "company" | "location" | "text" | "postedAt">, sponsors: SponsorData, roles: string[] = DEFAULT_ROLES, now = Date.now(), opts: JudgeOptions = {}): Verdict {
  const { regions, countries } = whereIs(job.location);
  const no = (blocked: string, sponsor: SponsorLevel = "no"): Verdict => ({ ok: false, regions, countries, sponsor, why: [], evidence: [], blocked, score: 0 });
  const title = String(job.title || "");
  const text = `${title}\n${job.text || ""}`;
  if (!regions.length) return no(job.location ? `Not in the US, Canada, Europe or the UAE (${job.location})` : "No location given");
  if (opts.regions?.length && !regions.some(r => opts.regions!.includes(r))) return no(`In ${regions.map(r => PLACE[r]).join(" and ")}, which you turned off (Settings → Jobs)`);
  const roleHit = roles.some(r => title.toLowerCase().includes(r.toLowerCase()));
  if (!roleHit) return no("Not one of your target roles");
  if (NOT_FOR_YOU.test(title)) return no(`For ${title.match(NOT_FOR_YOU)![0]} students`);
  if (!opts.internships && INTERN_RE.test(title)) return no("Internship, not a job");
  if (SENIOR.test(title) && !/\b(intern|new grad|graduate|junior|entry)\b/i.test(title)) return no("Senior role");
  if (EXPERIENCE.test(job.text || "") && !ENTRY.test(title)) return no(`Asks for ${(job.text || "").match(EXPERIENCE)![1]}+ years of experience`);

  // Sponsorship with evidence (jobs/sponsorship.ts); only confirmed and likely are kept.
  const s = sponsorshipFor(job.company, text, countries.length ? countries : regions.includes("europe") ? ["EU"] : [], sponsors);
  if (s.blocked) return no(s.blocked);
  const why = s.evidence.map(e => e.text).concat(s.stale ? [s.stale] : []);
  const best = s.confidence;
  if (best !== "confirmed" && best !== "likely") return { ok: false, regions, countries, sponsor: "unknown", why: why.length ? why : ["No sign they sponsor visas"], evidence: s.evidence, blocked: "No sign they sponsor visas", score: 0 };

  // Order: sponsorship first, then how entry-level the role is, then how fresh the posting is.
  let score = best === "confirmed" ? 50 : 35;
  if (/\b(new grad|new graduate|graduate|entry[- ]level|junior|early career|university|campus)\b/i.test(title)) score += 25;
  else if (/\bintern(ship)?\b/i.test(title)) score += 20;
  else if (!/\bii\b/i.test(title)) score += 12;
  const days = job.postedAt ? (now - job.postedAt) / 864e5 : 60;
  score += days <= 7 ? 15 : days <= 30 ? 10 : days <= 60 ? 5 : 0;
  if (regions.includes("usa")) score += 5; // STEM OPT: up to 3 years of work without a new visa
  return { ok: true, regions, countries, sponsor: best, why, evidence: s.evidence, score };
}
