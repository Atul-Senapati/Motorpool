/**
 * Turns the dropped Nakamura Firehawk GP into a drivable motorbike.
 *
 *     npm run prepare:motorbike
 *
 * `nakamura_firehawk_gp.glb`: a GP sports bike, already in metres, nose to +X,
 * with its rider stood beside it in a T-pose (the tall part, arms out along
 * ±Z, and a separate helmet). Nothing is skinned and nothing is animated.
 *
 * What this does:
 *
 *   facing −Z    the game's forward: a quarter turn about Y, (x, y, z) →
 *                (z, y, −x).
 *   origin       on the ground, midway between the axles.
 *   apart        the parts that move are their own nodes, each with its
 *                vertices about its own pivot:
 *                  `wheelRear`   about the rear axle
 *                  `steer`       fork, bars and front brake, about the
 *                                steering head — the rake is measured off
 *                                the fork itself (its long axis) and
 *                                written to the data file, so the game
 *                                turns the front end about the real axis
 *                  `wheelFront`  about the front axle, in the bike's frame
 *                                (the game hangs it off `steer`)
 *                  `rider`, `helmet`   the T-posed rider, in the bike's
 *                                frame; the game rigs and poses him
 *                                (`motoRider`)
 *   materials    kept as authored — base colour, metal, roughness, blend —
 *                not flattened: a GP bike's paint is most of what it is.
 *                Textures WebP, meshes Draco.
 *
 * What comes out: `public/models/garage/firehawk.glb` and
 * `src/config/motorbikeData.json`.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('nakamura_firehawk_gp.glb');
const DST = 'public/models/garage/firehawk.glb';
const DATA = 'src/config/motorbikeData.json';
const TEXTURE_SIZE = 1024;

/** Source part (the node above the meshes) → which output node it joins. */
const PARTS = {
  '2E_20_6E_77.001_1': 'wheelRear',
  '2E_20_6E_77_33': 'wheelFront',
  '30_4F_68_B6_3': 'rider',
  BF_FA_8E_80_27: 'steer',
  '57_A9_2E_89_29': 'steer',
  EB_A6_0C_22_19: 'steer',
  '66_7A_96_F2_11': 'steer',
  '41_55_EC_E0_15': 'steer',
};
/** The helmet is the rider's smaller mesh. */
const HELMET_MESH = 'Object_9';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

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
/** Source world → game frame: nose from +X to −Z. */
const turn = ([x, y, z]) => [z, y, -x];

/** A mesh node's primitives, baked into the game frame. */
function bake(node) {
  const out = [];
  const world = node.getWorldMatrix();
  for (const prim of node.getMesh().listPrimitives()) {
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
      p.set(turn(mul(world, v)), i * 3);
      if (nrm) {
        nrm.getElement(i, v);
        const d = turn(mulDir(world, v));
        const len = Math.hypot(...d) || 1;
        n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
      }
      if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
    }
    const indices = idx
      ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
      : Uint32Array.from({ length: count }, (_, i) => i);
    out.push({ pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial() });
  }
  return out;
}

const bounds = (parts) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let i = 0; i < part.pos.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], part.pos[i + k]);
    hi[k] = Math.max(hi[k], part.pos[i + k]);
  }
  return { lo, hi, centre: lo.map((v, k) => (v + hi[k]) / 2) };
};
const shift = (parts, d) => {
  for (const part of parts) for (let i = 0; i < part.pos.length; i += 3) for (let k = 0; k < 3; k++) part.pos[i + k] += d[k];
};

/* ----------------------------------------------------------------- read */

const doc = await io.read(SRC);
const groups = { body: [], wheelRear: [], wheelFront: [], steer: [], rider: [], helmet: [] };
for (const node of doc.getRoot().listNodes()) {
  if (!node.getMesh()) continue;
  // The part is the mesh's grandparent-or-parent with a name in PARTS.
  let part = null;
  for (let p = node; p && !part; p = p.getParentNode?.() ?? null) part = PARTS[p.getName()] ?? null;
  const target = node.getName() === HELMET_MESH ? 'helmet' : part ?? 'body';
  groups[target].push(...bake(node));
}

// Origin: on the ground, midway between the axles, centred across.
const rearBox = bounds(groups.wheelRear);
const frontBox = bounds(groups.wheelFront);
const ground = Math.min(rearBox.lo[1], frontBox.lo[1]);
const origin = [
  (rearBox.centre[0] + frontBox.centre[0]) / 2,
  ground,
  (rearBox.centre[2] + frontBox.centre[2]) / 2,
];
for (const g of Object.values(groups)) shift(g, origin.map((v) => -v));

const rearAxle = bounds(groups.wheelRear).centre;
const frontAxle = bounds(groups.wheelFront).centre;
const wheelRadius = {
  rear: (bounds(groups.wheelRear).hi[1] - bounds(groups.wheelRear).lo[1]) / 2,
  front: (bounds(groups.wheelFront).hi[1] - bounds(groups.wheelFront).lo[1]) / 2,
};

/*
 * The steering axis, from the fork: the long axis of the fork's vertices
 * (power iteration on their covariance), pointing up. Then the head — where
 * the axis passes the top of the steering parts — is the pivot.
 */
const forkParts = groups.steer;
const pts = [];
for (const part of forkParts) for (let i = 0; i < part.pos.length; i += 3) pts.push([part.pos[i], part.pos[i + 1], part.pos[i + 2]]);
// Only the fork legs, below the bars: the bars' width would swing the axis sideways.
const legs = pts.filter((p) => Math.abs(p[0]) < 0.16 && p[1] < frontAxle[1] + 0.55);
const mean = [0, 1, 2].map((k) => legs.reduce((s, p) => s + p[k], 0) / legs.length);
const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (const p of legs) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (p[i] - mean[i]) * (p[j] - mean[j]);
let axis = [0, 1, 0];
for (let it = 0; it < 200; it++) {
  const m = [0, 1, 2].map((i) => C[i][0] * axis[0] + C[i][1] * axis[1] + C[i][2] * axis[2]);
  const len = Math.hypot(...m);
  axis = m.map((v) => v / len);
}
if (axis[1] < 0) axis = axis.map((v) => -v);
axis[0] = 0; // symmetric bike: no sideways tilt
{ const len = Math.hypot(...axis); axis = axis.map((v) => v / len); }
// The head: on the axis line through the fork's centroid, at the top of the fork.
const steerTop = bounds(groups.steer).hi[1];
const headY = Math.min(steerTop, frontAxle[1] + 0.75);
const tHead = (headY - mean[1]) / axis[1];
const head = [0, headY, mean[2] + axis[2] * tHead];
const rake = Math.atan2(-axis[2], axis[1]);
console.log(`rake ${(rake * 180 / Math.PI).toFixed(1)}°, head ${head.map((v) => v.toFixed(3))}, trail-ish ${(frontAxle[2] - (head[2] + axis[2] / axis[1] * -head[1])).toFixed(3)}`);

// Every moving part about its own pivot.
shift(groups.wheelRear, rearAxle.map((v) => -v));
shift(groups.wheelFront, frontAxle.map((v) => -v));
shift(groups.steer, head.map((v) => -v));

const riderBox = bounds([...groups.rider, ...groups.helmet]);
const bodyBox = bounds(groups.body);

/* ---------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('firehawk');
const materials = new Map();
async function convert(src) {
  if (materials.has(src)) return materials.get(src);
  const name = src?.getName() || 'part';
  const m = out.createMaterial(name)
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.6)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE')
    .setDoubleSided(src?.getDoubleSided() ?? false);
  // Glass that was transmission: plain blend at its own alpha, and a little rough.
  if (src?.listExtensions().some((e) => e.extensionName === 'KHR_materials_transmission')) {
    m.setAlphaMode('BLEND').setBaseColorFactor([0.75, 0.8, 0.85, 0.3]).setRoughnessFactor(0.05);
  }
  const tex = src?.getBaseColorTexture();
  if (tex) {
    const webp = await sharp(Buffer.from(tex.getImage()))
      .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 }).toBuffer();
    m.setBaseColorTexture(out.createTexture(name).setImage(webp).setMimeType('image/webp'));
  }
  materials.set(src, m);
  return m;
}
let triangles = 0;
async function node(name, parts, translation = [0, 0, 0]) {
  const mesh = out.createMesh(name);
  for (const part of parts) {
    const prim = out.createPrimitive();
    prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(part.pos).setBuffer(buffer));
    if (part.nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(part.nrm).setBuffer(buffer));
    if (part.uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(part.uv).setBuffer(buffer));
    prim.setIndices(out.createAccessor().setType('SCALAR').setArray(part.idx).setBuffer(buffer));
    prim.setMaterial(await convert(part.material));
    mesh.addPrimitive(prim);
    triangles += part.idx.length / 3;
  }
  return out.createNode(name).setMesh(mesh).setTranslation(translation);
}
const root = out.createNode('firehawk');
scene.addChild(root);
root.addChild(await node('body', groups.body));
root.addChild(await node('wheelRear', groups.wheelRear, rearAxle));
root.addChild(await node('steer', groups.steer, head));
root.addChild(await node('wheelFront', groups.wheelFront, frontAxle));
root.addChild(await node('rider', groups.rider));
root.addChild(await node('helmet', groups.helmet));
out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);

const r3 = (v) => v.map((x) => +x.toFixed(4));
const data = {
  size: r3([bodyBox.hi[0] - bodyBox.lo[0], bodyBox.hi[1] - bodyBox.lo[1], bodyBox.hi[2] - bodyBox.lo[2]]),
  bodyBounds: { lo: r3(bodyBox.lo), hi: r3(bodyBox.hi) },
  rearAxle: r3(rearAxle),
  frontAxle: r3(frontAxle),
  wheelRadius: { rear: +wheelRadius.rear.toFixed(4), front: +wheelRadius.front.toFixed(4) },
  wheelbase: +(rearAxle[2] - frontAxle[2]).toFixed(4),
  steerHead: r3(head),
  steerAxis: r3(axis),
  riderBounds: { lo: r3(riderBox.lo), hi: r3(riderBox.hi) },
  triangles,
};
writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
console.log(`${triangles} tris → ${DST}`, data);
