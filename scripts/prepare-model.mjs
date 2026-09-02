/**
 * One-time preprocessor for the Sketchfab McLaren F1 GLB.
 *
 * The source export is unusable for a driving game as-is:
 *   - every node is named `Object_N` and geometry is merged BY MATERIAL, so all
 *     four tires live in a single mesh with no pivots (see README notes).
 *   - two baked shadow planes (`floor`, `material`) sit at ground level.
 *   - the model is Z-up, nose at -Y, and 17.6% oversized.
 *   - 9.85 MB of textures, half of it one 6.6 MB PNG.
 *
 * This script emits `public/models/mclaren.glb` with a real hierarchy:
 *
 *   Body                       all non-wheel geometry
 *   Wheel_FL/FR/RL/RR          pivot at axle centre; rolls AND steers
 *   Upright_FL/FR/RL/RR        pivot at axle centre; steers but never rolls
 *
 * Run with: npm run prepare:model
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsClearcoat, KHRMaterialsSpecular, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'mclaren_f1_1993_by_alex.ka..glb';
const DST = 'public/models/mclaren.glb';

/** Real McLaren F1 is 4.287 m long; the raw export measures 4.686 local units. */
const SCALE = 0.9148;

/** Materials whose geometry is part of a wheel and must spin with it. */
const ROLLING = new Set([
  'tire', 'tire_side', 'material_48', 'brakedisk', 'rimbolt', 'rimlogo', 'F1_nip_logo',
]);
/** Materials mounted on the upright: they steer with the wheel but must NOT spin. */
const UPRIGHT = new Set([
  'material_43', 'chrome', 'suport', 'black_aluminium', 'McLaren_supportlogo',
]);
/** Baked shadow-catcher planes in the source file. Deleted outright. */
const DROP = new Set(['floor', 'material']);

/**
 * Local (Z-up, nose at -Y) -> car space (Y-up, nose at -Z), uniformly scaled.
 * R = [[-1,0,0],[0,0,1],[0,1,0]] is orthogonal with det +1, so this is a proper
 * rotation: the model is re-oriented, never mirrored. Uniform scale means normals
 * transform with the same matrix (then re-normalised).
 */
const toCarSpace = (x, y, z) => [-SCALE * x, SCALE * z, SCALE * y];

const io = new NodeIO().registerExtensions([
  KHRMaterialsClearcoat, KHRMaterialsSpecular, KHRMaterialsEmissiveStrength,
]);

const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

const matName = (prim) => prim.getMaterial()?.getName() ?? '';

// ---------------------------------------------------------------------------
// 1. Bake the orientation/scale transform into vertex data.
//    Accessors can be shared between primitives, so guard against transforming
//    the same buffer twice.
// ---------------------------------------------------------------------------
const done = new Set();
const bake = (acc, isDirection) => {
  if (!acc || done.has(acc)) return;
  done.add(acc);
  const a = acc.getArray();
  const n = acc.getCount();
  const stride = acc.getElementSize();
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const [X, Y, Z] = toCarSpace(a[o], a[o + 1], a[o + 2]);
    if (isDirection) {
      const len = Math.hypot(X, Y, Z) || 1;
      a[o] = X / len; a[o + 1] = Y / len; a[o + 2] = Z / len;
    } else {
      a[o] = X; a[o + 1] = Y; a[o + 2] = Z;
    }
  }
  acc.setArray(a);
};

for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    bake(prim.getAttribute('POSITION'), false);
    bake(prim.getAttribute('NORMAL'), true);
    bake(prim.getAttribute('TANGENT'), true); // vec4: w (handedness) left untouched
  }
}

// ---------------------------------------------------------------------------
// 2. Locate the four wheel pivots from the `tire` mesh.
//    A tire is a solid of revolution, so its per-quadrant bbox centre IS the
//    axle centre in Y/Z, and the mid-width in X — exactly the pivot we want.
// ---------------------------------------------------------------------------
const tireMesh = root.listMeshes().find((m) => m.listPrimitives().some((p) => matName(p) === 'tire'));
if (!tireMesh) throw new Error('Could not find the `tire` mesh in the source model.');

const quadKey = (X, Z) => `${Z < 0 ? 'F' : 'R'}${X > 0 ? 'R' : 'L'}`; // -Z is the nose, +X is the driver's right
const bounds = {};
for (const prim of tireMesh.listPrimitives()) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 0; i < a.length; i += 3) {
    const [X, Y, Z] = [a[i], a[i + 1], a[i + 2]];
    const k = quadKey(X, Z);
    const b = (bounds[k] ??= { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
    for (let c = 0; c < 3; c++) {
      b.lo[c] = Math.min(b.lo[c], [X, Y, Z][c]);
      b.hi[c] = Math.max(b.hi[c], [X, Y, Z][c]);
    }
  }
}
const corners = ['FL', 'FR', 'RL', 'RR'];
if (!corners.every((k) => bounds[k])) throw new Error('Tire mesh did not split into four quadrants.');

const pivot = {};
for (const k of corners) {
  const b = bounds[k];
  pivot[k] = [0, 1, 2].map((c) => (b.lo[c] + b.hi[c]) / 2);
}
const radius = {};
for (const k of corners) radius[k] = (bounds[k].hi[1] - bounds[k].lo[1]) / 2;

// ---------------------------------------------------------------------------
// 3. Re-origin the model: X on the wheel centreline, Y=0 at tire contact patch,
//    Z at the wheelbase midpoint (keeps the physics config symmetric).
// ---------------------------------------------------------------------------
const offset = [
  -(pivot.FL[0] + pivot.FR[0]) / 2,
  -Math.min(...corners.map((k) => bounds[k].lo[1])),
  -(pivot.FL[2] + pivot.RL[2]) / 2,
];
// Only POSITION accessors are translated; NORMAL/TANGENT are directions.
const positions = new Set();
for (const mesh of root.listMeshes())
  for (const prim of mesh.listPrimitives()) positions.add(prim.getAttribute('POSITION'));
for (const acc of positions) {
  const a = acc.getArray();
  for (let i = 0; i < a.length; i += 3) {
    a[i] += offset[0]; a[i + 1] += offset[1]; a[i + 2] += offset[2];
  }
  acc.setArray(a);
}
for (const k of corners) for (let c = 0; c < 3; c++) pivot[k][c] += offset[c];

// ---------------------------------------------------------------------------
// 4. Split every wheel mesh into four, by triangle centroid, and re-centre each
//    piece onto its pivot so the node transform alone drives it.
// ---------------------------------------------------------------------------
const buffer = root.listBuffers()[0];

/** Extract the sub-primitive for one quadrant, with attributes compacted. */
function extractQuadrant(prim, corner) {
  const pos = prim.getAttribute('POSITION').getArray();
  const idxAcc = prim.getIndices();
  const idx = idxAcc ? idxAcc.getArray() : Uint32Array.from({ length: prim.getAttribute('POSITION').getCount() }, (_, i) => i);

  const keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    let cx = 0, cz = 0;
    for (let v = 0; v < 3; v++) { cx += pos[idx[t + v] * 3]; cz += pos[idx[t + v] * 3 + 2]; }
    if (quadKey(cx / 3, cz / 3) === corner) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!keep.length) return null;

  // Compact: old vertex index -> new, dropping vertices this quadrant doesn't use.
  const remap = new Map();
  const newIdx = new Uint32Array(keep.length);
  for (let i = 0; i < keep.length; i++) {
    let n = remap.get(keep[i]);
    if (n === undefined) { n = remap.size; remap.set(keep[i], n); }
    newIdx[i] = n;
  }

  const out = doc.createPrimitive().setMaterial(prim.getMaterial()).setMode(prim.getMode());
  for (const sem of prim.listSemantics()) {
    const src = prim.getAttribute(sem);
    const arr = src.getArray();
    const es = src.getElementSize();
    const dstArr = new arr.constructor(remap.size * es);
    for (const [oldI, newI] of remap)
      for (let c = 0; c < es; c++) dstArr[newI * es + c] = arr[oldI * es + c];

    // Move geometry into pivot-local space so the node transform is the only
    // thing positioning the wheel.
    if (sem === 'POSITION')
      for (let i = 0; i < dstArr.length; i += 3) {
        dstArr[i] -= pivot[corner][0]; dstArr[i + 1] -= pivot[corner][1]; dstArr[i + 2] -= pivot[corner][2];
      }

    out.setAttribute(sem, doc.createAccessor().setType(src.getType()).setArray(dstArr).setBuffer(buffer)
      .setNormalized(src.getNormalized()));
  }
  out.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buffer));
  return out;
}

// Group the source meshes by role.
const bodyNode = doc.createNode('Body');
const wheelNodes = {}, uprightNodes = {};
for (const k of corners) {
  wheelNodes[k] = doc.createNode(`Wheel_${k}`).setTranslation(pivot[k]);
  uprightNodes[k] = doc.createNode(`Upright_${k}`).setTranslation(pivot[k]);
}

let splitCount = 0, droppedCount = 0;
for (const mesh of root.listMeshes()) {
  const name = matName(mesh.listPrimitives()[0]);
  if (DROP.has(name)) { droppedCount++; continue; }

  const isRolling = ROLLING.has(name);
  const isUpright = UPRIGHT.has(name);

  if (!isRolling && !isUpright) {
    bodyNode.addChild(doc.createNode(`Body_${name}`).setMesh(mesh));
    continue;
  }

  for (const k of corners) {
    const parts = mesh.listPrimitives().map((p) => extractQuadrant(p, k)).filter(Boolean);
    if (!parts.length) continue;
    const m = doc.createMesh(`${name}_${k}`);
    for (const p of parts) m.addPrimitive(p);
    (isRolling ? wheelNodes[k] : uprightNodes[k]).addChild(doc.createNode(`${name}_${k}`).setMesh(m));
  }
  splitCount++;
}

// Rebuild the scene from scratch, discarding the flat Sketchfab hierarchy.
// The old Sketchfab transforms are already baked into the vertices, so the flat
// hierarchy is simply detached and later pruned.
for (const n of scene.listChildren()) scene.removeChild(n);
scene.addChild(bodyNode);
for (const k of corners) { scene.addChild(wheelNodes[k]); scene.addChild(uprightNodes[k]); }

// ---------------------------------------------------------------------------
// 5. Texture compression: 9.85 MB of PNG/JPEG -> WebP, capped at 2048px.
// ---------------------------------------------------------------------------
let before = 0, after = 0;
for (const tex of root.listTextures()) {
  const img = tex.getImage();
  if (!img) continue;
  before += img.byteLength;
  const webp = await sharp(Buffer.from(img))
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85, effort: 5 })
    .toBuffer();
  tex.setImage(new Uint8Array(webp)).setMimeType('image/webp');
  after += webp.byteLength;
}

// Splitting orphans the original merged wheel meshes; drop anything the rebuilt
// scene graph no longer references so it doesn't ship in the GLB.
const isOrphan = (prop) => prop.listParents().every((p) => p.propertyType === 'Root');
for (let pass = 0; pass < 4; pass++) {
  for (const list of [root.listNodes(), root.listMeshes(), root.listAccessors(), root.listMaterials(), root.listTextures()])
    for (const prop of list) if (isOrphan(prop)) prop.dispose();
}

await io.write(DST, doc);

// ---------------------------------------------------------------------------
const srcSize = readFileSync(SRC).byteLength;
const dstSize = readFileSync(DST).byteLength;
const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

console.log('\nWheel pivots (car space, metres):');
for (const k of corners)
  console.log(`  ${k}  x=${pivot[k][0].toFixed(4)}  y=${pivot[k][1].toFixed(4)}  z=${pivot[k][2].toFixed(4)}  r=${radius[k].toFixed(4)}`);
console.log(`\n  wheelbase   ${(pivot.RL[2] - pivot.FL[2]).toFixed(4)} m`);
console.log(`  track front ${(pivot.FR[0] - pivot.FL[0]).toFixed(4)} m`);
console.log(`  track rear  ${(pivot.RR[0] - pivot.RL[0]).toFixed(4)} m`);
console.log(`\n  meshes split into 4: ${splitCount}   shadow planes dropped: ${droppedCount}`);
console.log(`  textures ${mb(before)} -> ${mb(after)}`);
console.log(`  GLB      ${mb(srcSize)} -> ${mb(dstSize)}\n`);

// Emit the measured geometry so the runtime config can import real numbers
// instead of hard-coded guesses.
writeFileSync('src/config/carGeometry.json', JSON.stringify({
  wheelbase: +(pivot.RL[2] - pivot.FL[2]).toFixed(4),
  trackFront: +(pivot.FR[0] - pivot.FL[0]).toFixed(4),
  trackRear: +(pivot.RR[0] - pivot.RL[0]).toFixed(4),
  pivots: Object.fromEntries(corners.map((k) => [k, pivot[k].map((v) => +v.toFixed(4))])),
  radii: Object.fromEntries(corners.map((k) => [k, +radius[k].toFixed(4)])),
}, null, 2) + '\n');
