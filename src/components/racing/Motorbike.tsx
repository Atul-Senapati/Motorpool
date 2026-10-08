'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Group, Mesh, Quaternion, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import bikeData from '@/config/motorbikeData.json';
import { damp } from '@/physics/vehiclePhysics';
import type { VehicleTelemetry } from '@/types/vehicle';
import { VEHICLE } from '@/config/vehicleConfig';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { pose, rigRider, type RiderRig } from './motoRider';

/**
 * The Firehawk, as it is drawn: a sports bike that leans.
 *
 * Underneath, it drives on the same raycast vehicle as every car (narrow,
 * with its weight at road level so it cannot fall over — see `CarPhysics`).
 * Everything that makes it a motorcycle is here, on top of that body:
 *
 *   lean     about the tyres' contact line, by the corner it is actually
 *            taking: tan(lean) = v·ω / g, the angle at which gravity and
 *            the cornering force balance — so a fast sweeper lays it down
 *            to its knee and a slow junction barely tips it. Eased, so it
 *            rolls in and out rather than snapping.
 *   bars     the fork, bars and front wheel turn about the real steering
 *            axis, raked as the fork is (`prepare-motorbike`).
 *   pitch    hard on the throttle at low speed the front lifts — a few
 *            degrees of wheelie about the rear tyre — and hard on the brakes
 *            the rear goes light, pitching over the front.
 *   rider    sat on it and riding it (`motoRider`): tucked in, hands on the
 *            bars, feet on the pegs, hanging off into the corners.
 */
export const MOTORBIKE_MODEL = '/models/garage/firehawk.glb';

interface Parts {
  root: Object3D;
  steer: Object3D;
  wheelFront: Object3D;
  wheelRear: Object3D;
  rig: RiderRig | null;
}

const AXIS = new Vector3(...(bikeData.steerAxis as [number, number, number])).normalize();
const REAR_Z = bikeData.rearAxle[2];
const FRONT_Z = bikeData.frontAxle[2];
/** The steepest it leans, radians — a road bike's tyres give out past this. */
const MAX_LEAN = 0.95;
/**
 * The tyre's cross-section is round, so a leaning bike rolls about the
 * centre of that curve, not about the tread's middle on the road: about a
 * point this high. Leaned about the ground instead, the tyre's side went
 * under the road at any real lean.
 */
const CROWN = 0.09;

/**
 * Built parts, per scene. Not `userData`: `Object3D.clone` deep-copies that
 * through JSON, and a cache of objects in it would make every clone throw.
 */
const PARTS = new WeakMap<Object3D, Parts>();

/**
 * Assemble the bike out of the file's nodes, once per scene. Also takes a
 * `SkeletonUtils.clone` of an assembled one — the garage's showroom copy —
 * and finds its parts and its (rebound) rig rather than building them again.
 */
export function bikeParts(scene: Object3D): Parts {
  const cached = PARTS.get(scene);
  if (cached) return cached;
  const root = scene.getObjectByName('firehawk') ?? scene;
  const steer = root.getObjectByName('steer')!;
  const wheelFront = root.getObjectByName('wheelFront')!;
  const wheelRear = root.getObjectByName('wheelRear')!;
  // The front wheel hangs off the steering, about the head.
  if (wheelFront.parent !== steer) {
    const [hx, hy, hz] = bikeData.steerHead;
    wheelFront.position.sub(new Vector3(hx, hy, hz));
    steer.add(wheelFront);
  }
  let rig: RiderRig | null = null;
  const rigged = root.getObjectByName('riderSkinned') as SkinnedMesh | undefined;
  if (rigged?.isSkinnedMesh) {
    rig = { mesh: rigged, bones: Object.fromEntries(rigged.skeleton.bones.map((b) => [b.name, b])) as RiderRig['bones'] };
  } else {
    let riderMesh: Mesh | null = null;
    root.getObjectByName('rider')?.traverse((o) => { if (!riderMesh && (o as Mesh).isMesh) riderMesh = o as Mesh; });
    rig = riderMesh ? rigRider(riderMesh, root.getObjectByName('helmet')) : null;
  }
  root.traverse((o) => {
    if ((o as Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  const parts = { root, steer, wheelFront, wheelRear, rig };
  PARTS.set(scene, parts);
  return parts;
}

const _q = new Quaternion();

/** The bike for the showroom: a separate copy, the rider sat on it at rest. */
export function showroomBike(scene: Object3D): Object3D {
  const copy = cloneSkinned(scene);
  const parts = bikeParts(copy);
  if (parts.rig) pose(parts.rig, parts.root, { lean: 0, bars: 0, pace: 0.2, braking: 0 });
  return copy;
}

export function Motorbike({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const { scene } = useGLTF(MOTORBIKE_MODEL, DRACO_PATH);
  const parts = useMemo(() => bikeParts(scene), [scene]);
  const rideGroup = useRef<Group>(null);
  const leanGroup = useRef<Group>(null);
  const pitchPivot = useRef<Group>(null);
  const pitchInner = useRef<Group>(null);
  const state = useRef({
    heading: NaN, yawRate: 0, lean: 0, speed: 0, accel: 0, pitch: 0, braking: 0,
  });

  useFrame((_, rawDelta) => {
    const t = telemetry.current;
    const lean = leanGroup.current;
    if (!t || !lean || !pitchPivot.current || !pitchInner.current || !rideGroup.current) return;
    const dt = Math.min(rawDelta, 1 / 20);
    const s = state.current;

    // Yaw rate from the heading, unwrapped.
    if (Number.isFinite(s.heading) && dt > 0) {
      let dh = t.heading - s.heading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      s.yawRate = damp(s.yawRate, dh / dt, 0.08, dt);
    }
    s.heading = t.heading;
    const v = t.forwardSpeed;
    if (dt > 0) s.accel = damp(s.accel, (v - s.speed) / dt, 0.12, dt);
    s.speed = v;

    // The lean that balances the corner, faded in from walking pace.
    const balance = Math.atan((v * s.yawRate) / 9.81);
    const fade = Math.min(1, Math.max(0, (Math.abs(v) - 1.5) / 4));
    const target = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, balance * fade));
    s.lean = damp(s.lean, target, 0.11, dt);
    lean.rotation.z = s.lean;

    // Ride on the springs, as the car's wheels do: the drawn bike moves by
    // however far each hub sits from rest, and pitches by the difference,
    // so the tyres stay on the road over a kerb or a crest.
    // The model's axles are where a hub hangs when the spring is as long as
    // the mount is above the axle — the design ride height.
    const mount = VEHICLE.wheels[0].connection[1] - bikeData.frontAxle[1];
    const front = mount - t.wheels.FL.suspensionLength;
    const rear = mount - t.wheels.RL.suspensionLength;
    rideGroup.current.position.y = (front + rear) / 2;
    rideGroup.current.rotation.x = Math.atan2(front - rear, bikeData.wheelbase);

    // Wheelie under power from low speed; the rear lifting under hard braking.
    let pitch = 0;
    if (s.accel > 3 && v < 28) pitch = Math.min(0.14, (s.accel - 3) * 0.035);
    else if (s.accel < -7 && v > 6) pitch = Math.max(-0.05, (s.accel + 7) * 0.01);
    s.pitch = damp(s.pitch, pitch, pitch > s.pitch ? 0.25 : 0.12, dt);
    const pivotZ = s.pitch >= 0 ? REAR_Z : FRONT_Z;
    pitchPivot.current.position.set(0, 0, pivotZ);
    pitchPivot.current.rotation.x = s.pitch;
    pitchInner.current.position.set(0, 0, -pivotZ);

    // Bars, about the raked axis; wheels from the physics.
    const bars = t.wheels.FL.steering * 0.9;
    parts.steer.quaternion.copy(_q.setFromAxisAngle(AXIS, bars));
    parts.wheelRear.rotation.x = t.wheels.RL.rotation;
    parts.wheelFront.rotation.x = t.wheels.FL.rotation;

    s.braking = damp(s.braking, t.braking ? 1 : 0, 0.15, dt);
    if (parts.rig) {
      pose(parts.rig, parts.root, {
        lean: s.lean,
        bars,
        pace: Math.min(1, Math.max(0, t.speedKph / 220)),
        braking: s.braking,
      });
    }
  });

  return (
    <group ref={rideGroup}>
      <group ref={leanGroup} position={[0, CROWN, 0]}>
        <group position={[0, -CROWN, 0]}>
          <group ref={pitchPivot}>
            <group ref={pitchInner}>
              <primitive object={scene} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

useGLTF.preload(MOTORBIKE_MODEL, DRACO_PATH);
