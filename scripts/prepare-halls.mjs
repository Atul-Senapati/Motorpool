/**
 * Turns the dropped halls and shops into the sporting hall, the assembly hall
 * and the three shops that stand on Kestrel's grid.
 *
 *     npm run prepare:halls
 *
 * Both are Sketchfab exports of the same kind of thing — a big public building
 * modelled standing in a plot of its own — and both arrive WITH the plot:
 *
 * - `sporting_event_hall.glb`: eight parts, 6,306 triangles, in metres. A hall
 *   with four round corner towers and a flat roof, standing on a 112 x 138 m
 *   slab of paving (`tdtt_NenXiMang_512`) that is the backdrop, not the
 *   building.
 * - `assembly_room.glb`: thirteen parts, 4,007 triangles, in units of about ten
 *   to the metre. A great hipped roof on a colonnade, set in a 1,265 x 2,218
 *   plot — a giant ground plane, a ground texture, two round planters and a
 *   reflection plane.
 *
 * Kestrel has grass of its own, so everything the building was standing ON is
 * dropped by material name and what is left measures itself: the size written
 * out is the size of the BUILDING, which is what a block has to hold.
 *
 * Otherwise this is the mall's recipe: bake the node transforms flat, merge by
 * material, stand on the deck (the commonest height among near-horizontal
 * vertices low down), centre on the footprint, re-cut the textures to WebP,
 * Draco.
 *
 * Writes, for each hall:
 *   public/models/<name>.glb     Draco, one node.
 *   src/config/<name>Data.json   Its measured size and skirt.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { source } from './sourceModels.mjs';

const HALLS = [
  {
    name: 'sportsHall',
    file: 'sporting_event_hall.glb',
    /** Source units per metre: this one is already in metres. */
    unit: 1,
    /**
     * The courtyard paving sits at -1.2, and the commonest flat low down is a
     * terrace step at +3: that would bury the courtyard four metres. Stand on the
     * paving instead.
     */
    deck: -1.2,
    /** The 112 x 138 m paving the hall stood on. The courtyard floor stays. */
    drop: /^tdtt_NenXiMang_512$/,
  },
  {
    name: 'assemblyHall',
    file: 'assembly_room.glb',
    /** About ten units to the metre: a 770-unit hall is a 77 m one. */
    unit: 10,
    /**
     * Triangles past this z (source units) are free-standing posts out in the
     * lot, 540 units beyond the hall's own porch, and they would double its
     * length. The porch ends at z = 41.
     */
    clipZ: 60,
    /**
     * The plot: `lambert3` is the giant ground plane, `htr_gachBongSan_256` the
     * ground texture on the lot, `material` and `htr_phanChieu` flat planes at
     * the bottom of it, `htr_1024_loop_1` the two round planters and
     * `ghe_dalambert3` a stone bench stranded out in the lot.
     */
    drop: /^(lambert3|htr_gachBongSan_256|material|htr_phanChieu|htr_1024_loop_1|ghe_dalambert3)$/,
  },
  /*
   * Three shops, all in metres and upright, none of them with a plot to drop
   * except the burger bar's 54 x 46 m ground plate (`Material.004`). The
   * drive-thru lanes and the car park decals are kept: they are the lot.
   */
  { name: 'macShop', file: 'engadine_mcdonalds_restaurant_low_poly.glb', unit: 1, drop: /^$/ },
  { name: 'jacksShop', file: 'hungry_jacks_restaurant_low_poly.glb', unit: 1, drop: /^Material\.004$/ },
  { name: 'tilesShop', file: 'national_tiles_and_solomons_flooring_low_poly.glb', unit: 1, drop: /^$/ },
  /*
   * The factory is a whole industrial estate — 538 x 146 m at its true size
   * (centimetres), three long ranges of sheds with roads between them — and
   * the strip east of Halcyon Junction is 140 x 40. Shrinking the estate to fit
   * would leave sheds two metres tall under a ten-metre chimney, so instead the
   * one part of it that is a factory is kept at full size: the sawtooth-roofed
   * production hall, its office block and the chimney, at the estate's
   * north-east corner. The rest is dropped by position.
   */
  {
    name: 'factoryHall',
    file: 'factory (1).glb',
    unit: 100,
    /** The slab is at zero; the commonest flat low down is the sheds' eaves at 7 m. */
    deck: 0,
    drop: /^$/,
    keepAt: (x, z) => x > 32900 && x < 46900 && z > -13900 && z < -11100,
    /**
     * The source hall is a roof and a row of skylights with NO long walls: in
     * the estate its sides were hidden by the neighbouring sheds, so cut out on
     * its own it is open to the sea. Four walls are added round its body (output
     * metres, measured off the roof slab), painted with a flat sample of the
     * building's own cladding.
     */
    walls: { x0: -52.5, x1: 67.5, z0: -8.5, z1: 10.4, h: 26, uv: [0.435, 0.28] },
  },
  /*
   * A single shed from the estate's lower row of six, for the rest of the
   * ground beside the line: 50 x 21 m, the same cladding as the production
   * hall, scattered between its bigger sibling.
   */
  {
    name: 'factoryShed',
    file: 'factory (1).glb',
    unit: 100,
    deck: 0,
    drop: /^$/,
    keepAt: (x, z) => x > 12500 && x < 17700 && z > -5400 && z < -2900,
  },
  /*
   * Two more small pieces from the estate's south edge, to fill the odd-sized
   * gaps between the sheds: a plain depot and a small block.
   */
  {
    name: 'factoryDepot',
    file: 'factory (1).glb',
    unit: 100,
    deck: 0,
    drop: /^$/,
    keepAt: (x, z) => x > 29200 && x < 34900 && z > -1900 && z < 700,
  },
  {
    name: 'factoryBlock',
    file: 'factory (1).glb',
    unit: 100,
    deck: 0,
    drop: /^$/,
    keepAt: (x, z) => x > 24500 && x < 26900 && z > -2700 && z < -700,
  },
  /*
   * The aqua park, for the ground beside the Wall of Death: slides, pools,
   * an entrance building and a play area, in metres. It stands on an 83 m
   * lawn plate (`grass`) — the island has grass of its own — so the lawns go
   * and everything built stays. Its paving sits at zero.
   */
  {
    name: 'aquaPark', file: 'aqua_park.glb', unit: 1, deck: 0, drop: /^grass$/,
    /** Its bushes and entrance are BLEND; cut-outs sort properly where blended leaves do not. */
    blendToMask: true,
  },
];

const TEXTURE_SIZE = 1024;
/** Height bucket for finding the deck. Fine enough to separate a kerb from it. */
const DECK_BUCKET = 0.1;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const step = (msg) => console.log(`  ${msg}`);

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

/** `npm run prepare:halls -- factoryHall` bakes just that one. */
const only = process.argv[2];
for (const hall of HALLS) {
  if (only && hall.name !== only) continue;
  const SRC = source(hall.file);
  const DST = `public/models/${hall.name}.glb`;
  const DATA = `src/config/${hall.name}Data.json`;
  const srcSize = readFileSync(SRC).byteLength;
  console.log(`\n--- ${hall.name} ---`);
  step(`reading ${SRC} (${mb(srcSize)})`);
  const doc = await io.read(SRC);

  const parts = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      if (hall.drop.test(prim.getMaterial()?.getName() ?? '')) continue;
      const nrm = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const count = pos.getCount();
      const p = new Float32Array(count * 3);
      const n = new Float32Array(count * 3);
      const t = new Float32Array(count * 2);
      const v = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        pos.getElement(i, v);
        p.set(mul(world, v), i * 3);
        if (nrm) {
          nrm.getElement(i, v);
          const d = mulDir(world, v);
          const len = Math.hypot(...d) || 1;
          n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
        }
        if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
      }
      const idx = prim.getIndices();
      parts.push({
        pos: p,
        nrm: n,
        uv: t,
        idx: idx
          ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
          : Uint32Array.from({ length: count }, (_, i) => i),
        material: prim.getMaterial(),
      });
    }
  }
  if (!parts.length) throw new Error(`no geometry left in ${hall.file}`);
  if (hall.clipZ !== undefined || hall.keepAt) {
    for (const part of parts) {
      const keep = [];
      for (let i = 0; i < part.idx.length; i += 3) {
        const z = (part.pos[part.idx[i] * 3 + 2] + part.pos[part.idx[i + 1] * 3 + 2]
          + part.pos[part.idx[i + 2] * 3 + 2]) / 3;
        const x = (part.pos[part.idx[i] * 3] + part.pos[part.idx[i + 1] * 3]
          + part.pos[part.idx[i + 2] * 3]) / 3;
        if ((hall.clipZ === undefined || z <= hall.clipZ) && (!hall.keepAt || hall.keepAt(x, z))) keep.push(part.idx[i], part.idx[i + 1], part.idx[i + 2]);
      }
      const remap = new Map();
      const used = [];
      for (const k of keep) if (!remap.has(k)) { remap.set(k, used.length); used.push(k); }
      const p = new Float32Array(used.length * 3);
      const n = new Float32Array(used.length * 3);
      const t = new Float32Array(used.length * 2);
      used.forEach((k, j) => {
        p.set(part.pos.subarray(k * 3, k * 3 + 3), j * 3);
        n.set(part.nrm.subarray(k * 3, k * 3 + 3), j * 3);
        t.set(part.uv.subarray(k * 2, k * 2 + 2), j * 2);
      });
      part.pos = p; part.nrm = n; part.uv = t;
      part.idx = Uint32Array.from(keep, (k) => remap.get(k));
    }
    for (let i = parts.length - 1; i >= 0; i--) if (!parts[i].idx.length) parts.splice(i, 1);
  }

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], part.pos[i + k]);
        hi[k] = Math.max(hi[k], part.pos[i + k]);
      }
    }
  }
  let size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const triangles = parts.reduce((a, p) => a + p.idx.length / 3, 0);
  step(`${parts.length} parts, ${triangles.toLocaleString()} triangles, `
    + `${size[0].toFixed(1)} x ${size[2].toFixed(1)}, ${size[1].toFixed(1)} tall (source units)`);

  /* The deck: commonest height among the flat-facing vertices low down. */
  const deck = hall.deck ?? (() => {
    const band = lo[1] + size[1] * 0.2;
    const hist = new Map();
    for (const part of parts) {
      for (let i = 0; i < part.pos.length; i += 3) {
        const y = part.pos[i + 1];
        if (y > band) continue;
        if (part.nrm.length && Math.abs(part.nrm[i + 1]) < 0.8) continue;
        const k = Math.round(y / (DECK_BUCKET * hall.unit));
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
    }
    if (!hist.size) return lo[1];
    const [best] = [...hist].sort((a, b) => b[1] - a[1]);
    return best[0] * DECK_BUCKET * hall.unit;
  })();
  step(`deck at y = ${deck.toFixed(2)} (box starts at ${lo[1].toFixed(2)})`);

  const cx = (lo[0] + hi[0]) / 2;
  const cz = (lo[2] + hi[2]) / 2;
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      part.pos[i] = (part.pos[i] - cx) / hall.unit;
      part.pos[i + 1] = (part.pos[i + 1] - deck) / hall.unit;
      part.pos[i + 2] = (part.pos[i + 2] - cz) / hall.unit;
    }
  }
  size = size.map((v) => v / hall.unit);
  if (hall.walls) {
    const { x0, x1, z0, z1, h, uv } = hall.walls;
    // Four outward-facing quads, two triangles each.
    const quads = [
      [[x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0], [0, 0, -1]],
      [[x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1], [0, 0, 1]],
      [[x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1], [-1, 0, 0]],
      [[x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0], [1, 0, 0]],
    ];
    const pos = new Float32Array(quads.length * 12);
    const nrm = new Float32Array(quads.length * 12);
    const uvs = new Float32Array(quads.length * 8);
    const idx = new Uint32Array(quads.length * 6);
    quads.forEach((q, i) => {
      for (let k = 0; k < 4; k++) {
        pos.set(q[k], (i * 4 + k) * 3);
        nrm.set(q[4], (i * 4 + k) * 3);
        uvs.set(uv, (i * 4 + k) * 2);
      }
      idx.set([0, 2, 1, 0, 3, 2].map((n) => n + i * 4), i * 6);
    });
    // Reversed order: the corners above wind counter-clockwise seen from INSIDE.
    parts.push({ pos, nrm, uv: uvs, idx, material: parts[0].material });
    step('added four walls round the hall body');
  }
  const skirt = (deck - lo[1]) / hall.unit;

  const out = new Document();
  out.createBuffer();
  const buffer = out.getRoot().listBuffers()[0];
  const scene = out.createScene(hall.name);

  let imageBefore = 0;
  let imageAfter = 0;
  const copied = new Map();
  const copyMaterial = async (src) => {
    if (copied.has(src)) return copied.get(src);
    let texture = null;
    const srcTexture = src?.getBaseColorTexture();
    if (srcTexture?.getImage()) {
      imageBefore += srcTexture.getImage().byteLength;
      const webp = await sharp(Buffer.from(srcTexture.getImage()))
        .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86 })
        .toBuffer();
      imageAfter += webp.byteLength;
      texture = out.createTexture(srcTexture.getName() || hall.name)
        .setImage(webp).setMimeType('image/webp');
    }
    const m = out.createMaterial(src?.getName() || hall.name)
      .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
      .setMetallicFactor(src?.getMetallicFactor() ?? 0)
      .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.85)
      .setAlphaMode(hall.blendToMask && src?.getAlphaMode() === 'BLEND' ? 'MASK' : (src?.getAlphaMode() ?? 'OPAQUE'))
      .setDoubleSided(src?.getDoubleSided() ?? true)
      .setAlphaCutoff(src?.getAlphaCutoff() ?? 0.5);
    if (texture) m.setBaseColorTexture(texture);
    copied.set(src, m);
    return m;
  };

  const byMaterial = new Map();
  for (const part of parts) {
    const list = byMaterial.get(part.material) ?? [];
    list.push(part);
    byMaterial.set(part.material, list);
  }
  const mesh = out.createMesh(hall.name);
  for (const [srcMaterial, list] of byMaterial) {
    const vCount = list.reduce((a, p) => a + p.pos.length / 3, 0);
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const uvs = new Float32Array(vCount * 2);
    const idx = new Uint32Array(list.reduce((a, p) => a + p.idx.length, 0));
    let vo = 0;
    let io2 = 0;
    for (const part of list) {
      pos.set(part.pos, vo * 3);
      nrm.set(part.nrm, vo * 3);
      uvs.set(part.uv, vo * 2);
      for (let i = 0; i < part.idx.length; i++) idx[io2 + i] = part.idx[i] + vo;
      vo += part.pos.length / 3;
      io2 += part.idx.length;
    }
    mesh.addPrimitive(out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
      .setMaterial(await copyMaterial(srcMaterial)));
  }
  if (imageBefore) step(`${copied.size} materials, textures to WebP, ${mb(imageBefore)} -> ${mb(imageAfter)}`);
  scene.addChild(out.createNode(hall.name).setMesh(mesh));

  out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });
  await io.write(DST, out);
  writeFileSync(DATA, `${JSON.stringify({
    model: `/${DST.replace(/^public\//, '')}`,
    size: size.map((v) => +v.toFixed(3)),
    skirt: +skirt.toFixed(3),
    triangles,
  }, null, 2)}\n`);

  console.log(`  ${size[0].toFixed(1)} x ${size[2].toFixed(1)} m, ${size[1].toFixed(1)} m tall, `
    + `${triangles.toLocaleString()} tris`);
  console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}`);
}
