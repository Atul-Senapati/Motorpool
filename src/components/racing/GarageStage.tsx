'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, MeshReflectorMaterial, PerformanceMonitor, useGLTF } from '@react-three/drei';
import { DoubleSide, EdgesGeometry, Group, PlaneGeometry, type PerspectiveCamera, Vector3 } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import type { GarageVehicle } from '@/config/garage';
import { accentGlowTexture, cameraPose, frameVehicle, layOut, padTexture, studioEnvMap } from './garageStudio';
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

/**
 * The vehicle on the turntable, and its ground shadow.
 *
 * The shadow is a contact shadow rendered ONCE (`frames={1}`) and parented to
 * the turntable, so it turns with the car. The car only ever spins on the
 * spot, so a shadow baked in its own frame is exactly the shadow it would
 * cast every frame — and the stage no longer re-renders a depth pass and a
 * 2048² shadow map sixty times a second to draw the same soft blot.
 */
function Model({ vehicle, spin, onReady }: { vehicle: GarageVehicle; spin: React.RefObject<number>; onReady: (id: string) => void }) {
  const { scene } = useGLTF(vehicle.model, DRACO_PATH);
  const group = useRef<Group>(null);
  const model = useMemo(() => layOut(scene, vehicle), [scene, vehicle]);
  useEffect(() => { onReady(vehicle.id); }, [model, onReady, vehicle.id]);
  useFrame(() => { if (group.current) group.current.rotation.y = spin.current; });
  const [w, h, l] = vehicle.size;
  const reach = Math.max(l, w);
  return (
    <group ref={group}>
      <primitive object={model} />
      <ContactShadows position={[0, 0.02, 0]} scale={reach * 2.4} blur={2.6} opacity={0.62} far={h * 1.5}
        resolution={512} frames={1} color="#0b1220" />
    </group>
  );
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
  /*
   * The car framed into the open part of the stage — a little left of
   * centre, clear of the spec sheet on the right, and a little low, under
   * the name. By shifting the camera's FILM (a view offset), not where it
   * looks: the look-at stays dead on the car, which is what the earlier
   * sideways look-at got wrong (see above), and the turntable ring stays
   * centred under it.
   */
  // A long vehicle — the tram, a train — fills the stage side-on whatever
  // is done, and sliding it over pushes its nose under the left arrow; so
  // the slide eases off from 12 m long to a quarter of itself by 40 m.
  const length = vehicle.size[2];
  useEffect(() => {
    const { width, height } = size;
    const ease = Math.max(0.25, Math.min(1, 1 - (length - 12) / 28 * 0.75));
    const shiftX = Math.min(width * 0.07, 120) * ease;
    const shiftY = Math.min(height * 0.045, 36);
    camera.setViewOffset(width, height, shiftX, -shiftY, width, height);
    return () => camera.clearViewOffset();
  }, [camera, size, length]);
  const target = useMemo(() => new Vector3(), []);
  // On a narrower screen the name and the spec sheet take a bigger share of
  // the stage, so the car stands further back: up to 40% more air under 1280.
  const margin = STAGE_MARGIN * (1 + Math.min(0.4, Math.max(0, (1280 - size.width) / 1280)));
  const framing = useMemo(
    () => frameVehicle(
      vehicle, camera.fov, Math.max(size.width / Math.max(size.height, 1), 0.35), margin,
    ),
    [camera.fov, margin, size.height, size.width, vehicle],
  );
  useFrame((_, dt) => {
    const { position, lookAt } = cameraPose(vehicle, framing);
    target.set(...position);
    camera.position.lerp(target, 1 - Math.pow(0.002, dt));
    camera.lookAt(...lookAt);
  });
  return null;
}

/** The turntable's own slow turn. */
const AUTO_SPIN = 0.13;

/**
 * The turntable: turns on its own, or by hand. A drag spins the car with the
 * pointer and lets go with its momentum, which bleeds away back into the slow
 * automatic turn — so the car can be looked round, and is never left still.
 */
interface Spin { angle: number; velocity: number; dragging: boolean }
function TurnTable({ spin, hand }: { spin: React.RefObject<number>; hand: React.RefObject<Spin> }) {
  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const h = hand.current;
    if (h.dragging) { spin.current = h.angle; return; }
    h.velocity += (AUTO_SPIN - h.velocity) * Math.min(1, dt * 1.6);
    h.angle += h.velocity * dt;
    spin.current = h.angle;
  });
  return null;
}

/**
 * What stands on the turntable while the model is still arriving.
 *
 * It was a grey wireframe box at the vehicle's real dimensions — honest, and
 * completely still, which is the problem: a stationary box is indistinguishable
 * from a stage that has finished loading and has nothing on it. So the box
 * stays, dimmer, and something moves through it: a cross-section sweeping nose
 * to tail, the way a vehicle scanner works. The size is still the truth — this
 * is the space the car is about to occupy, and the sweep measures it out.
 *
 * Everything here is three primitives and one animated transform. The stage is
 * already running a reflector, and that is not free; a placeholder that costs
 * a frame is a placeholder that makes loading worse.
 */
function Skeleton({ vehicle }: { vehicle: GarageVehicle }) {
  const [w, h, l] = vehicle.size;
  const scan = useRef<Group>(null);
  const outline = useMemo(() => new EdgesGeometry(new PlaneGeometry(w * 1.06, h * 1.06)), [w, h]);
  useEffect(() => () => outline.dispose(), [outline]);

  useFrame((state) => {
    const group = scan.current;
    if (!group) return;
    // A sine rather than a saw: it eases at both ends, so the sweep reads as
    // deliberate rather than as something snapping back to the start.
    const phase = (Math.sin(state.clock.elapsedTime * 1.25) + 1) / 2;
    group.position.z = -l / 2 + phase * l;
  });

  return (
    <group>
      {/* The envelope. Dimmer than it was, because it is now the backdrop to
          the sweep rather than the whole idea. */}
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, l]} />
        <meshBasicMaterial color="#c9d2df" wireframe transparent opacity={0.45} />
      </mesh>

      {/* The footprint, just off the floor so it does not fight the turntable
          decal for the same depth. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <planeGeometry args={[w, l]} />
        <meshBasicMaterial color={THEME.accent} transparent opacity={0.07} depthWrite={false} />
      </mesh>

      <group ref={scan}>
        <mesh position={[0, h / 2, 0]}>
          <planeGeometry args={[w * 1.06, h * 1.06]} />
          <meshBasicMaterial color={THEME.accent} transparent opacity={0.13} depthWrite={false} side={DoubleSide} />
        </mesh>
        <lineSegments geometry={outline} position={[0, h / 2, 0]}>
          <lineBasicMaterial color={THEME.accent} transparent opacity={0.85} />
        </lineSegments>
      </group>
    </group>
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
      <mesh rotation={[0, 0, Math.PI / 2]}>
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
  const glow = useMemo(() => accentGlowTexture(THEME.accent), []);
  useEffect(() => () => { env.dispose(); pad.dispose(); glow.dispose(); }, [env, pad, glow]);
  // Sharp on a good machine, and down to 1:1 the moment frames start to slip.
  const [dpr, setDpr] = useState(1.5);

  const spin = useRef(0.5);
  const hand = useRef<Spin>({ angle: 0.5, velocity: AUTO_SPIN, dragging: false });
  const drag = useRef({ x: 0, t: 0 });
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    hand.current.dragging = true;
    hand.current.velocity = 0;
    drag.current = { x: e.clientX, t: performance.now() };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hand.current.dragging) return;
    const now = performance.now();
    const dx = e.clientX - drag.current.x;
    const turn = dx * 0.008;
    hand.current.angle += turn;
    const dt = Math.max(1, now - drag.current.t) / 1000;
    hand.current.velocity = hand.current.velocity * 0.6 + (turn / dt) * 0.4;
    drag.current = { x: e.clientX, t: now };
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hand.current.dragging) return;
    hand.current.dragging = false;
    // A drag that stopped before letting go has no momentum to keep.
    if (performance.now() - drag.current.t > 80) hand.current.velocity = 0;
    hand.current.velocity = Math.max(-6, Math.min(6, hand.current.velocity));
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const [w, h, l] = vehicle.size;
  const reach = Math.max(l, w);

  const halfW = reach * 3.2;
  const backAt = reach * 2.0;       // the cove begins here, behind the vehicle (+Z)
  const coveR = reach * 1.1;
  const wallTop = coveR + h * 2 + reach * 1.2;
  const padR = reach * 0.64;

  return (
    <div
      className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
    >
      <Canvas dpr={dpr} camera={{ fov: 30, near: 0.1, far: 1400 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <PerformanceMonitor onDecline={() => setDpr(1)} />
        <TurnTable spin={spin} hand={hand} />
        <color attach="background" args={['#f4f6fa']} />
        <fog attach="fog" args={['#f4f6fa', reach * 5, reach * 14]} />

        {/* Light the room. The banks in the reflection map do the paint; these
            do the shadows and pick out the wheels and lamps. */}
        <hemisphereLight intensity={0.9} color="#ffffff" groundColor="#c9d1dc" />
        <directionalLight position={[reach * 1.0, h * 3 + reach * 0.8, -reach * 1.2]} intensity={2.2} color="#ffffff" />
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
        <mesh position={[0, coveR + (wallTop - coveR) / 2, backAt]}>
          <planeGeometry args={[halfW * 2, wallTop - coveR]} />
          <meshStandardMaterial color="#f3f6fa" roughness={0.95} metalness={0} />
        </mesh>

        {/* No soft-bank planes in the room: the studio environment map
            already carries the banks the paint reflects, and the planes
            themselves stood in shot as a pale slab over the backdrop. */}

        {/* A pool of the accent on the floor round the turntable. */}
        <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[reach * 2.6, reach * 2.6]} />
          <meshBasicMaterial map={glow} transparent depthWrite={false} toneMapped={false} />
        </mesh>

        {/* Turntable decal. */}
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[padR * 2.13, padR * 2.13]} />
          <meshStandardMaterial map={pad} transparent roughness={0.6} metalness={0.05} />
        </mesh>

        {/* A white floor that still reflects: the reflection is the 3D cue. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, (backAt - reach * 4) / 2]}>
          <planeGeometry args={[halfW * 2, backAt + reach * 4]} />
          <MeshReflectorMaterial resolution={512} mirror={0.35} mixBlur={4} mixStrength={0.9} blur={[220, 80]}
            depthScale={1.0} minDepthThreshold={0.4} maxDepthThreshold={1.6} color="#e9edf3" metalness={0.1} roughness={0.55} />
        </mesh>

      </Canvas>
    </div>
  );
}
