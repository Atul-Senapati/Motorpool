'use client';

import { useEffect, useMemo, useRef } from 'react';
import { type BufferGeometry, type InstancedMesh, type Material, type Matrix4 } from 'three';

/**
 * How many instances share one draw call.
 *
 * The number trades draw calls against wasted vertex work, and the reason it
 * exists at all is that **an `InstancedMesh` is culled as one object**. Three
 * culls against its bounding sphere, and the sphere of a field that follows a
 * 9.2 km loop encloses the whole world — so every instance in it is submitted
 * every frame no matter where the camera is looking. The main line's sleepers
 * were one such field: 23,000 instances of a 96-triangle sleeper, **2.28 M
 * triangles every frame**, which measured as roughly half of everything the
 * camera pass drew.
 *
 * Cut into chunks, each chunk gets a bounding sphere a few tens of metres
 * across and the frustum rejects almost all of them. 256 sleepers is about 83 m
 * of double track, so the ~820 m the fog allows is a dozen or so chunks: a
 * dozen draw calls where there was one, against ninety-odd chunks' worth of
 * triangles no longer drawn. That is the trade, and it is a good one — draw
 * calls are cheap in the hundreds and vertices are not cheap in the millions.
 */
export const FIELD_CHUNK = 128;

/**
 * One chunk. Writes its matrices once and computes its own bounding sphere,
 * which is the whole point — a sphere round 83 m of track can be culled.
 */
function Chunk({ matrices, geometry, material, receiveShadow, castShadow }: {
  matrices: Matrix4[];
  geometry: BufferGeometry;
  material: Material;
  receiveShadow: boolean;
  castShadow: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    for (let i = 0; i < matrices.length; i++) instanced.setMatrixAt(i, matrices[i]);
    instanced.count = matrices.length;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [matrices]);
  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, matrices.length]}
      receiveShadow={receiveShadow}
      castShadow={castShadow}
    />
  );
}

/**
 * A large instanced field, cut into frustum-cullable chunks.
 *
 * Takes the matrices already built — the caller knows where its own things go —
 * and owns only the chunking and the per-chunk bounds. The geometry and the
 * material are shared across every chunk, so the renderer sees one program and
 * one set of uniforms however many chunks are visible.
 */
export function InstancedField({
  matrices, geometry, material, chunk = FIELD_CHUNK,
  receiveShadow = true, castShadow = false,
}: {
  matrices: Matrix4[];
  geometry: BufferGeometry;
  material: Material;
  chunk?: number;
  receiveShadow?: boolean;
  castShadow?: boolean;
}) {
  const groups = useMemo(() => {
    const out: Matrix4[][] = [];
    for (let i = 0; i < matrices.length; i += chunk) out.push(matrices.slice(i, i + chunk));
    return out;
  }, [matrices, chunk]);

  return (
    <>
      {groups.map((group, i) => (
        <Chunk
          key={i}
          matrices={group}
          geometry={geometry}
          material={material}
          receiveShadow={receiveShadow}
          castShadow={castShadow}
        />
      ))}
    </>
  );
}
