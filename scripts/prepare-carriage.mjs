/**
 * One-time preprocessor for a passenger carriage — see `STOCK`.
 *
 * The coaches the locomotive hauls (`FORMATION` in `trainConfig`, `TrainRide`).
 * Structurally the same job as `prepare-train.mjs` and deliberately the same
 * shape, so the two can be read side by side: measure every primitive in world
 * space, scale by real length, find the bogie centres from the wheel material,
 * decimate, compact, normalise onto the origin, Draco.
 *
 * Two things differ, and both come from this being a *rake* rather than one
 * vehicle:
 *
 *  1. **The triangle budget is per copy.** Six coaches share one geometry, so
 *     whatever this script leaves is spent six times over on the throughput.
 *     See `TRIANGLE_BUDGET`.
 *
 *  2. **There is no cab, so there is no "which end is forward" test.** A coach
 *     is symmetrical end to end for our purposes, so unlike the locomotive
 *     there is nothing to get backwards. What it does have is an interior — 12 k
 *     triangles of seats and 6 k of ceiling lights — which is worth keeping,
 *     because the cab camera looks back down the train through the windows.
 *
 * One measurement does fall back rather than being taken: the wheels come
 * through as a single cluster, so the bogie centres are the real 16.00 m figure
 * rather than a reading. For a Mark 3 that IS 16.00 m, so the answer is right
 * either way — but it is a fallback, not a measurement, and if the coach ever
 * changes again this is the line to check.
 *
 * Run with: npm run prepare:carriage
 *
 * Writes:
 *   public/models/carriage.glb    Draco-compressed, normalised, decimated.
 *   src/config/carriageData.json  Measured size and bogie centres.
 *
 * Sources, both Sketchfab and both untracked in `source-models/`: the Grand
 * Central Mark 3 that pairs with the Class 43 (a power car at each end of a
 * rake of Mark 3s is an HST, which is the formation `formationFor` builds), and
 * the APT 1st class trailer that pairs with the Class 91.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

/**
 * The coaches this script can build, chosen by
 * `npm run prepare:carriage -- <id>`.
 *
 * One per power car in `prepare-train.mjs`'s `STOCK`, and each reads the width
 * of *its own* locomotive — see the note on the ruler. Getting that pairing
 * wrong would scale a Mark 3 to a Class 91's width, which is the same class of
 * mistake as scaling by the wrong length.
 */
const STOCK = {
  hst: {
    src: 'mark_3_carriage_std_open_grand_central_livery.glb',
    dst: 'public/models/carriage.glb',
    data: 'src/config/carriageData.json',
    loco: 'src/config/trainData.json',
    /** Mark 3: length over body and bogie centres, metres. */
    length: 23,
    bogieCentres: 16,
  },
  apt: {
    src: 'train_-_british_rail_apt_1st_class_carriage.glb',
    dst: 'public/models/carriage91.glb',
    data: 'src/config/carriage91Data.json',
    loco: 'src/config/train91Data.json',
    /** APT-P trailer. */
    length: 22.4,
    bogieCentres: 16,
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
 * The ruler here is the locomotive's width, not the coach's real length — and
 * it is now a belt-and-braces choice rather than a rescue.
 *
 * It was a rescue. The APT upload this replaced measured 20.51 units long by
 * 3.16 wide: a width-to-length ratio of 0.154 against a real coach's 0.122, so
 * 26% too fat for its length with nothing sticking out. Scaling that by length
 * put it 28 cm wider each side than the locomotive it coupled to, which is the
 * error people see; scaling by width made it 18.7 m long, and nobody measures a
 * coach's length by eye. Width won.
 *
 * The Grand Central Mark 3 has no such problem: 23.49 by 2.92 units is a ratio
 * of **0.124** against that real 0.122, so the two rulers finally agree. By
 * width it comes out 23.36 m long against a real Mark 3's 23.00 — 1.6% over —
 * and exactly flush with the power car at the coupling, which is the one
 * comparison a passenger's eye actually makes. So the ruler stays where it is,
 * read out of `trainData.json` so the two cannot drift apart, and it is no
 * longer papering over anything.
 */
const LOCO_DATA = STOCK[WHICH].loco;
const REAL_BOGIE_CENTRES = STOCK[WHICH].bogieCentres;
/** For the sanity line in the log only: what the real coach measures. */
const REAL_LENGTH = STOCK[WHICH].length;

/**
 * Triangle budget — and it is much tighter than the locomotive's, because this
 * one is paid for six times.
 *
 * The source is 274 k. Six of those is 1.6 M triangles of train, on top of a
 * 3 M city, for vehicles that are mostly seen from outside at speed. 45 k a
 * coach is 270 k for the whole rake — about one locomotive — and at that ratio
 * the simplifier is still keeping the window pillars and the roof ribs, which
 * are what makes a coach read as a coach from the lineside.
 *
 * Like the locomotive's, this is a request rather than a promise: the roof and
 * body panels weld into locked borders and give back what they give back.
 */
const TRIANGLE_BUDGET = 45000;

/** Metres of gap that still counts as the same bogie, in source units. */
const BOGIE_CLUSTER = 2.5;

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
      // Sampled rather than exhaustive, for the reason the locomotive's is: a
      // box from 500 spread points is within millimetres at this density.
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
let sourceWidth = worldHi[0] - worldLo[0];
let sourceHeight = worldHi[1] - worldLo[1];
let sourceLength = worldHi[2] - worldLo[2];

/**
 * Which axis the body runs along.
 *
 * The locomotive's export happened to arrive nose-down -Z and the script could
 * assert it. This one cannot be assumed: it is a different upload by a
 * different author. The body is far longer than it is wide or tall, so the
 * longest horizontal extent *is* the length, and if that is X rather than Z the
 * model needs a quarter turn baking in — which is a rotation on the wrapper
 * node, not a rewrite of the vertices.
 */
const alongX = sourceWidth > sourceLength;
if (alongX) {
  step(`body runs along X (${sourceWidth.toFixed(2)} x ${sourceLength.toFixed(2)} units) `
    + '— baking a quarter turn so it faces -Z like everything else');
  [sourceWidth, sourceLength] = [sourceLength, sourceWidth];
}
const loco = JSON.parse(readFileSync(LOCO_DATA, 'utf8'));
const LOCO_WIDTH = loco.size[0];
const SCALE = LOCO_WIDTH / sourceWidth;

const totalBefore = parts.reduce((n, p) => n + p.triangles, 0);
step(`${parts.length} primitives, ${totalBefore.toLocaleString()} triangles`);
step(`source ${sourceLength.toFixed(2)} long x ${sourceWidth.toFixed(2)} wide `
  + `x ${sourceHeight.toFixed(2)} tall units -> scale ${SCALE.toFixed(5)} `
  + `(matching the locomotive's ${LOCO_WIDTH.toFixed(3)} m width)`);
step(`length comes out ${(sourceLength * SCALE).toFixed(2)} m against the real `
  + `${REAL_LENGTH} m — see the note on the ruler`);

// ---------------------------------------------------------------------------
// 2. Bogie centres, from the wheels. Measured along whichever axis is the body.
// ---------------------------------------------------------------------------
const LONG_AXIS = alongX ? 0 : 2;
const WHEEL = /wheel|tyre|tire|bogie/i;
const wheelParts = parts.filter((p) => WHEEL.test(p.material));
let bogieCentres = REAL_BOGIE_CENTRES;
if (wheelParts.length) {
  const along = [];
  for (const part of wheelParts) {
    const position = part.prim.getAttribute('POSITION');
    const count = position.getCount();
    const stride = Math.max(1, Math.floor(count / 3000));
    for (let i = 0; i < count; i += stride) {
      along.push(apply(part.matrix, position.getElement(i, []))[LONG_AXIS]);
    }
  }
  along.sort((a, b) => a - b);
  const clusters = [];
  for (const v of along) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.hi <= BOGIE_CLUSTER) { last.hi = v; last.sum += v; last.n++; }
    else clusters.push({ lo: v, hi: v, sum: v, n: 1 });
  }
  const centres = clusters
    .filter((c) => c.n >= along.length * 0.05)
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
// 3. Decimate, then compact. Both verbatim from `prepare-train.mjs` — see the
//    comments there for why the weld and `LockBorder` are needed.
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
  + `(asked for ${TRIANGLE_BUDGET.toLocaleString()}), `
  + `dropped ${removedVertices.toLocaleString()} orphaned vertices`);

// ---------------------------------------------------------------------------
// 4. Normalise and write.
//
// One node carries the scale to metres, the quarter turn if the body ran along
// X, and the shift that puts the body's centreline on the origin with its
// wheels on y = 0 — which is what `TrainRide` places on the rail head.
// ---------------------------------------------------------------------------
const centreLong = (worldLo[LONG_AXIS] + worldHi[LONG_AXIS]) / 2;
const centreAcross = (worldLo[alongX ? 2 : 0] + worldHi[alongX ? 2 : 0]) / 2;
const normalised = doc.createNode('carriage').setScale([SCALE, SCALE, SCALE]);
if (alongX) {
  // A quarter turn about Y takes +X onto -Z, so the body ends up along Z.
  normalised.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  normalised.setTranslation([centreAcross * SCALE, -worldLo[1] * SCALE, -centreLong * SCALE]);
} else {
  normalised.setTranslation([-centreAcross * SCALE, -worldLo[1] * SCALE, -centreLong * SCALE]);
}
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
  /** Width (X), height (Y), length (Z), metres. */
  size: size.map((v) => +v.toFixed(3)),
  /**
   * Distance between the two bogie centres, metres. The runtime stands each
   * vehicle on the curve at these two points and takes its heading from the
   * chord between them — a coach is 22 m long on a line with 106 m radii, so
   * using the locomotive's 10.5 m here would leave the ends off the rails.
   */
  bogieCentres: +bogieCentres.toFixed(3),
  triangles: totalAfter,
}, null, 2)}\n`);

console.log('\n--- carriage ---');
console.log(`  ${size[2].toFixed(2)} m long  ${size[0].toFixed(2)} m wide  ${size[1].toFixed(2)} m tall`
  + `  ${totalAfter.toLocaleString()} tris`);
console.log(`  bogie centres ${bogieCentres.toFixed(2)} m`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
