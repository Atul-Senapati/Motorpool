'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CuboidCollider, RigidBody, TrimeshCollider, useBeforePhysicsStep,
  type RapierRigidBody,
} from '@react-three/rapier';
import {
  AdditiveBlending, BackSide, BufferGeometry, CanvasTexture, DoubleSide, Euler, ExtrudeGeometry,
  Float32BufferAttribute, InstancedMesh, Matrix4, Object3D, Path, Quaternion, RepeatWrapping,
  Shape, SRGBColorSpace, Vector3,
} from 'three';
import { CITY_NAV_IMAGE, DRACO_PATH } from '@/config/cityConfig';
import { getNav, groundHeightAt, loadCityNav } from '@/physics/cityNav';
import { TOWN_PALETTE } from '@/config/townConfig';
import { pairCentreAt } from '@/config/trackPair';
import {
  BALLAST, CUTTING, RAIL_HEAD_LIFT, RAIL_SETS_ALL, RAIL_SET_IDS,
  SERVICE_CARRIAGES, TRAIN, serviceFormationFor, type RailSetId,
  TRAIN_LENGTH, TUNNEL, VIADUCT,
  locomotivePose, trainNormalAt, trainPointAt, trainSpeedLimitAt, trainTangentAt,
  trainWrap, TRAIN_ISLANDS, TRAIN_POINTS, trainDarknessAt,
} from '@/config/trainConfig';
import { SELECTED } from '@/config/garage';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { RAIL_STEEL, buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import {
  LINING_MATERIAL, LINING_PROFILE, LINING_STEP, WALKWAY_HEIGHT, WALKWAY_WIDTH,
  makeGlowTexture, makeLampTexture, makeLiningTexture,
} from './boreProfile';
import { Headlamps } from './Headlamps';
import { Lineside } from './Lineside';
import { TrussBridge } from './TrussBridge';
import { SuspensionBridge } from './SuspensionBridge';
import { SLEEPER_GEOMETRY, SLEEPER_MATERIAL } from './sleeper';
import { InstancedField } from './instancedField';
import { ShadowProxy } from './shadowProxy';
import { reportTrain, forgetTrain, playerTrain } from '@/physics/trainRegistry';
import { DOWN, UP, ahead } from '@/config/pointwork';
import { playerRoad, runsAlongArc } from '@/config/railSpawn';
import {
  doubleTrackAt, secondTrackGap, stationYardAt, undergroundStationAt,
} from '@/config/stationConfig';

// Both sets, because the services run both classes — see `SERVICE_STOCK`.
for (const id of RAIL_SET_IDS) {
  useGLTF.preload(RAIL_SETS_ALL[id].loco.model, DRACO_PATH);
  useGLTF.preload(RAIL_SETS_ALL[id].coach.model, DRACO_PATH);
}

/** Geometry sampling pitch along the line, metres. */
const STEP = LINING_STEP;
/** Arc-length metres per texture repeat. No maps are bound; this shapes UVs. */
const V_SCALE = 9;

interface Rail extends LoftSample {
  /** Height of the rail head over the ground under it. Negative in a cutting. */
  fill: number;
  structure: number;
  /** Inside a bore, or inside a gallery joining two of them. */
  enclosed: boolean;
  /** Standing on reclaimed causeway rather than on the map's own ground. */
  made: boolean;
  /**
   * Wants the trench pieces — floor, walls, coping — built here.
   *
   * Wider than `structure === CUTTING`, because the terrain carve is wider than
   * the cutting: the shader overruns each segment by `2.5 m` so consecutive
   * chords meet on a curve, and the chords themselves are drawn between
   * simplified chain ends rather than between route points. So the ground was
   * gone for a few metres either side of every cutting while the geometry that
   * replaces it stopped dead at the structure boundary — which is the hole
   * under the ballast on the approach to a portal.
   *
   * Only carried into neighbours that are themselves below ground (`fill < 0`).
   * On an embankment the ground is *under* the rail, nothing was carved, and a
   * floor slab laid there would hang in the air beside the ballast.
   */
  trench: boolean;
  /**
   * Ground at the top of each cutting wall, left and right, relative to the
   * rail head (positive = above it). NOT the centreline ground.
   *
   * The walls stand 5.5-7 m out from the rail, and on a hillside the ground
   * there is not the ground under the track: with cross-slope one side is
   * higher and the other lower. Built to the centreline height, the uphill
   * wall stopped short of the carved face and left a band of raw terrain
   * showing above it, while the downhill wall stood proud with its coping
   * hanging in the air — grey slabs at odd heights with wedges of grass
   * between them, on a cutting whose alignment data was perfectly clean.
   * Sampled from the nav raster where it is loaded; the centreline is the
   * fallback until then.
   */
  groundL: number;
  groundR: number;
  /** Over a street inside a drawn elevated span. */
  street: boolean;
  /** On the double-track stretch — the second track and the wide deck go here. */
  double: boolean;
  /** The second track's offset left of the running line, metres. */
  gap: number;
  /**
   * Inside the underground station's hall. The lining and its lights stop here
   * and `UndergroundStation` takes over, easing from the bore's own section.
   */
  cavern: boolean;
  /** Inside the island station's own ballast formation — see `stationYardAt`. */
  yard: boolean;
  /** On the steel truss bridge between the islands — see `TrussBridge`. */
  truss: boolean;
  /** On the suspension bridge from the small island to the city — see `SuspensionBridge`. */
  suspension: boolean;
}

/**
 * The line, resampled at a uniform pitch.
 *
 * The route file is already dense and already at a uniform 6 m, but every
 * piece of geometry below wants the same samples at the same pitch, and the
 * fields that are not interpolable — structure, ground — have to be looked up
 * per sample anyway. One pass here, shared by everything.
 */
function sampleLine(): Rail[] {
  const count = Math.round(TRAIN_LENGTH / STEP);
  const samples: Rail[] = [];
  for (let i = 0; i <= count; i++) {
    const arc = (i / count) * TRAIN_LENGTH;
    const [x, y, z] = trainPointAt(arc);
    const [nx, nz] = trainNormalAt(arc);
    // Nearest route point carries the things that are not interpolable: which
    // structure this is, and the ground under it.
    const source = TRAIN_POINTS[
      Math.min(TRAIN_POINTS.length - 1, Math.round((arc / TRAIN_LENGTH) * TRAIN_POINTS.length))
      % TRAIN_POINTS.length
    ];
    const head = y + RAIL_HEAD_LIFT;
    const centre = source.ground - head;
    // Where the wall top will be, laterally, if the ground is where the
    // centreline says. Close enough to pick the sample point.
    const reach = TRAIN.cuttingHalf
      + TRAIN.cuttingBatter * Math.max(0, centre - (-RAIL_HEAD_LIFT - 0.4));
    const pairMid = doubleTrackAt(arc) ? secondTrackGap(arc) / 2 : 0;
    const sideGround = (side: number) => {
      if (!getNav()) return centre;
      const off = pairMid + reach * side;
      const g = groundHeightAt(x + nx * off, z + nz * off);
      return g === null ? centre : g - head;
    };
    samples.push({
      x, z, nx, nz, arc,
      y: head,
      fill: y - source.ground,
      groundL: sideGround(-1),
      groundR: sideGround(1),
      structure: source.structure,
      enclosed: source.enclosed,
      made: source.made,
      trench: source.structure === CUTTING,
      street: source.street,
      double: doubleTrackAt(arc),
      gap: secondTrackGap(arc),
      cavern: undergroundStationAt(arc),
      yard: stationYardAt(arc),
      truss: false,
      suspension: false,
    });
  }
  // Grow the trench into whatever is next to it, while that is still below
  // ground. See `Rail.trench`.
  const TRENCH_REACH = 4;
  const seed = samples.map((s) => s.structure === CUTTING);
  for (let i = 0; i < samples.length; i++) {
    if (seed[i]) continue;
    if (samples[i].fill >= 0) continue;
    for (let k = -TRENCH_REACH; k <= TRENCH_REACH; k++) {
      if (seed[(i + k + samples.length) % samples.length]) { samples[i].trench = true; break; }
    }
  }
  // The bridges are steel, not concrete: a viaduct run whose ground at BOTH
  // ends is an island gets the through-truss (`TrussBridge`); the run from the
  // SMALLER island to ground that is no island gets the suspension bridge
  // (`SuspensionBridge`). Both lose the box deck and its pillars.
  // Which island a point is on, if any.
  const islandAt = (x: number, z: number) => TRAIN_ISLANDS.findIndex((island) => {
    const o = island.outline;
    let inside = false;
    for (let a = 0, b = o.length - 1; a < o.length; b = a++) {
      const [ax, az] = o[a];
      const [bx, bz] = o[b];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
    }
    return inside;
  });
  // The smaller island by outline area: the suspension bridge is its link to the city.
  const area = (o: ReadonlyArray<[number, number]>) => Math.abs(o.reduce((sum, [x, z], i) => {
    const [nx, nz] = o[(i + 1) % o.length];
    return sum + x * nz - nx * z;
  }, 0)) / 2;
  let small = -1;
  TRAIN_ISLANDS.forEach((island, i) => { if (small < 0 || area(island.outline) < area(TRAIN_ISLANDS[small].outline)) small = i; });
  for (const [from, to] of runsWhere(samples, (r) => r.structure === VIADUCT && !r.enclosed)) {
    const before = samples[(from - 2 + samples.length) % samples.length];
    const after = samples[(to + 2) % samples.length];
    const a = islandAt(before.x, before.z);
    const b = islandAt(after.x, after.z);
    if (a >= 0 && b >= 0) {
      for (let k = from; k <= to; k++) samples[k].truss = true;
    } else if ((a === small && b < 0) || (b === small && a < 0)) {
      for (let k = from; k <= to; k++) samples[k].suspension = true;
    }
  }
  return samples;
}

// Heights of everything, measured down from the rail head — which is what
// `Rail.y` is, and what the route was graded to.
const SLEEPER_TOP = -TRAIN.railHeight;
const SLEEPER_BOTTOM = SLEEPER_TOP - TRAIN.sleeperHeight;
const DECK_TOP = SLEEPER_BOTTOM;
const DECK_BOTTOM = DECK_TOP - TRAIN.deckThickness;
const PARAPET_TOP = DECK_TOP + TRAIN.parapetHeight;
/** Top of the tunnel invert — the slab the ballast sits in. */
const INVERT = SLEEPER_BOTTOM - TRAIN.boreFloorDrop;

/**
 * Ballast, as a trapezium from the crown out to the toe.
 *
 * The drop to the toe is the fill under the sample plus the ballast's own
 * depth, so the bank grows as the ground falls away and the section is the same
 * shape whether it is carrying the line 20 cm or 3 m. In a shallow cutting the
 * fill is negative and the arithmetic would invert the trapezium, so the drop
 * has a floor: there is always at least a shoulder of ballast showing.
 *
 * It stops at the tunnel mouth. Inside is slab track: the sleepers bed straight
 * onto the invert, which is what `boreFloorDrop` leaves room for.
 */
const ballastDrop = (s: Rail) => Math.max(0.15, TRAIN.ballastDepth + s.fill);
const ballastToe = (s: Rail) => TRAIN.ballastCrownHalf + TRAIN.ballastSlope * ballastDrop(s);

const BALLAST_PROFILE = [
  { off: (s: Rail) => -ballastToe(s), rise: (s: Rail) => SLEEPER_BOTTOM - ballastDrop(s) },
  { off: -TRAIN.ballastCrownHalf, rise: SLEEPER_BOTTOM },
  { off: TRAIN.ballastCrownHalf, rise: SLEEPER_BOTTOM },
  { off: (s: Rail) => ballastToe(s), rise: (s: Rail) => SLEEPER_BOTTOM - ballastDrop(s) },
];

/** Deck: a box with a parapet up each side, so the section is a U on a slab. */
const DECK_PROFILE = [
  { off: -TRAIN.deckHalf, rise: PARAPET_TOP },
  { off: -TRAIN.deckHalf + TRAIN.parapetWidth, rise: PARAPET_TOP },
  { off: -TRAIN.deckHalf + TRAIN.parapetWidth, rise: DECK_TOP },
  { off: TRAIN.deckHalf - TRAIN.parapetWidth, rise: DECK_TOP },
  { off: TRAIN.deckHalf - TRAIN.parapetWidth, rise: PARAPET_TOP },
  { off: TRAIN.deckHalf, rise: PARAPET_TOP },
  { off: TRAIN.deckHalf, rise: DECK_BOTTOM },
  { off: -TRAIN.deckHalf, rise: DECK_BOTTOM },
];

/**
 * The elevated line's deck: a concrete box girder, fixed width, two tracks.
 *
 * Centred on the midpoint between the running line and the second track, so
 * both sit symmetrically on it, and the same width everywhere — which is what
 * makes its edges straight. The first version read its width off the kerbs of
 * the street beneath, sample by sample, and a measurement that noisy drew a
 * deck edge that wandered; a viaduct is a manufactured thing and its edge is a
 * line. The soffit is chamfered so it reads as a girder rather than a slab, and
 * a low parapet kerb runs along each edge. Closed, so the underside is drawn:
 * this is seen from directly beneath by anyone driving down the street.
 *
 * The midpoint is per sample because the gap is not constant: the second track
 * fans out from 4.6 m to road 1's 12.4 m through the island station and back
 * again — see `secondTrackGap`.
 */
const EL = TRAIN.elevated;
const mid = (s: Rail) => s.gap / 2;
/**
 * Where the railway's middle is, relative to the running line — half the gap
 * where there are two tracks, nothing where there is one. Everything that has
 * to contain BOTH tracks (bore, lights, cutting, portal, gallery) is centred on
 * this rather than on the running line, and so is the terrain carve in
 * `CityMap`, through the same `pairCentreAt`. See `trackPair.ts`.
 */
const midOf = (s: Rail) => (s.double ? s.gap / 2 : 0);
const WIDE_DECK_PROFILE: ProfileVertex<Rail>[] = [
  { off: (s) => mid(s) - EL.deckHalf, rise: DECK_TOP + EL.parapetHeight },
  { off: (s) => mid(s) - EL.deckHalf + EL.parapetWidth, rise: DECK_TOP + EL.parapetHeight },
  { off: (s) => mid(s) - EL.deckHalf + EL.parapetWidth, rise: DECK_TOP },
  { off: (s) => mid(s) + EL.deckHalf - EL.parapetWidth, rise: DECK_TOP },
  { off: (s) => mid(s) + EL.deckHalf - EL.parapetWidth, rise: DECK_TOP + EL.parapetHeight },
  { off: (s) => mid(s) + EL.deckHalf, rise: DECK_TOP + EL.parapetHeight },
  { off: (s) => mid(s) + EL.deckHalf, rise: DECK_TOP - EL.deckDepth + EL.chamfer },
  { off: (s) => mid(s) + EL.deckHalf - EL.chamfer, rise: DECK_TOP - EL.deckDepth },
  { off: (s) => mid(s) - EL.deckHalf + EL.chamfer, rise: DECK_TOP - EL.deckDepth },
  { off: (s) => mid(s) - EL.deckHalf, rise: DECK_TOP - EL.deckDepth + EL.chamfer },
];

/** A profile shifted sideways by a per-sample amount: the second track's. */
function shifted(profile: ProfileVertex<Rail>[], by: (s: Rail) => number): ProfileVertex<Rail>[] {
  return profile.map((v) => ({
    off: (s: Rail) => (typeof v.off === 'function' ? v.off(s) : v.off) + by(s),
    rise: v.rise,
  }));
}

/** One rail: a box section, four faces, standing on the sleepers. */
/**
 * A flat-bottom rail: head, web and foot, as a closed section. Head 72 mm
 * wide and 50 deep, web 20, foot 150 wide and 30 deep — near enough a 113A —
 * so from the cab or the platform the rail reads as a rail and not a bar, and
 * the light catches the head and the foot differently.
 */
const railProfile = (centre: number) => {
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

/**
 * Concrete cable troughing along the running line's right-hand cess: the
 * lidded concrete channel every electrified railway has, on the ground and
 * on the deck alike, which is most of what makes a cess read as a cess.
 */
const TROUGH_OFF = -(TRAIN.ballastCrownHalf + 0.55);
const TROUGH_PROFILE = [
  { off: TROUGH_OFF - 0.22, rise: SLEEPER_BOTTOM - 0.05 },
  { off: TROUGH_OFF + 0.22, rise: SLEEPER_BOTTOM - 0.05 },
  { off: TROUGH_OFF + 0.22, rise: SLEEPER_BOTTOM + 0.25 },
  { off: TROUGH_OFF + 0.16, rise: SLEEPER_BOTTOM + 0.27 },
  { off: TROUGH_OFF - 0.16, rise: SLEEPER_BOTTOM + 0.27 },
  { off: TROUGH_OFF - 0.22, rise: SLEEPER_BOTTOM + 0.25 },
];

/**
 * The tunnel lining: a horseshoe with its invert, as one closed section.
 *
 * Floor a little under the sleepers, vertical walls to `boreWall`, and a
 * semicircular arch over them. Rendered from the inside — `BackSide` — so from
 * within the bore it is a continuous concrete tube, and from outside it draws
 * nothing at all: the hill is what you see there, with a horseshoe cut out of
 * it by `CityMap` exactly where this profile runs. The two agree because both
 * are built from `TRAIN.boreHalf` and `TRAIN.boreWall`.
 */

/**
 * The gallery deck: the bridge deck with its parapets left off.
 *
 * Where a gallery carries the line across a gap the shell *is* the parapet, and
 * the ordinary deck's walls would stand up through the lining's floor — they
 * reach higher than the invert and are only 3.1 m out, well inside a 5 m bore.
 */
const GALLERY_DECK_PROFILE = [
  // Its top sits just under the lining's invert, so the invert is the floor
  // everywhere inside an enclosed stretch and the deck's own pale concrete
  // never shows as a stripe down the middle of it.
  { off: -TRAIN.deckHalf, rise: INVERT - 0.02 },
  { off: TRAIN.deckHalf, rise: INVERT - 0.02 },
  { off: TRAIN.deckHalf, rise: DECK_BOTTOM },
  { off: -TRAIN.deckHalf, rise: DECK_BOTTOM },
];

/**
 * The gallery shell: the lining's horseshoe again, half a metre larger, drawn
 * from the *outside*.
 *
 * Only over the gap between two bores. Inside a bore the hill is the outside
 * and there is nothing to draw; here there is no hill, so without this the
 * lining would be a one-sided surface and the gallery would read as open sky
 * from any angle but the cab's.
 */
const SHELL_THICKNESS = 0.5;
const SHELL_PROFILE = (() => {
  const W = TRAIN.boreHalf + SHELL_THICKNESS;
  const profile: Array<{ off: number; rise: number }> = [
    { off: -W, rise: INVERT - SHELL_THICKNESS },
    { off: W, rise: INVERT - SHELL_THICKNESS },
    { off: W, rise: TRAIN.boreWall },
  ];
  const arcSteps = 12;
  for (let k = 1; k < arcSteps; k++) {
    const a = (k / arcSteps) * Math.PI;
    profile.push({ off: W * Math.cos(a), rise: TRAIN.boreWall + W * Math.sin(a) });
  }
  profile.push({ off: -W, rise: TRAIN.boreWall });
  return profile;
})();

/**
 * The causeway: reclaimed land the line stands on where it crosses water.
 *
 * The best alignment this map allows runs offshore for two thirds of its
 * length — ashore, the corridors left between the buildings and the trees give
 * a 72 m median curve radius against 290 m out here. Six kilometres of viaduct
 * reads as a pier rather than a railway, so the sea is filled instead: a crown
 * a couple of metres above the waterline, flanks battered down to the seabed,
 * and the ordinary ballasted track laid along the top of it. The route finder
 * leaves channels open at intervals so it is a chain of embankments and bridges
 * and not a wall across the bay.
 *
 * Three pieces rather than one closed section, because the crown is grass and
 * the flanks are sand, and one loft can only carry one material.
 */
const causewayGround = (s: Rail) => -RAIL_HEAD_LIFT - s.fill;
const CAUSEWAY_CROWN = [
  { off: -TRAIN.causewayCrownHalf, rise: (s: Rail) => causewayGround(s) },
  { off: TRAIN.causewayCrownHalf, rise: (s: Rail) => causewayGround(s) },
];

/** One flank, `side` being -1 for the left and +1 for the right. */
const causewayFlank = (side: number) => {
  const drop = (s: Rail) => causewayGround(s) - (TRAIN.seabed - s.y);
  return [
    { off: side * TRAIN.causewayCrownHalf, rise: (s: Rail) => causewayGround(s) },
    {
      off: (s: Rail) => side * (TRAIN.causewayCrownHalf + TRAIN.causewaySlope * drop(s)),
      rise: (s: Rail) => TRAIN.seabed - s.y,
    },
  ];
};

/**
 * The retaining walls of an open cutting.
 *
 * A cutting is carved out of the terrain by the fragment shader in `CityMap`,
 * and what that leaves is a raw hole: the map's own hillside texture, sliced
 * through, showing its unlit back faces down a trench up to nine metres deep
 * and twenty-five wide. It reads as damage rather than as engineering, which is
 * exactly the complaint — "huge cutouts, looks incomplete".
 *
 * So the trench gets lined. The wall follows the same battered face the shader
 * cuts — `cuttingHalf` at the floor, opening by `cuttingBatter` per metre of
 * depth — so the concrete lands on the cut surface rather than floating inside
 * it or leaving a gap of raw ground between them.
 *
 * `CUTTING_OVERCUT` is NEGATIVE, and the sign is the whole point. The cut face
 * and the lofted face are chorded differently, so meeting them exactly shows
 * daylight along the seam on every curve and the top has to be offset. Offset
 * it *upward* — which +0.7 did — and wherever the trench runs out shallow the
 * wall and its coping stand proud of the field: grey slabs sticking out of flat
 * grass all round the portal, which is what they looked like. Sunk below the
 * ground line the terrain laps over them instead. Same seam hidden, and the
 * worst case is a little wall buried rather than a little field missing.
 *
 * Two strips rather than one section, for the same reason the causeway is
 * three: a loft carries one material, and the coping along the top wants to
 * read as a different pour from the wall.
 */
const CUTTING_OVERCUT = -0.3;
const CUTTING_FOOT = -RAIL_HEAD_LIFT - 0.4;
/** Ground at the top of the wall on `side`, relative to the rail head. */
const wallGround = (s: Rail, side: number) => (side < 0 ? s.groundL : s.groundR);
/** How deep the trench is on `side`, measured from the wall's foot. */
const wallDepth = (s: Rail, side: number) => Math.max(0, wallGround(s, side) - CUTTING_FOOT);

/**
 * The floor of the cutting.
 *
 * The shader carves the terrain out of the trench — floor included, since a
 * trench with a bottom left in it is not a trench — and until now nothing put
 * anything back. The ballast shoulder covered the middle and either side of it
 * you looked straight through the ground into whatever was under the map.
 *
 * Laid at the same level as the foot of the walls, so the three pieces meet on
 * one line and there is no seam to catch light along.
 */
const cuttingFloor = () => [
  { off: -TRAIN.cuttingHalf, rise: CUTTING_FOOT },
  { off: TRAIN.cuttingHalf, rise: CUTTING_FOOT },
];

/** One wall, `side` being -1 for the left and +1 for the right. */
const cuttingWall = (side: number) => [
  { off: side * TRAIN.cuttingHalf, rise: () => CUTTING_FOOT },
  {
    off: (s: Rail) => side * (TRAIN.cuttingHalf + TRAIN.cuttingBatter * wallDepth(s, side)),
    rise: (s: Rail) => wallGround(s, side) + CUTTING_OVERCUT,
  },
];

/** The coping: a flat lip along the top of each wall, over the cut edge. */
// Narrow: on a cross-sloping bank a wide flat lip digs into the uphill side
// and hangs over the downhill one, and 1.4 m was enough to read as a loose bar.
const COPING_WIDTH = 0.6;
const cuttingCoping = (side: number) => [
  {
    off: (s: Rail) => side * (TRAIN.cuttingHalf + TRAIN.cuttingBatter * wallDepth(s, side)),
    rise: (s: Rail) => wallGround(s, side) + CUTTING_OVERCUT,
  },
  {
    off: (s: Rail) => side * (TRAIN.cuttingHalf + TRAIN.cuttingBatter * wallDepth(s, side) + COPING_WIDTH),
    rise: (s: Rail) => wallGround(s, side) + CUTTING_OVERCUT,
  },
];

/**
 * The lighting strip: a thin emissive band down each wall of a bore.
 *
 * A tunnel lit only by the locomotive's headlight is a black tube with a moving
 * pool in it, and no way to read how fast you are going — everything in view is
 * the same distance away. A continuous strip fixes both: it gives the walls a
 * receding line to judge speed against, and it puts some light on the lining so
 * the arch is legible instead of implied.
 *
 * Set a few centimetres proud of the lining rather than flush with it. Flush,
 * the two coplanar surfaces z-fight along the whole length of every tunnel,
 * which flickers far more than the strip is worth.
 */
const LIGHT_STRIP_HEIGHT = 0.34;
const LIGHT_STRIP_PROUD = 0.07;
const lightStrip = (side: number) => [
  {
    off: side * (TRAIN.boreHalf - LIGHT_STRIP_PROUD),
    rise: TRAIN.boreWall - LIGHT_STRIP_HEIGHT / 2,
  },
  {
    off: side * (TRAIN.boreHalf - LIGHT_STRIP_PROUD),
    rise: TRAIN.boreWall + LIGHT_STRIP_HEIGHT / 2,
  },
];


/** The glow bands: round the strip on the wall, along the walkway top, on the invert's edge. */
const wallGlow = (side: number) => [
  { off: side * (TRAIN.boreHalf - 0.045), rise: TRAIN.boreWall - 1.5 },
  { off: side * (TRAIN.boreHalf - 0.045), rise: TRAIN.boreWall + 1.5 },
];
const walkwayGlow = (side: number) => [
  { off: side * (TRAIN.boreHalf - 0.06), rise: INVERT + WALKWAY_HEIGHT + 0.012 },
  { off: side * (TRAIN.boreHalf - WALKWAY_WIDTH + 0.04), rise: INVERT + WALKWAY_HEIGHT + 0.012 },
];
const invertGlow = (side: number) => [
  { off: side * (TRAIN.boreHalf - WALKWAY_WIDTH - 0.04), rise: INVERT + 0.02 },
  { off: side * (TRAIN.boreHalf - WALKWAY_WIDTH - 1.9), rise: INVERT + 0.02 },
];

/**
 * The bore's fittings, as lofts down each wall — what makes the inside of a
 * tunnel look worked rather than extruded. All at the lining's own offsets, a
 * few centimetres proud of it so nothing z-fights.
 */
const TRAY_DEPTH = 0.12;
const cableTray = (side: number, rise: number) => {
  const W = TRAIN.boreHalf;
  return [
    { off: side * (W - 0.02), rise },
    { off: side * (W - 0.02 - TRAY_DEPTH), rise },
    { off: side * (W - 0.02 - TRAY_DEPTH), rise: rise + 0.14 },
    { off: side * (W - 0.02), rise: rise + 0.14 },
  ];
};
/** A handrail along the walkway's edge, 1 m up. */
const HANDRAIL_RISE = INVERT + WALKWAY_HEIGHT + 1.0;
const handrail = (side: number) => {
  const o = side * (TRAIN.boreHalf - WALKWAY_WIDTH + 0.06);
  return [
    { off: o - 0.025, rise: HANDRAIL_RISE - 0.025 },
    { off: o + 0.025, rise: HANDRAIL_RISE - 0.025 },
    { off: o + 0.025, rise: HANDRAIL_RISE + 0.025 },
    { off: o - 0.025, rise: HANDRAIL_RISE + 0.025 },
  ];
};
/** The painted line along the walkway's step. */
const walkwayEdge = (side: number) => {
  const W = TRAIN.boreHalf;
  return [
    { off: side * (W - WALKWAY_WIDTH + 0.02), rise: INVERT + WALKWAY_HEIGHT + 0.006 },
    { off: side * (W - WALKWAY_WIDTH + 0.16), rise: INVERT + WALKWAY_HEIGHT + 0.006 },
  ];
};
/** Soot along the crown: a translucent dark band over the top of the arch. */
const SOOT_CROWN = (() => {
  const W = TRAIN.boreHalf - 0.03;
  const out: Array<{ off: number; rise: number }> = [];
  for (let k = 0; k <= 6; k++) {
    const a = (0.34 + (k / 6) * 0.32) * Math.PI;
    out.push({ off: W * Math.cos(a), rise: TRAIN.boreWall + W * Math.sin(a) });
  }
  return out;
})();
/** Grime at the foot of each wall, above the walkway. */
const grimeBand = (side: number) => [
  { off: side * (TRAIN.boreHalf - 0.03), rise: INVERT + WALKWAY_HEIGHT },
  { off: side * (TRAIN.boreHalf - 0.03), rise: INVERT + WALKWAY_HEIGHT + 0.9 },
];
/** The drainage channel down the middle of the invert, between the tracks. */
const BORE_DRAIN = [
  { off: -0.28, rise: INVERT + 0.012 },
  { off: 0.28, rise: INVERT + 0.012 },
];

/** Unbroken runs where `test` holds, as [firstIndex, lastIndex] into the samples. */
function runsWhere(samples: Rail[], test: (s: Rail) => boolean): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < samples.length; i++) {
    const on = test(samples[i]);
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, samples.length - 1]);
  return runs;
}

const runsOf = (samples: Rail[], structure: number) =>
  runsWhere(samples, (s) => s.structure === structure);

/**
 * Piers under the viaducts and bridges.
 *
 * Placed by walking each elevated run at `pierSpacing` rather than by dividing
 * the run up, so every pier on the line is the same distance from its
 * neighbours whatever the span it is holding up — which is what makes a viaduct
 * read as a repeated structure instead of as a set of unrelated legs.
 */
interface Placement { x: number; y: number; z: number; angle: number }

/** A box repeated at each placement, yawed to the line. */
function Placed({ items, size, children }: { items: Placement[]; size: [number, number, number]; children: ReactNode }) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const euler = new Euler();
    items.forEach((p, i) => {
      position.set(p.x, p.y, p.z);
      euler.set(0, p.angle, 0);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      instanced.setMatrixAt(i, matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, items.length]} frustumCulled={false}>
      <boxGeometry args={size} />
      {children}
    </instancedMesh>
  );
}

/**
 * The bore's point fittings: handrail posts, refuge niches, exit signs and
 * distance boards, placed by arc along every enclosed run and yawed to the
 * line. Local +x is left of travel, so a fitting on side `s` faces the track
 * when its depth is along x. Everything stands a little INTO the bore from the
 * lining, which is one back-faced loft: anything behind it is invisible.
 */
function BoreFixtures({ samples }: { samples: Rail[] }) {
  const items = useMemo(() => {
    const W = TRAIN.boreHalf;
    const posts: Placement[] = [];
    const refuges: Placement[] = [];
    const refugeVoids: Placement[] = [];
    const refugeMarks: Placement[] = [];
    const signs: Placement[] = [];
    const signBars: Placement[] = [];
    const boards: Placement[] = [];
    const boardBars: Placement[] = [];
    const place = (arc: number, side: number, off: number, rise: number): Placement => {
      const [x, y, z] = trainPointAt(arc);
      const [nx, nz] = trainNormalAt(arc);
      const [tx, tz] = trainTangentAt(arc);
      const o = pairCentreAt(arc) + side * off;
      return { x: x + nx * o, y: y + RAIL_HEAD_LIFT + rise, z: z + nz * o, angle: Math.atan2(tx, tz) };
    };
    for (const [from, to] of runsWhere(samples, (s) => s.enclosed && !s.cavern)) {
      const start = samples[from].arc;
      const end = samples[to].arc;
      if (end - start < 30) continue;
      for (let arc = start + 3; arc < end - 2; arc += 6) {
        for (const side of [-1, 1]) posts.push(place(arc, side, W - WALKWAY_WIDTH + 0.06, INVERT + WALKWAY_HEIGHT + 0.5));
      }
      let flip = 1;
      for (let arc = start + 40; arc < end - 20; arc += 75) {
        refuges.push(place(arc, flip, W - 0.1, INVERT + WALKWAY_HEIGHT + 1.1));
        refugeVoids.push(place(arc, flip, W - 0.21, INVERT + WALKWAY_HEIGHT + 1.05));
        refugeMarks.push(place(arc, flip, W - 0.24, INVERT + WALKWAY_HEIGHT + 2.38));
        flip = -flip;
      }
      flip = -1;
      for (let arc = start + 15; arc < end - 10; arc += 50) {
        signs.push(place(arc, flip, W - 0.07, 2.25));
        signBars.push(place(arc, flip, W - 0.11, 2.25));
        flip = -flip;
      }
      for (let arc = start + 60; arc < end - 20; arc += 100) {
        boards.push(place(arc, 1, W - 0.06, 2.9));
        boardBars.push(place(arc, 1, W - 0.09, 2.9));
      }
    }
    return { posts, refuges, refugeVoids, refugeMarks, signs, signBars, boards, boardBars };
  }, [samples]);

  return (
    <group>
      <Placed items={items.posts} size={[0.05, 1.0, 0.05]}>
        <meshStandardMaterial color="#8a8880" emissive="#4d4b45" emissiveIntensity={0.5} roughness={0.5} metalness={0.6} />
      </Placed>
      {/* Refuge niches: a concrete surround with a black opening and a green marker. */}
      <Placed items={items.refuges} size={[0.2, 2.2, 1.5]}>
        <meshStandardMaterial color="#5a5751" emissive="#3a3833" emissiveIntensity={0.6} roughness={0.95} />
      </Placed>
      <Placed items={items.refugeVoids} size={[0.02, 2.0, 1.2]}>
        <meshBasicMaterial color="#03040a" toneMapped={false} />
      </Placed>
      <Placed items={items.refugeMarks} size={[0.04, 0.16, 0.5]}>
        <meshBasicMaterial color="#26c46a" toneMapped={false} />
      </Placed>
      {/* Emergency exit signs: green plate, white bar. */}
      <Placed items={items.signs} size={[0.06, 0.32, 0.72]}>
        <meshBasicMaterial color="#1c9a52" toneMapped={false} />
      </Placed>
      <Placed items={items.signBars} size={[0.02, 0.08, 0.46]}>
        <meshBasicMaterial color="#f2f2ea" toneMapped={false} />
      </Placed>
      {/* Distance boards: white plate, black bar. */}
      <Placed items={items.boards} size={[0.05, 0.4, 0.56]}>
        <meshBasicMaterial color="#e6e4da" toneMapped={false} />
      </Placed>
      <Placed items={items.boardBars} size={[0.02, 0.07, 0.36]}>
        <meshBasicMaterial color="#111111" toneMapped={false} />
      </Placed>
    </group>
  );
}

function Piers({ samples }: { samples: Rail[] }) {
  const mesh = useRef<InstancedMesh>(null);

  const piers = useMemo(() => {
    const result: Array<{ x: number; z: number; top: number; base: number; angle: number }> = [];
    for (const [from, to] of runsOf(samples, VIADUCT)) {
      const startArc = samples[from].arc;
      const endArc = samples[to].arc;
      // Half a spacing in from each abutment: a pier hard against the bank is
      // holding up nothing.
      for (let arc = startArc + TRAIN.pierSpacing / 2; arc < endArc; arc += TRAIN.pierSpacing) {
        const i = Math.min(to, Math.max(from, Math.round(arc / STEP)));
        const s = samples[i];
        // The double-track stretch stands on its own piers — see `Pillars` —
        // and the standard pier is the wrong section and in the wrong place.
        if (s.double) continue;
        const [tx, tz] = trainTangentAt(s.arc);
        result.push({
          x: s.x,
          z: s.z,
          top: s.y + DECK_BOTTOM,
          base: s.y - s.fill - RAIL_HEAD_LIFT - TRAIN.pierEmbed,
          angle: Math.atan2(tx, tz),
        });
      }
    }
    return result;
  }, [samples]);

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Euler();
    piers.forEach((pier, i) => {
      const height = Math.max(1, pier.top - pier.base);
      euler.set(0, pier.angle, 0);
      quaternion.setFromEuler(euler);
      position.set(pier.x, pier.base + height / 2, pier.z);
      // The unit box is 1 m each way, so the scale *is* the size.
      scale.set(TRAIN.pierHalf * 2, height, TRAIN.pierHalf * 1.2);
      instanced.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [piers]);

  if (!piers.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, piers.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#9a958c" roughness={0.92} />
    </instancedMesh>
  );
}

/**
 * The elevated line's piers: one rectangular pier per span on the deck's
 * centreline, with a cap beam across the top.
 *
 * The Portland El's construction, and chosen for the reason it works there: a
 * pier on the centreline needs nothing from its surroundings. It stands in a
 * street, on a shore, or in the sea alike, so one structure can run from the
 * district straight out over the northern crossing. The first version stood a
 * pair of columns on the footpaths, and columns that have to find a footpath
 * cannot leave the street.
 *
 * Solid, because some of them do stand in a street with cars on it.
 */
function Pillars({ samples }: { samples: Rail[] }) {
  const shafts = useRef<InstancedMesh>(null);
  const caps = useRef<InstancedMesh>(null);

  const piers = useMemo(() => {
    const result: Array<{ x: number; z: number; top: number; base: number; angle: number }> = [];
    for (const [from, to] of runsWhere(samples, (s) => s.double && s.structure === VIADUCT && !s.truss && !s.suspension)) {
      const startArc = samples[from].arc;
      const endArc = samples[to].arc;
      for (let arc = startArc + EL.pierSpacing / 2; arc < endArc; arc += EL.pierSpacing) {
        const i = Math.min(to, Math.max(from, Math.round(arc / STEP)));
        const s = samples[i];
        const [tx, tz] = trainTangentAt(s.arc);
        const c = mid(s);
        result.push({
          x: s.x + s.nx * c,
          z: s.z + s.nz * c,
          top: s.y + DECK_TOP - EL.deckDepth,
          base: s.y - s.fill - RAIL_HEAD_LIFT - TRAIN.pierEmbed,
          angle: Math.atan2(tx, tz),
        });
      }
    }
    return result;
  }, [samples]);

  useEffect(() => {
    const shaft = shafts.current;
    const cap = caps.current;
    if (!shaft || !cap) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Euler();
    piers.forEach((pier, i) => {
      euler.set(0, pier.angle, 0);
      quaternion.setFromEuler(euler);
      // The shaft, from the ground to the underside of the cap.
      const shaftTop = pier.top - EL.capDepth;
      const height = Math.max(1, shaftTop - pier.base);
      position.set(pier.x, pier.base + height / 2, pier.z);
      scale.set(EL.pierAcross, height, EL.pierAlong);
      shaft.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      // The cap beam, tight under the deck.
      position.set(pier.x, pier.top - EL.capDepth / 2, pier.z);
      scale.set(EL.capHalf * 2, EL.capDepth, EL.capAlong);
      cap.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    shaft.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate = true;
    shaft.computeBoundingSphere();
    cap.computeBoundingSphere();
  }, [piers]);

  if (!piers.length) return null;
  return (
    <>
      <instancedMesh ref={shafts} args={[undefined, undefined, piers.length]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#9a958c" roughness={0.92} />
      </instancedMesh>
      <instancedMesh ref={caps} args={[undefined, undefined, piers.length]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#a39e95" roughness={0.9} />
      </instancedMesh>
      <RigidBody type="fixed" colliders={false}>
        {piers.map((pier, i) => {
          const height = Math.max(1, pier.top - pier.base);
          return (
            <CuboidCollider
              key={i}
              args={[EL.pierAcross / 2, height / 2, EL.pierAlong / 2]}
              position={[pier.x, pier.base + height / 2, pier.z]}
              rotation={[0, pier.angle, 0]}
            />
          );
        })}
      </RigidBody>
    </>
  );
}

/** Sleepers, one instanced box for the whole line. */

/**
 * The down line's centreline at `arc`: the running line, offset by the gap that
 * applies THERE.
 *
 * Continuous, and that is the point. The sleepers used to take the gap from the
 * nearest `Rail` sample, which is a 5 m grid — so through the station's fan,
 * where the gap opens from 4.6 m to 12.4 m over 130 m, the value was a
 * staircase: constant for eight sleepers, then a 30 cm jump sideways. The rails
 * beside them are lofted from the same samples but INTERPOLATED between them,
 * so they ramp smoothly, and the sleepers stepped out from under them and back.
 * That was the zig-zag.
 */
function downLineAt(arc: number): [number, number] {
  const s = trainWrap(arc);
  const [x, , z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  const gap = secondTrackGap(s);
  return [x + nx * gap, z + nz * gap];
}

function Sleepers() {
  // Built as a list of matrices and handed to `InstancedField`, which cuts them
  // into frustum-cullable chunks. One field over the whole loop meant a
  // bounding sphere round the whole world and 2.28 M triangles of sleeper drawn
  // every frame whatever the camera could see — see `FIELD_CHUNK`.
  const matrices = useMemo(() => {
    const out: Matrix4[] = [];
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const euler = new Euler();
    const base = Math.floor(TRAIN_LENGTH / TRAIN.sleeperSpacing);
    for (let i = 0; i < base; i++) {
      const arc = i * TRAIN.sleeperSpacing;
      const [x, y, z] = trainPointAt(arc);
      const [tx, tz] = trainTangentAt(arc);
      euler.set(0, Math.atan2(tx, tz), 0);
      quaternion.setFromEuler(euler);
      // The geometry's origin is the sleeper's underside centre.
      const top = y + RAIL_HEAD_LIFT + SLEEPER_BOTTOM;
      position.set(x, top, z);
      out.push(new Matrix4().compose(position, quaternion, scale));
      // The second track's sleepers. Placed and SQUARED on the down line's own
      // centreline, not the running line's: on the fan the two are up to 1 in 15
      // apart in heading, and a sleeper yawed to the running line sat about four
      // degrees skew to the rails actually resting on it.
      if (doubleTrackAt(arc)) {
        const [dx, dz] = downLineAt(arc);
        const [ax, az] = downLineAt(arc - 0.5);
        const [bx, bz] = downLineAt(arc + 0.5);
        euler.set(0, Math.atan2(bx - ax, bz - az), 0);
        quaternion.setFromEuler(euler);
        position.set(dx, top, dz);
        out.push(new Matrix4().compose(position, quaternion, scale));
      }
    }
    return out;
  // No dependencies: the walk reads the route straight out of `trainPointAt`,
  // which is module-level and fixed for the life of the page.
  }, []);

  return (
    <InstancedField
      matrices={matrices}
      geometry={SLEEPER_GEOMETRY}
      material={SLEEPER_MATERIAL}
    />
  );
}

/**
 * The headwall at a tunnel mouth: a concrete slab with the bore cut through it.
 *
 * Built as a `Shape` with a hole and extruded, so the opening is the same
 * horseshoe as the lining and the terrain cut, not a rectangle with corners
 * showing hill through them. The generator has carried each tunnel out to
 * where the ground meets the rail, so this stands at the foot of the slope with
 * the hill rising behind it, which is where a portal goes.
 */
const PORTAL_GEOMETRY = (() => {
  const W = TRAIN.boreHalf + 0.05;
  const shape = new Shape();
  shape.moveTo(-TRAIN.portalHalf, SLEEPER_BOTTOM - 1);
  shape.lineTo(TRAIN.portalHalf, SLEEPER_BOTTOM - 1);
  shape.lineTo(TRAIN.portalHalf, TRAIN.portalHeight);
  shape.lineTo(-TRAIN.portalHalf, TRAIN.portalHeight);
  shape.closePath();
  const bore = new Path();
  bore.moveTo(-W, INVERT);
  bore.lineTo(W, INVERT);
  bore.lineTo(W, TRAIN.boreWall);
  bore.absarc(0, TRAIN.boreWall, W, 0, Math.PI, false);
  bore.lineTo(-W, INVERT);
  shape.holes.push(bore);
  const geometry = new ExtrudeGeometry(shape, { depth: TRAIN.portalThickness, bevelEnabled: false });
  geometry.translate(0, 0, -TRAIN.portalThickness / 2);
  return geometry;
})();

function Portal({ arc }: { arc: number }) {
  const { position, rotation } = useMemo(() => {
    const [x, y, z] = trainPointAt(arc);
    const [tx, tz] = trainTangentAt(arc);
    const [nx, nz] = trainNormalAt(arc);
    const off = pairCentreAt(arc);
    // The extrusion runs along local +Z; turned so that is along the track,
    // and stood on the middle of the track pair like the bore behind it.
    return {
      position: [x + nx * off, y + RAIL_HEAD_LIFT, z + nz * off] as [number, number, number],
      rotation: [0, Math.atan2(tx, tz), 0] as [number, number, number],
    };
  }, [arc]);

  return (
    <mesh geometry={PORTAL_GEOMETRY} position={position} rotation={rotation} castShadow receiveShadow>
      <meshStandardMaterial color="#8a847a" roughness={0.95} />
    </mesh>
  );
}


/**
 * Ballast, as a texture: grey-brown stone noise at about a centimetre a pixel.
 *
 * Drawn once on a canvas rather than shipped as a file. A flat colour reads as
 * a concrete strip from the cab, and the line is in view for most of a lap.
 */
function makeBallastTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#6e665d';
  ctx.fillRect(0, 0, size, size);
  let seed = 20240907;
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
  // The loft's U is metres across the section and its V is metres along the
  // line over V_SCALE, so this puts one tile per metre both ways.
  texture.repeat.set(1, V_SCALE);
  texture.anisotropy = 4;
  return texture;
}

/**
 * A scripted service: one locomotive and its coaches, running the loop on its
 * own.
 *
 * Not the player's train — that is `TrainRide`, which is driven. This is what
 * makes the railway look used: a train the player meets rather than one they
 * are in. It has no driver, no brake handle and no cab camera, so all it needs
 * is an arc length that increases, a speed that respects the line's own
 * restrictions, and the same `locomotivePose` every other rail vehicle uses.
 *
 * It hauls a rake now (`SERVICE_FORMATION`), for a reason that only appeared
 * once the player's train got coaches: a lone locomotive passing a
 * seven-vehicle train on the next track reads as a *fault* — as though the
 * scenery train had lost its train. Each unit is posed from its own arc length
 * rather than hung off the leader, exactly as the player's rake is, so the
 * service bends through corners instead of pivoting.
 */
/** Metres of an AI service behind its leading end, for the signalling. */
/**
 * Which class each service round the loop is, alternating.
 *
 * The player's own choice used to decide the whole fleet, which meant a line
 * of nothing but whatever you had picked. Both classes exist and both are
 * built, so both run: the services alternate down the list, and because they
 * are spread evenly round a 9.2 km loop the one you meet next is as likely to
 * be one as the other.
 *
 * The cost is honest and it is the reason this was not the first design — both
 * sets are now loaded rather than one, which is 370 k triangles and 2 MB of GLB
 * that a single-class line did not pay for. It buys a railway with two classes
 * on it, which is what was asked for.
 */
const SERVICE_STOCK = (index: number): RailSetId => (
  RAIL_SET_IDS[index % RAIL_SET_IDS.length]
);

/** Length over couplers of one service of the given class. */
const serviceLength = (setId: RailSetId) => serviceFormationFor(SERVICE_CARRIAGES, setId)
  .reduce((n, unit) => n + unit.length + 0.6, 0);

/**
 * How far ahead a service looks for the ridden train, metres.
 *
 * Its own stopping distance plus a margin, derived rather than written down so
 * it stays true if the line speed or the brake changes: at 42 m/s and 2 m/s²
 * that is 441 m to stop, and a block that was shorter than that would be a
 * signal a train cannot obey.
 */
const BLOCK = (TRAIN.speed * TRAIN.speed) / (2 * TRAIN.brake) + 120;

/**
 * True when the player's own train is on this road, and so no service may be.
 * Only a ridden main-line locomotive claims a road; from a car or a tram the
 * railway runs its full service on both.
 */
const mine = (road: number) => SELECTED.rail === 'main' && playerRoad() === road;

function Service({ phase, track = 0, stock }: {
  phase: number; track?: 0 | 1; stock: RailSetId;
}) {
  const set = RAIL_SETS_ALL[stock];
  const formation = useMemo(() => serviceFormationFor(SERVICE_CARRIAGES, stock), [stock]);
  const length = useMemo(() => serviceLength(stock), [stock]);
  const locoHeight = RAIL_SETS_ALL[stock].bodyHeight;
  const coachHeight = set.coach.size[1];
  // Track 1 is the second track of the pair: `secondTrackGap` across from the
  // running line, worked the opposite way round the loop. Which way each of
  // them runs is `runsAlongArc`'s to say and nobody else's — it is what makes
  // the railway drive on the right, and the player takes the very same answer
  // through `TrainRide`'s `FACING`.
  const direction: 1 | -1 = runsAlongArc(track === 1 ? DOWN : UP);
  const lateral = (arc: number) => (track === 1 ? secondTrackGap(arc) : 0);
  const { scene } = useGLTF(set.loco.model, DRACO_PATH);
  const { scene: coachScene } = useGLTF(set.coach.model, DRACO_PATH);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  const carriers = useRef<(Object3D | null)[]>([]);
  const travelled = useRef(phase);
  const speed = useRef(0);
  /** How dark it is where this train is — see `Headlamps`. */
  const darkness = useRef(0);
  const registryId = `ai-${stock}-${track}-${phase.toFixed(0)}`;
  useEffect(() => () => forgetTrain(registryId), [registryId]);

  // Cloned so drei's cached GLTF scene is never re-parented away from under it;
  // a hot reload would otherwise remount into an already-emptied scene and draw
  // nothing. Same reasoning as the tram's sections. Clones share geometry and
  // material, so a coach is a draw call and a matrix.
  const models = useMemo(
    () => formation.map(
      (unit) => (unit.model === 'loco' ? scene : coachScene).clone(true),
    ),
    [formation, scene, coachScene],
  );

  useEffect(() => {
    for (const model of models) {
      model.traverse((child) => {
        // NOT a caster — see `ShadowProxy`. A service is a hundred primitives
        // per vehicle and every one of them was its own shadow submission.
        child.castShadow = false;
        child.receiveShadow = true;
      });
    }
  }, [models]);

  const scratch = useMemo(() => ({
    quaternion: new Quaternion(), euler: new Euler(0, 0, 0, 'YXZ'),
  }), []);

  /**
   * Where one unit sits. `offset` is metres back down the train from the
   * locomotive, which is *against* the direction of travel — so it is
   * subtracted the way the arc increases, and a flipped unit turns end for end
   * in pitch as well as yaw.
   */
  const unitPose = (leadArc: number, index: number) => {
    const unit = formation[index];
    const arc = trainWrap(leadArc - direction * unit.offset);
    const at = locomotivePose(arc, direction, lateral, unit.bogieCentres);
    return unit.flip ? { ...at, yaw: at.yaw + Math.PI, pitch: -at.pitch } : at;
  };

  // Rapier writes go in the before-step callback, never in useFrame: touching a
  // body from the render loop races the step's borrow of the World and throws
  // the "recursive use of an object" abort. Same rule as CarPhysics and the tram.
  useBeforePhysicsStep(() => {
    let target = Math.min(TRAIN.speed, trainSpeedLimitAt(travelled.current));
    // Block working, and the ridden train is the only thing it is kept for.
    // The services keep station with each other for free — they all run this
    // same profile, so an evenly spaced set stays evenly spaced and none ever
    // closes on the one in front. The one train on the line that does not run
    // to a profile is the one with a driver in it.
    //
    // `playerTrain` is undefined while the player is in a loop, which is the
    // point of a loop: a service runs past the platform they are standing at
    // rather than being held outside the station by it. See `occupiedTrack`.
    const player = playerTrain();
    if (player && player.track === track) {
      // The player's occupied span, projected into this service's direction of
      // travel. Both ends, because head-on on the same road — the player
      // running wrong-line — closes from the other end.
      const head = ahead(travelled.current, player.arc) * direction;
      const tail = ahead(travelled.current, player.arc - player.direction * player.length)
        * direction;
      if (Math.max(head, tail) > -length && Math.min(head, tail) < BLOCK) target = 0;
    }
    const step = TRAIN.brake * PHYSICS_TIMESTEP;
    speed.current += Math.max(-step, Math.min(step, target - speed.current));
    travelled.current = trainWrap(travelled.current + direction * speed.current * PHYSICS_TIMESTEP);
    darkness.current = trainDarknessAt(travelled.current);
    reportTrain(registryId, { arc: travelled.current, track, direction, length });

    for (let i = 0; i < formation.length; i++) {
      const at = unitPose(travelled.current, i);
      scratch.euler.set(at.pitch, at.yaw, 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      const height = formation[i].model === 'loco' ? locoHeight : coachHeight;
      bodies.current[i]?.setNextKinematicTranslation({
        x: at.x, y: at.y + height / 2, z: at.z,
      });
      bodies.current[i]?.setNextKinematicRotation(scratch.quaternion);
    }
  });

  useFrame(() => {
    for (let i = 0; i < formation.length; i++) {
      const group = carriers.current[i];
      if (!group) continue;
      const at = unitPose(travelled.current, i);
      group.position.set(at.x, at.y, at.z);
      scratch.euler.set(at.pitch, at.yaw, 0);
      group.quaternion.setFromEuler(scratch.euler);
    }
  });

  return (
    <>
      {models.map((model, i) => (
        <group key={i} ref={(group) => { carriers.current[i] = group; }}>
          <primitive object={model} />
          <ShadowProxy size={formation[i].model === 'loco'
            ? [set.loco.size[0], locoHeight, set.loco.size[2]]
            : [set.coach.size[0], coachHeight, set.coach.size[2]]} />
          {formation[i].model === 'loco' && (
            <Headlamps dark={darkness} speed={speed} tail={i === models.length - 1} length={set.loco.size[2]} />
          )}
        </group>
      ))}
      {formation.map((unit, i) => {
        const box = unit.model === 'loco'
          ? [set.loco.size[0], locoHeight, set.loco.size[2]] as const
          : [set.coach.size[0], coachHeight, set.coach.size[2]] as const;
        return (
          <RigidBody
            key={i}
            ref={(body) => { bodies.current[i] = body; }}
            type="kinematicPosition"
            colliders="cuboid"
            position={[0, -500, 0]}
          >
            {/* Invisible: the visible vehicle is the model above, which Rapier
                never sees. This only sizes the collider. */}
            <mesh visible={false}>
              <boxGeometry args={[box[0], box[1], box[2]]} />
            </mesh>
          </RigidBody>
        );
      })}
    </>
  );
}

/**
 * Main-line railway: a loop right around the city.
 *
 * Everything here is built once from `trainConfig`'s smoothed centreline and
 * never touched again — no per-frame work at all, because nothing about the
 * line moves. The route was searched offline (`npm run route:train`), so this
 * does not read the nav raster and has nothing to wait for, unlike the tram
 * loop which samples road heights at load.
 *
 * Colliders are on the decks only. A bridge a car can drive through is worse
 * than no bridge, and the deck is the one part of the line the player can
 * actually get onto; the ballast, by contrast, would be ten kilometres of kerb
 * laid across the open ground, which is exactly the trip hazard `railConfig`
 * refuses to put in the streets.
 */
/**
 * The created islands, as a grass crown ringed by a sand beach.
 *
 * Built here rather than lofted along the rail like the causeway, because an
 * island is a *place*, not a strip: the line crosses one corner to corner and
 * the rest of it has to be there too. Two rings and a fan is enough — the drawn
 * outlines are convex blobs, so a fan from the centroid triangulates them
 * without needing ear clipping, and the beach is the same outline pushed
 * outward and dropped to the seabed.
 *
 * The outer ring goes *below* the waterline on purpose. Stopped at sea level it
 * leaves a rim of z-fighting where the two flat surfaces meet; carried under, the
 * water plane simply cuts it and the beach reads as shelving into the sea.
 */
function buildIslands() {
  const crown: number[] = [];
  const crownIndex: number[] = [];
  const beach: number[] = [];
  const beachIndex: number[] = [];

  for (const island of TRAIN_ISLANDS) {
    const n = island.outline.length;
    const base = crown.length / 3;
    crown.push(island.centre[0], island.crown, island.centre[1]);
    for (const [x, z] of island.outline) crown.push(x, island.crown, z);
    for (let i = 0; i < n; i++) {
      crownIndex.push(base, base + 1 + i, base + 1 + ((i + 1) % n));
    }

    const bBase = beach.length / 3;
    for (const [x, z] of island.outline) {
      const dx = x - island.centre[0];
      const dz = z - island.centre[1];
      const len = Math.hypot(dx, dz) || 1;
      beach.push(x, island.crown, z);
      beach.push(x + (dx / len) * island.shore, TRAIN.seabed, z + (dz / len) * island.shore);
    }
    for (let i = 0; i < n; i++) {
      const a = bBase + i * 2;
      const b = bBase + ((i + 1) % n) * 2;
      beachIndex.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }

  const make = (positions: number[], indices: number[]) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return {
      geometry,
      vertices: new Float32Array(positions),
      indices: new Uint32Array(indices),
    };
  };
  return { crown: make(crown, crownIndex), beach: make(beach, beachIndex) };
}

export function TrainLine({ trains = true }: {
  /**
   * Whether the scripted services run. False leaves the railway itself — the
   * track, its bridges, its tunnel and the colliders — because the stations,
   * the pointwork and the island bridge are mounted separately and stand on
   * it. What goes is the rolling stock, which is where the cost is.
   */
  trains?: boolean;
}) {
  // The cutting walls read the nav raster for the ground under each side. It
  // loads alongside the city, usually before this mounts; if not, the walls
  // are built to the centreline first and rebuilt once when the raster lands.
  const [navReady, setNavReady] = useState(() => getNav() !== null);
  useEffect(() => {
    if (navReady) return;
    let alive = true;
    loadCityNav(CITY_NAV_IMAGE).then(() => { if (alive) setNavReady(true); }).catch(() => {});
    return () => { alive = false; };
  }, [navReady]);

  const built = useMemo(() => {
    const samples = sampleLine();
    const g = TRAIN.gauge / 2;
    // A structure has to be complete at both ends, so a segment counts as part
    // of one if either of its samples does.
    const isDeck = (a: Rail, b: Rail) => a.structure === VIADUCT || b.structure === VIADUCT;

    // Not through the underground station: its hall replaces the lining there,
    // and the two meet exactly because the hall's ends are the bore's section.
    // ...and it stops one sample SHORT of the hall, not one sample into it: a
    // segment with either end in the cavern is the hall's, whose section at
    // its outer margin is this very profile — see `UndergroundStation`. Ending
    // inside the ease instead left the lining's last ring standing free inside
    // a room already wider than it, with a gap all round.
    const isBore = (a: Rail, b: Rail) => (a.enclosed || b.enclosed) && !(a.cavern || b.cavern);
    // A gallery is an enclosed stretch with no hill round it: the deck loses
    // its parapets and gains a shell. One sample of overlap at each end, so the
    // shell meets the bore rather than leaving a ring of daylight at the joint.
    const isGallery = (a: Rail, b: Rail) => (a.enclosed || b.enclosed)
      && (a.structure !== TUNNEL || b.structure !== TUNNEL);
    // The double-track stretch has its own deck, so the standard one stops where
    // it starts. A segment counts if either end does, so the wide deck reaches
    // its abutments rather than stopping a sample short.
    const isDouble = (a: Rail, b: Rail) => a.double || b.double;
    const isBothDouble = (a: Rail, b: Rail) => a.double && b.double;
    const isOpenDeck = (a: Rail, b: Rail) => isDeck(a, b) && !(a.enclosed && b.enclosed)
      && !isDouble(a, b);
    const isWideDeck = (a: Rail, b: Rail) => isDeck(a, b) && !(a.enclosed && b.enclosed)
      && isDouble(a, b) && !(a.truss && b.truss) && !(a.suspension && b.suspension);
    const isGalleryDeck = (a: Rail, b: Rail) => isDeck(a, b) && (a.enclosed || b.enclosed);
    // Ballast wherever the line is on the ground and in the open — embankment
    // and cutting alike. A cutting is still a railway on ballast; leaving it out
    // put the sleepers straight onto the trench floor, which is what the bare
    // strip in the bottom of every excavation was. Not on a bridge deck, and not
    // inside an enclosed stretch, which is slab track.
    const onGround = (r: Rail) => r.structure === BALLAST || r.structure === CUTTING;
    // Not through the station: the four roads there stand on ONE formation that
    // `IslandStation` lays, and a trapezium of our own inside it would be a
    // second crown at exactly the same height — coplanar, and z-fighting down
    // the length of the platforms.
    const isBank = (a: Rail, b: Rail) => !a.yard && !b.yard && onGround(a) && onGround(b)
      && !a.enclosed && !b.enclosed;
    // The second track's ballast, where the double-track stretch is on the ground.
    const isDoubleBank = (a: Rail, b: Rail) => isBank(a, b) && isBothDouble(a, b);
    const isMade = (a: Rail, b: Rail) => a.made && b.made;
    // Every open excavation: the cuttings themselves, and the short lengths of
    // cutting that sit either side of a portal.
    const isTrench = (a: Rail, b: Rail) => a.trench || b.trench;

    return {
      samples,
      ballastTexture: makeBallastTexture(),
      liningTexture: makeLiningTexture(),
      lampTexture: makeLampTexture(),
      glowTexture: makeGlowTexture(),
      ballast: buildLoft(samples, BALLAST_PROFILE, { vScale: V_SCALE, filter: isBank }),
      deck: buildLoft(samples, DECK_PROFILE, { vScale: V_SCALE, closed: true, filter: isOpenDeck }),
      galleryDeck: buildLoft(samples, shifted(GALLERY_DECK_PROFILE, midOf),
        { vScale: V_SCALE, closed: true, filter: isGalleryDeck }),
      lining: buildLoft(samples, shifted(LINING_PROFILE, midOf), { vScale: V_SCALE, closed: true, filter: isBore }),
      lightLeft: buildLoft(samples, shifted(lightStrip(-1), midOf), { vScale: V_SCALE, filter: isBore }),
      lightRight: buildLoft(samples, shifted(lightStrip(1), midOf), { vScale: V_SCALE, filter: isBore }),
      shell: buildLoft(samples, shifted(SHELL_PROFILE, midOf), { vScale: V_SCALE, closed: true, filter: isGallery }),
      // The bore's interior fittings: see `cableTray` and friends.
      boreTrays: [[-1, 1.75], [-1, 2.15], [1, 1.75], [1, 2.15]].map(([side, rise]) => (
        buildLoft(samples, shifted(cableTray(side, rise), midOf), { vScale: V_SCALE, closed: true, filter: isBore })
      )),
      boreHandrails: [-1, 1].map((side) => (
        buildLoft(samples, shifted(handrail(side), midOf), { vScale: V_SCALE, closed: true, filter: isBore })
      )),
      boreEdges: [-1, 1].map((side) => (
        buildLoft(samples, shifted(walkwayEdge(side), midOf), { vScale: V_SCALE, filter: isBore })
      )),
      boreGrime: [-1, 1].map((side) => (
        buildLoft(samples, shifted(grimeBand(side), midOf), { vScale: V_SCALE, filter: isBore })
      )),
      boreSoot: buildLoft(samples, shifted(SOOT_CROWN, midOf), { vScale: V_SCALE, filter: isBore }),
      boreGlow: [wallGlow, walkwayGlow, invertGlow].flatMap((band) => [-1, 1].map((side) => (
        buildLoft(samples, shifted(band(side), midOf), { vScale: V_SCALE, filter: isBore })
      ))),
      boreDrain: buildLoft(samples, shifted(BORE_DRAIN, midOf), { vScale: V_SCALE, filter: isBore }),
      trough: buildLoft(samples, TROUGH_PROFILE, { vScale: V_SCALE, closed: true, filter: (a, b) => !a.enclosed && !b.enclosed }),
      islands: buildIslands(),
      cuttingFloor: buildLoft(samples, shifted(cuttingFloor(), midOf), { vScale: V_SCALE, filter: isTrench }),
      cuttingLeft: buildLoft(samples, shifted(cuttingWall(-1), midOf), { vScale: V_SCALE, filter: isTrench }),
      cuttingRight: buildLoft(samples, shifted(cuttingWall(1), midOf), { vScale: V_SCALE, filter: isTrench }),
      copingLeft: buildLoft(samples, shifted(cuttingCoping(-1), midOf), { vScale: V_SCALE, filter: isTrench }),
      copingRight: buildLoft(samples, shifted(cuttingCoping(1), midOf), { vScale: V_SCALE, filter: isTrench }),
      causewayCrown: buildLoft(samples, CAUSEWAY_CROWN, { vScale: V_SCALE, filter: isMade }),
      causewayLeft: buildLoft(samples, causewayFlank(-1), { vScale: V_SCALE, filter: isMade }),
      causewayRight: buildLoft(samples, causewayFlank(1), { vScale: V_SCALE, filter: isMade }),
      railLeft: buildLoft(samples, railProfile(-g), { vScale: V_SCALE, closed: true }),
      railRight: buildLoft(samples, railProfile(g), { vScale: V_SCALE, closed: true }),
      // The double-track deck, and the second track — the down line, 4.6 m to
      // the left of the running line the whole way round: on the deck where
      // there is one and on its own ballast where the line is on the ground.
      // It fans out to become road 1 through the island station
      // (`secondTrackGap`) and carries the down service (`Service track=1`).
      wideDeck: buildLoft(samples, WIDE_DECK_PROFILE,
        { vScale: V_SCALE, closed: true, filter: isWideDeck }),
      secondBallast: buildLoft(samples, shifted(BALLAST_PROFILE, (s) => s.gap),
        { vScale: V_SCALE, filter: isDoubleBank }),
      secondLeft: buildLoft(samples, shifted(railProfile(-g), (s) => s.gap),
        { vScale: V_SCALE, closed: true, filter: isBothDouble }),
      secondRight: buildLoft(samples, shifted(railProfile(g), (s) => s.gap),
        { vScale: V_SCALE, closed: true, filter: isBothDouble }),
      // One portal at each end of the whole enclosed stretch — not at every
      // bore. Where two bores are joined by a gallery the driver runs straight
      // through, and a headwall at the join would be a ring across the view.
      //
      // And only where the mouth has a face to stand on: an excavation, or a
      // bridge deck. A headwall set straight into a hillside buries most of
      // itself and leaves its top corner hanging out of the slope as a slab in
      // mid-air — where a bore simply begins under deep cover, the hole in the
      // rock is the portal. A mouth that opens onto a viaduct is the opposite
      // case and was wrongly lumped in with it: there is nothing there to bury
      // the headwall in, so leaving it off gave a tunnel that simply stopped,
      // opening onto a bridge with no face at all.
      portals: runsWhere(samples, (s) => s.enclosed).flatMap(([from, to]) => {
        // A headwall wants a face to stand on. An excavation and a bridge deck
        // both give it one. So does plain ground where the bore daylights under
        // shallow cover — which is most mouths, and leaving those out is what
        // gave a bare horseshoe hole punched into a grass slope with no built
        // face anywhere near it.
        //
        // The case the original rule was guarding against is real but rarer:
        // where a bore begins under cover deeper than the portal is tall, the
        // headwall buries itself entirely and only its top corner shows,
        // hanging out of the slope as a slab in mid-air. So the test is not
        // what the neighbour is, it is whether the wall would be visible.
        const hasFace = (r: Rail) => r.structure === CUTTING || r.structure === VIADUCT
          || -r.fill < TRAIN.portalHeight + 2;
        const before = samples[(from - 1 + samples.length) % samples.length];
        const after = samples[(to + 1) % samples.length];
        return [
          ...(hasFace(before) ? [samples[from].arc] : []),
          ...(hasFace(after) ? [samples[to].arc] : []),
        ];
      }),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- navReady is the trigger, not an input
  }, [navReady]);

  useEffect(() => () => {
    built.ballastTexture.dispose();
    built.liningTexture.dispose();
    built.lampTexture.dispose();
    built.glowTexture.dispose();
    for (const g of [...built.boreTrays, ...built.boreHandrails, ...built.boreEdges, ...built.boreGrime,
      ...built.boreGlow, built.boreSoot, built.boreDrain]) g.geometry.dispose();
    built.ballast.geometry.dispose();
    built.deck.geometry.dispose();
    built.galleryDeck.geometry.dispose();
    built.lining.geometry.dispose();
    built.shell.geometry.dispose();
    built.lightLeft.geometry.dispose();
    built.lightRight.geometry.dispose();
    built.cuttingFloor.geometry.dispose();
    built.cuttingLeft.geometry.dispose();
    built.cuttingRight.geometry.dispose();
    built.copingLeft.geometry.dispose();
    built.copingRight.geometry.dispose();
    built.trough.geometry.dispose();
    built.islands.crown.geometry.dispose();
    built.islands.beach.geometry.dispose();
    built.causewayCrown.geometry.dispose();
    built.causewayLeft.geometry.dispose();
    built.causewayRight.geometry.dispose();
    built.railLeft.geometry.dispose();
    built.railRight.geometry.dispose();
    built.wideDeck.geometry.dispose();
    built.secondBallast.geometry.dispose();
    built.secondLeft.geometry.dispose();
    built.secondRight.geometry.dispose();
  }, [built]);

  return (
    <group>
      {/* The strip lighting. Unlit and self-coloured: it is a light source as far
          as the eye is concerned, and making it an actual light would be sixty
          of them in a scene that already has a shadow-casting sun. */}
      {[built.lightLeft, built.lightRight].map((strip, i) => (
        <mesh key={`l${i}`} geometry={strip.geometry}>
          <meshBasicMaterial map={built.lampTexture} side={DoubleSide} toneMapped={false} />
        </mesh>
      ))}

      {/* The bore's fittings. Cable trays and a handrail down each wall, the
          painted edge of the walkway, a drain between the tracks, and two
          translucent bands — soot along the crown, grime at the wall foot — that
          do more for "old tunnel" than any amount of texture. */}
      {built.boreTrays.map((tray, i) => (
        <mesh key={`bt${i}`} geometry={tray.geometry}>
          <meshStandardMaterial color="#34332f" emissive="#26251f" emissiveIntensity={0.5} roughness={0.7} metalness={0.4} side={DoubleSide} />
        </mesh>
      ))}
      {built.boreHandrails.map((rail, i) => (
        <mesh key={`bh${i}`} geometry={rail.geometry}>
          <meshStandardMaterial color="#8a8880" emissive="#4d4b45" emissiveIntensity={0.5} roughness={0.5} metalness={0.6} side={DoubleSide} />
        </mesh>
      ))}
      {built.boreEdges.map((edge, i) => (
        <mesh key={`be${i}`} geometry={edge.geometry}>
          <meshStandardMaterial color="#9a8a4a" emissive="#8a7a3c" emissiveIntensity={0.7} roughness={0.9} side={DoubleSide} />
        </mesh>
      ))}
      <mesh geometry={built.boreDrain.geometry}>
        <meshStandardMaterial color="#121214" emissive="#0e0e10" emissiveIntensity={0.6} roughness={1} side={DoubleSide} />
      </mesh>
      <mesh geometry={built.boreSoot.geometry}>
        <meshBasicMaterial color="#000000" transparent opacity={0.55} depthWrite={false} side={DoubleSide} />
      </mesh>
      {built.boreGrime.map((band, i) => (
        <mesh key={`bg${i}`} geometry={band.geometry}>
          <meshBasicMaterial color="#000000" transparent opacity={0.4} depthWrite={false} side={DoubleSide} />
        </mesh>
      ))}
      {/* The lamps' light on the concrete — additive, so it only ever brightens. */}
      {built.boreGlow.map((band, i) => (
        <mesh key={`gl${i}`} geometry={band.geometry}>
          <meshBasicMaterial
            map={built.glowTexture} transparent opacity={i < 2 ? 0.7 : 0.5} blending={AdditiveBlending}
            depthWrite={false} side={DoubleSide} toneMapped={false}
          />
        </mesh>
      ))}
      <BoreFixtures samples={built.samples} />

      {/* The trench floor, under the ballast and between the wall feet. */}
      <mesh geometry={built.cuttingFloor.geometry} receiveShadow>
        <meshStandardMaterial color="#6f6c66" roughness={0.98} side={DoubleSide} />
      </mesh>

      {/* The cutting walls. DoubleSide because the far wall is seen through the
          near one's top edge on a curve, and the coping is seen from beneath
          when the line is deep. */}
      {[built.cuttingLeft, built.cuttingRight].map((wall, i) => (
        <mesh key={`w${i}`} geometry={wall.geometry} receiveShadow castShadow>
          <meshStandardMaterial color="#8d8b85" roughness={0.92} side={DoubleSide} />
        </mesh>
      ))}
      {[built.copingLeft, built.copingRight].map((cap, i) => (
        <mesh key={`c${i}`} geometry={cap.geometry} receiveShadow castShadow>
          <meshStandardMaterial color="#a5a29a" roughness={0.9} side={DoubleSide} />
        </mesh>
      ))}

      {/* The created islands, in the same grass-and-sand as the causeway so the
          two read as the same kind of made ground — and in the MAINLAND's
          grass, not a green of their own. `TOWN_PALETTE` carries the figure and
          how it was measured; the short version is that the city's ground
          shells sample out at #4b6020 on the verges and #285230 in the parks,
          and the island was a full step brighter and greener than either, which
          is why it read as a different place from the far shore. */}
      <mesh geometry={built.islands.crown.geometry} receiveShadow>
        <meshStandardMaterial color={TOWN_PALETTE.grass} roughness={0.95} />
      </mesh>
      <mesh geometry={built.islands.beach.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#b3a37c" roughness={0.95} side={DoubleSide} />
      </mesh>

      {/* The reclaimed land, under everything else. Grass crown, sand flanks —
          see the note on CAUSEWAY_CROWN. DoubleSide on the flanks because the
          shore end of a run can be seen from either hand. */}
      <mesh geometry={built.causewayCrown.geometry} receiveShadow>
        <meshStandardMaterial color="#4f6b3c" roughness={0.95} side={DoubleSide} />
      </mesh>
      {[built.causewayLeft, built.causewayRight].map((flank, i) => (
        <mesh key={i} geometry={flank.geometry} receiveShadow castShadow>
          <meshStandardMaterial color="#b3a37c" roughness={0.95} side={DoubleSide} />
        </mesh>
      ))}

      <mesh geometry={built.ballast.geometry} receiveShadow castShadow>
        <meshStandardMaterial map={built.ballastTexture} roughness={1} />
      </mesh>

      {/* Seen from the inside only — see LINING_PROFILE.
          Very nearly unlit, and that is the point. Nothing in this scene
          occludes light, so the sun reaches inside the hill: with an ordinary
          lit material the invert — a flat surface square-on to a 48-degree sun
          — came out brighter than anything else in the bore and read as a
          sheet of white glass under the sleepers. A near-black diffuse leaves
          almost nothing for the sun to pick up, and the emissive carries the
          concrete instead, so wall, arch and floor are one even tone lit by
          the lamps rather than by a sun that should not be there. */}
      <mesh geometry={built.lining.geometry}>
        <meshStandardMaterial
          map={built.liningTexture}
          color={LINING_MATERIAL.color}
          emissive={LINING_MATERIAL.emissive}
          emissiveMap={built.liningTexture}
          // Dim, now that the world itself goes dark underground (`Darkness` in
          // Environment) and the strips are lamps rather than a tube of light:
          // the lining is concrete in a badly lit tunnel, read by the lamps and
          // the ring joints, not a glowing surface. At 1.0 it was daylight.
          emissiveIntensity={LINING_MATERIAL.emissiveIntensity}
          roughness={1}
          side={BackSide}
        />
      </mesh>

      <mesh geometry={built.deck.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#b4aea3" roughness={0.9} />
      </mesh>

      {/* The gallery: a parapet-less deck on the same piers, and the shell over
          it. Drawn front-facing, unlike the lining, because this is the part of
          an enclosed stretch that has an outside. */}
      <mesh geometry={built.galleryDeck.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#b4aea3" roughness={0.9} />
      </mesh>
      <mesh geometry={built.shell.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#9c968c" roughness={0.92} />
      </mesh>

      <Sleepers />
      <Piers samples={built.samples} />
      {built.portals.map((arc) => <Portal key={arc} arc={arc} />)}

      {/* Whichever road the player took is theirs alone: no service is placed
          on it at all. It used to be the up line that stood down, named
          outright — which was right only while the player could ONLY start on
          the up line. Once the spawn began picking a road at random, a
          down-line start put the player on the road carrying all four services,
          all going the same way, and left the up line empty: nothing ever came
          the other way, and the encounter the line is built around never
          happened. `mine` asks `railSpawn` instead of naming a track.

          Not squeamishness about collisions — the ridden train is kinematic and
          would pass through one. It is that a service on the *same* road going
          the *same* way is the one encounter the line cannot make interesting.
          The player tops out at 300 km/h and a service runs at 150, so meeting
          one means overhauling it from behind at closing speed with nowhere to
          go; there is no passing on a running line. Everything worth meeting is
          on the other road, coming toward you, where the two close at 450 and
          are past each other in a second. See `TRAIN.count`. */}
      {trains && !mine(UP) && Array.from(
        { length: TRAIN.count },
        (_, i) => (
          <Service key={i} stock={SERVICE_STOCK(i)}
            phase={(i / TRAIN.count) * TRAIN_LENGTH} />
        ),
      )}
      {/* The other road's services, running the opposite way — which is the
          only kind worth meeting, and now the only kind the player can meet.
          Only once the second track exists the whole way round: a train on a
          track that stops would drive off the end of it onto single-track
          ground, and until then `doubleTrackAt` is false somewhere. */}
      {trains && !mine(DOWN) && built.samples.every((s) => s.double) && Array.from(
        { length: TRAIN.count },
        (_, i) => (
          <Service key={`down-${i}`} track={1} stock={SERVICE_STOCK(i + 1)}
            phase={((i + 0.5) / TRAIN.count) * TRAIN_LENGTH} />
        ),
      )}

      {/* `RAIL_STEEL`: the one rail material, shared with the crossovers and
          the station loops so a blade and the stock rail it lies against are
          the same steel. See `railGeometry`. */}
      {[built.railLeft, built.railRight, built.secondLeft, built.secondRight].map((rail, i) => (
        <mesh key={i} geometry={rail.geometry} material={RAIL_STEEL} castShadow receiveShadow />
      ))}
      <mesh geometry={built.trough.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#9a968e" roughness={0.95} />
      </mesh>
      <Lineside samples={built.samples} />
      <TrussBridge samples={built.samples} />
      <SuspensionBridge samples={built.samples} />

      {/* The elevated line: the double-track box girder on its centre piers,
          and the second track's ballast where the stretch comes down to the
          ground. Concrete like the other decks — it is the same railway. */}
      <mesh geometry={built.wideDeck.geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#aaa59c" roughness={0.9} side={DoubleSide} />
      </mesh>
      <mesh geometry={built.secondBallast.geometry} receiveShadow castShadow>
        <meshStandardMaterial map={built.ballastTexture} roughness={1} />
      </mesh>
      <Pillars samples={built.samples} />

      {/* The decks and the causeway crown are solid — see the component
          docstring. The crown is land: a car that gets onto it should stand on
          it rather than drop into the sea. */}
      <RigidBody type="fixed" colliders={false} friction={0.9}>
        {built.deck.indices.length > 0 && (
          <TrimeshCollider args={[built.deck.vertices, built.deck.indices]} friction={0.9} />
        )}
        {built.wideDeck.indices.length > 0 && (
          <TrimeshCollider args={[built.wideDeck.vertices, built.wideDeck.indices]} friction={0.9} />
        )}
        {built.causewayCrown.indices.length > 0 && (
          <TrimeshCollider args={[built.causewayCrown.vertices, built.causewayCrown.indices]} friction={1} />
        )}
        {built.islands.crown.indices.length > 0 && (
          <TrimeshCollider args={[built.islands.crown.vertices, built.islands.crown.indices]} friction={1} />
        )}
      </RigidBody>
    </group>
  );
}
