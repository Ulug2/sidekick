// The low-poly aliens (Sidekick white, workers grey) for the 3D Powerhouse, and their poses. Built
// from spheres and capsules; joints are pivot groups so each exercise is a few rotations. The model
// stands on y = 0 and faces +z; about 12 units tall.
import * as THREE from "three";
import { BODY, PULL } from "./gpu-layout.js";

export const ARM_LEN = BODY.armLen;
export type AlienPose = "idle" | "point" | "push" | "pull" | "situp" | "sit" | "raise" | "slump" | "floor";
export interface Alien {
  root: THREE.Group; hips: THREE.Group; upper: THREE.Group; head: THREE.Group;
  armL: THREE.Group; armR: THREE.Group; legL: THREE.Group; legR: THREE.Group; kneeL: THREE.Group; kneeR: THREE.Group; eyes: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
}

const capsule = (r: number, len: number, mat: THREE.Material) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
  m.castShadow = true;
  return m;
};

export function makeAlien(color: number): Alien {
  const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, transparent: true });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0b, roughness: 0.12, metalness: 0.3, transparent: true });
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = BODY.hips; root.add(hips);
  const upper = new THREE.Group(); hips.add(upper);
  const torso = capsule(1.05, 2.6, skin); torso.position.y = 1.9; upper.add(torso);
  const head = new THREE.Group(); head.position.y = 5.6; upper.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(2, 20, 16), skin);
  skull.scale.set(1, 1.22, 0.95); skull.castShadow = true; head.add(skull);
  const eyes = new THREE.Group(); head.add(eyes);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 10), eyeMat);
    eye.scale.set(0.75, 1.25, 0.45);
    eye.position.set(side * 0.78, -0.15, 1.62);
    eye.rotation.z = side * -0.5;
    eyes.add(eye);
  }
  const limb = (x: number, y: number, len: number, parent: THREE.Group) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0); parent.add(pivot);
    const c = capsule(0.42, len, skin); c.position.y = -len / 2 - 0.2; pivot.add(c);
    return pivot;
  };
  const armL = limb(-1.45, BODY.shoulders, ARM_LEN, upper), armR = limb(1.45, BODY.shoulders, ARM_LEN, upper);
  // legs: thigh from the hip, shin from the knee (so it can sit, kneel and do sit-ups)
  const leg = (x: number) => {
    const hip = new THREE.Group(); hip.position.set(x, 0, 0); hips.add(hip);
    const thigh = capsule(0.45, 1.5, skin); thigh.position.y = -0.95; hip.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -2.1; hip.add(knee);
    const shin = capsule(0.42, 1.4, skin); shin.position.y = -0.95; knee.add(shin);
    return { hip, knee };
  };
  const l = leg(-0.62), r = leg(0.62);
  return { root, hips, upper, head, armL, armR, legL: l.hip, legR: r.hip, kneeL: l.knee, kneeR: r.knee, eyes, materials: [skin, eyeMat] };
}

const reset = (a: Alien) => {
  for (const g of [a.root, a.hips, a.upper, a.head, a.armL, a.armR, a.legL, a.legR, a.kneeL, a.kneeR]) g.rotation.set(0, 0, 0);
  a.root.position.set(0, 0, 0); a.hips.position.y = BODY.hips; a.hips.position.z = 0; a.eyes.scale.y = 1;
};

// t: seconds; moving: false shows a still frame (paused, reduced motion). point: direction to the
// worker Sidekick is shouting at, in the alien's own frame (radians around y).
export function pose(a: Alien, p: AlienPose, t: number, moving: boolean, point = 0): void {
  reset(a);
  const w = (period: number) => moving ? 0.5 - 0.5 * Math.cos((t * 2 * Math.PI) / period) : 0.5; // 0..1
  // blink every 6 s
  if (moving && (t % 6) > 5.85) a.eyes.scale.y = 0.15;
  switch (p) {
    case "idle": // standing ready, arms a little out (crossed arms under these eyes read as a skull and crossbones from afar)
      a.armL.rotation.set(0.1, 0, -0.35); a.armR.rotation.set(0.1, 0, 0.35);
      a.head.rotation.y = moving ? 0.25 * Math.sin(t * 0.5) : 0;
      break;
    case "point": // facing the worker, one arm pointing at it
      a.root.rotation.y = point;
      a.armR.rotation.set(-1.45, 0, 0.15); a.armL.rotation.set(-0.2, 0, -0.15);
      a.head.rotation.x = -0.12;
      break;
    case "push": { // plank on the floor, pivoting on the feet
      const tilt = 1.18 + 0.12 * w(1.2);
      a.root.rotation.x = tilt;
      a.armL.rotation.x = a.armR.rotation.x = -tilt + 0.05;
      a.root.position.y = 0.3;
      break;
    }
    case "pull": { // hanging from the pipe; as the body rises the arms spread so the hands stay on it
      const up = 3.2 * w(1.6);
      a.root.position.y = up;
      // hand height above the shoulder = reach · cos(forward) · cos(spread) = (reach - slack) · cos(forward) - up
      const c = ((BODY.reach - PULL.slack) * Math.cos(PULL.forward) - up) / (BODY.reach * Math.cos(PULL.forward));
      const spread = Math.acos(Math.max(-1, Math.min(1, c)));
      a.armL.rotation.set(-PULL.forward, 0, -(Math.PI - spread));
      a.armR.rotation.set(-PULL.forward, 0, Math.PI - spread);
      a.legL.rotation.x = -0.25; a.legR.rotation.x = -0.15; a.kneeL.rotation.x = 0.5; a.kneeR.rotation.x = 0.35;
      break;
    }
    case "situp": { // lying on the back, knees up, upper body swings up
      a.hips.position.y = 0.9;
      a.upper.rotation.x = -(Math.PI / 2) + 1.15 * w(1.5);
      a.legL.rotation.x = a.legR.rotation.x = -2.2; a.kneeL.rotation.x = a.kneeR.rotation.x = 1.9;
      a.armL.rotation.set(-0.4, 0, -0.5); a.armR.rotation.set(-0.4, 0, 0.5);
      break;
    }
    case "sit": // on an edge, thighs forward, shins hanging, hands on knees
      a.legL.rotation.x = a.legR.rotation.x = -Math.PI / 2;
      a.kneeL.rotation.x = a.kneeR.rotation.x = Math.PI / 2;
      a.hips.position.y = 0.45;
      a.armL.rotation.set(-0.7, 0, -0.1); a.armR.rotation.set(-0.7, 0, 0.1);
      break;
    case "raise": { // sitting, one hand up and waving
      a.legL.rotation.x = a.legR.rotation.x = -Math.PI / 2;
      a.kneeL.rotation.x = a.kneeR.rotation.x = Math.PI / 2;
      a.hips.position.y = 0.45;
      a.armL.rotation.set(-0.7, 0, -0.1);
      a.armR.rotation.set(0, 0, Math.PI - 0.35 + 0.25 * (moving ? Math.sin(t * 4.5) : 0));
      break;
    }
    case "slump": // on the floor, leaning back, head down
      a.hips.position.y = 0.6;
      a.legL.rotation.x = a.legR.rotation.x = -Math.PI / 2 + 0.1;
      a.upper.rotation.x = 0.45; a.head.rotation.x = 0.55;
      a.armL.rotation.set(0.2, 0, -0.25); a.armR.rotation.set(0.25, 0, 0.3);
      break;
    case "floor": // sitting on the die, arms round the knees
      a.hips.position.y = 0.6;
      a.legL.rotation.x = a.legR.rotation.x = -2.0; a.kneeL.rotation.x = a.kneeR.rotation.x = 2.2;
      a.upper.rotation.x = -0.15;
      a.armL.rotation.set(-1.0, 0, 0.15); a.armR.rotation.set(-1.0, 0, -0.15);
      break;
  }
}

export function setOpacity(a: Alien, o: number): void {
  for (const m of a.materials) { m.opacity = o; m.depthWrite = o > 0.98; }
  a.root.visible = o > 0.02;
}
