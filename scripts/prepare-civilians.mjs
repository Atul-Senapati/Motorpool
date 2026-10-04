/**
 * Turns the PSX civilian pack into twelve rigged, walkable pedestrians.
 *
 *     npm run prepare:civilians
 *
 * `psx_base_-_civilian_pack.glb` is twelve low-poly people stood in a loose
 * crowd, 6,500 triangles, with **no skeleton and no animation**: ten of them are
 * a body mesh plus a separate head, the last two one mesh each. The legs are
 * part of the body. A GTA-style street needs them to walk, so this pass rigs
 * them itself.
 *
 * ## How the rig is found
 *
 * Every figure stands in the same A-pose, which is what makes this possible
 * without a modelling tool. Measured from the geometry, per figure:
 *
 *  - **facing** — the feet stick out further in front of the shins than behind,
 *    so the toes say which way is forward. (All twelve face −X in the source.)
 *  - **hands** — the outermost vertices between hip and chest height. The arms
 *    hang out from the body, so the hands are clear of the hips.
 *  - **legs** — the lower body splits at the crotch into two columns; each
 *    column's centre is that leg's hip.
 *  - everything else (knee, elbow, waist, neck) is a fixed fraction of height.
 *    The ten two-part figures share one base body, so the fractions fit all.
 *
 * Each vertex is then bound to one bone, and blended with that bone's parent
 * across the joint, so knees, elbows and hips bend instead of tearing:
 *
 *  - arm: within `ARM_RADIUS` of the shoulder→hand line, below the shoulder.
 *    Projected along that line — upper arm, forearm past the elbow.
 *  - leg: below the crotch, left or right of the centre line. Thigh, shin,
 *    foot by height.
 *  - head: the head mesh, or above the neck for the one-piece figures.
 *  - the rest: hips below the waist, spine above it.
 *
 * ## What comes out
 *
 * `public/models/civilians.glb`: twelve root nodes `civilian0`…`civilian11`,
 * each a skinned mesh plus its own skeleton, feet on y = 0, facing **+Z**, left
 * hand on +X, at real height. Bones are world-aligned in the rest pose (every
 * rest rotation is identity), so the animation code can rotate them about plain
 * axes: X swings a limb forward and back, Z out to the side.
 *
 * No Draco: it is twelve meshes of ~700 vertices, and the skin attributes are
 * the bulk of it. Textures go down to `TEXTURE_SIZE` WebP — they were authored
 * at 512–1024 for a figure that is never more than a few hundred pixels tall
 * on screen.
 *
 * `src/config/civiliansData.json` lists each figure's height and bone names.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('psx_base_-_civilian_pack.glb');
const DST = 'public/models/civilians.glb';
const DATA = 'src/config/civiliansData.json';
/** The median figure's height, metres. The rest keep their relative heights. */
const MEDIAN_HEIGHT = 1.74;
const TEXTURE_SIZE = 256;

/**
 * Joint heights as fractions of the figure's full height, read off the
 * front-view density maps of the base body (crotch at 0.38, hands 0.42–0.52,
 * elbows 0.58, shoulders 0.67, top of the neck 0.86).
 */
const FRAC = {
  ankle: 0.06,
  knee: 0.24,
  crotch: 0.37,
  waist: 0.5,
  shoulder: 0.665,
  neck: 0.84,
};
/** How far from the shoulder→hand line still counts as arm, × height. */
const ARM_RADIUS = 0.05;
/** Half-width of the blend across each joint, × height. */
const BLEND = 0.025;

const BONES = [
  // name, parent
  ['root', null],
  ['hips', 'root'],
  ['spine', 'hips'],
  ['head', 'spine'],
  ['upperArm_L', 'spine'], ['foreArm_L', 'upperArm_L'],
  ['upperArm_R', 'spine'], ['foreArm_R', 'upperArm_R'],
  ['thigh_L', 'hips'], ['shin_L', 'thigh_L'], ['foot_L', 'shin_L'],
  ['thigh_R', 'hips'], ['shin_R', 'thigh_R'], ['foot_R', 'shin_R'],
];
const BONE_INDEX = Object.fromEntries(BONES.map(([name], i) => [name, i]));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
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
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Every mesh node baked to world space, one part per primitive. */
const meshes = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const world = node.getWorldMatrix();
  const parts = [];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const count = pos.getCount();
    const p = [];
    const n = [];
    const t = [];
    const v = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      p.push(mul(world, pos.getElement(i, v)));
      if (nrm) {
        const d = mulDir(world, nrm.getElement(i, v));
        const len = Math.hypot(...d) || 1;
        n.push(d.map((c) => c / len));
      }
      if (uv) t.push(uv.getElement(i, [0, 0]).slice());
    }
    const indices = idx
      ? Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
      : Array.from({ length: count }, (_, i) => i);
    parts.push({ p, n, t, idx: indices, material: prim.getMaterial() });
  }
  const all = parts.flatMap((part) => part.p);
  const lo = [0, 1, 2].map((k) => Math.min(...all.map((q) => q[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...all.map((q) => q[k])));
  meshes.push({ name: node.getName(), parts, lo, hi, centre: [(lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2] });
}

/**
 * Bodies are anything taller than half a figure; heads are the short ones on
 * top, matched to the body they sit over.
 */
const tallest = Math.max(...meshes.map((m) => m.hi[1] - m.lo[1]));
const bodies = meshes.filter((m) => m.hi[1] - m.lo[1] > tallest / 2);
const heads = meshes.filter((m) => m.hi[1] - m.lo[1] <= tallest / 2);
const figures = bodies.map((body) => ({ body, head: null }));
for (const head of heads) {
  let best = null;
  let bestD = Infinity;
  for (const f of figures) {
    const d = Math.hypot(f.body.centre[0] - head.centre[0], f.body.centre[1] - head.centre[1]);
    if (d < bestD && !f.head) { best = f; bestD = d; }
  }
  if (!best || bestD > 0.2) throw new Error(`head ${head.name} has no body under it (nearest ${bestD.toFixed(2)})`);
  best.head = head;
}
// Stable order: left to right along the crowd, so the indices do not move
// between runs.
figures.sort((a, b) => a.body.centre[1] - b.body.centre[1] || a.body.centre[0] - b.body.centre[0]);

const heights = figures.map((f) => Math.max(f.body.hi[1], f.head?.hi[1] ?? -Infinity) - f.body.lo[1]);
const median = [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)];
const SCALE = MEDIAN_HEIGHT / median;

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('civilians');

const textures = new Map();
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(image)) return textures.get(image);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 }).toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(image, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src) => {
  if (materials.has(src)) return materials.get(src);
  const m = out.createMaterial(src?.getName() || 'civilian')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.9)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE')
    .setDoubleSided(src?.getDoubleSided() ?? false);
  if (src?.getAlphaMode() === 'MASK') m.setAlphaCutoff(src.getAlphaCutoff());
  const tex = await convertTexture(src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  materials.set(src, m);
  return m;
};

const data = [];
for (const [fi, { body, head }] of figures.entries()) {
  const floor = body.lo[1];
  const H = heights[fi];
  const bodyPts = body.parts.flatMap((part) => part.p);

  // Facing, from the feet. Lateral axis is whichever horizontal axis the body
  // is wider along; the toes stick out along the other one.
  const ext = (k) => Math.max(...bodyPts.map((q) => q[k])) - Math.min(...bodyPts.map((q) => q[k]));
  const latK = ext(2) > ext(0) ? 2 : 0;
  const fwdK = 2 - latK;
  const feet = bodyPts.filter((q) => q[1] - floor < FRAC.ankle * H);
  // The whole leg, not just the shin: the low-poly legs have no vertices
  // between the ankle ring and the knee ring.
  const shins = bodyPts.filter((q) => {
    const h = (q[1] - floor) / H;
    return h > FRAC.ankle * 1.5 && h < FRAC.crotch;
  });
  const mean = (arr, k) => arr.reduce((s, q) => s + q[k], 0) / arr.length;
  const shinF = mean(shins, fwdK);
  const footLo = Math.min(...feet.map((q) => q[fwdK]));
  const footHi = Math.max(...feet.map((q) => q[fwdK]));
  const fwdSign = footHi - shinF > shinF - footLo ? 1 : -1;
  // Left = up × forward. With forward on +X that is −Z; on −X, +Z; on +Z, +X.
  const latSign = latK === 2 ? -fwdSign : fwdSign;

  const latMid = (() => {
    const ls = bodyPts.map((q) => q[latK]);
    return (Math.min(...ls) + Math.max(...ls)) / 2;
  })();
  /** Source point → figure space: metres, feet on 0, facing +Z, left on +X. */
  const toFig = (q) => [
    (q[latK] - latMid) * latSign * SCALE,
    (q[1] - floor) * SCALE,
    (q[fwdK] - shinF) * fwdSign * SCALE,
  ];
  const dirToFig = (d) => [d[latK] * latSign, d[1], d[fwdK] * fwdSign];

  const figPts = bodyPts.map(toFig);
  const h = H * SCALE;
  const y = Object.fromEntries(Object.entries(FRAC).map(([k, f]) => [k, f * h]));

  // Hands: the outermost points between the crotch and the elbow, per side.
  const handBand = figPts.filter((q) => q[1] > y.crotch && q[1] < (y.waist + y.shoulder) / 2);
  const hand = (side) => {
    const sidePts = handBand.filter((q) => q[0] * side > 0);
    const far = Math.max(...sidePts.map((q) => q[0] * side));
    const tip = sidePts.filter((q) => q[0] * side > far - 0.06 * h);
    return [mean(tip, 0), Math.min(...tip.map((q) => q[1])), mean(tip, 2)];
  };
  // Hips: the centre of each leg column.
  const legCol = (side) => {
    const col = figPts.filter((q) => q[1] > y.ankle * 1.5 && q[1] < y.crotch && q[0] * side > 0);
    return [mean(col, 0), mean(col, 2)];
  };
  const shoulderPts = figPts.filter((q) => Math.abs(q[1] - y.shoulder) < 0.03 * h);
  const shoulderLat = 0.8 * Math.max(...shoulderPts.map((q) => Math.abs(q[0])));

  const joints = { root: [0, 0, 0], hips: [0, y.crotch, 0], spine: [0, y.waist, 0], head: [0, y.neck, 0] };
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    const hd = hand(s);
    const sh = [shoulderLat * s, y.shoulder, 0];
    joints[`upperArm_${side}`] = sh;
    joints[`foreArm_${side}`] = sh.map((c, k) => (c + hd[k]) / 2);
    joints[`hand_${side}`] = hd;
    const [lx, lz] = legCol(s);
    joints[`thigh_${side}`] = [lx, y.crotch, lz];
    joints[`shin_${side}`] = [lx, y.knee, lz];
    joints[`foot_${side}`] = [lx, y.ankle, lz];
  }

  /** Weights for one body vertex: [[bone, w], …], summing to one. */
  const weigh = (q) => {
    const b = BLEND * h;
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      if (q[0] * s <= 0) continue;
      // Arm: near the shoulder→hand segment and below the shoulder.
      const a = joints[`upperArm_${side}`];
      const c = joints[`hand_${side}`];
      const ac = c.map((v, k) => v - a[k]);
      const len2 = ac.reduce((sum, v) => sum + v * v, 0);
      const t = ac.reduce((sum, v, k) => sum + v * (q[k] - a[k]), 0) / len2;
      const closest = a.map((v, k) => v + ac[k] * Math.min(1, Math.max(0, t)));
      const d = Math.hypot(...q.map((v, k) => v - closest[k]));
      if (t > -0.05 && d < ARM_RADIUS * h && q[1] < y.shoulder + b) {
        const seg = Math.sqrt(len2);
        const fore = smooth(0.5 - b / seg, 0.5 + b / seg, t);
        const body = 1 - smooth(-0.02, 0.15, t);
        return [
          ['spine', body],
          [`upperArm_${side}`, (1 - body) * (1 - fore)],
          [`foreArm_${side}`, (1 - body) * fore],
        ];
      }
      // Leg: below the crotch on this side of the centre line.
      if (q[1] < y.crotch + b) {
        const hipW = 1 - smooth(y.crotch - b * 2, y.crotch + b, q[1]);
        const shin = 1 - smooth(y.knee - b, y.knee + b, q[1]);
        const foot = 1 - smooth(y.ankle - b, y.ankle + b, q[1]);
        return [
          ['hips', 1 - hipW],
          [`thigh_${side}`, hipW * (1 - shin)],
          [`shin_${side}`, hipW * shin * (1 - foot)],
          [`foot_${side}`, hipW * shin * foot],
        ];
      }
    }
    const spine = smooth(y.waist - b * 2, y.waist + b * 2, q[1]);
    const headW = smooth(y.neck - b, y.neck + b, q[1]);
    return [['hips', 1 - spine], ['spine', spine * (1 - headW)], ['head', spine * headW]];
  };

  // ---- Output: bones, then the skinned mesh. ----
  const figNode = out.createNode(`civilian${fi}`);
  scene.addChild(figNode);
  const boneNodes = {};
  for (const [name, parent] of BONES) {
    const at = joints[name];
    const from = parent ? joints[parent] : [0, 0, 0];
    const node = out.createNode(name).setTranslation(at.map((v, k) => v - from[k]));
    boneNodes[name] = node;
    (parent ? boneNodes[parent] : figNode).addChild(node);
  }
  const ibm = new Float32Array(BONES.length * 16);
  BONES.forEach(([name], i) => {
    const [x, yy, z] = joints[name];
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -yy, -z, 1], i * 16);
  });
  const skin = out.createSkin(`civilian${fi}`)
    .setSkeleton(boneNodes.root)
    .setInverseBindMatrices(out.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  for (const [name] of BONES) skin.addJoint(boneNodes[name]);

  const mesh = out.createMesh(`civilian${fi}`);
  let triangles = 0;
  const sources = [...body.parts.map((part) => [part, false]), ...(head?.parts ?? []).map((part) => [part, true])];
  for (const [part, isHead] of sources) {
    const n = part.p.length;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(part.n.length ? n * 3 : 0);
    const uv = new Float32Array(part.t.length ? n * 2 : 0);
    const jnt = new Uint8Array(n * 4);
    const wgt = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const q = toFig(part.p[i]);
      pos.set(q, i * 3);
      if (nrm.length) nrm.set(dirToFig(part.n[i]), i * 3);
      if (uv.length) uv.set(part.t[i], i * 2);
      const ws = (isHead ? [['head', 1]] : weigh(q))
        .filter(([, w]) => w > 1e-3)
        .sort((p1, p2) => p2[1] - p1[1])
        .slice(0, 4);
      const total = ws.reduce((s, [, w]) => s + w, 0);
      ws.forEach(([bone, w], k) => {
        jnt[i * 4 + k] = BONE_INDEX[bone];
        wgt[i * 4 + k] = w / total;
      });
    }
    const prim = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('JOINTS_0', out.createAccessor().setType('VEC4').setArray(jnt).setBuffer(buffer))
      .setAttribute('WEIGHTS_0', out.createAccessor().setType('VEC4').setArray(wgt).setBuffer(buffer))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(Uint16Array.from(part.idx)).setBuffer(buffer))
      .setMaterial(await convertMaterial(part.material));
    if (nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer));
    if (uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
    mesh.addPrimitive(prim);
    triangles += part.idx.length / 3;
  }
  figNode.addChild(out.createNode(`civilian${fi}_mesh`).setMesh(mesh).setSkin(skin));

  data.push({
    name: `civilian${fi}`,
    source: [body.name, head?.name].filter(Boolean).join('+'),
    height: +h.toFixed(3),
    hipHeight: +y.crotch.toFixed(3),
    legLength: +(y.crotch - 0).toFixed(3),
    triangles,
  });
  console.log(
    `civilian${fi}  ${data[fi].source.padEnd(20)} ${h.toFixed(2)} m  facing ${fwdSign > 0 ? '+' : '−'}${'XYZ'[fwdK]}`
    + `  hands L ${joints.hand_L.map((v) => v.toFixed(2)).join(',')}  R ${joints.hand_R.map((v) => v.toFixed(2)).join(',')}`,
  );
}

await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({ bones: BONES.map(([b]) => b), figures: data }, null, 2) + '\n');
console.log(`${figures.length} figures, ×${SCALE.toFixed(3)}, ${textures.size} textures → ${DST}`);
