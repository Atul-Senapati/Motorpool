/**
 * Turns the dropped stage into Kestrel Beach's stage.
 *
 *     npm run prepare:beach-stage
 *
 * `stage_4.glb`: a 19 × 9 m concert stage, 1,173 triangles in nine parts and
 * six plain-colour materials, no textures — a black deck (`lantai`) with gold
 * trim, a light strip along its front (`light`), a raised riser at the back
 * lit underneath (`light_yellow`), a black backdrop and a white screen panel
 * on it (`Material`). The front faces +Z.
 *
 * This pass bakes the node transforms, merges the parts into one mesh per
 * material (six draw calls), puts the deck's foot on y = 0 and centres it on
 * X, and names each mesh after its material so `KestrelStage` can light the
 * strips and turn the screen panel into an LED wall. Draco.
 *
 * What comes out: `public/models/beachStage.glb` and
 * `src/config/beachStageData.json` with its size.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('stage_4.glb');
const DST = 'public/models/beachStage.glb';
const DATA = 'src/config/beachStageData.json';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(SRC);

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

/** Material name → its parts' positions, normals and indices, baked. */
const byMaterial = new Map();
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const world = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const name = prim.getMaterial()?.getName() || 'stage';
    const entry = byMaterial.get(name) ?? { pos: [], nrm: [], idx: [], colour: prim.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1] };
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    const base = entry.pos.length / 3;
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      entry.pos.push(...mul(world, v));
      if (nrm) {
        nrm.getElement(i, v);
        const d = mulDir(world, v);
        const len = Math.hypot(...d) || 1;
        entry.nrm.push(d[0] / len, d[1] / len, d[2] / len);
      } else {
        entry.nrm.push(0, 1, 0);
      }
    }
    const idx = prim.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    for (let i = 0; i < n; i++) entry.idx.push(base + (idx ? idx.getScalar(i) : i));
    byMaterial.set(name, entry);
  }
}

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const e of byMaterial.values()) for (let i = 0; i < e.pos.length; i += 3) for (let k = 0; k < 3; k++) {
  min[k] = Math.min(min[k], e.pos[i + k]);
  max[k] = Math.max(max[k], e.pos[i + k]);
}
const cx = (min[0] + max[0]) / 2;
for (const e of byMaterial.values()) {
  for (let i = 0; i < e.pos.length; i += 3) {
    e.pos[i] -= cx;
    e.pos[i + 1] -= min[1];
  }
}

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('stage');
let triangles = 0;
for (const [name, e] of byMaterial) {
  const material = out.createMaterial(name).setBaseColorFactor(e.colour).setMetallicFactor(name === 'gold' ? 0.8 : 0)
    .setRoughnessFactor(name === 'gold' ? 0.35 : 0.7);
  const prim = out.createPrimitive()
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(e.pos)).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(e.nrm)).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(e.idx)).setBuffer(buffer))
    .setMaterial(material);
  scene.addChild(out.createNode(name).setMesh(out.createMesh(name).addPrimitive(prim)));
  triangles += e.idx.length / 3;
}
out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => +v.toFixed(3));
writeFileSync(DATA, JSON.stringify({ size, front: +max[2].toFixed(3), back: +min[2].toFixed(3), triangles }, null, 2) + '\n');
console.log(`stage ${size.join(' × ')} m, ${triangles} tris, ${byMaterial.size} materials → ${DST}`);
