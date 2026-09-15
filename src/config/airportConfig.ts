/**
 * Halcyon Field: a made island east of the city, and the airport on it.
 *
 * ## Why it is its own island, and its own file
 *
 * The two islands the map already has belong to the railway. They are drawn in
 * `trainSketch.json`, they exist because the line has to cross the northern
 * bay, and three separate modules pick one of them **by area** — the station
 * takes the largest (`stationConfig`), the village the smallest
 * (`villageConfig`), the town the largest again (`townConfig`). Adding a third
 * island to `TRAIN_ISLANDS` that is bigger than either would therefore not add
 * an island; it would silently move the railway station onto it. So this one
 * is declared here, rendered by `AirportIsland`, and never enters that array.
 *
 * ## Where, and how big
 *
 * East, in open water. The nav raster runs out at about x = +200 on this side
 * of the map — everything beyond is sea — and the sea plane reaches x = +5050,
 * so there is room. The island sits at x 508..1532, which puts its near shore
 * about 350 m off the city's eastern edge: inside the 815 m far plane, so it
 * is a thing you can see from the shore rather than a rumour.
 *
 * "Double the station island" is meant literally. Kestrel is traced at
 * 115,524 m² and grown by `ISLAND_GROWTH` (1.08 across, 1.9 deep), so the land
 * that is actually there is 115,524 x 2.052 = **237,055 m²**. This is a stadium
 * — a rectangle with semicircular ends — 1,024 m long and 520 m wide:
 *
 *   straight   (1024 - 520) x 520  = 262,080 m²
 *   two ends   pi x 260^2          = 212,372 m²
 *   total                          = 474,452 m²
 *
 * against a target of 474,110. Within a tenth of a percent, and the shape is
 * not arbitrary: an airport wants one long axis, and a stadium is the shape a
 * runway would ask for if it could.
 *
 * ## The frame
 *
 * Same discipline as the station's town: **nothing below is a world
 * coordinate**. `AirportIsland` draws the lot inside one group at
 * `SITE.centre`, turned to `SITE.heading`, in which local **+X runs down the
 * runway** and local **+Z is north of it** — landside. Move the island by
 * editing `SITE` and everything on it moves with it.
 *
 * How much land there is at each station along the runway, measured off the
 * stadium rather than guessed, as half-width in metres either side of the axis:
 *
 * ```
 *   |x|      0    252    300    350    400    420    450    480
 *   half   260    260  255.5  240.8  213.8  198.4  168.5  125.0
 * ```
 *
 * The runway ends at |x| = 420, where there is still 198 m of half-width for a
 * strip that needs 142.5, and 62 m of land beyond each threshold for the
 * stopway. Nothing here is closer than 20 m to the beach.
 */

const TAU = Math.PI * 2;

/** Whether the island and its airport are part of the world at all. */
export const AIRPORT_ENABLED = true;

/**
 * Where the island is and which way its runway points.
 *
 * The heading is 12 degrees off the world axes on purpose. Axis-aligned, the
 * island reads as a placed object — every other shoreline on this map is a
 * traced curve, and a rectangle square to the horizon looks like a menu item.
 * Twelve degrees is enough to break that and little enough that the runway
 * still runs roughly out to sea at both ends.
 *
 * `ground` is the crown height: flat made land, a shade higher than the
 * railway islands' 3.2 m, because an airfield is graded and theirs is not.
 */
export const SITE = {
  centre: [1020, 210] as [number, number],
  heading: -0.209,
  ground: 3.4,
} as const;

/** The stadium: half the long axis, and the radius of each rounded end. */
export const ISLAND = {
  halfLength: 512,
  radius: 260,
  /** Metres of beach outside the outline, battered down to the seabed. */
  shore: 26,
} as const;

/** Half-width of the island at `x` along the runway — the envelope everything fits in. */
export const halfWidthAt = (x: number): number => {
  const straight = ISLAND.halfLength - ISLAND.radius;
  const over = Math.abs(x) - straight;
  if (over <= 0) return ISLAND.radius;
  if (over >= ISLAND.radius) return 0;
  return Math.sqrt(ISLAND.radius * ISLAND.radius - over * over);
};

/**
 * The outline, in the island's own frame.
 *
 * Generated rather than traced, because this island is a described shape and
 * not a drawn one — and because the beach skirt and the crown fan both need it
 * to stay star-shaped about the centre, which a formula guarantees and a hand
 * trace does not. 24 points round each end is a 7.5 degree step: at a 260 m
 * radius that is a 34 m chord, which from a boat is a curve.
 *
 * **Wound so that a fan over it faces UP**, which is the same trap
 * `trainConfig` documents for the drawn islands and which this fell into
 * anyway. In the XZ plane with Y up, a triangle's normal is +Y only when the
 * shoelace sum is negative; generated the obvious way — sweeping the angle
 * upward — it comes out positive, the crown's every triangle faces the seabed,
 * and with a front-facing material the island is simply not drawn. What you
 * get is a car apparently parked on the sea, with the buildings and the
 * runway floating above it, which is precisely what the first build looked
 * like. Reversing the sweep is the whole fix; the assertion below is so it can
 * never come back.
 */
export const OUTLINE: ReadonlyArray<readonly [number, number]> = (() => {
  const points: Array<[number, number]> = [];
  const straight = ISLAND.halfLength - ISLAND.radius;
  const STEPS = 24;
  // East end, sweeping from due north round to due south.
  for (let i = 0; i <= STEPS; i++) {
    const a = TAU / 4 - (i / STEPS) * (TAU / 2);
    points.push([straight + Math.cos(a) * ISLAND.radius, Math.sin(a) * ISLAND.radius]);
  }
  // West end, south round to north.
  for (let i = 0; i <= STEPS; i++) {
    const a = -TAU / 4 - (i / STEPS) * (TAU / 2);
    points.push([-straight + Math.cos(a) * ISLAND.radius, Math.sin(a) * ISLAND.radius]);
  }
  return points;
})();

/** Twice the signed area. Negative means a fan over the outline faces up. */
export const outlineShoelace = (): number => OUTLINE.reduce((sum, [x, z], i) => {
  const [nx, nz] = OUTLINE[(i + 1) % OUTLINE.length];
  return sum + (x * nz - nx * z);
}, 0);

/** The same outline in world XZ, for the minimap and anything else outside the group. */
export function outlineWorld(): Array<[number, number]> {
  const c = Math.cos(SITE.heading);
  const s = Math.sin(SITE.heading);
  // The group is rotated about +Y by `heading`, which takes local (x, z) to
  // (x cos + z sin, -x sin + z cos) in world — the same convention three uses.
  return OUTLINE.map(([x, z]) => [
    SITE.centre[0] + x * c + z * s,
    SITE.centre[1] - x * s + z * c,
  ] as [number, number]);
}

/* -------------------------------------------------------------- the airfield */

/**
 * The runway.
 *
 * 840 x 45 m. Short for an airliner and right for this island: a real 45 m
 * runway is a code-4 strip 2 km long, and 2 km of anything does not fit on a
 * kilometre of land. What it is sized to instead is what it has to *look*
 * like from a boat passing the end of it, and 840 m of tarmac with the correct
 * markings on it reads as a runway at any distance you can see it from.
 *
 * Offset to the south side (`centre` -120) so the whole of the landside — the
 * apron, the terminal, the road and the car park — has the wide part of the
 * island to sit in, rather than being spread along both sides of a strip up
 * the middle.
 */
export const RUNWAY = {
  centre: -120,
  half: 420,
  width: 45,
  /** The graded strip either side of the paving: grass, no markings. */
  strip: 70,
} as const;

/** The parallel taxiway, and the three links that join it to the runway. */
export const TAXIWAY = {
  centre: -55,
  half: 380,
  width: 18,
  /** Links at these stations along the runway. */
  links: [-380, 0, 380] as readonly number[],
} as const;

/**
 * The apron, the hangar apron in front of the sheds, and the road that serves
 * them. All plain rectangles in the island's frame: `[fromX, toX, fromZ, toZ]`.
 */
export const PAVING = {
  /**
   * The main apron. Its south edge is the taxiway's north edge, exactly: a
   * plan of the first version had six metres of grass between the two, which
   * is an apron nothing can taxi onto.
   */
  apron: [-230, 260, -46, 62] as const,
  /** The sheds' own apron, running west from the main one and joined to it. */
  hangarApron: [-480, -230, -46, 62] as const,
  /** The landside road: terminal frontage, then east past the car park. */
  frontage: [-250, 400, 132, 141] as const,
  /** Two spurs from the road down to the airside gates — one at the terminal,
   *  one at the sheds — so the landside and the apron are actually joined. */
  gate: [86, 95, 62, 132] as const,
  hangarGate: [-245, -236, 62, 132] as const,
  carPark: [268, 385, 132, 196] as const,
} as const;

/**
 * What is built, and out of what.
 *
 * Every one of these is a chunk of the city lifted whole (`collectCityParts`),
 * which is the same trick the island's village and the station's town are
 * built with. Nothing here is a new asset: a terminal is a 189 m row of city
 * frontage, a hangar is a wide two-storey block, and the control tower is the
 * one small building in the city that is taller than it is broad.
 *
 * | part                  | size (m)          | used as       |
 * | --------------------- | ----------------- | ------------- |
 * | `deco_Building_-5_-1` | 189 x 10 x 27     | terminal      |
 * | `deco_Building_-4_-2` | 93 x 9 x 62       | hangar        |
 * | `deco_Building_-4_-3` | 28 x 33 x 24      | control tower |
 * | `deco_Building_-4_-1` | 80 x 9 x 27       | freight shed  |
 * | `deco_Building_-3_2`  | 46 x 9 x 52       | fire station  |
 *
 * `turn` is radians about +Y in the island's frame; 0 leaves a chunk's own
 * long axis on the island's +X, which is down the runway.
 */
export interface AirportBuilding {
  part: string;
  x: number;
  z: number;
  turn: number;
  label: string;
}

export const BUILDINGS: readonly AirportBuilding[] = [
  // Landside frontage, set back behind the road, facing the apron.
  { part: 'deco_Building_-5_-1', x: -20, z: 170, turn: 0, label: 'terminal' },
  { part: 'deco_Building_-4_-1', x: 150, z: 170, turn: 0, label: 'arrivals' },
  { part: 'deco_Building_-3_2', x: -170, z: 168, turn: 0, label: 'fire station' },
  // The tower, off the apron's east corner: clear of the service gate, which
  // it stood squarely on the first time round, and with both thresholds in
  // sight down the length of the field.
  { part: 'deco_Building_-4_-3', x: 250, z: 100, turn: 0, label: 'control tower' },
  // The sheds, their doors a metre off the north edge of the hangar apron.
  { part: 'deco_Building_-4_-2', x: -300, z: 96, turn: 0, label: 'hangar one' },
  { part: 'deco_Building_-4_-2', x: -420, z: 96, turn: 0, label: 'hangar two' },
] as const;

/** One tree, one piece of street furniture, one car — the city's own. */
export const TREE_PART = 'deco_Vegetation_-3_-3';
export const PROP_PART = 'deco_Accesories_-4_-2';

/**
 * The lights, which are most of what makes this read as an airfield.
 *
 * A runway in daylight is a grey strip with paint on it. What says *airport*,
 * and says it from a kilometre away across water, is the lighting pattern:
 * white edges in two dead-straight lines, green at the approach end, red at
 * the stop end, and blue down the taxiway. They are 0.5 m emissive boxes, one
 * instanced mesh per colour, so the whole airfield's lighting is four draw
 * calls.
 */
export const LIGHTS = {
  edgeSpacing: 60,
  approachLength: 220,
  approachSpacing: 30,
  colours: {
    edge: '#f3efe0',
    threshold: '#35e06a',
    stop: '#e0402f',
    taxi: '#3aa0ff',
  },
} as const;

/** The paint. Widths in metres; everything is drawn a centimetre over the tarmac. */
export const MARKS = {
  colour: '#e9e6dc',
  taxiColour: '#e0c23a',
  centreDash: 30,
  centreGap: 20,
  centreWidth: 0.9,
  edgeWidth: 0.9,
  /** The piano keys: how many stripes a side, how long and how wide. */
  thresholdBars: 6,
  thresholdLength: 40,
  thresholdWidth: 2.4,
  thresholdGap: 1.8,
  /** The aiming point blocks, this far in from each threshold. */
  aimingAt: 250,
  aimingLength: 45,
  aimingWidth: 6,
} as const;
