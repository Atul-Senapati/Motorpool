/**
 * The fleet: six hulls, two of them drivable, and how a boat behaves on water.
 *
 * The measurements come from `boatData.json`, which `prepare-boats.mjs` writes
 * off the models themselves — length, beam, air draught, triangles. Everything
 * below is what a mesh cannot tell you: how heavy the thing is, how hard it
 * pushes, how quickly it answers the helm.
 *
 * ## Why a boat is not a car with a different mesh
 *
 * The car physics is a raycast vehicle: four springs, four contact patches,
 * grip as a function of slip. None of that exists at sea. What replaces it is
 * three forces and one torque, and the character of every boat here is in
 * their balance:
 *
 *   buoyancy   a damped spring pulling the hull to the height of the water
 *              under it, stiffened by its own waterplane times ρg — so a
 *              heavy hull answers a wave more slowly than a light one without
 *              that being written anywhere. The wave is sampled at the bow,
 *              the stern and both beams, and the difference between those
 *              samples IS the pitch and the roll.
 *   thrust     along the hull, from the throttle. A propeller pushes whichever
 *              way the boat points, which is why a boat can be moving one way
 *              and pointing another — see the drag split below.
 *   drag       quadratic, and **anisotropic**: a hull slips forward easily and
 *              resists sideways enormously. That ratio is what a keel is, and
 *              it is what makes a boat feel like a boat — it slides wide out of
 *              a turn and then tracks straight again as the hull bites.
 *   the helm   a yaw torque that only works when water is moving past the
 *              rudder, so a stopped boat cannot turn on the spot and a fast one
 *              answers instantly. Reverse turns the sense of it, exactly as it
 *              does in a real boat going astern.
 *
 * ## Integrated here, not by the solver
 *
 * The boats are kinematic bodies whose motion is integrated by `BoatRide`
 * rather than dynamic bodies pushed about by Rapier. Two reasons, and the
 * second is the one that matters: what holds a boat up is a force field
 * rather than a contact, so a dynamic hull spends its life arguing with the
 * solver about a surface that is not there — and a model integrated in plain
 * TypeScript can be run outside the browser and *measured*, which is where
 * every number in this file came from. Full helm at full speed gives the
 * yacht a 58 m circle (3.5 of its own lengths) and a 13° crab angle; the
 * ferry comes round in 674 m. Those are the readings, not estimates.
 *
 * The drag coefficient is derived from the stated top speed rather than
 * enforced alongside it (`dragFor`), so raising `topKph` raises the top speed
 * AND softens the drag that used to hold the boat below it — thrust stays the
 * real figure. What that costs is time: the yacht reaches nine tenths of 150
 * km/h in about thirteen seconds, the cruiser in nine, which is a long haul
 * up rather than a wall to hit.
 *
 * The collider still earns its place: a kinematic body shoulders dynamic ones,
 * so a hull is a solid thing that can shove a car off a slipway rather than a
 * hologram.
 */
import data from './boatData.json';
import { SEA_LEVEL, SEA_REACH } from './seaConfig';

export interface BoatHull {
  id: string;
  label: string;
  /** Beam (X), height above the waterline (Y), length (Z) — metres. */
  size: [number, number, number];
  /** How deep it floats, metres below the waterline. */
  draught: number;
  triangles: number;
}

export const BOAT_MODEL = '/models/boats.glb';

export const HULLS: Record<string, BoatHull> = Object.fromEntries(
  (data.boats as BoatHull[]).map((b) => [b.id, b]),
);

/** What it takes to drive one. */
export interface BoatSpec {
  id: string;
  /** Displacement, kg. Real boats, real figures. */
  mass: number;
  /** Full-ahead propeller thrust, newtons. */
  thrust: number;
  /** Astern is always weaker: a propeller in reverse is a bad propeller. */
  astern: number;
  /**
   * Flat-water top speed, km/h — the number the drag coefficient is derived
   * from rather than a number that is separately enforced. See `dragFor`.
   */
  topKph: number;
  /**
   * Helm authority: radians per second of yaw at cruising speed, at full
   * rudder. A short boat spins; a 200 m ship does not.
   *
   * Set from the turning circle each hull should have rather than by feel,
   * because a turning circle is a published figure and "feels about right" is
   * not: radius = speed / yaw rate. The ferry was at 0.05 and turned inside
   * its own length, which for 203 m of ship is pure cartoon; 0.012 gives it
   * the 600 m circle it ought to have.
   *
   * The two drivable boats are re-measured every time their top speeds move,
   * because above `helmFull` the yaw rate saturates at this figure and the
   * circle is speed over yaw rate — leave it alone and the circle opens by
   * whatever factor the speed grew. Not scaled in proportion, though: a boat
   * loses a third of its speed in a sustained turn, so the arithmetic
   * overshoots badly. These come off the same offline integration everything
   * else here does — at 150 km/h, 0.41 holds the yacht at 4.1 of its own
   * lengths and 0.73 holds the cruiser at 3.7, which is where they were.
   */
  helm: number;
  /** How far the hull heels outward through a turn, radians at full helm. */
  heel: number;
}

/**
 * The two you can take out, and the four that run themselves.
 *
 * The yacht and the cruiser are the drivable pair, and they are chosen for
 * contrast rather than for looks: 16.6 m against 8.6 m, eight tonnes against
 * one and a half, a boat that has to be *placed* into a turn against one that
 * darts. Driving both back to back is the point — the same water feels
 * completely different under them, which is the argument for boat physics at
 * all.
 */
export const BOATS: Record<string, BoatSpec> = {
  // A 16.6 m flybridge motor yacht: eight tonnes, twin diesels, and a great
  // deal more power than the real thing has. 150 km/h is 81 knots, which is
  // offshore-race territory rather than flybridge territory — the bay is
  // large and mostly empty, and a displacement-speed boat spends it crossing
  // water rather than driving over it.
  yacht: { id: 'yacht', mass: 8200, thrust: 38000, astern: 12000, topKph: 150, helm: 0.41, heel: 0.09 },
  // An 8.6 m cabin cruiser. A fifth of the yacht's displacement and a rudder
  // right behind the screw: the same top end now, and far quicker to
  // everything on the way to it.
  cruiser: { id: 'cruiser', mass: 1600, thrust: 11000, astern: 3600, topKph: 150, helm: 0.73, heel: 0.15 },
  // The working boats, for the traffic. Slow, heavy, and they hold a line.
  tug: { id: 'tug', mass: 24000, thrust: 38000, astern: 14000, topKph: 30, helm: 0.26, heel: 0.05 },
  sail: { id: 'sail', mass: 1400, thrust: 2600, astern: 700, topKph: 18, helm: 0.35, heel: 0.26 },
  ferry: { id: 'ferry', mass: 34000000, thrust: 9000000, astern: 3000000, topKph: 39, helm: 0.012, heel: 0.02 },
  cargo: { id: 'cargo', mass: 21000000, thrust: 5200000, astern: 1800000, topKph: 28, helm: 0.010, heel: 0.02 },
};

/**
 * How the hull sits and how hard the water pushes back.
 *
 * These are the numbers that are shared by every boat, and every one of them
 * is a shape of the response rather than a property of a particular hull.
 */
export const HYDRO = {
  /**
   * Buoyancy stiffness, newtons per metre of submergence per square metre of
   * waterplane. Sea water and gravity give 1000 × 9.81 ≈ 9,810; this is that,
   * because it is not a tuning knob — it is Archimedes, and using the real
   * figure is what makes a boat float at its own designed draught rather than
   * at whatever depth a made-up spring balances at.
   */
  stiffness: 9810,
  /**
   * Damping on the buoyancy, as a fraction of critical. Water is not a spring;
   * a hull dropped into it stops in about one bounce, and without this the
   * boats pogo on their own waterline for ever.
   */
  damping: 0.85,
  /**
   * How much of the wave's own slope the hull takes up, 0 to 1.
   *
   * Not a fudge: a hull is not a plank lying on the water, it is a body with
   * its own buoyancy distribution and a great deal of inertia, and it rides a
   * swell far more gently than the surface under it moves. At 1 — which is
   * what the first version did — the boats followed every slope exactly and
   * pitched six degrees in a calm. Just under a half is a hull that acknowledges
   * the sea without being thrown about by it.
   */
  waveFollow: 0.45,
  /**
   * Damping of the pitch and roll response, as a fraction of critical. High,
   * because an underdamped hull overshoots the angle the water asked for and
   * the two ring against each other — which is the "dipping" a boat should
   * never do in this sea state.
   */
  attitudeDamping: 0.9,
  /**
   * Extra freeboard, as metres of lift per metre of hull length.
   *
   * `prepare-boats.mjs` puts each model's waterline at its own y = 0 and the
   * hull floats with that on the water, which is exactly right for the flat
   * sea this was built against. It is not right for a sea with crests in it:
   * the boat rides at the MEAN of four samples (bow, stern, both beams) while
   * the water round the outline goes higher than that mean, so the sea climbs
   * the topsides and — on a boat whose cockpit sole is a few centimetres up —
   * comes aboard.
   *
   * How much higher was measured rather than guessed, by sampling the wave
   * field around a hull's outline against its own four-point mean over 90,000
   * positions, headings and moments:
   *
   *   8.6 m cruiser   median 0.10 m, p99 0.22, worst 0.25
   *   16.6 m yacht    median 0.20 m, p99 0.38, worst 0.42
   *
   * It grows with length because a longer hull spans more of a 42 m swell, and
   * 0.023 m per metre lands both of them on their own p99 — the sea comes to
   * the waterline in the worst one wave in a hundred and stays below it the
   * rest of the time, which is what a boat actually looks like. It cannot
   * exceed `SEA_REACH`, because past that the lift would be answering water
   * that does not exist: a 203 m ferry spans so many wavelengths that its mean
   * is flat calm and the crest beside it is the whole wave, no more.
   */
  freeboard: 0.023,
  /**
   * How far a hull rises onto the plane at its top speed, as a fraction of its
   * draught.
   *
   * At rest a hull is held up by Archimedes alone. Under way, water hitting
   * the underside of a hull at speed pushes UP as well as back, and past a
   * certain speed that dynamic lift carries most of the weight: the hull
   * climbs out of the hole it displaces and runs on top of the water instead
   * of through it. It is the most recognisable thing a fast boat does, and the
   * spray and the flattened wake (`BoatWake`) were already saying it had
   * happened while the hull itself sat at its dead-water draught. Grows with
   * the square of speed, as the lift does, so it is nothing at a crawl and
   * everything at the top end.
   */
  planeLift: 0.55,
  /**
   * How much of `waveFollow` is left at top speed, 0 to 1.
   *
   * A hull on the plane is not sitting in the swell any more; it is skipping
   * across the tops of it with most of its length clear of the water, and it
   * has far too much way on to pitch into each trough as it comes. So the
   * wave response falls away as the lift comes on — with the same speed
   * curve, because they are the same thing seen from two sides. Not to zero:
   * a boat at 150 km/h still feels the sea, it just feels it as a rhythm
   * rather than as a series of hills.
   */
  planeFollow: 0.4,
  /** Forward drag area, m² — scaled per boat from its beam and draught. */
  dragAhead: 0.9,
  /**
   * Sideways drag, as a multiple of the forward figure.
   *
   * The single most important number here, and it was measured rather than
   * guessed: run the model outside the browser, put full helm on and read the
   * crab angle — the difference between where the hull points and where it is
   * actually going. At 8 the yacht crabbed **35 degrees** through a turn,
   * which is a jet ski, not a boat.
   *
   * It is a multiple of the forward coefficient, and the forward coefficient
   * is derived from the boat's top speed — so raising the top speed quietly
   * softens the keel too. When the drivable pair went from 88 and 76 km/h to
   * 150, the same 26 that used to crab the yacht 15 degrees crabbed it 26,
   * because the lateral drag had fallen by the square of the speed ratio. 85
   * puts both hulls back where they were: 14.5 degrees for the yacht against
   * 15.4 before, 17.4 for the cruiser against 16.0.
   */
  lateralRatio: 85,
  /** Yaw damping, as a fraction of the yaw inertia per second. */
  yawDamping: 1.4,
  /**
   * Below this speed the rudder does nothing, m/s. A rudder is a wing and a
   * wing in still water is a plank.
   *
   * It was 0.6 with full authority at 6 m/s, which is 21 km/h — so a boat
   * pulling away from rest had no steering worth the name for the first eight
   * seconds, and the honest physical model read as broken controls. These are
   * the figures a small craft actually has: something is happening as soon as
   * the boat is moving at all, and the rudder is fully effective at a fast
   * walking pace.
   */
  helmStall: 0.15,
  /** Speed at which the helm reaches full authority, m/s. */
  helmFull: 2.6,
  /**
   * How much steering the propeller alone provides, with the boat stopped.
   *
   * A screw ahead of a rudder throws water over it whether or not the boat is
   * moving — it is how every boat leaves a berth, and without it a stationary
   * boat is a log. Counted as a fraction of full flow at full throttle, so a
   * burst of power swings the bow and easing off stops it.
   */
  propWash: 0.55,
  /** How quickly the hull leans into the heel it is asked for, per second. */
  heelRate: 1.8,
  /** How fast the wheel goes over, and how fast it centres itself, per second. */
  helmRate: 2.4,
  helmReturn: 3.2,
} as const;

/**
 * How high above still water a hull floats — see `HYDRO.freeboard`.
 *
 * Shared by the driven boat and the scripted ones so a yacht you are chasing
 * sits in the water the same way the one you are steering does.
 */
export const rideLift = (hull: BoatHull): number =>
  Math.min(SEA_REACH, HYDRO.freeboard * hull.size[2]);

/* ------------------------------------------------------------- sea routes */

/**
 * What the working boats do all day.
 *
 * Scripted, like the trams and the service train: a boat that is *driven* by
 * an AI has to solve pilotage, and pilotage in a bay with two islands, a
 * causeway and a railway viaduct in it is a much bigger problem than the
 * traffic's "follow the tarmac". These are the routes instead, and each one
 * is a ring — a centre, a radius and a heading round it — because a ring is
 * the one shape that never needs an end.
 *
 * Every centre and radius below was CHECKED rather than eyeballed: a probe
 * walks each ring and reports the least distance to any land, counting the
 * islands' beaches, the causeway's bank and — for the coastal lanes — the
 * city's own shoreline read out of the nav raster. The clearances are in the
 * comments, and they are what stops a 203 m ferry clipping a headland it
 * passes every ninety seconds.
 *
 * Two of the hulls here are the two you can drive. That is on purpose: a
 * yacht you can take out and never see anyone else in is a strange sort of
 * fleet, and the pair of them are the right size for the coastal water where
 * the big ships will not fit.
 */
export interface SeaRoute {
  /** Which hull runs it. */
  boat: string;
  /** How many of them, spread evenly round the ring. */
  count: number;
  centre: readonly [number, number];
  radius: number;
  /** Metres per second. Well under each hull's own top speed: this is cruising. */
  speed: number;
  /** Anticlockwise when false. */
  clockwise: boolean;
}

export const SEA_ROUTES: ReadonlyArray<SeaRoute> = [
  // The ferry, on the deep water north of both islands. It is the biggest
  // thing that moves in this world and it is meant to be seen from the
  // island's north shore.
  { boat: 'ferry', count: 1, centre: [-1000, -1560], radius: 420, speed: 8.5, clockwise: true },
  // A cargo ship further out still, going the other way.
  { boat: 'cargo', count: 1, centre: [-500, -1650], radius: 520, speed: 6.5, clockwise: false },
  // The tug works the water between the city's coast and the island, east of
  // the causeway — the one stretch of sea the player is always near.
  { boat: 'tug', count: 2, centre: [-790, -470], radius: 33, speed: 3.4, clockwise: false },
  // Yachts sailing the channel between the two islands.
  { boat: 'sail', count: 3, centre: [-600, -560], radius: 78, speed: 4.2, clockwise: true },
  // And a couple of small craft pottering off the village island.
  { boat: 'cruiser', count: 2, centre: [-250, -640], radius: 90, speed: 6, clockwise: true },

  /*
   * The coastal lanes.
   *
   * Everything above is in one bay — the water between the city's north shore
   * and the two islands — because that is where the *driving* is. The railway
   * is not: it runs a 6.6 km loop right round the outside of the city, down
   * the east side, along the south and back up the west, and from a train
   * window all of that was empty water. Measured, the whole line was a median
   * of 1,039 m from the nearest shipping lane and only 22% of it came within
   * 400 m of one. These four rings take that to 212 m and 83%.
   *
   * Each is checked the same way as the rings above — walked at two-degree
   * steps against the islands, their beaches, the causeway's bank AND the
   * city's own coastline out of the nav raster, which the original five never
   * had to consider because none of them goes near the mainland. The least
   * clearance is quoted per ring. They carry small craft only: 60-80 m of
   * water is room for a 17 m yacht and nowhere near enough for the 203 m
   * ferry, which stays out in the deep north where it was.
   */
  // The west coast, off the long straight the line runs down at x = -1888.
  // 80 m of water at the tightest; the railway is 58-538 m off it.
  { boat: 'yacht', count: 2, centre: [-2150, 150], radius: 240, speed: 12, clockwise: false },
  // South of the city, outside the southern leg. 70 m clear, 100-620 m off.
  { boat: 'cruiser', count: 2, centre: [-325, 1275], radius: 260, speed: 9, clockwise: true },
  // The east side, outside the leg that climbs from the station to the south
  // curve. 60 m clear, 85-605 m off — the closest shipping to a city street.
  { boat: 'yacht', count: 1, centre: [400, 200], radius: 260, speed: 12, clockwise: true },
  { boat: 'sail', count: 2, centre: [400, 200], radius: 260, speed: 4.2, clockwise: false },
  // The north-west approach, where the line comes back over the water toward
  // the islands. 60 m clear, 51-571 m off.
  { boat: 'tug', count: 1, centre: [-1650, -1200], radius: 260, speed: 3.4, clockwise: true },
  { boat: 'sail', count: 2, centre: [-1650, -1200], radius: 260, speed: 4.2, clockwise: true },
];

/**
 * Where a driven boat starts: the channel between the two islands.
 *
 * It was tucked against the city's north coast by the causeway, which is the
 * worst water on the map — 22 m of clearance, the bank on one side and the
 * beach on the other, and a boat that needs its own length to turn. Eight
 * candidate moorings were measured for clear water, for the shortest run
 * before something is in the way, and for how close the railway's viaducts
 * pass; this one won on all three:
 *
 * ```
 *   mooring                        clear water   nearest      railway
 *   off the city (the old one)         22 m      causeway      251 m
 *   the bay east of the causeway       50 m      city coast    247 m
 *   the channel between the islands   103 m      kestrel       176 m
 *   north of the station island        92 m      kestrel       331 m
 * ```
 *
 * And it is the best thing to look at. It sits at the centre of the sailing
 * yachts' own ring (`SEA_ROUTES`), so three of them circle at 78 m from the
 * moment the world loads; the station island and its town are off the port
 * bow, the village island astern, and there is a kilometre of open water
 * either way down the channel.
 */
export const BOAT_SPAWN = {
  position: [-600, SEA_LEVEL, -560] as [number, number, number],
  /** Bow toward the island town, which is the thing worth steering at first. */
  heading: 1.13,
};
