import { ROAD_WIDTH } from './roadConfig';
import { CROSS, KESTREL_ARCS, KESTREL_RADIALS } from './kestrelRoads';
import { STATION_SITE } from './stationConfig';
import mallData from './mallData.json';

/**
 * The mall, inside the ring road at the west end of the island.
 *
 * ## Why here
 *
 * The ring road (`KESTREL_ARCS`) is a semicircle 116.5 m in every direction
 * with its straight side on the cross street at −190, and what it encloses is
 * a **half disc of grass 233 m across and 116 deep** — the largest single piece
 * of open ground left on Kestrel, and the only one that has never had anything
 * proposed for it. It is also the one piece of ground on this island with a
 * road right round it, which is what a mall wants and what nothing else here
 * has: every other site has a frontage, and a mall has an outside.
 *
 * It faces the ring road's **straight side**, the chord — 233 m of it, and the
 * longest run of kerb on the island. That is the side the grid arrives on, so
 * the mall is seen front-on from the town and in the round from the ring.
 *
 * ## Why it is 45% of itself
 *
 * The model is **396 m long**. Nothing in this world is within a factor of two
 * of that: the school's campus is 147, the Hall of Justice 113, the station's
 * platforms 130. It is longer than the half disc is wide.
 *
 * So it is fitted, and the fit is a real piece of geometry rather than a
 * division. A rectangle inside a half disc with one side on the diameter has
 * its two far corners ON the rim, so for a building of a known aspect ratio the
 * largest that fits is the solution of `(W/2)² + (setback + D)² = r²` with
 * `W = aspect · D`. `MALL_SITE` solves it.
 *
 * It comes out at 0.452: **179 m long, 49 deep, 11.7 m tall**, with its front
 * face on the chord's kerb and both back corners exactly on the arc's — stuck
 * to the road on three sides, which is what a solved fit looks like.
 *
 * ## The road that was in the way
 *
 * The dock road threw a radial down through the middle of this ground, from the
 * chord to the arc, and the first fit put 25 m of shopping centre across its
 * carriageway. Squeezing the mall to the west of it cost a sixth of the
 * building — 154 m instead of 179 — so the radial went instead (`hasRadial`).
 *
 * Nothing is stranded by that. The ring road is a LOOP: the dock road still
 * reaches the chord, and the chord still reaches the ring at both its ends. The
 * radial was a spur into a field, and the field now has a building on it.
 *
 * Which is still the longest building in this world — thirty metres longer than
 * the school's campus — and 11.7 m is about what a real single-storey mall
 * stands at; the source's 26 m is its anchor towers. Of everything scaled to
 * fit a site here this is the one that loses least by it: a mall is long blank
 * walls and a big roof, and neither has a detail that 45% spoils.
 */

/** Half the kit's carriageway: how far a kerb stands off a road's centreline. */
const HALF = ROAD_WIDTH / 2;

/** The mall, as `prepare-mall.mjs` measured it. */
export const MALL = {
  model: mallData.model,
  /** Width (X), height (Y), depth (Z), metres. */
  size: mallData.size as [number, number, number],
  /** How far the slab reaches below its deck. Buried, not stood on. */
  skirt: mallData.skirt,
  triangles: mallData.triangles,
};

/**
 * Grass between the mall and the ring road's kerbs, metres.
 *
 * **None.** It was eight, on the argument that a building wants ground round
 * it — and eight metres of lawn between a mall and its road is not grounds, it
 * is a mall parked in the middle of a field. A mall goes right up to the kerb:
 * that is what the kerb is for, and it is what tells you the road round it is
 * its road.
 *
 * So the front face sits ON the chord's kerb and both back corners ON the
 * arc's — the same solved fit with the margin taken out, which also buys 22 m
 * of length back, because every metre of verge costs two.
 */
const VERGE = 0;

/**
 * The mall, placed and fitted.
 *
 * Two constraints, and both are tight at the answer: the **front face** sits on
 * the chord's kerb, and the two **back corners** sit on the arc's.
 *
 * A third used to bind — the dock road's radial, which ran through this ground
 * until it was turned off for the building. The code still reads the live list
 * of radials (`KESTREL_RADIALS`) rather than assuming there are none, so one
 * turned back on would push the mall west instead of running through it.
 *
 * Solved by bisection rather than algebra. With the radial in, the closed form
 * stops being a quadratic and starts being a case analysis; forty halvings of a
 * number between 0 and 1 is exact to eight decimal places and obviously
 * correct, which the case analysis would not be.
 */
export const MALL_SITE = (() => {
  const arc = KESTREL_ARCS[0];
  if (!STATION_SITE || !arc) return null;
  /** How far the ground reaches from the ring's centre, and where it starts. */
  const r = arc.radius[1] - HALF - VERGE;
  const setback = HALF + VERGE;
  /**
   * The nearest radial's kerb east of the ring's centre: nothing may cross it.
   *
   * There are none at the moment — the dock road's was turned off for this
   * building (`hasRadial`) — so this is `Infinity` and only the arc binds. It
   * is read rather than assumed because a radial turned back on has to push the
   * mall out of the way rather than run through it.
   */
  const radial = Math.min(
    Infinity,
    ...KESTREL_RADIALS.filter((at) => at > arc.centre[0]).map((at) => at - HALF - VERGE),
  );

  /**
   * Where the mall's middle may sit at a given scale, or null if it may not.
   *
   * `x` is how far either back corner may stand off the ring's centreline
   * before it leaves the arc — the half-width of the disc at that depth. The
   * window is what both that and the radial leave.
   */
  const windowAt = (scale: number): [number, number] | null => {
    const width = MALL.size[0] * scale;
    const depth = MALL.size[2] * scale;
    const reach = r * r - (setback + depth) ** 2;
    if (reach <= 0) return null;
    const x = Math.sqrt(reach);
    const lo = arc.centre[0] - x + width / 2;
    const hi = Math.min(arc.centre[0] + x, radial) - width / 2;
    return hi >= lo ? [lo, hi] : null;
  };

  let lo = 0;
  let hi = 1;
  if (!windowAt(lo)) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (windowAt(mid)) lo = mid; else hi = mid;
  }
  const scale = lo;
  const window = windowAt(scale);
  if (!window || scale <= 0) return null;

  const width = MALL.size[0] * scale;
  const depth = MALL.size[2] * scale;
  return {
    /** As far east as the radial allows: its service end against that road. */
    across: window[1],
    /** Its middle, which is `setback` plus half its depth past the chord. */
    along: CROSS[0] - setback - depth / 2,
    scale,
    /**
     * Square to the chord, and no turn at all.
     *
     * The group's local X is `across` and its local Z is `along`, and the
     * model's long axis is its own X — so at turn 0 the mall lies along the
     * chord and its front, which is +Z, looks back at it. Both of those are
     * what is wanted, which happens about once.
     */
    turn: 0,
    footprint: [width, depth] as [number, number],
    height: MALL.size[1] * scale,
    /** The half disc it went into, for the log: across by deep. */
    disc: [arc.radius[0] * 2, arc.radius[1]] as [number, number],
  };
})();

/** Nothing to build without a station frame, or without a ring road. */
export const MALL_ENABLED = MALL_SITE !== null;
