// The robots (docs/powerhouse-redesign/03-robots.md; ported from reference/powerhouse-city.html):
// cute round workers with a screen face, stubby legs, mitten hands and an antenna light; Sidekick is
// a bigger cream foreman with a coral headband, a whistle and a barbell. Feet at y 0, facing +z.
// lookFor()/glowFor() are pure (what face and antenna light a state gets); the pose functions set
// pivot rotations from a time t, so a frozen t draws the same pose every time.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { glow, signTex, std, MONO, SORA } from "./materials.js";
import type { Activity, SidekickMode } from "./scene.js";

export type Expr = "eyes" | "focus" | "down" | "scan" | "happy" | "strain" | "blow" | "q" | "bang" | "check" | "stopped" | "sleep" | "off";
export interface Look { expr: Expr; col: string; bright: number }
export interface Glow { hex: number; k: number }

// ---------- pure: the face and antenna of a state (03 › Face screen, Antenna and belly) ----------
const CYAN = "#39d0e8", AMBER = "#f2b33d", RED = "#ef5f55", GREY = "#9db0b6", DIM = "#4f7a86";
export function lookFor(a: Activity): Look {
  switch (a) {
    case "read": return { expr: "scan", col: CYAN, bright: 1.6 };
    case "write": return { expr: "down", col: CYAN, bright: 1.6 };
    case "apply": return { expr: "focus", col: CYAN, bright: 1.6 };
    case "start": return { expr: "happy", col: CYAN, bright: 1.6 };
    case "ask": return { expr: "q", col: AMBER, bright: 1.6 };
    case "fail": return { expr: "bang", col: RED, bright: 1.6 };
    case "done": return { expr: "check", col: GREY, bright: 1.6 };
    case "stopped": return { expr: "stopped", col: GREY, bright: 1.6 };
    case "nonews": case "wait": return { expr: "sleep", col: DIM, bright: 0.9 };
  }
}
// t: the (possibly frozen) animation time, for the pulses.
export function glowFor(a: Activity, finishing: boolean, t: number): Glow {
  if (finishing) return { hex: 0xd9a54a, k: 1.4 };
  switch (a) {
    case "nonews": case "wait": return { hex: 0x000000, k: 0 };
    case "done": case "stopped": return { hex: 0x9db0b6, k: 0.9 };
    case "fail": return { hex: 0xef5f55, k: 2.0 };
    case "ask": return { hex: 0xf2b33d, k: 1.2 + 0.6 * Math.sin(t * 2) };
    default: return { hex: 0x39d0e8, k: 1.3 + 0.5 * Math.sin(t * 3) };
  }
}
export const SIDEKICK_LOOK: Record<SidekickMode, Look> = {
  lift: { expr: "focus", col: "#8ee6f2", bright: 1.6 }, // "strain" at the top of each rep
  whistle: { expr: "blow", col: "#8ee6f2", bright: 1.6 },
  coach: { expr: "eyes", col: "#8ee6f2", bright: 1.6 },
  rest: { expr: "eyes", col: "#d9a54a", bright: 1.1 },
  sleep: { expr: "sleep", col: DIM, bright: 0.9 }
};

// ---------- the rig ----------
// Each rigid part (a leg with its foot, an arm with its hand, the head with its ears and antenna
// stem, the body) is one mesh with per-vertex colours: body colour and trim colour. A robot is
// 9 draws (6 shadow casters) instead of 16, and every worker shares the same geometry and material.
// Shapes and positions are the doc's (03 › Rig).
interface Parts { leg: THREE.BufferGeometry; arm: THREE.BufferGeometry; head: THREE.BufferGeometry; body: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }
const PALETTES = new Map<string, Parts>();
let SHARED: { face: THREE.BufferGeometry; ball: THREE.BufferGeometry; belly: THREE.BufferGeometry } | null = null;
const shared = () => SHARED ||= { face: new THREE.PlaneGeometry(2.55, 1.75), ball: new THREE.SphereGeometry(0.32, 16, 12), belly: new THREE.CircleGeometry(0.34, 20) };
function piece(g: THREE.BufferGeometry, hex: number, m: THREE.Matrix4): THREE.BufferGeometry {
  const out = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
  const c = new THREE.Color(hex), n = out.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  for (const name of Object.keys(out.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) out.deleteAttribute(name);
  return out;
}
const at = (x: number, y: number, z: number, rz = 0) => new THREE.Matrix4().makeRotationZ(rz).setPosition(x, y, z);
const merge = (list: THREE.BufferGeometry[]) => { const g = mergeGeometries(list, false)!; for (const x of list) x.dispose(); return g; };
function partsFor(body: number, trim: number): Parts {
  const key = `${body}|${trim}`;
  let p = PALETTES.get(key);
  if (p) return p;
  const leg = merge([piece(new THREE.CapsuleGeometry(0.45, 0.7, 4, 12), trim, at(0, -0.8, 0)), piece(new RoundedBoxGeometry(1.0, 0.55, 1.35, 3, 0.25), body, at(0, -1.72, 0.18))]);
  const arm = merge([piece(new THREE.CapsuleGeometry(0.36, 0.85, 4, 12), trim, at(0, -0.72, 0)), piece(new THREE.SphereGeometry(0.5, 16, 12), body, at(0, -1.5, 0))]);
  const ear = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 20);
  const head = merge([piece(new RoundedBoxGeometry(3.8, 3.0, 2.8, 5, 0.62), body, at(0, 1.5, 0)), piece(ear, trim, at(-1.98, 1.5, 0, Math.PI / 2)), piece(ear, trim, at(1.98, 1.5, 0, Math.PI / 2)), piece(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 8), trim, at(0, 3.45, 0))]);
  const torso = merge([piece(new RoundedBoxGeometry(2.6, 2.4, 2.0, 4, 0.55), body, at(0, 1.3, 0))]);
  // one material for both colours: the doc's body (r .38, m .05) and trim (r .45, m .25) meet in the middle
  p = { leg, arm, head, body: torso, mat: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.12 }) };
  PALETTES.set(key, p);
  return p;
}
let BEAM: { geo: THREE.BufferGeometry; mat: THREE.MeshBasicMaterial } | null = null;
const beam = () => BEAM ||= (() => {
  const g = new THREE.ConeGeometry(1.7, 5.6, 28, 1, true); g.translate(0, -2.8, 0); g.rotateX(-Math.PI / 2); g.scale(1, 0.4, 1);
  return { geo: g, mat: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x39d0e8).multiplyScalar(0.7), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }) };
})();

export interface Rig {
  id: string; root: THREE.Group; inner: THREE.Group; scale: number; torso: THREE.Group; head: THREE.Group;
  legs: THREE.Group[]; arms: THREE.Group[]; meshes: THREE.Mesh[];
  ctx: CanvasRenderingContext2D | null; tex: THREE.CanvasTexture | null; faceMat: THREE.MeshBasicMaterial; glowMat: THREE.MeshBasicMaterial;
  own: THREE.Material[]; ownGeos: THREE.BufferGeometry[]; // disposed with the rig
  props: { crate?: THREE.Group; beam?: THREE.Mesh; sparks?: THREE.Group; bar?: THREE.Group; whistle?: THREE.Group };
  lookKey: string; lastSeen: number;
}

function rr(g: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  g.beginPath(); g.moveTo(X + R, Y); g.arcTo(X + W, Y, X + W, Y + H, R); g.arcTo(X + W, Y + H, X, Y + H, R); g.arcTo(X, Y + H, X, Y, R); g.arcTo(X, Y, X + W, Y, R); g.closePath();
}
export function drawFace(g: CanvasRenderingContext2D, expr: Expr, col: string): void {
  const W = 256, H = 176;
  g.clearRect(0, 0, W, H);
  rr(g, 3, 3, W - 6, H - 6, 34); g.fillStyle = "#03080b"; g.fill();
  g.save(); g.clip(); g.globalAlpha = 0.07; g.fillStyle = "#8fe6f5"; for (let y = 6; y < H; y += 6) g.fillRect(0, y, W, 1.3); g.restore();
  if (expr === "off") return;
  g.save(); g.fillStyle = col; g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = expr === "sleep" ? 6 : 16; g.lineCap = "round"; g.lineJoin = "round";
  const E = [86, 170];
  const pill = (cx: number, cy: number, w: number, h: number) => { rr(g, cx - w / 2, cy - h / 2, w, h, Math.min(w, h) / 2); g.fill(); };
  switch (expr) {
    case "eyes": E.forEach(e => pill(e, 86, 26, 54)); break;
    case "focus": E.forEach(e => pill(e, 90, 40, 20)); break;
    case "down": E.forEach(e => pill(e, 108, 34, 18)); break;
    case "scan": pill(128, 84, 180, 24); g.globalAlpha = 0.9; g.fillStyle = "#ffffff"; pill(150, 84, 26, 14); break;
    case "happy": g.lineWidth = 13; E.forEach(e => { g.beginPath(); g.arc(e, 104, 20, Math.PI * 1.12, Math.PI * 1.88); g.stroke(); }); break;
    case "strain": case "blow":
      g.lineWidth = 12;
      g.beginPath(); g.moveTo(68, 60); g.lineTo(100, 82); g.lineTo(68, 104); g.stroke();
      g.beginPath(); g.moveTo(188, 60); g.lineTo(156, 82); g.lineTo(188, 104); g.stroke();
      g.lineWidth = 7; g.beginPath();
      if (expr === "blow") g.arc(128, 132, 10, 0, 7); else { g.moveTo(108, 134); g.lineTo(148, 134); }
      g.stroke(); break;
    case "q": g.font = `700 118px ${SORA}`; g.textAlign = "center"; g.fillText("?", 128, 132); break;
    case "bang": g.font = `700 118px ${SORA}`; g.textAlign = "center"; g.fillText("!", 128, 132); break;
    case "check": g.lineWidth = 17; g.beginPath(); g.moveTo(82, 92); g.lineTo(114, 122); g.lineTo(176, 58); g.stroke(); break;
    case "stopped": pill(86, 88, 30, 30); pill(170, 88, 30, 30); break;
    case "sleep":
      g.lineWidth = 9; g.beginPath(); g.moveTo(70, 104); g.lineTo(102, 104); g.moveTo(154, 104); g.lineTo(186, 104); g.stroke();
      g.font = `700 30px ${SORA}`; g.fillText("z", 188, 62); g.font = `700 22px ${SORA}`; g.fillText("z", 210, 40); break;
  }
  g.restore();
}

export function makeRobot(id: string, o: { body?: number; trim?: number; scale?: number } = {}): Rig {
  const { body = 0xe8ecef, trim = 0x6c8794, scale = 1 } = o;
  const P = partsFor(body, trim), S = shared();
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x39d0e8 });
  let ctx: CanvasRenderingContext2D | null = null, tex: THREE.CanvasTexture | null = null;
  if (typeof document !== "undefined") {
    const cv = document.createElement("canvas"); cv.width = 256; cv.height = 176;
    ctx = cv.getContext("2d");
    if (ctx) { tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; }
  }
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const root = new THREE.Group(), inner = new THREE.Group(); inner.scale.setScalar(scale); root.add(inner);
  const meshes: THREE.Mesh[] = [];
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, shadows = true) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
    if (shadows) { m.castShadow = true; m.receiveShadow = true; }
    m.userData.robotId = id; parent.add(m); meshes.push(m); return m;
  };
  const legs = [-1, 1].map(s => { const p = new THREE.Group(); p.position.set(0.7 * s, 2.0, 0); inner.add(p); mk(P.leg, P.mat, p); return p; });
  const torso = new THREE.Group(); torso.position.y = 2.0; inner.add(torso);
  mk(P.body, P.mat, torso); mk(S.belly, glowMat, torso, 0, 1.2, 1.012, false);
  // arms cast no shadow: too small to see, and every caster is drawn again in the shadow pass
  const arms = [-1, 1].map(s => { const p = new THREE.Group(); p.position.set(1.62 * s, 2.2, 0); torso.add(p); const a = mk(P.arm, P.mat, p); a.castShadow = false; return p; });
  const head = new THREE.Group(); head.position.y = 2.7; torso.add(head);
  mk(P.head, P.mat, head);
  mk(S.face, faceMat, head, 0, 1.45, 1.405, false);
  mk(S.ball, glowMat, head, 0, 4.0, 0, false);
  return { id, root, inner, scale, torso, head, legs, arms, meshes, ctx, tex, faceMat, glowMat, own: [glowMat, faceMat], ownGeos: [], props: {}, lookKey: "", lastSeen: 0 };
}

// A worker's props: the crate (applying, outbound), the scan beam (reading), sparks (failed).
export function addWorkerProps(r: Rig): void {
  const crate = new THREE.Group();
  const cm = std(0xffb547, { r: 0.5, m: 0.1 }), cg = new RoundedBoxGeometry(1.9, 1.3, 1.3, 2, 0.2);
  crate.add(new THREE.Mesh(cg, cm));
  const labelTex = typeof document !== "undefined" ? signTex("APPLY", "#1b1200", 256, 96, `700 60px ${MONO}`) : null; // no canvas outside a page (unit tests)
  const lm = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true }), lg = new THREE.PlaneGeometry(1.2, 0.5);
  const label = new THREE.Mesh(lg, lm); label.position.set(0, 0.05, 0.66); crate.add(label);
  crate.position.set(0, 2.25, 1.75); r.torso.add(crate);
  const b = beam(); const bm = new THREE.Mesh(b.geo, b.mat); bm.position.set(0, 1.45, 1.45); r.head.add(bm);
  const sparks = new THREE.Group(); const sm = glow(0xffb067, 3), sg = new THREE.SphereGeometry(0.13, 6, 4);
  for (let i = 0; i < 6; i++) sparks.add(new THREE.Mesh(sg, sm));
  r.head.add(sparks);
  for (const m of crate.children as THREE.Mesh[]) m.userData.robotId = r.id;
  r.props = { crate, beam: bm, sparks };
  r.own.push(cm, lm, sm); r.ownGeos.push(cg, lg, sg);
}
// Sidekick's extras: headband, barbell, whistle.
export function addSidekickProps(r: Rig): void {
  const band = std(0xff6b55, { r: 0.6 });
  const hb = new THREE.Mesh(new RoundedBoxGeometry(3.95, 0.48, 2.95, 2, 0.2), band); hb.position.y = 2.55; hb.castShadow = true; hb.userData.robotId = r.id; r.head.add(hb);
  // the barbell: chrome bar, coral and dark plates, one mesh
  const bar = new THREE.Group();
  const pieces = [piece(new THREE.CylinderGeometry(0.14, 0.14, 7.4, 10), 0xb7c0c6, at(0, 0, 0, Math.PI / 2))];
  for (const s of [-1, 1]) for (const [k, rad, c] of [[2.9, 1.15, 0xff7a5c], [3.35, 0.85, 0x2b3238]] as const) pieces.push(piece(new THREE.CylinderGeometry(rad, rad, 0.42, 26), c, at(k * s, 0, 0, Math.PI / 2)));
  const barMesh = new THREE.Mesh(merge(pieces), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.5 }));
  barMesh.castShadow = true; barMesh.userData.robotId = r.id; bar.add(barMesh);
  r.torso.add(bar);
  const whistle = new THREE.Group();
  const w = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.7, 12), std(0xd6dde1, { m: 0.9, r: 0.2 })); w.rotation.x = Math.PI / 2; whistle.add(w);
  whistle.position.set(0, 0.45, 1.75); r.head.add(whistle);
  r.props = { ...r.props, bar, whistle };
}

// Redraws the face only when the expression, colour or brightness changes.
export function setLook(r: Rig, l: Look): void {
  const key = `${l.expr}|${l.col}|${l.bright}`;
  if (r.lookKey === key) return;
  r.lookKey = key;
  if (r.ctx && r.tex) { drawFace(r.ctx, l.expr, l.col); r.tex.needsUpdate = true; }
  r.faceMat.color.setScalar(l.bright);
}
export function setGlow(r: Rig, g: Glow): void { r.glowMat.color.set(g.hex).multiplyScalar(g.k); }

// ---------- poses (03 › Pose system) ----------
export function resetPose(r: Rig): void {
  r.inner.position.set(0, 0, 0); r.torso.position.y = 2.0; r.torso.rotation.set(0, 0, 0); r.head.rotation.set(0, 0, 0);
  for (const l of r.legs) l.rotation.set(0, 0, 0);
  for (const a of r.arms) a.rotation.set(0, 0, 0);
}
export function sitPose(r: Rig, seat: number): void { for (const l of r.legs) l.rotation.x = -1.5; r.inner.position.y = (seat - 1.55) * r.scale; }

// A worker's pose for its activity at time t (already desynchronised by n). moving: the loop runs
// (sparks and waving show only then). outbound: a courier carrying its crate (from the lane).
export function poseWorker(r: Rig, a: Activity, t: number, moving: boolean, outbound = true): void {
  resetPose(r);
  const p = r.props;
  if (p.crate) p.crate.visible = a === "apply" && outbound;
  if (p.beam) p.beam.visible = a === "read";
  if (p.sparks) p.sparks.visible = a === "fail" && moving;
  switch (a) {
    case "read":
      r.head.rotation.x = 0.16 * Math.sin(t * 1.8) - 0.05; r.head.rotation.y = 0.22 * Math.sin(t * 0.9);
      r.arms[1].rotation.x = -0.7; r.torso.position.y = 2.0 + 0.04 * Math.sin(t * 2);
      if (p.beam) (p.beam.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.12 * Math.abs(Math.sin(t * 3.1));
      break;
    case "write":
      r.head.rotation.x = 0.28;
      r.arms.forEach((arm, i) => { arm.rotation.x = -1.0 + 0.12 * Math.sin(t * 14 + i * Math.PI); arm.rotation.z = 0.08 * (i ? -1 : 1); });
      break;
    case "apply": {
      const sw = Math.sin(t * 7.5);
      r.legs[0].rotation.x = 0.55 * sw; r.legs[1].rotation.x = -0.55 * sw;
      r.inner.position.y = 0.12 * Math.abs(sw);
      if (outbound) r.arms.forEach(arm => { arm.rotation.x = -1.25; });
      else { r.arms[0].rotation.x = -0.45 * sw; r.arms[1].rotation.x = 0.45 * sw; }
      r.torso.rotation.x = 0.06;
      break;
    }
    case "start":
      r.inner.position.y = 0.18 * Math.abs(Math.sin(t * 3.2)); r.arms[1].rotation.x = -2.7; r.arms[1].rotation.z = 0.3 + 0.2 * Math.sin(t * 6);
      break;
    case "ask":
      sitPose(r, 1.5); r.arms[1].rotation.x = -2.9; r.arms[1].rotation.z = 0.25 + 0.28 * Math.sin(t * 4.5); r.arms[0].rotation.x = -0.6;
      break;
    case "fail":
      sitPose(r, 0.45); r.torso.rotation.x = -0.3; r.head.rotation.x = 0.5; r.head.rotation.z = 0.12;
      r.arms.forEach((arm, i) => { arm.rotation.z = 0.55 * (i ? 1 : -1); arm.rotation.x = 0.2; });
      if (p.sparks && moving) p.sparks.children.forEach((sp, i) => {
        const h = Math.sin(Math.floor(t * 10) * 12.9898 + i * 78.233) * 43758.5453, f = h - Math.floor(h);
        sp.visible = f > 0.45; sp.position.set((f - 0.5) * 3.4, 3.2 + f * 1.4, (((f * 7) % 1) - 0.5) * 2.4);
      });
      break;
    case "done": sitPose(r, 1.5); r.arms.forEach(arm => { arm.rotation.x = -0.25; }); break;
    case "stopped": sitPose(r, 1.5); r.arms.forEach(arm => { arm.rotation.x = -0.25; }); r.head.rotation.x = 0.1; break;
    case "nonews": case "wait":
      sitPose(r, 1.5); r.torso.rotation.x = 0.16; r.head.rotation.x = 0.4; r.arms.forEach(arm => { arm.rotation.x = -0.15; });
      break;
  }
}

// Sidekick's pose for his mode. Returns the lift phase (0..1) for the HQ light and the antenna.
export function poseSidekick(r: Rig, mode: SidekickMode, t: number, moving: boolean, faceTo?: number): number {
  resetPose(r);
  r.root.rotation.y = 0;
  if (r.props.bar) r.props.bar.visible = mode === "lift";
  if (r.props.whistle) r.props.whistle.visible = mode === "whistle";
  let ph = 0;
  switch (mode) {
    case "lift": {
      ph = moving ? 0.5 - 0.5 * Math.cos((t * Math.PI * 2) / 1.6) : 1;
      const th = -1.75 + (-3.0 + 1.75) * ph;
      r.arms.forEach((a, i) => { a.rotation.x = th; a.rotation.z = 0.12 * (i ? 1 : -1); });
      r.props.bar?.position.set(0, 2.2 - 1.5 * Math.cos(th), -1.5 * Math.sin(th));
      r.torso.position.y = 2.0 - 0.28 * (1 - ph);
      setLook(r, { ...SIDEKICK_LOOK.lift, expr: ph > 0.65 ? "strain" : "focus" });
      setGlow(r, { hex: 0xffd9a0, k: 1.4 + 0.8 * ph });
      break;
    }
    case "whistle":
      if (faceTo !== undefined) r.root.rotation.y = faceTo;
      r.arms[1].rotation.x = -2.05 + (moving ? 0.08 * Math.sin(t * 6) : 0); r.arms[1].rotation.z = 0.1;
      r.arms[0].rotation.x = -2.4; r.arms[0].rotation.z = 0.9;
      setLook(r, SIDEKICK_LOOK.whistle); setGlow(r, { hex: 0xffd9a0, k: 1.8 });
      break;
    case "coach":
      r.head.rotation.y = moving ? 0.3 * Math.sin(t * 0.5) : 0;
      r.arms.forEach(a => { a.rotation.x = -0.15; });
      setLook(r, SIDEKICK_LOOK.coach); setGlow(r, { hex: 0xffd9a0, k: 1.4 });
      break;
    case "rest":
      sitPose(r, 0.45); r.torso.rotation.x = 0.1; r.arms.forEach(a => { a.rotation.x = -0.9; });
      setLook(r, SIDEKICK_LOOK.rest); setGlow(r, { hex: 0xd9a54a, k: 0.8 });
      break;
    case "sleep":
      sitPose(r, 0.45); r.torso.rotation.x = 0.18; r.head.rotation.x = 0.38; r.arms.forEach(a => { a.rotation.x = -0.3; });
      setLook(r, SIDEKICK_LOOK.sleep); setGlow(r, { hex: 0x000000, k: 0 });
      break;
  }
  return ph;
}

// Frees a rig's own materials, textures and prop geometries (the shared robot geometry stays).
export function disposeRig(r: Rig): void {
  r.root.removeFromParent();
  for (const m of r.own) { (m as THREE.MeshBasicMaterial).map?.dispose(); m.dispose(); }
  for (const g of r.ownGeos) g.dispose();
  r.tex?.dispose();
}
