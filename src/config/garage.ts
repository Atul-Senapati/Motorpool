/**
 * Which car the session drives, and everything measured about it.
 *
 * Selection works exactly like `world.ts`: read once from the query string at
 * module load. That is deliberate. `VEHICLE` in `vehicleConfig` is a frozen
 * module constant read from roughly sixty places — the physics class, the
 * cameras, the HUD, the skid marks — and threading a live "current vehicle"
 * through all of it would put a moving part inside code that was calibrated on
 * the assumption it never moves. Picking a car navigates to `?car=<id>`, the
 * module re-evaluates, and every consumer sees one consistent set of numbers.
 *
 * `garageData.json` is GENERATED — never hand-edit it. Re-run
 * `npm run prepare:garage` after touching the script or replacing a source
 * model and the measurements below follow automatically.
 */
import garageData from './garageData.json';
import mclarenGeometry from './carGeometry.json';
import tramData from './tramData.json';
import { RAIL, TRAM } from './railConfig';
import { RAIL_SETS_ALL, TRAIN, TRAIN_LINE_ENABLED } from './trainConfig';
import { WORLD_ID } from './world';
import { BOATS, BOAT_MODEL, HULLS } from './boatConfig';
import type { Corner } from '@/types/vehicle';

const tramTriangles = tramData.triangles;

type Vec3 = [number, number, number];

/** Which shelf of the garage a vehicle sits on. */
export type VehicleCategory = 'performance' | 'street' | 'utility' | 'rail' | 'marine';

export interface GarageVehicle {
  id: string;
  label: string;
  year: number;
  model: string;
  /** Width (X), height (Y), length (Z), metres. */
  size: Vec3;
  /** Kerb weight, kg. */
  mass: number;
  drive: 'rwd' | 'awd' | 'rail' | 'screw';
  /**
   * Which line this vehicle runs on, if it runs on rails at all.
   *
   * `'tram'` is the street loop through the city (`railConfig`, `TramRide`);
   * `'main'` is the railway round the outside of the map (`trainConfig`,
   * `TrainRide`). A rail vehicle bypasses the raycast-vehicle physics
   * entirely, so everything below that describes wheels, suspension or a
   * chassis box is inert for it, and is filled in only because `VEHICLE` is a
   * frozen module constant that reads these fields at load.
   *
   * It names the line rather than being a boolean because the two services
   * have to know which of them is a vehicle short: taking the tram out stands
   * a tram down, and taking the locomotive out must not.
   */
  rail?: 'tram' | 'main';
  /**
   * Which hull this is, if it floats.
   *
   * The marine equivalent of `rail`, and it works the same way: the scene
   * swaps the whole physics path for `BoatRide` rather than configuring the
   * raycast vehicle, so every wheel, spring and chassis figure below is inert
   * for a boat and filled in only because `VEHICLE` reads these fields at
   * load. It names the hull because that is the key into `BOATS`, where the
   * displacement, thrust and helm live.
   */
  sea?: string;
  /**
   * What the camera should frame, when that is not the vehicle's own bounds.
   *
   * Camera offsets scale with length (see `vehicleConfig`), which is right for
   * cars and wrong for an articulated tram: 24 m would put the chase rig 34 m
   * back and the driver would be watching a distant dot. The rig is framed on
   * the driving end instead.
   */
  rigSize?: Vec3;
  /**
   * Articulated sections, when the model is not one rigid body.
   *
   * The tram's sections all sit at the *origin* in the file — the layout
   * lives here, and `RailLoop` spends it by placing each one at its own arc
   * length along the track. Anything else drawing the vehicle has to do the
   * same, or it renders every body stacked on top of the others.
   */
  sections?: ReadonlyArray<{ name: string; offset: number }>;
  /** False when the export merged its wheels into the body — see prepare-garage.mjs. */
  hasWheelPivots: boolean;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  pivots: Record<Corner, Vec3>;
  radii: Record<Corner, number>;
  triangles: number;
  category: VehicleCategory;
  /** Engine ceiling, km/h. Not measurable from a mesh, so it is stated. */
  topSpeedKph: number;
  /**
   * How hard this pulls, with the McLaren as 1.
   *
   * Taken from real 0-100 km/h times against its 3.2 s, which is the same
   * figure `TUNING.accel` feeds to the engine force — so the bar the picker
   * draws and the force the car actually gets come from one number, and cannot
   * drift apart.
   */
  accel: number;
  /** Per-driven-wheel engine force. Scaled from the McLaren's calibrated 6600. */
  engineForce: number;
  blurb: string;
}

/**
 * The McLaren predates the garage pipeline and keeps its own hand-tuned
 * preparation (`prepare-model.mjs`), which gives it something no other car
 * here has: real `Upright_*` hardware that steers without rolling. It is
 * spliced in by hand rather than being reprocessed and losing that.
 */
const MCLAREN: GarageVehicle = {
  id: 'mclaren',
  label: 'McLaren F1',
  year: 1993,
  model: '/models/mclaren.glb',
  size: [1.82, 1.14, 4.287],
  mass: 1140,
  drive: 'rwd',
  hasWheelPivots: true,
  wheelbase: mclarenGeometry.wheelbase,
  trackFront: mclarenGeometry.trackFront,
  trackRear: mclarenGeometry.trackRear,
  pivots: mclarenGeometry.pivots as Record<Corner, Vec3>,
  radii: mclarenGeometry.radii as Record<Corner, number>,
  triangles: 78385,
  category: 'performance',
  topSpeedKph: 340,
  accel: 1,
  engineForce: 6600,
  blurb: 'The reference car. Every physics constant in the project was calibrated on it.',
};

/**
 * The city's tram, as a vehicle you can take out yourself.
 *
 * It is not a car and is deliberately not pretended to be one. At 43.5 m over
 * seven articulated modules, with no wheel pivots and no steering, putting it
 * through a physics model calibrated on a 4.3 m McLaren would be nonsense — and
 * it would not fit down a 7 m street. So it rides the rails that are already
 * laid through the city (`railConfig`), which is what a tram does: you have a
 * throttle and a brake, and the track does the steering.
 *
 * The wheel and chassis figures below are inert — `TramRide` never touches the
 * raycast vehicle — but they have to be present and non-degenerate because
 * `vehicleConfig` reads them while building its module constants. They are real
 * tram numbers rather than zeros so that nothing downstream divides by one.
 */
const TRAM_VEHICLE: GarageVehicle = {
  id: 'tram',
  label: 'Gold Coast G:link',
  year: 2014,
  model: TRAM.model,
  // Measured off the model by `prepare-tram.mjs`. The 5.0 m height is to the
  // top of the raised pantograph, not the roof, and the 2.76 m width is over
  // the wing mirrors — the bodyshell itself is 2.63 m.
  size: TRAM.size,
  sections: TRAM.sections,
  /**
   * Framed from above and behind the cab, not on all 43.5 m.
   *
   * With the rig anchored at the leading cab, any camera further back than the
   * tram is long sits among the traffic, and the tram reads as a distant object
   * you are watching rather than one you are driving. These figures put the eye
   * about 12 m behind the cab and 7 m up — clear above the roof, looking down
   * the track over the front of the tram. They are a stated frame rather than a
   * derived one: 8.7 m is roughly the cab module's own length, and the rest was
   * tuned by eye.
   */
  rigSize: [TRAM.size[0], 5, 8.7],
  /**
   * Tare weight, approximately. A seven-module, 43.5 m low-floor tram is in
   * this region; it is inert here in any case, since `TramRide` never asks the
   * raycast vehicle to move a mass.
   */
  mass: 60000,
  drive: 'rail',
  rail: 'tram',
  hasWheelPivots: false,
  // A bogie wheelbase and standard gauge, so the numbers mean something even
  // though nothing steers on them.
  wheelbase: 1.8,
  trackFront: RAIL.gauge,
  trackRear: RAIL.gauge,
  pivots: {
    FL: [-RAIL.gauge / 2, 0.29, 0.9], FR: [RAIL.gauge / 2, 0.29, 0.9],
    RL: [-RAIL.gauge / 2, 0.29, -0.9], RR: [RAIL.gauge / 2, 0.29, -0.9],
  },
  radii: { FL: 0.29, FR: 0.29, RL: 0.29, RR: 0.29 },
  triangles: tramTriangles,
  category: 'rail',
  /** Line speed. The real G:link tops out here, and much less in the street. */
  topSpeedKph: 70,
  /**
   * 1.15 m/s² against the McLaren's 8.7 (100 km/h in 3.2 s). A tram is not
   * trying to be quick, and the bar should say so rather than flatter it.
   */
  accel: 1.15 / 8.7,
  /** Inert: a tram is driven by `TramRide`, not by an engine force per wheel. */
  engineForce: 0,
  blurb: 'Seven articulated modules on the city loop. Throttle and brake only — '
    + 'the rails do the steering, and nothing gives way to you.',
};

/**
 * The main-line locomotive, as a vehicle you can take out yourself.
 *
 * Everything the tram entry says about inert wheel figures applies here for the
 * same reason — `TrainRide` never touches the raycast vehicle, but
 * `vehicleConfig` reads these fields while building its module constants, so
 * they have to be present and non-degenerate.
 *
 * What is different from the tram is the *character*, and it is all in two
 * numbers `TrainRide` holds: 0.9 m/s² to pull away and 1.6 to stop. An HST is
 * 4,500 hp across its two power cars, but the set is 380 tonnes, and it needs
 * the better part of a kilometre to stop from line speed. The tram is a vehicle
 * you drive; this is one you plan.
 */
/**
 * What differs between the two rail sets beyond their measurements.
 *
 * The measurements come from `RAIL_SETS_ALL`, which is the same table
 * `trainConfig` picks the loaded set from — so the garage cannot offer a
 * vehicle the runtime has no data for, and an id typed wrong here shows up as a
 * missing entry rather than as the wrong train. Everything in this table is the
 * part no amount of measuring a mesh will tell you.
 */
const RAIL_CHARACTER = {
  train: {
    /** The year the class entered service. The Grand Central livery is 2007. */
    year: 1976,
    /** Class 43 service weight, per power car. */
    mass: 70250,
    /** A Class 43 bogie's wheelbase, and its 1.02 m wheels. */
    wheelbase: 2.6,
    radius: 0.51,
    blurb: 'Two power cars, five Mark 3s, and the shape that made 125 mph normal. '
      + 'Runs the main line round the city — viaducts over the streets, tunnels '
      + 'through the hills.',
  },
  train91: {
    /** The year the class entered service. */
    year: 1988,
    /** Class 91 service weight. */
    mass: 81500,
    /** A Class 91 bogie's wheelbase, and its 1.0 m wheels. */
    wheelbase: 3.35,
    radius: 0.5,
    blurb: 'Six and a half thousand horsepower, and a kilometre to stop. Built for '
      + 'the wires it runs under, on the same main line round the city.',
  },
} as const;

/**
 * One of the two main-line sets as a garage entry.
 *
 * There was one of these written out longhand, and adding the second by copying
 * it would have left ten numbers to keep in step across two blocks — the sort
 * of duplication that ends with a Class 91 quoting a Class 43's mass. The
 * measurements come from the set, the character from `RAIL_CHARACTER`, and the
 * rest is identical between them because it describes the *line* rather than
 * the vehicle.
 */
function railVehicle(id: keyof typeof RAIL_CHARACTER): GarageVehicle {
  const set = RAIL_SETS_ALL[id];
  const character = RAIL_CHARACTER[id];
  const size = set.loco.size as [number, number, number];
  return {
    id,
    label: set.label,
    year: character.year,
    model: set.loco.model,
    /**
     * Measured off the model by `prepare-train.mjs`. The height is to whatever
     * stands proudest — a raised pantograph on the Class 91, roof aerials on
     * the Class 43 — and the collider uses the real height over the roof
     * instead. See `LOCOMOTIVE.bodyHeight`.
     */
    size,
    /**
     * Framed on the locomotive rather than on its driving end.
     *
     * The tram overrides this because at 43.5 m a rig framed on the whole
     * vehicle sits 34 m back among the traffic, so it is anchored at the cab
     * instead. One power car is short enough to frame whole, and `TrainRide`
     * anchors the rig at the body centre accordingly — but the override is
     * still needed, because the vehicle's own length would put the camera
     * twenty-odd metres back.
     *
     * `vehicleConfig` turns it into an offset of `5.9 x length / 4.287` back
     * and `1.6 x height / 1.14` up, so this puts the eye 15 m behind the body
     * centre and 7.7 m above the rail, which is a clear four metres over the
     * roof of either class.
     */
    rigSize: [size[0], 5.5, 11],
    /** Inert here — nothing asks the rails to move a mass. */
    mass: character.mass,
    drive: 'rail',
    rail: 'main',
    hasWheelPivots: false,
    wheelbase: character.wheelbase,
    trackFront: TRAIN.gauge,
    trackRear: TRAIN.gauge,
    pivots: {
      FL: [-TRAIN.gauge / 2, character.radius, character.wheelbase / 2],
      FR: [TRAIN.gauge / 2, character.radius, character.wheelbase / 2],
      RL: [-TRAIN.gauge / 2, character.radius, -character.wheelbase / 2],
      RR: [TRAIN.gauge / 2, character.radius, -character.wheelbase / 2],
    },
    radii: {
      FL: character.radius, FR: character.radius,
      RL: character.radius, RR: character.radius,
    },
    triangles: set.loco.triangles,
    category: 'rail',
    /**
     * 300 km/h — over the 200 that gave the InterCity 125 its name and the 225
     * the Class 91 was built for, and asked for. The line's own speed
     * restrictions (see `LATERAL` in `trainConfig`) still decide what the
     * corners allow; this is what the straights allow.
     */
    topSpeedKph: 300,
    /** 3.2 m/s² against the McLaren's 8.7 — see `TrainRide`'s `ACCEL`. */
    accel: 3.2 / 8.7,
    /** Inert: driven by `TrainRide`, not by an engine force per wheel. */
    engineForce: 0,
    blurb: character.blurb,
  };
}

const RAIL_VEHICLES: GarageVehicle[] = (Object.keys(RAIL_CHARACTER) as
  Array<keyof typeof RAIL_CHARACTER>).map(railVehicle);

/**
 * Per-car character, which no amount of measuring a mesh will tell you.
 *
 * `accel` is how hard this car pulls compared with the McLaren, taken from
 * real 0-100 km/h times against its 3.2 s. It is NOT a force multiplier: the
 * weight scaling is applied separately below, so a heavy car already gets the
 * force it needs to move its own mass and this number only says whether it is
 * quicker or slower than the reference car.
 *
 * Getting that backwards is worth spelling out, because it was: an earlier
 * version multiplied the weight scaling by figures above 1 for the heavy
 * vehicles, which gave the four-tonne Hummer 4.2x a McLaren F1's acceleration
 * and the semi tractor 3.4x. Beyond being nonsense, that much force at the
 * contact patches pitched the nose of the car skyward under throttle.
 */
const TUNING: Record<string, {
  topSpeedKph: number; accel: number; category: VehicleCategory; blurb: string;
}> = {
  // 0-100 in ~6.5 s.
  camaro: { category: 'street', topSpeedKph: 220, accel: 0.49, blurb: 'Big-block muscle. Plenty of power, not much interest in stopping.' },
  // ~7.0 s.
  canyon: { category: 'utility', topSpeedKph: 175, accel: 0.46, blurb: 'Off-road pickup. Tall, heavy, and surprisingly willing.' },
  // ~3.5 s — it really is nearly as quick as the McLaren, and weighs 3.6x more.
  // ~3.3 s.
  porsche: { category: 'performance', topSpeedKph: 300, accel: 0.97, blurb: 'GT3 race car. The closest thing here to the McLaren.' },
  bmw: { category: 'performance', topSpeedKph: 250, accel: 0.76, blurb: 'Homologation special with a V8 in a saloon shell. Famous for one game.' },
  w14: { category: 'performance', topSpeedKph: 350, accel: 1.23, blurb: 'An actual Formula 1 car, in traffic. 798 kg and no patience whatsoever.' },
  mcqueen: { category: 'performance', topSpeedKph: 320, accel: 0.74, blurb: 'Piston Cup rookie. Ka-chow, allegedly, at two hundred miles an hour.' },
  mater: { category: 'utility', topSpeedKph: 110, accel: 0.15, blurb: 'A 1951 boom truck with more rust than paint. Reverses better than most.' },
  dodge: { category: 'utility', topSpeedKph: 110, accel: 0.16, blurb: 'A 1953 half-ton pickup. Three on the tree, and in no hurry at all.' },
  tractor: { category: 'utility', topSpeedKph: 40, accel: 0.10, blurb: 'The other Lamborghini. Six cylinders, four driven wheels, forty flat out.' },
  monster: { category: 'utility', topSpeedKph: 145, accel: 0.60, blurb: 'Five and a half tonnes on 66-inch tyres. Kerbs are not an obstacle.' },
  // ~8.5 s.
  // ~15 s running bobtail.
};

const DEFAULT_TUNING = {
  topSpeedKph: 200, accel: 0.5, category: 'street' as VehicleCategory, blurb: '',
};

/**
 * Total engine force the McLaren makes: its calibrated 6600 per wheel, through
 * two driven wheels.
 */
const REFERENCE_TOTAL_FORCE = 6600 * 2;

const generated: GarageVehicle[] = (garageData.vehicles as Array<Omit<GarageVehicle,
  'topSpeedKph' | 'engineForce' | 'blurb' | 'drive' | 'pivots' | 'radii' | 'size'
  | 'category' | 'accel'> & {
    size: number[]; drive: string; pivots: Record<string, number[]>; radii: Record<string, number>;
  }>).map((v) => {
  const tuning = TUNING[v.id] ?? DEFAULT_TUNING;
  return {
    ...v,
    size: v.size as Vec3,
    drive: v.drive as 'rwd' | 'awd',
    pivots: v.pivots as Record<Corner, Vec3>,
    radii: v.radii as Record<Corner, number>,
    category: tuning.category,
    topSpeedKph: tuning.topSpeedKph,
    accel: tuning.accel,
    /*
     * Per driven wheel, which is what `vehiclePhysics` applies it as. The
     * target is a TOTAL force — weight-scaled so the car can shift its own
     * mass, then scaled again by how brisk it should feel — divided by the
     * number of wheels that will each be given this figure. Dividing is the
     * whole point: without it an all-wheel-drive car gets two extra driven
     * wheels and quietly doubles its own output.
     */
    engineForce: Math.round(
      (REFERENCE_TOTAL_FORCE * (v.mass / MCLAREN.mass) * tuning.accel)
      / (v.drive === 'awd' ? 4 : 2),
    ),
    blurb: tuning.blurb,
  };
});

/**
 * Everything drivable, McLaren first and the tram last.
 *
 * The tram is offered only in the city, because its route is four of the city's
 * own streets — `railConfig` is built from measured city coordinates and there
 * is no track for it on the circuit. Anyone arriving at `?world=track&car=tram`
 * falls through to the default car, since `selectVehicle` only accepts an id it
 * can find here.
 *
 * The locomotive comes and goes with `TRAIN_LINE_ENABLED` for the same reason
 * one step further: with the railway not built there is nothing for it to run
 * on, so `?car=train` has to fall through to the default rather than strand the
 * driver on a line that is not there.
 */
/**
 * The two drivable boats.
 *
 * Built from the same `boatData.json` the hulls themselves come out of, so a
 * re-run of `prepare:boats` that changes a length changes the picker's figures
 * with it. Everything a car needs and a boat does not — wheelbase, track,
 * pivots, radii — is filled with the hull's own proportions rather than zeros,
 * because the garage draws bars from these and a zero-length wheelbase renders
 * as a broken vehicle rather than as a boat.
 */
const BOAT_VEHICLES: GarageVehicle[] = (WORLD_ID === 'city' ? ['yacht', 'cruiser'] : [])
  .map((id): GarageVehicle | null => {
    const hull = HULLS[id];
    const spec = BOATS[id];
    if (!hull || !spec) return null;
    const [beam, air, loa] = hull.size;
    return {
      id: `boat-${id}`,
      label: hull.label,
      year: 2024,
      model: BOAT_MODEL,
      size: [beam, air + hull.draught, loa] as Vec3,
      mass: spec.mass,
      drive: 'screw',
      sea: id,
      // Framed on the hull itself. A boat's air draught is most of its height
      // and a rig framed on that sits far too high to see the water, which is
      // the one thing worth watching from a boat.
      rigSize: [beam, air * 0.7, loa] as Vec3,
      hasWheelPivots: false,
      wheelbase: loa * 0.6,
      trackFront: beam * 0.7,
      trackRear: beam * 0.7,
      pivots: {
        FL: [-beam * 0.35, 0, loa * 0.3], FR: [beam * 0.35, 0, loa * 0.3],
        RL: [-beam * 0.35, 0, -loa * 0.3], RR: [beam * 0.35, 0, -loa * 0.3],
      },
      radii: { FL: 0.3, FR: 0.3, RL: 0.3, RR: 0.3 },
      triangles: hull.triangles,
      category: 'marine' as VehicleCategory,
      topSpeedKph: spec.topKph,
      // Against the McLaren's 3.2 s to 100 km/h. A boat's answer to that
      // question is "it does not", and the bar should say so.
      accel: id === 'cruiser' ? 0.18 : 0.12,
      engineForce: spec.thrust,
      blurb: id === 'yacht'
        ? 'Eight tonnes of flybridge motor yacht. Plan the turn before you take it.'
        : 'Eight metres, one and a half tonnes, and a rudder right behind the screw.',
    } satisfies GarageVehicle;
  })
  .filter((v): v is GarageVehicle => v !== null);

export const GARAGE: GarageVehicle[] = WORLD_ID === 'city'
  ? [MCLAREN, ...generated, ...BOAT_VEHICLES, TRAM_VEHICLE,
    ...(TRAIN_LINE_ENABLED ? RAIL_VEHICLES : [])]
  : [MCLAREN, ...generated];

/**
 * The shelves, in the order the picker shows them.
 *
 * Data-driven so the picker has no vehicle knowledge of its own: adding a
 * vehicle with a new category here is all it takes for a tab to appear.
 */
export const CATEGORIES: ReadonlyArray<{
  id: VehicleCategory; label: string; tagline: string; accent: string;
}> = [
  { id: 'performance', label: 'PERFORMANCE', tagline: 'Built for one lap', accent: '#ff4a2a' },
  { id: 'street', label: 'STREET', tagline: 'Long roads, no hurry', accent: '#f6a623' },
  { id: 'utility', label: 'UTILITY', tagline: 'Heavy, tall, unbothered', accent: '#2fe1a0' },
  { id: 'rail', label: 'RAIL', tagline: 'The tram loop and the main line', accent: '#37b3ff' },
  { id: 'marine', label: 'MARINE', tagline: 'Out past the causeway', accent: '#25d0c0' },
];

/**
 * Bars for the picker, every one of them normalised against the roster itself
 * rather than an invented ceiling — so the fastest thing here always reads full
 * and adding a faster vehicle rescales everyone honestly.
 */
export interface VehicleRatings {
  speed: number;
  accel: number;
  heft: number;
  footprint: number;
}

const MAX = {
  speed: Math.max(...GARAGE.map((v) => v.topSpeedKph)),
  accel: Math.max(...GARAGE.map((v) => v.accel)),
  heft: Math.max(...GARAGE.map((v) => v.mass)),
  footprint: Math.max(...GARAGE.map((v) => v.size[2])),
};

export function ratingsFor(vehicle: GarageVehicle): VehicleRatings {
  return {
    speed: vehicle.topSpeedKph / MAX.speed,
    accel: vehicle.accel / MAX.accel,
    heft: vehicle.mass / MAX.heft,
    footprint: vehicle.size[2] / MAX.footprint,
  };
}

/**
 * A one-letter class, for the badge.
 *
 * Straight off speed and pull, which is what "fast" means here. A rail vehicle
 * is not competing on either and gets its own mark instead of a bad grade.
 */
export function classFor(vehicle: GarageVehicle): string {
  if (vehicle.category === 'rail') return 'R';
  const r = ratingsFor(vehicle);
  const score = (r.speed + r.accel) / 2;
  if (score >= 0.85) return 'S';
  if (score >= 0.66) return 'A';
  if (score >= 0.46) return 'B';
  if (score >= 0.3) return 'C';
  return 'D';
}

export const accentFor = (category: VehicleCategory): string =>
  CATEGORIES.find((c) => c.id === category)?.accent ?? '#4da3ff';

/** Query-string key, and the value stored for a returning driver. */
export const CAR_PARAM = 'car';
const STORAGE_KEY = 'motorpool.car';

function selectVehicle(): GarageVehicle {
  // `page.tsx` renders the scene with `ssr: false`, so this only ever runs in
  // the browser; the guard is for module evaluation during the server pass.
  if (typeof window === 'undefined') return GARAGE[0];
  const requested = new URLSearchParams(window.location.search).get(CAR_PARAM);
  return GARAGE.find((v) => v.id === requested) ?? GARAGE[0];
}

/** True when the driver has actually chosen, rather than landing on the default. */
export function hasChosenVehicle(): boolean {
  if (typeof window === 'undefined') return false;
  const requested = new URLSearchParams(window.location.search).get(CAR_PARAM);
  return GARAGE.some((v) => v.id === requested);
}

/** Remembers the last car, so the picker can offer it back. */
export function rememberVehicle(id: string) {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* private mode */ }
}

export function lastVehicleId(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export const SELECTED: GarageVehicle = selectVehicle();
