'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide,
  Material, Matrix4, Mesh, Object3D, Quaternion, RepeatWrapping, SRGBColorSpace, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { CRUISE, CRUISE_BERTH } from '@/config/stationConfig';
import { ParkedCars } from './parkedCars';
import { InstancedField } from './instancedField';

/**
 * The landside of Kestrel's cruise berth: a terminal and its grounds.
 *
 * ## Keep the ship in view
 *
 * The ship is the reason anyone comes here; anything stood between her and
 * the island is in the way of the one view that matters. So nothing is built
 * alongside her at all. The terminal is a small pavilion at the east end of
 * the berth, PAST her stern, and passengers walk out to her along a slim
 * glazed walkway at first-floor height that runs only the length of her
 * stern quarter. From the town, the station and the train the whole of her
 * side is open: the quay in front of her is paving, benches and lamps.
 *
 * ## The ground, in zones
 *
 * From the quay road out to the water, each strip has its own surface:
 *
 *   planting strip   along the kerb: trees in a lawn, lamps and benches
 *   drop-off loop    asphalt, with lane lines and marked coach and taxi bays
 *   the concourse    large-format paving in two greys, banded, round the hall
 *   the promenades   the same paving at each end of the berth, with benches
 *                    turned to face the ship — the place people stand and look
 *   the quay apron   jointed concrete, a yellow safety line along the edge
 *
 * ## The terminal
 *
 * Glass on all four sides between white columns, under a roof that rolls in
 * a long wave down its length — the one gesture a cruise terminal is allowed,
 * and the thing that makes it read as one from across the harbour. Two short
 * glazed boarding tunnels run straight out of its seaward face to the ship's
 * side at first-floor height.
 *
 * Drawn inside `CruiseTerminal`'s group: x across (out from the line toward
 * the ship), y up from the island crown, z along.
 */

/** The quay road's kerb (`kestrelRoads`: the quay road is at across 289). */
const KERB = 289 + 9.5;

const ZONE = {
  /** The tree line along the kerb, then the loop, then the concourse; across bounds. */
  plantFrom: KERB,
  plantTo: KERB + 6,
  loopFrom: KERB + 6,
  loopTo: KERB + 20,
  /** The concourse and promenade run from the loop out to the apron line. */
  concourseTo: 339,
  /** Along bounds of the whole landside, and of the drop-off loop by the terminal. */
  from: -212,
  to: 22,
  /** The tree line stops where the quay road does (its end junction is at -12). */
  treeTo: -16,
  loopAlongFrom: -62,
  loopAlongTo: -4,
};

/**
 * The terminal: a hall standing past the ship's stern — she ends at about
 * +0.5 — and running INLAND from the quay to the dock road, so it has all
 * the length a terminal wants without any of it standing alongside her.
 * Glass between white columns, under a roof that rolls in a long wave down
 * its length, with a deep canopy over its west side where the drop-off loop
 * and the taxi rank are.
 */
const HALL = {
  across0: 258,
  across1: 337,
  along0: 3,
  along1: 21,
  wall: 5.6,
  /** Roof: base height over the walls, and the wave down its length. */
  roof: 6.6,
  wave: 1.4,
  waves: 2,
  /** Overhangs: the west side is the canopy; the rest just shade the glass. */
  overWest: 7,
  overEast: 1.5,
  overEnds: 1.5,
};

/** The coach park, on the open ground east of the hall: across and along bounds, and the bays. */
const COACH_PARK = { across0: 258, across1: 288, along0: 30, along1: 62 };
const COACH_BAYS = [36, 42, 48, 54];

/** The walkway's floor height, where it runs, and where it turns out to the ship. */
const WALK_Y = 5.0;
const WALK_ACROSS = 342.5;
const WALK_DOOR = -16;

/* ------------------------------------------------------------------ textures */

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Large-format paving: 1.2 x 0.6 m slabs in a stretcher bond, two greys, fine joints. */
const PAVER_REPEAT = 4.8;
function makePavers() {
  let seed = 21;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#8d8a84';
    ctx.fillRect(0, 0, 256, 256);
    const rows = 8;
    const h = 256 / rows;
    const w = h * 2;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? w / 2 : 0;
      for (let c = -1; c < 256 / w + 1; c++) {
        const t = 188 + Math.floor(rnd() * 22);
        ctx.fillStyle = `rgb(${t},${t - 1},${t - 5})`;
        ctx.fillRect(c * w + off + 1.5, r * h + 1.5, w - 3, h - 3);
      }
    }
  });
}

/** A darker band of the same slabs, laid across the concourse every so often. */
function makeBand() {
  return canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#4f5257';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#5e6166';
    for (let i = 0; i < 4; i++) ctx.fillRect(i * 16 + 1, 1, 14, 62);
  });
}

/** Jointed concrete for the apron: 6 m bays with a sawn joint between. */
const CONCRETE_REPEAT = 6;
function makeConcrete() {
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#a19e98';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 600; i++) {
      const t = 140 + Math.floor(rnd() * 40);
      ctx.fillStyle = `rgba(${t},${t},${t - 4},0.35)`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    ctx.fillStyle = '#6f6c67';
    ctx.fillRect(0, 0, 128, 1.5);
    ctx.fillRect(0, 0, 1.5, 128);
  });
}

/** Asphalt, fine-grained. */
function makeAsphalt() {
  let seed = 77;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#3a3c3f';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1500; i++) {
      const t = 45 + Math.floor(rnd() * 40);
      ctx.fillStyle = `rgb(${t},${t},${t + 2})`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 1, 1);
    }
  });
}

/** Curtain wall: 1.5 m bays of glass between slim mullions, a transom at door head. */
function makeCurtain() {
  return canvasTexture(128, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#9fc4d6');
    g.addColorStop(1, '#4e7486');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 256);
    ctx.fillStyle = '#e9ecee';
    ctx.fillRect(0, 0, 6, 256);
    ctx.fillRect(122, 0, 6, 256);
    ctx.fillRect(0, 118, 128, 5);
    ctx.fillRect(0, 0, 128, 4);
    ctx.fillRect(0, 252, 128, 4);
  });
}

/** White on railway blue — the station's own signs. */
function makeSign(text: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#123a6b';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 66);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ---------------------------------------------------------------- geometry */

/** A flat rectangle at height `y`, its UVs in world metres over `repeat`. */
function slab(a0: number, a1: number, z0: number, z1: number, y: number, repeat: number) {
  const g = new BufferGeometry();
  const p = [a0, y, z0, a1, y, z0, a1, y, z1, a0, y, z1];
  const uv = [a0 / repeat, z0 / repeat, a1 / repeat, z0 / repeat, a1 / repeat, z1 / repeat, a0 / repeat, z1 / repeat];
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeVertexNormals();
  return g;
}

const mergeAll = (list: BufferGeometry[]) => {
  const merged = mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  for (const g of list) g.dispose();
  return merged;
};

/** The taxi rank, along the loop: the centre of each bay. */
const TAXI_BAYS = [-40, -34, -28, -22];

/** Where the trees stand along the kerb, clear of the loop's mouths. */
function treeLine(): number[] {
  const mouths = [ZONE.loopAlongFrom + 6, ZONE.loopAlongTo - 6];
  const out: number[] = [];
  for (let z = ZONE.from + 4; z <= ZONE.treeTo; z += 9) {
    if (mouths.some((m) => Math.abs(z - m) < 9)) continue;
    out.push(z);
  }
  return out;
}

/** Trees round the coach park, at its ends and down its landward side. */
function coachParkTrees(): Array<[number, number]> {
  const C = COACH_PARK;
  const out: Array<[number, number]> = [];
  for (let x = C.across0 + 2; x <= C.across1; x += 8) out.push([x, C.along1 + 2.5]);
  for (let z = C.along0 + 4; z <= C.along1; z += 9) out.push([C.across0 - 3, z]);
  return out;
}

/** The ground: every zone's surface, one geometry per material. */
function buildGround() {
  const Z = ZONE;
  const pavers: BufferGeometry[] = [];
  const bands: BufferGeometry[] = [];
  const lawn: BufferGeometry[] = [];
  const asphalt: BufferGeometry[] = [];
  const paint: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const kerbs: BufferGeometry[] = [];

  // The tree line along the kerb: paving, with a square iron grate round
  // each tree, and the loop's two mouths cut through it in asphalt.
  const mouths = [Z.loopAlongFrom + 6, Z.loopAlongTo - 6];
  let start = Z.from;
  for (const m of mouths) {
    pavers.push(slab(Z.plantFrom, Z.plantTo, start, m - 6, 0.06, PAVER_REPEAT));
    asphalt.push(slab(Z.plantFrom - 0.5, Z.loopFrom, m - 6, m + 6, 0.065, 8));
    start = m + 6;
  }
  pavers.push(slab(Z.plantFrom, Z.plantTo, start, Z.loopAlongTo + 6, 0.06, PAVER_REPEAT));
  for (const z of treeLine()) {
    const c = (Z.plantFrom + Z.plantTo) / 2;
    lawn.push(slab(c - 0.9, c + 0.9, z - 0.9, z + 0.9, 0.07, 1.8));
  }

  // The drop-off loop: asphalt, an edge line both sides, a centre dash, and
  // bays on the concourse side.
  asphalt.push(slab(Z.loopFrom, Z.loopTo, Z.loopAlongFrom, Z.loopAlongTo, 0.065, 8));
  for (const a of [Z.loopFrom + 0.4, Z.loopTo - 0.4]) {
    paint.push(slab(a - 0.08, a + 0.08, Z.loopAlongFrom, Z.loopAlongTo, 0.075, 1));
  }
  for (let z = Z.loopAlongFrom + 2; z < Z.loopAlongTo - 2; z += 6) {
    paint.push(slab((Z.loopFrom + Z.loopTo) / 2 - 3.5 - 0.06, (Z.loopFrom + Z.loopTo) / 2 - 3.5 + 0.06, z, z + 3, 0.075, 1));
  }
  // Bay lines along the loop's outer edge: the taxi rank.
  const bayEdge = Z.loopTo - 4;
  for (const z of TAXI_BAYS) paint.push(slab(bayEdge + 1.2, Z.loopTo - 0.4, z - 3 - 0.07, z - 3 + 0.07, 0.075, 1));
  kerbs.push(new BoxGeometry(0.3, 0.16, Z.loopAlongTo - Z.loopAlongFrom).translate(Z.loopTo + 0.15, 0.08, (Z.loopAlongFrom + Z.loopAlongTo) / 2));

  // The concourse and promenades: pavers from the loop (or the lawn, where
  // there is no loop) to the apron line, with a dark band every 24 m.
  pavers.push(slab(Z.loopTo, Z.concourseTo, Z.from, Z.to, 0.06, PAVER_REPEAT));
  // Where the loop is not, its strip is paved too: the concourse runs right
  // back to the tree line.
  pavers.push(slab(Z.loopFrom, Z.loopTo, Z.from, Z.loopAlongFrom, 0.06, PAVER_REPEAT));
  pavers.push(slab(Z.loopFrom, Z.loopTo, Z.loopAlongTo, Z.to, 0.06, PAVER_REPEAT));
  for (let z = Z.from + 12; z < Z.to; z += 24) {
    bands.push(slab(Z.loopTo, Z.concourseTo, z - 0.9, z + 0.9, 0.068, 1.6));
  }
  // The land round the hall: paved from the dock road's kerb out to the
  // concourse, the whole width of the hall and its canopy.
  const DOCK_KERB = 242.4 + 9.5;
  pavers.push(slab(DOCK_KERB, Z.loopFrom, Z.loopAlongTo, HALL.along1 + 5, 0.06, PAVER_REPEAT));
  pavers.push(slab(Z.loopFrom, Z.loopTo, Z.to, HALL.along1 + 2, 0.06, PAVER_REPEAT));

  // The coach park: asphalt on the open ground east of the hall, coaches
  // nosed in across it in marked bays, an aisle down the middle.
  const C = COACH_PARK;
  pavers.push(slab(DOCK_KERB, C.across1 + 4, HALL.along1 + 5, C.along1 + 4, 0.06, PAVER_REPEAT));
  asphalt.push(slab(C.across0, C.across1, C.along0, C.along1, 0.065, 8));
  asphalt.push(slab(DOCK_KERB - 0.5, C.across0, C.along0 + 10, C.along0 + 20, 0.065, 8));
  for (const z of [...COACH_BAYS.map((b) => b - 3), COACH_BAYS[COACH_BAYS.length - 1] + 3]) {
    paint.push(slab(C.across1 - 15, C.across1 - 1, z - 0.07, z + 0.07, 0.075, 1));
  }
  paint.push(slab(C.across0 + 0.6, C.across0 + 0.75, C.along0 + 1, C.along1 - 1, 0.075, 1));
  paint.push(slab(C.across1 - 0.75, C.across1 - 0.6, C.along0 + 1, C.along1 - 1, 0.075, 1));
  for (const [a0, a1, z0, z1] of [
    [C.across0, C.across1, C.along0 - 0.15, C.along0 + 0.15],
    [C.across0, C.across1, C.along1 - 0.15, C.along1 + 0.15],
    [C.across0 - 0.15, C.across0 + 0.15, C.along0, C.along1],
    [C.across1 - 0.15, C.across1 + 0.15, C.along0, C.along1],
  ] as const) {
    kerbs.push(new BoxGeometry(a1 - a0, 0.16, z1 - z0).translate((a0 + a1) / 2, 0.08, (z0 + z1) / 2));
  }
  // Grates for the trees round the coach park.
  for (const [x, z] of coachParkTrees()) lawn.push(slab(x - 0.9, x + 0.9, z - 0.9, z + 0.9, 0.07, 1.8));

  // The quay's safety line, inboard of the bollards.
  const face = CRUISE_BERTH!.face;
  yellow.push(slab(face - 3.75, face - 3.5, CRUISE_BERTH!.from, CRUISE_BERTH!.to, 0.07, 1));

  return {
    pavers: mergeAll(pavers), bands: mergeAll(bands), lawn: mergeAll(lawn), asphalt: mergeAll(asphalt),
    paint: mergeAll(paint), yellow: mergeAll(yellow), kerbs: mergeAll(kerbs),
  };
}

/** The apron's own concrete: a new top over the plain one, from the concourse to the face. */
function buildApron() {
  const b = CRUISE_BERTH!;
  return slab(ZONE.concourseTo, b.face, b.from, b.to, 0.062, CONCRETE_REPEAT);
}

/**
 * The terminal hall: the glazed walls, the white columns, and the wave roof
 * as a top and bottom skin with a fascia round its edge, and the walkway out
 * to the ship.
 */
function buildHall() {
  const H = HALL;
  const steel: BufferGeometry[] = [];
  const base: BufferGeometry[] = [];

  // Walls: four glazed quads, UVs in 1.5 m bays along and full height up.
  const wallPos: number[] = [];
  const wallUv: number[] = [];
  const quad = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const v = [[ax, 0.3, az, 0, 0], [bx, 0.3, bz, len / 1.5, 0], [bx, H.wall, bz, len / 1.5, 1], [ax, H.wall, az, 0, 1]];
    for (const i of [0, 1, 2, 0, 2, 3]) { wallPos.push(v[i][0], v[i][1], v[i][2]); wallUv.push(v[i][3], v[i][4]); }
  };
  quad(H.across0, H.along0, H.across0, H.along1);
  quad(H.across0, H.along1, H.across1, H.along1);
  quad(H.across1, H.along1, H.across1, H.along0);
  quad(H.across1, H.along0, H.across0, H.along0);
  const walls = new BufferGeometry();
  walls.setAttribute('position', new BufferAttribute(new Float32Array(wallPos), 3));
  walls.setAttribute('uv', new BufferAttribute(new Float32Array(wallUv), 2));
  walls.computeVertexNormals();

  base.push(new BoxGeometry(H.across1 - H.across0 + 0.6, 0.3, H.along1 - H.along0 + 0.6)
    .translate((H.across0 + H.across1) / 2, 0.15, (H.along0 + H.along1) / 2));

  // The roof: a grid, rolling down the hall's LENGTH (across) and arched a
  // little over its width (along).
  const r0 = H.across0 - H.overEnds;
  const r1 = H.across1 + H.overEnds;
  const z0 = H.along0 - H.overWest;
  const z1 = H.along1 + H.overEast;
  const nx = 64;
  const nz = 12;
  const heightAt = (x: number, z: number) => {
    const u = (x - r0) / (r1 - r0);
    const v = (z - z0) / (z1 - z0);
    return H.roof + H.wave * 0.5 * (1 + Math.sin(u * Math.PI * 2 * H.waves - Math.PI / 2))
      + Math.sin(v * Math.PI) * 0.8;
  };
  const top: number[] = [];
  const bot: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = r0 + ((r1 - r0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      const y = heightAt(x, z);
      top.push(x, y + 0.35, z);
      bot.push(x, y, z);
    }
  }
  const idxTop: number[] = [];
  const idxBot: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idxTop.push(a, c, b, b, c, d);
      idxBot.push(a, b, c, b, d, c);
    }
  }
  const surface = (pos: number[], idx: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  const roofTop = surface(top, idxTop);
  const roofBottom = surface(bot, idxBot);
  const fascia: number[] = [];
  const edge = (i0: number, j0: number, i1: number, j1: number) => {
    const at = (i: number, j: number) => {
      const x = r0 + ((r1 - r0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      return [x, heightAt(x, z), z];
    };
    const steps = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
    for (let k = 0; k < steps; k++) {
      const p = at(i0 + ((i1 - i0) * k) / steps, j0 + ((j1 - j0) * k) / steps);
      const q = at(i0 + ((i1 - i0) * (k + 1)) / steps, j0 + ((j1 - j0) * (k + 1)) / steps);
      fascia.push(p[0], p[1], p[2], q[0], q[1], q[2], q[0], q[1] + 0.35, q[2]);
      fascia.push(p[0], p[1], p[2], q[0], q[1] + 0.35, q[2], p[0], p[1] + 0.35, p[2]);
    }
  };
  edge(0, 0, nx, 0); edge(nx, 0, nx, nz); edge(nx, nz, 0, nz); edge(0, nz, 0, 0);
  const fasciaGeometry = new BufferGeometry();
  fasciaGeometry.setAttribute('position', new BufferAttribute(new Float32Array(fascia), 3));
  fasciaGeometry.computeVertexNormals();

  // Columns: down both long walls and the canopy's outer edge, every 7.9 m.
  for (let x = H.across0; x <= H.across1 + 1e-6; x += (H.across1 - H.across0) / 10) {
    for (const z of [z0 + 1, H.along0, H.along1]) {
      const y = heightAt(x, z);
      steel.push(new CylinderGeometry(0.22, 0.26, y, 10).translate(x, y / 2, z));
    }
  }

  // The walkway: out of the hall's seaward end at first-floor height, along
  // the quay over her stern quarter only, then a short tunnel out to her side
  // door. Glazed, on slim legs: the one structure that does stand by her,
  // and it is a glass tube.
  const glass: BufferGeometry[] = [];
  const run = (x0: number, zz0: number, x1: number, zz1: number) => {
    const len = Math.hypot(x1 - x0, zz1 - zz0);
    const turn = Math.atan2(x1 - x0, zz1 - zz0);
    const at = (g: BufferGeometry, y: number) => g.rotateY(turn).translate((x0 + x1) / 2, y, (zz0 + zz1) / 2);
    glass.push(at(new BoxGeometry(2.6, 2.5, len), WALK_Y + 1.25));
    steel.push(at(new BoxGeometry(3.0, 0.3, len + 0.2), WALK_Y - 0.15));
    steel.push(at(new BoxGeometry(3.0, 0.22, len + 0.2), WALK_Y + 2.6));
  };
  run(H.across1, H.along0 + 2, WALK_ACROSS + 1.3, H.along0 + 2);
  run(WALK_ACROSS, H.along0 + 2, WALK_ACROSS, WALK_DOOR);
  run(WALK_ACROSS + 1.3, WALK_DOOR, CRUISE_BERTH!.face + 1.9, WALK_DOOR);
  for (let z = WALK_DOOR; z <= H.along0 + 2; z += 6) {
    steel.push(new BoxGeometry(0.35, WALK_Y, 0.35).translate(WALK_ACROSS, WALK_Y / 2, z));
  }

  return {
    walls, roofTop, roofBottom, fascia: fasciaGeometry,
    steel: mergeAll(steel), base: mergeAll(base), glass: mergeAll(glass),
  };
}

/** Mooring lines from the ship's rail to the bollards, each a thin cylinder. */
function buildLines(shipSide: number, shipLength: number) {
  const out: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0);
  const half = shipLength / 2;
  const lines: Array<[number, number]> = [
    [-half + 12, -half - 6], [-half + 14, -half + 4], [-half + 40, -half + 58],
    [half - 40, half - 58], [half - 14, half - 4], [half - 12, half + 6],
  ];
  for (const [ship, bollard] of lines) {
    const a = new Vector3(shipSide + 1.5, 6.2, CRUISE.along + ship);
    const b = new Vector3(CRUISE_BERTH!.face - 2.6, 0.9, CRUISE.along + bollard);
    const d = new Vector3().subVectors(b, a);
    const g = new CylinderGeometry(0.07, 0.07, d.length(), 5);
    g.applyQuaternion(new Quaternion().setFromUnitVectors(up, d.clone().normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    out.push(g);
  }
  return mergeAll(out);
}

/* ----------------------------------------------------------------- planting */

type KitPart = 'treeBroad' | 'treeSlim' | 'bench' | 'lamp' | 'bin' | 'planter' | 'bush';
const KIT: readonly KitPart[] = ['treeBroad', 'treeSlim', 'bench', 'lamp', 'bin', 'planter', 'bush'];

/** Where the park kit goes: trees in the strip, lamps down the loop, benches facing the ship. */
function planGrounds(): Map<KitPart, Matrix4[]> {
  const out = new Map<KitPart, Matrix4[]>(KIT.map((k) => [k, []]));
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const put = (part: KitPart, x: number, z: number, turn = 0, scale = 1) => {
    q.setFromAxisAngle(up, turn);
    out.get(part)!.push(new Matrix4().compose(new Vector3(x, 0.06, z), q.clone(), new Vector3().setScalar(scale)));
  };
  const Z = ZONE;
  // Trees down the kerb, in their grates, alternating kinds, and round the coach park.
  for (const z of treeLine()) {
    put(Math.round(z / 9) % 2 ? 'treeBroad' : 'treeSlim', (Z.plantFrom + Z.plantTo) / 2, z, z, Math.round(z / 9) % 2 ? 0.7 : 0.8);
  }
  coachParkTrees().forEach(([x, z], i) => put(i % 2 ? 'treeBroad' : 'treeSlim', x, z, x + z, i % 2 ? 0.65 : 0.75));
  // Lamps along the loop's concourse side, and along the quay.
  for (let z = Z.loopAlongFrom + 4; z <= Z.loopAlongTo; z += 16) put('lamp', Z.loopTo + 1, z, 0, 1.8);
  for (let x = COACH_PARK.across0; x <= COACH_PARK.across1; x += 17) put('lamp', x, COACH_PARK.along0 - 1.5, 0, 1.8);
  const b = CRUISE_BERTH!;
  for (let z = b.from + 10; z < b.to; z += 24) put('lamp', b.face - 6, z, 0, 2);
  // The promenade along the whole of her side: benches facing her, planters
  // between, and nothing taller than a bush.
  for (const [from, to] of [[Z.from + 6, WALK_DOOR - 6]] as const) {
    for (let z = from; z <= to; z += 8) {
      put('bench', 335, z, Math.PI, 1);
      put('planter', 330, z + 4, 0, 0.6);
      put('bush', 330, z + 4, z, 0.8);
    }
    put('bin', 336, from - 2);
  }
  return out;
}

/* -------------------------------------------------------------------- the lot */

export function CruisePort({ shipSide, shipLength }: { shipSide: number; shipLength: number }) {
  const berth = CRUISE_BERTH;
  const { scene: park } = useGLTF('/models/park.glb', DRACO_PATH);

  const ground = useMemo(() => buildGround(), []);
  const apron = useMemo(() => buildApron(), []);
  const hall = useMemo(() => buildHall(), []);
  const lines = useMemo(() => buildLines(shipSide, shipLength), [shipSide, shipLength]);
  const textures = useMemo(() => ({
    pavers: makePavers(), band: makeBand(), concrete: makeConcrete(), asphalt: makeAsphalt(),
    curtain: makeCurtain(), sign: makeSign('KESTREL CRUISE TERMINAL'),
  }), []);
  useEffect(() => () => {
    for (const g of Object.values(ground)) g.dispose();
    apron.dispose();
    for (const g of Object.values(hall)) g.dispose();
    lines.dispose();
    for (const t of Object.values(textures)) t.dispose();
  }, [ground, apron, hall, lines, textures]);

  const kit = useMemo(() => {
    const m = new Map<KitPart, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of KIT) {
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      (park as unknown as Object3D).getObjectByName(name)?.traverse((child) => {
        if (child instanceof Mesh) pairs.push({ geometry: child.geometry, material: child.material as Material });
      });
      m.set(name, pairs);
    }
    return m;
  }, [park]);
  const placed = useMemo(() => planGrounds(), []);

  /** Coaches in their bays at the west end of the loop, taxis queued at the east. */
  // Nosed in across the coach park, facing the hall's landward end.
  const coaches = useMemo(() => COACH_BAYS.map((along) => ({ across: COACH_PARK.across1 - 8, along, turn: Math.PI / 2 })), []);
  const taxis = useMemo(() => TAXI_BAYS.map((along) => ({ across: ZONE.loopTo - 1.6, along, turn: 0 })), []);

  if (!berth) return null;
  const H = HALL;

  return (
    <group>
      {/* The ground, zone by zone. */}
      {/* The tree grates: cast iron, round each trunk. */}
      <mesh geometry={ground.lawn} receiveShadow>
        <meshStandardMaterial color="#2c2e30" roughness={0.6} metalness={0.5} />
      </mesh>
      <mesh geometry={ground.asphalt} receiveShadow>
        <meshStandardMaterial map={textures.asphalt} roughness={0.95} />
      </mesh>
      <mesh geometry={ground.pavers} receiveShadow>
        <meshStandardMaterial map={textures.pavers} roughness={0.9} />
      </mesh>
      <mesh geometry={ground.bands} receiveShadow>
        <meshStandardMaterial map={textures.band} roughness={0.9} />
      </mesh>
      <mesh geometry={apron} receiveShadow>
        <meshStandardMaterial map={textures.concrete} roughness={0.95} />
      </mesh>
      <mesh geometry={ground.paint}>
        <meshStandardMaterial color="#ecebe6" roughness={0.8} />
      </mesh>
      <mesh geometry={ground.yellow}>
        <meshStandardMaterial color="#e3b52d" roughness={0.8} />
      </mesh>
      <mesh geometry={ground.kerbs} receiveShadow>
        <meshStandardMaterial color="#b9b6ae" roughness={0.9} />
      </mesh>

      {/* The terminal hall. */}
      <mesh geometry={hall.base} receiveShadow>
        <meshStandardMaterial color="#c7c4bc" roughness={0.9} />
      </mesh>
      <mesh geometry={hall.walls}>
        <meshStandardMaterial map={textures.curtain} roughness={0.12} metalness={0.35} side={DoubleSide} />
      </mesh>
      <mesh geometry={hall.roofTop} castShadow receiveShadow>
        <meshStandardMaterial color="#f3f3f0" roughness={0.5} metalness={0.15} />
      </mesh>
      <mesh geometry={hall.roofBottom} receiveShadow>
        <meshStandardMaterial color="#d9d3c6" roughness={0.7} />
      </mesh>
      <mesh geometry={hall.fascia} castShadow>
        <meshStandardMaterial color="#ffffff" roughness={0.4} side={DoubleSide} />
      </mesh>
      <mesh geometry={hall.steel} castShadow receiveShadow>
        <meshStandardMaterial color="#eef0f1" roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh geometry={hall.glass} castShadow>
        <meshStandardMaterial color="#7fa9bd" roughness={0.1} metalness={0.35} transparent opacity={0.75} />
      </mesh>
      {/* The name over the landside doors, hung under the canopy's edge. */}
      <mesh position={[(H.across0 + H.across1) / 2 - 12, H.wall + 0.2, H.along0 - H.overWest + 0.3]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[20, 2]} />
        <meshStandardMaterial map={textures.sign} roughness={0.7} side={DoubleSide} />
      </mesh>
      <mesh position={[H.across0 - 0.2, H.wall - 1.3, (H.along0 + H.along1) / 2]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[14, 1.4]} />
        <meshStandardMaterial map={textures.sign} roughness={0.7} side={DoubleSide} />
      </mesh>

      <mesh geometry={lines}>
        <meshStandardMaterial color="#c9b98c" roughness={0.9} />
      </mesh>

      {KIT.map((part) => kit.get(part)?.map((pair, i) => (
        <InstancedField
          key={`${part}${i}`}
          matrices={placed.get(part) ?? []}
          geometry={pair.geometry}
          material={pair.material}
          castShadow={part.startsWith('tree') || part === 'lamp'}
        />
      )))}

      <ParkedCars slots={coaches} kinds={['citybus']} y={0.065} />
      <ParkedCars slots={taxis} kinds={['taxi']} y={0.065} />

      {/* Solid: the pavilion itself. */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[(H.across1 - H.across0) / 2, H.wall / 2, (H.along1 - H.along0) / 2]}
          position={[(H.across0 + H.across1) / 2, H.wall / 2, (H.along0 + H.along1) / 2]}
        />
      </RigidBody>
    </group>
  );
}
