/**
 * Turns the dropped quadcopter into the game's drone.
 *
 *     npm run prepare:drone
 *
 * The source is a Sketchfab export: 38 nodes of Maya `polySurfaceN` under two
 * nested scale/rotation fixes, one material, four textures, and — despite the
 * name it arrived under — no animation channels at all. So this pass does what
 * the other prepare scripts do (one convention, baked flat) plus one thing
 * they do not: it *finds the motor hubs*, so the game can spin prop discs there.
 *
 *   metres       scaled so the airframe spans `SPAN` across, motor to motor —
 *                a heavy-lift quad, big enough to read against a city block
 *   centred      on X and Z, so it yaws about itself
 *   grounded     y = 0 is the bottom of the skids, so "altitude" in the game
 *                is the height of the drone's feet
 *   facing −Z    the game's forward. Which way a quad faces is not obvious
 *                from its arms, which are symmetric; it is obvious from the
 *                CAMERA, which hangs under the nose. The two `pSphere` parts
 *                are the gimbal, and the nose is where they are.
 *
 * ## Finding the rotors
 *
 * The export has no propeller meshes — the blades are welded into the arm
 * parts — but each arm ends in a separate 6 cm motor cap. Those four caps are
 * found (thin, tiny, far from the centre), and their positions plus the arm
 * footprint go into the data file; `DroneRide` draws a spinning prop-blur disc
 * over each. If four are not found the script warns.
 *
 * ## What comes out
 *
 *   public/models/drone.glb     the airframe, Draco-compressed, rotors as nodes
 *   src/config/droneData.json   size, triangles, the rotor positions
 */
import { Document, NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('drone.glb');
const DST = 'public/models/drone.glb';
const DATA = 'src/config/droneData.json';
/** Motor-to-motor span across X, metres. */
const SPAN = 1.4;
const TEXTURE_SIZE = 1024;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(SRC);
const root = doc.getRoot();

/* ------------------------------------------------------------- bake parts */

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

/** Every primitive, in world space: positions, normals, uvs, indices. */
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
      const w = mul(world, v);
      p.set(w, i * 3);
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
    parts.push({ name: node.getName(), pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial() });
  }
}

const boundsOf = (arrays) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of arrays) for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]);
    max[k] = Math.max(max[k], p[i + k]);
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};

/* ------------------------------------------------ one frame: scale, face, ground */

const whole = boundsOf(parts.map((p) => p.pos));
const scale = SPAN / whole.size[0];

// The nose is where the camera gimbal is.
const gimbal = parts.filter((p) => /pSphere/i.test(p.name));
const gimbalCentre = gimbal.length ? boundsOf(gimbal.map((p) => p.pos)).centre : null;
let yaw = 0;
if (gimbalCentre) {
  const dx = gimbalCentre[0] - whole.centre[0];
  const dz = gimbalCentre[2] - whole.centre[2];
  // Rotate so that (dx, dz) lands on (0, -1).
  yaw = Math.atan2(dx, -dz) * -1;
  console.log(`gimbal is ${Math.hypot(dx, dz).toFixed(3)} m from centre at ${(Math.atan2(dx, -dz) * 180 / Math.PI).toFixed(0)}°; yawing ${(yaw * 180 / Math.PI).toFixed(0)}°`);
} else {
  console.log('no gimbal spheres found; keeping the source heading');
}
const cy = Math.cos(yaw);
const sy = Math.sin(yaw);
const frame = (x, y, z) => {
  const lx = (x - whole.centre[0]) * scale;
  const lz = (z - whole.centre[2]) * scale;
  const ly = (y - whole.min[1]) * scale;
  return [lx * cy + lz * sy, ly, -lx * sy + lz * cy];
};
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    part.pos.set(frame(part.pos[i], part.pos[i + 1], part.pos[i + 2]), i);
  }
  for (let i = 0; i < part.nrm.length; i += 3) {
    const x = part.nrm[i]; const z = part.nrm[i + 2];
    part.nrm[i] = x * cy + z * sy;
    part.nrm[i + 2] = -x * sy + z * cy;
  }
  part.bounds = boundsOf([part.pos]);
}
const framed = boundsOf(parts.map((p) => p.pos));
console.log(`airframe ${framed.size.map((v) => v.toFixed(3)).join(' × ')} m (W × H × L)`);
if (process.argv.includes('--parts')) {
  for (const p of parts) {
    console.log(`  ${p.name.padEnd(28)} size ${p.bounds.size.map((v) => v.toFixed(3)).join('×')}  centre ${p.bounds.centre.map((v) => v.toFixed(3)).join(',')}  tris ${p.idx.length / 3}`);
  }
}

/* -------------------------------------------------------------- rotors */

/*
 * There are no separate propeller meshes in this export — the blades are
 * baked into the four arm parts (0.6 × 0.45 m each, one per corner). What IS
 * separate is the motor cap on each arm: a 6 cm disc, 4 mm thick, at the far
 * end. Those four give the hub positions, and the game draws a spinning
 * prop-blur disc over each one rather than trying to spin geometry that is
 * welded to its arm. The disc's radius is taken from the arm's own footprint.
 */
const hubs = parts
  .filter((p) => p.bounds.size[1] < 0.02 && Math.max(p.bounds.size[0], p.bounds.size[2]) < SPAN * 0.08)
  .map((p) => ({ part: p, reach: Math.hypot(p.bounds.centre[0], p.bounds.centre[2]) }))
  .sort((a, b) => b.reach - a.reach)
  .slice(0, 4);
const arms = parts.filter((p) => Math.max(p.bounds.size[0], p.bounds.size[2]) > SPAN * 0.3
  && Math.hypot(p.bounds.centre[0], p.bounds.centre[2]) > SPAN * 0.25);
const armTop = arms.length ? Math.max(...arms.map((p) => p.bounds.max[1])) : framed.max[1];
const rotorRadius = arms.length ? Math.min(...arms.map((p) => Math.min(p.bounds.size[0], p.bounds.size[2]))) / 2 : SPAN * 0.16;
const rotorData = hubs.map(({ part }) => ({
  position: [part.bounds.centre[0], armTop + 0.01, part.bounds.centre[2]].map((v) => +v.toFixed(4)),
}));
if (rotorData.length < 4) console.warn(`only ${rotorData.length} motor hubs found`);
for (const r of rotorData) console.log(`rotor hub at [${r.position.join(', ')}], blur radius ${rotorRadius.toFixed(3)}`);
const rotorSet = new Set();

/* ---------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('drone');
const airframe = out.createNode('drone');
scene.addChild(airframe);

const textures = new Map();
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(image)) return textures.get(image);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(image, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src) => {
  if (materials.has(src)) return materials.get(src);
  const m = out.createMaterial(src?.getName() || 'drone')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0.2)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.6)
    .setDoubleSided(true)
    // The source is BLEND, which sorts badly against the city; a cutout gives
    // the rotor discs their transparency without the sorting.
    .setAlphaMode('MASK').setAlphaCutoff(0.4);
  const tex = await convertTexture(src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  const em = await convertTexture(src?.getEmissiveTexture());
  if (em) { m.setEmissiveTexture(em); m.setEmissiveFactor(src.getEmissiveFactor()); }
  materials.set(src, m);
  return m;
};

const primitiveOf = async (part, offset) => {
  const pos = new Float32Array(part.pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = part.pos[i] - offset[0];
    pos[i + 1] = part.pos[i + 1] - offset[1];
    pos[i + 2] = part.pos[i + 2] - offset[2];
  }
  const prim = out.createPrimitive();
  prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer));
  if (part.nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(part.nrm).setBuffer(buffer));
  if (part.uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(part.uv).setBuffer(buffer));
  prim.setIndices(out.createAccessor().setType('SCALAR').setArray(part.idx).setBuffer(buffer));
  prim.setMaterial(await convertMaterial(part.material));
  return prim;
};

const body = out.createMesh('body');
for (const part of parts) {
  if (rotorSet.has(part)) continue;
  body.addPrimitive(await primitiveOf(part, [0, 0, 0]));
}
airframe.setMesh(body);

let triangles = 0;
for (const part of parts) triangles += part.idx.length / 3;

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({
  size: framed.size.map((v) => +v.toFixed(4)),
  triangles,
  rotors: rotorData,
  rotorRadius: +rotorRadius.toFixed(4),
}, null, 2) + '\n');
console.log(`wrote ${DST} and ${DATA}: ${triangles} triangles, ${rotorData.length} rotors`);
