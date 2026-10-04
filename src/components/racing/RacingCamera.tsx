'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera as PerspectiveCameraImpl, Quaternion, Vector3, type Group } from 'three';
import { SELECTED } from '@/config/garage';
import { CAMERA, VEHICLE } from '@/config/vehicleConfig';
import { damp } from '@/physics/vehiclePhysics';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { createChaseState, updateChaseCamera } from './ChaseCamera';
import { updateCockpitCamera } from './CockpitCamera';
import { createRailState, isRailShot, updateRailCamera, type RailShot } from './RailCamera';
import { isTramShot, updateTramCamera } from './TramCamera';
import { createAirCamState, isAirShot, updateAirCamera } from './AirCamera';
import { isDromeShot, updateDromeCamera } from './DromeCamera';

/** The car's views. A rail vehicle has its own — see `RAIL_CAMERA_MODES`. */
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'close', 'cockpit'] as const;

interface RacingCameraProps {
  chassisRef: RefObject<Group | null>;
  telemetry: RefObject<VehicleTelemetry>;
  modeRef: RefObject<CameraMode>;
  /** Bumped whenever the mode changes, so the rig knows to ease the transition. */
  modeChangeToken: number;
  /** Bumped on car reset; the rig re-seats rather than flying across the map. */
  resetToken: number;
  /** 0..1 from the SPEED FX setting: how much the car rig leans, surges and rumbles. */
  fx: number;
}

const carPosition = new Vector3();
const carQuaternion = new Quaternion();
const carVelocity = new Vector3();
const previousCarPosition = new Vector3();
const desiredPosition = new Vector3();
const desiredTarget = new Vector3();
const smoothedTarget = new Vector3();
const shake = new Vector3();
const lookDir = new Vector3();
/** Scratch for the tram rig, which builds two points per frame. Module-level
    for the same reason everything above is: no allocation in the frame loop. */
const tramEye = new Vector3();
const tramAim = new Vector3();

/** Seconds spent easing after a camera-mode change or a reset. */
const TRANSITION_TIME = 0.7;
/** Half-life used at the start of a transition, blended down to the mode's own. */
const TRANSITION_HALF_LIFE = 0.32;

const TAU = Math.PI * 2;
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How a car's camera answers the car, on top of where the rig puts it. All of
 * it scales with the SPEED FX setting, and at OFF the camera is exactly what
 * it was before any of this existed.
 *
 *  - SURGE: drops back under acceleration and is thrown forward under braking,
 *    from the measured longitudinal acceleration — the rig's own lean reads
 *    *speed*, which is why flooring it from 150 felt like nothing happened.
 *  - LEAN: rolls into a corner with the lateral load (yaw rate x speed).
 *  - PUNCH: the frame a boost starts, the lens kicks wide and the eye is
 *    shoved back, then both settle into the steady boost widening.
 *  - RUMBLE: a rotational buzz rising in both size and pitch with speed. It is
 *    rotation rather than the old positional wobble because fifteen metres
 *    behind the car, four centimetres of travel is invisible; a fifth of a
 *    degree is not.
 */
const FEEL = {
  /** Metres back per m/s² of acceleration, and the cap either way. */
  surgePerAccel: 0.075,
  maxSurge: 1.1,
  /** Look-target drop per m/s² of braking: the nose dives with the car. */
  pitchPerAccel: 0.01,
  /**
   * Radians of roll per m/s² of lateral acceleration, and the cap. Kept to a
   * hint — under a degree at the limit. More than that tilts the horizon
   * enough to read as the camera, not the car, doing the cornering.
   */
  rollPerLat: 0.0008,
  maxRoll: 0.012,
  /** Degrees of extra lens, and metres back, at the moment boost fires. */
  punchFov: 6,
  punchBack: 0.6,
  /** Radians of rumble at full speed, and the extra a sliding rear adds. */
  rumble: 0.0026,
  rumbleSlip: 0.004,
  /** Extra fraction of the lens's own speed widening. */
  fovGain: 0.35,
};
export function RacingCamera({ chassisRef, telemetry, modeRef, modeChangeToken, resetToken, fx }: RacingCameraProps) {
  const camera = useThree((state) => state.camera) as PerspectiveCameraImpl;
  const transition = useRef(0);
  const initialised = useRef(false);
  // The chase rig is a damped angle, so it has to remember where it points.
  const chase = useRef(createChaseState());
  // The rail cameras remember where the current cinematic shot is planted.
  const rail = useRef(createRailState());
  const air = useRef(createAirCamState());
  // The car rig's feel — see `FEEL`.
  const feel = useRef({
    lastForward: 0, lastHeading: 0, accel: 0, lat: 0, roll: 0, punch: 0, boosting: false, seeded: false,
  });

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
      feel.current.seeded = false;
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
    // A rail view supplies its own smoothing and lens rather than reading one
    // of the car's configs: the shots are different in kind — one of them does
    // not move with the vehicle at all — so there is nothing to share.
    let shot: RailShot | null = null;
    const config = mode === 'cockpit' ? CAMERA.cockpit : mode === 'close' ? CAMERA.close : CAMERA.chase;

    if (SELECTED.air && isAirShot(mode)) {
      shot = updateAirCamera(mode, air.current, delta, t, carQuaternion, desiredPosition, desiredTarget);
    } else if (SELECTED.rail === 'main' && isRailShot(mode)) {
      shot = updateRailCamera(mode, rail.current, delta, t, desiredPosition, desiredTarget);
    } else if (SELECTED.rail === 'tram' && isTramShot(mode)) {
      // The tram is offered the same six names and used to get the car's chase
      // rig for five of them — see `TRAM_CAMERA`. It has its own line, its own
      // scale and its street for a floor, so it has its own rig.
      shot = updateTramCamera(
        mode, rail.current, delta, t, desiredPosition, desiredTarget, tramEye, tramAim,
      );
    } else if (isDromeShot(mode)) {
      // The Wall of Death's planted shots, offered while the car is in the
      // drum — see `DromeCamera`. After the aircraft and the rail, whose own
      // `top` these must not shadow.
      shot = updateDromeCamera(mode, t, desiredPosition, desiredTarget);
    } else if (mode === 'cockpit') {
      updateCockpitCamera(carPosition, carQuaternion, t, desiredPosition, desiredTarget);
    } else {
      updateChaseCamera(
        config as typeof CAMERA.chase, chase.current, delta,
        carPosition, carQuaternion, carVelocity, t, desiredPosition, desiredTarget,
      );
    }

    // Only a car, and only in its own three views: the rail, air and drome
    // shots are planted or flown, and a sea boat has no road to rumble on.
    const carRig = fx > 0 && !shot && !SELECTED.rail && !SELECTED.air && !SELECTED.sea;
    const f = feel.current;
    if (carRig) {
      if (!f.seeded) {
        f.lastForward = t.forwardSpeed;
        f.lastHeading = t.heading;
        f.accel = 0; f.lat = 0; f.roll = 0; f.punch = 0;
        f.seeded = true;
      }
      // Differenced from telemetry, clamped hard so a crash's one-frame
      // spike is a jolt and not a camera thrown across the street.
      const accel = clamp((t.forwardSpeed - f.lastForward) / delta, -25, 25);
      const yawRate = wrapAngle(t.heading - f.lastHeading) / delta;
      f.lastForward = t.forwardSpeed;
      f.lastHeading = t.heading;
      f.accel = damp(f.accel, accel, 0.14, delta);
      f.lat = damp(f.lat, clamp(yawRate * t.forwardSpeed, -30, 30), 0.12, delta);

      if (t.boosting && !f.boosting && t.speedKph > 20) f.punch = 1;
      f.boosting = t.boosting;
      f.punch = damp(f.punch, 0, 0.2, delta);

      if (mode !== 'cockpit') {
        lookDir.subVectors(desiredTarget, desiredPosition).setY(0);
        if (lookDir.lengthSq() > 1e-6) lookDir.normalize();
        const surge = clamp(f.accel * FEEL.surgePerAccel, -FEEL.maxSurge, FEEL.maxSurge) + f.punch * FEEL.punchBack;
        desiredPosition.addScaledVector(lookDir, -surge * fx);
      }
      desiredTarget.y += clamp(f.accel * FEEL.pitchPerAccel, -0.18, 0.1) * fx;
      f.roll = damp(f.roll, clamp(f.lat * FEEL.rollPerLat, -FEEL.maxRoll, FEEL.maxRoll) * fx, 0.16, delta);
    } else {
      f.seeded = false;
      f.roll = 0; f.punch = 0;
    }

    if (!initialised.current) {
      initialised.current = true;
      camera.position.copy(desiredPosition);
      smoothedTarget.copy(desiredTarget);
    }

    // Ease the smoothing constants after a mode switch so the cut becomes a move.
    transition.current = Math.max(0, transition.current - delta);
    const blend = transition.current / TRANSITION_TIME;
    const basePosition = shot ? shot.positionHalfLife : config.positionHalfLife;
    const baseTarget = shot ? shot.targetHalfLife : config.targetHalfLife;
    const positionHalfLife = basePosition + (TRANSITION_HALF_LIFE - basePosition) * blend;
    const targetHalfLife = baseTarget + (TRANSITION_HALF_LIFE - baseTarget) * blend;

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
    // would read as a jitter bug instead of a rumble. Not on a planted shot:
    // that camera is standing on the ground fifty metres away and has no
    // reason to know how fast the train is going.
    const intensity = mode === 'cinematic' || carRig ? 0
      : Math.max(0, t.speedKph - 120) / VEHICLE.engine.maxSpeedKph * 0.05 + t.slip * 0.035;
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

    if (carRig) {
      // Rumble: two incommensurate sines per axis so it never settles into a
      // visible rhythm, quickening with speed the way a road does under tyres.
      const speedT = clamp((t.speedKph - 40) / 260, 0, 1);
      const amount = (speedT * speedT * FEEL.rumble + clamp(t.slip, 0, 1) * FEEL.rumbleSlip
        + f.punch * 0.003) * fx;
      if (amount > 1e-5) {
        const time = performance.now() * 0.001;
        const rate = 0.6 + speedT * 0.8;
        camera.rotateX((Math.sin(time * 31.3 * rate) + Math.sin(time * 47.9 * rate) * 0.6) * amount);
        camera.rotateY((Math.sin(time * 27.1 * rate) + Math.sin(time * 53.7 * rate) * 0.5) * amount * 0.6);
      }
      if (Math.abs(f.roll) > 1e-5) camera.rotateZ(f.roll);
    }

    // Widen the lens with speed — the cheapest and most effective speed cue.
    const speedRatio = Math.min(t.speedKph / VEHICLE.engine.maxSpeedKph, 1);
    // Boost widens the lens further, on top of whatever speed has already
    // earned. It is the cue that sells the extra push: the same acceleration
    // read purely off the speedometer barely registers at 200 km/h, and the
    // lens pulling wider is felt immediately. Damped by the same `damp` below,
    // so it breathes in and out rather than snapping.
    const lens = shot ?? config;
    const targetFov =
      lens.fov + lens.fovBoost * (speedRatio * speedRatio + (t.boosting ? 0.55 : 0))
        * (carRig ? 1 + FEEL.fovGain * fx : 1)
      + (carRig ? f.punch * FEEL.punchFov * fx : 0);
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = damp(camera.fov, targetFov, 0.25, delta);
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
