# Migration plan: organized folders + TypeScript + a build

Status: proposal (checkpoint 2), 2026-10-29. Starts from v0.9.5 (`4cfef50`): `npm test` 546/546, `npm run test:chrome` 55/55.

**Goal:** the same extension, organized into folders, typed, and built. After every step: both suites green, one commit (or a few). No new features, no prompt changes.

---

## 1. Target layout

Based on ARCHITECTURE.md §3, adjusted to today's code. Folders for things that don't exist yet (`trace/`, `agent/perception` from CDP) come later. The folders are named so agent v2 slots in without another move.

```
sidekick/
  package.json  tsconfig.json  vite.config.ts  README.md  CLAUDE.md
  src/
    manifest.json             hand-written, copied to dist/ unchanged (plus a fixed "key", see §6)
    pages/                    the HTML entry points; built to dist/ root, so URLs stay sidepanel.html, profile.html, …
      sidepanel.html  profile.html  options.html  evals.html  mic.html
    background/
      service-worker.ts       (background.js)
    content/
      webmcp-capture.js       MAIN world, document_start. Copied byte for byte, never bundled (see §4.4)
    page/                     functions injected into web pages: one per file, self-contained, no imports
      snapshot.ts             skPageSnapshot
      act.ts                  skPageAct
      webmcp.ts               skWebMCPList, skWebMCPCall           (MAIN world)
      read.ts                 page text, problem text across frames, selection   (now lambdas in screen.js)
      region.ts  replace-selection.ts  leave-prompt.ts            (now in sidepanel.js / agent.js)
    core/
      llm/                    settings.ts, call.ts (modelCall + watchdog), anthropic.ts, openai.ts, sse.ts, usage.ts   (ai.js)
      storage/                schema.ts (one typed schema for every key), store.ts (typed get/set)
      messaging/              types.ts (the `pending` hand-off from the context menu; more later)
      security/               guard.ts (fence, redaction, injection scan, stripWrappers), sites.ts (siteOf, personalDetailsIn), net.ts (isPrivateHost)
      browser/                screen.ts (captures, runInPage), cdp.ts (TrustedInput), timeouts.ts
      web/                    read-url.ts, search.ts                 (web.js)
      docs/                   extract.ts                              (docs.js)
      calc/                   engine.ts                               (calc.js)
    assistant/                the chat brain
      routing.ts  prompt.ts  tools.ts  turn.ts                        (brain.js)
      review/                 math double-check: parse.ts, arbitrate.ts, verify.ts   (brain.js)
      memory/                 memory.ts, memory-io.ts, documents index
      skills.ts  session.ts  profile.ts                               (skills.js, session.js, profile-core.js)
    agent/
      loop/                   run.ts (runAgent), plan.ts, transcript.ts (trimTranscript), tabs.ts (tab group, following)
      perception/             capture.ts (captureTab), format.ts (formatSnapshot, groupRepeats)
      actions/                run-tool.ts (the switch, split by tool family), describe.ts
      safety/                 gates.ts (gateVisit, gateShare, checkAction, siteBlocked, RISKY_WORDS, NEVER_AUTO)
      skills/                 shortcuts.ts, site-notes.ts            (adapters.js)
      tools.ts  prompt.ts                                              (AGENT_TOOLS, agentSystemPrompt: text unchanged)
    ui/
      sidepanel/              main.ts, sidepanel.css, markdown.ts, chats.ts, attachments.ts, agent-card.ts, voice.ts, notify.ts
      profile/  options/  evals/  mic/                                 main.ts (+ css)
  public/                     copied to dist/ as is
    icons/  vendor/ (with licenses)
  tests/
    legacy/                   today's jsdom suites, unchanged, running against the built bundles (§3)
    e2e/                      real-chrome-test.js (loads dist/)
    unit/                     new Vitest suites as legacy ones are ported
    fixtures/
    helpers.js  run-all.js  README.md
  scripts/                    build helpers: check-page-functions.mjs
  docs/
    adr/                      ADR-002 build, ADR-005 page scripts, ADR-006 test strategy, …
    archive/                  NEXT_STEPS_v0.9.md, CLAUDE_CODE_KICKOFF.md
```

Two departures from ARCHITECTURE.md §3: (1) HTML entry points live in `src/pages/` so the built URLs don't change (`profile.html?welcome=1`, `mic.html`, links between pages); (2) `agent/perception` and `agent/actions` hold today's code (the in-page walker and the tool switch). v2 replaces their insides, not their place.

## 2. Build tooling: plain Vite (recommendation for ADR-002)

**Recommend: Vite 8 with a hand-written manifest. Not WXT.** Confidence: medium-high.

| | Plain Vite 8 | WXT 0.21 |
|---|---|---|
| Manifest | ours, copied unchanged: easy to prove nothing changed | generated from entrypoint files and config; has to be diffed against today's every time |
| `webmcp-capture.js` (must add nothing to pages) | copied byte for byte from `public/`-style handling | bundled through WXT's content-script wrapper; would need proof it adds nothing in MAIN world |
| Injected page functions | ordinary functions in the panel bundle, with our own check (§4) | same problem, plus more layers to inspect |
| Stability | Vite 8.3, mature | pre-1.0; minor versions can break |
| Dev loop | `vite build --watch`, then reload in chrome://extensions (same as today) | hot reload and auto-opening a browser |
| Later (Electron app) | Vite is the usual Electron bundler too | extension-only |

WXT's real wins are hot reload and store publishing, and we need neither now. If we want hot reload later, it's an addition, not a rewrite. CRXJS was also considered; it has the same "more magic in the build" downside.

**Settings (all in the ADR):**
- `build.target: "chrome120"` (ES2022+). Nothing gets down-levelled, so no `__async`/`__spreadValues` helpers end up inside page functions.
- **No minification** (`minify: false`) and no `keepNames`. Size doesn't matter for an unpacked extension; readable stack traces do; and it removes the main risk to self-contained page functions.
- No source maps in `dist/` for now. They can be added for debugging later.
- Vendor libraries stay as files in `public/vendor/`, loaded exactly as today (globals from `<script>` tags, `math.js`/`nerdamer`/`mammoth` by URL, pdf.js via `import(/* @vite-ignore */ chrome.runtime.getURL(...))`). No version changes.

**Versions** (pinned exactly, each at least 2 weeks old when added): `vite` 8.3.4, `typescript` 6.0.3 (TS 7.0 is out, but `typescript-eslint` doesn't support it yet), `@types/chrome`, `vitest` (5.0.x, whichever is 2 weeks old by then). Lint: `eslint` + `typescript-eslint` recommended rules only, added near the end. **No Prettier run over the code:** it would rewrite every line and hide real changes in the diffs.

`npm run build` → `dist/`. Load in Chrome: Load unpacked → `dist/`. `npm run dev` = `vite build --watch`.

## 3. How the tests stay green the whole way

The problem: 20 jsdom suites build a page by concatenating raw source files (`loadScripts(w, ['ai.js', …], expose)`) and read about 60 internal names off `window`. That stops working once files use `import`/`export`.

**The bridge: test bundles that rebuild today's world.** The build makes two extra outputs into `.test-build/` (git-ignored):
- `lib.js`: every non-UI module (no import-time side effects; I checked: today's non-UI files only declare things), assigning every formerly-global name to `window`.
- `sidepanel.js`, `profile.js`, `evals.js`, `options.js`: the page entries with the same exposure.

`loadScripts(w, files, expose)` keeps its signature. It maps the file list to the right bundle (any list containing `sidepanel.js` → the panel bundle, `profile.js` → the profile bundle, otherwise `lib.js`), loads vendor files as before, and exposes names the same way. **No suite changes its assertions.** `npm test` runs `build:test` first.

Small prerequisites, done in step 1:
- `region-test.js` cuts `pickRegionInPage` out of `sidepanel.js` by string index → take it from the bundle (`w.pickRegionInPage.toString()`).
- `real-chrome-test.js` regex-extracts `JOB` from `sites-test.js` → move `JOB` to `tests/fixtures/job.html`.
- Suites that read `sidepanel.html`/`profile.html` and strip `<script>` tags → read them from `src/pages/`, same stripping.
- `scroll-test` and `region-test` print true/false without failing → make them print PASS/FAIL and add them to `run-all.js`. `math-test.js` (dead) → delete.

**The real-Chrome suite** loads `dist/` instead of `extension/` and runs `npm run build` first. Its checks don't change.

**Moving to Vitest over time:** step 7 adds `tests/unit/legacy.test.ts`, which runs each legacy suite as a Vitest test (one test per suite, failing with the suite's FAIL lines). That gives one runner and watch mode right away. After that, suites are ported one by one into real Vitest files importing modules directly (leaves first: guard, calc, sites, memory). This is ongoing work after the migration, not a blocker. Playwright stays a script until the benchmark work, then moves to `@playwright/test`.

## 4. Injected page functions: stay `func` + closure-free (ADR-005)

**Choice: keep `chrome.scripting.executeScript({ func, args })` for every injected function, with each one in its own file under `src/page/` and a build check that it's self-contained.** Not `files: [...]`.

Why:
1. `files` can't pass arguments; every call would need two injections (define, then call), and the definitions would stay in the frame between calls.
2. In the **MAIN** world (`skWebMCPList`, `skWebMCPCall`, the leave-prompt disarm), a file would define names the page can see: the fingerprinting problem `webmcp-capture.js` is built to avoid. Those must be `func` anyway.
3. Today's code works with `func`, and the tests already exercise it the honest way (the fake `executeScript` runs `func.toString()` inside the page).

The risk is the build adding outside references to a function. Guards:
- §2 settings (modern target, no minify, no keepNames).
- `scripts/check-page-functions.mjs` runs on every build. It takes each function exported from `src/page/*` **out of the built bundle**, parses its `toString()` (acorn), and fails the build if it uses any identifier that isn't its own or a browser global.
- The legacy and e2e suites run the built functions inside pages (as today).
- Each `src/page/*.ts` file may import **types only**.

### 4.4 `webmcp-capture.js`
It stays plain JavaScript and is copied unchanged. It's 48 lines, runs in the page's own world at `document_start`, and must not grow a module wrapper or helpers. It gets type-checked through `// @ts-check` + JSDoc, not converted.

## 5. Steps (each one tested and committed on its own)

| # | Step | What changes | Risk |
|---|---|---|---|
| 1 | **Tooling and test bridge** | Add Vite, TS (allowJs, checkJs off), `@types/chrome`. Each `extension/*.js` gets `export` on its top-level declarations, and each page gets one module entry that imports its files **in today's order** and assigns their exports to `globalThis` ("legacy globals"), so code still finds every name at runtime exactly as before. HTML: one `<script type="module">` per page. Build → `dist/` (manifest copied unchanged). Test bundles + `loadScripts` switch (§3). real-chrome loads `dist/`. Fix the 4 small test prerequisites. | Medium: biggest step. Check: no cross-file mutable `let` is read through a global (copied once; I found none, the script confirms) |
| 2 | **Folders** | `git mv` every file into the §1 layout (1:1, no splitting yet); `public/` for icons and vendor; `src/pages/`; `tests/legacy`, `tests/e2e`; kickoff doc → `docs/archive/`. Only paths change. | Low |
| 3 | **Real imports** | File by file, leaves first, replace globals with `import`s; turn `typeof X === "function"` guards into imports (one visible effect: `read_url`'s personal-data check now also works on the evals page; it was silently off there). Remove the legacy-globals shim from production pages; the test bundles keep exposing names. | Medium. `tsc --checkJs` catches every missed name |
| 4 | **Page functions** | Move the inline lambdas (screen.js ×4, sidepanel ×2, agent ×1) and `page-agent.js` into `src/page/*` as named functions; add `check-page-functions.mjs` to the build. | Medium (this is the step that could break every snapshot; the check and both suites guard it) |
| 5 | **TypeScript, leaves first** | `.js` → `.ts` in this order: security, net, sites, calc, docs, web, storage (new schema module), llm, browser, memory, skills, session, profile, page/*, agent/*, assistant/*, ui/*. `strict: true` for all `.ts` from the first file. New types: `StorageSchema` (every key, including `chat:${id}`), `ModelMessage`/`ModelCallOptions`/`ModelResult`, `ToolDef` and per-tool `ToolCall` args (agent and chat), `PageSnapshot` (what `skPageSnapshot` returns), `ActionResult` (what `skPageAct` returns), `Settings` (from `DEFAULT_SETTINGS`), `PendingHandoff` (session message). Types describe today's shapes, including the text-line snapshot format. When the last file is converted, `allowJs` goes off. | Low per file; many commits |
| 6 | **Split the big files** | Move functions out of `sidepanel.ts` (2,062 lines), `agent.ts` (1,381) and `brain.ts` (987) into the §1 folders. Moves only: same functions, same bodies. Prompts move into `prompt.ts` files unchanged (a test asserts the built prompts are identical strings). | Low-medium |
| 7 | **Vitest + lint** | `tests/unit/legacy.test.ts` wrapper; first ported suites (guard, sites); ESLint with typescript-eslint recommended; `npm run check` = typecheck + lint + build + legacy + e2e. | Low |
| 8 | **Docs** | CLAUDE.md (layout, commands, gotchas), ARCHITECTURE.md (§1 current state, §4 done), tests/README.md, README, `docs/adr/` (002 build, 005 page scripts, 006 test bridge, 007 extension key), package.json scripts. | Low |

After step 8: load `dist/` in your Chrome myself through Claude in Chrome if the extension pages are reachable that way, else give you a 5-step checklist (load, add key, chat, agent on a test page, profile page).

## 6. Extension ID (you chose "start fresh")

Loading `dist/` gives a new ID with empty storage; that's accepted. In step 1 I'd also add a fixed public `"key"` to `manifest.json`, so the ID never changes again: not when the folder moves, the repo is re-cloned, or you switch machines. That's the one manifest change in the whole migration. The key is a public key (safe to commit); its private half isn't needed for unpacked loading and isn't kept. Skip it if you'd rather keep the manifest byte-identical.

## 7. What I will NOT change

- **Behavior.** Same features, flows, limits, timeouts, retries, storage keys and shapes, settings and defaults. The one intended exception is §5 step 3 (the evals page gets the `read_url` personal-data check).
- **Model IDs** in `DEFAULT_SETTINGS`, request shapes (thinking/effort/caching/`store: false`), routing rules.
- **Prompt text**: system prompts, tool names and descriptions, checker prompts, nudge messages. Moved between files only, checked by a test.
- **Security rules**: every invariant in CLAUDE.md, every check in security/safety/hardening, `webmcp-capture.js` byte for byte, the manifest's permissions and content-script settings.
- **Vendor library versions.**
- **The UI**: no React, no restyling.
- **Out of scope**, noted for after (in this order): full Public Suffix List via `tldts` in `siteOf`; blocking `read_url` redirects into private addresses before they're sent; structured snapshots (objects, not text lines); serialized storage writes; price table for cost in dollars; then Phase F (trace recorder, real-site benchmark).

## 8. What can't be verified by the suites

- The extension on your real Chrome profile with a real API key (the suites fake the model APIs).
- Real sites (the benchmark is Phase F).
- Headful background-tab behavior: real-chrome runs headless Chromium, so "agent works in a background tab" is verified there, not in your visible Chrome. Checking it in your visible Chrome needs a short agent run with your API key (a few cents), so only with your OK.
