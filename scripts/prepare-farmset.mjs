/**
 * Skylark's farm set: the user's five farm models, baked as a kit of their own.
 *
 *     npm run prepare:farmset
 *
 * They would be parts of `country.glb`, but that kit is built from the
 * city's own 188 MB source map as well (`prepare-country.mjs`), which is not
 * always on hand; this is the same recipe for just these five, into a file
 * of their own:
 *
 *   niva          the Niva SK-5 combine, 10.9 m with its header
 *   gaz52         the GAZ-52 truck
 *   mtz80         the MTZ-80 tractor
 *   tractorSmall  a compact tractor (modelled in millimetres)
 *   plough        a three-disc plough
 *
 * Each picked node's tree to world space, turned to face −Z (the project's
 * convention for every vehicle), scaled, joined into one primitive per
 * material, centred on its footprint and stood on y = 0 — exactly as
 * `prepare-country` frames its parts, so the same placing code takes them.
 *
 * The wheels come out as well, so traffic can spin them: each one a child
 * node of its part, placed at its hub, its mesh centred on the axle (the
 * axle along X), with `extras: { wheel: true, radius }`. The modelled ones
 * are taken by node name; the compact tractor is one welded mesh, so its
 * tyres are found as pieces of their own — round in side view, thin, on the
 * ground.
 *
 * Textures WebP, meshes Draco. Writes `public/models/country/farmset.glb`
 * (one node per part, by name) and `src/config/farmsetData.json` (sizes,
 * and each part's hubs).
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const DST = 'public/models/country/farmset.glb';
const DATA = 'src/config/farmsetData.json';
const TEXTURE_SIZE = 1024;
const FACE_PZ = Math.PI; // the model's front is +Z

const PARTS = [
  // The header is at −Z: already facing the right way, and life size.
  { name: 'niva', file: 'sk-5_niva.glb', pick: 'RootNode', scale: 1 },
  // Cab and front wheels at −Z already (not +Z: turning it drove it backwards).
  { name: 'gaz52', file: 'gaz-52_base.glb', pick: 'RootNode', scale: 1 },
  // Small front wheels at −Z.
  { name: 'mtz80', file: 'mtz-80__lowpoly.glb', pick: 'RootNode', scale: 1 },
  // Millimetres: 3.0 m at 0.001; 0.0013 for a compact tractor's 3.9 m. Bonnet at +Z.
  { name: 'tractorSmall', file: 'tractor.glb', pick: '92b03e196abe46fd8c9d62f6e066daae.obj.cleaner.materialmerger.gles', scale: 0.0013, rotY: FACE_PZ, tyres: true },
  { name: 'plough', file: 'plow_lowpoly.glb', pick: 'RootNode', scale: 1 },
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const mul = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
const mulDir = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('farmset');
const data = { parts: {} };
/**
 * Output materials by source material. Made per mesh instead, each wheel
 * carried its own copy of the texture, and the file grew from 0.8 to 3.1 MB.
 */
const materials = new Map();

for (const spec of PARTS) {
  const doc = await io.read(source(spec.file));
  const top = doc.getRoot().listNodes().find((n) => n.getName() === spec.pick);
  if (!top) throw new Error(`${spec.file}: no node "${spec.pick}"`);
  const ca = Math.cos(spec.rotY ?? 0);
  const sa = Math.sin(spec.rotY ?? 0);
  const yaw = (a, b) => [a * ca + b * sa, -a * sa + b * ca];

  // Every primitive under the pick, to world space, turned and scaled, by
  // material: the body's in `byMaterial`, each wheel's in its own map.
  const byMaterial = new Map();
  const wheels = new Map();
  const add = (groups, key, entry) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  };
  const walk = (node, wheel = null) => {
    // Road wheels only: not the steering wheel (the Niva's is `Stearing_wheel`)
    // nor its `Wheel_Rotator`, a drive part inside the body.
    if (!wheel && /wheel/i.test(node.getName()) && !/ste[ae]ring|rotator/i.test(node.getName())) wheel = node.getName();
    const mesh = node.getMesh();
    if (mesh) {
      const world = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const nrm = prim.getAttribute('NORMAL');
        const uv = prim.getAttribute('TEXCOORD_0');
        const idx = prim.getIndices();
        const n = pos.getCount();
        const p = new Float32Array(n * 3);
        const q = new Float32Array(n * 3);
        const t = new Float32Array(n * 2);
        const v = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          pos.getElement(i, v);
          const w = mul(world, v);
          const [wx, wz] = yaw(w[0], w[2]);
          p.set([wx * spec.scale, w[1] * spec.scale, wz * spec.scale], i * 3);
          if (nrm) {
            nrm.getElement(i, v);
            const d = mulDir(world, v);
            const [dx, dz] = yaw(d[0], d[2]);
            const len = Math.hypot(dx, d[1], dz) || 1;
            q.set([dx / len, d[1] / len, dz / len], i * 3);
          } else q.set([0, 1, 0], i * 3);
          if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
        }
        const index = idx
          ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
          : Uint32Array.from({ length: n }, (_, i) => i);
        const key = prim.getMaterial();
        const entry = { p, q, t, index };
        if (wheel) {
          if (!wheels.has(wheel)) wheels.set(wheel, new Map());
          add(wheels.get(wheel), key, entry);
        } else if (spec.tyres) {
          const { body, tyres } = splitTyres(entry);
          add(byMaterial, key, body);
          tyres.forEach((tyre, k) => {
            const name = `${node.getName()}#${k}`;
            if (!wheels.has(name)) wheels.set(name, new Map());
            add(wheels.get(name), key, tyre);
          });
        } else add(byMaterial, key, entry);
      }
    }
    for (const child of node.listChildren()) walk(child, wheel);
  };
  walk(top);

  // Bounds, then centre on the footprint and stand on y = 0.
  const bounds = (maps) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const groups of maps) for (const group of groups.values()) for (const { p } of group) {
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[i + k]);
        hi[k] = Math.max(hi[k], p[i + k]);
      }
    }
    return { lo, hi };
  };
  const { lo, hi } = bounds([byMaterial, ...wheels.values()]);
  const shift = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];

  const partNode = out.createNode(spec.name).setMesh(await build(spec, spec.name, byMaterial, shift));
  scene.addChild(partNode);
  // Each wheel at its hub: the middle of its own bounds, in the part's frame.
  const hubs = [];
  for (const [name, groups] of wheels) {
    const b = bounds([groups]);
    const centre = [0, 1, 2].map((k) => (b.lo[k] + b.hi[k]) / 2);
    const hub = centre.map((v, k) => +(v - shift[k]).toFixed(4));
    const radius = +(Math.max(b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2).toFixed(4);
    const wheelName = `${spec.name}Wheel${hubs.length}`;
    partNode.addChild(out.createNode(wheelName)
      .setMesh(await build(spec, wheelName, groups, centre))
      .setTranslation(hub)
      .setExtras({ wheel: true, radius }));
    hubs.push({ source: name, hub, radius });
  }
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((v) => +v.toFixed(3));
  data.parts[spec.name] = { size, wheels: hubs.map(({ hub, radius }) => ({ hub, radius })) };
  console.log(`  ${spec.name.padEnd(13)} ${size.map((v) => v.toFixed(2)).join(' x ').padEnd(22)} m  ${hubs.length} wheels  `
    + hubs.map((h) => `r${h.radius.toFixed(2)}@${h.hub[2].toFixed(2)}`).join(' '));
}

/** One output material per source material, shared by a part's body and wheels. */
async function materialFor(spec, srcMaterial) {
  const key = srcMaterial ?? spec.name;
  if (materials.has(key)) return materials.get(key);
  const material = out.createMaterial(srcMaterial?.getName() || spec.name)
    .setBaseColorFactor(srcMaterial?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.85)
    .setDoubleSided(srcMaterial?.getDoubleSided() ?? false);
  const tex = srcMaterial?.getBaseColorTexture();
  if (tex?.getImage()) {
    const webp = await sharp(Buffer.from(tex.getImage()))
      .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer();
    material.setBaseColorTexture(out.createTexture(`${spec.name}-tex`).setImage(webp).setMimeType('image/webp'));
  }
  materials.set(key, material);
  return material;
}

/** One mesh of a group of primitives by material, every vertex less `shift`. */
async function build(spec, name, byMaterial, shift) {
  const meshOut = out.createMesh(name);
  for (const [srcMaterial, group] of byMaterial) {
    const verts = group.reduce((a, g) => a + g.p.length / 3, 0);
    const P = new Float32Array(verts * 3);
    const N = new Float32Array(verts * 3);
    const T = new Float32Array(verts * 2);
    const I = new Uint32Array(group.reduce((a, g) => a + g.index.length, 0));
    let vo = 0;
    let io2 = 0;
    for (const g of group) {
      const count = g.p.length / 3;
      for (let i = 0; i < count; i++) {
        P[(vo + i) * 3] = g.p[i * 3] - shift[0];
        P[(vo + i) * 3 + 1] = g.p[i * 3 + 1] - shift[1];
        P[(vo + i) * 3 + 2] = g.p[i * 3 + 2] - shift[2];
      }
      N.set(g.q, vo * 3);
      T.set(g.t, vo * 2);
      for (let k = 0; k < g.index.length; k++) I[io2 + k] = g.index[k] + vo;
      vo += count;
      io2 += g.index.length;
    }

    const material = await materialFor(spec, srcMaterial);
    const prim = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(N).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(T).setBuffer(buffer))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(I).setBuffer(buffer))
      .setMaterial(material);
    meshOut.addPrimitive(prim);
  }
  return meshOut;
}

/**
 * A welded mesh split into its body and its tyres. Triangles are joined into
 * pieces by shared positions; a tyre is a piece that stands on the mesh's
 * lowest point, is as tall as it is long (round, seen from the side), and is
 * thinner across than either.
 */
function splitTyres({ p, q, t, index }) {
  const n = p.length / 3;
  const id = new Map();
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(p[i * 3] * 1000)},${Math.round(p[i * 3 + 1] * 1000)},${Math.round(p[i * 3 + 2] * 1000)}`;
    if (!id.has(key)) id.set(key, id.size);
    rep[i] = id.get(key);
  }
  const parent = Int32Array.from({ length: id.size }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let k = 0; k < index.length; k += 3) {
    const a = find(rep[index[k]]);
    for (const j of [1, 2]) { const b = find(rep[index[k + j]]); if (a !== b) parent[b] = a; }
  }
  const pieces = new Map();
  let floor = Infinity;
  for (let i = 0; i < n; i++) {
    const r = find(rep[i]);
    if (!pieces.has(r)) pieces.set(r, { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
    const b = pieces.get(r);
    for (let k = 0; k < 3; k++) {
      b.lo[k] = Math.min(b.lo[k], p[i * 3 + k]);
      b.hi[k] = Math.max(b.hi[k], p[i * 3 + k]);
    }
    floor = Math.min(floor, p[i * 3 + 1]);
  }
  const tyreRoots = [...pieces].filter(([, b]) => {
    const [dx, dy, dz] = [0, 1, 2].map((k) => b.hi[k] - b.lo[k]);
    return dy > 0.3 && b.lo[1] - floor < 0.1 && Math.abs(dy - dz) < 0.1 * dy && dx < 0.6 * dy;
  }).map(([r]) => r);
  // The kept triangles, and only the vertices they use.
  const pick = (keep) => {
    const remap = new Map();
    const tris = [];
    for (let k = 0; k < index.length; k += 3) {
      if (!keep(find(rep[index[k]]))) continue;
      for (let j = 0; j < 3; j++) {
        const v = index[k + j];
        if (!remap.has(v)) remap.set(v, remap.size);
        tris.push(remap.get(v));
      }
    }
    const P = new Float32Array(remap.size * 3);
    const Q = new Float32Array(remap.size * 3);
    const T = new Float32Array(remap.size * 2);
    for (const [v, w] of remap) {
      P.set(p.subarray(v * 3, v * 3 + 3), w * 3);
      Q.set(q.subarray(v * 3, v * 3 + 3), w * 3);
      T.set(t.subarray(v * 2, v * 2 + 2), w * 2);
    }
    return { p: P, q: Q, t: T, index: Uint32Array.from(tris) };
  };
  return {
    body: pick((r) => !tyreRoots.includes(r)),
    tyres: tyreRoots.map((root) => pick((r) => r === root)),
  };
}

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${DST} and ${DATA}`);
