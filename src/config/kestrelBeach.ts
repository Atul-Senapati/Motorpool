import { TRAIN, TRAIN_ISLANDS } from './trainConfig';
import { STATION_ISLAND, STATION_SITE, stationFrameOf, stationPoint, stationTracksInFrame } from './stationConfig';
import {
  KESTREL_ARCS, KESTREL_NODES, KESTREL_ROADS_ENABLED, KESTREL_RUNS, KESTREL_SWEEPS, kestrelArcPoints,
  sweepPoints,
} from './kestrelRoads';
import { ROAD_WIDTH } from './roadConfig';

/**
 * Kestrel Beach: the island's north-east shore, from fifty metres off the rail
 * bridge round the nose and west along the north shore past where the concert
 * stage stood.
 *
 * The railway islands end in a vertical sea wall: a grass crown at 3.2 m and a
 * face straight down to the seabed (`TrainLine`). Here that edge is replaced
 * by land that does what a coast does — it falls 6.8 m to the sea over a beach
 * of sand, and keeps going under the water as a shallow shelf:
 *
 *   crown ──╮
 *           ╰──────── sand, eased, ~1:12–1:18 ────────╮ waterline
 *                                                      ╰──── shelf ────╮
 *                                                                      ╰── seabed
 *
 * ## Where it starts
 *
 * The beach's top edge is set back from the shore along the shore's own inward
 * normal as far as the land allows: no closer than `ROAD_CLEAR` to the nearest
 * road (or the railway), and no deeper than `MAX_DEPTH`. That depth is smoothed
 * along the shore so the beach's top line is a curve, not a staircase, and it tapers
 * to nothing at both ends of the stretch, where the beach runs out into the sea
 * wall again.
 *
 * ## How it is built
 *
 * In world space, from the station island's own outline: each outline point
 * in the stretch is a "column" — shore point, inward normal, depth — and the
 * beach mesh is those columns crossed with the profile. The crown and the sea
 * wall are drawn from `BEACH_OUTLINE`, which is the island's outline with the
 * stretch pulled back to the beach's top edge, and the wall is left off that
 * part (`BEACH_NO_WALL`). Everything that lays out the island — roads, blocks,
 * the berth — still reads the original outline.
 */

/** Levelled pads in the beach (the food courts'), filled in once they are placed below. */
const PADS: Array<{ x: number; z: number; y: number; shore: [number, number]; sea: [number, number]; halfU: number; halfV: number }> = [];

/**
 * A beach height `h` at (x, z), `d` metres down from the top edge, with the
 * pads levelled in: flat on the pad, blending back to `h` over `PAD_BLEND`
 * round it. The top edge row itself is left alone, so it still meets the
 * island's crown.
 */
function padded(x: number, z: number, d: number, h: number) {
  if (d < 0.5) return h;
  for (const p of PADS) {
    const dx = x - p.x;
    const dz = z - p.z;
    const u = Math.max(0, Math.abs(dx * p.shore[0] + dz * p.shore[1]) - p.halfU);
    const v = Math.max(0, Math.abs(dx * p.sea[0] + dz * p.sea[1]) - p.halfV);
    const out = Math.hypot(u, v);
    if (out >= PAD_BLEND) continue;
    const t = out / PAD_BLEND;
    const k = 1 - t * t * (3 - 2 * t);
    h += (p.y - h) * k;
  }
  return h;
}

/** How far the beach's top edge stays from a road's edge (or the railway's). */
export const ROAD_CLEAR = 6;
/** The deepest the beach is cut back from the old shore. */
const MAX_DEPTH = 150;
/** How far the waterline sits out beyond the old shore: the beach builds a little out. */
const OUT = 10;
/** The shelf beyond the waterline, and how deep its outer edge is. */
const SHELF = 32;
const SHELF_DEPTH = 2.6;
/** Then down to the seabed over this much more. */
const TOE = 22;

export interface BeachColumn {
  /** The old shore point, world (x, z). */
  shore: [number, number];
  /** Unit inward normal, world. */
  inward: [number, number];
  /** Distance from the beach's top edge to the old shore. */
  depth: number;
  /** How far the waterline is beyond the old shore. */
  out: number;
  /** Where along the stretch, 0..1 — for tapering dressing near the ends. */
  t: number;
}

/**
 * The profile's height at `d` metres seaward of a column's top edge.
 *
 * One fall from the crown to the sea across the whole beach, with no dune
 * bank: the user found the bank's 1:4 too steep. It is eased — `t^1.3` —
 * so the top leaves the grass almost flat and the beach steepens only a little
 * toward the water, the way a backshore runs into a foreshore. At full depth
 * that is about 1:12 to 1:18.
 */
export function beachHeight(d: number, depth: number, out: number): number {
  const crown = STATION_SITE?.ground ?? TRAIN.seaLevel + 6.8;
  const sea = TRAIN.seaLevel;
  const land = depth + out;
  if (d <= 0) return crown;
  if (d < land) return crown - (crown - sea) * (d / Math.max(1e-3, land)) ** 1.3;
  if (d < land + SHELF) return sea - SHELF_DEPTH * ((d - land) / SHELF);
  const k = Math.min(1, (d - land - SHELF) / TOE);
  return sea - SHELF_DEPTH + (TRAIN.seabed - 0.5 - (sea - SHELF_DEPTH)) * k;
}

/** Profile samples, metres seaward of the top edge: the beach finely, then the shelf. */
export function profileSamples(depth: number, out: number): number[] {
  const land = depth + out;
  const s: number[] = [];
  for (let k = 0; k <= 20; k++) s.push((land * k) / 20);
  for (let k = 1; k <= 6; k++) s.push(land + (SHELF * k) / 6);
  s.push(land + SHELF + TOE);
  return s;
}

/* -------------------------------------------------------------- the stretch */

const host = TRAIN_ISLANDS.find((i) => i.name === STATION_ISLAND) ?? null;
const HALF = ROAD_WIDTH / 2;

/** Road centrelines in the station frame, as segments, for the set-back. */
function roadSegments(): Array<[[number, number], [number, number]]> {
  if (!KESTREL_ROADS_ENABLED) return [];
  const out: Array<[[number, number], [number, number]]> = [];
  for (const r of KESTREL_RUNS) out.push([[r.from[0], r.from[1]], [r.to[0], r.to[1]]]);
  for (const n of KESTREL_NODES) out.push([[n.across, n.along], [n.across, n.along]]);
  const poly = (p: Array<[number, number]>) => { for (let i = 0; i + 1 < p.length; i++) out.push([p[i], p[i + 1]]); };
  for (const s of KESTREL_SWEEPS) poly(sweepPoints(s));
  for (const a of KESTREL_ARCS) poly(kestrelArcPoints(a));
  return out;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
}

/** Where the stretch starts and ends, in the station frame (across, along). */
const START: [number, number] = [25, 345];
const END: [number, number] = [285, 100];

function buildBeach() {
  if (!host || !STATION_SITE) return null;
  const outline = host.outline;
  const n = outline.length;
  const frame = outline.map(([x, z]) => {
    const [along, across] = stationFrameOf(x, z);
    return [across, along] as [number, number];
  });
  const nearest = (p: [number, number]) => {
    let best = 0;
    let bestD = Infinity;
    frame.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const i0 = nearest(START);
  const i1 = nearest(END);
  // Walk whichever way round leaves the start heading north (across rising).
  const step = frame[(i0 + 1) % n][0] > frame[i0][0] ? 1 : -1;
  const indices: number[] = [];
  for (let i = i0; ; i = (i + step + n) % n) {
    indices.push(i);
    if (i === i1 || indices.length > n) break;
  }

  // Inward normals, from the two neighbouring edges, checked against the inside.
  const inside = (x: number, z: number) => {
    let hit = false;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const [xa, za] = outline[a];
      const [xb, zb] = outline[b];
      if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) hit = !hit;
    }
    return hit;
  };
  const inwardAt = (i: number): [number, number] => {
    const [px, pz] = outline[(i - 1 + n) % n];
    const [qx, qz] = outline[(i + 1) % n];
    let nx = -(qz - pz);
    let nz = qx - px;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    const [x, z] = outline[i];
    if (!inside(x + nx * 2, z + nz * 2)) { nx = -nx; nz = -nz; }
    return [nx, nz];
  };

  // How deep the beach may cut in at each column: march inward until a road
  // (or the railway) is within ROAD_CLEAR of its edge.
  const roads = roadSegments();
  const raw = indices.map((i) => {
    const [x, z] = outline[i];
    const [nx, nz] = inwardAt(i);
    let depth = 0;
    for (let d = 1; d <= MAX_DEPTH; d += 1) {
      const [along, across] = stationFrameOf(x + nx * d, z + nz * d);
      const p: [number, number] = [across, along];
      const nearRoad = roads.some(([a, b]) => distToSegment(p, a, b) < HALF + ROAD_CLEAR);
      const tracks = stationTracksInFrame(along);
      const nearRail = tracks.some((t) => Math.abs(t - across) < ROAD_CLEAR + 4) && along < 420;
      if (nearRoad || nearRail) break;
      depth = d;
    }
    return { i, inward: [nx, nz] as [number, number], depth };
  });

  // Smooth the depth along the shore, then taper both ends to nothing.
  const m = raw.length;
  const smooth = raw.map((_, k) => {
    let sum = 0;
    let w = 0;
    for (let j = -4; j <= 4; j++) {
      const q = raw[Math.max(0, Math.min(m - 1, k + j))];
      const wt = 5 - Math.abs(j);
      sum += q.depth * wt;
      w += wt;
    }
    // Never deeper than the road allows here, whatever the neighbours say.
    return Math.min(raw[k].depth, sum / w);
  });
  // Short at the bridge end, so the beach runs nearly to its 50 m mark; longer
  // at the west end, where it fades into the north shore's wall.
  const startEnds = 5;
  const endEnds = 8;
  const columns: BeachColumn[] = raw.map((c, k) => {
    const taper = Math.min(1, k / startEnds, (m - 1 - k) / endEnds);
    const ease = taper * taper * (3 - 2 * taper);
    return {
      shore: [outline[c.i][0], outline[c.i][1]],
      inward: c.inward,
      depth: smooth[k] * ease,
      out: OUT * ease,
      t: k / Math.max(1, m - 1),
    };
  });

  // The outline the crown and the wall are drawn from: the stretch pulled back
  // to the beach's top edge.
  const pulled = outline.map(([x, z]) => [x, z] as [number, number]);
  const noWall = new Set<number>();
  raw.forEach((c, k) => {
    const col = columns[k];
    pulled[c.i] = [col.shore[0] + col.inward[0] * col.depth, col.shore[1] + col.inward[1] * col.depth];
    // Interior columns carry no wall: the beach is the edge there.
    if (k > 0 && k < m - 1) noWall.add(c.i);
  });
  return { columns, outline: pulled, noWall, island: host.name };
}

export const BEACH = buildBeach();
export const BEACH_ENABLED = BEACH !== null && BEACH.columns.length > 3;

/** The station island's outline as the crown and the wall should draw it. */
export const BEACH_OUTLINE: ReadonlyArray<readonly [number, number]> | null = BEACH?.outline ?? null;
/** Outline points along the beach, between which no sea wall is drawn. */
export const BEACH_NO_WALL: ReadonlySet<number> = BEACH?.noWall ?? new Set();

/** World point of a column `d` metres seaward of its top edge, and its height. */
export function beachPoint(c: BeachColumn, d: number): [number, number, number] {
  const back = c.depth - d;
  const x = c.shore[0] + c.inward[0] * back;
  const z = c.shore[1] + c.inward[1] * back;
  return [x, padded(x, z, d, beachHeight(d, c.depth, c.out)), z];
}

/** The same, on the beach as it falls naturally — ignoring the levelled pads. */
function naturalPoint(c: BeachColumn, d: number): [number, number, number] {
  const back = c.depth - d;
  return [c.shore[0] + c.inward[0] * back, beachHeight(d, c.depth, c.out), c.shore[1] + c.inward[1] * back];
}

/* ------------------------------------------------------------------- grip */

/** Grip on dry and wet sand, and in the water off it, as a fraction of tarmac's. */
export const SAND_GRIP = 0.62;
export const SURF_GRIP = 0.4;

const BOX = (() => {
  if (!BEACH) return null;
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const c of BEACH.columns) {
    for (const d of [-5, c.depth + c.out + 60]) {
      const x = c.shore[0] + c.inward[0] * (c.depth - d);
      const z = c.shore[1] + c.inward[1] * (c.depth - d);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
  }
  return { x0, x1, z0, z1 };
})();

/**
 * Grip at a world point on the beach, or null when it is not on the beach.
 *
 * Nearest column, then how far seaward of that column's top edge the point
 * is: the grassy top few metres grip like grass (null — the world decides),
 * sand gives `SAND_GRIP`, and once the water is more than half a metre deep,
 * `SURF_GRIP`. Called per wheel per physics step, so a bounding box first.
 */
export function beachGrip(x: number, z: number): number | null {
  if (!BEACH || !BOX || x < BOX.x0 || x > BOX.x1 || z < BOX.z0 || z > BOX.z1) return null;
  let best: BeachColumn | null = null;
  let bestD = Infinity;
  for (const c of BEACH.columns) {
    const d = (c.shore[0] - x) ** 2 + (c.shore[1] - z) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best || best.depth < 3) return null;
  // Seaward distance from the top edge, along the column's own normal.
  const inland = (x - best.shore[0]) * best.inward[0] + (z - best.shore[1]) * best.inward[1];
  const d = best.depth - inland;
  const land = best.depth + best.out;
  // The top few metres are still mostly grass (KestrelBeach fades it out over ~16 m).
  if (d < 5 || d > land + SHELF + TOE) return null;
  return beachHeight(d, best.depth, best.out) < TRAIN.seaLevel - 0.5 ? SURF_GRIP : SAND_GRIP;
}

/**
 * The beach's ground height at a world point, or null off the beach. The same
 * nearest-column lookup as `beachGrip`; used to stand props, the volleyball
 * court and the quads on the sand wherever they fall between columns.
 */
export function beachGroundAt(x: number, z: number): number | null {
  if (!BEACH || !BOX || x < BOX.x0 || x > BOX.x1 || z < BOX.z0 || z > BOX.z1) return null;
  let best: BeachColumn | null = null;
  let bestD = Infinity;
  for (const c of BEACH.columns) {
    const d = (c.shore[0] - x) ** 2 + (c.shore[1] - z) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return null;
  const inland = (x - best.shore[0]) * best.inward[0] + (z - best.shore[1]) * best.inward[1];
  const d = best.depth - inland;
  return padded(x, z, d, beachHeight(d, best.depth, best.out));
}

/* ------------------------------------------------------------ volleyball */

/**
 * The beach volleyball court: on the north shore where the beach is widest,
 * halfway down the sand, its long side along the shore so it lies across the
 * slope's gentle direction. 16 × 8 m inside blue tape, the net across the
 * middle at men's height (2.43 m) on two posts.
 */
export const VOLLEYBALL = { column: 44, d: 46, length: 16, width: 8, netTop: 2.43, netDepth: 1, postOut: 0.75 } as const;

/**
 * The court's frame in world space: its centre on the sand, unit vectors
 * along the shore (`shore`, the court's length) and seaward (`sea`), and a
 * point at (a, b) metres along those.
 */
export function volleyballCourt() {
  const c = BEACH?.columns[VOLLEYBALL.column];
  if (!c) return null;
  const [x, y, z] = beachPoint(c, VOLLEYBALL.d);
  const sea: [number, number] = [-c.inward[0], -c.inward[1]];
  const shore: [number, number] = [sea[1], -sea[0]];
  const at = (a: number, b: number): [number, number] => [x + shore[0] * a + sea[0] * b, z + shore[1] * a + sea[1] * b];
  return { x, y, z, sea, shore, at };
}

/* ------------------------------------------------------------ food courts */

/**
 * Kestrel Beach's food courts: two of the city's own, cut out and stood on
 * the beach (`KestrelFoodCourts`, `cityCrop`). The city has a timber eating
 * deck with picnic tables and a kiosk on its west side, and a food market —
 * stalls round a paved square — north of it; both come here.
 *
 *  - **The deck** stands on the grass at the island's west tip (station
 *    frame along 98, across 222): the strip between the road and the beach,
 *    about 25 × 120 m now the market and lodge have moved off its north end,
 *    which takes the whole 120 × 19 m deck lengthways. The user's spot,
 *    `?at=-915,-962`.
 *  - **The market** is trimmed to its four stalls — no square, benches or
 *    trees — and **the lodge**, the city's brick lodge from by the pontoons,
 *    stand together on the empty grass of the island's east nose, between the
 *    road and the coast where the beach begins (`?at=-719,-767`), north of
 *    the railway (whose tracks run along across 0 and 4.6 here): the market
 *    at along 294, across 32, the lodge north of it at along 285, across 65,
 *    each with its length along the coast.
 *
 * `box` is the piece of the city, in city coordinates. A beach site lands
 * centred on `column`, `d` metres down the sand, its city x along the shore
 * and its city z seaward; sand slopes and stalls do not, so it sits on a
 * levelled pad of beach (`padded`), cut and filled to the height the beach has
 * under its middle and blended back to the natural fall over `PAD_BLEND`. A
 * grass site (`frame`) lands at that station-frame point on the crown, its
 * city x along `across` (or `along`, with `xAlong`).
 */
type FoodCourt = {
  name: string;
  box: CropBox;
} & ({ column: number; d: number } | { frame: { along: number; across: number; xAlong?: boolean } });

/** A box of the city to cut (`cityCrop`'s, repeated here so config does not import a component). */
interface CropBox {
  x0: number; x1: number; z0: number; z1: number; floor: number; top: number;
  parts?: ReadonlyArray<readonly [number, number, number, number]>;
  ground?: boolean;
}

export const FOOD_COURTS: readonly FoodCourt[] = [
  // The whole deck, end to end as the city has it: 120 m of tables, the
  // kiosk and the green arch. It takes the full length of the west grass
  // strip, from the road at across 160 to the top of the beach at 284.
  { name: 'deck', box: { x0: -1330, x1: -1210, z0: -212, z1: -193, floor: 0, top: 9 }, frame: { along: 98, across: 222 } },
  {
    name: 'market',
    box: {
      x0: -1291, x1: -1250, z0: -54, z1: -20, floor: 0, top: 9, ground: false,
      // The row of three stalls, and the one standing out in front of it.
      parts: [[-1291, -1250, -31, -20], [-1277, -1262, -54, -44]],
    },
    frame: { along: 294, across: 32, xAlong: true },
  },
  {
    /*
     * The lodge: the city's dark-roofed brick lodge by the floating pontoons
     * under the railway viaduct (`?at=-1245,829`), with the palms in its
     * planters — not the viaduct's piers, the pontoons or the car park round
     * it. It stands at street level down there (y −2.95). Here it is on the
     * east nose's grass just north of the market, its length along the coast.
     */
    name: 'lodge',
    box: { x0: -1273, x1: -1254.5, z0: 812.5, z1: 839.5, floor: -2.95, top: 8 },
    frame: { along: 285, across: 65 },
  },
];

/** How far a pad's level blends back into the slope round it, metres. */
const PAD_BLEND = 10;

export interface FoodCourtSite {
  name: string;
  box: FoodCourt['box'];
  /** On the beach (on a levelled pad), or on the grass. */
  beach: boolean;
  /** World centre, the pad's level, and the turn that lays city x along the shore. */
  x: number; z: number; y: number; heading: number;
  shore: [number, number]; sea: [number, number];
  halfU: number; halfV: number;
}

export const FOOD_COURT_SITES: readonly FoodCourtSite[] = (() => {
  if (!BEACH) return [];
  return FOOD_COURTS.flatMap((f): FoodCourtSite[] => {
    const halfU = (f.box.x1 - f.box.x0) / 2 + 1;
    const halfV = (f.box.z1 - f.box.z0) / 2 + 1;
    if ('frame' in f) {
      // On the crown: city x along the frame's across, z along its along.
      if (!STATION_SITE) return [];
      const [x, , z] = stationPoint(f.frame.along, f.frame.across);
      const [ax, , az] = f.frame.xAlong
        ? stationPoint(f.frame.along + 1, f.frame.across)
        : stationPoint(f.frame.along, f.frame.across + 1);
      const shore: [number, number] = [ax - x, az - z];
      const sea: [number, number] = [-shore[1], shore[0]];
      return [{
        name: f.name, box: f.box, beach: false, x, z, y: STATION_SITE.ground, heading: Math.atan2(sea[0], sea[1]),
        shore, sea, halfU, halfV,
      }];
    }
    const c = BEACH.columns[f.column];
    if (!c) return [];
    const [x, y, z] = naturalPoint(c, f.d);
    const sea: [number, number] = [-c.inward[0], -c.inward[1]];
    const shore: [number, number] = [sea[1], -sea[0]];
    return [{ name: f.name, box: f.box, beach: true, x, z, y, heading: Math.atan2(sea[0], sea[1]), shore, sea, halfU, halfV }];
  });
})();
PADS.push(...FOOD_COURT_SITES.filter((f) => f.beach));

/** Whether a world point is on a food court, grown by `margin`. */
export function onFoodCourt(x: number, z: number, margin = 0) {
  return FOOD_COURT_SITES.some((p) => {
    const dx = x - p.x;
    const dz = z - p.z;
    return Math.abs(dx * p.shore[0] + dz * p.shore[1]) < p.halfU + margin
      && Math.abs(dx * p.sea[0] + dz * p.sea[1]) < p.halfV + margin;
  });
}

/* ------------------------------------------------------------------ stage */

/**
 * The beach stage (`KestrelStage`): the user's `stage_4.glb` on the sand at
 * the beach's west end, `?at=-853,-966` — between the food deck and the
 * cruise terminal, where the beach is wide and open. Its back is to the sea
 * and its front faces inland up the beach, so an audience stands on the sand
 * with the deck behind them. It sits on a levelled pad like the food courts.
 *
 * `half` is the pad's half-size (along the stage's width, and its depth),
 * taking in the truss towers and the speaker stacks either side.
 */
const STAGE_AT: [number, number] = [-853, -966];
const STAGE_HALF: [number, number] = [14, 7];

export const BEACH_STAGE = (() => {
  if (!BEACH) return null;
  const [x, z] = STAGE_AT;
  // Inland is the nearest column's inward normal.
  let best = BEACH.columns[0];
  let bestD = Infinity;
  for (const c of BEACH.columns) {
    const d = (c.shore[0] - x) ** 2 + (c.shore[1] - z) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  const front: [number, number] = [best.inward[0], best.inward[1]];
  const y = beachGroundAt(x, z) ?? TRAIN.seaLevel;
  // Local +z (the stage's front) inland; local +x along the shore.
  const heading = Math.atan2(front[0], front[1]);
  const across: [number, number] = [front[1], -front[0]];
  return { x, z, y, heading, front, across, halfU: STAGE_HALF[0], halfV: STAGE_HALF[1] };
})();
if (BEACH_STAGE) {
  PADS.push({
    x: BEACH_STAGE.x, z: BEACH_STAGE.z, y: BEACH_STAGE.y, shore: BEACH_STAGE.across, sea: BEACH_STAGE.front,
    halfU: BEACH_STAGE.halfU, halfV: BEACH_STAGE.halfV,
  });
}

/** Whether a world point is on the stage's pad, grown by `margin`. */
export function onStage(x: number, z: number, margin = 0) {
  if (!BEACH_STAGE) return false;
  const dx = x - BEACH_STAGE.x;
  const dz = z - BEACH_STAGE.z;
  return Math.abs(dx * BEACH_STAGE.across[0] + dz * BEACH_STAGE.across[1]) < BEACH_STAGE.halfU + margin
    && Math.abs(dx * BEACH_STAGE.front[0] + dz * BEACH_STAGE.front[1]) < BEACH_STAGE.halfV + margin;
}

/** A spot in the audience: on the sand in front of the stage, facing it. */
export function audienceSpot(rnd: () => number = Math.random) {
  if (!BEACH_STAGE) return null;
  const s = BEACH_STAGE;
  const out = s.halfV + 3 + rnd() * 16;
  const side = (rnd() - 0.5) * 2 * (6 + out * 0.4);
  const x = s.x + s.front[0] * out + s.across[0] * side;
  const z = s.z + s.front[1] * out + s.across[1] * side;
  // Facing the stage, a little either way.
  return { x, z, face: Math.atan2(-s.front[0], -s.front[1]) + (rnd() - 0.5) * 0.5 };
}
