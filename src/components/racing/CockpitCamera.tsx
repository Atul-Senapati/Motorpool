'use client';

import { Quaternion, Vector3 } from 'three';
import { CAMERA } from '@/config/vehicleConfig';
import type { VehicleTelemetry } from '@/types/vehicle';

const forward = new Vector3();
const offset = new Vector3();

/**
 * Driver's-eye camera.
 *
 * Unlike the chase cam this one DOES inherit the full chassis rotation — you
 * want to feel the car pitch under braking from inside it. The eye point sits
 * on the centreline because the McLaren F1 has a central driving position.
 */
export function updateCockpitCamera(
  carPosition: Vector3,
  carQuaternion: Quaternion,
  telemetry: VehicleTelemetry,
  outPosition: Vector3,
  outTarget: Vector3,
) {
  const config = CAMERA.cockpit;

  offset.set(config.offset[0], config.offset[1], config.offset[2]).applyQuaternion(carQuaternion);
  outPosition.copy(carPosition).add(offset);

  forward.set(0, 0, -1).applyQuaternion(carQuaternion);
  outTarget.copy(outPosition).addScaledVector(forward, config.lookAhead);
  // Glance very slightly into the corner, following the steering rack.
  outTarget.y -= telemetry.slip * 0.4;
}
