import { ROAD_WIDTH } from './roadConfig';
import { avenue, CROSS } from './kestrelRoads';
import { STATION_SITE } from './stationConfig';
import justiceData from './justiceData.json';

/**
 * The Hall of Justice: Kestrel's civic block, opposite the park.
 *
 * The island's grid was laid with its blocks deliberately empty — a town that
 * has not been built yet. Three of them are now not empty: Kestrel Water in the
 * middle, St. Anjali's superblock at the west end, and this.
 *
 * ## Which block, and why this one
 *
 * The one bounded by the **station avenue** and the **stage avenue**, between
 * the park's cross street and the dock cross — which is to say the block
 * **directly across the stage avenue from Kestrel Water**.
 *
 * That is not a free choice among equals. A civic building wants three things
 * and this block is the only one on the island with all three: a whole block to
 * itself, so it is seen from four sides; something worth facing, which is the
 * park; and the arrival, because the station avenue runs down its other flank
 * and the station is at the end of it. The alternatives are the two blocks
 * further east, which face the level crossing and the bridge link — a hall of
 * justice looking at a road over a railway is a hall of justice on a bypass.
 *
 * It also completes the island as a plan rather than a list. The school holds
 * the west end, the park holds the middle, the civic block faces it across one
 * street, and the station is at the foot of the avenue between them.
 *
 * ## Why it is not full size
 *
 * The building is 113 m by 90. Kestrel's blocks are 93 m by 89 and **74 by 70
 * between the kerbs**, because `ROAD_WIDTH` is a generous 19 m and takes half a
 * block's width with it. Nothing short of deleting an avenue makes a 113 m
 * building fit, and the last time an avenue was deleted it was for a reason
 * (`AVENUES`) rather than to make one model fit.
 *
 * So it is fitted: the largest scale that leaves `VERGE` of grass on every
 * side, which comes out around 0.59 — 66 m by 53, and **17 m tall**. That last
 * number is the one that matters. At 17 m it is half again the height of the
 * school and twice the town's terraces, so it reads as the biggest thing on the
 * island bar the station roof, which is what a civic building is for. A
 * building whose job is to be the landmark can be reduced and still do its job;
 * what it cannot do is be somewhere you never look.
 */

/** Half the kit's carriageway: how far a kerb stands off an avenue's centre. */
const HALF = ROAD_WIDTH / 2;

/**
 * The block, as the four kerb lines round it.
 *
 * Streets by name and not by index, the same as `PARK_BLOCK` and
 * `SCHOOL_BLOCK`: deleting an avenue renumbers the list, and a block that moves
 * 47 m into the quay is not something a type error will catch.
 */
export const CIVIC_BLOCK = {
  acrossFrom: avenue('station avenue') + HALF,
  acrossTo: avenue('stage avenue') - HALF,
  alongFrom: CROSS[2] + HALF,
  alongTo: CROSS[3] - HALF,
} as const;

/** The hall, as `prepare-justice.mjs` measured it — the building, not the plot. */
export const JUSTICE = {
  model: justiceData.model,
  /** Width (X), height (Y), depth (Z), metres. */
  size: justiceData.size as [number, number, number],
  /** How far the plinth reaches below its deck. Buried, not stood on. */
  skirt: justiceData.skirt,
  triangles: justiceData.triangles,
};

/**
 * Grass between the hall and the kerb, metres.
 *
 * Five. A civic building of this kind stands in its own ground rather than on
 * the back of the pavement — the steps need somewhere to come down to — and
 * five metres is the least that reads as ground rather than as a gap. It is
 * bought out of the building's size and nothing else, so it is exactly as
 * expensive as it looks.
 */
const VERGE = 5;

/**
 * Which way round it stands.
 *
 * Zero: the model's own +X is its front, and at turn 0 the group's local X is
 * `across`, which points at the park. This is the one thing about the hall that
 * is not measured — `prepare-stage.mjs` can count triangles either side of a
 * stage deck and `prepare-school.mjs` can find playing fields by name, but a
 * symmetrical colonnaded block gives neither test anything to bite on. It was
 * set by standing in front of it.
 */
const FRONT_TURN = 0;

/**
 * The hall, placed: the middle of the block, square to it, fitted to it.
 *
 * Turned to face the park. In the station's frame the group's local X is
 * `across` and its local Z is `along`, and the park is at greater `across`, so
 * the model's front has to end up pointing that way — see `FRONT_TURN`, which
 * is the one number here that was set by looking.
 */
export const CIVIC_SITE = (() => {
  if (!STATION_SITE) return null;
  const width = CIVIC_BLOCK.acrossTo - CIVIC_BLOCK.acrossFrom;
  const length = CIVIC_BLOCK.alongTo - CIVIC_BLOCK.alongFrom;
  const scale = Math.min(
    1,
    (width - VERGE * 2) / JUSTICE.size[0],
    (length - VERGE * 2) / JUSTICE.size[2],
  );
  if (scale <= 0) return null;
  return {
    across: (CIVIC_BLOCK.acrossFrom + CIVIC_BLOCK.acrossTo) / 2,
    along: (CIVIC_BLOCK.alongFrom + CIVIC_BLOCK.alongTo) / 2,
    scale,
    turn: FRONT_TURN,
    /** What it came out as: footprint across and along, and height. */
    footprint: [JUSTICE.size[0] * scale, JUSTICE.size[2] * scale] as [number, number],
    height: JUSTICE.size[1] * scale,
    /** The verge it actually got, across and along. Reported, not assumed. */
    verge: [
      (width - JUSTICE.size[0] * scale) / 2,
      (length - JUSTICE.size[2] * scale) / 2,
    ] as [number, number],
    block: [width, length] as [number, number],
  };
})();

/** Nothing to build without a station frame to build it in. */
export const CIVIC_ENABLED = CIVIC_SITE !== null;
