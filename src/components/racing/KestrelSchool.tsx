'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, ConeGeometry, CylinderGeometry, DoubleSide,
  Float32BufferAttribute, Matrix4, Mesh,
  MeshStandardMaterial, Object3D, Quaternion, RepeatWrapping, SphereGeometry, SRGBColorSpace,
  Vector3, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_TOP } from '@/config/roadConfig';
import { TOWN_PALETTE, TOWN_PARKED } from '@/config/townConfig';
import {
  GROUNDS, SCHOOL, SCHOOL_BLOCK, SCHOOL_GROUNDS, SCHOOL_SITE, WORKSHOP,
} from '@/config/kestrelSchool';
import { STATION_SITE } from '@/config/stationConfig';
import { partColliders } from './partColliders';
import { ParkedCars, type CarSlot } from './parkedCars';
import { InstancedField } from './instancedField';

const PARK_MODEL = '/models/park.glb';
useGLTF.preload(SCHOOL.model, DRACO_PATH);
useGLTF.preload(PARK_MODEL, DRACO_PATH);
useGLTF.preload(WORKSHOP.model, DRACO_PATH);

const UP = new Vector3(0, 1, 0);

/** What stands on the bus stand. One kind, because a school runs one kind. */
const SCHOOL_BUSES = ['school_bus'] as const;

/** The appliance at the head of the bus line. */
const SCHOOL_APPLIANCE = ['fire_truck'] as const;

/** What goes on the board over the gate. */
const SCHOOL_NAME = 'ST. ANJALI HIGH SCHOOL';

/** The park kit's parts this uses: two avenue trees, a shrub and a lamp. */
const PARTS = [
  'treeSlim', 'treeTall', 'treeBroad', 'treeBig', 'bush', 'bushLow', 'lamp', 'bench',
  'benchSlat', 'bin', 'sign', 'playground',
] as const;
type Part = (typeof PARTS)[number];

/**
 * Heights of the layers, all measured from the island crown.
 *
 * The same stack the town's streets use: the surface stands `ROAD_TOP` over the
 * crown so it meets the road kit's own slabs at exactly their height, and the
 * paint stands a centimetre over that. A kerb is a kerb — 120 mm, which is what
 * a kerb is.
 */
const SURFACE = ROAD_TOP;
const MARK = SURFACE + 0.012;
const KERB = 0.12;
/** Every slab is this thick, so its top lands where it is asked to. */
const SLAB = 0.06;

/** A flat slab with its top at `top`, in the station's (across, along). */
function slab(
  acrossFrom: number, acrossTo: number, alongFrom: number, alongTo: number,
  top: number, thickness = SLAB,
): BoxGeometry {
  const g = new BoxGeometry(
    Math.abs(acrossTo - acrossFrom), thickness, Math.abs(alongTo - alongFrom),
  );
  g.translate(
    (acrossFrom + acrossTo) / 2, top - thickness / 2, (alongFrom + alongTo) / 2,
  );
  return g;
}

/**
 * Merge, and re-cut the UVs in METRES.
 *
 * A `BoxGeometry` maps 0..1 over each face whatever size the box is, so a tiled
 * texture on one set `repeat(40, 40)` puts forty tiles across a 150 m walk and
 * forty across a 9 m drive. Laying the UV off the vertex's own position instead
 * makes the tile a fixed number of metres everywhere, which is the only way two
 * slabs of different sizes can read as the same surface — the same projection
 * `islandGrass` uses for the turf, one surface down.
 */
function merge(parts: BufferGeometry[], tile: number): BufferGeometry | null {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  const pos = merged.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / tile;
    uv[i * 2 + 1] = pos.getZ(i) / tile;
  }
  merged.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return merged;
}

/** Metres to one repeat of each surface's texture. */
const TARMAC_TILE = 4;
const PAVING_TILE = 1;

/**
 * Tarmac, as a canvas.
 *
 * The airport's and the town's argument, unchanged: a flat grey surface a
 * hundred metres across is a colour, not a material, and what tells the eye it
 * is asphalt is the grain rather than the shade. Drawn once at 128 px and
 * repeated every four metres.
 */
function makeTarmac(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#42444a';
    ctx.fillRect(0, 0, 128, 128);
    let seed = 29;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    for (let i = 0; i < 2600; i++) {
      const g = 46 + Math.floor(rnd() * 32);
      ctx.fillStyle = `rgb(${g},${g + 2},${g + 5})`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 1.4, 1.4);
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
 * Paving, as a canvas.
 *
 * The walks were a flat `TOWN_PALETTE.paving` grey, and a 150 m path in one
 * colour is a ribbon of paint — the same objection the tarmac answers one
 * surface over. What makes paving read as paving is the joint: 128 px is one
 * square metre here, so the grid below is a 50 cm slab, four to the metre, with
 * a darker joint round each and a little variation slab to slab.
 */
function makePaving(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = 71;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    ctx.fillStyle = '#7d7a73';
    ctx.fillRect(0, 0, 128, 128);
    const n = 2;
    const cell = 128 / n;
    for (let x = 0; x < n; x++) {
      for (let z = 0; z < n; z++) {
        // Half-bonded, so the joints do not line up all the way across.
        const shift = (z % 2) * cell * 0.5;
        const g = 139 + Math.floor(rnd() * 16);
        ctx.fillStyle = `rgb(${g},${g - 3},${g - 9})`;
        ctx.fillRect(x * cell + shift + 1.6, z * cell + 1.6, cell - 3.2, cell - 3.2);
        if (shift) ctx.fillRect(x * cell + shift - cell + 1.6, z * cell + 1.6, cell - 3.2, cell - 3.2);
      }
    }
    // A little grain over the lot, so no two slabs are exactly one colour.
    for (let i = 0; i < 900; i++) {
      const g = 112 + Math.floor(rnd() * 34);
      ctx.fillStyle = `rgba(${g},${g},${g},0.35)`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 1.3, 1.3);
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
 * The grounds, as merged geometries and a list of places to plant.
 *
 * Merged rather than drawn as meshes for the reason the town gives at length:
 * the car park alone is eighty bay lines, and eighty meshes is more draw calls
 * than the rest of this island costs put together. Five surfaces, because they
 * are five materials — tarmac, paving, paint, kerb and sand.
 */
function buildGrounds(g: NonNullable<typeof SCHOOL_GROUNDS>) {
  const road: BufferGeometry[] = [];
  const paving: BufferGeometry[] = [];
  const mark: BufferGeometry[] = [];
  const kerb: BufferGeometry[] = [];

  const rect = (
    r: { acrossFrom: number; acrossTo: number; alongFrom: number; alongTo: number },
    into: BufferGeometry[],
  ) => into.push(slab(r.acrossFrom, r.acrossTo, r.alongFrom, r.alongTo, SURFACE));

  /*
   * Two yards and a plaza, and that is every square metre of surface here.
   *
   * Both yards have their own edge ON the avenue, so neither needs a drive out
   * to it — and the plaza runs from the gateway to the doors, so nothing needs
   * a path either. What went was four drives, a drop-off lane, a ring round
   * the site and two spurs across it, all of which read as roads through the
   * school from anywhere above head height.
   */
  rect(g.carPark, road);
  rect(g.busYard, road);

  /*
   * The floor: the plaza from the gateway to the school's front wall, the link
   * down the front of the lawn, and a spur to the play area and the workshop.
   *
   * Laid `plazaLift` over everything else, because the plaza's last sixteen
   * metres run over the campus's OWN deck and two surfaces at one height
   * z-fight. Fifteen millimetres is less than a paving joint and settles it.
   */
  paving.push(slab(
    g.plaza.acrossFrom, g.plaza.acrossTo, g.plaza.alongFrom, g.plaza.alongTo,
    SURFACE + GROUNDS.plazaLift,
  ));
  paving.push(slab(
    g.link.acrossFrom, g.link.acrossTo, g.link.alongFrom, g.link.alongTo,
    SURFACE + GROUNDS.plazaLift,
  ));
  for (const spur of g.spurs) {
    paving.push(slab(
      spur.acrossFrom, spur.acrossTo,
      spur.along - GROUNDS.spur / 2, spur.along + GROUNDS.spur / 2,
      SURFACE + GROUNDS.plazaLift,
    ));
  }

  /*
   * There is no painted crossing on the avenue, and there was one for a while.
   *
   * What the frontage was missing is not paint, it is a JUNCTION — the school's
   * entrance met a through road at nothing at all. That is now a `junctionT`
   * out of the road kit at the same `along` (`mouth` in `kestrelRoads`), and a
   * zebra laid across the middle of a junction is a zebra in the wrong place.
   */

  // Bay markings: the line BETWEEN two bays, not one down the middle of each.
  for (const m of g.marks) {
    mark.push(slab(m.acrossFrom, m.acrossTo, m.along - 0.06, m.along + 0.06, MARK, 0.01));
  }
  // The bus stand: an edge line down each side, and a division between buses.
  // What tells it from the car bays is that its lines run the other way.
  for (const edge of [g.stand.from + 0.3, g.stand.to - 0.3]) {
    mark.push(slab(
      edge - 0.08, edge + 0.08, g.busYard.alongFrom + 2, g.busYard.alongTo - 2, MARK, 0.01,
    ));
  }
  for (const bus of g.buses) {
    const at = bus.along - GROUNDS.busPitch / 2;
    mark.push(slab(g.stand.from + 0.3, g.stand.to - 0.3, at - 0.08, at + 0.08, MARK, 0.01));
  }

  // The planted islands in the car park, kerbed. Their tops carry no paint and
  // no tarmac: the planting sits on them and the kerb is what the eye reads.
  for (const island of g.islands) {
    kerb.push(slab(
      island.acrossFrom, island.acrossTo,
      island.along - GROUNDS.bayPitch / 2, island.along + GROUNDS.bayPitch / 2,
      SURFACE + KERB, KERB + SLAB,
    ));
  }

  /*
   * There is no bed along the building's frontage either.
   *
   * It was a 2.4 m strip of planting soil with a kerb round it and shrub clumps
   * standing in it, put there because the ground nearest the wall was the
   * emptiest on the site. Drawn, it read as a brown path running the length of
   * the façade — which is what a dark strip parallel to a building is, whatever
   * is planted in it. The lawn goes to the wall.
   */

  /*
   * The sand the play frame stands on: an ellipse, drawn as a fan.
   *
   * A disc rather than a rectangle, because sand is retained by a kerb and a
   * kerb round a play area is a curve — and because the one thing this lawn
   * needed was something in it that is not a rectangle. Its size is solved from
   * the frame in `SCHOOL_GROUNDS`; this only draws it, with a kerb ring round
   * the rim so the sand is held rather than spilt.
   */
  const STEPS = 48;
  const sandPos: number[] = [g.sand.across, SURFACE, g.sand.along];
  const sandIdx: number[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2;
    sandPos.push(
      g.sand.across + g.sand.radiusAcross * Math.cos(t),
      SURFACE,
      g.sand.along + g.sand.radiusAlong * Math.sin(t),
    );
    if (i) sandIdx.push(0, i + 1, i);
  }
  const sand = new BufferGeometry();
  sand.setAttribute('position', new Float32BufferAttribute(sandPos, 3));
  sand.setIndex(sandIdx);
  sand.computeVertexNormals();

  // The kerb ring: short straight kerbs chasing the same ellipse.
  for (let i = 0; i < STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2;
    const t1 = ((i + 1) / STEPS) * Math.PI * 2;
    const x0 = g.sand.across + g.sand.radiusAcross * Math.cos(t);
    const z0 = g.sand.along + g.sand.radiusAlong * Math.sin(t);
    const x1 = g.sand.across + g.sand.radiusAcross * Math.cos(t1);
    const z1 = g.sand.along + g.sand.radiusAlong * Math.sin(t1);
    const box = new BoxGeometry(Math.hypot(x1 - x0, z1 - z0) + 0.3, KERB + SLAB, 0.4);
    box.rotateY(Math.atan2(-(z1 - z0), x1 - x0));
    box.translate((x0 + x1) / 2, SURFACE + KERB - (KERB + SLAB) / 2, (z0 + z1) / 2);
    kerb.push(box);
  }

  return {
    road: merge(road, TARMAC_TILE),
    paving: merge(paving, PAVING_TILE),
    mark: merge(mark, 1),
    kerb: merge(kerb, 1),
    sand,
  };
}

/**
 * The gateway on the avenue: two piers, a semicircular arch and a name board.
 *
 * Built here rather than taken from a kit because no kit has one, and drawn as
 * a stack of boxes and voussoirs because that is how one is actually built.
 * What makes it read as an old school's gate rather than as two posts is
 * entirely proportion and profile: a plinth the pier stands on, a cornice it
 * stops at, a ring that springs from that cornice, an entablature over the
 * crown with the name on it, and a finial at each end.
 *
 * ## The arch
 *
 * Semicircular, so it rises half its span and the crown is at
 * `springing + opening / 2` — one number, not two that have to agree. The ring
 * is `ringSegments` voussoirs round it, each a box turned to stand radially:
 * the box's own +Y is sent to the radial direction by a rotation about X of
 * `π/2 − θ`, which is what puts a rectangle on a curve without a loft. They
 * overlap by a few per cent so there is no hairline between them.
 *
 * The frame here is the station's: local X is ACROSS, local Z is ALONG, so the
 * gateway is a wall in the (along, y) plane and the arch curves in it. That is
 * why the voussoirs turn about X and not about Y.
 *
 * Returned as two geometries because they are two materials — the stonework,
 * and the board with the lettering on it.
 */
function buildGate(g: NonNullable<typeof SCHOOL_GROUNDS>) {
  const G = GROUNDS.gate;
  const stone: BufferGeometry[] = [];
  const dressing: BufferGeometry[] = [];
  const at = g.gate.across;

  /**
   * A box of `size` centred on `[at, y, along]`, in the gateway's plane.
   *
   * `into` is which of the two stones it is cut from: the mass is the warm one
   * and everything that oversails or caps is the pale one, which is how a
   * building of this kind is actually built and the reason the mouldings read
   * from the far side of the avenue.
   */
  const block = (
    width: number, height: number, depth: number, y: number, along: number,
    into: BufferGeometry[] = stone,
  ) => {
    const box = new BoxGeometry(depth, height, width);
    box.translate(at, SURFACE + y + height / 2, along);
    into.push(box);
  };

  const half = G.opening / 2 + G.pier / 2;
  const crown = G.springing + G.opening / 2;
  const top = crown + G.ringDepth;

  for (const side of [-1, 1]) {
    const centre = g.gate.along + side * half;
    // Plinth, shaft, cornice: the three courses of a pier, each oversailing
    // or not as its name says.
    block(G.pier + G.plinthOver * 2, G.plinth, G.pier + G.plinthOver * 2, 0, centre, dressing);
    block(G.pier, G.springing - G.plinth, G.pier, G.plinth, centre);
    block(
      G.pier + G.corniceOver * 2, G.cornice, G.pier + G.corniceOver * 2,
      G.springing - G.cornice / 2, centre, dressing,
    );
    // And the pier carries on past the springing as the arch's abutment, up to
    // the entablature — otherwise the ring springs off thin air.
    block(G.pier, top - G.springing, G.pier, G.springing, centre);
  }

  /*
   * The ring. `θ` is measured from the springing on the +along side round to
   * the other, and `R` is to the middle of the ring's own thickness.
   */
  const R = G.opening / 2 + G.ringDepth / 2;
  const arc = (Math.PI * R) / G.ringSegments;
  for (let i = 0; i < G.ringSegments; i++) {
    const theta = (Math.PI * (i + 0.5)) / G.ringSegments;
    const voussoir = new BoxGeometry(G.ringWidth, G.ringDepth, arc * 1.06);
    voussoir.rotateX(Math.PI / 2 - theta);
    voussoir.translate(
      at,
      SURFACE + G.springing + R * Math.sin(theta),
      g.gate.along + R * Math.cos(theta),
    );
    stone.push(voussoir);
  }
  // The keystone, proud of the ring at the crown, which is the one place an
  // arch is allowed to show off.
  const key = new BoxGeometry(G.ringWidth + 0.24, G.ringDepth + 0.45, arc * 1.5);
  key.translate(at, SURFACE + G.springing + R + 0.12, g.gate.along);
  dressing.push(key);

  /*
   * The boundary wall, each way from the gateway to the yard that ends it.
   *
   * The same two stones: a low wall with a coping on it, which is what a gate
   * is a gap in. Without it the arch stood on a lawn with grass running past on
   * both sides, and an arch with nothing attached to it is a monument.
   */
  const W = GROUNDS.wall;
  for (const run of g.walls) {
    const length = run.alongTo - run.alongFrom;
    const centre = (run.alongFrom + run.alongTo) / 2;
    const body = new BoxGeometry(W.thickness, W.height, length);
    body.translate(at, SURFACE + W.height / 2, centre);
    stone.push(body);
    const coping = new BoxGeometry(W.thickness + W.copingOver * 2, W.coping, length);
    coping.translate(at, SURFACE + W.height + W.coping / 2, centre);
    dressing.push(coping);
  }

  // The entablature across the whole width, and a finial at each end of it.
  const span = G.opening + G.pier * 2;
  block(
    span + G.entablatureOver * 2, G.entablature, G.pier + G.entablatureOver, top,
    g.gate.along, dressing,
  );
  for (const side of [-1, 1]) {
    const centre = g.gate.along + side * (span / 2 + G.entablatureOver - 0.6);
    const finial = new ConeGeometry(0.62, G.finial, 4);
    finial.rotateY(Math.PI / 4);
    finial.translate(at, SURFACE + top + G.entablature + G.finial / 2, centre);
    dressing.push(finial);
  }

  /*
   * The board, on the entablature, facing both ways.
   *
   * One slab rather than two quads: it is 16 cm thick, the texture is on every
   * face and only the two big ones are ever seen, so the name reads from the
   * avenue and from the forecourt for the price of a box.
   */
  const board = new BoxGeometry(0.18, G.board, span * 0.72);
  board.translate(
    at, SURFACE + top + G.entablature + G.board / 2, g.gate.along,
  );

  return { stone: merge(stone, 1.2), dressing: merge(dressing, 1.2), board };
}


/**
 * The two things on this site that are neither ground nor kit: the court's
 * backboards and the flagpole at the head of the plaza.
 *
 * Both are a handful of boxes and a cylinder, which is all either of them is.
 * They are here rather than in the park kit because the park kit has no
 * basketball post and no flagpole, and because a school's front without a flag
 * on it is missing the one object that says which country it is in.
 */
function buildFittings(g: NonNullable<typeof SCHOOL_GROUNDS>) {
  const F = GROUNDS.flag;
  const steel: BufferGeometry[] = [];
  const white: BufferGeometry[] = [];
  const metal: BufferGeometry[] = [];
  const gilt: BufferGeometry[] = [];
  const base: BufferGeometry[] = [];

  // The flagpole, on the plaza's axis, `back` metres short of the building.
  const poleAt = g.plaza.acrossTo - F.back;
  const axis = (g.plaza.alongFrom + g.plaza.alongTo) / 2;
  const pole = new CylinderGeometry(F.radius * 0.7, F.radius, F.height, 12);
  pole.translate(poleAt, SURFACE + F.base.step * 2 + F.height / 2, axis);
  metal.push(pole);
  const truck = new SphereGeometry(F.radius * 2.1, 12, 9);
  truck.translate(poleAt, SURFACE + F.base.step * 2 + F.height + F.radius * 1.4, axis);
  gilt.push(truck);

  /*
   * And the base it stands on: two octagonal steps of the gate's pale stone.
   *
   * A pole coming straight out of paving is a pole somebody dropped. Two steps
   * is the least a flagpole has ever had under it, and being octagonal rather
   * than square they read as turned stone from any angle, which is what a
   * flagpole base is.
   */
  for (const [i, step] of [0, 1].entries()) {
    const r = F.base.radius - step * F.base.inset;
    const plinth = new CylinderGeometry(r, r + 0.04, F.base.step, 8);
    plinth.rotateY(Math.PI / 8);
    plinth.translate(poleAt, SURFACE + F.base.step * (i + 0.5), axis);
    base.push(plinth);
  }

  /*
   * The flag: a grid with a wave in it, not a quad.
   *
   * A flat rectangle on a pole reads as a sign somebody bolted on sideways. A
   * dozen columns with a sine displacement across them costs 44 triangles and
   * reads as cloth, and the wave grows from nothing at the hoist to its full
   * amplitude at the fly, because that is what a flag does.
   *
   * It hangs in the (along, y) plane, so the wave displaces in ACROSS. The UVs
   * run the cloth's own way — u along the fly, v down from the head.
   */
  const [cw, ch] = F.cloth;
  const N = 14;
  const M = 4;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    for (let j = 0; j <= M; j++) {
      const v = j / M;
      pos.push(
        poleAt + Math.sin(u * Math.PI * 2.2) * 0.34 * u * u,
        SURFACE + F.base.step * 2 + F.height - 0.55 - v * ch,
        axis + F.radius + u * cw,
      );
      uv.push(u, 1 - v);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a0 = i * (M + 1) + j;
      const b0 = a0 + (M + 1);
      idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  }
  const flag = new BufferGeometry();
  flag.setAttribute('position', new Float32BufferAttribute(pos, 3));
  flag.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  flag.setIndex(idx);
  flag.computeVertexNormals();

  return {
    steel: merge(steel, 1), white: merge(white, 1),
    pole: merge(metal, 1), truck: merge(gilt, 1), base: merge(base, 1), flag,
  };
}

/**
 * The school's flag: the name on a plain field, and nothing else on it.
 *
 * The same discipline as the name board — this map's signs are a colour, a thin
 * border and one name — with the one difference a flag earns, a band of the
 * school's second colour along the hoist so it still reads as a flag when the
 * cloth is edge on and the lettering has gone.
 */
function makeFlag(name: string): CanvasTexture {
  const W = 512;
  const H = 320;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#1d3f73';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#c79a5e';
    ctx.fillRect(0, 0, W * 0.16, H);
    ctx.strokeStyle = '#f2f4f7';
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.fillStyle = '#f2f4f7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = name.split(' ');
    let size = 74;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    while (lines.some((l) => ctx.measureText(l).width > W * 0.74) && size > 20) {
      size -= 3;
      ctx.font = `700 ${size}px system-ui, sans-serif`;
    }
    lines.forEach((l, i) => {
      ctx.fillText(l, W * 0.58, H / 2 + (i - (lines.length - 1) / 2) * size * 1.12);
    });
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * The name board's face: white on railway blue, and nothing else.
 *
 * The house style for signs on this map is plain and realistic — a coloured
 * board, a thin white border and one name on it. No subtitles, no badges, no
 * glow. The canvas is 8:1 because the board is, and the type is set to the
 * width it has rather than to a size somebody picked.
 */
function makeBoard(name: string): CanvasTexture {
  const W = 1024;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#1d3f73';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#f2f4f7';
    ctx.lineWidth = 4;
    ctx.strokeRect(9, 9, W - 18, H - 18);
    ctx.fillStyle = '#f2f4f7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 62;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(name).width > W - 90 && size > 18) {
      size -= 2;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
    }
    ctx.fillText(name, W / 2, H / 2 + 2);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Where the trees, benches, bins, lamps and the play frame go.
 *
 * Deterministic: one linear congruential generator seeded by hand, so the same
 * tree is the same tree every run and a screenshot taken today is the layout
 * tomorrow. Every other scatter on this island works the same way.
 */
function plant(g: NonNullable<typeof SCHOOL_GROUNDS>, site: NonNullable<typeof SCHOOL_SITE>) {
  let seed = 90210;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const placed: Array<{
    part: Part; across: number; along: number; turn: number; scale: number; y?: number;
  }> = [];
  const tree = (across: number, along: number, y = 0, kind?: Part) => placed.push({
    part: kind ?? (rnd() < 0.5 ? 'treeSlim' : 'treeTall'),
    across,
    along,
    turn: rnd() * Math.PI * 2,
    scale: 0.85 + rnd() * 0.35,
    y,
  });

  // One in every parking island, standing on its kerb.
  for (const island of g.islands) {
    tree((island.acrossFrom + island.acrossTo) / 2, island.along, KERB);
  }

  /*
   * The avenue down the plaza: two rows of trees from the gateway to the doors.
   *
   * This is the element the site was missing, and it is why everything else
   * could be taken away. An axis with trees down it is a place you walk; the
   * same ground with paths crossing it is a road layout. They stand ON the
   * plaza's edges, so the paving runs between them.
   */
  const P = GROUNDS.plazaTrees;
  const axis = (g.plaza.alongFrom + g.plaza.alongTo) / 2;
  let seat = 0;
  for (const side of [-1, 1]) {
    for (let across = g.plaza.acrossFrom + 9; across < g.plaza.acrossTo - 5; across += P.pitch) {
      /*
       * No planter under them, and there was one: the kit's `planter` is a flat
       * 4.3 m soil ring and on paving it read as a dark square pit round every
       * trunk. A tree standing in a plaza needs a hole in the paving, not a
       * tray laid on top of it — and the hole is what the eye supplies on its
       * own if nothing contradicts it.
       */
      placed.push({
        part: 'treeSlim',
        across,
        along: axis + side * P.offset,
        turn: rnd() * Math.PI * 2,
        scale: 0.95 + rnd() * 0.2,
      });
      /*
       * And between the trees, alternately, a bench facing the axis or a lamp:
       * a plaza with nothing to sit on is a forecourt you cross, and the point
       * of this one is that it is the way in.
       */
      const between = across + P.pitch / 2;
      if (between > g.plaza.acrossTo - 6) continue;
      if (seat % 2 === 0) {
        placed.push({
          part: 'bench',
          across: between,
          along: axis + side * (P.offset - 1.6),
          turn: side > 0 ? Math.PI / 2 : -Math.PI / 2,
          scale: 1,
        });
        placed.push({
          part: 'bin', across: between + 2.2, along: axis + side * (P.offset - 1.4), turn: 0, scale: 1,
        });
      } else {
        placed.push({ part: 'lamp', across: between, along: axis + side * P.offset, turn: 0, scale: 1 });
      }
      seat += 1;
    }
  }

  /*
   * A sign at the mouth of each yard, on the grass beside it.
   *
   * The kit's `sign` is a blank post-mounted board and that is all this needs:
   * what it does is tell you the two black rectangles on the avenue are the
   * school's and not a lay-by, which nothing else out here does.
   */
  for (const yard of [g.carPark, g.busYard]) {
    placed.push({
      part: 'sign',
      across: yard.acrossTo + 2.2,
      along: (yard.alongFrom + yard.alongTo) / 2,
      turn: -Math.PI / 2,
      scale: 1.3,
    });
  }

  // The grass either side of the plaza, between it and each yard: a line of
  // trees along the boundary, which is the only planting on the street edge now
  // the verge band has gone.
  for (const zone of [g.zones.park, g.zones.bus]) {
    for (let along = zone.from + 8; along < zone.to - 8; along += GROUNDS.treePitch * 2) {
      tree(g.bands.yardTo + 1.5, along + (rnd() - 0.5) * 2);
    }
  }

  /*
   * The play frame, on its sand, and nothing else inside the ring: sand with a
   * bench on it is a beach, and what the oval is for is that the frame has a
   * surface under it.
   *
   * A quarter turn, so the frame's 24 m side runs down the island, which is the
   * direction the lawn has room in.
   */
  placed.push({
    part: 'playground',
    across: g.play.across,
    along: g.play.along,
    turn: Math.PI / 2,
    scale: g.play.scale,
  });

  /*
   * The lawn: specimen trees and benches, kept out of the sand, off the court
   * and clear of the plaza.
   */
  const inSand = (across: number, along: number) => (
    ((across - g.sand.across) / (g.sand.radiusAcross + 4)) ** 2
    + ((along - g.sand.along) / (g.sand.radiusAlong + 4)) ** 2 < 1
  );
  const inRect = (
    r: { acrossFrom: number; acrossTo: number; alongFrom: number; alongTo: number },
    across: number, along: number, pad: number,
  ) => (
    across > r.acrossFrom - pad && across < r.acrossTo + pad
    && along > r.alongFrom - pad && along < r.alongTo + pad
  );
  const inWorkshop = (across: number, along: number, pad: number) => !!g.workshop && (
    Math.abs(across - g.workshop.across) < g.workshop.footprint[0] / 2 + pad
    && Math.abs(along - g.workshop.along) < g.workshop.footprint[1] / 2 + pad
  );
  const lawnMid = (g.lawn.acrossFrom + g.lawn.acrossTo) / 2;
  for (let along = g.lawn.alongFrom + 6; along < g.lawn.alongTo - 6;
    along += GROUNDS.greenTreePitch) {
    const across = lawnMid + (rnd() - 0.5) * 8;
    const at = along + (rnd() - 0.5) * 4;
    if (inSand(across, at) || inWorkshop(across, at, 7)) continue;
    if (inRect(g.plaza, across, at, 4)) continue;
    tree(across, at, 0, rnd() < 0.5 ? 'treeBroad' : 'treeBig');
  }
  for (let along = g.lawn.alongFrom + 12; along < g.lawn.alongTo - 12;
    along += GROUNDS.benchPitch) {
    const across = g.lawn.acrossFrom + 2.6;
    if (inSand(across, along) || inWorkshop(across, along, 6)) continue;
    if (inRect(g.plaza, across, along, 3)) continue;
    // Facing the building, which is +across from here.
    placed.push({ part: 'bench', across, along, turn: -Math.PI / 2, scale: 1 });
    placed.push({ part: 'bin', across, along: along + 2.4, turn: 0, scale: 1 });
  }

  // A line of bigger trees along the back, between the playing fields and the
  // dock road, which is the one place on this site a big tree cannot shade a
  // pitch or stand in a sightline.
  for (let along = site.alongFrom + 6; along < site.alongTo - 6; along += 16) {
    tree(
      (site.back + SCHOOL_BLOCK.acrossTo) / 2 + (rnd() - 0.5) * 2,
      along + (rnd() - 0.5) * 3,
      0,
      'treeBroad',
    );
  }

  // Lamp columns down the car park's lane and along the bus yard. Those are the
  // two parts of these grounds anybody crosses in the dark.
  for (let along = g.carPark.alongFrom + 8; along < g.carPark.alongTo - 8;
    along += GROUNDS.lampPitch) {
    placed.push({ part: 'lamp', across: g.aisle, along, turn: 0, scale: 1 });
  }
  for (let along = g.busYard.alongFrom + 8; along < g.busYard.alongTo - 8;
    along += GROUNDS.lampPitch) {
    placed.push({ part: 'lamp', across: g.busYard.acrossFrom + 2, along, turn: 0, scale: 1 });
  }
  return placed;
}

/**
 * Which bays have a car in them.
 *
 * `GROUNDS.occupancy` of them, chosen by the same deterministic generator. Not
 * all of them: a full car park reads as a showroom, and the gaps are most of
 * what says the markings are bays rather than a pattern.
 */
function parkCars(g: NonNullable<typeof SCHOOL_GROUNDS>): CarSlot[] {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  return g.bays.filter(() => rnd() < GROUNDS.occupancy);
}


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
      p.set(a.across, (a.y ?? 0) + SURFACE, a.along);
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

/**
 * St. Anjali High School, in the superblock at the west end of the grid.
 *
 * Where it is and why it is a superblock is in `kestrelSchool`; what the grid
 * gave up for it is in `CROSSES`. This is the placing, and the grounds.
 *
 * ## How it sits on the ground
 *
 * The campus is a single flat deck — lot, paths, track and outfield all on one
 * slab — and the island's crown under it is flat too, so there is no shaping to
 * do. It is lifted by `ROAD_TOP`, the same 72 mm the road kit's slabs stand
 * over the crown, for the same reason: two coplanar surfaces z-fight, and the
 * campus meeting the streets at exactly the height they are is the tidiest
 * answer there is. The slab's own skirt reaches 1.3 m below its deck
 * (`SCHOOL.skirt`), so the lift buries itself rather than leaving a step at the
 * kerb.
 *
 * ## The grounds
 *
 * The model is 107 m deep in a 167 m block, and the 60 m left over used to be
 * plain lawn either side of it. The campus is now pushed to the back and the
 * whole of that slack is frontage: a footway and a hedge on the avenue, two
 * hundred parking bays in two double-loaded modules with planted islands down
 * them, two drives in off the street, and a paved apron between the lot and the
 * school. `SCHOOL_GROUNDS` solves all of it off the campus's own front edge.
 *
 * ## What is solid
 *
 * The building, the stand behind the track and the backstop behind the plate —
 * measured by `prepare-colliders.mjs` and placed by `partColliders`, which is
 * what keeps the parking lot, the drives and the field **drivable**. A campus
 * you can only look at from the road is a texture; one you can drive into is
 * somewhere to go, and that was the argument for building it at all.
 *
 * Nothing else here is a collider. The surfaces are 60 mm slabs and a wheel
 * rides the island crown, exactly as it does on every street round them; the
 * trees and the parked cars are scenery, which is the airfield's convention,
 * Skylark's and the town's — a tree you can drive through is wrong and three
 * hundred rigid bodies in a car park is worse.
 */
export function KestrelSchool() {
  const site = STATION_SITE;
  const school = SCHOOL_SITE;
  const grounds = SCHOOL_GROUNDS;
  const { scene } = useGLTF(SCHOOL.model, DRACO_PATH);
  const { scene: parkScene } = useGLTF(PARK_MODEL, DRACO_PATH);
  const { scene: workshopScene } = useGLTF(WORKSHOP.model, DRACO_PATH);

  /**
   * Cloned, for the reason every prop on this island clones: drei caches one
   * scene per URL, and re-parenting it into this group takes it away from
   * anything else asking for the same file — including this component's own
   * next mount after a hot reload.
   */
  const campus = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return copy;
  }, [scene]);

  const kit = useMemo(() => {
    const out = new Map<Part, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of PARTS) {
      const node = parkScene.getObjectByName(name);
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
  }, [parkScene]);

  /**
   * The workshop, cloned for the reason every prop on this island clones: drei
   * caches one scene per URL, and re-parenting it into this group takes it away
   * from anything else asking for the same file.
   */
  const workshop = useMemo(() => {
    const copy = (workshopScene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return copy;
  }, [workshopScene]);

  const built = useMemo(() => (grounds ? buildGrounds(grounds) : null), [grounds]);
  const gate = useMemo(() => (grounds ? buildGate(grounds) : null), [grounds]);
  const fittings = useMemo(() => (grounds ? buildFittings(grounds) : null), [grounds]);
  const planted = useMemo(
    () => (grounds && school ? plant(grounds, school) : []),
    [grounds, school],
  );
  const cars = useMemo(() => (grounds ? parkCars(grounds) : []), [grounds]);

  const byPart = useMemo(() => {
    const groups = new Map<Part, typeof planted>();
    for (const p of planted) {
      if (!groups.has(p.part)) groups.set(p.part, []);
      groups.get(p.part)!.push(p);
    }
    return groups;
  }, [planted]);

  const materials = useMemo(() => ({
    tarmac: new MeshStandardMaterial({ map: makeTarmac(), roughness: 0.95 }),
    paving: new MeshStandardMaterial({ map: makePaving(), roughness: 0.9 }),
    mark: new MeshStandardMaterial({ color: TOWN_PALETTE.mark, roughness: 0.8 }),
    kerb: new MeshStandardMaterial({ color: TOWN_PALETTE.kerb, roughness: 0.9 }),
    /* Play sand: the colour of the airport island's own beaches, so the two
       pieces of sand in this world are one substance. */
    sand: new MeshStandardMaterial({ color: '#c9b083', roughness: 1 }),
    /*
     * The gateway, in the school's OWN two stones — measured, not chosen.
     *
     * It was honey sandstone and cream, which looked well enough on its own and
     * wrong next to the building: a gate belongs to the thing behind it. These
     * two are sampled out of `american_high_school.glb`'s atlas — the wall
     * block at `#6b604f` and the pale panel at `#938d87` — so the gateway's
     * albedo is the building's albedo and the two are lit as one material. A
     * gate cut from a different stone from its school is a gate somebody moved
     * there.
     *
     * The mass takes the wall and the dressings take the panel, which is also
     * how the building itself is put together.
     */
    stone: new MeshStandardMaterial({ color: '#6b604f', roughness: 0.85 }),
    dressing: new MeshStandardMaterial({ color: '#938d87', roughness: 0.8 }),
    steel: new MeshStandardMaterial({ color: '#4a5056', roughness: 0.5, metalness: 0.55 }),
    /*
     * The flagpole, and the one place on this site that is allowed to gleam.
     *
     * Brushed aluminium was grey against a grey plaza and disappeared. A
     * flagpole is white — painted, not bare metal — and the ball on top of it
     * is gilt, which is the whole reason you can see where a flagpole is from
     * the other end of a street. The base takes a dark granite rather than the
     * gate's pale stone, so the pole stands on something instead of fading into
     * the paving it rises out of.
     */
    pole: new MeshStandardMaterial({ color: '#f4f6f7', roughness: 0.28, metalness: 0.15 }),
    truck: new MeshStandardMaterial({ color: '#c9a227', roughness: 0.3, metalness: 0.85 }),
    plinth: new MeshStandardMaterial({ color: '#4e535a', roughness: 0.55, metalness: 0.08 }),
    white: new MeshStandardMaterial({ color: '#eceae3', roughness: 0.6 }),
    flag: new MeshStandardMaterial({
      map: makeFlag(SCHOOL_NAME.replace(' HIGH SCHOOL', '')),
      roughness: 0.85,
      side: DoubleSide,
    }),
    board: new MeshStandardMaterial({ map: makeBoard(SCHOOL_NAME), roughness: 0.6 }),
  }), []);

  useEffect(() => () => {
    materials.tarmac.map?.dispose();
    materials.paving.map?.dispose();
    materials.board.map?.dispose();
    materials.flag.map?.dispose();
    for (const m of Object.values(materials)) m.dispose();
  }, [materials]);

  useEffect(() => {
    if (!built && !gate && !fittings) return;
    return () => {
      for (const g of Object.values(built ?? {})) g?.dispose();
      for (const g of Object.values(gate ?? {})) g?.dispose();
      for (const g of Object.values(fittings ?? {})) g?.dispose();
    };
  }, [built, gate, fittings]);

  useEffect(() => {
    if (!school || !grounds) return;
    const trees = planted.filter((p) => p.part.startsWith('tree')).length;
    console.info(`[school] St. Anjali High School in a ${school.block[0].toFixed(0)} x `
      + `${school.block[1].toFixed(0)} m superblock: campus `
      + `${(SCHOOL.size[0] * school.scale).toFixed(0)} x `
      + `${(SCHOOL.size[2] * school.scale).toFixed(0)} m at ${(school.scale * 100).toFixed(0)}%, `
      + `${school.verge.toFixed(1)} m verge along, ${GROUNDS.back} m behind; frontage `
      + `${(school.front - SCHOOL_BLOCK.acrossFrom).toFixed(0)} m deep in three yards — `
      + `${grounds.bays.length} bays (${cars.length} taken) and `
      + `${grounds.islands.length} islands, a drop-off, `
      + `${grounds.buses.length} buses and ${grounds.appliance.length} appliance; `
      + (grounds.workshop
        ? `a ${grounds.workshop.footprint.map((v) => v.toFixed(0)).join(' x ')} m workshop `
          + `at ${(grounds.workshop.scale * 100).toFixed(0)}%; `
        : 'no room for the workshop; ')

      + `${(grounds.bands.lawnTo - grounds.bands.lawnFrom).toFixed(1)} m of lawn with a `
      + `${(grounds.sand.radiusAlong * 2).toFixed(0)} x `
      + `${(grounds.sand.radiusAcross * 2).toFixed(0)} m sand oval in it; `
      + `${trees} trees; ${SCHOOL.triangles.toLocaleString()} tris`);
  }, [school, grounds, planted, cars]);

  if (!site || !school || !grounds || !built) return null;

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      <group
        position={[school.across, SURFACE, school.along]}
        rotation={[0, school.turn, 0]}
        scale={school.scale}
      >
        <primitive object={campus} />
      </group>

      {built.road && <mesh geometry={built.road} material={materials.tarmac} receiveShadow />}
      {built.paving && <mesh geometry={built.paving} material={materials.paving} receiveShadow />}
      {built.mark && <mesh geometry={built.mark} material={materials.mark} />}
      {built.kerb && <mesh geometry={built.kerb} material={materials.kerb} receiveShadow />}
      <mesh geometry={built.sand} material={materials.sand} receiveShadow />

      {/* The gateway on the avenue. No railings either side of it: a fence
          along a school's boundary is a compound, and this island has none. */}
      {gate?.stone && (
        <mesh geometry={gate.stone} material={materials.stone} castShadow receiveShadow />
      )}
      {gate?.dressing && (
        <mesh geometry={gate.dressing} material={materials.dressing} castShadow receiveShadow />
      )}
      {gate && <mesh geometry={gate.board} material={materials.board} castShadow />}

      {/* The court's posts and boards, and the flagpole on the plaza. */}
      {fittings?.steel && (
        <mesh geometry={fittings.steel} material={materials.steel} castShadow />
      )}
      {fittings?.white && (
        <mesh geometry={fittings.white} material={materials.white} castShadow />
      )}
      {fittings?.pole && (
        <mesh geometry={fittings.pole} material={materials.pole} castShadow />
      )}
      {fittings?.truck && (
        <mesh geometry={fittings.truck} material={materials.truck} castShadow />
      )}
      {fittings?.base && (
        <mesh geometry={fittings.base} material={materials.plinth} castShadow receiveShadow />
      )}
      {fittings && <mesh geometry={fittings.flag} material={materials.flag} castShadow />}

      {[...byPart].map(([part, at]) => (
        kit.get(part)?.map((pair, i) => (
          <Instanced
            key={`${part}${i}`}
            geometry={pair.geometry}
            material={pair.material}
            at={at}
            castShadow={part !== 'bin' && !part.startsWith('bush')}
          />
        ))
      ))}

      <ParkedCars slots={cars} kinds={TOWN_PARKED} y={SURFACE} />
      {/* The buses and the school's own vehicles, from the same catalogue as
          the cars: `school_bus`, and the service kinds `Traffic` already
          ships, standing still. */}
      <ParkedCars slots={grounds.buses} kinds={SCHOOL_BUSES} y={SURFACE} />
      <ParkedCars slots={grounds.appliance} kinds={SCHOOL_APPLIANCE} y={SURFACE} />

      {/* The workshop block, in the east lawn — see `GROUNDS.workshop`. */}
      {grounds.workshop && (
        <group
          position={[grounds.workshop.across, SURFACE, grounds.workshop.along]}
          rotation={[0, grounds.workshop.turn, 0]}
          scale={grounds.workshop.scale}
        >
          <primitive object={workshop} />
        </group>
      )}

      <RigidBody type="fixed" colliders={false}>
        {/* The workshop is solid the way the airport's buildings are: boxes
            measured off the geometry, not a box round the bounds. */}
        {grounds.workshop && partColliders(
          'workshop',
          grounds.workshop.across,
          grounds.workshop.along,
          grounds.workshop.turn,
          WORKSHOP.size,
          'workshop',
          grounds.workshop.scale,
        )}
        {partColliders(
          'school',
          school.across,
          school.along,
          school.turn,
          SCHOOL.size,
          'school',
          school.scale,
        )}
      </RigidBody>
    </group>
  );
}
