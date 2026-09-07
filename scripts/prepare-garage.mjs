/**
 * One-time preprocessor for the drivable garage.
 *
 * Six Sketchfab exports, no two authored alike: two are in ~0.01-unit space,
 * the Peterbilt is Z-up, lengths run down X on some and Z on others, and the
 * naming conventions share nothing. Rather than hand-rig each the way
 * `prepare-model.mjs` had to for the McLaren, this script measures every model
 * and normalises it against a stated real-world length.
 *
 * Everything is baked to world space in one pass first. That is the whole
 * trick: once the node transforms are flattened into the vertices, finding the
 * wheels and building pivots for them is plain arithmetic instead of an
 * exercise in compensating for arbitrary ancestor transforms.
 *
 * Wheels are found geometrically, not by name — a wheel is a chunk of geometry
 * near the ground, roughly circular seen from the side, that has a mirror twin
 * across the centreline. Where the export merges its wheels into the body they
 * cannot be separated at all; those cars still drive (Rapier's raycast vehicle
 * only wants pivot positions and radii, which are estimated from the body's
 * proportions) but their wheels do not visibly turn. `hasWheelPivots` in the
 * emitted data records which is which.
 *
 * Emits:
 *   public/models/garage/<id>.glb   normalised, simplified, Draco-compressed
 *   src/config/garageData.json      per-vehicle geometry and physics inputs
 *
 * Run with: npm run prepare:garage
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT_DIR = 'public/models/garage';
const DATA = 'src/config/garageData.json';

/** Triangles a player car may cost. The McLaren, the reference, is 78 k. */
const TRIANGLE_BUDGET = 130_000;
const TEXTURE_SIZE = 1024;

/**
 * The garage.
 *
 * `length` is the real vehicle's length in metres and is what sets each
 * model's scale — the exports' own units mean nothing. `mass` is the real kerb
 * weight; the suspension and engine are derived from it at runtime.
 *
 * `flip` turns a model that ends up facing backwards and `upsideDown` rights
 * one that lands on its roof. Neither which end is the nose nor which way up a
 * model was authored can be told reliably from geometry, so both are stated
 * facts per vehicle, checked by looking at the car.
 */
const GARAGE = [
  {
    id: 'camaro', file: '1967_chevy_camaro_ss_hidden_jewel.glb',
    label: 'Chevrolet Camaro SS', year: 1967,
    length: 4.72, mass: 1500, drive: 'rwd', flip: true,
  },
  {
    id: 'canyon', file: '2023_gmc_canyon_at4x.glb',
    label: 'GMC Canyon AT4X', year: 2023,
    length: 5.38, mass: 2300, drive: 'awd', flip: true,
  },
  {
    id: 'porsche', file: '2024_porsche_992_gt3_r.glb',
    label: 'Porsche 992 GT3 R', year: 2024,
    length: 4.62, mass: 1250, drive: 'rwd', flip: true,
  },
  {
    id: 'bmw', file: '2005_bmw_m3_gtr_need_for_speed_most_wanted.glb',
    label: 'BMW M3 GTR', year: 2005,
    length: 4.49, mass: 1495, drive: 'rwd', flip: true,
  },
  {
    /* 2023 regulations cap a car at 5.63 m and 798 kg with driver. Rules
     * rather than measurements, which is the most reliable kind of
     * specification this list gets — and this export is already 5.63 m long,
     * so it barely needs scaling at all. */
    id: 'w14', file: 'amg_w14_s1__www.vecarz.com.glb',
    label: 'Mercedes-AMG W14', year: 2023,
    length: 5.63, mass: 798, drive: 'rwd', flip: true,
  },
  {
    /* Cartoon proportions and film figures, not a manufacturer's: both of the
     * next two are stubbier and wider than anything real, so their `length` is
     * pulled in a little to keep the width sane, and their speeds are what the
     * films claim. Stated as facts because that is all this script needs them
     * to be. */
    id: 'mcqueen', file: 'rookie_lightning_mcqueen.glb',
    label: 'Lightning McQueen', year: 2006,
    length: 4.40, mass: 1400, drive: 'rwd', flip: true,
  },
  {
    id: 'mater', file: 'mater.glb',
    label: 'Mater', year: 1951,
    length: 5.20, mass: 2700, drive: 'rwd', flip: true,
  },
  {
    id: 'dodge', file: 'dodge_b-series_pickup_1953_x-_mas_car.glb',
    label: 'Dodge B-Series', year: 1953,
    length: 4.80, mass: 1450, drive: 'rwd', flip: true,
  },
  {
    /* The other Lamborghini. Trattori has outlived the car company's
     * ownership changes and still makes these. */
    id: 'tractor', file: 'lamborghini_tractor_r6_125_dcr__www.vecarz.com.glb',
    label: 'Lamborghini R6', year: 2020,
    length: 4.40, mass: 4800, drive: 'awd', flip: true,
  },
  {
    /*
     * The monster truck's `length` is set from its **width**, not from a
     * catalogue length, and that is deliberate. This export is proportionally
     * much wider than the real thing — 1.11 length-to-width against a Monster
     * Jam truck's 1.42 — so scaling it to a real 5.18 m length would make it
     * 4.65 m wide, wider than a lane and wide enough to foul kerbs on both
     * sides of a 7 m street at once. 4.35 m lands it at 3.90 m wide and 3.26 m
     * tall: still the widest, tallest thing in the garage by a long way, and
     * still able to get down a road. Width is the dimension that has to fit.
     */
    id: 'monster', file: 'monster_truck__www.vecarz.com.glb',
    label: 'Monster Truck', year: 1990,
    length: 4.35, mass: 5443, drive: 'awd', flip: true,
  },
];

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

await MeshoptSimplifier.ready;

// ---------------------------------------------------------------------------
// Matrix helpers — same conventions as prepare-map.mjs and prepare-vehicles.mjs.
// ---------------------------------------------------------------------------
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  return o;
}

function nodeMatrix(node) {
  const [x, y, z, w] = node.getRotation();
  const t = node.getTranslation();
  const s = node.getScale();
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const apply = (m, x, y, z) => [
  x * m[0] + y * m[4] + z * m[8] + m[12],
  x * m[1] + y * m[5] + z * m[9] + m[13],
  x * m[2] + y * m[6] + z * m[10] + m[14],
];

/** Rotation-only apply, for normals (our matrices carry no shear). */
const applyDir = (m, x, y, z) => [
  x * m[0] + y * m[4] + z * m[8],
  x * m[1] + y * m[5] + z * m[9],
  x * m[2] + y * m[6] + z * m[10],
];

/**
 * Flattens every primitive in a document into world space.
 * Returns `{ material, pos, nrm, uv, idx }` records with plain typed arrays.
 */
function bakeToWorld(scene) {
  const parts = [];
  (function walk(node, parent) {
    const m = mul(parent, nodeMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const position = prim.getAttribute('POSITION');
        if (!position) continue;
        const count = position.getCount();
        const pos = new Float32Array(count * 3);
        const v = [0, 0, 0];
        for (let i = 0; i < count; i++) {
          position.getElement(i, v);
          const p = apply(m, v[0], v[1], v[2]);
          pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
        }

        const normal = prim.getAttribute('NORMAL');
        const nrm = new Float32Array(count * 3);
        if (normal) {
          for (let i = 0; i < count; i++) {
            normal.getElement(i, v);
            const d = applyDir(m, v[0], v[1], v[2]);
            const len = Math.hypot(d[0], d[1], d[2]) || 1;
            nrm[i * 3] = d[0] / len; nrm[i * 3 + 1] = d[1] / len; nrm[i * 3 + 2] = d[2] / len;
          }
        }

        const texcoord = prim.getAttribute('TEXCOORD_0');
        const uv = new Float32Array(count * 2);
        if (texcoord) {
          const t = [0, 0];
          for (let i = 0; i < count; i++) {
            texcoord.getElement(i, t);
            uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1];
          }
        }

        const index = prim.getIndices();
        const idx = index
          ? Uint32Array.from(index.getArray())
          : Uint32Array.from({ length: count }, (_, i) => i);

        parts.push({ material: prim.getMaterial(), pos, nrm, uv, idx, hasNormal: !!normal, hasUV: !!texcoord });
      }
    }
    for (const child of node.listChildren()) walk(child, m);
  })(scene.listChildren()[0] ?? scene, IDENTITY);
  return parts;
}

const boundsOf = (parts) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let i = 0; i < p.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.pos[i + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
  }
  return { lo, hi, size: hi.map((v, i) => v - lo[i]) };
};

/** Per-part bounds, used for wheel hunting. */
function partBounds(part) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = part.pos[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { lo, hi, size: hi.map((v, i) => v - lo[i]), c: hi.map((v, i) => (v + lo[i]) / 2) };
}

// ---------------------------------------------------------------------------
// Orientation and scale.
// ---------------------------------------------------------------------------

/** Rotations as flat matrices, all about the origin. */
const ROT = {
  /** Z-up to Y-up: (x, y, z) -> (x, z, -y). */
  zUpToYUp: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  /** Quarter turn about Y: (x, y, z) -> (z, y, -x). Puts an X-long model on Z. */
  yawQuarter: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  /** Half turn about Y: (x, y, z) -> (-x, y, -z). Turns a car that faces backwards. */
  yawHalf: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
  /**
   * Half turn about Z: (x, y, z) -> (-x, -y, z). Rights a model that came out
   * on its roof, without disturbing which end is the nose.
   */
  rollHalf: [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};

function transformParts(parts, m) {
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      const p = apply(m, part.pos[i], part.pos[i + 1], part.pos[i + 2]);
      part.pos[i] = p[0]; part.pos[i + 1] = p[1]; part.pos[i + 2] = p[2];
    }
    for (let i = 0; i < part.nrm.length; i += 3) {
      const d = applyDir(m, part.nrm[i], part.nrm[i + 1], part.nrm[i + 2]);
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      part.nrm[i] = d[0] / len; part.nrm[i + 1] = d[1] / len; part.nrm[i + 2] = d[2] / len;
    }
  }
}

const scaleAndOffset = (s, tx, ty, tz) =>
  [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, tx, ty, tz, 1];

/**
 * Puts a model into the project's convention: Y up, length along Z, nose at
 * -Z, sitting on y = 0 and centred on its own footprint, at real-world scale.
 */
function normalise(parts, vehicle) {
  let size = boundsOf(parts).size;

  // A car is longer than it is tall. If the tallest axis is Y-largest, the
  // export is Z-up and its length is being read as height.
  if (size[1] > size[0] && size[1] > size[2]) {
    transformParts(parts, ROT.zUpToYUp);
    size = boundsOf(parts).size;
  }
  // Swapping the up axis says nothing about which way up the model was: a
  // Z-up export authored with its roof toward -Z lands on its head. That is
  // not decidable from a bounding box, so it is stated per vehicle — and it
  // matters twice over, because wheel detection looks for round things
  // resting on the ground and finds nothing at all on an upturned truck.
  if (vehicle.upsideDown) transformParts(parts, ROT.rollHalf);
  // Length must run along Z.
  if (size[0] > size[2]) {
    transformParts(parts, ROT.yawQuarter);
    size = boundsOf(parts).size;
  }
  if (vehicle.flip) transformParts(parts, ROT.yawHalf);

  const scale = vehicle.length / boundsOf(parts).size[2];
  transformParts(parts, scaleAndOffset(scale, 0, 0, 0));

  const b = boundsOf(parts);
  transformParts(parts, scaleAndOffset(1,
    -(b.lo[0] + b.hi[0]) / 2,
    -b.lo[1],
    -(b.lo[2] + b.hi[2]) / 2,
  ));
  return { scale, size: boundsOf(parts).size };
}

// ---------------------------------------------------------------------------
// Wheels, found by shape rather than by name.
// ---------------------------------------------------------------------------

/**
 * Splits a mesh that holds several wheels into one part per wheel.
 *
 * Exports group geometry by *material*, and a wheel material covers every
 * wheel on the vehicle: the 1953 Dodge arrives with `tire_left_L` as a single
 * 3.53 m mesh containing that side's front and rear tyre, and its rims as one
 * 1.84 m mesh spanning both sides. `findWheels` looks for compact round lumps,
 * so a mesh like that reads as a 1.77 m "radius" and is thrown out — which is
 * how a pickup with four perfectly good tyres ends up with a one-piece body.
 *
 * This is the same trick `prepare-model.mjs` uses on the McLaren, whose tyres
 * are likewise merged: partition the triangles by centroid. A part is only cut
 * on an axis where it is much longer than it is tall, so a single wide tyre is
 * never sawn in half, and each piece's bounds are recomputed from the
 * triangles it actually kept — which is what makes the halves come out tight
 * around one wheel instead of around half the truck.
 */
function splitMergedWheels(parts) {
  const out = [];
  for (const part of parts) {
    const b = partBounds(part);
    const height = b.size[1];
    const nearGround = b.lo[1] < height * 0.6;
    const plausible = height > 0.30 && height < 2.20;
    const splitX = b.size[0] > height * 1.6;
    const splitZ = b.size[2] > height * 1.6;

    if (!nearGround || !plausible || (!splitX && !splitZ) || !part.idx) {
      out.push(part);
      continue;
    }

    // Bucket triangles by which side of the middle their centroid falls on.
    const buckets = new Map();
    for (let t = 0; t < part.idx.length; t += 3) {
      const a = part.idx[t], c = part.idx[t + 1], d = part.idx[t + 2];
      const cx = (part.pos[a * 3] + part.pos[c * 3] + part.pos[d * 3]) / 3;
      const cz = (part.pos[a * 3 + 2] + part.pos[c * 3 + 2] + part.pos[d * 3 + 2]) / 3;
      const key = `${splitX ? (cx < b.c[0] ? 0 : 1) : 0}:${splitZ ? (cz < b.c[2] ? 0 : 1) : 0}`;
      let bucket = buckets.get(key);
      if (!bucket) { bucket = []; buckets.set(key, bucket); }
      bucket.push(a, c, d);
    }
    if (buckets.size < 2) { out.push(part); continue; }

    /*
     * The cut is **speculative**, and this is the guard that makes it safe.
     * Plenty of near-ground geometry is longer than it is tall — floor pans,
     * side skirts, sill panels — and cutting those produces fragments that are
     * round enough to be mistaken for wheels. The first version of this
     * splitter did exactly that and moved the M3 GTR's wheelbase from 2.65 m
     * to 2.46 m and its radii from 0.25/0.25 to 0.41/0.32, on a car whose
     * wheels were already being found correctly. So: only keep the split if
     * *every* piece comes out round in side view and wheel-sized. Otherwise
     * the part goes through whole and nothing changes.
     */
    const pieces = [...buckets.values()].map((indices) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const v of indices) {
        for (let k = 0; k < 3; k++) {
          const value = part.pos[v * 3 + k];
          if (value < lo[k]) lo[k] = value;
          if (value > hi[k]) hi[k] = value;
        }
      }
      const size = hi.map((v, i) => v - lo[i]);
      const radius = Math.max(size[1], size[2]) / 2;
      const round = Math.min(size[1], size[2]) / (Math.max(size[1], size[2]) || 1);
      return { indices, radius, round };
    });
    const everyPieceIsAWheel = pieces.every((piece) =>
      piece.round >= 0.72 && piece.radius >= 0.20 && piece.radius <= 0.95);
    if (!everyPieceIsAWheel) { out.push(part); continue; }

    for (const { indices } of pieces) {
      // Re-index onto only the vertices this piece uses.
      const remap = new Map();
      const pos = [], nrm = [], uv = [], idx = [];
      for (const v of indices) {
        let m = remap.get(v);
        if (m === undefined) {
          m = remap.size;
          remap.set(v, m);
          pos.push(part.pos[v * 3], part.pos[v * 3 + 1], part.pos[v * 3 + 2]);
          if (part.hasNormal) nrm.push(part.nrm[v * 3], part.nrm[v * 3 + 1], part.nrm[v * 3 + 2]);
          if (part.hasUV) uv.push(part.uv[v * 2], part.uv[v * 2 + 1]);
        }
        idx.push(m);
      }
      out.push({
        material: part.material,
        pos: new Float32Array(pos),
        nrm: new Float32Array(nrm),
        uv: new Float32Array(uv),
        idx: new Uint32Array(idx),
        hasNormal: part.hasNormal,
        hasUV: part.hasUV,
      });
    }
  }
  return out;
}

/**
 * A wheel is a lump of geometry that is round seen from the side, sits on the
 * ground, and stands off the centreline. Names are useless here — across these
 * six exports the wheels are variously called `LOD_A_TYRE`, `Ext_suv_wheel`,
 * `DEF-Wheel` or nothing at all — but the shape is the same every time.
 */
function findWheels(parts, size) {
  const width = size[0];
  const candidates = [];
  /*
   * Why a part was rejected, for `WHEEL_DEBUG=1`. When a new model comes out
   * "body only" this is the difference between guessing at the export and
   * reading the number that actually failed — which is the same principle as
   * the rest of this script.
   */
  const rejects = [];

  parts.forEach((part, index) => {
    const b = partBounds(part);
    const radius = Math.max(b.size[1], b.size[2]) / 2;
    const note = (why) => rejects.push({ index, why, radius, size: b.size, c: b.c });
    // 0.95 m, not 0.80: a monster truck's 66-inch tyre is 0.84 m in radius and
    // was rejected by four centimetres, which is how it ended up with a
    // one-piece body and wheels that could not turn. Body panels, the thing
    // this ceiling is really for, come in around 2.0 m and are still excluded.
    if (radius < 0.20 || radius > 0.95) return note(`radius ${radius.toFixed(2)} outside 0.20-0.95`);
    // Round in side view: height and length within a third of each other.
    const round = Math.min(b.size[1], b.size[2]) / Math.max(b.size[1], b.size[2]);
    if (round < 0.72) return note(`not round in side view (${round.toFixed(2)} < 0.72)`);
    // Narrower than it is tall — a wheel, not a body panel or a wheel arch.
    if (b.size[0] > b.size[1] * 1.1) return note(`wider than tall (${b.size[0].toFixed(2)} > ${(b.size[1] * 1.1).toFixed(2)})`);
    // Resting on the ground, and off to one side.
    if (Math.abs(b.c[1] - radius) > 0.18) return note(`not on the ground (centre y ${b.c[1].toFixed(2)} vs radius ${radius.toFixed(2)})`);
    if (Math.abs(b.c[0]) < width * 0.18) return note(`too near the centreline (|x| ${Math.abs(b.c[0]).toFixed(2)} < ${(width * 0.18).toFixed(2)})`);
    candidates.push({ index, b, radius });
  });

  if (process.env.WHEEL_DEBUG) {
    const tally = new Map();
    for (const r of rejects) {
      const key = r.why.replace(/[\d.]+/g, 'N');
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    console.log(`  [wheel-debug] ${parts.length} parts -> ${candidates.length} candidates`);
    for (const [why, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  [wheel-debug]   ${String(n).padStart(4)} rejected: ${why}`);
    }
    // The near-misses are the interesting ones: right size, wrong something.
    for (const r of rejects.filter((x) => x.radius >= 0.20 && x.radius <= 0.80).slice(0, 6)) {
      console.log(`  [wheel-debug]   near-miss part ${r.index}: r=${r.radius.toFixed(2)} `
        + `size=[${r.size.map((v) => v.toFixed(2)).join(', ')}] c=[${r.c.map((v) => v.toFixed(2)).join(', ')}] — ${r.why}`);
    }
  }

  // Merge candidates that share an axle position.
  const clusters = [];
  for (const c of candidates) {
    const hit = clusters.find((k) =>
      Math.hypot(k.c[0] - c.b.c[0], k.c[1] - c.b.c[1], k.c[2] - c.b.c[2]) < 0.35);
    if (hit) {
      hit.indices.push(c.index);
      for (let i = 0; i < 3; i++) {
        hit.lo[i] = Math.min(hit.lo[i], c.b.lo[i]);
        hit.hi[i] = Math.max(hit.hi[i], c.b.hi[i]);
      }
      hit.c = [0, 1, 2].map((i) => (hit.lo[i] + hit.hi[i]) / 2);
    } else {
      clusters.push({ indices: [c.index], lo: [...c.b.lo], hi: [...c.b.hi], c: [...c.b.c] });
    }
  }
  if (clusters.length < 4) return null;

  /*
   * Discard clusters far smaller than the biggest one before choosing axles.
   * A modern racing car is covered in small round things — brake ducts, wheel
   * nuts, upright fairings — and several sit *ahead* of the front tyres, so
   * taking the extreme axles blindly hands the front axle to a duct: the W14
   * came out with a 4.33 m wheelbase and a 0.19 m front "wheel" against a real
   * 3.60 m and 0.36 m. Real axles stay within about a third of each other even
   * on a tractor (0.61 front against 0.86 rear), so 0.6x is a wide margin that
   * still excludes the ducts.
   */
  const biggest = Math.max(...clusters.map((k) => (k.hi[1] - k.lo[1]) / 2));
  const plausible = clusters.filter((k) => (k.hi[1] - k.lo[1]) / 2 >= biggest * 0.6);
  if (plausible.length < 4) return null;

  // Front is -Z. Take the extreme axles: on a three-axle truck that is the
  // steer axle and the rearmost drive axle, which is the right pair to drive.
  const byZ = [...plausible].sort((a, b) => a.c[2] - b.c[2]);
  const front = byZ.slice(0, 2).sort((a, b) => a.c[0] - b.c[0]);
  const rear = byZ.slice(-2).sort((a, b) => a.c[0] - b.c[0]);
  if (front.length < 2 || rear.length < 2) return null;
  // Each axle needs one wheel either side of the centreline.
  if (front[0].c[0] > 0 || front[1].c[0] < 0 || rear[0].c[0] > 0 || rear[1].c[0] < 0) return null;

  /*
   * Absorb anything that lives *inside* a wheel. The tyre is found on its own
   * merits, but its rim, hub and brake parts each fail one test or another —
   * a monster truck's rim is 0.98 m wide against 0.70 m tall, so it reads as
   * "wider than tall" — and left in the body they would sit still while the
   * tyre spun around them. Containment is the honest test: if a part's bounds
   * are within the tyre's, it is part of the wheel.
   */
  const claimed = new Set([front[0], front[1], rear[0], rear[1]].flatMap((c) => c.indices));
  for (const cluster of [front[0], front[1], rear[0], rear[1]]) {
    parts.forEach((part, index) => {
      if (claimed.has(index)) return;
      const b = partBounds(part);
      const inside = [0, 1, 2].every((i) =>
        b.lo[i] >= cluster.lo[i] - 0.02 && b.hi[i] <= cluster.hi[i] + 0.02);
      if (!inside) return;
      cluster.indices.push(index);
      claimed.add(index);
    });
  }

  const corner = (cluster) => ({
    indices: cluster.indices,
    centre: cluster.c,
    radius: (cluster.hi[1] - cluster.lo[1]) / 2,
  });
  return { FL: corner(front[0]), FR: corner(front[1]), RL: corner(rear[0]), RR: corner(rear[1]) };
}

/** Falls back to proportions when the export merges its wheels into the body. */
function estimateWheels(size) {
  const [width, height, length] = size;
  const radius = Math.min(0.42, Math.max(0.30, height * 0.24));
  const x = width * 0.40;
  const z = length * 0.31;
  const mk = (sx, sz) => ({ indices: [], centre: [sx * x, radius, sz * z], radius });
  return { FL: mk(-1, -1), FR: mk(1, -1), RL: mk(-1, 1), RR: mk(1, 1) };
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------

/** Collapses a set of baked parts into one primitive per material. */
function buildMesh(doc, buffer, name, parts, offset = [0, 0, 0]) {
  const byMaterial = new Map();
  for (const part of parts) {
    const list = byMaterial.get(part.material) ?? [];
    list.push(part);
    byMaterial.set(part.material, list);
  }

  const mesh = doc.createMesh(name);
  for (const [material, list] of byMaterial) {
    let vertices = 0;
    let indices = 0;
    for (const p of list) { vertices += p.pos.length / 3; indices += p.idx.length; }

    const pos = new Float32Array(vertices * 3);
    const nrm = new Float32Array(vertices * 3);
    const uv = new Float32Array(vertices * 2);
    const idx = new Uint32Array(indices);
    let vo = 0;
    let io2 = 0;
    for (const p of list) {
      const base = vo / 3;
      for (let i = 0; i < p.pos.length; i += 3) {
        pos[vo + i] = p.pos[i] - offset[0];
        pos[vo + i + 1] = p.pos[i + 1] - offset[1];
        pos[vo + i + 2] = p.pos[i + 2] - offset[2];
      }
      nrm.set(p.nrm, vo);
      uv.set(p.uv, (vo / 3) * 2);
      for (let i = 0; i < p.idx.length; i++) idx[io2 + i] = p.idx[i] + base;
      vo += p.pos.length;
      io2 += p.idx.length;
    }

    const prim = doc.createPrimitive().setMode(4).setMaterial(material);
    prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer));
    prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer));
    prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer));
    mesh.addPrimitive(prim);
  }
  return mesh;
}

/** Decimates every primitive proportionally until the mesh fits the budget. */
function simplifyDoc(doc, budget) {
  const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  const total = prims.reduce((n, p) => n + p.getIndices().getCount() / 3, 0);
  if (total <= budget) return { before: total, after: total };

  const ratio = budget / total;
  for (const prim of prims) {
    const indices = Uint32Array.from(prim.getIndices().getArray());
    const positions = Float32Array.from(prim.getAttribute('POSITION').getArray());
    const target = Math.max(3, Math.floor((indices.length / 3) * ratio)) * 3;
    if (target >= indices.length) continue;
    const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.05, ['LockBorder']);
    prim.getIndices().setArray(simplified);
  }
  const after = doc.getRoot().listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((n, p) => n + p.getIndices().getCount() / 3, 0);
  return { before: total, after };
}

/**
 * Drops vertices no triangle references any more.
 *
 * Simplifying only rewrites the index buffer, so without this the attribute
 * arrays still carry every original vertex — Draco then faithfully compresses
 * geometry nothing draws, and the files come out barely smaller than the raw
 * exports (the Hummer went 40.8 MB in, 38.8 MB out before this existed).
 */
function compactDoc(doc, buffer) {
  let removed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices().getArray();
      const position = prim.getAttribute('POSITION');
      const count = position.getCount();

      const remap = new Int32Array(count).fill(-1);
      let next = 0;
      for (let i = 0; i < indices.length; i++) {
        if (remap[indices[i]] === -1) remap[indices[i]] = next++;
      }
      if (next === count) continue;
      removed += count - next;

      for (const name of prim.listSemantics()) {
        const attribute = prim.getAttribute(name);
        const src = attribute.getArray();
        const stride = attribute.getElementSize();
        const dst = new src.constructor(next * stride);
        for (let i = 0; i < count; i++) {
          if (remap[i] < 0) continue;
          for (let k = 0; k < stride; k++) dst[remap[i] * stride + k] = src[i * stride + k];
        }
        prim.setAttribute(name, doc.createAccessor()
          .setType(attribute.getType()).setArray(dst).setBuffer(buffer));
        attribute.dispose();
      }

      const rebuilt = new Uint32Array(indices.length);
      for (let i = 0; i < indices.length; i++) rebuilt[i] = remap[indices[i]];
      const old = prim.getIndices();
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(rebuilt).setBuffer(buffer));
      old.dispose();
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const catalogue = [];

for (const vehicle of GARAGE) {
  const srcSize = readFileSync(vehicle.file).byteLength;
  step(`${vehicle.id}: reading ${vehicle.file} (${mb(srcSize)})`);

  const doc = await io.read(vehicle.file);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  let parts = bakeToWorld(scene);
  const { scale, size } = normalise(parts, vehicle);
  step(`  scale ${scale.toFixed(4)} -> ${size[2].toFixed(2)} m long, ${size[0].toFixed(2)} wide, ${size[1].toFixed(2)} tall`);

  /*
   * Wheel-material meshes are cut into one piece per wheel first, then the
   * whole (possibly re-partitioned) list is what everything downstream uses —
   * both the hunt and the body/wheel split — so a wheel found in a cut piece
   * still owns real geometry.
   */
  parts = splitMergedWheels(parts);
  const found = findWheels(parts, size);
  const wheels = found ?? estimateWheels(size);
  step(found
    ? `  wheels found geometrically (r=${found.FL.radius.toFixed(3)} front, ${found.RL.radius.toFixed(3)} rear)`
    : '  wheels not separable — pivots estimated, body stays one piece');

  // Split the baked parts into body and (when found) the four wheels.
  const wheelIndices = new Set(found ? Object.values(found).flatMap((w) => w.indices) : []);
  const bodyParts = parts.filter((_, i) => !wheelIndices.has(i));

  // Rebuild the scene from the baked geometry. The accessors go too: the bake
  // copied everything into plain arrays, and anything left attached to the
  // buffer is still written out — which is how the first cut of this script
  // produced files LARGER than the raw exports, Draco faithfully compressing
  // geometry that nothing referenced any more.
  for (const node of root.listNodes()) node.dispose();
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const accessor of root.listAccessors()) accessor.dispose();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();

  scene.addChild(doc.createNode('Body').setMesh(buildMesh(doc, buffer, 'Body', bodyParts)));

  if (found) {
    for (const [corner, wheel] of Object.entries(found)) {
      const owned = wheel.indices.map((i) => parts[i]);
      const mesh = buildMesh(doc, buffer, `Wheel_${corner}`, owned, wheel.centre);
      // Wheel_* rolls and steers about its own axle; Upright_* steers only and
      // is what Car.tsx hangs non-rotating hardware on. Nothing here is
      // separable into calipers, so the upright is an empty pivot — present so
      // the renderer finds what it expects.
      scene.addChild(doc.createNode(`Wheel_${corner}`)
        .setTranslation(wheel.centre).setMesh(mesh));
      scene.addChild(doc.createNode(`Upright_${corner}`).setTranslation(wheel.centre));
    }
  }

  const simplified = simplifyDoc(doc, TRIANGLE_BUDGET);
  if (simplified.after !== simplified.before) {
    step(`  simplified ${Math.round(simplified.before).toLocaleString()} -> ${Math.round(simplified.after).toLocaleString()} tris`);
  } else {
    step(`  ${Math.round(simplified.before).toLocaleString()} tris (within budget)`);
  }
  const dropped = compactDoc(doc, buffer);
  if (dropped) step(`  dropped ${dropped.toLocaleString()} orphaned vertices`);

  let before = 0;
  let after = 0;
  for (const texture of root.listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    before += image.byteLength;
    try {
      const webp = await sharp(Buffer.from(image))
        .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      texture.setImage(new Uint8Array(webp)).setMimeType('image/webp');
      after += webp.byteLength;
    } catch {
      after += image.byteLength; // leave anything sharp cannot read alone
    }
  }
  step(`  textures ${mb(before)} -> ${mb(after)}`);

  doc.createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5, decodeSpeed: 5,
      quantizationVolume: 'mesh',
      quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
    });

  const dst = `${OUT_DIR}/${vehicle.id}.glb`;
  await io.write(dst, doc);

  const pivot = (c) => wheels[c].centre.map((v) => +v.toFixed(4));
  catalogue.push({
    id: vehicle.id,
    label: vehicle.label,
    year: vehicle.year,
    model: `/models/garage/${vehicle.id}.glb`,
    /** Width (X), height (Y), length (Z), metres. */
    size: size.map((v) => +v.toFixed(3)),
    mass: vehicle.mass,
    drive: vehicle.drive,
    /** True when the wheels are real pivots that roll and steer. */
    hasWheelPivots: Boolean(found),
    wheelbase: +(wheels.RL.centre[2] - wheels.FL.centre[2]).toFixed(4),
    trackFront: +(wheels.FR.centre[0] - wheels.FL.centre[0]).toFixed(4),
    trackRear: +(wheels.RR.centre[0] - wheels.RL.centre[0]).toFixed(4),
    pivots: { FL: pivot('FL'), FR: pivot('FR'), RL: pivot('RL'), RR: pivot('RR') },
    radii: {
      FL: +wheels.FL.radius.toFixed(4), FR: +wheels.FR.radius.toFixed(4),
      RL: +wheels.RL.radius.toFixed(4), RR: +wheels.RR.radius.toFixed(4),
    },
    triangles: Math.round(simplified.after),
  });

  step(`  ${mb(srcSize)} -> ${mb(readFileSync(dst).byteLength)}\n`);
}

writeFileSync(DATA, JSON.stringify({ vehicles: catalogue }, null, 2) + '\n');

console.log('--- garage ---');
for (const v of catalogue) {
  console.log(`  ${v.id.padEnd(10)} ${v.size[2].toFixed(2)} m  ${String(v.mass).padStart(5)} kg  ` +
    `wb ${v.wheelbase.toFixed(2)}  r ${v.radii.FL.toFixed(2)}/${v.radii.RL.toFixed(2)}  ` +
    `${String(v.triangles).padStart(7)} tris  ${v.hasWheelPivots ? 'wheel pivots' : 'body only'}`);
}
console.log();
