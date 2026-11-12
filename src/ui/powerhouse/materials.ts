// Shared materials and code-drawn textures for the Silicon City (docs/powerhouse-redesign/02-world.md).
// std() = a standard (PBR) material, glow() = an unlit colour that feeds the bloom when k > 1,
// windowMat() = lit windows drawn from world position (no texture stretching on instanced
// buildings of any size). The window registry lets setMood() dim every lit window at once.
import * as THREE from "three";

export const std = (color: number, o: { r?: number; m?: number; extra?: THREE.MeshStandardMaterialParameters } = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.6, metalness: o.m ?? 0.2, ...o.extra });
export const glow = (hex: number, k = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) });

// mulberry32: the city is the same on every load.
export function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, anisotropy = 8): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = anisotropy;
  return t;
}
export const SORA = "Sora, Inter, sans-serif";
export const MONO = '"JetBrains Mono", ui-monospace, monospace';
export function signTex(text: string, color: string, w = 512, h = 96, font = `600 54px ${SORA}`): THREE.CanvasTexture {
  return canvasTex(w, h, (g, W, H) => {
    g.font = font; g.textAlign = "center"; g.textBaseline = "middle";
    g.shadowColor = color; g.shadowBlur = 14; g.fillStyle = color; g.fillText(text, W / 2, H / 2 + 2);
  });
}
// Canvas text needs the bundled fonts loaded first (vendor/fonts, @font-face in powerhouse.css).
export async function fontsReady(): Promise<void> {
  try { await Promise.all([`600 54px Sora`, `700 118px Sora`, `500 16px "JetBrains Mono"`, `600 26px "JetBrains Mono"`].map(f => document.fonts.load(f))); } catch { /* fall back to the next font in the stack */ }
}

export interface WindowOpts { color?: number; density?: number; wx?: number; wy?: number; boost?: number; warm?: number; cool?: number }
type WindowUniforms = { uLit: { value: number }; uWarm: { value: THREE.Color }; uCool: { value: THREE.Color }; uDensity: { value: number }; uSize: { value: THREE.Vector2 }; uBoost: { value: number } };
export class Materials {
  readonly windows: WindowUniforms[] = [];
  // Lit windows (02 › Lit-window shader): windows only on vertical faces, a grid from world
  // position, a cell on or off by hash, warm or cool, brightness 0.55–1.25, none on the ground floor.
  windowMat({ color = 0x18212b, density = 0.45, wx = 1.1, wy = 1.3, boost = 1, warm = 0xffc979, cool = 0x86d8ff }: WindowOpts = {}): THREE.MeshStandardMaterial {
    const m = std(color, { r: 0.55, m: 0.25 });
    const u: WindowUniforms = { uLit: { value: 1 }, uWarm: { value: new THREE.Color(warm) }, uCool: { value: new THREE.Color(cool) }, uDensity: { value: density }, uSize: { value: new THREE.Vector2(wx, wy) }, uBoost: { value: boost } };
    m.onBeforeCompile = s => {
      Object.assign(s.uniforms, u);
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWP; varying vec3 vWN;")
        .replace("#include <project_vertex>", `#include <project_vertex>
          { mat4 mm = modelMatrix;
            #ifdef USE_INSTANCING
              mm = modelMatrix * instanceMatrix;
            #endif
            vWP = (mm * vec4(transformed, 1.0)).xyz;
            vWN = normalize(mat3(mm) * objectNormal); }`);
      s.fragmentShader = s.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vWP; varying vec3 vWN;
          uniform float uLit; uniform vec3 uWarm; uniform vec3 uCool; uniform float uDensity; uniform vec2 uSize; uniform float uBoost;
          float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          { float side = 1.0 - step(0.6, abs(vWN.y));
            float a = abs(vWN.x) > 0.5 ? vWP.z : vWP.x;
            vec2 g = vec2(a / uSize.x, (vWP.y - 2.0) / uSize.y);
            vec2 c = floor(g); vec2 f = fract(g);
            float w = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.72);
            vec2 k = c + vec2(sign(vWN.x) * 17.0, sign(vWN.z) * 31.0);
            float on = step(1.0 - uDensity, hsh(k));
            float ground = step(1.4, vWP.y - 2.0);
            vec3 col = mix(uCool, uWarm, step(0.42, hsh(k * 1.7 + 3.1)));
            totalEmissiveRadiance += side * w * on * ground * col * uLit * uBoost * (0.55 + 0.7 * hsh(k + 9.0)); }`);
    };
    m.customProgramCacheKey = () => "sk-window";
    this.windows.push(u);
    return m;
  }
  // Mood dimmer for every lit window: 1.0 live, 0.8 paused, 0.5 idle.
  setLit(v: number): void { for (const u of this.windows) u.uLit.value = v; }
}
