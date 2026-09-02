'use client';

import { Quaternion, Vector3 } from 'three';
import { CAMERA } from '@/config/vehicleConfig';
import type { VehicleTelemetry } from '@/types/vehicle';

type ChaseConfig = typeof CAMERA.chase | typeof CAMERA.close;

/** Scratch vectors — module scope so the per-frame path allocates nothing. */
const forward = new Vector3();
const velocity = new Vector3();
const offset = new Vector3();
const yawQuat = new Quaternion();
const UP = new Vector3(0, 1, 0);

/**
 * Third-person chase camera.
 *
 * Two deliberate choices:
 *  - The rig uses a YAW-ONLY frame, not the chassis quaternion. Inheriting body
 *    roll and pitch from the suspension makes the horizon wobble constantly.
 *  - At speed the frame is blended slightly toward the velocity heading, so
 *    during a slide you see where the car is actually going rather than where
 *    its nose is pointing.
 */
export function updateChaseCamera(
  config: ChaseConfig,
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

  velocity.copy(carVelocity);
  velocity.y = 0;
  const speed = velocity.length();
  if (speed > 3) {
    // Only meaningful above walking pace, and never while reversing.
    velocity.divideScalar(speed);
    if (!telemetry.reversing) forward.lerp(velocity, 0.18).normalize();
  }

  // A three.js object faces -Z, so a heading h gives forward = (-sin h, -cos h).
  // Inverting that is what maps the forward vector back to a yaw angle; using
  // atan2(f.x, f.z) instead puts the rig 180 degrees out, i.e. in front of the car.
  const yaw = Math.atan2(-forward.x, -forward.z);
  yawQuat.setFromAxisAngle(UP, yaw);

  offset.set(config.offset[0], config.offset[1], config.offset[2]).applyQuaternion(yawQuat);

  // Under acceleration the camera drops back and lower; under braking it draws
  // in. Small, but it is most of the "feel" of a chase cam.
  const throttleLean = telemetry.forwardSpeed * 0.012;
  outPosition.copy(carPosition).add(offset);
  outPosition.addScaledVector(forward, -throttleLean);
  outPosition.y += Math.min(telemetry.speedKph, 300) * 0.0008;

  outTarget.copy(carPosition);
  outTarget.addScaledVector(forward, config.lookAhead);
  outTarget.y += 0.7;

  // During a big slide the rig can swing round and end up inside the car, so
  // hold a minimum standoff along whatever direction it ended up on.
  const minDistance = 2.6;
  offset.subVectors(outPosition, carPosition);
  const distance = offset.length();
  if (distance < minDistance) {
    if (distance < 1e-4) offset.set(0, 1, 1);
    outPosition.copy(carPosition).addScaledVector(offset.normalize(), minDistance);
    outPosition.y = Math.max(outPosition.y, carPosition.y + 1.1);
  }
}
