/**
 * The high street: twelve commercial buildings lifted out of the city map.
 *
 * The island has a park, an airport, a station and a town, and every building
 * that has gone up on it so far has been a HOUSE — because houses are what the
 * map has most of, and because a terrace is the easy thing to stamp down. The
 * result reads as a dormitory suburb with an airport attached. What it has
 * never had is a shop: somewhere the road goes TO rather than past.
 *
 * `prepare-park.mjs` already proved the technique on the fairground's arcade —
 * `readPicks` walks the map's node table, takes a named object and its subtree,
 * bakes the world matrices and recentres the result — and this is that, aimed
 * at the commercial blocks instead of at benches and trees. Everything here is
 * a shopfront, a hotel, an office or a depot, chosen ONE AT A TIME out of the
 * `Commerce_Center`, `Building_Beach`, `Building_Center` and `industrial`
 * families. No houses, deliberately: the island has enough of those, and the
 * whole point of this file is the half-kilometre of frontage it does not have.
 *
 * Why picks rather than `cityChunks`, which already stamps 250 m cells of the
 * processed city down: a cell is a hundred buildings welded into one mesh with
 * the roads they stand on, which is right for a skyline and useless for putting
 * one supermarket at the end of one street. These come out as single objects,
 * each recentred on its own footprint and stood on y = 0, so placing one is an
 * (x, z, turn) and its collider is half the size recorded in the JSON.
 *
 * Reading the map at all is the expensive part — 198 MB, 12,103 meshes — so
 * every pick is resolved in ONE walk of the node table, as the park's is.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync, statSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const CITY = source('drive_for_speed_-_map.glb');
/**
 * The map is authored in FBX centimetres and scaled by 0.01 at its root, so its
 * world units are hundreds of metres. `prepare-map.mjs` calls the same number
 * `UNIT_SCALE` and `prepare-park.mjs` calls it this; a shop read without it
 * comes out a third of a metre wide.
 */
const CITY_UNITS = 100;
const DST = 'public/models/parade.glb';
const DATA = 'src/config/paradeModelData.json';
const TEXTURE_SIZE = 1024;

/**
 * Pavement that came along with the building it was modelled beside.
 *
 * Two of these picks carry a scrap of the city's `Street` material inside their
 * own subtree — a forecourt apron on `parade`, a 9.8 x 24.4 m footway slab on
 * `hotel` — and the hotel's is the reason this exists: it is a perfectly flat
 * quad sitting at the building's lowest point, which after grounding is y = 0
 * exactly. Two coplanar surfaces z-fight, and here the other surface is the
 * whole island. Neither scrap is load-bearing and neither changes a footprint
 * (both sit inside their building's own bounds), so both go: a parade part is a
 * BUILDING, and the ground it stands on belongs to whatever places it.
 */
const DROP_MATERIALS = new Set(['Street']);

/**
 * The parts: what each one is called here, which node it comes out of, and how
 * big it should be.
 *
 * `pick` is the map's own node name and `instance` indexes the nodes carrying
 * that name in `listNodes()` order, because the map does not name its repeats
 * uniquely — there are eleven `Commerce_Center_05` and four `Building_Center_29`
 * — and matching on the name alone would gather every copy scattered over a
 * kilometre of city into one mesh.
 *
 * `metres` is the size of the longest HORIZONTAL axis, and it is a MEASUREMENT
 * rather than a target. It is stated on every part rather than left to the
 * source because the map scales each copy of a block to the plot it stands on,
 * so the instance index alone does not settle how big a thing comes out — but
 * the figure stated has to be the one that instance actually has, or the pick
 * quietly becomes a resize.
 *
 * Five of them were wrong on the first pass and the errors were the same two
 * mistakes twice over. `store` was given 52.3, which is its X extent while its
 * longest horizontal is 54.0 on Z. `officeSlim` was given 19.3, which is its
 * HEIGHT and not a horizontal axis at all. Both scaled a building to hit a
 * number that was never its length, and `hotel`, `hotelTower` and `depot` were
 * simply 15 to 24 per cent adrift. Every figure below now reads back at scale
 * 1.00 in the `scale` column the run prints, which is the check: a pick exists
 * to take a building out of the city as it is.
 *
 * `floor: 'min'` on all of them, and not the percentile the park uses for
 * strays: these are buildings sitting flat on the map's ground plane, their
 * lowest vertices ARE the slab, and a percentile that discards the bottom
 * tenth of a per cent would sink each one by its own doorstep.
 */
const PARTS = [
  /* ------------------------------------------------------------- the shops */

  // The supermarket: a 52 m big-box store with its own service yard. The
  // largest thing here by footprint and the anchor any parade is built around.

  { name: 'store', pick: 'Commerce_Center_14', instance: 0, metres: 54.0, floor: 'min' },
  // A single-storey retail box, 31 m — the unit a chemist or a bank occupies.
  { name: 'retailBox', pick: 'Commerce_Center_03', instance: 0, metres: 31.5, floor: 'min' },
  /*
   * The parade proper, and the reason the file is called this: four retail
   * units in a row under one roofline, 65 m end to end. One object rather than
   * four, which is exactly what makes it useful — four separate shopfronts
   * placed by hand never line up, and this arrived already lined up.
   */
  { name: 'parade', pick: 'Commerce_Center_07', instance: 0, metres: 64.8, floor: 'min' },
  // A small unit with a forecourt canopy — the petrol-station silhouette, and
  // the only one here with anything covered in front of it.
  { name: 'shopUnit', pick: 'Commerce_Center_09', instance: 0, metres: 24.4, floor: 'min' },
  // Three narrow units, so a street can be built without the same frontage
  // twice in a row: a two-storey storefront, a shop with a flat over it, and a
  // flat-roofed single-storey box.
  { name: 'shopTall', pick: 'Commerce_Center_05', instance: 0, metres: 15.9, floor: 'min' },
  { name: 'shopDuo', pick: 'Commerce_Center_10', instance: 0, metres: 20.0, floor: 'min' },
  { name: 'shopFlat', pick: 'Commerce_Center_18', instance: 0, metres: 20.1, floor: 'min' },

  /* ------------------------------------------------------- the big frontage */

  /*
   * Two hotels off the map's beach strip, which is where it keeps the only
   * buildings that are neither houses nor city-centre towers.
   *
   * `hotel` is the low seafront block — four storeys around a court, reading as
   * a motel — and `hotelTower` is the tall one, a podium with four storeys of
   * rooms over it. Between them they give a waterfront a reason to exist, and
   * the island has 3 km of waterfront and nothing on it.
   */
  { name: 'hotel', pick: 'Building_Beach_01', instance: 0, metres: 39.0, floor: 'min' },
  { name: 'hotelTower', pick: 'Building_Beach_03', instance: 0, metres: 36.4, floor: 'min' },
  // Two offices out of the city centre, at the small end of that family: a
  // 20 m tower and a narrow infill block to stand beside it. Anything bigger
  // out of `Building_Center` is a downtown high-rise and would dwarf the town.
  { name: 'office', pick: 'Building_Center_29', instance: 0, metres: 20.0, floor: 'min' },
  { name: 'officeSlim', pick: 'Building_Center_14', instance: 0, metres: 15.7, floor: 'min' },

  /* ------------------------------------------------------------- the depot */

  /*
   * A flat-roof workshop shed, out of the map's industrial estate — note the
   * SPACE in `industrial H03.001`, which is the real node name and not a typo
   * to be tidied away.
   *
   * 28 triangles for 37 m of building, because it is six boxes and a roof with
   * everything else painted on a 1024px atlas. That is the cheapest thing in
   * this file by two orders of magnitude, and it is what a goods yard, a bus
   * garage or the back of a trading estate is actually made of.
   */
  { name: 'depot', pick: 'industrial H03.001', instance: 0, metres: 30.4, floor: 'min' },

  /* ------------------------------------------- the rest of the high street */

  /*
   * NOT picked: `Commerce_Center_15`, the 86 m mall shell, and
   * `industrial I02.001`, the 78 m warehouse pair.
   *
   * The west strip has three pieces of ground clear of a carriageway and the
   * deepest is 86 m, between the landside road and the outer road. A building
   * that needs all 86 leaves no footway at either end, and one that needs 78
   * leaves four metres. Both were picked, measured and taken out again rather
   * than shaved down: a building squeezed into a band it does not fit is the
   * overlap problem in a smaller font.
   */

  // Four more small units, so the terrace can run without repeating itself
  // every second door.
  { name: 'shopCorner', pick: 'Commerce_Center_01', instance: 0, metres: 20.4, floor: 'min' },
  { name: 'shopNarrow', pick: 'Commerce_Center_02', instance: 0, metres: 16.2, floor: 'min' },
  { name: 'shopPair', pick: 'Commerce_Center_19', instance: 0, metres: 20.0, floor: 'min' },
  // Two taller commercial blocks off the same family: five and six storeys of
  // shop-with-flats-over, which is what breaks a low terrace's skyline.
  { name: 'blockTall', pick: 'Commerce_Center_20', instance: 0, metres: 23.3, floor: 'min' },
  { name: 'blockMid', pick: 'Commerce_Center_21', instance: 0, metres: 23.3, floor: 'min' },
  // Three offices for the back of the strip, where a high street keeps them.
  { name: 'officeMid', pick: 'Building_Center_23', instance: 0, metres: 27.3, floor: 'min' },
  { name: 'officeSquare', pick: 'Building_Center_27', instance: 0, metres: 31.5, floor: 'min' },
  // A chamfered corner block, which is the one shape that reads as a junction
  // rather than as a wall. 36.1 and not 41.8: the catalogue figure was the
  // footprint of the group, this is the instance's own longest horizontal.
  { name: 'cornerBlock', pick: 'DiagonalBuilding_Center_06', instance: 0, metres: 36.1, floor: 'min' },
  // The second beach hotel, terraced in five steps: the anchor the west end
  // of the strip never had. 58.0 for the same reason as the block above.
  { name: 'hotelBig', pick: 'Building_Beach_02', instance: 0, metres: 58.0, floor: 'min' },

  /*
   * No parcel-hub building any more: `hubDepot`, one building `isolate`d out
   * of `industrial I02`, stood at the hub's north end until the user found it
   * "too old" and it gave way to a modern shed built in `CourierHub`. The
   * `near`/`dropBelow` options stay for the next time one building has to
   * come out of a welded city block.
   */
];

/**
 * One building out of a block that the map welded into a single mesh.
 *
 * The map's `industrial` blocks are each one mesh for a whole city block, so
 * picking by node gives you every building on it. This finds the separate
 * buildings — triangles joined by a shared vertex (welded at 2 cm, since the
 * export splits vertices along UV seams), then pieces whose footprints touch
 * gathered into one — and keeps only the one whose footprint holds `near`,
 * in the map's world units scaled by `CITY_UNITS`.
 */
const isolate = (prims, near, dropBelow = 0) => {
  const tris = [];
  prims.forEach((p, pi) => { for (let t = 0; t < p.idx.length; t += 3) tris.push([pi, t]); });
  const vert = (pi, v) => [prims[pi].pos[v * 3], prims[pi].pos[v * 3 + 1], prims[pi].pos[v * 3 + 2]];
  const parent = tris.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  tris.forEach(([pi, t], i) => {
    for (let k = 0; k < 3; k++) {
      const key = vert(pi, prims[pi].idx[t + k]).map((c) => Math.round(c * 50)).join(',');
      if (owner.has(key)) { const a = find(owner.get(key)); const b = find(i); if (a !== b) parent[a] = b; } else owner.set(key, i);
    }
  });
  const groups = new Map();
  tris.forEach(([pi, t], i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { lo: [Infinity, Infinity], hi: [-Infinity, -Infinity], members: [] });
    const g = groups.get(r);
    g.members.push(i);
    for (let k = 0; k < 3; k++) {
      const v = vert(pi, prims[pi].idx[t + k]);
      g.lo = [Math.min(g.lo[0], v[0]), Math.min(g.lo[1], v[2])];
      g.hi = [Math.max(g.hi[0], v[0]), Math.max(g.hi[1], v[2])];
    }
  });
  // Pieces whose footprints touch are one building — leaving out, first, any
  // piece that reaches no higher than `dropBelow` metres over the block's
  // ground (a yard wall, a kerb). How HIGH it reaches, not how tall it is: a
  // roof vent is half a metre tall and eight metres up.
  let ground = Infinity;
  for (const p of prims) for (let v = 1; v < p.pos.length; v += 3) ground = Math.min(ground, p.pos[v]);
  for (const [r, g] of groups) {
    let top = -Infinity;
    for (const i of g.members) {
      const [pi, t] = tris[i];
      for (let k = 0; k < 3; k++) top = Math.max(top, vert(pi, prims[pi].idx[t + k])[1]);
    }
    if (dropBelow && top - ground < dropBelow) groups.delete(r);
  }
  const list = [...groups.values()];
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length && !merged; j++) {
        const a = list[i]; const b = list[j]; const s = 0.5;
        if (a.lo[0] - s < b.hi[0] && b.lo[0] - s < a.hi[0] && a.lo[1] - s < b.hi[1] && b.lo[1] - s < a.hi[1]) {
          a.lo = [Math.min(a.lo[0], b.lo[0]), Math.min(a.lo[1], b.lo[1])];
          a.hi = [Math.max(a.hi[0], b.hi[0]), Math.max(a.hi[1], b.hi[1])];
          a.members.push(...b.members);
          list.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  const hit = list.find((g) => near[0] > g.lo[0] && near[0] < g.hi[0] && near[1] > g.lo[1] && near[1] < g.hi[1]);
  if (!hit) throw new Error(`isolate: no building at ${near.join(', ')}`);
  const keep = new Set(hit.members);
  return prims.map((p, pi) => {
    const idx = [];
    tris.forEach(([qi, t], i) => { if (qi === pi && keep.has(i)) idx.push(p.idx[t], p.idx[t + 1], p.idx[t + 2]); });
    return { ...p, idx: Uint32Array.from(idx) };
  }).filter((p) => p.idx.length);
};

/**
 * See `prepare-airport.mjs`: the floor can be a low percentile rather than the
 * minimum, for parts whose lowest vertex is a stray. Nothing here asks for it —
 * every part above says `floor: 'min'` — but the option is what makes that
 * statement mean something.
 *
 * Over the vertices a triangle actually USES, so geometry left in a buffer but
 * never drawn cannot move a floor or inflate a collider.
 */
const FLOOR_PERCENTILE = 0.003;
const usedOf = (prims) => {
  const out = [];
  for (const p of prims) {
    const seen = new Set(p.idx);
    for (const v of seen) out.push([p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]]);
  }
  return out;
};
const groundOf = (prims, how) => {
  const ys = usedOf(prims).map((v) => v[1]).sort((a, b) => a - b);
  if (how === 'min') return ys[0];
  return ys[Math.min(ys.length - 1, Math.floor(ys.length * FLOOR_PERCENTILE))];
};

const boundsOf = (prims) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of usedOf(prims)) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], v[k]);
    max[k] = Math.max(max[k], v[k]);
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};

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

/**
 * A handful of named objects out of a source far too big to read whole.
 *
 * The city map is 12,103 meshes and 2.96 million triangles, and baking every
 * vertex of it into JavaScript arrays to find twelve buildings would be several
 * hundred megabytes of work thrown away. So this walks the node table, takes
 * only the subtrees asked for, and bakes those.
 *
 * Failing loudly is the point of the two throws. A wrong instance index or a
 * renamed node would otherwise give a part with no geometry, which survives
 * everything downstream and turns up as a building that is simply not there —
 * so the message names the pick AND how many nodes carry that name, which is
 * the one number that tells you whether the name is wrong or the index is.
 */
const readPicks = async (path, picks, unitScale) => {
  const doc = await io.read(path);
  const byName = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(node);
  }
  const out = new Map();
  for (const spec of picks) {
    const all = byName.get(spec.pick) ?? [];
    const node = all[spec.instance ?? 0];
    if (!node) {
      throw new Error(`${path}: no node named "${spec.pick}" `
        + `#${spec.instance ?? 0} (${all.length} carry that name)`);
    }
    const prims = [];
    let dropped = 0;
    const walk = (nd) => {
      const mesh = nd.getMesh();
      if (mesh) {
        const world = nd.getWorldMatrix();
        for (const prim of mesh.listPrimitives()) {
          const material = prim.getMaterial();
          // The pavement a building was modelled standing beside. See
          // `DROP_MATERIALS`.
          if (DROP_MATERIALS.has(material?.getName())) {
            dropped += (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION').getCount()) / 3;
            continue;
          }
          const pos = prim.getAttribute('POSITION');
          const nrm = prim.getAttribute('NORMAL');
          const uv = prim.getAttribute('TEXCOORD_0');
          const idx = prim.getIndices();
          const count = pos.getCount();
          const p = new Float32Array(count * 3);
          const n = new Float32Array(nrm ? count * 3 : 0);
          const t = new Float32Array(uv ? count * 2 : 0);
          const v = [0, 0, 0];
          for (let i = 0; i < count; i++) {
            pos.getElement(i, v);
            const w = mul(world, v);
            p.set([w[0] * unitScale, w[1] * unitScale, w[2] * unitScale], i * 3);
            if (nrm) {
              nrm.getElement(i, v);
              const d = mulDir(world, v);
              const len = Math.hypot(...d) || 1;
              n.set([d[0] / len, d[1] / len, d[2] / len], i * 3);
            }
            if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
          }
          prims.push({
            owner: spec.pick,
            self: nd.getName(),
            pos: p,
            nrm: n,
            uv: t,
            idx: idx
              ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
              : Uint32Array.from({ length: count }, (_, i) => i),
            material,
          });
        }
      }
      for (const child of nd.listChildren()) walk(child);
    };
    walk(node);
    if (!prims.length) {
      throw new Error(`${path}: "${spec.pick}" #${spec.instance ?? 0} has no geometry `
        + `(${all.length} nodes carry that name)`);
    }
    if (dropped) console.log(`  ${spec.name}: dropped ${dropped} tris of pavement`);
    out.set(spec.name, prims);
  }
  return out;
};

const picked = await readPicks(CITY, PARTS, CITY_UNITS);
console.log(`read ${CITY}: ${PARTS.length} picked objects, `
  + `${[...picked.values()].reduce((n, v) => n + v.length, 0)} primitives`);

/* ------------------------------------------ frame each part in its own right */

const built = [];
for (const spec of PARTS) {
  const prims = spec.near ? isolate(picked.get(spec.name), spec.near, spec.dropBelow) : picked.get(spec.name);
  const whole = boundsOf(prims);
  const longest = Math.max(whole.size[0], whole.size[2]);
  /*
   * A building with no width is not a building.
   *
   * It is the signature of a pick that resolved to the wrong kind of node —
   * an empty, a light, a locator — and it has to stop the run here rather than
   * downstream, because dividing by it produces an Infinity scale and every
   * vertex of the part becomes NaN. NaN positions survive Draco, survive the
   * write, and turn up as a mesh that vanishes the renderer.
   */
  if (!(longest > 0.01)) {
    throw new Error(`${spec.name}: "${spec.pick}" #${spec.instance} has no horizontal extent `
      + `(measured ${whole.size.map((v) => v.toFixed(3)).join(' x ')} m)`);
  }
  const scale = spec.metres / longest;
  const floor = groundOf(prims, spec.floor);
  // Centred on its own footprint and stood on y = 0 — the park's parts to the
  // letter, because `AirportIsland` places all of them the same way: an (x, z)
  // on the ground and a turn about Y.
  for (const prim of prims) {
    for (let i = 0; i < prim.pos.length; i += 3) {
      prim.pos[i] = (prim.pos[i] - whole.centre[0]) * scale;
      prim.pos[i + 1] = (prim.pos[i + 1] - floor) * scale;
      prim.pos[i + 2] = (prim.pos[i + 2] - whole.centre[2]) * scale;
    }
  }

  const framed = boundsOf(prims);
  // Height above the floor rather than the box's own, so a vertex that ended up
  // below ground does not hand the game a collider too tall and too low.
  framed.size[1] = framed.max[1];
  const tris = prims.reduce((n, p) => n + p.idx.length / 3, 0);
  console.log(`  ${spec.name.padEnd(10)} ${framed.size.map((v) => v.toFixed(1)).join(' x ').padEnd(22)}`
    + ` m  scale ${scale.toFixed(3)}  ${String(Math.round(tris)).padStart(6)} tris`);
  built.push({ name: spec.name, prims, size: framed.size, tris });
}

/* ------------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('parade');

const textures = new Map();
/**
 * One WebP per source texture, at 1024.
 *
 * The map's atlases are 2048 and there are three of them in play here —
 * `Building`, `Blocks` and `Buildings_texture_1024` — which is the whole of
 * this file's weight, since the geometry is under nine thousand triangles. At
 * 1024 a shopfront still has its windows and its signage, and the export stays
 * a download rather than a wait.
 */
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(src)) return textures.get(src);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(src, tex);
  return tex;
};

const materials = new Map();
const convertMaterial = async (src) => {
  if (materials.has(src)) return materials.get(src);
  const m = out.createMaterial(src?.getName() || 'parade')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(src?.getMetallicFactor() ?? 0.1)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.85)
    .setDoubleSided(true)
    // Opaque, for the reason `prepare-airport.mjs` gives at length: a
    // transparent surface has to be sorted against whatever is behind it, and
    // behind a shopfront is the rest of the parade. Nothing here is foliage,
    // which is the one case that genuinely needs its cutout.
    .setAlphaMode('OPAQUE');
  /*
   * Colour lives in the spec-gloss extension's diffuse texture when a material
   * has one, and every one of the map's building atlases does.
   *
   * See the airport's bus, which came out pure white for a week: reading only
   * `getBaseColorTexture()` on a `KHR_materials_pbrSpecularGlossiness` material
   * finds nothing at all, and a nothing renders as the base colour factor.
   */
  const spec = src?.getExtension('KHR_materials_pbrSpecularGlossiness');
  const diffuse = spec?.getDiffuseTexture?.() ?? null;
  const tex = await convertTexture(diffuse ?? src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  const factor = spec?.getDiffuseFactor?.();
  if (!tex && factor) m.setBaseColorFactor(factor);
  materials.set(src, m);
  return m;
};

let triangles = 0;
for (const part of built) {
  const mesh = out.createMesh(part.name);
  for (const p of part.prims) {
    const prim = out.createPrimitive();
    prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(p.pos).setBuffer(buffer));
    if (p.nrm.length) prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(p.nrm).setBuffer(buffer));
    if (p.uv.length) prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(p.uv).setBuffer(buffer));
    prim.setIndices(out.createAccessor().setType('SCALAR').setArray(p.idx).setBuffer(buffer));
    prim.setMaterial(await convertMaterial(p.material));
    mesh.addPrimitive(prim);
    triangles += p.idx.length / 3;
  }
  scene.addChild(out.createNode(part.name).setMesh(mesh));
}

out.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
  method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
});
await io.write(DST, out);
writeFileSync(DATA, `${JSON.stringify({
  triangles,
  parts: Object.fromEntries(built.map((p) => [p.name, {
    size: p.size.map((v) => +v.toFixed(2)),
    triangles: Math.round(p.tris),
  }])),
}, null, 2)}\n`);
console.log(`wrote ${DST} and ${DATA}: ${Math.round(triangles)} triangles in ${built.length} parts, `
  + `${textures.size} textures, ${(statSync(DST).size / 1024 / 1024).toFixed(2)} MB`);
