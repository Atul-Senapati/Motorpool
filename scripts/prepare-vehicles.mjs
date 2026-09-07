/**
 * One-time preprocessor for the two Sketchfab vehicle packs, which become the
 * city's NPC traffic.
 *
 *   generic_passenger_car_pack.glb        25 MB, 10 civilian cars
 *   generic_civil_service_vehicles_pack.glb  53 MB, 10 service vehicles
 *
 * Neither is usable as-is:
 *
 *   - 70 MB of the 78 MB is PNG texture. NPC cars are seen from several metres
 *     away at speed and never need 2048 px.
 *   - Authored in millimetres, so every vehicle is 1000x too large.
 *   - Each vehicle sits at its own spot in a showroom layout and at its own
 *     arbitrary yaw, so their local frames disagree with each other and with the
 *     game's "forward is -Z" convention.
 *   - The two packs are structured differently: passenger cars keep their wheels
 *     as separate `Wheel_A..H` nodes (four instances each, not parented to any
 *     body), while service vehicles have the wheels baked into the body mesh.
 *
 * Emits `public/models/vehicles.glb`: one node per vehicle, each normalised to
 * metres, centred on its own footprint, sitting on y=0 and facing -Z. Wheel
 * geometry, where the pack keeps it separate, is emitted once per vehicle as a
 * `<name>__wheel` mesh centred on its own axle, with the four hub offsets in
 * `extras` so the runtime can instance and spin them.
 *
 * Run with: npm run prepare:vehicles
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const PACKS = [
  { file: 'generic_passenger_car_pack.glb', kind: 'passenger' },
  { file: 'generic_civil_service_vehicles_pack.glb', kind: 'service' },
];
const DST = 'public/models/vehicles.glb';
const DATA = 'src/config/vehicleCatalogue.json';

/** Source units are millimetres. */
const UNIT_SCALE = 0.001;

/** Texture cap. Traffic is never inspected closely enough to want more. */
const TEXTURE_SIZE = 512;

/**
 * Overrides for the automatic orientation pass, by pack kind or vehicle name.
 *
 * Orientation is PCA for the axis plus the node's authored direction for the
 * sign, so every vehicle *within* a pack now agrees. What that cannot know is
 * whether the pack's own convention matches ours, which is one bit per pack —
 * so if a whole pack drives backwards, add its kind ('passenger' / 'service')
 * here rather than listing vehicles one by one.
 */
const FLIP = new Set([]);

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() });

// ---------------------------------------------------------------------------
// Matrix helpers — same conventions as prepare-map.mjs.
// ---------------------------------------------------------------------------
const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function mul(a, b) {
  const o = new Float64Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  return o;
}

function nodeMatrix(node) {
  const [x, y, z, w] = node.getRotation();
  const t = node.getTranslation();
  const s = node.getScale();
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** Inverse-transpose of the upper 3x3, for normals. */
function normalMatrix(m) {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] =
    [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const c00 = a11 * a22 - a12 * a21, c01 = a12 * a20 - a10 * a22, c02 = a10 * a21 - a11 * a20;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(det) < 1e-20) return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], det: 1 };
  const d = 1 / det;
  return {
    m: [
      c00 * d, c01 * d, c02 * d,
      (a02 * a21 - a01 * a22) * d, (a00 * a22 - a02 * a20) * d, (a01 * a20 - a00 * a21) * d,
      (a01 * a12 - a02 * a11) * d, (a02 * a10 - a00 * a12) * d, (a00 * a11 - a01 * a10) * d,
    ],
    det,
  };
}

// ---------------------------------------------------------------------------
// Pass 1: pull every primitive out of both packs into world space (metres).
// ---------------------------------------------------------------------------

/** { name, nodeId, kind, isWheel, material, pos: Float32Array, nrm, uv, idx } */
const parts = [];
let nextNodeId = 0;

for (const pack of PACKS) {
  step(`reading ${pack.file} (${mb(readFileSync(pack.file).byteLength)})`);
  const doc = await io.read(pack.file);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // Descend through the Sketchfab wrappers to the list of vehicles.
  let level = scene.listChildren();
  while (level.length === 1 && level[0].listChildren().length) level = level[0].listChildren();

  for (const entry of level) {
    const name = entry.getName();
    const isWheel = /^wheel/i.test(name);
    // Identity, not name: this pack has two distinct nodes both called
    // "Wheel_G001", and keying by name silently merges them into one.
    const nodeId = `${pack.kind}|${name}|${nextNodeId++}`;

    (function walk(node, parent) {
      const m = mul(parent, nodeMatrix(node));
      const mesh = node.getMesh();
      if (mesh) {
        const nm = normalMatrix(m);
        const flip = nm.det < 0;
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue;
          const posAcc = prim.getAttribute('POSITION');
          if (!posAcc) continue;
          const src = posAcc.getArray();
          const count = posAcc.getCount();

          const pos = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
            pos[i * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * UNIT_SCALE;
            pos[i * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * UNIT_SCALE;
            pos[i * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * UNIT_SCALE;
          }

          const nsrc = prim.getAttribute('NORMAL')?.getArray();
          const nrm = new Float32Array(count * 3);
          if (nsrc) {
            const n = nm.m;
            for (let i = 0; i < count; i++) {
              const x = nsrc[i * 3], y = nsrc[i * 3 + 1], z = nsrc[i * 3 + 2];
              const a = n[0] * x + n[3] * y + n[6] * z;
              const b = n[1] * x + n[4] * y + n[7] * z;
              const c = n[2] * x + n[5] * y + n[8] * z;
              const len = Math.hypot(a, b, c) || 1;
              nrm[i * 3] = a / len; nrm[i * 3 + 1] = b / len; nrm[i * 3 + 2] = c / len;
            }
          } else {
            for (let i = 0; i < count; i++) nrm[i * 3 + 1] = 1;
          }

          const uvSrc = prim.getAttribute('TEXCOORD_0')?.getArray();
          const uv = new Float32Array(count * 2);
          if (uvSrc) uv.set(uvSrc.subarray(0, count * 2));

          const idxAcc = prim.getIndices();
          const raw = idxAcc ? idxAcc.getArray() : null;
          const triCount = raw ? raw.length / 3 : count / 3;
          const idx = new Uint32Array(triCount * 3);
          for (let t = 0; t < triCount; t++) {
            const a = raw ? raw[t * 3] : t * 3;
            const b = raw ? raw[t * 3 + 1] : t * 3 + 1;
            const c = raw ? raw[t * 3 + 2] : t * 3 + 2;
            if (flip) { idx[t * 3] = a; idx[t * 3 + 1] = c; idx[t * 3 + 2] = b; }
            else { idx[t * 3] = a; idx[t * 3 + 1] = b; idx[t * 3 + 2] = c; }
          }

          // The node's own local -Z, in world space. PCA finds the long axis
          // but not which end is the nose; this does, and because a pack is
          // authored consistently it makes every vehicle in a pack agree.
          const authored = [-(m[8]), -(m[10])];
          const alen = Math.hypot(authored[0], authored[1]) || 1;

          parts.push({
            name, nodeId, kind: pack.kind, isWheel, doc,
            authored: [authored[0] / alen, authored[1] / alen],
            material: prim.getMaterial(), pos, nrm, uv, idx,
          });
        }
      }
      for (const child of node.listChildren()) walk(child, m);
    })(entry, IDENTITY);
  }
}
step(`extracted ${parts.length} primitives from ${PACKS.length} packs`);

/** World-space bounds of a set of parts. */
function bounds(list) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of list)
    for (let i = 0; i < p.pos.length; i += 3)
      for (let c = 0; c < 3; c++) {
        const v = p.pos[i + c];
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
  return { lo, hi, centre: [0, 1, 2].map((c) => (lo[c] + hi[c]) / 2) };
}

// ---------------------------------------------------------------------------
// Pass 2: group parts into vehicles, and attach loose wheels to the nearest body.
// ---------------------------------------------------------------------------
/** Showroom props that are not vehicles. */
const JUNK = /^Cylinder/i;

const byNode = new Map();
for (const p of parts) {
  if (JUNK.test(p.name)) continue;
  if (!byNode.has(p.nodeId)) byNode.set(p.nodeId, []);
  byNode.get(p.nodeId).push(p);
}

const bodies = [];
const wheelNodes = [];
for (const list of byNode.values()) {
  const entry = { name: list[0].name, kind: list[0].kind, parts: list, box: bounds(list) };
  (list[0].isWheel ? wheelNodes : bodies).push(entry);
}

// Wheels are siblings of the bodies, never children, so ownership has to be
// worked out. Two things make the naive "nearest body" answer wrong:
//
//   - Wheel nodes come in fours sharing a base name (Wheel_A, Wheel_A001..003).
//     Assigning them individually splits a set across neighbouring cars, which
//     is how one car ended up with 8 wheels and another with 2.
//   - Both packs are loaded into one list, and their showroom layouts overlap in
//     world space, so a passenger car's wheel can land nearest a fire truck.
//
// So: group by base name, and match each *set* to the nearest body within its
// own pack.
// Assignment is purely spatial, and capped at four per body.
//
// Names cannot be trusted here: the pack reuses one base name across two
// different cars (eight nodes stripping to "Wheel_A", in two sets of four with
// slightly different radii), so grouping by name hands one car eight wheels and
// a 12 m bounding box. Position is unambiguous — a wheel sits at the corner of
// exactly one car — so pairs are taken in order of increasing distance, each
// claiming a wheel that is still free on a body that still has a corner spare.
const MAX_WHEELS = 4;
const candidates = [];
for (const w of wheelNodes) {
  for (const body of bodies) {
    if (body.kind !== w.kind) continue;
    const d = Math.hypot(w.box.centre[0] - body.box.centre[0], w.box.centre[2] - body.box.centre[2]);
    // A wheel can never be further from its own car than the car's own extent.
    const reach = Math.hypot(
      body.box.hi[0] - body.box.lo[0], body.box.hi[2] - body.box.lo[2],
    ) / 2 + 1.5;
    if (d > reach) continue;
    candidates.push({ w, body, d });
  }
}
candidates.sort((a, b) => a.d - b.d);
const usedWheels = new Set();
for (const c of candidates) {
  if (usedWheels.has(c.w)) continue;
  const list = (c.body.wheels ??= []);
  if (list.length >= MAX_WHEELS) continue;
  usedWheels.add(c.w);
  list.push(c.w);
}
step(`grouped into ${bodies.length} vehicles; ${usedWheels.size}/${wheelNodes.length} wheel nodes matched`);

// ---------------------------------------------------------------------------
// Pass 3: normalise each vehicle — metres, centred, on the ground, facing -Z.
// ---------------------------------------------------------------------------

/**
 * Yaw that puts the vehicle's long axis along Z.
 *
 * The long axis is the dominant eigenvector of the XZ covariance of the body
 * vertices. A car is markedly longer than it is wide, so this is stable; it is
 * also undirected, which is what FLIP above exists to correct.
 */
function longAxisYaw(list, centre) {
  let sxx = 0, sxz = 0, szz = 0, n = 0;
  for (const p of list)
    for (let i = 0; i < p.pos.length; i += 3) {
      const x = p.pos[i] - centre[0];
      const z = p.pos[i + 2] - centre[2];
      sxx += x * x; sxz += x * z; szz += z * z; n++;
    }
  if (!n) return 0;
  sxx /= n; sxz /= n; szz /= n;
  // Larger eigenvalue of [[sxx,sxz],[sxz,szz]].
  const tr = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const lambda = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  // Eigenvector for lambda.
  let ax = sxz, az = lambda - sxx;
  if (Math.hypot(ax, az) < 1e-9) { ax = 1; az = 0; }
  const len = Math.hypot(ax, az);
  ax /= len; az /= len;
  // Rotation about Y taking (ax, az) to (0, 1): theta = atan2(-ax, az).
  return Math.atan2(-ax, az);
}

/** Decoded base-colour textures, cached by texture object. */
const pixelCache = new Map();
async function texturePixels(material) {
  const tex = material?.getBaseColorTexture();
  if (!tex) return null;
  if (pixelCache.has(tex)) return pixelCache.get(tex);
  const img = tex.getImage();
  if (!img) { pixelCache.set(tex, null); return null; }
  const { data, info } = await sharp(Buffer.from(img)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const entry = { data, width: info.width, height: info.height };
  pixelCache.set(tex, entry);
  return entry;
}

/**
 * Classify a lamp texel as a tail lamp or a head lamp.
 *
 * Red is saturated and red-dominant; a head lamp lens is clear or white, i.e.
 * bright and nearly unsaturated. Amber indicators and dark trim fall through as
 * neither, which is what we want — they appear at both ends of a car.
 */
function lampKind(px, u, v) {
  if (!px) return null;
  const wrap = (t) => t - Math.floor(t);
  const x = Math.min(px.width - 1, Math.max(0, Math.floor(wrap(u) * px.width)));
  const y = Math.min(px.height - 1, Math.max(0, Math.floor(wrap(v) * px.height)));
  const i = (y * px.width + x) * 4;
  if (px.data[i + 3] < 8) return null;
  const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx ? (mx - mn) / mx : 0;
  if (r > 60 && r >= mx && sat > 0.45 && g < r * 0.65 && b < r * 0.65) return 'red';
  if (sat < 0.28 && mx > 90) return 'clear';
  return null;
}

const catalogue = [];
/** Side-on profiles, for eyeballing orientation. See ORIENT_SHEET below. */
const silhouettes = [];



const { Document } = await import('@gltf-transform/core');
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('vehicles');

/** Source material -> material in the output document. */
const materialMap = new Map();
function cloneMaterial(src) {
  if (materialMap.has(src)) return materialMap.get(src);
  const m = doc.createMaterial(src.getName())
    .setBaseColorFactor(src.getBaseColorFactor())
    .setMetallicFactor(src.getMetallicFactor())
    .setRoughnessFactor(src.getRoughnessFactor())
    .setAlphaMode(src.getAlphaMode())
    .setDoubleSided(src.getDoubleSided());

  const srcTex = src.getBaseColorTexture();
  if (srcTex) {
    const tex = doc.createTexture(srcTex.getName())
      .setImage(srcTex.getImage())
      .setMimeType(srcTex.getMimeType());
    m.setBaseColorTexture(tex);
    const info = src.getBaseColorTextureInfo();
    if (info) {
      m.getBaseColorTextureInfo()
        .setWrapS(info.getWrapS()).setWrapT(info.getWrapT());
    }
  }
  materialMap.set(src, m);
  return m;
}

for (const vehicle of bodies) {
  // three's GLTFLoader runs every node name through PropertyBinding
  // .sanitizeNodeName, which strips ".:/[]" and turns whitespace into "_".
  // Emitting an already-safe id means the runtime can look nodes up by the name
  // in the catalogue instead of guessing at what survived the load.
  const id = vehicle.name.replace(/[^\w]/g, '_');
  const bodyParts = vehicle.parts;
  const wheelParts = (vehicle.wheels ?? []).flatMap((w) => w.parts);
  const all = [...bodyParts, ...wheelParts];

  const whole = bounds(all);
  let yaw = longAxisYaw(bodyParts, whole.centre);

  // longAxisYaw returns an *undirected* axis: it puts the length along Z but
  // cannot tell a bonnet from a boot, and getting that wrong makes a car drive
  // backwards. It is resolved from the lamps, because road vehicles are required
  // by law to be lit red at the back and white at the front:
  //
  //   the clear end is the front.
  //
  // Both colours are needed. Redness alone separated the ends by only about 10%
  // on a saloon — indistinguishable from noise, and it got the Coupe and the
  // Sport wrong — because there is red trim and there are red side markers all
  // over these models. Comparing each end's *ratio* of clear lens to red lens
  // separates them by 2x to 20x, since a head lamp is a big clear lens with no
  // red near it and a tail cluster is the reverse.
  //
  // Only the outer thirds count, so roof beacons and side repeaters are ignored,
  // and every sample is weighted by triangle area: summing per triangle lets a
  // finely tessellated scrap of trim outvote a whole lamp lens.
  //
  // A vehicle with no clear lens anywhere falls back to the glass: a windscreen
  // is raked forward and a rear window rakes back, so the area-weighted glass
  // normal points at the nose. That is decisive only on cab-forward vans and
  // trucks, where the windscreen dominates; on a car the two ends nearly annul.
  //
  // Rejected as too weak to use: glass centroid (dominated by side windows) and
  // front/rear overhang (differs by ~3 cm).
  {
    const rot = (x, z) => -x * Math.sin(yaw) + z * Math.cos(yaw);
    let zMin = Infinity, zMax = -Infinity;
    for (const p of bodyParts) {
      for (let i = 0; i < p.pos.length; i += 3) {
        const z = rot(p.pos[i] - whole.centre[0], p.pos[i + 2] - whole.centre[2]);
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
    }
    const endZone = (zMax - zMin) / 6;
    const lamp = { front: { red: 0, clear: 0 }, rear: { red: 0, clear: 0 } };
    let glassNz = 0, glassArea = 0;

    for (const p of bodyParts) {
      const matName2 = p.material?.getName() ?? '';
      const isOptics = /optic|light|lamp/i.test(matName2);
      const isGlass = /glass/i.test(matName2);
      if (!isOptics && !isGlass) continue;
      const px = isOptics ? await texturePixels(p.material) : null;

      for (let t = 0; t < p.idx.length; t += 3) {
        const ia = p.idx[t], ib = p.idx[t + 1], ic = p.idx[t + 2];
        const ax = ia * 3, bx = ib * 3, cxi = ic * 3;
        const cx = (p.pos[ax] + p.pos[bx] + p.pos[cxi]) / 3 - whole.centre[0];
        const cz = (p.pos[ax + 2] + p.pos[bx + 2] + p.pos[cxi + 2]) / 3 - whole.centre[2];
        const z = rot(cx, cz);

        const ux = p.pos[bx] - p.pos[ax], uy = p.pos[bx + 1] - p.pos[ax + 1], uz = p.pos[bx + 2] - p.pos[ax + 2];
        const vx = p.pos[cxi] - p.pos[ax], vy = p.pos[cxi + 1] - p.pos[ax + 1], vz = p.pos[cxi + 2] - p.pos[ax + 2];
        const nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
        const area = Math.hypot(nx2, ny2, nz2) / 2;
        if (!(area > 0)) continue;

        if (isOptics) {
          if (Math.abs(z) < endZone) continue;
          const u = (p.uv[ia * 2] + p.uv[ib * 2] + p.uv[ic * 2]) / 3;
          const v = (p.uv[ia * 2 + 1] + p.uv[ib * 2 + 1] + p.uv[ic * 2 + 1]) / 3;
          const kind = lampKind(px, u, v);
          if (!kind) continue;
          const end = z < 0 ? lamp.front : lamp.rear;
          end[kind] += area;
        } else {
          const mnx = (p.nrm[ax] + p.nrm[bx] + p.nrm[cxi]) / 3;
          const mnz = (p.nrm[ax + 2] + p.nrm[bx + 2] + p.nrm[cxi + 2]) / 3;
          glassNz += rot(mnx, mnz) * area;
          glassArea += area;
        }
      }
    }

    const glass = glassArea ? glassNz / glassArea : 0;
    const clarity = (o) => (o.clear + 1e-6) / (o.red + 1e-6);
    const cf = clarity(lamp.front), cr = clarity(lamp.rear);

    let flip, why;
    if (cf > cr * 1.3) { flip = false; why = 'lamps'; }
    else if (cr > cf * 1.3) { flip = true; why = 'lamps'; }
    else { flip = glass > 0; why = 'glass(no clear lens)'; }
    if (flip) yaw += Math.PI;

    console.log(`   ORIENT ${vehicle.name.padEnd(18)}` +
      ` clear/red front ${cf.toFixed(2).padStart(7)}  rear ${cr.toFixed(2).padStart(7)}` +
      `  glassN ${glass.toFixed(3).padStart(7)}` +
      `  -> ${(flip ? 'FLIP' : 'keep').padEnd(4)} (${why})`);
  }

  if (FLIP.has(vehicle.kind) || FLIP.has(vehicle.name)) yaw += Math.PI;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);

  // Rotate about Y, then re-origin: XZ on the footprint centre, Y on the ground.
  const place = (x, y, z) => [
    (x - whole.centre[0]) * cos + (z - whole.centre[2]) * sin,
    y,
    -(x - whole.centre[0]) * sin + (z - whole.centre[2]) * cos,
  ];

  // First pass to find the rotated bounds, so the re-origin is exact.
  const rl = [Infinity, Infinity, Infinity], rh = [-Infinity, -Infinity, -Infinity];
  for (const p of all)
    for (let i = 0; i < p.pos.length; i += 3) {
      const q = place(p.pos[i], p.pos[i + 1], p.pos[i + 2]);
      for (let c = 0; c < 3; c++) {
        if (q[c] < rl[c]) rl[c] = q[c];
        if (q[c] > rh[c]) rh[c] = q[c];
      }
    }
  const shift = [-(rl[0] + rh[0]) / 2, -rl[1], -(rl[2] + rh[2]) / 2];

  const bake = (list) => list.map((p) => {
    const pos = new Float32Array(p.pos.length);
    for (let i = 0; i < p.pos.length; i += 3) {
      const q = place(p.pos[i], p.pos[i + 1], p.pos[i + 2]);
      pos[i] = q[0] + shift[0];
      pos[i + 1] = q[1] + shift[1];
      pos[i + 2] = q[2] + shift[2];
    }
    const nrm = new Float32Array(p.nrm.length);
    for (let i = 0; i < p.nrm.length; i += 3) {
      nrm[i] = p.nrm[i] * cos + p.nrm[i + 2] * sin;
      nrm[i + 1] = p.nrm[i + 1];
      nrm[i + 2] = -p.nrm[i] * sin + p.nrm[i + 2] * cos;
    }
    return { ...p, pos, nrm };
  });

  const bakedBody = bake(bodyParts);
  const size = [rh[0] - rl[0], rh[1] - rl[1], rh[2] - rl[2]];

  // Side-on profile, for judging orientation by eye. The scalar tests above are
  // each ambiguous on some vehicle, and a human reads a bonnet or a windscreen
  // rake instantly, so the honest thing is to make that easy to check.
  if (process.env.ORIENT_SHEET) {
    const CELL = 0.07;
    const cells = new Map(); // "gz,gy" -> 0 body | 1 glass | 2 pale lamp | 3 red lamp
    for (const part of bakedBody) {
      const matName3 = part.material?.getName() ?? '';
      const optics = /optic|light|lamp/i.test(matName3);
      const glass = /glass/i.test(matName3);
      const px2 = optics ? await texturePixels(part.material) : null;
      for (let t = 0; t < part.idx.length; t += 3) {
        const v = [part.idx[t], part.idx[t + 1], part.idx[t + 2]];
        let rank = glass ? 1 : 0;
        if (optics) {
          const u = v.reduce((a, i) => a + part.uv[i * 2], 0) / 3;
          const w = v.reduce((a, i) => a + part.uv[i * 2 + 1], 0) / 3;
          rank = lampKind(px2, u, w) === 'red' ? 3 : 2;
        }
        // Vertices, edge midpoints and centroid: enough samples to fill the
        // profile at this cell size without rasterising every triangle.
        const pts = [];
        for (const i of v) pts.push([part.pos[i * 3 + 2], part.pos[i * 3 + 1]]);
        for (let e = 0; e < 3; e++) {
          const a = pts[e], b = pts[(e + 1) % 3];
          pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        }
        pts.push([(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3]);
        for (const [z, y] of pts) {
          const key = `${Math.round(z / CELL)},${Math.round(y / CELL)}`;
          if ((cells.get(key) ?? -1) < rank) cells.set(key, rank);
        }
      }
    }
    silhouettes.push({ name: vehicle.name, label: vehicle.label ?? vehicle.name, cell: CELL, cells: [...cells] });
  }

  // Role travels in `extras` -> Object3D.userData, never in the name: a mesh
  // with several primitives is split by GLTFLoader into children renamed
  // `<name>_1`, `<name>_2`... so the base name never appears in the loaded
  // scene and any name lookup silently finds nothing.
  const mesh = doc.createMesh(id).setExtras({ vehicle: id, part: 'body' });
  for (const p of bakedBody) {
    const prim = doc.createPrimitive().setMode(4).setMaterial(cloneMaterial(p.material));
    prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(p.pos).setBuffer(buffer));
    prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(p.nrm).setBuffer(buffer));
    prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(p.uv).setBuffer(buffer));
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(p.idx).setBuffer(buffer));
    mesh.addPrimitive(prim);
  }

  // --- wheels, where the pack kept them separate -------------------------
  const hubs = [];
  let wheelRadius = 0;
  let wheelMeshName = null;
  if (vehicle.wheels?.length) {
    // Every wheel on a vehicle is the same mesh at four places, so one is baked
    // about its own axle and the other three become instance offsets.
    const normalisedWheels = vehicle.wheels.map((w) => {
      const b = bounds(bake(w.parts));
      return { w, box: b };
    });
    for (const { box } of normalisedWheels) {
      hubs.push(box.centre.map((v) => +v.toFixed(4)));
      wheelRadius = Math.max(wheelRadius, (box.hi[1] - box.lo[1]) / 2);
    }

    const template = normalisedWheels[0];
    const baked = bake(template.w.parts);
    const c = template.box.centre;
    wheelMeshName = `${id}__wheel`;
    const wm = doc.createMesh(wheelMeshName).setExtras({ vehicle: id, part: 'wheel' });
    for (const p of baked) {
      const pos = new Float32Array(p.pos.length);
      for (let i = 0; i < p.pos.length; i += 3) {
        pos[i] = p.pos[i] - c[0];
        pos[i + 1] = p.pos[i + 1] - c[1];
        pos[i + 2] = p.pos[i + 2] - c[2];
      }
      const prim = doc.createPrimitive().setMode(4).setMaterial(cloneMaterial(p.material));
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer));
      prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(p.nrm).setBuffer(buffer));
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(p.uv).setBuffer(buffer));
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(p.idx).setBuffer(buffer));
      wm.addPrimitive(prim);
    }
    scene.addChild(doc.createNode(wheelMeshName).setMesh(wm));
  }

  scene.addChild(doc.createNode(id).setMesh(mesh));

  catalogue.push({
    /** Node id in vehicles.glb — already sanitiser-safe. */
    name: id,
    /** Human-readable original. */
    label: vehicle.name,
    kind: vehicle.kind,
    /** Width (X), height (Y), length (Z), metres. */
    size: size.map((v) => +v.toFixed(3)),
    wheelMesh: wheelMeshName,
    wheelRadius: +wheelRadius.toFixed(4),
    hubs,
    triangles: bakedBody.reduce((n, p) => n + p.idx.length / 3, 0),
  });
}
step(`normalised ${catalogue.length} vehicles`);

// ---------------------------------------------------------------------------
// Textures: 70 MB of PNG -> WebP at 512 px.
// ---------------------------------------------------------------------------
let before = 0, after = 0;
for (const tex of doc.getRoot().listTextures()) {
  const img = tex.getImage();
  if (!img) continue;
  before += img.byteLength;
  const webp = await sharp(Buffer.from(img))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 5 })
    .toBuffer();
  tex.setImage(new Uint8Array(webp)).setMimeType('image/webp');
  after += webp.byteLength;
}
step(`textures ${mb(before)} -> ${mb(after)}`);

doc.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    encodeSpeed: 5, decodeSpeed: 5,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });

await io.write(DST, doc);

writeFileSync(DATA, JSON.stringify({ vehicles: catalogue }, null, 2) + '\n');

const srcSize = PACKS.reduce((n, p) => n + readFileSync(p.file).byteLength, 0);
console.log('\n--- vehicles ---');
for (const v of catalogue)
  console.log(`  ${(v.hubs.length && v.hubs.length !== 4 ? '! ' : '  ') + v.name.padEnd(20)} ${v.kind.padEnd(10)} ` +
    `${v.size[2].toFixed(2)}m long  ${v.size[0].toFixed(2)}m wide  ${v.size[1].toFixed(2)}m tall  ` +
    `${String(v.triangles).padStart(6)} tris  ${v.hubs.length ? `${v.hubs.length} wheels r=${v.wheelRadius}` : 'wheels baked in'}`);
console.log(`\n  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);

if (process.env.ORIENT_SHEET) {
  // Nose is drawn to the LEFT: every vehicle is normalised to face -Z, so a
  // correctly oriented one shows its bonnet or cab on the left and its red
  // lamps on the right. Red at the left means that vehicle is round the wrong
  // way. This exists because every scalar test tried is ambiguous on some
  // vehicle, while a person reads a windscreen rake at a glance.
  const COLS = 4, PAD = 16, SCALE = 26, LABEL = 15;
  const span = (v, ix) => {
    const a = v.cells.map(([k]) => +k.split(',')[ix]);
    return (Math.max(...a) - Math.min(...a)) * v.cell;
  };
  const cw = Math.max(...silhouettes.map((v) => span(v, 0))) * SCALE + PAD * 2;
  const ch = Math.max(...silhouettes.map((v) => span(v, 1))) * SCALE + PAD * 2 + LABEL + 10;
  const rows = Math.ceil(silhouettes.length / COLS);
  const FILL = ['#5b6472', '#79b6e8', '#f2e6a8', '#e0463c'];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * cw}" height="${rows * ch}">`;
  svg += `<rect width="100%" height="100%" fill="#f6f5f2"/>`;
  silhouettes.forEach((v, n) => {
    const ox = (n % COLS) * cw, oy = Math.floor(n / COLS) * ch;
    const zs = v.cells.map(([k]) => +k.split(',')[0]);
    const ys = v.cells.map(([k]) => +k.split(',')[1]);
    const z0 = Math.min(...zs), y1 = Math.max(...ys);
    svg += `<text x="${ox + PAD}" y="${oy + 12}" font-family="system-ui,sans-serif" font-size="11" fill="#222">${n}. ${v.label}</text>`;
    const px = v.cell * SCALE + 0.5;
    for (const [k, rank] of v.cells) {
      const [gz, gy] = k.split(',').map(Number);
      const x = ox + PAD + (gz - z0) * v.cell * SCALE;
      const y = oy + LABEL + PAD + (y1 - gy) * v.cell * SCALE;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${px.toFixed(1)}" height="${px.toFixed(1)}" fill="${FILL[rank]}"/>`;
    }
    const ay = oy + ch - 6;
    svg += `<path d="M${ox + PAD + 34} ${ay} L${ox + PAD + 2} ${ay}" stroke="#2a7f3e" stroke-width="1.5"/>`;
    svg += `<path d="M${ox + PAD} ${ay} l7 -3.5 v7 z" fill="#2a7f3e"/>`;
  });
  svg += '</svg>';
  writeFileSync(process.env.ORIENT_SHEET, svg);
  console.log(`  SHEET  ${process.env.ORIENT_SHEET}`);
}

