'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import { GeometryCollider } from './GeometryCollider';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Euler,
  ExtrudeGeometry, Float32BufferAttribute, InstancedMesh, Material, Matrix4, Mesh,
  Quaternion, RepeatWrapping, Shape, SRGBColorSpace, Vector3, type Object3D,
} from 'three';
import HALL_DATA from '@/config/kestrelStationData.json';
import { partColliders } from './partColliders';
import { InstancedField } from './instancedField';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import {
  CATENARY, RAIL_HEAD_LIFT, TRAIN, trainNormalAt, trainPointAt, trainWrap,
} from '@/config/trainConfig';
import {
  BRIDGE, ISLAND_LINK, MAIN_LINE_TOE, PLATFORMS, ROADS, STATION, STATION_SITE,
  STATION_NAME, STATION_STEP, STATION_YARD, TOWN, UP_LOOP, roadLead, roadOffset,
  roadSeparation, stationFrameOf, stationInner, stationOuter, stationPoint, stationRailPoint,
  stationTracks, upLoopLead, upLoopOffset, upLoopSeparation,
} from '@/config/stationConfig';
import { CROSSING, TOWN_BUILT } from '@/config/townConfig';
import { KESTREL_WEST_CROSSING } from '@/config/kestrelRoads';
import { RAIL_STEEL, buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { SLEEPER_GEOMETRY } from './sleeper';
import { bladeFraction, bladedRailProfile, standsAlone, type BladedSample } from './switchBlade';

/**
 * The station on the made island: four roads, two island platforms, and a
 * block of the city moved out to sea to stand behind it.
 *
 * ## What is built here and what is not
 *
 * Roads 0 and 1 are the two through lines — the running line and the down
 * line, which `secondTrackGap` fans out to road 1's offset through the station
 * — and both are drawn by `TrainLine` with their own ballast, sleepers and
 * rails. This component adds the outer pair as loop roads round platform B,
 * the platforms, the canopies over them and the town — so the station is
 * additive: turn it off and the railway is exactly what it was.
 *
 * ## The town is the city, not a model of it
 *
 * `prepare-map.mjs` merges the city into chunks of (material, 250 m cell) and
 * bakes every node transform into the vertices. That has a consequence worth
 * exploiting: a chunk is a plain world-space mesh sharing one material, so
 * drawing it a second time under a different matrix costs one draw call and
 * nothing else — no new asset, no second download, no extra GPU memory. The
 * buildings, the road, the kerbs, the bins and the street lights on this island
 * are the same vertices as the ones in the city, seen from somewhere else.
 *
 * Which chunks come is decided in `stationConfig`; see `TOWN` for why that
 * particular cell and why the terrain shell has to stay behind.
 */

/** A sample of a station road's centreline. Level: the crossing is flat. */
interface Road extends BladedSample {
  /** Rail head height over the formation the ballast has to reach down to. */
  fill: number;
}

const SLEEPER_TOP = -TRAIN.railHeight;
const SLEEPER_BOTTOM = SLEEPER_TOP - TRAIN.sleeperHeight;

/**
 * Ballast, sleepers and rails, all measured down from the rail head — the same
 * frame `TrainLine` uses, and the same trapezium, so a station road and the
 * running line beside it are visibly the same railway.
 */

/**
 * The station's formation: ONE ballast bed under the whole throat.
 *
 * Every road used to carry its own trapezium, and at a station that is wrong
 * twice over. Where the roads are far apart — the 12.4 m between the running
 * lines past the platform ends — the beds do not meet and a wedge of GRASS
 * shows between two running lines, which no railway has. Where they converge
 * the beds overlap, and since the station is level every crown is at exactly
 * the same height, so the overlaps are coplanar and z-fight: a grey mess of
 * criss-crossing edges that flickers as the camera moves. Between them those
 * two are most of what made the throat look scattered.
 *
 * A station stands on one continuous formation with the rails laid on top, and
 * so does this: a single bed reaching from the running line's own toe out past
 * the outermost road that still exists here (`stationOuter`). It ends exactly
 * where the outermost road's turnout does, at which point `stationOuter` has
 * closed to the running gap and the section is the pair's own — so it hands
 * over to `TrainLine`'s ballast without a step. `TrainLine` leaves the yard
 * alone in return; see its `yard` flag.
 */
interface Yard extends LoftSample {
  fill: number;
  /** Offset of the outermost track here, from `stationOuter`. */
  outer: number;
  /**
   * Offset of the innermost track, from `stationInner` — zero until the relief
   * loop opens out to the right of the running line, negative after that.
   *
   * The formation used to be symmetric about the running line because nothing
   * lay to its right; with `UP_LOOP` there it has a road on both sides, so both
   * edges are now sampled rather than one being a constant.
   */
  inner: number;
}
const yardDrop = (s: Yard) => Math.max(0.15, TRAIN.ballastDepth + s.fill);
const yardToe = (s: Yard) => TRAIN.ballastCrownHalf + TRAIN.ballastSlope * yardDrop(s);

const FORMATION_PROFILE: ProfileVertex<Yard>[] = [
  { off: (s) => s.inner - yardToe(s), rise: (s) => SLEEPER_BOTTOM - yardDrop(s) },
  { off: (s) => s.inner - TRAIN.ballastCrownHalf, rise: SLEEPER_BOTTOM },
  { off: (s) => s.outer + TRAIN.ballastCrownHalf, rise: SLEEPER_BOTTOM },
  { off: (s) => s.outer + yardToe(s), rise: (s) => SLEEPER_BOTTOM - yardDrop(s) },
];

/**
 * The formation's centreline is the RUNNING LINE itself, so its normal is the
 * line's own — no central difference needed, unlike a road on a taper.
 */
function sampleYard(): Yard[] {
  const site = STATION_SITE;
  if (!site || STATION_YARD <= 0) return [];
  const count = Math.max(2, Math.round((STATION_YARD * 2) / STATION_STEP));
  const fill = site.centre[1] - site.ground;
  const out: Yard[] = [];
  let arc = 0;
  let previous: [number, number] | null = null;
  for (let i = 0; i <= count; i++) {
    const along = -STATION_YARD + (STATION_YARD * 2 * i) / count;
    const [x, , z] = trainPointAt(trainWrap(site.arc + along));
    const [nx, nz] = trainNormalAt(trainWrap(site.arc + along));
    if (previous) arc += Math.hypot(x - previous[0], z - previous[1]);
    previous = [x, z];
    out.push({
      x, z, y: site.centre[1] + RAIL_HEAD_LIFT, arc, fill, nx, nz,
      outer: stationOuter(along),
      inner: stationInner(along),
    });
  }
  return out;
}

/** Metres of arc per texture repeat, matching the running line's ballast. */
const V_SCALE = 9;

/**
 * Ballast chippings.
 *
 * A second, smaller copy of the running line's generator rather than an import:
 * that one is a private helper inside `TrainLine`, and a station is not a good
 * enough reason to widen that module's surface. Same seed family, same palette,
 * same one-tile-per-metre mapping, so the two read as one railway.
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
  let seed = 20240908;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 7000; i++) {
    const shade = 70 + Math.floor(random() * 90);
    const warm = Math.floor(random() * 14);
    ctx.fillStyle = `rgb(${shade + warm}, ${shade + warm / 2}, ${shade})`;
    const r = 1.5 + random() * 3.5;
    ctx.beginPath();
    ctx.ellipse(random() * size, random() * size, r, r * (0.6 + random() * 0.6),
      random() * Math.PI, 0, Math.PI * 2);
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

/**
 * One station road, as centreline samples in world space.
 *
 * The lateral offset comes from `roadOffset`, so the flat length beside the
 * platforms and the eased taper into the throat are decided in the config. The
 * normal is taken from the finished polyline by central difference rather than
 * from the running line: on the taper the road is not parallel to the line, and
 * borrowing the line's normal there would twist the section by up to a degree
 * and leave the rails visibly out of gauge.
 */
function sampleRoad(
  offsetAt: (along: number) => number,
  separationAt: (along: number) => number,
  to: number,
): Road[] {
  const site = STATION_SITE;
  if (!site) return [];
  // Symmetric, and `to` is the merge itself — where this road and the one it
  // joins are the same piece of track. The rails are laid the whole way and
  // taper into a switch blade over the last `STATION.bladeGap` of separation;
  // they used to stop 13-21 m short of here, which left the loops hanging.
  // See `switchBlade.ts`, and `pointwork` for what the merge means to a train.
  const from = -to;
  const count = Math.max(2, Math.round((to - from) / STATION_STEP));
  const y = site.centre[1] + RAIL_HEAD_LIFT;
  const fill = site.centre[1] - site.ground;

  const points: Array<[number, number, number]> = [];
  for (let i = 0; i <= count; i++) {
    const along = from + ((to - from) * i) / count;
    // On the RAILWAY's frame, not the flat one: `stationPoint` projects `along`
    // down one tangent, and 200 m out the line has curved away from it, so a
    // road laid that way closes on where the down line is not. See
    // `stationRailPoint`.
    const [x, , z] = stationRailPoint(along, offsetAt(along));
    points.push([x, z, bladeFraction(separationAt(along))]);
  }

  const samples: Road[] = [];
  let arc = 0;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    if (i > 0) arc += Math.hypot(x - points[i - 1][0], z - points[i - 1][1]);
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const len = Math.hypot(tx, tz) || 1;
    // Left-hand normal, the sign `trainNormalAt` uses.
    samples.push({ x, z, y, arc, fill, blade: points[i][2], nx: tz / len, nz: -tx / len });
  }
  return samples;
}

/**
 * Every road this component lays, as an offset function and how far it is
 * drawn.
 *
 * Roads 0 and 1 are the two through lines and belong to `TrainLine` — road 1 is
 * the down line, fanned out by `secondTrackGap`. What is left is the pair of
 * platform loops off the down line and the relief loop off the up, and they are
 * listed together because the rails, the sleepers and the instance ceiling all
 * want the same answer to "which roads are there".
 */
const BUILT_ROADS: ReadonlyArray<{
  name: string;
  offsetAt: (along: number) => number;
  /** How far it stands off the line it joins — what the blade taper reads. */
  separationAt: (along: number) => number;
  to: number;
}> = STATION_SITE
  ? [
    ...ROADS.slice(2).map((road) => ({
      name: `road ${road}`,
      offsetAt: (along: number) => roadOffset(road, along),
      separationAt: (along: number) => roadSeparation(road, along),
      to: roadLead(road),
    })),
    {
      name: 'relief loop',
      offsetAt: upLoopOffset,
      separationAt: upLoopSeparation,
      to: upLoopLead(),
    },
  ]
  : [];

/**
 * Where every station sleeper goes.
 *
 * Computed in full rather than into a preallocated ceiling, because the ceiling
 * was wrong and wrong in a way that could only ever get worse. It was
 * `(halfPlatform + approach + site.taper) * 2` per road, shared across all of
 * them — but a road's real extent is `roadDrawn`, built on `roadTaper`, which
 * takes the *longer* of `site.taper` and what the ballast allows and then aims
 * at `STATION.loopLead` (175 m, 225 m, 150 m) rather than at `site.taper`
 * (130 m). So every road overran its allowance, the shared budget ran dry, and
 * the roads at the END of the list simply stopped getting sleepers — which is
 * why the relief loop, added last, had none at all and the outer platform loop
 * lost its far end.
 *
 * An exact count cannot starve, and it cannot silently mis-size again when the
 * next road is added.
 */
interface Sleeper { x: number; z: number; yaw: number }

function sleeperPlacements(): Sleeper[] {
  if (!STATION_SITE) return [];
  const out: Sleeper[] = [];
  for (const built of BUILT_ROADS) {
    const samples = sampleRoad(built.offsetAt, built.separationAt, built.to);
    if (samples.length < 2) continue;
    const length = samples[samples.length - 1].arc;
    // A cursor, not a fraction. The samples are evenly spaced in `along` and
    // NOT in arc — a road on a taper covers more ground per step than one on
    // the straight — so guessing the segment from `at / length` picked the
    // wrong one through the throat and interpolated outside it, which put
    // sleepers off the end of their own segment.
    let k = 0;
    for (let at = 0; at <= length; at += TRAIN.sleeperSpacing) {
      while (k < samples.length - 2 && samples[k + 1].arc < at) k++;
      const a = samples[k];
      const b = samples[k + 1];
      // Not under the blades. The road runs to the merge now, but the last
      // stretch of it lies on the line it is joining, and that line's own
      // sleepers are already there — a second set between them would read as
      // a doubled, half-pitch bay rather than as a turnout.
      if (!standsAlone(a) || !standsAlone(b)) continue;
      const t = Math.min(1, Math.max(0, (at - a.arc) / Math.max(b.arc - a.arc, 1e-6)));
      out.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        // Square to the rails through the taper as well as on the straight.
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
      });
    }
  }
  return out;
}

/** Sleepers for every built road, all in one instanced draw. */
function Sleepers() {
  const mesh = useRef<InstancedMesh>(null);
  const site = STATION_SITE;
  const placements = useMemo(() => sleeperPlacements(), []);

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !site) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    // The shared monobloc geometry: unit scale, origin at the underside.
    const scale = new Vector3(1, 1, 1);
    const y = site.centre[1] + RAIL_HEAD_LIFT + SLEEPER_BOTTOM;
    for (let n = 0; n < placements.length; n++) {
      const p = placements[n];
      euler.set(0, p.yaw, 0);
      quaternion.setFromEuler(euler);
      position.set(p.x, y, p.z);
      instanced.setMatrixAt(n, matrix.compose(position, quaternion, scale));
    }
    instanced.count = placements.length;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [placements, site]);

  if (!placements.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, placements.length]}
      receiveShadow
      geometry={SLEEPER_GEOMETRY}
    >
      <meshStandardMaterial vertexColors roughness={0.9} metalness={0.05} />
    </instancedMesh>
  );
}

/* --------------------------------------------------------------- the fittings */

/**
 * Everything on the platform that is not the platform.
 *
 * All of it presentational, so it lives here rather than in `stationConfig`:
 * nothing outside this file needs to know how far a bench is from a column.
 * What the numbers are *for* is the difference between a station and a slab
 * beside a railway — a bare platform with a flat lid over it reads as a bus
 * shelter at any distance, and the things that fix that are the things a
 * passenger would actually use: a marked edge, light, somewhere to sit, a sign
 * saying where you are, and a way to reach the other platform.
 */
const FIT = {
  /** Paving: slab pitch, and the coat of paint that makes an edge an edge. */
  slab: 1.5,
  safetyWidth: 0.45,
  /** Clear of the coping, so the two read as separate markings. */
  safetyGap: 0.12,

  /** The canopy's edge boards and the beams under its deck. */
  fascia: 0.42,
  fasciaThickness: 0.1,
  ridgeWidth: 1.1,
  ridgeHeight: 0.16,
  beamSpacing: 6.5,
  beamDepth: 0.22,
  /** Down-lights under the canopy, and lamp posts beyond its ends. */
  lightSpacing: 10.5,
  lampSpacing: 16,
  lampHeight: 4.6,
  lampReach: 0.75,

  /** Furniture, as pitches along the covered length. */
  benchSpacing: 24,
  binSpacing: 31,
  /** Name boards along each platform edge, facing the train. */
  boardSpacing: 46,
  boardSize: [2.6, 0.62] as const,
  boardHeight: 2.05,

  /**
   * The footbridge.
   *
   * Sited just outside the canopy's west end rather than in the middle of the
   * platforms, which is where a real one usually goes: in the middle it would
   * have to punch through the canopy, and a canopy with a hole in it is a
   * bigger lie than a footbridge that is thirteen metres off centre.
   *
   * The clearance is the one figure here that is not free: the electrified line
   * underneath wants 6 m over the rail head, and the drone camera tucks to 30 m
   * so nothing above matters.
   */
  bridgeAlong: -78,
  bridgeClearance: 6.4,
  bridgeWidth: 3.2,
  bridgeDeck: 0.34,
  parapet: 1.15,
  parapetThickness: 0.11,
  balusterSpacing: 0.85,
  /** Stair run, and the landing at the foot of it. */
  stairRun: 13,
  stairWidth: 2.4,
  /** The boundary fence along the seaward side. */
  fenceGap: 3.7,
  fencePitch: 3,
  fenceHeight: 1.35,
} as const;

/**
 * The Halcyon palette.
 *
 * This station was re-dressed to match the airport island's — same warm
 * sandstone slabs underfoot, the same slate-blue steel with a teal accent
 * line, a cedar soffit under the canopies and blue-grey glass on the rooflights
 * and the footbridge. The colours are lifted verbatim from `StationCanopies`
 * so the two stations on the same railway read as one estate, which is what a
 * railway's stations do.
 */
const HALCYON = {
  paving: '#bdb3a0',
  joint: '#948b7a',
  face: '#8b8f95',
  coping: '#cfc9bd',
  steel: '#3e5566',
  fascia: '#2f4a5e',
  accent: '#14a39a',
  soffit: '#a86a3f',
  roof: '#5a6268',
  glass: '#7fb3c0',
  rail: '#c9cdd0',
  tread: '#7f878c',
  line: '#e8b52a',
} as const;

/** Metres per paving repeat: four 600 mm slabs, the airport station's pitch. */
const SLAB = 2.4;

/**
 * The curved canopy over one island platform, as merged geometry.
 *
 * The airport station's canopy, in Kestrel's frame: local X is across the
 * platform and local Z is along it, so the arch is a cross-section in X extruded
 * along Z — where `StationCanopies` extrudes across a frame whose axes are the
 * other way round. An arch lowest at the two edges and `rise` higher at the
 * crown, on a rooflight down the middle, carried on tapered columns that fork
 * into a Y where the arms meet the shell.
 */
const CANOPY = { rise: 0.9, arms: 1.7, rooflight: 1.2, edgeInset: 0.15 } as const;

/** A shell layer: the strip between `bottom(x)` and `top(x)` from x0..x1, extruded `len` along Z. */
function shellX(
  x0: number, x1: number, top: (x: number) => number, bottom: (x: number) => number, len: number,
): BufferGeometry {
  const n = 16;
  const shape = new Shape();
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    if (i === 0) shape.moveTo(x, top(x)); else shape.lineTo(x, top(x));
  }
  for (let i = n; i >= 0; i--) {
    const x = x0 + ((x1 - x0) * i) / n;
    shape.lineTo(x, bottom(x));
  }
  return new ExtrudeGeometry(shape, { depth: len, bevelEnabled: false, steps: 1 })
    .translate(0, 0, -len / 2);
}

/** A box of length `len` from (z0,y0) to (z1,y1) in the Z–Y plane, `depth` wide in X at `x`: a stringer or handrail on a stair that runs along the line. */
function inclineZ(z0: number, y0: number, z1: number, y1: number, x: number, h: number, depth: number): BufferGeometry {
  const len = Math.hypot(z1 - z0, y1 - y0);
  return new BoxGeometry(depth, h, len)
    .rotateX(Math.atan2(-(y1 - y0), z1 - z0))
    .translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
}

interface CanopyBuild {
  steel: BufferGeometry | null;
  soffit: BufferGeometry | null;
  roof: BufferGeometry | null;
  glass: BufferGeometry | null;
  fascia: BufferGeometry | null;
  accent: BufferGeometry | null;
  lights: BufferGeometry | null;
  columns: Array<{ z: number; height: number; foot: number }>;
}

/** Everything the canopy is made of, over a platform `width` wide and `covered` long, its deck `under` metres over the surface `top`. */
function buildIslandCanopy(width: number, covered: number, top: number, under: number): CanopyBuild {
  const steel: BufferGeometry[] = [];
  const soffit: BufferGeometry[] = [];
  const roof: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const fascia: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const lights: BufferGeometry[] = [];
  const columns: Array<{ z: number; height: number; foot: number }> = [];

  const half = width / 2 - CANOPY.edgeInset;
  const soffitAt = (x: number) => under + CANOPY.rise * (1 - (x / half) ** 2);
  const gap = CANOPY.rooflight / 2;
  const layer = (list: BufferGeometry[], a: number, b: number, lo: number, hi: number) => {
    list.push(shellX(a, b, (x) => soffitAt(x) + hi, (x) => soffitAt(x) + lo, covered));
  };
  for (const [a, b] of [[-half, -gap], [gap, half]] as Array<[number, number]>) {
    layer(soffit, a, b, 0, 0.04);
    layer(roof, a, b, 0.04, 0.16);
  }
  layer(glass, -gap, gap, 0.06, 0.1);
  // Fascia with the teal line along each edge.
  for (const x of [-half, half]) {
    fascia.push(new BoxGeometry(0.1, 0.34, covered + 0.2).translate(x, under + 0.02, 0));
    accent.push(new BoxGeometry(0.105, 0.05, covered + 0.2).translate(x, under - 0.08, 0));
  }
  // Purlins where the arms meet the shell, and the light strip under them.
  for (const k of [-1, 1]) {
    const x = k * CANOPY.arms;
    steel.push(new BoxGeometry(0.2, 0.24, covered).translate(x, soffitAt(x) - 0.12, 0));
    lights.push(new BoxGeometry(0.12, 0.04, covered - 2).translate(x, soffitAt(x) - 0.26, 0));
  }
  // Tapered columns down the centre, forking into a Y.
  const fork = under - 0.8;
  const bays = Math.max(1, Math.round(covered / STATION.columnSpacing));
  for (let i = 0; i <= bays; i++) {
    const z = -covered / 2 + (covered * i) / bays;
    steel.push(new CylinderGeometry(0.11, 0.17, fork - top, 14).translate(0, top + (fork - top) / 2, z));
    for (const k of [-1, 1]) {
      const x1 = k * CANOPY.arms;
      const y1 = soffitAt(x1) - 0.22;
      const l = Math.hypot(x1, y1 - (fork - 0.05));
      steel.push(
        new CylinderGeometry(0.08, 0.08, l, 8)
          .rotateZ(-Math.atan2(x1, y1 - (fork - 0.05)))
          .translate(x1 / 2, (fork - 0.05 + y1) / 2, z),
      );
    }
    columns.push({ z, height: fork - top, foot: top });
  }

  const merge = (list: BufferGeometry[]) => (
    list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
  );
  return {
    steel: merge(steel), soffit: merge(soffit), roof: merge(roof), glass: merge(glass),
    fascia: merge(fascia), accent: merge(accent), lights: merge(lights), columns,
  };
}

/**
 * A solid ramp off one end of a platform.
 *
 * The end ramps were a thin tilted slab floating over a triangular void — from
 * the side you saw under it, and it did not stand on the ground. This is the
 * whole wedge: a triangular prism, full platform width, with a vertical face at
 * the platform end rising the platform's own height, a top that slopes down to
 * meet the ground over `run`, and solid concrete filling everything below. The
 * inner face sits at z = 0 and the ramp runs out toward +z; the caller mirrors
 * it for the other end.
 */
function makeRampWedge(width: number, rise: number, run: number): BufferGeometry {
  const w = width / 2;
  const v = new Float32Array([
    -w, 0, 0, -w, rise, 0, -w, 0, run, // left cap
    w, 0, 0, w, rise, 0, w, 0, run, // right cap
  ]);
  const idx = [
    0, 2, 1, // left cap (−x)
    3, 4, 5, // right cap (+x)
    0, 1, 4, 0, 4, 3, // vertical end face (−z)
    1, 2, 5, 1, 5, 4, // sloped top
    0, 3, 5, 0, 5, 2, // underside
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The back-sprung canopy over a SIDE platform — the airport station's other
 * canopy, for the relief-loop platform on the south side.
 *
 * Where the island canopy arches symmetrically over a centre row of columns,
 * this springs from a row along the platform's BACK — the building side — and
 * sweeps down to the track edge, which is what a canopy against a wall does.
 * `front` is the track edge (+x, north) and the back is −x. Local frame: x
 * across the platform, z along it.
 */
function buildSideCanopy(width: number, covered: number, top: number, under: number): CanopyBuild {
  const steel: BufferGeometry[] = [];
  const soffit: BufferGeometry[] = [];
  const roof: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const fascia: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const lights: BufferGeometry[] = [];
  const columns: Array<{ z: number; height: number; foot: number }> = [];

  const fx = width / 2 - CANOPY.edgeInset;
  const front = fx;            // the track edge (north)
  const rear = -fx;            // the building side (south)
  const colX = rear + 0.6;     // columns just in from the back
  const reach = front - colX;
  const soffitAt = (x: number) => under + CANOPY.rise * (1 - Math.min(1, ((x - colX) / reach) ** 2));
  soffit.push(shellX(rear, front, (x) => soffitAt(x) + 0.04, (x) => soffitAt(x) + 0, covered));
  roof.push(shellX(rear, front, (x) => soffitAt(x) + 0.16, (x) => soffitAt(x) + 0.04, covered));
  // Fascia with the teal line at the front; a short fascia along the back.
  fascia.push(new BoxGeometry(0.1, 0.34, covered + 0.2).translate(front, soffitAt(front) + 0.02, 0));
  accent.push(new BoxGeometry(0.105, 0.05, covered + 0.2).translate(front, soffitAt(front) - 0.08, 0));
  fascia.push(new BoxGeometry(0.1, 0.3, covered + 0.2).translate(rear, soffitAt(rear) + 0.05, 0));
  // Two purlins — one at the springing, one two-thirds out — with the lights.
  const head = colX + (front - colX) * 0.6;
  steel.push(new BoxGeometry(0.22, 0.26, covered).translate(colX, soffitAt(colX) - 0.13, 0));
  steel.push(new BoxGeometry(0.18, 0.22, covered).translate(head, soffitAt(head) - 0.11, 0));
  lights.push(new BoxGeometry(0.12, 0.04, covered - 2).translate(head, soffitAt(head) - 0.24, 0));
  const bays = Math.max(1, Math.round(covered / STATION.columnSpacing));
  for (let i = 0; i <= bays; i++) {
    const z = -covered / 2 + (covered * i) / bays;
    const topY = soffitAt(colX) - 0.26;
    steel.push(new CylinderGeometry(0.11, 0.16, topY - top, 14).translate(colX, top + (topY - top) / 2, z));
    // A strut up to the outer purlin.
    const y1 = soffitAt(head) - 0.22;
    const l = Math.hypot(head - colX, y1 - (topY - 1.1));
    steel.push(
      new CylinderGeometry(0.07, 0.07, l, 8)
        .rotateZ(-Math.atan2(head - colX, y1 - (topY - 1.1)))
        .translate((colX + head) / 2, (topY - 1.1 + y1) / 2, z),
    );
    columns.push({ z, height: topY - top, foot: top });
  }

  return {
    steel: merge(steel), soffit: merge(soffit), roof: merge(roof), glass: merge(glass),
    fascia: merge(fascia), accent: merge(accent), lights: merge(lights), columns,
  };
  function merge(list: BufferGeometry[]) {
    return list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null;
  }
}

/**
 * Platform paving: slabs, not a grey plane.
 *
 * The one texture this station could not do without. A 9 x 170 m surface in a
 * single flat colour has no scale — from the cab it is impossible to tell
 * whether the platform is ten metres away or a hundred, because nothing on it
 * repeats at a size the eye knows. Slabs give it that, and they cost one canvas.
 * Warm sandstone at a 600 mm pitch to match the airport station (`HALCYON`).
 */
function makePavingTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  // The joint grid first, as the ground the slabs sit in; the airport station's
  // sandstone over it.
  ctx.fillStyle = HALCYON.joint;
  ctx.fillRect(0, 0, 256, 256);
  let seed = 20260909;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const base = [1, 3, 5].map((i) => parseInt(HALCYON.paving.slice(i, i + 2), 16));
  const cell = 64;
  for (let gx = 0; gx < 4; gx++) {
    for (let gz = 0; gz < 4; gz++) {
      const k = 0.95 + random() * 0.08;
      ctx.fillStyle = `rgb(${base.map((c) => Math.min(255, Math.round(c * k))).join(',')})`;
      ctx.fillRect(gx * cell + 2, gz * cell + 2, cell - 4, cell - 4);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * A name board: the station's name, white on the railway's blue.
 *
 * Text on a canvas rather than a modelled sign, for the obvious reason, and
 * because a board whose name comes from `STATION_NAME` renames itself if the
 * route is regenerated onto a different island.
 */
function makeBoardTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#123a6b';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 6);
  ctx.fillRect(0, 122, 512, 6);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(STATION_NAME, 256, 68);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * One island platform: a slab, a coping strip down each face, a canopy over
 * the middle of it and a ramp off each end.
 *
 * Boxes in the station's own frame rather than swept sections, because a
 * platform is straight by definition — the roads it serves are parallel for
 * its whole length, which is what `STATION.approach` exists to guarantee.
 */
function Platform({
  from, to, paving, board, numbers,
}: {
  from: number;
  to: number;
  paving: CanvasTexture;
  board: CanvasTexture;
  /** The two road numbers this platform's faces serve, near face first. */
  numbers: readonly [number, number];
}) {
  const site = STATION_SITE;
  if (!site) return null;

  const width = to - from;
  const centre = (from + to) / 2;
  const railHead = site.centre[1] + RAIL_HEAD_LIFT;
  const top = railHead + STATION.platformRise;
  const base = site.ground;
  const height = top - base;
  const length = STATION.platformLength;
  const [x, , z] = stationPoint(0, centre);

  const copingInset = width / 2 - STATION.copingWidth / 2;
  /** The covered length: the canopy stops short of the ends so it is not a tunnel. */
  const covered = length - 40;
  /** The curved arch canopy, built once per platform geometry. See `buildIslandCanopy`. */
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const canopy = useMemo(() => buildIslandCanopy(width, covered, top, top + STATION.canopyHeight), [width, covered, top]);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const rampWedge = useMemo(() => makeRampWedge(width, height, STATION.rampLength), [width, height]);

  return (
    <group position={[x, 0, z]} rotation={[0, site.heading, 0]}>
      {/* The slab. Its top is the platform surface; it stands on the island
          crown rather than floating at rail height, so the face you see from a
          train is the full 2.3 m of it. */}
      <mesh position={[0, base + height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, height, length]} />
        <meshStandardMaterial color={HALCYON.face} roughness={0.94} />
      </mesh>

      {/* The paved surface, laid *on* the slab rather than flush into it.
          Five millimetres proud, and the five millimetres are the whole point:
          coplanar with the slab's own top face, the two surfaces z-fought and
          what showed through was a mottle of plain grey — the slabs were being
          drawn and were invisible. The coping still stands 15 mm over this.
          See `makePavingTexture` for why the texture is here at all. */}
      <mesh position={[0, top - 0.035, 0]} receiveShadow>
        <boxGeometry args={[width - STATION.copingWidth * 2, 0.08, length]} />
        <meshStandardMaterial
          map={paving}
          map-repeat-x={(width - STATION.copingWidth * 2) / SLAB}
          map-repeat-y={length / SLAB}
          roughness={0.88}
        />
      </mesh>

      {/* Coping: the lighter, slightly raised edging strip that marks where a
          platform stops. The one detail that makes a grey slab read as a
          platform, and it costs two boxes. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * copingInset, top + STATION.copingRise / 2, 0]}
          receiveShadow
        >
          <boxGeometry args={[STATION.copingWidth, STATION.copingRise, length]} />
          <meshStandardMaterial color={HALCYON.coping} roughness={0.85} />
        </mesh>
      ))}

      {/* The yellow line. Two long boxes, and the single strongest signal that
          this is a railway platform rather than a pier: it is the only pure
          colour anywhere in the station, and the eye reads it as an edge from
          hundreds of metres away. */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[
            side * (width / 2 - STATION.copingWidth - FIT.safetyGap - FIT.safetyWidth / 2),
            top + 0.011,
            0,
          ]}
          receiveShadow
        >
          <boxGeometry args={[FIT.safetyWidth, 0.02, length]} />
          <meshStandardMaterial color={HALCYON.line} roughness={0.8} />
        </mesh>
      ))}

      {/* Ramps: a SOLID wedge off each end, standing on the crown and rising to
          the platform's own height, so the platform runs down to the ballast
          instead of ending in a drop or floating over a void. See
          `makeRampWedge`. */}
      {[-1, 1].map((end) => (
        <mesh
          key={end}
          geometry={rampWedge}
          position={[0, base, end * (length / 2)]}
          scale={[1, 1, end]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={HALCYON.face} roughness={0.95} />
        </mesh>
      ))}

      {/* Canopy: the airport station's curved arch (`buildIslandCanopy`), a
          shell lowest at the edges and higher at a glazed rooflight down the
          crown, carried on tapered columns that fork into a Y. Short of the
          platform ends — a canopy the whole length reads as a tunnel. */}
      {canopy.soffit && (
        <mesh geometry={canopy.soffit} position={[0, 0, 0]} receiveShadow>
          <meshStandardMaterial color={HALCYON.soffit} roughness={0.7} />
        </mesh>
      )}
      {canopy.roof && (
        <mesh geometry={canopy.roof} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.roof} roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {canopy.glass && (
        <mesh geometry={canopy.glass}>
          <meshStandardMaterial color={HALCYON.glass} roughness={0.05} metalness={0.2} transparent opacity={0.45} depthWrite={false} />
        </mesh>
      )}
      {canopy.steel && (
        <mesh geometry={canopy.steel} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.steel} roughness={0.45} metalness={0.45} />
        </mesh>
      )}
      {canopy.fascia && (
        <mesh geometry={canopy.fascia} castShadow>
          <meshStandardMaterial color={HALCYON.fascia} roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      {canopy.accent && (
        <mesh geometry={canopy.accent}>
          <meshStandardMaterial color={HALCYON.accent} roughness={0.5} />
        </mesh>
      )}
      {canopy.lights && (
        <mesh geometry={canopy.lights}>
          <meshBasicMaterial color="#fff4d8" toneMapped={false} />
        </mesh>
      )}
      {/* A collider on each canopy column, so a car cannot drive through one. */}
      <RigidBody type="fixed" colliders={false}>
        {canopy.columns.map((c) => (
          <CuboidCollider key={c.z} args={[0.17, c.height / 2, 0.17]} position={[0, c.foot + c.height / 2, c.z]} />
        ))}
      </RigidBody>

      {/* Benches and bins, under the canopy and clear of its columns. Alternate
          sides of the centre line, which is both what a real platform does and
          what stops them queueing up behind one another from the cab view. */}
      {Array.from({ length: Math.floor(covered / FIT.benchSpacing) }, (_, i) => {
        const at = -covered / 2 + FIT.benchSpacing * (i + 0.5);
        const side = i % 2 ? 1 : -1;
        return (
          <group key={`bench${i}`} position={[side * 1.55, top, at]}>
            <mesh position={[0, 0.46, 0]} castShadow receiveShadow>
              <boxGeometry args={[0.52, 0.09, 2.0]} />
              <meshStandardMaterial color="#6b4b32" roughness={0.9} />
            </mesh>
            <mesh position={[side * 0.24, 0.78, 0]} rotation={[0, 0, side * 0.12]} castShadow>
              <boxGeometry args={[0.08, 0.5, 2.0]} />
              <meshStandardMaterial color="#6b4b32" roughness={0.9} />
            </mesh>
            {[-1, 1].map((leg) => (
              <mesh key={leg} position={[0, 0.23, leg * 0.8]} castShadow>
                <boxGeometry args={[0.46, 0.46, 0.09]} />
                <meshStandardMaterial color="#3e5566" roughness={0.7} metalness={0.3} />
              </mesh>
            ))}
          </group>
        );
      })}
      {Array.from({ length: Math.floor(covered / FIT.binSpacing) }, (_, i) => {
        const at = -covered / 2 + FIT.binSpacing * (i + 0.8);
        const side = i % 2 ? -1 : 1;
        return (
          <mesh key={`bin${i}`} position={[side * 1.5, top + 0.45, at]} castShadow receiveShadow>
            <boxGeometry args={[0.5, 0.9, 0.5]} />
            <meshStandardMaterial color="#2f4a5e" roughness={0.85} />
          </mesh>
        );
      })}

      {/* Name boards, hung off posts along each edge and facing the train that
          is stopping. `DoubleSide` because the back of a board is seen from the
          other road. */}
      {[-1, 1].flatMap((side) => Array.from(
        { length: Math.floor(length / FIT.boardSpacing) },
        (_, i) => {
          const at = -length / 2 + FIT.boardSpacing * (i + 0.5);
          return (
            <group
              key={`board${side}${i}`}
              position={[side * (width / 2 - 1.15), top, at]}
            >
              {[-1, 1].map((post) => (
                <mesh
                  key={post}
                  position={[0, FIT.boardHeight / 2, post * FIT.boardSize[0] * 0.36]}
                  castShadow
                >
                  <boxGeometry args={[0.09, FIT.boardHeight, 0.09]} />
                  <meshStandardMaterial color="#4f5761" roughness={0.6} metalness={0.35} />
                </mesh>
              ))}
              <mesh
                position={[0, FIT.boardHeight, 0]}
                rotation={[0, Math.PI / 2, 0]}
                castShadow
              >
                <boxGeometry args={[FIT.boardSize[0], FIT.boardSize[1], 0.05]} />
                <meshStandardMaterial map={board} roughness={0.75} side={DoubleSide} />
              </mesh>
            </group>
          );
        },
      ))}

      {/* Road numbers, one at each end of each face, so the driver of a train
          being routed into a loop can see which road they have been given.
          Painted on the platform rather than hung: a number on the deck is
          readable from the cab, and from the drone it labels the layout. */}
      {[-1, 1].flatMap((end) => numbers.map((number, face) => {
        const side = face === 0 ? -1 : 1;
        return (
          <mesh
            key={`num${end}${number}`}
            position={[
              side * (width / 2 - STATION.copingWidth - 1.35),
              top + 0.012,
              end * (length / 2 - 6),
            ]}
            receiveShadow
          >
            <boxGeometry args={[0.9, 0.02, 1.4]} />
            <meshStandardMaterial color="#e8e4da" roughness={0.85} />
          </mesh>
        );
      }))}

      {/* Solid, because the island crown is solid: a car that reaches this
          island can drive onto the platform ramp, and it should stand on the
          platform rather than pass through it. One box, not the trimesh of
          everything above — a platform is a box. */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[width / 2, height / 2, length / 2]}
          position={[0, base + height / 2, 0]}
        />
      </RigidBody>
    </group>
  );
}

/**
 * The footbridge, and the stairs off it.
 *
 * The piece that turns four roads and two islands of concrete into a station
 * you could actually use: without it, platform B is unreachable except by
 * walking the track. It also does something for the *look* that nothing on the
 * platforms can — it is the only thing here that crosses the railway, so it
 * gives the whole complex a piece of structure to be seen against, and from a
 * passing cab it is the one object that reads as "station" in a single frame.
 *
 * Laid out in the station's own frame: local X is metres left of the running
 * line and local Z is metres along it, which is what `stationPoint` and
 * `roadOffset` already speak. The deck therefore spans from the town side of
 * the up line to just outside road 3, and its legs stand in the only places
 * there is room for them — on each platform's centre line, in the six-metre
 * cess between roads 1 and 2, and on the ground at each end.
 */
/* --------------------------------------------------- the station's overhead */

/**
 * World point `across` metres left of the running line at `along`, `rise` over
 * the rail head.
 *
 * On the true alignment, not the flat frame — the same distinction that decides
 * where the roads themselves are laid (`stationRailPoint`). The station is
 * level, so the height is one number rather than a lookup.
 */
function olePoint(along: number, across: number, rise: number): Vector3 {
  const site = STATION_SITE;
  const [x, , z] = stationRailPoint(along, across);
  return new Vector3(x, (site ? site.centre[1] : 0) + RAIL_HEAD_LIFT + rise, z);
}

/** A square-section strut between two world points. */
function strut(a: Vector3, b: Vector3, r: number): BoxGeometry {
  const length = Math.max(a.distanceTo(b), 1e-4);
  const g = new BoxGeometry(r * 2, r * 2, length);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(
    new Vector3(0, 0, 1), b.clone().sub(a).normalize(),
  ));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Depth of the lattice beam, and the pitch of its bracing. */
const BEAM_DEPTH = 0.85;
const BRACE_PITCH = 2.6;
/** How far the messenger sags at mid-bay over a loop, and the loop wire's section. */
const WIRE_HALF = 0.016;
const MESSENGER_HALF = 0.013;

/**
 * The overhead line through the station: portals across every road, and wire
 * over the loops.
 *
 * Two things were wrong. The loops had **no wire at all** — `Lineside` wires
 * the two roads the running line carries and knows nothing about the station's
 * own, so a train could be routed into a platform under bare sky. And the
 * masts it does build are single-track: one column in the cess beside each
 * road, which through a four-road throat means a forest of them, several
 * planted between rails that are converging on each other.
 *
 * A station spans the lot from a portal instead — two masts outside the whole
 * formation and a lattice beam between them, with a registration dropping to
 * each track's contact wire. That is what the reference photograph shows and
 * what any wired station with more than two roads actually has. `Lineside`
 * stands its own masts down wherever `yard` is set, so the two do not fight;
 * the WIRES still run through, because a contact wire that stops at the
 * station is worse than no station.
 */
function StationCatenary() {
  const built = useMemo(() => {
    const site = STATION_SITE;
    if (!site || !BUILT_ROADS.length) return null;
    const contact = CATENARY.contact;
    const messenger = CATENARY.messenger;
    const pitch = CATENARY.mastPitch;

    // --- wire over each loop, contact and messenger, with its droppers.
    const wires: BufferGeometry[] = [];
    const dropperGeo: BufferGeometry[] = [];
    const sagAt = (arc: number) => {
      const u = (arc / pitch) - Math.floor(arc / pitch);
      return CATENARY.sag * 4 * u * (1 - u);
    };
    const section = (rise: (s: Road) => number, half: number): ProfileVertex<Road>[] => [
      { off: -half, rise: (s) => rise(s) - half },
      { off: half, rise: (s) => rise(s) - half },
      { off: half, rise: (s) => rise(s) + half },
      { off: -half, rise: (s) => rise(s) + half },
    ];
    for (const road of BUILT_ROADS) {
      const samples = sampleRoad(road.offsetAt, road.separationAt, road.to);
      if (samples.length < 2) continue;
      wires.push(
        buildLoft(samples, section(() => contact, WIRE_HALF), { closed: true }).geometry,
        buildLoft(samples, section((s) => messenger - sagAt(s.arc), MESSENGER_HALF),
          { closed: true }).geometry,
      );
      // Droppers hang the contact wire off the messenger. Walked along the
      // road's own arc, because that is the length the wire actually has.
      const length = samples[samples.length - 1].arc;
      let k = 0;
      for (let at = CATENARY.dropperPitch / 2; at < length; at += CATENARY.dropperPitch) {
        while (k < samples.length - 2 && samples[k + 1].arc < at) k++;
        const a = samples[k];
        const b = samples[k + 1];
        const t = Math.min(1, Math.max(0, (at - a.arc) / Math.max(b.arc - a.arc, 1e-6)));
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const y = a.y;
        dropperGeo.push(strut(
          new Vector3(x, y + messenger - sagAt(at), z),
          new Vector3(x, y + contact + 0.02, z),
          0.011,
        ));
      }
    }

    // --- portals, in phase with the plain line's mast bays so the spans read
    // as one run of wire rather than two grids that happen to meet.
    const steel: BufferGeometry[] = [];
    const first = Math.ceil((site.arc - STATION_YARD - pitch / 2) / pitch);
    const last = Math.floor((site.arc + STATION_YARD - pitch / 2) / pitch);
    /**
     * How far a portal has to stand off the footbridge.
     *
     * Half the bridge's width and a bit: the mast bays are in phase with the
     * plain line's, and on this station that put a portal at along -77 with the
     * footbridge at -78 — the lattice beam inside the bridge's span with its
     * top chord level with the parapet, one metre apart. Real overhead line
     * does not build a portal where a bridge crosses; it lengthens the bay and
     * stands the structure clear, which is what this does.
     */
    const bridgeClear = FIT.bridgeWidth / 2 + 3;
    for (let bay = first; bay <= last; bay++) {
      const nominal = pitch / 2 + bay * pitch - site.arc;
      const toBridge = nominal - FIT.bridgeAlong;
      const along = Math.abs(toBridge) < bridgeClear
        ? FIT.bridgeAlong + Math.sign(toBridge || 1) * bridgeClear
        : nominal;
      const inner = stationInner(along) - CATENARY.mastOff;
      const outer = stationOuter(along) + CATENARY.mastOff;
      const foot = SLEEPER_BOTTOM - 0.65;
      // The two masts, and the lattice beam across everything between them.
      for (const across of [inner, outer]) {
        steel.push(strut(
          olePoint(along, across, foot), olePoint(along, across, CATENARY.mastTop), 0.13,
        ));
      }
      const chords: Array<[number, number]> = [
        [CATENARY.mastTop, CATENARY.mastTop],
        [CATENARY.mastTop - BEAM_DEPTH, CATENARY.mastTop - BEAM_DEPTH],
      ];
      for (const [r0, r1] of chords) {
        steel.push(strut(olePoint(along, inner, r0), olePoint(along, outer, r1), 0.055));
      }
      // Bracing: an upright and a diagonal per panel, which is what makes it a
      // girder rather than a pair of pipes.
      const panels = Math.max(2, Math.round((outer - inner) / BRACE_PITCH));
      for (let i = 0; i <= panels; i++) {
        const at = inner + ((outer - inner) * i) / panels;
        steel.push(strut(
          olePoint(along, at, CATENARY.mastTop),
          olePoint(along, at, CATENARY.mastTop - BEAM_DEPTH), 0.035,
        ));
        if (i === panels) continue;
        const next = inner + ((outer - inner) * (i + 1)) / panels;
        steel.push(strut(
          olePoint(along, at, CATENARY.mastTop - BEAM_DEPTH),
          olePoint(along, next, CATENARY.mastTop), 0.03,
        ));
      }
      // A registration down to each track: the drop tube off the lower chord
      // and the steady arm that sets the contact wire's stagger.
      const zig = bay % 2 === 0 ? CATENARY.stagger : -CATENARY.stagger;
      for (const centre of stationTracks(along)) {
        const wireX = centre + zig;
        const dropTop = olePoint(along, wireX, CATENARY.mastTop - BEAM_DEPTH);
        const dropFoot = olePoint(along, wireX, contact + 0.45);
        steel.push(strut(dropTop, dropFoot, 0.045));
        steel.push(strut(dropFoot, olePoint(along, wireX, contact + 0.05), 0.022));
        // The insulator where the drop leaves the beam.
        steel.push(strut(
          olePoint(along, wireX, CATENARY.mastTop - BEAM_DEPTH - 0.1),
          olePoint(along, wireX, CATENARY.mastTop - BEAM_DEPTH - 0.5), 0.075,
        ));
      }
    }

    const merge = (parts: BufferGeometry[]) => (parts.length ? mergeGeometries(parts) : null);
    const result = { wire: merge(wires), droppers: merge(dropperGeo), steel: merge(steel) };
    for (const g of [...wires, ...dropperGeo, ...steel]) g.dispose();
    return result;
  }, []);

  useEffect(() => () => {
    built?.wire?.dispose();
    built?.droppers?.dispose();
    built?.steel?.dispose();
  }, [built]);

  if (!built) return null;
  return (
    <group>
      {built.steel && (
        <mesh geometry={built.steel} castShadow>
          <meshStandardMaterial color="#8b9198" roughness={0.6} metalness={0.55} />
        </mesh>
      )}
      {built.wire && (
        <mesh geometry={built.wire}>
          <meshStandardMaterial color="#6f5f4c" roughness={0.5} metalness={0.7} />
        </mesh>
      )}
      {built.droppers && (
        <mesh geometry={built.droppers}>
          <meshStandardMaterial color="#7a6a56" roughness={0.55} metalness={0.6} />
        </mesh>
      )}
    </group>
  );
}

function Footbridge() {
  const site = STATION_SITE;
  const built = useMemo(() => {
    if (!site) return null;
  const railHead = site.centre[1] + RAIL_HEAD_LIFT;
  const platformTop = railHead + STATION.platformRise;
  const ground = site.ground;
  const deckTop = railHead + FIT.bridgeClearance + FIT.bridgeDeck;

  /**
   * Where the deck starts and stops, across the line.
   *
   * The town side clears whatever is furthest right — the running line's own
   * ballast toe, or the relief loop's, now that there is a road out there —
   * and then 4.2 m more, which is not spare: the flight down to the town has
   * to LAND on the crown clear of that toe, and 1.4 m of deck was not enough
   * to hang a 2.8 m stair from.
   */
  const outerToe = Math.min(-MAIN_LINE_TOE, UP_LOOP - MAIN_LINE_TOE);
  const townSide = outerToe - 4.2;
  const seaSide = ROADS[ROADS.length - 1] + 3.4;
  const span = seaSide - townSide;
  const mid = (townSide + seaSide) / 2;
  /**
   * The legs, each carrying what it stands on and whether a flight comes down
   * it.
   *
   * A list of bare numbers with the stairs indexing `legs[1]` and `legs[3]` is
   * what this was, and adding one leg for the relief loop shifted every index
   * under it: the flights ended up over the cess at platform height instead of
   * on the platforms, and the two legs that were marked as standing on a
   * platform were the ones that no longer did, so they hung in the air while
   * the real platform legs speared through the paving. Naming what each leg is
   * makes that class of mistake impossible rather than merely fixed.
   */
  const legs: Array<{ across: number; onPlatform: boolean; stair: boolean }> = [
    { across: townSide + 0.6, onPlatform: false, stair: false },
    // The cess between the relief loop and the running line.
    { across: UP_LOOP / 2, onPlatform: false, stair: false },
    { across: (PLATFORMS[0].from + PLATFORMS[0].to) / 2, onPlatform: true, stair: true },
    // The cess between the middle pair, which share a formation.
    { across: (ROADS[1] + ROADS[2]) / 2, onPlatform: false, stair: false },
    { across: (PLATFORMS[1].from + PLATFORMS[1].to) / 2, onPlatform: true, stair: true },
    { across: seaSide - 0.6, onPlatform: false, stair: false },
  ];
  const [x, , z] = stationPoint(FIT.bridgeAlong, 0);

    // The airport station's glazed footbridge, in Kestrel's frame: a roofed deck
    // on a column on each platform and cess, glazed the full height of both long
    // sides, with a stair down onto each island platform running along the line.
    // Built as merged geometry, one mesh per material, exactly the airport
    // station's construction (`StationCanopies`).
    const treads: BufferGeometry[] = [];
    const steel: BufferGeometry[] = [];
    const glass: BufferGeometry[] = [];
    const rails: BufferGeometry[] = [];
    const nosing: BufferGeometry[] = [];
    const fascia: BufferGeometry[] = [];
    const accent: BufferGeometry[] = [];
    const roof: BufferGeometry[] = [];
    const colliders: Array<{ centre: [number, number, number]; half: [number, number, number] }> = [];

    const floor = deckTop;
    const halfW = FIT.bridgeWidth / 2;
    const wall = 2.4;
    // The deck slab and the beam under it.
    treads.push(new BoxGeometry(span, 0.1, FIT.bridgeWidth).translate(mid, floor - 0.05, 0));
    steel.push(new BoxGeometry(span + 0.3, 0.7, FIT.bridgeWidth).translate(mid, floor - 0.45, 0));
    // Both long sides: glass, a top rail, a handrail and an accent line, with
    // mullions at a regular pitch.
    for (const k of [-1, 1]) {
      const zEdge = k * halfW;
      accent.push(new BoxGeometry(span, 0.06, 0.02).translate(mid, floor - 0.3, k * (halfW + 0.16)));
      glass.push(new BoxGeometry(span, wall, 0.03).translate(mid, floor + wall / 2, zEdge));
      steel.push(new BoxGeometry(span, 0.14, 0.12).translate(mid, floor + wall, zEdge));
      rails.push(new BoxGeometry(span, 0.06, 0.06).translate(mid, floor + 1.0, k * (halfW - 0.1)));
      const mullions = Math.round(span / 3);
      for (let i = 0; i <= mullions; i++) {
        steel.push(new BoxGeometry(0.12, wall, 0.12).translate(townSide + (span * i) / mullions, floor + wall / 2, zEdge));
      }
    }
    roof.push(new BoxGeometry(span + 0.6, 0.14, FIT.bridgeWidth + 0.6).translate(mid, floor + wall + 0.12, 0));
    fascia.push(new BoxGeometry(span + 0.64, 0.28, FIT.bridgeWidth + 0.64).translate(mid, floor + wall + 0.02, 0));
    // The end walls, glazed.
    for (const ex of [townSide, seaSide]) glass.push(new BoxGeometry(0.03, wall, FIT.bridgeWidth).translate(ex, floor + wall / 2, 0));
    colliders.push({ centre: [mid, floor + wall / 2 - 0.4, 0], half: [span / 2, wall / 2 + 0.4, halfW + 0.15] });

    // A column under the deck at every leg, standing on what is under it.
    for (const l of legs) {
      const foot = l.onPlatform ? platformTop : ground;
      const colH = floor - 0.8 - foot;
      steel.push(new BoxGeometry(0.45, colH, 0.45).translate(l.across, foot + colH / 2, 0));
      colliders.push({ centre: [l.across, foot + colH / 2, 0], half: [0.23, colH / 2, 0.23] });
    }

    // A stair down onto each island platform, and one to the town's ground.
    const S = { going: 0.3, rise: 0.17, width: FIT.stairWidth, landing: 1.4 };
    const flights = [
      ...legs.filter((l) => l.stair).map((l) => ({ across: l.across, foot: platformTop })),
      { across: townSide + 2.4, foot: ground },
    ];
    for (const { across, foot } of flights) {
      const total = floor - foot;
      const risers = Math.max(2, Math.round(total / S.rise));
      const rise = total / risers;
      const firstFlight = Math.floor(risers / 2);
      const xA = across - S.width / 2;
      const xB = across + S.width / 2;
      let zc = halfW;
      let y = floor;
      const profile: Array<[number, number]> = [[zc, y]];
      for (let i = 0; i < risers; i++) {
        if (i === firstFlight) {
          treads.push(new BoxGeometry(S.width, 0.25, S.landing).translate(across, y - 0.125, zc + S.landing / 2));
          zc += S.landing;
          profile.push([zc, y]);
        }
        y -= rise;
        const h = y - foot;
        if (h > 0.001) {
          treads.push(new BoxGeometry(S.width, Math.min(h, 0.3), S.going).translate(across, y - Math.min(h, 0.3) / 2, zc + S.going / 2));
          nosing.push(new BoxGeometry(S.width, 0.012, 0.05).translate(across, y + 0.006, zc + S.going - 0.03));
        }
        zc += S.going;
        profile.push([zc, y]);
      }
      // Slate-blue stringers, glass balustrades and handrails, flight by flight.
      for (let i = 1; i < profile.length; i++) {
        const [za, ya] = profile[i - 1];
        const [zb, yb] = profile[i];
        for (const px of [xA - 0.08, xB + 0.08]) {
          steel.push(inclineZ(za, ya - 0.25, zb, yb - 0.25, px, 0.55, 0.14));
          glass.push(inclineZ(za, ya + 0.55, zb, yb + 0.55, px, 1.0, 0.025));
          rails.push(inclineZ(za, ya + 1.05, zb, yb + 1.05, px, 0.05, 0.06));
        }
      }
      const runZ = zc - halfW;
      colliders.push({
        centre: [across, foot + total / 4, halfW + runZ / 2],
        half: [S.width / 2 + 0.15, total / 4, runZ / 2],
      });
    }

    const merge = (list: BufferGeometry[]) => (
      list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
    );
    return {
      treads: merge(treads), steel: merge(steel), glass: merge(glass), rails: merge(rails),
      nosing: merge(nosing), fascia: merge(fascia), accent: merge(accent), roof: merge(roof),
      colliders, x, z, heading: site.heading,
    };
  }, [site]);

  if (!built) return null;

  return (
    <group position={[built.x, 0, built.z]} rotation={[0, built.heading, 0]}>
      {built.treads && (
        <mesh geometry={built.treads} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.tread} roughness={0.85} />
        </mesh>
      )}
      {built.steel && (
        <mesh geometry={built.steel} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.steel} roughness={0.45} metalness={0.45} />
        </mesh>
      )}
      {built.fascia && (
        <mesh geometry={built.fascia} castShadow>
          <meshStandardMaterial color={HALCYON.fascia} roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      {built.accent && (
        <mesh geometry={built.accent}>
          <meshStandardMaterial color={HALCYON.accent} roughness={0.5} />
        </mesh>
      )}
      {built.roof && (
        <mesh geometry={built.roof} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.roof} roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {built.nosing && (
        <mesh geometry={built.nosing}>
          <meshStandardMaterial color={HALCYON.line} roughness={0.6} />
        </mesh>
      )}
      {built.glass && (
        <mesh geometry={built.glass}>
          <meshStandardMaterial color={HALCYON.glass} roughness={0.05} metalness={0.2} transparent opacity={0.45} depthWrite={false} />
        </mesh>
      )}
      {built.rails && (
        <mesh geometry={built.rails}>
          <meshStandardMaterial color={HALCYON.rail} roughness={0.3} metalness={0.8} />
        </mesh>
      )}
      <RigidBody type="fixed" colliders={false}>
        {built.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.centre} />
        ))}
      </RigidBody>
    </group>
  );
}

/**
 * The boundary fence along the seaward side.
 *
 * Cheap depth. A railway has an edge, and on the sea side of road 3 there is
 * nothing at all between the ballast and the beach — which is what made the
 * station look like a model on a table rather than a place. Posts and two
 * rails, instanced, on the one hand where nothing else has to fit.
 */
/**
 * Where the fence stops: at a level crossing, and well clear of one.
 *
 * It did not, and it never had: the boundary runs the yard's whole 604 m on
 * the railway's own frame and the east crossing is inside that, so a
 * post-and-rail fence has been standing across the road at +255 since the
 * crossing was built. The west one (`KESTREL_WEST_CROSSING`) would have made it
 * two. A crossing is a hole in a boundary — that is what it is for — so the
 * posts are dropped for the deck's width and a car's length either side of it.
 *
 * Asked in the station's FLAT frame, because that is the frame the crossings
 * are laid out in, and the fence's own points are found on the true alignment:
 * at the west end those two are 14.8 m and 12.6 degrees apart, so comparing the
 * fence's arc length against a crossing's `along` would open the gap in the
 * wrong place. `stationFrameOf` puts the post where the crossing can see it.
 */
const CROSSING_GAP = 5;

function fenced(x: number, z: number): boolean {
  const [along] = stationFrameOf(x, z);
  for (const C of [CROSSING, KESTREL_WEST_CROSSING]) {
    if (C && Math.abs(along - C.along) < C.halfWidth + CROSSING_GAP) return true;
  }
  return false;
}

function SeaFence() {
  const posts = useRef<InstancedMesh>(null);
  const site = STATION_SITE;
  const built = useMemo(() => {
    if (!site || STATION_YARD <= 0) return null;
    // On the railway's frame and OUTSIDE whatever the outermost track is here,
    // not at a fixed offset in the flat frame. At a fixed offset it kept a
    // constant distance from a straight line the railway leaves — 24 m out by
    // the west throat — and it also ignored the throat entirely, standing 18 m
    // clear of the roads at the platforms and a metre and a half from a running
    // rail where they had converged. Following `stationOuter` it is the same
    // distance beyond the last road everywhere, which is what a boundary is.
    const count = Math.max(2, Math.round((STATION_YARD * 2) / FIT.fencePitch));
    const pts: Array<{ x: number; z: number; gap: boolean }> = [];
    for (let i = 0; i <= count; i++) {
      const along = -STATION_YARD + (STATION_YARD * 2 * i) / count;
      const [x, , z] = stationRailPoint(along, stationOuter(along) + FIT.fenceGap);
      pts.push({ x, z, gap: fenced(x, z) });
    }
    return pts;
  }, [site]);

  useEffect(() => {
    const instanced = posts.current;
    if (!instanced || !site || !built) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3(0.1, FIT.fenceHeight, 0.1);
    let n = 0;
    built.forEach((p, i) => {
      if (p.gap) return;
      const a = built[Math.max(0, i - 1)];
      const b = built[Math.min(built.length - 1, i + 1)];
      euler.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
      quaternion.setFromEuler(euler);
      position.set(p.x, site.ground + FIT.fenceHeight / 2, p.z);
      instanced.setMatrixAt(n++, matrix.compose(position, quaternion, scale));
    });
    instanced.count = n;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [built, site]);

  const rails = useMemo(() => {
    if (!built) return null;
    // Two rails, as a panel between each pair of posts so they follow the curve
    // and the taper rather than cutting the corner.
    const parts: BufferGeometry[] = [];
    for (let i = 1; i < built.length; i++) {
      const a = built[i - 1];
      const b = built[i];
      if (a.gap || b.gap) continue;
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span < 0.05) continue;
      for (const rise of [0.45, 0.95]) {
        const panel = new BoxGeometry(0.05, 0.07, span);
        panel.rotateY(Math.atan2(b.x - a.x, b.z - a.z));
        panel.translate((a.x + b.x) / 2, rise, (a.z + b.z) / 2);
        parts.push(panel);
      }
    }
    if (!parts.length) return null;
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return merged;
  }, [built]);

  useEffect(() => () => { rails?.dispose(); }, [rails]);

  if (!site || !built) return null;
  return (
    <group>
      <instancedMesh ref={posts} args={[undefined, undefined, built.length]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#6c665c" roughness={0.9} />
      </instancedMesh>
      {rails && (
        <mesh geometry={rails} position={[0, site.ground, 0]} castShadow>
          <meshStandardMaterial color="#6c665c" roughness={0.9} />
        </mesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ the town */

/**
 * Surfaces that are the block's own ground — what it should be stood on.
 *
 * The block is seated on its road surface, not on its lowest vertex. Its
 * lowest vertex is a building foundation three metres *below* the city's
 * pavement, and seating on that put the whole town on a three-metre plinth
 * with a drop off the kerb into the sea. Foundations are supposed to be buried,
 * and on the island they bury themselves in the crown exactly as they do in
 * the city.
 */
const PAVED = new Set(['Street', 'Street_1', 'Parking', 'MaterialPiso']);

interface Transplant {
  meshes: Array<{ geometry: BufferGeometry; material: Material | Material[]; cast: boolean }>;
  solid: Array<{ vertices: Float32Array; indices: Uint32Array }>;
  /** Source-space centre in XZ and lowest vertex, for seating the block. */
  offset: [number, number, number];
  /** Measured footprint, so the block can be seated from its near edge. */
  depth: number;
}

/**
 * Collects the chunks of one city cell out of the already-loaded city.
 *
 * Chunk role and surface travel in glTF `extras`, which is where `CityMap`
 * reads them from too — never in the node name, which three sanitises on load.
 * The cell is in the name, because that is the only place the preprocessor puts
 * it, and it survives sanitising: it is digits and underscores.
 */
function collect(scene: Mesh['parent']): Transplant | null {
  if (!scene) return null;
  const meshes: Transplant['meshes'] = [];
  const solid: Transplant['solid'] = [];
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  /** Lowest point of the block's own paving — the surface it stands on. */
  let datum = Infinity;

  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    if (!object.name.endsWith(`_${TOWN.cell}`)) return;
    const extras = object.userData as { surface?: string; collides?: boolean };
    if (TOWN.skip.includes(extras.surface ?? '')) return;

    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) {
      lo.min(box.min);
      hi.max(box.max);
      if (PAVED.has(extras.surface ?? '')) datum = Math.min(datum, box.min.y);
    }
    meshes.push({ geometry, material: object.material, cast: true });
    if (!extras.collides) return;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!position || !index) return;
    solid.push({
      vertices: position.array as Float32Array,
      indices: index.array instanceof Uint32Array
        ? index.array
        : new Uint32Array(index.array),
    });
  });

  if (!meshes.length) return null;
  return {
    meshes,
    solid,
    // Centred in XZ, and stood on its paving. Falls back to the lowest vertex
    // only if the block turns out to have no paved surface at all.
    offset: [-(lo.x + hi.x) / 2, -(Number.isFinite(datum) ? datum : lo.y),
      -(lo.z + hi.z) / 2],
    depth: hi.z - lo.z,
  };
}

/**
 * The transplanted block, and the paving that ties it to the railway.
 *
 * Two nested groups, and the order matters: the inner one moves the block's own
 * centre to the origin and its lowest vertex to the ground, the outer one turns
 * it to the railway's heading and carries it to the island. Rotating before
 * centring would swing the block around a point 800 m away in the city.
 */
function Town() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);
  const site = STATION_SITE;
  const block = useMemo(() => collect(scene), [scene]);
  if (!site || !block) return null;
  // The *other* town, and the one that is easy to miss: `IslandTown` builds
  // streets and blocks from `townConfig`, and this transplants a 277 x 75 m
  // cell of the city — its roads, its buildings and its street furniture —
  // onto the far side of the line. Both are the town, so both answer to the
  // same switch. Stripping only the first left the island looking clear from
  // the platform and still carrying a block of city behind the camera, which
  // the map showed plainly. The link road from the bridge head goes with it:
  // it exists to join the causeway to this block, and there is nothing to join
  // it to now.
  if (!TOWN_BUILT) return null;

  // Seated from the near edge, on the far side of the line from the platforms.
  // See `TOWN.nearGap` for why the depth is measured rather than stated.
  const across = -(MAIN_LINE_TOE + TOWN.nearGap + block.depth / 2);
  const [x, , z] = stationPoint(TOWN.along, across);
  const [tx, tz] = site.tangent;
  // The block's own long axis is +X in city space; this turns that axis along
  // the railway. See the note in the component docstring.
  const turn = Math.atan2(-tz, tx);
  const ground = site.ground + TOWN.lift;

  // The link from the bridge head up to the block's own paving. Drawn in world
  // space rather than inside the block's frame, because it belongs to neither:
  // it runs from a fixed point on the shore to whatever edge the block turned
  // out to have. Without it the bridge lands in a field — the car could still
  // drive off onto the grass and up onto the streets, since the island crown is
  // solid, but a road that stops short of the town reads as unfinished.
  const bridge = BRIDGE;
  const link = bridge ? (() => {
    const south = z + block.depth / 2;
    const run = south - bridge.islandZ;
    if (run <= 0) return null;
    return { x: bridge.x, z: (south + bridge.islandZ) / 2, run };
  })() : null;

  return (
    <>
    {link && (
      <mesh
        position={[link.x, ground + 0.02, link.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[ISLAND_LINK.halfWidth * 2, link.run]} />
        <meshStandardMaterial color="#4a4b4d" roughness={0.95} />
      </mesh>
    )}
    <group position={[x, ground, z]} rotation={[0, turn, 0]}>
      <group position={block.offset}>
        {block.meshes.map((m, i) => (
          <mesh key={i} geometry={m.geometry} material={m.material} castShadow receiveShadow />
        ))}
        {/* The city's own colliders, moved with it: whatever was solid in the
            city is solid here. */}
        <RigidBody type="fixed" colliders={false}>
          {block.solid.map((s, i) => (
            <TrimeshCollider key={i} args={[s.vertices, s.indices]} friction={0.9} />
          ))}
        </RigidBody>
      </group>
    </group>
    </>
  );
}

/* ------------------------------------------------- the south side of the line */

/**
 * The south side, which had nothing on it.
 *
 * The four roads and both island platforms are north of the running line, on
 * the side of this island with the land; south of the line there was the relief
 * loop and then open grass down to the shore. So the south gets what a station's
 * front usually is: a platform on the relief loop, an entrance building facing
 * it across a forecourt, and — since the shore road was rerouted out to −72 to
 * make room (`kestrelRoads`) — clear ground between them.
 *
 * The offsets, from the running line (`across` negative is south):
 * the relief loop is at `UP_LOOP` (−6); its platform's track edge is a setback
 * inside that; the building stands a few metres behind the platform's back.
 */
const SOUTH = (() => {
  const setback = 1.7;
  const width = 9;
  const front = UP_LOOP - setback;        // the track edge, nearest the loop
  const centre = front - width / 2;
  const back = front - width;             // the platform's back
  const buildFront = back - 3;            // 3 m of forecourt path behind the platform
  const buildDepth = 20;
  return {
    setback, width, front, centre, back,
    buildFront, buildDepth,
    buildBack: buildFront - buildDepth,
    buildCentre: buildFront - buildDepth / 2,
    buildLength: 64,
    length: STATION.platformLength,
  };
})();

/**
 * The relief-loop platform: a side platform, coped and canopied on the track
 * side only, its back to the station building. Halcyon dress throughout
 * (`HALCYON`, `buildSideCanopy`), the same as the island platforms.
 */
function SouthPlatform({ paving, board }: { paving: CanvasTexture; board: CanvasTexture }) {
  const site = STATION_SITE;
  const width = SOUTH.width;
  const length = SOUTH.length;
  const covered = length - 40;
  const canopy = useMemo(
    () => (site ? buildSideCanopy(width, covered, site.centre[1] + RAIL_HEAD_LIFT + STATION.platformRise,
      site.centre[1] + RAIL_HEAD_LIFT + STATION.platformRise + STATION.canopyHeight) : null),
    [site, width, covered],
  );
  const rampWedge = useMemo(
    () => (site ? makeRampWedge(width, site.centre[1] + RAIL_HEAD_LIFT + STATION.platformRise - site.ground, STATION.rampLength) : null),
    [site, width],
  );
  if (!site || !canopy || !rampWedge) return null;

  const railHead = site.centre[1] + RAIL_HEAD_LIFT;
  const top = railHead + STATION.platformRise;
  const base = site.ground;
  const height = top - base;
  const [x, , z] = stationPoint(0, SOUTH.centre);
  // +x is north (the track edge); the coping and yellow line go on that face.
  const edge = width / 2;
  const copingInset = edge - STATION.copingWidth / 2;

  return (
    <group position={[x, 0, z]} rotation={[0, site.heading, 0]}>
      <mesh position={[0, base + height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, height, length]} />
        <meshStandardMaterial color={HALCYON.face} roughness={0.94} />
      </mesh>
      <mesh position={[0, top - 0.035, 0]} receiveShadow>
        <boxGeometry args={[width - STATION.copingWidth, 0.08, length]} />
        <meshStandardMaterial
          map={paving}
          map-repeat-x={(width - STATION.copingWidth) / SLAB}
          map-repeat-y={length / SLAB}
          roughness={0.88}
        />
      </mesh>
      {/* Coping and the yellow line, on the track (north, +x) face only. */}
      <mesh position={[copingInset, top + STATION.copingRise / 2, 0]} receiveShadow>
        <boxGeometry args={[STATION.copingWidth, STATION.copingRise, length]} />
        <meshStandardMaterial color={HALCYON.coping} roughness={0.85} />
      </mesh>
      <mesh position={[edge - STATION.copingWidth - 0.12 - 0.225, top + 0.011, 0]} receiveShadow>
        <boxGeometry args={[0.45, 0.02, length]} />
        <meshStandardMaterial color={HALCYON.line} roughness={0.8} />
      </mesh>
      {/* Solid wedge ramps off each end — see `makeRampWedge`. */}
      {[-1, 1].map((end) => (
        <mesh
          key={end}
          geometry={rampWedge}
          position={[0, base, end * (length / 2)]}
          scale={[1, 1, end]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={HALCYON.face} roughness={0.95} />
        </mesh>
      ))}
      {/* The back-sprung canopy. */}
      {canopy.soffit && (
        <mesh geometry={canopy.soffit} receiveShadow>
          <meshStandardMaterial color={HALCYON.soffit} roughness={0.7} />
        </mesh>
      )}
      {canopy.roof && (
        <mesh geometry={canopy.roof} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.roof} roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {canopy.steel && (
        <mesh geometry={canopy.steel} castShadow receiveShadow>
          <meshStandardMaterial color={HALCYON.steel} roughness={0.45} metalness={0.45} />
        </mesh>
      )}
      {canopy.fascia && (
        <mesh geometry={canopy.fascia} castShadow>
          <meshStandardMaterial color={HALCYON.fascia} roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      {canopy.accent && (
        <mesh geometry={canopy.accent}>
          <meshStandardMaterial color={HALCYON.accent} roughness={0.5} />
        </mesh>
      )}
      {canopy.lights && (
        <mesh geometry={canopy.lights}>
          <meshBasicMaterial color="#fff4d8" toneMapped={false} />
        </mesh>
      )}
      {/* A name board along the loop face. */}
      {Array.from({ length: Math.floor(length / FIT.boardSpacing) }, (_, i) => {
        const at = -length / 2 + FIT.boardSpacing * (i + 0.5);
        return (
          <group key={`board${i}`} position={[edge - 1.15, top, at]}>
            {[-1, 1].map((post) => (
              <mesh key={post} position={[0, FIT.boardHeight / 2, post * FIT.boardSize[0] * 0.36]} castShadow>
                <boxGeometry args={[0.09, FIT.boardHeight, 0.09]} />
                <meshStandardMaterial color={HALCYON.steel} roughness={0.6} metalness={0.35} />
              </mesh>
            ))}
            <mesh position={[0, FIT.boardHeight, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
              <boxGeometry args={[FIT.boardSize[0], FIT.boardSize[1], 0.05]} />
              <meshStandardMaterial map={board} roughness={0.75} side={DoubleSide} />
            </mesh>
          </group>
        );
      })}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[width / 2, height / 2, length / 2]} position={[0, base + height / 2, 0]} />
        {canopy.columns.map((c) => (
          <CuboidCollider key={c.z} args={[0.16, c.height / 2, 0.16]} position={[-SOUTH.width / 2 + 0.6, c.foot + c.height / 2, c.z]} />
        ))}
      </RigidBody>
    </group>
  );
}

/**
 * The station building on the south side: the user's railway station model
 * (`railway_station.glb`, see `prepare-kestrel-station`).
 *
 * It is turned the way a real station stands: its street face looks south
 * over a paved forecourt to the shore road, and its back is to the
 * relief-loop platform, three metres away across a path. The frontage is
 * furnished from the city's park kit — see `planForecourt`.
 */
const HALL_MODEL = HALL_DATA.model;
const HALL_PART = 'kestrelStation';
useGLTF.preload(HALL_MODEL, DRACO_PATH);

/** Drawn at the size it was modelled: 91 m along the line, 31 m deep. */
const HALL_SCALE = 1;
/**
 * Its length runs along the line, and its front — the model's +Z, the side
 * with the doors — looks south to the road.
 */
const HALL_TURN = -Math.PI / 2;
/** Where the shore road's north kerb is: its centreline (−72, `kestrelRoads`) less half a carriageway. */
const SHORE_KERB = -72 + 9.4;

/** The city's park kit — the same trees, lamps and benches as the school and the park. */
const PARK_MODEL = '/models/park.glb';
useGLTF.preload(PARK_MODEL, DRACO_PATH);
const KIT = ['treeBroad', 'treeBig', 'bush', 'lamp', 'bench', 'bin'] as const;
type KitPart = (typeof KIT)[number];
interface Placed { across: number; along: number; turn: number; scale: number }

/**
 * Where the forecourt's furniture goes, as park-kit parts in the hall's frame
 * (x across, north +; z along). `front` is the hall's street face and `kerb`
 * the road's.
 *
 * The plot in front of the hall is narrow — the building is 31 m deep and the
 * road is 12 m beyond it — so this is a station frontage rather than a
 * square: along the face, lamps with benches, bins and bushes between them;
 * along the kerb, a row of street trees; the middle left clear in front of the
 * doors, with bollards across it at the road. Scenery, like every tree and
 * lamp on this island: none of it is a collider (see `KestrelSchool`).
 */
function planForecourt(front: number, kerb: number, length: number) {
  const placed = new Map<KitPart, Placed[]>(KIT.map((k) => [k, []]));
  const put = (part: KitPart, across: number, along: number, turn: number, scale = 1) =>
    placed.get(part)!.push({ across, along, turn, scale });
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clear = 9; // half the open bay in front of the doors

  // Along the face: a lamp every bay; between, a bench facing the road with a
  // bin beside it, and a bush.
  const faceX = front - 2.5;
  const bays = 6;
  const span = length - 10;
  for (let i = 0; i <= bays; i++) {
    const z = -span / 2 + span * i / bays;
    if (Math.abs(z) < clear) continue;
    put('lamp', faceX, z, 0, 1.6);
  }
  for (let i = 0; i < bays; i++) {
    const z = -span / 2 + span * (i + 0.5) / bays;
    if (Math.abs(z) < clear) continue;
    put('bench', faceX - 0.6, z - 1.5, Math.PI, 1);
    put('bin', faceX - 0.6, z + 0.2, 0, 1);
    put('bush', faceX + 0.6, z + 2.6, rnd() * Math.PI * 2, 0.9 + rnd() * 0.2);
  }

  // Along the kerb: street trees, a pair either side of the open bay.
  const treeX = kerb + 2.4;
  const spacing = 8;
  for (let z = clear + 3; z <= length / 2 - 2; z += spacing) {
    for (const side of [-1, 1]) {
      const kind: KitPart = rnd() < 0.6 ? 'treeBroad' : 'treeBig';
      put(kind, treeX, side * z, rnd() * Math.PI * 2, kind === 'treeBroad' ? 0.85 + rnd() * 0.15 : 0.6 + rnd() * 0.1);
    }
  }
  return placed;
}

/** Bollards across the open bay at the kerb: the only furniture not from the kit. */
function buildBollards(kerb: number) {
  const parts: BufferGeometry[] = [];
  for (let z = -8; z <= 8; z += 2.2) {
    if (Math.abs(z) < 1.5) continue;
    parts.push(new CylinderGeometry(0.11, 0.11, 0.9, 8).translate(kerb + 0.6, 0.45, z));
  }
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  for (const g of parts) g.dispose();
  return merged;
}

/** One kit part, instanced in the hall's frame. */
function KitField({ geometry, material, at, castShadow }: {
  geometry: BufferGeometry;
  material: Material;
  at: readonly Placed[];
  castShadow: boolean;
}) {
  const matrices = useMemo(() => {
    const q = new Quaternion();
    const p = new Vector3();
    const sc = new Vector3();
    const up = new Vector3(0, 1, 0);
    return at.map((a) => {
      q.setFromAxisAngle(up, a.turn);
      p.set(a.across, 0.03, a.along);
      sc.setScalar(a.scale);
      return new Matrix4().compose(p, q, sc);
    });
  }, [at]);
  if (!matrices.length) return null;
  return <InstancedField matrices={matrices} geometry={geometry} material={material} castShadow={castShadow} />;
}

function StationBuilding({ board, paving }: { board: CanvasTexture; paving: CanvasTexture }) {
  const site = STATION_SITE;
  const { scene } = useGLTF(HALL_MODEL, DRACO_PATH);
  const { scene: parkScene } = useGLTF(PARK_MODEL, DRACO_PATH);

  // Cloned out of drei's shared scene — see `KestrelMall` for why.
  const hall = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return copy;
  }, [scene]);

  // The kit's geometry and materials, shared rather than cloned: instancing
  // only reads them. The same lookup `KestrelSchool` does.
  const kit = useMemo(() => {
    const out = new Map<KitPart, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of KIT) {
      const node = (parkScene as unknown as Object3D).getObjectByName(name);
      if (!node) continue;
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      node.traverse((child) => {
        if (child instanceof Mesh) pairs.push({ geometry: child.geometry, material: child.material as Material });
      });
      if (pairs.length) out.set(name, pairs);
    }
    return out;
  }, [parkScene]);

  const size = HALL_DATA.size as [number, number, number];
  const length = size[0] * HALL_SCALE;
  const depth = size[2] * HALL_SCALE;
  // Its back to the platform path, three metres behind the platform.
  const centreAcross = SOUTH.buildFront - depth / 2;
  // In the hall's own frame: x is across (north +), z is along.
  const south = -depth / 2;
  const kerb = SHORE_KERB - centreAcross;
  const plazaLength = length + 10;

  const placed = useMemo(() => planForecourt(south, kerb, plazaLength), [south, kerb, plazaLength]);
  const bollards = useMemo(() => buildBollards(kerb), [kerb]);
  useEffect(() => () => bollards.dispose(), [bollards]);
  // Its own copy of the platforms' slab texture, because a repeat is a
  // property of the texture and the platforms set theirs on the shared one.
  const slabs = useMemo(() => {
    const t = paving.clone();
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set((south - kerb) / SLAB, plazaLength / SLAB);
    t.needsUpdate = true;
    return t;
  }, [paving, south, kerb, plazaLength]);
  useEffect(() => () => slabs.dispose(), [slabs]);

  if (!site || !hall) return null;
  const base = site.ground;
  const [x, , z] = stationPoint(0, centreAcross);
  const plazaDepth = south - kerb;

  return (
    <group position={[x, base, z]} rotation={[0, site.heading, 0]}>
      <group rotation={[0, HALL_TURN, 0]} scale={HALL_SCALE}>
        <primitive object={hall} />
      </group>

      {/* The name, white on railway blue, over the doors. */}
      <mesh position={[south - 0.12, 7, 0]} rotation={[0, -Math.PI / 2, 0]} castShadow>
        <boxGeometry args={[12, 1.3, 0.08]} />
        <meshStandardMaterial map={board} roughness={0.7} />
      </mesh>

      {/* Paving: the frontage to the kerb, and the path behind to the platform. */}
      <mesh position={[(south + kerb) / 2, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[plazaDepth, plazaLength]} />
        <meshStandardMaterial map={slabs} color="#d8d2c6" roughness={0.9} />
      </mesh>
      <mesh position={[-south + 2, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[4, plazaLength]} />
        <meshStandardMaterial color={HALCYON.paving} roughness={0.9} />
      </mesh>

      {/* The furniture: the city's own park kit — see `planForecourt`. */}
      {KIT.map((part) => kit.get(part)?.map((pair, i) => (
        <KitField
          key={`${part}${i}`}
          geometry={pair.geometry}
          material={pair.material}
          at={placed.get(part)!}
          castShadow={part !== 'bin' && part !== 'bush'}
        />
      )))}
      <mesh geometry={bollards} castShadow>
        <meshStandardMaterial color={HALCYON.steel} roughness={0.5} metalness={0.45} />
      </mesh>

      <RigidBody type="fixed" colliders={false}>
        {partColliders(HALL_PART, 0, 0, HALL_TURN, size, 'station-hall', HALL_SCALE)}
      </RigidBody>
    </group>
  );
}

/* ------------------------------------------------------------------ the whole */

export function IslandStation() {
  const built = useMemo(() => {
    if (!STATION_SITE) return null;
    const g = TRAIN.gauge / 2;
    // See `BUILT_ROADS`: the platform loops off the down line, and the relief
    // loop off the up.
    const roads = BUILT_ROADS.map((built) => {
      const samples = sampleRoad(built.offsetAt, built.separationAt, built.to);
      return {
        road: built.name,
        railLeft: buildLoft(samples, bladedRailProfile<Road>(-g), { vScale: V_SCALE, closed: true }),
        railRight: buildLoft(samples, bladedRailProfile<Road>(g), { vScale: V_SCALE, closed: true }),
      };
    });
    return {
      roads,
      formation: buildLoft(sampleYard(), FORMATION_PROFILE, { vScale: V_SCALE }),
      ballastTexture: makeBallastTexture(),
      paving: makePavingTexture(),
      board: makeBoardTexture(),
    };
  }, []);

  useEffect(() => {
    if (!built) return;
    return () => {
      built.ballastTexture.dispose();
      built.paving.dispose();
      built.board.dispose();
      built.formation.geometry.dispose();
      for (const road of built.roads) {
        road.railLeft.geometry.dispose();
        road.railRight.geometry.dispose();
      }
    };
  }, [built]);

  if (!built || !STATION_SITE) return null;

  return (
    <group>
      {/* One formation under the lot — see `FORMATION_PROFILE`. */}
      <mesh geometry={built.formation.geometry} receiveShadow castShadow>
        <meshStandardMaterial map={built.ballastTexture} roughness={1} />
      </mesh>
      <GeometryCollider geometry={built.formation.geometry} />
      {built.roads.map(({ road, railLeft, railRight }) => (
        <group key={road}>
          {/* DoubleSide for the reason the running line's rails are: a 13 cm
              section winds whichever way its road happens to travel, and paying
              for the back faces is cheaper than reasoning about it. */}
          {/* One rail material for the whole railway — see `RAIL_STEEL`. */}
          {[railLeft, railRight].map((rail, i) => (
            <mesh key={i} geometry={rail.geometry} material={RAIL_STEEL} castShadow receiveShadow />
          ))}
        </group>
      ))}

      <Sleepers />
      {/* Platform A takes roads 1 and 2 — the up line's own face and the down
          line's — and platform B the outer loops, 3 and 4. The numbers are the
          driver's, counted from the running line out, and they are what the
          route indicator's road names mean on the ground. */}
      {PLATFORMS.map((platform, i) => (
        <Platform
          key={platform.from}
          from={platform.from}
          to={platform.to}
          paving={built.paving}
          board={built.board}
          numbers={i === 0 ? [1, 2] : [3, 4]}
        />
      ))}
      {/* The south side: the relief-loop platform and the station building
          facing it across a forecourt. See `SOUTH`. */}
      <SouthPlatform paving={built.paving} board={built.board} />
      <StationBuilding board={built.board} paving={built.paving} />
      <Footbridge />
      {/* Portals over every road, and wire over the loops — see
          `StationCatenary`. Outside any group: it is built in world space on
          the true alignment, like the lineside. */}
      <StationCatenary />
      <SeaFence />
      <Town />
    </group>
  );
}
