import roadModels from './roadModelData.json';
import { AIRPORT_GATE, CARGO_JUNCTION, ENTRY, PARADE_LINKS, PAVING } from './airportConfig';
import { COURIER_HUB, STATION_FORECOURT } from './islandRailConfig';

/**
 * Halcyon Field's roads, built from the modular kit.
 *
 * The island's two roads used to be slabs: a box of tarmac with a box of
 * paint on top. `modular_roads_pack.glb` carries kerbs, pavements, lane
 * markings and pedestrian crossings in its texture, so a road made of it
 * looks like a road without any of that being modelled — and the whole kit is
 * 1,461 triangles.
 *
 * ## The pieces, and which way they face
 *
 * Measured off the baked model rather than assumed (`prepare-roads.mjs` puts
 * every piece centred on its footprint and flat on y = 0):
 *
 *   straight1/2/4   73.2 / 146.3 / 292.6 m long, 19.0 m wide, running along X
 *   curve1/2/4      a U-turn, both mouths facing +Z, centres at x = +/- the
 *                   radius: 23.3 / 46.6 / 93.1 m
 *   cornerL         arms +X and -Z
 *   junctionT       arms +X, -X and -Z — the bar on X, the stem to -Z
 *   junctionX       all four, so its turn does not matter
 *
 * ## Runs, not pieces
 *
 * A run is a centreline and two ends; the component fills it with whole
 * straights. That is deliberate, because the kit does NOT tile at the
 * junction pitch — a straight is 146.30 units against a 37.92 junction, which
 * is 3.86 and not 4 — so anything that assumed pieces snap would drift about
 * 2.7 m a span. Instead each run takes the whole number of straights nearest
 * its length and scales them along their own axis to fit exactly. At the
 * worst it is a couple of per cent, which on a dashed lane line is invisible,
 * and the run ends up exactly where the layout says it does.
 */

export type Piece = keyof typeof roadModels.parts;

/** The kit's road width, which every alignment here is spaced against. */
export const ROAD_WIDTH = roadModels.parts.straight1.size[2];

/**
 * How far the carriageway sits over the island crown.
 *
 * A whisker above the airfield's own paving (0.06) so the two never fight for
 * the same pixels where a road crosses an apron, and the kit's 0.1 m slab
 * then hangs below the crown rather than standing on it — a road is cut into
 * the ground, not laid on top of it.
 */
export const ROAD_TOP = 0.072;

/**
 * How many metres of road one repeat of the kit's texture covers.
 *
 * Taken off `straight2`, which is 146.3 m over seven repeats, because that is
 * the piece most of the outer road is made of — so anything else textured to
 * this figure, the bridge deck above all, carries its dashes at the same
 * spacing as the road it joins.
 *
 * The kit is not self-consistent about this: its 1X repeats every 24.4 m and
 * its 4X every 19.5. Nothing can be done about that from here, and at a
 * couple of metres over a 20 m dash cycle nobody has ever noticed.
 */
export const ROAD_REPEAT = roadModels.parts.straight2.size[0] / 7;

/**
 * How much of the kit's cross-section is PAVEMENT, at each edge.
 *
 * Its texture runs pavement, yellow edge line, two lanes, double-yellow
 * median, two lanes, edge line, pavement — so a strip at the top and bottom
 * is footway rather than carriageway. 0.143 is measured rather than guessed:
 * it is exactly the slice the kit's own L, T and X pieces sample for the kerb
 * band round a junction (`v 0.000..0.143`), so it is the pack's own idea of
 * where its pavement ends.
 *
 * It matters on the BRIDGE. A deck already has its parapets, modelled, at
 * both edges — so a texture that paints its own footways underneath them
 * gives the crossing two sets of pavement, one drawn and one built, which is
 * exactly what it looked like. Cropping to `0.143 .. 0.857` puts the four
 * lanes across the deck and nothing else.
 */
export const ROAD_PAVEMENT = 0.143;

/**
 * The kit is not one shape in section, and laying it as if it were put the
 * junctions 10 cm above the streets.
 *
 * Measured off `roads.glb`: a **straight** models its own footways — the
 * carriageway is at y = 0 and the pavement strips stand 0.103 up — while a
 * **junction or corner** is a flat slab with its whole top, paint and all, at
 * 0.102. Laid at the same height, the junction's carriageway stood a kerb's
 * height over the street's. So junction pieces go down by `KIT_KERB`
 * (`pieceBase`), which makes every carriageway in the network flush at
 * `ROAD_TOP`.
 */
export const KIT_KERB = roadModels.parts.straight1.size[1];

/** Where to put a kit piece's origin so its carriageway is at `ROAD_TOP`. */
export function pieceBase(piece: string): number {
  return piece.startsWith('straight') ? ROAD_TOP : ROAD_TOP - KIT_KERB;
}

/**
 * The footway's top over the island crown: the straights' own modelled
 * pavement, solid since `RoadColliders`. 10 cm over the road, under the chassis
 * collider's 0.14 m clearance (`vehicleConfig`), so a car bumps up onto it
 * rather than snagging its body on the kerb. Junctions and the swept curves
 * have no raised footway — the kit paints theirs flat.
 */
export const KERB_TOP = ROAD_TOP + KIT_KERB;

/**
 * Where a building on a paved civic block stands (`KestrelPlazas`): on the
 * plaza, which is at the footway's height, a centimetre up so its own ground
 * slab does not fight the paving for the same pixels.
 */
export const PLAZA_FLOOR = KERB_TOP + 0.01;

export interface RoadRun {
  /** Both ends of the centreline, in the island's frame. */
  from: readonly [number, number];
  to: readonly [number, number];
  label: string;
}

export interface RoadNode {
  piece: Piece;
  x: number;
  z: number;
  /** Radians about +Y. See the piece table above for what turn 0 points at. */
  turn: number;
  label: string;
}

const QUARTER = Math.PI / 2;

/**
 * Where the outer road turns south for the freight apron.
 *
 * Defined in `airportConfig` and imported, because the BRIDGE is built
 * against it: the crossing's whole last stretch — the aim point out over the
 * water, the tangent length, the radius of the curve — is solved backwards
 * from the edge of this junction, so it cannot be a number the road layout
 * owns privately. See `CARGO_JUNCTION` there for why it is 410 and not
 * anywhere else.
 */
const CARGO_TURN = CARGO_JUNCTION;

/**
 * The corners, and why the roads are joined at all.
 *
 * The landside road and the outer road ran as two dead-ended straights 105 m
 * apart, which is two roads rather than a road network: you drove to the end
 * of one and stopped. They are now a single U — west along the inner road,
 * round two corners, east along the outer — so there is a circuit to drive.
 *
 * Corners and not a curve, and that is the kit's fault rather than a choice:
 * its U-turns come in three radii, 23.3, 46.6 and 93.1 m, which put their two
 * mouths 46.5, 93.1 or 186.2 m apart. These two roads are 104.5 m apart. No
 * radius fits, and the pair that nearly does would mean moving the landside
 * road 11 m north into the car park.
 *
 * `cornerL` has arms +X and -Z at turn 0. The north corner therefore takes
 * turn 0 — east along the outer road, south down the link — and the south
 * corner takes a quarter turn the other way, for east and north.
 */
export const ROAD_NODES: readonly RoadNode[] = [
  /**
   * The airfield's own way in, and it is a T rather than a corner now.
   *
   * There has always been a way from the landside road down onto the frontage
   * at this end — `PAVING.hangarGate`, so that the west of the field is not
   * reached only by driving the length of the terminal. It was a 9 m slab, and
   * it opened onto the CORNER tile: the road arrived at the turn, and the way
   * in was a gap in the kerb on the outside of it. That is not a junction, it
   * is a hole, and it is why the entrance read as unconnected.
   *
   * Three roads meet here and the piece should say so. `junctionT` at a
   * quarter turn the other way gives arms +Z, -Z and +X — the link north to
   * the outer road, the gate road south onto the apron, and the landside road
   * east along the terminal — so a car reaching the west end of the island can
   * turn either way or go straight on, which is what it looks like it should
   * be able to do.
   */
  { piece: 'junctionT', x: AIRPORT_GATE, z: 154.5, turn: -QUARTER, label: 'airfield gate junction' },
  /**
   * The outer road's west end: a T now, and the bridge to Skylark is its
   * third arm.
   *
   * It was `cornerL` at turn 0: arms +X (east along the outer road) and −Z
   * (south down the link). `junctionT` at the same turn has both of those —
   * its bar is +X and −X, its stem is −Z — plus the −X arm the corner had as
   * a kerb, which in the world points 17° west of south, out over the water
   * toward the island the user drew. `countryConfig` reads this tile's west
   * edge as the start of its crossing and this arm's bearing as the
   * crossing's bearing, so the road and the bridge cannot drift apart.
   */
  /*
   * And a crossroads since the harbour: its fourth arm, north, is the harbour
   * road, which goes straight up over the trunk on its own level crossing
   * (`harbourConfig`). `junctionX` has every arm a `junctionT` at turn 0 has.
   */
  { piece: 'junctionX', x: AIRPORT_GATE, z: 259, turn: 0, label: 'outer road west junction' },
  /**
   * The island station car park's way out: a T on the outer road with its
   * stem north, into the car park's one-way loop — see `STATION_FORECOURT`.
   * Half a turn puts the kit's −Z stem at +Z, as the parade's landside Ts do.
   */
  { piece: 'junctionT', x: STATION_FORECOURT.exit, z: 259, turn: Math.PI, label: 'station exit' },
  /*
   * The island station's road — see `STATION_FORECOURT`. Its two tiles sit
   * mouth to mouth on the outer road's: a T at the west (arms south to the
   * crossroads, east along the station, west into the car park — turn 0 is
   * +X, −X and −Z) and a corner at the east (arms west and south — a quarter
   * turn takes the kit's +X to −Z and its −Z to −X).
   */
  { piece: 'junctionT', x: STATION_FORECOURT.west, z: STATION_FORECOURT.road, turn: 0, label: 'station road west' },
  // A T, not a corner: its +X arm opens east into the parcel hub's yard
  // (`COURIER_HUB`), so the station and the hub are one piece of ground.
  // At turn 0 its arms are +X, −X (the station road) and −Z (down to the exit).
  { piece: 'junctionT', x: STATION_FORECOURT.exit, z: STATION_FORECOURT.road, turn: 0, label: 'station road east / parcel hub' },
  /**
   * The cargo junction: the one place where everything meets.
   *
   * Three roads: the bridge arrives from the east, the airport road leaves
   * west, and the cargo road drops south to the freight apron — which is
   * where the lorries were always going, so it is the turn most of them take
   * rather than a wall they bounce off. `junctionT` is +X, -X and -Z at turn
   * 0, which is bridge, airport and cargo in that order, so it needs no
   * rotation at all.
   *
   * The +X arm is the one that has to be earned. A junction only works if
   * something actually arrives down every arm of it, and for a long time
   * nothing arrived down this one: the deck's curve finished 29 m west of
   * here, so the bridge crossed the whole tile from corner to corner and came
   * out the other side, leaving this arm pointing at grass. The crossing is
   * now solved backwards from this junction's east edge — see `CROSSING` in
   * `airportConfig` — and the deck ends on it to the millimetre.
   */
  { piece: 'junctionT', x: CARGO_TURN, z: 259, turn: 0, label: 'bridge and cargo junction' },
  /*
   * The parade's two crossings, a pair of junctions each.
   *
   * See `PARADE_LINKS` in `airportConfig` for why there are two of them and
   * why they are where they are. Each one is a T on the landside road and a T
   * on the outer road with a run between, which is what the west link already
   * is — the difference is only that these two land in the middle of a built
   * frontage rather than at the end of the island.
   *
   * The turns are the kit's, not guesses. `junctionT` at turn 0 is +X, -X and
   * -Z: on the outer road that is east, west and the link running SOUTH off
   * it, which is exactly right. On the landside road the stem has to point the
   * other way, so the tile is turned a half — +X and -X are still the road,
   * and -Z becomes +Z.
   */
  ...PARADE_LINKS.flatMap((at, i) => ([
    { piece: 'junctionT' as const, x: at, z: 154.5, turn: Math.PI, label: `parade link ${i + 1}, landside` },
    // Both links' outer ends are crossroads, and each north arm is a way
    // into the island station: the second link's onto the station road, the
    // first's straight into the car park through the gap in its hedge — see
    // `STATION_FORECOURT` in `islandRailConfig`. `junctionX` has all four
    // arms, so turn is moot.
    { piece: 'junctionX' as const, x: at, z: 259, turn: 0, label: i === 1 ? 'parade link 2 / station road' : 'parade link 1 / station car park' },
  ])),
  /*
   * The airport entrance, which is the same pair of tiles and deliberately so.
   *
   * It was the one road on this island that was not out of the kit: three
   * rectangles of slab with its kerbs, its lane lines and a central
   * reservation all painted on by hand. That was defensible when everything
   * here was slab. It is not now — a hand-drawn road beside three kit ones
   * reads as a different surface, because it is one, and the give-away was the
   * junctions: the kit roads meet at tiles with proper radii and crossings,
   * and this one met them at a painted flare.
   *
   * So the road is a link like the others and what makes it the entrance is
   * the SITE on it, which is where that reading belongs anyway: the gate, the
   * gatehouse, the sign gantry and the avenue. See `ENTRY` in `airportConfig`.
   */
  /*
   * The crossroads, and it is an X now rather than a T.
   *
   * The entrance used to stop dead here: you came off the outer road, drove
   * south, and met the landside road at a T with the airport on the far side
   * of it. So arriving meant turning twice and then driving the length of the
   * terminal to find a way onto the field.
   *
   * It goes straight through now. `junctionX` has all four arms — the link
   * north to the outer road, the landside road east and west, and the gate
   * road south through the fence onto the frontage apron — so the way in is
   * one line from the bridge to the aeroplanes with a single junction in it.
   * The terminal moved twenty metres south to let that line past its east end;
   * see `BUILDINGS` in `airportConfig`.
   *
   * `junctionX` has every arm, so its turn does not matter.
   */
  { piece: 'junctionX', x: ENTRY.centre, z: 154.5, turn: 0, label: 'airport crossroads' },
  // A crossroads rather than a T: its north arm is the way into the parcel
  // hub — see `COURIER_HUB` in `islandRailConfig`. `junctionX` has all four
  // arms, so turn is moot.
  { piece: 'junctionX', x: ENTRY.centre, z: 259, turn: 0, label: 'airport entrance / parcel hub' },
  // The parcel hub's north gate: a T with its stem north, half a turn as the
  // station exit's is, cut into the outer road below.
  { piece: 'junctionT', x: COURIER_HUB.gate2Centre, z: 259, turn: Math.PI, label: 'parcel hub north gate' },
];

/**
 * The runs between them.
 *
 * Every end is a corner's own edge rather than a round number, so the
 * straights meet the corner squarely: half the kit's width, 9.48 m, off the
 * corner's centre.
 */
const HALF = ROAD_WIDTH / 2;

/**
 * Every place the two long roads are joined, west to east.
 *
 * The airport entrance is in here with the parade's links because it IS one —
 * the same two tiles and the same run — and because both roads have to be cut
 * at all three of them by the same rule. What the entrance has that the others
 * do not is everything standing beside it; see `ENTRY`.
 */
const CROSS_LINKS = [...PARADE_LINKS, ENTRY.centre];

/**
 * One of the two long roads, cut into runs wherever a link crosses it.
 *
 * The links are junction TILES, and a tile is the road there — so each run has
 * to stop on the tile's edge and the next one start on its far edge. Written
 * once because both roads are cut at the same places and by the same rule.
 */
function roadSegments(
  z: number, from: number, to: number, label: string, extra: readonly number[] = [],
): RoadRun[] {
  const cuts = [...CROSS_LINKS, ...extra].filter((at) => at > from && at < to).sort((a, b) => a - b);
  const runs: RoadRun[] = [];
  let cursor = from;
  for (const at of cuts) {
    runs.push({ from: [cursor, z], to: [at - HALF, z], label });
    cursor = at + HALF;
  }
  runs.push({ from: [cursor, z], to: [to, z], label });
  /*
   * A road that ENDS on a junction leaves nothing after it, and a run of
   * nothing is not nothing: the component fills every run with the whole
   * number of straights nearest its length, and the nearest whole number to
   * zero is one — a 73 m piece squashed to a millimetre, which is a sliver of
   * carriageway standing on end in the junction it was supposed to follow.
   * The landside road does exactly this now that it stops on the airport
   * entrance, so anything shorter than a metre is dropped.
   */
  return runs.filter((r) => Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]) > 1);
}

export const ROAD_RUNS: readonly RoadRun[] = [
  /*
   * The landside road, east from the gate junction across the back of the
   * terminal forecourt. It stops where it always did.
   *
   * Three runs rather than one, because it now has two junctions in it and a
   * run drawn straight through a junction tile lays a carriageway over it —
   * lane markings, kerbs and all — which is a road with a road on top of it.
   * Each run stops half a tile short and starts half a tile past. Same for the
   * outer road below.
   */
  ...roadSegments(154.5, AIRPORT_GATE + HALF, PAVING.road[1], 'landside road'),
  {
    // The link between the two roads, north up the island's west end.
    from: [AIRPORT_GATE, 154.5 + HALF],
    to: [AIRPORT_GATE, 259 - HALF],
    label: 'west link',
  },
  {
    /*
     * The gate road: south off the junction onto the frontage apron.
     *
     * It stops on the apron's north edge rather than running out over it,
     * because past that line the ground is the airfield's own hard standing
     * and a painted carriageway on it would be a road drawn across an apron.
     * The perimeter wall crosses here too — see `PERIMETER.gates` — and its
     * gap is set from `AIRPORT_GATE` so the wall and the road cannot drift
     * apart, which they had: the gap was 16 m centred on -385 against a
     * carriageway that runs -404 to -386, so eleven metres of wall stood
     * across the road.
     *
     * 47 m is shorter than the kit's smallest straight, so the piece is
     * squashed to about two thirds. On a spur this length that shortens the
     * dashes and nothing else.
     */
    from: [AIRPORT_GATE, 154.5 - HALF],
    to: [AIRPORT_GATE, PAVING.frontage[3]],
    label: 'airfield gate road',
  },
  // The outer road, east from the north corner, past the bridge landing at
  // `PAVING.outerRoad[1]` and on to the cargo corner. Broken at the links.
  // Also cut at the station car park's way out, which is a T of its own.
  ...roadSegments(259, -395 + HALF, CARGO_TURN - HALF, 'outer road', [STATION_FORECOURT.exit, COURIER_HUB.gate2Centre]),
  // The station road, along the island station's front between its two tiles.
  {
    from: [STATION_FORECOURT.west + HALF, STATION_FORECOURT.road] as [number, number],
    to: [STATION_FORECOURT.exit - HALF, STATION_FORECOURT.road] as [number, number],
    label: 'station road',
  },
  {
    /*
     * The gate road: south off the crossroads, through the fence, onto the
     * apron.
     *
     * It stops on the frontage apron's north edge for the reason the hangar
     * gate road does — past that line the ground is the airfield's own hard
     * standing, and a painted carriageway on it would be a road drawn across
     * an apron. `PERIMETER.gates` carries the gap in the wall and takes it
     * from `ENTRY_ALONG` too, so the wall and the road cannot drift apart.
     */
    from: [ENTRY.centre, 154.5 - HALF],
    to: [ENTRY.centre, PAVING.frontage[3]],
    label: 'main gate road',
  },
  // The links themselves, north between the two roads. The entrance is the
  // last of them and is built exactly like the other two.
  ...CROSS_LINKS.map((at, i) => ({
    from: [at, 154.5 + HALF] as [number, number],
    to: [at, 259 - HALF] as [number, number],
    label: i < PARADE_LINKS.length ? `parade link ${i + 1}` : 'airport entrance',
  })),
  {
    /*
     * The cargo road: south down the island's east side to the freight apron.
     *
     * It runs between the park's hedge and the coast, parallel to the park
     * for its whole length, and stops on the north edge of `PAVING.cargo` —
     * so a lorry comes off the bridge, turns south at the corner and arrives
     * on the apron without ever crossing the terminal frontage or the
     * landside road, which is the whole point of it.
     */
    from: [CARGO_TURN, 259 - HALF],
    to: [CARGO_TURN, PAVING.cargo[3]],
    label: 'cargo road',
  },
];
