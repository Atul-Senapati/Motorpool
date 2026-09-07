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
import { Vehicle } from '@/physics/vehiclePhysics';
import type { VehicleTelemetry } from '@/types/vehicle';
import type { RawInput } from '@/hooks/useKeyboardControls';
import { Car } from './Car';

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

    i.steer = v.update(
      { throttle: i.throttle, brake: i.brake, steerAxis: i.steerAxis, handbrake: i.handbrake },
      PHYSICS_TIMESTEP,
      t,
    );
  });

  const [hx, hy, hz] = VEHICLE.chassis.halfExtents;
  const [cx, cy, cz] = VEHICLE.chassis.center;

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
    >
      <group ref={chassisRef}>
        {/* Mass belongs on the COLLIDER, not the RigidBody: with `colliders={false}`
            a `mass` prop on RigidBody is ignored and the chassis ends up with
            whatever its collider's default density implies — 6.6 kg here. */}
        <CuboidCollider
          args={[hx, hy, hz]}
          position={[cx, cy, cz]}
          mass={VEHICLE.mass}
          friction={0.4}
          restitution={0.05}
        />
        <Car telemetry={telemetry} />
      </group>
    </RigidBody>
  );
}
