/**
 * The road network, as lanes a car can follow.
 *
 * Two sources, one graph:
 *
 *   the city    `roadGraph.json`, the street centrelines `make-road-graph.mjs`
 *               skeletonised out of the nav raster — see that script for how
 *   the island  built here at load from the same `STREETS` and `RING_CHAINS`
 *               the town is drawn from, plus the causeway that joins it to the
 *               city; the island is TypeScript config rather than a mesh, so
 *               there is nothing offline to skeletonise
 *
 * Both go through `planarise`, which is what turns a bag of polylines into a
 * graph: every place two lines cross or one ends on another becomes a node,
 * and the pieces between nodes become edges. The city's lines arrive already
 * noded (the skeleton did that); the island's are drawn as whole streets and
 * have to be cut at every junction here.
 *
 * ## Lanes
 *
 * An edge is a centreline. A lane is an edge, a direction of travel, and an
 * offset to the driving side — `laneAt` is the only place that offset is
 * applied, so `TRAFFIC.driveOnRight` is a single switch. A car on a lane is a
 * distance `s` along it; that is its whole position, and everything the AI
 * asks — where am I, where is the car in front, how sharp is the next bend,
 * what are my exits — is arithmetic on `s` rather than a raster probe. That is
 * the difference between a car that is parallel to the kerb because the lane
 * is, and one that is trying to be.
 *
 * ## What the graph is not
 *
 * It is not a collision map. Buildings, trams, the player and the edge of the
 * tarmac are all still real geometry the physics deals with; this only says
 * where a car that is driving normally should want to be.
 */
import cityGraph from '@/config/roadGraph.json';
import { TRAFFIC } from '@/config/trafficConfig';
import { BRIDGE, stationPoint } from '@/config/stationConfig';
import { RING, RING_CHAINS, STREETS, TOWN_ENABLED, CROSSING } from '@/config/townConfig';

export interface RoadEdge {
  /** Node indices. `dir` +1 travels a -> b. */
  a: number;
  b: number;
  /** Carriageway width, kerb to kerb, metres. */
  width: number;
  /** Centreline as flat [x0, z0, x1, z1, ...]. */
  pts: Float64Array;
  /** Cumulative length at each point, from `a`. */
  cum: Float64Array;
  length: number;
  /** Lane centre's distance from the centreline. */
  laneOffset: number;
  /** Cruise cap on this road, m/s. Wider is faster. */
  speed: number;
  /**
   * The level crossing's deck: driveable only while the barriers are up.
   * The AI holds at the start of it otherwise. See `townNav.isCrossingClear`.
   */
  gate: boolean;
  /**
   * One-way: the only direction of travel allowed, +1 for a -> b, or 0 for
   * both. A roundabout's ring is one-way in the circulating direction; see
   * `make-road-graph.mjs`.
   */
  oneWay: 0 | 1 | -1;
}

export interface RoadNode {
  x: number;
  z: number;
  /** Every edge touching this node. */
  edges: number[];
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** Spatial hash of edge indices by cell, for "what roads are near here". */
  grid: Map<number, number[]>;
  cell: number;
}

/** Where a lane sample landed. */
export interface LanePose {
  x: number;
  z: number;
  /** Forward is (-sin h, -cos h), the convention every vehicle here uses. */
  heading: number;
}

/** A point on a lane, as `nearestLane` reports it. */
export interface LaneFix {
  edge: number;
  dir: 1 | -1;
  /** Distance along the lane in the direction of travel. */
  s: number;
  /** Metres from the query point to the lane centre. */
  distance: number;
}

const TAU = Math.PI * 2;
export const wrapAngle = (a: number) => {
  let d = a % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/* ------------------------------------------------------------ building */

type Poly = {
  pts: [number, number][]; width: number; speed: number; gate?: boolean; oneWay?: 1 | -1;
  /** Snap the ends onto whatever street they nearly touch. The island's streets need it; the city's arrive noded. */
  snap?: boolean;
};

/**
 * A set of polylines to a graph.
 *
 * Endpoints within `snap` of another line are joined to it (T-junctions), and
 * proper crossings are cut (X-junctions). Then every vertex that is a junction
 * or an end becomes a node, vertices within a metre of each other are one
 * node, and the runs between nodes are the edges.
 */
function planarise(polys: Poly[], snap: number): { nodes: RoadNode[]; edges: RoadEdge[] } {
  // Work on mutable copies. `marks` collects the vertices that are junctions:
  // every line end, and every point inserted where lines meet. Only those
  // become nodes — a vertex is not a junction because a curve happens to bend
  // through the same square metre as another.
  const lines = polys.map((p) => ({ ...p, pts: p.pts.map(([x, z]) => [x, z] as [number, number]) }));
  const key = (x: number, z: number) => `${Math.round(x * 2)}:${Math.round(z * 2)}`;
  const marks = new Set<string>();
  for (const line of lines) {
    marks.add(key(line.pts[0][0], line.pts[0][1]));
    marks.add(key(line.pts[line.pts.length - 1][0], line.pts[line.pts.length - 1][1]));
  }

  const closest = (pts: [number, number][], x: number, z: number) => {
    let best = { d: Infinity, i: 0, t: 0, x: 0, z: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i]; const [bx, bz] = pts[i + 1];
      const ex = bx - ax, ez = bz - az; const l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const px = ax + ex * t, pz = az + ez * t;
      const d = Math.hypot(px - x, pz - z);
      if (d < best.d) best = { d, i, t, x: px, z: pz };
    }
    return best;
  };
  const insert = (line: { pts: [number, number][] }, i: number, t: number, x: number, z: number) => {
    marks.add(key(x, z));
    if (t <= 1e-6 || t >= 1 - 1e-6) return;
    line.pts.splice(i + 1, 0, [x, z]);
  };

  // T-junctions: snap each end onto the nearest other line.
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.snap) continue;
    for (const endIdx of [0, line.pts.length - 1]) {
      const [x, z] = line.pts[endIdx];
      let best: { lj: number; hit: ReturnType<typeof closest> } | null = null;
      for (let lj = 0; lj < lines.length; lj++) {
        if (lj === li) continue;
        const hit = closest(lines[lj].pts, x, z);
        if (hit.d <= snap && (!best || hit.d < best.hit.d)) best = { lj, hit };
      }
      if (!best) continue;
      const { lj, hit } = best;
      if (hit.d < 1e-6) continue; // already shares the vertex
      insert(lines[lj], hit.i, hit.t, hit.x, hit.z);
      line.pts[endIdx] = [hit.x, hit.z];
      marks.add(key(hit.x, hit.z));
    }
  }

  // X-junctions: proper segment crossings.
  for (let li = 0; li < lines.length; li++) for (let lj = li + 1; lj < lines.length; lj++) {
    const A = lines[li], B = lines[lj];
    for (let i = 0; i < A.pts.length - 1; i++) for (let j = 0; j < B.pts.length - 1; j++) {
      const [ax, az] = A.pts[i], [bx, bz] = A.pts[i + 1];
      const [cx, cz] = B.pts[j], [dx, dz] = B.pts[j + 1];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
      const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
      if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      insert(A, i, t, x, z); insert(B, j, u, x, z);
      i++; // the inserted vertex shifts the rest along
    }
  }

  // Nodes: the marked vertices, merged where they coincide.
  const nodes: RoadNode[] = [];
  const nodeAt = new Map<string, number>();
  const nodeFor = (x: number, z: number) => {
    const k = key(x, z);
    let n = nodeAt.get(k);
    if (n === undefined) { n = nodes.length; nodes.push({ x, z, edges: [] }); nodeAt.set(k, n); }
    return n;
  };
  const edges: RoadEdge[] = [];
  for (const line of lines) {
    let run: [number, number][] = [line.pts[0]];
    for (let i = 1; i < line.pts.length; i++) {
      const p = line.pts[i];
      run.push(p);
      const isNode = i === line.pts.length - 1 || marks.has(key(p[0], p[1]));
      if (!isNode) continue;
      const a = nodeFor(run[0][0], run[0][1]);
      const b = nodeFor(p[0], p[1]);
      if (a !== b) {
        // Ends pinned to the node exactly, so every lane into a junction
        // meets every lane out of it at one point.
        run[0] = [nodes[a].x, nodes[a].z];
        run[run.length - 1] = [nodes[b].x, nodes[b].z];
        const e = makeEdge(a, b, run, line.width, line.speed, line.gate ?? false, line.oneWay ?? 0);
        nodes[a].edges.push(edges.length); nodes[b].edges.push(edges.length); edges.push(e);
      }
      run = [p];
    }
  }
  return { nodes, edges };
}

function makeEdge(
  a: number, b: number, run: [number, number][], width: number, speed: number, gate: boolean, oneWay: 0 | 1 | -1,
): RoadEdge {
  const pts = new Float64Array(run.length * 2);
  const cum = new Float64Array(run.length);
  for (let i = 0; i < run.length; i++) {
    pts[i * 2] = run[i][0]; pts[i * 2 + 1] = run[i][1];
    cum[i] = i === 0 ? 0 : cum[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
  }
  return {
    a, b, width, pts, cum, length: cum[cum.length - 1], gate, oneWay,
    // A quarter of the carriageway: the middle of the car's own half. Never
    // closer to the centreline than a car is wide, or the two streams touch.
    laneOffset: Math.min(TRAFFIC.laneOffsetMax, Math.max(TRAFFIC.laneOffsetMin, width * 0.25)),
    speed,
  };
}

/**
 * Junction clusters to junctions.
 *
 * Where the island's streets meet the ring, or a snapped end lands a few
 * metres from an existing node, two junctions end up a car's length apart
 * with a stub between them — and a car on the stub is "between junctions"
 * with neither one's give-way logic applying to it. Any edge shorter than a
 * junction is wide with a junction at both ends becomes one node at the
 * midpoint. The offline script does the same to the city (`CLUSTER`).
 */
function contract(g: { nodes: RoadNode[]; edges: RoadEdge[] }): { nodes: RoadNode[]; edges: RoadEdge[] } {
  const { nodes, edges } = g;
  const alive = edges.map(() => true);
  for (let guard = 0; guard < 500; guard++) {
    let done = true;
    for (let i = 0; i < edges.length; i++) {
      if (!alive[i]) continue;
      const e = edges[i];
      if (e.oneWay || e.length >= TRAFFIC.clusterLength || e.a === e.b) continue;
      const degA = nodes[e.a].edges.filter((k) => alive[k]).length;
      const degB = nodes[e.b].edges.filter((k) => alive[k]).length;
      if (degA < 3 || degB < 3) continue;
      const keep = e.a, drop = e.b;
      const mx = (nodes[keep].x + nodes[drop].x) / 2, mz = (nodes[keep].z + nodes[drop].z) / 2;
      nodes[keep].x = mx; nodes[keep].z = mz;
      alive[i] = false;
      for (const k of nodes[drop].edges) {
        if (!alive[k]) continue;
        const f = edges[k];
        if (f.a === drop) f.a = keep;
        if (f.b === drop) f.b = keep;
        if (!nodes[keep].edges.includes(k)) nodes[keep].edges.push(k);
      }
      nodes[drop].edges = [];
      nodes[keep].edges = nodes[keep].edges.filter((k) => alive[k] && k !== i);
      // Every edge at the merged node ends on its new position.
      for (const k of nodes[keep].edges) repin(edges[k], nodes);
      done = false;
    }
    if (done) break;
  }
  // Re-pack: drop dead edges and empty nodes, fix the indices.
  const edgeMap = new Map<number, number>();
  const outEdges: RoadEdge[] = [];
  edges.forEach((e, i) => { if (alive[i] && e.a !== e.b) { edgeMap.set(i, outEdges.length); outEdges.push(e); } });
  const nodeMap = new Map<number, number>();
  const outNodes: RoadNode[] = [];
  nodes.forEach((n, i) => {
    const kept = n.edges.filter((k) => edgeMap.has(k)).map((k) => edgeMap.get(k)!);
    if (!kept.length) return;
    nodeMap.set(i, outNodes.length);
    outNodes.push({ x: n.x, z: n.z, edges: kept });
  });
  for (const e of outEdges) { e.a = nodeMap.get(e.a)!; e.b = nodeMap.get(e.b)!; }
  return { nodes: outNodes, edges: outEdges };
}

/** Move an edge's end points onto its nodes and re-measure it. */
function repin(e: RoadEdge, nodes: RoadNode[]) {
  const n = e.cum.length;
  e.pts[0] = nodes[e.a].x; e.pts[1] = nodes[e.a].z;
  e.pts[(n - 1) * 2] = nodes[e.b].x; e.pts[(n - 1) * 2 + 1] = nodes[e.b].z;
  for (let i = 1; i < n; i++) {
    e.cum[i] = e.cum[i - 1] + Math.hypot(e.pts[i * 2] - e.pts[(i - 1) * 2], e.pts[i * 2 + 1] - e.pts[(i - 1) * 2 + 1]);
  }
  e.length = e.cum[n - 1];
}

/** Cruise cap for a road of this width, m/s. */
const speedFor = (width: number) =>
  width >= 16 ? TRAFFIC.speed.boulevard : width >= 10 ? TRAFFIC.speed.street : TRAFFIC.speed.lane;

/** The island's streets and the causeway, as polylines to planarise. */
function townPolys(): Poly[] {
  if (!TOWN_ENABLED) return [];
  const out: Poly[] = [];
  const at = (along: number, across: number): [number, number] => {
    const [x, , z] = stationPoint(along, across);
    return [x, z];
  };
  for (const street of STREETS) {
    const pts: [number, number][] = street.axis === 'along'
      ? [at(street.from, street.at), at(street.to, street.at)]
      : [at(street.at, street.from), at(street.at, street.to)];
    out.push({ pts, width: street.width, speed: TRAFFIC.speed.town, snap: true });
  }
  // The crossing deck itself, between the two link streets' ramp ends.
  out.push({
    pts: [at(CROSSING.along, CROSSING.fromAcross - CROSSING.ramp), at(CROSSING.along, CROSSING.toAcross + CROSSING.ramp)],
    width: CROSSING.halfWidth * 2 - 2 * 5, speed: TRAFFIC.speed.lane, gate: true, snap: true,
  });
  for (const chain of RING_CHAINS) {
    if (chain.length < 2) continue;
    out.push({ pts: chain.map((s) => at(s.along, s.across)), width: RING.width, speed: TRAFFIC.speed.street, snap: true });
  }
  if (BRIDGE) {
    out.push({
      pts: [[BRIDGE.x, BRIDGE.cityZ], [BRIDGE.x, BRIDGE.islandZ]],
      width: BRIDGE.halfWidth * 2, speed: TRAFFIC.speed.street, snap: true,
    });
  }
  return out;
}

let graph: RoadGraph | null = null;

/** The whole network. Built on first use, never rebuilt. */
export function getRoadGraph(): RoadGraph {
  if (graph) return graph;

  // The city arrives noded; it still goes through planarise so the causeway's
  // city end can be snapped onto whichever street it lands in.
  const polys: Poly[] = cityGraph.edges.map((e: { p: number[][]; w: number; oneWay?: number }) => ({
    pts: e.p.map(([x, z]) => [x, z] as [number, number]),
    width: e.w,
    // A roundabout is taken at walking-pace-plus, whatever the road into it.
    speed: e.oneWay ? TRAFFIC.turnSpeed.gentle : speedFor(e.w),
    // The file gives the ANTICLOCKWISE direction; that is right-hand traffic's.
    oneWay: e.oneWay ? ((e.oneWay * (TRAFFIC.driveOnRight ? 1 : -1)) as 1 | -1) : undefined,
  }));
  polys.push(...townPolys());
  const { nodes, edges } = contract(planarise(polys, TRAFFIC.graphSnap));

  const cell = 60;
  const grid = new Map<number, number[]>();
  const cellKey = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
  edges.forEach((e, i) => {
    const touched = new Set<number>();
    for (let k = 0; k < e.pts.length; k += 2) {
      touched.add(cellKey(Math.floor(e.pts[k] / cell), Math.floor(e.pts[k + 1] / cell)));
    }
    for (const k of touched) (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });

  graph = { nodes, edges, grid, cell };
  console.info(`[roads] ${nodes.length} junctions, ${edges.length} streets, `
    + `${(edges.reduce((s, e) => s + e.length, 0) / 1000).toFixed(1)} km`);
  return graph;
}

/* ------------------------------------------------------------- sampling */

/** Position and heading on the centreline at `t` metres from node `a`. */
function centreAt(e: RoadEdge, t: number, out: LanePose) {
  const n = e.cum.length;
  let i = 1;
  // Small edges: a linear scan is as fast as anything.
  while (i < n - 1 && e.cum[i] < t) i++;
  const t0 = e.cum[i - 1], t1 = e.cum[i];
  const f = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
  const ax = e.pts[(i - 1) * 2], az = e.pts[(i - 1) * 2 + 1];
  const bx = e.pts[i * 2], bz = e.pts[i * 2 + 1];
  out.x = ax + (bx - ax) * f;
  out.z = az + (bz - az) * f;
  out.heading = Math.atan2(-(bx - ax), -(bz - az));
}

const scratch: LanePose = { x: 0, z: 0, heading: 0 };

/**
 * Where a car `s` metres along a lane is, and which way it faces.
 *
 * The heading is taken slightly ahead and behind the point, which turns the
 * polyline's corners into a heading that changes over a car's length rather
 * than in one step — a car on a Chaikin curve is smooth already; this is for
 * the few edges that are two points and a bend.
 */
export function laneAt(g: RoadGraph, edge: number, dir: 1 | -1, s: number, out: LanePose): LanePose {
  const e = g.edges[edge];
  const t = dir > 0 ? s : e.length - s;
  centreAt(e, t, out);
  // Heading from a point behind to a point ahead, both clamped to the edge,
  // so the last metres into a node read the same direction as the run up to
  // them — a heading taken from the final segment alone kinks wherever the
  // node was pinned a little off the line, and that kink is a yaw spike on
  // every car that passes through.
  const look = Math.min(3, e.length / 2);
  const behind = Math.max(0, Math.min(e.length, t - dir * look));
  const ahead = Math.max(0, Math.min(e.length, t + dir * look));
  centreAt(e, behind, scratch);
  const bx = scratch.x, bz = scratch.z;
  centreAt(e, ahead, scratch);
  const fx = scratch.x - bx, fz = scratch.z - bz;
  const heading = Math.hypot(fx, fz) > 1e-3
    ? Math.atan2(-fx, -fz)
    : wrapAngle(out.heading + (dir > 0 ? 0 : Math.PI));
  out.heading = heading;
  // Offset to the driving side. Forward is (-sin h, -cos h); right is
  // forward x up = (cos h, -sin h). (The first traffic model had this as
  // (-cos h, sin h), which is the LEFT, and drove on the left while its
  // comments said right.)
  const side = TRAFFIC.driveOnRight ? 1 : -1;
  out.x += Math.cos(heading) * side * e.laneOffset;
  out.z += -Math.sin(heading) * side * e.laneOffset;
  return out;
}

/** The node a lane arrives at. */
export const laneEnd = (g: RoadGraph, edge: number, dir: 1 | -1) => (dir > 0 ? g.edges[edge].b : g.edges[edge].a);
/** The node a lane leaves from. */
export const laneStart = (g: RoadGraph, edge: number, dir: 1 | -1) => (dir > 0 ? g.edges[edge].a : g.edges[edge].b);

/** Direction of travel on `edge` when entering it from `node`. */
export const dirFrom = (g: RoadGraph, edge: number, node: number): 1 | -1 => (g.edges[edge].a === node ? 1 : -1);

/** Heading a lane has as it leaves `node` along `edge`. */
export function exitHeading(g: RoadGraph, edge: number, node: number): number {
  const dir = dirFrom(g, edge, node);
  laneAt(g, edge, dir, Math.min(4, g.edges[edge].length / 2), scratch);
  return scratch.heading;
}

/** Heading a lane has as it arrives at its end. */
export function arriveHeading(g: RoadGraph, edge: number, dir: 1 | -1): number {
  const e = g.edges[edge];
  laneAt(g, edge, dir, Math.max(0, e.length - Math.min(4, e.length / 2)), scratch);
  return scratch.heading;
}

/**
 * Edge indices near a point. Every cell the radius touches, so it over-reports
 * rather than misses.
 */
export function edgesNear(g: RoadGraph, x: number, z: number, radius: number, out: number[]): number[] {
  out.length = 0;
  const c = g.cell;
  const x0 = Math.floor((x - radius) / c), x1 = Math.floor((x + radius) / c);
  const z0 = Math.floor((z - radius) / c), z1 = Math.floor((z + radius) / c);
  const seen = new Set<number>();
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const list = g.grid.get(cx * 73856093 ^ cz * 19349663);
    if (!list) continue;
    for (const i of list) if (!seen.has(i)) { seen.add(i); out.push(i); }
  }
  return out;
}

const nearScratch: number[] = [];

/**
 * The lane nearest a world point, within `maxDist` — the one a car at that
 * point and facing `heading` would be in. Used to put the player into the
 * traffic's frame (so cars queue behind them) and to spawn.
 */
export function nearestLane(g: RoadGraph, x: number, z: number, heading: number, maxDist: number): LaneFix | null {
  edgesNear(g, x, z, maxDist, nearScratch);
  let best: LaneFix | null = null;
  for (const ei of nearScratch) {
    const e = g.edges[ei];
    for (let i = 0; i + 3 < e.pts.length; i += 2) {
      const ax = e.pts[i], az = e.pts[i + 1], bx = e.pts[i + 2], bz = e.pts[i + 3];
      const ex = bx - ax, ez = bz - az; const l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const px = ax + ex * t, pz = az + ez * t;
      const d = Math.hypot(px - x, pz - z);
      if (d > maxDist + e.laneOffset) continue;
      const along = e.cum[i / 2] + Math.hypot(px - ax, pz - az);
      // The direction whose lane the point is actually on: the one whose
      // heading agrees with the car, or failing that the nearer offset.
      const hAB = Math.atan2(-ex, -ez);
      const dir: 1 | -1 = Math.abs(wrapAngle(heading - hAB)) < Math.PI / 2 ? 1 : -1;
      const s = dir > 0 ? along : e.length - along;
      laneAt(g, ei, dir, s, scratch);
      const dist = Math.hypot(scratch.x - x, scratch.z - z);
      if (dist <= maxDist && (!best || dist < best.distance)) best = { edge: ei, dir, s, distance: dist };
    }
  }
  return best;
}
