// Fails the build if an injected page function uses anything from outside its own body.
// chrome.scripting.executeScript({ func }) sends only the function's source text, so a reference
// to a module-level name (or a helper the bundler added) works in the panel and breaks in the page.
// Checks the built output in dist/, which is what Chrome actually injects.
import fs from "node:fs";
import path from "node:path";
import * as espree from "espree";
import * as eslintScope from "eslint-scope";
import globals from "globals";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE = path.join(ROOT, "src", "page");
const ASSETS = path.join(ROOT, "dist", "assets");
const ALLOWED = new Set([...Object.keys(globals.browser), ...Object.keys(globals.builtin)]);

// The functions to check: everything src/page/*.js exports.
const names = new Set();
for (const f of fs.readdirSync(PAGE).filter(f => /\.(js|ts)$/.test(f))) {
  for (const m of fs.readFileSync(path.join(PAGE, f), "utf8").matchAll(/^export (?:async )?(?:function\*? ?|const )([\w$]+)/gm)) names.add(m[1]);
}

const parse = code => espree.parse(code, { ecmaVersion: "latest", sourceType: "module", range: true, loc: true });
const found = new Map(); // name -> problems
for (const file of fs.readdirSync(ASSETS).filter(f => f.endsWith(".js"))) {
  const code = fs.readFileSync(path.join(ASSETS, file), "utf8");
  const ast = parse(code);
  const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: "module" });
  const check = (name, fnNode) => {
    const fnScope = scopes.acquire(fnNode);
    const problems = [];
    // Every reference that leaves the function: must be a browser global, never a module name.
    for (const ref of fnScope.through) {
      const id = ref.identifier.name;
      if (ref.resolved) problems.push(`uses "${id}" from the bundle (line ${ref.identifier.loc.start.line} of ${file})`);
      else if (!ALLOWED.has(id)) problems.push(`uses unknown global "${id}" (line ${ref.identifier.loc.start.line} of ${file})`);
    }
    found.set(name, [...(found.get(name) || []), ...problems]);
  };
  for (const node of ast.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (decl?.type === "FunctionDeclaration" && names.has(decl.id.name)) check(decl.id.name, decl);
    if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type === "Identifier" && names.has(d.id.name) && /Function/.test(d.init?.type || "")) check(d.id.name, d.init);
      }
    }
  }
}

let failed = false;
for (const name of names) {
  if (!found.has(name)) {
    // Not in any chunk: either unused (fine to skip) or renamed by the bundler (must be checked).
    const anywhere = fs.readdirSync(ASSETS).some(f => f.endsWith(".js") && fs.readFileSync(path.join(ASSETS, f), "utf8").includes(name));
    if (anywhere) { console.error(`✗ ${name}: in the bundle under another shape; can't verify it`); failed = true; }
    continue;
  }
  const problems = found.get(name);
  if (problems.length) { failed = true; console.error(`✗ ${name}:\n  ${problems.join("\n  ")}`); }
}
if (failed) { console.error("\nInjected page functions must be self-contained (see src/page/)."); process.exit(1); }
console.log(`page functions self-contained: ${[...found.keys()].sort().join(", ")}`);
