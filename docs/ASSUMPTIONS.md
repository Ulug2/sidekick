# Assumptions and findings (code read, 2026-10-29, v0.9.4)

Written after reading the code, not just the docs. Baseline on this Mac (Node 24.8, Chromium from Playwright 1.63): `npm test` 530/530, `npm run test:chrome` 54/54, `scroll-test` and `region-test` all true. Commit `5f12efa`.

Confidence tags: **(high)** I checked it in the code or by running it; **(medium)** likely, partly checked; **(low)** an opinion or a guess.

---

## 1. How it works, in my words

- One page, the side panel, does everything. `sidepanel.html` loads 4 vendor libraries and 16 of our scripts as classic `<script>` tags, so they all share one global scope. Math.js, nerdamer, mammoth and pdf.js load later, on demand, by URL (`calc.js loadScript`, `docs.js`).
- `background.js` only opens the panel and handles the context menu. Nothing runs when the panel is closed.
- **Chat:** `sidepanel.send` → `brain.runTurn` (local routing to fast/smart, system prompt + context, tool loop, math review pipeline) → `ai.modelCall` (one function, two providers, SSE streaming, 90 s silence watchdog with one retry, per-day token usage).
- **Agent:** `sidepanel.runAgentCard` builds a `ui` object (step, note, thinking, plan, approve, ask, signal) and calls `agent.runAgent`. Each step: `captureTab` runs `skPageSnapshot` in every frame → the page returns **text lines** (`[12] button "Apply" …`) → `captureTab` parses them back with a regex into `state.elements` → `formatSnapshot` builds full or change-only text → smart model → `runTool` (gates, then the action through CDP or through `skPageAct` in the page) → next snapshot.
- **Safety** is spread out: `guard.js` (fence, redaction, injection scan, wrapper stripping), `agent.js` (`RISKY_WORDS`, `NEVER_AUTO`, `gateVisit`, `gateShare`, `checkAction`, `siteBlocked`, the site re-check), `adapters.js` (`personalDetailsIn`, `siteOf`), `web.js` (`isPrivateHost`), `page-agent.js` (its own `SECRET` field regex, trap fields), `sidepanel.renderMarkdown` (no-fetch tags and attributes, link rewriting).
- **Storage:** about 10 files call `chrome.storage.local` directly, each with its own key and read-modify-write.

## 2. Where the docs and the code disagree

| Docs say | Code does | Conf. |
|---|---|---|
| "Every outside await has a timeout and obeys Stop" (CLAUDE.md rule 4, LESSONS 8) | True for model streams, agent page calls (`agent.pageScript`, 15 s) and debugger commands (`cdp.send`, 4 s). **Not** true for: `screen.js runInPage/readPageText/readProblemText/readSelectionFromPage` (chat's page reads; a page showing `alert()` hangs the chat turn), `web.js fetchUrlText` and `webSearchFallback` (no timeout and no Stop signal; used by chat `read_url`/`web_search` and agent `web_search`), `chrome.debugger.attach`, `chrome.tabs.captureVisibleTab`. | high |
| "Never change which tab the user is looking at" (LESSONS 5, USER_GUIDE "never pulls you back") | `open_tab` creates the tab with `active: true`, and `switch_tab` activates it (`agent.js` ~1261, ~1277). These are the agent's own choices, so it may be on purpose, but it contradicts the rule. | high |
| `read_url` refuses links that redirect into your network (SECURITY.md) | It refuses to **read** them, but `fetch(..., { redirect: "follow" })` has already sent the request to the private address by then (blind GET to a router). A public hostname that resolves to a private IP (DNS rebinding, `127.0.0.1.nip.io`) isn't caught at all. | high |
| "A shortcut only runs on the site it was learned on"; plan approval, upload approval and sharing checks are per site | "Site" is `adapters.siteOf`, a two-label heuristic, not the Public Suffix List. `alice.github.io` and `evil.github.io` are the same site, and so are any two `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, `*.herokuapp.com`, `*.web.app`, `*.blogspot.com` pages. An approved plan, upload or sharing OK on one carries over to an attacker's page on the same host. | high |
| `read_url` refuses links carrying personal data | Only when `personalDetailsIn` and `getProfile` exist on the page (`brain.js:238` checks with `typeof`). `evals.html` doesn't load `adapters.js`, so the check is silently off there. A security check shouldn't depend on which script tags a page has. | high |
| SECURITY.md: "v0.9.3", real-chrome suite "(36)" | v0.9.4, 54 checks | high |
| USER_GUIDE: quality checks run "16 graded conversations"; "Unzip somewhere permanent" | `evals.js` has 24 cases (some offline); install is now from git | high |
| CLAUDE.md: only `page-agent.js` functions must be self-contained | Other functions are injected too and have the same rule: `sidepanel.js pickRegionInPage` and the lambda in `replaceSelectionOnPage`, four lambdas in `screen.js`, the lambda in `agent.js disarmLeavePrompt` | high |
| tests/README: the suites run the side panel's scripts | `PANEL_SCRIPTS` preloads `vendor/math.js` and `nerdamer.js`, which the real panel loads lazily, so jsdom never tests the lazy-load path (real-chrome covers part of it) | high |
| `npm test` covers everything | `scroll-test.js` and `region-test.js` aren't in `run-all.js` and print true/false without failing, so they never gate anything. `math-test.js` is dead (legacy). | high |

## 3. Fragile, dead, duplicated, over-complicated

**Fragile**
- **The snapshot is a text protocol.** `skPageSnapshot` returns formatted lines; `captureTab` parses them back with `/^\[([\d:]+)\] (\S+) "(.*?)"/`, and `adapters.questionOfLine`, `replayShortcut` (`line.includes('value: "…')`) and `find` parse the same text again. A label containing `"` is cut short. Matters a lot for traces and agent v2: the page should return objects, and text should be made only at the edge, for the model. (high)
- **Storage writes race.** Read-modify-write in about 10 files with no serialization (only `recordUsage` queues). `saveChat` (chatIndex), `addMemory`, `saveAdapters`, `saveSkills` can lose an update when two run at once (end-of-chat reflection while a chat saves). (medium: possible, not seen)
- **Module-level run state** in `agent.js`: `agentSignal` is a global, so only one agent run can exist at a time. True today, but it will matter when runs move to the service worker or run in parallel. (high)
- **Small leak in `runAgent`:** `onCreated`/`onActivated` listeners are added before the `try`, and the first `snapshotTab` (inside the first transcript message) runs outside it. If that throws (tab closed), the listeners are never removed. (high, minor)
- **Implicit dependencies** found only by reading: `cdp.js` uses `shrinkImage` (screen.js), `web.js` uses `extractDocText` (docs.js), `adapters.js` calls `modelCall`, `brain.js` calls `runAgent` through `env`, plus 6 `typeof X === "function"` guards for optional ones. (high)
- **Lots of short generic names** used both as globals and as locals (`input`, `stop`, `chat`, `sleep`, `plain`, `quote`, `close`, `clip`). One missing `let` writes a global by accident. Modules plus strict TS remove this class of bug. (high)
- **Prompts live inside logic files** (`agentSystemPrompt` in agent.js, `buildSystemPrompt` in brain.js, `CHECK_SYSTEM`, tool descriptions), so a prompt diff looks like a code diff. (high)

**Dead**
- `skills.js findSkill` (only tests use it), `sidepanel.js speakingToggle` (set, never read), `tests/math-test.js`. (high)

**Duplicated**
- `sleep` (agent.js) / `sleepMs` (screen.js); `PROTECTED` (agent.js) / `PROTECTED_URL` (screen.js), and the two regexes differ (`chrome-search:` is only in one). (high)
- The secret-field regex exists in `page-agent.js` (`SECRET`) and, in another form, in `guard.js`. The page copy has to stay (it must be self-contained), but nothing checks that the two agree. (high)

**Over-complicated (for later, not the migration)**
- `sidepanel.js` (2,062 lines) is UI, chat lifecycle, attachments, voice, agent card and notifications in one file. `agent.js runToolInner` is a 400-line switch. Both will split naturally by folder during the migration (same functions, more files). (high)
- The tests reach into internals: `loadScripts(..., expose)` exposes about 60 internal names; `region-test.js` cuts `pickRegionInPage` out of `sidepanel.js` **by string index**; `real-chrome-test.js` pulls the `JOB` fixture out of `sites-test.js` **with a regex on its source**. Any file move or rename breaks these. (high)

## 4. Risks for the TypeScript migration

1. **Injected functions must stay closure-free after the build.** `executeScript({ func })` sends `func.toString()`. Bundlers can add references to outer helpers inside a function: esbuild `keepNames` adds `__name(...)`, down-levelling to an older target adds `__async`/`__spreadValues`, TS emit can add `__awaiter`. Any of these breaks every snapshot at runtime, and jsdom tests that load the source would not notice. Fix: target ES2022 or later, no `keepNames`, and a build-time test that takes every injected function from the **built** output, runs its `toString()` in an empty realm, and fails on any free variable. (high)
2. **`files: [...]` vs. `func`.** `files` can't pass arguments, and a file injected into the **MAIN** world would define globals the page can see (fingerprinting, the reason `webmcp-capture.js` is so careful). So `skWebMCPList`/`skWebMCPCall` and `disarmLeavePrompt` must stay `func`. My preference: keep `func` for everything, with each page function in its own self-contained TS file and the check from point 1. (medium; the plan will argue it out)
3. **The tests load raw source files.** Once files use `import`/`export`, concatenating them into jsdom stops working. The way through: a build target that bundles the same files into one IIFE which puts every formerly-global name on `window`, the exact world the tests expect today. Point `loadScripts` at that bundle, and every suite keeps running unchanged while files move. The `sidepanel.html` script-tag stripping, `region-test`'s string slicing and `real-chrome-test`'s regex on `sites-test.js` need small fixes first. (high)
4. **One global scope → imports.** The dependency graph is a DAG (sidepanel → brain → agent/session → adapters/memory/... → ai/guard), so no real cycles to untangle. The work is the implicit dependencies and `typeof` guards above, plus the profile, options and evals pages loading different subsets. (medium-high)
5. **Vendor libraries.** `marked`, `DOMPurify`, `katex`, `hljs` are globals from script tags; `math.js`/`nerdamer`/`mammoth` load by URL; pdf.js loads with `import(chrome.runtime.getURL(...))`. During the migration they stay as copied static files at the same paths (`vendor/...`), not npm packages. Swapping versions is a behavior change. The bundler has to leave the dynamic `import()` alone (`/* @vite-ignore */`), and the calc suites must keep running with `--disallow-code-generation-from-strings`. (high)
6. **`webmcp-capture.js`** runs in MAIN world at `document_start`. Its build output must be a plain classic script that adds nothing to the page (no module wrapper, no `import.meta`, no preload polyfill). Copy it as is, or build it as a bare IIFE, and keep real-chrome check 7. (high)
7. **Extension ID and your data.** An unpacked extension's ID comes from its folder path. Loading `dist/` instead of `extension/` gives a **new ID with empty storage**: no API key, profile, memories or chats. Fixing a `key` in the manifest pins the ID, but it changes once when the key is added. See question 1. (high)
8. **MV3 CSP:** no `eval`, no inline scripts. Fine for a production build; dev-mode hot reload must not rely on eval. (medium)
9. **Test hooks** `globalThis.SK_STALL_MS` / `SK_PAGE_MS` and the fake `chrome`/`fetch` must keep working against the bundle. (high)

## 5. Where I'd do something differently from ARCHITECTURE.md

- **ADR-002 (build tool):** leaning **plain Vite + a hand-written `manifest.json`** over WXT for this migration. WXT generates the manifest and imposes its own entrypoint layout and conventions. That's helpful for a new project, but here it adds an abstraction layer at the exact moment the goal is "same extension, byte-for-byte same manifest". Vite with multiple inputs plus a separate small build for page scripts is a little more config, but every output file is visible and predictable. Vitest shares the config. I'll argue this fully in MIGRATION_PLAN.md. (medium)
- **ADR-004 (UI):** keep vanilla DOM during the migration and for agent v2. React only if the UI work becomes the bottleneck. (high)
- **ADR-003 (perception):** agree with CDP AX tree + DOMSnapshot. Since trusted input already attaches the debugger (and shows the yellow bar), CDP perception costs almost nothing extra in user experience. (medium-high)
- **Structured snapshots before agent v2.** Changing the page→agent snapshot from text lines to objects (text made only for the model) is the single change that most helps traces, the benchmark and v2. It's internal, but it is a behavior change, so it's out of the migration. I'd make it the first step of Phase F. (medium)
- **Where runs live:** an MV3 service worker can be stopped after about 30 s idle. Long agent runs are better in an **offscreen document** (or kept in the panel), with the service worker only for alarms and notifications. Worth an ADR before Phase 4. (medium)
- **Cost:** there is no price table anywhere. Usage is tokens per model per day, never dollars. The benchmark ("cost per task"), the budget meter (Phase 5) and rule 11 ("estimate cost per run") all need one. Small, and should come with the trace recorder. (high)

## 6. Things that will matter for Phase F (trace recorder, benchmark)

- The `ui` object passed to `runAgent` (step, note, thinking, plan, approve, ask) plus `modelCall`'s result (`usage`, `ms`, `model`) are natural hooks for a recorder, and need almost no agent changes.
- Today only step **titles** (`state.steps`) survive a run; the transcript and screenshots are trimmed in memory (`trimTranscript`) and never saved.
- `actInPage` results (`ok`, `error`, `note`, `covered`) are already structured: a good base for typed action results.
- Benchmark needs dollars per run (see Cost above) and a way to run without the panel being driven by hand.

## 7. Questions for you

1. **Your current install:** do you use 0.9.4 every day with real data (API key, profile, resume, memories, chats)? If yes, how should we keep it when Chrome loads the build folder instead of `extension/`? Options: (a) add a fixed `key` to the manifest now (the ID changes once; you re-enter the key and use Export/Import for memories and skills, but chats and the profile don't carry over); (b) have the build write to `extension/` itself (same path, same ID, all data kept, but the folder becomes build output); (c) you don't care, start fresh.
2. **The two security gaps** (`siteOf` treating `*.github.io`-style hosts as one site; `read_url` sending the request before it checks a redirect): fix them **before** the migration (two small commits, each with a regression test), or log them and fix after? I'd fix `siteOf` before (it's a security invariant) and do the redirect one after (needs a design: manual redirects plus a DNS check).
3. **The rule-4 timeout gaps** (chat page reads, `read_url`, `web_search`): same question. They're real bugs, but fixing them isn't "behavior-preserving". My default is after the migration, as the first fixes.
4. **WXT:** are you attached to WXT (from ARCHITECTURE.md), or OK with plain Vite if the plan makes the case?
5. **`open_tab` / `switch_tab` activating tabs:** intended (the agent chose to go there), or should it follow the "never change your tab" rule? Not changing it now either way.
6. **Git identity:** commits used your global git config (your school email). Fine, or do you want a different name or email (for example GitHub's noreply address) before anything is pushed?

## 8. Your answers (2026-10-29) and what happened

1. Start fresh: loading `dist/` with a new extension ID is fine (MIGRATION_PLAN §6 suggests pinning the ID with a manifest key).
2. `siteOf`: fixed in v0.9.5 (shared hosting list; full Public Suffix List after the migration). The `read_url` redirect gap is documented in SECURITY.md and comes after the migration.
3. Timeouts: fixed in v0.9.5 (chat page reads and captures, `read_url`, web search; Stop works on the network ones).
4. Build tool: open; MIGRATION_PLAN recommends plain Vite.
5. Tabs: the agent opens and switches its own tabs in the background (v0.9.5).
6. Git identity: kept at first; before publishing (2026-10-31) the history was rewritten to your GitHub noreply address, and test data with your surname and school email was replaced with fictional values.
