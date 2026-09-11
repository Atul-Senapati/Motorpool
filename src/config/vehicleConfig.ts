/**
 * Single source of truth for vehicle tuning.
 *
 * Geometry values are NOT hand-authored: they are measured off the mesh by the
 * asset pipeline (`prepare-model.mjs` for the McLaren, `prepare-garage.mjs` for
 * the rest) and reach here through `garage.ts`. Re-run the relevant
 * `npm run prepare:*` and these stay in sync with the art.
 *
 * Which car this describes is fixed for the lifetime of the page — see
 * `garage.ts` for why the selection is a query parameter rather than state.
 */
import { SELECTED } from './garage';
import { pickCitySpawn } from './cityConfig';
import { trackSpawn } from './trackConfig';
import { WORLD_ID } from './world';
import type { Corner, Vec3, WheelConfig } from '@/types/vehicle';

export const CAR_GEOMETRY = SELECTED;

/** The reference car, and the mass every calibrated constant below assumes. */
const REFERENCE_MASS = 1140;

/**
 * The car model faces -Z (three.js convention). Rapier's vehicle controller
 * measures speed and applies engine force along its forward axis index, which
 * is +Z. This constant reconciles the two and is applied in exactly one place
 * (see `physics/vehiclePhysics.ts`) so signs never leak into gameplay code.
 */
export const FORWARD_SIGN = -1;

/**
 * Fixed physics timestep, shared by the `<Physics>` world and the vehicle
 * controller. Must NOT be read back from Rapier inside a before-step callback:
 * `world.timestep` re-enters the borrowed World and throws "recursive use of an
 * object detected which would lead to unsafe aliasing in rust", which aborts
 * the step so the vehicle controller never applies any force.
 */
export const PHYSICS_TIMESTEP = 1 / 60;

/**
 * Dev-only override, so suspension rates can be calibrated with a clean sim
 * state per page load (`?k=12`). Mutating them mid-flight destabilises the
 * simulation and produces meaningless readings.
 */
const devNumber = (key: string, fallback: number) => {
  if (typeof window === 'undefined' || process.env.NODE_ENV === 'production') return fallback;
  const raw = new URLSearchParams(window.location.search).get(key);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Suspension geometry.
 *
 * The key thing to understand about Rapier's raycast vehicle is that
 * `suspensionRestLength` does two jobs at once: it is the spring's free length,
 * AND it sets the ray length (the ray reaches `restLength + radius` below the
 * hard point). Deriving the hard-point height from the rest length therefore
 * couples them, and the car ends up balanced on the very tip of its own
 * suspension ray: wheel contact flickers on and off, the spring never
 * compresses, and ride height becomes independent of stiffness entirely.
 *
 * So the two are decoupled here. HARD_POINT_ABOVE_AXLE fixes the geometry (and
 * hence the ride height), while REST_LENGTH is deliberately longer, which puts
 * the spring meaningfully into compression at rest and leaves the ray a large
 * margin below the tyre.
 */
const HARD_POINT_ABOVE_AXLE = 0.22;

/**
 * Spring compression when the car is simply sitting still.
 *
 * This also sets the available droop travel: the ray reaches exactly
 * DESIGN_DEFLECTION past the tyre, so a wheel dropping further than this into a
 * dip loses contact. It trades off against stiffness — the same corner load over
 * more travel means a softer spring — so it is kept modest. At 0.23 m the car
 * squatted a further 0.14 m under full throttle and grounded its chassis
 * collider on the road, which then dragged it to a standstill.
 */
const DESIGN_DEFLECTION = 0.1;

const SUSPENSION_REST_LENGTH = HARD_POINT_ABOVE_AXLE + DESIGN_DEFLECTION;

/**
 * Stiffness that balances the car's weight at DESIGN_DEFLECTION.
 *
 * Calibrated in-browser rather than derived: Rapier's suspension force does not
 * follow the Bullet formula its docs imply (there is no chassis-mass term, and
 * `wheelSuspensionForce` reads back in units unrelated to the applied impulse),
 * so this cannot be computed on paper. Measured relationship at equilibrium:
 * `stiffness * deflection ~= 2.13` at the reference car's 1140 kg.
 *
 * It is scaled by mass here. Rapier's suspension force carries no chassis-mass
 * term, so the same spring under a heavier car simply sinks further; without
 * this a four-tonne SUV would sit on its bump stops. Ride height then
 * stays put across the garage. Re-calibrate the 2.13 with `?k=` if the Rapier
 * version changes.
 */
const SUSPENSION_STIFFNESS = devNumber('k',
  (2.13 * (SELECTED.mass / REFERENCE_MASS)) / DESIGN_DEFLECTION);

const wheel = (corner: Corner, steered: boolean, powered: boolean): WheelConfig => {
  const [x, y, z] = CAR_GEOMETRY.pivots[corner] as [number, number, number];
  return {
    corner,
    connection: [x, y + HARD_POINT_ABOVE_AXLE, z] as Vec3,
    radius: CAR_GEOMETRY.radii[corner],
    steered,
    powered,
  };
};

/**
 * Chassis box, in proportion to the body.
 *
 * The McLaren's numbers were arrived at by hand and are kept exactly; the
 * ratios below are simply those numbers divided by its dimensions, so every
 * other car gets a collider inset the same way — including the gap under it,
 * which must never reach the road or the car rests on its box instead of its
 * springs.
 */
function chassisFor(): { halfExtents: Vec3; center: Vec3 } {
  if (SELECTED.id === 'mclaren') {
    return { halfExtents: [0.88, 0.46, 2.05], center: [0, 0.6, -0.19] };
  }
  const [width, height, length] = SELECTED.size;
  const halfExtents: Vec3 = [width * 0.483, height * 0.404, length * 0.478];
  return { halfExtents, center: [0, height * 0.526, 0] };
}

const CHASSIS = chassisFor();

/** All four wheels drive an AWD car; otherwise the rear axle does. */
const powered = (corner: Corner) => SELECTED.drive === 'awd' || corner === 'RL' || corner === 'RR';

export const VEHICLE = {
  /** Kerb weight of the selected car. */
  mass: SELECTED.mass,

  /** Cuboid chassis collider. Inset from the visual shell so it doesn't snag on curbs. */
  chassis: {
    /**
     * Inset from the visual shell, and deliberately raised: the collider must
     * never reach the road at normal ride height, or the car rests on its box
     * instead of its wheels and the suspension stops mattering entirely. On
     * the McLaren the bottom sits at 0.14 m, top at 1.06 m — just clear of the
     * road even with the springs fully compressed.
     */
    halfExtents: CHASSIS.halfExtents,
    center: CHASSIS.center,
  },

  /** Front-wheel steering throughout; the driven axle depends on the car. */
  wheels: [
    wheel('FL', true, powered('FL')),
    wheel('FR', true, powered('FR')),
    wheel('RL', false, powered('RL')),
    wheel('RR', false, powered('RR')),
  ] as const,

  suspension: {
    restLength: SUSPENSION_REST_LENGTH,
    stiffness: SUSPENSION_STIFFNESS,
    /**
     * Damping, following the Bullet convention Rapier inherits:
     * `2 * sqrt(stiffness) * zeta` — zeta 0.25 compressing, 0.45 extending, so
     * the car settles quickly without floating over crests.
     */
    compression: devNumber('dc', 4.4),
    relaxation: devNumber('dr', 8.8),
    /**
     * Clamps |length - restLength|, so it must EXCEED the design deflection or
     * the car sits permanently on its bump stop. The 0.12 m of extra travel is
     * deliberately less than the chassis collider's 0.14 m ground clearance, so
     * the suspension hits its bump stop BEFORE the body can touch the road.
     */
    maxTravel: DESIGN_DEFLECTION + 0.12,
    maxForce: 30000,
  },

  engine: {
    /**
     * Per driven wheel. Calibrated by timing 0-100 km/h in-browser rather than
     * from F = ma: like the suspension, Rapier's engine force is not applied in
     * plain newtons. 5000 gave 6.3 s and 9800 gave 2.15 s; the real car does
     * 3.2 s, and acceleration time scales as 1/force.
     */
    maxForce: devNumber('ef', SELECTED.engineForce),
    reverseForce: Math.round(SELECTED.engineForce * 0.64),
    /** Engine force tapers to zero as this speed is approached, capping top end. */
    maxSpeedKph: SELECTED.topSpeedKph,
    idleRpm: 900,
    maxRpm: 7500,
    /**
     * Ratios are for the RPM readout and gear display only; torque is not
     * modelled per-gear, so the McLaren's spacing is simply stretched to
     * whatever this car's top speed is.
     */
    gearSpeedsKph: [0, 65, 110, 160, 215, 270, 340]
      .map((v) => Math.round((v / 340) * SELECTED.topSpeedKph)),
  },

  /**
   * Boost: a finite reserve of extra push, on demand.
   *
   * Deliberately not nitrous chemistry — nothing here models a bottle. It is
   * the arcade device every driving game has, and the numbers are chosen so it
   * changes what you can do with a straight without changing what the car is:
   * a third more shove and a little more top end for a few seconds, then a
   * wait. Scaled off the vehicle's own figures rather than stated in absolute
   * newtons, so a tractor's boost is a tractor's boost.
   */
  boost: {
    /** Engine force multiplier while boosting. */
    forceScale: 1.42,
    /**
     * How much the speed cap lifts, as a fraction of the car's top speed.
     * Without this the extra force does nothing at the top end, because engine
     * force tapers to zero as `maxSpeedKph` is approached — boost would be felt
     * only from a standstill, which is exactly where it is least wanted.
     */
    topSpeedBonus: 0.12,
    /** Seconds of boost in a full reserve. */
    capacity: 4.5,
    /** Seconds of not boosting before the reserve starts refilling. */
    refillDelay: 1.1,
    /** Fraction of a full reserve refilled per second — ~7 s from empty. */
    refillRate: 0.14,
    /**
     * How full the reserve must be to start a boost. Without a floor, tapping
     * the key on an empty reserve gives a stutter of thrust every frame the
     * refill has produced anything at all.
     */
    minToEngage: 0.12,
  },

  brake: {
    /** Per-wheel braking impulse cap, roughly F * dt. */
    force: 65,
    /** Applied to the rear axle only, which is what makes the tail step out. */
    handbrake: 140,
    /** Light braking applied on all wheels when coasting, standing in for engine braking. */
    engineBraking: 4,
  },

  steering: {
    /** Full lock, radians (~32 deg). */
    maxAngle: 0.56,
    /** Lock available at and above `speedForMinAngle` (~9 deg). */
    minAngle: 0.16,
    /** Speed (km/h) at which steering authority has fully tapered off. */
    speedForMinAngle: 190,
    /** How fast the virtual steering rack moves toward the input, per second. */
    rate: 3.4,
    /** Faster self-centring when the input is released. */
    returnRate: 5.5,
  },

  tyres: {
    /** Longitudinal grip. Higher = more instantaneous traction and braking. */
    frictionSlip: 2.1,
    /** Lateral grip. Lower on the rear so the car rotates when provoked. */
    sideFrictionFront: 1.1,
    sideFrictionRear: 0.88,
    /**
     * Rear side grip while the handbrake is pulled — this is the drift. At 0.22
     * the car snapped into an uncatchable spin from a quarter turn of lock.
     */
    sideFrictionHandbrake: 0.45,
    /**
     * Speed, m/s, by which the driven wheels stop spinning up under full
     * throttle. 627 bhp through the rear axle lights them up well into third,
     * so this is high on purpose.
     */
    spinFadeSpeed: 24,
    /** Below this speed, m/s, a hard brake stops the car rather than skidding it. */
    lockMinSpeed: 6,
  },

  aero: {
    /** Linear damping applied to the chassis body; stands in for drag. */
    linearDamping: 0.06,
    angularDamping: 0.9,
    /**
     * Downforce coefficient: N per (m/s)^2. At 4.2 this reached 29 kN at top
     * speed — 2.6x the car's weight — and bottomed the suspension. 0.5 gives a
     * more plausible ~3.4 kN (about 30% of weight) at 300 km/h.
     */
    downforce: 0.5,
  },

  /**
   * Spawn transform, also used by the reset handler. Derived from the loaded
   * world, never hard-coded: on the circuit that is the grid slot (the world
   * origin sits in the infield), and in the city it is one of a dozen surveyed
   * on-road spawns spread across the map, chosen per drive — see
   * `cityConfig.pickCitySpawn`.
   */
  spawn: WORLD_ID === 'city' ? pickCitySpawn() : trackSpawn(),
} as const;

/**
 * Camera offsets scale with the car.
 *
 * Every distance below was framed on the McLaren — 4.29 m long, 1.14 m tall.
 * Left fixed, the rig ends up inside the bodywork of a tall SUV and buried
 * in a semi tractor. Length drives how far back the rig sits and
 * height drives how far up, each relative to the reference car, so a big
 * vehicle is framed the same way a small one is.
 */
const REFERENCE_LENGTH = 4.287;
const REFERENCE_HEIGHT = 1.14;
/**
 * `rigSize` overrides the vehicle's own bounds where framing the whole thing
 * would be wrong — an articulated tram is framed on its driving end, not on all
 * 24 m of it, which would otherwise put the chase rig 34 m back.
 */
const RIG_SIZE = SELECTED.rigSize ?? SELECTED.size;
const LENGTH_SCALE = RIG_SIZE[2] / REFERENCE_LENGTH;
const HEIGHT_SCALE = RIG_SIZE[1] / REFERENCE_HEIGHT;

/** Scales a chase/close offset triple, leaving the lateral component alone. */
const rigOffset = (x: number, y: number, z: number): Vec3 =>
  [x, y * HEIGHT_SCALE, z * LENGTH_SCALE];

export const CAMERA = {
  /**
   * The chase rig follows the car's heading through a damped *angle*, not by
   * being pinned to the chassis. That lag is the whole character of the camera:
   * turn in and the rig trails, swings wide, then gathers itself up behind you.
   * Pinning it rigidly is what makes a chase cam feel like a tripod bolted to
   * the boot.
   */
  chase: {
    /** Offset behind and above the car, in chassis space (-Z is forward). */
    offset: rigOffset(0, 1.6, 5.9),
    lookAhead: 6 * LENGTH_SCALE,
    /** Position smoothing half-life in seconds — frame-rate independent. */
    positionHalfLife: 0.11,
    targetHalfLife: 0.09,
    fov: 60,
    /** Extra FOV added as speed approaches `maxSpeedKph`. */
    fovBoost: 9,
    /** Half-life of the rig's yaw follow. Larger swings wider through a corner. */
    yawHalfLife: 0.30,
    /** Extra trail, in radians, per rad/s the car is turning. */
    swingPerYawRate: 0.22,
    /** Ceiling on that trail, so a spin does not fling the rig round. */
    maxSwing: 0.5,
    /** Seconds of sustained reverse before the rig sweeps round to look back. */
    reverseDwell: 0.35,
    /** Half-life of the sweep itself, and of its return. */
    reverseHalfLife: 0.4,
    /** Fraction of the base distance added at top speed. */
    distanceBoost: 0.35,
    /** Metres of extra height at top speed. */
    heightBoost: 0.45,
    /** Fraction of the distance pulled in while reversing. */
    reverseTuck: 0.3,
  },
  close: {
    offset: rigOffset(0, 1.25, 4.1),
    lookAhead: 5 * LENGTH_SCALE,
    positionHalfLife: 0.08,
    targetHalfLife: 0.06,
    fov: 57,
    fovBoost: 8,
    yawHalfLife: 0.20,
    swingPerYawRate: 0.15,
    maxSwing: 0.38,
    reverseDwell: 0.35,
    reverseHalfLife: 0.35,
    distanceBoost: 0.28,
    heightBoost: 0.3,
    reverseTuck: 0.3,
  },
  cockpit: {
    /**
     * The McLaren F1 has a central driving position, hence x = 0 — which also
     * happens to be the only sane default for a garage where nothing else
     * models an interior worth sitting in.
     */
    offset: [0, 0.93 * HEIGHT_SCALE, -0.42 * LENGTH_SCALE] as Vec3,
    lookAhead: 12,
    positionHalfLife: 0.02,
    targetHalfLife: 0.07,
    fov: 72,
    fovBoost: 8,
  },
} as const;
