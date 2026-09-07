'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute, BufferGeometry, NormalBlending, Quaternion, ShaderMaterial, Vector3,
  type Group, type Mesh,
} from 'three';
import { VEHICLE } from '@/config/vehicleConfig';
import { marksAt, surfaceHeightAt } from '@/physics/surfaceGrip';
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
 * Lift above the sampled ground, in metres.
 *
 * Generous enough to clear the nav raster's own quantisation on a slope — it
 * stores height per 1.5 m pixel, so the true surface can sit a few centimetres
 * either side of the sample.
 */
const GROUND_LIFT = 0.05;

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

  const { geometry, material, positions, births, strengths } = useMemo(() => {
    const positions = new Float32Array(QUADS * 4 * 3);
    const births = new Float32Array(QUADS * 4);
    const strengths = new Float32Array(QUADS * 4);
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
    geometry.setAttribute('aStrength', new BufferAttribute(strengths, 1));
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
        attribute float aStrength;
        uniform float uTime;
        uniform float uLife;
        varying float vAlpha;
        void main() {
          float fade = clamp(1.0 - (uTime - aBirth) / uLife, 0.0, 1.0);
          // A tyre that is barely slipping leaves a faint smear; one that is
          // locked or spinning leaves black. Constant opacity read as painted-on.
          vAlpha = fade * aStrength;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(0.02, 0.02, 0.025, vAlpha * 0.62);
        }
      `,
      transparent: true,
      depthWrite: false,
      // Marks are decals on a surface whose height is only known to the nav
      // raster's 1.5 m resolution, so on a slope the sampled ground can sit a
      // few centimetres either side of the real road. A fixed lift cannot win
      // that race — a depth bias can, and is what decals normally use.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      // Normal blending, not additive: additive black is a no-op, so an
      // additive skid mark would be completely invisible.
      blending: NormalBlending,
    });
    return { geometry, material, positions, births, strengths };
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

  useFrame((_, rawDelta) => {
    const chassis = chassisRef.current;
    const t = telemetry.current;
    const mesh = meshRef.current;
    if (!chassis || !t || !mesh) return;

    // Clamp before accumulating. A tab regaining focus hands over a multi-second
    // delta, and since the fade is `now - birth` against this same clock, one
    // such frame would age every mark on the map out of existence at once.
    scratch.elapsed += Math.min(rawDelta, 1 / 20);
    material.uniforms.uTime.value = scratch.elapsed;

    chassis.getWorldPosition(scratch.chassisPos);
    chassis.getWorldQuaternion(scratch.quat);

    const positionAttr = geometry.getAttribute('position') as BufferAttribute;
    const birthAttr = geometry.getAttribute('aBirth') as BufferAttribute;
    const strengthAttr = geometry.getAttribute('aStrength') as BufferAttribute;
    let dirty = false;

    for (let i = 0; i < CORNERS.length; i++) {
      const corner = CORNERS[i];
      const wheelState = t.wheels[corner];
      const config = VEHICLE.wheels[i];
      const s = state[i];

      // How hard this tyre is working, 0..1. Three things leave rubber and the
      // component used to draw only the first: sliding sideways, spinning up
      // under power, and locking under the brakes.
      const lateral = Math.max(0, wheelState.sideSlip - SLIP_THRESHOLD) / (1 - SLIP_THRESHOLD);
      const locked = t.handbrake && !config.steered ? 1 : 0;
      const intensity = Math.min(1, Math.max(lateral, wheelState.longSlip, locked));

      if (!wheelState.inContact || intensity <= 0.02 || t.speedKph < 4) {
        s.hasLast = false;
        continue;
      }

      // Contact patch, derived from the chassis transform (no physics queries).
      scratch.wheel
        .set(config.connection[0], config.connection[1], config.connection[2])
        .applyQuaternion(scratch.quat)
        .add(scratch.chassisPos);

      // Rubber only shows on tarmac, and only at the height the tarmac actually
      // is. Pinning marks to y = 0 is what made them invisible across the city.
      if (!marksAt(scratch.wheel.x, scratch.wheel.z)) {
        s.hasLast = false;
        continue;
      }
      const ground = surfaceHeightAt(scratch.wheel.x, scratch.wheel.z);
      if (ground === null) {
        s.hasLast = false;
        continue;
      }
      scratch.wheel.y = ground + GROUND_LIFT;

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
        strengths[base + offset] = intensity;
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
      strengthAttr.needsUpdate = true;
    }
  });

  return <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}
