/**
 * One-time preprocessor for the concert stage on Kestrel's north shore.
 *
 * The source is 346,534 triangles, 18.5 MB, and — unusually for a Sketchfab
 * export — already **in metres and already upright**: 30.00 m across, 9.92 m
 * tall, 40.79 m deep, floor at y = 0. A 30 m proscenium is a real festival
 * stage, so there is no ruler to apply here and no rotation to bake. That makes
 * this the simplest of the prepare scripts: measure, decimate, compact,
 * transcode the textures, normalise onto the origin, Draco.
 *
 * What it does have is depth. The bulk sits between z = −3.1 and z = +37.7,
 * which is far more than a stage deck — it is the deck plus its roof trusses,
 * wings and back-of-house. Which end faces the crowd is therefore a real
 * question and not one a bounding box answers, so it is **measured**: the front
 * of a stage is the open side, and the open side is the one with less material
 * in front of the deck. See `FRONT`.
 *
 * Run with: npm run prepare:stage
 *
 * Writes:
 *   public/models/stage.glb       Draco-compressed, normalised, decimated.
 *   src/config/stageData.json     Measured size, and which way it faces.
 *
 * Source `stage_porsimaptar.glb` (18.5 MB, `source-models/`, untracked).
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const SRC = source('stage_porsimaptar.glb');
const DST = 'public/models/stage.glb';
const DATA = 'src/config/stageData.json';

/**
 * Triangle budget.
 *
 * One instance, standing still, seen from the field in front of it and from a
 * train half a kilometre away — so this is nothing like the coach's budget,
 * which is paid six times over. 50 k against a source of 347 k keeps the roof
 * trusses reading as trusses, which is the whole silhouette of a stage, and
 * costs a fifth of what one of the freight locomotives does.
 */
const TRIANGLE_BUDGET = 90000;

/**
 * Primitives smaller than this are left exactly as they are.
 *
 * Thirty-seven of the eighty-one parts are under 500 triangles and come to
 * 3,070 between them — bolts, clamps, cable ends. There is nothing to win
 * there and a great deal to lose: a decimator given a fifty-triangle bracket
 * and told to return seven returns a triangle soup, and it is the small parts
 * you are closest to when you stand in front of the stage.
 */
const KEEP_WHOLE = 1000;

/** Textures over this go down to it. The same size the other props use. */
const TEXTURE_SIZE = 1024;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const step = (msg) => console.log(`  ${msg}`);

const srcSize = readFileSync(SRC).byteLength;
step(`reading ${SRC} (${mb(srcSize)})`);

const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

/* ------------------------------------------------- 1. measure in world space */

const mul = (A, B) => {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += A[k * 4 + r] * B[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
};
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const parts = [];
const walk = (node, parent) => {
  const world = mul(parent, node.getMatrix());
  const mesh = node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      if (!position) continue;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      const count = position.getCount();
      for (let i = 0; i < count; i++) {
        const p = apply(world, position.getElement(i, []));
        for (let k = 0; k < 3; k++) {
          if (p[k] < lo[k]) lo[k] = p[k];
          if (p[k] > hi[k]) hi[k] = p[k];
        }
      }
      const index = prim.getIndices();
      parts.push({
        prim,
        matrix: world,
        lo,
        hi,
        triangles: (index ? index.getCount() : count) / 3,
      });
    }
  }
  for (const child of node.listChildren()) walk(child, world);
};
for (const child of scene.listChildren()) walk(child, IDENTITY);

const worldLo = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.lo[k])));
const worldHi = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.hi[k])));
const size = [0, 1, 2].map((k) => worldHi[k] - worldLo[k]);
const totalBefore = parts.reduce((n, p) => n + p.triangles, 0);
step(`${parts.length} primitives, ${totalBefore.toLocaleString()} triangles`);
step(`${size[2].toFixed(2)} m deep x ${size[0].toFixed(2)} m wide x ${size[1].toFixed(2)} m tall`);

/* ------------------------------------------------------ 2. which way it faces
 *
 * The open side. A stage is a box with one wall missing, so the half with less
 * material in it is the half the audience is on — and "material" here is
 * triangles weighted by nothing at all, just counted in each half, because a
 * truss tower behind the deck is thousands of triangles and the air in front of
 * it is none.
 *
 * Measured rather than assumed, because the only alternative is to look at it
 * in the game and turn it round, and a script that can tell you is better than
 * a constant that remembers what somebody saw once.
 */
const midZ = (worldLo[2] + worldHi[2]) / 2;
let ahead = 0;
let behind = 0;
for (const part of parts) {
  const centre = (part.lo[2] + part.hi[2]) / 2;
  if (centre < midZ) ahead += part.triangles;
  else behind += part.triangles;
}
/** True when the open side is −Z, which is the direction everything here calls forward. */
const FACES_MINUS_Z = ahead < behind;
step(`triangles ${Math.round(ahead).toLocaleString()} at −Z against `
  + `${Math.round(behind).toLocaleString()} at +Z => open side is `
  + `${FACES_MINUS_Z ? '−Z (already forward)' : '+Z (a half turn is baked in)'}`);

/* --------------------------------------------------- 3. decimate and compact */

/*
 * Decimation, and this model needed a second method.
 *
 * `simplify` is the edge-collapse simplifier every other prepare script here
 * uses, and it preserves topology: it will not merge two solids that do not
 * share an edge. That is exactly right for a locomotive body and exactly wrong
 * for this, because the stage is **not one surface**. It is ten near-identical
 * 14,144-triangle parts — truss towers and their rigging — each made of
 * hundreds of separate closed tubes, and every tube is already about as few
 * triangles as a tube can be. Asked for 14 % it returned 100 %: 346,534
 * triangles came back as 346,534. Dropping `LockBorder` moved it to 339,076.
 * Welding by position first (which IS worth doing — the export splits vertices
 * three ways at attribute seams) moved it no further. The obstacle was never
 * the border, the tolerance or the seams; it is that there is no edge to
 * collapse between two tubes.
 *
 * `simplifySloppy` ignores topology altogether and hits whatever target it is
 * given — 44,348 at the same 14 %. What it costs is exactness: it will weld
 * across gaps and round off a corner. So it is a *fallback*, not the default:
 * each primitive is offered to `simplify` first, and only the ones that come
 * back barely changed are handed to the sloppy one. On this model that is the
 * ten big lattices and nothing else, which is precisely the geometry that can
 * afford it — a truss read at thirty metres is a silhouette.
 *
 * The budget is 90 k rather than the 50 k a background prop would get, because
 * the sloppy pass is doing the work and every triangle taken off it is taken
 * off detail that cannot be reasoned about. 90 k is a third of the Class 37.
 */
const ratio = Math.min(1, TRIANGLE_BUDGET / totalBefore);
let sloppyParts = 0;
if (ratio < 1) {
  await MeshoptSimplifier.ready;
  for (const part of parts) {
    const prim = part.prim;
    const indexAccessor = prim.getIndices();
    const position = prim.getAttribute('POSITION');
    if (!indexAccessor || !position) continue;
    if (part.triangles < KEEP_WHOLE) continue;
    const indices = new Uint32Array(indexAccessor.getCount());
    for (let i = 0; i < indices.length; i++) indices[i] = indexAccessor.getScalar(i);
    const positions = new Float32Array(position.getCount() * 3);
    for (let i = 0; i < position.getCount(); i++) {
      const p = position.getElement(i, []);
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
    }
    const target = Math.max(3, Math.floor((indices.length / 3) * ratio) * 3);

    // Welded by position before the first attempt. The export splits its
    // vertices at every attribute seam — a hard normal or a UV break makes two
    // vertices at one point — and an edge whose endpoints the simplifier
    // believes are different vertices cannot collapse. It is not enough on its
    // own here, but it is free and it is right.
    const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
    const welded = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) welded[i] = remap[indices[i]];

    let [simplified] = MeshoptSimplifier.simplify(welded, positions, 3, target, 0.1);
    // Barely moved: topology is in the way, so fall back. Two thirds and not
    // some tighter test, because a part that gives back even half of what was
    // asked has been genuinely simplified and should keep its topology.
    if (simplified.length > target * 2) {
      const [sloppy] = MeshoptSimplifier.simplifySloppy(
        indices, positions, 3, null, target, 0.6,
      );
      if (sloppy.length && sloppy.length < simplified.length) {
        simplified = sloppy;
        sloppyParts++;
      }
    }
    if (simplified.length && simplified.length < indices.length) {
      indexAccessor.setArray(
        indices.length > 65535 ? new Uint32Array(simplified) : new Uint16Array(simplified),
      );
    }
  }
}

// Simplifying only rewrites indices, so without this Draco faithfully
// compresses vertices nothing references any more. Same reasoning as
// `prepare-train.mjs`, which says it at length.
let removedVertices = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const indexAccessor = prim.getIndices();
    if (!indexAccessor) continue;
    const used = new Set();
    for (let i = 0; i < indexAccessor.getCount(); i++) used.add(indexAccessor.getScalar(i));
    const order = [...used].sort((a, b) => a - b);
    const remap = new Map(order.map((old, next) => [old, next]));
    const before = prim.getAttribute('POSITION')?.getCount() ?? 0;
    if (order.length === before) continue;
    removedVertices += before - order.length;
    for (const semantic of prim.listSemantics()) {
      const attribute = prim.getAttribute(semantic);
      const elements = attribute.getElementSize();
      const src = attribute.getArray();
      const dst = new src.constructor(order.length * elements);
      order.forEach((old, next) => {
        for (let c = 0; c < elements; c++) dst[next * elements + c] = src[old * elements + c];
      });
      attribute.setArray(dst);
    }
    const remapped = new Uint32Array(indexAccessor.getCount());
    for (let i = 0; i < remapped.length; i++) {
      remapped[i] = remap.get(indexAccessor.getScalar(i));
    }
    indexAccessor.setArray(
      order.length > 65535 ? remapped : new Uint16Array(remapped),
    );
  }
}

const totalAfter = root.listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices() ? p.getIndices().getCount() / 3 : 0), 0);
step(`decimated ${totalBefore.toLocaleString()} -> ${totalAfter.toLocaleString()} triangles `
  + `(asked for ${TRIANGLE_BUDGET.toLocaleString()}; ${sloppyParts} parts needed the sloppy pass), `
  + `dropped ${removedVertices.toLocaleString()} orphaned vertices`);

/* ------------------------------------------------------- 4. textures to WebP */

let imageBefore = 0;
let imageAfter = 0;
for (const texture of root.listTextures()) {
  const image = texture.getImage();
  if (!image) continue;
  imageBefore += image.byteLength;
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer();
  texture.setImage(webp).setMimeType('image/webp');
  imageAfter += webp.byteLength;
}
if (imageBefore) {
  step(`${root.listTextures().length} textures to WebP, ${mb(imageBefore)} -> ${mb(imageAfter)}`);
}

/* ------------------------------------------------ 5. normalise onto the origin
 *
 * Centred on X and Z and stood on y = 0, so the runtime places it by its own
 * middle and its feet land on the ground. The half turn, when it is needed, is
 * baked on the same wrapper node — and a glTF node applies T then R then S, so
 * the translation has to be in the ROTATED frame: a half turn about Y flips the
 * sign on X and Z and leaves Y alone. `prepare-train.mjs` explains this at
 * length; it is the same node and the same trap.
 */
const centreX = (worldLo[0] + worldHi[0]) / 2;
const centreZ = (worldLo[2] + worldHi[2]) / 2;
const turn = FACES_MINUS_Z ? 1 : -1;
const normalised = doc.createNode('stage')
  .setRotation(FACES_MINUS_Z ? [0, 0, 0, 1] : [0, 1, 0, 0])
  .setTranslation([turn * -centreX, -worldLo[1], turn * -centreZ]);
for (const child of scene.listChildren()) {
  scene.removeChild(child);
  normalised.addChild(child);
}
scene.addChild(normalised);

doc.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    encodeSpeed: 5,
    decodeSpeed: 5,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });
await io.write(DST, doc);

writeFileSync(DATA, `${JSON.stringify({
  model: `/${DST.replace(/^public\//, '')}`,
  /** Width (X), height (Y), depth (Z), metres. */
  size: size.map((v) => +v.toFixed(3)),
  /**
   * How far the open side is from the model's centre, metres.
   *
   * What the crowd field is measured from: the field starts at the stage's own
   * front edge, not at its middle, and the middle is 20 m back on a structure
   * this deep.
   */
  front: +(size[2] / 2).toFixed(3),
  triangles: totalAfter,
}, null, 2)}\n`);

console.log('\n--- stage ---');
console.log(`  ${size[0].toFixed(1)} m wide  ${size[1].toFixed(1)} m tall  ${size[2].toFixed(1)} m deep`
  + `  ${totalAfter.toLocaleString()} tris`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
