'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Environment as DreiEnvironment, Sky } from '@react-three/drei';
import {
  CanvasTexture, Color, DirectionalLight, EquirectangularReflectionMapping, Euler,
  InstancedMesh, Matrix4, Object3D, Quaternion, Vector3, type Group,
} from 'three';
import { TRACK, trackNormal, trackPoint, trackRadius } from '@/config/trackConfig';
import { WORLD_ID } from '@/config/world';

/**
 * Sky box size. Must comfortably exceed the distance from the world origin to
 * the furthest drivable point — the city's far corner is ~4.9 km out.
 */
const SKY_DISTANCE = 45000;

/** Sun position, shared by the sky, the shadow-casting light and the IBL. */
const SUN_AZIMUTH = 2.15;
const SUN_ELEVATION = 0.42;

const SUN_DIRECTION = new Vector3(
  Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
);

/**
 * Equirectangular environment map, drawn procedurally.
 *
 * drei's `Environment preset=` would fetch an HDRI from a CDN — an external
 * runtime dependency for something the scene can generate locally in a few ms.
 * This gives the McLaren's clearcoat a real gradient to reflect (sky above,
 * ground below, a hot sun) without any network request.
 */
function useProceduralEnvMap() {
  return useMemo(() => {
    const width = 512;
    const height = 256;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');

    // Sky: deep blue at the zenith easing to a warm haze at the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, height / 2);
    sky.addColorStop(0, '#2f6ec4');
    sky.addColorStop(0.65, '#8fc0e8');
    sky.addColorStop(1, '#e6ddc9');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height / 2);

    // Ground half: dark enough that the car's lower panels don't glow.
    const ground = ctx.createLinearGradient(0, height / 2, 0, height);
    ground.addColorStop(0, '#8b8f76');
    ground.addColorStop(1, '#2a2c25');
    ctx.fillStyle = ground;
    ctx.fillRect(0, height / 2, width, height / 2);

    // Sun disc, positioned to match SUN_DIRECTION so highlights line up.
    const u = ((SUN_AZIMUTH / (Math.PI * 2)) % 1) * width;
    const v = (0.5 - SUN_ELEVATION / Math.PI) * height;
    const glow = ctx.createRadialGradient(u, v, 0, u, v, 46);
    glow.addColorStop(0, 'rgba(255,252,235,1)');
    glow.addColorStop(0.18, 'rgba(255,240,200,0.85)');
    glow.addColorStop(1, 'rgba(255,235,190,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(u, v, 46, 0, Math.PI * 2);
    ctx.fill();

    const texture = new CanvasTexture(canvas);
    texture.mapping = EquirectangularReflectionMapping;
    return texture;
  }, []);
}

/**
 * Shadow-casting sun that follows the car.
 *
 * A single shadow map cannot cover a 1.4 km circuit at usable resolution, so
 * the light rig is translated to stay centred on the car and the map only ever
 * covers the ~70 m the player can actually see.
 */
function SunLight({ chassisRef }: { chassisRef: RefObject<Group | null> }) {
  const lightRef = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const carPosition = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const light = lightRef.current;
    const chassis = chassisRef.current;
    if (!light || !chassis) return;

    chassis.getWorldPosition(carPosition);
    // Snap to a 2 m grid: moving the shadow camera continuously makes the
    // texel grid crawl, which reads as shimmering shadow edges.
    const sx = Math.round(carPosition.x / 2) * 2;
    const sz = Math.round(carPosition.z / 2) * 2;

    target.position.set(sx, 0, sz);
    target.updateMatrixWorld();
    light.position.set(sx + SUN_DIRECTION.x * 90, SUN_DIRECTION.y * 90, sz + SUN_DIRECTION.z * 90);
  });

  useEffect(() => {
    const light = lightRef.current;
    if (light) light.target = target;
  }, [target]);

  return (
    <directionalLight
      ref={lightRef}
      castShadow
      intensity={3.1}
      color="#fff4e0"
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
      shadow-camera-left={-38}
      shadow-camera-right={38}
      shadow-camera-top={38}
      shadow-camera-bottom={-38}
      shadow-camera-near={1}
      shadow-camera-far={220}
    />
  );
}

/**
 * Trees, as two instanced meshes (trunks + canopies).
 *
 * Placement uses the analytic centreline: for any point, theta = atan2(z, x)
 * gives the nearest centreline angle, so `|r - trackRadius(theta)|` is a cheap
 * and accurate distance-to-track. Anything too close to the circuit is rejected
 * so trees never grow through the barriers.
 */
function Trees({ count = 420 }: { count?: number }) {
  const trunks = useRef<InstancedMesh>(null);
  const canopies = useRef<InstancedMesh>(null);

  const placements = useMemo(() => {
    const result: Array<{ x: number; z: number; scale: number; rotation: number }> = [];
    // Deterministic PRNG so the treeline is identical every load.
    let seed = 987654321;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    let attempts = 0;
    while (result.length < count && attempts < count * 40) {
      attempts++;
      const angle = random() * Math.PI * 2;
      const radius = 90 + random() * 320;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const distanceToTrack = Math.abs(radius - trackRadius(Math.atan2(z, x)));
      if (distanceToTrack < TRACK.barrierOffset + 9) continue;
      result.push({ x, z, scale: 0.75 + random() * 0.9, rotation: random() * Math.PI * 2 });
    }
    return result;
  }, [count]);

  useEffect(() => {
    const trunkMesh = trunks.current;
    const canopyMesh = canopies.current;
    if (!trunkMesh || !canopyMesh) return;

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Euler();

    placements.forEach((tree, i) => {
      euler.set(0, tree.rotation, 0);
      quaternion.setFromEuler(euler);

      position.set(tree.x, 1.8 * tree.scale, tree.z);
      scale.set(tree.scale, tree.scale, tree.scale);
      trunkMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));

      position.set(tree.x, 5.4 * tree.scale, tree.z);
      canopyMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });

    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    trunkMesh.computeBoundingSphere();
    canopyMesh.computeBoundingSphere();
  }, [placements]);

  return (
    <group>
      <instancedMesh ref={trunks} args={[undefined, undefined, placements.length]} castShadow>
        <cylinderGeometry args={[0.22, 0.32, 3.6, 6]} />
        <meshStandardMaterial color="#4a3728" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={canopies} args={[undefined, undefined, placements.length]} castShadow>
        <coneGeometry args={[2.5, 6.4, 8]} />
        <meshStandardMaterial color="#315a2c" roughness={0.85} flatShading />
      </instancedMesh>
    </group>
  );
}

/** A tiered grandstand, oriented to face the track. */
function Grandstand({ theta }: { theta: number }) {
  const { position, rotation } = useMemo(() => {
    const [cx, cz] = trackPoint(theta);
    const [nx, nz] = trackNormal(theta);
    const distance = TRACK.barrierOffset + 11;
    return {
      position: [cx + nx * distance, 0, cz + nz * distance] as [number, number, number],
      // Face back down the outward normal, i.e. toward the circuit.
      rotation: [0, Math.atan2(-nx, -nz), 0] as [number, number, number],
    };
  }, [theta]);

  const tiers = 7;

  return (
    <group position={position} rotation={rotation}>
      {/* Seating tiers, stepping up and back away from the track. */}
      {Array.from({ length: tiers }, (_, i) => (
        <mesh key={i} position={[0, 0.7 + i * 0.75, i * 1.25]} castShadow receiveShadow>
          <boxGeometry args={[38, 0.75, 1.3]} />
          <meshStandardMaterial color={i % 2 ? '#c9ccd2' : '#9aa2ad'} roughness={0.8} />
        </mesh>
      ))}
      {/* Back wall and roof. */}
      <mesh position={[0, 4.2, tiers * 1.25 + 0.6]} castShadow receiveShadow>
        <boxGeometry args={[38, 8.4, 0.6]} />
        <meshStandardMaterial color="#6f7681" roughness={0.85} />
      </mesh>
      <mesh position={[0, 8.6, tiers * 0.62]} castShadow>
        <boxGeometry args={[39.5, 0.35, tiers * 1.5]} />
        <meshStandardMaterial color="#3d434d" roughness={0.7} metalness={0.25} />
      </mesh>
      {/* Roof supports. */}
      {[-17.5, 0, 17.5].map((x) => (
        <mesh key={x} position={[x, 4.4, tiers * 1.25 + 0.2]} castShadow>
          <boxGeometry args={[0.4, 8.8, 0.4]} />
          <meshStandardMaterial color="#4a505a" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

export function RacingEnvironment({ chassisRef }: { chassisRef: RefObject<Group | null> }) {
  const envMap = useProceduralEnvMap();
  useEffect(() => () => envMap.dispose(), [envMap]);

  const skyPosition = useMemo(
    () => [SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z] as [number, number, number],
    [],
  );

  return (
    <>
      {/* `distance` sizes the sky box, which is drawn BackSide and sits at the
          world origin — so it only works while the camera is INSIDE it. drei's
          default of 1000 gives a half-extent of 500 m: fine for a 266 m
          circuit, but the city spans +-4.4 km, and everywhere beyond 500 m from
          the origin you are outside the box looking at culled back-faces, i.e.
          a black sky. The shader pins its depth to the far plane, so enlarging
          the box costs nothing and cannot clip. */}
      <Sky
        distance={SKY_DISTANCE}
        sunPosition={skyPosition}
        turbidity={4}
        rayleigh={1.1}
        mieCoefficient={0.006}
        mieDirectionalG={0.82}
      />
      <DreiEnvironment map={envMap} background={false} environmentIntensity={0.85} />

      <hemisphereLight args={[new Color('#bcd7f2'), new Color('#5d6446'), 0.5]} />
      <ambientLight intensity={0.18} />
      <SunLight chassisRef={chassisRef} />

      {/* Haze pushes the distant treeline back and hides the world edge. */}
      <fog attach="fog" args={['#c3d2e0', 220, 780]} />

      {/* Circuit dressing only. Both are placed off the analytic centreline, so
          in the city they would land in the sea — and the city brings its own
          40,000-odd trees anyway. */}
      {WORLD_ID === 'track' && (
        <>
          <Trees />
          {[0.35, 2.4, 4.6].map((theta) => (
            <Grandstand key={theta} theta={theta} />
          ))}
        </>
      )}
    </>
  );
}
