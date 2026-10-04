'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, InstancedMesh, type Material, Matrix4, Mesh,
  type Object3D, Quaternion, SRGBColorSpace, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  BALLAST, STATION, STATION_BUILDING, STATION_FORECOURT as F, STATION_NAME, STATION_SHOPS, stationPlatforms,
} from '@/config/islandRailConfig';
import { TRAIN } from '@/config/trainConfig';
import truckData from '@/config/truckData.json';
import countryModels from '@/config/countryModelData.json';
import { trafficMachine, vehicleSize } from './WallOfDeath';

/**
 * The island station's outside: the name boards, the forecourt and its car
 * park, and the trees along the road. Everything is in the airport island's
 * frame — `x` along the line, `z` across it — drawn inside `IslandRail`.
 *
 * - **Boards.** Generic modern (`STATION_NAME`): a slate-blue fascia with a
 *   teal train pictogram and white lettering over the door, street side and
 *   platform side, where the two halves meet; on each platform only its
 *   number, on a post. No name boards on the platforms.
 * - **Station road.** Not here: it is the road kit's, laid by `IslandRoads`
 *   from `roadConfig`, so its junctions are the kit's too. This draws what is
 *   off it — the set-down pavement, the car park, lamps and trees — and no
 *   painted grass anywhere; trees stand on the ground.
 * - **Car park.** Asphalt, painted bays and a zebra walkway, kerbed; filled to
 *   `occupancy` with the city's own traffic cars (`vehicles.glb`, through the
 *   Wall of Death's `trafficMachine`) in real-car colours, each with a box so
 *   you hit it rather than drive through it. Nobody parks dead straight: each
 *   car sits a little off centre, a little skewed, and some reversed in.
 * - **Shops and lorries.** The shops stand on pads across the northern half
 *   (`STATION_SHOPS`), each with a lorry in its loading bay; the lorry park at
 *   the west end holds the Skylark island's artic and lorry cab
 *   (`country.glb`), the city's box truck and artic (`trucks.glb`, cut out of
 *   its scenery by `prepare:trucks`) and a tow truck.
 * - **Hedge and gate.** A hedge along the road side, broken where parade
 *   link 1's crossroads opens straight into the car park.
 * - **Trees.** The park kit's broadleaves — not palms, which the user had
 *   cleared from this field — along the verge and in pairs at the plaza's ends.
 */

const VEHICLES_MODEL = '/models/vehicles.glb';
const PARK_MODEL = '/models/park.glb';
const PARADE_MODEL = '/models/parade.glb';
const TRUCKS_MODEL = '/models/trucks.glb';
const COUNTRY_MODEL = '/models/country.glb';
useGLTF.preload(VEHICLES_MODEL, DRACO_PATH);
useGLTF.preload(COUNTRY_MODEL, DRACO_PATH);
useGLTF.preload(TRUCKS_MODEL, DRACO_PATH);
useGLTF.preload(PARK_MODEL, DRACO_PATH);
useGLTF.preload(PARADE_MODEL, DRACO_PATH);

/**
 * What parks in the bays: the city's car bodies, weighted toward the ordinary
 * ones, with pickups, sports cars, vans — the post van and the road-service
 * truck both fit a bay — and the odd police car among them.
 */
const CARS = ['Compact_Body', 'Coupe_Body', 'Hatchback_Body', 'minivan_body', 'Offroad_Body',
  'Sedan_Body', 'SUV_Body', 'Wagon_Body', 'Hatchback_Body', 'Sedan_Body', 'Compact_Body',
  'Pickup_Body', 'Sport_body', 'postvan', 'police_sedan', 'Wagon_Body', 'rdservtruck',
  'Pickup_Body', 'minivan_body', 'postvan'] as const;
/** The lorries cut from the city's scenery; their cabs are at +z, where a traffic car's nose is at −z. */
const TRUCKS = truckData as Record<string, { size: number[] }>;
const isTruck = (name: string) => name in TRUCKS;
/**
 * The Skylark island's vehicles, named `country:<part>`: its lorries, its
 * pickup, the quarry's dumper. `prepare:country` turns every one to face −Z,
 * as the traffic cars do, and stands it on y = 0.
 */
const COUNTRY = countryModels.parts as Record<string, { size: number[] }>;
const countryPart = (name: string) => (name.startsWith('country:') ? name.slice(8) : null);
const sizeOf = (name: string): number[] => {
  const part = countryPart(name);
  if (part) return COUNTRY[part].size;
  return isTruck(name) ? TRUCKS[name].size : vehicleSize(name);
};
/** The turn that points a vehicle's nose at −z. */
const noseSouth = (name: string) => (isTruck(name) ? Math.PI : 0);
/** Vehicles that keep their own livery rather than taking a random paint. */
const LIVERIED = new Set(['postvan', 'police_sedan', 'taxi', 'citybus', 'school_bus', 'ambulance', 'rdservtruck']);
/** The bus and coach bay, west to east along the kerb. */
const BUS_BAY = ['citybus', 'school_bus', 'citybus', 'rdservtruck', 'postvan'] as const;
const PAINT = ['#e9e9e6', '#e9e9e6', '#c7c9cc', '#9ea2a6', '#2b2d30', '#15171a', '#7b1f24', '#1f3b6e', '#5d6468', '#b8a88a'];
const TREES = ['treeBroad', 'treeBig', 'treeTall', 'treeBroad', 'treeSlim'] as const;

/* ------------------------------------------------------------------ boards */

export type BoardKind = 'fascia' | 'number';

/**
 * A generic modern station's signs — the user asked for that rather than
 * London's roundel: slate-blue panels, white sans-serif, one teal accent
 * and a plain train pictogram, the way a new-build station anywhere is
 * signed.
 */
const PANEL = '#46586a';
const INK = '#ffffff';
const ACCENT = '#14a39a';
const FONT = (px: number) => `600 ${px}px "Inter", "Helvetica Neue", "Segoe UI", Arial, sans-serif`;

/** Shrinks `px` until `text` fits `width`. */
function fit(g: CanvasRenderingContext2D, text: string, px: number, width: number) {
  let size = px;
  g.font = FONT(size);
  while (g.measureText(text).width > width && size > 12) { size -= 2; g.font = FONT(size); }
}

/** A train seen head-on, white on the accent tile: body, windscreen, lamps, rails. */
function pictogram(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.fillStyle = ACCENT;
  g.beginPath();
  g.roundRect(x, y, s, s, s * 0.14);
  g.fill();
  const cx = x + s / 2;
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(cx - s * 0.26, y + s * 0.16, s * 0.52, s * 0.54, s * 0.12);
  g.fill();
  g.fillStyle = ACCENT;
  g.fillRect(cx - s * 0.19, y + s * 0.24, s * 0.38, s * 0.2);
  g.beginPath();
  g.arc(cx - s * 0.13, y + s * 0.56, s * 0.045, 0, Math.PI * 2);
  g.arc(cx + s * 0.13, y + s * 0.56, s * 0.045, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = s * 0.05;
  g.beginPath();
  g.moveTo(cx - s * 0.2, y + s * 0.74); g.lineTo(cx - s * 0.3, y + s * 0.86);
  g.moveTo(cx + s * 0.2, y + s * 0.74); g.lineTo(cx + s * 0.3, y + s * 0.86);
  g.stroke();
}

/**
 * A board's face.
 *
 * - `fascia`: the pictogram, then the name in white on the slate panel,
 *   a thin accent rule along the bottom.
 * - `number`: a slate square with an accent band over the number.
 */
function boardTexture(kind: BoardKind, text: string, aspect: number): CanvasTexture {
  const h = 400;
  const w = Math.round(h * aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.textBaseline = 'middle';
  g.fillStyle = PANEL;
  g.fillRect(0, 0, w, h);
  if (kind === 'fascia') {
    const s = h * 0.62;
    pictogram(g, h * 0.22, (h - s) / 2, s);
    g.fillStyle = ACCENT;
    g.fillRect(0, h - 16, w, 16);
    g.fillStyle = INK;
    g.textAlign = 'left';
    const left = h * 0.22 + s + h * 0.24;
    fit(g, text, h * 0.44, w - left - h * 0.3);
    g.fillText(text, left, h / 2 + 2);
  } else {
    g.fillStyle = ACCENT;
    g.fillRect(0, 0, w, h * 0.12);
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.font = FONT(h * 0.62);
    g.fillText(text, w / 2, h * 0.58);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export interface Board { kind: BoardKind; x: number; y: number; z: number; turn: number; w: number; h: number; text: string }

export function Boards({ boards }: { boards: Board[] }) {
  const faces = useMemo(() => boards.map((b) => boardTexture(b.kind, b.text, b.w / b.h)), [boards]);
  return (
    <>
      {boards.map((b, i) => (
        <group key={i} position={[b.x, b.y, b.z]} rotation={[0, b.turn, 0]}>
          <mesh castShadow>
            <boxGeometry args={[b.w + 0.1, b.h + 0.1, 0.1]} />
            <meshStandardMaterial color="#41474d" roughness={0.4} metalness={0.55} />
          </mesh>
          {[0.056, -0.056].map((dz, k) => (
            <mesh key={k} position={[0, 0, dz]} rotation={[0, k ? Math.PI : 0, 0]}>
              <planeGeometry args={[b.w, b.h]} />
              <meshStandardMaterial map={faces[i]} roughness={0.5} side={DoubleSide} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

/**
 * One mesh of a kit part, instanced at every spot — the hedge is a hundred
 * shrubs and should be one draw call per material, as the park's is.
 */
function Instanced({ geometry, material, at }: {
  geometry: BufferGeometry; material: Material; at: ReadonlyArray<{ x: number; z: number; turn: number }>;
}) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const one = new Vector3(1, 1, 1);
    at.forEach((spot, i) => mesh.setMatrixAt(i, m.compose(new Vector3(spot.x, 0, spot.z), q.setFromAxisAngle(up, spot.turn), one)));
    mesh.instanceMatrix.needsUpdate = true;
    // Without this the whole run is culled by the one shrub's sphere at the origin.
    mesh.computeBoundingSphere();
  }, [at]);
  return <instancedMesh ref={ref} args={[geometry, material, at.length]} castShadow receiveShadow />;
}

/* -------------------------------------------------------------- the layout */

const rnd = (() => {
  let seed = F.seed;
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
})();

function layout() {
  const a0 = STATION_BUILDING.along - STATION_BUILDING.span / 2;
  const a1 = STATION_BUILDING.along + STATION_BUILDING.span / 2;
  const boards: Board[] = [];
  const posts: BufferGeometry[] = [];

  // The building's two big boards, where its halves meet.
  const B = STATION_BUILDING;
  boards.push({ kind: 'fascia', x: B.along, y: B.height * 0.76, z: F.front - 0.25, turn: 0, w: 20, h: 2.4, text: STATION_NAME });
  boards.push({ kind: 'fascia', x: B.along, y: B.height * 0.76, z: B.across + B.depth / 2 + 0.25, turn: Math.PI, w: 12, h: 1.6, text: STATION_NAME });

  // On the platforms, only the number — no name boards (the user took them
  // out) — on a post near the middle of each, facing the tracks.
  const P = STATION.platform;
  const platformTop = BALLAST.line.depth + TRAIN.sleeperHeight + TRAIN.railHeight + P.top;
  stationPlatforms().forEach((plat, n) => {
    const ref = plat.line.reduce((m, q) => (Math.abs(q.x - STATION.centre) < Math.abs(m.x - STATION.centre) ? q : m));
    const mid = ref.z + plat.dir * (plat.from + plat.to) / 2;
    // Between the islands' lamps, which stand every 22 m from `ramp + 4` in.
    const nx = STATION.centre + 17;
    boards.push({ kind: 'number', x: nx, y: platformTop + 3.0, z: mid, turn: 0, w: 1.1, h: 1.1, text: String(n + 1) });
    posts.push(new BoxGeometry(0.1, 3.0 + 0.55, 0.1).translate(nx, platformTop + (3.0 + 0.55) / 2, mid));
  });

  // Surfaces. The roads themselves are the kit's, laid by `IslandRoads` from
  // `roadConfig`; this is everything off them.
  const asphalt: BufferGeometry[] = [];
  const paving: BufferGeometry[] = [];
  const paint: BufferGeometry[] = [];
  const kerbs: BufferGeometry[] = [];
  const slab = (x0: number, x1: number, z0: number, z1: number, top: number, list: BufferGeometry[]) => {
    list.push(new BoxGeometry(x1 - x0, top + 0.2, z1 - z0).translate((x0 + x1) / 2, (top - 0.2) / 2, (z0 + z1) / 2));
  };
  const overlaps = (x0: number, x1: number, c: number, h: number) => x1 > c - h && x0 < c + h;

  // The set-down pavement, from the station road's north pavement to the
  // building, the building's whole length — and on round its west end to
  // the car park's footpath.
  slab(a0, a1, F.plaza[0], F.plaza[1], 0.12, paving);

  /* ----- the car park ----- */
  const lot = F.park;
  const cars: Array<{ name: string; tint: string; x: number; z: number; turn: number }> = [];
  const trees: Array<{ part: string; x: number; z: number; turn: number; scale: number }> = [];
  const lampSteel: BufferGeometry[] = [];
  const lampHeads: BufferGeometry[] = [];
  const line = (x: number, z0: number, z1: number) => paint.push(new BoxGeometry(0.12, 0.02, z1 - z0).translate(x, 0.075, (z0 + z1) / 2));
  /** How far east a band may run: to the west T below the building's front, short of the building above it. */
  const eastOf = (z1: number) => (z1 <= lot.clearOfBuilding ? lot.southTo : lot.northTo);
  // Asphalt band by band, so the part beside the building stops at its wall.
  const bands: Array<[number, number]> = [...lot.rows.map((r) => r.z), ...lot.aisles];
  for (const [z0, z1] of bands) slab(lot.from, eastOf(z1), z0, z1, 0.06, asphalt);
  slab(lot.from, lot.northTo + 6, lot.path[0], lot.path[1], 0.12, paving);
  /*
   * The hedge between the road and the car park: the amusement park's own,
   * `bushLow` shoulder to shoulder at its pitch, each lying ALONG the run
   * (the shrub's long axis is its +X) with the same small stray and wobble.
   * It stands on the verge the car park slid north to leave, stops either
   * side of the way in, and across that gap the verge is asphalt.
   */
  const H = lot.hedge;
  const hedgeRuns: Array<[number, number]> = [[lot.from + 1, lot.gate[0] - 1.4], [lot.gate[1] + 1.4, lot.southTo - 1]];
  const shrubs: Array<{ x: number; z: number; turn: number }> = [];
  for (const [h0, h1] of hedgeRuns) {
    const n = Math.max(1, Math.round((h1 - h0) / 2));
    for (let i = 0; i <= n; i++) {
      shrubs.push({ x: h0 + ((h1 - h0) * i) / n, z: H.z + (rnd() - 0.5) * 0.2, turn: (rnd() - 0.5) * 0.24 + (rnd() < 0.5 ? Math.PI : 0) });
    }
  }
  slab(lot.gate[0], lot.gate[1], F.roadEdge - 0.3, lot.bottom, 0.06, asphalt);
  // Kerbs: the road side, the west end, and the east edge above the building's front.
  for (const [k0, k1] of [[lot.from, lot.gate[0]], [lot.gate[1], lot.southTo]]) {
    kerbs.push(new BoxGeometry(k1 - k0, 0.16, 0.25).translate((k0 + k1) / 2, 0.08, lot.bottom));
  }
  // No kerb on the west end any more: the petrol station's lot carries straight
  // on from here (`petrolConfig`), so the car park and the forecourt are one.
  kerbs.push(new BoxGeometry(0.25, 0.16, lot.top - lot.clearOfBuilding).translate(lot.northTo, 0.08, (lot.clearOfBuilding + lot.top) / 2));
  // Bays in every row, clear of the two cross aisles and of the T's mouth.
  const inAisle = (x0: number, x1: number) => lot.ends.some(([e0, e1]) => x1 > e0 && x0 < e1);
  const yellow: BufferGeometry[] = [];
  const yline = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    yellow.push(new BoxGeometry(len, 0.02, 0.15).rotateY(-Math.atan2(z1 - z0, x1 - x0)).translate((x0 + x1) / 2, 0.076, (z0 + z1) / 2));
  };
  const special = (rowIndex: number, x0: number, x1: number) => [lot.busBay, lot.taxiRank]
    .some((b) => b.row === rowIndex && x1 > b.from && x0 < b.to)
    // The way in off the outer road runs through the south row.
    || (rowIndex === 0 && x1 > lot.gate[0] && x0 < lot.gate[1]);
  /** North of the middle aisle, the shops, their aisles and bays and the lorry park take whole blocks. */
  const reserved = (z0: number, x0: number, x1: number) => z0 >= STATION_SHOPS.northOf - 0.01
    && STATION_SHOPS.reserved.some(([r0, r1]) => x1 > r0 && x0 < r1);
  /**
   * A parked vehicle, nose `nose` (+1 north, −1 south) into a bay whose
   * inner end is at `kerb`: rarely dead straight — a little off centre,
   * short of the kerb by a bit, skewed a few degrees, and one in four
   * reversed in, which only swaps which end is at the kerb.
   */
  const park = (name: string, tint: string, x: number, kerb: number, nose: 1 | -1, loose = 1) => {
    const length = sizeOf(name)[2];
    const skew = (rnd() < 0.12 ? 0.2 : 0.07) * (rnd() - 0.5) * 2 * loose;
    const back = 0.3 + rnd() * 0.6 * loose;
    // Lorries and cabs (`loose` < 1) are always backed in; only cars come in either way.
    const reversed = rnd() < 0.25 && loose >= 1;
    const facing = (nose > 0) !== reversed ? Math.PI : 0;
    cars.push({
      name, tint,
      x: x + (rnd() - 0.5) * 0.5 * loose,
      z: kerb - nose * (length / 2 + back),
      turn: noseSouth(name) + facing + skew,
    });
  };
  lot.rows.forEach((row, ri) => {
    const to = eastOf(row.z[1]) - 1.5;
    for (let x = lot.from + 0.5; x + F.bay.width <= to; x += F.bay.width) {
      if (inAisle(x, x + F.bay.width) || special(ri, x, x + F.bay.width) || reserved(row.z[0], x, x + F.bay.width)) continue;
      line(x, row.z[0], row.z[1]);
      line(x + F.bay.width, row.z[0], row.z[1]);
      if (rnd() < F.occupancy) {
        const car = CARS[Math.floor(rnd() * CARS.length)];
        const tint = LIVERIED.has(car) || countryPart(car) ? '' : PAINT[Math.floor(rnd() * PAINT.length)];
        park(car, tint, x + F.bay.width / 2, row.nose > 0 ? row.z[1] : row.z[0], row.nose);
      }
    }
  });
  /*
   * The bus and coach bay: long vehicles along the kerb, nose east, in a
   * yellow box — and the taxi rank, nearest the station: black cabs nose in,
   * in yellow-lined bays. London's markings, both.
   */
  {
    const b = lot.busBay;
    const row = lot.rows[b.row].z;
    yline(b.from, row[0] + 0.3, b.to, row[0] + 0.3);
    yline(b.from, row[1] - 0.3, b.to, row[1] - 0.3);
    yline(b.from, row[0] + 0.3, b.from, row[1] - 0.3);
    yline(b.to, row[0] + 0.3, b.to, row[1] - 0.3);
    let x = b.from + 1.5;
    for (const name of BUS_BAY) {
      const length = vehicleSize(name)[2];
      if (x + length > b.to - 1) break;
      cars.push({ name, tint: '', x: x + length / 2, z: (row[0] + row[1]) / 2, turn: -Math.PI / 2 });
      x += length + 2;
    }
  }
  {
    const b = lot.taxiRank;
    const row = lot.rows[b.row];
    for (let x = b.from + 0.5; x + F.bay.width <= b.to; x += F.bay.width) {
      yline(x, row.z[0], x, row.z[1]);
      yline(x + F.bay.width, row.z[0], x + F.bay.width, row.z[1]);
      if (rnd() < 0.6) park('taxi', '#141414', x + F.bay.width / 2, row.nose > 0 ? row.z[1] : row.z[0], row.nose, 0.4);
    }
  }
  /*
   * The lorry park: long bays from the middle aisle north, yellow-lined, the
   * lorries backed in so they drive straight out — and each shop's loading
   * bay, a yellow box beside its pad with its delivery lorry in it the same
   * way.
   */
  {
    const L = STATION_SHOPS.lorryPark;
    const [z0, z1] = L.z;
    yline(L.from, z1, L.to, z1);
    for (let i = 0; i <= L.bays; i++) yline(L.from + i * L.width, z0 + 0.5, L.from + i * L.width, z1);
    L.fleet.forEach((name, i) => {
      if (name) park(name, '', L.from + (i + 0.5) * L.width, z1 - 0.4, 1, 0.3);
    });
    // Backed in: `park` puts the nose north at a +1 kerb, so turn them round.
    for (const c of cars.slice(-L.fleet.filter(Boolean).length)) c.turn += Math.PI;
    for (const b of STATION_SHOPS.buildings) {
      const [x0, x1] = b.loadingBay;
      const top = lot.rows[4].z[1];
      yline(x0, z0 + 0.4, x0, top); yline(x1, z0 + 0.4, x1, top); yline(x0, top, x1, top);
      yline(x0, z0 + 0.4, x1, top); yline(x1, z0 + 0.4, x0, top);
      const n = cars.length;
      park(b.delivery, '', (x0 + x1) / 2, top - 0.3, 1, 0.3);
      cars[n].turn += Math.PI;
    }
  }
  // Lamps between the back-to-back rows — not on a pad or in a lorry bay.
  const onPad = (x: number) => STATION_SHOPS.reserved.some(([r0, r1]) => x > r0 - 1 && x < r1 + 1);
  for (let x = lot.from + 12; x < lot.northTo - 6; x += 26) {
    for (const z of [lot.rows[1].z[1], lot.rows[3].z[1], lot.path[0] + 0.6]) {
      if (z > STATION_SHOPS.northOf && onPad(x)) continue;
      lampSteel.push(new CylinderGeometry(0.07, 0.1, 7.5, 8).translate(x, 3.75, z));
      for (const k of [-1, 1]) {
        lampSteel.push(new BoxGeometry(0.12, 0.12, 1.4).translate(x, 7.45, z + k * 0.7));
        lampHeads.push(new BoxGeometry(0.45, 0.1, 0.3).translate(x, 7.38, z + k * 1.3));
      }
    }
  }
  // Trees down the car park's west side, along its footpath, and in the
  // set-down pavement between the station road and the door — on the ground,
  // no painted grass under any of them.
  let t = 0;
  // (The row of trees down the west side went with the kerb: the petrol
  // station stands there now. `rnd` is still drawn so nothing else moves.)
  for (let z = lot.bottom + 4; z <= lot.path[1]; z += 10) { rnd(); rnd(); }
  const behindShop = (x: number) => STATION_SHOPS.buildings.some((b) => Math.abs(x - b.x) < b.width / 2 + 3);
  for (let x = lot.from + 8; x <= lot.northTo - 4; x += F.treeEvery + 3) {
    if (behindShop(x)) continue;
    trees.push({ part: TREES[t++ % TREES.length], x, z: lot.path[1] + 1.2, turn: rnd() * Math.PI * 2, scale: 0.6 + rnd() * 0.2 });
  }
  const plazaTreeZ = F.plaza[0] + 2.2;
  for (let x = a0 + 8; x <= a1 - 8; x += 18) {
    if (overlaps(x - 5, x + 5, STATION_BUILDING.along, 8)) continue;
    trees.push({ part: t++ % 2 ? 'treeSlim' : 'treeBroad', x, z: plazaTreeZ, turn: rnd() * Math.PI * 2, scale: 0.55 + rnd() * 0.15 });
  }
  // Lamps along the set-down pavement.
  for (let x = a0 + 17; x < a1 - 4; x += 18) {
    if (overlaps(x - 2, x + 2, STATION_BUILDING.along, 8)) continue;
    lampSteel.push(new CylinderGeometry(0.07, 0.1, 7, 8).translate(x, 3.5, F.plaza[0] + 0.6));
    lampSteel.push(new BoxGeometry(0.12, 0.12, 1.4).translate(x, 6.95, F.plaza[0] + 0.1));
    lampHeads.push(new BoxGeometry(0.45, 0.1, 0.3).translate(x, 6.88, F.plaza[0] - 0.5));
  }

  // Non-indexed first: the island is an `ExtrudeGeometry`, which has no index,
  // and `mergeGeometries` refuses a list that mixes indexed and not — it
  // returns null, and the grass silently was not there.
  const merge = (list: BufferGeometry[]) => (
    list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
  );
  return {
    boards, cars, trees,
    posts: merge(posts), asphalt: merge(asphalt), paving: merge(paving), paint: merge(paint), kerbs: merge(kerbs),
    yellow: merge(yellow), shrubs, hedgeRuns,
    lampSteel: merge(lampSteel), lampHeads: merge(lampHeads),
  };
}

export default function StationForecourt() {
  const vehicles = useGLTF(VEHICLES_MODEL, DRACO_PATH).scene;
  const park = useGLTF(PARK_MODEL, DRACO_PATH).scene;
  const built = useMemo(() => layout(), []);
  const trucks = useGLTF(TRUCKS_MODEL, DRACO_PATH).scene;
  const country = useGLTF(COUNTRY_MODEL, DRACO_PATH).scene;
  const cars = useMemo(() => built.cars.map((c) => {
    const part = countryPart(c.name);
    if (!part && !isTruck(c.name)) return trafficMachine(vehicles, c.name, c.tint || undefined).root;
    const copy = (part ? country.getObjectByName(part)! : trucks.getObjectByName(c.name)!).clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.traverse((o: Object3D) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }), [built.cars, vehicles, trucks, country]);
  const parade = useGLTF(PARADE_MODEL, DRACO_PATH).scene;
  const shops = useMemo(() => STATION_SHOPS.buildings.map((b) => {
    const node = parade.getObjectByName(b.part);
    if (!node) return null;
    const copy = node.clone(true);
    copy.traverse((o: Object3D) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    return copy;
  }), [parade]);
  const hedge = useMemo(() => {
    const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
    park.getObjectByName('bushLow')?.traverse((o: Object3D) => {
      if (o instanceof Mesh) pairs.push({ geometry: o.geometry, material: o.material as Material });
    });
    return pairs;
  }, [park]);
  // Each tree from its part's meshes — geometry and material, not the node,
  // whose own transform is where it stood in the park. `CountryPlanting` does
  // the same.
  const trees = useMemo(() => built.trees.map((tr) => {
    const node = park.getObjectByName(tr.part);
    if (!node) return null;
    const group = new Group();
    node.traverse((o: Object3D) => {
      if (!(o instanceof Mesh)) return;
      const m = new Mesh(o.geometry, o.material);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    });
    return group;
  }), [built.trees, park]);

  return (
    <group>
      <Boards boards={built.boards} />
      {built.posts && (
        <mesh geometry={built.posts} castShadow>
          <meshStandardMaterial color="#41474d" roughness={0.4} metalness={0.55} />
        </mesh>
      )}
      {built.paving && (
        <mesh geometry={built.paving} receiveShadow>
          <meshStandardMaterial color="#b9b3a7" roughness={0.9} />
        </mesh>
      )}
      {built.asphalt && (
        <mesh geometry={built.asphalt} receiveShadow>
          <meshStandardMaterial color="#3a3c40" roughness={0.95} />
        </mesh>
      )}
      {built.paint && (
        <mesh geometry={built.paint}>
          <meshStandardMaterial color="#eeeeea" roughness={0.7} />
        </mesh>
      )}
      {built.kerbs && (
        <mesh geometry={built.kerbs} castShadow receiveShadow>
          <meshStandardMaterial color="#c9c5bc" roughness={0.85} />
        </mesh>
      )}
      {built.lampSteel && (
        <mesh geometry={built.lampSteel} castShadow>
          <meshStandardMaterial color="#5f6468" roughness={0.45} metalness={0.5} />
        </mesh>
      )}
      {built.lampHeads && (
        <mesh geometry={built.lampHeads}>
          <meshStandardMaterial color="#fff3d6" emissive="#ffe2a8" emissiveIntensity={0.6} />
        </mesh>
      )}
      {built.yellow && (
        <mesh geometry={built.yellow}>
          <meshStandardMaterial color="#e8c21a" roughness={0.7} />
        </mesh>
      )}
      {hedge.map((pair, i) => (
        <Instanced key={`hedge-${i}`} geometry={pair.geometry} material={pair.material} at={built.shrubs} />
      ))}
      {STATION_SHOPS.buildings.map((b, i) => shops[i] && (
        <group key={b.label} position={[b.x, 0.06, b.z]} rotation={[0, b.turn, 0]} scale={b.scale}>
          <primitive object={shops[i]!} />
        </group>
      ))}
      {built.cars.map((c, i) => (
        <group key={`car-${i}`} position={[c.x, 0.06, c.z]} rotation={[0, c.turn, 0]}>
          <primitive object={cars[i]} />
        </group>
      ))}
      {built.trees.map((tr, i) => trees[i] && (
        <group key={`tree-${i}`} position={[tr.x, 0, tr.z]} rotation={[0, tr.turn, 0]} scale={tr.scale}>
          <primitive object={trees[i]!} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {built.cars.map((c, i) => {
          const size = sizeOf(c.name);
          return (
            <CuboidCollider
              key={`car-box-${i}`}
              args={[size[0] / 2, size[1] / 2, size[2] / 2]}
              position={[c.x, 0.06 + size[1] / 2, c.z]}
              rotation={[0, c.turn, 0]}
            />
          );
        })}
        {built.hedgeRuns.map(([h0, h1], i) => (
          <CuboidCollider
            key={`hedge-${i}`}
            args={[(h1 - h0) / 2, F.park.hedge.height / 2, F.park.hedge.width / 2]}
            position={[(h0 + h1) / 2, F.park.hedge.height / 2, F.park.hedge.z]}
          />
        ))}
        {STATION_SHOPS.buildings.map((b) => (
          <CuboidCollider key={`shop-${b.label}`} args={[b.width / 2, b.height / 2, b.depth / 2]} position={[b.x, b.height / 2, b.z]} />
        ))}
        {built.trees.map((tr, i) => (
          <CuboidCollider key={`tree-box-${i}`} args={[0.35 * tr.scale, 2, 0.35 * tr.scale]} position={[tr.x, 2, tr.z]} />
        ))}
      </RigidBody>
    </group>
  );
}

