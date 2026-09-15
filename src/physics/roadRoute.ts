import { getRoadGraph, type RoadEdge, type RoadGraph } from './roadGraph';

/**
 * Shortest driving route between two points, over the same road graph the
 * traffic drives.
 *
 * The map used to draw a straight dashed line from the car to the waypoint,
 * which is honest about *where* but useless about *how*: this city is a grid
 * with a river, two islands and a causeway, so the straight line regularly
 * points across water. This walks the streets instead.
 *
 * It is A\* over junctions, weighted by length, with the pieces of the first
 * and last street handled outside the search: a route starts and ends wherever
 * the car and the pin happen to be along a street, not at the junctions either
 * side of them. So the search runs between the *ends* of those two streets —
 * seeded with the cost of reaching each end, finished with the cost of leaving
 * each end — and the partial stretches are stitched on afterwards.
 *
 * One-way streets are respected, because a route the wrong way up one is a
 * route no driver would take. If that makes the destination unreachable —
 * a mistake in the graph, or a pin somewhere only reachable against the
 * arrows — the search is run again ignoring them rather than telling the
 * player there is no way there. A slightly wrong line beats a blank map.
 */

export interface Route {
  /** The path as flat world [x0, z0, x1, z1, ...]. */
  points: Float64Array;
  /** Its length, in metres. */
  metres: number;
}

/** Where a point sits on a street: which one, how far along, how far away. */
interface EdgeFix {
  edge: number;
  /** Metres along the centreline from the edge's `a` node. */
  t: number;
  /** Metres from the query point to the centreline. */
  distance: number;
}

/** Position on an edge's centreline at `t` metres from `a`. */
function pointAt(e: RoadEdge, t: number): [number, number] {
  const clamped = Math.max(0, Math.min(e.length, t));
  let i = 1;
  while (i < e.cum.length - 1 && e.cum[i] < clamped) i += 1;
  const span = e.cum[i] - e.cum[i - 1] || 1;
  const f = (clamped - e.cum[i - 1]) / span;
  const ax = e.pts[(i - 1) * 2], az = e.pts[(i - 1) * 2 + 1];
  const bx = e.pts[i * 2], bz = e.pts[i * 2 + 1];
  return [ax + (bx - ax) * f, az + (bz - az) * f];
}

/**
 * The stretch of an edge between two distances, as world points.
 *
 * Both ends are interpolated rather than snapped to the nearest vertex, so the
 * drawn route meets the car and the pin exactly instead of jumping to the end
 * of the block. Reversed when `from` is past `to`, which is how an edge walked
 * b -> a comes out.
 */
function slice(e: RoadEdge, from: number, to: number): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out: number[] = [];
  const [sx, sz] = pointAt(e, lo);
  out.push(sx, sz);
  for (let i = 0; i < e.cum.length; i += 1) {
    if (e.cum[i] > lo && e.cum[i] < hi) out.push(e.pts[i * 2], e.pts[i * 2 + 1]);
  }
  const [ex, ez] = pointAt(e, hi);
  out.push(ex, ez);
  if (from > to) {
    const flipped: number[] = [];
    for (let i = out.length - 2; i >= 0; i -= 2) flipped.push(out[i], out[i + 1]);
    return flipped;
  }
  return out;
}

/** Closest point on one edge to (x, z), as a distance along it. */
function project(e: RoadEdge, x: number, z: number): { t: number; distance: number } {
  let best = { t: 0, distance: Infinity };
  for (let i = 1; i < e.cum.length; i += 1) {
    const ax = e.pts[(i - 1) * 2], az = e.pts[(i - 1) * 2 + 1];
    const bx = e.pts[i * 2], bz = e.pts[i * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const f = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const cx = ax + dx * f, cz = az + dz * f;
    const d = Math.hypot(x - cx, z - cz);
    if (d < best.distance) best = { t: e.cum[i - 1] + (e.cum[i] - e.cum[i - 1]) * f, distance: d };
  }
  return best;
}

/**
 * The nearest street to a point, searched outward through the spatial hash.
 *
 * Rings rather than one big radius: the first hit is the closest, and a car on
 * a road — the usual case — costs one cell's worth of work.
 */
function nearestEdge(g: RoadGraph, x: number, z: number, maxMetres = 400): EdgeFix | null {
  const cx = Math.floor(x / g.cell);
  const cz = Math.floor(z / g.cell);
  const key = (a: number, b: number) => a * 73856093 ^ b * 19349663;
  const seen = new Set<number>();
  // Three numbers rather than an object: the compiler cannot follow an
  // `EdgeFix | null` assigned only inside three nested loops, and decides it is
  // still null by the time the ring check reads it.
  let bestEdge = -1;
  let bestT = 0;
  let bestDistance = Infinity;

  for (let ring = 0; ring <= Math.ceil(maxMetres / g.cell); ring += 1) {
    for (let dz = -ring; dz <= ring; dz += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        // Only the new perimeter; the inside was covered by a smaller ring.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        for (const ei of g.grid.get(key(cx + dx, cz + dz)) ?? []) {
          if (seen.has(ei)) continue;
          seen.add(ei);
          const hit = project(g.edges[ei], x, z);
          if (hit.distance < bestDistance) {
            bestEdge = ei;
            bestT = hit.t;
            bestDistance = hit.distance;
          }
        }
      }
    }
    // A hit inside the ring already searched cannot be beaten by a further one.
    if (bestEdge >= 0 && bestDistance <= ring * g.cell) {
      return { edge: bestEdge, t: bestT, distance: bestDistance };
    }
  }
  return bestEdge >= 0 ? { edge: bestEdge, t: bestT, distance: bestDistance } : null;
}

/** A tiny binary heap; the graph is thousands of nodes, not millions. */
class Heap {
  private items: Array<{ node: number; f: number }> = [];

  push(node: number, f: number) {
    this.items.push({ node, f });
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].f <= this.items[i].f) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }

  pop(): number | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (last && this.items.length) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.items.length && this.items[l].f < this.items[s].f) s = l;
        if (r < this.items.length && this.items[r].f < this.items[s].f) s = r;
        if (s === i) break;
        [this.items[s], this.items[i]] = [this.items[i], this.items[s]];
        i = s;
      }
    }
    return top?.node;
  }

  get size() { return this.items.length; }
}

/** Whether `edge` may be driven from `node`. */
function passable(g: RoadGraph, edge: number, from: number, oneWay: boolean): boolean {
  if (!oneWay) return true;
  const e = g.edges[edge];
  if (!e.oneWay) return true;
  return e.oneWay === 1 ? e.a === from : e.b === from;
}

function search(
  g: RoadGraph, starts: Map<number, number>, goals: Map<number, number>, oneWay: boolean,
): { node: number; cameFrom: Map<number, { node: number; edge: number }>; cost: number } | null {
  const best = new Map<number, number>();
  const cameFrom = new Map<number, { node: number; edge: number }>();
  const open = new Heap();
  // The heuristic aims at whichever end of the destination street is nearer;
  // both are goals, so it must not overestimate the distance to either.
  const targets = [...goals.keys()].map((n) => g.nodes[n]);
  const h = (n: number) => {
    const node = g.nodes[n];
    let min = Infinity;
    for (const t of targets) min = Math.min(min, Math.hypot(node.x - t.x, node.z - t.z));
    return min === Infinity ? 0 : min;
  };

  for (const [node, cost] of starts) {
    best.set(node, cost);
    open.push(node, cost + h(node));
  }

  let bestGoal: { node: number; cost: number } | null = null;
  while (open.size) {
    const node = open.pop();
    if (node === undefined) break;
    const cost = best.get(node);
    if (cost === undefined) continue;
    // Everything still queued is at least this far out, so nothing left can
    // beat a finished goal.
    if (bestGoal && cost + h(node) >= bestGoal.cost) break;

    const exit = goals.get(node);
    if (exit !== undefined && (!bestGoal || cost + exit < bestGoal.cost)) {
      bestGoal = { node, cost: cost + exit };
    }

    for (const edge of g.nodes[node].edges) {
      if (!passable(g, edge, node, oneWay)) continue;
      const e = g.edges[edge];
      const next = e.a === node ? e.b : e.a;
      const through = cost + e.length;
      if (through >= (best.get(next) ?? Infinity)) continue;
      best.set(next, through);
      cameFrom.set(next, { node, edge });
      open.push(next, through + h(next));
    }
  }

  if (!bestGoal) return null;
  return { node: bestGoal.node, cameFrom, cost: bestGoal.cost };
}

/**
 * The route from one world point to another, or null if there is no way.
 *
 * Cheap enough to call while driving — the graph is cached and a city-wide
 * search is a few thousand nodes — but not free, so callers run it on a timer
 * rather than per frame.
 */
export function findRoute(
  from: { x: number; z: number }, to: { x: number; z: number },
): Route | null {
  const g = getRoadGraph();
  const start = nearestEdge(g, from.x, from.z);
  const goal = nearestEdge(g, to.x, to.z);
  if (!start || !goal) return null;

  const startEdge = g.edges[start.edge];
  const goalEdge = g.edges[goal.edge];

  // Same street: no junctions involved, just the stretch between the two.
  if (start.edge === goal.edge) {
    const points = slice(startEdge, start.t, goal.t);
    return { points: Float64Array.from(points), metres: Math.abs(goal.t - start.t) };
  }

  const starts = new Map<number, number>([
    [startEdge.a, start.t],
    [startEdge.b, startEdge.length - start.t],
  ]);
  const goals = new Map<number, number>([
    [goalEdge.a, goal.t],
    [goalEdge.b, goalEdge.length - goal.t],
  ]);

  const found = search(g, starts, goals, true) ?? search(g, starts, goals, false);
  if (!found) return null;

  // Walk the chain back to whichever end of the starting street it began at.
  const chain: Array<{ node: number; edge: number }> = [];
  let node = found.node;
  for (;;) {
    const step = found.cameFrom.get(node);
    if (!step) break;
    chain.push({ node, edge: step.edge });
    node = step.node;
  }
  chain.reverse();

  const points: number[] = [];
  const push = (xs: number[]) => {
    for (let i = 0; i < xs.length; i += 2) {
      const n = points.length;
      // Edges meet at a junction, so every join would otherwise be doubled.
      if (n >= 2 && Math.abs(points[n - 2] - xs[i]) < 1e-6 && Math.abs(points[n - 1] - xs[i + 1]) < 1e-6) continue;
      points.push(xs[i], xs[i + 1]);
    }
  };

  // The part of the first street between the car and the junction it leaves by.
  push(slice(startEdge, start.t, node === startEdge.a ? 0 : startEdge.length));

  let at = node;
  for (const step of chain) {
    const e = g.edges[step.edge];
    push(e.a === at ? slice(e, 0, e.length) : slice(e, e.length, 0));
    at = step.node;
  }

  // And the part of the last street between that junction and the pin.
  push(slice(goalEdge, at === goalEdge.a ? 0 : goalEdge.length, goal.t));

  let metres = 0;
  for (let i = 2; i < points.length; i += 2) {
    metres += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  }
  return { points: Float64Array.from(points), metres };
}
