'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { type PerspectiveCamera } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import type { GarageVehicle } from '@/config/garage';
import { cameraPose, frameVehicle, groundBlobTexture, layOut, studioEnvMap } from './garageStudio';
import { THEME } from './garageTheme';

/**
 * Bump when the shot changes (lighting, angle, size), so stale images are
 * re-rendered rather than served from cache for ever. v4: the render gained
 * an environment map and a ground shadow — see the module doc below — and
 * the camera switched from its own ad hoc angle to the shared `frameVehicle`,
 * which is also when the tram's thumbnail stopped looking like a sliver.
 */
// v5: the tram model was replaced (G:link Flexity -> Melbourne C-class),
// so every cached picture of the old one has to be thrown away. v6: replaced
// again, back to a G:link Flexity 2 — same reason.
//
// v7: the main line gained a second class, and `train.glb` stopped being the
// Class 91 and became a Class 43. The cache key is the vehicle *id*, not the
// file, so `train` kept serving a picture of a locomotive that is no longer in
// it — and since the new `train91` entry rendered the Class 91 fresh, the
// roster showed the same locomotive twice under two names. The id surviving a
// model swap is the whole reason this constant exists.
const CACHE_VERSION = 'v8';
const key = (id: string) => `motorpool.thumb.${CACHE_VERSION}.${id}`;

export const THUMB_W = 320;
export const THUMB_H = 180;

/**
 * One exposure. Mounts inside Suspense, so by the time its effect runs the
 * model is loaded and in the scene; it frames, renders a single frame by hand
 * and reads the pixels back.
 */
function Shot({ vehicle, onDone }: { vehicle: GarageVehicle; onDone: (url: string) => void }) {
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
    onDone(gl.domElement.toDataURL('image/jpeg', 0.9));
  }, [camera, gl, model, onDone, root, vehicle]);

  return <primitive object={model} />;
}

/**
 * Renders a thumbnail of the vehicle you are looking at, and caches it.
 *
 * There are no vehicle images in this project — it ships models, not renders —
 * and the roster wants pictures, not names. So the pictures are made here, from
 * the same GLBs the stage uses, and kept in localStorage. On a return visit the
 * rail is populated before the first model has downloaded.
 *
 * **It used to shoot the entire roster on mount**, walking a queue of every
 * vehicle without a cached picture. One at a time, so never a stampede of
 * parallel requests — but still, opening the garage for the first time pulled
 * down all twelve models back to back whether or not you ever looked at them,
 * which is most of what made a cold garage slow, and it left every model
 * resident on a machine that may not have the memory for them.
 *
 * Now it shoots exactly one vehicle: the focused one, when it has no picture
 * yet. That makes a thumbnail **free**. The stage is already downloading that
 * model to put it on the turntable, `useGLTF` shares its cache, so the picture
 * costs a render of something already in memory and no download at all. Browse
 * the roster and the rail fills in behind you, one vehicle per vehicle you
 * actually look at, and the cache means it only ever happens once per browser.
 *
 * The trade is visible and deliberate: on a first visit the cards you have not
 * been to yet are placeholders rather than pictures. Loading twelve models to
 * fill them is the cost that was being complained about.
 *
 * The first version of this lit the scene with three flat, uncoordinated
 * lights and nothing for the vehicle to reflect or sit on — no environment
 * map, no floor, no shadow. Direct light alone does not make a PBR material
 * look like paint; paint reads from what it reflects, and metallic or
 * clearcoat surfaces with nothing to reflect read as dull plastic regardless
 * of how many lights point at them. It now shares the stage's own studio
 * environment map and gets a soft radial "ground blob" standing in for a
 * contact shadow — cheaper than a real shadow map for a canvas that renders
 * exactly one frame and is thrown away, but enough to stop the vehicle
 * looking like it is floating in a void.
 *
 * Reports cached images through `onShot` on mount as well, so the parent has a
 * single path for "here is a picture of vehicle X" and no cache logic of its own.
 */
export default function GarageThumbs({
  vehicles,
  focusedId,
  onShot,
}: {
  vehicles: GarageVehicle[];
  /** The vehicle on the turntable. The only one this will ever load. */
  focusedId: string;
  onShot: (id: string, url: string) => void;
}) {
  /*
   * The cache is read once, in a lazy initialiser rather than an effect. This
   * component is loaded with `ssr: false`, so there is no server render to
   * disagree with, and it keeps the queue derived instead of synchronised —
   * setting state from inside an effect body is the cascading-render pattern
   * the project's lint forbids.
   */
  const [cached] = useState(() => {
    const hits: Array<[string, string]> = [];
    for (const v of vehicles) {
      let hit: string | null = null;
      try { hit = window.localStorage.getItem(key(v.id)); } catch { /* private mode */ }
      if (hit) hits.push([v.id, hit]);
    }
    return hits;
  });
  /**
   * Which vehicles already have a picture. Seeded from the cache, and added to
   * as each is shot — state rather than a ref because the render below is
   * derived from it, and derived state is what stops this component needing an
   * effect to decide what to do next.
   */
  const [shot, setShot] = useState<Record<string, true>>(
    () => Object.fromEntries(cached.map(([id]) => [id, true])),
  );
  const env = useMemo(() => studioEnvMap(), []);
  const blob = useMemo(() => groundBlobTexture(), []);
  useEffect(() => () => { env.dispose(); blob.dispose(); }, [env, blob]);

  // Reporting to the parent is an effect on an external party, not our state.
  useEffect(() => { for (const [id, url] of cached) onShot(id, url); }, [cached, onShot]);

  // The one vehicle worth rendering: the one being looked at, if it has no
  // picture yet. Everything else waits until it is looked at.
  const current = shot[focusedId] ? undefined : vehicles.find((v) => v.id === focusedId);
  if (!current) return null;

  const [w, , l] = current.size;
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
          <Shot
            key={current.id}
            vehicle={current}
            onDone={(url) => {
              try { window.localStorage.setItem(key(current.id), url); } catch { /* full or private */ }
              onShot(current.id, url);
              setShot((done) => ({ ...done, [current.id]: true }));
            }}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
