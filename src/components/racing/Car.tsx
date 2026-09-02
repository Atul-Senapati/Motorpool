'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Euler, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { VEHICLE } from '@/config/vehicleConfig';
import { CORNERS, type Corner, type VehicleTelemetry } from '@/types/vehicle';

export const CAR_MODEL_URL = '/models/mclaren.glb';

/**
 * Wheel roll direction.
 *
 * A wheel rolling without slip while the car moves forward (-Z) must have a
 * DECREASING three.js `rotation.x`: for the contact patch to be stationary,
 * omega_x = -v / radius. Rapier's accumulated `wheelRotation` about the -X axle
 * already decreases as the car moves forward, so it maps straight across and no
 * negation is needed. Getting this backwards makes the tyres visibly spin
 * against the direction of travel.
 */
const ROLL_SIGN = 1;

/** Materials that should glow when the brakes are on. */
const BRAKE_LIGHT_MATERIALS = new Set(['brakelight', 'rear_lamp']);

interface CarProps {
  telemetry: RefObject<VehicleTelemetry>;
}

/**
 * Renders the McLaren and drives its wheel transforms from physics telemetry.
 *
 * The processed GLB (see `scripts/prepare-model.mjs`) provides real pivot nodes:
 *   Wheel_*    rolls about its axle AND steers
 *   Upright_*  steers only — brake calipers and suspension links must not spin
 * Both follow the suspension vertically.
 */
export function Car({ telemetry }: CarProps) {
  const { scene } = useGLTF(CAR_MODEL_URL);

  // Resolve the named pivot nodes once. Missing nodes are a preprocessing bug,
  // so fail loudly rather than silently rendering a car with static wheels.
  const nodes = useMemo(() => {
    const wheels = {} as Record<Corner, Object3D>;
    const uprights = {} as Record<Corner, Object3D>;
    for (const corner of CORNERS) {
      const wheel = scene.getObjectByName(`Wheel_${corner}`);
      const upright = scene.getObjectByName(`Upright_${corner}`);
      if (!wheel || !upright) {
        throw new Error(
          `Car model is missing Wheel_${corner}/Upright_${corner}. Run \`npm run prepare:model\`.`,
        );
      }
      wheel.rotation.order = 'YXZ'; // roll about X first, then steer about Y
      wheels[corner] = wheel;
      uprights[corner] = upright;
    }
    return { wheels, uprights };
  }, [scene]);

  /** Materials tagged as brake lights, collected once so useFrame allocates nothing. */
  const brakeLights = useRef<MeshStandardMaterial[]>([]);

  useEffect(() => {
    const found: MeshStandardMaterial[] = [];
    scene.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const material = child.material as MeshStandardMaterial;
      if (!material) return;
      // The Sketchfab export is authored for a dim viewer; lift reflections so
      // the paint and chrome read properly under the HDRI.
      material.envMapIntensity = 1.5;
      if (BRAKE_LIGHT_MATERIALS.has(material.name)) {
        material.toneMapped = false;
        found.push(material);
      }
    });
    brakeLights.current = found;
  }, [scene]);

  const wheelEuler = useMemo(() => new Euler(0, 0, 0, 'YXZ'), []);

  useFrame((_, delta) => {
    const t = telemetry.current;
    if (!t) return;

    for (let i = 0; i < VEHICLE.wheels.length; i++) {
      const config = VEHICLE.wheels[i];
      const state = t.wheels[config.corner];
      const wheel = nodes.wheels[config.corner];
      const upright = nodes.uprights[config.corner];

      // Suspension: the wheel hangs below its hard point by the spring length,
      // so this single value gives visually correct travel over curbs and dips.
      const y = config.connection[1] - state.suspensionLength;
      wheel.position.y = y;
      upright.position.y = y;

      wheelEuler.set(state.rotation * ROLL_SIGN, state.steering, 0);
      wheel.rotation.copy(wheelEuler);
      // Uprights steer but never roll.
      upright.rotation.y = state.steering;
    }

    // Brake lights: ramp rather than snap, so they read as filaments not LEDs.
    const target = t.braking ? 4.5 : t.forwardSpeed !== 0 ? 0.35 : 0.35;
    for (const material of brakeLights.current) {
      const current = material.emissiveIntensity ?? 0;
      material.emissiveIntensity = current + (target - current) * Math.min(1, delta * 14);
    }
  });

  return (
    <>
      <primitive object={scene} />
      {/*
        Cabin fill. The McLaren's roof and buttresses self-shadow the interior
        almost black, which is physically reasonable but leaves the cockpit
        camera unusable. A short-range light parented to the car lifts the
        dashboard without washing out the exterior paint.
      */}
      <pointLight
        position={[0, 0.85, -0.45]}
        intensity={1.6}
        distance={1.9}
        decay={2}
        color="#ffeedd"
      />
    </>
  );
}

useGLTF.preload(CAR_MODEL_URL);
