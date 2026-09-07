/**
 * One-time preprocessor for the Melbourne C-class tram (Alstom Citadis 202).
 *
 * The Sketchfab export is a SketchUp model, and it arrives with three problems
 * that each need a different kind of fix:
 *
 *   - **2.86 million triangles**, against the 60 k the tram it replaces cost.
 *     Five trams run the loop, so the model's cost is paid five times over and
 *     the city itself is only 250 k. Two thirds of that count is furniture:
 *     seats, grab poles and hanging straps, modelled as full round tubes with
 *     more triangles in the handrails than the entire city has in its roads.
 *   - **Everything inside is invisible anyway.** The windows are tinted, so
 *     nothing behind them reads at street distance — you are paying millions
 *     of triangles for geometry the player cannot see.
 *   - **It is one rigid body**, and it is authored per *material*, so each
 *     mesh runs the whole length of the vehicle. It cannot be split into
 *     articulated sections by re-parenting nodes the way the previous tram
 *     was; the geometry itself has to be cut.
 *
 * What this does about them, in order:
 *
 *  1. **Culls anything not visible from outside**, by rendering the model from
 *     26 directions with a z-buffer and keeping only the meshes that actually
 *     win pixels. This is a measurement rather than a guess: glass is treated
 *     as opaque, so everything behind a window is correctly found to be
 *     invisible, and the seats, grab rails, driver's cabs and gangway frames
 *     fall out on their own without anyone having to name them. Fully
 *     transparent geometry (the export has a mesh at alpha 0) goes first.
 *  2. **Cuts the body at its two articulation joints.** A rigid 25 m vehicle
 *     cannot follow this loop's 10 m corners — the chord across a rigid body
 *     that long is wider than the corner's whole diameter — which is why the
 *     real vehicle is three bodies on two articulated joints. The joints were
 *     measured, not eyeballed: the body's half-width at waist height dips from
 *     51.1 to 45.5 source units in two narrow bands, symmetric about the
 *     centre at ±174.5 units, which are the bellows. Triangles are bucketed by
 *     centroid, and each section reaches slightly past its own cut so that
 *     neighbours overlap inside the bellows instead of showing a seam.
 *  3. **Simplifies what is left** to a triangle budget with meshoptimizer,
 *     per section and material so the livery stripes keep their own geometry.
 *
 * Then the usual normalisation: the model is Z-up and lies along +X, and
 * everything in this project stands Y-up and drives down -Z.
 *
 * Emits:
 *
 *   public/models/tram.glb     Draco-compressed, normalised, three sections.
 *   src/config/tramData.json   Measured size and section offsets.
 *
 * Run with: npm run prepare:tram
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'alstom_citadis_202_c_class_melbourne_tram.glb';
const DST = 'public/models/tram.glb';
const DATA = 'src/config/tramData.json';

/**
 * The ruler. The export is not proportioned to the real vehicle — scaling it
 * by length, by width or by height disagree by about 13 % — so one dimension
 * has to be chosen and the others allowed to fall where they land. Width wins
 * because width is what this project's geometry actually cares about: the
 * rails are laid at 1.44 m gauge down real city streets, and `railConfig`'s
 * clearances were all reasoned about in terms of how wide the tram is against
 * how wide the road is. A tram half a metre out on length is invisible; one
 * half a metre out on width fouls the kerb.
 */
const REAL_WIDTH = 2.65;

/**
 * Articulation joints, in source X. Measured from the body's waist-height
 * half-width profile — see the file comment. Symmetric about the body centre
 * at 515, which is a good sign the reading is real and not noise.
 */
const JOINTS = [340.5, 689.5];

/**
 * How far past its own cut each section reaches, in source units (~2 cm each
 * at final scale). The sections are placed independently on the curve, so
 * their facing ends swing apart through a corner; a little overlap buried in
 * the bellows band is what stops that reading as a hole in the tram.
 */
const JOINT_OVERLAP = 9;

/**
 * Triangles aimed at — and on this model it is an aspiration, not a promise.
 * The error ceiling below is what actually governs, and it stops well short:
 * expect around 450 k. See `SIMPLIFY_ERROR` for why, and §"Riding the tram"
 * in the README for what that costs at runtime.
 */
const TRI_BUDGET = 80_000;

/**
 * Simplification error ceiling, as a fraction of each primitive's own extent.
 *
 * Deliberately tight, because **this model does not decimate**. Its bodyshell
 * is a lattice of thin window and door frames, and meshoptimizer will not
 * collapse an edge on a topological border, so almost every triangle in it is
 * locked in place: raising this to 2 % bought 12 % fewer triangles, and 5 %
 * bought 25 % but broke the livery swooshes into dashes and blunted the nose
 * by most of a metre. Unlocking borders instead lets the shell bridge
 * straight across its own window openings, spraying white slivers over every
 * pane. Both were tried, both were rendered, both looked worse than paying
 * for the triangles. So this is set where it only removes real redundancy.
 */
const SIMPLIFY_ERROR = 0.005;

/**
 * Primitives at or under this are left alone. They are the trim — a lamp, a
 * wiper, a handle — where the budget saved is negligible and simplification
 * does the most visible damage, because there is no redundant detail to give
 * up. Primitives are split by material, so there are a lot of these.
 */
const SMALL_PRIMITIVE = 400;

/** Visibility test: viewpoints, resolution, and the threshold to survive it. */
const VIEWS = 26;
const VIEW_PX = 420;
const MIN_VISIBLE_PX = 600;

/**
 * Elevations the visibility test looks from, degrees above the horizon.
 *
 * Deliberately a hemisphere and not a sphere: a tram sits on the ground, so
 * there is no viewpoint underneath it and no reason to pay for geometry only
 * reachable from one. The first version of this test used a full sphere and
 * kept 45 k triangles of bogie frames and brake discs that are only ever seen
 * from below the road surface. The low bound stays just above the horizon so
 * that what you *can* see under the skirt from a kerbside camera — the wheels
 * — still counts as visible; the high bound covers the chase camera, which
 * looks down from about 7 m up, and the garage's own stage angle.
 */
const VIEW_ELEVATION = [3, 75];

/**
 * Crease angle for the normals rebuilt after simplification, degrees. Panel
 * edges stay sharp, the nose and the roof camber stay smooth.
 */
const CREASE = 40;

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const srcSize = readFileSync(SRC).byteLength;
step(`reading ${SRC} (${mb(srcSize)})`);
const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

// ---------------------------------------------------------------------------
// 1. Flatten to a list of drawable parts.
//
// Every mesh-bearing node in this export has an identity transform; the only
// non-identity node is the `Sketchfab_model` wrapper, which carries the -90°
// about X that turns SketchUp's Z-up into glTF's Y-up. That rotation is
// deliberately ignored: this script applies its own orientation below, from
// raw source coordinates, so honouring the wrapper too would rotate twice.
// The check is asserted rather than assumed, because a silently non-identity
// node would put one part of the tram somewhere else entirely.
// ---------------------------------------------------------------------------
const IDENT = (node) => {
  const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
  return t.every((v) => v === 0) && r[0] === 0 && r[1] === 0 && r[2] === 0
    && Math.abs(r[3]) === 1 && s.every((v) => v === 1);
};

const parts = [];
(function walk(node, insideWrapper) {
  const mesh = node.getMesh();
  if (mesh) {
    if (!IDENT(node)) throw new Error(`mesh node ${node.getName()} has a transform; bake it first`);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      parts.push({
        material: prim.getMaterial(),
        position: pos.getArray(),
        normal: prim.getAttribute('NORMAL')?.getArray() ?? null,
        index: prim.getIndices()?.getArray() ?? null,
        vertexCount: pos.getCount(),
      });
    }
  }
  for (const child of node.listChildren()) walk(child, insideWrapper);
})({ getMesh: () => null, listChildren: () => scene.listChildren() }, false);

const triCount = (part) => (part.index ? part.index.length : part.vertexCount) / 3;
const totalTris = parts.reduce((a, p) => a + triCount(p), 0);
step(`${parts.length} primitives, ${Math.round(totalTris).toLocaleString()} triangles`);

// Fully transparent geometry: the export carries a mesh whose material sits at
// alpha 0, which draws nothing but costs everything.
const solid = parts.filter((p) => {
  const m = p.material;
  if (!m) return true;
  return !(m.getAlphaMode() === 'BLEND' && m.getBaseColorFactor()[3] <= 0.02);
});
step(`dropped ${parts.length - solid.length} fully transparent primitive(s)`);

// ---------------------------------------------------------------------------
// 2. Visibility cull.
//
// A flat-shaded z-buffer from `VIEWS` directions spread over a sphere. Each
// pixel records which primitive won it; a primitive that never wins anywhere
// is geometry no player can ever see, and it goes. Treating glass as opaque is
// the point rather than a limitation — it is what makes the cabin interior
// come out invisible, which is exactly the intent.
// ---------------------------------------------------------------------------
const bbox = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
for (const part of solid) {
  const p = part.position;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < bbox.lo[k]) bbox.lo[k] = p[i + k];
      if (p[i + k] > bbox.hi[k]) bbox.hi[k] = p[i + k];
    }
  }
}

/**
 * Camera *look* directions, spread over the band of elevations a player can
 * actually occupy. The golden angle spaces the azimuths so consecutive views
 * never cluster. Returned as the direction the camera looks *along*, which is
 * the negation of where it stands: the rasterizer keeps the smallest depth, so
 * the eye sits at negative infinity along this axis.
 */
function directions(n) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const yLo = Math.sin((VIEW_ELEVATION[0] * Math.PI) / 180);
  const yHi = Math.sin((VIEW_ELEVATION[1] * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const y = yLo + (yHi - yLo) * ((i + 0.5) / n);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    // Stand at (x, y, z) above the ground; look back down at the tram.
    out.push([-Math.cos(theta) * r, -y, -Math.sin(theta) * r]);
  }
  return out;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const visible = new Uint32Array(solid.length);

for (const forward of directions(VIEWS)) {
  const f = norm(forward);
  const seed = Math.abs(f[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(seed, f));
  const up = cross(f, right);

  // Frame the whole model from this direction, using bbox corners only.
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const q = [
      c & 1 ? bbox.hi[0] : bbox.lo[0],
      c & 2 ? bbox.hi[1] : bbox.lo[1],
      c & 4 ? bbox.hi[2] : bbox.lo[2],
    ];
    const u = q[0] * right[0] + q[1] * right[1] + q[2] * right[2];
    const v = q[0] * up[0] + q[1] * up[1] + q[2] * up[2];
    if (u < lo[0]) lo[0] = u; if (u > hi[0]) hi[0] = u;
    if (v < lo[1]) lo[1] = v; if (v > hi[1]) hi[1] = v;
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1;
  const scale = (VIEW_PX - 2) / span;
  const W = VIEW_PX, H = VIEW_PX;
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const idbuf = new Int32Array(W * H).fill(-1);

  for (let pi = 0; pi < solid.length; pi++) {
    const part = solid[pi];
    const P = part.position, I = part.index;
    const n = I ? I.length : part.vertexCount;
    for (let t = 0; t < n; t += 3) {
      const a = (I ? I[t] : t) * 3, b = (I ? I[t + 1] : t + 1) * 3, c = (I ? I[t + 2] : t + 2) * 3;
      const ax = (P[a] * right[0] + P[a + 1] * right[1] + P[a + 2] * right[2] - lo[0]) * scale + 1;
      const ay = H - 1 - (P[a] * up[0] + P[a + 1] * up[1] + P[a + 2] * up[2] - lo[1]) * scale;
      const az = P[a] * f[0] + P[a + 1] * f[1] + P[a + 2] * f[2];
      const bx = (P[b] * right[0] + P[b + 1] * right[1] + P[b + 2] * right[2] - lo[0]) * scale + 1;
      const by = H - 1 - (P[b] * up[0] + P[b + 1] * up[1] + P[b + 2] * up[2] - lo[1]) * scale;
      const bz = P[b] * f[0] + P[b + 1] * f[1] + P[b + 2] * f[2];
      const cx = (P[c] * right[0] + P[c + 1] * right[1] + P[c + 2] * right[2] - lo[0]) * scale + 1;
      const cy = H - 1 - (P[c] * up[0] + P[c + 1] * up[1] + P[c + 2] * up[2] - lo[1]) * scale;
      const cz = P[c] * f[0] + P[c + 1] * f[1] + P[c + 2] * f[2];

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      if (minX > maxX || minY > maxY) continue;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (!den) continue;

      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const w0 = ((by - cy) * (px + 0.5 - cx) + (cx - bx) * (py + 0.5 - cy)) / den;
          const w1 = ((cy - ay) * (px + 0.5 - cx) + (ax - cx) * (py + 0.5 - cy)) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * az + w1 * bz + w2 * cz;
          const o = py * W + px;
          if (d < zbuf[o]) { zbuf[o] = d; idbuf[o] = pi; }
        }
      }
    }
  }
  for (let i = 0; i < idbuf.length; i++) if (idbuf[i] >= 0) visible[idbuf[i]]++;
}

/**
 * Glazing is exempt from the threshold, because the threshold cannot measure
 * it. The test rasterizes every triangle as opaque — which is what makes it
 * find the cabin correctly invisible — but that same assumption badly
 * under-counts a tinted pane, which in the real renderer is a surface you look
 * *through* rather than at. Culling glass on those numbers punched the windows
 * out of the tram and left the inside of the far wall showing through the
 * holes. Panes are cheap anyway: the main glazing is 3.2 k triangles and wins
 * more pixels than any other single primitive.
 */
const glazing = (part) => part.material?.getAlphaMode() !== 'OPAQUE';

const kept = [];
let culledTris = 0;
for (let i = 0; i < solid.length; i++) {
  if (visible[i] >= MIN_VISIBLE_PX || glazing(solid[i])) {
    // Carried through to the simplifier: how much screen a primitive actually
    // occupies is the honest measure of how many triangles it deserves.
    solid[i].pixels = visible[i];
    kept.push(solid[i]);
  } else culledTris += triCount(solid[i]);
}

const keptTris = kept.reduce((a, p) => a + triCount(p), 0);
step(`visibility: kept ${kept.length}/${solid.length} primitives, `
  + `${Math.round(keptTris).toLocaleString()} tris (culled ${Math.round(culledTris).toLocaleString()} unseen)`);

// ---------------------------------------------------------------------------
// 3. Measure, and work out the transform.
// ---------------------------------------------------------------------------
/**
 * True for a needle: a triangle so much longer than it is wide that it carries
 * no shape, only a streak.
 *
 * The export has a set of these radiating from the pantograph — flat ribbons a
 * couple of centimetres wide and metres long, which read as white slashes
 * sprayed across the roof and down over the windows from every angle. They are
 * in the source model, not something the cull or the simplifier introduced
 * (both were verified against a render with simplification disabled), and they
 * are the only thing on the vehicle that looks broken. The measure is the
 * triangle's own thickness — twice its area over its longest edge — against
 * that longest edge. Real trim is nowhere near this slender: a window frame
 * strip runs about 30:1, the streaks run past 200:1. Set at 80 it also took
 * the pantograph's own rods with it and left a solid white fin on the roof,
 * so it sits above those and below the streaks.
 */
const NEEDLE_ASPECT = 150;

function isNeedle(P, a, b, c) {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
  const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const twiceArea = Math.hypot(nx, ny, nz);
  const longest = Math.sqrt(Math.max(
    ux * ux + uy * uy + uz * uz,
    vx * vx + vy * vy + vz * vz,
    (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2,
  ));
  if (twiceArea <= 0) return true;                 // degenerate outright
  const thickness = twiceArea / longest;
  return longest / thickness > NEEDLE_ASPECT;
}

let needles = 0;

const shellLo = [Infinity, Infinity, Infinity], shellHi = [-Infinity, -Infinity, -Infinity];
// Needles are excluded from the measurement as well as from the output: the
// export's edge-overlay ribbons reach past the bodywork at both ends, and
// letting them set the ruler scaled the real body down by 6 %.
for (const part of kept) {
  const P = part.position, I = part.index;
  const n = I ? I.length : part.vertexCount;
  for (let t = 0; t < n; t += 3) {
    const a = I ? I[t] : t, b = I ? I[t + 1] : t + 1, c = I ? I[t + 2] : t + 2;
    if (isNeedle(P, a, b, c)) continue;
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (P[v * 3 + k] < shellLo[k]) shellLo[k] = P[v * 3 + k];
        if (P[v * 3 + k] > shellHi[k]) shellHi[k] = P[v * 3 + k];
      }
    }
  }
}
const SCALE = REAL_WIDTH / (shellHi[1] - shellLo[1]);
const centreX = (shellLo[0] + shellHi[0]) / 2;
const centreY = (shellLo[1] + shellHi[1]) / 2;
const groundZ = shellLo[2];
step(`source ${(shellHi[0] - shellLo[0]).toFixed(1)} x ${(shellHi[1] - shellLo[1]).toFixed(1)} `
  + `x ${(shellHi[2] - shellLo[2]).toFixed(1)} units -> scale ${SCALE.toFixed(5)}`);

/**
 * Source is Z-up along +X; the project is Y-up facing -Z. So model X becomes
 * world -Z, model Y becomes world -X and model Z becomes world +Y — a proper
 * rotation (determinant +1), unlike the tempting X->-Z / Y->+X pairing, which
 * mirrors the tram and puts its doors on the wrong side.
 */
const toWorld = (x, y, z, sectionX) => [
  -(y - centreY) * SCALE,
  (z - groundZ) * SCALE,
  -(x - sectionX) * SCALE,
];
const normalToWorld = (nx, ny, nz) => [-ny, nz, -nx];

// ---------------------------------------------------------------------------
// 4. Cut into sections and rebuild the geometry.
//
// A primitive that spans a cut is split triangle by triangle on its centroid;
// a compact one (a lamp, the pantograph head) is assigned whole to whichever
// section holds its centre, so small assemblies are never torn in half.
// ---------------------------------------------------------------------------
const bounds = [
  [-Infinity, JOINTS[0]],
  [JOINTS[0], JOINTS[1]],
  [JOINTS[1], Infinity],
];
const sectionCentres = [
  (shellLo[0] + JOINTS[0]) / 2,
  (JOINTS[0] + JOINTS[1]) / 2,
  (JOINTS[1] + shellHi[0]) / 2,
];
/** Compact enough to keep whole: under a section's own length. */
const WHOLE_LIMIT = (JOINTS[1] - JOINTS[0]) * 0.9;

/** buckets[section] = Map(material -> { pos: [], nor: [], idx: [], seen: Map }) */
const buckets = bounds.map(() => new Map());

const bucketFor = (section, material) => {
  const map = buckets[section];
  let entry = map.get(material);
  if (!entry) {
    entry = { pos: [], nor: [], idx: [], seen: new Map(), pixels: 0, parts: new Set() };
    map.set(material, entry);
  }
  return entry;
};

/** Appends one source triangle into a section bucket, sharing vertices. */
function emit(entry, part, a, b, c, sectionX) {
  if (!entry.parts.has(part)) { entry.parts.add(part); entry.pixels += part.pixels; }
  const P = part.position, N = part.normal;
  for (const v of [a, b, c]) {
    let mapped = entry.seen.get(v);
    if (mapped === undefined) {
      mapped = entry.pos.length / 3;
      entry.seen.set(v, mapped);
      const w = toWorld(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], sectionX);
      entry.pos.push(w[0], w[1], w[2]);
      if (N) {
        const n = normalToWorld(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
        entry.nor.push(n[0], n[1], n[2]);
      } else {
        entry.nor.push(0, 1, 0);
      }
    }
    entry.idx.push(mapped);
  }
}


for (const part of kept) {
  const P = part.position, I = part.index;
  const n = I ? I.length : part.vertexCount;

  let plo = Infinity, phi = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] < plo) plo = P[i];
    if (P[i] > phi) phi = P[i];
  }
  const whole = phi - plo <= WHOLE_LIMIT;
  const centre = (plo + phi) / 2;
  const wholeSection = bounds.findIndex(([lo, hi]) => centre >= lo && centre < hi);

  for (let t = 0; t < n; t += 3) {
    const a = I ? I[t] : t, b = I ? I[t + 1] : t + 1, c = I ? I[t + 2] : t + 2;
    if (isNeedle(P, a, b, c)) { needles++; continue; }
    let section;
    if (whole) {
      section = wholeSection;
    } else {
      const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
      section = bounds.findIndex(([lo, hi]) => cx >= lo && cx < hi);
      if (section < 0) section = cx < JOINTS[0] ? 0 : 2;
    }
    emit(bucketFor(section, part.material), part, a, b, c, sectionCentres[section]);

    // Reach past the cut, so neighbours overlap inside the bellows rather than
    // parting company through a corner.
    if (!whole) {
      const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
      for (let s = 0; s < bounds.length; s++) {
        if (s === section) continue;
        const [lo, hi] = bounds[s];
        if (cx >= lo - JOINT_OVERLAP && cx < hi + JOINT_OVERLAP) {
          emit(bucketFor(s, part.material), part, a, b, c, sectionCentres[s]);
        }
      }
    }
  }
}

const bucketTris = buckets.reduce((a, m) =>
  a + [...m.values()].reduce((b, e) => b + e.idx.length / 3, 0), 0);
step(`dropped ${needles.toLocaleString()} needle triangles`);
step(`cut into ${buckets.length} sections `
  + `(${buckets.map((m) => [...m.values()].reduce((b, e) => b + e.idx.length / 3, 0)).join('/')} tris)`);

// ---------------------------------------------------------------------------
// 5. Simplify to budget.
// ---------------------------------------------------------------------------
await MeshoptSimplifier.ready;

/*
 * The budget is shared out by **how much screen each primitive occupies**,
 * not by how many triangles it arrived with, using the pixel counts the
 * visibility pass already measured. That is the whole trick for this model:
 * a flat proportional split spends 45 k triangles on bogie frames and brake
 * discs glimpsed as a dark mass under the skirt, and then has nothing left
 * for the bodyshell, which is what the eye is actually on. Weighted by
 * visible area, the underframe is cut hard and the shell is barely touched.
 */
const everything = buckets.flatMap((map) => [...map.values()]);
const big = everything.filter((e) => e.idx.length / 3 > SMALL_PRIMITIVE);
const exempt = new Set(everything.filter((e) => !big.includes(e)));
const exemptTris = [...exempt].reduce((a, e) => a + e.idx.length / 3, 0);
const bigTris = big.reduce((a, e) => a + e.idx.length / 3, 0);
const bigPixels = big.reduce((a, e) => a + e.pixels, 0) || 1;
const shareable = Math.max(bigTris * 0.05, TRI_BUDGET - exemptTris);
step(`budget: ${Math.round(exemptTris).toLocaleString()} tris exempt in `
  + `${exempt.size} small primitives, `
  + `${Math.round(bigTris).toLocaleString()} shareable across ${big.length}`);

/**
 * Rebuilds normals over a simplified patch: area-weighted average per
 * position, but only across faces that agree to within `CREASE`. Welding for
 * simplification (below) collapses the crease-split vertices the export
 * carried, so without this every panel edge comes back rounded off.
 */
function rebuildNormals(pos, idx) {
  const smooth = new Float64Array(pos.length);
  const faces = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    // Unnormalised cross product: its length is twice the area, which is the
    // weight we want, so accumulate it as-is.
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    faces.push([nx, ny, nz]);
    for (const o of [a, b, c]) { smooth[o] += nx; smooth[o + 1] += ny; smooth[o + 2] += nz; }
  }

  const limit = Math.cos((CREASE * Math.PI) / 180);
  const outPos = [], outNor = [], outIdx = [], seen = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const [fx, fy, fz] = faces[t / 3];
    const fl = Math.hypot(fx, fy, fz) || 1;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k], o = v * 3;
      const sl = Math.hypot(smooth[o], smooth[o + 1], smooth[o + 2]) || 1;
      const agrees = (smooth[o] * fx + smooth[o + 1] * fy + smooth[o + 2] * fz) / (sl * fl) >= limit;
      const n = agrees
        ? [smooth[o] / sl, smooth[o + 1] / sl, smooth[o + 2] / sl]
        : [fx / fl, fy / fl, fz / fl];
      const key = `${v}|${agrees ? 's' : `${n[0].toFixed(3)},${n[1].toFixed(3)},${n[2].toFixed(3)}`}`;
      let mapped = seen.get(key);
      if (mapped === undefined) {
        mapped = outPos.length / 3;
        seen.set(key, mapped);
        outPos.push(pos[o], pos[o + 1], pos[o + 2]);
        outNor.push(n[0], n[1], n[2]);
      }
      outIdx.push(mapped);
    }
  }
  return { pos: outPos, nor: outNor, idx: outIdx };
}

let finalTris = exemptTris;
let worstError = 0;
for (const entry of big) {
  const tris = entry.idx.length / 3;
  const share = entry.pixels / bigPixels;
  const target = Math.max(24, Math.round(shareable * share));
  if (target >= tris) { finalTris += tris; continue; }
  const positions = new Float32Array(entry.pos);

  /*
   * Weld by position before simplifying, and this is the whole reason the
   * budget is reachable. The export authors each material as several separate
   * meshes — the white bodyshell arrives as four — and meshoptimizer will not
   * collapse an edge on a topological border, so unwelded patches are almost
   * entirely locked: an earlier run of this script bottomed out at 292 k
   * against an 80 k budget with the error ceiling raised to 8 %, because there
   * was nothing left it was allowed to touch. Welding is done per material,
   * never across one, so the livery stripes keep the hard seams that hold
   * their shape and only same-coloured geometry is joined up.
   */
  const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const welded = new Uint32Array(entry.idx.length);
  for (let i = 0; i < welded.length; i++) welded[i] = remap[entry.idx[i]];

  /*
   * `LockBorder` on top of the weld, which is not the contradiction it looks
   * like. Welding joins the four separate meshes the bodyshell arrives as, so
   * edges *inside* the shell become collapsible; locking the border then keeps
   * the edges around each window and door opening where they are. Without it
   * the simplifier is free to collapse a window frame and bridge the panel
   * straight across the opening, which it does: the run before this one sprayed
   * long white slivers across every pane of glass on the tram.
   */
  const [simplified, error] = MeshoptSimplifier.simplify(
    welded, positions, 3, target * 3, SIMPLIFY_ERROR, ['LockBorder'],
  );
  const rebuilt = rebuildNormals(entry.pos, simplified);
  entry.pos = rebuilt.pos;
  entry.nor = rebuilt.nor;
  entry.idx = rebuilt.idx;
  finalTris += entry.idx.length / 3;
  if (error > worstError) worstError = error;
}
step(`simplified ${Math.round(bucketTris).toLocaleString()} -> ${Math.round(finalTris).toLocaleString()} tris`
  + ` (budget ${TRI_BUDGET.toLocaleString()}, worst error ${(worstError * 100).toFixed(2)}% of extent)`);

// ---------------------------------------------------------------------------
// 6. Rebuild the document: three section nodes, each one mesh.
// ---------------------------------------------------------------------------
for (const node of [...root.listNodes()]) node.dispose();
for (const mesh of [...root.listMeshes()]) mesh.dispose();
// Accessors outlive the meshes that referenced them, and anything still
// assigned to a buffer is still written to it — so the source model's 2.86 M
// triangles come along for the ride unless they are disposed by hand. This is
// why the first working version of this script emitted a 73 MB "compressed"
// GLB. Safe here because every vertex has already been baked into `buckets`.
for (const accessor of [...root.listAccessors()]) accessor.dispose();

const usedMaterials = new Set();
const buffer = root.listBuffers()[0] ?? doc.createBuffer();
const sections = [];

for (let s = 0; s < buckets.length; s++) {
  const mesh = doc.createMesh(`tram_s${s}_mesh`);
  for (const [material, entry] of buckets[s]) {
    if (!entry.idx.length) continue;
    // Compact: simplification leaves unreferenced vertices behind.
    const remap = new Map();
    const pos = [], nor = [], idx = [];
    for (const v of entry.idx) {
      let m = remap.get(v);
      if (m === undefined) {
        m = pos.length / 3;
        remap.set(v, m);
        pos.push(entry.pos[v * 3], entry.pos[v * 3 + 1], entry.pos[v * 3 + 2]);
        nor.push(entry.nor[v * 3], entry.nor[v * 3 + 1], entry.nor[v * 3 + 2]);
      }
      idx.push(m);
    }
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3')
        .setArray(new Float32Array(pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3')
        .setArray(new Float32Array(nor)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR')
        .setArray(new Uint32Array(idx)).setBuffer(buffer))
      .setMaterial(material);
    mesh.addPrimitive(prim);
    if (material) usedMaterials.add(material);
  }
  const node = doc.createNode(`tram_s${s}`).setMesh(mesh);
  scene.addChild(node);
  sections.push({
    name: node.getName(),
    // Positive towards the front, which is -Z: see `toWorld`.
    offset: +((sectionCentres[s] - centreX) * SCALE).toFixed(4),
  });
}

// Materials and textures nothing references any more.
for (const material of root.listMaterials()) if (!usedMaterials.has(material)) material.dispose();
for (const texture of root.listTextures()) texture.dispose();
step(`kept ${usedMaterials.size} materials`);

// ---------------------------------------------------------------------------
// 7. Measure the result and emit.
// ---------------------------------------------------------------------------
const outLo = [Infinity, Infinity, Infinity], outHi = [-Infinity, -Infinity, -Infinity];
for (let s = 0; s < buckets.length; s++) {
  for (const entry of buckets[s].values()) {
    for (let i = 0; i < entry.pos.length; i += 3) {
      // Back to tram space: each section's geometry is centred on its own
      // origin, so its own offset has to be added back to measure the whole.
      const p = [entry.pos[i], entry.pos[i + 1], entry.pos[i + 2] - sections[s].offset];
      for (let k = 0; k < 3; k++) {
        if (p[k] < outLo[k]) outLo[k] = p[k];
        if (p[k] > outHi[k]) outHi[k] = p[k];
      }
    }
  }
}
const size = [outHi[0] - outLo[0], outHi[1] - outLo[1], outHi[2] - outLo[2]];

doc.createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({
    method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
    encodeSpeed: 5, decodeSpeed: 5,
    quantizationVolume: 'mesh',
    quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
  });

await io.write(DST, doc);

const spacing = sections.length > 1 ? sections[1].offset - sections[0].offset : 0;
writeFileSync(DATA, JSON.stringify({
  model: '/models/tram.glb',
  /** Width (X), height (Y), length (Z), metres. Height is to the raised pantograph. */
  size: size.map((v) => +v.toFixed(3)),
  /**
   * One entry per articulated section. `offset` is metres along the tram from
   * its centre, positive towards the front — the runtime places each section
   * that much further along the rail, which is what lets the tram bend.
   */
  sections,
  triangles: Math.round(finalTris),
}, null, 2) + '\n');

console.log('\n--- tram ---');
console.log(`  ${size[2].toFixed(2)} m long  ${size[0].toFixed(2)} m wide  ${size[1].toFixed(2)} m tall`
  + `  ${Math.round(finalTris).toLocaleString()} tris`);
console.log(`  ${sections.length} sections at ` + sections.map((s) => s.offset.toFixed(2)).join(', ') + ' m'
  + `  (spacing ${spacing.toFixed(2)} m)`);
console.log(`  suggested RAIL.minTramGap ${(size[2] + 6).toFixed(1)}`
  + `, TRAM.sectionCollider ${(spacing * 1.13).toFixed(1)}`);
console.log(`  GLB  ${mb(srcSize)} -> ${mb(readFileSync(DST).byteLength)}\n`);
