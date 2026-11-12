# Design: Powerhouse, dashboard, Settings, Needs You

Written 2026-11-10 for the v1 plan. Everything uses the Sidekick look already in `src/ui/shared/page.css`: Inter, the beige accent, light and dark from the system, cards separated by hairlines, 14.5 px text. The dark "control room" style of the Jobs page is removed (brief §6.5). Every page works at 760 px (half of a 1512 px MacBook screen) and 420 px (the side panel), light and dark, and the static mockups below go through a design review by a second agent before Phase 6 starts.

## 1. The Powerhouse (`powerhouse.html`): the Silicon City

The full spec is `docs/powerhouse-redesign/` (his design handoff, 2026-11-11: README, 01 architecture, 02 world, 03 robots, 04 state mapping, 05 rendering, 06 build plan, and the prototype `reference/powerhouse-city.html`). This section says what was built and where it differs.

**What it is.** A live status view of Sidekick and its workers, drawn in Three.js (bundled into this page only). The graphics card is a night city: the board's traces are roads, the GPU die is the HQ tower, the VRAM chips are the archive and the data halls, the fin stack is the power plant with its turbine fan, the capacitors are silos, the display bracket is the city wall, the PCIe fingers are the docks. The card floats inside a PC case (motherboard, RAM towers, CPU cooler, back-wall fans, cables). The card is dark in both themes; the page around it follows light/dark.

**Who is where (the contract).** `scene.ts` `deriveScene(CityInput)` is pure and the only place that maps real state to the city; the 3D view (`city-view.ts`) only draws the Scene. Tables in `docs/powerhouse-redesign/04-state-mapping.md`; tests in `tests/unit/scene.test.ts`.

| Real state | Robot | Where |
|---|---|---|
| reading / classifying | scans the data rack (face "scan", a cyan beam) | the rack, 3 spots |
| writing (cover letter) | types at a terminal (the screen scrolls) | 2 terminals |
| applying | carries an APPLY crate down the lane to the docks and walks back | the lane, 4 couriers |
| started in the last 6 s | hops and waves at the archive entrance | 2 spots |
| needs you | sits on the dock bench, waves, "?" | bench (5 seats, needs-you first) |
| done / stopped (30 s) | sits on the bench, "✓" / "■ ■" | bench |
| no news for 15 min / waiting | sits asleep, "z z" | bench |
| failed (until dismissed or 24 h) | slumped by the silos, "!", sparks | silos, 3 spots |
| paused while running | its pose frozen, amber antenna, "finishing" | where it was |

Sidekick (the cream foreman, coral headband, 1.7×) is on the HQ roof: **lift** (barbell press) while a brain model call is in flight, **whistle** (points at the new worker, a speech bubble with its real title, a dashed glowing trace to it) for 6 s after starting one, **coach** while workers run, **rest** when paused by you or the spend cap, **sleep** when nothing runs. More robots than spots go to the list only ("N more workers than there is room for on the card").

**Traffic.** Packets on the roads summarise real activity (never when nothing runs); each logged step sends one bright pulse from HQ to the worker's district (worker records count `steps`).

**Mood.** Live: windows lit, fan spinning. Paused: windows 80%, fan ring dim, nothing moves. Asleep (nothing runs): windows 50%, the board glow dims, one frame is drawn and the renderer stops.

**Cost.** Frames only while something moves and the tab is visible, at most 30 a second, pixel ratio ≤ 1.5; otherwise one frame per change (and one final frame when the loop stops). Static city and case meshes are merged per material, static shadow casters baked into one proxy, robots are 9 draws each: 4 robots ≈ 185 draws, 7 robots ≈ 228 (budget 250). Rigs unused for 60 s are disposed.

**Interaction and accessibility.** Drag to turn, scroll or pinch to zoom, + / − / Reset view, + − 0 on the focused canvas; clicking a robot, its badge or its row in the list flies the camera to it and opens its drawer (Escape returns focus to where it came from). The canvas and badges are `aria-hidden`; the worker list is the keyboard and screen-reader path. Reduced motion: still poses, no flights, no traffic. Without WebGL (or after the context is lost): one line in the stage, the list carries everything.

**Demo.** `powerhouse.html#demo`: every state (Idle, Thinking, Dispatch, Working, Needs you, Failed, Paused, Busy day, Overflow) and "Log a step", from made-up records in memory (nothing is stored), with a render meter (fps or stopped, frames, draws).

**Differences from the handoff.**
- `PCFSoftShadowMap` no longer exists in three 0.186: shadows use `PCFShadowMap`.
- The HQ roof light is above Sidekick (ROOF + 19), not at his chest; at ROOF + 9 it blew his face out up close.
- Robots are merged, vertex-coloured parts with one material (body/trim roughness averaged).
- Sora and JetBrains Mono are bundled locally (no Google Fonts).
- The prototype kept the last moving frame on screen when a scene stopped moving; the view now draws a final frame.

**History.** Phase 6 first shipped a 2D SVG gym with alien coaches (mockup `docs/design/powerhouse-mockup.html`, reviewed by a second agent), then a 3D graphics card with alien workers; both were replaced by the city (commits up to `8bc7bec`, swapped in M6). The voice hook (`voice.ts`, `speak()`) stays a no-op stub.

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
