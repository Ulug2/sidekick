# Powerhouse redesign: Silicon City (handoff for Claude Code)

This folder describes how to rebuild the Sidekick **Powerhouse** page (`powerhouse.html`) from the
"GPU gym with aliens" into the **Silicon City**. The look:

- The GPU card is a night city with lit buildings.
- The card floats inside a PC case.
- Workers are cute round robots doing their real jobs.
- Sidekick is a foreman robot who trains on the roof of the HQ tower (the GPU die).

A working prototype of the whole look is in `reference/powerhouse-city.html`. It is a single file
using Three.js from a CDN with made-up demo data. **Treat it as the visual source of truth.** Every
number in these docs was taken from it. When a doc and the prototype disagree, the doc wins, because
some docs fix prototype shortcuts (more slots, real-state wiring, beacons for far view).

## Files

| File | What it covers |
|---|---|
| `01-architecture.md` | Module map, data flow, the new `Scene` type, what changes in which file |
| `02-world.md` | The city on the card and the PC case around it: every part, position, size, colour, material |
| `03-robots.md` | Robot rig, faces, poses, props, Sidekick extras |
| `04-state-mapping.md` | Connecting to the real agents: state → scene → visual, slots, traffic, timers, events |
| `05-rendering.md` | Render loop and cost rules, lights, bloom, shadows, overlay, accessibility, fallbacks, tests |
| `06-build-plan.md` | Ordered milestones, each with acceptance checks |
| `reference/powerhouse-city.html` | The prototype. Open it in Chrome and use the demo buttons (Busy day / Dispatch / Paused / Idle) |

## Hard rules (unchanged from the original spec, plus one new one)

1. Every figure and motion maps to a real state. No robot without a real worker record. No motion when nothing runs.
2. States come from the pure function `deriveScene(state) -> Scene` in `scene.ts`. Drawing code never reads app state directly.
3. The HTML worker list is the accessible path. The canvas and its labels are `aria-hidden`, but still clickable.
4. All web text (job titles, companies, errors) is shown as plain text (`textContent`), never HTML. That includes the speech bubble.
5. Rendering costs nothing when idle: frames are drawn only while something moves and the tab is visible, capped at 30 fps, with pixel ratio ≤ 1.5. The page may stay open for hours.
6. Reduced motion: still poses, no camera flights.
7. Without WebGL, the stage shows a one-line note and the list carries everything.
8. **New:** when nothing runs, everyone is asleep. Robots sit with a `z z` face, Sidekick sleeps on the roof and the city lights dim. One frame is drawn, then the renderer stops.

## Prompt to paste into Claude Code

```
Read every file in docs/powerhouse-redesign/ (start with README.md, then 01 to 06), and open
reference/powerhouse-city.html to see the target look. Then read the current Powerhouse code
(scene.ts, gpu3d.ts, gpu-layout.ts, alien.ts, powerhouse.ts/.css/.html) and the worker/Sidekick
state types it consumes.

Implement the redesign following 06-build-plan.md milestone by milestone. After each milestone,
run the checks listed for it, show me what changed, and wait for my OK before the next one.
Keep deriveScene pure and fully unit-tested. Do not change how worker state is produced; if the
real state lacks a field that 04-state-mapping.md needs, stop and tell me instead of inventing it.
```

Put this folder at `docs/powerhouse-redesign/` in the extension repo, or change the path in the prompt.
