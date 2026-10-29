# Sidekick: notes for Claude Code

Sidekick is Ulugbek's personal "Jarvis": a Chrome side-panel extension (Manifest V3) that knows him (profile, resume, memories), helps with homework (math with code-checked answers), tracks deadlines, applies to jobs, and can operate web pages (the browser agent). Later it becomes a Mac app (Electron + a Swift helper).

Read these first:
- `docs/PRODUCT_PLAN.md`: what's built, what's next, in what order.
- `docs/ARCHITECTURE.md`: how it works today, its known weaknesses, the target architecture, and the TypeScript migration plan.
- `docs/LESSONS.md`: every bug that reached the user, its root cause, and the rule that prevents it. Treat these rules as binding.
- `docs/SECURITY.md`: threat model and the protections that must never regress.

## About the user
- CS student at Gettysburg College. Knows TypeScript, React Native, Node/Express, Postgres/Supabase, Next.js. Doesn't know Swift.
- Wants things built and tested, not long explanations. When reporting: say plainly what broke and why, what you changed, and what was NOT tested with real accounts, real API keys, or real sites.
- Constraints: Chrome extension only for now; **API budget $10/month** (his own Anthropic/OpenAI key).
- For any failure on a real site, reproduce it on the real site first (he has Chrome; use Claude in Chrome or Playwright against the live page, read-only) before changing code.

## Status
- Version 0.9.5. Plain JavaScript, no build step, no modules: every script in a page shares one global scope (no duplicate top-level names across files loaded together).
- Planned next: organize the repo and migrate to TypeScript with a build (behavior-preserving), then rebuild the browser agent's perception/action layers (see ARCHITECTURE.md "Target architecture").

## Layout (current)
```
extension/            the unpacked extension (load this folder in chrome://extensions)
  manifest.json       MV3; side panel, debugger, scripting, tabs, tabGroups, notifications
  background.js       service worker: opens the panel, context menus (tiny)
  sidepanel.*         chat UI, agent cards, history, notes (all runtime logic is loaded here)
  ai.js               model calls: Claude Messages API + OpenAI Responses API, streaming, retries
  brain.js            chat turn: routing, tools, math double-check pipeline, review
  agent.js            browser agent loop, tools, safety gates, snapshots, learning
  page-agent.js       functions injected into pages (snapshot + actions); must stay self-contained
  cdp.js              chrome.debugger wrapper: trusted clicks/typing, screenshots, timeouts
  adapters.js         learned site shortcuts + site notes; personal-data detection
  guard.js            secret redaction, untrusted-content fencing, injection scan, output cleanup
  calc.js             calculator engine (math.js + nerdamer), scanCurve
  memory*.js, skills.js, session.js, profile-core.js, docs.js, web.js, screen.js
  profile.*, options.*, evals.*, mic.*   other extension pages
  vendor/             third-party libraries (pinned copies + licenses)
  webmcp-capture.js   MAIN-world content script (WebMCP tool capture)
tests/                jsdom suites (*-test.js), real-Chromium suite, fixtures, run-all.js
docs/                 product plan, architecture, lessons, security, research, user guide
```

## Commands
```
npm install
npx playwright install chromium      # once, for the real-Chrome suite
npm test                             # all jsdom suites (about 546 checks, ~3 min)
node tests/run-all.js forms safety   # selected suites
npm run test:chrome                  # real Chromium with the real extension (about 55 checks); screenshots in .artifacts/shots
```
Load in Chrome: chrome://extensions → Developer mode → Load unpacked → `extension/`. After code changes: reload the extension, then reopen the side panel.

How the jsdom tests work: `tests/helpers.js` `loadScripts()` concatenates extension files into one jsdom window (same as the side panel's `<script>` tags) and fakes `chrome.*` and `fetch` (fake SSE streams from Claude/OpenAI). Fixtures in `tests/fixtures/` (for example `airline.html`, a copy of turkishairlines.com's booking form) reproduce real-site behavior. jsdom has no layout: tests stub `getBoundingClientRect`, `elementFromPoint`, and CSS clip.

## Rules (from docs/LESSONS.md; follow them)
1. **Real site first.** Before fixing a site failure, look at the real page's markup and behavior, build a fixture that fails without the fix, then fix. Validate on the real site too.
2. **Every bug gets a regression test** that fails on the old code.
3. **Rules in code, not just the prompt.** If the model must never do X, enforce it in code (approval gates, loop limits, output stripping).
4. **Every outside await has a timeout and obeys Stop**: model streams (90 s silence → retry once), page scripts (15 s), debugger input (4 s).
5. **Save as you go.** Agent runs and chats are saved after every step, never only at the end.
6. **Never skip silently.** Anything Sidekick can't read or do (blocked frame, site, field) is reported with the site and a next step.
7. **Design for the long version of a task** (apply to 4 jobs, not 1; multi-city, not one-way).
8. **Status always visible.** Any step that can take more than about 2 s shows what it's doing.
9. **Strip internal markup at the output boundary** (`<untrusted_content>`, pipeline tags) in code.
10. **Test UI at real widths:** panel 340 to 420 px, half-screen about 760 px, full width. Light and dark.
11. **Budget:** fast model by default; smart model only when routed (math, agent); strongest model only for tie-breaks. Estimate cost per run for anything new.
12. **Say what wasn't tested** with real keys, real accounts, real sites.

## Security invariants (must never regress; tests in tests/security-test.js, safety-test.js)
- Everything from outside (pages, frames, search results, files, selections, site tools, snapshots, chat history given to the agent) is fenced with `untrusted()`; the fence can't be closed early by content.
- Replies can't load anything (no images/CSS/iframes; links open in a new tab; only http(s)/mailto).
- Never type passwords, card numbers, SSNs/government IDs, API keys; refuse secret-looking fields and values.
- Final actions (submit/send/pay/delete/post, Enter in bigger forms, non-read-only site tools) need approval, except submits on sites the user approved in a plan with "submit without asking" (never pay/delete/post).
- URLs carrying personal data, uploads to a new site, cross-site shortcut replay, sharing personal details with a new site (fast-model check that never sees page content), off-plan sites: all ask.
- `read_url` blocks private/loopback/link-local addresses and redirects into them.
- Learned data (shortcuts, site notes, skills) never stores what the user typed; web content can't create skills.
- Typed secrets in chat are masked before sending and before saving.

## Gotchas
- `page-agent.js` functions (`skPageSnapshot`, `skPageAct`, `skWebMCP*`) are passed to `chrome.scripting.executeScript({ func })`, which serializes the function's source. They must not reference anything outside their own body (no imports, no outer helpers). In a TS build, bundle them as separate self-contained scripts and inject with `files: [...]`, or keep them closure-free.
- `webmcp-capture.js` runs in the page's MAIN world at `document_start` and must add nothing to pages that don't use WebMCP (fingerprinting).
- `chrome.sidePanel.open` only works inside a user gesture (call it before any await).
- The debugger's input commands can stall in background tabs; the agent falls back to page events (`viaTrusted`). Screenshots of background tabs are refused rather than switching tabs.
- Claude 5.x hides thinking unless asked: requests use `thinking: { type: "adaptive", display: "summarized" }`, with a fallback for models that reject it. Model IDs live in `DEFAULT_SETTINGS` in `extension/ai.js`; don't change them without being asked.
- OpenAI calls use the Responses API with `store: false`; reasoning items are replayed with `encrypted_content`.
- Storage is `chrome.storage.local` (unencrypted, like every extension). Keys: settings fields, `profile`, `memories`, `skills`, `adapters`, `siteNotes`, `chatIndex`, `chat:<id>`, `documents`, `applications`, `usage`, `evalRuns`, `userModel`.
