/**
 * What the game needs to know about an aircraft, and which one is being flown.
 *
 * There are two — a quadcopter and a twin-engine helicopter — and they are
 * flown identically (see `flightModel`) and filmed identically (`AirCamera`).
 * Everything that differs between them is a number, and every one of those
 * numbers is in this shape, so adding a third aircraft is a table entry rather
 * than a third copy of the flying.
 */
import { CITY, pickCitySpawn, switchSpawn } from './cityConfig';
import type { FlightBounds, FlightSpec } from '@/physics/flightModel';
import { onSelectedChange, SELECTED } from './garage';
import { DRONE_AIRFRAME } from './droneConfig';
import { HELICOPTER_AIRFRAME } from './helicopterConfig';

export type Triple = [number, number, number];

export interface Airframe {
  /** The glTF, already prepared: nose −Z, skids at y = 0. */
  model: string;
  /** Width (X), height (Y), length (Z), metres. */
  size: Triple;
  /** How it flies. */
  spec: FlightSpec;
  /** How far outside the city's footprint it may wander, metres. */
  margin: number;
  /** Where a flight starts, in metres over the ground spawn. */
  launchHeight: number;
  /**
   * Where the cameras stand. Stated per aircraft rather than scaled off the
   * size, because a 1.4 m quad and a 12 m helicopter do not want the same
   * multiple of themselves: the quad has to be followed closely enough to see
   * at all, and the helicopter framed far enough back to fit its rotor in.
   */
  camera: {
    /** Chase: metres behind and above. */
    back: number;
    up: number;
    /** Orbit: radius of the circle, metres. */
    orbitRadius: number;
    /** Top-down: how far over it, metres. */
    topHeight: number;
    /** FPV: metres forward of the origin, and up or down from it. */
    fpvAhead: number;
    fpvUp: number;
  };
  /** Rotor rate at idle and at full effort, rad/s. Chosen to look right — see `propBlurTexture`. */
  rotorIdle: number;
  rotorFull: number;
  /** The tacho's note, mapped from effort. */
  idleRpm: number;
  maxRpm: number;
}

/** The aircraft being flown, or the drone's figures when nothing is. */
export let AIRFRAME: Airframe =
  SELECTED.air === 'helicopter' ? HELICOPTER_AIRFRAME : DRONE_AIRFRAME;
// Switching between the drone and the helicopter mid-flight (`setSelected`).
onSelectedChange(() => {
  AIRFRAME = SELECTED.air === 'helicopter' ? HELICOPTER_AIRFRAME : DRONE_AIRFRAME;
});

/** The box neither aircraft may leave: the city's footprint, generously bordered. */
export function airspace(margin: number): FlightBounds {
  return {
    minX: CITY.bounds.min[0] - margin,
    maxX: CITY.bounds.max[0] + margin,
    minZ: CITY.bounds.min[2] - margin,
    maxZ: CITY.bounds.max[2] + margin,
  };
}

/** Where a flight starts. `?at=x,z` or `?at=x,z,y` pins it anywhere on the map. */
export const AT_PARAM = 'at';

export interface AirSpawn {
  position: Triple;
  heading: number;
}

/**
 * Over the ground spawn by default, or over whatever point `?at=` names.
 *
 * This is what makes an aircraft a development tool as well as a vehicle:
 * `?car=drone&at=430,210` puts you over the channel, `&at=430,210,120` puts
 * you a hundred and twenty metres over it, `&at=430,210,120,45` points it
 * north-east while it is there, and the top-down camera turns that into a map
 * you can fly.
 */
export function pickAirSpawn(launchHeight: number): AirSpawn {
  // Switched into the air mid-drive: take off from where the last vehicle was.
  const switched = switchSpawn();
  if (switched) return { position: switched.position, heading: switched.heading };
  const ground = pickCitySpawn();
  const fallback: AirSpawn = {
    position: [ground.position[0], ground.position[1] + launchHeight, ground.position[2]],
    heading: ground.heading,
  };
  if (typeof window === 'undefined') return fallback;
  const at = new URLSearchParams(window.location.search).get(AT_PARAM);
  if (!at) return fallback;
  const parts = at.split(',').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return fallback;
  const [x, z, y, heading] = parts;
  return {
    position: [x, y ?? ground.position[1] + launchHeight, z],
    // A fourth number aims it, in degrees, the same as a ground vehicle's.
    // Without one the aircraft inherits the fallback spawn's yaw, which is a
    // street in the middle of the city and has nothing to do with wherever
    // `?at=` just put you — fine over open ground, useless when you have
    // dropped the drone somewhere specific to look at something specific.
    heading: heading === undefined ? fallback.heading : (heading * Math.PI) / 180,
  };
}
