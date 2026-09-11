'use client';

import { useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, type Mesh, type MeshBasicMaterial, type Object3D, type SpotLight } from 'three';

/**
 * A locomotive's lamps, on the end of a body that faces -Z.
 *
 * Two lenses and a spotlight, driven per frame from refs so nothing re-renders:
 * `dark` (0 in daylight, 1 deep in a bore — `trainDarknessAt`) fades the beam
 * in as the world fades out, because a headlight in sunshine is a sticker and
 * a spotlight the eye can see costs the same either way; `speed` decides which
 * end is leading. The end that leads shows white and throws the beam, the end
 * that trails shows red and throws nothing — swap the sign of `speed` and the
 * two ends swap, which is what a push-pull set does.
 *
 * One spotlight per locomotive, no shadow: the lining's diffuse is light enough
 * to take the pool (`LINING_MATERIAL.color`), and that pool sliding down the
 * tube ahead is the whole point.
 */
export function Headlamps({ dark, speed, tail = false, length, height = 1.35 }: {
  dark: RefObject<number>;
  speed: RefObject<number>;
  /** This is the trailing locomotive: it leads only when the train reverses. */
  tail?: boolean;
  /** Body length, so the lamps sit on the nose. */
  length: number;
  /** Lamp height over the rail. */
  height?: number;
}) {
  const spot = useRef<SpotLight>(null);
  const target = useRef<Object3D>(null);
  const lenses = useRef<(Mesh | null)[]>([]);
  const glares = useRef<(Mesh | null)[]>([]);
  const nose = -length / 2 - 0.06;

  useFrame(() => {
    const d = Math.min(1, Math.max(0, dark.current));
    const forward = speed.current >= -0.2;
    const leading = tail ? !forward : forward;
    const light = spot.current;
    if (light) {
      if (target.current) light.target = target.current;
      light.intensity = leading ? 900 * d : 0;
      light.visible = leading && d > 0.02;
    }
    const colour = leading ? WHITE : RED;
    for (const lens of lenses.current) {
      if (!lens) continue;
      (lens.material as MeshBasicMaterial).color.copy(colour);
    }
    for (const glare of glares.current) {
      if (!glare) continue;
      const m = glare.material as MeshBasicMaterial;
      m.color.copy(colour);
      m.opacity = (leading ? 0.55 : 0.25) * d;
      glare.visible = d > 0.02;
    }
  });

  return (
    <group>
      {[-0.72, 0.72].map((x, i) => (
        <group key={x} position={[x, height, nose]}>
          <mesh ref={(m) => { lenses.current[i] = m; }}>
            <circleGeometry args={[0.15, 16]} />
            <meshBasicMaterial color="#fff6dc" toneMapped={false} />
          </mesh>
          {/* Glare: a soft additive disc behind the lens, only in the dark. */}
          <mesh ref={(m) => { glares.current[i] = m; }} position={[0, 0, -0.02]}>
            <circleGeometry args={[0.5, 20]} />
            <meshBasicMaterial
              color="#fff6dc" transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false}
            />
          </mesh>
        </group>
      ))}
      {/* The high marker lamp. */}
      <mesh position={[0, height + 1.55, nose + 0.02]} ref={(m) => { lenses.current[2] = m; }}>
        <circleGeometry args={[0.1, 12]} />
        <meshBasicMaterial color="#fff6dc" toneMapped={false} />
      </mesh>
      <spotLight
        ref={spot}
        position={[0, height + 0.5, nose]}
        angle={0.34}
        penumbra={0.65}
        distance={150}
        decay={1.3}
        intensity={0}
        color="#fff1d0"
        castShadow={false}
      />
      <object3D ref={target} position={[0, 0.2, nose - 55]} />
    </group>
  );
}

const WHITE = new Color('#fff6dc');
const RED = new Color('#ff2b1f');
