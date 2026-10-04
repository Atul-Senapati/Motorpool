/*
 * Collider boxes that follow the buildings instead of boxing the sky round them.
 *
 * Every solid thing at the airport had ONE collider: a cuboid the size of the
 * model's bounding box. For a hangar that is honest — a hangar is a box. For
 * everything else it is a lie you can drive into:
 *
 *   terminal      a 200 m concourse laid DIAGONALLY across its own bounds, so
 *                 the box was 108 x 210 m and the building was a band through
 *                 the middle of it. The forecourt either side was solid air.
 *   deco_Building a city chunk is a grid CELL, not a building — ten separate
 *                 blocks with streets between them. Boxed whole, the streets
 *                 were walls.
 *   tower         round. Boxed, its four corners were not.
 *   coaster       a hundred metres of track and sky. Its box was the sky.
 *
 * So this measures what is actually there and writes boxes that fit it.
 *
 * ## How
 *
 * 1. Rasterise, per part, every near-VERTICAL surface whose height band
 *    overlaps a car's, onto a grid of the part's own footprint. Vertical
 *    matters: a floor is not an obstacle, and counting it would fill the plan
 *    of every building solid. Height matters too — a canopy 4 m up leaves only
 *    its columns here, which is exactly what you can drive between.
 * 2. Flood the OUTSIDE and solidify whatever the flood could not reach, so a
 *    building is a mass rather than a ring of walls a car can end up inside.
 * 3. Cover that mass with the largest all-solid rectangles, biggest first.
 *
 * The boxes come out in the part's placed frame: x and z about the footprint
 * centre, y from the base, which is how `cityPartMatrix` and the airport's own
 * `copy.position.set(b.x, 0, b.z)` both place their meshes.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

/** Metres. Fine enough to follow a diagonal, coarse enough to stay cheap. */
const CELL = 2.0;
/** The band a car can hit: above the kerb, below the roof. */
const SILL = 0.3, CAR_TOP = 2.6;

/**
 * Parts whose lowest geometry is not an obstacle, and where their band starts.
 *
 * The crane is the reason. Its rails are 40 cm of steel running 137 m down the
 * apron, which clears `SILL` by a whisker — so they rasterised as two
 * continuous walls, the flood could not get between them, and the strip
 * between the rails solidified. The crane came out as a single 10 x 138 m box:
 * an invisible slab across the freight apron that the service router then had
 * to drive its cargo loop through the containers to avoid.
 *
 * A rail is something a lorry bumps over, not something it hits. Starting the
 * crane's band at 1.2 m leaves the mast, the base and the bogie frames — which
 * are the parts that would actually stop a vehicle.
 */
const BAND_FLOOR = {
  crane: 1.2,
  /*
   * And the school, for the same shape of reason one step round.
   *
   * Its campus is one slab of lot, path and playing field with a skirt under
   * the rim that reaches 1.3 m below the deck (`prepare-school.mjs` measures
   * it and writes it out as `skirt`). That skirt is a vertical surface running
   * the whole way round the campus, so measured from the bounding box it
   * rasterises as a closed wall, the flood cannot get in, and 17,600 square
   * metres of parking lot and running track solidify behind it. Starting the
   * band above the deck leaves the building, the stand and the backstop, which
   * are the things a car can actually hit.
   */
  school: +JSON.parse(readFileSync('src/config/schoolData.json', 'utf8')).skirt + SILL,
};
/** Stop covering when the rectangles get smaller than this many cells. */
const MIN_CELLS = 1;
const MAX_BOXES = 192;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

/** Every `deco_*` chunk any config places, so the set cannot drift. */
function decoPartsUsed() {
  const names = new Set();
  for (const f of readdirSync('src/config')) {
    if (!f.endsWith('.ts')) continue;
    for (const m of readFileSync(`src/config/${f}`, 'utf8').matchAll(/deco_[A-Za-z0-9_-]+/g)) names.add(m[0]);
  }
  return names;
}

function rasterise(node) {
  const mesh = node.getMesh();
  if (!mesh) return null;
  const sill = BAND_FLOOR[node.getName()] ?? SILL;
  const tris = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const idx = prim.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    const get = (i) => pos.getElement(idx ? idx.getScalar(i) : i, [0, 0, 0]);
    for (let i = 0; i < n; i += 3) {
      const t = [get(i), get(i + 1), get(i + 2)];
      tris.push(t);
      for (const p of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    }
  }
  if (!tris.length) return null;
  const nx = Math.max(1, Math.ceil((hi[0] - lo[0]) / CELL));
  const nz = Math.max(1, Math.ceil((hi[2] - lo[2]) / CELL));
  const grid = new Uint8Array(nx * nz);
  const band = [lo[1] + sill, lo[1] + CAR_TOP];
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ny = u[2] * v[0] - u[0] * v[2];
    const len = Math.hypot(u[1] * v[2] - u[2] * v[1], ny, u[0] * v[1] - u[1] * v[0]);
    if (len < 1e-9 || Math.abs(ny / len) > 0.6) continue;          // a floor or a roof
    if (Math.max(a[1], b[1], c[1]) < band[0] || Math.min(a[1], b[1], c[1]) > band[1]) continue;
    const side = Math.max(Math.hypot(...u), Math.hypot(...v));
    const N = Math.min(96, Math.max(3, Math.ceil(side / (CELL * 0.35))));
    for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
      const s = i / N, t = j / N;
      const y = a[1] + u[1] * s + v[1] * t;
      if (y < band[0] || y > band[1]) continue;
      const ix = Math.min(nx - 1, Math.max(0, Math.floor((a[0] + u[0] * s + v[0] * t - lo[0]) / CELL)));
      const iz = Math.min(nz - 1, Math.max(0, Math.floor((a[2] + u[2] * s + v[2] * t - lo[2]) / CELL)));
      grid[iz * nx + ix] = 1;
    }
  }
  return { lo, hi, nx, nz, grid };
}

/** Anything the outside air cannot reach is inside a building. */
function fillInteriors({ nx, nz, grid }) {
  const seen = new Uint8Array(nx * nz);
  const stack = [];
  for (let ix = 0; ix < nx; ix++) { stack.push([ix, 0], [ix, nz - 1]); }
  for (let iz = 0; iz < nz; iz++) { stack.push([0, iz], [nx - 1, iz]); }
  while (stack.length) {
    const [x, z] = stack.pop();
    if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
    const k = z * nx + x;
    if (seen[k] || grid[k]) continue;
    seen[k] = 1;
    stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]);
  }
  for (let k = 0; k < grid.length; k++) if (!grid[k] && !seen[k]) grid[k] = 1;
}

/** The largest all-solid rectangle left, by the histogram method. */
function biggestRect(grid, nx, nz) {
  const heights = new Int32Array(nx);
  let best = null;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) heights[ix] = grid[iz * nx + ix] ? heights[ix] + 1 : 0;
    const stack = [];
    for (let ix = 0; ix <= nx; ix++) {
      const h = ix === nx ? 0 : heights[ix];
      let start = ix;
      while (stack.length && stack[stack.length - 1][1] >= h) {
        const [s, sh] = stack.pop();
        const area = sh * (ix - s);
        if (!best || area > best.area) best = { area, x0: s, x1: ix, z0: iz - sh + 1, z1: iz + 1 };
        start = s;
      }
      stack.push([start, h]);
    }
  }
  return best;
}

function boxesFor(node) {
  const r = rasterise(node);
  if (!r) return null;
  fillInteriors(r);
  const { lo, hi, nx, nz, grid } = r;
  const work = Uint8Array.from(grid);
  const boxes = [];
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
  for (let n = 0; n < MAX_BOXES; n++) {
    const b = biggestRect(work, nx, nz);
    if (!b || b.area < MIN_CELLS) break;
    for (let z = b.z0; z < b.z1; z++) for (let x = b.x0; x < b.x1; x++) work[z * nx + x] = 0;
    const x0 = lo[0] + b.x0 * CELL, x1 = Math.min(hi[0], lo[0] + b.x1 * CELL);
    const z0 = lo[2] + b.z0 * CELL, z1 = Math.min(hi[2], lo[2] + b.z1 * CELL);
    boxes.push([
      +((x0 + x1) / 2 - cx).toFixed(2), +((z0 + z1) / 2 - cz).toFixed(2),
      +((x1 - x0) / 2).toFixed(2), +((z1 - z0) / 2).toFixed(2),
    ]);
  }
  const solid = grid.reduce((a, b) => a + b, 0);
  const missed = work.reduce((a, b) => a + b, 0);
  return {
    size: [+(hi[0] - lo[0]).toFixed(2), +(hi[1] - lo[1]).toFixed(2), +(hi[2] - lo[2]).toFixed(2)],
    height: +(hi[1] - lo[1]).toFixed(2),
    boxes,
    // What the single bounding box used to claim, against what is there.
    coverage: +((solid / (nx * nz)) * 100).toFixed(0),
    // How much of the solid mass the boxes did NOT get. Under-covering is its
    // own bug — it is a wall you drive through — so it is measured, not assumed.
    missed: +((missed / Math.max(1, solid)) * 100).toFixed(1),
  };
}

const out = {};
const wanted = decoPartsUsed();
for (const [file, keep] of [['public/models/airport.glb', () => true],
                            ['public/models/park.glb', () => true],
                            // Halcyon Parade's shops, hotel and offices. Same
                            // deal as the park: every part in the file is
                            // placed, so measure all of them.
                            ['public/models/parade.glb', () => true],
                            // Kestrel's school campus. One node, and most of
                            // its footprint is lot and playing field — which is
                            // exactly why it is measured rather than boxed.
                            ['public/models/school.glb', () => true],
                            // St. Anjali's workshop block, and the European
                            // pack it was chosen over — every node in both is a
                            // building, so measure all of them.
                            ['public/models/workshop.glb', () => true],
                            // The Hall of Justice, which is a colonnade round a
                            // hall: a bounding box would make a portico you can
                            // walk through into a wall you cannot.
                            ['public/models/justice.glb', () => true],
                            // The mall: six ranges with gaps between them, so
                            // one box round the lot would make 157 m of service
                            // yard into a wall.
                            ['public/models/mall.glb', () => true],
                            // The two halls in Kestrel's south-west blocks:
                            // colonnades and towers round open courts, so a
                            // bounding box would be a wall across a courtyard.
                            ['public/models/sportsHall.glb', () => true],
                            ['public/models/assemblyHall.glb', () => true],
                            ['public/models/macShop.glb', () => true],
                            ['public/models/factoryHall.glb', () => true],
                            ['public/models/aquaPark.glb', () => true],
                            // The petrol station cut out of the city: a canopy on
                            // columns, so a box round it would wall off the pumps.
                            ['public/models/petrol.glb', () => true],
                            ['public/models/factoryShed.glb', () => true],
                            ['public/models/factoryDepot.glb', () => true],
                            ['public/models/factoryBlock.glb', () => true],
                            ['public/models/jacksShop.glb', () => true],
                            ['public/models/tilesShop.glb', () => true],
                            // The airport's entrance canopy: a roof ON COLUMNS,
                            // so a box round its bounds would wall off the
                            // forecourt you drive under it into.
                            ['public/models/entrygate.glb', () => true],
                            ['public/models/euro.glb', () => true],
                            ['public/models/city.glb', (n) => wanted.has(n)]]) {
  const doc = await io.read(file);
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (!keep(name) || out[name]) continue;
    const b = boxesFor(node);
    if (b && b.boxes.length) out[name] = b;
  }
}
writeFileSync('src/config/colliderBoxes.json', `${JSON.stringify(out, null, 1)}\n`);
const rows = Object.entries(out).sort((a, b) => a[1].coverage - b[1].coverage);
console.log(`${rows.length} parts measured (cell ${CELL} m, car band ${SILL}..${CAR_TOP} m)\n`);
console.log('  part                    bounding box     solid   boxes   uncovered');
for (const [n, b] of rows)
  console.log(`  ${n.padEnd(22)} ${b.size[0].toFixed(0).padStart(4)} x ${b.size[2].toFixed(0).padStart(4)} m  ${String(b.coverage).padStart(4)}%   ${String(b.boxes.length).padStart(4)}   ${String(b.missed).padStart(5)}%`);
