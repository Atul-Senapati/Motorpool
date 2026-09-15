/**
 * The drone: a heavy-lift quadcopter, and how it flies.
 *
 * The measurements come from `droneData.json`, which `prepare-drone.mjs`
 * writes off the model — span, height, length, the four motor hubs. What is
 * here is what a mesh cannot say: how fast it goes, how hard it accelerates,
 * how it is steered.
 *
 * ## Why a drone is not a car pointed upward
 *
 * A car has one axis of control (the wheel) and its speed comes from the
 * road. A quad has four — forward/back, left/right, up/down and yaw — and every
 * one of them is a *velocity you ask for*, which the airframe then tilts to
 * deliver. So the model is: each stick sets a target velocity along its axis,
 * the drone accelerates toward it (capped at `accel`), and the body pitches
 * and rolls in proportion to that acceleration. That tilt is not cosmetic — it
 * is the whole of how a quad reads as a quad rather than a floating camera.
 *
 * Nothing pushes the drone but its own motors, so with the sticks centred it
 * coasts to a stop under `drag` — a real quad in GPS-hold does exactly this —
 * and SPACE brakes it hard, which is the "hold position" you want when you
 * have found the thing you were looking for.
 *
 * ## For looking at the world
 *
 * This is also the development camera. `?car=drone&at=x,z[,y]` puts it over
 * any point on the map at any height, and the `top` view looks straight down;
 * the default spawn is forty-five metres over wherever a car would start.
 */
import data from './droneData.json';
import { pickCitySpawn } from './cityConfig';

export const DRONE_MODEL = '/models/drone.glb';

type Triple = [number, number, number];
const triple = (v: number[]): Triple => [v[0], v[1], v[2]];

export const DRONE = {
  /** Span (X), height (Y), length (Z) — metres, skids at y = 0. */
  size: triple(data.size),
  triangles: data.triangles,
  /** Motor hubs, in the airframe's frame; a prop-blur disc spins over each. */
  rotors: data.rotors.map((r) => triple(r.position)),
  rotorRadius: data.rotorRadius,
};

export const FLIGHT = {
  /** Cruise and sport (SHIFT) speed caps, m/s. 90 and 180 km/h. */
  cruise: 25,
  sport: 50,
  /** Horizontal acceleration toward the asked-for velocity, m/s². */
  accel: 14,
  /** With SPACE held: the brake. A quad can stop very hard. */
  brake: 26,
  /** Climb and descent rate caps, m/s — sport doubles them. */
  climb: 8,
  /** How quickly the asked-for vertical speed is reached, m/s². */
  climbAccel: 12,
  /** Yaw: full stick rate, rad/s, and how fast the rate is reached. */
  yawRate: 2.0,
  yawAccel: 6,
  /** Coasting: the share of velocity kept per second with the sticks centred. */
  drag: 0.35,
  /** Body tilt per m/s² of horizontal acceleration, and its cap, radians. */
  tiltPerAccel: 0.032,
  tiltMax: 0.5,
  /** How the visual attitude follows the asked-for one — a half-life, seconds. */
  tiltHalfLife: 0.16,
  /** Floor over whatever is under the skids, and the absolute ceiling, metres. */
  clearance: 0.6,
  ceiling: 400,
  /** How far outside the city's footprint the drone may go, metres. */
  margin: 600,
  /** Prop-blur spin, rad/s at hover and at full effort. */
  spinIdle: 18,
  spinFull: 40,
  /** The tacho's note, mapped from motor effort. */
  idleRpm: 900,
  maxRpm: 7000,
} as const;

/** Where a flight starts. `?at=x,z` or `?at=x,z,y` pins it anywhere. */
export const AT_PARAM = 'at';
/** Default height over the ground spawn, metres. */
const LAUNCH_HEIGHT = 45;

export interface DroneSpawn {
  position: Triple;
  heading: number;
}

export function pickDroneSpawn(): DroneSpawn {
  const ground = pickCitySpawn();
  const fallback: DroneSpawn = {
    position: [ground.position[0], ground.position[1] + LAUNCH_HEIGHT, ground.position[2]],
    heading: ground.heading,
  };
  if (typeof window === 'undefined') return fallback;
  const at = new URLSearchParams(window.location.search).get(AT_PARAM);
  if (!at) return fallback;
  const parts = at.split(',').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return fallback;
  const [x, z, y] = parts;
  return {
    position: [x, y ?? ground.position[1] + LAUNCH_HEIGHT, z],
    heading: fallback.heading,
  };
}
