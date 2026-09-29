/**
 * Turns the dropped panda into the park's statue.
 *
 *     npm run prepare:panda
 *
 * `cute_cartoon_panda_with_bamboo.glb`: one mesh, one material, 38,000
 * triangles, modelled about its own centre at 1.8 m tall. It stands where the
 * park's fountain was, so this pass does the usual: bakes the node transforms
 * flat, scales it to `HEIGHT`, puts its feet on y = 0 and centres it on X and
 * Z so it turns about itself, WebP textures, Draco.
 *
 * What comes out: `public/models/panda.glb`, one node `panda`, and
 * `src/config/pandaData.json` with its size.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('cute_cartoon_panda_with_bamboo.glb');
const DST = 'public/models/panda.glb';
const DATA = 'src/config/pandaData.json';
/** How tall the statue stands, metres. A big garden ornament, not a monument. */
const HEIGHT = 3.2;
const TEXTURE_SIZE = 1024;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
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
    const nrm = prim.getAttribute('NORMAL');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const count = pos.getCount();
    const p = new Float32Array(count * 3);
    const n = new Float32Array(nrm ? count * 3 : 0);
    const t = new Float32Array(uv ? count * 2 : 0);
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
    const indices = idx
      ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
      : Uint32Array.from({ length: count }, (_, i) => i);
    parts.push({ pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial() });
  }
}
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const part of parts) for (let i = 0; i < part.pos.length; i += 3) for (let k = 0; k < 3; k++) {
  min[k] = Math.min(min[k], part.pos[i + k]);
  max[k] = Math.max(max[k], part.pos[i + k]);
}
const scale = HEIGHT / (max[1] - min[1]);
const cx = (min[0] + max[0]) / 2;
const cz = (min[2] + max[2]) / 2;
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    part.pos[i] = (part.pos[i] - cx) * scale;
    part.pos[i + 1] = (part.pos[i + 1] - min[1]) * scale;
    part.pos[i + 2] = (part.pos[i + 2] - cz) * scale;
  }
}
const size = [(max[0] - min[0]) * scale, (max[1] - min[1]) * scale, (max[2] - min[2]) * scale];

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('panda');
const textures = new Map();
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(image)) return textures.get(image);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 }).toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(image, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src) => {
  if (materials.has(src)) return materials.get(src);
  const m = out.createMaterial(src?.getName() || 'panda')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.8);
  const tex = await convertTexture(src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  materials.set(src, m);
  return m;
};
const mesh = out.createMesh('panda');
let triangles = 0;
for (const part of parts) {
  const prim = out.createPrimitive();
  prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(part.pos).setBuffer(buffer));
  if (part.nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(part.nrm).setBuffer(buffer));
  if (part.uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(part.uv).setBuffer(buffer));
  prim.setIndices(out.createAccessor().setType('SCALAR').setArray(part.idx).setBuffer(buffer));
  prim.setMaterial(await convertMaterial(part.material));
  mesh.addPrimitive(prim);
  triangles += part.idx.length / 3;
}
scene.addChild(out.createNode('panda').setMesh(mesh));
out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({ size: size.map((v) => +v.toFixed(3)), triangles }, null, 2) + '\n');
console.log(`panda ${size.map((v) => v.toFixed(2)).join(' × ')} m, ${triangles} tris → ${DST}`);
