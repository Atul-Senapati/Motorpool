import { RAIL_ROADS, branchViews, type Road } from './pointwork';
import { STATION, STATION_SITE, stationPoint } from './stationConfig';
import { STATION as HALCYON, stationPlatforms } from './islandRailConfig';
import { RAIL_STATIONS, groundWorld, railAt, toWorld as countryWorld } from './countryConfig';
import { SITE as AIRPORT } from './airportConfig';
import { trainWrap } from './trainConfig';

/**
 * The stations you can board the train at — and get off at — by driving into
 * the circle on the forecourt (`StationBoarding`). The user's rule: **a train
 * ride starts at a station, standing at the platform, and nowhere else.**
 *
 *  - **Kestrel** (Kestrel island), on the main line: the ride starts on a
 *    running line, as it always has (`TrainRide.startingArc`).
 *  - **Halcyon Junction** (the airport island's line) and **Skylark** (the
 *    country line) are on the branch loop, which the pointwork models as roads
 *    of their own (`RAIL_ROADS`, `BRANCH UP`). A ride starting there is put on
 *    that road, the lead cab near the far end of the platform so the whole
 *    rake stands alongside it. Where on the road is measured, not written
 *    down: the road's own `place` is walked for the point nearest the
 *    platform's middle.
 *
 * `circle` is the boarding circle, world XZ, and `ground` its height;
 * `platform` the platform's middle and `half` half its length, for "stopped at
 * the station".
 */
export type TrainStationId = 'kestrel' | 'halcyon' | 'skylark';

export interface TrainStation {
  id: TrainStationId;
  name: string;
  circle: [number, number];
  ground: number;
  platform: [number, number];
  half: number;
}

const island = (x: number, z: number): [number, number] => {
  const c = Math.cos(AIRPORT.heading);
  const s = Math.sin(AIRPORT.heading);
  return [AIRPORT.centre[0] + x * c + z * s, AIRPORT.centre[1] - x * s + z * c];
};

export const TRAIN_STATIONS: readonly TrainStation[] = (() => {
  const out: TrainStation[] = [];
  if (STATION_SITE) {
    const [cx, , cz] = stationPoint(0.5, -57.3);
    out.push({
      id: 'kestrel', name: 'Kestrel', circle: [cx, cz], ground: STATION_SITE.ground,
      platform: [STATION_SITE.centre[0], STATION_SITE.centre[2]], half: STATION.platformLength / 2,
    });
  }
  // Halcyon Junction: the middle of the island platform (PF2 / PF3), and the
  // forecourt in front of the building's doors, in the island's frame.
  const plats = stationPlatforms();
  const mid = (label: string) => {
    const p = plats.find((q) => q.label === label);
    const m = p?.line[Math.floor(p.line.length / 2)];
    return m ? island(m.x, m.z) : null;
  };
  const pf2 = mid('PF2');
  const pf3 = mid('PF3');
  if (pf2 && pf3) {
    out.push({
      id: 'halcyon', name: 'Halcyon Junction', circle: island(-42, 291.8), ground: AIRPORT.ground,
      platform: [(pf2[0] + pf3[0]) / 2, (pf2[1] + pf3[1]) / 2], half: HALCYON.platform.length / 2,
    });
  }
  // Skylark: on the grass behind the platform, which is on the line's left.
  const sk = RAIL_STATIONS.find((s) => s.name === 'Skylark');
  if (sk) {
    const at = railAt((sk.from + sk.to) / 2);
    const [px, pz] = countryWorld(at.x, at.z);
    const side = sk.building || 1;
    const circle: [number, number] = [px + at.tz * 24 * side, pz - at.tx * 24 * side];
    out.push({
      id: 'skylark', name: 'Skylark', circle, ground: groundWorld(circle[0], circle[1]),
      platform: [px, pz], half: (sk.to - sk.from) / 2,
    });
  }
  return out;
})();

/** Which station the next ride starts from. Set by boarding, read once by `TrainRide`. */
let requested: TrainStationId = 'kestrel';
export function requestTrainStart(id: TrainStationId) {
  requested = id;
}
export const requestedTrainStart = (): TrainStationId => requested;

/**
 * Where a ride from a branch station starts: the road, and the lead cab's arc.
 * Null for Kestrel, whose start is the main line's (`TrainRide.startingArc`).
 */
export function branchStart(id: TrainStationId): { road: number; arc: number; facing: 1 | -1 } | null {
  const station = TRAIN_STATIONS.find((s) => s.id === id);
  if (!station || id === 'kestrel') return null;
  // The loop is counted two ways (`branchViews`) and each station is on only
  // one of them. Whichever it is, the train faces that view's own toe —
  // down the arc on a Skylark view, up it on an airport view — which is the
  // view `routeHandover` keeps it on, so it is not moved on its first step.
  const views = branchViews();
  const facingOf = (road: number): 1 | -1 | 0 => (views.some((v) => v.airport === road) ? 1
    : views.some((v) => v.skylark === road) ? -1 : 0);
  let best: { road: Road; s: number; d: number } | null = null;
  for (const road of RAIL_ROADS) {
    if (road.name !== 'BRANCH UP' || !road.place || !facingOf(road.id)) continue;
    for (let s = 0; s <= road.length; s += 2) {
      // `place` takes an ARC, and counts along the road itself (`roadS`).
      const p = road.place(trainWrap(road.from + s));
      const d = Math.hypot(p.x - station.platform[0], p.z - station.platform[1]);
      if (!best || d < best.d) best = { road, s, d };
    }
  }
  if (!best || best.d > 25) return null;
  const facing = facingOf(best.road.id) as 1 | -1;
  // The lead cab near the platform's far end, in the direction it faces.
  const lead = Math.max(0, Math.min(best.road.length, best.s + facing * (station.half - 12)));
  return { road: best.road.id, arc: trainWrap(best.road.from + lead), facing };
}

/** The station whose platform the train's lead is alongside, if any — for getting off. */
export function stationAlongside(x: number, z: number): TrainStation | null {
  for (const s of TRAIN_STATIONS) {
    if (Math.hypot(x - s.platform[0], z - s.platform[1]) < s.half + 25) return s;
  }
  return null;
}

