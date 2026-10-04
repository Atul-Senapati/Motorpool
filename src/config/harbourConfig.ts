import { ROAD_TOP, ROAD_WIDTH } from './roadConfig';
import { SITE, shoreAt } from './airportConfig';
import { trunkCentre } from './islandRailConfig';
import { TRAIN } from './trainConfig';
import hallData from './factoryHallData.json';
import shedData from './factoryShedData.json';
import depotData from './factoryDepotData.json';
import blockData from './factoryBlockData.json';

/**
 * Halcyon Harbour: the port and works on the coast side of Halcyon Junction.
 *
 * Everything here is in the airport island's frame (x along the line, z across
 * it, +z toward the sea — world east) and drawn inside `IslandRail`.
 *
 * ## The plan, west to east
 *
 * - **Way in.** The outer road's west junction becomes a crossroads; its new
 *   north arm runs straight up over the trunk on a level crossing with barriers
 *   (`HARBOUR_CROSSING`) — the only place the double track can be crossed
 *   without four station roads in the way — and becomes the harbour road. The
 *   crossing is skewed, so its crest is shaped off the tracks (`roadHeightAt`).
 * - **The harbour road** (`HARBOUR_ROAD`) runs the whole strip beside the
 *   railway, built from the road kit's own surface swept along a smooth line,
 *   and ends in a turning circle at the east end. Everything opens off its
 *   seaward side.
 * - **The container terminal** at the wide west end: a new quay built out
 *   into the sea (the island extended — `QUAY`), three dock cranes on rails,
 *   stacks in blocks with gantry cranes over them, a gate and an office.
 * - **The works** at the east end: the production hall, a tank farm and a
 *   water tower either side of it (`PLANT`), the harbour office and a seafront
 *   walk between.
 *
 * And the cargo ship that used to circle out in the deep water now berths
 * here, sailing straight out and coming straight back (`HARBOUR_SHIP`).
 */

export interface FactoryModel { model: string; size: [number, number, number]; triangles: number }
const model = (d: { model: string; size: number[]; triangles: number }): FactoryModel => ({
  model: d.model, size: d.size as [number, number, number], triangles: d.triangles,
});
export const HARBOUR_MODELS = {
  factoryHall: model(hallData),
  factoryShed: model(shedData),
  factoryDepot: model(depotData),
  factoryBlock: model(blockData),
} as const;
export type HarbourBuilding = keyof typeof HARBOUR_MODELS;

/** Paved ground's top, as everywhere on the island: the road kit's slab height. */
export const PAVE = 0.06;
export const ROAD_HALF = ROAD_WIDTH / 2;

/* ------------------------------------------------------------- the road */

export interface RoadSample { x: number; z: number; y: number; nx: number; nz: number; arc: number }

/**
 * The harbour road's centreline, as the points it is swept through.
 *
 * Not typed by eye: every point was set against the outermost track's centre
 * (plus the ballast toe and a verge) on one side and the sea wall on the
 * other, measured every ten metres. The tightest spot is behind platform 4,
 * where the road has 2 m to the platform's back and 3.5 m to the sea wall.
 */
const ROAD_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-395, 268.5], // the crossroads' north mouth
  [-395, 300], [-395, 326], // straight over the railway
  [-391, 342], [-381, 355], [-366, 364], [-350, 367],
  [-300, 367], [-250, 367],
  [-200, 373.5], [-150, 380],
  [-100, 380], [0, 380], [65, 380],
  [100, 375.5], [150, 368],
  [200, 366], [260, 366], [300, 368],
];

/** The turning circle the road ends in, and its radius to the kerb. */
export const TURNING = { x: 300, z: 368, radius: 17 } as const;

/** Centripetal Catmull-Rom through the points, resampled every `step` metres. */
function sweep(points: ReadonlyArray<readonly [number, number]>, step: number): Array<[number, number]> {
  const P = points.map(([x, z]) => [x, z] as [number, number]);
  const dense: Array<[number, number]> = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    const d = (a: number[], b: number[]) => Math.max(1e-3, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
    const t0 = 0;
    const t1 = t0 + d(p0, p1);
    const t2 = t1 + d(p1, p2);
    const t3 = t2 + d(p2, p3);
    const n = 40;
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const lerp = (a: number[], b: number[], ta: number, tb: number) => {
        const w = tb === ta ? 0 : (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const a1 = lerp(p0, p1, t0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      const c = lerp(b1, b2, t1, t2);
      dense.push([c[0], c[1]]);
    }
  }
  dense.push(P[P.length - 1]);
  // Resample evenly.
  const out: Array<[number, number]> = [dense[0]];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    const [ax, az] = dense[i - 1];
    const [bx, bz] = dense[i];
    const len = Math.hypot(bx - ax, bz - az);
    let at = step - carry;
    while (at <= len) {
      out.push([ax + ((bx - ax) * at) / len, az + ((bz - az) * at) / len]);
      at += step;
    }
    carry = len - (at - step);
  }
  const last = dense[dense.length - 1];
  if (Math.hypot(last[0] - out[out.length - 1][0], last[1] - out[out.length - 1][1]) > step * 0.3) out.push(last);
  return out;
}

/** The rail head over the island's crown, where the trunk is on the level. */
export const RAIL_TOP = TRAIN.ballastDepth + TRAIN.sleeperHeight + TRAIN.railHeight;

/**
 * The level crossing: where the road meets the trunk's centreline, how
 * skewed it is, and the band of road that stands at rail height.
 *
 * Found, not placed: the crossing is wherever the swept road actually cuts the
 * trunk. `trunkArc` is the trunk's own arc there, which is how the barriers
 * find the trains (`BRANCH_ROUTE`).
 */
export const HARBOUR_CROSSING = (() => {
  const road = sweep(ROAD_POINTS, 1);
  const trunk = trunkCentre();
  let best = { d: Infinity, i: 0, j: 0 };
  for (let i = 0; i < road.length; i++) {
    for (let j = 0; j < trunk.length; j++) {
      const d = Math.hypot(road[i][0] - trunk[j].x, road[i][1] - trunk[j].z);
      if (d < best.d) best = { d, i, j };
    }
  }
  const [x, z] = road[best.i];
  const t = trunk[best.j];
  const prev = road[Math.max(0, best.i - 2)];
  const next = road[Math.min(road.length - 1, best.i + 2)];
  const dir = Math.atan2(next[1] - prev[1], next[0] - prev[0]);
  // The trunk's left normal is (nx, nz); the road's direction against it.
  const cos = Math.abs(Math.cos(dir) * t.nx + Math.sin(dir) * t.nz);
  /** Sleeper ends of the outer road plus a little, either side of the centre, square to the line. */
  const halfTracks = TRAIN.elevated.trackGap / 2 + 1.3 + 0.9;
  return {
    x, z, trunkArc: t.arc, roadIndex: best.i,
    /** Trunk tangent, so the barriers can stand square to it. */
    tx: -t.nz, tz: t.nx,
    skew: Math.acos(Math.min(1, cos)),
    /** Half the length of road held at rail height, measured along the road. */
    deckHalf: halfTracks / Math.max(0.5, cos),
    ramp: 10,
  };
})();

/**
 * How high the road stands at any point near the crossing.
 *
 * Measured from the TRACKS, not along the road. The crossing is skewed, so a
 * hump shaped along the road leaves its corners at grass level while the rails
 * run under them — the rails were buried in the ramps at the road's edges.
 * Here the crest runs parallel to the rails, the whole width of the road is at
 * rail height wherever a rail crosses it, and the ramps fall away square to
 * the line.
 */
const NEAR_TRUNK = trunkCentre().filter((q) => Math.hypot(q.x - HARBOUR_CROSSING.x, q.z - HARBOUR_CROSSING.z) < 80);
/** Perpendicular distance from the trunk's centreline, against its local samples. */
export function trunkDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < NEAR_TRUNK.length; i++) {
    const a = NEAR_TRUNK[i];
    const b = NEAR_TRUNK[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const l2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
    best = Math.min(best, Math.hypot(x - a.x - vx * t, z - a.z - vz * t));
  }
  return best;
}
/** Half the band of road held at rail height, square to the line. */
export const CROSSING_BAND = TRAIN.elevated.trackGap / 2 + 1.3 + 0.9;
export const CROSSING_TOP = RAIL_TOP - 0.025;
export function roadHeightAt(x: number, z: number): number {
  const d = trunkDistance(x, z);
  if (d <= CROSSING_BAND) return CROSSING_TOP;
  if (d >= CROSSING_BAND + HARBOUR_CROSSING.ramp) return ROAD_TOP;
  const f = (d - CROSSING_BAND) / HARBOUR_CROSSING.ramp;
  return CROSSING_TOP + (ROAD_TOP - CROSSING_TOP) * f * f * (3 - 2 * f);
}

/** The road's samples, every 2 m. Heights come from `roadHeightAt`, per vertex. */
export const HARBOUR_ROAD: RoadSample[] = (() => {
  const pts = sweep(ROAD_POINTS, 2);
  const out: RoadSample[] = [];
  let arc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) arc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // Left normal of the direction of travel.
    out.push({ x: pts[i][0], z: pts[i][1], y: roadHeightAt(pts[i][0], pts[i][1]), nx: -(b[1] - a[1]) / l, nz: (b[0] - a[0]) / l, arc });
  }
  return out;
})();

/** The road's centreline z at `x`, for anything laid out against its kerb. */
export function roadZAt(x: number): number {
  let best = HARBOUR_ROAD[0];
  for (const s of HARBOUR_ROAD) {
    if (s.z < 330) continue;
    if (Math.abs(s.x - x) < Math.abs(best.x - x)) best = s;
  }
  return best.z;
}
/** The seaward kerb at `x`. */
export const kerbAt = (x: number) => roadZAt(x) + ROAD_HALF;

/* ----------------------------------------------------- the container terminal */

/**
 * The quay and the terminal behind it, as one paved slab.
 *
 * Built OUT from the sea wall, which is the island extended: the shore here
 * wanders between z 434 and 460 and a berth needs a straight face, so the
 * slab runs to a dead straight edge at `face` and down to the seabed, the same
 * concrete revetment the rest of the island stands behind.
 */
export const QUAY = { x0: -326, x1: -102, z0: 392, face: 466, seabed: -9 } as const;

/** The berth: where the ship's centre stops, and which way it lies (bow to −x). */
export const BERTH = { x: -220, z: QUAY.face + 1.5 + 11.4, fender: 1.5 } as const;

/** The dock cranes' rails, seaward and landward, and where each crane stands. */
export const DOCK_CRANES = {
  rails: [QUAY.face - 2.5, QUAY.face - 10.7] as const,
  /** Origin of the model, turned a quarter so its jib reaches over the ship. */
  originZ: QUAY.face - 1.6,
  at: [-262, -218, -174],
  /** How far each one travels along its rails while a ship is in. */
  travel: 9,
};

/** One stack block: rows across z, 40 ft bays along x. */
export interface Block { x0: number; x1: number; z0: number; rows: number }
export const CONTAINER = { length: 12.19, short: 6.06, width: 2.44, height: 2.59, rowPitch: 2.74, bayPitch: 12.8 } as const;

/**
 * The terminal is laid out to be DRIVEN, not just looked at:
 *
 * - an internal road just inside the landward fence, two lanes, `YARD_ROAD`;
 * - ONE line of stack blocks behind it, with 14 m cross lanes between the
 *   blocks and wide ends, each block with its own gantry that never leaves it;
 * - a 28 m apron between the stacks and the crane rails, clear the whole
 *   length of the quay;
 * - a staff car park and lorry bays at the two ends.
 *
 * So from the gate you can drive round the stacks, down any cross lane, along
 * the quay under the cranes and back, without a moving gantry leg or a parked
 * lorry in the way.
 */
export const YARD_ROAD = { z0: QUAY.z0 + 1, z1: QUAY.z0 + 10 } as const;
const STACK_Z0 = 409;
const ROWS = 5;
export const TERMINAL_BLOCKS: Block[] = [
  { x0: -306, x1: -254.8, z0: STACK_Z0, rows: ROWS },
  { x0: -240, x1: -188.8, z0: STACK_Z0, rows: ROWS },
  { x0: -174, x1: -122.8, z0: STACK_Z0, rows: ROWS },
];
/** The apron's landward edge: the far side of the gantries' legs. */
export const APRON_Z0 = STACK_Z0 + ROWS * CONTAINER.rowPitch + 4.5;

/** One gantry per block, straddling it, travelling only over its own block. */
export const GANTRIES = TERMINAL_BLOCKS.map((b, i) => ({
  z: b.z0 + (b.rows * CONTAINER.rowPitch) / 2,
  from: b.x0 + 4.7,
  to: b.x1 - 4.7,
  phase: i * 0.37,
}));

/** Where the terminal opens off the road: on the first cross lane's axis. */
export const TERMINAL_GATE = { x: (TERMINAL_BLOCKS[0].x1 + TERMINAL_BLOCKS[1].x0) / 2, width: 14 } as const;

/** Staff car park at the east end, lorry bays at the west. Bays across z. */
export const CAR_PARK = { x0: -120, x1: -104, z0: YARD_ROAD.z1 + 2, z1: APRON_Z0 - 2, bay: 2.6, depth: 5.2 } as const;
export const LORRY_BAYS = { x0: -324, x1: -308, z0: YARD_ROAD.z1 + 2, z1: APRON_Z0 - 2, bay: 4, depth: 16 } as const;

/* ------------------------------------------------------------ buildings */

export interface PlacedBuilding { name: HarbourBuilding; x: number; z: number; turn: number; label: string }

export const HARBOUR_BUILDINGS: PlacedBuilding[] = [
  // The transit shed, in the crook of the road's turn, doors to the road.
  { name: 'factoryShed', x: -355, z: 390, turn: 0, label: 'transit shed' },
  // The harbour and terminal office, just past the terminal's east fence.
  { name: 'factoryBlock', x: -84, z: 401, turn: Math.PI, label: 'harbour office' },
  // The production hall: chimney and offices at its west end.
  { name: 'factoryHall', x: 198, z: 397.5, turn: 0, label: 'works' },
];

/**
 * Plant out of the Skylark works (`country.glb`) where the empties depots
 * were: a tank farm with silos and a transformer beside the works' west end,
 * and a water tower and a silo past its east end. Each on its own paved pad
 * (`PLANT_PADS`), set against the kerb and the sea wall by measurement.
 */
export const PLANT: Array<{ part: string; x: number; z: number; turn: number }> = [
  { part: 'indTransformer', x: 77, z: 396, turn: 0 },
  { part: 'indSilo', x: 88, z: 399.5, turn: 0 },
  { part: 'indSilo2', x: 93.5, z: 399.5, turn: 1.1 },
  { part: 'indSilo', x: 99, z: 399.5, turn: 2.3 },
  { part: 'indTank', x: 113, z: 404, turn: 0 },
  { part: 'indWatertower', x: 277, z: 396, turn: 0.4 },
  { part: 'indSilo2', x: 289, z: 393.5, turn: 0 },
];
export const PLANT_PADS: Array<{ x0: number; x1: number; z0: number; z1: number }> = [
  { x0: 70, x1: 124, z0: 391, z1: 422 },
  { x0: 270, x1: 294, z0: 389, z1: 404 },
];

/* ------------------------------------------------------------- the ship */

/**
 * The cargo ship's run: straight out and straight back, no loop.
 *
 * It lies at the berth bow-out (bow to the island's −x, world south). When it
 * sails it goes FORWARD along the berth line, out past the island's south end
 * into the open water toward Skylark, stops, and comes BACK astern along the
 * same line into the berth — the one straight line a ship in this channel can
 * use, checked against the islands, the city and both bridges.
 */
export const HARBOUR_SHIP = (() => {
  const toWorld = (x: number, z: number): [number, number] => {
    const c = Math.cos(SITE.heading);
    const s = Math.sin(SITE.heading);
    return [SITE.centre[0] + x * c + z * s, SITE.centre[1] - x * s + z * c];
  };
  const berth = toWorld(BERTH.x, BERTH.z);
  const out = toWorld(BERTH.x - 400, BERTH.z);
  return {
    hull: 'cargo',
    berth,
    out,
    /** Ahead out to sea, and astern back in, m/s; and how hard it gathers and loses way. */
    ahead: 5,
    astern: 3,
    accel: 0.06,
    /** Seconds alongside, and lying off at the far end. */
    dwell: 90,
    lieOff: 30,
  };
})();

/** Shared between the ship and the cranes: whether a ship is alongside now. */
export const harbourLive = { berthed: false };

/** Island-frame shore at `x`, re-exported for the layout. */
export const shoreZAt = (x: number) => shoreAt(x)?.[1] ?? 0;
