/**
 * The village on the smaller island.
 *
 * `TRAIN_ISLANDS` carries two made islands. The larger one has the four-road
 * station, the transplanted town and the road bridge to the city
 * (`stationConfig`); the smaller one had 22,900 m² of grass, 198 m of railway
 * across the middle of it and nothing else — which from a passing cab read as
 * a mistake rather than as somewhere.
 *
 * So it gets a hamlet: two rows of cottages down a lane, a low building at the
 * head of it, a quay with two boats out over the water, field walls, trees, and
 * a halt on the running line so the railway has a reason to pass this way.
 *
 * ## The buildings are the city's own, chosen by height
 *
 * Same trick as the station's town — a merged chunk of `city.glb` drawn a
 * second time under a different matrix, for one draw call and no new asset —
 * but selected rather than taken wholesale. The town works because it is a
 * *block*: a street with four-storey frontages, which is what the bigger
 * island's suburb wants. On a 200 m island reached only by rail, four storeys
 * would be absurd, so the chunks here were picked by measuring every cell in
 * the city and taking the ones whose buildings are single-storey:
 *
 * - `deco_Building_-4_-1` is an 80 x 27 m row of two-storey buildings, 8.8 m to
 *   the eaves, 3,120 triangles. It is the village street, laid twice — once at
 *   each end of the island, the second mirrored so it is not visibly the same
 *   row.
 * - `col_Building_-4_-1` is a pair of 3.4 m buildings in 55 x 17 m, from the
 *   same low-rise cell. They go behind the houses as outbuildings.
 * - `deco_Vegetation_-3_-3` is one tree, and `deco_Accesories_-4_-3` one piece
 *   of street furniture. Both are scattered, instanced.
 *
 * Chosen by *density* as much as by height, which is the part worth writing
 * down. The first attempt took the shortest buildings in the city — a 4.8 m
 * row in cell -5_0 — on the assumption that short means domestic. It does not:
 * 276 triangles across 70 m of frontage is a row of blue-roofed sheds, and on
 * the island it read as a depot. Two storeys at 1.4 triangles per square metre
 * is a *house*, because windows, doors and eaves are what the triangles are
 * spent on.
 *
 * What is *not* the city's is what the city has none of: the quay, the boats,
 * the dry-stone walls and the halt. A fishing village needs a way to arrive by
 * sea and the railway needs somewhere to stop, and neither exists in a merged
 * city block.
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
   * ground takes to reach full height.
   *
   * The railway's ballast, its formation and the halt are all built to a level
   * island (`ISLAND_CROWN`) by `TrainLine`, which knows nothing about this — so
   * the relief has to leave the railway alone or the embankment's toe would
   * hang in the air. Nine metres flat is the formation plus its shoulders;
   * twenty-two is where the ground is free to do what it likes.
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
/** Deterministic value noise on a lattice — no dependency, same wood every load. */
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
 * to a level surface — the railway corridor, the buildings, the lane — and
 * faded out before the shore so the beach still meets the water where
 * `TrainLine` drew it.
 *
 * The mask is the whole of the difficulty. Relief is easy; relief that does not
 * leave a building on a plinth, a wall floating over a dip or a ballast toe in
 * mid-air is a set of exclusion zones, and every one of them is something else
 * on this island that was drawn flat.
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

  // Clear of anything built.
  for (const b of VILLAGE_BUILDINGS) {
    const half = VILLAGE.footprint[b.part] ?? [12, 12];
    const turned = b.turn % Math.PI !== 0;
    const alongHalf = turned ? half[0] : half[1];
    const acrossHalf = turned ? half[1] : half[0];
    const dAlong = Math.abs(along - b.along) - alongHalf;
    const dAcross = Math.abs(across - b.across * site.hand) - acrossHalf;
    const out = Math.max(dAlong, dAcross);
    mask = Math.min(mask, clamp01((out - R.buildFlat) / (R.buildBlend - R.buildFlat)));
  }
  // And of the lane.
  const lane = Math.abs(across - VILLAGE.laneAcross * site.hand) - VILLAGE.laneWidth / 2;
  const laneEnd = Math.abs(along - VILLAGE.laneAlong) - VILLAGE.laneHalfLength;
  const laneOut = Math.max(lane, laneEnd);
  mask = Math.min(mask, clamp01((laneOut - R.buildFlat) / (R.buildBlend - R.buildFlat)));

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

export const VILLAGE = {
  /**
   * The lane: how far off the line it runs, how wide, how long, and where its
   * midpoint is. Between the two cottage rows, and running past the head of
   * the village to the low building at the end of it.
   */
  laneAcross: 12,
  laneWidth: 6,
  laneHalfLength: 78,
  laneAlong: 0,
  /** The footpath from the halt to the lane. */
  pathWidth: 2.2,

  /**
   * Where the two cottage rows sit, as a record for everything that has to
   * stay clear of them — the walls, the trees and the paddocks. The rows
   * themselves are placed by `VILLAGE_BUILDINGS`; these are the same figures.
   */
  rowInner: 30,
  rowOuter: 56,

  /** The quay: a timber deck on piles, reaching out past the beach. */
  quay: {
    along: 52,
    width: 5,
    /** How far past the outline the deck goes, and the pile pitch under it. */
    overWater: 14,
    deckRise: 1.6,
    pileSpacing: 4.5,
    pile: 0.34,
  },

  /**
   * Field walls: dry stone, low, and built in segments.
   *
   * The pitch is what lets a wall cross the relief. One long box over rolling
   * ground buries one end and leaves the other in the air; two-metre segments,
   * each set on the ground it stands on, step up a slope the way a dry-stone
   * wall actually does.
   */
  wall: { height: 0.85, thickness: 0.5, pitch: 2 },

  /**
   * The beacon on the island's seaward tip.
   *
   * The one vertical thing out here, and the reason it is worth building rather
   * than transplanted: the city has nothing that reads as a light. From the
   * bridge, from the station and from a train two kilometres away, the small
   * island is a green lump — with this, it is a green lump with a light on it,
   * which is the difference between scenery and a place.
   */
  beacon: {
    /** How far along from the frame's origin, and how far in from the shore. */
    along: 82,
    inset: 12,
    height: 9.5,
    baseRadius: 1.9,
    topRadius: 1.25,
    galleryHeight: 1.1,
    lampHeight: 1.6,
  },

  /**
   * Clutter on the shore by the quay: upturned dinghies and stacks of pots.
   *
   * The cheapest possible signal that somebody works here. Boxes and a hull,
   * placed at the tide line — a quay with nothing on it is a pier.
   */
  clutter: { count: 7 },

  /** Trees and props, scattered by rejection sampling — see `VILLAGE_TREES`. */
  trees: { count: 64, clearOfLine: 19, clearOfBuilding: 6, clearOfLane: 5 },
  /** Copses: the three-tree chunk, in the open ground away from the houses. */
  copses: { count: 7, clearOfLine: 26, clearOfBuilding: 16 },
  /**
   * The city's street-furniture chunk, which turns out to be a white-and-orange
   * striped stall.
   *
   * Eleven of them spaced down the lane read as roadworks. Four of them
   * clustered at the quay end read as the morning's fish market, which is what
   * they are now — the lesson being that a transplanted prop's *meaning* comes
   * from how many there are and where they stand, not from the mesh.
   */
  props: { count: 4, along: 40, spread: 11 },
  /**
   * Rocks: how many, how big, and where they are allowed.
   *
   * Two populations rather than one, because a scatter of evenly sized stones
   * reads as gravel. Boulders are landmarks — you can tell one knoll from
   * another by which rock is on it — and the small ones are litter round their
   * feet and along the tide line.
   */
  rocks: { count: 54, boulders: 9, small: [0.5, 1.5] as const, big: [2.2, 4.6] as const,
    clearOfLine: 16, clearOfBuilding: 7 },
  /**
   * Half-extents of each transplanted chunk, [across, along] in its own axes.
   *
   * Stated, unusually, and only because it has to be: the real sizes are in
   * `city.glb` and are not known until it has loaded, while the tree scatter is
   * computed at module load. They are rounded up from the measured chunks, so
   * the only cost of being wrong is a tree not planted somewhere it could have
   * been.
   */
  footprint: {
    'deco_Building_-4_-1': [40, 14],
    'col_Building_-4_-1': [28, 9],
  } as Record<string, readonly [number, number]>,

  /**
   * The halt: one short low platform on the running line.
   *
   * Not a station. There is no loop, no second face and no pointwork — a halt
   * is a platform and a nameboard, which is exactly what a hamlet of nine
   * cottages would have got. It sits on the village's hand so that stepping off
   * the train puts you on the right side of the railway, and it is deliberately
   * short: 30 m is a coach and a half, and the length is the thing that says
   * "halt" rather than "station".
   */
  halt: {
    length: 30,
    width: 3.2,
    /** Face off the track centre, as the station's platforms are. */
    setback: 1.7,
    rise: 0.5,
    rampLength: 4.5,
    shelter: [3.4, 2.4] as const,
    shelterHeight: 2.5,
    boardHeight: 1.9,
    lampHeight: 3.6,
  },
} as const;

/**
 * One placement of a city chunk on the island.
 *
 * `part` is the chunk's mesh name in `city.glb` — the merged (material, cell)
 * name that `prepare-map.mjs` writes, which is stable as long as the map is
 * prepared from the same source. `turn` is applied on top of the island frame's
 * own heading, so 0 lays the chunk's long axis along the railway.
 */
export interface Placement {
  part: string;
  along: number;
  across: number;
  /** Extra rotation about Y, radians, on top of the line's heading. */
  turn: number;
}

/**
 * The village's buildings.
 *
 * Laid out against the measured land rather than by eye: the island reaches
 * about 82 m on the village's hand at the middle of the crossing and 52 m by
 * 80 m out, so the two 70 m rows sit either side of the middle where there is
 * depth for them, and the 55 m building group goes at the west end where there
 * is length but not width. Nothing is closer than 14 m to the running line,
 * which is the structure gauge plus a margin.
 *
 * The `across` figures are unsigned; `VILLAGE_SITE.hand` puts them on whichever
 * side of the railway the island actually has.
 */
export const VILLAGE_BUILDINGS: ReadonlyArray<Placement> = [
  // The two halves of the street, end to end along the island rather than
  // facing each other across the lane: 27 m of depth twice over plus a lane
  // between them is 60 m, and the island has 74 m at the point where the rows
  // would end. End to end it fits with room for the paddocks behind.
  { part: 'deco_Building_-4_-1', along: -42, across: 30, turn: -Math.PI / 2 },
  { part: 'deco_Building_-4_-1', along: 42, across: 30, turn: Math.PI / 2 },
  // Outbuildings behind the houses, from the same low-rise cell.
  { part: 'col_Building_-4_-1', along: 0, across: 56, turn: -Math.PI / 2 },
];

/** The chunks used for a tree, a three-tree copse, and street furniture. */
export const VILLAGE_TREE_PART = 'deco_Vegetation_-3_-3';
export const VILLAGE_COPSE_PART = 'deco_Vegetation_-4_-5';
export const VILLAGE_PROP_PART = 'deco_Accesories_-4_-3';

/**
 * Where the trees go.
 *
 * Rejection sampling over the island, seeded so the wood is the same every
 * load: a candidate is kept if it is on the island, far enough from the running
 * line to be clear of the structure gauge, off the lane, and not inside
 * anybody's house. Cheaper to write than a hand-placed wood and much harder to
 * make look like a grid.
 *
 * Each one carries its own height, and the taller ones are biased *uphill* —
 * `villageRelief` is sampled at the candidate and mixed into the scale. It is a
 * cheap trick and it does a lot: trees that grow bigger on the knolls make the
 * knolls read as knolls rather than as bumps in a lawn.
 */
export const VILLAGE_TREES: ReadonlyArray<{
  along: number; across: number; turn: number; scale: number;
}> = (() => {
  const site = VILLAGE_SITE;
  if (!HOST || !site) return [];
  let seed = 7331;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: Array<{ along: number; across: number; turn: number; scale: number }> = [];
  const { clearOfLine, clearOfBuilding, clearOfLane } = VILLAGE.trees;
  for (let tries = 0; tries < 9000 && out.length < VILLAGE.trees.count; tries++) {
    const along = (random() * 2 - 1) * (site.crossing / 2 + 20);
    const across = (random() * 2 - 1) * Math.max(site.reach.left, site.reach.right);
    const [x, , z] = villagePoint(along, across);
    if (!inside(HOST.outline, x, z)) continue;
    if (Math.abs(across) < clearOfLine) continue;
    const onVillageHand = Math.sign(across) === site.hand;
    if (onVillageHand) {
      const laneAt = VILLAGE.laneAcross * site.hand;
      if (Math.abs(across - laneAt) < VILLAGE.laneWidth / 2 + clearOfLane
        && Math.abs(along - VILLAGE.laneAlong) < VILLAGE.laneHalfLength) continue;
      if (VILLAGE_BUILDINGS.some((b) => {
        const half = VILLAGE.footprint[b.part] ?? [12, 12];
        const turned = b.turn % Math.PI !== 0;
        return Math.abs(b.along - along) < (turned ? half[0] : half[1]) + clearOfBuilding
          && Math.abs(b.across * site.hand - across) < (turned ? half[1] : half[0]) + clearOfBuilding;
      })) continue;
    }
    // Not on top of another tree, and not in the middle of a copse.
    if (out.some((t) => Math.abs(t.along - along) < 5 && Math.abs(t.across - across) < 5)) continue;
    const uphill = villageRelief(along, across) / RELIEF.amplitude;
    out.push({
      along,
      across,
      turn: random() * Math.PI * 2,
      scale: 0.62 + random() * 0.5 + uphill * 0.45,
    });
  }
  return out;
})();

/**
 * Copses: the city's three-tree chunk, dropped in the open ground.
 *
 * A wood is not a denser scatter of single trees — it is *groups*, and the
 * chunk that happens to hold three trees in 50 x 12 m is a group for one draw
 * call. Kept well back from the line and the houses, because at 50 m across
 * there is nowhere near a building it would fit.
 */
export const VILLAGE_COPSES: ReadonlyArray<{
  along: number; across: number; turn: number; scale: number;
}> = (() => {
  const site = VILLAGE_SITE;
  if (!HOST || !site) return [];
  let seed = 40241;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: Array<{ along: number; across: number; turn: number; scale: number }> = [];
  const { clearOfLine, clearOfBuilding } = VILLAGE.copses;
  for (let tries = 0; tries < 4000 && out.length < VILLAGE.copses.count; tries++) {
    const along = (random() * 2 - 1) * (site.crossing / 2 + 10);
    const across = (random() * 2 - 1) * Math.max(site.reach.left, site.reach.right);
    const [x, , z] = villagePoint(along, across);
    // The chunk is 25 m from its centre to its far end, so its own corners have
    // to be on the island too — checked, not assumed.
    if (!inside(HOST.outline, x, z)) continue;
    const reach = Math.sign(across) === site.hand ? site.reach.right : site.reach.left;
    if (Math.abs(across) < clearOfLine || Math.abs(across) > reach - 26) continue;
    if (VILLAGE_BUILDINGS.some((b) => {
      const half = VILLAGE.footprint[b.part] ?? [12, 12];
      const turned = b.turn % Math.PI !== 0;
      return Math.abs(b.along - along) < (turned ? half[0] : half[1]) + clearOfBuilding
        && Math.abs(b.across * site.hand - across) < (turned ? half[1] : half[0]) + clearOfBuilding;
    })) continue;
    if (out.some((c) => Math.abs(c.along - along) < 30 && Math.abs(c.across - across) < 30)) continue;
    out.push({ along, across, turn: random() * Math.PI * 2, scale: 0.8 + random() * 0.5 });
  }
  return out;
})();

/**
 * Rocks, in two sizes: boulders on the high ground and stones everywhere else.
 *
 * The boulders are placed first and biased to the knolls — a rock on a rise is
 * a landmark, and the same rock in a hollow is a nuisance to walk round. The
 * small ones are allowed right down to the tide line, which is where a shore
 * actually keeps its stones.
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
    if (VILLAGE_BUILDINGS.some((b) => {
      const half = VILLAGE.footprint[b.part] ?? [12, 12];
      const turned = b.turn % Math.PI !== 0;
      return Math.abs(b.along - along) < (turned ? half[0] : half[1]) + R.clearOfBuilding
        && Math.abs(b.across * site.hand - across) < (turned ? half[1] : half[0]) + R.clearOfBuilding;
    })) continue;
    const rise = villageRelief(along, across) / RELIEF.amplitude;
    // A boulder wants the high ground; a stone does not care.
    if (boulder && rise < 0.55) continue;
    const [lo, hi] = boulder ? R.big : R.small;
    out.push({
      along,
      across,
      turn: random() * Math.PI * 2,
      tilt: (random() - 0.5) * 0.5,
      size: lo + random() * (hi - lo),
      // Rocks are wider than they are tall, and the flatter ones read as
      // outcrop rather than as dropped balls.
      squash: 0.45 + random() * 0.4,
    });
  }
  return out;
})();

/**
 * Props along the lane: the city's own street furniture, dropped where a
 * passer-by would put it.
 *
 * Alternating sides of the lane and clear of the cottage fronts. Six of them,
 * because the piece is 1,674 triangles — cheap once, and the sixth is the last
 * one that adds anything.
 */
export const VILLAGE_PROPS: ReadonlyArray<{ along: number; across: number; turn: number }> = (
  () => {
    const site = VILLAGE_SITE;
    if (!site) return [];
    const P = VILLAGE.props;
    const out: Array<{ along: number; across: number; turn: number }> = [];
    // Two ragged rows facing each other across the lane, in a huddle rather
    // than a queue: a market is a knot of stalls, and the giveaway that it is
    // not one is even spacing.
    const offsets = [-0.9, 0.35, -0.2, 0.8];
    for (let i = 0; i < P.count; i++) {
      const side = i % 2 ? 1 : -1;
      out.push({
        along: P.along + offsets[i % offsets.length] * P.spread,
        across: (VILLAGE.laneAcross + side * (VILLAGE.laneWidth / 2 + 2.1)) * site.hand,
        turn: side > 0 ? 0.1 : Math.PI - 0.15,
      });
    }
    return out;
  })();
