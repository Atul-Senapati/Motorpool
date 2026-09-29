/**
 * The helicopter: an EC135, and how it flies.
 *
 * The measurements come from `helicopterData.json`, which
 * `prepare-helicopter.mjs` writes off the model — 10.2 m rotor, 12.31 m long,
 * 3.92 m tall, and the two rotor hubs with the axis each one turns about.
 *
 * ## Why it is not the drone with a bigger mesh
 *
 * It is flown with the same sticks and integrated by the same model
 * (`flightModel`), and everything that makes it feel like two and a half
 * tonnes of aircraft rather than a nine-kilo quad is in the figures here:
 *
 *   it leans          `tiltPerAccel` is nearly twice the drone's, capped at
 *                     24°. A helicopter cannot accelerate without tipping its
 *                     disc, and the lean is how you read its speed from
 *                     outside. The quad's is a shrug by comparison.
 *   it takes its time `accel` is half, `tiltHalfLife` twice, `yawAccel` less
 *                     than half. Asking a helicopter for a new direction and
 *                     getting it a second later is the whole character.
 *   it carries        `drag` at 0.55 against 0.35: let go of the stick and it
 *                     keeps going for a long while, because there is a lot of
 *                     it and not much holding it back.
 *   it is fast        259 km/h in sport, which is an EC135's real cruise, and
 *                     nearly half as fast again as the drone.
 *   it is alive       a degree of hover wander (`wobble`), a nose that swings
 *                     against the disc when power goes on (`torqueYaw`), and
 *                     a shake through the whole frame (`vibration`) that the
 *                     camera picks up. A helicopter is never quite still.
 *
 * The rotor rates are the one set of figures here that are NOT the real ones.
 * A main rotor turns at 395 rpm and a tail rotor at 3,500, and at sixty frames
 * a second both alias into a slow crawl backwards. What is drawn instead is a
 * rate that reads as fast plus a blur disc over it — see `propBlurTexture`.
 */
import data from './helicopterData.json';
import type { Airframe, Triple } from './airframe';

export const HELICOPTER_MODEL = '/models/helicopter.glb';

const triple = (v: number[]): Triple => [v[0], v[1], v[2]];

export const HELICOPTER = {
  /** Span (X, the rotor disc), height (Y), length (Z) — metres, skids at y = 0. */
  size: triple(data.size),
  /** Where the origin sits in those bounds: the mast, with the tail aft of it. */
  extent: { min: triple(data.extent.min), max: triple(data.extent.max) },
  /**
   * The airframe without its rotor disc — 2.86 m across rather than 10.2 —
   * and where its middle sits relative to the mast. The collider is built from
   * this: a box the width of the rotor would refuse to fly down a street the
   * machine fits in.
   */
  hull: { size: triple(data.hull.size), centre: triple(data.hull.centre) },
  triangles: data.triangles,
  /** Main and tail rotor: hub, spin axis and radius, measured by the prepare pass. */
  rotors: data.rotors.map((r) => ({
    id: r.id,
    axis: r.axis as 'x' | 'y' | 'z',
    hub: triple(r.hub),
    radius: r.radius,
  })),
};

export const HELICOPTER_AIRFRAME: Airframe = {
  model: HELICOPTER_MODEL,
  size: HELICOPTER.size,
  spec: {
    // 151 km/h and 259 km/h. The second is an EC135's real cruise.
    cruise: 42,
    sport: 72,
    accel: 7,
    brake: 12,
    // The real rate of climb, 1,500 ft/min.
    climb: 8,
    climbAccel: 6,
    yawRate: 1.1,
    yawAccel: 2.6,
    drag: 0.55,
    tiltPerAccel: 0.055,
    tiltMax: 0.42,
    tiltHalfLife: 0.3,
    // Skids, not props: it can sit closer to a roof than the quad can.
    clearance: 0.4,
    ceiling: 600,
    // About a degree of hover wander, the nose swinging a little against the
    // disc when power goes on, and a steady shake through the frame.
    wobble: 0.018,
    torqueYaw: 0.35,
    vibration: 0.6,
  },
  margin: 900,
  launchHeight: 60,
  camera: {
    back: 26,
    up: 9,
    orbitRadius: 30,
    topHeight: 90,
    // Ahead of the nose — the origin is the mast, and the nose is 5 m forward
    // of it — and below the rotor rather than in it.
    fpvAhead: 5.6,
    fpvUp: 1.4,
  },
  rotorIdle: 9,
  rotorFull: 26,
  idleRpm: 1200,
  maxRpm: 6800,
};
