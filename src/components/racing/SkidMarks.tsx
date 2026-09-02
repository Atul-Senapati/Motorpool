'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute, BufferGeometry, NormalBlending, Quaternion, ShaderMaterial, Vector3,
  type Group, type Mesh,
} from 'three';
import { VEHICLE } from '@/config/vehicleConfig';
import { gripAt } from '@/physics/surfaceGrip';
import { CORNERS, type VehicleTelemetry } from '@/types/vehicle';

/** Quads per wheel trail. Ring buffer — the oldest quad is overwritten. */
const MAX_QUADS_PER_WHEEL = 150;
const QUADS = MAX_QUADS_PER_WHEEL * CORNERS.length;
/** Seconds a mark takes to fade out. */
const LIFETIME = 9;
/** Slip above which a tyre starts marking. */
const SLIP_THRESHOLD = 0.16;
/** Minimum travel before laying another quad, in metres. */
const MIN_STEP = 0.35;

/**
 * Tyre skid marks.
 *
 * One geometry, one draw call, zero allocations per frame. Vertices live in a
 * ring buffer; each vertex carries a birth timestamp and the fade is computed
 * on the GPU from a time uniform, so old marks cost nothing on the CPU.
 */
export function SkidMarks({
  chassisRef,
  telemetry,
}: {
  chassisRef: RefObject<Group | null>;
  telemetry: RefObject<VehicleTelemetry>;
}) {
  const meshRef = useRef<Mesh>(null);

  const { geometry, material, positions, births } = useMemo(() => {
    const positions = new Float32Array(QUADS * 4 * 3);
    const births = new Float32Array(QUADS * 4);
    const indices = new Uint32Array(QUADS * 6);
    for (let q = 0; q < QUADS; q++) {
      const v = q * 4;
      indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    // Marks start fully faded so nothing shows until a tyre actually slips.
    births.fill(-LIFETIME * 2);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aBirth', new BufferAttribute(births, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));
    // Fixed, generous bounding sphere: the marks are scattered across the whole
    // circuit and recomputing bounds every frame would be wasteful.
    geometry.boundingSphere = null;
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.radius = 600;

    const material = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLife: { value: LIFETIME } },
      vertexShader: `
        attribute float aBirth;
        uniform float uTime;
        uniform float uLife;
        varying float vAlpha;
        void main() {
          vAlpha = clamp(1.0 - (uTime - aBirth) / uLife, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(0.02, 0.02, 0.025, vAlpha * 0.55);
        }
      `,
      transparent: true,
      depthWrite: false,
      // Normal blending, not additive: additive black is a no-op, so an
      // additive skid mark would be completely invisible.
      blending: NormalBlending,
    });
    return { geometry, material, positions, births };
  }, []);

  /** Per-wheel ring cursor and last-laid position. */
  const state = useMemo(
    () =>
      CORNERS.map(() => ({
        cursor: 0,
        last: new Vector3(),
        hasLast: false,
      })),
    [],
  );

  const scratch = useMemo(
    () => ({
      chassisPos: new Vector3(),
      quat: new Quaternion(),
      wheel: new Vector3(),
      forward: new Vector3(),
      side: new Vector3(),
      elapsed: 0,
    }),
    [],
  );

  useFrame((_, delta) => {
    const chassis = chassisRef.current;
    const t = telemetry.current;
    const mesh = meshRef.current;
    if (!chassis || !t || !mesh) return;

    scratch.elapsed += delta;
    material.uniforms.uTime.value = scratch.elapsed;

    chassis.getWorldPosition(scratch.chassisPos);
    chassis.getWorldQuaternion(scratch.quat);

    const positionAttr = geometry.getAttribute('position') as BufferAttribute;
    const birthAttr = geometry.getAttribute('aBirth') as BufferAttribute;
    let dirty = false;

    for (let i = 0; i < CORNERS.length; i++) {
      const corner = CORNERS[i];
      const wheelState = t.wheels[corner];
      const config = VEHICLE.wheels[i];
      const s = state[i];

      const slipping =
        wheelState.inContact &&
        (wheelState.sideSlip > SLIP_THRESHOLD || (t.handbrake && !config.steered)) &&
        t.speedKph > 8;

      if (!slipping) {
        s.hasLast = false;
        continue;
      }

      // Contact patch, derived from the chassis transform (no physics queries).
      scratch.wheel
        .set(config.connection[0], config.connection[1], config.connection[2])
        .applyQuaternion(scratch.quat)
        .add(scratch.chassisPos);
      scratch.wheel.y = 0.014;

      // Don't mark the grass.
      if (gripAt(scratch.wheel.x, scratch.wheel.z) < 1) {
        s.hasLast = false;
        continue;
      }

      if (!s.hasLast) {
        s.last.copy(scratch.wheel);
        s.hasLast = true;
        continue;
      }

      scratch.forward.subVectors(scratch.wheel, s.last);
      const travelled = scratch.forward.length();
      if (travelled < MIN_STEP) continue;

      // Lay a quad spanning the tyre width, perpendicular to the travel.
      scratch.forward.divideScalar(travelled);
      scratch.side.set(-scratch.forward.z, 0, scratch.forward.x).multiplyScalar(config.radius * 0.42);

      const quadIndex = i * MAX_QUADS_PER_WHEEL + s.cursor;
      const base = quadIndex * 4;
      const write = (offset: number, from: Vector3, sign: number) => {
        positions[(base + offset) * 3] = from.x + scratch.side.x * sign;
        positions[(base + offset) * 3 + 1] = from.y;
        positions[(base + offset) * 3 + 2] = from.z + scratch.side.z * sign;
        births[base + offset] = scratch.elapsed;
      };
      write(0, s.last, -1);
      write(1, s.last, 1);
      write(2, scratch.wheel, -1);
      write(3, scratch.wheel, 1);

      s.cursor = (s.cursor + 1) % MAX_QUADS_PER_WHEEL;
      s.last.copy(scratch.wheel);
      dirty = true;
    }

    if (dirty) {
      positionAttr.needsUpdate = true;
      birthAttr.needsUpdate = true;
    }
  });

  return <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}
