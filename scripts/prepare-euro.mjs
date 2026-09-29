/**
 * Cuts the European building pack into buildings you can place one at a time.
 *
 *     npm run prepare:euro
 *
 * `european_buildings_asset_pack_2.glb` is an asset pack presented the way
 * packs are: one scene, 148 m by 93, with the buildings stood in a row on it —
 * and **752 mesh nodes called `Object_5`, `Object_7`, `Object_9`**, split by
 * material rather than by object, with not one name in the file that says which
 * pieces are a building. A sales display, not a library.
 *
 * So this finds the buildings rather than being told them. The pieces are
 * clustered by their footprints: any two whose XZ boxes come within `GAP` of
 * each other are the same building, union-found until nothing joins. On this
 * pack that turns 752 parts into 38 clusters, of which the eight that are over
 * 2.5 m tall and 3 m wide are the buildings and the rest are bollards, signs
 * and a parked car.
 *
 * Which is not a trick — it is the only information in the file. There are no
 * names, no hierarchy and no convention; what makes a building a building here
 * is that its parts touch.
 *
 * Each cluster then gets what every other prop in this project gets: its world
 * transforms baked flat, its parts merged by material, its origin moved to the
 * middle of its own footprint with its feet on y = 0, and a name. They come out
 * as `euro1`..`euroN`, biggest first, so a config can name one and mean it.
 *
 * Writes:
 *   public/models/euro.glb           Draco, one node per building.
 *   src/config/euroModelData.json    Each one's size, in metres.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const SRC = source('european_buildings_asset_pack_2.glb');
const DST = 'public/models/euro.glb';
const DATA = 'src/config/euroModelData.json';

/**
 * How close two footprints have to be to belong to the same building.
 *
 * A metre and a half. Wide enough that a porch, a sign and a downpipe come with
 * the wall they hang off; narrow enough that two buildings stood four metres
 * apart on the display slab stay two buildings. The pack's own spacing is what
 * makes a number this blunt work at all.
 */
const GAP = 1.5;
/** A cluster has to be at least this to be a building rather than a bollard. */
const MIN_HEIGHT = 2.5;
const MIN_WIDTH = 3;
/** Textures over this go down to it. */
const TEXTURE_SIZE = 512;

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

/* ------------------------------------------------- 1. flatten into world space */

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
const walk = (node) => {
  const mesh = node.getMesh();
  if (mesh) {
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
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      const v = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        pos.getElement(i, v);
        const w = mul(world, v);
        p.set(w, i * 3);
        for (let k = 0; k < 3; k++) {
          if (w[k] < lo[k]) lo[k] = w[k];
          if (w[k] > hi[k]) hi[k] = w[k];
        }
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
        lo,
        hi,
      });
    }
  }
  for (const child of node.listChildren()) walk(child);
};
for (const child of scene.listChildren()) walk(child);
step(`${parts.length} primitives, ${root.listMaterials().length} materials`);

/* ------------------------------------------------ 2. cluster them by footprint */

const parent = parts.map((_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
const near = (a, b) => (
  a.lo[0] - GAP <= b.hi[0] && b.lo[0] - GAP <= a.hi[0]
  && a.lo[2] - GAP <= b.hi[2] && b.lo[2] - GAP <= a.hi[2]
);
for (let i = 0; i < parts.length; i++) {
  for (let j = i + 1; j < parts.length; j++) {
    if (!near(parts[i], parts[j])) continue;
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  }
}
const clusters = new Map();
parts.forEach((part, i) => {
  const key = find(i);
  const group = clusters.get(key) ?? { parts: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  group.parts.push(part);
  for (let k = 0; k < 3; k++) {
    group.lo[k] = Math.min(group.lo[k], part.lo[k]);
    group.hi[k] = Math.max(group.hi[k], part.hi[k]);
  }
  clusters.set(key, group);
});
const buildings = [...clusters.values()]
  .filter((g) => g.hi[1] - g.lo[1] > MIN_HEIGHT && g.hi[0] - g.lo[0] > MIN_WIDTH)
  .sort((a, b) => (b.hi[0] - b.lo[0]) * (b.hi[2] - b.lo[2]) - (a.hi[0] - a.lo[0]) * (a.hi[2] - a.lo[2]));
step(`${clusters.size} clusters, ${buildings.length} of them buildings`);

/* ----------------------------------------------------- 3. textures, once each */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const outScene = out.createScene('euro');

let imageBefore = 0;
let imageAfter = 0;
const textures = new Map();
async function copyTexture(src) {
  if (!src) return null;
  if (textures.has(src)) return textures.get(src);
  const image = src.getImage();
  if (!image) { textures.set(src, null); return null; }
  imageBefore += image.byteLength;
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  imageAfter += webp.byteLength;
  const copy = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(src, copy);
  return copy;
}

const materials = new Map();
async function copyMaterial(src) {
  if (materials.has(src)) return materials.get(src);
  const tex = await copyTexture(src?.getBaseColorTexture());
  const m = out.createMaterial(src?.getName() || 'euro')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.85)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE')
    .setDoubleSided(src?.getDoubleSided() ?? false);
  if (tex) m.setBaseColorTexture(tex);
  materials.set(src, m);
  return m;
}

/* ------------------------------------------- 4. one node per building, merged */

const data = {};
let totalTris = 0;
for (const [i, building] of buildings.entries()) {
  const name = `euro${i + 1}`;
  const cx = (building.lo[0] + building.hi[0]) / 2;
  const cz = (building.lo[2] + building.hi[2]) / 2;
  const base = building.lo[1];
  const size = [0, 1, 2].map((k) => building.hi[k] - building.lo[k]);

  const byMaterial = new Map();
  for (const part of building.parts) {
    const list = byMaterial.get(part.material) ?? [];
    list.push(part);
    byMaterial.set(part.material, list);
  }
  const mesh = out.createMesh(name);
  let tris = 0;
  for (const [srcMaterial, list] of byMaterial) {
    const vCount = list.reduce((a, p) => a + p.pos.length / 3, 0);
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const uvs = new Float32Array(vCount * 2);
    const idx = new Uint32Array(list.reduce((a, p) => a + p.idx.length, 0));
    let vo = 0;
    let io2 = 0;
    for (const part of list) {
      for (let k = 0; k < part.pos.length; k += 3) {
        pos[vo * 3 + k] = part.pos[k] - cx;
        pos[vo * 3 + k + 1] = part.pos[k + 1] - base;
        pos[vo * 3 + k + 2] = part.pos[k + 2] - cz;
      }
      nrm.set(part.nrm, vo * 3);
      uvs.set(part.uv, vo * 2);
      for (let k = 0; k < part.idx.length; k++) idx[io2 + k] = part.idx[k] + vo;
      vo += part.pos.length / 3;
      io2 += part.idx.length;
    }
    const prim = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
      .setMaterial(await copyMaterial(srcMaterial));
    mesh.addPrimitive(prim);
    tris += idx.length / 3;
  }
  outScene.addChild(out.createNode(name).setMesh(mesh));
  data[name] = {
    size: size.map((v) => +v.toFixed(2)),
    parts: byMaterial.size,
    triangles: tris,
  };
  totalTris += tris;
  step(`${name}: ${size.map((v) => v.toFixed(1)).join(' x ')} m, `
    + `${building.parts.length} pieces -> ${byMaterial.size} materials, ${tris} tris`);
}
if (imageBefore) step(`${textures.size} textures to WebP, ${mb(imageBefore)} -> ${mb(imageAfter)}`);

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  quantizationVolume: 'mesh',
  quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify({ parts: data }, null, 2)}\n`);

console.log('\n--- euro ---');
console.log(`  ${buildings.length} buildings, ${totalTris.toLocaleString()} tris`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
