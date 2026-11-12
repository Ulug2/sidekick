// Traffic on the city's roads (docs/powerhouse-redesign/04 › Traffic, Dispatch trace): packets that
// summarise real activity (never when nothing runs), step pulses (one bright packet from HQ to a
// worker's district each time it logs a step), and the dispatch trace (a dashed arc from Sidekick's
// hand to the worker he just started). All drawn as few objects: one instanced mesh per kind.
import * as THREE from "three";
import { G, ROOF, ROUTES, along, polylineLength, type XZ } from "./city-layout.js";

export type RouteKey = keyof typeof ROUTES;
interface Path { pts: XZ[]; L: number; v: number; color: THREE.Color }
const PULSE_MS = 1500;
const MAX_PACKETS = 48, MAX_PULSES = 16;

export interface Traffic {
  setCounts(counts: Record<RouteKey, number>, show: boolean): void;
  update(t: number): void; // place the packets at time t
  pulse(route: "archive" | "docks", now: number): void;
  stepPulses(now: number): boolean; // true while any pulse is still travelling
  setTrace(from: THREE.Vector3 | null, to?: THREE.Vector3): void;
  updateTrace(t: number): void;
  dispose(): void;
}

export function createTraffic(world: THREE.Object3D): Traffic {
  const paths: Record<RouteKey, Path[]> = Object.fromEntries((Object.keys(ROUTES) as RouteKey[]).map(k => [k, ROUTES[k].paths.map((pts, i) => ({ pts, L: polylineLength(pts), v: ROUTES[k].v[i] ?? ROUTES[k].v[0], color: new THREE.Color(ROUTES[k].color).multiplyScalar(2.2) }))])) as Record<RouteKey, Path[]>;
  const packets = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.32, 0.9, 3, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PACKETS);
  packets.count = 0; packets.frustumCulled = false; world.add(packets);
  const pulses = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.5, 1.2, 3, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PULSES);
  pulses.count = 0; pulses.frustumCulled = false; world.add(pulses);
  let counts: Record<RouteKey, number> = { archive: 0, docks: 0, plant: 0, ring: 0 };
  let visible = false;
  const live: { path: Path; start: number }[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  const place = (mesh: THREE.InstancedMesh, i: number, path: Path, s: number) => {
    const at = along(path.pts, s / path.L);
    q.setFromUnitVectors(up, dir.set(at.dir[0], 0, at.dir[1]));
    mesh.setMatrixAt(i, m.compose(p.set(at.x, G + 0.55, at.z), q, one));
  };

  // the dispatch trace: dashes running from the hand to the worker
  const traceMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec2 vUv; uniform float uTime; void main() { float d = step(0.45, fract(vUv.x * 26.0 - uTime * 1.8)); gl_FragColor = vec4(vec3(0.5, 0.9, 0.96) * 2.2 * d, d); }"
  });
  let trace: THREE.Mesh | null = null, traceKey = "";

  return {
    setCounts(c, show) { counts = c; visible = show; packets.visible = show; },
    update(t) {
      if (!visible) { packets.count = 0; return; }
      let k = 0;
      for (const key of Object.keys(paths) as RouteKey[]) for (const path of paths[key]) {
        const n = counts[key];
        for (let i = 0; i < n && k < MAX_PACKETS; i++, k++) {
          place(packets, k, path, (t * path.v + (i / n) * path.L) % path.L);
          packets.setColorAt(k, path.color);
        }
      }
      packets.count = k;
      packets.instanceMatrix.needsUpdate = true;
      if (packets.instanceColor) packets.instanceColor.needsUpdate = true;
    },
    pulse(route, now) {
      if (live.length >= MAX_PULSES) live.shift();
      // archive: HQ → the archive (readers, writers); docks: HQ → the docks (couriers)
      live.push({ path: route === "archive" ? paths.archive[0] : paths.docks[1], start: now });
    },
    stepPulses(now) {
      for (let i = live.length - 1; i >= 0; i--) if (now - live[i].start > PULSE_MS) live.splice(i, 1);
      live.forEach((l, i) => {
        place(pulses, i, l.path, Math.min(1, (now - l.start) / PULSE_MS) * l.path.L);
        pulses.setColorAt(i, new THREE.Color(l.path.color).multiplyScalar(1.4)); // ×3 brighter than a packet
      });
      pulses.count = live.length;
      pulses.instanceMatrix.needsUpdate = true;
      if (pulses.instanceColor) pulses.instanceColor.needsUpdate = true;
      return live.length > 0;
    },
    setTrace(from, to) {
      const key = from && to ? `${to.x.toFixed(1)},${to.z.toFixed(1)}` : "";
      if (key === traceKey) return;
      traceKey = key;
      if (trace) { world.remove(trace); trace.geometry.dispose(); trace = null; }
      if (!from || !to) return;
      const c = from.clone().lerp(to, 0.5); c.y += 22;
      trace = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(from, c, to), 90, 0.22, 6), traceMat);
      world.add(trace);
    },
    updateTrace(t) { traceMat.uniforms.uTime.value = t; },
    dispose() { packets.geometry.dispose(); (packets.material as THREE.Material).dispose(); pulses.geometry.dispose(); (pulses.material as THREE.Material).dispose(); trace?.geometry.dispose(); traceMat.dispose(); }
  };
}
// Where the trace starts: Sidekick's pointing hand on the roof.
export const HAND = new THREE.Vector3(-1.5, ROOF + 8, 1.2);
