import {
  AIRPORT_JUNCTION, JUNCTION, ahead, pointsAhead, roadOf, type PointsAhead, type Road,
} from '@/config/pointwork';
import { trainNormalAt, trainPointAt, trainWrap } from '@/config/trainConfig';
import { TRAIN_STATIONS } from '@/config/trainStations';
import { STATION_SITE, stationPoint } from '@/config/stationConfig';
import { CROSSING as TOWN_CROSSING } from '@/config/townConfig';
import { KESTREL_WEST_CROSSING } from '@/config/kestrelRoads';
import { BRIDGE, BRIDGE_DIR, RAIL_CROSSINGS, TRUNK_ROAD_CROSSING, airportWorld, toWorld } from '@/config/countryConfig';
import { HARBOUR_CROSSING } from '@/config/harbourConfig';
import { trainsOnTrack } from './trainRegistry';

/**
 * The road choice at the next set of points, for the driver.
 *
 * The player picks a road with A or D — the left-hand road or the right-hand
 * one — and the HUD shows both as destinations with what each leads to: its
 * speed, the next station on it, and whether there is a train on it. This
 * module works those out; `TrainRide` writes `liveRouteChoice` every frame and
 * the HUD's `RouteChoice` reads it.
 */

/** How far out the choice is shown, metres. */
export const ROUTE_WINDOW = 1600;
/**
 * Inside this the route is locked and A / D are refused, metres: only once the
 * engine is right on the points. Up to then the driver can change their mind.
 */
export const ROUTE_LOCK = 15;
/** How far down each road the next station and trains are looked for, metres. */
const LOOK = 6000;
const STEP = 25;
/** How far past the blades the hand is read, metres. */
const HAND_PROBE = 60;

export interface RoadInfo {
  name: string;
  /** Speed the road is signed for, km/h; 0 when it runs at line speed. */
  kph: number;
  /** The next station down this road, metres from the train, or null. */
  station: { name: string; m: number } | null;
  /** Metres from the train to the nearest train on this road; -1 clear; null when not known. */
  trainM: number | null;
}

export const liveRouteChoice = {
  /** A set of points is inside `ROUTE_WINDOW`. */
  active: false,
  /** The turnout's arc, so the HUD can tell one junction from the next. */
  arc: 0,
  /** Metres to the blades. */
  d: 0,
  /** Which way the diverging road goes: -1 left, +1 right, 0 a join. */
  hand: 0 as -1 | 0 | 1,
  /** The current road ends here; there is no choice. */
  forced: false,
  /** The train will take the diverging road. */
  diverge: false,
  straight: null as RoadInfo | null,
  branch: null as RoadInfo | null,
  /** Counts refused presses (too late), so the HUD can shake on each one. */
  refused: 0,
};

/** The route name the driver is given, which is not always the road's own name. */
export function routeName(road: Road, from: Road, turnoutArc: number): string {
  // Off the running line onto the branch: say where it goes. Both branch roads
  // are called BRANCH; the junction they leave from tells Skylark from Halcyon.
  if (road.name.startsWith('BRANCH') && from.through) {
    const [x, , z] = trainPointAt(trainWrap(turnoutArc));
    const near = (at: readonly [number, number]) => Math.hypot(at[0] - x, at[1] - z);
    return (near(JUNCTION.at) < near(AIRPORT_JUNCTION.at) ? JUNCTION : AIRPORT_JUNCTION).name.toUpperCase();
  }
  if (road.through && from.place) return 'MAIN LINE';
  return road.name;
}

/** Plan position of `road` at arc `a`. */
function placeOn(road: Road, a: number): [number, number] {
  if (road.place) {
    const p = road.place(a);
    return [p.x, p.z];
  }
  const s = trainWrap(a);
  const [x, , z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  const off = road.offset(s);
  return [x + nx * off, z + nz * off];
}

/**
 * Which way `to` leaves `from` at a turnout, from the driver's seat, in plan.
 * Needed where `PointsAhead.hand` cannot say: a road with a `place` of its own
 * (the branch) is not an offset from anything, so its offset hand reads 0.
 */
export function handFrom(from: Road, to: Road, turnoutArc: number, way: 1 | -1): -1 | 0 | 1 {
  const [x0, z0] = placeOn(from, turnoutArc);
  const beyond = trainWrap(turnoutArc + way * HAND_PROBE);
  const [x1, z1] = placeOn(from, beyond);
  const [x2, z2] = placeOn(to, beyond);
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  // Left of travel is (tz, -tx) — `trainNormalAt`'s convention.
  const left = ((x2 - x1) * (z1 - z0) - (z2 - z1) * (x1 - x0)) / len;
  return Math.abs(left) < 0.5 ? 0 : left > 0 ? -1 : 1;
}

interface RoadPlan {
  name: string;
  station: { name: string; m: number } | null;
  /** The running line this road joins or is, with metres to where it is on it; null off them. */
  track: { id: 0 | 1; from: number; arc: number } | null;
}

const plans = new Map<string, RoadPlan>();

/**
 * Where a road leads from `arc`, travelling `way`: walked along the road and on
 * through any points the road forces (a crossover's far end), never through a
 * choice. Cached per road and junction — the answer does not change.
 */
function planRoad(roadId: number, from: Road, turnoutArc: number, way: 1 | -1): RoadPlan {
  const key = `${roadId}|${Math.round(turnoutArc)}|${way}|${from.id}`;
  const cached = plans.get(key);
  if (cached) return cached;
  let road = roadOf(roadId);
  let name = routeName(road, from, turnoutArc);
  // A connecting road is a way onto somewhere else: name the somewhere else.
  let at = turnoutArc;
  let base = 0;
  let next: PointsAhead | null = pointsAhead(road.id, at, way);
  let station: RoadPlan['station'] = null;
  let track: RoadPlan['track'] = null;
  let renamed = false;
  for (let d = STEP; d <= LOOK; d += STEP) {
    // On through anything the road forces.
    while (next && base + next.distance <= d) {
      if (!next.compulsory) { at = next.turnout.arc; base += next.distance; next = pointsAhead(road.id, at, way); continue; }
      const onto = roadOf(next.other);
      if (!renamed && !road.through && !road.place) { name = routeName(onto, from, next.turnout.arc); renamed = true; }
      road = onto;
      at = next.turnout.arc;
      base += next.distance;
      next = pointsAhead(road.id, at, way);
    }
    const a = trainWrap(turnoutArc + way * d);
    if (!track && road.through && (road.id === 0 || road.id === 1)) track = { id: road.id as 0 | 1, from: d, arc: a };
    if (!station) {
      const [x, z] = placeOn(road, a);
      const s = TRAIN_STATIONS.find((t) => Math.hypot(x - t.platform[0], z - t.platform[1]) < t.half);
      if (s) station = { name: s.name.toUpperCase(), m: d };
    }
    if (station && track) break;
  }
  const plan = { name, station, track };
  plans.set(key, plan);
  return plan;
}

/** Metres from `arc` along `way` to the nearest other train on running line `track`, -1 clear. */
function trainOn(track: 0 | 1, arc: number, way: 1 | -1): number {
  let best = -1;
  for (const t of trainsOnTrack(track)) {
    if (t.id.startsWith('player')) continue;
    const nose = ahead(arc, t.arc) * way;
    const tail = ahead(arc, t.arc - t.direction * t.length) * way;
    const near = Math.min(nose, tail);
    const far = Math.max(nose, tail);
    if (far <= 0 || near > LOOK) continue;
    const gap = Math.max(0, near);
    if (best < 0 || gap < best) best = gap;
  }
  return best;
}

function info(plan: RoadPlan, kph: number, d: number, way: 1 | -1): RoadInfo {
  // A train on a road is in the way whichever way it runs, so it is looked for
  // down the road from where the route joins it.
  let trainM: number | null = null;
  if (plan.track) {
    const gap = trainOn(plan.track.id, plan.track.arc, way);
    trainM = gap < 0 ? -1 : d + plan.track.from + gap;
  }
  return {
    name: plan.name,
    kph,
    station: plan.station ? { name: plan.station.name, m: d + plan.station.m } : null,
    trainM,
  };
}

/**
 * Re-reads the choice at `next` into `liveRouteChoice`. `road` is the road the
 * leading end is on, `way` the direction of travel in arc, `armed` the standing
 * call for the diverging road, `top` the train's top speed in m/s.
 */
export function sampleRouteChoice(
  road: number, next: PointsAhead | null, way: 1 | -1, armed: boolean, top: number,
): void {
  const out = liveRouteChoice;
  if (!next || next.distance > ROUTE_WINDOW) {
    out.active = false;
    return;
  }
  const here = roadOf(road);
  const other = roadOf(next.other);
  out.active = true;
  out.arc = next.turnout.arc;
  out.d = next.distance;
  out.hand = next.hand === 0 && (other.place || here.place)
    ? handFrom(here, other, next.turnout.arc, way)
    : next.hand;
  out.forced = next.compulsory;
  out.diverge = armed || next.compulsory;
  const branchKph = Number.isFinite(other.limit) ? other.limit * 3.6
    : other.limitAt ? other.limitAt(trainWrap(next.turnout.arc + way * HAND_PROBE)) * 3.6 : Infinity;
  const straight = planRoad(here.id, here, next.turnout.arc, way);
  const branch = planRoad(other.id, here, next.turnout.arc, way);
  out.straight = info(straight, 0, next.distance, way);
  out.branch = info(branch, branchKph < top * 3.6 - 3 ? Math.round(branchKph) : 0, next.distance, way);
}

/**
 * What A or D asks for at these points: the left-hand road is the diverging one
 * when it turns left, otherwise the straight one. Returns the call (`armed`)
 * that picks it.
 */
export function armedFor(side: -1 | 1, hand: -1 | 0 | 1): boolean {
  const leftIsBranch = hand < 0;
  return side < 0 ? leftIsBranch : !leftIsBranch;
}

/* ------------------------------------------------------------ level crossings */

/** How far ahead a level crossing is called, metres. */
export const CROSSING_NOTICE = 600;

let crossings: [number, number][] | null = null;
/**
 * Every level crossing the player's train can reach, in world XZ: Kestrel's
 * two (station frame), the Skylark line's (island frame), the harbour's on the
 * trunk (airport frame) and the trunk's crossing of the Skylark road. Built on
 * first use, after every config module has settled.
 */
function levelCrossings(): [number, number][] {
  if (crossings) return crossings;
  const out: [number, number][] = [];
  if (STATION_SITE) {
    const [ex, , ez] = stationPoint(TOWN_CROSSING.along, 0);
    out.push([ex, ez]);
    if (KESTREL_WEST_CROSSING) {
      const [wx, , wz] = trainPointAt(trainWrap(STATION_SITE.arc + KESTREL_WEST_CROSSING.along));
      out.push([wx, wz]);
    }
  }
  for (const c of RAIL_CROSSINGS) out.push(toWorld(c.x, c.z));
  out.push(airportWorld(HARBOUR_CROSSING.x, HARBOUR_CROSSING.z));
  out.push([BRIDGE.start[0] + BRIDGE_DIR[0] * TRUNK_ROAD_CROSSING.s, BRIDGE.start[1] + BRIDGE_DIR[1] * TRUNK_ROAD_CROSSING.s]);
  crossings = out;
  return out;
}

/** Within this of a crossing's centre, a point on the line is on the crossing, metres. */
const ON_CROSSING = 14;
const CROSSING_STEP = 10;

/**
 * Metres to the next level crossing along the line ahead, -1 for none inside
 * `CROSSING_NOTICE`. `placeAt(d)` is where the line is `d` metres ahead.
 */
export function crossingAhead(placeAt: (d: number) => [number, number]): number {
  const list = levelCrossings();
  for (let d = 0; d <= CROSSING_NOTICE; d += CROSSING_STEP) {
    const [x, z] = placeAt(d);
    for (const [cx, cz] of list) {
      if (Math.abs(x - cx) < ON_CROSSING && Math.abs(z - cz) < ON_CROSSING
        && Math.hypot(x - cx, z - cz) < ON_CROSSING) return d;
    }
  }
  return -1;
}
