'use client';

import { useMemo } from 'react';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three';
import { pieceBase } from '@/config/roadConfig';

/**
 * The road kit, made solid — exactly as drawn.
 *
 * The kit's pieces were only ever drawn: wheels rode the island crown and the
 * tarmac floated over them, so tyres looked cut off at the road and the
 * straights' raised footways could be driven straight through. This builds one
 * trimesh collider out of the kit's OWN triangles, laid where the network lays
 * them, so what you see is what the wheels touch:
 *
 *  - a straight's carriageway is road, and its modelled footway is a 10 cm
 *    kerb a car bumps up onto (under the chassis collider's 0.14 m clearance);
 *  - a junction is flat, as the kit made it — paint, not kerb, at its corners;
 *  - the swept curves (`extra`) are their own surfaces.
 *
 * Nothing is added to the road that the kit does not have.
 */

export interface LaidPiece {
  piece: string;
  x: number;
  z: number;
  turn: number;
  long: number;
}

const UP = new Vector3(0, 1, 0);

export function RoadColliders({ kit, laid, extra = [] }: {
  /** Each piece's geometries, in the piece's own frame (as the kit's meshes hold them). */
  kit: Map<string, Array<{ geometry: BufferGeometry }>>;
  laid: readonly LaidPiece[];
  /** Surfaces already in the network's frame — Kestrel's swept curves. */
  extra?: readonly BufferGeometry[];
}) {
  const collider = useMemo(() => {
    const pos: number[] = [];
    const idx: number[] = [];
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    const v = new Vector3();
    const add = (geometry: BufferGeometry, matrix: Matrix4 | null) => {
      const at = geometry.getAttribute('position');
      const base = pos.length / 3;
      for (let i = 0; i < at.count; i++) {
        v.fromBufferAttribute(at, i);
        if (matrix) v.applyMatrix4(matrix);
        pos.push(v.x, v.y, v.z);
      }
      const index = geometry.getIndex();
      if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
      else for (let i = 0; i < at.count; i++) idx.push(base + i);
    };
    for (const spot of laid) {
      const pairs = kit.get(spot.piece);
      if (!pairs) continue;
      q.setFromAxisAngle(UP, spot.turn);
      p.set(spot.x, pieceBase(spot.piece), spot.z);
      s.set(spot.long, 1, 1);
      m.compose(p, q, s);
      for (const { geometry } of pairs) add(geometry, m);
    }
    for (const geometry of extra) add(geometry, null);
    if (!idx.length) return null;
    return [new Float32Array(pos), new Uint32Array(idx)] as [Float32Array, Uint32Array];
  }, [kit, laid, extra]);

  if (!collider) return null;
  return (
    <RigidBody type="fixed" colliders={false}>
      <TrimeshCollider args={collider} friction={1} />
    </RigidBody>
  );
}
