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
import { ROAD_REPEAT, ROAD_TOP, ROAD_WIDTH, type Piece } from '@/config/roadConfig';
import { KESTREL_ARCS, KESTREL_NODES, KESTREL_RUNS } from '@/config/kestrelRoads';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
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
 * Sampled at about four metres of arc, which on a 116 m ellipse is a couple of
 * degrees a step: the kerb line reads as a curve rather than as a polygon, and
 * it is 60-odd quads for the whole sweep.
 */
const ARC_STEP = 4;

function buildArcs() {
  const out: Array<{ geometry: BufferGeometry }> = [];
  for (const arc of KESTREL_ARCS) {
    const [cx, cz] = arc.centre;
    const [ra, rb] = arc.radius;
    // Rough perimeter of the half ellipse, for how many samples to take.
    const steps = Math.max(24, Math.round((Math.PI * (ra + rb)) / 2 / ARC_STEP));
    const samples: LoftSample[] = [];
    let along = 0;
    for (let k = 0; k <= steps; k++) {
      // π to 0, which runs the sweep from the low `across` end to the high one
      // with the bulge toward −along. See `crescentAlong`.
      const t = Math.PI * (1 - k / steps);
      const x = cx + ra * Math.cos(t);
      const z = cz - rb * Math.sin(t);
      // Tangent by differentiation, then the left normal.
      const dx = ra * Math.sin(t);
      const dz = rb * Math.cos(t);
      const len = Math.hypot(dx, dz) || 1;
      if (k > 0) {
        const prev = samples[k - 1];
        along += Math.hypot(x - prev.x, z - prev.z);
      }
      samples.push({ x, z, y: ROAD_TOP, nx: -dz / len, nz: dx / len, arc: along });
    }
    // Right edge first, and that order is load-bearing. `buildLoft` derives
    // which way a face points from the section's own winding, and a flat
    // two-vertex section has no area to wind — so the rule it falls back on
    // turns the surface to −Y, and a road you can only see from underneath is
    // no road at all. Left-to-right gives down, right-to-left gives up.
    const profile: ProfileVertex[] = [
      { off: ROAD_WIDTH / 2, rise: 0 },
      { off: -ROAD_WIDTH / 2, rise: 0 },
    ];
    const loft = buildLoft(samples, profile, { vScale: 8 });
    // `buildLoft` puts u across the section and v along the arc; the kit's
    // texture runs the other way round, one repeat across and many along. The
    // same swap both bridge decks do — except that this is a road rather than a
    // bridge, so the kit's painted footways are kept instead of cropped off.
    const uv = loft.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getY(i) * 8) / ROAD_REPEAT, Math.min(1, Math.max(0, uv.getX(i))));
    }
    uv.needsUpdate = true;
    out.push({ geometry: loft.geometry });
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
        p.set(spot.across, ROAD_TOP, spot.along);
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
 * The carriageway is not a collider. A wheel rides the island crown, exactly as
 * it does on the airfield's roads, and the kit's slab sits 72 mm over it.
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
    </group>
  );
}
