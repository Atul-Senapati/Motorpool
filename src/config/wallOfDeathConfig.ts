/**
 * The Wall of Death — *maut ka kuan* — on Halcyon Field's landside.
 *
 * ## What it is
 *
 * A motordrome: a wooden-walled drum that motorcycles (and, in the Indian
 * fairground version, small cars) ride round on the VERTICAL wall, held there
 * by friction and centripetal force, while the crowd watches from a gallery
 * along the top edge. The real ones are 6 to 11 m across and 4.6 to 7.6 m
 * high, with the bottom of the wall banked so a rider can get from the floor
 * onto the vertical without a step.
 *
 * ## Why it is three times the real thing
 *
 * Because the PLAYER rides it. A touring drome is sized for a 1930s Indian
 * Scout; a McLaren F1 is 4.3 m long and 1.8 m wide, and it goes in through
 * the door and up the wall like the bikes do. Two things set the size:
 *
 * - **The transition has to be a curve, not a corner.** A raycast vehicle
 *   crossing a 45° crease loses wheel contact on one axle and lands on the
 *   other; a quarter-circle bank of radius `bank` keeps all four rays on
 *   the surface all the way from the floor to the vertical. Six metres is
 *   a little over a wheelbase and a half, which is what makes it smooth.
 * - **The wall has to be ridable at a speed a car can hold.** On a vertical
 *   wall the tyres carry the car's weight sideways, so it stays up only
 *   while `v² / R ≥ g / μ` — at 16 m and unit grip that is 45 km/h, and
 *   comfortable at 70. Smaller drums need proportionally more speed in less
 *   room; bigger ones start to read as a velodrome.
 *
 * So: 40 m across at the foot, a 9 m bank and 12 m of timber leaning
 * outward at 72° above it, closed all the way round. The NPC bikes and cars
 * ride the same wall, leaning off it by the same physics.
 *
 * ## Modern, not vintage
 *
 * The touring walls are red-painted board and canvas. This is a permanent
 * attraction next to an airport and an amusement pier, so it is dressed the
 * way a new one would be: graphite panelling on the outside with brushed
 * steel ribs, two LED rings round the drum, a canopy brim over the gallery on
 * sixteen columns, a lit sign pylon and a ticket kiosk. The inside of the
 * drum is still timber, because that is the surface everybody recognises.
 *
 * ## Where
 *
 * On the grass north of the outer road at `along` 330 — see `WOD_SITE` for
 * `across`. It was put "where the track ended", when the island railway's
 * trunk stopped at (286, 331). The trunk has since been carried on past it:
 * from along 355 it swings east and runs straight south to the sea wall, and
 * at its closest the down main is 30 m from the drum's centre — under the
 * canopy's brim, which is 21 m up, and well clear of the drum's foot. See
 * `WOD_SITE` and `TRUNK`.
 *
 * Everything below is in the island's frame — `x` is `along`, `z` is
 * `across`, `y` is metres above the crown — and drawn inside the island's
 * group by `WallOfDeath`.
 */

export const WALL_OF_DEATH_ENABLED = true;

/** Where the drum's centre stands, and how the whole thing is turned. */
export const WOD_SITE = {
  /**
   * 245, then 265, now 330: the parcel hub grew north and the user asked
   * for the drome "more north" twice. What bounds it is not the canopy — its
   * brim is 21 m up, far over any train — but the drum's foot, 21.6 m from
   * the centre with the plinth, and the tracks' beds: the down main never
   * comes within 30 m of this row (30.0 at along 340, its nearest), and PF1's
   * spur runs at across 335.6, 31.6 m off it. North of about 370 the bridge
   * corner (along 410 on) is kept clear.
   */
  along: 330,
  /**
   * Hard up against the outer road: the forecourt's front edge is a metre
   * off the road's north kerb at `across` 268.5, and the drum's foot stands
   * at 324. It was 358, in the middle of the field; the user asked for it
   * brought down to the road "such that the train track can pass behind
   * comfortably". The trunk did not in the end run on straight past it —
   * that would have been seven metres off the drum's foot and under the
   * canopy's brim — but curves east behind it instead, 15 m clear of the
   * brim. See `TRUNK`.
   */
  across: 304,
  /** The forecourt and its halo face `-across`, toward the outer road, at turn 0. */
  turn: 0,
} as const;

/** The drum: inner radius, wall height and the curved bank at its foot. */
export const DRUM = {
  /**
   * The slab the whole ride stands on. Flush with the apron rather than a
   * raised plinth, because a car has to drive onto it: the crown under it is
   * the collider, exactly as the airfield's own paving works.
   */
  plinth: { height: 0.06, margin: 1.1 },
  /**
   * Radius at the foot of the wall: a 40 m drome. It went 20, 32, 44, 52 m
   * as the user asked for bigger, and then back to 40 when 52 "looked too
   * big" — which it did; from the gallery it read as a stadium. The floor
   * inside the bank is 23 m across, still room to build speed in.
   */
  radius: 20,
  /** The wall's height, from the top of the bank to the gallery. */
  wall: 12,
  /**
   * The wall's angle from horizontal, degrees.
   *
   * A real wall of death is 90°, and 90° was tried: it needs `v² / R ≥ g / μ`
   * — over 60 km/h on the rear tyres' grip here — held EXACTLY, with nothing
   * under the car but friction, and the user could not ride it smoothly. At
   * 72° the wall leans outward like a bowl: a share of the car's weight
   * presses it into the surface, the speed it takes to stay up drops by a
   * third, and losing a little speed slides you down the bank instead of
   * dropping you off the wall. Still steep enough to read as a wall from the
   * gallery; the NPC riders lean on it by the same physics as before.
   */
  slope: 72,
  /**
   * Radius of the bank between the floor and the wall. Bigger is gentler:
   * nine metres is two wheelbases, and the suspension barely notices the
   * transition at 80 km/h.
   */
  bank: 9,
  /**
   * There is no doorway. A slot through the bank is a wall you hit once a
   * lap, and a door that shuts behind you is a mechanism nobody asked for.
   * The drum is closed all the way round, inside and out, and you get in the
   * way you get into a Vice City mission: drive into the halo on the
   * forecourt and press Enter — see `PORTAL`.
   */
  /** The outer skin sits this far outside the inner wall; the ribs stand proud of it. */
  skin: 0.35,
  ribs: { count: 24, width: 0.16, depth: 0.3 },
  /** The LED bands round the outside: their heights above the slab and thickness. */
  bands: { low: 3.4, high: 15.2, thick: 0.18 },
} as const;

/**
 * The drum's shape, derived once from `DRUM` for everything that is not the
 * drawing itself — the cameras, the portals — so nobody re-derives the bank's
 * height from the slope and gets it a little wrong.
 */
export const DROME_SHAPE = (() => {
  const slope = (DRUM.slope * Math.PI) / 180;
  const kickTop = DRUM.bank * (1 - Math.cos(slope));
  const top = kickTop + DRUM.wall;
  const topRadius = DRUM.radius + DRUM.wall / Math.tan(slope);
  return {
    slope,
    /** Where the floor ends and the bank begins. */
    floorRadius: DRUM.radius - DRUM.bank * Math.sin(slope),
    /** Top of the bank, foot of the wall. */
    kickTop,
    /** The gallery deck. */
    top,
    /** The wall's radius at the gallery. */
    topRadius,
    /** The riding surface's radius at height `y`. */
    rideAt: (y: number) => (y <= kickTop ? DRUM.radius : DRUM.radius + (y - kickTop) / Math.tan(slope)),
  };
})();

/** The gallery along the top, its rail and the canopy over it. */
export const GALLERY = {
  /** How far the deck reaches outward from the inner wall. */
  width: 3.2,
  deck: 0.3,
  rail: { height: 1.1, postEvery: 6 },
  canopy: {
    /** Columns from the deck to the brim, on this radius outside the wall. */
    columns: 20,
    columnAt: 2.4,
    /** The brim: a cone frustum from the inner edge (low) to the outer edge (high). */
    innerAt: -0.8,
    outerAt: 5.5,
    /** Heights over the deck at its inner and outer edges. */
    lowAt: 3.6,
    highAt: 4.7,
  },
} as const;

/** The two straight stairs up to the gallery, one each side. */
export const STAIRS = {
  /** Rise per step and going. */
  rise: 0.32,
  going: 0.3,
  width: 1.8,
  /** Which sides they stand on, as angles round the drum (0 is the door, at the front). */
  at: [Math.PI / 2, -Math.PI / 2] as const,
} as const;

/** The forecourt in front of the door, and the road down to the outer road. */
export const APRON = {
  /** Half-width of the forecourt either side of the centreline, and how deep it is. */
  half: 28,
  depth: 13,
  /** The way in from the outer road's north kerb (`across` 268.5): a car's width and more. */
  path: { half: 5, to: 268.5 },
  top: 0.06,
} as const;

/**
 * The halo markers: one on the forecourt that puts you inside, one on the
 * drum floor that puts you back out.
 *
 * `radius` is the standing zone — the car's centre inside it is what shows the
 * prompt — and `height` is how tall the glow is drawn. `entry.dz` is where the
 * outside marker stands in front of the drum; the exit marker is the floor's
 * centre. `cooldown` stops the one you land on firing straight back.
 *
 * Landing poses are the drum's frame: inside, at the centre facing `+along`
 * with the whole floor to build speed on; outside, back on the forecourt
 * behind the entry halo facing the road.
 */
export const PORTAL = {
  radius: 4.5,
  height: 3.6,
  entry: { dz: -29 },
  /** Where Enter puts you on the way out: beside the entry halo, facing the road. */
  exit: { dx: 9, dz: -28 },
  cooldown: 1.5,
  colours: { entry: '#f2c766', exit: '#f3ecdc' },
} as const;

/**
 * The totem sign and the ticket kiosk, offset from the drum centre.
 *
 * `pylon` is the totem: `board.width` is the slab's width, `post` its depth,
 * `height` how tall it stands, `board.height` how much of the top carries
 * the lettering.
 */
export const FURNITURE = {
  pylon: { dx: -14, dz: -32, height: 9, post: 0.5, board: { width: 1.9, height: 7.4 } },
  kiosk: { dx: 18, dz: -30, width: 3.4, depth: 2.8, height: 2.6 },
  /** The marquee on the front of the drum, over where a door would be. */
  marquee: { width: 9, height: 1.8, over: 0.9 },
} as const;

/**
 * The show: who rides the wall, how fast, and in what wave.
 *
 * The two bikers are the models dropped in the repo — `prepare-bikers.mjs`
 * bakes them — and the car is one of the city's own traffic cars, picked out
 * of `vehicles.glb` by name. Each rides at its own speed, and the speed is
 * not decoration: `WallRider` leans every machine by `atan(g R / v²)` off
 * the wall, so the slower car sits visibly further up the wall than the
 * bikes, the way it does in the real show.
 */
export interface Rider {
  kind: 'male' | 'female' | 'car';
  /** For a car: which of the traffic pack rides. Defaults to `SHOW.trafficCar`. */
  car?: string;
  /** For a car: repaint the bodywork this colour. The pack's own livery otherwise. */
  tint?: string;
  /** Ground speed on the wall, m/s. */
  speed: number;
  /** Where in the circuit the rider starts, radians. */
  phase: number;
  /** The height band ridden, metres above the top of the bank. */
  band: { low: number; high: number };
  /** Period of the climb-and-dive wave, seconds, and its phase. */
  wave: { period: number; phase: number };
}

export const SHOW = {
  /** Which of the traffic pack's cars rides. It has to carry a `wheel` mesh. */
  trafficCar: 'Hatchback_Body',
  riders: [
    { kind: 'male', speed: 17, phase: 0, band: { low: 1.5, high: 8 }, wave: { period: 8.5, phase: 0 } },
    { kind: 'female', speed: 16.5, phase: Math.PI / 2, band: { low: 2.5, high: 9 }, wave: { period: 10, phase: 2.1 } },
    { kind: 'car', speed: 15.5, phase: Math.PI, band: { low: 1.0, high: 5.5 }, wave: { period: 12, phase: 4.0 } },
    { kind: 'car', car: 'Coupe_Body', speed: 16, phase: Math.PI * 3 / 2, band: { low: 1.5, high: 6.5 }, wave: { period: 9, phase: 1.0 } },
    // The red one, asked for by name: the pack's sports car in stunt-team red.
    { kind: 'car', car: 'Sport_body', tint: '#d4161c', speed: 17.5, phase: Math.PI / 4, band: { low: 3.0, high: 8.5 }, wave: { period: 7.5, phase: 3.0 } },
  ] as readonly Rider[],
  /** A bike standing by the kiosk, on the ground. */
  parked: { who: 'male' as const, dx: 13, dz: -27, turn: 0.4 },
} as const;

/**
 * Parked cars: the city's own traffic pack, standing still.
 *
 * Two outside by the forecourt's edges, nosed in toward the drum — the user
 * asked for no more than two out there — and ONE inside: the blue saloon,
 * parked just off the inner circle (the cyan exit halo, 4.5 m) so it is the
 * first thing you see when Enter lands you at the centre, and the only thing
 * on the floor between you and the bank. `turn` is the yaw; the pack faces
 * −Z at turn 0. Every one gets a collider. `tint` repaints the bodywork.
 */
export const PARKED_CARS: readonly {
  name: string; dx: number; dz: number; turn: number; tint?: string;
}[] = [
  // Outside.
  { name: 'SUV_Body', dx: -25, dz: -27, turn: -1.35 },
  { name: 'minivan_body', dx: 25, dz: -28, turn: 1.3 },
  // Inside: the blue car, beside the inner circle.
  { name: 'Sedan_Body', dx: 6.8, dz: 1.5, turn: Math.PI / 2 + 0.2, tint: '#1f5fd6' },
];

export const WOD_COLOURS = {
  plinth: '#7d8087',
  apron: '#8c8f96',
  floor: '#34363a',
  floorMark: '#e6e2d8',
  timber: '#b07a45',
  /**
   * The outside: minimal, in two colours — teal and creamy white, the pair
   * the user named after trying most of the wheel.
   *
   * Teal on the plumb foot, the canopy, the ribs and the trim; a soft creamy
   * white on the leaning wall between them, so the drum reads as a cream
   * bowl sitting in a teal ring under a teal lid. Warm gold for the one ring
   * of light, the totem's hairline and the halo. Two colours and a line of
   * light; nothing else.
   */
  skin: '#1f6b73',
  skinWall: '#f3ecdc',
  ribs: '#2a7a82',
  trim: '#18555c',
  steel: '#9aa3ad',
  accent: '#f2c766',
  cool: '#f2c766',
  canopy: '#1f6b73',
  deck: '#18555c',
  kiosk: '#f3ecdc',
  glass: '#9fd3e8',
  sign: { back: '#1f6b73', text: '#f3ecdc', sub: '#f2c766' },
} as const;

/**
 * Where trees must not be planted: the whole site plus the way in.
 * `[along0, along1, across0, across1]`, for `AirportIsland`'s scatter.
 */
export const WOD_BOUNDS = [
  WOD_SITE.along - 36, WOD_SITE.along + 36,
  APRON.path.to, WOD_SITE.across + DRUM.radius + DRUM.wall / Math.tan((DRUM.slope * Math.PI) / 180)
    + GALLERY.canopy.outerAt + 6,
] as const;
