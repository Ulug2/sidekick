# ADR-002: Build tool: plain Vite, not WXT

Status: accepted (2026-10-29).

## Context
The extension was plain JavaScript with no build. The migration had to keep behavior identical, including two things a bundler can break: the MAIN-world content script (`webmcp-capture.js`) must add nothing to pages, and injected page functions must stay self-contained.

## Decision
Vite 8 with a hand-written `src/manifest.json`:
- HTML entry points in `src/pages/` (so built URLs stay `sidepanel.html`, `profile.html?welcome=1`, …), service worker built to `dist/background.js` as one standalone file.
- `manifest.json` and `content/webmcp-capture.js` are copied byte for byte; `public/` (icons, vendored libraries) is copied as is.
- `target: chrome120` (nothing down-levelled, so no helpers inside page functions), `minify: false`, no modulepreload polyfill.
- `npm run build` = `tsc` + `vite build` + `scripts/check-build.mjs`.

## Why not WXT
WXT generates the manifest from entrypoint conventions and wraps content scripts; both would have to be proven harmless on every change. It is pre-1.0. Its main gains (hot reload, store publishing) aren't needed now; hot reload can be added later. Vite is also the usual bundler for the planned Electron app.

## Consequences
Load `dist/`, not the source folder. Rebuild (`npm run dev` watches) and reload the extension after changes.
