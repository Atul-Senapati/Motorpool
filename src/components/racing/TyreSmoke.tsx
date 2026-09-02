'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Points,
  Quaternion, ShaderMaterial, Vector3, type Group,
} from 'three';
import { VEHICLE } from '@/config/vehicleConfig';
import { CORNERS, type VehicleTelemetry } from '@/types/vehicle';

const MAX_PARTICLES = 160;
const LIFETIME = 1.1;
const SLIP_THRESHOLD = 0.2;

/** Soft radial puff, drawn once into a small canvas. */
function makePuffTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Very soft and low-contrast: a hard bright core reads as a white dot on the
  // road rather than as smoke.
  gradient.addColorStop(0, 'rgba(255,255,255,0.22)');
  gradient.addColorStop(0.3, 'rgba(245,245,245,0.12)');
  gradient.addColorStop(0.7, 'rgba(235,235,235,0.04)');
  gradient.addColorStop(1, 'rgba(230,230,230,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

/**
 * Tyre smoke when a wheel is sliding.
 *
 * A single fixed-size Points pool: particles are recycled round-robin, so there
 * is no allocation and no draw-call growth however long you drift for. Only the
 * live particles are integrated each frame.
 */
export function TyreSmoke({
  chassisRef,
  telemetry,
}: {
  chassisRef: RefObject<Group | null>;
  telemetry: RefObject<VehicleTelemetry>;
}) {
  const pointsRef = useRef<Points>(null);

  const { geometry, material, positions, sizes, alphas, opacities, ages, velocities } = useMemo(() => {
    const positions = new Float32Array(MAX_PARTICLES * 3);
    const sizes = new Float32Array(MAX_PARTICLES);
    const alphas = new Float32Array(MAX_PARTICLES);
    const opacities = new Float32Array(MAX_PARTICLES);
    const ages = new Float32Array(MAX_PARTICLES).fill(LIFETIME * 2);
    const velocities = new Float32Array(MAX_PARTICLES * 3);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('size', new BufferAttribute(sizes, 1));
    geometry.setAttribute('alpha', new BufferAttribute(alphas, 1));
    geometry.boundingSphere = null;

    // A ShaderMaterial rather than PointsMaterial: PointsMaterial has a single
    // uniform size and ignores a per-particle `size` attribute, so expired
    // puffs would keep rendering at full size.
    const material = new ShaderMaterial({
      uniforms: { uMap: { value: makePuffTexture() } },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 320.0 / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.002) discard;
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(tex.rgb, tex.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return { geometry, material, positions, sizes, alphas, opacities, ages, velocities };
  }, []);

  const scratch = useMemo(
    () => ({ chassisPos: new Vector3(), quat: new Quaternion(), wheel: new Vector3(), cursor: 0, seed: 1 }),
    [],
  );

  useFrame((_, rawDelta) => {
    const chassis = chassisRef.current;
    const t = telemetry.current;
    if (!chassis || !t) return;
    const delta = Math.min(rawDelta, 1 / 20);

    // Cheap deterministic jitter; Math.random would be fine but this keeps the
    // effect reproducible between runs.
    const random = () => {
      scratch.seed = (scratch.seed * 16807) % 2147483647;
      return scratch.seed / 2147483647;
    };

    chassis.getWorldPosition(scratch.chassisPos);
    chassis.getWorldQuaternion(scratch.quat);

    // Spawn.
    for (let i = 0; i < CORNERS.length; i++) {
      const wheelState = t.wheels[CORNERS[i]];
      const config = VEHICLE.wheels[i];
      const sliding =
        wheelState.inContact &&
        t.speedKph > 15 &&
        (wheelState.sideSlip > SLIP_THRESHOLD || (t.handbrake && !config.steered));
      if (!sliding) continue;

      scratch.wheel
        .set(config.connection[0], config.connection[1], config.connection[2])
        .applyQuaternion(scratch.quat)
        .add(scratch.chassisPos);

      const p = scratch.cursor;
      scratch.cursor = (scratch.cursor + 1) % MAX_PARTICLES;
      positions[p * 3] = scratch.wheel.x + (random() - 0.5) * 0.3;
      positions[p * 3 + 1] = 0.18 + random() * 0.16;
      positions[p * 3 + 2] = scratch.wheel.z + (random() - 0.5) * 0.3;
      velocities[p * 3] = (random() - 0.5) * 1.2;
      velocities[p * 3 + 1] = 0.9 + random() * 1.1;
      velocities[p * 3 + 2] = (random() - 0.5) * 1.2;
      ages[p] = 0;
      opacities[p] = Math.min(0.8, wheelState.sideSlip * 1.1);
    }

    // Integrate.
    for (let p = 0; p < MAX_PARTICLES; p++) {
      if (ages[p] >= LIFETIME) {
        sizes[p] = 0;
        alphas[p] = 0;
        continue;
      }
      ages[p] += delta;
      positions[p * 3] += velocities[p * 3] * delta;
      positions[p * 3 + 1] += velocities[p * 3 + 1] * delta;
      positions[p * 3 + 2] += velocities[p * 3 + 2] * delta;
      // Slow the rise so puffs billow rather than shoot upward.
      velocities[p * 3 + 1] *= 1 - delta * 1.4;
      const life = ages[p] / LIFETIME;
      // Puffs grow as they age and fade out over the back half of their life.
      sizes[p] = 0.6 + life * 3.2;
      alphas[p] = opacities[p] * Math.max(0, 1 - life) * (life < 0.15 ? life / 0.15 : 1);
    }

    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('size').needsUpdate = true;
    geometry.getAttribute('alpha').needsUpdate = true;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
}
