# Sidekick architecture

Status: v0.9.6, TypeScript (2026-10-29; v0.9.6 2026-10-31: read_url checks each redirect). This document has four parts: how it works today, what's wrong with it, the target architecture, and the migration (done; see §4).

---

## 1. How it works today

### Runtime contexts (Chrome MV3)

| Context | Files | What runs there |
|---|---|---|
| Service worker | `src/background/background.ts` → `dist/background.js` | Opens the side panel on toolbar click; context menus ("Rewrite with Sidekick", "Ask Sidekick"); first-install onboarding. Nothing else (no alarms yet). |
| Side panel page | `src/pages/sidepanel.html` → `src/ui/sidepanel/sidepanel.ts` (imports everything else) | **All runtime logic**: chat, model calls, math pipeline, browser agent, memory, learning. The agent only runs while the panel is open. |
| Injected into web pages | `src/page/*` via `chrome.scripting.executeScript({ func })` | Snapshots of interactive elements, actions (click, type, select, pick_date, upload), page text, area picking. ISOLATED world; WebMCP calls and the leave-prompt disarm in MAIN world. |
| Content script, MAIN world, `document_start` | `src/content/webmcp-capture.js` (copied as is) | Captures tools a site registers with `navigator.modelContext` (WebMCP). Inert on pages without WebMCP. |
| Debugger (CDP) | `src/core/browser/cdp.ts` | Real (trusted) mouse/keyboard input, screenshots, layout metrics. 4 s timeout per command. |
| Other pages | `src/pages/{profile,options,evals,mic}.html` → `src/ui/<page>/` | Profile/resume/memories/skills/site skills editor; settings; eval runner; microphone permission. |

ES modules, bundled by Vite into `dist/` (ADR-002). One typed storage schema: `src/core/storage/schema.ts`.

### Modules (lines at v0.9.5)

| Folder | What's there |
|---|---|
| `core/llm` (≈600) | `settings` (defaults, model IDs, provider/model choice), `call` (`modelCall` with the stall watchdog; `watchModelCalls` for traces), `anthropic` (Messages API, adaptive thinking, caching), `openai` (Responses API, store:false), `sse`, `usage`, `prices` (dollars per call), `types` |
| `core/security` (≈220) | `guard` (redaction, `untrusted()` fence, injection scan, `stripWrappers`), `sites` (`siteOf`, shared hosting list), `personal-data` (`personalDetailsIn`, profile values) |
| `core/browser`, `core/web`, `core/docs`, `core/calc` | page reads and captures with time limits, `TrustedInput`; `read_url` (SSRF-guarded) and keyless search; PDF/DOCX text; the calculator (math.js + nerdamer, `scanCurve`) |
| `core/storage/schema.ts` | every chrome.storage key and its type; `readLocal()` |
| `assistant` (≈1,700) | `turn` (one chat turn, tool loop), `routing`, `prompt`, `tools` (chat tools), `review/` (math double-check: `parse`, `check`, `review`), `memory/` (memories, documents, Markdown export/import), `skills`, `session` (pinned notes, end-of-chat reflection), `profile-core` |
| `agent` (≈1,900) | `loop/run` (the loop, budgets, nudges), `loop/plan`, `loop/tab-group`, `perception/capture` + `format` (full or change-only snapshots), `actions/run-tool` (gates then action), `actions/input` (page events or debugger), `actions/describe`, `actions/replay`, `safety/gates`, `skills/shortcuts` + `site-notes`, `trace/trace` + `trace/store` (run traces), `tools` (tool schemas), `prompt`, `page-calls`, `types` |
| `page` (≈850) | `snapshot`, `act`, `webmcp`, `read`, `region`, `replace-selection`, `leave-prompt`: self-contained, checked by `scripts/check-build.mjs` |
| `bench` | the real-site benchmark: `tasks` (ten tasks: start page, goal, settings, automatic checks), `results` (run records, scoring per version, month spend, CSV) |
| `ui` (≈2,700) | `sidepanel/` (entry + state, `markdown`, `messages`, `chats`, `agent-card`, `notify`, `icons`), `profile/`, `options/`, `evals/`, `runs/` (Agent runs: replay, export, import), `bench/` (Benchmark page; the panel side is `sidepanel/bench-run`), `mic/`, `shared/` |

### Main flows

**Chat turn:** `ui/sidepanel` `send()` → `assistant/turn` `runTurn()` builds system prompt + context block (date, tab, pinned notes, relevant memories, matched skill) → routes to a tier (`assistant/routing`) → `core/llm` `modelCall()` streams text and summarized thinking → tool calls (calculate, web_search, read_url, read_page, remember, use_skill, operate_browser) → for math: `reviewAnswer()` (independent checker; code compares objective/residuals; completeness check; tie-break on the strongest model) → render, save, refresh pinned notes.

**Agent run:** `ui/sidepanel` `sendAgent()` passes the chat history (fenced) → `ui/sidepanel/agent-card` `runAgentCard()` → `agent/loop/run` `runAgent()`:
1. Snapshot (`captureTab`, all frames) → `formatSnapshot` (full, or only changes since the last full one; repeated buttons grouped; site tools, shortcuts and notes; blocked frames; hidden traps).
2. Model (smart tier, parallel tool calls allowed) → tool calls.
3. `runTool` → gates in order: never-act sites → site re-check (tab moved?) → personal-data sharing check (fast model) → per-tool approvals (final actions, uploads, risky URLs, off-plan sites) → action via CDP (trusted) or page events (fallback) → snapshot.
4. Plan/checklist with approval; nudges when the model stops early; step budget 40 + 30 per extra task.
5. At the end: learn a shortcut and site notes (value-free).
6. Throughout: the run's trace (`agent/trace`) records each step before the model call (page, screenshot, prompt), the model's reply and every model call made with the run's Stop signal (cost from `core/llm/prices`), each action and result, and approvals while they wait. Saved after every change; replayed on `runs.html`.

**Learning:** end-of-chat reflection writes memories and skills (never from web content); agent runs compile shortcuts.

### Storage (`chrome.storage.local`)
All keys and their types: `src/core/storage/schema.ts`. Settings fields (`DEFAULT_SETTINGS`), `profile`, `applications`, `memories`, `docIndex` + `doc:<id>`, `skills`, `userModel`, `adapters` (shortcuts), `siteNotes`, `chatIndex` + `chat:<id>`, `usage`, `evalRuns`, `traceIndex` + `trace:<id>` + `traceShot:<id>:<n>` (run traces, last 30), `benchRuns`, `benchParams`, `benchMaxCost`. Session storage: `pending` (context-menu hand-off), `benchPending` (Benchmark page → panel, taken under a Web Lock so only one panel runs it).

### Tests
- `tests/jsdom/*-test.js`: jsdom suites that load test bundles of the same modules into a fake window with fake `chrome.*` and fake model streams (about 580 checks; ADR-006). `prompts-test` pins every prompt and tool definition.
- `tests/unit/*.test.ts`: Vitest unit tests on the TypeScript modules.
- `tests/chrome/real-chrome-test.js`: Playwright launches Chromium with the built extension (`dist/`), serves local test pages, fakes the model API at the network layer, and checks real CSP, real debugger input, tab groups, the fixed extension ID, and so on (about 56 checks). It asserts nothing reaches outside servers.
- Fixtures reproduce real sites (`fixtures/airline.html` = turkishairlines.com booking form).
- Missing: a benchmark on **real** sites with a **real** model (Phase F item 4; run traces now record what such runs do).

---

## 2. What's wrong with it (honest)

1. **The agent can't reliably find and use controls on real sites.** Evidence: the Turkish Airlines runs (LESSONS 11 and the 2026-10-29 run): 60 steps, repeated guessed coordinates outside the viewport, stuck behind a pop-up, a wrong click on "Award ticket - Buy a ticket with Miles".
   - Perception is home-grown: CSS selectors plus heuristics decide what's interactive, what its name is, and whether it's visible. It misses things Chrome itself knows (computed accessibility names, what's actually on top, popovers, cross-origin frames).
   - The model sees two representations that don't line up: a numbered text list and an unmarked screenshot. When the list is unclear, it falls back to guessing pixel coordinates, the least reliable thing it does.
   - Rules ("use ids", "deal with the pop-up first", "don't repeat a failing action") live in the prompt, and the model ignores them under pressure.
2. **No observability.** A failed real run leaves only a list of step titles. Debugging is guesswork.
3. **Tests prove the fixtures, not reality.** Every version passed its suites and still failed on real sites.
4. **Codebase shape** (fixed by the migration: modules, strict TypeScript, files split by concern; UI code is still loosely typed, ADR-008).
5. **The agent lives in the panel.** Close the panel and the run dies; nothing can run on a schedule (Phase 4 needs the service worker or an offscreen document).
6. **Cost.** Long runs with screenshots on the smart model can cost $0.50 to $2; at $10/month that's few runs.

---

## 3. Target architecture

```
src/
  core/
    llm/          provider adapters (Claude, OpenAI), streaming, stall watchdog, cost meter, prompt caching
    storage/      typed schema + migrations for chrome.storage
    messaging/    typed messages between panel, service worker, offscreen doc, page scripts
  assistant/      chat brain: routing, tools, math pipeline (verify/arbitrate/confirm), memory, skills, session notes
  agent/
    perception/   page model from Chrome: CDP Accessibility.getFullAXTree + DOMSnapshot (boxes, paint order,
                  visibility, occlusion), all frames incl. cross-origin (Target.setAutoAttach), stable ids per run
                  (backendNodeId), set-of-marks screenshot (numbered boxes matching the ids), viewport-first ordering,
                  pop-ups/dialogs on top, change-only diffs
    actions/      deterministic, no AI: click/type/select/pick_date/upload/scroll/keys by id. Preconditions
                  (visible, enabled, not covered, in viewport; scroll if needed), trusted input via CDP, then
                  verify an effect (value changed, dialog opened, navigation) and return a typed result
    loop/         planner (smart model, few calls) + executor (cheap model, per step), task state machine
                  (subgoals), budgets, loop detection in code (same failure twice → replan), pop-up handling
                  policy, plan approval, checklist, nudges
    safety/       gates (approvals, never-act, sharing check, off-plan), injection scan, secret refusal
    skills/       site skills: recorded flows (record-a-workflow) and learned shortcuts, replayed without AI
  trace/          per-run recorder: observation, screenshot, model call, action, result, timing, cost;
                  export as a zip; replay viewer page; a failed trace becomes a regression fixture
  background/     service worker: alarms, notifications, reminders, morning brief (Phase 4); runs that outlive the panel
  ui/
    sidepanel/ profile/ options/   (TypeScript first; React later only if it pays off)
  page/           self-contained scripts injected into pages (bundled separately, injected with files: [])
tests/
  unit/           Vitest (jsdom) per module
  e2e/            Playwright with the built extension, local fixtures, faked model
  bench/          real-site, real-model benchmark (run manually on the Mac; scores tracked over time)
```

### Agent v2 in one paragraph
Each step, perception produces one observation: the visible part of the page as a list of elements with stable ids, names from Chrome's accessibility tree, state, and position, with dialogs and pop-ups first, plus a screenshot with the same ids drawn on it. The executor model answers with actions on ids only. The action layer checks preconditions, performs the action with real input, waits for the page to settle, and reports what changed. Code, not the prompt, enforces policies: a pop-up blocking the target is handled first; the same failing action twice triggers a replan by the planner model; coordinate clicks are allowed only on a zoomed crop and only after id-based actions fail. Every step is written to the trace.

### Decisions (docs/adr/)
- **ADR-001 (open): build our own agent core, or fork Nanobrowser** (Apache-2.0 Chrome extension agent: TypeScript, chrome.debugger, planner/navigator, multi-provider). Run the same 10 benchmark tasks on both; adopt their core if clearly better, and put Sidekick's personal layer (profile, memory, homework, deadlines, applications) on top.
- **ADR-002: build tooling.** Decided: plain Vite with a hand-written manifest (not WXT).
- **ADR-003 (open): perception source.** CDP accessibility tree + DOMSnapshot (needs the debugger attached; shows Chrome's yellow "debugging" bar) vs. an improved in-page walker (no bar, but no cross-origin frames). Likely CDP with the in-page walker as fallback.
- **ADR-004: UI.** Decided: keep vanilla TS DOM code for now.
- **ADR-005 to 008** (migration): page functions stay `func`-injected and checked; test bundles; fixed extension key; strictness rules.

---

## 4. Migration (done, 2026-10-29)

The same extension, organized and typed, with all tests green after every step (details and deviations: `docs/MIGRATION_PLAN.md`, decisions: `docs/adr/`).

1. ES modules + Vite build to `dist/`, test bundles for the jsdom suites, fixed extension ID.
2. Folders (`src/`, `public/`, `tests/jsdom|chrome|unit`).
3. Injected functions moved to `src/page/`, checked on every build.
4. TypeScript, `strict`, types for storage, model calls, tool calls, page snapshots and actions, agent state, chat turns.
5. Big files split by concern (agent, brain, side panel, adapters, model layer); prompts pinned by `prompts-test`.
6. Lint (typescript-eslint + restricted globals), Vitest, `npm run check`.

Next (separate project): trace recorder → real-site benchmark → agent v2 (ADR-001 decides build vs. fork).
