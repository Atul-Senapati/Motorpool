/**
 * The island station: four roads, two platforms, and a transplanted town.
 *
 * The main line already crosses the larger of the two made islands
 * (`TRAIN_ISLANDS`) in a 600 m dead-straight, dead-level run on ballast — the
 * only stretch of the whole 9 km loop that is straight, flat and on land at the
 * same time. A station wants exactly that, so the site is not chosen here: it
 * is *found*, by asking where the line is inside the island. If the route is
 * regenerated and the crossing moves, the station moves with it.
 *
 * Everything below is measured from the running line rather than stated in
 * world coordinates, for the same reason: `u` is metres to the left of travel
 * (the sign `trainNormalAt` uses), `s` is arc length along the loop, and the
 * whole complex is laid out in that frame. Nothing in this file knows where the
 * island is.
 *
 * ## Why the throat is drawn but not detailed
 *
 * The extra roads converge on the down line at both ends as a ladder, and the
 * train can run from one to the other there — see `pointwork`, which puts a
 * turnout at each merge and lets the driver choose the road. What the throat
 * does *not* have is a frog or check rails: a working turnout is a fortnight
 * of geometry on its own, it is only ever seen from a cab at 150 km/h, and
 * what reads as a station throat at that speed is the *convergence* — four
 * roads becoming one. It does have blades, because without them it had a hole:
 * see `bladeGap` below and `switchBlade.ts`.
 */
import {
  BALLAST, RAIL_HEAD_LIFT, TRAIN, TRAIN_ISLANDS, TRAIN_LENGTH, TRAIN_POINTS, TUNNEL,
  trainNormalAt, trainPointAt, trainTangentAt, trainWrap,
} from './trainConfig';

/* ------------------------------------------------------------------- the site */

/** Signed area of a closed XZ outline, for picking the larger island. */
const area = (outline: ReadonlyArray<readonly [number, number]>) => Math.abs(
  outline.reduce((sum, [x, z], i) => {
    const [nx, nz] = outline[(i + 1) % outline.length];
    return sum + (x * nz - nx * z);
  }, 0) / 2,
);

/** Even-odd point-in-polygon. */
const inside = (
  outline: ReadonlyArray<readonly [number, number]>, x: number, z: number,
) => {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, zi] = outline[i];
    const [xj, zj] = outline[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

/**
 * The bigger island, which is where the station goes.
 *
 * "Bigger" by area, not by name: the two islands exist to break up a 2.4 km
 * span and their shapes are traced from a sketch, so which one is larger is a
 * property of the drawing rather than something to hard-code.
 */
const HOST = TRAIN_ISLANDS.length
  ? [...TRAIN_ISLANDS].sort((a, b) => area(b.outline) - area(a.outline))[0]
  : null;

/** Arc-length step used to find the crossing. Fine enough for a 600 m run. */
const PROBE = 4;

/**
 * The longest run of arc length that lies inside the host island.
 *
 * Walked as a ring so a crossing that straddles the arc-length origin is still
 * found as one run rather than as two — the origin is wherever the route
 * generator happened to start, and nothing should depend on it.
 */
const crossing = (() => {
  if (!HOST) return null;
  const steps = Math.floor(TRAIN_LENGTH / PROBE);
  const on: boolean[] = [];
  for (let i = 0; i < steps; i++) {
    const [x, , z] = trainPointAt(i * PROBE);
    on.push(inside(HOST.outline, x, z));
  }
  let best: { from: number; length: number } | null = null;
  let start = -1;
  let run = 0;
  // Two laps of the ring: the second lap lets a run that wraps close.
  for (let k = 0; k < steps * 2; k++) {
    if (on[k % steps]) {
      if (run === 0) start = k;
      run++;
      if (!best || run > best.length) best = { from: start, length: run };
    } else {
      run = 0;
    }
    if (k >= steps && run === 0) break;
  }
  if (!best || best.length < 4) return null;
  return {
    centre: ((best.from + best.length / 2) * PROBE) % TRAIN_LENGTH,
    length: best.length * PROBE,
  };
})();

/**
 * How far the line is still on BALLAST either side of the station's midpoint.
 *
 * Not the same as the crossing, and the difference is what a turnout lead has
 * to be clamped to. The crossing is how much of the line is inside the island's
 * outline — 684 m — but the outer 30 m at each end is the viaduct's approach,
 * already up on a deck. A lead measured against the crossing put the outer
 * loop's turnout 26 m out over the viaduct, which would have laid ballast and a
 * loop on a bridge.
 */
const ballastRoom = (() => {
  if (!crossing || !TRAIN_POINTS.length) return 0;
  const n = TRAIN_POINTS.length;
  const step = TRAIN_LENGTH / n;
  const at = (d: number) => TRAIN_POINTS[
    ((Math.round((crossing.centre + d) / step) % n) + n) % n
  ];
  const walk = (sign: 1 | -1) => {
    let d = 0;
    while (d < TRAIN_LENGTH / 4 && at(sign * d).structure === BALLAST) d += step;
    return d;
  };
  return Math.min(walk(1), walk(-1));
})();

/* -------------------------------------------------------- the cross section */

/**
 * Platform height above the rail head, and how far its edge stands off the
 * track centre. Both are the real figures: a UK main-line platform is 915 mm
 * over the rail and 1.7 m from the centre of the road it serves.
 */
const PLATFORM_RISE = 0.915;
const PLATFORM_SETBACK = 1.7;
/** Two roads either side of one platform therefore stand this far apart. */
const ISLAND_PLATFORM_WIDTH = 9;
const PLATFORM_PITCH = PLATFORM_SETBACK * 2 + ISLAND_PLATFORM_WIDTH;
/**
 * The middle pair share a formation with no platform between them. 6 m rather
 * than the 4.5 m of real paired track: the ballast trapezium is 4.6 m across
 * its crown, and at 4.5 m centres the two formations interpenetrate, which
 * reads as one wide grey smear instead of two roads.
 */
const PAIR_GAP = 6;

/**
 * The four roads, as offsets left of the running line.
 *
 * Road 1 *is* the running line, so it is at zero and is not built here — it
 * already exists, with its own ballast, sleepers and rails, and moving it
 * would move the railway. Everything else is built outward from it on the
 * left, which is the side of this island with 131 m of land rather than 97.
 */
export const ROADS = [0, PLATFORM_PITCH, PLATFORM_PITCH + PAIR_GAP,
  PLATFORM_PITCH * 2 + PAIR_GAP] as const;

/**
 * The two island platforms, each between a pair of roads.
 *
 * Platform A takes the running line on its right-hand face, so a service that
 * does not stop still passes a platform, and B takes the outer pair. Every one
 * of the four roads therefore has a face, which is the point of an island
 * platform and the reason four roads need only two of them.
 */
export const PLATFORMS = [
  { from: ROADS[0] + PLATFORM_SETBACK, to: ROADS[1] - PLATFORM_SETBACK },
  { from: ROADS[2] + PLATFORM_SETBACK, to: ROADS[3] - PLATFORM_SETBACK },
] as const;

export const STATION = {
  /** Rail height over the formation, shared with the running line. */
  railLift: RAIL_HEAD_LIFT,
  platformRise: PLATFORM_RISE,
  /** Coping: the lighter edging strip, and how far it is inset. */
  copingWidth: 0.75,
  copingRise: 0.02,
  /**
   * Platform length. Four coaches and a locomotive is about 100 m; 170 m is a
   * main-line platform and, more to the point, it is long enough that the eye
   * reads it as infrastructure rather than as a halt.
   */
  platformLength: 170,
  /** The ramp down off each platform end, at about 1 in 8. */
  rampLength: 7.5,
  /** Canopy: how high over the platform, how far it oversails, and its columns. */
  canopyHeight: 4.4,
  canopyHalfWidth: 3.4,
  canopyThickness: 0.28,
  columnSpacing: 13,
  columnHalf: 0.16,
  /**
   * How far the extra roads run past each platform end, and how long the taper
   * back toward the running line is.
   *
   * The taper does the whole of the lateral shift — 30.8 m on the outermost
   * road — so at 130 m it works out at an equivalent radius of about 550 m,
   * which is a plausible turnout lead and, more importantly, is gentle enough
   * that the rails do not visibly kink where the taper meets the straight.
   */
  approach: 22,
  taper: 130,
  /**
   * How long each loop's turnout lead is, in metres from the end of the flat.
   *
   * Both loops come off the *down line* — neither trails into the other — and
   * the outer one leaves further out and takes longer about it, which is what
   * keeps the two from crossing (see `roadOffset` for the algebra). The lengths
   * are set by the gradient each road can afford rather than as a multiple of
   * the platform taper: the outer road has 26.2 m to lose and 225 m to do it
   * in, which is a steady 1 in 7.7; the inner has 13.8 m over 175, or 1 in 11.
   *
   * A ladder — road 3 trailing into road 2 — was tried twice and is worse both
   * ways round. Short (62 % of the taper) the outer road had to lose 23 m in
   * 91 m, the sharpest thing in the station. Long, its gradient is its own plus
   * road 2's plus the down line's, all peaking in the same 80 m, which came out
   * at 1 in 4.6. Two staggered turnouts on the down line are gentler than
   * either and just as connected.
   */
  loopLead: {
    inner: 175,
    outer: 225,
    /**
     * The relief loop's, on the up line — shorter than either, and shorter on
     * purpose rather than for room.
     *
     * At the inner figure its turnouts landed on 416 and 980, which are exactly
     * where loop 1's are on the down line: four sets of blades on one transverse
     * line, two of them a track's width apart facing opposite ways. Nothing
     * breaks — they connect different roads and `pointsAhead` never confuses
     * them — but a throat reads as a sequence of decisions, and a real one
     * staggers its points for the same reason. 150 puts them 25 m clear.
     */
    relief: 150,
  },
  /** How far short of the end of the ballast the outermost turnout stops. */
  yardMargin: 10,
  /**
   * How close a diverging road's rails come to the ones they are joining
   * before they are drawn as switch blades rather than as plain rail.
   *
   * Both roads' offsets are *equal* at the merge, which is what makes the train
   * able to run from one to the other without a step — and it also means the
   * last stretch of rail is laid in the same place as the rail it is joining.
   * Two rails within a few centimetres of each other draw as one smeared,
   * z-fighting rail, so that stretch has to be shaped rather than repeated.
   *
   * It used to be *dropped* instead, which was worse: a crossover is 84 m long
   * and 45.5 m of it was drawn, leaving 19.5 m of missing rail at each end, and
   * the diagonals hung in the four-foot joined to nothing. Now the road runs
   * the whole way and this last 0.6 m of separation is where it tapers into a
   * blade — see `switchBlade.ts` for the three things that happen over it.
   *
   * Measured as a separation rather than as a distance back from the merge,
   * because a smoothstep leaves the two roads *tangent* where they meet: a
   * flat four metres back still had three roads within six centimetres of each
   * other for tens of metres. 0.6 m is a little wider than the rail itself, so
   * the taper starts exactly where the rails would begin to touch.
   */
  bladeGap: 0.6,
  /**
   * The blade's section at its tip, as a fraction of the rail's own.
   *
   * A real switch rail is planed to a few millimetres. This is 12% of a 130 mm
   * rail, so 16 mm — fine enough to read as a point from a cab, wide enough not
   * to be a degenerate sliver of geometry that shades badly.
   */
  bladeTip: 0.12,
  /**
   * How far the blade tip runs below the stock rail head, metres.
   *
   * True of real pointwork, and load-bearing here: it is what guarantees the
   * blade and the rail it lies against can never share a plane, however the
   * offsets round off. 14 mm is invisible at any distance the throat is seen
   * from.
   */
  bladeDrop: 0.014,
} as const;

/**
 * What the station is called.
 *
 * Taken from the island it stands on rather than invented, so the name boards
 * agree with the map and with the route file: if the sketch is redrawn and the
 * larger island is a different one, the station is renamed with it.
 */
export const STATION_NAME = HOST ? `${HOST.name.toUpperCase()} ISLAND` : 'ISLAND';

/** Sampling pitch along a station road. The roads are straight or barely bent. */
export const STATION_STEP = 3;

/* ------------------------------------------------------------ where it sits */

/**
 * The station's own frame: one point and one direction on the running line.
 *
 * Null when there is no railway, no islands, or no crossing long enough to put
 * a station in — every consumer checks, and the station is simply not part of
 * the world in that case rather than being built somewhere arbitrary.
 */
export const STATION_SITE = (() => {
  if (!crossing) return null;
  const needed = STATION.platformLength + (STATION.approach + STATION.taper) * 2;
  // Centre the complex in the crossing and shorten the tapers if the island is
  // too short for the full layout, rather than letting the throat run out over
  // the water.
  const spare = crossing.length - needed;
  const taper = spare < 0
    ? Math.max(40, STATION.taper + spare / 2)
    : STATION.taper;
  const [x, y, z] = trainPointAt(crossing.centre);
  const [tx, tz] = trainTangentAt(crossing.centre);
  const [nx, nz] = trainNormalAt(crossing.centre);
  return {
    /** Arc length of the station's midpoint. */
    arc: crossing.centre,
    /** How much of the line is on the island at all. */
    crossing: crossing.length,
    /** …and how much of that is on ballast rather than the viaduct approach. */
    ballast: ballastRoom,
    taper,
    /** Half the length of the platform face. */
    halfPlatform: STATION.platformLength / 2,
    centre: [x, y, z] as [number, number, number],
    tangent: [tx, tz] as [number, number],
    normal: [nx, nz] as [number, number],
    /** Heading of the line here, for anything placed square to it. */
    heading: Math.atan2(tx, tz),
    /** The island being built on, for the town's height. */
    ground: HOST ? HOST.crown : 0,
  };
})();

/**
 * A point in the station's frame, in world space.
 *
 * `along` is metres from the station midpoint in the direction of travel and
 * `across` is metres to the left of the line. Everything the station draws is
 * placed with this, so the whole complex swings with the route rather than
 * being pinned to a compass direction.
 */
export function stationPoint(along: number, across: number): [number, number, number] {
  if (!STATION_SITE) return [0, 0, 0];
  const [cx, cy, cz] = STATION_SITE.centre;
  const [tx, tz] = STATION_SITE.tangent;
  const [nx, nz] = STATION_SITE.normal;
  return [cx + tx * along + nx * across, cy, cz + tz * along + nz * across];
}

/**
 * Lateral offset of one station road at `along`.
 *
 * Flat across the platforms, then eased back toward the running line over the
 * taper with a smoothstep. A smoothstep and not a straight ramp because the
 * rails are drawn as a swept section: a linear taper puts a visible corner at
 * both of its ends, where a curve of zero radius meets a straight.
 */
/**
 * The shape of a turnout lead: 0 at `t` = 0, 1 at `t` = 1, with a CONSTANT
 * gradient through the middle and a short ease at each end.
 *
 * Not a smoothstep, and the difference is the whole of why the throat used to
 * look scattered. A smoothstep's gradient peaks at 1.5x its average, so the
 * outer road's 26 m of shift over 188 m came out at **1 in 4.3** in the middle
 * — an angle no turnout has ever been built at, and what made the loops look
 * like they were slashing across the formation rather than diverging from it.
 *
 * A real turnout is a switch, a short curve, and then a STRAIGHT lead at a
 * fixed angle: its gradient is flat-topped, not a bell. So is this. For the
 * same length the peak is `shift / ((1 - ease) * L)` instead of
 * `1.5 * shift / L`, and — far more important than the number — what the eye
 * gets is a straight diagonal leg of constant angle, which is what pointwork
 * looks like.
 */
const LEAD_EASE = 0.1;
export function leadCurve(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  const area = 1 - LEAD_EASE;
  if (u < LEAD_EASE) return (u * u) / (2 * LEAD_EASE * area);
  if (u <= 1 - LEAD_EASE) return (u - LEAD_EASE / 2) / area;
  const v = 1 - u;
  return 1 - (v * v) / (2 * LEAD_EASE * area);
}

/**
 * A point on the RAILWAY at `along` from the station's midpoint, `across`
 * metres to its left — the station's frame, but curved.
 *
 * `stationPoint` projects `along` down the tangent at the midpoint, which is a
 * straight line, and the railway is only straight from about −100 eastward.
 * West of that it curves away: 15 m of drift at along −200 and **24 m at −237**,
 * which is where the inner loop's turnout is. Laid in the flat frame the loop
 * therefore closed on where the frame *said* the down line was and stopped 24 m
 * from the real one — a rail ending in the grass, which is exactly the dead end
 * it looked like.
 *
 * So the roads, the formation and the boundary fence are laid on this instead:
 * every offset is measured along the railway's own normal at its own arc, which
 * makes each road parallel to the running line by construction, everywhere.
 * The platforms stay on `stationPoint` — they are inside the straight stretch,
 * where the two agree to the centimetre, and a platform is straight anyway.
 */
export function stationRailPoint(along: number, across: number): [number, number, number] {
  const site = STATION_SITE;
  if (!site) return [0, 0, 0];
  const arc = trainWrap(site.arc + along);
  const [x, , z] = trainPointAt(arc);
  const [nx, nz] = trainNormalAt(arc);
  return [x + nx * across, site.centre[1], z + nz * across];
}

export function roadOffset(road: number, along: number): number {
  const site = STATION_SITE;
  if (!site || road === ROADS[0]) return 0;
  const flat = site.halfPlatform + STATION.approach;
  const beyond = Math.abs(along) - flat;
  if (beyond <= 0) return road;
  // The down line is not laid by the station — it is the running line's own
  // second track, and its fan through the platforms is `secondTrackGap`. It is
  // answered here so that the roads outside it have something to aim at.
  if (road === ROADS[1]) return secondTrackGap(trainWrap(site.arc + along));
  // Each road runs its OWN flat-topped ramp from its platform offset down to
  // the running gap, with a longer lead the further out it starts.
  //
  // Absolute, and not a separation from the road inside it, which is the
  // subtlety that decides how this looks. Written as a ladder — road 3 closing
  // on road 2, road 2 on the down line — every road's gradient is its own PLUS
  // its parent's, and all three peak in the same 80 m of throat: road 3 came
  // out at 1 in 4.6 even with a gentle lead of its own. Written absolutely,
  // each road's gradient is only its own, so the outer road's 26 m of shift
  // over 225 m is a steady 1 in 7.7 and the down line's 7.8 m over 130 is 1 in
  // 15 — a running line that no longer swerves.
  //
  // The ordering is still safe by construction, which is what a ladder was for:
  // with a common start and a longer lead the further out a road begins, the
  // outer road has always completed a smaller fraction of a larger shift, so
  // `R3 >= R2 >= down` holds everywhere and the rails cannot cross. It is worth
  // the two lines of algebra to see it: `R3 - R2 = 12.4 - (26.2*c3 - 13.8*c2)`
  // and `c3 <= c2`, so the bracket is at most `12.4*c2 <= 12.4`.
  const t = Math.min(1, beyond / roadTaper(road));
  return road + (TRAIN.elevated.trackGap - road) * leadCurve(t);
}

/**
 * The outermost track at `along`: the edge the station's formation reaches to.
 *
 * Safe as a plain lookup because the ladder above guarantees the ordering —
 * outer loop, inner loop, down line — at every point, so the outermost road
 * that still exists here is the outermost track.
 */
export function stationOuter(along: number): number {
  const site = STATION_SITE;
  if (!site) return 0;
  for (let i = ROADS.length - 1; i >= 1; i--) {
    if (Math.abs(along) <= roadLead(ROADS[i])) return roadOffset(ROADS[i], along);
  }
  return roadOffset(ROADS[1], along);
}

/**
 * How far from the station's midpoint one road runs before it has merged.
 *
 * This is the road's extent both topologically — the arc its turnout sits at,
 * and where `pointwork` lets a train cross — and visually: the rails run the
 * whole way here, tapering into a switch blade over the last `bladeGap` of
 * separation (`roadSeparation`, `switchBlade.ts`).
 */
export function roadLead(road: number): number {
  const site = STATION_SITE;
  if (!site || road === ROADS[0]) return 0;
  return site.halfPlatform + STATION.approach + roadTaper(road);
}

/**
 * How long one road's taper is.
 *
 * The outer road's is longer, and clamped to the room the island actually has:
 * the throat cannot run out over the water, and `STATION_SITE` has already
 * shortened the base taper if the crossing was tight. So the extra length is
 * whatever is left between the end of the inner road's taper and the end of the
 * island's crossing, up to the 1.45 it wants.
 */
function roadTaper(road: number): number {
  const site = STATION_SITE;
  if (!site) return 0;
  const flat = site.halfPlatform + STATION.approach;
  // Clamped to the BALLAST, not the crossing: past the ballast the line is on
  // the viaduct's approach, and a loop and its formation cannot go there. The
  // margin keeps the merge itself clear of the abutment.
  const room = Math.max(site.taper, site.ballast - flat - STATION.yardMargin);
  const want = road === ROADS[ROADS.length - 1] ? STATION.loopLead.outer : STATION.loopLead.inner;
  return Math.min(want, room);
}

/**
 * How far one road stands off the down line it joins, at `along`.
 *
 * What the blade taper is driven by: at `roadLead` it is zero and the two are
 * the same piece of track, and it opens out from there. It replaces a
 * `roadDrawn` that answered "where does this road stop being drawn" — nothing
 * asks that any more, because the road is drawn all the way and the last
 * stretch is a switch blade instead of a gap.
 */
export function roadSeparation(road: number, along: number): number {
  if (!STATION_SITE || road === ROADS[0]) return Infinity;
  return Math.abs(roadOffset(road, along) - roadOffset(ROADS[1], along));
}

/* ------------------------------------------ the relief loop, on the right */

/**
 * A loop off the UP line, on the other side of the running line from the
 * platforms.
 *
 * Everything else in this station is built out to the *left*, because that is
 * the side of the island with 131 m of land (see `ROADS`). The right has 97 m,
 * which is far more than one more road needs, and until now none of it carried
 * anything: the town starts at the far side of it and the running line's own
 * ballast toe is only 3.2 m out. This puts a road in that gap.
 *
 * It is a **relief loop**, not a platform road, and the distinction is the
 * reason it can exist at all. A platform road would have to be numbered, and
 * numbering a face on the far side of the up line renumbers every sign in the
 * station — the up line already has a face on platform A, and a track cannot
 * be platform 1 twice. A relief loop needs no face: it is where a slow service
 * stands to be overtaken, which is exactly what a station with four platform
 * roads and only two through lines is short of.
 *
 * `-PAIR_GAP` rather than a new number, because this is the same relationship
 * the middle pair already have — two roads sharing one formation with no
 * platform between them, at the spacing that note settled on. Its ballast toe
 * therefore lands at 9.2 m out, which is 4.8 m clear of the town's own fence
 * line at -14 and well inside `RAIL_CORRIDOR`, so nothing in the town has to
 * move for it.
 */
export const UP_LOOP = -PAIR_GAP;

/**
 * Its taper: the inner loops' lead, clamped to the same room they are.
 *
 * The inner figure and not the outer, which keeps this road's lead shorter than
 * the outermost one's — so the station's formation, which is sized from the
 * outermost road (`STATION_YARD`), already spans it and needs no lengthening.
 */
function upLoopTaper(): number {
  const site = STATION_SITE;
  if (!site) return 0;
  const flat = site.halfPlatform + STATION.approach;
  const room = Math.max(site.taper, site.ballast - flat - STATION.yardMargin);
  return Math.min(STATION.loopLead.relief, room);
}

/**
 * Metres left of the running line at `along` — negative throughout, since it
 * lies to the right.
 *
 * It closes on **zero**, not on `TRAIN.elevated.trackGap`: the road it joins is
 * the up line itself, which is the running line and is the origin of this whole
 * coordinate. That one difference is what makes it an up-line loop rather than
 * a fifth road off the down.
 */
export function upLoopOffset(along: number): number {
  const site = STATION_SITE;
  if (!site) return 0;
  const flat = site.halfPlatform + STATION.approach;
  const beyond = Math.abs(along) - flat;
  if (beyond <= 0) return UP_LOOP;
  const t = Math.min(1, beyond / upLoopTaper());
  return UP_LOOP * (1 - leadCurve(t));
}

/** Where its turnouts sit, either side of the midpoint. See `roadLead`. */
export function upLoopLead(): number {
  const site = STATION_SITE;
  if (!site) return 0;
  return site.halfPlatform + STATION.approach + upLoopTaper();
}

/** How far it stands off the up line at `along`. See `roadSeparation`. */
export function upLoopSeparation(along: number): number {
  return Math.abs(upLoopOffset(along));
}

/**
 * The innermost track at `along` — the right-hand edge the formation reaches
 * to, and zero wherever the relief loop has merged.
 *
 * The mirror of `stationOuter`, and the reason the station's formation is no
 * longer symmetric about the running line.
 */
export function stationInner(along: number): number {
  if (!STATION_SITE) return 0;
  return Math.abs(along) <= upLoopLead() ? upLoopOffset(along) : 0;
}

/**
 * Every track centre at `along`, sorted across the formation.
 *
 * The single answer to "how many railways is a thing crossing here", which
 * until now every caller guessed at. The level crossing hardcoded two — the up
 * and down lines — and laid one unbroken slab from the down line's far rail out
 * to the edge of its deck; both platform loops sit inside that slab, at the
 * same height as their own rail heads, so the crossing buried them.
 *
 * Roads that have merged are one track, not two: past the blades a loop *is*
 * the line it joined (that is the whole basis of `roadOffset`), so anything
 * closer than a gauge apart is filtered out rather than being given a second
 * flangeway a few centimetres from the first.
 */
export function stationTracks(along: number): number[] {
  const site = STATION_SITE;
  if (!site) return [0];
  const all = [0, secondTrackGap(trainWrap(site.arc + along))];
  for (let r = 2; r < ROADS.length; r++) {
    if (Math.abs(along) <= roadLead(ROADS[r])) all.push(roadOffset(ROADS[r], along));
  }
  if (Math.abs(along) <= upLoopLead()) all.push(upLoopOffset(along));
  all.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const v of all) {
    if (!kept.length || v - kept[kept.length - 1] > TRAIN.gauge) kept.push(v);
  }
  return kept;
}

/**
 * How far the running line's own structure is from the station.
 *
 * The town is laid on the other side of the line from the platforms, and its
 * nearest edge has to clear the running line's ballast toe rather than the
 * rails: the toe is where the formation actually ends.
 */
export const MAIN_LINE_TOE = TRAIN.ballastCrownHalf
  + TRAIN.ballastSlope * TRAIN.ballastDepth;

/* ------------------------------------------------------------------ the town */

/**
 * A piece of the city, moved to the island.
 *
 * Not a new asset and not a copy of the file: the city GLB is already loaded,
 * already Draco-decoded and already on the GPU, and its chunks are merged by
 * (material, 250 m cell) with every node transform baked into the vertices. So
 * a chunk can be drawn a second time somewhere else for the cost of one draw
 * call and one matrix — the geometry and the material are shared with the
 * original, which is what makes transplanting a block of the city cheaper than
 * modelling a single hut.
 *
 * Cell -1,-3 is chosen by measurement, not by taste: of the 46 cells it is one
 * of the few whose street, buildings and street furniture together occupy a
 * footprint (277 x 75 m) that fits on the island at all, and it is the only one
 * of those that has a proper road running the length of it. Most cells sprawl
 * over 250 m in both directions, which is wider than the island.
 *
 * `Blocks` is excluded and everything else in the cell is kept. `Blocks` is
 * the city's terrain shell — a 250 m slab of ground at the city's own height —
 * and bringing it would lay a grey plateau across an island that already has
 * its own crown to stand on.
 */
export const TOWN = {
  /** Chunk suffix: the cell these chunks were merged in. */
  cell: '-1_-3',
  /** Surfaces to leave behind. See above for why terrain cannot come. */
  skip: ['Blocks'] as readonly string[],
  /** How far along the line the block's centre sits. */
  along: 0,
  /**
   * The block's own footprint in the city, in world metres.
   *
   * Written down rather than measured, and only because the *map* needs it: the
   * minimap is painted from the nav raster and never loads the model, so it has
   * no bounding boxes to ask. `IslandStation` measures the same figure off the
   * geometry at load and uses that for the placement, which is the one that has
   * to be exact. If `city.glb` is ever regenerated and these disagree, the town
   * on the map will sit a few metres off the town in the world — the 3D is
   * right by construction, this is the copy to correct.
   */
  footprint: { x: [-935.6, -649.8], z: [-421.6, -353.1] } as const,
  /**
   * How far the block's near edge stands off the running line's ballast toe.
   *
   * Seated from its near edge rather than from its centre, and measured off the
   * geometry at load rather than stated here, because the block's depth is a
   * property of the city and this island is not wide enough to guess at: the
   * outline tapers toward both ends, and at the ends of a 277 m block there is
   * about 80 m of land to play with. Placing the centre at a fixed offset put
   * the far corners four metres out over the beach.
   *
   * 2 m puts the block's own street immediately alongside the railway, which is
   * both what the land allows and what a station approach looks like.
   */
  nearGap: 2,
  /**
   * Clearance over the island crown.
   *
   * The block is dropped so its lowest vertex sits this far above the crown.
   * A road slab laid exactly on the grass z-fights along its whole length —
   * both surfaces are flat, level and coplanar — and 6 cm reads as a kerb.
   */
  lift: 0.06,
} as const;

/* ----------------------------------------------------------------- the bridge */

/**
 * The road bridge from the city's north coast out to the island.
 *
 * Until now the island was reachable only by rail, which made a four-road
 * station, a town and a street network on it something you could look at from a
 * train and never stand in. A road bridge is what makes the island part of the
 * map rather than scenery beside it.
 *
 * The two ends are found differently on purpose. The island end is *measured*:
 * a ray walked south out of the island on the crossing's own meridian until it
 * leaves the outline, so if the island is ever grown again (it already has been
 * — see `ISLAND_GROWTH`) the bridge follows its shore instead of ending in the
 * sea or in a field. The city end is stated, because it is a fact about a fixed
 * asset, measured off the nav raster: the northern coast road runs east-west at
 * z = -412 at height zero, and a street leaves it southward at x = -989 and
 * runs the depth of the city.
 *
 * The crossing takes that street rather than T-ing into the coast road below
 * the island's centre, which is where it was first put. A bridge is a street
 * that keeps going: landing it mid-block gives the city no route to it, and 19
 * metres east of the island's centre costs nothing, because the island is 687 m
 * across. It also lands within a few metres of one of the transplanted town's
 * own north-south lanes on the far side, so the link road joins something.
 */
const CITY_COAST_ROAD_Z = -412;
/** The street the crossing continues. Nav-raster measurement: it spans x -991..-987. */
const CITY_STREET_X = -989;
/** Metres of deck run into each end, so the joins have no lip to catch a wheel. */
const BRIDGE_OVERLAP = 7;

export const BRIDGE = (() => {
  const site = STATION_SITE;
  if (!site || !HOST) return null;
  // Walk south along the crossing's own meridian to find the island's shore.
  const x = CITY_STREET_X;
  let shore = HOST.centre[1];
  for (let z = HOST.centre[1]; z < CITY_COAST_ROAD_Z; z += 2) {
    if (!inside(HOST.outline, x, z)) break;
    shore = z;
  }
  return {
    x,
    /** Deck ends, north (on the island crown) and south (in the city street). */
    islandZ: shore - BRIDGE_OVERLAP,
    /**
     * The south end, reaching just into the city's street.
     *
     * It was pushed 14 m in at one point, to give the deck a run-up at which to
     * climb the waterfront's sea wall. The wall is cut out now (`TERRAIN_CUTS`)
     * and the run-up went with it: a deck that reaches further into the road
     * than it has to is a deck that lies *across* the junction it leaves, and
     * at any grade at all that is a lump east-west traffic drives over.
     */
    cityZ: CITY_COAST_ROAD_Z + BRIDGE_OVERLAP,
    /** Deck heights at those ends: the island's crown, and the city at zero. */
    islandY: HOST.crown,
    cityY: 0,
    /**
     * Two lanes and a footway each side. Wide enough that the AI-free island
     * road does not feel like a track, narrow enough to read as a crossing
     * rather than a motorway.
     */
    halfWidth: 6.5,
    /**
     * A causeway, not a bridge.
     *
     * It was a box girder on four piers, and the piers were the problem: a road
     * that leaves the city on stilts reads as *elevated* the whole way, which is
     * not what a 130 m hop to a low island wants and is not what the railway
     * does either — `TrainLine` reclaims land for its own crossings to these
     * same islands (`TRAIN.causewayCrownHalf`) and this is now the same kind of
     * structure, built by the same swept-section builder.
     *
     * The crown is wider than the carriageway so the road has verges rather
     * than dropping off its own edge, and the flanks batter out at 2.2:1 to a
     * toe just under the water. Below that the bank simply stops: nothing can
     * see it, and a car that goes over the side is going into the sea anyway.
     */
    crownHalf: 8.5,
    slope: 2.2,
    toe: TRAIN.seaLevel - 1.5,
    /** The carriageway laid on the crown, and how far it stands proud of it. */
    surface: 0.05,
    /** Painted centre line, because a bare slab does not read as a road. */
    laneWidth: 0.28,

    /* ---- the profile: how high the road runs, and how it is worked out ---- */

    /** How far the road must clear whatever the city has left in the way. */
    clearance: 0.25,
    /**
     * How far from each end the clearance tapers away.
     *
     * The road has to *land* flush at both ends — on the street at one and the
     * island crown at the other — and a clearance held to the very end would
     * lift it into a 25 cm step at both joints.
     */
    landing: 12,
    /**
     * How far *below* the ground the very ends sit.
     *
     * Four centimetres, and the sign is the point. Flush would leave the road's
     * surface coplanar with the street's, and two coplanar surfaces meeting
     * under a wheel is a lip you can catch on. Sunk, the street wins at the
     * joint and the causeway comes out from under it.
     */
    endSink: 0.04,
    /** The steepest the road is allowed to be, as a gradient. */
    maxGrade: 0.055,
    /** Sampling pitch along the road, and the half-window the ground is read over. */
    step: 4,
    probe: 3,
  };
})();

/**
 * Bits of the city that are removed — from the mesh *and* from the collider —
 * because something else now stands there.
 *
 * ## The sea wall
 *
 * Along this street the city's paving runs north to z -417, steps up a 16 cm
 * kerb, and then stands a 0.76 m vertical face whose top is at 0.92 m: the
 * waterfront's own boundary wall, part of a `col_Blocks` chunk and therefore
 * solid. The road has to get past it, and rather than ramp over it — which is
 * what makes an approach elevated — the twelve metres of it the road lands on
 * are demolished, which is what a highway authority would do.
 *
 * The width is measured, not chosen, and this is the part that bit. A triangle
 * goes if its *centroid* is inside the box, and the wall is not tiled finely:
 * `col_Blocks_-3_-2` spans it in one triangle from x -1001.7 to -988.6 and
 * `col_Blocks_-2_-3` carries on from -988.6 to -975.6, the two meeting almost
 * exactly on the bridge's centreline. A 12 m box missed both centroids by
 * 20 cm and left both triangles in place — which drew as a thin line straight
 * across the new road, and stopped the car dead on it. The box now reaches
 * -996.5 to -981 so that both centroids are inside, and the 40 m triangles
 * either side of them are untouched: they reach only to -1001.7 and -975.6, so
 * nothing that survives crosses the carriageway.
 *
 * Removing whole triangles leaves the wall ending at the tile boundaries, 26 m
 * apart, with the causeway's bank filling about twenty of that. What is left
 * reads as the opening the bridge was built through.
 *
 * ## The trees
 *
 * Six of them, and their positions are measured from the asset the same way:
 * the vegetation chunk was clustered and these are the clusters whose trunks or
 * canopies stand inside the carriageway. One of them (x -991.5, z -418.4) stood
 * in the middle of the bridge mouth. They are `deco_` chunks and never had
 * colliders, so this is purely so that the road does not appear to run through
 * a tree — the rest of the street's planting is left alone.
 *
 * `only` keeps each cut to the chunk it is aimed at. Without it a box sitting
 * on the street would take a bite out of whatever building happened to share
 * the space.
 */
export interface TerrainCut {
  x: readonly [number, number];
  y: readonly [number, number];
  z: readonly [number, number];
  /** Restrict the cut to chunks whose name contains this. */
  only?: string;
  /**
   * Remove every triangle that *overlaps* the box, not just those centred in
   * it — the only test that can remove geometry tiled coarser than the cut.
   *
   * See `CityMap.trim`: the sea wall crosses the bridge in 13 m triangles whose
   * centroids sit outside any box narrow enough to be safe, so a centroid cut
   * left its coping lying across the new road however wide the box was made.
   * The y band does the discriminating instead, which is why the wall cut
   * starts above the pavement the wall stands on.
   */
  overlap?: boolean;
}

/** One tree, as a box round its measured extent. */
const fell = (x: number, z: number, half: number): TerrainCut => ({
  x: [x - half, x + half],
  z: [z - half, z + half],
  // Above the kerbs and the pavement, which have to survive: the trunk starts
  // at 0.2 m and what is left of it below the cut is buried in the ground.
  y: [0.25, 16],
  only: 'Vegetation',
});

export const TERRAIN_CUTS: ReadonlyArray<TerrainCut> = BRIDGE ? [
  {
    // The wall: everything this box TOUCHES between the pavement and head
    // height, across the full width of the crossing. `overlap` and the 0.35 m
    // floor are what make this work at all — the wall is tiled in 13 m
    // triangles that no centroid test can catch, and the floor is what keeps
    // the 0.2 m pavement the wall stands on. See `TerrainCut.overlap`.
    x: [BRIDGE.x - 7, BRIDGE.x + 7],
    y: [0.35, 4],
    z: [CITY_COAST_ROAD_Z - 14, CITY_COAST_ROAD_Z - 2],
    only: 'Blocks',
    overlap: true,
  },
  fell(-991.5, -418.4, 5),
  fell(-992.6, -390.5, 6),
  fell(-992.6, -381.5, 6),
  fell(-992.1, -368.9, 6),
  fell(-983.7, -393.0, 4),
  fell(-985.1, -364.2, 5),
] : [];

/**
 * The link from the bridge head to the town's own streets.
 *
 * The bridge lands on open crown south of the transplanted block, and a road
 * that stops in a field is not a road. This is the connecting stretch, laid on
 * the island the way the station approach is: plain asphalt, because the city's
 * street material is a baked atlas and means nothing on new geometry.
 */
export const ISLAND_LINK = {
  halfWidth: 6.5,
} as const;

/* ------------------------------------------------------------ double track */

/**
 * Where the line is double track: from the start of the elevated street run,
 * forward along the northern leg, to the station throat.
 *
 * The second track is the other half of a railway through a city, and it has
 * somewhere to go: it runs on from the street, over the northern crossing, and
 * into the station, where the throat fans the roads out. It stops where the
 * throat begins, easing from its running offset to the throat's own over the
 * last `THROAT_EASE` metres so the two meet rather than jog.
 *
 * Measured off the route rather than stated: the street is wherever the
 * generator flagged it, the throat is wherever the station found itself, and
 * the range is read forward round the loop between them, through the
 * arc-length origin if that is where it falls.
 */
export const DOUBLE_TRACK = (() => {
  const site = STATION_SITE;
  const first = TRAIN_POINTS.findIndex((p, i) => p.street
    && !TRAIN_POINTS[(i - 1 + TRAIN_POINTS.length) % TRAIN_POINTS.length].street);
  if (!site || first < 0) return null;
  const from = TRAIN_POINTS[first].arc;
  const to = ((site.arc - site.halfPlatform - STATION.approach - site.taper) % TRAIN_LENGTH
    + TRAIN_LENGTH) % TRAIN_LENGTH;
  return { from, to, length: ((to - from) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH };
})();

/**
 * Whether arc length `s` is double track. It always is now: the second track
 * is the down line, the whole way round, and `DOUBLE_TRACK` above survives
 * only as the record of where the elevated stretch and the station sit.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is the contract
export function doubleTrackAt(_s: number): boolean {
  return true;
}


/**
 * The second track's offset left of the running line at arc `s`.
 *
 * The running gap everywhere — except through the island station, where the
 * down line fans out to *become* road 1. That puts platform A between the two
 * through lines, which is what an island platform is for, and it is why the
 * station needs to build only the outer pair itself. The fan is a smoothstep
 * over the station's taper at each end, mirrored, so the down line leaves the
 * platform the way it arrived; the old one-sided ease into the throat, which
 * turned the second track into a bay, is gone with the bays.
 */
export function secondTrackGap(s: number): number {
  const gap = TRAIN.elevated.trackGap;
  const site = STATION_SITE;
  if (!site) return gap;
  let along = ((s - site.arc) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  if (along > TRAIN_LENGTH / 2) along -= TRAIN_LENGTH;
  const flat = site.halfPlatform + STATION.approach;
  const beyond = Math.abs(along) - flat;
  if (beyond >= site.taper) return gap;
  // The same flat-topped lead the loops use, for the same reason: the down
  // line's own fan out to the island platform is a turnout lead like any other,
  // and a smoothstep gave it a 1-in-11 swerve in the middle of a running line.
  const t = beyond <= 0 ? 0 : beyond / site.taper;
  return ROADS[1] + (gap - ROADS[1]) * leadCurve(t);
}

/**
 * How far the station's formation reaches from its midpoint, and whether an arc
 * is inside it.
 *
 * The whole throat stands on ONE ballast formation (`IslandStation`), so the
 * running line's own trapezium has to stop where that starts or the two fight
 * for the same plane — see `TrainLine`'s `yard`.
 */
export const STATION_YARD = STATION_SITE ? roadLead(ROADS[ROADS.length - 1]) : 0;

export function stationYardAt(s: number): boolean {
  const site = STATION_SITE;
  if (!site) return false;
  let along = ((s - site.arc) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  if (along > TRAIN_LENGTH / 2) along -= TRAIN_LENGTH;
  return Math.abs(along) <= STATION_YARD;
}

/* ------------------------------------------------------------ metro station */

/**
 * The elevated metro station on the street viaduct.
 *
 * Two side platforms with the two tracks between them, a lattice barrel vault
 * over all of it, gantries and wires above the tracks, lamps under the roof and
 * stairs down to the footpath at each end — the elevated-station type, built
 * here on the one stretch of the line that is elevated through a city.
 *
 * The site is found, not stated: the longest run of `street` points, and within
 * it the `platformLength` window whose narrowest measured carriageway is
 * widest — the platforms overhang the running deck, and the more street there
 * is under them the less they overhang anything else. Ties go to the middle of
 * the run.
 */
export const METRO = {
  platformLength: 108,
  /** Platform width beyond the face; the face is `platformSetback` off each track. */
  platformWidth: 3.4,
  platformSetback: 1.7,
  /** Platform surface over the rail head — the same figure as the island's. */
  platformRise: 0.915,
  /** How the widened deck eases back to the running deck at each end. */
  deckEase: 14,
  /** The vault: springing height over the platform, and rib and purlin pitch. */
  vaultRise: 1.6,
  ribSpacing: 6,
  purlins: 9,
  /** Roof columns down each platform's outer edge. */
  columnSpacing: 12,
  columnHalf: 0.16,
  /** Catenary gantries over the tracks, and the wire height over the rail. */
  gantrySpacing: 36,
  wireHeight: 5.1,
  /** Lamps under the vault, along each platform. */
  lampSpacing: 9,
  /** The stair towers at the south end, one per platform. */
  stairWidth: 2.6,
  stairLength: 7,
} as const;

export const METRO_SITE = (() => {
  const n = TRAIN_POINTS.length;
  if (!n) return null;
  // The longest run of street points, read as a ring.
  let best: { from: number; length: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (!TRAIN_POINTS[i].street || TRAIN_POINTS[(i - 1 + n) % n].street) continue;
    let run = 0;
    while (run < n && TRAIN_POINTS[(i + run) % n].street) run++;
    if (!best || run > best.length) best = { from: i, length: run };
  }
  if (!best) return null;
  const step = TRAIN_LENGTH / n;
  const window = Math.round(METRO.platformLength / step);
  if (best.length <= window + 8) return null;
  // Widest narrowest street under any window; ties to the middle.
  let pick = -1;
  let pickWidth = -1;
  let pickOffset = Infinity;
  for (let k = 4; k + window <= best.length - 4; k++) {
    let narrowest = Infinity;
    for (let j = 0; j < window; j++) {
      const p = TRAIN_POINTS[(best.from + k + j) % n];
      narrowest = Math.min(narrowest, p.kerbLeft + p.kerbRight);
    }
    const offset = Math.abs(k + window / 2 - best.length / 2);
    if (narrowest > pickWidth || (narrowest === pickWidth && offset < pickOffset)) {
      pick = k; pickWidth = narrowest; pickOffset = offset;
    }
  }
  if (pick < 0) return null;
  const centreIndex = (best.from + pick + Math.floor(window / 2)) % n;
  const arc = TRAIN_POINTS[centreIndex].arc;
  const [x, y, z] = trainPointAt(arc);
  const [tx, tz] = trainTangentAt(arc);
  const [nx, nz] = trainNormalAt(arc);
  return {
    arc,
    centre: [x, y, z] as [number, number, number],
    tangent: [tx, tz] as [number, number],
    normal: [nx, nz] as [number, number],
    heading: Math.atan2(tx, tz),
    /** Street width under the narrowest point of the platforms. */
    streetWidth: pickWidth,
    /** The street's ground under the station, for the stairs. */
    ground: TRAIN_POINTS[centreIndex].ground,
  };
})();

/* ------------------------------------------------------ underground station */

/**
 * The underground station inside the long tunnel.
 *
 * A twin-platform tube station: the bore is widened into a hall for the
 * length of two platforms, one down each side — the right-hand one serves the
 * running (up) line, the left-hand one the down line — with a tall bay over
 * both tracks between them, low ceilings over the platforms, tiled back walls
 * with a name frieze, exit portals, benches, name boards, hanging signs, and at
 * each end the hall eases back into the horseshoe so the lining hands over to
 * it without a seam.
 *
 * Everything is measured from the CENTRE OF THE TRACK PAIR (`pairCentreAt`),
 * not the running line: the hall is symmetric about that centre, and so is
 * the bore it grows out of. `UndergroundStation` places its samples on it.
 *
 * Sited by cover, not by name: the longest enclosed stretch, and within it the
 * `length` window of true bore points (there is ground over them — the middle
 * of this tunnel is a gallery over an inlet, with sea above it) whose shallowest
 * cover is deepest. A hall 8.9 m high wants a hill over it; the pick today has
 * 16.8 m at its shallowest.
 */
export const UNDERGROUND = {
  /** Platform length. Two 200 m platforms in a 312 m bore, with the eases. */
  length: 200,
  /** How far beyond the platform the hall eases back into the bore. */
  ease: 12,
  /** Each platform: face off its own track, and width to the back wall. */
  platformSetback: 1.7,
  platformWidth: 4.6,
  platformRise: 0.915,
  /**
   * Half-width of the hall about the pair centre: half the track gap out to
   * the rail, the setback to the platform face, the platform, and 0.2 m of
   * wall behind the tiles. 8.8 m today.
   */
  hallHalf: TRAIN.elevated.trackGap / 2 + 1.7 + 4.6 + 0.2,
  /**
   * The section: a low flat ceiling over each platform — the subway room, 3.9 m
   * over the platform — stepping up to a tall bay over the two tracks. The bay
   * is not a stylistic choice: the chase camera rides high over the rail, and
   * a ceiling under it puts the camera on the roof. The step is this far back
   * from each platform face, so the columns stand under the low ceiling.
   */
  stepInset: 0.6,
  lowCeiling: 0.915 + 3.9,
  bayCeiling: 8.9,
  /** Columns down each platform edge, and the fixtures' pitches along the hall. */
  columnSpacing: 4.5,
  columnInset: 0.95,
  lampSpacing: 4,
  binSpacing: 30,
  cameraSpacing: 25,
  benchSpacing: 15,
  exitSpacing: 48,
  signSpacing: 24,
  adSpacing: 12,
  firePointSpacing: 48,
  /** Minimum cover the picker will accept over the hall. */
  minCover: 9,
} as const;

export const UNDERGROUND_SITE = (() => {
  const n = TRAIN_POINTS.length;
  if (!n) return null;
  // The longest enclosed stretch...
  let enclosed: { from: number; length: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (!TRAIN_POINTS[i].enclosed || TRAIN_POINTS[(i - 1 + n) % n].enclosed) continue;
    let run = 0;
    while (run < n && TRAIN_POINTS[(i + run) % n].enclosed) run++;
    if (!enclosed || run > enclosed.length) enclosed = { from: i, length: run };
  }
  if (!enclosed) return null;
  // ...and within it the longest run of true bore — ground overhead, not sea.
  // The hall goes in the middle of that. The tunnel's own midpoint is where a
  // gallery carries the line over an inlet, and a station there would be a box
  // hanging off a viaduct, not anything underground.
  const isBore = (i: number) => {
    const p = TRAIN_POINTS[i % n];
    return p.structure === TUNNEL && !p.overWater && p.ground - p.y >= UNDERGROUND.minCover;
  };
  let bore: { from: number; length: number } | null = null;
  for (let k = 0; k < enclosed.length; k++) {
    const i = enclosed.from + k;
    if (!isBore(i) || (k > 0 && isBore(i - 1))) continue;
    let run = 0;
    while (k + run < enclosed.length && isBore(i + run)) run++;
    if (!bore || run > bore.length) bore = { from: i, length: run };
  }
  const step = TRAIN_LENGTH / n;
  const needed = Math.round((UNDERGROUND.length + UNDERGROUND.ease * 2) / step);
  if (!bore || bore.length < needed) return null;
  const centreIndex = (bore.from + Math.floor(bore.length / 2)) % n;
  let cover = Infinity;
  for (let j = -needed / 2; j <= needed / 2; j++) {
    const p = TRAIN_POINTS[(centreIndex + Math.round(j) + n) % n];
    cover = Math.min(cover, p.ground - p.y);
  }
  const arc = TRAIN_POINTS[centreIndex].arc;
  return { arc, cover, centre: trainPointAt(arc) };
})();

/** Whether arc `s` lies within the hall, easing included — where the lining stops. */
export function undergroundStationAt(s: number): boolean {
  const site = UNDERGROUND_SITE;
  if (!site) return false;
  let d = ((s - site.arc) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  if (d > TRAIN_LENGTH / 2) d -= TRAIN_LENGTH;
  return Math.abs(d) <= UNDERGROUND.length / 2 + UNDERGROUND.ease;
}

/** True when the underground station has a site. */
export const UNDERGROUND_ENABLED = UNDERGROUND_SITE !== null;

/** True when the elevated metro station has a site. */
export const METRO_ENABLED = METRO_SITE !== null;

/** True when there is a station to draw at all. */
export const STATION_ENABLED = STATION_SITE !== null && TRAIN_POINTS.length > 0;
