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
 *   the viaduct   the piers of the road crossing at `BRIDGE.x`, which are
 *                 solid ground the raster has never heard of because they are
 *                 built at runtime. Only the piers: the arches between them
 *                 are open water and a hull can sail through
 *
 * A boat that hits any of them is aground. The test is deliberately generous
 * — it keeps a hull's length clear of the shore rather than its exact outline
 * — because running gently aground and stopping is a much better failure than
 * a 200 m ferry pushing its bow through a beach.
 */
import { BRIDGE } from '@/config/stationConfig';
import { TRAIN_ISLANDS } from '@/config/trainConfig';
import {
  COUNTRY_ENABLED, OUTLINE_WORLD as COUNTRY_OUTLINE, PIER, SITE as COUNTRY_SITE, toWorld as countryWorld,
} from '@/config/countryConfig';

/** The harbour pier, as a thin closed outline round its line, in world XZ. */
const PIER_OUTLINE: ReadonlyArray<[number, number]> = (() => {
  const half = PIER.width / 2 + 1;
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  const pts = PIER.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const nz = (b[0] - a[0]) / len;
    left.push(countryWorld(pts[i][0] + nx * half, pts[i][1] + nz * half));
    right.push(countryWorld(pts[i][0] - nx * half, pts[i][1] - nz * half));
  }
  return [...left, ...right.reverse()];
})();
const PIER_CENTRE = countryWorld(PIER.pts[1][0], PIER.pts[1][1]);
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
 * their outlines outward from the wall face.
 *
 * It used to grow them through the *beach* as well — `island.shore`, 26 m of
 * sand shelving to the seabed, which a hull would ground on long before it
 * reached the land. There is no beach now: the wall is vertical and the outline
 * is the edge (`ISLAND_COPING`), so deep water starts at the face and the only
 * standoff a boat needs is its own. `SHORE_MARGIN` keeps it off the concrete.
 */
/**
 * Every island with a wall: the railway's two, and Skylark. Halcyon Field is
 * not here — it never was, and the shipping lanes are laid clear of it by
 * hand (`boatConfig`) — but Skylark sits in open water south of the airfield
 * where a boat can wander, and its cliffs are as solid as any wall.
 */
const WALLED: ReadonlyArray<{ outline: ReadonlyArray<readonly [number, number]>; centre: readonly [number, number]; reach: number }> = [
  ...TRAIN_ISLANDS.map((i) => ({ outline: i.outline, centre: i.centre, reach: 400 })),
  ...(COUNTRY_ENABLED ? [
    { outline: COUNTRY_OUTLINE, centre: COUNTRY_SITE.centre, reach: 760 },
    // The pier stands in open water off the outline, and a hull goes round it.
    { outline: PIER_OUTLINE, centre: PIER_CENTRE, reach: 120 },
  ] : []),
];

export function afloatAt(x: number, z: number, clearance = 0): boolean {
  for (const island of WALLED) {
    // Cheap reject first: the outline test is a loop over every vertex and
    // this runs per boat per step.
    const dx = x - island.centre[0];
    const dz = z - island.centre[1];
    const reach = clearance + island.reach;
    if (dx * dx + dz * dz > reach * reach) continue;
    if (inside(island.outline, x, z)) return false;
    // Just the hull's own room off a vertical wall, where it used to be that
    // plus 60 % of the beach.
    const margin = clearance + SHORE_MARGIN;
    if (nearOutline(island.outline, x, z, margin)) return false;
  }

  // The road crossing used to be a causeway, and a causeway is a wall: the
  // whole corridor between the two shores was aground, because a bank is
  // ground the whole way across. It is a viaduct on piers now, so the water
  // runs through it and the only thing in a hull's way is the piers
  // themselves — which is the point of having built it.
  if (BRIDGE) {
    const north = Math.min(BRIDGE.islandZ, BRIDGE.cityZ);
    const south = Math.max(BRIDGE.islandZ, BRIDGE.cityZ);
    if (z > north - clearance && z < south + clearance
      && Math.abs(x - BRIDGE.x) < BRIDGE.crownHalf + clearance) {
      // Along the crossing from the city end, which is how the arches are laid
      // out — see `layOpenings`. Anything not inside an opening is masonry.
      const run = south - north;
      const along = south - z;
      const A = BRIDGE.arch;
      const mid = run / 2;
      const pitch = A.sideSpan + A.pier;
      const half = A.mainSpan / 2;
      const off = Math.abs(along - mid);
      // Inside the navigation arch: deep water, and 48 m of it.
      if (off > half) {
        // Outside it, the bays repeat: pier, arch, pier, arch. A hull is clear
        // only while it is inside an arch, and `SHORE_MARGIN` keeps it off the
        // masonry either side rather than letting it graze the stone.
        const bay = (off - half) % pitch;
        const inArch = bay > A.pier + SHORE_MARGIN && bay < pitch - SHORE_MARGIN;
        if (!inArch) return false;
        // Past the last arch there is only abutment.
        if (off - half > A.pier + A.sides * pitch) return false;
      }
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
