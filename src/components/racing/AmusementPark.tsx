'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, CylinderCollider, RigidBody } from '@react-three/rapier';
import { partColliders } from './partColliders';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, Float32BufferAttribute,
  Box3, DoubleSide, Euler, Group, InstancedMesh, Matrix4, Mesh, Quaternion, RepeatWrapping, SRGBColorSpace,
  Vector3, type Material, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import parkModels from '@/config/parkModelData.json';
import {
  ARCADE, CANDY, CAST, FLAT_LIFT, FOUNTAIN, ICE_CARTS, KIT, KIT_PARTS, LAP, MOTION, STATUE,
  LOOP, LOOP_LAP, PARK, PARK_COLOURS, PARK_HEDGE, PARK_PAVING, PARK_SURFACES, PIT, PLANTING, POND,
  RIDES, SHOPS, SPEEDWAY, TROPHY, parkBoundaryRuns,
} from '@/config/parkConfig';

/**
 * Halcyon Pier, the amusement park on the airport island.
 *
 * Drawn inside the island's group, so every number here is in the island's
 * frame and `parkConfig` owns all of them. This file is the drawing: paving,
 * rides, the borrowed city chunks, the fountain, and the four things that move.
 *
 * ## Everything that moves is a transform
 *
 * A ferris wheel is a rotation about Z, a swing carousel is a rotation about
 * Y, a drop tower is a position on a line and a bumper car is a point on a
 * circle. Not one of them needs a rig, an animation clip or a physics body,
 * and between them they are the difference between a park and a photograph of
 * one. The two rides that move as a whole — wheel and gondola — arrive from
 * `prepare-park.mjs` already centred on their own middles, so placing and
 * turning them is the transform and nothing else.
 *
 * ## The colliders stop at the rides
 *
 * A box each, from the measured size, the same as the airfield's buildings.
 * The moving parts get none: a ferris wheel with a collider is a 43 m blade
 * sweeping through anything parked under it, and the one thing worse than not
 * being able to drive into a ride is being launched into the sea by one.
 */

const PARK_MODEL = '/models/park.glb';
const PANDA_MODEL = '/models/panda.glb';
useGLTF.preload(PARK_MODEL, DRACO_PATH);
useGLTF.preload(PANDA_MODEL, DRACO_PATH);
for (const car of SPEEDWAY.cars) useGLTF.preload(car.model, DRACO_PATH);

/**
 * The coaster's trains, and the ride they run.
 *
 * The clip is baked into the model data as a uniform table of position and
 * rotation — see `prepare-park.mjs` — so running it is an index and a lerp,
 * and the three trains are the same table at three phases because that is how
 * the modeller animated them. Rotations are slerped rather than lerped: at 20
 * fps a train through an inversion turns far enough between frames that the
 * short way round and the straight line are visibly different things.
 */
interface Ride {
  path: number[][];
  duration: number;
  /** Cumulative distance to each key, so a car can trail by metres. */
  arc: number[];
  total: number;
}
const rideOf = (part: string): Ride | null => {
  const entry = (parkModels.parts as Record<string, { path?: number[][]; duration?: number }>)[part];
  if (!entry?.path || !entry.duration) return null;
  const { path } = entry;
  const arc = [0];
  for (let i = 1; i <= path.length; i++) {
    const a = path[i - 1];
    const b = path[i % path.length];
    arc.push(arc[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return { path, duration: entry.duration, arc, total: arc[path.length] };
};

/** The key index at a distance round the circuit — the inverse of `arc`. */
const indexAt = (ride: Ride, distance: number): number => {
  const d = ((distance % ride.total) + ride.total) % ride.total;
  let lo = 0;
  let hi = ride.arc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ride.arc[mid] <= d) lo = mid; else hi = mid;
  }
  const span = ride.arc[hi] - ride.arc[lo];
  return lo + (span ? (d - ride.arc[lo]) / span : 0);
};

/** A part's measured footprint, which places it and sizes its collider. */
const sizeOf = (part: string): [number, number, number] => {
  const entry = (parkModels.parts as Record<string, { size: number[] }>)[part];
  return entry ? [entry.size[0], entry.size[1], entry.size[2]] : [10, 10, 10];
};

/**
 * The ferris wheel's axle, and its cabins' orbits — both measured at build
 * time rather than written down here. See `prepare-park.mjs`.
 */
const AXLE = (parkModels.parts as Record<string, { axle?: number[] }>).wheelBase?.axle
  ?? [0, 24, 0];
/** The drop tower's mast centreline, measured the same way. */
const MAST = (parkModels.parts as Record<string, { axle?: number[] }>).dropTower?.axle
  ?? [0, 27, 0];
/** The floors these two rides are used from — 2.25 m up, not y = 0. */
const deckOf = (part: string) => (
  parkModels.parts as Record<string, { deck?: number }>
)[part]?.deck ?? 0;
const ARENA = deckOf('pavilion');
/** The gondola rests ON the boarding deck: its own half-height above it. */
const DROP_LOW = deckOf('dropTower') + sizeOf('dropCar')[1] / 2;
const CABINS = Object.entries(parkModels.parts as Record<string, { orbit?: number[] }>)
  .filter(([name, part]) => name.startsWith('wheelCabin') && part.orbit)
  .map(([name, part]) => ({ name, radius: part.orbit![0], angle: part.orbit![1] }));

/** Paving is 60 mm over the island crown, exactly as the airfield's is. */
const TOP = 0.06;
const SLAB = 0.4;

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
 * The paving, as flagstones.
 *
 * Drawn rather than imported, which is what the airfield does for its tarmac
 * and for the same reason: a flat fill a hundred metres across is a colour,
 * not a material, and what tells the eye it is a paved surface is the JOINT
 * pattern rather than the shade. One tile is drawn at 256 px and repeated.
 *
 * Two courses of slabs per tile, offset by half a slab on alternate rows, so
 * the bond runs like laid paving instead of a chessboard — a square grid is
 * the thing that made the old grass swatch read as tiling, and the offset is
 * most of what stops it here. Each slab gets its own small tone shift on top.
 */
function makePaving(): CanvasTexture {
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    // The joint colour is the whole background; the slabs are drawn over it.
    ctx.fillStyle = '#9a9488';
    ctx.fillRect(0, 0, px, px);
    const rows = 2;
    const cols = 2;
    const h = px / rows;
    const w = px / cols;
    const joint = 2.5;
    for (let r = 0; r < rows; r++) {
      // Half-slab offset on every other course: a running bond, not a grid.
      const shift = (r % 2) * (w / 2);
      for (let c = -1; c <= cols; c++) {
        const tone = 186 + Math.floor(rnd() * 16);
        ctx.fillStyle = `rgb(${tone},${tone - 6},${tone - 18})`;
        ctx.fillRect(c * w + shift + joint / 2, r * h + joint / 2, w - joint, h - joint);
      }
    }
    // Grain, so a slab is not a flat rectangle of one value.
    for (let i = 0; i < 2400; i++) {
      const g = 150 + Math.floor(rnd() * 70);
      ctx.fillStyle = `rgba(${g},${g - 6},${g - 16},0.28)`;
      ctx.fillRect(rnd() * px, rnd() * px, 1.6, 1.6);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * The circuit's asphalt: grain, and nothing else.
 *
 * A flat colour has no scale — nothing in it tells you how big a square metre
 * of it is — so close up the track reads as a painted shape rather than as a
 * road. A few thousand chips of aggregate fix that and cost one 256 px canvas.
 *
 * What this deliberately does NOT do is change the colour. The first version
 * had oil-dark bands down each wheel track and pale scuffs along it, which is
 * what real asphalt looks like and was wrong here: the bands read as stripes
 * painted on the road and the whole surface came out muddy, because a mid-grey
 * map multiplied by a dark colour lands somewhere neither of them was.
 *
 * So the grain is centred on white and varies by a few per cent either side.
 * Multiplied by `colours.asphalt` it gives back that colour with texture in
 * it, which is the whole of what was wanted.
 */
function makeAsphalt(): CanvasTexture {
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = 91;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    for (let i = 0; i < 11000; i++) {
      // 224..255 against a white ground: visible as texture, invisible as tint.
      const g = 224 + Math.floor(rnd() * 32);
      ctx.fillStyle = `rgba(${g},${g},${g},${0.3 + rnd() * 0.45})`;
      const r = 0.8 + rnd() * 1.6;
      ctx.fillRect(rnd() * px, rnd() * px, r, r);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  // Along the track, not round it: one repeat is about six metres of road.
  texture.repeat.set(60, 1);
  return texture;
}

/**
 * The same grain, for surfaces whose UVs are already in metres.
 *
 * `makeAsphalt` is built for the track's ribbon, whose V runs across the road
 * and whose U runs 0..1 round the whole lap — hence `repeat(60, 1)`. The pit
 * apron is a slab with `planarUV` UVs, which are metres divided by a tile
 * size, so it wants the repeat left at 1 and gets its own instance. Sharing
 * the texture would mean sharing the repeat, and one of the two would be
 * smeared.
 */
function makeGrain(): CanvasTexture {
  const texture = makeAsphalt();
  texture.repeat.set(1, 1);
  return texture;
}

/**
 * Planar UVs off the ground plane, in metres.
 *
 * A `BoxGeometry` maps 0..1 across each face whatever its size, so a merged
 * pile of slabs textured on its own UVs gives every rectangle a different
 * scale of paving — a 200 m promenade and a 12 m spur each squeezing one
 * repeat into themselves. Taking the UV from world X and Z instead makes the
 * slab size the same everywhere, and lets the joints run straight across a
 * junction where two rectangles meet.
 */
function planarUV(g: BufferGeometry, metres: number) {
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / metres;
    uv[i * 2 + 1] = pos.getZ(i) / metres;
  }
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
}

/** The paths, and the plaza disc the fountain stands in. */
function buildPaving(): BufferGeometry | null {
  const parts: BufferGeometry[] = PARK_SURFACES.map((rect) => slab(rect, TOP));
  /*
   * The plaza is a disc, because the fountain in the middle of it is round and
   * a square of paving round a round pool reads as a car park.
   *
   * Two centimetres higher than the paths it interrupts, and that is not a
   * detail: the disc necessarily overlaps the promenade it sits on, and two
   * coplanar surfaces sharing twenty metres is a z-fight. Raised, it is a
   * kerbed plaza the promenade runs into, which is what it should have been.
   */
  const plaza = new CylinderGeometry(FOUNTAIN.basin + 8, FOUNTAIN.basin + 8, SLAB, 48);
  plaza.translate(FOUNTAIN.along, TOP + 0.02 - SLAB / 2, FOUNTAIN.across);
  parts.push(plaza);
  const merged = merge(parts);
  if (merged) planarUV(merged, PARK_COLOURS.slab);
  return merged;
}

/**
 * Where every tree, shrub and bench goes.
 *
 * The park used to be planted by rejection sampling: eighty trees thrown at
 * the site, kept wherever they missed a path. That gives woodland with rides
 * in it. What makes a park read as designed is that the planting AGREES with
 * the paths — so this lays four deliberate things first and scatters only
 * what is left over:
 *
 *   the avenue    two rows of trees down the promenade at a fixed pitch,
 *                 alternating between two species so a row of twenty is not
 *                 one object twenty times
 *   the benches   both kerbs, at twice the tree pitch and half a pitch out of
 *                 step with them, so a bench always sits between two trunks
 *   the plaza     four planters on the disc's diagonals, each with a specimen
 *                 tree — on the diagonals precisely because the promenade and
 *                 the cross walk take the four cardinal directions
 *   the hedge     low shrubs inside the boundary fence, which is what stops
 *                 the fence reading as a line drawn round nothing
 *
 * Everything is returned grouped by part name, because each group becomes one
 * instanced mesh and therefore one draw call.
 */
function layout() {
  const at = new Map<string, Array<{ x: number; z: number; turn: number }>>();
  const put = (part: string, x: number, z: number, turn: number) => {
    if (!at.has(part)) at.set(part, []);
    at.get(part)!.push({ x, z, turn });
  };
  let seed = 811;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };

  const P = PLANTING;
  const [a0, a1, c0, c1] = PARK.bounds;
  /** The two rides that get a queue pen, and the half-depth to stand it off. */
  const AT_QUEUES = {
    drop: { along: 218, across: 175, half: sizeOf('dropTower')[2] / 2 },
    swings: { along: 250, across: 175, half: sizeOf('swingsBase')[2] / 2 },
  };
  const onPath = (x: number, z: number, pad: number) => PARK_SURFACES.some(
    (r) => x > r[0] - pad && x < r[1] + pad && z > r[2] - pad && z < r[3] + pad,
  );
  const onPlaza = (x: number, z: number, pad: number) => Math.hypot(
    x - FOUNTAIN.along, z - FOUNTAIN.across,
  ) < FOUNTAIN.basin + 8 + pad;
  const onRide = (x: number, z: number, pad: number) => RIDES.some((r) => {
    const s = sizeOf(r.part);
    const turned = Math.abs(Math.cos(r.turn)) < 0.5;
    const ha = (turned ? s[2] : s[0]) / 2 + pad;
    const hc = (turned ? s[0] : s[2]) / 2 + pad;
    return Math.abs(r.along - x) < ha && Math.abs(r.across - z) < hc;
  });
  const onArcade = (x: number, z: number, pad: number) => {
    const s = sizeOf(KIT.arcade);
    return Math.abs(ARCADE.along - x) < s[0] / 2 + pad
      && Math.abs(ARCADE.across - z) < s[2] / 2 + pad;
  };
  const onPond = (x: number, z: number, pad: number) =>
    Math.hypot(x - POND.along, z - POND.across) < sizeOf(KIT.pond)[0] / 2 + pad;
  /**
   * The entrance throat: nothing goes here at all.
   *
   * Wider than the flare itself so the trees on the verges are excluded too —
   * they stood at along 271.5 and 304.5, which is exactly where a car coming
   * off the road would be looking.
   */
  const inEntry = (x: number, z: number) =>
    z >= P.entryClear && x > PARK_PAVING.entryApron[0] - 8 && x < PARK_PAVING.entryApron[1] + 8;
  const taken = (x: number, z: number, pad: number) =>
    onPath(x, z, pad) || onPlaza(x, z, pad) || onRide(x, z, pad + 2)
    || onArcade(x, z, pad + 2) || onPond(x, z, pad);

  /* --------------------------------------------------- down every walk */
  /*
   * One routine for all three walks, so the promenade and both cross arms
   * carry the same rhythm and meet each other in step.
   *
   * At each station: a tree on both verges, and one piece of furniture inside
   * each kerb dealt from a seven-step cycle — bench, lamp, stall, slatted
   * bench, lamp, stall, bin — with the two kerbs three steps out of phase so
   * you never face a matching pair across the walk. Seven steps at 14 m means
   * any one kind repeats every 98 m.
   */
  const dressWalk = (rect: readonly [number, number, number, number], phase: number) => {
    const [x0, x1, z0, z1] = rect;
    const along = x1 - x0 >= z1 - z0;          // which way this walk runs
    const from = along ? x0 : z0;
    const to = along ? x1 : z1;
    const kerbA = (along ? z0 : x0) + P.kerbSetback;
    const kerbB = (along ? z1 : x1) - P.kerbSetback;
    const vergeA = (along ? z0 : x0) - P.vergeSetback;
    const vergeB = (along ? z1 : x1) + P.vergeSetback;
    const at2 = (t: number, c: number): [number, number] => (along ? [t, c] : [c, t]);
    let step = phase;
    for (let t = from + P.walkPitch; t < to - P.walkPitch / 2; t += P.walkPitch) {
      step += 1;
      for (const v of [vergeA, vergeB]) {
        const [x, z] = at2(t, v);
        if (taken(x, z, 1) || onPlaza(x, z, P.plazaClear) || inEntry(x, z)) continue;
        // A pit under every one. The verges are hard standing now rather than
        // grass, and a trunk coming straight out of paving looks like a tree
        // that was dropped there; a soil ring round it looks planted.
        put(KIT.planter, x, z, rnd() * Math.PI * 2);
        put(KIT.avenue[step % KIT.avenue.length], x, z, rnd() * Math.PI * 2);
      }
      for (const [c, side] of [[kerbA, 0], [kerbB, 1]] as const) {
        const [x, z] = at2(t, c);
        if (onPlaza(x, z, P.plazaClear) || onRide(x, z, 1) || inEntry(x, z)) continue;
        // Face the walk: a thing on the low kerb looks up, one on the high
        // kerb looks down, and `along` decides which axis that is.
        const turn = along ? (side ? Math.PI : 0) : (side ? -Math.PI / 2 : Math.PI / 2);
        const which = (step + side * 3) % 7;
        if (which === 0) put(KIT.bench, x, z, turn);
        else if (which === 1) put(KIT.lamp, x, z, 0);
        else if (which === 2) put(KIT.stall, x, z, turn);
        else if (which === 3) put(KIT.benchSlat, x, z, turn);
        else if (which === 4) put(KIT.lamp, x, z, 0);
        else if (which === 5) put(KIT.stall, x, z, turn);
        else put(KIT.bin, x, z, 0);
      }
    }
  };
  dressWalk(PARK_PAVING.promenade, 0);
  dressWalk(PARK_PAVING.crossWest, 2);
  dressWalk(PARK_PAVING.crossEast, 5);

  /* ------------------------------------------- the cotton candy stall */
  // At the head of the show plaza, closing the view down the west walk.
  for (const c of CANDY) put(KIT.candyStall, c.along, c.across, c.turn);

  /* ------------------------------------------------------- the ice carts */
  for (const cart of ICE_CARTS) {
    if (inEntry(cart.along, cart.across)) continue;
    put(KIT.iceCart, cart.along, cart.across, cart.turn);
  }

  /* ---------------------------------------------------------- the hub */
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * (Math.PI / 2);
    const x = FOUNTAIN.along + Math.cos(a) * P.plazaRing;
    const z = FOUNTAIN.across + Math.sin(a) * P.plazaRing;
    put(KIT.planter, x, z, a);
    put(KIT.specimen[k % KIT.specimen.length], x, z, rnd() * Math.PI * 2);
  }
  /*
   * NO barrier ring round the fountain.
   *
   * Twelve orange plastic crowd barriers round an ornamental basin is what a
   * burst water main looks like, not a plaza — and the fountain does not need
   * them to keep a car out, because its kerb is already a collider. Barriers
   * are queue furniture, so they go where a queue is: across the front of the
   * two rides people line up for.
   */
  for (const ride of [AT_QUEUES.drop, AT_QUEUES.swings]) {
    for (let k = -2; k <= 2; k++) {
      put(KIT.barrier, ride.along + k * 2.1, ride.across - ride.half - 2.5, 0);
    }
  }
  /*
   * And a run of the same barriers along the PADDOCK edge of the pit lane —
   * see `PIT.barrier`. They step in `along` at turn 0, because that is the
   * way the apron's long edge runs.
   *
   * On that side and not the track side: a crowd barrier holds people back,
   * so it faces the people, and the track side gets a pit wall instead. The
   * lamps and the bin are the park's own furniture, which is what stops the
   * apron reading as a slab with props on it.
   */
  {
    const B = PIT.barrier;
    // Stepping in `along` at turn 0, because the paddock edge runs that way —
    // the apron is 28 m of `along` by 18 of `across`, and the lane runs its
    // length. The two coordinates went in transposed the first time and put
    // the whole run outside the apron, at right angles to the edge it lines.
    for (let a = B.from; a <= B.to + 1e-6; a += B.pitch) put(KIT.barrier, a, B.across, 0);
    // Two lamps and a bin, from the same kit as the rest of the park's.
    for (const l of PIT.lamps) put(KIT.lamp, l.along, l.across, 0);
    put(KIT.bin, PIT.bin.along, PIT.bin.across, 0);
  }

  /* ------------------------------------------------------------ the pond */
  /*
   * The pond, and the thing that makes it a pond rather than a blue rectangle
   * in a yard: an edge you can sit on.
   *
   * Its own apron is paved, so the ring round it is a kerb of planting with
   * gaps in it — shrubs at three quarters of the stations and a bench facing
   * the water at the other quarter, with a lamp between each pair. Somewhere
   * to stop, which is what a water feature in a park is actually for.
   */
  put(KIT.pond, POND.along, POND.across, 0);
  const pondR = sizeOf(KIT.pond)[0] / 2;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const x = POND.along + Math.cos(a) * (pondR + 2.2);
    const z = POND.across + Math.sin(a) * (pondR + 2.2);
    // Facing the water, which for anything on a ring means facing the middle.
    const inward = Math.atan2(-Math.cos(a), -Math.sin(a));
    if (k % 4 === 0) put(KIT.bench, x, z, inward);
    else if (k % 4 === 2) put(KIT.lamp, x, z, 0);
    else put(KIT.shrub, x, z, rnd() * Math.PI * 2);
  }
  // A specimen tree at each end of it, in a pit, for something to sit under.
  for (const side of [-1, 1] as const) {
    const x = POND.along + side * (pondR + 6);
    put(KIT.planter, x, POND.across, 0);
    put(KIT.specimen[side > 0 ? 0 : 1], x, POND.across, rnd() * Math.PI * 2);
  }
  put(KIT.shelter, POND.along, POND.across - pondR - 7, 0);

  /* --------------------------------------------------- the two extra shops */
  for (const shop of SHOPS) put(shop.part, shop.along, shop.across, shop.turn);

  /* ----------------------------------------------------------- the signs */
  // The gate sign stands BESIDE the threshold, not in it.
  put(KIT.sign, PARK_PAVING.entryApron[0] - 4, P.entryClear - 6, Math.PI);
  put(KIT.sign, PARK_PAVING.crossWest[0] + 4, 200, Math.PI / 2);
  put(KIT.sign, PARK_PAVING.crossEast[1] - 4, 200, -Math.PI / 2);

  /* -------------------------------------------------------- the boundary */
  /*
   * The hedge IS the edge of the park — there is no fence behind it. It runs
   * ON the line, shoulder to shoulder at a pitch under the shrub's own
   * length, and it does NOT skip what it crosses: a boundary with a shrub
   * missing wherever it passes near a path is a boundary with holes in it.
   * The one gap is the gate, and `parkBoundaryRuns` knows where that is.
   *
   * Every shrub lies ALONG its run. A turn about +Y sends the shrub's local
   * +X, its long axis, to (cos, -sin), so aiming that down the run is
   * `atan2(-dz, dx)` and nothing more — and that alignment is the whole
   * difference between a hedge and a line of separate bushes.
   */
  for (const [x0, z0, x1, z1] of parkBoundaryRuns()) {
    const span = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.round(span / PARK_HEDGE.pitch));
    const dx = (x1 - x0) / span;
    const dz = (z1 - z0) / span;
    const lie = Math.atan2(-dz, dx);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const off = (rnd() - 0.5) * 2 * PARK_HEDGE.jitter;
      put(KIT.hedge,
        x0 + (x1 - x0) * t + dz * off,
        z0 + (z1 - z0) * t - dx * off,
        lie + (rnd() - 0.5) * 2 * PARK_HEDGE.wobble);
    }
  }

  /* ------------------------------------------------- and the loose fill */
  const placed: Array<{ x: number; z: number }> = [];
  const free = (x: number, z: number, gap: number) =>
    !placed.some((q) => Math.hypot(q.x - x, q.z - z) < gap);
  const fill = (parts: readonly string[], want: number, gap: number, pad: number) => {
    for (let n = 0, got = 0; n < 4000 && got < want; n++) {
      const x = a0 + 5 + rnd() * (a1 - a0 - 10);
      const z = c0 + 5 + rnd() * (c1 - c0 - 10);
      if (taken(x, z, pad) || inEntry(x, z) || !free(x, z, gap)) continue;
      put(parts[got % parts.length], x, z, rnd() * Math.PI * 2);
      placed.push({ x, z });
      got += 1;
    }
  };
  fill([...KIT.avenue, ...KIT.specimen], P.fillTrees, P.fillSpacing, P.offPaving);
  fill([KIT.shrub], P.fillShrubs, P.fillSpacing * 0.5, P.offPaving);
  /*
   * And a third pass of low shrubs at a much tighter spacing.
   *
   * What is left as grass now is the strips BETWEEN aprons and the band round
   * the boundary — long thin pieces a metre or three wide, which the two
   * passes above skip because they keep nine metres from their neighbours.
   * Bare green slots between paved yards are what made the park look like a
   * car park with rides on it, so these go in at three metres and fill them.
   */
  fill([KIT.hedge, KIT.shrub], P.fillEdging, 3, 1.2);

  return at;
}

/**
 * The statue's plinth: a low stone disc with a slightly darker edge band, at
 * the hub's centre. The panda itself is a model — see `STATUE` and
 * `prepare-panda.mjs` — and stands on top of this.
 */
function buildPlinth() {
  const S = STATUE;
  const disc = new CylinderGeometry(S.plinth.radius, S.plinth.radius, S.plinth.height, 48);
  disc.translate(S.along, TOP + S.plinth.height / 2, S.across);
  const edge = new CylinderGeometry(S.plinth.radius + 0.06, S.plinth.radius + 0.06, 0.1, 48, 1, true);
  edge.translate(S.along, TOP + S.plinth.height - 0.05, S.across);
  return { disc, edge };
}

/**
 * A flat band swept round the circuit, between two offsets from its centreline.
 *
 * The track, its two kerbs and anything else that follows the loop are all
 * this with different numbers. Built by hand rather than with `buildLoft`
 * because there is no profile here worth describing — it is a ribbon lying on
 * the ground, and what it needs is a closed index buffer and a normal pointing
 * up, which is four lines.
 *
 * The winding is worked out rather than guessed: for a ribbon whose left edge
 * is `centre + n * h` and whose tangent is `t`, the triangle (left, nextLeft,
 * right) has its normal along `n x t`, which is +Y — and (left, right,
 * nextLeft) is therefore the floor seen from underneath.
 */
/**
 * A route a ribbon can be laid along: where it goes, and how high its deck is.
 *
 * There are two routes now — the speedway and the infield loop that branches
 * off it — and everything that follows one used to name `LAP.point` and
 * `LAP.deckAt` directly. The loop is dead flat, so its height is a constant
 * zero rather than the speedway's jump profile.
 */
type Path = {
  at: (d: number) => readonly [number, number] | number[];
  h: (d: number) => number;
};
const SPEEDWAY_PATH: Path = { at: (d) => LAP.point(d), h: (d) => LAP.deckAt(d) };
const LOOP_PATH: Path = { at: (d) => LOOP_LAP.point(d), h: () => 0 };

function ribbon(
  from: number, to: number, lift: number, fromD: number, toD: number,
  path: Path = SPEEDWAY_PATH,
): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const steps = Math.max(8, Math.round((toD - fromD) / 0.45));
  for (let i = 0; i <= steps; i++) {
    const d = fromD + ((toD - fromD) * i) / steps;
    const p = path.at(d);
    const q = path.at(d + 0.4);
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const y = TOP + lift + path.h(d);
    pos.push(p[0] + nx * to, y, p[1] + nz * to);
    pos.push(p[0] + nx * from, y, p[1] + nz * from);
    nrm.push(0, 1, 0, 0, 1, 0);
    uv.push(i / steps, 1, i / steps, 0);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  /*
   * A UV nobody samples, and it is not optional — see `skirt`.
   *
   * Ribbons are merged with BoxGeometry in two lists now (the start line goes
   * in with the gantry's chequer blocks, the ramp rails in with the rumble
   * strips), and `mergeGeometries` refuses a list whose members disagree about
   * which attributes exist. A box has a uv, so these need one.
   */
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * The side of a ramp: a vertical wall from the running surface to the ground.
 *
 * Without it a take-off ramp is a strip of tarmac hanging in the air with
 * daylight under it. One wall per edge per ramp, four in all.
 */
function skirt(off: number, fromD: number, toD: number, raise = 0): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const steps = Math.max(4, Math.round((toD - fromD) / 0.5));
  for (let i = 0; i <= steps; i++) {
    const d = fromD + ((toD - fromD) * i) / steps;
    const p = LAP.point(d);
    const q = LAP.point(d + 0.4);
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    const x = p[0] + (-dz / len) * off;
    const z = p[1] + (dx / len) * off;
    pos.push(x, TOP + LAP.deckAt(d) + raise, z, x, TOP, z);
    uv.push(i / steps, 1, i / steps, 0);
  }
  /*
   * The winding follows the side the wall is on.
   *
   * These triangles come out facing along +n, the offset direction, so on the
   * `off > 0` wall that is outward and on the `off < 0` wall it is straight
   * into the ramp — and a back-facing wall is an invisible one. Reversing the
   * order on the near side turns it back around. Two ramps with one wall each
   * missing is exactly what "not enclosed from all sides" looks like.
   */
  const out = off >= 0;
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    if (out) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else idx.push(a + 2, a + 1, a, a + 2, a + 3, a + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  /*
   * A UV nobody samples, and it is not optional.
   *
   * This geometry is merged with the grandstand's boxes and the trophy's
   * plinth, and `mergeGeometries` refuses a list whose members disagree about
   * which attributes exist — "make sure uv exists among all of them, or in
   * none". A BoxGeometry has one, so this needs one, and the material has no
   * map so the values are only ever a formality.
   */
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A vertical strip at one offset, between two heights ABOVE the deck.
 *
 * `skirt` always reaches the ground, which is right for the outside of a ramp
 * and wrong for the inside of its parapet — that face starts at the running
 * surface. `outward` is which way it is meant to be seen from, because these
 * are single-sided and a wall facing the wrong way is no wall at all.
 */
function wall(
  off: number, fromD: number, toD: number, base: number, top: number, outward: boolean,
): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const steps = Math.max(4, Math.round((toD - fromD) / 0.5));
  for (let i = 0; i <= steps; i++) {
    const d = fromD + ((toD - fromD) * i) / steps;
    const p = LAP.point(d);
    const q = LAP.point(d + 0.4);
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    const x = p[0] + (-dz / len) * off;
    const z = p[1] + (dx / len) * off;
    const deck = TOP + LAP.deckAt(d);
    pos.push(x, deck + top, z, x, deck + base, z);
    uv.push(i / steps, 1, i / steps, 0);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    if (outward) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else idx.push(a + 2, a + 1, a, a + 2, a + 3, a + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A vertical quad at one arc, between two OFFSETS and two heights.
 *
 * `face` closes a ramp across its full width and `wall` runs along an offset;
 * this is the third one — a panel standing across the depth of something that
 * follows the circuit, which is what closes the open end of a grandstand.
 * `ahead` is which way out of the structure is, because these are
 * single-sided and a panel facing inwards is no panel at all.
 */
function endPanel(
  d: number, o0: number, o1: number, y0: number, y1: number, ahead: boolean,
): BufferGeometry {
  const p = LAP.point(d);
  const q = LAP.point(d + 0.4);
  const dx = q[0] - p[0];
  const dz = q[1] - p[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const [k, o] of [o0, o1].entries()) {
    const x = p[0] + nx * o;
    const z = p[1] + nz * o;
    pos.push(x, TOP + y1, z, x, TOP + y0, z);
    uv.push(k, 1, k, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(ahead ? [2, 1, 0, 2, 3, 1] : [0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  return g;
}

/**
 * A vertical face across the track at one arc distance, ground to deck.
 *
 * It is what closes a ramp. A deck with two side walls and an open end is a
 * shell you can see the inside of the moment you are past it; with this it is
 * a solid object.
 */
function face(d: number, half: number, ahead: boolean, raise = 0): BufferGeometry {
  const p = LAP.point(d);
  const q = LAP.point(d + 0.4);
  const dx = q[0] - p[0];
  const dz = q[1] - p[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const top = TOP + LAP.deckAt(d) + raise;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const side of [-1, 1] as const) {
    const x = p[0] + nx * half * side;
    const z = p[1] + nz * half * side;
    pos.push(x, top, z, x, TOP, z);
    uv.push(side < 0 ? 0 : 1, 1, side < 0 ? 0 : 1, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  /*
   * `ahead` is which way out of the ramp is: the take-off's cap is at the end
   * of its run and faces forward, the landing's is at the start of its run and
   * faces back. This winding faces backwards, so the take-off's has to be
   * reversed — otherwise the one end you drive straight at is a hole.
   */
  g.setIndex(ahead ? [2, 1, 0, 2, 3, 1] : [0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  return g;
}

/**
 * Radiator Springs Speedway, drawn: the circuit and everything standing on it.
 *
 * All of it is boxes, cylinders and cones, which is the same argument the
 * fountain makes — a traffic cone is a cone, a floodlight mast is a post with a
 * box on it, and a grandstand is five boxes in a staircase. Nothing here is
 * worth a model, and everything here merges by material into seven draw calls.
 *
 * See `SPEEDWAY` for why the attraction is this rather than two turntables.
 */
function buildSpeedway() {
  const S = SPEEDWAY;
  const asphalt: BufferGeometry[] = [];
  const kerb: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const concrete: BufferGeometry[] = [];
  const lamp: BufferGeometry[] = [];
  const chequer: BufferGeometry[] = [];
  const rumble: BufferGeometry[] = [];
  const tyre: BufferGeometry[] = [];
  const tyrePaint: BufferGeometry[] = [];
  const seat: BufferGeometry[] = [];
  const standRoof: BufferGeometry[] = [];
  /** One bucket per livery colour — see `SPEEDWAY.colours.livery`. */
  const livery: BufferGeometry[][] = SPEEDWAY.colours.livery.map(() => []);
  const pitFloor: BufferGeometry[] = [];
  const pitWall: BufferGeometry[] = [];
  const pitRig: BufferGeometry[] = [];
  const pitPad: BufferGeometry[] = [];
  /** One bucket per pit box — see `SPEEDWAY.colours.pitTeam`. */
  const pitTeam: BufferGeometry[][] = SPEEDWAY.colours.pitTeam.map(() => []);

  const box = (
    w: number, h: number, d: number, x: number, y: number, z: number, to: BufferGeometry[],
  ) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y, z);
    to.push(g);
  };

  /* ------------------------------------------------------------- the track */
  const half = S.width / 2;
  /**
   * A point `off` metres inboard of the circuit at arc `d`, and the bearing.
   *
   * The same normal every ribbon uses — `(-dz, dx)` — so a positive offset is
   * the infield side, and anything placed with this lines up with the kerbs
   * and the stand rows without having to be told where they are.
   */
  const beside = (d: number, off: number) => {
    const p = LAP.point(d);
    const q = LAP.point(d + 0.4);
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    return {
      x: p[0] + (-dz / len) * off,
      z: p[1] + (dx / len) * off,
      turn: Math.atan2(dx / len, dz / len),
    };
  };
  const { from: p0, to: p1 } = LAP.paved;
  asphalt.push(ribbon(-half, half, S.lift, p0, p1));
  /*
   * A kerb each side, a centimetre prouder so its edge catches the light —
   * BROKEN where the infield loop branches off.
   *
   * See `LOOP.kerbGap`. BOTH gaps are on the `+half` side, and that is
   * measured rather than reasoned: the ribbon's offset runs along the normal
   * `(-dz, dx)`, and projecting the loop onto that normal gives +0.4 to +5.8 m
   * leaving the west straight and +0.2 to +2.2 m arriving at the east one. It
   * is easy to talk yourself into the east mouth being the other side — the
   * cars run the opposite way down it — but the normal turns with them, so the
   * infield stays on `+half` at both. The outside kerb runs on unbroken.
   *
   * The arcs are in the PAVED domain, which starts at the landing ramp and
   * runs past the end of the lap — hence the `+ LAP.length` on both.
   */
  const GAP = LOOP.kerbGap;
  const leaveArc = LOOP.leave + LAP.length;
  const joinArc = LOOP.join + LAP.length;
  /** The gaps, in the paved arc domain: an opening after the leave, one
      before the join. */
  const openings: Array<[number, number]> = [
    [joinArc - GAP.join[0], joinArc + GAP.join[1]],
    [leaveArc - GAP.leave[0], leaveArc + GAP.leave[1]],
  ].sort((a, b) => a[0] - b[0]) as Array<[number, number]>;
  let cursor = p0;
  for (const [a, b] of openings) {
    if (a > cursor + 1) kerb.push(ribbon(half, half + S.kerb, S.lift + 0.01, cursor, Math.min(a, p1)));
    cursor = Math.max(cursor, b);
  }
  if (p1 > cursor + 1) kerb.push(ribbon(half, half + S.kerb, S.lift + 0.01, cursor, p1));
  kerb.push(ribbon(-half - S.kerb, -half, S.lift + 0.01, p0, p1));
  /*
   * Rumble strips on the tight corners, red block and white block alternating.
   *
   * Laid OVER the kerb rather than instead of it — the white half of the strip
   * is the kerb showing through, so only the red blocks are drawn and they are
   * a millimetre prouder so they win the depth test. See `rumbleUnder`.
   */
  const inGap = (d: number, centre: number, before: number, after: number) => {
    const x = ((d - centre) % LAP.length + LAP.length) % LAP.length;
    return x <= after || x >= LAP.length - before;
  };
  for (let d = 0; d < LAP.length; d += S.rumbleBlock * 2) {
    if (LAP.radiusAt(d) > S.rumbleUnder || !LAP.onTrack(d)) continue;
    /*
     * The inside strip skips both junction mouths. A rumble block inside one
     * lays the white line straight back down across the loop, which is the
     * whole thing the gap exists to remove — and it would do it in red as
     * well. The outside strip is untouched: no junction on that side.
     */
    if (!inGap(d, LOOP.leave, GAP.leave[0], GAP.leave[1])
      && !inGap(d, LOOP.join, GAP.join[0], GAP.join[1])) {
      rumble.push(ribbon(half, half + S.kerb, S.lift + 0.012, d, d + S.rumbleBlock));
    }
    rumble.push(ribbon(-half - S.kerb, -half, S.lift + 0.012, d, d + S.rumbleBlock));
  }
  /*
   * Tyre walls on the outside of the two hairpins.
   *
   * Which side is the outside is not a guess: on a left-hand corner the
   * outside is the right, and the sign of the path's own turn says which it
   * is. Set back `back` metres from the kerb and stacked `courses` high.
   */
  const TY = S.tyre;
  /**
   * One course of a tyre stack, at a given foot height.
   *
   * A pinched ring at the rim and a fatter one at the tread — three cylinders,
   * and what separates one course from the next is that pinch. Pulled out of
   * the barrier loop so the pit box's spares are the same object rather than a
   * second, slightly different tyre.
   */
  const barrel = (x: number, foot: number, z: number, into: BufferGeometry[]) => {
    const belly = new CylinderGeometry(
      TY.radius + TY.bulge, TY.radius + TY.bulge, TY.height * 0.5, 16,
    );
    belly.translate(x, foot + TY.height * 0.5, z);
    into.push(belly);
    for (const end of [0.2, 0.8] as const) {
      const rim = new CylinderGeometry(TY.radius, TY.radius, TY.height * 0.3, 16);
      rim.translate(x, foot + TY.height * end, z);
      into.push(rim);
    }
  };
  let stackNo = 0;
  for (let d = 0; d < LAP.length; d += TY.pitch) {
    if (LAP.radiusAt(d) > S.tyresUnder || !LAP.onTrack(d)) continue;
    const here = LAP.point(d);
    const ahead = LAP.point(d + 0.6);
    const back = LAP.point(d - 0.6);
    const turn = (ahead[0] - here[0]) * (here[1] - back[1])
      - (ahead[1] - here[1]) * (here[0] - back[0]);
    const dx = ahead[0] - here[0];
    const dz = ahead[1] - here[1];
    const len = Math.hypot(dx, dz) || 1;
    const side = turn > 0 ? 1 : -1;
    const off = side * (half + S.kerb + TY.back);
    const x = here[0] + (-dz / len) * off;
    const z = here[1] + (dx / len) * off;
    // Every fourth stack is a painted marker; the rest are rubber. Per STACK,
    // never per course — see `colours.tyre` for the biscuits that made.
    const into = stackNo++ % 4 === 3 ? tyrePaint : tyre;
    for (let c = 0; c < TY.courses; c++) {
      /*
       * Each course is a barrel, not a drum: a pinched ring at the rim and a
       * fatter one at the tread, which is three cylinders and reads as a tyre.
       * What separates one course from the next is that pinch.
       */
      barrel(x, TOP + TY.height * c, z, into);
    }
  }
  /*
   * The two ramps, as closed solids.
   *
   * A curved deck, a wall down each side to the ground, a rail along each
   * edge, and a vertical face across the high end. That is a sealed object:
   * there is no angle from which you can see under it or into it.
   *
   * They used to be open — the deck on stilts, with legs every three metres
   * and daylight between them. That is how a temporary stunt ramp is built and
   * it looked like one, which is the wrong note beside a permanent circuit
   * with a grandstand. It also meant the underside was visible and the
   * underside is the one face a swept deck does not have.
   *
   * The deck's curve comes from `LAP.deckAt` and so do the walls and the
   * face, so all four agree about the shape by construction — see
   * `SPEEDWAY.jump` for why it is a quadratic rather than a wedge.
   */
  const lipHalf = half + S.kerb + S.parapet.width;
  const P = S.parapet;
  for (const r of LAP.ramps) {
    /*
     * The edges are a PARAPET, not a painted stripe.
     *
     * They were a red-and-white rumble rib laid flat along both sides of the
     * deck, and it was the wrong thing twice. A rumble strip is a warning you
     * are running out of road, which on a flat corner is exactly what it means
     * and on the lip of a jump is nonsense — you are meant to be there, at
     * speed, in the middle. And flat paint on a flat shoulder gave the ramp no
     * edge at all: the deck just stopped.
     *
     * So the side walls are carried `P.rise` above the running surface instead
     * and capped, which is how a real take-off ramp is built. The wall you
     * already needed for the underside becomes the parapet by growing; the cap
     * and the inner face close the top of it. Pale stone on grey concrete, the
     * same two materials as the circuit's own kerbs.
     */
    /*
     * PAINTED IN BLOCKS, which is also why it is built in blocks.
     *
     * Every piece of the parapet — outer wall, cap, inner face — is cut at the
     * same `block` boundaries and the three pieces of one block go into the
     * same colour bucket, so a block is solid from the deck down to the ground
     * rather than striped by which face you are looking at. The deck gets a
     * chevron of that colour at the block's leading edge, which carries the
     * stripe across the running surface.
     *
     * The last block is whatever is left over rather than a full one run past
     * the lip, because a stripe of paint hanging in the air off the end of a
     * jump is exactly the sort of thing you would notice.
     */
    const N = SPEEDWAY.colours.livery.length;
    const blocks = Math.max(1, Math.round((r.to - r.from) / S.paint.block));
    const step = (r.to - r.from) / blocks;
    for (let b = 0; b < blocks; b++) {
      const d0 = r.from + b * step;
      const d1 = d0 + step;
      const paint = livery[b % N];
      paint.push(skirt(lipHalf, d0, d1, P.rise));
      paint.push(skirt(-lipHalf, d0, d1, P.rise));
      paint.push(wall(half + S.kerb, d0, d1, S.lift, S.lift + P.rise, false));
      paint.push(wall(-half - S.kerb, d0, d1, S.lift, S.lift + P.rise, true));
      paint.push(ribbon(half + S.kerb, lipHalf, S.lift + P.rise, d0, d1));
      paint.push(ribbon(-lipHalf, -half - S.kerb, S.lift + P.rise, d0, d1));
      // The chevron across the deck, a millimetre over the asphalt.
      paint.push(ribbon(-half, half, S.lift + 0.004, d0, Math.min(d1, d0 + S.paint.band)));
    }
    // The high end, closed. `heightAt` is zero at the low end, so that one is
    // shut by the deck meeting the ground and needs nothing.
    const takeOff = LAP.deckAt(r.to) > LAP.deckAt(r.from);
    const lipColour = livery[(takeOff ? blocks - 1 : 0) % SPEEDWAY.colours.livery.length];
    lipColour.push(face(takeOff ? r.to : r.from, lipHalf, takeOff, P.rise));
  }
  /*
   * The start line is the gantry's arc, full stop.
   *
   * It used to be searched for: the gantry was written down as a POSITION and
   * the line was the arc whose point came nearest to it. That is the wrong way
   * round — it let the gantry sit somewhere the track is not, which it did,
   * with a leg four metres inside the racing line. The gantry is an arc now
   * and the line is the same number.
   */
  const startLine = S.gantry.arc;
  /*
   * The start line: two solid white lines with a chequered band between them.
   *
   * Both halves of the chequer are painted now. They were not — only the dark
   * squares were drawn and the pale ones were left as "the road showing
   * through", which sounds economical and is invisible: the chequer is
   * #22242a and the asphalt it was meant to contrast with is #33363b. From the
   * grandstand it was a slightly darker patch of road.
   *
   * The band is laid as short ribbons, one per square, so it follows the
   * camber and the curve of the track rather than being a flat rectangle
   * dropped onto a bending road. The two edge lines do the same, and they are
   * the part that actually reads as a LINE — a chequered band says "this is
   * the start area", a hard white edge says "this is the point".
   */
  {
    const L = S.line;
    const w = (half * 2) / L.cells;
    const band = L.courses * L.cell;
    // The line proper sits at `startLine`; the band runs back from it so the
    // leading white edge is the one on the arc the lap is measured from.
    const d0 = startLine - band - L.gap - L.edge;
    kerb.push(ribbon(-half, half, S.lift + 0.009, d0, d0 + L.edge));
    kerb.push(ribbon(-half, half, S.lift + 0.009, startLine - L.edge, startLine));
    const from = d0 + L.edge + L.gap;
    for (let c = 0; c < L.courses; c++) {
      for (let i = 0; i < L.cells; i++) {
        const a = from + c * L.cell;
        const cell = ribbon(-half + i * w, -half + (i + 1) * w, S.lift + 0.008, a, a + L.cell);
        ((i + c) % 2 ? kerb : chequer).push(cell);
      }
    }
  }

  /* ----------------------------------------------------- the infield loop */
  /*
   * The branch across the infield and back — see `LOOP`.
   *
   * Asphalt 2 mm under the circuit's so the two do not fight for the same
   * pixels where they overlap at the mouths: the circuit wins, the loop
   * flares into it, and the seam reads as a junction rather than as a crack.
   * Kerbs and rumble strips skip `mouth` metres at each end for the reason
   * `LOOP.mouth` gives. No cars: nothing here places one.
   */
  {
    const O = LOOP;
    const oHalf = O.width / 2;
    const oLen = LOOP_LAP.length;
    const m0 = O.mouth.leave;
    const m1 = oLen - O.mouth.join;
    asphalt.push(ribbon(-oHalf, oHalf, O.lift - 0.002, 0, oLen, LOOP_PATH));
    kerb.push(ribbon(oHalf, oHalf + O.kerb, O.lift + 0.008, m0, m1, LOOP_PATH));
    kerb.push(ribbon(-oHalf - O.kerb, -oHalf, O.lift + 0.008, m0, m1, LOOP_PATH));
    for (let d = m0; d < m1; d += O.rumbleBlock * 2) {
      if (LOOP_LAP.radiusAt(d) > O.rumbleUnder) continue;
      const to = Math.min(d + O.rumbleBlock, m1);
      rumble.push(ribbon(oHalf, oHalf + O.kerb, O.lift + 0.010, d, to, LOOP_PATH));
      rumble.push(ribbon(-oHalf - O.kerb, -oHalf, O.lift + 0.010, d, to, LOOP_PATH));
    }
  }

  /* --------------------------------------------------------- the pit box */
  /*
   * See `PIT`. Everything here is boxes and cylinders, like the rest of the
   * circuit, and the whole point of it is that this is the one place on the
   * site where a car is being worked on rather than driven or parked.
   *
   * It is drawn in the order you would build it: floor, barrier, then the
   * things standing on the floor — jacks, rig, trolley, spares, board.
   */
  {
    const Q = PIT;
    /*
     * The apron, TEXTURED, and in two tones.
     *
     * It was one flat mid-grey rectangle, which at any distance is a patch
     * where the paving changed colour rather than a floor. Three things fix
     * that and they are all cheap: the same grain the track uses, mapped
     * PLANAR so a 21 m apron and a 10 m pad get the same size of aggregate
     * (see `planarUV` — a BoxGeometry's own 0..1 UV would stretch one repeat
     * across the whole slab); a darker pad inside it where the car actually
     * stands, so the eye has an edge to read the apron's size against; and a
     * run of diagonal hatching along the back, which is the marking every real
     * pit lane has and the thing that says "this area is not for driving on".
     */
    const apron = slab(Q.floor, TOP + 0.02);
    planarUV(apron, 3.2);
    pitFloor.push(apron);
    const [fa0, fa1] = Q.floor;
    /*
     * The LANE, a darker strip the full length of the apron on the track side.
     *
     * Its own tone rather than the apron's, because a pit lane is a running
     * surface and the paddock behind it is not — and because the tone change
     * is what tells you at a glance which part is the road. Nothing is ever
     * drawn standing in here.
     */
    const LN = Q.lane;
    const lane = slab([fa0, fa1, LN.from, LN.to], TOP + 0.035);
    planarUV(lane, 3.2);
    pitPad.push(lane);
    // The solid white line down its inner edge.
    box(fa1 - fa0, 0.02, LN.line, (fa0 + fa1) / 2, TOP + 0.055, LN.from, pitWall);
    /*
     * Hatching where the lane would run out onto the circuit, at both ends.
     *
     * Diagonal bars, which is the marking every real pit lane has at its mouth
     * and the thing that says "this is not a piece of track". Each bar is a box
     * turned 45 degrees and the run is stepped along the lane.
     */
    const H = Q.hatch;
    for (const [ha0, ha1] of H.ends) {
      const count = Math.floor((ha1 - ha0) / H.pitch);
      for (let i = 0; i < count; i++) {
        const bar = new BoxGeometry(H.bar, 0.02, (LN.to - LN.from) * 0.8);
        bar.rotateY(Math.PI / 4);
        bar.translate(ha0 + (i + 0.5) * H.pitch, TOP + 0.05, (LN.from + LN.to) / 2);
        pitWall.push(bar);
      }
    }
    /*
     * THE THREE BOXES, each marked out on three sides.
     *
     * Open at the lane end, like a real bay — a closed rectangle would be a
     * parking space. The lines are laid a couple of centimetres over the
     * concrete rather than flush with it, because two coplanar surfaces at the
     * same height is a coin toss every frame about which the depth test likes.
     */
    const BX = Q.boxes;
    for (const [i, [ba0, ba1]] of BX.at.entries()) {
      // The coloured floor first, inset so the white markings sit on the grey
      // apron and read as markings rather than as its edge.
      const panel = slab(
        [ba0 + BX.inset, ba1 - BX.inset, BX.from + BX.inset, BX.to - BX.inset], TOP + 0.03,
      );
      planarUV(panel, 3.2);
      pitTeam[i % pitTeam.length].push(panel);
      for (const a2 of [ba0, ba1]) {
        box(BX.line, 0.02, BX.to - BX.from, a2, TOP + 0.045, (BX.from + BX.to) / 2, pitWall);
      }
      box(ba1 - ba0, 0.02, BX.line, (ba0 + ba1) / 2, TOP + 0.045, BX.from, pitWall);
    }
    /*
     * The pit wall: one long box with a paler cap, on the track side.
     *
     * A cap because a wall seen end-on is a horizontal edge and the cap is
     * what gives it one. Crowd barriers do the other side — see `PIT.barrier`
     * for why the two are not interchangeable.
     */
    const W = Q.wall;
    /*
     * Blocked in the ramp's two colours rather than left one flat grey.
     *
     * A pit wall is the most-photographed surface on any circuit and it is
     * never plain. Dealing it from the same `livery` the jump ramps use ties
     * the two together instead of introducing a third palette, and the cap
     * stays pale and continuous so the wall still reads as one object.
     */
    const wBlocks = Math.max(1, Math.round((W.to - W.from) / 2.4));
    const wStep = (W.to - W.from) / wBlocks;
    for (let b = 0; b < wBlocks; b++) {
      const g = new BoxGeometry(wStep, W.height, W.thick);
      g.translate(W.from + (b + 0.5) * wStep, TOP + W.height / 2, W.across);
      livery[b % livery.length].push(g);
    }
    box(W.to - W.from, W.cap, W.thick + 0.16,
      (W.from + W.to) / 2, TOP + W.height + W.cap / 2, W.across, kerb);
    /*
     * The jacks, one at each end of the car, and they are load-bearing.
     *
     * `jack.rise` is the number the crew list lifts Chick by as well, so the
     * pads land exactly under him: drawn at `rise` and lifted by `rise`. Get
     * those out of step and he either floats over them or sinks through.
     */
    const K = Q.jack;
    const chick = Q.crew[0];
    for (const end of [-1, 1] as const) {
      const x = chick.across + end * K.reach;
      box(K.pad, 0.1, K.pad, chick.along, TOP + K.rise - 0.05, x, steel);
      box(K.post, K.rise, K.post, chick.along, TOP + K.rise / 2, x, steel);
      // The handle, laid out sideways where a crew would leave it.
      box(0.06, 0.06, 1.1, chick.along + 0.5, TOP + 0.2, x, steel);
    }
    /* The fuel rig: a drum on a stand, and a hose hooped over to the car. */
    const R = Q.rig;
    box(R.radius * 2.1, R.stand, R.radius * 2.1, R.along, TOP + R.stand / 2, R.across, steel);
    const drum = new CylinderGeometry(R.radius, R.radius, R.height, 18);
    drum.translate(R.along, TOP + R.stand + R.height / 2, R.across);
    pitRig.push(drum);
    for (let i = 0; i < 7; i++) {
      // Seven links from the drum to the car, sagging in the middle: a hose,
      // as far as a hose can be boxes.
      const u = (i + 0.5) / 7;
      const a2 = R.along + (chick.along - R.along - 0.9) * u;
      const sag = Math.sin(u * Math.PI) * 0.3;
      box(0.42, 0.11, 0.11, a2, TOP + R.stand + R.height * 0.7 - sag, R.across, steel);
    }
    /* The tool trolley, with a lighter top so it reads as a worktop. */
    const T = Q.trolley;
    box(T.depth, T.height, T.width, T.along, TOP + T.height / 2, T.across, steel);
    box(T.depth + 0.1, 0.07, T.width + 0.1, T.along, TOP + T.height, T.across, kerb);
    /* Spare sets, stacked. Same barrel as the barriers use. */
    for (const sp of Q.spares) {
      for (let c = 0; c < sp.courses; c++) {
        barrel(sp.along, TOP + TY.height * c, sp.across, tyre);
      }
    }
    /* The pit board, hung out over the wall on a pole. */
    const B = Q.board;
    box(B.post, B.height, B.post, B.along, TOP + B.height / 2, B.across, steel);
    box(0.06, B.tall, B.width, B.along, TOP + B.height - B.tall / 2, B.across + B.width / 2, kerb);
  }

  /* --------------------------------------------------- start and finish */
  /*
   * The gantry, built ON the circuit rather than beside it — see `gantry.arc`.
   *
   * Every piece of it is placed through `beside`, so the legs sit `clear`
   * metres outside the kerb on each side and the beam is square to the track,
   * whatever the circuit does at that arc. The previous one was written down
   * as a position and had a leg four metres inside the racing line.
   */
  const G = S.gantry;
  const postAt = half + S.kerb + G.clear;
  const gCentre = beside(G.arc, 0);
  const gTurn = gCentre.turn;
  const legs = [-1, 1].map((sx) => beside(G.arc, sx * postAt));
  for (const leg of legs) {
    const g = new BoxGeometry(G.post, G.height, G.post);
    g.rotateY(gTurn);
    g.translate(leg.x, TOP + G.height / 2, leg.z);
    steel.push(g);
  }
  {
    /*
     * Long in X, not Z, and that is the whole of it.
     *
     * `beside` hands back the bearing of the track's DIRECTION, and rotating
     * a box by that maps its local +Z onto the tangent — so a beam built long
     * in Z ends up running down the straight instead of over it. Local +X maps
     * onto the normal, which is the way a gantry spans. Same for every chequer
     * block hanging under it.
     */
    const beam = new BoxGeometry(postAt * 2 + G.post, G.beam, G.post * 1.1);
    beam.rotateY(gTurn);
    beam.translate(gCentre.x, TOP + G.height + G.beam / 2, gCentre.z);
    steel.push(beam);
  }
  // The chequered band hanging under the beam: alternating blocks, two rows.
  const cells = 12;
  const cell = (postAt * 2) / cells;
  for (let i = 0; i < cells; i++) {
    const at = beside(G.arc, -postAt + cell * (i + 0.5));
    for (let r = 0; r < 2; r++) {
      if ((i + r) % 2) continue;
      const g = new BoxGeometry(cell, G.band / 2, 0.1);
      g.rotateY(gTurn);
      g.translate(at.x, TOP + G.height - G.band / 4 - r * (G.band / 2), at.z);
      chequer.push(g);
    }
  }

  /* --------------------------------------------------------- the stand */
  /*
   * The grandstand: a concrete staircase with seating on it and a trussed
   * canopy over it.
   *
   * It was five plain slabs and a flat roof on three posts, which is a stand
   * in the sense that a staircase is a stand. What it has now is what makes
   * one read: the risers are concrete and the TREADS are seating in a colour,
   * so the rake is legible from across the circuit; the canopy is carried on a
   * truss with a tie under it rather than on a slab; and there is a back wall,
   * because a stand you can see daylight through is scaffolding.
   */
  const T = S.stand;
  const SEAT = SPEEDWAY.colours.seatBlocks;
  const seatGeo: BufferGeometry[][] = SEAT.map(() => []);
  const span = T.to - T.from;
  /*
   * The rake, row by row, each one following the circuit at its own offset.
   *
   * A row is three pieces: a concrete RISER facing the track, a concrete
   * TREAD on top of it, and the seating on the tread. The riser faces -n, in
   * towards the circuit, which is why `wall` is asked for the inward side —
   * these are single-sided and a riser facing the back of the stand is a
   * staircase you can see straight through.
   */
  for (let r = 0; r < T.rows; r++) {
    const o0 = T.offset + T.tread * r;
    const o1 = o0 + T.tread;
    const h = T.rise * (r + 1);
    concrete.push(wall(o0, T.from, T.to, T.rise * r, h, false));
    concrete.push(ribbon(o0, o1, h, T.from, T.to));
    /*
     * The seating, dealt into `sections` colour blocks along the arc and
     * broken at the vomitories. A bench and a backrest, because a coloured
     * strip lying flat on a step reads as paint and a strip with something
     * standing up behind it reads as a seat.
     */
    for (let k = 0; k < T.sections; k++) {
      const a0 = T.from + (span * k) / T.sections;
      const a1 = T.from + (span * (k + 1)) / T.sections;
      // Walk the section and skip anything inside a stairway.
      let cut = a0;
      const runs: Array<[number, number]> = [];
      for (const [v0, v1] of T.vomitory) {
        if (v1 <= a0 || v0 >= a1) continue;
        if (v0 > cut) runs.push([cut, Math.min(v0, a1)]);
        cut = Math.max(cut, Math.min(v1, a1));
      }
      if (cut < a1) runs.push([cut, a1]);
      const into = seatGeo[k % SEAT.length];
      for (const [f, t] of runs) {
        if (t - f < 0.4) continue;
        const s0 = o0 + T.seat.inset;
        into.push(ribbon(s0, s0 + T.seat.depth, h + 0.04, f, t));
        into.push(wall(s0 + T.seat.depth, f, t, h + 0.04, h + T.seat.rest, false));
      }
    }
  }
  const rear = T.offset + T.tread * T.rows;
  // The stairs in each vomitory: the bare concrete rake, one step per row.
  for (const [v0, v1] of T.vomitory) {
    for (let r = 0; r < T.rows; r++) {
      const o0 = T.offset + T.tread * r;
      concrete.push(ribbon(o0, o0 + T.tread, T.rise * (r + 1) + 0.02, v0, v1));
    }
  }
  /*
   * BOTH ENDS CLOSED, stepped to follow the rake.
   *
   * The stand was open at its two ends: eight rows of seating with the
   * staircase cross-section on show, which from the side is a model of a stand
   * rather than a stand. One panel per row from the ground to that row's
   * height, plus one more up the back wall, and it is a solid object from
   * every angle.
   *
   * `ahead` flips between the two ends because out of the stand is +tangent at
   * one and -tangent at the other.
   */
  for (const [end, ahead] of [[T.from, false], [T.to, true]] as const) {
    for (let r = 0; r < T.rows; r++) {
      const o0 = T.offset + T.tread * r;
      concrete.push(endPanel(end, o0, o0 + T.tread, 0, T.rise * (r + 1), ahead));
    }
  }
  // The back wall, closing it. A stand you can see daylight through is
  // scaffolding.
  const backTop = T.rise * T.rows + T.back.height;
  concrete.push(wall(rear, T.from, T.to, 0, backTop, true));
  concrete.push(ribbon(rear, rear + T.back.thick, backTop, T.from, T.to));
  concrete.push(wall(rear + T.back.thick, T.from, T.to, 0, backTop, true));
  // And the ends of the back wall itself, up to its full height.
  for (const [end, ahead] of [[T.from, false], [T.to, true]] as const) {
    concrete.push(endPanel(end, rear, rear + T.back.thick, 0, backTop, ahead));
    // The panel that closes the gap above the top row, up to the back wall.
    concrete.push(endPanel(end, T.offset, rear, T.rise * T.rows, backTop, ahead));
  }
  /*
   * The canopy: a column per bay at the back, and a roof that oversails the
   * front row. Both follow the arc, so the roof is a curved shell rather than
   * a plank laid over a curve.
   */
  const R = T.roof;
  for (let i = 0; i <= R.columns; i++) {
    const d = T.from + (span * i) / R.columns;
    const at = beside(d, rear - 0.25);
    const g = new BoxGeometry(R.post, R.height, R.post);
    g.rotateY(at.turn);
    g.translate(at.x, TOP + R.height / 2, at.z);
    steel.push(g);
  }
  standRoof.push(ribbon(T.offset - R.over, rear + T.back.thick, R.height, T.from, T.to));
  standRoof.push(ribbon(T.offset - R.over, rear + T.back.thick, R.height - R.thick, T.from, T.to));
  // The fascia hanging off the front edge, which is what gives the roof a line.
  standRoof.push(wall(T.offset - R.over, T.from, T.to, R.height - R.fascia, R.height, false));

  /* -------------------------------------------------- the trophy plinth */
  /*
   * Three drums, each narrower than the one under it — see `TROPHY`.
   *
   * It was one knee-high drum, which a car could have parked on. This is
   * 3.6 m of stepped stone with nothing to climb: unreachable because of its
   * shape rather than because something is fencing it off, which is the only
   * kind of unreachable that looks deliberate.
   *
   * Each tier gets a pale lip a few centimetres proud of the drum below it,
   * so the steps read as steps from a distance instead of as one tapered
   * column. The cup stands on the top of the last one — the same `rise` the
   * placement lifts it by, so the two cannot drift apart.
   */
  {
    const PL = TROPHY.plinth;
    let foot = 0;
    for (const tier of PL.tiers) {
      // A straight drum per tier, not a tapered one: the SHAPE comes from the
      // four of them being different widths, and a taper inside each would
      // blur that back into the cone this replaced.
      const drum = new CylinderGeometry(tier.radius, tier.radius, tier.rise, 36);
      drum.translate(TROPHY.along, TOP + foot + tier.rise / 2, TROPHY.across);
      concrete.push(drum);
      if (tier.tread) {
        // A pale tread on the steps only. On the shaft it would be a collar,
        // and on the cap it would fight the cup standing on it.
        const lip = new CylinderGeometry(tier.radius + 0.14, tier.radius + 0.14, 0.11, 36);
        lip.translate(TROPHY.along, TOP + foot + tier.rise - 0.055, TROPHY.across);
        kerb.push(lip);
      }
      foot += tier.rise;
    }
    // The Piston Cup band round the shaft, proud of it so it catches a shadow.
    const shaft = PL.tiers[2];
    const band = new CylinderGeometry(
      shaft.radius + PL.band.over, shaft.radius + PL.band.over, PL.band.height, 36,
    );
    band.translate(TROPHY.along, TOP + PL.band.at, TROPHY.across);
    livery[0].push(band);
  }

  /* ---------------------------------------------------- the floodlights */
  const M = S.mast;
  for (const mast of S.masts) {
    box(M.post, M.height, M.post, mast.at, TOP + M.height / 2, mast.across, steel);
    box(M.head.width, M.head.height, M.head.depth,
      mast.at, TOP + M.height + M.head.height / 2, mast.across, lamp);
  }

  return {
    livery: livery.map((g) => merge(g)),
    pitFloor: merge(pitFloor),
    pitWall: merge(pitWall),
    pitRig: merge(pitRig),
    pitPad: merge(pitPad),
    pitTeam: pitTeam.map((g) => merge(g)),
    rumble: merge(rumble),
    tyre: merge(tyre),
    tyrePaint: merge(tyrePaint),
    seat: merge(seat),
    standRoof: merge(standRoof),
    seatBlocks: seatGeo.map((g) => merge(g)),
    asphalt: merge(asphalt),
    kerb: merge(kerb),
    steel: merge(steel),
    concrete: merge(concrete),
    lamp: merge(lamp),
    chequer: merge(chequer),
  };
}

/**
 * One car, running the circuit.
 *
 * Its own component because each car is its own `useGLTF`, and `SPEEDWAY.cars`
 * is a fixed pair so the hook order is stable.
 *
 * Both cars share one clock and one speed and differ only by `gap`, which is
 * why neither can ever catch the other: the distance between two points on a
 * loop that advance at the same rate is a constant, and no collision code is
 * needed to keep a tow truck behind a race car.
 *
 * The heading comes from two samples half a metre apart rather than from a
 * written-down tangent, because a tangent that is a degree out at one of the
 * four joints shows up as a flick every lap. Which WAY it is turning is taken
 * the same way, from the sign of the cross product of two successive steps.
 */
function SpeedwayCar({ car }: { car: (typeof SPEEDWAY.cars)[number] }) {
  const { scene } = useGLTF(car.model, DRACO_PATH);
  // Cloned: drei hands back the cached scene, and two of these must not be
  // driving the same object round the same track.
  const body = useMemo(() => scene.clone(true), [scene]);
  /*
   * The wheels, by the names `prepare-garage.mjs` gives them.
   *
   * `Wheel_FL` and friends roll about X and steer about Y, in that order —
   * which is why the rotation order is set rather than left at the default.
   * Here only the roll is used: these cars follow a spline and do not steer,
   * and the tyre radius comes off the mesh so a wheel turns at the speed the
   * car is actually going rather than at a speed that looks about right.
   */
  const wheels = useMemo(() => {
    const all: Object3D[] = [];
    const steered: Object3D[] = [];
    for (const corner of ['FL', 'FR', 'RL', 'RR']) {
      const node = body.getObjectByName(`Wheel_${corner}`);
      if (!node) continue;
      node.rotation.order = 'YXZ';
      all.push(node);
      // Only the front pair steers. `YXZ` is what makes both work at once:
      // the yaw is applied before the roll, so a steered wheel still spins
      // about its own axle rather than about the car's.
      if (corner[0] === 'F') steered.push(node);
    }
    return { all, steered };
  }, [body]);
  const radius = useMemo(() => {
    if (!wheels.all.length) return 0.45;
    const box = new Box3().setFromObject(wheels.all[0]);
    return Math.max(0.2, (box.max.y - box.min.y) / 2);
  }, [wheels]);

  const node = useRef<Group>(null);
  const clock = useRef(0);
  const yaw = useRef(0);
  const pitch = useRef(0);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    clock.current += delta;
    /*
     * All three cars read ONE function of time, offset by `behind` seconds.
     *
     * Not by a distance: at a fixed distance the gap is the same in a corner
     * as it is on the straight, which is a tow rope rather than a chase. At a
     * fixed time each car is simply where the one ahead was a few seconds ago,
     * so the gaps breathe with the speed — and because all three read the same
     * table, none can close on another however long they run.
     */
    const t = clock.current - car.behind;
    const d = LAP.arcAt(t);
    const here = LAP.point(d);
    const ahead = LAP.point(d + 0.6);
    const back = LAP.point(d - 0.6);
    // Which way the path is turning, and how hard it is being taken.
    const turn = (ahead[0] - here[0]) * (here[1] - back[1])
      - (ahead[1] - here[1]) * (here[0] - back[0]);
    const v = LAP.speedAt(d);
    /*
     * How hard the corner is, as how far off the pace the car is here.
     *
     * The obvious measure — lateral g, `v^2 / (r * 9.81)` — is useless on this
     * circuit, and for a reason worth knowing: the speed is CHOSEN as
     * `sqrt(grip * r)`, so `v^2 / (r * g)` comes out to `grip / g` everywhere
     * the car is cornering at all. A constant. Every corner from the 10 m
     * squeeze to the 100 m sweeper got exactly the same slide.
     *
     * Speed against the straight-line pace is the honest measure instead: 1 at
     * the slowest corner on the lap, 0 flat out. The tightest turn slides at
     * 0.86 of full lock and a fast sweeper at about a third of it.
     */
    const load = Math.min(1, Math.max(0,
      (SPEEDWAY.quick - v) / (SPEEDWAY.quick - SPEEDWAY.slow)));

    if (node.current) {
      node.current.position.set(here[0], TOP + LAP.heightAt(d), here[1]);
      /*
       * NOSE UP THE RAMP, nose down over the top of the jump.
       *
       * The cars were being placed at the right HEIGHT on the ramp and left
       * lying flat, which is a car being carried up a hill on a pallet. What
       * makes a jump read as a jump is the pitch: front wheels lift first
       * going up, the whole car rotates nose-down through the arc, and it
       * meets the landing ramp at roughly the angle the ramp is at.
       *
       * The angle is just the gradient of the path the car is on — a central
       * difference over 1.2 m of arc, which also rounds off the corner at the
       * foot of the ramp for free. Note this reads `heightAt`, the CAR's
       * height, not `deckAt`: through the air the gradient wanted is the
       * parabola's, and that is what makes the car pitch over at the apex and
       * come down nose-first. At the lip the two agree exactly, by
       * construction — the ramp's angle at its edge IS the launch angle — so
       * there is no kink where the wheels leave.
       *
       * `YXZ` is the part that has to be right: the yaw is applied first, so
       * the pitch is about the car's own lateral axis rather than about the
       * world's X. With the default order a car pointing down the far straight
       * would pitch sideways.
       */
      const grade = LAP.heightAt(d + 0.6) - LAP.heightAt(d - 0.6);
      node.current.rotation.order = 'YXZ';
      const wantPitch = Math.atan2(grade, 1.2);
      pitch.current += (wantPitch - pitch.current) * Math.min(1, delta * 8);
      node.current.rotation.x = pitch.current;
      /*
       * Pointing where it is going, plus the drift — and the drift is ALL of
       * the cornering movement now.
       *
       * These cars used to roll as well, by up to 26 degrees about their own
       * length. That was wrong twice over. A car is not a motorcycle: it does
       * not lean into a corner, its body rolls slightly OUT of one on its
       * springs. And this circuit is dead flat — nothing is banked — so there
       * was no camber for a lean to be a response to. It read as a boat.
       *
       * What a car actually does at the limit on a flat surface is slide: the
       * body yaws away from the direction of travel and the nose ends up
       * pointing inside the line. That is `drift`, and with the roll gone it
       * is the whole of the effect, so it is worth twice what it was — 0.85 rad
       * is about fifty degrees of opposite lock at the tightest corner.
       *
       * The garage exports face -Z, so the bearing of travel is turned half
       * about first. Eased over a quarter second, so it winds on entering a
       * corner and unwinds on exit rather than snapping between states.
       */
      const want = Math.sign(turn) * load * SPEEDWAY.drift;
      yaw.current += (want - yaw.current) * Math.min(1, delta * 4);
      node.current.rotation.y = Math.atan2(ahead[0] - here[0], ahead[1] - here[1])
        + Math.PI + yaw.current;
    }
    // The wheels roll at the speed the car is doing. Negative because the
    // model's +X is its left, so a forward roll is a negative pitch.
    const spin = -d / radius;
    for (const w of wheels.all) w.rotation.x = spin;
    /*
     * OPPOSITE LOCK on the front pair.
     *
     * The body is yawed into the corner by `yaw`; a driver holding that slide
     * has the front wheels pointed the other way, and by about as much. So the
     * steering angle is simply the negative of the drift, capped at `SPEEDWAY.
     * lock` because a real rack runs out of travel and a wheel turned ninety
     * degrees reads as a broken model rather than as a slide.
     *
     * This is what was missing: a car sideways with its wheels pointing along
     * its own body is a car that has spun, not a car being driven.
     */
    const steer = Math.max(-SPEEDWAY.lock, Math.min(SPEEDWAY.lock, -yaw.current));
    for (const w of wheels.steered) w.rotation.y = steer;
  });

  return (
    <group ref={node}>
      <primitive object={body} />
    </group>
  );
}

/**
 * One kit part, instanced wherever the layout puts it.
 *
 * No recentring, which is the difference from the city chunks this replaces:
 * `prepare-park.mjs` leaves every part centred on its own footprint and
 * standing on y = 0, so a placement is a position and a turn and nothing
 * else. A city cell carries its own offset and `cityPartMatrix` had to undo
 * it every time.
 *
 * One instanced mesh per (geometry, material) pair, all driven by the same
 * matrices — a part with two materials is two instanced meshes, not two
 * hundred objects.
 */
const UP = new Vector3(0, 1, 0);

function Kit({ pairs, at, lift = 0 }: {
  pairs: Array<{ geometry: BufferGeometry; material: Material }> | undefined;
  at: ReadonlyArray<{ x: number; z: number; turn: number }>;
  /** How far over the crown, for the flat parts. See `FLAT_LIFT`. */
  lift?: number;
}) {
  const group = useRef<Group>(null);
  useEffect(() => {
    const g = group.current;
    if (!g || !pairs?.length) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const one = new Vector3(1, 1, 1);
    for (const child of g.children) {
      if (!(child instanceof InstancedMesh)) continue;
      at.forEach((spot, i) => {
        q.setFromAxisAngle(UP, spot.turn);
        p.set(spot.x, lift, spot.z);
        child.setMatrixAt(i, m.compose(p, q, one));
      });
      child.instanceMatrix.needsUpdate = true;
      child.computeBoundingSphere();
    }
  }, [pairs, at, lift]);
  if (!pairs?.length || !at.length) return null;
  return (
    <group ref={group}>
      {pairs.map((pair, i) => (
        <instancedMesh
          key={i}
          args={[pair.geometry, pair.material, at.length]}
          // A flat ground tile casting a shadow shadows itself, in stripes.
          castShadow={lift === 0}
          receiveShadow
        />
      ))}
    </group>
  );
}

/**
 * One ride out of `park.glb`, cloned rather than re-parented.
 *
 * A plain function and not a hook, because the rides are built by mapping over
 * a list and a hook cannot be called in a callback. Cloned for the reason
 * every model here is: drei caches the loaded scene, so moving its nodes into
 * this group means a hot reload remounts into an emptied scene and draws
 * nothing at all.
 */
function cloneRide(scene: Object3D, part: string): Object3D | null {
  const source = scene.getObjectByName(part);
  if (!source) return null;
  const copy = source.clone(true);
  copy.traverse((child) => {
    if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
  });
  return copy;
}

/**
 * The drop tower's gondola, on a cycle that is deliberately not a sine.
 *
 * Climb, hold, fall, rest — four spans, and the asymmetry IS the ride. Up and
 * down on one wave reads as a lift; a long slow climb, a pause at the top and
 * a fall four times quicker reads as the thing people queue for.
 */
function dropHeight(t: number): number {
  const D = MOTION.drop;
  const low = DROP_LOW;
  const cycle = D.climb + D.hold + D.fall + D.rest;
  const u = ((t % cycle) + cycle) % cycle;
  if (u < D.climb) {
    const k = u / D.climb;
    return low + (D.high - low) * (k * k * (3 - 2 * k));
  }
  if (u < D.climb + D.hold) return D.high;
  if (u < D.climb + D.hold + D.fall) {
    // Free fall, near enough: the square of the fraction fallen.
    const k = (u - D.climb - D.hold) / D.fall;
    return D.high - (D.high - low) * k * k;
  }
  return low;
}

export function AmusementPark() {
  const { scene } = useGLTF(PARK_MODEL, DRACO_PATH);
  const pandaScene = useGLTF(PANDA_MODEL, DRACO_PATH).scene;
  const panda = useMemo(() => {
    const copy = pandaScene.clone(true);
    copy.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }, [pandaScene]);

  const built = useMemo(() => ({
    paving: buildPaving(),
    plinth: buildPlinth(),
    speedway: buildSpeedway(),
    paved: makePaving(),
    asphalt: makeAsphalt(),
    grain: makeGrain(),
    layout: layout(),
  }), []);

  /*
   * The kit, as geometry and material pairs ready to instance.
   *
   * Every part of `park.glb` is one node holding one mesh, and three.js gives
   * a multi-primitive mesh back as a Group of Meshes — so a part is a LIST of
   * (geometry, material), and each one becomes its own instanced mesh driven
   * by the same matrices. The arcade is the only part here with more than one.
   */
  const kit = useMemo(() => {
    const out = new Map<string, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of KIT_PARTS) {
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

  // Every clone in one memo: one pass over the loaded scene, and the list is
  // stable across renders so the refs below keep pointing at the same objects.
  const models = useMemo(() => ({
    rides: RIDES.map((r) => ({ ride: r, object: cloneRide(scene, r.part) })),
    wheel: cloneRide(scene, 'wheelRim'),
    cabins: CABINS.map((c) => ({ ...c, object: cloneRide(scene, c.name) })),
    swings: cloneRide(scene, 'swingsTop'),
    dropCar: cloneRide(scene, 'dropCar'),
    bumpers: MOTION.bumpers.cars.map((car) => cloneRide(scene, car.part)),
    // The pit row's occupants and the trophy. Static clones, placed once.
    cheer: [...CAST, ...PIT.crew].map((c) => ({ ...c, object: cloneRide(scene, c.part) })),
    trophy: cloneRide(scene, 'pistonCup'),
    // Three trains of `cars` cars: the same table, one offset per car, so a
    // train follows itself exactly. See `MOTION.coaster.cars`.
    trains: ['train1', 'train2', 'train3'].flatMap((name) => {
      const ride = rideOf(name);
      if (!ride) return [];
      return Array.from({ length: MOTION.coaster.cars }, (_, car) => ({
        name: `${name}-${car}`,
        object: cloneRide(scene, name),
        ride,
        lag: car * MOTION.coaster.carLength,
      }));
    }).filter((t) => t.object),
  }), [scene]);
  const { rides, wheel, swings, dropCar } = models;

  const wheelRef = useRef<Object3D>(null);
  const swingRef = useRef<Object3D>(null);
  /*
   * The rides that turn WHOLE, by part name.
   *
   * One of them at the moment, and still a map rather than a ref: a ride that
   * turns whole stays in `RIDES` for its placement and its collider while
   * `useFrame` drives the yaw, so what this needs is a way to find the right
   * node from the ride's own part. See `MOTION.swans` for why the roundabout
   * turns whole rather than being split into a still base and a moving top.
   */
  const spun = useRef<Record<string, Object3D | null>>({});
  const cheerRefs = useRef<Record<string, Object3D | null>>({});
  const SPIN: Record<string, number> = { swans: MOTION.swans.rate };
  const dropRef = useRef<Object3D>(null);
  const bumperRefs = useRef<Array<Object3D | null>>([]);
  const cabinRefs = useRef<Array<Object3D | null>>([]);
  const trainRefs = useRef<Array<Object3D | null>>([]);
  const spare = useMemo(() => ({ a: new Quaternion(), b: new Quaternion() }), []);
  const clock = useRef(0);

  useEffect(() => {
    const missing = rides.filter((r) => !r.object).map((r) => r.ride.part);
    const circuit = models.trains[0]?.ride;
    console.info(`[park] Halcyon Pier: ${rides.length - missing.length} rides, `
      + `${models.trains.length / MOTION.coaster.cars} coaster trains of `
      + `${MOTION.coaster.cars} on a ${circuit ? circuit.duration : 0} s circuit, `
      + `${[...built.layout.values()].reduce((n, a) => n + a.length, 0)} kit pieces `
      + `in ${built.layout.size} parts, ${models.cabins.length} wheel cabins, `
      + `${models.cheer.filter((c) => c.object).length} cheering trackside, `
      + `the circuit ${LAP.length.toFixed(0)} m in ${LAP.lapTime.toFixed(0)} s, `
      /*
       * The real range, walked. This used to print `speedAt(0)` as the low
       * figure, which is the speed at the START LINE and not the minimum — on
       * a fast section it reads "21.0-21", which says the cars never slow down
       * and is simply the wrong number rather than a wrong sim.
       */
      + `${Math.min(...Array.from({ length: 400 }, (_, i) => LAP.speedAt((i / 400) * LAP.length))).toFixed(1)}`
      + `-${SPEEDWAY.quick} m/s, tightest `
      + `${Math.min(...Array.from({ length: 400 }, (_, i) => LAP.radiusAt((i / 400) * LAP.length))).toFixed(1)} m, `
      + `${SPEEDWAY.cars.map((c) => c.label).join(' chased by ')}, `
      + `${parkModels.triangles} triangles`
      /*
       * Every gate and its threshold have to be the same opening, and nothing
       * in the type system says so: `PARK.gates` cuts the holes in the hedge
       * and the aprons lay the tiles through them. They drifted apart once —
       * the main gate stayed at 306 +/- 11 after the entrance moved to 288 +/-
       * 23, so the hedge ran clean across the threshold — and the only way
       * that shows up is by looking at it. Now it says so, for both.
       */
      + PARK.gates.map((g) => {
        const apron = g.edge === 'across' ? PARK_PAVING.entryApron : PARK_PAVING.westApron;
        // The opening runs along the edge, so it is the apron's OTHER pair of
        // numbers that has to match: a gap in the north edge is a span of
        // along, and a gap in the west edge is a span of across.
        const [lo, hi] = g.edge === 'across' ? [apron[0], apron[1]] : [apron[2], apron[3]];
        return Math.abs(g.centre - g.half - lo) > 0.01 || Math.abs(g.centre + g.half - hi) > 0.01
          ? ` — ${g.label.toUpperCase()} ${g.centre - g.half}..${g.centre + g.half}`
            + ` DOES NOT MATCH ITS APRON ${lo}..${hi}, so the hedge crosses it`
          : '';
      }).join('')
      + (missing.length ? ` — MISSING ${missing.join(', ')}` : ''));
    return () => {
      built.paving?.dispose();
      built.paved.dispose();
      built.asphalt.dispose();
      built.grain.dispose();
      // `livery` is an ARRAY of geometries, one per colour; everything else
      // in here is a single one. Flattening covers both.
      for (const g of Object.values(built.speedway).flat()) g?.dispose();
      built.plinth.disc.dispose();
      built.plinth.edge.dispose();
    };
  }, [built, rides, models]);

  useFrame((_, rawDelta) => {
    // Clamped like everything else that moves here: a backgrounded tab hands
    // us a multi-second delta, and a ferris wheel does not teleport.
    clock.current += Math.min(rawDelta, 1 / 20);
    const t = clock.current;
    /*
     * The wheel turns; its cabins orbit and stay LEVEL.
     *
     * Rotating the whole wheel as one mesh takes the cabins with it, and a
     * cabin upside down at the top is the thing everybody sees. Here the rim
     * spins about Z and each cabin is placed on the circle at its own angle
     * plus the spin, with its rotation left alone — which is what the real
     * pivot at the top of every cabin does.
     */
    const spin = t * MOTION.wheel.rate;
    if (wheelRef.current) wheelRef.current.rotation.z = spin;
    models.cabins.forEach((cabin, i) => {
      const node = cabinRefs.current[i];
      if (!node) return;
      const a = cabin.angle + spin;
      node.position.set(
        MOTION.wheel.along + AXLE[0] + Math.cos(a) * cabin.radius,
        AXLE[1] + Math.sin(a) * cabin.radius,
        MOTION.wheel.across + AXLE[2],
      );
    });
    if (swingRef.current) swingRef.current.rotation.y = t * MOTION.swings.rate;
    for (const [part, rate] of Object.entries(SPIN)) {
      const node = spun.current[part];
      if (node) node.rotation.y = t * rate;
    }
    /*
     * The crowd, bouncing.
     *
     * A sine on the body's height and a matching rock about its long axis at
     * two thirds the rate, so the two never line up and it reads as a car
     * jumping on its springs rather than a car on a lift. Clamped at zero on
     * the way down: a bounce goes up from the ground, it does not sink into it.
     */
    for (const c of [...CAST, ...PIT.crew]) {
      const node = cheerRefs.current[c.part];
      if (!node) continue;
      const u = t * c.rate + c.phase;
      // `lift` is the floor this one bounces from, and for Chick on the jacks
      // it is the whole of it: `hop` is zero, so he simply sits up there.
      node.position.y = TOP + c.lift + Math.max(0, Math.sin(u)) * c.hop;
      node.rotation.z = Math.sin(u * 0.66) * c.hop * 0.5;
    }
    if (dropRef.current) dropRef.current.position.y = dropHeight(t);
    // The coaster. One table, three phases, slerped between frames.
    models.trains.forEach((train, i) => {
      const node = trainRefs.current[i];
      if (!node || !train.ride) return;
      const { path, duration, arc } = train.ride;
      // The head is driven by the CLIP's timing, because that is the ride —
      // the crawl out of the station and the rush at the bottom of the drop
      // are in the keys. The rest of the train trails it by metres.
      const head = (((t * MOTION.coaster.rate) / duration) % 1 + 1) % 1 * path.length;
      // The head's distance round the circuit, INTERPOLATED. Taking it from
      // the key below instead quantises it, and the error lands entirely on
      // the gap between the first two cars — measured, that gap breathed
      // between 1.35 and 2.19 m while every gap behind it stayed at 1.90.
      const seat = Math.floor(head);
      const headArc = arc[seat] + (arc[seat + 1] - arc[seat]) * (head - seat);
      const at = train.lag ? indexAt(train.ride, headArc - train.lag) : head;
      const lo = Math.floor(at) % path.length;
      const hi = (lo + 1) % path.length;
      const k = at - Math.floor(at);
      const a = path[lo];
      const b = path[hi];
      node.position.set(
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
      );
      spare.a.set(a[3], a[4], a[5], a[6]);
      spare.b.set(b[3], b[4], b[5], b[6]);
      node.quaternion.copy(spare.a.slerp(spare.b, k));
    });

    const B = MOTION.bumpers;
    B.cars.forEach((car, i) => {
      const node = bumperRefs.current[i];
      if (!node) return;
      const a = (t * B.rate + car.phase * Math.PI * 2) * (i % 2 ? -1 : 1);
      node.position.set(
        B.along + Math.cos(a) * B.radius * car.lane,
        ARENA,
        B.across + Math.sin(a) * B.radius * car.lane,
      );
      /*
       * Facing along travel. For a point at angle `a` on a circle the tangent
       * is (-sin a, cos a), and a yaw of `atan2(dx, dz)` aims an object's own
       * +Z along it — which works out to exactly `-a`. The quarter turns that
       * used to be here were a guess at which way the model faces; `spin` is
       * that, named, and it is zero.
       */
      node.rotation.y = -a + B.spin;
    });
  });

  return (
    <group>
      {built.paving && (
        <mesh geometry={built.paving} receiveShadow>
          <meshStandardMaterial map={built.paved} color={PARK_COLOURS.paving} roughness={0.95} />
        </mesh>
      )}

      {/* The rides that stand still. */}
      {rides.map(({ ride, object }) => object && (
        <primitive
          key={ride.label}
          object={object}
          /*
           * The swan roundabout turns WHOLE — so unlike the carousel it is
           * not split into a still base and a moving top, and it stays in this
           * list for its placement and its collider while `useFrame` drives
           * the yaw. The declarative rotation below is the starting angle and
           * nothing re-renders to fight the mutation. See `SPIN`.
           */
          ref={(node: Object3D | null) => {
            if (SPIN[ride.part] !== undefined) spun.current[ride.part] = node;
          }}
          position={[ride.along, 0, ride.across]}
          rotation={[0, ride.turn, 0]}
        />
      ))}

      {/* Doc, Luigi and Guido, watching from the infield and bouncing on
          their springs — see `CAST` and `PIT.crew`. */}
      {models.cheer.map((c) => c.object && (
        <primitive
          key={c.part}
          ref={(node: Object3D | null) => { cheerRefs.current[c.part] = node; }}
          object={c.object}
          position={[c.along, TOP + c.lift, c.across]}
          rotation={[0, c.turn, 0]}
        />
      ))}
      {/* The Piston Cup, on its plinth in the infield. */}
      {models.trophy && (
        <primitive
          object={models.trophy}
          position={[TROPHY.along, TOP + TROPHY.plinth.rise, TROPHY.across]}
          rotation={[0, TROPHY.turn, 0]}
        />
      )}

      {/* And the ones that do not. */}
      {wheel && (
        <primitive
          ref={wheelRef}
          object={wheel}
          position={[
            MOTION.wheel.along + AXLE[0],
            AXLE[1],
            MOTION.wheel.across + AXLE[2],
          ]}
        />
      )}
      {models.cabins.map((cabin, i) => cabin.object && (
        <primitive
          key={cabin.name}
          ref={(node: Object3D | null) => { cabinRefs.current[i] = node; }}
          object={cabin.object}
        />
      ))}
      {swings && (
        <primitive
          ref={swingRef}
          object={swings}
          position={[MOTION.swings.along, 0, MOTION.swings.across]}
        />
      )}
      {dropCar && (
        <group position={[MOTION.drop.along + MAST[0], 0, MOTION.drop.across + MAST[2]]}>
          <primitive ref={dropRef} object={dropCar} position={[0, DROP_LOW, 0]} />
        </group>
      )}
      {models.bumpers.map((body, i) => body && (
        <primitive
          key={`bumper${i}`}
          ref={(node: Object3D | null) => { bumperRefs.current[i] = node; }}
          object={body}
        />
      ))}

      {/* The coaster's trains, inside the ride's own transform so the baked
          circuit lands on the track it was sampled from. */}
      <group
        position={[MOTION.coaster.along, 0, MOTION.coaster.across]}
        rotation={[0, MOTION.coaster.turn, 0]}
      >
        {models.trains.map((train, i) => train.object && (
          <primitive
            key={train.name}
            ref={(node: Object3D | null) => { trainRefs.current[i] = node; }}
            object={train.object}
          />
        ))}
      </group>

      {/* The statue: the panda on its plinth, where the fountain was. */}
      <mesh geometry={built.plinth.disc} castShadow receiveShadow>
        <meshStandardMaterial color={STATUE.colours.stone} roughness={0.9} />
      </mesh>
      <mesh geometry={built.plinth.edge} castShadow>
        <meshStandardMaterial color={STATUE.colours.edge} roughness={0.9} />
      </mesh>
      <primitive
        object={panda}
        position={[STATUE.along, TOP + STATUE.plinth.height, STATUE.across]}
        rotation={[0, STATUE.turn, 0]}
      />

      {/* Radiator Springs Speedway — see `SPEEDWAY`. Seven materials, and
          every one of them a merged geometry. */}
      {built.speedway.asphalt && (
        <mesh geometry={built.speedway.asphalt} receiveShadow>
          <meshStandardMaterial
            map={built.asphalt}
            color={SPEEDWAY.colours.asphalt}
            roughness={0.95}
          />
        </mesh>
      )}
      {built.speedway.kerb && (
        <mesh geometry={built.speedway.kerb} receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.kerb} roughness={0.8} />
        </mesh>
      )}
      {built.speedway.rumble && (
        <mesh geometry={built.speedway.rumble} receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.rumble} roughness={0.8} />
        </mesh>
      )}
      {/* The ramps' paint: one mesh per livery colour, each a merged
          geometry of every block dealt that colour. See `SPEEDWAY.paint`. */}
      {built.speedway.livery.map((geometry, i) => geometry && (
        <mesh key={SPEEDWAY.colours.livery[i]} geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.livery[i]} roughness={0.72} />
        </mesh>
      ))}
      {built.speedway.pitFloor && (
        <mesh geometry={built.speedway.pitFloor} receiveShadow>
          <meshStandardMaterial
            map={built.grain}
            color={SPEEDWAY.colours.pitFloor}
            roughness={0.95}
          />
        </mesh>
      )}
      {built.speedway.pitPad && (
        <mesh geometry={built.speedway.pitPad} receiveShadow>
          <meshStandardMaterial
            map={built.grain}
            color={SPEEDWAY.colours.pitPad}
            roughness={0.92}
          />
        </mesh>
      )}
      {/* One mesh per pit box, each the colour of the team that owns it. */}
      {built.speedway.pitTeam.map((geometry, i) => geometry && (
        <mesh key={SPEEDWAY.colours.pitTeam[i]} geometry={geometry} receiveShadow>
          <meshStandardMaterial
            map={built.grain}
            color={SPEEDWAY.colours.pitTeam[i]}
            roughness={0.9}
          />
        </mesh>
      ))}
      {built.speedway.pitWall && (
        <mesh geometry={built.speedway.pitWall} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.pitWall} roughness={0.85} />
        </mesh>
      )}
      {built.speedway.pitRig && (
        <mesh geometry={built.speedway.pitRig} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.pitRig} roughness={0.7} />
        </mesh>
      )}
      {built.speedway.tyre && (
        <mesh geometry={built.speedway.tyre} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.tyre} roughness={0.95} />
        </mesh>
      )}
      {built.speedway.tyrePaint && (
        <mesh geometry={built.speedway.tyrePaint} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.tyrePaint} roughness={0.9} />
        </mesh>
      )}
      {built.speedway.seat && (
        <mesh geometry={built.speedway.seat} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.seat} roughness={0.75} />
        </mesh>
      )}
      {/* The stand's seating, one mesh per colour block — see
          `SPEEDWAY.colours.seatBlocks`. */}
      {built.speedway.seatBlocks.map((geometry, i) => geometry && (
        <mesh key={SPEEDWAY.colours.seatBlocks[i]} geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.seatBlocks[i]} roughness={0.72} />
        </mesh>
      ))}
      {built.speedway.standRoof && (
        <mesh geometry={built.speedway.standRoof} castShadow receiveShadow>
          <meshStandardMaterial
            color={SPEEDWAY.colours.standRoof}
            roughness={0.55}
            metalness={0.3}
            side={DoubleSide}
          />
        </mesh>
      )}
      {built.speedway.concrete && (
        <mesh geometry={built.speedway.concrete} castShadow receiveShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.concrete} roughness={0.9} />
        </mesh>
      )}
      {built.speedway.steel && (
        <mesh geometry={built.speedway.steel} castShadow receiveShadow>
          <meshStandardMaterial
            color={SPEEDWAY.colours.steel}
            roughness={0.5}
            metalness={0.45}
          />
        </mesh>
      )}
      {built.speedway.chequer && (
        <mesh geometry={built.speedway.chequer} castShadow>
          <meshStandardMaterial color={SPEEDWAY.colours.chequer} roughness={0.7} />
        </mesh>
      )}
      {built.speedway.lamp && (
        <mesh geometry={built.speedway.lamp}>
          <meshStandardMaterial
            color={SPEEDWAY.colours.lamp}
            emissive={SPEEDWAY.colours.lamp}
            emissiveIntensity={0.75}
            roughness={0.35}
          />
        </mesh>
      )}
      {SPEEDWAY.cars.map((car) => <SpeedwayCar key={car.label} car={car} />)}

      {/* The planting and the furniture: one instanced mesh per part, so the
          whole park's greenery and seating is a dozen draw calls. */}
      {[...built.layout].map(([part, at]) => (
        <Kit key={part} pairs={kit.get(part)} at={at} lift={FLAT_LIFT[part] ?? 0} />
      ))}
      {/* The arcade, fronting the west walk. */}
      <Kit pairs={kit.get(KIT.arcade)} at={[{ x: ARCADE.along, z: ARCADE.across, turn: ARCADE.turn }]} />

      {/* Solid: the rides you could drive into, and the fountain kerb. The
          moving parts are not — a 43 m wheel with a collider is a blade.

          The rides FOLLOW their geometry rather than their bounds. A roller
          coaster's bounding box is 100 x 55 m and 4% of it is coaster; boxed
          whole, most of the east half of the park was a wall you could see
          straight through. See `partColliders`. */}
      <RigidBody type="fixed" colliders={false}>
        {RIDES.map((r) => partColliders(r.part, r.along, r.across, r.turn, sizeOf(r.part), r.label))}
        {/* The statue's plinth — a cylinder the size of the disc, and nothing
            round it. The fountain here had a 24 m BOX for a 12 m basin, and
            its corners were the invisible walls on the plaza. */}
        <CylinderCollider
          args={[(STATUE.plinth.height + 1.2) / 2, STATUE.plinth.radius]}
          position={[STATUE.along, TOP + (STATUE.plinth.height + 1.2) / 2, STATUE.across]}
        />
        {/* The arcade. Solid like the rides — the planting is not, the same
            as the city's own street furniture. */}
        {[{ part: KIT.arcade, ...ARCADE }, ...SHOPS].map((shop) => partColliders(
          shop.part, shop.along, shop.across, shop.turn, sizeOf(shop.part), shop.part,
        ))}
        {/* The speedway's own structures. The circuit is not solid — it is a
            road, and a road you cannot drive on is a wall painted like one —
            and neither are the cars on it, for the reason the ferris wheel is
            bare. What you can hit is what a spectator could walk into: the
            grandstand, the gantry legs and the masts. */}
        {/*
          * The stand, as a stack of boxes along its arc.
          *
          * It used to be ONE axis-aligned box, which was right while the stand
          * was a straight staircase at a fixed `along`. It bends with the
          * circuit now, and a single box round a curve is either a wall across
          * the track at one end or a gap at the other. One box per 4 m of arc,
          * each turned to the track, is the same fix the ramps needed.
          */}
        {(() => {
          const T = SPEEDWAY.stand;
          /*
           * The WHOLE volume, not just the seating.
           *
           * It used to be a box as deep as the rake and as tall as the top
           * row, which left the back wall and everything above the seating as
           * air you could drive a drone through. The stand is a closed object
           * now — both ends panelled, a back wall, a roof — so its collider is
           * the whole of it: full depth including the back wall, full height
           * to the top of that wall.
           */
          const depth = T.tread * T.rows + T.back.thick;
          const height = T.rise * T.rows + T.back.height;
          const step = 4;
          const out = [];
          for (let d = T.from; d < T.to - 1e-6; d += step) {
            const to = Math.min(d + step, T.to);
            const mid = (d + to) / 2;
            const p = LAP.point(mid);
            const q = LAP.point(mid + 0.4);
            const dx = q[0] - p[0];
            const dz = q[1] - p[1];
            const len = Math.hypot(dx, dz) || 1;
            const off = T.offset + depth / 2;
            out.push(
              <CuboidCollider
                key={`stand${d.toFixed(0)}`}
                args={[depth / 2, height / 2, (to - d) / 2]}
                position={[
                  p[0] + (-dz / len) * off, TOP + height / 2, p[1] + (dx / len) * off,
                ]}
                rotation={[0, Math.atan2(dx / len, dz / len), 0]}
              />,
            );
          }
          return out;
        })()}
        {/*
          * The ramps, and they need colliders for a reason the rest of the
          * circuit does not: they are the only part of it that is not flat.
          *
          * Everything else here is either a road you drive on or scenery you
          * drive round. A ramp is a solid object with a hollow inside, and
          * with nothing in the physics world it was a shell you flew straight
          * through — the drone went in one side and sat inside it.
          *
          * One box per two metres, each turned to the track and sized to the
          * deck height at its middle, so the stack of them follows the curve.
          * A single box would be a wedge-shaped hill approximated by a brick.
          */}
        {LAP.ramps.flatMap((r, ri) => {
          /*
           * THE SLABS ARE TILTED. This is what you drive up.
           *
           * They used to be flat-topped boxes, each one as tall as the deck at
           * its own middle and turned only about Y. A stack of those is a
           * staircase: at the steep end of a 3.2 m ramp, consecutive 2 m boxes
           * differ by about 90 cm, so a car climbing it hit a chest-high
           * vertical face nine times on the way up. It was drivable in a light
           * car that skipped over the noses of the steps and impossible in
           * anything with real mass — which is exactly how it was reported,
           * "hard hitting".
           *
           * Now each slab is pitched to the gradient across its own span, so
           * its top face lies along the ramp instead of across it and the
           * stack is continuous to within a few millimetres. Three things
           * follow from the tilt:
           *
           *  - the half-length is divided by cos(pitch), because a tilted box
           *    covers less ground than its own length and the shortfall is 15%
           *    at the lip — which would put a gap between every pair;
           *  - the slabs are `THICK` and sink below the ground rather than
           *    standing on it, so the tilt cannot open a wedge underneath;
           *  - the quadratic is convex, so a tangent plane lies just UNDER the
           *    surface it touches. Half a centimetre of lift puts the collider
           *    back on the visible deck rather than under it.
           *
           * The rotation is built as a quaternion and converted, because it is
           * yaw-then-pitch about the car's own lateral axis and the collider
           * takes a plain XYZ Euler.
           */
          const step = 1;
          const THICK = 3;
          const boxes = [];
          const wide = SPEEDWAY.width / 2 + SPEEDWAY.kerb + SPEEDWAY.parapet.width;
          for (let d = r.from; d < r.to - 1e-6; d += step) {
            const to = Math.min(d + step, r.to);
            const mid = (d + to) / 2;
            const run = to - d;
            const h = LAP.deckAt(mid);
            const pitch = Math.atan2(LAP.deckAt(to) - LAP.deckAt(d), run);
            if (h < 0.02 && Math.abs(pitch) < 1e-3) continue;
            const p = LAP.point(mid);
            const q = LAP.point(mid + 0.4);
            const yaw = Math.atan2(q[0] - p[0], q[1] - p[1]);
            const quat = new Quaternion()
              .setFromAxisAngle(new Vector3(0, 1, 0), yaw)
              // NEGATED, and it is not a fudge. `yaw` is built so the slab's
              // local +Z points down the track, and a positive turn about X
              // tilts local up toward +Z — forward. A ramp rising ahead of you
              // has its normal leaning BACK. With the sign the other way each
              // slab's top face landed 1.6 m further on than the deck point it
              // was built for, which read as a 60 cm ledge at every seam.
              .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch));
            const e = new Euler().setFromQuaternion(quat, 'XYZ');
            /*
             * Back off along the slab's OWN up, not the world's.
             *
             * A tilted box's top face centre sits `THICK` away along the
             * rotated up vector, which at 32 degrees is 1.6 m of travel down
             * the track as well as 2.5 m down. Subtracting only the vertical
             * part slides every slab along its own ramp and the tops stop
             * meeting. Rotating (0,1,0) by the same quaternion is the whole
             * answer: the top face then lands exactly on the deck point this
             * slab was built for.
             */
            const up = new Vector3(0, 1, 0).applyQuaternion(quat).multiplyScalar(THICK);
            boxes.push(
              <CuboidCollider
                key={`ramp${ri}-${d.toFixed(1)}`}
                args={[wide, THICK, run / 2 / Math.cos(pitch)]}
                position={[p[0] - up.x, TOP + h + 0.01 - up.y, p[1] - up.z]}
                rotation={[e.x, e.y, e.z]}
              />,
            );
          }
          return boxes;
        })}
        {SPEEDWAY.masts.map((mast) => (
          <CuboidCollider
            key={`mast${mast.across}-${mast.at}`}
            args={[SPEEDWAY.mast.post, SPEEDWAY.mast.height / 2, SPEEDWAY.mast.post]}
            position={[mast.at, TOP + SPEEDWAY.mast.height / 2, mast.across]}
          />
        ))}
        {/* The hedge, one box per run rather than one per shrub: 270 of them
            would be 270 colliders, and a hedge is a wall whatever it is made
            of. Without these you drive straight through it and the gate
            means nothing. */}
        {parkBoundaryRuns().map(([x0, z0, x1, z1], i) => (
          <CuboidCollider
            key={`hedge${i}`}
            args={[PARK_HEDGE.halfDepth, PARK_HEDGE.halfHeight, Math.hypot(x1 - x0, z1 - z0) / 2]}
            position={[(x0 + x1) / 2, PARK_HEDGE.halfHeight, (z0 + z1) / 2]}
            rotation={[0, Math.atan2(x1 - x0, z1 - z0), 0]}
          />
        ))}
      </RigidBody>
    </group>
  );
}
