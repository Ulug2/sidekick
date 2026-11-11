# Sidekick v1 "Powerhouse": the plan

Written 2026-11-10 from `docs/SIDEKICK_POWERHOUSE_BRIEF.md`. Companion docs: `ARCHITECTURE.md` (how), `DESIGN.md` (what it looks like), `COSTS.md` (what it spends), `BUGS.md` (why the four known bugs happen). Each phase ends with code that builds, passes `npm run check`, was exercised in the loaded extension where a model isn't needed, was reviewed by a second agent, and is committed.

Baseline at the start: v0.9.6, commit `9c6c657`; 685 jsdom checks, 46 unit tests, 87 real-Chromium checks, all green.

## Phase 1: audit, root causes, plan (done 2026-11-10) → checkpoint

Delivered: `BUGS.md` (four root causes with file:line), this plan, `ARCHITECTURE.md` v1 section, `DESIGN.md`, `COSTS.md`. Decisions for Ulugbek are listed at the end.

## Phase 2: orchestrator core

Goal: one brain, numbered workers, one model config, a world state every part can read, logging, a hard spend cap. No new user-facing features yet except the cap and the usage meter.

Build:
- `src/core/llm/models.ts`: every model ID, per-role assignment (brain, browser, writer, classifier, tie-break) and token limits in one place; `DEFAULT_SETTINGS` keeps only the provider and keys. Nothing else in `src/` names a model string (lint rule).
- `src/orchestrator/`: `brain.ts` (plan/rank/review calls; never loops), `workers.ts` (typed `WorkerTask` → `WorkerResult`; a worker is one agent run or one model call with a number, a model, a memory slice and a log), `world.ts` (the world state read from storage: jobs, needs-you, assignments, reminders, workers, spend), `policy.ts` (one autonomy policy: what may run without asking at each level), `scheduler.ts` (chrome.alarms: the 8 AM batch, randomized application times, reminder times, retries), `log.ts` (every irreversible action: what, when, why, by which worker; shown in the UI).
- `src/core/llm/budget.ts`: daily and monthly caps from Settings; `modelCall` refuses over the cap; the Powerhouse and the Jobs page show the meter.
- The existing agent (`src/agent`) becomes the browser worker's engine; `runAgent` takes a `WorkerTask` (goal, context slice, files, policy level) instead of loose options.

Acceptance:
- `grep -r "claude-\|gpt-" src --include=*.ts` finds model strings only in `models.ts` and `prices.ts`.
- A worker started with `policy: approved-batch` submits a local test form with "Sign and submit", an Enter-submit and a resume upload inside a cross-host frame without one approval card (real-Chromium test; this is bug 3).
- A worker's task context contains the applied/queued slice of the job board; a `world_query` tool answers "have I applied to Acme?" from storage (jsdom test; bug 4).
- With the daily cap set to $0.01 and a fake usage log over it, no model call happens and the UI says "Paused: spend cap" (jsdom test).
- Every submit, send, trash and upload appears in the action log with the worker number.

## Phase 3: memory that answers each question once

Goal: a fact store, an answer bank, episodic memory, the Memory page, and the regression test for bug 1.

Build:
- `src/memory/facts.ts`: typed canonical fields (name, emails, phone, addresses, school, degree, graduation month, high school and year, citizenship, visa status, work authorization answers, sponsorship answer, EEO choices, salary, relocation, start date, links, …), each `{ value, updatedAt, source }`; the profile page edits them; the old `profile` keys migrate in.
- `src/memory/answers.ts`: the answer bank (`{ id, question, normalized, answer, fieldType, options?, site, askedAt[] }`); `findAnswer(question, { options })` = BM25 over normalized questions, then a Haiku "same question?" confirmation above a threshold, cached; `learnAnswer()` from every `ask_user`, every answer typed on a Needs-You card and every answer the worker gave from the fact store.
- `src/memory/episodic.ts`: today's `memories` with a stored embedding field left optional (OpenAI `text-embedding-3-small` when the key exists; BM25 otherwise) and `recall(query)`.
- `ask_user` in the worker is intercepted in code: bank or fact store hit → answered without the UI, logged as "answered from memory".
- Memory page (`memory.html`): facts (editable), answer bank (search, edit, delete), episodic memories (today's list), "what Sidekick knows about you" export.
- Regression test (jsdom): a form asks high school twice in two different wordings across two runs with the bank filled by the first; zero `ask_user` reaches the UI in the second run and both fields are filled.

Acceptance: the regression test; the Memory page works at 760 px light and dark; facts edited on the page change the next worker's context (jsdom); no secrets (card, SSN) enter the bank (`redactSecrets`).

## Phase 4: job pipeline rework

Goal: the 8 AM batch, the strict eligibility and sponsorship module with evidence, applying without asking once a batch is approved, randomized times, logging with a confirmation screenshot, and the Needs-You redesign with Save & resume.

Build:
- Sources: Canada added to `whereIs`; more boards (Workday postings via each company's `wday/cxs` JSON when a careers link is pasted; Teamtailor; BambooHR), remote roles "hiring in" the five regions.
- `src/jobs/sponsorship.ts`: evidence per job with source and date: USCIS H-1B hub (have), DOL LCA certifications FY2025–26 compacted by `scripts/sponsors/build-lca.mjs` into a small JSON shipped in `public/data/` and refreshed monthly (stale → "unknown", shown), the UK register (have), IND recognised sponsors (HTML list, parsed), Ireland and Germany (any employer can; posting wording decides), Canada (the open.canada.ca positive-LMIA employers table + GTS wording), UAE (always employer-sponsored). Posting wording rules extended ("without sponsorship now or in the future", "US person", "permanent resident", "security clearance", per-country citizenship). Confidence confirmed / likely / unknown / no; only confirmed and likely enter batches. A note in the brain's ranking prompt about the 2026 H-1B facts (weighted lottery in force; the $100k fee applies to petitions filed from abroad and is court-blocked; OPT/STEM OPT cover the start).
- Scheduler: the 8 AM ET batch (alarm; if Chrome was closed, the first wake builds it); approved jobs get random times across the next 20 hours (never two within 15 minutes, none for the same company); each application run logs status, time, the exact answers (from the trace) and a screenshot of the confirmation page.
- Needs You: notification first, wait `needsYouWaitMinutes` (default 10), then the card with one input per question (text / select with the form's options / file / yes-no), "Save & resume" → answer bank → resume run (same tab or restart), CAPTCHAs, logins, SSN/ID/bank fields and legal attestations always land here.
- Honesty rules in code: work-authorization and sponsorship answers come only from the fact store (F-1, needs sponsorship); EEO from the fact store or "prefer not to answer"; a worker that invents a value fails the trace check (the trace shows each typed value's source).

Acceptance (real-Chromium where possible): bug 3 test; the Needs-You round trip (a run stops at a question → card with the literal question and options → Save & resume → the second run fills it from the bank and submits); a job whose posting says "must be authorized without sponsorship" is dropped with the sentence; a job with LCA evidence shows "likely: 42 certified LCAs FY2025"; the 8 AM alarm builds a batch of 15–20 with one job per company; times are randomized and logged.

## Phase 5: dashboard restyle and Settings nav

- Jobs page back to the Sidekick look (page.css tokens, light and dark), same layout, fewer chips; the Needs-You cards from Phase 4; the usage meter.
- Settings: a real sidebar nav (buttons, icons, active and hover states, keyboard focus; a horizontal scrollable row under 860 px), plus the new settings: autonomy (email auto-send categories, Needs-You wait), batch size and time, countries, notifications, daily/monthly caps, link to the Memory page.

Acceptance: real-Chromium screenshots at 760 and 1280 px, light and dark, no horizontal overflow; keyboard tabbing reaches every nav item.

## Phase 6: the Powerhouse

- `powerhouse.html`: the gym inside the CPU, Sidekick the coach doing push-ups while a brain call runs, shouting the real instruction when it dispatches or checks a worker; numbered workers on the equipment by task type; idle on a bench; Needs You with a raised hand; failed slumped with the error on hover; click → side drawer with task, live step log, model, tokens and dollars. CSS/SVG only, `prefers-reduced-motion` respected, 760 px works. A `voice` hook (`speak(text)`, no-op) for later.
- This page is also where the orchestrator loop lives (see ARCHITECTURE §3.2): keeping it open is what keeps Sidekick running.

Acceptance: a jsdom test that drives the state machine (idle → dispatch → working → needs-you → done) and checks the DOM; a design review by a second agent before implementation (`DESIGN.md` + a static mockup `docs/design/powerhouse-mockup.html`).

## Phase 7: school

- Readers for Moodle (calendar/upcoming events page, course pages) and MyOpenMath (assessment list), both already reachable through the agent; a syllabus uploader (reuse Documents) with Haiku extraction; course emails via Phase 8.
- `assignments` store: course, title, due (America/New_York), weight, source link, status; a "Do now / Do next / Later" ranking (brain, once a day; code re-sorts by due date between runs) with a one-line reason each; reminders through chrome.alarms + notifications with configurable lead times.
- Read and organize only: no worker may click Submit on a course site (policy level `read-only`).

Acceptance: fixtures copied from his Moodle and MyOpenMath pages (he exports the HTML; no account in tests); extraction test; ranking test with a fake brain; a reminder fires in a real-Chromium test with a short lead time.

## Phase 8: email

- Gmail through the Gmail API with `chrome.identity` (he creates the OAuth client for the extension ID; tokens encrypted at rest, see ARCHITECTURE §3.5).
- Outlook: try Microsoft Graph with a device-code flow and `Mail.Read` + `Mail.Send`; if the tenant requires admin consent (likely, see RESEARCH_NOTES), fall back to (a) an Outlook rule forwarding to Gmail, or (b) the browser worker reading Outlook on the web read-only. The choice is his.
- Triage (Haiku) into important / needs reply / FYI / promo / junk; cleanup moves promo and junk to Trash with a log and one-click undo (restore the label/folder); replies drafted by Sonnet in approval mode, with a per-category auto-send whitelist in Settings; every date, deadline and action item goes to the reminder list and, when it's coursework, to Phase 7.
- Everything from an email is untrusted content; an email that tries to instruct the agent is flagged on the Powerhouse and in the log.

Acceptance: fake Gmail API in tests; triage fixture set of 30 emails with expected labels; undo restores; a reply is never sent without approval unless its category is whitelisted; injection flagged.

## Phase 9: overnight runtime

- The orchestrator runs in the Powerhouse page; `chrome.alarms` (service worker) reopens it if closed and fires the schedules; a watchdog restarts stuck workers; everything survives a Chrome restart from storage.
- `docs/OVERNIGHT.md`: macOS sleep settings, `caffeinate`, lid, Chrome open, reboot behaviour, what to check in the morning.
- The daemon (Node + launchd) is designed but not built unless Phase 8 needs Keychain; see ARCHITECTURE §3.2 for the trigger.

Acceptance: a real-Chromium test that closes the Powerhouse tab and sees the alarm reopen it; a scheduled application fires at its time with Chrome idle.

## Phase 10: end to end

- One night's dry run with the real key at Lean settings and 5 applications; LESSONS.md updated with everything found; a final review by a second agent of each module against SECURITY.md; version 1.0.0.

## Decisions for Ulugbek (checkpoint)

1. Budget: Lean / Standard / Full (COSTS.md), and applications per day.
2. Keys: add an Anthropic key for the brain (Fable 5.1) or stay OpenAI-only (Terra as the brain).
3. Runtime: extension-hosted orchestrator now, daemon later only if needed (ARCHITECTURE §3.2), or the daemon from the start.
4. Memory storage: local (IndexedDB/chrome.storage, recommended) or Supabase + pgvector.
5. Outlook fallback if the school tenant blocks consent: forward to Gmail, or browser reading.
6. Email cleanup: on from the start (Trash only, with undo) or off until triage proves itself.
