# ADR-006: The jsdom suites run against test bundles of the same modules

Status: accepted (2026-10-29).

## Context
About 580 jsdom checks concatenated raw source files into one window and read internal names off `window`. ES modules end that.

## Decision
`scripts/build-test.mjs` bundles the modules (Vite, IIFE) into `.test-build/`: `lib.js` (everything but page UI) and one bundle per page (lib + the page's folder). Each exposes all exports on `window.__sk`, and exported function declarations on `window` except names the browser already defines. `tests/jsdom/helpers.js` `loadScripts(w, files, expose)` keeps its signature and picks the bundle from the file list. `npm test` builds the bundles first. New pure-logic tests go to Vitest (`tests/unit`), importing modules directly; jsdom suites get ported over time.

## Consequences
The suites test bundled code close to what ships. A bundle contains more than a suite asked for, which is harmless because modules have no import-time side effects outside the page entries (keep it that way).
