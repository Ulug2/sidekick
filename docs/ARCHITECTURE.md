# Sidekick architecture

Status: v0.9.4 (2026-10-29). This document has four parts: how it works today, what's wrong with it, the target architecture, and the migration plan to get there.

---

## 1. How it works today

### Runtime contexts (Chrome MV3)

| Context | Files | What runs there |
|---|---|---|
| Service worker | `background.js` | Opens the side panel on toolbar click; context menus ("Rewrite with Sidekick", "Ask Sidekick"); first-install onboarding. Nothing else (no alarms yet). |
| Side panel page | `sidepanel.html` loads ~20 scripts | **All runtime logic**: chat, model calls, math pipeline, browser agent, memory, learning. The agent only runs while the panel is open. |
| Injected into web pages | `page-agent.js` functions via `chrome.scripting.executeScript({ func })`; `screen.js` readers | Snapshots of interactive elements, actions (click, type, select, pick_date, upload), page text. ISOLATED world; WebMCP calls in MAIN world. |
| Content script, MAIN world, `document_start` | `webmcp-capture.js` | Captures tools a site registers with `navigator.modelContext` (WebMCP). Inert on pages without WebMCP. |
| Debugger (CDP) | `cdp.js` | Real (trusted) mouse/keyboard input, screenshots, layout metrics. 4 s timeout per command. |
| Other pages | `profile.*`, `options.*`, `evals.*`, `mic.*` | Profile/resume/memories/skills/site skills editor; settings; eval runner; microphone permission. |

All side-panel scripts share one global scope (plain `<script>` tags, no modules, no build).

### Modules (lines at v0.9.4)

| File | Lines | Role |
|---|---|---|
| sidepanel.js | 2062 | Chat UI, streaming render (marked + DOMPurify + KaTeX), thinking/status line, agent run cards, plan approval card, notifications, history, pinned notes, voice, attachments, area capture |
| agent.js | 1381 | Agent loop, tool definitions, system prompt, snapshot formatting (full vs. change-only), safety gates, plan/checklist, action check, tab group, learning shortcuts/site notes |
| brain.js | 987 | Chat turn: system prompt, context block, routing (fast/smart/best), chat tools, math double-check pipeline (verify, arbitrate, confirm, tie-break, completeness), skills/memory tools |
| page-agent.js | 830 | `skPageSnapshot` (elements with roles, labels, questions, sections, row context, traps), `skPageAct` (click, type, select_option with fuzzy/typed autocomplete, pick_date calendar, upload, keys, scroll all), WebMCP list/call |
| calc.js | 565 | Calculator engine: math.js + nerdamer, numeric solving, `scanCurve` for constrained extrema |
| ai.js | 501 | Settings, model selection, `modelCall` for Claude (Messages API, adaptive thinking, prompt caching) and OpenAI (Responses API, store:false), streaming, stall watchdog, usage tracking |
| evals.js | 401 | Live eval cases (math, memory, guardrails, persona) |
| adapters.js | 322 | Learned site shortcuts (compiled from successful runs, value-free), site notes, `siteOf`, `personalDetailsIn` |
| memory.js / memory-io.js | 242 / 129 | Long-term memories (due/status/origin), retrieval, Markdown export/import |
| session.js | 215 | Pinned notes per chat, end-of-chat reflection (memories, skills) |
| screen.js | 134 | Screenshots, page text, problem text across frames, blocked-frame reporting |
| skills.js | 127 | Procedural memory: skill index, matching, use_skill |
| profile-core.js | 99 | Profile schema, profile → prompt, applications log |
| web.js | 97 | read_url (SSRF-guarded), keyless web search fallback |
| cdp.js | 85 | TrustedInput (debugger) with timeouts |
| guard.js | 83 | Secret redaction, `untrusted()` fencing, injection scan, `stripWrappers` |
| docs.js | 70 | Document store for syllabi/notes |

### Main flows

**Chat turn:** `sidepanel.send()` → `brain.runTurn()` builds system prompt + context block (date, tab, pinned notes, relevant memories, matched skill) → routes to a tier → `ai.modelCall()` streams text and summarized thinking → tool calls (calculate, web_search, read_url, read_page, remember, use_skill, operate_browser) → for math: `reviewAnswer()` (independent checker; code compares objective/residuals; completeness check; tie-break on the strongest model) → render, save, refresh pinned notes.

**Agent run:** `sidepanel.sendAgent()` passes the chat history (fenced) → `agent.runAgent()`:
1. Snapshot (`captureTab`, all frames) → `formatSnapshot` (full, or only changes since the last full one; repeated buttons grouped; site tools, shortcuts and notes; blocked frames; hidden traps).
2. Model (smart tier, parallel tool calls allowed) → tool calls.
3. `runTool` → gates in order: never-act sites → site re-check (tab moved?) → personal-data sharing check (fast model) → per-tool approvals (final actions, uploads, risky URLs, off-plan sites) → action via CDP (trusted) or page events (fallback) → snapshot.
4. Plan/checklist with approval; nudges when the model stops early; step budget 40 + 30 per extra task.
5. At the end: learn a shortcut and site notes (value-free).

**Learning:** end-of-chat reflection writes memories and skills (never from web content); agent runs compile shortcuts.

### Storage (`chrome.storage.local`)
Settings fields (see `DEFAULT_SETTINGS`), `profile`, `memories`, `skills`, `adapters` (shortcuts), `siteNotes`, `chatIndex` + `chat:<id>`, `documents`, `applications`, `usage`, `evalRuns`, `userModel`. Session storage: `pending` (context-menu hand-off).

### Tests
- `tests/*-test.js`: jsdom suites that load the real extension files into a fake window with fake `chrome.*` and fake model streams (about 530 checks).
- `tests/real-chrome-test.js`: Playwright launches Chromium with the real extension, serves local test pages, fakes the model API at the network layer, and checks real CSP, real debugger input, tab groups, and so on (about 54 checks). It asserts nothing reaches outside servers.
- Fixtures reproduce real sites (`fixtures/airline.html` = turkishairlines.com booking form).
- Missing: a benchmark on **real** sites with a **real** model, and run traces from real use.

---

## 2. What's wrong with it (honest)

1. **The agent can't reliably find and use controls on real sites.** Evidence: the Turkish Airlines runs (LESSONS 11 and the 2026-10-29 run): 60 steps, repeated guessed coordinates outside the viewport, stuck behind a pop-up, a wrong click on "Award ticket - Buy a ticket with Miles".
   - Perception is home-grown: CSS selectors plus heuristics decide what's interactive, what its name is, and whether it's visible. It misses things Chrome itself knows (computed accessibility names, what's actually on top, popovers, cross-origin frames).
   - The model sees two representations that don't line up: a numbered text list and an unmarked screenshot. When the list is unclear, it falls back to guessing pixel coordinates, the least reliable thing it does.
   - Rules ("use ids", "deal with the pop-up first", "don't repeat a failing action") live in the prompt, and the model ignores them under pressure.
2. **No observability.** A failed real run leaves only a list of step titles. Debugging is guesswork.
3. **Tests prove the fixtures, not reality.** Every version passed its suites and still failed on real sites.
4. **Codebase shape.** One global scope, no types, `sidepanel.js` and `agent.js` over 1,000 lines each, prompt text mixed with logic.
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

### Open decisions (write these up as ADRs in docs/adr/)
- **ADR-001: build our own agent core, or fork Nanobrowser** (Apache-2.0 Chrome extension agent: TypeScript, WXT, chrome.debugger, planner/navigator, multi-provider). Run the same 10 benchmark tasks on both; adopt their core if clearly better, and put Sidekick's personal layer (profile, memory, homework, deadlines, applications) on top.
- **ADR-002: build tooling.** WXT (extension framework on Vite: manifest generation, HMR, multiple entry points) vs. plain Vite + a manifest plugin. Leaning WXT.
- **ADR-003: perception source.** CDP accessibility tree + DOMSnapshot (needs the debugger attached; shows Chrome's yellow "debugging" bar) vs. an improved in-page walker (no bar, but no cross-origin frames). Likely CDP with the in-page walker as fallback.
- **ADR-004: UI.** Keep vanilla TS DOM code vs. move the side panel to React (the user knows React; the current UI works).

---

## 4. Migration plan (behavior-preserving)

Goal: the same extension, organized and typed, with all tests green after every step. **No new features during the migration.**

0. **Baseline.** `npm install`, `npm test` (about 530 checks green), `npm run test:chrome` (54). Commit the baseline (local git).
1. **Tooling.** Add TypeScript (`strict`, `allowJs` during the transition), the bundler (ADR-002), ESLint/Prettier, a build to `dist/` that Chrome can load. CI script: typecheck + unit + e2e.
2. **Make the tests target the build.** The jsdom suites concatenate source files today (`tests/helpers.js loadScripts`). Point them at bundled output (or expose a test entry that sets the same globals), so they keep working while files move. Then port suites to Vitest gradually.
3. **Modules.** Replace the shared global scope with explicit imports/exports. Move files into `src/` following the target layout. Keep names and behavior.
4. **Convert to `.ts`**, leaves first: guard, profile-core, adapters, calc, memory, skills, session, web, docs, screen, ai, cdp, page scripts, agent, brain, sidepanel. Add types for storage (schema), messages, model calls, tool calls, snapshots.
5. **Page scripts.** Bundle `page-agent` and friends as separate self-contained scripts; inject with `files: [...]`. Keep `world: "MAIN"` where it's used.
6. **Docs.** Update this file, CLAUDE.md, tests/README.md. Record decisions in `docs/adr/`.
7. **Then (separate project):** trace recorder → real-site benchmark → agent v2 (ADR-001 decides build vs. fork).
