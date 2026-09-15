'use client';

import { Quaternion, Vector3 } from 'three';
import { DRONE } from '@/config/droneConfig';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import type { RailShot } from './RailCamera';

/**
 * The drone's cameras.
 *
 * - `chase`  behind and above, turning with the drone. The flying view.
 * - `fpv`    from the airframe, looking where it points and tilting with it —
 *            the goggles view, and the one that makes a slide feel like one.
 * - `orbit`  a slow circle round the drone at a fixed radius, the cinematic
 *            shot every drone reel has.
 * - `top`    straight down from forty metres over it. The survey view: this
 *            is the one to use when the drone is being used to *look at* a
 *            place — pair it with `?at=x,z` and you have a map you can fly.
 */

export const DRONE_CAMERA_MODES: readonly CameraMode[] = ['chase', 'fpv', 'orbit', 'top'] as const;

export const isDroneShot = (mode: CameraMode) =>
  mode === 'chase' || mode === 'fpv' || mode === 'orbit' || mode === 'top';

export interface DroneCamState {
  orbit: number;
}
export const createDroneCamState = (): DroneCamState => ({ orbit: 0 });

const SHOT: Record<'chase' | 'fpv' | 'orbit' | 'top', RailShot> = {
  chase: { fov: 64, fovBoost: 10, positionHalfLife: 0.16, targetHalfLife: 0.08 },
  fpv: { fov: 84, fovBoost: 8, positionHalfLife: 0.015, targetHalfLife: 0.015 },
  orbit: { fov: 52, fovBoost: 0, positionHalfLife: 0.4, targetHalfLife: 0.2 },
  top: { fov: 60, fovBoost: 0, positionHalfLife: 0.35, targetHalfLife: 0.25 },
};

const forward = new Vector3();
const up = new Vector3();

/** Behind by this, above by this — scaled off the airframe so a bigger quad gets a longer rig. */
const CHASE_BACK = DRONE.size[2] * 4.2;
const CHASE_UP = DRONE.size[2] * 1.7;
const ORBIT_RADIUS = 11;
const ORBIT_RATE = 0.22;
const TOP_HEIGHT = 40;

export function updateDroneCamera(
  mode: CameraMode,
  state: DroneCamState,
  delta: number,
  t: VehicleTelemetry,
  attitude: Quaternion,
  outPosition: Vector3,
  outTarget: Vector3,
): RailShot {
  const fx = -Math.sin(t.heading);
  const fz = -Math.cos(t.heading);

  switch (mode) {
    case 'fpv': {
      forward.set(0, 0, -1).applyQuaternion(attitude);
      up.set(0, 1, 0).applyQuaternion(attitude);
      // Ahead of the props, not inside the body: the eye sits at the gimbal,
      // 0.7 lengths forward and a little under the airframe. At 0.45 it was
      // between the front arms with a propeller across half the frame.
      const ahead = DRONE.size[2] * 0.7;
      outPosition.set(
        t.x + forward.x * ahead - up.x * 0.04,
        t.y + forward.y * ahead - up.y * 0.04,
        t.z + forward.z * ahead - up.z * 0.04,
      );
      outTarget.copy(outPosition).addScaledVector(forward, 20);
      return SHOT.fpv;
    }
    case 'orbit': {
      state.orbit += delta * ORBIT_RATE;
      outPosition.set(
        t.x + Math.cos(state.orbit) * ORBIT_RADIUS,
        t.y + ORBIT_RADIUS * 0.45,
        t.z + Math.sin(state.orbit) * ORBIT_RADIUS,
      );
      outTarget.set(t.x, t.y, t.z);
      return SHOT.orbit;
    }
    case 'top': {
      // Straight down, with the aim a hair ahead so "up" on screen is the
      // drone's forward and the camera never spins about its own axis.
      outPosition.set(t.x, t.y + TOP_HEIGHT, t.z);
      outTarget.set(t.x + fx * 0.5, t.y, t.z + fz * 0.5);
      return SHOT.top;
    }
    default: {
      outPosition.set(t.x - fx * CHASE_BACK, t.y + CHASE_UP, t.z - fz * CHASE_BACK);
      outTarget.set(t.x + fx * 3, t.y + 0.4, t.z + fz * 3);
      return SHOT.chase;
    }
  }
}
