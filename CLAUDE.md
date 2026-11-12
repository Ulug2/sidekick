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
- Version 0.9.6. TypeScript (`strict`), ES modules, built with Vite into `dist/`. Behavior is the same as the plain-JavaScript v0.9.5 (see `docs/MIGRATION_PLAN.md` and `docs/adr/`).
- Next (when Ulugbek says so): Phase F, the run-trace recorder and the real-site benchmark, then agent v2 (see `docs/PRODUCT_PLAN.md`, ARCHITECTURE.md "Target architecture").

## Layout
```
src/
  manifest.json          MV3 manifest, copied to dist/ as is (fixed "key" → fixed extension ID)
  pages/                 HTML entry points (built to the root of dist/: sidepanel.html, profile.html, …)
  background/            service worker: opens the panel, context menus (built to dist/background.js)
  content/               webmcp-capture.js: MAIN-world content script, copied byte for byte
  page/                  functions injected into web pages (snapshot, act, webmcp, read, region, …)
  core/
    llm/                 model calls: settings + model IDs, Claude Messages API, OpenAI Responses API, streaming, usage, prices
    storage/             schema.ts: one typed schema for every chrome.storage key, readLocal(); update.ts: locked read-modify-write
    security/            guard (redaction, untrusted fence, injection scan, stripWrappers), sites (siteOf: Public Suffix List), personal-data
    browser/             screen (captures, page reads with time limits), cdp (TrustedInput: debugger input)
    web/ docs/ calc/     read_url + search, PDF/DOCX text, calculator engine
  assistant/             chat brain: turn, routing, prompt, tools, types; review/ (math double-check); memory/, skills, session, profile-core
  agent/                 browser agent: loop/ (run, plan, tab group), perception/ (capture, format), actions/ (run-tool, input,
                         describe, replay), safety/gates, skills/ (shortcuts, site notes), trace/ (run traces), tools, prompt,
                         page-calls, types
  bench/                 real-site benchmark: tasks (the ten tasks, goals, automatic checks), results (records, scoring, spend)
  memory/                facts (fact store), answers (answer bank: resolve before ask_user, learn after), honesty (form answers vs profile)
  orchestrator/          v1 core (docs/ARCHITECTURE.md §3): types (WorkerTask, AutonomyLevel…), policy (one decide() for every
                         final action), workers (numbered runs + records), world (state from storage, world_query), brain
                         (typed rank/review calls), scheduler (chrome.alarms, persisted), log (action log), host (chrome adapter)
  ui/powerhouse/         the Powerhouse (Silicon City): scene (pure state → Scene), city-layout (pure numbers), city-view (renderer, loop, controls), city, case, robot, traffic, materials, powerhouse (page), voice (no-op hook)
  jobs/                  job pipeline (ADR-010): sources (job-board APIs), sponsors (UK register, USCIS H-1B), eligibility (rules in code),
                         store (job list, batch, CSV), scan, cover (student-voice letters), pdf, batch (judge a run), seed,
                         sponsorship (evidence + confidence), daily (8 AM batch, spread times), needs-you (cards, Save & resume)
  ui/                    sidepanel/ (sidepanel = entry and state, markdown, messages, chats, agent-card, bench-run, notify, icons),
                         profile/, options/, evals/, runs/ (Agent runs: replay, export), bench/ (Benchmark page), jobs/ (Jobs dashboard), mic/,
                         shared/ (page.css, dom.ts, meter.ts)
  types/globals.d.ts     vendored-library globals and test hooks
public/                  icons/, vendor/ (third-party libraries, pinned copies + licenses), copied as is
tests/
  jsdom/                 the jsdom suites (*-test.js), helpers.js, run-all.js
  chrome/                real Chromium with the built extension (real-chrome-test.js)
  unit/                  Vitest unit tests (import the TypeScript modules directly)
  fixtures/              real-site copies (airline.html, job.html), resumes (fictional), prompts.json
scripts/                 build-test.mjs (test bundles), check-build.mjs (checks dist/ after every build)
docs/                    product plan, architecture, lessons, security, adr/, archive/
```

## Commands
```
npm install
npx playwright install chromium      # once, for the real-Chrome suite
npm run build                        # typecheck, build dist/, check it (npm run dev: rebuild on change)
npm test                             # builds .test-build/, then all jsdom suites (about 680 checks, ~3 min)
node tests/jsdom/run-all.js forms safety   # selected suites
npm run test:unit                    # Vitest unit tests
npm run test:chrome                  # real Chromium with dist/ (about 85 checks; builds first); screenshots in .artifacts/shots
npm run lint                         # ESLint (typescript-eslint)
npm run check                        # all of the above
```
Load in Chrome: chrome://extensions → Developer mode → Load unpacked → `dist/` (after `npm run build`). After code changes: rebuild, reload the extension, reopen the side panel. The manifest has a fixed `key`, so the extension ID is always `nhnafciagehpkiaighdpmnahdacacnfj`.

How the jsdom suites work: `scripts/build-test.mjs` bundles the same modules into classic scripts in `.test-build/` (one per page plus `lib.js`); `tests/jsdom/helpers.js` `loadScripts(w, files, expose)` loads the bundle for the page those files belong to into a jsdom window and puts the requested names on `window`. Fakes for `chrome.*` and `fetch` (SSE streams from Claude/OpenAI) are in helpers.js. Fixtures reproduce real-site behavior. jsdom has no layout: tests stub `getBoundingClientRect`, `elementFromPoint`, and CSS clip. `prompts-test.js` compares every system prompt and tool definition with `tests/fixtures/prompts.json` (update it only for an intended prompt change: `UPDATE_PROMPTS=1 node tests/jsdom/prompts-test.js`).

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

## Security invariants (must never regress; tests in tests/jsdom/security-test.js, safety-test.js, tests/unit/security.test.ts)
- Everything from outside (pages, frames, search results, files, selections, site tools, snapshots, chat history given to the agent) is fenced with `untrusted()`; the fence can't be closed early by content.
- Replies can't load anything (no images/CSS/iframes; links open in a new tab; only http(s)/mailto).
- Never type passwords, card numbers, SSNs/government IDs, API keys; refuse secret-looking fields and values.
- Final actions (submit/send/pay/delete/post, Enter in bigger forms, non-read-only site tools) need approval, except submits on sites the user approved in a plan with "submit without asking" (never pay/delete/post).
- URLs carrying personal data, uploads to a new site, cross-site shortcut replay, sharing personal details with a new site (fast-model check that never sees page content), off-plan sites: all ask.
- `read_url` blocks private/loopback/link-local addresses; it follows redirects one hop at a time (target from `webRequest`) and checks each before requesting it; a public name answering from a private address isn't read.
- Learned data (shortcuts, site notes, skills) never stores what the user typed; web content can't create skills.
- Typed secrets in chat are masked before sending and before saving.

## Gotchas
- Functions in `src/page/` are passed to `chrome.scripting.executeScript({ func })`, which sends only the function's source text. They must not use anything outside their own body (no imports except `import type`, no outer helpers). `npm run build` fails if one does (`scripts/check-build.mjs`). They stay `func`-injected (not `files: [...]`) so they can take arguments and so nothing is left behind in the page's world (ADR-005).
- Modules don't share a global scope any more: a name used without an import resolves to the browser's global if one exists (`stop`, `close`, `status`, `name`, `open`, …) and silently does the wrong thing. ESLint flags those globals and `check-build.mjs` fails on any of our exported names used without an import (LESSONS 15). A module can't assign another module's `let`; export a setter (see `setAgentSignal`).
- `src/content/webmcp-capture.js` runs in the page's MAIN world at `document_start` and must add nothing to pages that don't use WebMCP (fingerprinting). It's plain JavaScript, copied byte for byte; never bundle it.
- Vendored libraries (`public/vendor/`) load as they did before: marked, DOMPurify, KaTeX, highlight.js by `<script vite-ignore>` tags; math.js, nerdamer, mammoth and pdf.js by URL at runtime. Don't bundle or upgrade them as part of other work.
- `chrome.sidePanel.open` only works inside a user gesture (call it before any await).
- The debugger's mouse input stalls in background tabs (checked in un-instrumented Chromium: clicks time out; typing, keys and CDP screenshots work); the agent falls back to page events (`viaTrusted`). Screenshots of background tabs are refused today rather than switching tabs. The agent's own tabs open in the background.
- Claude 5.x hides thinking unless asked: requests use `thinking: { type: "adaptive", display: "summarized" }`, with a fallback for models that reject it. Model IDs live in `DEFAULT_SETTINGS` in `src/core/llm/settings.ts`; don't change them without being asked.
- OpenAI calls use the Responses API with `store: false`; reasoning items are replayed with `encrypted_content`.
- Storage is `chrome.storage.local` (unencrypted, like every extension). Every key and its shape is in `src/core/storage/schema.ts`: settings fields, `profile`, `applications`, `memories`, `docIndex` + `doc:<id>`, `skills`, `userModel`, `adapters` (shortcuts), `siteNotes`, `chatIndex` + `chat:<id>`, `usage`, `evalRuns`, `traceIndex` + `trace:<id>` + `traceShot:<id>:<n>` (run traces), `benchRuns`, `benchParams`, `benchMaxCost`, `jobs`, `jobCompanies`, `sponsorLists`, `jobSettings`, `heldNotices` (notifications held in quiet hours); session storage: `pending`, `benchPending` (Benchmark page → panel), `jobBatch` + `jobBatchStop` (Jobs page → panel). Any read-modify-write goes through `updateLocal(key, fn)` or `withStorageLock(name, fn)` (`core/storage/update.ts`, a Web Lock shared by all pages); never read a list, await something, then `set` it. A function running under a lock must not take the same lock again (it would wait for itself): inside, write with plain `chrome.storage.local.set`.
- Benchmark runs spend the real API budget and use Ulugbek's accounts: Ulugbek runs them himself from `bench.html`; never start one (or drive his Chrome to) without asking. The page refuses to run with a model that has no price (the per-run dollar limit needs it).
- Models: every model ID lives in `src/core/llm/models.ts` (roles: brain, browser, writer, classifier…) and `prices.ts`; a lint rule and a unit test fail on an ID anywhere else. Spend caps (`capDaily` $1, `capMonthly` $25) are checked in `modelCall` before anything is sent (`core/llm/budget.ts`); unpriced models count at the highest known price.
- Autonomy: every final action (click, Enter-submit, upload, sharing details, visits, site tools) asks `orchestrator/policy.ts decide()`. An approved batch runs submits/uploads only on the job's own sites and application-system frames (`ATS_SITES`) on them; money/delete/post (`NEVER_AUTO`) and non-submitting write tools always ask; read-only refuses final actions. Never add a gate outside `decide()`.
- Phase 4 (jobs): `jobs/sponsorship.ts` gives each job evidence (source, date) and a confidence (confirmed / likely / unknown / no); only confirmed and likely are eligible. `jobs/daily.ts`: the service worker builds the 8 AM ET batch (code only) and notifies; "Approve & spread" gives each job a random time (`spreadTimes`) and an `apply:<id>` alarm; fired alarms are run by the side panel (`runDueApplications`). `jobs/needs-you.ts`: in an approved batch `ask_user` notifies, waits `needsYouWaitMinutes`, then saves the questions on the job (`job.needsYou`) and ends the run; Save & resume files answers in the answer bank and re-runs the job. `memory/honesty.ts` checks sponsorship / work-authorization / EEO values against the profile before any type/select/tick. Each application keeps `answers` (from the trace) and `shot` (`jobShot:<id>`).
- Phase 5 (pages): Settings sections are reached through `#sidenav` buttons (`setupNav` in `ui/options/options.ts`: aria-current, arrow keys, scroll marking); a new section needs a nav button with `data-target` and an `<h2 tabindex="-1">`. Settings → Jobs writes `jobSettings` with `updateLocal` (the Jobs page writes the same key: always merge, never write a whole copy). `jobSettings.regions` filters in `judgeJob`; `companyDays` goes to `pickBatch`. Background notifications pass a kind to `host.notify` (`needs_you`, `batch`, `due`); `allowNotify` / `quietEndsAt` decide; quiet hours keep them in `heldNotices` and the `notify-after-quiet` alarm shows them. Email settings (`email*`) are stored for Phase 8; nothing reads them yet. Spend meters: `ui/shared/meter.ts`.
- Phase 6 (Powerhouse, `powerhouse.html`): `ui/powerhouse/scene.ts deriveScene()` is the only place that maps state to poses (contract table in DESIGN.md §1); never draw a figure without a worker record. Brain calls must go through `trackBrain` (`orchestrator/activity.ts`; `askModel` does it for `role: "brain"`), workers through `startWorker`/`runAsWorker` (which write `lastShout`). `orchestrator.paused` is `"you"` or null (the runner waits while set); the spend cap is read live, never stored as a pause. The page draws with Three.js (`city-view.ts`, bundled into this page only); jsdom has no WebGL, so tests there check the no-WebGL note, the list, chip, line and drawer and real Chromium (launched with `--enable-unsafe-swiftshader`) checks the drawing; `#demo` shows every state without storage.
- Powerhouse = the Silicon City (`docs/powerhouse-redesign/`, built in milestones M0–M7 of 06-build-plan.md; DESIGN.md §1 says what was built and where it differs): `scene.ts` is now the city contract (`deriveScene(CityInput)`, `nextDeadline`; table-driven tests in `tests/unit/scene.test.ts`), `city-layout.ts` the pure numbers. Worker records count their steps (`steps`, bumped by `workerStep`) for the step pulses. The view is `city-view.ts` (renderer, loop, controls) + `city.ts` (the card city; static meshes merged per material by `mergeStatic`, keep draws < 200) + `materials.ts` (`windowMat` shader, registry for mood) (`#demo` adds the render meter); fonts Sora and JetBrains Mono are bundled in `public/vendor/fonts` (OFL) and must be loaded (`fontsReady`) before canvas text is drawn. `case.ts` (the PC case, no shadows). `robot.ts` (rig of merged vertex-coloured parts, 9 draws a robot; faces on a canvas; `lookFor`/`glowFor` pure; poses from a time t so a frozen t draws the same) and the rig pool, badges, picking and flights in `city-view.ts`; static shadow casters are baked into one invisible proxy (`bakeShadowProxy`). When the loop stops it draws one last frame (the still state).
- Answer once (v1 Phase 3, ADR-012): `src/memory/facts.ts` (typed facts: profile fields read through, plus `facts` for high school, graduation, visa status…) and `src/memory/answers.ts` (the answer bank). The agent's `ask_user` goes to `resolveQuestion()` first (code match, then one classifier call) and only the unanswered parts reach the UI; every answer is filed by `learnFromAnswer()`. Workers get facts + saved answers in their prompt. Memory page: `memory.html`. Sign-in/CAPTCHA questions skip memory.
- Memory: besides the end-of-chat reflection, `updateSessionNotesAndFacts` (one fast call per reply) returns lasting facts from the user's own words, saved at once (`chats.refreshNotes`); `factsFromAnswer` does the same for answers to the agent's `ask_user` (source "application"). Never from fenced content or the assistant's reply; `redactSecrets` applies.
- Jobs (ADR-010): applications go only through company career sites (never LinkedIn/Handshake/Indeed auto-apply); an approved batch pre-approves submits on each job's own site only; one application per company per 30 days; `CAPTCHA_RE` refuses human checks in code; cover letters must pass `voiceProblems` (student voice, no template phrases, no dashes); the batch runs on the fast tier (low effort) in its own unfocused Chrome window (`batchTab`) and stops at `jobSettings.monthlyCap`. Running a batch spends the real API budget and applies for real: Ulugbek starts it himself from `jobs.html`; never start one without asking.
- Run traces: `agent/trace` records an agent run as it happens; model calls are recorded through `watchModelCalls(signal)`, so any new model call inside a run must pass the run's signal (`state.signal`) to be counted. Prices live in `core/llm/prices.ts` (Claude 5.5 models, GPT-5.6 Luna/Terra; unknown models cost "unknown", never a guess).
- UI code (`src/ui`) looks elements up with `$` (returns `any`) and narrows DOM types with type-only assertions; the typed parts are the data (chats, settings, agent UI contract). Tighten it when a UI file is next changed for real.
