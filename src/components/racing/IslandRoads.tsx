'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3,
  type Material, type Texture,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import roadModels from '@/config/roadModelData.json';
import {
  ROAD_NODES, ROAD_RUNS, ROAD_TOP, ROAD_WIDTH, type Piece,
} from '@/config/roadConfig';

const ROAD_MODEL = '/models/roads.glb';
useGLTF.preload(ROAD_MODEL, DRACO_PATH);

const UP = new Vector3(0, 1, 0);

/** A piece's measured size, which is what lets a run count its straights. */
const sizeOf = (piece: string): [number, number, number] => {
  const entry = (roadModels.parts as Record<string, { size: number[] }>)[piece];
  return entry ? [entry.size[0], entry.size[1], entry.size[2]] : [1, 1, 1];
};

interface Laid { piece: Piece; x: number; z: number; turn: number; long: number }

/**
 * Every piece the network needs, worked out once.
 *
 * A run picks the LONGEST straight that divides it into a whole number of
 * pieces with the least stretch, then scales those pieces along their own
 * length so the run ends exactly where it should. The kit does not tile at
 * the junction pitch — see `roadConfig` — so fitting to the run is the only
 * way the far end lands where the layout says.
 */
function layRoads(): Laid[] {
  const out: Laid[] = [];
  for (const node of ROAD_NODES) {
    out.push({ piece: node.piece, x: node.x, z: node.z, turn: node.turn, long: 1 });
  }
  for (const run of ROAD_RUNS) {
    const dx = run.to[0] - run.from[0];
    const dz = run.to[1] - run.from[1];
    const span = Math.hypot(dx, dz);
    if (span < 1) continue;
    // A turn that sends the piece's own +X down the run. See `roadConfig`.
    const turn = Math.atan2(-dz, dx);
    // The candidate that needs the least stretching, longest first so a long
    // run is a handful of big pieces rather than a hundred small ones.
    let best: { piece: Piece; n: number; stretch: number } | null = null;
    for (const piece of ['straight4', 'straight2', 'straight1'] as const) {
      const len = sizeOf(piece)[0];
      const n = Math.max(1, Math.round(span / len));
      const stretch = Math.abs(span / (n * len) - 1);
      // 20% and not something tighter, because of the west link: it is 85.5 m
      // between two corners that both sit on a road centreline, so its length
      // is not a choice, and 73.15 goes into it 1.17 times. One piece stretched
      // 17% lengthens the dashes by 17% over 85 m, which nothing notices; two
      // pieces squashed to 42.75 would halve them, which everything does.
      if (stretch > 0.2) continue;
      if (!best || stretch < best.stretch - 0.001) best = { piece, n, stretch };
    }
    // Nothing fitted tidily: fall back to the smallest piece and stretch it.
    const fit = best ?? { piece: 'straight1' as Piece, n: Math.max(1, Math.round(span / sizeOf('straight1')[0])), stretch: 0 };
    const step = span / fit.n;
    const ux = dx / span;
    const uz = dz / span;
    for (let i = 0; i < fit.n; i++) {
      const at = (i + 0.5) * step;
      out.push({
        piece: fit.piece,
        x: run.from[0] + ux * at,
        z: run.from[1] + uz * at,
        turn,
        long: step / sizeOf(fit.piece)[0],
      });
    }
  }
  return out;
}

/** One piece, instanced wherever the network puts it. */
function Pieces({ pairs, at }: {
  pairs: Array<{ geometry: BufferGeometry; material: Material }> | undefined;
  at: readonly Laid[];
}) {
  const group = useRef<Group>(null);
  useEffect(() => {
    const g = group.current;
    if (!g || !pairs?.length) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    for (const child of g.children) {
      if (!(child instanceof InstancedMesh)) continue;
      at.forEach((spot, i) => {
        q.setFromAxisAngle(UP, spot.turn);
        p.set(spot.x, ROAD_TOP, spot.z);
        // Stretched along its OWN length only, so the width — and therefore
        // the lane spacing — is the same on every piece in the network.
        s.set(spot.long, 1, 1);
        child.setMatrixAt(i, m.compose(p, q, s));
      });
      child.instanceMatrix.needsUpdate = true;
      child.computeBoundingSphere();
    }
  }, [pairs, at]);
  if (!pairs?.length || !at.length) return null;
  return (
    <group ref={group}>
      {pairs.map((pair, i) => (
        <instancedMesh key={i} args={[pair.geometry, pair.material, at.length]} receiveShadow />
      ))}
    </group>
  );
}

/**
 * The island's roads.
 *
 * Drawn inside `AirportIsland`'s group, so every number in `roadConfig` is
 * the island's own (along, across) — the same frame the airfield is laid in.
 *
 * The carriageway is not a collider. A wheel rides the island crown, exactly
 * as it does on the airfield's aprons, and the road sits 12 mm over it.
 */
export function IslandRoads() {
  const { scene } = useGLTF(ROAD_MODEL, DRACO_PATH);
  /**
   * The most anisotropic filtering this machine will do.
   *
   * A road is the worst case there is for a mipmapped texture: you look ALONG
   * it, so every pixel past about fifty metres samples a footprint that is
   * long in one direction and thin in the other. Isotropic filtering has to
   * pick one mip for both, takes the blurrier, and the lane markings dissolve
   * into grey — which is exactly what the far end of this road looked like.
   *
   * The kit arrives at anisotropy 1 because that is glTF's default and
   * nothing in the file says otherwise. The rest of this project sets 4 to 8
   * on its own canvas textures; a road earns the maximum, which is 16 on any
   * hardware that runs this at all.
   */
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());

  const laid = useMemo(() => layRoads(), []);

  const kit = useMemo(() => {
    const out = new Map<string, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const piece of Object.keys(roadModels.parts)) {
      const node = scene.getObjectByName(piece);
      if (!node) continue;
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      node.traverse((child) => {
        if (child instanceof Mesh) {
          pairs.push({ geometry: child.geometry, material: child.material as Material });
        }
      });
      if (pairs.length) out.set(piece, pairs);
    }
    // Every piece shares the kit's two materials, so this touches each map
    // once however many pieces reference it.
    const done = new Set<unknown>();
    for (const pairs of out.values()) {
      for (const { material } of pairs) {
        const map = (material as Material & { map?: Texture }).map;
        if (!map || done.has(map)) continue;
        done.add(map);
        map.anisotropy = maxAnisotropy;
        map.needsUpdate = true;
      }
    }
    return out;
  }, [scene, maxAnisotropy]);

  const byPiece = useMemo(() => {
    const groups = new Map<string, Laid[]>();
    for (const item of laid) {
      if (!groups.has(item.piece)) groups.set(item.piece, []);
      groups.get(item.piece)!.push(item);
    }
    return groups;
  }, [laid]);

  useEffect(() => {
    if (!kit.size) return;
    const runs = [...byPiece].map(([p, a]) => `${a.length} x ${p}`).join(', ');
    console.info(`[roads] Halcyon Field: ${laid.length} pieces (${runs}), `
      + `${ROAD_WIDTH.toFixed(1)} m carriageway, ${roadModels.triangles} triangles in the kit`);
  }, [kit, byPiece, laid]);

  return (
    <>
      {[...byPiece].map(([piece, at]) => (
        <Pieces key={piece} pairs={kit.get(piece)} at={at} />
      ))}
    </>
  );
}
