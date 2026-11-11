# Known bugs: root causes (Powerhouse brief §1, audited 2026-11-10)

Each entry: what Ulugbek saw, where the code actually does it, the cause, and the fix the plan commits to. Line references are to commit `9c6c657`.

## 1. The job agent asked for his high school and graduation year three times

**What happened.** During one batch, three application runs each asked "high school / graduation year" through `ask_user`. After the first answer the panel showed "Remembered for next time: …", so the answer was saved, yet the next two runs asked again.

**Where answers are written.** `src/agent/actions/run-tool.ts` `case "ask_user"`: after `ui.ask()` returns, `factsFromAnswer()` (`src/assistant/session.ts`) asks the fast model whether the answer holds a lasting fact and, if so, `addMemory(text, "application", kind)` stores it as a free-text memory in `chrome.storage.local["memories"]` (newest first). That is the only place an answer is kept. The profile (`src/assistant/profile-core.ts` `DEFAULT_PROFILE`) has no high-school fields at all.

**Where they are read.** `src/agent/loop/run.ts` builds the system prompt once per run with `memoriesFor(goal, { relevant: 10, recent: 3 })` (`src/assistant/memory/memory.ts:169`). `memoriesFor` returns (a) the memories whose words match the *goal text* by BM25 and (b) the 3 newest non-stale memories. Nothing else reads memories during a run; `ask_user` never consults them before asking.

**Why the read misses.**
1. *Retrieval is keyed to the wrong text.* In a batch the goal is "Apply for this job using my profile: <title> at <company> … <the whole cover letter>". A memory like "Graduated from Nazarbayev Intellectual School in 2022" shares no words with that, so it never scores; it survives only through the "3 newest" rule, which another two memories push it out of (the batch itself adds memories: each answered question can add one or two, and the letter writer's questions add none, but chat facts and other answers do).
2. *The prompt tells the model to ask.* `src/agent/prompt.ts:58`: "If a required answer isn't in the profile, collect all such questions and ask the user once." Memories are shown under "Things you've learned about them", not as profile facts, and fast-tier runs (Luna/Haiku at low effort) follow the literal rule.
3. *No question matching.* Even when the memory is in context, nothing maps "Year of HS graduation" to it; the model must notice the paraphrase itself. There is no answer bank keyed by normalized question.
4. *Nothing stops the ask in code.* The `ask_user` handler asks first and learns afterwards; it never checks whether the question is already answered.

**Fix (Phase 3).** An **answer bank** (`src/memory/answers.ts`): every `ask_user` question and answer is stored with a normalized question key, the field type and options; the structured **fact store** holds canonical fields including `highSchool`, `highSchoolYear`. Before `ask_user` reaches the UI, code looks the question up (BM25 over normalized questions, then a Haiku "same question?" check above a threshold); a hit answers the agent directly ("Answered from memory: …") and logs it in the trace. The worker's context also gets the whole fact store and the bank entries matching the form's field labels. Regression test: a form with "High school" and "What year did you finish secondary school?" fields, the bank holding one answer from a previous run, and a fake model that calls `ask_user` for both: neither question reaches the UI, both fields are filled.

## 2. "Needs you" is a dead end

**What happened.** A job set aside under Needs you can only be marked "Applied by hand" or opened by hand; nothing continues the application.

**Cause.** `src/ui/sidepanel/jobs-run.ts` records only `{ status: "needs_you", note, traceId }` (`setJobStatus`) and moves on; the tab is left open but no identifier of it, no list of the open questions, no field ids and no answers are stored. `src/ui/jobs/jobs.ts` `renderJob` has no resume action. The agent run itself ended (the stall watcher calls `stop()` after 8 minutes, `judgeRun` turns the unanswered `ask` event into the note), so there is no run to continue.

**Fix (Phase 4).** A `needsYou` record per job: the literal questions (text, field type, options), the tab id and URL, the step the run reached. The card renders one input per question; **Save & resume** writes the answers to the answer bank and starts a new run with `resumeFrom` (same tab if it still exists, else the apply URL again) whose goal says the form was partly filled and lists the saved answers. Everything auto-fills from the bank and fact store, so a restart costs one run.

## 3. An approved batch still asks

**What happened.** After "Approve & start batch", runs still stopped for approval or questions.

**Cause.** Pre-approval (`preApproved` → `state.planApproval = { sites, autoSubmit: true }` in `src/agent/loop/run.ts`) only switches off the gates that check `inPlan(state, site)`: final-action clicks, visits and sharing on the listed sites, and resume uploads. Everything else still asks, in code:
- `ask_user` for anything not in the profile (bug 1): the most common.
- `press_key` Enter in a form with more than a search box (`run-tool.ts:193`): always asks, pre-approval or not.
- Clicks whose label matches `NEVER_AUTO` (`src/agent/safety/gates.ts:64`: "sign and …", "post", "order", …) even when they are the application's own submit ("Sign and submit").
- Any site not in the approved list: the list holds only `siteOf(applyUrl)` and `siteOf(job.url)`, but forms embedded in a frame from another host (a Greenhouse board inside the company's careers site, Workable's `apply.workable.com` reached from a company page), redirects to a sub-site and "Apply" buttons that open a new tab on another host all fall outside it, so uploads ask ("Attach your resume on greenhouse.io?") and `gateShare` runs the fast-model check, which asks when unsure.
- Non-read-only site tools (`site_tool`) always ask.
- A CAPTCHA, a sign-in, "Verify you are human": by design.
- Settings → Agent → "Ask before: every click" overrides everything.

**Fix (Phase 2/4).** One `autonomy` policy evaluated in one module (`src/orchestrator/policy.ts`) instead of gates scattered through `run-tool.ts`: an approved batch sets `level: "approved-batch"` for the job, which pre-approves submits, Enter-submits, uploads and typing on the job's ATS site, the company's site and any frame host of the form; questions go to the answer bank first; the remaining stops (CAPTCHA, login, SSN/ID/bank fields, legal attestations, payments) notify and wait `needsYouWaitMinutes`, then the job moves to Needs You. "Every click" mode stays a global override and is shown on the Jobs page when it is on.

## 4. The job agent knows nothing about the dashboard

**What happened.** The agent can't answer "did I already apply to this company", doesn't know the batch, the statuses or what's waiting in Needs you.

**Cause.** `runAgent` gets a goal string, the profile and memories (`src/agent/loop/run.ts:36-44`); the job list (`jobs`, `jobCompanies`) is read only by the Jobs page and `jobs-run.ts`. There is no shared state object and no tool to query it.

**Fix (Phase 2).** A **world state** module (`src/orchestrator/world.ts`) that assembles, from storage, what every worker may see: the job board (queue, statuses, applications sent with dates), Needs You items, assignments and reminders, worker statuses, spend. Workers get a typed slice in their task (`task.context.jobs = { applied: [...], queued: [...] }`) and a `world_query` tool for the rest. The brain reads the whole thing when planning.

## Also found during the audit (not in the brief)

- **Learned facts never reach the profile.** Facts the chat learns ("graduates May 2027") stay free text; the profile fields that forms need (start date, graduation) are typed by hand. The fact store (bug 1 fix) becomes the one source, and the profile page edits it.
- **Jobs page restyle.** `src/ui/jobs/jobs.css` overrides the shared tokens with a dark control-room look; the brief rejects it. Phase 5 returns it to `page.css`'s look.
- **Settings navigation** is plain text links (`.toc a` in `src/ui/shared/page.css`); Phase 5 makes it a real sidebar nav.
