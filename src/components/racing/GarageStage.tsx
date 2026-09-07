'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, MeshReflectorMaterial, useGLTF } from '@react-three/drei';
import { Group, type PerspectiveCamera, Vector3 } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import type { GarageVehicle } from '@/config/garage';
import { cameraPose, frameVehicle, layOut, padTexture, studioEnvMap } from './garageStudio';
import { THEME } from './garageTheme';

/**
 * A white cyclorama, built the way a car studio is.
 *
 * Two things from how these are actually shot decide everything here:
 *
 *  - **You light the walls, not the car.** Paint reads from what it reflects,
 *    so the room is white and bright, and the "lights" are large soft banks
 *    the car can see in its panels. A dark room gives the paint nothing — the
 *    previous version put a car in a void and it went flat.
 *  - **Corners must not exist.** The floor curves up into the wall (the cove),
 *    so no seam appears in the reflections. Photographers also hang dark
 *    "blacks" to put a false horizon in the reflection: that dark band is what
 *    gives a flank its depth. The reflection map carries one.
 *
 * Kept simple on purpose — nothing overhead that could reflect in the car.
 * The lighting and framing math (`frameVehicle`/`cameraPose`) live in
 * `garageStudio.ts`, shared with `GarageThumbs`, so a vehicle looks the same
 * way in both places.
 */

function Model({ vehicle, spin, onReady }: { vehicle: GarageVehicle; spin: React.RefObject<number>; onReady: (id: string) => void }) {
  const { scene } = useGLTF(vehicle.model, DRACO_PATH);
  const group = useRef<Group>(null);
  const model = useMemo(() => layOut(scene, vehicle), [scene, vehicle]);
  useEffect(() => {
    model.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    onReady(vehicle.id);
  }, [model, onReady, vehicle.id]);
  useFrame(() => { if (group.current) group.current.rotation.y = spin.current; });
  return <group ref={group}><primitive object={model} /></group>;
}

/**
 * Frames the vehicle from `frameVehicle`'s hero angle, always looking dead
 * centre. An earlier version pushed the look-at sideways in world space to
 * dodge the spec panel, scaled by the fit distance — which is calibrated on
 * car-scale distances (roughly 10-19 m) and blows up for the tram (roughly
 * 45-55 m under the box fit, more under the sphere fit it replaced), pushing
 * the look-at point over 11x the vehicle's own half-width away from it. The
 * car visibly floated off from the turntable ring, which sits at the true
 * origin. The panel is translucent instead, so overlap reads as a HUD rather
 * than as the car hiding behind a wall.
 *
 * `STAGE_MARGIN` backs the camera off further than a tight fit: this is the
 * hero shot the whole screen is built around, and a vehicle that fills the
 * frame edge-to-edge reads as cramped rather than dramatic. The thumbnail
 * renderer (`GarageThumbs`) keeps the tight default — a small tile wants to
 * fill itself, a large one wants air around the car.
 */
const STAGE_MARGIN = 1.55;

function Rig({ vehicle }: { vehicle: GarageVehicle }) {
  const camera = useThree((s) => s.camera as PerspectiveCamera);
  const size = useThree((s) => s.size);
  const target = useMemo(() => new Vector3(), []);
  const framing = useMemo(
    () => frameVehicle(
      vehicle, camera.fov, Math.max(size.width / Math.max(size.height, 1), 0.35), STAGE_MARGIN,
    ),
    [camera.fov, size.height, size.width, vehicle],
  );
  useFrame((_, dt) => {
    const { position, lookAt } = cameraPose(vehicle, framing);
    target.set(...position);
    camera.position.lerp(target, 1 - Math.pow(0.002, dt));
    camera.lookAt(...lookAt);
  });
  return null;
}

function TurnTable({ spin }: { spin: React.RefObject<number> }) {
  useFrame((_, dt) => { spin.current += dt * 0.13; });
  return null;
}

function Skeleton({ vehicle }: { vehicle: GarageVehicle }) {
  const [w, h, l] = vehicle.size;
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, l]} />
      <meshBasicMaterial color="#c9d2df" wireframe />
    </mesh>
  );
}

/**
 * The cove: floor curving up into the back wall with no corner. Built as a
 * quarter-cylinder lying along X, so its inside face sweeps from horizontal to
 * vertical. Open-ended, and long enough that its ends are outside the frame.
 */
function Cove({ radius, halfWidth, at }: { radius: number; halfWidth: number; at: number }) {
  return (
    <group position={[0, radius, at - radius]}>
      <mesh rotation={[0, 0, Math.PI / 2]} receiveShadow>
        {/* thetaStart/Length pick the lower-back quarter of the cylinder's inside. */}
        <cylinderGeometry args={[radius, radius, halfWidth * 2, 64, 1, true, Math.PI, Math.PI / 2]} />
        <meshStandardMaterial color="#f3f6fa" roughness={0.95} metalness={0} side={1} />
      </mesh>
    </group>
  );
}

export function GarageStage({ vehicle, onReady }: { vehicle: GarageVehicle; onReady: (id: string) => void }) {
  const env = useMemo(() => studioEnvMap(), []);
  const pad = useMemo(() => padTexture(), []);
  useEffect(() => () => { env.dispose(); pad.dispose(); }, [env, pad]);

  const spin = useRef(0.5);
  const [w, h, l] = vehicle.size;
  const reach = Math.max(l, w);

  const halfW = reach * 3.2;
  const backAt = reach * 2.0;       // the cove begins here, behind the vehicle (+Z)
  const coveR = reach * 1.1;
  const wallTop = coveR + h * 2 + reach * 1.2;
  const padR = reach * 0.64;

  return (
    <div className="absolute inset-0">
      <Canvas shadows dpr={[1, 1.75]} camera={{ fov: 30, near: 0.1, far: 1400 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <TurnTable spin={spin} />
        <color attach="background" args={['#f4f6fa']} />
        <fog attach="fog" args={['#f4f6fa', reach * 5, reach * 14]} />

        {/* Light the room. The banks in the reflection map do the paint; these
            do the shadows and pick out the wheels and lamps. */}
        <hemisphereLight intensity={0.9} color="#ffffff" groundColor="#c9d1dc" />
        <directionalLight position={[reach * 1.0, h * 3 + reach * 0.8, -reach * 1.2]} intensity={2.2} color="#ffffff"
          castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0003} />
        <spotLight position={[-reach * 1.3, h * 2.2, -reach * 0.3]} angle={0.5} penumbra={0.9} intensity={reach * reach * 0.9} color="#ffffff" distance={reach * 8} decay={2} />
        <spotLight position={[reach * 1.3, h * 2.2, reach * 0.4]} angle={0.5} penumbra={0.9} intensity={reach * reach * 0.7} color="#ffffff" distance={reach * 8} decay={2} />
        {/* Blue kick from behind, low: an edge in the accent so the silhouette
            separates from a white wall. */}
        <pointLight position={[-reach * 0.4, h * 0.45, reach * 1.1]} intensity={reach * reach * 0.5} color={THEME.accent} distance={reach * 3} decay={2} />

        <Rig vehicle={vehicle} />

        <Suspense key={vehicle.id} fallback={<Skeleton vehicle={vehicle} />}>
          <Model vehicle={vehicle} spin={spin} onReady={onReady} />
        </Suspense>
        <primitive attach="environment" object={env} />

        {/* --- the cyclorama --- */}
        <Cove radius={coveR} halfWidth={halfW} at={backAt} />
        <mesh position={[0, coveR + (wallTop - coveR) / 2, backAt]} receiveShadow>
          <planeGeometry args={[halfW * 2, wallTop - coveR]} />
          <meshStandardMaterial color="#f3f6fa" roughness={0.95} metalness={0} />
        </mesh>

        {/* Soft banks either side — the area lights the recipe asks for. They
            are what the flanks reflect; they also read in the floor. */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * reach * 1.7, h * 1.4 + reach * 0.4, -reach * 0.2]} rotation={[0, -side * Math.PI / 2, 0]}>
            <planeGeometry args={[reach * 2.2, reach * 0.9]} />
            <meshBasicMaterial color="#ffffff" toneMapped={false} />
          </mesh>
        ))}

        {/* Turntable decal. */}
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[padR * 2.13, padR * 2.13]} />
          <meshStandardMaterial map={pad} transparent roughness={0.6} metalness={0.05} />
        </mesh>

        {/* The dramatic, soft-edged ground shadow that grounds the car. */}
        <ContactShadows position={[0, 0.02, 0]} scale={reach * 2.4} blur={2.6} opacity={0.62} far={h * 1.5} resolution={1024} color="#0b1220" />

        {/* A white floor that still reflects: the reflection is the 3D cue. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, (backAt - reach * 4) / 2]}>
          <planeGeometry args={[halfW * 2, backAt + reach * 4]} />
          <MeshReflectorMaterial resolution={1024} mirror={0.35} mixBlur={4} mixStrength={0.9} blur={[220, 80]}
            depthScale={1.0} minDepthThreshold={0.4} maxDepthThreshold={1.6} color="#e9edf3" metalness={0.1} roughness={0.55} />
        </mesh>
      </Canvas>
    </div>
  );
}
