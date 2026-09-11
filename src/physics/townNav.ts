/**
 * The island's streets, as something the traffic can read.
 *
 * ## Why the island needed its own raster
 *
 * NPC traffic does not follow a route graph. Every car reads the city's nav
 * raster the way a line-following robot reads a track — probe a fan of
 * headings, keep the one with the most tarmac ahead, trim sideways off the
 * kerb (`trafficAI`) — and that raster is baked offline by `prepare-map.mjs`
 * from `city.glb`. The island is not in `city.glb`: it is drawn at runtime
 * from the sketch (`TRAIN_ISLANDS`), and its town is drawn from `townConfig`
 * as merged slabs. So every probe on the island read "no tarmac", which had
 * three consequences, all of them visible: no car ever spawned there, a car
 * that somehow arrived was recycled within `offRoadGrace`, and the player's
 * own tyres were on grass grip (`surfaceGrip` asks the same raster) on what
 * looks like asphalt.
 *
 * Regenerating the PNG was the obvious fix and the wrong one. The town's
 * geometry is TypeScript config, the island's outline is a traced sketch, and
 * both are still being moved about; a baked raster would be a second copy of
 * the layout that goes stale the moment a street moves. This is the first copy
 * instead — the same `STREETS` the town is BUILT from, rasterised at load.
 *
 * ## Aligned to the city's own grid
 *
 * The patch is a small raster with the city's `metresPerPixel` and its origin,
 * so a pixel index means the same thing in both and `cityNav` can consult this
 * one first with no coordinate maths at all. That also fixes the resolution at
 * the city's 1.5 m, which is what the traffic's probe steps, kerb thresholds
 * and lane deadband are all tuned against: a sharper island would have cars
 * behaving differently on it than in the city, for no gain.
 *
 * Three states rather than two, mirroring `cityNav`'s split between what is
 * paved and what is driveable: footways, the forecourt and the car park are
 * `PAVED` (the map draws them, the player's tyres grip them, no NPC drives on
 * them), carriageways are `ROAD`, and the level crossing's ramps are `GATE` —
 * driveable only while the barriers are up. See `setCrossingClear`.
 *
 * ## What is deliberately narrower than it looks
 *
 * A `parking` street's driveable strip is `PARKING_STRIP` short of each kerb,
 * because `IslandTown` stands parked cars there and those cars have no
 * colliders. Without it every NPC on the shore street drove through a parked
 * Hatchback.
 */
import { CITY } from '@/config/cityConfig';
import { BRIDGE, STATION_SITE } from '@/config/stationConfig';
import {
  CAR_PARK, CROSSING, FORECOURT, PARKING_STRIP, RING, RING_CHAINS, STREETS, SURFACE, TOWN_SITE,
} from '@/config/townConfig';
import { RAIL_HEAD_LIFT, TRAIN_ISLANDS, trainPointAt, trainWrap } from '@/config/trainConfig';

/** Cell states, in increasing order of permission. */
const NONE = 0;
const PAVED = 1;
const ROAD = 2;
/** Driveable only when `open` — the level crossing's approach ramps. */
const GATE = 3;

interface Patch {
  /** Pixel origin in the CITY raster's index space, so indices are shared. */
  px0: number;
  pz0: number;
  width: number;
  height: number;
  kind: Uint8Array;
  /** Surface height in world metres. Meaningless where `kind` is `NONE`. */
  y: Float32Array;
}

let patch: Patch | null = null;
let built = false;
/** Barriers up: the crossing ramps are driveable. */
let crossingClear = true;
/** The causeway's deck, once `IslandBridge` has worked out its profile. */
let deck: ReadonlyArray<{ z: number; y: number }> | null = null;

const mpp = CITY.nav.metresPerPixel;
const toPixelX = (x: number) => Math.floor((x - CITY.nav.originX) / mpp);
const toPixelZ = (z: number) => Math.floor((z - CITY.nav.originZ) / mpp);
const toWorldX = (px: number) => CITY.nav.originX + (px + 0.5) * mpp;
const toWorldZ = (pz: number) => CITY.nav.originZ + (pz + 0.5) * mpp;

/**
 * The bigger island, which is the one with the town on it.
 *
 * By area, exactly as `stationConfig` picks it: the patch only needs the
 * island's bounding box, but it has to be the SAME island the station is on or
 * the box is somewhere else entirely.
 */
const host = (() => {
  const area = (outline: ReadonlyArray<readonly [number, number]>) => {
    let sum = 0;
    for (let i = 0; i < outline.length; i++) {
      const [x, z] = outline[i];
      const [nx, nz] = outline[(i + 1) % outline.length];
      sum += x * nz - nx * z;
    }
    return Math.abs(sum / 2);
  };
  return TRAIN_ISLANDS.length
    ? [...TRAIN_ISLANDS].sort((a, b) => area(b.outline) - area(a.outline))[0]
    : null;
})();

/* ------------------------------------------------------------------ frame */

/**
 * World position to the station's frame: `[across, along]`.
 *
 * The inverse of `stationPoint`, and the reason the whole town can be tested
 * as axis-aligned rectangles: a rotated rectangle in the world is an
 * upright one in here.
 */
function frame(x: number, z: number): [number, number] {
  const site = STATION_SITE;
  if (!site) return [0, 0];
  const dx = x - site.centre[0];
  const dz = z - site.centre[2];
  return [
    dx * site.normal[0] + dz * site.normal[1],
    dx * site.tangent[0] + dz * site.tangent[1],
  ];
}

/* ------------------------------------------------------------- the raster */

/** A rectangle in the frame, painted at a height that may vary across it. */
interface Area {
  a0: number;
  a1: number;
  l0: number;
  l1: number;
  kind: number;
  /** World height of the surface, given the frame position of the cell. */
  y: (across: number, along: number) => number;
}

/** The frame back to the world: the forward half of `stationPoint`. */
function world(across: number, along: number): [number, number] {
  const site = STATION_SITE;
  if (!site) return [0, 0];
  return [
    site.centre[0] + site.normal[0] * across + site.tangent[0] * along,
    site.centre[2] + site.normal[1] * across + site.tangent[1] * along,
  ];
}

/**
 * Paint one frame rectangle.
 *
 * Only the pixels inside the rectangle's own WORLD bounding box are visited,
 * which matters more than it looks: there are thirty-odd areas and 200,000
 * cells, and testing every cell against every area is six million frame
 * transforms at load — a visible hitch on the frame the island first comes
 * into view. The box is the four corners turned into the world, so it is
 * correct for the rotated rectangle rather than an axis-aligned guess.
 */
function paint(p: Patch, area: Area) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [a, l] of [
    [area.a0, area.l0], [area.a0, area.l1], [area.a1, area.l0], [area.a1, area.l1],
  ] as const) {
    const [wx, wz] = world(a, l);
    x0 = Math.min(x0, wx);
    x1 = Math.max(x1, wx);
    z0 = Math.min(z0, wz);
    z1 = Math.max(z1, wz);
  }
  const from = Math.max(0, toPixelZ(z0) - p.pz0);
  const to = Math.min(p.height - 1, toPixelZ(z1) - p.pz0);
  const left = Math.max(0, toPixelX(x0) - p.px0);
  const right = Math.min(p.width - 1, toPixelX(x1) - p.px0);
  for (let pz = from; pz <= to; pz++) {
    const wz = toWorldZ(p.pz0 + pz);
    for (let px = left; px <= right; px++) {
      const [across, along] = frame(toWorldX(p.px0 + px), wz);
      if (across < area.a0 || across > area.a1) continue;
      if (along < area.l0 || along > area.l1) continue;
      const i = pz * p.width + px;
      // Only ever upgrades: a carriageway painted over a footway is a
      // carriageway, and the order the areas happen to be listed in must not
      // decide which of two overlapping surfaces wins.
      if (area.kind >= p.kind[i]) {
        p.kind[i] = area.kind;
        p.y[i] = area.y(across, along);
      }
    }
  }
}

/** Every street, the paved places, and the level crossing, in frame rectangles. */
function townAreas(ground: number): Area[] {
  const areas: Area[] = [];
  const road = () => ground + SURFACE.road;
  const foot = () => ground + SURFACE.footway;

  for (const street of STREETS) {
    const l0 = Math.min(street.from, street.to);
    const l1 = Math.max(street.from, street.to);
    const half = street.width / 2;
    const outer = half + street.footway;
    // The footway first and the carriageway over it, so the kerb line falls
    // where the geometry puts it rather than where the loop order does.
    const rect = (from: number, to: number, kind: number, y: Area['y']): Area => (
      street.axis === 'along'
        ? { a0: from, a1: to, l0, l1, kind, y }
        : { a0: l0, a1: l1, l0: from, l1: to, kind, y }
    );
    if (street.footway > 0) {
      areas.push(rect(street.at - outer, street.at + outer, PAVED, foot));
    }
    // See `Street.parking`: parked cars have no colliders, so the strip they
    // stand in must not be offered to the steering.
    const drive = half - (street.parking ? PARKING_STRIP : 0);
    areas.push(rect(street.at - drive, street.at + drive, ROAD, road));
  }

  // Paved, not driveable. The forecourt is where the taxis and the bus stand
  // and the car park is full of parked cars, and both are places an NPC that
  // wandered in would spend its life shunting: they are surfaces the PLAYER
  // uses. `isRoadAt` still reports them, so the tyres know they are on tarmac.
  areas.push({
    a0: FORECOURT.fromAcross, a1: FORECOURT.toAcross,
    l0: FORECOURT.fromAlong, l1: FORECOURT.toAlong, kind: PAVED, y: foot,
  });
  areas.push({
    a0: CAR_PARK.fromAcross, a1: CAR_PARK.toAcross,
    l0: CAR_PARK.fromAlong, l1: CAR_PARK.toAlong, kind: PAVED, y: road,
  });

  /* ---------------------------------------------------- the level crossing */

  // The deck stands at rail head height, a metre over the crown, and the ramps
  // climb to it. Both have to be in here or the two rings are two islands as
  // far as the traffic is concerned — and the height has to RAMP, because
  // `trafficAI` reads a step up of more than `maxClimb` as a wall and stops.
  const site = STATION_SITE;
  if (site) {
    // The panels' top face, which `buildCrossing` lays flush with the rail head.
    const deckTop = trainPointAt(trainWrap(site.arc + CROSSING.along))[1] + RAIL_HEAD_LIFT;
    const lane = CROSSING.halfWidth;
    areas.push({
      a0: CROSSING.fromAcross, a1: CROSSING.toAcross,
      l0: CROSSING.along - lane, l1: CROSSING.along + lane,
      kind: ROAD, y: () => deckTop,
    });
    // The ramps are the gate: a car already on the deck drives off it when the
    // barriers fall, and a car approaching stops where the stop line is. Gating
    // the deck instead would strand whatever is standing on it, which reads as
    // a car being deleted in front of a train rather than as a crossing.
    for (const side of [-1, 1] as const) {
      const at = side < 0 ? CROSSING.fromAcross : CROSSING.toAcross;
      const outerEdge = at + side * CROSSING.ramp;
      areas.push({
        a0: Math.min(at, outerEdge), a1: Math.max(at, outerEdge),
        l0: CROSSING.along - lane, l1: CROSSING.along + lane,
        kind: GATE,
        y: (across) => {
          const t = Math.min(1, Math.max(0, (across - outerEdge) / (at - outerEdge)));
          return ground + SURFACE.road + (deckTop - ground - SURFACE.road) * t;
        },
      });
    }
  }

  // The apron between the shore street and the transplanted block, which
  // `IslandStation` draws as a plain slab. Paved: it is where the bridge
  // traffic actually lands, and grass grip on it was wrong.
  if (BRIDGE) {
    const [across, along] = frame(BRIDGE.x, BRIDGE.islandZ);
    areas.push({
      a0: across, a1: -70, l0: along - 6.5, l1: along + 6.5,
      kind: PAVED, y: () => ground + 0.02,
    });
  }

  return areas;
}

/**
 * The ring road, painted along its own centreline.
 *
 * Not a rectangle in the frame for the same reason the causeway is not: it is a
 * curve, and one that changes height where it crosses the railway. Each pair of
 * samples is a quadrilateral, and rather than rasterise a quad the corridor is
 * walked — every cell within half a carriageway of the segment gets the
 * interpolated height. At 8 m samples and 1.5 m cells that is a couple of
 * thousand cells a segment's worth of work, once.
 *
 * The driveable strip is the carriageway less a metre, so a car steering to a
 * quarter of the corridor is not steering onto the verge; the verge itself is
 * paved so the tyres still know it is made ground.
 */
function paintRing(p: Patch, ground: number) {
  const drive = RING.width / 2 - 1;
  const paved = RING.width / 2 + RING.verge;
  // Per chain, and never wrapping: the ring is two open shore roads now, and
  // joining the end of one to the start of the other would paint a kilometre
  // of driveable tarmac straight across the island.
  for (const chain of RING_CHAINS) {
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const dx = b.across - a.across;
    const dz = b.along - a.along;
    const span = Math.hypot(dx, dz) || 1;
    // The segment's own world box, plus the corridor's half width.
    const [ax, az] = world(a.across, a.along);
    const [bx, bz] = world(b.across, b.along);
    const x0 = Math.min(ax, bx) - paved;
    const x1 = Math.max(ax, bx) + paved;
    const z0 = Math.min(az, bz) - paved;
    const z1 = Math.max(az, bz) + paved;
    const from = Math.max(0, toPixelZ(z0) - p.pz0);
    const to = Math.min(p.height - 1, toPixelZ(z1) - p.pz0);
    const left = Math.max(0, toPixelX(x0) - p.px0);
    const right = Math.min(p.width - 1, toPixelX(x1) - p.px0);
    for (let pz = from; pz <= to; pz++) {
      const wz = toWorldZ(p.pz0 + pz);
      for (let px = left; px <= right; px++) {
        const [across, along] = frame(toWorldX(p.px0 + px), wz);
        // Where the cell falls along this segment, clamped to its ends.
        const t = Math.min(1, Math.max(0,
          ((across - a.across) * dx + (along - a.along) * dz) / (span * span)));
        const cx = a.across + dx * t;
        const cz = a.along + dz * t;
        const off = Math.hypot(across - cx, along - cz);
        if (off > paved) continue;
        const kind = off <= drive ? ROAD : PAVED;
        const i2 = pz * p.width + px;
        if (kind >= p.kind[i2]) {
          p.kind[i2] = kind;
          p.y[i2] = ground + a.rise + (b.rise - a.rise) * t;
        }
      }
    }
  }
  }
}

/**
 * The causeway, painted along the deck profile `IslandBridge` measured.
 *
 * Not a rectangle in the frame: the causeway runs down world Z, its height is
 * the cone-filtered profile worked out at runtime from raycasts against the
 * city, and neither of those is known to any config. So it is painted directly
 * in world coordinates from the samples the component hands over, which is
 * also what makes the height right — a straight interpolation between the two
 * ends would sit up to 25 cm under the road it is supposed to describe, and
 * `trafficAI` compares exactly that number against `maxClimb`.
 */
function paintCauseway(p: Patch) {
  const B = BRIDGE;
  if (!B || !deck || deck.length < 2) return;
  const north = Math.min(B.islandZ, B.cityZ);
  const south = Math.max(B.islandZ, B.cityZ);
  /** Interpolated deck height at a world z, or null off the ends. */
  const heightAt = (z: number): number | null => {
    const samples = deck!;
    if (z < north || z > south) return null;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const lo = Math.min(a.z, b.z);
      const hi = Math.max(a.z, b.z);
      if (z < lo || z > hi) continue;
      const t = (z - a.z) / (b.z - a.z || 1);
      return a.y + (b.y - a.y) * t;
    }
    return null;
  };
  // The carriageway, then its verges. Narrower than the deck by a metre so a
  // car steering to a quarter of the corridor is not steering onto the shoulder.
  const drive = B.halfWidth - 1;
  for (let pz = 0; pz < p.height; pz++) {
    const wz = toWorldZ(p.pz0 + pz);
    const y = heightAt(wz);
    if (y === null) continue;
    for (let px = 0; px < p.width; px++) {
      const dx = Math.abs(toWorldX(p.px0 + px) - B.x);
      if (dx > B.crownHalf) continue;
      const i = pz * p.width + px;
      const kind = dx <= drive ? ROAD : PAVED;
      if (kind >= p.kind[i]) {
        p.kind[i] = kind;
        p.y[i] = y + (kind === ROAD ? B.surface : 0);
      }
    }
  }
}

/** Build the raster on first use, and again whenever the causeway arrives. */
function ensure(): Patch | null {
  if (built) return patch;
  built = true;
  const site = TOWN_SITE;
  if (!site || !host || !STATION_SITE) return null;

  // The box: the island's own bounding box with room for the beach, plus the
  // causeway's corridor, which reaches most of the way to the city.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of host.outline) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const margin = host.shore + 20;
  minX -= margin;
  maxX += margin;
  minZ -= margin;
  maxZ += margin;
  if (BRIDGE) {
    minX = Math.min(minX, BRIDGE.x - BRIDGE.crownHalf - 4);
    maxX = Math.max(maxX, BRIDGE.x + BRIDGE.crownHalf + 4);
    minZ = Math.min(minZ, BRIDGE.islandZ, BRIDGE.cityZ);
    maxZ = Math.max(maxZ, BRIDGE.islandZ, BRIDGE.cityZ);
  }

  const px0 = toPixelX(minX);
  const pz0 = toPixelZ(minZ);
  const width = toPixelX(maxX) - px0 + 1;
  const height = toPixelZ(maxZ) - pz0 + 1;
  const p: Patch = {
    px0, pz0, width, height,
    kind: new Uint8Array(width * height),
    y: new Float32Array(width * height),
  };
  for (const area of townAreas(site.ground)) paint(p, area);
  // The ring after the grid: where the two meet, the ring's own height is the
  // one that has to win, because at the level crossings it is the one that is
  // not at crown level.
  paintRing(p, site.ground);
  paintCauseway(p);
  patch = p;
  return p;
}

/**
 * Hand over the causeway's measured deck profile.
 *
 * Called by `IslandBridge` once it has raycast the city and filtered its
 * grade. Anything already built is thrown away and rebuilt, because the
 * causeway is the one thing that joins the island to the city and a patch
 * without it is a patch NPC traffic cannot reach.
 */
export function setCausewayDeck(samples: ReadonlyArray<{ z: number; y: number }>) {
  deck = samples;
  patch = null;
  built = false;
}

/**
 * Barriers up or down at the level crossing.
 *
 * `IslandTown`'s `LevelCrossing` already works this out from the train
 * registry to swing its booms; this is the same fact told to the traffic, so
 * the barriers stop cars instead of passing through them.
 */
export function setCrossingClear(clear: boolean) {
  crossingClear = clear;
}

/** Barriers up? The traffic's road graph asks before entering the crossing deck. */
export const isCrossingClear = () => crossingClear;

/** The cell index for a city-raster pixel, or −1 if it is outside the patch. */
function index(px: number, pz: number): number {
  const p = ensure();
  if (!p) return -1;
  const x = px - p.px0;
  const z = pz - p.pz0;
  if (x < 0 || z < 0 || x >= p.width || z >= p.height) return -1;
  const i = z * p.width + x;
  return p.kind[i] === NONE ? -1 : i;
}

/** True where the island has any made surface at this pixel. */
export function townPavedAt(px: number, pz: number): boolean {
  return index(px, pz) >= 0;
}

/** True where an NPC may drive at this pixel. */
export function townDriveableAt(px: number, pz: number): boolean {
  const i = index(px, pz);
  if (i < 0 || !patch) return false;
  const kind = patch.kind[i];
  return kind === ROAD || (kind === GATE && crossingClear);
}

/** Surface height at this pixel, or null where the island has nothing made. */
export function townHeightAt(px: number, pz: number): number | null {
  const i = index(px, pz);
  return i < 0 || !patch ? null : patch.y[i];
}
