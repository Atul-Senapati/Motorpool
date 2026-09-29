/**
 * Turns the two dropped bikers into the Wall of Death's riders.
 *
 *     npm run prepare:bikers
 *
 * Two Sketchfab exports — `low_poly_male_biker.glb` and
 * `low_poly_female_biker.glb` — that turn out to be the SAME motorcycle with
 * a different rider sat on it: identical frame (7,683 triangles, one
 * material) and identical wheels (two separate 1,152-triangle meshes at the
 * same two axles). Already in metres, already on the ground, already centred
 * on X. What they are not is facing the game's way or spinnable, so this
 * pass does to them what every other prepare script does to its download:
 *
 *   facing −Z    the game's forward. The rider sits over the rear wheel and
 *                leans toward the front, and in the source the rider is at
 *                the −Z end — so the front is +Z and the whole thing is yawed
 *                180°.
 *   centred      on the bike's own footprint, X and Z, so it turns about
 *                itself; y = 0 stays the tyre contact.
 *   wheels apart the two wheel meshes become their own nodes, each with its
 *                vertices moved to its own axle, so `rotation.x` spins a
 *                wheel about its hub instead of swinging it round the origin.
 *
 * ## What comes out
 *
 *   public/models/bikers.glb     one scene, two root nodes `male` and
 *                                `female`, each with `body`, `wheelFront`
 *                                and `wheelRear` children
 *   src/config/bikerData.json    size, wheel radius and axle positions, and
 *                                the triangle count, per rider
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SOURCES = {
  male: 'low_poly_male_biker.glb',
  female: 'low_poly_female_biker.glb',
};
const DST = 'public/models/bikers.glb';
const DATA = 'src/config/bikerData.json';
const TEXTURE_SIZE = 1024;
/** The source has the front at +Z; the game's forward is −Z. */
const YAW = Math.PI;

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
const boundsOf = (arrays) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of arrays) for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]);
    max[k] = Math.max(max[k], p[i + k]);
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};

/** Every primitive of a file, baked to world space and then into the game's frame. */
async function readParts(file) {
  const doc = await io.read(source(file));
  const parts = [];
  for (const node of doc.getRoot().listNodes()) {
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
      parts.push({ name: node.getName(), pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial() });
    }
  }
  // The frame: centre on the whole bike's footprint, keep the ground, yaw round.
  const whole = boundsOf(parts.map((p) => p.pos));
  const cy = Math.cos(YAW);
  const sy = Math.sin(YAW);
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      const lx = part.pos[i] - whole.centre[0];
      const ly = part.pos[i + 1] - whole.min[1];
      const lz = part.pos[i + 2] - whole.centre[2];
      part.pos[i] = lx * cy + lz * sy;
      part.pos[i + 1] = ly;
      part.pos[i + 2] = -lx * sy + lz * cy;
    }
    for (let i = 0; i < part.nrm.length; i += 3) {
      const x = part.nrm[i]; const z = part.nrm[i + 2];
      part.nrm[i] = x * cy + z * sy;
      part.nrm[i + 2] = -x * sy + z * cy;
    }
    part.bounds = boundsOf([part.pos]);
  }
  return parts;
}

/**
 * A wheel is a part that is round in the YZ plane and thin in X, with its
 * bottom on the ground. Both files have exactly two.
 */
const isWheel = (p) => {
  const [w, h, d] = p.bounds.size;
  return w < 0.2 && Math.abs(h - d) < 0.03 && p.bounds.min[1] < 0.05 && h > 0.4;
};

/* ---------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('bikers');

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
const convertMaterial = async (src, who) => {
  const key = `${who}|${src?.getName()}`;
  if (materials.has(key)) return materials.get(key);
  const m = out.createMaterial(`${who}_${src?.getName() || 'material'}`)
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0.2)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.7);
  const tex = await convertTexture(src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  materials.set(key, m);
  return m;
};
const primitiveOf = async (part, offset, who) => {
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
  prim.setMaterial(await convertMaterial(part.material, who));
  return prim;
};

const data = {};
for (const [who, file] of Object.entries(SOURCES)) {
  const parts = await readParts(file);
  const wheels = parts.filter(isWheel).sort((a, b) => a.bounds.centre[2] - b.bounds.centre[2]);
  if (wheels.length !== 2) throw new Error(`${file}: expected two wheels, found ${wheels.length}`);
  // Facing −Z, the front wheel is the one with the smaller Z.
  const [front, rear] = wheels;
  const rider = out.createNode(who);
  scene.addChild(rider);

  const body = out.createMesh(`${who}_body`);
  let triangles = 0;
  for (const part of parts) {
    triangles += part.idx.length / 3;
    if (wheels.includes(part)) continue;
    body.addPrimitive(await primitiveOf(part, [0, 0, 0], who));
  }
  rider.addChild(out.createNode('body').setMesh(body));
  for (const [name, wheel] of [['wheelFront', front], ['wheelRear', rear]]) {
    const c = wheel.bounds.centre;
    const mesh = out.createMesh(`${who}_${name}`);
    mesh.addPrimitive(await primitiveOf(wheel, c, who));
    rider.addChild(out.createNode(name).setMesh(mesh).setTranslation(c));
  }
  const whole = boundsOf(parts.map((p) => p.pos));
  data[who] = {
    size: whole.size.map((v) => +v.toFixed(4)),
    wheelRadius: +(front.bounds.size[1] / 2).toFixed(4),
    wheels: {
      front: front.bounds.centre.map((v) => +v.toFixed(4)),
      rear: rear.bounds.centre.map((v) => +v.toFixed(4)),
    },
    triangles,
  };
  console.log(`${who}: ${whole.size.map((v) => v.toFixed(2)).join(' × ')} m, ${triangles} tris, `
    + `wheels r ${data[who].wheelRadius} at z ${front.bounds.centre[2].toFixed(2)} / ${rear.bounds.centre[2].toFixed(2)}`);
}

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
console.log(`wrote ${DST} and ${DATA}`);
