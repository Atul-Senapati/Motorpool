'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  BackSide, BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Euler, Group, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, Vector3, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CuboidCollider, RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { DRACO_PATH } from '@/config/cityConfig';
import countryModels from '@/config/countryModelData.json';
import train08Data from '@/config/train08Data.json';
import wagonHopperData from '@/config/wagonHopperData.json';
import { MINE, RAIL_GAP, filletAlignment, groundAt, makeRandom, railPose } from '@/config/countryConfig';
import { leadCurve } from '@/config/stationConfig';
import { RAIL_HEAD_LIFT, TRAIN } from '@/config/trainConfig';
import { bladeFraction, bladedRailProfile, standsAlone, type BladedSample } from './switchBlade';
import { RAIL_STEEL, buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { makeBallastTexture } from './CountryRail';
import { SLEEPER_GEOMETRY, SLEEPER_MATERIAL } from './sleeper';
import { InstancedField } from './instancedField';

/**
 * Skylark Quarry: the working, the works, and the loop line through them.
 *
 * The ground is the quarry — `mineAt` in `countryConfig` cuts the horseshoe
 * into the hill and the terrace it opens onto — so what stands here is what
 * a real hard-rock quarry stands on that ground, laid out the way stone
 * actually moves through one:
 *
 *   face → excavator → tipper → primary crusher → conveyor → screen house
 *        → conveyors → stockpiles → load-out (rail bin over the loop, silos
 *          over the works road) → weighbridge → gate
 *
 * ## The goods loop
 *
 * Stone leaves by train as well as by lorry. A goods loop comes off the
 * island railway's east road south of the works, runs parallel to it along
 * the works' west edge past the rail load-out, and rejoins the main line to
 * the north — a passing loop, the way a quarry's exchange sidings are laid
 * where the main line runs past the gate. A shunter and four hoppers stand
 * on its straight, clear of the load-out shed, waiting to be drawn under it. It is the main line's own track: its
 * rail section, its sleeper, its ballast, and its grade, because the loop
 * lies on the line's own shoulder the whole way.
 *
 * Inside the fence the works are one open yard: the works road runs through
 * the middle from the gate, the haul road north from it into the pit, and
 * everything else stands off both, so the yard can be driven round.
 *
 * The old working is still here as history — the adit in the back face and
 * its two-foot tramway — because the user dug that tunnel and it is a good
 * tunnel. It now runs out to a stone bin at the pit's west side.
 *
 * ## Frames and levels
 *
 * All local: the island's frame, metres. The terrace and the floor are
 * `MINE.terrace.y`; anything on ground the terrain shapes (the tip, the ramp,
 * the bench road) asks `groundAt`. Rail heads are `RAIL_HEAD_LIFT` over the
 * formation, exactly as on the main line, because this is the main line's
 * track — its rail section, its sleeper, its ballast.
 */

/* --------------------------------------------------------------- stock */

type Mat = 'steel' | 'rust' | 'timber' | 'stone' | 'brick' | 'slate' | 'concrete' | 'dark' | 'rock'
  | 'ballast' | 'railhead' | 'bore' | 'masonry' | 'belt' | 'paint' | 'mesh' | 'water' | 'glass' | 'aggregate' | 'asphalt';

const MATERIALS: Record<Mat, MeshStandardMaterial> = {
  steel: new MeshStandardMaterial({ color: '#7d848c', roughness: 0.55, metalness: 0.5, side: DoubleSide }),
  rust: new MeshStandardMaterial({ color: '#8a5433', roughness: 0.85, metalness: 0.25 }),
  timber: new MeshStandardMaterial({ color: '#6a5539', roughness: 0.92 }),
  stone: new MeshStandardMaterial({ color: '#9b9488', roughness: 0.95 }),
  brick: new MeshStandardMaterial({ color: '#8d5a45', roughness: 0.93 }),
  slate: new MeshStandardMaterial({ color: '#4a4f55', roughness: 0.7, side: DoubleSide }),
  concrete: new MeshStandardMaterial({ color: '#8c8a83', roughness: 0.94 }),
  dark: new MeshStandardMaterial({ color: '#26282b', roughness: 0.8 }),
  rock: new MeshStandardMaterial({ color: '#8f8778', roughness: 1 }),
  ballast: new MeshStandardMaterial({ color: '#6f6a5e', roughness: 1 }),
  railhead: new MeshStandardMaterial({ color: '#9aa0a6', roughness: 0.34, metalness: 0.85 }),
  bore: new MeshStandardMaterial({ color: '#15171a', roughness: 1, side: BackSide }),
  masonry: new MeshStandardMaterial({ color: '#6b6a66', roughness: 0.88 }),
  belt: new MeshStandardMaterial({ color: '#1e1f21', roughness: 0.75 }),
  paint: new MeshStandardMaterial({ color: '#c9a227', roughness: 0.6, metalness: 0.2 }),
  mesh: new MeshStandardMaterial({ color: '#3a3d40', roughness: 0.9, transparent: true, opacity: 0.38, side: DoubleSide }),
  water: new MeshStandardMaterial({ color: '#5f7d80', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.82 }),
  glass: new MeshStandardMaterial({ color: '#7fa0b4', roughness: 0.2, metalness: 0.3 }),
  aggregate: new MeshStandardMaterial({ color: '#857e70', roughness: 1 }),
  // The site roads: asphalt, dusty with the stone that comes off the lorries.
  asphalt: new MeshStandardMaterial({ color: '#4d4b47', roughness: 0.95 }),
};

interface Solid { x: number; y: number; z: number; turn: number; w: number; h: number; d: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** A yaw that faces a −Z-baked model along (dx, dz). */
const facing = (dx: number, dz: number) => Math.atan2(-dx, -dz);
/** A yaw that lays a box's own X axis along (dx, dz). */
const across = (dx: number, dz: number) => Math.atan2(-dz, dx);

/** Geometry by material, plus the boxes Rapier gets. */
class Site {
  parts = new Map<Mat, BufferGeometry[]>();
  solids: Solid[] = [];

  add(mat: Mat, g: BufferGeometry) {
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat)!.push(flat);
  }

  box(mat: Mat, w: number, h: number, d: number, x: number, y: number, z: number, turn = 0, pitch = 0) {
    const g = new BoxGeometry(w, h, d);
    if (pitch) g.rotateX(pitch);
    if (turn) g.rotateY(turn);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  strut(mat: Mat, a: readonly [number, number, number], b: readonly [number, number, number], t: number) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const g = new BoxGeometry(t, len, t);
    g.rotateX(Math.acos(Math.max(-1, Math.min(1, dy / len))));
    g.rotateY(Math.atan2(dx, dz));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.add(mat, g);
  }

  cylinder(mat: Mat, rTop: number, rBottom: number, h: number, x: number, y: number, z: number, seg = 14) {
    const g = new CylinderGeometry(rTop, rBottom, h, seg);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  solid(w: number, h: number, d: number, x: number, y: number, z: number, turn = 0) {
    this.solids.push({ x, y, z, turn, w, h, d });
  }

  merged() {
    const out: Array<{ mat: Mat; geometry: BufferGeometry }> = [];
    for (const [mat, list] of this.parts) {
      const geometry = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (geometry) {
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        out.push({ mat, geometry });
      }
    }
    return out;
  }
}

/* --------------------------------------------------------------- track */

const T = MINE.terrace.y;
const F = MINE.floorY;

interface RailPt extends BladedSample {
  tx: number;
  tz: number;
  /** Formation over the ground under it. */
  fill: number;
  /** Centre to centre from the running road it is an offset of; Infinity for a track of its own. */
  offset: number;
}

/** Even samples along a fillet alignment at `step`, with tangents and normals. */
function resample(pts: ReadonlyArray<readonly [number, number]>, radius: number, step: number): Array<[number, number]> {
  const { line } = filletAlignment(pts, radius);
  const fine: Array<[number, number]> = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [px, pz] = line[i - 1];
    const [qx, qz] = line[i];
    const n = Math.max(1, Math.round(Math.hypot(qx - px, qz - pz) / step));
    for (let k = 1; k <= n; k++) fine.push([px + ((qx - px) * k) / n, pz + ((qz - pz) * k) / n]);
  }
  return fine;
}

function toRail(fine: Array<[number, number]>, y: number[], closed: boolean): RailPt[] {
  const n = fine.length;
  let arc = 0;
  return fine.map(([x, z], i) => {
    if (i > 0) arc += Math.hypot(x - fine[i - 1][0], z - fine[i - 1][1]);
    const a = fine[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = fine[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return {
      x, z, y: y[i], nx: -dz / len, nz: dx / len, tx: dx / len, tz: dz / len, arc, blade: 1, offset: Infinity,
      fill: Math.max(0, y[i] - groundAt(x, z)),
    };
  });
}

/** One road of standard-gauge track over `formation` samples: ballast, rails, sleeper matrices. */
function buildTrack(formation: RailPt[], fromArc = 0) {
  const head: RailPt[] = formation.map((p) => ({ ...p, y: p.y + RAIL_HEAD_LIFT }));
  const sleeperBottom = -TRAIN.railHeight - TRAIN.sleeperHeight;
  // The main line's own section: its crown half, its depth, its batter.
  const crown = TRAIN.ballastCrownHalf;
  const drop = (p: RailPt) => TRAIN.ballastDepth + p.fill + 0.06;
  const toe = (p: RailPt) => crown + TRAIN.ballastSlope * drop(p);
  /**
   * The shoulder on the running line's side. Where this road is an offset
   * of a running road, the line's own crown reaches `RAIL_GAP / 2 +
   * crownHalf` past the pair's centre — `crownHalf` past the east road — and
   * this road's bed meets it EDGE TO EDGE there, flat at crown height, rather
   * than laying a second crown over the first: two coplanar beds z-fight, and
   * a yard is one bed anyway. `offset` is measured from the east road, so
   * the line's crown edge is at `crown - offset` in this road's own frame.
   */
  const inner = (p: RailPt) => Math.max(-toe(p), crown - p.offset);
  const innerCrown = (p: RailPt) => Math.max(-crown, crown - p.offset);
  const ballast = buildLoft(head, [
    { off: inner, rise: (p) => (inner(p) > -toe(p) + 0.01 ? sleeperBottom : sleeperBottom - drop(p)) },
    { off: innerCrown, rise: sleeperBottom },
    { off: crown, rise: sleeperBottom },
    { off: (p) => toe(p), rise: (p) => sleeperBottom - drop(p) },
  ], { vScale: 4, filter: (a, b) => a.offset > 0.4 && b.offset > 0.4 });
  // The rails taper into switch blades where the road closes on the line it
  // joins (`blade` < 1), exactly as the station's loops and the crossovers do
  // — the same module, so it is the same pointwork.
  const rails = [
    buildLoft(head, bladedRailProfile<RailPt>(-TRAIN.gauge / 2), { closed: true, vScale: 9 }),
    buildLoft(head, bladedRailProfile<RailPt>(TRAIN.gauge / 2), { closed: true, vScale: 9 }),
  ];
  const sleepers: Matrix4[] = [];
  const position = new Vector3();
  const quaternion = new Quaternion();
  const euler = new Euler();
  const one = new Vector3(1, 1, 1);
  const total = head[head.length - 1].arc;
  for (let a = fromArc; a < total - 0.5; a += TRAIN.sleeperSpacing) {
    const i = Math.min(head.length - 1, Math.round((a / total) * (head.length - 1)));
    const p = head[i];
    // Under the blades the road shares the running line's sleepers.
    if (!standsAlone(p)) continue;
    euler.set(0, Math.atan2(p.tx, p.tz), 0);
    quaternion.setFromEuler(euler);
    position.set(p.x, p.y + sleeperBottom, p.z);
    sleepers.push(new Matrix4().compose(position, quaternion, one));
  }
  return { head, ballast, rails, sleepers, total };
}

/**
 * The goods loop, laid the way the station lays its loops: as a lateral
 * OFFSET from the running line, in the line's own frame. From the south
 * switch the offset ramps out from nothing to the yard gap over the lead,
 * holds it along the straight under the bin, and ramps back to nothing at the
 * north switch — with `leadCurve`, the flat-topped ramp the station uses,
 * because a turnout is a switch, a short curve and then a straight diagonal
 * at a fixed angle, not a bell. Where the offset is under `bladeGap` the
 * rails are drawn as switch blades lying against the stock rails, and the
 * road shares the line's sleepers; clear of it, it is its own track with its
 * own shoulder. The profile is the running line's own formation, sample for
 * sample.
 */
const LOOP_FROM = 750;
const LOOP_TO = 990;
/** The lead: how much of the line each turnout takes to open the full gap — 1 in 6, a yard turnout. */
const LOOP_TAPER = 70;
/**
 * Centre to centre from the east road. Wide, because the load-bay shed
 * straddles the loop and is 14.9 m across: its wall has to stand clear of a
 * train on the main line, which puts the loop's centre 10.5 m out.
 */
const LOOP_GAP = 10.5;
const LOOP_STEP = 1.5;
/** Where the load-bay shed stands over the straight (its centre, in z): at its north end, the rake standing clear of it to the south. */
const RAIL_SHED_Z = 45;

function buildLoopLine() {
  const fine: Array<[number, number]> = [];
  const y: number[] = [];
  const blade: number[] = [];
  const offsets: number[] = [];
  const count = Math.round((LOOP_TO - LOOP_FROM) / LOOP_STEP);
  for (let i = 0; i <= count; i++) {
    const s = LOOP_FROM + (i / count) * (LOOP_TO - LOOP_FROM);
    const ramp = Math.min(leadCurve((s - LOOP_FROM) / LOOP_TAPER), leadCurve((LOOP_TO - s) / LOOP_TAPER));
    const offset = LOOP_GAP * ramp;
    const [x, fy, z] = railPose(s, -RAIL_GAP / 2 - offset);
    fine.push([x, z]);
    y.push(fy);
    blade.push(bladeFraction(offset));
    offsets.push(offset);
  }
  const formation = toRail(fine, y, false).map((p, i) => ({
    ...p, blade: blade[i], offset: offsets[i],
    fill: Math.max(0, y[i] - groundAt(p.x, p.z)),
  }));
  const track = buildTrack(formation);
  /** The arc of the first sample at or past `z` on the straight (the loop runs north, +z). */
  const arcAtZ = (z: number) => {
    const i = formation.findIndex((p) => p.blade >= 1 && p.z >= z);
    return formation[i < 0 ? formation.length - 1 : i].arc;
  };
  const poseAt = (arc: number) => {
    const total = track.total;
    const t = (Math.min(Math.max(arc, 0), total) / total) * (formation.length - 1);
    const i = Math.floor(t);
    const f = t - i;
    const p = formation[i];
    const q = formation[Math.min(formation.length - 1, i + 1)];
    const tx = lerp(p.tx, q.tx, f);
    const tz = lerp(p.tz, q.tz, f);
    return { x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f) + RAIL_HEAD_LIFT, z: lerp(p.z, q.z, f), tx, tz };
  };
  /** Where the straight runs: the z range with the full gap open. */
  const straight = formation.filter((p) => p.blade >= 1);
  return { ...track, formation, arcAtZ, poseAt, straightZ: [straight[0].z, straight[straight.length - 1].z] as const };
}

type Loop = ReturnType<typeof buildLoopLine>;

/* ----------------------------------------------------------- conveyors */

type P3 = readonly [number, number, number];

/**
 * One belt conveyor from `tail` to `head`: a lattice gantry with the belt on
 * top, a drum housing at each end, and A-frame legs down to the ground every
 * twelve metres or so. Built in its own frame — `u` along, `v` across — and
 * swung round, so the same code lays a 70 m incline out of the pit and a
 * 20 m stub onto a stockpile.
 */
function conveyor(s: Site, tail: P3, head: P3, opts: { legs?: boolean; feed?: boolean } = {}) {
  const dx = head[0] - tail[0];
  const dy = head[1] - tail[1];
  const dz = head[2] - tail[2];
  const run = Math.hypot(dx, dz);
  const len = Math.hypot(run, dy);
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.atan2(dy, run);
  const W = 1.1;
  const D = 0.9;
  const at = (u: number, v: number, w: number): P3 => {
    const ux = u * Math.sin(yaw) * Math.cos(-pitch);
    const uz = u * Math.cos(yaw) * Math.cos(-pitch);
    const uy = u * Math.sin(-pitch);
    return [
      tail[0] + ux + v * Math.cos(yaw) - w * Math.sin(yaw) * Math.sin(-pitch),
      tail[1] + uy + w * Math.cos(-pitch),
      tail[2] + uz - v * Math.sin(yaw) - w * Math.cos(yaw) * Math.sin(-pitch),
    ];
  };
  for (const v of [-W / 2, W / 2]) {
    s.strut('paint', at(0, v, 0), at(len, v, 0), 0.12);
    s.strut('paint', at(0, v, D), at(len, v, D), 0.12);
  }
  const bays = Math.max(2, Math.round(len / 2.4));
  for (let k = 0; k <= bays; k++) {
    const u = (k / bays) * len;
    for (const v of [-W / 2, W / 2]) {
      s.strut('paint', at(u, v, 0), at(u, v, D), 0.07);
      if (k < bays) s.strut('paint', at(u, v, 0), at(u + len / bays, v, D), 0.06);
    }
    s.strut('paint', at(u, -W / 2, 0), at(u, W / 2, 0), 0.07);
    s.strut('paint', at(u, -W / 2, D), at(u, W / 2, D), 0.07);
  }
  {
    const g = new BoxGeometry(0.8, 0.05, len - 1.2);
    g.rotateX(pitch);
    g.rotateY(yaw);
    const c = at(len / 2, 0, D + 0.06);
    g.translate(c[0], c[1], c[2]);
    s.add('belt', g);
    const load = new BoxGeometry(0.5, 0.14, len - 2.4);
    load.rotateX(pitch);
    load.rotateY(yaw);
    load.translate(c[0], c[1] + 0.09, c[2]);
    s.add('rock', load);
  }
  for (const [u, big] of [[0.4, false], [len - 0.5, true]] as const) {
    const c = at(u, 0, D + 0.1);
    s.box('steel', W + 0.5, big ? 0.9 : 0.6, big ? 1.4 : 0.9, c[0], c[1], c[2], yaw);
  }
  if (opts.feed !== false) {
    const c = at(len - 0.6, 0, -0.6);
    s.box('steel', 1.4, 1.2, 1.1, c[0], c[1], c[2], yaw);
  }
  if (opts.legs !== false) {
    const count = Math.max(1, Math.round(len / 12));
    for (let k = 1; k <= count; k++) {
      const u = (k / (count + 1)) * len;
      const top = at(u, 0, -0.1);
      const gy = groundAt(top[0], top[2]);
      const dropTo = top[1] - gy;
      if (dropTo < 1.2) continue;
      const spread = 0.9 + dropTo * 0.18;
      const l = at(u, -spread, 0);
      const r = at(u, spread, 0);
      const foot = (p: P3): P3 => [p[0], gy, p[2]];
      s.strut('paint', [top[0] - Math.cos(yaw) * W / 2, top[1], top[2] + Math.sin(yaw) * W / 2], foot(l), 0.16);
      s.strut('paint', [top[0] + Math.cos(yaw) * W / 2, top[1], top[2] - Math.sin(yaw) * W / 2], foot(r), 0.16);
      s.strut('paint', [foot(l)[0], gy + dropTo * 0.45, foot(l)[2]], [foot(r)[0], gy + dropTo * 0.45, foot(r)[2]], 0.09);
      for (const p of [l, r]) {
        s.box('concrete', 1.1, 0.4, 1.1, p[0], gy + 0.2, p[2]);
        s.solid(0.5, dropTo, 0.5, p[0], gy + dropTo / 2, p[2]);
      }
    }
  }
}

/* --------------------------------------------------------- the plant */

/** The primary crusher in the pit's mouth, and the ramp the tippers tip into it from. */
const PRIMARY = { x: -380, z: 110 };
const RAMP_RISE = 5.4;
const RAMP_LEN = 26;
const RAMP_PITCH = Math.atan2(RAMP_RISE, RAMP_LEN);

function primary(s: Site) {
  const X = PRIMARY.x;
  const Z = PRIMARY.z;
  const rampZ0 = Z - 6 - RAMP_LEN;
  const deckLen = Math.hypot(RAMP_RISE, RAMP_LEN);
  s.box('rock', 8.4, 0.4, deckLen, X, F + RAMP_RISE / 2 + 0.1, rampZ0 + RAMP_LEN / 2, 0, -RAMP_PITCH);
  s.solid(8.4, 0.5, deckLen, X, F + RAMP_RISE / 2 + 0.1, rampZ0 + RAMP_LEN / 2);
  // The fill under the deck, in eight risers: a ramp is an embankment with a
  // road on it, and a deck with daylight under it is a bridge.
  for (let k = 0; k < 8; k++) {
    const z0 = rampZ0 + (k / 8) * RAMP_LEN;
    const h = ((k + 0.5) / 8) * RAMP_RISE;
    s.box('rock', 8.2, h, RAMP_LEN / 8 + 0.02, X, F + h / 2, z0 + RAMP_LEN / 16);
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z0 = rampZ0 + (k / 4) * RAMP_LEN;
      const h = 0.9 + ((k + 1) / 4) * RAMP_RISE;
      s.box('concrete', 0.6, h, RAMP_LEN / 4 + 0.05, X + side * 4.5, F + h / 2, z0 + RAMP_LEN / 8);
      s.solid(0.6, h, RAMP_LEN / 4, X + side * 4.5, F + h / 2, z0 + RAMP_LEN / 8);
    }
    s.box('concrete', 0.6, RAMP_RISE + 1.4, 7, X + side * 4.5, F + (RAMP_RISE + 1.4) / 2, Z - 6 + 3.5);
    s.solid(0.6, RAMP_RISE + 1.4, 7, X + side * 4.5, F + (RAMP_RISE + 1.4) / 2, Z - 6 + 3.5);
  }
  s.box('rock', 8.4, 0.5, 7, X, F + RAMP_RISE + 0.05, Z - 6 + 3.5);
  s.solid(8.4, 0.6, 7, X, F + RAMP_RISE + 0.05, Z - 6 + 3.5);
  s.box('concrete', 8.4, 0.7, 0.5, X, F + RAMP_RISE + 0.6, Z - 2.4);
  const lip = F + RAMP_RISE + 0.3;
  {
    const g = new CylinderGeometry(4.1, 1.1, 3.6, 4, 1, true);
    g.rotateY(Math.PI / 4);
    g.translate(X, lip - 1.8, Z);
    s.add('rust', g);
    for (const [ax, az] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      s.strut('steel', [X + ax * 3.2, F, Z + az * 3.2], [X + ax * 2.8, lip - 0.3, Z + az * 2.8], 0.3);
      s.solid(0.4, lip - F, 0.4, X + ax * 3.2, (lip + F) / 2, Z + az * 3.2);
    }
    for (let k = -3; k <= 3; k++) s.box('steel', 0.12, 0.2, 5.6, X + k * 0.75, lip + 0.05, Z);
    s.box('steel', 5.9, 0.25, 0.25, X, lip + 0.1, Z - 2.9);
    s.box('steel', 5.9, 0.25, 0.25, X, lip + 0.1, Z + 2.9);
  }
  s.box('concrete', 5, 0.8, 5, X, F + 0.4, Z + 0.5);
  s.box('steel', 3.2, 2.6, 3.4, X, F + 2.1, Z + 0.5);
  s.solid(3.2, 2.6, 3.4, X, F + 2.1, Z + 0.5);
  s.cylinder('dark', 1.05, 1.05, 1.2, X + 2.6, F + 1.6, Z + 0.5, 16);
  s.box('paint', 0.5, 0.5, 2.2, X + 2.6, F + 2.4, Z + 0.5);
  for (const side of [-1, 1]) {
    s.box('steel', 1.2, 0.08, 8.4, X + side * 4.4, lip + 0.1, Z);
    s.box('steel', 0.05, 1.05, 8.4, X + side * 5, lip + 0.65, Z);
    for (let k = -2; k <= 2; k++) s.box('steel', 0.05, 1.05, 0.05, X + side * 5, lip + 0.65, Z + k * 2);
  }
  s.box('steel', 1, 0.08, 9, X - 5.6, (lip + F) / 2, Z - 8, 0, Math.atan2(lip - F, 9));
}

/** The stockpile cones under their conveyor heads. */
const STOCKPILES: ReadonlyArray<{ x: number; z: number; r: number; h: number; mat: Mat }> = [
  { x: -404, z: -22, r: 11, h: 9.2, mat: 'aggregate' },
  { x: -424, z: -22, r: 9, h: 7.8, mat: 'aggregate' },
  { x: -382, z: -22, r: 9, h: 7.2, mat: 'stone' },
];

function stockpiles(s: Site) {
  for (const p of STOCKPILES) {
    const y = groundAt(p.x, p.z);
    const g = new ConeGeometry(p.r, p.h, 26, 1, false);
    g.translate(p.x, y + p.h / 2 - 0.2, p.z);
    s.add(p.mat, g);
    s.solid(p.r * 1.1, p.h * 0.5, p.r * 1.1, p.x, y + p.h * 0.25, p.z);
  }
}

/** The road load-out: two silos on legs either side of the works road; lorries load beneath. */
function roadLoadout(s: Site, x: number, z: number) {
  const gy = groundAt(x, z);
  const deck = gy + 6.4;
  for (const dz of [-5.6, 5.6]) {
    for (const dx of [-2.2, 2.2]) {
      s.strut('paint', [x + dx, gy, z + dz], [x + dx, deck, z + dz], 0.36);
      s.box('concrete', 1.2, 0.5, 1.2, x + dx, gy + 0.25, z + dz);
      s.solid(0.45, deck - gy, 0.45, x + dx, (deck + gy) / 2, z + dz);
    }
    s.cylinder('steel', 2.4, 2.4, 6.5, x, deck + 3.6, z + dz, 20);
    const cone = new CylinderGeometry(2.2, 0.45, 2.6, 20, 1, true);
    cone.translate(x, deck - 1, z + dz);
    s.add('steel', cone);
    s.box('rust', 0.8, 1.2, 0.8, x, deck - 2.8, z + dz);
    s.cylinder('slate', 2.45, 2.45, 0.3, x, deck + 7, z + dz, 20);
    s.box('steel', 5.2, 0.3, 5.2, x, deck, z + dz);
  }
  s.box('steel', 1.2, 0.1, 11.2, x, deck + 0.1, z);
  s.box('steel', 0.05, 1, 11.2, x - 0.6, deck + 0.6, z);
  s.box('steel', 0.05, 1, 11.2, x + 0.6, deck + 0.6, z);
  s.strut('steel', [x + 2.9, gy, z - 5.6], [x + 2.9, deck + 1, z - 5.6], 0.06);
  s.strut('steel', [x + 3.3, gy, z - 5.6], [x + 3.3, deck + 1, z - 5.6], 0.06);
}

/**
 * The site entrance: a proper gateway — two brick piers 6 m tall with a
 * steel portal across them carrying the name board, 16 m clear between for
 * the lorries — and inside it the weighbridge and the gatehouse. The
 * barriers are kit models, standing open beside the piers.
 */
const GATE_HALF = 8;

function gate(s: Site) {
  const G = MINE.gate;
  const gy = groundAt(G.x, G.z);
  // The piers, and the portal beam across.
  for (const side of [-1, 1]) {
    const pz = G.z + side * (GATE_HALF + 1);
    s.box('brick', 2, 6, 2, G.x, gy + 3, pz);
    s.box('concrete', 2.4, 0.3, 2.4, G.x, gy + 6.15, pz);
    s.solid(2, 6.3, 2, G.x, gy + 3.15, pz);
    // The fence's return to the pier.
    s.box('steel', 0.09, 2.3, 0.09, G.x, gy + 1.15, pz + side * 1.4);
  }
  s.box('steel', 0.5, 0.6, GATE_HALF * 2 + 2, G.x, gy + 6.6, G.z);
  s.box('paint', 0.14, 1.3, 9, G.x + 0.3, gy + 7.6, G.z);
  s.box('dark', 0.05, 0.85, 8.2, G.x + 0.4, gy + 7.6, G.z);
  // The weighbridge, just inside: a steel deck flush in a concrete pit with a
  // kerb each side, on the works road's line.
  const wx = G.x - 16;
  s.box('concrete', 18, 0.3, 4.6, wx, gy + 0.05, G.z);
  s.box('dark', 16, 0.12, 3.2, wx, gy + 0.26, G.z);
  s.box('paint', 16, 0.35, 0.3, wx, gy + 0.35, G.z - 1.8);
  s.box('paint', 16, 0.35, 0.3, wx, gy + 0.35, G.z + 1.8);
  // The gatehouse beside it.
  const hx = wx;
  const hz = G.z + 6.5;
  s.box('concrete', 5, 0.3, 4, hx, gy + 0.15, hz);
  s.box('steel', 4.4, 2.7, 3.2, hx, gy + 1.65, hz);
  s.box('glass', 4.5, 0.9, 3.3, hx, gy + 2.2, hz);
  s.box('slate', 4.9, 0.18, 3.7, hx, gy + 3.1, hz);
  s.solid(4.6, 3.2, 3.4, hx, gy + 1.9, hz);
  s.box('paint', 0.2, 0.02, 7, G.x - 5, gy + 0.03, G.z);
}

/** The perimeter: chain-link on posts, the gate left open in it; the railway cutting is the west boundary. */
function fence(s: Site) {
  const T2 = MINE.terrace;
  const x0 = T2.x - T2.w / 2 + 3;
  const x1 = T2.x + T2.w / 2 - 3;
  const z0 = T2.z - T2.d / 2 + 3;
  const runs: Array<[[number, number], [number, number]]> = [
    [[x0, z0], [x1, z0]],
    [[x1, z0], [x1, MINE.gate.z - GATE_HALF - 2]],
    [[x1, MINE.gate.z + GATE_HALF + 2], [x1, 60]],
  ];
  for (const [a, b] of runs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / 3));
    const samples: LoftSample[] = [];
    const dx = (b[0] - a[0]) / len;
    const dz = (b[1] - a[1]) / len;
    for (let k = 0; k <= n; k++) {
      const x = lerp(a[0], b[0], k / n);
      const z = lerp(a[1], b[1], k / n);
      const y = groundAt(x, z);
      s.box('steel', 0.09, 2.3, 0.09, x, y + 1.15, z);
      samples.push({ x, z, y, nx: -dz, nz: dx, arc: (k / n) * len });
    }
    s.add('mesh', buildLoft(samples, [{ off: 0, rise: 0.15 }, { off: 0, rise: 2.15 }], { vScale: 2 }).geometry);
    s.box('steel', 0.04, 0.04, len, (a[0] + b[0]) / 2, (groundAt(a[0], a[1]) + groundAt(b[0], b[1])) / 2 + 2.25,
      (a[1] + b[1]) / 2, Math.atan2(b[0] - a[0], b[1] - a[1]));
  }
}

/** Floodlight masts round the yard. */
function lights(s: Site) {
  for (const [x, z] of [[-364, 80], [-440, -34], [-360, -36], [-334, 30]] as const) {
    const gy = groundAt(x, z);
    s.box('concrete', 1.6, 0.6, 1.6, x, gy + 0.3, z);
    s.cylinder('steel', 0.14, 0.24, 17, x, gy + 8.5, z, 10);
    s.box('dark', 1.8, 0.5, 0.6, x, gy + 17.2, z);
    s.box('paint', 1.6, 0.25, 0.4, x, gy + 17.5, z);
    s.solid(0.5, 17, 0.5, x, gy + 8.5, z);
  }
}

/** The offices, the fuel point, the wheel wash and the workshop's yard clutter. */
function compound(s: Site) {
  // The offices are the industrial set's trailers (`PLACED`); this is what stands round them.
  // The fuel point: a bunded tank on saddles, a pump island, a canopy.
  {
    const x = -346;
    const z = 22;
    const gy = groundAt(x, z);
    s.box('concrete', 12, 0.5, 8, x, gy + 0.25, z);
    s.box('concrete', 12, 0.9, 0.3, x, gy + 0.7, z - 4);
    s.box('concrete', 12, 0.9, 0.3, x, gy + 0.7, z + 4);
    const tank = new CylinderGeometry(1.5, 1.5, 6.5, 16);
    tank.rotateZ(Math.PI / 2);
    tank.translate(x - 2, gy + 2.2, z);
    s.add('rust', tank);
    for (const k of [-2.2, 2.2]) s.box('steel', 0.7, 1.2, 2.6, x - 2 + k, gy + 0.9, z);
    s.solid(7, 3.6, 3.2, x - 2, gy + 2.2, z);
    s.box('paint', 0.9, 1.6, 0.6, x + 3.6, gy + 1.3, z - 1);
    s.strut('steel', [x + 5.5, gy, z - 3.5], [x + 5.5, gy + 4.2, z - 3.5], 0.15);
    s.strut('steel', [x + 5.5, gy, z + 3.5], [x + 5.5, gy + 4.2, z + 3.5], 0.15);
    s.box('slate', 5, 0.15, 8.4, x + 3.2, gy + 4.3, z);
  }
  // Oil drums by the workshop.
  const rnd = makeRandom(4141);
  for (let i = 0; i < 9; i++) {
    const x = -362 + (i % 3) * 0.9 + (rnd() - 0.5) * 0.2;
    const z = 50 + Math.floor(i / 3) * 0.9 + (rnd() - 0.5) * 0.2;
    s.cylinder(i % 4 === 0 ? 'paint' : 'rust', 0.3, 0.3, 0.88, x, groundAt(x, z) + 0.44, z, 12);
  }
  s.solid(3, 0.9, 3, -361.1, groundAt(-361, 51) + 0.45, 50.9);
  // Wheel wash: a shallow trough in the works road just inside the crossing.
  s.box('concrete', 12, 0.2, 4.2, -352, groundAt(-352, WORKS_Z) + 0.08, WORKS_Z);
  s.box('water', 11.2, 0.04, 3.4, -352, groundAt(-352, WORKS_Z) + 0.2, WORKS_Z);
}

function lagoon(s: Site) {
  const L = MINE.lagoon;
  const g = new CylinderGeometry(L.r - 0.6, L.r - 0.6, 0.04, 28);
  g.translate(L.x, T - 0.42, L.z);
  s.add('water', g);
}

/** The adit and its masonry, at the back face. */
function adit(s: Site) {
  const A = MINE.adit;
  const floor = F;
  const springing = 2.1;
  const bore = 2.25;
  const wallTop = floor + 7;
  const face = A.z;
  const tube = new CylinderGeometry(bore, bore, A.bore, 18, 1, true, 0, Math.PI);
  tube.rotateZ(Math.PI / 2);
  tube.rotateY(Math.PI / 2);
  tube.translate(A.x, floor + springing, face + A.bore / 2 - 0.4);
  s.add('bore', tube);
  for (const side of [-1, 1]) {
    const wall = new BoxGeometry(0.1, springing, A.bore);
    wall.translate(A.x + side * bore, floor + springing / 2, face + A.bore / 2 - 0.4);
    s.add('bore', wall);
  }
  s.box('bore', bore * 2, springing + bore, 0.1, A.x, floor + (springing + bore) / 2, face + A.bore - 0.4);
  s.box('dark', bore * 2, 0.12, A.bore, A.x, floor - 0.06, face + A.bore / 2 - 0.4);
  // The mouth: the terrain is cut back `A.mouth` behind the face, and where
  // the rock takes over again a black wall closes the bore, so that from the
  // pit the arch is a hole with dark in it and not a rock face in a frame.
  s.box('dark', bore * 2 + 0.4, springing + bore + 0.4, 0.12, A.x, floor + (springing + bore) / 2, face + A.mouth - 0.1);
  const wallZ = face - 0.7;
  const wingW = (A.half + A.feather * 0.7) - bore;
  for (const side of [-1, 1]) {
    s.box('masonry', wingW, wallTop - floor, 1.4, A.x + side * (bore + wingW / 2), floor + (wallTop - floor) / 2, wallZ);
    s.solid(wingW, wallTop - floor, 1.4, A.x + side * (bore + wingW / 2), floor + (wallTop - floor) / 2, wallZ);
  }
  s.box('masonry', bore * 2, wallTop - (floor + springing + bore), 1.4, A.x, (wallTop + floor + springing + bore) / 2, wallZ);
  for (let k = 0; k < 13; k++) {
    const ang = Math.PI * ((k + 0.5) / 13);
    const r = bore + 0.26;
    const g = new BoxGeometry(0.52, 0.52, 1.5);
    g.rotateZ(ang);
    g.translate(A.x - r * Math.cos(ang), floor + springing + r * Math.sin(ang), wallZ);
    s.add('masonry', g);
  }
  s.box('masonry', (A.half + A.feather * 0.7) * 2, 0.3, 1.7, A.x, floor + springing + bore + 0.5, wallZ);
  s.box('masonry', (A.half + A.feather * 0.7) * 2, 0.34, 1.8, A.x, wallTop + 0.17, wallZ);
  for (const side of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const t = k / 6;
      const h = 4.6 - t * 3.4;
      const zk = face - 1.6 - k * 2.6;
      s.box('masonry', 0.7, h, 2.7, A.x + side * (A.half + 0.2 + t * 1.1), floor + h / 2, zk, side * 0.1);
      s.solid(0.9, h, 2.7, A.x + side * (A.half + 0.2 + t * 1.1), floor + h / 2, zk);
    }
  }
}

/** The old tramway's stone bin, where the tubs tip: timber on posts. */
function oreBin(s: Site, x: number, z: number, yaw: number) {
  const gy = groundAt(x, z);
  for (const [dx, dz] of [[-1.6, -2.2], [1.6, -2.2], [1.6, 2.2], [-1.6, 2.2]]) {
    const px = x + dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const pz = z + dx * Math.sin(yaw) + dz * Math.cos(yaw);
    s.box('timber', 0.3, 3.2, 0.3, px, gy + 1.6, pz, yaw);
  }
  s.box('timber', 3.6, 2.2, 4.8, x, gy + 2.3, z, yaw);
  s.solid(3.6, 3.4, 4.8, x, gy + 1.7, z, yaw);
  s.box('rock', 3.2, 0.6, 4.2, x, gy + 3.5, z, yaw);
}

/**
 * The yard grid. Everything is square to it: the works road runs east–west
 * at `WORKS_Z` from the gate to the loop, the haul road north from it at
 * `HAUL_X` into the pit, and the buildings stand in blocks either side with
 * their walls on the road lines.
 */
const WORKS_Z = MINE.gate.z;
const HAUL_X = -370;
/** The screen house (the `mineWorks` model, 40 × 27 m, 21 m to the ridge), west of the haul road. */
const HOUSE = { x: -400, z: 30 };
/** The parking apron by the offices, and its bays. */
const APRON = { x: -346, z: -26, w: 26, d: 14 };

/**
 * The roads' own surface: asphalt on the works road and the haul road, laid
 * a few centimetres over the hard standing, and the apron. The terrain under
 * them is already level, so there is nothing to collide with; this is what a
 * driver sees, and what tells them where the roads are.
 */
function roads(s: Site) {
  const lay = (pts: Array<[number, number]>, width: number) => {
    const samples: LoftSample[] = [];
    let arc = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (i) arc += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      samples.push({ x, z, y: groundAt(x, z) + 0.04, nx: -dz / len, nz: dx / len, arc });
    }
    s.add('asphalt', buildLoft(samples, [{ off: -width / 2, rise: 0 }, { off: width / 2, rise: 0 }], { vScale: 6 }).geometry);
    // A worn centre and edge lines, painted.
    s.add('paint', buildLoft(samples, [{ off: -width / 2 + 0.3, rise: 0.005 }, { off: -width / 2 + 0.42, rise: 0.005 }]).geometry);
    s.add('paint', buildLoft(samples, [{ off: width / 2 - 0.42, rise: 0.005 }, { off: width / 2 - 0.3, rise: 0.005 }]).geometry);
  };
  // The works road, gate to the rail bin, with a turning head at its end.
  lay([[MINE.gate.x + 1, WORKS_Z], [-380, WORKS_Z], [-430, WORKS_Z], [-444, WORKS_Z]], 9);
  // The gateway's own apron, the piers' full width, out to where the access road arrives.
  lay([[MINE.gate.x + 14, WORKS_Z], [MINE.gate.x - 6, WORKS_Z]], GATE_HALF * 2 - 1);
  // The haul road, north from the works road across the yard into the pit.
  lay([[HAUL_X, WORKS_Z - 4.5], [HAUL_X, 40], [HAUL_X, 84], [-378, 100]], 9);
  // The workshop's spur east off the haul road.
  lay([[HAUL_X + 4.5, 40], [-346, 40]], 7);
  // The apron, with its bays marked.
  s.box('asphalt', APRON.w, 0.06, APRON.d, APRON.x, groundAt(APRON.x, APRON.z) + 0.03, APRON.z);
  for (let k = 0; k <= 8; k++) {
    s.box('paint', 0.1, 0.01, 5.5, APRON.x - APRON.w / 2 + 1 + k * 3, groundAt(APRON.x, APRON.z) + 0.07, APRON.z - APRON.d / 2 + 3.5);
  }
}

function buildSite(loop: Loop) {
  const s = new Site();
  roads(s);
  primary(s);
  stockpiles(s);
  gate(s);
  fence(s);
  lights(s);
  compound(s);
  lagoon(s);
  adit(s);

  /*
   * The conveyors — the chain from the crusher out. The primary's conveyor
   * rises from the crusher's discharge in the pit's mouth, clears the haul
   * road with room for a tipper under it, and enters the screen house's
   * north end at height. The plant's conveyors come off the house to the
   * three stockpiles south of it, to the rail bin on the west leg and to the
   * road silos on the works road.
   */
  // Primary → the screen house's north end, high, clear of the haul road.
  conveyor(s, [PRIMARY.x + 2, F + 2.6, PRIMARY.z - 4], [HOUSE.x + 8, T + 15.5, HOUSE.z + 13]);
  // Screen house → the three stockpiles south of the works road.
  for (const p of STOCKPILES) {
    const y = groundAt(p.x, p.z);
    conveyor(s, [HOUSE.x + (p.x - HOUSE.x) * 0.3, T + 13.5, HOUSE.z - 13.5], [p.x, y + p.h + 2.2, p.z]);
  }
  // Screen house → the rail load-out: the industrial set's load-bay shed
  // straddles the loop's straight (`PLACED`), and the conveyor comes in
  // through its east gable at eaves height.
  const bin = loop.poseAt(loop.arcAtZ(RAIL_SHED_Z));
  conveyor(s, [HOUSE.x - 20, T + 13, HOUSE.z], [bin.x + 7.4, bin.y + 7.6, bin.z - 4]);
  // Screen house → the road silos over the works road.
  conveyor(s, [HOUSE.x + 20, T + 12, HOUSE.z - 8], [-356, T + 14, WORKS_Z]);
  roadLoadout(s, -356, WORKS_Z);
  oreBin(s, -396, 116, 0);
  return s;
}

/* ----------------------------------------------------------- tramway */

/** The old two-foot line, from the adit out to the stone bin on the pit's west side. */
const TRAM_POINTS: ReadonlyArray<readonly [number, number]> = [
  [MINE.adit.x, MINE.adit.z + 18], [MINE.adit.x, MINE.adit.z - 3], [MINE.adit.x, 136], [-384, 126],
  [-391, 120], [-395.5, 118],
];
const GAUGE = 0.62;
const TRAM_GRADE = 0.045;
const RAIL_HEIGHT = 0.175;
const BALLAST_DEPTH = 0.3;

function tramSamples(): Array<LoftSample & { ground: number; tx: number; tz: number }> {
  const fine = resample(TRAM_POINTS, 14, 1.5);
  const floor = fine.map(([x, z]) => (z > MINE.adit.z - 1 ? F : groundAt(x, z) + 0.06));
  const y = [...floor];
  const step = (i: number) => Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]);
  for (let pass = 0; pass < 240; pass++) {
    let moved = 0;
    for (let i = 1; i < y.length; i++) { const lift = y[i - 1] - TRAM_GRADE * step(i); if (y[i] < lift) { y[i] = lift; moved++; } }
    for (let i = y.length - 2; i >= 0; i--) { const lift = y[i + 1] - TRAM_GRADE * step(i + 1); if (y[i] < lift) { y[i] = lift; moved++; } }
    if (!moved) break;
  }
  for (let pass = 0; pass < 8; pass++) {
    const copy = [...y];
    for (let i = 1; i < y.length - 1; i++) y[i] = Math.max(floor[i], (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4);
  }
  let arc = 0;
  return fine.map(([x, z], i) => {
    if (i > 0) arc += step(i);
    const a = fine[Math.max(0, i - 1)];
    const b = fine[Math.min(fine.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return { x, z, y: y[i], nx: -dz / len, nz: dx / len, tx: dx / len, tz: dz / len, arc, ground: floor[i] };
  });
}

/**
 * The two-foot line's own permanent way: a ballast shoulder, timber sleepers
 * bedded into it, bullhead rail — and the tubs standing on it with their
 * wheels on the rail head and their length ALONG the track. (They stood
 * across it before: the yaw had a quarter turn in it that belonged to the
 * sleepers' boxes and not to a model baked facing −Z.)
 */
function buildTramway() {
  const samples = tramSamples();
  const ballast = buildLoft(samples, [
    { off: -1.3, rise: -BALLAST_DEPTH }, { off: -0.85, rise: 0 }, { off: 0.85, rise: 0 }, { off: 1.3, rise: -BALLAST_DEPTH },
  ], { vScale: 3 });
  const rail = (c: number): ProfileVertex[] => [
    { off: c - 0.055, rise: 0.06 }, { off: c + 0.055, rise: 0.06 }, { off: c + 0.055, rise: 0.085 }, { off: c + 0.018, rise: 0.09 },
    { off: c + 0.018, rise: 0.132 }, { off: c + 0.038, rise: 0.14 }, { off: c + 0.038, rise: RAIL_HEIGHT }, { off: c - 0.038, rise: RAIL_HEIGHT },
    { off: c - 0.038, rise: 0.14 }, { off: c - 0.018, rise: 0.132 }, { off: c - 0.018, rise: 0.09 }, { off: c - 0.055, rise: 0.085 },
  ];
  const rails = [
    buildLoft(samples, rail(-GAUGE / 2), { closed: true, vScale: 2 }),
    buildLoft(samples, rail(GAUGE / 2), { closed: true, vScale: 2 }),
  ];
  const rnd = makeRandom(717);
  const sleepers: BufferGeometry[] = [];
  const total = samples[samples.length - 1].arc;
  for (let a = 0.4; a < total; a += 0.75) {
    const i = Math.min(samples.length - 1, Math.round((a / total) * (samples.length - 1)));
    const sm = samples[i];
    const g = new BoxGeometry(1.15, 0.13, 0.2);
    g.rotateZ((rnd() - 0.5) * 0.05);
    g.rotateY(across(sm.nx, sm.nz) + (rnd() - 0.5) * 0.06);
    g.translate(sm.x, sm.y + 0.015, sm.z);
    sleepers.push(g);
  }
  const sleeperGeometry = mergeGeometries(sleepers, false);
  for (const g of sleepers) g.dispose();
  const skips = [0.14, 0.2, 0.26, 0.32, 0.74].map((t) => {
    const i = Math.min(samples.length - 1, Math.round(t * (samples.length - 1)));
    const sm = samples[i];
    return { x: sm.x, y: sm.y + RAIL_HEIGHT, z: sm.z, turn: facing(sm.tx, sm.tz) };
  });
  return { rails, ballast, sleeperGeometry, skips, samples };
}

/* ------------------------------------------------------------- the kit */

const KIT = '/models/country.glb';
useGLTF.preload(KIT, DRACO_PATH);
useGLTF.preload(train08Data.model, DRACO_PATH);
useGLTF.preload(wagonHopperData.model, DRACO_PATH);

interface Placed {
  part: string;
  x: number;
  z: number;
  /** A level of a metre or more; anything less is a lift off whatever the ground is. */
  y: number;
  turn: number;
  pitch?: number;
  label: string;
  /** Stands on the goods loop: `x` and `turn` come from the track at `z`. */
  onLoop?: boolean;
}

/**
 * Everything from the kit, placed where the chain puts it — and off the
 * roads. The works road runs east–west at z = −4 from the gate and the haul
 * road north from it at x ≈ −370, and nothing stands on either.
 */
const PLACED: readonly Placed[] = [
  /* — the face: the shovel at the face, the excavator beside it, a truck under each — */
  // More diggers and cranes, at the user's word: a second excavator at the
  // stockpiles, a gantry crane and the mobile crane by the workshop.
  { part: 'mineRig', x: -414, z: -36, y: 0, turn: 0.4, label: 'excavator at the stockpiles' },
  { part: 'indGantry', x: -338, z: 40, y: T, turn: 0, label: 'the gantry crane' },
  /* — the plant, west of the haul road — */
  { part: 'mineWorks', x: HOUSE.x, z: HOUSE.z, y: T, turn: 0, label: 'the screen house' },
  { part: 'minePlant', x: -430, z: 68, y: T, turn: Math.PI / 2, label: 'the processing house' },
  { part: 'mineMachine', x: -358, z: 20, y: T, turn: 0, label: 'genset 1' },
  { part: 'mineMachine', x: -358, z: 28, y: T, turn: 0, label: 'genset 2' },
  /* — off the roads: a tipper waiting at the stockpiles, the barriers standing open beside the gate — */
  { part: 'mineDumper', x: -394, z: -12, y: 0, turn: -Math.PI / 2, label: 'tipper at the stockpiles' },
  { part: 'siteBarrier', x: MINE.gate.x - 4, z: WORKS_Z + 8.6, y: 0, turn: Math.PI / 2, label: 'barrier in, open' },
  { part: 'siteBarrier', x: MINE.gate.x - 4, z: WORKS_Z - 8.6, y: 0, turn: Math.PI / 2, label: 'barrier out, open' },
  /* — the apron: nose-in to the bays, in a row — */
  { part: 'pickup', x: APRON.x - 9, z: APRON.z - 3, y: 0, turn: 0, label: 'manager\'s pickup' },
  { part: 'pickup', x: APRON.x - 6, z: APRON.z - 3, y: 0, turn: 0, label: 'fitter\'s pickup' },
  { part: 'siteLorry', x: APRON.x + 3, z: APRON.z - 2, y: 0, turn: 0, label: 'stores lorry' },
  /* — the workshop, east of the haul road, square to its spur — */
  { part: 'siteShed', x: -350, z: 60, y: 0, turn: 0, label: 'the workshop' },
  { part: 'siteCrane', x: -330, z: 20, y: 0, turn: Math.PI / 2, label: 'the mobile crane' },
  { part: 'siteSkip', x: -366, z: 49, y: 0, turn: 0, label: 'skip 1' },
  { part: 'siteSkip', x: -364, z: 49, y: 0, turn: 0, label: 'skip 2' },
  { part: 'siteCrate', x: -358, z: 49, y: 0, turn: 0, label: 'crate 1' },
  { part: 'siteCrate', x: -357, z: 49, y: 0, turn: 0, label: 'crate 2' },
  { part: 'siteCrate', x: -357.5, z: 49, y: 0.5, turn: 0, label: 'crate 3' },
  { part: 'siteSkip', x: -388, z: 104, y: 0, turn: 0, label: 'skip at the crusher' },
  /* — the industrial set — */
  // The rail load-bay shed, straddling the loop's straight: `x` and `turn` are
  // filled in from the loop at mount (`onLoop`), so it sits on the track.
  { part: 'indShedRail', x: 0, z: RAIL_SHED_Z, y: 0, turn: 0, label: 'the rail load-out shed', onLoop: true },
  { part: 'indSilo', x: -424, z: 4, y: T, turn: 0, label: 'fines silo 1' },
  { part: 'indSilo2', x: -430, z: 4, y: T, turn: 0, label: 'fines silo 2' },
  { part: 'indSilo', x: -436, z: 4, y: T, turn: 0, label: 'fines silo 3' },
  { part: 'indTank', x: -438, z: -36, y: T, turn: 0, label: 'the water tank' },
  { part: 'indOffice', x: -346, z: -14, y: T, turn: 0, label: 'the site office' },
  { part: 'indTransformer', x: -356, z: 8, y: T, turn: 0, label: 'the transformer station' },
  // The dock crane, standing between the loop and the processing house with
  // its jib out over the wagons — beside the track, never on it.
  { part: 'dockCrane', x: -436, z: -10, y: 0, turn: 0, label: 'the loading crane' },
];

/* ------------------------------------------------------------ the train */

/**
 * The rake on the loop: a Class 08 and four HAA hoppers, standing under the
 * bin being loaded. Set out from the north end of the straight back toward
 * the south switch, each unit half its own length on from the last with a
 * hand's width of coupling between; the shunter at the north end faces up
 * the line, the way it will leave.
 */
const COUPLING = 0.35;

function rakeOn(loop: Loop) {
  const units: Array<{ model: 'loco' | 'hopper'; size: number[]; x: number; y: number; z: number; yaw: number }> = [];
  // From just short of the shed's south gable back down the straight.
  let arc = loop.arcAtZ(RAIL_SHED_Z - 14 - 3);
  const stand = (model: 'loco' | 'hopper', size: number[]) => {
    arc -= size[2] / 2;
    const p = loop.poseAt(arc);
    units.push({ model, size, x: p.x, y: p.y, z: p.z, yaw: facing(p.tx, p.tz) });
    arc -= size[2] / 2 + COUPLING;
  };
  stand('loco', train08Data.size);
  for (let i = 0; i < 4; i++) stand('hopper', wagonHopperData.size);
  return units;
}

/* ------------------------------------------------------------- movers */

/**
 * The machines that work: a tipper on a circuit down the haul road and back,
 * the hauler shuttling between the face and the primary (forward loaded,
 * reversing back, the way a truck does at a face it cannot turn at), the
 * dozer pushing back and forth on the tip, and the excavator slewing at the
 * face.
 *
 * Each is one `Mover`: a path as a polyline, a mode, a speed. `loop` runs
 * round and round; `shuttle` runs the path out and back, the model always
 * facing the path's forward direction so the return leg is a reverse; `slew`
 * stands still and swings about its base yaw. Visuals move in the frame
 * loop and the kinematic collider in the physics step — the rule everything
 * that touches Rapier in this project follows — and every machine is pitched
 * to the ground under a chord its own length, so the dozer noses down the
 * tip rather than standing level on it.
 */
interface MoveSpec {
  part: string;
  path: ReadonlyArray<readonly [number, number]>;
  mode: 'loop' | 'shuttle' | 'slew';
  /** Metres a second, or radians a second for a slew. */
  speed: number;
  /** Where it starts, as a fraction of the cycle. */
  phase?: number;
  /** For a slew: the base yaw and the swing either side. */
  yaw?: number;
  swing?: number;
  /** Added to the travel yaw: for a model baked facing +Z rather than −Z. */
  face?: number;
  label: string;
}

const MOVERS: readonly MoveSpec[] = [
  // The tipper's circuit: down the haul road to the works road and back up.
  { part: 'mineDumper', mode: 'loop', speed: 5.5, phase: 0.1, face: Math.PI, label: 'tipper on the haul road',
    path: [[-368, 86], [-368, 40], [-368, 12], [-372, 2], [-378, 6], [-380, 16], [-378, 40], [-375, 70], [-372, 86], [-364, 90]] },
  // The hauler, from under the shovel to the primary's ramp foot and back, reversing.
  { part: 'mineHauler', mode: 'shuttle', speed: 3.6, phase: 0.3, label: 'the haul truck',
    path: [[-370, 136], [-370, 116], [-370, 98]] },
  { part: 'mineRig', mode: 'slew', speed: 0.28, yaw: 0.6, swing: 0.5, label: 'the second excavator', path: [[-404, 142]] },
  // The dozer, pushing on the tip.
  { part: 'mineDozer', mode: 'shuttle', speed: 1.4, phase: 0.6, label: 'the dozer',
    path: [[-446, 92], [-436, 102]] },
  // The excavator, slewing at the face.
  { part: 'mineRig', mode: 'slew', speed: 0.35, yaw: -2.4, swing: 0.55, label: 'the excavator', path: [[-358, 134]] },
];

/** A polyline as samples with arc and forward tangent. */
function pathSamples(path: ReadonlyArray<readonly [number, number]>) {
  const out: Array<{ x: number; z: number; arc: number; tx: number; tz: number }> = [];
  let arc = 0;
  for (let i = 0; i < path.length; i++) {
    const [x, z] = path[i];
    if (i) arc += Math.hypot(x - path[i - 1][0], z - path[i - 1][1]);
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    out.push({ x, z, arc, tx: dx / len, tz: dz / len });
  }
  return out;
}

function Mover({ spec, object, size }: { spec: MoveSpec; object: Object3D; size: [number, number, number] }) {
  const samples = useMemo(() => pathSamples(spec.path), [spec]);
  const total = samples[samples.length - 1].arc;
  const carrier = useRef<Group>(null);
  const body = useRef<RapierRigidBody | null>(null);
  const t = useRef((spec.phase ?? 0) * (spec.mode === 'loop' ? total : spec.mode === 'shuttle' ? total * 2 : Math.PI * 2));
  const scratch = useMemo(() => ({ q: new Quaternion(), e: new Euler(0, 0, 0, 'YXZ') }), []);

  /** Where along the path, for the cycle position `v`. */
  const arcAt = (v: number) => {
    if (spec.mode === 'loop') return ((v % total) + total) % total;
    const u = ((v % (total * 2)) + total * 2) % (total * 2);
    return u <= total ? u : total * 2 - u;
  };
  const along = (arc: number) => {
    let i = 0;
    while (i < samples.length - 2 && samples[i + 1].arc < arc) i++;
    const a = samples[i];
    const b = samples[i + 1] ?? a;
    const f = b.arc > a.arc ? (arc - a.arc) / (b.arc - a.arc) : 0;
    return { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), tx: lerp(a.tx, b.tx, f), tz: lerp(a.tz, b.tz, f) };
  };
  const pose = () => {
    if (spec.mode === 'slew') {
      const [x, z] = spec.path[0];
      return { x, z, y: groundAt(x, z), yaw: (spec.yaw ?? 0) + (spec.swing ?? 0) * Math.sin(t.current), pitch: 0 };
    }
    const arc = arcAt(t.current);
    const at = along(arc);
    const half = size[2] / 2;
    const front = along(Math.min(total, arc + half));
    const back = along(Math.max(0, arc - half));
    const gf = groundAt(front.x, front.z);
    const gb = groundAt(back.x, back.z);
    return { x: at.x, z: at.z, y: (gf + gb) / 2, yaw: facing(at.tx, at.tz) + (spec.face ?? 0), pitch: Math.atan2(gf - gb, size[2]) };
  };

  useBeforePhysicsStep(() => {
    const p = pose();
    scratch.e.set(p.pitch, p.yaw, 0);
    scratch.q.setFromEuler(scratch.e);
    body.current?.setNextKinematicTranslation({ x: p.x, y: p.y + size[1] / 2, z: p.z });
    body.current?.setNextKinematicRotation(scratch.q);
  });
  useFrame((_, dt) => {
    t.current += spec.speed * Math.min(dt, 0.1);
    const g = carrier.current;
    if (!g) return;
    const p = pose();
    g.position.set(p.x, p.y, p.z);
    scratch.e.set(p.pitch, p.yaw, 0);
    g.quaternion.setFromEuler(scratch.e);
  });

  return (
    <>
      <group ref={carrier}><primitive object={object} /></group>
      <RigidBody ref={body} type="kinematicPosition" colliders={false} position={[0, -500, 0]}>
        <CuboidCollider args={[size[0] / 2, size[1] / 2, size[2] / 2]} />
      </RigidBody>
    </>
  );
}

/* ----------------------------------------------------------- component */

const sizeOf = (part: string): [number, number, number] => {
  const s = (countryModels.parts as Record<string, { size: number[] }>)[part]?.size ?? [4, 4, 4];
  return [s[0], s[1], s[2]];
};

const cloneShadowed = (node: Object3D) => {
  const object = node.clone(true);
  object.traverse((child) => {
    if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
  });
  return object;
};

const quaternionFor = (yaw: number, pitch = 0) => new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'));

export function CountryMine() {
  const loop = useMemo(() => buildLoopLine(), []);
  const site = useMemo(() => buildSite(loop), [loop]);
  const merged = useMemo(() => site.merged(), [site]);
  const tram = useMemo(() => buildTramway(), []);
  const { scene: kit } = useGLTF(KIT, DRACO_PATH);
  const { scene: shunter } = useGLTF(train08Data.model, DRACO_PATH);
  const { scene: hopper } = useGLTF(wagonHopperData.model, DRACO_PATH);
  /** The main line's own stone, so the loop's bed is the line's bed. */
  const ballastMaterial = useMemo(() => new MeshStandardMaterial({ map: makeBallastTexture(), roughness: 0.95, side: DoubleSide }), []);

  const placed = useMemo(() => {
    const out: Array<Placed & { object: Object3D; size: [number, number, number]; q: Quaternion }> = [];
    for (const spec of PLACED) {
      const node = kit.getObjectByName(spec.part);
      if (!node) continue;
      let p = spec;
      if (spec.onLoop) {
        const at = loop.poseAt(loop.arcAtZ(spec.z));
        p = { ...spec, x: at.x, z: at.z, turn: Math.atan2(at.tx, at.tz) };
      }
      const y = p.y >= 1 ? p.y : groundAt(p.x, p.z) + p.y;
      out.push({ ...p, y, object: cloneShadowed(node), size: sizeOf(p.part), q: quaternionFor(p.turn, p.pitch ?? 0) });
    }
    return out;
  }, [kit, loop]);

  const cars = useMemo(() => {
    const node = kit.getObjectByName('mineCar');
    if (!node) return [];
    return tram.skips.map((s) => ({ ...s, object: cloneShadowed(node) }));
  }, [kit, tram]);

  const movers = useMemo(() => MOVERS.map((spec) => {
    const node = kit.getObjectByName(spec.part);
    return node ? { spec, object: cloneShadowed(node), size: sizeOf(spec.part) } : null;
  }).filter((m): m is NonNullable<typeof m> => m !== null), [kit]);

  const rake = useMemo(() => rakeOn(loop).map((u) => ({
    ...u, object: cloneShadowed(u.model === 'loco' ? shunter : hopper),
  })), [loop, shunter, hopper]);

  useEffect(() => {
    console.info(`[country] ${MINE.label}: ${MINE.pit.rim * 2} m horseshoe, ${MINE.pit.benches} benches of `
      + `${MINE.pit.benchHeight} m, ${Math.round(loop.total)} m goods loop with ${rake.length} vehicles standing on it, `
      + `${STOCKPILES.length} stockpiles, ${Math.round(tram.samples[tram.samples.length - 1].arc)} m of tramway, `
      + `${PLACED.length} placed models, ${MOVERS.length} working`);
    return () => {
      for (const m of merged) m.geometry.dispose();
      for (const r of tram.rails) r.geometry.dispose();
      tram.ballast.geometry.dispose();
      tram.sleeperGeometry?.dispose();
      for (const r of loop.rails) r.geometry.dispose();
      loop.ballast.geometry.dispose();
    };
  }, [merged, tram, loop, rake.length]);

  return (
    <group>
      {merged.map(({ mat, geometry }) => (
        <mesh key={mat} geometry={geometry} material={MATERIALS[mat]} castShadow={mat !== 'mesh' && mat !== 'water'} receiveShadow />
      ))}

      {/* The goods loop: the main line's ballast, sleepers and rail, and the rake on it. */}
      <mesh geometry={loop.ballast.geometry} material={ballastMaterial} receiveShadow />
      <InstancedField matrices={loop.sleepers} geometry={SLEEPER_GEOMETRY} material={SLEEPER_MATERIAL} />
      {loop.rails.map((r, i) => (
        <mesh key={`lrail${i}`} geometry={r.geometry} material={RAIL_STEEL} castShadow receiveShadow />
      ))}
      {rake.map((u, i) => (
        <primitive key={`rake${i}`} object={u.object} position={[u.x, u.y, u.z]} rotation={[0, u.yaw, 0]} />
      ))}

      {/* The old tramway. */}
      <mesh geometry={tram.ballast.geometry} material={MATERIALS.ballast} receiveShadow />
      {tram.sleeperGeometry && <mesh geometry={tram.sleeperGeometry} material={MATERIALS.timber} castShadow receiveShadow />}
      {tram.rails.map((r, i) => (
        <mesh key={`trail${i}`} geometry={r.geometry} material={MATERIALS.railhead} castShadow receiveShadow />
      ))}
      {cars.map((c, i) => (
        <primitive key={`car${i}`} object={c.object} position={[c.x, c.y, c.z]} rotation={[0, c.turn, 0]} />
      ))}

      {placed.map((p) => (
        <primitive key={p.label} object={p.object} position={[p.x, p.y, p.z]} quaternion={p.q} />
      ))}
      {movers.map((m) => <Mover key={m.spec.label} spec={m.spec} object={m.object} size={m.size} />)}

      <RigidBody type="fixed" colliders={false}>
        {placed.filter((p) => !p.onLoop).map((p) => (
          <CuboidCollider
            key={p.label}
            args={[p.size[0] / 2, p.size[1] / 2, p.size[2] / 2]}
            position={[p.x, p.y + p.size[1] / 2, p.z]}
            quaternion={p.q}
          />
        ))}
        {rake.map((u, i) => (
          <CuboidCollider
            key={`rakebox${i}`}
            args={[u.size[0] / 2, u.size[1] / 2, u.size[2] / 2]}
            position={[u.x, u.y + u.size[1] / 2, u.z]}
            rotation={[0, u.yaw, 0]}
          />
        ))}
        {site.solids.map((b, i) => (
          <CuboidCollider key={i} args={[b.w / 2, b.h / 2, b.d / 2]} position={[b.x, b.y, b.z]} rotation={[0, b.turn, 0]} />
        ))}
      </RigidBody>
    </group>
  );
}
