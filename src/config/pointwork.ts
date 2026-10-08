/**
 * Pointwork: the roads the train can run on, and where it can change between
 * them.
 *
 * ## A road is an offset, and a turnout is where two of them agree
 *
 * Everything about the railway is already parametrised by one number — arc
 * length along the running line — and the second track is drawn by *offsetting*
 * a section sideways from it (`secondTrackGap`, `roadOffset`). So a road here is
 * not a curve in world space. It is a function that says how far left of the
 * running line it sits at a given arc, plus the stretch of arc it exists over.
 *
 * That representation makes a turnout almost free. Two roads whose offsets are
 * *equal* at some arc are, geometrically, the same piece of track there — so
 * changing road at that arc moves the train sideways by nothing at all, and the
 * change needs no blending, no progress tracking and no separate curve. The
 * whole switching mechanism is therefore: pick a different offset function at
 * an arc where the two agree.
 *
 * This is why the geometry had to come first. The station's extra roads ease
 * onto the down line and then *become* it (see `STATION.loopLead`); a crossover
 * is a road whose offset runs from zero to the full track gap over 84 m, which
 * makes it equal to the up line at one end and the down line at the other. In
 * both cases the turnout is not built, it is a consequence.
 *
 * The pay-off is that a 147 m rake follows the drawn rails exactly. Each unit
 * asks which road *its own* arc is on and gets that road's offset, so while the
 * train is crossing over, the locomotive is on one track, the rear engine is
 * still on the other, and the coaches between them are strung along the
 * diagonal — which is what a train crossing over looks like. A single shared
 * lateral offset, eased over time, would have slid the whole rake sideways
 * through the ballast.
 *
 * ## Where the pointwork is
 *
 * Not stated: measured, like everything else on this line. Crossovers go on the
 * straightest stretches that are clear of every platform, spread round the loop
 * — and they can go almost anywhere, because a crossover lives *between* two
 * tracks that already exist, so it fits on the viaduct deck and inside the bore
 * as readily as on ballast. The loop lines are the station's own roads, for the
 * opposite reason: a third track needs ground beside the railway, and on this
 * route — 62% viaduct, 20% tunnel — the island crossing the station already
 * occupies is very nearly the only place that has any.
 */
import {
  TRAIN, TRAIN_LENGTH, TRAIN_POINTS, trainNormalAt, trainPointAt, trainSpeedLimitAt, trainTangentAt,
  trainWrap,
} from './trainConfig';
import {
  RAIL as SKYLARK_RAIL, RAIL_MARKS as SKYLARK_MARKS, TRUNK_CLIMB, airportWorld, toWorld as skylarkToWorld,
} from './countryConfig';
import { SIDINGS, SITE as AIRPORT_SITE, sidingCentre } from './airportConfig';
import {
  BALLAST as ISLAND_BALLAST, LINK_MAIN, LOOP_SIDE, RAILHEAD, THROUGH_MAIN, YARD_SIDE,
  connectionSamples, crossoverSamples, downLinkSamples, pf1Spur, stationLoop, trunkCentre,
} from './islandRailConfig';
import {
  METRO, METRO_SITE, ROADS, STATION_SITE, UNDERGROUND, UNDERGROUND_SITE,
  roadLead, roadOffset, secondTrackGap, upLoopLead, upLoopOffset,
} from './stationConfig';

/** The two through roads. Every other road is reached from one of these. */
export const UP = 0;
export const DOWN = 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Signed distance from `from` to `to` round the loop, shortest way. */
export function ahead(from: number, to: number): number {
  let d = ((to - from) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  if (d > TRAIN_LENGTH / 2) d -= TRAIN_LENGTH;
  return d;
}

export interface Road {
  id: number;
  /** What the HUD calls it. */
  name: string;
  /**
   * Where the road begins and how far it runs, in arc length. A through road
   * covers the whole loop; a crossover or a loop line does not exist outside
   * its own stretch, which is what makes its end turnouts compulsory.
   */
  from: number;
  length: number;
  through: boolean;
  /**
   * Speed over this road, m/s. `Infinity` on a running line — the line's own
   * restrictions already cover those (`trainSpeedLimitAt`); a connecting track
   * is what needs signing, and a 56 m throat crossover needs signing harder
   * than an 84 m one out on the plain.
   */
  limit: number;
  /** Metres left of the running line at arc `s`. */
  offset: (s: number) => number;
  /**
   * Metres above the running line's rail head at arc `s`, for a road with a
   * profile of its own. Undefined — level with the running line — everywhere
   * but the junction's branch.
   */
  rise?: (s: number) => number;
  /**
   * Where the road is at arc `s`, for a road that goes somewhere the running
   * line's offset cannot describe — the junction's branch, which runs on to
   * Skylark and the airport trunk. `s` then counts metres ALONG THE ROAD from
   * its `from` (see `roadS`), not along the running line.
   */
  place?: (s: number) => RailPlace;
  /** The road's own line speed at arc `s`, m/s, where it has one. */
  limitAt?: (s: number) => number;
  /**
   * A dead end: which end of the road has a buffer stop, as the direction of
   * travel that reaches it (+1 the `from + length` end, -1 the `from` end).
   * Undefined for every road that joins something at both ends.
   */
  buffer?: 1 | -1;
  /**
   * Out on the branch loop, clear of the running line: `offset` is then
   * metres left of the loop's inner road (its own up road), not of the
   * running line, and the road is none of the running line's business.
   */
  onLoop?: (s: number) => boolean;
  /** Metres along the loop from the Skylark toe (`BRANCH_ROUTE`), for a road on or off it. */
  routeB?: (s: number) => number;
  /** A road off the loop's two mains — a station loop, a yard road — rather than one of them. */
  sub?: boolean;
}

/**
 * Two roads that can be crossed between at one arc.
 *
 * Undeclared coincidences are not turnouts. A scissors crossover's two
 * diagonals cross at their midpoint and their offsets are equal there, but a
 * diamond crossing is a place where two routes intersect, not a place a train
 * may change route — so the connections are listed rather than derived from the
 * offsets agreeing.
 */
export interface Turnout {
  arc: number;
  a: number;
  b: number;
}

export const CROSSOVER = {
  /**
   * How far the connecting track takes to cross from one line to the other.
   *
   * 84 m for the 4.6 m gap is an equivalent radius of about 380 m, which is a
   * plausible high-speed crossover and, more to the point, is slack enough that
   * the swept rails do not visibly kink where they meet the line at each end.
   */
  lead: 84,
  /** How many places round the loop, and the least distance between them. */
  count: 6,
  spacing: 700,
  /** The sharpest curve one is laid in, as a radius. */
  minRadius: 260,
  /** How far clear of a platform end a crossover has to start. */
  clear: 60,
  /**
   * Speed over the points, m/s. A crossover taken at line speed is a derailment
   * anywhere but in a game; 30 m/s is about 110 km/h, which is what a fast
   * crossover is actually signed for.
   */
  speed: 30,
  /**
   * The throat crossovers: shorter, sharper, slower.
   *
   * Two of these go at each end of the island station, immediately outside the
   * ladder, and they are what make the station a place a route is *chosen*
   * rather than a place a route happens to you. Without them the four roads
   * can only be reached from the down line, and the down line can only be
   * reached from a crossover 300 m out in the country — so arriving on the up
   * line meant running through your own station on the through road.
   *
   * 56 m for the 4.6 m gap is about a 170 m radius: a slow turnout, which is
   * what a station throat has, and what lets three sets of points fit in the
   * 113 m between the crossover and the far platform road. 18 m/s is 65 km/h.
   */
  throatLead: 56,
  throatSpeed: 18,
  /**
   * How far the throat crossover stops short of the ladder's first turnout.
   *
   * Not a clearance so much as a decision gap. Eight metres was the first
   * figure — enough to keep the two sets of points from being laid on top of
   * each other — and it made the layout unusable: a driver who had just been
   * put onto the down line had half a second to call for the loop. Forty gives
   * the eye time to see the next set coming, and it is what a real throat looks
   * like anyway.
   */
  throatClear: 40,
} as const;

/**
 * The switch itself, as against the connecting track beyond it.
 *
 * `foul` is how much of the approach the blades own. Inside it the route is
 * already set — the leading wheels are on or between the switch rails — so the
 * lever is locked (`leverLocked`) instead of silently having no effect. Twelve
 * metres is about the length of the switch rails on a slow turnout, and at the
 * throat's 18 m/s it is two thirds of a second: short enough that the driver
 * never feels robbed of a decision, long enough that the last-instant press
 * that used to do nothing now says why.
 */
export const POINTS = {
  foul: 12,
} as const;

const PROBE = 6;

/**
 * The shape a junction's branch is laid to.
 *
 * `curve` is the Skylark junction's: straight from the running line's own
 * curvature into ONE curve, whose radius is solved so the straight after it
 * lands on the line the branch joins. `run` is for a toe that is a long way
 * from that line but not far ahead of the joint: it eases off the running
 * line's curve onto a straight first, runs out along it, and only then turns —
 * the straight's length and the curve's radius solved together, for the widest
 * curve that still leaves `lead` metres of straight before the joint.
 */
type BranchShape = 'curve' | 'run';

/** What a junction is built from. Everything else about it is solved. */
export interface JunctionSpec {
  /** Where it goes: the direction signs' name for it. */
  name: string;
  /** Where the user stood: the toe is the running-line arc nearest this. */
  at: readonly [number, number];
  /**
   * Which way along the running line the branch leaves: +1 up the arc, −1
   * down it. Either way it leaves on the DOWN line's side, so its inner road is
   * off the up line (across the down line on a diamond) and its outer road is
   * off the down line.
   */
  dir: 1 | -1;
  /** Length of each transition, into the branch's curve and out of it. */
  transition: number;
  /** Half-width of the branch's deck outside each of its two roads. */
  deckHalf: number;
  /** Centres of the branch's two roads, square to them: the main line's gap. */
  gap: number;
  shape: BranchShape;
  /** `run` only: the least straight before the joint, metres. */
  lead: number;
  /**
   * `run` only: the straight run's direction, as a heading (x = sin h,
   * z = cos h), and the radius of the curve that swings the branch onto it off
   * the running line's own. The branch diverges on the outside of the running
   * line's curve, so it swings the other way to the running line.
   */
  runHeading: number;
  divergeRadius: number;
}

/**
 * The branch: a flat junction off the viaduct, 100 m of single line to a buffer
 * stop.
 *
 * Sited where the user stood (`at`) looking along the line with the arc — up
 * the arc is the UP line's direction, and this railway runs on the right, so
 * the train that meets these points facing is on the up line and the branch
 * turns to its LEFT, across the down line. That is a flat junction: the branch
 * leaves the up line on a set of facing points and crosses the down line on a
 * diamond. The diamond is deliberately not a turnout — see `Turnout` — so a
 * down train runs straight over it.
 *
 * The offset is `u² / 2R` from the toe, which leaves the up line tangent (no
 * kink at the blades) and curves away at a constant rate. The line itself curves
 * right here on about 385 m, so against the world the branch is a gentle LEFT
 * curve of ~510 m, and at 100 m it stands 22.7 m clear of the up line: over the
 * down line by 45 m, off the main deck by 67 m, over the highway on its own
 * span and onto the stop in the grass beyond.
 *
 * `speed` is what a dead-end single line is signed for: 30 km/h. `stand` is how
 * far short of the buffer's face the protection brings the leading end to a
 * stand — the train pulls up to the stop, it does not hit it.
 */
export const JUNCTION = {
  name: 'Skylark Island',
  at: [-1545, 779] as const,
  dir: 1 as const,
  /**
   * How far past the toe (running-line metres) the player's train may run on
   * the branch. The track goes on to Skylark, but the train is steered by an
   * offset from the running line, and that only stays true while the branch is
   * still near-parallel to it (cos ≥ 0.8, here about 80 m) — beyond that it
   * would need a hand-over to the branch's own curve. A stop signal marks it.
   */
  length: 80,
  /** Length of each transition, into the branch's curve and out of it — see `JUNCTION_CURVE`. */
  transition: 40,
  /** Signed speed over the junction's points: none — taken at line speed, as asked. */
  speed: Infinity,
  stand: 2,
  /**
   * Half-width of the branch's own deck. Single track, and no wider than it
   * must be: the down line's catenary mast stands at 7.9 m where the branch
   * leaves the main deck, and 2.25 keeps the branch's inner parapet off it.
   */
  deckHalf: 2.25,
  /** Centres of the branch's two roads, square to them: the main line's gap. */
  gap: TRAIN.elevated.trackGap,
  shape: 'curve' as BranchShape,
  lead: 0,
  runHeading: 0,
  divergeRadius: 0,
} as const;

/**
 * The second junction: off the viaduct at the city's shore, and on over the
 * water to the airport island's trunk, whose north end was left open for
 * exactly this.
 *
 * Sited where the user stood, at heading 108 — looking DOWN the arc, where the
 * line swings left round the shore on 143 m. The trunk's open end is 560 m
 * across from the toe but only 255 m on along the trunk's own direction, and a
 * curve covers about as much ground on as it does across, so a single curve
 * cannot do it. The branch leaves on the OUTSIDE of the running line's curve,
 * swings right onto a short straight, and only then turns left onto the
 * trunk's own centreline and meets it end-on: 706 m in all, nearly all of it
 * curve, with a 189 m curve onto the trunk.
 *
 * Same pair, same gap and the same flat layout as the Skylark junction: the
 * outer road off the down line, the inner off the up line and over the down
 * line on a diamond. Down the arc is a down train's direction, so here it is
 * the DOWN line's train that meets the points facing, and the branch is to its
 * right.
 *
 * `deckHalf` is 3.0 here, not 2.25: the main deck's and the trunk viaduct's own
 * (5.3 m either side of the pair's centre), so the branch deck meets the trunk's
 * flush. What forced 2.25 at Skylark was a down-line mast inside the mouth;
 * here the nearest one (arc ≈6453) stands 0.7 m outside the deck's inner edge.
 */
export const AIRPORT_JUNCTION = {
  name: 'Halcyon Field',
  at: [-1776, -890] as const,
  dir: -1 as const,
  transition: 40,
  deckHalf: TRAIN.elevated.deckHalf - TRAIN.elevated.trackGap / 2,
  gap: TRAIN.elevated.trackGap,
  shape: 'run' as BranchShape,
  lead: 20,
  // Almost all curve, as asked: a 1 km swing to the right off the running
  // line's curve, 32 m of straight, and straight into the 189 m curve onto the
  // trunk. Scanned for the shortest line that keeps that curve wide: a
  // straighter start (78°) saves 8 m for a 174 m curve; the first version,
  // 250 m onto a 62 m run at 100°, was 767 m long for a 230 m curve.
  runHeading: (-84 * Math.PI) / 180,
  divergeRadius: 1000,
} as const;

/** The running-line arc nearest a world point, projected onto the segment rather than quantised to the 6 m step. */
function toeNear([jx, jz]: readonly [number, number]): number {
  if (!TRAIN_POINTS.length) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TRAIN_POINTS.length; i++) {
    const p = TRAIN_POINTS[i];
    const q = TRAIN_POINTS[(i + 1) % TRAIN_POINTS.length];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = clamp(((jx - p.x) * dx + (jz - p.z) * dz) / len2, 0, 1);
    const d = Math.hypot(p.x + dx * t - jx, p.z + dz * t - jz);
    if (d < bestD) { bestD = d; best = p.arc + Math.sqrt(len2) * t; }
  }
  return trainWrap(best);
}

/** The toe of the Skylark junction's points: the arc nearest `JUNCTION.at`. */
export const JUNCTION_TOE: number = toeNear(JUNCTION.at);

const CURVE_STEP = 0.5;
const CURVE_REACH = 140;
const TABLE_STEP = 0.25;
/** How far past the toe the branch still counts as beside the running line. */
const BESIDE = 105;

function trainPoint(s: number): [number, number, number] {
  return trainPointAt(trainWrap(s));
}

/** Signed plan curvature of the running line at `s`, + to the left. */
function lineCurvature(s: number): number {
  const [ax, , az] = trainPoint(s - 15);
  const [bx, , bz] = trainPoint(s);
  const [cx, , cz] = trainPoint(s + 15);
  const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
  const la = Math.hypot(bx - ax, bz - az);
  const lb = Math.hypot(cx - bx, cz - bz);
  const lc = Math.hypot(cx - ax, cz - az);
  // Menger curvature. The railway's left normal is (tz, -tx), so a turn to the
  // left is a negative cross product in this frame.
  return (-2 * cross) / (la * lb * lc || 1);
}

/**
 * Where a branch joins another line end-on: the pair's centre there, the
 * formation height, and the direction a train arriving along the branch is
 * travelling as it runs on.
 */
interface Joint { x: number; z: number; y: number; ax: number; az: number }

/** The Skylark line's pier end, in world terms: where the branch joins it end-on. */
const SKYLARK_END = (() => {
  const n = SKYLARK_RAIL.length;
  const e = SKYLARK_RAIL[n - 1];
  const p = SKYLARK_RAIL[Math.max(0, n - 11)];
  const [x, z] = skylarkToWorld(e.x, e.z);
  const [px, pz] = skylarkToWorld(p.x, p.z);
  const l = Math.hypot(x - px, z - pz) || 1;
  // The Skylark line's heading as it runs out to the pier end; the branch
  // arrives travelling the other way.
  return { x, z, y: e.y, dx: (x - px) / l, dz: (z - pz) / l };
})();
const SKYLARK_JOINT: Joint = {
  x: SKYLARK_END.x, z: SKYLARK_END.z, y: SKYLARK_END.y, ax: -SKYLARK_END.dx, az: -SKYLARK_END.dz,
};

const TRUNK_LINE = trunkCentre();
const TRUNK_JOINT = TRUNK_LINE[TRUNK_LINE.length - 1].arc;

/** The trunk's centre at one of its own arcs, in world terms, with its formation height. */
function trunkCentreAt(arc: number): [number, number, number] {
  const line = TRUNK_LINE;
  const a = clamp(arc, 0, TRUNK_JOINT);
  let lo = 0;
  let hi = line.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (line[mid].arc <= a) lo = mid; else hi = mid; }
  const p = line[lo];
  const q = line[hi];
  const t = q.arc > p.arc ? (a - p.arc) / (q.arc - p.arc) : 0;
  const [x, z] = airportWorld(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t);
  return [x, AIRPORT_SITE.ground + TRUNK_CLIMB.riseAt(a), z];
}

/**
 * The airport trunk's open north end, 111 m out over the water off the island's
 * north-east corner: arc 0 of the trunk, and a train arriving there from the
 * branch runs on along the trunk's first segment, the way its own normals are
 * taken (`dress` in `islandRailConfig`).
 */
const TRUNK_END: Joint = (() => {
  const [x, y, z] = trunkCentreAt(0);
  const [bx, , bz] = trunkCentreAt(TRUNK_LINE[1]?.arc ?? 2);
  const l = Math.hypot(bx - x, bz - z) || 1;
  return { x, z, y, ax: (bx - x) / l, az: (bz - z) / l };
})();

interface Shape { radius: number; run: number }

/**
 * Traces a branch's inner road for a given shape: off the running line at the
 * toe with its heading and curvature, into the curve (for `run`, after easing
 * off onto a straight and running out along it), out of the curve onto the
 * joint's line, and along that to the joint. Returns the samples, how far the
 * pair's centreline misses the joint's line (+ one side, − the other) — what
 * the shape is solved to zero — and how much straight there is before the joint.
 */
function traceBranch(
  spec: JunctionSpec, toe: number, joint: Joint, shape: Shape, step: number, record: boolean,
) {
  const d = spec.dir;
  const [x0, , z0] = trainPoint(toe);
  // The toe's heading from a chord either side, not from one polyline
  // segment's direction, so a vertex near the toe does not tilt the whole curve.
  const [ax, , az] = trainPoint(toe - 6 * d);
  const [bx, , bz] = trainPoint(toe + 6 * d);
  let h = Math.atan2(bx - ax, bz - az);
  const target = Math.atan2(joint.ax, joint.az);
  // The running line's curvature the way the branch is going: a left turn up
  // the arc is a right turn down it.
  const k0 = d * lineCurvature(toe);
  const k1 = 1 / shape.radius;
  const T = spec.transition;
  const run = spec.shape === 'run';
  // `run` only: the swing off the running line's curve onto the run. Right,
  // so negative, and eased in from the running line's curvature and out to
  // straight like every other change of curvature here.
  const kr = run ? -1 / spec.divergeRadius : 0;
  // Where the swing starts easing out, where the run starts, and where the
  // curve's own entry transition begins; -1 until they are reached.
  let swingOut = -1;
  let runAt = run ? -1 : 0;
  // The pair's centre from the inner road, along the trace's left normal: the
  // outer road is on the down line's side, which is the trace's left going up
  // the arc and its right going down.
  const half = (d * spec.gap) / 2;
  const points: Array<{ x: number; z: number; h: number }> = [];
  let x = x0;
  let z = z0;
  let exitAt = -1;
  let straightAt = -1;
  let lead = NaN;
  for (let b = 0; b < 6000; b += step) {
    if (record) points.push({ x, z, h });
    // The centreline's distance still to run to the joint, once on the straight.
    if (straightAt >= 0) {
      const cx = x + Math.cos(h) * half;
      const cz = z - Math.sin(h) * half;
      const along = (joint.x - cx) * joint.ax + (joint.z - cz) * joint.az;
      if (Number.isNaN(lead)) lead = along;
      if (along <= 0) break;
    }
    let k = 0;
    const mid = b + step / 2;
    if (runAt < 0) {
      // The swing: from the running line's curvature into `kr`, held until
      // what is left to turn is what easing out turns, then out to straight.
      if (swingOut < 0) {
        k = mid < T ? k0 + (kr - k0) * (mid / T) : kr;
        if (mid >= T && h - spec.runHeading <= (-kr * T) / 2) swingOut = b;
      }
      if (swingOut >= 0) {
        const t = (mid - swingOut) / T;
        if (t >= 1) { runAt = b; h = spec.runHeading; } else k = kr * (1 - t);
      }
    } else if (exitAt < 0) {
      const entry = runAt + (run ? shape.run : 0);
      if (mid >= entry) {
        const t = Math.min(1, (mid - entry) / T);
        k = run ? k1 * t : k0 + (k1 - k0) * t;
        // Start easing out when what is left to turn is what the exit turns.
        if (t >= 1 && target - h <= (k1 * T) / 2) exitAt = b;
      }
    }
    if (exitAt >= 0 && straightAt < 0) {
      const t = (mid - exitAt) / T;
      if (t >= 1) { straightAt = b; h = target; } else k = k1 * (1 - t);
    }
    // + curvature turns left, which in this frame (x = sin h, z = cos h, left
    // normal (cos h, -sin h)) increases the heading.
    const dh = k * step;
    x += Math.sin(h + dh / 2) * step;
    z += Math.cos(h + dh / 2) * step;
    h += dh;
  }
  const cx = x + Math.cos(h) * half;
  const cz = z - Math.sin(h) * half;
  const miss = joint.ax * (cz - joint.z) - joint.az * (cx - joint.x);
  return { points, miss, straightAt, exitAt, lead };
}

/**
 * The shape that lands the branch on the joint's line.
 *
 * `curve`: one unknown, the radius, bisected on the miss. `run`: two. For a
 * given radius the straight run is bisected on the miss; the radius is then
 * the largest for which that still leaves `lead` metres of straight before the
 * joint — a wider curve covers more ground ON, and there is only so much of
 * that between the toe and the joint.
 */
function solveShape(spec: JunctionSpec, toe: number, joint: Joint): Shape {
  const trace = (shape: Shape) => traceBranch(spec, toe, joint, shape, 1, false);
  if (spec.shape === 'curve') {
    let lo = 60;
    let hi = 600;
    const sign = Math.sign(trace({ radius: hi, run: 0 }).miss) || 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (Math.sign(trace({ radius: mid, run: 0 }).miss) === sign) hi = mid; else lo = mid;
    }
    return { radius: (lo + hi) / 2, run: 0 };
  }
  const runFor = (radius: number) => {
    let lo = 0;
    let hi = 1500;
    const sign = Math.sign(trace({ radius, run: lo }).miss);
    if (!sign || sign === Math.sign(trace({ radius, run: hi }).miss)) return null;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (Math.sign(trace({ radius, run: mid }).miss) === sign) lo = mid; else hi = mid;
    }
    const run = (lo + hi) / 2;
    const t = trace({ radius, run });
    return t.straightAt >= 0 && t.lead >= spec.lead ? { radius, run } : null;
  };
  let lo = 60;
  let hi = 2000;
  if (!runFor(lo)) return { radius: lo, run: 0 };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (runFor(mid)) lo = mid; else hi = mid;
  }
  return runFor(lo) ?? { radius: lo, run: 0 };
}

export interface BranchTrackSample {
  x: number; z: number;
  /** Square to the branch, pointing from its inner road toward its outer. */
  nx: number; nz: number;
}

/**
 * One junction, built: the branch's alignment in plan from the toe all the way
 * to the line it joins, how it sits against the running line near the toe, its
 * height, and where it runs out through the main deck's parapet.
 *
 * At the toe the branch has exactly the running line's heading AND curvature,
 * and its curvature is eased, linearly with distance (a clothoid, the standard
 * railway transition), over `transition` metres into its curve; eased out
 * again the same way; and then it runs dead straight, on the joined line's own
 * centreline, onto its end — end-on, same pair, same heading.
 *
 * The alignment is traced as its own polyline and the offset is solved against
 * it: for each arc of the running line near the toe, how far along its normal
 * the branch is (`offsetRaw`). An offset from the running line copied that
 * line's 6 m-polyline kinks and magnified them 20 m out.
 *
 * The outer road is the inner one moved `gap` toward the down line's side,
 * square to the branch, so the pair are truly parallel; at the toe that puts it
 * exactly on the down line, tangent to it.
 */
function buildJunction(spec: JunctionSpec, joint: Joint) {
  const toe = toeNear(spec.at);
  const d = spec.dir;
  const shape = solveShape(spec, toe, joint);
  const traced = traceBranch(spec, toe, joint, shape, CURVE_STEP, true);
  const tracks: BranchTrackSample[][] = [0, 1].map((track) => traced.points.map((p) => {
    const nx = d * Math.cos(p.h);
    const nz = -d * Math.sin(p.h);
    const g = track * spec.gap;
    return { x: p.x + nx * g, z: p.z + nz * g, nx, nz };
  }));
  // Land the last sample on the joint exactly — the pair's centre on the
  // joined line's end. The trace stops within a step of it (0.3 m or so), and
  // that remainder is spread linearly along the straight, where a shift that
  // small only turns it by a few thousandths of a degree; left alone it was a
  // 10 cm step in the rails and under the train.
  {
    const n = traced.points.length - 1;
    const end = tracks[0][n];
    const [ex, ez] = [
      joint.x - end.nx * (spec.gap / 2) - end.x,
      joint.z - end.nz * (spec.gap / 2) - end.z,
    ];
    const first = Math.max(0, Math.round(traced.straightAt / CURVE_STEP));
    for (let i = first; i <= n; i++) {
      const f = n > first ? (i - first) / (n - first) : 1;
      for (const line of tracks) { line[i].x += ex * f; line[i].z += ez * f; }
    }
  }
  const length = (traced.points.length - 1) * CURVE_STEP;

  /** Where the line P + n·o meets polyline `line`, as {o, cos, b}, nearest `guess`. */
  const meet = (
    line: BranchTrackSample[], px: number, pz: number, nx: number, nz: number, guess: number,
  ) => {
    let best: { o: number; cos: number; i: number; b: number } | null = null;
    const from = Math.max(0, guess - 8);
    const to = Math.min(line.length - 1, guess + 8);
    for (let i = from; i < to; i++) {
      const p = line[i];
      const q = line[i + 1];
      const ex = q.x - p.x;
      const ez = q.z - p.z;
      // Solve P + n·o = p + e·t.
      const det = nx * -ez - nz * -ex;
      if (Math.abs(det) < 1e-9) continue;
      const rx = p.x - px;
      const rz = p.z - pz;
      const o = (rx * -ez - rz * -ex) / det;
      const t = (nx * rz - nz * rx) / det;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      if (!best || Math.abs(i - guess) < Math.abs(best.i - guess)) {
        best = { o, cos: Math.abs(nx * p.nx + nz * p.nz), i, b: (i + t) * CURVE_STEP };
      }
    }
    return best;
  };

  /** The running line's arc `u` metres past the toe, the way the branch leaves. */
  const lineArc = (u: number) => trainWrap(toe + d * u);

  // The offset table, per road, sampled along the running line's arc — only
  // as far as the branch is still beside the running line.
  const count = Math.ceil(CURVE_REACH / TABLE_STEP) + 1;
  const offsets = [new Float64Array(count), new Float64Array(count)];
  const cosines = new Float64Array(count);
  const along = new Float64Array(count);
  const guess = [0, 0];
  for (let k = 0; k < count; k++) {
    const s = lineArc(k * TABLE_STEP);
    const [px, , pz] = trainPoint(s);
    const [nx, nz] = trainNormalAt(s);
    for (const track of [0, 1] as const) {
      // Walk the guess to the polyline sample nearest this normal's foot.
      let near = guess[track];
      const line = tracks[track];
      const o0 = k ? offsets[track][k - 1] : track * spec.gap;
      const gx = px + nx * o0;
      const gz = pz + nz * o0;
      for (let w = 0; w < 60; w++) {
        const here = Math.hypot(line[near].x - gx, line[near].z - gz);
        const up = near + 1 < line.length ? Math.hypot(line[near + 1].x - gx, line[near + 1].z - gz) : Infinity;
        if (up < here) near++; else break;
      }
      const hit = meet(line, px, pz, nx, nz, near);
      offsets[track][k] = hit ? hit.o : o0;
      if (hit) guess[track] = hit.i;
      if (track === 0) {
        cosines[k] = hit ? hit.cos : 1;
        along[k] = hit ? hit.b : (k ? along[k - 1] : 0);
      }
    }
  }

  const sampleTable = (table: ArrayLike<number>, u: number): number => {
    const f = clamp(u / TABLE_STEP, 0, count - 1);
    const i = Math.min(count - 2, Math.floor(f));
    const t = f - i;
    return table[i] * (1 - t) + table[i + 1] * t;
  };

  /**
   * Metres left of the up line at `u` metres (of running-line arc) past the
   * toe to branch road `track` (0 inner, 1 outer). Good as far as `CURVE_REACH`.
   */
  const offsetRaw = (u: number, track: 0 | 1): number => {
    const first = sampleTable(offsets[track], u);
    // Solved exactly against the traced curve, with the table only as the
    // first guess. The running line's normal steps at each of its polyline
    // vertices, so the true offset steps there too; interpolating a table
    // across that step put the point a few centimetres off the curve for a
    // quarter of a metre, which a train reads as a kink.
    const s = lineArc(clamp(u, 0, CURVE_REACH));
    const [px, , pz] = trainPoint(s);
    const [nx, nz] = trainNormalAt(s);
    const line = tracks[track];
    const near = clamp(Math.round(sampleTable(along, u) / CURVE_STEP), 0, line.length - 1);
    const hit = meet(line, px, pz, nx, nz, near);
    return hit ? hit.o : first;
  };

  /** Cosine of the angle between the branch and the running line at `u`. */
  const cosAt = (u: number): number => sampleTable(cosines, u);

  /** Metres along the branch's own curve at `u` metres of running-line arc past the toe. */
  const alongAt = (u: number): number => sampleTable(along, u);

  /**
   * The inverse of `alongAt`: running-line metres past the toe at `b` metres
   * along the branch — or `NaN` once the branch has turned too far away from
   * the running line for the question to mean anything.
   */
  const uAt = (b: number): number => {
    if (b > along[Math.round(BESIDE / TABLE_STEP)]) return NaN;
    let k = 0;
    while (k < count - 1 && along[k + 1] < b) k++;
    const a0 = along[k];
    const a1 = along[Math.min(count - 1, k + 1)];
    return (k + (a1 > a0 ? clamp((b - a0) / (a1 - a0), 0, 1) : 0)) * TABLE_STEP;
  };

  /**
   * Where the branch passes through the main deck's left parapet, as metres
   * past the toe: from where its own deck's outer edge reaches the main deck's
   * edge to where its inner edge is clear of it. The main deck drops its
   * parapet over this stretch (`TrainLine`) — the one change to the viaduct
   * itself, and the least one there is: a 0.6 m kerb across the branch is a
   * wall the train would drive through.
   */
  const mouth = (() => {
    const edge = TRAIN.elevated.trackGap / 2 + TRAIN.elevated.deckHalf;
    // First u at which `reach(u)` passes `edge`, walked in 0.25 m steps.
    const first = (reach: (u: number) => number) => {
      for (let u = 0; u <= CURVE_REACH; u += 0.25) if (reach(u) >= edge) return u;
      return CURVE_REACH;
    };
    return {
      // From where the outer road's deck edge reaches the main deck's edge...
      from: first((u) => offsetRaw(u, 1) + spec.deckHalf * cosAt(u)) - 2,
      // ...to where the inner road's deck edge is clear of it.
      to: first((u) => offsetRaw(u, 0) - spec.deckHalf * cosAt(u)) + 2,
      edge,
    };
  })();

  /**
   * The branch's rail-head height (less `RAIL_HEAD_LIFT`, like `trainPointAt`)
   * at `b` metres along its own curve.
   *
   * The running line's own profile while the branch is still on the main deck
   * — the two decks are one slab there and have to agree — and from where it
   * leaves (`mouth.to`), one smooth grade to the joined line's formation at
   * the joint.
   *
   * Vertical curves, not a spline: the running line's grade at the mouth is
   * eased over `EASE_IN` to one constant grade `g2`, held, and eased to level
   * over `EASE_OUT` onto the joint. `g2` is whatever makes the three add up to
   * the joint's height. A cubic through the same ends overshot into a 1.2 m
   * hump.
   */
  const EASE_IN = 60;
  const EASE_OUT = 60;
  const u1 = mouth.to - 2;
  const b1 = alongAt(u1);
  const y1 = trainPoint(lineArc(u1))[1];
  const g1 = (y1 - trainPoint(lineArc(u1 - 6))[1]) / 6;
  const heightAt = (b: number): number => {
    if (b <= b1) return trainPoint(lineArc(uAt(b)))[1];
    const L = Math.max(EASE_IN + EASE_OUT + 1, length - b1);
    const g2 = (joint.y - y1 - (EASE_IN * g1) / 2) / (L - EASE_IN / 2 - EASE_OUT / 2);
    const dd = clamp(b - b1, 0, L);
    const inRun = Math.min(dd, EASE_IN);
    let y = y1 + g1 * inRun + ((g2 - g1) * inRun * inRun) / (2 * EASE_IN);
    if (dd > EASE_IN) y += g2 * (Math.min(dd, L - EASE_OUT) - EASE_IN);
    if (dd > L - EASE_OUT) {
      const o = dd - (L - EASE_OUT);
      y += g2 * o - (g2 * o * o) / (2 * EASE_OUT);
    }
    return y;
  };

  /** The pair's centreline at `b` metres along the branch: [x, y (formation), z]. */
  const centreAt = (b: number): [number, number, number] => {
    const i = clamp(b / CURVE_STEP, 0, tracks[0].length - 1);
    const k = Math.min(tracks[0].length - 2, Math.floor(i));
    const t = i - k;
    const [a0, a1] = [tracks[0][k], tracks[0][k + 1]];
    const [o0, o1] = [tracks[1][k], tracks[1][k + 1]];
    return [
      ((a0.x + o0.x) / 2) * (1 - t) + ((a1.x + o1.x) / 2) * t,
      heightAt(b),
      ((a0.z + o0.z) / 2) * (1 - t) + ((a1.z + o1.z) / 2) * t,
    ];
  };

  /** True where the main deck's left parapet gives way to this branch. */
  const mouthAt = (s: number): boolean => {
    const u = d * ahead(toe, s);
    return u >= mouth.from && u <= mouth.to;
  };

  return {
    spec, toe, dir: d, joint, radius: shape.radius, run: shape.run, length,
    tracks, exitAt: traced.exitAt, straightAt: traced.straightAt,
    offsetRaw, cosAt, alongAt, uAt, mouth, mouthAt, heightAt, centreAt, lineArc,
  };
}

export type BranchJunction = ReturnType<typeof buildJunction>;

/**
 * The Skylark junction's branch, from the toe all the way to the Skylark line.
 *
 * Its curve's radius is not chosen, it is SOLVED: it is the one radius for
 * which the straight lands on the Skylark line rather than beside it. From
 * this toe that is about 128 m — the toe is only 103 m from the Skylark line
 * and the branch has to turn 68° to run along it, and a curve covers about
 * 0.63 R sideways in that turn. A wider curve needs the toe further back.
 */
export const JUNCTION_CURVE: BranchJunction = buildJunction(JUNCTION, SKYLARK_JOINT);

/** The airport junction's branch, from its toe to the trunk's open north end. */
export const AIRPORT_BRANCH: BranchJunction = buildJunction(AIRPORT_JUNCTION, TRUNK_END);

/** Both junctions, for everything that draws or clears round them. */
export const JUNCTIONS: ReadonlyArray<BranchJunction> = [JUNCTION_CURVE, AIRPORT_BRANCH];

/** The Skylark branch's solved curve radius, metres. */
export const JUNCTION_RADIUS = JUNCTION_CURVE.radius;

/** The Skylark branch, against the running line — see `buildJunction`. */
export const branchOffsetRaw = JUNCTION_CURVE.offsetRaw;
export const branchOffset = (u: number, track: 0 | 1): number =>
  branchOffsetRaw(clamp(u, 0, JUNCTION.length), track);
export const branchCosAt = JUNCTION_CURVE.cosAt;
export const branchUAt = JUNCTION_CURVE.uAt;
export const branchAlongAt = JUNCTION_CURVE.alongAt;
export const branchHeightAt = JUNCTION_CURVE.heightAt;

/* ------------------------------------------------ the branch as a route */

/**
 * The branch roads as somewhere a train can actually go: from the Skylark toe
 * along that branch's own curve, onto the Skylark line at its old pier end,
 * right round Skylark on that line's own centreline, along the airport
 * island's trunk — which the Skylark line was built to meet end-on, one
 * railway — to the trunk's open north end, and on over the airport branch back
 * onto the running line at the airport toe. One loop: out at one junction,
 * home at the other.
 *
 * Measured in metres along the route from the Skylark toe (`b`), NOT along the
 * running line. That is the whole of the change that lets the player's train go
 * past a junction: it used to be steered as an offset from the running line,
 * which only holds while the branch still runs beside it (it stopped the train
 * 80 m out, at a signal). Now each branch road knows its own position
 * (`Road.place`), and the train simply keeps counting metres along it.
 *
 * Every piece is built from the CENTRELINE and its direction of travel, with
 * the railway's own left normal taken from that direction, so the three
 * systems' differing normal conventions never meet.
 */
export const BRANCH_ROUTE = (() => {
  const branch = JUNCTION_CURVE.length;
  const skylark = SKYLARK_MARKS.pierEnd;
  const trunk = TRUNK_JOINT;
  const airport = AIRPORT_BRANCH.length;
  return { branch, skylark, trunk, airport, length: branch + skylark + trunk + airport };
})();

/**
 * The Skylark line's centre at one of its own arcs, in world terms, with its
 * formation height — interpolated by each sample's real arc. `railAt` assumes
 * a uniform 3 m, which the last interval is not (2.7 m, to the pier end), so it
 * returned the pier end for the whole last stretch and then jumped.
 */
export function skylarkCentreAt(arc: number): [number, number, number] {
  const line = SKYLARK_RAIL;
  const a = clamp(arc, 0, line[line.length - 1].arc);
  let lo = 0;
  let hi = line.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (line[mid].arc <= a) lo = mid; else hi = mid; }
  const p = line[lo];
  const q = line[hi];
  const t = q.arc > p.arc ? (a - p.arc) / (q.arc - p.arc) : 0;
  const [x, z] = skylarkToWorld(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t);
  return [x, p.y + (q.y - p.y) * t, z];
}

/** The route's centreline at `b` metres past the Skylark toe: [x, y (formation), z]. */
function routeCentreAt(b: number): [number, number, number] {
  const R = BRANCH_ROUTE;
  if (b <= R.branch) return JUNCTION_CURVE.centreAt(b);
  if (b <= R.branch + R.skylark) return skylarkCentreAt(R.skylark - (b - R.branch));
  const t = b - R.branch - R.skylark;
  if (t <= R.trunk) return trunkCentreAt(R.trunk - t);
  // Over the airport branch the other way from how it was traced: from the
  // trunk's north end back to its toe.
  return AIRPORT_BRANCH.centreAt(R.airport - (t - R.trunk));
}

export interface RailPlace {
  /** Rail-head point less `RAIL_HEAD_LIFT` — the same convention as `trainPointAt`. */
  x: number; y: number; z: number;
  /** The road's left normal, the railway's convention. */
  nx: number; nz: number;
}

/**
 * Where branch road `track` (0 inner, 1 outer) is at `b` metres past the
 * Skylark toe.
 *
 * Near that toe the two roads are exactly the up and down lines, and the inner
 * is the one on the right going away — so it is the centreline moved half the
 * gap to the right of the direction of travel, the outer half the gap left.
 * Right-hand running holds all the way round: at the airport toe, arriving
 * up the arc, the inner road is again the one on the right, and lands on the
 * up line; the outer on the down.
 */
export function branchPlaceAt(b: number, track: 0 | 1): RailPlace {
  const bb = clamp(b, 0, BRANCH_ROUTE.length);
  const [ax, , az] = routeCentreAt(Math.max(0, bb - 0.75));
  const [bx, , bz] = routeCentreAt(Math.min(BRANCH_ROUTE.length, bb + 0.75));
  const l = Math.hypot(bx - ax, bz - az) || 1;
  const tx = (bx - ax) / l;
  const tz = (bz - az) / l;
  const nx = tz;
  const nz = -tx;
  const [cx, cy, cz] = routeCentreAt(bb);
  const side = (track ? 1 : -1) * (JUNCTION.gap / 2);
  return { x: cx + nx * side, y: cy, z: cz + nz * side, nx, nz };
}

/**
 * The line speed along the route, m/s: the junction and its diamond, the
 * 128 m curve, the straight, then what the Skylark line and the trunk's own
 * curvature allow (the running line's rule, `sqrt(12 R)`), all capped at 90.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is the contract
export function branchLimitAt(_b: number): number {
  return ROUTE_TOP;
}
/**
 * The branch and the lines beyond it: 300 km/h, the train's own top speed, the
 * whole way — asked for, and no slowing over the junction either. It was
 * 40 km/h over the points and diamond, 60 on the 128 m curve and 90 beyond.
 */
const ROUTE_TOP = 300 / 3.6;

/** Where the trunk comes ashore, in its own arc: north of this it is on viaduct. */
const TRUNK_LANDFALL = 89;

/** The Skylark branch's parapet cut — see `buildJunction`'s `mouth`. */
export const JUNCTION_MOUTH = JUNCTION_CURVE.mouth;

/** True where the main deck's left parapet gives way to either junction's branch. */
export function junctionMouthAt(s: number): boolean {
  return JUNCTIONS.some((j) => j.mouthAt(s));
}

/**
 * Each route road, twice over: once counted from the Skylark toe, where it
 * leaves the running line, and once from the airport toe. Same rails, same
 * metres along them (`roadS` gives the same `b` on either); only where the
 * road's arc starts differs, so that the turnout at each end is at that
 * junction's real arc. See `routeHandover`.
 */
const ROUTE_VIEWS: Array<{ track: 0 | 1; skylark: number; airport: number }> = [];
/**
 * The branch loop's two views of each of its mains, by road id — for placing a
 * train straight onto the loop (`trainStations`): start it on the view
 * `routeHandover` would want for its direction, or it is handed over (and
 * moved) on its first step.
 */
export const branchViews = (): ReadonlyArray<{ track: 0 | 1; skylark: number; airport: number }> => ROUTE_VIEWS;

/* ------------------------------------------------ the loop's own pointwork */

/*
 * The airport island's pointwork, as roads a train can take: the station's two
 * loops and PF1's spur, the trunk's crossover, and the yard — its connection
 * off the trunk, both of its mains and the two sidings off them.
 *
 * All of it is drawn by `IslandRail` and `AirportIsland` off `islandRailConfig`
 * and `airportConfig`; these roads are built off the very same samples, so a
 * train on them is on the rails that are drawn. Each exists twice, once in each
 * view of the loop (`ROUTE_VIEWS`), because a road off a road has to be counted
 * in the same arc as the road it leaves.
 *
 * Two kinds. A road ALONGSIDE one of the loop's mains — the station's loops,
 * the spur, the crossover — is counted in that main's own metres: at each of
 * the main's arcs, where its normal meets the road (`alongside`), which is how
 * the junctions' branches are solved against the running line. A road that
 * turns away — the yard's — is counted in its own metres from its turnout
 * (`ownRoad`), laid so its arc runs on from the turnout the way the train
 * leaving on it is going.
 */

/** A point on a road, in world terms, with `trainPointAt`'s convention for y. */
interface WorldPoint { x: number; y: number; z: number }

/**
 * An island-frame track sample in world terms, its height as the loop counts
 * it: the island's crown, the trunk's climb where it is (nearest trunk sample),
 * and its own ballast against the running line's — the yard's 0.4 m against
 * 0.62, which is the step the connection ramps out.
 */
function islandPoint(q: { x: number; z: number; depth: number }): WorldPoint {
  let arc = 0;
  let near = Infinity;
  for (const t of TRUNK_LINE) {
    const d = (t.x - q.x) ** 2 + (t.z - q.z) ** 2;
    if (d < near) { near = d; arc = t.arc; }
  }
  const [x, z] = airportWorld(q.x, q.z);
  return { x, z, y: AIRPORT_SITE.ground + TRUNK_CLIMB.riseAt(arc) + q.depth - ISLAND_BALLAST.line.depth };
}

const SIDE_STEP = 0.5;

/**
 * A road alongside loop main `track`, solved against it: for every half-metre
 * of that main between the road's two ends, where the main's normal meets the
 * road, how far along it (`o`, + to the main's left) and how high.
 */
interface Alongside {
  track: 0 | 1;
  b0: number;
  b1: number;
  x: Float64Array; y: Float64Array; z: Float64Array; o: Float64Array;
}

function alongside(poly: WorldPoint[], track: 0 | 1): Alongside {
  const R = BRANCH_ROUTE;
  const lo = R.branch + R.skylark;
  const hi = lo + R.trunk;
  // The main's metre nearest a point: a coarse sweep of the trunk, refined.
  const nearestB = (p: WorldPoint) => {
    let best = lo;
    let bestD = Infinity;
    const probe = (b: number) => {
      const q = branchPlaceAt(b, track);
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    };
    for (let b = lo; b <= hi; b += 2) probe(b);
    const c = best;
    for (let b = c - 2; b <= c + 2; b += 0.05) probe(b);
    return best;
  };
  const e0 = nearestB(poly[0]);
  const e1 = nearestB(poly[poly.length - 1]);
  const b0 = Math.min(e0, e1);
  const b1 = Math.max(e0, e1);
  const n = Math.max(2, Math.floor((b1 - b0) / SIDE_STEP) + 1);
  const out: Alongside = {
    track, b0, b1: b0 + (n - 1) * SIDE_STEP,
    x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), o: new Float64Array(n),
  };
  let last: { x: number; y: number; z: number; o: number } | null = null;
  for (let k = 0; k < n; k++) {
    const p = branchPlaceAt(b0 + k * SIDE_STEP, track);
    let hit: { x: number; y: number; z: number; o: number } | null = null;
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i];
      const c = poly[i + 1];
      const ex = c.x - a.x;
      const ez = c.z - a.z;
      // Solve P + n·o = a + e·t.
      const det = p.nx * -ez - p.nz * -ex;
      if (Math.abs(det) < 1e-9) continue;
      const rx = a.x - p.x;
      const rz = a.z - p.z;
      const o = (rx * -ez - rz * -ex) / det;
      const t = (p.nx * rz - p.nz * rx) / det;
      if (t < -1e-6 || t > 1 + 1e-6 || Math.abs(o) > 40) continue;
      if (!hit || Math.abs(o) < Math.abs(hit.o)) {
        hit = { x: p.x + p.nx * o, z: p.z + p.nz * o, y: a.y + (c.y - a.y) * t, o };
      }
    }
    // Past the road's very end by a hair the normal misses it; the road is
    // on its main there, so it is the main.
    const at: { x: number; y: number; z: number; o: number } = hit ?? last ?? { x: p.x, y: p.y, z: p.z, o: 0 };
    out.x[k] = at.x; out.y[k] = at.y; out.z[k] = at.z; out.o[k] = at.o;
    last = at;
  }
  return out;
}

/** Where an alongside road is `b` metres along the loop. */
function alongsideAt(r: Alongside, b: number) {
  const n = r.x.length;
  const f = clamp((b - r.b0) / SIDE_STEP, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  const lerp = (a: Float64Array) => a[i] * (1 - t) + a[i + 1] * t;
  return { x: lerp(r.x), y: lerp(r.y), z: lerp(r.z), o: lerp(r.o) };
}

/** A polyline with its own running metres, for a road that turns away. */
interface OwnLine { pts: WorldPoint[]; d: Float64Array; length: number }

function ownLine(pts: WorldPoint[]): OwnLine {
  const d = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    d[i] = d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return { pts, d, length: d[pts.length - 1] };
}

function ownLineAt(line: OwnLine, at: number): WorldPoint {
  const a = clamp(at, 0, line.length);
  let lo = 0;
  let hi = line.pts.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (line.d[mid] <= a) lo = mid; else hi = mid; }
  const t = line.d[hi] > line.d[lo] ? (a - line.d[lo]) / (line.d[hi] - line.d[lo]) : 0;
  const p = line.pts[lo];
  const q = line.pts[hi];
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t };
}

/**
 * A place from a way of finding points, with the road's left normal taken
 * from its own direction of increasing arc.
 */
function placeFrom(at: (s: number) => WorldPoint, s: number): RailPlace {
  const p = at(s);
  const a = at(s - 0.75);
  const b = at(s + 0.75);
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: p.x, y: p.y, z: p.z, nx: (b.z - a.z) / l, nz: -(b.x - a.x) / l };
}

/** The station, the crossover and the yard, as geometry — built once. */
const LOOP_POINTWORK = (() => {
  if (!TRAIN_POINTS.length) return null;
  // Which loop main each side of the trunk is. The loop runs the trunk against
  // its arc, so the trunk's left (+1, the coast) is the loop's right: its up
  // road, 0. The road side (-1) is its down road, 1.
  const mainOf = (side: -1 | 1): 0 | 1 => (side < 0 ? 1 : 0);
  const world = (samples: ReadonlyArray<{ x: number; z: number; depth: number }>) => samples.map(islandPoint);
  const yardDepth = SIDINGS.ballast.depth;
  const yardMain = (at: number) => {
    const road = SIDINGS.roads.find((r) => r.at === at);
    return road ? sidingCentre(road, 2) : [];
  };
  // The connection runs from the neck's railhead to the trunk; the yard's down
  // main is its own road south of the railhead. Trunk end first, into the yard.
  const conn = connectionSamples();
  const connLength = conn[conn.length - 1].arc;
  const down = ownLine([
    ...world([...conn].reverse()),
    ...world(yardMain(THROUGH_MAIN).filter(([, z]) => z < RAILHEAD - 0.5).reverse()
      .map(([x, z]) => ({ x, z, depth: yardDepth }))),
  ]);
  // The up main's link eases off the connection and runs onto the up main.
  // Merge end first, then south down the up main.
  const link = downLinkSamples();
  const up = ownLine([
    ...world([...link].reverse()),
    ...world(yardMain(LINK_MAIN).filter(([, z]) => z < RAILHEAD - 0.5).reverse()
      .map(([x, z]) => ({ x, z, depth: yardDepth }))),
  ]);
  // Where the link leaves the connection, in metres from the trunk end: its
  // merge end measured on the connection itself. `LINK`'s own figure is where
  // the ease finishes, and the link's last sample is the first 2 m spine
  // sample past that — a metre and more further on.
  const merge = up.pts[0];
  let linkAt = 0;
  let linkD = Infinity;
  for (let i = 0; i < down.pts.length - 1; i++) {
    const a = down.pts[i];
    const b = down.pts[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1;
    const t = clamp(((merge.x - a.x) * ex + (merge.z - a.z) * ez) / len2, 0, 1);
    const d = Math.hypot(a.x + ex * t - merge.x, a.z + ez * t - merge.z);
    if (d < linkD) { linkD = d; linkAt = down.d[i] + Math.sqrt(len2) * t; }
  }
  const siding = (at: number) => {
    const road = SIDINGS.roads.find((r) => r.at === at);
    return road ? ownLine(world(sidingCentre(road, 2).reverse().map(([x, z]) => ({ x, z, depth: yardDepth })))) : null;
  };
  return {
    downLoop: alongside(world(stationLoop('down')), mainOf(LOOP_SIDE.down)),
    upLoop: alongside(world(stationLoop('up')), mainOf(LOOP_SIDE.up)),
    spur: alongside(world(pf1Spur()), mainOf(LOOP_SIDE.down)),
    crossover: alongside(world(crossoverSamples()), mainOf(YARD_SIDE)),
    yardTrack: mainOf(YARD_SIDE),
    conn: { line: down, length: connLength },
    link: { line: up, from: linkAt },
    dock: siding(447),
    arrivals: siding(488),
  };
})();

/** Metres along the loop of the yard connection's turnout on the trunk, from its own end sample. */
function loopBNearest(p: WorldPoint, track: 0 | 1): number {
  const R = BRANCH_ROUTE;
  const lo = R.branch + R.skylark;
  let best = lo;
  let bestD = Infinity;
  const probe = (b: number) => {
    const q = branchPlaceAt(b, track);
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = b; }
  };
  for (let b = lo; b <= lo + R.trunk; b += 2) probe(b);
  const c = best;
  for (let b = c - 2; b <= c + 2; b += 0.05) probe(b);
  return best;
}

/** Speeds off the loop's mains: a station throat's, as at the island station, and a yard's. */
const LOOP_THROAT_SPEED = CROSSOVER.throatSpeed;
const YARD_SPEED = 25 / 3.6;

/**
 * Lays the loop's pointwork into both views of the loop. Called once, from
 * `built`, after the two views of each main exist.
 */
function layLoopPointwork(roads: Road[], turnouts: Turnout[]) {
  const P = LOOP_POINTWORK;
  if (!P) return;
  const G = JUNCTION.gap;
  for (const view of ['skylark', 'airport'] as const) {
    const main = (track: 0 | 1) => roads[ROUTE_VIEWS[track][view]];
    /** A road alongside a main, with a turnout at each end onto `ends`. */
    const beside = (name: string, r: Alongside, ends: [Road, Road], limit: number) => {
      const parent = main(r.track);
      const id = roads.length;
      const road: Road = {
        id,
        name,
        from: trainWrap(parent.from + r.b0),
        length: r.b1 - r.b0,
        through: false,
        limit,
        offset: (s) => r.track * G + alongsideAt(r, r.b0 + roadS(road, s)).o,
        place: (s) => placeFrom((a) => alongsideAt(r, r.b0 + roadS(road, a)), s),
        onLoop: () => true,
        routeB: (s) => r.b0 + roadS(road, s),
        sub: true,
      };
      roads.push(road);
      turnouts.push({ arc: road.from, a: ends[0].id, b: id });
      turnouts.push({ arc: trainWrap(road.from + road.length), a: ends[1].id, b: id });
      return road;
    };
    /**
     * A road that turns away off `parent` at arc `at`, into the yard: its arc
     * runs DOWN from the turnout, the way a train leaving the trunk on it is
     * going, to a buffer stop at its far end.
     */
    const away = (name: string, parent: Road, at: number, line: OwnLine) => {
      const id = roads.length;
      const len = line.length;
      const road: Road = {
        id,
        name,
        from: trainWrap(at - len),
        length: len,
        through: false,
        limit: YARD_SPEED,
        // Near the turnout, how far left of the loop's up road it is — the road
        // it leaves' own figure, plus how far off that road it has come; well
        // clear of the mains, simply clear.
        offset: (s) => {
          const q = parent.place?.(s);
          if (!q) return 1e3;
          const p = placeFrom((a) => ownLineAt(line, len - roadS(road, a)), s);
          const dx = p.x - q.x;
          const dz = p.z - q.z;
          return Math.hypot(dx, dz) > 25 ? 1e3 : parent.offset(s) + dx * q.nx + dz * q.nz;
        },
        place: (s) => placeFrom((a) => ownLineAt(line, len - roadS(road, a)), s),
        buffer: -1,
        onLoop: () => true,
        routeB: (s) => parent.routeB?.(s) ?? 0,
        sub: true,
      };
      roads.push(road);
      turnouts.push({ arc: trainWrap(at), a: parent.id, b: id });
      return road;
    };

    const downMain = main(P.downLoop.track);
    const upMain = main(P.upLoop.track);
    const pf1 = beside('PF1 LOOP', P.downLoop, [downMain, downMain], LOOP_THROAT_SPEED);
    beside('PF4 LOOP', P.upLoop, [upMain, upMain], LOOP_THROAT_SPEED);
    beside('PF1 SPUR', P.spur, [pf1, downMain], LOOP_THROAT_SPEED);
    {
      // The crossover's low-b end is on the other main, its high-b end on the
      // yard's side — see `CROSSOVER` in `islandRailConfig`.
      const yard = main(P.yardTrack);
      const other = main(P.yardTrack ? 0 : 1);
      beside('TRUNK CROSSOVER', P.crossover, [other, yard], LOOP_THROAT_SPEED);
    }
    // The yard: its connection leaves the trunk's yard-side road facing a train
    // running DOWN the loop (towards Skylark), and the rest peels off that.
    const yardMain = main(P.yardTrack);
    const toe = loopBNearest(P.conn.line.pts[0], P.yardTrack);
    const connRoad = away('YARD DOWN MAIN', yardMain, yardMain.from + toe, P.conn.line);
    const connTop = connRoad.from + connRoad.length;
    const upRoad = away('YARD UP MAIN', connRoad, connTop - P.link.from, P.link.line);
    if (P.dock) away('YARD DOCK', connRoad, connTop - P.conn.length, P.dock);
    if (P.arrivals) {
      // Where the arrivals road reaches the up main, in the up main's metres.
      const end = P.arrivals.pts[0];
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < P.link.line.pts.length; i++) {
        const q = P.link.line.pts[i];
        const d = (q.x - end.x) ** 2 + (q.z - end.z) ** 2;
        if (d < bestD) { bestD = d; best = P.link.line.d[i]; }
      }
      away('YARD ARRIVALS', upRoad, upRoad.from + upRoad.length - best, P.arrivals);
    }
  }
}


/**
 * How far the island station's own pointwork reaches from its midpoint.
 *
 * The whole complex, not just the platforms: the longest of the ladder's leads,
 * plus the throat crossover beyond it. Both the barring below and the throat
 * placement further down are measured from this, because they have to agree —
 * when the outer loop's lead grew (`STATION.loopLead`) the throat crossovers
 * moved out with it, and the *east* one landed on top of a plain-line crossover
 * that had been sited 30 m clear of where the throat used to end. Four
 * diagonals in 56 m of track, which is exactly as bad as it sounds.
 */
const STATION_EXTENT = STATION_SITE
  ? Math.max(...ROADS.slice(1).map(roadLead)) + CROSSOVER.throatClear + CROSSOVER.throatLead
  : 0;

/** Change of heading per metre at arc `s` — curvature, as 1/radius. */
function curvatureAt(s: number): number {
  const [ax, az] = trainTangentAt(s);
  const [bx, bz] = trainTangentAt(trainWrap(s + PROBE));
  let d = Math.atan2(bx, bz) - Math.atan2(ax, az);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) / PROBE;
}

/**
 * Where the crossovers go: the straightest 84 m windows that are clear of every
 * platform, spread round the loop.
 *
 * Straightness rather than structure. The first version of this looked for
 * plain ballast, on the assumption that pointwork needs ground under it — and
 * found 876 m of it on the whole line, all but 130 m of that already occupied
 * by the station. A crossover does not need ground: it runs between two tracks
 * that are already carried, so wherever the railway is double it has a deck or
 * an invert under it.
 */
const CROSSOVER_SITES: number[] = (() => {
  if (!TRAIN_POINTS.length) return [];
  // Nowhere near a platform: the island station's platform A stands between the
  // two through roads, the metro's stand outside them and the underground hall
  // is barely wider than the bore, so a diagonal through any of them would be
  // laid through masonry.
  const barred: Array<[number, number]> = [];
  // The station keeps the plain line out of its whole complex, throat
  // crossovers included — see `STATION_EXTENT`.
  if (STATION_SITE) barred.push([STATION_SITE.arc, STATION_EXTENT + CROSSOVER.clear]);
  if (METRO_SITE) barred.push([METRO_SITE.arc, METRO.platformLength / 2 + CROSSOVER.clear]);
  if (UNDERGROUND_SITE) {
    barred.push([UNDERGROUND_SITE.arc,
      UNDERGROUND.length / 2 + UNDERGROUND.ease + CROSSOVER.clear]);
  }
  const barredAt = (s: number) => barred.some(([arc, half]) => Math.abs(ahead(arc, s)) <= half);

  const candidates: Array<{ arc: number; curve: number }> = [];
  for (const point of TRAIN_POINTS) {
    let curve = 0;
    let blocked = false;
    for (let d = 0; d <= CROSSOVER.lead; d += PROBE) {
      const at = trainWrap(point.arc + d);
      if (barredAt(at)) { blocked = true; break; }
      curve = Math.max(curve, curvatureAt(at));
    }
    if (!blocked && curve <= 1 / CROSSOVER.minRadius) candidates.push({ arc: point.arc, curve });
  }
  // Straightest first, then spread: taking the best window and refusing
  // anything within 700 m of it leaves the loop with crossovers at intervals
  // rather than a cluster in its one long straight.
  candidates.sort((a, b) => a.curve - b.curve);
  const chosen: number[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= CROSSOVER.count) break;
    if (chosen.every((arc) => Math.abs(ahead(arc, candidate.arc)) >= CROSSOVER.spacing)) {
      chosen.push(candidate.arc);
    }
  }
  return chosen.sort((a, b) => a - b);
})();

/** Signed metres from the station's midpoint, for the loop roads' offsets. */
const alongStation = (s: number) => (STATION_SITE ? ahead(STATION_SITE.arc, s) : 0);

const built = (() => {
  const roads: Road[] = [
    {
      id: UP,
      name: 'UP LINE',
      from: 0,
      length: TRAIN_LENGTH,
      through: true,
      limit: Infinity,
      offset: () => 0,
    },
    {
      id: DOWN,
      name: 'DOWN LINE',
      from: 0,
      length: TRAIN_LENGTH,
      through: true,
      limit: Infinity,
      offset: secondTrackGap,
    },
  ];
  const turnouts: Turnout[] = [];

  // The loop lines: the station's own extra roads, which `roadOffset` has
  // already eased onto the down line at each end.
  if (STATION_SITE) {
    for (let r = 2; r < ROADS.length; r++) {
      const road = ROADS[r];
      const lead = roadLead(road);
      const id = roads.length;
      roads.push({
        id,
        name: `LOOP ${r - 1}`,
        from: trainWrap(STATION_SITE.arc - lead),
        length: lead * 2,
        through: false,
        // A platform road is signed as slowly as the throat that reaches it.
        limit: CROSSOVER.throatSpeed,
        offset: (s) => roadOffset(road, alongStation(s)),
      });
      // Both loops come off the down line, not off each other — see
      // `STATION.loopLead`. Their turnouts are therefore two staggered pairs
      // on the down line rather than a ladder, which is what `roadOffset` now
      // draws and what the driver sees from the cab.
      turnouts.push({ arc: trainWrap(STATION_SITE.arc - lead), a: DOWN, b: id });
      turnouts.push({ arc: trainWrap(STATION_SITE.arc + lead), a: DOWN, b: id });
    }

    // The relief loop, off the UP line and on the other side of it — see
    // `UP_LOOP`. Its turnouts are a facing pair on the up line exactly as the
    // platform loops' are on the down, so the same rule holds for it: no dead
    // end, both ends on a running line, and it is reached in either direction
    // because whichever end the train arrives at is a facing point for it.
    const upLead = upLoopLead();
    if (upLead > 0) {
      const id = roads.length;
      roads.push({
        id,
        name: 'RELIEF LOOP',
        from: trainWrap(STATION_SITE.arc - upLead),
        length: upLead * 2,
        through: false,
        limit: CROSSOVER.throatSpeed,
        offset: (s) => upLoopOffset(alongStation(s)),
      });
      turnouts.push({ arc: trainWrap(STATION_SITE.arc - upLead), a: UP, b: id });
      turnouts.push({ arc: trainWrap(STATION_SITE.arc + upLead), a: UP, b: id });
    }
  }

  // The crossovers. Both diagonals at every site — a scissors — so that
  // whichever line the driver is on and whichever way they are running, the
  // other line is one set of points away. A single diagonal can only be taken
  // in the direction it was laid, which would mean driving up to two kilometres
  // to find the one that goes the way you want.
  const scissors = (arc: number, lead: number, limit: number) => {
    const exit = trainWrap(arc + lead);
    for (const sense of [1, -1] as const) {
      const id = roads.length;
      roads.push({
        id,
        name: 'CROSSOVER',
        from: arc,
        length: lead,
        through: false,
        limit,
        // Equal to the up line at one end and the down line at the other, which
        // is what its two turnouts stand on. The gap is read per sample rather
        // than taken as a constant so a crossover would still land on both
        // tracks if it were sited where they are fanning apart.
        offset: (s) => {
          const t = smooth(clamp(ahead(arc, s) / lead, 0, 1));
          return secondTrackGap(s) * (sense > 0 ? t : 1 - t);
        },
      });
      turnouts.push({ arc, a: sense > 0 ? UP : DOWN, b: id });
      turnouts.push({ arc: exit, a: id, b: sense > 0 ? DOWN : UP });
    }
  };

  for (const arc of CROSSOVER_SITES) scissors(arc, CROSSOVER.lead, CROSSOVER.speed);

  // The branch: two roads, one off each running line at each junction's toe,
  // and the same two roads all the way round the loop between them. The inner
  // road's crossing of the down line is a diamond at both junctions, not a
  // connection, so it is not listed.
  //
  // Each road is entered twice, as two views of the one piece of track: from
  // the Skylark toe, where its arc starts (`from`) at that toe, and from the
  // airport toe, where it is laid so that its far end is at that toe's arc.
  // Both count the same metres along it — `roadS` is `b` from the Skylark toe
  // on either — so a train is handed from one to the other half way round
  // without moving a centimetre (`routeHandover`).
  if (TRAIN_POINTS.length) {
    const R = BRANCH_ROUTE;
    // Past either end the train is back on the running line, and its curve
    // limits: a train off the branch at 300 km/h must see the 143 m curve at
    // the airport toe coming.
    const routeLimit = (road: Road, s: number) => {
      const b = roadS(road, s);
      return b >= 0 && b <= R.length ? branchLimitAt(b) : trainSpeedLimitAt(trainWrap(s));
    };
    for (const [track, line, name] of [[0, UP, 'BRANCH UP'], [1, DOWN, 'BRANCH DOWN']] as const) {
      const id = roads.length;
      const road: Road = {
        id,
        name,
        from: JUNCTION_TOE,
        // The whole loop: branch, Skylark, trunk, the airport branch. The far
        // end is reached only from the other view, at the airport toe; the stop
        // is a backstop for a hand-over that did not happen.
        length: R.length,
        through: false,
        limit: JUNCTION.speed,
        // Beside the running line, how far left of it the road is — for the
        // fouling test and the points' hand; out beyond, simply clear of it.
        // Out beyond, how far left of the loop's inner road: 0 or the gap.
        offset: (s) => {
          const u = branchUAt(Math.max(0, roadS(road, s)));
          return Number.isFinite(u) ? branchOffsetRaw(u, track) : track * JUNCTION.gap;
        },
        place: (s) => branchPlaceAt(roadS(road, s), track),
        limitAt: (s) => routeLimit(road, s),
        buffer: 1,
        onLoop: (s) => !Number.isFinite(branchUAt(Math.max(0, roadS(road, s)))),
        routeB: (s) => roadS(road, s),
      };
      roads.push(road);
      turnouts.push({ arc: JUNCTION_TOE, a: line, b: id });

      const backId = roads.length;
      const back: Road = {
        id: backId,
        name,
        from: trainWrap(AIRPORT_BRANCH.toe - R.length),
        length: R.length,
        through: false,
        limit: JUNCTION.speed,
        offset: (s) => {
          const u = AIRPORT_BRANCH.uAt(Math.max(0, R.length - roadS(back, s)));
          return Number.isFinite(u) ? AIRPORT_BRANCH.offsetRaw(u, track) : track * JUNCTION.gap;
        },
        place: (s) => branchPlaceAt(roadS(back, s), track),
        limitAt: (s) => routeLimit(back, s),
        buffer: -1,
        onLoop: (s) => !Number.isFinite(AIRPORT_BRANCH.uAt(Math.max(0, R.length - roadS(back, s)))),
        routeB: (s) => roadS(back, s),
      };
      roads.push(back);
      turnouts.push({ arc: AIRPORT_BRANCH.toe, a: line, b: backId });
      ROUTE_VIEWS.push({ track, skylark: id, airport: backId });
    }
    // The airport island's station, crossover and yard, off those mains.
    layLoopPointwork(roads, turnouts);
  }

  // The throat pair, just outside the ladder at each end of the station. These
  // are what let a train arriving on either line take any of the four roads,
  // and take them one after another: cross at the throat, then the ladder.
  if (STATION_SITE) {
    // Outside the *whole* ladder: the outer loop's turnout is now the furthest
    // one out, so the throat crossover clears the longest lead of the lot.
    const outer = Math.max(...ROADS.slice(1).map(roadLead));
    const west = trainWrap(STATION_SITE.arc - outer - CROSSOVER.throatClear
      - CROSSOVER.throatLead);
    const east = trainWrap(STATION_SITE.arc + outer + CROSSOVER.throatClear);
    scissors(west, CROSSOVER.throatLead, CROSSOVER.throatSpeed);
    scissors(east, CROSSOVER.throatLead, CROSSOVER.throatSpeed);
  }

  return { roads, turnouts };
})();

export const RAIL_ROADS: ReadonlyArray<Road> = built.roads;
export const TURNOUTS: ReadonlyArray<Turnout> = built.turnouts;
export const POINTWORK_ENABLED = TURNOUTS.length > 0;

/** Every crossover's connecting track, for the geometry to draw. */
export const CROSSOVER_ROADS = RAIL_ROADS.filter((r) => r.name === 'CROSSOVER');

/** The junction's two branch roads, inner then outer, for the geometry to draw. */
export const BRANCH_ROADS = RAIL_ROADS.filter((r) => r.name.startsWith('BRANCH'));

/**
 * Metres along `road` from its `from` to arc `s`, signed: negative behind the
 * start. For a through road this is just the loop's own shortest-way distance.
 *
 * Needed because a road can now be longer than half the loop — the branch runs
 * 4 km on to Skylark and the airport — and `ahead`'s shortest-way answer flips
 * sign half way round: 3.3 km out on the branch, the points at its toe would
 * suddenly read as just behind the train, and running "over" them again put
 * it back on the up line.
 */
export function roadS(road: Road, s: number): number {
  if (road.through) return ahead(road.from, s);
  const u = ((s - road.from) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  return u > (road.length + TRAIN_LENGTH) / 2 ? u - TRAIN_LENGTH : u;
}

/**
 * Signed metres from arc `from` to arc `to` measured along `road` — the
 * distance a train on that road actually has to run.
 */
const along = (road: Road, from: number, to: number) => (
  road.through ? ahead(from, to) : roadS(road, to) - roadS(road, from)
);

/** Is `road` laid at arc `s`? */
export function roadExistsAt(road: Road, s: number): boolean {
  if (road.through) return true;
  const u = ((s - road.from) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  return u <= road.length;
}

export const roadOf = (id: number) => RAIL_ROADS[id] ?? RAIL_ROADS[UP];
export const roadNameOf = (id: number) => roadOf(id).name;

/* ------------------------------------------------------------ the driver's end */

export interface PointsMove {
  /** The turnout's arc, and which way the train was going through it. */
  arc: number;
  way: 1 | -1;
  from: number;
  to: number;
}

export interface PointsState {
  /** The road behind the oldest remembered move. */
  base: number;
  /**
   * Every turnout the train has run through, oldest first.
   *
   * A history rather than a single current road, because the train is longer
   * than the pointwork: with a ten-coach rake the locomotive can be a hundred
   * metres past a crossover while the rear engine has not reached it. Each unit
   * asks which road its own arc is on, and the answer is the most recent move
   * that arc is past.
   */
  moves: PointsMove[];
  /**
   * The route lever: the driver is calling for the diverging route.
   *
   * It *stands* until it is put back. Taking a set of points does not clear it,
   * and that is what makes a four-road station usable — one press walks the
   * train out through the throat crossover, up the ladder and into the far
   * platform loop, which as a single-shot call would have meant three keypresses
   * inside 150 m at 65 km/h. The consequence is that a call left set out on the
   * plain line crosses the train over at every crossover it meets, which is why
   * the indicator holds it in amber for as long as it is set.
   */
  armed: boolean;
}

/**
 * How many moves to remember.
 *
 * Only the ones the train is still standing on matter, and the longest possible
 * rake is under 250 m while the pointwork is hundreds of metres apart — so two
 * would very nearly do. Six is cheap and leaves room for the station throat,
 * where three turnouts fall inside 150 m.
 */
const MEMORY = 6;
/** How far back a remembered move can still be under the train: the longest rake and then some. */
const MOVE_REACH = 400;

export const createPointsState = (road = UP): PointsState => ({
  base: road, moves: [], armed: false,
});

/**
 * The player's train's points, shared at module level.
 *
 * The rail cameras and the HUD both need to know which road the train is on,
 * and the cameras need it at arcs other than the train's own — a lineside shot
 * has to stand beside the road the train will actually be on when it arrives.
 * Passing the state down two component trees to reach them would be a prop
 * threaded through everything in between; this is the same bargain
 * `settingsSnapshot` and `SELECTED` already make. `TrainRide` owns it and is
 * the only writer.
 */
export const livePoints: PointsState = createPointsState();

/**
 * The player's train out on the junction branch's route, in route metres from
 * the toe (`BRANCH_ROUTE`) — for things along that route that are not the
 * running line's, like the Skylark line's level crossings. `TrainRide` is the
 * only writer; `active` is false whenever the train is not on a branch road.
 */
export const livePlayerRoute = { active: false, head: 0, dir: 1 as 1 | -1, length: 0, speed: 0 };

export function resetPoints(state: PointsState, road = UP) {
  state.base = road;
  state.moves.length = 0;
  state.armed = false;
}

/** Which road arc `a` is on. */
export function roadAt(state: PointsState, a: number): number {
  let best: PointsMove | null = null;
  let bestPast = Infinity;
  for (const move of state.moves) {
    // How far past the turnout this arc is, in the direction the train went
    // through it. Negative means the arc is on the near side, so the move has
    // not happened as far as this part of the train is concerned.
    // Measured along the road the move went onto: that is where an arc past
    // it would be, and a branch can be longer than half the loop.
    const to = roadOf(move.to);
    const past = along(to, move.arc, a) * move.way;
    if (!to.through && roadS(to, a) > to.length) continue;
    if (past > 0 && past < bestPast) { bestPast = past; best = move; }
  }
  if (best) return best.to;
  // Behind everything remembered: the road the earliest move came off.
  return state.moves.length ? state.moves[0].from : state.base;
}

/** Metres left of the running line at arc `a`, following the roads taken. */
export function lateralAt(state: PointsState, a: number): number {
  return roadOf(roadAt(state, a)).offset(a);
}

/** Metres above the running line's rail head at arc `a`, following the roads taken. */
export function liftAt(state: PointsState, a: number): number {
  return roadOf(roadAt(state, a)).rise?.(a) ?? 0;
}

/**
 * Where the train's road is at arc `a` — rail-head point less `RAIL_HEAD_LIFT`,
 * and its left normal — whichever road that is. The one question everything
 * that places the player's train (bogies, cameras) should ask, because a road
 * with its own `place` is not an offset from the running line at all.
 */
export function railPlaceAt(state: PointsState, a: number): RailPlace {
  const road = roadOf(roadAt(state, a));
  if (road.place) return road.place(a);
  const s = trainWrap(a);
  const [x, y, z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  const off = road.offset(s);
  return { x: x + nx * off, y: y + (road.rise?.(s) ?? 0), z: z + nz * off, nx, nz };
}

/** Just the position, for `locomotivePose`'s bogies. */
export function railPointOf(state: PointsState, a: number): [number, number, number] {
  const p = railPlaceAt(state, a);
  return [p.x, p.y, p.z];
}

/** The line speed at arc `a` on whatever road the train is on there, m/s. */
export function railLimitAt(state: PointsState, a: number): number {
  const road = roadOf(roadAt(state, a));
  return road.limitAt ? road.limitAt(a) : trainSpeedLimitAt(a);
}

/**
 * Is arc `a` on a viaduct out on the branch — the branch's own, which now
 * carries the line right over what was the Skylark east bridge — as against
 * the Skylark line's ground or the trunk? `undefined` on the running line,
 * whose own structure table answers that.
 */
export function railBranchDeckAt(state: PointsState, a: number): boolean | undefined {
  const road = roadOf(roadAt(state, a));
  if (!road.place) return undefined;
  // The airport island's station and yard are all on the ground.
  if (road.sub) return false;
  const b = road.routeB ? road.routeB(a) : roadS(road, a);
  const R = BRANCH_ROUTE;
  return b <= R.branch + (SKYLARK_MARKS.pierEnd - SKYLARK_MARKS.eastShore)
    // The airport branch, and the trunk's own viaduct north of its landfall.
    || b >= R.length - R.airport - TRUNK_LANDFALL;
}

/**
 * Is arc `a` away from the running line — out on the branch, where the
 * running line's tunnels, streets and structures at that arc mean nothing?
 */
export function railOffLineAt(state: PointsState, a: number): boolean {
  const road = roadOf(roadAt(state, a));
  return !!road.place && roadS(road, a) > 0;
}

/**
 * The train, as the stretch of arc it stands on.
 *
 * The pointwork needs this and not just a position, because which end of a
 * train is its *front* depends on which way it is going. Everything else about
 * the rake is derived from the leading locomotive's centre (`unitPose`), so
 * that is the reference here too, with the reach either side of it measured
 * once from the formation.
 */
export interface Rake {
  /** Arc of the leading locomotive's centre — the arc `TrainRide` integrates. */
  arc: number;
  /** Metres of train in front of `arc`, and metres of it behind. */
  front: number;
  back: number;
}

/**
 * The end that reaches the points first, travelling `way`.
 *
 * This is the whole of the reverse fix. A set of points is taken by the
 * *leading wheels* — the blades are where the route is decided, and what
 * decides it is whatever arrives at them first. Running forward that is the
 * locomotive's nose; propelling, it is the tail of the last coach, which on a
 * six-coach rake is 150 m away at the other end of the train.
 *
 * Working the points from the locomotive's own arc regardless of direction, as
 * this did, means that when propelling the whole rake passes over the turnout
 * before the route changes: measured on the station's east throat the switch
 * was worked 26.8 m late even with a two-unit rake, and because `roadAt` gives
 * every arc already beyond the turnout the new road at once, the coaches that
 * had run past it snapped sideways — 1.0 m at the loop 1 turnout, 1.6 m at
 * loop 2 — in a single frame. That is the juddering, and it is also why a
 * reverse shunt into a platform did not work: the train was on the loop's
 * offset while its wheels were still on the down line and vice versa.
 */
export function leadEnd(rake: Rake, way: 1 | -1): number {
  return trainWrap(rake.arc + (way > 0 ? rake.front : -rake.back));
}

/**
 * Forgets the pointwork the whole train has run through.
 *
 * `roadAt` measures past a move with the loop's shortest-way distance, which
 * turns negative half a loop on: a train that came off the branch onto the up
 * line and ran 3.3 km along it read, from then on, as being back on the branch
 * — and was put there, 2.7 km away. Once the rear is past a set of points no
 * part of the train can be on the road it came off, so that move and everything
 * before it are settled: its road becomes the base and the history goes.
 */
export function settlePoints(state: PointsState, rake: Rake, way: 1 | -1): void {
  const tail = leadEnd(rake, way > 0 ? -1 : 1);
  for (let i = state.moves.length - 1; i >= 0; i--) {
    const m = state.moves[i];
    const past = along(roadOf(m.to), m.arc, tail) * m.way;
    if (past > 0 && roadAt(state, tail) === m.to) {
      state.base = m.to;
      state.moves.splice(0, i + 1);
      return;
    }
  }
}

/**
 * The last hand-over the route made: by how much it moved the train's arc, and
 * a count, so anything holding an arc of its own (a planted camera shot) can
 * move it too. `routeHandover` is the only writer.
 */
export const liveRouteShift = { seq: 0, by: 0 };

/** How far into the loop the whole train must be, from either end, to be handed over. */
const HANDOVER_MARGIN = 400;

/**
 * The loop's one seam, and it is in the middle of nowhere on purpose.
 *
 * A road's position is counted in arc from where it starts, and the train
 * integrates one arc for the whole rake — so a road can only meet the running
 * line at the arc its own count says it is at. The loop meets it at two toes,
 * 1.8 km apart on the running line and 5 km apart along the loop, and no one
 * count can be right at both. Hence the two views of each road
 * (`ROUTE_VIEWS`): the Skylark view is right at the Skylark toe, the airport
 * view at the airport toe, and they differ by a constant.
 *
 * Out in the middle of the loop, where the whole rake is on it and neither toe
 * is anywhere near, the train is moved onto the view whose toe it is heading
 * for: its arc shifts by that constant, every unit's road changes to the
 * other view, and every unit's place — which both views compute from the same
 * `b` — does not change at all. Returns the shift to add to the train's arc,
 * or 0 when there is nothing to do.
 */
export function routeHandover(state: PointsState, rake: Rake, way: 1 | -1): number {
  const head = leadEnd(rake, way);
  const tail = leadEnd(rake, way > 0 ? -1 : 1);
  const id = roadAt(state, head);
  if (roadAt(state, tail) !== id) return 0;
  const view = ROUTE_VIEWS.find((v) => v.skylark === id || v.airport === id);
  if (!view) return 0;
  // `b` grows up the arc on both views, so up the arc is towards the airport toe.
  const want = way > 0 ? view.airport : view.skylark;
  if (want === id) return 0;
  const road = roadOf(id);
  const bh = roadS(road, head);
  const bt = roadS(road, tail);
  if (Math.min(bh, bt) < HANDOVER_MARGIN || Math.max(bh, bt) > BRANCH_ROUTE.length - HANDOVER_MARGIN) return 0;
  const shift = roadOf(want).from - road.from;
  state.base = want;
  state.moves.length = 0;
  liveRouteShift.by = shift;
  liveRouteShift.seq++;
  return shift;
}

/**
 * Approach locking: points cannot be moved in front of a train that is on them.
 *
 * The real rule, and the reason the lever is *refused* rather than ignored.
 * Once the leading wheels are within the switch the blades are held by the
 * train running over them, so a lever pulled then changes nothing — and a
 * driver who presses the key and sees the indication stay put concludes the key
 * is broken, which is the complaint this answers.
 *
 * `moving` is the other half of the real rule and the reason this is not simply
 * a distance test. Approach locking applies to a train *approaching*; a train
 * standing short of the blades is not, and the road in front of it may be
 * changed freely. Without that, a driver who had stopped clear of the points
 * intending to reverse would be locked out by the points ahead of the end they
 * were about to leave — which is precisely the shunt this whole change exists
 * to make possible.
 *
 * Only the *next* set of points can be locked. Ones the train is already
 * straddling have been taken; the entry is in `PointsState.moves` and no lever
 * undoes it, which is correct — you do not get to change your mind about a
 * route you are standing on.
 */
export function leverLocked(
  state: PointsState, rake: Rake, way: 1 | -1, moving: boolean,
): boolean {
  if (!moving) return false;
  const lead = leadEnd(rake, way);
  const next = pointsAhead(roadAt(state, lead), lead, way);
  return !!next && next.distance <= POINTS.foul;
}

/**
 * How close to a running line counts as being on it.
 *
 * The whole purpose of a loop is that a train standing in it is *clear* of the
 * line it came off, so "which track is this train on" cannot be answered by
 * picking the nearer one — that would have a train parked at a platform still
 * occupying the down line, and everything else on the road held outside the
 * station waiting for it to move.
 *
 * 2.5 m is a shade over half the 6 m the closest pair of roads are apart
 * (`PAIR_GAP`), so a road that has opened out to its own centres reads as
 * clear while one still inside the switch reads as fouling — which is what
 * fouling means.
 */
const FOUL = 2.5;

/**
 * Which running line the train at `arc` occupies: 0 for the up, 1 for the
 * down, and **-1 when it is on neither** — in a loop, clear of both.
 *
 * Derived from the offset rather than from a table of roads, so it needs no
 * maintenance when a road is added: a crossover half way across counts as
 * fouling whichever line it is nearer, a loop counts as nothing, and the
 * relief loop is clear of the up line for exactly as long as its own geometry
 * says it is.
 */
export function occupiedTrack(state: PointsState, arc: number): 0 | 1 | -1 {
  // Out on the loop the offset is from the loop's own road, and the running
  // line at this arc is somewhere else entirely.
  if (roadOf(roadAt(state, arc)).onLoop?.(arc)) return -1;
  const off = lateralAt(state, arc);
  if (Math.abs(off) < FOUL) return 0;
  if (Math.abs(off - secondTrackGap(arc)) < FOUL) return 1;
  return -1;
}

export interface PointsAhead {
  turnout: Turnout;
  /** The road the diverging route leads to. */
  other: number;
  /** Metres to the points. */
  distance: number;
  /** The current road ends here: the train takes this whether it is armed or not. */
  compulsory: boolean;
  /**
   * Which way the diverging route turns, from the driver's seat: -1 left,
   * +1 right, 0 when the two roads do not separate at all.
   *
   * A driver cannot see this from the cab. Two roads that are about to be
   * hundreds of metres apart are, at the blades, the same piece of track — that
   * is the whole basis of `Road.offset` — so the view through the windscreen at
   * the moment the decision matters is of one railway, not two. Which is why
   * the indication has to come from the geometry rather than the picture.
   */
  hand: -1 | 0 | 1;
}

/** Below this the two roads are the same track and there is no hand to report. */
const HAND_EPS = 0.02;

/**
 * Which way `to` turns away from `from` at arc `at`, from the driver's seat.
 *
 * `Road.offset` is metres *left of the running line*, and the running line is
 * measured along increasing arc — so the sign is a fact about the railway, not
 * about the train, and a train running the other way has the line's left on its
 * right. Getting that backwards would put the arrow on the wrong side for every
 * reverse move, which is exactly the half of the pointwork that is hardest to
 * check by eye.
 */
function handOf(from: Road, to: Road, at: number, way: 1 | -1): -1 | 0 | 1 {
  const spread = to.offset(at) - from.offset(at);
  if (Math.abs(spread) < HAND_EPS) return 0;
  const left = spread > 0;
  return (left === (way > 0) ? -1 : 1);
}

/**
 * The next set of points the train can use, travelling `way` from `arc` on
 * `road`.
 *
 * "Can use" is the whole of the logic. A turnout is only a choice if the road
 * being left is laid up to it and the road being joined carries on *beyond* it
 * in the direction of travel — which is what makes a facing point a decision
 * and a trailing point merely a join. The exception is a road that ends: a
 * crossover's far end and a loop line's exit are not choices, they are the only
 * way out, and the train takes them whether the driver asked or not.
 */
export function pointsAhead(road: number, arc: number, way: 1 | -1): PointsAhead | null {
  const here = roadOf(road);
  let best: PointsAhead | null = null;
  for (const turnout of TURNOUTS) {
    const other = turnout.a === road ? turnout.b : turnout.b === road ? turnout.a : -1;
    if (other < 0) continue;
    const distance = along(here, arc, turnout.arc) * way;
    if (distance <= 0) continue;
    if (best && distance >= best.distance) continue;
    // A step beyond the points, the way the train is going.
    const beyond = trainWrap(turnout.arc + way * PROBE);
    if (!roadExistsAt(roadOf(other), beyond)) continue;
    best = {
      turnout,
      other,
      distance,
      compulsory: !roadExistsAt(here, beyond),
      // Read a probe's length past the blades, because *at* them the two roads
      // are by construction the same offset and the spread is zero.
      hand: handOf(here, roadOf(other), beyond, way),
    };
  }
  return best;
}

/**
 * Runs the points as the train's leading end moves from `previous` to `arc`.
 *
 * Both arcs are the **leading end** in the direction of travel — `leadEnd`, not
 * the locomotive's own arc. The distinction is invisible running forward, where
 * the two differ by half a locomotive, and is the whole behaviour propelling,
 * where they are a train length apart and using the wrong one works the switch
 * after the entire rake has run over it. See `leadEnd`.
 *
 * Called from the physics step, so it does no allocation in the common case and
 * simply returns when nothing was crossed.
 */
export function stepPoints(
  state: PointsState, previous: number, arc: number, way: 1 | -1,
): void {
  if (previous === arc) return;
  // The road the leading end was ON, at `previous` — not the one `arc` reads
  // as. A road that ends is over by `arc`: one step past a crossover's far end
  // `roadAt` already falls back to the road the crossover was entered from,
  // so asking there found no turnout to cross, the compulsory move onto the
  // other line never happened, and the train snapped 4.6 m back onto the line
  // it had just left.
  const road = roadAt(state, previous);
  const here = roadOf(road);
  for (const turnout of TURNOUTS) {
    const other = turnout.a === road ? turnout.b : turnout.b === road ? turnout.a : -1;
    if (other < 0) continue;
    // Crossed this step: in front of the train before, behind it now.
    const was = along(here, turnout.arc, previous) * way;
    const now = along(here, turnout.arc, arc) * way;
    if (was > 0 || now <= 0) continue;
    const beyond = trainWrap(turnout.arc + way * PROBE);
    if (!roadExistsAt(roadOf(other), beyond)) continue;
    const compulsory = !roadExistsAt(here, beyond);
    if (!compulsory && !state.armed) continue;
    // Onto or off a road that leaves the running line, what is remembered from
    // before counts only where the train can still be standing on it — within
    // a train's length of these points. Out there a road's arc is its own
    // count, which comes round to arcs the running line used long ago; a
    // crossover taken there 4 km back read as the road under the train.
    if (roadOf(other).place || here.place) {
      for (let i = state.moves.length - 1; i >= 0; i--) {
        if (Math.abs(ahead(state.moves[i].arc, turnout.arc)) > MOVE_REACH) {
          state.base = state.moves[i].to;
          state.moves.splice(0, i + 1);
          break;
        }
      }
    }
    state.moves.push({ arc: turnout.arc, way, from: road, to: other });
    if (state.moves.length > MEMORY) {
      const dropped = state.moves.shift();
      if (dropped) state.base = dropped.from;
    }
    return;
  }
}

/**
 * The ceiling the pointwork imposes here, m/s, or `Infinity` where nothing
 * binds.
 *
 * Only where the train is actually going to diverge — a set of points taken
 * straight through is no restriction at all, which is why this reads the route
 * lever rather than the geometry. Being on a connecting track counts: the middle
 * of a crossover is not the place to discover the limit.
 *
 * Relaxed by what the brake can shed on the way there, exactly as the line's
 * own restrictions are (`limitAhead` in `TrainRide`). Without that, a standing
 * call for a diverging route would hold the train to 65 km/h for the whole
 * kilometre before the points instead of making it brake for them — the call is
 * meant to survive being set early, which is the whole point of it standing.
 */
export function pointsCeiling(
  state: PointsState, arc: number, way: 1 | -1, brake: number,
): number {
  const here = roadOf(roadAt(state, arc));
  let own = Infinity;
  if (!here.through) {
    // A dead end brakes the train onto a stand short of the stop: the same
    // braking curve the line's own restrictions use, run down to zero.
    const stop = bufferAhead(here, arc, way);
    const limit = here.limitAt ? here.limitAt(arc) : here.limit;
    own = Number.isFinite(stop)
      ? Math.min(limit, Math.sqrt(2 * brake * Math.max(0, stop)))
      : limit;
    // The loop's mains are not through roads either, and they have facing
    // points of their own (the airport station, its crossover, its yard), so
    // a road that is not a dead end still has to look at what is ahead of it.
    // A connecting road does too: a station loop's far end is compulsory, and
    // the road it rejoins may be slower than the loop.
  }
  const next = pointsAhead(here.id, arc, way);
  if (!next || (!state.armed && !next.compulsory)) return own;
  const limit = roadOf(next.other).limit;
  if (!Number.isFinite(limit)) return own;
  // v² = limit² + 2·b·d: the speed from which the brake arrives at the points
  // at exactly the limit. It was `limit + √(2bd)`, which is faster than that
  // everywhere and falls faster than the brake can follow, so a train riding
  // it overshot and reached the blades well over their limit.
  return Math.min(own, Math.sqrt(limit * limit + 2 * brake * Math.max(0, next.distance)));
}

/**
 * Metres from the leading end at `arc` to where it must stand short of the
 * buffer stop, travelling `way` along `road` — negative once past it, and
 * `Infinity` when the road has no stop or the train is running away from it.
 *
 * Measured to `JUNCTION.stand` short of the stop's face, so a train brought to
 * a stand by `pointsCeiling` is a couple of metres off the buffers, and one
 * that is caught by the hard stop in `TrainRide` is put back to exactly there.
 */
export function bufferAhead(road: Road, arc: number, way: 1 | -1): number {
  if (!road.buffer || road.buffer !== way) return Infinity;
  const end = road.buffer > 0 ? road.length : 0;
  return (end - roadS(road, arc)) * way - JUNCTION.stand;
}

/* ------------------------------------------------------- the signalling's end */

/**
 * Where a train is for the block working: in the running line's arc, in the
 * loop's own metres, or — within `window` of a junction — in both.
 *
 * The loop and the running line are two railways as far as distances go, and
 * the block works on distances; but they meet at two toes, and a train about
 * to cross from one to the other has to be seen by the trains on the one it is
 * joining. Near a toe the two agree anyway: each view of a loop main is laid so
 * its arc IS the running line's at its own toe (`ROUTE_VIEWS`). So a train on
 * the loop running in to a toe is, for the running line, a train that many
 * metres short of the toe on the line it will join — which is what makes it
 * wait for a gap rather than drive into the side of a train going past — and a
 * train on the running line that is going to take the branch is, for the loop,
 * a train that far short of the loop's end.
 *
 * `diverting` is whether the next set of points will be taken: a train running
 * straight past a toe is none of the loop's business.
 */
export interface SpaceReport { line: 'main' | 'loop'; arc: number; track: 0 | 1 }

const viewOf = (id: number) => ROUTE_VIEWS.find((v) => v.skylark === id || v.airport === id);
/** The loop's metres at a view's own toe: 0 at Skylark, the far end at the airport. */
const toeB = (view: { skylark: number }, id: number) => (id === view.skylark ? 0 : BRANCH_ROUTE.length);

export function trainSpaces(
  state: PointsState, rake: Rake, way: 1 | -1, diverting: boolean, window: number,
): SpaceReport[] {
  const out: SpaceReport[] = [];
  const head = leadEnd(rake, way);
  const road = roadOf(roadAt(state, head));
  const view = viewOf(road.id);
  if (view) {
    const b = roadS(road, head);
    out.push({ line: 'loop', arc: b, track: view.track });
    if (Math.abs(b - toeB(view, road.id)) < window) out.push({ line: 'main', arc: head, track: view.track });
    return out;
  }
  if (road.sub) {
    // Off the mains — in a station loop or the yard — it is on neither main,
    // unless it is fouling one on the way on or off.
    const off = road.offset(head);
    const track = Math.abs(off) < FOUL ? 0 : Math.abs(off - JUNCTION.gap) < FOUL ? 1 : -1;
    if (track !== -1 && road.routeB) out.push({ line: 'loop', arc: road.routeB(head), track });
    return out;
  }
  const track = occupiedTrack(state, head);
  if (track !== -1) out.push({ line: 'main', arc: head, track });
  // Coming off the loop: nose on the running line, rake still on the branch.
  // `roadS` runs on past the road's end, so the rear's road gives the metres
  // the nose would be at had the loop gone on.
  const tail = roadOf(roadAt(state, leadEnd(rake, way > 0 ? -1 : 1)));
  const behind = viewOf(tail.id);
  if (behind) {
    out.push({ line: 'loop', arc: roadS(tail, head), track: behind.track });
  } else if (diverting) {
    const next = pointsAhead(road.id, head, way);
    const into = next ? viewOf(next.other) : undefined;
    if (next && into && next.distance < window) {
      out.push({ line: 'loop', arc: toeB(into, next.other) - way * next.distance, track: into.track });
    }
  }
  return out;
}

/** Is this one of the junctions' toes — where a train leaves the running line for the loop? */
export function isJunctionTurnout(turnout: Turnout): boolean {
  return !!viewOf(turnout.b) && (turnout.a === UP || turnout.a === DOWN);
}

/* ---------------------------------------------------------------- the diamonds */

/**
 * The two diamonds, one at each junction: where the branch's inner road —
 * off the up line — crosses the down line flat. The running-line arc of the
 * crossing, and which view of the loop is laid through it.
 *
 * A diamond is not a turnout (see `Turnout`) and nothing about the roads stops
 * two trains using it at once, so it is interlocked instead: a train whose road
 * runs over it claims it before it gets there, and a down train stops for the
 * claim as it would for a train on its road. See `diamondAhead`.
 */
export const DIAMONDS = JUNCTIONS.map((j, k) => {
  let lo = 0;
  let hi = CURVE_REACH;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (j.offsetRaw(mid, 0) < j.spec.gap) lo = mid; else hi = mid;
  }
  return { arc: j.lineArc((lo + hi) / 2), view: (k === 0 ? 'skylark' : 'airport') as 'skylark' | 'airport' };
});

/**
 * The diamond this train's road takes it over next, and how far off it is,
 * leading end to the crossing — or null. Only a train on the inner road, or on
 * the up line about to take it (`diverting`), goes over one; and only while
 * some of the train has still to clear it.
 */
export function diamondAhead(
  state: PointsState, rake: Rake, way: 1 | -1, diverting: boolean, reach: number,
): { arc: number; distance: number } | null {
  const head = leadEnd(rake, way);
  const tail = leadEnd(rake, way > 0 ? -1 : 1);
  for (const d of DIAMONDS) {
    const inner = ROUTE_VIEWS[0]?.[d.view];
    if (inner === undefined) continue;
    const toHead = ahead(head, d.arc) * way;
    const toTail = ahead(tail, d.arc) * way;
    if (toTail < 0 || toHead > reach) continue;
    const headRoad = roadAt(state, head);
    let over = headRoad === inner || roadAt(state, tail) === inner || roadAt(state, d.arc) === inner;
    if (!over && diverting && headRoad === UP) {
      const next = pointsAhead(UP, head, way);
      over = !!next && next.other === inner;
    }
    if (over) return { arc: d.arc, distance: toHead };
  }
  return null;
}
