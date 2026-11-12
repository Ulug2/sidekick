// The 3D Powerhouse (docs/DESIGN.md §1, "3D"): a dark graphics card. Sidekick stands on the GPU die;
// workers are on the parts that match what they do (scene.ts decides that; gpu-layout.ts says
// where): applying = pull-ups on the copper heat pipe, reading/writing = on the VRAM chips,
// done/waiting/needs you = sitting on the PCIe edge, failed = by the capacitors. Far away each
// worker is a glowing core; zoom in and it becomes the alien doing its exercise.
// Renders only while something moves (and the tab is visible); otherwise once per change.
// Without WebGL it keeps the labels (data only) and says so; the worker list carries everything.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Figure, Scene } from "./scene-gym.js";
import { BOARD, CAMERA, DIE, FOCUS_AZIMUTH, HEATPIPE, SIDEKICK, alienWeight, clampPolar, clampRadius, clampTarget, orbitPosition, placeFigures, type Placed, type Spot } from "./gpu-layout.js";
import { makeAlien, pose, setOpacity, type Alien, type AlienPose } from "./alien.js";

export interface PowerhouseView {
  gl: boolean;
  update(scene: Scene): void;
  onPick(cb: (id: string) => void): void;
  zoom(factor: number): void;
  reset(): void;
  focus(id: string): void;
  setLive(on: boolean): void;
  distance(): number;
}

const STATE_COLOR = { working: 0x39d0e8, needs: 0xf2b33d, failed: 0xe5534b, idle: 0x9db0b6, finishing: 0xd9a54a };
const POSE: Record<Figure["pose"], AlienPose> = { pull: "pull", push: "push", situp: "situp", sit: "sit", raise: "raise", slump: "slump" };

export function hasWebGL(): boolean {
  if (typeof WebGL2RenderingContext === "undefined" && typeof WebGLRenderingContext === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const ctx = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    ctx?.getExtension("WEBGL_lose_context")?.loseContext(); // don't keep the probe's context
    return !!ctx;
  } catch { return false; }
}

// ---------- textures drawn in code ----------
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
// The board: dark PCB with copper and cyan traces and vias; seeded so it looks the same each load.
function boardTextures(): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const paths: [number, number][][] = [];
  for (let i = 0; i < 70; i++) {
    let x = rnd() * 2000, y = rnd() * 1200; const p: [number, number][] = [[x, y]];
    for (let k = 0; k < 4; k++) { const d = 60 + rnd() * 260; const dir = Math.floor(rnd() * 8) * Math.PI / 4; x += Math.cos(dir) * d; y += Math.sin(dir) * d; p.push([x, y]); }
    paths.push(p);
  }
  const drawPaths = (g: CanvasRenderingContext2D, color: string, width: number, alpha: number) => {
    g.strokeStyle = color; g.lineWidth = width; g.globalAlpha = alpha; g.lineCap = "round"; g.lineJoin = "round";
    for (const p of paths) { g.beginPath(); p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); }
    g.fillStyle = color;
    for (const p of paths) for (const [x, y] of [p[0], p[p.length - 1]]) { g.beginPath(); g.arc(x, y, width * 2.2, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
  };
  const map = canvasTexture(2000, 1200, g => {
    g.fillStyle = "#0a1210"; g.fillRect(0, 0, 2000, 1200);
    g.strokeStyle = "#13201c"; g.lineWidth = 1;
    for (let x = 0; x < 2000; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 1200); g.stroke(); }
    for (let y = 0; y < 1200; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(2000, y); g.stroke(); }
    drawPaths(g, "#8a5a2c", 5, 0.75);
    g.fillStyle = "#c9a24a"; g.font = "600 34px Inter, system-ui, sans-serif"; g.globalAlpha = 0.55;
    g.fillText("SIDEKICK  ·  PH-1  ·  REV 6", 1320, 1150); g.globalAlpha = 1;
  });
  const glow = canvasTexture(2000, 1200, g => { g.fillStyle = "#000"; g.fillRect(0, 0, 2000, 1200); drawPaths(g, "#2fb6cc", 2.5, 0.9); });
  return { map, glow };
}
function dieTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, g => {
    g.fillStyle = "#000"; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      g.fillStyle = (i + j) % 3 ? "#5a4a2a" : "#2a8fa0";
      g.fillRect(36 + i * 56, 36 + j * 56, 44, 44);
    }
    g.fillStyle = "#f2dcae"; g.font = "700 40px Inter, system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("SIDEKICK", 256, 270);
  });
}
function chipTexture(label: string): THREE.CanvasTexture {
  return canvasTexture(256, 192, g => {
    g.fillStyle = "#101112"; g.fillRect(0, 0, 256, 192);
    g.fillStyle = "#8f9498"; g.font = "600 26px Inter, system-ui, sans-serif"; g.textAlign = "center";
    g.fillText(label, 128, 100); g.font = "500 18px Inter, system-ui, sans-serif"; g.fillText("16Gb · 28 Gbps", 128, 132);
    g.beginPath(); g.arc(30, 30, 9, 0, Math.PI * 2); g.fill();
  });
}

// ---------- the card ----------
function buildBoard(root: THREE.Group): { die: THREE.MeshStandardMaterial; fan: THREE.Group; fanRing: THREE.MeshStandardMaterial; dieLight: THREE.PointLight } {
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; root.add(m); return m;
  };
  const tex = boardTextures();
  add(new THREE.BoxGeometry(BOARD.w, BOARD.top, BOARD.d), std({ map: tex.map, emissiveMap: tex.glow, emissive: 0x2fb6cc, emissiveIntensity: 0.35, roughness: 0.78, metalness: 0.15 }), 0, BOARD.top / 2, 0, false);
  // GPU package and die
  add(new THREE.BoxGeometry(40, 1.4, 40), std({ color: 0x14241d, roughness: 0.6 }), DIE.x, BOARD.top + 0.7, DIE.z);
  const dieMat = std({ color: 0x1b1e22, roughness: 0.22, metalness: 0.7, emissiveMap: dieTexture(), emissive: 0xffd9a0, emissiveIntensity: 0.55 });
  add(new THREE.BoxGeometry(DIE.size, DIE.top - BOARD.top - 1.4, DIE.size), dieMat, DIE.x, (DIE.top + BOARD.top + 1.4) / 2, DIE.z);
  const dieLight = new THREE.PointLight(0xffd29a, 60, 70, 2); dieLight.position.set(DIE.x, DIE.top + 10, DIE.z); root.add(dieLight);
  // VRAM
  const vram = std({ map: chipTexture("SK-GDDR7"), roughness: 0.5, metalness: 0.2 });
  for (const x of [-40, 40]) for (const z of [-26, -9, 9, 26]) add(new THREE.BoxGeometry(12, 1.6, 9), vram, x, BOARD.top + 0.8, z);
  // power stages: chokes and MOSFETs along the back
  const choke = std({ color: 0x3a3e42, roughness: 0.45, metalness: 0.6 }), fet = std({ color: 0x141516, roughness: 0.5 });
  for (let x = -63; x <= 63; x += 14) { add(new THREE.BoxGeometry(8, 6, 8), choke, x, BOARD.top + 3, -48); add(new THREE.BoxGeometry(5, 1.2, 4), fet, x, BOARD.top + 0.6, -39); }
  // capacitors by the bracket
  const cap = std({ color: 0x1f1b2b, roughness: 0.35, metalness: 0.4 }), capTop = std({ color: 0x8a8f93, roughness: 0.55, metalness: 0.7 });
  for (const x of [-88, -82]) for (let z = -44; z <= 44; z += 11) {
    if (Math.abs(z) < 6) continue;
    add(new THREE.CylinderGeometry(2.3, 2.3, 7, 20), cap, x, BOARD.top + 3.5, z);
    add(new THREE.CylinderGeometry(2.1, 2.1, 0.2, 20), capTop, x, BOARD.top + 7.05, z, false);
  }
  // the bracket with display ports
  add(new THREE.BoxGeometry(1.2, 34, BOARD.d), std({ color: 0x6f777c, roughness: 0.6, metalness: 0.8 }), -BOARD.w / 2 - 0.6, 15, 0);
  for (const z of [-36, -12, 12, 36]) add(new THREE.BoxGeometry(1.6, 5, 12), std({ color: 0x050607, roughness: 0.6 }), -BOARD.w / 2 - 0.8, 12, z, false);
  // PCIe gold fingers on the front edge
  const gold = std({ color: 0xd4a23c, roughness: 0.25, metalness: 1 });
  for (let x = -64; x <= 24; x += 2.2) add(new THREE.BoxGeometry(1.3, 0.25, 5), gold, x, BOARD.top + 0.13, BOARD.d / 2 - 3, false);
  // copper heat pipe: from the die out to the bar the workers hang from, then into the fin stack
  const copper = std({ color: 0xb8713f, roughness: 0.4, metalness: 1 });
  const pipe = (pts: [number, number, number][], r = 1.1) => add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), 64, r, 12), copper, 0, 0, 0);
  pipe([[10, DIE.top + 0.8, -10], [30, 14, -28], [HEATPIPE.x, HEATPIPE.y, HEATPIPE.z0 - 4]]);
  pipe([[HEATPIPE.x, HEATPIPE.y, HEATPIPE.z0 - 4], [HEATPIPE.x, HEATPIPE.y, HEATPIPE.z1 + 4]], 1.2);
  pipe([[HEATPIPE.x, HEATPIPE.y, HEATPIPE.z1 + 4], [70, 20, 36], [84, 12, 30]]);
  for (const z of [HEATPIPE.z0 - 4, HEATPIPE.z1 + 4]) add(new THREE.CylinderGeometry(1, 1, HEATPIPE.y - BOARD.top, 12), copper, HEATPIPE.x, (HEATPIPE.y + BOARD.top) / 2, z);
  // fin stack and fan
  const fin = std({ color: 0xa3acb2, roughness: 0.32, metalness: 0.85 });
  for (let z = -40; z <= 40; z += 2.6) add(new THREE.BoxGeometry(24, 18, 0.45), fin, 84, BOARD.top + 9, z);
  const fan = new THREE.Group(); fan.position.set(84, BOARD.top + 22, 0); root.add(fan);
  const blades = new THREE.Group(); fan.add(blades);
  const bladeMat = std({ color: 0x15181a, roughness: 0.5, metalness: 0.3 });
  for (let i = 0; i < 9; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(12, 0.3, 4), bladeMat); b.position.set(Math.cos(i * 0.698) * 7, 0, Math.sin(i * 0.698) * 7); b.rotation.y = -i * 0.698; b.rotation.x = 0.35; blades.add(b); }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 1.4, 24), bladeMat); fan.add(hub);
  const fanRing = std({ color: 0x0c2a30, emissive: 0x39d0e8, emissiveIntensity: 0.8 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(15, 0.7, 10, 64), fanRing); ring.rotation.x = Math.PI / 2; fan.add(ring);
  return { die: dieMat, fan: blades, fanRing, dieLight };
}

// ---------- a worker: core (far) + alien (near) ----------
interface Piece { group: THREE.Group; alien: Alien; core: THREE.Group; coreMat: THREE.MeshStandardMaterial; ringMat: THREE.MeshStandardMaterial; hit: THREE.Mesh; label: HTMLElement; key: string; placed: Placed }
function makeCore(): { core: THREE.Group; coreMat: THREE.MeshStandardMaterial; ringMat: THREE.MeshStandardMaterial } {
  const core = new THREE.Group();
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x0e1416, emissive: STATE_COLOR.working, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.5, transparent: true });
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x0e1416, emissive: STATE_COLOR.working, emissiveIntensity: 2, transparent: true });
  const hex = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 1.6, 6), coreMat); core.add(hex);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.28, 8, 40), ringMat); ring.rotation.x = Math.PI / 2; core.add(ring);
  return { core, coreMat, ringMat };
}
// One label per worker over the canvas: its number and tag; its pose, zone and state as data (the
// list below is the accessible path, so the overlay is aria-hidden).
export function fillLabel(el: HTMLElement, f: Figure, zone: string): void {
  const state = stateOf(f);
  Object.assign(el.dataset, { pose: f.pose, zone, state, n: String(f.n), animate: String(f.animate) });
  const key = [f.n, f.tag || "", state, f.pose].join("|");
  el.title = `Agent ${f.n}: ${f.label}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const n = document.createElement("span"); n.className = "ph-n"; n.textContent = String(f.n);
  const parts: HTMLElement[] = [n];
  if (f.tag) { const t = document.createElement("span"); t.className = `ph-tag ph-tag-${f.tag === "?" ? "q" : f.tag === "!" ? "err" : "word"}`; t.textContent = f.tag; parts.push(t); }
  el.replaceChildren(...parts);
}
const stateOf = (f: Figure): keyof typeof STATE_COLOR => f.pose === "raise" ? "needs" : f.status === "failed" ? "failed" : f.tag === "finishing" ? "finishing" : f.status === "working" && f.tag !== "no news" ? "working" : "idle";

export function createView(stage: HTMLElement, overlay: HTMLElement, opts: { reducedMotion: boolean }): PowerhouseView {
  const gl = hasWebGL();
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 1, 900);
  const orbit = { ...CAMERA.home, target: { ...CAMERA.home.target } };
  const pieces = new Map<string, Piece>();
  let pick: (id: string) => void = () => {};
  let scene: Scene | null = null;
  let live = true, raf = 0, last = performance.now(), clock = 0;
  let tween: { from: typeof orbit; to: typeof orbit; t0: number; ms: number } | null = null;
  const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.hidden = true; overlay.append(bubble);

  const applyCamera = () => {
    const r = String(Math.round(orbit.radius));
    if (stage.dataset.radius !== r) stage.dataset.radius = r; // for tests and the zoom buttons' state
    const p = orbitPosition(orbit);
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(orbit.target.x, orbit.target.y, orbit.target.z);
    camera.updateMatrixWorld();
  };
  applyCamera();

  const noGL = (why: string): PowerhouseView => {
    const note = document.createElement("p"); note.className = "nogl";
    note.textContent = why;
    stage.append(note);
    return {
      gl: false,
      update(s) {
        scene = s;
        const keep = new Set<string>();
        for (const pl of placeFigures(s)) {
          keep.add(pl.figure.id);
          let el = [...overlay.querySelectorAll<HTMLElement>(".ph-label")].find(x => x.dataset.id === pl.figure.id);
          if (!el) { el = document.createElement("div"); el.className = "ph-label"; el.dataset.id = pl.figure.id; const id = pl.figure.id; el.addEventListener("click", () => pick(id)); overlay.append(el); }
          fillLabel(el, pl.figure, pl.zone);
        }
        for (const el of [...overlay.querySelectorAll<HTMLElement>(".ph-label")]) if (!keep.has(el.dataset.id!)) el.remove();
        bubble.hidden = !s.shout; bubble.textContent = s.shout?.text || "";
        overlay.dataset.coach = s.coach;
      },
      onPick(cb) { pick = cb; }, zoom() {}, reset() {}, focus() {}, setLive() {}, distance: () => orbit.radius
    };
  };
  if (!gl) return noGL("The 3D view needs WebGL, which is turned off in this browser. Everything it would show is in the list below.");
  // WebGL can be reported and still fail (a blocked GPU, too many contexts): fall back, never leave
  // the page empty.
  try { return glView(); } catch (err) {
    console.warn("Sidekick: the 3D view could not start", err);
    stage.querySelector(".ph-canvas")?.remove();
    return noGL("The 3D view could not start on this computer's graphics. Everything it would show is in the list below.");
  }

  function glView(): PowerhouseView {
  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // redrawn only when something moved (shadowDirty)
  renderer.domElement.className = "ph-canvas";
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "3D view of Sidekick's graphics card. Drag or use the arrow keys to turn it, scroll or press plus and minus to zoom, 0 to reset. The list below has the same information.");
  stage.prepend(renderer.domElement);
  const world = new THREE.Scene();
  world.background = new THREE.Color(0x06080a);
  world.fog = new THREE.Fog(0x06080a, 260, 520);
  world.add(new THREE.HemisphereLight(0x9fb4c8, 0x0a0c0e, 0.8));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.2); key.position.set(70, 150, 110); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.4;
  Object.assign(key.shadow.camera, { left: -115, right: 115, top: 75, bottom: -75, near: 60, far: 300 }); world.add(key);
  // a warm fill on the heat pipe, so the hanging workers and the copper read
  const fill = new THREE.PointLight(0xffe2c4, 45, 90, 2); fill.position.set(40, 40, 30); world.add(fill);
  const rim = new THREE.DirectionalLight(0x5fd4ea, 0.35); rim.position.set(-120, 60, -140); world.add(rim);
  const card = new THREE.Group(); world.add(card);
  const board = buildBoard(card);
  // the composer renders off screen, where the canvas's own antialiasing doesn't apply: multisample
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(world, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 288), 0.5, 0.4, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Sidekick: the alien sits in a group placed on the die (pose() resets the alien's own position
  // every frame, so the placement must live on a parent)
  const sk = makeAlien(0xf3f2ec);
  const skGroup = new THREE.Group();
  skGroup.position.set(SIDEKICK.x, SIDEKICK.y, SIDEKICK.z);
  skGroup.scale.setScalar(SK_SCALE); // the coach is bigger than the workers
  skGroup.add(sk.root); world.add(skGroup);
  const skHit = new THREE.Mesh(new THREE.SphereGeometry(10, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
  skHit.position.set(SIDEKICK.x, SIDEKICK.y + 8, SIDEKICK.z); skHit.userData.id = "sk"; world.add(skHit);
  // the trace to the worker being addressed
  const traceTex = canvasTexture(64, 8, g => { g.fillStyle = "#000"; g.fillRect(0, 0, 64, 8); g.fillStyle = "#fff"; g.fillRect(0, 0, 36, 8); });
  traceTex.wrapS = THREE.RepeatWrapping; traceTex.colorSpace = THREE.NoColorSpace;
  const traceMat = new THREE.MeshBasicMaterial({ color: 0x7fe6f5, alphaMap: traceTex, transparent: true, depthWrite: false });
  let trace: THREE.Mesh | null = null, traceKey = "";

  const size = () => {
    const w = stage.clientWidth || 640, h = stage.clientHeight || 360;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    bloom.setSize(Math.round((w * pixelRatio) / 2), Math.round((h * pixelRatio) / 2)); // bloom at half resolution
    camera.aspect = w / h; camera.updateProjectionMatrix();
    requestFrame();
  };
  new ResizeObserver(size).observe(stage);

  // ---------- figures ----------
  function piece(pl: Placed): Piece {
    let p = pieces.get(pl.figure.id);
    if (!p) {
      const group = new THREE.Group();
      const alien = makeAlien(0xa1a8a4); group.add(alien.root);
      const { core, coreMat, ringMat } = makeCore(); group.add(core);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(7, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 6; hit.userData.id = pl.figure.id; group.add(hit);
      const label = document.createElement("div"); label.className = "ph-label"; label.dataset.id = pl.figure.id;
      label.addEventListener("click", () => pick(pl.figure.id));
      overlay.append(label);
      world.add(group);
      p = { group, alien, core, coreMat, ringMat, hit, label, key: "", placed: pl };
      pieces.set(pl.figure.id, p);
    }
    p.placed = pl;
    return p;
  }
  function placePiece(p: Piece) {
    const { spot, figure: f, zone } = p.placed;
    p.group.position.set(spot.x, spot.y, spot.z);
    p.group.rotation.y = spot.facing; // on the group: pose() resets the alien's own rotation every frame
    p.core.position.y = zone === "heatpipe" ? ARM_TOP_OFFSET : 3.2;
    const state = stateOf(f);
    for (const m of [p.coreMat, p.ringMat]) m.emissive.setHex(STATE_COLOR[state]);
    fillLabel(p.label, f, zone);
  }

  // ---------- the frame ----------
  const v = new THREE.Vector3();
  function project(x: number, y: number, z: number, el: HTMLElement) {
    v.set(x, y, z).project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
    el.style.visibility = vis ? "visible" : "hidden";
    if (vis) { el.style.left = `${((v.x + 1) / 2) * stage.clientWidth}px`; el.style.top = `${((1 - v.y) / 2) * stage.clientHeight}px`; }
  }
  const moving = () => live && !opts.reducedMotion;
  let lastDraw = 0, shadowDirty = true;
  function frame(now: number) {
    raf = 0;
    // about 30 frames a second is plenty for this page (it may stay open for hours)
    if (!tween && now - lastDraw < 31) { requestFrame(); return; }
    lastDraw = now;
    try { draw(now); } catch (err) { console.warn("Sidekick: a 3D frame failed", err); }
    if (busy()) requestFrame();
  }
  function draw(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; clock += dt;
    if (tween) {
      const k = Math.min(1, (now - tween.t0) / tween.ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      orbit.radius = tween.from.radius + (tween.to.radius - tween.from.radius) * e;
      orbit.polar = tween.from.polar + (tween.to.polar - tween.from.polar) * e;
      orbit.azimuth = tween.from.azimuth + (tween.to.azimuth - tween.from.azimuth) * e;
      for (const a of ["x", "y", "z"] as const) orbit.target[a] = tween.from.target[a] + (tween.to.target[a] - tween.from.target[a]) * e;
      if (k >= 1) tween = null;
    }
    applyCamera();
    const s = scene;
    const working = s ? s.working : 0;
    // Sidekick
    const coachPose: AlienPose = !s ? "idle" : s.coach === "thinking" ? "push" : s.coach === "shouting" ? "point" : s.coach === "paused" ? "floor" : "idle";
    let pointAt = 0;
    if (s?.shout) { const t = pieces.get(s.shout.workerId); if (t) pointAt = Math.atan2(t.group.position.x - SIDEKICK.x, t.group.position.z - SIDEKICK.z); }
    pose(sk, coachPose, clock, moving() && s?.coach !== "paused", pointAt);
    if (coachPose === "push") sk.root.position.z = -7; // push-ups: the feet move back so the plank lies on the die
    // the die glows brighter while the brain works; the fan spins while anything works
    const thinking = s?.coach === "thinking";
    board.die.emissiveIntensity = thinking ? 1.1 + (moving() ? 0.5 * Math.sin(clock * 5) : 0) : s?.coach === "paused" ? 0.2 : 0.55;
    board.dieLight.intensity = thinking ? 140 : 60;
    if (moving() && (working || thinking)) board.fan.rotation.y -= dt * (thinking ? 9 : 5);
    board.fanRing.emissiveIntensity = s?.coach === "paused" ? 0.15 : working ? 1.0 : 0.55;
    // workers: far = core, near = alien
    for (const p of pieces.values()) {
      const f = p.placed.figure;
      p.group.getWorldPosition(v);
      const w = alienWeight(camera.position.distanceTo(v));
      setOpacity(p.alien, w);
      p.core.visible = w < 0.98;
      p.coreMat.opacity = p.ringMat.opacity = 1 - w;
      const animate = moving() && (f.animate || f.pose === "raise");
      if (w > 0.02) pose(p.alien, POSE[f.pose], clock + f.n * 0.37, animate);
      const st = stateOf(f);
      const pulse = st === "working" && moving() ? 1.3 + 0.7 * Math.sin(clock * 4 + f.n) : st === "needs" ? (moving() ? 0.9 + 0.6 * Math.sin(clock * 5) : 1.2) : st === "idle" ? 0.5 : st === "failed" ? 1.1 : 1.3;
      p.coreMat.emissiveIntensity = pulse; p.ringMat.emissiveIntensity = pulse * 1.3;
      if (moving() && st === "working") p.core.rotation.y += dt * 1.5;
      const coreY = p.placed.zone === "heatpipe" ? ARM_TOP_OFFSET : 3.2;
      p.core.position.y = coreY + (moving() ? 0.4 * Math.sin(clock * 2 + f.n) : 0);
      // the label sits just above whichever is showing: the core far away, the alien's head close up
      const labelY = coreY + 6 + w * ((p.placed.zone === "heatpipe" ? 15 : 13) - coreY - 6);
      project(p.group.position.x, p.group.position.y + labelY, p.group.position.z, p.label);
    }
    // the trace pulses toward the worker
    if (trace && moving()) traceTex.offset.x -= dt * 2.2;
    if (s?.shout) project(SIDEKICK.x, SIDEKICK.y + 17 * SK_SCALE, SIDEKICK.z, bubble);
    renderer.shadowMap.needsUpdate = shadowDirty || busy();
    shadowDirty = false;
    composer.render();
  }
  const busy = () => !!tween || (moving() && !!scene && (scene.working > 0 || scene.coach === "thinking" || scene.coach === "shouting" || scene.needsYou > 0 || [...pieces.values()].some(p => p.placed.figure.animate)) || false);
  function requestFrame() { if (!raf) raf = requestAnimationFrame(frame); }

  // ---------- controls: drag to orbit, right-drag or shift-drag to pan, wheel and pinch to zoom ----------
  const canvas = renderer.domElement;
  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = 0, pinch = 0, multi = false;
  const stopTween = () => { tween = null; };
  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { dragged = 0; multi = false; }
    if (pointers.size === 2) { multi = true; const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  canvas.addEventListener("pointermove", e => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y; prev.x = e.clientX; prev.y = e.clientY; dragged += Math.abs(dx) + Math.abs(dy);
    stopTween();
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) orbit.radius = clampRadius(orbit.radius * pinch / d); pinch = d; }
    else if (e.buttons === 2 || e.shiftKey) {
      const k = orbit.radius / 600, s = Math.sin(orbit.azimuth), c = Math.cos(orbit.azimuth);
      orbit.target = clampTarget({ x: orbit.target.x - (dx * c - dy * s) * k * 2, y: orbit.target.y, z: orbit.target.z - (-dx * s - dy * c) * k * 2 });
    } else { orbit.azimuth -= dx * 0.006; orbit.polar = clampPolar(orbit.polar - dy * 0.005); }
    requestFrame();
  });
  const up = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = 0;
    // a tap picks; a drag or any two-finger gesture never does
    if (dragged < 5 && !multi && e.type === "pointerup" && pointers.size === 0) {
      const r = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hits = ray.intersectObjects([skHit, ...[...pieces.values()].map(p => p.hit)], false);
      const id = hits[0]?.object.userData.id as string | undefined;
      if (id) pick(id);
    }
  };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; });
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("wheel", e => {
    e.preventDefault(); stopTween();
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1); // lines or pages → pixels
    orbit.radius = clampRadius(orbit.radius * Math.exp(dy * 0.0012)); requestFrame();
  }, { passive: false });
  // the GPU can drop the context (sleep, driver reset): keep the canvas and redraw when it is back
  canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); if (raf) { cancelAnimationFrame(raf); raf = 0; } });
  canvas.addEventListener("webglcontextrestored", () => { shadowDirty = true; requestFrame(); });
  canvas.addEventListener("keydown", e => {
    const k = e.key;
    if (k === "ArrowLeft") orbit.azimuth += 0.12; else if (k === "ArrowRight") orbit.azimuth -= 0.12;
    else if (k === "ArrowUp") orbit.polar = clampPolar(orbit.polar - 0.08); else if (k === "ArrowDown") orbit.polar = clampPolar(orbit.polar + 0.08);
    else if (k === "+" || k === "=") orbit.radius = clampRadius(orbit.radius / 1.25); else if (k === "-" || k === "_") orbit.radius = clampRadius(orbit.radius * 1.25);
    else if (k === "0") { view.reset(); return; } else return;
    e.preventDefault(); stopTween(); requestFrame();
  });

  const flyTo = (to: typeof orbit) => {
    // the shortest way round: bring the current azimuth within half a turn of the target's
    while (orbit.azimuth - to.azimuth > Math.PI) orbit.azimuth -= 2 * Math.PI;
    while (orbit.azimuth - to.azimuth < -Math.PI) orbit.azimuth += 2 * Math.PI;
    if (opts.reducedMotion) { Object.assign(orbit, to, { target: { ...to.target } }); requestFrame(); return; }
    tween = { from: { ...orbit, target: { ...orbit.target } }, to, t0: performance.now(), ms: 700 }; requestFrame();
  };

  const view: PowerhouseView = {
    gl: true,
    update(s) {
      scene = s;
      const placed = placeFigures(s);
      const keep = new Set(placed.map(pl => pl.figure.id));
      for (const pl of placed) placePiece(piece(pl));
      for (const [id, p] of pieces) if (!keep.has(id)) { world.remove(p.group); dispose(p.group); p.label.remove(); pieces.delete(id); }
      shadowDirty = true;
      // the trace from the die to the worker Sidekick is shouting at
      const target = s.shout && pieces.get(s.shout.workerId);
      const tk = target ? `${s.shout!.workerId}:${target.group.position.toArray().join(",")}` : "";
      if (tk !== traceKey) {
        traceKey = tk;
        if (trace) { world.remove(trace); trace.geometry.dispose(); trace = null; }
        if (target) {
          const t = target.group.position, y = BOARD.top + 0.6, endY = t.y + (target.placed.zone === "heatpipe" ? ARM_TOP_OFFSET : 3.2);
          const pts = [new THREE.Vector3(SIDEKICK.x, DIE.top + 0.4, SIDEKICK.z), new THREE.Vector3(SIDEKICK.x + (t.x - SIDEKICK.x) * 0.15, y, SIDEKICK.z + 14), new THREE.Vector3((SIDEKICK.x + t.x) / 2, y, (SIDEKICK.z + t.z) / 2 + 10), new THREE.Vector3(t.x, y, t.z), new THREE.Vector3(t.x, endY, t.z)];
          trace = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.55, 8), traceMat);
          traceTex.repeat.set(12, 1);
          world.add(trace);
        }
      }
      bubble.hidden = !s.shout;
      bubble.textContent = s.shout?.text || "";
      requestFrame();
    },
    onPick(cb) { pick = cb; },
    zoom(f) { stopTween(); orbit.radius = clampRadius(orbit.radius * f); requestFrame(); },
    reset() { flyTo({ ...CAMERA.home, target: { ...CAMERA.home.target } }); },
    focus(id) {
      const placed = pieces.get(id)?.placed;
      const spot: Spot | undefined = id === "sk" ? SIDEKICK : placed?.spot;
      if (!spot) return;
      // aim at the figure itself (hanging workers are high up), from the side it faces
      flyTo({ radius: CAMERA.focus, polar: 1.1, azimuth: FOCUS_AZIMUTH[id === "sk" ? "sidekick" : placed!.zone], target: clampTarget({ x: spot.x, y: spot.y + 6, z: spot.z }) });
    },
    setLive(on) { live = on; last = performance.now(); if (on) requestFrame(); else if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    distance: () => orbit.radius
  };
  size();
  return view;
  }
}

// Frees a removed worker's geometries and materials (the page may run for hours).
function dispose(g: THREE.Object3D): void {
  g.traverse(o => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose();
  });
}

// Hanging workers: their core floats just under the pipe.
const ARM_TOP_OFFSET = 8;
const SK_SCALE = 1.6;
