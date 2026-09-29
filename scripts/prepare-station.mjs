/**
 * Turns the dropped station model into the island line's station building.
 *
 *     npm run prepare:station
 *
 * `standar_materials_fbx_nombres_corregidos.glb`: 17 parts, 12 materials, no
 * textures, authored in centimetres (6706 × 904 × 2546). This pass bakes the
 * node transforms flat, scales it to metres, puts its base on y = 0 and centres
 * it on X and Z, merges the parts by material, gives each a realistic finish
 * by its name (`FINISH` — the export lost its textures), and drops the five `Text*` meshes — the lettering on the front,
 * which read "store", not a station's name. Draco.
 *
 * The lettering is measured before it is dropped: it is on the street front,
 * and `stationBuildingData.json` records which way that front faces (`front`,
 * the sign of Z) so the building can be turned to face the road.
 *
 * What comes out: `public/models/station.glb`, one node `station`, and
 * `src/config/stationBuildingData.json` with its size.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const SRC = source('standar_materials_fbx_nombres_corregidos.glb');
const DST = 'public/models/station.glb';
const DATA = 'src/config/stationBuildingData.json';
/** Centimetres to metres. */
const SCALE = 0.01;
const isText = (name) => /^Text\d+/i.test(name);

/**
 * Realistic finishes, by the model's own material names.
 *
 * The export lost every texture, so nine of its twelve materials are the same
 * flat 50% grey and the building read as a grey box. The names say what each
 * surface is — Spanish: `ladrillos` bricks, `madera` timber, `techo` roof and
 * floor slabs, `paredes interiores` the interior walls, which are also its
 * whole back and ends — so each gets the colour, roughness and sheen of that
 * material.
 *
 * Colours are written as the sRGB hex you would pick them by and converted to
 * LINEAR here, because that is what a glTF base-colour factor is. Written as
 * 0..1 screen values the first time, every one came out far paler than meant —
 * the buff brick rendered as cream, and the back of the building as white.
 */
const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);

/*
 * The modern palette — the user asked for a generic modern station, not a
 * Victorian London one, after the red brick and Portland stone; then turned
 * down an all-dark version and an all-light one, and asked for CONTRAST. So:
 * the big surfaces (`paredes interiores`, the back and ends) a warm light
 * stone-coloured panel — never white, which the user ruled out for the back
 * and base — against rich cedar slats on the front's piers (`ladrillos`) and
 * timber (`madera`), slate blue-grey (`pared gris`) and mid-grey concrete
 * (`stone`) as the cool accents, and graphite frames and ironwork to draw the
 * lines.
 *
 * Colours are sRGB hex, converted to LINEAR, because that is what a glTF
 * base-colour factor is; a textured material's factor is white and the image
 * carries the colour (sRGB, which glTF expects of a base-colour texture).
 */
const FINISH = {
  metal_windows: { color: lin('#3a3f44'), rough: 0.4, metal: 0.55 },
  metal: { color: lin('#41474d'), rough: 0.4, metal: 0.55 },
  metal_3: { color: lin('#33383d'), rough: 0.4, metal: 0.6 },
  'vray_0B1Dana-Got3d': { color: lin('#e2ddd3'), rough: 0.7, metal: 0 },
  madera: { texture: 'slats', rough: 0.7, metal: 0 },
  techo: { color: lin('#565b60'), rough: 0.8, metal: 0.1 },
  ladrillos: { texture: 'slats', rough: 0.7, metal: 0 },
  stone: { texture: 'concrete', rough: 0.85, metal: 0 },
  pared_gris: { color: lin('#5d6b76'), rough: 0.6, metal: 0.1 },
  paredes_interiores: { texture: 'panels', rough: 0.7, metal: 0 },
  Material_2100525465: { color: lin('#4f7f8e'), rough: 0.05, metal: 0.3, alpha: 0.5 },
};

/**
 * Metres of wall per texture repeat, in the MODEL's units — the scene scales
 * the building by 1.25, so 1.8 here is 2.25 m on the ground: one rainscreen
 * panel across and two up, one concrete panel, sixteen 14 cm slats.
 */
const TILE = 1.8;
const hexShade = (hex, k) => '#' + [1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k))).toString(16).padStart(2, '0')).join('');

/**
 * The textures are deliberately plain — seams and nothing else, at the
 * user's "slight less effort texture": a panel joint, a slat reveal, a
 * concrete joint. The contrast is in the colours, not in the grain.
 */
/** Cladding panels: one flat colour, a soft joint round each. */
function panelSvg(base, joint) {
  const W = 1024, gap = 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="${joint}"/>`
    + `<rect x="${gap / 2}" y="${gap / 2}" width="${W - gap}" height="${W / 2 - gap}" fill="${base}"/>`
    + `<rect x="${gap / 2}" y="${W / 2 + gap / 2}" width="${W - gap}" height="${W / 2 - gap}" fill="${hexShade(base, 0.98)}"/></svg>`;
}
/** Vertical slats: alternating a hair lighter and darker, with a reveal between. */
function slatSvg(base, reveal) {
  const W = 1024, n = 12, sw = W / n, gap = 12;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="${reveal}"/>`;
  for (let i = 0; i < n; i++) {
    out += `<rect x="${(i * sw + gap / 2).toFixed(1)}" y="0" width="${(sw - gap).toFixed(1)}" height="${W}" fill="${hexShade(base, i % 3 === 0 ? 0.93 : i % 3 === 1 ? 1.03 : 1)}"/>`;
  }
  return out + '</svg>';
}
/** Concrete: one panel, a fine joint. */
function concreteSvg(base, joint) {
  const W = 1024;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="${joint}"/>`
    + `<rect x="3" y="3" width="${W - 6}" height="${W - 6}" fill="${base}"/></svg>`;
}
const TEXTURES = {
  panels: () => panelSvg('#d6d0c4', '#b3ab9d'),
  slats: () => slatSvg('#a86a3f', '#4a2f1d'),
  concrete: () => concreteSvg('#8e979d', '#6f777d'),
};

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
/** Whether a node, or any ancestor, is one of the lettering nodes. */
const underText = (node) => {
  for (let n = node; n; n = n.getParentNode?.() ?? null) if (isText(n.getName())) return true;
  return false;
};

const parts = [];
const textZ = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const world = node.getWorldMatrix();
  const text = underText(node) || isText(mesh.getName());
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    const idx = prim.getIndices();
    const count = pos.getCount();
    const p = new Float32Array(count * 3);
    const n = new Float32Array(nrm ? count * 3 : 0);
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
    }
    if (text) { for (let i = 2; i < p.length; i += 3) textZ.push(p[i]); continue; }
    const indices = idx
      ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
      : Uint32Array.from({ length: count }, (_, i) => i);
    parts.push({ pos: p, nrm: n, idx: indices, material: prim.getMaterial() });
  }
}
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
    part.pos[i] = (part.pos[i] - cx) * SCALE;
    part.pos[i + 1] = (part.pos[i + 1] - min[1]) * SCALE;
    part.pos[i + 2] = (part.pos[i + 2] - cz) * SCALE;
  }
}
const size = [(max[0] - min[0]) * SCALE, (max[1] - min[1]) * SCALE, (max[2] - min[2]) * SCALE];
/*
 * Where the end WALLS stand, as opposed to the bounding box: the dark portal
 * frame at one end reaches 1.1 m past the wall, and two copies placed box to
 * box left a gap that wide between their walls. Measured over the opaque
 * vertices at storey height, which the frame's thin members barely touch.
 */
const wallXs = [];
for (const part of parts) {
  if ((part.material?.getAlphaMode() ?? 'OPAQUE') === 'BLEND') continue;
  for (let i = 0; i < part.pos.length; i += 3) if (part.pos[i + 1] > 2 && part.pos[i + 1] < 6) wallXs.push(part.pos[i]);
}
wallXs.sort((a, b) => a - b);
const walls = [wallXs[Math.floor(wallXs.length * 0.002)], wallXs[Math.floor(wallXs.length * 0.998)]];
const textMeanZ = textZ.length ? textZ.reduce((a, b) => a + b, 0) / textZ.length : cz;
/** The street front's side: the lettering was on it. */
const front = Math.sign(textMeanZ - cz) || -1;

/*
 * Box-projected UVs, in metres over `TILE`: each vertex takes the two axes
 * across its normal's strongest one, so a wall facing ±Z maps (x, y), one
 * facing ±X maps (z, y) and a slab maps (x, z). The export's own UVs belonged
 * to the textures it lost, and a cladding texture on them would land at whatever
 * scale they happened to have.
 */
for (const part of parts) {
  const n = part.pos.length / 3;
  part.uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2]];
    const nx = Math.abs(part.nrm[i * 3] ?? 0), ny = Math.abs(part.nrm[i * 3 + 1] ?? 0), nz = Math.abs(part.nrm[i * 3 + 2] ?? 0);
    const [u, v] = nx >= ny && nx >= nz ? [z, y] : nz >= ny ? [x, y] : [x, z];
    part.uv[i * 2] = u / TILE;
    part.uv[i * 2 + 1] = -v / TILE;
  }
}

// Merge by material, giving each its finish.
const byMaterial = new Map();
for (const part of parts) {
  const list = byMaterial.get(part.material) ?? [];
  list.push(part);
  byMaterial.set(part.material, list);
}
const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('station');
const baked = new Map();
/** One texture per kind, rendered from its SVG, as WebP. */
async function bakeTexture(kind) {
  if (baked.has(kind)) return baked.get(kind);
  const png = await sharp(Buffer.from(TEXTURES[kind]())).resize(1024, 1024).webp({ quality: 88 }).toBuffer();
  const t = out.createTexture(kind).setImage(png).setMimeType('image/webp');
  baked.set(kind, t);
  return t;
}
const mesh = out.createMesh('station');
let triangles = 0;
for (const [src, list] of byMaterial) {
  const vCount = list.reduce((a, p) => a + p.pos.length / 3, 0);
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const idx = new Uint32Array(list.reduce((a, p) => a + p.idx.length, 0));
  let vo = 0, io2 = 0;
  for (const p of list) {
    pos.set(p.pos, vo * 3);
    if (p.nrm.length) nrm.set(p.nrm, vo * 3);
    uvs.set(p.uv, vo * 2);
    for (let i = 0; i < p.idx.length; i++) idx[io2 + i] = p.idx[i] + vo;
    vo += p.pos.length / 3;
    io2 += p.idx.length;
  }
  const alpha = src?.getAlphaMode() ?? 'OPAQUE';
  const name = src?.getName() || 'station';
  const finish = FINISH[name];
  const base = src?.getBaseColorFactor() ?? [1, 1, 1, 1];
  const tex = finish?.texture ? await bakeTexture(finish.texture) : null;
  const m = out.createMaterial(name)
    .setBaseColorFactor(tex ? [1, 1, 1, 1] : finish ? [...finish.color, finish.alpha ?? base[3]] : base)
    .setMetallicFactor(finish?.metal ?? src?.getMetallicFactor() ?? 0)
    .setRoughnessFactor(finish?.rough ?? src?.getRoughnessFactor() ?? 0.85)
    .setAlphaMode(alpha)
    .setDoubleSided(true);
  if (tex) m.setBaseColorTexture(tex);
  if (!finish) console.warn(`no finish for material ${name}; kept its own colour`);
  const prim = out.createPrimitive()
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
    .setMaterial(m);
  mesh.addPrimitive(prim);
  triangles += idx.length / 3;
}
scene.addChild(out.createNode('station').setMesh(mesh));
out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({ size: size.map((v) => +v.toFixed(3)), walls: walls.map((v) => +v.toFixed(3)), front, triangles }, null, 2) + '\n');
console.log(`station ${size.map((v) => v.toFixed(2)).join(' × ')} m, ${triangles} tris, ${byMaterial.size} materials, lettering dropped (${textZ.length / 3} verts) on the ${front < 0 ? '-Z' : '+Z'} face → ${DST}`);
