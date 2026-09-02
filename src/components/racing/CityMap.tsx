'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import { Mesh } from 'three';
import { CITY, CITY_MODEL, CITY_NAV_IMAGE, DRACO_PATH } from '@/config/cityConfig';
import { loadCityNav } from '@/physics/cityNav';

useGLTF.preload(CITY_MODEL, DRACO_PATH);

/**
 * Chunk role comes from glTF `extras`, which GLTFLoader copies to `userData`.
 *
 * It deliberately does NOT come from the node name: three runs every name
 * through `PropertyBinding.sanitizeNodeName`, which strips ".:/[]" characters,
 * so any structured name is quietly mangled on load and prefix tests match
 * nothing at all (symptom: zero colliders, and the car falls through the city).
 */
interface ChunkData {
  /** Solid — hand this geometry to Rapier as a trimesh. */
  collides?: boolean;
  /** Source material name, e.g. `Street`. */
  surface?: string;
}

/**
 * Terrain and ground shells are the largest meshes in the file and lie flat, so
 * they have nothing to cast onto anything. Excluding them from the shadow pass
 * keeps the map out of the depth-only render without changing what you see.
 */
const NON_CASTING = new Set(['Street', 'Street_1', 'Street_texture', 'Parking', 'MaterialPiso']);

interface Chunk {
  name: string;
  vertices: Float32Array;
  indices: Uint32Array;
}

export function CityMap() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);

  const chunks = useMemo(() => {
    const solid: Chunk[] = [];

    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;

      const chunk = object.userData as ChunkData;
      object.receiveShadow = true;
      object.castShadow = !NON_CASTING.has(chunk.surface ?? '');

      if (!chunk.collides) return;

      const position = object.geometry.getAttribute('position');
      const index = object.geometry.getIndex();
      if (!position || !index) return;

      // The preprocessor bakes every node transform into the vertices and
      // leaves the chunk nodes at the identity, so these are already world
      // coordinates and need no further transform before Rapier sees them.
      solid.push({
        name: object.name,
        vertices: position.array as Float32Array,
        // Draco hands back whichever index width it chose; Rapier wants u32.
        indices: index.array instanceof Uint32Array
          ? index.array
          : new Uint32Array(index.array),
      });
    });

    return solid;
  }, [scene]);

  // The nav raster drives the minimap, the compass and reset-onto-road. It is
  // fetched alongside the model rather than suspended on: the city is fully
  // playable without it, and the reset handler falls back to the fixed spawn
  // until it lands.
  useEffect(() => {
    loadCityNav(CITY_NAV_IMAGE).catch((error) => {
      console.warn('[city] navigation raster failed to load; minimap disabled', error);
    });
  }, []);

  useEffect(() => {
    const triangles = chunks.reduce((n, c) => n + c.indices.length / 3, 0);
    console.info(
      `[city] ${chunks.length} solid chunks (${triangles.toLocaleString()} triangles) + ${CITY.boxes.length} box colliders`,
    );
  }, [chunks]);

  return (
    <group>
      <primitive object={scene} />

      {/* One fixed body holds the whole map. Rapier's broad-phase copes with a
          few thousand static colliders far better than a few thousand bodies,
          and none of this ever moves. */}
      <RigidBody type="fixed" colliders={false} friction={1}>
        {chunks.map((chunk) => (
          <TrimeshCollider
            key={chunk.name}
            args={[chunk.vertices, chunk.indices]}
            friction={1}
          />
        ))}

        {/* Buildings. A per-primitive AABB is tighter than a per-building one
            and needs no clustering; the oversized primitives that boxed badly
            were routed into the trimesh above instead. */}
        {CITY.boxes.map((box, i) => (
          <CuboidCollider
            key={i}
            args={[box.h[0], box.h[1], box.h[2]]}
            position={[box.p[0], box.p[1], box.p[2]]}
            friction={0.4}
            restitution={0.1}
          />
        ))}
      </RigidBody>
    </group>
  );
}
