/**
 * Turns the dropped factory into St. Anjali's workshop block.
 *
 *     npm run prepare:workshop
 *
 * `vaccume_tube_factory.glb`: two parts, one material, one 1.6 MB atlas, 4,857
 * triangles, already in metres and already upright — 57 m by 36 by 18.4, which
 * is a shed and a silo at one end of it. There is no ruler to apply and no
 * rotation to bake, so this is one of the short prepare scripts: bake the node
 * transforms flat, merge to one node, stand it on its DECK, centre it on its
 * own footprint, re-cut the atlas, Draco.
 *
 * The deck and not the bounding box, the same as `prepare-school.mjs`: the
 * model's lowest vertex is 1.7 m under the slab it stands on, and a building
 * sat on that floats by that much. It is found as the commonest height among
 * the near-horizontal vertices in the bottom fifth.
 *
 * Writes:
 *   public/models/workshop.glb      Draco, one node `workshop`.
 *   src/config/workshopData.json    Its measured size and skirt.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const SRC = source('vaccume_tube_factory.glb');
const DST = 'public/models/workshop.glb';
const DATA = 'src/config/workshopData.json';
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
    const count = pos.getCount();
    const p = new Float32Array(count * 3);
    const n = new Float32Array(count * 3);
    const t = new Float32Array(count * 2);
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
      if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
    }
    const idx = prim.getIndices();
    parts.push({
      pos: p,
      nrm: n,
      uv: t,
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
step(`${parts.length} parts, ${triangles.toLocaleString()} triangles, `
  + `${size[0].toFixed(1)} x ${size[2].toFixed(1)} m, ${size[1].toFixed(1)} m tall`);

/* The deck: commonest height among the flat-facing vertices low down. */
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
step(`deck at y = ${deck.toFixed(2)} (box starts at ${lo[1].toFixed(2)}), `
  + `${(deck - lo[1]).toFixed(2)} m of it below grade`);

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
const scene = out.createScene('workshop');

const srcTexture = root.listTextures()[0];
let texture = null;
if (srcTexture?.getImage()) {
  const before = srcTexture.getImage().byteLength;
  const webp = await sharp(Buffer.from(srcTexture.getImage()))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86 })
    .toBuffer();
  texture = out.createTexture('workshop').setImage(webp).setMimeType('image/webp');
  step(`atlas to WebP, ${mb(before)} -> ${mb(webp.byteLength)}`);
}
const srcMaterial = parts[0].material;
const material = out.createMaterial('workshop')
  .setBaseColorFactor(srcMaterial?.getBaseColorFactor() ?? [1, 1, 1, 1])
  .setMetallicFactor(srcMaterial?.getMetallicFactor() ?? 0)
  .setRoughnessFactor(srcMaterial?.getRoughnessFactor() ?? 0.85)
  .setAlphaMode('OPAQUE')
  .setDoubleSided(true);
if (texture) material.setBaseColorTexture(texture);

const vCount = parts.reduce((a, p) => a + p.pos.length / 3, 0);
const pos = new Float32Array(vCount * 3);
const nrm = new Float32Array(vCount * 3);
const uvs = new Float32Array(vCount * 2);
const idx = new Uint32Array(parts.reduce((a, p) => a + p.idx.length, 0));
let vo = 0;
let io2 = 0;
for (const part of parts) {
  pos.set(part.pos, vo * 3);
  nrm.set(part.nrm, vo * 3);
  uvs.set(part.uv, vo * 2);
  for (let i = 0; i < part.idx.length; i++) idx[io2 + i] = part.idx[i] + vo;
  vo += part.pos.length / 3;
  io2 += part.idx.length;
}
const mesh = out.createMesh('workshop');
mesh.addPrimitive(out.createPrimitive()
  .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
  .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
  .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
  .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
  .setMaterial(material));
scene.addChild(out.createNode('workshop').setMesh(mesh));

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  quantizationVolume: 'mesh',
  quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify({
  model: `/${DST.replace(/^public\//, '')}`,
  size: size.map((v) => +v.toFixed(3)),
  skirt: +(deck - lo[1]).toFixed(3),
  triangles,
}, null, 2)}\n`);

console.log('\n--- workshop ---');
console.log(`  ${size[0].toFixed(1)} x ${size[2].toFixed(1)} m, ${size[1].toFixed(1)} m tall, `
  + `${triangles.toLocaleString()} tris`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
