/**
 * Lifts three commercial vehicles out of the city model for the station car park.
 *
 *     npm run prepare:trucks
 *
 * The city has lorries, but only as scenery baked into its chunks: a Mercedes
 * box truck (`deco_MercedesTruck_*`, four meshes) and one articulated lorry
 * that is the whole of `deco_special_vehicles_texture_0_-2`. (The Peterbilt
 * meshes measure 6.5 × 16.6 m — more than one vehicle merged — so they are
 * left; so is `deco_container1`, which is every container in the city in one
 * mesh, 370 m end to end.) Each is baked flat out of its world transform, turned so its length
 * runs along +Z (measured, from the footprint's principal axis), centred on its
 * footprint and set on y = 0, and written into a NEW document with only its own
 * geometry and materials — disposing the rest of the city in place left 150 MB
 * of it behind. Textures stay the city's own images, so they look like the
 * traffic they were.
 *
 * What comes out: `public/models/trucks.glb`, one node per truck, and
 * `src/config/truckData.json` with each one's size.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptDecoder } from 'meshoptimizer';
import { writeFileSync } from 'node:fs';

const SRC = 'public/models/city.glb';
const DST = 'public/models/trucks.glb';
const DATA = 'src/config/truckData.json';
const TRUCKS = {
  boxTruck: /^deco_MercedesTruck_/,
  artic: /^deco_special_vehicles_texture_0_-2$/,
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'meshopt.decoder': MeshoptDecoder,
});
const doc = await io.read(SRC);
const root = doc.getRoot();
const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('trucks');
const data = {};
const apply = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
const applyDir = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];
const textures = new Map();
const materials = new Map();
const copyMaterial = (src) => {
  if (materials.has(src)) return materials.get(src);
  const m = out.createMaterial(src?.getName() || 'truck')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.8)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE');
  const t = src?.getBaseColorTexture();
  if (t?.getImage()) {
    if (!textures.has(t)) textures.set(t, out.createTexture(t.getName() || 'tex').setImage(t.getImage()).setMimeType(t.getMimeType()));
    m.setBaseColorTexture(textures.get(t));
  }
  materials.set(src, m);
  return m;
};
for (const [name, re] of Object.entries(TRUCKS)) {
  const nodes = root.listNodes().filter((n) => re.test(n.getName()) && n.getMesh());
  if (!nodes.length) throw new Error(`no nodes for ${name}`);
  const worlds = nodes.map((n) => ({ node: n, m: n.getWorldMatrix() }));
  const pts = [];
  for (const { node, m } of worlds) for (const p of node.getMesh().listPrimitives()) {
    const a = p.getAttribute('POSITION'); const v = [0, 0, 0];
    for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); pts.push(apply(m, v)); }
  }
  const cx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
  const cz = pts.reduce((sum, p) => sum + p[2], 0) / pts.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of pts) { const dx = p[0] - cx, dz = p[2] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  const axis = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const rot = Math.PI / 2 - axis;
  const c = Math.cos(rot), s = Math.sin(rot);
  const turn = (x, z) => [(x - cx) * c - (z - cz) * s, (x - cx) * s + (z - cz) * c];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) { const [x, z] = turn(p[0], p[2]); const q = [x, p[1], z]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); } }
  const mx = (lo[0] + hi[0]) / 2, mz = (lo[2] + hi[2]) / 2, base = lo[1];
  const mesh = out.createMesh(name);
  for (const { node, m } of worlds) {
    for (const p of node.getMesh().listPrimitives()) {
      const a = p.getAttribute('POSITION'); const nrm = p.getAttribute('NORMAL'); const uv = p.getAttribute('TEXCOORD_0'); const idx = p.getIndices();
      const v = [0, 0, 0];
      const pa = new Float32Array(a.getCount() * 3); const na = new Float32Array(a.getCount() * 3); const ua = uv ? new Float32Array(a.getCount() * 2) : null;
      for (let i = 0; i < a.getCount(); i++) {
        a.getElement(i, v); const w = apply(m, v); const [x, z] = turn(w[0], w[2]);
        pa.set([x - mx, w[1] - base, z - mz], i * 3);
        if (nrm) { nrm.getElement(i, v); const d = applyDir(m, v); const dx = d[0] * c - d[2] * s, dz = d[0] * s + d[2] * c; const l = Math.hypot(dx, d[1], dz) || 1; na.set([dx / l, d[1] / l, dz / l], i * 3); }
        else na.set([0, 1, 0], i * 3);
        if (ua) { uv.getElement(i, v); ua.set([v[0], v[1]], i * 2); }
      }
      const prim = out.createPrimitive()
        .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pa).setBuffer(buffer))
        .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(na).setBuffer(buffer))
        .setMaterial(copyMaterial(p.getMaterial()));
      if (ua) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(ua).setBuffer(buffer));
      const ix = idx ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i)) : Uint32Array.from({ length: a.getCount() }, (_, i) => i);
      prim.setIndices(out.createAccessor().setType('SCALAR').setArray(ix).setBuffer(buffer));
      mesh.addPrimitive(prim);
    }
  }
  scene.addChild(out.createNode(name).setMesh(mesh));
  data[name] = { size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((v) => +v.toFixed(2)) };
}
out.createExtension(KHRDracoMeshCompression).setRequired(true);
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
console.log(Object.entries(data).map(([k, v]) => `${k} ${v.size.join(' × ')}`).join('\n'));
