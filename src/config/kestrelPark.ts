import { ROAD_WIDTH } from './roadConfig';
import { avenue, CROSS } from './kestrelRoads';
import { STATION_SITE, stationPoint } from './stationConfig';

/**
 * Kestrel Water: a pond in the middle of the island, and the park round it.
 *
 * The island is infrastructure end to end — a station, a freight yard, a cruise
 * berth, a stage, a viaduct and now a street grid with fourteen empty blocks in
 * it. Empty blocks are *waiting* ground: they read as a city that has not been
 * built yet rather than as a city with space in it. One of them is therefore
 * not a block at all but a park, with water in it, which is the one thing on
 * this island that is not made of concrete.
 *
 * ## Where
 *
 * The island's own centroid is at across 118, along −12 — and that lands on a
 * cross street, in the narrowest column the grid has: the middle and stage
 * avenues are 46.6 m apart, so a pond there would be 28 m of water between two
 * kerbs with nowhere to put a bank, let alone a tree. The nearest block that
 * can actually hold one is the next column out, across 149.2 to 242.4 by along
 * −12 to 77 — **93 by 89 metres**, the largest block in the grid, and its
 * centre is 100 m from the centroid on an island 575 m long. That is the middle
 * of the island as anyone standing on it would use the word.
 *
 * ## Why it is dug rather than drawn
 *
 * The park kit has a `pond` part and it is a **flat 17 m disc with 32
 * triangles** — a decal, for standing in a fairground. Water reads as water
 * because the ground goes down to meet it: a disc laid on a lawn reads as a
 * puddle of paint at any angle but straight down.
 *
 * So the ground is actually opened. `POND_HOLE` is cut out of the island's
 * crown (`buildIslands`, which triangulates round it), and `KestrelPark` builds
 * a basin through the hole — bank, waterline shelf, dished bed — with the water
 * surface laid across it. The basin carries its own collider, because a hole in
 * the crown with nothing under it is a hole in the *world*.
 *
 * ## The shape
 *
 * A polar blob, the same construction Skylark Water uses (`lakeRadius`): an
 * ellipse with three harmonics on it, which gives an outline with bays and
 * points in it and no straight edges anywhere. A circle would read as a
 * reservoir and a rectangle as a dock, and this is meant to read as neither.
 */

/** Half the kit's carriageway: how far a kerb stands off an avenue's centre. */
const HALF = ROAD_WIDTH / 2;

/**
 * The block the park occupies, as the four kerb lines round it.
 *
 * Indices rather than numbers so it stays attached to the grid: if an avenue
 * moves, the park moves with it instead of being left in the road.
 */
export const PARK_BLOCK = {
  /** Between the stage avenue and the dock road. By name: see `avenue`. */
  acrossFrom: avenue('stage avenue') + HALF,
  acrossTo: avenue('dock road') - HALF,
  /** Between the third and fourth cross streets. */
  alongFrom: CROSS[2] + HALF,
  alongTo: CROSS[3] - HALF,
} as const;

const MID_ACROSS = (PARK_BLOCK.acrossFrom + PARK_BLOCK.acrossTo) / 2;
const MID_ALONG = (PARK_BLOCK.alongFrom + PARK_BLOCK.alongTo) / 2;

/**
 * The water, in the station's own (across, along).
 *
 * `rx` runs across the island and `rz` along it, and the block is 74 m by 70 m
 * inside its kerbs — so 22 by 19, plus up to 16% of harmonic, leaves a good
 * twelve metres of grass between the widest part of the bank and the nearest
 * kerb. That margin is what the planting goes in, and it is checked below
 * rather than trusted.
 *
 * `depth` is to the middle of the bed. Two metres is nothing for a lake and
 * plenty for this: the water is opaque enough that what is under it is a tone
 * rather than a shape, and a deep bed only costs triangles and a longer fall
 * for anything that drives in.
 */
export const POND = {
  across: MID_ACROSS,
  along: MID_ALONG,
  rx: 22,
  rz: 19,
  /** Bed depth below the island crown, at the middle. */
  depth: 2,
  /** Water surface below the crown. */
  surface: 0.55,
  /**
   * Where the bank stops falling and the bed starts dishing, as a fraction of
   * the rim radius. The shelf sits just under the waterline, so the bank goes
   * *into* the water rather than stopping at it — a bank that stops exactly at
   * the surface leaves a rim of z-fighting all the way round.
   */
  shelf: 0.88,
  /** How far under the surface that shelf sits. */
  shelfDrop: 0.2,
} as const;

/** The rim's radius at `theta`, measured from the pond's middle. */
export function pondRadius(theta: number): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const ellipse = (POND.rx * POND.rz) / Math.hypot(POND.rz * c, POND.rx * s);
  return ellipse * (1 + 0.09 * Math.sin(2 * theta + 0.7) + 0.06 * Math.sin(3 * theta + 2.3)
    + 0.035 * Math.sin(5 * theta - 1.1));
}

/** How many points the rim is sampled at. Everything else follows this. */
export const POND_STEPS = 72;

/** The rim, in the station's frame: `[across, along]` a step at a time. */
export const POND_RIM: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: POND_STEPS },
  (_, i) => {
    const theta = (i / POND_STEPS) * Math.PI * 2;
    const r = pondRadius(theta);
    return [POND.across + r * Math.cos(theta), POND.along + r * Math.sin(theta)] as const;
  },
);

/**
 * The same rim in world XZ, which is what the crown has to be cut round.
 *
 * `null` when there is no station frame to place it in — the island is the
 * station's host, so without one there is no island either.
 */
export const POND_HOLE: ReadonlyArray<readonly [number, number]> | null = STATION_SITE
  ? POND_RIM.map(([across, along]) => {
    const [x, , z] = stationPoint(along, across);
    return [x, z] as const;
  })
  : null;

/**
 * Height of the basin at `f`, the fraction of the way out to the rim.
 *
 * Two pieces that meet at `shelf` with the same value on both sides:
 *
 * - **outside it**, the bank, easing from the crown at the rim down to the
 *   shelf with a smoothstep, so the lip is a rounded brow rather than a
 *   chamfer;
 * - **inside it**, the bed, a quadratic dish from the shelf to the deepest
 *   point, which is the profile a dug pond silts itself into.
 *
 * Returned as a drop below the crown, positive downward, because every caller
 * wants it relative to ground.
 */
export function pondDrop(f: number): number {
  const shelfDrop = POND.surface + POND.shelfDrop;
  if (f >= POND.shelf) {
    const t = (f - POND.shelf) / (1 - POND.shelf);
    const ease = t * t * (3 - 2 * t);
    return shelfDrop * (1 - ease);
  }
  const t = f / POND.shelf;
  return POND.depth - (POND.depth - shelfDrop) * t * t;
}

/**
 * Where the bank crosses the waterline, as a fraction of the rim radius.
 *
 * Solved rather than stated, so the water's edge is on the bank by
 * construction however `pondDrop` is retuned. Bisection over the bank segment,
 * which is monotonic in `f` — thirty steps is far finer than a vertex.
 */
export const POND_WATERLINE = (() => {
  let lo: number = POND.shelf;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (pondDrop(mid) > POND.surface) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
})();

/**
 * How much room the bank leaves between itself and the block's kerbs.
 *
 * Reported rather than asserted. The pond is hand-sized and hand-placed and
 * the numbers above are chosen against this one, so what is wanted is for it
 * to be visible when it goes wrong — and what "wrong" means is not zero but
 * *too small to plant*, which no assertion can name.
 */
export const POND_MARGIN = (() => {
  let out = Infinity;
  for (const [across, along] of POND_RIM) {
    out = Math.min(
      out,
      across - PARK_BLOCK.acrossFrom, PARK_BLOCK.acrossTo - across,
      along - PARK_BLOCK.alongFrom, PARK_BLOCK.alongTo - along,
    );
  }
  return out;
})();

/** Nothing to build without a station frame to build it in. */
export const KESTREL_PARK_ENABLED = STATION_SITE !== null;
