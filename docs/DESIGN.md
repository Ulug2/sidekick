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

**Mockup.** `docs/design/powerhouse-mockup.html` (static, no script beyond a state toggle) is produced in Phase 6 before the real page.

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
