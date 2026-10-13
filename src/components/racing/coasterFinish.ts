import { Color, Mesh, MeshStandardMaterial, type Material, type Object3D } from 'three';

/**
 * The roller coaster's steel, made to look like freshly painted steel.
 *
 * The track, spine and ties arrive as flat colours with NO UVs — 110,000
 * vertices of plastic — so there is nothing to hang a texture on. The finish
 * is worked out in the shader from the WORLD position instead: 3D value noise
 * in metres, so it never stretches or seams, and it costs no texture memory.
 *
 *  - PAINT: the colour breathes a few percent over metre-scale patches, the
 *    way a repainted structure never quite matches itself.
 *  - SHEEN: roughness broken up at a finer scale, so the sky's reflection
 *    runs along a rail in pieces rather than as one plastic highlight.
 *  - GRIME: road dust low down, and dirt on every downward face.
 *  - STREAKS: on the supports only — long vertical runs of rust-brown, the
 *    stain rain leaves under every bolt on a steel column.
 */

interface Finish {
  colour?: string;
  /** Drop the material's own texture: the colour is the whole paint. */
  noMap?: boolean;
  metalness: number;
  roughness: number;
  /** Fraction the paint colour wanders, ±. */
  paint: number;
  /** How far the roughness wanders, ±. */
  sheen: number;
  /** Strength of the low-down and underside dirt. */
  grime: number;
  /** Strength of the vertical rust runs. */
  streaks: number;
}

/**
 * By the material names `prepare-park.mjs` leaves on the coaster.
 *
 * THE KINGFISHER. Halcyon is the kingfisher's old name, so the park's big
 * ride wears the bird: a brilliant blue back (the spine), the orange breast
 * (the running rails, the line your eye follows round the layout) and the
 * dark river it dives into (the supports, which should recede rather than
 * compete — white washed out against the sky, and grey read as rust).
 */
const FINISHES: Record<string, Finish> = {
  // The running rails: the kingfisher's orange breast.
  Yellow: { colour: '#f47a20', metalness: 0.25, roughness: 0.26, paint: 0.04, sheen: 0.08, grime: 0, streaks: 0 },
  // The spine tube, most of the track you see: kingfisher blue.
  LightBlue: { colour: '#0b74c4', metalness: 0.3, roughness: 0.26, paint: 0.04, sheen: 0.08, grime: 0.04, streaks: 0 },
  // The ties and brackets between rail and spine: the deeper cobalt of the wings.
  DarkGrey: { colour: '#084f8c', metalness: 0.3, roughness: 0.3, paint: 0.04, sheen: 0.08, grime: 0.04, streaks: 0 },
  // Supports, station and stairs: dark river teal; the old gunmetal texture dropped.
  Platform: { colour: '#12424a', noMap: true, metalness: 0.3, roughness: 0.38, paint: 0.04, sheen: 0.1, grime: 0.1, streaks: 0 },
  // The station's hand railings, orange like the rails.
  Railings__0: { colour: '#f47a20', metalness: 0.2, roughness: 0.35, paint: 0.03, sheen: 0.08, grime: 0, streaks: 0 },
};

const NOISE = /* glsl */ `
varying vec3 vFinishPos;
varying vec3 vFinishNormal;
float fHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float fNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fHash(i + vec3(0, 0, 0)), fHash(i + vec3(1, 0, 0)), f.x),
                 mix(fHash(i + vec3(0, 1, 0)), fHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(fHash(i + vec3(0, 0, 1)), fHash(i + vec3(1, 0, 1)), f.x),
                 mix(fHash(i + vec3(0, 1, 1)), fHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fFbm(vec3 p) {
  return 0.55 * fNoise(p) + 0.3 * fNoise(p * 2.13) + 0.15 * fNoise(p * 4.37);
}
`;

const cache = new Map<string, Material>();

function finished(source: Material, f: Finish, key: string): Material {
  const hit = cache.get(key);
  if (hit) return hit;
  const base = source instanceof MeshStandardMaterial ? source : null;
  const m = base ? base.clone() : new MeshStandardMaterial();
  if (f.colour) m.color = new Color(f.colour);
  if (f.noMap) m.map = null;
  m.metalness = f.metalness;
  m.roughness = f.roughness;
  m.envMapIntensity = 1.15;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFinish = { value: [f.paint, f.sheen, f.grime, f.streaks] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFinishPos;\nvarying vec3 vFinishNormal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFinishPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFinishNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uFinish[4];\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float fPaint = fFbm(vFinishPos * 0.35);
float fFine = fFbm(vFinishPos * 3.1);
float fLow = 1.0 - smoothstep(0.0, 4.0, vFinishPos.y);
float fUnder = clamp(-vFinishNormal.y, 0.0, 1.0);
float fRun = smoothstep(0.62, 0.95, fNoise(vec3(vFinishPos.x * 2.6, vFinishPos.y * 0.12, vFinishPos.z * 2.6)));
float fGrime = clamp(uFinish[2] * (0.55 * fLow + 0.35 * fUnder) * (0.6 + 0.8 * fFine), 0.0, 0.85);
diffuseColor.rgb *= 1.0 + (fPaint - 0.5) * 2.0 * uFinish[0];
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.48, 0.4), fGrime);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.23, 0.12, 0.06), fRun * uFinish[3] * 0.55);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (fFine - 0.5) * 2.0 * uFinish[1] + fGrime * 0.35 + fRun * uFinish[3] * 0.3, 0.05, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor *= 1.0 - 0.6 * max(fGrime, fRun * uFinish[3]);`);
  };
  m.customProgramCacheKey = () => key;
  cache.set(key, m);
  return m;
}

/** Re-material every mesh under the coaster. Unknown materials are left alone. */
export function finishCoaster(root: Object3D) {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const swap = (mat: Material) => {
      const f = FINISHES[mat.name];
      return f ? finished(mat, f, `coasterFinish-${mat.name}`) : mat;
    };
    child.material = Array.isArray(child.material) ? child.material.map(swap) : swap(child.material);
  });
}

/**
 * The trains' liveries: body, seats, and trim.
 *
 * Each car is four parts on one texture — body, seats and two lap bars — and
 * the texture is a flat body colour, a grey block the seats are mapped to, a
 * green block the lap bars are mapped to, and a lightning-bolt decal on the
 * sides. So each PART gets its own material, chosen by where its UVs sit:
 * the seats matte upholstery, the lap bars polished trim, and the body gloss
 * paint with the bolts picked out in the trim colour (their black outline
 * stays black).
 */
const LIVERIES = [
  // The breast: orange, cobalt seats, cream trim.
  { body: '#f26b1d', seat: '#0b4f9c', trim: '#fff3d6' },
  // The back: kingfisher blue, orange seats, cream trim.
  { body: '#0b74c4', seat: '#f47a20', trim: '#fff3d6' },
  // The flash of turquoise on the crown: turquoise, orange seats, cobalt trim.
  { body: '#19a7b5', seat: '#f47a20', trim: '#084f8c' },
] as const;

type CarPart = 'body' | 'seat' | 'trim';
const trainCache = new Map<string, Material>();

/** Which atlas block a part is mapped into, read off its first UV. */
function partOf(mesh: Mesh): CarPart {
  const uv = mesh.geometry.getAttribute('uv');
  if (!uv) return 'body';
  const u = uv.getX(0);
  const v = uv.getY(0);
  if (u < 0.22 && v < 0.22) return 'seat';
  if (u < 0.26 && v > 0.38 && v < 0.51) return 'trim';
  return 'body';
}

function livery(source: Material, index: number, part: CarPart): Material {
  const key = `${index}-${part}`;
  const hit = trainCache.get(key);
  if (hit) return hit;
  const l = LIVERIES[index % LIVERIES.length];
  let m: MeshStandardMaterial;
  if (part === 'seat') {
    m = new MeshStandardMaterial({ color: l.seat, roughness: 0.8, metalness: 0 });
  } else if (part === 'trim') {
    m = new MeshStandardMaterial({ color: l.trim, roughness: 0.25, metalness: 0.6 });
  } else {
    m = source instanceof MeshStandardMaterial ? source.clone() : new MeshStandardMaterial();
    m.color = new Color('#ffffff');
    m.metalness = 0.35;
    m.roughness = 0.2;
    const body = new Color(l.body);
    const trim = new Color(l.trim);
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBody = { value: body };
      shader.uniforms.uTrim = { value: trim };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uBody;\nuniform vec3 uTrim;')
        .replace('#include <map_fragment>', `#ifdef USE_MAP
vec3 lTex = texture2D(map, vMapUv).rgb;
vec3 lRef = texture2D(map, vec2(0.8, 0.8)).rgb;
float lDecal = step(0.12, distance(lTex, lRef));
float lDark = 1.0 - step(0.06, max(lTex.r, max(lTex.g, lTex.b)));
diffuseColor.rgb *= mix(mix(uBody, uTrim, lDecal), vec3(0.02), lDark);
#endif`);
    };
    m.customProgramCacheKey = () => `coasterLivery-${index}`;
  }
  m.envMapIntensity = 1.2;
  trainCache.set(key, m);
  return m;
}

/** Repaint one train's car, by which of the three trains it is (0, 1, 2). */
export function paintTrain(root: Object3D, index: number) {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const part = partOf(child);
    const swap = (mat: Material) => (mat.name === 'cart' ? livery(mat, index, part) : mat);
    child.material = Array.isArray(child.material) ? child.material.map(swap) : swap(child.material);
  });
}
