import { ROAD_WIDTH } from './roadConfig';
import { ARC_CORNERS, avenue, CROSS, KESTREL_SWEEPS, sweepPoints } from './kestrelRoads';
import { STATION_SITE } from './stationConfig';
import sportsData from './sportsHallData.json';
import assemblyData from './assemblyHallData.json';
import jacksData from './jacksShopData.json';
import tilesData from './tilesShopData.json';

/**
 * The sporting hall and the assembly hall: the two empty blocks between the
 * Hall of Justice and the level crossing.
 *
 * ## Which blocks
 *
 * Kestrel's grid has fourteen blocks and the school, the park, the Hall of
 * Justice and the mall already hold four of them (`kestrelSchool`,
 * `kestrelPark`, `kestrelCivic`, `kestrelMall`). The two on the **station
 * avenue** side, south of the Hall of Justice — between the dock cross and the
 * stage cross, and the stage cross and the crossing — are the next ones along
 * the same avenue, which makes the avenue the town's civic frontage: justice,
 * sport, assembly, each across the street from the station.
 *
 * ## Fitted, not placed
 *
 * Both are bigger than a block (`ROAD_WIDTH` is 19 m, so a 93 x 89 m block is
 * 74 x 70 between the kerbs). Each is turned so its long axis runs along the
 * block's long side — `across` is the wider — and scaled to the largest size
 * that leaves `VERGE` of grass all round, the way the Hall of Justice is. The
 * fronts face the station avenue: they are the arrival side.
 */

/** Half the kit's carriageway: how far a kerb stands off an avenue's centre. */
const HALF = ROAD_WIDTH / 2;

/** Grass between a hall and the kerb, metres. */
const VERGE = 4;

interface HallModel {
  model: string;
  /** Width (X), height (Y), depth (Z), metres. */
  size: [number, number, number];
  /** How far the slab reaches below its deck. Buried, not stood on. */
  skirt: number;
  triangles: number;
}

const model = (d: { model: string; size: number[]; skirt: number; triangles: number }): HallModel => ({
  model: d.model, size: d.size as [number, number, number], skirt: d.skirt, triangles: d.triangles,
});

export const SPORTS_HALL = model(sportsData);
export const ASSEMBLY_HALL = model(assemblyData);

/**
 * The two blocks, as kerb lines. By street name for the avenues: an index is a
 * promise about the order of a list that gets edited.
 */
const blockOf = (from: number, to: number) => ({
  acrossFrom: avenue('station avenue') + HALF,
  acrossTo: avenue('stage avenue') - HALF,
  alongFrom: CROSS[from] + HALF,
  alongTo: CROSS[to] - HALF,
});

export const SPORTS_BLOCK = blockOf(3, 4);
export const ASSEMBLY_BLOCK = blockOf(4, 5);

/**
 * Which way round each stands: the model's own +Z is its front (the porch),
 * and at turn 0 the group's local Z is `along`. -PI/2 swings +Z onto -`across`,
 * so the front looks at the station avenue and the long axis runs along
 * `across`, the block's longer side.
 */
const FRONT_TURN = -Math.PI / 2;

function fit(block: ReturnType<typeof blockOf>, hall: HallModel, turn: number) {
  if (!STATION_SITE) return null;
  const width = block.acrossTo - block.acrossFrom;
  const length = block.alongTo - block.alongFrom;
  // A quarter turn swaps which model axis lies along which block side.
  const quarter = Math.abs(Math.sin(turn)) > 0.5;
  const mx = quarter ? hall.size[2] : hall.size[0];
  const mz = quarter ? hall.size[0] : hall.size[2];
  const scale = Math.min(1, (width - VERGE * 2) / mx, (length - VERGE * 2) / mz);
  if (scale <= 0) return null;
  return {
    across: (block.acrossFrom + block.acrossTo) / 2,
    along: (block.alongFrom + block.alongTo) / 2,
    scale,
    turn,
    footprint: [mx * scale, mz * scale] as [number, number],
    height: hall.size[1] * scale,
    block: [width, length] as [number, number],
  };
}

export const SPORTS_SITE = fit(SPORTS_BLOCK, SPORTS_HALL, FRONT_TURN);
/**
 * The assembly hall stands 6 m west of its block's middle: the block's east
 * corner is now the inside of a swept bend (`ARC_CORNERS`), and centred, the
 * hall's corner came within two metres of that bend's footway.
 */
const ASSEMBLY_SHIFT = -6;
export const ASSEMBLY_SITE = (() => {
  const site = fit(ASSEMBLY_BLOCK, ASSEMBLY_HALL, FRONT_TURN);
  return site ? { ...site, along: site.along + ASSEMBLY_SHIFT } : null;
})();

/**
 * Where a block's corner is cut away by a swept bend: the bend's centre and the
 * radius of its inner edge (footway included). `KestrelPlazas` stops its paving
 * on this curve rather than laying it over the road.
 */
export function blockCut(block: { acrossTo: number; alongTo: number }) {
  const c = ARC_CORNERS.find((k) => Math.abs(k.across - HALF - block.acrossTo) < 0.5
    && Math.abs(k.along - HALF - block.alongTo) < 0.5);
  if (!c) return null;
  return { across: c.across - c.radius, along: c.along - c.radius, radius: c.radius - HALF };
}

/* ------------------------------------------------------------------ shops */

/**
 * Two shops beside the station, on the grass south of the line.
 *
 * They stood on the strip east of the stage avenue with a third, the Mac shop,
 * until the user had the Mac shop taken out and these two moved next to the
 * station building, where the people coming off the trains are. The ground
 * east of the station hall, between the south platform's back path and the
 * shore road, was an empty field: the hall ends at along 45.5, and the shore
 * road holds at −72 to along 60 before its S-bend lifts it north (`KESTREL_SWEEPS`),
 * so its kerb runs from −62.5 to −52.6 across the shops' frontage.
 *
 * Both face the road (fronts to −across), set back to one line at `SHOP_FRONT`,
 * and keep the size they had: scaled to fit 38 and 36 m plots.
 */
export const SHOP_MODELS = {
  jacksShop: model(jacksData),
  tilesShop: model(tilesData),
};
export type ShopName = keyof typeof SHOP_MODELS;

/** The shops' street face, across: clear of the road's kerb by 8–16 m. */
const SHOP_FRONT = -46;

/**
 * Each shop's own front. The tile shop's is -Z (its blue shutter frontage and
 * sign are on the model's low-z side), so it takes the opposite quarter turn to
 * Jack's, whose front is +Z. Either way the front ends up looking at −across.
 */
const SHOP_PLACES: { name: ShopName; from: number; to: number; turn: number; plot: number }[] = [
  { name: 'jacksShop', from: 50, to: 82, turn: FRONT_TURN, plot: 38 },
  // Up against Jack's: its building ends at along 74.5 and its back shed at
  // 79.4 (measured off its collider boxes) — the rest of its plot is apron.
  { name: 'tilesShop', from: 81, to: 111, turn: -FRONT_TURN, plot: 36 },
];

export const SHOP_SITES = SHOP_PLACES.flatMap((place) => {
  if (!STATION_SITE) return [];
  const m = SHOP_MODELS[place.name];
  // Quarter-turned, so the model's X lies along `along`.
  const scale = Math.min(1, (place.plot - 3 * 2) / m.size[0]);
  const depth = m.size[2] * scale;
  return [{
    name: place.name,
    across: SHOP_FRONT + depth / 2,
    along: (place.from + place.to) / 2,
    scale,
    turn: place.turn,
    footprint: [depth, m.size[0] * scale] as [number, number],
    height: m.size[1] * scale,
    block: [0, place.to - place.from] as [number, number],
  }];
});

/* ------------------------------------------------------------- car parks */

export interface ParkingLot {
  acrossFrom: number;
  acrossTo: number;
  alongFrom: number;
  alongTo: number;
  /** Bay rows, as [start, depth] metres from `acrossFrom`. Bays are 2.6 m along. */
  rows: Array<[number, number]>;
  /**
   * The lot's `acrossFrom` edge as a curve instead of a straight line: across at
   * an `along`. For a lot that runs up to a road that bends away from it.
   */
  edge?: (along: number) => number;
}

/**
 * The shore road's outer edge on its north side, at an `along` east of the
 * station: the S-bend (`KESTREL_SWEEPS`) offset half a road square to its own
 * direction — not straight across, which on the bend lands short of the edge
 * and laid the car park over the painted footway.
 */
const SHORE_EDGE: Array<[number, number]> = (() => {
  const points = sweepPoints(KESTREL_SWEEPS.find((w) => w.label === 'east shore bend')!);
  return points.map(([a, l], i) => {
    const [pa, pl] = points[Math.max(0, i - 1)];
    const [qa, ql] = points[Math.min(points.length - 1, i + 1)];
    const len = Math.hypot(qa - pa, ql - pl) || 1;
    // The normal on the +across (north) side.
    let na = (ql - pl) / len;
    let nl = -(qa - pa) / len;
    if (na < 0) { na = -na; nl = -nl; }
    return [a + na * HALF, l + nl * HALF] as [number, number];
  });
})();

function shoreKerb(along: number): number {
  const e = SHORE_EDGE;
  for (let i = 0; i + 1 < e.length; i++) {
    const [a0, l0] = e[i];
    const [a1, l1] = e[i + 1];
    if ((l0 - along) * (l1 - along) <= 0) return a0 + ((a1 - a0) * (along - l0)) / (l1 - l0 || 1);
  }
  return along < e[0][1] ? e[0][0] : e[e.length - 1][0];
}

/** The car park's back edge, behind the shops: clear of the platform's back path. */
const LOT_BACK = -19.5;

export const PARKING_LOTS: ParkingLot[] = [
  // In front of and under the shops: one row nose-in to their fronts.
  {
    acrossFrom: shoreKerb(50), acrossTo: LOT_BACK, alongFrom: 50, alongTo: 116,
    rows: [[SHOP_FRONT - 0.5 - 4.8 - shoreKerb(50), 4.8]], edge: (along) => shoreKerb(along) + 0.1,
  },
  // East of the tiles shop to along 172: two rows with the aisle between.
  {
    acrossFrom: shoreKerb(116), acrossTo: LOT_BACK, alongFrom: 116, alongTo: 172,
    rows: [[-36 - shoreKerb(116), 5], [LOT_BACK - 5 - shoreKerb(116), 5]],
    edge: (along) => shoreKerb(along) + 0.1,
  },
];

/**
 * A few cars standing in the bays, so the car park reads as one: which lot,
 * which row, which bay along it (counting from the lot's west end), and which
 * way the nose points across (+1 north, −1 south). Nose-in to the shops, and
 * nose-in to each row's head line past them.
 */
export const PARKED_CARS: Array<{ part: string; lot: number; row: number; bay: number; nose: 1 | -1 }> = [
  { part: 'Sedan_Body', lot: 0, row: 0, bay: 4, nose: 1 },
  { part: 'SUV_Body', lot: 0, row: 0, bay: 15, nose: 1 },
  { part: 'Hatchback_Body', lot: 1, row: 1, bay: 3, nose: 1 },
  { part: 'Pickup_Body', lot: 1, row: 0, bay: 6, nose: -1 },
];

/** Nothing to build without a station frame to build it in. */
export const HALLS_ENABLED = SPORTS_SITE !== null || ASSEMBLY_SITE !== null || SHOP_SITES.length > 0;
export const PARKING_ENABLED = STATION_SITE !== null;
