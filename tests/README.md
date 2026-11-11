# Sidekick tests

```
npm install
npx playwright install chromium          # once
npm test                                 # builds .test-build/, then every jsdom suite: one line each + total (about 628 checks)
node tests/jsdom/run-all.js forms e2e    # just some suites (run npm run build:test first if src/ changed)
npm run test:unit                        # Vitest unit tests (tests/unit)
npm run test:chrome                      # builds dist/, then real Chromium with the real extension (about 71 checks); screenshots in .artifacts/shots
```

## Layout
- `jsdom/`: the main suites (`*-test.js`), `helpers.js` (fakes and the loader), `run-all.js`.
- `chrome/real-chrome-test.js`: Playwright launches Chromium with `dist/` loaded, serves local test pages, fakes the model API at the network layer, checks real CSP, debugger input, tab groups, the fixed extension ID, and that nothing reaches outside servers.
- `unit/`: Vitest tests that import the TypeScript modules directly (start here for new pure-logic tests).
- `fixtures/`: real-site copies (`airline.html` = turkishairlines.com booking form, `job.html`), fictional resumes ("Jordan Example"), `prompts.json` (see below).

## How the jsdom suites work
- The extension is ES modules; `scripts/build-test.mjs` bundles the same modules into classic scripts in `.test-build/`: `lib.js` (everything except page UI) and one bundle per page (`sidepanel.js`, `profile.js`, …, each = lib + that page's folder). `helpers.js` `loadScripts(window, files, expose)` loads the vendor files listed, then the bundle for the page the list belongs to (a list containing `sidepanel.js` gets the panel bundle, and so on), and puts the `expose` names on `window`. Exported function declarations are on `window` too, except names the browser already has (`stop`, `close`…), as in the real panel.
- `srcPath(name)` finds a page, vendor file or the content script by its old flat name (`'sidepanel.html'`, `'vendor/marked.js'`, `'webmcp-capture.js'`).
- Fakes: `makeStore()` (chrome.storage), `sseResponse()` + `anthropicEvents(blocks)` / `openaiEvents({...})` (streaming model APIs: Claude Messages and OpenAI Responses), `checkerReply()` (the agent's safety check answers "ok" unless a test says otherwise). `engine-test.js` `prep(window)` adds the layout stubs jsdom lacks (`getBoundingClientRect`, `innerText`). Page scripts run in the page window from their `toString()`, like `executeScript({ func })` does.
- No suite calls a real model or a real website.
- `prompts-test.js` renders every system prompt and tool definition and compares them with `fixtures/prompts.json` character by character. After an intended prompt change: `UPDATE_PROMPTS=1 node tests/jsdom/prompts-test.js`, and review the diff.

## Suites
| Suite | Covers |
|---|---|
| bench | the Benchmark page: tasks, settings, Run hands the task to the panel, grading, score per version, results as text only, Run off for unpriced models |
| jobs | the Jobs page: sponsor lists (GOV.UK API + the two CSVs, faked), scanning two boards, eligible vs filtered with reasons, text-only titles, Keep anyway / Skip, Build today's batch (one per company), Approve & start (hand-off), Stop, statuses, CSV, add a company by link, the monthly limit |
| memory-answers | BUGS 1 regression: high school asked once, then answered from memory in other wordings (no UI), exact repeats matched in code, sign-in always asked; the Memory page edits facts and answers, refuses secrets |
| orchestrator | spend cap stops calls before sending, caps of 0, action log under concurrent writes, world state from storage |
| reading | pages inside a frame from another site (Moodle + MyOpenMath, copied from the 2026-11-09 run): read_text reads every frame and names the ones it can't, an empty page says so, identical buttons are grouped but not interchangeable |
| storage | writes don't lose each other: two pages saving memories, applications, skills, site notes, shortcuts, usage, benchmark runs and documents at once through the shared lock; the queue without Web Locks; a timed-out lock still saves; an error inside the lock runs once |
| traces | run traces: every step saved as it happens (prompt, reply, actions, approvals while waiting, screenshots, cost), stopped/failed/interrupted runs, last 30 kept, export masks secrets, import keeps only images, the Agent runs page shows everything as text (v0.9.6) |
| timeouts | chat page reads, screenshots, read_url and web search give up after a time limit and obey Stop (v0.9.5) |
| prompts | system prompts and tool definitions unchanged (fixtures/prompts.json) |
| scroll, region | chat auto-scroll; the area-capture overlay |
| forms | turkishairlines.com-style form (fixtures/airline.html): airport autocompletes, calendar date picker, multi-city rows (v0.9.4) |
| safety | ideas from Claude in Chrome: plan approval, action check, tab group, notifications, injection scan, hidden traps, site re-check (v0.9.3) |
| multitask | several tasks per run, no freezes, chat context, find / scroll all / web_search (v0.9.2) |
| fixes | the seven bugs of v0.9.1 (status/thinking, Lagrange DNE, new chat, tab switching, blocked frames, wrapper tags) |
| security | attacks on every trust boundary |
| hardening | fuzzed hostile replies and pages, property tests on the double-check, interruptions, stress, accessibility |
| phase3 | skills, code-checked voting, memory fields, export/import |
| sites | shortcuts, site notes, WebMCP, change-only snapshots, fill_fields, batching, Site skills page |
| verify | the math double-check pipeline |
| memory-session, brain, panel-v6, pages, v4, e2e, agent-cdp, engine, openai-profile | memory and pinned notes, chat brain, panel UI, extension pages, chat lifecycle, an end-to-end application, debugger input, page engine, OpenAI provider + profile |
| calc, numeric | calculator and numeric solving, run with eval disabled |
| docs | PDF and DOCX text extraction |
| real-chrome | the real extension in Chromium: CSP, debugger input, agent runs on local pages, tab groups, homework in a cross-site frame (read_text, zoom by pixel color, check before done), the application batch (Jobs page → panel, cover letter PDF received by the form, pre-approved submit, a sign-in set aside), nothing leaves the machine |

Unit tests (`unit/`): `security.test.ts` (redaction, the untrusted fence, wrapper stripping, siteOf (Public Suffix List), local addresses, personal data in URLs, skill text), `prices.test.ts` (dollars per call), `bench.test.ts` (benchmark tasks, checks, scoring, spend, CSV), `jobs.test.ts` (where a job is, who can sponsor it, the eligibility rules, job-board JSON → postings, the job list, today's batch, cover-letter voice checks, the hand-made PDF, judging an application run).
