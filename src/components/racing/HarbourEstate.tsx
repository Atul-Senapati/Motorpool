'use client';

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CuboidCollider, CylinderCollider, RigidBody, TrimeshCollider, type RapierRigidBody,
} from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, Float32BufferAttribute, CircleGeometry, ClampToEdgeWrapping, CylinderGeometry, DoubleSide,
  Group, Material, Mesh, Object3D, PlaneGeometry, RepeatWrapping, RingGeometry, SRGBColorSpace, Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_REPEAT, ROAD_TOP } from '@/config/roadConfig';
import {
  APRON_Z0, CAR_PARK, CONTAINER, DOCK_CRANES, GANTRIES, HARBOUR_BUILDINGS, HARBOUR_CROSSING, HARBOUR_MODELS,
  HARBOUR_ROAD, LORRY_BAYS, PAVE, PLANT, PLANT_PADS, QUAY, ROAD_HALF, TERMINAL_BLOCKS, TERMINAL_GATE,
  TURNING, YARD_ROAD, harbourLive, kerbAt, shoreZAt, type HarbourBuilding,
  CROSSING_BAND, CROSSING_TOP, roadHeightAt, trunkDistance,
} from '@/config/harbourConfig';
import countryModels from '@/config/countryModelData.json';
import truckData from '@/config/truckData.json';
import { BRANCH_ROUTE, livePlayerRoute } from '@/config/pointwork';
import { trunkCentre, trunkSamples } from '@/config/islandRailConfig';
import { TRAIN } from '@/config/trainConfig';
import { useTexture } from '@react-three/drei';
import { GRASS_REPEAT, GRASS_TILE, prepareGrassTile } from './islandGrass';
import { trafficMachine, vehicleSize } from './WallOfDeath';
import { trainsOnLoop } from '@/physics/trainRegistry';
import { partColliders } from './partColliders';
import { type Board, Boards } from './StationForecourt';

/**
 * Halcyon Harbour — see `harbourConfig` for the plan and why it is where it
 * is. Drawn inside `IslandRail`, so x is along the line and z across it.
 *
 * Built here: the harbour road (the road kit's own surface swept along its
 * line, humped over the trunk), the level crossing's barriers, the quay slab
 * and its furniture, the container stacks, fences, lamps and the turning
 * circle. Reused: the dock cranes and yard gantries (`country.glb`), the
 * factory buildings, the lorries, and the park's trees.
 */

const ROAD_MODEL = '/models/roads.glb';
const COUNTRY_MODEL = '/models/country.glb';
const TRUCKS_MODEL = '/models/trucks.glb';
const PARK_MODEL = '/models/park.glb';
const VEHICLES_MODEL = '/models/vehicles.glb';
for (const url of [ROAD_MODEL, COUNTRY_MODEL, TRUCKS_MODEL, PARK_MODEL, VEHICLES_MODEL]) useGLTF.preload(url, DRACO_PATH);
for (const m of Object.values(HARBOUR_MODELS)) useGLTF.preload(m.model, DRACO_PATH);

const COUNTRY = countryModels.parts as Record<string, { size: number[] }>;
const TRUCKS = truckData as Record<string, { size: number[] }>;

const LIVERIES = ['#1f5f8b', '#b3372c', '#2f6b3a', '#d38a1c', '#6d6f73', '#e4e1d8', '#2a3f73'];

type V3 = [number, number, number];
interface Collider { half: V3; centre: V3; turn?: number }

/* --------------------------------------------------------------- textures */

/** A container's corrugated side, multiplied by the livery. */
function ribTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    g.fillStyle = '#ffffff';
    g.fillRect(i * 16, 0, 8, 64);
    g.fillStyle = '#c4c4c4';
    g.fillRect(i * 16 + 8, 0, 8, 64);
  }
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, 256, 3);
  g.fillRect(0, 61, 256, 3);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(4, 1);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * Terminal paving: big concrete panels with dark joints, each panel a slightly
 * different tone and speckled, so a 236 m slab does not read as one grey card.
 * One tile is four 6 m panels square.
 */
function pavingTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const cell = size / 4;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const v = 150 + Math.floor(rnd() * 22);
      g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      g.fillRect(i * cell, j * cell, cell, cell);
    }
  }
  for (let k = 0; k < 9000; k++) {
    const v = 110 + Math.floor(rnd() * 90);
    g.fillStyle = `rgba(${v},${v},${v - 4},0.35)`;
    g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  // Oil and tyre marks.
  for (let k = 0; k < 14; k++) {
    g.fillStyle = 'rgba(40,40,40,0.08)';
    g.beginPath();
    g.ellipse(rnd() * size, rnd() * size, 8 + rnd() * 30, 4 + rnd() * 12, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#5b5955';
  for (let i = 0; i <= 4; i++) {
    g.fillRect(i * cell - 1, 0, 2, size);
    g.fillRect(0, i * cell - 1, size, 2);
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ----------------------------------------------------------------- layout */

/** A box in the island frame, optionally turned about its own centre. */
function box(list: BufferGeometry[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, turn = 0) {
  const g = new BoxGeometry(sx, sy, sz);
  if (turn) g.rotateY(turn);
  list.push(g.translate(cx, cy, cz));
}

/** A flat rectangle at paving height, with UVs in world metres over the 24 m paving tile. */
function flatQuad(x0: number, x1: number, z0: number, z1: number): BufferGeometry {
  const g = new PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, PAVE, (z0 + z1) / 2);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 24, pos.getZ(i) / 24);
  return g;
}

function layout() {
  let seed = 41;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const concrete: BufferGeometry[] = [];
  const darkConcrete: BufferGeometry[] = [];
  const white: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const rubber: BufferGeometry[] = [];
  const fenceMesh: BufferGeometry[] = [];
  const grey: BufferGeometry[] = [];
  const lampHeads: BufferGeometry[] = [];
  const containers: BufferGeometry[][] = LIVERIES.map(() => []);
  const paved: BufferGeometry[] = [];
  const colliders: Collider[] = [];
  const trees: Array<{ part: string; x: number; z: number; scale: number; turn: number }> = [];
  const placed: Array<{ model: 'country' | 'truck'; name: string; x: number; z: number; turn: number }> = [];
  const placedCountry: Array<{ part: string; x: number; z: number; turn: number }> = [];
  const cars: Array<{ name: string; tint: string; x: number; z: number; turn: number }> = [];
  const solid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => colliders.push({
    half: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], centre: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
  });

  /* ----- the quay: one slab from the yard's landward fence to the berth face, down to the seabed ----- */
  const Q = QUAY;
  // The face and the two ends, below the paving, in the island's own sea-wall concrete.
  box(darkConcrete, (Q.x0 + Q.x1) / 2, (Q.seabed + PAVE) / 2 - 0.01, (Q.z0 + Q.face) / 2, Q.x1 - Q.x0, PAVE - Q.seabed - 0.02, Q.face - Q.z0);
  solid(Q.x0, Q.x1, -2, PAVE, Q.z0, Q.face);
  // The coping: a white-edged kerb along the face, and a yellow safety line a metre in.
  box(white, (Q.x0 + Q.x1) / 2, PAVE + 0.1, Q.face - 0.3, Q.x1 - Q.x0, 0.2, 0.6);
  box(yellow, (Q.x0 + Q.x1) / 2, PAVE + 0.012, Q.face - 1.4, Q.x1 - Q.x0, 0.02, 0.2);
  // Fenders on the face, bollards on the coping.
  for (let x = Q.x0 + 6; x < Q.x1 - 3; x += 9) box(rubber, x, -1.6, Q.face + 0.35, 1.4, 3.4, 0.7);
  for (let x = Q.x0 + 4; x < Q.x1; x += 16) {
    const g = new CylinderGeometry(0.32, 0.4, 0.8, 10);
    grey.push(g.translate(x, PAVE + 0.4, Q.face - 0.9));
    const cap = new CylinderGeometry(0.48, 0.48, 0.14, 10);
    grey.push(cap.translate(x, PAVE + 0.85, Q.face - 0.9));
  }
  // The dock cranes' rails.
  for (const z of DOCK_CRANES.rails) box(steel, (Q.x0 + Q.x1) / 2, PAVE + 0.03, z, Q.x1 - Q.x0 - 4, 0.06, 0.35);
  // The apron: an edge line along the stacks' side and two lanes, dashed.
  box(white, (Q.x0 + Q.x1) / 2, PAVE + 0.012, APRON_Z0, Q.x1 - Q.x0 - 4, 0.02, 0.15);
  for (const z of [APRON_Z0 + 9, APRON_Z0 + 18]) {
    for (let x = Q.x0 + 6; x < Q.x1 - 6; x += 9) box(white, x + 2.5, PAVE + 0.012, z, 5, 0.02, 0.18);
  }
  // The internal road inside the landward fence: edge lines and a dashed centre.
  box(white, (Q.x0 + Q.x1) / 2, PAVE + 0.012, YARD_ROAD.z1, Q.x1 - Q.x0 - 4, 0.02, 0.15);
  for (let x = Q.x0 + 4; x < Q.x1 - 6; x += 9) box(white, x + 2.5, PAVE + 0.012, (YARD_ROAD.z0 + YARD_ROAD.z1) / 2, 5, 0.02, 0.15);
  // Staff car park and lorry bays, painted.
  for (const P of [CAR_PARK, LORRY_BAYS]) {
    const rowDepth = P === CAR_PARK ? P.depth : P.x1 - P.x0;
    const rows = P === CAR_PARK ? [[P.x0, P.x0 + rowDepth], [P.x1 - rowDepth, P.x1]] : [[P.x0, P.x1]];
    for (const [a, b] of rows) {
      for (let z = P.z0; z <= P.z1 + 0.01; z += P.bay) box(white, (a + b) / 2, PAVE + 0.012, z, b - a, 0.02, 0.12);
    }
  }
  // Block outlines on the paving, under the stacks.
  for (const b of TERMINAL_BLOCKS) {
    const depth = b.rows * CONTAINER.rowPitch;
    for (const z of [b.z0 - 0.4, b.z0 + depth + 0.1]) box(white, (b.x0 + b.x1) / 2, PAVE + 0.012, z, b.x1 - b.x0 + 1, 0.02, 0.15);
    for (const x of [b.x0 - 0.5, b.x1 + 0.5]) box(white, x, PAVE + 0.012, b.z0 + depth / 2, 0.15, 0.02, depth + 0.6);
  }

  /* ----- container stacks ----- */
  const C = CONTAINER;
  const stack = (x: number, z: number, tiers: number, along: 'x' | 'z', livery?: number) => {
    for (let h = 0; h < tiers; h++) {
      const l = livery ?? Math.floor(rnd() * LIVERIES.length);
      const g = along === 'x'
        ? new BoxGeometry(C.length - 0.08, C.height - 0.03, C.width - 0.05)
        : new BoxGeometry(C.width - 0.05, C.height - 0.03, C.length - 0.08);
      containers[l].push(g.translate(x + (rnd() - 0.5) * 0.12, PAVE + C.height / 2 + h * C.height, z + (rnd() - 0.5) * 0.08));
    }
  };
  for (const b of TERMINAL_BLOCKS) {
    const bays = Math.floor((b.x1 - b.x0) / C.bayPitch);
    for (let r = 0; r < b.rows; r++) {
      const z = b.z0 + C.rowPitch * (r + 0.5);
      let tallest = 0;
      for (let k = 0; k < bays; k++) {
        const x = b.x0 + C.bayPitch * (k + 0.5);
        const tiers = rnd() < 0.08 ? 0 : 1 + Math.floor(rnd() * 4);
        tallest = Math.max(tallest, tiers);
        stack(x, z, tiers, 'x');
      }
      if (tallest) solid(b.x0, b.x0 + bays * C.bayPitch, 0, tallest * C.height, z - C.width / 2, z + C.width / 2);
    }
  }
  // The plant's pads, paved in 6 m strips that stop short of the sea wall.
  for (const d of PLANT_PADS) {
    for (let x = d.x0; x < d.x1; x += 6) {
      const top = Math.min(d.z1, shoreZAt(x) - 1.5, shoreZAt(x + 6) - 1.5);
      if (top > d.z0) paved.push(flatQuad(x, Math.min(x + 6, d.x1), d.z0, top));
    }
  }
  for (const item of PLANT) {
    placedCountry.push(item);
    const size = COUNTRY[item.part]?.size ?? [4, 4, 4];
    colliders.push({ half: [size[0] / 2, size[1] / 2, size[2] / 2], centre: [item.x, size[1] / 2, item.z], turn: item.turn });
  }

  /* ----- the gate: paving from the road's kerb into the yard, a gatehouse and two booms ----- */
  const G = TERMINAL_GATE;
  const kerb = kerbAt(G.x);
  paved.push(flatQuad(G.x - G.width / 2, G.x + G.width / 2, kerb - 1, Q.z0));
  solid(G.x - G.width / 2, G.x + G.width / 2, -1, PAVE, kerb - 1, Q.z0);
  // The gatehouse on an island in the middle, in and out lanes either side.
  box(concrete, G.x, PAVE + 0.1, Q.z0 + 3, 2.4, 0.2, 8);
  box(grey, G.x, PAVE + 1.5, Q.z0 + 3, 2, 2.6, 3.2);
  box(steel, G.x, PAVE + 3.0, Q.z0 + 3, 3.4, 0.25, 6);
  solid(G.x - 1.2, G.x + 1.2, 0, 3, Q.z0 - 1, Q.z0 + 7);
  for (const k of [-1, 1]) {
    box(yellow, G.x + k * 1.4, PAVE + 0.55, Q.z0 - 0.2, 0.3, 1.1, 0.3);
    // Booms raised: the gate stands open.
    box(white, G.x + k * 1.4, PAVE + 3.3, Q.z0 - 0.2, 0.12, 4.4, 0.12);
  }

  /* ----- fences: the terminal's landward edge and ends, and the railway side of the road ----- */
  const fenceRun = (x0: number, z0: number, x1: number, z1: number, height: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.5) return;
    const turn = -Math.atan2(z1 - z0, x1 - x0);
    box(fenceMesh, (x0 + x1) / 2, height / 2, (z0 + z1) / 2, len, height, 0.04, turn);
    box(steel, (x0 + x1) / 2, height - 0.04, (z0 + z1) / 2, len, 0.06, 0.06, turn);
    const posts = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= posts; i++) {
      const f = i / posts;
      box(steel, x0 + (x1 - x0) * f, height / 2, z0 + (z1 - z0) * f, 0.08, height, 0.08);
    }
    colliders.push({ half: [len / 2, height / 2, 0.1], centre: [(x0 + x1) / 2, height / 2, (z0 + z1) / 2], turn });
  };
  fenceRun(Q.x0, Q.z0, G.x - G.width / 2, Q.z0, 2.4);
  fenceRun(G.x + G.width / 2, Q.z0, Q.x1, Q.z0, 2.4);
  fenceRun(Q.x0, Q.z0, Q.x0, Q.face - 1, 2.4);
  fenceRun(Q.x1, Q.z0, Q.x1, Q.face - 1, 2.4);
  {
    // Lineside: a palisade a metre and a half off the road's railway kerb,
    // broken for the crossing.
    const R = HARBOUR_ROAD;
    const off = -(ROAD_HALF + 1.6);
    let prev: { x: number; z: number } | null = null;
    for (let i = 0; i < R.length; i += 5) {
      const s = R[i];
      const p0 = { x: s.x + s.nx * off, z: s.z + s.nz * off };
      const clear = trunkDistance(p0.x, p0.z) > CROSSING_BAND + HARBOUR_CROSSING.ramp + 3
        && s.z > 300 && Math.hypot(s.x - TURNING.x, s.z - TURNING.z) > TURNING.radius + 6;
      const p = { x: s.x + s.nx * off, z: s.z + s.nz * off };
      if (clear && prev) fenceRun(prev.x, prev.z, p.x, p.z, 1.8);
      prev = clear ? p : null;
    }
  }

  /* ----- lamps along the road, both sides, staggered ----- */
  {
    const R = HARBOUR_ROAD;
    let side = 1;
    for (let i = 10; i < R.length - 4; i += 16) {
      const s = R[i];
      const off = side * (ROAD_HALF - 0.6);
      const x = s.x + s.nx * off;
      const z = s.z + s.nz * off;
      if (trunkDistance(x, z) < CROSSING_BAND + HARBOUR_CROSSING.ramp + 2) continue;
      box(steel, x, 4.5, z, 0.16, 9, 0.16);
      // Arm out over the carriageway, and the head.
      box(steel, x - s.nx * side * 1.1, 8.9, z - s.nz * side * 1.1, 0.1 + Math.abs(s.nx) * 2.2, 0.1, 0.1 + Math.abs(s.nz) * 2.2);
      box(lampHeads, x - s.nx * side * 2.1, 8.8, z - s.nz * side * 2.1, 0.5, 0.12, 0.5);
      solid(x - 0.15, x + 0.15, 0, 9, z - 0.15, z + 0.15);
      side = -side;
    }
  }
  // Floodlight masts in the terminal.
  // At the stack blocks' corners on the apron side, clear of every lane and of the gantries' runs.
  for (const [x, z] of [
    ...TERMINAL_BLOCKS.flatMap((b) => [[b.x0 - 1.5, APRON_Z0 - 2], [b.x1 + 1.5, APRON_Z0 - 2]]),
  ] as Array<[number, number]>) {
    box(steel, x, 12.5, z, 0.5, 25, 0.5);
    box(steel, x, 25.2, z, 3.2, 0.3, 1.2);
    for (const k of [-1, 0, 1]) box(lampHeads, x + k * 1.05, 25.0, z, 0.8, 0.12, 0.9);
    solid(x - 0.4, x + 0.4, 0, 25, z - 0.4, z + 0.4);
  }

  /* ----- seafront walk, where the strip narrows: a railing along the sea wall, benches, trees ----- */
  for (let x = -66; x < 64; x += 3) {
    const z0 = shoreZAt(x) - 0.7;
    const z1 = shoreZAt(x + 3) - 0.7;
    if (z0 - kerbAt(x) < 1.5) continue;
    box(steel, x, 1.05, z0, 0.06, 0.06, 0.06);
    box(steel, x + 1.5, 1.05, (z0 + z1) / 2, 3.02, 0.06, 0.06, -Math.atan2(z1 - z0, 3));
    box(steel, x, 0.55, z0, 0.06, 1.1, 0.06);
  }
  for (const x of [-48, -20, 36]) {
    const z = Math.min(shoreZAt(x) - 2.6, kerbAt(x) + 3);
    if (z - kerbAt(x) < 1.6) continue;
    box(grey, x, 0.45, z, 1.8, 0.08, 0.5);
    box(grey, x, 0.75, z + 0.24, 1.8, 0.5, 0.06);
  }
  for (const [x, z, part] of [
    [-62, 0, 'treeBroad'], [-34, 0, 'treeSlim'], [48, 0, 'treeBroad'], [58, 0, 'treeTall'],
    [-395, 0, 'treeBig'], [-375, 0, 'treeBroad'], [320, 0, 'treeBroad'], [340, 0, 'treeTall'],
    [360, 0, 'treeBig'], [385, 0, 'treeSlim'], [410, 0, 'treeBroad'], [130, 0, 'treeSlim'],
  ] as Array<[number, number, string]>) {
    // Between the kerb (or the rail toe past the road's end) and the shore, in the middle.
    const inner = x > TURNING.x + 10 ? 352 : x < -380 ? 360 : kerbAt(x);
    const zz = z || (inner + shoreZAt(x)) / 2;
    if (shoreZAt(x) - inner < 7) continue;
    trees.push({ part, x, z: zz, scale: 0.7 + rnd() * 0.3, turn: rnd() * Math.PI * 2 });
  }

  /* ----- lorries: under the cranes, in the lanes, and at the works ----- */
  const truck = (name: string, model: 'country' | 'truck', x: number, z: number, turn: number) => {
    placed.push({ model, name, x, z, turn });
    const size = model === 'truck' ? TRUCKS[name].size : COUNTRY[name].size;
    colliders.push({ half: [size[0] / 2, size[1] / 2, size[2] / 2], centre: [x, PAVE + size[1] / 2, z], turn });
  };
  // Under the cranes, between their rails, waiting on the ship.
  const underCranes = (DOCK_CRANES.rails[0] + DOCK_CRANES.rails[1]) / 2;
  truck('artic', 'truck', -246, underCranes, -Math.PI / 2);
  truck('artic', 'country', -196, underCranes, -Math.PI / 2);
  // Lorries backed into the bays at the west end.
  for (const [k, name, model] of [[1, 'artic', 'truck'], [3, 'artic', 'country'], [4, 'lorryCab', 'country']] as Array<[number, string, 'truck' | 'country']>) {
    const L = LORRY_BAYS;
    truck(name, model, (L.x0 + L.x1) / 2, L.z0 + L.bay * (k + 0.5), Math.PI / 2);
  }
  // Staff cars in the car park, nose in.
  {
    const P = CAR_PARK;
    const bodies = ['Hatchback_Body', 'Sedan_Body', 'Compact_Body', 'Wagon_Body', 'SUV_Body', 'minivan_body'];
    const paint = ['#e9e9e6', '#c7c9cc', '#2b2d30', '#7b1f24', '#1f3b6e', '#5d6468'];
    for (const [x, nose] of [[P.x0 + P.depth / 2, 1], [P.x1 - P.depth / 2, -1]] as Array<[number, number]>) {
      for (let z = P.z0 + P.bay / 2; z < P.z1; z += P.bay) {
        if (rnd() > 0.55) continue;
        const name = bodies[Math.floor(rnd() * bodies.length)];
        const turn = nose * Math.PI / 2 + (rnd() - 0.5) * 0.05;
        cars.push({ name, tint: paint[Math.floor(rnd() * paint.length)], x, z, turn });
        const sz = vehicleSize(name);
        colliders.push({ half: [sz[0] / 2, sz[1] / 2, sz[2] / 2], centre: [x, PAVE + sz[1] / 2, z], turn });
      }
    }
  }

  /* ----- a sign at the gate ----- */
  const boards: Board[] = [
    { kind: 'fascia', x: G.x + G.width / 2 + 5, y: 3.2, z: kerb + 2.2, turn: Math.PI, w: 9, h: 1.4, text: 'Halcyon Harbour · Container Terminal' },
    { kind: 'fascia', x: 150, y: 3.2, z: kerbAt(150) + 1.8, turn: Math.PI, w: 7, h: 1.3, text: 'Halcyon Works' },
  ];
  for (const b of boards) for (const k of [-1, 1]) box(steel, b.x + k * (b.w / 2 - 0.3), 1.9, b.z + 0.05, 0.1, 3.8, 0.1);

  const merge = (list: BufferGeometry[]) => (
    list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
  );
  return {
    concrete: merge(concrete), darkConcrete: merge(darkConcrete), white: merge(white), yellow: merge(yellow),
    steel: merge(steel), rubber: merge(rubber), fence: merge(fenceMesh), grey: merge(grey), lampHeads: merge(lampHeads),
    containers: containers.map(merge), paved: merge(paved), colliders, trees, placed, placedCountry, cars, boards,
  };
}

/* ------------------------------------------------------------------- road */

/** A triangle list into a geometry with vertex normals; optional UVs. */
function mesh(pos: number[], idx: number[], uv?: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Across-the-road vertices per sample: enough for the skewed crest to be a crest. */
const ACROSS = 17;

/**
 * The road: the kit's surface swept along its samples, every vertex at
 * `roadHeightAt` — so over the railway the crest lies parallel to the rails.
 * Beside the raised part, a concrete lip where the tracks run alongside and a
 * grass bank everywhere else.
 */
function buildRoad() {
  const R = HARBOUR_ROAD;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const s of R) {
    for (let j = 0; j < ACROSS; j++) {
      const off = -ROAD_HALF + (2 * ROAD_HALF * j) / (ACROSS - 1);
      const x = s.x + s.nx * off;
      const z = s.z + s.nz * off;
      pos.push(x, roadHeightAt(x, z), z);
      uv.push(s.arc / ROAD_REPEAT, j / (ACROSS - 1));
    }
  }
  for (let i = 0; i + 1 < R.length; i++) {
    for (let j = 0; j + 1 < ACROSS; j++) {
      const a = i * ACROSS + j;
      const b = a + ACROSS;
      // Facing up: the offset runs right to left of the direction of travel.
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const top = mesh(pos, idx, uv);
  top.computeBoundingSphere();

  const lip: number[] = [];
  const bank: number[] = [];
  const bankUv: number[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i + 1 < R.length; i++) {
      const edge = (s: (typeof R)[number]) => {
        const x = s.x + s.nx * side * ROAD_HALF;
        const z = s.z + s.nz * side * ROAD_HALF;
        return { x, z, y: roadHeightAt(x, z), s };
      };
      const e0 = edge(R[i]);
      const e1 = edge(R[i + 1]);
      if (e0.y < ROAD_TOP + 0.02 && e1.y < ROAD_TOP + 0.02) continue;
      const nearRails = Math.min(trunkDistance(e0.x, e0.z), trunkDistance(e1.x, e1.z)) < CROSSING_BAND + 1.2;
      if (nearRails) {
        // The panel's edge, straight down to the ballast.
        lip.push(e0.x, e0.y, e0.z, e1.x, e1.y, e1.z, e1.x, 0.45, e1.z);
        lip.push(e0.x, e0.y, e0.z, e1.x, 0.45, e1.z, e0.x, 0.45, e0.z);
      } else {
        const out = (e: typeof e0) => {
          const w = 0.25 + 2.4 * Math.max(0, e.y - ROAD_TOP);
          return [e.x + e.s.nx * side * w, 0.01, e.z + e.s.nz * side * w];
        };
        const o0 = out(e0);
        const o1 = out(e1);
        const quad = [e0.x, e0.y, e0.z, e1.x, e1.y, e1.z, o1[0], o1[1], o1[2], e0.x, e0.y, e0.z, o1[0], o1[1], o1[2], o0[0], o0[1], o0[2]];
        bank.push(...quad);
        for (let k = 0; k < quad.length; k += 3) bankUv.push(quad[k] / GRASS_REPEAT, quad[k + 2] / GRASS_REPEAT);
      }
    }
  }
  const soup = (p: number[], u?: number[]) => {
    if (!p.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(p, 3));
    if (u) g.setAttribute('uv', new Float32BufferAttribute(u, 2));
    g.computeVertexNormals();
    return g;
  };
  return {
    top,
    vertices: new Float32Array(pos),
    indices: new Uint32Array(idx),
    lip: soup(lip),
    bank: soup(bank, bankUv),
  };
}

/**
 * The crossing's surface over the railway: concrete panels between and either
 * side of the rails, with a dark flangeway inside each rail, swept along the
 * two tracks themselves (so they follow the curve) and clipped to the road.
 */
function buildPanels() {
  const C = HARBOUR_CROSSING;
  const lo = C.x - ROAD_HALF;
  const hi = C.x + ROAD_HALF;
  const near = (q: { x: number; z: number }) => Math.hypot(q.x - C.x, q.z - C.z) < 40;
  /** One strip `[a, b]` across a line of samples, clipped to the road's x band. */
  const strip = (line: Array<{ x: number; z: number; nx: number; nz: number }>, a: number, b: number, y: number, uvScale?: number) => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const rows: Array<[number, number, number, number] | null> = line.map((q) => {
      // Offsets o along the normal for which lo <= x <= hi.
      let o0 = a;
      let o1 = b;
      if (Math.abs(q.nx) > 1e-6) {
        const t0 = (lo - q.x) / q.nx;
        const t1 = (hi - q.x) / q.nx;
        o0 = Math.max(o0, Math.min(t0, t1));
        o1 = Math.min(o1, Math.max(t0, t1));
      } else if (q.x < lo || q.x > hi) return null;
      return o1 > o0 ? [q.x + q.nx * o0, q.z + q.nz * o0, q.x + q.nx * o1, q.z + q.nz * o1] : null;
    });
    let arc = 0;
    for (let i = 0; i + 1 < rows.length; i++) {
      const r0 = rows[i];
      const r1 = rows[i + 1];
      arc += Math.hypot(line[i + 1].x - line[i].x, line[i + 1].z - line[i].z);
      if (!r0 || !r1) continue;
      const base = pos.length / 3;
      pos.push(r0[0], y, r0[1], r0[2], y, r0[3], r1[0], y, r1[1], r1[2], y, r1[3]);
      const s = uvScale ?? 1;
      uv.push(0, (arc - 2) / s, (b - a) / s, (arc - 2) / s, 0, arc / s, (b - a) / s, arc / s);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    return { pos, uv, idx };
  };
  const join = (parts: Array<{ pos: number[]; uv: number[]; idx: number[] }>) => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const p of parts) {
      const base = pos.length / 3;
      pos.push(...p.pos);
      uv.push(...p.uv);
      idx.push(...p.idx.map((i) => i + base));
    }
    return idx.length ? mesh(pos, idx, uv) : null;
  };
  const centre = trunkCentre().filter(near);
  const tracks = [trunkSamples(-1).filter(near), trunkSamples(1).filter(near)];
  const half = TRAIN.gauge / 2;
  const panels = join([strip(centre, -CROSSING_BAND, CROSSING_BAND, CROSSING_TOP + 0.004, 1.8)]);
  // Flangeways: a dark groove just inside each rail.
  const grooves = join(tracks.flatMap((t) => [
    strip(t, -half + 0.075, -half + 0.16, CROSSING_TOP + 0.008),
    strip(t, half - 0.16, half - 0.075, CROSSING_TOP + 0.008),
  ]));
  return { panels, grooves };
}

/** Crossing panels: pale concrete slabs with dark joints and an anti-slip speckle. */
function panelTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#b4b1aa';
  g.fillRect(0, 0, 256, 256);
  let seed = 9;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  for (let k = 0; k < 5000; k++) {
    const v = 140 + Math.floor(rnd() * 70);
    g.fillStyle = `rgba(${v},${v},${v - 6},0.5)`;
    g.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
  }
  g.fillStyle = '#4c4a46';
  g.fillRect(0, 0, 256, 4);
  g.fillRect(0, 0, 4, 256);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** The warning sign: a red-bordered triangle with a gate on it. */
function warningTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  const tri = (inset: number, colour: string) => {
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(128, 14 + inset * 1.9);
    g.lineTo(244 - inset * 1.6, 230 - inset);
    g.lineTo(12 + inset * 1.6, 230 - inset);
    g.closePath();
    g.fill();
  };
  tri(0, '#c4241b');
  tri(22, '#ffffff');
  // A gate: posts and a barred top rail.
  g.fillStyle = '#111111';
  g.fillRect(84, 120, 8, 76);
  g.fillRect(164, 120, 8, 76);
  g.fillRect(84, 128, 88, 10);
  g.fillRect(84, 156, 88, 8);
  for (let x = 98; x < 164; x += 16) g.fillRect(x, 128, 6, 66);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** The kit's straight-road material, wrapping along the road. */
function useKitSurface(scene: Object3D): Material | undefined {
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  return useMemo(() => {
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
    clone.polygonOffset = true;
    clone.polygonOffsetFactor = -1;
    return clone;
  }, [scene, maxAnisotropy]);
}

/* -------------------------------------------------------- level crossing */

const TRUNK_JOINT = (() => { const t = trunkCentre(); return t[t.length - 1].arc; })();
/** The crossing in the branch route's own metres, which is what the trains report. */
const CROSSING_B = BRANCH_ROUTE.branch + BRANCH_ROUTE.skylark + (TRUNK_JOINT - HARBOUR_CROSSING.trunkArc);

function crossingBusy(): boolean {
  const near = (head: number, dir: number, length: number, speed: number) => {
    const ahead = (CROSSING_B - head) * dir;
    if (ahead > 0 && speed < 0.2) return false;
    return ahead < 60 + speed * 8 && ahead > -(length + 12);
  };
  const p = livePlayerRoute;
  if (p.active && near(p.head, p.dir, p.length, p.speed)) return true;
  for (const t of trainsOnLoop()) {
    if (t.owner === 'player') continue;
    if (near(t.arc, t.direction, t.length, t.speed)) return true;
  }
  return false;
}

/**
 * Where each approach stops: the first point, coming toward the railway, at
 * which the whole width of the road is clear of the tracks by a couple of
 * metres. Measured across the road because the crossing is skewed — one kerb
 * reaches the rails a good eight metres before the other.
 */
const STOPS = (() => {
  const C = HARBOUR_CROSSING;
  const clearAt = (z: number) => Math.min(
    ...[-ROAD_HALF, 0, ROAD_HALF].map((w) => trunkDistance(C.x + w, z)),
  );
  return ([-1, 1] as const).map((k) => {
    let z = C.z;
    while (clearAt(z) < CROSSING_BAND + 2.5) z += k * 0.25;
    return { k, z };
  });
})();

/**
 * Barriers, lamps and crossbucks at the stops — a diagonal pair, each boom
 * across the half of the road coming toward it — with stop lines just before
 * them and a warning sign forty metres out. The road is straight north here,
 * so each approach is simply `z` and the posts stand on the traffic's left.
 */
function CrossingGates() {
  const C = HARBOUR_CROSSING;
  const posts = useMemo(() => STOPS.map(({ k, z }) => {
    // Coming from the south (k −1) the traffic heads +z and its left is −x.
    const left = k < 0 ? -1 : 1;
    const x = C.x + left * (ROAD_HALF + 0.6);
    return { k, x, z, left, road: roadHeightAt(C.x + left * ROAD_HALF * 0.5, z) };
  }), [C]);
  const lines = useMemo(() => {
    const quads: number[] = [];
    for (const { k, z } of STOPS) {
      const left = k < 0 ? -1 : 1;
      const zz = z + k * 1.2;
      // Across the approach half, kerb to centre line, on the surface.
      for (let i = 0; i < 8; i++) {
        const w0 = left * (ROAD_HALF * 0.72) * (i / 8);
        const w1 = left * (ROAD_HALF * 0.72) * ((i + 1) / 8);
        const p = (w: number, dz: number) => [C.x + w, roadHeightAt(C.x + w, zz + dz) + 0.012, zz + dz];
        const a0 = p(w0, -0.25); const a1 = p(w1, -0.25); const b0 = p(w0, 0.25); const b1 = p(w1, 0.25);
        quads.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(quads, 3));
    g.computeVertexNormals();
    return g;
  }, [C]);
  const warning = useMemo(() => warningTexture(), []);
  const booms = useRef<(Group | null)[]>([]);
  const lamps = useRef<(Mesh | null)[]>([]);
  const down = useRef(0);
  const phase = useRef(0);
  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const target = crossingBusy() ? 1 : 0;
    down.current += (target - down.current) * (1 - Math.pow(0.5, delta / 0.6));
    phase.current += delta;
    booms.current.forEach((b) => { if (b) b.rotation.z = -(Math.PI / 2) * (1 - down.current); });
    const lit = down.current > 0.05;
    const flash = Math.floor(phase.current * 1.6) % 2 === 0;
    lamps.current.forEach((m, i) => { if (m) m.visible = lit && (i % 2 === 0 ? flash : !flash); });
  });
  return (
    <>
      <mesh geometry={lines}>
        <meshStandardMaterial color="#f2f2ee" roughness={0.7} side={DoubleSide} polygonOffset polygonOffsetFactor={-4} />
      </mesh>
      {posts.map((p, s) => (
        // Turned so local +z faces the traffic; the boom is mirrored to reach the road's middle.
        <group key={s} position={[p.x, 0, p.z]} rotation={[0, p.k < 0 ? Math.PI : 0, 0]}>
          <mesh position={[0, 2.0, 0]} castShadow>
            <boxGeometry args={[0.28, 4.0, 0.28]} />
            <meshStandardMaterial color="#d8d5cc" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.15, 0]}>
            <boxGeometry args={[0.9, 0.3, 0.9]} />
            <meshStandardMaterial color="#7d7a72" roughness={0.9} />
          </mesh>
          {/* The light unit: two red lamps under a black backboard, facing the traffic. */}
          <mesh position={[0, 3.25, 0.2]}>
            <boxGeometry args={[1.5, 0.75, 0.06]} />
            <meshStandardMaterial color="#16171a" roughness={0.7} />
          </mesh>
          {[-0.42, 0.42].map((x, i) => (
            <group key={x} position={[x, 3.25, 0.26]}>
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.2, 0.2, 0.08, 16]} />
                <meshStandardMaterial color="#3a1210" roughness={0.5} />
              </mesh>
              <mesh position={[0, 0, 0.05]} ref={(m) => { lamps.current[s * 2 + i] = m; }} visible={false}>
                <circleGeometry args={[0.17, 16]} />
                <meshBasicMaterial color="#ff2418" toneMapped={false} />
              </mesh>
              {/* The hood over each lamp. */}
              <mesh position={[0, 0.2, 0.1]}>
                <boxGeometry args={[0.46, 0.04, 0.22]} />
                <meshStandardMaterial color="#16171a" roughness={0.7} />
              </mesh>
            </group>
          ))}
          <group position={[0, 4.3, 0.2]}>
            {[1, -1].map((d) => (
              <mesh key={d} rotation={[0, 0, (d * Math.PI) / 4]} castShadow>
                <boxGeometry args={[1.8, 0.2, 0.04]} />
                <meshStandardMaterial color="#f2f0e8" roughness={0.6} />
              </mesh>
            ))}
          </group>
          {/* The boom, pivoting at the post, along local x toward the road's middle. */}
          <group position={[0, p.road + 1.05, 0]} ref={(g) => { booms.current[s] = g; }}>
            <group scale={[-p.left * (p.k < 0 ? -1 : 1), 1, 1]}>
              <mesh position={[4.9, 0, 0]} castShadow>
                <boxGeometry args={[9.6, 0.24, 0.14]} />
                <meshStandardMaterial color="#f0efe8" roughness={0.6} />
              </mesh>
              {[1.2, 3.2, 5.2, 7.2, 9.2].map((x) => (
                <mesh key={x} position={[x, 0, 0]}>
                  <boxGeometry args={[1.0, 0.25, 0.16]} />
                  <meshStandardMaterial color="#c0261c" roughness={0.6} />
                </mesh>
              ))}
              <mesh position={[4.9, -0.36, 0]}>
                <boxGeometry args={[9.2, 0.45, 0.04]} />
                <meshStandardMaterial color="#d8d5cc" roughness={0.8} transparent opacity={0.85} />
              </mesh>
            </group>
          </group>
        </group>
      ))}
      {/* Advance warning signs, forty metres out on the traffic's left. */}
      {posts.map((p, s) => (
        <group key={`w${s}`} position={[p.x - p.left * 0.4, 0, p.z + p.k * 40]} rotation={[0, p.k < 0 ? Math.PI : 0, 0]}>
          <mesh position={[0, 1.4, 0]}>
            <boxGeometry args={[0.09, 2.8, 0.09]} />
            <meshStandardMaterial color="#8a8d90" metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[0, 3.1, 0.06]}>
            <planeGeometry args={[1.3, 1.3]} />
            <meshStandardMaterial map={warning} transparent alphaTest={0.5} side={DoubleSide} />
          </mesh>
        </group>
      ))}
      {/* The relay cabinet. */}
      <group position={[C.x + ROAD_HALF + 4, 0, STOPS[1].z + 3]}>
        <mesh position={[0, 1.0, 0]} castShadow>
          <boxGeometry args={[1.9, 1.8, 1.0]} />
          <meshStandardMaterial color="#6d7a6a" metalness={0.3} roughness={0.7} />
        </mesh>
      </group>
    </>
  );
}

/* ----------------------------------------------------------------- cranes */

/** A model out of `country.glb`, placed and cloned. */
function useCountryPart(scene: Object3D, name: string): Object3D | null {
  return useMemo(() => {
    const source = scene.getObjectByName(name);
    if (!source) return null;
    const copy = source.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }, [scene, name]);
}

/**
 * One dock crane on the quay rails: the jib over the berth, travelling a few
 * metres along the quay while a ship is alongside, still when none is. Its
 * four legs are kinematic colliders that go with it.
 */
function DockCrane({ scene, x, index }: { scene: Object3D; x: number; index: number }) {
  const crane = useCountryPart(scene, 'dockCrane');
  const body = useRef<RapierRigidBody>(null);
  const group = useRef<Group>(null);
  const offset = useRef(0);
  const clock = useRef(index * 7.3);
  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    if (harbourLive.berthed) clock.current += delta;
    const want = harbourLive.berthed ? Math.sin(clock.current * 0.09 + index * 2.1) * DOCK_CRANES.travel : 0;
    offset.current += (want - offset.current) * (1 - Math.pow(0.5, delta / 3));
    const px = x + offset.current;
    group.current?.position.set(px, PAVE, DOCK_CRANES.originZ);
    body.current?.setNextKinematicTranslation({ x: px, y: PAVE, z: DOCK_CRANES.originZ });
  });
  if (!crane) return null;
  // The model's jib reaches −x and its portal stands at +x 1..9; a quarter
  // turn puts the jib over the water (+z) and the portal on the rails.
  return (
    <>
      <group ref={group} position={[x, PAVE, DOCK_CRANES.originZ]} rotation={[0, Math.PI / 2, 0]}>
        <primitive object={crane} />
      </group>
      <RigidBody ref={body} type="kinematicPosition" colliders={false} position={[x, PAVE, DOCK_CRANES.originZ]}>
        {[-4, 4].flatMap((dx) => [-1.4, -8.6].map((dz) => (
          <CuboidCollider key={`${dx}:${dz}`} args={[0.6, 6, 0.6]} position={[dx, 6, dz]} />
        )))}
      </RigidBody>
    </>
  );
}

/** A yard gantry, working up and down its line of blocks. */
function Gantry({ scene, z, from, to, phase }: { scene: Object3D; z: number; from: number; to: number; phase: number }) {
  const gantry = useCountryPart(scene, 'indGantry');
  const body = useRef<RapierRigidBody>(null);
  const group = useRef<Group>(null);
  useFrame((state) => {
    // A slow traverse with long pauses over the stacks: a smoothed triangle wave.
    const span = to - from;
    const period = (span * 2) / 0.9;
    const u = ((state.clock.elapsedTime / period + phase) % 1);
    const tri = u < 0.5 ? u * 2 : 2 - u * 2;
    const eased = tri * tri * (3 - 2 * tri);
    const x = from + span * eased;
    group.current?.position.set(x, PAVE, z);
    body.current?.setNextKinematicTranslation({ x, y: PAVE, z });
  });
  if (!gantry) return null;
  return (
    <>
      <group ref={group} position={[from, PAVE, z]}>
        <primitive object={gantry} />
      </group>
      <RigidBody ref={body} type="kinematicPosition" colliders={false} position={[from, PAVE, z]}>
        {[-3.9, 3.9].flatMap((dx) => [-10, 10].map((dz) => (
          <CuboidCollider key={`${dx}:${dz}`} args={[0.6, 3, 0.6]} position={[dx, 3, dz]} />
        )))}
      </RigidBody>
    </>
  );
}

/* ---------------------------------------------------------------- the lot */

function Building({ name, x, z, turn, index }: { name: HarbourBuilding; x: number; z: number; turn: number; index: number }) {
  const { scene } = useGLTF(HARBOUR_MODELS[name].model, DRACO_PATH);
  const copy = useMemo(() => {
    const c = (scene as unknown as Object3D).clone(true);
    c.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return c;
  }, [scene]);
  return (
    <>
      <group position={[x, 0, z]} rotation={[0, turn, 0]}>
        <primitive object={copy} />
      </group>
      <RigidBody type="fixed" colliders={false}>
        {partColliders(name, x, z, turn, HARBOUR_MODELS[name].size, `${name}-${index}`)}
      </RigidBody>
    </>
  );
}

export default function HarbourEstate() {
  const built = useMemo(() => layout(), []);
  const road = useMemo(() => buildRoad(), []);
  const panels = useMemo(() => buildPanels(), []);
  const panelMap = useMemo(() => panelTexture(), []);
  const grassTile = useTexture(GRASS_TILE);
  const grass = useMemo(() => prepareGrassTile(grassTile.clone()), [grassTile]);
  const roads = useGLTF(ROAD_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const country = useGLTF(COUNTRY_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const trucks = useGLTF(TRUCKS_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const park = useGLTF(PARK_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const surface = useKitSurface(roads);
  const ribs = useMemo(() => ribTexture(), []);
  const paving = useMemo(() => pavingTexture(), []);

  const yard = useMemo(() => flatQuad(QUAY.x0, QUAY.x1, QUAY.z0, QUAY.face), []);
  const turning = useMemo(() => ({
    disc: new CircleGeometry(TURNING.radius, 48).rotateX(-Math.PI / 2).translate(TURNING.x, ROAD_TOP + 0.004, TURNING.z),
    kerb: new RingGeometry(TURNING.radius, TURNING.radius + 2.6, 48).rotateX(-Math.PI / 2).translate(TURNING.x, ROAD_TOP + 0.03, TURNING.z),
  }), []);

  const objects = useMemo(() => built.placed.map((p) => {
    const source = (p.model === 'country' ? country : trucks).getObjectByName(p.name);
    if (!source) return null;
    const copy = source.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }), [built.placed, country, trucks]);
  const vehicles = useGLTF(VEHICLES_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const plant = useMemo(() => built.placedCountry.map((p) => {
    const source = country.getObjectByName(p.part);
    if (!source) return null;
    const copy = source.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }), [built.placedCountry, country]);
  const cars = useMemo(() => built.cars.map((c) => trafficMachine(vehicles, c.name, c.tint).root), [built.cars, vehicles]);
  const trees = useMemo(() => built.trees.map((tr) => {
    const node = park.getObjectByName(tr.part);
    if (!node) return null;
    const group = new Group();
    node.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const m = new Mesh(o.geometry, o.material);
      m.castShadow = true;
      group.add(m);
    });
    return group;
  }), [built.trees, park]);

  return (
    <group>
      {/* The road and its turning circle. */}
      {surface && <mesh geometry={road.top} material={surface} receiveShadow />}
      {road.lip && (
        <mesh geometry={road.lip} castShadow receiveShadow>
          <meshStandardMaterial color="#9a978f" roughness={0.9} side={DoubleSide} />
        </mesh>
      )}
      {road.bank && (
        <mesh geometry={road.bank} receiveShadow>
          <meshStandardMaterial map={grass} roughness={1} side={DoubleSide} />
        </mesh>
      )}
      {panels.panels && (
        <mesh geometry={panels.panels} receiveShadow>
          <meshStandardMaterial map={panelMap} roughness={0.85} side={DoubleSide} polygonOffset polygonOffsetFactor={-2} />
        </mesh>
      )}
      {panels.grooves && (
        <mesh geometry={panels.grooves}>
          <meshStandardMaterial color="#1c1c1c" roughness={0.9} side={DoubleSide} polygonOffset polygonOffsetFactor={-4} />
        </mesh>
      )}
      <mesh geometry={turning.disc} receiveShadow>
        <meshStandardMaterial color="#55585b" roughness={0.95} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={turning.kerb} receiveShadow>
        <meshStandardMaterial color="#b5b2aa" roughness={0.9} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <CrossingGates />

      {/* The terminal. */}
      <mesh geometry={yard} receiveShadow>
        <meshStandardMaterial map={paving} roughness={0.92} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      {built.paved && (
        <mesh geometry={built.paved} receiveShadow>
          <meshStandardMaterial map={paving} roughness={0.92} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      )}
      {built.darkConcrete && (
        <mesh geometry={built.darkConcrete} receiveShadow>
          <meshStandardMaterial color="#8c8a84" roughness={0.95} />
        </mesh>
      )}
      {built.concrete && (
        <mesh geometry={built.concrete} receiveShadow castShadow>
          <meshStandardMaterial color="#a8a59e" roughness={0.9} />
        </mesh>
      )}
      {built.white && (
        <mesh geometry={built.white}>
          <meshStandardMaterial color="#eeeeea" roughness={0.7} polygonOffset polygonOffsetFactor={-3} />
        </mesh>
      )}
      {built.yellow && (
        <mesh geometry={built.yellow} castShadow>
          <meshStandardMaterial color="#e6c227" roughness={0.6} polygonOffset polygonOffsetFactor={-3} />
        </mesh>
      )}
      {built.steel && (
        <mesh geometry={built.steel} castShadow>
          <meshStandardMaterial color="#3e4a52" roughness={0.45} metalness={0.5} />
        </mesh>
      )}
      {built.grey && (
        <mesh geometry={built.grey} castShadow receiveShadow>
          <meshStandardMaterial color="#6f7377" roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {built.rubber && (
        <mesh geometry={built.rubber}>
          <meshStandardMaterial color="#1b1b1b" roughness={0.95} />
        </mesh>
      )}
      {built.fence && (
        <mesh geometry={built.fence}>
          <meshStandardMaterial color="#2c3238" roughness={0.6} metalness={0.4} transparent opacity={0.35} depthWrite={false} side={DoubleSide} />
        </mesh>
      )}
      {built.lampHeads && (
        <mesh geometry={built.lampHeads}>
          <meshStandardMaterial color="#fff6dc" emissive="#ffe7b0" emissiveIntensity={0.9} />
        </mesh>
      )}
      {built.containers.map((g, i) => g && (
        <mesh key={i} geometry={g} castShadow receiveShadow>
          <meshStandardMaterial color={LIVERIES[i]} map={ribs} roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
      <Boards boards={built.boards} />

      {DOCK_CRANES.at.map((x, i) => <DockCrane key={x} scene={country} x={x} index={i} />)}
      {GANTRIES.map((g, i) => <Gantry key={i} scene={country} {...g} />)}
      {HARBOUR_BUILDINGS.map((b, i) => <Building key={i} index={i} {...b} />)}

      {built.placed.map((p, i) => objects[i] && (
        <group key={`${p.name}-${i}`} position={[p.x, PAVE, p.z]} rotation={[0, p.turn, 0]}>
          <primitive object={objects[i]!} />
        </group>
      ))}
      {built.placedCountry.map((p, i) => plant[i] && (
        <group key={`plant-${i}`} position={[p.x, PAVE, p.z]} rotation={[0, p.turn, 0]}>
          <primitive object={plant[i]!} />
        </group>
      ))}
      {built.cars.map((c, i) => (
        <group key={`car-${i}`} position={[c.x, PAVE, c.z]} rotation={[0, c.turn, 0]}>
          <primitive object={cars[i]} />
        </group>
      ))}
      {built.trees.map((tr, i) => trees[i] && (
        <group key={`tree-${i}`} position={[tr.x, 0, tr.z]} rotation={[0, tr.turn, 0]} scale={tr.scale}>
          <primitive object={trees[i]!} />
        </group>
      ))}

      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[road.vertices, road.indices]} friction={1} />
        <CylinderCollider args={[0.05, TURNING.radius + 2.6]} position={[TURNING.x, ROAD_TOP - 0.05, TURNING.z]} />
        {built.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.centre} rotation={[0, c.turn ?? 0, 0]} />
        ))}
      </RigidBody>
    </group>
  );
}
