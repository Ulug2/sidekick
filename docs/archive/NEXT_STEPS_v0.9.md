# Sidekick: next steps (master plan, updated 2026-10-28)

Constraints: Chrome extension only (for now) · $10/month API budget · goals: homework help, assignment reminders, job applications, screen watching for deadlines.
Research behind this plan: RESEARCH_NOTES.md.

## Phase 1 — v0.7.3: fix the double-check ✅ DONE (2026-10-28; tested in jsdom, not yet with real keys)
Target answer for the pipeline problem: x = 18/sqrt(19) ≈ 4.1295, y = 18/sqrt(205) ≈ 1.2572, min cost ≈ 423.51.
The checker's wrong answer (0.9052, 0.4352) costs ≈ 449.73.
Root cause: brain.js ~L464 trusts the checker blindly; sidepanel.js ~L1271 re-renders the whole message; the verdict parser reads "not correct" as correct.
1. Evidence-based override: only replace when the checker's own calc succeeded. Optimization → compare the objective at both answers; equations → compare residuals. Never override on errors or hedges.
2. Tie-break: if undecided, a third independent solve on the strongest model; if still undecided, show both with a warning.
3. UX: show the correction as a labeled block with the original collapsed; for "just the answer", hold the answer until the check finishes.
4. Read page text + screenshot together; show the setup collapsed; escalate screenshot word-problem math to the strongest model.
5. Tests/evals where the checker is wrong and must not override (incl. this pipeline problem).

## Phase 2 — Smarter, faster agent on websites ✅ DONE in v0.8 (2026-10-28; tested in jsdom, not in real Chrome)
6. Learned site adapters: the first run on a site uses the smart model; Sidekick then compiles what worked into tools (e.g. myopenmath.getQuestion / submitAnswer, greenhouse.fillApplication) backed by selectors and steps. Replays cost $0; the AI only steps in to patch when a selector breaks.
7. Three-tier site access: (1) the site's own WebMCP tools (navigator.modelContext) → (2) a learned adapter → (3) fallback to the numbered snapshot + screenshot.
8. Faster page view: send only what changed between steps, collapse repeated items into tables, batch actions ("fill these 12 fields" in one call), cheap model executes / smart model plans.
9. Lean on the accessibility tree (roles, labels, states) for structure on sites without WebMCP.

What shipped, and how it differs from the plan:
- 6 → adapters.js: shortcuts compiled from successful runs (role/label/question targets, {{profile}} values, never typed text); use_shortcut replays through the normal tools (same safety rules), stops for judgment/final steps and on any mismatch. Plus Hermes-style site notes from runs with problems (fast model, value-free step list).
- 7 → site_tool (WebMCP imperative tools via webmcp-capture.js in the page's MAIN world, and declarative <form toolname>) → use_shortcut → snapshot agent.
- 8 → change-only snapshots against the last full one (full again on a new page or a big change), repeated buttons grouped, fill_fields, several calls per turn (parallel tool use on for the agent only). "Cheap model executes" became "no model at all" for replayed steps.
- 9 → done in-page from ARIA (section headings, aria-describedby hints, selected/pressed/current). Not done: Chrome's computed accessibility tree via the debugger (Accessibility.getPartialAXTree) for unlabeled elements — worth adding if real sites show many unlabeled controls.
Open questions for real-world testing: WebMCP API names may change (Chrome 146 flag preview; the capture only wraps tools registered after it loads); real Greenhouse/Workday markup; how often shortcuts stop on "couldn't find".

## Phase 3 — Learns and remembers ✅ DONE in v0.9 (2026-10-28)
10. Skills (procedural memory): auto-write/patch skills after a correction, an error recovery or a hard task (5+ tool calls). Names in the prompt, full text loaded on demand. Examples: MyOpenMath optimization recipe, MATH 211 answer format, Greenhouse flow.
11. Verified math by voting: 2–3 independent solves, each produces a calculator program; vote only among program-confirmed answers; compare objective/residual. Hard problems only (budget).
12. Memory upgrades: status, due date, source URL and stated-vs-inferred on each memory; background reflection on the smart model; export/import as readable Markdown files (ports to the Mac app).

Phase 3 notes: skills.js (procedural memory: names in the prompt, best match's steps in the context, use_skill tool, learned at end-of-chat review, never from web content, editable on the profile page); confirmAnswer() code-checks each candidate against its own setup and only confirmed answers vote; memories have due/status/origin/url, upcoming deadlines always in context; memory-io.js exports/imports one Markdown file.

## Testing and security pass ✅ (2026-10-28) — see SECURITY.md
Fixed: zero-click image/CSS leaks in replies, links hijacking the panel, URL exfiltration (navigate/read_url), site tools sending personal data, cross-site shortcut replay, resume upload to any site, SSRF gaps (172.16/12, .local, redirects), typed secrets reaching the API and chat history, WebMCP capture fingerprinting and its load-time race (found only in real Chrome), "0.1" site names for IPs, radio steps without their question, consent checkbox given a heading as its question, narrow-panel tables, missing lang attributes.
Suites: 420 jsdom checks + 36 real-Chromium checks (real extension, real CSP, real debugger input).

## v0.9.1 bug-fix pass ✅ (2026-10-28) — see LESSONS.md
Fixed the 7 bugs from real use: live status + visible thinking; Lagrange max/min with a DNE part (scanCurve, completeness check); profile section menu overlapping at half width; new chat on every open (auto-saved on close/reload); agent breaking when you switch tabs; MyOpenMath-in-Moodle frames and math boxes (blocked frames now reported); `<untrusted_content>` tags in replies. Regression suite: fixes-test.js (31) + 6 real-Chrome checks.
Still to verify with your account: MyOpenMath inside Moodle in your real Chrome (whether Chrome lets Sidekick into the frame depends on Site access), thinking summaries with your real key.

## v0.9.2 agent pass ✅ (2026-10-28) — see LESSONS.md 8–10
Multi-task runs with a checklist (plan tool, bigger step budget, keeps going after each submit), no more freezes (timeouts on page calls and the AI stream, Stop always works, "Leave site?" switched off when the agent leaves a page), saved as it goes, chat context for Agent mode, find / scroll "all" / web_search. Tests: multitask-test.js (29) + real-chrome 12 (5).
Still to verify with real sites: Ashby/Greenhouse multi-application run end to end with your account; how often the model needs the "keep going" nudge (each one costs a model call).

## v0.9.3 ideas from Claude in Chrome ✅ (2026-10-28) — see RESEARCH_NOTES.md
1. Notifications when the agent needs your OK, has a question, or finishes (only when you're not looking at the panel).
2. The agent's tabs in an orange "Sidekick" tab group (✓ when done).
3. Approve the plan once: several tasks → one card with the tasks and sites; optional "submit without asking" (never payments, deleting, posting); other sites still ask.
4. Safety check by the fast model before going to a new site or typing your details on a new site; it sees only your words and the step, never the page; flagged → you decide.
5. Free local injection scan on everything Sidekick reads (warning outside the fence), fields hidden from people left out, site re-checked right before every action.
Tests: safety-test.js (34) + real-chrome 13 (5).

## v0.9.4 forms pass ✅ (2026-10-29) — see LESSONS.md 11
Autocomplete matching by code/wording from the field's own list, typing to filter; pick_date for calendars (auto-opened calendars, month navigation, next-year dates); row context for repeated fields; better click_at advice. Verified on the real turkishairlines.com (all three legs filled by Sidekick's page code). Tests: forms-test.js (12) + real-chrome 14.
Next for travel: compare results across pages (the multi-city results show one flight at a time after you pick the previous leg), price calendars ("cheapest day" views).

## Phase 4 — Proactive
13. Assignment reminders: read due dates from Moodle/MyOpenMath pages you visit (local parsing, no AI), store as tasks, chrome.alarms + chrome.notifications.
14. Cheap screen watching: on page load, extract text locally, detect dates/"due"/deadlines with rules, call the fast model only on candidates. Never-watch site list + pause toggle.
15. Morning brief: a short, finite list when the browser opens (due soon, unfinished tasks, application statuses).
16. Personal search: search across sites you're logged into (Moodle, Handshake) plus memories, documents and past chats.
16a. Record a workflow (from Claude in Chrome): you do a flow once (MyOpenMath submit, Moodle upload, a Handshake application) while Sidekick watches your clicks and typing in the page; it compiles them into a shortcut with the existing adapter compiler (labels/roles, profile fields, never typed values), you review and name it, and it can be replayed or scheduled.
16b. Plain-English find (from Claude in Chrome): when keyword find returns nothing, the fast model searches the page's element list for what was meant ("the button that starts the application"). Fast model only, on misses only.

## Phase 5 — Budget and reliability
17. Monthly spend meter + hard cap in Settings (warn at 80%, stop smart/strongest models at 100%).
18. Real-key / real-Chrome validation pass: OpenAI Responses replay with store:false, Claude web search, chrome.debugger input on real sites, voice, area capture.

## Later — Mac app (v1.0)
19. Electron + Swift helper (or Peekaboo-style helper to start); menu bar + hotkey panel; whole-screen understanding.
20. Accessibility-tree actions + safety (kill switch, take-over on mouse move, app blocklist, approvals); prefer AppleScript/Shortcuts over clicks.
21. MCP client (Gmail, Calendar, Notion…); Chrome bridge via native messaging; cross-app tasks.
22. Ideas to revisit: credential vault the model can't read (Muse), a guard agent approving internet actions, parallel sub-agents for long tasks.

## Separate project (parked) — "Lighthouse for agents"
A tool that scores how usable a website is for AI agents (labels, accessibility tree, stable selectors, WebMCP tools, Markdown availability) and auto-generates WebMCP tool declarations from a site's existing forms as a drop-in script. Possible portfolio / ACM project. Shares code with Phase 2 (adapters + page view).
