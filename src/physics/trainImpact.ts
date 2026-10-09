import { Quaternion, Vector3 } from 'three';
import type { RapierRigidBody } from '@react-three/rapier';

/**
 * Being hit by a train.
 *
 * The trains are kinematic: the solver treats them as infinite mass and only
 * pushes a car out of the box, which at a crawl is a polite shove and at speed
 * is whatever a one-step depenetration happens to come out as. A train is
 * three hundred tonnes; meeting one should never be polite. So on the first
 * contact the car is given a hard kick of its own — out of the side it was
 * struck on, or off the nose, with lift and a tumble — that never drops
 * below `MIN_KICK` however slowly either of them was going, and grows with
 * the train's speed and the car's.
 *
 * Event-driven: nothing here runs until a car actually touches a train, so it
 * costs nothing per frame.
 */

/** `userData` on every AI train/tram body, so a contact can recognise one. */
export const TRAIN_BODY = { train: true } as const;

export const isTrainBody = (body: RapierRigidBody | undefined | null) =>
  !!(body?.userData as { train?: boolean } | undefined)?.train;

export const TRAIN_IMPACT = {
  /** m/s the car leaves at, at the very least — about 50 km/h, even at a crawl. */
  minKick: 14,
  /** Ceiling, so a 200 km/h meeting launches a car rather than orbiting it. */
  maxKick: 42,
  /** How much of the train's own speed goes into the kick on top of `minKick`. */
  trainGain: 1.1,
  /** And of the speed the car drove in at. */
  carGain: 0.45,
  /** Upward share of the kick: a car hit by a train leaves the ground. */
  lift: 0.32,
  /** rad/s of tumble per m/s of kick. */
  spin: 0.22,
  /** Seconds before the same car can be kicked again (contacts repeat). */
  cooldown: 0.7,
} as const;

/**
 * Camera jolt, 0..1. Set by the hit, decayed by `RacingCamera`. A plain shared
 * object rather than telemetry: it is an effect, not a reading.
 */
export const impactShake = { amount: 0 };

const q = new Quaternion();
const forward = new Vector3();
const right = new Vector3();
const offset = new Vector3();
const out = new Vector3();

/**
 * Applies the hit to `car`. Call from a before-physics-step callback only —
 * body writes from anywhere else race the step (see CarPhysics).
 */
export function applyTrainHit(car: RapierRigidBody, train: RapierRigidBody) {
  const c = car.translation();
  const t = train.translation();
  const r = train.rotation();
  q.set(r.x, r.y, r.z, r.w);
  forward.set(0, 0, 1).applyQuaternion(q);
  forward.y = 0;
  forward.normalize();
  right.set(-forward.z, 0, forward.x);
  offset.set(c.x - t.x, 0, c.z - t.z);

  // Struck on the nose or tail: thrown ahead of it. Struck down the side:
  // thrown out sideways from the side it was on.
  const half = train.numColliders() > 0 ? train.collider(0).halfExtents().z : 10;
  const along = offset.dot(forward);
  if (Math.abs(along) > half - 0.5) out.copy(forward).multiplyScalar(Math.sign(along) || 1);
  else out.copy(right).multiplyScalar(Math.sign(offset.dot(right)) || 1);

  const tv = train.linvel();
  const cv = car.linvel();
  const trainSpeed = Math.hypot(tv.x, tv.z);
  const carSpeed = Math.hypot(cv.x, cv.z);
  const kick = Math.min(
    TRAIN_IMPACT.maxKick,
    TRAIN_IMPACT.minKick + trainSpeed * TRAIN_IMPACT.trainGain + carSpeed * TRAIN_IMPACT.carGain,
  );

  // The car leaves with the train's own velocity plus the kick — so a car
  // pinned to the nose is carried and flung, never left inside the box.
  const mass = car.mass();
  const target = {
    x: tv.x + out.x * kick,
    y: Math.max(cv.y, 0) + kick * TRAIN_IMPACT.lift,
    z: tv.z + out.z * kick,
  };
  car.applyImpulse({
    x: (target.x - cv.x) * mass,
    y: (target.y - cv.y) * mass,
    z: (target.z - cv.z) * mass,
  }, true);

  // Tumble: roll about the train's line (away from it) and a flat spin.
  const spin = kick * TRAIN_IMPACT.spin;
  const side = Math.sign(offset.dot(right)) || 1;
  car.setAngvel({
    x: forward.x * spin * side,
    y: spin * 0.6 * (along >= 0 ? 1 : -1),
    z: forward.z * spin * side,
  }, true);

  impactShake.amount = Math.min(1, 0.45 + kick / TRAIN_IMPACT.maxKick);
}
