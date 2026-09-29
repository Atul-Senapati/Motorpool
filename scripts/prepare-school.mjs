/**
 * Turns the dropped high school into Kestrel's school campus.
 *
 *     npm run prepare:school
 *
 * `american_high_school.glb`: four parts under Sketchfab's usual Z-up wrapper —
 * `Schoo_0` (the building and its parking lot), `Track_1` (the running track
 * and its stand), `Baseball_2` (the diamond and its backstop) and `Hoop_3` (a
 * basketball hoop) — 11,208 triangles between them, sharing ONE material and
 * one 1024 atlas. It is already **in metres**: 155.7 m by 113.1 m by 12.5 m
 * tall, which is a real American high school campus and not a ruler that needs
 * applying.
 *
 * So this pass has very little to do, and does not pretend otherwise. No
 * decimation — 11 k triangles is a third of what one of the freight wagons
 * costs, and taking any off a model this cheap would only round the corners off
 * the building. What it does:
 *
 * 1. bakes the node transforms flat and merges the four parts into one node,
 *    so the campus is one object the scene places by its middle;
 * 2. stands the campus deck on y = 0 — **the deck, not the bounding box**. The
 *    lot's slab has a skirt under it that reaches ~1 m below grade, and a model
 *    sat on its lowest vertex would float the whole campus by that much. The
 *    deck is found as the commonest height among the near-horizontal, so the
 *    ground people walk on is the ground;
 * 3. centres it on X and Z;
 * 4. re-cuts the atlas as WebP and turns the material from BLEND to MASK. The
 *    alpha in it is a chain-link fence and a few cut-out details, which is
 *    exactly what a cutout is for; left as BLEND, a 155 m ground plane and a
 *    fence in front of it sort against each other by depth order and the fence
 *    flickers.
 *
 * Which way it faces is *measured*, not assumed, for the same reason
 * `prepare-stage.mjs` measures the open side of a stage: the sports ground is
 * the half of the campus with the track and the diamond in it, and the front is
 * the other half. See `FRONT` below.
 *
 * Writes:
 *   public/models/school.glb      Draco, one node `school`.
 *   src/config/schoolData.json    Measured size, and which way the front faces.
 *
 * The colliders are NOT written here. They come from
 * `scripts/prepare-colliders.mjs`, which reads this file's output and measures
 * what a car can actually hit — the building, the stand and the backstop —
 * leaving the parking lot and the field drivable. Run that after this.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const SRC = source('american_high_school.glb');
const DST = 'public/models/school.glb';
const DATA = 'src/config/schoolData.json';

/** The atlas goes to this, which is the size every other prop here uses. */
const TEXTURE_SIZE = 1024;

/** Height bucket for finding the deck. Fine enough to separate a kerb from it. */
const DECK_BUCKET = 0.1;

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

/* -------------------------------------------------- 1. flatten into world space
 *
 * The export is four meshes under five nested nodes, and the outermost pair are
 * the Z-up-to-Y-up quarter turn Sketchfab writes on everything. Rather than
 * carry that tree through, every vertex is pushed through its node's world
 * matrix once and the parts come out in a single frame — which is also what
 * lets the measurements below be about the campus rather than about whichever
 * node happens to hold a part.
 */
const mul = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
const mulDir = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];

const parts = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const world = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const nrm = prim.getAttribute('NORMAL');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const count = pos.getCount();
    const p = new Float32Array(count * 3);
    const n = new Float32Array(nrm ? count * 3 : 0);
    const v = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      pos.getElement(i, v);
      p.set(mul(world, v), i * 3);
      if (nrm) {
        nrm.getElement(i, v);
        const d = mulDir(world, v);
        const len = Math.hypot(...d) || 1;
        n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
      }
    }
    const uvs = new Float32Array(count * 2);
    if (uv) {
      for (let i = 0; i < count; i++) {
        uv.getElement(i, v);
        uvs.set([v[0], v[1]], i * 2);
      }
    }
    parts.push({
      name: node.getParentNode()?.getName() ?? mesh.getName(),
      pos: p,
      nrm: n,
      uv: uvs,
      idx: idx
        ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
        : Uint32Array.from({ length: count }, (_, i) => i),
      material: prim.getMaterial(),
    });
  }
}
if (!parts.length) throw new Error('no geometry in the source model');

const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], part.pos[i + k]);
      hi[k] = Math.max(hi[k], part.pos[i + k]);
    }
  }
}
const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
const triangles = parts.reduce((a, p) => a + p.idx.length / 3, 0);
step(`${parts.length} parts (${parts.map((p) => p.name).join(', ')}), `
  + `${triangles.toLocaleString()} triangles`);
step(`${size[0].toFixed(2)} m by ${size[2].toFixed(2)} m, ${size[1].toFixed(2)} m tall`);

/* ------------------------------------------------------------- 2. find the deck
 *
 * The commonest height among the flat-facing vertices in the bottom fifth of
 * the model. Flat-facing, because a wall has vertices at every height and a
 * ground plane has all of its at one; bottom fifth, because a flat roof is also
 * flat and there is more roof on this model than there is kerb.
 */
const deck = (() => {
  const band = lo[1] + size[1] * 0.2;
  const hist = new Map();
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      const y = part.pos[i + 1];
      if (y > band) continue;
      if (part.nrm.length && Math.abs(part.nrm[i + 1]) < 0.8) continue;
      const k = Math.round(y / DECK_BUCKET);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  }
  if (!hist.size) return lo[1];
  const [best] = [...hist].sort((a, b) => b[1] - a[1]);
  return best[0] * DECK_BUCKET;
})();
step(`deck at y = ${deck.toFixed(2)} (bounding box starts at ${lo[1].toFixed(2)}), `
  + `so ${(deck - lo[1]).toFixed(2)} m of it is below grade`);

/* ------------------------------------------------------- 3. which way it faces
 *
 * The campus is a building and its lot at one end and a running track and a
 * baseball diamond at the other, and the front of a school is the end you drive
 * up to. So the sports ground is found by name — the two parts that are a track
 * and a diamond — and the front is whichever side of the campus middle they are
 * NOT on.
 *
 * By name and not by triangle count, because unlike the stage's open side there
 * is no shape argument to be made here: a running track is a great many
 * triangles and so is a school. The names are what the export actually knows.
 */
const SPORTS = /track|baseball|field|diamond/i;
const sportsZ = [];
for (const part of parts) {
  if (!SPORTS.test(part.name)) continue;
  for (let i = 2; i < part.pos.length; i += 3) sportsZ.push(part.pos[i]);
}
const midZ = (lo[2] + hi[2]) / 2;
const meanSportsZ = sportsZ.length
  ? sportsZ.reduce((a, b) => a + b, 0) / sportsZ.length
  : midZ - 1;
/** The sign of Z the front is on: away from the playing fields. */
const front = Math.sign(midZ - meanSportsZ) || 1;
step(`playing fields average z = ${meanSportsZ.toFixed(1)} against a middle of `
  + `${midZ.toFixed(1)} => the front is the ${front > 0 ? '+Z' : '-Z'} side`);

/* ------------------------------------------------------ 4. normalise and merge */

const cx = (lo[0] + hi[0]) / 2;
const cz = (lo[2] + hi[2]) / 2;
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    part.pos[i] -= cx;
    part.pos[i + 1] -= deck;
    part.pos[i + 2] -= cz;
  }
}

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const outScene = out.createScene('school');

/*
 * One atlas, re-cut. The source is a 1.2 MB PNG with a real alpha channel in
 * it — the chain-link fence panels along the lot — so the alpha is kept and the
 * mode moved from BLEND to MASK: a cutout needs no depth sorting, and sorting
 * is exactly what a 155 m ground plane and a fence standing on it get wrong.
 */
const srcTexture = root.listTextures()[0];
let texture = null;
let imageBefore = 0;
let imageAfter = 0;
if (srcTexture?.getImage()) {
  imageBefore = srcTexture.getImage().byteLength;
  const webp = await sharp(Buffer.from(srcTexture.getImage()))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  imageAfter = webp.byteLength;
  texture = out.createTexture('campus').setImage(webp).setMimeType('image/webp');
  step(`atlas to WebP, ${mb(imageBefore)} -> ${mb(imageAfter)}`);
}

const material = out.createMaterial('campus')
  .setBaseColorFactor(parts[0].material?.getBaseColorFactor() ?? [1, 1, 1, 1])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.85)
  .setAlphaMode('MASK')
  .setAlphaCutoff(0.5)
  .setDoubleSided(true);
if (texture) material.setBaseColorTexture(texture);

// Merged: every part shares the one material, so there is nothing a second
// primitive would buy and one draw call is one draw call.
const vCount = parts.reduce((a, p) => a + p.pos.length / 3, 0);
const pos = new Float32Array(vCount * 3);
const nrm = new Float32Array(vCount * 3);
const uvs = new Float32Array(vCount * 2);
const idx = new Uint32Array(parts.reduce((a, p) => a + p.idx.length, 0));
let vo = 0;
let io2 = 0;
for (const part of parts) {
  pos.set(part.pos, vo * 3);
  if (part.nrm.length) nrm.set(part.nrm, vo * 3);
  uvs.set(part.uv, vo * 2);
  for (let i = 0; i < part.idx.length; i++) idx[io2 + i] = part.idx[i] + vo;
  vo += part.pos.length / 3;
  io2 += part.idx.length;
}
const mesh = out.createMesh('school');
mesh.addPrimitive(out.createPrimitive()
  .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
  .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
  .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
  .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
  .setMaterial(material));
outScene.addChild(out.createNode('school').setMesh(mesh));

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  quantizationVolume: 'mesh',
  quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
});
await io.write(DST, out);

writeFileSync(DATA, `${JSON.stringify({
  model: `/${DST.replace(/^public\//, '')}`,
  /** Width (X), height (Y), depth (Z), metres, about the deck and the middle. */
  size: size.map((v) => +v.toFixed(3)),
  /** How far the campus reaches BELOW its deck, metres. Buried, not floated. */
  skirt: +(deck - lo[1]).toFixed(3),
  /** Which side of Z the front is on. The playing fields are on the other. */
  front,
  triangles,
}, null, 2)}\n`);

console.log('\n--- school ---');
console.log(`  ${size[0].toFixed(1)} m by ${size[2].toFixed(1)} m  ${size[1].toFixed(1)} m tall`
  + `  ${triangles.toLocaleString()} tris`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
