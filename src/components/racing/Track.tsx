'use client';

import { useEffect, useMemo } from 'react';
import { RigidBody, TrimeshCollider, CuboidCollider } from '@react-three/rapier';
import { DoubleSide, RepeatWrapping } from 'three';
import { TRACK } from '@/config/trackConfig';
import { asphaltRoughness, asphaltTexture, barrierTexture, curbTexture, grassTexture } from './textures';
import { buildRibbon, buildStartLine, buildWall, sampleTrack } from './trackGeometry';

/** Metres of arc per texture repeat, per surface. */
const TILING = { asphalt: 9, curb: 1.6, line: 4, barrier: 6 } as const;

export function Track() {
  const built = useMemo(() => {
    const samples = sampleTrack();
    const w = TRACK.halfWidth;
    const inCorner = (a: { isCorner: boolean }, b: { isCorner: boolean }) => a.isCorner && b.isCorner;

    return {
      road: buildRibbon(samples, -w, w, 0, TILING.asphalt),
      curbOuter: buildRibbon(samples, w, w + TRACK.curbWidth, 0.025, TILING.curb, inCorner),
      curbInner: buildRibbon(samples, -w - TRACK.curbWidth, -w, 0.025, TILING.curb, inCorner),
      lineOuter: buildRibbon(samples, w - 0.35, w - 0.05, 0.012, TILING.line),
      lineInner: buildRibbon(samples, -w + 0.05, -w + 0.35, 0.012, TILING.line),
      barrierOuter: buildWall(samples, TRACK.barrierOffset, TRACK.barrierHeight, TILING.barrier),
      barrierInner: buildWall(samples, -TRACK.barrierOffset, TRACK.barrierHeight, TILING.barrier),
      startLine: buildStartLine(),
    };
  }, []);

  const textures = useMemo(() => {
    const asphalt = asphaltTexture();
    asphalt.repeat.set(1, 1);
    const curb = curbTexture();
    const barrier = barrierTexture();
    const grass = grassTexture();
    grass.repeat.set(180, 180);
    grass.wrapS = grass.wrapT = RepeatWrapping;
    return { asphalt, roughness: asphaltRoughness(), curb, barrier, grass };
  }, []);

  useEffect(() => {
    // Release the GPU memory held by the generated geometry on unmount.
    const geometries = Object.values(built).map((b) => ('geometry' in b ? b.geometry : b));
    return () => geometries.forEach((g) => g.dispose());
  }, [built]);

  return (
    <group>
      {/* --- Grass: one large fixed box. Tyre grip off the racing surface is
              handled analytically in physics/surfaceGrip.ts, because Rapier's
              raycast vehicle ignores collider friction entirely. --- */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[600, 5, 600]} position={[0, -5 - TRACK.grassDrop, 0]} />
      </RigidBody>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -TRACK.grassDrop, 0]} receiveShadow>
        <planeGeometry args={[1200, 1200]} />
        <meshStandardMaterial map={textures.grass} roughness={0.95} metalness={0} color="#9db877" />
      </mesh>

      {/* --- Asphalt. The visual ribbon doubles as the physics trimesh, so what
              you see is exactly what the wheels raycast against. --- */}
      <RigidBody type="fixed" colliders={false} friction={1}>
        <TrimeshCollider args={[built.road.vertices, built.road.indices]} friction={1} />
        <TrimeshCollider args={[built.barrierOuter.vertices, built.barrierOuter.indices]} friction={0.3} restitution={0.25} />
        <TrimeshCollider args={[built.barrierInner.vertices, built.barrierInner.indices]} friction={0.3} restitution={0.25} />
      </RigidBody>

      <mesh geometry={built.road.geometry} receiveShadow>
        <meshStandardMaterial
          map={textures.asphalt}
          roughnessMap={textures.roughness}
          roughness={0.82}
          metalness={0.05}
          color="#8d8d92"
        />
      </mesh>

      {/* Curbs, laid only through the corners. */}
      {[built.curbOuter, built.curbInner].map((curb, i) => (
        <mesh key={`curb-${i}`} geometry={curb.geometry} receiveShadow>
          <meshStandardMaterial map={textures.curb} roughness={0.55} metalness={0} />
        </mesh>
      ))}

      {/* Track edge markings. Slightly emissive so they stay readable at dusk. */}
      {[built.lineOuter, built.lineInner].map((line, i) => (
        <mesh key={`line-${i}`} geometry={line.geometry}>
          <meshStandardMaterial color="#f4f4f6" roughness={0.6} metalness={0} />
        </mesh>
      ))}

      <mesh geometry={built.startLine}>
        <meshStandardMaterial color="#f0f0f2" roughness={0.5} />
      </mesh>

      {/* Barriers. */}
      {[built.barrierOuter, built.barrierInner].map((wall, i) => (
        <mesh key={`barrier-${i}`} geometry={wall.geometry} castShadow receiveShadow>
          <meshStandardMaterial map={textures.barrier} roughness={0.7} metalness={0.1} side={DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
