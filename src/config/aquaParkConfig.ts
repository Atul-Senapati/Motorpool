import { PAVING } from './airportConfig';
import { ROAD_WIDTH } from './roadConfig';
import { APRON, WOD_SITE } from './wallOfDeathConfig';
import aquaData from './aquaParkData.json';

/**
 * Halcyon Aqua Park: the water park beside the Wall of Death.
 *
 * Halcyon Pier's fairground is south of the outer road; the drome stands
 * across the road from it, and this goes on the drome's east side, so the two
 * attractions north of the road face the fairground's main gate together and
 * the whole thing reads as one park split by its road.
 *
 * ## The ground, measured
 *
 * - **West:** the drome's forecourt runs to along 358 (`APRON.half` either
 *   side of the drum), so the park starts at 360.
 * - **South:** the outer road's north kerb, `across` 268.5; the park keeps
 *   six metres of entrance plaza in front of it.
 * - **East:** the bridge leaves the outer road at along 419.5 and swings
 *   north-east on a 52 m curve; its deck edge is at across ~270 by along 428,
 *   so the park stops there.
 * - **North:** the trunk's nearest track is at across 333; ten metres of
 *   grass are kept to its ballast.
 *
 * That window is 68 m by 52, and the model (in metres, `prepare-halls.mjs`
 * with its lawn plate taken off) is 74 by 56 — so it stands at 92%, a
 * difference no one will see in a water park.
 *
 * It is turned a quarter so its entrance building, which is on the model's +x
 * side, faces the road.
 */
export const AQUA = {
  model: aquaData.model,
  size: aquaData.size as [number, number, number],
  triangles: aquaData.triangles,
};

const SCALE = 0.92;
const FROM = WOD_SITE.along + APRON.half + 2;
/** The outer road's north kerb: its centreline plus half the kit's width (268.5). */
const KERB = (PAVING.outerRoad[2] + PAVING.outerRoad[3]) / 2 + ROAD_WIDTH / 2;
const PLAZA = 6;

export const AQUA_SITE = (() => {
  const length = AQUA.size[2] * SCALE;
  const depth = AQUA.size[0] * SCALE;
  const front = KERB + PLAZA;
  return {
    along: FROM + length / 2,
    across: front + depth / 2,
    /** Model +x (its entrance) onto island −z, toward the road. */
    turn: Math.PI / 2,
    scale: SCALE,
    footprint: [length, depth] as [number, number],
    /** The paved plaza between the kerb and the park's fence, and where the gate is. */
    plaza: { x0: FROM, x1: FROM + length, z0: KERB, z1: front },
    /** The entrance building's middle, along the road: the model's z −4.6 after the turn. */
    gateAlong: FROM + length / 2 - 4.6 * SCALE,
  };
})();

/** `[along0, along1, across0, across1]`, for `AirportIsland`'s tree scatter. */
export const AQUA_BOUNDS = [
  AQUA_SITE.plaza.x0 - 2, AQUA_SITE.plaza.x1 + 2, KERB, AQUA_SITE.across + AQUA_SITE.footprint[1] / 2 + 4,
] as const;

export const AQUA_PARK_ENABLED = true;
