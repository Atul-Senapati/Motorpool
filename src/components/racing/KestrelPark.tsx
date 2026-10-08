'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, Mesh, MeshStandardMaterial,
  Quaternion, Vector3, type Material,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  PARK_BLOCK, POND, POND_MARGIN, POND_RIM, POND_STEPS, POND_WATERLINE, pondDrop,
} from '@/config/kestrelPark';
import { STATION_SITE } from '@/config/stationConfig';
import { blockCut } from '@/config/kestrelHalls';
import { InstancedField } from './instancedField';

const PARK_MODEL = '/models/park.glb';
useGLTF.preload(PARK_MODEL, DRACO_PATH);

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

/**
 * Kestrel Water and the park round it.
 *
 * `kestrelPark` says where and why; this builds it. Everything is drawn inside
 * the station's own group, so the numbers here are the (across, along) the
 * whole island is laid out in — local X is across and local Z is along, and
 * local Y is measured down from the island's crown.
 *
 * Four things in it:
 *
 * - the **basin**, dropped through the hole `buildIslands` cuts in the crown;
 * - the **water**, a fan across the basin at the level the bank was solved
 *   against;
 * - **reeds**, drawn rather than modelled — the park kit has trees and bushes
 *   and nothing that grows in water, and a pond whose bank is mown right to
 *   the edge reads as a swimming pool;
 * - **planting**, from the city's own park kit: the same four trees and two
 *   bushes Skylark is planted with, so nothing new ships for this.
 *
 * The trees have no colliders, which is the airfield's convention and Skylark's
 * — a tree you can drive through is wrong and sixty rigid bodies in a park is
 * worse. The basin does, because it is ground.
 */

/* ------------------------------------------------------------ the basin */

/**
 * Where the rings go, as fractions of the rim radius.
 *
 * Crowded near the rim and sparse near the middle, because that is where the
 * shape is: the bank turns through its whole fall in the outer eighth, and the
 * bed under the water is a dish nobody can see the curvature of. Four rings in
 * the top 12% and four over the remaining 88%.
 */
const RINGS = [1, 0.97, 0.94, 0.91, POND.shelf, 0.72, 0.52, 0.28] as const;

/**
 * The bank's colour, by how far under the crown it has fallen.
 *
 * Grass at the lip — the SAME grass the crown is painted in, `TOWN_PALETTE`'s,
 * so the seam where the two meet is a change of angle and not a change of
 * colour. Then the mown green gives out as the ground gets damp, a band of wet
 * mud at the waterline, and silt under it going dark. Held as stops and
 * interpolated, so retuning the profile does not also mean repainting it.
 */
const BANK: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [0.29, 0.36, 0.17]],
  [0.38, [0.33, 0.34, 0.22]],
  [0.55, [0.42, 0.38, 0.28]],
  [0.95, [0.27, 0.29, 0.20]],
  [2.0, [0.18, 0.22, 0.15]],
];

function bankColour(drop: number): readonly [number, number, number] {
  for (let i = 1; i < BANK.length; i++) {
    if (drop > BANK[i][0] && i < BANK.length - 1) continue;
    const [d0, c0] = BANK[i - 1];
    const [d1, c1] = BANK[i];
    const t = Math.min(1, Math.max(0, (drop - d0) / (d1 - d0)));
    return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
  }
  return BANK[0][1];
}

/**
 * The basin: concentric rings of the rim, shrunk toward the middle and dropped.
 *
 * Every ring is the rim's own shape scaled about the pond's centre, so the bays
 * and points in the outline carry all the way down to the bed instead of the
 * hole being a blob over a cone.
 *
 * Which way each triangle faces is **measured, not assumed**. The rings run
 * anticlockwise in (across, along) and the ground has to face up, and rather
 * than work that out once and get it silently wrong — a down-facing basin is
 * an invisible one, which is how the cruise quay first shipped — each triangle
 * is emitted in whichever order gives a positive Y normal.
 */
function buildBasin() {
  const position: number[] = [];
  const colour: number[] = [];
  const index: number[] = [];

  const push = (across: number, along: number, drop: number) => {
    position.push(across, -drop, along);
    const [r, g, b] = bankColour(drop);
    colour.push(r, g, b);
  };

  for (const f of RINGS) {
    const drop = pondDrop(f);
    for (const [across, along] of POND_RIM) {
      push(POND.across + (across - POND.across) * f, POND.along + (along - POND.along) * f, drop);
    }
  }
  // The deepest point, which every innermost triangle fans to.
  const middle = position.length / 3;
  push(POND.across, POND.along, pondDrop(0));

  const tri = (a: number, b: number, c: number) => {
    const ax = position[a * 3];
    const az = position[a * 3 + 2];
    const up = (position[b * 3 + 2] - az) * (position[c * 3] - ax)
      - (position[b * 3] - ax) * (position[c * 3 + 2] - az);
    if (up > 0) index.push(a, b, c);
    else index.push(a, c, b);
  };

  for (let r = 0; r < RINGS.length - 1; r++) {
    for (let i = 0; i < POND_STEPS; i++) {
      const j = (i + 1) % POND_STEPS;
      const a = r * POND_STEPS + i;
      const b = r * POND_STEPS + j;
      const c = (r + 1) * POND_STEPS + i;
      const d = (r + 1) * POND_STEPS + j;
      tri(a, b, d);
      tri(a, d, c);
    }
  }
  const last = (RINGS.length - 1) * POND_STEPS;
  for (let i = 0; i < POND_STEPS; i++) {
    tri(last + i, last + ((i + 1) % POND_STEPS), middle);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colour, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return {
    geometry,
    vertices: new Float32Array(position),
    indices: new Uint32Array(index),
  };
}

/**
 * The water: one fan at the level the bank was solved for.
 *
 * Laid at `POND_WATERLINE`, the fraction of the rim where the bank passes
 * through the surface, pulled in half a percent so the edge tucks under the
 * bank rather than poking out of it.
 */
function buildWater() {
  const f = POND_WATERLINE * 0.995;
  const position: number[] = [POND.across, -POND.surface, POND.along];
  const index: number[] = [];
  for (const [across, along] of POND_RIM) {
    position.push(
      POND.across + (across - POND.across) * f,
      -POND.surface,
      POND.along + (along - POND.along) * f,
    );
  }
  for (let i = 0; i < POND_STEPS; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % POND_STEPS);
    const up = (position[a * 3 + 2] - POND.along) * (position[b * 3] - POND.across)
      - (position[a * 3] - POND.across) * (position[b * 3 + 2] - POND.along);
    if (up > 0) index.push(0, a, b);
    else index.push(0, b, a);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------- the reeds */

/**
 * One clump of reeds, as a merged fan of blades.
 *
 * Nine blades from a common root, each a tapered quad leaning out and away —
 * two triangles a blade, eighteen a clump, which is why they can be strewn by
 * the hundred round a waterline. Two-sided, because a blade is one quad and is
 * seen from both hands.
 *
 * The colours are per-vertex and run from a dark wet base to a bleached tip:
 * that vertical gradient is most of what makes a flat quad read as a stem, and
 * it costs a byte a corner.
 */
function buildReeds() {
  const position: number[] = [];
  const colour: number[] = [];
  const index: number[] = [];
  // Its own sequence, so the clump is the same clump in every instance of it.
  let seed = 8237;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let b = 0; b < 9; b++) {
    const yaw = (b / 9) * TAU + rnd() * 0.6;
    const lean = 0.18 + rnd() * 0.3;
    const height = 0.9 + rnd() * 0.8;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    // Across the blade, square to the way it leans, so it is widest face-on.
    const wx = -dz;
    const wz = dx;
    const root = 0.05;
    const tip = 0.012;
    const base = position.length / 3;
    const corners: Array<[number, number, number, number]> = [
      [-root * wx, 0, -root * wz, 0],
      [root * wx, 0, root * wz, 0],
      [dx * lean * height - tip * wx, height, dz * lean * height - tip * wz, 1],
      [dx * lean * height + tip * wx, height, dz * lean * height + tip * wz, 1],
    ];
    for (const [x, y, z, up] of corners) {
      position.push(x, y, z);
      // Wet olive at the root, dry straw-green at the head.
      colour.push(0.16 + 0.34 * up, 0.24 + 0.28 * up, 0.10 + 0.14 * up);
    }
    index.push(base, base + 1, base + 3, base, base + 3, base + 2);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colour, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------------------------------------------------- the planting */

type Part = 'treeSlim' | 'treeBroad' | 'treeTall' | 'treeBig' | 'bush' | 'bushLow';
const PARTS: readonly Part[] = ['treeSlim', 'treeBroad', 'treeTall', 'treeBig', 'bush', 'bushLow'];

interface Placement { part: Part; across: number; along: number; turn: number; scale: number }
interface Clump { across: number; along: number; turn: number; scale: number }

/** Deterministic, so the park is the same park every load. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** How far out the rim reaches on the bearing from the pond's middle to here. */
function rimAt(across: number, along: number): number {
  const theta = Math.atan2(along - POND.along, across - POND.across);
  let i = Math.round((theta / TAU) * POND_STEPS);
  i = ((i % POND_STEPS) + POND_STEPS) % POND_STEPS;
  const [rx, rz] = POND_RIM[i];
  return Math.hypot(rx - POND.across, rz - POND.along);
}

/** Fraction of the way out to the rim: under 1 is inside the basin. */
const pondFraction = (across: number, along: number) => (
  Math.hypot(across - POND.across, along - POND.along) / rimAt(across, along)
);

/**
 * What is planted, and where.
 *
 * Three rules, and between them they are the whole park:
 *
 * - a **belt round the water**, dense and mixed, three to twelve metres back
 *   from the rim — which is where a tree by a pond actually is;
 * - **corner groups** in the four corners of the block, because a park with an
 *   even scatter reads as an orchard and a park with clumps reads as a park;
 * - a thin **scatter** over what is left, to fill the lawn without closing it.
 *
 * Everything is checked against three things: it must be inside the block by
 * a margin so no canopy overhangs a carriageway, outside the rim so nothing
 * grows in the water, and not on top of something already planted.
 */
function plant(): { placed: Placement[]; reeds: Clump[]; lilies: Clump[] } {
  const rnd = makeRandom(4517);
  const placed: Placement[] = [];
  const taken: Array<[number, number]> = [];

  /** Verge between the kerb and anything with leaves on it. */
  const VERGE = 4;
  // The block's north-east corner is the inside of the dock road's swept bend.
  const cut = blockCut(PARK_BLOCK);
  const room = (across: number, along: number) => (
    across > PARK_BLOCK.acrossFrom + VERGE && across < PARK_BLOCK.acrossTo - VERGE
    && along > PARK_BLOCK.alongFrom + VERGE && along < PARK_BLOCK.alongTo - VERGE
    && !(cut && across > cut.across && along > cut.along
      && Math.hypot(across - cut.across, along - cut.along) > cut.radius - VERGE)
  );
  const clear = (across: number, along: number, min: number) => {
    for (const [a, l] of taken) if (Math.hypot(a - across, l - along) < min) return false;
    return true;
  };
  const pick = (mix: ReadonlyArray<readonly [Part, number]>): Part => {
    let roll = rnd();
    for (const [part, weight] of mix) {
      roll -= weight;
      if (roll <= 0) return part;
    }
    return mix[mix.length - 1][0];
  };
  const put = (part: Part, across: number, along: number, scale: number, min: number) => {
    if (!room(across, along)) return false;
    // Outside the water, and off the bank's brow so no trunk stands in a slope.
    if (pondFraction(across, along) < 1.06) return false;
    if (!clear(across, along, min)) return false;
    placed.push({ part, across, along, turn: rnd() * TAU, scale });
    taken.push([across, along]);
    return true;
  };

  // The belt. Walked round the rim rather than sampled at random, so it thins
  // and thickens instead of clotting.
  const belt: ReadonlyArray<readonly [Part, number]> = [
    ['treeBroad', 0.3], ['treeTall', 0.22], ['treeSlim', 0.24], ['treeBig', 0.1],
    ['bush', 0.09], ['bushLow', 0.05],
  ];
  for (let i = 0; i < 150; i++) {
    const theta = (i / 150) * TAU;
    const r = rimAt(POND.across + Math.cos(theta), POND.along + Math.sin(theta));
    // Kept to the inner half of the grass, because the outer half is where the
    // block's verge is and a tree placed out there is a tree `room()` throws
    // away — which is how the first cut of this ended up with twenty.
    const out = r + 2.5 + rnd() * 6;
    const part = pick(belt);
    const min = part.startsWith('bush') ? 2.6 : 6;
    put(
      part,
      POND.across + out * Math.cos(theta),
      POND.along + out * Math.sin(theta),
      0.85 + rnd() * 0.35,
      min,
    );
  }

  // Corner groups, tucked into the four angles of the block where the belt
  // does not reach.
  for (const [ca, cl] of [
    [PARK_BLOCK.acrossFrom + 11, PARK_BLOCK.alongFrom + 11],
    [PARK_BLOCK.acrossTo - 11, PARK_BLOCK.alongFrom + 11],
    [PARK_BLOCK.acrossFrom + 11, PARK_BLOCK.alongTo - 11],
    [PARK_BLOCK.acrossTo - 11, PARK_BLOCK.alongTo - 11],
  ]) {
    for (let i = 0; i < 7; i++) {
      const theta = rnd() * TAU;
      const r = rnd() * 9;
      put(
        pick([['treeBig', 0.34], ['treeTall', 0.33], ['treeBroad', 0.33]]),
        ca + r * Math.cos(theta),
        cl + r * Math.sin(theta),
        0.95 + rnd() * 0.3,
        7,
      );
    }
  }

  // And a scatter over the lawn, mostly low.
  for (let i = 0; i < 140; i++) {
    put(
      pick([['bushLow', 0.34], ['bush', 0.3], ['treeSlim', 0.22], ['treeBroad', 0.14]]),
      PARK_BLOCK.acrossFrom + rnd() * (PARK_BLOCK.acrossTo - PARK_BLOCK.acrossFrom),
      PARK_BLOCK.alongFrom + rnd() * (PARK_BLOCK.alongTo - PARK_BLOCK.alongFrom),
      0.8 + rnd() * 0.3,
      5,
    );
  }

  /*
   * The reeds, in stands rather than as a fringe.
   *
   * A continuous collar of reed round a pond is a bath mat. What reed does is
   * colonise the shallows it likes and leave the rest bare, so this picks a
   * dozen arcs of the waterline and fills only those — and each stand runs
   * from a little above the water to a little below it, which is what hides
   * the line where the water meets the bank.
   */
  const reeds: Clump[] = [];
  for (let stand = 0; stand < 12; stand++) {
    const from = rnd() * TAU;
    const width = 0.18 + rnd() * 0.42;
    const count = 10 + Math.floor(rnd() * 16);
    for (let i = 0; i < count; i++) {
      const theta = from + rnd() * width;
      const f = POND_WATERLINE + (rnd() - 0.62) * 0.1;
      const r = rimAt(POND.across + Math.cos(theta), POND.along + Math.sin(theta)) * f;
      reeds.push({
        across: POND.across + r * Math.cos(theta),
        along: POND.along + r * Math.sin(theta),
        turn: rnd() * TAU,
        scale: 0.75 + rnd() * 0.6,
      });
    }
  }

  /* Lily pads, in two rafts in the still water off the reed stands. */
  const lilies: Clump[] = [];
  for (const [theta0, spread] of [[1.1, 0.5], [4.2, 0.7]]) {
    for (let i = 0; i < 26; i++) {
      const theta = theta0 + (rnd() - 0.5) * spread;
      const f = 0.45 + rnd() * 0.35;
      const r = rimAt(POND.across + Math.cos(theta), POND.along + Math.sin(theta)) * f;
      lilies.push({
        across: POND.across + r * Math.cos(theta),
        along: POND.along + r * Math.sin(theta),
        turn: rnd() * TAU,
        scale: 0.6 + rnd() * 0.7,
      });
    }
  }

  return { placed, reeds, lilies };
}

/* ------------------------------------------------------------ the drawing */

/** One part, instanced where the planting put it. Local (across, y, along). */
function Instanced({ geometry, material, at, castShadow = true }: {
  geometry: BufferGeometry;
  material: Material;
  at: ReadonlyArray<{ across: number; along: number; y?: number; turn: number; scale: number }>;
  castShadow?: boolean;
}) {
  const matrices = useMemo(() => {
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    return at.map((a) => {
      q.setFromAxisAngle(UP, a.turn);
      p.set(a.across, a.y ?? 0, a.along);
      s.setScalar(a.scale);
      return new Matrix4().compose(p, q, s);
    });
  }, [at]);
  if (!matrices.length) return null;
  return (
    <InstancedField
      matrices={matrices}
      geometry={geometry}
      material={material}
      chunk={40}
      castShadow={castShadow}
    />
  );
}

export function KestrelPark() {
  const site = STATION_SITE;
  const { scene } = useGLTF(PARK_MODEL, DRACO_PATH);

  const kit = useMemo(() => {
    const out = new Map<Part, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of PARTS) {
      const node = scene.getObjectByName(name);
      if (!node) continue;
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      node.traverse((child) => {
        if (child instanceof Mesh) {
          pairs.push({ geometry: child.geometry, material: child.material as Material });
        }
      });
      if (pairs.length) out.set(name, pairs);
    }
    return out;
  }, [scene]);

  const built = useMemo(() => ({
    basin: buildBasin(),
    water: buildWater(),
    reed: buildReeds(),
    ...plant(),
  }), []);

  const byPart = useMemo(() => {
    const groups = new Map<Part, Placement[]>();
    for (const p of built.placed) {
      if (!groups.has(p.part)) groups.set(p.part, []);
      groups.get(p.part)!.push(p);
    }
    return groups;
  }, [built]);

  const materials = useMemo(() => ({
    bank: new MeshStandardMaterial({ vertexColors: true, roughness: 0.97 }),
    /* Still water, and the same reading as Skylark Water so the two islands'
       water is one substance: dark, slightly metallic so it takes the sky, and
       just transparent enough that the bed is a presence under it. */
    water: new MeshStandardMaterial({
      color: '#2d5560', roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.86,
    }),
    reed: new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: DoubleSide }),
    lily: new MeshStandardMaterial({ color: '#35612c', roughness: 0.75 }),
  }), []);

  useEffect(() => {
    const trees = built.placed.filter((p) => !p.part.startsWith('bush')).length;
    console.info(`[park] Kestrel Water: ${(POND.rx * 2).toFixed(0)} x ${(POND.rz * 2).toFixed(0)} m, `
      + `${POND.depth} m deep, water ${POND.surface} m under the crown; `
      + `${trees} trees, ${built.placed.length - trees} bushes, ${built.reeds.length} reed clumps, `
      + `${built.lilies.length} lilies; ${POND_MARGIN.toFixed(1)} m of bank to the nearest kerb`);
    return () => {
      built.basin.geometry.dispose();
      built.water.dispose();
      built.reed.dispose();
      for (const m of Object.values(materials)) m.dispose();
    };
  }, [built, materials]);

  if (!site) return null;

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      <mesh geometry={built.basin.geometry} material={materials.bank} receiveShadow />
      <mesh geometry={built.water} material={materials.water} receiveShadow />

      <Instanced
        geometry={built.reed}
        material={materials.reed}
        at={built.reeds}
        castShadow={false}
      />

      {/* Lily pads: flat discs on the surface, a whisker over it so they do not
          fight the water for the same depth. Their own tiny geometry rather
          than the kit's `pond` part, which is a 17 m painted disc. */}
      {built.lilies.map((lily, i) => (
        <mesh
          key={`lily${i}`}
          position={[lily.across, -POND.surface + 0.02, lily.along]}
          rotation={[-Math.PI / 2, 0, lily.turn]}
          material={materials.lily}
          receiveShadow
        >
          <circleGeometry args={[0.55 * lily.scale, 7]} />
        </mesh>
      ))}

      {[...byPart].map(([part, at]) => (
        kit.get(part)?.map((pair, i) => (
          <Instanced
            key={`${part}${i}`}
            geometry={pair.geometry}
            material={pair.material}
            at={at}
            castShadow={!part.startsWith('bush')}
          />
        ))
      ))}

      {/* The basin is ground, and the crown it sits in has a hole in it — so
          without this a car that drove into the park would fall out of the
          world rather than into a pond. */}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[built.basin.vertices, built.basin.indices]} friction={0.9} />
      </RigidBody>
    </group>
  );
}
