'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, DoubleSide, Euler, InstancedMesh, Material,
  Matrix4, Mesh,
  Quaternion, RepeatWrapping, SRGBColorSpace, Vector3,
} from 'three';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import {
  CATENARY, RAIL_HEAD_LIFT, TRAIN, trainNormalAt, trainPointAt, trainWrap,
} from '@/config/trainConfig';
import {
  BRIDGE, ISLAND_LINK, MAIN_LINE_TOE, PLATFORMS, ROADS, STATION, STATION_SITE,
  STATION_NAME, STATION_STEP, STATION_YARD, TOWN, UP_LOOP, roadDrawn, roadOffset,
  stationInner, stationOuter, stationPoint, stationRailPoint, stationTracks, upLoopDrawn,
  upLoopOffset,
} from '@/config/stationConfig';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { SLEEPER_GEOMETRY } from './sleeper';

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
interface Road extends LoftSample {
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

const railProfile = (centre: number) => [
  { off: centre - TRAIN.railWidth / 2, rise: 0 },
  { off: centre + TRAIN.railWidth / 2, rise: 0 },
  { off: centre + TRAIN.railWidth / 2, rise: SLEEPER_TOP },
  { off: centre - TRAIN.railWidth / 2, rise: SLEEPER_TOP },
];

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
function sampleRoad(offsetAt: (along: number) => number, to: number): Road[] {
  const site = STATION_SITE;
  if (!site) return [];
  // Symmetric, and `to` is where the road has closed on the one it is joining:
  // past that point the two are the same piece of track, so carrying on would
  // lay this rail inside that one. See `STATION.bladeGap`, and `pointwork` for
  // what happens at the merge itself.
  const from = -to;
  const count = Math.max(2, Math.round((to - from) / STATION_STEP));
  const y = site.centre[1] + RAIL_HEAD_LIFT;
  const fill = site.centre[1] - site.ground;

  const points: Array<[number, number]> = [];
  for (let i = 0; i <= count; i++) {
    const along = from + ((to - from) * i) / count;
    // On the RAILWAY's frame, not the flat one: `stationPoint` projects `along`
    // down one tangent, and 200 m out the line has curved away from it, so a
    // road laid that way closes on where the down line is not. See
    // `stationRailPoint`.
    const [x, , z] = stationRailPoint(along, offsetAt(along));
    points.push([x, z]);
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
    samples.push({ x, z, y, arc, fill, nx: tz / len, nz: -tx / len });
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
  to: number;
}> = STATION_SITE
  ? [
    ...ROADS.slice(2).map((road) => ({
      name: `road ${road}`,
      offsetAt: (along: number) => roadOffset(road, along),
      to: roadDrawn(road),
    })),
    { name: 'relief loop', offsetAt: upLoopOffset, to: upLoopDrawn() },
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
    const samples = sampleRoad(built.offsetAt, built.to);
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
 * Platform paving: slabs, not a grey plane.
 *
 * The one texture this station could not do without. A 9 x 170 m surface in a
 * single flat colour has no scale — from the cab it is impossible to tell
 * whether the platform is ten metres away or a hundred, because nothing on it
 * repeats at a size the eye knows. Slabs at 1.5 m give it that, and they cost
 * one canvas.
 */
function makePavingTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#b3aea4';
  ctx.fillRect(0, 0, 256, 256);
  // Four slabs each way, with a joint between them and a little tone variation
  // so the grid does not read as a printed pattern.
  let seed = 20260909;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const cell = 64;
  for (let gx = 0; gx < 4; gx++) {
    for (let gz = 0; gz < 4; gz++) {
      const tone = 168 + Math.floor(random() * 22);
      ctx.fillStyle = `rgb(${tone},${tone - 4},${tone - 12})`;
      ctx.fillRect(gx * cell + 1.5, gz * cell + 1.5, cell - 3, cell - 3);
    }
  }
  ctx.strokeStyle = 'rgba(90,86,80,0.5)';
  ctx.lineWidth = 2;
  for (let g = 0; g <= 4; g++) {
    ctx.beginPath();
    ctx.moveTo(g * cell, 0);
    ctx.lineTo(g * cell, 256);
    ctx.moveTo(0, g * cell);
    ctx.lineTo(256, g * cell);
    ctx.stroke();
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
  /** The covered length, and where the canopy's deck sits. */
  const covered = length - 40;
  const canopyTop = top + STATION.canopyHeight;
  const beams = Math.floor(covered / FIT.beamSpacing) + 1;
  const lights = Math.floor(covered / FIT.lightSpacing);
  /** Lamp posts only where the canopy is not: under it they would be pointless. */
  const openRun = (length - covered) / 2;
  const lamps = Math.max(1, Math.floor(openRun / FIT.lampSpacing));

  return (
    <group position={[x, 0, z]} rotation={[0, site.heading, 0]}>
      {/* The slab. Its top is the platform surface; it stands on the island
          crown rather than floating at rail height, so the face you see from a
          train is the full 2.3 m of it. */}
      <mesh position={[0, base + height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, height, length]} />
        <meshStandardMaterial color="#9a968e" roughness={0.94} />
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
          map-repeat-x={(width - STATION.copingWidth * 2) / FIT.slab}
          map-repeat-y={length / FIT.slab}
          roughness={0.93}
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
          <meshStandardMaterial color="#cfc9bd" roughness={0.85} />
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
          <meshStandardMaterial color="#e8b52a" roughness={0.8} />
        </mesh>
      ))}

      {/* Ramps: a wedge off each end, so the platform runs out to the ballast
          instead of ending in a 2.3 m drop. Built as a squashed box rotated
          about its long axis — a real ramp is a plane, and a plane is all this
          is ever seen as. */}
      {[-1, 1].map((end) => (
        <mesh
          key={end}
          position={[0, top - height / 4, end * (length / 2 + STATION.rampLength / 2)]}
          rotation={[end * Math.atan2(height, STATION.rampLength * 2), 0, 0]}
          receiveShadow
        >
          <boxGeometry args={[width, 0.3, Math.hypot(STATION.rampLength, height / 2) * 2]} />
          <meshStandardMaterial color="#8f8b83" roughness={0.95} />
        </mesh>
      ))}

      {/* Canopy: a deck on a row of columns down the platform centre, with an
          edge board hanging off each side, a ridge along the top and beams
          across the underside.
          Deliberately short of the platform ends — a canopy that runs the whole
          length reads as a tunnel, and no station has one.
          The edge boards are what earn their place here: a bare slab lid is a
          canopy seen from above and a *line* seen from a train, and the valance
          is the part a passenger actually looks at. */}
      <mesh position={[0, canopyTop, 0]} castShadow>
        <boxGeometry args={[STATION.canopyHalfWidth * 2, STATION.canopyThickness, covered]} />
        <meshStandardMaterial color="#3f4650" roughness={0.7} metalness={0.15} />
      </mesh>
      <mesh position={[0, canopyTop + STATION.canopyThickness / 2 + FIT.ridgeHeight / 2, 0]}>
        <boxGeometry args={[FIT.ridgeWidth, FIT.ridgeHeight, covered]} />
        <meshStandardMaterial color="#4a525e" roughness={0.6} metalness={0.2} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[
            side * (STATION.canopyHalfWidth - FIT.fasciaThickness / 2),
            canopyTop - STATION.canopyThickness / 2 - FIT.fascia / 2,
            0,
          ]}
          castShadow
        >
          <boxGeometry args={[FIT.fasciaThickness, FIT.fascia, covered]} />
          <meshStandardMaterial color="#e6e2d8" roughness={0.85} />
        </mesh>
      ))}
      {Array.from({ length: beams }, (_, i) => (
        <mesh
          key={`beam${i}`}
          position={[
            0,
            canopyTop - STATION.canopyThickness / 2 - FIT.beamDepth / 2,
            -covered / 2 + i * FIT.beamSpacing,
          ]}
          castShadow
        >
          <boxGeometry args={[STATION.canopyHalfWidth * 2 - 0.3, FIT.beamDepth, 0.18]} />
          <meshStandardMaterial color="#59626e" roughness={0.6} metalness={0.25} />
        </mesh>
      ))}
      {Array.from(
        { length: Math.floor(covered / STATION.columnSpacing) + 1 },
        (_, i) => (
          <mesh
            key={`col${i}`}
            position={[0, top + STATION.canopyHeight / 2, -covered / 2 + i * STATION.columnSpacing]}
            castShadow
          >
            <boxGeometry args={[STATION.columnHalf * 2, STATION.canopyHeight,
              STATION.columnHalf * 2]} />
            <meshStandardMaterial color="#55606d" roughness={0.6} metalness={0.3} />
          </mesh>
        ),
      )}

      {/* Down-lights under the canopy. Unlit and self-coloured, like the
          tunnel's strips: they are light sources as far as the eye is
          concerned, and sixty real ones would be sixty shadow maps. */}
      {Array.from({ length: lights }, (_, i) => (
        <mesh
          key={`lamp${i}`}
          position={[
            0,
            canopyTop - STATION.canopyThickness / 2 - FIT.beamDepth - 0.06,
            -covered / 2 + FIT.lightSpacing / 2 + i * FIT.lightSpacing,
          ]}
        >
          <boxGeometry args={[0.5, 0.09, 1.5]} />
          <meshBasicMaterial color="#fff4d8" toneMapped={false} />
        </mesh>
      ))}

      {/* Lamp posts on the open ends, where the canopy stops. A column with a
          head cantilevered off it, one each side of the centre line so the
          uncovered platform is lit across its width. */}
      {[-1, 1].flatMap((end) => Array.from({ length: lamps }, (_, i) => {
        const at = end * (covered / 2 + FIT.lampSpacing * (i + 0.6));
        if (Math.abs(at) > length / 2 - 2) return null;
        return (
          <group key={`post${end}${i}`} position={[0, top, at]}>
            <mesh position={[0, FIT.lampHeight / 2, 0]} castShadow>
              <boxGeometry args={[0.16, FIT.lampHeight, 0.16]} />
              <meshStandardMaterial color="#4f5761" roughness={0.6} metalness={0.35} />
            </mesh>
            {[-1, 1].map((side) => (
              <group key={side}>
                <mesh position={[side * FIT.lampReach / 2, FIT.lampHeight, 0]} castShadow>
                  <boxGeometry args={[FIT.lampReach, 0.1, 0.1]} />
                  <meshStandardMaterial color="#4f5761" roughness={0.6} metalness={0.35} />
                </mesh>
                <mesh position={[side * FIT.lampReach, FIT.lampHeight - 0.1, 0]}>
                  <boxGeometry args={[0.44, 0.12, 0.44]} />
                  <meshBasicMaterial color="#fff2cf" toneMapped={false} />
                </mesh>
              </group>
            ))}
          </group>
        );
      }))}

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
                <meshStandardMaterial color="#454c55" roughness={0.7} metalness={0.3} />
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
            <meshStandardMaterial color="#2f3a34" roughness={0.85} />
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
      const samples = sampleRoad(road.offsetAt, road.to);
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
  const balusters = Math.floor(span / FIT.balusterSpacing);

  return (
    <group position={[x, 0, z]} rotation={[0, site.heading, 0]}>
      {/* The deck, and a kerb up each side of it. */}
      <mesh position={[mid, deckTop - FIT.bridgeDeck / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[span, FIT.bridgeDeck, FIT.bridgeWidth]} />
        <meshStandardMaterial color="#8d939b" roughness={0.85} metalness={0.1} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh
            position={[mid, deckTop + FIT.parapet, side * (FIT.bridgeWidth / 2 - 0.05)]}
            castShadow
          >
            <boxGeometry args={[span, FIT.parapetThickness, FIT.parapetThickness]} />
            <meshStandardMaterial color="#4f5761" roughness={0.55} metalness={0.4} />
          </mesh>
          {/* Balusters rather than a solid panel: a solid parapet from below is
              a grey wall in the sky, and the gaps are what make it a bridge. */}
          {Array.from({ length: balusters }, (_, i) => (
            <mesh
              key={i}
              position={[
                townSide + FIT.balusterSpacing * (i + 0.5),
                deckTop + FIT.parapet / 2,
                side * (FIT.bridgeWidth / 2 - 0.05),
              ]}
              castShadow
            >
              <boxGeometry args={[0.05, FIT.parapet, 0.05]} />
              <meshStandardMaterial color="#5a636e" roughness={0.6} metalness={0.35} />
            </mesh>
          ))}
        </group>
      ))}

      {/* Legs. Each stands on whatever is under it — platform, cess or island
          crown — so none of them hangs in the air. */}
      {legs.map(({ across, onPlatform }) => {
        const foot = onPlatform ? platformTop : ground;
        const height = deckTop - FIT.bridgeDeck - foot;
        return (
          <mesh
            key={across}
            position={[across, foot + height / 2, 0]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[0.42, height, 0.42]} />
            <meshStandardMaterial color="#7d838b" roughness={0.8} metalness={0.15} />
          </mesh>
        );
      })}

      {/* Three flights: one to each platform, and one down to the town's road.
          They run along the line rather than across it, which is the only way
          they can go — across, a flight would land on the track. */}
      {[
        // Onto each platform, from the leg that actually stands on it.
        ...legs.filter((l) => l.stair).map((l) => ({
          across: l.across, foot: platformTop, width: FIT.stairWidth,
        })),
        // And down to the town's road. Inboard of the deck's end rather than
        // 1.6 m beyond it, where its head hung off the end of the bridge, and
        // far enough out that its landing clears the relief loop's ballast.
        { across: townSide + 2.4, foot: ground, width: FIT.stairWidth + 0.4 },
      ].map(({ across, foot, width }, i) => {
        const rise = deckTop - foot;
        const run = Math.max(FIT.stairRun, rise * 2.1);
        const length = Math.hypot(run, rise);
        return (
          <group key={i} position={[across, 0, 0]}>
            <mesh
              position={[0, foot + rise / 2, run / 2]}
              rotation={[-Math.atan2(rise, run), 0, 0]}
              castShadow
              receiveShadow
            >
              <boxGeometry args={[width, 0.26, length]} />
              <meshStandardMaterial color="#868c94" roughness={0.9} />
            </mesh>
            {/* A handrail each side, following the flight. */}
            {[-1, 1].map((side) => (
              <mesh
                key={side}
                position={[side * (width / 2 - 0.06), foot + rise / 2 + 0.95, run / 2]}
                rotation={[-Math.atan2(rise, run), 0, 0]}
                castShadow
              >
                <boxGeometry args={[0.07, 0.07, length]} />
                <meshStandardMaterial color="#4f5761" roughness={0.6} metalness={0.4} />
              </mesh>
            ))}
            {/* The landing at the foot. */}
            <mesh position={[0, foot + 0.05, run + 1.5]} receiveShadow>
              <boxGeometry args={[width, 0.1, 3]} />
              <meshStandardMaterial color="#8d939b" roughness={0.9} />
            </mesh>
          </group>
        );
      })}
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
    const pts: Array<{ x: number; z: number }> = [];
    for (let i = 0; i <= count; i++) {
      const along = -STATION_YARD + (STATION_YARD * 2 * i) / count;
      const [x, , z] = stationRailPoint(along, stationOuter(along) + FIT.fenceGap);
      pts.push({ x, z });
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
    built.forEach((p, i) => {
      const a = built[Math.max(0, i - 1)];
      const b = built[Math.min(built.length - 1, i + 1)];
      euler.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
      quaternion.setFromEuler(euler);
      position.set(p.x, site.ground + FIT.fenceHeight / 2, p.z);
      instanced.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    instanced.count = built.length;
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

/* ------------------------------------------------------------------ the whole */

export function IslandStation() {
  const built = useMemo(() => {
    if (!STATION_SITE) return null;
    const g = TRAIN.gauge / 2;
    // See `BUILT_ROADS`: the platform loops off the down line, and the relief
    // loop off the up.
    const roads = BUILT_ROADS.map((built) => {
      const samples = sampleRoad(built.offsetAt, built.to);
      return {
        road: built.name,
        railLeft: buildLoft(samples, railProfile(-g), { vScale: V_SCALE, closed: true }),
        railRight: buildLoft(samples, railProfile(g), { vScale: V_SCALE, closed: true }),
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
      {built.roads.map(({ road, railLeft, railRight }) => (
        <group key={road}>
          {/* DoubleSide for the reason the running line's rails are: a 13 cm
              section winds whichever way its road happens to travel, and paying
              for the back faces is cheaper than reasoning about it. */}
          {[railLeft, railRight].map((rail, i) => (
            <mesh key={i} geometry={rail.geometry} castShadow receiveShadow>
              <meshStandardMaterial
                color="#8e949c" roughness={0.35} metalness={0.85} side={DoubleSide}
              />
            </mesh>
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
