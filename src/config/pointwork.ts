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
  TRAIN_LENGTH, TRAIN_POINTS, trainTangentAt, trainWrap,
} from './trainConfig';
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
    const past = ahead(move.arc, a) * move.way;
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
    const distance = ahead(arc, turnout.arc) * way;
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
  const road = roadAt(state, arc);
  const here = roadOf(road);
  for (const turnout of TURNOUTS) {
    const other = turnout.a === road ? turnout.b : turnout.b === road ? turnout.a : -1;
    if (other < 0) continue;
    // Crossed this step: in front of the train before, behind it now.
    const was = ahead(turnout.arc, previous) * way;
    const now = ahead(turnout.arc, arc) * way;
    if (was > 0 || now <= 0) continue;
    const beyond = trainWrap(turnout.arc + way * PROBE);
    if (!roadExistsAt(roadOf(other), beyond)) continue;
    const compulsory = !roadExistsAt(here, beyond);
    if (!compulsory && !state.armed) continue;
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
  if (!here.through) return here.limit;
  if (!state.armed) return Infinity;
  const next = pointsAhead(here.id, arc, way);
  if (!next) return Infinity;
  const limit = roadOf(next.other).limit;
  if (!Number.isFinite(limit)) return Infinity;
  return limit + Math.sqrt(2 * brake * Math.max(0, next.distance));
}
