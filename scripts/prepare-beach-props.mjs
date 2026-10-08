/**
 * Turns the dropped beach pack and quad bike into Kestrel Beach's props.
 *
 *     npm run prepare:beach-props
 *
 * `psx_beach_pack.glb`: sixteen small props laid out side by side, in metres,
 * specular-glossiness materials over 256 px textures. Each prop is cut out as
 * its own node, centred on X and Z with its foot on y = 0, so the beach can
 * instance it anywhere. The table keeps what stands on it (cocktail, glasses,
 * plate, corn) as one node, `table`, in their places. The swimming ring is
 * modelled leaning on something, so it is laid flat (`layFlat`). The palm's leaf texture
 * has no alpha — the leaves are drawn on white — so near-white is keyed out
 * into an alpha mask here.
 *
 * `quad_bike_3d.glb`: one quad bike modelled in centimetres, nose to +Z. Scaled
 * to metres, turned to face −Z, wheels on y = 0, centred: node `quad` (the
 * body) and `quadWheel` (one wheel centred on its axle), with the four hubs
 * and the handlebar in the data file — the beach's ridden quads spin them.
 *
 * Materials come out metal-rough and non-metallic (the pack's spec-gloss and
 * the quad's metallic-1-with-no-map both render near black in this lighting),
 * textures WebP, meshes Draco.
 *
 * What comes out: `public/models/beachPack.glb`, `public/models/quadBike.glb`,
 * and `src/config/beachPropsData.json` with each node's size.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const PACK_SRC = source('psx_beach_pack.glb');
const QUAD_SRC = source('quad_bike_3d.glb');
const PACK_DST = 'public/models/beachPack.glb';
const QUAD_DST = 'public/models/quadBike.glb';
const DATA = 'src/config/beachPropsData.json';

/** Source node name prefix → output node. Several sources may share one output. */
const PACK_NODES = {
  Ball: 'ball',
  Coconut: 'coconut',
  Lifebuoy: 'lifebuoy',
  Palm1: 'palm1',
  Palm2: 'palm2',
  SunLounger1: 'lounger1',
  SunLounger2: 'lounger2',
  SwimmingRing: 'ring',
  Towel: 'towel',
  Umbrella1: 'umbrella1',
  Umbrella2: 'umbrella2',
  Table: 'table',
  Cocktail: 'table',
  Glasses: 'table',
  Plate: 'table',
  orn1: 'table', // "corn1", with a mangled first byte in the source
};

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

/** Every primitive of a node, baked to world space. */
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
    out.push({ pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial() });
  }
  return out;
}

/** Scale, then put a group of parts' foot on y = 0 and centre it on X and Z. */
function settle(parts, scale) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let i = 0; i < part.pos.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], part.pos[i + k]);
    max[k] = Math.max(max[k], part.pos[i + k]);
  }
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      part.pos[i] = (part.pos[i] - cx) * scale;
      part.pos[i + 1] = (part.pos[i + 1] - min[1]) * scale;
      part.pos[i + 2] = (part.pos[i + 2] - cz) * scale;
    }
  }
  return [(max[0] - min[0]) * scale, (max[1] - min[1]) * scale, (max[2] - min[2]) * scale].map((v) => +v.toFixed(3));
}

/**
 * Turn a group of parts so its flattest direction points up: for the swimming
 * ring, modelled leaning against something, so it lies flat on the sand. The
 * normal is the covariance's smallest axis, found by power iteration on the
 * inverse-free form (largest of trace·I − C).
 */
function layFlat(parts) {
  const pts = [];
  for (const part of parts) for (let i = 0; i < part.pos.length; i += 3) pts.push([part.pos[i], part.pos[i + 1], part.pos[i + 2]]);
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (p[i] - c[i]) * (p[j] - c[j]);
  const tr = C[0][0] + C[1][1] + C[2][2];
  const M = C.map((row, i) => row.map((v, j) => (i === j ? tr : 0) - v));
  let n = [0.3, 0.9, 0.3];
  for (let it = 0; it < 100; it++) {
    const m = [0, 1, 2].map((i) => M[i][0] * n[0] + M[i][1] * n[1] + M[i][2] * n[2]);
    const len = Math.hypot(...m);
    n = m.map((v) => v / len);
  }
  if (n[1] < 0) n = n.map((v) => -v);
  // Rodrigues: rotate n onto +y.
  const axis = [-n[2], 0, n[0]]; // n × y
  const s = Math.hypot(...axis);
  if (s < 1e-6) return;
  const k = axis.map((v) => v / s);
  const cos = n[1];
  const rot = (v) => {
    const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    const cross = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    return [0, 1, 2].map((i) => v[i] * cos + cross[i] * s + k[i] * dot * (1 - cos));
  };
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) part.pos.set(rot([part.pos[i], part.pos[i + 1], part.pos[i + 2]]), i);
    for (let i = 0; i < part.nrm.length; i += 3) part.nrm.set(rot([part.nrm[i], part.nrm[i + 1], part.nrm[i + 2]]), i);
  }
}

/** A source material's colour texture, spec-gloss or metal-rough. */
function colourOf(material) {
  const sg = material?.listExtensions().find((e) => e.extensionName === 'KHR_materials_pbrSpecularGlossiness');
  return {
    texture: sg ? sg.getDiffuseTexture() : material?.getBaseColorTexture(),
    factor: sg ? sg.getDiffuseFactor() : material?.getBaseColorFactor() ?? [1, 1, 1, 1],
  };
}

async function write(dst, groups, { keyWhite = new Set(), textureSize = 512 } = {}) {
  const out = new Document();
  out.createBuffer();
  const buffer = out.getRoot().listBuffers()[0];
  const scene = out.createScene('props');
  const materials = new Map();
  const convert = async (src) => {
    if (materials.has(src)) return materials.get(src);
    const { texture, factor } = colourOf(src);
    const name = src?.getName() || 'prop';
    const m = out.createMaterial(name).setBaseColorFactor(factor).setMetallicFactor(0).setRoughnessFactor(0.75);
    if (texture) {
      let img = sharp(Buffer.from(texture.getImage()));
      const keyed = keyWhite.has(name);
      if (keyed) {
        // Leaves on white: alpha from how far a pixel is from white.
        const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let i = 0; i < data.length; i += 4) {
          const white = Math.min(data[i], data[i + 1], data[i + 2]);
          data[i + 3] = white > 235 ? 0 : 255;
        }
        img = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
        m.setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true);
      }
      const webp = await img
        .resize(textureSize, textureSize, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90, alphaQuality: 100 }).toBuffer();
      m.setBaseColorTexture(out.createTexture(name).setImage(webp).setMimeType('image/webp'));
    }
    if (src?.getDoubleSided()) m.setDoubleSided(true);
    materials.set(src, m);
    return m;
  };
  const sizes = {};
  let triangles = 0;
  for (const [name, { parts, size }] of Object.entries(groups)) {
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
    scene.addChild(out.createNode(name).setMesh(mesh));
    sizes[name] = size;
  }
  out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  });
  await io.write(dst, out);
  console.log(`${Object.keys(groups).length} nodes, ${triangles} tris → ${dst}`);
  return sizes;
}

/* ------------------------------------------------------------- beach pack */

const pack = await io.read(PACK_SRC);
const packParts = {};
for (const node of pack.getRoot().listNodes()) {
  if (!node.getMesh()) continue;
  const key = Object.keys(PACK_NODES).find((k) => node.getName().includes(k));
  if (!key) { console.warn(`skipped ${node.getName()}`); continue; }
  (packParts[PACK_NODES[key]] ??= []).push(...bake(node));
}
const packGroups = {};
for (const [name, parts] of Object.entries(packParts)) {
  if (name === 'ring') layFlat(parts);
  packGroups[name] = { parts, size: settle(parts, 1) };
}
const packSizes = await write(PACK_DST, packGroups, { keyWhite: new Set(['Palm']), textureSize: 256 });

/* --------------------------------------------------------------- quad bike */

const quad = await io.read(QUAD_SRC);
const quadNodes = quad.getRoot().listNodes().filter((n) => n.getMesh());
const quadParts = quadNodes.flatMap((n) => bake(n).map((part) => ({ ...part, node: n.getName() })));
// Turned to face −Z, like every other vehicle here: half a turn about Y.
for (const part of quadParts) {
  for (let i = 0; i < part.pos.length; i += 3) { part.pos[i] = -part.pos[i]; part.pos[i + 2] = -part.pos[i + 2]; }
  for (let i = 0; i < part.nrm.length; i += 3) { part.nrm[i] = -part.nrm[i]; part.nrm[i + 2] = -part.nrm[i + 2]; }
}
const quadSize = settle(quadParts, 0.01);
/** Centre and extent of a part, after settling. */
const extent = (part) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.pos.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], part.pos[i + k]);
    hi[k] = Math.max(hi[k], part.pos[i + k]);
  }
  return { lo, hi, centre: lo.map((v, k) => (v + hi[k]) / 2) };
};
// The wheels come apart from the body so they can turn: one wheel, centred on
// its axle, and the four hubs it is drawn at.
const wheelParts = quadParts.filter((p) => /^Wheel/.test(p.node));
const hubs = wheelParts.map((p) => extent(p).centre.map((v) => +v.toFixed(4)));
const wheel = wheelParts[0];
const wheelBox = extent(wheel);
for (let i = 0; i < wheel.pos.length; i += 3) for (let k = 0; k < 3; k++) wheel.pos[i + k] -= wheelBox.centre[k];
const handle = quadParts.find((p) => /^Handle/.test(p.node));
const handleBox = handle ? extent(handle) : null;
const quadSizes = await write(QUAD_DST, {
  quad: { parts: quadParts.filter((p) => !/^Wheel/.test(p.node)), size: quadSize },
  quadWheel: { parts: [wheel], size: wheelBox.hi.map((v, k) => +(v - wheelBox.lo[k]).toFixed(3)) },
}, { textureSize: 1024 });

writeFileSync(DATA, JSON.stringify({
  pack: packSizes,
  quad: quadSizes.quad,
  quadWheel: { radius: +((wheelBox.hi[1] - wheelBox.lo[1]) / 2).toFixed(4), hubs },
  quadHandle: handleBox ? { centre: handleBox.centre.map((v) => +v.toFixed(3)), top: +handleBox.hi[1].toFixed(3) } : null,
}, null, 2) + '\n');
