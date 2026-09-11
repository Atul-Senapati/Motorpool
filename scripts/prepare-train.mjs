/**
 * One-time preprocessor for a main-line power car — see `STOCK`.
 *
 * The locomotive that runs the main line (`find-train-route.mjs`,
 * `TrainLine.tsx`). Far less work than the tram needed: this is one rigid
 * vehicle, not seven articulated modules, and the export arrives already in the
 * project's frame — X across, Y up, **nose towards -Z**, which is the direction
 * everything else in this game calls forward — or arrives facing the other way
 * and gets a half turn baked in (see `HALF_TURN`). Either way there is no
 * sectioning to do.
 *
 * What it does have is 594,813 triangles, well over twice the whole city, so
 * the substance of this script is:
 *
 *  1. **Measure it in world space**, walking the node transforms, so the
 *     exporter's wrapper chain is accounted for rather than assumed away.
 *  2. **Work out which end the cab is** from the height profile rather than
 *     from a node name, and turn the model if it is the wrong way round. A
 *     power car is a raked wedge at one end and a flat slab at the other; the
 *     wedge is where the roof line falls away, and that has to agree with -Z or
 *     the train runs backwards round the loop for ever. This export faces +Z,
 *     so a half turn is baked in — see `HALF_TURN`.
 *  3. **Find the bogie centres** by clustering the wheel material's triangles
 *     along the body. The runtime stands the locomotive on *two* points of the
 *     curve rather than one — see `trainData.bogieCentres` — so this is a
 *     measurement the renderer actually depends on, not a statistic.
 *  4. **Decimate as far as it will go**, then drop the vertices nothing
 *     references any more. Simplifying alone only rewrites indices, so without
 *     the compaction Draco faithfully compresses geometry that is never drawn.
 *     "As far as it will go" is 192 k of 595 k, and why it stops there is
 *     documented on `TRIANGLE_BUDGET`.
 *
 * Run with: npm run prepare:train
 *
 * Writes:
 *   public/models/train.glb     Draco-compressed, normalised, decimated.
 *   src/config/trainData.json   Measured size and bogie centres.
 *
 * Source `train_-_grand_central_class_43.glb` (27 MB, `source-models/`, untracked) —
 * Sketchfab, "Train - Grand Central Class 43". Paired with the Grand Central
 * Mark 3 in `prepare-carriage.mjs`: an HST is a power car at each end of a rake
 * of Mark 3s, which is exactly the formation `formationFor` already builds.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

/**
 * The stock this script can build, chosen by `npm run prepare:train -- <id>`.
 *
 * Two power cars rather than one, because the game keeps both: the HST is the
 * default and the Class 91 is still selectable in the garage. They differ in
 * every measurement that matters, so the real dimensions live here beside the
 * source rather than as module constants that would have to be edited back and
 * forth — editing a ruler to build a different vehicle is how you end up with a
 * Class 43 scaled to a Class 91's length, which is exactly what happened once.
 */
const STOCK = {
  hst: {
    src: 'train_-_grand_central_class_43.glb',
    dst: 'public/models/train.glb',
    data: 'src/config/trainData.json',
    /** Class 43: length over buffers, body width, bogie centres, metres. */
    length: 17.79,
    width: 2.74,
    bogieCentres: 10.34,
  },
  ic225: {
    src: 'train_-_british_rail_class_91_power_car.glb',
    dst: 'public/models/train91.glb',
    data: 'src/config/train91Data.json',
    /** Class 91. */
    length: 19.4,
    width: 2.74,
    bogieCentres: 10.5,
  },
};

const WHICH = process.argv[2] ?? 'hst';
if (!STOCK[WHICH]) {
  throw new Error(`unknown stock "${WHICH}" — expected one of ${Object.keys(STOCK).join(', ')}`);
}
const SRC = source(STOCK[WHICH].src);
const DST = STOCK[WHICH].dst;
const DATA = STOCK[WHICH].data;

/**
 * Real dimensions of the chosen power car, from `STOCK`: length over buffers,
 * body width, and the distance between bogie centres.
 *
 * Length is the ruler, and it is worth showing what happens when the wrong one
 * is used. These were the Class 91's — 19.4 m — and against this export that
 * put the body 15.6% wider than a real power car and 4.37 m tall. At the Class
 * 43's own 17.79 m the same measurement comes out 5.9% over on width and
 * **4.00 m** tall against a real 3.90, which is the mirrors and the horns in
 * the extent rather than a fat body. A scale that is wrong shows up in the
 * dimensions it was not fitted to; these two now agree.
 *
 * Scaling by width instead would take 6% off the length, and a locomotive a
 * metre short is more obviously wrong than one whose mirrors stick out.
 */
const REAL_LENGTH = STOCK[WHICH].length;
const REAL_WIDTH = STOCK[WHICH].width;
const REAL_BOGIE_CENTRES = STOCK[WHICH].bogieCentres;

/**
 * Triangle budget for the finished locomotive — a request, not a promise.
 *
 * The simplifier gets this export's 595 k down to 192 k and will not go further
 * whatever it is asked for, because a handful of primitives do not
 * decimate: they give back 35,005 of 35,269 and the like, a fraction of a
 * percent, and they do it at every target and every target error. Welding by
 * position was the obvious suspect — 65,533 vertices over 13,492 distinct
 * positions is a lot of duplication — but welding makes it *worse*, both
 * exactly and with a tolerance, and it takes the roof meshes (which decimate
 * perfectly well as they are, 72 k -> 11 k) down with it. So this number sets
 * the per-primitive ratio and the result is measured and printed rather than
 * assumed.
 *
 * 192 k against a 250 k city is heavy for one vehicle, but what costs is how
 * many are **on screen at once** rather than how many exist — see
 * `TRAIN.count`, which is four services a road and spreads them round a 9.2 km
 * loop. Getting it lower needs the visibility cull the Melbourne tram had.
 */
const TRIANGLE_BUDGET = 70000;

/** How close two wheel clusters must be to count as one bogie, in source units. */
const BOGIE_CLUSTER = 2.5;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await MeshoptSimplifier.ready;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const step = (msg) => console.log(`  ${msg}`);

const srcSize = readFileSync(SRC).byteLength;
step(`reading ${SRC} (${mb(srcSize)})`);
const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

// ---------------------------------------------------------------------------
// 1. Measure every primitive in world space.
// ---------------------------------------------------------------------------
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
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const parts = [];
(function walk(node, parent) {
  const m = mul(parent, node.getMatrix());
  const mesh = node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      const count = position.getCount();
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      // Sampled, not exhaustive: 661 k triangles is a lot to walk twice, and a
      // bounding box from 500 spread points is within millimetres of the true
      // one for meshes of this density.
      const stride = Math.max(1, Math.floor(count / 500));
      for (let i = 0; i < count; i += stride) {
        const p = apply(m, position.getElement(i, []));
        for (let k = 0; k < 3; k++) {
          if (p[k] < lo[k]) lo[k] = p[k];
          if (p[k] > hi[k]) hi[k] = p[k];
        }
      }
      parts.push({
        prim,
        matrix: m,
        material: prim.getMaterial()?.getName() ?? '',
        triangles: prim.getIndices() ? prim.getIndices().getCount() / 3 : count / 3,
        lo,
        hi,
      });
    }
  }
  for (const child of node.listChildren()) walk(child, m);
}(scene.listChildren()[0] ?? scene, IDENTITY));
if (!parts.length) throw new Error('no meshes found in the source');

const worldLo = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.lo[k])));
const worldHi = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.hi[k])));
const sourceWidth = worldHi[0] - worldLo[0];
const sourceHeight = worldHi[1] - worldLo[1];
const sourceLength = worldHi[2] - worldLo[2];
const SCALE = REAL_LENGTH / sourceLength;

const totalBefore = parts.reduce((n, p) => n + p.triangles, 0);
step(`${parts.length} primitives, ${totalBefore.toLocaleString()} triangles`);
step(`source ${sourceLength.toFixed(2)} long x ${sourceWidth.toFixed(2)} wide `
  + `x ${sourceHeight.toFixed(2)} tall units -> scale ${SCALE.toFixed(5)}`);
step(`width check: ${(sourceWidth * SCALE).toFixed(2)} m against a real ${REAL_WIDTH} m `
  + `(${((sourceWidth * SCALE) / REAL_WIDTH - 1) * 100 > 0 ? '+' : ''}`
  + `${(((sourceWidth * SCALE) / REAL_WIDTH - 1) * 100).toFixed(1)}%)`);

// ---------------------------------------------------------------------------
// 2. Which end is the cab.
//
// Read off the roof line, not off a node name. A Class 91 is a raked wedge at
// the cab end and a flat slab at the other, so the roof falls away over the
// last couple of metres of the nose and does not at the tail. Getting this
// wrong is not subtle — the locomotive would run the whole loop backwards —
// but it is also not something to take on trust, hence the check.
// ---------------------------------------------------------------------------
const BINS = 20;
const roof = new Array(BINS).fill(-Infinity);
for (const part of parts) {
  const position = part.prim.getAttribute('POSITION');
  const count = position.getCount();
  const stride = Math.max(1, Math.floor(count / 600));
  for (let i = 0; i < count; i += stride) {
    const p = apply(part.matrix, position.getElement(i, []));
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(
      ((p[2] - worldLo[2]) / sourceLength) * BINS,
    )));
    if (p[1] > roof[b]) roof[b] = p[1];
  }
}
const nose = (roof[0] + roof[1]) / 2;
const tail = (roof[BINS - 1] + roof[BINS - 2]) / 2;
step(`roof line: ${nose.toFixed(2)} at -Z, ${tail.toFixed(2)} at +Z`);
/**
 * Whether the model has to be turned end for end.
 *
 * This used to throw, on the grounds that the Class 91 export happened to
 * arrive facing the right way and a model that did not should be fixed at
 * source. The Grand Central Class 43 arrives facing the other way — its raked
 * nose is at +Z, roof 2.79 against 4.22 at the tail — and turning a 27 MB
 * export by hand to satisfy a script is the wrong way round. The half turn is
 * one quaternion on the node this script already writes, so it bakes it.
 *
 * Which end is the cab is still read off the ROOF LINE rather than a node name:
 * a power car is a raked wedge at the cab and a flat slab at the other end, so
 * the roof falls away over the last couple of metres of the nose. Getting it
 * wrong is not subtle — the locomotive would run the whole loop backwards.
 */
const HALF_TURN = nose >= tail;
step(HALF_TURN
  ? `cab is at +Z; baking a half turn so it faces -Z, which is forward`
  : 'cab is at -Z, which is forward — no rotation needed');

// ---------------------------------------------------------------------------
// 3. Bogie centres, from the wheels.
// ---------------------------------------------------------------------------
const WHEEL = /wheel|tyre|tire/i;
const wheelParts = parts.filter((p) => WHEEL.test(p.material));
let bogieCentres = REAL_BOGIE_CENTRES;
if (wheelParts.length) {
  // The wheels are one merged mesh spanning the whole body, so the clusters
  // have to come from the vertices rather than from the primitive bounds.
  const zs = [];
  for (const part of wheelParts) {
    const position = part.prim.getAttribute('POSITION');
    const count = position.getCount();
    const stride = Math.max(1, Math.floor(count / 3000));
    for (let i = 0; i < count; i += stride) zs.push(apply(part.matrix, position.getElement(i, []))[2]);
  }
  zs.sort((a, b) => a - b);
  const clusters = [];
  for (const z of zs) {
    const last = clusters[clusters.length - 1];
    if (last && z - last.hi <= BOGIE_CLUSTER) { last.hi = z; last.sum += z; last.n++; }
    else clusters.push({ lo: z, hi: z, sum: z, n: 1 });
  }
  const centres = clusters
    .filter((c) => c.n >= zs.length * 0.05)
    .map((c) => c.sum / c.n);
  if (centres.length >= 2) {
    bogieCentres = (centres[centres.length - 1] - centres[0]) * SCALE;
    step(`${centres.length} wheel clusters at ${centres.map((c) => c.toFixed(2)).join(', ')} units`);
  } else {
    step(`only ${centres.length} wheel cluster(s) found; falling back to the real figure`);
  }
}
step(`bogie centres ${bogieCentres.toFixed(2)} m against a real ${REAL_BOGIE_CENTRES} m`);

// ---------------------------------------------------------------------------
// 4. Decimate, then compact.
// ---------------------------------------------------------------------------
const ratio = Math.min(1, TRIANGLE_BUDGET / totalBefore);
if (ratio < 1) {
  for (const part of parts) {
    const prim = part.prim;
    const indexAccessor = prim.getIndices();
    if (!indexAccessor) continue;
    const indices = Uint32Array.from(indexAccessor.getArray());
    const positions = Float32Array.from(prim.getAttribute('POSITION').getArray());
    const target = Math.max(3, Math.floor((indices.length / 3) * ratio)) * 3;
    if (target >= indices.length) continue;

    // Weld by position before simplifying. The export is split per triangle
    // corner, so every edge in it is a *border* edge as far as the simplifier
    // can tell, and LockBorder then locks the entire mesh: asked for 11% the
    // first run gave back 42%, having collapsed almost nothing. Remapping the
    // indices onto one vertex per position tells it which edges are really
    // borders. The attribute arrays are left alone — the remapped indices
    // still address them — so a corner that carried two different UVs keeps
    // whichever of them the canonical vertex holds.
    // LockBorder: panels meet along seams that crack open the moment an edge
    // vertex moves — the same setting the tram needed. It costs about 8% here
    // (276 k against 254 k without) and is worth it on a vehicle the camera
    // gets this close to.
    const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.05, ['LockBorder']);
    indexAccessor.setArray(simplified);
  }
}

const buffer = root.listBuffers()[0] ?? doc.createBuffer();
let removedVertices = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const indexAccessor = prim.getIndices();
    if (!indexAccessor) continue;
    const indices = indexAccessor.getArray();
    const count = prim.getAttribute('POSITION').getCount();
    const remap = new Int32Array(count).fill(-1);
    let next = 0;
    for (let i = 0; i < indices.length; i++) {
      if (remap[indices[i]] === -1) remap[indices[i]] = next++;
    }
    if (next === count) continue;
    removedVertices += count - next;

    for (const semantic of prim.listSemantics()) {
      const attribute = prim.getAttribute(semantic);
      const src = attribute.getArray();
      const stride = attribute.getElementSize();
      const dst = new src.constructor(next * stride);
      for (let i = 0; i < count; i++) {
        if (remap[i] < 0) continue;
        for (let k = 0; k < stride; k++) dst[remap[i] * stride + k] = src[i * stride + k];
      }
      prim.setAttribute(semantic, doc.createAccessor()
        .setType(attribute.getType()).setArray(dst).setBuffer(buffer));
      attribute.dispose();
    }
    const rebuilt = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) rebuilt[i] = remap[indices[i]];
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(rebuilt).setBuffer(buffer));
    indexAccessor.dispose();
  }
}
const totalAfter = root.listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices() ? p.getIndices().getCount() / 3 : 0), 0);
step(`decimated ${totalBefore.toLocaleString()} -> ${totalAfter.toLocaleString()} triangles `
  + `(asked for ${TRIANGLE_BUDGET.toLocaleString()}; see TRIANGLE_BUDGET), `
  + `dropped ${removedVertices.toLocaleString()} orphaned vertices`);

// ---------------------------------------------------------------------------
// 5. Normalise and write.
//
// One node over the whole model carries the scale to metres, the half turn if
// the export faces the wrong way (step 2), and the shift that puts the body's
// centreline on the origin and its wheels on y = 0. The existing wrapper chain
// keeps its own transforms underneath and is simply scaled with everything else.
//
// A glTF node applies T, then R, then S, so the translation is in the ROTATED
// frame: with the half turn in, `T` has to be `R * T` or the model is turned
// about the origin and swings a body length away from it. A half turn about Y
// maps (x, y, z) to (-x, y, -z), so that is a sign flip on X and Z and Y left
// alone — which is also why the measured size needs no adjustment.
// ---------------------------------------------------------------------------
const centreX = (worldLo[0] + worldHi[0]) / 2;
const centreZ = (worldLo[2] + worldHi[2]) / 2;
const turn = HALF_TURN ? -1 : 1;
const normalised = doc.createNode('train')
  .setScale([SCALE, SCALE, SCALE])
  .setRotation(HALF_TURN ? [0, 1, 0, 0] : [0, 0, 0, 1])
  .setTranslation([turn * -centreX * SCALE, -worldLo[1] * SCALE, turn * -centreZ * SCALE]);
for (const child of scene.listChildren()) {
  scene.removeChild(child);
  normalised.addChild(child);
}
scene.addChild(normalised);

doc.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    encodeSpeed: 5,
    decodeSpeed: 5,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });
await io.write(DST, doc);

const size = [sourceWidth * SCALE, sourceHeight * SCALE, sourceLength * SCALE];
writeFileSync(DATA, `${JSON.stringify({
  // Derived from `DST`, not written out again: hardcoding it meant the
  // Class 91's data file pointed at the HST's model, which is a swap that
  // type-checks and renders and is simply the wrong train.
  model: `/${DST.replace(/^public\//, '')}`,
  /** Width (X), height (Y), length (Z), metres. Height is to the raised pantograph. */
  size: size.map((v) => +v.toFixed(3)),
  /**
   * Distance between the two bogie centres, metres. The runtime stands the
   * locomotive on the curve at these two points and takes its heading from the
   * chord between them, which is how a bogied vehicle actually sits on track —
   * placing it on one point instead swings the long ends off the rails through
   * every corner.
   */
  bogieCentres: +bogieCentres.toFixed(3),
  triangles: totalAfter,
}, null, 2)}\n`);

console.log('\n--- train ---');
console.log(`  ${size[2].toFixed(2)} m long  ${size[0].toFixed(2)} m wide  ${size[1].toFixed(2)} m tall`
  + `  ${totalAfter.toLocaleString()} tris`);
console.log(`  bogie centres ${bogieCentres.toFixed(2)} m`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
