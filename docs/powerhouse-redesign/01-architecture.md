# 01 · Architecture

## Data flow

```
 real app state (Sidekick brain, worker records, pause/spend/sleep flags, clock)
        │   (subscription already used by powerhouse.ts today)
        ▼
 deriveScene(state, now) ──► Scene            scene.ts   PURE, unit-tested, no Three.js
        │
        ├──► renderList(scene)                powerhouse.ts   HTML worker list + top bar (accessible path)
        │
        └──► world.apply(scene, prevScene)    gpu3d.ts        3D: places rigs, sets poses/props/mood,
                                                              diffs for events, starts/stops the loop
```

- `deriveScene` is called on every state change and also on a timer, but **only while a timed rule
  is pending** (dispatch window 6 s, done/stopped leaving after 30 s, no news after 15 min). The
  timer is a single `setTimeout` to the next deadline, never a polling interval.
- The 3D world never reads app state. It receives the `Scene` and the previous `Scene`, and nothing else.
- All motion is computed from the `Scene` plus a local animation clock. The clock advances only
  while the loop runs, so a frozen scene renders identically every time.

## Module map

| File | Status | Responsibility |
|---|---|---|
| `scene.ts` | **extend** | `Scene` type, `deriveScene`, slot assignment, traffic flags, `animates` flag. Pure. |
| `city-layout.ts` | **new** (replaces `gpu-layout.ts`) | Pure numbers: board size, roads, districts, slots/spots, routes, camera home, zoom limits, LOD distances. No Three.js imports. |
| `materials.ts` | **new** | `std()`, `glow()`, `windowMat()` (lit-window shader), canvas texture helpers (`canvasTex`, `signTex`). Shared material cache. |
| `city.ts` | **new** | Builds the card city: board, roads texture, HQ, archive, docks, power plant, silos, wall, substations, filler skyline, lamps. Exposes `setMood(mood)` and refs for animated parts (fan, HQ light, rack). |
| `case.ts` | **new** | Builds the PC-case background: motherboard, standoffs, riser, RAM, cooler, back wall, fans, cables, parts, dust. Exposes `bgFans` and `setMood`. Static, casts no shadows. |
| `robot.ts` | **new** (replaces `alien.ts`) | `makeRobot()`, face canvas + expressions, `resetPose`, pose functions, props (crate, scan beam, sparks, barbell, whistle, headband). |
| `traffic.ts` | **new** | Data packets on routes, step pulses, dispatch trace (dashed tube). |
| `gpu3d.ts` | **rewrite** | Renderer, composer, lights, controls, render loop, camera flights, picking, overlay (badges, bubble), rig pool, `apply(scene, prev)`. |
| `powerhouse.ts/.css/.html` | **small changes** | Status chip texts, worker list rows (new state pills), demo buttons, meter (demo only). |

Three.js stays bundled into this page only. Import addons from `three/examples/jsm/...`:
`OrbitControls`, `RoundedBoxGeometry`, `RoomEnvironment`, `EffectComposer`, `RenderPass`,
`UnrealBloomPass`, `OutputPass`. The prototype used r170. The repo uses 0.186.1; the same APIs work.

## The Scene type (scene.ts)

```ts
export type SidekickMode =
  | 'lift'     // brain model call in flight: barbell press on the HQ roof
  | 'whistle'  // started a worker in the last 6 s: whistle + point + bubble + trace
  | 'coach'    // something runs, brain not calling: stands with clipboard, watching
  | 'rest'     // paused by user / spend cap: sits on the roof, amber, awake
  | 'sleep';   // nothing runs (idle, or sleeping until a time): asleep, z z

export type Activity =
  | 'read'     // reading / classifying     → scans the data rack
  | 'write'    // writing (cover letter)    → types at a terminal
  | 'apply'    // applying                  → carries a crate to the docks
  | 'start'    // first 6 s after dispatch  → hops at the archive entrance, waving
  | 'ask'      // needs you                 → bench, '?', waving
  | 'fail'     // failed                    → slumped by the silos, '!', sparks
  | 'done'     // done                      → bench, '✓'   (leaves after 30 s)
  | 'stopped'  // stopped                   → bench, '■ ■' (leaves after 30 s)
  | 'nonews'   // no update for 15 min      → bench, asleep, tag "no news"
  | 'wait';    // queued / waiting          → bench, asleep, tag "z z"

export type Zone = 'rack' | 'terminal' | 'lane' | 'entrance' | 'bench' | 'silos';
export interface Slot { zone: Zone; index: number }

export interface SceneWorker {
  id: string;            // stable worker id from the record
  n: number;             // display number (agent number)
  activity: Activity;
  finishing: boolean;    // paused while running → frozen pose, amber antenna, tag "finishing"
  title: string;         // plain text
  step: string;          // plain text: current step or error
  slot: Slot | null;     // null → overflow (list only)
  phase: number;         // 0..1 lane phase for 'apply'; 0 otherwise
  stepKey: string;       // changes whenever the worker logs a new step (drives step pulses)
}

export interface Scene {
  mood: 'live' | 'paused' | 'idle';
  sidekick: { mode: SidekickMode; dispatchTo?: string /* worker id */; bubble?: string /* plain text */ };
  workers: SceneWorker[];          // only those with a slot, sorted by n
  overflow: SceneWorker[];         // no room on the card; shown in the list
  traffic: { archive: number; docks: number; plant: number; ring: number }; // packet counts, 0 = off
  animates: boolean;               // true → render loop may run
  chip: string;                    // status chip text
  line: [string, string];          // status line: bold lead + rest
}
```

Rules for `deriveScene` are in `04-state-mapping.md`. It must be deterministic: the same input gives
the same Scene, including slot assignment. Sort workers by `n` before assigning slots.

## gpu3d.ts public API (keep it small)

```ts
export interface PowerhouseView {
  apply(scene: Scene): void;          // diff against the last scene, update the world, then kick()
  focusWorker(id: string | 'sidekick'): void; // camera flight + open drawer (drawer is HTML, outside)
  resetView(): void;
  zoom(factor: number): void;
  dispose(): void;                    // on page unload
}
export function createPowerhouseView(stage: HTMLElement, opts: {
  onPick(id: string | 'sidekick'): void; // canvas or badge click → page opens the details drawer
  reducedMotion: boolean;
}): PowerhouseView | null;            // null when WebGL is unavailable (caller shows the note)
```

### Rig pool

- `Map<workerId, RobotRig>`. Create a rig the first time an id appears. When an id leaves the
  scene, hide its rig and dispose it after 60 s unused, so a busy day does not leak GPU memory.
- `apply()` steps for every visible rig: set its slot transform, its activity props (crate, beam,
  sparks), its face, its antenna colour, and the base pose for t = current clock. Then rebuild the
  badges overlay (DOM) and set `shadowsDirty = true`.

### Diffing previous → next scene (inside apply)

- A worker's `stepKey` changed → spawn one **step pulse**, a bright packet from HQ to that worker's zone (`traffic.ts`).
- `sidekick.mode` became `whistle` → build the dispatch trace to the target rig.
- A new worker id appeared → no special effect beyond the whistle. It just appears in its slot.
- A worker id disappeared → hide its rig on this frame (no exit animation in v1).

A step pulse is motion. If the loop is stopped when the pulse spawns, run the loop until the pulse
lands (about 1.5 s), then stop again. Use the same mechanism as camera flights: `transient` counts
keep the loop alive.
