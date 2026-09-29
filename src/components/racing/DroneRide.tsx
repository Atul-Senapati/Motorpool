'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { DoubleSide, Mesh, MeshBasicMaterial, Object3D, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { DRONE, DRONE_MODEL } from '@/config/droneConfig';
import { propBlurTexture } from './propBlur';
import { useFlight } from './useFlight';
import type { RawInput } from '@/hooks/useKeyboardControls';
import type { VehicleTelemetry } from '@/types/vehicle';

useGLTF.preload(DRONE_MODEL, DRACO_PATH);

/**
 * Flying the drone. The flying itself is `useFlight`; what is here is the
 * quadcopter's own hardware.
 *
 *   W / S      forward and back          ↑ / ↓    climb and descend
 *   A / D      slide left and right      ← / →    turn (yaw)
 *   SHIFT      sport — double the caps   SPACE    brake to a hover
 *   R          back to the launch point
 *
 * The props are welded into the arms in the source model, so there is no
 * geometry to turn; what spins instead is a blur disc over each motor hub,
 * which is what a propeller looks like anyway. See `prepare-drone.mjs`.
 */
export function DroneRide({ input, telemetry, chassisRef }: {
  input: RefObject<RawInput>;
  telemetry: RefObject<VehicleTelemetry>;
  chassisRef: RefObject<Group | null>;
}) {
  const { scene } = useGLTF(DRONE_MODEL, DRACO_PATH);
  const { body, spawn, rotor } = useFlight(input, telemetry, chassisRef);
  const discs = useRef<(Mesh | null)[]>([]);

  const model = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    return copy;
  }, [scene]);

  const blur = useMemo(() => new MeshBasicMaterial({
    map: propBlurTexture(), transparent: true, depthWrite: false, side: DoubleSide,
  }), []);

  useFrame(() => {
    // Diagonal pairs turn opposite ways, as they must on a quad.
    for (let k = 0; k < discs.current.length; k++) {
      const disc = discs.current[k];
      if (disc) disc.rotation.z = (k % 2 === 0 ? 1 : -1) * rotor.current.angle;
    }
  });

  const half = DRONE.size.map((v) => v / 2);

  return (
    <>
      <RigidBody ref={body} type="kinematicPosition" colliders={false} position={spawn.position}>
        <CuboidCollider
          args={[half[0] * 0.8, half[1], half[2] * 0.8]}
          position={[0, half[1], 0]}
          friction={0.3}
          restitution={0.1}
        />
      </RigidBody>

      <group ref={chassisRef}>
        <primitive object={model} />
        {/* Flat over each motor hub: `rotation.x` lays the circle down, the
            spin goes on `rotation.z`. */}
        {DRONE.rotors.map((p, k) => (
          <mesh
            key={k}
            ref={(el) => { discs.current[k] = el; }}
            position={p}
            rotation={[-Math.PI / 2, 0, 0]}
            material={blur}
          >
            <circleGeometry args={[DRONE.rotorRadius, 40]} />
          </mesh>
        ))}
      </group>
    </>
  );
}
