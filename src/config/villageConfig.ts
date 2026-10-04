/**
 * Gannet Harbour: the village on the smaller island.
 *
 * `TRAIN_ISLANDS` carries two made islands. The larger one has the four-road
 * station, the town and the road bridge to the city (`stationConfig`); this
 * one has 198 m of railway across the middle and, on the wide side of it, a
 * small Nordic fishing harbour.
 *
 * ## The theme
 *
 * A harbour town that faces the sea and turns its back on the railway. The
 * line runs through without stopping — there is no halt; the island is a
 * place you look at from the train, and a place a boat can come alongside.
 *
 * - **The harbour front**: one sweep of granite setts from the waterfront
 *   houses round to the inn, edged in dressed stone at the water, with a
 *   timber jetty and three fishing boats.
 * - **The square**, opening off it, with the market hall across its head.
 * - **The lane**: a small village road the length of the island on the
 *   village's side, in the city road kit's own surface but cottage-narrow,
 *   swept on a gentle curve, with a spur down to the harbour.
 * - **The houses and the church** are the same ones Skylark uses — the city's
 *   own houses out of `country.glb`, scaled to cottage size — fronting the
 *   lane, with the square's two at its head facing the water.
 * - **The boats** are the game's own hulls (`boats.glb`), bobbing at the
 *   jetty, as they do in Skylark's cove.
 * - **The lighthouse** on the seaward tip, kept from the hamlet that was here.
 * - **The country** across the line: knolls, rocks and dry-stone paddocks.
 *
 * Furnished from the city's own park kit — lamps, benches, bins, broadleaf
 * trees — so nothing on the island is a new asset except the boats and the
 * stonework, and every repeated thing is instanced.
 *
 * ## Everything is in the island's own frame
 *
 * Same discipline as the station: nothing here is a world coordinate. The frame
 * is the point where the railway crosses the island, `along` is metres up the
 * line and `across` is metres to the left of it, and `villagePoint` is the only
 * thing that knows where that is. Redraw the sketch or regenerate the route and
 * the village moves with it.
 *
 * ## Which side the village is on
 *
 * Measured, not chosen. The line does not cross the middle: at the crossing
 * midpoint the island reaches about 60 m on one hand and 82 m on the other, and
 * the village goes on the wide side — which is also the side the *second* track
 * is not on, so the halt platform can sit beside the running line without
 * having to reach over the down line to get to it.
 */
import {
  RAIL_HEAD_LIFT, TRAIN_ISLANDS, TRAIN_LENGTH, TRAIN_POINTS,
  trainNormalAt, trainPointAt, trainTangentAt,
} from './trainConfig';
import COUNTRY_MODELS from './countryModelData.json';

/** Even-odd point-in-polygon, on the XZ plane. */
const inside = (
  outline: ReadonlyArray<readonly [number, number]>, x: number, z: number,
) => {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, zi] = outline[i];
    const [xj, zj] = outline[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

const area = (outline: ReadonlyArray<readonly [number, number]>) => Math.abs(
  outline.reduce((sum, [x, z], i) => {
    const [nx, nz] = outline[(i + 1) % outline.length];
    return sum + (x * nz - nx * z);
  }, 0) / 2,
);

/** The smaller island. The station has the larger one. */
const HOST = TRAIN_ISLANDS.length < 2 ? null
  : [...TRAIN_ISLANDS].sort((a, b) => area(a.outline) - area(b.outline))[0];

/** Which island that is, by name. See `STATION_ISLAND` for why it is exported. */
export const VILLAGE_ISLAND: string | null = HOST?.name ?? null;

/**
 * The village's frame: where the line crosses the island, and which way round
 * the land lies.
 *
 * The crossing is found the way the station's is — the longest run of route
 * points inside the outline — and the frame sits at its midpoint. `reach` is
 * how far the island extends on each hand there, walked out in two-metre steps
 * until the outline is left behind; it is what decides which side the village
 * is built on and how far out the quay can go.
 */
export const VILLAGE_SITE = (() => {
  if (!HOST || !TRAIN_POINTS.length) return null;
  const n = TRAIN_POINTS.length;
  const on = TRAIN_POINTS.map((p) => inside(HOST.outline, p.x, p.z));
  let best: { from: number; length: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (!on[i] || on[(i - 1 + n) % n]) continue;
    let run = 0;
    while (run < n && on[(i + run) % n]) run++;
    if (!best || run > best.length) best = { from: i, length: run };
  }
  if (!best || best.length < 8) return null;

  const centreIndex = (best.from + Math.floor(best.length / 2)) % n;
  const arc = TRAIN_POINTS[centreIndex].arc;
  const [x, y, z] = trainPointAt(arc);
  const [tx, tz] = trainTangentAt(arc);
  const [nx, nz] = trainNormalAt(arc);

  const walk = (sign: 1 | -1) => {
    let out = 0;
    while (out < 400 && inside(HOST.outline, x + nx * sign * (out + 2), z + nz * sign * (out + 2))) {
      out += 2;
    }
    return out;
  };
  const left = walk(1);
  const right = walk(-1);

  return {
    /** Arc length of the frame's origin: the middle of the crossing. */
    arc,
    /** How much of the line is on the island at all, metres. */
    crossing: best.length * (TRAIN_LENGTH / n),
    centre: [x, y, z] as [number, number, number],
    tangent: [tx, tz] as [number, number],
    normal: [nx, nz] as [number, number],
    heading: Math.atan2(tx, tz),
    /** Island height, and the rail head above it. */
    ground: HOST.crown,
    railHead: y + RAIL_HEAD_LIFT,
    /** How far the island reaches on each hand at the origin. */
    reach: { left, right } as const,
    /**
     * Which hand the village is built on: +1 for the left of travel, -1 for
     * the right. The wider one, and the sign every layout figure below is
     * multiplied by.
     */
    hand: (left > right ? 1 : -1) as 1 | -1,
    name: HOST.name.toUpperCase(),
  };
})();

export const VILLAGE_ENABLED = VILLAGE_SITE !== null;

/** A point in the village's frame, in world space. `across` is left of travel. */
export function villagePoint(along: number, across: number): [number, number, number] {
  if (!VILLAGE_SITE) return [0, 0, 0];
  const [cx, cy, cz] = VILLAGE_SITE.centre;
  const [tx, tz] = VILLAGE_SITE.tangent;
  const [nx, nz] = VILLAGE_SITE.normal;
  return [cx + tx * along + nx * across, cy, cz + tz * along + nz * across];
}

/** How far out the island reaches on the village's hand, at `along`. */
export function villageShore(along: number): number {
  const site = VILLAGE_SITE;
  if (!HOST || !site) return 0;
  const [x, , z] = villagePoint(along, 0);
  const [nx, nz] = site.normal;
  let out = 0;
  while (out < 400) {
    const at = (out + 2) * site.hand;
    if (!inside(HOST.outline, x + nx * at, z + nz * at)) break;
    out += 2;
  }
  return out;
}

/* ------------------------------------------------------------------- relief */

export const RELIEF = {
  /** How high the knolls get over the island's own crown. */
  amplitude: 3.4,
  /** Wavelengths of the two octaves, metres. */
  coarse: 38,
  fine: 14,
  /** The fine octave's share of the amplitude. */
  detail: 0.32,
  /**
   * The flat corridor either side of the running line, and how far past it the
   * ground takes to reach full height. The railway's ballast and formation are
   * built to a level island by `TrainLine`, so the relief leaves them alone.
   */
  railFlat: 9,
  railBlend: 22,
  /** The same, around anything built: flat under it, blending out beyond. */
  buildFlat: 3,
  buildBlend: 11,
  /** How far inside the shore the ground starts to rise. */
  shoreBlend: 20,
} as const;

const fract = (v: number) => v - Math.floor(v);
/** Deterministic value noise on a lattice — no dependency, same ground every load. */
const hash = (x: number, z: number) => fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453);
const ease = (t: number) => t * t * (3 - 2 * t);

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = ease(x - ix);
  const fz = ease(z - iz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * How high the island's surface stands over its crown at a point in the
 * village's frame.
 *
 * Two octaves of value noise, masked to zero wherever something has been built
 * to a level surface — the railway corridor, the buildings, the paving — and
 * faded out before the shore so the beach still meets the water where
 * `TrainLine` drew it.
 */
export function villageRelief(along: number, across: number): number {
  const site = VILLAGE_SITE;
  if (!site) return 0;
  const R = RELIEF;

  // Clear of the railway.
  let mask = clamp01((Math.abs(across) - R.railFlat) / (R.railBlend - R.railFlat));

  // Clear of the shore, and of the ends of the island.
  const reach = Math.abs(across) < 1 ? Math.max(site.reach.left, site.reach.right)
    : (Math.sign(across) === site.hand ? site.reach.right : site.reach.left);
  mask = Math.min(mask, clamp01((reach - Math.abs(across)) / R.shoreBlend));
  mask = Math.min(mask, clamp01((site.crossing / 2 + 14 - Math.abs(along)) / R.shoreBlend));

  // Clear of anything built, and of the paving.
  const out = clearance(along, across);
  mask = Math.min(mask, clamp01((out - R.buildFlat) / (R.buildBlend - R.buildFlat)));

  if (mask <= 0) return 0;
  const coarse = valueNoise(along / R.coarse, across / R.coarse);
  const fine = valueNoise(along / R.fine + 31.4, across / R.fine + 17.2);
  const height = coarse * (1 - R.detail) + fine * R.detail;
  return height * R.amplitude * mask;
}

/** The island's surface height at a point in the village's frame. */
export function villageGround(along: number, across: number): number {
  const site = VILLAGE_SITE;
  return (site ? site.ground : 0) + villageRelief(along, across);
}

/* ------------------------------------------------------------------- layout */

export const VILLAGE = {
  /**
   * The harbour square: along the shore from `from` to `to`, out from
   * `squareInner` to the stone-free shore line less `edgeInset`.
   */
  harbour: {
    from: -22,
    to: 32,
    squareFrom: -22,
    squareTo: 32,
    squareInner: 57,
    westInner: 57,
    eastInner: 57,
    edgeInset: 1,
    step: 4,
  },

  /**
   * The lane: a centreline through these points (along, across), smoothed,
   * and how wide it is. Seven metres is a village road — two cars can pass,
   * just — where the city kit's own carriageway is nineteen.
   */
  road: {
    width: 7,
    points: [[-90, 26], [-62, 31], [-32, 35], [0, 37], [30, 36], [56, 33], [84, 26]] as ReadonlyArray<readonly [number, number]>,
    /** The spur down to the square, at this `along`, from the lane to the square's inner edge. */
    spurAlong: 6,
  },

  /**
   * The far lane, across the line: the same kind of road on the island's
   * other side, through the cottages and the farm. Its `across` figures are
   * NEGATIVE — the far side of the line from the village — in the same
   * village-relative terms as everything else here.
   */
  farRoad: {
    width: 6,
    points: [[-82, -24], [-56, -29], [-20, -31], [20, -30], [50, -27], [74, -22]] as ReadonlyArray<readonly [number, number]>,
  },
  /** The children's playground, on the village side between the harbour houses and the church. */
  playground: { along: 36, across: 48, scale: 0.45 },

  /** The jetty: a timber deck on piles, out past the square. */
  quay: {
    along: 6,
    width: 4.2,
    overWater: 18,
    inland: 4,
    deckRise: 1.2,
    pileSpacing: 4,
    pile: 0.32,
  },

  /** The lighthouse on the island's seaward tip. */
  beacon: {
    along: 82,
    inset: 12,
    height: 9.5,
    baseRadius: 1.9,
    topRadius: 1.25,
    galleryHeight: 1.1,
    lampHeight: 1.6,
  },

  trees: { count: 34, clearOfLine: 18, clearOfBuilt: 5 },
  rocks: { count: 40, boulders: 7, small: [0.5, 1.5] as const, big: [2.2, 4.6] as const,
    clearOfLine: 16, clearOfBuilt: 6 },
} as const;

/* -------------------------------------------------------------------- lane */

/**
 * A centreline sampled every couple of metres: a Catmull-Rom through its
 * points, so the road bends through them rather than kinking at them.
 * (along, across).
 */
function smoothLine(pts: ReadonlyArray<readonly [number, number]>): ReadonlyArray<readonly [number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const steps = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

function lineAcross(r: ReadonlyArray<readonly [number, number]>, along: number): number {
  for (let i = 0; i < r.length - 1; i++) {
    if (along >= r[i][0] && along <= r[i + 1][0]) {
      const t = (along - r[i][0]) / Math.max(1e-6, r[i + 1][0] - r[i][0]);
      return r[i][1] + (r[i + 1][1] - r[i][1]) * t;
    }
  }
  return r[along < r[0][0] ? 0 : r.length - 1][1];
}

/** The village lane's centreline. */
export const VILLAGE_ROAD = smoothLine(VILLAGE.road.points);
/** The far lane's, across the line (negative across). */
export const FAR_ROAD = smoothLine(VILLAGE.farRoad.points);

/** Where the village lane runs at `along`. */
export function roadAcross(along: number): number {
  return lineAcross(VILLAGE_ROAD, along);
}
/** Where the far lane runs at `along` (negative). */
export function farRoadAcross(along: number): number {
  return lineAcross(FAR_ROAD, along);
}

/**
 * How far the island reaches from the line at `along`, on the village's hand
 * (`side` +1) or the far one (-1), in metre steps. Anything that has to stand
 * on the level crown — a rock, a tree — keeps well inside this: the crown
 * gives way to the beach slope a little inside the outline, and a rock placed
 * at crown height over the slope is a rock in mid-air.
 */
const shoreCache = new Map<string, number>();
export function shoreOn(along: number, side: 1 | -1): number {
  const key = `${Math.round(along)}:${side}`;
  const hit = shoreCache.get(key);
  if (hit !== undefined) return hit;
  const site = VILLAGE_SITE;
  if (!HOST || !site) return 0;
  const [x, , z] = villagePoint(Math.round(along), 0);
  const [nx, nz] = site.normal;
  const sign = side * site.hand;
  let out = 0;
  while (out < 400 && inside(HOST.outline, x + nx * sign * (out + 1), z + nz * sign * (out + 1))) out += 1;
  shoreCache.set(key, out);
  return out;
}

/** The spur: from the lane's seaward edge down to the square, as (along, across0, across1). */
export function roadSpur(): [number, number, number] {
  const a = VILLAGE.road.spurAlong;
  return [a, roadAcross(a), VILLAGE.harbour.squareInner + 2];
}

/* ---------------------------------------------------------------- buildings */

/** Which way a building's front looks, in the village's frame. */
export type Facing = 'sea' | 'land' | 'east' | 'west';

/**
 * One of the city's houses (or Skylark's church), placed in the village's
 * frame. `across` is unsigned; `facing` is which way the model's front looks.
 */
export interface Placement {
  part: string;
  along: number;
  across: number;
  facing: Facing;
  scale: number;
  label: string;
}

const KIT_SIZES = COUNTRY_MODELS.parts as Record<string, { size: number[] }>;

/**
 * A house set back `setback` metres from the lane's seaward kerb, its front to
 * the lane: where its centre goes.
 */
const offLane = (along: number, part: string, scale: number, setback = 3) => {
  const depth = (KIT_SIZES[part]?.size[2] ?? 10) * scale;
  return roadAcross(along) + VILLAGE.road.width / 2 + setback + depth / 2;
};

/**
 * The houses are Curlew's — the west district's suburban houses, porches and
 * garages and all, which `country.glb` carries as single parts — scaled to
 * village size and fronting the lane.
 */
/** The same, for a house across the line fronting the far lane: its centre (negative). */
const offFarLane = (along: number, part: string, scale: number, setback = 3) => {
  const depth = (KIT_SIZES[part]?.size[2] ?? 10) * scale;
  return farRoadAcross(along) - VILLAGE.farRoad.width / 2 - setback - depth / 2;
};

export const VILLAGE_BUILDINGS: ReadonlyArray<Placement> = [
  { part: 'house10', along: -80, across: offLane(-80, 'house10', 0.85), facing: 'land', scale: 0.85, label: 'cottage' },
  { part: 'house01', along: -63, across: offLane(-63, 'house01', 0.62), facing: 'land', scale: 0.62, label: 'house' },
  { part: 'house09', along: -44, across: offLane(-44, 'house09', 0.72), facing: 'land', scale: 0.72, label: 'house' },
  // The two at the head of the square, fronting the water, backs to the lane.
  { part: 'house02', along: -10, across: VILLAGE.harbour.squareInner - 1 - (26.62 * 0.56) / 2, facing: 'sea', scale: 0.56, label: 'harbour house' },
  { part: 'house06', along: 22, across: VILLAGE.harbour.squareInner - 1 - (23.9 * 0.58) / 2, facing: 'sea', scale: 0.58, label: 'harbour house' },
  { part: 'church', along: 50, across: offLane(50, 'church', 0.85, 4), facing: 'land', scale: 0.85, label: 'church' },
  { part: 'house12', along: 72, across: offLane(72, 'house12', 0.66), facing: 'land', scale: 0.66, label: 'house' },

  // Across the line: cottages down the far lane, and a farmstead in the middle
  // of it — the farmhouse, its barn and a silo — fronting the lane. A front
  // looking toward the railway from this side is 'sea' in `facingTurn`'s
  // terms: it means toward +across, which over here is back toward the line.
  { part: 'house13', along: -64, across: offFarLane(-64, 'house13', 0.6), facing: 'sea', scale: 0.6, label: 'cottage' },
  { part: 'house10', along: -47, across: offFarLane(-47, 'house10', 0.85), facing: 'sea', scale: 0.85, label: 'cottage' },
  { part: 'house01', along: -4, across: offFarLane(-4, 'house01', 0.62), facing: 'sea', scale: 0.62, label: 'farmhouse' },
  { part: 'indShedRail', along: 18, across: offFarLane(18, 'indShedRail', 0.6, 4), facing: 'sea', scale: 0.6, label: 'barn' },
  { part: 'indSilo', along: 27.5, across: offFarLane(27.5, 'indSilo', 0.8, 9), facing: 'sea', scale: 0.8, label: 'silo' },
  { part: 'house09', along: 50, across: offFarLane(50, 'house09', 0.62), facing: 'sea', scale: 0.62, label: 'house' },
  { part: 'house12', along: 65, across: offFarLane(65, 'house12', 0.58), facing: 'sea', scale: 0.58, label: 'house' },
];

/**
 * The rotation that turns a building's front to `facing`, on top of the
 * line's heading.
 *
 * The village's group is turned by the heading, which makes its local +X the
 * frame's +across and +Z its +along. A turn ψ sends a model's −Z front to
 * (−sin ψ, −cos ψ), so a front looking along local (dx, dz) wants
 * ψ = atan2(−dx, −dz). The sea is +across on the village's hand.
 */
export function facingTurn(facing: Facing, hand: 1 | -1): number {
  const d: Record<Facing, [number, number]> = {
    sea: [hand, 0], land: [-hand, 0], east: [0, 1], west: [0, -1],
  };
  const [dx, dz] = d[facing];
  return Math.atan2(-dx, -dz);
}

/** A building's half-extents in the village's frame, [across, along]. */
export function buildingHalf(b: Placement): [number, number] {
  const size = KIT_SIZES[b.part]?.size ?? [10, 8, 10];
  const sideways = b.facing === 'sea' || b.facing === 'land';
  const w = size[0] * b.scale;
  const d = size[2] * b.scale;
  return sideways ? [d / 2, w / 2] : [w / 2, d / 2];
}

/** A building's footprint in its own axes, [width, depth], for the minimap. */
export function buildingSize(b: Placement): [number, number] {
  const size = KIT_SIZES[b.part]?.size ?? [10, 8, 10];
  return [size[0] * b.scale, size[2] * b.scale];
}

/* -------------------------------------------------------------------- paving */

/**
 * The harbour front's landward edge at `along`, unsigned, or null where there
 * is no harbour front.
 */
export function harbourInner(along: number): number | null {
  const H = VILLAGE.harbour;
  if (along < H.from || along > H.to) return null;
  if (along >= H.squareFrom && along <= H.squareTo) return H.squareInner;
  return along < H.squareFrom ? H.westInner : H.eastInner;
}

/**
 * The shore on the village's hand, finely: walked in quarter-metre steps
 * rather than `villageShore`'s two, then averaged over a few metres either
 * side. The coarse walk is fine for siting a building; as the line a row of
 * dressed stones follows it is a saw blade.
 */
const fineShore = new Map<number, number>();
function shoreFine(along: number): number {
  const key = Math.round(along * 4);
  const hit = fineShore.get(key);
  if (hit !== undefined) return hit;
  const site = VILLAGE_SITE;
  if (!HOST || !site) return 0;
  const [x, , z] = villagePoint(key / 4, 0);
  const [nx, nz] = site.normal;
  let out = Math.max(0, villageShore(key / 4) - 2);
  while (out < 400 && inside(HOST.outline, x + nx * (out + 0.25) * site.hand, z + nz * (out + 0.25) * site.hand)) {
    out += 0.25;
  }
  fineShore.set(key, out);
  return out;
}

/** And its seaward edge, where the dressed-stone edge stands. */
export function harbourOuter(along: number): number {
  let sum = 0;
  for (let k = -3; k <= 3; k++) sum += shoreFine(along + k);
  return sum / 7 - VILLAGE.harbour.edgeInset;
}

/**
 * How far a point (along, across — across SIGNED, in the frame) is from
 * anything built or paved on the village's side: negative inside it.
 *
 * The one test the relief, the trees and the rocks all ask, so the ground
 * cannot rise under a house or a tree grow through the square.
 */
export function clearance(along: number, signedAcross: number): number {
  const site = VILLAGE_SITE;
  if (!site) return Infinity;
  const across = signedAcross * site.hand;
  let best = Infinity;
  for (const b of VILLAGE_BUILDINGS) {
    const [ha, hl] = buildingHalf(b);
    best = Math.min(best, Math.max(Math.abs(across - b.across) - ha, Math.abs(along - b.along) - hl));
  }
  const inner = harbourInner(along);
  if (inner !== null) {
    const outer = harbourOuter(along);
    const H = VILLAGE.harbour;
    const alongOut = Math.max(H.from - along, along - H.to);
    best = Math.min(best, Math.max(inner - across, across - outer, alongOut));
  }
  // The two lanes, and the spur down to the square.
  const lane = (r: ReadonlyArray<readonly [number, number]>, half: number) => {
    const alongOut = Math.max(r[0][0] - along, along - r[r.length - 1][0]);
    return Math.max(Math.abs(across - lineAcross(r, along)) - half, alongOut);
  };
  const half = VILLAGE.road.width / 2;
  best = Math.min(best, lane(VILLAGE_ROAD, half), lane(FAR_ROAD, VILLAGE.farRoad.width / 2));
  const [sa, s0, s1] = roadSpur();
  best = Math.min(best, Math.max(Math.abs(along - sa) - half, s0 - across, across - s1));
  const P = VILLAGE.playground;
  best = Math.min(best, Math.max(Math.abs(along - P.along) - 6, Math.abs(across - P.across) - 4.5));
  return best;
}

/* ---------------------------------------------------------------- planting */

/** The park kit's parts the village plants and furnishes with. */
export const VILLAGE_KIT = ['treeBroad', 'treeBig', 'treeSlim', 'bush', 'bushLow', 'lamp', 'bench', 'bin', 'planter', 'iceCart', 'shelter', 'playground'] as const;
export type VillageKitPart = (typeof VILLAGE_KIT)[number];

/** One kit part placed in the frame: across SIGNED, a turn on top of the heading. */
export interface KitPlacement { along: number; across: number; turn: number; scale: number }

/**
 * The village's trees: broadleaf, in the open ground on both sides of the
 * line, never on the paving, the lane or in a house.
 *
 * Rejection sampling, seeded so the wood is the same every load, with the
 * taller ones biased uphill — trees that grow bigger on the knolls make the
 * knolls read as knolls.
 */
export const VILLAGE_TREES: ReadonlyArray<KitPlacement & { part: VillageKitPart }> = (() => {
  const site = VILLAGE_SITE;
  if (!HOST || !site) return [];
  let seed = 7331;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: Array<KitPlacement & { part: VillageKitPart }> = [];
  const T = VILLAGE.trees;
  for (let tries = 0; tries < 9000 && out.length < T.count; tries++) {
    const along = (random() * 2 - 1) * (site.crossing / 2 + 10);
    const across = (random() * 2 - 1) * Math.max(site.reach.left, site.reach.right);
    const [x, , z] = villagePoint(along, across);
    if (!inside(HOST.outline, x, z)) continue;
    if (Math.abs(across) < T.clearOfLine) continue;
    // Well back from the shore, on the crown and not the beach slope.
    if (Math.abs(across) > shoreOn(along, Math.sign(across) === site.hand ? 1 : -1) - 8) continue;
    if (clearance(along, across) < T.clearOfBuilt) continue;
    if (out.some((t) => Math.hypot(t.along - along, t.across - across) < 9)) continue;
    const uphill = villageRelief(along, across) / RELIEF.amplitude;
    const roll = random();
    const part: VillageKitPart = roll < 0.5 ? 'treeBroad' : roll < 0.75 ? 'treeBig' : roll < 0.9 ? 'treeSlim' : 'bush';
    const base = part === 'treeBig' ? 0.5 : part === 'treeSlim' ? 0.7 : part === 'bush' ? 0.9 : 0.7;
    out.push({ part, along, across, turn: random() * Math.PI * 2, scale: base + random() * 0.25 + uphill * 0.25 });
  }
  return out;
})();

/**
 * The harbour's furniture: lamps along the stone edge with benches facing
 * the water between them, and a ring of lamps round the square.
 */
export const VILLAGE_FURNITURE: ReadonlyArray<KitPlacement & { part: VillageKitPart }> = (() => {
  const site = VILLAGE_SITE;
  if (!site) return [];
  const H = VILLAGE.harbour;
  const out: Array<KitPlacement & { part: VillageKitPart }> = [];
  const seaward = facingTurn('sea', site.hand);
  let i = 0;
  for (let along = H.from + 6; along <= H.to - 4; along += 11, i++) {
    // Leave the jetty's head clear.
    if (Math.abs(along - VILLAGE.quay.along) < 4) continue;
    const edge = harbourOuter(along) - 1.6;
    out.push({ part: 'lamp', along, across: edge * site.hand, turn: 0, scale: 1.5 });
    if (i % 2 === 0) {
      out.push({ part: 'bench', along: along + 5, across: (edge - 0.4) * site.hand, turn: seaward + Math.PI / 2, scale: 1 });
    } else {
      out.push({ part: 'bin', along: along + 1.2, across: edge * site.hand, turn: 0, scale: 1 });
    }
  }
  // Front-garden hedges along the lane, in front of each house that fronts
  // it, with a gap at the gate.
  for (const b of VILLAGE_BUILDINGS) {
    const far = b.across < 0;
    if (!far && b.facing !== 'land') continue;
    if (b.part.startsWith('ind')) continue;
    const [, halfAlong] = buildingHalf(b);
    const verge = far
      ? farRoadAcross(b.along) - VILLAGE.farRoad.width / 2 - 1.2
      : roadAcross(b.along) + VILLAGE.road.width / 2 + 1.2;
    for (let a = b.along - halfAlong; a <= b.along + halfAlong; a += 2.1) {
      if (Math.abs(a - b.along) < 1.6) continue;
      out.push({ part: 'bushLow', along: a, across: verge * site.hand, turn: Math.PI / 2, scale: 0.9 });
    }
  }
  // The square: planters with the ice-cream cart between them, and a shelter
  // at the head of the jetty.
  for (const along of [H.squareFrom + 6, -2, 14, H.squareTo - 4]) {
    out.push({ part: 'planter', along, across: (H.squareInner + 6) * site.hand, turn: 0, scale: 0.55 });
    out.push({ part: 'bush', along, across: (H.squareInner + 6) * site.hand, turn: along, scale: 0.7 });
  }
  out.push({ part: 'iceCart', along: 0, across: (H.squareInner + 11) * site.hand, turn: facingTurn('sea', site.hand), scale: 1 });
  out.push({ part: 'shelter', along: VILLAGE.quay.along + 5, across: (harbourOuter(VILLAGE.quay.along) - 3) * site.hand, turn: 0, scale: 1 });

  // Street lamps down both lanes, on their railway-side verges.
  for (let along = -80; along <= 76; along += 16) {
    out.push({ part: 'lamp', along, across: (roadAcross(along) - VILLAGE.road.width / 2 - 1) * site.hand, turn: 0, scale: 1.5 });
  }
  for (let along = -72; along <= 66; along += 18) {
    out.push({ part: 'lamp', along, across: (farRoadAcross(along) + VILLAGE.farRoad.width / 2 + 1) * site.hand, turn: 0, scale: 1.5 });
  }
  // The playground, with a bench either side of it.
  const P = VILLAGE.playground;
  out.push({ part: 'playground', along: P.along, across: P.across * site.hand, turn: 0, scale: P.scale });
  for (const side of [-1, 1]) {
    out.push({ part: 'bench', along: P.along + side * 7.5, across: P.across * site.hand, turn: 0, scale: 1 });
  }
  return out;
})();

/**
 * The two vehicles in the village: the post van that came over on the boat,
 * and somebody's small car.
 * In the frame, across SIGNED, the car's turn on top of the heading.
 */
export const VILLAGE_CARS: ReadonlyArray<{ along: number; across: number; turn: number }> = (() => {
  const site = VILLAGE_SITE;
  if (!site) return [];
  return [
    // The van on the square by the jetty; the car pulled in on the lane's
    // verge outside the cottages.
    { along: 14, across: (VILLAGE.harbour.squareInner + 4) * site.hand, turn: 0 },
    { along: -50, across: (roadAcross(-50) + VILLAGE.road.width / 2 + 1.3) * site.hand, turn: 0.05 },
  ];
})();
export const VILLAGE_CAR_KINDS = ['postvan', 'Compact_Body'] as const;

/**
 * The country across the line: Skylark's windmill on the meadow, and sheep
 * and a pair of horses grazing round it. Across SIGNED, on the hand away from
 * the village. `turn` on top of the heading.
 */
export const VILLAGE_PASTURE = (() => {
  const site = VILLAGE_SITE;
  if (!site) return { mill: null, sheep: [], horses: [] };
  const far = -site.hand;
  let seed = 515;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const herd = (n: number, along: number, across: number, spread: number) =>
    Array.from({ length: n }, () => ({
      along: along + (rnd() * 2 - 1) * spread,
      across: (across + (rnd() * 2 - 1) * spread * 0.5) * far,
      turn: rnd() * Math.PI * 2,
    }));
  return {
    // Out on the far tip on its own, where it can be seen from both lanes.
    mill: { along: -86, across: 22 * far, turn: 0.6 },
    // The sheep in the paddock behind the barn, the horses by the farmhouse.
    sheep: herd(6, 37, 46, 6),
    horses: herd(2, -21, 46, 4),
  };
})();

/**
 * Rocks, in two sizes: boulders on the high ground and stones everywhere else.
 * The boulders are biased to the knolls — a rock on a rise is a landmark — and
 * the small ones are allowed down to the tide line.
 */
export const VILLAGE_ROCKS: ReadonlyArray<{
  along: number; across: number; turn: number; tilt: number; size: number; squash: number;
}> = (() => {
  const site = VILLAGE_SITE;
  if (!HOST || !site) return [];
  let seed = 90211;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const R = VILLAGE.rocks;
  const out: Array<{
    along: number; across: number; turn: number; tilt: number; size: number; squash: number;
  }> = [];
  for (let tries = 0; tries < 9000 && out.length < R.count; tries++) {
    const boulder = out.length < R.boulders;
    const along = (random() * 2 - 1) * (site.crossing / 2 + 22);
    const across = (random() * 2 - 1) * Math.max(site.reach.left, site.reach.right);
    const [x, , z] = villagePoint(along, across);
    if (!inside(HOST.outline, x, z)) continue;
    if (Math.abs(across) < R.clearOfLine) continue;
    if (Math.abs(across) > shoreOn(along, Math.sign(across) === site.hand ? 1 : -1) - 7) continue;
    if (clearance(along, across) < R.clearOfBuilt) continue;
    const rise = villageRelief(along, across) / RELIEF.amplitude;
    if (boulder && rise < 0.55) continue;
    const [lo, hi] = boulder ? R.big : R.small;
    out.push({
      along,
      across,
      turn: random() * Math.PI * 2,
      tilt: (random() - 0.5) * 0.5,
      size: lo + random() * (hi - lo),
      squash: 0.45 + random() * 0.4,
    });
  }
  return out;
})();
