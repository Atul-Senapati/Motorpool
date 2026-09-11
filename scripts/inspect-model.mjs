/**
 * Measures a source model, so a garage entry can be written from numbers
 * instead of guesses.
 *
 * `prepare-garage.mjs` normalises everything it is given, but three facts have
 * to be *stated* per vehicle and cannot be read off the geometry: the real
 * length that sets the scale, which end is the nose (`flip`), and which way up
 * it was authored (`upsideDown`). This script gives you what you need to decide
 * all three, plus a warning when a model's own proportions disagree with the
 * real vehicle's — which is how the monster truck ended up scaled by width
 * rather than by length.
 *
 * What to read:
 *
 *  - **longest axis** is almost always the length. If the shortest axis is Z
 *    rather than Y the model is probably Z-up and wants `upsideDown`.
 *  - **symmetry** tells you which axis is width: a vehicle is symmetric across
 *    its width and asymmetric along its length (a nose differs from a tail).
 *  - **length ÷ width** against the real car's says whether scaling by length
 *    will give you a sane width.
 *  - **wheel-ish parts** lists round things near the ground, i.e. what
 *    `findWheels` will be looking at. Compare the radii against the real tyre.
 *
 * Run with: npm run inspect -- <file.glb> [more.glb ...]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { source } from './sourceModels.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run inspect -- <file.glb> [more.glb ...]');
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  }
  return o;
}

function nodeMatrix(node) {
  const [x, y, z, w] = node.getRotation();
  const t = node.getTranslation();
  const s = node.getScale();
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const AXIS = ['X', 'Y', 'Z'];

for (const given of files) {
  // Takes a bare name, a path in `source-models/`, or any path at all.
  const file = source(given);
  const doc = await io.read(file);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const parts = [];
  let tris = 0;

  (function walk(node, parent) {
    const m = mul(parent, nodeMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const idx = prim.getIndices();
        tris += (idx ? idx.getCount() : pos.getCount()) / 3;
        const plo = [Infinity, Infinity, Infinity];
        const phi = [-Infinity, -Infinity, -Infinity];
        const v = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, v);
          const q = [
            v[0] * m[0] + v[1] * m[4] + v[2] * m[8] + m[12],
            v[0] * m[1] + v[1] * m[5] + v[2] * m[9] + m[13],
            v[0] * m[2] + v[1] * m[6] + v[2] * m[10] + m[14],
          ];
          for (let k = 0; k < 3; k++) {
            if (q[k] < plo[k]) plo[k] = q[k];
            if (q[k] > phi[k]) phi[k] = q[k];
            if (q[k] < lo[k]) lo[k] = q[k];
            if (q[k] > hi[k]) hi[k] = q[k];
          }
        }
        parts.push({ lo: plo, hi: phi, size: phi.map((x, i) => x - plo[i]),
          c: phi.map((x, i) => (x + plo[i]) / 2) });
      }
    }
    for (const child of node.listChildren()) walk(child, m);
  })({
    getMesh: () => null, listChildren: () => scene.listChildren(),
    getRotation: () => [0, 0, 0, 1], getTranslation: () => [0, 0, 0], getScale: () => [1, 1, 1],
  }, IDENT);

  const size = hi.map((v, i) => v - lo[i]);
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const [longest, middle, shortest] = order;

  /** Symmetric about zero => that axis is the width. */
  const symmetry = [0, 1, 2].map((i) => {
    const skew = Math.abs(lo[i] + hi[i]) / (size[i] || 1);
    return { axis: AXIS[i], skew };
  });
  const widthAxis = symmetry.filter((s) => s.axis !== AXIS[longest])
    .sort((a, b) => a.skew - b.skew)[0];

  console.log(`\n=== ${file}`);
  console.log(`  ${Math.round(tris).toLocaleString()} triangles · ${parts.length} parts · `
    + `${root.listMaterials().length} materials · ${root.listTextures().length} textures`);
  console.log(`  size    X ${size[0].toFixed(3)}   Y ${size[1].toFixed(3)}   Z ${size[2].toFixed(3)}`);
  console.log(`  bounds  lo [${lo.map((v) => v.toFixed(2)).join(', ')}]  `
    + `hi [${hi.map((v) => v.toFixed(2)).join(', ')}]`);
  console.log(`  longest ${AXIS[longest]} (length) · middle ${AXIS[middle]} · shortest ${AXIS[shortest]}`);
  console.log(`  most symmetric non-length axis: ${widthAxis.axis} (skew ${widthAxis.skew.toFixed(3)}) `
    + `-> that is the width, so height is the other one`);
  if (AXIS[shortest] === 'Z') {
    console.log('  !! shortest axis is Z — this model is probably Z-up; try upsideDown: true');
  }
  const wi = AXIS.indexOf(widthAxis.axis);
  console.log(`  length/width ${(size[longest] / size[wi]).toFixed(2)}  `
    + `(a saloon is ~2.4, a supercar ~2.3, a monster truck ~1.4)`);
  console.log(`  sits on zero? lowest point on each axis: `
    + `X ${lo[0].toFixed(2)}  Y ${lo[1].toFixed(2)}  Z ${lo[2].toFixed(2)}`);

  // What findWheels will be looking at: round, near the lowest extent.
  const groundAxis = AXIS[shortest] === 'Z' ? 2 : 1;
  const wheelish = parts
    .map((p) => {
      const a = groundAxis === 1 ? 1 : 2;
      const b = groundAxis === 1 ? 2 : 1;
      const radius = Math.max(p.size[a], p.size[b]) / 2;
      const round = Math.min(p.size[a], p.size[b]) / (Math.max(p.size[a], p.size[b]) || 1);
      return { ...p, radius, round };
    })
    .filter((p) => p.round > 0.7 && p.radius > 0.05
      && Math.abs(p.c[groundAxis] - lo[groundAxis] - p.radius) < p.radius * 0.8)
    .sort((a, b) => b.radius - a.radius)
    .slice(0, 6);
  if (wheelish.length) {
    console.log('  wheel-ish parts (round, near the ground):');
    for (const w of wheelish) {
      console.log(`    r=${w.radius.toFixed(3)} round=${w.round.toFixed(2)} `
        + `size=[${w.size.map((v) => v.toFixed(2)).join(', ')}] `
        + `c=[${w.c.map((v) => v.toFixed(2)).join(', ')}]`);
    }
    console.log('    (compare against the real tyre; prepare-garage accepts radius 0.20-0.95 '
      + 'after scaling)');
  } else {
    console.log('  no obviously round parts near the ground — wheels may be merged into the body');
  }
}
