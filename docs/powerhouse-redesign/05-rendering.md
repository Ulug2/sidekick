# 05 · Rendering, cost, overlay, accessibility

## Renderer and post-processing

```ts
renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;           // redraw shadows only when something moved

const rt = new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 });   // 4× MSAA
composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new Vector2(w/2, h/2), 0.62 /*strength*/, 0.45 /*radius*/, 0.82 /*threshold*/));
composer.addPass(new OutputPass());              // applies tone mapping and sRGB
```

Bloom feeds on values above about 1: window emissives, `glow()` materials with k > 1, faces at
×1.6, and packets at ×2.2. Copper and other metals stay under the threshold because the
environment intensity is low (0.32). That fixes the old "copper blooms up close" problem. If any
metal still flares, lower its roughness spread, not the bloom threshold.

Resize with a `ResizeObserver` on the stage: `renderer.setSize(w, h, false)`, `composer.setSize(w, h)`,
update the camera aspect, set `shadowsDirty = true`, then render once.

## The render loop (cost rule)

```ts
let running = false, lastFrame = 0, clock = 0, shadowsDirty = true, pendingOnce = false;
let transient = 0;                 // > 0 while a camera flight or step pulse is in progress

const wantLoop = () => !document.hidden && (scene.animates || transient > 0);

function frame(now) {
  if (!wantLoop()) { running = false; onStopped(); return; }
  requestAnimationFrame(frame);
  if (now - lastFrame < 1000/30 - 2) return;          // 30 fps cap
  const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000); lastFrame = now;
  stepTransients(now);                                  // flights, pulses
  if (scene.animates) { clock += dt; poseAll(clock, dt); shadowsDirty = true; }
  draw();
}
function kick() {                  // call after apply(), flights, pulses, visibility → visible
  if (wantLoop()) { if (!running) { running = true; lastFrame = 0; requestAnimationFrame(frame); } }
  else renderOnce();
}
function renderOnce() {            // coalesced single frame (state change, orbit drag, resize)
  if (running || pendingOnce) return;
  pendingOnce = true;
  requestAnimationFrame(() => { pendingOnce = false; if (!running) draw(); });
}
function draw() {
  if (shadowsDirty) { renderer.shadowMap.needsUpdate = true; shadowsDirty = false; }
  composer.render(); updateOverlay();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
controls.addEventListener('change', () => { if (!running) renderOnce(); });
```

- `OrbitControls` with `enableDamping = false`. Damping would need frames after the user lets go.
- Idle and paused scenes: `apply()` poses everything at the frozen clock, then calls `kick()`, which draws exactly one frame. After that nothing runs until a state change, a drag, a resize or the tab becoming visible.
- Hidden tab: the loop exits by itself on its next frame. Nothing renders until the tab is visible.
- All shadow casters on the card are static except the robots and the fan. The shadow map redraws only on animated frames and on scene changes.
- Do not add `setInterval` anywhere on this page.

## Camera

- Home: target (−8, 9, 6), distance 205, polar 1.08, azimuth 0.42. Limits are in 02.
- **Flight** to a robot (badge, canvas or list click): over 0.7 s with ease-in-out-quad, to `target = robot root + (0, 4·scale, 0)`, at distance 32 (Sidekick 46), polar 1.05, azimuth = robot yaw + 0.55. The camera ends in front of and a little to the side of the robot's face. Disable controls during the flight and count it in `transient`.
- Reduced motion: jump straight to the end.
- Buttons +, −, Reset view; on the focused canvas, + / − / 0 work, and arrows come from `controls.listenToKeyEvents(canvas)`.
- Picking: on pointerup with less than 5 px of movement since pointerdown, raycast against the visible rigs' meshes. Read `userData.robotId` and call `onPick(id)`.

## Overlay (HTML on top of the canvas, `aria-hidden`)

Keep the existing styles. These are the changes:

- **Badge** per worker: a number disc (26 px, glass) plus an optional tag pill. Its border is tinted by state (cyan working, amber needs you, red failed). Tags:
  - `?` amber `#f2b33d` with text `#261b00`;
  - `!` red `#ef5f55` with white text;
  - words (`done`, `stopped`, `finishing`, `no news`, `z z`) as glass pills in `#9fb0b6`.

  The badge sits 5 units above the head pivot (projected to the screen). Hide it when the point is behind the camera. Badges are `<button tabindex="-1">` so they are clickable but stay out of the tab order (the list is the keyboard path).
- **Speech bubble** above Sidekick (head + 5.6): a small "Sidekick" label, then the worker title. Use `textContent` only. Max 3 lines, max width 360 px.
- Hint, bottom left: "Drag to turn · scroll or pinch to zoom · click a robot".
- Update positions inside `draw()`, so they move only when frames are drawn.
- Rebuild the badge DOM only in `apply()`, not every frame.

## Page around the card

- The card stays dark in both themes. The page around it follows the theme, as before.
- Worker list rows: number, title, step or error, and a state pill. Use the pill texts from 04. Sidekick's row reads, for example, "Model call in flight · lifting on the HQ roof", "Started worker 3", "Paused by you", "Sleeping on the HQ roof".
- The demo page (`#demo`) keeps a button per state. Make the demo buttons cover: Idle, Thinking, Dispatch, Working, Needs you, Failed, Paused, Busy day, and **Overflow** (12 workers). Add the small render meter (live fps / stopped) on the demo page only.

## Accessibility and fallbacks

- The canvas is `aria-hidden="true"` but focusable (tabindex 0) for keyboard orbiting.
- The HTML list carries every fact the 3D view shows.
- `prefers-reduced-motion`: `animates` is forced false inside the view (deriveScene stays pure, and the view ORs in the media query). Poses use t = 0.37n, there are no flights, packets are hidden and fans stand still. State changes still redraw.
- WebGL unavailable, or context creation throws: `createPowerhouseView` returns null. The page puts a one-line note in the stage ("3D view is off because WebGL is not available. The worker list below shows everything.").
- Context lost (`webglcontextlost`): `preventDefault`, stop the loop, show the same note. On restore, rebuild the view.

## Disposal

`dispose()`:
- stops the loop;
- disconnects the ResizeObserver;
- removes the listeners;
- disposes every geometry, material and texture in the scene (traverse);
- disposes the PMREM render target, the composer targets and the renderer.

Call it on `pagehide`.

## Performance budget (check on a mid laptop with integrated graphics)

| Case | Target |
|---|---|
| Idle, tab visible | 0 frames per second after the first frame (verify with a rAF counter in the demo meter) |
| Busy, 7 workers | ≤ 30 fps cap holds, main-thread frame time < 12 ms |
| Draw calls | < 250. Instancing for buildings, fins, gold fingers, lamps, packets, rack lights, chips, caps |
| Memory after a busy day | stable: the rig pool disposes rigs unused for 60 s |

## Tests

- **Unit**: `deriveScene` tables (see 04).
- **View smoke test** (jsdom with a WebGL mock, or Playwright on the demo page):
  - Idle → the rAF callback count stops increasing after one frame.
  - Busy → the count increases. Hide the tab → it stops.
  - Reduced motion → no flights, and the frame count stays flat.
  - A title containing HTML renders as literal text in the badge, the bubble and the list.
- **Visual check**: Playwright screenshots of the demo states at 1280 × 720 and 390 × 844, saved as artifacts for review. Not pixel-diffed, because bloom varies by GPU.
