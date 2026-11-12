// The Silicon City view (docs/powerhouse-redesign/01, 05): draws a Scene from scene.ts. It never
// reads app state. Cost rule: frames are drawn only while the scene animates (or a camera flight /
// step pulse is in progress) and the tab is visible, capped at 30 fps; otherwise exactly one frame
// per change. Behind ?city=1 until the swap (06-build-plan M6); robots arrive in M4, traffic in M5.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Scene } from "./scene.js";
import { CAMERA } from "./city-layout.js";
import { Materials, fontsReady } from "./materials.js";
import { buildCity, type City } from "./city.js";
import { buildCase, type Case } from "./case.js";

export interface CityView {
  apply(scene: Scene): void; // update the world for this scene, then draw (one frame or the loop)
  focusWorker(id: string): void; // camera flight (M4, when robots exist)
  resetView(): void;
  zoom(factor: number): void;
  dispose(): void;
}
export interface DrawInfo { running: boolean; frames: number; fps: number; calls: number }

export function createCityView(stage: HTMLElement, opts: { onPick(id: string): void; reducedMotion: boolean; onDraw?(info: DrawInfo): void }): CityView | null {
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
  let city: City | null = null, pcCase: Case | null = null;
  let scene: Scene | null = null;
  // The city draws text on canvases: build it once the bundled fonts are loaded.
  fontsReady().then(() => { if (disposed) return; city = buildCity(world, mats); pcCase = buildCase(world); shadowsDirty = true; if (scene) view.apply(scene); else renderOnce(); });

  // ---------- the loop (05 › The render loop) ----------
  let running = false, lastFrame = 0, clock = 0, shadowsDirty = true, pendingOnce = false, disposed = false;
  const transient = { n: 0 }; // > 0 while a camera flight or step pulse runs (M4, M5)
  let frames = 0, fpsCount = 0, fpsT = 0, fps = 0;
  const animates = () => !!scene?.animates && !opts.reducedMotion;
  const wantLoop = () => !document.hidden && (animates() || transient.n > 0);
  function frame(now: number) {
    if (disposed) return;
    if (!wantLoop()) { running = false; report(); return; }
    requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / 30 - 2) return; // 30 fps cap
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (animates()) { clock += dt; tick(dt); shadowsDirty = true; }
    fpsCount++; if (now - fpsT > 1000) { fps = fpsCount; fpsCount = 0; fpsT = now; }
    draw();
  }
  // What moves on the card in M2: the fan and the terminal screens (robots and traffic come later).
  function tick(dt: number) {
    if (!city || !scene) return;
    city.fan.rotation.y += dt * (scene.sidekick.mode === "lift" ? 5 : 2.5);
    pcCase?.bgFans.forEach((f, i) => { f.rotation.z += dt * (1.6 + i * 0.3); });
    const writers = scene.workers.filter(w => w.activity === "write" && !w.finishing && w.slot);
    // the screen scrolls with the animation clock, so a frozen scene draws the same every time
    for (const w of writers) { const t = city.termTextures[w.slot!.index]; if (t) t.offset.y = (clock * 0.06) % 1; }
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
    report();
  }
  const report = () => opts.onDraw?.({ running, frames, fps: running ? fps : 0, calls: renderer.info.render.calls });

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

  const view: CityView = {
    apply(s) {
      scene = s;
      if (city) {
        city.setMood(s.mood);
        pcCase?.setMood(s.mood);
        city.hqLight.intensity = { lift: 260, whistle: 300, coach: 260, rest: 90, sleep: 45 }[s.sidekick.mode];
      }
      shadowsDirty = true;
      kick();
    },
    focusWorker() { /* M4 */ },
    resetView() { camera.position.copy(homePos()); controls.target.copy(homeTarget); controls.update(); renderOnce(); },
    zoom(f) {
      const d = camera.position.distanceTo(controls.target);
      const nd = Math.max(CAMERA.min, Math.min(CAMERA.max, d * f));
      camera.position.sub(controls.target).setLength(nd).add(controls.target); controls.update(); renderOnce();
    },
    dispose() {
      disposed = true; running = false;
      ro.disconnect(); document.removeEventListener("visibilitychange", onVisibility); controls.dispose();
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
