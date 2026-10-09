/**
 * The city's footways, as a graph for the pedestrians (`kestrelPeople`).
 *
 *     npm run walks:city
 *
 * Kestrel and Halcyon are built from the road kit, so their footways are
 * arithmetic — 8.1 m either side of a centreline. The city is a Sketchfab
 * mesh; its footways are whatever it modelled, and people must be on one of
 * them or on the road — nowhere else. So every point and every line they walk
 * is tested against the mesh itself.
 *
 * ## What is a footway, in this mesh
 *
 * The raised `Blocks` slabs, 15 cm over the carriageway, line every street —
 * but `Blocks` is one 2048² atlas, and it paints lawns, plazas, tiled yards
 * and a sports court as well as pavement. And other ground sits on top of it
 * in places: car parks, garage floors. So, at 0.5 m:
 *
 *   ground    the TOP walking surface of each cell and what it is: `Blocks`
 *             (slab), `Street*` (road), or anything else flat (parking,
 *             floors — neither footway nor road).
 *   grass     a slab cell whose atlas texel under it is green.
 *   blocked   anything standing in the band a person walks through, 0.15–
 *             2 m over the ground: walls (`Building*`), and the street
 *             furniture, bushes and trunks (`Accessories`, `Vegetation`,
 *             `Obstacles`, the parked trucks).
 *
 * A **footway cell** is slab, not grass, not blocked. A **road cell** is
 * road. Nothing else is walkable.
 *
 * ## The graph
 *
 *   1. Along every street of the traffic graph (`roadGraph.json`, the same
 *      centrelines the cars drive), a point each side at the kerb plus
 *      `INSET`, every `STEP` metres, kept only if the road is right there
 *      and everything from the kerb out to the point is footway (so not a
 *      grass verge between) and the point has a person's room round it.
 *      A miss breaks the chain — a junction, a lawn, a car park entrance.
 *   2. Thin each chain to its corners — only where the straightened line is
 *      still footway all the way.
 *   3. Join chain pieces along the same side over a short gap (a driveway),
 *      then every chain end to the two nearest other chains: round a corner
 *      or over the road. Every join is walked in 0.4 m steps and must be
 *      footway or road at every one; it is a crossing if any of it is road.
 *
 * Petrel — the circuit island and its two bridges — is left out: a race
 * track has no footways and nobody should be strolling on it (`petrel.json`).
 *
 * Emits `src/config/cityWalks.json`: nodes `[x, y, z]` (y the slab top) and
 * edges `[a, b, crossing, dip]` (dip: how far below its ends a crossing's
 * road is).
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const CITY = 'public/models/city.glb';
const GRAPH = 'src/config/roadGraph.json';
const OUT = 'src/config/cityWalks.json';

/** Metres in from the kerb line to the middle of where people walk. */
const INSET = 1.8;
/** Sample spacing along a street, before thinning. */
const STEP = 3;
/** Raster resolution, metres. */
const CELL = 0.5;
/** A slab higher than this over the kerb's slab is a plinth or a terrace, not a footway. */
const KERB_MAX = 0.45;
/** The most kerb stone and grass verge there may be between the road and its footway, metres. */
const VERGE = 3;
/** A person's room: nothing standing within this of where they walk. */
const ROOM = 0.45;
/** How far a chain end looks for another chain to join. */
const JOIN = 26;
/** Joins shorter than this that stay on the footway are corners, not crossings. */
const CORNER = 9;
/**
 * Petrel — the circuit island and both its bridges — by edge, from the same
 * list the traffic reads (`src/config/petrel.json`). No footways on any of it.
 */
const PETREL = (() => {
  const p = JSON.parse(readFileSync('src/config/petrel.json', 'utf8'));
  return new Set([...Object.keys(p.lap).map(Number), ...p.paddock]);
})();
/** A footway broken for no more than this is joined up along the same side. */
const GAP = 30;
/** Chains shorter than this are kerb notches, not footways. */
const MIN_CHAIN = 12;

const graph = JSON.parse(readFileSync(GRAPH, 'utf8'));

/* --------------------------------------------------------- 1. rasterise */

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read(CITY);

let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
for (const [x, z] of graph.nodes) {
  x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
}
x0 -= 60; z0 -= 60; x1 += 60; z1 += 60;
const W = Math.ceil((x1 - x0) / CELL);
const H = Math.ceil((z1 - z0) / CELL);

const SLAB = 1, ROAD = 2, OTHER = 3;
/** Top walking surface: its height, what it is, and (slab) the atlas texel under it. */
const topY = new Float32Array(W * H).fill(-Infinity);
const topKind = new Uint8Array(W * H);
const topU = new Float32Array(W * H);
const topV = new Float32Array(W * H);
const blocked = new Uint8Array(W * H);
const grass = new Uint8Array(W * H);

const groundKind = (name) => (name === 'Blocks' ? SLAB
  : /^Street/.test(name) ? ROAD
    : /^(Parking|MaterialPiso|Texture_garage_claro_PisoSombra)/.test(name) ? OTHER : 0);
const standing = (name) => /^(Building|Accesories|Vegetation|Obstacles|special_vehicles|Peterbilt|MercedesTruck|container|Default-Material|BillboardBlack)/.test(name);

/** Each cell centre inside the triangle's plan, with the barycentric weights there (null for an edge-on one). */
function fill(tri, onCell) {
  const [[ax, , az], [bx, , bz], [cx, , cz]] = tri;
  const gx = (x) => (x - x0) / CELL;
  const gz = (z) => (z - z0) / CELL;
  const X0 = gx(ax), Z0 = gz(az), X1 = gx(bx), Z1 = gz(bz), X2 = gx(cx), Z2 = gz(cz);
  const lo = [Math.max(0, Math.floor(Math.min(X0, X1, X2))), Math.max(0, Math.floor(Math.min(Z0, Z1, Z2)))];
  const hi = [Math.min(W - 1, Math.ceil(Math.max(X0, X1, X2))), Math.min(H - 1, Math.ceil(Math.max(Z0, Z1, Z2)))];
  if (lo[0] > hi[0] || lo[1] > hi[1]) return;
  const area = (X1 - X0) * (Z2 - Z0) - (X2 - X0) * (Z1 - Z0);
  for (let j = lo[1]; j <= hi[1]; j++) {
    for (let i = lo[0]; i <= hi[0]; i++) {
      if (Math.abs(area) < 1e-9) { onCell(j * W + i, null); continue; }
      const sx = i + 0.5, sz = j + 0.5;
      const w0 = ((X1 - sx) * (Z2 - sz) - (X2 - sx) * (Z1 - sz)) / area;
      const w1 = ((X2 - sx) * (Z0 - sz) - (X0 - sx) * (Z2 - sz)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
      onCell(j * W + i, [w0, w1, w2]);
    }
  }
}

const upward = (tri) => {
  const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2];
  const vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
  const ny = uz * vx - ux * vz;
  const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
  return Math.abs(ny / len) >= 0.8;
};

const standingTris = [];
let groundTris = 0;
let atlas = null;
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  const world = (v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
  for (const prim of mesh.listPrimitives()) {
    const material = prim.getMaterial();
    const name = material?.getName() ?? '';
    const kind = groundKind(name);
    const stands = standing(name);
    if (!kind && !stands) continue;
    if (kind === SLAB && !atlas) atlas = material.getBaseColorTexture();
    const pos = prim.getAttribute('POSITION');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    const at = (k) => (idx ? idx.getScalar(k) : k);
    for (let k = 0; k + 2 < count; k += 3) {
      const ids = [at(k), at(k + 1), at(k + 2)];
      const tri = ids.map((i) => world(pos.getElement(i, [])));
      if (stands) { standingTris.push(tri); continue; }
      if (!upward(tri)) continue;
      groundTris++;
      const uvs = kind === SLAB && uv ? ids.map((i) => uv.getElement(i, [])) : null;
      fill(tri, (c, w) => {
        if (!w) return;
        const y = w[0] * tri[0][1] + w[1] * tri[1][1] + w[2] * tri[2][1];
        if (y <= topY[c]) return;
        topY[c] = y;
        topKind[c] = kind;
        if (uvs) {
          topU[c] = w[0] * uvs[0][0] + w[1] * uvs[1][0] + w[2] * uvs[2][0];
          topV[c] = w[0] * uvs[0][1] + w[1] * uvs[1][1] + w[2] * uvs[2][1];
        }
      });
    }
  }
}

// Anything standing in the band a person walks through. Not by plan alone:
// Curlew stands on one vast building triangle 3.7 m UNDER the street, and a
// tree's crown or a balcony high over a footway is no obstacle either.
for (const tri of standingTris) {
  const lo = Math.min(tri[0][1], tri[1][1], tri[2][1]);
  const hi = Math.max(tri[0][1], tri[1][1], tri[2][1]);
  fill(tri, (c) => {
    const g = topY[c];
    if (Number.isFinite(g) && hi > g + 0.15 && lo < g + 2) blocked[c] = 1;
  });
}

// Grass: a slab cell whose texel is green.
if (atlas) {
  const { data, info } = await sharp(Buffer.from(atlas.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const wrap = (t) => t - Math.floor(t);
  for (let c = 0; c < topKind.length; c++) {
    if (topKind[c] !== SLAB) continue;
    const px = Math.min(info.width - 1, Math.floor(wrap(topU[c]) * info.width));
    const py = Math.min(info.height - 1, Math.floor(wrap(topV[c]) * info.height));
    const o = (py * info.width + px) * 3;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (g > r + 12 && g > b + 8) grass[c] = 1;
  }
}
// `VIEW=x,z,r VIEW_OUT=file.png`: a picture of the ground classes round a
// point with the graph over it, for checking by eye — footway grey, grass
// green, road dark, other ground purple, blocked red; walks cyan, crossings yellow.
if (process.env.VIEW) {
  const [vx, vz, vr] = process.env.VIEW.split(',').map(Number);
  globalThis.VIEW = { vx, vz, vr };
}
let slabs = 0, lawns = 0, walls = 0;
for (let c = 0; c < topKind.length; c++) {
  if (topKind[c] === SLAB) { slabs++; if (grass[c]) lawns++; }
  if (blocked[c]) walls++;
}
console.log(`raster ${W}×${H} at ${CELL} m: ${groundTris} ground and ${standingTris.length} standing triangles; `
  + `${slabs} slab cells (${lawns} grass), ${walls} blocked`);

const cellOf = (x, z) => {
  const i = Math.floor((x - x0) / CELL);
  const j = Math.floor((z - z0) / CELL);
  return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i;
};
const isFootway = (c) => c >= 0 && topKind[c] === SLAB && !grass[c] && !blocked[c];
const isRoad = (c) => c >= 0 && topKind[c] === ROAD && !blocked[c];
/** Room for a person: on footway or road, and nothing standing within `ROOM`. */
const roomy = (x, z) => {
  const here = cellOf(x, z);
  if (!isFootway(here) && !isRoad(here)) return false;
  for (let dz = -ROOM; dz <= ROOM + 1e-6; dz += CELL) {
    for (let dx = -ROOM; dx <= ROOM + 1e-6; dx += CELL) {
      if (dx * dx + dz * dz > ROOM * ROOM + 1e-6) continue;
      const c = cellOf(x + dx, z + dz);
      if (c < 0 || blocked[c]) return false;
    }
  }
  return true;
};

/**
 * Walk the straight line a→b in 0.4 m steps: null if any step is neither
 * footway nor road (grass, a car park, water, a wall, a bench) — otherwise
 * whether any of it is road.
 */
function walk(a, b) {
  const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const n = Math.max(2, Math.ceil(d / 0.4));
  let road = 0;
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n;
    const z = a[2] + ((b[2] - a[2]) * k) / n;
    const c = cellOf(x, z);
    if (isRoad(c)) road++;
    else if (!isFootway(c)) return null;
  }
  return { crossing: road > 1 };
}

/* ------------------------------------------------------- 2. the chains */

const chains = [];
let rejected = 0;
graph.edges.forEach((edge, ei) => {
  if (PETREL.has(ei)) return;
  // Resample the centreline.
  const line = [];
  for (let i = 0; i + 1 < edge.p.length; i++) {
    const [ax, az] = edge.p[i];
    const [bx, bz] = edge.p[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
    for (let k = 0; k < n; k++) line.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  line.push(edge.p[edge.p.length - 1]);
  if (line.length < 2) return;
  const half = edge.w / 2;
  for (const side of [-1, 1]) {
    let run = [];
    const close = () => {
      if (run.length >= 2) {
        const len = run.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - run[i - 1][0], p[2] - run[i - 1][2]) : 0), 0);
        if (len >= MIN_CHAIN) chains.push({ points: run, edge: ei, side });
      }
      run = [];
    };
    for (let i = 0; i < line.length; i++) {
      const [pa, pb] = [line[Math.max(0, i - 1)], line[Math.min(line.length - 1, i + 1)]];
      const l = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
      const nx = (-(pb[1] - pa[1]) / l) * side;
      const nz = ((pb[0] - pa[0]) / l) * side;
      const [cx, cz] = line[i];
      const across = (d) => cellOf(cx + nx * d, cz + nz * d);
      // The kerb, found rather than taken from the graph: the street widths
      // there are a raster's estimate and out by a metre either way. Out from
      // the middle, the first slab past the carriageway.
      let kerbAt = -1;
      let seenRoad = false;
      for (let d = Math.max(0.5, half - 4); d <= half + 6; d += 0.25) {
        const q = across(d);
        if (isRoad(q)) seenRoad = true;
        else if (seenRoad && topKind[q] === SLAB) { kerbAt = d; break; }
        else if (seenRoad) break; // the road ends on something that is not a footway
      }
      let point = null;
      if (kerbAt >= 0) {
        // The footway strip itself: past the kerb stone or a grass verge
        // (green, so up to `VERGE` of that is allowed), the run of
        // footway cells out from the kerb. Many of the city's are narrow —
        // a metre or two of paving and then lawn — so the walker goes down
        // the middle of whatever is there, never at a fixed offset that
        // lands on the grass behind it.
        let from = -1;
        let to = -1;
        for (let d = kerbAt; d <= kerbAt + VERGE + 7; d += 0.25) {
          const foot = isFootway(across(d));
          if (from < 0) {
            if (foot) from = d;
            else if (d > kerbAt + VERGE) break;
          } else if (foot) to = d;
          else break;
        }
        // A wide one is walked a couple of metres in, not down its middle.
        const width = to - from;
        if (from >= 0 && width >= 0.9) {
          const d = from + Math.min(width / 2, INSET);
          const x = cx + nx * d;
          const z = cz + nz * d;
          const c = cellOf(x, z);
          if (roomy(x, z) && Math.abs(topY[c] - topY[across(kerbAt + 0.3)]) < KERB_MAX) point = [x, topY[c], z];
        }
      }
      const ok = point !== null;
      // And the step from the last point to this one is footway too — on a
      // narrow strip round a bend the straight line can clip the lawn.
      if (ok && run.length) {
        const step = walk(run[run.length - 1], point);
        if (!step || step.crossing) { close(); }
      }
      if (ok) run.push(point);
      else { rejected++; close(); }
    }
    close();
  }
});

/* ------------------------------------------------------------ 3. thin */

for (const c of chains) {
  const p = c.points;
  const keep = [p[0]];
  for (let i = 1; i + 1 < p.length; i++) {
    const a = keep[keep.length - 1];
    const b = p[i + 1];
    // Drop a point the straight line from the last kept one to the next would
    // pass within 0.25 m of, at much the same height, never more than 30 m
    // apart — and only if that straight line is footway the whole way.
    const lx = b[0] - a[0], lz = b[2] - a[2];
    const ll = Math.hypot(lx, lz) || 1;
    const dev = Math.abs((p[i][0] - a[0]) * lz - (p[i][2] - a[2]) * lx) / ll;
    const dy = Math.abs(p[i][1] - (a[1] + b[1]) / 2);
    const straight = walk(a, b);
    if (dev > 0.25 || dy > 0.08 || ll > 30 || !straight || straight.crossing) keep.push(p[i]);
  }
  keep.push(p[p.length - 1]);
  c.points = keep;
}

/* ------------------------------------------------------------- 4. graph */

const nodes = [];
const edges = [];
const chainOf = [];
chains.forEach((c, ci) => {
  c.ids = c.points.map((p) => { chainOf.push(ci); return nodes.push(p.map((v) => Math.round(v * 100) / 100)) - 1; });
  for (let i = 0; i + 1 < c.ids.length; i++) edges.push([c.ids[i], c.ids[i + 1], 0, 0]);
});

const joined = new Set();
let crossings = 0;
let refused = 0;
// First, each piece to the next along the same side of the same street,
// over whatever broke it — a driveway — so a footway with a gap in it is
// still walked along, not abandoned for the far side.
let continued = 0;
for (let ci = 0; ci + 1 < chains.length; ci++) {
  const a = chains[ci];
  const b = chains[ci + 1];
  if (a.edge !== b.edge || a.side !== b.side) continue;
  const end = a.ids[a.ids.length - 1];
  const start = b.ids[0];
  const d = Math.hypot(nodes[end][0] - nodes[start][0], nodes[end][2] - nodes[start][2]);
  if (d > GAP) continue;
  const kind = walk(nodes[end], nodes[start]);
  if (!kind) { refused++; continue; }
  joined.add(end < start ? `${end}:${start}` : `${start}:${end}`);
  edges.push([end, start, kind.crossing ? 1 : 0, kind.crossing ? 0.15 : 0]);
  continued++;
}
for (const c of chains) {
  for (const end of [c.ids[0], c.ids[c.ids.length - 1]]) {
    const here = nodes[end];
    const best = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const ci = chainOf[i];
      if (ci === chainOf[end]) continue;
      const p = nodes[i];
      if (Math.abs(p[0] - here[0]) > JOIN || Math.abs(p[2] - here[2]) > JOIN) continue;
      const d = Math.hypot(p[0] - here[0], p[2] - here[2]);
      if (d > JOIN) continue;
      const known = best.get(ci);
      if (!known || d < known.d) best.set(ci, { i, d });
    }
    let made = 0;
    for (const { i, d } of [...best.values()].sort((a, b) => a.d - b.d)) {
      if (made >= 2) break;
      const key = end < i ? `${end}:${i}` : `${i}:${end}`;
      if (joined.has(key)) { made++; continue; }
      const kind = walk(here, nodes[i]);
      if (!kind) { refused++; continue; }
      // A long join that never leaves the footway is cutting across a plaza —
      // not a corner and not a crossing.
      if (!kind.crossing && d > CORNER) continue;
      joined.add(key);
      edges.push([end, i, kind.crossing ? 1 : 0, kind.crossing ? 0.15 : 0]);
      if (kind.crossing) crossings++;
      made++;
    }
  }
}

// Keep the components big enough to walk round; drop the scraps.
const goodEdges = edges
  .filter(([a, b]) => Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][2] - nodes[b][2]) > 0.3)
  // Every edge walked once more as built — rounding the nodes to the
  // centimetre can tip a line along a narrow strip onto its edge.
  .filter(([a, b]) => walk(nodes[a], nodes[b]) !== null);
const adj = nodes.map(() => []);
for (const [a, b] of goodEdges) { adj[a].push(b); adj[b].push(a); }
const comp = new Int32Array(nodes.length).fill(-1);
const sizes = [];
for (let s = 0; s < nodes.length; s++) {
  if (comp[s] >= 0) continue;
  const id = sizes.length;
  let n = 0;
  const stack = [s];
  comp[s] = id;
  while (stack.length) {
    const v = stack.pop();
    n++;
    for (const o of adj[v]) if (comp[o] < 0) { comp[o] = id; stack.push(o); }
  }
  sizes.push(n);
}
const keepNode = nodes.map((_, i) => sizes[comp[i]] >= 6);
const remap = new Int32Array(nodes.length).fill(-1);
const outNodes = [];
nodes.forEach((p, i) => { if (keepNode[i]) remap[i] = outNodes.push(p) - 1; });
// Never an edge of no length: a walker's step loop takes edges off until it
// has used its distance up, and an edge of nothing never uses any.
const outEdges = goodEdges
  .filter(([a, b]) => keepNode[a] && keepNode[b])
  .map(([a, b, c, d]) => [remap[a], remap[b], c, d]);

// The audit: every edge, walked again, footway or road the whole way. There
// should be none left that is not; any that is, goes.
let bad = 0;
for (const [a, b] of outEdges) if (!walk(outNodes[a], outNodes[b])) bad++;

let length = 0;
for (const [a, b] of outEdges) length += Math.hypot(outNodes[a][0] - outNodes[b][0], outNodes[a][2] - outNodes[b][2]);
writeFileSync(OUT, JSON.stringify({ nodes: outNodes, edges: outEdges }));
if (globalThis.VIEW) {
  const { vx, vz, vr } = globalThis.VIEW;
  const N = 800, img = Buffer.alloc(N * N * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = cellOf(vx - vr + (i / N) * 2 * vr, vz - vr + (j / N) * 2 * vr);
    const col = c < 0 ? [0, 0, 0] : blocked[c] ? [170, 40, 40] : topKind[c] === ROAD ? [60, 60, 70]
      : topKind[c] === SLAB ? (grass[c] ? [40, 110, 40] : [175, 170, 160]) : topKind[c] === OTHER ? [90, 70, 140] : [20, 20, 20];
    img.set(col, (j * N + i) * 3);
  }
  const px = (x) => ((x - vx + vr) / (2 * vr)) * N, pz = (z) => ((z - vz + vr) / (2 * vr)) * N;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}">`;
  for (const [a, b, cr] of outEdges) {
    const A = outNodes[a], B = outNodes[b];
    svg += `<line x1="${px(A[0])}" y1="${pz(A[2])}" x2="${px(B[0])}" y2="${pz(B[2])}" stroke="${cr ? '#ff0' : '#0ff'}" stroke-width="2"/>`;
  }
  svg += '</svg>';
  await sharp(img, { raw: { width: N, height: N, channels: 3 } }).composite([{ input: Buffer.from(svg) }]).png().toFile(process.env.VIEW_OUT);
}
console.log(`${rejected} footway samples refused; ${continued} gaps bridged along a side; ${refused} joins refused`);
console.log(`${chains.length} chains → ${outNodes.length} nodes, ${outEdges.length} edges (${crossings} crossings), `
  + `${(length / 1000).toFixed(1)} km; components ≥6: ${sizes.filter((s) => s >= 6).length}, largest ${Math.max(...sizes)}; `
  + `audit: ${bad} edges off footway and road`);
