'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BRANCH_ROUTE, livePlayerRoute } from '@/config/pointwork';
import { trainsOnLoop } from '@/physics/trainRegistry';
import { setCrossingClear } from '@/physics/townNav';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Euler, Group, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, RepeatWrapping, SRGBColorSpace, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import { GeometryCollider } from './GeometryCollider';
import { SITE as AIRPORT_SITE } from '@/config/airportConfig';
import { ROAD_PAVEMENT, ROAD_TOP } from '@/config/roadConfig';
import { RAIL_HEAD_LIFT, TRAIN } from '@/config/trainConfig';
import {
  LANE_WIDTH, PIER_END_LINKED, RAIL, RAIL_CROSSINGS, RAIL_CULVERTS, RAIL_CUTS, RAIL_FLAT, RAIL_GAP, RAIL_LENGTH,
  RAIL_MARKS, RAIL_STATIONS, SITE, SKYLARK_FORECOURT, alongRoad, cutRoadSamples, groundAt, railAt, railNear, roadByName,
  type RailCrossing, type RoadSample,
} from '@/config/countryConfig';
import { RAIL_STEEL, buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { SLEEPER_GEOMETRY, SLEEPER_MATERIAL } from './sleeper';
import { InstancedField } from './instancedField';

/**
 * The Skylark line: a double-track branch from a halt on Halcyon Field,
 * over a girder bridge beside the road viaduct, right round the island in
 * cuttings and on the flat, and out over a second bridge to a pier at the
 * Petrel shore.
 *
 * Everything here is built once from `countryConfig`'s `RAIL`, the way the
 * main line is built from `trainConfig`'s route, and the same pieces are
 * used wherever there is one to use: the main line's sleeper, its rail
 * section, its rail steel, its loft. What is new is what the island needed:
 *
 * - **Ground, not viaduct.** On the island the formation is the ground —
 *   `groundAt` holds it flat across `RAIL_FLAT` and batters the sides out as
 *   steep as the cut is deep — so the ballast sits on earth everywhere and
 *   the two bridges are the two places there is no earth to sit on.
 * - **Level crossings.** Five roads cross the line on the flat. The road's
 *   own surface stops at the crossing's panels (`railCrossingAt`), a deck
 *   fills the gap flush with the rail head, and a pair of half-barriers
 *   drop for anything coming.
 * - **One station**, Skylark, on the south side above the vineyard, with
 *   side platforms outside the pair of tracks — 4.6 m between track centres
 *   is not room for an island platform — and buffer stops at the pier end.
 *   The other end is not an end: it is the joint with the airport's trunk,
 *   out on the west bridge, and the rails carry straight on through it.
 * - **No trains of its own.** The HST shuttle and the Class 08 goods that
 *   used to work it were taken off: the line is now part of the player's
 *   route, from the main line's junction branch round the island and on to
 *   the airport trunk, and trains of its own would only be in the way. The
 *   level crossings work for the player's train instead (`crossingBusy`).
 *
 * Mounted at the scene root; the static parts live in a group at the
 * island's centre.
 */

/* ------------------------------------------------------------ heights */

// Measured down from the rail head, which is what every sample's `y` is.
const SLEEPER_TOP = -TRAIN.railHeight;
const SLEEPER_BOTTOM = SLEEPER_TOP - TRAIN.sleeperHeight;
/** The formation: `RAIL_HEAD_LIFT` under the head, and the island's ground. */
const FORMATION = -RAIL_HEAD_LIFT;
const V_SCALE = 9;

/** The two roads, as metres left of the pair's centre. */
const TRACKS: readonly number[] = [RAIL_GAP / 2, -RAIL_GAP / 2];

interface Sample extends LoftSample {
  tx: number;
  tz: number;
  /** Metres of bank under the formation where the ground is lower than it. */
  fill: number;
}

const onWestBridge = (arc: number) => arc > RAIL_MARKS.airportShore && arc < RAIL_MARKS.landfall;
const onEastBridge = (arc: number) => arc > RAIL_MARKS.eastShore;
const onBridge = (arc: number) => onWestBridge(arc) || onEastBridge(arc);

/**
 * The line at rail-head height. On the airfield the formation stands a
 * little over the crown, so the ballast carries a bank there; on the island
 * the carve has already brought the ground to the formation, and on the
 * decks the ballast sits on the deck.
 */
const HEAD: Sample[] = RAIL.map((sm) => ({
  x: sm.x, z: sm.z, y: sm.y + RAIL_HEAD_LIFT, nx: sm.nx, nz: sm.nz, tx: sm.tx, tz: sm.tz, arc: sm.arc,
  fill: sm.arc <= RAIL_MARKS.airportShore ? Math.max(0, sm.y - AIRPORT_SITE.ground) : 0,
}));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/* ------------------------------------------------------------ ballast */

/** Shoulder to shoulder for the pair: the main line's crown half, each side of both tracks. */
const CROWN_HALF = RAIL_GAP / 2 + TRAIN.ballastCrownHalf;
const drop = (s: Sample) => TRAIN.ballastDepth + s.fill + 0.06;
const toe = (s: Sample) => CROWN_HALF + TRAIN.ballastSlope * drop(s);
const BALLAST_PROFILE: ProfileVertex<Sample>[] = [
  { off: (s) => -toe(s), rise: (s) => SLEEPER_BOTTOM - drop(s) },
  { off: -CROWN_HALF, rise: SLEEPER_BOTTOM },
  { off: CROWN_HALF, rise: SLEEPER_BOTTOM },
  { off: (s) => toe(s), rise: (s) => SLEEPER_BOTTOM - drop(s) },
];

/** The main line's stone, tile for tile. */
export function makeBallastTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#6e665d';
  ctx.fillRect(0, 0, size, size);
  let seed = 20260921;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 9000; i++) {
    const shade = 70 + Math.floor(random() * 90);
    const warm = Math.floor(random() * 14);
    ctx.fillStyle = `rgb(${shade + warm}, ${shade + warm / 2}, ${shade})`;
    const r = 1.5 + random() * 3.5;
    ctx.beginPath();
    ctx.ellipse(random() * size, random() * size, r, r * (0.6 + random() * 0.6), random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1, V_SCALE);
  texture.anisotropy = 4;
  return texture;
}

/* --------------------------------------------------------------- rails */

/** The main line's flat-bottom rail, about `centre`, head at rise 0. */
const railProfile = (centre: number): ProfileVertex<Sample>[] => {
  const head = 0.036;
  const web = 0.011;
  const foot = 0.075;
  const headDepth = 0.05;
  const footDepth = 0.03;
  const top = 0;
  const bottom = SLEEPER_TOP;
  return [
    { off: centre - head, rise: top },
    { off: centre + head, rise: top },
    { off: centre + head, rise: top - headDepth },
    { off: centre + web, rise: top - headDepth - 0.012 },
    { off: centre + web, rise: bottom + footDepth + 0.01 },
    { off: centre + foot, rise: bottom + footDepth },
    { off: centre + foot, rise: bottom },
    { off: centre - foot, rise: bottom },
    { off: centre - foot, rise: bottom + footDepth },
    { off: centre - web, rise: bottom + footDepth + 0.01 },
    { off: centre - web, rise: top - headDepth - 0.012 },
    { off: centre - head, rise: top - headDepth },
  ];
};

function buildRails(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const lat of TRACKS) {
    for (const side of [-1, 1]) {
      parts.push(buildLoft(HEAD, railProfile(lat + side * TRAIN.gauge / 2), { vScale: V_SCALE, closed: true }).geometry);
    }
  }
  return merge(parts);
}

/** A sleeper every `TRAIN.sleeperSpacing` on each road, squared to its own centreline. */
function buildSleepers(): Matrix4[] {
  const out: Matrix4[] = [];
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const euler = new Euler();
  const count = Math.floor(RAIL_LENGTH / TRAIN.sleeperSpacing);
  for (const lat of TRACKS) {
    for (let i = 0; i <= count; i++) {
      const arc = i * TRAIN.sleeperSpacing;
      const p = railAt(arc);
      euler.set(0, Math.atan2(p.tx, p.tz), 0);
      quaternion.setFromEuler(euler);
      position.set(p.x + p.nx * lat, p.y + RAIL_HEAD_LIFT + SLEEPER_BOTTOM, p.z + p.nz * lat);
      out.push(new Matrix4().compose(position, quaternion, scale));
    }
  }
  return out;
}

/* ------------------------------------------------------------- bridges */

/**
 * The two bridges: a concrete box girder wide enough for both tracks, with
 * a parapet up each side, on single piers. The east one widens past the
 * shore into the pier, so Petrel's platforms stand on the deck inside the
 * parapets.
 */
const BRIDGE_HALF = 5.6;
const PARAPET = 0.34;
const PARAPET_TOP = 0.55;
const DECK_TOP = FORMATION;
const DECK_DEPTH = 1.7;
const CHAMFER = 0.5;
const SEABED = -10;
const PIER_PITCH = 24;

const deckHalf = (_s: Sample) => BRIDGE_HALF;
const DECK_PROFILE: ProfileVertex<Sample>[] = [
  { off: (s) => -deckHalf(s), rise: PARAPET_TOP },
  { off: (s) => -deckHalf(s) + PARAPET, rise: PARAPET_TOP },
  { off: (s) => -deckHalf(s) + PARAPET, rise: DECK_TOP },
  { off: (s) => deckHalf(s) - PARAPET, rise: DECK_TOP },
  { off: (s) => deckHalf(s) - PARAPET, rise: PARAPET_TOP },
  { off: (s) => deckHalf(s), rise: PARAPET_TOP },
  { off: (s) => deckHalf(s), rise: DECK_TOP - DECK_DEPTH + CHAMFER },
  { off: (s) => deckHalf(s) - CHAMFER, rise: DECK_TOP - DECK_DEPTH },
  { off: (s) => -deckHalf(s) + CHAMFER, rise: DECK_TOP - DECK_DEPTH },
  { off: (s) => -deckHalf(s), rise: DECK_TOP - DECK_DEPTH + CHAMFER },
];

function part(x: number, z: number, y: number, yaw: number, w: number, h: number, d: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  // An empty list is a real case now — the pier end's buffers are gone when
  // the line runs on (`PIER_END_LINKED`) — and `mergeGeometries([])` throws.
  if (!parts.length) return new BufferGeometry();
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  if (!merged) throw new Error('CountryRail: merge failed');
  for (const g of flat) g.dispose();
  return merged;
}

function buildBridges() {
  // The east bridge is gone: the junction branch's viaduct carries the line
  // from the old pier end to the shore now (`PIER_END_LINKED`, `BranchLine`).
  const spans: Array<[number, number]> = [
    [RAIL_MARKS.airportShore, RAIL_MARKS.landfall],
    ...(PIER_END_LINKED ? [] : [[RAIL_MARKS.eastShore, RAIL_MARKS.pierEnd] as [number, number]]),
  ];
  const deck = buildLoft(HEAD, DECK_PROFILE, {
    closed: true,
    vScale: V_SCALE,
    filter: (a, b) => spans.some(([from, to]) => a.arc >= from - 0.1 && b.arc <= to + 0.1),
  });
  const masonry: BufferGeometry[] = [];
  for (const [from, to] of spans) {
    // Piers, from the seabed to the soffit, the width of the deck less its
    // chamfers; the pier's own last span carries a pair.
    for (let arc = from + 14; arc < to - 6; arc += PIER_PITCH) {
      const p = railAt(arc);
      const sm = HEAD[Math.min(HEAD.length - 1, Math.round(arc / 3))];
      const soffit = p.y + RAIL_HEAD_LIFT + DECK_TOP - DECK_DEPTH + 0.15;
      const yaw = Math.atan2(p.tx, p.tz);
      const wide = deckHalf(sm) * 2 - CHAMFER * 2 - 0.4;
      masonry.push(part(p.x, p.z, (soffit + SEABED) / 2, yaw, wide, soffit - SEABED, 1.6));
    }
    // Abutments: a block behind each shore end, so the girder's open end is
    // in the ground and not on show.
    for (const [arc, inward] of [[from, -1], [to, 1]] as const) {
      if (arc >= RAIL_MARKS.pierEnd - 1) continue;
      const p = railAt(arc + inward * 1.8);
      const top = p.y + RAIL_HEAD_LIFT + DECK_TOP + 0.02;
      masonry.push(part(p.x, p.z, (top - 7) / 2, Math.atan2(p.tx, p.tz), BRIDGE_HALF * 2 + 1.2, top + 7, 3.6));
    }
  }
  // The pier's end: a wall across the deck under the buffer stops — left off
  // now the line runs on there, onto the junction branch's own deck.
  const end = railAt(RAIL_LENGTH - 0.4);
  if (!PIER_END_LINKED) masonry.push(part(end.x, end.z, (end.y + RAIL_HEAD_LIFT + PARAPET_TOP + SEABED) / 2, Math.atan2(end.tx, end.tz),
    BRIDGE_HALF * 2, end.y + RAIL_HEAD_LIFT + PARAPET_TOP - SEABED, 0.8));
  return { deck, masonry: merge(masonry) };
}

/* ------------------------------------------------------------ stations */

const PLATFORM_EDGE = 3.85;
const PLATFORM_OUTER = 7.05;
const PLATFORM_TOP = 0.92;
const PLATFORM_BASE = FORMATION - 0.35;
const COPING = 0.55;
const RAMP = 7;

function boardTexture(name: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(0, 0, 512, 112);
  ctx.fillStyle = '#1d3a5f';
  ctx.fillRect(0, 0, 512, 12);
  ctx.fillRect(0, 100, 512, 12);
  ctx.font = 'bold 54px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.toUpperCase(), 256, 58);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

interface Furniture {
  x: number;
  z: number;
  y: number;
  yaw: number;
}

interface StationBuild {
  concrete: BufferGeometry;
  coping: BufferGeometry;
  yellow: BufferGeometry;
  steel: BufferGeometry;
  timber: BufferGeometry;
  roof: BufferGeometry;
  glass: BufferGeometry;
  bloom: BufferGeometry;
  boards: Array<Furniture & { name: string }>;
  buffers: BufferGeometry;
  /** Box colliders for what stands at the station: the ticket hall, lamps, sign posts. */
  solids: Array<{ x: number; y: number; z: number; half: [number, number, number]; yaw: number }>;
}

function buildStations(): StationBuild {
  const concrete: BufferGeometry[] = [];
  const coping: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const timber: BufferGeometry[] = [];
  const roof: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const bloom: BufferGeometry[] = [];
  const buffers: BufferGeometry[] = [];
  const boards: Array<Furniture & { name: string }> = [];
  const solids: StationBuild['solids'] = [];

  for (const st of RAIL_STATIONS) {
    const within = (a: Sample, b: Sample) => a.arc >= st.from - 0.1 && b.arc <= st.to + 0.1;
    /** The surface, ramping down over the last `RAMP` metres at each end. */
    const top = (s: Sample) => PLATFORM_TOP - 0.7 * Math.max(0, 1 - Math.min(s.arc - st.from, st.to - s.arc) / RAMP);
    const mid = railAt((st.from + st.to) / 2);
    const yaw = Math.atan2(mid.tx, mid.tz);
    const head = mid.y + RAIL_HEAD_LIFT;
    /** Island metres for a point `along` the platform and `across` it (left positive). */
    const at = (along: number, across: number): [number, number] => [
      mid.x + mid.tx * along + mid.nx * across, mid.z + mid.tz * along + mid.nz * across,
    ];

    for (const side of [-1, 1] as const) {
      const built = st.building === side;
      const outer = built ? PLATFORM_OUTER + 6 : PLATFORM_OUTER;
      const box = (a: number, b: number, lo: ProfileVertex<Sample>['rise'], hi: ProfileVertex<Sample>['rise']): ProfileVertex<Sample>[] => [
        { off: side * a, rise: lo }, { off: side * b, rise: lo }, { off: side * b, rise: hi }, { off: side * a, rise: hi },
      ];
      concrete.push(buildLoft(HEAD, box(PLATFORM_EDGE, outer, PLATFORM_BASE, top), { closed: true, filter: within, vScale: 4 }).geometry);
      coping.push(buildLoft(HEAD, box(PLATFORM_EDGE, PLATFORM_EDGE + COPING, (s) => top(s) - 0.01, (s) => top(s) + 0.025), { closed: true, filter: within }).geometry);
      yellow.push(buildLoft(HEAD, box(PLATFORM_EDGE + 0.72, PLATFORM_EDGE + 0.84, (s) => top(s) + 0.02, (s) => top(s) + 0.034), { closed: true, filter: within }).geometry);
      // End walls, where the ramps stop.
      for (const arc of [st.from, st.to]) {
        const p = railAt(arc);
        const [x, z] = [p.x + p.nx * side * (PLATFORM_EDGE + outer) / 2, p.z + p.nz * side * (PLATFORM_EDGE + outer) / 2];
        const topY = p.y + RAIL_HEAD_LIFT + PLATFORM_TOP - 0.7;
        const baseY = p.y + RAIL_HEAD_LIFT + PLATFORM_BASE;
        concrete.push(part(x, z, (topY + baseY) / 2, Math.atan2(p.tx, p.tz), outer - PLATFORM_EDGE, topY - baseY, 0.24));
      }

      const deck = head + PLATFORM_TOP;
      const half = (st.to - st.from) / 2;
      // Lamps, every 22 m, standing at the back of the platform.
      for (let along = -half + RAMP + 4; along <= half - RAMP - 4; along += 22) {
        const [x, z] = at(along, side * (PLATFORM_OUTER - 0.45));
        steel.push(new CylinderGeometry(0.035, 0.05, 3.4, 8).translate(x, deck + 1.7, z));
        bloom.push(part(x - mid.nx * side * 0.2, z - mid.nz * side * 0.2, deck + 3.38, yaw, 0.36, 0.08, 0.18));
      }
      // The name, on two posts, in the middle, facing the track.
      {
        const [x, z] = at(built ? -14 : 0, side * (PLATFORM_OUTER - 0.5));
        boards.push({ x, z, y: deck + 2.35, yaw: yaw + (side > 0 ? Math.PI : 0), name: st.name });
        for (const k of [-1.3, 1.3]) {
          const [px, pz] = [x + mid.tx * k, z + mid.tz * k];
          steel.push(part(px, pz, deck + 1.3, yaw, 0.08, 2.6, 0.08));
        }
      }
      // A bench or two.
      for (const along of built ? [-20] : [-16, 24]) {
        const [x, z] = at(along, side * (PLATFORM_OUTER - 0.7));
        timber.push(part(x, z, deck + 0.45, yaw, 0.45, 0.06, 1.8));
        timber.push(part(x + mid.nx * side * 0.22, z + mid.nz * side * 0.22, deck + 0.7, yaw, 0.06, 0.5, 1.8));
        for (const k of [-0.8, 0.8]) steel.push(part(x + mid.tx * k, z + mid.tz * k, deck + 0.22, yaw, 0.4, 0.44, 0.06));
      }

      // The shelter: a minimal pavilion. A thin dark roof floating on four
      // slim posts, well over the platform, a low timber slat wall along the
      // back and a glazed windbreak above it, so from the platform you look
      // out through it at the downs and the sea. Longer on the building
      // side, where it also carries a planter or two; nothing else.
      {
        const len = built ? 16 : 8;
        const deep = 3.0;
        const centre = built ? 4 : 10;
        const cx = side * (PLATFORM_OUTER - 0.3 - deep / 2 + 0.6);
        const [x, z] = at(centre, cx);
        const roofY = deck + 3.05;
        const slab = new BoxGeometry(deep + 1.6, 0.14, len + 1.2);
        slab.rotateZ(side * 0.04);
        slab.rotateY(yaw);
        slab.translate(x - mid.nx * side * 0.3, roofY, z - mid.nz * side * 0.3);
        roof.push(slab);
        for (const k of [-1, 1]) {
          steel.push(part(x + mid.tx * k * (len / 2 + 0.55), z + mid.tz * k * (len / 2 + 0.55), roofY - 0.02, yaw, deep + 1.6, 0.22, 0.06));
        }
        for (const along of [-len / 2 + 0.6, len / 2 - 0.6]) {
          for (const across of [side * (PLATFORM_EDGE + 1.1), side * (PLATFORM_OUTER - 0.5)]) {
            const [px, pz] = at(centre + along, across);
            steel.push(part(px, pz, deck + 1.5, yaw, 0.11, 3.0, 0.11));
          }
        }
        const back = side * (PLATFORM_OUTER - 0.35);
        const [bx, bz] = at(centre, back);
        for (let k = 0; k < 5; k++) timber.push(part(bx, bz, deck + 0.25 + k * 0.22, yaw, 0.05, 0.12, len - 0.4));
        for (const along of [-len / 2 + 0.5, 0, len / 2 - 0.5]) {
          const [px, pz] = at(centre + along, back);
          timber.push(part(px, pz, deck + 0.7, yaw, 0.08, 1.4, 0.08));
        }
        glass.push(part(bx, bz, deck + 2.2, yaw, 0.03, 1.6, len - 0.4));
        for (const along of [-len / 4, len / 4]) {
          const [sx, sz] = at(centre + along, side * (PLATFORM_OUTER - 1.3));
          timber.push(part(sx, sz, deck + 0.45, yaw, 0.5, 0.06, 1.9));
          for (const k of [-0.85, 0.85]) steel.push(part(sx + mid.tx * k, sz + mid.tz * k, deck + 0.22, yaw, 0.44, 0.44, 0.05));
        }
        if (built) {
          for (const along of [-len / 2 - 3, -len / 2 - 5.5, len / 2 + 3, len / 2 + 5.5]) {
            const [px, pz] = at(centre + along, side * (PLATFORM_OUTER - 0.75));
            timber.push(part(px, pz, deck + 0.28, yaw, 0.9, 0.56, 1.3));
            bloom.push(part(px, pz, deck + 0.62, yaw, 0.7, 0.14, 1.1));
          }
        }
      }

      /*
       * The ticket hall, and the forecourt behind it.
       *
       * Small, and in the shelter's own language: a timber-clad box on the
       * built platform's extra width, glazed both ways, under the same thin
       * dark roof floating a little proud of it. Its doors open onto the
       * forecourt — levelled just under the platform (`SKYLARK_FORECOURT`) —
       * where the approach road arrives, with a handful of bays along the sea
       * side, three lamps, and the boarding circle in the middle.
       */
      if (built) {
        const F = SKYLARK_FORECOURT;
        const hallMid = 22;
        const hallLen = 14;
        const inner = PLATFORM_OUTER + 0.55;
        const outerFace = PLATFORM_OUTER + 6 - 0.35;
        const hallDeep = outerFace - inner;
        const hallC = (inner + outerFace) / 2;
        const wallH = 3.0;
        const floor = deck + 0.2;
        const [hx, hz] = at(hallMid, side * hallC);
        concrete.push(part(hx, hz, deck + 0.1, yaw, hallDeep + 0.3, 0.2, hallLen + 0.3));
        timber.push(part(hx, hz, floor + wallH / 2, yaw, hallDeep, wallH, hallLen));
        // Vertical battens down both long faces: the slats that make it read
        // as timber from the train, not a brown box.
        for (const [face, out] of [[inner, -1], [outerFace, 1]] as const) {
          for (let a = -hallLen / 2 + 0.4; a <= hallLen / 2 - 0.4; a += 0.55) {
            const [bx, bz] = at(hallMid + a, side * (face + out * 0.04));
            timber.push(part(bx, bz, floor + wallH / 2, yaw, 0.06, wallH, 0.07));
          }
        }
        /** A framed pane set into a long face. */
        const pane = (a: number, face: number, out: 1 | -1, w: number, h: number, y: number) => {
          const [px, pz] = at(hallMid + a, side * (face + out * 0.09));
          glass.push(part(px, pz, y, yaw, 0.04, h, w));
          for (const k of [-1, 1]) {
            steel.push(part(px, pz, y + k * (h / 2 + 0.04), yaw, 0.08, 0.08, w + 0.16));
            const [qx, qz] = at(hallMid + a + k * (w / 2 + 0.04), side * (face + out * 0.09));
            steel.push(part(qx, qz, y, yaw, 0.08, h + 0.16, 0.08));
          }
        };
        for (const a of [-4.5, 0, 4.5]) pane(a, inner, -1, 2.6, 1.5, floor + 1.55);
        for (const a of [-4.5, 4.5]) pane(a, outerFace, 1, 2.6, 1.5, floor + 1.55);
        pane(0, outerFace, 1, 1.9, 2.3, floor + 1.15);
        const roofY = floor + wallH + 0.1;
        const slab = new BoxGeometry(hallDeep + 3.2, 0.16, hallLen + 1.4);
        slab.rotateZ(side * 0.04);
        slab.rotateY(yaw);
        slab.translate(hx, roofY, hz);
        roof.push(slab);
        // The name over the doors, facing the forecourt.
        {
          const [fx, fz] = at(hallMid, side * (outerFace + 0.14));
          boards.push({ x: fx, z: fz, y: floor + wallH - 0.4, yaw: yaw - side * Math.PI / 2, name: st.name });
        }
        solids.push({ x: hx, y: floor + wallH / 2, z: hz, half: [hallDeep / 2, wallH / 2 + 0.1, hallLen / 2], yaw });

        // Planters either side of the doors, and a bench.
        for (const a of [-2.2, 2.2]) {
          const [px, pz] = at(hallMid + a, side * (outerFace + 1.0));
          timber.push(part(px, pz, F.y + 0.3, yaw, 0.9, 0.6, 1.3));
          bloom.push(part(px, pz, F.y + 0.64, yaw, 0.7, 0.12, 1.1));
        }
        {
          const [bx, bz] = at(hallMid + 5.6, side * (outerFace + 0.9));
          timber.push(part(bx, bz, F.y + 0.45, yaw, 0.45, 0.06, 1.8));
          timber.push(part(bx - mid.nx * side * 0.22, bz - mid.nz * side * 0.22, F.y + 0.7, yaw, 0.06, 0.5, 1.8));
          for (const k of [-0.8, 0.8]) steel.push(part(bx + mid.tx * k, bz + mid.tz * k, F.y + 0.22, yaw, 0.4, 0.44, 0.06));
        }

        // The bays: white lines across the sea-side strip, and a kerb behind them.
        for (let a = 20; a <= F.to - 4; a += 2.6) {
          const [lx, lz] = at(a, side * (F.far - 2.5));
          coping.push(part(lx, lz, F.y + 0.012, yaw, 5, 0.02, 0.1));
        }
        {
          const [kx, kz] = at((F.from + F.to) / 2, side * (F.far + 0.15));
          concrete.push(part(kx, kz, F.y + 0.07, yaw, 0.3, 0.16, F.to - F.from));
        }
        // Three lamps along the kerb.
        for (const a of [16, 36, 56]) {
          const [lx, lz] = at(a, side * (F.far + 0.6));
          steel.push(new CylinderGeometry(0.06, 0.08, 5, 8).translate(lx, F.y + 2.5, lz));
          const [ax, az] = at(a, side * (F.far - 0.2));
          steel.push(part(ax, az, F.y + 4.95, yaw, 1.6, 0.08, 0.08));
          bloom.push(part(ax - mid.nx * side * 0.5, az - mid.nz * side * 0.5, F.y + 4.86, yaw, 0.5, 0.08, 0.26));
          solids.push({ x: lx, y: F.y + 2.5, z: lz, half: [0.1, 2.5, 0.1], yaw });
        }
        // The sign where the road comes in, facing it.
        {
          const [sx, sz] = at(F.to - 1, side * (F.far - 4.5));
          boards.push({ x: sx, z: sz, y: F.y + 2.1, yaw, name: st.name });
          for (const k of [-1.15, 1.15]) {
            const px = sx + mid.nx * side * k;
            const pz = sz + mid.nz * side * k;
            steel.push(part(px, pz, F.y + 1.1, yaw, 0.08, 2.2, 0.08));
            solids.push({ x: px, y: F.y + 1.1, z: pz, half: [0.05, 1.1, 0.05], yaw });
          }
        }
      }
    }

  }
  // Buffer stops on both roads at the pier end: a beam across the rails on two
  // posts, each with a strut raked back toward the line. Only the pier end —
  // the line's other end is the joint with Halcyon Field's trunk, and the
  // track runs on through it.
  // Not any more: the junction branch off the main viaduct runs on through
  // the pier end (`PIER_END_LINKED`), so there is nothing to stop against.
  for (const [arc, inward] of PIER_END_LINKED ? [] : [[RAIL_LENGTH - 2.5, -1] as const]) {
    const p = railAt(arc);
    const pyaw = Math.atan2(p.tx, p.tz);
    for (const lat of TRACKS) {
      const [x, z] = [p.x + p.nx * lat, p.z + p.nz * lat];
      const y = p.y + RAIL_HEAD_LIFT;
      buffers.push(part(x, z, y + 0.95, pyaw, 2.2, 0.32, 0.3));
      for (const k of [-0.8, 0.8]) {
        buffers.push(part(x + p.nx * k, z + p.nz * k, y + 0.45, pyaw, 0.22, 1.1, 0.24));
        buffers.push(part(x + p.nx * k + p.tx * inward * 0.9, z + p.nz * k + p.tz * inward * 0.9, y + 0.45, pyaw, 0.18, 0.18, 2.0));
      }
    }
  }
  return {
    concrete: merge(concrete), coping: merge(coping), yellow: merge(yellow), steel: merge(steel),
    timber: merge(timber), roof: merge(roof), glass: merge(glass), bloom: merge(bloom), buffers: merge(buffers), boards,
    solids,
  };
}

/* ------------------------------------------------------------ crossings */

/** How far before the rails a barrier stands on each approach, before the walk back. */
const BARRIER_BACK = { lane: 9.5, mini: 7 } as const;

interface BarrierSpec {
  crossing: RailCrossing;
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** +1 guards traffic arriving along the road's tangent, −1 the other way. */
  sigma: 1 | -1;
  arm: number;
}

interface CrossingBuild {
  /** The wedge under the road across the rail band, concrete. */
  aprons: BufferGeometry;
  /** The crossing surface between the cut edges, panelled. */
  panels: BufferGeometry;
  /** The slot either side of each rail through the panels. */
  flangeways: BufferGeometry;
  /** Stop lines. */
  paint: BufferGeometry;
  posts: BufferGeometry;
  signBacks: BufferGeometry;
  signFaces: BufferGeometry;
  barriers: BarrierSpec[];
  /** One solid box under each crossing's panels, so nothing drives through the cut. */
  decks: Array<{ x: number; z: number; y: number; yaw: number; half: [number, number, number] }>;
}

/**
 * The crossing's surface: concrete panels, 1.2 m across the road and 2.4 m
 * along it, with a dark joint between every pair. One tile is two panels
 * each way, so the loft's V repeat is 2.4 m and its U is metres over 2.4.
 */
function makePanelTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#5e5c58';
  ctx.fillRect(0, 0, size, size);
  let seed = 20260922;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 5000; i++) {
    const v = 95 + Math.floor(random() * 40);
    ctx.fillStyle = `rgb(${v + 4}, ${v + 2}, ${v})`;
    ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
  }
  ctx.fillStyle = '#4a4946';
  for (const k of [0, 128]) {
    ctx.fillRect(k - 2, 0, 4, size);
    ctx.fillRect(0, k - 2, size, 4);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (const k of [0, 128]) {
    ctx.fillRect(k + 2, 0, 2, size);
    ctx.fillRect(0, k + 2, size, 2);
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1 / 2.4, 1);
  texture.anisotropy = 4;
  return texture;
}

function buildCrossings(): CrossingBuild {
  const aprons: BufferGeometry[] = [];
  const panels: BufferGeometry[] = [];
  const flangeways: BufferGeometry[] = [];
  const paint: BufferGeometry[] = [];
  const posts: BufferGeometry[] = [];
  const signBacks: BufferGeometry[] = [];
  const signFaces: BufferGeometry[] = [];
  const barriers: BarrierSpec[] = [];
  const decks: CrossingBuild['decks'] = [];
  const toLoft = (sm: RoadSample): LoftSample => ({
    x: sm.x, z: sm.z, y: sm.y + ROAD_TOP, nx: sm.nx, nz: sm.nz, arc: sm.arc,
  });
  for (const c of RAIL_CROSSINGS) {
    const road = roadByName(c.road);
    const S = cutRoadSamples(road);
    const w = road.width + 0.6;

    // The apron: the road's own samples across the whole rail band, as a
    // solid from under the formation to just below the road's surface. The
    // road runs over the formation here, a metre above the carved ground,
    // and this is what fills the wedge under it.
    let i0 = 0;
    let best = Infinity;
    S.forEach((sm, i) => { const d = Math.abs(sm.arc - c.roadS); if (d < best) { best = d; i0 = i; } });
    const onBand = (i: number) => railNear(S[i].x, S[i].z).d < RAIL_FLAT + 7.5;
    let a = i0;
    let b = i0;
    while (a > 0 && onBand(a - 1)) a--;
    while (b < S.length - 1 && onBand(b + 1)) b++;
    aprons.push(buildLoft(S.slice(a, b + 1).map(toLoft), [
      { off: w / 2, rise: -1.4 }, { off: -w / 2, rise: -1.4 }, { off: -w / 2, rise: -0.03 }, { off: w / 2, rise: -0.03 },
    ], { closed: true, vScale: 4 }).geometry);

    // The panels: exactly the road's cut, 12 mm under the rail head so the
    // rails stand proud of them the way they do through a real crossing.
    const cut = (RAIL_CUTS.get(c.road) ?? []).find(([s1, s2]) => c.roadS >= s1 - 1 && c.roadS <= s2 + 1);
    if (cut) {
      const inside = S.filter((sm) => sm.arc >= cut[0] - 1e-3 && sm.arc <= cut[1] + 1e-3).map(toLoft);
      // 35 mm under the rail head, so the rails stand out of the panels as
      // two steel lines and the track reads as running THROUGH the road
      // rather than being cut by it.
      panels.push(buildLoft(inside, [{ off: w / 2, rise: -0.035 }, { off: -w / 2, rise: -0.035 }], { vScale: 2.4 }).geometry);
      const mid = alongRoad(road, (cut[0] + cut[1]) / 2);
      decks.push({
        x: mid.x, z: mid.z, y: mid.y + ROAD_TOP - 0.035 - 0.4, yaw: Math.atan2(mid.tx, mid.tz),
        half: [w / 2 + 0.3, 0.4, (cut[1] - cut[0]) / 2 + 1.5],
      });
    }

    // Flangeways: a dark slot along each side of each rail, the length of
    // the panels — which on a skewed crossing is the road's width over the
    // sine of the angle.
    const at = alongRoad(road, c.roadS);
    const sinA = Math.max(0.35, Math.abs(at.tx * c.tz - at.tz * c.tx));
    const halfAlong = (w / 2) / sinA + 0.6;
    const window = (p: Sample, q: Sample) => Math.abs((p.arc + q.arc) / 2 - c.s) < halfAlong;
    for (const lat of TRACKS) {
      for (const side of [-1, 1]) {
        for (const k of [-1, 1]) {
          const centre = lat + side * TRAIN.gauge / 2 + k * 0.13;
          flangeways.push(buildLoft(HEAD, [
            { off: centre + 0.07, rise: -0.028 }, { off: centre - 0.07, rise: -0.028 },
          ], { filter: window }).geometry);
        }
      }
    }

    // Half-barriers: one each approach, pivoted on the approaching traffic's
    // right-hand verge and reaching to the crown of the road — the far lane
    // stays open, which is what a half-barrier is. A single-track lane gets
    // the whole road closed, there being only one lane to close.
    const lane = road.cls === 'lane';
    const carriageway = lane ? LANE_WIDTH * (1 - 2 * ROAD_PAVEMENT) : road.width;
    const pivot = carriageway / 2 + 0.45;
    const arm = lane ? carriageway / 2 + 0.6 : carriageway + 0.6;
    for (const sigma of [1, -1] as const) {
      // Walked back from the rails until both the post and the arm's tip are
      // clear of the formation: on a square crossing that is the standing
      // distance, on a skewed one the post on the acute side is a good deal
      // further back than the one across the road from it.
      let back = (lane ? BARRIER_BACK.lane : BARRIER_BACK.mini) - 0.5;
      let p = alongRoad(road, c.roadS - sigma * back);
      for (let tries = 0; tries < 120; tries++) {
        back += 0.5;
        p = alongRoad(road, c.roadS - sigma * back);
        const post = railNear(p.x - p.nx * sigma * pivot, p.z - p.nz * sigma * pivot).d;
        const tip = railNear(p.x - p.nx * sigma * (pivot - arm), p.z - p.nz * sigma * (pivot - arm)).d;
        if (Math.min(post, tip) >= RAIL_FLAT + 1.2) break;
      }
      barriers.push({
        crossing: c,
        x: p.x - p.nx * sigma * pivot,
        z: p.z - p.nz * sigma * pivot,
        y: p.y + ROAD_TOP,
        yaw: Math.atan2(p.tx, p.tz),
        sigma,
        arm,
      });

      // The stop line, across the closed lane two metres short of the arm.
      const q = alongRoad(road, c.roadS - sigma * (back + 2.2));
      const lateral = -sigma * (pivot - arm / 2);
      paint.push(part(q.x + q.nx * lateral, q.z + q.nz * lateral, q.y + ROAD_TOP + 0.012, Math.atan2(q.tx, q.tz), arm - 0.4, 0.024, 0.4));

      // The warning: a yellow diamond on a post on the right verge, thirty
      // metres out, facing the traffic it warns.
      const g = alongRoad(road, c.roadS - sigma * (back + 26));
      const gyaw = Math.atan2(g.tx, g.tz);
      const gl = -sigma * (pivot + 0.4);
      const gx = g.x + g.nx * gl;
      const gz = g.z + g.nz * gl;
      const gy = Math.max(groundAt(gx, gz), g.y + ROAD_TOP - 0.2);
      posts.push(part(gx, gz, gy + 1.5, gyaw, 0.09, 3.0, 0.09));
      const diamond = (size: number, thick: number, along: number) => {
        const d = new BoxGeometry(size, size, thick);
        d.rotateZ(Math.PI / 4);
        d.rotateY(gyaw);
        d.translate(gx - g.tx * sigma * along, gy + 2.55, gz - g.tz * sigma * along);
        return d;
      };
      signBacks.push(diamond(0.84, 0.04, 0));
      signFaces.push(diamond(0.7, 0.05, 0.012));
    }
  }
  return {
    aprons: merge(aprons), panels: merge(panels), flangeways: merge(flangeways), paint: merge(paint),
    posts: merge(posts), signBacks: merge(signBacks), signFaces: merge(signFaces), barriers, decks,
  };
}

/* ------------------------------------------------------------- culverts */

function buildCulverts(): { stone: BufferGeometry; pipes: BufferGeometry } {
  const stone: BufferGeometry[] = [];
  const pipes: BufferGeometry[] = [];
  for (const c of RAIL_CULVERTS) {
    const p = railAt(c.s);
    const yaw = Math.atan2(p.tx, p.tz);
    for (const side of [-1, 1]) {
      const ox = p.x + p.nx * side * (RAIL_FLAT + 0.3);
      const oz = p.z + p.nz * side * (RAIL_FLAT + 0.3);
      const bed = groundAt(p.x + p.nx * side * (RAIL_FLAT + 2.5), p.z + p.nz * side * (RAIL_FLAT + 2.5));
      const bottom = Math.min(bed, p.y) - 0.6;
      const top = p.y + 0.55;
      stone.push(part(ox, oz, (top + bottom) / 2, yaw, 0.7, top - bottom, 5.2));
      // Wing walls, angled out along the bank.
      for (const k of [-1, 1]) {
        const wing = new BoxGeometry(0.5, top - bottom - 0.3, 2.4);
        wing.rotateY(k * 0.7);
        wing.translate(side * 0.9, 0, k * 3.2);
        wing.rotateY(yaw);
        wing.translate(ox, (top + bottom) / 2 - 0.15, oz);
        stone.push(wing);
      }
      const pipe = new CylinderGeometry(0.75, 0.75, 1.2, 14);
      pipe.rotateZ(Math.PI / 2);
      pipe.rotateY(yaw);
      pipe.translate(ox - p.nx * side * 0.2, bottom + 1.0, oz - p.nz * side * 0.2);
      pipes.push(pipe);
    }
  }
  return { stone: merge(stone), pipes: merge(pipes) };
}

/* --------------------------------------------------------------- trains */

/**
 * The player's train, in this line's own arc metres, when it is on the line —
 * for the barriers. It arrives from the junction branch at the pier end
 * running DOWN this line's arc (`livePlayerRoute`, measured along the route
 * from the main line's toe), so the conversion turns it round.
 */
function playerOnLine(): { head: number; dir: 1 | -1; length: number; speed: number } | null {
  const p = livePlayerRoute;
  if (!p.active) return null;
  const head = RAIL_LENGTH - (p.head - BRANCH_ROUTE.branch);
  if (head < -p.length || head > RAIL_LENGTH + p.length) return null;
  return { head, dir: p.dir > 0 ? -1 : 1, length: p.length, speed: p.speed };
}

/**
 * The services out on the branch loop, in this line's arc metres, the way
 * `playerOnLine` gives the player's — their registry reports are metres along
 * the loop from the main line's toe (`trainsOnLoop`).
 */
function servicesOnLine(): Array<{ head: number; dir: 1 | -1; length: number; speed: number }> {
  const out: Array<{ head: number; dir: 1 | -1; length: number; speed: number }> = [];
  for (const t of trainsOnLoop()) {
    if (t.owner === 'player') continue;
    const head = RAIL_LENGTH - (t.arc - BRANCH_ROUTE.branch);
    if (head < -t.length || head > RAIL_LENGTH + t.length) continue;
    out.push({ head, dir: t.direction > 0 ? -1 : 1, length: t.length, speed: t.speed });
  }
  return out;
}

/** Whether a barrier at arc `s` should be down. */
function crossingBusy(s: number): boolean {
  const player = playerOnLine();
  for (const t of player ? [player, ...servicesOnLine()] : servicesOnLine()) {
    const ahead = (s - t.head) * t.dir;
    // Far enough ahead to be down before it arrives, and up once the tail
    // is past; a train standing at a platform does not hold the road.
    if (ahead > 0 && t.speed < 0.2) continue;
    if (ahead < 50 + t.speed * 8 && ahead > -(t.length + 12)) return true;
  }
  return false;
}

/* ------------------------------------------------------------- barriers */

/**
 * Tells the road traffic which crossings it may use (`setCrossingClear`), by
 * the names `roadGraph.countryPolys` gates them on: `skylark-<n>`, the index
 * in `RAIL_CROSSINGS`. Shut the moment the lamps start, not when the arm is
 * down, so a lorry stops at the line rather than under a falling barrier.
 */
function CrossingGates() {
  useFrame(() => {
    RAIL_CROSSINGS.forEach((c, i) => setCrossingClear(!crossingBusy(c.s), `skylark-${i}`));
  });
  return null;
}

function Barrier({ spec }: { spec: BarrierSpec }) {
  const arm = useRef<Group>(null);
  const lamps = useRef<(Mesh | null)[]>([]);
  const up = useRef(1);
  const clock = useRef(0);
  useFrame((_, dt) => {
    const busy = crossingBusy(spec.crossing.s);
    const want = busy ? 0 : 1;
    // Lights first, arm after: the lamps start the moment a train is due,
    // the arm follows over six seconds — down slow, up a little quicker.
    up.current += clamp(want - up.current, -dt / 6, dt / 4);
    if (arm.current) arm.current.rotation.z = -spec.sigma * (Math.PI / 2) * smooth(up.current);
    clock.current += dt;
    const phase = Math.floor(clock.current * 1.6) % 2;
    lamps.current.forEach((lamp, i) => {
      if (!lamp) return;
      const mat = lamp.material as MeshStandardMaterial;
      mat.emissiveIntensity = busy && phase === i ? 2.2 : 0;
    });
  });
  const along = -spec.sigma;
  return (
    <group position={[spec.x, spec.y, spec.z]} rotation={[0, spec.yaw, 0]}>
      {/* The post, the lamp head with its two red lenses, and the cross. */}
      <mesh position={[0, 0.95, 0]} castShadow>
        <boxGeometry args={[0.26, 1.9, 0.26]} />
        <meshStandardMaterial color="#d8d6cf" roughness={0.6} />
      </mesh>
      <mesh position={[0, 2.5, 0]} castShadow>
        <boxGeometry args={[0.7, 0.34, 0.22]} />
        <meshStandardMaterial color="#2a2c30" roughness={0.6} />
      </mesh>
      {[-0.2, 0.2].map((k, i) => (
        <mesh key={i} ref={(m) => { lamps.current[i] = m; }} position={[k, 2.5, -0.13 * spec.sigma]}>
          <sphereGeometry args={[0.1, 10, 8]} />
          <meshStandardMaterial color="#5a0a0a" emissive="#ff2020" emissiveIntensity={0} />
        </mesh>
      ))}
      <mesh position={[0, 3.0, 0]} rotation={[0, 0, Math.PI / 4]}>
        <boxGeometry args={[1.0, 0.16, 0.05]} />
        <meshStandardMaterial color="#f4f1ea" />
      </mesh>
      <mesh position={[0, 3.0, 0]} rotation={[0, 0, -Math.PI / 4]}>
        <boxGeometry args={[1.0, 0.16, 0.05]} />
        <meshStandardMaterial color="#f4f1ea" />
      </mesh>
      {/* The arm, pivoting at the post's head, banded red and white. */}
      <group ref={arm} position={[0, 1.05, 0]}>
        <mesh position={[along * spec.arm / 2, 0, 0]} castShadow>
          <boxGeometry args={[spec.arm, 0.11, 0.11]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.5} />
        </mesh>
        {Array.from({ length: Math.floor(spec.arm / 1.2) }, (_, i) => (
          <mesh key={i} position={[along * (0.6 + i * 1.2), 0, 0]}>
            <boxGeometry args={[0.6, 0.115, 0.115]} />
            <meshStandardMaterial color="#d8261c" roughness={0.5} />
          </mesh>
        ))}
        <mesh position={[along * -0.25, 0, 0]}>
          <boxGeometry args={[0.5, 0.32, 0.32]} />
          <meshStandardMaterial color="#2a2c30" roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------- the line */

export function CountryRail() {
  const built = useMemo(() => {
    // No ballast where the junction branch's viaduct carries the line (from
    // the Skylark shore out, `PIER_END_LINKED`): that deck is slab track, the
    // sleepers sit straight on it, and ballast showed through its edges.
    const ballast = buildLoft(HEAD, BALLAST_PROFILE, {
      vScale: V_SCALE,
      filter: PIER_END_LINKED ? (a) => a.arc < RAIL_MARKS.eastShore - 4 : undefined,
    });
    return {
      ballast,
      rails: buildRails(),
      sleepers: buildSleepers(),
      bridges: buildBridges(),
      stations: buildStations(),
      crossings: buildCrossings(),
      culverts: buildCulverts(),
    };
  }, []);
  const ballastTexture = useMemo(() => makeBallastTexture(), []);
  const panelTexture = useMemo(() => makePanelTexture(), []);
  const boards = useMemo(() => new Map(RAIL_STATIONS.map((st) => [st.name, boardTexture(st.name)])), []);

  useEffect(() => {
    console.info(`[country] railway: ${built.sleepers.length.toLocaleString()} sleepers, `
      + `${RAIL_STATIONS.length} stations, ${RAIL_CROSSINGS.length} crossings with ${built.crossings.barriers.length} barriers`);
    return () => {
      built.ballast.geometry.dispose();
      built.rails.dispose();
      built.bridges.deck.geometry.dispose();
      built.bridges.masonry.dispose();
      for (const g of [built.stations.concrete, built.stations.coping, built.stations.yellow, built.stations.steel,
        built.stations.timber, built.stations.roof, built.stations.glass, built.stations.bloom, built.stations.buffers]) g.dispose();
      for (const g of [built.crossings.aprons, built.crossings.panels, built.crossings.flangeways, built.crossings.paint,
        built.crossings.posts, built.crossings.signBacks, built.crossings.signFaces]) g.dispose();
      panelTexture.dispose();
      built.culverts.stone.dispose();
      built.culverts.pipes.dispose();
      ballastTexture.dispose();
      for (const t of boards.values()) t.dispose();
    };
  }, [built, ballastTexture, panelTexture, boards]);

  return (
    <>
      <group position={[SITE.centre[0], 0, SITE.centre[1]]}>
        <mesh geometry={built.ballast.geometry} receiveShadow>
          <meshStandardMaterial map={ballastTexture} roughness={0.95} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.rails} material={RAIL_STEEL} castShadow receiveShadow />
        <InstancedField matrices={built.sleepers} geometry={SLEEPER_GEOMETRY} material={SLEEPER_MATERIAL} />

        <mesh geometry={built.bridges.deck.geometry} castShadow receiveShadow>
          <meshStandardMaterial color="#8f8d88" roughness={0.9} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.bridges.masonry} castShadow receiveShadow>
          <meshStandardMaterial color="#7f7d78" roughness={0.92} />
        </mesh>

        <mesh geometry={built.stations.concrete} castShadow receiveShadow>
          <meshStandardMaterial color="#b3ad9f" roughness={0.92} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.stations.coping} receiveShadow>
          <meshStandardMaterial color="#e6e0d2" roughness={0.8} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.stations.yellow}>
          <meshStandardMaterial color="#e6c227" roughness={0.6} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.stations.steel} castShadow>
          <meshStandardMaterial color="#6d7378" roughness={0.45} metalness={0.5} />
        </mesh>
        <mesh geometry={built.stations.timber} castShadow>
          <meshStandardMaterial color="#8a6a44" roughness={0.85} />
        </mesh>
        <mesh geometry={built.stations.roof} castShadow receiveShadow>
          <meshStandardMaterial color="#2f2c29" roughness={0.6} metalness={0.2} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.stations.glass}>
          <meshStandardMaterial color="#cfe4ec" roughness={0.1} metalness={0.1} transparent opacity={0.35} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.stations.bloom}>
          <meshStandardMaterial color="#d8607f" roughness={0.7} emissive="#4a1a28" emissiveIntensity={0.2} />
        </mesh>
        <mesh geometry={built.stations.buffers} castShadow>
          <meshStandardMaterial color="#a8231c" roughness={0.7} />
        </mesh>
        {built.stations.boards.map((b, i) => (
          <mesh key={i} position={[b.x, b.y, b.z]} rotation={[0, b.yaw, 0]} castShadow>
            <boxGeometry args={[2.6, 0.57, 0.05]} />
            <meshStandardMaterial map={boards.get(b.name)} roughness={0.7} />
          </mesh>
        ))}

        <mesh geometry={built.crossings.aprons} receiveShadow>
          <meshStandardMaterial color="#7a7874" roughness={0.96} side={DoubleSide} />
        </mesh>
        <mesh geometry={built.crossings.panels} receiveShadow>
          <meshStandardMaterial map={panelTexture} roughness={0.95} />
        </mesh>
        <mesh geometry={built.crossings.flangeways}>
          <meshStandardMaterial color="#141310" roughness={1} />
        </mesh>
        <mesh geometry={built.crossings.paint}>
          <meshStandardMaterial color="#f4f1ea" roughness={0.6} />
        </mesh>
        <mesh geometry={built.crossings.posts} castShadow>
          <meshStandardMaterial color="#5a5e63" roughness={0.6} metalness={0.3} />
        </mesh>
        <mesh geometry={built.crossings.signBacks} castShadow>
          <meshStandardMaterial color="#141414" roughness={0.6} />
        </mesh>
        <mesh geometry={built.crossings.signFaces}>
          <meshStandardMaterial color="#f2c522" roughness={0.5} />
        </mesh>
        {built.crossings.barriers.map((spec, i) => <Barrier key={i} spec={spec} />)}
        <CrossingGates />

        <mesh geometry={built.culverts.stone} castShadow receiveShadow>
          <meshStandardMaterial color="#8d877b" roughness={0.95} />
        </mesh>
        <mesh geometry={built.culverts.pipes}>
          <meshStandardMaterial color="#141412" roughness={1} />
        </mesh>

        <RigidBody type="fixed" colliders={false}>
          <TrimeshCollider args={[built.ballast.vertices, built.ballast.indices]} friction={0.9} />
          <TrimeshCollider args={[built.bridges.deck.vertices, built.bridges.deck.indices]} friction={1} />
          <TrimeshCollider args={[flatVertices(built.crossings.aprons), flatIndices(built.crossings.aprons)]} friction={1} />
          <TrimeshCollider args={[flatVertices(built.crossings.panels), flatIndices(built.crossings.panels)]} friction={1} />
          {built.crossings.decks.map((d, i) => (
            <CuboidCollider key={`deck${i}`} args={d.half} position={[d.x, d.y, d.z]} rotation={[0, d.yaw, 0]} friction={1} />
          ))}
          <TrimeshCollider args={[flatVertices(built.stations.concrete), flatIndices(built.stations.concrete)]} friction={1} />
          {built.stations.solids.map((b, i) => (
            <CuboidCollider key={`stn${i}`} args={b.half} position={[b.x, b.y, b.z]} rotation={[0, b.yaw, 0]} />
          ))}
        </RigidBody>
        {/* The bridges' piers, abutments and end wall, and the culverts'
            stonework — solid as drawn, not just the deck over them. */}
        <GeometryCollider geometry={[built.bridges.masonry, built.culverts.stone]} />
      </group>

    </>
  );
}

/** A merged, non-indexed geometry as the flat arrays a trimesh collider takes. */
function flatVertices(g: BufferGeometry): Float32Array {
  return g.getAttribute('position').array as Float32Array;
}
function flatIndices(g: BufferGeometry): Uint32Array {
  const n = g.getAttribute('position').count;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/** Whether a point is inside the rail band, for anything outside that asks. */
export const onRailway = (x: number, z: number) => railNear(x, z).d < RAIL_FLAT;
export { onBridge as railOnBridge };
