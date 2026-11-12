# 04 · Connecting to the real agents (`scene.ts`)

This is the contract between the real Sidekick/worker state and what the city shows. Everything
here happens inside `deriveScene(state, now)`, which is pure. The 3D code only draws the `Scene`.

## Inputs deriveScene needs

Map these from the existing state types. **Do not invent fields.** If one is missing, add it where
the state is produced, or ask.

| Needed | Meaning | Probably comes from |
|---|---|---|
| `brainCallInFlight: boolean` | Sidekick's model call is running now | Sidekick brain state |
| `paused: 'user' \| 'spendCap' \| null` | Paused by the user or the spend cap | settings / spend meters |
| `sleepingUntil: number \| null` | Scheduled quiet hours ("Sleeping until 8:00 AM ET") | scheduler |
| `lastDispatch: { workerId, at } \| null` | When Sidekick last started a worker | dispatch log |
| `workers[]` | `id`, `n`, `title`, `state`, `step`, `error?`, `createdAt`, `updatedAt`, `endedAt?`, `dismissed`, `stepCount` (or the id of the last log entry) | worker records |
| `now: number` | Passed in (never `Date.now()` inside), so tests are deterministic | caller |

Worker `state` values from the current spec: `applying`, `reading`, `classifying`, `writing`,
`needs_you`, `failed`, `done`, `stopped`, `waiting`. "No news" is computed from `updatedAt`.

## Worker → activity

Apply these rules in order. The first match wins.

| # | Condition | Activity | Tag | List pill |
|---|---|---|---|---|
| 1 | `dismissed`, or `failed` for more than 24 h, or `done`/`stopped` with `endedAt` more than 30 s ago | (removed from the scene and the list's live section) | | |
| 2 | `failed` | `fail` | `!` | failed (red) |
| 3 | `needs_you` | `ask` | `?` | needs you (amber) |
| 4 | `done` | `done` | `done` | done (grey) |
| 5 | `stopped` | `stopped` | `stopped` | stopped (grey) |
| 6 | running state and `now − updatedAt ≥ 15 min` | `nonews` | `no news` | no news (grey) |
| 7 | `waiting` / queued | `wait` | `z z` | waiting (grey) |
| 8 | it is `lastDispatch.workerId` and `now − lastDispatch.at < 6 s` | `start` | | starting (cyan) |
| 9 | `applying` | `apply` | | applying (cyan) |
| 10 | `reading` or `classifying` | `read` | | reading (cyan) |
| 11 | `writing` | `write` | | writing (cyan) |

`finishing = paused !== null && activity ∈ {read, write, apply, start}`. The tag becomes
`finishing` and the pill becomes "finishing" (amber-gold `#d9a54a`).

`stepKey = String(stepCount)` (or the last log entry id). It changes on every new step, and the 3D
view turns each change into a step pulse.

## Sidekick → mode

| # | Condition | mode |
|---|---|---|
| 1 | `paused !== null` | `rest` |
| 2 | `lastDispatch` within 6 s and that worker is in the scene | `whistle` (`dispatchTo` = id, `bubble` = that worker's title, as plain text) |
| 3 | `brainCallInFlight` | `lift` |
| 4 | any worker activity ∈ {read, write, apply, start} | `coach` |
| 5 | otherwise (nothing runs, or `sleepingUntil` is set) | `sleep` |

Dispatch beats lifting on purpose: the 6-second dispatch moment is rare, and the whistle-and-point
explains why a new robot appeared.

## Mood, animates, chip, line

- `mood`: `'paused'` when paused; `'idle'` when the Sidekick mode is `sleep`; otherwise `'live'`.
- `animates = mood === 'live' && (sidekick.mode ∈ {lift, whistle, coach} || any worker ∈ {read, write, apply, start})`.
  - A lone `ask` or `fail` robot does not keep the loop alive. Its wave and sparks play only while something else runs; otherwise it shows a still pose (arm up, or slumped).
  - Paused never animates. The scene redraws once per state change.
- `chip` keeps the current texts: "Running · 4 working · 1 needs you", "Paused by you",
  "Spend cap reached (daily)", "Sleeping until 8:00 AM ET", "Idle".
- `line`: `['Sidekick is thinking:', <brain task summary>]`, `['Sidekick started worker 3:', title]`,
  `['Paused.', 'Workers finish the job they are on; nothing new starts.']`, `['Everyone is asleep.', …]`,
  or the overflow note "N more workers than there is room for on the card".

## Slots (`city-layout.ts`)

Assign slots inside deriveScene. Sort workers by `n` (needs-you first for the bench) so the result is
stable. Spots are world (x, z) on the board at ground y = G. The facing vector is (dx, dz).

| Zone | Activities | Capacity | Spots (x, z) → facing |
|---|---|---|---|
| `rack` | read | 3 | (−48, −14), (−48, −10), (−48, −6) → (−1, 0) |
| `terminal` | write | 2 | (−51, 6), (−51, 14) → (−1, 0) (each faces its own desk) |
| `lane` | apply | 4 | the courier path below, phases 0.05, 0.30, 0.55, 0.80 in slot order |
| `entrance` | start | 2 | (−40, 4), (−36, 4) → (0.4, 1) |
| `bench` | ask, done, stopped, nonews, wait | 5 | x −41, −37, −33, −29, −25 at z 51.5, seat 1.5 → (0, 1). Needs-you first, then the rest by `n` |
| `silos` | fail | 3 | (−73, 30), (−73, 18), (−73, −30) → (1, 0.45) |

No free slot → the worker goes to `overflow` and appears only in the list. The status line then says
"N more workers than there is room for on the card".

Courier path (ping-pong, 4.2 units/s). Outbound carries the crate:
`[[-40,3], [-40,46], [-14,46], [-14,53]]` (archive → down the x −40 street → dock street → dock spur).

Sidekick: `(0, ROOF, 1.2)` facing +z, on the HQ roof.

## Traffic (packets on roads)

Packets are a summary of real activity. They never appear when nothing runs. Each route gets a
packet count from the scene, and 0 hides it. Packets loop along the route at speed v, evenly spaced.

| Route | Path (x, z) | Colour | Active when | Count | v |
|---|---|---|---|---|---|
| `archive` | (0,−26) → (−26,−26) → (−26,0) → (−46,0) | cyan `#5fe3f5` | readers + writers > 0 | 3 + 2·(readers + writers), max 9 | 11 |
| `docks` | (−46,0) → (−64,0) → (−64,46) → (−14,46) → (−14,56), and (0,26) → (0,46) → (−14,46) → (−14,56) | amber `#ffc35a` | couriers > 0 | 3 + 2·couriers per path, max 8 | 10 / 9 |
| `plant` | (26,0) → (60,0) → (60,−46) → (0,−46) → (0,−26) | cyan | any working worker | 4 + working, max 8 | 12 |
| `ring` | (26,26) → (38,38) → (38,46) → (12,46) → (12,56) | cyan | Sidekick `lift` | 4 | 10 |

Packets are capsules r 0.32, len 0.9, oriented along the road, at y G + 0.55, colour ×2.2 so they
bloom. Use one InstancedMesh for all of them.

**Step pulses** are discrete. When a worker's `stepKey` changes, send one larger, brighter packet
(×3, radius 0.5) from HQ (0, 0) along the route that ends at that worker's zone (`archive` for
rack/terminal, `docks` for lane). It lands in about 1.5 s. It runs even when the loop was stopped
(see 05).

## Dispatch trace

When the mode is `whistle`, draw a dashed glowing arc from Sidekick's hand (−1.5, ROOF+8, 1.2) to
the target worker's head (spot x, G+9.5, spot z). It is a quadratic bezier with its control point at
the midpoint +22 up, drawn as `TubeGeometry(curve, 90, 0.22, 6)` with a `ShaderMaterial`:
`dash = step(0.45, fract(uv.x*26 − time*1.8))`, colour (0.5, 0.9, 0.96) × 2.2, additive. Rebuild it
when the target changes, and remove it when the mode leaves `whistle`.

The speech bubble (HTML overlay) shows "Sidekick" as a small label above the worker's real title
(`textContent`, max 3 lines, max width 360 px).

## Timers (keep the derived state true without polling)

After each derive, compute the **next deadline**, the earliest of:
- `lastDispatch.at + 6 s`;
- each `done`/`stopped` worker's `endedAt + 30 s`;
- each running worker's `updatedAt + 15 min`;
- each failed worker's `endedAt + 24 h`;
- `sleepingUntil`.

Schedule one `setTimeout` for it, and clear it on the next derive. No intervals.

## Unit tests (table-driven, in scene.test.ts)

- Every row of each table above, at least one case each, including the boundaries (exactly 6 s, 30 s, 15 min).
- Slot capacity and overflow: 5 readers → 3 on the rack, 2 in overflow.
- Bench order: needs-you first.
- Sort stability: shuffled input gives the same slots.
- `animates`: false for {only ask}, {only fail}, {paused with running workers}, {sleep}; true for {lift}, {one reader}.
- Text stays plain: a title like `<img onerror=…>` comes out unchanged as a string (the view must use `textContent`).
- Next-deadline calculation.
