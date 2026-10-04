/**
 * Turns the dropped railway station into the Kestrel station's hall.
 *
 *     npm run prepare:kestrel-station
 *
 * `railway_station.glb` is a Sketchfab export from 3ds Max: one mesh, one
 * material on a 1024 px PNG atlas, 1,336 triangles, in CENTIMETRES (9,100 x
 * 3,100 units is a 91 x 31 m station), with a metre of foundation below its
 * street level and the hall floor raised 1.5 m above it.
 *
 * The halls' recipe (`prepare-halls`), for a single part: bake the node
 * transforms flat, convert to metres, stand its own street level on y = 0
 * (see `DECK_OVERRIDE`), centre on the footprint, re-cut the texture to WebP,
 * Draco.
 *
 * Writes:
 *   public/models/kestrelStation.glb     Draco, one node.
 *   src/config/kestrelStationData.json   Its measured size and skirt.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const NAME = 'kestrelStation';
const SRC = source('railway_station.glb');
const DST = `public/models/${NAME}.glb`;
const DATA = `src/config/${NAME}Data.json`;
/** Source units per metre. */
const UNIT = 100;
const TEXTURE_SIZE = 1024;
const DECK_BUCKET = 0.1;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const step = (msg) => console.log(`  ${msg}`);
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

const srcSize = readFileSync(SRC).byteLength;
step(`reading ${SRC} (${mb(srcSize)})`);
const doc = await io.read(SRC);

/* 1. Every primitive, in world space. */
const parts = [];
for (const node of doc.getRoot().listNodes()) {
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
      pos: p, nrm: n, uv: t,
      idx: idx
        ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
        : Uint32Array.from({ length: count }, (_, i) => i),
      material: prim.getMaterial(),
    });
  }
}
if (!parts.length) throw new Error(`no geometry in ${SRC}`);

/* 2. Bounds, deck, and the move to metres about the footprint centre. */
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
let size = [0, 1, 2].map((k) => hi[k] - lo[k]);
const triangles = parts.reduce((a, p) => a + p.idx.length / 3, 0);

/**
 * The ground line. The auto-detected deck (the commonest flat height low
 * down) is the hall's raised floor, 1.5 m up — stood on that, its front steps
 * would go into the ground. The model's own y = 0 is the street, so that is
 * the deck; the metre below it is foundation and becomes skirt.
 */
const DECK_OVERRIDE = 0;
const deck = DECK_OVERRIDE ?? (() => {
  const band = lo[1] + size[1] * 0.2;
  const hist = new Map();
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      const y = part.pos[i + 1];
      if (y > band) continue;
      if (part.nrm.length && Math.abs(part.nrm[i + 1]) < 0.8) continue;
      const k = Math.round(y / (DECK_BUCKET * UNIT));
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  }
  if (!hist.size) return lo[1];
  const [best] = [...hist].sort((a, b) => b[1] - a[1]);
  return best[0] * DECK_BUCKET * UNIT;
})();
step(`deck at y = ${(deck / UNIT).toFixed(2)} m (box starts at ${(lo[1] / UNIT).toFixed(2)} m)`);

const cx = (lo[0] + hi[0]) / 2;
const cz = (lo[2] + hi[2]) / 2;
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    part.pos[i] = (part.pos[i] - cx) / UNIT;
    part.pos[i + 1] = (part.pos[i + 1] - deck) / UNIT;
    part.pos[i + 2] = (part.pos[i + 2] - cz) / UNIT;
  }
}
size = size.map((v) => v / UNIT);
const skirt = (deck - lo[1]) / UNIT;

/* 3. Write it out: one node, a primitive per material, WebP textures. */
const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene(NAME);
let imageBefore = 0;
let imageAfter = 0;
const copied = new Map();
const copyMaterial = async (src) => {
  if (copied.has(src)) return copied.get(src);
  let texture = null;
  const srcTexture = src?.getBaseColorTexture();
  if (srcTexture?.getImage()) {
    imageBefore += srcTexture.getImage().byteLength;
    const webp = await sharp(Buffer.from(srcTexture.getImage()))
      .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer();
    imageAfter += webp.byteLength;
    texture = out.createTexture(srcTexture.getName() || NAME).setImage(webp).setMimeType('image/webp');
  }
  const m = out.createMaterial(src?.getName() || NAME)
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.85)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE')
    .setDoubleSided(src?.getDoubleSided() ?? true);
  if (texture) m.setBaseColorTexture(texture);
  copied.set(src, m);
  return m;
};

const byMaterial = new Map();
for (const part of parts) {
  const list = byMaterial.get(part.material) ?? [];
  list.push(part);
  byMaterial.set(part.material, list);
}
const mesh = out.createMesh(NAME);
for (const [srcMaterial, list] of byMaterial) {
  const vCount = list.reduce((a, p) => a + p.pos.length / 3, 0);
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const idx = new Uint32Array(list.reduce((a, p) => a + p.idx.length, 0));
  let vo = 0;
  let io2 = 0;
  for (const part of list) {
    pos.set(part.pos, vo * 3);
    nrm.set(part.nrm, vo * 3);
    uvs.set(part.uv, vo * 2);
    for (let i = 0; i < part.idx.length; i++) idx[io2 + i] = part.idx[i] + vo;
    vo += part.pos.length / 3;
    io2 += part.idx.length;
  }
  mesh.addPrimitive(out.createPrimitive()
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
    .setMaterial(await copyMaterial(srcMaterial)));
}
if (imageBefore) step(`textures to WebP, ${mb(imageBefore)} -> ${mb(imageAfter)}`);
scene.addChild(out.createNode(NAME).setMesh(mesh));

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  quantizationVolume: 'mesh',
  quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify({
  model: `/${DST.replace(/^public\//, '')}`,
  size: size.map((v) => +v.toFixed(3)),
  skirt: +skirt.toFixed(3),
  triangles,
}, null, 2)}\n`);

console.log(`  ${size[0].toFixed(1)} x ${size[2].toFixed(1)} m, ${size[1].toFixed(1)} m tall, `
  + `${triangles.toLocaleString()} tris`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}`);
