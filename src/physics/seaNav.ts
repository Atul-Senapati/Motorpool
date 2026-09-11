/**
 * Where a boat can be: the sea, and nothing else.
 *
 * There is no map of the water and there does not need to be one — the water
 * is everywhere the land is not, and the land is already described three
 * times over by things this can ask:
 *
 *   the islands   `TRAIN_ISLANDS` carries each traced outline and the width of
 *                 its beach, so an island is a polygon test plus a margin
 *   the city      the nav raster knows the height of every paved surface, and
 *                 a paved surface above the waterline is a quay, a slipway or
 *                 a coast road — all of them land
 *   the causeway  a corridor round `BRIDGE.x` between the two shores, which is
 *                 solid ground the raster has never heard of because it is
 *                 built at runtime
 *
 * A boat that hits any of them is aground. The test is deliberately generous
 * — it keeps a hull's length clear of the shore rather than its exact outline
 * — because running gently aground and stopping is a much better failure than
 * a 200 m ferry pushing its bow through a beach.
 */
import { BRIDGE } from '@/config/stationConfig';
import { TRAIN_ISLANDS } from '@/config/trainConfig';
import { SEA_LEVEL } from '@/config/seaConfig';
import { groundHeightAt } from './cityNav';

/** How far off the beach a hull is turned away. */
const SHORE_MARGIN = 6;
/** Paved ground this far above the waterline is land, not a slipway. */
const LAND_HEIGHT = SEA_LEVEL + 0.4;

/** Point in polygon, the same ray test `stationConfig` uses on these outlines. */
function inside(outline: ReadonlyArray<readonly [number, number]>, x: number, z: number) {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, zi] = outline[i];
    const [xj, zj] = outline[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Is there water at this point — enough of it to float in?
 *
 * `clearance` is how much room the hull wants around the point, so a ferry
 * keeps further off than a dinghy. It is applied to the islands by growing
 * their outlines outward through the beach, which is what `shore` already
 * measures.
 */
export function afloatAt(x: number, z: number, clearance = 0): boolean {
  for (const island of TRAIN_ISLANDS) {
    // Cheap reject first: the outline test is a loop over every vertex and
    // this runs per boat per step.
    const dx = x - island.centre[0];
    const dz = z - island.centre[1];
    const reach = island.shore + clearance + 400;
    if (dx * dx + dz * dz > reach * reach) continue;
    if (inside(island.outline, x, z)) return false;
    // Beyond the outline the beach still shelves down to the seabed, so the
    // water is only deep enough a little way out.
    const margin = island.shore * 0.6 + clearance + SHORE_MARGIN;
    if (nearOutline(island.outline, x, z, margin)) return false;
  }

  if (BRIDGE) {
    const north = Math.min(BRIDGE.islandZ, BRIDGE.cityZ);
    const south = Math.max(BRIDGE.islandZ, BRIDGE.cityZ);
    if (z > north - clearance && z < south + clearance) {
      // The causeway's bank batters out as it climbs; this is its widest.
      const half = BRIDGE.crownHalf + BRIDGE.slope * (BRIDGE.islandY - BRIDGE.toe) + clearance;
      if (Math.abs(x - BRIDGE.x) < half) return false;
    }
  }

  const ground = groundHeightAt(x, z);
  if (ground !== null && ground > LAND_HEIGHT) return false;

  return true;
}

/** Within `margin` of any edge of the outline. */
function nearOutline(
  outline: ReadonlyArray<readonly [number, number]>,
  x: number,
  z: number,
  margin: number,
): boolean {
  const m2 = margin * margin;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, zi] = outline[i];
    const [xj, zj] = outline[j];
    const ex = xj - xi;
    const ez = zj - zi;
    const len2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((x - xi) * ex + (z - zi) * ez) / len2));
    const px = xi + ex * t - x;
    const pz = zi + ez * t - z;
    if (px * px + pz * pz < m2) return true;
  }
  return false;
}
