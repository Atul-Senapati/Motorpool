'use client';

import { Quaternion, Vector3 } from 'three';
import { AIRFRAME } from '@/config/airframe';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import type { RailShot } from './RailCamera';

/**
 * The aircraft's cameras — the drone's and the helicopter's, which are the
 * same four shots at two scales (`Airframe.camera`).
 *
 * - `chase`  behind and above, turning with the aircraft. The flying view.
 * - `fpv`    from the nose, looking where it points and leaning with it. The
 *            goggles view, and the one that makes a slide feel like one.
 * - `orbit`  a slow circle round the aircraft, the cinematic shot every drone
 *            reel has and every helicopter news package too.
 * - `top`    straight down from overhead. The survey view: this is the one to
 *            use when the aircraft is being used to *look at* a place — pair
 *            it with `?at=x,z` and you have a map you can fly.
 */

export const AIR_CAMERA_MODES: readonly CameraMode[] = ['chase', 'fpv', 'orbit', 'top'] as const;

export const isAirShot = (mode: CameraMode) =>
  mode === 'chase' || mode === 'fpv' || mode === 'orbit' || mode === 'top';

export interface AirCamState {
  orbit: number;
}
export const createAirCamState = (): AirCamState => ({ orbit: 0 });

const SHOT: Record<'chase' | 'fpv' | 'orbit' | 'top', RailShot> = {
  chase: { fov: 64, fovBoost: 10, positionHalfLife: 0.16, targetHalfLife: 0.08 },
  fpv: { fov: 84, fovBoost: 8, positionHalfLife: 0.015, targetHalfLife: 0.015 },
  orbit: { fov: 52, fovBoost: 0, positionHalfLife: 0.4, targetHalfLife: 0.2 },
  top: { fov: 60, fovBoost: 0, positionHalfLife: 0.35, targetHalfLife: 0.25 },
};

const forward = new Vector3();
const up = new Vector3();

/** How fast the orbit goes round, rad/s. Slow enough to be a shot, not a spin. */
const ORBIT_RATE = 0.22;

export function updateAirCamera(
  mode: CameraMode,
  state: AirCamState,
  delta: number,
  t: VehicleTelemetry,
  attitude: Quaternion,
  outPosition: Vector3,
  outTarget: Vector3,
): RailShot {
  const rig = AIRFRAME.camera;
  const fx = -Math.sin(t.heading);
  const fz = -Math.cos(t.heading);

  switch (mode) {
    case 'fpv': {
      forward.set(0, 0, -1).applyQuaternion(attitude);
      up.set(0, 1, 0).applyQuaternion(attitude);
      // Ahead of the airframe rather than inside it: on the quad that is past
      // the props, on the helicopter past the nose and under the disc.
      outPosition.set(
        t.x + forward.x * rig.fpvAhead + up.x * rig.fpvUp,
        t.y + forward.y * rig.fpvAhead + up.y * rig.fpvUp,
        t.z + forward.z * rig.fpvAhead + up.z * rig.fpvUp,
      );
      outTarget.copy(outPosition).addScaledVector(forward, 20);
      return SHOT.fpv;
    }
    case 'orbit': {
      state.orbit += delta * ORBIT_RATE;
      outPosition.set(
        t.x + Math.cos(state.orbit) * rig.orbitRadius,
        t.y + rig.orbitRadius * 0.45,
        t.z + Math.sin(state.orbit) * rig.orbitRadius,
      );
      outTarget.set(t.x, t.y, t.z);
      return SHOT.orbit;
    }
    case 'top': {
      // Straight down, with the aim a hair ahead so "up" on screen is the
      // aircraft's forward and the camera never spins about its own axis.
      outPosition.set(t.x, t.y + rig.topHeight, t.z);
      outTarget.set(t.x + fx * 0.5, t.y, t.z + fz * 0.5);
      return SHOT.top;
    }
    default: {
      outPosition.set(t.x - fx * rig.back, t.y + rig.up, t.z - fz * rig.back);
      outTarget.set(t.x + fx * rig.back * 0.6, t.y + 0.4, t.z + fz * rig.back * 0.6);
      return SHOT.chase;
    }
  }
}
