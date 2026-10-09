'use client';

import { useMemo } from 'react';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import type { BufferGeometry } from 'three';

type Part = BufferGeometry | null | undefined;

const ids = new WeakMap<object, number>();
let nextId = 1;
/**
 * A stable key for a list of objects, by identity. Lets a memo depend on the
 * CONTENTS of a list built inline at the call site (a new array every render)
 * without rebuilding a trimesh every render.
 */
export function identityKey(list: readonly (object | null | undefined)[]): string {
  return list.map((o) => {
    if (!o) return '-';
    let id = ids.get(o);
    if (id === undefined) { id = nextId++; ids.set(o, id); }
    return id;
  }).join(',');
}

/**
 * A drawn surface, made solid — exactly as drawn.
 *
 * One fixed trimesh built from the geometry's own triangles: what the wheels
 * touch is what you see — ballast shoulders, bridge parapets, girders, piers.
 * Mount it beside the meshes it copies, in the same group, so it picks up the
 * same transform. Pass one geometry or a list; a list becomes ONE trimesh.
 *
 * Indexed and non-indexed geometry both work; empty parts are skipped and an
 * empty total renders nothing (Rapier rejects a trimesh with no triangles).
 */
export function GeometryCollider({ geometry, friction = 0.9 }: {
  geometry: Part | readonly Part[];
  friction?: number;
}) {
  const parts = Array.isArray(geometry) ? geometry as readonly Part[] : [geometry as Part];
  const key = identityKey(parts);
  const args = useMemo(() => {
    const pos: number[] = [];
    const idx: number[] = [];
    for (const g of parts) {
      const at = g?.getAttribute('position');
      if (!g || !at || at.count < 3) continue;
      const base = pos.length / 3;
      for (let i = 0; i < at.count; i++) pos.push(at.getX(i), at.getY(i), at.getZ(i));
      const index = g.getIndex();
      if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
      else for (let i = 0; i < at.count; i++) idx.push(base + i);
    }
    if (idx.length < 3) return null;
    return [new Float32Array(pos), new Uint32Array(idx)] as [Float32Array, Uint32Array];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the parts' identities
  }, [key]);

  if (!args) return null;
  return (
    <RigidBody type="fixed" colliders={false}>
      <TrimeshCollider args={args} friction={friction} />
    </RigidBody>
  );
}
