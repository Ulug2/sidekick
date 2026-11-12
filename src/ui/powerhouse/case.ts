// The PC case around the card (docs/powerhouse-redesign/02-world.md › PC case background; ported from
// reference/powerhouse-city.html). Static background: nothing casts shadows (the shadow map covers
// only the card). The fan rotors spin only while the scene animates (city-view drives them).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { canvasTex, glow, seeded, signTex, std, MONO } from "./materials.js";
import { mergeStatic, type Mood } from "./city.js";
import { G, MB } from "./city-layout.js";

export interface Case { bgFans: THREE.Group[]; setMood(mood: Mood): void }

export function buildCase(world: THREE.Object3D): Case {
  const root = new THREE.Group(); world.add(root);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; // no shadows in the background
  };
  const rbox = (w: number, h: number, d: number, seg: number, r: number) => new RoundedBoxGeometry(w, h, d, seg, r);
  const rnd = seeded(41);
  const keep = new Set<THREE.Object3D>();

  // ---------- the motherboard floor ----------
  const mbTex = canvasTex(2048, 2048, (g, W, H) => {
    g.fillStyle = "#071014"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#0c1a1f"; g.lineWidth = 1;
    for (let i = 0; i <= W; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, H); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(W, i); g.stroke(); }
    for (let k = 0; k < 260; k++) {
      let px = rnd() * W, py = rnd() * H; g.beginPath(); g.moveTo(px, py);
      const n = 3 + Math.floor(rnd() * 4);
      for (let j = 0; j < n; j++) {
        const L = 20 + rnd() * 120, d = Math.floor(rnd() * 4);
        if (d === 0) px += L; else if (d === 1) px -= L; else if (d === 2) py += L; else py -= L;
        if (rnd() < 0.35) { px += L * 0.5; py += (rnd() < 0.5 ? -1 : 1) * L * 0.5; }
        g.lineTo(px, py);
      }
      g.strokeStyle = rnd() < 0.8 ? "#5a3c22" : "#1d6f7e"; g.lineWidth = 1.5 + rnd() * 2.5; g.stroke();
      g.fillStyle = "#9a6a30"; g.beginPath(); g.arc(px, py, 3, 0, 7); g.fill();
    }
    g.fillStyle = "#c9a24a"; g.font = `600 34px ${MONO}`; g.fillText("SK-Z890 · MAINBOARD", 1180, 1260);
    g.font = `500 22px ${MONO}`; g.fillText("PCIE_1  x16", 960, 1100); g.fillText("DIMM_A1 A2 B1 B2", 560, 820); g.fillText("CPU_FAN", 820, 560);
  });
  const gr = seeded(43);
  const mbGlow = canvasTex(1024, 1024, (g, W, H) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    for (let k = 0; k < 90; k++) {
      let px = gr() * W, py = gr() * H; g.beginPath(); g.moveTo(px, py);
      for (let j = 0; j < 4; j++) { const L = 10 + gr() * 60; if (gr() < 0.5) px += gr() < 0.5 ? -L : L; else py += gr() < 0.5 ? -L : L; g.lineTo(px, py); }
      g.strokeStyle = gr() < 0.7 ? "#0f5b68" : "#3b2a7a"; g.lineWidth = 1.2; g.stroke();
    }
  });
  const mbMat = new THREE.MeshStandardMaterial({ map: mbTex, emissiveMap: mbGlow, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.85, metalness: 0.2 });
  add(new THREE.PlaneGeometry(2400, 2400), mbMat, 0, MB, 0).rotation.x = -Math.PI / 2;

  // ---------- the card's mounting: brass standoffs, the slot and the riser ----------
  const brass = std(0xb08a4a, { m: 1, r: 0.35 });
  for (const [x, z] of [[-92, -52], [92, -52], [-92, 52], [92, 52]]) add(new THREE.CylinderGeometry(2.2, 2.6, G - MB, 14), brass, x, (G + MB) / 2 - 0.5, z);
  add(rbox(104, 9, 12, 2, 1), std(0x111417, { r: 0.5, m: 0.3 }), -20, MB + 4.5, 66);
  const riserTex = canvasTex(512, 256, (g, W, H) => { g.fillStyle = "#0b0e10"; g.fillRect(0, 0, W, H); for (let i = 8; i < W; i += 10) { g.fillStyle = i % 40 === 8 ? "#ffcf6a" : "#6a4f22"; g.fillRect(i, 0, 3, H); } });
  add(new THREE.PlaneGeometry(90, G - MB - 4), new THREE.MeshStandardMaterial({ map: riserTex, emissiveMap: riserTex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6, side: THREE.DoubleSide }), -20, (G + MB) / 2 + 2, 61).rotation.x = -0.12;

  // ---------- RAM: four lit towers on the left ----------
  const ramBar = canvasTex(1024, 16, (g, W, H) => { const l = g.createLinearGradient(0, 0, W, 0); l.addColorStop(0, "#39d0e8"); l.addColorStop(0.35, "#7a5cff"); l.addColorStop(0.7, "#ff6fb5"); l.addColorStop(1, "#39d0e8"); g.fillStyle = l; g.fillRect(0, 0, W, H); });
  const ramLabel = signTex("SK-DDR5 · 6400", "#c9d6dc", 1024, 96, `600 56px ${MONO}`);
  const ramBody = std(0x1b2026, { r: 0.4, m: 0.75 }), ramLight = new THREE.MeshBasicMaterial({ map: ramBar, color: new THREE.Color(1.5, 1.5, 1.5) });
  const ramLab = new THREE.MeshBasicMaterial({ map: ramLabel, transparent: true, color: new THREE.Color(0.8, 0.8, 0.8) }), slot = std(0x0d1013, { r: 0.6 });
  for (let i = 0; i < 4; i++) {
    const x = -330 + i * 30, z = -170;
    add(rbox(12, 150, 380, 2, 2), ramBody, x, MB + 75, z);
    add(new THREE.BoxGeometry(12.6, 7, 382), ramLight, x, MB + 153, z);
    add(new THREE.PlaneGeometry(180, 17), ramLab, x + 6.4, MB + 110, z).rotation.y = Math.PI / 2;
    add(new THREE.BoxGeometry(14, 10, 400), slot, x, MB + 5, z);
  }
  const rl = new THREE.PointLight(0x7a5cff, 1.6, 0, 0); rl.position.set(-300, MB + 170, -120); root.add(rl);

  // ---------- case fans (helper) ----------
  const bgFans: THREE.Group[] = [];
  const rings: { mat: THREE.MeshBasicMaterial; hex: number }[] = [];
  function caseFan(r: number, ringCol: number): THREE.Group {
    const g = new THREE.Group();
    add(rbox(r * 2.3, r * 2.3, 10, 3, 6), std(0x111417, { r: 0.5, m: 0.4 }), 0, 0, -6, g);
    add(new THREE.CircleGeometry(r * 1.02, 48), std(0x050608, { r: 0.9 }), 0, 0, -0.6, g);
    const rot = new THREE.Group(); g.add(rot);
    add(new THREE.CylinderGeometry(r * 0.24, r * 0.24, 4, 28), std(0x1c2025, { r: 0.4, m: 0.5 }), 0, 0, 1, rot).rotation.x = Math.PI / 2;
    const bladeMat = std(0x16191c, { r: 0.5, m: 0.3 }), bladeGeo = rbox(r * 0.78, r * 0.3, 1.2, 2, 0.5);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const b = add(bladeGeo, bladeMat, Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, 1, rot);
      b.rotation.set(0.45, 0, a);
    }
    const ringMat = glow(ringCol, 1.6); rings.push({ mat: ringMat, hex: ringCol });
    add(new THREE.TorusGeometry(r * 1.03, r * 0.035, 10, 90), ringMat, 0, 0, 2, g);
    bgFans.push(rot); keep.add(g);
    return g;
  }

  // ---------- the CPU cooler tower with its front fan ----------
  const cooler = new THREE.Group(); cooler.position.set(-120, MB, -380); root.add(cooler); keep.add(cooler);
  add(rbox(90, 14, 90, 2, 3), std(0x2a3036, { m: 0.8, r: 0.35 }), 0, 7, 0, cooler);
  const cfins = new THREE.InstancedMesh(new THREE.BoxGeometry(150, 1.4, 110), std(0xa3acb2, { m: 0.85, r: 0.32 }), 46);
  for (let i = 0; i < 46; i++) cfins.setMatrixAt(i, new THREE.Matrix4().makeTranslation(0, 40 + i * 4.4, 0));
  cooler.add(cfins);
  const pipe = std(0xb8713f, { m: 1, r: 0.42 }), pipeGeo = new THREE.CylinderGeometry(3, 3, 210, 10);
  for (const px of [-40, -20, 0, 20, 40]) add(pipeGeo, pipe, px, 115, -10, cooler);
  add(rbox(154, 6, 114, 2, 2.5), std(0x15181b, { r: 0.4, m: 0.6 }), 0, 245, 0, cooler);
  add(new THREE.PlaneGeometry(90, 17), new THREE.MeshBasicMaterial({ map: signTex("SIDEKICK", "#ffe2b0"), transparent: true, color: new THREE.Color(1.5, 1.5, 1.5) }), 0, 248.2, 0, cooler).rotation.x = -Math.PI / 2;
  const cf = caseFan(62, 0x39d0e8); cf.position.set(0, 150, 62); cooler.add(cf);

  // ---------- the back wall: perforated steel, two RGB exhaust fans, the I/O shield ----------
  const holes = canvasTex(256, 256, (g, W, H) => { g.fillStyle = "#0d1318"; g.fillRect(0, 0, W, H); g.fillStyle = "#04070a"; for (let yy = 0, row = 0; yy < H + 16; yy += 16, row++) for (let xx = (row % 2) * 9; xx < W + 18; xx += 18) { g.beginPath(); g.arc(xx, yy, 5.2, 0, 7); g.fill(); } });
  holes.wrapS = holes.wrapT = THREE.RepeatWrapping; holes.repeat.set(26, 14);
  add(new THREE.PlaneGeometry(2600, 1400), std(0xffffff, { r: 0.6, m: 0.6, extra: { map: holes } }), 0, MB + 600, -600);
  const f1 = caseFan(120, 0x7a5cff); f1.position.set(-430, MB + 175, -592); root.add(f1);
  const f2 = caseFan(120, 0x39d0e8); f2.position.set(-160, MB + 175, -592); root.add(f2);
  add(rbox(150, 240, 6, 2, 3), std(0x2a3238, { m: 0.8, r: 0.3 }), 250, MB + 170, -594);
  const portA = glow(0x2a6cff, 0.7), portB = glow(0x39d0e8, 0.7);
  for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(40, 14, 2), i % 2 ? portA : portB, 250, MB + 95 + i * 30, -590);

  // ---------- sleeved cables from the PSU side ----------
  const sleeve = std(0x15181c, { r: 0.75, m: 0.05 }), comb = glow(0x46d6ea, 1.0);
  for (let i = 0; i < 5; i++) {
    const o = i * 9;
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(560 + o, MB + 420, -320), new THREE.Vector3(500 + o, MB + 260, -260), new THREE.Vector3(420 + o, MB + 90, -150), new THREE.Vector3(360 + o, MB + 8, -90)]);
    add(new THREE.TubeGeometry(c, 40, 3.6, 10, false), sleeve);
  }
  for (const t of [0.3, 0.6]) add(rbox(56, 6, 10, 2, 2), comb, 500 + 18 - t * 120, MB + 420 - t * 360, -320 + t * 190);
  add(rbox(70, 12, 30, 2, 3), std(0x111417, { r: 0.5 }), 378, MB + 6, -90);

  // ---------- scattered parts: chips, capacitors, VRM heatsinks ----------
  const pr = seeded(77);
  const chips = new THREE.InstancedMesh(rbox(1, 1, 1, 1, 0.08), std(0x0e1114, { r: 0.45, m: 0.4 }), 90);
  const caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 16), std(0x231e33, { r: 0.45, m: 0.3 }), 160);
  const clear = (x: number, z: number) => (Math.abs(x) < 170 && Math.abs(z) < 120) || (x < -280 && x > -370 && z > -380 && z < 40) || (x > -220 && x < -20 && z > -470 && z < -290);
  const q = new THREE.Quaternion();
  for (let ci = 0; ci < 90;) { const x = (pr() - 0.5) * 1800, z = -580 + pr() * 1360; if (clear(x, z)) continue; const w = 14 + pr() * 40, h = 3 + pr() * 6; chips.setMatrixAt(ci++, new THREE.Matrix4().compose(new THREE.Vector3(x, MB + h / 2, z), q, new THREE.Vector3(w, h, w * (0.6 + pr() * 0.6)))); }
  for (let ki = 0; ki < 160;) { const x = (pr() - 0.5) * 1800, z = -580 + pr() * 1360; if (clear(x, z)) continue; const r = 3 + pr() * 4, h = 8 + pr() * 14; caps.setMatrixAt(ki++, new THREE.Matrix4().compose(new THREE.Vector3(x, MB + h / 2, z), q, new THREE.Vector3(r, h, r))); }
  root.add(chips, caps);
  const vrm = std(0x2b3238, { m: 0.85, r: 0.3 }), vrmGeo = rbox(26, 34, 90, 2, 3);
  for (let i = 0; i < 7; i++) add(vrmGeo, vrm, -230 + i * 30, MB + 17, -260);

  // ---------- dust in the case air (static) ----------
  const n = 700, pos = new Float32Array(n * 3);
  const dr = seeded(91);
  for (let i = 0; i < n; i++) { pos[i * 3] = (dr() - 0.5) * 1400; pos[i * 3 + 1] = MB + dr() * 420; pos[i * 3 + 2] = -700 + dr() * 1100; }
  const dust = new THREE.BufferGeometry(); dust.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  root.add(new THREE.Points(dust, new THREE.PointsMaterial({ color: 0x6fd8ea, size: 1.6, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })));

  mergeStatic(root, keep); // one draw per material for the background (the fans and the cooler stay)

  return {
    bgFans,
    // asleep, the case's RGB dims with the city
    setMood(mood) {
      for (const r of rings) r.mat.color.set(r.hex).multiplyScalar(mood === "idle" ? 0.7 : 1.6);
      mbMat.emissiveIntensity = mood === "idle" ? 0.5 : 0.9;
    }
  };
}
