# 02 · World: the city on the card and the PC case around it

Units are the same as before. The board is 200 (x) × 120 (z), lying flat, with its top at **y = 2**
(`G` below). +z faces the default camera. All shapes are primitives,
`RoundedBoxGeometry` (from three addons), and textures drawn in code on `<canvas>`. There are no
model files and no image assets.

Material shorthands (all in `materials.ts`):
- `std(color, {r, m})` = `MeshStandardMaterial` with roughness `r` (default 0.6) and metalness `m` (default 0.2).
- `glow(hex, k)` = `MeshBasicMaterial` with colour × k. Values above 1 feed the bloom.
- `windowMat({...})` = the lit-window shader (below).

## Scene setup

| Item | Value |
|---|---|
| Background | `CanvasTexture` vertical gradient: `#05070c` (0) → `#070b13` (.5) → `#0a1018` (.8) → `#060a12` (1) |
| Fog | `Fog(0x060a12, 280, 1250)` |
| Environment | `PMREMGenerator.fromScene(new RoomEnvironment(), 0.04)`, `scene.environmentIntensity = 0.32` (gives plastic and metal a soft sheen at night) |
| Camera | Perspective, FOV 38, near 1, far 3000 |
| Home view | target (−8, 9, 6), distance 205, polar 1.08 rad, azimuth 0.42 rad |
| Limits | distance 22–360, polar 0.18–1.38; target clamped over the board, height 0–30 |

### Lights

| Light | Values |
|---|---|
| Hemisphere | sky `#3a4a6a`, ground `#05070a`, 0.7 |
| Moon (key, shadows) | Directional `#c4d2ff` 1.35 from (70, 150, 110); shadow map 2048², PCFSoft, ortho camera L−125 R125 T90 B−90, near 20, far 420; bias −0.0005, normalBias 0.4; `shadowMap.autoUpdate = false` |
| Rim | Directional `#5fd4ea` 0.4 from (−120, 60, −140) |
| HQ roof light | Point `#ffd29a`, intensity 260, distance 70, decay 2, at (0, ROOF+9, 4). Driven by the Sidekick mode (see 03) |
| Plant light | Point `#39d0e8` 160 (20 when idle), distance 60, decay 2, at (83, 26, 0) |
| RAM light | Point `#7a5cff` 1.6, distance 0, decay 0, at (−300, MB+170, −120) |

## Lit-window shader (`windowMat`)

A `MeshStandardMaterial` patched with `onBeforeCompile`. It draws windows from **world position**,
so instanced buildings with any scale get correctly sized windows with no texture stretching.

- Vertex shader: pass `vWP` (world position) and `vWN` (world normal), using
  `modelMatrix * instanceMatrix` under `#ifdef USE_INSTANCING`.
- Fragment shader, after `#include <emissivemap_fragment>`:
  - Windows only on vertical faces: `side = 1 - step(0.6, abs(vWN.y))`.
  - Grid coordinate: horizontal axis = `vWP.z` on x-facing faces, otherwise `vWP.x`, divided by `uSize.x`; vertical = `(vWP.y − 2) / uSize.y`.
  - Window rectangle inside each cell: x 0.2–0.8, y 0.3–0.72.
  - On/off per cell: `hash(cell + face offset) > 1 − uDensity`.
  - Colour per cell: `uWarm` or `uCool` by a second hash. Brightness varies 0.55–1.25 by a third hash.
  - No windows in the bottom 1.4 units (ground floor).
  - `totalEmissiveRadiance += side * window * on * ground * colour * uLit * uBoost * brightness`.
- Uniforms: `uLit` (mood dimmer), `uWarm`, `uCool`, `uDensity`, `uSize` (vec2), `uBoost`.
- Keep a list of every window material so `setMood` can set `uLit` on all of them: 1.0 live, 0.8 paused, 0.5 idle.

| Use | color | density | uSize | boost | warm / cool |
|---|---|---|---|---|---|
| HQ tower | `#141d26` | 0.72 | 1.0 × 1.25 | 1.35 | `#ffe2b0` / `#8ee6f2` |
| Archive warehouses | `#1a1f27` | 0.6 | 1.5 × 1.1 | 1.1 | `#ffd28a` / `#6fd3ff` |
| Data halls | `#172028` | 0.5 | 1.2 × 1.2 | 1.0 | default |
| Filler skyline | `#161d25` | 0.42 | 1.05 × 1.25 | 1.0 | default `#ffc979` / `#86d8ff` |

## Roads (the card's traces)

The board traces become a routed road network. Roads are polylines in (x, z):

```ts
export const ROADS = [
  [[-94,46],[60,46]], [[-94,-46],[60,-46]],                 // front avenue (dock street), back avenue
  [[-94,0],[-26,0]], [[26,0],[60,0]],                         // crosstown, split by HQ
  [[-26,-26],[26,-26],[26,26],[-26,26],[-26,-26]],             // HQ ring
  [[0,26],[0,46]], [[0,-26],[0,-46]],
  [[-64,-46],[-64,46]], [[-40,0],[-40,46]], [[60,-46],[60,46]], [[-94,-46],[-94,46]],
  [[26,-26],[40,-40],[40,-46]], [[-26,-26],[-38,-38],[-38,-46]],   // 45° diagonals
  [[26,26],[38,38],[38,46]], [[-26,26],[-34,34],[-34,46]],
  [[-50,46],[-50,56]], [[-14,46],[-14,56]], [[12,46],[12,56]],     // dock spurs
];
```

### Board top

A `PlaneGeometry(200,120)` at y = G + 0.01, rotated −π/2 on x. It is drawn on two canvases at
**10 px per unit** (2000 × 1200). The mapping is `px = (x+100)*10`, `py = (z+60)*10`.

**Map canvas** (roughness 0.82, metalness 0.15):
1. Fill `#0a1215`, with a 2-unit grid in `#0f1a1e`.
2. About 170 short copper "alleys" (Manhattan polylines of 2–4 legs, 2–8 units each, 30% with a 45° jog), stroke `#5a3c22` 0.45 wide, ending in a via dot `#8a5a2c` r 0.55. Skip any that start within 3 units of a road.
3. Roads: stroke 4.2 wide `#2a3a42` (edge), then 3.6 wide `#151d23` (asphalt), then centre dashes 0.22 wide `#6f5a2e`, dash 1.6/1.6.
4. A via at every road end: disc r 2.6 `#1d262b` with a gold ring r 1.6 `#b88a3c`.
5. Dashed gold outline around the HQ package (−23…23).
6. Gold silkscreen, `JetBrains Mono`:
   - "SIDEKICK · PH-1 · REV 6" (2.6 units, right-aligned at (94, 54));
   - "ARCHIVE · VRAM 0–3" at (−62, −20);
   - "DOCKS · PCIe x16" at (−62, 50.5);
   - "POWER · VRM" at (−70, −56.5).

**Emissive canvas** (emissive white, intensity 1.0 live / 0.45 idle):
1. Black.
2. Road edges as glow lines: stroke 4.0 `#1d8fa3`, then 3.5 black on top, which leaves two thin cyan edges.
3. Centre dashes `#6a4612`.
4. Alleys `#2a1608`.
5. Via rings `#c98a2a`.

Board slab: `Box(200, 2, 120)` `#0b1316` at y 1, receiving shadows but not casting them. Gold edge
strips `glow(#c9a24a, 0.6)` along the front and back edges.

Wait for `document.fonts.ready` before drawing any canvas text.

## Districts

`ROOF = 35.9` is the top of the HQ roof deck.

| Part (card part) | Where | Build |
|---|---|---|
| **HQ podium** (GPU package) | (0, G+0.7, 0) | RoundedBox 40 × 1.4 × 40, r 0.5, `std(#10201c, r .5, m .3)`. Cyan frame: four thin boxes `glow(#46d6ea, 1.1)` along the top edges at ±19 |
| **HQ tower** (GPU die) | (0, G+1.4+16, 0) | RoundedBox 20 × 32 × 20, r 1.1, HQ window material |
| Roof deck | (0, ROOF−0.3, 0) | RoundedBox 19 × 0.6 × 19, `std(#1b2228, r .45, m .5)`. Railing: four boxes 0.22 thick at ROOF+0.9, ±9.3, `glow(#ffd9a0, 1.0)` |
| Roof gym | | Mat: RoundedBox 9 × 0.25 × 6 `std(#c2543f, r .8, m 0)` at (0, ROOF+0.12, 1.5). Plate rack at (−6.5, ROOF, −5.5): post r 0.15 h 3.4, three plates (r 1.1, 0.95, 0.8; h 0.35) alternating `#ff7a5c` / `#2b3238` |
| HQ signs | +z face and +x face, y ROOF−3.2 | Plane 14 × 2.6, `signTex('SIDEKICK', '#ffe2b0')`, colour ×1.6 |
| **Archive warehouses** (left VRAM) | (−47, G+2.75, ±27) | RoundedBox 17 × 5.5 × 7, r 0.5, archive window material. Signs "ARCHIVE A" / "ARCHIVE B" (mono, `#8fe6f5`, ×1.4), plane 9 × 1.7 at y G+6.5 on the +z face |
| **Data rack** (readers) | x −54, z −16…−4 | Two uprights 1.8 × 7 × 0.4 at z −15.5 and −4.5. Four shelves 1.8 × 0.2 × 11. On each shelf, 9 lit blocks 0.8 × 0.9 × 0.8 at x −53.6, spaced 1.12 (InstancedMesh, `MeshBasicMaterial`, per-instance colour: 70% `#2fc7dd`, 30% `#7a5cff`, × 0.5–1.6). Metal `std(#2a3238, m .7, r .35)` |
| **Terminals** (writers) | two desks, z 6 and z 14, x −54.5 | Each: desk RoundedBox 3 × 2.6 × 5.4 `#252d33`; monitor housing 0.8 × 3.4 × 5 at x −55.2, y G+4.9; screen plane 4.5 × 3 at x −54.75 facing +x; keyboard strip `glow(#39d0e8, 0.5)` 1.4 × 0.15 × 3.2 at (−53.4, G+2.68). Screen texture: 256 × 512 canvas of cover-letter-like lines in `#59e3c4` (every 7th line `#ffd28a`), `repeat (1, 0.5)`, `wrapT` repeat, `offset.y` scrolls at 0.06/s while that terminal's writer is animating |
| **Data halls** (right VRAM) | (40, G+5, ±13) | RoundedBox 12 × 10 × 9, r 0.6, data-hall window material |
| **Heat pipes** | z ±2.6 | Tube r 1.1: straight from (10, 22) to (64, 22), then a quadratic bend through (71, 22) down to (71, 17). Copper `std(#b8713f, m 1, r .42)`. Posts r 0.5–0.6, h 20 at x 24, 38, 52 `std(#5b646a, m .8, r .35)` |
| **Power plant base** (fin stack) | (83, G+2, 0) | RoundedBox 28 × 4 × 82 `std(#1a2126, r .55, m .5)`, cyan strip on the front edge |
| Fins | x 83, y G+10 | InstancedMesh, 31 boxes 24 × 12 × 0.45, z = −39 + i·2.6, `std(#a3acb2, m .85, r .32)` |
| **Turbine fan** | (83, G+17.2, 0) | Hub cylinder r 3.4 h 1.4; 9 blades RoundedBox 12 × 0.35 × 4 at radius 8.2, pitched 0.35 rad, `#15181a`; ring torus r 14.6 tube 0.35 `glow(#39d0e8)` with ×1 live, ×0.35 paused, ×0.15 idle. Spins (rotation.y) 5 rad/s with Sidekick `lift`, 2.5 otherwise when live, 0 when not animating |
| **Substations** (power stages) | x −63…63 step 14, z −53.5 | RoundedBox 8 × 5 × 6, r 0.8, `std(#30363b, m .7, r .35)`, with a cyan band `glow(#39d0e8, 0.8)` at y G+3.6 |
| **Silos** (capacitors) | x −88 and −82, z −44…44 step 11, skipping \|z\| < 5 | Cylinder r 2.3 h 7 `#251f37`, dome cap `#8a8f93` metal, violet ring `glow(#9a7cff, 0.9)` at y G+5.2 |
| **City wall** (display bracket) | x −98 | Wall segments RoundedBox 2.6 × 7 × (len) `std(#59636a, m .75, r .38)`, with gates at z −36, −12, 12, 36 (9 wide). Each gate has a lintel 2.6 × 1.6 × 9 at y G+6.2 and an inner glow plane 9 × 5.4 `glow(#2a6cff, 0.9)` at x −96.65 facing +x |
| **Docks** (PCIe fingers) | z 57.4, x −64…24 | InstancedMesh, 41 RoundedBox 1.3 × 0.4 × 4.6, step 2.2, gold `std(#d4a23c, m 1, r .28)` |
| Dock bench | (−33, G+1.25, 51.5) | RoundedBox **24** × 0.55 × 2.4 (`#6d5135`), legs at the ends. Seat top = G + 1.5. Holds 5 seats (see 04) |
| Dock lamps | (−46, 53), (−20, 53) | Post r 0.18 h 5, lamp sphere r 0.5 `glow(#ffc35a, 2)` |

## Filler skyline

Fill the remaining land with instanced buildings using a seeded PRNG (mulberry32) so the city is the
same on every load.

- Grid: x −90…92, z −56…56 in steps of 6.4, jitter ±0.8. Footprint w and d each 3.2–5.4.
- Skip a candidate if any of these is true:
  - it is off the board (|x| + w/2 > 97 or |z| + d/2 > 58);
  - it overlaps an exclusion rectangle (list below), using margin max(w, d)/2;
  - it is within max(w, d)/2 + 2.3 of a road;
  - it fails a 12% random skip.
- Height: `3 + rnd*7 + near*rnd*15`, where `near = max(0, 1 − dist(x,z)/75)`. Cap at 5.5 where −66 < x < −30 (keeps the archive robots visible) and at 7 where z > 30 (keeps the docks visible).
- Exclusion rectangles `[xmin, xmax, zmin, zmax]`:
  `[-24,24,-24,24]`, `[-60,-34,-20,20]`, `[-57,-37,-32,-22]`, `[-57,-37,22,32]`,
  `[-70,32,47.5,60]`, `[-93,-77,-50,50]`, `[-100,-92,-60,60]`, `[64,100,-46,46]`,
  `[32,48,-21,21]`, `[-72,72,-60,-49.5]`, `[-80,-66,14,38]`, `[-80,-66,-38,-22]`, `[20,66,-5,5]`.
- One InstancedMesh: `RoundedBoxGeometry(1,1,1,2,0.1)` scaled per instance, filler window material. Instance colours cycle through `#161d25 #1b2129 #141a21 #1d1b26 #172226`. Casts and receives shadows.
- Roof AC units: one per building, size 0.35w × 0.7 × 0.3d, `#3a4249`.
- Red aircraft lights: a sphere r 0.28 `glow(#ff4a4a, 2.2)` on every building taller than 12.

Street lamps: along every road segment, every 9 units, offset 2.6 to alternating sides. Skip lamps
inside the HQ (|x|, |z| < 23) or off the board. Posts are r 0.1–0.12, h 2.4, `#3a4248`. Heads are
r 0.3 `glow(#ffd28a, 2)`. Use two InstancedMeshes.

## PC case background (`case.ts`)

Everything here is static, and **nothing casts shadows** (the shadow map covers only the card).
`MB = −70` is the motherboard surface.

| Part | Where | Build |
|---|---|---|
| Motherboard | Plane 2400 × 2400 at y MB | Map: 2048² canvas, `#071014` with a 32-px grid `#0c1a1f`, 260 trace polylines (80% copper `#5a3c22`, 20% `#1d6f7e`, 1.5–4 px) ending in vias `#9a6a30`, and gold labels ("SK-Z890 · MAINBOARD", "PCIE_1 x16", "DIMM_A1 A2 B1 B2", "CPU_FAN"). Emissive: 1024² canvas of 90 faint traces `#0f5b68` / `#3b2a7a`, intensity 0.9 |
| Standoffs | (±92, ±52) | Brass cylinders r 2.2–2.6 from MB to G, `std(#b08a4a, m 1, r .35)` |
| PCIe slot | (−20, MB+4.5, 66) | RoundedBox 104 × 9 × 12, `#111417` |
| Riser | plane 90 × (G−MB−4) at (−20, mid, 61), tilted −0.12 rad on x | 512 × 256 canvas of vertical gold lanes (`#6a4f22`, every 4th `#ffcf6a`), used as both map and emissiveMap, intensity 0.55, double-sided |
| RAM sticks ×4 | x = −330 + i·30, z −170 | Body RoundedBox 12 × 150 × 380 `std(#1b2026, r .4, m .75)` at y MB+75. Light bar box 12.6 × 7 × 382 at y MB+153, gradient canvas cyan `#39d0e8` → violet `#7a5cff` → pink `#ff6fb5` → cyan, ×1.5. Label plane 180 × 17 "SK-DDR5 · 6400" on the +x side. Slot box 14 × 10 × 400 at the base |
| CPU cooler | group at (−120, MB, −380) | Base RoundedBox 90 × 14 × 90. 46 fins 150 × 1.4 × 110 stacked from y 40 every 4.4. Five copper pipes r 3, h 210, at x −40…40 step 20, z −10. Top cap 154 × 6 × 114 with a "SIDEKICK" sign lying flat. Case fan r 62 (cyan ring) on the +z face at (0, 150, 62) |
| Back wall | Plane 2600 × 1400 at (0, MB+600, −600) | Perforated steel: a 256² canvas of staggered dark holes on `#0d1318`, repeat 26 × 14, `std(white, r .6, m .6)` |
| Exhaust fans | (−430, MB+175, −592), (−160, MB+175, −592) | Case fans r 120, rings violet `#7a5cff` and cyan `#39d0e8` |
| I/O shield | (250, MB+170, −594) | RoundedBox 150 × 240 × 6 metal, six port glows 40 × 14 alternating `#2a6cff` / `#39d0e8` ×0.7 |
| Cable bundles | five tubes, r 3.6 | CatmullRom (560+o, MB+420, −320) → (500+o, MB+260, −260) → (420+o, MB+90, −150) → (360+o, MB+8, −90), o = i·9. Sleeve `std(#15181c, r .75, m .05)`. Two cyan cable combs. 24-pin plug block 70 × 12 × 30 at (378, MB+6, −90) |
| Board parts | random within x ±900, z −580…780 | 90 chips (RoundedBox, w 14–54, h 3–9, `#0e1114`), 160 capacitors (cylinders r 3–7, h 8–22, `#231e33`). Keep clear of the card footprint (\|x\| < 170 and \|z\| < 120), the RAM area and the cooler. Seven VRM heatsinks 26 × 34 × 90 at x −230 + i·30, z −260 |
| Dust | 700 points in x ±700, y MB…MB+420, z −700…400 | `PointsMaterial` `#6fd8ea`, size 1.6, opacity 0.35, additive, no depth write. Static |

**Case fan** helper: a frame RoundedBox (2.3r)² × 10 with a dark disc behind, a rotor group
(hub r 0.24r plus 7 blades RoundedBox 0.78r × 0.3r × 1.2 at radius 0.55r, pitched 0.45), and an
RGB ring torus r 1.03r, tube 0.035r, ×1.6. Rotors spin on z at (1.6 + i·0.3) rad/s, **only when
the scene animates**.

## Mood (`setMood`, called by `apply`)

| | live | paused | idle |
|---|---|---|---|
| Window `uLit` | 1.0 | 0.8 | 0.5 |
| Board emissive | 1.0 | 1.0 | 0.45 |
| Fan ring | ×1 | ×0.35 | ×0.15 |
| Plant light | 160 | 160 | 20 |
| Packets | per traffic counts | hidden | hidden |
