'use client';

import { useMemo, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { DoubleSide, Mesh, MeshBasicMaterial, Object3D, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { HELICOPTER, HELICOPTER_MODEL } from '@/config/helicopterConfig';
import { propBlurTexture } from './propBlur';
import { useFlight } from './useFlight';
import type { RawInput } from '@/hooks/useKeyboardControls';
import type { VehicleTelemetry } from '@/types/vehicle';

useGLTF.preload(HELICOPTER_MODEL, DRACO_PATH);

/**
 * Flying the helicopter. The flying itself is `useFlight`; what is here is the
 * aircraft's own hardware — which, unlike the drone's, is real geometry.
 *
 *   W / S      forward and back          ↑ / ↓    climb and descend
 *   A / D      slide left and right      ← / →    yaw (the pedals)
 *   SHIFT      sport — 259 km/h          SPACE    brake to a hover
 *   R          back to the launch point
 *
 * ## Two rotors, turned two ways at once
 *
 * `prepare-helicopter.mjs` lifts the main and tail rotors out as their own
 * nodes, pivoted on their own hubs, and measures which axis each turns about —
 * the main disc about Y, the tail about X. Those meshes are spun here at a
 * rate that *reads* as fast, which is not the real one: a main rotor turns at
 * 395 rpm and a tail rotor at 3,500, and at sixty frames a second both alias
 * into a slow crawl backwards.
 *
 * What sells the speed instead is a blur disc over each, fading in as the
 * rotor picks up — so at idle you see blades turning and at cruise you see
 * what a camera sees, a disc with ghosts in it. Four ghosts on the main rotor
 * and two on the tail, because that is what an EC135 has.
 */

/** Disc opacity at idle and at full effort. */
const BLUR_IDLE = 0.12;
const BLUR_FULL = 0.8;

export function HelicopterRide({ input, telemetry, chassisRef }: {
  input: RefObject<RawInput>;
  telemetry: RefObject<VehicleTelemetry>;
  chassisRef: RefObject<Group | null>;
}) {
  const { scene } = useGLTF(HELICOPTER_MODEL, DRACO_PATH);
  const { body, spawn, rotor } = useFlight(input, telemetry, chassisRef);

  /**
   * The airframe, with the two rotor nodes found by the names the prepare pass
   * gave them. They stay children of the airframe — they are pivoted on their
   * own hubs, so turning them in place is all that is needed.
   */
  const { model, rotors } = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    return {
      model: copy,
      rotors: HELICOPTER.rotors.map((spec) => ({ spec, node: copy.getObjectByName(spec.id) ?? null })),
    };
  }, [scene]);

  // One material per rotor: the blade count differs, and so does the opacity
  // they settle at, because a tail rotor spends its life at full chat.
  const blur = useMemo(() => ({
    main: new MeshBasicMaterial({
      map: propBlurTexture(4), transparent: true, opacity: BLUR_IDLE, depthWrite: false, side: DoubleSide,
    }),
    tail: new MeshBasicMaterial({
      map: propBlurTexture(2), transparent: true, opacity: BLUR_IDLE, depthWrite: false, side: DoubleSide,
    }),
  }), []);

  useFrame(() => {
    const { angle, effort } = rotor.current;
    for (const { spec, node } of rotors) {
      if (!node) continue;
      // The tail rotor turns far faster than the main one, in the gearing an
      // EC135 has; the sign differs so the two do not look like one machine
      // bolted together twice.
      const turn = spec.id === 'tail' ? angle * 4.6 : angle;
      node.rotation[spec.axis] = spec.id === 'tail' ? -turn : turn;
    }
    const opacity = BLUR_IDLE + (BLUR_FULL - BLUR_IDLE) * effort;
    blur.main.opacity = opacity;
    blur.tail.opacity = opacity;
  });

  const hull = HELICOPTER.hull;

  return (
    <>
      <RigidBody ref={body} type="kinematicPosition" colliders={false} position={spawn.position}>
        <CuboidCollider
          args={[hull.size[0] / 2, hull.size[1] / 2, hull.size[2] / 2]}
          position={hull.centre}
          friction={0.4}
          restitution={0.05}
        />
      </RigidBody>

      <group ref={chassisRef}>
        <primitive object={model} />

        {/* The discs. The main one lies flat (its normal is +Y, so the circle
            is laid down); the tail's normal is +X, so it stands on edge. */}
        {HELICOPTER.rotors.map((spec) => (
          <mesh
            key={spec.id}
            position={spec.hub}
            rotation={spec.axis === 'y' ? [-Math.PI / 2, 0, 0] : [0, Math.PI / 2, 0]}
            material={spec.id === 'tail' ? blur.tail : blur.main}
            renderOrder={2}
          >
            <circleGeometry args={[spec.radius, 48]} />
          </mesh>
        ))}
      </group>
    </>
  );
}
