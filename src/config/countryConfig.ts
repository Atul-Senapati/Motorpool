import roadModels from './roadModelData.json';
import countryModels from './countryModelData.json';
import {
  AIRPORT_GATE, OUTLINE as AIRPORT_OUTLINE, PAVING as AIRPORT_PAVING, SITE as AIRPORT_SITE,
} from './airportConfig';
import { TRACK_GAP, TRUNK_RAILHEAD, trunkCentre } from './islandRailConfig';
import { ROAD_TOP } from './roadConfig';
import { RAIL_HEAD_LIFT, TRAIN } from './trainConfig';

/**
 * Skylark: a countryside island south-west of Halcyon Field.
 *
 * Farmland, not made land. Every other island in this world is flat — a crown
 * at one height with a vertical wall to the seabed — because every other
 * island is a runway, a station yard or a village on reclaimed ground. This one
 * is drawn as *country*: a ridge of downs across the south, a wooded hill in
 * the north-east, a lake in the hollow between, and a patchwork of fields
 * between hedges over all of it, with two farms, a hamlet round a crossroads
 * and a church, and the lanes that join them.
 *
 * ## The frame
 *
 * Everything here is in the island's own metres, `x` east and `z` south, about
 * `SITE.centre`. The island is not turned (`heading` 0), so local and world
 * differ by that centre and nothing else — `toWorld` is the only conversion
 * and it is a subtraction. The centre is where the user drew it: a sketch over
 * the map put the island at pixel (142, 557) of a 0.2536 px/m view whose
 * airport label sat at (105, 262), which is 146 m east and 1,163 m south of
 * Halcyon Field's centre.
 *
 * ## The coast
 *
 * A polar function of the angle, `coastRadius`, so the outline is star-shaped
 * about the centre by construction — the crown is a polar grid whose outer
 * ring IS the outline, and the sea wall is extruded from that same ring, so
 * the two can never disagree. An ellipse of 840 × 640 m, bent by four
 * harmonics for a real-looking shore, with three deliberate features on top:
 * a headland where the bridge lands, so the crossing is shorter; a second on
 * the south-west where the downs run into the sea, for the lighthouse; and a
 * cove on the south-east.
 *
 * ## The ground
 *
 * `groundAt` is the one function. Base relief is a handful of Gaussian hills
 * plus two octaves of value noise over a coastal floor of 3.6 m; then the
 * *pads* — farmyards, the hamlet, junctions, the bridge landing, the lake
 * basin — flatten or lower it; then the roads carve it: every lane's height is
 * smoothed and grade-limited along its own centreline, and the ground within
 * the carriageway is brought to that height with a soft shoulder outside it,
 * so a lane is cut into a hillside rather than laid across it. The terrain
 * mesh, the collider, the nav raster, every tree and every cow read the same
 * function, which is why nothing floats.
 *
 * ## The lanes
 *
 * Catmull-Rom splines through waypoints, sampled every three metres. They are
 * swept from the road kit's surface (`buildLoft`, exactly as Kestrel's
 * crescent and both bridge decks are) rather than tiled from its straights,
 * because a lane over a hill is neither straight nor flat and the kit's pieces
 * are both. The junctions ARE the kit — a T where the bridge road meets the
 * island and a crossroads in the hamlet — standing on pads flattened to their
 * height, and every lane starts and ends square on a junction's mouth.
 *
 * ## The bridge
 *
 * Straight, because it can be: the airport's outer road ends in a corner at
 * its west end, that corner becomes a T (`roadConfig`), and the T's free arm
 * points 17° west of south — almost exactly at where the island was drawn.
 * The deck runs from the T's edge along that bearing, over 57 m of airport
 * crown, across the water and 25 m onto the island, and the first lane
 * continues along the same bearing to its own T. See `BRIDGE`.
 */

const TAU = Math.PI * 2;

/** Whether the island is part of the world at all. */
export const COUNTRY_ENABLED = true;

export const COUNTRY_NAME = 'Skylark';

export const SITE = {
  centre: [-2560, 1160] as [number, number],
  heading: 0,
} as const;

/** Island metres to world metres — a subtraction, because the island is not turned. */
export const toWorld = (x: number, z: number): [number, number] => [
  SITE.centre[0] + x, SITE.centre[1] + z,
];
export const toLocal = (x: number, z: number): [number, number] => [
  x - SITE.centre[0], z - SITE.centre[1],
];

/* ------------------------------------------------------------------ maths */

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Hermite ease, 0..1 over 0..1. */
export const smooth = (t: number) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministic random, so the island is the same island every load. */
export function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A hash on the integer lattice, for the value noise. */
function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Smooth value noise, −1..1, one repeat every `wavelength` metres. */
function noise(x: number, z: number, wavelength: number, seed: number): number {
  const u = x / wavelength + seed * 17.1;
  const v = z / wavelength + seed * 31.7;
  const ix = Math.floor(u);
  const iz = Math.floor(v);
  const fx = smooth(u - ix);
  const fz = smooth(v - iz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (lerp(lerp(a, b, fx), lerp(c, d, fx), fz) - 0.5) * 2;
}

/* --------------------------------------------------------------- the coast */

export const SHAPE = {
  /** Semi-axes of the base ellipse: east-west, then north-south. */
  a: 420,
  b: 320,
  /** Points round the outline, and the angular resolution of the crown. */
  steps: 900,
  /**
   * Named departures from the ellipse, as a Gaussian in the angle. Positive
   * pushes the coast out.
   *
   * The south-west lobe is the second half of the island: asked for after
   * the first half was seen, "at least half more, south-west". It nearly
   * doubles the radius through 135° and takes the area from 0.45 km² to
   * 0.70. Everything that was already here kept its coordinates — the lobe
   * is new ground beyond the old coast, not a stretch of the old.
   */
  bumps: [
    { at: -1.93, width: 0.4, amount: 0.11, label: 'bridge headland' },
    { at: 0.85, width: 0.26, amount: -0.1, label: 'gull cove' },
    { at: 2.35, width: 0.66, amount: 0.92, label: 'the south-west lobe' },
    { at: 2.42, width: 0.1, amount: -0.08, label: 'harbour cove' },
    { at: 2.78, width: 0.14, amount: 0.07, label: 'lighthouse headland' },
    // For the railway: the corridor between Home Farm and the north-west
    // coast was 25 m, and a double track with its cuttings wants 60.
    { at: -2.55, width: 0.34, amount: 0.22, label: 'railway headland' },
  ],
} as const;

/** Distance from the centre to the coast, at an angle `atan2(z, x)`. */
export function coastRadius(theta: number): number {
  const { a, b } = SHAPE;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const ellipse = (a * b) / Math.hypot(b * c, a * s);
  let k = 1
    + 0.075 * Math.sin(2 * theta + 0.7)
    + 0.055 * Math.sin(3 * theta + 2.1)
    + 0.035 * Math.sin(5 * theta + 4.0)
    + 0.02 * Math.sin(9 * theta + 1.3);
  for (const bump of SHAPE.bumps) {
    const raw = theta - bump.at;
    const d = Math.atan2(Math.sin(raw), Math.cos(raw));
    k += bump.amount * Math.exp(-(d * d) / (2 * bump.width * bump.width));
  }
  return ellipse * k;
}

/**
 * The outline, in the island's frame.
 *
 * Wound so a fan over it faces UP: in the XZ plane with Y up a triangle's
 * normal is +Y only when the shoelace sum is negative, and sweeping the angle
 * upward gives a positive one — the same trap `airportConfig` documents. The
 * angle is swept downward here, and `outlineShoelace` is asserted below.
 */
export const OUTLINE: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: SHAPE.steps },
  (_, i) => {
    const theta = -(i / SHAPE.steps) * TAU;
    const r = coastRadius(theta);
    return [r * Math.cos(theta), r * Math.sin(theta)] as const;
  },
);

/** Twice the signed area. Negative means a fan over the outline faces up. */
export const outlineShoelace = (): number => OUTLINE.reduce((sum, [x, z], i) => {
  const [nx, nz] = OUTLINE[(i + 1) % OUTLINE.length];
  return sum + (x * nz - nx * z);
}, 0);
if (outlineShoelace() >= 0) throw new Error('Skylark: outline is wound the wrong way');

/** The same outline in world XZ, for the map, the sea and anything outside the group. */
export const OUTLINE_WORLD: ReadonlyArray<[number, number]> = OUTLINE.map(
  ([x, z]) => toWorld(x, z),
);

/** How far inside the coast a point is, measured radially — negative at sea. */
export function coastClearance(x: number, z: number): number {
  return coastRadius(Math.atan2(z, x)) - Math.hypot(x, z);
}

export const inIsland = (x: number, z: number, margin = 0) => coastClearance(x, z) >= margin;

/** A point on the coast at an angle, pulled `inset` metres inland. */
export function coastPoint(theta: number, inset = 0): [number, number] {
  const r = coastRadius(theta) - inset;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/** The bounding box of the island, with room round it, in its own frame. */
export const BOUNDS = { x0: -740, x1: 480, z0: -380, z1: 620 } as const;

/* -------------------------------------------------------------- the ground */

/** The coastal floor: the least height the land has, and what the wall stands over. */
export const COAST_BASE = 3.6;

/**
 * The relief, as Gaussian hills.
 *
 * `sx` and `sz` are the sigmas along and across the hill's own axis, `rot`
 * turns that axis, `h` is its height above whatever is under it.
 */
export const HILLS = [
  { x: -60, z: 190, sx: 150, sz: 62, rot: 0.12, h: 46, label: 'the Downs' },
  { x: -300, z: 150, sx: 75, sz: 60, rot: 0.6, h: 16, label: 'west shoulder' },
  { x: 265, z: -150, sx: 105, sz: 88, rot: -0.3, h: 34, label: 'Beacon Hill' },
  { x: -150, z: 0, sx: 55, sz: 45, rot: 0, h: 13, label: 'Mill Knoll' },
  { x: 0, z: -40, sx: 130, sz: 110, rot: 0, h: 7, label: 'hamlet rise' },
  { x: -230, z: -190, sx: 90, sz: 70, rot: 0.4, h: 5, label: 'farm rise' },
  // Added when the user asked for a hillier island: a ridge behind the
  // north coast between Home Farm and the hamlet, and a swell in the
  // south-west fields, both clear of the railway's flat.
  { x: -60, z: -260, sx: 110, sz: 40, rot: -0.15, h: 14, label: 'north ridge' },
  { x: -200, z: 300, sx: 70, sz: 55, rot: 0.2, h: 12, label: 'vineyard swell' },
  // The lobe: a broad low rise so it is not a plain, and Castle Hill on its
  // seaward side with the fort's ramparts round its top.
  { x: -470, z: 150, sx: 150, sz: 110, rot: 0.3, h: 13, label: 'lobe rise' },
  { x: -520, z: 250, sx: 82, sz: 66, rot: 0.45, h: 31, label: 'Castle Hill' },
] as const;

/**
 * The hill fort: two banks with a ditch outside each, ringed round Castle
 * Hill's top. Earthworks, not buildings — it is the ground itself that is the
 * monument, and from the air two concentric rings on a hilltop are
 * unmistakable.
 */
export const CASTLE_HILL = {
  x: -520, z: 250,
  ramparts: [
    { r: 40, bank: 3.2, ditch: 2.0 },
    { r: 62, bank: 2.6, ditch: 1.6 },
  ],
  /** The entrance: a gap in the rings on the landward side, toward the car park. */
  gate: -0.89,
} as const;

function fortAt(x: number, z: number): number {
  const dx = x - CASTLE_HILL.x;
  const dz = z - CASTLE_HILL.z;
  const d = Math.hypot(dx, dz);
  if (d > 90) return 0;
  const gap = Math.atan2(Math.sin(Math.atan2(dz, dx) - CASTLE_HILL.gate), Math.cos(Math.atan2(dz, dx) - CASTLE_HILL.gate));
  const open = Math.abs(gap) < 0.14 ? 0 : 1;
  let h = 0;
  for (const ring of CASTLE_HILL.ramparts) {
    h += ring.bank * Math.exp(-((d - ring.r) ** 2) / (2 * 4.5 * 4.5)) * open;
    h -= ring.ditch * Math.exp(-((d - ring.r - 9) ** 2) / (2 * 4 * 4)) * open;
  }
  return h;
}

function hillsAt(x: number, z: number): number {
  let h = 0;
  for (const hill of HILLS) {
    const dx = x - hill.x;
    const dz = z - hill.z;
    const c = Math.cos(hill.rot);
    const s = Math.sin(hill.rot);
    const u = dx * c + dz * s;
    const v = -dx * s + dz * c;
    h += hill.h * Math.exp(-((u * u) / (2 * hill.sx * hill.sx) + (v * v) / (2 * hill.sz * hill.sz)));
  }
  return h;
}

/** Hills and noise, and nothing built. What every pad and lane is measured against. */
export function reliefAt(x: number, z: number): number {
  return COAST_BASE + hillsAt(x, z) + fortAt(x, z)
    + 3.0 * noise(x, z, 95, 1)
    + 1.3 * noise(x, z, 38, 2)
    + 0.45 * noise(x, z, 14, 3);
}

/**
 * The beach: the one stretch of coast that is not a wall.
 *
 * East of the harbour, through `BEACH.halfAngle` either side of its bearing,
 * the last `BEACH.strand` metres of land slope down to below the waterline
 * instead of stopping at a cliff, so the sea runs up onto it. The wall is
 * still built under it — its top is simply under water there.
 */
export const BEACH = { theta: 2.2, halfAngle: 0.085, strand: 58, low: -3.3 } as const;

function beachAt(x: number, z: number, h: number): number {
  const theta = Math.atan2(z, x);
  const raw = theta - BEACH.theta;
  const d = Math.abs(Math.atan2(Math.sin(raw), Math.cos(raw)));
  if (d > BEACH.halfAngle + 0.05) return h;
  const clear = coastClearance(x, z);
  if (clear > BEACH.strand) return h;
  // Soften the window's edges so the strand narrows into the cliffs.
  const window = 1 - smooth((d - BEACH.halfAngle + 0.05) / 0.05);
  const t = smooth(1 - clear / BEACH.strand);
  return lerp(h, lerp(h, BEACH.low, t), window);
}

/* ------------------------------------------------------------- the lake */

/**
 * Skylark Water, in the hollow between the downs and Beacon Hill.
 *
 * A polar blob like the island itself. `y` is the water surface, solved below
 * off the lowest ground round its shore so that the water never stands above
 * the bank anywhere; the bed is dished under it.
 */
export const LAKE = {
  x: 205,
  z: 55,
  rx: 78,
  rz: 52,
  depth: 3.4,
  /** The shelf of flat bank just above the water, and how far the land climbs out of it. */
  bank: 3,
  shore: 26,
} as const;

export function lakeRadius(theta: number): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const ellipse = (LAKE.rx * LAKE.rz) / Math.hypot(LAKE.rz * c, LAKE.rx * s);
  return ellipse * (1 + 0.09 * Math.sin(2 * theta + 1.1) + 0.07 * Math.sin(3 * theta - 0.4)
    + 0.04 * Math.sin(5 * theta + 2.0));
}

/** Fraction of the way from the lake's centre to its shore: <1 is water. */
export const lakeFraction = (x: number, z: number) => (
  Math.hypot(x - LAKE.x, z - LAKE.z) / lakeRadius(Math.atan2(z - LAKE.z, x - LAKE.x))
);

export const LAKE_OUTLINE: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: 96 },
  (_, i) => {
    const theta = -(i / 96) * TAU;
    const r = lakeRadius(theta);
    return [LAKE.x + r * Math.cos(theta), LAKE.z + r * Math.sin(theta)] as const;
  },
);

/** The water surface: 0.7 m under the lowest bank, so nothing stands in it that should not. */
export const LAKE_Y = (() => {
  let low = Infinity;
  for (let i = 0; i < 64; i++) {
    const theta = (i / 64) * TAU;
    for (const f of [1.1, 1.25, 1.4]) {
      const r = lakeRadius(theta) * f;
      low = Math.min(low, reliefAt(LAKE.x + r * Math.cos(theta), LAKE.z + r * Math.sin(theta)));
    }
  }
  return Math.round((low - 0.7) * 10) / 10;
})();

/**
 * The duck pond on the hamlet green, and a dew pond up on the downs. Both sit
 * on flat ground so a plain disc is all they need.
 */
export const PONDS = [
  { x: 41, z: -79, r: 11, label: 'duck pond' },
  { x: 20, z: 168, r: 8, label: 'dew pond' },
] as const;

/* ------------------------------------------------------------- the pads */

/**
 * Flat ground: where something is built, the hill is graded to one height.
 *
 * `y` is the height the pad holds; where it is omitted the pad takes the
 * relief at its own centre, so a farm sits at the height its hill gives it.
 * `blend` is the width of the shoulder the ground takes to rejoin the relief.
 */
interface PadSpec {
  x: number;
  z: number;
  r: number;
  blend: number;
  y?: number;
  label: string;
}

/* --------------------------------------------------------- the junctions */

const HALF = roadModels.parts.junctionT.size[0] / 2;
/** The kit's carriageway width, which every lane is swept at. */
export const LANE_WIDTH = roadModels.parts.straight1.size[2];

/**
 * Where the bridge arrives, worked out from the airport rather than written
 * down: the T at the west end of the outer road, its west edge, and the
 * bearing of its free arm. Local +X on the airport island is world
 * (cos h, −sin h), so the arm that points away from the outer road is the
 * negative of that.
 */
export const airportWorld = (x: number, z: number): [number, number] => {
  const c = Math.cos(AIRPORT_SITE.heading);
  const s = Math.sin(AIRPORT_SITE.heading);
  return [AIRPORT_SITE.centre[0] + x * c + z * s, AIRPORT_SITE.centre[1] - x * s + z * c];
};
const OUTER_ROAD_Z = (AIRPORT_PAVING.outerRoad[2] + AIRPORT_PAVING.outerRoad[3]) / 2;
const BRIDGE_START_WORLD = airportWorld(AIRPORT_GATE - HALF, OUTER_ROAD_Z);
/** Unit bearing of the crossing, in world = island XZ. */
export const BRIDGE_DIR: readonly [number, number] = [
  -Math.cos(AIRPORT_SITE.heading), Math.sin(AIRPORT_SITE.heading),
];
const BRIDGE_START = toLocal(BRIDGE_START_WORLD[0], BRIDGE_START_WORLD[1]);

/** A point along the crossing, `s` metres from the airport T's edge, island frame. */
export const bridgePoint = (s: number): [number, number] => [
  BRIDGE_START[0] + BRIDGE_DIR[0] * s, BRIDGE_START[1] + BRIDGE_DIR[1] * s,
];

/** Where the deck crosses the island's coast: the first metre of the line that is land. */
const LANDFALL_S = (() => {
  for (let s = 100; s < 1200; s += 0.5) {
    const [x, z] = bridgePoint(s);
    if (inIsland(x, z)) return s;
  }
  throw new Error('Skylark: the bridge never reaches the island');
})();

/** How far the deck runs onto the island past the coast before the lane takes over. */
export const DECK_OVERLAP = 25;
const DECK_END_S = LANDFALL_S + DECK_OVERLAP;
const DECK_END = bridgePoint(DECK_END_S);

/**
 * Where the deck leaves the airport's own ground, measured on that island's
 * outline. The airport's outline is in the airport's frame, so the line is
 * walked in that frame; it is 57-odd metres from the T's edge to the water.
 */
const AIRPORT_SHORE_S = (() => {
  const inAirport = (s: number): boolean => {
    const [wx, wz] = bridgePoint(s);
    const [gx, gz] = toWorld(wx, wz);
    const dx = gx - AIRPORT_SITE.centre[0];
    const dz = gz - AIRPORT_SITE.centre[1];
    const c = Math.cos(AIRPORT_SITE.heading);
    const sn = Math.sin(AIRPORT_SITE.heading);
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    // Even-odd against the outline.
    let inside = false;
    for (let i = 0, j = AIRPORT_OUTLINE.length - 1; i < AIRPORT_OUTLINE.length; j = i++) {
      const [xi, zi] = AIRPORT_OUTLINE[i];
      const [xj, zj] = AIRPORT_OUTLINE[j];
      if ((zi > lz) !== (zj > lz) && lx < ((xj - xi) * (lz - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  let last = 0;
  for (let s = 0; s < 200; s += 0.5) {
    if (inAirport(s)) last = s;
    else if (s > 5) break;
  }
  return last;
})();

/** The bridge T: dead on the crossing's line, where the lane it carries meets the island. */
const BRIDGE_HEAD_Z = -168;
const BRIDGE_HEAD_S = (BRIDGE_HEAD_Z - BRIDGE_START[1]) / BRIDGE_DIR[1];
const BRIDGE_HEAD = bridgePoint(BRIDGE_HEAD_S);

/** The landing: the deck's end, held flat at the relief there. */
const LANDING_Y = Math.round(Math.max(COAST_BASE + 0.8, reliefAt(DECK_END[0], DECK_END[1])) * 10) / 10;

/** The railway's formation height on the west bridge and the two shores it joins. */
export const RAIL_WEST_Y = 4.6;
/** And on the east bridge, out to the pier. */
export const RAIL_EAST_Y = 5.6;

/* ------------------------------------------------ the railway's course */

/**
 * The line's course, in this frame, before anything is known about heights.
 * Solved here, early, because the pads the ground is fitted to need to know
 * where it comes ashore.
 *
 * It runs WEST of the road viaduct, not east: 70 m off the road's
 * centreline, which on the airfield is the strip between the outer road and
 * the landside road, and on the island is the headland's broad west flank
 * rather than its narrow east one. The first draft ran 30 m east, landed on
 * the headland's tip and had to turn 60° in 90 m to get round it — a 42 m
 * radius, which from a cab is a wall coming round. West of the road there
 * is room for the turn to start at the deck's end and be done at 160 m.
 *
 * The course is a fillet alignment, the way a railway is actually set out:
 * straights between the waypoints, and at every corner a circular curve of
 * `RAIL_R` tangent to both legs — the radius given up only where two corners
 * stand too close for it, which `describeCountry` reports as the tightest
 * curve. The bridges are part of the same alignment. The east one leaves
 * the coast heading north-east, straight for Petrel's west shore, because
 * that is the one bearing the island's east side allows: between the lake,
 * the ring road and the coast there is no room to turn, so the line crosses
 * the ring's south-east corner at sixty degrees and does not turn at all.
 *
 * The 70 m is `SKYLARK_OFFSET` in `islandRailConfig`, which owns it now: the
 * airport's trunk is solved to land on this line, and the line starts where
 * the trunk ends (`RAIL_ORIGIN`).
 */
/** The ruling radius, metres. */
export const RAIL_R = 160;
/** Metres of deck run onto each shore past the coast. */
const RAIL_DECK_OVERLAP = 25;
/** The straight run inland from the west deck's end before the first curve. */
const RAIL_LANDING_RUN = 100;
/** Where the east pier ends: a boat's length off Petrel's west shore, which is x ≈ 570 in this frame. */
const PIER_END: [number, number] = [556, -160];
/** The island's waypoints, from the first curve after the west deck to the east coast. */
const RAIL_ISLAND_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-388, -230], [-452, -120], [-462, -30], [-462, 80], [-445, 180], [-405, 255], [-368, 306],
  [-320, 342], [-255, 352], [-160, 345], [-70, 355], [20, 350], [100, 330], [160, 268], [185, 195],
  [306, 100], [400, -40],
];
/**
 * The line's origin: the joint with Halcyon Field's trunk, out over the water.
 *
 * It used to be a pair of buffer stops on the airfield, west of the west link,
 * on a bank standing 4.6 m over the crown. The airport's island line now comes
 * down the island, crosses the Skylark road on its deck at the tip and lands on
 * this line's own straight, and the Skylark line starts exactly where it ends:
 * `TRUNK_RAILHEAD`, in the airport's frame, which is on `OUTER_ROAD_Z +
 * RAIL_OFFSET` by construction. One railway, one cross-section at the joint —
 * the same pair, the same heading, the same rail head.
 */
export const RAIL_ORIGIN: [number, number] = toLocal(...airportWorld(TRUNK_RAILHEAD[0], TRUNK_RAILHEAD[1]));
/**
 * Where the climb to Skylark begins, in the airport's `along`: just past the
 * trunk's crossing of the Skylark road.
 *
 * The rise to the island's 4.6 m is ONE ramp, and it does not start at the
 * joint. The joint is 171 m from the landfall, which is 2.7% before any
 * easing — over `RAIL_MAX_GRADE`. So the trunk starts climbing as soon as its
 * outer rail is off the road deck, at the island's tip, and the Skylark deck
 * carries the same grade on without a change: from here to the landfall is
 * about 330 m, and the grade comes out under 2%.
 */
const RAIL_CLIMB_FROM_ALONG = -446;
/** The parabolic ease at each end of the climb, metres. */
const RAIL_CLIMB_EASE = 60;

const inAirportLocal = (x: number, z: number): boolean => {
  const [gx, gz] = toWorld(x, z);
  const dx = gx - AIRPORT_SITE.centre[0];
  const dz = gz - AIRPORT_SITE.centre[1];
  const c = Math.cos(AIRPORT_SITE.heading);
  const sn = Math.sin(AIRPORT_SITE.heading);
  const lx = dx * c - dz * sn;
  const lz = dx * sn + dz * c;
  let inside = false;
  for (let i = 0, j = AIRPORT_OUTLINE.length - 1; i < AIRPORT_OUTLINE.length; j = i++) {
    const [xi, zi] = AIRPORT_OUTLINE[i];
    const [xj, zj] = AIRPORT_OUTLINE[j];
    if ((zi > lz) !== (zj > lz) && lx < ((xj - xi) * (lz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

/**
 * Straights and tangent circular curves through `pts`, as a polyline no
 * coarser than 4 m. At each corner the curve of `radius` is set out with
 * tangent length `r·tan(θ/2)` back along the leg in and on along the leg
 * out; where a leg is too short for that the radius drops to what fits, and
 * the radii the corners got are returned with the line.
 */
export function filletAlignment(
  pts: ReadonlyArray<readonly [number, number]>, radius: number,
): { line: Array<[number, number]>; radii: number[] } {
  const coarse: Array<[number, number]> = [[pts[0][0], pts[0][1]]];
  const radii: number[] = [];
  let prevT = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = pts[i + 1];
    const lu = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / lu;
    const uz = (b[1] - a[1]) / lu;
    const lv = Math.hypot(d[0] - b[0], d[1] - b[1]);
    const vx = (d[0] - b[0]) / lv;
    const vz = (d[1] - b[1]) / lv;
    const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uz * vz)));
    if (theta < 0.005) { coarse.push([b[0], b[1]]); prevT = 0; continue; }
    const maxT = Math.min(lu - prevT, lv / 2);
    let r = radius;
    let t = r * Math.tan(theta / 2);
    if (t > maxT) { t = maxT; r = t / Math.tan(theta / 2); }
    radii.push(r);
    const s = ux * vz - uz * vx > 0 ? 1 : -1;
    const px = b[0] - ux * t;
    const pz = b[1] - uz * t;
    const cx = px - uz * s * r;
    const cz = pz + ux * s * r;
    const a0 = Math.atan2(pz - cz, px - cx);
    const steps = Math.max(2, Math.ceil((r * theta) / 4));
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + s * theta * (k / steps);
      coarse.push([cx + r * Math.cos(ang), cz + r * Math.sin(ang)]);
    }
    prevT = t;
  }
  coarse.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  // The straights, cut to 4 m, so a walk along the line can ask where it is.
  const line: Array<[number, number]> = [coarse[0]];
  for (let i = 1; i < coarse.length; i++) {
    const [ax, az] = coarse[i - 1];
    const [bx, bz] = coarse[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
    for (let k = 1; k <= n; k++) line.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return { line, radii };
}

/** Where the west bridge comes ashore: marched from the buffer stops along the crossing's bearing. */
const RAIL_LANDFALL_XZ: [number, number] = (() => {
  let left = false;
  for (let t = 0; t < 1400; t += 0.5) {
    const x = RAIL_ORIGIN[0] + BRIDGE_DIR[0] * t;
    const z = RAIL_ORIGIN[1] + BRIDGE_DIR[1] * t;
    if (!left) { if (t > 5 && !inAirportLocal(x, z)) left = true; continue; }
    if (inIsland(x, z)) return [x, z];
  }
  throw new Error('Skylark: the railway never reaches the island');
})();
const RAIL_COURSE = (() => {
  const deckEnd: [number, number] = [
    RAIL_LANDFALL_XZ[0] + BRIDGE_DIR[0] * RAIL_DECK_OVERLAP, RAIL_LANDFALL_XZ[1] + BRIDGE_DIR[1] * RAIL_DECK_OVERLAP,
  ];
  const first: [number, number] = [
    deckEnd[0] + BRIDGE_DIR[0] * RAIL_LANDING_RUN, deckEnd[1] + BRIDGE_DIR[1] * RAIL_LANDING_RUN,
  ];
  return filletAlignment([RAIL_ORIGIN, first, ...RAIL_ISLAND_POINTS, PIER_END], RAIL_R);
})();
/** The tightest curve the alignment had to accept, metres. */
export const RAIL_TIGHTEST = Math.min(...RAIL_COURSE.radii);
/** Where the line leaves the island for Petrel: the course's last point ashore, and its heading there. */
const RAIL_EXIT = (() => {
  const line = RAIL_COURSE.line;
  let last = -1;
  for (let i = 0; i < line.length; i++) if (inIsland(line[i][0], line[i][1])) last = i;
  if (last < 0 || last >= line.length - 1) throw new Error('Skylark: the railway never leaves the island');
  const [ax, az] = line[last];
  const [bx, bz] = line[last + 1];
  const len = Math.hypot(bx - ax, bz - az) || 1;
  return { shore: [ax, az] as [number, number], dir: [(bx - ax) / len, (bz - az) / len] as [number, number] };
})();
/** The pads at the two shores, which the ground is fitted to at the decks' heights. */
const RAIL_LANDING_PAD: [number, number] = [
  RAIL_LANDFALL_XZ[0] + BRIDGE_DIR[0] * 20, RAIL_LANDFALL_XZ[1] + BRIDGE_DIR[1] * 20,
];
const RAIL_EAST_PAD: [number, number] = [
  RAIL_EXIT.shore[0] - RAIL_EXIT.dir[0] * 18, RAIL_EXIT.shore[1] - RAIL_EXIT.dir[1] * 18,
];

/* -------------------------------------------- the road bridge to Petrel */

/**
 * The road to the circuit, beside the railway's east bridge: a T on the
 * ring's east leg, a lane north-east to the coast on the railway's own
 * bearing 28 m to its north-west, and a bridge across to Petrel's shore
 * road — which the nav raster puts at x ≈ 573 in this frame, at 0.0 m, 3.6
 * m over the sea. The bearing is the railway's so the two bridges run
 * parallel and never meet; the T's bar is the ring's own tangent there.
 */
export const PETREL_DIR: [number, number] = [0.783, -0.622];
const PETREL_T: [number, number] = [322, -6];
/** Petrel's beach begins and its shore road's near edge, in this frame, along `PETREL_DIR`. */
const PETREL_LAND_X = 564;
const PETREL_ROAD_X = 573;
const PETREL_ROAD_Y = 0.0;
const PETREL_SHORE_XZ: [number, number] = (() => {
  for (let t = 20; t < 400; t += 0.5) {
    const x = PETREL_T[0] + PETREL_DIR[0] * t;
    const z = PETREL_T[1] + PETREL_DIR[1] * t;
    if (!inIsland(x, z)) return [x, z];
  }
  throw new Error('Skylark: the Petrel road never reaches the coast');
})();
const PETREL_DECK_OVERLAP = 14;
const PETREL_DECK_START: [number, number] = [
  PETREL_SHORE_XZ[0] - PETREL_DIR[0] * PETREL_DECK_OVERLAP, PETREL_SHORE_XZ[1] - PETREL_DIR[1] * PETREL_DECK_OVERLAP,
];
/**
 * The deck's height at the island: fixed, and low. The relief at the coast
 * here is 11 m, and a deck starting there fell 11 m to Petrel's road with
 * no room for a hump; the landing pad cuts the shore down to this instead,
 * and the lane comes down to it from the T at 5 %.
 */
const PETREL_LANDING_Y = 6.0;

export interface Junction {
  x: number;
  z: number;
  /** Radians about +Y, three's convention: local +X goes to (cos, −sin). */
  turn: number;
  piece: 'junctionT' | 'junctionX';
  label: string;
}

/**
 * The two junctions.
 *
 * The bridge head is turned to the crossing's own bearing, so its bar runs
 * along the bridge line — one arm back to the deck, the other on toward the
 * hamlet — and its stem, which the kit puts at −Z, points west-north-west to
 * Home Farm. The crossroads is turned a little off the world's axes for no
 * reason but that a hamlet laid out square to a map looks planned.
 */
export const JUNCTIONS = {
  bridgeHead: {
    x: BRIDGE_HEAD[0], z: BRIDGE_HEAD[1],
    // Local +X goes to (cos φ, −sin φ); it has to be the bearing BACK up the
    // deck, so cos φ = −dir.x and sin φ = dir.z.
    turn: Math.atan2(BRIDGE_DIR[1], -BRIDGE_DIR[0]),
    piece: 'junctionT' as const, label: 'bridge head',
  },
  cross: { x: 0, z: -60, turn: -0.35, piece: 'junctionX' as const, label: 'Skylark crossroads' },
  /**
   * Where Quay Lane leaves the ring road for the coombe. The ring runs
   * west-north-west here, so the bar is turned to that and the stem — the
   * kit's −Z — points south-south-west, down the valley.
   */
  coombe: { x: -238, z: 207, turn: 2.678, piece: 'junctionT' as const, label: 'the coombe T' },
  /**
   * Where the Petrel road leaves the ring's east leg for the bridge. The bar
   * is the ring's tangent here (south-east, 52°) and the stem — the kit's
   * −Z — points north-east, straight down the bridge's bearing.
   */
  petrelT: { x: PETREL_T[0], z: PETREL_T[1], turn: Math.atan2(-0.783, 0.622), piece: 'junctionT' as const, label: 'the Petrel T' },
} satisfies Record<string, Junction>;

export type Arm = 'px' | 'nx' | 'pz' | 'nz';

/** The direction a junction's arm points, in the island frame. */
export function armDirection(j: Junction, arm: Arm): [number, number] {
  const c = Math.cos(j.turn);
  const s = Math.sin(j.turn);
  switch (arm) {
    case 'px': return [c, -s];
    case 'nx': return [-c, s];
    case 'pz': return [s, c];
    case 'nz': return [-s, -c];
  }
}

/** Where a lane leaves a junction: the tile's edge on that arm. */
export function armMouth(j: Junction, arm: Arm): [number, number] {
  const [dx, dz] = armDirection(j, arm);
  return [j.x + dx * HALF, j.z + dz * HALF];
}

/* ----------------------------------------------------------- the places */

/** Home Farm, in the north-west: the big one, off the bridge head's stem. */
export const HOME_FARM = { x: -248, z: -184, r: 42, turn: 0.29, label: 'Home Farm' } as const;
/** Hill Farm, on the north slope of the downs above the ring road. */
export const HILL_FARM = { x: -208, z: 104, r: 30, turn: -0.55, label: 'Hill Farm' } as const;
/** The hamlet round the crossroads, and how far its graded ground reaches. */
export const HAMLET = { x: 0, z: -60, r: 120, blend: 70 } as const;
export const CHURCH = { x: 72, z: -150, turn: 0.35, yard: 26 } as const;
export const PUB = { x: 20, z: -27, turn: -1.2 } as const;
export const GREEN = { memorial: [22, -70] as const, cricket: [118, -100] as const };
export const PADDOCK = { x: -62, z: -128, w: 56, d: 42, turn: -0.35 } as const;

/**
 * The poultry farm, beside the paddock.
 *
 * In the paddock's own frame — 14 m along its length and 40 m off its side —
 * so the two enclosures move together and read as one holding. The spot was
 * measured rather than chosen: of the eight places round the paddock, this
 * is the one where all nine points of a 36 × 24 m footprint sit within five
 * centimetres of each other and nothing is within forty metres, which for a
 * run a bird has to be let out into matters more than for a shed.
 */
export const POULTRY = (() => {
  const c = Math.cos(PADDOCK.turn);
  const s = Math.sin(PADDOCK.turn);
  const u = 14;
  const v = -40;
  return {
    x: PADDOCK.x + u * c + v * s,
    z: PADDOCK.z - u * s + v * c,
    w: 36,
    d: 24,
    turn: PADDOCK.turn,
    label: 'the poultry farm',
  } as const;
})();
/** The windmill on Mill Knoll, and the flat top it stands on. */
export const MILL = { x: -150, z: 0, r: 16, turn: 0.4 } as const;
/** Hanger Wood, on Beacon Hill. */
export const WOOD = { x: 262, z: -152, rx: 140, rz: 100, rot: 0.3 } as const;
/** The turbines, along the crest of the downs. */
export const TURBINES = [
  { x: -238, z: 182 }, { x: -96, z: 206 }, { x: 56, z: 204 }, { x: 150, z: 140 },
] as const;
export const TRIG = { x: -60, z: 190 } as const;
/** The summit car park, a little east of the trig point along the crest. */
export const SUMMIT = { x: -34, z: 176, r: 13, turn: 0.2 } as const;
/** On the new south-west tip, where the lobe runs out into the sea. */
export const LIGHTHOUSE = (() => {
  const [x, z] = coastPoint(2.78, 28);
  return { x, z } as const;
})();
/** Nine stones on the western ridge of the downs. */
export const STONE_CIRCLE = { x: -170, z: 202, r: 11, count: 9 } as const;
/** The chapel ruin on the west coast lane. */
export const CHAPEL = { x: -560, z: 108, turn: 0.5 } as const;

/**
 * The harbour, in the cove at the lobe's tip: a quay graded flat at
 * `quayY`, the village on it, and a stone pier out across the mouth.
 */
export const HARBOUR = (() => {
  // South-east of the brook's mouth, on the cove's back shore.
  const theta = 2.37;
  const [cx, cz] = coastPoint(theta, 44);
  // Outward from the centre of the island is outward from the quay.
  const out: [number, number] = [Math.cos(theta), Math.sin(theta)];
  return {
    x: cx, z: cz, r: 56, quayY: 2.2, out,
    /** The quay front faces the cove: local +z of the harbour's frame. */
    turn: Math.atan2(out[0], out[1]),
  } as const;
})();

/** The pier: a breakwater from the cove's south-eastern headland, out along the line of its mouth. */
export const PIER = (() => {
  const root = coastPoint(2.27, 3);
  const far = coastPoint(2.55, 0);
  const len = Math.hypot(far[0] - root[0], far[1] - root[1]);
  const dir: [number, number] = [(far[0] - root[0]) / len, (far[1] - root[1]) / len];
  const out: [number, number] = [Math.cos(2.41), Math.sin(2.41)];
  const mid: [number, number] = [root[0] + dir[0] * 36 + out[0] * 10, root[1] + dir[1] * 36 + out[1] * 10];
  const tip: [number, number] = [root[0] + dir[0] * 72 + out[0] * 14, root[1] + dir[1] * 72 + out[1] * 14];
  return { pts: [root, mid, tip] as Array<[number, number]>, width: 7, top: HARBOUR.quayY, label: 'the pier' } as const;
})();

export const CAMPSITE = { x: -348, z: 466, w: 70, d: 56, turn: 0.35 } as const;
export const VINEYARD = { x: -236, z: 418, w: 64, d: 46, turn: 0.2, rows: 9 } as const;
/** The watermill on the stream's east bank, a little above the harbour. */
export const WATERMILL = { x: -412, z: 348, turn: 0.55 } as const;
/** The scramble course: a gravel loop between Back Lane and the mill knoll — it moved inland for the railway. */
export const SCRAMBLE = { x: -225, z: -12 } as const;

/**
 * Three houses lifted out of the city map (`prepare-country.mjs`), for the
 * newer end of the hamlet and the campsite's farmhouse: a long one behind
 * Lane End, a wide one east of Church Lane, a small one by the campsite lane.
 * `turn` lays each one's long side along its lane.
 */
export const HOUSES = [
  { part: 'houseLong', x: -118, z: -98, turn: -0.45, label: 'Downs End' },
  { part: 'houseWide', x: 92, z: -214, turn: 1.22, label: 'Glebe Farm' },
  { part: 'houseSmall', x: -270, z: 432, turn: -2.2, label: 'Strand House' },
  // The harbour terrace: three houses along the back of the quay behind the
  // coast lane, facing the sea over it, with the Anchor at their end.
  { part: 'house10', x: HARBOUR.x + HARBOUR.out[0] * -26 + -HARBOUR.out[1] * -6, z: HARBOUR.z + HARBOUR.out[1] * -26 + HARBOUR.out[0] * -6, turn: HARBOUR.turn, scale: 0.9, label: 'Harbour View' },
  { part: 'house13', x: HARBOUR.x + HARBOUR.out[0] * -26 + -HARBOUR.out[1] * 14, z: HARBOUR.z + HARBOUR.out[1] * -26 + HARBOUR.out[0] * 14, turn: HARBOUR.turn, scale: 0.62, label: 'Seaward' },
  { part: 'house10', x: HARBOUR.x + HARBOUR.out[0] * -26 + -HARBOUR.out[1] * 34, z: HARBOUR.z + HARBOUR.out[1] * -26 + HARBOUR.out[0] * 34, turn: HARBOUR.turn, scale: 0.9, label: 'The Moorings' },
] as const;
/** Where the coombe lane ends: a car park by the ford, a walk from the fort's gate. */
export const FORT_CARPARK = { x: -368, z: 246, r: 11 } as const;
/** Where Church Lane ends: a car park on the north cliffs looking at the airfield. */
export const VIEWPOINT = { x: 64, z: -252, r: 17, turn: 0.35 } as const;
/** The boathouse on the lake's north shore, and its jetty. */
export const BOATHOUSE = { x: 196, z: -12, turn: 0.1 } as const;
export const ORCHARD = { x: -232, z: -118, w: 44, d: 36, turn: 0.29 } as const;

export const PADS: readonly PadSpec[] = [
  { x: DECK_END[0], z: DECK_END[1], r: 48, blend: 34, y: LANDING_Y, label: 'bridge landing' },
  { x: RAIL_LANDING_PAD[0], z: RAIL_LANDING_PAD[1], r: 34, blend: 26, y: RAIL_WEST_Y, label: 'railway landing' },
  { x: RAIL_EAST_PAD[0], z: RAIL_EAST_PAD[1], r: 34, blend: 26, y: RAIL_EAST_Y, label: 'railway east landing' },
  { x: PETREL_DECK_START[0], z: PETREL_DECK_START[1], r: 34, blend: 28, y: PETREL_LANDING_Y, label: 'petrel landing' },
  { x: HARBOUR.x, z: HARBOUR.z, r: HARBOUR.r, blend: 30, y: HARBOUR.quayY, label: 'the quay' },
  { x: SUMMIT.x, z: SUMMIT.z, r: SUMMIT.r + 3, blend: 14, label: 'summit car park' },
  { x: CAMPSITE.x, z: CAMPSITE.z, r: 44, blend: 26, label: 'campsite' },
  { x: WATERMILL.x, z: WATERMILL.z, r: 12, blend: 12, label: 'watermill' },
  { x: FORT_CARPARK.x, z: FORT_CARPARK.z, r: FORT_CARPARK.r, blend: 12, label: 'fort car park' },
  { x: CHAPEL.x, z: CHAPEL.z, r: 16, blend: 14, label: 'chapel' },
  { x: STONE_CIRCLE.x, z: STONE_CIRCLE.z, r: STONE_CIRCLE.r + 5, blend: 12, label: 'stone circle' },
  ...HOUSES.map((h) => ({ x: h.x, z: h.z, r: 15, blend: 12, label: h.label })),
  { x: JUNCTIONS.bridgeHead.x, z: JUNCTIONS.bridgeHead.z, r: 20, blend: 26, label: 'bridge head' },
  { x: JUNCTIONS.coombe.x, z: JUNCTIONS.coombe.z, r: 20, blend: 26, label: 'coombe T' },
  { x: JUNCTIONS.petrelT.x, z: JUNCTIONS.petrelT.z, r: 22, blend: 28, label: 'Petrel T' },
  { x: HAMLET.x, z: HAMLET.z, r: HAMLET.r, blend: HAMLET.blend, label: 'the hamlet' },
  { x: POULTRY.x, z: POULTRY.z, r: 24, blend: 18, label: POULTRY.label },
  { x: HOME_FARM.x, z: HOME_FARM.z, r: HOME_FARM.r, blend: 30, label: HOME_FARM.label },
  { x: HILL_FARM.x, z: HILL_FARM.z, r: HILL_FARM.r, blend: 26, label: HILL_FARM.label },
  { x: MILL.x, z: MILL.z, r: MILL.r, blend: 18, label: 'Mill Knoll top' },
  { x: VIEWPOINT.x, z: VIEWPOINT.z, r: VIEWPOINT.r + 4, blend: 20, label: 'viewpoint' },
  { x: CHURCH.x, z: CHURCH.z, r: CHURCH.yard + 4, blend: 20, label: 'churchyard' },
  { x: BOATHOUSE.x, z: BOATHOUSE.z, r: 16, blend: 14, label: 'boathouse' },
  ...TURBINES.map((t, i) => ({ x: t.x, z: t.z, r: 9, blend: 12, label: `turbine ${i + 1}` })),
  { x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, r: 12, blend: 12, label: 'lighthouse' },
  { x: PONDS[1].x, z: PONDS[1].z, r: PONDS[1].r + 5, blend: 10, label: 'dew pond' },
];

const PAD_LIST = PADS.map((p) => ({ ...p, y: p.y ?? reliefAt(p.x, p.z) }));

/** The relief with the pads and the lake in it — the ground before the lanes cut it. */
export function paddedAt(x: number, z: number): number {
  let h = reliefAt(x, z);
  for (const pad of PAD_LIST) {
    const d = Math.hypot(x - pad.x, z - pad.z);
    if (d >= pad.r + pad.blend) continue;
    h = lerp(pad.y, h, smooth((d - pad.r) / pad.blend));
  }
  h = beachAt(x, z, h);
  // The lake: a flat bank at the water's edge, the ground climbing out of it,
  // and the bed dished under the surface.
  const f = lakeFraction(x, z);
  const R = lakeRadius(Math.atan2(z - LAKE.z, x - LAKE.x));
  const bankEdge = 1 + LAKE.bank / R;
  const shoreEdge = bankEdge + LAKE.shore / R;
  if (f < shoreEdge) {
    const bankY = LAKE_Y + 0.35;
    if (f >= bankEdge) h = lerp(bankY, h, smooth((f - bankEdge) / (shoreEdge - bankEdge)));
    else if (f >= 1) h = bankY;
    else h = LAKE_Y - LAKE.depth * (1 - f * f) + 0.05;
  }
  for (const pond of PONDS) {
    const d = Math.hypot(x - pond.x, z - pond.z);
    if (d >= pond.r + 6) continue;
    const y = pondLevel(pond);
    if (d <= pond.r) h = y - 1.2 * (1 - (d / pond.r) ** 2) + 0.05;
    else h = lerp(y + 0.3, h, smooth((d - pond.r) / 6));
  }
  return h;
}

export function pondLevel(pond: { x: number; z: number; r: number }): number {
  // Just under the flat ground the pond is dug into; the pads have already
  // been applied where the ponds are, so the relief is the graded height.
  let h = reliefAt(pond.x, pond.z);
  for (const pad of PAD_LIST) {
    const d = Math.hypot(pond.x - pad.x, pond.z - pad.z);
    if (d >= pad.r + pad.blend) continue;
    h = lerp(pad.y, h, smooth((d - pad.r) / pad.blend));
  }
  return h - 0.55;
}

/* ----------------------------------------------------------- the stream */

/**
 * The brook: from a spring under the downs' western shoulder, down the
 * coombe it has cut through the lobe, into the harbour cove.
 *
 * Its bed is the ground along its own line, smoothed and forced downhill —
 * a stream that ran uphill for ten metres would be the one thing on the
 * island nobody would believe — and the ground either side is cut to a V
 * off that bed, which is what makes the coombe. A narrow channel is cut a
 * further 0.75 m for the water to sit in, and `CountryIsland` sweeps the
 * water along the bed. Where a lane crosses, `CROSSINGS` says whether it
 * goes over on a bridge or through at a ford.
 */
/** Where the brook meets the sea: the cove's north-west shore. */
const STREAM_MOUTH_THETA = 2.46;
export const STREAM_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-330, 216], [-360, 258], [-392, 296], [-418, 326],
  coastPoint(STREAM_MOUTH_THETA, 34), coastPoint(STREAM_MOUTH_THETA, 12), coastPoint(STREAM_MOUTH_THETA, -14),
];
const STREAM_STEP = 3;
/** How wide the coombe is cut, and how steeply its sides climb off the bed. */
const VALLEY_REACH = 70;
const VALLEY_SIDE = 0.28;
const CHANNEL_HALF = 2.4;
const CHANNEL_DEPTH = 0.75;

export interface StreamSample { x: number; z: number; bed: number; nx: number; nz: number; arc: number }

function splineThrough(points: ReadonlyArray<readonly [number, number]>, ghostStart?: readonly [number, number], ghostEnd?: readonly [number, number], closed = false): Array<[number, number]> {
  const pts = points.map(([x, z]) => [x, z] as [number, number]);
  const P = closed
    ? [pts[pts.length - 1], ...pts, pts[0], pts[1]]
    : [ghostStart ?? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]], ...pts,
      ghostEnd ?? [2 * pts[pts.length - 1][0] - pts[pts.length - 2][0], 2 * pts[pts.length - 1][1] - pts[pts.length - 2][1]]];
  const out: Array<[number, number]> = [];
  const STEPS = 32;
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < STEPS; k++) {
      const t = k / STEPS;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  else out.push([pts[0][0], pts[0][1]]);
  return out;
}

/** Even samples along a fine polyline, each with its left normal and tangent. */
function evenSamples(fine: Array<[number, number]>, step: number) {
  const cum = [0];
  for (let i = 1; i < fine.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]));
  }
  const length = cum[cum.length - 1];
  const count = Math.max(2, Math.round(length / step));
  const pitch = length / count;
  const out: Array<{ x: number; z: number; nx: number; nz: number; tx: number; tz: number; arc: number }> = [];
  let j = 0;
  for (let i = 0; i <= count; i++) {
    const sArc = Math.min(length, i * pitch);
    while (j < cum.length - 2 && cum[j + 1] < sArc) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const t = (sArc - cum[j]) / span;
    out.push({
      x: lerp(fine[j][0], fine[j + 1][0], t), z: lerp(fine[j][1], fine[j + 1][1], t),
      nx: 0, nz: 0, tx: 0, tz: 0, arc: sArc,
    });
  }
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(out.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    out[i].tx = dx / len;
    out[i].tz = dz / len;
    out[i].nx = -dz / len;
    out[i].nz = dx / len;
  }
  return out;
}

export const STREAM: readonly StreamSample[] = (() => {
  const raw = evenSamples(splineThrough(STREAM_POINTS), STREAM_STEP);
  const bed = raw.map((r) => paddedAt(r.x, r.z) - 1.0);
  for (let pass = 0; pass < 12; pass++) {
    const copy = [...bed];
    for (let i = 1; i < bed.length - 1; i++) bed[i] = (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4;
  }
  // Downhill, every step, all the way to the sea.
  for (let i = 1; i < bed.length; i++) bed[i] = Math.min(bed[i], bed[i - 1] - 0.03);
  return raw.map((r, i) => ({ x: r.x, z: r.z, bed: bed[i], nx: r.nx, nz: r.nz, arc: r.arc }));
})();

/* ------------------------------------------------------------ the lanes */

/**
 * Two classes of road.
 *
 * A `lane` is the modular kit's carriageway, 19 m of four lanes, swept along
 * a spline — the main roads. A `mini` is a single-track country road, 4.6 m
 * of plain tarmac or 4.2 m of gravel, which is what actually joins a farm
 * to a lane or climbs to a hilltop; the kit has no such piece, so these are
 * swept with a texture of their own. Both are lofts, both carve the ground,
 * both are colliders; only the width, the surface and how far the ground is
 * held flat either side differ.
 */
export type RoadClass = 'lane' | 'mini';
export type Surface = 'kit' | 'tarmac' | 'gravel';

export const MINI_WIDTH: Record<'tarmac' | 'gravel', number> = { tarmac: 4.6, gravel: 4.2 };

export interface RoadSample {
  x: number;
  z: number;
  /** Ground level of the carriageway, before `ROAD_TOP`. */
  y: number;
  /** Unit normal, left of travel. */
  nx: number;
  nz: number;
  /** Unit tangent. */
  tx: number;
  tz: number;
  arc: number;
}

/** Where a road joins another: at the arc nearest `at`, on one side, or on the centreline (`side` 0) at its end. */
interface OnRoad {
  road: string;
  at?: readonly [number, number];
  s?: number;
  side: 1 | -1 | 0;
}

export interface RoadDef {
  name: string;
  label: string;
  cls: RoadClass;
  surface: Surface;
  points: ReadonlyArray<readonly [number, number]>;
  startTangent?: readonly [number, number];
  endTangent?: readonly [number, number];
  startY?: number;
  endY?: number;
  startOn?: OnRoad;
  endOn?: OnRoad;
  closed?: boolean;
  /** Smoothing passes over the profile; fewer keeps the ground's own lumps. */
  smoothing?: number;
  /** Metres of deliberate lumps added along the profile — the scramble course. */
  bumps?: number;
}

export interface Road {
  name: string;
  label: string;
  cls: RoadClass;
  surface: Surface;
  width: number;
  samples: RoadSample[];
  length: number;
  closed: boolean;
}

export interface Crossing {
  road: string;
  /** Arc along the road, and the point. */
  s: number;
  x: number;
  z: number;
  /** The stream's bed there, and the road's surface. */
  bed: number;
  y: number;
  kind: 'bridge' | 'ford';
  /** The road's tangent, which the bridge is laid along. */
  tx: number;
  tz: number;
}

/** Sampling pitch along every road. */
export const LANE_STEP = 3;
/** The steepest a road may be. */
export const MAX_GRADE = 0.1;
export const MAX_GRADE_MINI = 0.16;
/** How high a bridge deck stands over the bed, and how far a ford sits above it. */
const BRIDGE_RISE = 3.4;
const FORD_RISE = 0.15;

const mouth = (name: keyof typeof JUNCTIONS, arm: Arm) => armMouth(JUNCTIONS[name], arm);
const outward = (name: keyof typeof JUNCTIONS, arm: Arm) => armDirection(JUNCTIONS[name], arm);
const inward = (name: keyof typeof JUNCTIONS, arm: Arm): [number, number] => {
  const [dx, dz] = armDirection(JUNCTIONS[name], arm);
  return [-dx, -dz];
};
const padY = (x: number, z: number) => paddedAt(x, z);

/** The quay's own axis: along the front, and out to sea. */
const QUAY_ALONG: [number, number] = [-HARBOUR.out[1], HARBOUR.out[0]];
const quayPoint = (along: number, out = 0): [number, number] => [
  HARBOUR.x + QUAY_ALONG[0] * along + HARBOUR.out[0] * out,
  HARBOUR.z + QUAY_ALONG[1] * along + HARBOUR.out[1] * out,
];

const ROAD_DEFS: readonly RoadDef[] = [
  {
    name: 'bridgeLane', label: 'Bridge Lane', cls: 'lane', surface: 'kit',
    points: [DECK_END, mouth('bridgeHead', 'px')],
    startTangent: BRIDGE_DIR, endTangent: inward('bridgeHead', 'px'),
    startY: LANDING_Y, endY: padY(JUNCTIONS.bridgeHead.x, JUNCTIONS.bridgeHead.z),
  },
  {
    name: 'laneEnd', label: 'Lane End', cls: 'lane', surface: 'kit',
    points: [mouth('bridgeHead', 'nx'), [-196, -112], [-166, -84], [-112, -70], [-58, -66], mouth('cross', 'nx')],
    startTangent: outward('bridgeHead', 'nx'), endTangent: inward('cross', 'nx'),
    startY: padY(JUNCTIONS.bridgeHead.x, JUNCTIONS.bridgeHead.z), endY: padY(JUNCTIONS.cross.x, JUNCTIONS.cross.z),
  },
  {
    name: 'farmLane', label: 'Home Farm lane', cls: 'lane', surface: 'kit',
    points: [mouth('bridgeHead', 'nz'), [-214, -178], [-236, -181]],
    startTangent: outward('bridgeHead', 'nz'),
    startY: padY(JUNCTIONS.bridgeHead.x, JUNCTIONS.bridgeHead.z), endY: padY(HOME_FARM.x, HOME_FARM.z),
  },
  {
    name: 'churchLane', label: 'Church Lane', cls: 'lane', surface: 'kit',
    points: [mouth('cross', 'nz'), [22, -112], [42, -160], [58, -212], [VIEWPOINT.x, VIEWPOINT.z]],
    startTangent: outward('cross', 'nz'),
    startY: padY(JUNCTIONS.cross.x, JUNCTIONS.cross.z), endY: padY(VIEWPOINT.x, VIEWPOINT.z),
  },
  {
    name: 'ringEast', label: 'the ring road, east',
    cls: 'lane', surface: 'kit',
    // Out of the crossroads eastward, north of the lake, down the east coast
    // and along the south under the downs to the coombe T.
    points: [mouth('cross', 'px'), [76, -40], [142, -24], [216, -40], [290, -30], mouth('petrelT', 'nx')],
    startTangent: outward('cross', 'px'), endTangent: inward('petrelT', 'nx'),
    startY: padY(JUNCTIONS.cross.x, JUNCTIONS.cross.z), endY: padY(JUNCTIONS.petrelT.x, JUNCTIONS.petrelT.z),
  },
  {
    name: 'ringSouth', label: 'the ring road, south',
    cls: 'lane', surface: 'kit',
    // On from the Petrel T down the east coast and along the south under the
    // downs to the coombe T.
    points: [mouth('petrelT', 'px'), [354, 76], [340, 148], [288, 194], [200, 222], [106, 236], [0, 250],
      [-104, 240], [-202, 224], mouth('coombe', 'nx')],
    startTangent: outward('petrelT', 'px'), endTangent: inward('coombe', 'nx'),
    startY: padY(JUNCTIONS.petrelT.x, JUNCTIONS.petrelT.z), endY: padY(JUNCTIONS.coombe.x, JUNCTIONS.coombe.z),
  },
  {
    name: 'petrelLane', label: 'the Petrel road',
    cls: 'lane', surface: 'kit',
    // Out of the T's stem north-east to the coast, where the bridge to the
    // circuit takes over.
    points: [mouth('petrelT', 'nz'), PETREL_DECK_START],
    startTangent: outward('petrelT', 'nz'), endTangent: PETREL_DIR,
    startY: padY(JUNCTIONS.petrelT.x, JUNCTIONS.petrelT.z), endY: PETREL_LANDING_Y,
  },
  {
    name: 'ringWest', label: 'the ring road, west',
    cls: 'lane', surface: 'kit',
    // On from the coombe T over the downs' western shoulder and back
    // north-east past Hill Farm into the crossroads from the south.
    points: [mouth('coombe', 'px'), [-274, 188], [-302, 136], [-262, 92], [-190, 62], [-122, 44],
      [-58, 8], mouth('cross', 'pz')],
    startTangent: outward('coombe', 'px'), endTangent: inward('cross', 'pz'),
    startY: padY(JUNCTIONS.coombe.x, JUNCTIONS.coombe.z), endY: padY(JUNCTIONS.cross.x, JUNCTIONS.cross.z),
  },
  {
    name: 'quayLane', label: 'Quay Lane', cls: 'lane', surface: 'kit',
    // Down the coombe's east side to the harbour, then along the quay front.
    // Down the coombe's east side to the harbour, and onto the quay's apron
    // at its cove end — not along the front, where a four-lane kit road with
    // its markings laid across the setts was the wrong thing.
    // Down the coombe's east side and straight onto the quay's apron,
    // facing the sea. It used to turn along the front to hand over to the
    // coast lane, which was a right angle in twenty metres; the coast lane
    // leaves it from a T further up instead.
    points: [mouth('coombe', 'nz'), [-262, 262], [-300, 316], quayPoint(-48, -24), quayPoint(-44, 8)],
    startTangent: outward('coombe', 'nz'), endTangent: HARBOUR.out,
    startY: padY(JUNCTIONS.coombe.x, JUNCTIONS.coombe.z), endY: HARBOUR.quayY,
  },
  // ---- the single-track roads ----
  {
    name: 'scrambleLoop', label: 'the scramble course', cls: 'mini', surface: 'gravel',
    points: [[-190, -40], [-225, -55], [-250, -30], [-247, 10], [-220, 30], [-193, 15]],
    closed: true, smoothing: 10, bumps: 0.45,
  },
  {
    name: 'coastLane', label: 'the coast lane', cls: 'mini', surface: 'tarmac',
    // On from the end of the quay: over the brook, round the back of the
    // cove, under Castle Hill to the lighthouse, and up the west coast to
    // Home Farm.
    // ...and on round the north-west coast, outside the railway, to Bridge
    // Lane by the landing. It used to cut inland to Home Farm; the line has
    // that ground now, and the farm keeps its own lane off the bridge-head T.
    // Behind the harbour terrace, not through it: along the back of the
    // houses and on to the brook.
    points: [[-388, 370], [-425, 364], quayPoint(70, -14), quayPoint(96, -4), coastPoint(2.55, 30), coastPoint(2.62, 30),
      coastPoint(2.7, 36), coastPoint(2.79, 50), coastPoint(2.88, 36), coastPoint(2.97, 30),
      coastPoint(3.06, 30), coastPoint(-3.0, 34), coastPoint(-2.85, 34), coastPoint(-2.7, 34),
      coastPoint(-2.55, 34), coastPoint(-2.4, 34), coastPoint(-2.25, 36)],
    startOn: { road: 'quayLane', at: [-340, 368], side: 1 },
    endOn: { road: 'bridgeLane', at: [-140, -290], side: 1 },
  },
  {
    name: 'coombeLane', label: 'the coombe lane', cls: 'mini', surface: 'gravel',
    // Off Quay Lane, through the brook at the ford, and up to the fort's car park.
    // Through the brook at the ford to a car park on its west bank; the fort
    // is a walk from there, over the line by a path.
    points: [[-300, 252], [-345, 238], [-362, 244]],
    startOn: { road: 'quayLane', at: [-262, 262], side: 1 },
    endY: padY(FORT_CARPARK.x, FORT_CARPARK.z),
  },
  {
    name: 'summitTrack', label: 'the summit track', cls: 'mini', surface: 'gravel',
    points: [[-92, 56], [-46, 100], [-108, 142], [-76, 174], [SUMMIT.x - 4, SUMMIT.z - 2]],
    startOn: { road: 'ringWest', at: [-62, 8], side: 1 },
    endY: padY(SUMMIT.x, SUMMIT.z),
  },
  {
    name: 'millLane', label: 'Mill Lane', cls: 'mini', surface: 'tarmac',
    points: [[-176, -52], [-160, -26], [-152, -18]],
    startOn: { road: 'laneEnd', at: [-166, -84], side: 1 },
    endY: padY(MILL.x, MILL.z),
  },
  {
    name: 'boathouseLane', label: 'the boathouse lane', cls: 'mini', surface: 'gravel',
    points: [[208, -28], [202, -18], [199, -13]],
    startOn: { road: 'ringEast', at: [216, -40], side: 1 },
  },
  {
    name: 'woodRide', label: 'the wood ride', cls: 'mini', surface: 'gravel',
    // A loop through Hanger Wood and back to the ring, not a dead end.
    points: [[278, -80], [264, -140], [250, -200], [198, -196], [186, -130], [200, -80]],
    startOn: { road: 'ringEast', at: [290, -30], side: -1 },
    endOn: { road: 'ringEast', at: [216, -40], side: -1 },
  },
  {
    name: 'hillFarmLane', label: 'Hill Farm lane', cls: 'mini', surface: 'tarmac',
    points: [[-204, 84], [-206, 96]],
    startOn: { road: 'ringWest', at: [-200, 66], side: 1 },
    endY: padY(HILL_FARM.x, HILL_FARM.z),
  },
  {
    name: 'campsiteLane', label: 'the campsite lane', cls: 'mini', surface: 'tarmac',
    points: [[-358, 425], [-344, 442]],
    startOn: { road: 'quayLane', at: [-378, 392], side: -1 },
    endY: padY(CAMPSITE.x, CAMPSITE.z),
  },
  // ---- more of the grey single-tracks, asked for by name ----
  {
    name: 'backLane', label: 'Back Lane', cls: 'mini', surface: 'tarmac',
    // Home Farm south to the ring road under Hill Farm: the west side's loop.
    points: [[-262, -150], [-282, -90], [-286, -20], [-276, 48]],
    startOn: { road: 'farmLane', at: [-236, -181], side: 1 },
    endOn: { road: 'ringWest', at: [-262, 92], side: -1 },
  },
  {
    name: 'quarryRoad', label: 'the quarry road', cls: 'mini', surface: 'tarmac',
    // Off Back Lane north-west to Skylark Quarry's gate: the works' own
    // access, a real road and not a painted track, so a lorry can drive in.
    // It leaves Back Lane down where that lane is on the ground — level with
    // the gate it is 14 m up on its bank — and ends at the terrace's level
    // (7.2; `MINE` is declared further down this file), arriving square to
    // the gateway from the east.
    points: [[-294, -84], [-306, -50], [-309, -22], [-313, -6]],
    startOn: { road: 'backLane', at: [-281, -98], side: 1 },
    endY: 7.2,
  },
  {
    name: 'lakeLane', label: 'Lake Lane', cls: 'mini', surface: 'tarmac',
    // Down the west side of the lake and over the downs' eastern end to the south leg.
    points: [[124, 20], [112, 80], [116, 140], [110, 196]],
    startOn: { road: 'ringEast', at: [142, -24], side: 1 },
    endOn: { road: 'ringSouth', at: [106, 236], side: -1 },
  },
  {
    name: 'vineyardLane', label: 'the vineyard lane', cls: 'mini', surface: 'tarmac',
    points: [[-256, 350], [VINEYARD.x, VINEYARD.z - VINEYARD.d / 2 - 12]],
    startOn: { road: 'quayLane', at: [-288, 300], side: -1 },
  },
  {
    name: 'circleLane', label: 'the stone circle lane', cls: 'mini', surface: 'tarmac',
    // Up from Hill Farm's yard to the stones on the ridge.
    points: [[-196, 132], [-186, 162], [STONE_CIRCLE.x - 6, STONE_CIRCLE.z - 20]],
    startOn: { road: 'hillFarmLane', at: [-206, 96], side: 0 },
    endY: padY(STONE_CIRCLE.x - 6, STONE_CIRCLE.z - 20),
  },
  {
    name: 'scrambleSpur', label: 'the scramble spur', cls: 'mini', surface: 'gravel',
    points: [[-202, 44]],
    startOn: { road: 'ringWest', at: [-200, 66], side: -1 },
    endOn: { road: 'scrambleLoop', at: [-193, 15], side: 1 },
  },
];

function widthOf(def: RoadDef): number {
  return def.cls === 'lane' ? LANE_WIDTH : MINI_WIDTH[def.surface === 'gravel' ? 'gravel' : 'tarmac'];
}

/** The sample of a road nearest a point, and its index. */
function nearestSample(road: Road, x: number, z: number): { i: number; sample: RoadSample } {
  let best = 0;
  let bestD = Infinity;
  road.samples.forEach((sm, i) => {
    const d = Math.hypot(sm.x - x, sm.z - z);
    if (d < bestD) { bestD = d; best = i; }
  });
  return { i: best, sample: road.samples[best] };
}

/** Where a road joins another: the point on that road's edge, the way out, the height. */
function resolveJoin(
  on: OnRoad, built: Road[], from?: readonly [number, number],
): { point: [number, number]; tangent: [number, number]; y: number } {
  const host = built.find((r) => r.name === on.road);
  if (!host) throw new Error(`Skylark: ${on.road} is not built yet`);
  const sample = on.at ? nearestSample(host, on.at[0], on.at[1]).sample
    : host.samples[Math.min(host.samples.length - 1, Math.max(0, Math.round((on.s ?? host.length) / LANE_STEP)))];
  if (on.side === 0) return { point: [sample.x, sample.z], tangent: [sample.tx, sample.tz], y: sample.y };
  // The side is the one the joining road ARRIVES from, read off its nearest
  // own point, whatever the definition says: Lake Lane's end was written as
  // the south side of the ring while the lane came down from the north, so
  // it ran straight across the carriageway to get there.
  const side = from
    ? (((from[0] - sample.x) * sample.nx + (from[1] - sample.z) * sample.nz) >= 0 ? 1 : -1)
    : on.side;
  // Just CLEAR of the host's footprint, not on its edge: a road that ended
  // on the edge laid its last metres coplanar over the host's pavement strip
  // and flickered against it, and its collider doubled the host's. The
  // ground between is the host's own flat band, at the host's height, so
  // the join is seamless without the two surfaces touching.
  const off = host.width / 2 + 0.35;
  return {
    point: [sample.x + sample.nx * off * side, sample.z + sample.nz * off * side],
    tangent: [sample.nx * side, sample.nz * side],
    y: sample.y,
  };
}

/** Distance from a point to the stream's line, and the bed there. */
function streamNear(x: number, z: number): { d: number; bed: number; i: number } {
  let best = { d: Infinity, bed: 0, i: 0 };
  for (let i = 0; i < STREAM.length - 1; i++) {
    const a = STREAM[i];
    const b = STREAM[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1;
    const t = clamp01(((x - a.x) * ex + (z - a.z) * ez) / len2);
    const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
    if (d < best.d) best = { d, bed: a.bed + (b.bed - a.bed) * t, i };
  }
  return best;
}

/** The ground a road is fitted to: the pads and the coombe, before any road cuts it. */
function bedrockAt(x: number, z: number): number {
  const h = paddedAt(x, z);
  const near = streamNear(x, z);
  if (near.d >= VALLEY_REACH) return h;
  return Math.min(h, near.bed + VALLEY_SIDE * near.d + 0.9);
}

/* ----------------------------------------------------------- the railway */

/**
 * The Skylark line: double track from a halt at the airfield's west end,
 * over a girder bridge beside the road viaduct, round the island on the
 * ground, and over a second bridge to a pier on the Petrel headland.
 *
 * ## Where it goes, and why not where it was drawn
 *
 * The user drew it round the outside of everything. Two stretches of that
 * could not be built as drawn: the north-west, where Home Farm sat 25 m from
 * the coast, and the south-west, where the harbour sits in a bowl 25 m below
 * the lobe and no railway at 2.5 % can get down to it and back inside the
 * island. So the coast gained a headland north-west of the farm (`SHAPE`),
 * the line runs the corridor that made, and it crosses the coombe at its
 * HEAD — a culvert over the brook and a level crossing on Quay Lane just
 * below the T — leaving the whole lobe south of it. Everything else is as
 * drawn: down the west side in a cutting through Castle Hill's flank,
 * across the south, over the ring road twice and up the east strip.
 *
 * ## On the ground
 *
 * Nothing on the island is elevated. The formation is the ground: `groundAt`
 * cuts the crown to the line's own profile, held `RAIL_FLAT` either side of
 * the pair's centre with sides whose width follows the depth of the cut —
 * steep in a deep cutting, gentle on a low bank. Ruling grade 2.5 %, the
 * profile fitted from the graded ground and pinned to the deck heights at
 * both shores. Where a lane crosses, the LANE takes the railway's height and
 * a deck carries it over the rails; where the brook crosses, the channel is
 * cut through the bank under a culvert.
 *
 * ## The frame
 *
 * Everything is in the island's frame, including the stretches on the
 * airfield's crown and out to the Petrel shore: the frame is world minus a
 * centre, so it reaches wherever the line does. `s` is metres from the
 * buffer stops at Halcyon Halt.
 */

/** Between the two tracks' centres — the main line's own. */
export const RAIL_GAP = 4.6;
/**
 * The pier end is no longer an end: the main line's junction branch
 * (`JUNCTION_CURVE` in `pointwork`) is solved to run onto it end-on, same pair,
 * same heading, same formation, so `CountryRail` leaves off its buffer stops
 * and end wall — and its whole east bridge: from the shore out, the line is
 * carried by the branch's viaduct (`BranchLine`), one design end to end.
 */
export const PIER_END_LINKED = true;
/** Half the formation: ballast shoulder to ballast shoulder for the pair. */
export const RAIL_FLAT = 7.2;
export const RAIL_MAX_GRADE = 0.025;
const RAIL_STEP = 3;

export interface RailSample {
  x: number;
  z: number;
  /** The formation: rail head is `RAIL_HEAD_LIFT` above it. */
  y: number;
  /** Ground under the formation before the line cut it, for the ballast's skirt. */
  ground: number;
  nx: number;
  nz: number;
  tx: number;
  tz: number;
  arc: number;
}

/** Where the island's station stands, and half its length: pinned level in the profile. */
const RAIL_STATION_SITES: ReadonlyArray<[number, number, number]> = [[20, 350, 58]];

/**
 * A climb of `rise` over `length`: a constant grade with a parabolic ease of
 * `ease` at each end, so the gradient changes smoothly into it and out of it.
 * The grade is `rise / (length - ease)`.
 */
function climbProfile(length: number, rise: number, ease: number) {
  const e = Math.min(ease, length / 3);
  const grade = rise / (length - e);
  const at = (u: number) => {
    if (u <= 0) return 0;
    if (u >= length) return rise;
    if (u < e) return (grade * u * u) / (2 * e);
    if (u > length - e) return rise - (grade * (length - u) ** 2) / (2 * e);
    return grade * (u - e / 2);
  };
  return { grade, at };
}

/**
 * The line at 3 m, graded.
 *
 * Off the island — the airfield, both bridges, the pier — the formation is
 * pinned to the decks' heights, and so are the deck overlaps on each shore.
 * On the island it is the terrain smoothed, held level through the station,
 * and walked out from every pin at the ruling grade: a cutting where the
 * hill is above it, a bank where the hill is below.
 */
function buildRail(): {
  samples: RailSample[];
  marks: Record<'airportShore' | 'landfall' | 'westDeckEnd' | 'eastDeckStart' | 'eastShore' | 'pierEnd', number>;
  climb: { from: number; total: number; grade: number; at: (u: number) => number };
} {
  const even = evenSamples(RAIL_COURSE.line, RAIL_STEP);
  const n = even.length;
  let airportShore = 0;
  for (let i = 0; i < n; i++) {
    if (inAirportLocal(even[i].x, even[i].z)) airportShore = i;
    else if (i > 2) break;
  }
  let landfall = n - 1;
  for (let i = airportShore + 1; i < n; i++) if (inIsland(even[i].x, even[i].z)) { landfall = i; break; }
  let eastShore = landfall;
  for (let i = landfall; i < n; i++) if (inIsland(even[i].x, even[i].z)) eastShore = i;
  const overlap = Math.round(RAIL_DECK_OVERLAP / RAIL_STEP);

  const y = even.map((sm) => bedrockAt(sm.x, sm.z));
  const pins = new Map<number, number>();
  /*
   * The climb, from the trunk's tip to the landfall: one constant grade with a
   * parabolic ease at each end, shared with the trunk — see `TRUNK_CLIMB`.
   */
  const trunk = trunkCentre();
  const jointArc = trunk[trunk.length - 1].arc;
  const climbFrom = trunk.find((q) => q.x <= RAIL_CLIMB_FROM_ALONG)?.arc ?? jointArc;
  const onTrunk = jointArc - climbFrom;
  const total = onTrunk + (even[landfall].arc - even[0].arc);
  const climb = climbProfile(total, RAIL_WEST_Y - AIRPORT_SITE.ground, RAIL_CLIMB_EASE);
  const westAt = (a: number) => AIRPORT_SITE.ground + climb.at(onTrunk + a - even[0].arc);
  for (let i = 0; i < n; i++) {
    if (i <= landfall) pins.set(i, westAt(even[i].arc));
    else if (i <= landfall + overlap) pins.set(i, RAIL_WEST_Y);
    if (i >= eastShore - overlap) pins.set(i, RAIL_EAST_Y);
  }
  const pin = () => { for (const [i, v] of pins) y[i] = v; };
  pin();
  for (let pass = 0; pass < 40; pass++) {
    const copy = [...y];
    for (let i = 1; i < n - 1; i++) y[i] = (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4;
    pin();
  }
  // The station stands level: its whole length is held at the height the
  // smoothed profile has at its middle, and the grade is walked out from it
  // like any other pin.
  for (const [cx, cz, half] of RAIL_STATION_SITES) {
    let mid = 0;
    let bestD = Infinity;
    even.forEach((sm, i) => {
      const d = Math.hypot(sm.x - cx, sm.z - cz);
      if (d < bestD) { bestD = d; mid = i; }
    });
    const level = y[mid];
    const span = Math.round(half / RAIL_STEP);
    for (let i = Math.max(1, mid - span); i <= Math.min(n - 2, mid + span); i++) pins.set(i, level);
  }
  pin();
  const rise = RAIL_MAX_GRADE * RAIL_STEP;
  for (let i = 1; i < n; i++) {
    y[i] = Math.min(y[i - 1] + rise, Math.max(y[i - 1] - rise, y[i]));
    if (pins.has(i)) y[i] = pins.get(i)!;
  }
  for (let i = n - 2; i >= 0; i--) {
    y[i] = Math.min(y[i + 1] + rise, Math.max(y[i + 1] - rise, y[i]));
    if (pins.has(i)) y[i] = pins.get(i)!;
  }
  const samples = even.map((e, i) => ({
    x: e.x, z: e.z, y: y[i], ground: paddedAt(e.x, e.z), nx: e.nx, nz: e.nz, tx: e.tx, tz: e.tz, arc: e.arc,
  }));
  return {
    samples,
    climb: { from: climbFrom, total, grade: climb.grade, at: climb.at },
    marks: {
      airportShore: even[airportShore].arc,
      landfall: even[landfall].arc,
      westDeckEnd: even[landfall].arc + RAIL_DECK_OVERLAP,
      eastDeckStart: even[eastShore].arc - RAIL_DECK_OVERLAP,
      eastShore: even[eastShore].arc,
      pierEnd: even[n - 1].arc,
    },
  };
}

const RAIL_BUILT = buildRail();
export const RAIL: readonly RailSample[] = RAIL_BUILT.samples;
export const RAIL_LENGTH = RAIL[RAIL.length - 1].arc;
/** Arcs of the things along the line. */
export const RAIL_MARKS = RAIL_BUILT.marks;

/**
 * The trunk's share of the climb to Skylark, for `IslandRail`: metres above the
 * airfield's crown at a given arc along `trunkCentre()`. Zero until the climb
 * begins at the island's tip; at the trunk's end it is exactly the Skylark
 * line's formation at its origin, so the joint has no step.
 */
export const TRUNK_CLIMB = {
  from: RAIL_BUILT.climb.from,
  grade: RAIL_BUILT.climb.grade,
  riseAt: (arc: number) => RAIL_BUILT.climb.at(arc - RAIL_BUILT.climb.from),
};

/** The sample nearest an arc, interpolated. */
export function railAt(sArc: number): RailSample {
  const t = Math.min(RAIL.length - 1, Math.max(0, sArc / RAIL_STEP));
  const i = Math.floor(t);
  const f = t - i;
  const a = RAIL[i];
  const b = RAIL[Math.min(RAIL.length - 1, i + 1)];
  const m = (p: number, q: number) => p + (q - p) * f;
  const tx = m(a.tx, b.tx);
  const tz = m(a.tz, b.tz);
  const len = Math.hypot(tx, tz) || 1;
  return {
    x: m(a.x, b.x), z: m(a.z, b.z), y: m(a.y, b.y), ground: m(a.ground, b.ground),
    tx: tx / len, tz: tz / len, nx: -tz / len, nz: tx / len, arc: sArc,
  };
}

/** A point on one of the two tracks: `lateral` metres left of the pair's centre. */
export function railPose(sArc: number, lateral: number): [number, number, number] {
  const p = railAt(sArc);
  return [p.x + p.nx * lateral, p.y, p.z + p.nz * lateral];
}

/** The nearest sample to a point on the line, how far off it, and the formation there. */
export function railNear(x: number, z: number): { d: number; sample: RailSample; i: number; y: number } {
  let best = { d: Infinity, sample: RAIL[0], i: 0, y: RAIL[0].y };
  for (let i = 0; i < RAIL.length - 1; i++) {
    const a = RAIL[i];
    const b = RAIL[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1;
    const t = clamp01(((x - a.x) * ex + (z - a.z) * ez) / len2);
    const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
    if (d < best.d) best = { d, sample: t < 0.5 ? a : b, i, y: a.y + (b.y - a.y) * t };
  }
  return best;
}

export interface RailStation {
  name: string;
  from: number;
  to: number;
  /** Which side the building stands: left (+1) or right (−1) of the line's direction, or none (0). */
  building: 1 | -1 | 0;
  terminus: boolean;
}

/**
 * The stations. Arcs on the line: the pier at Petrel is the terminus (the
 * west end is no longer one — it is the joint with the airport's trunk, out
 * on the west bridge); Skylark is on the north strip just past the Bridge
 * Lane crossing; the Downs halt is on the south, at the foot of the summit
 * track's hill.
 */
export const RAIL_STATIONS: readonly RailStation[] = (() => {
  const [sx, sz, half] = RAIL_STATION_SITES[0];
  const at = railNear(sx, sz).sample.arc;
  return [{ name: 'Skylark', from: at - half + 2, to: at + half - 2, building: 1, terminus: false }];
})();

/** Where the brook passes under the line. */
export const RAIL_CULVERTS: ReadonlyArray<{ s: number; x: number; z: number }> = (() => {
  const out: Array<{ s: number; x: number; z: number }> = [];
  let last = -Infinity;
  for (const sm of RAIL) {
    if (streamNear(sm.x, sm.z).d < 2 && sm.arc - last > 30) {
      out.push({ s: sm.arc, x: sm.x, z: sm.z });
      last = sm.arc;
    }
  }
  return out;
})();

/**
 * The brook goes UNDER the line, so its bed has to be under the formation —
 * and where the line crosses it the two were within a metre, the line being
 * on the valley floor there. So the bed steps down into the culvert over the
 * last dozen metres above it, a cascade, and runs on below the formation
 * until the valley's own fall takes it lower. Done to the samples after the
 * line is graded, so the formation does not chase the trench it makes.
 */
export const RAIL_CULVERT_CLEARANCE = 1.7;
for (const c of RAIL_CULVERTS) {
  let k = 0;
  let best = Infinity;
  STREAM.forEach((sm, i) => { const d = Math.hypot(sm.x - c.x, sm.z - c.z); if (d < best) { best = d; k = i; } });
  const floor = railAt(c.s).y - RAIL_CULVERT_CLEARANCE;
  const from = Math.max(0, k - 4);
  const head = STREAM[from].bed;
  for (let i = from; i < STREAM.length; i++) {
    const sm = STREAM[i] as { bed: number; arc: number };
    if (i <= k) sm.bed = Math.min(sm.bed, lerp(head, floor, smooth((i - from) / (k - from || 1))));
    else sm.bed = Math.min(sm.bed, floor - 0.004 * (sm.arc - STREAM[k].arc));
  }
}

export interface RailCrossing {
  road: string;
  /** Arc on the line, and on the road. */
  s: number;
  roadS: number;
  x: number;
  z: number;
  /** The formation; the road's surface is `RAIL_HEAD_LIFT` above it. */
  y: number;
  tx: number;
  tz: number;
}

/** Filled as the roads are built below. */
const railCrossings: RailCrossing[] = [];
export const RAIL_CROSSINGS: readonly RailCrossing[] = railCrossings;

/**
 * Half the width of a level crossing's deck across the line: the outer rail
 * of the outer track and a shoulder. A road's own surface stops this far from
 * the line and the crossing's panels take over, so the rails show through the
 * road rather than being painted over.
 */
export const RAIL_CROSSING_HALF = RAIL_GAP / 2 + TRAIN.gauge / 2 + 0.85;
/** True where a road point is on a crossing's panels. */
export const railCrossingAt = (x: number, z: number) => railNear(x, z).d < RAIL_CROSSING_HALF;

/** The road's surface height at a level crossing, from the formation. */
export const crossingRoadY = (formation: number) => formation + RAIL_HEAD_LIFT - ROAD_TOP;

/**
 * The road's height along its own length.
 *
 * The graded ground under the centreline, smoothed hard, then limited to the
 * class's grade by a pass each way, with both ends held at whatever they
 * join — a junction's pad, the bridge landing, a farmyard, another road —
 * and any stream crossing held at its bridge or ford height. The clamp only
 * ever lowers, so the pins are re-applied after it: a pinned end that was
 * lowered means the road could not make its grade, and it is better to hold
 * the junction and let the road be a shade steep than to sink the junction.
 */
function profile(samples: RoadSample[], def: RoadDef, pins: Map<number, number>) {
  const n = samples.length;
  const y = samples.map((sm) => bedrockAt(sm.x, sm.z));
  const pin = () => { for (const [i, v] of pins) y[i] = v; };
  const smoothPass = () => {
    const copy = [...y];
    for (let i = 1; i < n - 1; i++) y[i] = (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4;
    if (def.closed) y[0] = y[n - 1] = (copy[1] + 2 * copy[0] + copy[n - 2]) / 4;
    pin();
  };
  pin();
  // A light diffusion only. Seventy passes was the first figure, and it
  // spread a pinned junction's height into a coombe eighteen metres away —
  // and the pin then stood as a 14 m step over the next three metres. Eight
  // passes takes out the noise and leaves the hill.
  const passes = def.smoothing ?? 24;
  for (let pass = 0; pass < passes; pass++) smoothPass();
  // The grade: the class's own, unless the pins demand more. Two pins that
  // are 30 m apart in height and 300 m apart along the road want 10 %
  // whatever the class says, and a limit below that produces a step at one
  // of them rather than a road between them.
  let required = 0;
  const pinned = [...pins.keys()].sort((a, b) => a - b);
  for (let k = 1; k < pinned.length; k++) {
    const i0 = pinned[k - 1];
    const i1 = pinned[k];
    if (i1 === i0) continue;
    required = Math.max(required, Math.abs(y[i1] - y[i0]) / ((i1 - i0) * LANE_STEP));
  }
  const grade = Math.max(def.cls === 'lane' ? MAX_GRADE : MAX_GRADE_MINI, required * 1.04);
  const rise = grade * LANE_STEP;
  // Both ways: a road may neither climb nor fall faster than its grade, so a
  // hollow gets an embankment and a knoll gets a cutting. Walked from each
  // pinned end so the pins are honoured by construction.
  for (let i = 1; i < n; i++) {
    y[i] = Math.min(y[i - 1] + rise, Math.max(y[i - 1] - rise, y[i]));
    if (pins.has(i)) y[i] = pins.get(i)!;
  }
  for (let i = n - 2; i >= 0; i--) {
    y[i] = Math.min(y[i + 1] + rise, Math.max(y[i + 1] - rise, y[i]));
    if (pins.has(i)) y[i] = pins.get(i)!;
  }
  // Six passes, not two: on the hillier island the clamps left a profile of
  // straight grades with creases between them, and a kit lane shows every one.
  for (let pass = 0; pass < 6; pass++) smoothPass();
  if (def.bumps) {
    for (let i = 0; i < n; i++) {
      const a = samples[i].arc;
      y[i] += def.bumps * (0.6 * Math.sin(a * 0.2) + 0.4 * Math.sin(a * 0.45 + 1.2)) + def.bumps * 0.4;
    }
    if (def.closed) y[n - 1] = y[0];
  }
  samples.forEach((sm, i) => { sm.y = y[i]; });
}

const built: Road[] = [];
const crossings: Crossing[] = [];
for (const def of ROAD_DEFS) {
  const points = def.points.map(([x, z]) => [x, z] as [number, number]);
  let startTangent = def.startTangent;
  let endTangent = def.endTangent;
  let startY = def.startY;
  let endY = def.endY;
  if (def.startOn) {
    const join = resolveJoin(def.startOn, built, points[0]);
    points.unshift(join.point);
    startTangent = join.tangent;
    startY = join.y;
  }
  if (def.endOn) {
    const join = resolveJoin(def.endOn, built, points[points.length - 1]);
    points.push(join.point);
    endTangent = [-join.tangent[0], -join.tangent[1]];
    endY = join.y;
  }
  const GHOST = 40;
  const first = points[0];
  const last = points[points.length - 1];
  const fine = splineThrough(
    points,
    startTangent ? [first[0] - startTangent[0] * GHOST, first[1] - startTangent[1] * GHOST] : undefined,
    endTangent ? [last[0] + endTangent[0] * GHOST, last[1] + endTangent[1] * GHOST] : undefined,
    def.closed,
  );
  const samples: RoadSample[] = evenSamples(fine, LANE_STEP).map((sm) => ({ ...sm, y: 0 }));
  const pins = new Map<number, number>();
  // A join is held level for two samples, not one, so a lane arrives at its
  // host flat rather than creasing down onto it over its last three metres.
  if (startY !== undefined) { pins.set(0, startY); pins.set(1, startY); }
  if (endY !== undefined) { pins.set(samples.length - 1, endY); pins.set(samples.length - 2, endY); }
  // Where it meets the brook.
  let nearest = { i: -1, d: Infinity, bed: 0 };
  samples.forEach((sm, i) => {
    const near = streamNear(sm.x, sm.z);
    if (near.d < nearest.d) nearest = { i, d: near.d, bed: near.bed };
  });
  const kind: Crossing['kind'] = def.surface === 'gravel' ? 'ford' : 'bridge';
  if (nearest.d < 2.5 && nearest.i > 2 && nearest.i < samples.length - 3) {
    pins.set(nearest.i, nearest.bed + (kind === 'bridge' ? BRIDGE_RISE : FORD_RISE));
    // Hold the approaches level for a bridge, so the deck is a deck and not a hump.
    if (kind === 'bridge') {
      for (const k of [-2, -1, 1, 2]) pins.set(nearest.i + k, nearest.bed + BRIDGE_RISE);
    }
  }
  // Where it meets the railway: a level crossing, and the road takes the
  // line's height there and for a sample either side, so the deck is flat.
  // Every crossing, not the nearest: the ring road meets the line twice.
  {
    const near = samples.map((sm) => railNear(sm.x, sm.z));
    for (let i = 3; i < samples.length - 3; i++) {
      const d = near[i].d;
      if (d >= 2.2 || d > near[i - 1].d || d > near[i + 1].d) continue;
      if (railCrossings.some((c) => c.road === def.name && Math.abs(c.roadS - samples[i].arc) < 30)) continue;
      const rail = near[i].sample;
      // The rail head's own height over the whole of the crossing's panels
      // and a sample beyond — which on a skewed crossing is a good deal more
      // than a sample either side, the ring meeting the line at thirty
      // degrees — so the road follows the line's grade across the rails
      // rather than holding one height the rails leave.
      let a = i;
      let b = i;
      while (a > 1 && near[a - 1].d < RAIL_CROSSING_HALF + 1.5) a--;
      while (b < samples.length - 2 && near[b + 1].d < RAIL_CROSSING_HALF + 1.5) b++;
      for (let k = a - 1; k <= b + 1; k++) pins.set(k, crossingRoadY(near[k].y));
      const sm = samples[i];
      railCrossings.push({
        road: def.name, s: rail.arc, roadS: sm.arc, x: sm.x, z: sm.z, y: near[i].y, tx: rail.tx, tz: rail.tz,
      });
    }
  }
  profile(samples, def, pins);
  const road: Road = {
    name: def.name, label: def.label, cls: def.cls, surface: def.surface, width: widthOf(def),
    samples, length: samples[samples.length - 1].arc, closed: def.closed ?? false,
  };
  built.push(road);
  if (nearest.d < 2.5 && nearest.i > 2 && nearest.i < samples.length - 3) {
    const sm = samples[nearest.i];
    crossings.push({
      road: def.name, s: sm.arc, x: sm.x, z: sm.z, bed: nearest.bed, y: sm.y, kind, tx: sm.tx, tz: sm.tz,
    });
  }
}

export const ROADS: readonly Road[] = built;
/** The kit lanes only. */
export const LANES: readonly Road[] = built.filter((r) => r.cls === 'lane');
/** The single-track roads only. */
export const MINI_ROADS: readonly Road[] = built.filter((r) => r.cls === 'mini');
/** Where roads meet the brook: a stone bridge on the tarmac, a ford on the gravel. */
export const CROSSINGS: readonly Crossing[] = crossings;

export const roadByName = (name: string): Road => {
  const road = ROADS.find((r) => r.name === name);
  if (!road) throw new Error(`Skylark: no road called ${name}`);
  return road;
};

/** The sample of a road nearest a distance along it, and a point offset from it. */
export function alongRoad(road: Road, s: number, offset = 0): RoadSample & { px: number; pz: number } {
  const i = Math.min(road.samples.length - 1, Math.max(0, Math.round(s / LANE_STEP)));
  const sample = road.samples[i];
  return { ...sample, px: sample.x + sample.nx * offset, pz: sample.z + sample.nz * offset };
}

/** The arc along a road nearest a point. */
export const arcNear = (road: Road, x: number, z: number) => nearestSample(road, x, z).sample.arc;

/** A road's sample at any arc, interpolated between the two it lies between. */
function roadSampleAt(road: Road, s: number): RoadSample {
  const t = Math.min(road.samples.length - 1, Math.max(0, s / LANE_STEP));
  const i = Math.floor(t);
  const f = t - i;
  const a = road.samples[i];
  const b = road.samples[Math.min(road.samples.length - 1, i + 1)];
  const m = (p: number, q: number) => p + (q - p) * f;
  const tx = m(a.tx, b.tx);
  const tz = m(a.tz, b.tz);
  const len = Math.hypot(tx, tz) || 1;
  return { x: m(a.x, b.x), z: m(a.z, b.z), y: m(a.y, b.y), tx: tx / len, tz: tz / len, nx: -tz / len, nz: tx / len, arc: s };
}

/**
 * Where a road's surface gives way to a level crossing's panels: for each
 * crossing, the pair of arcs along the road where it enters and leaves the
 * band `RAIL_CROSSING_HALF` either side of the line, solved by bisection so
 * the surface is cut exactly there and not at the nearest sample — which on
 * a skewed crossing left metres of panel past the road's end, and a road end
 * that was not square to the rails.
 */
export const RAIL_CUTS: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> = (() => {
  const map = new Map<string, Array<readonly [number, number]>>();
  for (const c of railCrossings) {
    const road = roadByName(c.road);
    const clear = (s: number) => { const p = roadSampleAt(road, s); return railNear(p.x, p.z).d - RAIL_CROSSING_HALF; };
    const edge = (dir: 1 | -1) => {
      let a = c.roadS;
      let b = a;
      for (let k = 0; k < 60; k++) {
        b = a + dir * 2;
        if (b < 0 || b > road.length || clear(b) > 0) break;
        a = b;
      }
      b = Math.max(0, Math.min(road.length, b));
      for (let k = 0; k < 24; k++) { const mid = (a + b) / 2; if (clear(mid) > 0) b = mid; else a = mid; }
      return (a + b) / 2;
    };
    const list = map.get(c.road) ?? [];
    list.push([edge(-1), edge(1)]);
    map.set(c.road, list);
  }
  return map;
})();
/** True where an arc along a road is on a crossing's panels. */
export const inRailCut = (road: string, s: number) => (RAIL_CUTS.get(road) ?? []).some(([a, b]) => s > a && s < b);
/** A road's samples with one added at each cut's edge, so a surface lofted over them stops exactly at the panels. */
export function cutRoadSamples(road: Road): RoadSample[] {
  const cuts = RAIL_CUTS.get(road.name);
  if (!cuts) return road.samples;
  const out = [...road.samples];
  for (const cut of cuts) for (const s of cut) out.push(roadSampleAt(road, s));
  return out.sort((a, b) => a.arc - b.arc);
}

/* ---------------------------------------------------------- the carve */

/**
 * How far either side of a centreline the ground is held at road height,
 * and the shoulder over which it rejoins the hill.
 *
 * The flat band is wider than the carriageway so that the terrain's own
 * vertices — up to eight metres apart out on the lobe — can never rise
 * through the slab between two of them; the shoulder is a cutting or an
 * embankment, whichever way the hill is. A single-track road gets a narrower
 * band and a shorter shoulder: a lane in a cutting is a feature, a farm
 * track in one is a mistake.
 */
export const CARVE_FLAT = LANE_WIDTH / 2 + 4.5;
export const CARVE_BLEND = 36;
const CARVE_FLAT_MINI_PAD = 2.6;
const CARVE_BLEND_MINI = 22;

const CELL = 4;
const COLS = Math.ceil((BOUNDS.x1 - BOUNDS.x0) / CELL) + 1;
const ROWS = Math.ceil((BOUNDS.z1 - BOUNDS.z0) / CELL) + 1;

/** A distance field to the nearest centreline of one class, with the road's height and half-width there. */
class Carve {
  dist = new Float32Array(COLS * ROWS).fill(Infinity);
  y = new Float32Array(COLS * ROWS);
  half = new Float32Array(COLS * ROWS);
  reach: number;

  constructor(reach: number) {
    this.reach = reach;
  }

  stamp(road: Road) {
    const S = road.samples;
    const reach = this.reach;
    for (let i = 0; i < S.length - 1; i++) {
      const a = S[i];
      const b = S[i + 1];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - BOUNDS.x0) / CELL));
      const x1 = Math.min(COLS - 1, Math.ceil((Math.max(a.x, b.x) + reach - BOUNDS.x0) / CELL));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - BOUNDS.z0) / CELL));
      const z1 = Math.min(ROWS - 1, Math.ceil((Math.max(a.z, b.z) + reach - BOUNDS.z0) / CELL));
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const len2 = ex * ex + ez * ez || 1;
      for (let cz = z0; cz <= z1; cz++) {
        const pz = BOUNDS.z0 + cz * CELL;
        for (let cx = x0; cx <= x1; cx++) {
          const px = BOUNDS.x0 + cx * CELL;
          const t = clamp01(((px - a.x) * ex + (pz - a.z) * ez) / len2);
          const d = Math.hypot(px - (a.x + ex * t), pz - (a.z + ez * t));
          const k = cz * COLS + cx;
          if (d < this.dist[k]) {
            this.dist[k] = d;
            this.y[k] = a.y + (b.y - a.y) * t;
            this.half[k] = road.width / 2;
          }
        }
      }
    }
  }

  /** Bilinear distance, height and half-width at a point; distance Infinity beyond reach. */
  at(x: number, z: number): { d: number; y: number; half: number } {
    const u = (x - BOUNDS.x0) / CELL;
    const v = (z - BOUNDS.z0) / CELL;
    const cx = Math.floor(u);
    const cz = Math.floor(v);
    if (cx < 0 || cz < 0 || cx >= COLS - 1 || cz >= ROWS - 1) return { d: Infinity, y: 0, half: 0 };
    const fx = u - cx;
    const fz = v - cz;
    const k = cz * COLS + cx;
    const ks = [k, k + 1, k + COLS, k + COLS + 1];
    const ds = ks.map((i) => this.dist[i]);
    if (!Number.isFinite(ds[0] + ds[1] + ds[2] + ds[3])) {
      const nearest = Math.min(...ds);
      return { d: nearest < this.reach - CELL * 1.5 ? nearest + CELL : Infinity, y: 0, half: 0 };
    }
    const w = [(1 - fx) * (1 - fz), fx * (1 - fz), (1 - fx) * fz, fx * fz];
    let d = 0; let y = 0; let half = 0;
    for (let i = 0; i < 4; i++) { d += ds[i] * w[i]; y += this.y[ks[i]] * w[i]; half += this.half[ks[i]] * w[i]; }
    return { d, y, half };
  }
}

const MAIN = new Carve(CARVE_FLAT + CARVE_BLEND + 2);
const MINI = new Carve(MINI_WIDTH.tarmac / 2 + CARVE_FLAT_MINI_PAD + CARVE_BLEND_MINI + 2);
for (const road of built) (road.cls === 'lane' ? MAIN : MINI).stamp(road);
/** The line's own field: the widest the sides of a cutting ever reach. */
const RAIL_BLEND_MAX = 30;
const RAILWAY = new Carve(RAIL_FLAT + RAIL_BLEND_MAX + 2);
RAILWAY.stamp({
  name: 'railway', label: 'the railway', cls: 'lane', surface: 'kit', width: RAIL_FLAT * 2, closed: false,
  length: RAIL_LENGTH, samples: RAIL.map((sm) => ({ ...sm })),
});

/** Distance to the railway's formation edge, negative on it, Infinity far away. */
export function railEdgeAt(x: number, z: number): number {
  return RAILWAY.at(x, z).d - RAIL_FLAT;
}

/**
 * The carriageway's own level at a point on a road, before `ROAD_TOP`, or
 * null off every road. The ground under a road is this everywhere except at a
 * level crossing, where the formation wins the carve and the road runs a
 * metre over it on the crossing's deck — so the nav reads the road, not the
 * ground.
 */
export function roadLevelAt(x: number, z: number): number | null {
  const m = MAIN.at(x, z);
  const n = MINI.at(x, z);
  const eM = m.d - LANE_WIDTH / 2;
  const eN = n.d - (n.half || MINI_WIDTH.tarmac / 2);
  if (eM > 0 && eN > 0) return null;
  return eM <= eN ? m.y : n.y;
}

/** Distance to the nearest carriageway EDGE of any road, negative on the road, Infinity far away. */
export function roadEdgeAt(x: number, z: number): number {
  const m = MAIN.at(x, z);
  const n = MINI.at(x, z);
  return Math.min(m.d - (m.half || LANE_WIDTH / 2), n.d - (n.half || MINI_WIDTH.tarmac / 2));
}

/** Distance to the nearest kit lane's centreline — the wide roads only. */
export const roadDistanceAt = (x: number, z: number) => MAIN.at(x, z).d;

/** Distance to the brook's line, or Infinity beyond the coombe. */
export function streamDistanceAt(x: number, z: number): number {
  const near = streamNear(x, z);
  return near.d;
}

/**
 * The ground, finished: relief, pads, beach, lake, the coombe, the roads
 * cut into it, and the brook's channel cut through the lot.
 *
 * In the island's frame. This is what the terrain mesh is built from, what
 * the collider is, what the nav raster samples and what everything standing
 * on the island is placed at.
 */
/**
 * How steep the bare terrain is at a point, and which way it falls.
 *
 * `grade` is a rise over a run and `fall` the compass of steepest ASCENT in
 * the XZ plane. Measured off `reliefAt` rather than `groundAt`, because what
 * a farmer reads is the hillside, not the cutting a lane has taken out of it.
 * The 12 m arm is deliberate: a field is worked at that scale, and a finer
 * one just picks up the noise octaves.
 */
export function slopeAt(x: number, z: number): { grade: number; fall: number } {
  const d = 12;
  const gx = (reliefAt(x + d, z) - reliefAt(x - d, z)) / (2 * d);
  const gz = (reliefAt(x, z + d) - reliefAt(x, z - d)) / (2 * d);
  return { grade: Math.hypot(gx, gz), fall: Math.atan2(gz, gx) };
}

/* ---------------------------------------------------------- the mine */

/**
 * Skylark Quarry: a hillside working and its works.
 *
 * The excavation is cut into the north-facing hill above the works and
 * OPENS SOUTH onto one level terrace, the way a hillside quarry does: the
 * floor and the works are one piece of ground, the faces stand round three
 * sides of it, and everything won at the face comes out along the level to
 * the crusher without a ramp. The terrace runs west to the island railway,
 * which is in a cutting there, and a siding comes off the main line onto it
 * to a rail load-out — stone leaves by train as well as by lorry.
 *
 * The ground here is a set of operations on the natural relief, in order:
 * the terrace levelled (cut and fill); the benched horseshoe of the pit, a
 * minimum against what is left; the overburden tip piled on the result; the
 * bench road climbing the east face along a corridor; the lagoon dished
 * into the terrace; and the adit's approach cutting through the back face.
 * Doing it as terrain rather than as models is what makes a truck drive into
 * the pit and a player walk up onto a bench.
 */
export const MINE = {
  label: 'Skylark Quarry',
  /**
   * The pit floor — and the works terrace it opens onto is the same level:
   * one piece of ground. 7.2 m is where the island railway, climbing north
   * through its cutting past the works at 2.5 %, is at the terrace's own
   * height, which is what lets a siding come off it onto the terrace level.
   */
  floorY: 7.2,
  /**
   * The horseshoe: floor radius, rim radius, and the benches between. Each
   * bench is seven tenths flat and three tenths riser. The rim stays 21 m
   * clear of the lane that passes the hill on the east.
   */
  pit: { x: -380, z: 118, floor: 22, rim: 52, benches: 3, benchHeight: 8 },
  /**
   * The bench road: a corridor up the east face from the floor onto the
   * first bench, graded end to end. Set out along the wall as a real bench
   * road is, so the excavator and the drill rig can reach the top of the
   * face without a straight cut through every bench.
   */
  bench: {
    half: 5, feather: 4,
    path: [[-365, 99], [-356, 105], [-350.5, 112], [-347, 121], [-346.5, 132], [-350.5, 143], [-359.5, 150]],
  },
  /**
   * The works terrace: hard standing from the railway cutting to the site
   * gate, and north into the pit's mouth. Cut AND fill — a level, not a
   * minimum — because the natural ground runs out below it along the south
   * side and a works stands on made ground there, not on a slope.
   */
  terrace: { x: -384, z: 25, w: 132, d: 150, y: 7.2, blend: 18 },
  /** Overburden, tipped in the terrace's north-west corner outside the rail loop, against the west face. */
  spoil: { x: -440, z: 98, r: 18, height: 9 },
  /** The settlement lagoon in the works' south-east corner, outside the rail loop, wash water off the screens. */
  lagoon: { x: -330, z: -38, r: 5, depth: 1.5 },
  /** The adit into the back face, and where the old tramway comes from. `z` is the portal's face. */
  adit: { x: -380, z: 149.5, half: 4.4, feather: 2.6, run: 22, bore: 36, mouth: 2.2 },
  /** The site gate, on the works' east side where the quarry road arrives. */
  gate: { x: -320, z: -6 },
} as const;

/** Distance to a polyline and how far along it, as a fraction, for the bench road. */
function alongPath(path: ReadonlyArray<readonly [number, number]>, x: number, z: number): { d: number; t: number } {
  let best = { d: Infinity, t: 0 };
  let arc = 0;
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1];
    const [bx, bz] = path[i];
    const ex = bx - ax;
    const ez = bz - az;
    const len = Math.hypot(ex, ez) || 1;
    const u = clamp01(((x - ax) * ex + (z - az) * ez) / (len * len));
    const d = Math.hypot(x - (ax + ex * u), z - (az + ez * u));
    if (d < best.d) best = { d, t: (arc + u * len) / total };
    arc += len;
  }
  return best;
}

/**
 * The quarry's own ground, applied to the natural relief in the order the
 * comment on `MINE` gives.
 *
 * The pit is a MINIMUM against the ground: where the hill stands above the
 * bench profile it is cut, and where the ground is already lower — the
 * whole terrace — nothing happens. That one rule is what opens the horseshoe
 * onto the works without a hole being punched through a wall for the road,
 * and it is why the terrace and the floor meet as one level and not a step.
 */
function mineAt(x: number, z: number, base: number): number {
  let h = base;
  const P = MINE.pit;
  const T = MINE.terrace;
  const S = MINE.spoil;
  // The terrace: level inside, blended out to the ground round it.
  const tu = Math.abs(x - T.x) - T.w / 2;
  const tv = Math.abs(z - T.z) - T.d / 2;
  const td = Math.max(tu, tv);
  if (td < T.blend) h = td <= 0 ? T.y : lerp(T.y, h, smooth(td / T.blend));
  // The goods loop's band: the terrace's west strip, up to 14 m east of the
  // main line's east road, comes down to the line's own grade so the loop
  // — which is laid as an offset from that road and must meet it at both
  // switches — is on ground and not in fill. The line runs due north here at
  // x = -462 climbing 2.5 %, which this is, to within the carve's tolerance;
  // the carve then cuts the exact formation under the rails themselves.
  {
    const lateral = x + 459.7;
    if (z > -95 && z < 100 && lateral > 0 && lateral < 18) {
      const fy = 5.84 + 0.025 * (z + 21);
      const w = lateral < 14 ? 1 : smooth(1 - (lateral - 14) / 4);
      h = lerp(h, Math.min(h, fy), w);
    }
  }
  // The horseshoe.
  const d = Math.hypot(x - P.x, z - P.z);
  if (d < P.rim) {
    let y: number;
    if (d <= P.floor) y = MINE.floorY;
    else {
      const step = (P.rim - P.floor) / P.benches;
      const t = (d - P.floor) / step;
      const k = Math.floor(t);
      const f = t - k;
      const lo = MINE.floorY + k * P.benchHeight;
      y = f < 0.7 ? lo : lo + P.benchHeight * smooth((f - 0.7) / 0.3);
    }
    // The bench road, graded floor to first bench along its corridor.
    const B = MINE.bench;
    const along = alongPath(B.path, x, z);
    if (along.d < B.half + B.feather) {
      const roadY = lerp(MINE.floorY, MINE.floorY + P.benchHeight, along.t);
      const w = smooth(clamp01((B.half + B.feather - along.d) / B.feather));
      y = lerp(y, Math.min(y, roadY), w);
    }
    h = Math.min(h, y);
  }
  // The tip: waste piled ON the terrace after it was cut. It has to come
  // after the two minimums or they take it straight back off again, and it
  // stands clear of the pit so the excavation cannot cut it either.
  const ds = Math.hypot(x - S.x, z - S.z);
  if (ds < S.r) h += S.height * smooth(Math.min(1, (1 - ds / S.r) * 1.9));
  // The lagoon, dished into the terrace with a soft lip.
  const L = MINE.lagoon;
  const dl = Math.hypot(x - L.x, z - L.z);
  if (dl < L.r + 4) {
    const bowl = dl <= L.r ? T.y - L.depth * (1 - (dl / L.r) ** 2) : lerp(T.y - 0.05, h, smooth((dl - L.r) / 4));
    h = Math.min(h, bowl);
  }
  // The adit's approach cutting: a slot at floor level through the back
  // face up to the portal, feathered so the rock closes in on it.
  const A = MINE.adit;
  const au = Math.abs(x - A.x);
  if (z > A.z - A.run && z < A.z && au < A.half + A.feather) {
    const w = smooth(clamp01((A.half + A.feather - au) / A.feather));
    h = lerp(h, Math.min(h, MINE.floorY), w);
  }
  // And the mouth itself: the bore's own width, cut on past the portal's face
  // so the rock face is not standing in the archway. A heightfield cannot have
  // a hole in it, so the tunnel is a mouth two metres deep with the dark of
  // the bore drawn across the back of it.
  if (z >= A.z && z < A.z + A.mouth && au < 2.6 + 0.6) {
    const w = smooth(clamp01((3.2 - au) / 0.6));
    h = lerp(h, Math.min(h, MINE.floorY), w);
  }
  return h;
}

/** True within `pad` of the quarry: nothing grows, grazes or is built here. */
export const inMine = (x: number, z: number, pad = 0) => (
  Math.hypot(x - MINE.pit.x, z - MINE.pit.z) < MINE.pit.rim + pad
  || Math.hypot(x - MINE.spoil.x, z - MINE.spoil.z) < MINE.spoil.r + pad
  || (Math.abs(x - MINE.terrace.x) < MINE.terrace.w / 2 + pad
    && Math.abs(z - MINE.terrace.z) < MINE.terrace.d / 2 + pad)
);

export function groundAt(x: number, z: number): number {
  let h = mineAt(x, z, paddedAt(x, z));
  const brook = streamNear(x, z);
  if (brook.d < VALLEY_REACH) h = Math.min(h, brook.bed + VALLEY_SIDE * brook.d + 0.9);
  const m = MAIN.at(x, z);
  const n = MINI.at(x, z);
  const eM = m.d - CARVE_FLAT;
  const eN = n.d - (n.half + CARVE_FLAT_MINI_PAD);
  if (eM < CARVE_BLEND || eN < CARVE_BLEND_MINI) {
    // Whichever road's flat band this point is nearer, measured from the band's edge.
    // Inside a lane's own flat band the lane always wins: a single-track
    // arriving at it must not carve its own grade into the lane's ground.
    const useMain = eM <= 0 || eM / CARVE_BLEND <= eN / CARVE_BLEND_MINI;
    const excess = useMain ? eM : eN;
    const blend = useMain ? CARVE_BLEND : CARVE_BLEND_MINI;
    // The ground under a carriageway sits a few centimetres BELOW the road's
    // own level, not at it: the road loft and the crown are two piecewise
    // linear reads of the same profile at different sample points, and where
    // the ground curves the crown came up through the tarmac between them.
    const ry = (useMain ? m.y : n.y) - 0.12;
    h = excess <= 0 ? ry : lerp(ry, h, smooth(excess / blend));
  }
  // The railway: the formation held flat, and sides as steep as the cut is
  // deep — a metre of bank rolls out over six metres, a ten-metre cutting
  // stands at nearly one-to-one. Last of the built things, so at a level
  // crossing the formation wins under the deck and the road's own carve
  // ends where the rails begin.
  const rail = RAILWAY.at(x, z);
  if (rail.d < RAIL_FLAT + RAIL_BLEND_MAX) {
    const before = h;
    const depth = Math.abs(h - rail.y);
    const blend = Math.min(RAIL_BLEND_MAX, Math.max(6, depth * 1.4));
    const excess = rail.d - RAIL_FLAT;
    if (excess <= 0) h = rail.y;
    else if (excess < blend) h = lerp(rail.y, h, smooth(excess / blend));
    // A level crossing: the road meets the rails at grade, so beside the
    // road the ground comes up to the road's level — which is the rail
    // head's — and only the ballast shows, instead of the road crossing a
    // metre-deep trench on a plinth. `before` is the road's own carve, which
    // is pinned to the rail head here; the lift fades out over fourteen metres
    // from the road's edge, and in from the ballast's toe so the shoulders
    // stay clear.
    const edge = Math.min(m.d - (m.half || LANE_WIDTH / 2), n.d - (n.half || MINI_WIDTH.tarmac / 2));
    if (edge < 15.5 && rail.d > 5.0) {
      const lift = smooth(clamp01((1.5 - edge) / 14 + 1)) * smooth(clamp01((rail.d - 5.0) / 2.5));
      h = lerp(h, before, lift);
    }
  }
  // The channel widens to a river mouth over its last hundred metres.
  const mouth = 1 + 1.6 * smooth(clamp01((brook.i / STREAM.length - 0.62) / 0.38));
  if (brook.d < CHANNEL_HALF * mouth && rail.d > RAIL_FLAT) {
    // The channel, except through a ford, where the road IS the bed, and
    // except under the railway, where it is a culvert: the water goes through
    // a pipe and the formation runs over it unbroken.
    const ford = CROSSINGS.some((c) => c.kind === 'ford' && Math.hypot(c.x - x, c.z - z) < 7);
    if (!ford) h = Math.min(h, brook.bed - CHANNEL_DEPTH * (1 - (brook.d / (CHANNEL_HALF * mouth)) ** 2));
  }
  return h;
}

/** The same, asked in world metres. */
export const groundWorld = (x: number, z: number) => groundAt(x - SITE.centre[0], z - SITE.centre[1]);

/* ----------------------------------------------------------- the bridge */

/**
 * The crossing from Halcyon Field.
 *
 * `s` is metres from the airport T's west edge along `BRIDGE_DIR`. The deck's
 * top follows the chord between the two ends — the airport crown plus the
 * kit's slab at one, the landing at the other — with a hump over the water so
 * the span reads as a bridge and not a road laid on the sea. The hump is a
 * `sin²` window rather than a parabola so it starts and ends with no slope:
 * a car meets no crease at either shore.
 */
export interface RoadBridge {
  label: string;
  start: [number, number];
  end: [number, number];
  dir: [number, number];
  /** Where the deck leaves the near shore's ground and where it reaches the far one's. */
  airportShoreS: number;
  landfallS: number;
  /** Where the deck stops and the road begins again. */
  endS: number;
  airportTop: number;
  landingTop: number;
  hump: number;
  halfWidth: number;
  deck: number;
  edgeWidth: number;
  edgeHeight: number;
  capOver: number;
  capHeight: number;
  girder: { offset: number; width: number; depth: number };
  pierEvery: number;
  pier: { half: number; spread: number; capHalf: number; capDepth: number };
  step: number;
  colours: { deck: string; steel: string; pier: string };
  topAt(s: number): number;
  pointAt(s: number): [number, number];
  seabed: number;
  seaLevel: number;
  /** Where the piers stand: over the water only, clear of both shores. */
  piers: readonly number[];
}

/**
 * A concrete beam bridge for a kit lane: the shape both of Skylark's road
 * crossings share. The deck's top follows the chord between the two ends
 * with a `sin²` hump over the water, so it starts and ends with no slope.
 */
function roadBridge(o: {
  label: string; start: [number, number]; dir: [number, number];
  shoreS: number; landfallS: number; endS: number; startTop: number; endTop: number; hump: number;
  /** A level crossing on the deck: raised to `top` over `s ± flat`, ramped over `ramp` either side. */
  crossing?: { s: number; flat: number; ramp: number; top: number };
}): RoadBridge {
  const pointAt = (s: number): [number, number] => [o.start[0] + o.dir[0] * s, o.start[1] + o.dir[1] * s];
  // Level over each shore's overlap — the deck there stands on a pad held
  // at its own height, and a chord that started falling from the first
  // metre put the pad above the deck — and the chord plus the hump between.
  const baseAt = (s: number) => {
    const u = (s - o.shoreS) / (o.landfallS - o.shoreS);
    if (u <= 0) return o.startTop;
    if (u >= 1) return o.endTop;
    const w = Math.sin(Math.PI * u);
    return lerp(o.startTop, o.endTop, u) + o.hump * w * w;
  };
  const topAt = (s: number) => {
    const base = baseAt(s);
    const x = o.crossing;
    if (!x) return base;
    const d = Math.abs(s - x.s) - x.flat;
    if (d >= x.ramp) return base;
    const t = d <= 0 ? 1 : 1 - d / x.ramp;
    return Math.max(base, base + (x.top - base) * (t * t * (3 - 2 * t)));
  };
  const pierEvery = 46;
  const piers: number[] = [];
  const from = o.shoreS + 30;
  const to = o.landfallS - 24;
  const count = Math.max(1, Math.round((to - from) / pierEvery));
  for (let i = 0; i <= count; i++) piers.push(from + ((to - from) * i) / count);
  return {
    label: o.label,
    start: o.start,
    end: pointAt(o.endS),
    dir: o.dir,
    airportShoreS: o.shoreS,
    landfallS: o.landfallS,
    endS: o.endS,
    airportTop: o.startTop,
    landingTop: o.endTop,
    hump: o.hump,
    halfWidth: LANE_WIDTH / 2,
    deck: 1.1,
    edgeWidth: 0.42,
    edgeHeight: 1.05,
    capOver: 0.06,
    capHeight: 0.12,
    girder: { offset: 4.2, width: 2.2, depth: 2.4 },
    pierEvery,
    pier: { half: 1.35, spread: 4.2, capHalf: 7.4, capDepth: 1.6 },
    step: 4,
    colours: { deck: '#8f9399', steel: '#58636c', pier: '#9b9791' },
    topAt,
    pointAt,
    seabed: TRAIN.seabed,
    seaLevel: TRAIN.seaLevel,
    piers,
  };
}

/**
 * Where the airport's trunk crosses the Skylark road, measured on the deck.
 *
 * The trunk comes down the island north of the road and crosses it at the
 * tip on the way to the Skylark line, over the stretch of deck that is still
 * level on the airfield (`s` under `AIRPORT_SHORE_S`). The deck comes UP to the
 * rail rather than the rail going down to it — the same arrangement as every
 * crossing on the airfield: the tarmac level with the rail head, 2 cm under it
 * so the rails stand proud, across the whole band where any rail is on the carriageway,
 * and eased back to the deck's own height over `ramp` — 14 m, a 10% peak on
 * the ease, and it still fits between the junction's edge and the shore.
 *
 * The band is skewed: at an angle `a` to the road, the pair's rails cross the
 * carriageway's full width over `2 · half / tan a` of `s`, and each rail
 * adds its own `(gap/2 + 1.6) / sin a` either side. Pinning less than that is
 * the step a skewed crossing makes at one kerb.
 */
export const TRUNK_ROAD_CROSSING = (() => {
  const trunk = trunkCentre().map((q) => airportWorld(q.x, q.z));
  const n: [number, number] = [-BRIDGE_DIR[1], BRIDGE_DIR[0]];
  const lat = (p: [number, number]) => (p[0] - BRIDGE_START_WORLD[0]) * n[0] + (p[1] - BRIDGE_START_WORLD[1]) * n[1];
  const along = (p: [number, number]) => (p[0] - BRIDGE_START_WORLD[0]) * BRIDGE_DIR[0] + (p[1] - BRIDGE_START_WORLD[1]) * BRIDGE_DIR[1];
  for (let i = 1; i < trunk.length; i++) {
    const a = trunk[i - 1], b = trunk[i];
    const la = lat(a), lb = lat(b);
    if (Math.sign(la) === Math.sign(lb) || along(a) < 0 || along(a) > AIRPORT_SHORE_S) continue;
    const t = la / (la - lb);
    const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const cos = Math.abs(((b[0] - a[0]) * BRIDGE_DIR[0] + (b[1] - a[1]) * BRIDGE_DIR[1]) / len);
    const angle = Math.acos(Math.min(1, cos));
    const flat = HALF / Math.tan(angle) + (TRACK_GAP / 2 + 1.6) / Math.sin(angle) + 1;
    // `topAt` is the deck's structural top; `CountryBridge` lays its tarmac
    // 6 cm over it, so the visible road is set 2 cm under the rail head by
    // putting the deck 8 cm under. At 2 cm under, the tarmac stood 4 cm OVER
    // the rails and buried the crossing.
    return { s: along(p), angle, flat, ramp: 14, top: AIRPORT_SITE.ground + RAIL_HEAD_LIFT - 0.08 };
  }
  throw new Error('Skylark: the trunk never crosses the Skylark road on the airfield');
})();

/** The crossing from Halcyon Field: `s` is metres from the airport T's west edge along `BRIDGE_DIR`. */
export const BRIDGE: RoadBridge = roadBridge({
  label: 'Skylark',
  start: [BRIDGE_START_WORLD[0], BRIDGE_START_WORLD[1]],
  dir: [BRIDGE_DIR[0], BRIDGE_DIR[1]],
  shoreS: AIRPORT_SHORE_S,
  landfallS: LANDFALL_S,
  endS: DECK_END_S,
  startTop: AIRPORT_SITE.ground + ROAD_TOP,
  endTop: LANDING_Y + ROAD_TOP,
  hump: 6.5,
  crossing: TRUNK_ROAD_CROSSING,
});

/**
 * The crossing to Petrel, beside the railway's: from the Petrel road's end on
 * the island's east coast to the circuit's shore road. Its `s` runs from the
 * deck's start on the island; the near shore is the deck overlap in, the far
 * one where Petrel's beach begins.
 */
export const PETREL_BRIDGE: RoadBridge = roadBridge({
  label: 'Petrel',
  start: toWorld(PETREL_DECK_START[0], PETREL_DECK_START[1]),
  dir: PETREL_DIR,
  shoreS: PETREL_DECK_OVERLAP,
  landfallS: (PETREL_LAND_X - PETREL_DECK_START[0]) / PETREL_DIR[0],
  endS: (PETREL_ROAD_X - PETREL_DECK_START[0]) / PETREL_DIR[0],
  startTop: PETREL_LANDING_Y + ROAD_TOP,
  endTop: PETREL_ROAD_Y + ROAD_TOP,
  hump: 4.5,
});

export const ROAD_BRIDGES: readonly RoadBridge[] = [BRIDGE, PETREL_BRIDGE];
/** Where the Skylark bridge's piers stand. */
export const PIERS: readonly number[] = BRIDGE.piers;

/* ------------------------------------------------------------- the spawn */

/**
 * A place to start a drive here: on Bridge Lane just past the landing, facing
 * into the island.
 *
 * The heading is a yaw about +Y, and the car's nose is at local −Z, so its
 * forward is (−sin h, −cos h) and the yaw that drives along a direction is
 * `atan2(−dx, −dz)` — the convention `cityNav.roadHeadingAt` spells out.
 * `atan2(dx, dz)` is the other way round, and put the first car here facing
 * back up the deck.
 */
export const COUNTRY_SPAWN = (() => {
  const [x, z] = bridgePoint(DECK_END_S + 38);
  const [wx, wz] = toWorld(x, z);
  return {
    position: [wx, LANDING_Y + 0.6, wz] as [number, number, number],
    heading: Math.atan2(-BRIDGE_DIR[0], -BRIDGE_DIR[1]),
  };
})();

/* ---------------------------------------------------------- summary */

/** What the console says the island came out as. */
export function describeCountry(): string {
  const grades = ROADS.map((r) => {
    let g = 0;
    for (let i = 1; i < r.samples.length; i++) {
      g = Math.max(g, Math.abs(r.samples[i].y - r.samples[i - 1].y) / LANE_STEP);
    }
    return `${r.label} ${Math.round(r.length)} m, ${(g * 100).toFixed(1)}%`;
  });
  const lanes = LANES.reduce((n, r) => n + r.length, 0);
  const minis = MINI_ROADS.reduce((n, r) => n + r.length, 0);
  let top = -Infinity;
  for (let i = 0; i < OUTLINE.length; i += 8) {
    for (const f of [0.2, 0.4, 0.6, 0.8, 0.95]) {
      top = Math.max(top, groundAt(OUTLINE[i][0] * f, OUTLINE[i][1] * f));
    }
  }
  let railGrade = 0;
  for (let i = 1; i < RAIL.length; i++) railGrade = Math.max(railGrade, Math.abs(RAIL[i].y - RAIL[i - 1].y) / RAIL_STEP);
  let deepest = 0;
  for (const sm of RAIL) deepest = Math.max(deepest, sm.ground - sm.y);
  return `Skylark: ${(Math.abs(outlineShoelace()) / 2 / 1e6).toFixed(2)} km², railway ${Math.round(RAIL_LENGTH)} m, tightest curve ${Math.round(RAIL_TIGHTEST)} m, `
    + `at ${(railGrade * 100).toFixed(1)}% with ${RAIL_CROSSINGS.length} level crossings, ${RAIL_CULVERTS.length} culverts, `
    + `deepest cutting ${deepest.toFixed(1)} m; `
    + `summit ${top.toFixed(0)} m, lake at ${LAKE_Y.toFixed(1)} m; `
    + `bridge ${Math.round(DECK_END_S)} m (landfall at ${Math.round(LANDFALL_S)}, `
    + `${PIERS.length} piers); ${(lanes / 1000).toFixed(1)} km of lane and ${(minis / 1000).toFixed(1)} km `
    + `of single-track, brook ${Math.round(STREAM[STREAM.length - 1].arc)} m with ${CROSSINGS.length} `
    + `crossings; ${grades.join('; ')}`;
}

/* ----------------------------------------------------------- the hamlet */

export interface Cottage {
  x: number;
  z: number;
  /** Radians about +Y; the front is local +Z, and it faces the lane. */
  turn: number;
  w: number;
  d: number;
  storeys: 1 | 2;
  style: 'stone' | 'white' | 'brick' | 'cream';
  roof: 'thatch' | 'tile' | 'slate';
  label: string;
}

/**
 * The hamlet's houses, placed along the lanes rather than at coordinates:
 * a distance along a lane, a side (+1 is the left of travel) and a setback
 * from the centreline, and the house turns to face the lane it stands on.
 */
export const COTTAGES: readonly Cottage[] = (() => {
  const spec = [
    { road: 'laneEnd', s: 172, side: -1, off: 23, w: 9, d: 6.5, storeys: 1, style: 'white', roof: 'thatch', label: 'Rose Cottage' },
    { road: 'laneEnd', s: 191, side: 1, off: 24, w: 10, d: 7, storeys: 2, style: 'stone', roof: 'slate', label: 'Lane End House' },
    { road: 'laneEnd', s: 208, side: -1, off: 23, w: 8.5, d: 6, storeys: 1, style: 'cream', roof: 'thatch', label: 'Apple Tree Cottage' },
    { road: 'laneEnd', s: 224, side: 1, off: 24, w: 9, d: 6.5, storeys: 2, style: 'brick', roof: 'tile', label: 'The Forge' },
    { road: 'churchLane', s: 30, side: -1, off: 23, w: 9, d: 6.5, storeys: 1, style: 'white', roof: 'thatch', label: 'Glebe Cottage' },
    { road: 'churchLane', s: 48, side: 1, off: 23, w: 10, d: 7, storeys: 2, style: 'brick', roof: 'tile', label: 'The Old Post Office' },
    { road: 'churchLane', s: 66, side: -1, off: 23, w: 8, d: 6, storeys: 1, style: 'stone', roof: 'tile', label: 'Church Cottage' },
    { road: 'churchLane', s: 86, side: -1, off: 24, w: 9.5, d: 6.5, storeys: 2, style: 'cream', roof: 'slate', label: 'The Old Rectory' },
    { road: 'churchLane', s: 112, side: -1, off: 24, w: 13, d: 7, storeys: 1, style: 'brick', roof: 'slate', label: 'the village hall' },
    { road: 'ringEast', s: 60, side: 1, off: 23, w: 9, d: 6.5, storeys: 1, style: 'white', roof: 'thatch', label: 'Meadow Cottage' },
    { road: 'ringEast', s: 82, side: 1, off: 24, w: 10, d: 7, storeys: 2, style: 'stone', roof: 'slate', label: 'Downs View' },
    { road: 'ringEast', s: 106, side: 1, off: 23, w: 8.5, d: 6, storeys: 1, style: 'cream', roof: 'tile', label: 'Lake Cottage' },
    // The harbour: a terrace along the quay front, on its landward side.
    { road: 'quayLane', s: -100, side: 'land', off: 22, w: 8, d: 6, storeys: 2, style: 'white', roof: 'slate', label: 'Quay House' },
    { road: 'quayLane', s: -88, side: 'land', off: 22, w: 8, d: 6, storeys: 2, style: 'cream', roof: 'slate', label: 'Harbour Cottage' },
    { road: 'quayLane', s: -76, side: 'land', off: 22, w: 8, d: 6, storeys: 2, style: 'stone', roof: 'slate', label: 'Net Loft' },
    { road: 'quayLane', s: -48, side: 'land', off: 22, w: 8, d: 6, storeys: 1, style: 'white', roof: 'tile', label: 'Pilot Cottage' },
    { road: 'quayLane', s: -36, side: 'land', off: 22, w: 8, d: 6, storeys: 1, style: 'cream', roof: 'tile', label: 'Cove Cottage' },
  ] as const;
  return spec.map((c) => {
    const road = roadByName(c.road);
    const s = c.s < 0 ? road.length + c.s : c.s;
    // `land` is whichever side is further from the sea — the quay front has
    // the harbour on one side and the village on the other.
    let side: 1 | -1 = c.side === 'land' ? 1 : c.side;
    if (c.side === 'land') {
      const left = alongRoad(road, s, c.off);
      const right = alongRoad(road, s, -c.off);
      side = coastClearance(left.px, left.pz) >= coastClearance(right.px, right.pz) ? 1 : -1;
    }
    const at = alongRoad(road, s, c.off * side);
    // The front is local +Z, which a turn of φ sends to (sin φ, cos φ); it has
    // to point back at the lane, which from this side is −side × the normal.
    const fx = -side * at.nx;
    const fz = -side * at.nz;
    return {
      x: at.px, z: at.pz, turn: Math.atan2(fx, fz),
      w: c.w, d: c.d, storeys: c.storeys, style: c.style, roof: c.roof, label: c.label,
    };
  });
})();

/** The pub, on the corner of the green: placed the same way. */
export const INN = (() => {
  const at = alongRoad(roadByName('ringEast'), 32, 21);
  return { x: at.px, z: at.pz, turn: Math.atan2(-at.nx, -at.nz), w: 15, d: 9, label: 'The Skylark' };
})();

/** The harbour's pub, at the landward end of the quay front. */
export const ANCHOR = (() => {
  const road = roadByName('quayLane');
  const s = road.length - 62;
  const left = alongRoad(road, s, 19);
  const right = alongRoad(road, s, -19);
  const side = coastClearance(left.px, left.pz) >= coastClearance(right.px, right.pz) ? 1 : -1;
  const at = alongRoad(road, s, 19 * side);
  return { x: at.px, z: at.pz, turn: Math.atan2(-side * at.nx, -side * at.nz), w: 14, d: 8, label: 'The Anchor' };
})();

/* ------------------------------------------------------- parked vehicles */

export interface Parked {
  /** A part of the country kit: see `prepare-country.mjs`. */
  part: 'tractor' | 'harvester' | 'pickup' | 'boxLorry' | 'artic' | 'lorryCab';
  x: number;
  z: number;
  /** Radians about +Y. Every vehicle is baked facing −Z, so this is its heading. */
  turn: number;
  label: string;
}

/**
 * Where the island's working vehicles stand.
 *
 * Parked, not driven: they are scenery the player walks and drives past, so
 * each one is a position, a heading and nothing else. Two kinds of spot —
 * a yard, given as an offset in a place's own frame, and a verge, given as a
 * distance along a lane and a side of it, which puts the vehicle on ground
 * the lane's own carve has already graded flat and turns it to the lane.
 *
 * They are spread deliberately rather than scattered at random: farm machines
 * at the farms and in the fields they work, a pickup at each of the three car
 * parks, and the lorries where a lorry can actually get to — the quay, the
 * Petrel road, and the yard behind Hill Farm.
 */
/**
 * Where the island's working vehicles stand.
 *
 * Parked, not driven: they are scenery the player walks and drives past, so
 * each one is a position, a heading and nothing else. The two that DO move
 * are the tractor and the combine working their fields — see `WORK_LOOPS` in
 * `countryFields`.
 *
 * The spot is SEARCHED, not written down. Every entry names an anchor — a
 * yard, a car park, a verge — and `flatSpot` then walks a spiral out from it
 * for the nearest stance where all four corners of that vehicle's own
 * footprint sit within a few centimetres of each other and nothing is in the
 * way. Hand-picked offsets were what put a lorry across a slope and a pickup
 * half in a hedge; a vehicle's footprint is 4 m by 16 m at the extreme and
 * the ground under it has to be judged at that size, not at a point.
 */
export const PARKED: readonly Parked[] = (() => {
  const size = (part: Parked['part']): [number, number] => {
    const s = (countryModels.parts as Record<string, { size: number[] }>)[part]?.size ?? [2, 2, 4];
    return [s[0], s[2]];
  };
  /** How level the ground is under a footprint of `w` by `d` at this stance. */
  const tilt = (x: number, z: number, turn: number, w: number, d: number) => {
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [u, v] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [0, 0]]) {
      const y = groundAt(x + u * c + v * sn, z - u * sn + v * c);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    return hi - lo;
  };
  /**
   * The nearest stance to the anchor that a vehicle of this size can stand on.
   *
   * A spiral of rings out to `reach`, taking the first stance that is level
   * enough and clear, and falling back to the flattest seen if none is. The
   * heading is the anchor's, give or take: at each ring the vehicle is also
   * tried turned a little, because a long vehicle across a contour tilts and
   * the same vehicle along it does not.
   */
  const flatSpot = (
    part: Parked['part'], ax: number, az: number, turn: number, label: string, reach = 34,
  ): Parked => {
    const [w, d] = size(part);
    const span = Math.max(w, d);
    const clear = (x: number, z: number) => (
      roadEdgeAt(x, z) > span / 2 + 2.5 && railEdgeAt(x, z) > span / 2 + 3
      && inIsland(x, z, span) && coastClearance(x, z) > span
      && lakeFraction(x, z) > 1.2 && streamDistanceAt(x, z) > span / 2 + 2
    );
    let best: Parked | null = null;
    let bestTilt = Infinity;
    for (let r = 0; r <= reach; r += 3) {
      const steps = r === 0 ? 1 : Math.max(8, Math.round((TAU * r) / 4));
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * TAU;
        const x = ax + r * Math.cos(t);
        const z = az + r * Math.sin(t);
        if (!clear(x, z)) continue;
        for (const swing of [0, 0.5, -0.5, 1.1, -1.1, Math.PI / 2, -Math.PI / 2]) {
          const ti = tilt(x, z, turn + swing, w, d);
          if (ti < bestTilt) {
            bestTilt = ti;
            best = { part, x, z, turn: turn + swing, label };
          }
          if (ti < 0.18) return best!;
        }
      }
    }
    if (!best) throw new Error(`Skylark: nowhere to park the ${label}`);
    return best;
  };

  /** A point in a place's own frame: `u` along its turn, `v` across it. */
  const yard = (place: { x: number; z: number; turn?: number }, u: number, v: number) => {
    const base = place.turn ?? 0;
    const c = Math.cos(base);
    const sn = Math.sin(base);
    return { x: place.x + u * c + v * sn, z: place.z - u * sn + v * c, turn: base };
  };
  /** Beside a lane: `s` along it, `side` 1 left, `off` metres from the centreline. */
  const verge = (name: string, s: number, side: 1 | -1, off: number) => {
    const road = roadByName(name);
    const at = alongRoad(road, s < 0 ? road.length + s : s, off * side);
    return { x: at.px, z: at.pz, turn: Math.atan2(-at.tx, -at.tz) };
  };
  /** On the harbour's apron: `along` the front, `out` toward the water. */
  const quay = (along: number, out: number) => {
    const axis: [number, number] = [-HARBOUR.out[1], HARBOUR.out[0]];
    return {
      x: HARBOUR.x + axis[0] * along + HARBOUR.out[0] * out,
      z: HARBOUR.z + axis[1] * along + HARBOUR.out[1] * out,
      turn: Math.atan2(axis[0], axis[1]),
    };
  };

  const at = (
    part: Parked['part'], anchor: { x: number; z: number; turn: number }, label: string, reach?: number,
  ) => flatSpot(part, anchor.x, anchor.z, anchor.turn, label, reach);

  return [
    // Two tractors: one in Home Farm's yard with its trailer still on the
    // drawbar, one at Hill Farm. A third works a field (`WORK_LOOPS`).
    at('tractor', yard(HOME_FARM, -10, -18), 'Home Farm tractor'),
    at('tractor', yard(HILL_FARM, 12, -14), 'Hill Farm tractor'),
    // Two combines, both off the yards: they are 12 m long and want room.
    at('harvester', yard(HOME_FARM, -30, 6), 'Home Farm combine'),
    at('harvester', verge('ringSouth', 250, 1, 34), 'the stubble combine'),
    // Four pickups, at the four places anyone parks.
    at('pickup', yard(SUMMIT, 4, 3), 'summit pickup'),
    at('pickup', yard(FORT_CARPARK, -3, 2), 'fort pickup'),
    at('pickup', yard(CAMPSITE, -18, -14), 'campsite pickup'),
    at('pickup', yard(VIEWPOINT, -22, 0), 'viewpoint pickup'),
    // Two box lorries: one on the quay's apron, one at the village hall.
    at('boxLorry', quay(-28, 26), 'the quay lorry'),
    at('boxLorry', verge('churchLane', 112, 1, 30), 'the village hall lorry'),
    // Two artics, where an artic can actually get to and turn: the Petrel
    // road waiting for the bridge, and the bridge landing at the other end.
    at('artic', verge('petrelLane', 30, -1, 19), 'the Petrel artic'),
    at('artic', verge('bridgeLane', 80, 1, 26), 'the landing artic'),
    // Two tractor units: Hill Farm's yard and the harbour.
    at('lorryCab', yard(HILL_FARM, -22, 10), 'Hill Farm lorry'),
    at('lorryCab', quay(24, 24), 'the harbour lorry'),
  ];
})();
