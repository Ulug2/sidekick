// The city on the card (docs/powerhouse-redesign/02-world.md; reference/powerhouse-city.html is the
// visual source of truth, the doc wins where they differ: two terminals, a 3-spot rack, a 24-unit
// bench, the silo exclusions). Everything is primitives and code-drawn textures. Static except the
// fan, the terminal screens and the lights, which gpu views drive through the returned refs.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Materials, canvasTex, glow, seeded, signTex, std, MONO } from "./materials.js";
import { BOARD, G, ROADS, ROOF, type XZ } from "./city-layout.js";

export type Mood = "live" | "paused" | "idle";
export interface City {
  fan: THREE.Group; // spins on y
  hqLight: THREE.PointLight; // driven by Sidekick's mode
  plantLight: THREE.PointLight;
  termTextures: THREE.CanvasTexture[]; // scroll offset.y while that terminal's writer types
  setMood(mood: Mood): void;
}

// distance from (x, z) to the nearest road
function segDist(px: number, pz: number, a: XZ, b: XZ): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  let t = L ? ((px - a[0]) * dx + (pz - a[1]) * dz) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - px, a[1] + t * dz - pz);
}
export function roadDist(x: number, z: number): number { let d = 1e9; for (const r of ROADS) for (let i = 0; i < r.length - 1; i++) d = Math.min(d, segDist(x, z, r[i], r[i + 1])); return d; }

// Exclusion rectangles for the skyline [xmin, xmax, zmin, zmax] (02 › Filler skyline).
export const EXCL: [number, number, number, number][] = [
  [-24, 24, -24, 24], [-60, -34, -20, 20], [-57, -37, -32, -22], [-57, -37, 22, 32],
  [-70, 32, 47.5, 60], [-93, -77, -50, 50], [-100, -92, -60, 60], [64, 100, -46, 46],
  [32, 48, -21, 21], [-72, 72, -60, -49.5], [-80, -66, 14, 38], [-80, -66, -38, -22], [20, 66, -5, 5]
];
const inExcl = (x: number, z: number, m: number) => EXCL.some(([a, b, c, d]) => x > a - m && x < b + m && z > c - m && z < d + m);

// The skyline's buildings (pure, seeded): the same on every load.
export function skyline(): { x: number; z: number; w: number; d: number; h: number }[] {
  const rnd = seeded(21);
  const out: { x: number; z: number; w: number; d: number; h: number }[] = [];
  for (let x = -90; x <= 92; x += 6.4) for (let z = -56; z <= 56; z += 6.4) {
    const cx = x + (rnd() - 0.5) * 1.6, cz = z + (rnd() - 0.5) * 1.6;
    const w = 3.2 + rnd() * 2.2, d = 3.2 + rnd() * 2.2;
    if (Math.abs(cx) + w / 2 > 97 || Math.abs(cz) + d / 2 > 58) continue;
    if (inExcl(cx, cz, Math.max(w, d) / 2)) continue;
    if (roadDist(cx, cz) < Math.max(w, d) / 2 + 2.3) continue;
    if (rnd() < 0.12) continue;
    const near = Math.max(0, 1 - Math.hypot(cx, cz) / 75);
    let h = 3 + rnd() * 7 + near * rnd() * 15;
    if (cx > -66 && cx < -30) h = Math.min(h, 5.5); // keeps the archive robots visible
    if (cz > 30) h = Math.min(h, 7); // keeps the docks visible
    out.push({ x: cx, z: cz, w, d, h });
  }
  return out;
}

// Static meshes that share a material and shadow flags become one mesh (one draw call instead of
// dozens: silos, substations, wall, rails, desks…). Moving parts (keep) and instanced meshes stay.
export function mergeStatic(group: THREE.Group, keep: Set<THREE.Object3D>): void {
  group.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; receive: boolean; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  for (const o of [...group.children]) {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || keep.has(m) || Array.isArray(m.material)) continue;
    const key = `${m.material.uuid}|${m.castShadow}|${m.receiveShadow}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: m.material, cast: m.castShadow, receive: m.receiveShadow, geos: [], meshes: [] }));
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    b.geos.push(g); b.meshes.push(m);
  }
  for (const b of buckets.values()) {
    if (b.meshes.length < 2) { for (const g of b.geos) g.dispose(); continue; }
    const merged = mergeGeometries(b.geos, false);
    for (const g of b.geos) g.dispose();
    if (!merged) continue;
    for (const m of b.meshes) { group.remove(m); m.geometry.dispose(); }
    const one = new THREE.Mesh(merged, b.mat); one.castShadow = b.cast; one.receiveShadow = b.receive; one.matrixAutoUpdate = false;
    group.add(one);
  }
}

export function buildCity(world: THREE.Object3D, mats: Materials): City {
  const root = new THREE.Group(); world.add(root);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadows = true, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
    if (shadows) { m.castShadow = true; m.receiveShadow = true; }
    parent.add(m); return m;
  };
  const rbox = (w: number, h: number, d: number, seg: number, r: number) => new RoundedBoxGeometry(w, h, d, seg, r);

  // ---------- the board: roads (the card's traces), alleys, vias, silkscreen ----------
  const PX = 10;
  const toPx = (x: number, z: number): [number, number] => [(x + 100) * PX, (z + 60) * PX];
  const strokeRoads = (g: CanvasRenderingContext2D, width: number, style: string, dash?: number[]) => {
    g.save(); g.lineWidth = width * PX; g.strokeStyle = style; g.lineCap = "round"; g.lineJoin = "round";
    if (dash) g.setLineDash(dash.map(d => d * PX));
    for (const r of ROADS) { g.beginPath(); r.forEach((p, i) => { const [a, b] = toPx(p[0], p[1]); if (i) g.lineTo(a, b); else g.moveTo(a, b); }); g.stroke(); }
    g.restore();
  };
  const junctions = ROADS.flatMap(r => [r[0], r[r.length - 1]]);
  const rnd = seeded(11);
  const alleys: XZ[][] = [];
  for (let i = 0; i < 170; i++) {
    let x = -96 + rnd() * 192, z = -56 + rnd() * 112;
    if (roadDist(x, z) < 3) continue;
    const pts: XZ[] = [[x, z]];
    const n = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const L = 2 + rnd() * 6, dir = Math.floor(rnd() * 4);
      if (dir === 0) x += L; else if (dir === 1) x -= L; else if (dir === 2) z += L; else z -= L;
      if (rnd() < 0.3) { x += (rnd() < 0.5 ? -1 : 1) * L * 0.6; z += (rnd() < 0.5 ? -1 : 1) * L * 0.6; }
      pts.push([x, z]);
    }
    alleys.push(pts);
  }
  const path = (g: CanvasRenderingContext2D, p: XZ[]) => { g.beginPath(); p.forEach((q, i) => { const [a, b] = toPx(q[0], q[1]); if (i) g.lineTo(a, b); else g.moveTo(a, b); }); g.stroke(); };
  const boardMap = canvasTex(2000, 1200, (g, W, H) => {
    g.fillStyle = "#0a1215"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#0f1a1e"; g.lineWidth = 1;
    for (let i = 0; i <= W; i += 20) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, H); g.stroke(); }
    for (let j = 0; j <= H; j += 20) { g.beginPath(); g.moveTo(0, j); g.lineTo(W, j); g.stroke(); }
    g.strokeStyle = "#5a3c22"; g.lineWidth = 0.45 * PX; g.lineCap = "round"; g.lineJoin = "round";
    for (const t of alleys) { path(g, t); const [ea, eb] = toPx(...t[t.length - 1]); g.fillStyle = "#8a5a2c"; g.beginPath(); g.arc(ea, eb, 0.55 * PX, 0, 7); g.fill(); }
    strokeRoads(g, 4.2, "#2a3a42"); strokeRoads(g, 3.6, "#151d23"); strokeRoads(g, 0.22, "#6f5a2e", [1.6, 1.6]);
    for (const p of junctions) {
      const [a, b] = toPx(p[0], p[1]);
      g.fillStyle = "#1d262b"; g.beginPath(); g.arc(a, b, 2.6 * PX, 0, 7); g.fill();
      g.strokeStyle = "#b88a3c"; g.lineWidth = 0.35 * PX; g.beginPath(); g.arc(a, b, 1.6 * PX, 0, 7); g.stroke();
    }
    g.strokeStyle = "#c9a24a"; g.lineWidth = 0.3 * PX; g.setLineDash([12, 10]); g.strokeRect(...toPx(-23, -23), 46 * PX, 46 * PX); g.setLineDash([]);
    g.fillStyle = "#c9a24a"; g.font = `600 ${2.6 * PX}px ${MONO}`; g.textAlign = "right";
    g.fillText("SIDEKICK · PH-1 · REV 6", ...toPx(94, 54));
    g.font = `500 ${1.6 * PX}px ${MONO}`; g.textAlign = "left"; g.fillStyle = "#8a7440";
    g.fillText("ARCHIVE · VRAM 0–3", ...toPx(-62, -20)); g.fillText("DOCKS · PCIe x16", ...toPx(-62, 50.5)); g.fillText("POWER · VRM", ...toPx(-70, -56.5));
  });
  const boardGlow = canvasTex(2000, 1200, (g, W, H) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    strokeRoads(g, 4.0, "#1d8fa3"); strokeRoads(g, 3.5, "#000"); strokeRoads(g, 0.2, "#6a4612", [1.6, 1.6]);
    g.strokeStyle = "#2a1608"; g.lineWidth = 0.45 * PX; g.lineCap = "round";
    for (const t of alleys) path(g, t);
    for (const p of junctions) { const [a, b] = toPx(p[0], p[1]); g.strokeStyle = "#c98a2a"; g.lineWidth = 0.3 * PX; g.beginPath(); g.arc(a, b, 1.6 * PX, 0, 7); g.stroke(); }
  });
  const boardTop = new THREE.MeshStandardMaterial({ map: boardMap, emissiveMap: boardGlow, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.82, metalness: 0.15 });
  const slab = add(new THREE.BoxGeometry(BOARD.w, 2, BOARD.d), std(0x0b1316, { r: 0.7 }), 0, 1, 0); slab.castShadow = false;
  const top = add(new THREE.PlaneGeometry(BOARD.w, BOARD.d), boardTop, 0, G + 0.01, 0); top.rotation.x = -Math.PI / 2; top.castShadow = false;
  const edge = glow(0xc9a24a, 0.6);
  for (const z of [60.1, -60.1]) add(new THREE.BoxGeometry(200.4, 0.25, 0.3), edge, 0, G - 0.1, z, false);

  // ---------- HQ (GPU package and die) with the roof gym ----------
  add(rbox(40, 1.4, 40, 3, 0.5), std(0x10201c, { r: 0.5, m: 0.3 }), 0, G + 0.7, 0);
  const frame = glow(0x46d6ea, 1.1);
  for (const s of [-1, 1]) { add(new THREE.BoxGeometry(38, 0.18, 0.18), frame, 0, G + 1.45, 19 * s, false); add(new THREE.BoxGeometry(0.18, 0.18, 38), frame, 19 * s, G + 1.45, 0, false); }
  add(rbox(20, 32, 20, 4, 1.1), mats.windowMat({ color: 0x141d26, density: 0.72, wx: 1.0, wy: 1.25, boost: 1.35, warm: 0xffe2b0, cool: 0x8ee6f2 }), 0, G + 1.4 + 16, 0);
  add(rbox(19, 0.6, 19, 2, 0.2), std(0x1b2228, { r: 0.45, m: 0.5 }), 0, ROOF - 0.3, 0);
  const rail = glow(0xffd9a0, 1.0);
  for (const s of [-1, 1]) { add(new THREE.BoxGeometry(18.6, 0.22, 0.22), rail, 0, ROOF + 0.9, 9.3 * s, false); add(new THREE.BoxGeometry(0.22, 0.22, 18.6), rail, 9.3 * s, ROOF + 0.9, 0, false); }
  add(rbox(9, 0.25, 6, 2, 0.1), std(0xc2543f, { r: 0.8, m: 0 }), 0, ROOF + 0.12, 1.5);
  const plates = new THREE.Group(); plates.position.set(-6.5, ROOF, -5.5); root.add(plates);
  add(new THREE.CylinderGeometry(0.15, 0.15, 3.4, 8), std(0x8a949a, { m: 0.8, r: 0.3 }), 0, 1.7, 0, true, plates);
  for (let i = 0; i < 3; i++) add(new THREE.CylinderGeometry(1.1 - i * 0.15, 1.1 - i * 0.15, 0.35, 24), std(i % 2 ? 0x2b3238 : 0xff7a5c, { r: 0.5 }), 0, 0.4 + i * 0.38, 0, true, plates);
  const hqSign = new THREE.MeshBasicMaterial({ map: signTex("SIDEKICK", "#ffe2b0"), transparent: true, color: new THREE.Color(1.6, 1.6, 1.6) });
  add(new THREE.PlaneGeometry(14, 2.6), hqSign, 0, ROOF - 3.2, 10.06, false);
  add(new THREE.PlaneGeometry(14, 2.6), hqSign, 10.06, ROOF - 3.2, 0, false).rotation.y = Math.PI / 2;

  // ---------- archive (left VRAM): warehouses, the data rack (readers), two terminals (writers) ----------
  const archive = mats.windowMat({ color: 0x1a1f27, density: 0.6, wx: 1.5, wy: 1.1, boost: 1.1, warm: 0xffd28a, cool: 0x6fd3ff });
  for (const z of [-27, 27]) {
    add(rbox(17, 5.5, 7, 3, 0.5), archive, -47, G + 2.75, z);
    const sign = new THREE.MeshBasicMaterial({ map: signTex(z < 0 ? "ARCHIVE A" : "ARCHIVE B", "#8fe6f5", 512, 96, `600 46px ${MONO}`), transparent: true, color: new THREE.Color(1.4, 1.4, 1.4) });
    add(new THREE.PlaneGeometry(9, 1.7), sign, -47, G + 6.5, z + 3.6, false);
  }
  const metal = std(0x2a3238, { m: 0.7, r: 0.35 });
  for (const z of [-15.5, -4.5]) add(new THREE.BoxGeometry(1.8, 7, 0.4), metal, -54, G + 3.5, z);
  const rackLight = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 0.9, 0.8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 36);
  const rr = seeded(3);
  let k = 0;
  for (let s = 0; s < 4; s++) {
    const y = G + 1.2 + s * 1.6;
    add(new THREE.BoxGeometry(1.8, 0.2, 11), metal, -54, y - 0.55, -10);
    for (let i = 0; i < 9; i++) {
      rackLight.setMatrixAt(k, new THREE.Matrix4().makeTranslation(-53.6, y, -14.5 + i * 1.12));
      rackLight.setColorAt(k++, new THREE.Color(rr() < 0.7 ? 0x2fc7dd : 0x7a5cff).multiplyScalar(0.5 + rr() * 1.1));
    }
  }
  root.add(rackLight);
  const term = canvasTex(256, 512, (g, _W, H) => {
    g.fillStyle = "#03100f"; g.fillRect(0, 0, 256, H); g.font = `15px ${MONO}`;
    const tr = seeded(5);
    const words = ["Dear hiring team,", "I build things that ship.", "At Gettysburg I led", "a team of 4 on a", "React Native app with", "2k weekly users...", "", "Why this team:", "your tooling", "is the problem I", "want to work on."];
    for (let y = 22, i = 0; y < H; y += 22, i++) { g.fillStyle = i % 7 === 0 ? "#ffd28a" : "#59e3c4"; g.globalAlpha = 0.65 + tr() * 0.35; g.fillText(words[i % words.length], 12, y); }
  });
  term.wrapT = THREE.RepeatWrapping; term.repeat.set(1, 0.5);
  const termTextures: THREE.CanvasTexture[] = [];
  for (const z of [6, 14]) {
    const tex = term.clone(); tex.needsUpdate = true; termTextures.push(tex);
    add(rbox(3, 2.6, 5.4, 2, 0.25), std(0x252d33, { r: 0.5, m: 0.4 }), -54.5, G + 1.3, z);
    add(rbox(0.8, 3.4, 5.0, 2, 0.25), std(0x1a2026, { r: 0.4, m: 0.5 }), -55.2, G + 4.9, z);
    add(new THREE.PlaneGeometry(4.5, 3.0), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.4, 1.4, 1.4) }), -54.75, G + 4.9, z, false).rotation.y = Math.PI / 2;
    add(new THREE.BoxGeometry(1.4, 0.15, 3.2), glow(0x39d0e8, 0.5), -53.4, G + 2.68, z, false);
  }

  // ---------- data halls (right VRAM) ----------
  const hall = mats.windowMat({ color: 0x172028, density: 0.5, wx: 1.2, wy: 1.2, boost: 1.0 });
  for (const z of [-13, 13]) add(rbox(12, 10, 9, 3, 0.6), hall, 40, G + 5, z);

  // ---------- power plant: heat pipes, fin hall, turbine fan ----------
  const copper = std(0xb8713f, { m: 1, r: 0.42 });
  for (const z of [-2.6, 2.6]) {
    const p = new THREE.CurvePath<THREE.Vector3>();
    p.add(new THREE.LineCurve3(new THREE.Vector3(10, 22, z), new THREE.Vector3(64, 22, z)));
    p.add(new THREE.QuadraticBezierCurve3(new THREE.Vector3(64, 22, z), new THREE.Vector3(71, 22, z), new THREE.Vector3(71, 17, z)));
    add(new THREE.TubeGeometry(p as unknown as THREE.Curve<THREE.Vector3>, 60, 1.1, 14, false), copper);
  }
  for (const x of [24, 38, 52]) add(new THREE.CylinderGeometry(0.5, 0.6, 20, 10), std(0x5b646a, { m: 0.8, r: 0.35 }), x, G + 10, 0);
  add(rbox(28, 4, 82, 3, 0.6), std(0x1a2126, { r: 0.55, m: 0.5 }), 83, G + 2, 0);
  add(new THREE.BoxGeometry(28.2, 0.3, 0.3), glow(0x39d0e8, 1.2), 83, G + 3.4, 41.2, false);
  const fins = new THREE.InstancedMesh(new THREE.BoxGeometry(24, 12, 0.45), std(0xa3acb2, { m: 0.85, r: 0.32 }), 31);
  for (let i = 0; i < 31; i++) fins.setMatrixAt(i, new THREE.Matrix4().makeTranslation(83, G + 10, -39 + i * 2.6));
  fins.castShadow = true; fins.receiveShadow = true; root.add(fins);
  const fan = new THREE.Group(); fan.position.set(83, G + 17.2, 0); root.add(fan);
  add(new THREE.CylinderGeometry(3.4, 3.4, 1.4, 28), std(0x2a3036, { m: 0.6, r: 0.3 }), 0, 0, 0, true, fan);
  const bladeGeo = rbox(12, 0.35, 4, 2, 0.15), bladeMat = std(0x15181a, { r: 0.45, m: 0.4 });
  for (let i = 0; i < 9; i++) {
    const b = add(bladeGeo, bladeMat, Math.cos((i / 9) * Math.PI * 2) * 8.2, 0, Math.sin((i / 9) * Math.PI * 2) * 8.2, true, fan);
    b.rotation.y = -(i / 9) * Math.PI * 2; b.rotation.x = 0.35;
  }
  const fanRing = glow(0x39d0e8, 1);
  add(new THREE.TorusGeometry(14.6, 0.35, 10, 80), fanRing, 83, G + 17.2, 0, false).rotation.x = Math.PI / 2;

  // ---------- substations (power stages), silos (capacitors), the city wall (bracket) ----------
  const sub = std(0x30363b, { m: 0.7, r: 0.35 }), band = glow(0x39d0e8, 0.8);
  for (let x = -63; x <= 63; x += 14) { add(rbox(8, 5, 6, 3, 0.8), sub, x, G + 2.5, -53.5); add(new THREE.BoxGeometry(8.1, 0.35, 6.1), band, x, G + 3.6, -53.5, false); }
  const silo = std(0x251f37, { r: 0.45, m: 0.3 }), dome = std(0x8a8f93, { m: 0.9, r: 0.3 }), violet = glow(0x9a7cff, 0.9);
  const siloGeo = new THREE.CylinderGeometry(2.3, 2.3, 7, 24), domeGeo = new THREE.SphereGeometry(2.3, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), ringGeo = new THREE.TorusGeometry(2.36, 0.12, 6, 32);
  for (const x of [-88, -82]) for (let z = -44; z <= 44; z += 11) {
    if (Math.abs(z) < 5) continue;
    add(siloGeo, silo, x, G + 3.5, z); add(domeGeo, dome, x, G + 7, z);
    add(ringGeo, violet, x, G + 5.2, z, false).rotation.x = Math.PI / 2;
  }
  const wall = std(0x59636a, { m: 0.75, r: 0.38 }), gateGlow = glow(0x2a6cff, 0.9);
  const gates = [-36, -12, 12, 36];
  const edges = [-60, ...gates.flatMap(g => [g - 4.5, g + 4.5]), 60];
  for (let i = 0; i < edges.length; i += 2) { const a = edges[i], b = edges[i + 1]; add(rbox(2.6, 7, b - a, 2, 0.3), wall, -98, G + 3.5, (a + b) / 2); }
  for (const g of gates) { add(rbox(2.6, 1.6, 9, 2, 0.3), wall, -98, G + 6.2, g); add(new THREE.PlaneGeometry(9, 5.4), gateGlow, -96.65, G + 2.7, g, false).rotation.y = Math.PI / 2; }

  // ---------- docks (PCIe fingers), the bench, dock lamps ----------
  const gold = new THREE.InstancedMesh(rbox(1.3, 0.4, 4.6, 2, 0.15), std(0xd4a23c, { m: 1, r: 0.28 }), 41);
  for (let i = 0; i < 41; i++) gold.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-64 + i * 2.2, G + 0.2, 57.4));
  gold.receiveShadow = true; root.add(gold);
  add(rbox(24, 0.55, 2.4, 2, 0.2), std(0x6d5135, { r: 0.7, m: 0.1 }), -33, G + 1.25, 51.5); // seat top = G + 1.5, five seats
  for (const x of [-44.5, -21.5]) add(new THREE.BoxGeometry(0.6, 1.0, 2), std(0x2a3036, { m: 0.6 }), x, G + 0.5, 51.5);
  for (const x of [-46, -20]) { add(new THREE.CylinderGeometry(0.18, 0.18, 5, 8), std(0x3a4248, { m: 0.7 }), x, G + 2.5, 53); add(new THREE.SphereGeometry(0.5, 12, 8), glow(0xffc35a, 2), x, G + 5.2, 53, false); }

  // ---------- the skyline (instanced, seeded) with roof units and aircraft lights ----------
  const blds = skyline();
  const town = new THREE.InstancedMesh(rbox(1, 1, 1, 2, 0.1), mats.windowMat({ color: 0x161d25, density: 0.42, wx: 1.05, wy: 1.25, boost: 1 }), blds.length);
  const pal = [0x161d25, 0x1b2129, 0x141a21, 0x1d1b26, 0x172226];
  const q = new THREE.Quaternion();
  blds.forEach((b, i) => { town.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(b.x, G + b.h / 2, b.z), q, new THREE.Vector3(b.w, b.h, b.d))); town.setColorAt(i, new THREE.Color(pal[i % pal.length])); });
  town.castShadow = true; town.receiveShadow = true; root.add(town);
  const tall = blds.filter(b => b.h > 12);
  const red = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 8, 6), glow(0xff4a4a, 2.2), Math.max(1, tall.length));
  red.count = tall.length;
  tall.forEach((b, i) => red.setMatrixAt(i, new THREE.Matrix4().makeTranslation(b.x, G + b.h + 0.9, b.z)));
  root.add(red);
  const ac = new THREE.InstancedMesh(rbox(1, 1, 1, 1, 0.1), std(0x3a4249, { m: 0.6, r: 0.4 }), blds.length);
  blds.forEach((b, i) => ac.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(b.x + (i % 2 ? 0.6 : -0.5), G + b.h + 0.35, b.z + (i % 3 ? -0.4 : 0.5)), q, new THREE.Vector3(b.w * 0.35, 0.7, b.d * 0.3))));
  ac.castShadow = true; root.add(ac);

  // street lamps along every road, alternating sides
  const lamps: XZ[] = [];
  for (const r of ROADS) for (let i = 0; i < r.length - 1; i++) {
    const [a, b] = [r[i], r[i + 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
    for (let s = 4, n = 0; s < L - 2; s += 9, n++) {
      const side = n % 2 ? 1 : -1;
      const x = a[0] + ((b[0] - a[0]) * s) / L + nx * 2.6 * side, z = a[1] + ((b[1] - a[1]) * s) / L + nz * 2.6 * side;
      if (Math.abs(x) < 23 && Math.abs(z) < 23) continue;
      if (Math.abs(x) > 97 || Math.abs(z) > 58) continue;
      lamps.push([x, z]);
    }
  }
  const post = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.12, 2.4, 6), std(0x3a4248, { m: 0.7 }), lamps.length);
  const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 8, 6), glow(0xffd28a, 2.0), lamps.length);
  lamps.forEach(([x, z], i) => { post.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, G + 1.2, z)); head.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, G + 2.5, z)); });
  root.add(post, head);

  // one draw per material for everything that never moves
  mergeStatic(root, new Set([fan, plates]));

  // ---------- city lights ----------
  const hqLight = new THREE.PointLight(0xffd29a, 260, 70, 2); hqLight.position.set(0, ROOF + 9, 4); root.add(hqLight);
  const plantLight = new THREE.PointLight(0x39d0e8, 160, 60, 2); plantLight.position.set(83, 26, 0); root.add(plantLight);

  return {
    fan, hqLight, plantLight, termTextures,
    // 02 › Mood: windows, board glow, fan ring, plant light
    setMood(mood) {
      mats.setLit(mood === "live" ? 1 : mood === "paused" ? 0.8 : 0.5);
      boardTop.emissiveIntensity = mood === "idle" ? 0.45 : 1;
      fanRing.color.set(0x39d0e8).multiplyScalar(mood === "live" ? 1 : mood === "paused" ? 0.35 : 0.15);
      plantLight.intensity = mood === "idle" ? 20 : 160;
    }
  };
}
