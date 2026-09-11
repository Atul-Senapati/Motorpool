/**
 * Rasterises everything in the city that a railway may not be laid through.
 *
 * The route finder used to take its obstacles from `cityData.boxes`, and that
 * is not what the name suggests. Those boxes are *collider* boxes, and
 * `prepare-map.mjs` only makes one where a primitive's footprint is at most
 * 40 m across — anything larger falls through to the exact trimesh instead,
 * because a single AABB round the beach plane would encase the city. So every
 * building bigger than forty metres is absent from that list, and so is every
 * tree: vegetation is never boxed at all. The line went through both, which is
 * exactly what you would expect from a search that could not see them.
 *
 * This walks the finished city mesh and marks every cell any non-ground
 * triangle stands on. Buildings large and small, trees, walls, signs, parked
 * props — if it is drawn and it is not a surface you could drive on, it is an
 * obstacle.
 *
 * Output is an RGB PNG on exactly the nav raster's grid — same origin, same
 * metres per pixel, same size — so the route finder can index the two with one
 * set of coordinates. **Red is solid** (buildings, walls, props: things a
 * railway would have to demolish) and **green is vegetation** (things it would
 * fell). They are separate because they deserve different clearances: eight
 * metres from a building, three from a tree. Given the same clearance the
 * lineside trees close every corridor in the green hinterland, and the only
 * route left is five kilometres of viaduct on forty-metre embankments.
 *
 * Run with: npm run map:obstacles
 * Writes:   public/models/cityObstacles.png
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const SRC = 'public/models/city.glb';
const CITY_DATA = 'src/config/cityData.json';
const OUT = 'public/models/cityObstacles.png';

/**
 * Materials that are ground: surfaces the line may cross or sit on. Everything
 * else is an obstacle. This is `prepare-map.mjs`'s own DRIVABLE set — the same
 * list that decides what becomes the trimesh a car drives on — so the two
 * cannot drift apart in what they consider a surface.
 */
/** Material treated as trees rather than structure. */
const VEGETATION = 'Vegetation';

const GROUND = new Set([
  'Street', 'Street_1', 'Street_texture', 'Parking', 'MaterialPiso', 'Blocks',
  'Texture_garage_claro_PisoSombra', 'Texture_garage_claro_PisoSombra_1',
]);

/**
 * Geometry lower than this above the local ground is ignored.
 *
 * Kerbs, road markings, manhole covers and the like are separate primitives on
 * non-ground materials and cover a lot of the street surface; blocking on them
 * would wall the city off entirely. A railway is stopped by things with height.
 */
const MIN_HEIGHT = 1.5;

/**
 * Over water, geometry has to be this far above the waterline to count.
 *
 * There is no nav ground out at sea, so there is nothing to measure `MIN_HEIGHT`
 * against — and the map's beach shell, a 5,158 x 4,231 m plane on the
 * `Building` material, sits just above the waterline and reaches far out over
 * it. Measured against sea level it cleared 1.5 m and marked the whole bay
 * solid, and the route finder came back with two 444 m crossings it refused to
 * bridge. Eight metres is the bridge soffit: over water, only what a deck would
 * actually hit is an obstacle.
 *
 * A footprint cap was tried first and is the wrong tool — this map merges all
 * its trees into a handful of primitives spanning kilometres, so capping by
 * primitive size discarded the vegetation entirely and took the obstacle count
 * from 24% of the raster to 1%.
 */
const SEA_LEVEL = -3.6;
const OVER_WATER_HEIGHT = 8;

const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const city = JSON.parse(readFileSync(CITY_DATA, 'utf8'));
const nav = city.nav;
const W = nav.width;
const H = nav.height;
const PX = nav.metresPerPixel;

// Ground height per cell, from the nav raster, so "1.5 m above the ground" can
// be tested where there is ground to be above.
const { data: navData, info: navInfo } = await sharp('public/models/cityNav.png')
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const groundAt = (i, j) => {
  if (i < 0 || j < 0 || i >= W || j >= H) return null;
  const o = (j * navInfo.width + i) * navInfo.channels;
  if (!navData[o + 3]) return null;
  const u16 = (navData[o + 1] << 8) | navData[o + 2];
  return nav.minY + (u16 / 65535) * (nav.maxY - nav.minY);
};

step(`reading ${SRC}`);
const doc = await io.read(SRC);
const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];

const solid = new Uint8Array(W * H);
const leaves = new Uint8Array(W * H);
let mask = solid;

/**
 * Scan-fills one triangle's footprint, marking cells it stands over.
 *
 * Conservative on purpose: the bounding box of the triangle is walked and each
 * cell tested against the triangle's edges with a half-cell slack, so a wall
 * thinner than a pixel still marks the pixel it crosses rather than slipping
 * between samples.
 */
function rasterise(ax, ay, az, bx, by, bz, cx, cz, cy) {
  const gx = (x) => (x - nav.originX) / PX;
  const gz = (z) => (z - nav.originZ) / PX;
  const x0 = gx(ax); const z0 = gz(az);
  const x1 = gx(bx); const z1 = gz(bz);
  const x2 = gx(cx); const z2 = gz(cz);
  const loX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const hiX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const loZ = Math.max(0, Math.floor(Math.min(z0, z1, z2)));
  const hiZ = Math.min(H - 1, Math.ceil(Math.max(z0, z1, z2)));
  if (loX > hiX || loZ > hiZ) return;
  const top = Math.max(ay, by, cy);

  const area = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0);
  const degenerate = Math.abs(area) < 1e-9;

  for (let j = loZ; j <= hiZ; j++) {
    for (let i = loX; i <= hiX; i++) {
      if (mask[j * W + i]) continue;
      if (!degenerate) {
        // Barycentric, with a half-cell of slack so thin geometry still lands.
        const px = i + 0.5; const pz = j + 0.5;
        const w0 = ((x1 - px) * (z2 - pz) - (x2 - px) * (z1 - pz)) / area;
        const w1 = ((x2 - px) * (z0 - pz) - (x0 - px) * (z2 - pz)) / area;
        const w2 = 1 - w0 - w1;
        const slack = 0.75 / Math.max(hiX - loX + 1, hiZ - loZ + 1, 1);
        if (w0 < -slack || w1 < -slack || w2 < -slack) continue;
      }
      const ground = groundAt(i, j);
      if (ground === null) {
        if (top - SEA_LEVEL < OVER_WATER_HEIGHT) continue;
      } else if (top - ground < MIN_HEIGHT) continue;
      mask[j * W + i] = 1;
    }
  }
}

const mul = (A, B) => {
  const C = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += A[i + k * 4] * B[k + j * 4];
      C[i + j * 4] = sum;
    }
  }
  return C;
};
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

let triangles = 0;
const seen = new Map();
// 344 flat nodes at the scene root, one per chunk — not a tree with a single
// root, which is what an earlier version assumed and why it found nothing.
function walk(node, parent) {
  const m = mul(parent, node.getMatrix());
  const mesh = node.getMesh();
  if (mesh) {
    // `extras.surface` is what prepare-map recorded and what CityMap reads;
    // the material name is the fallback for anything without it.
    const surface = (node.getExtras()?.surface ?? '');
    for (const prim of mesh.listPrimitives()) {
      const name = surface || (prim.getMaterial()?.getName() ?? '');
      if (GROUND.has(name)) continue;
      const position = prim.getAttribute('POSITION');
      const index = prim.getIndices();
      if (!position || !index) continue;
      const count = index.getCount();
      seen.set(name, (seen.get(name) ?? 0) + count / 3);
      mask = name === VEGETATION ? leaves : solid;
      const a = []; const b = []; const c = [];
      for (let t = 0; t < count; t += 3) {
        const p0 = apply(m, position.getElement(index.getScalar(t), a));
        const p1 = apply(m, position.getElement(index.getScalar(t + 1), b));
        const p2 = apply(m, position.getElement(index.getScalar(t + 2), c));
        rasterise(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[2], p2[1]);
        triangles++;
      }
    }
  }
  for (const child of node.listChildren()) walk(child, m);
}
for (const child of scene.listChildren()) walk(child, IDENTITY);

const markedSolid = solid.reduce((n, v) => n + v, 0);
const markedLeaves = leaves.reduce((n, v) => n + v, 0);
step(`${triangles.toLocaleString()} obstacle triangles over ${seen.size} materials`);
const worst = [...seen].sort((x, y) => y[1] - x[1]).slice(0, 6);
for (const [name, n] of worst) console.log(`    ${name.padEnd(34)} ${Math.round(n).toLocaleString()} tris`);


const png = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  png[i * 3] = solid[i] ? 255 : 0;
  png[i * 3 + 1] = leaves[i] ? 255 : 0;
}
await sharp(png, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT);

console.log('\n--- obstacle map ---');
console.log(`  ${W}x${H} at ${PX} m`);
console.log(`  solid      ${markedSolid.toLocaleString()} cells `
  + `(${((100 * markedSolid) / (W * H)).toFixed(1)}% of the raster)`);
console.log(`  vegetation ${markedLeaves.toLocaleString()} cells `
  + `(${((100 * markedLeaves) / (W * H)).toFixed(1)}%)`);
console.log(`  wrote ${OUT} (${(readFileSync(OUT).byteLength / 1024).toFixed(0)} kB)\n`);
