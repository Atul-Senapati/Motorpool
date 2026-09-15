'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BufferGeometry, BoxGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute,
  InstancedMesh, Matrix4, RepeatWrapping, SRGBColorSpace, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import { TRAIN } from '@/config/trainConfig';
import { TOWN_PALETTE } from '@/config/townConfig';
import {
  BUILDINGS, ISLAND, LIGHTS, MARKS, OUTLINE, PAVING, PROP_PART, RUNWAY, SITE, TAXIWAY,
  TREE_PART, halfWidthAt, outlineShoelace,
} from '@/config/airportConfig';
import { collectCityParts, cityPartMatrix, type CityPart } from './cityChunks';

/**
 * Halcyon Field: the island east of the city, and everything on it.
 *
 * All of it is drawn inside one group at `SITE.centre` turned to
 * `SITE.heading`, so every number in `airportConfig` is a local one — +X down
 * the runway, +Z toward the landside. Local y = 0 is the crown, which is why
 * the beach reaches down to `seabed - ground` rather than to the seabed.
 *
 * ## What this reuses rather than models
 *
 * The brief was to lean on the city, and almost nothing here is new geometry:
 *
 *   the buildings   five chunks of the city lifted whole — a row of frontage
 *                   is a terminal, a wide two-storey block is a hangar, and
 *                   the one small building taller than it is broad is the
 *                   control tower. See `BUILDINGS`
 *   the planting    the city's own tree and its own piece of street furniture,
 *                   the same two `IslandTown` scatters round the station
 *   the ground      the railway islands' grass and sand, from `TOWN_PALETTE`,
 *                   so this reads as the same coast rather than a new one
 *
 * What is actually modelled here is the flat stuff, which is boxes: tarmac,
 * paint and lamps. That is the cheap half of an airport and the half that
 * carries it.
 *
 * ## Cost
 *
 * Every static surface is merged to one geometry per material, so the whole
 * airfield — runway, taxiway, links, two aprons, the roads and the car park —
 * is one draw call, the paint is two more, and the lights are four. The
 * buildings are one instanced call per distinct chunk, which for six buildings
 * out of five parts is five.
 */

/** Where the paving sits over the crown, and the paint over the paving. */
const TARMAC_TOP = 0.06;
const MARK_TOP = TARMAC_TOP + 0.012;
const SLAB = 0.5;

/** The beach's outer edge, in the island's own frame. */
const BEACH_BOTTOM = TRAIN.seabed - SITE.ground;

/** A flat slab: `[fromX, toX, fromZ, toZ]`, top at `top`. */
function slab(rect: readonly [number, number, number, number], top: number): BoxGeometry {
  const [x0, x1, z0, z1] = rect;
  const g = new BoxGeometry(Math.abs(x1 - x0), SLAB, Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, top - SLAB / 2, (z0 + z1) / 2);
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry | null {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Tarmac, as a canvas.
 *
 * The same idea as the town's: a flat grey surface a hundred metres across is
 * a colour, not a material, and what tells the eye it is asphalt is the grain
 * rather than the shade. Drawn once at 128 px and repeated.
 */
function makeTarmac(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#3b3d40';
    ctx.fillRect(0, 0, 128, 128);
    let seed = 11;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    for (let i = 0; i < 2600; i++) {
      const g = 40 + Math.floor(rnd() * 34);
      ctx.fillStyle = `rgb(${g},${g + 2},${g + 4})`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 1.4, 1.4);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(70, 70);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ------------------------------------------------------------------ the land */

/**
 * The island itself: a crown fan and a beach skirt, exactly as the railway's
 * islands are built (`TrainLine.buildIslands`).
 *
 * The outer ring of the beach goes *below* the waterline deliberately. Stopped
 * at sea level it leaves a rim of coplanar z-fighting; carried under, the water
 * plane cuts it and the sand reads as shelving into the sea.
 */
function buildLand() {
  const n = OUTLINE.length;
  const crown: number[] = [0, 0, 0];
  const crownIndex: number[] = [];
  for (const [x, z] of OUTLINE) crown.push(x, 0, z);
  for (let i = 0; i < n; i++) crownIndex.push(0, 1 + i, 1 + ((i + 1) % n));

  const beach: number[] = [];
  const beachIndex: number[] = [];
  for (const [x, z] of OUTLINE) {
    const len = Math.hypot(x, z) || 1;
    beach.push(x, 0, z);
    beach.push(x + (x / len) * ISLAND.shore, BEACH_BOTTOM, z + (z / len) * ISLAND.shore);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    beachIndex.push(a, a + 1, b + 1, a, b + 1, b);
  }

  const make = (positions: number[], indices: number[]) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return { geometry, vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
  };
  return { crown: make(crown, crownIndex), beach: make(beach, beachIndex) };
}

/* ------------------------------------------------------------- the pavements */

function buildPaving() {
  const parts: BufferGeometry[] = [];
  const R = RUNWAY;
  const T = TAXIWAY;
  parts.push(slab([-R.half, R.half, R.centre - R.width / 2, R.centre + R.width / 2], TARMAC_TOP));
  parts.push(slab([-T.half, T.half, T.centre - T.width / 2, T.centre + T.width / 2], TARMAC_TOP));
  for (const at of T.links) {
    parts.push(slab([at - T.width / 2, at + T.width / 2, R.centre, T.centre], TARMAC_TOP));
  }
  for (const rect of [PAVING.apron, PAVING.hangarApron, PAVING.frontage, PAVING.gate,
    PAVING.hangarGate, PAVING.carPark]) {
    parts.push(slab(rect, TARMAC_TOP));
  }
  return merge(parts);
}

/**
 * The paint.
 *
 * Two geometries, because there are two colours: white for the runway, yellow
 * for everything a wheel is meant to follow on the ground. What is drawn is
 * the set a real strip carries and no more — thresholds, centreline, edges and
 * the two aiming points — because those four are what the eye reads as "runway"
 * and the rest is detail nobody sees from a boat.
 */
function buildMarks() {
  const white: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const R = RUNWAY;
  const T = TAXIWAY;
  const bar = (rect: readonly [number, number, number, number], to: BufferGeometry[]) =>
    to.push(slab(rect, MARK_TOP));

  // Thresholds: the piano keys, symmetrical about the centreline.
  const pitch = MARKS.thresholdWidth + MARKS.thresholdGap;
  for (const end of [-1, 1] as const) {
    const from = end * (R.half - 8);
    for (let i = 0; i < MARKS.thresholdBars; i++) {
      const off = (i + 0.5) * pitch;
      for (const side of [-1, 1] as const) {
        const z = R.centre + side * off;
        bar([from - end * MARKS.thresholdLength, from, z - MARKS.thresholdWidth / 2, z + MARKS.thresholdWidth / 2], white);
      }
    }
    // Aiming point: one long block each side of the centreline.
    const aim = end * MARKS.aimingAt;
    for (const side of [-1, 1] as const) {
      const z = R.centre + side * 9;
      bar([aim - MARKS.aimingLength / 2, aim + MARKS.aimingLength / 2, z - MARKS.aimingWidth / 2, z + MARKS.aimingWidth / 2], white);
    }
  }
  // Centreline, dashed, stopping short of the piano keys at each end.
  const reach = R.half - MARKS.thresholdLength - 30;
  for (let x = -reach; x < reach; x += MARKS.centreDash + MARKS.centreGap) {
    bar([x, Math.min(x + MARKS.centreDash, reach), R.centre - MARKS.centreWidth / 2, R.centre + MARKS.centreWidth / 2], white);
  }
  // Edge lines, solid, the full length.
  for (const side of [-1, 1] as const) {
    const z = R.centre + side * (R.width / 2 - 1.2);
    bar([-R.half, R.half, z - MARKS.edgeWidth / 2, z + MARKS.edgeWidth / 2], white);
  }
  // Taxiway centreline: continuous, and round each link — a taxiway line never
  // stops, which is the whole point of it.
  bar([-T.half, T.half, T.centre - 0.5, T.centre + 0.5], yellow);
  for (const at of T.links) {
    bar([at - 0.5, at + 0.5, R.centre, T.centre], yellow);
  }
  // Stand markings on the apron: six lead-in lines off the taxiway, each
  // ending in the stop bar an aircraft's nosewheel would be parked on.
  for (let i = 0; i < 6; i++) {
    const x = -190 + i * 78;
    bar([x - 0.5, x + 0.5, -46, 40], yellow);
    bar([x - 13, x + 13, 39, 40], yellow);
  }
  return { white: merge(white), yellow: merge(yellow) };
}

/** Lamp positions, by colour. */
function buildLights() {
  const edge: Array<[number, number]> = [];
  const threshold: Array<[number, number]> = [];
  const stop: Array<[number, number]> = [];
  const taxi: Array<[number, number]> = [];
  const R = RUNWAY;
  const T = TAXIWAY;
  const half = R.width / 2 + 2;
  for (let x = -R.half; x <= R.half + 0.1; x += LIGHTS.edgeSpacing) {
    edge.push([x, R.centre - half], [x, R.centre + half]);
  }
  // Green at the west threshold, red at the east stop end, plus an approach
  // line running out over the grass beyond each.
  for (let i = 0; i < 9; i++) {
    const z = R.centre - 20 + i * 5;
    threshold.push([-R.half, z]);
    stop.push([R.half, z]);
  }
  for (let d = LIGHTS.approachSpacing; d <= LIGHTS.approachLength; d += LIGHTS.approachSpacing) {
    threshold.push([-R.half - d, R.centre]);
    stop.push([R.half + d, R.centre]);
  }
  for (let x = -T.half; x <= T.half + 0.1; x += LIGHTS.edgeSpacing) {
    taxi.push([x, T.centre - T.width / 2 - 2], [x, T.centre + T.width / 2 + 2]);
  }
  return { edge, threshold, stop, taxi };
}

function Lamps({ at, colour }: { at: ReadonlyArray<readonly [number, number]>; colour: string }) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const m = new Matrix4();
    at.forEach(([x, z], i) => instanced.setMatrixAt(i, m.makeTranslation(x, 0.35, z)));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [at]);
  if (!at.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, at.length]}>
      <boxGeometry args={[0.55, 0.55, 0.55]} />
      <meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={1.6} roughness={0.5} />
    </instancedMesh>
  );
}

/* ---------------------------------------------------------------- the pieces */

const PART_NAMES = [...new Set(BUILDINGS.map((b) => b.part))].concat(TREE_PART, PROP_PART);

/** One instanced copy of a city chunk per placement. */
function Chunk({ part, at }: {
  part: CityPart | undefined;
  at: ReadonlyArray<{ x: number; z: number; turn: number }>;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !part) return;
    const m = new Matrix4();
    at.forEach((p, i) => instanced.setMatrixAt(i, cityPartMatrix(part, p.x, 0, p.z, p.turn, m)));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [part, at]);
  if (!part || !at.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[part.geometry, part.material as Material, at.length]}
      castShadow
      receiveShadow
    />
  );
}

/**
 * Trees and street furniture, landside only.
 *
 * Nothing is planted airside, and that is not decoration policy — a tree
 * beside a runway reads as a mistake, and the strip either side of the paving
 * is meant to be bare graded grass. So the scatter is confined to `z > 100`,
 * which is the far side of the frontage road from the apron.
 */
function scatter() {
  const trees: Array<{ x: number; z: number; turn: number }> = [];
  const props: Array<{ x: number; z: number; turn: number }> = [];
  let seed = 23;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };

  /** Clear of every building, with a margin for the chunk's own footprint. */
  const clear = (x: number, z: number) => !BUILDINGS.some(
    (b) => Math.abs(b.x - x) < 108 && Math.abs(b.z - z) < 38,
  );

  // A row on the seaward verge of the frontage road, between it and the apron.
  for (let x = -230; x <= 400; x += 26) {
    const z = 124 + rnd() * 3;
    if (!clear(x, z)) continue;
    trees.push({ x, z, turn: rnd() * Math.PI * 2 });
    if (trees.length % 3 === 0) props.push({ x: x + 3, z: z - 5, turn: rnd() * Math.PI * 2 });
  }
  // A band along the northern shore, filling the ground behind the buildings.
  for (let x = -430; x <= 400; x += 30) {
    for (let k = 0; k < 2; k++) {
      const z = 206 + k * 22 + rnd() * 8;
      // Inside the outline with room for the beach, and clear of the terminal.
      if (z > halfWidthAt(x) - 34 || !clear(x, z)) continue;
      trees.push({ x: x + rnd() * 10 - 5, z, turn: rnd() * Math.PI * 2 });
    }
  }
  return { trees, props };
}

/* ------------------------------------------------------------------- the lot */

export function AirportIsland() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);
  const parts = useMemo(() => collectCityParts(scene, PART_NAMES), [scene]);

  const built = useMemo(() => ({
    land: buildLand(),
    paving: buildPaving(),
    marks: buildMarks(),
    lights: buildLights(),
    scatter: scatter(),
  }), []);
  const tarmac = useMemo(() => makeTarmac(), []);

  // The same one-line report the city, the traffic and the fleet print. It is
  // the only way to tell a chunk that failed to resolve — a missing name gives
  // no error, just a building that is not there.
  useEffect(() => {
    if (!parts.size) return;
    const missing = PART_NAMES.filter((n) => !parts.has(n));
    // A positive shoelace means the crown's triangles face the seabed and the
    // island is invisible from above — see `OUTLINE`.
    const facing = outlineShoelace() < 0 ? '' : ' — OUTLINE WOUND INSIDE OUT';
    console.info(`[airport] ${BUILDINGS.length} buildings from ${parts.size} city chunks, `
      + `${built.scatter.trees.length} trees`
      + (missing.length ? ` — MISSING ${missing.join(', ')}` : '') + facing);
  }, [parts, built]);

  useEffect(() => () => {
    built.land.crown.geometry.dispose();
    built.land.beach.geometry.dispose();
    built.paving?.dispose();
    built.marks.white?.dispose();
    built.marks.yellow?.dispose();
    tarmac.dispose();
  }, [built, tarmac]);

  /** Placements grouped by chunk, so each distinct part is one instanced call. */
  const byPart = useMemo(() => {
    const map = new Map<string, Array<{ x: number; z: number; turn: number }>>();
    for (const b of BUILDINGS) {
      const list = map.get(b.part) ?? [];
      list.push({ x: b.x, z: b.z, turn: b.turn });
      map.set(b.part, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <group position={[SITE.centre[0], SITE.ground, SITE.centre[1]]} rotation={[0, SITE.heading, 0]}>
      {/* The land, in the railway islands' own grass and sand so the whole
          coast reads as one place — see `TOWN_PALETTE`. */}
      <mesh geometry={built.land.crown.geometry} receiveShadow>
        <meshStandardMaterial color={TOWN_PALETTE.grass} roughness={0.95} />
      </mesh>
      <mesh geometry={built.land.beach.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#b3a37c" roughness={0.95} side={DoubleSide} />
      </mesh>

      {built.paving && (
        <mesh geometry={built.paving} receiveShadow>
          <meshStandardMaterial map={tarmac} color="#8f929a" roughness={0.94} />
        </mesh>
      )}
      {built.marks.white && (
        <mesh geometry={built.marks.white}>
          <meshStandardMaterial color={MARKS.colour} roughness={0.8} />
        </mesh>
      )}
      {built.marks.yellow && (
        <mesh geometry={built.marks.yellow}>
          <meshStandardMaterial color={MARKS.taxiColour} roughness={0.8} />
        </mesh>
      )}

      <Lamps at={built.lights.edge} colour={LIGHTS.colours.edge} />
      <Lamps at={built.lights.threshold} colour={LIGHTS.colours.threshold} />
      <Lamps at={built.lights.stop} colour={LIGHTS.colours.stop} />
      <Lamps at={built.lights.taxi} colour={LIGHTS.colours.taxi} />

      {byPart.map(([name, at]) => (
        <Chunk key={name} part={parts.get(name)} at={at} />
      ))}
      <Chunk part={parts.get(TREE_PART)} at={built.scatter.trees} />
      <Chunk part={parts.get(PROP_PART)} at={built.scatter.props} />

      {/* The ground a car stands on, and a box round each building so it is
          solid rather than a picture. The paving is not a collider: it sits
          60 mm over the crown and a wheel rides the crown, exactly as the
          station town's streets do. */}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider
          args={[built.land.crown.vertices, built.land.crown.indices]}
          friction={1}
        />
        {BUILDINGS.map((b) => {
          const part = parts.get(b.part);
          if (!part) return null;
          return (
            <CuboidCollider
              key={b.label}
              args={[part.size[0] / 2, part.size[1] / 2, part.size[2] / 2]}
              position={[b.x, part.size[1] / 2, b.z]}
              rotation={[0, b.turn, 0]}
            />
          );
        })}
      </RigidBody>
    </group>
  );
}
