/**
 * Street centrelines for the NPC traffic, extracted from the nav raster.
 *
 * The city is a Sketchfab mesh; nobody drew its roads as lines, so the traffic
 * used to read the raster directly — probe a fan of headings, keep the one with
 * the most tarmac, trim off the kerb (`trafficAI`, first version). It worked
 * the way a line-following robot works and it drove the same way: every input
 * quantised to a 1.5 m pixel, every correction a visible wiggle, and a car in a
 * wide junction with no idea which of the four exits was "straight on".
 *
 * A graph fixes all of that at once. A car on a lane polyline sits exactly a
 * lane's width from the centreline, parallel to the kerb by construction; a
 * junction is a node with a known set of exits; and every other car is a
 * distance along the same lane, so spacing is arithmetic rather than a cone
 * test. This script builds that graph, once, from the same raster the old AI
 * read — so it can never disagree with the map about where the tarmac is.
 *
 * ## How
 *
 *   1. Street mask: the pixels `isDrivablePixel` accepts (R > 191), closed with
 *      a 3x3 pass so single-pixel holes do not become islands in the skeleton.
 *   2. Exact Euclidean distance transform, so every pixel knows how far it is
 *      from the kerb — which is the local half-width of the road.
 *   3. Zhang–Suen thinning to a one-pixel skeleton: the medial axis.
 *   4. Graph: skeleton pixels with other than two neighbours are junctions or
 *      ends; the runs between them are edges. Junction pixel clusters collapse
 *      to one node.
 *   5. Prune. Spurs (short dead ends) are the skeleton's reaction to every
 *      kerb-side notch and parking bay, and go. Edges wider than a boulevard are
 *      plazas and car parks — the medial axis of a square is a spider, not a
 *      road — and go too. Nodes left with two edges are spliced.
 *   6. Simplify (Douglas–Peucker) and smooth (Chaikin) each edge so the lane a
 *      car follows is a curve rather than a staircase of pixel centres.
 *
 * Emits `src/config/roadGraph.json`. Run with: npm run roads
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const NAV = 'public/models/cityNav.png';
const CITY = 'src/config/cityData.json';
const OUT = 'src/config/roadGraph.json';

/** Dead ends shorter than this are notches in the kerb, not streets. Metres. */
const SPUR = 14;
/** Wider than this is a square, not a street. Metres, kerb to kerb. */
const PLAZA = 26;
/** Narrower than this, and short, is a footpath the mesh happens to have
 *  paved rather than a street. Metres. */
const ALLEY = 4.5;
/** Junction nodes closer than this are one junction. Metres. */
const MERGE = 7;
/**
 * Douglas–Peucker tolerance, metres.
 *
 * Deliberately over a pixel. The medial axis of a street whose kerbs are
 * ragged at pixel scale wanders a pixel or two from side to side, and a car
 * that follows it faithfully weaves — which is the very thing the graph was
 * built to stop. At 2.2 m a grid street collapses to its chord and a bend of
 * any radius a car can take still keeps enough points to read as a curve
 * after smoothing.
 */
const SIMPLIFY = 2.2;
/** Components with less street than this are car parks with a gate. Metres. */
const MIN_COMPONENT = 1500;
/**
 * A dead end this close to other road, with tarmac most of the way, is a road
 * with something drawn across it — a barrier arm, a gantry's shadow, a seam in
 * the mesh — rather than a dead end. Metres.
 */
const GAP = 32;
/** Closing radius, pixels. 2 fills anything under 4 px (6 m) across. */
const CLOSE = 2;

const step = (msg) => console.log(`  ${msg}`);

const { nav } = JSON.parse(readFileSync(CITY, 'utf8'));
const img = sharp(NAV);
const { width: W, height: H } = await img.metadata();
const rgba = await img.ensureAlpha().raw().toBuffer();
if (W !== nav.width || H !== nav.height) throw new Error('cityNav.png does not match cityData.json');
const N = W * H;
const at = (x, z) => z * W + x;
const inside = (x, z) => x >= 0 && z >= 0 && x < W && z < H;

/* ------------------------------------------------------------ 1. the mask */

let mask = new Uint8Array(N);
for (let i = 0; i < N; i++) mask[i] = rgba[i * 4 + 3] > 0 && rgba[i * 4] > 191 ? 1 : 0;

/**
 * Dilate (`want` = 1) or erode (`want` = 0) by `r` pixels. Dilate then erode is
 * a morphological close: it fills gaps narrower than the kernel and leaves the
 * outline where it was. The raster carries a two-pixel band of "not road"
 * across several streets — a barrier arm or a seam in the source mesh that the
 * obstacle pass rasterised across the whole carriageway — and a skeleton of
 * the raw mask breaks at every one of them.
 */
function morph(src, want, r) {
  const out = new Uint8Array(N);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    let hit = want ? 0 : 1;
    scan: for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, nz = z + dz;
      const v = inside(nx, nz) ? src[at(nx, nz)] : 0;
      if (v === want) { hit = want; break scan; }
    }
    out[at(x, z)] = hit;
  }
  return out;
}
const raw = mask;
mask = morph(morph(mask, 1, CLOSE), 0, CLOSE);
let streetPx = 0; for (let i = 0; i < N; i++) streetPx += mask[i];
step(`street mask ${streetPx} px (${(streetPx * nav.metresPerPixel ** 2 / 1e4).toFixed(1)} ha)`);

/* ---------------------------------------------- 2. distance to the kerb */

/** Felzenszwalb–Huttenlocher exact EDT, squared, in pixels. */
function edt(mask) {
  const INF = 1e12;
  const f = new Float64Array(N);
  for (let i = 0; i < N; i++) f[i] = mask[i] ? INF : 0;
  const n = Math.max(W, H);
  const d = new Float64Array(n), v = new Int32Array(n), zb = new Float64Array(n + 1), g = new Float64Array(n);
  const dt1 = (len, get, set) => {
    let k = 0; v[0] = 0; zb[0] = -INF; zb[1] = INF;
    for (let q = 0; q < len; q++) g[q] = get(q);
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) {
        s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s <= zb[k]) { k--; if (k < 0) { k = 0; break; } } else break;
      }
      k++; v[k] = q; zb[k] = s; zb[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (zb[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + g[v[k]];
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < W; x++) dt1(H, (z) => f[at(x, z)], (z, val) => { f[at(x, z)] = val; });
  for (let z = 0; z < H; z++) dt1(W, (x) => f[at(x, z)], (x, val) => { f[at(x, z)] = val; });
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.sqrt(f[i]) * nav.metresPerPixel;
  return out;
}
const kerb = edt(mask);
step('distance transform done');

/* ---------------------------------------------------- 3. the skeleton */

/** Zhang–Suen thinning. Standard two-subiteration form. */
function thin(src) {
  const img = new Uint8Array(src);
  const P = (x, z) => (inside(x, z) ? img[at(x, z)] : 0);
  let changed = true, passes = 0;
  const kill = [];
  while (changed) {
    changed = false;
    for (let sub = 0; sub < 2; sub++) {
      kill.length = 0;
      for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
        const i = at(x, z);
        if (!img[i]) continue;
        const p2 = P(x, z - 1), p3 = P(x + 1, z - 1), p4 = P(x + 1, z), p5 = P(x + 1, z + 1);
        const p6 = P(x, z + 1), p7 = P(x - 1, z + 1), p8 = P(x - 1, z), p9 = P(x - 1, z - 1);
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let a = 0; for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
        if (a !== 1) continue;
        if (sub === 0 ? (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) : (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0)) continue;
        kill.push(i);
      }
      for (const i of kill) img[i] = 0;
      if (kill.length) changed = true;
    }
    passes++;
  }
  return { img, passes };
}
const { img: skel, passes } = thin(mask);
let skelPx = 0; for (let i = 0; i < N; i++) skelPx += skel[i];
step(`skeleton ${skelPx} px in ${passes} passes`);

/* ---------------------------------------------------- 4. pixels to graph */

const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const degree = new Uint8Array(N);
for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
  if (!skel[at(x, z)]) continue;
  let d = 0;
  for (const [dx, dz] of NB) if (inside(x + dx, z + dz) && skel[at(x + dx, z + dz)]) d++;
  degree[at(x, z)] = d;
}

// Junction / end pixels, clustered: a 4-way meeting of one-pixel lines is
// usually a 2x2 knot of degree-3 pixels, which is one node.
const nodeOf = new Int32Array(N).fill(-1);
const nodes = []; // { px: [..], x, z }
for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
  const i = at(x, z);
  if (!skel[i] || degree[i] === 2 || nodeOf[i] >= 0) continue;
  const id = nodes.length; const px = []; const stack = [i];
  nodeOf[i] = id;
  while (stack.length) {
    const j = stack.pop(); px.push(j);
    const jx = j % W, jz = (j - jx) / W;
    for (const [dx, dz] of NB) {
      const nx = jx + dx, nz = jz + dz;
      if (!inside(nx, nz)) continue;
      const k = at(nx, nz);
      if (skel[k] && degree[k] !== 2 && nodeOf[k] < 0) { nodeOf[k] = id; stack.push(k); }
    }
  }
  nodes.push({ px, x: 0, z: 0 });
}
for (const n of nodes) {
  let sx = 0, sz = 0;
  for (const j of n.px) { sx += j % W; sz += (j - (j % W)) / W; }
  n.x = sx / n.px.length; n.z = sz / n.px.length;
}
step(`${nodes.length} junction/end clusters`);

// Trace every run of degree-2 pixels between two clusters.
const visited = new Uint8Array(N);
let edges = []; // { a, b, pts: [[px,pz],...] }
const trace = (start, from) => {
  const pts = [];
  let cur = start, prev = from;
  for (;;) {
    visited[cur] = 1;
    const cx = cur % W, cz = (cur - cx) / W;
    pts.push([cx, cz]);
    let next = -1;
    for (const [dx, dz] of NB) {
      const nx = cx + dx, nz = cz + dz;
      if (!inside(nx, nz)) continue;
      const k = at(nx, nz);
      if (!skel[k] || k === prev || k === cur) continue;
      if (nodeOf[k] >= 0) { if (nodeOf[k] !== nodeOf[from] || pts.length > 2) return { pts, end: nodeOf[k] }; continue; }
      if (!visited[k]) { next = k; }
    }
    if (next < 0) return { pts, end: -1 };
    prev = cur; cur = next;
  }
};
for (let id = 0; id < nodes.length; id++) {
  for (const j of nodes[id].px) {
    const jx = j % W, jz = (j - jx) / W;
    for (const [dx, dz] of NB) {
      const nx = jx + dx, nz = jz + dz;
      if (!inside(nx, nz)) continue;
      const k = at(nx, nz);
      if (!skel[k] || nodeOf[k] >= 0 || visited[k]) continue;
      const { pts, end } = trace(k, j);
      if (end < 0) continue; // dangling run with no far node: dropped
      edges.push({ a: id, b: end, pts: [[jx, jz], ...pts, [nodes[end].x, nodes[end].z]] });
    }
  }
}
// Direct cluster-to-cluster adjacency (two knots touching) as zero-length edges.
for (let id = 0; id < nodes.length; id++) for (const j of nodes[id].px) {
  const jx = j % W, jz = (j - jx) / W;
  for (const [dx, dz] of NB) {
    const nx = jx + dx, nz = jz + dz;
    if (!inside(nx, nz)) continue;
    const k = at(nx, nz);
    if (skel[k] && nodeOf[k] >= 0 && nodeOf[k] > id) edges.push({ a: id, b: nodeOf[k], pts: [[jx, jz], [nx, nz]] });
  }
}
step(`${edges.length} raw edges`);

/* ------------------------------------------------------------ 5. prune */

const mpp = nav.metresPerPixel;
const toWorld = ([px, pz]) => [nav.originX + (px + 0.5) * mpp, nav.originZ + (pz + 0.5) * mpp];
const length = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };
const widthOf = (pts) => {
  const ws = pts.map(([px, pz]) => 2 * kerb[at(Math.round(px), Math.round(pz))]).sort((a, b) => a - b);
  return ws[ws.length >> 1];
};
for (const e of edges) { e.world = e.pts.map(toWorld); e.len = length(e.world); e.width = widthOf(e.pts); }

const alive = new Set(edges.map((_, i) => i));
/** Roundabout ring edges (see 5c), and their circulating direction: +1 when a->b. */
const ringEdges = new Set();
const ringDir = new Map();
const deg = () => { const d = new Map(); for (const i of alive) { const e = edges[i]; d.set(e.a, (d.get(e.a) ?? 0) + 1); d.set(e.b, (d.get(e.b) ?? 0) + 1); } return d; };

// Plazas first, so their spider legs become spurs and go in the next pass.
const pruned = []; // for the debug dump: [reason, world pts]
let plazas = 0;
for (const i of alive) if (edges[i].width > PLAZA) { alive.delete(i); plazas++; pruned.push(['plaza', edges[i].world, edges[i].width]); }
let alleys = 0;
// Only SHORT alleys. A long narrow run is a bridge or an underpass whose
// parapets the obstacle pass rasterised a pixel into the carriageway — the
// one road between two districts measured 3 m wide and was cut, which split
// the city in two.
for (const i of alive) if (edges[i].width < ALLEY && edges[i].len < 50) { alive.delete(i); alleys++; pruned.push(['alley', edges[i].world, edges[i].width]); }
let spurs = 0;
for (let round = 0; round < 12; round++) {
  const d = deg(); let cut = 0;
  for (const i of alive) {
    const e = edges[i];
    if (e.len < SPUR && ((d.get(e.a) ?? 0) === 1 || (d.get(e.b) ?? 0) === 1)) { alive.delete(i); cut++; pruned.push(['spur', e.world, e.width]); }
  }
  spurs += cut; if (!cut) break;
}
step(`pruned ${plazas} plaza edges, ${alleys} alleys, ${spurs} spurs -> ${alive.size} edges`);

// Splice degree-2 nodes so an edge runs junction to junction.
function splice() {
  for (;;) {
    const d = deg();
    const byNode = new Map();
    for (const i of alive) { const e = edges[i]; (byNode.get(e.a) ?? byNode.set(e.a, []).get(e.a)).push(i); (byNode.get(e.b) ?? byNode.set(e.b, []).get(e.b)).push(i); }
    let did = false;
    for (const [n, list] of byNode) {
      if (d.get(n) !== 2 || list.length !== 2 || list[0] === list[1]) continue;
      if (ringEdges.has(list[0]) || ringEdges.has(list[1])) continue;
      const [i, j] = list; const A = edges[i], B = edges[j];
      const aPts = A.a === n ? [...A.world].reverse() : [...A.world];
      const bPts = B.a === n ? [...B.world] : [...B.world].reverse();
      const start = A.a === n ? A.b : A.a; const end = B.a === n ? B.b : B.a;
      if (start === end && start === n) continue;
      const world = [...aPts, ...bPts.slice(1)];
      const w = (A.width * A.len + B.width * B.len) / Math.max(1e-6, A.len + B.len);
      edges.push({ a: start, b: end, world, len: length(world), width: w, pts: [] });
      alive.delete(i); alive.delete(j); alive.add(edges.length - 1);
      did = true; break;
    }
    if (!did) return;
  }
}
splice();

// Merge junctions that sit within a car's length of each other: the skeleton
// of a wide crossroads is two or three knots, and traffic wants one node.
function mergeNodes() {
  const pos = new Map();
  for (const i of alive) { const e = edges[i]; pos.set(e.a, e.world[0]); pos.set(e.b, e.world[e.world.length - 1]); }
  const ids = [...pos.keys()];
  const parent = new Map(ids.map((i) => [i, i]));
  const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
  for (let u = 0; u < ids.length; u++) for (let v = u + 1; v < ids.length; v++) {
    const p = pos.get(ids[u]), q = pos.get(ids[v]);
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) < MERGE) parent.set(find(ids[u]), find(ids[v]));
  }
  const groups = new Map();
  for (const i of ids) { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)).push(i); }
  const centre = new Map();
  for (const [r, list] of groups) {
    let sx = 0, sz = 0; for (const i of list) { const p = pos.get(i); sx += p[0]; sz += p[1]; }
    centre.set(r, [sx / list.length, sz / list.length]);
  }
  let merged = 0;
  for (const i of alive) {
    const e = edges[i]; const ra = find(e.a), rb = find(e.b);
    if (ra === rb) { alive.delete(i); merged++; continue; }
    e.a = ra; e.b = rb;
    e.world[0] = centre.get(ra); e.world[e.world.length - 1] = centre.get(rb);
    e.len = length(e.world);
  }
  return merged;
}
let merged = mergeNodes();
splice();

// Roundabouts. A roundabout thins to a ring of short edges between the
// spokes, and the cluster contraction below would collapse that ring to a
// point — after which every car crosses the roundabout through its middle,
// over the grass. So rings are found first and kept: a cycle of edges that
// closes within a roundabout's circumference, whose nodes all sit about the
// same distance from their centroid. Its edges are marked one-way, the
// circulating direction for the driving side, and left alone by everything
// that follows.
{
  const ROUND_MAX = 160; // metres of ring, i.e. up to ~50 m across
  const nodePos = new Map();
  for (const i of alive) { const e = edges[i]; nodePos.set(e.a, e.world[0]); nodePos.set(e.b, e.world[e.world.length - 1]); }
  const adj = new Map();
  for (const i of alive) { const e = edges[i]; (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)).push(i); (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)).push(i); }
  const other = (i, n) => (edges[i].a === n ? edges[i].b : edges[i].a);
  let found = 0;
  for (const start of alive) {
    if (ringEdges.has(start) || edges[start].len > ROUND_MAX / 3) continue;
    // Depth-first for a cycle through `start`, short edges only, bounded length.
    const e0 = edges[start];
    const stack = [{ node: e0.b, path: [start], len: e0.len }];
    let cycle = null;
    while (stack.length && !cycle) {
      const { node, path, len } = stack.pop();
      if (path.length > 12) continue;
      for (const j of adj.get(node) ?? []) {
        if (path.includes(j) || !alive.has(j)) continue;
        const f = edges[j];
        if (f.len > ROUND_MAX / 3) continue;
        const nlen = len + f.len;
        if (nlen > ROUND_MAX) continue;
        const to = other(j, node);
        if (to === e0.a && path.length >= 2) { cycle = [...path, j]; break; }
        if (path.some((k) => edges[k].a === to || edges[k].b === to)) continue;
        stack.push({ node: to, path: [...path, j], len: nlen });
      }
    }
    if (!cycle) continue;
    // Round, not a block: nodes at a consistent radius from the centroid.
    const ns = [...new Set(cycle.flatMap((k) => [edges[k].a, edges[k].b]))];
    const cx = ns.reduce((s, n) => s + nodePos.get(n)[0], 0) / ns.length;
    const cz = ns.reduce((s, n) => s + nodePos.get(n)[1], 0) / ns.length;
    const radii = ns.map((n) => Math.hypot(nodePos.get(n)[0] - cx, nodePos.get(n)[1] - cz));
    const rMean = radii.reduce((a, b) => a + b, 0) / radii.length;
    if (rMean < 6 || rMean > 28 || radii.some((r) => Math.abs(r - rMean) > rMean * 0.35)) continue;
    // And an island in the middle: a roundabout has one, a triangular knot of
    // skeleton in a wide junction does not. Tested on the raw mask, a few
    // pixels round the centroid.
    const cpx = Math.round((cx - nav.originX) / mpp - 0.5), cpz = Math.round((cz - nav.originZ) / mpp - 0.5);
    let island = 0, tested = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { tested++; if (!(inside(cpx + dx, cpz + dz) && raw[at(cpx + dx, cpz + dz)])) island++; }
    if (island / tested < 0.6) continue;
    // Circulating direction, recorded as the ANTICLOCKWISE sense (the runtime
    // flips it for left-hand traffic). Seen from above, +X right and +Z down,
    // anticlockwise goes east -> north -> west, and for a = (r, 0), b = (0, -r)
    // about the centre the cross product (a - c) x (b - a) is NEGATIVE.
    for (const k of cycle) {
      const e = edges[k];
      const a = e.world[0], b = e.world[e.world.length - 1];
      const cross = (a[0] - cx) * (b[1] - a[1]) - (a[1] - cz) * (b[0] - a[0]);
      ringEdges.add(k);
      ringDir.set(k, cross < 0 ? 1 : -1);
    }
    found++;
    step(`  roundabout at ${cx.toFixed(0)},${cz.toFixed(0)} r=${rMean.toFixed(0)} m, ${cycle.length} edges, ${ns.length} spokes`);
  }
  step(`found ${found} roundabout(s), ${ringEdges.size} ring edges kept one-way`);
}

// Junction clusters. A wide crossroads or a roundabout thins to a knot of
// several junction pixels joined by stubs a few metres long, and a car on
// one of those stubs is "between junctions" for a car's length — which is
// where the AI's one-node junction model breaks down: two lanes converge on
// the same tarmac with neither seeing the other. Any edge shorter than a
// junction is wide, with a junction at both ends, is contracted to a node.
const CLUSTER = 18;
for (let round = 0; round < 6; round++) {
  const d = deg();
  let did = false;
  for (const i of alive) {
    const e = edges[i];
    if (ringEdges.has(i) || e.len >= CLUSTER || e.a === e.b) continue;
    if ((d.get(e.a) ?? 0) < 3 || (d.get(e.b) ?? 0) < 3) continue;
    // Never pull a roundabout's spoke node into the ring's neighbour either.
    if ([...alive].some((j) => ringEdges.has(j) && (edges[j].a === e.a || edges[j].b === e.a || edges[j].a === e.b || edges[j].b === e.b))) continue;
    const mid = [(e.world[0][0] + e.world[e.world.length - 1][0]) / 2, (e.world[0][1] + e.world[e.world.length - 1][1]) / 2];
    for (const j of alive) {
      if (j === i) continue;
      const f = edges[j];
      if (f.a === e.b) f.a = e.a;
      if (f.b === e.b) f.b = e.a;
      if (f.a === e.a) { f.world[0] = mid; f.len = length(f.world); }
      if (f.b === e.a) { f.world[f.world.length - 1] = mid; f.len = length(f.world); }
    }
    alive.delete(i);
    merged++;
    did = true;
    break;
  }
  if (!did) break;
  round--; // keep going until nothing contracts
  if (merged > 5000) break;
}
// Edges that became loops or duplicates through contraction.
for (const i of alive) if (edges[i].a === edges[i].b && edges[i].len < CLUSTER * 2) alive.delete(i);
splice();
step(`merged junctions (${merged} stub edges absorbed) -> ${alive.size} edges`);

// Drop small disconnected components: a car park with its own internal lane.
{
  const adj = new Map();
  for (const i of alive) { const e = edges[i]; (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)).push(i); (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)).push(i); }
  const seenE = new Set(); let dropped = 0, kept = 0;
  for (const s of alive) {
    if (seenE.has(s)) continue;
    const comp = []; const stack = [s]; seenE.add(s);
    while (stack.length) { const i = stack.pop(); comp.push(i); for (const n of [edges[i].a, edges[i].b]) for (const j of adj.get(n)) if (!seenE.has(j)) { seenE.add(j); stack.push(j); } }
    const total = comp.reduce((acc, i) => acc + edges[i].len, 0);
    if (total < MIN_COMPONENT) { for (const i of comp) { alive.delete(i); pruned.push(['island', edges[i].world, edges[i].width]); } dropped++; } else kept++;
  }
  step(`${kept} connected component(s) kept, ${dropped} small ones dropped`);
}

/* --------------------------------------------- 5a. parallel duplicates */

// Two skeleton branches for one road. Where a street runs past a plaza or a
// parking apron the medial axis forks, and after the plaza's own spider is
// pruned two near-parallel edges can survive a lane's width apart, both
// feeding the same junctions. Cars on the two of them drive through each
// other. Where most of a shorter edge lies within a lane of a longer one,
// the shorter goes.
{
  const near = (p, poly, r) => {
    for (let i = 0; i < poly.length - 1; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[i + 1];
      const ex = bx - ax, ez = bz - az; const l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * ex + (p[1] - az) * ez) / l2));
      if (Math.hypot(ax + ex * t - p[0], az + ez * t - p[1]) <= r) return true;
    }
    return false;
  };
  let dups = 0;
  const list = [...alive].sort((i, j) => edges[i].len - edges[j].len);
  for (const i of list) {
    if (!alive.has(i)) continue;
    const e = edges[i];
    if (e.len < 8) continue;
    for (const j of alive) {
      if (j === i || edges[j].len <= e.len) continue;
      const f = edges[j];
      const r = Math.max(e.width, f.width) * 0.45;
      let hits = 0;
      for (const p of e.world) if (near(p, f.world, r)) hits++;
      if (hits / e.world.length >= 0.7) { alive.delete(i); dups++; pruned.push(['dup', e.world, e.width]); break; }
    }
  }
  splice();
  step(`dropped ${dups} parallel duplicate edges`);
}

/* ------------------------------------------------- 5b. bridge the gaps */

// A dead end whose tarmac carries on a few metres later is not a dead end.
// Walk out from it along its own direction; if another edge is met inside GAP
// with mostly road under the way, join them there.
{
  const d = deg();
  const ends = [];
  for (const i of alive) {
    const e = edges[i];
    if ((d.get(e.a) ?? 0) === 1) ends.push({ edge: i, node: e.a, p: e.world[0], q: e.world[Math.min(3, e.world.length - 1)] });
    if ((d.get(e.b) ?? 0) === 1) ends.push({ edge: i, node: e.b, p: e.world[e.world.length - 1], q: e.world[Math.max(0, e.world.length - 4)] });
  }
  const roadAt = (x, z) => { const px = Math.floor((x - nav.originX) / mpp), pz = Math.floor((z - nav.originZ) / mpp); return inside(px, pz) && raw[at(px, pz)] === 1; };
  let bridged = 0;
  for (const end of ends) {
    const dx = end.p[0] - end.q[0], dz = end.p[1] - end.q[1];
    const L = Math.hypot(dx, dz) || 1; const ux = dx / L, uz = dz / L;
    // Nearest point on any other live edge within GAP, ahead of the end.
    let best = null;
    for (const j of alive) {
      if (j === end.edge) continue;
      const f = edges[j];
      for (let k = 0; k < f.world.length; k++) {
        const [x, z] = f.world[k];
        const rx = x - end.p[0], rz = z - end.p[1];
        const dist = Math.hypot(rx, rz);
        if (dist > GAP || dist < 1) continue;
        const ahead = (rx * ux + rz * uz) / dist;
        if (ahead < 0.7) continue; // within ~45 degrees of straight on
        if (!best || dist < best.dist) best = { edge: j, k, dist, x, z };
      }
    }
    if (!best) continue;
    let road = 0, n = 0;
    for (let t = 0; t <= 1; t += 0.05) { n++; if (roadAt(end.p[0] + (best.x - end.p[0]) * t, end.p[1] + (best.z - end.p[1]) * t)) road++; }
    // Under half road and it is not a gap, it is a gap between two roads.
    if (road / n < 0.45) continue;
    // Split the target edge at k and hang the join off the new node.
    const f = edges[best.edge];
    const nid = nodes.length; nodes.push({ px: [], x: 0, z: 0 });
    const head = f.world.slice(0, best.k + 1), tail = f.world.slice(best.k);
    if (head.length >= 2) { edges.push({ a: f.a, b: nid, world: head, len: length(head), width: f.width, pts: [] }); alive.add(edges.length - 1); }
    if (tail.length >= 2) { edges.push({ a: nid, b: f.b, world: tail, len: length(tail), width: f.width, pts: [] }); alive.add(edges.length - 1); }
    alive.delete(best.edge);
    const join = [end.p, [best.x, best.z]];
    edges.push({ a: end.node, b: nid, world: join, len: length(join), width: edges[end.edge].width, pts: [] });
    alive.add(edges.length - 1);
    bridged++;
  }
  splice();
  step(`bridged ${bridged} gaps`);
}

/* ------------------------------------------------ 6. simplify and smooth */

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1];
  let idx = -1, max = -1;
  const L = Math.hypot(bx - ax, bz - az) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, pz] = pts[i];
    const d = Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / L;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...douglasPeucker(pts.slice(0, idx + 1), eps).slice(0, -1), ...douglasPeucker(pts.slice(idx), eps)];
}
function chaikin(pts, rounds) {
  let out = pts;
  for (let r = 0; r < rounds; r++) {
    if (out.length < 3) return out;
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, az] = out[i], [bx, bz] = out[i + 1];
      next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/* ------------------------------------------------------ 6b. re-centring */

// Everything above has moved points off the medial axis a little: junction
// centroids, merges, contraction midpoints, and a Douglas–Peucker chord
// between two displaced ends is displaced along its whole length. On a 12 m
// street three metres off centre puts one lane on the footway. So every
// point is put back on the centre of the road's cross-section — walk out
// perpendicular to the line in both directions until the tarmac ends, and
// take the midpoint — and every node is put at the centre of the tarmac
// around it.
const toPx = ([x, z]) => [(x - nav.originX) / mpp - 0.5, (z - nav.originZ) / mpp - 0.5];
const onMask = (px, pz) => { const X = Math.round(px), Z = Math.round(pz); return inside(X, Z) && mask[at(X, Z)] === 1; };
const REACH = 16; // pixels either side, i.e. a 48 m carriageway at most
function recentre(p, tangent) {
  const [px, pz] = toPx(p);
  if (!onMask(px, pz)) return p;
  const L = Math.hypot(tangent[0], tangent[1]) || 1;
  const nx = -tangent[1] / L, nz = tangent[0] / L;
  let l = 0; while (l < REACH && onMask(px + nx * (l + 0.5), pz + nz * (l + 0.5))) l += 0.5;
  let r = 0; while (r < REACH && onMask(px - nx * (r + 0.5), pz - nz * (r + 0.5))) r += 0.5;
  if (l >= REACH || r >= REACH) return p; // open ground, not a street: leave it
  const shift = (l - r) / 2;
  return toWorld([px + nx * shift, pz + nz * shift]);
}
function recentreNode(p, radiusPx) {
  const [px, pz] = toPx(p);
  let sx = 0, sz = 0, n = 0;
  const r = Math.ceil(radiusPx);
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dz * dz > radiusPx * radiusPx) continue;
    if (onMask(px + dx, pz + dz)) { sx += dx; sz += dz; n++; }
  }
  if (!n) return p;
  return toWorld([px + sx / n, pz + sz / n]);
}

// Node ids re-packed densely, positions re-centred on the tarmac around them.
const nodeIds = new Map();
const outNodes = [];
const nodeWidth = new Map();
for (const i of alive) { const e = edges[i]; for (const n of [e.a, e.b]) nodeWidth.set(n, Math.max(nodeWidth.get(n) ?? 0, e.width)); }
const nodeIndex = (id, p) => {
  if (!nodeIds.has(id)) {
    nodeIds.set(id, outNodes.length);
    const c = recentreNode(p, Math.max(2, (nodeWidth.get(id) ?? 8) / 2 / mpp));
    outNodes.push([+c[0].toFixed(2), +c[1].toFixed(2)]);
  }
  return nodeIds.get(id);
};
const outEdges = [];
let totalLen = 0;
for (const i of alive) {
  const e = edges[i];
  const a = nodeIndex(e.a, e.world[0]);
  const b = nodeIndex(e.b, e.world[e.world.length - 1]);
  let pts = douglasPeucker(e.world, SIMPLIFY);
  pts = chaikin(pts, 2);
  pts[0] = outNodes[a]; pts[pts.length - 1] = outNodes[b];
  // Re-centre the interior, then smooth the pixel jitter that puts back in.
  // Not within a junction's reach of either end: there the perpendicular
  // walk finds the cross street's kerbs, not this one's.
  const clear = Math.max(9, e.width);
  const distTo = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  pts = pts.map((p, k) => {
    if (k === 0 || k === pts.length - 1) return p;
    if (distTo(p, pts[0]) < clear || distTo(p, pts[pts.length - 1]) < clear) return p;
    const t = [pts[k + 1][0] - pts[k - 1][0], pts[k + 1][1] - pts[k - 1][1]];
    const c = recentre(p, t);
    // Never further than half a lane: a bigger shift is the walk finding
    // something that is not this road's kerb.
    return distTo(c, p) <= Math.max(1.5, e.width * 0.25) ? c : p;
  });
  pts = chaikin(douglasPeucker(pts, 0.7), 2);
  // Ends pinned to the node exactly, whatever the smoothing did in between.
  pts[0] = outNodes[a]; pts[pts.length - 1] = outNodes[b];
  // No hooks. Pinning an end to a re-centred node can leave the first (or
  // last) interior point BEHIND the node, so the lane sets off backwards for
  // a metre and swings through 180 degrees — which the traffic reads as a
  // U-turn and a 700 deg/s yaw spike. Interior points too close to an end,
  // or making an acute angle with it, go.
  const unhook = (list) => {
    for (;;) {
      if (list.length < 3) return list;
      const [p0, p1, p2] = list;
      const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const dot = (p1[0] - p0[0]) * (p2[0] - p1[0]) + (p1[1] - p0[1]) * (p2[1] - p1[1]);
      if (d < 2 || dot < 0) { list.splice(1, 1); continue; }
      return list;
    }
  };
  pts = unhook(pts);
  pts = unhook(pts.reverse()).reverse();
  const len = length(pts);
  totalLen += len;
  const out = { a, b, w: +e.width.toFixed(1), p: pts.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]) };
  if (ringEdges.has(i)) out.oneWay = ringDir.get(i);
  outEdges.push(out);
}

const degs = new Map();
for (const e of outEdges) { degs.set(e.a, (degs.get(e.a) ?? 0) + 1); degs.set(e.b, (degs.get(e.b) ?? 0) + 1); }
const hist = {};
for (const d of degs.values()) hist[d] = (hist[d] ?? 0) + 1;
const widths = outEdges.map((e) => e.w).sort((a, b) => a - b);

if (process.env.ROADS_DEBUG) writeFileSync(process.env.ROADS_DEBUG, JSON.stringify(pruned));
writeFileSync(OUT, JSON.stringify({
  source: NAV,
  metresPerPixel: mpp,
  nodes: outNodes,
  edges: outEdges,
}));
step(`wrote ${OUT}: ${outNodes.length} nodes, ${outEdges.length} edges, ${(totalLen / 1000).toFixed(2)} km of street`);
step(`node degrees ${JSON.stringify(hist)}; widths ${widths[0]}-${widths[widths.length - 1]} m, median ${widths[widths.length >> 1]} m`);
