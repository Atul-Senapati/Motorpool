import {
  BEACH, BOATHOUSE, BOUNDS, BRIDGE, CAMPSITE, CASTLE_HILL, CHAPEL, CHURCH, CROSSINGS, FORT_CARPARK,
  HAMLET, HARBOUR, HILL_FARM, HOME_FARM, HOUSES, JUNCTIONS, LANE_WIDTH, LIGHTHOUSE, MILL, PADDOCK, PONDS, POULTRY,
  MINE, ROADS, STONE_CIRCLE, SUMMIT, TURBINES, VIEWPOINT, VINEYARD, WATERMILL, WOOD, coastClearance,
  coastRadius, groundAt, inIsland, inMine, lakeFraction, makeRandom, railEdgeAt, reliefAt, roadDistanceAt,
  roadEdgeAt, slopeAt,
  streamDistanceAt, toLocal, type Road,
} from './countryConfig';

/**
 * Skylark's fields, hedges and tracks.
 *
 * ## Fields are a Voronoi diagram
 *
 * Thirty-odd seeds thrown across the island at least 88 m apart, and each
 * field is the ground nearer its seed than any other — which is what a
 * parish looks like from the air: irregular convex patches with no two alike,
 * meeting at three-way corners. Each cell is clipped back to 93% of the coast
 * so a band of rough cliff-top grass runs round the whole island, and a lane
 * simply cuts through whatever cells it crosses — the ground under the
 * carriageway is painted over, and the hedges stop at the verge either side.
 *
 * ## Hedges are the cell edges
 *
 * Every edge of every cell is a hedge, except where it would cross a lane, a
 * yard, the lake or the wood, and up on the downs, where the boundaries are
 * dry-stone walls instead. Both sides of every lane carry a hedge of their
 * own with a field gate every hundred-odd metres. All of it is sampled at
 * 2.2 m and handed on as runs of points; `CountryPlanting` sweeps a box along
 * each run.
 *
 * ## What is where
 *
 * The crop is chosen from where the seed fell: wood on Beacon Hill, sheep
 * grass over 26 m, paddocks round the hamlet, rough grazing along the coast,
 * an arable mix nearest Home Farm and a pastoral one elsewhere. The row
 * direction of an arable field is its own long axis, so the drilling follows
 * the shape of the field the way it does.
 */

export type Crop =
  | 'pasture' | 'meadow' | 'wheat' | 'barley' | 'rape' | 'maize' | 'plough' | 'stubble'
  | 'roots' | 'wildflower' | 'downs' | 'rough' | 'wood' | 'water';

export type Pt = [number, number];

export interface Field {
  id: number;
  seed: Pt;
  polygon: Pt[];
  crop: Crop;
  /** Radians: the direction the rows run. */
  rowAngle: number;
  centroid: Pt;
  area: number;
}

/** The coast, as a fraction, that fields stop at. */
export const FIELD_COAST = 0.93;

const SEED_SPACING = 88;

/* ------------------------------------------------------------- zones */

/** Inside Hanger Wood, with the ellipse scaled by `grow`. */
export function inWood(x: number, z: number, grow = 1): boolean {
  const dx = x - WOOD.x;
  const dz = z - WOOD.z;
  const c = Math.cos(WOOD.rot);
  const s = Math.sin(WOOD.rot);
  const u = (dx * c + dz * s) / (WOOD.rx * grow);
  const v = (-dx * s + dz * c) / (WOOD.rz * grow);
  return u * u + v * v < 1;
}

/** Hanger Wood's edge, as a polygon, for the map and the painter. */
export const WOOD_OUTLINE: Pt[] = Array.from({ length: 48 }, (_, i) => {
  const t = (i / 48) * Math.PI * 2;
  const u = WOOD.rx * Math.cos(t);
  const v = WOOD.rz * Math.sin(t);
  const c = Math.cos(WOOD.rot);
  const s = Math.sin(WOOD.rot);
  return [WOOD.x + u * c - v * s, WOOD.z + u * s + v * c];
});

const near = (x: number, z: number, p: { x: number; z: number }, r: number) => (
  Math.hypot(x - p.x, z - p.z) < r
);

/** Inside a turned rectangle, grown by `pad`. */
export function inRect(x: number, z: number, r: { x: number; z: number; w: number; d: number; turn: number }, pad = 0): boolean {
  const dx = x - r.x;
  const dz = z - r.z;
  const c = Math.cos(r.turn);
  const s = Math.sin(r.turn);
  const u = dx * c - dz * s;
  const v = dx * s + dz * c;
  return Math.abs(u) < r.w / 2 + pad && Math.abs(v) < r.d / 2 + pad;
}

/** On the strand: inside the beach's window and within its slope of the sea. */
export function inBeach(x: number, z: number, pad = 0): boolean {
  const raw = Math.atan2(z, x) - BEACH.theta;
  const d = Math.abs(Math.atan2(Math.sin(raw), Math.cos(raw)));
  return d < BEACH.halfAngle + 0.05 && coastClearance(x, z) < BEACH.strand + pad;
}

/** On the hill fort: its ramparts and the ground inside them. */
export const inFort = (x: number, z: number, pad = 0) => near(x, z, CASTLE_HILL, 100 + pad);

/**
 * Ground that something is built on or graded for, which no hedge crosses and
 * no crop is drilled over. `pad` widens every zone.
 */
export function inBuiltZone(x: number, z: number, pad = 0): boolean {
  const [ex, ez] = toLocal(BRIDGE.end[0], BRIDGE.end[1]);
  if (Math.hypot(x - ex, z - ez) < 46 + pad) return true;
  if (near(x, z, HOME_FARM, HOME_FARM.r + pad)) return true;
  if (near(x, z, HILL_FARM, HILL_FARM.r + pad)) return true;
  if (near(x, z, CHURCH, CHURCH.yard + pad)) return true;
  if (near(x, z, MILL, MILL.r + pad)) return true;
  if (near(x, z, VIEWPOINT, VIEWPOINT.r + 3 + pad)) return true;
  if (near(x, z, BOATHOUSE, 16 + pad)) return true;
  if (near(x, z, LIGHTHOUSE, 12 + pad)) return true;
  for (const t of TURBINES) if (near(x, z, t, 10 + pad)) return true;
  for (const p of PONDS) if (near(x, z, p, p.r + 4 + pad)) return true;
  for (const j of Object.values(JUNCTIONS)) if (near(x, z, j, 22 + pad)) return true;
  // The lobe's own places.
  if (near(x, z, HARBOUR, HARBOUR.r + pad)) return true;
  if (inRect(x, z, CAMPSITE, 6 + pad)) return true;
  if (inRect(x, z, VINEYARD, 5 + pad)) return true;
  if (near(x, z, WATERMILL, 14 + pad)) return true;
  if (near(x, z, CHAPEL, 18 + pad)) return true;
  if (near(x, z, SUMMIT, SUMMIT.r + 3 + pad)) return true;
  if (near(x, z, FORT_CARPARK, FORT_CARPARK.r + 3 + pad)) return true;
  if (near(x, z, STONE_CIRCLE, STONE_CIRCLE.r + 6 + pad)) return true;
  for (const c of CROSSINGS) if (near(x, z, c, 14 + pad)) return true;
  for (const h of HOUSES) if (near(x, z, h, 15 + pad)) return true;
  // The paddock, which was NOT in this list: hedges ran across it and trees
  // grew inside the rails, which is not a thing a paddock has in it.
  if (inRect(x, z, PADDOCK, 3 + pad)) return true;
  if (inRect(x, z, POULTRY, 4 + pad)) return true;
  // The quarry: its pit, yard and tip. Nothing is drilled, grazed, hedged or
  // planted on a working.
  if (inMine(x, z, 10 + pad)) return true;
  return false;
}

/** The hamlet's own ground: its green, its gardens, its lanes. */
export const inHamlet = (x: number, z: number, pad = 0) => near(x, z, HAMLET, 96 + pad);

/* --------------------------------------------------------- the cells */

function clipHalfPlane(poly: Pt[], ax: number, az: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const fp = ax * p[0] + az * p[1] - c;
    const fq = ax * q[0] + az * q[1] - c;
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Points every `pitch` along the polygon's edges, corners included. */
function subdivide(poly: Pt[], pitch: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.round(len / pitch));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Pull every point that is past the field coast back onto it, radially. */
function clampToCoast(poly: Pt[]): Pt[] {
  return poly.map(([x, z]) => {
    const theta = Math.atan2(z, x);
    const limit = coastRadius(theta) * FIELD_COAST;
    const r = Math.hypot(x, z);
    if (r <= limit) return [x, z];
    return [(x / r) * limit, (z / r) * limit];
  });
}

function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function centroidOf(poly: Pt[]): Pt {
  let x = 0;
  let z = 0;
  for (const p of poly) { x += p[0]; z += p[1]; }
  return [x / poly.length, z / poly.length];
}

/** The polygon's long axis, from the covariance of its points. */
function longAxis(poly: Pt[]): number {
  const [cx, cz] = centroidOf(poly);
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const [x, z] of poly) {
    sxx += (x - cx) * (x - cx);
    sxz += (x - cx) * (z - cz);
    szz += (z - cz) * (z - cz);
  }
  return 0.5 * Math.atan2(2 * sxz, sxx - szz);
}

export function pointInPolygon(poly: ReadonlyArray<Pt>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const ARABLE_HOME: Array<[Crop, number]> = [
  ['wheat', 0.2], ['barley', 0.14], ['rape', 0.12], ['maize', 0.08], ['plough', 0.12],
  ['stubble', 0.14], ['roots', 0.08], ['pasture', 0.08], ['wildflower', 0.04],
];
const MIXED: Array<[Crop, number]> = [
  ['pasture', 0.3], ['meadow', 0.16], ['wheat', 0.12], ['barley', 0.08], ['rape', 0.06],
  ['stubble', 0.1], ['plough', 0.06], ['maize', 0.05], ['roots', 0.03], ['wildflower', 0.04],
];

function weighted(table: Array<[Crop, number]>, u: number): Crop {
  const total = table.reduce((n, [, w]) => n + w, 0);
  let acc = 0;
  for (const [crop, w] of table) {
    acc += w / total;
    if (u <= acc) return crop;
  }
  return table[table.length - 1][0];
}

function cropFor(seed: Pt, u: number): Crop {
  const [x, z] = seed;
  if (inWood(x, z, 0.9)) return 'wood';
  if (lakeFraction(x, z) < 1.25) return 'water';
  if (reliefAt(x, z) > 26 || inFort(x, z, 30)) return 'downs';
  if (inHamlet(x, z, 10)) return u < 0.7 ? 'pasture' : 'meadow';
  if (coastClearance(x, z) < 75) return u < 0.55 ? 'rough' : 'pasture';
  // The harbour's back: small pastures, not arable.
  if (Math.hypot(x - HARBOUR.x, z - HARBOUR.z) < 150) return u < 0.6 ? 'pasture' : 'meadow';
  // Corn on the hillsides. A field with a real fall to it is the one a
  // parish puts its wheat and barley on — the ground drains, and from below
  // the drill's rows run up the slope and the whole incline reads as worked
  // land rather than as green. `rowAngle` follows the fall line for these
  // (see `FIELDS`), which is what makes the stripes climb.
  if (slopeAt(x, z).grade > 0.1) return u < 0.62 ? 'wheat' : 'barley';
  const home = Math.hypot(x - HOME_FARM.x, z - HOME_FARM.z) < 190;
  return weighted(home ? ARABLE_HOME : MIXED, u);
}

export const FIELDS: readonly Field[] = (() => {
  const rnd = makeRandom(7);
  const seeds: Pt[] = [];
  let tries = 0;
  while (seeds.length < 60 && tries < 6000) {
    tries++;
    const x = BOUNDS.x0 + rnd() * (BOUNDS.x1 - BOUNDS.x0);
    const z = BOUNDS.z0 + rnd() * (BOUNDS.z1 - BOUNDS.z0);
    if (!inIsland(x, z, 45)) continue;
    if (seeds.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < SEED_SPACING)) continue;
    seeds.push([x, z]);
  }
  const box: Pt[] = [[BOUNDS.x0 - 20, BOUNDS.z0 - 20], [BOUNDS.x1 + 20, BOUNDS.z0 - 20], [BOUNDS.x1 + 20, BOUNDS.z1 + 20], [BOUNDS.x0 - 20, BOUNDS.z1 + 20]];
  return seeds.map((seed, id) => {
    let poly = box;
    for (let j = 0; j < seeds.length; j++) {
      if (j === id) continue;
      const other = seeds[j];
      const ax = 2 * (other[0] - seed[0]);
      const az = 2 * (other[1] - seed[1]);
      const c = other[0] * other[0] + other[1] * other[1] - seed[0] * seed[0] - seed[1] * seed[1];
      poly = clipHalfPlane(poly, ax, az, c);
    }
    const polygon = clampToCoast(subdivide(poly, 12));
    return {
      id,
      seed,
      polygon,
      crop: cropFor(seed, rnd()),
      // Up the slope where there is one to climb, down the field's long axis
      // where there is not.
      rowAngle: (() => {
        const slope = slopeAt(seed[0], seed[1]);
        if (slope.grade > 0.1) return slope.fall + (rnd() - 0.5) * 0.12;
        return longAxis(polygon) + (rnd() - 0.5) * 0.3;
      })(),
      centroid: centroidOf(polygon),
      area: polygonArea(polygon),
    };
  });
})();

/** The field under a point, if any. */
export function fieldAt(x: number, z: number): Field | null {
  for (const f of FIELDS) if (pointInPolygon(f.polygon, x, z)) return f;
  return null;
}

/* --------------------------------------------------------- the tracks */

/** Unmetalled farm tracks: painted, not built, and nothing grows on them. */
export const TRACKS: ReadonlyArray<{ pts: Pt[]; label: string }> = (() => {
  const gate: Pt = [
    CASTLE_HILL.x + Math.cos(CASTLE_HILL.gate) * 84, CASTLE_HILL.z + Math.sin(CASTLE_HILL.gate) * 84,
  ];
  return [
    { pts: [[-248, -184], [-268, -150], [-262, -108], [-250, -80]], label: 'Home Farm back track' },
    { pts: [[FORT_CARPARK.x, FORT_CARPARK.z], gate], label: 'fort path' },
    { pts: [[CAMPSITE.x, CAMPSITE.z], [-364, 500], [-376, 524]], label: 'beach path' },
    { pts: [[-378, 296], [-392, 318], [WATERMILL.x + 4, WATERMILL.z - 8]], label: 'watermill track' },
    // Up to the poultry farm from the lane past the paddock's near end.
    { pts: [[-18, -108], [-26, -134], [POULTRY.x + 12, POULTRY.z - 4]], label: 'poultry track' },
  ];
})();

export function nearTrack(x: number, z: number, within: number): boolean {
  for (const t of TRACKS) {
    for (let i = 0; i < t.pts.length - 1; i++) {
      const [ax, az] = t.pts[i];
      const [bx, bz] = t.pts[i + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez || 1;
      const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2));
      if (Math.hypot(x - (ax + ex * u), z - (az + ez * u)) < within) return true;
    }
  }
  return false;
}

/* --------------------------------------------------------- the hedges */

export interface HedgeRun {
  pts: Pt[];
  kind: 'hedge' | 'wall';
}

export interface Gate {
  x: number;
  z: number;
  /** Radians about +Y; the gate's bar runs along local X. */
  turn: number;
}

/** Above this relief the boundaries are walls: the downs are sheep country. */
const WALL_ABOVE = 22;
/** Sampling pitch along every run. */
export const HEDGE_PITCH = 2.2;
/** How far outside the carriageway the lane-side hedge stands. */
export const VERGE = LANE_WIDTH / 2 + 3.2;

function keepBoundary(x: number, z: number): boolean {
  // Off every road's carriageway by the verge a hedge stands back from, and
  // off the railway's formation by its fence.
  if (roadEdgeAt(x, z) < 4.8) return false;
  if (railEdgeAt(x, z) < 3.5) return false;
  if (streamDistanceAt(x, z) < 6) return false;
  if (inFort(x, z, 8) || inBeach(x, z, 6)) return false;
  // Nothing along the line the fields stop at: the cliff-top band is open
  // rough grass, not a hedged field.
  if (coastClearance(x, z) < 31) return false;
  if (inBuiltZone(x, z, 5)) return false;
  if (inWood(x, z, 1.02)) return false;
  if (lakeFraction(x, z) < 1.45) return false;
  if (nearTrack(x, z, 3.5)) return false;
  if (inHamlet(x, z, -20)) return false;
  return true;
}

const kindAt = (x: number, z: number): 'hedge' | 'wall' => (reliefAt(x, z) > WALL_ABOVE ? 'wall' : 'hedge');

/** Break a sampled polyline into runs wherever a sample was dropped. */
function runsOf(samples: Array<Pt | null>, kind: (p: Pt) => 'hedge' | 'wall'): HedgeRun[] {
  const out: HedgeRun[] = [];
  let current: Pt[] = [];
  const flush = () => {
    if (current.length >= 3) out.push({ pts: current, kind: kind(current[Math.floor(current.length / 2)]) });
    current = [];
  };
  for (const s of samples) {
    if (s) current.push(s);
    else flush();
  }
  flush();
  return out;
}

const built = (() => {
  const seen = new Set<string>();
  const key = (x: number, z: number) => `${Math.round(x / 1.6)},${Math.round(z / 1.6)}`;
  const hedges: HedgeRun[] = [];

  // Field boundaries. Each cell's whole perimeter is walked as one sampled
  // line, so a run carries on round a corner; the twin of an edge already
  // walked from the neighbouring cell lands on the same keys and is dropped,
  // and the run breaks there.
  for (const field of FIELDS) {
    const poly = field.polygon;
    const samples: Array<Pt | null> = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const n = Math.max(1, Math.round(len / HEDGE_PITCH));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = p[0] + (q[0] - p[0]) * t;
        const z = p[1] + (q[1] - p[1]) * t;
        const kk = key(x, z);
        if (seen.has(kk)) { samples.push(null); continue; }
        seen.add(kk);
        samples.push(keepBoundary(x, z) ? [x, z] : null);
      }
    }
    hedges.push(...runsOf(samples, ([x, z]) => kindAt(x, z)));
  }

  // Lane-side hedges, with their gates.
  const gates: Gate[] = [];
  const roadside: HedgeRun[] = [];
  const junctionNear = (x: number, z: number) => Object.values(JUNCTIONS)
    .some((j) => Math.hypot(x - j.x, z - j.z) < 27);
  const [endX, endZ] = toLocal(BRIDGE.end[0], BRIDGE.end[1]);
  const gateAt = (road: Road) => {
    const at: Array<{ s: number; side: 1 | -1 }> = [];
    for (let s = 70, k = 0; s < road.length - 45; s += 118, k++) at.push({ s, side: k % 2 ? 1 : -1 });
    return at;
  };
  // The kit lanes and the tarmac single-tracks get hedges; a gravel track
  // does not, it runs through whatever field it crosses.
  for (const road of ROADS) {
    if (road.surface === 'gravel') continue;
    const verge = road.cls === 'lane' ? VERGE : road.width / 2 + 1.9;
    const gatesHere = road.cls === 'lane' ? gateAt(road) : [];
    for (const side of [1, -1] as const) {
      const samples: Array<Pt | null> = [];
      for (const sm of road.samples) {
        const x = sm.x + sm.nx * verge * side;
        const z = sm.z + sm.nz * verge * side;
        let keep = !junctionNear(x, z)
          && !inHamlet(x, z, -4)
          && !inBuiltZone(x, z, 9)
          && coastClearance(x, z) > 20
          && Math.hypot(x - endX, z - endZ) > 44
          && lakeFraction(x, z) > 1.4
          && !nearTrack(x, z, 4.5)
          && streamDistanceAt(x, z) > 8
          && railEdgeAt(x, z) > 6
          && !inFort(x, z, 6)
          && !inBeach(x, z, 6);
        // A single-track's hedge stops where it meets a lane, and a lane's
        // hedge breaks where a single-track leaves it.
        if (road.cls === 'mini' && roadDistanceAt(x, z) < LANE_WIDTH / 2 + 4) keep = false;
        if (road.cls === 'lane' && roadEdgeAt(x, z) < 1.2 && roadDistanceAt(x, z) > LANE_WIDTH / 2 + 1) keep = false;
        for (const g of gatesHere) {
          if (g.side === side && Math.abs(sm.arc - g.s) < 2.8) keep = false;
        }
        samples.push(keep ? [x, z] : null);
      }
      roadside.push(...runsOf(samples, ([x, z]) => kindAt(x, z)));
      for (const g of gatesHere) {
        if (g.side !== side) continue;
        const i = Math.round(g.s / 3);
        const sm = road.samples[Math.min(road.samples.length - 1, i)];
        const x = sm.x + sm.nx * verge * side;
        const z = sm.z + sm.nz * verge * side;
        if (junctionNear(x, z) || inHamlet(x, z, -4) || inBuiltZone(x, z, 9)) continue;
        if (coastClearance(x, z) <= 20 || lakeFraction(x, z) <= 1.4 || railEdgeAt(x, z) < 6) continue;
        if (roadEdgeAt(x, z) < 1.2 && roadDistanceAt(x, z) > LANE_WIDTH / 2 + 1) continue;
        gates.push({ x, z, turn: Math.atan2(sm.tz, sm.tx) });
      }
    }
  }
  return { hedges, roadside, gates };
})();

/** Field-boundary hedges and walls, as runs of points. */
export const HEDGES: readonly HedgeRun[] = built.hedges;
/** The hedges either side of every lane. */
export const ROADSIDE: readonly HedgeRun[] = built.roadside;
/** Five-bar gates in the lane-side hedges. */
export const GATES: readonly Gate[] = built.gates;

/** The paddock's rails, as a closed run. */
export const PADDOCK_FENCE: Pt[] = (() => {
  const c = Math.cos(PADDOCK.turn);
  const s = Math.sin(PADDOCK.turn);
  const corner = (u: number, v: number): Pt => [
    PADDOCK.x + u * c + v * s, PADDOCK.z - u * s + v * c,
  ];
  const w = PADDOCK.w / 2;
  const d = PADDOCK.d / 2;
  return [corner(-w, -d), corner(w, -d), corner(w, d), corner(-w, d)];
})();

/** The poultry run's netting, as a closed run. */
export const POULTRY_FENCE: Pt[] = (() => {
  const c = Math.cos(POULTRY.turn);
  const s = Math.sin(POULTRY.turn);
  const corner = (u: number, v: number): Pt => [
    POULTRY.x + u * c + v * s, POULTRY.z - u * s + v * c,
  ];
  const w = POULTRY.w / 2;
  const d = POULTRY.d / 2;
  return [corner(-w, -d), corner(w, -d), corner(w, d), corner(-w, d)];
})();

/** What the console says the parish came out as. */
export function describeFields(): string {
  const counts = new Map<Crop, number>();
  for (const f of FIELDS) counts.set(f.crop, (counts.get(f.crop) ?? 0) + 1);
  const km = (runs: readonly HedgeRun[], kind: 'hedge' | 'wall') => runs
    .filter((r) => r.kind === kind)
    .reduce((n, r) => n + (r.pts.length - 1) * HEDGE_PITCH, 0) / 1000;
  // The hedge runs are still computed — the hedgerow trees, the gates and
  // the ground map all read them — but nothing draws a hedge any more, so
  // they are reported as what they now are: boundaries.
  return `${FIELDS.length} fields (${[...counts].map(([c, n]) => `${n} ${c}`).join(', ')}), `
    + `${(km(HEDGES, 'hedge') + km(ROADSIDE, 'hedge')).toFixed(1)} km of open boundary, `
    + `${(km(HEDGES, 'wall') + km(ROADSIDE, 'wall')).toFixed(1)} km of wall, ${GATES.length} gates`;
}

/* -------------------------------------------------------- work loops */

export interface WorkSample {
  x: number;
  z: number;
  /** The ground, so a machine sits on it rather than on a plane. */
  y: number;
  tx: number;
  tz: number;
  arc: number;
}

export interface WorkLoop {
  field: number;
  crop: Crop;
  samples: WorkSample[];
  length: number;
  label: string;
}

/**
 * The circuits the tractor and the combine drive.
 *
 * A machine working a field drives round it, in from the headland, so the
 * loop is the field's own boundary brought inside by a headland's width and
 * its corners cut — a tractor turns, it does not stop and pivot. Taking the
 * field's polygon rather than drawing a circle somewhere is what keeps the
 * loop inside one field and off the hedges that mark its edges, which is the
 * whole difficulty: a hand-drawn loop in open ground crosses a boundary the
 * moment the Voronoi seeding moves.
 *
 * Arable only. The lone oaks and the copses are scattered in pasture, meadow
 * and rough ground (see `CountryPlanting`), so an arable field is a field
 * with nothing standing in it — and a combine belongs in corn in any case.
 */
const WORK_CROPS: readonly Crop[] = ['stubble', 'wheat', 'barley', 'plough', 'maize', 'rape'];
/**
 * How far inside its boundary a machine runs — the headland it leaves itself.
 *
 * Tried in turn, widest last. A field's Voronoi cell is drawn against its
 * neighbours and takes no notice of the lanes and the railway, so EVERY field
 * on the island has a road or the line clipping a corner of it: at sixteen
 * metres not one loop came back clear. Shrinking further pulls the loop off
 * whatever crosses the corner, at the cost of a shorter lap.
 */
const HEADLANDS = [16, 22, 28, 34, 40, 48] as const;

export const WORK_LOOPS: readonly WorkLoop[] = (() => {
  const ok = (x: number, z: number) => (
    roadEdgeAt(x, z) > 7 && railEdgeAt(x, z) > 7 && !inBuiltZone(x, z, 6)
    && !inWood(x, z) && !inFort(x, z, 8) && lakeFraction(x, z) > 1.25
    && coastClearance(x, z) > 30 && inIsland(x, z, 40)
  );
  /** The field's boundary brought in by `headland`, corners cut, resampled. */
  const ring = (f: Field, headland: number) => {
    const inset = f.polygon.map(([x, z]) => {
      const dx = f.centroid[0] - x;
      const dz = f.centroid[1] - z;
      const len = Math.hypot(dx, dz) || 1;
      const t = Math.min(0.8, headland / len);
      return [x + dx * t, z + dz * t] as Pt;
    });
    // Corner cutting, three passes: a headland turn, not a right angle.
    let loop = inset;
    for (let pass = 0; pass < 3; pass++) {
      const next: Pt[] = [];
      for (let i = 0; i < loop.length; i++) {
        const [ax, az] = loop[i];
        const [bx, bz] = loop[(i + 1) % loop.length];
        next.push([ax + (bx - ax) * 0.25, az + (bz - az) * 0.25]);
        next.push([ax + (bx - ax) * 0.75, az + (bz - az) * 0.75]);
      }
      loop = next;
    }
    const cum = [0];
    for (let i = 1; i <= loop.length; i++) {
      const [ax, az] = loop[i - 1];
      const [bx, bz] = loop[i % loop.length];
      cum.push(cum[i - 1] + Math.hypot(bx - ax, bz - az));
    }
    const length = cum[loop.length];
    const step = 2;
    const count = Math.max(8, Math.round(length / step));
    const samples: WorkSample[] = [];
    let j = 0;
    for (let i = 0; i < count; i++) {
      const arc = (length * i) / count;
      while (j < loop.length - 1 && cum[j + 1] < arc) j++;
      const span = cum[j + 1] - cum[j] || 1;
      const t = (arc - cum[j]) / span;
      const [ax, az] = loop[j];
      const [bx, bz] = loop[(j + 1) % loop.length];
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      samples.push({ x, z, y: groundAt(x, z), tx: 0, tz: 0, arc });
    }
    for (let i = 0; i < samples.length; i++) {
      const a = samples[(i - 1 + samples.length) % samples.length];
      const b = samples[(i + 1) % samples.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      samples[i].tx = dx / len;
      samples[i].tz = dz / len;
    }
    let climb = 0;
    for (let i = 1; i < samples.length; i++) {
      climb = Math.max(climb, Math.abs(samples[i].y - samples[i - 1].y) / step);
    }
    return { samples, length, climb, clear: samples.every((s) => ok(s.x, s.z)) };
  };

  const found: WorkLoop[] = [];
  for (const f of FIELDS) {
    if (!WORK_CROPS.includes(f.crop) || f.area < 6000) continue;
    for (const headland of HEADLANDS) {
      const r = ring(f, headland);
      // Every metre of it has to be usable: one sample on a lane and the
      // machine drives through the hedge once a lap. A gentle field, too —
      // these things work along the contour, not up the scarp.
      if (!r.clear || r.length < 130 || r.climb > 0.16) continue;
      found.push({ field: f.id, crop: f.crop, samples: r.samples, length: r.length, label: `${f.crop} field ${f.id}` });
      break;
    }
  }
  // The two longest, and never two in the same field.
  return found.sort((a, b) => b.length - a.length).slice(0, 2);
})();

/** True within `pad` of a work loop: nothing may be left standing on one. */
export function onWorkLoop(x: number, z: number, pad: number): boolean {
  for (const loop of WORK_LOOPS) {
    for (const s of loop.samples) if (Math.hypot(s.x - x, s.z - z) < pad) return true;
  }
  return false;
}
