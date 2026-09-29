/*
 * The airport's service roads, routed rather than drawn.
 *
 * They used to be four rectangles written by hand, and a rectangle is four
 * straight lines and a guess. Measured against the buildings' real footprints,
 * the guess was wrong: the apron loop ran 1.6 m INSIDE the terminal, and the
 * cargo loop ran 1 m from the line the freighter taxis down.
 *
 * So they are computed now. The airport's driveable space becomes a grid —
 * paved, clear of every structure by a margin, clear of the corridors the
 * aeroplanes use — and each loop is routed through it, smoothed, and checked.
 *
 * ## Why the output is a dense polyline and not control points
 *
 * The first version wrote twenty control points per loop and splined them in
 * the game. A spline does not pass where its control points do: uniform
 * Catmull-Rom overshoots, and even centripetal bulges on the outside of a
 * turn. Twice the control polygon cleared a building by five metres and the
 * CURVE went through it — a check that passes on data the game does not drive
 * is not a check. So the smoothing happens here and the result is written out
 * every five metres. What is verified below is exactly what runs.
 *
 * ## The shape of the place
 *
 * Airside is a TREE, not a graph. The band in front of the stands is the only
 * way east-west, and the two aircraft lead-ins cut the apron behind the stands
 * into three pockets that do not join up. So an airside loop has to turn round,
 * and the turns go where there is room for them: the east apron and the hangar
 * apron, not in the middle of the band.
 *
 *   npm run prepare:routes
 */
import { writeFileSync } from 'node:fs';
import {
  BUILDINGS, CONTAINERS, DECO, PAVING, PARKED, FUSELAGE, HELIPADS, HELIPAD, RUNWAY, TAXIWAY,
} from '../src/config/airportConfig';
import { RIDES, PARK_PAVING } from '../src/config/parkConfig';
import {
  JET, TURBOPROP, FREIGHTER, THRESHOLD, RUN_DIR, RUN_CITY, RUNWAY_TOP,
} from '../src/config/flightConfig';
import colliders from '../src/config/colliderBoxes.json';
import airportModels from '../src/config/airportModelData.json';
import parkModels from '../src/config/parkModelData.json';

type Pt = [number, number];

/* --------------------------------------------------------------- the place */

const BOXES = colliders as unknown as Record<string, { height: number; boxes: number[][] }>;
const SIZE: Record<string, number[]> = {
  ...Object.fromEntries(Object.entries((airportModels as { parts: Record<string, { size: number[] }> }).parts)
    .map(([k, v]) => [k, v.size])),
  ...Object.fromEntries(Object.entries((parkModels as { parts: Record<string, { size: number[] }> }).parts)
    .map(([k, v]) => [k, v.size])),
};

interface Obstacle { what: string; x: number; z: number; turn: number; hx: number; hz: number }
const OBSTACLES: Obstacle[] = [];
function solid(what: string, part: string, x: number, z: number, turn: number) {
  const e = BOXES[part];
  if (e?.boxes.length) {
    const c = Math.cos(turn), s = Math.sin(turn);
    for (const [cx, cz, hx, hz] of e.boxes)
      OBSTACLES.push({ what, x: x + cx * c + cz * s, z: z - cx * s + cz * c, turn, hx, hz });
    return;
  }
  const sz = SIZE[part];
  if (sz) OBSTACLES.push({ what, x, z, turn, hx: sz[0] / 2, hz: sz[2] / 2 });
}
for (const b of BUILDINGS) solid(b.label, b.part, b.x, b.z, b.turn);
for (const d of DECO.filter((x) => x.solid)) solid(d.part.replace('deco_', ''), d.part, d.x, d.z, d.turn);
for (const r of RIDES) solid(r.label, r.part, r.along, r.across, r.turn);
for (const a of PARKED) {
  const f = a.fuselage ?? FUSELAGE;
  OBSTACLES.push({ what: `parked ${a.label}`, x: a.x, z: a.z, turn: a.turn,
    hx: f.halfWidth, hz: (SIZE[a.part]?.[2] ?? 40) / 2 });
}
// The container bays, one obstacle each. A stack is a solid block to anything
// driving round it, and the router only needs the footprint — which is the
// same box `AirportIsland` gives Rapier.
for (const [i, bay] of CONTAINERS.bays.entries()) {
  const B = CONTAINERS.box;
  const G = CONTAINERS.gap;
  const along = bay.long * (B.long + G.end) - G.end;
  const across = bay.rows * (B.wide + G.side) - G.side;
  OBSTACLES.push({
    what: `container bay ${i + 1}`, turn: 0,
    x: bay.along + along / 2, z: bay.across + across / 2,
    hx: along / 2, hz: across / 2,
  });
}
for (const p of HELIPADS)
  OBSTACLES.push({ what: p.label, x: p.x, z: p.z, turn: 0, hx: HELIPAD.half, hz: HELIPAD.half });

/** Metres from a point to a rotated rectangle; zero when inside it. */
function gap(o: Obstacle, x: number, z: number) {
  const dx = x - o.x, dz = z - o.z;
  const c = Math.cos(-o.turn), s = Math.sin(-o.turn);
  return Math.hypot(
    Math.max(0, Math.abs(dx * c + dz * s) - o.hx),
    Math.max(0, Math.abs(-dx * s + dz * c) - o.hz),
  );
}
function nearest(x: number, z: number) {
  let best = Infinity, what = '';
  for (const o of OBSTACLES) { const d = gap(o, x, z); if (d < best) { best = d; what = o.what; } }
  return { d: best, what };
}

const SURFACES: number[][] = [
  ...Object.values(PAVING), ...Object.values(PARK_PAVING),
  [-RUNWAY.half, RUNWAY.half, RUNWAY.centre - RUNWAY.width / 2, RUNWAY.centre + RUNWAY.width / 2],
  [-TAXIWAY.half, TAXIWAY.half, TAXIWAY.centre - TAXIWAY.width / 2, TAXIWAY.centre + TAXIWAY.width / 2],
].map((r) => r as unknown as number[]);
const paved = (x: number, z: number) =>
  SURFACES.some((r) => x >= r[0] && x <= r[1] && z >= r[2] && z <= r[3]);

/** Where the three aeroplanes roll, in the island's frame. */
const TAXI: Pt[] = [];
for (const c of [JET, TURBOPROP, FREIGHTER])
  for (let d = 0; d < c.lapLength; d += 4) {
    const p = c.at(d);
    if (p.y - RUNWAY_TOP > 0.5) continue;
    TAXI.push([
      (p.x - THRESHOLD[0]) * RUN_DIR[0] + (p.z - THRESHOLD[1]) * RUN_DIR[1] - 420,
      (p.x - THRESHOLD[0]) * RUN_CITY[0] + (p.z - THRESHOLD[1]) * RUN_CITY[1] - 120,
    ]);
  }
const taxiGap = (x: number, z: number) => {
  let best = Infinity;
  for (const [tx, tz] of TAXI) { const d = Math.hypot(tx - x, tz - z); if (d < best) best = d; }
  return best;
};

/* ---------------------------------------------------------------- the grid */

const C = 2, X0 = -440, X1 = 440, Z0 = -110, Z1 = 290;
const NX = Math.round((X1 - X0) / C), NZ = Math.round((Z1 - Z0) / C);
const at = (ix: number, iz: number) => iz * NX + ix;
const xOf = (ix: number) => X0 + ix * C;
const zOf = (iz: number) => Z0 + iz * C;

/** Half a service vehicle plus the room a driver would want beside a wall. */
const MARGIN = 5;
/** How far a service road keeps off a line an aeroplane taxis down. */
const TAXI_CLEAR = 14;

const blocked = new Uint8Array(NX * NZ);
for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++)
  if (!paved(xOf(ix), zOf(iz))) blocked[at(ix, iz)] = 1;
// Stamped per obstacle rather than asked per cell: the same answer, and it
// finishes. 88,000 cells against 330 boxes is 29 million distance tests.
function stamp(x: number, z: number, r: number, hit: (x: number, z: number) => boolean) {
  const i0 = Math.max(0, Math.floor((x - r - X0) / C)), i1 = Math.min(NX - 1, Math.ceil((x + r - X0) / C));
  const j0 = Math.max(0, Math.floor((z - r - Z0) / C)), j1 = Math.min(NZ - 1, Math.ceil((z + r - Z0) / C));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
    if (!blocked[at(i, j)] && hit(xOf(i), zOf(j))) blocked[at(i, j)] = 1;
}
for (const o of OBSTACLES)
  stamp(o.x, o.z, Math.hypot(o.hx, o.hz) + MARGIN + 1, (x, z) => gap(o, x, z) < MARGIN);
for (const [tx, tz] of TAXI)
  stamp(tx, tz, TAXI_CLEAR + 1, (x, z) => Math.hypot(tx - x, tz - z) < TAXI_CLEAR);

/** Distance to the nearest blocked cell, so a route can prefer the middle. */
const room = new Int32Array(NX * NZ).fill(-1);
{
  const q: number[] = [];
  for (let k = 0; k < blocked.length; k++) if (blocked[k]) { room[k] = 0; q.push(k); }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], ix = k % NX, iz = (k - ix) / NX;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= NX || jz >= NZ) continue;
      const j = at(jx, jz);
      if (room[j] < 0) { room[j] = room[k] + 1; q.push(j); }
    }
  }
}
const isClear = (x: number, z: number) => {
  const ix = Math.round((x - X0) / C), iz = Math.round((z - Z0) / C);
  return ix >= 0 && iz >= 0 && ix < NX && iz < NZ && !blocked[at(ix, iz)];
};

/* --------------------------------------------------------------- the route */

/**
 * Cells a leg has already used, so the next one finds its own lane.
 *
 * Without it the return half of a loop is the outbound half backwards — the
 * router prefers the widest ground and there is only one widest ground — and
 * two lines of vehicles drive through each other down the middle of it.
 */
const used = new Float64Array(NX * NZ);
function markUsed(path: Pt[], radius = 11, weight = 90) {
  for (const [x, z] of path)
    stampField(x, z, radius, (i, j, d) => {
      used[at(i, j)] = Math.max(used[at(i, j)], weight * (1 - d / radius));
    });
}
function stampField(x: number, z: number, r: number, f: (i: number, j: number, d: number) => void) {
  const i0 = Math.max(0, Math.floor((x - r - X0) / C)), i1 = Math.min(NX - 1, Math.ceil((x + r - X0) / C));
  const j0 = Math.max(0, Math.floor((z - r - Z0) / C)), j1 = Math.min(NZ - 1, Math.ceil((z + r - Z0) / C));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d = Math.hypot(xOf(i) - x, zOf(j) - z);
    if (d < r) f(i, j, d);
  }
}

/** Dijkstra, cheapest through the WIDEST ground rather than the shortest. */
function leg(from: Pt, to: Pt): Pt[] {
  const snap = (p: Pt) => {
    let best = -1, bd = Infinity;
    for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
      if (blocked[at(ix, iz)]) continue;
      const d = Math.hypot(xOf(ix) - p[0], zOf(iz) - p[1]);
      if (d < bd) { bd = d; best = at(ix, iz); }
    }
    if (best < 0) throw new Error(`no driveable ground near ${p}`);
    return best;
  };
  const s = snap(from), t = snap(to);
  const dist = new Float64Array(NX * NZ).fill(Infinity);
  const prev = new Int32Array(NX * NZ).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, k: number) => {
    heap.push([d, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop() as [number, number];
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  dist[s] = 0;
  push(0, s);
  while (heap.length) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    if (k === t) break;
    const ix = k % NX, iz = (k - ix) / NX;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= NX || jz >= NZ) continue;
      const j = at(jx, jz);
      if (blocked[j]) continue;
      // Hug the middle: a cell with little room either side costs more.
      const w = Math.hypot(dx, dz) * C * (1 + 90 / Math.max(2, room[j]) ** 1.4) + used[j];
      if (dist[k] + w < dist[j]) { dist[j] = dist[k] + w; prev[j] = k; push(dist[j], j); }
    }
  }
  const out: Pt[] = [];
  for (let k = t; k >= 0; k = prev[k]) {
    const ix = k % NX;
    out.push([xOf(ix), zOf((k - ix) / NX)]);
    if (k === s) break;
  }
  return out.reverse();
}

/**
 * Laplacian smoothing, held off the walls.
 *
 * A grid path is a staircase of 45 degree steps; this is what turns it into
 * something a vehicle would drive. A move is only taken if it stays clear, and
 * the grid already carries the margin, so "clear" means "far enough from
 * everything". The pull back toward where each point started is what stops a
 * closed loop shrinking to a dot, which is what Laplacian smoothing does to a
 * ring if you let it.
 */
function smooth(path: Pt[], rounds = 600): Pt[] {
  const orig = path.map((p) => [...p] as Pt);
  const p = path.map((q) => [...q] as Pt);
  const n = p.length;
  for (let r = 0; r < rounds; r++)
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
      const tx = p[i][0] + 0.4 * ((a[0] + b[0]) / 2 - p[i][0]) + 0.05 * (orig[i][0] - p[i][0]);
      const tz = p[i][1] + 0.4 * ((a[1] + b[1]) / 2 - p[i][1]) + 0.05 * (orig[i][1] - p[i][1]);
      if (isClear(tx, tz)) { p[i][0] = tx; p[i][1] = tz; }
    }
  return p;
}

/**
 * Keep the two lanes of a loop apart, which is what rounds its turnarounds.
 *
 * Smoothing alone pulls the outbound and return lanes together until they
 * meet, and where they meet the path reverses inside five metres — a cusp, not
 * a turn. Measured, r = 1 m. Pushing apart any two points that are close in
 * SPACE but far apart along the PATH holds the lanes at arm's length, and a
 * turnaround between lanes that are nine metres apart has a radius of four and
 * a half whether anything asks it to or not.
 */
function unpick(points: Pt[], rounds = 700, apart = 9): Pt[] {
  const p = points.map((q) => [...q] as Pt);
  // Tethered to where it started, for the reason `smooth` is: without it the
  // Laplacian term shrinks a ring, and it shrank the hangar lap from 259 m to
  // 80 — a neat little circle in the middle of 300 m of concrete.
  const orig = points.map((q) => [...q] as Pt);
  const n = p.length;
  const far = Math.max(6, Math.round(apart * 2.5 / 5));
  for (let r = 0; r < rounds; r++)
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
      let px = 0.3 * ((a[0] + b[0]) / 2 - p[i][0]) + 0.06 * (orig[i][0] - p[i][0]);
      let pz = 0.3 * ((a[1] + b[1]) / 2 - p[i][1]) + 0.06 * (orig[i][1] - p[i][1]);
      for (let j = 0; j < n; j++) {
        const sep = Math.min(Math.abs(i - j), n - Math.abs(i - j));
        if (sep <= far) continue;
        const dx = p[i][0] - p[j][0], dz = p[i][1] - p[j][1];
        const d = Math.hypot(dx, dz);
        if (d >= apart || d < 1e-6) continue;
        px += (dx / d) * (apart - d) * 0.25;
        pz += (dz / d) * (apart - d) * 0.25;
      }
      const tx = p[i][0] + px, tz = p[i][1] + pz;
      if (isClear(tx, tz)) { p[i][0] = tx; p[i][1] = tz; }
    }
  return p;
}

/** Even spacing by arc length round the whole closed loop. */
function resample(path: Pt[], every: number): Pt[] {
  const n = path.length, cum = [0];
  for (let i = 1; i <= n; i++)
    cum.push(cum[i - 1] + Math.hypot(path[i % n][0] - path[i - 1][0], path[i % n][1] - path[i - 1][1]));
  const total = cum[n];
  const count = Math.max(8, Math.round(total / every));
  const out: Pt[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const want = (total * k) / count;
    while (seg < n - 1 && cum[seg + 1] < want) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span ? (want - cum[seg]) / span : 0;
    const a = path[seg], b = path[(seg + 1) % n];
    out.push([
      Math.round((a[0] + (b[0] - a[0]) * t) * 10) / 10,
      Math.round((a[1] + (b[1] - a[1]) * t) * 10) / 10,
    ]);
  }
  return out;
}

/* --------------------------------------------------------------- the loops */

const LOOPS: { name: string; note: string; visit: Pt[] }[] = [
  {
    name: 'apron',
    note: 'the stands: east in front of the aeroplanes, round the east apron, back west, round the hangar apron',
    visit: [[-200, 48], [-120, 54], [-40, 58], [40, 62], [120, 58], [190, 48],
      [214, 18], [208, -16], [174, -34], [138, -36], [104, -28], [92, 0], [102, 26],
      [60, 42], [-40, 42], [-120, 38], [-190, 34],
      [-234, 14], [-254, -14], [-288, -30], [-316, -12], [-302, 16], [-252, 34]],
  },
  {
    name: 'hangar',
    note: 'a lap of the open concrete west of the stands',
    visit: [[-330, -28], [-392, -34], [-426, -12], [-418, 10], [-370, 22], [-332, 6]],
  },
  {
    name: 'cargo',
    note: 'the freight yard, round the sheds and clear of the freighter',
    visit: [[292, 70], [332, 88], [390, 90], [420, 64], [424, 28], [414, -8],
      [392, -32], [352, -38], [314, -28], [286, 6], [278, 40]],
  },
  /*
   * There is no `landside` loop any more.
   *
   * It ran the entrance avenue, the terminal road and the car park aisle, and
   * it carried seven vehicles — two buses, a taxi, a city bus, a postvan, a
   * tow truck and an SUV. All seven are gone from `FLEET`: everything left is
   * inside the fence, which is ground service on ground service's own roads.
   *
   * The loop went with them rather than being left in the data, because the
   * ground it was drawn on is not there any more. The entrance avenue moved
   * from along 157 to 120 and lost its central reservation, the terminal's
   * forecourt came back to its building, and the car park shifted west — so
   * the route this script last generated failed its own check with fifteen
   * points off tarmac. A loop that is kept "in case" and cannot be driven is
   * worse than no loop: it passes review by existing.
   */
];

/** Half the widest service vehicle. */
const HALF = 1.6;
/*
 * What the result has to be, or this script has not done its job.
 *
 * The radius is 2.5 m because that is roughly what a baggage tug turns in, and
 * the only places a loop gets near it are its two turnarounds. It is not a
 * number chosen to make the check pass: the first run measured r = 1 m, which
 * is not a turn but a cusp, and `unpick` is what fixed it.
 */
const WANT_STRUCTURE = 2.5, WANT_TAXI = 14, WANT_RADIUS = 2.5;

const out: Record<string, { note: string; points: Pt[] }> = {};
let failed = 0;
console.log(`driveable ground: ${blocked.length - blocked.reduce((a, b) => a + b, 0)} of ${blocked.length} cells\n`);
console.log('  loop        length   nearest structure        taxi   tightest turn');
for (const { name, note, visit } of LOOPS) {
  let path: Pt[] = [];
  for (let i = 0; i < visit.length; i++) {
    const seg = leg(visit[i], visit[(i + 1) % visit.length]);
    markUsed(seg);
    path = path.concat(i ? seg.slice(1) : seg);
  }
  used.fill(0);
  const points = resample(unpick(resample(smooth(path), 5)), 5);

  let worst = Infinity, what = '', offPave = 0, minTaxi = Infinity, minR = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    if (!paved(x, z)) offPave++;
    minTaxi = Math.min(minTaxi, taxiGap(x, z));
    const n2 = nearest(x, z);
    if (n2.d - HALF < worst) { worst = n2.d - HALF; what = n2.what; }
    const a = points[(i - 1 + points.length) % points.length], b = points[(i + 1) % points.length];
    let dh = Math.atan2(b[0] - x, b[1] - z) - Math.atan2(x - a[0], z - a[1]);
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    if (Math.abs(dh) > 1e-6) minR = Math.min(minR, Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.abs(dh));
  }
  const len = points.reduce((n2, p, i) =>
    n2 + Math.hypot(p[0] - points[(i - 1 + points.length) % points.length][0],
      p[1] - points[(i - 1 + points.length) % points.length][1]), 0);
  const ok = worst >= WANT_STRUCTURE && offPave === 0 && minTaxi >= WANT_TAXI && minR >= WANT_RADIUS;
  if (!ok) failed++;
  console.log(`  ${ok ? ' ' : '!'} ${name.padEnd(9)} ${len.toFixed(0).padStart(4)} m   ${worst.toFixed(1).padStart(5)} m ${`(${what})`.padEnd(22)} ${minTaxi.toFixed(0).padStart(3)} m   r=${minR.toFixed(1).padStart(4)} m${offPave ? `   OFF TARMAC ${offPave}` : ''}`);
  out[name] = { note, points };
}

writeFileSync('src/config/serviceRoutes.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(`\nwrote src/config/serviceRoutes.json — ${Object.values(out).reduce((n, r) => n + r.points.length, 0)} points`);
if (failed) {
  console.error(`\n${failed} loop(s) below the bar (structure ${WANT_STRUCTURE} m, taxi ${WANT_TAXI} m, radius ${WANT_RADIUS} m).`);
  process.exitCode = 1;
}
