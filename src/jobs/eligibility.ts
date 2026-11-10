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

export interface SponsorData {
  h1b: (company: string) => number; // H-1B approvals found for this employer (0 = none found)
  ukSponsor: (company: string) => boolean; // on the UK Skilled Worker register
}
export interface Verdict {
  ok: boolean;
  regions: Region[];
  countries: string[];
  sponsor: SponsorLevel;
  why: string[]; // short reasons, shown in the dashboard
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
const NOT_THERE = /\b(london,? (ontario|on)\b|paris,? (tx|texas)|dublin,? (ca|oh|ohio|california)|cambridge,? (ma|massachusetts)|birmingham,? (al|alabama)|manchester,? (nh|new hampshire)|athens,? (ga|georgia))\b/i;

export function whereIs(location: string): { regions: Region[]; countries: string[] } {
  const loc = String(location || "").replace(/\s+/g, " ").trim();
  const countries = new Set<string>();
  const clean = loc.replace(CANADA_CA, "Canada").replace(NOT_THERE, m => (/,\s*(ca|oh|ohio|california|ma|massachusetts|tx|texas|al|alabama|nh|new hampshire|ga|georgia)\b/i.test(m) ? "United States" : "Canada"));
  if (US_RE.test(clean)) countries.add("US");
  if (UAE_RE.test(clean)) countries.add("AE");
  for (const [c, re] of EU_RES) if (re.test(clean)) countries.add(c);
  const regions = new Set<Region>();
  for (const c of countries) regions.add(c === "US" ? "usa" : c === "AE" ? "uae" : "europe");
  if (!countries.size && EUROPE_WORD.test(clean)) regions.add("europe");
  return { regions: [...regions], countries: [...countries] };
}

// ---------- what the posting says ----------
// "Executive sponsor", "sponsorship deals" and the like don't count: only visa wording does.
const NO_SPONSOR = [
  /\b(unable|not able|cannot|can ?not|can't|do not|don't|does not|doesn't|will not|won't|are not able|is not able|not in a position|no longer)\b[^.]{0,40}\b(sponsor|sponsorship)\b[^.]{0,40}\b(visa|work|employment|immigration|h-?1b|authori[sz]ation|candidates|applicants|this (role|position))/i,
  /\b(visa|immigration|employment|work)[- ]?(visa )?sponsorship\b[^.]{0,30}\b(is )?(not|un)(available| be provided| offered|able)/i,
  /\bwithout (the need for |requiring |needing )?(current or future |now or in the future |any )?(employer |visa |immigration |employment )?sponsorship\b/i,
  /\bno (visa|immigration|employment|work[- ]?visa|h-?1b) sponsorship\b/i,
  /\bsponsorship (is )?not (available|provided|offered)\b/i
];
const CITIZENS_ONLY = [
  /\b(must be|be) (a )?(u\.?s\.?|united states) citizens?\b/i,
  /\bu\.?s\.? citizenship (is )?(required|needed|mandatory)\b/i,
  /\b(only )?(u\.?s\.? citizens|green card holders)( (and|or) (green card holders|permanent residents|u\.?s\.? citizens))?( only| are eligible)\b/i,
  /\b(active|current|ability to obtain|eligible for|obtain and maintain) (a |an )?(u\.?s\.? )?(government |dod |secret |top secret |ts\/sci |security )+clearance\b/i,
  /\b(itar|export control)[^.]{0,80}\b(u\.?s\.? person|citizen|permanent resident)/i,
  /\b(require[sd]?|must be|only|eligib\w+|restricted to|limited to|open to)\b[^.]{0,60}\bu\.?s\.? persons?\b/i,
  /\bu\.?s\.? persons?\b[^.]{0,40}\b(only|required|status|as defined)\b/i,
  /\bmust (already )?have (the )?(full |existing )?right to work in the (uk|united kingdom|eu|european union)\b/i
];
const SPONSORS = [
  /\b(we|will|can|able to|happy to|do|does)\b[^.]{0,30}\bsponsor\b[^.]{0,30}\b(visa|visas|work permit|h-?1b|immigration|relocation)/i,
  /\b(visa|immigration|work permit|h-?1b|blue card|skilled worker)[- ]?(sponsorship|support)\b[^.]{0,30}\b(is |are )?(available|provided|offered|possible)\b/i,
  /\b(offer|offers|provide|provides|including|includes|with|plus)\b[^.]{0,30}\b(visa|immigration|work permit|blue card) (sponsorship|support|assistance)\b/i,
  /\brelocation (package|support|assistance|bonus)\b/i,
  /\b(sponsorship|visa support) for (international|non-eu|non-uk) (candidates|applicants|hires)\b/i
];
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|vice president|architect|distinguished|fellow|iii|iv|level [3-9]|l[5-9])\b/i;
const NOT_FOR_YOU = /\b(ph\.?d\.?|doctoral|master'?s|mba|high school)\b/i;
const EXPERIENCE = /\b([4-9]|1\d)\+? (or more )?years?\b[^.]{0,40}\b(experience|of professional|in industry|of industry)/i;
// Internships, co-ops and working-student roles: not jobs. Off by default (he graduates May 2027).
export const INTERN_RE = /\b(intern|interns|internship|internships|co-?op|summer analyst|working student|werkstudent|stagiaire|praktikum|praktikant|apprentice|apprenticeship)\b/i;
const ENTRY = /\b(intern|internship|new grad|new graduate|graduate|entry[- ]level|junior|jr\.?|early career|university|campus|associate|apprentice|i\b|level 1|l1|2026|2027)\b/i;
export const DEFAULT_ROLES = ["software engineer", "software developer", "software engineering", "backend", "back-end", "frontend", "front-end", "full stack", "full-stack", "fullstack", "mobile engineer", "ios engineer", "android engineer", "react native", "web developer", "data engineer", "machine learning engineer", "ml engineer", "ai engineer", "platform engineer", "infrastructure engineer", "forward deployed engineer", "solutions engineer", "product engineer", "swe"];

export const sentences = (text: string, re: RegExp[]) => re.map(r => String(text || "").match(r)?.[0]).filter(Boolean) as string[];

// roles: what to look for in titles (the profile's target roles, or DEFAULT_ROLES).
export interface JudgeOptions { internships?: boolean }
export function judgeJob(job: Pick<Job, "title" | "company" | "location" | "text" | "postedAt">, sponsors: SponsorData, roles: string[] = DEFAULT_ROLES, now = Date.now(), opts: JudgeOptions = {}): Verdict {
  const { regions, countries } = whereIs(job.location);
  const why: string[] = [];
  const no = (blocked: string): Verdict => ({ ok: false, regions, countries, sponsor: "no", why, blocked, score: 0 });
  const title = String(job.title || "");
  const text = `${title}\n${job.text || ""}`;
  if (!regions.length) return no(job.location ? `Not in the US, Europe or the UAE (${job.location})` : "No location given");
  const roleHit = roles.some(r => title.toLowerCase().includes(r.toLowerCase()));
  if (!roleHit) return no("Not one of your target roles");
  if (NOT_FOR_YOU.test(title)) return no(`For ${title.match(NOT_FOR_YOU)![0]} students`);
  if (!opts.internships && INTERN_RE.test(title)) return no("Internship, not a job");
  if (SENIOR.test(title) && !/\b(intern|new grad|graduate|junior|entry)\b/i.test(title)) return no("Senior role");
  if (EXPERIENCE.test(job.text || "") && !ENTRY.test(title)) return no(`Asks for ${(job.text || "").match(EXPERIENCE)![1]}+ years of experience`);
  const citizen = sentences(text, CITIZENS_ONLY)[0];
  if (citizen) return no(`Says: “${citizen.trim()}”`);
  const refuses = sentences(text, NO_SPONSOR)[0];
  const offers = sentences(text, SPONSORS)[0];

  // Sponsorship, region by region; the job is kept if any of its countries works.
  let best = "unknown" as SponsorLevel;
  const rank: Record<SponsorLevel, number> = { no: 0, unknown: 1, possible: 2, likely: 3, strong: 4 };
  const consider = (lvl: SponsorLevel, reason: string) => { if (rank[lvl] > rank[best]) best = lvl; if (!why.includes(reason)) why.push(reason); };
  const h1b = sponsors.h1b(job.company);
  const uk = sponsors.ukSponsor(job.company);
  for (const c of countries.length ? countries : ["EU"]) {
    if (c === "AE") consider("strong", "UAE: the employer arranges the work visa");
    else if (c === "US") {
      if (refuses) continue;
      if (offers) consider("strong", "Posting offers visa sponsorship");
      if (h1b >= 5) consider("strong", `Sponsored ${h1b} H-1B visas (USCIS data)`);
      else if (h1b > 0) consider("likely", `Sponsored ${h1b} H-1B visa${h1b > 1 ? "s" : ""} (USCIS data)`);
    } else if (c === "UK") {
      if (refuses) continue;
      if (uk) consider("strong", "Licensed UK Skilled Worker sponsor (Home Office register)");
      else if (offers) consider("likely", "Posting offers visa sponsorship");
    } else {
      if (refuses) continue;
      if (offers) consider("likely", "Posting offers visa sponsorship or relocation");
      else if (h1b >= 5 || uk) consider("possible", "Sponsors visas in other countries; Europe needs a work permit they'd support");
    }
  }
  if (refuses && best === "unknown") return no(`Says: “${refuses.trim()}”`);
  if (best === "unknown") return { ok: false, regions, countries, sponsor: "unknown", why: ["No sign they sponsor visas"], blocked: "No sign they sponsor visas", score: 0 };

  // Order: sponsorship first, then how entry-level the role is, then how fresh the posting is.
  let score = { strong: 50, likely: 35, possible: 20, unknown: 0, no: 0 }[best];
  if (/\b(new grad|new graduate|graduate|entry[- ]level|junior|early career|university|campus)\b/i.test(title)) score += 25;
  else if (/\bintern(ship)?\b/i.test(title)) score += 20;
  else if (!/\bii\b/i.test(title)) score += 12;
  const days = job.postedAt ? (now - job.postedAt) / 864e5 : 60;
  score += days <= 7 ? 15 : days <= 30 ? 10 : days <= 60 ? 5 : 0;
  if (regions.includes("usa")) score += 5; // STEM OPT: up to 3 years of work without a new visa
  return { ok: true, regions, countries, sponsor: best, why, score };
}
