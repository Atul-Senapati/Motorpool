/**
 * Skylark's own assets, baked.
 *
 *     npm run prepare:country
 *
 * The downloads for the countryside island, plus three houses lifted out of
 * the city map, in two kinds of output:
 *
 *   public/models/country.glb         the static kit — the wind turbine's tower
 *                                     and blades, the church, and the three
 *                                     houses — every part centred on its
 *                                     footprint and standing on y = 0, Draco-
 *                                     compressed, the same contract as the
 *                                     park's and the airport's kits
 *   public/models/country/*.glb       the ANIMATED models, one file each: the
 *                                     windmill, a sheep and a cow. These keep
 *                                     their skeletons and clips — baking a
 *                                     skinned mesh into world space the way the
 *                                     kit is baked would throw the skin away —
 *                                     so they are pruned, scaled to metres,
 *                                     given WebP textures and written as they
 *                                     are
 *   src/config/countryModelData.json  sizes, the turbine's hub, the clips
 *
 * ## Scale
 *
 * Measured rather than trusted, and the skinned models measured in their
 * POSED bounds — a skinned mesh's raw vertices are in bind space, and the
 * windmill's sails read 19,000 units across that way against a 1,668-unit
 * tower, which is not a windmill. Posed, they are 1,908, which is one. The
 * turbine is a 20 m model asked to be a 56 m one; the church a 12 m chapel
 * asked to be an 18 m church; the windmill's tower is set at 14 m; the sheep
 * at 0.96 m to the back; the cow, which arrives at four-tenths size, at two
 * and a half times.
 *
 * ## What is thrown away
 *
 * The windmill file carries two mills side by side and the sheep file three
 * sheep, of which only the first of each is animated. The extras go, with
 * their skins and any clip channels that drove them.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const KIT = 'public/models/country.glb';
const LIFE_DIR = 'public/models/country';
const DATA = 'src/config/countryModelData.json';
const TEXTURE_SIZE = 1024;
const CITY_UNITS = 100;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await MeshoptSimplifier.ready;

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
const boundsOf = (arrays) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of arrays) for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]);
    max[k] = Math.max(max[k], p[i + k]);
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};

/* ------------------------------------------------------------------ the kit */

/**
 * The static parts: file, the node to take (with its subtree), which copy of
 * that name when the file repeats it, and the scale to metres.
 *
 * The grass pack names its nine tufts by material only — three nodes called
 * `green-material` — so a tuft is a name and an index: 0 is the big clump
 * (three crossed cards), 1 the middle tuft, 2 the small one.
 */
const TURBINE = source('wind_turbine.glb');
const CHURCH = source('psx_abandoned_church.glb');
const CITY = source('drive_for_speed_-_map.glb');
const POND = source('pond_assets.glb');

/**
 * The vehicles, and which way each one faces in its own file.
 *
 * `rotY` turns the part about +Y before it is centred, and every vehicle is
 * turned to face **−Z**, which is the convention the whole project places
 * vehicles by (`locomotivePose` spells it out: a model faces −Z, so a yaw
 * that drives along (dx, dz) is `atan2(−dx, −dz)`). Which way a model faces
 * to begin with was measured rather than guessed — the seat back is behind
 * the cushion, the engine is in front of the seats, the tall cab is over one
 * axle group, a tractor's small wheels are at its front and the implement it
 * tows is at its back.
 */
const FACE_PX = Math.PI / 2;    // the model's front is +X
const FACE_NX = -Math.PI / 2;   // ...−X
const FACE_PZ = Math.PI;        // ...+Z

/**
 * The pond pack, at a tenth: it is modelled ten times life size (a duck 4.2 m
 * long, a reed eleven metres). Its parts are laid out in a row in the file and
 * every one is re-centred on its own footprint here, so the layout offsets
 * come out in the wash.
 */
const PONDS = [
  { name: 'pondReed', pick: 'reed_01' },
  { name: 'pondSedge', pick: 'sedge_01' },
  { name: 'pondSedgeTall', pick: 'sedge_02' },
  { name: 'pondGrass', pick: 'grass_01' },
  { name: 'pondWaterGrass', pick: 'water_grass_02' },
  { name: 'pondWaterGrassSmall', pick: 'water_grass_03' },
  { name: 'pondLily', pick: 'water_grass_01' },
  { name: 'pondLotus', pick: 'lotus_01' },
  { name: 'pondLotusOpen', pick: 'lotus_02' },
  { name: 'pondLeaf', pick: 'leaf_01' },
  { name: 'pondLeafWide', pick: 'leaf_03' },
  { name: 'pondStone', pick: 'stone_01' },
  { name: 'pondStoneSmall', pick: 'stone_02' },
  { name: 'pondLog', pick: 'Cylinder' },
  { name: 'pondDuck', pick: 'duck' },
].map((p) => ({ ...p, file: POND, scale: 0.1 }));

/*
 * The grass pack was in this list and is not any more: nine thousand tufts
 * of it were scattered over the island and the user did not like them, so
 * the pack is not baked at all. The file is still in the repo root if anyone
 * wants it back: three colours, three sizes, alpha cards.
 */
const PARTS = [
  { name: 'turbineTower', file: TURBINE, pick: 'Windturbine Support_0', scale: 56 / 19.91 },
  // A chapel-sized model, at one and a half times so it is the hamlet's
  // church: 18 m long and 17 to the top of its steeple.
  { name: 'church', file: CHURCH, pick: 'PSX Abandoned Church', scale: 1.5 },
  // Centred on its hub rather than its footprint, so turning it turns it.
  { name: 'turbineBlades', file: TURBINE, pick: 'Windturbine Blades_1', scale: 56 / 19.91, centreY: true },
  { name: 'houseSmall', file: CITY, pick: 'House_Residential_03', scale: CITY_UNITS },
  { name: 'houseWide', file: CITY, pick: 'House_Residential_07', scale: CITY_UNITS },
  { name: 'houseLong', file: CITY, pick: 'House_Residential_08', scale: CITY_UNITS },
  // More of the city's houses, for the hamlet's cottages, which were boxes.
  { name: 'house01', file: CITY, pick: 'House_Residential_01', scale: CITY_UNITS },
  { name: 'house02', file: CITY, pick: 'House_Residential_02', scale: CITY_UNITS },
  { name: 'house06', file: CITY, pick: 'House_Residential_06', scale: CITY_UNITS },
  { name: 'house09', file: CITY, pick: 'House_Residential_09', scale: CITY_UNITS },
  { name: 'house10', file: CITY, pick: 'House_Residential_10', scale: CITY_UNITS },
  { name: 'house12', file: CITY, pick: 'House_Residential_12', scale: CITY_UNITS },
  { name: 'house13', file: CITY, pick: 'House_Residential_13', scale: CITY_UNITS },
  ...PONDS,

  /* ---------------------------------------------------------- the vehicles */

  /*
   * Six farm and working vehicles, each scaled off a real one of its kind and
   * decimated to a budget: between them they are 570 k triangles raw, which is
   * more than the rest of the island put together, and they are scenery a
   * player walks past rather than drives.
   */
  // A tractor with its trailer still on the drawbar: 14 m raw, 12 m at 0.85.
  { name: 'tractor', file: source('tractor_02.glb'), pick: 'Tractor 02.obj.cleaner.materialmerger.gles', scale: 0.85, rotY: FACE_NX, budget: 70000, error: 0.02 },
  // A combine, modelled life size already, header and all.
  { name: 'harvester', file: source('crop_harvestor.glb'), pick: 'RootNode', scale: 1, rotY: FACE_PZ },
  // 17 k raw and already low-poly; a light trim keeps the whole set in budget.
  // A flatbed pickup, 4.35 m raw, left at its own size.
  { name: 'pickup', file: source('1970_truck.glb'), pick: 'Collada visual scene group', scale: 1, rotY: FACE_NX, budget: 9000 },
  // A box lorry, 6.7 m raw.
  { name: 'boxLorry', file: source('gameready_truck.glb'), pick: 'RootNode', scale: 1, rotY: FACE_PX, budget: 9000 },
  // An articulated lorry, 19.8 m raw and too big for a farm lane at that:
  // 0.8 puts it at 15.9 m over the trailer, 2.9 wide, which is a real one.
  { name: 'artic', file: source('low_poly_truck.glb'), pick: 'RootNode', scale: 0.8, rotY: FACE_PZ },
  // The tractor unit out of the frac rig, as a lorry cab. Its own trailer is
  // an oil-field blender, which is not a thing this island has any use for,
  // so only the tractor is taken — 8 m of it, at 38 k triangles raw.

  /* ------------------------------------------------------------ the mine */

  /*
   * The quarry's plant. Four downloads, each scaled off the thing it stands
   * in for rather than off its own file: a processing plant is 27 m long and
   * stays that way, a 26 m mining machine comes down to a 12 m face shovel,
   * and the mine car is life size already at two metres over the buffers.
   * The yard machine is a 4 m unit taken up to 6.4 m, which is the size of a
   * screening plant or a compressor set standing beside a quarry's shed.
   */
  { name: 'minePlant', file: source('generic_factory_with_smoke_towers.glb'), pick: '02. Factory.obj.cleaner.materialmerger.gles', scale: 1 },
  { name: 'mineMachine', file: source('factory_machine.glb'), pick: 'Body_factorymachine01_reference.smd_0', scale: 1.6 },
  { name: 'mineShovel', file: source('space_mining_vehicle.glb'), pick: 'e6057149e569428fb4e565395c2eaad7.fbx', scale: 12 / 26.06, rotY: FACE_PX, budget: 40000, error: 0.03 },
  { name: 'mineCar', file: source('mine_car.glb'), pick: 'Collada visual scene group', scale: 1, budget: 12000 },
  // A rigid-frame haul truck, modelled life size at 9.4 m — a real HD465 is
  // 9.9 — and a crawler dozer whose file is in centimetres: 675 units of it
  // is a 6.75 m machine over the blade, which is a real DZ-171.
  { name: 'mineHauler', file: source('komatsu_hd-465-7eo.glb'), pick: 'Komatsu 2.obj.cleaner.materialmerger.gles', scale: 1, budget: 26000 },
  { name: 'mineDozer', file: source('dz-171.3.glb'), pick: 'GLTF_SceneRootNode', scale: 0.01, budget: 60000, error: 0.05, sloppy: 0.004 },
  // The works: a 828-unit model at 0.0483 is 40 m long and 21 m to the ridge,
  // which is a building a quarry of this size would send its stone to.
  { name: 'mineWorks', file: source('factory.glb'), pick: 'Collada visual scene group', scale: 0.0483 },
  // A KrAZ tipper, 10 m over the body: at 0.86 it is the 8.7 m of the real one.
  { name: 'mineDumper', file: source('kraz_250_dump_truck.glb'), pick: 'GLTF_SceneRootNode', scale: 0.86, budget: 60000, error: 0.05, sloppy: 0.003 },
  // A tracked excavator, 11.6 m with the boom out, left at its own size.
  { name: 'mineRig', file: source('construction_truck.glb'), pick: 'RootNode', scale: 1, budget: 60000, error: 0.05 },

  /* ------------------------------------------------ the quarry's site kit */

  /*
   * Lifted out of the city map for the works: an industrial shed for the
   * workshop, a mobile crane, a small lorry, and the yard clutter — a barrier
   * for the gate, a skip, a crate. The city's "industrial" buildings are
   * whole 90 m blocks with the streets baked in, so the one shed (J04) is
   * the only building there that can stand on its own.
   */
  { name: 'siteShed', file: CITY, pick: 'industrial J04', scale: CITY_UNITS },
  { name: 'siteCrane', file: CITY, pick: 'grua', scale: CITY_UNITS },
  { name: 'siteLorry', file: CITY, pick: 'TruckSmall', scale: CITY_UNITS },
  { name: 'siteBarrier', file: CITY, pick: 'Barrera_01', scale: CITY_UNITS },
  { name: 'siteSkip', file: CITY, pick: 'BasuraContainer', scale: CITY_UNITS },
  { name: 'siteCrate', file: CITY, pick: 'Caja', scale: CITY_UNITS },

  /*
   * The industrial set: a low-poly kit of separate, named buildings already in
   * metres and standing on y = 0, so each is one pick at scale 1. The rail
   * load-bay shed straddles the goods loop; the tall tanks are the plant's
   * silos; the trailers are the offices. And a 34 m dock crane, one mesh.
   */
  { name: 'indShedRail', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Railroad_Loadbay_Shed_1', scale: 1 },
  { name: 'indSilo', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Tank_4', scale: 1 },
  { name: 'indSilo2', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Tank_5', scale: 1 },
  { name: 'indTank', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Tank_1', scale: 1 },
  { name: 'indWatertower', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Watertower_1', scale: 1 },
  { name: 'indOffice', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_OfficeTrailer_1', scale: 1 },
  { name: 'indTransformer', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_TsrStation_1', scale: 1 },
  { name: 'indWarehouse', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Warehouse_1', scale: 1 },
  { name: 'indGantry', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_PortalCrane_2', scale: 1 },
  { name: 'indMast', file: source('industrial_buildings_set_-_low_poly_models.glb'), pick: 'Industrial_Radiotower_1', scale: 1 },
  { name: 'dockCrane', file: source('midsize_dock_crane.glb'), pick: 'RootNode', scale: 1, budget: 9000 },

  {
    name: 'lorryCab',
    file: source('frac_blender_with_tractor__hydraulic_fracturing.glb'),
    picks: ['Tractor_Chassis_0', 'Tractor_Fenders_7', 'Tractor_Cab_16', 'Tractor_FrontHardware_24',
      'Tractor_ChromeAccessories_32', 'Tractor_RearServices_40'],
    scale: 1, rotY: FACE_NX, budget: 12000,
  },
];

/** The picked subtrees of one file, baked to world space in metres. */
const readPicks = async (path, picks) => {
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
    // A part may be several sibling nodes: the frac rig's tractor unit is its
    // chassis, fenders, cab, front hardware, chrome and rear services, six
    // nodes at the top of the file with the blender's own beside them.
    const names = spec.picks ?? [spec.pick];
    const nodes = names.map((name) => {
      const all = byName.get(name) ?? [];
      const node = all[spec.instance ?? 0];
      if (!node) throw new Error(`${path}: no node "${name}" #${spec.instance ?? 0} (${all.length} carry that name)`);
      return node;
    });
    const prims = [];
    const walk = (nd) => {
      const mesh = nd.getMesh();
      if (mesh) {
        const world = nd.getWorldMatrix();
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          const nrm = prim.getAttribute('NORMAL');
          const uv = prim.getAttribute('TEXCOORD_0');
          const idx = prim.getIndices();
          const count = pos.getCount();
          const p = new Float32Array(count * 3);
          const n = new Float32Array(nrm ? count * 3 : 0);
          const t = new Float32Array(uv ? count * 2 : 0);
          const v = [0, 0, 0];
          // A yaw about +Y, applied after the node's own transform and
          // before the scale, so a spec can turn a model to face -Z.
          const ca = Math.cos(spec.rotY ?? 0);
          const sa = Math.sin(spec.rotY ?? 0);
          const yaw = (a, b) => [a * ca + b * sa, -a * sa + b * ca];
          for (let i = 0; i < count; i++) {
            pos.getElement(i, v);
            const w = mul(world, v);
            const [wx, wz] = yaw(w[0], w[2]);
            p.set([wx * spec.scale, w[1] * spec.scale, wz * spec.scale], i * 3);
            if (nrm) {
              nrm.getElement(i, v);
              const d = mulDir(world, v);
              const [dx, dz] = yaw(d[0], d[2]);
              const len = Math.hypot(dx, d[1], dz) || 1;
              n.set([dx / len, d[1] / len, dz / len], i * 3);
            }
            if (uv) { uv.getElement(i, v); t.set([v[0], v[1]], i * 2); }
          }
          prims.push({
            pos: p, nrm: n, uv: t,
            idx: idx ? Uint32Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i))
              : Uint32Array.from({ length: count }, (_, i) => i),
            material: prim.getMaterial(),
          });
        }
      }
      for (const child of nd.listChildren()) walk(child);
    };
    for (const node of nodes) walk(node);
    if (!prims.length) throw new Error(`${path}: "${names.join(', ')}" has no geometry`);
    // Join the primitives that share a material into one each.
    //
    // A Sketchfab export of a machine is one primitive per bolt — the dozer
    // arrives as 206 of them — and every primitive is its own draw call.
    // Joined by material the dozer is 21 and the face shovel 1.
    //
    // Before the decimation, so the simplifier is handed one mesh per
    // material rather than two hundred sub-parts: it holds each connected
    // component of a mesh together, and a 600-triangle bolt cannot go to 70
    // whatever error it is given. It still will not take the dozer far — the
    // model is a shell per plate and the components survive the join — but
    // the lorry cab and the face shovel both come out smaller this way.
    // Positions are already in world space here, so concatenating them is
    // sound, and the vertex compaction below throws away what is orphaned.
    {
      const byMaterial = new Map();
      for (const prim of prims) {
        const key = prim.material;
        if (!byMaterial.has(key)) byMaterial.set(key, []);
        byMaterial.get(key).push(prim);
      }
      const joined = [];
      for (const [material, group] of byMaterial) {
        if (group.length === 1) { joined.push(group[0]); continue; }
        const verts = group.reduce((n, g) => n + g.pos.length / 3, 0);
        const hasN = group.some((g) => g.nrm.length);
        const hasT = group.some((g) => g.uv.length);
        const pos = new Float32Array(verts * 3);
        const nrm = new Float32Array(hasN ? verts * 3 : 0);
        const uv = new Float32Array(hasT ? verts * 2 : 0);
        const idx = new Uint32Array(group.reduce((n, g) => n + g.idx.length, 0));
        let v = 0;
        let i = 0;
        for (const g of group) {
          const count = g.pos.length / 3;
          pos.set(g.pos, v * 3);
          if (hasN && g.nrm.length) nrm.set(g.nrm, v * 3);
          if (hasT && g.uv.length) uv.set(g.uv, v * 2);
          for (let k = 0; k < g.idx.length; k++) idx[i + k] = g.idx[k] + v;
          v += count;
          i += g.idx.length;
        }
        joined.push({ pos, nrm, uv, idx, material });
      }
      prims.length = 0;
      prims.push(...joined);
    }
    // Decimate to the part's budget, share by share, so a part made of many
    // primitives loses the same proportion from each. Welded by position
    // first, for the reason `prepare-train` gives at length: an export split
    // per triangle corner is all border edges as far as the simplifier can
    // tell, and it then collapses almost nothing.
    const raw = prims.reduce((n, p) => n + p.idx.length / 3, 0);
    if (spec.budget && raw > spec.budget) {
      const ratio = spec.budget / raw;
      for (const prim of prims) {
        const target = Math.max(3, Math.floor((prim.idx.length * ratio) / 3)) * 3;
        if (target >= prim.idx.length) continue;
        // Weld by position first. These exports are split per triangle corner,
        // so without a remap every edge is a border edge as far as the
        // simplifier can tell and it collapses almost nothing — 184 k asked
        // down to 13 k came back as 115 k on the first run.
        //
        // NOT `simplifyPrune`: its threshold is relative to the whole mesh,
        // and each of these primitives is one sub-part of a vehicle, so it
        // read every one of them as a speck and pruned the lot — all six
        // vehicles came back with zero triangles.
        // (positions, stride) — it takes TWO arguments, and a third silently
        // became the stride, which produced a garbage remap that scrambled
        // every index: the lorry came out four centimetres tall.
        const remap = MeshoptSimplifier.generatePositionRemap(prim.pos, 3);
        let idx = Uint32Array.from(prim.idx, (i) => remap[i]);
        if (idx.length > target) {
          // No `LockBorder`: these are scenery seen from metres away, not a
          // vehicle the camera sits inside, and locking the seams of a model
          // this fragmented is the same as not simplifying it.
          // `error` is a fraction of the PRIMITIVE's own extent, so a model
          // split into two hundred small sub-parts needs a looser one than a
          // model that is one mesh: at 0.08 the dozer gave back 111 k of the
          // 124 k it was asked to cut to 14 k.
          const [simplified] = MeshoptSimplifier.simplify(idx, prim.pos, 3, target, spec.error ?? 0.08, []);
          idx = Uint32Array.from(simplified);
          // `sloppy` for the things whose silhouette is all that matters —
          // a heap of stone. It ignores topology, which is the only way past
          // a model built as two hundred separate pebbles, and it will happily
          // spend its whole error budget, so it is asked for a small one.
          if (spec.sloppy && idx.length > target) {
            const [rough] = MeshoptSimplifier.simplifySloppy(idx, prim.pos, 3, null, target, spec.sloppy);
            if (rough.length >= 3) idx = Uint32Array.from(rough);
          }
        }
        prim.idx = idx;
      }
      const now = prims.reduce((n, p) => n + p.idx.length / 3, 0);
      console.log(`  decimated ${spec.name}: ${Math.round(raw).toLocaleString()} -> ${Math.round(now).toLocaleString()} tris`);
    }
    // Drop the vertices nothing points at any more. Without this the file
    // still carries every original vertex of a decimated part — the six
    // vehicles left 13 MB of orphaned positions in a 50 k-triangle kit.
    for (const prim of prims) {
      const used = new Int32Array(prim.pos.length / 3).fill(-1);
      let next = 0;
      for (const i of prim.idx) if (used[i] === -1) used[i] = next++;
      if (next === prim.pos.length / 3) continue;
      const pos = new Float32Array(next * 3);
      const nrm = new Float32Array(prim.nrm.length ? next * 3 : 0);
      const uv = new Float32Array(prim.uv.length ? next * 2 : 0);
      for (let i = 0; i < used.length; i++) {
        const k = used[i];
        if (k === -1) continue;
        pos.set(prim.pos.subarray(i * 3, i * 3 + 3), k * 3);
        if (nrm.length) nrm.set(prim.nrm.subarray(i * 3, i * 3 + 3), k * 3);
        if (uv.length) uv.set(prim.uv.subarray(i * 2, i * 2 + 2), k * 2);
      }
      prim.pos = pos;
      prim.nrm = nrm;
      prim.uv = uv;
      prim.idx = Uint32Array.from(prim.idx, (i) => used[i]);
    }
    out.set(spec.name, prims);
  }
  return out;
};

const byFile = new Map();
for (const spec of PARTS) {
  if (!byFile.has(spec.file)) byFile.set(spec.file, []);
  byFile.get(spec.file).push(spec);
}
const built = [];
let turbineFoot = null;
let turbineHub = null;
for (const [file, specs] of byFile) {
  const picked = await readPicks(file, specs);
  console.log(`read ${file}: ${specs.length} parts`);
  for (const spec of specs) {
    const prims = picked.get(spec.name);
    const whole = boundsOf(prims.map((p) => p.pos));
    // The rotor turns about its hub, and the hub is the vertex CENTROID, not
    // the middle of the box: with one blade straight up the box's middle is
    // metres above the hub, and a rotor pivoted there wobbles.
    const mean = [0, 0, 0];
    let count = 0;
    for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
      mean[0] += p.pos[i]; mean[1] += p.pos[i + 1]; mean[2] += p.pos[i + 2]; count++;
    }
    for (let k = 0; k < 3; k++) mean[k] /= count || 1;
    if (spec.name === 'turbineTower') turbineFoot = [whole.centre[0], whole.min[1], whole.centre[2]];
    if (spec.name === 'turbineBlades') turbineHub = [...mean];
    const shift = spec.centreY
      ? mean
      : [whole.centre[0], whole.min[1], whole.centre[2]];
    for (const prim of prims) {
      for (let i = 0; i < prim.pos.length; i += 3) {
        prim.pos[i] -= shift[0];
        prim.pos[i + 1] -= shift[1];
        prim.pos[i + 2] -= shift[2];
      }
    }
    const framed = boundsOf(prims.map((p) => p.pos));
    const tris = prims.reduce((n, p) => n + p.idx.length / 3, 0);
    console.log(`  ${spec.name.padEnd(16)} ${framed.size.map((v) => v.toFixed(2)).join(' x ').padEnd(22)} m`
      + `  ${String(Math.round(tris)).padStart(5)} tris  ${prims.length} prim(s)`);
    built.push({ name: spec.name, prims, size: framed.size, tris });
  }
}
/** Where the blades turn, relative to the tower's foot. */
const hub = turbineHub.map((v, k) => v - turbineFoot[k]);
console.log(`  turbine hub at ${hub.map((v) => v.toFixed(2)).join(', ')} over the foot`);

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('country');
const textures = new Map();
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(image)) return textures.get(image);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86 })
    .toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(image, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src) => {
  if (materials.has(src)) return materials.get(src);
  // A cutout stays a cutout — the grass is alpha cards and would be
  // rectangles otherwise, as the park's trees once were. Everything else
  // opaque, for the sorting reasons the park script gives.
  const cutout = src?.getAlphaMode() === 'MASK' || src?.getAlphaMode() === 'BLEND';
  const m = out.createMaterial(src?.getName() || 'country')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.9)
    .setDoubleSided(cutout || (src?.getDoubleSided() ?? false))
    .setAlphaMode(cutout ? 'MASK' : 'OPAQUE')
    .setAlphaCutoff(0.5);
  const spec = src?.getExtension('KHR_materials_pbrSpecularGlossiness');
  const tex = await convertTexture(spec?.getDiffuseTexture?.() ?? src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
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
await io.write(KIT, out);
console.log(`wrote ${KIT}: ${Math.round(triangles)} triangles in ${built.length} parts, ${textures.size} textures`);

/* ------------------------------------------------------------- the animated */

/**
 * Each animated model: the nodes to drop, the scale to metres and where its
 * origin should be, measured off the posed bounds printed above the script.
 * `shift` is applied before the scale, in the model's own units.
 */
const LIFE = [
  {
    name: 'windmill', file: source('windmill.glb'),
    drop: ['Object_9', 'Cylinder012_Windmill_0'],
    scale: 14 / 1668, shift: [0, 3.9, 98],
    clip: 'Take 001',
  },
  {
    name: 'sheep', file: source('sheep_animation_lowpoly.glb'),
    drop: ['Armature.001_29', 'Armature.002_44'],
    scale: 0.72, shift: [-0.02, 0, -0.235],
    clip: 'Animation',
  },
  {
    name: 'cow', file: source('farm_cow_animated_dairy_cattle.glb'),
    drop: [],
    scale: 2.5, shift: [0.005, 0, -0.175],
    clip: 'Armature|idle1',
  },
  {
    // Three chickens in the file, pecking on one shared clip; the other two
    // armatures go, and the one that stays is the copy at the near end.
    name: 'chicken', file: source('farm_animals.glb'),
    drop: ['Armature.001_7', 'Armature.002_11'],
    scale: 0.22, shift: [-0.14, 1.31, -3.19],
    clip: 'Animation',
  },
  {
    // Rigged, but the file carries no clip, so it stands in its bind pose —
    // which for this model is a horse standing square, and a horse in a
    // paddock standing still is what it would be doing anyway.
    name: 'horse', file: source('low_poly_horse.glb'),
    drop: [],
    scale: 0.78, shift: [0.5, 0.01, -0.64],
    // Its head is at −X in the file; a quarter turn puts it at −Z.
    rotY: -Math.PI / 2,
    clip: null,
  },
];

mkdirSync(LIFE_DIR, { recursive: true });
const life = {};
for (const spec of LIFE) {
  const doc = await io.read(spec.file);
  const root = doc.getRoot();
  // Drop what is not wanted, with everything under it.
  const dropped = new Set();
  const dropTree = (node) => {
    for (const child of node.listChildren()) dropTree(child);
    dropped.add(node);
    node.dispose();
  };
  for (const node of root.listNodes()) if (spec.drop.includes(node.getName())) dropTree(node);
  // Skins whose skeleton went, and clip channels aimed at nothing.
  for (const skin of root.listSkins()) {
    if (skin.listJoints().some((j) => j.isDisposed())) skin.dispose();
  }
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const target = ch.getTargetNode();
      if (!target || target.isDisposed()) { const s = ch.getSampler(); ch.dispose(); s?.dispose(); }
    }
  }
  // Wrap what is left in one named node that puts it in metres at the origin.
  const sceneIn = root.listScenes()[0];
  const wrapper = doc.createNode(spec.name)
    .setScale([spec.scale, spec.scale, spec.scale])
    // The wrapper is T * R * S, so a yaw turns the shift with the model and
    // the translation has to be the ROTATED shift or the origin slides out
    // from under it. Every animal is baked facing −Z, the convention the
    // whole project places things by.
    .setRotation([0, Math.sin((spec.rotY ?? 0) / 2), 0, Math.cos((spec.rotY ?? 0) / 2)])
    .setTranslation((() => {
      const a = spec.rotY ?? 0;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const [sx, sy, sz] = spec.shift.map((v) => -v * spec.scale);
      return [sx * c + sz * sn, sy, -sx * sn + sz * c];
    })());
  for (const child of sceneIn.listChildren()) {
    sceneIn.removeChild(child);
    wrapper.addChild(child);
  }
  sceneIn.addChild(wrapper);
  // Textures to WebP, in place.
  for (const tex of root.listTextures()) {
    const image = tex.getImage();
    if (!image) continue;
    const webp = await sharp(Buffer.from(image))
      .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer();
    tex.setImage(webp).setMimeType('image/webp');
  }
  for (const m of root.listMaterials()) m.setMetallicFactor(0).setRoughnessFactor(0.85);
  // What the dropped nodes left behind: meshes no node carries, and the
  // accessors and materials only they used. The writer keeps everything in
  // the root's lists, so an orphan is a megabyte of sheep nobody sees.
  for (const mesh of root.listMeshes()) {
    if (!mesh.listParents().some((parent) => parent.propertyType === 'Node')) {
      for (const prim of mesh.listPrimitives()) prim.dispose();
      mesh.dispose();
    }
  }
  for (const acc of root.listAccessors()) if (acc.listParents().every((parent) => parent.propertyType === 'Root')) acc.dispose();
  for (const m of root.listMaterials()) if (m.listParents().every((parent) => parent.propertyType === 'Root')) m.dispose();
  for (const t of root.listTextures()) if (t.listParents().every((parent) => parent.propertyType === 'Root')) t.dispose();
  const path = `${LIFE_DIR}/${spec.name}.glb`;
  await io.write(path, doc);
  const meshes = root.listMeshes().filter((m) => !m.isDisposed());
  const tris = meshes.reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);
  const clips = root.listAnimations().filter((a) => !a.isDisposed()).map((a) => a.getName());
  console.log(`wrote ${path}: ${Math.round(tris)} triangles, ${meshes.length} meshes, dropped ${dropped.size} nodes, clips ${clips.join(' | ')}`);
  life[spec.name] = { clip: spec.clip ?? null, clips, triangles: Math.round(tris), scale: spec.scale };
}

writeFileSync(DATA, `${JSON.stringify({
  triangles: Math.round(triangles),
  parts: Object.fromEntries(built.map((p) => [p.name, {
    size: p.size.map((v) => +v.toFixed(3)),
    triangles: Math.round(p.tris),
  }])),
  turbineHub: hub.map((v) => +v.toFixed(3)),
  life,
}, null, 2)}\n`);
console.log(`wrote ${DATA}`);
