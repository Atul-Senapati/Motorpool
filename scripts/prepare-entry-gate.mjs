/**
 * Turns the dropped bus-terminal gate into Halcyon Field's entrance canopy.
 *
 *     npm run prepare:entry-gate
 *
 * `mersin_otogar_kapi.glb` — the gate of Mersin's bus terminal, which stands
 * on the airport's landside forecourt beside the terminal building. Twelve parts,
 * twelve materials, **no textures at all**: every material is plain white, so
 * what arrives is a white structure and the shape is the whole of it. 25,572
 * triangles, in metres, upright, 161 m wide and 20 tall.
 *
 * Two of the twelve are a **ground slab** — 146 by 61 m and 40 cm thick, with a
 * second one laid on top of it at zero thickness. They are what makes the model
 * measure 61 m deep when the canopy is 30, and they are the third time in this
 * project a building has arrived standing on its own piece of ground
 * (`prepare-school.mjs`, `prepare-justice.mjs`). Kestrel has ground.
 *
 * Otherwise the usual short pass: bake the node transforms flat, merge by
 * material, stand it on its deck, centre it on its footprint, Draco. There are
 * no textures to re-cut, which makes this the cheapest prepare script here.
 *
 * Writes:
 *   public/models/entrygate.glb      Draco, one node `entryGate`.
 *   src/config/entryGateData.json    Its measured size and skirt.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('mersin_otogar_kapi.glb');
const DST = 'public/models/entrygate.glb';
const DATA = 'src/config/entryGateData.json';
/**
 * What it came standing ON, by material name.
 *
 * `mat_0006` is a 146 by 61 m apron 40 cm thick and `mat_0007` is a second one
 * laid on top of it with no thickness at all. Kestrel has ground of its own,
 * and this is the third time in this project a building has turned up standing
 * on a piece of somebody else's (`prepare-school.mjs`, `prepare-justice.mjs`).
 *
 * `mat_0011` goes with them: 926 triangles over the model's whole 161 by 61 m
 * envelope — the terminal's back range and yard wall, which is a bus station
 * and not a railway one, and the other reason the model measures 61 m deep when
 * its canopy is 30.
 */
const DROP = /^mat_(0006|0007|0011)/i;
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
    if (DROP.test(prim.getMaterial()?.getName() ?? '')) continue;
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

const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);

/**
 * The nine, by the model's own material names.
 *
 * Read each comment as the survey that placed it: size, the height band it
 * lives in, and its triangle count. That is everything the file gives, and it
 * is enough to tell an arch from a pane of glass.
 */
const PAINT = {
  // 45 x 29 m, y 18-22, 9,538 tris: the curved roof deck, up in the air.
  mat_0000: { color: '#c9ccce', rough: 0.42, metal: 0.45 },
  // 161 x 30 m over the whole height, 792 tris: the glazed walls.
  mat_0001: { color: '#6d93a6', rough: 0.07, metal: 0.62 },
  // 87 x 21 m, y 14-21, 272 tris: the fascia band under the roof's edge.
  mat_0002: { color: '#eceeef', rough: 0.4, metal: 0.2 },
  // 123 x 22 m over the whole height, 4,289 tris: the arches and columns.
  mat_0003: { color: '#4a5056', rough: 0.38, metal: 0.62 },
  // 128 x 28 m over the whole height, 9,402 tris: the shell they carry.
  mat_0004: { color: '#dfe2e3', rough: 0.48, metal: 0.28 },
  // 14 x 15 m, y 10.5-11.5, 18 tris: a board. Railway blue, like every other
  // sign on this map — see the `signage-style` note.
  mat_0005: { color: '#1d3f73', rough: 0.5, metal: 0.1 },
  // 33 x 21 m, y 1.5-16, 35 tris: the end block's wall.
  mat_0008: { color: '#d8d2c5', rough: 0.75, metal: 0 },
  // 52 x 15 m, y 1.5-10.5, 64 tris: the lower wall and the plinth under it.
  mat_0009: { color: '#9a9488', rough: 0.8, metal: 0 },
  // 123 x 21 m, y 1.5-16, 68 tris: the long curtain wall. A shade off
  // `mat_0001` so the two planes of glass read as two planes.
  mat_0010: { color: '#5d8397', rough: 0.05, metal: 0.66 },
};

/** What an unlisted material would get, if the model ever grew one. */
const DEFAULT_PAINT = { color: '#dfe2e3', rough: 0.5, metal: 0.25 };

/** The finish for one material, by name. */
const paintFor = (src) => PAINT[(src?.getName() ?? '').slice(0, 8)] ?? DEFAULT_PAINT;



const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('entryGate');

/*
 * Merged BY MATERIAL, and each material repainted.
 *
 * The model's twelve materials carry no information of their own — they are
 * `mat_0000` to `mat_0011` and every one is flat white — so what is kept from
 * them is the GROUPING: which triangles belong together. The name is then the
 * key into `PAINT`, which is the only place anything is said about them.
 */
const copied = new Map();

function copyMaterial(src) {
  if (copied.has(src)) return copied.get(src);
  const paint = paintFor(src);
  const m = out.createMaterial(src?.getName() || 'entryGate')
    .setBaseColorFactor([...lin(paint.color), 1])
    .setMetallicFactor(paint.metal)
    .setRoughnessFactor(paint.rough)
    .setAlphaMode('OPAQUE')
    .setDoubleSided(true);
  copied.set(src, m);
  return m;
}

const byMaterial = new Map();
for (const part of parts) {
  const list = byMaterial.get(part.material) ?? [];
  list.push(part);
  byMaterial.set(part.material, list);
}
const mesh = out.createMesh('entryGate');
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
    .setMaterial(copyMaterial(srcMaterial)));
}
step(`${copied.size} materials painted, one colour each, no textures`);
scene.addChild(out.createNode('entryGate').setMesh(mesh));

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

console.log('\n--- entryGate ---');
console.log(`  ${size[0].toFixed(1)} x ${size[2].toFixed(1)} m, ${size[1].toFixed(1)} m tall, `
  + `${triangles.toLocaleString()} tris`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
