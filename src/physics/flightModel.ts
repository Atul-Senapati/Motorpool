/**
 * How an aircraft flies here, shared by the drone and the helicopter.
 *
 * Both are flown the same way — four sticks, each asking for a velocity — and
 * the difference between a quadcopter and a twin-engine helicopter is entirely
 * in the numbers: how hard it accelerates, how far it leans to do it, how
 * quickly it answers the pedals. Keeping one integration and two `FlightSpec`s
 * is what makes that claim testable rather than a hope; when the helicopter
 * felt wrong it was a figure that was wrong, not a second copy of the physics
 * that had drifted.
 *
 * ## Velocity, not force
 *
 * A car's throttle asks for torque and the road decides what happens. An
 * aircraft under a pilot's hand is closer to the opposite: the stick asks for
 * a *velocity*, the machine leans over and delivers it. So each axis here sets
 * a target speed, the airframe accelerates toward it at `accel`, and the body
 * pitches and rolls in proportion to the acceleration it is actually taking.
 * That tilt is not decoration — an aircraft that translates without leaning
 * reads as a camera on a wire, and one that leans reads as a machine holding
 * itself up on a disc it has tipped over.
 *
 * With the sticks centred nothing is asked for and the airframe coasts down
 * under `drag`, which is what a GPS-hold quad and a helicopter in trim both
 * do; the brake key stops it hard.
 *
 * Integrated here rather than by the solver, for the reason `BoatRide` gives:
 * what holds an aircraft up is a force field, not a contact, and a dynamic
 * body spends its life arguing with a surface that is not there.
 */

/** What separates one airframe from another. */
export interface FlightSpec {
  /** Horizontal speed caps, m/s: normal, and with the sport key held. */
  cruise: number;
  sport: number;
  /** Horizontal acceleration toward the asked-for velocity, m/s². */
  accel: number;
  /** With the brake held. */
  brake: number;
  /** Climb and descent rate cap, m/s. Sport doubles it. */
  climb: number;
  climbAccel: number;
  /** Full-pedal yaw rate, rad/s, and how fast that rate is reached. */
  yawRate: number;
  yawAccel: number;
  /** Share of velocity kept per second with the sticks centred. */
  drag: number;
  /** Body tilt per m/s² of acceleration, and its cap, radians. */
  tiltPerAccel: number;
  tiltMax: number;
  /** Half-life of the visual attitude following the asked-for one, seconds. */
  tiltHalfLife: number;
  /** Floor over whatever is underneath, and the absolute ceiling, metres. */
  clearance: number;
  ceiling: number;
  /**
   * The hover is never still. A rotor disc holding two tonnes up wanders by a
   * degree or so and a quad's flight controller hunts by a fraction of that;
   * this is the amplitude of that wander in radians, laid over the attitude as
   * three slow sines that never repeat. Zero for a machine that sits dead.
   */
  wobble: number;
  /**
   * Torque coupling, rad/s per unit of effort change per second. Pull power
   * on a single-rotor helicopter and the nose swings against the disc until
   * the pedals catch it; this is that swing, and zero on a quad, whose four
   * rotors cancel it.
   */
  torqueYaw: number;
  /** How much the airframe shakes with effort, as the camera's slip figure. */
  vibration: number;
}

/** Where the aircraft is and what it is doing. Mutated in place every step. */
export interface FlightState {
  x: number; y: number; z: number;
  heading: number;
  vx: number; vy: number; vz: number;
  yawRate: number;
  /** Visual attitude, radians, eased toward the tilt the acceleration asks for. */
  pitch: number; roll: number;
  /** World height of the surface under the aircraft, or -Infinity over nothing. */
  ground: number;
  /** Last step's effort, for the torque swing, and a clock for the wobble. */
  effort: number;
  clock: number;
}

/** The sticks, already normalised to -1..1 and two booleans. */
export interface FlightSticks {
  move: number;
  strafe: number;
  climb: number;
  yaw: number;
  sport: boolean;
  hold: boolean;
}

/** What the caller needs back for telemetry, sound and rotors. */
export interface FlightReadout {
  /** Speed along the aircraft's own nose, m/s. Negative going backwards. */
  ahead: number;
  /** Speed over the ground, m/s. */
  horizontal: number;
  /** How hard the machine is working, 0..1. Drives rotor rate and the tacho. */
  effort: number;
  /** True while the sticks are asking for something. */
  asking: boolean;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const approach = (v: number, target: number, maxStep: number) =>
  v + clamp(target - v, -maxStep, maxStep);

/** Bounds the aircraft may not leave, so neither can wander off the world. */
export interface FlightBounds {
  minX: number; maxX: number; minZ: number; maxZ: number;
}

/**
 * One step. `groundAt` is asked for the height of whatever is under the
 * aircraft *after* it has moved — a roof edge is exactly where a stale reading
 * hurts, so it is sampled every step rather than cached.
 */
export function stepFlight(
  s: FlightState,
  spec: FlightSpec,
  sticks: FlightSticks,
  dt: number,
  bounds: FlightBounds,
  groundAt: (x: number, y: number, z: number) => number,
): FlightReadout {
  const cap = sticks.sport ? spec.sport : spec.cruise;
  const climbCap = sticks.sport ? spec.climb * 2 : spec.climb;

  /* ------------------------------------------------------------------ yaw */
  const wantedYaw = -sticks.yaw * spec.yawRate;
  s.yawRate = approach(s.yawRate, wantedYaw, spec.yawAccel * dt);
  s.heading += s.yawRate * dt;

  /* ------------------------------------------------- horizontal velocity */
  const fx = -Math.sin(s.heading);
  const fz = -Math.cos(s.heading);
  // Right of forward, the convention the rest of the game uses.
  const rx = -fz;
  const rz = fx;
  const asking = sticks.move !== 0 || sticks.strafe !== 0;
  const wantAhead = sticks.hold ? 0 : sticks.move * cap;
  const wantSide = sticks.hold ? 0 : sticks.strafe * cap;
  const wantVx = fx * wantAhead + rx * wantSide;
  const wantVz = fz * wantAhead + rz * wantSide;
  // The brake is the hardest the machine can push; a stick that is merely
  // centred gets a gentler settle than one being actively reversed.
  const accel = sticks.hold ? spec.brake : asking ? spec.accel : spec.accel * 0.6;
  let dvx = wantVx - s.vx;
  let dvz = wantVz - s.vz;
  const want = Math.hypot(dvx, dvz);
  const step = accel * dt;
  if (want > step) { dvx *= step / want; dvz *= step / want; }
  // Kept before the drag below, so the tilt reflects what the machine is
  // doing under power rather than what the air is doing to it.
  const ax = dvx / dt;
  const az = dvz / dt;
  s.vx += dvx;
  s.vz += dvz;
  if (!asking && !sticks.hold) {
    const keep = Math.pow(spec.drag, dt);
    s.vx *= keep;
    s.vz *= keep;
  }

  /* -------------------------------------------------------------- vertical */
  const wantVy = sticks.hold ? 0 : sticks.climb * climbCap;
  s.vy = approach(s.vy, wantVy, spec.climbAccel * dt);

  /* ------------------------------------------------------------- integrate */
  s.x = clamp(s.x + s.vx * dt, bounds.minX, bounds.maxX);
  s.z = clamp(s.z + s.vz * dt, bounds.minZ, bounds.maxZ);
  s.y += s.vy * dt;
  s.ground = groundAt(s.x, s.y, s.z);
  const floor = (Number.isFinite(s.ground) ? s.ground : -Infinity) + spec.clearance;
  if (s.y < floor) { s.y = floor; if (s.vy < 0) s.vy = 0; }
  if (s.y > spec.ceiling) { s.y = spec.ceiling; if (s.vy > 0) s.vy = 0; }

  /* ---------------------------------------------------------------- readout */
  const horizontal = Math.hypot(s.vx, s.vz);
  const effort = clamp(
    horizontal / spec.sport * 0.6 + Math.abs(s.vy) / spec.climb * 0.3
      + (asking || sticks.climb !== 0 ? 0.25 : 0),
    0, 1,
  );

  /* ----------------------------------------------------------------- torque */
  // Power going on swings the nose one way, coming off swings it the other,
  // and it does so before the pilot has moved a foot. Small, and then damped
  // out by the same yaw settle the pedals use.
  const dEffort = (effort - s.effort) / dt;
  s.effort = effort;
  s.yawRate += dEffort * spec.torqueYaw * dt;

  /* --------------------------------------------------------------- attitude */
  // Accelerating forward pitches the nose down; sliding right rolls right.
  const aAhead = ax * fx + az * fz;
  const aSide = ax * rx + az * rz;
  s.clock += dt;
  // Three incommensurate sines: slow enough to be a wander, never a rhythm.
  const c = s.clock;
  const wobblePitch = (Math.sin(c * 0.73) * 0.5 + Math.sin(c * 1.31 + 1.7) * 0.3 + Math.sin(c * 2.17 + 0.4) * 0.2) * spec.wobble;
  const wobbleRoll = (Math.sin(c * 0.61 + 2.1) * 0.5 + Math.sin(c * 1.09 + 0.9) * 0.3 + Math.sin(c * 1.93 + 2.6) * 0.2) * spec.wobble;
  const wantPitch = clamp(-aAhead * spec.tiltPerAccel, -spec.tiltMax, spec.tiltMax) + wobblePitch;
  const wantRoll = clamp(-aSide * spec.tiltPerAccel, -spec.tiltMax, spec.tiltMax) + wobbleRoll;
  const k = 1 - Math.pow(0.5, dt / spec.tiltHalfLife);
  s.pitch += (wantPitch - s.pitch) * k;
  s.roll += (wantRoll - s.roll) * k;

  return {
    ahead: s.vx * fx + s.vz * fz,
    horizontal,
    effort,
    asking,
  };
}
