'use client';

import { useEffect, useRef, type RefObject } from 'react';
import {
  RigidBody, CuboidCollider, useRapier, useBeforePhysicsStep,
  type RapierRigidBody,
} from '@react-three/rapier';
import type { Group } from 'three';
import { PHYSICS_TIMESTEP, VEHICLE } from '@/config/vehicleConfig';
import { WORLD_ID } from '@/config/world';
import { nearestRoad } from '@/physics/cityNav';
import { takeTeleport } from '@/physics/portals';
import { applyTrainHit, isTrainBody, TRAIN_IMPACT } from '@/physics/trainImpact';
import { Vehicle } from '@/physics/vehiclePhysics';
import type { VehicleTelemetry } from '@/types/vehicle';
import type { RawInput } from '@/hooks/useKeyboardControls';
import { Car } from './Car';
import { Motorbike } from './Motorbike';
import { SELECTED } from '@/config/garage';

interface CarPhysicsProps {
  input: RefObject<RawInput>;
  telemetry: RefObject<VehicleTelemetry>;
  /** Filled with the chassis group so the cameras have something to follow. */
  chassisRef: RefObject<Group | null>;
  /**
   * Filled with the chassis body. Traffic needs it to tell the player's car
   * apart from the city and from other traffic when a collision comes in —
   * comparing handles is unambiguous where matching on names or body type is
   * guesswork.
   */
  playerBodyRef?: RefObject<RapierRigidBody | null>;
}

/**
 * Owns the chassis rigid body and the Rapier vehicle controller.
 *
 * The controller is stepped in `useBeforePhysicsStep` so its impulses land in
 * the same substep as the rest of the world — running it from `useFrame` would
 * desync it from the fixed physics timestep.
 */
export function CarPhysics({ input, telemetry, chassisRef, playerBodyRef }: CarPhysicsProps) {
  const { world } = useRapier();
  const bodyRef = useRef<RapierRigidBody>(null);
  const vehicle = useRef<Vehicle | null>(null);
  /** A train that touched the chassis this step, waiting for the before-step — see `trainImpact`. */
  const trainHit = useRef<RapierRigidBody | null>(null);
  /** Seconds left before another train contact can kick the car again. */
  const hitCooldown = useRef(0);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (playerBodyRef) playerBodyRef.current = body;
    const instance = new Vehicle(world, body);
    vehicle.current = instance;
    return () => {
      instance.dispose(world);
      vehicle.current = null;
      if (playerBodyRef) playerBodyRef.current = null;
    };
  }, [world, playerBodyRef]);

  useBeforePhysicsStep(() => {
    const v = vehicle.current;
    const i = input.current;
    const t = telemetry.current;
    if (!v || !i || !t) return;

    if (i.resetRequested) {
      i.resetRequested = false;
      // In the city, drop back onto the nearest street rather than teleporting
      // across the map to a fixed grid slot — after a crash you want to carry on
      // from where you were. The road and its height come from the precomputed
      // nav raster; Rapier cannot be raycast from inside a before-step callback
      // (see physics/cityNav.ts). Falls back to the spawn when the raster has
      // not loaded yet or nothing is within range.
      const fix = WORLD_ID === 'city' ? nearestRoad(t.x, t.z, t.heading) : null;
      if (fix) v.reset(fix.position, fix.heading);
      else v.reset(VEHICLE.spawn.position, VEHICLE.spawn.heading);
    }

    if (i.flipRequested) {
      i.flipRequested = false;
      v.flipUpright();
    }

    // A portal the driver stepped through — see `physics/portals`. Same
    // relocation as the reset, to a pose the marker chose.
    const portal = takeTeleport();
    if (portal) v.reset(portal.position, portal.heading);

    // Hit by a train: hard, at any speed. Applied here, not in the collision
    // callback, for the same reason every other body write is.
    hitCooldown.current = Math.max(0, hitCooldown.current - PHYSICS_TIMESTEP);
    const train = trainHit.current;
    trainHit.current = null;
    const body = bodyRef.current;
    if (train && body && hitCooldown.current === 0) {
      applyTrainHit(body, train);
      hitCooldown.current = TRAIN_IMPACT.cooldown;
    }

    // A stoppie is the front brake on hard: E brakes the bike while it is
    // still rolling forward (only then — at a stand, braking is reversing).
    const stoppie = SELECTED.bike && i.stunts.stoppie && t.forwardSpeed > 2;
    i.steer = v.update(
      {
        throttle: stoppie ? 0 : i.throttle, brake: stoppie ? Math.max(i.brake, 0.75) : i.brake, steerAxis: i.steerAxis,
        handbrake: i.handbrake, boost: i.boost,
      },
      PHYSICS_TIMESTEP,
      t,
    );
  });

  const [hx, hy, hz] = VEHICLE.chassis.halfExtents;
  const [cx, cy, cz] = VEHICLE.chassis.center;
  /*
   * A bike's weight sits at road level. Its four wheels are a narrow pair
   * each side of the centreline, and with the mass up where a rider's is,
   * cornering force at the tyres would roll the body straight over them. At
   * road height the tyres' sideways pull has no lever to roll it with, so
   * the physics body stays upright and `Motorbike` draws the lean instead.
   * The roll inertia is raised for the same reason: kerbs and bumps nudge
   * it, they do not throw it.
   */
  const m = VEHICLE.mass;
  const bikeMass = SELECTED.bike ? {
    mass: m,
    centerOfMass: { x: -cx, y: 0.05 - cy, z: -cz },
    principalAngularInertia: {
      x: (m * ((hy * 2) ** 2 + (hz * 2) ** 2)) / 12,
      y: (m * ((hx * 2) ** 2 + (hz * 2) ** 2)) / 12,
      z: (m * ((hx * 2) ** 2 + (hy * 2) ** 2)) / 4,
    },
    angularInertiaLocalFrame: { x: 0, y: 0, z: 0, w: 1 },
  } : undefined;

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders={false}
      position={[...VEHICLE.spawn.position]}
      // Without this the car spawns on the grid facing across the circuit.
      rotation={[0, VEHICLE.spawn.heading, 0]}
      linearDamping={VEHICLE.aero.linearDamping}
      angularDamping={VEHICLE.aero.angularDamping}
      // The raycast vehicle relies on the chassis staying awake to keep its
      // suspension rays live; sleeping would freeze the car mid-corner.
      canSleep={false}
      // Continuous collision: at 250 km/h the car moves 1.2 m a step, more than
      // a parapet is thick — without this it can pass clean through a bridge
      // wall between one step and the next. One body, so it costs next to nothing.
      ccd
    >
      <group ref={chassisRef}>
        {/* Mass belongs on the COLLIDER, not the RigidBody: with `colliders={false}`
            a `mass` prop on RigidBody is ignored and the chassis ends up with
            whatever its collider's default density implies — 6.6 kg here. */}
        <CuboidCollider
          args={[hx, hy, hz]}
          position={[cx, cy, cz]}
          {...(bikeMass ? { massProperties: bikeMass } : { mass: VEHICLE.mass })}
          friction={0.4}
          restitution={0.05}
          // On the collider, not the RigidBody: that is what switches its
          // collision events on. Only remembers the train — see the before-step.
          onCollisionEnter={({ other }) => {
            if (isTrainBody(other.rigidBody)) trainHit.current = other.rigidBody ?? null;
          }}
        />
        {SELECTED.bike ? <Motorbike telemetry={telemetry} input={input} /> : <Car telemetry={telemetry} />}
      </group>
    </RigidBody>
  );
}
