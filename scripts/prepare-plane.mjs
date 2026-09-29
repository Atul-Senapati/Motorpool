/**
 * Turns the dropped 747 into the airliner that flies the city.
 *
 *     npm run prepare:plane
 *
 * The source is a Sketchfab VC-25A — 110 nodes, 25 materials, 33 k triangles,
 * and no animation channels. What makes it worth the trouble is that it is
 * built in *named parts*: four engines, a nose gear and a main gear, thrust
 * reversers, and — the useful one — both the OPEN and the CLOSED positions of
 * every gear door. So the aeroplane can put its wheels away in flight without
 * anything here having to animate a hinge.
 *
 * This pass does what the other prepare scripts do:
 *
 *   metres       scaled so the fuselage is `LENGTH` nose to tail
 *   centred      on X and Z, so it yaws about itself
 *   grounded     y = 0 is the bottom of the wheels, so the game's altitude is
 *                the height of the tyres and putting it on a runway is one
 *                number rather than a measured offset
 *   facing −Z    the game's forward, which every other vehicle here uses. The
 *                source has the nose at +Z — the windshield, the nose gear and
 *                the radome are all at the +Z end and the fin is at −Z — so
 *                this is a flat 180 degrees
 *
 * ...and one thing they do not: it sorts the parts into four meshes rather
 * than merging the lot, so the game can switch between gear down and gear up.
 *
 * ## The four meshes
 *
 *   body        everything always visible: fuselage, wings, engines, fin
 *   gear        the legs and bogies, drawn only when the wheels are out
 *   doorsOpen   the door leaves in their open position, with the gear
 *   doorsShut   the belly panels that close over the bays, without it
 *
 * The classification is by name and is listed below rather than inferred,
 * because a wrong guess here is a 747 flying with its bay doors hanging open
 * and there is no way to tell from geometry alone which of `CoversClosed` and
 * `MLGCovers` is the one that moves.
 *
 * ## What comes out
 *
 *   public/models/plane.glb     four meshes, Draco-compressed
 *   src/config/planeData.json   size, triangles, and where the wheels are
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('air_force_one_-_boeing_747_vc-25ab.glb');
const DST = 'public/models/plane.glb';
const DATA = 'src/config/planeData.json';
/**
 * Nose to tail, metres. A VC-25A is a 747-200B: 70.66 m long, 59.64 m span.
 * Scaled on LENGTH rather than span because the length is what reads against
 * an 840 m runway, and because the source's wings carry a little more
 * overhang than the real aeroplane's.
 */
const LENGTH = 70.66;
const TEXTURE_SIZE = 1024;

/** Which mesh each named part belongs to. Anything unlisted goes in the body. */
const GEAR = /^(LGFront|LGBack|LGBackBack)_/;
const DOORS_OPEN = /^(CoversFrontOpen|CoverOpen)_/;
const DOORS_SHUT = /^(CoversFrontClosed|CoversClosed)_/;

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

/**
 * Every primitive in world space, tagged with the NAMED ancestor it belongs
 * to. The meshes themselves are called `Object_11` and so on; the name that
 * means something is the parent's, which is how the source is organised.
 */
const named = (node) => {
  for (let n = node; n; n = n.getParentNode()) {
    const name = n.getName();
    if (name && !/^Object_\d+$/.test(name)) return name;
  }
  return node.getName();
};

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
    parts.push({
      name: named(node),
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

const boundsOf = (arrays) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of arrays) for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]);
    max[k] = Math.max(max[k], p[i + k]);
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};

/* --------------------------------------- one frame: scale, turn, ground */

const whole = boundsOf(parts.map((p) => p.pos));
const scale = LENGTH / whole.size[2];
// Nose at +Z in the source, forward is −Z here: a flat half turn.
const frame = (x, y, z) => [
  -(x - whole.centre[0]) * scale,
  (y - whole.min[1]) * scale,
  -(z - whole.centre[2]) * scale,
];
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    part.pos.set(frame(part.pos[i], part.pos[i + 1], part.pos[i + 2]), i);
  }
  for (let i = 0; i < part.nrm.length; i += 3) {
    part.nrm[i] = -part.nrm[i];
    part.nrm[i + 2] = -part.nrm[i + 2];
  }
  part.bounds = boundsOf([part.pos]);
}
const framed = boundsOf(parts.map((p) => p.pos));
console.log(`airframe ${framed.size.map((v) => v.toFixed(2)).join(' x ')} m (span x height x length), scale ${scale.toFixed(3)}`);

/* ------------------------------------------------------- the four meshes */

const groupOf = (name) => (GEAR.test(name) ? 'gear'
  : DOORS_OPEN.test(name) ? 'doorsOpen'
    : DOORS_SHUT.test(name) ? 'doorsShut' : 'body');
const groups = { body: [], gear: [], doorsOpen: [], doorsShut: [] };
for (const part of parts) groups[groupOf(part.name)].push(part);
for (const [name, list] of Object.entries(groups)) {
  const tris = list.reduce((n, p) => n + p.idx.length / 3, 0);
  console.log(`  ${name.padEnd(10)} ${String(Math.round(tris)).padStart(6)} tris  ${[...new Set(list.map((p) => p.name))].join(', ') || '(none)'}`);
}

/**
 * Where the wheels touch, measured rather than assumed.
 *
 * `y = 0` is already the lowest point of the aeroplane, which is the tyres —
 * but the game also wants to know how far back the MAIN gear is, because that
 * is the pivot a 747 rotates about on take-off and the point that touches
 * first on landing. Taken from the main legs' own footprint.
 */
const mains = groups.gear.filter((p) => /^LGBack/.test(p.name));
const nose = groups.gear.filter((p) => /^LGFront/.test(p.name));
const mainZ = mains.length ? boundsOf(mains.map((p) => p.pos)).centre[2] : 0;
const noseZ = nose.length ? boundsOf(nose.map((p) => p.pos)).centre[2] : 0;
console.log(`main gear at z ${mainZ.toFixed(2)} m, nose gear at z ${noseZ.toFixed(2)} m`);

/* ---------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('plane');

const textures = new Map();
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(image)) return textures.get(image);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(image, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src) => {
  if (materials.has(src)) return materials.get(src);
  const m = out.createMaterial(src?.getName() || 'plane')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0.3)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.45)
    .setDoubleSided(false)
    // OPAQUE throughout: the source marks the cabin glass BLEND, and a
    // transparent surface on something that crosses the whole sky sorts
    // against every building it passes behind.
    .setAlphaMode('OPAQUE');
  const tex = await convertTexture(src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  const em = await convertTexture(src?.getEmissiveTexture());
  if (em) { m.setEmissiveTexture(em); m.setEmissiveFactor(src.getEmissiveFactor()); }
  materials.set(src, m);
  return m;
};

const primitiveOf = async (part) => {
  const prim = out.createPrimitive();
  prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(part.pos).setBuffer(buffer));
  if (part.nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(part.nrm).setBuffer(buffer));
  if (part.uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(part.uv).setBuffer(buffer));
  prim.setIndices(out.createAccessor().setType('SCALAR').setArray(part.idx).setBuffer(buffer));
  prim.setMaterial(await convertMaterial(part.material));
  return prim;
};

let triangles = 0;
for (const [name, list] of Object.entries(groups)) {
  if (!list.length) continue;
  const mesh = out.createMesh(name);
  for (const part of list) { mesh.addPrimitive(await primitiveOf(part)); triangles += part.idx.length / 3; }
  scene.addChild(out.createNode(name).setMesh(mesh));
}

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({
  size: framed.size.map((v) => +v.toFixed(3)),
  triangles,
  mainGearZ: +mainZ.toFixed(3),
  noseGearZ: +noseZ.toFixed(3),
}, null, 2) + '\n');
console.log(`wrote ${DST} and ${DATA}: ${triangles} triangles in ${Object.values(groups).filter((g) => g.length).length} meshes`);
