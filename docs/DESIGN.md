# Design: Powerhouse, dashboard, Settings, Needs You

Written 2026-11-10 for the v1 plan. Everything uses the Sidekick look already in `src/ui/shared/page.css`: Inter, the beige accent, light and dark from the system, cards separated by hairlines, 14.5 px text. The dark "control room" style of the Jobs page is removed (brief §6.5). Every page works at 760 px (half of a 1512 px MacBook screen) and 420 px (the side panel), light and dark, and the static mockups below go through a design review by a second agent before Phase 6 starts.

## 1. The Powerhouse (`powerhouse.html`)

A live status view drawn as a gym inside the CPU. Every animation maps to real orchestrator state; nothing moves without a reason.

**Scene.** A 16:9 stage (max 1100 px wide, scales down to 420 px) built from inline SVG: a circuit-board floor (thin copper traces in the accent colour at 20% opacity, vias as dots), chip-die walls (dark tiles with faint grid), two heat-sink racks drawn as fin stacks that serve as the pull-up bar (left) and the bench (right), a glowing trace that runs from Sidekick to whichever worker it is addressing. In light mode the board is pale green-grey with copper traces; in dark mode charcoal with cyan traces. `prefers-reduced-motion`: no loops; states shown by pose and label only.

**Sidekick, the coach.** A white humanoid alien (SVG, ~120 px): oval head, two large dark eyes, a slim body. Poses: `idle` (standing, arms crossed, slow blink every 6 s), `thinking` (push-ups: a 1.2 s loop, runs exactly while a brain model call is in flight), `shouting` (stands, one arm pointed at the worker, a speech bubble with the real dispatch text, e.g. "Agent 3! Finish the Stripe app, form's on page 2!" for 6 s or until the next event), `paused` (sitting on the floor, a small "spend cap" or "stopped" tag).

**Workers.** Numbered badges (1–6) on grey humanoids 80% Sidekick's size. Pose by state: `working` with task type → pull-ups (applications), push-ups (reading/extraction), sit-ups (writing); `idle` → sitting on the bench; `needs_you` → sitting with a raised hand and a yellow "?" tag; `failed` → slumped against the rack with a red tag; hover shows the error. A worker appears when its task starts and leaves the stage 30 s after it finishes (fades to the bench, then out).

**Click any character.** A right drawer (360 px; full width under 760 px) with: the task title, the worker number and model, a live step log (the same step lines as the agent card, newest at the bottom, auto-scroll), tokens and dollars so far, buttons Stop / Open its tab. Clicking Sidekick shows the current plan (today's batch, what's scheduled next, the last brain decision with its reason) and the spend meter.

**Top bar.** "Powerhouse" + status chip (Running / Paused: spend cap / Paused by you / Sleeping until 8:00), the daily and monthly meters as two thin bars with dollars, and Pause/Resume.

**Voice hook.** `src/ui/powerhouse/voice.ts` exports `speak(text: string): void` (no-op) and a `VoiceProvider` interface; the shout bubble calls it. Nothing else now.

**Mockup.** `docs/design/powerhouse-mockup.html` (static, no script beyond a state toggle) is produced in Phase 6 before the real page. Reviewed 2026-11-11 by a second agent (approved with required changes, all taken; summary below).

**The contract (after the review).** Every visual has exactly one real source; `src/ui/powerhouse/scene.ts` `deriveScene()` is the only place that maps state to poses, and the jsdom test drives it.

| Visual | Real source | Notes |
|---|---|---|
| Sidekick push-ups | a brain model call in flight: `brainCalls` in session storage (`orchestrator/activity.ts trackBrain`, wrapped around every `role: "brain"` call) | entries older than 3 min don't count (a page closed mid-call) |
| Sidekick shouting + bubble + glowing trace | `orchestrator.lastShout { text, at, workerId }`, written when a worker starts (`startWorker`, `runAsWorker`) | shown while `now - at < 6 s` and the worker is on stage; text is the task's real title (redacted, plain text), clamped to 3 lines; never replayed after a reload |
| Sidekick sitting + tag | `orchestrator.paused === "you"` → "paused by you"; spend over a cap (live, `overCap`) → "spend cap: daily/monthly" | the old sticky `"spend-cap"` value is ignored; running workers freeze with a "stopping" tag |
| Sidekick standing, arms crossed | none of the above | |
| Pull-ups | worker `kind: apply`, `status: working` | |
| Push-ups (worker) | `kind: read` or `classify`, `status: working` | |
| Sit-ups | `kind: write`, `status: working` (cover letters: `runAsWorker`) | |
| Hand up + "?" | `status: needs_you` (or a `needsYou` item for that worker) | stays until handled; never leaves on a timer |
| Slumped + "!" | `status: failed`; the error in the list and drawer | stays until he dismisses it (drawer) or 24 h |
| On the bench, "done" / "stopped" | `status: done` / `stopped`, for 30 s after `updatedAt` | then off stage; no worker is ever drawn without a record |
| Top chip | working count; else "Sleeping until <next batch time>" from `jobSettings.batchHour` (or "Idle" when the daily batch is off); "Paused" / "Spend cap" | |

**Layout.** Slots per area: bar 3, mat 2, bench 3, floor (failed) 2; extra workers go into the HTML list only, with a "+N more" chip on the stage. Below 560 px the in-scene labels are hidden and the list carries everything.

**Accessibility.** The scene is `aria-hidden`; an HTML list of workers (one `<button>` each: "Agent 3, applying: Stripe, step: Page 2, needs you") is the keyboard and screen-reader path and opens the drawer. The drawer is `inert` when closed, takes focus on open, returns it on close, closes on Escape; its step log is `aria-live="polite"`. Reduced motion: no animation, static poses, every status also in text.

**Cost of looking.** Animations run only while the tab is visible and only on figures that are working; the trace has no filter; workers are desynchronised (`--i` delays). The page re-renders from `chrome.storage.onChanged` with keyed figures (one `<g>` per worker id), and a 1 s ticker runs only while something is leaving or a shout is fresh.

**Scope.** The page shows state and has Pause/Resume and Stop; it does not yet host the orchestrator loop or reopen itself (Phase 9). The voice hook stays a no-op stub.

**3D (redesign, 2026-11-11, his choices: aliens up close and cores far away, Three.js, a dark card in both themes).** The 2D gym is replaced by a graphics card in WebGL (`gpu3d.ts`; placement in `gpu-layout.ts`, pure and unit-tested; the aliens and their poses in `alien.ts`). The contract above is unchanged; only the drawing moved:

| Area (scene.ts) | Part of the card | Close up (alien) | Far away (core) |
|---|---|---|---|
| Sidekick | the GPU die, centre | stands, push-ups while a brain call runs, points and shouts, sits when paused | always the alien (1.35×); the die glows brighter while thinking, dims when paused |
| bar (applying) | the copper heat pipe | pull-ups, hands on the pipe | cyan pulsing core under the pipe |
| mat (reading, writing) | VRAM chips | push-ups / sit-ups | cyan pulsing core |
| bench (needs you, done, stopped, no news) | sitting on the PCIe edge | hand up and waving / sitting | amber pulsing core / grey core |
| floor (failed) | by the capacitors | slumped | red core |

- The level of detail is per worker by camera distance (alien under 70 units, core over 95, crossfade between); the overview shows cores, flying to a worker shows the alien.
- Controls: drag to turn, right-drag or shift-drag to pan, wheel or pinch to zoom, + / − / Reset buttons, arrow keys, + − 0 on the focused canvas; click a worker (or its label) to fly to it, from the side it faces, and open its drawer; Escape returns focus to the canvas without scrolling.
- The trace from the die to the addressed worker is a glowing tube with moving dashes (6 s with the shout). The fan spins while anything works.
- Cost of looking: render only while something moves and the tab is visible, otherwise once per change; pixel ratio ≤ 2, one 1024 shadow map, bloom at half resolution. Reduced motion: still poses, camera jumps instead of flying.
- Without WebGL the stage says so and the worker list carries everything.
- `powerhouse.html#demo` shows every state from made-up records, in memory only (nothing stored).


## 2. The Jobs dashboard (restyled)

Same structure as today, in the Sidekick look:
- Hero: title, one-line status (sponsor lists date, companies, last scan, spend), the two main buttons.
- Six stat tiles as plain cards (number, label, one-line detail), the accent only on "today's batch".
- Controls row (daily cap, monthly cap, internships, update lists, find companies, export).
- Tabs as proper tabs (underline accent, counts in small grey).
- Rows: title (link) · company; a second line with grey chips (region, sponsorship with its evidence on hover, status), place, posted, applied; reason line; actions to the right as `button.small`, "Replay" as a link.
- Sponsorship evidence shown as text under the row: "likely · 42 certified LCAs (DOL, FY2025) · UK licence (Home Office, 2026-11-06)".

## 3. Needs You (cards)

On the Jobs page's Needs you tab and in the Powerhouse drawer:

```
Backend Engineer · Bravo                                   waiting since 09:42
Stopped at: "Education" page (step 7 of the form)
1. What year did you finish secondary school?        [ 2022        ]  (text)
2. Which best describes your work authorization?     [ select ▾    ]  options from the form
3. Resume (PDF)                                      [attached from profile]  nothing to do
Also here: sign-in needed · CAPTCHA · asks for SSN  → "I'll do this part" opens the tab
[Save & resume]  [Skip this job]  [Open the form ↗]
```
Each answer saved by "Save & resume" goes to the answer bank with the literal question, the normalized key, the field type and the options, then the run resumes (same tab if open, else restarted and auto-filled). A card for a human check (CAPTCHA, login) has no inputs, only "I did it, continue".

## 4. Settings

A left sidebar nav with icon + label buttons (not links): Connect, Models, Assistant, Memory, Agent, Jobs, Email, School, Notifications, Spend, Pages. Active item has the accent background; hover a surface tint; focus ring from `--focus`; arrow keys move between items. Under 860 px the nav becomes a sticky horizontal row of pill buttons. New sections:
- **Jobs:** batch size (5–30), batch time (default 08:00 ET), countries (US, UK, EU, Canada, UAE, remote), Needs-You wait (minutes), internships, one-per-company days.
- **Email:** accounts (connect/disconnect), triage on/off, cleanup on/off (Trash only), reply mode: approve each / auto-send for categories [ ] newsletters [ ] receipts [ ] course logistics …
- **Notifications:** what notifies (needs you, batch built, batch done, deadlines, spend cap), quiet hours.
- **Spend:** daily cap, monthly cap, meter, link to usage.
- **Memory:** link to the Memory page; learn automatically on/off.

## 5. Memory page (`memory.html`)

Three cards: **Facts** (a table of canonical fields with value, updated, source; inline edit), **Answers** (search; each row: question, answer, field type, where it was asked, when; edit/delete), **Memories** (today's list). Export everything as Markdown (exists) and import.

## 6. Side panel

Unchanged, except: a small "Agent 2 · applying at Stripe" line at the top while the batch runs, linking to the Powerhouse; "Remembered …" toasts keep their Edit link (now to the Memory page).
