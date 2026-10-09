'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useGLTF, useTexture } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider, type RapierRigidBody } from '@react-three/rapier';
import { GeometryCollider } from './GeometryCollider';
import { partColliders } from './partColliders';
import {
  GRASS_REPEAT, GRASS_TILE, grassBounds, grassMaterial, makeMottle, prepareGrassTile,
} from './islandGrass';
import {
  BufferGeometry, BoxGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute,
  InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, type Object3D, RepeatWrapping,
  SRGBColorSpace, type Material, type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import airportModels from '@/config/airportModelData.json';
import { PARK } from '@/config/parkConfig';
import { TRAIN } from '@/config/trainConfig';
import {
  BUILDINGS, CAR_PARK_DECK, CONTAINERS, CONTAINER_BOXES, CROSSINGS, DECO, ENTRY, SIDINGS, STABLED, YARD, FUSELAGE, HELIPAD, HELIPADS,
  LIGHTS, MARKS, OUTLINE,
  ENTRY_GATE, PARADE_BOUNDS, PARADE_BUILDINGS, PARADE_LINKS, PARKED, PAVING, PERIMETER,
  PROP_PART, RUNWAY, SITE,
  TAXIWAY, TREE_PART,
  outlineShoelace, perimeterRuns, railPose, shoreAt, sidingCentre,
} from '@/config/airportConfig';
import { ROAD_TOP, ROAD_WIDTH } from '@/config/roadConfig';
import { AirportTraffic } from './AirportTraffic';
import { FreightYard } from './FreightYard';
import IslandRail from './IslandRail';
import { makeBallastTexture } from './CountryRail';
import { IslandRoads } from './IslandRoads';
import { AmusementPark } from './AmusementPark';
import { WallOfDeath } from './WallOfDeath';
import { AquaPark } from './AquaPark';
import { DromeGrounds } from './DromeGrounds';
import { AQUA_BOUNDS, AQUA_PARK_ENABLED } from '@/config/aquaParkConfig';
import { HELI_BOUNDS, HELIPORT_ENABLED } from '@/config/heliportConfig';
import { Heliport } from './Heliport';
import { WALL_OF_DEATH_ENABLED, WOD_BOUNDS } from '@/config/wallOfDeathConfig';
import { collectCityParts, cityPartMatrix, type CityPart } from './cityChunks';
import { SLEEPER_GEOMETRY, SLEEPER_MATERIAL } from './sleeper';
import { RAIL_STEEL, buildLoft, type ProfileVertex } from './railGeometry';

/** The buildings, as `prepare-airport.mjs` leaves them: one mesh per part. */
const AIRPORT_MODEL = '/models/airport.glb';
useGLTF.preload(AIRPORT_MODEL, DRACO_PATH);

/** Halcyon Parade's buildings, extracted one at a time — see `prepare-parade.mjs`. */
const PARADE_MODEL = '/models/parade.glb';
useGLTF.preload(PARADE_MODEL, DRACO_PATH);
useGLTF.preload(ENTRY_GATE.model, DRACO_PATH);



/** A part's measured footprint, which places it and sizes its collider. */
const sizeOf = (part: string): [number, number, number] => {
  const entry = (airportModels.parts as Record<string, { size: number[] }>)[part];
  return entry ? [entry.size[0], entry.size[1], entry.size[2]] : [10, 10, 10];
};

/**
 * Halcyon Field: the island east of the city, and everything on it.
 *
 * All of it is drawn inside one group at `SITE.centre` turned to
 * `SITE.heading`, so every number in `airportConfig` is a local one — +X down
 * the runway, +Z toward the landside. Local y = 0 is the crown, which is why
 * the beach reaches down to `seabed - ground` rather than to the seabed.
 *
 * ## What this reuses rather than models
 *
 * The brief was to lean on the city, and almost nothing here is new geometry:
 *
 *   the planting    and the ground, below — the buildings are no longer city
 *                   chunks. They are eight placements of seven meshes out of
 *                   `airport.glb`, which `prepare-airport.mjs` builds from an
 *                   airfield kit and a terminal concourse. See `BUILDINGS`
 *   the planting    the city's own tree and its own piece of street furniture,
 *                   the same two `IslandTown` scatters round the station
 *   the ground      the railway islands' grass and sand, from `TOWN_PALETTE`,
 *                   so this reads as the same coast rather than a new one
 *
 * What is actually modelled here is the flat stuff, which is boxes: tarmac,
 * paint and lamps. That is the cheap half of an airport and the half that
 * carries it.
 *
 * ## Cost
 *
 * Every static surface is merged to one geometry per material, so the whole
 * airfield — runway, taxiway, links, two aprons, the roads and the car park —
 * is one draw call, the paint is two more, and the lights are four. The
 * buildings are one draw call per distinct part, which for eight placements
 * out of seven meshes is seven — the two hangars share theirs.
 */

/** Where the paving sits over the crown, and the paint over the paving. */
const TARMAC_TOP = 0.06;
const MARK_TOP = TARMAC_TOP + 0.012;
const SLAB = 0.5;

/**
 * How far the sea wall goes down, in the island's own frame.
 *
 * To the seabed, not to the waterline. Stopped at the water it would leave a
 * ring of z-fighting where two surfaces meet at exactly one height; carried
 * under, the sea plane simply cuts it. 7 m of it stands above the water, which
 * is what a reclamation's revetment looks like.
 */
const WALL_BOTTOM = TRAIN.seabed - SITE.ground;
/**
 * The grass: a real photographed lawn under a painted mottle.
 *
 * Both textures, the shader that multiplies them and the reasoning are in
 * `islandGrass`, which the railway islands now share — Kestrel and Gannet were
 * a flat `TOWN_PALETTE.grass` and read as paint next to this from the air.
 * What stays here is this island's own bounding box, which its mottle is laid
 * over, and the fact that its crown carries baked planar UVs so it does not
 * need `planarUv`.
 */
/** The coping: a lip of concrete along the top of the wall, inboard of it. */
const COPING = 1.6;

/** A flat slab: `[fromX, toX, fromZ, toZ]`, top at `top`. */
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
 * Tarmac, as a canvas.
 *
 * The same idea as the town's: a flat grey surface a hundred metres across is
 * a colour, not a material, and what tells the eye it is asphalt is the grain
 * rather than the shade. Drawn once at 128 px and repeated.
 */
function makeTarmac(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#3b3d40';
    ctx.fillRect(0, 0, 128, 128);
    let seed = 11;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    for (let i = 0; i < 2600; i++) {
      const g = 40 + Math.floor(rnd() * 34);
      ctx.fillStyle = `rgb(${g},${g + 2},${g + 4})`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 1.4, 1.4);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(70, 70);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ----------------------------------------------------------------- the grass */

/** This island's own bounding box in its own metres: the mottle's frame. */
const ISLAND_BOUNDS = () => grassBounds([OUTLINE]);
/* ------------------------------------------------------------------ the land */

/**
 * The island itself: a crown fan, and a vertical concrete wall round it.
 *
 * The crown is a triangle fan from the centre, which works only because the
 * outline is star-shaped about it — see `OUTLINE`, where the roughening is
 * done as a radial scale for exactly this reason.
 *
 * The wall replaces the sand batter the railway's islands use. It is a plain
 * extrusion: the same outline at the crown and at the seabed, so the face is
 * dead vertical, with a narrow coping set inboard along the top so the edge
 * reads as a built lip rather than as the place two surfaces happen to meet.
 */
function buildLand() {
  const n = OUTLINE.length;
  const crown: number[] = [0, 0, 0];
  const crownIndex: number[] = [];
  for (const [x, z] of OUTLINE) crown.push(x, 0, z);
  for (let i = 0; i < n; i++) crownIndex.push(0, 1 + i, 1 + ((i + 1) % n));

  const wall: number[] = [];
  const wallIndex: number[] = [];
  for (const [x, z] of OUTLINE) {
    const len = Math.hypot(x, z) || 1;
    // The coping sits a little inboard, so the top of the wall is a flat band
    // rather than a knife edge against the grass.
    wall.push(x - (x / len) * COPING, 0.05, z - (z / len) * COPING);
    wall.push(x, 0.05, z);
    wall.push(x, WALL_BOTTOM, z);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    // The coping band, then the face below it.
    wallIndex.push(a, a + 1, b + 1, a, b + 1, b);
    wallIndex.push(a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }

  const make = (positions: number[], indices: number[], textured = false) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    if (textured) {
      // Planar UVs in island metres for the grass tile; the mottle finds its
      // own place from the vertex position in the shader — see `grassMaterial`.
      const uv: number[] = [];
      for (let i = 0; i < positions.length; i += 3) uv.push(positions[i] / GRASS_REPEAT, positions[i + 2] / GRASS_REPEAT);
      geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    }
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return { geometry, vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
  };
  return { crown: make(crown, crownIndex, true), wall: make(wall, wallIndex) };
}

/* ------------------------------------------------------------- the pavements */

function buildPaving() {
  const parts: BufferGeometry[] = [];
  const R = RUNWAY;
  const T = TAXIWAY;
  parts.push(slab([-R.half, R.half, R.centre - R.width / 2, R.centre + R.width / 2], TARMAC_TOP));
  parts.push(slab([-T.half, T.half, T.centre - T.width / 2, T.centre + T.width / 2], TARMAC_TOP));
  // Between the two edges, NOT between the two centrelines. Run centre to
  // centre, a link's top face lies exactly on the runway's and the taxiway's
  // for twenty metres at each end — two coplanar surfaces at the same height,
  // which is a field of z-fighting that from the air looks like the apron is
  // tearing. Everything else in the paving merely touches along an edge, which
  // is fine; only overlaps fight.
  for (const at of T.links) {
    parts.push(slab([at - T.width / 2, at + T.width / 2,
      R.centre + R.width / 2, T.centre - T.width / 2], TARMAC_TOP));
  }
  /*
   * EVERY rectangle in `PAVING`, not a list of them.
   *
   * This was a hand-written list of fourteen, and adding a fifteenth to the
   * config did not add it to the ground: the freighter's new exit existed as
   * far as every check was concerned and was grass as far as the renderer was.
   * That is a whole class of bug — the config and the drawing disagreeing
   * about what exists — and enumerating the config removes it.
   */
  /*
   * Everything except the two ROADS.
   *
   * `road` and `outerRoad` were slabs — a box of tarmac with a box of paint
   * on top — and they are laid from the modular kit now, by `IslandRoads`,
   * which brings kerbs, pavements, lane markings and pedestrian crossings in
   * its texture. Everything else here is an apron or a hard standing, which
   * is what a slab actually is, so the rest stay.
   *
   * They are still in `PAVING` because half the island is measured off them:
   * the tree line takes its across from `road[3]`, the park hangs its gate
   * off `outerRoad[2]`, and the bridge finds its landing from the outer
   * road's own centreline. Only the drawing moves.
   */
  const LAID_BY_KIT: ReadonlyArray<readonly [number, number, number, number]> = [
    PAVING.road, PAVING.outerRoad,
  ];
  for (const rect of Object.values(PAVING)) {
    if (LAID_BY_KIT.includes(rect)) continue;
    parts.push(slab(rect, TARMAC_TOP));
  }
  return merge(parts);
}

/**
 * The paint.
 *
 * Two geometries, because there are two colours: white for the runway, yellow
 * for everything a wheel is meant to follow on the ground. What is drawn is
 * the set a real strip carries and no more — thresholds, centreline, edges and
 * the two aiming points — because those four are what the eye reads as "runway"
 * and the rest is detail nobody sees from a boat.
 */
function buildMarks() {
  const white: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const R = RUNWAY;
  const T = TAXIWAY;
  const bar = (rect: readonly [number, number, number, number], to: BufferGeometry[]) =>
    to.push(slab(rect, MARK_TOP));
  /**
   * A mark laid on a KIT road rather than on the airfield's own paving.
   *
   * `MARK_TOP` is 0.072 and so is `ROAD_TOP` — the two were set from different
   * ends and landed on the same plane, which for paint on a slab is fine
   * because the slab underneath is at 0.06. On a kit carriageway it is not:
   * the mark and the road surface are coplanar and fight for every pixel of
   * it. Only the entrance's stop line needs this, because it is the only thing
   * painted on a kit road anywhere on the island.
   */
  const barOnKit = (rect: readonly [number, number, number, number], to: BufferGeometry[]) =>
    to.push(slab(rect, ROAD_TOP + 0.006));

  // Thresholds: the piano keys, symmetrical about the centreline.
  const pitch = MARKS.thresholdWidth + MARKS.thresholdGap;
  for (const end of [-1, 1] as const) {
    const from = end * (R.half - 8);
    for (let i = 0; i < MARKS.thresholdBars; i++) {
      const off = (i + 0.5) * pitch;
      for (const side of [-1, 1] as const) {
        const z = R.centre + side * off;
        bar([from - end * MARKS.thresholdLength, from, z - MARKS.thresholdWidth / 2, z + MARKS.thresholdWidth / 2], white);
      }
    }
    // Aiming point: one long block each side of the centreline.
    const aim = end * MARKS.aimingAt;
    for (const side of [-1, 1] as const) {
      const z = R.centre + side * 9;
      bar([aim - MARKS.aimingLength / 2, aim + MARKS.aimingLength / 2, z - MARKS.aimingWidth / 2, z + MARKS.aimingWidth / 2], white);
    }
  }
  // Centreline, dashed, stopping short of the piano keys at each end.
  const reach = R.half - MARKS.thresholdLength - 30;
  for (let x = -reach; x < reach; x += MARKS.centreDash + MARKS.centreGap) {
    bar([x, Math.min(x + MARKS.centreDash, reach), R.centre - MARKS.centreWidth / 2, R.centre + MARKS.centreWidth / 2], white);
  }
  // Edge lines, solid, the full length.
  for (const side of [-1, 1] as const) {
    const z = R.centre + side * (R.width / 2 - 1.2);
    bar([-R.half, R.half, z - MARKS.edgeWidth / 2, z + MARKS.edgeWidth / 2], white);
  }
  // Taxiway centreline: continuous, and round each link — a taxiway line never
  // stops, which is the whole point of it.
  bar([-T.half, T.half, T.centre - 0.5, T.centre + 0.5], yellow);
  for (const at of T.links) {
    bar([at - 0.5, at + 0.5, R.centre, T.centre], yellow);
  }
  // Stand markings on the apron: six lead-in lines off the taxiway, each
  // ending in the stop bar an aircraft's nosewheel would be parked on.
  for (let i = 0; i < 6; i++) {
    const x = -190 + i * 78;
    bar([x - 0.5, x + 0.5, -46, 40], yellow);
    bar([x - 13, x + 13, 39, 40], yellow);
  }
  // The apron taxilane: the line an aircraft follows PAST the stands rather
  // than into one. Without it the lead-in lines start from nothing.
  bar([PAVING.apron[0], PAVING.cargo[1], -31, -30], yellow);
  // Two more stands on the cargo apron, off the same taxilane.
  for (const x of [300, 340]) {
    bar([x - 0.5, x + 0.5, -30, 46], yellow);
    bar([x - 13, x + 13, 45, 46], yellow);
  }
  // Hold-short bars: the ladder across each link where it meets the runway
  // strip. Four rungs, which is what the real marking is.
  for (const at of T.links) {
    for (let k = 0; k < 4; k++) {
      const z = R.centre + R.width / 2 + 16 + k * 1.8;
      bar([at - T.width / 2, at + T.width / 2, z, z + 0.9], yellow);
    }
  }
  /*
   * No painted lane lines on the outer road.
   *
   * They were drawn here because the road was a bare slab, and 14 m of tarmac
   * with nothing on it does not read as a dual carriageway. The kit's own
   * texture carries the markings now, with the kerbs and the crossings, so
   * painting more on top would be two sets of lines fighting for the surface.
   */
  // Car park bays: two banks either side of a central aisle. This is the one
  // piece of paint that does the most work — an unmarked slab of tarmac the
  // size of the terminal reads as nothing at all.
  const [px0, px1, pz0, pz1] = PAVING.carPark;
  const aisle = (pz0 + pz1) / 2;
  for (let x = px0 + 2; x <= px1 - 2; x += 2.6) {
    bar([x, x + 0.25, pz0 + 1.5, aisle - 3], white);
    bar([x, x + 0.25, aisle + 3, pz1 - 1.5], white);
  }
  /*
   * The approach gets ONE painted mark: the stop line at the gate.
   *
   * It used to get an edge line and a dashed lane line down each of its two
   * carriageways, because it was a blank slab and every line on it had to be
   * drawn. It is a kit road now and the kit carries its lanes, its kerbs and
   * its crossings in its own texture — so all of that came out, and painting
   * it again would be a second set of lane lines a few centimetres over the
   * first.
   *
   * A stop line is the one thing the kit has no piece for, and the one thing
   * this road needs that an ordinary link does not. Across the ARRIVING half
   * only: the other half is leaving, and a stop line facing the wrong way is
   * worse than none. Arrivals run up the west half (`along` below centre).
   */
  barOnKit(
    [ENTRY.centre - ENTRY.half + 0.6, ENTRY.centre - 0.3,
      ENTRY.gate.stopLine, ENTRY.gate.stopLine + 0.5],
    white,
  );
  /*
   * The landside road has no hand-painted centreline any more.
   *
   * It had one — dashed, down the middle, from when the road was a slab and a
   * slab has no markings of its own. The road has been kit for some time and
   * the kit carries four painted lanes in its texture, so this was a second
   * centreline drawn over the first. Worse, it was drawn AT the same height:
   * `MARK_TOP` and `ROAD_TOP` are both 0.072, which is coplanar, so the two
   * fought for every pixel of a 573 m road. Gone with the entrance's own
   * painted lanes and for the same reason — see the stop line above, which is
   * the one mark on this island that still belongs on a kit carriageway.
   */
  return { white: merge(white), yellow: merge(yellow) };
}

/**
 * One 40 ft box, cut out of the city's own container chunk.
 *
 * `deco_container1_-1_0` looks like a single lump of scenery and is not: split
 * into connected components — triangles that share vertices — it is individual
 * containers, each twelve triangles, each 12.28 x 2.60 x 2.80 m. So the yard
 * does not need a container modelled for it. It needs one taken out of the
 * chunk the city already ships and instanced.
 *
 * The component picked is the one whose long side is nearest a 40 ft box, so a
 * chunk that happens to hold a wider stack as well still yields the right
 * piece. Recentred on its own footprint and stood on y = 0, which is the same
 * convention every airport part uses: placing one is then an (x, y, z).
 */
function extractContainer(part: CityPart | undefined): BufferGeometry | null {
  if (!part) return null;
  const src = part.geometry;
  const position = src.getAttribute('position');
  const index = src.getIndex();
  if (!position || !index) return null;

  /*
   * Grouping the triangles into boxes, in two passes.
   *
   * The first pass is union-find over shared vertex INDICES, and on its own it
   * is wrong here — a box exported with per-face normals has four vertices per
   * face and shares none between them, so it comes back as six flat quads. The
   * first version cut one of those out and instanced it: the yard was full of
   * containers measuring 12.28 x **0.00** x 2.80.
   *
   * So a second pass merges any two groups whose bounding boxes touch, which
   * puts a box's six faces back together and leaves neighbouring containers
   * apart, because they are stacked with a gap. Cheap either way — the whole
   * chunk is twenty-four triangles.
   */
  const parent = new Int32Array(position.count);
  for (let i = 0; i < parent.length; i += 1) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  const union = (a2: number, b2: number) => { const ra = find(a2); const rb = find(b2); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < index.count; i += 3) {
    union(index.getX(i), index.getX(i + 1));
    union(index.getX(i + 1), index.getX(i + 2));
  }

  interface Piece { tris: number[]; lo: number[]; hi: number[] }
  const byVertex = new Map<number, Piece>();
  for (let i = 0; i < index.count; i += 3) {
    const key = find(index.getX(i));
    let piece = byVertex.get(key);
    if (!piece) {
      piece = { tris: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
      byVertex.set(key, piece);
    }
    piece.tris.push(i);
    for (let k = 0; k < 3; k += 1) {
      const v = index.getX(i + k);
      for (let axis = 0; axis < 3; axis += 1) {
        const c = position.getComponent(v, axis);
        piece.lo[axis] = Math.min(piece.lo[axis], c);
        piece.hi[axis] = Math.max(piece.hi[axis], c);
      }
    }
  }

  // Second pass: fuse pieces whose boxes touch, until nothing more fuses.
  const pieces = [...byVertex.values()];
  const TOUCH = 0.05;
  for (let fused = true; fused;) {
    fused = false;
    outer: for (let i = 0; i < pieces.length; i += 1) {
      for (let j = i + 1; j < pieces.length; j += 1) {
        const a2 = pieces[i];
        const b2 = pieces[j];
        const apart = [0, 1, 2].some((k) => a2.lo[k] - b2.hi[k] > TOUCH || b2.lo[k] - a2.hi[k] > TOUCH);
        if (apart) continue;
        a2.tris.push(...b2.tris);
        for (let k = 0; k < 3; k += 1) {
          a2.lo[k] = Math.min(a2.lo[k], b2.lo[k]);
          a2.hi[k] = Math.max(a2.hi[k], b2.hi[k]);
        }
        pieces.splice(j, 1);
        fused = true;
        break outer;
      }
    }
  }

  let best: { tris: number[]; lo: number[]; hi: number[]; miss: number } | null = null;
  for (const piece of pieces) {
    // Nearest to a 40 ft box on all three axes. Length alone is not enough —
    // a flat top face matches on length and width and has no height at all.
    const miss = Math.abs((piece.hi[0] - piece.lo[0]) - CONTAINERS.box.long)
      + Math.abs((piece.hi[1] - piece.lo[1]) - CONTAINERS.box.high)
      + Math.abs((piece.hi[2] - piece.lo[2]) - CONTAINERS.box.wide);
    if (!best || miss < best.miss) best = { ...piece, miss };
  }
  if (!best) return null;

  const normal = src.getAttribute('normal');
  const uv = src.getAttribute('uv');
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const cx = (best.lo[0] + best.hi[0]) / 2;
  const cz = (best.lo[2] + best.hi[2]) / 2;
  for (const t of best.tris) {
    for (let k = 0; k < 3; k += 1) {
      const v = index.getX(t + k);
      pos.push(
        position.getComponent(v, 0) - cx,
        position.getComponent(v, 1) - best.lo[1],
        position.getComponent(v, 2) - cz,
      );
      if (normal) nrm.push(normal.getComponent(v, 0), normal.getComponent(v, 1), normal.getComponent(v, 2));
      if (uv) uvs.push(uv.getComponent(v, 0), uv.getComponent(v, 1));
    }
  }
  /*
   * The one-line report the city, the airport and the fleet all print, and
   * here it earns its place more than most: a bad cut gives no error, just a
   * yard of wrong-shaped boxes. The first version printed 12.28 x **0.00** x
   * 2.80 and that number is the whole diagnosis.
   */
  console.info(`[containers] cut a ${(best.hi[0] - best.lo[0]).toFixed(2)} x `
    + `${(best.hi[1] - best.lo[1]).toFixed(2)} x ${(best.hi[2] - best.lo[2]).toFixed(2)} m box `
    + `from ${pieces.length} in the chunk `
    + `(want ${CONTAINERS.box.long} x ${CONTAINERS.box.high} x ${CONTAINERS.box.wide})`);
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  if (nrm.length) out.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  if (uvs.length) out.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  if (!nrm.length) out.computeVertexNormals();
  return out;
}

/**
 * The city's container texture, with the blue taken out of it.
 *
 * The photograph is of a blue container, and `instanceColor` multiplies — so
 * a red livery over a blue skin comes out nearly black, and every box in the
 * yard would be a different shade of navy. Taking the luminance once at load
 * keeps every corrugation, door bar and scuff in the photograph and leaves a
 * neutral the liveries can multiply over.
 *
 * Lifted and brightened as it goes: a straight luminance of a dark blue is
 * dark, and a livery multiplied over THAT is black. `flipY` is copied rather
 * than defaulted — glTF textures are `false` and a `CanvasTexture` is `true`,
 * and getting it wrong prints the container upside down.
 */
function neutralise(map: Texture | null): CanvasTexture | null {
  const image = map?.image as (HTMLImageElement | ImageBitmap | null);
  if (!map || !image) return null;
  const w = image.width;
  const h = image.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const v = Math.min(255, luma * 1.6 + 30);
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = map.flipY;
  texture.wrapS = map.wrapS;
  texture.wrapT = map.wrapT;
  texture.anisotropy = 4;
  return texture;
}

/**
 * The container yard: the city's own box, instanced and tinted.
 *
 * One draw call for the lot. `setColorAt` is what earns it — sixteen boxes in
 * six liveries off one geometry and one texture, where a mesh per livery would
 * be six of each.
 */
function Containers({ part }: { part: CityPart | undefined }) {
  const mesh = useRef<InstancedMesh>(null);
  const built = useMemo(() => {
    const geometry = extractContainer(part);
    const source = part?.material;
    const first = Array.isArray(source) ? source[0] : source;
    const map = (first as MeshStandardMaterial | undefined)?.map ?? null;
    return { geometry, skin: neutralise(map) };
  }, [part]);

  useEffect(() => () => {
    built.geometry?.dispose();
    built.skin?.dispose();
  }, [built]);

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !built.geometry) return;
    const m = new Matrix4();
    const turn = new Matrix4();
    const c = new Color();
    CONTAINER_BOXES.forEach((box, i) => {
      m.makeTranslation(box.x, box.y, box.z);
      if (box.turn) m.multiply(turn.makeRotationY(box.turn));
      instanced.setMatrixAt(i, m);
      instanced.setColorAt(i, c.set(box.colour));
    });
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [built]);

  if (!built.geometry || !CONTAINER_BOXES.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[built.geometry, undefined, CONTAINER_BOXES.length]}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial map={built.skin} roughness={0.85} metalness={0.15} />
    </instancedMesh>
  );
}

/**
 * The freight sidings: ballast, rails and buffer stops — see `SIDINGS`.
 *
 * Three straight roads, so none of the main line's machinery is needed. What
 * IS shared is the track itself: `TRAIN`'s gauge and sleeper spacing, the
 * monobloc `SLEEPER_GEOMETRY` every other piece of track in the game
 * instances, and `RAIL_STEEL`. Building a siding out of its own brown boxes
 * beside the railway's grey concrete is exactly the mismatch `sleeper.ts` was
 * written to end.
 *
 * The ballast is a trapezoid rather than a slab: a shoulder that batters out
 * to the grass is most of what reads as ballast from above, and a box reads as
 * a grey stripe painted on the field.
 */
interface RailSample {
  x: number;
  z: number;
  nx: number;
  nz: number;
  arc: number;
  y: number;
}

/**
 * One road's centreline, as loft samples.
 *
 * A road runs straight down its own `along` from the buffer stops, and — if it
 * has a turnout — eases across onto the neck over `transition` metres and
 * STOPS there. The ease is a smoothstep, which is what a turnout and its
 * closure rails actually look like from any distance worth looking from: a
 * gentle S rather than a kink.
 *
 * The neck itself has no turnout and runs on past all of them.
 */
function roadSamples(
  road: { at: number; from: number; merge: number | null; onto: number | null },
): RailSample[] {
  // The centreline itself is `sidingCentre`, in the config, because the
  // minimap draws these roads as well and two copies of a turnout's easing is
  // two railways. This adds what a LOFT needs and the map does not: the arc
  // length along the road, and the normal at every sample.
  //
  // Which main a road joins is the config's business too. 488 joins the UP
  // main at 476, not the down main at 464 — easing it onto 464 would carry it
  // straight across the up main's own straight, which is the one mistake a
  // two-road throat makes.
  const out: RailSample[] = [];
  let arc = 0;
  let previous: [number, number] | null = null;
  for (const [x, z] of sidingCentre(road)) {
    if (previous) arc += Math.hypot(x - previous[0], z - previous[1]);
    out.push({ x, z, nx: 1, nz: 0, arc, y: 0 });
    previous = [x, z];
  }
  // The normal is the tangent turned a right angle, so the profile stays
  // square to the track through the ease instead of shearing across it.
  for (let i = 0; i < out.length; i++) {
    const a2 = out[Math.max(0, i - 1)];
    const b2 = out[Math.min(out.length - 1, i + 1)];
    const dx = b2.x - a2.x;
    const dz = b2.z - a2.z;
    const len = Math.hypot(dx, dz) || 1;
    out[i].nx = dz / len;
    out[i].nz = -dx / len;
  }
  return out;
}

/**
 * The freight terminal's track, lofted the way the main line's is.
 *
 * Built with `buildLoft` rather than by hand, and that is the whole point of
 * the rewrite: the first version swept its own prisms and got **every one of
 * the six faces wound inside out**, so the ballast faced inward and was not
 * drawn at all — the sleepers sat on grass for several passes before anyone
 * saw it. `buildLoft` derives which way a face points from the profile's own
 * signed area instead of trusting whoever wrote the index list. It is also
 * what lets a road curve at all: a hand-swept box only ever went straight.
 *
 * Profiles are the main line's own shapes at this yard's shallower depth: a
 * ballast section that batters out to the formation, and a rail section per
 * rail at the gauge.
 */
/**
 * Metres of line per texture repeat, and it is nine because that is what
 * `CountryRail`'s ballast texture bakes into its own `repeat`. It was six, and
 * six tiled the same stone half again as coarse as the stone on every other
 * railway in the game — including the island line running past the end of
 * these very sidings.
 */
const YARD_V_SCALE = 9;

function buildYardTrack() {
  const S = SIDINGS;
  const B = S.ballast;
  const toe = B.crownHalf + B.slope * B.depth;
  const railBase = B.depth + TRAIN.sleeperHeight;

  const ballastProfile: ProfileVertex<RailSample>[] = [
    { off: -toe, rise: 0 },
    { off: -B.crownHalf, rise: B.depth },
    { off: B.crownHalf, rise: B.depth },
    { off: toe, rise: 0 },
  ];
  const railProfile = (side: number): ProfileVertex<RailSample>[] => {
    const at = side * TRAIN.gauge / 2;
    const half = TRAIN.railWidth / 2;
    return [
      { off: at - half, rise: railBase },
      { off: at + half, rise: railBase },
      { off: at + half, rise: railBase + TRAIN.railHeight },
      { off: at - half, rise: railBase + TRAIN.railHeight },
    ];
  };

  const ballast: BufferGeometry[] = [];
  const rails: BufferGeometry[] = [];
  const stops: BufferGeometry[] = [];
  const sleepers: Array<{ x: number; z: number; turn: number }> = [];

  for (const road of S.roads) {
    const samples = roadSamples(road);
    ballast.push(buildLoft(samples, ballastProfile, { vScale: YARD_V_SCALE }).geometry);
    for (const side of [-1, 1]) {
      rails.push(buildLoft(samples, railProfile(side), { vScale: YARD_V_SCALE, closed: true }).geometry);
    }
    // Sleepers at the railway's own spacing, square to the track.
    let next = 0;
    for (let i = 1; i < samples.length; i++) {
      const a2 = samples[i - 1];
      const b2 = samples[i];
      while (next <= b2.arc) {
        const t = (next - a2.arc) / ((b2.arc - a2.arc) || 1);
        sleepers.push({
          x: a2.x + (b2.x - a2.x) * t,
          z: a2.z + (b2.z - a2.z) * t,
          turn: Math.atan2(b2.x - a2.x, b2.z - a2.z),
        });
        next += TRAIN.sleeperSpacing;
      }
    }
    // A buffer stop at the south end: a baulk across the rails on two legs.
    const beam = new BoxGeometry(S.stop.width, S.stop.thick, S.stop.thick);
    beam.translate(road.at, railBase + S.stop.height, road.from + 1.2);
    stops.push(beam);
    for (const side of [-1, 1] as const) {
      const leg = new BoxGeometry(S.stop.thick * 0.7, S.stop.height, S.stop.thick * 0.7);
      leg.translate(road.at + side * TRAIN.gauge / 2, railBase + S.stop.height / 2, road.from + 1.2);
      stops.push(leg);
    }
  }

  /* ------------------------------------------------------- the goods dock -- */
  const P = S.platform;
  const deck: BufferGeometry[] = [];
  const edge: BufferGeometry[] = [];
  const [pz0, pz1] = P.across;

  deck.push(slabAt(P.from, P.to, pz0, pz1, P.height));
  for (const face of [P.from, P.to] as const) {
    const side = face === P.from ? 1 : -1;
    edge.push(slabAt(face, face + side * P.edge, pz0, pz1, P.height + 0.03));
  }
  // Ramps at both ends. A dock nothing can drive onto is a wall with a flat
  // top; these rise the deck's full height over `ramp` metres, about 1 in 7.
  for (const end of [-1, 1] as const) {
    const at = end < 0 ? pz0 : pz1;
    const out = at + end * P.ramp;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([
      P.from, 0, out, P.to, 0, out, P.from, P.height, at, P.to, P.height, at,
    ], 3));
    // A uv nothing samples, and not optional: `mergeGeometries` refuses a set
    // whose attributes differ, and every `BoxGeometry` here has one.
    g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(8), 2));
    g.setIndex(end < 0 ? [0, 3, 1, 0, 2, 3] : [0, 1, 3, 0, 3, 2]);
    g.computeVertexNormals();
    deck.push(g);
  }

  /* --------------------------------------------------------- the floodlights */
  const masts: BufferGeometry[] = [];
  const lamps: BufferGeometry[] = [];
  const M = YARD.masts;
  for (const [x, z] of M.at) {
    // A tapered column, as a stack of shortening boxes — a cone reads as a
    // chimney, and a lattice mast is not worth its triangles at this range.
    const tiers = 5;
    for (let k = 0; k < tiers; k++) {
      const t0 = k / tiers;
      const t1 = (k + 1) / tiers;
      const half = M.foot + (M.head - M.foot) * ((t0 + t1) / 2);
      const box = new BoxGeometry(half * 2, M.height / tiers, half * 2);
      box.translate(x, M.height * (t0 + t1) / 2, z);
      masts.push(box);
    }
    const rig = new BoxGeometry(M.rig.width, 0.3, M.rig.deep);
    rig.translate(x, M.height + 0.15, z);
    masts.push(rig);
    for (let k = 0; k < M.rig.lamps; k++) {
      const at = -M.rig.width / 2 + (k + 0.5) * (M.rig.width / M.rig.lamps);
      const lamp = new BoxGeometry(0.62, 0.42, 0.5);
      lamp.translate(x + at, M.height + 0.5, z);
      lamps.push(lamp);
    }
  }

  /* ------------------------------------------------------- the hardstanding */
  const paving: BufferGeometry[] = [];
  for (const r of [
    YARD.hardstanding, YARD.headland, YARD.lorryPark, YARD.siloRoad,
    YARD.northTip,
  ]) {
    paving.push(slabAt(r[0], r[1], r[2], r[3], TARMAC_TOP));
  }

  /*
   * ...and the level crossing, laid with it.
   *
   * Built HERE, in the apron's own geometry, rather than in `FreightYard`
   * where the rest of the crossing is. It had a grey of its own and it was
   * wrong in a way that is obvious the moment you see it: pale panels laid
   * over a dark apron, reading as a little bridge. A level crossing is the
   * SAME surface as the road, carried over the rails — so it is the same
   * mesh, the same colour and the same tarmac texture, and the only thing
   * that differs is that it sits at railhead height instead of on the ground.
   *
   * ## One deck across all five roads, and ramps at the two ends
   *
   * The railhead is 0.78 m up. Decked road by road that is a 780 mm step in
   * and out of each of five crossings, and the 4 m between two ballast
   * shoulders is nowhere near enough to ramp it — so the deck runs unbroken
   * from the first road's west shoulder to the last road's east one, with a
   * slot left at each rail so the rail still stands proud and the flangeway
   * is open. `CROSSINGS.ramp` metres of 1 in 15 at each end is what a vehicle
   * actually drives up. See `CROSSINGS`.
   */
  const C = CROSSINGS;
  const railTop = B.depth + TRAIN.sleeperHeight + TRAIN.railHeight;
  const inner = TRAIN.gauge / 2 - TRAIN.railWidth / 2;
  const outer = TRAIN.gauge / 2 + TRAIN.railWidth / 2;

  for (const lane of C.lanes) {
    const crossed = S.roads.filter((r) => !lane.roads || lane.roads.includes(r.at));
    if (!crossed.length) continue;
    const ends = crossed.map((r) => r.at);
    const deckFrom = Math.min(...ends) - C.panel;
    const deckTo = Math.max(...ends) + C.panel;

    // The rails are the gaps; everything between them is decked.
    const slots = crossed.flatMap((r) => (
      [[r.at - outer, r.at - inner], [r.at + outer, r.at + inner]]
    )).map(([p, q]) => [Math.min(p, q), Math.max(p, q)] as const)
      .sort((p, q) => p[0] - q[0]);
    let cut = deckFrom;
    for (const [gap0, gap1] of slots) {
      if (gap0 > cut) paving.push(deckSlab(cut, gap0, railTop, lane));
      cut = Math.max(cut, gap1);
    }
    if (cut < deckTo) paving.push(deckSlab(cut, deckTo, railTop, lane));

    // The approach ramps, as slabs tilted about the across axis.
    const slope = Math.hypot(C.ramp, railTop);
    const angle = Math.atan2(railTop, C.ramp);
    for (const side of [-1, 1] as const) {
      const g = new BoxGeometry(slope, SLAB, lane.to - lane.from);
      // Rising eastward on the west approach, falling on the east one.
      g.rotateZ(side > 0 ? -angle : angle);
      g.translate(
        side > 0 ? deckTo + C.ramp / 2 : deckFrom - C.ramp / 2,
        railTop / 2 - (SLAB / 2) * Math.cos(angle),
        (lane.from + lane.to) / 2,
      );
      paving.push(g);
    }
  }

  return {
    ballast: merge(ballast),
    rails: merge(rails),
    stops: merge(stops),
    deck: merge(deck),
    edge: merge(edge),
    masts: merge(masts),
    lamps: merge(lamps),
    paving: merge(paving),
    sleepers,
  };
}

/**
 * One panel of the level crossing: the road's width, from the ground up to
 * the railhead. Not `slabAt`, which hangs a 0.5 m slab below its top and
 * would leave this one floating two hundred millimetres over the grass
 * between two ballast banks.
 */
function deckSlab(
  x0: number, x1: number, top: number, lane: { from: number; to: number },
): BoxGeometry {
  const g = new BoxGeometry(Math.abs(x1 - x0), top, Math.abs(lane.to - lane.from));
  g.translate((x0 + x1) / 2, top / 2, (lane.from + lane.to) / 2);
  return g;
}

/** A flat slab between two `along` and two `across` lines, top at `top`. */
function slabAt(x0: number, x1: number, z0: number, z1: number, top: number): BoxGeometry {
  const g = new BoxGeometry(Math.abs(x1 - x0), SLAB, Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, top - SLAB / 2, (z0 + z1) / 2);
  return g;
}

/** Every sleeper on every road, as one instanced draw. */
function Sleepers({ at }: { at: ReadonlyArray<{ x: number; z: number; turn: number }> }) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const m = new Matrix4();
    const spin = new Matrix4();
    // `SLEEPER_GEOMETRY` has +x across the track and +z along it, so a sleeper
    // only needs the yaw of the road under it — zero on the straights, and
    // the ease's own angle through a turnout.
    at.forEach((s, i) => {
      m.makeTranslation(s.x, SIDINGS.ballast.depth, s.z);
      if (s.turn) m.multiply(spin.makeRotationY(s.turn));
      instanced.setMatrixAt(i, m);
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [at]);

  if (!at.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[SLEEPER_GEOMETRY, SLEEPER_MATERIAL, at.length]}
      castShadow
      receiveShadow
    />
  );
}

/**
 * What is standing in the yard.
 *
 * Every model is one the railway already ships, and the list is FIXED rather
 * than derived from `STABLED` — `useGLTF` is a hook and a hook cannot be
 * called a different number of times for a yard with tanks in it than for one
 * without. `FreightTrain` loads its rake the same way and for the same reason.
 *
 * Nothing here moves. A stabled wagon is scenery, and giving these the rake
 * logic would mean giving them a route on an island whose track joins nothing.
 */
const STABLED_MODELS = [
  '/models/train08.glb',
  '/models/wagonBoxcar.glb',
  '/models/wagonFlat40.glb',
  '/models/wagonFlat20.glb',
  '/models/wagonTank.glb',
  '/models/wagonHopper.glb',
] as const;
for (const model of STABLED_MODELS) useGLTF.preload(model, DRACO_PATH);

function StabledStock() {
  /*
   * One `useGLTF` per line, written out.
   *
   * Not a `.map` over `STABLED_MODELS`, however much it wants to be: `useGLTF`
   * is a hook, and a hook inside a callback is a hook React cannot count. The
   * list is fixed anyway — the same reason `FreightTrain` loads all five of
   * its models whichever rake it is running.
   */
  const shunter = useGLTF(STABLED_MODELS[0], DRACO_PATH).scene;
  const boxcar = useGLTF(STABLED_MODELS[1], DRACO_PATH).scene;
  const flat40 = useGLTF(STABLED_MODELS[2], DRACO_PATH).scene;
  const flat20 = useGLTF(STABLED_MODELS[3], DRACO_PATH).scene;
  const tank = useGLTF(STABLED_MODELS[4], DRACO_PATH).scene;
  const hopper = useGLTF(STABLED_MODELS[5], DRACO_PATH).scene;
  const scenes = useMemo(
    () => [shunter, boxcar, flat40, flat20, tank, hopper],
    [shunter, boxcar, flat40, flat20, tank, hopper],
  );
  const railTop = SIDINGS.ballast.depth + TRAIN.sleeperHeight + TRAIN.railHeight;

  const placed = useMemo(() => {
    const byModel = new Map(STABLED_MODELS.map((model, i) => [model, scenes[i]]));
    return STABLED.map((v, i) => {
      const source = byModel.get(v.model as typeof STABLED_MODELS[number]);
      if (!source) return null;
      const object = source.clone(true);
      object.traverse((child) => {
        if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      // The models are grounded on their own railhead, so they sit at the top
      // of the rail rather than on the ballast.
      //
      // And they sit where the RAIL is, not where the road's straight is. Past
      // its turnout a road eases onto the main, and `v.road` is only the
      // straight part of it — two vans on yard 2's ease were standing 3.3 m
      // and 10.9 m out in the ballast. `railPose` runs the same easing the
      // track is lofted along, and gives the yaw with it, so a vehicle on a
      // curve is turned to match instead of sitting square across it.
      const road = SIDINGS.roads.find((r) => r.at === v.road);
      const pose = road ? railPose(road, v.at) : { along: v.road, turn: 0 };
      object.position.set(pose.along, railTop, v.at);
      object.rotation.y = pose.turn;
      return { key: `${v.model}-${i}`, object: object as Object3D };
    }).filter((p): p is { key: string; object: Object3D } => p !== null);
  }, [scenes, railTop]);

  useEffect(() => {
    console.info(`[yard] ${placed.length} vehicles stabled on ${SIDINGS.roads.length} roads`);
    return () => {
      for (const p of placed) p.object.traverse((child) => {
        if (child instanceof Mesh) child.geometry.dispose();
      });
    };
  }, [placed]);

  return <>{placed.map((p) => <primitive key={p.key} object={p.object} />)}</>;
}

/**
 * The entrance: the reservation, the gate and the sign gantry.
 *
 * Boxes, merged by material, which is six draw calls for the whole thing. It
 * is the same construction the level crossing and the perimeter wall use, and
 * for the same reason: every piece of it is a cuboid, and a cuboid drawn from
 * a shared geometry costs less than any model of one would.
 *
 * The barrier arms are drawn RAISED — see `ENTRY.gate`. An arm lying across
 * the road is a wall across the only entrance on the island, and a raised one
 * is what a barrier looks like nearly all the time anyway.
 */
function buildEntry() {
  const E = ENTRY;
  const posts: BufferGeometry[] = [];
  const arms: BufferGeometry[] = [];
  const bands: BufferGeometry[] = [];
  const hut: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const board: BufferGeometry[] = [];

  const box = (
    w: number, h: number, d: number, x: number, y: number, z: number, to: BufferGeometry[],
  ) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y, z);
    to.push(g);
  };

  /* ------------------------------------------------------------- the gate -- */
  const G = E.gate;
  // One pivot outside each kerb, with the arm standing up out of it and a
  // banded sleeve at the top. Lowered, the two would meet over the crown.
  const reach = E.half + G.arm.clear;
  for (const side of [-1, 1] as const) {
    const at = E.centre + side * reach;
    box(0.34, G.arm.pivot, 0.34, at, G.arm.pivot / 2, G.at, posts);
    box(G.arm.thick, reach, G.arm.thick, at, G.arm.pivot + reach / 2, G.at, arms);
    // Three bands up the arm: what makes a white pole read as a boom.
    for (let k = 0; k < 3; k++) {
      const y = G.arm.pivot + 1.4 + k * 2.2;
      if (y > G.arm.pivot + reach - 0.5) continue;
      box(G.arm.thick + 0.02, 0.7, G.arm.thick + 0.02, at, y, G.at, bands);
    }
  }
  // The gatehouse on the east verge, glazed on the side it watches the road
  // from, with a slab roof oversailing it.
  const H = G.hut;
  const hutAt = E.centre + H.off;
  box(H.width, H.height, H.depth, hutAt, H.height / 2, H.at, hut);
  box(H.width + 0.7, 0.16, H.depth + 0.7, hutAt, H.height + 0.08, H.at, hut);
  box(0.06, H.height * 0.5, H.depth * 0.7,
    hutAt - H.width / 2 - 0.02, H.height * 0.6, H.at, glass);

  /* ---------------------------------------------------------- the gantry -- */
  const Y = E.gantry;
  const span = (E.half + Y.clear) * 2;
  for (const side of [-1, 1] as const) {
    box(Y.post, Y.height, Y.post, E.centre + side * (span / 2), Y.height / 2, Y.at, posts);
  }
  box(span + Y.post, Y.beam, Y.post * 1.2, E.centre, Y.height + Y.beam / 2, Y.at, posts);
  box(Y.board.width, Y.board.height, 0.14,
    E.centre, Y.height - Y.board.height / 2 - 0.3, Y.at, board);

  return {
    posts: merge(posts),
    arms: merge(arms),
    bands: merge(bands),
    hut: merge(hut),
    glass: merge(glass),
    board: merge(board),
  };
}

/**
 * The two elevated helipads, as four merged geometries.
 *
 * A box for every bar of the grille sounds expensive and is not: the deck is
 * 26 m across at a 1.15 m pitch, so it is about forty-five bars a pad and they
 * all merge into one geometry. What it buys is the thing that makes an
 * elevated pad read as a structure rather than a grey square — you can see the
 * grass through it, and the shadow it casts is striped.
 *
 * Four pieces because there are four materials: the frame and legs, the
 * grille, the safety rim, and the painted H.
 */
function buildHelipads() {
  const frame: BufferGeometry[] = [];
  const grille: BufferGeometry[] = [];
  const rim: BufferGeometry[] = [];
  const mark: BufferGeometry[] = [];
  const lights: Array<[number, number]> = [];
  const H = HELIPAD;
  const top = H.height;
  const deckBottom = top - H.deck;

  for (const pad of HELIPADS) {
    const { x: cx, z: cz } = pad;
    const inner = H.half - H.rimDepth;
    // Legs, one at each corner, set in from the edge so the deck oversails.
    for (const sx of [-1, 1] as const) for (const sz of [-1, 1] as const) {
      const lx = cx + sx * (H.half - 2.6);
      const lz = cz + sz * (H.half - 2.6);
      const leg = new BoxGeometry(H.legWidth, deckBottom, H.legWidth);
      leg.translate(lx, deckBottom / 2, lz);
      frame.push(leg);
    }
    // The deck's structural frame: a beam round all four edges, under the top.
    for (const [a, b, c, d] of [
      [-H.half, H.half, -H.half, -H.half + 0.9],
      [-H.half, H.half, H.half - 0.9, H.half],
      [-H.half, -H.half + 0.9, -H.half, H.half],
      [H.half - 0.9, H.half, -H.half, H.half],
    ]) {
      const beam = new BoxGeometry(Math.abs(b - a), H.deck, Math.abs(d - c));
      beam.translate(cx + (a + b) / 2, deckBottom + H.deck / 2, cz + (c + d) / 2);
      frame.push(beam);
    }
    // The grille: bars both ways, so it reads as grating rather than decking.
    const bars = (across: boolean) => {
      for (let o = -inner; o <= inner + 0.001; o += H.gap) {
        const g = across
          ? new BoxGeometry(H.slat, 0.16, inner * 2)
          : new BoxGeometry(inner * 2, 0.16, H.slat);
        g.translate(cx + (across ? o : 0), top - 0.08, cz + (across ? 0 : o));
        grille.push(g);
      }
    };
    bars(true);
    bars(false);
    // The safety rim: a bright kerb round the edge of the deck.
    for (const [a, b, c, d] of [
      [-H.half, H.half, -H.half, -inner],
      [-H.half, H.half, inner, H.half],
      [-H.half, -inner, -inner, inner],
      [inner, H.half, -inner, inner],
    ]) {
      const k = new BoxGeometry(Math.abs(b - a), 0.34, Math.abs(d - c));
      k.translate(cx + (a + b) / 2, top + 0.09, cz + (c + d) / 2);
      rim.push(k);
    }
    // The H, which is the one marking a helipad cannot do without.
    const arm = inner * 0.62;
    for (const sx of [-1, 1] as const) {
      const leg = new BoxGeometry(H.markWidth, 0.06, arm * 2);
      leg.translate(cx + sx * arm * 0.62, top + 0.05, cz);
      mark.push(leg);
    }
    const cross = new BoxGeometry(arm * 1.24, 0.06, H.markWidth);
    cross.translate(cx, top + 0.05, cz);
    mark.push(cross);
    // Green perimeter lights, the way a real pad is edge-lit.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      lights.push([cx + Math.cos(a) * (H.half + 0.6), cz + Math.sin(a) * (H.half + 0.6)]);
    }
  }
  return {
    frame: merge(frame), grille: merge(grille), rim: merge(rim), mark: merge(mark), lights,
  };
}

/** Lamp positions, by colour. */
function buildLights() {
  const edge: Array<[number, number]> = [];
  const threshold: Array<[number, number]> = [];
  const stop: Array<[number, number]> = [];
  const taxi: Array<[number, number]> = [];
  const R = RUNWAY;
  const T = TAXIWAY;
  const half = R.width / 2 + 2;
  for (let x = -R.half; x <= R.half + 0.1; x += LIGHTS.edgeSpacing) {
    edge.push([x, R.centre - half], [x, R.centre + half]);
  }
  // Green at the west threshold, red at the east stop end, plus an approach
  // line running out over the grass beyond each.
  for (let i = 0; i < 9; i++) {
    const z = R.centre - 20 + i * 5;
    threshold.push([-R.half, z]);
    stop.push([R.half, z]);
  }
  for (let d = LIGHTS.approachSpacing; d <= LIGHTS.approachLength; d += LIGHTS.approachSpacing) {
    threshold.push([-R.half - d, R.centre]);
    stop.push([R.half + d, R.centre]);
  }
  for (let x = -T.half; x <= T.half + 0.1; x += LIGHTS.edgeSpacing) {
    taxi.push([x, T.centre - T.width / 2 - 2], [x, T.centre + T.width / 2 + 2]);
  }
  return { edge, threshold, stop, taxi };
}

function Lamps({ at, colour, y = 0.35 }: {
  at: ReadonlyArray<readonly [number, number]>; colour: string; y?: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const m = new Matrix4();
    at.forEach(([x, z], i) => instanced.setMatrixAt(i, m.makeTranslation(x, y, z)));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [at, y]);
  if (!at.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, at.length]}>
      <boxGeometry args={[0.55, 0.55, 0.55]} />
      <meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={1.6} roughness={0.5} />
    </instancedMesh>
  );
}

/* ---------------------------------------------------------------- the pieces */

/** Every city chunk this island borrows: the planting, and the `DECO` list. */
const PART_NAMES = [...new Set([TREE_PART, PROP_PART, ...DECO.map((d) => d.part)])];

/**
 * The buildings, cloned out of `airport.glb` and placed.
 *
 * Cloned rather than re-parented for the reason every model here is: drei
 * caches the loaded scene, and moving the cached nodes into this group means
 * a hot reload remounts into an emptied scene and draws nothing. Each part is
 * already centred on its own footprint and standing on y = 0, so a placement
 * is a position and a turn and there is no offset to work out.
 */
function Buildings() {
  const { scene } = useGLTF(AIRPORT_MODEL, DRACO_PATH);
  const placed = useMemo(() => {
    const buildings = BUILDINGS.map((b) => {
      const mesh = scene.getObjectByName(b.part);
      if (!mesh) return null;
      const copy = mesh.clone(true);
      copy.traverse((child) => {
        if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      copy.position.set(b.x, 0, b.z);
      copy.rotation.set(0, b.turn, 0);
      return { key: b.label, object: copy as Object3D };
    });
    const aircraft = PARKED.map((a) => {
      const mesh = scene.getObjectByName(a.part);
      if (!mesh) return null;
      const copy = mesh.clone(true);
      copy.traverse((child) => {
        if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
      });
      copy.position.set(a.x, 0, a.z);
      copy.rotation.set(0, a.turn, 0);
      return { key: a.label, object: copy as Object3D };
    });
    return [...buildings, ...aircraft]
      .filter((p): p is { key: string; object: Object3D } => p !== null);
  }, [scene]);

  useEffect(() => () => {
    for (const p of placed) p.object.traverse((child) => {
      if (child instanceof Mesh) child.geometry.dispose();
    });
  }, [placed]);

  return <>{placed.map((p) => <primitive key={p.key} object={p.object} />)}</>;
}

/**
 * Halcyon Parade's buildings — see `PARADE_BUILDINGS`.
 *
 * The same clone-and-place as `Buildings`, against a different model, because
 * these came out of the city map one node at a time rather than out of the
 * airport kit. A part arrives centred on its own footprint and standing on
 * y = 0, so a placement is a position and a turn and there is no offset to
 * work out.
 *
 * A missing part is skipped rather than thrown, so the island still draws if
 * `parade.glb` has not been built yet — the pipeline is a separate npm run
 * and the scene should not be a blank screen because someone pulled the repo
 * without it.
 */
/**
 * The entrance canopy on the landside forecourt — see `ENTRY_GATE`.
 *
 * Drawn inside the island's own group, so its numbers are the island's (x
 * along the frontage, z out from the apron) like every other building here.
 * It arrives out of `prepare-entry-gate.mjs` centred on its footprint and
 * standing on its deck, so a placement is a position and a turn.
 *
 * Cloned for the reason every prop clones: drei caches one scene per URL, and
 * re-parenting it here takes it away from anything else asking for the file.
 */
function EntryGate() {
  const { scene } = useGLTF(ENTRY_GATE.model, DRACO_PATH);
  const gate = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    copy.position.set(ENTRY_GATE.x, 0, ENTRY_GATE.z);
    copy.rotation.set(0, ENTRY_GATE.turn, 0);
    return copy;
  }, [scene]);
  useEffect(() => () => {
    gate.traverse((child) => { if (child instanceof Mesh) child.geometry.dispose(); });
  }, [gate]);
  return <primitive object={gate} />;
}

function ParadeBuildings() {
  const { scene } = useGLTF(PARADE_MODEL, DRACO_PATH);
  const placed = useMemo(() => PARADE_BUILDINGS.map((b) => {
    const mesh = scene.getObjectByName(b.part);
    if (!mesh) return null;
    const copy = mesh.clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    copy.position.set(b.x, 0, b.z);
    copy.rotation.set(0, b.turn, 0);
    return { key: b.label, object: copy as Object3D };
  }).filter((p): p is { key: string; object: Object3D } => p !== null), [scene]);

  useEffect(() => () => {
    for (const p of placed) p.object.traverse((child) => {
      if (child instanceof Mesh) child.geometry.dispose();
    });
  }, [placed]);

  return <>{placed.map((p) => <primitive key={p.key} object={p.object} />)}</>;
}

/** One instanced copy of a city chunk per placement. */
function Chunk({ part, at }: {
  part: CityPart | undefined;
  at: ReadonlyArray<{ x: number; z: number; turn: number }>;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !part) return;
    const m = new Matrix4();
    at.forEach((p, i) => instanced.setMatrixAt(i, cityPartMatrix(part, p.x, 0, p.z, p.turn, m)));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [part, at]);
  if (!part || !at.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[part.geometry, part.material as Material, at.length]}
      castShadow
      receiveShadow
    />
  );
}

/**
 * The multi-storey car park — see `CAR_PARK_DECK`.
 *
 * Four geometries, one per material, so the whole structure is four draw
 * calls. It is built in the island's frame directly, like the crane, because
 * everything on this island is.
 */
function buildCarPark() {
  const C = CAR_PARK_DECK;
  const concrete: BufferGeometry[] = [];
  const band: BufferGeometry[] = [];
  const core: BufferGeometry[] = [];
  const deck: BufferGeometry[] = [];

  const box = (
    w: number, h: number, d: number, x: number, y: number, z: number,
    to: BufferGeometry[], tilt = 0,
  ) => {
    const g = new BoxGeometry(w, h, d);
    if (tilt) g.rotateZ(tilt);
    g.translate(x, y, z);
    to.push(g);
  };

  const x0 = C.along - C.length / 2;
  const x1 = C.along + C.length / 2;
  const z0 = C.across - C.depth / 2;
  const z1 = C.across + C.depth / 2;
  const topDeck = (C.decks - 1) * C.storey;

  // The decks. The ground one is tarmac, not a slab — you drive onto it — so
  // the slabs start at level one and the top one is the roof deck.
  for (let k = 1; k < C.decks; k++) {
    const y = k * C.storey;
    box(C.length, C.slab, C.depth, C.along, y - C.slab / 2, C.across, deck);
    // The upstand band round each deck edge, which is the detail that says
    // car park. Broken on the east end, where the ramp arrives.
    for (const z of [z0, z1]) {
      box(C.length, C.band, C.bandThick, C.along, y + C.band / 2, z, band);
    }
    box(C.bandThick, C.band, C.depth, x0, y + C.band / 2, C.across, band);
  }
  // Columns, on a grid you can count through the gaps.
  for (let i = 0; i <= C.bays.length; i++) {
    const x = x0 + (i / C.bays.length) * C.length;
    for (let j = 0; j <= C.bays.depth; j++) {
      const z = z0 + (j / C.bays.depth) * C.depth;
      box(C.column * 2, topDeck, C.column * 2, x, topDeck / 2, z, concrete);
    }
  }
  // The stair and lift core at the west end, running past the roof because
  // the stairs have to arrive somewhere.
  const coreX = x0 + C.core.length / 2;
  const coreH = topDeck + C.core.over;
  box(C.core.length, coreH, C.core.depth, coreX, coreH / 2, C.across, core);

  // The external ramp at the east end: one straight flight per level, each
  // rising a storey over `reach`, with a wall on its outer side.
  const rampZ = z1 + C.ramp.width / 2;
  for (let k = 0; k < C.decks - 1; k++) {
    const run = C.ramp.reach;
    const rise = C.storey;
    const tilt = Math.atan2(rise, run);
    const length = Math.hypot(run, rise);
    const midX = x1 - run / 2 + (k % 2 === 0 ? 0 : 0);
    box(
      length, C.slab, C.ramp.width,
      midX, k * C.storey + rise / 2 - C.slab / 2, rampZ,
      deck, k % 2 === 0 ? -tilt : -tilt,
    );
    box(
      length, C.band, C.bandThick,
      midX, k * C.storey + rise / 2 + C.band / 2, rampZ + C.ramp.width / 2,
      band, -tilt,
    );
  }

  return {
    concrete: merge(concrete),
    band: merge(band),
    core: merge(core),
    deck: merge(deck),
  };
}

/**
 * Trees and street furniture, landside only.
 *
 * Nothing is planted airside, and that is not decoration policy — a tree
 * beside a runway reads as a mistake, and the strip either side of the paving
 * is meant to be bare graded grass. So the scatter is confined to `z > 100`,
 * which is the far side of the frontage road from the apron.
 */
function scatter() {
  const trees: Array<{ x: number; z: number; turn: number }> = [];
  const props: Array<{ x: number; z: number; turn: number }> = [];
  let seed = 23;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };

  /**
   * Clear of every building, and of the car park.
   *
   * The margin used to be a flat 108 x 38, which was the largest city chunk's
   * half-footprint applied to all six. The parts are measured now, so each one
   * clears by its own size and a tree can stand between two small buildings
   * instead of being pushed out by the biggest.
   */
  const clear = (x: number, z: number) => !BUILDINGS.some((b) => {
    const s = sizeOf(b.part);
    const turned = Math.abs(Math.cos(b.turn)) < 0.5;
    const half = [(turned ? s[2] : s[0]) / 2 + 12, (turned ? s[0] : s[2]) / 2 + 12];
    return Math.abs(b.x - x) < half[0] && Math.abs(b.z - z) < half[1];
  }) && !(x > PAVING.carPark[0] - 14 && x < PAVING.carPark[1] + 14
    && z > PAVING.carPark[2] - 14 && z < PAVING.carPark[3] + 14)
    // And clear of Halcyon Pier. The airfield's planting is laid in long rows
    // that cross the whole island — the road verge runs to along 400 and the
    // first landside band to 300 — and the park sits in the middle of both,
    // so the airfield was planting trees inside the fairground and between
    // its rides. The park does its own planting; this stops at its hedge.
    && !(x > PARK.bounds[0] - 4 && x < PARK.bounds[1] + 4
      && z > PARK.bounds[2] - 4 && z < PARK.bounds[3] + 4)
    // And clear of the parade, for the same reason and with more force. Two
    // of the three landside bands lie at across 286 and 364, which is the
    // shop fronts and the back of the car park — so every palm in them stood
    // inside a building. See `PARADE_BOUNDS`.
    && !(x > PARADE_BOUNDS[0] && x < PARADE_BOUNDS[1]
      && z > PARADE_BOUNDS[2] && z < PARADE_BOUNDS[3])
    // And clear of the three roads linking the landside road to the outer one.
    // `PARADE_BOUNDS` does not cover them: it starts at across 172 and the
    // links run from 159, so the verge row at 165 crosses all three. That row
    // steps 26 m from -230, which puts a palm 6 m inside the first link's
    // carriageway, another 4 m inside the second, and a third 3 m inside the
    // airport entrance — that last one has been standing on the way in since
    // the entrance was a slab, where it was easier to miss.
    && ![...PARADE_LINKS, ENTRY.centre].some(
      (at) => Math.abs(x - at) < ROAD_WIDTH / 2 + 5,
    )
    // And clear of the Wall of Death and its path down to the outer road: the
    // 286 band's palms at along 240 and the 364 band's at 210..270 both stood
    // on the site. See `WOD_BOUNDS`.
    && !(WALL_OF_DEATH_ENABLED && x > WOD_BOUNDS[0] && x < WOD_BOUNDS[1]
      && z > WOD_BOUNDS[2] && z < WOD_BOUNDS[3])
    // And the aqua park beside it.
    && !(AQUA_PARK_ENABLED && x > AQUA_BOUNDS[0] && x < AQUA_BOUNDS[1]
      && z > AQUA_BOUNDS[2] && z < AQUA_BOUNDS[3])
    // And the heliport, coast to road.
    && !(HELIPORT_ENABLED && x > HELI_BOUNDS[0] && x < HELI_BOUNDS[1]
      && z > HELI_BOUNDS[2] && z < HELI_BOUNDS[3]);

  // A row on the landward verge of the frontage road. It used to sit between
  // the road and the apron; the terminal has that ground now, so it is the
  // far verge instead.
  for (let x = -230; x <= 400; x += 26) {
    const z = PAVING.road[3] + 6 + rnd() * 3;
    if (!clear(x, z)) continue;
    trees.push({ x, z, turn: rnd() * Math.PI * 2 });
    if (trees.length % 3 === 0) props.push({ x: x + 3, z: z - 5, turn: rnd() * Math.PI * 2 });
  }
  // Behind the car park, filling the landside ground. One band was enough when
  // the island's east shore was 260 m out; it now reaches 461, and a single
  // row left 250 m of bare field behind it. Three bands, all culled against
  // the real coast, and all across the developed frontage rather than the
  // whole 1 km of island — the airfield is a compact thing at one end of a big
  // island and the planting should still say so.
  for (let x = -300; x <= 300; x += 30) {
    for (let k = 0; k < 3; k++) {
      const z = 208 + k * 78 + rnd() * 14;
      // Inside the outline with room for the beach, and clear of the terminal.
      const shore = shoreAt(x);
      if (!shore || z > shore[1] - 34 || !clear(x, z)) continue;
      trees.push({ x: x + rnd() * 10 - 5, z, turn: rnd() * Math.PI * 2 });
    }
  }
  /*
   * And none in the field north of the outer road. The island railway's trunk
   * runs the length of it, curving east behind the Wall of Death and then
   * straight south to the sea wall, and the 286 and 364 bands both cross that
   * field — palms stood in the four-foot and beside the drum. The user asked
   * for them gone, so the field is open grass: the line, the drome and nothing
   * else.
   *
   * Culled AFTER the scatter rather than inside `clear`, because `clear` is
   * tested between draws of the generator: skipping a tree there skips its
   * jitter draw too and every palm after it in the band moves. Filtering the
   * finished list takes these out and leaves every other palm exactly where
   * it was.
   */
  const southOfRoad = (t: { z: number }) => t.z < PAVING.outerRoad[3];
  return { trees: trees.filter(southOfRoad), props: props.filter(southOfRoad) };
}

/* ------------------------------------------------------------------- the lot */

/**
 * The perimeter wall: one box per segment, plus a coping and the gate piers.
 *
 * A box per segment rather than a loft, because the wall is straight between
 * its points and a loft's value is in following a curve THROUGH them — here
 * the curve is already in the point list, 191 segments of it. Each box is
 * turned to its own segment and made slightly long, so neighbours overlap at
 * the joint and a bend has no wedge of daylight in the outside of it.
 *
 * The coping is a second, wider box along the top. It is what stops three
 * metres of grey reading as a fence: a wall has a lip and a fence does not.
 */
function buildPerimeter() {
  const { height, thickness, coping, pier, gates, landsideAt } = PERIMETER;
  const wall: BufferGeometry[] = [];
  const caps: BufferGeometry[] = [];
  for (const run of perimeterRuns()) {
    for (let i = 1; i < run.length; i++) {
      const [x0, z0] = run[i - 1];
      const [x1, z1] = run[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.01) continue;
      const turn = Math.atan2(x1 - x0, z1 - z0);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      // Over-long by a thickness so the mitre at a bend is filled.
      const body = new BoxGeometry(thickness, height, len + thickness);
      body.rotateY(turn);
      body.translate(mx, height / 2, mz);
      wall.push(body);
      const cap = new BoxGeometry(thickness + coping.over * 2, coping.deep, len + thickness);
      cap.rotateY(turn);
      cap.translate(mx, height + coping.deep / 2, mz);
      caps.push(cap);
    }
  }
  // A pier either side of every gate: a wall that stops looks broken, and a
  // wall with two posts and a gap looks like a way in.
  for (const g of gates)
    for (const side of [-1, 1]) {
      const half = pier.half + pier.over;
      const post = new BoxGeometry(half * 2, pier.height, half * 2);
      post.translate(g.at + side * (g.half + pier.half), pier.height / 2, landsideAt);
      caps.push(post);
    }
  // The spur's own gate carries its piers as points, because its opening is
  // for a railway rather than a road and is nowhere near `landsideAt`.
  for (const [x, z] of PERIMETER.spur.piers) {
    const half = pier.half + pier.over;
    const post = new BoxGeometry(half * 2, pier.height, half * 2);
    post.translate(x, pier.height / 2, z);
    caps.push(post);
  }
  return { wall: merge(wall), caps: merge(caps) };
}

/**
 * `playerBodyRef` is the driver's chassis, for the one thing on the island
 * that reacts to the player: the Wall of Death's door.
 */
export function AirportIsland({ playerBodyRef }: { playerBodyRef?: RefObject<RapierRigidBody | null> }) {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);
  const parts = useMemo(() => collectCityParts(scene, PART_NAMES), [scene]);

  const built = useMemo(() => ({
    land: buildLand(),
    paving: buildPaving(),
    marks: buildMarks(),
    lights: buildLights(),
    helipads: buildHelipads(),
    entry: buildEntry(),
    yard: buildYardTrack(),
    carPark: buildCarPark(),
    perimeter: buildPerimeter(),
    scatter: scatter(),
    // Grouped by chunk, so each distinct part is one instanced call however
    // many times it is placed.
    deco: [...DECO.reduce((map, d) => {
      const list = map.get(d.part) ?? [];
      list.push({ x: d.x, z: d.z, turn: d.turn });
      return map.set(d.part, list);
    }, new Map<string, Array<{ x: number; z: number; turn: number }>>()).entries()],
  }), []);
  const tarmac = useMemo(() => makeTarmac(), []);
  const grassTile = useTexture(GRASS_TILE);
  const grass = useMemo(() => {
    const bounds = ISLAND_BOUNDS();
    return grassMaterial(
      prepareGrassTile(grassTile), makeMottle(bounds), bounds, 'airport-grass',
    );
  }, [grassTile]);
  /** The railway's own stone, shared with every other line — see the mesh. */
  const yardStone = useMemo(() => makeBallastTexture(), []);

  // The same one-line report the city, the traffic and the fleet print. It is
  // the only way to tell a chunk that failed to resolve — a missing name gives
  // no error, just a building that is not there.
  useEffect(() => {
    if (!parts.size) return;
    const missing = PART_NAMES.filter((n) => !parts.has(n));
    // A positive shoelace means the crown's triangles face the seabed and the
    // island is invisible from above — see `OUTLINE`.
    const facing = outlineShoelace() < 0 ? '' : ' — OUTLINE WOUND INSIDE OUT';
    const named = new Set([...BUILDINGS, ...PARKED].map((b) => b.part));
    console.info(`[airport] ${BUILDINGS.length} buildings and ${PARKED.length} aircraft `
      + `from ${named.size} meshes (${airportModels.triangles} tris), `
      + `${DECO.length} city chunks, ${HELIPADS.length} helipads, `
      + `${built.scatter.trees.length} trees`
      + (missing.length ? ` — MISSING ${missing.join(', ')}` : '') + facing);
  }, [parts, built]);

  useEffect(() => () => {
    built.land.crown.geometry.dispose();
    built.land.wall.geometry.dispose();
    built.paving?.dispose();
    built.perimeter.wall?.dispose();
    built.perimeter.caps?.dispose();
    built.marks.white?.dispose();
    built.marks.yellow?.dispose();
    for (const g of Object.values(built.entry)) g?.dispose();
    for (const [key, g] of Object.entries(built.yard)) {
      if (key !== 'sleepers' && g && 'dispose' in g) (g as BufferGeometry).dispose();
    }
    tarmac.dispose();
    (grass.map as Texture | null)?.dispose();
    grass.dispose();
    yardStone.dispose();
  }, [built, tarmac, grass, yardStone]);

  return (
    <group position={[SITE.centre[0], SITE.ground, SITE.centre[1]]} rotation={[0, SITE.heading, 0]}>
      {/* The land, in the railway islands' own grass and sand so the whole
          coast reads as one place — see `TOWN_PALETTE`. */}
      <mesh geometry={built.land.crown.geometry} material={grass} receiveShadow />
      <mesh geometry={built.land.wall.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#9a9791" roughness={0.9} side={DoubleSide} />
      </mesh>

      {built.paving && (
        <mesh geometry={built.paving} receiveShadow>
          <meshStandardMaterial map={tarmac} color="#8f929a" roughness={0.94} />
        </mesh>
      )}

      {/* The boundary. Airside is inside it; the car park, the hotel strip and
          the outer road are not. See `PERIMETER`. */}
      {built.perimeter.wall && (
        <mesh geometry={built.perimeter.wall} receiveShadow castShadow>
          <meshStandardMaterial color={PERIMETER.colours.wall} roughness={0.95} />
        </mesh>
      )}
      {built.perimeter.caps && (
        <mesh geometry={built.perimeter.caps} receiveShadow castShadow>
          <meshStandardMaterial color={PERIMETER.colours.coping} roughness={0.9} />
        </mesh>
      )}
      {built.marks.white && (
        <mesh geometry={built.marks.white}>
          <meshStandardMaterial color={MARKS.colour} roughness={0.8} />
        </mesh>
      )}
      {built.marks.yellow && (
        <mesh geometry={built.marks.yellow}>
          <meshStandardMaterial color={MARKS.taxiColour} roughness={0.8} />
        </mesh>
      )}

      {/* The helipads: frame, grille, rim, paint, and a ring of green. */}
      {built.helipads.frame && (
        <mesh geometry={built.helipads.frame} castShadow receiveShadow>
          <meshStandardMaterial color={HELIPAD.colours.frame} roughness={0.7} metalness={0.35} />
        </mesh>
      )}
      {built.helipads.grille && (
        <mesh geometry={built.helipads.grille} castShadow receiveShadow>
          <meshStandardMaterial color={HELIPAD.colours.grille} roughness={0.6} metalness={0.5} />
        </mesh>
      )}
      {built.helipads.rim && (
        <mesh geometry={built.helipads.rim} castShadow>
          <meshStandardMaterial
            color={HELIPAD.colours.rim}
            emissive={HELIPAD.colours.rim}
            emissiveIntensity={0.25}
            roughness={0.5}
          />
        </mesh>
      )}
      {built.helipads.mark && (
        <mesh geometry={built.helipads.mark}>
          <meshStandardMaterial color={HELIPAD.colours.mark} roughness={0.8} />
        </mesh>
      )}
      <Lamps at={built.helipads.lights} colour={HELIPAD.colours.light} y={HELIPAD.height + 0.4} />

      <Lamps at={built.lights.edge} colour={LIGHTS.colours.edge} />
      <Lamps at={built.lights.threshold} colour={LIGHTS.colours.threshold} />
      <Lamps at={built.lights.stop} colour={LIGHTS.colours.stop} />
      <Lamps at={built.lights.taxi} colour={LIGHTS.colours.taxi} />

      {/* The entrance: gate, gatehouse and sign gantry — see `ENTRY`. The
          kerbed reservation that used to be the first thing here went with the
          slab; the kit road carries its own kerbs. */}
      {built.entry.posts && (
        <mesh geometry={built.entry.posts} castShadow receiveShadow>
          <meshStandardMaterial color={ENTRY.colours.post} roughness={0.5} metalness={0.45} />
        </mesh>
      )}
      {built.entry.arms && (
        <mesh geometry={built.entry.arms} castShadow>
          <meshStandardMaterial color={ENTRY.colours.arm} roughness={0.7} />
        </mesh>
      )}
      {built.entry.bands && (
        <mesh geometry={built.entry.bands} castShadow>
          <meshStandardMaterial color={ENTRY.colours.band} roughness={0.7} />
        </mesh>
      )}
      {built.entry.hut && (
        <mesh geometry={built.entry.hut} castShadow receiveShadow>
          <meshStandardMaterial color={ENTRY.colours.hut} roughness={0.85} />
        </mesh>
      )}
      {built.entry.glass && (
        <mesh geometry={built.entry.glass}>
          <meshStandardMaterial
            color={ENTRY.colours.glass}
            transparent
            opacity={0.4}
            roughness={0.15}
            metalness={0.1}
          />
        </mesh>
      )}
      {built.entry.board && (
        <mesh geometry={built.entry.board} castShadow>
          <meshStandardMaterial
            color={ENTRY.colours.board}
            emissive={ENTRY.colours.board}
            emissiveIntensity={0.18}
            roughness={0.6}
          />
        </mesh>
      )}

      {/* The multi-storey car park — see `CAR_PARK_DECK`. */}
      {built.carPark.deck && (
        <mesh geometry={built.carPark.deck} castShadow receiveShadow>
          <meshStandardMaterial color={CAR_PARK_DECK.colours.deck} roughness={0.9} />
        </mesh>
      )}
      {built.carPark.concrete && (
        <mesh geometry={built.carPark.concrete} castShadow receiveShadow>
          <meshStandardMaterial color={CAR_PARK_DECK.colours.concrete} roughness={0.85} />
        </mesh>
      )}
      {built.carPark.band && (
        <mesh geometry={built.carPark.band} castShadow receiveShadow>
          <meshStandardMaterial color={CAR_PARK_DECK.colours.band} roughness={0.8} />
        </mesh>
      )}
      {built.carPark.core && (
        <mesh geometry={built.carPark.core} castShadow receiveShadow>
          <meshStandardMaterial color={CAR_PARK_DECK.colours.core} roughness={0.85} />
        </mesh>
      )}

      {/* The freight sidings on the green east of the apron — see `SIDINGS`.
          They join nothing: the main line is on Kestrel, across the water. */}
      {/* The same stone the main line, the country line and the island line
          stand on. It was a flat `SIDINGS.colours.ballast`, and a flat colour
          under a rake of wagons reads as a poured concrete strip. */}
      {built.yard.ballast && (
        <mesh geometry={built.yard.ballast} receiveShadow>
          <meshStandardMaterial map={yardStone} roughness={0.95} side={DoubleSide} />
        </mesh>
      )}
      <GeometryCollider geometry={built.yard.ballast} />
      <Sleepers at={built.yard.sleepers} />
      {built.yard.rails && (
        <mesh geometry={built.yard.rails} material={RAIL_STEEL} castShadow receiveShadow />
      )}
      {built.yard.stops && (
        <mesh geometry={built.yard.stops} castShadow receiveShadow>
          <meshStandardMaterial color={SIDINGS.colours.stop} roughness={0.8} metalness={0.2} />
        </mesh>
      )}
      {/* The terminal's hardstanding: the container yard east of the roads and
          the turning apron across their heads. A railhead is a strip of
          ballast beside a slab of concrete, and this is the concrete. */}
      {built.yard.paving && (
        <mesh geometry={built.yard.paving} receiveShadow>
          <meshStandardMaterial map={tarmac} color={YARD.colours.hardstanding} roughness={0.94} />
        </mesh>
      )}
      {/* Floodlight masts. A yard is flat and grey and reads as nothing from
          the air; six 22 m masts give it a skyline. */}
      {built.yard.masts && (
        <mesh geometry={built.yard.masts} castShadow receiveShadow>
          <meshStandardMaterial color={YARD.colours.mast} roughness={0.5} metalness={0.55} />
        </mesh>
      )}
      {built.yard.lamps && (
        <mesh geometry={built.yard.lamps}>
          <meshStandardMaterial
            color={YARD.colours.lamp}
            emissive={YARD.colours.lamp}
            emissiveIntensity={0.9}
            roughness={0.4}
          />
        </mesh>
      )}
      <StabledStock />
      {/* The goods platform: an open transfer dock at lorry-bed height between
          the two loading roads. No canopy — a crane has to reach it. */}
      {built.yard.deck && (
        <mesh geometry={built.yard.deck} receiveShadow castShadow>
          <meshStandardMaterial color={SIDINGS.colours.deck} roughness={0.92} side={DoubleSide} />
        </mesh>
      )}
      {built.yard.edge && (
        <mesh geometry={built.yard.edge} receiveShadow castShadow>
          <meshStandardMaterial color={SIDINGS.colours.edge} roughness={0.85} />
        </mesh>
      )}


      {/* The container yard — see `CONTAINERS`. */}
      <Containers part={parts.get(CONTAINERS.part)} />

      {/* Halcyon East: the running shed, the bulk terminal, the level
          crossings and the boundary — see `FreightYard`. */}
      <FreightYard />

      {/* The railway that reaches it: the trunk in off the north-east corner,
          the connection out of the gate and the up main's link. Both ends of
          the trunk are deliberately open — see `islandRailConfig`. */}
      <IslandRail />

      <Buildings />
      <ParadeBuildings />
      <EntryGate />
      <AirportTraffic />
      {/* The roads, from the modular kit — inside this group, so `roadConfig`
          works in the island's own (along, across). */}
      <IslandRoads />
      {/* Halcyon Pier, on the strip between the outer road and the cargo
          apron — see `parkConfig`. Inside this group, so its numbers are the
          island's own `along` / `across`. */}
      <AmusementPark />
      {/* The Wall of Death, on the grass north of the outer road where the
          island line's trunk currently stops — see `wallOfDeathConfig`. */}
      {WALL_OF_DEATH_ENABLED && <WallOfDeath playerBodyRef={playerBodyRef} />}
      {/* Its grounds: a fairground plaza round the drome — see `DromeGrounds`. */}
      {WALL_OF_DEATH_ENABLED && <DromeGrounds />}
      {/* Halcyon Aqua Park, on the drome's east side — see `aquaParkConfig`. */}
      {AQUA_PARK_ENABLED && <AquaPark />}
      {HELIPORT_ENABLED && <Heliport />}
      {built.deco.map(([name, at]) => (
        <Chunk key={name} part={parts.get(name)} at={at} />
      ))}
      <Chunk part={parts.get(TREE_PART)} at={built.scatter.trees} />
      <Chunk part={parts.get(PROP_PART)} at={built.scatter.props} />

      {/* The ground a car stands on, and colliders that FOLLOW each building
          rather than boxing its bounds — see `partColliders`. The terminal is
          the reason: a 200 m concourse laid diagonally across a 108 x 210 m
          bound, of which it fills 4%. The other 96% was a wall you could see
          straight through. The paving is not a collider: it sits
          60 mm over the crown and a wheel rides the crown, exactly as the
          station town's streets do. */}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider
          args={[built.land.crown.vertices, built.land.crown.indices]}
          friction={1}
        />
        {BUILDINGS.map((b) => partColliders(b.part, b.x, b.z, b.turn, sizeOf(b.part), b.label))}
        {/* The entrance canopy, from its own measured boxes: it is a roof ON
            COLUMNS, and a box round its bounds would wall off the forecourt
            you are meant to drive under it into. */}
        {partColliders(
          ENTRY_GATE.part, ENTRY_GATE.x, ENTRY_GATE.z, ENTRY_GATE.turn,
          ENTRY_GATE.size, 'entry gate',
        )}
        {/* The helipad decks, so a helicopter has something to land on. The
            legs are left open — nothing can drive between them anyway. */}
        {HELIPADS.map((pad) => (
          <CuboidCollider
            key={pad.label}
            args={[HELIPAD.half, HELIPAD.deck / 2, HELIPAD.half]}
            position={[pad.x, HELIPAD.height - HELIPAD.deck / 2, pad.z]}
          />
        ))}
        {/* Containers and landside blocks are solid; the service vehicles and
            the planting are not, the same as the city's own street furniture. */}
        {DECO.filter((d) => d.solid).map((d, i) => {
          const part = parts.get(d.part);
          if (!part) return null;
          const size = part.size as [number, number, number];
          return partColliders(d.part, d.x, d.z, d.turn, size, `${d.part}-${i}`);
        })}
        {/* The car park: its columns and its core, and nothing else.
            The ground floor is meant to be drivable — that is what the
            columns are for, and a car that can pull in under the decks is
            worth more than a box that stops it at the kerb. The decks
            themselves start 3.1 m up, which is over a car. */}
        {(() => {
          const C = CAR_PARK_DECK;
          const x0 = C.along - C.length / 2;
          const z0 = C.across - C.depth / 2;
          const top = (C.decks - 1) * C.storey;
          const out = [];
          for (let i = 0; i <= C.bays.length; i++) {
            for (let j = 0; j <= C.bays.depth; j++) {
              out.push(
                <CuboidCollider
                  key={`cp-col-${i}-${j}`}
                  args={[C.column, top / 2, C.column]}
                  position={[
                    x0 + (i / C.bays.length) * C.length,
                    top / 2,
                    z0 + (j / C.bays.depth) * C.depth,
                  ]}
                />,
              );
            }
          }
          const coreH = top + C.core.over;
          out.push(
            <CuboidCollider
              key="cp-core"
              args={[C.core.length / 2, coreH / 2, C.core.depth / 2]}
              position={[x0 + C.core.length / 2, coreH / 2, C.across]}
            />,
          );
          return out;
        })()}
        {/* The goods dock: one box for the deck, which is all there is. */}
        <CuboidCollider
          args={[
            (SIDINGS.platform.to - SIDINGS.platform.from) / 2,
            SIDINGS.platform.height / 2,
            (SIDINGS.platform.across[1] - SIDINGS.platform.across[0]) / 2,
          ]}
          position={[
            (SIDINGS.platform.from + SIDINGS.platform.to) / 2,
            SIDINGS.platform.height / 2,
            (SIDINGS.platform.across[0] + SIDINGS.platform.across[1]) / 2,
          ]}
        />
        {/* The yard, one collider per BAY rather than per box: a stack is a
            solid block as far as anything driving round it is concerned, and
            a hundred cuboids would be a hundred colliders for the same wall. */}
        {CONTAINERS.bays.map((bay, i) => {
          const B = CONTAINERS.box;
          const G = CONTAINERS.gap;
          const along = bay.long * (B.long + G.end) - G.end;
          const across = bay.rows * (B.wide + G.side) - G.side;
          const high = bay.high * (B.high + G.tier);
          return (
            <CuboidCollider
              key={`bay-${i}`}
              args={[along / 2, high / 2, across / 2]}
              position={[bay.along + along / 2, high / 2, bay.across + across / 2]}
            />
          );
        })}
        {/* The entrance's own furniture: the gatehouse, the gantry posts and
            the barrier pivots are things a car should hit. The raised arms are
            not — they are four metres up, where nothing on the road is. There
            is no reservation to ride over any more; see `ENTRY`. */}
        <CuboidCollider
          args={[ENTRY.gate.hut.width / 2, ENTRY.gate.hut.height / 2, ENTRY.gate.hut.depth / 2]}
          position={[
            ENTRY.centre + ENTRY.gate.hut.off, ENTRY.gate.hut.height / 2, ENTRY.gate.hut.at,
          ]}
        />
        {[-1, 1].map((side) => (
          <CuboidCollider
            key={`boom-${side}`}
            args={[0.17, ENTRY.gate.arm.pivot / 2, 0.17]}
            position={[
              ENTRY.centre + side * (ENTRY.half + ENTRY.gate.arm.clear),
              ENTRY.gate.arm.pivot / 2, ENTRY.gate.at,
            ]}
          />
        ))}
        {[-1, 1].map((side) => (
          <CuboidCollider
            key={`gantry-${side}`}
            args={[ENTRY.gantry.post / 2, ENTRY.gantry.height / 2, ENTRY.gantry.post / 2]}
            position={[
              ENTRY.centre + side * (ENTRY.half + ENTRY.gantry.clear),
              ENTRY.gantry.height / 2, ENTRY.gantry.at,
            ]}
          />
        ))}
        {/* The boundary, one box per segment. It is the only thing here a car
            meets at speed on the way in, so it is solid for its whole length
            and open exactly where the gates are. */}
        {perimeterRuns().flatMap((run, r) => run.slice(1).map(([x1, z1], i) => {
          const [x0, z0] = run[i];
          const len = Math.hypot(x1 - x0, z1 - z0);
          return (
            <CuboidCollider
              key={`wall-${r}-${i}`}
              args={[PERIMETER.thickness / 2, PERIMETER.height / 2, (len + PERIMETER.thickness) / 2]}
              position={[(x0 + x1) / 2, PERIMETER.height / 2, (z0 + z1) / 2]}
              rotation={[0, Math.atan2(x1 - x0, z1 - z0), 0]}
            />
          );
        }))}
        {PERIMETER.gates.flatMap((g) => [-1, 1].map((side) => (
          <CuboidCollider
            key={`pier-${g.label}-${side}`}
            args={[PERIMETER.pier.half, PERIMETER.pier.height / 2, PERIMETER.pier.half]}
            position={[g.at + side * (g.half + PERIMETER.pier.half), PERIMETER.pier.height / 2, PERIMETER.landsideAt]}
          />
        )))}
        {PERIMETER.spur.piers.map(([x, z]) => (
          <CuboidCollider
            key={`spur-pier-${x}-${z}`}
            args={[PERIMETER.pier.half, PERIMETER.pier.height / 2, PERIMETER.pier.half]}
            position={[x, PERIMETER.pier.height / 2, z]}
          />
        ))}
        {/* The aeroplanes are solid down the fuselage and open under the
            wings — see `PARKED`. */}
        {PARKED.map((a) => {
          const body = a.fuselage ?? FUSELAGE;
          return (
            <CuboidCollider
              key={a.label}
              args={[body.halfWidth, body.halfHeight, sizeOf(a.part)[2] / 2]}
              position={[a.x, body.halfHeight, a.z]}
              rotation={[0, a.turn, 0]}
            />
          );
        })}
      </RigidBody>
    </group>
  );
}
