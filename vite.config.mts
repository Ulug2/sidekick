import { defineConfig, type Plugin } from "vite";
import { cpSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "extension");
const OUT = resolve(import.meta.dirname, "dist");
// Copied byte for byte: the manifest, the service worker, the MAIN-world content script
// (it must add nothing to pages), icons and the vendored libraries (loaded by URL at runtime).
const STATIC = ["manifest.json", "background.js", "webmcp-capture.js", "icons", "vendor"];

const copyStatic = (): Plugin => ({
  name: "sidekick-copy-static",
  apply: "build",
  closeBundle() {
    for (const p of STATIC) cpSync(resolve(ROOT, p), resolve(OUT, p), { recursive: true });
  }
});

export default defineConfig({
  root: ROOT,
  publicDir: false,
  base: "./",
  logLevel: "warn",
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: "chrome120", // nothing is down-levelled, so no helpers end up inside injected page functions
    minify: false, // readable stack traces; injected functions stay exactly as written
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: Object.fromEntries(["sidepanel", "profile", "options", "evals", "mic"].map(p => [p, resolve(ROOT, `${p}.html`)]))
    }
  },
  plugins: [copyStatic()]
});
