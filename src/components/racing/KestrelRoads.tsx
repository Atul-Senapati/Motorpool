'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  BufferGeometry, ClampToEdgeWrapping, Group, InstancedMesh, Matrix4, Mesh, Quaternion,
  RepeatWrapping, Vector3, type Material, type Texture,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import roadModels from '@/config/roadModelData.json';
import {
  KIT_KERB, ROAD_PAVEMENT, ROAD_REPEAT, ROAD_TOP, ROAD_WIDTH, pieceBase, type Piece,
} from '@/config/roadConfig';
import {
  KESTREL_ARCS, KESTREL_NODES, KESTREL_RUNS, KESTREL_SWEEPS, kestrelArcPoints, sweepPoints,
} from '@/config/kestrelRoads';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { RoadColliders } from './RoadColliders';
import { STATION_SITE } from '@/config/stationConfig';

const ROAD_MODEL = '/models/roads.glb';
useGLTF.preload(ROAD_MODEL, DRACO_PATH);

const UP = new Vector3(0, 1, 0);

/** A piece's measured size, which is what lets a run count its straights. */
const sizeOf = (piece: string): number => {
  const entry = (roadModels.parts as Record<string, { size: number[] }>)[piece];
  return entry ? entry.size[0] : 1;
};

interface Laid { piece: Piece; across: number; along: number; turn: number; long: number }

/**
 * Every piece the grid needs, worked out once.
 *
 * The same fitting `IslandRoads` does, and for the same reason: the kit does
 * **not** tile at the junction pitch — a straight is 146.30 against a 37.92
 * junction, which is 3.86 and not 4 — so a layout that assumed pieces snap
 * would drift a couple of metres a span. Each run instead takes the whole
 * number of straights nearest its length and scales them along their own axis,
 * so the far end lands exactly where the layout says.
 *
 * What is different here is the frame. `IslandRoads` works in the airport
 * island's local (x, z); this works in the station's (across, along), which the
 * component's own group turns into the world. A run down the island is
 * therefore a run in `along`, and a cross street is a run in `across`.
 */
function layRoads(): Laid[] {
  const out: Laid[] = [];
  for (const node of KESTREL_NODES) {
    out.push({
      piece: node.piece, across: node.across, along: node.along, turn: node.turn, long: 1,
    });
  }
  for (const run of KESTREL_RUNS) {
    const dAcross = run.to[0] - run.from[0];
    const dAlong = run.to[1] - run.from[1];
    const span = Math.hypot(dAcross, dAlong);
    if (span < 0.5) continue;
    // A turn that sends the piece's own +X down the run, in this frame's terms:
    // local X is across and local Z is along, and `atan2(-dz, dx)` is what
    // `IslandRoads` uses against the same convention.
    const turn = Math.atan2(-dAlong, dAcross);
    let best: { piece: Piece; n: number; stretch: number } | null = null;
    for (const piece of ['straight4', 'straight2', 'straight1'] as const) {
      const len = sizeOf(piece);
      const n = Math.max(1, Math.round(span / len));
      const stretch = Math.abs(span / (n * len) - 1);
      if (stretch > 0.2) continue;
      if (!best || stretch < best.stretch - 0.001) best = { piece, n, stretch };
    }
    // Nothing fitted tidily. The short crossing approaches are the only runs
    // here that land in this branch, and they land in it hard — thirteen metres
    // against a 73 m piece. See the note on them in `kestrelRoads`.
    const fit = best ?? {
      piece: 'straight1' as Piece,
      n: Math.max(1, Math.round(span / sizeOf('straight1'))),
      stretch: 0,
    };
    const step = span / fit.n;
    const uAcross = dAcross / span;
    const uAlong = dAlong / span;
    for (let i = 0; i < fit.n; i++) {
      const at = (i + 0.5) * step;
      out.push({
        piece: fit.piece,
        across: run.from[0] + uAcross * at,
        along: run.from[1] + uAlong * at,
        turn,
        long: step / sizeOf(fit.piece),
      });
    }
  }
  return out;
}

/**
 * The crescent, swept rather than tiled.
 *
 * The kit has no curve of this shape and could not have one — its curves are
 * U-turns at three fixed radii (`kestrelRoads` says why that stopped being
 * good enough). What the kit does have is a road *surface*, and a surface can
 * be swept along any centreline at all: both bridge decks already do exactly
 * this, and this is the same `buildLoft` over a different curve.
 *
 * Built in the station's own (across, along), because the group it renders
 * inside turns that into the world — so `x` is across, `z` is along, and the
 * normal the loft sweeps the section along is the curve's own in that frame.
 *
 * Sampled at `SWEEP_STEP`, so the kerb line reads as a curve rather than as a
 * polygon.
 */

/**
 * A swept road along any centreline given as (across, along) points.
 *
 * The normal at each point is the left normal of the local tangent, taken
 * between its neighbours, which is what the crescent's analytic derivative
 * gives too.
 */
function sweepRoad(points: ReadonlyArray<readonly [number, number]>): BufferGeometry {
  const samples: LoftSample[] = [];
  let along = 0;
  const last = points.length - 1;
  for (let k = 0; k <= last; k++) {
    const [x, z] = points[k];
    const [px, pz] = points[Math.max(0, k - 1)];
    const [qx, qz] = points[Math.min(last, k + 1)];
    let dx = qx - px;
    let dz = qz - pz;
    // At the two ends the road meets a kit straight, and every one on this
    // island runs on a frame axis: snap the end's direction to that axis, so
    // the section is square to the straight it butts. A chord-based tangent
    // leaves the end turned a degree or two and a wedge of grass in the seam.
    if (k === 0 || k === last) {
      if (Math.abs(dx) > Math.abs(dz)) dz = 0; else dx = 0;
    }
    const len = Math.hypot(dx, dz) || 1;
    if (k > 0) along += Math.hypot(x - px, z - pz);
    samples.push({ x, z, y: ROAD_TOP, nx: -dz / len, nz: dx / len, arc: along });
  }
  const loft = buildLoft(samples, ROAD_SECTION, { vScale: 8 });
  // `buildLoft` gives u in metres round the section and v along the arc; the
  // kit's texture runs the other way — one repeat across, many along.
  const uv = loft.geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getY(i) * 8) / ROAD_REPEAT, Math.min(1, Math.max(0, uv.getX(i) / SECTION_LENGTH)));
  }
  uv.needsUpdate = true;
  return loft.geometry;
}

/**
 * The kit straight's cross-section, for the roads that are swept rather than
 * tiled: carriageway at `ROAD_TOP`, and each painted footway standing `KIT_KERB`
 * proud of it with a kerb face — the way the kit models a straight's — so a
 * curve's footway is a raised pavement like the street it continues, not paint.
 * Right edge first (see the note in `buildArcs` on why the order matters).
 */
const PAVE = ROAD_WIDTH * ROAD_PAVEMENT;
const HALF_ROAD = ROAD_WIDTH / 2;
const ROAD_SECTION: ProfileVertex[] = [
  { off: HALF_ROAD, rise: 0 },
  { off: HALF_ROAD, rise: KIT_KERB },
  { off: HALF_ROAD - PAVE, rise: KIT_KERB },
  { off: HALF_ROAD - PAVE, rise: 0 },
  { off: -(HALF_ROAD - PAVE), rise: 0 },
  { off: -(HALF_ROAD - PAVE), rise: KIT_KERB },
  { off: -HALF_ROAD, rise: KIT_KERB },
  { off: -HALF_ROAD, rise: 0 },
];
/** Metres round that section: what `buildLoft`'s u runs to, to normalise it. */
const SECTION_LENGTH = ROAD_SECTION.slice(1).reduce(
  (sum, v, i) => sum + Math.hypot(v.off as number - (ROAD_SECTION[i].off as number), v.rise as number - (ROAD_SECTION[i].rise as number)),
  0,
);

/** How finely a swept road is sampled: about every 1.5 m, so a bend reads as a curve. */
const SWEEP_STEP = 1.5;

function buildArcs() {
  const out: Array<{ geometry: BufferGeometry }> = [];
  // The shore road's S-bends and the grid's swept corners, and the crescent:
  // kit surface, swept along curves the kit does not have.
  for (const sweep of KESTREL_SWEEPS) out.push({ geometry: sweepRoad(sweepPoints(sweep, SWEEP_STEP)) });
  for (const arc of KESTREL_ARCS) out.push({ geometry: sweepRoad(kestrelArcPoints(arc, SWEEP_STEP)) });
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
        p.set(spot.across, pieceBase(spot.piece), spot.along);
        // Stretched along its OWN length only, so the width — and therefore the
        // lane spacing — is the same on every piece in the network.
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
 * Kestrel's streets.
 *
 * Two avenues, six cross streets, ten empty blocks, and a link from the road
 * viaduct through the level crossing — see `kestrelRoads` for the layout and
 * for the survey it is fitted to.
 *
 * Drawn inside the station's own group, so every number in the config is an
 * (across, along) in the frame the station, the cruise berth and the stage are
 * all laid in. That is the whole reason this is not `IslandRoads` with a
 * different table: that one works in the airport island's frame and is mounted
 * inside `AirportIsland`.
 *
 * The kit is solid, as drawn — `RoadColliders` — so a wheel rides the tarmac
 * and bumps up onto a straight's modelled footway.
 */
export function KestrelRoads() {
  const site = STATION_SITE;
  const { scene } = useGLTF(ROAD_MODEL, DRACO_PATH);
  /**
   * The most anisotropic filtering this machine will do — `IslandRoads`'s
   * reasoning, unchanged: you look ALONG a road, so every pixel past fifty
   * metres samples a long thin footprint, and isotropic filtering dissolves the
   * lane markings into grey.
   */
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());

  const laid = useMemo(() => layRoads(), []);
  const arcs = useMemo(() => buildArcs(), []);
  /** The same pieces in the collider's terms: x across, z along. */
  const solid = useMemo(() => laid.map((l) => ({ piece: l.piece, x: l.across, z: l.along, turn: l.turn, long: l.long })), [laid]);
  const arcSurfaces = useMemo(() => arcs.map((a) => a.geometry), [arcs]);
  useEffect(() => () => { for (const a of arcs) a.geometry.dispose(); }, [arcs]);

  /**
   * The kit's surface, cloned so the crescent can wrap it.
   *
   * Its UVs run to many repeats along a 200 m sweep where the kit's own
   * straights want one a piece, and mutating the shared texture would change
   * every tiled road in the network with it.
   */
  const surface = useMemo(() => {
    let found: Material | undefined;
    scene.getObjectByName('straight2')?.traverse((child) => {
      if (!found && child instanceof Mesh) found = child.material as Material;
    });
    if (!found) return undefined;
    const clone = found.clone() as Material & { map?: Texture | null };
    const map = (found as Material & { map?: Texture | null }).map;
    if (map) {
      const tex = map.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.anisotropy = maxAnisotropy;
      tex.needsUpdate = true;
      clone.map = tex;
    }
    return clone;
  }, [scene, maxAnisotropy]);

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
    console.info(`[roads] Kestrel: ${laid.length} pieces (${runs}) `
      + `and ${arcs.length} swept ${arcs.length === 1 ? 'curve' : 'curves'}, `
      + `${ROAD_WIDTH.toFixed(1)} m carriageway`);
  }, [kit, byPiece, laid, arcs]);

  if (!site) return null;

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      {[...byPiece].map(([piece, at]) => (
        <Pieces key={piece} pairs={kit.get(piece)} at={at} />
      ))}
      {arcs.map((a, i) => (
        <mesh key={`arc${i}`} geometry={a.geometry} material={surface} receiveShadow />
      ))}
      <RoadColliders kit={kit} laid={solid} extra={arcSurfaces} />
    </group>
  );
}
