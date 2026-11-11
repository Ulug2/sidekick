#!/usr/bin/env node
// Builds public/data/lca.json from the U.S. Department of Labor's LCA disclosure files
// (https://www.dol.gov/agencies/eta/foreign-labor/performance → "LCA Programs (H-1B, H-1B1, E-3)").
// DOL publishes them as .xlsx: open each quarter's file and export it as CSV (Numbers, Excel or
// `npx xlsx-cli`), then:
//   node scripts/sponsors/build-lca.mjs FY2025 ~/Downloads/LCA_Disclosure_Data_FY2025_Q*.csv
// Counts certified H-1B LCAs per employer name. Names are normalized in the extension (the same
// normCompany as the other lists). Refresh monthly; the Jobs page marks it stale after 120 days.
import { createReadStream, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [fy, ...files] = process.argv.slice(2);
if (!/^FY\d{4}/.test(fy || "") || !files.length) {
  console.error("Usage: node scripts/sponsors/build-lca.mjs FY2025 file1.csv [file2.csv …]");
  process.exit(1);
}
// One CSV line → fields (quotes and commas inside quotes; LCA rows don't span lines in exports).
function fields(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c;
  }
  out.push(f);
  return out;
}
const counts = {};
let rows = 0;
for (const file of files) {
  let head = null, status = -1, visa = -1, name = -1;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    const r = fields(line);
    if (!head) {
      head = r.map(h => h.trim().toUpperCase());
      status = head.indexOf("CASE_STATUS"); visa = head.indexOf("VISA_CLASS"); name = head.indexOf("EMPLOYER_NAME");
      if (status < 0 || name < 0) { console.error(`${file}: no CASE_STATUS / EMPLOYER_NAME column`); process.exit(1); }
      continue;
    }
    rows++;
    if (!/^certified$/i.test((r[status] || "").trim())) continue; // not "Certified - Withdrawn"
    if (visa >= 0 && !/^h-?1b$/i.test((r[visa] || "").trim())) continue;
    const n = (r[name] || "").trim().toUpperCase();
    if (n) counts[n] = (counts[n] || 0) + 1;
  }
}
const out = join(dirname(fileURLToPath(import.meta.url)), "../../public/data/lca.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ fy: fy.slice(2), built: Date.now(), source: "DOL OFLC LCA disclosure data", counts }));
console.log(`${rows} rows, ${Object.keys(counts).length} employers with certified H-1B LCAs → ${out}`);
