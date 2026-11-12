// The Silicon City view (docs/powerhouse-redesign/01, 05): draws a Scene from scene.ts. It never
// reads app state. Cost rule: frames are drawn only while the scene animates (or a camera flight /
// step pulse is in progress) and the tab is visible, capped at 30 fps; otherwise exactly one frame
// per change. Behind ?city=1 until the swap (06-build-plan M6).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Scene, SceneWorker } from "./scene.js";
import { CAMERA, G, SIDEKICK_SPOT, SPOTS, lanePosition, yawOf } from "./city-layout.js";
import { Materials, fontsReady } from "./materials.js";
import { buildCity, type City } from "./city.js";
import { buildCase, type Case } from "./case.js";
import { createTraffic, HAND } from "./traffic.js";
import { addSidekickProps, addWorkerProps, disposeRig, glowFor, lookFor, makeRobot, poseSidekick, poseWorker, setGlow, setLook, type Rig } from "./robot.js";

export interface CityView {
  apply(scene: Scene): void; // update the world for this scene, then draw (one frame or the loop)
  focusWorker(id: string): void; // camera flight to a robot ("sk" = Sidekick)
  resetView(): void;
  zoom(factor: number): void;
  dispose(): void;
}
export interface DrawInfo { running: boolean; frames: number; fps: number; calls: number }
const RIG_KEEP_MS = 60000; // a robot unused this long is disposed (a busy day must not leak GPU memory)

export function createCityView(stage: HTMLElement, opts: { onPick(id: string): void; reducedMotion: boolean; onDraw?(info: DrawInfo): void; overlay?: HTMLElement }): CityView | null {
  let renderer: THREE.WebGLRenderer;
  try {
    if (typeof WebGLRenderingContext === "undefined") return null;
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    if (!renderer.getContext()) return null;
  } catch { return null; }

  const canvas = renderer.domElement;
  canvas.className = "ph-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-hidden", "true");
  stage.prepend(canvas);
  const overlay = opts.overlay || stage;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap is removed in three 0.186 (it falls back to this)
  renderer.shadowMap.autoUpdate = false; // redrawn only when something moved
  renderer.info.autoReset = false; // count the draw calls of every pass in a frame (reset in draw())

  const world = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  world.environment = envRT.texture;
  world.environmentIntensity = 0.32; // a soft sheen on plastic and metal at night, under the bloom threshold
  world.fog = new THREE.Fog(0x060a12, 280, 1250);
  {
    const c = document.createElement("canvas"); c.width = 4; c.height = 256;
    const g = c.getContext("2d")!; const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#05070c"); grad.addColorStop(0.5, "#070b13"); grad.addColorStop(0.8, "#0a1018"); grad.addColorStop(1, "#060a12");
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    const sky = new THREE.CanvasTexture(c); sky.colorSpace = THREE.SRGBColorSpace; world.background = sky;
  }

  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 1, 3000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; // damping would need frames after the user lets go
  controls.minDistance = CAMERA.min; controls.maxDistance = CAMERA.max;
  controls.minPolarAngle = CAMERA.polarMin; controls.maxPolarAngle = CAMERA.polarMax;
  controls.listenToKeyEvents(canvas as unknown as HTMLElement);
  const home = CAMERA.home;
  const homeTarget = new THREE.Vector3(home.target.x, home.target.y, home.target.z);
  const homePos = () => new THREE.Vector3().setFromSpherical(new THREE.Spherical(home.radius, home.polar, home.azimuth)).add(homeTarget);
  camera.position.copy(homePos()); controls.target.copy(homeTarget); controls.update();

  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }); // 4× MSAA
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(world, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.62, 0.45, 0.82));
  composer.addPass(new OutputPass());

  world.add(new THREE.HemisphereLight(0x3a4a6a, 0x05070a, 0.7));
  const moon = new THREE.DirectionalLight(0xc4d2ff, 1.35);
  moon.position.set(70, 150, 110); moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  Object.assign(moon.shadow.camera, { left: -125, right: 125, top: 90, bottom: -90, near: 20, far: 420 });
  moon.shadow.camera.updateProjectionMatrix();
  moon.shadow.bias = -0.0005; moon.shadow.normalBias = 0.4;
  world.add(moon);
  const rim = new THREE.DirectionalLight(0x5fd4ea, 0.4); rim.position.set(-120, 60, -140); world.add(rim);

  const mats = new Materials();
  let city: City | null = null, pcCase: Case | null = null, sk: Rig | null = null;
  let scene: Scene | null = null;
  const rigs = new Map<string, Rig>();
  let active: { w: SceneWorker; r: Rig }[] = [];
  const badges = new Map<string, HTMLElement>();
  const traffic = createTraffic(world);
  const stepKeys = new Map<string, string>(); // each worker's last step key: a change sends a pulse
  let pulsing = false; // a pulse keeps the loop alive (transient) until it lands
  let bubble: HTMLElement | null = null;

  // ---------- the loop (05 › The render loop) ----------
  let running = false, lastFrame = 0, clock = 0, shadowsDirty = true, pendingOnce = false, disposed = false;
  const transient = { n: 0 }; // > 0 while a camera flight or step pulse runs
  let frames = 0, fpsCount = 0, fpsT = 0, fps = 0;
  const animates = () => !!scene?.animates && !opts.reducedMotion;
  const wantLoop = () => !document.hidden && (animates() || transient.n > 0);
  function frame(now: number) {
    if (disposed) return;
    // The loop ends: draw the state it ends on (a change from moving to still arrives while the loop
    // runs, so renderOnce() skipped it; without this the last moving frame would stay on screen).
    if (!wantLoop()) { running = false; if (!document.hidden) draw(); report(); return; }
    requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / 30 - 2) return; // 30 fps cap
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000); lastFrame = now;
    stepFlight(now);
    if (pulsing && !traffic.stepPulses(now)) { pulsing = false; transient.n--; }
    if (animates()) { clock += dt; poseAll(dt); shadowsDirty = true; }
    fpsCount++; if (now - fpsT > 1000) { fps = fpsCount; fpsCount = 0; fpsT = now; }
    draw();
  }
  function kick() { if (wantLoop()) { if (!running) { running = true; lastFrame = 0; requestAnimationFrame(frame); } } else renderOnce(); }
  function renderOnce() {
    if (running || pendingOnce || disposed) return;
    pendingOnce = true;
    requestAnimationFrame(() => { pendingOnce = false; if (!running && !disposed) { draw(); report(); } });
  }
  function draw() {
    if (shadowsDirty) { renderer.shadowMap.needsUpdate = true; shadowsDirty = false; }
    renderer.info.reset();
    composer.render();
    frames++;
    updateOverlay();
    const r = String(Math.round(camera.position.distanceTo(controls.target)));
    if (stage.dataset.radius !== r) stage.dataset.radius = r;
    report();
  }
  const report = () => opts.onDraw?.({ running, frames, fps: running ? fps : 0, calls: renderer.info.render.calls });

  // ---------- poses: everything from the scene and the animation clock ----------
  function poseAll(dt: number) {
    if (!city || !scene || !sk) return;
    const moving = animates();
    for (const { w, r } of active) {
      const still = !moving || w.finishing;
      const t = (still ? 0 : clock) + 0.37 * w.n; // frozen: each worker at its own fixed phase
      let x: number, z: number, yaw: number, outbound = true;
      if (w.slot!.zone === "lane") {
        const lp = lanePosition(w.phase, still ? 0 : clock);
        x = lp.x; z = lp.z; yaw = yawOf(lp.dir); outbound = lp.outbound;
      } else {
        const s = SPOTS[w.slot!.zone][w.slot!.index];
        x = s.x; z = s.z; yaw = yawOf(s.face);
      }
      r.root.position.set(x, G, z); r.root.rotation.y = yaw;
      poseWorker(r, w.activity, t, !still, outbound);
      setGlow(r, glowFor(w.activity, w.finishing, t));
    }
    const mode = scene.sidekick.mode;
    const target = mode === "whistle" ? active.find(a => a.w.id === scene!.sidekick.dispatchTo)?.r : undefined;
    const faceTo = target ? yawOf([target.root.position.x - SIDEKICK_SPOT.x, target.root.position.z - SIDEKICK_SPOT.z]) : undefined;
    const ph = poseSidekick(sk, mode, clock, moving, faceTo);
    city.hqLight.intensity = mode === "lift" ? 260 + 220 * ph : { whistle: 300, coach: 260, rest: 90, sleep: 45 }[mode];
    traffic.update(clock); // packets only show while live (setCounts)
    traffic.updateTrace(moving ? clock : 0);
    if (moving && dt) {
      city.fan.rotation.y += dt * (mode === "lift" ? 5 : 2.5);
      pcCase?.bgFans.forEach((f, i) => { f.rotation.z += dt * (1.6 + i * 0.3); });
      for (const { w } of active) if (w.activity === "write" && !w.finishing) { const tex = city.termTextures[w.slot!.index]; if (tex) tex.offset.y = (clock * 0.06) % 1; }
    }
  }

  // ---------- robots: the pool, the scene's workers on their spots ----------
  function rigFor(id: string): Rig {
    let r = rigs.get(id);
    if (!r) { r = makeRobot(id); addWorkerProps(r); world.add(r.root); rigs.set(id, r); }
    return r;
  }
  function placeRobots(s: Scene) {
    const now = performance.now();
    const keep = new Set(s.workers.map(w => w.id));
    active = s.workers.filter(w => w.slot).map(w => {
      const r = rigFor(w.id);
      r.root.visible = true; r.lastSeen = now;
      setLook(r, lookFor(w.activity));
      return { w, r };
    });
    for (const [id, r] of rigs) {
      if (keep.has(id)) continue;
      r.root.visible = false; // gone from the scene: hidden at once
      if (now - r.lastSeen > RIG_KEEP_MS) { disposeRig(r); rigs.delete(id); }
    }
    buildBadges();
  }

  // ---------- the overlay: one badge per robot (aria-hidden; the list is the accessible path) ----------
  function buildBadges() {
    for (const el of badges.values()) el.remove();
    badges.clear();
    for (const { w } of active) {
      const b = document.createElement("button");
      b.type = "button"; b.tabIndex = -1; b.className = "ph-label";
      Object.assign(b.dataset, { id: w.id, activity: w.activity, zone: w.slot!.zone, state: w.finishing ? "finishing" : w.activity === "ask" ? "needs" : w.activity === "fail" ? "failed" : ["read", "write", "apply", "start"].includes(w.activity) ? "working" : "idle" });
      const n = document.createElement("span"); n.className = "ph-n"; n.textContent = String(w.n); b.append(n);
      if (w.tag) { const t = document.createElement("span"); t.className = `ph-tag ph-tag-${w.tag === "?" ? "q" : w.tag === "!" ? "err" : "word"}`; t.textContent = w.tag; b.append(t); }
      b.title = `Agent ${w.n}: ${w.pill.text}`;
      b.addEventListener("click", () => { flyTo(w.id); opts.onPick(w.id); });
      overlay.append(b); badges.set(w.id, b);
    }
  }
  const v3 = new THREE.Vector3();
  function project(obj: THREE.Object3D, y: number, el: HTMLElement) {
    obj.localToWorld(v3.set(0, y, 0)); v3.project(camera);
    const ok = v3.z < 1 && Math.abs(v3.x) < 1.2 && Math.abs(v3.y) < 1.2;
    el.style.visibility = ok ? "visible" : "hidden";
    if (ok) { el.style.left = `${(v3.x * 0.5 + 0.5) * stage.clientWidth}px`; el.style.top = `${(-v3.y * 0.5 + 0.5) * stage.clientHeight}px`; }
  }
  function updateOverlay() {
    for (const { w, r } of active) { const b = badges.get(w.id); if (b) project(r.head, 5.0, b); }
    if (bubble && sk) project(sk.head, 5.6, bubble);
  }
  // The speech bubble above Sidekick while he dispatches: "Sidekick", then the worker's real title (text only).
  function setBubble(text: string | undefined) {
    if (!text) { bubble?.remove(); bubble = null; return; }
    if (!bubble) { bubble = document.createElement("div"); bubble.className = "bubble"; overlay.append(bubble); }
    const who = document.createElement("small"); who.textContent = "Sidekick";
    bubble.replaceChildren(who, document.createTextNode(text));
  }
  // Traffic for a scene: packet counts, step pulses for new steps, the dispatch trace.
  function applyTraffic(s: Scene) {
    traffic.setCounts(s.traffic, s.mood === "live" && !opts.reducedMotion);
    const now = performance.now();
    for (const w of s.workers) {
      const prev = stepKeys.get(w.id);
      stepKeys.set(w.id, w.stepKey);
      if (prev === undefined || prev === w.stepKey || opts.reducedMotion || !w.slot) continue;
      const route = w.slot.zone === "rack" || w.slot.zone === "terminal" ? "archive" : w.slot.zone === "lane" ? "docks" : null;
      if (!route) continue;
      traffic.pulse(route, now);
      if (!pulsing) { pulsing = true; transient.n++; }
    }
    for (const id of [...stepKeys.keys()]) if (!s.workers.some(w => w.id === id)) stepKeys.delete(id);
    const target = s.sidekick.mode === "whistle" ? active.find(a => a.w.id === s.sidekick.dispatchTo)?.r : undefined;
    traffic.setTrace(target ? HAND : null, target ? new THREE.Vector3(target.root.position.x, G + 9.5, target.root.position.z) : undefined);
    setBubble(s.sidekick.mode === "whistle" ? s.sidekick.bubble : undefined);
  }

  // ---------- camera flights (05 › Camera) ----------
  let flight: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; start: number } | null = null;
  function startFlight(p1: THREE.Vector3, t1: THREE.Vector3) {
    if (opts.reducedMotion) { camera.position.copy(p1); controls.target.copy(t1); controls.update(); renderOnce(); return; }
    if (!flight) transient.n++;
    flight = { p0: camera.position.clone(), t0: controls.target.clone(), p1, t1, start: performance.now() };
    controls.enabled = false; kick();
  }
  function stepFlight(now: number) {
    if (!flight) return;
    const k = Math.min(1, (now - flight.start) / CAMERA.flightMs), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(flight.p0, flight.p1, e); controls.target.lerpVectors(flight.t0, flight.t1, e); camera.lookAt(controls.target);
    if (k >= 1) { flight = null; transient.n--; controls.enabled = true; controls.update(); }
  }
  function flyTo(id: string) {
    const r = id === "sk" ? sk : rigs.get(id);
    if (!r || !r.root.visible) return;
    const wp = r.root.getWorldPosition(new THREE.Vector3());
    const target = wp.clone().add(new THREE.Vector3(0, 4 * r.scale, 0));
    const yaw = r.root.rotation.y + 0.55, dist = id === "sk" ? CAMERA.focusSidekick : CAMERA.focus;
    startFlight(target.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.sin(1.05) * dist, Math.cos(1.05) * dist, Math.cos(yaw) * Math.sin(1.05) * dist)), target);
  }

  // ---------- picking: a click (under 5 px of movement) on a robot ----------
  const ray = new THREE.Raycaster();
  let down: [number, number] | null = null;
  canvas.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerup", e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const b = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), camera);
    const meshes = [...(sk ? sk.meshes : []), ...active.flatMap(a => a.r.meshes)];
    const id = ray.intersectObjects(meshes, false)[0]?.object.userData.robotId as string | undefined;
    if (id) { flyTo(id); opts.onPick(id); }
  });
  canvas.addEventListener("keydown", e => {
    if (e.key === "+" || e.key === "=") view.zoom(0.8); else if (e.key === "-") view.zoom(1.25); else if (e.key === "0") view.resetView(); else return;
    e.preventDefault();
  });

  const onVisibility = () => { if (!document.hidden) kick(); };
  document.addEventListener("visibilitychange", onVisibility);
  controls.addEventListener("change", () => { if (!running) renderOnce(); });
  const resize = () => {
    const w = stage.clientWidth || 640, h = stage.clientHeight || 360;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    shadowsDirty = true; renderOnce();
  };
  const ro = new ResizeObserver(resize); ro.observe(stage);
  canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); running = false; });
  canvas.addEventListener("webglcontextrestored", () => { shadowsDirty = true; kick(); });

  // The city and the robots draw text on canvases: build them once the bundled fonts are loaded.
  fontsReady().then(() => {
    if (disposed) return;
    city = buildCity(world, mats); pcCase = buildCase(world);
    sk = makeRobot("sk", { body: 0xf1e4c6, trim: 0xb0946a, scale: 1.7 }); addSidekickProps(sk);
    sk.root.position.set(SIDEKICK_SPOT.x, SIDEKICK_SPOT.y, SIDEKICK_SPOT.z); world.add(sk.root);
    shadowsDirty = true;
    if (scene) view.apply(scene); else renderOnce();
  });

  const view: CityView = {
    apply(s) {
      scene = s;
      if (city) {
        city.setMood(s.mood); pcCase?.setMood(s.mood);
        placeRobots(s);
        poseAll(0); // at the current (or frozen) clock
        applyTraffic(s);
      }
      shadowsDirty = true;
      kick();
    },
    focusWorker(id) { flyTo(id); },
    resetView() { startFlight(homePos(), homeTarget.clone()); },
    zoom(f) {
      const off = camera.position.clone().sub(controls.target);
      camera.position.copy(controls.target).add(off.setLength(Math.max(CAMERA.min, Math.min(CAMERA.max, off.length() * f))));
      controls.update(); renderOnce();
    },
    dispose() {
      disposed = true; running = false;
      ro.disconnect(); document.removeEventListener("visibilitychange", onVisibility); controls.dispose();
      for (const el of badges.values()) el.remove();
      bubble?.remove();
      for (const r of rigs.values()) disposeRig(r);
      traffic.dispose();
      world.traverse(o => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          for (const v of Object.values(x)) if (v instanceof THREE.Texture) v.dispose();
          x.dispose();
        }
      });
      (world.background as THREE.Texture | null)?.dispose?.();
      envRT.dispose(); pmrem.dispose(); rt.dispose(); composer.dispose(); renderer.dispose();
      canvas.remove();
    }
  };
  resize();
  return view;
}
