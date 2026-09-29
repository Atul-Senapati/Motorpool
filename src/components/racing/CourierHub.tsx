'use client';

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, type BufferGeometry, CanvasTexture, Mesh, type Object3D, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import airportModels from '@/config/airportModelData.json';
import countryModels from '@/config/countryModelData.json';
import { COURIER_HUB as H, PF1_SPUR, STATION, pf1Spur, stationPlatforms } from '@/config/islandRailConfig';
import { TRAIN, freightFormation } from '@/config/trainConfig';
import truckData from '@/config/truckData.json';
import { type Board, Boards } from './StationForecourt';
import { trafficMachine, vehicleSize } from './WallOfDeath';

/**
 * The parcel hub (`COURIER_HUB`), in the airport island's frame — `x` along
 * the line, `z` across it — drawn inside `IslandRail` beside the station.
 *
 * Everything that can be is an existing model: the airport's cargo shed and
 * baggage carts (`airport.glb`), the Skylark island's site office, floodlight
 * masts, crates and skips (`country.glb`), the city's box truck and artic
 * (`trucks.glb`) and the traffic's vans and cars (`vehicles.glb`). What is built
 * here is the ground and what stands on it — the yard, the loading dock and
 * its canopy and shutters, the fence, the markings — and the shipping
 * containers, which the city has only as one merged mesh.
 */

const AIRPORT_MODEL = '/models/airport.glb';
const COUNTRY_MODEL = '/models/country.glb';
const TRUCKS_MODEL = '/models/trucks.glb';
const VEHICLES_MODEL = '/models/vehicles.glb';
const PARADE_MODEL = '/models/parade.glb';
const PARK_MODEL = '/models/park.glb';
useGLTF.preload(AIRPORT_MODEL, DRACO_PATH);

const TRUCKS = truckData as Record<string, { size: number[] }>;
const COUNTRY = countryModels.parts as Record<string, { size: number[] }>;
const AIRPORT = airportModels.parts as Record<string, { size: number[] }>;
const isTruck = (name: string) => name in TRUCKS;
/** `country:<part>` is one of the Skylark island's vehicles — its long artic and lorry cab — out of `country.glb`. */
const countryPart = (name: string) => (name.startsWith('country:') ? name.slice(8) : null);
/** `airport:<part>` is one of the airport's vehicles — its catering high-loader. */
const airportPart = (name: string) => (name.startsWith('airport:') ? name.slice(8) : null);
const sizeOf = (name: string) => {
  const part = countryPart(name);
  if (part) return COUNTRY[part].size;
  const ap = airportPart(name);
  if (ap) return AIRPORT[ap].size;
  return isTruck(name) ? TRUCKS[name].size : vehicleSize(name);
};
/**
 * The turn that points a vehicle's nose at −z: the city's lorries and the
 * airport's vehicles face +z (`prepare-airport` turns everything nose to +Z),
 * the traffic and the Skylark ones −z.
 */
const noseSouth = (name: string) => (isTruck(name) || airportPart(name) ? Math.PI : 0);
/** Which model a vehicle comes out of, and its node there. */
const source = (name: string): Pick<Placed, 'model' | 'name'> => {
  const part = countryPart(name);
  if (part) return { model: 'country', name: part };
  const ap = airportPart(name);
  if (ap) return { model: 'airport', name: ap };
  return { model: isTruck(name) ? 'truck' : 'vehicle', name };
};
/** Car paints for the staff cars; the vans and lorries keep their liveries. */
const PAINT = ['#e9e9e6', '#c7c9cc', '#2b2d30', '#7b1f24', '#1f3b6e', '#5d6468'];
const CAR_BODIES = new Set(['Hatchback_Body', 'Sedan_Body', 'Compact_Body', 'Wagon_Body', 'SUV_Body', 'Pickup_Body', 'minivan_body']);

/** Container liveries: the shipping lines' blue, red, green, orange and a plain grey. */
const LIVERIES = ['#1f5f8b', '#b3372c', '#2f6b3a', '#d38a1c', '#6d6f73', '#1f5f8b', '#b3372c'];

/** A container's corrugated side: light and dark ribs, multiplied by the livery. */
function ribTexture(): CanvasTexture {
  const w = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  const ribs = 16;
  for (let i = 0; i < ribs; i++) {
    const x = (i * w) / ribs;
    g.fillStyle = '#ffffff';
    g.fillRect(x, 0, w / ribs / 2, 64);
    g.fillStyle = '#c4c4c4';
    g.fillRect(x + w / ribs / 2, 0, w / ribs / 2, 64);
  }
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, w, 3);
  g.fillRect(0, 61, w, 3);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(4, 1);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Cladding: vertical ribs on a silver sheet, 2 m to a repeat — see `worldUV`. */
function claddingTexture(): CanvasTexture {
  const w = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = w;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#c9cdcf';
  g.fillRect(0, 0, w, w);
  const ribs = 8;
  for (let i = 0; i < ribs; i++) {
    const x = (i * w) / ribs;
    g.fillStyle = '#a9aeb2';
    g.fillRect(x, 0, 6, w);
    g.fillStyle = '#e0e3e4';
    g.fillRect(x + 6, 0, 3, w);
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** World-metre UVs over a 2 m repeat, so every wall's ribs are the same size: across a wall horizontally, up it vertically. */
function worldUV(g: BufferGeometry): BufferGeometry {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    const along = Math.abs(nrm.getX(i)) > 0.5 ? pos.getZ(i) : pos.getX(i);
    const up = Math.abs(nrm.getY(i)) > 0.5 ? pos.getZ(i) : pos.getY(i);
    uv.setXY(i, along / 2, up / 2);
  }
  uv.needsUpdate = true;
  return g;
}

interface Placed { model: 'airport' | 'country' | 'truck' | 'vehicle' | 'parade' | 'park'; name: string; x: number; y: number; z: number; turn: number; vehicle?: string; tint?: string }

function layout() {
  let seed = 23;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const asphalt: BufferGeometry[] = [];
  const concrete: BufferGeometry[] = [];
  const white: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const mesh: BufferGeometry[] = [];
  const rubber: BufferGeometry[] = [];
  const shutters: BufferGeometry[] = [];
  const canopy: BufferGeometry[] = [];
  const teal: BufferGeometry[] = [];
  const clad: BufferGeometry[] = [];
  const slate: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const darkGlass: BufferGeometry[] = [];
  const containers: BufferGeometry[][] = LIVERIES.map(() => []);
  const placed: Placed[] = [];
  const colliders: Array<{ centre: [number, number, number]; half: [number, number, number] }> = [];
  const box = (list: BufferGeometry[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    list.push(new BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
  };
  const solid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    colliders.push({ centre: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], half: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2] });
  };
  const lineX = (list: BufferGeometry[], x: number, z0: number, z1: number, w = 0.12) => box(list, x - w / 2, x + w / 2, 0.065, 0.085, z0, z1);
  const lineZ = (list: BufferGeometry[], z: number, x0: number, x1: number, w = 0.12) => box(list, x0, x1, 0.065, 0.085, z - w / 2, z + w / 2);
  const signs: Board[] = [];
  /**
   * A modern logistics building (`COURIER_HUB.depot`, `.workshop`): a clad
   * box on a slate plinth, a teal line under a dark parapet, rooflights and
   * roof plant on its flat roof, a glazed office at one end standing a metre
   * proud of the front, and roller shutters with little canopies along the
   * rest of the front, which faces −z.
   */
  const building = (b: { x: number; z: number; width: number; depth: number; height: number; doors: number; office: 'east' | 'west' | null; sign: string }) => {
    const x0 = b.x - b.width / 2;
    const x1 = b.x + b.width / 2;
    const z0 = b.z - b.depth / 2;
    const z1 = b.z + b.depth / 2;
    const h = b.height;
    clad.push(worldUV(new BoxGeometry(b.width, h, b.depth).translate(b.x, h / 2 + 0.06, b.z)));
    box(slate, x0 - 0.05, x1 + 0.05, 0.06, 1.1, z0 - 0.05, z1 + 0.05);
    box(slate, x0 - 0.12, x1 + 0.12, h + 0.06, h + 0.75, z0 - 0.12, z1 + 0.12);
    box(teal, x0 - 0.07, x1 + 0.07, h - 0.55, h - 0.4, z0 - 0.07, z1 + 0.07);
    solid(x0, x1, 0, h + 0.75, z0, z1);
    // Rooflights in strips, and a few plant boxes.
    for (let x = x0 + 4; x < x1 - 4; x += 8) box(glass, x, x + 3, h + 0.06, h + 0.3, z0 + 3, z1 - 3);
    for (let k = 0; k < Math.max(1, Math.round(b.width / 16)); k++) {
      const px = x0 + 6 + k * 14;
      box(shutters, px, px + 2.4, h + 0.06, h + 1.5, z1 - 4, z1 - 2.4);
    }
    // The glazed office end.
    let doorFrom = x0 + 1.5;
    let doorTo = x1 - 1.5;
    if (b.office) {
      const ow = Math.min(12, b.width * 0.3);
      const [ox0, ox1] = b.office === 'east' ? [x1 - ow, x1 + 0.4] : [x0 - 0.4, x0 + ow];
      box(darkGlass, ox0, ox1, 0.06, h + 0.3, z0 - 1.2, z0 + 1);
      for (let x = ox0; x <= ox1 + 0.01; x += (ox1 - ox0) / Math.round((ox1 - ox0) / 1.6)) box(steel, x - 0.05, x + 0.05, 0.06, h + 0.3, z0 - 1.26, z0 - 1.14);
      for (const y of [0.06, h / 2, h + 0.3]) box(steel, ox0, ox1, y - 0.08, y + 0.08, z0 - 1.26, z0 - 1.14);
      box(slate, ox0 - 0.1, ox1 + 0.1, h + 0.3, h + 0.75, z0 - 1.35, z0 + 1);
      // The way in: a canopy over the door.
      box(canopy, (ox0 + ox1) / 2 - 2.5, (ox0 + ox1) / 2 + 2.5, 3.2, 3.4, z0 - 3.4, z0 - 1.2);
      solid(ox0, ox1, 0, h + 0.75, z0 - 1.35, z0);
      if (b.office === 'east') doorTo = ox0 - 1.5; else doorFrom = ox1 + 1.5;
    }
    // Roller shutters, each in a slate frame with a short canopy over it.
    const dw = 4.2;
    const dh = Math.min(5, h - 2.5);
    for (let i = 0; i < b.doors; i++) {
      const cx = doorFrom + ((doorTo - doorFrom) * (i + 0.5)) / b.doors;
      box(slate, cx - dw / 2 - 0.25, cx + dw / 2 + 0.25, 0.06, dh + 0.3, z0 - 0.12, z0 - 0.02);
      box(shutters, cx - dw / 2, cx + dw / 2, 0.06, dh, z0 - 0.16, z0 - 0.1);
      for (let y = 0.5; y < dh; y += 0.5) box(steel, cx - dw / 2, cx + dw / 2, y - 0.015, y + 0.015, z0 - 0.18, z0 - 0.16);
      box(canopy, cx - dw / 2 - 0.4, cx + dw / 2 + 0.4, dh + 0.5, dh + 0.65, z0 - 1.6, z0);
    }
    signs.push({ kind: 'fascia', x: b.office === 'east' ? (doorFrom + doorTo) / 2 : b.x, y: h - 1.5, z: z0 - 0.15, turn: 0, w: Math.min(16, b.width * 0.6), h: 1.6, text: b.sign });
  };

  /* ----- the yard ----- */
  box(asphalt, H.west, H.east, -0.2, 0.06, H.bottom, H.top);
  // The verge is paved across the gate, so the crossroads' north arm runs straight in.
  box(asphalt, H.gate[0], H.gate[1], -0.2, 0.06, H.fence.z - 1.2, H.bottom);

  /* ----- the fence: steel palisade posts and rails, a dark mesh between ----- */
  const F = H.fence;

  const runZ = (x: number, z0: number, z1: number) => {
    const n = Math.max(1, Math.round((z1 - z0) / F.post));
    for (let i = 0; i <= n; i++) box(steel, x - 0.04, x + 0.04, 0, F.height, z0 + ((z1 - z0) * i) / n - 0.04, z0 + ((z1 - z0) * i) / n + 0.04);
    for (const y of [0.15, F.height - 0.1]) box(steel, x - 0.03, x + 0.03, y - 0.03, y + 0.03, z0, z1);
    box(mesh, x - 0.01, x + 0.01, 0.1, F.height - 0.05, z0, z1);
    solid(x - 0.1, x + 0.1, 0, F.height, z0, z1);
  };
  const runX = (z: number, x0: number, x1: number) => {
    const n = Math.max(1, Math.round((x1 - x0) / F.post));
    for (let i = 0; i <= n; i++) box(steel, x0 + ((x1 - x0) * i) / n - 0.04, x0 + ((x1 - x0) * i) / n + 0.04, 0, F.height, z - 0.04, z + 0.04);
    for (const y of [0.15, F.height - 0.1]) box(steel, x0, x1, y - 0.03, y + 0.03, z - 0.03, z + 0.03);
    box(mesh, x0, x1, 0.1, F.height - 0.05, z - 0.01, z + 0.01);
    solid(x0, x1, 0, F.height, z - 0.1, z + 0.1);
  };

  // The road side and the tracks only: the west is open to the station and
  // the east to the Wall of Death. Broken at both gates.
  runX(F.z, H.west + 0.5, H.gate[0] - 0.5);
  runX(F.z, H.gate[1] + 0.5, H.gate2[0] - 0.5);
  runX(F.z, H.gate2[1] + 0.5, H.east);
  // Along the tracks only past PF1's end; alongside it, the platform is the boundary.
  runX(H.top + 1.5, PF1_SPUR.platformTo, H.east);
  // And across the north end, between the yard and the Wall of Death's ground.
  runZ(H.east, F.z, H.top + 1.5);
  // Each gate: two posts and a barrier arm each way, raised; the verge paved across it.
  for (const [g0, g1] of [H.gate, H.gate2]) {
    for (const x of [g0 + 0.3, g1 - 0.3]) {
      box(steel, x - 0.2, x + 0.2, 0, 1.1, F.z - 0.2, F.z + 0.2);
      yellow.push(new BoxGeometry(0.12, 6, 0.12).rotateZ((x < g0 + 1 ? -1 : 1) * 0.12).translate(x, 1.1 + 3, F.z));
    }
    if (g0 !== H.gate[0]) box(asphalt, g0, g1, -0.2, 0.06, H.fence.z - 1.2, H.bottom);
  }

  /* ----- the shed, its dock, canopy and shutters ----- */
  const S = H.shed;
  placed.push({ model: 'airport', name: S.part, x: S.x, y: 0, z: S.z, turn: Math.PI / 2 });
  solid(S.x - S.length / 2, S.x + S.length / 2, 0, S.height, S.z - S.width / 2, S.z + S.width / 2);
  const D = H.dock;
  box(concrete, D.from, D.to, 0, D.height, D.z0, D.z1);
  box(yellow, D.from, D.to, D.height, D.height + 0.012, D.z0, D.z0 + 0.15);
  solid(D.from, D.to, 0, D.height, D.z0, D.z1);
  // Steps up onto the dock at its west end.
  for (let i = 0; i < 6; i++) box(concrete, D.from - 1.8 + i * 0.3, D.from, 0, (D.height * (i + 1)) / 6, D.z0 + 0.2, D.z0 + 1.6);
  // The canopy over the dock and the lorries' tails: slate steel on posts, a yellow safety lip.
  const cy = 5.4;
  box(canopy, D.from - 1, D.to + 1, cy, cy + 0.25, D.z0 - 2.4, D.z1 - 0.2);
  box(yellow, D.from - 1, D.to + 1, cy + 0.05, cy + 0.12, D.z0 - 2.45, D.z0 - 2.4);
  const B = H.dockBays;
  for (let i = 0; i <= B.count; i++) {
    const x = D.from + ((D.to - D.from) * i) / B.count;
    if (i % 2 === 0) box(steel, x - 0.1, x + 0.1, D.height, cy, D.z0 + 0.1, D.z0 + 0.3);
    // The bay lines on the apron, and a pair of black bumpers on the dock face.
    lineX(white, x, D.z0 - B.depth, D.z0);
  }
  for (let i = 0; i < B.count; i++) {
    const x0 = D.from + ((D.to - D.from) * i) / B.count;
    const x1 = D.from + ((D.to - D.from) * (i + 1)) / B.count;
    const xc = (x0 + x1) / 2;
    for (const k of [-1, 1]) box(rubber, xc + k * 1.1 - 0.15, xc + k * 1.1 + 0.15, 0.4, 1.0, D.z0 - 0.12, D.z0);
    // A roller shutter in the shed wall behind each bay.
    box(shutters, xc - 1.5, xc + 1.5, D.height, D.height + 3.6, D.z1 - 0.05, D.z1 + 0.02);
    const name = H.fleet[i];
    if (!name) {
      continue;
    }
    const length = sizeOf(name)[2];
    placed.push({
      ...source(name), vehicle: name,
      x: xc + (rnd() - 0.5) * 0.3, y: 0.06, z: D.z0 - 0.35 - length / 2, turn: noseSouth(name) + (rnd() - 0.5) * 0.03,
    });
  }
  lineZ(yellow, D.z0 - B.depth, D.from, D.to, 0.15);

  /* ----- the van park, west of the gate: nose in to the fence ----- */
  const V = H.vans;
  // A mix, and never the same twice running.
  const vanNames = ['postvan', 'rdservtruck', 'minivan_body', 'Pickup_Body', 'postvan', 'Wagon_Body', 'SUV_Body'];
  let last = '';
  for (let x = V.from; x + V.width <= V.to; x += V.width) {
    lineX(white, x, V.z[0], V.z[1]);
    lineX(white, x + V.width, V.z[0], V.z[1]);
    if (rnd() > V.fill) continue;
    let name = vanNames[Math.floor(rnd() * vanNames.length)];
    if (name === last) name = vanNames[(vanNames.indexOf(name) + 1) % vanNames.length];
    last = name;
    placed.push({ model: 'vehicle', name, vehicle: name, x: x + V.width / 2 + (rnd() - 0.5) * 0.3, y: 0.06, z: V.z[0] + 0.3 + sizeOf(name)[2] / 2, turn: (rnd() - 0.5) * 0.06 });
  }
  // Chargers for the electric vans, on every other bay line: a slate post with a teal light.
  for (let x = V.from; x <= V.to; x += V.width * 2) {
    box(steel, x - 0.18, x + 0.18, 0, 1.5, V.z[0] + 0.1, V.z[0] + 0.4);
    box(teal, x - 0.12, x + 0.12, 1.1, 1.35, V.z[0] + 0.41, V.z[0] + 0.43);
    solid(x - 0.18, x + 0.18, 0, 1.5, V.z[0] + 0.1, V.z[0] + 0.4);
  }
  // A speed bump across each way in, yellow and black.
  for (const [g0, g1] of [H.gate, H.gate2]) {
    for (let k = 0; k < 10; k++) {
      const x0 = g0 + ((g1 - g0) * k) / 10;
      box(k % 2 ? rubber : yellow, x0, x0 + (g1 - g0) / 10, 0.06, 0.14, H.bottom + 8, H.bottom + 8.6);
    }
  }

  /* ----- the second van row, with a few staff cars, never the same twice running ----- */
  const V2 = H.vans2;
  const mix = ['rdservtruck', 'country:siteLorry', 'Hatchback_Body', 'postvan', 'Sedan_Body', 'towtruck', 'Compact_Body', 'minivan_body'];
  let prev2 = '';
  for (let x = V2.from; x + V2.width <= V2.to; x += V2.width) {
    lineX(white, x, V2.z[0], V2.z[1]);
    lineX(white, x + V2.width, V2.z[0], V2.z[1]);
    if (rnd() > V2.fill) continue;
    let name = mix[Math.floor(rnd() * mix.length)];
    if (name === prev2) name = mix[(mix.indexOf(name) + 1) % mix.length];
    prev2 = name;
    // A lorry needs two bays.
    const wide = sizeOf(name)[0] > 2.4 && name.startsWith('country:');
    const xc = x + (wide ? V2.width : V2.width / 2);
    placed.push({
      ...source(name), vehicle: name, tint: CAR_BODIES.has(name) ? PAINT[Math.floor(rnd() * PAINT.length)] : undefined,
      x: xc + (rnd() - 0.5) * 0.3, y: 0.06, z: V2.z[0] + 0.3 + sizeOf(name)[2] / 2, turn: noseSouth(name) + (rnd() - 0.5) * 0.06,
    });
    if (wide) x += V2.width;
  }

  /* ----- the fuel and charging canopy past the north gate ----- */
  {
    const Fu = H.fuel;
    const [z0, z1] = Fu.z;
    box(concrete, Fu.from, Fu.to, 0.06, 0.2, z0, z1);
    box(canopy, Fu.from - 1.5, Fu.to + 1.5, Fu.height, Fu.height + 0.5, z0 - 1.5, z1 + 1.5);
    box(teal, Fu.from - 1.52, Fu.to + 1.52, Fu.height + 0.12, Fu.height + 0.3, z0 - 1.52, z1 + 1.52);
    for (const x of [Fu.from + 1, Fu.to - 1]) {
      for (const z of [z0 + 1, z1 - 1]) {
        box(steel, x - 0.2, x + 0.2, 0.2, Fu.height, z - 0.2, z + 0.2);
        solid(x - 0.2, x + 0.2, 0, Fu.height, z - 0.2, z + 0.2);
      }
    }
    // Two pump islands along z, each with a pump and a charger.
    const mid = (Fu.from + Fu.to) / 2;
    for (const x of [mid - 3, mid + 3]) {
      box(concrete, x - 0.6, x + 0.6, 0.2, 0.35, z0 + 2, z1 - 2);
      solid(x - 0.6, x + 0.6, 0, 0.35, z0 + 2, z1 - 2);
      for (const [z, lit] of [[z0 + 3.5, rubber], [z1 - 3.5, teal]] as Array<[number, BufferGeometry[]]>) {
        box(shutters, x - 0.35, x + 0.35, 0.35, 2.1, z - 0.3, z + 0.3);
        box(lit, x - 0.37, x + 0.37, 1.5, 1.8, z - 0.31, z + 0.31);
        solid(x - 0.35, x + 0.35, 0, 2.1, z - 0.3, z + 0.3);
      }
    }
    // A van filling up, nose to the road.
    placed.push({ model: 'vehicle', name: 'postvan', vehicle: 'postvan', x: mid - 5.6, y: 0.06, z: (z0 + z1) / 2, turn: 0 });
  }

  /* ----- the distribution centre at the north end, and its lorry park ----- */
  const W = H.depot;
  building(W);
  const L = H.lorries;
  const bay = (L.to - L.from) / L.fleet.length;
  lineZ(yellow, L.z[1], L.from, L.to, 0.15);
  L.fleet.forEach((name, i) => {
    const x = L.from + i * bay;
    lineX(yellow, x, L.z[0], L.z[1], 0.15);
    if (i === L.fleet.length - 1) lineX(yellow, x + bay, L.z[0], L.z[1], 0.15);
    // Backed in against the line at the back, nose to the apron.
    placed.push({ ...source(name), vehicle: name, x: x + bay / 2, y: 0.06, z: L.z[1] - 0.4 - sizeOf(name)[2] / 2, turn: noseSouth(name) });
  });

  /* ----- the staff's bus shelter, and bins ----- */
  placed.push({ model: 'park', name: 'shelter', x: H.shelter.x, y: 0.06, z: H.shelter.z, turn: H.shelter.turn });
  solid(H.shelter.x - 2.5, H.shelter.x + 2.5, 0, 2.8, H.shelter.z - 1.2, H.shelter.z + 1.2);
  for (const [x, z] of H.bins) {
    for (let k = 0; k < 3; k++) placed.push({ model: 'park', name: 'bin', x: x + k * 0.85, y: 0.06, z, turn: (rnd() - 0.5) * 0.3 });
  }

  /* ----- office, masts, skips ----- */
  for (const office of [H.office, H.office2]) {
    placed.push({ model: 'country', name: office.part, x: office.x, y: 0.06, z: office.z, turn: office.turn });
    const O = COUNTRY[office.part].size;
    solid(office.x - O[0] / 2, office.x + O[0] / 2, 0, O[1], office.z - O[2] / 2, office.z + O[2] / 2);
  }
  for (const [x, z] of H.masts) {
    placed.push({ model: 'country', name: 'indMast', x, y: 0.06, z, turn: rnd() * Math.PI });
    solid(x - 0.4, x + 0.4, 0, 20, z - 0.4, z + 0.4);
  }
  for (const [x, z] of [[H.west + 3, 290], [D.from - 2.5, D.z1 + 4], [W.x - W.width / 2 - 3, W.z], [W.x + W.width / 2 + 3, W.z - 6]] as Array<[number, number]>) {
    placed.push({ model: 'country', name: 'siteSkip', x, y: 0.06, z, turn: 0 });
  }

  /* ----- containers, east of the shed, stacked one to three high ----- */
  const K = H.containers;
  const stacks = [2, 3, 1, 2, 1];
  for (let r = 0; r < K.rows; r++) {
    const x = K.x - ((K.rows - 1) / 2) * (K.width + K.gap) + r * (K.width + K.gap);
    for (let h = 0; h < stacks[r]; h++) {
      const livery = Math.floor(rnd() * LIVERIES.length);
      const g = new BoxGeometry(K.width, K.height, K.length).translate(x, 0.06 + K.height / 2 + h * K.height, K.z0 + K.length / 2 + (rnd() - 0.5) * 0.2);
      containers[livery].push(g);
    }
    solid(x - K.width / 2, x + K.width / 2, 0, K.height * stacks[r], K.z0, K.z0 + K.length);
  }

  /* ----- parcel carts on PF1's new stretch, and a few by the dock ----- */
  const pf1 = stationPlatforms()[0];
  const top = pf1.line[0].depth + TRAIN.sleeperHeight + TRAIN.railHeight + STATION.platform.top;
  for (let i = 0; i < H.carts.count; i++) {
    const x = H.carts.from + i * H.carts.pitch;
    const q = pf1.line.reduce((m, s) => (Math.abs(s.x - x) < Math.abs(m.x - x) ? s : m));
    const mid = (pf1.from + pf1.to) / 2 + 0.6;
    placed.push({ model: 'airport', name: 'cart', x: q.x + q.nx * pf1.dir * mid, y: top, z: q.z + q.nz * pf1.dir * mid, turn: Math.atan2(q.nz, q.nx) }); // a cart's length is its z: turned onto the line
  }
  // Three parcel carts between PF1's first ramp and the dock steps — no tug: the user took it out.
  for (let i = 0; i < 3; i++) placed.push({ model: 'airport', name: 'cart', x: 86, y: 0.06, z: 306 - i * 4.6, turn: 0 });
  solid(84.9, 87.1, 0, 2.3, 294.8, 308.1);

  /* ----- the workshop in the west end ----- */
  building(H.workshop);

  /* ----- small vans and cars parked along PF1's extension ----- */
  {
    const pf = stationPlatforms()[0];
    const top = pf.line[0].depth + TRAIN.sleeperHeight + TRAIN.railHeight + STATION.platform.top;
    for (const [name, x, zAt, dir] of H.platformParked) {
      const q = pf.line.reduce((m, t) => (Math.abs(t.x - x) < Math.abs(m.x - x) ? t : m));
      // On the strip, a little toward its back so the platform edge stays clear; on the deck where one is given.
      const z = zAt || q.z + q.nz * pf.dir * ((pf.from + pf.to) / 2 + 0.6);
      placed.push({
        ...source(name), vehicle: name, tint: CAR_BODIES.has(name) ? PAINT[Math.floor(rnd() * PAINT.length)] : undefined,
        x, y: top + 0.012, z, turn: dir * Math.PI / 2 + noseSouth(name) + (rnd() - 0.5) * 0.04,
      });
    }
  }

  /* ----- signs ----- */
  const boards: Board[] = [
    { kind: 'fascia', x: H.sign.x - 4, y: 3.2, z: H.sign.z, turn: 0, w: 7, h: 1.3, text: H.sign.text },
    { kind: 'fascia', x: S.x, y: 8.6, z: S.z - S.width / 2 - 0.12, turn: 0, w: 18, h: 2.2, text: 'Parcels · Deliveries' },
    { kind: 'fascia', x: H.gate2[0] - 5.5, y: 3.2, z: H.sign.z, turn: 0, w: 7, h: 1.3, text: 'Parcel Hub · North Gate' },
    ...signs,
  ];
  for (const k of [-1, 1]) box(steel, H.gate2[0] - 5.5 + k * 3 - 0.06, H.gate2[0] - 5.5 + k * 3 + 0.06, 0, 3.9, H.sign.z - 0.06, H.sign.z + 0.06);
  for (const k of [-1, 1]) box(steel, H.sign.x - 4 + k * 3 - 0.06, H.sign.x - 4 + k * 3 + 0.06, 0, 3.9, H.sign.z - 0.06, H.sign.z + 0.06);

  const merge = (list: BufferGeometry[]) => (
    list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
  );
  return {
    asphalt: merge(asphalt), concrete: merge(concrete), white: merge(white), yellow: merge(yellow), steel: merge(steel),
    mesh: merge(mesh), rubber: merge(rubber), shutters: merge(shutters), canopy: merge(canopy), teal: merge(teal),
    clad: merge(clad), slate: merge(slate), glass: merge(glass), darkGlass: merge(darkGlass),
    containers: containers.map(merge), placed, colliders, boards,
  };
}

/**
 * The goods train standing on PF1's spur (`COURIER_HUB.train`).
 *
 * Built the way the airport's stabled stock is: each vehicle cloned out of
 * the railway's own model and stood on the railhead, spaced by
 * `freightFormation` — the same couplings the running freight trains use —
 * so it is a real rake of real wagons, not props. Nothing moves: it is
 * scenery, standing on the spur's straight short of where it joins the main.
 */
const TRAIN_MODELS = ['/models/train37.glb', '/models/wagonFlat40.glb', '/models/wagonFlat20.glb'] as const;
for (const m of TRAIN_MODELS) useGLTF.preload(m, DRACO_PATH);

function StandingTrain() {
  const loco = useGLTF(TRAIN_MODELS[0], DRACO_PATH).scene;
  const flat40 = useGLTF(TRAIN_MODELS[1], DRACO_PATH).scene;
  const flat20 = useGLTF(TRAIN_MODELS[2], DRACO_PATH).scene;
  const placed = useMemo(() => {
    const scenes = new Map<string, Object3D>([[TRAIN_MODELS[0], loco], [TRAIN_MODELS[1], flat40], [TRAIN_MODELS[2], flat20]]);
    // On the spur's straight, south of where it eases onto the main: the
    // train's front at `frontAt`, facing north along the straight.
    const straight = pf1Spur().filter((q) => q.x < PF1_SPUR.blendFrom);
    const [next, far] = [straight[0], straight[straight.length - 1]];
    const len = Math.hypot(next.x - far.x, next.z - far.z);
    const dx = (next.x - far.x) / len;
    const dz = (next.z - far.z) / len;
    const t = (H.train.frontAt - next.x) / dx;
    const end = { x: next.x + dx * t, z: next.z + dz * t, depth: next.depth };
    // A model faces −Z, so driving along (dx, dz) is a yaw of atan2(−dx, −dz).
    const yaw = Math.atan2(-dx, -dz);
    const railTop = end.depth + TRAIN.sleeperHeight + TRAIN.railHeight;
    const units = [...freightFormation(H.train.loco, H.train.wagons)];
    // Top-and-tailed: a second locomotive coupled on behind the last wagon, turned to face the other way.
    if (H.train.tail) {
      const last = units[units.length - 1];
      const engine = units[0];
      units.push({ ...engine, offset: last.offset + last.length / 2 + 0.9 + engine.length / 2, flip: true });
    }
    const front = units[0].length / 2;
    return units.map((u, i) => {
      const source = scenes.get(u.model);
      if (!source) return null;
      const object = source.clone(true);
      object.traverse((o: Object3D) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      const back = front + u.offset;
      return { key: `${u.model}-${i}`, object, x: end.x - dx * back, z: end.z - dz * back, y: railTop, yaw: yaw + (u.flip ? Math.PI : 0), box: u.box };
    }).filter((p): p is NonNullable<typeof p> => p !== null);
  }, [loco, flat40, flat20]);
  return (
    <>
      {placed.map((p) => (
        <group key={p.key} position={[p.x, p.y, p.z]} rotation={[0, p.yaw, 0]}>
          <primitive object={p.object} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {placed.map((p) => (
          <CuboidCollider key={p.key} args={[p.box[0] / 2, p.box[1] / 2, p.box[2] / 2]} position={[p.x, p.y + p.box[1] / 2, p.z]} rotation={[0, p.yaw, 0]} />
        ))}
      </RigidBody>
    </>
  );
}

export default function CourierHub() {
  const built = useMemo(() => layout(), []);
  const airport = useGLTF(AIRPORT_MODEL, DRACO_PATH).scene;
  const country = useGLTF(COUNTRY_MODEL, DRACO_PATH).scene;
  const trucks = useGLTF(TRUCKS_MODEL, DRACO_PATH).scene;
  const vehicles = useGLTF(VEHICLES_MODEL, DRACO_PATH).scene;
  const parade = useGLTF(PARADE_MODEL, DRACO_PATH).scene;
  const park = useGLTF(PARK_MODEL, DRACO_PATH).scene;
  const ribs = useMemo(() => ribTexture(), []);
  const cladding = useMemo(() => claddingTexture(), []);
  const objects = useMemo(() => built.placed.map((p) => {
    if (p.model === 'vehicle') return trafficMachine(vehicles, p.name, p.tint).root;
    const source = { airport, country, truck: trucks, parade, park }[p.model].getObjectByName(p.name);
    if (!source) return null;
    const copy = source.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.traverse((o: Object3D) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }), [built.placed, airport, country, trucks, vehicles, parade, park]);

  return (
    <group>
      {built.asphalt && (
        <mesh geometry={built.asphalt} receiveShadow>
          <meshStandardMaterial color="#44474b" roughness={0.95} />
        </mesh>
      )}
      {built.concrete && (
        <mesh geometry={built.concrete} castShadow receiveShadow>
          <meshStandardMaterial color="#a3a09a" roughness={0.9} />
        </mesh>
      )}
      {built.white && (
        <mesh geometry={built.white}>
          <meshStandardMaterial color="#eeeeea" roughness={0.7} />
        </mesh>
      )}
      {built.yellow && (
        <mesh geometry={built.yellow} castShadow>
          <meshStandardMaterial color="#e6c227" roughness={0.6} />
        </mesh>
      )}
      {built.steel && (
        <mesh geometry={built.steel} castShadow>
          <meshStandardMaterial color="#3e5566" roughness={0.45} metalness={0.45} />
        </mesh>
      )}
      {built.mesh && (
        <mesh geometry={built.mesh}>
          <meshStandardMaterial color="#2c3238" roughness={0.6} metalness={0.4} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      )}
      {built.rubber && (
        <mesh geometry={built.rubber}>
          <meshStandardMaterial color="#1b1b1b" roughness={0.9} />
        </mesh>
      )}
      {built.shutters && (
        <mesh geometry={built.shutters}>
          <meshStandardMaterial color="#b9bec2" roughness={0.5} metalness={0.5} />
        </mesh>
      )}
      {built.canopy && (
        <mesh geometry={built.canopy} castShadow receiveShadow>
          <meshStandardMaterial color="#2f4a5e" roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      {built.clad && (
        <mesh geometry={built.clad} castShadow receiveShadow>
          <meshStandardMaterial map={cladding} roughness={0.5} metalness={0.35} />
        </mesh>
      )}
      {built.slate && (
        <mesh geometry={built.slate} castShadow receiveShadow>
          <meshStandardMaterial color="#35414b" roughness={0.6} metalness={0.2} />
        </mesh>
      )}
      {built.glass && (
        <mesh geometry={built.glass}>
          <meshStandardMaterial color="#a9cfd6" roughness={0.1} metalness={0.3} />
        </mesh>
      )}
      {built.darkGlass && (
        <mesh geometry={built.darkGlass} castShadow>
          <meshStandardMaterial color="#2c4a57" roughness={0.08} metalness={0.6} />
        </mesh>
      )}
      {built.teal && (
        <mesh geometry={built.teal}>
          <meshStandardMaterial color="#14a39a" emissive="#14a39a" emissiveIntensity={0.8} />
        </mesh>
      )}
      {built.containers.map((g, i) => g && (
        <mesh key={`box-${i}`} geometry={g} castShadow receiveShadow>
          <meshStandardMaterial color={LIVERIES[i]} map={ribs} roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
      <Boards boards={built.boards} />
      <StandingTrain />
      {built.placed.map((p, i) => objects[i] && (
        <group key={`${p.name}-${i}`} position={[p.x, p.y, p.z]} rotation={[0, p.turn, 0]}>
          <primitive object={objects[i]!} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {built.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.centre} />
        ))}
        {built.placed.filter((p) => p.vehicle).map((p, i) => {
          const size = sizeOf(p.vehicle!);
          return (
            <CuboidCollider
              key={`v-${i}`}
              args={[size[0] / 2, size[1] / 2, size[2] / 2]}
              position={[p.x, p.y + size[1] / 2, p.z]}
              rotation={[0, p.turn, 0]}
            />
          );
        })}
      </RigidBody>
    </group>
  );
}
