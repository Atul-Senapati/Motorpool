'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { type PerspectiveCamera } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import type { GarageVehicle } from '@/config/garage';
import { cameraPose, frameVehicle, groundBlobTexture, layOut, studioEnvMap } from './garageStudio';
import { THEME } from './garageTheme';

/**
 * The thumbnail studio: one off-screen canvas that photographs one vehicle
 * and hands back the picture. Used live by `GarageThumbs` (for a vehicle
 * with no picture shipped), and by the `/thumbs` bench, which shoots the
 * whole garage into `public/garage/thumbs/` so the rail never waits.
 *
 * Kept apart from `GarageThumbs` on purpose: that module reads the shipped
 * pictures' manifest, which the bench rewrites as it goes, and a bench that
 * imported it would hot-reload itself out from under its own run.
 */
export const THUMB_W = 320;
export const THUMB_H = 180;

/**
 * One exposure. Mounts inside Suspense, so by the time its effect runs the
 * model is loaded and in the scene; it frames, renders a single frame by hand
 * and reads the pixels back.
 */
function Shot({ vehicle, quality, onDone }: { vehicle: GarageVehicle; quality: number; onDone: (url: string) => void }) {
  const { scene } = useGLTF(vehicle.model, DRACO_PATH);
  const { gl, camera, scene: root } = useThree();
  const model = useMemo(() => layOut(scene, vehicle), [scene, vehicle]);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const cam = camera as PerspectiveCamera;
    // Same hero angle the stage uses — a vehicle should not look like a
    // different object in the roster than it does on the turntable.
    const framing = frameVehicle(vehicle, cam.fov, THUMB_W / THUMB_H);
    const { position, lookAt } = cameraPose(vehicle, framing);
    cam.position.set(...position);
    cam.lookAt(...lookAt);
    cam.updateProjectionMatrix();
    gl.render(root, cam);
    // WebP where the browser will encode it, JPEG where it will not (Safari
    // hands back a PNG for an encoder it lacks, the largest of all).
    const webp = gl.domElement.toDataURL('image/webp', quality);
    onDone(webp.startsWith('data:image/webp') ? webp : gl.domElement.toDataURL('image/jpeg', quality));
  }, [camera, gl, model, onDone, quality, root, vehicle]);

  return <primitive object={model} />;
}

/**
 * The studio itself: the stage's environment map, a soft ground blob for a
 * shadow, and the vehicle — rendered once (`frameloop="never"`) off-screen.
 */
export function ThumbStudio({ vehicle, quality = 0.86, onDone }: {
  vehicle: GarageVehicle;
  /** Encoder quality, 0..1. */
  quality?: number;
  onDone: (url: string) => void;
}) {
  const env = useMemo(() => studioEnvMap(), []);
  const blob = useMemo(() => groundBlobTexture(), []);
  useEffect(() => () => { env.dispose(); blob.dispose(); }, [env, blob]);
  const [w, , l] = vehicle.size;
  const blobSize = Math.max(w, l) * 1.3;

  return (
    <div
      aria-hidden
      style={{ position: 'fixed', left: -10000, top: 0, width: THUMB_W, height: THUMB_H, pointerEvents: 'none' }}
    >
      <Canvas
        frameloop="never"
        dpr={1}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ fov: 30, near: 0.1, far: 900 }}
      >
        <color attach="background" args={['#f4f6fa']} />
        <hemisphereLight intensity={1.0} color="#ffffff" groundColor="#c9d1dc" />
        <directionalLight position={[6, 9, -7]} intensity={2.2} color="#ffffff" />
        <directionalLight position={[-7, 4, 4]} intensity={0.8} color="#ffffff" />
        <pointLight position={[-2, 1.2, 6]} intensity={30} color={THEME.accent} distance={30} decay={2} />
        <primitive attach="environment" object={env} />

        <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[blobSize, blobSize]} />
          <meshBasicMaterial map={blob} transparent depthWrite={false} />
        </mesh>

        <Suspense fallback={null}>
          <Shot key={vehicle.id} vehicle={vehicle} quality={quality} onDone={onDone} />
        </Suspense>
      </Canvas>
    </div>
  );
}
