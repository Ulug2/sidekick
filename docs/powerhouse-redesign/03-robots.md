# 03 · Robots (`robot.ts`, replaces `alien.ts`)

Style: cute and round. Each robot has rounded boxes, a big screen face, stubby legs, mitten hands
and an antenna light. Workers are all the same off-white robot. Sidekick is a bigger cream foreman
with a coral headband.

## Rig (units; worker ≈ 9 tall; feet at y 0; faces +z)

```
root (Group)                 position = spot on the board, rotation.y = facing (set by gpu3d)
└─ inner (Group)             scale = 1 (workers) / 1.7 (Sidekick); position.y used for sitting/bobbing
   ├─ leg L/R (pivot)        at (±0.70, 2.0, 0)
   │   ├─ capsule r .45 len .7          at y −0.80   trim
   │   └─ foot RoundedBox 1.0×.55×1.35 r .25 at (0, −1.72, 0.18)   body
   └─ torso (pivot)          at y 2.0 (the hips)
       ├─ body RoundedBox 2.6×2.4×2.0 r .55  at y 1.3      body
       ├─ belly light Circle r .34 at (0, 1.2, 1.012)       glow (state colour)
       ├─ arm L/R (pivot)    at (±1.62, 2.2, 0)
       │   ├─ capsule r .36 len .85 at y −0.72              trim
       │   └─ hand sphere r .5 at y −1.5                    body     (arm reach L = 1.5)
       └─ head (pivot)       at y 2.7 (the neck)
           ├─ head RoundedBox 3.8×3.0×2.8 r .62 at y 1.5     body
           ├─ face Plane 2.55×1.75 at (0, 1.45, 1.405)       face material (canvas)
           ├─ ears: cylinders r .42 h .3 at (±1.98, 1.5, 0), rotated z π/2   trim
           ├─ antenna stem cylinder r .08 h .9 at y 3.45     trim
           └─ antenna ball sphere r .32 at y 4.0             glow (state colour)
```

Keep the head's corner radius at 0.62 or less. With a larger radius, the flat front of the head
gets narrower than the face plane, and the face floats in front of the curved edges.

Materials, one set per rig:
- body `std(#e8ecef, r .38, m .05)`; trim `std(#6c8794, r .45, m .25)`.
- Sidekick body `#f1e4c6`, trim `#b0946a`.
- `glowMat` = `MeshBasicMaterial`, shared by the antenna ball and belly light. Set colour × intensity.
- Face material = `MeshBasicMaterial({ map: CanvasTexture, transparent: true })`. Its colour scalar is the face brightness (1.6 normal, 0.9 asleep), which pushes the face into bloom.

Every mesh casts and receives shadows, except the face, belly and antenna ball. Set
`userData.robotId` on every mesh so picking can find the rig.

## Face screen (canvas 256 × 176)

Background: a rounded rect (radius 34) filled `#03080b`, with faint scanlines (`#8fe6f5` at 7%
alpha, every 6 px). Glyphs use the expression colour with `shadowBlur` 16 (6 when asleep), round
caps. Eye centres are at x 86 and 170.

| Expression | Drawing | Used by |
|---|---|---|
| `eyes` | two vertical pills 26 × 54 at y 86 | Sidekick resting, coach |
| `focus` | two horizontal pills 40 × 20 at y 90 | courier, Sidekick lift (top of rep) |
| `down` | two pills 34 × 18 at y 108 | writer (looking at the keyboard) |
| `scan` | one visor bar 180 × 24 at y 84, plus a white highlight pill 26 × 14 at x 150 | reader |
| `happy` | two arcs r 20 at y 104, from 1.12π to 1.88π, width 13 | worker starting |
| `strain` | `>` `<` chevrons (68,60)→(100,82)→(68,104), mirrored, plus a flat mouth | Sidekick lift (bottom of rep) |
| `blow` | chevrons plus a small "o" mouth r 10 at (128, 132) | Sidekick whistle |
| `q` | "?" in Sora 700 118 px | needs you |
| `bang` | "!" in Sora 700 118 px | failed |
| `check` | ✓ polyline (82,92)→(114,122)→(176,58), width 17 | done |
| `stopped` | two filled squares 30 × 30 at y 88 | stopped |
| `sleep` | two flat lines y 104 plus a small "z" (30 px at 188,62) and a smaller "z" (22 px at 210,40) | wait, no news, Sidekick asleep |
| `off` | background only | (spare) |

Colours: cyan `#39d0e8` (working), amber `#f2b33d` (needs you), red `#ef5f55` (failed),
grey `#9db0b6` (done, stopped), dim teal `#4f7a86` (asleep), Sidekick face `#8ee6f2`, Sidekick
resting `#d9a54a`.

Redraw the canvas **only when the expression, colour or brightness changes**. Cache the last key
per rig. Lift switches between `focus` and `strain` twice per rep, which is fine.

## Antenna and belly (state colour)

| State | Colour | Intensity |
|---|---|---|
| working (read, write, apply, start) | `#39d0e8` | 1.3 + 0.5·sin(3t) |
| needs you | `#f2b33d` | 1.2 + 0.6·sin(2t) (slow pulse) |
| failed | `#ef5f55` | 2.0 |
| done / stopped | `#9db0b6` | 0.9 |
| finishing (paused while running) | `#d9a54a` | 1.4 |
| asleep (wait, no news) | off | 0 |
| Sidekick | `#ffd9a0` | lift 1.4–2.2 with the rep, whistle 1.8, rest `#d9a54a` 0.8, sleep 0 |

When the loop is not running, evaluate the pulses at the frozen clock. They stay still.

## Pose system

`resetPose(rig)`: zero all pivot rotations, set `inner.position = 0` and `torso.position.y = 2.0`.
Every pose starts from reset. Poses are pure functions `(rig, t, slotInfo) => void`, where `t` is the
animation clock plus `0.37 × n` (desynchronises the workers).

Arm maths: a pivot rotated by θ on x points the arm along (0, −cos θ, −sin θ). So θ = 0 hangs down,
θ = −π/2 points forward, and θ = −π points straight up. The hand sits 1.5 along that direction from
the shoulder. For splay, `rotation.z = a·side` (side = −1 left, +1 right; positive a goes outward).

`sitPose(rig, seatHeight)`: legs `rotation.x = −1.5` (forward), `inner.position.y = (seat − 1.55) × scale`.
Use seat 1.5 on the dock bench and 0.45 on the ground or roof.

### Worker poses

| Activity | Pose | Motion (period) | Props |
|---|---|---|---|
| read | stand facing the rack (−x) | head x = 0.16·sin(1.8t) − 0.05, head y = 0.22·sin(0.9t); right arm −0.7; torso bob 0.04 | **scan beam**: open cone r 1.7, length 5.6, apex at the face (0, 1.45, 1.45) pointing +z, scaled y 0.4 (a flat fan); additive cyan ×0.7, opacity 0.22–0.34 flicker, no depth write, double-sided. Child of the head, so it sweeps with it |
| write | stand at a terminal (−x) | head x 0.28; arms x = −1.0 + 0.12·sin(14t + side·π), z ±0.08 | the terminal screen scrolls |
| apply | walk the lane | position from the lane path (ping-pong, 4.2 u/s); legs ±0.55·sin(7.5t); inner bob 0.12·\|sin\|; torso lean 0.06. Outbound: arms −1.25 holding the crate. Return: arms swing ±0.45, no crate | **crate**: RoundedBox 1.9 × 1.3 × 1.3 `#ffb547` with an "APPLY" label, child of the torso at (0, 2.25, 1.75); visible only outbound |
| start | stand at the archive entrance, facing the camera side | hop: inner y 0.18·\|sin(3.2t)\|; right arm −2.7, waving z 0.3 + 0.2·sin(6t) | |
| ask | sit on the bench | right arm −2.9, waving z 0.25 + 0.28·sin(4.5t); left arm −0.6 | |
| fail | sit on the ground by the silos | torso x −0.3 (leaning back); head x 0.5, z 0.12; arms z ±0.55, x 0.2 | **sparks**: 6 spheres r 0.13 `glow(#ffb067, 3)` around the head. Each frame, show a sphere when a hash of floor(t·10) + i is above 0.45, at a hash-driven position. Hidden when not animating |
| done | sit on the bench | arms −0.25 | |
| stopped | sit on the bench | arms −0.25, head x 0.1 | |
| nonews / wait | sit on the bench, asleep | torso x 0.16, head x 0.4, arms −0.15 | |
| finishing | the activity's pose at its frozen phase (t = 0.37n), no motion | | amber antenna, tag "finishing" |

### Sidekick (scale 1.7, root at (0, ROOF, 1.2), faces +z)

Extras:
- **Headband**: RoundedBox 3.95 × 0.48 × 2.95 r 0.2, `#ff6b55`, child of the head at y 2.55.
- **Whistle**: cylinder r 0.22–0.26 h 0.7, chrome, child of the head at (0, 0.45, 1.75). Visible only in `whistle`.
- **Barbell**: bar r 0.14 len 7.4 chrome; plates r 1.15 (coral `#ff7a5c`) at ±2.9 and r 0.85 (dark `#2b3238`) at ±3.35, all rotated z π/2. Child of the torso. Visible only in `lift`.

| Mode | Pose | Notes |
|---|---|---|
| `lift` | Overhead press. `ph = 0.5 − 0.5·cos(2πt/1.6)`; arms θ = −1.75 → −3.0 with ph, splay 0.12; bar position = (0, 2.2 − 1.5·cos θ, −1.5·sin θ); torso y = 2.0 − 0.28·(1 − ph) (a small squat) | face `strain` when ph > 0.65, otherwise `focus`; HQ light 260 + 220·ph; antenna 1.4 + 0.8·ph |
| `whistle` | Turns to face the target worker (root.rotation.y = atan2(dx, dz)). Right arm points: x −2.05 + 0.08·sin(6t), z 0.1. Left arm to the mouth: x −2.4, z 0.9 | face `blow`; speech bubble with the task's real title; dispatch trace; HQ light 300 |
| `coach` | Stand. Head looks around: y = 0.3·sin(0.5t). Arms relaxed −0.15 | face `eyes`; antenna 1.4. Only animates when the loop is already running for workers |
| `rest` | sitPose(0.45); torso 0.1; arms −0.9 (hugging knees) | face `eyes` amber, ×1.1; HQ light 90 |
| `sleep` | sitPose(0.45); torso 0.18; head 0.38; arms −0.3 | face `sleep` ×0.9; antenna off; HQ light 45 |

The spec's push-ups and sit-ups were hard to read. Lifting a barbell reads clearly from far away,
and the robots' jobs now carry the "what is it doing" meaning.

## Far view: beacons (optional milestone)

At the home distance a worker is about 30 px tall. With its badge it reads fine, so v1 can ship
without level of detail. If labels crowd or the robots get lost:

- Beyond 95 units from the camera, swap the robot for a **beacon**: a hover puck (cylinder r 2.8 h 1.2, `#0e1416`) with a state-colour ring (torus r 3.6). It floats 3 above the spot and turns slowly while working.
- Under 70 units, show the robot. Crossfade between 70 and 95 with material opacity.
- Decide per rig per frame, using the camera distance to the root.
