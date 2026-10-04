/**
 * Turns the dropped palm grove into the beach's palms.
 *
 *     npm run prepare:palms
 *
 * `realistic_palm_tree_low_poly.glb`: five palms in one file (about 1,250
 * triangles each), one alpha-masked material, exported unlit. Each palm is cut
 * out as its own node `palm0`…`palm4` so the beach can plant them as five
 * instanced variants: node transforms baked, the trunk's foot put on the
 * origin (not the bounding box's middle — the trunks lean, and a palm turned
 * about its crown would walk its foot round the sand), WebP texture, Draco.
 * The material is re-made lit, so the palms shade with the sun like the rest
 * of the world.
 *
 * What comes out: `public/models/beachPalms.glb` and
 * `src/config/beachPalmsData.json` with each palm's height.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('realistic_palm_tree_low_poly.glb');
const DST = 'public/models/beachPalms.glb';
const DATA = 'src/config/beachPalmsData.json';
/** The source is near true size already (7–10 m palms); a touch taller. */
const SCALE = 1.15;
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

const palms = [];
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
    const n = new Float32Array(count * 3);
    const t = new Float32Array(count * 2);
    const v = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      pos.getElement(i, v);
      p.set(mul(world, v), i * 3);
      nrm.getElement(i, v);
      const d = mulDir(world, v);
      const len = Math.hypot(...d) || 1;
      n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
      uv.getElement(i, v);
      t.set([v[0], v[1]], i * 2);
    }
    const indices = idx
      ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
      : Uint32Array.from({ length: count }, (_, i) => i);
    // The trunk's foot: the middle of everything within 30 cm of the ground.
    let fx = 0, fz = 0, fn = 0, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < p.length; i += 3) { minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]); }
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] < minY + 0.3) { fx += p[i]; fz += p[i + 2]; fn++; }
    }
    fx /= fn; fz /= fn;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = (p[i] - fx) * SCALE;
      p[i + 1] = (p[i + 1] - minY) * SCALE;
      p[i + 2] = (p[i + 2] - fz) * SCALE;
    }
    palms.push({ pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial(), height: (maxY - minY) * SCALE });
  }
}

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('palms');
const src = palms[0].material;
const image = src.getBaseColorTexture().getImage();
const webp = await sharp(Buffer.from(image))
  .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 90, alphaQuality: 100 }).toBuffer();
const texture = out.createTexture('palm').setImage(webp).setMimeType('image/webp');
const material = out.createMaterial('palm')
  .setBaseColorTexture(texture)
  .setAlphaMode('MASK')
  .setAlphaCutoff(0.4)
  .setDoubleSided(true)
  .setMetallicFactor(0)
  .setRoughnessFactor(0.85);

let triangles = 0;
palms.forEach((palm, i) => {
  const prim = out.createPrimitive();
  prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(palm.pos).setBuffer(buffer));
  prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(palm.nrm).setBuffer(buffer));
  prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(palm.uv).setBuffer(buffer));
  prim.setIndices(out.createAccessor().setType('SCALAR').setArray(palm.idx).setBuffer(buffer));
  prim.setMaterial(material);
  const mesh = out.createMesh(`palm${i}`).addPrimitive(prim);
  scene.addChild(out.createNode(`palm${i}`).setMesh(mesh));
  triangles += palm.idx.length / 3;
});
out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({ heights: palms.map((p) => +p.height.toFixed(2)), triangles }, null, 2) + '\n');
console.log(`${palms.length} palms, ${palms.map((p) => p.height.toFixed(1)).join(' / ')} m, ${triangles} tris → ${DST}`);
