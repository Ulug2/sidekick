# 06 · Build plan (do these in order and stop after each for review)

Each milestone leaves the page working. Keep the old code path until M6 swaps it in, or build the new
view behind a flag (`?city=1`) and flip the default at M7.

## M0 · Orient (no code changes)

- Read docs 01–05 and open `reference/powerhouse-city.html`.
- Read the current `scene.ts`, `gpu3d.ts`, `gpu-layout.ts`, `alien.ts`, `powerhouse.ts`, and the state types that feed them.
- Write a short note mapping each "Inputs deriveScene needs" row (04) to a real field, or flag it as missing.

**Check:** the mapping note is posted, and missing fields are listed with a proposal. Wait for OK.

## M1 · Scene contract (pure, no Three.js)

- Extend `Scene` and `deriveScene` per 01 and 04: activities, Sidekick modes, mood, slots, overflow, traffic counts, `animates`, chip/line, `stepKey`.
- Add `city-layout.ts` with the pure numbers: roads, spots, slot tables, the courier path, routes, camera home and limits, `ROOF`, `G`, `MB`.
- Add the next-deadline timer in `powerhouse.ts` (one `setTimeout`).
- Update the HTML list rows and pills to the new states.
- Write `scene.test.ts` (04 › Unit tests).

**Check:** all tests pass; the list shows the right pills in every `#demo` state; no rendering changes yet.

## M2 · Materials and the city

- `materials.ts`: `std`, `glow`, `windowMat` (02 › Lit-window shader), `canvasTex`, `signTex`, and the material registry for `setMood`.
- `city.ts`: board and road canvases, HQ, archive with **two terminals and the 3-spot rack**, data halls, heat pipes, plant with fins and fan, substations, silos, wall, docks with the **24-unit bench**, filler skyline (seeded), lamps. Expose refs: `fan`, `fanRing`, `hqLight`, `plantLight`, `termTextures[]`, and `setMood(mood)`.
- Wire the new lights, fog, environment and composer settings (02, 05) into `gpu3d.ts`. Keep the old aliens for now; they can stand in the new slots.

**Check:** demo screenshots at home view match the reference city. Idle draws one frame (meter shows stopped). Draw calls < 200 so far.

## M3 · The PC case

- `case.ts` per 02 › PC case background. Nothing casts shadows. Expose `bgFans` and `setMood`.
- Fans spin only while `animates`.

**Check:** from the home view you see the motherboard, the RAM towers on the left, the cooler and back-wall fans behind, and the cables on the right. Idle cost is unchanged (one frame).

## M4 · Robots

- `robot.ts`: rig, face canvas with all expressions, glow, `resetPose`, `sitPose`, the worker poses, the Sidekick modes, and props (crate, beam, sparks, barbell, whistle, headband). Per 03.
- Rig pool in `gpu3d.ts`: create on first sight, hide when gone, dispose after 60 s unused.
- Delete `alien.ts` and the old pose code.

**Check:**
- Every `#demo` state shows the right pose, face, antenna colour and tag.
- Clicking a robot or its badge flies to it and opens the drawer.
- Paused freezes poses with amber antennas.
- Idle shows everyone asleep and stops rendering.

## M5 · Traffic, pulses, dispatch

- `traffic.ts`: packet routes with counts from `scene.traffic`, step pulses on `stepKey` changes (they keep the loop alive about 1.5 s via `transient`), and the dispatch trace plus speech bubble.
- Hide all of it under reduced motion.

**Check:**
- Packets appear only when something works.
- A step change in a stopped scene draws a pulse, then the loop stops again.
- Dispatch shows whistle + bubble + trace for 6 s, then the scene reverts.

## M6 · View wiring and the swap

- Finish `createPowerhouseView` (01 › gpu3d.ts public API): overlay, picking, flights, keyboard, resize, context loss, dispose.
- Switch `powerhouse.ts` to the new view and remove the old one.
- Remove `gpu-layout.ts` once nothing imports it.

**Check:** 05 › Tests all pass (rAF counter tests, plain-text tests, reduced motion, WebGL-off note).

## M7 · Polish and tune

- Tune exposure, bloom and the window density on a real screen in both light and dark page themes (the card stays dark).
- Check labels at the narrow layout (4:3 under 760 px), and the overflow state with 12 workers.
- Optional: far-view beacons (03 › Far view) if the robots read too small.
- Update the original design spec document so it describes the city, not the gym.

**Check:** performance budget table in 05 is met; screenshots of every demo state are posted for review.
