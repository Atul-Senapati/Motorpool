import { ROAD_WIDTH, type Piece } from './roadConfig';
import {
  CROSSING, CROSSING_ALONG, CROSSING_DECK_N, CROSSING_DECK_S, CROSSING_RAMP,
  type CrossingSpec,
} from './townConfig';
import {
  MAIN_LINE_TOE, STATION_SITE, stationShore, stationTracksInFrame,
} from './stationConfig';

/**
 * Kestrel's street grid.
 *
 * The island had a town on it once — two through streets, a back lane, cross
 * streets, a ring road and thirteen blocks of transplanted city — and it was
 * switched off wholesale (`TOWN_BUILT`) when the brief became "railway, and
 * nothing else". What is wanted now is the grid back *without* the buildings:
 * a city layout with the blocks left empty.
 *
 * So this is not that town restored. It is a new network built from the
 * **modular road kit** the airport island uses, in the station's own
 * (across, along) frame, laid out against a survey of what is actually on the
 * island rather than against the shape it used to be.
 *
 * ## What the island leaves room for
 *
 * Walked outward from the running line, the island now reaches 331 m north at
 * `along` −180, falling to 217 at +260, and 30–97 m south — the north figures
 * being 80 m more than they were, because the grid is what the island was
 * widened for (`ISLAND_TRIM`). Against that:
 *
 * - the **railway** takes across −6 (the relief loop) to +31 (`ROADS[3]`, the
 *   outermost station road) plus its ballast, over almost the whole length —
 *   `STATION_YARD` is 302 m, so the formation runs the island end to end;
 * - the **cruise berth** is `along` −215 to +25 at the north shore;
 * - the **stage** stands at `along` 150, measuring its own back off the shore,
 *   so it moved out with it;
 * - the **road viaduct** lands at `along` +17 on the south shore;
 * - the **level crossing** is at `along` 255, which is the one place the
 *   station's roads have tapered far enough away to get a road over the line.
 *
 * What is left is a band about 160 m deep along the north shore and a thinner
 * one to the south, and the grid is fitted into the first with a link through
 * the second to the bridge.
 *
 * ## Endless
 *
 * Four avenues by six cross streets: nine blocks, and no road that stops.
 * Every junction has at least three ways out of it and the outside of the grid
 * is a closed rectangle, so there is nowhere to drive to and be stuck — which
 * is what a grid is for, and what the airport island's first pair of dead-ended
 * straights were not. The only thing hanging off it is the bridge link, and
 * that ends at a bridge.
 *
 * Two things stand in the blocks rather than beside them: Kestrel Water in the
 * middle of the island (`kestrelPark`), and the school's campus at the west end
 * (`kestrelSchool`), which is a superblock — one cross street bay short of the
 * grid it is cut out of, and the only hole in it.
 */

/** Half the kit's carriageway, which every end is set back by so tiles butt. */
const HALF = ROAD_WIDTH / 2;

/**
 * The avenues, as distances across from the running line — and how far east
 * each one reaches.
 *
 * Four, and they do not all run the full length, because the island does not.
 * The north shore falls away eastward — 334 m out at `along` −190, 291 at +77,
 * 228 at +255 — so an avenue placed far enough out to be behind the dock is in
 * the sea by the time it reaches the level crossing. Rather than pick one
 * compromise distance and put the whole grid at it, each avenue runs as far as
 * its own distance allows and stops on a cross street:
 *
 * - **56** is the station avenue and runs the full six, clear of the railway's
 *   outermost road and its ballast at one end and of the stage at the other;
 * - **149** is the stage avenue, and it starts at the THIRD cross street and
 *   not the first: everything west of that is the school's campus, and a
 *   campus is a superblock or it is two halves of a campus. See `CROSSES` and
 *   `kestrelSchool`;
 * - **242** is the dock road, stopping at +77 where it has 17 m of shore left;
 * - **289** is the quay road behind the berth itself, stopping at −101 where
 *   the apron is still 20 m further out.
 *
 * There was a fifth at **102.6**, the middle avenue, and it is gone. It ran the
 * length of the island 46.6 m out from the station avenue and dead parallel to
 * it, which is not two streets — it is a dual carriageway with a strip down
 * the middle. West of the park it had the school on one side of it and a block
 * of grass on the other. Taking it out does three things at once: the campus
 * gets its own ground from the station avenue out to the dock road, the west
 * end stops being ruled with parallel lines, and the crescent gets to be a
 * ring road rather than a bracket round the end of one — see `KESTREL_ARCS`.
 *
 * `to` is an index into `CROSS`, and the list must be **non-increasing** in it:
 * every avenue reaches at least as far as the one outside it, which is what
 * lets a cross street know how far north it runs by looking at one number.
 */
const AVENUES = [
  { across: 56, from: 0, to: 5, label: 'station avenue' },
  { across: 149.2, from: 2, to: 5, label: 'stage avenue' },
  { across: 242.4, from: 0, to: 3, label: 'dock road', radial: false },
  { across: 289, from: 0, to: 2, label: 'quay road' },
] as const;

/**
 * Whether an avenue throws a radial into the ring road's half disc.
 *
 * All of them do that reach the west end, and it is not a choice anywhere else
 * — a road that stops at a chord with a loop the other side of it is a road
 * that stops for no reason. The dock road is the exception: its radial ran down
 * through the middle of the ground the mall now stands on (`kestrelMall`), and
 * a service road through a shopping centre is not a service road.
 *
 * Off rather than shortened, because the ring road is a loop: the dock road
 * still reaches the chord, the chord still reaches the ring at both its ends,
 * and nothing is stranded by it.
 */
const hasRadial = (a: { label: string }) => (a as { radial?: boolean }).radial !== false;

/** One avenue's distance across, by name. Indices shift; labels do not. */
export function avenue(label: string): number {
  const found = AVENUES.find((a) => a.label === label);
  if (!found) throw new Error(`no avenue called ${label}`);
  return found.across;
}

/** Just the offsets, for anything that only wants to know where they are. */
export const AVENUE = AVENUES.map((a) => a.across);

/**
 * The cross streets, as distances along from the station midpoint.
 *
 * Six at 89 m centres. With the avenues they leave **fourteen blocks**, most of
 * them about 70 m by 50 — a city block, and the spaces the brief asks to be
 * left for buildings.
 *
 * The end pair are not chosen for spacing. −190 is as far west as the island
 * carries the avenues with room to turn, and **+255 is the level crossing**: it
 * is the one `along` at which the station's four roads have tapered back far
 * enough for a road to get over the railway, so the grid's east side and the
 * only way in from the bridge are the same street.
 */
const CROSSES = [
  { along: -190, label: 'west end' },
  /*
   * The school's cross street, and the one bay of it that was never built.
   *
   * `skip` NAMES an avenue: the bay from that avenue out to the next one is
   * missing, and everything below — which arms a junction has, which runs get
   * laid — reads it rather than being told twice. There is exactly one, and it
   * is the middle of St. Anjali's campus.
   *
   * By name and not by index, because an index is a promise about the order of
   * a list that is edited: when the middle avenue came out of `AVENUES` the
   * bays either side of this one renumbered, and a `skip: 1` would have gone
   * on silently meaning a different street.
   *
   * The two blocks either side of it were 140 m by 89, and an American high
   * school with its parking lot, its running track and its baseball diamond is
   * 156 m by 113. It does not fit in a block and it should not: a campus is a
   * superblock in every town that has one, because what you do with a school is
   * drive round it, not through it. So this street stops at the middle avenue
   * on one side and at the dock road on the other, and both of its ends are
   * T junctions rather than the crossroads they were.
   *
   * Nothing is stranded by it. The bays it keeps are rungs between two parallel
   * avenues at each end, the four streets round the campus all run through, and
   * the column between the station and middle avenues simply becomes one long
   * block instead of two — which is what a street that a school is built across
   * does to the grid behind it.
   */
  { along: -101, label: 'school cross', skip: 'station avenue', mouth: 'station avenue' },
  { along: -12, label: 'park cross' },
  { along: 77, label: 'dock cross' },
  { along: 166, label: 'stage cross' },
  { along: CROSSING_ALONG, label: 'crossing' },
] as const;

/** Just the distances, for anything that only wants to know where they are. */
export const CROSS: readonly number[] = CROSSES.map((c) => c.along);

/**
 * The avenues that actually throw a radial into the half disc, as distances
 * across.
 *
 * Exported because the ground inside the ring road has a building on it now and
 * that building has to know what crosses it — and has to keep knowing if a
 * radial is ever turned back on. See `hasRadial` and `MALL_SITE`.
 */
export const KESTREL_RADIALS: readonly number[] = AVENUES
  .filter((a) => a.from === 0 && hasRadial(a))
  .map((a) => a.across);

/* -------------------------------------------------- the west level crossing */

/**
 * The second crossing, at the west end — and why it is a different shape from
 * the first.
 *
 * The island had one road over the railway, at +255, and everything south of
 * the line hung off it: the viaduct landed on the south shore, a link ran 240 m
 * east under the station, and the ONLY way from it to the town was back over
 * that one deck. Drive the island and you feel it — the west end is a
 * cul-de-sac with a ring road on the end of it.
 *
 * This is the other one. It takes the grid's south-west corner — the station
 * avenue's junction with the west end cross street, which is also the
 * crescent's east mouth — straight down over the throat to a new shore road,
 * and that road runs east to the link at the stage cross. What it makes is a
 * **circuit**: grid, west crossing, south shore, east crossing, grid.
 *
 * ## Why it is skewed, and why its ramps are not equal
 *
 * At +255 the flat frame and the railway are the same line, which is the whole
 * reason the first crossing is there (see `CROSSING_ALONG`). Here they are not:
 * the running line is 14.8 m north of the frame's origin line at −190 and 12.6
 * degrees off its heading, and there are FIVE tracks under the road rather than
 * four, still fanning out of the throat. So the deck's edges are measured with
 * `stationTracksInFrame`, which walks each track out to the frame line one
 * `along` at a time — sampled over the deck's whole width, because the
 * outermost track moves two metres across the twenty-two the road is wide.
 *
 * The consequence is the ramps. The deck reaches the ballast toe at 39.7 and
 * the station avenue's kerb is at 46.5: **seven metres**, against sixteen on
 * the shore side where there is nothing but grass. So the north ramp is as long
 * as the ground allows and no longer. Sixteen there would have put the foot of
 * it four metres inside the junction tile, which is a hump rising through a
 * crossroads.
 */
const WEST_ALONG = CROSS[0];

const WEST_CROSSING: CrossingSpec | null = (() => {
  if (!STATION_SITE) return null;
  const half = CROSSING.halfWidth;
  // The extremes over the deck's own width, not the value at its midpoint:
  // a rectangle that fits the tracks at the middle of the road leaves rail
  // sticking out of both ends of it. See `stationTracksInFrame`.
  let from = Infinity;
  let to = -Infinity;
  for (let d = -half; d <= half + 1e-6; d += 1) {
    const tracks = stationTracksInFrame(WEST_ALONG + d);
    from = Math.min(from, tracks[0] - MAIN_LINE_TOE);
    to = Math.max(to, tracks[tracks.length - 1] + MAIN_LINE_TOE);
  }
  return {
    label: 'west crossing',
    along: WEST_ALONG,
    halfWidth: half,
    fromAcross: from,
    toAcross: to,
    ramp: CROSSING_RAMP,
    // Onto the avenue's kerb exactly, and never shorter than a kerb ramp.
    rampNorth: Math.max(4, AVENUES[0].across - HALF - to),
    barrierAcross: [from - 2.5, to + 2.5] as const,
    warnDistance: CROSSING.warnDistance,
    skew: true,
  };
})();

/** The west crossing, for whatever draws it and whatever drives over it. */
export const KESTREL_WEST_CROSSING: CrossingSpec | null = WEST_CROSSING;

/**
 * Whether cross street `j` has a carriageway from avenue `i` out to the next.
 *
 * The one thing in this network that is stated rather than derived, and it is
 * stated in one place: see `CROSSES`.
 */
const bay = (j: number, i: number): boolean => (
  (CROSSES[j] as { skip?: string }).skip !== AVENUES[i].label
);

/**
 * Whether this avenue has a MOUTH at this cross street: an arm, but no road.
 *
 * The school's superblock has no cross street through it (`skip`), and it did
 * not need one — but the school's gateway is on the station avenue at exactly
 * that `along`, and an entrance that opens onto the side of a through road is
 * not an entrance. It is the one place on this island where something arrives
 * at the network and the network does not acknowledge it.
 *
 * So the node there takes a north arm and becomes a **T out of the kit**, which
 * is the junction the avenue actually wants, and no run is laid off it: the
 * junction tile's own half-width IS the distance from the avenue's centre to
 * the block's kerb, so the mouth lands on the school's plaza by construction.
 * A road drawn past it would be a road inside the school, and there are none.
 */
const mouth = (j: number, i: number): boolean => (
  (CROSSES[j] as { mouth?: string }).mouth === AVENUES[i].label
);

/**
 * The link from the road viaduct, and why it goes the long way round.
 *
 * The bridge lands at `along` +17 on the SOUTH shore and the grid is on the
 * north, so something has to cross the railway — and the only place it can is
 * the level crossing at +255. The link therefore runs east under the station
 * along the south shore, and it cannot run straight: at across −72 it has a few
 * metres of land to spare at `along` 166 and none at all by 255, where the
 * island has narrowed to 50. So it steps north to −30 at 166 and finishes along
 * that, which is inside the shore the whole way.
 */
const LINK_OUTER = -72;
const LINK_INNER = -30;
/**
 * Where the shore road bends between its two offsets.
 *
 * Through the station it runs on the OUTER leg (−72), clear of the building,
 * its forecourt and the relief-loop platform; at both ends it has to come back
 * in to `LINK_INNER` (−30) — west for the west crossing, east for the level
 * crossing. Those used to be doglegs: two kit corners each, a square jog of
 * 42 m with a right angle at either end of it, and at the west one the corner
 * at −92 put the kerb over the water (the shore is at −78 there).
 *
 * They are now S-bends swept along a cosine — `KESTREL_SWEEPS` — whose ends
 * leave dead parallel to the line, so each one meets the straight beyond it
 * with no kink at all. The numbers are fitted to the shore, which was walked
 * (`onStationIsland`) for the southmost land at each `along`:
 *
 * - **West**, from the west crossing's corner to −40: 140 m long, never more
 *   than 25° off the line, and its south kerb stays 4.9 m inside the shore at
 *   the tightest point (along −56). Ending it further west tightens that; at
 *   −70 the kerb is in the sea.
 * - **East**, from 60 to the level crossing's corner: 185 m, 20° at most, 15 m
 *   of verge throughout. It starts east of the forecourt, which ends at 50.
 */
const WEST_BEND_END = -40;
const EAST_BEND_START = 60;
/** Where the viaduct's deck ends, in this frame. See `BRIDGE_OVERLAP`. */
const BRIDGE_ALONG = 17;

/**
 * The west crescent: the ring road round the end of the island.
 *
 * The first attempt at curves used the kit's own `curve1` pieces, and they made
 * the layout rather than the other way round: a kit curve is a **U-turn** whose
 * two mouths are a fixed distance apart — 46.6 m, 93.2 or 186.2 and nothing
 * between — so the avenues had to be spaced at one of those, three disjoint
 * pairs got capped and the rest got square corners. Three tight semicircles in
 * a row is not a road layout, it is a constraint showing.
 *
 * Nothing actually requires the kit's geometry. The road *surface* is what the
 * kit provides, and both bridge decks already sweep that surface along an
 * arbitrary centreline with `buildLoft`. So this is a curve of whatever shape
 * suits: a half ellipse from the station avenue's west end round to the quay
 * road's, with the cross street at −190 as its chord.
 *
 * ## How deep, and why it is measured
 *
 * It used to be 60 m, which was a guess made against a remembered west tip and
 * with the middle avenue's radial crossing it. 60 against a half-width of 116.5
 * is a bracket, not a ring road: the curvature is all in two tight corners at
 * the ends with a near-straight between them, which is exactly what it looked
 * like from the middle avenue.
 *
 * So it is now **as deep as the island allows**, and the island is asked rather
 * than remembered — which matters, because what was remembered was wrong. The
 * west tip is not at −260: the outline reaches −308 at the station avenue's
 * line and −343 in the middle, so there was another eighty metres of ground
 * out there the whole time. For each point on the arc the shore is walked west
 * from the chord (`stationShore`) and the arc is required to stay `MARGIN` plus
 * its own half-carriageway inside it; the depth is the largest that satisfies
 * every point at once.
 *
 * On today's outline that comes out at 131 m, and it is capped at the
 * half-width — so the crescent is a **semicircle**, 116.5 m in every
 * direction, reaching −306 with 35 m of grass still in front of it. Deeper
 * than a semicircle would turn the ends back on themselves and have the
 * avenues meeting the loop from inside, which is not a ring road, it is a
 * bulb.
 *
 * `MARGIN` is grass, and 10 m of it: a road whose kerb is at the waterline
 * reads as a sea wall, and there is no sea wall out here.
 *
 * What it makes is a loop with the chord across it and one radial — the dock
 * road's — off the far side, which is what the west end of a town looks like
 * when the town stops and the ring road keeps going.
 */
export interface RoadArc {
  /** Centre, in the station's (across, along). */
  centre: readonly [number, number];
  /** Semi-axes: across, then along. Equal ones give a circle. */
  radius: readonly [number, number];
  label: string;
}

/** Grass the crescent leaves between its outer kerb and the water. */
const MARGIN = 10;

/** The crescent's ends: the two outermost avenues that reach the west end. */
const ARC_ENDS = AVENUES.filter((a) => a.from === 0);
const ARC_CENTRE = (ARC_ENDS[0].across + ARC_ENDS[ARC_ENDS.length - 1].across) / 2;
const ARC_HALF = (ARC_ENDS[ARC_ENDS.length - 1].across - ARC_ENDS[0].across) / 2;

/**
 * How far west the arc may bulge, solved against the shore.
 *
 * Sampled a degree at a time over the half ellipse. At each sample the arc is
 * at a known `across`, the island's westmost `along` at that `across` is walked
 * out, and the depth that would just put this point on its clearance line is
 * `(chord - shore - clearance) / sin t`. The smallest of those is the depth the
 * whole curve can have, and the sample nearest the middle is usually the one
 * that binds, because that is where the arc is furthest west and the island is
 * narrowing.
 *
 * Falls back to the old 60 when there is no island to ask — the layout still
 * has to have a shape when `STATION_SITE` is null and nothing is built.
 */
const ARC_DEPTH = (() => {
  if (!STATION_SITE) return 60;
  const clearance = MARGIN + HALF;
  let depth = Infinity;
  for (let d = 1; d <= 179; d++) {
    const t = (d / 180) * Math.PI;
    const across = ARC_CENTRE + ARC_HALF * Math.cos(t);
    const shore = stationShore(CROSS[0], across, -1, 400);
    // No land even at the chord: this part of the arc is a lost cause and the
    // clamp below is what keeps the curve sane rather than zero.
    if (shore === null) return 60;
    depth = Math.min(depth, (CROSS[0] - shore - clearance) / Math.sin(t));
  }
  // Never deeper than a semicircle: past that the ends would turn back on
  // themselves and the avenues would meet the loop from inside it.
  return Math.max(20, Math.min(ARC_HALF, depth));
})();

export const KESTREL_ARCS: readonly RoadArc[] = [
  {
    centre: [ARC_CENTRE, CROSS[0]],
    radius: [ARC_HALF, ARC_DEPTH],
    label: 'west crescent',
  },
];

/**
 * An S-bend between two lines parallel to the railway: `from` and `to` are
 * (across, along), and the road leaves each of them heading straight along the
 * line. Swept, like the crescent, rather than tiled — see `KestrelRoads`.
 */
export interface RoadSweep {
  from: readonly [number, number];
  to: readonly [number, number];
  label: string;
  /**
   * A quarter-circle bend round this corner instead of an S: `from` and `to`
   * are where the two straights leave it, each `radius` from the corner, and
   * the arc is tangent to both. See `ARC_CORNERS`.
   */
  corner?: readonly [number, number];
}

/**
 * Points down a sweep's centreline, about `step` metres apart, as
 * (across, along) — the one sampling the renderer and the minimap share.
 *
 * The across offset eases on a half cosine of the along distance, which is
 * what makes the ends tangent to the straights: its slope is zero at both.
 */
export function sweepPoints(sweep: RoadSweep, step = 4): Array<[number, number]> {
  const [c0, a0] = sweep.from;
  const [c1, a1] = sweep.to;
  if (sweep.corner) {
    // The arc's centre is the corner reflected through the chord's midpoint.
    const oc = c0 + c1 - sweep.corner[0];
    const oa = a0 + a1 - sweep.corner[1];
    const t0 = Math.atan2(a0 - oa, c0 - oc);
    let t1 = Math.atan2(a1 - oa, c1 - oc);
    while (t1 - t0 > Math.PI) t1 -= Math.PI * 2;
    while (t0 - t1 > Math.PI) t1 += Math.PI * 2;
    const r = Math.hypot(c0 - oc, a0 - oa);
    const n = Math.max(8, Math.ceil((Math.abs(t1 - t0) * r) / step));
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      pts.push([oc + r * Math.cos(t), oa + r * Math.sin(t)]);
    }
    return pts;
  }
  const n = Math.max(8, Math.ceil(Math.hypot(c1 - c0, a1 - a0) / step));
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([c0 + (c1 - c0) * (1 - Math.cos(Math.PI * t)) / 2, a0 + (a1 - a0) * t]);
  }
  return out;
}

/**
 * Where one avenue meets the crescent.
 *
 * The ellipse is parametrised so `across` runs from centre − a to centre + a as
 * the angle goes π to 0, and `along` bulges to centre − b at the top. Solving it
 * for a known `across` is one inverse cosine, and the avenues are all inside the
 * span by construction — the two on the ends of it ARE the span.
 */
export function crescentAlong(across: number): number | null {
  const arc = KESTREL_ARCS[0];
  const t = (across - arc.centre[0]) / arc.radius[0];
  if (Math.abs(t) > 1) return null;
  return arc.centre[1] - arc.radius[1] * Math.sqrt(1 - t * t);
}

/** A crescent's centreline in (across, along), as `KestrelRoads` sweeps it. */
export function kestrelArcPoints(arc: RoadArc, step = 4) {
  const [cx, cz] = arc.centre;
  const [ra, rb] = arc.radius;
  const steps = Math.max(24, Math.round((Math.PI * (ra + rb)) / 2 / step));
  const out: Array<[number, number]> = [];
  for (let k = 0; k <= steps; k++) {
    const t = Math.PI * (1 - k / steps);
    out.push([cx + ra * Math.cos(t), cz - rb * Math.sin(t)]);
  }
  return out;
}

export interface RoadNode {
  piece: Piece;
  /** Across the running line, and along it: the station's own frame. */
  across: number;
  along: number;
  turn: number;
  label: string;
}

export interface RoadRun {
  from: readonly [number, number];
  to: readonly [number, number];
  label: string;
}

/**
 * Which piece goes at a junction, and which way it is turned.
 *
 * Worked out from the arms rather than written down per node, because
 * fourteen-odd nodes hand-assigned is fourteen chances to put a corner on
 * backwards — and a corner on backwards is a road that stops dead with a kerb
 * across it, which is easy to miss from the air and impossible to miss in a
 * car.
 *
 * The kit describes its pieces against ITS axes (`roadConfig`): at turn 0 a
 * `cornerL` has arms +X and −Z and a `junctionT` has +X, −X and −Z. Here +X is
 * across — north, away from the railway — and +Z is along, east. A rotation of
 * θ sends +X to (cos θ, −sin θ) and −Z to (−sin θ, −cos θ) in (across, along),
 * which gives the four orientations of each piece tabulated below.
 */
type Arm = 'N' | 'S' | 'E' | 'W';
const QUARTER = Math.PI / 2;

/** `cornerL` by its two arms; `junctionT` by the stem, the arm off the bar. */
const CORNER: Record<string, number> = {
  NW: 0, WS: QUARTER, SE: Math.PI, EN: -QUARTER,
};
const TEE: Record<Arm, number> = { W: 0, S: QUARTER, E: Math.PI, N: -QUARTER };

function junction(arms: readonly Arm[]): { piece: Piece; turn: number } {
  if (arms.length >= 4) return { piece: 'junctionX', turn: 0 };
  if (arms.length === 3) {
    // The stem is whichever arm has no opposite in the set.
    const opposite: Record<Arm, Arm> = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const stem = arms.find((a) => !arms.includes(opposite[a]))!;
    return { piece: 'junctionT', turn: TEE[stem] };
  }
  const key = Object.keys(CORNER).find((k) => k.split('').every((c) => arms.includes(c as Arm)))!;
  return { piece: 'cornerL', turn: CORNER[key] };
}

/** The avenue indices that reach cross street `j`, innermost first. */
const spanning = (j: number) => AVENUES
  .map((a, i) => ({ a, i }))
  .filter(({ a }) => a.from <= j && j <= a.to)
  .map(({ i }) => i);


/**
 * The grid's junctions: one at every avenue/cross-street crossing.
 *
 * The arms are worked out rather than assigned. North exists when the next
 * avenue out also reaches this cross street and the bay between them is not a
 * curve; east exists when this avenue itself reaches the next cross. That is
 * what makes the ragged edges come out right — the dock road's east end is a
 * corner because the avenue stops there, and the stage avenue's node at the
 * same cross is a T because there is nothing north of it any more.
 */
/**
 * Grid corners turned into swept bends instead of a kit corner tile.
 *
 * The stage avenue's east end, where it turns south down the crossing street
 * toward the station avenue: a square corner there read as an intersection
 * with two roads missing, and the user asked for an arc. A 32 m radius is the
 * largest the assembly hall's block takes with the hall a little way along it
 * (`kestrelHalls`); the two streets stop `radius` short of the corner and the
 * bend joins them (`KESTREL_SWEEPS`).
 */
export const ARC_CORNERS: ReadonlyArray<{ across: number; along: number; radius: number; label: string }> = [
  { across: avenue('stage avenue'), along: CROSSING_ALONG, radius: 32, label: 'stage corner' },
];
const arcCornerAt = (across: number, along: number) => ARC_CORNERS.find(
  (c) => Math.abs(c.across - across) < 0.5 && Math.abs(c.along - along) < 0.5,
);

const GRID_NODES: RoadNode[] = AVENUES.flatMap((avenue, i) => (
  CROSS.slice(avenue.from, avenue.to + 1).flatMap((along, k) => {
    const j = avenue.from + k;
    const here = spanning(j);
    const at = here.indexOf(i);
    const above = here[at + 1];
    const below = here[at - 1];
    const arms: Arm[] = [];
    // North and south exist only where the cross street actually has that bay:
    // the school's superblock is one that it has not. See `CROSSES`.
    if (below !== undefined && bay(j, below)) arms.push('S');
    if ((above !== undefined && bay(j, i)) || mouth(j, i)) arms.push('N');
    // West exists when the avenue carries on that way — past the first cross
    // street it does, and at the first one only if it has a radial out to the
    // crescent. Without that test the dock road, whose radial was turned off
    // for the mall, kept a crossroads with an arm pointing into a shop.
    if (j > avenue.from || (j === 0 && hasRadial(avenue))) arms.push('W');
    if (j < avenue.to) arms.push('E');
    // The way in from the mainland: the crossing comes up from the south into
    // the grid's south-east corner, which is therefore a T and not a corner.
    if (i === 0 && j === CROSS.length - 1) arms.push('S');
    // ...and the west crossing comes up into the south-WEST corner, which was
    // a T with the crescent and is now the only crossroads on this avenue.
    if (i === 0 && j === 0 && WEST_CROSSING) arms.push('S');
    if (arms.length < 2) return [];
    // A corner that is a swept bend has no tile.
    if (arcCornerAt(avenue.across, along)) return [];
    const { piece, turn } = junction(arms);
    return [{ piece, across: avenue.across, along, turn, label: `${avenue.label} at ${along}` }];
  })
));

export const KESTREL_NODES: readonly RoadNode[] = [
  ...GRID_NODES,
  /*
   * The bridge head: where the causeway lands, and a T on the shore road.
   *
   * The through road runs along the outer leg (−72) past here — west to the
   * dogleg and the west crossing, east to the stage cross — and the causeway
   * comes up into it from the south, so the causeway is the stem. It used to be
   * a plain corner (the road only went east); with the west crossing there is
   * now somewhere to turn west as well, which is what a landfall on a circuit
   * should offer.
   */
  (WEST_CROSSING
    ? { piece: 'junctionT' as Piece, across: LINK_OUTER, along: BRIDGE_ALONG, turn: TEE.S, label: 'bridge head' }
    : { piece: 'cornerL' as Piece, across: LINK_OUTER, along: BRIDGE_ALONG, turn: CORNER.SE, label: 'bridge head' }),
  // The two ends of the shore road bend in and out of the outer leg on swept
  // S-bends, not corners — see `WEST_BEND_END` and `KESTREL_SWEEPS`. The east
  // one runs straight into this corner up to the level crossing.
  { piece: 'cornerL', across: LINK_INNER, along: CROSS[5], turn: CORNER.NW, label: 'crossing approach' },
  // The west crossing's own corner: up from the shore road, round to the ramp.
  ...(WEST_CROSSING
    ? [{
      piece: 'cornerL' as Piece, across: LINK_INNER, along: WEST_ALONG,
      turn: CORNER.EN, label: 'west crossing turn',
    }]
    : []),
];

export const KESTREL_RUNS: readonly RoadRun[] = [
  // The avenues, in segments between the cross streets they meet. An end that
  // is a curve mouth takes no setback: the mouth IS the end of the run, where a
  // junction tile occupies half a width of it.
  ...AVENUES.flatMap((avenue, i) => (
    CROSS.slice(avenue.from, avenue.to).map((from, k) => {
      const j = avenue.from + k;
      return {
        from: [avenue.across, from + HALF] as const,
        to: [avenue.across, CROSS[j + 1] - (arcCornerAt(avenue.across, CROSS[j + 1])?.radius ?? HALF)] as const,
        label: `avenue ${i} bay ${j}`,
      };
    })
  )),

  // The cross streets, between consecutive avenues that both reach them.
  ...CROSS.flatMap((along, j) => {
    const here = spanning(j);
    return here.slice(0, -1).filter((lo) => bay(j, lo)).map((lo) => ({
      from: [AVENUES[lo].across + HALF, along] as const,
      to: [
        AVENUES[here[here.indexOf(lo) + 1]].across
          - (arcCornerAt(AVENUES[here[here.indexOf(lo) + 1]].across, along)?.radius ?? HALF),
        along,
      ] as const,
      label: `cross ${j} bay ${lo}`,
    }));
  }),

  // The radials: each avenue's west end, out from the first cross street to
  // wherever the crescent crosses its line. The two on the ends of the span
  // meet it at `CROSS[0]` itself and so have no radial at all.
  ...AVENUES.flatMap((avenue, i) => {
    if (avenue.from !== 0 || !hasRadial(avenue)) return [];
    const meets = crescentAlong(avenue.across);
    if (meets === null || CROSS[0] - meets < HALF * 2) return [];
    return [{
      from: [avenue.across, CROSS[0] - HALF] as const,
      to: [avenue.across, meets] as const,
      label: `radial ${i}`,
    }];
  }),

  // The bridge link. Its first leg starts at the viaduct's own deck end, which
  // `BRIDGE_OVERLAP` is set to land on this carriageway rather than short of
  // it, so the two meet without a stub of grass between them.
  // East of the bridge head as far as the east bend, which takes it the rest
  // of the way to the level crossing.
  {
    from: [LINK_OUTER, BRIDGE_ALONG + HALF],
    to: [LINK_OUTER, EAST_BEND_START],
    label: 'shore road east of the bridge',
  },
  /*
   * Up to the crossing, and then down from it on the other side.
   *
   * Two short runs with the railway between them, because what carries the road
   * over the rails is the crossing's own deck and ramps (`CROSSING_RAMP`), not
   * the kit. The north one is a stub — thirteen metres — and a kit straight
   * squashed to a fifth of its length carries its lane dashes at a fifth of
   * their spacing, which is the one place in this network you can see the fit
   * going on. It is that short because both things it joins are fixed: the
   * ramp ends where the station's outermost road lets it, and the south avenue
   * stands clear of the ballast.
   */
  {
    from: [LINK_INNER + HALF, CROSS[5]],
    to: [CROSSING_DECK_S - CROSSING_RAMP, CROSS[5]],
    label: 'crossing approach south',
  },
  {
    from: [CROSSING_DECK_N + CROSSING_RAMP, CROSS[5]],
    to: [AVENUES[0].across - HALF, CROSS[5]],
    label: 'crossing approach north',
  },

  /*
   * The west crossing, and the shore road it opens.
   *
   * Only ONE approach run, and it is the south one: the north ramp's foot
   * lands on the station avenue's kerb by construction (`rampNorth`), so there
   * is no carriageway between the junction and the hump — the junction tile's
   * own south edge is where the climb begins.
   *
   * The shore road then runs the length of the island at `LINK_INNER`, which
   * is the offset the existing link already uses for its last leg: far enough
   * south of the formation's toe to be clear of it everywhere — the toe is
   * never below −17 — and far enough north of the water to keep a verge, which
   * the outer leg's −72 would not be west of the bridge.
   */
  ...(WEST_CROSSING ? [
    {
      from: [WEST_CROSSING.fromAcross - WEST_CROSSING.ramp, WEST_ALONG] as const,
      to: [LINK_INNER + HALF, WEST_ALONG] as const,
      label: 'west crossing approach south',
    },
    // From the end of the west bend along the outer leg to the bridge head —
    // clear of the station's south side, where the building, its forecourt and
    // the relief-loop platform sit. See `WEST_BEND_END`.
    {
      from: [LINK_OUTER, WEST_BEND_END] as const,
      to: [LINK_OUTER, BRIDGE_ALONG - HALF] as const,
      label: 'shore road west of the bridge',
    },
  ] : []),
];

/**
 * The shore road's two S-bends. See `WEST_BEND_END`.
 *
 * The west one starts at the west crossing's corner tile and only exists with
 * it; without the west crossing there is nothing west of the bridge head to
 * bend towards.
 */
export const KESTREL_SWEEPS: readonly RoadSweep[] = [
  ...(WEST_CROSSING ? [{
    from: [LINK_INNER, WEST_ALONG + HALF] as const,
    to: [LINK_OUTER, WEST_BEND_END] as const,
    label: 'west shore bend',
  }] : []),
  {
    from: [LINK_OUTER, EAST_BEND_START] as const,
    to: [LINK_INNER, CROSS[5] - HALF] as const,
    label: 'east shore bend',
  },
  // The grid's swept corners: from the avenue into the cross street.
  ...ARC_CORNERS.map((c) => ({
    from: [c.across, c.along - c.radius] as const,
    to: [c.across - c.radius, c.along] as const,
    corner: [c.across, c.along] as const,
    label: `${c.label} bend`,
  })),
];

/**
 * Across of the shore road's south kerb at the bridge head: where the
 * viaduct's parapets have to stop (`IslandBridge`), or they stand on the
 * carriageway the deck runs onto.
 */
export const BRIDGE_HEAD_KERB = LINK_OUTER - HALF;

/** True when there is a station frame to lay all this in. */
export const KESTREL_ROADS_ENABLED = STATION_SITE !== null;
