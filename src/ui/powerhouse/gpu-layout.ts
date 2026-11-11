// Where things are on the 3D graphics card (docs/DESIGN.md §1, "3D"). Pure: numbers only, so the
// placement and the zoom levels can be tested without WebGL. Units: the board is 200 × 120, lying
// on the XZ plane, top surface at y = BOARD.top; +z faces the default camera.
import { SLOTS, type Area, type Figure, type Scene } from "./scene.js";

export type Zone = "heatpipe" | "vram" | "pcie" | "caps";
export const ZONE_OF: Record<Area, Zone> = { bar: "heatpipe", mat: "vram", bench: "pcie", floor: "caps" };
export interface Spot { x: number; y: number; z: number; facing: number } // facing: radians around y (0 = +z)

export const BOARD = { w: 200, d: 120, top: 2 };
export const DIE = { x: 0, z: 0, size: 24, top: BOARD.top + 4.4 };
export const HEATPIPE = { x: 60, y: 24, z0: -32, z1: 32, r: 1.2 }; // the copper pipe the applying workers hang from
export const VRAM_TOP = BOARD.top + 1.6;
// The alien's body (alien.ts builds it from these): hips above the feet, shoulders above the hips,
// shoulder-to-hand reach.
export const BODY = { hips: 4.3, shoulders: 3.3, armLen: 4, reach: 4 + 0.62 };
// Hanging from the pipe: the body hangs just behind it (so the head clears it) with the arms tilted
// forward; as it rises the arms spread so the hands stay on the pipe (alien.ts "pull").
export const PULL = { forward: 0.5, behind: 3.2, slack: 0.25 };
export const ARM_REACH = BODY.hips + BODY.shoulders + (BODY.reach - PULL.slack) * Math.cos(PULL.forward); // feet to hands

// One spot per slot in scene.ts SLOTS (same counts, same order).
export const SPOTS: Record<Zone, Spot[]> = {
  heatpipe: [-22, 0, 22].map(z => ({ x: HEATPIPE.x + PULL.behind, y: HEATPIPE.y - ARM_REACH, z, facing: -Math.PI / 2 })),
  vram: [-14, 14].map(z => ({ x: -46, y: VRAM_TOP, z, facing: Math.PI / 2 })),
  pcie: [-52, -32, -12].map(x => ({ x, y: BOARD.top, z: BOARD.d / 2 - 2, facing: 0 })),
  caps: [-30, 30].map(z => ({ x: -74, y: BOARD.top, z, facing: Math.PI / 2 }))
};
export const SIDEKICK: Spot = { x: DIE.x, y: DIE.top, z: DIE.z + 2, facing: 0 };
// Where the camera looks from when it flies to a zone (azimuth: 0 = from the front, -π/2 = from the
// die's side): each worker is seen face on, not through the part it is on.
export const FOCUS_AZIMUTH: Record<Zone | "sidekick", number> = { heatpipe: -Math.PI / 2 + 0.35, vram: Math.PI / 2 - 0.5, pcie: 0.15, caps: Math.PI / 2 - 0.3, sidekick: 0.25 };

export interface Placed { figure: Figure; zone: Zone; spot: Spot }
// The figures on stage, each on its zone's spot for its slot.
export function placeFigures(scene: Scene): Placed[] {
  return scene.figures.filter(f => f.onStage && f.slot >= 0).map(f => {
    const zone = ZONE_OF[f.area];
    return { figure: f, zone, spot: SPOTS[zone][f.slot] };
  });
}

// The camera: orbit around a target. Distance decides the level of detail per figure: far away a
// glowing core, close up the alien doing its exercise (crossfade between NEAR and FAR).
export const CAMERA = { home: { radius: 215, polar: 0.95, azimuth: 0.5, target: { x: 4, y: 0, z: 4 } }, min: 22, max: 260, polarMin: 0.18, polarMax: 1.38, focus: 48 };
export const LOD = { near: 70, far: 95 };
// 1 = the alien fully shown, 0 = the core fully shown.
export function alienWeight(distance: number): number {
  if (distance <= LOD.near) return 1;
  if (distance >= LOD.far) return 0;
  return 1 - (distance - LOD.near) / (LOD.far - LOD.near);
}
export const clampRadius = (r: number) => Math.max(CAMERA.min, Math.min(CAMERA.max, r));
export const clampPolar = (p: number) => Math.max(CAMERA.polarMin, Math.min(CAMERA.polarMax, p));
// Keep the orbit target over the board.
export const clampTarget = (t: { x: number; y: number; z: number }) => ({ x: Math.max(-BOARD.w / 2, Math.min(BOARD.w / 2, t.x)), y: Math.max(0, Math.min(30, t.y)), z: Math.max(-BOARD.d / 2, Math.min(BOARD.d / 2, t.z)) });

// Camera position from the orbit parameters.
export function orbitPosition(o: { radius: number; polar: number; azimuth: number; target: { x: number; y: number; z: number } }) {
  return {
    x: o.target.x + o.radius * Math.sin(o.polar) * Math.sin(o.azimuth),
    y: o.target.y + o.radius * Math.cos(o.polar),
    z: o.target.z + o.radius * Math.sin(o.polar) * Math.cos(o.azimuth)
  };
}

// Slot counts must match scene.ts (checked by a unit test).
export const SLOT_COUNTS = Object.fromEntries((Object.keys(SLOTS) as Area[]).map(a => [a, SLOTS[a].length])) as Record<Area, number>;
export type { Scene };
