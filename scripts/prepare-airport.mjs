/**
 * Turns two dropped Sketchfab exports into the buildings of Halcyon Field.
 *
 *     npm run prepare:airport
 *
 * The airfield was built out of city chunks: a terminal was a 189 m row of
 * high-street frontage, a hangar was a wide two-storey block, and the control
 * tower was the one city building taller than it was broad. That was the right
 * answer while there were no airport assets; there are now two.
 *
 *   airport.glb                     a GA airfield kit — a control tower, two
 *                                   sizes of hangar, and three blocks, all
 *                                   standing on a 452 m runway plate
 *   airport_terminal_1_south_...    one 273 m terminal concourse, on its own
 *   pushback / airport_cart / bus   three ground vehicles, to drive the apron
 *   qantas_airbus_a330-303          an A330 to stand at the gates
 *   atr_42-600                      a turboprop that flies its own circuit
 *   c-400                           an A400M to stand on the cargo apron
 *   daily_news_hangar_at_zahns_...  a 30 m arched club hangar, signed facade
 *   embraer_phenom_300_...          a business jet, with its airstair
 *   antenna                         a 13.5 m dish on a lattice pedestal
 *   loader_crane_kb-572             a rail-mounted tower crane for the freight
 *                                   yard, rails included
 *   airport_catering_truck          a 9 m catering hi-loader for the apron
 *
 * ## What is taken, and what is not
 *
 * The buildings and the aeroplane, not the ground. The kit's runway plate is 452 m long and ours is 840 m
 * with its own markings, lights and edge paint laid out in `airportConfig`, so
 * importing the plate would mean either a second runway lying across the first
 * or throwing away the one that is correct. The plate is dropped and the kit's
 * buildings are placed on the island's own paving.
 *
 * ## Scale
 *
 * The kit is a general-aviation field and the island's is not: measured, its
 * control tower is 44.8 m, which is right, and its larger hangar is 23 m wide,
 * which is a club hangar rather than somewhere a 747 fits. So each part is
 * scaled to a stated real-world size rather than the file being scaled as a
 * whole — `metres` below is the target for the part's longest horizontal axis,
 * and `null` means the part already measures up and is left alone.
 *
 * ## What comes out
 *
 *   public/models/airport.glb         one mesh per part, Draco-compressed
 *   src/config/airportModelData.json  each part's measured footprint, which is
 *                                     what places it and sizes its collider
 *
 * Every part is centred on its own footprint and grounded at y = 0, so putting
 * one on the island is an (x, z, turn) and nothing else.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const KIT = source('airport.glb');
const TERMINAL = source('airport_terminal_1_south_concourse.glb');
const PUSHBACK = source('pushback.glb');
const CART = source('remastered_airport_cart.glb');
const BUS = source('brisbane_city_scania_l94ub_bus_rhd_free.glb');
const QANTAS = source('qantas_airbus_a330-303.glb');
const ATR = source('atr_42-600.glb');
const C400 = source('c-400.glb');
const CLUB = source('daily_news_hangar_at_zahns_airport.glb');
const JET = source('embraer_phenom_300_private_jet_full_interior.glb');
const ANTENNA = source('antenna.glb');
const CRANE = source('loader_crane_kb-572.glb');
const CATERING = source('airport_catering_truck.glb');
const DST = 'public/models/airport.glb';
const DATA = 'src/config/airportModelData.json';
const TEXTURE_SIZE = 1024;

/**
 * The parts, what they are called here, and how big they should be.
 *
 * `from` is the named node in the source; `metres` is the target size of the
 * part's longest horizontal axis, or null to keep the source's own scale.
 * Everything not listed — the runway plate, and the duplicate copies of the
 * hangars and blocks, which are the same mesh at another position — is left
 * behind: a part wanted twice is placed twice, not imported twice.
 */
/**
 * Metalness and roughness, where the source got them wrong.
 *
 * Every material in the crane file arrives at **metalness 0, roughness 0.82**,
 * which is the Sketchfab default and not a description of anything. Under this
 * scene's sun and environment map that renders painted steel as matte plastic:
 * no sheen on the yellow, no glint off the hook, no wear down the rail head —
 * the textures are good and nothing was catching the light. These are the
 * figures the surfaces actually have, which is the whole of the fix.
 *
 * Keyed on material name and applied only to the parts that ask for a finish,
 * so `Material.017` in some other export cannot pick these up by accident.
 */
const CRANE_FINISH = [
  /*
   * The mast, jib and counterjib.
   *
   * Three numbers and each one was wrong in a different way at first.
   *
   * **Metalness 0.12, not 0.28.** Paint is a dielectric — the steel under it
   * is not what you are looking at. Half-metal greys and flattens the diffuse,
   * so the yellow lost its colour and gained a sheen, which is most of what
   * reads as plastic.
   *
   * **Roughness 0.70, not 0.52.** At 0.52 a broad soft highlight slides over
   * the whole jib as the camera moves; weathered industrial paint scatters.
   *
   * **And a tint.** The atlas's yellow is a bright lemon — what a new toy is
   * painted, not what a crane is.
   *
   * The factor multiplies the texture **in linear space**, which is the part
   * that is not obvious and which made the first attempt do almost nothing:
   * a lemon's blue channel is already near zero, so cutting it 38% changes
   * nothing you can see, and 0.88/0.80/0.62 moved #f5c73a all the way to
   * #e8b42d. Solved backwards from the colour actually wanted instead:
   *
   * A neutral darkening got it to an ochre and still read cold. Holding red up
   * while pulling green and blue down is what turns it: the same amount of
   * light, weighted warm, which is what sun-bleached machine paint does as it
   * chalks and what the rust bleeding out of every joint does to the rest.
   *
   * ```
   *   factor              yellow     steel      rust patch
   *   0.88, 0.80, 0.62    #e8b42d    #878b83    -            barely moved
   *   0.62, 0.56, 0.58    #c6992b    #73767f    #87321f      ochre, but cold
   *   0.70, 0.46, 0.34    #d18c20    #796c63    #8f2d16
   *   0.76, 0.50, 0.35    #d99220    #7e7064    #942f16   <- amber, warm steel
   *   0.82, 0.50, 0.30    #e0921e    #83705d    #9a2f14      getting orange
   * ```
   *
   * The grey steel and the rust patches share this atlas, so both warm with
   * the yellow — which is the right thing to happen to all three on a machine
   * that lives outdoors. Go a row down the table for more orange, a row up
   * for less.
   */
  { match: /^Material\.01[67]$/, metalness: 0.12, roughness: 0.70, tint: [0.76, 0.50, 0.35, 1] },
  // The one untextured part, which arrives near-white. Knocked back to a grey.
  { match: /^Material\.018$/, metalness: 0.15, roughness: 0.68, tint: [0.64, 0.55, 0.47, 1] },
  // The hook block and the trolley — bare machined steel, and the one part of
  // a crane that is genuinely shiny. Left untinted: bare steel is not dusty.
  { match: /^Material\.02[01]$/, metalness: 0.72, roughness: 0.36 },
  // Hoist rope: steel wire, dull and dark.
  { match: /^Material\.019$/, metalness: 0.62, roughness: 0.44 },
  // The rail head, polished by the bogies; the sleepers under it are not.
  { match: /^Material\.015$/, metalness: 0.55, roughness: 0.42, tint: [0.92, 0.84, 0.76, 1] },
  { match: /^Material\.014$/, metalness: 0.05, roughness: 0.92, tint: [0.88, 0.80, 0.72, 1] },
];

const PARTS = [
  // 18.3 x 44.8 x 15.1 as it arrives, and a 45 m control tower is correct.
  { name: 'tower', from: 'Tower_1', source: KIT, metres: null },
  // 23 m wide is a club hangar; 60 m is one an airliner can be towed into.
  { name: 'hangar', from: 'Hanger_2', source: KIT, metres: 60 },
  // Long and narrow: a maintenance shed rather than a hangar, despite the name.
  { name: 'shed', from: 'Hanger_1', source: KIT, metres: 60 },
  // 30 x 28 x 17, and 28 m of height beside a 45 m tower is the right relation.
  { name: 'admin', from: 'Building', source: KIT, metres: null },
  { name: 'freight', from: 'Building_1', source: KIT, metres: 76 },
  { name: 'fire', from: 'Building_2', source: KIT, metres: 43 },
  // The whole concourse, every mesh in the file.
  { name: 'terminal', from: null, source: TERMINAL, metres: 210, dropSlabs: true },
  // NO parked 747 here. The TWA model this once imported has no landing gear —
  // measured, its lowest geometry is its four engine nacelles, at exactly the
  // stations a 747-100's are, with nothing at the nose-gear station or under
  // the wing root. Parked, it rested on its engines. The aeroplanes on the
  // stands are `plane.glb` instead, which `prepare-plane.mjs` splits into
  // body, gear and both positions of the gear doors, and grounds on its tyres.
  // See `AirportIsland`'s `PLANE_MODEL`.
  // --- the ground fleet ---
  //
  // All three are grounded on their lowest point, for the reason the 747 is:
  // the tyres are the lowest thing on a vehicle and there are not many
  // vertices on them, so the floor percentile would bury the wheels.
  //
  // `forward` is which of the model's own axes points the way it drives.
  // Everything downstream assumes +Z, because a yaw of `atan2(dx, dz)` aims an
  // object's +Z along its direction of travel — get it wrong and the vehicle
  // drives sideways, which is a great deal more obvious than a building
  // facing the wrong way.
  { name: 'pushback', from: null, source: PUSHBACK, metres: null, floor: 'min' },
  { name: 'cart', from: null, source: CART, metres: null, floor: 'min' },
  // The Scania is modelled nose at +X: its front door is the foremost of the
  // three and its front axle is at +4.3 against the rear's -3.7.
  { name: 'bus', from: null, source: BUS, metres: null, floor: 'min', forward: 'x' },
  // --- the aeroplanes ---
  //
  // The A330 stands at the gates. Its nose is at +Z already, and it sits on
  // its own gear — but not level: the main bogies reach 0.9 m lower than the
  // nose wheel, so grounded on the lowest point it parks tail-down with the
  // nose wheel in the air. `noseDown` is the pitch that puts all three on the
  // tarmac, measured from the gear rather than guessed.
  { name: 'qantas', from: null, source: QANTAS, metres: null, floor: 'min', levelGear: true },
  // The ATR flies its own circuit. Nose at +X — its nose gear is at x 8.2 and
  // its mains at x -0.9 — so it gets the quarter turn the bus gets. Its two
  // propellers come out as their own meshes, recentred on their hubs, so the
  // game can spin them about Z without a rig.
  // The A400M on the cargo apron. 42.4 x 45.7 m, which is the real aeroplane,
  // and its nose is at +Z like the A330's. No `levelGear` here: all three legs
  // already reach within 0.3 m of each other, so grounding on the lowest point
  // puts every wheel on the tarmac by itself.
  {
    name: 'c400',
    from: null,
    source: C400,
    metres: null,
    floor: 'min',
    /*
     * Four propellers, eight blades each, and they split by NAME.
     *
     * The export numbers the blades `BladeCW` / `BladeCCW` with a suffix, and
     * the numbering runs round one hub before starting the next — CCW 000-007
     * is the outer right, CCW 008-015 the inner left, CW 000-007 the inner
     * right, CW 008-015 the outer left. Clustering on position would have
     * worked too and did not: the blades reach two metres either side of their
     * own hub, so grouping on x splits every propeller in half.
     *
     * `split` recentres each on its own hub and records it, so the game puts
     * the mesh at the hub and spins it about Z — the same three lines the ATR
     * uses, four times over.
     */
    split: [
      { name: 'c400PropOuterR', match: /^BladeCCW(\.00[0-7])?$/ },
      { name: 'c400PropInnerL', match: /^BladeCCW\.0(0[89]|1[0-5])$/ },
      { name: 'c400PropInnerR', match: /^BladeCW(\.00[0-7])?$/ },
      { name: 'c400PropOuterL', match: /^BladeCW\.0(0[89]|1[0-5])$/ },
    ],
  },
  {
    name: 'atr',
    from: null,
    source: ATR,
    metres: null,
    floor: 'min',
    forward: 'x',
    split: [
      { name: 'atrPropLeft', match: /^leftProp/ },
      { name: 'atrPropRight', match: /^rightProp/ },
    ],
  },
  // --- the general-aviation corner, west ---
  //
  // An arched club hangar: a 30.5 m barrel vault 25 m deep, 10.3 m to the
  // crown, and the whole thing is 543 triangles because it is a lofted arch
  // with all its geometry on the two end rings. Left at the scale it arrives
  // at — 30 m of door is what a hangar this shape actually has.
  //
  // It has a FRONT, which is unusual here and worth stating: the +X end wall
  // carries the signed facade — measured, its triangles sample the texture's
  // sign band and its lower panel, where the -X end samples only the plain
  // corrugated sheet. So `turn` has to aim +X at the apron and the config
  // says so, or the field gets a hangar showing it its back.
  { name: 'clubHangar', from: null, source: CLUB, metres: null },
  // The business jet that stands in front of it.
  //
  // Nose at MINUS X — the T-tail is at the +X end, at x 47.4 to 49.2 against
  // a 30.1 to 49.6 model, and the rear-fuselage engines are at 40.9 to 43.7.
  // So this is the one part here that needs `forward` the other way about;
  // `x` would park it tail-first at the hangar door.
  //
  // Scaled by LENGTH. The model's proportions disagree with the real Phenom
  // 300's about which axis is oversized — its tailplane measures 6.96 m
  // against a real 6.9, its span 18.57 against a real 16.2 — and length is
  // the dimension an aeroplane is judged by, so 15.9 m it is. The span comes
  // out 15.1 rather than 16.2, which is a metre nobody standing on an apron
  // has ever noticed.
  //
  // Grounded on `min` because everything that touches the tarmac — the three
  // tyres and the airstair's feet — bottoms out within 8 mm of each other,
  // and within 45 mm of the floor percentile. No `levelGear`: it already sits
  // level, unlike the A330.
  {
    name: 'jet',
    from: null,
    source: JET,
    metres: 15.9,
    floor: 'min',
    forward: '-x',
    hollow: true,
  },
  // The dish, on the grass by the offices. 13.5 m across on a 9.5 m lattice
  // pedestal, 17.6 m to the top, which is a real airport's surveillance
  // antenna and needs no scaling.
  { name: 'antenna', from: null, source: ANTENNA, metres: null },
  // --- the freight yard ---
  //
  // A KB-572: a rail-mounted tower crane, 35 m to the top of the mast with a
  // 65 m jib, and it brings its own 42 m of track. Left at the size it
  // arrives at, because those are the real machine's figures — this is the
  // one part here where `metres` would be picking a number over a measurement.
  //
  // Grounded on `min` for the reason the vehicles are: it arrives floating
  // 1.81 m, and the lowest thing on it is the rails, which have few enough
  // vertices that the floor percentile would sink them into the apron.
  {
    name: 'crane',
    from: null,
    source: CRANE,
    metres: null,
    floor: 'min',
    // 42 m of modelled track laid five times: 210 m of rail, centred on the
    // crane so it stands in the middle of its own run rather than at one end.
    repeat: [{ match: /^tracks/, axis: 'z', times: 3 }],
    finish: CRANE_FINISH,
  },
  // The catering hi-loader. 2.75 x 3.42 x 9.13 m as it arrives, which is a
  // real catering truck, and it is already grounded on its tyres with its
  // nose at +Z — the front axle is at z 1.34 and the twin rear at -2.87 — so
  // it needs neither scaling nor a `forward`.
  {
    name: 'cateringTruck',
    from: null,
    source: CATERING,
    metres: null,
    floor: 'min',
    // Nose at MINUS Z — read off the part names, not the wheelbase: `Cabin`
    // is at z -4.12..-2.62 and the container body at -2.36..+4.15. The axle
    // overhangs suggested the same thing and I read them the other way round,
    // which put it on the apron in reverse.
    forward: '-z',
  },
];

/**
 * Where a part's floor actually is.
 *
 * NOT its lowest vertex. The terminal has exactly one vertex at the bottom of
 * its bounding box and the next 1,520 are 1.3 m higher, so grounding on the
 * minimum hung the whole concourse 1.3 m in the air on pillars that reached
 * for a floor they never touched. A low percentile ignores the stray and finds
 * the real base: the control tower, which genuinely has 43 vertices on its
 * slab, is unmoved by it.
 */
const FLOOR_PERCENTILE = 0.003;
const groundOf = (prims, how) => {
  const ys = [];
  for (const p of prims) for (let i = 1; i < p.pos.length; i += 3) ys.push(p.pos[i]);
  ys.sort((a, b) => a - b);
  if (how === 'min') return ys[0];
  return ys[Math.min(ys.length - 1, Math.floor(ys.length * FLOOR_PERCENTILE))];
};

/**
 * Flat slabs of a handful of triangles, dropped.
 *
 * The terminal export carries its own apron under it — big four-triangle
 * quads sitting at ground level, which is exactly where the island's paving
 * already is. Two coplanar surfaces 60 mm apart is a z-fight across the whole
 * forecourt, so anything low, flat and trivially cheap goes.
 */
const isGroundSlab = (tris, height) => tris <= 64 && height < 8;

/**
 * The cabin of an aeroplane sold with a full interior, which nobody will see.
 *
 * The Phenom is 78,769 triangles and 41,151 of them are furniture: five seat
 * buckets at 1,521 each, their armrests, footrests and side covers, two
 * pillows, and one 12,800-triangle carpet. All of it is behind a fuselage
 * skin, on an aeroplane parked on an apron you drive past. It is half the
 * model for nothing.
 *
 * A primitive goes if its bounding box lies ENTIRELY inside the cabin — a box
 * stated as fractions of the part's own bounds, in the frame after `forward`
 * has swung the nose to +Z, so it travels with the model rather than being a
 * set of coordinates out of one particular export. Entirely inside, because
 * anything that reaches out of the tube is skin, glazing or structure: the
 * fuselage itself runs the whole length, the wing spar crosses the full span,
 * and both survive this where a centre-of-mass test would eat them.
 *
 * The numbers are measured, not guessed. Aft limit 0.58 stops ahead of the
 * engine pylons at 0.62; the half-width 0.06 of the span is the 1.1 m cabin
 * against a 18.6 m span; the floor and ceiling are the cabin's own. Checked
 * both ways round: what it drops is furniture, and what it keeps includes the
 * skin, the wings, the nacelles, the tail caps and the airstair.
 */
const CABIN = { fromNose: 0.10, toNose: 0.58, halfWidth: 0.06, floor: 0.20, ceiling: 0.55 };

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

const boundsOf = (arrays) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of arrays) for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]);
    max[k] = Math.max(max[k], p[i + k]);
  }
  return { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) };
};

/**
 * Which part of the kit a mesh belongs to.
 *
 * A Sketchfab FBX export names the mesh node after both the part and its
 * material — `Tower_1_Airplane_buildings___Copy_0` — so the mesh's own name is
 * one level too deep, and matching it by prefix would fold `Hanger_1__1_` into
 * `Hanger_1`. The part node is its parent, every time:
 *
 *     Sketchfab_model > Airport.fbx > RootNode > Airport > Tower_1 > Tower_1_…_0
 */
const named = (node) => node.getParentNode()?.getName() || node.getName();

/** Every primitive of a source, baked into world space and tagged by owner. */
const readSource = async (path) => {
  const doc = await io.read(path);
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    const owner = named(node);
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
      out.push({
        owner,
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
  return out;
};

const sources = new Map();
for (const path of [...new Set(PARTS.map((p) => p.source))]) {
  sources.set(path, await readSource(path));
  console.log(`read ${path}: ${sources.get(path).length} primitives`);
}

/* ------------------------------------------ frame each part in its own right */

const built = [];
for (const spec of PARTS) {
  let prims = sources.get(spec.source)
    .filter((p) => (spec.from === null ? true : p.owner === spec.from));
  if (!prims.length) throw new Error(`no geometry for ${spec.name} (looked for "${spec.from}")`);

  // Only where it is asked for. The rule — cheap and flat — was written for
  // the terminal's own apron quads, and on an aeroplane 7.7 m tall it matched
  // fifty-one parts: doors, wipers, aerials, every small detail on the ATR.
  const dropped = spec.dropSlabs ? prims.filter((p) => {
    const b = boundsOf([p.pos]);
    return isGroundSlab(p.idx.length / 3, b.size[1]);
  }) : [];
  if (dropped.length) {
    prims = prims.filter((p) => !dropped.includes(p));
    console.log(`  ${spec.name}: dropped ${dropped.length} flat slab(s), `
      + `${dropped.reduce((n, p) => n + p.idx.length / 3, 0)} tris`);
  }

  // Turned to face +Z first, so every measurement after this is of the part as
  // the game will see it.
  //
  // A quarter turn either way: `x` swings the model's +X round to +Z, `-x`
  // swings its -X there. Both are needed because which end of its own X a
  // model calls the nose is the modeller's choice and not a convention — the
  // Scania and the ATR face +X, the Phenom faces -X.
  /*
   * A half turn, for a model built nose-at-minus-Z.
   *
   * The catering truck is the one: its `Cabin` sits at z -4.12..-2.62 and the
   * container body it carries at -2.36..+4.15, so its nose is at -Z while the
   * yaw everything downstream applies — `atan2(dx, dz)` — aims +Z along the
   * direction of travel. Left alone it drove the apron backwards, cab last,
   * which is a great deal more obvious than a building facing the wrong way.
   */
  if (spec.forward === '-z') {
    const spin = (a) => {
      for (let i = 0; i < a.length; i += 3) {
        a[i] = -a[i];
        a[i + 2] = -a[i + 2];
      }
    };
    for (const prim of prims) {
      spin(prim.pos);
      spin(prim.nrm);
    }
  }
  if (spec.forward === 'x' || spec.forward === '-x') {
    const sign = spec.forward === 'x' ? 1 : -1;
    const swing = (a) => {
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i];
        a[i] = -sign * a[i + 2];
        a[i + 2] = sign * x;
      }
    };
    for (const prim of prims) {
      swing(prim.pos);
      swing(prim.nrm);
    }
  }

  // Gut the cabin, now the nose is at +Z and the box below means something.
  if (spec.hollow) {
    const b = boundsOf(prims.map((p) => p.pos));
    const box = {
      x: [b.centre[0] - b.size[0] * CABIN.halfWidth, b.centre[0] + b.size[0] * CABIN.halfWidth],
      y: [b.min[1] + b.size[1] * CABIN.floor, b.min[1] + b.size[1] * CABIN.ceiling],
      // Measured back from the nose, which is +Z by the time we get here.
      z: [b.max[2] - b.size[2] * CABIN.toNose, b.max[2] - b.size[2] * CABIN.fromNose],
    };
    const inside = (p) => {
      const q = boundsOf([p.pos]);
      return q.min[0] >= box.x[0] && q.max[0] <= box.x[1]
        && q.min[1] >= box.y[0] && q.max[1] <= box.y[1]
        && q.min[2] >= box.z[0] && q.max[2] <= box.z[1];
    };
    const gutted = prims.filter(inside);
    if (gutted.length) {
      prims = prims.filter((p) => !gutted.includes(p));
      console.log(`  ${spec.name}: gutted the cabin, ${gutted.length} parts and `
        + `${Math.round(gutted.reduce((n, p) => n + p.idx.length / 3, 0))} tris`);
    }
  }

  /**
   * Pitch the part so every leg of its gear reaches the ground.
   *
   * The A330 is modelled with its main bogies 0.9 m below its nose wheel, so
   * grounded on the lowest point it stands tail-down with the nose in the air.
   * The angle is measured — lowest point near the nose against lowest point
   * near the mains, over the distance between them — not picked by eye.
   */
  if (spec.levelGear) {
    const lowNear = (from, to) => {
      let best = Infinity;
      for (const prim of prims) {
        for (let i = 0; i < prim.pos.length; i += 3) {
          const z = prim.pos[i + 2];
          if (z >= from && z <= to && prim.pos[i + 1] < best) best = prim.pos[i + 1];
        }
      }
      return best;
    };
    const span = boundsOf(prims.map((p) => p.pos));
    const noseZ = span.max[2] * 0.55;
    const mainZ = span.min[2] * 0.35;
    const nose = lowNear(noseZ, span.max[2]);
    const main = lowNear(span.min[2], mainZ);
    const arm = (noseZ + span.max[2]) / 2 - (span.min[2] + mainZ) / 2;
    const tilt = arm > 1 ? Math.atan2(nose - main, arm) : 0;
    if (Math.abs(tilt) > 0.002) {
      const c = Math.cos(-tilt);
      const sn = Math.sin(-tilt);
      for (const prim of prims) {
        for (let i = 0; i < prim.pos.length; i += 3) {
          const y = prim.pos[i + 1];
          const z = prim.pos[i + 2];
          prim.pos[i + 1] = y * c - z * sn;
          prim.pos[i + 2] = y * sn + z * c;
        }
        for (let i = 0; i < prim.nrm.length; i += 3) {
          const y = prim.nrm[i + 1];
          const z = prim.nrm[i + 2];
          prim.nrm[i + 1] = y * c - z * sn;
          prim.nrm[i + 2] = y * sn + z * c;
        }
      }
      console.log(`  ${spec.name}: levelled by ${(tilt * 180 / Math.PI).toFixed(2)} degrees `
        + `(nose gear was ${(nose - main).toFixed(2)} m high)`);
    }
  }

  /*
   * Tile a sub-part along its own length — the crane's rails.
   *
   * A rail-mounted crane arrives with the track the artist modelled, which
   * here is 42 m: enough to stand the crane on and not enough to read as a
   * crane that TRAVELS. Stretching it was the obvious fix and the wrong one —
   * the track is sleepers and fishplates at a fixed pitch, and scaling it
   * along its length smears all of them. Repeating it is what rail actually
   * is: the same panel laid end to end.
   *
   * Laid symmetrically about the run's own centre, so the crane stays where
   * it stands on the track instead of ending up at one end of it.
   */
  for (const rule of spec.repeat ?? []) {
    const mine = prims.filter((p) => rule.match.test(p.owner));
    if (!mine.length) throw new Error(`no geometry to repeat for ${rule.match}`);
    const axis = { x: 0, y: 1, z: 2 }[rule.axis ?? 'z'];
    const len = boundsOf(mine.map((p) => p.pos)).size[axis];
    const added = [];
    for (let k = 1; k < rule.times; k++) {
      for (const side of [-1, 1]) {
        const shift = side * k * len;
        for (const prim of mine) {
          const pos = Float32Array.from(prim.pos);
          for (let i = axis; i < pos.length; i += 3) pos[i] += shift;
          added.push({ ...prim, pos, nrm: Float32Array.from(prim.nrm), idx: prim.idx.slice() });
        }
      }
    }
    prims = prims.concat(added);
    const runs = rule.times * 2 - 1;
    console.log(`  ${spec.name}: ${rule.axis ?? 'z'} run tiled ${runs} x ${len.toFixed(1)} m `
      + `= ${(runs * len).toFixed(1)} m`);
  }

  const whole = boundsOf(prims.map((p) => p.pos));
  const scale = spec.metres ? spec.metres / Math.max(whole.size[0], whole.size[2]) : 1;
  const floor = groundOf(prims, spec.floor);
  if (floor > whole.min[1] + 0.01) {
    console.log(`  ${spec.name}: floor at ${floor.toFixed(2)} m, `
      + `${(floor - whole.min[1]).toFixed(2)} m above the lowest stray vertex`);
  }
  // Centred on its footprint and standing on y = 0: placing it is then an
  // (x, z, turn) and the collider is half its measured size.
  for (const prim of prims) {
    for (let i = 0; i < prim.pos.length; i += 3) {
      prim.pos[i] = (prim.pos[i] - whole.centre[0]) * scale;
      prim.pos[i + 1] = (prim.pos[i + 1] - floor) * scale;
      prim.pos[i + 2] = (prim.pos[i + 2] - whole.centre[2]) * scale;
    }
  }
  // Split off any sub-parts that have to move on their own — the propellers.
  // Each is recentred on its own hub and the hub is written to the data file,
  // so the game positions the mesh at the hub and spins it about Z.
  const spun = [];
  for (const rule of spec.split ?? []) {
    const mine = prims.filter((p) => rule.match.test(p.owner));
    if (!mine.length) throw new Error(`no geometry for ${rule.name}`);
    prims = prims.filter((p) => !mine.includes(p));
    const b = boundsOf(mine.map((p) => p.pos));
    const hub = [b.centre[0], b.centre[1], b.centre[2]];
    for (const prim of mine) {
      for (let i = 0; i < prim.pos.length; i += 3) {
        prim.pos[i] -= hub[0];
        prim.pos[i + 1] -= hub[1];
        prim.pos[i + 2] -= hub[2];
      }
    }
    spun.push({ name: rule.name, prims: mine, hub, size: b.size });
    console.log(`  ${rule.name}: hub at ${hub.map((v) => v.toFixed(2)).join(', ')}, `
      + `${b.size[0].toFixed(2)} m across`);
  }

  const framed = boundsOf(prims.map((p) => p.pos));
  // Height above the floor, not the bounding box's: the stray vertex the floor
  // percentile ignored is now a metre BELOW ground, and taking the box would
  // hand the game a collider a metre too tall and half a metre too low.
  framed.size[1] = framed.max[1];
  const tris = prims.reduce((n, p) => n + p.idx.length / 3, 0);
  console.log(`  ${spec.name.padEnd(9)} ${framed.size.map((v) => v.toFixed(1)).join(' x ').padEnd(22)}`
    + ` m  scale ${scale.toFixed(3)}  ${String(Math.round(tris)).padStart(5)} tris`);
  built.push({ name: spec.name, prims, size: framed.size, tris, spun, finish: spec.finish });
  for (const part of spun) {
    // The hub is in the frame BEFORE centring and grounding, so it moves with
    // everything else.
    const b = boundsOf(part.prims.map((p) => p.pos));
    built.push({
      name: part.name,
      prims: part.prims,
      finish: spec.finish,
      size: b.size,
      tris: part.prims.reduce((n, p) => n + p.idx.length / 3, 0),
      // Already in the finished frame: the split runs AFTER the centring and
      // grounding above, so the hub comes out of framed geometry. Transforming
      // it a second time put the ATR's propellers 3 m too high and 6 m too far
      // forward, which is a nice illustration of why this comment is here.
      hub: part.hub,
    });
  }
}

/* ------------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('airport');

const textures = new Map();
const convertTexture = async (src) => {
  const image = src?.getImage();
  if (!image) return null;
  if (textures.has(image)) return textures.get(image);
  const webp = await sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  textures.set(image, tex);
  return tex;
};
const materials = new Map();
const convertMaterial = async (src, finish) => {
  const rule = finish?.find((f) => f.match.test(src?.getName() ?? ''));
  const key = rule ? `${src?.getName()}|${rule.metalness}|${rule.tint ?? ''}` : src;
  if (materials.has(key)) return materials.get(key);
  const m = out.createMaterial(src?.getName() || 'airport')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(rule ? rule.metalness : (src?.getMetallicFactor() ?? 0.1))
    .setRoughnessFactor(rule ? rule.roughness : (src?.getRoughnessFactor() ?? 0.85))
    .setDoubleSided(true)
    // OPAQUE throughout. The concourse marks its glazing BLEND, and a
    // transparent wall on a building this size sorts against the aeroplane
    // behind it — which is the one thing it is there to be seen in front of.
    .setAlphaMode('OPAQUE');
  // Base colour, from wherever this material keeps it.
  //
  // The Scania is authored in KHR_materials_pbrSpecularGlossiness, where the
  // colour is the extension's DIFFUSE texture and `baseColorTexture` is empty.
  // Reading only the latter is how a bus with a full livery came out pure
  // white — a material that says nothing is a white material.
  const spec = src?.getExtension('KHR_materials_pbrSpecularGlossiness');
  const diffuse = spec?.getDiffuseTexture?.() ?? null;
  const tex = await convertTexture(diffuse ?? src?.getBaseColorTexture());
  if (tex) m.setBaseColorTexture(tex);
  const factor = spec?.getDiffuseFactor?.();
  if (!tex && factor) m.setBaseColorFactor(factor);
  // The tint LAST, so it multiplies whatever colour the source settled on
  // rather than being overwritten by it.
  if (rule?.tint) m.setBaseColorFactor(rule.tint);
  materials.set(key, m);
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
    prim.setMaterial(await convertMaterial(p.material, part.finish));
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
    ...(p.hub ? { hub: p.hub.map((v) => +v.toFixed(3)) } : {}),
  }])),
}, null, 2)}\n`);
console.log(`wrote ${DST} and ${DATA}: ${Math.round(triangles)} triangles in ${built.length} parts, `
  + `${textures.size} textures`);
