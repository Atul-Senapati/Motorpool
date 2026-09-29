/**
 * Turns the dropped EC135 into the game's helicopter.
 *
 *     npm run prepare:helicopter
 *
 * The source is a Sketchfab export of a rescue EC135: 75 nodes, a skinned rig,
 * two rescue pilots sitting in it, 201,260 triangles and 36 one-megapixel PNGs
 * — 33.8 MB of file for one aircraft. This pass does what the other prepare
 * scripts do (one convention, baked flat) and two things particular to it.
 *
 *   metres      scaled by the MAIN ROTOR, not the fuselage: the disc is the
 *               one dimension of a helicopter that is published to the
 *               centimetre (10.2 m on an EC135) and the one the eye measures
 *               the aircraft against. The 12.16 m length falls out of it.
 *   centred     on X, and on Z at the MAST rather than at the bounding box.
 *               A helicopter yaws about its rotor mast; an origin halfway
 *               down the tail boom would swing the nose through an arc it
 *               does not have.
 *   grounded    y = 0 is the bottom of the skids, so "altitude" is the height
 *               of the skids, as it is for the drone.
 *   facing −Z   the game's forward. Decided by the TAIL ROTOR: whichever end
 *               of the aircraft that sits at is aft, and the nose is opposite.
 *               (This export already faced −Z; the test is there so a
 *               re-export that does not cannot pass silently.)
 *
 * ## The rotors
 *
 * The source has a one-second rotation clip on two joints. It is not used.
 * A rotor that turns at a fixed rate whatever the aircraft is doing is a
 * decoration — what a game needs is a rotor that winds up from rest, sits at
 * idle and picks up when you pull power, which means the *code* owns the
 * angle. So both rotor meshes are lifted out as their own nodes, re-centred on
 * their own hubs, and tagged; `HelicopterRide` spins them. Each one's spin
 * axis is measured rather than assumed — a rotor is a thin disc, so the axis
 * is whichever of its dimensions is the small one.
 *
 * ## The budget
 *
 * Decimated per part rather than globally, because the source spends its
 * triangles absurdly: 34,614 on cockpit buttons and 86,000 on two human
 * figures who sit behind tinted glass, against 17,000 for the fuselage
 * everybody actually looks at. `SHARE` is that judgement, written down.
 *
 * ## What comes out
 *
 *   public/models/helicopter.glb     the aircraft, Draco-compressed
 *   src/config/helicopterData.json   size, triangles, the rotor hubs and axes
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('helicopter.glb');
const DST = 'public/models/helicopter.glb';
const DATA = 'src/config/helicopterData.json';

/** Main rotor diameter, metres. The EC135's published figure. */
const ROTOR_DIAMETER = 10.2;

/**
 * What share of each part's triangles to keep, by mesh name.
 *
 * First match wins. The rotors are held at 1 because they are thin blades
 * that a decimator turns into confetti, and they cost 2,368 triangles between
 * them anyway.
 */
const SHARE = [
  [/Rotor/i, 1],
  [/Glass/i, 1],
  [/CockpitButtons/i, 0.08],
  [/PilotSeat|BackSeats|Bed/i, 0.25],
  // The two rescue pilots: bodies, clothes, shoes, helmets, eyes.
  [/Body\d|Shoes|Tops|Bottoms|Helmet|Eyes|Eyelashes/i, 0.18],
  [/.*/, 0.45],
];

/** Texture size by material name. The shell is looked at; a pilot's shoe is not. */
const TEXTURE_SIZE = [
  [/Body_Outer|Rotor/i, 1024],
  [/ResucePilot|Body6|Shoes6/i, 256],
  [/.*/, 512],
];
const pick = (table, name) => table.find(([re]) => re.test(name ?? ''))[1];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(SRC);

/* ------------------------------------------------------------- bake flat */

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
 * Every primitive in world space at the REST pose.
 *
 * The meshes are skinned, and a skinned mesh is normally posed by its joint
 * matrices rather than by its node — but this export leaves the geometry in
 * place and the rig at rest, so the node's world matrix is the right
 * transform. Checked: the baked main rotor comes out 60.32 units across,
 * which is the whole scene's X extent, as a rotor disc should be.
 */
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
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
      }
      if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
    }
    parts.push({
      name: mesh.getName() || node.getName(),
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
  for (const p of arrays) {
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};
for (const part of parts) part.bounds = boundsOf([part.pos]);

/* --------------------------------------------------- scale, face, ground */

const main = parts.find((p) => /RotorMain/i.test(p.name));
const tail = parts.find((p) => /RotorRear/i.test(p.name));
if (!main || !tail) throw new Error('could not find both rotors by name');

// The disc's diameter is its largest dimension; the thin one is the shaft.
const discSpan = Math.max(main.bounds.size[0], main.bounds.size[2]);
const scale = ROTOR_DIAMETER / discSpan;
const whole = boundsOf(parts.map((p) => p.pos));

// Aft is where the tail rotor is; if that is at −Z the aircraft is facing
// backwards for this game and has to be turned about.
const aftIsPositiveZ = tail.bounds.centre[2] > main.bounds.centre[2];
const flip = aftIsPositiveZ ? 1 : -1;
console.log(`tail rotor is ${aftIsPositiveZ ? 'aft of' : 'forward of'} the mast — ${flip === 1 ? 'keeping' : 'turning'} the heading`);

// Origin: centred on X, skids on the floor, and the mast over it.
const originX = whole.centre[0];
const originY = whole.min[1];
const originZ = main.bounds.centre[2];
for (const part of parts) {
  for (let i = 0; i < part.pos.length; i += 3) {
    part.pos[i] = (part.pos[i] - originX) * scale * flip;
    part.pos[i + 1] = (part.pos[i + 1] - originY) * scale;
    part.pos[i + 2] = (part.pos[i + 2] - originZ) * scale * flip;
  }
  if (flip === -1) {
    for (let i = 0; i < part.nrm.length; i += 3) {
      part.nrm[i] = -part.nrm[i];
      part.nrm[i + 2] = -part.nrm[i + 2];
    }
    // Mirroring reverses the winding, so the faces have to be turned back.
    for (let i = 0; i < part.idx.length; i += 3) {
      const swap = part.idx[i + 1];
      part.idx[i + 1] = part.idx[i + 2];
      part.idx[i + 2] = swap;
    }
  }
  part.bounds = boundsOf([part.pos]);
}
const framed = boundsOf(parts.map((p) => p.pos));
console.log(`airframe ${framed.size.map((v) => v.toFixed(2)).join(' × ')} m (W × H × L), rotor disc ${ROTOR_DIAMETER} m`);

if (process.argv.includes('--parts')) {
  for (const p of [...parts].sort((a, b) => b.idx.length - a.idx.length)) {
    console.log(`  ${String(p.idx.length / 3).padStart(6)}  ${p.name.padEnd(46)} size ${p.bounds.size.map((v) => v.toFixed(2)).join('×').padEnd(22)} centre ${p.bounds.centre.map((v) => v.toFixed(2)).join(',')}`);
  }
}

/* ------------------------------------------------------------- the rotors */

/** A disc's spin axis is its thin one, and its radius is half of a fat one. */
const axisOf = (part) => {
  const [w, h, l] = part.bounds.size;
  const thin = Math.min(w, h, l);
  return thin === h ? 'y' : thin === w ? 'x' : 'z';
};
const rotorOf = (part, id) => ({
  id,
  axis: axisOf(part),
  hub: part.bounds.centre.map((v) => +v.toFixed(4)),
  radius: +(Math.max(...part.bounds.size) / 2).toFixed(4),
});
const rotors = [rotorOf(main, 'main'), rotorOf(tail, 'tail')];
for (const r of rotors) console.log(`${r.id} rotor: ${r.radius.toFixed(2)} m radius, spins about ${r.axis}, hub [${r.hub.join(', ')}]`);

/* ---------------------------------------------------------------- output */

await MeshoptSimplifier.ready;

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('helicopter');
const airframe = out.createNode('helicopter');
scene.addChild(airframe);

const textures = new Map();
const convertTexture = async (src, size) => {
  const image = src?.getImage();
  if (!image) return null;
  const key = `${image.byteLength}:${size}`;
  if (textures.has(key)) return textures.get(key);
  const webp = await sharp(Buffer.from(image))
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86 })
    .toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(key, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src) => {
  const name = src?.getName() ?? 'helicopter';
  if (materials.has(name)) return materials.get(name);
  const m = out.createMaterial(name)
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0.2)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.6)
    .setDoubleSided(src?.getDoubleSided() ?? false)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE');
  const tex = await convertTexture(src?.getBaseColorTexture(), pick(TEXTURE_SIZE, name));
  if (tex) m.setBaseColorTexture(tex);
  materials.set(name, m);
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

let before = 0;
let after = 0;
for (const part of parts) {
  before += part.idx.length / 3;
  const share = pick(SHARE, part.name);
  const target = Math.max(3, Math.floor((part.idx.length / 3) * share)) * 3;
  if (target < part.idx.length) {
    // `LockBorder` holds the open edges where these submeshes meet each other,
    // which is what stops a decimated cabin floor pulling away from its shell.
    const [simplified] = MeshoptSimplifier.simplify(part.idx, part.pos, 3, target, 0.05, ['LockBorder']);
    part.idx = simplified instanceof Uint32Array ? simplified : Uint32Array.from(simplified);
  }
  after += part.idx.length / 3;
}
console.log(`${before} → ${after} triangles`);

const body = out.createMesh('body');
for (const part of parts) {
  if (part === main || part === tail) continue;
  body.addPrimitive(await primitiveOf(part, [0, 0, 0]));
}
airframe.setMesh(body);

for (const [part, spec] of [[main, rotors[0]], [tail, rotors[1]]]) {
  const mesh = out.createMesh(spec.id);
  mesh.addPrimitive(await primitiveOf(part, spec.hub));
  airframe.addChild(out.createNode(spec.id).setMesh(mesh).setTranslation(spec.hub).setExtras({ rotor: spec.id }));
}

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
// The aircraft without its rotor discs. The collider wants this, not `size`:
// the disc is 10.2 m across and the machine under it is under three, and a
// box the width of the rotor would refuse to fly down a street it fits in.
const hull = boundsOf(parts.filter((p) => p !== main && p !== tail).map((p) => p.pos));
console.log(`hull ${hull.size.map((v) => v.toFixed(2)).join(' × ')} m about [${hull.centre.map((v) => v.toFixed(2)).join(', ')}]`);

writeFileSync(DATA, JSON.stringify({
  size: framed.size.map((v) => +v.toFixed(4)),
  /** Where the origin sits inside those bounds: nose is −Z of it, tail +Z. */
  extent: { min: framed.min.map((v) => +v.toFixed(4)), max: framed.max.map((v) => +v.toFixed(4)) },
  /** The airframe alone, rotors excluded — what the collider is built from. */
  hull: { size: hull.size.map((v) => +v.toFixed(4)), centre: hull.centre.map((v) => +v.toFixed(4)) },
  triangles: after,
  rotors,
}, null, 2) + '\n');
console.log(`wrote ${DST} and ${DATA}`);
