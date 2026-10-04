/**
 * Lifts the city's petrol station out of the city model for Halcyon Junction's
 * car park.
 *
 *     npm run prepare:petrol
 *
 * The station stands at world (−1125, −150) in the city: a 40 x 31 m canopy
 * over four pump islands, a kiosk behind it and a second row of pumps, all on
 * its own paved lot. Like everything in `city.glb` it is not an object but
 * triangles in the city's chunks, which are merged by (material, 250 m cell) —
 * the canopy is in `col_Street`, the kiosk in `col_Building`, the pumps and
 * signs in `deco_*`. So it is cut out by POSITION: every triangle whose
 * centroid is inside the lot, from every chunk, keeping each chunk's material.
 *
 * The lot is bounded by green verges on three sides and the side street on the
 * fourth, and the box below is that lot and no more: one metre wider and the
 * street's own tarmac and kerbs come with it.
 *
 * Writes a NEW document (disposing the rest of the city in place leaves the
 * whole city's buffers behind — see `prepare-trucks`), merged by material,
 * centred on the lot, standing on its paving at y = 0, with the city's own
 * textures re-cut to 1024 WebP, and Draco.
 *
 *   public/models/petrol.glb       one node, `petrol`
 *   src/config/petrolData.json     its size and the lot's footprint
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptDecoder } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SRC = 'public/models/city.glb';
const DST = 'public/models/petrol.glb';
const DATA = 'src/config/petrolData.json';
/** The lot, world XZ, measured off a plan of the city's triangles. */
const LOT = { x0: -1148.6, x1: -1100.9, z0: -182.2, z1: -118.6 };
/** Nothing above this is the station: the city's taller neighbours lean in. */
const CEILING = 12;
const TEXTURE_SIZE = 1024;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'meshopt.decoder': MeshoptDecoder,
});
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const doc = await io.read(SRC);

const parts = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  if (/Vegetation/.test(node.getName())) continue;
  const w = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const count = pos.getCount();
    const P = new Float32Array(count * 3);
    const v = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      pos.getElement(i, v);
      P[i * 3] = w[0] * v[0] + w[4] * v[1] + w[8] * v[2] + w[12];
      P[i * 3 + 1] = w[1] * v[0] + w[5] * v[1] + w[9] * v[2] + w[13];
      P[i * 3 + 2] = w[2] * v[0] + w[6] * v[1] + w[10] * v[2] + w[14];
    }
    const tri = (i) => (idx ? idx.getScalar(i) : i);
    const n3 = idx ? idx.getCount() : count;
    const keep = [];
    for (let i = 0; i < n3; i += 3) {
      const a = tri(i); const b = tri(i + 1); const c = tri(i + 2);
      const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
      const y = Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]);
      const z = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      if (x < LOT.x0 || x > LOT.x1 || z < LOT.z0 || z > LOT.z1 || y > CEILING) continue;
      // A triangle that pokes far outside the lot is a neighbour's, not ours.
      const out = [a, b, c].some((k) => P[k * 3] < LOT.x0 - 3 || P[k * 3] > LOT.x1 + 3
        || P[k * 3 + 2] < LOT.z0 - 3 || P[k * 3 + 2] > LOT.z1 + 3);
      if (!out) keep.push(a, b, c);
    }
    if (!keep.length) continue;
    const remap = new Map();
    const used = [];
    for (const k of keep) if (!remap.has(k)) { remap.set(k, used.length); used.push(k); }
    const p = new Float32Array(used.length * 3);
    const n = new Float32Array(used.length * 3);
    const t = new Float32Array(used.length * 2);
    used.forEach((k, j) => {
      p.set(P.subarray(k * 3, k * 3 + 3), j * 3);
      if (nrm) {
        nrm.getElement(k, v);
        const d = [w[0] * v[0] + w[4] * v[1] + w[8] * v[2], w[1] * v[0] + w[5] * v[1] + w[9] * v[2], w[2] * v[0] + w[6] * v[1] + w[10] * v[2]];
        const l = Math.hypot(...d) || 1;
        n.set([d[0] / l, d[1] / l, d[2] / l], j * 3);
      }
      if (uv) { uv.getElement(k, v); t.set([v[0], v[1]], j * 2); }
    });
    parts.push({ name: node.getName(), material: prim.getMaterial(), pos: p, nrm: n, uv: t, idx: Uint32Array.from(keep, (k) => remap.get(k)) });
  }
}
if (!parts.length) throw new Error('nothing inside the lot');
let tris = parts.reduce((a, q) => a + q.idx.length / 3, 0);
console.log(`  ${parts.length} pieces from ${new Set(parts.map((q) => q.name)).size} chunks, ${tris.toLocaleString()} triangles`);

/* The paving: the commonest height among upward faces. */
const hist = new Map();
for (const q of parts) {
  for (let i = 0; i < q.pos.length; i += 3) {
    if (q.nrm[i + 1] < 0.9) continue;
    const k = Math.round(q.pos[i + 1] * 20);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
}
const deck = [...hist].sort((a, b) => b[1] - a[1])[0][0] / 20;
const cx = (LOT.x0 + LOT.x1) / 2;
const cz = (LOT.z0 + LOT.z1) / 2;
let top = -Infinity;
for (const q of parts) {
  for (let i = 0; i < q.pos.length; i += 3) {
    q.pos[i] -= cx; q.pos[i + 1] -= deck; q.pos[i + 2] -= cz;
    top = Math.max(top, q.pos[i + 1]);
  }
}
console.log(`  paving at y = ${deck.toFixed(2)}, ${top.toFixed(1)} m to the top`);

/*
 * The boundary walls, which are the city's and not the station's: a 5.6 m
 * blank wall down the whole of the lot's verge side and another across its
 * far end, put there to screen it from the neighbours. Set down beside a car
 * park they wall the station off from the very thing it is part of, so every
 * triangle lying wholly in either wall's slab — faces and cap — goes.
 */
const WALLS = [
  (x) => x > -23.3 && x < -22.1,
  (_x, z) => z > 30.6 && z < 31.7,
];
let dropped = 0;
for (const q of parts) {
  const keep = [];
  for (let i = 0; i < q.idx.length; i += 3) {
    const k = [q.idx[i], q.idx[i + 1], q.idx[i + 2]];
    const inWall = WALLS.some((w) => k.every((v) => w(q.pos[v * 3], q.pos[v * 3 + 2])));
    if (inWall) dropped++; else keep.push(...k);
  }
  q.idx = Uint32Array.from(keep);
}
/*
 * And the floor: the lot's own paving and verges. The station stands on the
 * car park's asphalt instead (`StationPetrol`), so the two are one surface.
 * Only faces lying flat at ground level go — the pump islands' raised tops,
 * the kerbs' sides and everything above stay.
 */
let floor = 0;
for (let i = parts.length - 1; i >= 0; i--) {
  const q = parts[i];
  if (q.material?.getName() === 'Blocks') { floor += q.idx.length / 3; parts.splice(i, 1); continue; }
  const keep = [];
  for (let t = 0; t < q.idx.length; t += 3) {
    const k = [q.idx[t], q.idx[t + 1], q.idx[t + 2]];
    const flat = k.every((v) => Math.abs(q.pos[v * 3 + 1]) < 0.06 && q.nrm[v * 3 + 1] > 0.9);
    if (flat) floor++; else keep.push(...k);
  }
  q.idx = Uint32Array.from(keep);
}
console.log(`  dropped ${floor} triangles of floor`);
top = -Infinity;
for (const q of parts) for (const v of q.idx) top = Math.max(top, q.pos[v * 3 + 1]);
console.log(`  dropped ${dropped} triangles of boundary wall`);

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('petrol');
const copied = new Map();
const images = new Map();
let before = 0; let after = 0;
async function copyMaterial(src) {
  if (copied.has(src)) return copied.get(src);
  const m = out.createMaterial(src?.getName() || 'petrol')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.85)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE')
    .setAlphaCutoff(src?.getAlphaCutoff() ?? 0.5)
    .setDoubleSided(src?.getDoubleSided() ?? false);
  const tex = src?.getBaseColorTexture();
  if (tex?.getImage()) {
    if (!images.has(tex)) {
      before += tex.getImage().byteLength;
      const webp = await sharp(Buffer.from(tex.getImage()))
        .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86 }).toBuffer();
      after += webp.byteLength;
      images.set(tex, out.createTexture(tex.getName() || 'petrol').setImage(webp).setMimeType('image/webp'));
    }
    m.setBaseColorTexture(images.get(tex));
  }
  const em = src?.getEmissiveTexture();
  if (src?.getEmissiveFactor) m.setEmissiveFactor(src.getEmissiveFactor());
  if (em?.getImage() && images.has(em)) m.setEmissiveTexture(images.get(em));
  copied.set(src, m);
  return m;
}
const byMaterial = new Map();
for (const q of parts) byMaterial.set(q.material, [...(byMaterial.get(q.material) ?? []), q]);
const mesh = out.createMesh('petrol');
for (const [material, list] of byMaterial) {
  const vCount = list.reduce((a, q) => a + q.pos.length / 3, 0);
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const idx = new Uint32Array(list.reduce((a, q) => a + q.idx.length, 0));
  let vo = 0; let io2 = 0;
  for (const q of list) {
    pos.set(q.pos, vo * 3); nrm.set(q.nrm, vo * 3); uvs.set(q.uv, vo * 2);
    for (let i = 0; i < q.idx.length; i++) idx[io2 + i] = q.idx[i] + vo;
    vo += q.pos.length / 3; io2 += q.idx.length;
  }
  mesh.addPrimitive(out.createPrimitive()
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
    .setMaterial(await copyMaterial(material)));
}
scene.addChild(out.createNode('petrol').setMesh(mesh));
console.log(`  ${byMaterial.size} materials, ${images.size} textures, ${mb(before)} -> ${mb(after)}`);

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  quantizationVolume: 'mesh',
  quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify({
  model: '/models/petrol.glb',
  size: [+(LOT.x1 - LOT.x0).toFixed(2), +top.toFixed(2), +(LOT.z1 - LOT.z0).toFixed(2)],
  /** Where it came from, world XZ, so it can be found again. */
  source: [cx, cz],
  triangles: parts.reduce((a, q) => a + q.idx.length / 3, 0),
}, null, 2)}\n`);
console.log(`  wrote ${DST} (${mb(readFileSync(DST).byteLength)})`);
