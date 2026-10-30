// Builds the bundles the jsdom suites load (tests/helpers.js loadScripts): the same modules as the
// extension, as classic scripts, with every export reachable from the test. Function declarations
// also land on window, as they did when each file was a classic <script>.
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, ".test-build");
const SRC = path.join(ROOT, "src");
const src = file => path.join(SRC, file);
const PAGES = ["sidepanel", "profile", "options", "evals", "mic"];
// Every module except the pages' own UI code, the service worker and the content script.
const LIB = fs.readdirSync(SRC, { recursive: true }).filter(f => /\.(js|ts)$/.test(f) && !f.endsWith(".d.ts") && !/^(ui|background|content|types)\//.test(f)).sort();
// A page bundle: the library plus every module in the page's folder (its entry file last).
const pageFiles = p => {
  const dir = fs.readdirSync(src(`ui/${p}`)).filter(f => f.endsWith(".ts")).map(f => `ui/${p}/${f}`);
  return [...dir.filter(f => f !== `ui/${p}/${p}.ts`), `ui/${p}/${p}.ts`];
};
const BUNDLES = { lib: LIB, ...Object.fromEntries(PAGES.map(p => [p, [...(p === "mic" ? [] : LIB), ...pageFiles(p)]])) };
const ENTRIES = path.join(ROOT, "node_modules", ".sk-test-entries");
const fnNames = file => [...fs.readFileSync(src(file), "utf8").matchAll(/^export (?:async )?function\*? ?([\w$]+)/gm)].map(m => m[1]);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(ENTRIES, { recursive: true });
for (const [name, files] of Object.entries(BUNDLES)) {
  const entry = files.map((f, i) => `import * as m${i} from ${JSON.stringify(src(f))};`).join("\n") +
    `\nconst all = Object.assign({}, ${files.map((_, i) => `m${i}`).join(", ")});` +
    `\nwindow.__sk = all;` +
    `\nfor (const k of ${JSON.stringify([...new Set(files.flatMap(fnNames))])}) window[k] = all[k];\n`;
  const entryFile = path.join(ENTRIES, `${name}.js`);
  fs.writeFileSync(entryFile, entry);
  await build({
    configFile: false,
    logLevel: "warn",
    root: ROOT,
    build: {
      outDir: OUT, emptyOutDir: false, target: "chrome120", minify: false, write: true,
      lib: { entry: entryFile, formats: ["iife"], name: "SidekickTest", fileName: () => `${name}.js` }
    }
  });
}
console.log(`test bundles: ${Object.keys(BUNDLES).join(", ")} → .test-build/`);
