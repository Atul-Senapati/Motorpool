'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  LAKE, LAKE_Y, PONDS, STREAM, coastClearance, groundAt, lakeRadius, makeRandom, pondLevel,
  railEdgeAt, roadEdgeAt,
} from '@/config/countryConfig';
import { InstancedField } from './instancedField';

/**
 * What grows in and around the island's water: Skylark Water, the two ponds
 * and the brook.
 *
 * The pond pack is a set of alpha-carded plants — reeds, sedges, water grass,
 * lotus, broad leaves — plus lily pads, stones, a log and a duck. Every one of
 * them is scattered here rather than placed, because a reed bed is a hundred
 * reeds and no config should hold a hundred coordinates.
 *
 * Everything here is IN the water. These are water plants — reeds, sedges,
 * lotus, lily pads — and a reed standing on dry grass reads as a weed someone
 * forgot to cut, which is what the first pass looked like. So every plant is
 * rooted below the surface and rises through it, the lilies and the ducks
 * float on it, and even the stones and the log sit half submerged at the
 * edge. The one test every placement makes is `groundAt < surface`: the
 * ground there is under water.
 *
 * The scatter follows the water's own edge. The ponds are circles and the
 * lake has `lakeRadius(theta)`, but neither is the waterline — see `around`.
 * The brook takes its samples' own normals and its dug channel. Nothing is
 * placed on a road, on the railway's formation or over the coast.
 *
 * Instanced per part, so the whole scatter is a handful of draw calls: the
 * plants are a few hundred triangles each and there are hundreds of them.
 */

/** The parts, and the water they belong to. */
const EDGE_PLANTS = ['pondReed', 'pondSedge', 'pondSedgeTall', 'pondGrass', 'pondWaterGrass'] as const;
const SHALLOW_PLANTS = ['pondLotus', 'pondLotusOpen', 'pondLeaf', 'pondLeafWide', 'pondWaterGrassSmall'] as const;
type Part =
  | (typeof EDGE_PLANTS)[number]
  | (typeof SHALLOW_PLANTS)[number]
  | 'pondLily' | 'pondStone' | 'pondStoneSmall' | 'pondLog' | 'pondDuck';

interface Placement {
  part: Part;
  x: number;
  z: number;
  y: number;
  turn: number;
  scale: number;
}

const TAU = Math.PI * 2;
const KIT = '/models/country.glb';
useGLTF.preload(KIT, DRACO_PATH);

/** Clear of everything built: a plant may not stand on a lane or the line. */
const clear = (x: number, z: number) => (
  roadEdgeAt(x, z) > 2.5 && railEdgeAt(x, z) > 3 && coastClearance(x, z) > 6
);

function scatter(): Placement[] {
  const rnd = makeRandom(91);
  const out: Placement[] = [];
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const put = (part: Part, x: number, z: number, y: number, scale: number) => {
    out.push({ part, x, z, y, turn: rnd() * TAU, scale });
  };

  /**
   * One body of water: a radius at a bearing, its surface, and how many of
   * each thing to put round it. `edge` plants stand on the bank just clear of
   * the water, `shallow` ones in it, lilies float on it.
   *
   * The waterline is FOUND, not assumed. A lake's nominal radius is the
   * outline its basin was dug to, and the ground round it is not level — on
   * Skylark Water the terrain at that radius runs from 5.5 m to 9.8 m against
   * a 5.5 m surface, so a fringe placed on the nominal radius is half in the
   * water and half four metres up the bank. Marching out along each bearing
   * to where the ground crosses the surface gives the line the water actually
   * reaches, which is what a reed bed grows on.
   */
  const around = (
    cx: number, cz: number, radius: (t: number) => number, surface: number,
    counts: { edge: number; shallow: number; lily: number; stone: number; duck: number },
  ) => {
    const waterline = (t: number) => {
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const nominal = radius(t);
      let lo = nominal * 0.55;
      let hi = nominal * 1.5;
      if (groundAt(cx + hi * c, cz + hi * sn) < surface) return hi;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (groundAt(cx + mid * c, cz + mid * sn) < surface) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    /** In the water at this point: the ground under it is below the surface. */
    const wet = (x: number, z: number) => clear(x, z) && groundAt(x, z) < surface - 0.05;
    // The margin: reeds and sedges in the shallows just inside the waterline,
    // broken into beds so the edge reads as reed and open water rather than
    // an even fringe. Rooted a hand's depth under and rising through it.
    for (let i = 0; i < counts.edge; i++) {
      const t = rnd() * TAU;
      // Clumped: a bed every so often round the bearing, thick in the middle.
      const bed = Math.sin(t * 7 + 1.3) * 0.5 + 0.5;
      if (rnd() > 0.25 + bed * 0.75) continue;
      const f = waterline(t) - 0.5 - rnd() * 5;
      const x = cx + f * Math.cos(t);
      const z = cz + f * Math.sin(t);
      if (!wet(x, z)) continue;
      put(pick(EDGE_PLANTS), x, z, surface - 0.18 - rnd() * 0.3, 0.8 + rnd() * 0.7);
    }
    // In the shallows, standing on the bed and rising through the surface.
    for (let i = 0; i < counts.shallow; i++) {
      const t = rnd() * TAU;
      const f = waterline(t) * (0.84 + rnd() * 0.13);
      const x = cx + f * Math.cos(t);
      const z = cz + f * Math.sin(t);
      if (!wet(x, z)) continue;
      // Rooted below the surface and rising through it: these are a metre or
      // more tall, so a base half a metre down still stands clear of the water.
      put(pick(SHALLOW_PLANTS), x, z, surface - 0.35 - rnd() * 0.25, 0.7 + rnd() * 0.6);
    }
    // Lily pads, flat on the surface, in rafts.
    for (let i = 0; i < counts.lily; i++) {
      const t = rnd() * TAU;
      const f = waterline(t) * (0.5 + rnd() * 0.35);
      const cxr = cx + f * Math.cos(t);
      const czr = cz + f * Math.sin(t);
      for (let k = 0; k < 7; k++) {
        const x = cxr + (rnd() - 0.5) * 7;
        const z = czr + (rnd() - 0.5) * 7;
        if (!wet(x, z)) continue;
        put('pondLily', x, z, surface + 0.02, 1.6 + rnd() * 1.6);
      }
    }
    // Stones and a log or two, half submerged just inside the waterline.
    for (let i = 0; i < counts.stone; i++) {
      const t = rnd() * TAU;
      const f = waterline(t) - 0.4 - rnd() * 4;
      const x = cx + f * Math.cos(t);
      const z = cz + f * Math.sin(t);
      if (!wet(x, z)) continue;
      const log = rnd() < 0.18;
      put(log ? 'pondLog' : pick(['pondStone', 'pondStoneSmall'] as const),
        x, z, surface - 0.1 - rnd() * 0.12, log ? 0.9 + rnd() * 0.5 : 0.8 + rnd() * 1.1);
    }
    // Ducks, on the open water.
    for (let i = 0; i < counts.duck; i++) {
      const t = rnd() * TAU;
      const f = waterline(t) * (0.25 + rnd() * 0.5);
      const x = cx + f * Math.cos(t);
      const z = cz + f * Math.sin(t);
      if (!wet(x, z)) continue;
      put('pondDuck', x, z, surface - 0.07, 0.9 + rnd() * 0.25);
    }
  };

  around(LAKE.x, LAKE.z, lakeRadius, LAKE_Y,
    { edge: 900, shallow: 150, lily: 9, stone: 90, duck: 7 });
  for (const pond of PONDS) {
    around(pond.x, pond.z, () => pond.r, pondLevel(pond),
      { edge: 200, shallow: 40, lily: 3, stone: 26, duck: 3 });
  }

  // The brook: reeds and water grass standing IN the channel, thinning where
  // it runs fast through the coombe and thickening at the slow lower end.
  // Its water is drawn at `bed - 0.22`, so a plant is rooted below that.
  for (let i = 2; i < STREAM.length - 2; i++) {
    const sm = STREAM[i];
    const slow = i / STREAM.length;
    const water = sm.bed - 0.22;
    for (const side of [1, -1] as const) {
      if (rnd() > 0.2 + slow * 0.6) continue;
      const off = 0.5 + rnd() * 1.5;
      const x = sm.x + sm.nx * off * side;
      const z = sm.z + sm.nz * off * side;
      if (!clear(x, z) || groundAt(x, z) > water) continue;
      put(pick(EDGE_PLANTS), x, z, water - 0.12 - rnd() * 0.15, 0.6 + rnd() * 0.5);
    }
    if (rnd() < 0.05) {
      const off = rnd() * 1.4;
      const side = rnd() < 0.5 ? 1 : -1;
      const x = sm.x + sm.nx * off * side;
      const z = sm.z + sm.nz * off * side;
      if (clear(x, z) && groundAt(x, z) <= water) {
        put(rnd() < 0.3 ? 'pondLog' : 'pondStone', x, z, water - 0.08, 0.8 + rnd() * 0.8);
      }
    }
  }
  return out;
}

export function CountryWater() {
  const { scene: kit } = useGLTF(KIT, DRACO_PATH);
  const placed = useMemo(() => scatter(), []);

  /** One geometry and material per part, taken out of the kit once. */
  const parts = useMemo(() => {
    const out = new Map<Part, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const part of new Set(placed.map((p) => p.part))) {
      const node = kit.getObjectByName(part);
      if (!node) continue;
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      node.traverse((child) => {
        if (child instanceof Mesh) pairs.push({ geometry: child.geometry, material: child.material as Material });
      });
      if (pairs.length) out.set(part, pairs);
    }
    return out;
  }, [kit, placed]);

  /** The matrices, grouped by part and by the primitive within it. */
  const fields = useMemo(() => {
    const out: Array<{ key: string; geometry: BufferGeometry; material: Material; matrices: Matrix4[] }> = [];
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    for (const [part, pairs] of parts) {
      const mine = placed.filter((p) => p.part === part);
      pairs.forEach((pair, i) => {
        const matrices = mine.map((p) => {
          position.set(p.x, p.y, p.z);
          quaternion.setFromAxisAngle(new Vector3(0, 1, 0), p.turn);
          scale.set(p.scale, p.scale, p.scale);
          return new Matrix4().compose(position, quaternion, scale);
        });
        out.push({ key: `${part}:${i}`, geometry: pair.geometry, material: pair.material, matrices });
      });
    }
    return out;
  }, [parts, placed]);

  useEffect(() => {
    const plants = placed.filter((p) => !['pondStone', 'pondStoneSmall', 'pondLog', 'pondDuck'].includes(p.part)).length;
    console.info(`[country] water: ${plants} plants, ${placed.length - plants} stones, logs and ducks`);
  }, [placed]);

  return (
    <>
      {fields.map((f) => (
        <InstancedField
          key={f.key}
          matrices={f.matrices}
          geometry={f.geometry}
          material={f.material}
          castShadow={false}
        />
      ))}
    </>
  );
}
