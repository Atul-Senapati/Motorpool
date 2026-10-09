import { CITY } from '@/config/cityConfig';
import {
  BOUNDS, ROAD_BRIDGES, CHURCH, COUNTRY_ENABLED, FORT_CARPARK, HARBOUR, HILL_FARM, HOME_FARM, JUNCTIONS,
  PIER, SITE, SUMMIT, VIEWPOINT, groundAt, inIsland, roadEdgeAt, roadLevelAt, toLocal,
} from '@/config/countryConfig';
import { ROAD_TOP } from '@/config/roadConfig';

/**
 * Skylark, as something the nav queries can read.
 *
 * The same idea as `townNav`, and consulted from the same three places in
 * `cityNav`: the island is drawn at runtime from `countryConfig`, so it is not
 * in the baked raster, and without this every query on it came back "no
 * ground" — no tyre marks, R dropping you back in the city, an aircraft that
 * could not tell where the hill was.
 *
 * A patch on the city's own grid, so a pixel index means the same thing in
 * both. Built lazily on first use, off `groundAt` — the island's one height
 * function — and the carve distance field, so the raster, the collider and
 * the mesh cannot disagree. Three kinds: `ROAD` where a lane or the bridge
 * deck is, `PAVED` on the yards and the car park, and grass everywhere else
 * on the island, which is walkable ground with a height but takes no mark.
 */

const NONE = 0;
const GRASS = 1;
const PAVED = 2;
const ROAD = 3;

interface Patch {
  px0: number;
  pz0: number;
  width: number;
  height: number;
  kind: Uint8Array;
  y: Float32Array;
}

let patch: Patch | null = null;
let built = false;

/** The deck's height at a world point that is on it, or null off it. */
function deckAt(wx: number, wz: number): number | null {
  for (const B of ROAD_BRIDGES) {
    const dx = wx - B.start[0];
    const dz = wz - B.start[1];
    const s = dx * B.dir[0] + dz * B.dir[1];
    if (s < -1 || s > B.endS + 1) continue;
    const off = Math.abs(-dx * B.dir[1] + dz * B.dir[0]);
    if (off > B.halfWidth) continue;
    return B.topAt(s);
  }
  return null;
}

/**
 * The road surface at a world point on Skylark, exactly: what `build` samples
 * into the raster, without the raster's 1.5 m steps. The traffic drives on
 * this (`roadGraph`, `heightAt`): eased onto the raster instead, a car on a
 * slope rose a step at a time and bounced.
 */
export function countryRoadTop(wx: number, wz: number): number {
  const deck = deckAt(wx, wz);
  if (deck !== null) return deck;
  const [lx, lz] = toLocal(wx, wz);
  return (roadLevelAt(lx, lz) ?? groundAt(lx, lz)) + ROAD_TOP;
}

function build(): Patch | null {
  if (!COUNTRY_ENABLED) return null;
  const m = CITY.nav.metresPerPixel;
  const x0 = SITE.centre[0] + BOUNDS.x0;
  const x1 = SITE.centre[0] + BOUNDS.x1;
  const z0 = SITE.centre[1] + BOUNDS.z0;
  const z1 = SITE.centre[1] + BOUNDS.z1;
  // The bridges reach back to the airport and on to Petrel, so the box takes them in too.
  const ends = ROAD_BRIDGES.flatMap((b) => [b.start, b.end]);
  const bx0 = Math.min(x0, ...ends.map((e) => e[0] - 20));
  const bz0 = Math.min(z0, ...ends.map((e) => e[1] - 20));
  const bx1 = Math.max(x1, ...ends.map((e) => e[0] + 20));
  const bz1 = Math.max(z1, ...ends.map((e) => e[1] + 20));
  const px0 = Math.floor((bx0 - CITY.nav.originX) / m);
  const pz0 = Math.floor((bz0 - CITY.nav.originZ) / m);
  const px1 = Math.ceil((bx1 - CITY.nav.originX) / m);
  const pz1 = Math.ceil((bz1 - CITY.nav.originZ) / m);
  const width = px1 - px0 + 1;
  const height = pz1 - pz0 + 1;
  const kind = new Uint8Array(width * height);
  const y = new Float32Array(width * height);
  const yards = [
    { x: HOME_FARM.x, z: HOME_FARM.z, r: HOME_FARM.r - 4 },
    { x: HILL_FARM.x, z: HILL_FARM.z, r: HILL_FARM.r - 4 },
    { x: VIEWPOINT.x, z: VIEWPOINT.z, r: VIEWPOINT.r },
    { x: CHURCH.x, z: CHURCH.z, r: 8 },
    { x: HARBOUR.x, z: HARBOUR.z, r: HARBOUR.r - 6 },
    { x: SUMMIT.x, z: SUMMIT.z, r: SUMMIT.r },
    { x: FORT_CARPARK.x, z: FORT_CARPARK.z, r: FORT_CARPARK.r },
  ];
  /** On the pier: within half its width of its line. */
  const onPier = (lx: number, lz: number) => {
    for (let i = 0; i < PIER.pts.length - 1; i++) {
      const [ax, az] = PIER.pts[i];
      const [bx, bz] = PIER.pts[i + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez || 1;
      const u = Math.min(1, Math.max(0, ((lx - ax) * ex + (lz - az) * ez) / len2));
      if (Math.hypot(lx - (ax + ex * u), lz - (az + ez * u)) <= PIER.width / 2) return true;
    }
    return false;
  };
  const junctions = Object.values(JUNCTIONS);
  for (let pz = 0; pz < height; pz++) {
    const wz = CITY.nav.originZ + (pz0 + pz + 0.5) * m;
    for (let px = 0; px < width; px++) {
      const wx = CITY.nav.originX + (px0 + px + 0.5) * m;
      const i = pz * width + px;
      const deck = deckAt(wx, wz);
      if (deck !== null) {
        kind[i] = ROAD;
        y[i] = deck;
        continue;
      }
      const [lx, lz] = toLocal(wx, wz);
      if (onPier(lx, lz)) {
        kind[i] = PAVED;
        y[i] = PIER.top;
        continue;
      }
      if (!inIsland(lx, lz)) continue;
      const ground = groundAt(lx, lz);
      let k = GRASS;
      let top = ground;
      if (roadEdgeAt(lx, lz) <= 0) {
        // The road's own level, which is the ground's except on a level
        // crossing's deck, where the road runs over the formation.
        k = ROAD;
        top = (roadLevelAt(lx, lz) ?? ground) + ROAD_TOP;
      } else if (junctions.some((j) => Math.abs(lx - j.x) <= 9.5 && Math.abs(lz - j.z) <= 9.5)) {
        // A square of tile round each junction, which the distance field does
        // not see: the field measures to centrelines and a tile has none.
        k = ROAD;
        top = ground + ROAD_TOP;
      } else if (yards.some((yd) => Math.hypot(lx - yd.x, lz - yd.z) < yd.r)) {
        k = PAVED;
      }
      kind[i] = k;
      y[i] = top;
    }
  }
  return { px0, pz0, width, height, kind, y };
}

function ensure(): Patch | null {
  if (!built) {
    built = true;
    patch = build();
  }
  return patch;
}

function index(px: number, pz: number): number {
  const p = ensure();
  if (!p) return -1;
  const x = px - p.px0;
  const z = pz - p.pz0;
  if (x < 0 || z < 0 || x >= p.width || z >= p.height) return -1;
  const i = z * p.width + x;
  return p.kind[i] === NONE ? -1 : i;
}

/** True where the island has a made surface at this pixel — a lane, a yard, the deck. */
export function countryPavedAt(px: number, pz: number): boolean {
  const i = index(px, pz);
  return i >= 0 && patch !== null && patch.kind[i] >= PAVED;
}

/** True where a car may be put back on the road at this pixel. */
export function countryDriveableAt(px: number, pz: number): boolean {
  const i = index(px, pz);
  return i >= 0 && patch !== null && patch.kind[i] === ROAD;
}

/** Surface height at this pixel, or null off the island and its bridge. */
export function countryHeightAt(px: number, pz: number): number | null {
  const i = index(px, pz);
  return i < 0 || !patch ? null : patch.y[i];
}
