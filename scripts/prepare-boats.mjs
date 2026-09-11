/**
 * Turns the dropped marine models into one fleet the game can use.
 *
 *     npm run prepare:boats
 *
 * Six files arrived from three different sources, in three
 * different conventions: four small craft modelled in metres with their long
 * axis on Z, and two ships modelled two units long with their long axis on X.
 * A game cannot hold six conventions, so this pass puts every hull into ONE:
 *
 *   metres      scaled to its real length overall, which is stated per boat
 *               below rather than measured — a ferry modelled 2 units long
 *               carries no clue about whether that is 100 m or 200 m, and the
 *               ship it is a model OF has a published length.
 *   centred     on X and Z, so a boat turns about itself rather than swinging
 *               round a corner of its own bounding box.
 *   floating    y = 0 is the WATERLINE, not the keel. Everything that puts a
 *               boat in the world — the traffic, the player's physics, the
 *               wake — works in terms of where the water is, and a model whose
 *               origin is its keel makes every one of them carry a correction.
 *   facing −Z   the game's forward, the same convention `prepare-vehicles.mjs`
 *               normalises cars to.
 *
 * ## Which end is the bow — decided at the waterline
 *
 * The first version compared the mean half-beam over the forward and after
 * fifths of the hull, on the rule that a bow is narrower. It got two of the
 * six backwards, and the reason is instructive: over a fifth of a boat's
 * length that average is dominated by the DECK and the superstructure, not by
 * the hull, and on a motor yacht the deck is at its widest right up to the
 * transom while the flybridge sits forward.
 *
 * So the test looks at the waterline instead, and at the very ends: within a
 * few percent of each end, how wide is the hull within a third of a metre of
 * y = 0? A bow narrows to a **stem** and that figure goes to nothing; a
 * transom is a flat face that carries most of the beam to the last
 * centimetre. On this fleet it reads 2.35 m against 0.00 m for the yacht and
 * 0.96 against 0.00 for the cruiser — no judgement required.
 *
 * It is run AFTER the hull has been scaled and lowered, because that is the
 * only frame in which y = 0 is the waterline; the sources put it at the keel,
 * at the deck, or wherever the modeller left it.
 *
 * The one hull it cannot settle is the tug, which is bluff forward and fine
 * aft — the opposite of every other boat, and exactly the shape a tug has.
 * `BOW` overrides it.
 *
 * ## What comes out
 *
 *   public/models/boats.glb   every hull, tagged with `extras.boat` so the
 *                             loader can find them by name the way the vehicle
 *                             pack is keyed
 *   src/config/boatData.json  the measurements the game reads: size, draught,
 *                             triangles
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const DST = 'public/models/boats.glb';
const DATA = 'src/config/boatData.json';
/** Every texture is squared off to this. The hulls are seen from metres away. */
const TEXTURE_SIZE = 1024;

/**
 * Triangle budget per hull.
 *
 * The six models arrived at 710,000 triangles between them — a fifth of the
 * whole city, for six boats, and 199,000 of them on a 16 m yacht. What they
 * are actually spent on is deck hardware: cleats, rails, winches, davits,
 * each modelled as though the camera would come within a metre of it. The
 * player's boat is seen from ten metres behind and the traffic from hundreds,
 * so each hull is decimated to a budget that keeps its silhouette — which is
 * all a boat on water is — and the fleet lands at a tenth of what it was.
 *
 * The two ships get more than the small craft in absolute terms and far less
 * per metre: a 203 m ferry is mostly flat sides.
 */
const BUDGET = { yacht: 34000, cruiser: 22000, tug: 20000, sail: 18000, ferry: 26000, cargo: 14000 };

/**
 * The fleet, and the two numbers that cannot be measured off a mesh.
 *
 * `loa` is length overall in metres — the real ship's, from its own
 * specification. `draught` is how deep the model's LOWEST POINT sits below the
 * water, which decides where the waterline cuts the hull and therefore how
 * much of the boat you see.
 *
 * It is not quite the same as the boat's published draught, and that is the
 * correction these numbers carry: the lowest point of a model is usually a
 * rudder, a skeg or a propeller rather than the bottom of the hull, so using
 * the real figure sinks the hull by whatever hangs below it. The small craft
 * were all sitting visibly deep and came up by about a quarter.
 */
const FLEET = [
  {
    id: 'yacht', label: 'Motor Yacht', src: 'motor_boat_iii_empty.glb',
    loa: 16.6, draught: 0.85,
  },
  {
    id: 'cruiser', label: 'Cabin Cruiser', src: 'ss_minnow_iii.glb',
    loa: 8.6, draught: 0.44,
  },
  {
    id: 'tug', label: 'Harbour Tug', src: 'tow_boat.glb',
    loa: 11.2, draught: 1.15,
  },
  {
    id: 'sail', label: 'Sailing Yacht', src: 'j-80_sailboat.glb',
    loa: 8.0, draught: 1.5,
  },
  {
    id: 'ferry', label: 'Cruise Ferry', src: 'silja_line_ms_silja_serenade_1990.glb',
    loa: 203, draught: 7.1,
  },
  {
    id: 'cargo', label: 'Cargo Ship', src: 'alassia_mv_cymona_eagle_2024.glb',
    loa: 140, draught: 6.4,
  },
];

/** Where the stem test is overruled, and why. */
const BOW = {
  // A tug is bluff at the bow and fine at the stern, so the end that comes to
  // a point is its STERN and the test reads it exactly backwards.
  tug: 'blunt',
};

/* --------------------------------------------------------------- matrices */

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

const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/** Rotate a direction only — no translation, and good enough for normals here
 *  because every transform this script applies is a rotation and a uniform
 *  scale, which leaves normals unsheared. */
const rotate = (m, x, y, z) => {
  const out = [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
  const len = Math.hypot(...out) || 1;
  return out.map((v) => v / len);
};

/* ------------------------------------------------------- read every source */

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

/** One primitive, in the source's own world space. */
const collect = async (boat) => {
  const doc = await io.read(source(boat.src));
  const parts = [];

  const walk = (node, parent) => {
    const local = nodeMatrix(node);
    const world = parent ? mul(parent, local) : local;
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const nrm = prim.getAttribute('NORMAL');
        const uv = prim.getAttribute('TEXCOORD_0');
        const idx = prim.getIndices();
        if (!pos) continue;
        const count = pos.getCount();
        const p = new Float32Array(count * 3);
        const n = new Float32Array(count * 3);
        const t = new Float32Array(count * 2);
        const v = [0, 0, 0];
        for (let i = 0; i < count; i++) {
          pos.getElement(i, v);
          const w = apply(world, v[0], v[1], v[2]);
          p[i * 3] = w[0];
          p[i * 3 + 1] = w[1];
          p[i * 3 + 2] = w[2];
          if (nrm) {
            nrm.getElement(i, v);
            const r = rotate(world, v[0], v[1], v[2]);
            n[i * 3] = r[0];
            n[i * 3 + 1] = r[1];
            n[i * 3 + 2] = r[2];
          }
          if (uv) {
            uv.getElement(i, v);
            t[i * 2] = v[0];
            t[i * 2 + 1] = v[1];
          }
        }
        const indices = idx
          ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
          : Uint32Array.from({ length: count }, (_, i) => i);
        parts.push({ pos: p, nrm: n, uv: t, idx: indices, material: prim.getMaterial() });
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };

  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walk(node, null);
  }
  return { doc, parts };
};

/* ------------------------------------------------------------ the new file */

await MeshoptSimplifier.ready;

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('boats');
const fleet = [];
/** Source texture image -> the new file's texture, so a shared atlas is shared. */
const textures = new Map();

const convertTexture = async (source) => {
  if (!source) return null;
  const image = source.getImage();
  if (!image) return null;
  const key = image;
  if (textures.has(key)) return textures.get(key);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  const texture = out.createTexture(source.getName() || 'tex')
    .setImage(webp)
    .setMimeType('image/webp');
  textures.set(key, texture);
  return texture;
};

for (const boat of FLEET) {
  const { parts } = await collect(boat);
  if (!parts.length) throw new Error(`${boat.src}: no geometry`);

  // --- measure -------------------------------------------------------------
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (let i = 0; i < part.pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], part.pos[i + a]);
        hi[a] = Math.max(hi[a], part.pos[i + a]);
      }
    }
  }
  const span = hi.map((v, i) => v - lo[i]);
  /** Which horizontal axis the hull is long on: 0 = X, 2 = Z. */
  const longAxis = span[0] > span[2] ? 0 : 2;
  const beamAxis = longAxis === 0 ? 2 : 0;
  const centre = [(lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2];

  // --- the transform -------------------------------------------------------
  //
  // Scale to the real length, turn the long axis onto Z with the bow at −Z,
  // centre on the plan and drop the keel `draught` below the waterline.
  const scale = boat.loa / span[longAxis];
  // Turn the long axis onto Z. Which END is forward is settled afterwards, on
  // the placed hull, where the waterline is known — see the header.
  const yaw = longAxis === 2 ? 0 : -Math.PI / 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  let tris = 0;
  const newLo = [Infinity, Infinity, Infinity];
  const newHi = [-Infinity, -Infinity, -Infinity];
  const placed = [];
  for (const part of parts) {
    const p = new Float32Array(part.pos.length);
    const n = new Float32Array(part.nrm.length);
    for (let i = 0; i < part.pos.length; i += 3) {
      const x = (part.pos[i] - centre[0]) * scale;
      const y = (part.pos[i + 1] - lo[1]) * scale;
      const z = (part.pos[i + 2] - centre[2]) * scale;
      p[i] = x * cos + z * sin;
      p[i + 1] = y - boat.draught;
      p[i + 2] = -x * sin + z * cos;
      const nx = part.nrm[i];
      const nz = part.nrm[i + 2];
      n[i] = nx * cos + nz * sin;
      n[i + 1] = part.nrm[i + 1];
      n[i + 2] = -nx * sin + nz * cos;
      for (let a = 0; a < 3; a++) {
        newLo[a] = Math.min(newLo[a], p[i + a]);
        newHi[a] = Math.max(newHi[a], p[i + a]);
      }
    }
    tris += part.idx.length / 3;
    placed.push({ ...part, pos: p, nrm: n });
  }

  // --- which end is the bow, at the waterline ------------------------------
  //
  // See the header. Everything below is in the placed frame, so y = 0 is the
  // waterline and z is the length; the end whose half-breadth there goes to
  // nothing is the stem.
  const band = Math.max(0.35, boat.loa * 0.012);
  const endBand = boat.loa * 0.06;
  const halfBreadth = (from, to) => {
    let widest = 0;
    for (const part of placed) {
      for (let i = 0; i < part.pos.length; i += 3) {
        const z = part.pos[i + 2];
        if (z < from || z > to) continue;
        if (Math.abs(part.pos[i + 1]) > band) continue;
        widest = Math.max(widest, Math.abs(part.pos[i]));
      }
    }
    return widest;
  };
  const sternward = halfBreadth(newLo[2], newLo[2] + endBand);
  const forward = halfBreadth(newHi[2] - endBand, newHi[2]);
  // The finer end is the stem, unless this hull is one that is bluff forward.
  const fineIsBow = BOW[boat.id] !== 'blunt';
  const bowAtLow = fineIsBow ? sternward < forward : sternward > forward;
  if (!bowAtLow) {
    // Turn the hull end for end: a half turn about Y is a sign flip on X and Z.
    for (const part of placed) {
      for (let i = 0; i < part.pos.length; i += 3) {
        part.pos[i] = -part.pos[i];
        part.pos[i + 2] = -part.pos[i + 2];
        part.nrm[i] = -part.nrm[i];
        part.nrm[i + 2] = -part.nrm[i + 2];
      }
    }
    const swap = newLo[2];
    newLo[2] = -newHi[2];
    newHi[2] = -swap;
    const swapX = newLo[0];
    newLo[0] = -newHi[0];
    newHi[0] = -swapX;
  }

  // --- decimate to the budget ---------------------------------------------
  //
  // Per primitive, proportionally: a hull made of forty submeshes has no
  // single mesh to simplify, and taking the same fraction off each keeps the
  // ratio of hull to hardware the modeller chose. `LockBorder` holds the open
  // edges where those submeshes meet, which is what stops a decimated deck
  // pulling away from its own coaming.
  const budget = BUDGET[boat.id] ?? 25000;
  const ratio = Math.min(1, budget / tris);
  let kept = 0;
  if (ratio < 1) {
    for (const part of placed) {
      const target = Math.max(3, Math.floor((part.idx.length / 3) * ratio)) * 3;
      if (target < part.idx.length) {
        const [simplified] = MeshoptSimplifier.simplify(
          part.idx, part.pos, 3, target, 0.05, ['LockBorder'],
        );
        part.idx = simplified instanceof Uint32Array ? simplified : Uint32Array.from(simplified);
      }
      kept += part.idx.length / 3;
    }
  } else {
    kept = tris;
  }

  // --- write it into the fleet file ---------------------------------------
  const mesh = out.createMesh(boat.id);
  mesh.setExtras({ boat: boat.id });
  for (const part of placed) {
    const prim = out.createPrimitive();
    prim.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(part.pos).setBuffer(buffer));
    if (part.nrm.length) {
      prim.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(part.nrm).setBuffer(buffer));
    }
    if (part.uv.length) {
      prim.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(part.uv).setBuffer(buffer));
    }
    prim.setIndices(out.createAccessor().setType('SCALAR').setArray(part.idx).setBuffer(buffer));

    const src = part.material;
    const material = out.createMaterial(src?.getName() || `${boat.id}_mat`)
      .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
      .setMetallicFactor(src?.getMetallicFactor() ?? 0.1)
      .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.8)
      .setDoubleSided(src?.getDoubleSided() ?? false)
      .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE');
    const texture = await convertTexture(src?.getBaseColorTexture());
    if (texture) material.setBaseColorTexture(texture);
    prim.setMaterial(material);
    mesh.addPrimitive(prim);
  }
  scene.addChild(out.createNode(boat.id).setMesh(mesh));

  fleet.push({
    id: boat.id,
    label: boat.label,
    /** Beam (X), height above the waterline (Y), length (Z). */
    size: [
      +(newHi[0] - newLo[0]).toFixed(3),
      +newHi[1].toFixed(3),
      +(newHi[2] - newLo[2]).toFixed(3),
    ],
    draught: boat.draught,
    triangles: Math.round(kept),
  });
  step(`${boat.id.padEnd(8)} ${boat.loa.toFixed(1)} m, `
    + `${Math.round(tris).toLocaleString()} -> ${Math.round(kept).toLocaleString()} tris, `
    + `waterline ends ${sternward.toFixed(2)} / ${forward.toFixed(2)} m `
    + `=> ${bowAtLow ? 'already bow-first' : 'turned end for end'}`
    + `${BOW[boat.id] ? ` (${BOW[boat.id]} bow)` : ''}`);
}

out.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
  });

await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({ boats: fleet }, null, 2) + '\n');
step(`wrote ${DST} and ${DATA}`);
for (const b of fleet) {
  console.log(`  ${b.id.padEnd(8)} ${b.size[2].toFixed(1)} m x ${b.size[0].toFixed(1)} m, `
    + `${b.size[1].toFixed(1)} m above the water, draught ${b.draught} m`);
}
