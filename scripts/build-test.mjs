// Builds the bundles the jsdom suites load (tests/helpers.js loadScripts): the same modules as the
// extension, as classic scripts, with every export reachable from the test. Function declarations
// also land on window, as they did when each file was a classic <script>.
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, ".test-build");
const LIB = ["ai", "guard", "profile-core", "memory", "memory-io", "skills", "docs", "web", "screen", "calc", "page-agent", "cdp", "adapters", "agent", "session", "brain"];
const BUNDLES = { lib: LIB, sidepanel: [...LIB, "sidepanel"], profile: [...LIB, "profile"], evals: [...LIB, "evals"], options: [...LIB, "options"], mic: ["mic"] };

const ENTRIES = path.join(ROOT, "node_modules", ".sk-test-entries");
const FILE = {
  ai: "core/llm/ai.js", guard: "core/security/guard.js", web: "core/web/web.js", screen: "core/browser/screen.js", cdp: "core/browser/cdp.js",
  docs: "core/docs/docs.js", calc: "core/calc/calc.js", "profile-core": "assistant/profile-core.js", memory: "assistant/memory/memory.js",
  "memory-io": "assistant/memory/memory-io.js", skills: "assistant/skills.js", session: "assistant/session.js", brain: "assistant/brain.js",
  adapters: "agent/skills/adapters.js", agent: "agent/agent.js", "page-agent": "page/page-agent.js",
  sidepanel: "ui/sidepanel/sidepanel.js", profile: "ui/profile/profile.js", options: "ui/options/options.js", evals: "ui/evals/evals.js", mic: "ui/mic/mic.js"
};
const src = name => path.join(ROOT, "src", FILE[name]);
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
