# Sidekick tests

```
npm install
npx playwright install chromium   # once
npm test                          # every jsdom suite, one line each + total (about 546 checks)
node tests/run-all.js forms e2e   # just some suites
npm run test:chrome               # real Chromium with the real extension (about 55 checks); screenshots in .artifacts/shots
node tests/scroll-test.js         # chat auto-scroll behavior (prints true/false lines)
node tests/region-test.js         # area-capture overlay (prints true/false lines)
```

## How the jsdom suites work
- `helpers.js` `loadScripts(window, files, expose)` concatenates extension source files into one jsdom window, the same way the side panel's `<script>` tags share one global scope, then exposes chosen names to the test.
- Fakes: `makeStore()` (chrome.storage), `sseResponse()` + `anthropicEvents(blocks)` / `openaiEvents({...})` (streaming model APIs: Claude Messages and OpenAI Responses), `checkerReply()` (the agent's safety check answers "ok" unless a test says otherwise). `engine-test.js` `prep(window)` adds the layout stubs jsdom lacks (`getBoundingClientRect`, `innerText`).
- No suite calls a real model or a real website.

## Suites
| Suite | Covers |
|---|---|
| timeouts | chat page reads, screenshots, read_url and web search give up after a time limit and obey Stop (v0.9.5) |
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
| real-chrome | the real extension in Chromium: CSP, debugger input, agent runs on local pages, tab groups, nothing leaves the machine |

`math-test.js` is legacy (Chat Completions era) and not part of the run.
