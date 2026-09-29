'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, Vector3, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  CASTLE_HILL, CHAPEL, CHURCH, COTTAGES, HARBOUR, HOME_FARM, LAKE, ORCHARD, STREAM, VINEYARD, WOOD,
  coastClearance, coastRadius, groundAt, inIsland, lakeFraction, lakeRadius, makeRandom, railEdgeAt,
  reliefAt, roadByName, roadEdgeAt, streamDistanceAt,
} from '@/config/countryConfig';
import {
  FIELDS, GATES, HEDGES, HEDGE_PITCH, PADDOCK_FENCE, POULTRY_FENCE, ROADSIDE, VERGE, inBeach, inBuiltZone, inFort,
  inHamlet, inWood, nearTrack, onWorkLoop, pointInPolygon, WORK_LOOPS, type HedgeRun, type Pt,
} from '@/config/countryFields';
import { InstancedField } from './instancedField';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * What grows on Skylark, and what is put up between the fields.
 *
 * ## Trees
 *
 * The city's own trees, the four the park kit already takes out of the map
 * (`prepare-park.mjs`): nothing new is downloaded for this island, which was
 * the brief. Six hundred-odd of them, placed by rule rather than by hand —
 * Hanger Wood on Beacon Hill, copses in the corners of pastures, a tree every
 * forty metres or so along the hedges (which is how a hedgerow tree happens:
 * a sapling the hedger left), willows round the lake, an orchard in rows at
 * Home Farm, an avenue up Church Lane, yews in the churchyard, and a lone oak
 * in the middle of a few fields for the cattle to stand under.
 *
 * Drawn through `InstancedField`, forty to a chunk, so the frustum can throw
 * away the far side of the island: a thousand trees in one instanced mesh is
 * a thousand trees drawn every frame from everywhere.
 *
 * ## Hedges and walls
 *
 * Boxes swept along the runs `countryFields` hands over — a hedge 1.5 m wide
 * and a bumpy metre and a half high, a wall 0.7 m wide and 1.15 high — every
 * sample at the ground, so a hedge climbs a hill with it. Merged into one
 * geometry each, and each run is a collider: a hedge is a wall whatever it
 * is made of, as the park's note says.
 *
 * ## The rest
 *
 * Five-bar gates in the gaps the hedges leave; round bales in the stubble;
 * telegraph poles down the lanes with their wires slung between them; the
 * paddock's post-and-rail.
 */

const PARK_MODEL = '/models/park.glb';
useGLTF.preload(PARK_MODEL, DRACO_PATH);

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

type TreePart = 'treeSlim' | 'treeBroad' | 'treeTall' | 'treeBig' | 'bush' | 'bushLow';
const PARTS: readonly TreePart[] = ['treeSlim', 'treeBroad', 'treeTall', 'treeBig', 'bush', 'bushLow'];

interface Placement {
  part: TreePart;
  x: number;
  z: number;
  turn: number;
  scale: number;
}

/* ---------------------------------------------------------- planting */

function plant(): Placement[] {
  const rnd = makeRandom(23);
  const out: Placement[] = [];
  const taken: Pt[] = [];
  const spacing = new Map<string, Pt[]>();
  const cell = (x: number, z: number) => `${Math.floor(x / 12)},${Math.floor(z / 12)}`;
  const crowded = (x: number, z: number, min: number) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = spacing.get(`${Math.floor(x / 12) + dx},${Math.floor(z / 12) + dz}`);
        if (!list) continue;
        for (const [px, pz] of list) if (Math.hypot(px - x, pz - z) < min) return true;
      }
    }
    return false;
  };
  const put = (part: TreePart, x: number, z: number, scale = 1, min = 4) => {
    if (crowded(x, z, min)) return false;
    out.push({ part, x, z, turn: rnd() * TAU, scale });
    taken.push([x, z]);
    const k = cell(x, z);
    if (!spacing.has(k)) spacing.set(k, []);
    spacing.get(k)!.push([x, z]);
    return true;
  };
  /** Open ground a tree may stand on, `edge` metres off any road's carriageway. */
  const clear = (x: number, z: number, edge = 4.5) => (
    inIsland(x, z, 14)
    && roadEdgeAt(x, z) > edge
    && !inBuiltZone(x, z, 4)
    && lakeFraction(x, z) > 1.06
    && !nearTrack(x, z, 3)
    && !inFort(x, z, 6)
    && !inBeach(x, z, 4)
    && streamDistanceAt(x, z) > 4
    && railEdgeAt(x, z) > 3
  );
  const pick = (table: Array<[TreePart, number]>): TreePart => {
    const u = rnd();
    let acc = 0;
    for (const [p, w] of table) { acc += w; if (u <= acc) return p; }
    return table[table.length - 1][0];
  };

  // Hanger Wood: dense, and the big trees are in it.
  const woodMix: Array<[TreePart, number]> = [['treeBig', 0.32], ['treeTall', 0.4], ['treeBroad', 0.28]];
  for (let i = 0; i < 5200 && out.length < 620; i++) {
    const t = rnd() * TAU;
    const r = Math.sqrt(rnd());
    const c = Math.cos(WOOD.rot);
    const s = Math.sin(WOOD.rot);
    const u = WOOD.rx * r * Math.cos(t) * 0.98;
    const v = WOOD.rz * r * Math.sin(t) * 0.98;
    const x = WOOD.x + u * c - v * s;
    const z = WOOD.z + u * s + v * c;
    if (!clear(x, z, 3.5)) continue;
    put(pick(woodMix), x, z, 0.85 + rnd() * 0.4, 6.2);
  }
  const woodCount = out.length;

  // Copses: a knot of trees in a pasture corner, four of them.
  const corners: Pt[] = [];
  for (const f of FIELDS) {
    if (f.crop !== 'pasture' && f.crop !== 'meadow' && f.crop !== 'rough') continue;
    for (const p of f.polygon) {
      if (!clear(p[0], p[1], 30) || coastClearance(p[0], p[1]) < 45) continue;
      if (inHamlet(p[0], p[1], 20) || reliefAt(p[0], p[1]) > 24) continue;
      if (corners.some(([cx, cz]) => Math.hypot(cx - p[0], cz - p[1]) < 110)) continue;
      corners.push(p);
      if (corners.length === 8) break;
    }
    if (corners.length === 8) break;
  }
  for (const [cx, cz] of corners) {
    for (let i = 0; i < 60; i++) {
      const t = rnd() * TAU;
      const r = 4 + rnd() * 24;
      const x = cx + r * Math.cos(t);
      const z = cz + r * Math.sin(t);
      if (!clear(x, z, 5)) continue;
      put(pick([['treeBroad', 0.4], ['treeTall', 0.35], ['treeBig', 0.25]]), x, z, 0.8 + rnd() * 0.4, 6);
    }
  }

  // Hedgerow trees, every forty-odd metres along the hedges, never the walls.
  for (const run of HEDGES) {
    if (run.kind !== 'hedge') continue;
    let next = 18 + rnd() * 30;
    for (let i = 1; i < run.pts.length; i++) {
      const s = i * HEDGE_PITCH;
      if (s < next) continue;
      next = s + 20 + rnd() * 16;
      const [x, z] = run.pts[i];
      const [px, pz] = run.pts[i - 1];
      const len = Math.hypot(x - px, z - pz) || 1;
      const side = rnd() < 0.5 ? 1 : -1;
      const tx = x + (-(z - pz) / len) * 1.4 * side;
      const tz = z + ((x - px) / len) * 1.4 * side;
      if (!clear(tx, tz, 5.5)) continue;
      put(pick([['treeBroad', 0.45], ['treeSlim', 0.3], ['treeTall', 0.25]]), tx, tz, 0.85 + rnd() * 0.35, 8);
    }
  }

  // Willows round the lake.
  for (let i = 0; i < 18; i++) {
    const t = (i / 18) * TAU + rnd() * 0.25;
    const r = lakeRadius(t) * (1.16 + rnd() * 0.16);
    const x = LAKE.x + r * Math.cos(t);
    const z = LAKE.z + r * Math.sin(t);
    if (!clear(x, z, 5.5) || inBuiltZone(x, z, 6)) continue;
    put('treeBroad', x, z, 0.95 + rnd() * 0.3, 8);
  }

  // Alders and willows down the brook, on both banks, clear of the mill and
  // the crossings; and a few round the harbour and the chapel.
  for (let i = 4; i < STREAM.length - 6; i += 8) {
    const sm = STREAM[i];
    for (const side of [1, -1] as const) {
      if (rnd() < 0.35) continue;
      const off = 5 + rnd() * 5;
      const x = sm.x + sm.nx * off * side;
      const z = sm.z + sm.nz * off * side;
      if (!inIsland(x, z, 14) || roadEdgeAt(x, z) < 4 || inBuiltZone(x, z, 5) || railEdgeAt(x, z) < 3) continue;
      put(rnd() < 0.6 ? 'treeBroad' : 'treeSlim', x, z, 0.75 + rnd() * 0.35, 6);
    }
  }
  for (const [px, pz] of [[HARBOUR.x, HARBOUR.z], [CHAPEL.x, CHAPEL.z]] as const) {
    for (let i = 0; i < 10; i++) {
      const t = rnd() * TAU;
      const r = (px === HARBOUR.x ? HARBOUR.r + 6 : 20) + rnd() * 22;
      const x = px + r * Math.cos(t);
      const z = pz + r * Math.sin(t);
      if (!clear(x, z, 5)) continue;
      put(pick([['treeBroad', 0.5], ['treeSlim', 0.5]]), x, z, 0.8 + rnd() * 0.3, 7);
    }
  }

  // The orchard, in rows.
  {
    const c = Math.cos(ORCHARD.turn);
    const s = Math.sin(ORCHARD.turn);
    for (let u = -ORCHARD.w / 2 + 3.5; u < ORCHARD.w / 2; u += 7) {
      for (let v = -ORCHARD.d / 2 + 3.5; v < ORCHARD.d / 2; v += 7) {
        const x = ORCHARD.x + u * c + v * s;
        const z = ORCHARD.z - u * s + v * c;
        if (!clear(x, z, 2.5)) continue;
        put('treeSlim', x, z, 0.75 + rnd() * 0.15, 3);
      }
    }
  }

  // A lone oak in the middle of a few pastures.
  let oaks = 0;
  for (const f of FIELDS) {
    if (oaks >= 6 || f.crop !== 'pasture') continue;
    const [x, z] = f.centroid;
    if (!clear(x, z, 18) || inHamlet(x, z, 10)) continue;
    if (put('treeBig', x, z, 1.1 + rnd() * 0.2, 10)) oaks++;
  }

  // The avenue up Church Lane, and the yews in the churchyard.
  {
    const lane = roadByName('churchLane');
    for (let s = 24; s < 100; s += 18) {
      for (const side of [1, -1] as const) {
        const i = Math.min(lane.samples.length - 1, Math.round(s / 3));
        const sm = lane.samples[i];
        const x = sm.x + sm.nx * (VERGE + 2.4) * side;
        const z = sm.z + sm.nz * (VERGE + 2.4) * side;
        if (Math.hypot(x - CHURCH.x, z - CHURCH.z) < CHURCH.yard + 3) continue;
        if (roadEdgeAt(x, z) < 2.5 || inBuiltZone(x, z, 2)) continue;
        put('treeSlim', x, z, 1.05 + rnd() * 0.15, 5);
      }
    }
    for (const [u, v] of [[-14, 12], [13, 14], [-15, -9], [16, -8]] as const) {
      const c = Math.cos(CHURCH.turn);
      const s = Math.sin(CHURCH.turn);
      put('treeSlim', CHURCH.x + u * c + v * s, CHURCH.z - u * s + v * c, 0.9, 3);
    }
  }

  // A shelter belt north of Home Farm, and a tree or two behind each house.
  {
    const c = Math.cos(HOME_FARM.turn);
    const s = Math.sin(HOME_FARM.turn);
    for (let u = -30; u <= 30; u += 6) {
      const v = -(HOME_FARM.r + 7);
      const x = HOME_FARM.x + u * c + v * s;
      const z = HOME_FARM.z - u * s + v * c;
      if (!inIsland(x, z, 14) || roadEdgeAt(x, z) < 2.5 || railEdgeAt(x, z) < 3) continue;
      put('treeTall', x, z, 0.95 + rnd() * 0.2, 4);
    }
    for (const home of COTTAGES) {
      if (rnd() < 0.35) continue;
      const bx = home.x - Math.sin(home.turn) * (home.d / 2 + 9) + (rnd() - 0.5) * 6;
      const bz = home.z - Math.cos(home.turn) * (home.d / 2 + 9) + (rnd() - 0.5) * 4;
      if (roadEdgeAt(bx, bz) < 3.5 || inBuiltZone(bx, bz, 2) || railEdgeAt(bx, bz) < 3) continue;
      put(rnd() < 0.5 ? 'treeBroad' : 'treeSlim', bx, bz, 0.8 + rnd() * 0.3, 5);
    }
  }

  // Odd trees along the ring road's verges, off the downs.
  for (const name of ['ringEast', 'ringSouth', 'ringWest']) {
    const ring = roadByName(name);
    for (let i = 0; i < 16; i++) {
      const s = rnd() * ring.length;
      const sm = ring.samples[Math.min(ring.samples.length - 1, Math.round(s / 3))];
      if (reliefAt(sm.x, sm.z) > 22) continue;
      const side = rnd() < 0.5 ? 1 : -1;
      const x = sm.x + sm.nx * (VERGE + 3.2) * side;
      const z = sm.z + sm.nz * (VERGE + 3.2) * side;
      if (!clear(x, z, 5)) continue;
      put(pick([['treeBroad', 0.5], ['treeTall', 0.5]]), x, z, 0.9 + rnd() * 0.3, 8);
    }
  }

  // Scrub: gorse and thorn along the cliff tops, reeds' worth of bushes at
  // the lake's marsh, and a bush at the end of a hedge here and there.
  for (let i = 0; i < 160; i++) {
    const t = rnd() * TAU;
    const r = coastRadius(t) * (0.935 + rnd() * 0.045);
    const x = r * Math.cos(t);
    const z = r * Math.sin(t);
    if (!clear(x, z, 3.5)) continue;
    put(rnd() < 0.6 ? 'bushLow' : 'bush', x, z, 0.7 + rnd() * 0.6, 3);
  }
  // Gorse on Castle Hill's flanks, below the ramparts.
  for (let i = 0; i < 70; i++) {
    const t = rnd() * TAU;
    const r = 106 + rnd() * 50;
    const x = CASTLE_HILL.x + r * Math.cos(t);
    const z = CASTLE_HILL.z + r * Math.sin(t);
    if (!clear(x, z, 3.5)) continue;
    put('bushLow', x, z, 0.8 + rnd() * 0.6, 3);
  }
  for (let i = 0; i < 40; i++) {
    const t = rnd() * TAU;
    const r = lakeRadius(t) * (1.07 + rnd() * 0.08);
    const x = LAKE.x + r * Math.cos(t);
    const z = LAKE.z + r * Math.sin(t);
    if (roadEdgeAt(x, z) < 3.5 || inBuiltZone(x, z, 4)) continue;
    put('bush', x, z, 0.6 + rnd() * 0.5, 2.5);
  }
  for (const run of HEDGES) {
    if (run.kind !== 'hedge' || rnd() < 0.5) continue;
    const [x, z] = run.pts[rnd() < 0.5 ? 0 : run.pts.length - 1];
    if (!clear(x, z, 4.5)) continue;
    put('bush', x, z, 0.8 + rnd() * 0.4, 2.5);
  }

  void woodCount;
  return out;
}

/* ------------------------------------------------------------- hedges */

/** Sweep a section along every run of one kind and merge the lot. */
function buildRuns(
  runs: readonly HedgeRun[], kind: 'hedge' | 'wall', width: number,
  height: (arc: number, i: number) => number, sink: number,
): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  let seed = 0;
  for (const run of runs) {
    if (run.kind !== kind || run.pts.length < 2) continue;
    seed++;
    const samples: Array<LoftSample & { h: number }> = [];
    let arc = 0;
    for (let i = 0; i < run.pts.length; i++) {
      const [x, z] = run.pts[i];
      const [ax, az] = run.pts[Math.max(0, i - 1)];
      const [bx, bz] = run.pts[Math.min(run.pts.length - 1, i + 1)];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      if (i > 0) arc += Math.hypot(x - run.pts[i - 1][0], z - run.pts[i - 1][1]);
      // A hedge is not straight: wander a little across its own line.
      const wobble = kind === 'hedge' ? Math.sin(arc * 0.6 + seed) * 0.22 : 0;
      const px = x + (-dz / len) * wobble;
      const pz = z + (dx / len) * wobble;
      samples.push({
        x: px, z: pz, y: groundAt(px, pz) - sink, nx: -dz / len, nz: dx / len, arc, h: height(arc, seed),
      });
    }
    const w = width / 2;
    // A hedge is a rounded mass, not a box: the section bellies out at
    // waist height and rounds over the top. A wall stays a wall.
    const profile: ProfileVertex<LoftSample & { h: number }>[] = kind === 'hedge' ? [
      { off: -w * 0.8, rise: 0 }, { off: w * 0.8, rise: 0 },
      { off: w * 1.05, rise: (s) => s.h * 0.45 },
      { off: w * 0.8, rise: (s) => s.h * 0.88 }, { off: w * 0.35, rise: (s) => s.h },
      { off: -w * 0.35, rise: (s) => s.h }, { off: -w * 0.8, rise: (s) => s.h * 0.88 },
      { off: -w * 1.05, rise: (s) => s.h * 0.45 },
    ] : [
      { off: -w, rise: 0 }, { off: w, rise: 0 },
      { off: w * 0.85, rise: (s) => s.h }, { off: -w * 0.85, rise: (s) => s.h },
    ];
    const loft = buildLoft(samples, profile, { closed: true, vScale: kind === 'hedge' ? 3 : 4 });
    parts.push(loft.geometry);
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** One box collider per straight-ish stretch of a run. */
function runColliders(runs: readonly HedgeRun[], height: number, width: number) {
  const out: Array<{ x: number; y: number; z: number; turn: number; length: number }> = [];
  for (const run of runs) {
    for (let i = 0; i < run.pts.length - 1; i += 4) {
      const j = Math.min(run.pts.length - 1, i + 4);
      const [ax, az] = run.pts[i];
      const [bx, bz] = run.pts[j];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 1) continue;
      const x = (ax + bx) / 2;
      const z = (az + bz) / 2;
      out.push({ x, z, y: groundAt(x, z) + height / 2 - 0.2, turn: Math.atan2(-(bz - az), bx - ax), length });
    }
  }
  void width;
  return out;
}

/* ------------------------------------------------------- furniture */

function gateGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) => {
    const g = new BoxGeometry(w, h, d);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };
  box(0.2, 1.5, 0.2, -1.95, 0.75, 0);
  box(0.16, 1.4, 0.16, 1.95, 0.7, 0);
  for (let i = 0; i < 5; i++) box(3.7, 0.08, 0.05, 0, 0.28 + i * 0.27, 0);
  box(0.09, 1.2, 0.05, -1.7, 0.7, 0.03);
  box(0.09, 1.2, 0.05, 1.7, 0.7, 0.03);
  box(3.6, 0.07, 0.04, 0, 0.7, 0.05, 0.31);
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function baleGeometry(): BufferGeometry {
  const g = new CylinderGeometry(0.78, 0.78, 1.25, 14);
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.78, 0);
  return g;
}

function poleGeometry(): BufferGeometry {
  const pole = new CylinderGeometry(0.11, 0.15, 8.4, 8);
  pole.translate(0, 4.2, 0);
  const arm = new BoxGeometry(1.5, 0.11, 0.11);
  arm.translate(0, 8.05, 0);
  const g = mergeGeometries([pole, arm], false);
  pole.dispose();
  arm.dispose();
  return g;
}

interface Pole { x: number; z: number; y: number; turn: number }

function poles(): Pole[] {
  const out: Pole[] = [];
  for (const name of ['bridgeLane', 'laneEnd', 'churchLane', 'farmLane']) {
    const road = roadByName(name);
    for (let s = 14; s < road.length - 8; s += 42) {
      const sm = road.samples[Math.min(road.samples.length - 1, Math.round(s / 3))];
      const x = sm.x + sm.nx * (VERGE + 2.1);
      const z = sm.z + sm.nz * (VERGE + 2.1);
      if (inBuiltZone(x, z, 3) || !inIsland(x, z, 10) || railEdgeAt(x, z) < 3) continue;
      out.push({ x, z, y: groundAt(x, z), turn: Math.atan2(-sm.tz, sm.tx) });
    }
  }
  return out;
}

/** The wires, slung with a sag between consecutive poles of one lane. */
function wires(list: Pole[]): BufferGeometry | null {
  const pts: number[] = [];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (Math.hypot(b.x - a.x, b.z - a.z) > 60) continue;
    for (const off of [-0.7, 0.7]) {
      const ax = a.x + Math.cos(a.turn) * off;
      const az = a.z - Math.sin(a.turn) * off;
      const bx = b.x + Math.cos(b.turn) * off;
      const bz = b.z - Math.sin(b.turn) * off;
      let px = ax; let py = a.y + 8.05; let pz = az;
      for (let k = 1; k <= 4; k++) {
        const t = k / 4;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const y = a.y + 8.05 + (b.y - a.y) * t - 0.6 * 4 * t * (1 - t);
        pts.push(px, py, pz, x, y, z);
        px = x; py = y; pz = z;
      }
    }
  }
  if (!pts.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  return g;
}

/** Post-and-rail round a closed run of corners. */
/**
 * Chicken wire on light stakes, round the poultry run.
 *
 * Not the paddock's post and rail: a bird run is a two-metre stake every
 * couple of metres with netting strained between, and what reads at a
 * distance is the row of thin uprights and a mesh you can see the arks
 * through. The mesh is two thin horizontal strands and a vertical every
 * 0.4 m — cheap, and it reads as wire rather than as a wall.
 */
function netting(corners: Pt[]): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  const H = 1.9;
  for (let i = 0; i < corners.length; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % corners.length];
    const len = Math.hypot(bx - ax, bz - az);
    const turn = Math.atan2(-(bz - az), bx - ax);
    const stakes = Math.max(1, Math.round(len / 2.4));
    for (let k = 0; k <= stakes; k++) {
      const t = k / stakes;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const g = new BoxGeometry(0.1, H, 0.1);
      g.translate(x, groundAt(x, z) + H / 2 - 0.1, z);
      parts.push(g);
    }
    // The mesh: two strained wires and a vertical every 0.4 m.
    const wires = Math.max(2, Math.round(len / 0.4));
    for (let k = 0; k < wires; k++) {
      const t = (k + 0.5) / wires;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const g = new BoxGeometry(0.012, H - 0.18, 0.012);
      g.translate(x, groundAt(x, z) + (H - 0.18) / 2 - 0.08, z);
      parts.push(g);
    }
    for (let k = 0; k < stakes; k++) {
      const t0 = k / stakes;
      const t1 = (k + 1) / stakes;
      const x0 = ax + (bx - ax) * t0;
      const z0 = az + (bz - az) * t0;
      const x1 = ax + (bx - ax) * t1;
      const z1 = az + (bz - az) * t1;
      const y0 = groundAt(x0, z0);
      const y1 = groundAt(x1, z1);
      const seg = Math.hypot(x1 - x0, z1 - z0, y1 - y0);
      for (const rise of [0.35, 1.72]) {
        const g = new BoxGeometry(seg, 0.03, 0.03);
        g.rotateZ(Math.atan2(y1 - y0, Math.hypot(x1 - x0, z1 - z0)));
        g.rotateY(turn);
        g.translate((x0 + x1) / 2, (y0 + y1) / 2 + rise, (z0 + z1) / 2);
        parts.push(g);
      }
    }
  }
  if (!parts.length) return null;
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * Post-and-rail round the paddock.
 *
 * Three rails, not two, and a post every 2.2 m with a proper 1.45 m head on
 * it: two thin rails on stubs is a garden fence, and what a paddock has is a
 * stock fence a horse cannot lean through. The posts are morticed — each one
 * is a little taller than the top rail and a shade wider at its head — and
 * the rails follow the ground rather than stepping, so the run reads along a
 * slope. One bay is left out for the gate, on the side nearest the lane, and
 * its two posts are heavier.
 */
function fence(corners: Pt[], closed: boolean): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  const n = closed ? corners.length : corners.length - 1;
  const RAILS = [0.45, 0.85, 1.25];
  const POST = 1.45;
  // Where the gateway goes: the bay whose middle is nearest a lane.
  let gateSide = -1;
  let gateBest = Infinity;
  for (let i = 0; i < n; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % corners.length];
    const d = roadEdgeAt((ax + bx) / 2, (az + bz) / 2);
    if (d < gateBest) { gateBest = d; gateSide = i; }
  }
  for (let i = 0; i < n; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % corners.length];
    const len = Math.hypot(bx - ax, bz - az);
    const turn = Math.atan2(-(bz - az), bx - ax);
    const posts = Math.max(1, Math.round(len / 2.2));
    // The gateway: one bay in the middle of the chosen side left open.
    const gateBay = i === gateSide ? Math.floor(posts / 2) : -1;
    for (let k = 0; k <= posts; k++) {
      const t = k / posts;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const y = groundAt(x, z);
      const heavy = k === gateBay || k === gateBay + 1;
      const w = heavy ? 0.19 : 0.14;
      const g = new BoxGeometry(w, POST + (heavy ? 0.2 : 0), w);
      g.translate(x, y + (POST + (heavy ? 0.2 : 0)) / 2 - 0.12, z);
      parts.push(g);
      // A shallow cap, so a post head is a head and not a cut stick.
      const cap = new BoxGeometry(w + 0.05, 0.06, w + 0.05);
      cap.translate(x, y + POST + (heavy ? 0.2 : 0) - 0.12, z);
      parts.push(cap);
    }
    for (let k = 0; k < posts; k++) {
      if (k === gateBay) continue;
      const t0 = k / posts;
      const t1 = (k + 1) / posts;
      const x0 = ax + (bx - ax) * t0;
      const z0 = az + (bz - az) * t0;
      const x1 = ax + (bx - ax) * t1;
      const z1 = az + (bz - az) * t1;
      const y0 = groundAt(x0, z0);
      const y1 = groundAt(x1, z1);
      const seg = Math.hypot(x1 - x0, z1 - z0, y1 - y0);
      for (const rise of RAILS) {
        const g = new BoxGeometry(seg, 0.11, 0.055);
        g.rotateZ(Math.atan2(y1 - y0, Math.hypot(x1 - x0, z1 - z0)));
        g.rotateY(turn);
        g.translate((x0 + x1) / 2, (y0 + y1) / 2 + rise, (z0 + z1) / 2);
        parts.push(g);
      }
    }
  }
  if (!parts.length) return null;
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/** The vineyard: a post every four metres along each row, and the vines between. */
function vines() {
  const posts: Array<{ x: number; z: number; y: number; turn: number }> = [];
  const rows: Array<{ x: number; z: number; y: number; turn: number }> = [];
  const V = VINEYARD;
  const c = Math.cos(V.turn);
  const s = Math.sin(V.turn);
  for (let i = 0; i < V.rows; i++) {
    const v = -V.d / 2 + ((i + 0.5) * V.d) / V.rows;
    for (let u = -V.w / 2 + 2; u <= V.w / 2 - 2; u += 4) {
      const x = V.x + u * c + v * s;
      const z = V.z - u * s + v * c;
      posts.push({ x, z, y: groundAt(x, z), turn: V.turn });
      if (u < V.w / 2 - 2) {
        const mx = V.x + (u + 2) * c + v * s;
        const mz = V.z - (u + 2) * s + v * c;
        rows.push({ x: mx, z: mz, y: groundAt(mx, mz), turn: V.turn });
      }
    }
  }
  return { posts, rows };
}

/**
 * A clump of standing corn: five tapered stalks leaning slightly apart, each
 * with a fatter ear at the top.
 *
 * Geometry, not a card. The grass pack was alpha cards and the user had it
 * taken out; a stalk is four triangles and reads as a stalk from a metre away
 * as well as from fifty, which a card seen edge-on does not.
 */
function cropClump(height: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const rnd = makeRandom(77);
  for (let i = 0; i < 5; i++) {
    const t = (i / 5) * TAU + rnd();
    const lean = 0.06 + rnd() * 0.07;
    const h = height * (0.82 + rnd() * 0.3);
    const stalk = new BoxGeometry(0.018, h, 0.018);
    stalk.translate(0, h / 2, 0);
    stalk.rotateX(Math.cos(t) * lean);
    stalk.rotateZ(Math.sin(t) * lean);
    stalk.translate(Math.cos(t) * 0.07, 0, Math.sin(t) * 0.07);
    parts.push(stalk);
    const ear = new BoxGeometry(0.045, h * 0.24, 0.045);
    ear.translate(0, h * 0.9, 0);
    ear.rotateX(Math.cos(t) * lean);
    ear.rotateZ(Math.sin(t) * lean);
    ear.translate(Math.cos(t) * 0.07, 0, Math.sin(t) * 0.07);
    parts.push(ear);
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * The standing corn in the two fields the machines are working.
 *
 * Drilled in rows along the field's own `rowAngle` — which on a slope is the
 * fall line, so the rows climb it — and cut away along the loop the machine
 * drives, so there is a swathe of worked ground behind it and standing crop
 * everywhere else. That gap is the whole point: it is what makes a combine
 * going round a field read as a combine working rather than one parked on a
 * lawn.
 */
function crops(): Array<{ x: number; z: number; y: number; turn: number; scale: number }> {
  const out: Array<{ x: number; z: number; y: number; turn: number; scale: number }> = [];
  const rnd = makeRandom(88);
  for (const loop of WORK_LOOPS) {
    const field = FIELDS.find((f) => f.id === loop.field);
    if (!field) continue;
    let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
    for (const [x, z] of field.polygon) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const c = Math.cos(field.rowAngle);
    const sn = Math.sin(field.rowAngle);
    const reach = Math.hypot(x1 - x0, z1 - z0) / 2 + 4;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    // Along each row, in the row's own frame, then back to the island's.
    for (let v = -reach; v <= reach; v += 2.6) {
      for (let u = -reach; u <= reach; u += 2.4) {
        const x = cx + u * c + v * sn + (rnd() - 0.5) * 0.7;
        const z = cz - u * sn + v * c + (rnd() - 0.5) * 0.7;
        if (!pointInPolygon(field.polygon, x, z)) continue;
        if (roadEdgeAt(x, z) < 7 || railEdgeAt(x, z) < 7 || inBuiltZone(x, z, 4)) continue;
        // The cut swathe: the machine's own track, and a little either side.
        if (onWorkLoop(x, z, 6)) continue;
        out.push({ x, z, y: groundAt(x, z), turn: rnd() * TAU, scale: 0.85 + rnd() * 0.35 });
      }
    }
  }
  return out;
}

function bales(): Array<{ x: number; z: number; y: number; turn: number }> {
  const rnd = makeRandom(31);
  const out: Array<{ x: number; z: number; y: number; turn: number }> = [];
  for (const f of FIELDS) {
    if (f.crop !== 'stubble' && f.crop !== 'meadow') continue;
    let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
    for (const [x, z] of f.polygon) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    let placed = 0;
    for (let i = 0; i < 200 && placed < (f.crop === 'stubble' ? 14 : 7); i++) {
      const x = x0 + rnd() * (x1 - x0);
      const z = z0 + rnd() * (z1 - z0);
      let hit = false;
      const poly = f.polygon;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, zi] = poly[a];
        const [xj, zj] = poly[b];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
      }
      if (!hit || roadEdgeAt(x, z) < 6.5 || inBuiltZone(x, z, 3) || lakeFraction(x, z) < 1.3 || railEdgeAt(x, z) < 4) continue;
      // Not on the combine's own circuit — it drives round these fields.
      if (onWorkLoop(x, z, 9)) continue;
      if (out.some((b) => Math.hypot(b.x - x, b.z - z) < 5)) continue;
      const turn = f.rowAngle + (rnd() - 0.5) * 0.3;
      out.push({ x, z, y: groundAt(x, z), turn });
      if (rnd() < 0.2) out.push({ x, z, y: groundAt(x, z) + 1.5, turn });
      placed++;
    }
  }
  return out;
}

/* ------------------------------------------------------------- render */

function Instanced({ geometry, material, at, castShadow = true }: {
  geometry: BufferGeometry;
  material: Material;
  at: ReadonlyArray<{ x: number; y: number; z: number; turn: number; scale?: number }>;
  castShadow?: boolean;
}) {
  const matrices = useMemo(() => {
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    return at.map((a) => {
      q.setFromAxisAngle(UP, a.turn);
      p.set(a.x, a.y, a.z);
      s.setScalar(a.scale ?? 1);
      return new Matrix4().compose(p, q, s);
    });
  }, [at]);
  if (!matrices.length) return null;
  return (
    <InstancedField matrices={matrices} geometry={geometry} material={material} chunk={40} castShadow={castShadow} />
  );
}

export function CountryPlanting() {
  const { scene } = useGLTF(PARK_MODEL, DRACO_PATH);


  const kit = useMemo(() => {
    const out = new Map<TreePart, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of PARTS) {
      const node = scene.getObjectByName(name);
      if (!node) continue;
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      node.traverse((child) => {
        if (child instanceof Mesh) pairs.push({ geometry: child.geometry, material: child.material as Material });
      });
      if (pairs.length) out.set(name, pairs);
    }
    return out;
  }, [scene]);

  const placed = useMemo(() => plant(), []);
  const byPart = useMemo(() => {
    const groups = new Map<TreePart, Array<{ x: number; y: number; z: number; turn: number; scale: number }>>();
    for (const p of placed) {
      if (!groups.has(p.part)) groups.set(p.part, []);
      groups.get(p.part)!.push({ x: p.x, y: groundAt(p.x, p.z) - 0.06, z: p.z, turn: p.turn, scale: p.scale });
    }
    return groups;
  }, [placed]);

  const built = useMemo(() => {
    const poleList = poles();
    return {
      /*
       * No hedges. They were the island's field boundaries — nine kilometres
       * of them, and a collider under every metre — and the user had the lot
       * taken out. The RUNS are still computed, because three other things
       * read them: the hedgerow trees stand along them, the gates hang in
       * their gaps, and the ground map draws the boundary lines. What is gone
       * is the geometry and the physics, so a field edge is now a line of
       * trees and a change of crop rather than a wall of green a car bounces
       * off. The stone walls stay: a wall is not a hedge.
       */
      walls: buildRuns([...HEDGES, ...ROADSIDE], 'wall', 0.7, () => 1.15, 0.15),
      wallBoxes: runColliders([...HEDGES, ...ROADSIDE].filter((r) => r.kind === 'wall'), 1.15, 0.7),
      gate: gateGeometry(),
      gates: GATES.map((g) => ({ x: g.x, z: g.z, y: groundAt(g.x, g.z), turn: g.turn })),
      bale: baleGeometry(),
      bales: bales(),
      pole: poleGeometry(),
      poles: poleList,
      wires: wires(poleList),
      paddock: fence(PADDOCK_FENCE, true),
      netting: netting(POULTRY_FENCE),
      crop: cropClump(0.95),
      crops: crops(),
      vinePost: (() => { const g = new BoxGeometry(0.1, 1.8, 0.1); g.translate(0, 0.9, 0); return g; })(),
      vineRow: (() => { const g = new BoxGeometry(3.8, 1.1, 0.5); g.translate(0, 0.95, 0); return g; })(),
      vines: vines(),
    };
  }, []);

  const materials = useMemo(() => ({
    wall: new MeshStandardMaterial({ color: '#8a8478', roughness: 0.96 }),
    oak: new MeshStandardMaterial({ color: '#8b7355', roughness: 0.85 }),
    straw: new MeshStandardMaterial({ color: '#c9a962', roughness: 0.95 }),
    corn: new MeshStandardMaterial({ color: '#cbb05e', roughness: 0.95 }),
    pole: new MeshStandardMaterial({ color: '#6d5a44', roughness: 0.9 }),
    vine: new MeshStandardMaterial({ color: '#3f6a2c', roughness: 0.95 }),
  }), []);

  useEffect(() => {
    const trees = placed.filter((p) => !p.part.startsWith('bush')).length;
    console.info(`[country] ${built.crops.length} clumps of standing corn; `
      + `${trees} trees and ${placed.length - trees} bushes, ${built.gates.length} gates, `
      + `${built.bales.length} bales, ${built.poles.length} poles`);
    return () => {
      for (const g of [built.walls, built.gate, built.bale, built.pole, built.wires, built.paddock, built.netting, built.vinePost, built.vineRow, built.crop]) g?.dispose();
      for (const m of Object.values(materials)) m.dispose();
    };
  }, [placed, built, materials]);

  return (
    <group>
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
      {built.walls && (
        <mesh geometry={built.walls} material={materials.wall} castShadow receiveShadow />
      )}
      <Instanced geometry={built.gate} material={materials.oak} at={built.gates} />
      <Instanced geometry={built.bale} material={materials.straw} at={built.bales} />
      <Instanced geometry={built.crop} material={materials.corn} at={built.crops} castShadow={false} />
      <Instanced geometry={built.pole} material={materials.pole} at={built.poles} />
      {built.wires && (
        <lineSegments geometry={built.wires}>
          <lineBasicMaterial color="#1c1a18" />
        </lineSegments>
      )}
      {built.paddock && (
        <mesh geometry={built.paddock} material={materials.oak} castShadow receiveShadow />
      )}
      {built.netting && (
        <mesh geometry={built.netting} material={materials.pole} castShadow receiveShadow />
      )}
      <Instanced geometry={built.vinePost} material={materials.pole} at={built.vines.posts} castShadow={false} />
      <Instanced geometry={built.vineRow} material={materials.vine} at={built.vines.rows} />

      <RigidBody type="fixed" colliders={false}>
        {built.wallBoxes.map((b, i) => (
          <CuboidCollider
            key={`w${i}`}
            args={[b.length / 2, 0.58, 0.35]}
            position={[b.x, b.y, b.z]}
            rotation={[0, b.turn, 0]}
            friction={0.6}
          />
        ))}
        {placed.filter((p) => !p.part.startsWith('bush')).map((p, i) => (
          <CuboidCollider
            key={`t${i}`}
            args={[0.32 * p.scale, 2.2, 0.32 * p.scale]}
            position={[p.x, groundAt(p.x, p.z) + 2.1, p.z]}
            friction={0.5}
          />
        ))}
      </RigidBody>
    </group>
  );
}

/** Where the wood is, for anything that wants to keep out of it. */
export const inHangerWood = inWood;
