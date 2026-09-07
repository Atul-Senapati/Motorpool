'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera as PerspectiveCameraImpl, Quaternion, Vector3, type Group } from 'three';
import { CAMERA, VEHICLE } from '@/config/vehicleConfig';
import { damp } from '@/physics/vehiclePhysics';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { createChaseState, updateChaseCamera } from './ChaseCamera';
import { updateCockpitCamera } from './CockpitCamera';

export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'close', 'cockpit'] as const;

interface RacingCameraProps {
  chassisRef: RefObject<Group | null>;
  telemetry: RefObject<VehicleTelemetry>;
  modeRef: RefObject<CameraMode>;
  /** Bumped whenever the mode changes, so the rig knows to ease the transition. */
  modeChangeToken: number;
  /** Bumped on car reset; the rig re-seats rather than flying across the map. */
  resetToken: number;
}

const carPosition = new Vector3();
const carQuaternion = new Quaternion();
const carVelocity = new Vector3();
const previousCarPosition = new Vector3();
const desiredPosition = new Vector3();
const desiredTarget = new Vector3();
const smoothedTarget = new Vector3();
const shake = new Vector3();

/** Seconds spent easing after a camera-mode change or a reset. */
const TRANSITION_TIME = 0.7;
/** Half-life used at the start of a transition, blended down to the mode's own. */
const TRANSITION_HALF_LIFE = 0.32;

export function RacingCamera({ chassisRef, telemetry, modeRef, modeChangeToken, resetToken }: RacingCameraProps) {
  const camera = useThree((state) => state.camera) as PerspectiveCameraImpl;
  const transition = useRef(0);
  const initialised = useRef(false);
  // The chase rig is a damped angle, so it has to remember where it points.
  const chase = useRef(createChaseState());

  useEffect(() => {
    transition.current = TRANSITION_TIME;
  }, [modeChangeToken]);

  // A reset teleports the car, so easing toward the new pose would send the
  // camera sweeping across the circuit. Re-seat it instead.
  useEffect(() => {
    if (resetToken > 0) {
      initialised.current = false;
      // Re-seat the rig's yaw too, or it spends a second unwinding from
      // wherever the car used to be pointing.
      chase.current.seeded = false;
      chase.current.reverse = 0;
      chase.current.reverseHold = 0;
    }
  }, [resetToken]);

  useFrame((_, rawDelta) => {
    const chassis = chassisRef.current;
    const t = telemetry.current;
    if (!chassis || !t) return;

    // Clamp: a tab regaining focus can hand us a multi-second delta, which
    // would fling the camera across the map.
    const delta = Math.min(rawDelta, 1 / 20);

    chassis.getWorldPosition(carPosition);
    chassis.getWorldQuaternion(carQuaternion);

    if (initialised.current) {
      carVelocity.subVectors(carPosition, previousCarPosition).divideScalar(Math.max(delta, 1e-4));
    } else {
      carVelocity.set(0, 0, 0);
    }
    previousCarPosition.copy(carPosition);

    const mode = modeRef.current ?? 'chase';
    const config = mode === 'cockpit' ? CAMERA.cockpit : mode === 'close' ? CAMERA.close : CAMERA.chase;

    if (mode === 'cockpit') {
      updateCockpitCamera(carPosition, carQuaternion, t, desiredPosition, desiredTarget);
    } else {
      updateChaseCamera(
        config as typeof CAMERA.chase, chase.current, delta,
        carPosition, carQuaternion, carVelocity, t, desiredPosition, desiredTarget,
      );
    }

    if (!initialised.current) {
      initialised.current = true;
      camera.position.copy(desiredPosition);
      smoothedTarget.copy(desiredTarget);
    }

    // Ease the smoothing constants after a mode switch so the cut becomes a move.
    transition.current = Math.max(0, transition.current - delta);
    const blend = transition.current / TRANSITION_TIME;
    const positionHalfLife = config.positionHalfLife + (TRANSITION_HALF_LIFE - config.positionHalfLife) * blend;
    const targetHalfLife = config.targetHalfLife + (TRANSITION_HALF_LIFE - config.targetHalfLife) * blend;

    camera.position.set(
      damp(camera.position.x, desiredPosition.x, positionHalfLife, delta),
      damp(camera.position.y, desiredPosition.y, positionHalfLife, delta),
      damp(camera.position.z, desiredPosition.z, positionHalfLife, delta),
    );
    smoothedTarget.set(
      damp(smoothedTarget.x, desiredTarget.x, targetHalfLife, delta),
      damp(smoothedTarget.y, desiredTarget.y, targetHalfLife, delta),
      damp(smoothedTarget.z, desiredTarget.z, targetHalfLife, delta),
    );

    // Speed and slip shake. Deterministic trig rather than random noise, which
    // would read as a jitter bug instead of a rumble.
    const intensity =
      Math.max(0, t.speedKph - 120) / VEHICLE.engine.maxSpeedKph * 0.05 + t.slip * 0.035;
    if (intensity > 0.0005) {
      const time = performance.now() * 0.001;
      shake.set(
        Math.sin(time * 37.1) * intensity,
        Math.sin(time * 29.7) * intensity * 0.7,
        Math.sin(time * 43.3) * intensity * 0.4,
      );
      camera.position.add(shake);
    }

    camera.lookAt(smoothedTarget);

    // Widen the lens with speed — the cheapest and most effective speed cue.
    const speedRatio = Math.min(t.speedKph / VEHICLE.engine.maxSpeedKph, 1);
    const targetFov = config.fov + config.fovBoost * speedRatio * speedRatio;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = damp(camera.fov, targetFov, 0.25, delta);
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
