/**
 * One-time preprocessor for the "Drive for Speed" city GLB.
 *
 * The Sketchfab export is 188 MB and cannot be shipped or rendered as-is:
 *
 *   - 12,103 primitives across 26,779 nodes  -> 12k draw calls, ~8 fps.
 *   - 179 MB of *uncompressed* geometry (2.96 M triangles, f32 positions).
 *   - Authored in FBX centimetres, then scaled by 0.01 at the root, so the whole
 *     city measures 55 x 27.5 "units". Real-world scale is recovered below.
 *   - Per-vertex data nobody uses: TEXCOORD_1/2, COLOR_0, TANGENT.
 *   - Foliage is alphaMode BLEND, which means 1.6 M triangles of sorted
 *     transparency — the single most expensive thing in the file.
 *
 * This script emits:
 *
 *   public/models/city.glb    Draco-compressed, merged into spatial chunks.
 *   src/config/cityData.json  Spawn point, world bounds, building box colliders.
 *
 * Chunking, not one mesh per material: a single merged Vegetation mesh would
 * span the whole city and could never be frustum-culled, so every tree in the
 * map would be submitted every frame. Merging by (material, CELL x CELL cell)
 * keeps the draw-call count low *and* lets the renderer throw away everything
 * behind you. Each chunk carries `extras.collides`, so the runtime knows which
 * chunks double as the physics trimesh — the wheels then raycast exactly the
 * surface you see, the same guarantee the procedural circuit gives.
 *
 * Run with: npm run prepare:map
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'drive_for_speed_-_map.glb';
const DST = 'public/models/city.glb';
const DATA = 'src/config/cityData.json';
const NAV = 'public/models/cityNav.png';

/**
 * Source units -> metres.
 *
 * The root chain already applies FBX's 0.01 cm->m, leaving a city 55 units
 * across, which is obviously not 55 m. Recovered from objects whose real size is
 * fixed by standard or by law, measured as world-space bounds of single
 * instances. Every reliable reference lands between 90 and 106:
 *
 *   ISO shipping container, width      94   (2.44 m by standard)
 *   ISO shipping container, height     92   (2.59 m by standard)
 *   bus shelter height                 90   (~2.5 m)
 *   road sign, ground to top           93   (~2.2 m)
 *   refuse container height           101   (~1.4 m)
 *   refuse sack                       100
 *   crowd barrier height              105   (~1.1 m)
 *   litter bin height                 106   (~1.05 m)
 *   Peterbilt tyre diameter           103   (22.5 in truck tyre, 1.06 m)
 *   Peterbilt overall height          104   (4.11 m is the US legal maximum)
 *   Mercedes trailer width            104   (2.55 m is the EU legal maximum)
 *   Mercedes chassis width            105
 *
 * 100 is taken, putting the city at 5.5 x 2.75 km.
 *
 * It was 160, which made everything in the city about 1.6x too large and left
 * the player's car looking like a toy beside it. That came from four references
 * that cannot carry the weight, and they are recorded here so they are not
 * reached for again: tree height (trees are not a fixed size — the trees in this
 * very map imply anything from 49 to 115), a "residential house" 13.4 m tall
 * (that is a four-storey block, not a house), a "wall module" 6.6 m high (a
 * boundary wall is 2-3 m), and a Peterbilt cab 4.3 m high (above the 4.11 m
 * legal limit it would have to obey). Prefer things built to a specification:
 * containers, road vehicles, street furniture.
 */
const UNIT_SCALE = 100;

/** Edge length of a merge/cull cell, metres. Scaled with UNIT_SCALE. */
const CELL = 250;

/**
 * Materials whose geometry is solid ground you can drive on. These chunks are
 * emitted as `road::` and become the vehicle's trimesh collider.
 *
 * `Blocks` is the terrain shell (hills, cliffs, retaining walls) and `Building`
 * is deliberately absent: 836 k triangles of facade would make a needlessly
 * expensive trimesh when per-primitive boxes are both cheaper and tighter.
 */
const DRIVABLE = new Set([
  'Street', 'Street_1', 'Street_texture', 'Parking', 'MaterialPiso', 'Blocks',
  'Texture_garage_claro_PisoSombra', 'Texture_garage_claro_PisoSombra_1',
]);

/** Materials that become box colliders instead of trimesh. */
const SOLID_BOXES = new Set(['Building', 'Obstacles', 'container1']);

/**
 * A primitive only becomes a box if its footprint is at most this wide.
 *
 * Most `Building` primitives are one house and box tightly (2,786 of 2,937 are
 * under 60 m). The rest are merged blocks and ground shells — the worst is the
 * beach plane, a single 5,158 x 4,231 m primitive whose AABB would encase the
 * entire city in an invisible wall. Anything oversized falls through to the
 * exact trimesh instead, which costs a few thousand triangles and cannot
 * swallow a street.
 */
const BOX_MAX_FOOTPRINT = 40;

/**
 * Of the drivable materials, the ones that are actually *paved*. These form the
 * road mask: what the minimap draws, what `R` snaps the car back onto, and what
 * counts as tarmac. `Blocks` is excluded — it is the terrain shell, and treating
 * hillsides as road would carpet the map in false streets.
 */
const PAVED = new Set([
  'Street', 'Street_1', 'Street_texture', 'Parking', 'MaterialPiso',
  'Texture_garage_claro_PisoSombra', 'Texture_garage_claro_PisoSombra_1',
]);

/**
 * Metres per pixel in the navigation raster.
 *
 * Chosen to keep the raster roughly its old pixel size now the city is smaller,
 * which also buys the traffic AI a third more positional precision: every probe
 * it makes is quantised to this, and at 3 m it was the dominant noise source.
 */
const NAV_RESOLUTION = 1.5;

/** Foliage: kept double-sided, but alpha-tested rather than alpha-blended. */
const FOLIAGE = new Set(['Vegetation', 'graffiti']);

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// ---------------------------------------------------------------------------

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() });

step(`reading ${SRC} (${mb(readFileSync(SRC).byteLength)})`);
const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];
step(`parsed: ${root.listMeshes().length} meshes, ${root.listAccessors().length} accessors`);

const matName = (prim) => prim.getMaterial()?.getName() ?? '<none>';

/** Snapshot before the rebuild adds ours; these all get disposed in step 8. */
const originalMeshes = root.listMeshes();

// ---------------------------------------------------------------------------
// 1. Walk the hierarchy, resolving each mesh node's world matrix.
//    Meshes are 1:1 with nodes in this export (12,103 of each), so no mesh is
//    reachable through two different transforms and baking in place is safe.
// ---------------------------------------------------------------------------

/** Column-major 4x4 multiply, matching the glTF/three convention. */
function mul(a, b) {
  const o = new Float64Array(16);
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
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}

/**
 * Inverse-transpose of the upper 3x3, for normals. Node scales in this file are
 * not guaranteed uniform, and using the plain matrix on a non-uniformly scaled
 * node tilts every normal — which reads as wrong lighting, not as a crash.
 */
function normalMatrix(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const c00 = a11 * a22 - a12 * a21, c01 = a12 * a20 - a10 * a22, c02 = a10 * a21 - a11 * a20;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(det) < 1e-20) return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], det: 1 };
  const id = 1 / det;
  // inverse-transpose == cofactor matrix / det
  return {
    m: [
      c00 * id, c01 * id, c02 * id,
      (a02 * a21 - a01 * a22) * id, (a00 * a22 - a02 * a20) * id, (a01 * a20 - a00 * a21) * id,
      (a01 * a12 - a02 * a11) * id, (a02 * a10 - a00 * a12) * id, (a00 * a11 - a01 * a10) * id,
    ],
    det,
  };
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Every mesh node in the scene, with its resolved world matrix. */
const placements = [];
(function walk(node, parent) {
  const m = mul(parent, nodeMatrix(node));
  const mesh = node.getMesh();
  if (mesh) placements.push({ node, mesh, m });
  for (const child of node.listChildren()) walk(child, m);
})(scene.listChildren()[0], IDENTITY);
for (const extra of scene.listChildren().slice(1)) {
  (function walk(node, parent) {
    const m = mul(parent, nodeMatrix(node));
    const mesh = node.getMesh();
    if (mesh) placements.push({ node, mesh, m });
    for (const child of node.listChildren()) walk(child, m);
  })(extra, IDENTITY);
}
step(`resolved ${placements.length} mesh placements`);

// ---------------------------------------------------------------------------
// 2. Transform every primitive into world space (metres), bucketing vertices by
//    (material, spatial cell) as we go. Also collects box colliders.
// ---------------------------------------------------------------------------

/** key -> { material, drivable, pos[], nrm[], uv[], idx[], base } */
const groups = new Map();
const boxes = [];
const world = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
/** Sampled drivable triangles, used to choose a spawn point. */
/** Every drivable triangle, in world metres, for the navigation raster. */
const navTris = [];

let skippedNonTriangle = 0;

for (const { mesh, m } of placements) {
  const nm = normalMatrix(m);
  const flipWinding = nm.det < 0;

  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) { skippedNonTriangle++; continue; }
    const posAcc = prim.getAttribute('POSITION');
    if (!posAcc) continue;

    const name = matName(prim);
    const src = posAcc.getArray();
    const count = posAcc.getCount();

    // --- positions -> world metres, and this primitive's world bbox ---
    const px = new Float32Array(count), py = new Float32Array(count), pz = new Float32Array(count);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      const wx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * UNIT_SCALE;
      const wy = (m[1] * x + m[5] * y + m[9] * z + m[13]) * UNIT_SCALE;
      const wz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * UNIT_SCALE;
      px[i] = wx; py[i] = wy; pz[i] = wz;
      if (wx < lo[0]) lo[0] = wx; if (wx > hi[0]) hi[0] = wx;
      if (wy < lo[1]) lo[1] = wy; if (wy > hi[1]) hi[1] = wy;
      if (wz < lo[2]) lo[2] = wz; if (wz > hi[2]) hi[2] = wz;
    }
    for (let c = 0; c < 3; c++) {
      world.lo[c] = Math.min(world.lo[c], lo[c]);
      world.hi[c] = Math.max(world.hi[c], hi[c]);
    }

    // --- axis-aligned box colliders for solid, non-decal geometry ---
    // Anything flatter than 0.8 m is a painted marking, a shadow decal or a
    // kerb; turning those into boxes would litter the roads with invisible
    // walls, which is far worse than being able to clip a kerb.
    const he = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    const boxed = SOLID_BOXES.has(name)
      && he[1] * 2 > 0.8
      && Math.min(he[0], he[2]) > 0.15
      && Math.max(he[0], he[2]) * 2 <= BOX_MAX_FOOTPRINT;
    if (boxed) {
      boxes.push({
        p: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2].map((v) => +v.toFixed(2)),
        h: he.map((v) => +v.toFixed(2)),
      });
    }

    /** Boxed geometry is already solid; everything else solid needs a trimesh. */
    const collides = DRIVABLE.has(name) || (SOLID_BOXES.has(name) && !boxed);

    // --- normals ---
    const nrmAcc = prim.getAttribute('NORMAL');
    const nsrc = nrmAcc?.getArray();
    const nx = new Float32Array(count), ny = new Float32Array(count), nz = new Float32Array(count);
    if (nsrc) {
      const n = nm.m;
      for (let i = 0; i < count; i++) {
        const x = nsrc[i * 3], y = nsrc[i * 3 + 1], z = nsrc[i * 3 + 2];
        let a = n[0] * x + n[3] * y + n[6] * z;
        let b = n[1] * x + n[4] * y + n[7] * z;
        let c = n[2] * x + n[5] * y + n[8] * z;
        const len = Math.hypot(a, b, c) || 1;
        nx[i] = a / len; ny[i] = b / len; nz[i] = c / len;
      }
    } else {
      for (let i = 0; i < count; i++) ny[i] = 1;
    }

    // Only POSITION/NORMAL/TEXCOORD_0 are carried over. TEXCOORD_1/2, COLOR_0
    // and TANGENT are present on some primitives but unused by any material
    // here, and they are ~25% of the vertex payload.
    const uvAcc = prim.getAttribute('TEXCOORD_0');
    const uv = uvAcc?.getArray();

    const idxAcc = prim.getIndices();
    const idx = idxAcc ? idxAcc.getArray() : null;
    const triCount = idx ? idx.length / 3 : count / 3;

    // --- bucket by material + cell, using the primitive centroid ---
    const cx = Math.floor(((lo[0] + hi[0]) / 2) / CELL);
    const cz = Math.floor(((lo[2] + hi[2]) / 2) / CELL);
    const drivable = DRIVABLE.has(name);
    // `collides` is part of the key: a material can land in both buckets when
    // some of its primitives box cleanly and others fall through to trimesh.
    const key = `${name}|${cx}|${cz}|${collides ? 'c' : 'd'}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        material: prim.getMaterial(), name, drivable, collides, cell: [cx, cz],
        pos: [], nrm: [], uv: [], idx: [], verts: 0,
      };
      groups.set(key, g);
    }

    const base = g.verts;
    for (let i = 0; i < count; i++) {
      g.pos.push(px[i], py[i], pz[i]);
      g.nrm.push(nx[i], ny[i], nz[i]);
      g.uv.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
    }
    g.verts += count;

    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3;
      const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      if (flipWinding) g.idx.push(base + a, base + c, base + b);
      else g.idx.push(base + a, base + b, base + c);

      // Every drivable triangle is kept for the navigation raster (§4b). Paved
      // surfaces drive the road mask; terrain contributes ground height only,
      // so hills and cliffs never show up as roads on the map.
      if (drivable) {
        navTris.push({
          paved: PAVED.has(name),
          v: [px[a], py[a], pz[a], px[b], py[b], pz[b], px[c], py[c], pz[c]],
        });
      }
    }
  }
}
step(`bucketed into ${groups.size} chunks; ${boxes.length} box colliders`);
if (skippedNonTriangle) console.log(`  (skipped ${skippedNonTriangle} non-triangle primitives)`);

// ---------------------------------------------------------------------------
// 3. Re-centre the city on the origin so world coordinates stay small (float
//    precision, shadow-map fitting and the camera's `far` all prefer this).
//    Y is left alone: ground level is meaningful, and gravity points down.
// ---------------------------------------------------------------------------
const centre = [(world.lo[0] + world.hi[0]) / 2, 0, (world.lo[2] + world.hi[2]) / 2];
for (const g of groups.values())
  for (let i = 0; i < g.pos.length; i += 3) { g.pos[i] -= centre[0]; g.pos[i + 2] -= centre[2]; }
for (const b of boxes) { b.p[0] = +(b.p[0] - centre[0]).toFixed(2); b.p[2] = +(b.p[2] - centre[2]).toFixed(2); }
for (const t of navTris) { t.v[0] -= centre[0]; t.v[3] -= centre[0]; t.v[6] -= centre[0];
                           t.v[2] -= centre[2]; t.v[5] -= centre[2]; t.v[8] -= centre[2]; }

// ---------------------------------------------------------------------------
// 3b. Navigation raster.
//
// One RGBA image carries everything the running game needs to know about the
// ground without touching physics:
//
//   R  255 where the surface is paved  -> minimap, and the reset snap target
//   G,B ground height as a big-endian u16 across [minY, maxY]
//   A  255 where any drivable surface exists at all (G/B are meaningless at 0)
//
// It exists because Rapier cannot be queried for this. `wheelGroundObject()` and
// any collider lookup re-enter the borrowed World from inside the physics step
// and throw "recursive use of an object detected" (see §4), so the reset handler
// — which runs in `useBeforePhysicsStep` — has no way to raycast for the road.
// A precomputed raster answers "where is the nearest road, and how high is it"
// in O(1) from plain array indexing.
// ---------------------------------------------------------------------------
let navW = Math.ceil((world.hi[0] - world.lo[0]) / NAV_RESOLUTION);
let navH = Math.ceil((world.hi[2] - world.lo[2]) / NAV_RESOLUTION);
let navOriginX = world.lo[0] - centre[0];
let navOriginZ = world.lo[2] - centre[2];
const minY = world.lo[1];
const maxY = world.hi[1];
const ySpan = maxY - minY || 1;

let navRoad = new Uint8Array(navW * navH);
let navHas = new Uint8Array(navW * navH);
// Height is kept as f32 while rasterising so overlapping surfaces can be
// resolved by max (a bridge deck wins over the road beneath it).
let navHeight = new Float32Array(navW * navH).fill(-Infinity);

/** Scan-fill one triangle, writing max height and OR-ing the paved flag. */
function rasterise(tri) {
  const v = tri.v;
  const gx = (x) => (x - navOriginX) / NAV_RESOLUTION;
  const gz = (z) => (z - navOriginZ) / NAV_RESOLUTION;
  const x0 = gx(v[0]), z0 = gz(v[2]), x1 = gx(v[3]), z1 = gz(v[5]), x2 = gx(v[6]), z2 = gz(v[8]);
  const y0 = v[1], y1 = v[4], y2 = v[7];

  const loX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const hiX = Math.min(navW - 1, Math.ceil(Math.max(x0, x1, x2)));
  const loZ = Math.max(0, Math.floor(Math.min(z0, z1, z2)));
  const hiZ = Math.min(navH - 1, Math.ceil(Math.max(z0, z1, z2)));
  if (loX > hiX || loZ > hiZ) return;

  const area = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0);
  if (Math.abs(area) < 1e-9) return;
  const inv = 1 / area;

  for (let pz = loZ; pz <= hiZ; pz++) {
    for (let px2 = loX; px2 <= hiX; px2++) {
      // Sample at the pixel centre, in barycentric coordinates.
      const sx = px2 + 0.5, sz = pz + 0.5;
      const w0 = ((x1 - sx) * (z2 - sz) - (x2 - sx) * (z1 - sz)) * inv;
      const w1 = ((x2 - sx) * (z0 - sz) - (x0 - sx) * (z2 - sz)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;

      const i = pz * navW + px2;
      const h = w0 * y0 + w1 * y1 + w2 * y2;
      if (h > navHeight[i]) navHeight[i] = h;
      navHas[i] = 255;
      if (tri.paved) navRoad[i] = 255;
    }
  }
}
for (const tri of navTris) rasterise(tri);

// Punch the buildings back out of the road mask.
//
// The mask is built from paved geometry, which knows nothing about what was
// built on top of it — warehouses and shops frequently sit on their own paved
// lot, so those pixels come through as road. Left alone, `R` would happily
// "rescue" a stuck car to a spot inside a building, and the minimap would draw
// streets straight through them. Footprints are grown by BUILDING_CLEARANCE so
// the car lands clear of a wall rather than touching one.
//
// Only boxes resting near the local ground remove road: an overhead structure
// or a raised deck must not erase the street running underneath it.
const BUILDING_CLEARANCE = 1.5;
let clearedPixels = 0;
for (const b of boxes) {
  const bottom = b.p[1] - b.h[1];
  const x0 = Math.max(0, Math.floor((b.p[0] - b.h[0] - BUILDING_CLEARANCE - navOriginX) / NAV_RESOLUTION));
  const x1 = Math.min(navW - 1, Math.ceil((b.p[0] + b.h[0] + BUILDING_CLEARANCE - navOriginX) / NAV_RESOLUTION));
  const z0 = Math.max(0, Math.floor((b.p[2] - b.h[2] - BUILDING_CLEARANCE - navOriginZ) / NAV_RESOLUTION));
  const z1 = Math.min(navH - 1, Math.ceil((b.p[2] + b.h[2] + BUILDING_CLEARANCE - navOriginZ) / NAV_RESOLUTION));
  for (let pz = z0; pz <= z1; pz++) {
    for (let px2 = x0; px2 <= x1; px2++) {
      const i = pz * navW + px2;
      if (!navRoad[i]) continue;
      if (bottom > navHeight[i] + 3) continue;
      navRoad[i] = 0;
      clearedPixels++;
    }
  }
}
step(`cleared ${clearedPixels.toLocaleString()} road px under ${boxes.length} buildings`);

// Crop to the ground that actually exists. The world bbox is stretched by a few
// far-flung stray primitives, which left the city filling under half the raster
// — dead space that the minimap would happily scroll through and that wasted
// most of the full map's screen area.
let cropX0 = navW, cropX1 = -1, cropZ0 = navH, cropZ1 = -1;
for (let pz = 0; pz < navH; pz++) {
  for (let px2 = 0; px2 < navW; px2++) {
    if (!navHas[pz * navW + px2]) continue;
    if (px2 < cropX0) cropX0 = px2;
    if (px2 > cropX1) cropX1 = px2;
    if (pz < cropZ0) cropZ0 = pz;
    if (pz > cropZ1) cropZ1 = pz;
  }
}
const MARGIN = 6;
cropX0 = Math.max(0, cropX0 - MARGIN);
cropZ0 = Math.max(0, cropZ0 - MARGIN);
cropX1 = Math.min(navW - 1, cropX1 + MARGIN);
cropZ1 = Math.min(navH - 1, cropZ1 + MARGIN);
const cropW = cropX1 - cropX0 + 1;
const cropH = cropZ1 - cropZ0 + 1;

const navRGBA = Buffer.alloc(cropW * cropH * 4);
// The working arrays are cropped alongside the image, NOT left at the original
// stride. Everything downstream (the spawn search) indexes them as
// `pz * navW + px`, so leaving them full-size while navW shrinks silently reads
// the wrong pixels — which is how the spawn ended up on a tile that was neither
// road nor even ground.
const cropRoad = new Uint8Array(cropW * cropH);
const cropHas = new Uint8Array(cropW * cropH);
const cropHeight = new Float32Array(cropW * cropH);
let pavedPixels = 0;
for (let pz = 0; pz < cropH; pz++) {
  for (let px2 = 0; px2 < cropW; px2++) {
    const src = (pz + cropZ0) * navW + (px2 + cropX0);
    const out = pz * cropW + px2;
    const dst = out * 4;
    const h = navHeight[src];
    const u16 = navHas[src] ? Math.max(0, Math.min(65535, Math.round(((h - minY) / ySpan) * 65535))) : 0;
    navRGBA[dst] = navRoad[src];
    navRGBA[dst + 1] = u16 >> 8;
    navRGBA[dst + 2] = u16 & 0xff;
    navRGBA[dst + 3] = navHas[src];
    cropRoad[out] = navRoad[src];
    cropHas[out] = navHas[src];
    cropHeight[out] = h;
    if (navRoad[src]) pavedPixels++;
  }
}
// The crop moves the raster's origin, so georeferencing has to follow it.
navOriginX += cropX0 * NAV_RESOLUTION;
navOriginZ += cropZ0 * NAV_RESOLUTION;
navW = cropW;
navH = cropH;
navRoad = cropRoad;
navHas = cropHas;
navHeight = cropHeight;

await sharp(navRGBA, { raw: { width: navW, height: navH, channels: 4 } })
  .png({ compressionLevel: 9, palette: false })
  .toFile(NAV);
step(`nav raster ${navW}x${navH} @ ${NAV_RESOLUTION} m/px — ${pavedPixels.toLocaleString()} paved px`);

// ---------------------------------------------------------------------------
// 4. Choose a spawn, from the finished road mask.
//
// Deliberately NOT from the raw Street/Parking triangles: those still include
// the paved lots inside building blocks, which is how the car ended up starting
// in a walled yard between two warehouses.
//
// Nor from "how much pavement surrounds this point" — that scores a car park or
// a courtyard *higher* than a street, and picked an elevated parking deck in the
// middle of a block. What actually distinguishes a street is that it is a long
// linear corridor, so candidates are ranked by the longest unbroken straight run
// of road through them. A courtyard is bounded by its block; an avenue runs for
// hundreds of metres.
// ---------------------------------------------------------------------------

/** Longest straight run of road through a pixel, and the axis it runs along. */
const RUN_CAP = 160; // pixels, i.e. 240 m at 1.5 m/px
const onRoadPx = (px2, pz) =>
  px2 >= 0 && pz >= 0 && px2 < navW && pz < navH && navRoad[pz * navW + px2] !== 0;

function longestRun(px2, pz) {
  let bestRun = -1, bestAxis = 0;
  for (let a = 0; a < 12; a++) {
    const theta = (a / 12) * Math.PI;
    const dx = Math.cos(theta), dz = Math.sin(theta);
    let run = 0;
    for (const sign of [1, -1])
      for (let d = 1; d <= RUN_CAP; d++) {
        if (!onRoadPx(Math.round(px2 + dx * d * sign), Math.round(pz + dz * d * sign))) break;
        run++;
      }
    if (run > bestRun) { bestRun = run; bestAxis = theta; }
  }
  return { run: bestRun, axis: bestAxis };
}

// Minimum road height per block, so a candidate can be rejected when the
// street it belongs to also exists further down. Without this the search happily
// picks a raised deck or a flyover sitting above the road it should start on.
const BLOCK = 16; // px, i.e. ~24 m at 1.5 m/px
const bw = Math.ceil(navW / BLOCK), bh = Math.ceil(navH / BLOCK);
const blockMin = new Float32Array(bw * bh).fill(Infinity);
for (let pz = 0; pz < navH; pz++)
  for (let px2 = 0; px2 < navW; px2++) {
    const i = pz * navW + px2;
    if (!navRoad[i]) continue;
    const b = Math.floor(pz / BLOCK) * bw + Math.floor(px2 / BLOCK);
    if (navHeight[i] < blockMin[b]) blockMin[b] = navHeight[i];
  }
const localMinHeight = (px2, pz) => {
  const bx = Math.floor(px2 / BLOCK), bz = Math.floor(pz / BLOCK);
  let m = Infinity;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = bx + dx, z = bz + dz;
      if (x < 0 || z < 0 || x >= bw || z >= bh) continue;
      if (blockMin[z * bw + x] < m) m = blockMin[z * bw + x];
    }
  return m;
};

/** Centre of the road network — not the centre of the bounding box. */
let sumX = 0, sumZ = 0, roadCount = 0;
for (let pz = 0; pz < navH; pz++)
  for (let px2 = 0; px2 < navW; px2++)
    if (navRoad[pz * navW + px2]) { sumX += px2; sumZ += pz; roadCount++; }
const hubX = roadCount ? sumX / roadCount : navW / 2;
const hubZ = roadCount ? sumZ / roadCount : navH / 2;
const maxDist = Math.hypot(navW, navH);

let bestScore = -Infinity;
let spawnPx = Math.round(hubX), spawnPz = Math.round(hubZ), spawnAxis = 0;
// Every other pixel: 3 m resolution is far finer than the choice needs.
for (let pz = 0; pz < navH; pz += 2) {
  for (let px2 = 0; px2 < navW; px2 += 2) {
    const i = pz * navW + px2;
    if (!navRoad[i]) continue;
    // Reject anything raised above the road surface beneath it.
    if (navHeight[i] - localMinHeight(px2, pz) > 2) continue;

    const { run, axis } = longestRun(px2, pz);
    const pull = Math.hypot(px2 - hubX, pz - hubZ) / maxDist;
    const score = Math.min(run, RUN_CAP) / RUN_CAP - 0.45 * pull;
    if (score > bestScore) { bestScore = score; spawnPx = px2; spawnPz = pz; spawnAxis = axis; }
  }
}

const spawn = {
  x: navOriginX + (spawnPx + 0.5) * NAV_RESOLUTION,
  z: navOriginZ + (spawnPz + 0.5) * NAV_RESOLUTION,
  y: navHas[spawnPz * navW + spawnPx] ? navHeight[spawnPz * navW + spawnPx] : 0,
};

// Face along the street. Forward is (-sin h, -cos h), so an axis (dx, dz) maps
// to atan2(-dx, -dz); the axis is undirected and either end will do.
const heading = Math.atan2(-Math.cos(spawnAxis), -Math.sin(spawnAxis));

// ---------------------------------------------------------------------------
// 5. Build the output scene: one node + mesh per chunk.
// ---------------------------------------------------------------------------
const buffer = root.listBuffers()[0];
const newNodes = [];
let outTris = 0, outVerts = 0, roadTriTotal = 0;

for (const g of groups.values()) {
  if (!g.idx.length) continue;
  const prim = doc.createPrimitive().setMaterial(g.material).setMode(4);
  prim.setAttribute('POSITION',
    doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer));
  prim.setAttribute('NORMAL',
    doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.nrm)).setBuffer(buffer));
  prim.setAttribute('TEXCOORD_0',
    doc.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.idx)).setBuffer(buffer));

  // Chunk role travels in `extras`, NOT in the node name: three's GLTFLoader
  // runs every name through PropertyBinding.sanitizeNodeName, which strips
  // ".:/[]" outright — a "col::Street::-2_1" node arrives as "colStreet-2_1"
  // and any prefix test on it silently matches nothing. `extras` is copied
  // verbatim to Object3D.userData instead.
  const label = `${g.collides ? 'col' : 'deco'}_${g.name}_${g.cell[0]}_${g.cell[1]}`.replace(/[^\w-]/g, '_');
  const mesh = doc.createMesh(label);
  mesh.addPrimitive(prim);
  newNodes.push(
    doc.createNode(label)
      .setMesh(mesh)
      .setExtras({ collides: g.collides, surface: g.name }),
  );

  outVerts += g.verts;
  outTris += g.idx.length / 3;
  if (g.collides) roadTriTotal += g.idx.length / 3;
}

// Detach the original hierarchy; the transforms now live in the vertex data.
for (const child of scene.listChildren()) scene.removeChild(child);
for (const n of newNodes) scene.addChild(n);
step(`built ${newNodes.length} chunk meshes (${Math.round(outTris).toLocaleString()} tris)`);

// ---------------------------------------------------------------------------
// 6. Materials: alpha-test the foliage instead of alpha-blending it.
//    BLEND forces back-to-front sorting and full overdraw on 1.6 M triangles of
//    leaves; MASK is a shader discard and also fixes trees sorting through
//    each other.
// ---------------------------------------------------------------------------
let masked = 0;
for (const mat of root.listMaterials()) {
  if (FOLIAGE.has(mat.getName()) && mat.getAlphaMode() === 'BLEND') {
    mat.setAlphaMode('MASK').setAlphaCutoff(0.5);
    masked++;
  }
}

// ---------------------------------------------------------------------------
// 7. Textures: 9.28 MB of PNG -> WebP, capped at 2048 px.
// ---------------------------------------------------------------------------
let texBefore = 0, texAfter = 0;
for (const tex of root.listTextures()) {
  const img = tex.getImage();
  if (!img) continue;
  texBefore += img.byteLength;
  const webp = await sharp(Buffer.from(img))
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toBuffer();
  tex.setImage(new Uint8Array(webp)).setMimeType('image/webp');
  texAfter += webp.byteLength;
}
step(`textures ${mb(texBefore)} -> ${mb(texAfter)}`);

// ---------------------------------------------------------------------------
// 8. Drop everything the rebuilt scene no longer references.
//
// The original primitives must be disposed EXPLICITLY. Disposing a Mesh leaves
// its Primitives parented to the Root, and those Primitives still reference the
// source accessors — so a pure orphan sweep keeps all 52,210 of them alive and
// the writer happily serialises 179 MB of dead geometry alongside the new
// chunks. (Symptom: Draco compresses fine and the file still grows.)
// ---------------------------------------------------------------------------
for (const mesh of originalMeshes) {
  for (const prim of mesh.listPrimitives()) {
    prim.dispose();
  }
  mesh.dispose();
}

const isOrphan = (prop) => prop.listParents().every((p) => p.propertyType === 'Root');
for (let pass = 0; pass < 4; pass++) {
  for (const list of [root.listNodes(), root.listMeshes(), root.listAccessors(), root.listMaterials(), root.listTextures()])
    for (const prop of list) if (isOrphan(prop)) prop.dispose();
}
step(`pruned to ${root.listMeshes().length} meshes, ${root.listAccessors().length} accessors`);

// ---------------------------------------------------------------------------
// 9. Draco.
//
// `quantizationVolume: 'mesh'` — NOT 'scene'. Scene-wide quantisation spreads
// 14 bits over 8.8 km, i.e. 54 cm buckets, which would visibly corrugate every
// road and (because the road chunks double as the collider) make the car
// judder. Per-mesh volumes are 400 m wide, so 14 bits is ~2.4 cm.
// ---------------------------------------------------------------------------
doc.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    encodeSpeed: 5,
    decodeSpeed: 5,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });

step('encoding Draco (this takes a while)…');
await io.write(DST, doc);

// ---------------------------------------------------------------------------
writeFileSync(DATA, JSON.stringify({
  unitScale: UNIT_SCALE,
  cell: CELL,
  bounds: {
    min: [+(world.lo[0] - centre[0]).toFixed(2), +world.lo[1].toFixed(2), +(world.lo[2] - centre[2]).toFixed(2)],
    max: [+(world.hi[0] - centre[0]).toFixed(2), +world.hi[1].toFixed(2), +(world.hi[2] - centre[2]).toFixed(2)],
  },
  spawn: {
    position: [+spawn.x.toFixed(2), +(spawn.y + 0.6).toFixed(2), +spawn.z.toFixed(2)],
    heading: +heading.toFixed(4),
  },
  /** Georeferencing for `cityNav.png`: pixel (px,py) -> world (originX + px*mpp, originZ + py*mpp). */
  nav: {
    width: navW,
    height: navH,
    metresPerPixel: NAV_RESOLUTION,
    originX: +navOriginX.toFixed(2),
    originZ: +navOriginZ.toFixed(2),
    minY: +minY.toFixed(2),
    maxY: +maxY.toFixed(2),
  },
  boxes,
}) + '\n');

const srcSize = readFileSync(SRC).byteLength;
const dstSize = readFileSync(DST).byteLength;
const size = [0, 1, 2].map((c) => world.hi[c] - world.lo[c]);

console.log('\n--- city ---');
console.log(`  extent      ${(size[0] / 1000).toFixed(2)} x ${(size[2] / 1000).toFixed(2)} km, ${size[1].toFixed(0)} m of relief`);
console.log(`  chunks      ${newNodes.length}  (${groups.size} material x cell buckets, ${CELL} m cells)`);
console.log(`  triangles   ${Math.round(outTris).toLocaleString()}  of which ${Math.round(roadTriTotal).toLocaleString()} collidable`);
console.log(`  vertices    ${outVerts.toLocaleString()}`);
console.log(`  boxes       ${boxes.length} building/obstacle colliders`);
console.log(`  foliage     ${masked} material(s) switched BLEND -> MASK`);
console.log(`  spawn       ${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}, ${spawn.z.toFixed(1)}  heading ${(heading * 180 / Math.PI).toFixed(0)}deg`);
console.log(`  GLB         ${mb(srcSize)} -> ${mb(dstSize)}\n`);
