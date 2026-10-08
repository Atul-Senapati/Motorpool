import {
  Color, Float32BufferAttribute, Matrix4, Mesh, MeshStandardMaterial, Vector3,
  type Object3D, type SkinnedMesh, type Texture,
} from 'three';

/**
 * Beachwear for the animated crowd (`crowd.glb`): the same eighteen people,
 * changed out of their street clothes into swim trunks or a bikini.
 *
 * The crowd is one texture atlas and no clothes are separate meshes, so the
 * outfit is painted on in the shader. Each vertex gets its height above the
 * feet in the bind pose (`bodyH`) and how much of it the arm joints move
 * (`armW`); the fragment shader then keeps the atlas only for the head (face
 * and hair, above the neckline), paints arms and everything else bare skin,
 * and lays the swimwear on by height bands — trunks from the waist to mid-
 * thigh, a bikini as a band over the hips and one over the chest. Heights are
 * per fragment, so the edges are clean even on these ~570-triangle bodies.
 *
 * The skin is the figure's own — the atlas sampled under its hands, the far
 * ends of the arms — or a new tone (`skin`), in which case the face is
 * re-toned too: atlas texels that read as skin (warm, near the sampled tone)
 * are scaled from the old tone to the new, so the face keeps its shading and
 * features and the hair stays as it was.
 *
 * There is no head or hand joint in this rig — the head rides `Neck` and the
 * hands ride the forearms — which is why the head is found by height and the
 * hands by reach.
 */

export type BeachOutfit = {
  kind: 'trunks' | 'bikini';
  colour: string;
  trim?: string;
  /** A new skin tone, face included; the figure's own when left out. */
  skin?: string;
};

/**
 * A fixed sample of five for the lab (`/people?set=crowd&beach=set`): the
 * look the beach crowd is drawn from. `figure` is the crowd index
 * (`crowd0`…`crowd17`): 0, 2 and 13 are men, 8 and 12 women.
 */
export const BEACH_PEOPLE: ReadonlyArray<{ figure: number } & BeachOutfit> = [
  { figure: 0, kind: 'trunks', colour: '#2f6fd0', trim: '#f4f1ea', skin: '#d39c74' },
  { figure: 12, kind: 'bikini', colour: '#e8455a', trim: '#f4f1ea', skin: '#dba882' },
  { figure: 2, kind: 'trunks', colour: '#f2a531', trim: '#1d3b6e', skin: '#bd8159' },
  { figure: 8, kind: 'bikini', colour: '#1fa3a0', trim: '#f4f1ea', skin: '#c98f68' },
  { figure: 13, kind: 'trunks', colour: '#2a2f3a', trim: '#e8455a', skin: '#8e5b3e' },
];

/** Heights above the feet, metres, for a ~1.8 m figure; scaled to each figure's height. */
const BANDS = {
  neckline: 1.56,
  trunks: [0.72, 1.06],
  bottom: [0.9, 1.02],
  top: [1.27, 1.4],
} as const;
const REFERENCE_HEIGHT = 1.8;

const ARM_JOINTS = /Shoulder|Arm/;

/** Read a texture's image into pixels once, for sampling skin. */
const pixelCache = new WeakMap<object, { data: Uint8ClampedArray; width: number; height: number }>();
function pixels(map: Texture) {
  const image = map.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image) return null;
  const cached = pixelCache.get(image);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const out = { data: ctx.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
  pixelCache.set(image, out);
  return out;
}

const _p = new Vector3();
const _m = new Matrix4();

/** What a body's beachwear needs from its mesh: measured once per geometry. */
interface BodyFit { scale: number; ownSkin: Color }
const fits = new WeakMap<object, BodyFit>();

/**
 * Measure a crowd mesh for beachwear, once per geometry (clones share it):
 * writes `bodyH` and `armW` onto the geometry and samples the figure's own
 * skin. `figure` must still be in its rest pose and unmoved.
 */
function fitBody(figure: Object3D, mesh: SkinnedMesh): BodyFit | null {
  const g = mesh.geometry;
  const known = fits.get(g);
  if (known) return known;
  const pos = g.getAttribute('position');
  const skinIndex = g.getAttribute('skinIndex');
  const skinWeight = g.getAttribute('skinWeight');
  const uv = g.getAttribute('uv');
  if (!pos || !skinIndex || !skinWeight) return null;
  const bones = mesh.skeleton?.bones ?? [];
  const isArm = bones.map((b) => ARM_JOINTS.test(b.name.replace(/_\d+$/, '')));

  // Rest-pose positions in the figure's frame, feet at y = 0. Skinned:
  // these meshes' vertices only land in the figure once the bones apply.
  figure.updateMatrixWorld(true);
  _m.copy(figure.matrixWorld).invert().multiply(mesh.matrixWorld);
  const skinned = typeof mesh.applyBoneTransform === 'function';
  const height = new Float32Array(pos.count);
  const arm = new Float32Array(pos.count);
  const xs = new Float32Array(pos.count);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    if (skinned) mesh.applyBoneTransform(i, _p);
    _p.applyMatrix4(_m);
    height[i] = _p.y;
    xs[i] = _p.x;
    minY = Math.min(minY, _p.y);
    maxY = Math.max(maxY, _p.y);
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (isArm[skinIndex.getComponent(i, k)]) w += skinWeight.getComponent(i, k);
    }
    arm[i] = w;
  }
  for (let i = 0; i < pos.count; i++) height[i] -= minY;
  g.setAttribute('bodyH', new Float32BufferAttribute(height, 1));
  g.setAttribute('armW', new Float32BufferAttribute(arm, 1));

  // Skin: the atlas under the hands — arm vertices furthest out.
  const source = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
  const ownSkin = new Color('#c8946c');
  const px = source.map ? pixels(source.map) : null;
  if (px && uv) {
    let reach = 0;
    for (let i = 0; i < pos.count; i++) if (arm[i] > 0.5) reach = Math.max(reach, Math.abs(xs[i]));
    let r = 0; let gr = 0; let b = 0; let n = 0;
    for (let i = 0; i < pos.count; i++) {
      if (arm[i] < 0.5 || Math.abs(xs[i]) < reach * 0.93) continue;
      const u = Math.min(px.width - 1, Math.max(0, Math.floor(uv.getX(i) * px.width)));
      const v = Math.min(px.height - 1, Math.max(0, Math.floor(uv.getY(i) * px.height)));
      const at = (v * px.width + u) * 4;
      const [pr, pg, pb] = [px.data[at], px.data[at + 1], px.data[at + 2]];
      // Skin, not a cuff or a glove: warm (red over blue) and not grey.
      if (pr < pg || pr - pb < 14) continue;
      r += pr; gr += pg; b += pb; n++;
    }
    if (n > 0) ownSkin.setRGB(r / n / 255, gr / n / 255, b / n / 255, 'srgb');
  }
  const fit = { scale: (maxY - minY) / REFERENCE_HEIGHT, ownSkin };
  fits.set(g, fit);
  return fit;
}

/** A beachwear version of `base` for a body measured by `fitBody`. */
function beachMaterial(base: MeshStandardMaterial, outfit: BeachOutfit, fit: BodyFit) {
  const material = base.clone();
  const skin = outfit.skin ? new Color(outfit.skin) : fit.ownSkin;
  const wear = new Color(outfit.colour);
  const trim = new Color(outfit.trim ?? outfit.colour);
  const bikini = outfit.kind === 'bikini' ? 1 : 0;
  const { scale } = fit;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkin = { value: skin };
    shader.uniforms.uOwnSkin = { value: fit.ownSkin };
    shader.uniforms.uWear = { value: wear };
    shader.uniforms.uTrim = { value: trim };
    shader.uniforms.uBikini = { value: bikini };
    shader.uniforms.uNeck = { value: BANDS.neckline * scale };
    shader.uniforms.uTrunks = { value: [BANDS.trunks[0] * scale, BANDS.trunks[1] * scale] };
    shader.uniforms.uBottom = { value: [BANDS.bottom[0] * scale, BANDS.bottom[1] * scale] };
    shader.uniforms.uTop = { value: [BANDS.top[0] * scale, BANDS.top[1] * scale] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float bodyH;\nattribute float armW;\nvarying float vBodyH;\nvarying float vArmW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodyH = bodyH;\nvArmW = armW;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uSkin; uniform vec3 uOwnSkin; uniform vec3 uWear; uniform vec3 uTrim; uniform float uBikini;
uniform float uNeck; uniform vec2 uTrunks; uniform vec2 uBottom; uniform vec2 uTop;
varying float vBodyH; varying float vArmW;
float inBand(float h, vec2 b) { return step(b.x, h) * step(h, b.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  // Keep the atlas for the head only; the rest is skin, then swimwear on top.
  float beachKeep = step(uNeck, vBodyH) * (1.0 - step(0.5, vArmW));
  vec3 beachCol = uSkin;
  if (vArmW < 0.5) {
    if (uBikini < 0.5) {
      float t = inBand(vBodyH, uTrunks);
      // A trim band at the waist.
      float w = inBand(vBodyH, vec2(uTrunks.y - 0.045, uTrunks.y));
      beachCol = mix(beachCol, mix(uWear, uTrim, w), t);
    } else {
      beachCol = mix(beachCol, uWear, inBand(vBodyH, uBottom));
      beachCol = mix(beachCol, uWear, inBand(vBodyH, uTop));
      beachCol = mix(beachCol, uTrim, inBand(vBodyH, vec2(uTop.y - 0.02, uTop.y)));
    }
  }
  // The head: re-tone its skin texels from the figure's own tone to the new one.
  vec3 tex = diffuseColor.rgb;
  float warm = step(tex.b, tex.r) * step(tex.g, tex.r * 1.08);
  float near = 1.0 - smoothstep(0.7, 1.4, length(log(max(tex, vec3(1e-3)) / max(uOwnSkin, vec3(1e-3)))));
  vec3 retoned = uSkin * clamp(dot(tex, vec3(0.333)) / max(dot(uOwnSkin, vec3(0.333)), 1e-3), 0.3, 2.2);
  vec3 head = mix(tex, retoned, warm * near);
  diffuseColor.rgb = mix(beachCol, head, beachKeep);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // The daylight lift glows the atlas; off the head, a gentler glow of the new
  // colours, so tanned skin is not washed out to white in the sun.
  totalEmissiveRadiance = mix(emissive * diffuseColor.rgb * 0.4, totalEmissiveRadiance, beachKeep);`);
  };
  // One program for every beachwear material: only the uniforms differ.
  material.customProgramCacheKey = () => 'crowd-beachwear';
  return material;
}

/**
 * Beachwear materials for a freshly cloned crowd figure (rest pose, unmoved):
 * for each mesh, a swimwear version of `base(itsMaterial)`. Not applied —
 * the caller swaps them in and out (`KestrelPeople` does, as a pooled person
 * moves between the pavements and the beach).
 */
export function beachMaterials(
  figure: Object3D,
  outfit: BeachOutfit,
  base: (m: MeshStandardMaterial) => MeshStandardMaterial,
): Map<Mesh, MeshStandardMaterial> {
  const out = new Map<Mesh, MeshStandardMaterial>();
  figure.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!(mesh as unknown as Mesh).isMesh || !mesh.geometry) return;
    const fit = fitBody(figure, mesh);
    if (!fit) return;
    const source = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
    out.set(mesh as unknown as Mesh, beachMaterial(base(source), outfit, fit));
  });
  return out;
}

/** Dress a freshly cloned crowd figure in `outfit`, for good. */
export function dressForBeach(
  figure: Object3D,
  outfit: BeachOutfit,
  base: (m: MeshStandardMaterial) => MeshStandardMaterial,
) {
  for (const [mesh, material] of beachMaterials(figure, outfit, base)) mesh.material = material;
}

/* ------------------------------------------------------- the beach crowd */

/** Crowd figures who are women; and those in skirts, who stay off the beach (a skirt's flare turns a bikini bottom into a skirt). */
const WOMEN = new Set([3, 4, 5, 6, 7, 8, 9, 10, 12, 15]);
export const SKIRTED = new Set([3, 4, 5]);
/**
 * British holidaymakers a week into the sun: light tans to deep ones, some
 * darker. Nothing paler — the town's daylight lift brightens skin, and a fair
 * tone came out white on the sand.
 */
const SKINS = ['#dba882', '#d39c74', '#c98f68', '#bd8159', '#b0744e', '#9c6444', '#86543a'];
const SKIN_WEIGHTS = [3, 3, 3, 2, 2, 1, 1];
const WEAR = ['#e8455a', '#2f6fd0', '#f2a531', '#1fa3a0', '#7a3fb8', '#f07aa8', '#2a2f3a', '#e0452f', '#3bb36b'];
const TRIM = ['#f4f1ea', '#f4f1ea', '#1d3b6e', '#e8455a', '#f2c64a'];

/** A random beach outfit for crowd figure `figure`: trunks or a bikini, a colour, a skin tone. */
export function beachOutfitFor(figure: number, rnd: () => number = Math.random): BeachOutfit {
  const total = SKIN_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = rnd() * total;
  let skin = SKINS[0];
  for (let i = 0; i < SKINS.length; i++) {
    roll -= SKIN_WEIGHTS[i];
    if (roll <= 0) { skin = SKINS[i]; break; }
  }
  return {
    kind: WOMEN.has(figure) ? 'bikini' : 'trunks',
    colour: WEAR[Math.floor(rnd() * WEAR.length)],
    trim: TRIM[Math.floor(rnd() * TRIM.length)],
    skin,
  };
}

/** In the lab, everyone gets an outfit: the set's, or a seeded random one. */
export const BEACH_OUTFITS: readonly BeachOutfit[] = Array.from({ length: 18 }, (_, i) => {
  const set = BEACH_PEOPLE.find((p) => p.figure === i);
  if (set) return set;
  let seed = 0xbea + i * 7919;
  return beachOutfitFor(i, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; });
});
