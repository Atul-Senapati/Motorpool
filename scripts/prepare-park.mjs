/**
 * Halcyon Pier: the rides, out of two Sketchfab exports and into one file.
 *
 * `roller_coaster.glb` is 24.5 MB and 760,000 triangles, of which 708,000 are
 * the track alone — more geometry in one ride than in the whole airport, the
 * city's vehicles and both aeroplanes put together. It cannot ship as it
 * arrives, and the interesting part is that it does not need to: a coaster
 * track is a swept tube, and a swept tube is the single most over-tessellated
 * thing a modelling package produces. Decimated to a twentieth it is the same
 * ride at the distance anybody sees it from.
 *
 * `amusement_park_game_attractions_pack.glb` is the opposite problem. It is
 * cheap (80,000 triangles), already at real-world scale — a 43 m wheel, a 30 m
 * drop tower, an 18 m swing carousel — and it is a laid-out *scene* rather
 * than a kit, with the rides scattered across 174 m of ground. Two of them are
 * also split: a static structure, plus a SKINNED mesh sitting in bind pose
 * somewhere else entirely. The ferris wheel's rim is a flat ring 43 m across
 * lying in the XZ plane at y 22, forty-four metres behind its own towers.
 *
 * So this script does four things the airport's does not:
 *
 *   `owners`   — several source nodes gathered into one part, because a ride
 *                here is a structure node plus its decals plus its logo.
 *   `simplify` — meshopt decimation, for the track and nothing else.
 *   `pitch`    — a quarter turn about X, which stands the ferris wheel up.
 *   `hub`      — centre the part on its own middle and record nothing else,
 *                for the pieces the game positions and spins itself.
 *
 * Everything else — world-matrix baking, per-part scaling to a stated size,
 * the floor percentile, WebP textures, Draco — is the airport's pipeline and
 * is here for the same reasons, which `prepare-airport.mjs` explains at length.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const COASTER = source('roller_coaster.glb');
const PACK = source('amusement_park_game_attractions_pack.glb');
const CIRCUS = source('circus_tent.glb');
const PLAYGROUND = source('playground.glb');
const CANDY = source('cotton_candy_stall.glb');
/* Radiator Springs, the rest of it: three more of the cast and the trophy. */
const CHICK = source('chick_hicks.glb');
const SARGE = source('sarge.glb');
const LUIGI = source('luigi.glb');
const GUIDO = source('guido.glb');
const CUP = source('piston_cup.glb');
const FILLMORE = source('fillmore.glb');
const SALLY = source('sally_carrera.glb');
const SHERIFF = source('sherrif.glb');
const GIOVANNI = source('giovanni.glb');
/* And two more rides. */
const BOUNCE = source('bounce_house.glb');
const SWANS = source('lunapark_-_swans_-_roundabout_-_animated.glb');
/**
 * The city, for the park kit: benches, planters, trees and an arcade.
 *
 * Halcyon Pier had rides and nothing between them. What a park is made of is
 * the stuff BETWEEN the rides — a bench you could sit on, a tree you walk
 * under, a hedge that stops a path going nowhere — and the city map already
 * has all of it, modelled at the same scale and lit by the same sun, in three
 * groups the map calls `BigPark`, `Coast > Park` and `Coast > Park Comercial`.
 *
 * Taken ONE AT A TIME rather than as chunks. `cityChunks` lifts whole
 * 250 m cells out of the processed city and stamps them down, which is right
 * for a row of buildings and wrong for planting: a park wants this tree here
 * and that bench there, and a cell is a hundred things welded together. So
 * these come out of the raw map as single objects, recentred and grounded,
 * and the park places them one by one.
 */
const CITY = source('drive_for_speed_-_map.glb');
/**
 * The map is authored in FBX centimetres and scaled by 0.01 at its root, so
 * its world units are hundreds of metres — the whole city measures 55 across.
 * `prepare-map.mjs` calls the same number `UNIT_SCALE` and recovers real scale
 * with it; a bench read without it comes out 2 cm long.
 */
const CITY_UNITS = 100;
const DST = 'public/models/park.glb';
const DATA = 'src/config/parkModelData.json';
const TEXTURE_SIZE = 1024;

/**
 * The parts, what they are called here, and how big they should be.
 *
 * `metres` is the target size of the longest HORIZONTAL axis, or null to keep
 * the source's own scale. The attractions pack is already in metres and is
 * left alone; the coaster arrives half a unit across and is told what it is.
 */
const PARTS = [
  /*
   * The coaster, whole. Its own ground plate goes — the park lays its own
   * paving and two coplanar surfaces is a z-fight across the whole ride — and
   * the three cars stay, because a coaster with trains standing on it reads as
   * a coaster and an empty track reads as scaffolding.
   *
   * But the plate cannot just be deleted, because it is what the ride STANDS
   * ON, and it is not thin: 11.24 m thick at this scale. Measured, the support
   * feet come in two families — a few founded near the plate's underside at
   * 1.06 m, and the bulk of them sitting on its top surface at 11.5 — so
   * dropping the plate and grounding the ride on its own lowest vertex put
   * every support of the second kind eleven metres in the air. `floorFrom`
   * takes the datum from the plate's top instead: the supports that stood on
   * it stand on the park's paving, and the handful that ran down through it
   * are buried, which is invisible and which is where they always were.
   *
   * 100 m across is a mid-size steel coaster and puts the lift hill at 43 m,
   * which is the right relation: tall enough to see from the bridge, short
   * enough not to argue with the 45 m control tower across the island.
   */
  {
    name: 'coaster',
    source: COASTER,
    metres: 100,
    exclude: ['Box001'],
    // Grounded on the TOP of the plate it was modelled standing on, not on
    // its own lowest vertex. See `floorFrom`.
    floorFrom: 'Box001',
    // The three cart trains come out as their own parts and are driven by the
    // model's own 45-second clip. See `sampleTrains`.
    trains: ['Dummy008', 'Dummy009', 'Dummy010'],
    // The track is 708k triangles of swept tube, and it comes down to 76k.
    // Nothing else in the file is simplified: the supports, the station and
    // the cars are already cheap, and they are what you get close to from the
    // path underneath.
    simplify: { '1A_track': 0.06 },
  },

  /* ----------------------------------------------- the attractions pack */

  // The ferris wheel's A-frame and its deck. 39.8 x 29.2 m as it arrives.
  { name: 'wheelBase', source: PACK, from: 'panel_1.001', metres: null, axle: true },
  /*
   * The wheel itself: rim, spokes and cabins, and a skinned mesh, which is why
   * it is 44 m from its own towers and lying on its side. Skinned geometry is
   * authored in bind space and posed by joints, so its node transform means
   * nothing and its bind pose is wherever the rigger left it.
   *
   * `pitch` stands it up and `hub` centres it on itself. After that the game
   * puts it at a position and turns it about Z, which is all a ferris wheel
   * has ever done.
   */
  {
    name: 'wheel',
    source: PACK,
    from: 'Object_8',
    metres: null,
    pitch: true,
    hub: true,
    // Rim and sixteen cabins, split apart so the cabins can hang. See `explode`.
    explode: { rim: 'wheelRim', cabin: 'wheelCabin', big: 20, cluster: 3 },
  },

  // The drop tower, 30.5 m, and its gondola — also skinned, also adrift.
  // `axle` here is the mast's own centreline, measured off the top of the
  // tower — the gondola has to ride THAT, not the middle of a bounding box
  // that includes the wider platform at the bottom.
  { name: 'dropTower', source: PACK, from: 'panel_1.002', metres: null, axle: true, deck: true },
  { name: 'dropCar', source: PACK, from: 'Object_111', metres: null, hub: true },

  // The swing carousel, complete and in one piece. Spun about Y by the game.
  /*
   * The swing carousel, in two pieces — and it has to be two.
   *
   * Turning the whole ride about Y turned its foundation with it: the base,
   * its steps and the ground plate all spun, which is not a thing a fairground
   * ride does. The source has the split already, by material: `build_gen_2` is
   * the low base and `build_gen_1` is the mast, the canopy and the swings.
   */
  {
    name: 'swings',
    source: PACK,
    from: 'flying_swings',
    metres: null,
    byMaterial: { build_gen_2: 'swingsBase', '*': 'swingsTop' },
  },

  // The pavilion the bumper cars live under, and two of the cars.
  // `deck` is the arena floor, 2.25 m up on its platform — see the option.
  { name: 'pavilion', source: PACK, from: 'panel_1.005', metres: null, deck: true },
  /*
   * Two bumper cars, and both come with a 7.3 m spike.
   *
   * Nine tenths of each car's vertices are below 2.55 m and the last tenth is
   * a single thin mast — the contact pole for an electrified ceiling that this
   * pavilion does not have, reaching halfway up a building it never touches.
   * `clipAbove` drops any triangle entirely above the line, which leaves the
   * car and takes the mast.
   */
  { name: 'bumperA', source: PACK, from: 'bumpercar', metres: null, floor: 'min', clipAbove: 3.0 },
  { name: 'bumperB', source: PACK, from: 'bumpercar.001', metres: null, floor: 'min', clipAbove: 3.0 },

  /* ------------------------------------------------------ the park kit ----
   *
   * Single objects out of the city map, by name and instance — see
   * `readPicks`. All grounded on their lowest point rather than the floor
   * percentile: a tree's lowest geometry is the few vertices where its trunk
   * meets the soil, and a percentile that ignores strays would bury it.
   *
   * `metres` is stated on every one, because the map's copies of a prop are
   * scaled differently — `Tree_17` appears at both 4.4 m across and 8.7 — so
   * the instance index alone does not settle how big a thing comes out. It is
   * the longest HORIZONTAL axis, so for a tree it is the canopy.
   */
  { name: 'bench', source: CITY, pick: 'Module_Bench_23', metres: 2.1, floor: 'min' },
  { name: 'benchSlat', source: CITY, pick: 'Module_Bench_24', metres: 2.6, floor: 'min' },
  { name: 'planter', source: CITY, pick: 'Module_Treepot_07', metres: 4.5, floor: 'min' },
  // Four trees and two shrubs, which is enough to plant a park without any
  // two neighbours being the same object twice over.
  { name: 'treeSlim', source: CITY, pick: 'Tree_02', metres: 4.4, floor: 'min' },
  { name: 'treeBroad', source: CITY, pick: 'Tree_11', metres: 8.1, floor: 'min' },
  { name: 'treeTall', source: CITY, pick: 'Tree_17', metres: 6.6, floor: 'min' },
  { name: 'treeBig', source: CITY, pick: 'Tree_06', metres: 10.6, floor: 'min' },
  { name: 'bush', source: CITY, pick: 'Bush_05', metres: 2.8, floor: 'min' },
  { name: 'bushLow', source: CITY, pick: 'Bush_03', metres: 2.3, floor: 'min' },
  /*
   * The arcade, out of `Park Comercial`.
   *
   * A commercial unit and not a house, which is the distinction that matters
   * here: the park's last building was a terrace of city shopfronts and read
   * as a street that had wandered in. This is a 31 m single-storey retail
   * block of the kind a fairground's food hall and amusement arcade actually
   * occupy, and it stands on the parade walk, which until now fronted nothing.
   */
  { name: 'arcade', source: CITY, pick: 'Commerce_Center_12', metres: 31.4, floor: 'min' },
  // Its two sisters, so the park's shops are not one building three times.
  // The map has `Commerce_Center_11`, `_12` and `_13`, all 31.4 m units of
  // the same block with different frontages.
  { name: 'shopA', source: CITY, pick: 'Commerce_Center_11', metres: 31.4, floor: 'min' },
  { name: 'shopB', source: CITY, pick: 'Commerce_Center_13', metres: 31.4, floor: 'min' },

  /* --------------------------------------------------------- the water --
   *
   * No lawn tile here any more. The city atlas's grass was instanced across
   * the park's open ground on an 8 m grid and it was not wanted: a tiled
   * swatch at that size reads as a grid of squares rather than as a lawn.
   * The park stands on the island's own crown again.
   */
  /*
   * The water: one flat surface out of a city block that has a pond on it.
   *
   * `E04.block aux.001` and not `E04.block aux` — the map suffixes its
   * duplicates, and the copy carrying the water is the .001. The material
   * filter is what keeps the block's buildings out of it, since the pond and
   * the terrace round it hang off the same node.
   *
   * 17.2 m, which is the pond's own size. The map has a bigger one — the
   * 56 x 57 m lake under `Park_City.001` — and a lake that size in a site
   * 160 m across would be the park rather than a feature in it.
   */
  {
    name: 'pond',
    source: CITY,
    pick: 'E04.block aux.001',
    onlyMaterial: 'WaterBasicNighttime',
    metres: 17.2,
    floor: 'min',
  },

  /* ------------------------------------------------------ more furniture --
   *
   * A park is bins and lamps and somewhere to shelter, and the pier had none
   * of them. All four are city street furniture at city scale.
   */
  { name: 'bin', source: CITY, pick: 'Tacho Variant', metres: 0.7, floor: 'min' },
  { name: 'shelter', source: CITY, pick: 'BusStop_01', metres: 4.9, floor: 'min' },
  { name: 'sign', source: CITY, pick: 'Cartel_02 Variant', metres: 0.8, floor: 'min' },
  { name: 'lamp', source: CITY, pick: 'Accessory_20', metres: 0.6, floor: 'min' },
  /*
   * The ice cart: a 2 m barrow under a striped awning.
   *
   * Found by its paint rather than its name — the map calls it
   * `Accessory_25`, which says nothing, but it is one of only two objects in
   * the city whose UVs reach the orange-and-white striped panel in the
   * `Accesories` atlas, and the other is a 0.6 m parasol on its own.
   */
  { name: 'iceCart', source: CITY, pick: 'Accessory_25', metres: 2.2, floor: 'min' },
  /*
   * Two more off the mainland, for the small stuff a midway is actually made
   * of. `Accessory_22` is the other object in the city that reaches the
   * striped panel in the `Accesories` atlas — a 2 m stall under an awning,
   * the ice cart's smaller cousin — and `Barrera_01` is the crowd barrier
   * every queue in the world is penned in with.
   */
  { name: 'stall', source: CITY, pick: 'Accessory_22', metres: 1.0, floor: 'min' },
  { name: 'barrier', source: CITY, pick: 'Barrera_01', metres: 1.9, floor: 'min' },

  /* ------------------------------------------------- two more attractions --
   *
   * Both arrive in their own units rather than metres — the tent measures
   * 0.077 across and the playground 2.0 — so both are told what they are.
   *
   * The big top at 32 m stands 24 m to its peak, which is between the swing
   * carousel and the 30 m drop tower: tall enough to be the thing you see
   * over the hedge from the road, short enough that it does not argue with
   * the coaster's lift hill.
   */
  { name: 'circus', source: CIRCUS, metres: 32, floor: 'min' },
  // 24 m of climbing frame, which is a big municipal playground rather than
  // three swings, and that is what the east lawn had room for.
  { name: 'playground', source: PLAYGROUND, metres: 24, floor: 'min' },

  /*
   * The cotton candy stall, which arrives as its own file and needs none of
   * the machinery above: no owner to pick out, nothing to decimate, nothing
   * lying on its side. `from` is omitted, so the whole file is the part.
   *
   * 3.6 m is the target for its longest HORIZONTAL axis, which makes it 2.6 m
   * tall and 2.0 deep. That is sized against `iceCart`, the only other thing
   * of its kind here at 2.0 x 2.2 — a stall you walk up to should be a little
   * bigger than a cart somebody wheels, and both should be small enough that
   * the rides still own the skyline.
   */
  { name: 'candyStall', source: CANDY, metres: 3.6 },

  /* ------------------------------------------------- the rest of the cast */
  /*
   * The cars that stand still, sized to what they are rather than to each
   * other: a Piston Cup stock car is five metres, a Fiat 500 is three metres
   * of nothing, and Guido is a forklift you could step over. The comedy is in
   * the difference, so the difference is measured.
   *
   * `metres` is the longest HORIZONTAL axis, which for all three is the
   * length, and each arrives already standing on y = 0.
   */
  /*
   * Chick Hicks stands still, so he is built here; Doc RACES, so he is built
   * by `prepare-garage.mjs` instead.
   *
   * It is not a preference, it is what the two exports allow. Run through the
   * garage pipeline Doc comes back with `Wheel_FL` and friends and Chick comes
   * back "body only" — his wheels are merged into his shell and cannot be
   * separated. A car on the circuit needs wheels that turn; a car watching
   * from the verge does not. So they swapped, and each one lives in exactly
   * one pipeline according to what it does.
   */
  { name: 'chick', source: CHICK, metres: 5.03 },
  // Sarge, for the same reason as Chick: `prepare-garage` reports him "body
  // only", so he stands still and is built here rather than there.
  { name: 'sarge', source: SARGE, metres: 3.35 },
  { name: 'luigi', source: LUIGI, metres: 3.2 },
  { name: 'guido', source: GUIDO, metres: 1.6 },
  /*
   * Fillmore, and he is here rather than in the garage because he is scenery.
   *
   * Chick Hicks went the other way — see `prepare-garage.mjs` — because he
   * races and a racing car needs its wheels named. Fillmore stands beside the
   * track with the others and a parked bus has no use for them.
   */
  { name: 'fillmore', source: FILLMORE, metres: 4.6 },
  /*
   * Sally, who was racing and is now watching.
   *
   * She is the one car in the crowd that `prepare-garage` could have handled —
   * her export has wheel pivots, so she had a seat on the circuit for a while.
   * She is not a racer though, and a Porsche running third in the Piston Cup
   * was the sort of thing you notice. Off the track and onto the verge, which
   * means she is built here, like the rest of the spectators.
   */
  { name: 'sally', source: SALLY, metres: 4.44 },
  /*
   * Sheriff and Giovanni, both scenery and therefore both built here.
   *
   * Neither races, so neither needs `prepare-garage` to find wheel pivots for
   * it — see the note on Fillmore. `metres` is the long dimension after
   * scaling, so the pipeline's printed box is the check: a 1949 Mercury is
   * about 5.4 m and Giovanni is a small city car.
   */
  { name: 'sheriff', source: SHERIFF, metres: 5.4 },
  { name: 'giovanni', source: GIOVANNI, metres: 3.9 },
  /*
   * The Piston Cup, at 3.7 m across and therefore 5 m tall.
   *
   * It is authored 29 m tall and forty metres from its own origin, which is
   * what a trophy modelled as a landmark looks like. Five metres is the size
   * that reads as a trophy on a plinth rather than as a water tower: big
   * enough to be the thing you photograph, small enough that the drop tower is
   * still the tallest thing in the park.
   *
   * Decimated to a quarter. It is a lathe-turned cup and a handle, which is
   * exactly the kind of shape that arrives with forty thousand triangles and
   * needs ten.
   */
  { name: 'pistonCup', source: CUP, metres: 3.7, simplify: 0.25 },

  /* ------------------------------------------------------- two more rides */
  /*
   * The bounce house: 14 m across, which makes it 3.7 m tall and 9 deep.
   *
   * Left whole at 42,000 triangles. An inflatable is all curves and there is
   * nothing in it to take out without it going faceted, and it is the one new
   * ride you stand next to rather than look at from across the park.
   */
  { name: 'bounce', source: BOUNCE, metres: 14 },
  /*
   * The swan roundabout, kept at its own scale and turned by the game.
   *
   * It arrives 24.7 m across and is asked for 18, which is still a carousel and
   * is what fits the one pocket in the south band deep enough to walk round it
   * — the circuit took the 25 m one. See `AT.swans`.
   * It also arrives with a 21-second animation of its arms rising and falling,
   * and that is thrown away here — this pipeline bakes world matrices and
   * merges by material, which flattens any hierarchy an animation needs. What
   * it gets instead is a rotation about Y, which is what every other ride in
   * this park gets and what a carousel has always been.
   *
   * The steps turn with it. On a swan roundabout they do.
   *
   * A fifth of its triangles: 172,000 is more than half of what the whole park
   * costs, for one ride you see from thirty metres away.
   */
  { name: 'swans', source: SWANS, metres: 18, simplify: 0.2 },
];

/**
 * See `prepare-airport.mjs`: the floor is a low percentile, not the minimum.
 *
 * Over the vertices a triangle actually USES, which matters here and not
 * there. `clipAbove` drops triangles and leaves their vertices in the buffer —
 * re-indexing them out would be a second pass for nothing, since Draco drops
 * anything unreferenced on the way out — so a measurement that reads the
 * position array straight through still sees the bumper car's 7.3 m mast after
 * the mast has stopped being drawn. That is how a 2.5 m car gets a collider
 * three times its own height.
 */
/**
 * Repainting the coaster, by material name.
 *
 * It arrived in sky blue and pale yellow, which reads as a toy. What a real
 * steel coaster looks like is white supports, a red running track and a dark
 * spine — the supports recede, the rails are the line your eye follows round
 * the layout, and everything structural between them stays out of the way.
 *
 * The two that are plain colours are simply replaced. The supports are not:
 * they carry a TEXTURE, and that texture is itself cyan. A factor multiplies
 * into a texture, and multiplying cyan by any grey leaves cyan — to neutralise
 * it a factor would have to exceed 1 in red, which glTF does not allow. So the
 * supports are handled by `WASH`, which repaints the pixels instead.
 *
 * Values are LINEAR, which is what glTF stores — the sRGB each one came from
 * is in the comment, because nobody can read linear.
 */
const REPAINT = {
  // The supports' own factor stays neutral; their colour is in the texture,
  // which `WASH` deals with.
  Platform: [1, 1, 1, 1],
  // #b3231d — the running rails, and the one thing here that is a colour.
  Yellow: [0.451, 0.017, 0.012, 1],
  // #45494f — the trim tube, dropped back so the red is the only accent.
  LightBlue: [0.055, 0.062, 0.073, 1],
  /*
   * #5fb6c8 — the pond.
   *
   * The map's `WaterBasicNighttime` has no texture at all and a base colour
   * of [0.70, 0.48, 0.47], which is a pinkish grey: it was a night shader's
   * input rather than a colour anyone was meant to see, and rendered plainly
   * it is a beige puddle in the grass. This is `FOUNTAIN.colours.water`,
   * the blue the park's own fountain already runs, so the two read as the
   * same water rather than as two different accidents.
   */
  WaterBasicNighttime: [0.115, 0.468, 0.578, 1],
};

/**
 * Textures repainted, by material name.
 *
 * Desaturate, then duotone toward a colour. Repainting the pixels is the only
 * way to change the hue of a textured material — see `REPAINT` — and it costs
 * nothing extra here, because every texture already goes through sharp on its
 * way to WebP.
 */
const WASH = {
  /*
   * The attractions pack's two structural materials, which every ride in it
   * is built from — the pavilion's walls, the drop tower's mast and deck, the
   * carousel's base, the wheel's A-frame and rim.
   *
   * They arrive with their blacks CRUSHED: both textures have pixels at 0, a
   * spread of 60 to 74, and means of #534340 and #916a68. Out in daylight
   * against pale paving that reads as a cut-out — a black box in a park, which
   * is exactly what the bumper-car pavilion looked like.
   *
   * `linear(a, b)` is `out = a*in + b`, so the offset lifts the floor off zero
   * and the multiplier keeps the top from clipping: the darkest pixel goes to
   * 68 and 80 and the spread drops to 48 and 36. That is a structure lit by
   * the sky rather than one cut out of it. A little saturation back on top,
   * because lifting blacks toward grey is also lifting them toward colourless.
   */
  build_gen_1: { linear: [0.72, 52], saturation: 1.1 },
  build_gen_2: { linear: [0.6, 80], saturation: 1.1 },
  /*
   * The bumper cars themselves, which measured #0c0e11 and #120e0b — near
   * black, on a ride whose entire visual idea is a dozen brightly painted cars
   * bouncing off each other. There is paint in there (one reads orange and one
   * blue in the scene) but at a twentieth of the brightness it wants. Lifted
   * hard and saturated to match, which is the same treatment as the structure
   * and for the same reason, just further.
   */
  bumpercar: { linear: [0.85, 74], saturation: 1.8 },
  bumpercar2: { linear: [0.85, 74], saturation: 1.8 },
  /*
   * The supports, station, stairs and tubes.
   *
   * White was the wrong call. A hundred slender white members against a bright
   * sky have nothing to read against — they wash out into the background and
   * the ride loses its structure, which is the half of a coaster you actually
   * see from a distance. Gunmetal is what these are painted in life, and it
   * gives the red something to sit against.
   *
   * `tint` PRESERVES luminance — it changes hue and leaves lightness alone —
   * which is why the first attempt at this came out #c8d2df: a pale cyan
   * texture tinted grey is a pale grey texture. The darkening has to be asked
   * for separately, and `brightness` is what does it. Measured: the source is
   * #92dce3 and this lands at roughly #5f6167.
   */
  Platform: { saturation: 0, brightness: 0.49, tint: { r: 176, g: 178, b: 184 } },
};

/**
 * The trains' liveries — one per train, and the whole point is that they are
 * ROTATIONS of the texture rather than replacements of it.
 *
 * The cars arrived at #e3e898, a pale cream-yellow, which is the "faded". The
 * first fix desaturated them and duotoned them blue, and that was worse in a
 * way worth recording: a duotone maps every pixel to one hue, so the livery's
 * stripes, its shading and its panel lines all collapse into a single flat
 * colour. It read as a blue lozenge.
 *
 * Rotating the hue keeps all of that. Every pixel moves the same number of
 * degrees round the wheel, so the relationships between the colours survive
 * and only the key changes — and three rotations give three trains that are
 * recognisably the same design in three colours, which is exactly what a park
 * with three trains has. The saturation lift is what takes the fade out.
 *
 * The source sits at about 64° (yellow-green), so the rotations are measured
 * from there rather than from red — and measured is the word. Predicting where
 * a rotation lands does not work, because the mean hue of a multi-hued texture
 * does not move with the rotation the way a single colour would: -65° was
 * expected to give red and gave orange, and -92° gave pink. Every value here
 * was swept and read back off the rendered pixels.
 *
 * The saturation lift does NOT flatten the livery, which is the thing to check
 * when pushing colour this hard. Measured, per-channel standard deviation goes
 * UP with it — 19.4 at 1.8, 24.8 at 2.2 — so the stripes and the shading are
 * being amplified along with the hue rather than crushed into a flat lozenge,
 * which is exactly what the duotone before it did.
 */
const LIVERIES = [
  // #f44e37, a warm vermilion.
  { hue: -70, saturation: 2.2, brightness: 0.7 },
  // #578bf4, a royal blue — 180 lands on azure, which is the sky blue this
  // ride was rescued from, so it goes five degrees further round.
  { hue: 185, saturation: 2.2, brightness: 0.7 },
  // #f73cd3, magenta, which against the other two reads as the third of a set.
  { hue: 230, saturation: 2.2, brightness: 0.7 },
];

/**
 * How each material finishes, where the default is wrong.
 *
 * Everything gets roughness 0.85 and metalness 0.1 by default, which is right
 * for concrete and wrong for a painted steel ride. The supports and the rails
 * are lacquered metal and the cars are gloss fibreglass; a little metalness
 * and a lot less roughness is the difference between a ride that catches the
 * sun along its rails and one that looks like it is made of chalk.
 */
const FINISH = {
  /** The pond: smooth and a little metallic, so it catches the sky. */
  WaterBasicNighttime: { roughness: 0.12, metalness: 0.2 },
  Platform: { metalness: 0.45, roughness: 0.52 },
  Yellow: { metalness: 0.4, roughness: 0.38 },
  LightBlue: { metalness: 0.5, roughness: 0.45 },
  DarkGrey: { metalness: 0.35, roughness: 0.6 },
  cart: { metalness: 0.3, roughness: 0.34 },
};

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

/** 4x4 multiply, column-major like glTF's own. */
const mat = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
      + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};

/** General 4x4 inverse — the trains need one, to get out of world space. */
const invert = (m) => {
  const inv = new Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  const det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (!det) throw new Error('singular matrix');
  return inv.map((v) => v / det);
};

/** A translation/rotation/scale triple as a column-major 4x4. */
const compose = ([x, y, z], [qx, qy, qz, qw], [sx, sy, sz]) => {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    x, y, z, 1,
  ];
};

/** The rotation in a matrix, as a quaternion, with any scale divided out. */
const quatOf = (m) => {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [m[0]/sx, m[1]/sx, m[2]/sx, m[4]/sy, m[5]/sy, m[6]/sy, m[8]/sz, m[9]/sz, m[10]/sz];
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    return [(m12 - m21) / k, (m20 - m02) / k, (m01 - m10) / k, k / 4];
  }
  if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [k / 4, (m10 + m01) / k, (m20 + m02) / k, (m12 - m21) / k];
  }
  if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m10 + m01) / k, k / 4, (m21 + m12) / k, (m20 - m02) / k];
  }
  const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m20 + m02) / k, (m21 + m12) / k, k / 4, (m01 - m10) / k];
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

/**
 * Which part of the export a mesh belongs to.
 *
 * The parent's name, as in the airport's kit — except for the skinned meshes,
 * which glTF requires to sit at the scene root with no parent transform, so
 * they answer to their own names (`Object_8`, `Object_111`). That is not a
 * quirk of this export; it is the format.
 */
const named = (node) => node.getParentNode()?.getName() || node.getName();

/**
 * A handful of named objects out of a source far too big to read whole.
 *
 * The city map is 12,103 meshes and 2.96 million triangles. `readSource`
 * bakes every vertex of everything it is given into JavaScript arrays, which
 * for this file would be several hundred megabytes to find a bench in. So
 * this walks the node table instead, takes only the subtrees asked for, and
 * bakes those.
 *
 * Objects are picked by their own name and an INSTANCE index, because the map
 * does not give repeated props unique names: there are 37 nodes called
 * `Module_Bench_23`, 144 called `Tree_17`, and matching by name alone would
 * gather every copy scattered over a kilometre of city into one part. Which
 * instance hardly matters — each is recentred and grounded below — except
 * that the copies are scaled differently, so `metres` states the size where
 * the size matters.
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
    const walk = (nd) => {
      const mesh = nd.getMesh();
      if (mesh) {
        const world = nd.getWorldMatrix();
        for (const prim of mesh.listPrimitives()) {
          // Some objects are several materials in one node — the block that
          // carries the park's pond also carries the buildings around it, and
          // only the water is wanted.
          if (spec.onlyMaterial && prim.getMaterial()?.getName() !== spec.onlyMaterial) continue;
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
            ancestry: [spec.pick],
            self: nd.getName(),
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
      for (const child of nd.listChildren()) walk(child);
    };
    walk(node);
    if (!prims.length) throw new Error(`${path}: "${spec.pick}" #${spec.instance ?? 0} has no geometry`);
    out.set(spec.name, prims);
  }
  return out;
};

/** Every primitive of a source, baked into world space and tagged by owner. */
const readSource = async (path) => {
  const doc = await io.read(path);
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    const owner = named(node);
    const ancestry = [];
    for (let p = node; p; p = p.getParentNode()) ancestry.push(p.getName());
    const self = node.getName();
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
        // Every ancestor's name, because a part is not always the parent. The
        // cart trains hang two and three levels under their `Dummy`, so
        // matching on the immediate parent misses them entirely.
        ancestry,
        // The mesh node's OWN name, which is how the ferris wheel's sixteen
        // cabins are told apart from each other and from the rim.
        node: self,
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

/**
 * Decimate one primitive.
 *
 * Per primitive rather than per mesh, because a primitive is the unit that
 * owns a material and merging across them would merge the paint.
 *
 * No `LockBorder`, and that is measured rather than assumed: with borders
 * locked the track would only come down to 298,000 triangles, against 127,000
 * without — the track is thousands of small closed shells (every tie, every
 * rail segment its own solid), so almost every edge IS a border and locking
 * them locks nearly everything. Unlocked, each shell simplifies inside itself
 * and the pieces cannot pull apart from each other because they were never
 * joined to begin with.
 *
 * 127,000 is also the floor: raising the error budget from 0.01 to 0.12
 * changes nothing at all, because the limit is topology and not tolerance.
 * `simplifySloppy` would go lower and would throw the UVs away with it, and
 * the UVs are the track's yellow rails and blue trim.
 */
const decimate = (prim, ratio, sloppy) => {
  const target = Math.max(3, Math.floor((prim.idx.length * ratio) / 3) * 3);
  if (target >= prim.idx.length) return prim;
  /*
   * `simplifySloppy` ignores topology and UVs, and for an UNTEXTURED model
   * that is a free lunch rather than a compromise.
   *
   * The ordinary simplifier is bounded by an error target — 1% of the mesh's
   * own extent — and stops when the next collapse would exceed it whatever
   * ratio it was asked for. On a lattice of thin tube that happens almost
   * immediately: one 608,000-triangle ride was asked for a sixteenth and gave
   * back 36%, because every collapse on a 30 cm strut is a large error
   * relative to a 30 cm strut. Sloppy took the same model to 5.2%.
   *
   * What it costs is the UVs and the topology, so it is only free on an
   * UNTEXTURED model — flat colours do not care which triangle they are on.
   * Anything with a texture must not use it.
   *
   * Nothing in the park uses it today; the ride it was written for has gone.
   * It is kept because the next heavy export will have the same shape, and
   * because the reason it is safe is not obvious enough to rediscover.
   */
  const [indices, error] = sloppy
    ? MeshoptSimplifier.simplifySloppy(prim.idx, prim.pos, 3, null, target, 1)
    : MeshoptSimplifier.simplify(prim.idx, prim.pos, 3, target, 1e-2, []);
  return { ...prim, idx: Uint32Array.from(indices), error };
};

/**
 * The ride, sampled out of the model's own animation.
 *
 * The export carries a 45-second clip called "Take 001" driving three cart
 * trains round the track, and that is the whole answer to making the coaster
 * work. It is also the ONLY answer that could have been right: I spent a long
 * time trying to recover the track's centreline from the mesh instead, and it
 * is not recoverable — the track is not a vertex-ordered sweep but thousands
 * of separate pieces, and with the jump threshold set correctly the longest
 * continuous run in any primitive is 25 m of a circuit several hundred metres
 * long. The modeller already drove the train round it; read that.
 *
 * Sampled at a fixed rate rather than kept as keyframes, because the keys are
 * LINEAR and unevenly spaced (979, 909 and 909 of them) and a uniform table is
 * a lookup rather than a search. Position and rotation only: the clip animates
 * scale too, and it is 1.000 throughout.
 */
const TRAIN_FPS = 20;
const sampleTrains = async (path, owners) => {
  const doc = await io.read(path);
  const anim = doc.getRoot().listAnimations()[0];
  if (!anim) throw new Error(`${path} has no animation to drive the trains`);
  // Channels, by node name then by path.
  const tracks = new Map();
  for (const ch of anim.listChannels()) {
    const name = ch.getTargetNode()?.getName();
    if (!name || !owners.includes(name)) continue;
    const s = ch.getSampler();
    const input = s.getInput();
    const output = s.getOutput();
    const times = Array.from({ length: input.getCount() }, (_, i) => input.getScalar(i));
    const size = output.getElementSize();
    const values = [];
    const tmp = new Array(size).fill(0);
    for (let i = 0; i < output.getCount(); i++) { output.getElement(i, tmp); values.push([...tmp]); }
    if (!tracks.has(name)) tracks.set(name, {});
    tracks.get(name)[ch.getTargetPath()] = { times, values };
  }
  /** Linear sample, with quaternions taken the short way round. */
  const at = (track, t, fallback) => {
    if (!track) return fallback;
    const { times, values } = track;
    if (t <= times[0]) return values[0];
    if (t >= times[times.length - 1]) return values[values.length - 1];
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    const k = (t - times[lo]) / (times[hi] - times[lo] || 1);
    const a = values[lo];
    let b = values[hi];
    if (a.length === 4 && a.reduce((n, v, i) => n + v * b[i], 0) < 0) b = b.map((v) => -v);
    const out = a.map((v, i) => v + (b[i] - v) * k);
    if (out.length === 4) {
      const len = Math.hypot(...out) || 1;
      return out.map((v) => v / len);
    }
    return out;
  };
  let duration = 0;
  for (const s of anim.listSamplers()) {
    const input = s.getInput();
    if (input) duration = Math.max(duration, input.getMax([])[0]);
  }
  const frames = Math.round(duration * TRAIN_FPS);
  const out = new Map();
  for (const name of owners) {
    const node = doc.getRoot().listNodes().find((n) => n.getName() === name);
    if (!node) throw new Error(`no node ${name} to sample`);
    const parent = node.getParentNode()?.getWorldMatrix() ?? compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const track = tracks.get(name) ?? {};
    const pose = (t) => mat(parent, compose(
      at(track.translation, t, node.getTranslation()),
      at(track.rotation, t, node.getRotation()),
      [1, 1, 1],
    ));
    const keys = [];
    for (let f = 0; f < frames; f++) {
      const m = pose((f / frames) * duration);
      keys.push({ p: [m[12], m[13], m[14]], q: quatOf(m) });
    }
    out.set(name, { keys, duration, rest: pose(0) });
  }
  return out;
};

const sources = new Map();
for (const path of [...new Set(PARTS.filter((p) => !p.pick).map((p) => p.source))]) {
  sources.set(path, await readSource(path));
  console.log(`read ${path}: ${sources.get(path).length} primitives`);
}
/**
 * The picked parts, gathered in ONE pass over each source.
 *
 * Opening the city map costs about as much as the rest of this script
 * together, so every pick out of it is resolved in a single walk of the node
 * table rather than a walk each.
 */
const picked = new Map();
for (const path of [...new Set(PARTS.filter((p) => p.pick).map((p) => p.source))]) {
  const mine = PARTS.filter((p) => p.pick && p.source === path);
  const got = await readPicks(path, mine, path === CITY ? CITY_UNITS : 1);
  for (const [name, prims] of got) picked.set(name, prims);
  console.log(`read ${path}: ${mine.length} picked objects, `
    + `${[...got.values()].reduce((n, v) => n + v.length, 0)} primitives`);
}

/* ------------------------------------------ frame each part in its own right */

const built = [];
for (const spec of PARTS) {
  let prims = spec.pick ? picked.get(spec.name) : sources.get(spec.source).filter((p) => {
    if (spec.exclude?.includes(p.owner)) return false;
    return spec.from === undefined || spec.from === null ? true : p.owner === spec.from;
  });
  if (!prims.length) throw new Error(`no geometry for ${spec.name} (looked for "${spec.from}")`);

  /*
   * The trains, lifted out of the ride and into their own frames.
   *
   * `readSource` has already baked every vertex into world space, and the
   * clip's pose at t = 0 is the pose they were baked in. So the cart's own
   * local geometry is that world geometry with the t = 0 pose divided back
   * out, and from then on the clip places it: position and rotation per
   * frame, and nothing else to keep in step.
   */
  const trains = [];
  if (spec.trains) {
    const motion = await sampleTrains(spec.source, spec.trains);
    for (const owner of spec.trains) {
      const mine = prims.filter((p) => p.ancestry.includes(owner));
      if (!mine.length) throw new Error(`no geometry for train ${owner}`);
      prims = prims.filter((p) => !mine.includes(p));
      const { keys, duration, rest } = motion.get(owner);
      const back = invert(rest);
      for (const prim of mine) {
        for (let i = 0; i < prim.pos.length; i += 3) {
          const v = mul(back, [prim.pos[i], prim.pos[i + 1], prim.pos[i + 2]]);
          prim.pos.set(v, i);
        }
        for (let i = 0; i < prim.nrm.length; i += 3) {
          const d = mulDir(back, [prim.nrm[i], prim.nrm[i + 1], prim.nrm[i + 2]]);
          const len = Math.hypot(...d) || 1;
          prim.nrm.set([d[0] / len, d[1] / len, d[2] / len], i);
        }
      }
      /*
       * The scale the pose carries, kept so the geometry can get it back.
       *
       * Dividing the t = 0 pose out of the geometry divides out its SCALE too,
       * and that scale is the FBX chain's — the source is authored in units
       * where the whole ride is half a unit across. Left like that the cart
       * came out 726 m long. It is reapplied below, alongside the ride's own
       * metre scale.
       */
      const unit = Math.hypot(rest[0], rest[1], rest[2]);
      // Each train's cars get their own livery — see `LIVERIES`. Tagged on
      // the primitive, because the material cache is what has to tell them
      // apart: all three share one source material.
      const livery = trains.length % LIVERIES.length;
      for (const prim of mine) prim.livery = livery;
      trains.push({ owner, prims: mine, keys, duration, unit });
    }
  }

  /*
   * Triangles REACHING above a height, dropped — any vertex, not all three.
   *
   * "All three" is the obvious rule and it does nothing here. The bumper car's
   * mast is four long quads running the whole way up, so every one of its
   * triangles has a foot down at the car and a head at 8 m: not one of them is
   * wholly above any line you could draw, and the first version of this cut
   * 160 triangles and left the mast standing.
   *
   * Cutting a triangle properly would mean re-triangulating it and inventing
   * UVs for the new vertices. Dropping any triangle that reaches over the line
   * is cruder and right here, because the line is above everything the car
   * actually is: nine tenths of its vertices are below 2.55 m.
   */
  if (spec.clipAbove !== undefined) {
    let cut = 0;
    prims = prims.map((p) => {
      const keep = [];
      for (let i = 0; i < p.idx.length; i += 3) {
        const reaches = [0, 1, 2].some((k) => p.pos[p.idx[i + k] * 3 + 1] > spec.clipAbove);
        if (reaches) cut++;
        else keep.push(p.idx[i], p.idx[i + 1], p.idx[i + 2]);
      }
      return { ...p, idx: Uint32Array.from(keep) };
    });
    console.log(`  ${spec.name}: clipped ${cut} tris reaching above ${spec.clipAbove} m`);
  }

  if (spec.simplify) {
    let before = 0;
    let after = 0;
    let worst = 0;
    prims = prims.map((p) => {
      // A number decimates the WHOLE part; a table decimates the owners it
      // names. The table is right when one mesh in a model is the problem —
      // the coaster's track is 93% of its triangles and nothing else in it is
      // worth touching. It is no use on something that arrives as scores of
      // unnamed `Object_N` nodes with the triangles spread evenly over them,
      // which is the shape most heavy Sketchfab exports come in.
      const ratio = typeof spec.simplify === 'number' ? spec.simplify : spec.simplify[p.owner];
      before += p.idx.length / 3;
      if (!ratio) { after += p.idx.length / 3; return p; }
      const cut = decimate(p, ratio, spec.sloppy);
      after += cut.idx.length / 3;
      worst = Math.max(worst, cut.error ?? 0);
      return cut;
    });
    console.log(`  ${spec.name}: ${Math.round(before)} -> ${Math.round(after)} tris `
      + `(${(100 * after / before).toFixed(1)}%), worst error ${worst.toFixed(4)}`);
  }

  // A quarter turn about X, which takes a ring lying in the XZ plane and
  // stands it up in XY — the ferris wheel, and nothing else so far.
  if (spec.pitch) {
    for (const prim of prims) {
      for (const a of [prim.pos, prim.nrm]) {
        for (let i = 0; i < a.length; i += 3) {
          const y = a[i + 1];
          a[i + 1] = -a[i + 2];
          a[i + 2] = y;
        }
      }
    }
  }

  const whole = boundsOf(prims);
  const scale = spec.metres ? spec.metres / Math.max(whole.size[0], whole.size[2]) : 1;
  /**
   * The ground datum, taken from the top of another node — usually one that
   * has just been excluded.
   *
   * A percentile over the part's own vertices finds the floor of a building,
   * which is what it was written for. It cannot find the floor of something
   * that was modelled standing on a slab, because the slab is the floor and
   * the slab is not part of the part. Reading it straight off the slab is
   * both simpler and exact.
   */
  const datum = spec.floorFrom
    ? boundsOf(sources.get(spec.source).filter((p) => p.owner === spec.floorFrom)).max[1]
    : null;
  if (spec.floorFrom && !Number.isFinite(datum)) {
    throw new Error(`no geometry for ${spec.name}'s floorFrom "${spec.floorFrom}"`);
  }
  // `hub` parts are centred on all three axes: the game gives them a position
  // and an axis to turn about, so their own origin has to be their middle.
  // Everything else is centred on its footprint and stood on y = 0, so placing
  // it is an (x, z, turn) and the collider is half its measured size.
  const floor = spec.hub ? whole.centre[1] : (datum ?? groundOf(prims, spec.floor));
  if (datum !== null) {
    console.log(`  ${spec.name}: floor from ${spec.floorFrom}, `
      + `${((datum - whole.min[1]) * scale).toFixed(2)} m above the ride's lowest vertex`);
  }
  if (!spec.hub && datum === null && floor > whole.min[1] + 0.01) {
    console.log(`  ${spec.name}: floor at ${floor.toFixed(2)} m, `
      + `${(floor - whole.min[1]).toFixed(2)} m above the lowest stray vertex`);
  }
  for (const prim of prims) {
    for (let i = 0; i < prim.pos.length; i += 3) {
      prim.pos[i] = (prim.pos[i] - whole.centre[0]) * scale;
      prim.pos[i + 1] = (prim.pos[i + 1] - floor) * scale;
      prim.pos[i + 2] = (prim.pos[i + 2] - whole.centre[2]) * scale;
    }
  }

  /*
   * The ferris wheel, taken apart.
   *
   * Rotating the wheel as one mesh rotates its cabins with it, and a cabin
   * that turns upside down at the top of the wheel is the one thing everybody
   * notices. The source already has the split: the rim is two big nodes and
   * each cabin is a pair of small ones, so the rule is size, and the pairs are
   * found by clustering what is left on position.
   *
   * Each cabin is centred on itself and its offset from the axle is recorded
   * as a radius and an angle. After that the game orbits it and never turns
   * it, which is exactly what the real linkage does.
   */
  const pieces = [];
  if (spec.explode) {
    const E = spec.explode;
    const byNode = new Map();
    for (const prim of prims) {
      const list = byNode.get(prim.node) ?? [];
      list.push(prim);
      byNode.set(prim.node, list);
    }
    const rim = [];
    const small = [];
    for (const [, list] of byNode) {
      const b = boundsOf(list);
      (Math.max(...b.size) > E.big ? rim : small).push({ prims: list, centre: b.centre });
    }
    // Cluster the small nodes into cabins: each cabin is two nodes sitting on
    // top of each other, so anything within `cluster` metres is one cabin.
    const cabins = [];
    for (const piece of small) {
      const near = cabins.find((c) => Math.hypot(
        c.centre[0] - piece.centre[0], c.centre[1] - piece.centre[1], c.centre[2] - piece.centre[2],
      ) < E.cluster);
      if (near) { near.prims.push(...piece.prims); near.centre = boundsOf(near.prims).centre; }
      else cabins.push({ prims: [...piece.prims], centre: piece.centre });
    }
    prims = rim.flatMap((r) => r.prims);
    cabins.forEach((cabin, i) => pieces.push({ name: `${E.cabin}${i}`, prims: cabin.prims, orbit: true }));
    console.log(`  ${spec.name}: ${rim.length} rim nodes, ${cabins.length} cabins`);
    spec.name = E.rim;
  }

  /* The swing carousel's base and top, told apart by material. */
  if (spec.byMaterial) {
    const groups = new Map();
    for (const prim of prims) {
      const name = spec.byMaterial[prim.material?.getName()] ?? spec.byMaterial['*'];
      const list = groups.get(name) ?? [];
      list.push(prim);
      groups.set(name, list);
    }
    const [first, ...rest] = [...groups];
    prims = first[1];
    spec.name = first[0];
    for (const [name, list] of rest) pieces.push({ name, prims: list, spin: true });
  }

  const framed = boundsOf(prims);
  // Height above the floor rather than the box's, so a stray vertex now below
  // ground does not hand the game a collider too tall and too low.
  if (!spec.hub) framed.size[1] = framed.max[1];
  const tris = prims.reduce((n, p) => n + p.idx.length / 3, 0);
  console.log(`  ${spec.name.padEnd(10)} ${framed.size.map((v) => v.toFixed(1)).join(' x ').padEnd(22)}`
    + ` m  scale ${scale.toFixed(3)}  ${String(Math.round(tris)).padStart(6)} tris`);
  /*
   * The axle: where the wheel's bearing actually is on its A-frame.
   *
   * Not the middle of the base's bounding box, which is where the wheel was
   * being hung and which is why the rim sat forward of the towers that were
   * supposed to be holding it. The bearing is the apex, so it is the centroid
   * of the highest two per cent of the base's vertices — measured, not
   * assumed, and in the part's own finished frame.
   */
  /*
   * Two measurements, both optional and both independent — which is worth a
   * word, because the first version made them an if/else and the drop tower
   * silently lost its axle the moment it asked for a deck.
   *
   * `axle` is a bearing: the centroid of the highest two per cent, which is
   * the apex of an A-frame or the top of a mast. `deck` is the floor people
   * and bumper cars stand on, and it is NOT y = 0 — both of these rides are
   * modelled with a raised platform 2.25 m up on a structure that reaches the
   * ground, so anything placed at the part's own origin is under the floor and
   * inside the building. That is where four bumper cars spent their first
   * outing. It is found as the busiest quarter-metre band in the lower half of
   * the part, because a floor is the one horizontal surface with thousands of
   * vertices on it.
   */
  const extra = {};
  if (spec.axle) {
    const used = usedOf(prims);
    const ys = used.map((v) => v[1]).sort((a, b) => b - a);
    const cut = ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.02))];
    const top = used.filter((v) => v[1] >= cut);
    extra.axle = [0, 1, 2].map((a) => top.reduce((n, v) => n + v[a], 0) / top.length);
    console.log(`  ${spec.name}: axle at ${extra.axle.map((v) => v.toFixed(2)).join(', ')}`);
  }
  if (spec.deck) {
    const low = usedOf(prims).map((v) => v[1]).filter((y) => y < framed.size[1] * 0.5);
    const bins = new Map();
    for (const y of low) {
      const k = Math.round(y / 0.25) * 0.25;
      bins.set(k, (bins.get(k) ?? 0) + 1);
    }
    [extra.deck] = [...bins].sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${spec.name}: deck at ${extra.deck.toFixed(2)} m`);
  }
  built.push({ name: spec.name, prims, size: framed.size, tris, ...extra });

  /*
   * The pieces that came off, in the SAME frame as the part they came from —
   * the same centring, floor and scale — so a cabin's recorded orbit and a
   * carousel's top both line up with what is left behind.
   */
  for (const piece of pieces) {
    const b = boundsOf(piece.prims);
    // Centred on itself, so the game can place and orbit it.
    const centre = piece.orbit ? b.centre : [b.centre[0], 0, b.centre[2]];
    for (const prim of piece.prims) {
      for (let i = 0; i < prim.pos.length; i += 3) {
        prim.pos[i] -= centre[0];
        prim.pos[i + 1] -= centre[1];
        prim.pos[i + 2] -= centre[2];
      }
    }
    const framedPiece = boundsOf(piece.prims);
    const out = {
      name: piece.name,
      prims: piece.prims,
      size: framedPiece.size,
      tris: piece.prims.reduce((n, p) => n + p.idx.length / 3, 0),
    };
    if (piece.orbit) {
      // In the pitched frame the wheel stands in XY, so the orbit is an angle
      // about Z and a radius in that plane.
      out.orbit = [Math.hypot(centre[0], centre[1]), Math.atan2(centre[1], centre[0])];
    } else {
      out.offset = centre.map((v) => +v.toFixed(3));
    }
    built.push(out);
  }

  // The trains take the ride's own framing — the same centring, floor and
  // scale — so they run on the track rather than beside it.
  trains.forEach((train, i) => {
    for (const prim of train.prims) {
      for (let j = 0; j < prim.pos.length; j++) prim.pos[j] *= scale * train.unit;
    }
    const path = train.keys.map((k) => [
      (k.p[0] - whole.centre[0]) * scale,
      (k.p[1] - floor) * scale,
      (k.p[2] - whole.centre[2]) * scale,
      ...k.q,
    ]);
    let run = 0;
    for (let j = 1; j < path.length; j++) {
      run += Math.hypot(path[j][0] - path[j - 1][0], path[j][1] - path[j - 1][1],
        path[j][2] - path[j - 1][2]);
    }
    const ys = path.map((k) => k[1]);
    const b = boundsOf(train.prims);
    console.log(`  ${`train${i + 1}`.padEnd(10)} ${b.size.map((v) => v.toFixed(1)).join(' x ').padEnd(22)}`
      + ` m  ${String(Math.round(train.prims.reduce((n, p) => n + p.idx.length / 3, 0))).padStart(6)} tris`
      + `  circuit ${run.toFixed(0)} m, ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)} m high`);
    built.push({
      name: `train${i + 1}`,
      prims: train.prims,
      size: b.size,
      tris: train.prims.reduce((n, p) => n + p.idx.length / 3, 0),
      path,
      duration: train.duration,
    });
  });
}

/* ------------------------------------------------------------------- write */

const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('park');

const textures = new Map();
const convertTexture = async (src, wash) => {
  const image = src?.getImage();
  if (!image) return null;
  // Cached per source texture AND per wash: the same image repainted two ways
  // is two textures, and left alone twice is still one.
  const key = wash ? JSON.stringify(wash) : '';
  const seen = textures.get(src) ?? new Map();
  textures.set(src, seen);
  if (seen.has(key)) return seen.get(key);
  let pipe = sharp(Buffer.from(image))
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true });
  // Before anything else: lifting the floor is a tonal change, and doing it
  // after a hue rotation would rotate a colour that is no longer there.
  if (wash?.linear) pipe = pipe.linear(wash.linear[0], wash.linear[1]);
  if (wash?.saturation !== undefined || wash?.brightness !== undefined
    || wash?.hue !== undefined) {
    pipe = pipe.modulate({
      ...(wash.saturation !== undefined ? { saturation: wash.saturation } : {}),
      ...(wash.brightness !== undefined ? { brightness: wash.brightness } : {}),
      ...(wash.hue !== undefined ? { hue: wash.hue } : {}),
    });
  }
  if (wash?.tint) pipe = pipe.tint(wash.tint);
  const webp = await pipe.webp({ quality: 84 }).toBuffer();
  const tex = out.createTexture(src.getName() || 'tex').setImage(webp).setMimeType('image/webp');
  seen.set(key, tex);
  return tex;
};
const materials = new Map();
/**
 * Materials that keep their cutout instead of being flattened to OPAQUE.
 *
 * Everything else here is forced opaque for the reason `prepare-airport.mjs`
 * gives at length: a transparent surface sorts against whatever is behind it,
 * and on a ride that is the rest of the ride. Foliage is the exception and
 * has to be. The city's `Vegetation` is alpha CARDS — flat quads with a leaf
 * shape painted on a 2048px texture that carries a real alpha channel — so
 * rendered opaque a tree is not a tree, it is the rectangle the tree was
 * drawn on. That is exactly what the first build of the park kit looked like.
 *
 * MASK and not BLEND. A cutout needs no sorting at all: the fragment is
 * either drawn or discarded, which is right for a leaf and costs nothing,
 * where BLEND would put every tree into the transparent pass to be sorted
 * against every other tree.
 */
const CUTOUT = new Set(['Vegetation']);

const convertMaterial = async (src, livery) => {
  // Keyed by source material AND livery: one material with three liveries is
  // three materials, which is the only way three trains can be three colours.
  const key = `${livery ?? ''}`;
  const seen = materials.get(src) ?? new Map();
  materials.set(src, seen);
  if (seen.has(key)) return seen.get(key);
  const finish = FINISH[src?.getName()];
  const m = out.createMaterial(src?.getName() || 'park')
    .setBaseColorFactor(src?.getBaseColorFactor() ?? [1, 1, 1, 1])
    .setMetallicFactor(finish?.metalness ?? src?.getMetallicFactor() ?? 0.1)
    .setRoughnessFactor(finish?.roughness ?? src?.getRoughnessFactor() ?? 0.85)
    .setDoubleSided(true)
    .setAlphaMode(CUTOUT.has(src?.getName()) ? 'MASK' : 'OPAQUE')
    .setAlphaCutoff(0.5);
  // Colour lives in the spec-gloss extension's diffuse texture when a material
  // has one — see the airport's bus, which came out pure white for a week.
  const spec = src?.getExtension('KHR_materials_pbrSpecularGlossiness');
  const diffuse = spec?.getDiffuseTexture?.() ?? null;
  const wash = livery === undefined ? WASH[src?.getName()] : LIVERIES[livery];
  const tex = await convertTexture(diffuse ?? src?.getBaseColorTexture(), wash);
  if (tex) m.setBaseColorTexture(tex);
  const factor = spec?.getDiffuseFactor?.();
  if (!tex && factor) m.setBaseColorFactor(factor);
  // Last, so it beats both of the above. See `REPAINT`.
  const repaint = REPAINT[src?.getName()];
  if (repaint) m.setBaseColorFactor(repaint);
  seen.set(key, m);
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
    prim.setMaterial(await convertMaterial(p.material, p.livery));
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
    ...(p.axle ? { axle: p.axle.map((v) => +v.toFixed(3)) } : {}),
    ...(p.deck !== undefined ? { deck: p.deck } : {}),
    ...(p.orbit ? { orbit: p.orbit.map((v) => +v.toFixed(4)) } : {}),
    ...(p.offset ? { offset: p.offset } : {}),
    ...(p.duration ? { duration: +p.duration.toFixed(3), fps: TRAIN_FPS } : {}),
    // x, y, z, qx, qy, qz, qw per frame. Trimmed to millimetres and five
    // decimals of quaternion, which is well under what a 6 m cart can show
    // and is the difference between a 300 KB data file and a 900 KB one.
    ...(p.path ? {
      path: p.path.map((k) => k.map((v, i) => +v.toFixed(i < 3 ? 3 : 5))),
    } : {}),
  }])),
}, null, 2)}\n`);
console.log(`wrote ${DST} and ${DATA}: ${Math.round(triangles)} triangles in ${built.length} parts, `
  + `${[...textures.values()].reduce((n, m) => n + m.size, 0)} textures`);
