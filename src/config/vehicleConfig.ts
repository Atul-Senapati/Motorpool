/**
 * Single source of truth for vehicle tuning.
 *
 * Geometry values are NOT hand-authored: `carGeometry.json` is emitted by
 * `scripts/prepare-model.mjs`, measured directly off the McLaren mesh. Re-run
 * `npm run prepare:model` and these stay in sync with the art.
 */
import geometry from './carGeometry.json';
import { CITY } from './cityConfig';
import { trackSpawn } from './trackConfig';
import { WORLD_ID } from './world';
import type { Corner, Vec3, WheelConfig } from '@/types/vehicle';

export const CAR_GEOMETRY = geometry;

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
 * `stiffness * deflection ~= 2.13` for this car's mass.
 * Re-calibrate with `?k=` if VEHICLE.mass or the Rapier version changes.
 */
const SUSPENSION_STIFFNESS = devNumber('k', 2.13 / DESIGN_DEFLECTION);

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

export const VEHICLE = {
  /** Kerb weight of a real McLaren F1. */
  mass: 1140,

  /** Cuboid chassis collider. Inset from the visual shell so it doesn't snag on curbs. */
  chassis: {
    /**
     * Inset from the visual shell, and deliberately raised: the collider must
     * never reach the road at normal ride height, or the car rests on its box
     * instead of its wheels and the suspension stops mattering entirely.
     * Bottom sits at 0.14 m, top at 1.06 m — just clear of the road even with
     * the springs fully compressed.
     */
    halfExtents: [0.88, 0.46, 2.05] as Vec3,
    center: [0, 0.6, -0.19] as Vec3,
  },

  /** Rear-wheel drive, front-wheel steering — as the real car. */
  wheels: [
    wheel('FL', true, false),
    wheel('FR', true, false),
    wheel('RL', false, true),
    wheel('RR', false, true),
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
    maxForce: devNumber('ef', 6600),
    reverseForce: 4200,
    /** Engine force tapers to zero as this speed is approached, capping top end. */
    maxSpeedKph: 340,
    idleRpm: 900,
    maxRpm: 7500,
    /** Ratios are for the RPM readout and gear display only; torque is not modelled per-gear. */
    gearSpeedsKph: [0, 65, 110, 160, 215, 270, 340],
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
   * origin sits in the infield), and in the city it is the widest stretch of
   * road nearest the centre, measured by the map preprocessor.
   */
  spawn: WORLD_ID === 'city' ? CITY.spawn : trackSpawn(),
} as const;

export const CAMERA = {
  chase: {
    /** Offset behind and above the car, in chassis space (-Z is forward). */
    offset: [0, 1.6, 5.9] as Vec3,
    lookAhead: 6,
    /** Position smoothing half-life in seconds — frame-rate independent. */
    positionHalfLife: 0.12,
    targetHalfLife: 0.09,
    fov: 60,
    /** Extra FOV added as speed approaches `maxSpeedKph`. */
    fovBoost: 9,
  },
  close: {
    offset: [0, 1.25, 4.1] as Vec3,
    lookAhead: 5,
    positionHalfLife: 0.08,
    targetHalfLife: 0.06,
    fov: 57,
    fovBoost: 8,
  },
  cockpit: {
    /** The McLaren F1 has a central driving position, hence x = 0. */
    offset: [0, 0.93, -0.42] as Vec3,
    lookAhead: 12,
    positionHalfLife: 0.02,
    targetHalfLife: 0.07,
    fov: 72,
    fovBoost: 8,
  },
} as const;
