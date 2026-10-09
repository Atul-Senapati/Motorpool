import { KERB_TOP, ROAD_PAVEMENT, ROAD_TOP, ROAD_WIDTH } from './roadConfig';
import {
  KESTREL_ARCS, KESTREL_NODES, KESTREL_ROADS_ENABLED, KESTREL_RUNS, KESTREL_SWEEPS, kestrelArcPoints,
  sweepPoints,
} from './kestrelRoads';
import { STATION_SITE, stationPoint } from './stationConfig';
import { ROAD_RUNS } from './roadConfig';
import { AIRPORT_ENABLED, SITE as AIRPORT } from './airportConfig';
import cityWalks from './cityWalks.json';

/**
 * Kestrel's pedestrians: where they can walk, and how many there are.
 *
 * The people are the animated crowd (`prepare-crowd.mjs`), and they walk the
 * **pavements the road kit already draws**. Every kit tile is 19 m wide and
 * its outer 14.3% each side is footway (`ROAD_PAVEMENT`), so a street's two
 * pavements run 8.1 m either side of its centreline — and the footway network
 * is the road network, offset. Nothing new is built on the ground for them.
 *
 * ## The network
 *
 * Only the grid: the avenues and the cross streets, whose runs both end on a
 * junction. Each junction has four pavement corners; each run joins the
 * corners on its two sides; and where a junction has no road on one side, the
 * two corners on that side are joined too — that is the pavement carrying on
 * round a T or a corner. Where it DOES have a road, a `crossing` edge goes
 * over it, so people change blocks at junctions rather than mid-street. There
 * are no zebras and no traffic to wait for; they just cross.
 *
 * Everything is in the station's (along, across) frame and turned into world
 * metres once, here.
 */

/** No more than this many people are ever out at once. */
export const PEOPLE_MAX = 40;

/** They appear no nearer than this to the player, and no further. */
export const SPAWN_NEAR = 30;
export const SPAWN_FAR = 80;
/** ...and are taken away again beyond this. */
export const DESPAWN = 110;

/**
 * Walking speed range, m/s. The clip's planted foot slides back at 1.53 m/s at
 * normal playback (measured off `crowd0`), so playback rate is speed / 1.53
 * and the feet do not skate.
 */
export const WALK_SPEED: readonly [number, number] = [1.15, 1.6];
export const CLIP_SPEED = 1.53;
/**
 * Running away. The walk played fast is not a sprint — at much over twice the
 * rate it stops looking like legs — so this is a jog that clears a car's line.
 */
export const RUN_SPEED = 3.6;

/** Share of spawns that are a standing group of two or three, not a walker. */
export const GROUP_SHARE = 0.25;
/** Chance a walker at a junction crosses the road rather than turning. */
export const CROSS_CHANCE = 0.2;

/** The pavement's middle line, from a road's centreline. */
const PAVE = ROAD_WIDTH / 2 - (ROAD_WIDTH * ROAD_PAVEMENT) / 2;
const HALF = ROAD_WIDTH / 2;

export interface WalkNode {
  /** World position on the ground. */
  x: number;
  z: number;
  /** The raised footway's top here — Kestrel's and Halcyon's ground differ. */
  y: number;
  /** Indices into `PEOPLE_EDGES`. */
  edges: number[];
}
export interface WalkEdge {
  a: number;
  b: number;
  length: number;
  /** Over a carriageway rather than along a pavement. */
  crossing: boolean;
  /**
   * Along a street's raised footway (the kit models a straight's), rather than
   * across a junction tile, which the kit paints flat at road level. Its first
   * and last `inset` metres are still on the tile.
   */
  raised: boolean;
  /** How far in from each end the footway is raised: `JUNCTION_INSET` on the kit's islands, 0 in the city. */
  inset?: number;
  /** How far below the footway the road is, where this edge is not raised: `ROAD_DIP` unless set. */
  dip?: number;
}

const nodes: WalkNode[] = [];
const edges: WalkEdge[] = [];
/** A street's raised footway top on Kestrel (the kit models it), which is where people stand. */
const KESTREL_FOOTWAY = (STATION_SITE?.ground ?? 0) + KERB_TOP;

if (KESTREL_ROADS_ENABLED && STATION_SITE) {
  const grid = KESTREL_NODES.filter((n) => n.label.includes(' at '));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const nodeAt = (across: number, along: number) => grid.findIndex((n) => near(n.across, across) && near(n.along, along));

  // Corner (ni, sa, sl): sa = +1 on the far side across, sl = +1 on the far side along.
  const corners = new Map<string, number>();
  const corner = (ni: number, sa: number, sl: number) => {
    const key = `${ni}:${sa}:${sl}`;
    let id = corners.get(key);
    if (id === undefined) {
      const n = grid[ni];
      const [x, , z] = stationPoint(n.along + sl * PAVE, n.across + sa * PAVE);
      id = nodes.push({ x, z, y: KESTREL_FOOTWAY, edges: [] }) - 1;
      corners.set(key, id);
    }
    return id;
  };
  const link = (a: number, b: number, crossing = false, raised = false) => {
    const length = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    const id = edges.push({ a, b, length, crossing, raised }) - 1;
    nodes[a].edges.push(id);
    nodes[b].edges.push(id);
  };

  // Arms: which sides of each junction have road, read off EVERY run's ends —
  // including the ones that leave the grid — so no pavement is drawn across a
  // radial or a crossing approach.
  const arms = grid.map(() => ({ N: false, S: false, E: false, W: false }));
  for (const run of KESTREL_RUNS) {
    for (const [end, other] of [[run.from, run.to], [run.to, run.from]] as const) {
      const [ac, al] = end;
      if (near(ac, other[0])) {
        // Runs along: the junction is HALF beyond this end.
        const dir = Math.sign(al - other[1]);
        const ni = nodeAt(ac, al + dir * HALF);
        if (ni >= 0) arms[ni][dir > 0 ? 'W' : 'E'] = true;
      } else if (near(al, other[1])) {
        const dir = Math.sign(ac - other[0]);
        const ni = nodeAt(ac + dir * HALF, al);
        if (ni >= 0) arms[ni][dir > 0 ? 'S' : 'N'] = true;
      }
    }
  }

  // Pavements along each grid run, both sides. A run with an end that is not a
  // junction — one that runs into a swept bend — is laid as a chain instead.
  const orphans: typeof KESTREL_RUNS[number][] = [];
  for (const run of KESTREL_RUNS) {
    if (!/^(avenue|cross) /.test(run.label)) continue;
    const [fa, fl] = run.from;
    const [ta, tl] = run.to;
    if (near(fa, ta)) {
      const a = nodeAt(fa, fl - HALF);
      const b = nodeAt(ta, tl + HALF);
      if (a < 0 || b < 0) { orphans.push(run); continue; }
      for (const s of [-1, 1]) link(corner(a, s, 1), corner(b, s, -1), false, true);
    } else {
      const a = nodeAt(fa - HALF, fl);
      const b = nodeAt(ta + HALF, tl);
      if (a < 0 || b < 0) { orphans.push(run); continue; }
      for (const s of [-1, 1]) link(corner(a, 1, s), corner(b, -1, s), false, true);
    }
  }

  // Round the junctions: along the kerb where there is no road, over it where there is.
  grid.forEach((_, ni) => {
    const has = arms[ni];
    const side = (open: boolean, a: [number, number], b: [number, number]) => {
      link(corner(ni, a[0], a[1]), corner(ni, b[0], b[1]), open);
    };
    side(has.E, [-1, 1], [1, 1]);
    side(has.W, [-1, -1], [1, -1]);
    side(has.N, [1, -1], [1, 1]);
    side(has.S, [-1, -1], [-1, 1]);
  });

  /*
   * The curved roads, and the straights that leave the grid.
   *
   * The crescent at the west end, the shore road's two S-bends, and the radials
   * that run from the grid out to the crescent have no junction corners to hang
   * a pavement between, so each gets its footways as a chain of points 8.1 m
   * either side of its centreline, a few metres apart. A chain's ends are then
   * joined to whatever footway point is nearest — a junction corner, or another
   * chain where a radial meets the crescent — so it is one network to walk.
   *
   * Every one of them has a raised footway now — the curves are swept with the
   * kit straight's own section (`KestrelRoads`) — so people walk them up on it.
   */
  const chainEnds: Array<{ node: number; chain: number }> = [];
  let chainId = 0;
  const chain = (points: ReadonlyArray<readonly [number, number]>, raised: boolean) => {
    // Resample to about every 4 m, so a tight bend is still a bend.
    const dense: Array<[number, number]> = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const [a0, l0] = points[i];
      const [a1, l1] = points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(a1 - a0, l1 - l0) / 4));
      for (let k = 0; k < steps; k++) dense.push([a0 + ((a1 - a0) * k) / steps, l0 + ((l1 - l0) * k) / steps]);
    }
    dense.push([points[points.length - 1][0], points[points.length - 1][1]]);
    if (dense.length < 2) return;
    for (const side of [-1, 1]) {
      const id = chainId++;
      let prev = -1;
      for (let i = 0; i < dense.length; i++) {
        const [pa, pl] = dense[Math.max(0, i - 1)];
        const [qa, ql] = dense[Math.min(dense.length - 1, i + 1)];
        const len = Math.hypot(qa - pa, ql - pl) || 1;
        // Normal to the road in (across, along).
        const na = -(ql - pl) / len;
        const nl = (qa - pa) / len;
        const [x, , z] = stationPoint(dense[i][1] + nl * PAVE * side, dense[i][0] + na * PAVE * side);
        const node = nodes.push({ x, z, y: KESTREL_FOOTWAY, edges: [] }) - 1;
        if (prev >= 0) link(prev, node, false, raised);
        else chainEnds.push({ node, chain: id });
        prev = node;
      }
      chainEnds.push({ node: prev, chain: id });
    }
  };
  for (const sweep of KESTREL_SWEEPS) chain(sweepPoints(sweep), true);
  for (const arc of KESTREL_ARCS) chain(kestrelArcPoints(arc), true);
  // Every kit straight that is not a grid street: the radials, the shore road,
  // the bridge link and the crossing approaches.
  for (const run of KESTREL_RUNS) {
    if (!/^(avenue|cross) /.test(run.label)) chain([run.from, run.to], true);
  }
  for (const run of orphans) chain([run.from, run.to], true);
  // Join each chain's ends to the nearest footway point that is not its own.
  const owner = new Map<number, number>();
  for (const end of chainEnds) owner.set(end.node, end.chain);
  const firstChainNode = chainEnds.length ? Math.min(...chainEnds.map((e) => e.node)) : nodes.length;
  for (const end of chainEnds) {
    const here = nodes[end.node];
    let best = -1;
    // A junction tile's width: far enough to reach the footway on the other
    // side of a T the chains do not have corners for.
    let bestD = 21;
    for (let i = 0; i < nodes.length; i++) {
      if (i === end.node) continue;
      // Not a point on its own chain: grid corners, or other chains' points.
      if (i >= firstChainNode && chainOf(i) === end.chain) continue;
      const d = Math.hypot(nodes[i].x - here.x, nodes[i].z - here.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && !nodes[end.node].edges.some((e) => edges[e].a === best || edges[e].b === best)) {
      // Longer than a step and it goes over a carriageway: a crossing.
      link(end.node, best, bestD > 6, false);
    }
  }
  /** Which chain a chain node belongs to, by walking to one of its ends. */
  function chainOf(node: number): number {
    const seen = new Set<number>();
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (owner.has(n)) return owner.get(n)!;
      seen.add(n);
      for (const e of nodes[n].edges) {
        const o = edges[e].a === n ? edges[e].b : edges[e].a;
        if (!seen.has(o) && o >= firstChainNode) stack.push(o);
      }
    }
    return -1;
  }
}

/*
 * Halcyon — the airport island. Its streets are the same kit, so its
 * pavements are the same 8.1 m either side of each road; but they are all
 * straight runs between junction tiles (`ROAD_RUNS`), so each gets its two
 * footways as a chain, and each chain's ends join the nearest footway point
 * of another chain — round a corner, or over a junction (a crossing).
 */
const halcyonFrom = nodes.length;
if (AIRPORT_ENABLED) {
  const c = Math.cos(AIRPORT.heading);
  const sn = Math.sin(AIRPORT.heading);
  const world = (x: number, z: number): [number, number] => [
    AIRPORT.centre[0] + x * c + z * sn, AIRPORT.centre[1] - x * sn + z * c,
  ];
  const ground = AIRPORT.ground + KERB_TOP;
  const chainOfNode: number[] = [];
  const ends: number[] = [];
  let chainId = 0;
  const link = (a: number, b: number, crossing: boolean, raised: boolean) => {
    const length = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    const id = edges.push({ a, b, length, crossing, raised }) - 1;
    nodes[a].edges.push(id);
    nodes[b].edges.push(id);
  };
  for (const run of ROAD_RUNS) {
    const [fx, fz] = run.from;
    const [tx, tz] = run.to;
    const len = Math.hypot(tx - fx, tz - fz);
    if (len < 4) continue;
    const ux = (tx - fx) / len;
    const uz = (tz - fz) / len;
    const steps = Math.max(1, Math.ceil(len / 6));
    for (const side of [-1, 1]) {
      const id = chainId++;
      let prev = -1;
      for (let k = 0; k <= steps; k++) {
        const t = (len * k) / steps;
        const [x, z] = world(fx + ux * t - uz * PAVE * side, fz + uz * t + ux * PAVE * side);
        const node = nodes.push({ x, z, y: ground, edges: [] }) - 1;
        chainOfNode[node] = id;
        if (prev >= 0) link(prev, node, false, true);
        else ends.push(node);
        prev = node;
      }
      ends.push(prev);
    }
  }
  // Each end joins the nearest point of the two nearest other chains: at a
  // corner that is the footway carrying on round it and the one across the
  // junction — one join alone left most of the island unreachable.
  for (const end of ends) {
    const here = nodes[end];
    const best = new Map<number, { node: number; d: number }>();
    for (let i = halcyonFrom; i < nodes.length; i++) {
      const chain = chainOfNode[i];
      if (chain === chainOfNode[end]) continue;
      const d = Math.hypot(nodes[i].x - here.x, nodes[i].z - here.z);
      if (d >= 21) continue;
      const known = best.get(chain);
      if (!known || d < known.d) best.set(chain, { node: i, d });
    }
    const picks = [...best.values()].sort((a, b) => a.d - b.d).slice(0, 2);
    for (const { node, d } of picks) {
      if (here.edges.some((e) => edges[e].a === node || edges[e].b === node)) continue;
      link(end, node, d > 6, false);
    }
  }
}

/*
 * The city — the mainland, and Curlew on its west — off its own mesh: its
 * footways are the raised `Blocks` slabs along every street, laid as chains
 * either side of the traffic's centrelines and joined round corners and
 * over the road (`scripts/make-city-walks.mjs`). Unlike the kit islands the
 * ground is not one height: every node has its own, and the kerb is the
 * mesh's 15 cm. Petrel, the circuit, is left out.
 */
const cityFrom = nodes.length;
{
  const walks = cityWalks as { nodes: [number, number, number][]; edges: [number, number, number, number][] };
  for (const [x, y, z] of walks.nodes) nodes.push({ x, z, y, edges: [] });
  for (const [a, b, crossing, dip] of walks.edges) {
    const na = nodes[cityFrom + a];
    const nb = nodes[cityFrom + b];
    const id = edges.push({
      a: cityFrom + a, b: cityFrom + b, length: Math.hypot(na.x - nb.x, na.z - nb.z),
      crossing: crossing === 1, raised: crossing !== 1, inset: 0, dip,
    }) - 1;
    na.edges.push(id);
    nb.edges.push(id);
  }
}

export const PEOPLE_NODES: readonly WalkNode[] = nodes;
export const PEOPLE_EDGES: readonly WalkEdge[] = edges;
export const PEOPLE_ENABLED = nodes.length > 0;

/** Kestrel's raised footway top — kept for the beach code, which is Kestrel's alone. */
export const PEOPLE_GROUND = KESTREL_FOOTWAY;
/**
 * How far below that the road is — and a junction tile, whose footway the kit
 * paints flat. People step down onto it at every corner.
 */
export const ROAD_DIP = KERB_TOP - ROAD_TOP;
/** How far a street pavement edge runs over the junction tile at each end. */
export const JUNCTION_INSET = HALF - PAVE;

/**
 * World-space boxes round each island's network, padded by the spawn radius,
 * for "is the player here", with that island's footway height.
 */
function areaOf(list: readonly WalkNode[], flat = true) {
  const xs = list.map((n) => n.x);
  const zs = list.map((n) => n.z);
  return {
    x0: Math.min(...xs) - SPAWN_FAR,
    x1: Math.max(...xs) + SPAWN_FAR,
    z0: Math.min(...zs) - SPAWN_FAR,
    z1: Math.max(...zs) + SPAWN_FAR,
    /** The footway's height, where it is one height all over; null where the ground rolls (the city). */
    ground: flat ? list[0].y : null,
  };
}
/** Kestrel, Halcyon, then the city — whose box takes in both islands, so it is looked up last. */
export const PEOPLE_AREAS = ([
  [nodes.slice(0, halcyonFrom), true], [nodes.slice(halcyonFrom, cityFrom), true], [nodes.slice(cityFrom), false],
] as const).filter(([list]) => list.length > 0).map(([list, flat]) => areaOf(list, flat));
