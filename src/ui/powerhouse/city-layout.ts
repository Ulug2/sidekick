// Silicon City layout (docs/powerhouse-redesign/02-world.md, 04-state-mapping.md): pure numbers
// only, no Three.js. The board is 200 (x) × 120 (z), lying flat, top at y = G; +z faces the default
// camera. ROOF is the top of the HQ roof deck (the GPU die); MB is the motherboard surface.

export const G = 2;
export const ROOF = 35.9;
export const MB = -70;
export const BOARD = { w: 200, d: 120 };

export type XZ = [number, number];
// The card's traces as a routed road network.
export const ROADS: XZ[][] = [
  [[-94, 46], [60, 46]], [[-94, -46], [60, -46]], // front avenue (dock street), back avenue
  [[-94, 0], [-26, 0]], [[26, 0], [60, 0]], // crosstown, split by HQ
  [[-26, -26], [26, -26], [26, 26], [-26, 26], [-26, -26]], // HQ ring
  [[0, 26], [0, 46]], [[0, -26], [0, -46]],
  [[-64, -46], [-64, 46]], [[-40, 0], [-40, 46]], [[60, -46], [60, 46]], [[-94, -46], [-94, 46]],
  [[26, -26], [40, -40], [40, -46]], [[-26, -26], [-38, -38], [-38, -46]], // 45° diagonals
  [[26, 26], [38, 38], [38, 46]], [[-26, 26], [-34, 34], [-34, 46]],
  [[-50, 46], [-50, 56]], [[-14, 46], [-14, 56]], [[12, 46], [12, 56]] // dock spurs
];

export type Zone = "rack" | "terminal" | "lane" | "entrance" | "bench" | "silos";
// A spot: where a robot stands, which way it faces (a direction on the board), and for the bench
// the seat height above G.
export interface Spot { x: number; z: number; face: XZ; seat?: number }
export const SPOTS: Record<Exclude<Zone, "lane">, Spot[]> = {
  rack: [[-48, -14], [-48, -10], [-48, -6]].map(([x, z]) => ({ x, z, face: [-1, 0] as XZ })),
  terminal: [[-51, 6], [-51, 14]].map(([x, z]) => ({ x, z, face: [-1, 0] as XZ })),
  entrance: [[-40, 4], [-36, 4]].map(([x, z]) => ({ x, z, face: [0.4, 1] as XZ })),
  bench: [-41, -37, -33, -29, -25].map(x => ({ x, z: 51.5, face: [0, 1] as XZ, seat: 1.5 })),
  silos: [[-73, 30], [-73, 18], [-73, -30]].map(([x, z]) => ({ x, z, face: [1, 0.45] as XZ }))
};
// Couriers (applying) walk this lane, ping-pong at LANE_SPEED; outbound carries the crate.
export const LANE: XZ[] = [[-40, 3], [-40, 46], [-14, 46], [-14, 53]];
export const LANE_PHASES = [0.05, 0.3, 0.55, 0.8];
export const LANE_SPEED = 4.2;
export const CAPACITY: Record<Zone, number> = { rack: 3, terminal: 2, lane: 4, entrance: 2, bench: 5, silos: 3 };
// Sidekick on the HQ roof, facing +z.
export const SIDEKICK_SPOT = { x: 0, y: ROOF, z: 1.2 };

// Packet routes (traffic). Each path is a polyline on the roads; packets loop along it at v.
export interface Route { paths: XZ[][]; color: number; v: number[] }
export const ROUTES: Record<"archive" | "docks" | "plant" | "ring", Route> = {
  archive: { paths: [[[0, -26], [-26, -26], [-26, 0], [-46, 0]]], color: 0x5fe3f5, v: [11] },
  docks: { paths: [[[-46, 0], [-64, 0], [-64, 46], [-14, 46], [-14, 56]], [[0, 26], [0, 46], [-14, 46], [-14, 56]]], color: 0xffc35a, v: [10, 9] },
  plant: { paths: [[[26, 0], [60, 0], [60, -46], [0, -46], [0, -26]]], color: 0x5fe3f5, v: [12] },
  ring: { paths: [[[26, 26], [38, 38], [38, 46], [12, 46], [12, 56]]], color: 0x5fe3f5, v: [10] }
};

// The camera: an orbit around a target.
export const CAMERA = {
  home: { radius: 205, polar: 1.08, azimuth: 0.42, target: { x: -8, y: 9, z: 6 } },
  min: 22, max: 360, polarMin: 0.18, polarMax: 1.38, focus: 32, focusSidekick: 46, flightMs: 700
};
export const LOD = { near: 70, far: 95 }; // optional far-view beacons (03 › Far view)

// ---------- pure helpers ----------
export const polylineLength = (p: XZ[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
// The point a fraction f (0..1) along a polyline, and the direction of travel there.
export function along(p: XZ[], f: number): { x: number; z: number; dir: XZ } {
  const total = polylineLength(p);
  let d = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < p.length; i++) {
    const [ax, az] = p[i - 1], [bx, bz] = p[i];
    const seg = Math.hypot(bx - ax, bz - az);
    if (d <= seg || i === p.length - 1) {
      const k = seg ? Math.min(1, d / seg) : 0;
      return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, dir: seg ? [(bx - ax) / seg, (bz - az) / seg] : [0, 1] };
    }
    d -= seg;
  }
  return { x: p[0][0], z: p[0][1], dir: [0, 1] };
}
// A courier's place on the lane at time t (s), from its phase: ping-pong, outbound = carrying.
export function lanePosition(phase: number, t: number): { x: number; z: number; dir: XZ; outbound: boolean } {
  const len = polylineLength(LANE);
  const u = ((phase * 2 + (t * LANE_SPEED) / len) % 2 + 2) % 2; // 0..2: there and back
  const outbound = u < 1;
  const at = along(LANE, outbound ? u : 2 - u);
  return { ...at, dir: outbound ? at.dir : [-at.dir[0], -at.dir[1]], outbound };
}
// Rotation around y that makes a model facing +z face the direction (dx, dz).
export const yawOf = ([dx, dz]: XZ) => Math.atan2(dx, dz);

// ---------- badges on screen (CSS pixels) ----------
export const BADGE_W = 30, BADGE_H = 26; // a badge's number disc plus a gap
// where a crowded badge may go, in its own widths and in rows from its robot: in place, right, left, rows up
const SPOTS_NEAR: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, -1], [1, -1], [-1, -1], [0, -2], [1, -2], [-1, -2]];
/** A badge's width: the number disc, plus its tag ("?", "!", "done", "finishing"…) to the right. */
export const badgeWidth = (tag: string): number => BADGE_W + (tag ? 14 + 7 * tag.length : 0);
/**
 * Spread badges so none covers another: each badge (centre of its number disc at x, y; w wide to the
 * right from x - 14) takes the first of SPOTS_NEAR that overlaps nothing placed before it, or the one
 * that overlaps least. Returns each badge's new x, y, in the same order.
 */
export function spreadBadges(items: { x: number; y: number; w: number }[]): [number, number][] {
  const placed: { x: number; y: number; w: number }[] = [];
  const overlap = (x: number, y: number, w: number) => placed.reduce((sum, p) => sum + Math.max(0, Math.min(x + w, p.x + p.w) - Math.max(x, p.x)) * Math.max(0, BADGE_H - Math.abs(p.y - y)), 0);
  return items.map(({ x, y, w }) => {
    let best = SPOTS_NEAR[0]!, least = Infinity;
    for (const s of SPOTS_NEAR) {
      const o = overlap(x + s[0] * w - 14, y + s[1] * BADGE_H, w);
      if (o < least) { least = o; best = s; }
      if (o === 0) break;
    }
    const at: [number, number] = [x + best[0] * w, y + best[1] * BADGE_H];
    placed.push({ x: at[0] - 14, y: at[1], w });
    return at;
  });
}
