'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  Euler, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D,
} from 'three';
import { BRAKE_COLOUR, brakeLampMaterial, rampBrake, rearLampGeometry } from './brakeLamps';
import { VEHICLE } from '@/config/vehicleConfig';
import { SELECTED } from '@/config/garage';
import { CORNERS, type Corner, type VehicleTelemetry } from '@/types/vehicle';

export const CAR_MODEL_URL = SELECTED.model;

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
 * Renders the selected car and drives its wheel transforms from physics
 * telemetry.
 *
 * A processed GLB provides real pivot nodes:
 *   Wheel_*    rolls about its axle AND steers
 *   Upright_*  steers only — brake calipers and suspension links must not spin
 * Both follow the suspension vertically.
 *
 * Not every car in the garage has them. Where an export merged its wheels into
 * the body they cannot be separated (see `prepare-garage.mjs`), and that car
 * renders as one shell with static wheels — it still drives correctly, because
 * Rapier's raycast vehicle works off the measured pivots and radii, not the
 * mesh. `SELECTED.hasWheelPivots` says which kind of car this is.
 */
export function Car({ telemetry }: CarProps) {
  const { scene } = useGLTF(CAR_MODEL_URL);

  // Resolve the named pivot nodes once. Missing nodes are a preprocessing bug,
  // so fail loudly rather than silently rendering a car with static wheels.
  const nodes = useMemo(() => {
    if (!SELECTED.hasWheelPivots) return null;
    const wheels = {} as Record<Corner, Object3D>;
    const uprights = {} as Record<Corner, Object3D>;
    for (const corner of CORNERS) {
      const wheel = scene.getObjectByName(`Wheel_${corner}`);
      const upright = scene.getObjectByName(`Upright_${corner}`);
      if (!wheel || !upright) {
        // The data claimed pivots and the mesh has none, which means the model
        // and `garageData.json` have drifted apart — worth shouting about,
        // but not worth refusing to render the car over.
        console.error(
          `[car] ${SELECTED.id} is missing Wheel_${corner}/Upright_${corner}. ` +
          'Re-run the prepare script for it.',
        );
        return null;
      }
      wheel.rotation.order = 'YXZ'; // roll about X first, then steer about Y
      wheels[corner] = wheel;
      uprights[corner] = upright;
    }
    return { wheels, uprights };
  }, [scene]);

  /** Materials tagged as brake lights, collected once so useFrame allocates nothing. */
  const brakeLights = useRef<MeshStandardMaterial[]>([]);
  /**
   * Lamp overlays for a car whose model tags nothing — see `brakeLamps`.
   *
   * The named-material path above is right for the McLaren and useless for
   * everything else in the garage: the twenty vehicles out of `vehicles.glb`
   * have four materials each and none of them is called `brakelight`. Their
   * lamps are real geometry all the same, inside the `Optics` lens, so the
   * back half of that lens is doubled with an additive overlay and lit that
   * way. One or the other, never both — a car that HAS tagged lamps is better
   * served by lighting the material it already has.
   */
  const lampOverlays = useRef<MeshBasicMaterial[]>([]);

  useEffect(() => {
    const found: MeshStandardMaterial[] = [];
    const lenses: Mesh[] = [];
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
      if (/optic|lamp|light/i.test(material.name)) lenses.push(child);
    });
    brakeLights.current = found;

    const overlays: MeshBasicMaterial[] = [];
    if (!found.length) {
      for (const lens of lenses) {
        const geometry = rearLampGeometry(lens);
        if (!geometry) continue;
        const material = brakeLampMaterial();
        material.color.copy(BRAKE_COLOUR);
        // Off until the first frame says otherwise. Additive, so this is
        // genuinely invisible rather than a dark patch over the lens.
        material.opacity = 0;
        const overlay = new Mesh(geometry, material);
        overlay.frustumCulled = false;
        lens.add(overlay);
        overlays.push(material);
      }
    }
    lampOverlays.current = overlays;
    return () => {
      for (const material of overlays) material.dispose();
    };
  }, [scene]);

  const wheelEuler = useMemo(() => new Euler(0, 0, 0, 'YXZ'), []);

  useFrame((_, delta) => {
    const t = telemetry.current;
    if (!t) return;

    if (nodes) for (let i = 0; i < VEHICLE.wheels.length; i++) {
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
    // The same ramp for a car whose lamps are geometry rather than a material,
    // carried on the overlay's opacity because that is what an additive layer
    // has instead of an emissive.
    for (const material of lampOverlays.current) {
      material.opacity = rampBrake(material.opacity, t.braking, delta);
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
        position={[0, SELECTED.size[1] * 0.75, -SELECTED.size[2] * 0.1]}
        intensity={1.6}
        distance={Math.max(1.9, SELECTED.size[1] * 1.7)}
        decay={2}
        color="#ffeedd"
      />
    </>
  );
}

useGLTF.preload(CAR_MODEL_URL);
