/**
 * The drone: a heavy-lift quadcopter, and how it flies.
 *
 * The measurements come from `droneData.json`, which `prepare-drone.mjs`
 * writes off the model — span, height, length, the four motor hubs. What is
 * here is what a mesh cannot say: how fast it goes, how hard it accelerates,
 * how it is steered.
 *
 * Flown by `flightModel` and framed by `AirCamera`, both of which it shares
 * with the helicopter; what makes it a quad rather than an aircraft is the
 * figures below. It barely leans (`tiltPerAccel` 0.032 against the
 * helicopter's 0.055), it answers instantly (`tiltHalfLife` 0.16 against 0.3),
 * it spins on the spot (`yawRate` 2.0 against 1.1) and it stops dead when you
 * let go (`drag` 0.35 against 0.55). Nine kilos does all of that; two and a
 * half tonnes does none of it.
 *
 * ## For looking at the world
 *
 * This is also the development camera. `?car=drone&at=x,z[,y]` puts it over
 * any point on the map at any height, and the `top` view looks straight down;
 * the default spawn is forty-five metres over wherever a car would start.
 */
import data from './droneData.json';
import type { Airframe, Triple } from './airframe';

export const DRONE_MODEL = '/models/drone.glb';

const triple = (v: number[]): Triple => [v[0], v[1], v[2]];

export const DRONE = {
  /** Span (X), height (Y), length (Z) — metres, skids at y = 0. */
  size: triple(data.size),
  triangles: data.triangles,
  /** Motor hubs, in the airframe's frame; a prop-blur disc spins over each. */
  rotors: data.rotors.map((r) => triple(r.position)),
  rotorRadius: data.rotorRadius,
};

export const DRONE_AIRFRAME: Airframe = {
  model: DRONE_MODEL,
  size: DRONE.size,
  spec: {
    // 90 and 180 km/h.
    cruise: 25,
    sport: 50,
    accel: 14,
    brake: 26,
    climb: 8,
    climbAccel: 12,
    yawRate: 2.0,
    yawAccel: 6,
    drag: 0.35,
    tiltPerAccel: 0.032,
    tiltMax: 0.5,
    tiltHalfLife: 0.16,
    clearance: 0.6,
    ceiling: 400,
    wobble: 0.004,
    torqueYaw: 0,
    vibration: 0.15,
  },
  margin: 600,
  launchHeight: 45,
  camera: {
    back: 4.7,
    up: 1.9,
    orbitRadius: 11,
    topHeight: 40,
    fpvAhead: 0.78,
    fpvUp: -0.04,
  },
  rotorIdle: 18,
  rotorFull: 40,
  idleRpm: 900,
  maxRpm: 7000,
};
