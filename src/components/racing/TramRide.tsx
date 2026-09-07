'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { Euler, Object3D, Quaternion, Vector3, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  RAIL, RAIL_LENGTH, TRAM, railPointAt, railTangentAt, railWrap,
} from '@/config/railConfig';
import { PHYSICS_TIMESTEP, VEHICLE } from '@/config/vehicleConfig';
import { groundHeightAt } from '@/physics/cityNav';
import { forgetTramArc, gapAhead, gapBehind, reportTramArc } from '@/physics/tramTraffic';
import type { useKeyboardControls } from '@/hooks/useKeyboardControls';
import type { VehicleTelemetry } from '@/types/vehicle';

useGLTF.preload(TRAM.model, DRACO_PATH);

/** Line speed, m/s, from the garage entry's stated ceiling. */
const TOP_SPEED = VEHICLE.engine.maxSpeedKph / 3.6;
/** Shunting backwards is deliberately slow — you cannot see where you are going. */
const REVERSE_SPEED = 4;

/**
 * Tram acceleration, m/s^2.
 *
 * A C-class pulls away at a little over 1 m/s² and brakes at about 1.8 on the
 * service brake. Those are the real figures and they are the point of driving
 * one: it takes 18 seconds to reach line speed and 150 m to stop, so you plan
 * ahead or you sail through the junction.
 */
const ACCEL = 1.15;
const BRAKE = 1.8;
/** Coasting drag with neither pedal, m/s^2. */
const COAST = 0.32;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The player's entry in the shared tram registry. */
const ID = 'player';

/**
 * The player's tram.
 *
 * This is the whole reason the tram is not in the garage as just another car:
 * it replaces `CarPhysics` rather than configuring it. A tram has no steering
 * and no suspension worth simulating, it is 24.1 m long over three articulated
 * sections, and it would not fit down most of the streets in this city. What it
 * does have is a route, and `railConfig` already parametrises that route by
 * arc length — so driving one is a single scalar, `travelled`, pushed along by
 * a throttle and a brake. The rails do the steering.
 *
 * Physics is the same arrangement the scripted trams use: kinematic
 * bodies, one per section, so the tram collides with cars without being shoved
 * off its own track. The consequence is that the player's tram is immovable —
 * which is correct, and is what makes meeting one in a car frightening.
 */
export function TramRide({
  input,
  telemetry,
  chassisRef,
}: {
  input: ReturnType<typeof useKeyboardControls>;
  telemetry: RefObject<VehicleTelemetry>;
  chassisRef: RefObject<Group | null>;
}) {
  const { scene } = useGLTF(TRAM.model, DRACO_PATH);
  const bodyRefs = useRef<(RapierRigidBody | null)[]>([]);
  const groupRefs = useRef<(Object3D | null)[]>([]);

  /**
   * Start half a service interval behind the first scripted tram.
   *
   * They sit at multiples of RAIL_LENGTH / count, and phase 0 is one of them —
   * so starting there would put the player inside a tram on the first frame.
   */
  const startArc = useMemo(() => RAIL_LENGTH / (TRAM.count * 2), []);
  const travelled = useRef(startArc);
  const speed = useRef(0);

  const scratch = useMemo(() => ({
    look: new Vector3(), quaternion: new Quaternion(), euler: new Euler(),
  }), []);

  // Cloned so the cached GLTF scene is never re-parented out from under drei;
  // clones share geometry and materials, so this is cheap. Same reasoning as
  // the scripted trams in RailLoop.
  const sections = useMemo(() => {
    const copy = scene.clone(true);
    return TRAM.sections
      .map(({ name, offset }) => ({ offset, object: copy.getObjectByName(name) }))
      .filter((s): s is { offset: number; object: Object3D } => Boolean(s.object));
  }, [scene]);

  /** The leading cab: the section furthest along the direction of travel. */
  const cabOffset = useMemo(
    () => TRAM.sections.reduce((max, s) => Math.max(max, s.offset), -Infinity),
    [],
  );

  // Withdrawn from the registry on unmount, so a hot reload does not leave a
  // ghost tram for the service to queue behind for ever.
  useEffect(() => () => forgetTramArc(ID), []);

  useEffect(() => {
    for (const { object } of sections) {
      object.traverse((child) => {
        child.castShadow = true;
        child.receiveShadow = true;
      });
    }
  }, [sections]);

  const heightAt = (x: number, z: number, lift: number) => (groundHeightAt(x, z) ?? 0) + lift;

  // Integration and every Rapier write happen in the before-step callback, not
  // in useFrame: touching a body from the render loop races the physics step's
  // borrow of the World and throws the "recursive use of an object" abort. Same
  // rule as CarPhysics, Traffic and RailLoop.
  useBeforePhysicsStep(() => {
    const cmd = input.current;
    const dt = PHYSICS_TIMESTEP;
    if (!cmd) return;

    if (cmd.resetRequested) {
      cmd.resetRequested = false;
      travelled.current = startArc;
      speed.current = 0;
    }
    // Righting a tram is meaningless; swallow the key so it does not queue up.
    cmd.flipRequested = false;

    const v = speed.current;
    let accel: number;
    if (cmd.brake > 0) {
      // Brake to a stop, then shunt backwards — the car's convention.
      if (v > 0.2) accel = -BRAKE * cmd.brake;
      else accel = v > -REVERSE_SPEED ? -ACCEL * cmd.brake : 0;
    } else if (cmd.throttle > 0) {
      // Throttle out of a reverse shunt brakes first.
      accel = v < -0.2 ? BRAKE * cmd.throttle : ACCEL * cmd.throttle;
    } else {
      accel = -Math.sign(v) * COAST;
    }

    let next = v + accel * dt;
    // Coasting must settle at a standstill rather than buzzing around zero.
    if (cmd.brake === 0 && cmd.throttle === 0 && Math.abs(next) < COAST * dt * 1.5) next = 0;
    next = clamp(next, -REVERSE_SPEED, TOP_SPEED);

    // Do not drive through a service tram. Both are kinematic, so Rapier will
    // not stop us — this is the only thing that does. The service trams run the
    // same check against us, so the queue works from either end.
    const here = travelled.current;
    const room = (gap: number) =>
      Math.max(0, Math.min(1, (gap - RAIL.minTramGap) / RAIL.tramFollowZone));
    if (next > 0) next = Math.min(next, room(gapAhead(ID, here)) * TOP_SPEED);
    if (next < 0) next = Math.max(next, -room(gapBehind(ID, here)) * REVERSE_SPEED);

    speed.current = next;
    travelled.current = railWrap(here + next * dt);
    reportTramArc(ID, travelled.current);

    TRAM.sections.forEach(({ offset }, i) => {
      const body = bodyRefs.current[i];
      if (!body) return;
      const arc = railWrap(travelled.current + offset);
      const [x, z] = railPointAt(arc);
      const [tx, tz] = railTangentAt(arc);
      // The models face -Z, so a direction (tx, tz) is heading atan2(-tx, -tz).
      scratch.euler.set(0, Math.atan2(-tx, -tz), 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      body.setNextKinematicTranslation({ x, y: heightAt(x, z, TRAM.size[1] / 2), z });
      body.setNextKinematicRotation(scratch.quaternion);
    });
  });

  // Visuals, telemetry and the camera anchor all track the same arc length.
  useFrame(() => {
    sections.forEach(({ offset }, i) => {
      const group = groupRefs.current[i];
      if (!group) return;
      const arc = railWrap(travelled.current + offset);
      const [x, z] = railPointAt(arc);
      const [tx, tz] = railTangentAt(arc);
      const y = heightAt(x, z, 0);
      group.position.set(x, y, z);
      scratch.look.set(x + tx, y, z + tz);
      group.lookAt(scratch.look);
    });

    // Everything downstream — camera, minimap, compass, HUD — is anchored to
    // the leading cab, which is where a driver sits and what the map arrow
    // should point at. An empty group: the tram's own visuals are the carriers
    // above, so this only carries a transform.
    const cabArc = railWrap(travelled.current + cabOffset);
    const [cx, cz] = railPointAt(cabArc);
    const [ctx, ctz] = railTangentAt(cabArc);
    const cy = heightAt(cx, cz, 0);
    const heading = Math.atan2(-ctx, -ctz);

    const anchor = chassisRef.current;
    if (anchor) {
      anchor.position.set(cx, cy, cz);
      scratch.euler.set(0, heading, 0);
      anchor.quaternion.setFromEuler(scratch.euler);
    }

    const t = telemetry.current;
    if (t) {
      const v = speed.current;
      t.forwardSpeed = v;
      t.speedKph = Math.abs(v) * 3.6;
      t.braking = (input.current?.brake ?? 0) > 0 && v > 0.2;
      t.reversing = v < -0.4;
      t.handbrake = false;
      // A tram has no engine and no gears. The HUD's dial is fed a traction
      // reading instead, so it still says something true about the vehicle
      // rather than sitting dead at idle.
      const load = Math.min(Math.abs(v) / TOP_SPEED, 1);
      t.rpm = VEHICLE.engine.idleRpm
        + (VEHICLE.engine.maxRpm - VEHICLE.engine.idleRpm) * load;
      t.gear = 1;
      t.slip = 0;
      t.x = cx;
      t.y = cy;
      t.z = cz;
      t.heading = heading;
    }
  });

  return (
    <>
      {/* Camera/minimap anchor. Kept outside the section carriers so it is not
          dragged around by the normalising transform each section carries. */}
      <group ref={chassisRef} />

      {/* Each section gets a carrier group, and it is the carrier that is
          placed on the rail. The section node itself holds the normalising
          transform prepare-tram.mjs baked in — the turn onto -Z, the scale to
          metres, and its own offset along the tram — so writing position and
          quaternion onto it directly would wipe all three. */}
      {sections.map(({ object }, i) => (
        <group key={i} ref={(instance) => { groupRefs.current[i] = instance; }}>
          <primitive object={object} />
        </group>
      ))}

      {/* Kinematic collider per section, declarative for the same reason
          Traffic's are: creating bodies imperatively from an effect calls into
          Rapier while the World is already borrowed and aborts the step. */}
      {TRAM.sections.map((_, i) => (
        <RigidBody
          key={i}
          ref={(instance) => { bodyRefs.current[i] = instance; }}
          type="kinematicPosition"
          colliders="cuboid"
          position={[0, -500, 0]}
        >
          <mesh visible={false}>
            <boxGeometry args={[TRAM.size[0], TRAM.size[1], TRAM.sectionCollider]} />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
}
