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
import { WORLD_ID } from './world';
import type { Corner } from '@/types/vehicle';

const tramTriangles = tramData.triangles;

type Vec3 = [number, number, number];

/** Which shelf of the garage a vehicle sits on. */
export type VehicleCategory = 'performance' | 'street' | 'utility' | 'rail';

export interface GarageVehicle {
  id: string;
  label: string;
  year: number;
  model: string;
  /** Width (X), height (Y), length (Z), metres. */
  size: Vec3;
  /** Kerb weight, kg. */
  mass: number;
  drive: 'rwd' | 'awd' | 'rail';
  /**
   * Runs on the tram loop instead of the road.
   *
   * A rail vehicle bypasses the raycast-vehicle physics entirely — see
   * `TramRide`. Everything below that describes wheels, suspension or a chassis
   * box is therefore inert for it, and is filled in only because `VEHICLE` is a
   * frozen module constant that reads these fields at load.
   */
  rail?: boolean;
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
 * It is not a car and is deliberately not pretended to be one. At 24.1 m over
 * three articulated sections, with no wheel pivots and no steering, putting it
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
  label: 'Melbourne C-Class',
  year: 2001,
  model: TRAM.model,
  // Measured off the model by `prepare-tram.mjs`. The 5.7 m height is to the
  // top of the raised pantograph, not the roof.
  size: TRAM.size,
  sections: TRAM.sections,
  /**
   * Framed from above and behind the cab, not on all 24.1 m.
   *
   * With the rig anchored at the leading cab, any camera further back than the
   * tram is long sits among the traffic, and the tram reads as a distant object
   * you are watching rather than one you are driving. These figures put the eye
   * about 12 m behind the cab and 7 m up — clear above the roof, looking down
   * the track over the front of the tram. Left at the figures the 43.5 m
   * Flexity used, because the cab module is a similar length and the framing
   * was tuned by eye against it rather than derived.
   */
  rigSize: [TRAM.size[0], 5, 8.7],
  /** Tare weight, approximately — a three-section Citadis 202 is about this. */
  mass: 29000,
  drive: 'rail',
  rail: true,
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
  /** Line speed. The real C-class tops out here, and much less in the street. */
  topSpeedKph: 70,
  /**
   * 1.15 m/s² against the McLaren's 8.7 (100 km/h in 3.2 s). A tram is not
   * trying to be quick, and the bar should say so rather than flatter it.
   */
  accel: 1.15 / 8.7,
  /** Inert: a tram is driven by `TramRide`, not by an engine force per wheel. */
  engineForce: 0,
  blurb: 'Three articulated sections on the city loop. Throttle and brake only — '
    + 'the rails do the steering, and nothing gives way to you.',
};

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
 */
export const GARAGE: GarageVehicle[] = WORLD_ID === 'city'
  ? [MCLAREN, ...generated, TRAM_VEHICLE]
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
  { id: 'rail', label: 'RAIL', tagline: 'Runs the city loop', accent: '#37b3ff' },
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
