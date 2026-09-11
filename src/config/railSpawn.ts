import { DOWN, UP } from './pointwork';

/**
 * Which running line the player's train starts on — decided once, read by two
 * modules that must not disagree.
 *
 * `TrainRide` needs it to place and face the locomotive. `TrainLine` needs it
 * for the opposite reason: to keep its own services OFF that road, because a
 * service sharing a running line with the player is a head-on or a 150 km/h
 * roadblock with no way past. When the choice lived in `TrainRide` the two
 * could not agree — the ride picked a road at random and the line went on
 * putting all four of its trains on the down line regardless, so a down-line
 * spawn met nothing coming the other way and caught up to same-line traffic
 * instead. One cached answer, read by both, and the render order stops
 * mattering.
 *
 * Not cached on the server: there is no URL and no draw there, and a value
 * decided during prerender would be baked into the build.
 */
const ROAD_PARAM = 'road';
let chosen: number | null = null;

export function playerRoad(): number {
  if (chosen !== null) return chosen;
  if (typeof window === 'undefined') return UP;
  const requested = new URLSearchParams(window.location.search).get(ROAD_PARAM);
  chosen = requested === 'down' ? DOWN
    : requested === 'up' ? UP
      : Math.random() < 0.5 ? UP : DOWN;
  return chosen;
}

/**
 * Which way a train on `road` travels, as a sign on arc length.
 *
 * **This railway runs on the right**, like its roads, and this is the only
 * place that is decided: the player takes it through `TrainRide`'s `FACING`,
 * the AI services through `Service`'s `direction`, so the two cannot end up
 * working a road in opposite senses.
 *
 * The up line is the running line itself and runs up the arc; the down line is
 * `secondTrackGap` along `trainNormalAt`, which is the LEFT of increasing arc,
 * and runs back down it. Each driver therefore has the other road on his left,
 * which is what driving on the right means.
 *
 * This was briefly inverted on the strength of a misread screenshot, and the
 * live line said so plainly: with both roads reversed, the other track sat on
 * the driver's RIGHT on both of them. If this is ever in doubt again, do not
 * squint at a chase view — the rig is offset to one side and will mislead you.
 * Take the driver's forward `f`, form his left as `(f.z, -f.x)`, and dot it
 * with the vector to the other road's centreline. Positive is left, and left is
 * correct.
 */
export const runsAlongArc = (road: number): 1 | -1 => (road === DOWN ? -1 : 1);
