/**
 * Surveys places in the city the player can be dropped into.
 *
 * The city had exactly one spawn — the widest street nearest the middle of the
 * map, measured once by `prepare-map.mjs` — so every drive started in the same
 * place facing the same way. This finds a *set* of them, spread across the
 * whole map, and `vehicleConfig` picks one per drive.
 *
 * ## Candidates come from the road graph, not the raster
 *
 * They used to come from a grid sweep of `cityNav.png`, accepting any pixel
 * the raster called street that had street either side and a clear run ahead.
 * That is not the same question as "is this a road". A multi-storey car park's
 * roof deck is built from road material, so the raster calls it street; one
 * measured 100 m by 30 m, stood 2.5 m up, touched no street anywhere, and duly
 * passed every test — a drive started on top of it, 75 m from the nearest
 * street, with no way down.
 *
 * So candidates are now sampled along `roadGraph.json`, the connected street
 * network `make-road-graph.mjs` skeletonises out of the same raster. That
 * network has already thrown decks away: an isolated slab is either wider than
 * a street (pruned as a plaza) or a component of its own (pruned as too
 * small). Being *on* it is therefore the guarantee, and it is the same network
 * the NPC traffic drives, so the player and the traffic agree about where the
 * roads are.
 *
 * It also fixes the heading. The old survey guessed the street's axis by
 * probing eighteen directions and faced whichever end had more room, which on
 * a two-way street is a coin toss — half of all drives started facing into
 * oncoming traffic. A graph edge has a direction; the car is placed in the
 * driving-side lane, facing the way that lane goes.
 *
 * Everything a candidate still has to prove, against the raster:
 *
 *  1. **It is flat under the car.** A spawn is a drop from 0.6 m; a point with
 *     a kerb or a ramp under the footprint lands the car tilted, which on this
 *     physics costs a wheel or flips it outright.
 *  2. **It has road ahead of it and behind it**, so the first thing you do on
 *     spawning is drive rather than reverse off a kerb.
 *  3. **It is clear of the rails.** The tram loop runs down real streets and
 *     five trams run it; a car spawned between the rails is a car spawned
 *     inside a kinematic wall on its way. The train route is checked too,
 *     which in practice only matters at its level crossings.
 *  4. **It is not in a junction**, and not on a roundabout: both ends of every
 *     edge are left alone, and one-way ring edges are skipped entirely.
 *  5. **It is far from the other spawns.** Accepted greedily from a shuffled
 *     list with a minimum separation, so the set covers the city rather than
 *     clustering wherever the grid is densest.
 *
 * Re-running gives a different set; the seed is printed and can be passed back
 * to reproduce one exactly:
 *
 *   npm run spawns              # a new set
 *   npm run spawns -- 12345     # that exact set again
 *
 * Emits `src/config/spawnPoints.json`, which `cityConfig.ts` reads. Re-run it
 * after `npm run roads`, which is itself re-run after `npm run prepare:map`.
 */
import sharp from 'sharp';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const NAV_IMAGE = 'public/models/cityNav.png';
const CITY_DATA = 'src/config/cityData.json';
const ROAD_GRAPH = 'src/config/roadGraph.json';
const TRAFFIC_CONFIG = 'src/config/trafficConfig.ts';
const RAIL_ROUTES = ['src/config/tramRoute.json', 'src/config/trainRoute.json'];
const OUT = 'src/config/spawnPoints.json';

/**
 * Half-width of pavement wanted either side of the spawn. The widest thing in
 * the garage is the monster truck at 2.5 m, so 1.6 m either side of the
 * centreline leaves it a little air without demanding a boulevard — most of
 * this city's streets are 7 m.
 */
const CORRIDOR = 1.6;
/**
 * Metres of clear road the car must have in front of it. Deliberately more
 * than a car length: it is what separates a street from a paved pocket, and it
 * means the first thing you do on spawning is drive rather than reverse.
 */
const CLEAR_AHEAD = 30;
/** Metres of clear road behind, so the tail is not already inside a wall. */
const CLEAR_BEHIND = 8;
/**
 * Height a spawn footprint may vary by, in metres. The drop is 0.6 m, so
 * anything past this is a kerb or a ramp and lands the car cocked over.
 */
const MAX_FOOTPRINT_RELIEF = 0.35;
/** Footprint measured for relief: half-length and half-width, metres. */
const FOOTPRINT = [3, 1.6];
/** Clearance from any rail centreline. Tram gauge is 1.44 m; this clears it. */
const RAIL_CLEARANCE = 9;
/** Minimum distance between two spawns, so they are genuinely different places. */
const MIN_SEPARATION = 300;
/** How many to keep. Twelve is enough that a session rarely repeats itself. */
const WANT = 12;
/** Metres between candidates along an edge. */
const PITCH = 8;
/**
 * Metres of an edge left alone at each end. A spawn inside a junction is a
 * spawn in the middle of a give-way decision four NPCs are also making.
 */
const JUNCTION_CLEAR = 14;
/** Metres between samples when validating a corridor. Finer than the raster. */
const STEP = 1.0;

const seed = Number(process.argv[2] ?? Math.floor(Math.random() * 1e9));
let rngState = seed >>> 0 || 1;
/** xorshift32 — small, seeded, and reproducible across runs. */
function rng() {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 0x100000000;
}

// ---------------------------------------------------------------------------
// The raster.
// ---------------------------------------------------------------------------
const city = JSON.parse(readFileSync(CITY_DATA, 'utf8'));
const { originX, originZ, metresPerPixel, minY, maxY } = city.nav;

const { data, info } = await sharp(NAV_IMAGE).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const CH = info.channels;
console.log(`nav raster ${W}x${H} at ${metresPerPixel} m/px, origin (${originX}, ${originZ})`);

const toPx = (x) => Math.round((x - originX) / metresPerPixel);
const toPz = (z) => Math.round((z - originZ) / metresPerPixel);
const toWorldX = (i) => originX + i * metresPerPixel;
const toWorldZ = (j) => originZ + j * metresPerPixel;

function isRoad(x, z) {
  const i = toPx(x), j = toPz(z);
  if (i < 0 || j < 0 || i >= W || j >= H) return false;
  // The narrow level: street, not every paved yard. See cityNav.ts on `R`.
  return data[(j * W + i) * CH] > 191;
}

function groundHeight(x, z) {
  const i = toPx(x), j = toPz(z);
  if (i < 0 || j < 0 || i >= W || j >= H) return null;
  const o = (j * W + i) * CH;
  if (data[o + 3] < 128) return null;
  return minY + (((data[o + 1] << 8) | data[o + 2]) / 65535) * (maxY - minY);
}

// ---------------------------------------------------------------------------
// The road graph, and the lane geometry that has to match the traffic's.
//
// `laneOffset` is duplicated from `roadGraph.ts` — the player has to be put in
// the same lane the NPCs use, and two copies of "a quarter of the width,
// clamped" is exactly the sort of number that drifts. So the clamps are read
// out of `trafficConfig.ts` rather than written again here, and the run fails
// loudly if they ever stop being findable.
// ---------------------------------------------------------------------------
const graph = JSON.parse(readFileSync(ROAD_GRAPH, 'utf8'));
const trafficSource = readFileSync(TRAFFIC_CONFIG, 'utf8');
const readNumber = (name) => {
  const m = trafficSource.match(new RegExp(`${name}:\\s*(-?[\\d.]+)`));
  if (!m) throw new Error(`${TRAFFIC_CONFIG}: could not find ${name}`);
  return Number(m[1]);
};
const LANE_MIN = readNumber('laneOffsetMin');
const LANE_MAX = readNumber('laneOffsetMax');
const DRIVE_ON_RIGHT = /driveOnRight:\s*true/.test(trafficSource);
const laneOffset = (width) => Math.min(LANE_MAX, Math.max(LANE_MIN, width * 0.25));
console.log(`road graph: ${graph.nodes.length} junctions, ${graph.edges.length} streets; `
  + `lane offset ${LANE_MIN}-${LANE_MAX} m, driving on the ${DRIVE_ON_RIGHT ? 'right' : 'left'}`);

// ---------------------------------------------------------------------------
// Rail centrelines to stay clear of.
//
// Each route is treated as its straight polyline, which is not exactly the
// rail: the tram's corners are rounded, so the real rail cuts *inside* each
// vertex. That errs the safe way — a point measured clear of the polyline is
// at least as clear of the rail it stands for.
// ---------------------------------------------------------------------------
const railSegments = [];
for (const file of RAIL_ROUTES) {
  if (!existsSync(file)) continue;
  const route = JSON.parse(readFileSync(file, 'utf8'));
  const points = route.points ?? [];
  if (points.length < 2) continue;
  // Tram points are [x, z]; train points carry a height and more besides, so
  // the horizontal pair is (0, 2) there. Both are read as a ground track.
  const flat = points.map((p) => (p.length >= 3 ? [p[0], p[2]] : [p[0], p[1]]));
  // The tram's route is a closed loop; the train's is written closed too.
  for (let i = 0; i < flat.length; i++) {
    railSegments.push([flat[i], flat[(i + 1) % flat.length]]);
  }
  console.log(`  keeping ${RAIL_CLEARANCE} m clear of ${file} (${flat.length} points)`);
}

/** Squared distance from a point to a segment, in the ground plane. */
function distanceToSegment2(x, z, [a, b]) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
  const px = a[0] + dx * t, pz = a[1] + dz * t;
  return (x - px) ** 2 + (z - pz) ** 2;
}

const clearOfRails = (x, z) =>
  railSegments.every((s) => distanceToSegment2(x, z, s) >= RAIL_CLEARANCE ** 2);

// ---------------------------------------------------------------------------
// What makes a point drivable.
// ---------------------------------------------------------------------------
/** Road, and road `CORRIDOR` either side of the direction of travel. */
function corridorClear(x, z, heading) {
  if (!isRoad(x, z)) return false;
  // Forward is (-sin h, -cos h), so the lateral axis is (-cos h, sin h).
  const lx = -Math.cos(heading), lz = Math.sin(heading);
  for (const d of [-CORRIDOR, CORRIDOR]) {
    if (!isRoad(x + lx * d, z + lz * d)) return false;
  }
  return true;
}

/** How far the corridor stays clear from (x, z) along `heading`, up to `limit`. */
function runAhead(x, z, heading, limit) {
  const fx = -Math.sin(heading), fz = -Math.cos(heading);
  for (let d = STEP; d <= limit; d += STEP) {
    if (!corridorClear(x + fx * d, z + fz * d, heading)) return d - STEP;
  }
  return limit;
}

/** Height spread over the car's own footprint. */
function footprintRelief(x, z, heading) {
  const fx = -Math.sin(heading), fz = -Math.cos(heading);
  const lx = -Math.cos(heading), lz = Math.sin(heading);
  let lo = Infinity, hi = -Infinity;
  for (const along of [-FOOTPRINT[0], 0, FOOTPRINT[0]]) {
    for (const across of [-FOOTPRINT[1], 0, FOOTPRINT[1]]) {
      const h = groundHeight(x + fx * along + lx * across, z + fz * along + lz * across);
      if (h === null) return Infinity;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return hi - lo;
}

// ---------------------------------------------------------------------------
// Walk the graph for candidates.
// ---------------------------------------------------------------------------
const candidates = [];
let sampled = 0;
let rejectedRail = 0, rejectedRun = 0, rejectedRelief = 0, rejectedHeight = 0;

for (const edge of graph.edges) {
  // A roundabout's ring: one-way, short, and no place to be dropped.
  if (edge.oneWay) continue;
  // Cumulative length along the centreline, so a candidate can be placed at a
  // distance rather than at a vertex — vertices bunch up on the bends.
  const pts = edge.p;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const length = cum[cum.length - 1];
  if (length < JUNCTION_CLEAR * 2 + PITCH) continue;

  /** Centreline point and forward heading at `t` metres from the edge's start. */
  const at = (t) => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < t) i++;
    const span = cum[i] - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (t - cum[i - 1]) / span));
    const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f;
    const z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
    // Forward is (-sin h, -cos h): the same convention the cars use.
    const heading = Math.atan2(-(pts[i][0] - pts[i - 1][0]), -(pts[i][1] - pts[i - 1][1]));
    return { x, z, heading };
  };

  const offset = laneOffset(edge.w);
  for (let t = JUNCTION_CLEAR; t <= length - JUNCTION_CLEAR; t += PITCH) {
    // Both directions of travel: each is a lane, on its own side.
    for (const sense of [1, -1]) {
      const c = at(t);
      const heading = sense > 0 ? c.heading : c.heading + Math.PI;
      // Right of forward (-sin h, -cos h) is (cos h, -sin h).
      const side = DRIVE_ON_RIGHT ? 1 : -1;
      const x = c.x + Math.cos(heading) * side * offset;
      const z = c.z - Math.sin(heading) * side * offset;
      sampled++;

      if (!clearOfRails(x, z)) { rejectedRail++; continue; }
      if (!corridorClear(x, z, heading)) { rejectedRun++; continue; }
      if (runAhead(x, z, heading, CLEAR_AHEAD) < CLEAR_AHEAD) { rejectedRun++; continue; }
      if (runAhead(x, z, heading + Math.PI, CLEAR_BEHIND) < CLEAR_BEHIND) { rejectedRun++; continue; }

      const relief = footprintRelief(x, z, heading);
      if (relief > MAX_FOOTPRINT_RELIEF) { rejectedRelief++; continue; }

      const y = groundHeight(x, z);
      if (y === null) { rejectedHeight++; continue; }
      candidates.push({ position: [x, y + 0.6, z], heading, relief, width: edge.w });
    }
  }
}
console.log(`${sampled.toLocaleString()} lane points -> ${candidates.length.toLocaleString()} drivable candidates`
  + ` (rejected: ${rejectedRail} near rails, ${rejectedRun} no run, ${rejectedRelief} not flat, ${rejectedHeight} no height)`);

if (!candidates.length) {
  console.error('no drivable spawn found. Relax CORRIDOR / CLEAR_AHEAD / MAX_FOOTPRINT_RELIEF.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Spread them out: shuffled, then accepted greedily on separation.
// ---------------------------------------------------------------------------
const shuffled = [...candidates];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}

const chosen = [];
for (const c of shuffled) {
  if (chosen.length >= WANT) break;
  const far = chosen.every(({ position: p }) =>
    Math.hypot(p[0] - c.position[0], p[2] - c.position[2]) >= MIN_SEPARATION);
  if (far) chosen.push(c);
}
// North to south, so the printed list and the `?spawn=` indices read in an
// order a human can find on the map.
chosen.sort((a, b) => a.position[2] - b.position[2]);

// The whole point of this rewrite, asserted rather than assumed: every spawn
// is on the street network. A candidate is built ON a lane, so a failure here
// means the geometry above has drifted from `roadGraph.ts`.
const distanceToGraph = (x, z) => {
  let best = Infinity;
  for (const edge of graph.edges) {
    for (let i = 0; i < edge.p.length - 1; i++) {
      const d2 = distanceToSegment2(x, z, [edge.p[i], edge.p[i + 1]]);
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
};
const strays = chosen
  .map((c) => ({ c, d: distanceToGraph(c.position[0], c.position[2]) }))
  .filter(({ d }) => d > LANE_MAX + 1);
if (strays.length) {
  console.error(`${strays.length} spawn(s) are not on the road graph:`);
  for (const { c, d } of strays) console.error(`  (${c.position[0].toFixed(0)}, ${c.position[2].toFixed(0)}) is ${d.toFixed(1)} m from the nearest street`);
  process.exit(1);
}

writeFileSync(OUT, `${JSON.stringify({
  seed,
  minSeparationMetres: MIN_SEPARATION,
  corridorHalfWidthMetres: CORRIDOR,
  clearAheadMetres: CLEAR_AHEAD,
  railClearanceMetres: RAIL_CLEARANCE,
  /** One per spawn, in travel order of nothing — sorted north to south. */
  points: chosen.map((c) => ({
    position: c.position.map((v) => +v.toFixed(2)),
    heading: +c.heading.toFixed(4),
    footprintReliefMetres: +c.relief.toFixed(3),
    streetWidthMetres: c.width,
  })),
}, null, 2)}\n`);

console.log('\n--- city spawns ---');
console.log(`  seed ${seed} · ${chosen.length} kept of ${candidates.length.toLocaleString()} `
  + `candidates, at least ${MIN_SEPARATION} m apart`);
chosen.forEach((c, i) => {
  const [x, y, z] = c.position;
  console.log(`  ${String(i).padStart(2)}  (${x.toFixed(0).padStart(6)}, ${z.toFixed(0).padStart(6)})  `
    + `y ${y.toFixed(2).padStart(6)}  heading ${((c.heading * 180) / Math.PI).toFixed(0).padStart(4)}°  `
    + `relief ${c.relief.toFixed(2)} m  on a ${c.width} m street, `
    + `${distanceToGraph(x, z).toFixed(1)} m off its centreline`);
});
console.log(`  wrote ${OUT}\n`);
