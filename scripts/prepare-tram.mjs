/**
 * One-time preprocessor for the Gold Coast G:link tram (Bombardier Flexity 2).
 *
 * This script replaced a much larger one, and the difference is the asset
 * rather than the ambition. The tram before this was a Melbourne C-class whose
 * Sketchfab export was a 2.86 M-triangle SketchUp model authored per
 * *material*, so every mesh in it ran the full length of the vehicle: it had
 * to be visibility-culled from 26 directions, cut into sections triangle by
 * triangle on a measured bellows position, and simplified to a budget. None of
 * that applies here. This export arrives:
 *
 *   - **at 60 594 triangles**, a quarter of the city's own 250 k, so five of
 *     them can run the line at once with nothing decimated and no budget to
 *     share out. Nothing is culled, the interior included — the glazing is
 *     translucent and you can see through it, which is the point.
 *   - **authored per module.** The real vehicle is seven modules on four
 *     bogies, and the file is modelled that way: one node per module, plus its
 *     doors, windows, bogie and wheels as separate nodes sitting at their own
 *     positions along the body. Sections can therefore be made by
 *     **re-parenting nodes**, which means no geometry is rebuilt and the
 *     livery's UVs and textures survive untouched.
 *   - **proportioned correctly.** Scaled by its real 43.5 m length the width
 *     comes out at 2.63 m against a real 2.65 — under a percent, so either
 *     ruler gives the same answer. The C-class export's three rulers disagreed
 *     by 13 % and picking one was a judgement call; here it is not.
 *
 * So all this does is measure, group, normalise and compress:
 *
 *  1. **Drops the export's "Please Read" billboard** — a two-triangle
 *     textured plane the author parked beside the tram, 12 m off to one side.
 *     It has to go before anything is measured or it takes the bounding box
 *     with it, which is also why the width ruler cannot simply be the model's
 *     Z extent.
 *  2. **Finds the seven modules by measurement**, not by node name: the names
 *     lie. There are five distinct `glink_seg*` names for seven modules, they
 *     repeat between the two ends, and the doors named `seg2_*` include the
 *     ones in the middle module. What is reliable is size and position — a
 *     module-scale mesh spans nearly the full body width and metres of its
 *     length — so the module centres are the clusters those meshes fall into.
 *  3. **Assigns every other node to a module by where it sits**, cutting at
 *     the midpoints between module centres. A 45 m rigid body cannot follow
 *     this loop's 10 m corners; seven bodies of about 6 m can. Nothing is cut
 *     geometrically, so a mesh that overhangs its own module (the mirrored
 *     shell halves reach ~0.4 m past the joint) simply overlaps its
 *     neighbour — which is what you want at an articulation joint anyway,
 *     since sections placed at fixed arc-length offsets move *closer* together
 *     on a curve, never further apart.
 *  4. **Sorts the glazing out from the bodywork, by measured texture alpha.**
 *     The export puts the whole tram — bodywork, doors, wheels, bogies and
 *     glazing — on one `BLEND` material, because 8 % of its atlas is the
 *     tinted glass. three.js honours that per *material*: everything on it is
 *     drawn as transparent geometry with no depth write, so the bodyshell
 *     stops occluding anything and you look straight through the roof at the
 *     seats. Culling the interior would not fix it; the roof would still be
 *     see-through.
 *
 *     Splitting by *mesh* is not enough either — that was tried, and it moved
 *     only 42 of 105 primitives, because a module's shell is one mesh whose
 *     UVs cover its window openings as well as its panels. So the split is
 *     **per triangle**, on the alpha its own UVs land on: triangles that never
 *     touch a translucent texel are re-indexed onto an opaque clone of the
 *     material, which writes depth, and the glazing keeps the blend material,
 *     which is what it is for. Only the index buffers are rebuilt; both
 *     primitives share the original's vertices.
 *  5. **Bakes the normalising transform onto each section node**: the quarter
 *     turn that puts the body's +X onto the project's forward -Z, the scale to
 *     metres, and the shift that puts the section's own centre at its origin.
 *     The runtime places a carrier group per section on the rail and leaves
 *     this transform alone — see `RailLoop`. Which end leads is not a decision
 *     to make: a Flexity 2 has a cab at both ends and is symmetric about its
 *     centre.
 *
 * Run with: npm run prepare:tram
 *
 * Writes:
 *   public/models/tram.glb     Draco-compressed, normalised, seven sections.
 *   src/config/tramData.json   Measured size and section offsets.
 *
 * Source `gold_coast_glink_light_rail_tram__flexity_2.glb` (7.8 MB, in
 * `source-models/`, untracked) — Sketchfab, "Gold Coast G:link Light Rail Tram
 * (Flexity 2)".
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('gold_coast_glink_light_rail_tram__flexity_2.glb');
const DST = 'public/models/tram.glb';
const DATA = 'src/config/tramData.json';

/**
 * Real length of a Gold Coast Flexity 2, over couplers, in metres. The model
 * measures 45.04 units, so this is very nearly a 1:1 export; scaling by it
 * lands the width within 1 % of the real 2.65 m, which is the check printed
 * below. Width is what the rail clearances in `railConfig` are reasoned about,
 * so if the two ever disagree by more than a couple of percent, scale by width
 * instead and take the length error.
 */
const REAL_LENGTH = 43.5;
const REAL_WIDTH = 2.65;

/**
 * A mesh counts as module-scale, and therefore as evidence of where a module
 * is, if it spans at least this fraction of the body's width (source Z) and
 * this many source units of its length (source X). Both are deliberately loose: the test only has
 * to separate whole-module meshes (shells, interiors, the mirrored shell
 * halves, the long window strips) from furniture that sits *inside* a module
 * (doors at 0.8 units, wheels at 0.66, the roof aerial at 0.23). The nearest
 * thing to the boundary on either side is a 3.06-unit interior fitting kept in
 * and a 1.47-unit window strip left out.
 */
const MODULE_WIDTH_FRACTION = 0.95;
const MODULE_MIN_LENGTH = 3;

/**
 * How far apart two module-scale meshes may sit and still be the same module.
 * The widest spread within one module is 0.87 units (the cab's shell, its
 * interior, its window strip and its mirrored half all measure slightly
 * differently); the closest two modules get is 5.86, the module pitch. There
 * is a factor of six of daylight here, so this number is not delicate.
 */
const MODULE_CLUSTER = 1.5;

/** The real vehicle: seven modules on four bogies. Asserted, not assumed. */
const MODULES = 7;

/**
 * Alpha at or above this counts as opaque when deciding whether a primitive
 * needs the blend material. The atlas is 8-bit and its solid regions are a
 * flat 255, so this only has to survive PNG rounding; the glass it has to
 * catch is at 107, less than half way.
 */
const OPAQUE_ALPHA = 250;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const step = (msg) => console.log(`  ${msg}`);

const srcSize = readFileSync(SRC).byteLength;
step(`reading ${SRC} (${mb(srcSize)})`);
const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

// ---------------------------------------------------------------------------
// 1. Find the model's own root, under the exporter's wrapper chain.
//
// Sketchfab wraps an FBX conversion in four nodes. The outer two carry equal
// and opposite quarter turns about X — the FBX conversion's Z-up correction
// and its undoing — so they cancel, and the model's own nodes carry the turn
// that actually matters. Everything measured below is therefore in the frame
// those nodes produce: **X along the body** (a cab at each end), **Y up**,
// **Z across it**. The chain is dropped rather than respected, since step 4
// writes a normalising transform that subsumes it; it is asserted to be pure
// rotation first, because a translation or a scale hiding in it would silently
// offset the lot.
// ---------------------------------------------------------------------------
let modelRoot = scene.listChildren()[0];
const chain = [];
while (modelRoot) {
  chain.push(modelRoot);
  const t = modelRoot.getTranslation(), s = modelRoot.getScale();
  if (t.some((v) => v !== 0) || s.some((v) => v !== 1)) {
    throw new Error(`wrapper node "${modelRoot.getName()}" is not pure rotation: `
      + `t=${t} s=${s} — the normalising transform in step 5 assumes it is`);
  }
  const children = modelRoot.listChildren();
  if (children.length !== 1) break;
  modelRoot = children[0];
}
step(`wrapper chain: ${chain.map((n) => n.getName()).join(' > ')}`);

// ---------------------------------------------------------------------------
// 2. Measure every mesh node, in the source's frame, and drop the billboard.
// ---------------------------------------------------------------------------
const BILLBOARD = /please\s*read/i;

const mul = (A, B) => {
  const C = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += A[i + k * 4] * B[k + j * 4];
      C[i + j * 4] = sum;
    }
  }
  return C;
};

const localMatrix = (node) => {
  const [x, y, z, w] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  const [tx, ty, tz] = node.getTranslation();
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  const M = mul(R, [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
  M[12] = tx; M[13] = ty; M[14] = tz;
  return M;
};

const apply = (M, p) => [0, 1, 2].map((j) => M[j] * p[0] + M[j + 4] * p[1] + M[j + 8] * p[2] + M[j + 12]);

/** Every mesh node under `modelRoot`, with its bounds and triangles. */
const parts = [];
let billboards = 0;

/** The top-level nodes to be re-parented: one subtree per part of the tram. */
const groups = modelRoot.listChildren();

for (const group of groups) {
  if (BILLBOARD.test(group.getName())) {
    // Disposed here rather than left out of the sections, so its material and
    // its 500 KB texture are unreferenced by the time step 5 sweeps.
    for (const node of [group, ...group.listChildren()]) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      billboards += 1;
      node.setMesh(null);
      // Primitives have to go by hand: disposing a Mesh does not dispose them,
      // and a surviving Primitive keeps its material — and therefore the
      // billboard's half-megabyte of texture — referenced through the sweep in
      // step 5 and into the file.
      for (const prim of mesh.listPrimitives()) { mesh.removePrimitive(prim); prim.dispose(); }
      mesh.dispose();
    }
    group.dispose();
    continue;
  }
  const measured = [];
  (function walk(node, parent) {
    const M = mul(parent, localMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      let triangles = 0;
      for (const prim of mesh.listPrimitives()) {
        const P = prim.getAttribute('POSITION');
        const indices = prim.getIndices();
        triangles += (indices ? indices.getCount() : P.getCount()) / 3;
        const p = [0, 0, 0];
        for (let i = 0; i < P.getCount(); i++) {
          P.getElement(i, p);
          const w = apply(M, p);
          for (let k = 0; k < 3; k++) {
            if (w[k] < lo[k]) lo[k] = w[k];
            if (w[k] > hi[k]) hi[k] = w[k];
          }
        }
      }
      measured.push({ name: node.getName(), lo, hi, triangles });
    }
    for (const child of node.listChildren()) walk(child, M);
  }(group, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));

  if (!measured.length) continue;
  const lo = [0, 1, 2].map((k) => Math.min(...measured.map((m) => m.lo[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...measured.map((m) => m.hi[k])));
  parts.push({
    node: group,
    name: group.getName(),
    lo, hi,
    triangles: measured.reduce((a, m) => a + m.triangles, 0),
    meshes: measured,
  });
}
step(`dropped ${billboards} billboard mesh${billboards === 1 ? '' : 'es'} ("Please Read")`);

const modelLo = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.lo[k])));
const modelHi = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.hi[k])));
const sourceLength = modelHi[0] - modelLo[0];
const sourceHeight = modelHi[1] - modelLo[1];
const sourceWidth = modelHi[2] - modelLo[2];
const SCALE = REAL_LENGTH / sourceLength;
const totalTriangles = parts.reduce((a, p) => a + p.triangles, 0);

step(`${parts.length} parts, ${totalTriangles.toLocaleString()} triangles`);
step(`source ${sourceLength.toFixed(2)} long x ${sourceWidth.toFixed(2)} wide `
  + `x ${sourceHeight.toFixed(2)} tall units -> scale ${SCALE.toFixed(5)}`);

// ---------------------------------------------------------------------------
// 3. Find the module centres, then bucket every part into a module.
// ---------------------------------------------------------------------------
const moduleScale = [];
for (const part of parts) {
  for (const mesh of part.meshes) {
    const width = mesh.hi[2] - mesh.lo[2];
    const length = mesh.hi[0] - mesh.lo[0];
    if (width >= sourceWidth * MODULE_WIDTH_FRACTION && length >= MODULE_MIN_LENGTH) {
      moduleScale.push({ centre: (mesh.lo[0] + mesh.hi[0]) / 2, width, name: mesh.name });
    }
  }
}
moduleScale.sort((a, b) => a.centre - b.centre);

/**
 * The width check, and why it is not simply the model's Z extent: that is set
 * by the wing mirrors, which stand 7 cm proud of the bodywork on each side. So
 * the bodyshell is measured as the *median* module's own width — a median
 * cannot be moved by a mirror or an aerial — and it is that figure the real
 * 2.65 m is compared against. `size[0]` keeps the full extent regardless,
 * deliberately: the collider should cover the mirrors.
 */
const widths = moduleScale.map((m) => m.width).sort((a, b) => a - b);
const bodyWidth = widths[Math.floor(widths.length / 2)] * SCALE;
step(`width check: bodyshell ${bodyWidth.toFixed(3)} m against a real ${REAL_WIDTH} m `
  + `(${((bodyWidth / REAL_WIDTH - 1) * 100).toFixed(1)}%); full extent `
  + `${(sourceWidth * SCALE).toFixed(3)} m over the wing mirrors`);

const clusters = [];
for (const m of moduleScale) {
  const last = clusters[clusters.length - 1];
  if (last && m.centre - last[last.length - 1].centre <= MODULE_CLUSTER) last.push(m);
  else clusters.push([m]);
}
const centres = clusters.map((c) => (c[0].centre + c[c.length - 1].centre) / 2);

if (centres.length !== MODULES) {
  console.error(`\nfound ${centres.length} module clusters, expected ${MODULES}:`);
  for (const c of clusters) {
    console.error(`  ${((c[0].centre + c[c.length - 1].centre) / 2).toFixed(2)}  `
      + c.map((m) => m.name).join(', '));
  }
  throw new Error('module detection failed — see the clusters above and the constants '
    + 'MODULE_WIDTH_FRACTION / MODULE_MIN_LENGTH / MODULE_CLUSTER');
}
const pitch = centres.slice(1).map((c, i) => c - centres[i]);
step(`${centres.length} modules at ${centres.map((c) => c.toFixed(2)).join(', ')} units `
  + `(pitch ${pitch.map((p) => p.toFixed(2)).join('/')})`);

/** Cut planes: halfway between neighbouring module centres. */
const cuts = centres.slice(1).map((c, i) => (c + centres[i]) / 2);
const moduleOf = (x) => {
  let i = 0;
  while (i < cuts.length && x >= cuts[i]) i++;
  return i;
};

const sections = centres.map(() => []);
for (const part of parts) sections[moduleOf((part.lo[0] + part.hi[0]) / 2)].push(part);

// ---------------------------------------------------------------------------
// 4. Re-index the glazing away from the bodywork.
//
// See the header. Each triangle on a blend material is sampled at its three
// vertex UVs and at its centroid; if none of those four is translucent, the
// triangle is moved to an opaque clone of the material. A primitive that comes
// out mixed is split in two, sharing its vertex attributes and differing only
// in indices.
// ---------------------------------------------------------------------------
const alphaCache = new Map();

async function alphaMap(texture) {
  if (alphaCache.has(texture)) return alphaCache.get(texture);
  const image = sharp(Buffer.from(texture.getImage()));
  const meta = await image.metadata();
  let map = null;
  if (meta.hasAlpha) {
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = new Uint8Array(info.width * info.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * info.channels + 3];
    map = { alpha, width: info.width, height: info.height };
  }
  alphaCache.set(texture, map);
  return map;
}

/** Alpha under one UV. glTF UVs are top-down and the export's sampler repeats. */
const alphaAt = (map, u, v) => {
  const wrap = (t) => ((t % 1) + 1) % 1;
  const x = Math.min(map.width - 1, Math.floor(wrap(u) * map.width));
  const y = Math.min(map.height - 1, Math.floor(wrap(v) * map.height));
  return map.alpha[y * map.width + x];
};

const primBuffer = root.listBuffers()[0] ?? doc.createBuffer();
const opaqueClones = new Map();
let opaqueTris = 0, blendTris = 0, splitPrims = 0;

for (const mesh of root.listMeshes()) {
  for (const prim of [...mesh.listPrimitives()]) {
    const material = prim.getMaterial();
    if (!material || material.getAlphaMode() !== 'BLEND') continue;
    const texture = material.getBaseColorTexture();
    const uv = prim.getAttribute('TEXCOORD_0');
    const map = texture ? await alphaMap(texture) : null;
    const indices = prim.getIndices();
    if (!map || !uv || !indices) continue;

    const index = indices.getArray();
    const opaque = [], blended = [];
    const t = [0, 0], a = [0, 0], b = [0, 0], c = [0, 0];
    for (let i = 0; i < index.length; i += 3) {
      uv.getElement(index[i], a);
      uv.getElement(index[i + 1], b);
      uv.getElement(index[i + 2], c);
      const samples = [a, b, c, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]];
      const translucent = samples.some((s) => alphaAt(map, s[0], s[1]) < OPAQUE_ALPHA);
      (translucent ? blended : opaque).push(index[i], index[i + 1], index[i + 2]);
      void t;
    }
    opaqueTris += opaque.length / 3;
    blendTris += blended.length / 3;
    if (!opaque.length) continue;

    let clone = opaqueClones.get(material);
    if (!clone) {
      clone = doc.createMaterial(`${material.getName()}_opaque`).copy(material).setAlphaMode('OPAQUE');
      opaqueClones.set(material, clone);
    }

    const indexAccessor = (array) => doc.createAccessor()
      .setType('SCALAR').setArray(new Uint32Array(array)).setBuffer(primBuffer);

    if (!blended.length) {
      // Wholly opaque: the material swap is the whole fix.
      prim.setMaterial(clone);
      continue;
    }
    // Mixed: the opaque half becomes a second primitive over the same
    // vertices, and the original keeps only its translucent triangles.
    const half = doc.createPrimitive().setMaterial(clone).setIndices(indexAccessor(opaque));
    for (const semantic of prim.listSemantics()) half.setAttribute(semantic, prim.getAttribute(semantic));
    half.setMode(prim.getMode());
    mesh.addPrimitive(half);
    prim.setIndices(indexAccessor(blended));
    splitPrims += 1;
  }
}
step(`transparency: ${opaqueTris.toLocaleString()} triangles made opaque against `
  + `${blendTris.toLocaleString()} left blended (the glazing), `
  + `${splitPrims} primitives split, ${opaqueClones.size} materials cloned`);

// ---------------------------------------------------------------------------
// 5. Re-parent each module's parts onto one section node, and normalise it.
//
// The section node's transform is  K * R * T(-centre), which the runtime never
// touches:
//
//   R  turns the source frame onto the project's: a quarter turn about Y that
//      takes source X (along the body) onto world -Z, which is forward here,
//      and source Z (across it) onto world +X. Up is already up. Turning the
//      other way would land X on -Z just as well but take Z onto -X, which is
//      a mirror rather than a rotation, and would put the tram's doors on the
//      wrong side of the street.
//   K  is the uniform scale to metres.
//   T  puts this section's own centre at its origin, so the runtime can place
//      each one on the rail independently and the tram bends.
//
// As TRS: rotation is the quaternion of R, scale is uniform, and translation
// is -K*R*centre, which works out as (-K*cz, -K*groundY, K*cx).
// ---------------------------------------------------------------------------
const ROTATION = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const centreX = (modelLo[0] + modelHi[0]) / 2;
const groundY = modelLo[1];
const centreZ = (modelLo[2] + modelHi[2]) / 2;

const emitted = [];
for (let s = 0; s < sections.length; s++) {
  const own = sections[s];
  const lo = [0, 1, 2].map((k) => Math.min(...own.map((p) => p.lo[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...own.map((p) => p.hi[k])));
  const cx = (lo[0] + hi[0]) / 2;

  const node = doc.createNode(`tram_s${s}`)
    .setRotation(ROTATION)
    .setScale([SCALE, SCALE, SCALE])
    .setTranslation([-centreZ * SCALE, -groundY * SCALE, cx * SCALE]);
  for (const part of own) node.addChild(part.node);
  scene.addChild(node);

  emitted.push({
    name: node.getName(),
    // Positive towards the front, which is -Z: see R above.
    offset: +((cx - centreX) * SCALE).toFixed(4),
    // Kept for the report; not written to the config.
    lo, hi, triangles: own.reduce((a, p) => a + p.triangles, 0), parts: own.length,
  });
}

// ---------------------------------------------------------------------------
// 6. Sweep what nothing references any more, and write.
// ---------------------------------------------------------------------------
const reachable = new Set();
(function mark(nodes) {
  for (const node of nodes) { reachable.add(node); mark(node.listChildren()); }
}(scene.listChildren()));
let dropped = 0;
for (const node of root.listNodes()) if (!reachable.has(node)) { node.dispose(); dropped += 1; }
for (const mesh of root.listMeshes()) if (mesh.listParents().length <= 1) mesh.dispose();
for (const accessor of root.listAccessors()) if (accessor.listParents().length <= 1) accessor.dispose();
for (const material of root.listMaterials()) if (material.listParents().length <= 1) material.dispose();
for (const texture of root.listTextures()) if (texture.listParents().length <= 1) texture.dispose();
step(`swept ${dropped} wrapper nodes; kept ${root.listMaterials().length} materials, `
  + `${root.listTextures().length} textures`);

doc.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    encodeSpeed: 5, decodeSpeed: 5,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });

await io.write(DST, doc);

const size = [sourceWidth * SCALE, sourceHeight * SCALE, sourceLength * SCALE];
const spacings = emitted.slice(1).map((e, i) => e.offset - emitted[i].offset);
const longest = Math.max(...emitted.map((e) => (e.hi[0] - e.lo[0]) * SCALE));

writeFileSync(DATA, JSON.stringify({
  model: '/models/tram.glb',
  /** Width (X), height (Y), length (Z), metres. Height is to the roof aerial. */
  size: size.map((v) => +v.toFixed(3)),
  /**
   * One entry per articulated section, nose last. `offset` is metres along the
   * tram from its centre, positive towards the front — the runtime places each
   * section that much further along the rail, which is what lets the tram
   * bend.
   */
  sections: emitted.map(({ name, offset }) => ({ name, offset })),
  triangles: totalTriangles,
}, null, 2) + '\n');

console.log('\n--- tram ---');
console.log(`  ${size[2].toFixed(2)} m long  ${size[0].toFixed(2)} m wide  ${size[1].toFixed(2)} m tall`
  + `  ${totalTriangles.toLocaleString()} tris`);
for (const e of emitted) {
  console.log(`  ${e.name}  offset ${e.offset.toFixed(2).padStart(7)} m  `
    + `${((e.hi[0] - e.lo[0]) * SCALE).toFixed(2)} m long  `
    + `${String(e.parts).padStart(3)} parts  ${e.triangles.toLocaleString().padStart(6)} tris`);
}
console.log(`  spacing ${spacings.map((s) => s.toFixed(2)).join('/')} m, longest section ${longest.toFixed(2)} m`);
console.log(`  suggested RAIL.minTramGap ${(size[2] + 6).toFixed(0)}`
  + `, TRAM.sectionCollider ${(Math.max(...spacings) * 1.05).toFixed(1)}`
  + `, tramTraffic FOULING ${(size[2] / 2 + 6).toFixed(0)}`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
