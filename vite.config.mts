import { defineConfig, type Plugin } from "vite";
import { cpSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "src");
const OUT = resolve(import.meta.dirname, "dist");
export const PAGES = ["sidepanel", "profile", "options", "evals", "mic"];
// Copied byte for byte (dist path ← source): the manifest, the service worker, and the
// MAIN-world content script, which must add nothing to pages. public/ (icons, vendored
// libraries loaded by URL at runtime) is copied as is by Vite.
const STATIC: Record<string, string> = {
  "manifest.json": "manifest.json",
  "background.js": "background/background.js",
  "webmcp-capture.js": "content/webmcp-capture.js"
};

const copyStatic = (): Plugin => ({
  name: "sidekick-copy-static",
  apply: "build",
  closeBundle() {
    for (const [to, from] of Object.entries(STATIC)) cpSync(resolve(SRC, from), resolve(OUT, to));
  }
});

export default defineConfig({
  root: resolve(SRC, "pages"), // the HTML entry points land at the root of dist/, so URLs don't change
  publicDir: resolve(import.meta.dirname, "public"),
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
      input: Object.fromEntries(PAGES.map(p => [p, resolve(SRC, "pages", `${p}.html`)]))
    }
  },
  plugins: [copyStatic()]
});
