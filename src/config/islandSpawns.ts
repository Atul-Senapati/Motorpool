import { ROAD_NODES, ROAD_PAVEMENT, ROAD_RUNS, ROAD_TOP, ROAD_WIDTH } from './roadConfig';
import { AIRPORT_ENABLED, SITE as AIRPORT } from './airportConfig';
import { KESTREL_NODES, KESTREL_ROADS_ENABLED, KESTREL_RUNS } from './kestrelRoads';
import { STATION_SITE, stationPoint } from './stationConfig';
import {
  COUNTRY_ENABLED, JUNCTIONS as COUNTRY_JUNCTIONS, LANES, LANE_STEP, inRailCut, toWorld as countryWorld,
} from './countryConfig';
import { TRAFFIC } from './trafficConfig';

/**
 * Places to start a drive on the islands' roads.
 *
 * The city's spawns are surveyed off its nav raster (`spawnPoints.json`), and
 * the islands are not on that raster, so a drive only ever began in the city —
 * or, one time in thirteen, at Skylark's bridge. These are the islands' own:
 * picked from the same road definitions the islands are BUILT from, so a spawn
 * is on a road by construction, facing along it, in the driving-side lane.
 *
 *  - **Kestrel**: the middle of each kit run long enough to start on
 *    (`KESTREL_RUNS`). Runs stop at junction tiles, so a middle is never in a
 *    junction; the stubs either side of the level crossing are too short to
 *    qualify, which keeps spawns off the rails.
 *  - **Halcyon** (the airport island): the middles of its road runs
 *    (`ROAD_RUNS`), in the island's turned frame.
 *  - **Skylark**: along its lanes, clear of junctions and of the level
 *    crossings' panels (`inRailCut`), at the lane's own surface height.
 *
 * Each island's set is thinned to points at least `SPREAD` apart, so a big
 * grid does not crowd out a small one, and the per-island cap keeps the
 * city — which is most of the map — from becoming the rare start.
 *
 * Heights are the road's surface plus the same 0.6 m drop the city spawns use.
 */
export interface IslandSpawn {
  position: [number, number, number];
  heading: number;
  island: 'kestrel' | 'halcyon' | 'skylark';
}

/** Shortest run worth starting on: a car length either side and some road ahead. */
const MIN_RUN = 40;
/** Minimum distance between two spawns on the same island. */
const SPREAD = 110;
const DROP = 0.6;
/** How far right of the centreline the driving-side lane is. */
const LANE = (ROAD_WIDTH * (1 - 2 * ROAD_PAVEMENT)) / 4;

/** World heading for travel along (dx, dz) — the convention `roadGraph` uses. */
const headingOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** A point on a road, moved into the driving-side lane for travel along (dx, dz). */
function inLane(x: number, z: number, dx: number, dz: number, lane = LANE): [number, number] {
  const len = Math.hypot(dx, dz) || 1;
  // Right of travel is (−dz, dx) in this world (forward −Z, right +X).
  const side = TRAFFIC.driveOnRight ? 1 : -1;
  return [x + (-dz / len) * lane * side, z + (dx / len) * lane * side];
}

/** Greedy thinning, deterministic: keeps the first of any two closer than `SPREAD`. */
function thin(points: IslandSpawn[], max: number): IslandSpawn[] {
  const out: IslandSpawn[] = [];
  for (const p of points) {
    if (out.length >= max) break;
    if (out.every((q) => Math.hypot(q.position[0] - p.position[0], q.position[2] - p.position[2]) >= SPREAD)) out.push(p);
  }
  return out;
}

/** Alternate directions down a list, so not every start faces the same way. */
const flip = (i: number) => (i % 2 === 0 ? 1 : -1);

function kestrel(): IslandSpawn[] {
  if (!KESTREL_ROADS_ENABLED || !STATION_SITE) return [];
  const out: IslandSpawn[] = [];
  const runs = [...KESTREL_RUNS].sort((a, b) => (
    Math.hypot(b.to[0] - b.from[0], b.to[1] - b.from[1]) - Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1])
  ));
  runs.forEach((run, i) => {
    // Kestrel runs are (across, along).
    const [fa, fl] = run.from;
    const [ta, tl] = run.to;
    if (Math.hypot(ta - fa, tl - fl) < MIN_RUN) return;
    // Not across a junction tile either: a run whose middle is near a node is one
    // that a tile was dropped onto later.
    const ma = (fa + ta) / 2;
    const ml = (fl + tl) / 2;
    if (KESTREL_NODES.some((n) => Math.hypot(n.across - ma, n.along - ml) < ROAD_WIDTH)) return;
    const [x0, , z0] = stationPoint(fl, fa);
    const [x1, , z1] = stationPoint(tl, ta);
    const [mx, my, mz] = stationPoint(ml, ma);
    const s = flip(i);
    const dx = (x1 - x0) * s;
    const dz = (z1 - z0) * s;
    const [x, z] = inLane(mx, mz, dx, dz);
    out.push({ position: [x, my + ROAD_TOP + DROP, z], heading: headingOf(dx, dz), island: 'kestrel' });
  });
  return thin(out, 6);
}

function halcyon(): IslandSpawn[] {
  if (!AIRPORT_ENABLED) return [];
  const c = Math.cos(AIRPORT.heading);
  const sn = Math.sin(AIRPORT.heading);
  const world = (x: number, z: number): [number, number] => [
    AIRPORT.centre[0] + x * c + z * sn, AIRPORT.centre[1] - x * sn + z * c,
  ];
  const out: IslandSpawn[] = [];
  ROAD_RUNS.forEach((run, i) => {
    const [fx, fz] = run.from;
    const [tx, tz] = run.to;
    if (Math.hypot(tx - fx, tz - fz) < MIN_RUN) return;
    const mxl = (fx + tx) / 2;
    const mzl = (fz + tz) / 2;
    if (ROAD_NODES.some((n) => Math.hypot(n.x - mxl, n.z - mzl) < ROAD_WIDTH)) return;
    const [x0, z0] = world(fx, fz);
    const [x1, z1] = world(tx, tz);
    const [mx, mz] = world(mxl, mzl);
    const s = flip(i);
    const dx = (x1 - x0) * s;
    const dz = (z1 - z0) * s;
    const [x, z] = inLane(mx, mz, dx, dz);
    out.push({ position: [x, AIRPORT.ground + ROAD_TOP + DROP, z], heading: headingOf(dx, dz), island: 'halcyon' });
  });
  return thin(out, 4);
}

function skylark(): IslandSpawn[] {
  if (!COUNTRY_ENABLED) return [];
  const junctions = Object.values(COUNTRY_JUNCTIONS);
  const out: IslandSpawn[] = [];
  LANES.forEach((road, i) => {
    // Every 70 m along, clear of the ends, the junctions and the rails.
    for (let s = 30; s < road.length - 30; s += 70) {
      const k = Math.round(s / LANE_STEP);
      const p = road.samples[Math.max(0, Math.min(road.samples.length - 1, k))];
      if (inRailCut(road.name, p.arc) || inRailCut(road.name, p.arc + 12) || inRailCut(road.name, p.arc - 12)) continue;
      if (junctions.some((j) => Math.hypot(j.x - p.x, j.z - p.z) < 25)) continue;
      const d = flip(i);
      const dx = p.tx * d;
      const dz = p.tz * d;
      const [lx, lz] = inLane(p.x, p.z, dx, dz);
      const [x, z] = countryWorld(lx, lz);
      out.push({ position: [x, p.y + ROAD_TOP + DROP, z], heading: headingOf(dx, dz), island: 'skylark' });
    }
  });
  return thin(out, 5);
}

export const ISLAND_SPAWNS: readonly IslandSpawn[] = [...kestrel(), ...halcyon(), ...skylark()];
