import { TRAIN, TRAIN_ISLANDS } from './trainConfig';
import { STATION_ISLAND, STATION_SITE, stationFrameOf, stationTracksInFrame } from './stationConfig';
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
