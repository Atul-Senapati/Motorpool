'use client';

import { Quaternion, Vector3 } from 'three';
import { CAMERA, VEHICLE } from '@/config/vehicleConfig';
import { damp } from '@/physics/vehiclePhysics';
import type { VehicleTelemetry } from '@/types/vehicle';

type ChaseConfig = typeof CAMERA.chase | typeof CAMERA.close;

/** Scratch vectors — module scope so the per-frame path allocates nothing. */
const forward = new Vector3();
const rigForward = new Vector3();
const velocity = new Vector3();
const offset = new Vector3();
const yawQuat = new Quaternion();
const UP = new Vector3(0, 1, 0);

const TAU = Math.PI * 2;
/** Shortest signed angle from `a` to `b`, so the rig never unwinds the long way. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Rig state that has to survive between frames.
 *
 * The camera is a damped *angle* rather than a fixed offset, so it needs
 * somewhere to remember where it currently points.
 */
export interface ChaseState {
  /** Rig yaw in radians. Its lag behind the car is the corner swing. */
  yaw: number;
  /** Car yaw last frame, differenced to get the turn rate. */
  carYaw: number;
  /** Seconds of sustained reverse, for hysteresis on the sweep. */
  reverseHold: number;
  /** 0 = looking over the bonnet, 1 = swung round to look over the boot. */
  reverse: number;
  seeded: boolean;
}

export const createChaseState = (): ChaseState => ({
  yaw: 0, carYaw: 0, reverseHold: 0, reverse: 0, seeded: false,
});

/**
 * Third-person chase camera.
 *
 * Four deliberate choices:
 *
 *  - The rig uses a YAW-ONLY frame, not the chassis quaternion. Inheriting body
 *    roll and pitch from the suspension makes the horizon wobble constantly.
 *  - That yaw is a *damped follow* of where the car is going, not a copy of
 *    where it points. Turn in and the rig trails, swings wide and then settles
 *    back behind you; a rig pinned to the chassis feels bolted to the boot.
 *  - At speed the heading is blended slightly toward the velocity direction, so
 *    during a slide you see where the car is actually going rather than where
 *    its nose happens to be aimed.
 *  - Reverse for more than a moment and the rig sweeps round to look the way you
 *    are travelling, instead of leaving you to reverse blind into the camera.
 *    The dwell and the eased blend are what stop it flip-flopping when you rock
 *    back and forth off a kerb.
 */
export function updateChaseCamera(
  config: ChaseConfig,
  state: ChaseState,
  delta: number,
  carPosition: Vector3,
  carQuaternion: Quaternion,
  carVelocity: Vector3,
  telemetry: VehicleTelemetry,
  outPosition: Vector3,
  outTarget: Vector3,
) {
  // Car heading, flattened to the ground plane.
  forward.set(0, 0, -1).applyQuaternion(carQuaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();

  // A three.js object faces -Z, so a heading h gives forward = (-sin h, -cos h).
  // Inverting that is what maps the forward vector back to a yaw angle; using
  // atan2(f.x, f.z) instead puts the rig 180 degrees out, i.e. in front of the car.
  const carYaw = Math.atan2(-forward.x, -forward.z);

  if (!state.seeded) {
    state.yaw = carYaw;
    state.carYaw = carYaw;
    state.seeded = true;
  }

  const turnRate = angleDelta(state.carYaw, carYaw) / Math.max(delta, 1e-4);
  state.carYaw = carYaw;

  // --- where the car is actually going -------------------------------------
  velocity.copy(carVelocity);
  velocity.y = 0;
  const speed = velocity.length();
  let travelYaw = carYaw;
  if (speed > 3 && !telemetry.reversing) {
    // Only meaningful above walking pace, and never while reversing — the
    // velocity heading is 180 degrees out from the nose in that case, and the
    // reverse sweep below handles it deliberately instead.
    velocity.divideScalar(speed);
    const velocityYaw = Math.atan2(-velocity.x, -velocity.z);
    travelYaw = carYaw + angleDelta(carYaw, velocityYaw) * 0.18;
  }

  // --- reverse sweep, with hysteresis --------------------------------------
  const wantReverse = telemetry.reversing && telemetry.forwardSpeed < -0.8;
  state.reverseHold = wantReverse ? state.reverseHold + delta : 0;
  const reverseTarget = state.reverseHold > config.reverseDwell ? 1 : 0;
  state.reverse = damp(state.reverse, reverseTarget, config.reverseHalfLife, delta);

  // Committing at the halfway point rather than interpolating the angle: yaw and
  // yaw + pi are antipodal, so blending between them is undefined in direction.
  // Letting the damped follow below sweep the short way round is both defined
  // and what reads naturally.
  let targetYaw = state.reverse > 0.5 ? travelYaw + Math.PI : travelYaw;

  // --- the swing ------------------------------------------------------------
  // Trail the turn rather than tracking it. The damped follow alone produces
  // some of this; the explicit term is what makes a corner feel like one.
  targetYaw -= clamp(turnRate * config.swingPerYawRate, -config.maxSwing, config.maxSwing);

  state.yaw += angleDelta(state.yaw, targetYaw) * (1 - Math.pow(2, -delta / config.yawHalfLife));

  // --- place the rig --------------------------------------------------------
  yawQuat.setFromAxisAngle(UP, state.yaw);
  rigForward.set(0, 0, -1).applyQuaternion(yawQuat);

  // Back off and rise with speed, and tuck in while reversing so the boot does
  // not fill the frame.
  const speedT = Math.min(telemetry.speedKph / VEHICLE.engine.maxSpeedKph, 1);
  const distance = config.offset[2]
    * (1 + config.distanceBoost * speedT)
    * (1 - config.reverseTuck * state.reverse);
  const height = config.offset[1] + config.heightBoost * speedT;

  offset.set(config.offset[0], height, distance).applyQuaternion(yawQuat);

  // Under acceleration the camera drops back and lower; under braking it draws
  // in. Small, but it is most of the "feel" of a chase cam.
  const throttleLean = telemetry.forwardSpeed * 0.012;
  outPosition.copy(carPosition).add(offset);
  outPosition.addScaledVector(rigForward, throttleLean);
  outPosition.y += Math.min(telemetry.speedKph, 300) * 0.0008;

  // Look along the rig, not along the nose: while the rig is swinging, the eye
  // should go where the rig is going.
  outTarget.copy(carPosition);
  outTarget.addScaledVector(rigForward, config.lookAhead);
  outTarget.y += 0.7;

  // During a big slide the rig can swing round and end up inside the car, so
  // hold a minimum standoff along whatever direction it ended up on.
  const minDistance = 2.6;
  offset.subVectors(outPosition, carPosition);
  const distanceOut = offset.length();
  if (distanceOut < minDistance) {
    if (distanceOut < 1e-4) offset.set(0, 1, 1);
    outPosition.copy(carPosition).addScaledVector(offset.normalize(), minDistance);
    outPosition.y = Math.max(outPosition.y, carPosition.y + 1.1);
  }
}
