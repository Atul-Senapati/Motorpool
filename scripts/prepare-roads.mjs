/**
 * The modular road kit, baked into something the game can lay.
 *
 *     npm run prepare:roads
 *
 * `modular_roads_pack.glb` is nine pieces of a four-lane divided arterial —
 * three lengths of straight, three radii of half-circle, and an L, a T and an
 * X junction. All the detail is in two 1024 textures rather than in geometry,
 * so the whole kit is under 1,500 triangles: a road made of it carries real
 * kerbs, pavements, lane markings and crossings without any of that being
 * modelled.
 *
 * ## Scale
 *
 * The pack is authored at about TWO units per metre, which is measured rather
 * than assumed: the carriageway is 37.92 units across and carries four lanes
 * plus two pavements, so at 2 units/m that is a 19 m road with 3.3 m lanes and
 * 2.7 m footways — which is what an arterial is. `UNITS` below is that number
 * and everything comes out in metres.
 *
 * ## What comes out
 *
 *   public/models/roads.glb        one mesh per piece, Draco-compressed
 *   src/config/roadModelData.json  each piece's measured size, which is what
 *                                  lets the layout butt them together
 *
 * Every piece is centred on its own footprint and sits at y = 0, so laying one
 * is an (x, z, turn) and nothing else — the same contract as the airport's.
 *
 * ## The straights do NOT tile at the junction pitch
 *
 * A junction is 37.92 units square and `Road_1X_Straight` is 146.30 long,
 * which is 3.86 junctions and not 4. Butting straights against junctions and
 * assuming they snap leaves about 2.7 m unaccounted for per span. The layout
 * therefore works from the JUNCTION positions outwards and fits the straights
 * between them — see `roadConfig`.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const KIT = source('modular_roads_pack.glb');
const DST = 'public/models/roads.glb';
const DATA = 'src/config/roadModelData.json';
const TEXTURE_SIZE = 1024;

/** Units per metre, measured off the carriageway. See the header. */
const UNITS = 2;

/**
 * Every piece, by the name the pack gives it.
 *
 * `from` is the node whose children carry the geometry — the junctions are
 * two meshes each, the carriageway and a separate infill panel under it, and
 * both hang off the same parent, so matching the parent takes both.
 */
const PARTS = [
  { name: 'straight1', from: 'Road_1X_Straight' },
  { name: 'straight2', from: 'Road_2X_Straight' },
  { name: 'straight4', from: 'Road_4X_Straight' },
  { name: 'curve1', from: 'Road_1X_HalfCircle' },
  { name: 'curve2', from: 'Road_2X_HalfCircle' },
  { name: 'curve4', from: 'Road_4X_HalfCircle' },
  { name: 'cornerL', from: 'Road_L_Intersection' },
  { name: 'junctionT', from: 'Road_T_Intersection' },
  { name: 'junctionX', from: 'Road_X_Intersection' },
];

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

/** Every primitive of the kit, baked into world space, in METRES, by owner. */
const read = async (path) => {
  const doc = await io.read(path);
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    const owner = node.getParentNode()?.getName() || node.getName();
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
        p.set([w[0] / UNITS, w[1] / UNITS, w[2] / UNITS], i * 3);
        if (nrm) {
          nrm.getElement(i, v);
          const d = mulDir(world, v);
          const len = Math.hypot(...d) || 1;
          n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
        }
        if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
      }
      out.push({
        owner,
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
  return out;
};

const kit = await read(KIT);
console.log(`read ${KIT}: ${kit.length} primitives`);

const built = [];
for (const spec of PARTS) {
  const prims = kit.filter((p) => p.owner === spec.from);
  if (!prims.length) throw new Error(`no geometry for ${spec.name} (looked for "${spec.from}")`);
  const whole = boundsOf(prims.map((p) => p.pos));
  // Centred on its footprint and sitting on y = 0: laying one is then an
  // (x, z, turn), and two pieces butt when their edges meet.
  for (const prim of prims) {
    for (let i = 0; i < prim.pos.length; i += 3) {
      prim.pos[i] -= whole.centre[0];
      prim.pos[i + 1] -= whole.min[1];
      prim.pos[i + 2] -= whole.centre[2];
    }
  }
  /*
   * The junction art sits UNDER its own road slab, and has to be lifted out.
   *
   * L, T and X are each two primitives: a 19 m square slab carrying a strip
   * of `City_Road_mat` — measured, the top 14.3% of that texture, which is
   * pavement and a yellow edge line — and a flat `City_Intersection_mat`
   * quad carrying the actual crossroads, with its zebras and its rounded
   * kerbs. In the pack that quad sits at the slab's BOTTOM, 0.1 m below the
   * running surface, so it is completely hidden and every junction renders as
   * a plain grey square of stretched pavement. Which is exactly what they
   * looked like.
   *
   * Raised to a couple of millimetres over the slab's top, which draws it
   * where it belongs and leaves the slab showing only where the quad is
   * smaller than the tile — the L's outer kerb, the T's fourth side. That
   * band is the corner's pavement, so the two are meant to be seen together.
   */
  const top = boundsOf(prims.map((p) => p.pos)).max[1];
  for (const prim of prims) {
    if (prim.material?.getName() !== 'City_Intersection_mat') continue;
    for (let i = 1; i < prim.pos.length; i += 3) prim.pos[i] = top + 0.002;
  }

  const framed = boundsOf(prims.map((p) => p.pos));
  const tris = prims.reduce((n, p) => n + p.idx.length / 3, 0);
  console.log(`  ${spec.name.padEnd(10)} ${framed.size.map((v) => v.toFixed(2)).join(' x ').padEnd(24)} m`
    + `  ${String(Math.round(tris)).padStart(4)} tris  ${prims.length} prim(s)`);
  built.push({ name: spec.name, prims, size: framed.size, tris });
}

/* ------------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('roads');

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
  const m = out.createMaterial(src?.getName() || 'road')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(0)
    // Asphalt, and the markings are painted on it: nothing here is shiny.
    .setRoughnessFactor(0.92)
    .setDoubleSided(false)
    .setAlphaMode('OPAQUE');
  const spec = src?.getExtension('KHR_materials_pbrSpecularGlossiness');
  const tex = await convertTexture(spec?.getDiffuseTexture?.() ?? src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  materials.set(src, m);
  return m;
};

let triangles = 0;
for (const part of built) {
  const mesh = out.createMesh(part.name);
  for (const p of part.prims) {
    const prim = out.createPrimitive();
    prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(p.pos).setBuffer(buffer));
    if (p.nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(p.nrm).setBuffer(buffer));
    if (p.uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(p.uv).setBuffer(buffer));
    prim.setIndices(out.createAccessor().setType('SCALAR').setArray(p.idx).setBuffer(buffer));
    prim.setMaterial(await convertMaterial(p.material));
    mesh.addPrimitive(prim);
    triangles += p.idx.length / 3;
  }
  scene.addChild(out.createNode(part.name).setMesh(mesh));
}

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify({
  unitsPerMetre: UNITS,
  triangles,
  parts: Object.fromEntries(built.map((p) => [p.name, {
    size: p.size.map((v) => +v.toFixed(3)),
    triangles: Math.round(p.tris),
  }])),
}, null, 2)}\n`);
console.log(`wrote ${DST} and ${DATA}: ${Math.round(triangles)} triangles in ${built.length} pieces, `
  + `${textures.size} textures`);
