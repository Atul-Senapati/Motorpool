'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BoxGeometry, CanvasTexture, DoubleSide, Euler, InstancedMesh, Matrix4, Mesh, Quaternion,
  RepeatWrapping, SRGBColorSpace, Vector3, type BufferGeometry, type Group, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import {
  RAIL_HEAD_LIFT, TRAIN, TRAIN_LENGTH, trainNormalAt, trainPointAt, trainWrap,
} from '@/config/trainConfig';
import { STATION_SITE, stationTracks } from '@/config/stationConfig';
import {
  CAR_PARK, CROSSING, FENCE, FORECOURT, FORECOURT_KIT, LAMPS, PARK, PARKING_STRIP,
  RAIL_CORRIDOR, RING, RING_CHAINS, RING_ENABLED, STREETS, SURFACE, TOWN_BUILDINGS,
  TOWN_PALETTE, TOWN_PARKED, TOWN_PROP_PART, TOWN_SITE, TOWN_TREE_PART, type Street,
} from '@/config/townConfig';
import catalogue from '@/config/vehicleCatalogue.json';
import { trainsOnTrack } from '@/physics/trainRegistry';
import { setCrossingClear } from '@/physics/townNav';
import { collectCityParts, cityPartMatrix, type CityPart } from './cityChunks';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * The town around the island station.
 *
 * Streets, footways, a forecourt, a car park, a level crossing, and rows of the
 * city's own buildings along them — see `townConfig` for the layout and for why
 * each block is where it is.
 *
 * ## One frame, and plain local coordinates
 *
 * Everything is drawn inside a single group at the station's centre turned to
 * the line's heading, in which **local +Z is `along` the line and local +X is
 * `across` it, left positive**. That is worth checking rather than trusting: a
 * group rotated by `heading = atan2(tx, tz)` maps local +Z to the tangent
 * `(tx, tz)` and local +X to the left normal `(tz, −tx)`, which is exactly
 * `stationPoint`'s own definition. So the whole town can be written as flat
 * rectangles in two numbers each, and none of it has to know where the island
 * is — the same trick the station's roads use, one level up.
 *
 * ## Drawn as merged slabs, not as meshes
 *
 * Every street is a handful of boxes, and there are nine streets: as separate
 * meshes that is two hundred draw calls for something the eye reads as tarmac.
 * They are merged per material instead — one geometry for carriageway, one for
 * footway, one for kerbs, one for markings — so the whole street network is
 * four calls. The buildings are single transplanted chunks (one call each), and
 * the trees, street furniture and parked cars are instanced.
 *
 * ## The level crossing is worked
 *
 * The road over the railway is the only link between the two halves of the
 * town, and its barriers fall when a train is coming: `LevelCrossing` reads the
 * same `trainRegistry` the signals do, so what the barriers are doing is what
 * the traffic on the line is doing, and the red lights flash with them.
 */

/** Local y of the island crown; everything is measured up from it. */
/** The game's own vehicles, parked — see `ParkedCars`. */
const VEHICLE_MODEL = '/models/vehicles.glb';

const GROUND = 0;
/** Slab thicknesses, shared with the nav patch the traffic reads — see `SURFACE`. */
const ROAD_TOP = SURFACE.road;
const FOOTWAY_TOP = SURFACE.footway;
const KERB_WIDTH = 0.2;
/** Half the carriageway at the crossing; the deck is wider by a footway each side. */
const CARRIAGE_HALF = 6;
const MARK_TOP = ROAD_TOP + 0.012;

const MARK_COLOUR = TOWN_PALETTE.mark;

/** Centre-line dashes on the ring: length and gap, in metres. */
const RING_DASH = 4;
const RING_DASH_GAP = 7;

/* --------------------------------------------------------------- textures */

function makeTarmac(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#3f4145';
  ctx.fillRect(0, 0, size, size);
  let seed = 91;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  for (let i = 0; i < 2600; i++) {
    const g = 40 + Math.floor(random() * 34);
    ctx.fillStyle = `rgba(${g}, ${g + 1}, ${g + 4}, ${0.25 + random() * 0.5})`;
    ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
  }
  return finish(canvas, 0.14);
}
/** The crossing's deck: concrete panels with a dark joint between them. */
function makeDeckPanels(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#26282b';
  ctx.fillRect(0, 0, size, size);
  let seed = 53;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  // Two panels across the texture, so the joints run at a readable pitch.
  for (let j = 0; j < 2; j++) {
    const g = 128 + Math.floor(random() * 20);
    ctx.fillStyle = `rgb(${g}, ${g - 2}, ${g - 6})`;
    ctx.fillRect(3, j * (size / 2) + 3, size - 6, size / 2 - 6);
    ctx.fillStyle = 'rgba(30,30,32,0.22)';
    ctx.fillRect(3, j * (size / 2) + 3, size - 6, 4);
  }
  return finish(canvas, 0.35);
}

function makePaving(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#6d6a64';
  ctx.fillRect(0, 0, size, size);
  const per = 4;
  const tile = size / per;
  let seed = 17;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  for (let j = 0; j < per; j++) {
    for (let i = 0; i < per; i++) {
      const g = 150 + Math.floor(random() * 26);
      ctx.fillStyle = `rgb(${g}, ${g - 3}, ${g - 10})`;
      ctx.fillRect(i * tile + 1, j * tile + 1, tile - 2, tile - 2);
    }
  }
  return finish(canvas, 0.5);
}
function finish(canvas: HTMLCanvasElement, repeat: number): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.repeat.set(repeat, repeat);
  return texture;
}

/* ------------------------------------------------------------------ slabs */

/** A box in the frame: `across` × `along` on plan, from `y` up by `h`. */
function slab(acrossFrom: number, acrossTo: number, alongFrom: number, alongTo: number, y: number, h: number): BoxGeometry {
  const w = Math.abs(acrossTo - acrossFrom);
  const d = Math.abs(alongTo - alongFrom);
  const g = new BoxGeometry(Math.max(w, 0.01), h, Math.max(d, 0.01));
  g.translate((acrossFrom + acrossTo) / 2, y + h / 2, (alongFrom + alongTo) / 2);
  return g;
}
/** Merge, or null when nothing was collected. */
function merge(parts: BufferGeometry[]): BufferGeometry | null {
  if (!parts.length) return null;
  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return out;
}

/**
 * The street network: carriageway, footways, kerbs and centre lines.
 *
 * A street is described in `townConfig` by the axis it runs along and the
 * offset of its centreline; this turns that into boxes. Streets running
 * `across` and streets running `along` cross each other, and the crossings are
 * not cut out — the carriageway slabs simply overlap at the same height, which
 * is what a junction looks like and costs nothing. The footways ARE stopped at
 * the junctions, by drawing each footway as two runs with a gap where another
 * street's carriageway passes, because a pavement running through a road is the
 * one thing that would give the trick away.
 */
function buildStreets(streets: readonly Street[]) {
  const road: BufferGeometry[] = [];
  const foot: BufferGeometry[] = [];
  const kerb: BufferGeometry[] = [];
  const mark: BufferGeometry[] = [];

  /** Where other streets' carriageways cut this one's footway, as [from, to] on its axis. */
  const gapsFor = (street: Street) => {
    const gaps: Array<[number, number]> = [];
    for (const other of streets) {
      if (other === street || other.axis === street.axis) continue;
      // The other street runs perpendicular; it crosses if its span covers our
      // offset and our span covers its offset.
      const covers = other.from <= street.at && street.at <= other.to;
      const within = street.from <= other.at && other.at <= street.to;
      if (!covers || !within) continue;
      const half = other.width / 2 + other.footway;
      gaps.push([other.at - half, other.at + half]);
    }
    return gaps.sort((a, b) => a[0] - b[0]);
  };

  for (const street of streets) {
    const half = street.width / 2;
    // Local (across, along) of the two ends, whichever axis it runs on.
    const box = (a0: number, a1: number, o0: number, o1: number, y: number, h: number) => (
      street.axis === 'along'
        ? slab(o0, o1, a0, a1, y, h)
        : slab(a0, a1, o0, o1, y, h)
    );
    road.push(box(street.from, street.to, street.at - half, street.at + half, GROUND, ROAD_TOP));

    if (street.footway > 0) {
      const gaps = gapsFor(street);
      // Footway runs between the gaps, on both sides.
      const runs: Array<[number, number]> = [];
      let cursor = street.from;
      for (const [g0, g1] of gaps) {
        if (g0 > cursor) runs.push([cursor, Math.min(g0, street.to)]);
        cursor = Math.max(cursor, g1);
      }
      if (cursor < street.to) runs.push([cursor, street.to]);
      for (const side of [-1, 1]) {
        const inner = street.at + side * half;
        const outer = inner + side * street.footway;
        for (const [r0, r1] of runs) {
          if (r1 - r0 < 1) continue;
          foot.push(box(r0, r1, Math.min(inner, outer), Math.max(inner, outer), GROUND, FOOTWAY_TOP));
          // The kerb: a light edge along the carriageway side of the footway.
          const k0 = inner;
          const k1 = inner + side * KERB_WIDTH;
          kerb.push(box(r0, r1, Math.min(k0, k1), Math.max(k0, k1), GROUND, FOOTWAY_TOP + 0.02));
        }
      }
    }

    if (street.centreLine) {
      for (let a = street.from + 3; a < street.to - 3; a += 9) {
        mark.push(box(a, a + 4.5, street.at - 0.09, street.at + 0.09, MARK_TOP, 0.01));
      }
    }
  }
  return { road: merge(road), foot: merge(foot), kerb: merge(kerb), mark: merge(mark) };
}

/** Forecourt paving, the car park and its bay markings. */
function buildPaving() {
  const foot: BufferGeometry[] = [];
  const road: BufferGeometry[] = [];
  const mark: BufferGeometry[] = [];
  foot.push(slab(FORECOURT.fromAcross, FORECOURT.toAcross, FORECOURT.fromAlong, FORECOURT.toAlong, GROUND, FOOTWAY_TOP));
  road.push(slab(CAR_PARK.fromAcross, CAR_PARK.toAcross, CAR_PARK.fromAlong, CAR_PARK.toAlong, GROUND, ROAD_TOP));
  // Bays: two rows nose to nose, marked out along the park's length.
  const depth = (CAR_PARK.toAcross - CAR_PARK.fromAcross) / 2;
  for (let row = 0; row < CAR_PARK.rows; row++) {
    const a0 = CAR_PARK.fromAcross + row * depth;
    for (let z = CAR_PARK.fromAlong + 2; z < CAR_PARK.toAlong - 2; z += CAR_PARK.bayPitch) {
      mark.push(slab(a0 + 0.6, a0 + depth - 0.6, z - 0.06, z + 0.06, MARK_TOP, 0.01));
    }
  }
  return { foot: merge(foot), road: merge(road), mark: merge(mark) };
}

/**
 * The lineside fence, and the street lamps.
 *
 * Both are merged into one geometry each: a fence is 200 posts and a lamp is
 * three boxes, and as meshes that would be more draw calls than the rest of the
 * town put together. The lamp HEADS are separate, because they are the one part
 * that has to be emissive.
 */
/**
 * The boundary fence, on the TRUE alignment.
 *
 * Everything else in the town is laid in the flat frame, which is right for a
 * town: a street grid does not have to follow a curve. A fence between the town
 * and the railway does. West of along −100 the line curves away from the frame
 * — 30 m by −265 — so a fence at a fixed frame offset would drift off the
 * railway at one end and stand on the track at the other.
 *
 * So each post is found on the railway (`trainPointAt` at the arc, `across`
 * metres along its own normal) and then expressed back in the frame, which is
 * just the projection `stationPoint` inverts. Panels join consecutive posts, so
 * the fence follows the curve as a polyline rather than a straight run.
 */
function buildFence(site: NonNullable<typeof TOWN_SITE>) {
  const station = STATION_SITE;
  if (!station) return null;
  const parts: BufferGeometry[] = [];
  const [cx, , cz] = site.centre;
  const [tx, tz] = station.tangent;
  const [nx, nz] = station.normal;
  /** A point on the railway `off` metres left of it at `along`, in frame coordinates. */
  const onLine = (along: number, off: number): [number, number] => {
    const arc = trainWrap(station.arc + along);
    const [x, , z] = trainPointAt(arc);
    const [rx, rz] = trainNormalAt(arc);
    const wx = x + rx * off - cx;
    const wz = z + rz * off - cz;
    return [wx * nx + wz * nz, wx * tx + wz * tz];
  };
  for (const run of FENCE.runs) {
    let previous: [number, number] | null = null;
    for (let a = run.from; a <= run.to; a += FENCE.postPitch) {
      const here = onLine(a, run.across);
      parts.push(slab(here[0] - 0.07, here[0] + 0.07, here[1] - 0.07, here[1] + 0.07, GROUND, FENCE.height));
      if (previous) {
        // Two rails between this post and the last, as a box along the chord.
        const mx = (previous[0] + here[0]) / 2;
        const mz = (previous[1] + here[1]) / 2;
        const span = Math.hypot(here[0] - previous[0], here[1] - previous[1]);
        const angle = Math.atan2(here[0] - previous[0], here[1] - previous[1]);
        for (const rise of [FENCE.height - 0.16, FENCE.height * 0.52]) {
          const rail = new BoxGeometry(0.07, 0.09, span);
          rail.rotateY(angle);
          rail.translate(mx, rise, mz);
          parts.push(rail);
        }
      }
      previous = here;
    }
  }
  return merge(parts);
}

function buildLamps() {
  const posts: BufferGeometry[] = [];
  const heads: BufferGeometry[] = [];
  for (const street of STREETS) {
    // The through streets only. The test used to be `footway < 3`, which meant
    // the same thing until the footways were widened (2.6 -> 3.6 on the lanes);
    // left alone it would have lit every back lane in the town at a 32 m pitch.
    if (street.footway < 4.5) continue;
    const stand = street.width / 2 + street.footway * 0.35;
    for (let a = street.from + 16, i = 0; a < street.to - 16; a += LAMPS.pitch, i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const at = street.at + side * stand;
      const inner = at - side * LAMPS.reach;
      const put = (c0: number, c1: number, a0: number, a1: number, y: number, h: number) => (
        street.axis === 'along' ? slab(c0, c1, a0, a1, y, h) : slab(a0, a1, c0, c1, y, h)
      );
      if (street.axis === 'along' ? (at > RAIL_CORRIDOR.from && at < RAIL_CORRIDOR.to)
        : (a > RAIL_CORRIDOR.from && a < RAIL_CORRIDOR.to)) continue;
      posts.push(put(at - 0.09, at + 0.09, a - 0.09, a + 0.09, GROUND, LAMPS.height));
      posts.push(put(Math.min(at, inner), Math.max(at, inner), a - 0.07, a + 0.07, LAMPS.height - 0.18, 0.14));
      heads.push(put(inner - 0.34, inner + 0.34, a - 0.16, a + 0.16, LAMPS.height - 0.24, 0.1));
    }
  }
  return { posts: merge(posts), heads: merge(heads) };
}

/* ---------------------------------------------------------------- the ring */

/** A ring sample in the town's own frame, ready to be swept. */
interface RingPoint extends LoftSample {
  /** Height above the crown at this point. */
  rise: number;
  /** Last sample of its chain: the sweep must not continue past it. */
  last: boolean;
}

/**
 * The coast road, as a swept section.
 *
 * The streets are boxes because a street here is straight; the ring is a curve
 * that follows the shore and climbs over the railway twice, and neither of
 * those can be a box. It is the same loft the railway is built with
 * (`buildLoft`), which already knows how to sweep a profile along a centreline
 * and get the winding right — so the road is described by its cross-section
 * alone and the shape comes from `RING_CHAINS`.
 *
 * Two sections. The carriageway is a 6 cm slab like every other road in the
 * town. The shoulder under it is a flat verge that BATTERS DOWN to the crown by
 * however far the road stands above it, which is nothing at all for most of the
 * lap and a metre and a half at each level crossing — so the crossings come
 * with their own embankments, for free, and the road never floats.
 */
function buildRing() {
  if (!RING_ENABLED || !RING_CHAINS.length) return null;
  const samples: RingPoint[] = [];
  // The two chains end to end in one array, with the joint between them broken
  // by `filter` below — one geometry and one draw call for both shore roads,
  // the same trick `Pointwork` uses for twelve separate diagonals.
  for (const chain of RING_CHAINS) {
    let arc = 0;
    for (let i = 0; i < chain.length; i++) {
      const here = chain[i];
      const before = chain[Math.max(0, i - 1)];
      const after = chain[Math.min(chain.length - 1, i + 1)];
      if (i > 0) {
        arc += Math.hypot(here.across - chain[i - 1].across, here.along - chain[i - 1].along);
      }
      // Tangent from the neighbours, so the section stays square to the road
      // through a bend rather than to the segment it happens to start.
      const tx = after.across - before.across;
      const tz = after.along - before.along;
      const len = Math.hypot(tx, tz) || 1;
      samples.push({
        x: here.across,
        z: here.along,
        y: GROUND + here.rise,
        // Left-hand normal, the convention the rest of the loft code uses.
        nx: tz / len,
        nz: -tx / len,
        arc,
        rise: here.rise,
        last: i === chain.length - 1,
      });
    }
  }

  const half = RING.width / 2;
  const shoulder: ProfileVertex<RingPoint>[] = [
    { off: -(half + RING.verge), rise: -SURFACE.road },
    { off: half + RING.verge, rise: -SURFACE.road },
  ];
  const carriageway: ProfileVertex<RingPoint>[] = [
    { off: -half, rise: 0 },
    { off: half, rise: 0 },
    { off: half, rise: -SURFACE.road },
    { off: -half, rise: -SURFACE.road },
  ];
  // Never sweep across the joint between the two chains: they are laid end to
  // end in one array and are half an island apart on the ground.
  const same = (a: RingPoint) => !a.last;
  const lengths = RING_CHAINS.map((chain) => {
    let run = 0;
    for (let i = 1; i < chain.length; i++) {
      run += Math.hypot(chain[i].across - chain[i - 1].across, chain[i].along - chain[i - 1].along);
    }
    return run;
  });
  return {
    samples,
    lengths,
    shoulder: buildLoft(samples, shoulder, { vScale: 12, filter: same }),
    road: buildLoft(samples, carriageway, { closed: true, vScale: 10, filter: same }),
  };
}

/** The dashed centre line, walked along each chain's own arc length. */
function RingDashes() {
  const mesh = useRef<InstancedMesh>(null);
  const runs = useMemo(() => RING_CHAINS.map((chain) => {
    const points: Array<{ across: number; along: number; rise: number; arc: number }> = [];
    let arc = 0;
    chain.forEach((s, i) => {
      if (i > 0) arc += Math.hypot(s.across - chain[i - 1].across, s.along - chain[i - 1].along);
      points.push({ across: s.across, along: s.along, rise: s.rise, arc });
    });
    return points;
  }), []);
  const count = useMemo(() => runs.reduce((sum, run) => (
    sum + Math.max(1, Math.floor(run[run.length - 1].arc / (RING_DASH + RING_DASH_GAP)))
  ), 0), [runs]);

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3(0.22, 0.02, RING_DASH);
    let placed = 0;
    for (const run of runs) {
      const length = run[run.length - 1].arc;
      const dashes = Math.max(1, Math.floor(length / (RING_DASH + RING_DASH_GAP)));
      const pitch = length / dashes;
      for (let i = 0; i < dashes && placed < count; i++) {
        const at = pitch * (i + 0.5);
        let k = 0;
        while (k < run.length - 2 && run[k + 1].arc < at) k++;
        const a = run[k];
        const b = run[k + 1];
        const t = (at - a.arc) / Math.max(b.arc - a.arc, 1e-3);
        euler.set(0, Math.atan2(b.across - a.across, b.along - a.along), 0);
        quaternion.setFromEuler(euler);
        position.set(
          a.across + (b.across - a.across) * t,
          GROUND + a.rise + 0.012,
          a.along + (b.along - a.along) * t,
        );
        instanced.setMatrixAt(placed++, matrix.compose(position, quaternion, scale));
      }
    }
    instanced.count = placed;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [runs, count]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={MARK_COLOUR} roughness={0.8} />
    </instancedMesh>
  );
}

/* --------------------------------------------------------- level crossing */

/**
 * Metres of deck per texture repeat. The panel joints land at half this,
 * because `makeDeckPanels` draws two panels across its own height.
 */
const DECK_TILE = 5;

/**
 * A deck panel that follows the track.
 *
 * The crossing used to be built from axis-aligned boxes, each spanning the
 * whole 22 m width of the road with its flangeways cut at the track offsets
 * taken at ONE `along` — the crossing's midpoint. The tracks do not hold still
 * over 22 m: measured across this crossing, platform loop 2 runs from 11.79 out
 * at the near edge to 8.51 at the far one. Cutting its flangeway at the middle
 * value put the slot **1.6 m from its own rails** at each end of the deck, which
 * is the "road doesn't follow the track" — the panels were straight and the
 * railway was not.
 *
 * A band between two diverging rails is a *trapezoid*, so that is what this
 * builds: a box whose two ends have their own across extents, the vertices
 * lerped between them. The offsets vary linearly over a strip this short, so one
 * trapezoid is exact rather than an approximation.
 *
 * The UVs are planar in the frame rather than the box's own 0..1. Each panel
 * used to stretch the whole texture over its own width, so a 3 m band and a
 * 0.3 m one showed the same two joints at wildly different scales and no joint
 * ever lined up with its neighbour's — the other half of "not seamless". Mapped
 * from position, separate panels tile as one continuous surface.
 */
function deckPanel(
  from0: number, to0: number, from1: number, to1: number,
  alongFrom: number, alongTo: number, y: number, h: number,
): BoxGeometry | null {
  const w0 = to0 - from0;
  const w1 = to1 - from1;
  // A slab of negative width is a slab wound inside out; at a merge the two
  // flangeways meet and the band between them has no width at all.
  if (w0 <= 0.02 || w1 <= 0.02) return null;
  const width = Math.max(w0, w1);
  const depth = Math.max(alongTo - alongFrom, 0.01);
  const g = new BoxGeometry(width, h, depth);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    // Where this vertex sits in the panel: `t` along it, `u` across it.
    const t = pos.getZ(i) / depth + 0.5;
    const u = pos.getX(i) / width + 0.5;
    const a = from0 + (from1 - from0) * t;
    const b = to0 + (to1 - to0) * t;
    pos.setX(i, a + (b - a) * u);
    pos.setZ(i, alongFrom + depth * t);
  }
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / DECK_TILE, pos.getZ(i) / DECK_TILE);
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  g.translate(0, y + h / 2, 0);
  g.computeVertexNormals();
  return g;
}

/**
 * How many strips the deck is cut into along the line.
 *
 * One per metre. A trapezoid already follows a taper exactly, so the strips are
 * not there for the taper — they are there because the *number* of tracks
 * changes across the crossing: platform loop 1 is a road of its own at the near
 * edge and has merged into the down line by the far one, so the set of
 * flangeways to cut is not the same at both ends. Cutting at a metre means at
 * most one strip straddles a merge.
 */
const DECK_STRIPS = 22;

/**
 * Height of the road surface at `across`, crown to deck and back.
 *
 * One function for three jobs — the visual ramp, the solid the car stands on,
 * and the markings — because they have to agree to the centimetre. A car riding
 * a collider that is not the ramp it can see is the sort of fault that reads as
 * "the physics is broken" rather than as a mismatch.
 *
 * Linear, and deliberately: a straight wedge is what a crossing hump is, and it
 * is also the shape a closed prism can be built from exactly (`crossingSolid`),
 * so what is drawn and what is driven cannot drift apart.
 */
function crossingHeight(across: number, deck: number): number {
  const s = CROSSING.fromAcross;
  const n = CROSSING.toAcross;
  if (across >= s && across <= n) return deck;
  const climb = (t: number) => ROAD_TOP + (deck - ROAD_TOP) * Math.min(1, Math.max(0, t));
  if (across < s) return climb((across - (s - CROSSING.ramp)) / CROSSING.ramp);
  return climb((n + CROSSING.ramp - across) / CROSSING.ramp);
}

/**
 * The whole crossing as one closed solid, for the car to drive over.
 *
 * There was no collider here at all: the deck and its ramps were meshes and
 * nothing else, so a car drove *through* the hump at crown level and out the
 * other side. Which is the bug — a level crossing that a train can be stopped
 * for and a car cannot drive over is scenery, not a crossing.
 *
 * Built as a prism rather than as a stack of boxes because the ramp has to be
 * *smooth*: a staircase of cuboids, which is what the visual is made of, gives
 * the wheels forty small steps to climb and the car shakes its way over. The
 * cross-section is a convex hexagon — ground, up the far kerb, up the slope,
 * across the deck, down the near slope, down the near kerb — extruded the width
 * of the road, so a fan from one corner triangulates both end caps.
 */
function crossingSolid(deck: number): [Float32Array, Uint32Array] {
  const s = CROSSING.fromAcross;
  const n = CROSSING.toAcross;
  const r = CROSSING.ramp;
  const z0 = CROSSING.along - CROSSING.halfWidth;
  const z1 = CROSSING.along + CROSSING.halfWidth;
  // The section, in (across, height), wound one way round.
  const section: Array<[number, number]> = [
    [s - r, GROUND], [n + r, GROUND], [n + r, ROAD_TOP],
    [n, deck], [s, deck], [s - r, ROAD_TOP],
  ];
  const m = section.length;
  const vertices = new Float32Array(m * 2 * 3);
  for (let i = 0; i < m; i++) {
    const [across, y] = section[i];
    vertices.set([across, y, z0], i * 3);
    vertices.set([across, y, z1], (m + i) * 3);
  }
  const tri: number[] = [];
  // The skin: one quad per section edge, joining the two ends.
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    tri.push(i, j, m + j, i, m + j, m + i);
  }
  // The two caps, fanned from corner 0. Convex, so a fan is a triangulation.
  for (let i = 1; i < m - 1; i++) {
    tri.push(0, i, i + 1);
    tri.push(m, m + i + 1, m + i);
  }
  return [vertices, new Uint32Array(tri)];
}

/**
 * The road over the railway.
 *
 * The rail head stands about a metre over the island crown — the ballast, the
 * sleeper and the rail — so the road humps up to meet it: ramps on each
 * approach, then panels at rail level laid BETWEEN and OUTSIDE the rails with a
 * flangeway left open at each rail, which is what a road crossing is made of
 * and what stops it reading as a bridge. The rails themselves are `TrainLine`'s
 * and run straight through.
 */
function buildCrossing(railTop: number) {
  const along0 = CROSSING.along - CROSSING.halfWidth;
  const along1 = CROSSING.along + CROSSING.halfWidth;
  /** The carriageway, narrower than the deck: the rest is footway either side. */
  const lane0 = CROSSING.along - CARRIAGE_HALF;
  const lane1 = CROSSING.along + CARRIAGE_HALF;
  const deck: BufferGeometry[] = [];
  const ramps: BufferGeometry[] = [];
  const mark: BufferGeometry[] = [];
  const hatch: BufferGeometry[] = [];
  const dark: BufferGeometry[] = [];
  const g = TRAIN.gauge / 2;
  const HEAD = 0.036;
  const FLANGE = 0.075;
  const top = railTop;

  /**
   * The edges of every panel, across, for the tracks at one `along`.
   *
   * The crossing stands inside the station's throat, so what it spans is the up
   * line, the down line and both platform loops — four railways where this used
   * to assume two, and three by the time it reaches the far side of the road.
   * `stationTracks` answers it from the geometry, so a road added to the station
   * cannot be paved over by a crossing that has not heard of it.
   *
   * Working across: the apron outside, then for each track the four-foot
   * between its own rails, then the six-foot to the next one. The gaps left are
   * the flangeways — the slot a wheel's flange runs in, and the reason a
   * crossing is panels and not one slab.
   */
  const edgesAt = (along: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let cursor = CROSSING.fromAcross;
    for (const centre of stationTracks(along)) {
      out.push([cursor, centre - g - HEAD - FLANGE]);
      out.push([centre - g + HEAD + FLANGE, centre + g - HEAD - FLANGE]);
      cursor = centre + g + HEAD + FLANGE;
    }
    out.push([cursor, CROSSING.toAcross]);
    return out;
  };

  // Cut into strips along the line, each strip's panels tapered from its own
  // near edge to its own far one — see `deckPanel` and `DECK_STRIPS`.
  for (let i = 0; i < DECK_STRIPS; i++) {
    const b0 = along0 + ((along1 - along0) * i) / DECK_STRIPS;
    const b1 = along0 + ((along1 - along0) * (i + 1)) / DECK_STRIPS;
    const e0 = edgesAt(b0);
    const e1 = edgesAt(b1);
    // Where a track merges the two ends disagree about how many panels there
    // are. Rather than guess at the pairing, that one strip is laid straight
    // from its own midpoint — one metre of deck, and the alternative is a panel
    // stretched between two edges that are not the same edge.
    const straight = e0.length !== e1.length;
    const near = straight ? edgesAt((b0 + b1) / 2) : e0;
    const far = straight ? near : e1;
    for (let k = 0; k < near.length; k++) {
      const panel = deckPanel(
        near[k][0], near[k][1], far[k][0], far[k][1], b0, b1, top - 0.14, 0.14,
      );
      if (panel) deck.push(panel);
    }
  }

  // Anti-trespass panels: the ribbed dark aprons laid outside the outer rails,
  // which is what stops anyone walking the four-foot away from the crossing.
  // Each is read at its own `along`, because the outermost rail is not in the
  // same place at both ends of the road.
  for (const [b0, b1] of [
    [along0 - 2.4, along0 - 0.1], [along1 + 0.1, along1 + 2.4],
  ] as const) {
    const local = stationTracks((b0 + b1) / 2);
    for (const [a0, a1] of [
      [CROSSING.fromAcross, local[0] - g - 0.5],
      [local[local.length - 1] + g + 0.5, CROSSING.toAcross],
    ] as const) {
      if (a1 - a0 > 0.02) dark.push(slab(a0, a1, b0, b1, top - 0.16, 0.1));
    }
  }

  // Approach ramps, crown to deck. Forty slices rather than nine steps: nine
  // over sixteen metres is an eleven-centimetre riser, which reads as a flight
  // of stairs and drove like one. At forty the riser is under three
  // centimetres and the hump reads as a hump — and the solid the car actually
  // stands on is the exact wedge (`crossingSolid`), so the ride is smooth
  // however finely this is sliced.
  const RAMP = CROSSING.ramp;
  const SLICES = 40;
  for (const [from, to] of [
    [CROSSING.fromAcross - RAMP, CROSSING.fromAcross],
    [CROSSING.toAcross, CROSSING.toAcross + RAMP],
  ] as const) {
    for (let i = 0; i < SLICES; i++) {
      const a0 = from + ((to - from) * i) / SLICES;
      const a1 = from + ((to - from) * (i + 1)) / SLICES;
      // To `top`, the deck panels' own top face — not to their underside. The
      // ramp used to stop 0.14 m short, which left a step at the deck edge you
      // could see and, now that there is a collider, one the car would have
      // ridden over. The road surface is continuous across a crossing.
      const y = crossingHeight((a0 + a1) / 2, top);
      // Asphalt, not deck panels: the concrete is only the bit between the
      // rails, and a ramp in panel grey reads as a slab bridge.
      ramps.push(slab(a0, a1, along0, along1, GROUND, Math.max(0.03, y)));
    }
  }

  // The yellow box on the deck: keep-clear hatching over both tracks, an
  // outline round the carriageway and four diagonals through it.
  const boxFrom = CROSSING.fromAcross + 0.4;
  const boxTo = CROSSING.toAcross - 0.4;
  const y = top + 0.014;
  hatch.push(slab(boxFrom, boxTo, lane0, lane0 + 0.22, y, 0.01));
  hatch.push(slab(boxFrom, boxTo, lane1 - 0.22, lane1, y, 0.01));
  hatch.push(slab(boxFrom, boxFrom + 0.22, lane0, lane1, y, 0.01));
  hatch.push(slab(boxTo - 0.22, boxTo, lane0, lane1, y, 0.01));
  // Diagonals at 45 degrees, CLIPPED to the box. Drawn as a fixed fraction of
  // the box's diagonal they overshot it and ran out onto the grass; a hatch is
  // a set of parallel lines inside a rectangle, so each one is clipped to it.
  // The line is `across = boxFrom + t, along = lane0 + t - c` for intercept c,
  // which is inside the box for t in [max(0, c), min(width, c + depth)].
  const width = boxTo - boxFrom;
  const depth = lane1 - lane0;
  for (let c = -depth + 2.4; c < width; c += 3.2) {
    const t0 = Math.max(0, c);
    const t1 = Math.min(width, c + depth);
    if (t1 - t0 < 0.9) continue;
    const x0 = boxFrom + t0;
    const z0 = lane0 + t0 - c;
    const x1 = boxFrom + t1;
    const z1 = lane0 + t1 - c;
    const bar = new BoxGeometry(0.18, 0.01, Math.hypot(x1 - x0, z1 - z0));
    bar.rotateY(Math.atan2(x1 - x0, z1 - z0));
    bar.translate((x0 + x1) / 2, y + 0.005, (z0 + z1) / 2);
    hatch.push(bar);
  }

  // Stop line at the barrier, rumble strips out on the level street.
  //
  // The stop line follows the barrier in: a line eighteen metres before the
  // thing it stops you at is not a stop line. That puts it on the ramp, where
  // the surface is not flat and `MARK_TOP` is a metre underground — so it takes
  // its height from `crossingHeight` like everything else on the hump, and is
  // the real 0.4 m wide, narrow enough that the 1-in-14 fall across it stays
  // inside the paint.
  //
  // The rumble strips stay on the flat approach, because that is what they are:
  // an approach warning, not part of the crossing.
  for (const side of [-1, 1] as const) {
    const bar = side < 0 ? CROSSING.fromAcross - 3.4 : CROSSING.toAcross + 3.4;
    const foot = side < 0
      ? CROSSING.fromAcross - RAMP - 1.4
      : CROSSING.toAcross + RAMP + 1.4;
    // Half the carriageway only: the near lane stops, the far one is leaving.
    const stopFrom = side < 0 ? CROSSING.along : lane0;
    const stopTo = side < 0 ? lane1 : CROSSING.along;
    const stopY = crossingHeight(bar, top);
    mark.push(slab(bar - 0.2, bar + 0.2, stopFrom, stopTo, stopY - 0.02, 0.035));
    for (let k = 1; k <= 3; k++) {
      const at = foot + side * (1.6 + k * 1.5);
      dark.push(slab(at - 0.28, at + 0.28, lane0, lane1, ROAD_TOP, 0.035));
    }
  }
  return {
    deck: merge(deck), ramps: merge(ramps), mark: merge(mark),
    hatch: merge(hatch), dark: merge(dark),
    // What the car drives on. See `crossingSolid`.
    solid: crossingSolid(top),
  };
}

/** Barrier booms, red lights and the wig-wag standards at one crossing. */
function LevelCrossing({ railTop }: { railTop: number }) {
  const booms = useRef<(Group | null)[]>([]);
  const lamps = useRef<(Mesh | null)[]>([]);
  /** 0 raised, 1 lowered. */
  const state = useRef(0);
  const phase = useRef(0);

  const crossingArc = STATION_SITE ? STATION_SITE.arc + CROSSING.along : 0;

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    // A train is coming if it is within `warnDistance` on the approach side and
    // running towards us. Both tracks, and the ring is walked the short way.
    let coming = false;
    for (const track of [0, 1] as const) {
      for (const t of trainsOnTrack(track)) {
        // How far ahead of the train the crossing is, walked the way it runs.
        const ahead = ((crossingArc - t.arc) * t.direction % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
        if (ahead < CROSSING.warnDistance) coming = true;
      }
    }
    const target = coming ? 1 : 0;
    state.current += (target - state.current) * (1 - Math.pow(0.5, delta / 0.55));
    // The same fact, told to the traffic: while the booms are anywhere but up,
    // the approach ramps stop being driveable and an NPC holds at the stop
    // line instead of driving under a falling barrier. The DECK stays
    // driveable (see `townNav`), so a car already on it clears the crossing.
    setCrossingClear(state.current < 0.05);
    phase.current += delta;
    // Raised is vertical. The boom lies along the road's width, which is the
    // frame's `along` (local Z), so it lifts about the ACROSS axis (local X) —
    // rotating about Z would swing it sideways into the road. Each post's boom
    // reaches the other way, so the sign follows the side.
    booms.current.forEach((boom, i) => {
      if (boom) boom.rotation.x = (i === 0 ? 1 : -1) * (Math.PI / 2) * (1 - state.current);
    });
    const lit = state.current > 0.05;
    const flash = Math.floor(phase.current * 1.6) % 2 === 0;
    lamps.current.forEach((lamp, i) => {
      if (!lamp) return;
      const on = lit && (i % 2 === 0 ? flash : !flash);
      lamp.visible = on;
    });
  });

  const sides = CROSSING.barrierAcross;
  return (
    <group>
      {sides.map((across, s) => (
        <group key={across} position={[across, GROUND, CROSSING.along + (s === 0 ? CROSSING.halfWidth : -CROSSING.halfWidth)]}>
          {/* The standard: a post with the light head and the boom's pivot. */}
          <mesh position={[0, 1.6, 0]} castShadow>
            <boxGeometry args={[0.28, 3.2, 0.28]} />
            <meshStandardMaterial color="#d8d5cc" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.15, 0]} castShadow>
            <boxGeometry args={[0.9, 0.3, 0.9]} />
            <meshStandardMaterial color="#7d7a72" roughness={0.9} />
          </mesh>
          {/* Two red lamps side by side, and the white one beneath. */}
          {/* Two red lamps facing the traffic this post stops: the south post
              faces the road coming up from the shore street, the north post the
              road coming down from the station. */}
          {[-0.45, 0.45].map((z, i) => (
            <group key={z} position={[0, 3.0, z]}>
              <mesh>
                <boxGeometry args={[0.22, 0.42, 0.42]} />
                <meshStandardMaterial color="#16171a" roughness={0.7} />
              </mesh>
              <mesh
                position={[s === 0 ? -0.13 : 0.13, 0, 0]}
                rotation={[0, s === 0 ? -Math.PI / 2 : Math.PI / 2, 0]}
                ref={(m) => { lamps.current[s * 2 + i] = m; }}
                visible={false}
              >
                <circleGeometry args={[0.15, 14]} />
                <meshBasicMaterial color="#ff2418" toneMapped={false} />
              </mesh>
            </group>
          ))}
          {/* The crossbuck, above the lamps and facing the same way: two white
              bars crossed in the plane that faces the traffic this post stops.
              Rotating a Z-long bar about X tilts it into Y, which is what puts
              the X in that plane — about Y or Z it would lie flat or edge-on. */}
          <group position={[s === 0 ? -0.2 : 0.2, 3.95, 0]}>
            {[1, -1].map((d) => (
              <mesh key={d} rotation={[(d * Math.PI) / 4, 0, 0]} castShadow>
                <boxGeometry args={[0.04, 0.16, 1.75]} />
                <meshStandardMaterial color="#f2f0e8" emissive="#3a3a34" emissiveIntensity={0.3} roughness={0.6} />
              </mesh>
            ))}
            {[1, -1].map((d) => (
              <mesh key={`t${d}`} position={[s === 0 ? -0.02 : 0.02, d * 0.6, 0]} rotation={[(d * Math.PI) / 4, 0, 0]}>
                <boxGeometry args={[0.02, 0.17, 0.3]} />
                <meshStandardMaterial color="#c0261c" roughness={0.6} />
              </mesh>
            ))}
          </group>
          {/* The bell, on the post head. */}
          <mesh position={[0, 3.42, 0]} castShadow>
            <cylinderGeometry args={[0.16, 0.19, 0.2, 12]} />
            <meshStandardMaterial color="#4a4e52" metalness={0.6} roughness={0.4} />
          </mesh>
          {/* The boom: pivots about the post, red and white, with a skirt. */}
          <group position={[0, 2.35, 0]} ref={(g) => { booms.current[s] = g; }}>
            <group position={[0, 0, (s === 0 ? -1 : 1) * 4.6]} rotation={[0, s === 0 ? Math.PI : 0, 0]}>
              <mesh position={[0, 0, 0]} castShadow>
                <boxGeometry args={[0.14, 0.26, 9.2]} />
                <meshStandardMaterial color="#f0efe8" roughness={0.6} />
              </mesh>
              {[-3.4, -1.4, 0.6, 2.6].map((z) => (
                <mesh key={z} position={[0.01, 0, z]}>
                  <boxGeometry args={[0.16, 0.27, 1.2]} />
                  <meshStandardMaterial color="#c0261c" roughness={0.6} />
                </mesh>
              ))}
              <mesh position={[0, -0.42, 0]}>
                <boxGeometry args={[0.05, 0.55, 8.6]} />
                <meshStandardMaterial color="#d8d5cc" roughness={0.8} />
              </mesh>
            </group>
          </group>
        </group>
      ))}
      {/* Pedestrian wickets at the footway edges, one pair each side of the
          railway: the gate a walker uses, which is what tells you the deck's
          outer strips are footway and not just wide road. */}
      {([CROSSING.fromAcross - 1.1, CROSSING.toAcross + 1.1] as const).map((across) => (
        ([-1, 1] as const).map((side) => (
          <group
            key={`${across}:${side}`}
            position={[across, GROUND + ROAD_TOP, CROSSING.along + side * (CARRIAGE_HALF + 1.6)]}
          >
            {[-0.8, 0.8].map((z) => (
              <mesh key={z} position={[0, 0.6, z]} castShadow>
                <boxGeometry args={[0.1, 1.2, 0.1]} />
                <meshStandardMaterial color="#7d8288" metalness={0.4} roughness={0.6} />
              </mesh>
            ))}
            {/* The leaf, swung part open. */}
            <group position={[0, 0.55, -0.75]} rotation={[0, 0.55, 0]}>
              <mesh position={[0, 0, 0.72]} castShadow>
                <boxGeometry args={[0.06, 0.95, 1.45]} />
                <meshStandardMaterial color="#e8e4d8" roughness={0.7} />
              </mesh>
            </group>
          </group>
        ))
      ))}
      {/* The relay cabinet: everything the crossing needs to work, in a box
          beside it, which every crossing has and none is without. */}
      <group position={[CROSSING.toAcross + 5, GROUND, CROSSING.along + CROSSING.halfWidth + 4]}>
        <mesh position={[0, 0.08, 0]} receiveShadow>
          <boxGeometry args={[2.4, 0.16, 1.6]} />
          <meshStandardMaterial color="#8f8a80" roughness={0.95} />
        </mesh>
        <mesh position={[0, 1.05, 0]} castShadow>
          <boxGeometry args={[1.9, 1.8, 1.0]} />
          <meshStandardMaterial color="#6d7a6a" metalness={0.3} roughness={0.7} />
        </mesh>
        <mesh position={[0, 1.05, 0.52]}>
          <boxGeometry args={[1.5, 1.4, 0.03]} />
          <meshStandardMaterial color="#5c6a59" roughness={0.6} metalness={0.35} />
        </mesh>
      </group>

      {/* Rail-level road panels, hatching and markings are static geometry. */}
      <CrossingDeck railTop={railTop} />
    </group>
  );
}

function CrossingDeck({ railTop }: { railTop: number }) {
  const built = useMemo(() => ({
    ...buildCrossing(railTop), panels: makeDeckPanels(), tarmac: makeTarmac(),
  }), [railTop]);
  useEffect(() => () => {
    built.deck?.dispose();
    built.ramps?.dispose();
    built.mark?.dispose();
    built.hatch?.dispose();
    built.dark?.dispose();
    built.panels.dispose();
    built.tarmac.dispose();
  }, [built]);
  return (
    <group>
      {built.ramps && (
        <mesh geometry={built.ramps} receiveShadow castShadow>
          <meshStandardMaterial map={built.tarmac} color="#8d9096" roughness={0.96} />
        </mesh>
      )}
      {built.deck && (
        <mesh geometry={built.deck} receiveShadow castShadow>
          <meshStandardMaterial map={built.panels} color="#c8ccd0" roughness={0.9} />
        </mesh>
      )}
      {built.dark && (
        <mesh geometry={built.dark} receiveShadow>
          <meshStandardMaterial color="#26282b" roughness={0.95} />
        </mesh>
      )}
      {built.hatch && (
        <mesh geometry={built.hatch}>
          <meshStandardMaterial color="#e8b62a" emissive="#4a3a08" emissiveIntensity={0.3} roughness={0.8} />
        </mesh>
      )}
      {built.mark && (
        <mesh geometry={built.mark}>
          <meshStandardMaterial color="#eeeade" roughness={0.8} />
        </mesh>
      )}

      {/* Solid, at last. The deck and its ramps were meshes and nothing else,
          so a car drove straight through the hump at crown level — see
          `crossingSolid`. Friction is the road's, not the ballast's: this is
          asphalt and concrete panel, and a car should be able to stop on it. */}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={built.solid} friction={0.95} />
      </RigidBody>
    </group>
  );
}

/* ------------------------------------------------------------ parked cars */

interface CatalogueEntry {
  name: string;
  wheelRadius: number;
  hubs: number[][];
}
const VEHICLES = catalogue.vehicles as CatalogueEntry[];

/**
 * Cars standing in the town: the game's own vehicles, the ones `Traffic`
 * drives, parked.
 *
 * Composed the way `Traffic` composes them, and for the same reason — the model
 * is a body and a wheel, and a car is the body plus the wheel at each of the
 * catalogue's four hubs. The model's origin is on the GROUND (a hub's y is the
 * wheel's radius), so a parked car sits at the road surface with no offset,
 * which is worth knowing because guessing centre-origin buries every car to the
 * axles.
 *
 * One `InstancedMesh` per (type, part), so a car park of twenty different cars
 * costs about as many draw calls as it has kinds of car in it.
 */
function ParkedCars({ slots }: { slots: ReadonlyArray<{ across: number; along: number; turn: number }> }) {
  const { scene } = useGLTF(VEHICLE_MODEL, DRACO_PATH);

  const batches = useMemo(() => {
    // Keyed on `extras` (-> userData) like `Traffic`: the loader renames a
    // multi-primitive mesh's children, so the mesh's own name is not in the scene.
    const byPart = new Map<string, Mesh[]>();
    (scene as unknown as Object3D).traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const { vehicle, part } = o.userData as { vehicle?: string; part?: string };
      if (!vehicle || !part) return;
      const key = `${vehicle}|${part}`;
      byPart.set(key, [...(byPart.get(key) ?? []), o]);
    });
    // Which slot gets which kind: a fixed shuffle, so the mix is varied but the
    // same car is in the same bay every run.
    const kinds = TOWN_PARKED.filter((name) => byPart.has(`${name}|body`));
    if (!kinds.length) return [];
    const pick = slots.map((_, i) => kinds[(i * 7 + (i % 3) * 5) % kinds.length]);
    return kinds.map((name) => {
      const entry = VEHICLES.find((v) => v.name === name);
      const mine = slots.filter((_, i) => pick[i] === name);
      const body = byPart.get(`${name}|body`)?.[0];
      const wheel = byPart.get(`${name}|wheel`)?.[0];
      return { name, entry, mine, body, wheel };
    }).filter((b) => b.body && b.mine.length);
  }, [scene, slots]);

  return (
    <group>
      {batches.map((b) => (
        <CarBatch key={b.name} batch={b} />
      ))}
    </group>
  );
}

function CarBatch({ batch }: {
  batch: {
    entry?: CatalogueEntry;
    mine: ReadonlyArray<{ across: number; along: number; turn: number }>;
    body?: Mesh;
    wheel?: Mesh;
  };
}) {
  const bodies = useRef<InstancedMesh>(null);
  const wheels = useRef<InstancedMesh>(null);
  const hubs = useMemo(() => batch.entry?.hubs ?? [], [batch]);

  useEffect(() => {
    const matrix = new Matrix4();
    const hub = new Matrix4();
    const quaternion = new Quaternion();
    const position = new Vector3();
    const scale = new Vector3(1, 1, 1);
    const axis = new Vector3(0, 1, 0);
    batch.mine.forEach((slot, i) => {
      quaternion.setFromAxisAngle(axis, slot.turn);
      position.set(slot.across, GROUND + ROAD_TOP, slot.along);
      matrix.compose(position, quaternion, scale);
      bodies.current?.setMatrixAt(i, matrix);
      hubs.forEach((h, w) => {
        hub.makeTranslation(h[0], h[1], h[2]).premultiply(matrix);
        wheels.current?.setMatrixAt(i * hubs.length + w, hub);
      });
    });
    if (bodies.current) {
      bodies.current.instanceMatrix.needsUpdate = true;
      bodies.current.computeBoundingSphere();
    }
    if (wheels.current) {
      wheels.current.instanceMatrix.needsUpdate = true;
      wheels.current.computeBoundingSphere();
    }
  }, [batch, hubs]);

  if (!batch.body || !batch.mine.length) return null;
  return (
    <group>
      <instancedMesh
        ref={bodies}
        args={[batch.body.geometry, batch.body.material, batch.mine.length]}
        castShadow
        receiveShadow
      />
      {batch.wheel && hubs.length > 0 && (
        <instancedMesh
          ref={wheels}
          args={[batch.wheel.geometry, batch.wheel.material, batch.mine.length * hubs.length]}
          castShadow
        />
      )}
    </group>
  );
}

/* ---------------------------------------------------------------- scatter */

/** Many copies of one chunk, in a single instanced draw. */
function Scatter({ part, items }: {
  part: CityPart | undefined;
  items: ReadonlyArray<{ across: number; along: number; turn: number }>;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !part) return;
    const matrix = new Matrix4();
    items.forEach((it, i) => {
      instanced.setMatrixAt(i, cityPartMatrix(part, it.across, GROUND, it.along, it.turn, matrix));
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [part, items]);
  if (!part || !items.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[part.geometry, part.material, items.length]}
      castShadow
      receiveShadow
    />
  );
}

/** Trees down both through streets, round the forecourt and through the park. */
function scatterPoints() {
  const trees: Array<{ across: number; along: number; turn: number }> = [];
  const props: Array<{ across: number; along: number; turn: number }> = [];
  const cars: Array<{ across: number; along: number; turn: number }> = [];
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };

  /** Nothing goes on the railway — see `RAIL_CORRIDOR`. */
  const clear = (across: number) => across < RAIL_CORRIDOR.from || across > RAIL_CORRIDOR.to;

  // Street trees, in the footway, alternating sides so the street is not a
  // corridor. Every street with a footway gets them, lanes included: at 3.6 m
  // there is room for a tree and a metre to walk past it, and the lanes are
  // where the new blocks are.
  for (const street of STREETS) {
    if (street.footway < 2) continue;
    const half = street.width / 2 + street.footway * 0.55;
    for (let a = street.from + 14, i = 0; a < street.to - 14; a += 26, i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const at = street.at + side * half;
      const p = street.axis === 'along' ? { across: at, along: a } : { across: a, along: at };
      if (!clear(p.across)) continue;
      trees.push({ ...p, turn: random() * Math.PI * 2 });
      if (i % 2 === 0) props.push({ ...p, turn: random() * Math.PI * 2 });
    }
  }
  // The ring road: trees down the outside of it the whole way round, which is
  // 1.6 km of frontage and the biggest single thing filling the island's empty
  // ground. Outside only — the inside is where the town is, and a tree on the
  // sea side reads as a coast road.
  for (const chain of RING_CHAINS) {
    for (let i = 1; i < chain.length - 1; i += 3) {
    const here = chain[i];
    const before = chain[i - 1];
    const after = chain[i + 1];
    const tx = after.across - before.across;
    const tz = after.along - before.along;
    const len = Math.hypot(tx, tz) || 1;
    // Outward is away from the island's middle, which in this frame is the
    // origin: the ring is a closed curve round it, so the sign of the dot
    // product with the outward radius picks the seaward side of the road.
    const nx = tz / len;
    const nz = -tx / len;
    const outward = (nx * here.across + nz * here.along) > 0 ? 1 : -1;
    const stand = RING.width / 2 + RING.verge + 3.5 + random() * 2.5;
    trees.push({
      across: here.across + nx * stand * outward,
      along: here.along + nz * stand * outward,
      turn: random() * Math.PI * 2,
    });
    }
  }

  // The waterfront park.
  for (let a = PARK.fromAlong + 8; a < PARK.toAlong - 8; a += 17) {
    for (let c = PARK.fromAcross + 8; c < PARK.toAcross - 8; c += 15) {
      trees.push({ across: c + random() * 6 - 3, along: a + random() * 6 - 3, turn: random() * Math.PI * 2 });
    }
  }
  // Parked cars. In the car park they stand nose-in to the bay markings, one
  // per bay pitch, with gaps: a full car park reads as a showroom. At the kerb
  // they stand along the street, which is the other way a car is ever parked.
  const depth = (CAR_PARK.toAcross - CAR_PARK.fromAcross) / 2;
  for (let row = 0; row < CAR_PARK.rows; row++) {
    const at = CAR_PARK.fromAcross + row * depth + depth / 2;
    for (let z = CAR_PARK.fromAlong + 4; z < CAR_PARK.toAlong - 4; z += CAR_PARK.bayPitch * 2) {
      if (random() < 0.3) continue;
      // Nose-in: the car faces across the bay, so it is square to the markings.
      cars.push({ across: at, along: z, turn: row === 0 ? Math.PI / 2 : -Math.PI / 2 });
    }
  }
  // Kerbside parking, and ONLY on the streets flagged for it. These cars have
  // no colliders, and `townNav` narrows those streets' driveable strip by
  // `PARKING_STRIP` to leave room for them; parking on any other street would
  // stand a car in the middle of a lane the NPC traffic believes is clear.
  for (const street of STREETS) {
    if (!street.parking) continue;
    for (let a = street.from + 24; a < street.to - 24; a += 21) {
      if (random() < 0.45) continue;
      const side = random() < 0.5 ? 1 : -1;
      const at = street.at + side * (street.width / 2 - PARKING_STRIP / 2);
      const p = street.axis === 'along' ? { across: at, along: a } : { across: a, along: at };
      if (!clear(p.across)) continue;
      // Facing along the street, one way or the other.
      const face = random() < 0.5 ? 0 : Math.PI;
      cars.push({ ...p, turn: (street.axis === 'along' ? 0 : Math.PI / 2) + face });
    }
  }
  // The taxi rank outside the station.
  for (let z = FORECOURT_KIT.taxiRank.alongFrom; z < FORECOURT_KIT.taxiRank.alongTo; z += 7) {
    cars.push({ across: FORECOURT_KIT.taxiRank.across, along: z, turn: 0 });
  }
  return { trees, props, cars };
}

/**
 * The forecourt's furniture: a bus shelter, benches and bins on the paving
 * outside the platform ramp.
 *
 * Small things, and the reason they are here rather than scattered: a station
 * forecourt is recognisable by exactly these, and where each one goes matters —
 * the shelter faces the station, the benches look at the trains, and the bins
 * are by the ramp. Scattering them would put a bench in the taxi rank.
 */
function Forecourt() {
  const K = FORECOURT_KIT;
  return (
    <group>
      {/* Bus shelter: a glazed box with a flat roof, open to the forecourt. */}
      <group position={[K.shelter.across, GROUND + FOOTWAY_TOP, K.shelter.along]}>
        <mesh position={[0, 2.55, 0]} castShadow>
          <boxGeometry args={[3.4, 0.14, 9]} />
          <meshStandardMaterial color="#2f3336" metalness={0.4} roughness={0.6} />
        </mesh>
        {[-4.4, 4.4].map((z) => (
          <mesh key={z} position={[1.5, 1.3, z]} castShadow>
            <boxGeometry args={[0.16, 2.5, 0.16]} />
            <meshStandardMaterial color="#4a4e52" metalness={0.5} roughness={0.5} />
          </mesh>
        ))}
        {/* Back and end glazing. */}
        <mesh position={[1.62, 1.35, 0]}>
          <boxGeometry args={[0.05, 2.3, 8.8]} />
          <meshStandardMaterial color="#a8c4d0" transparent opacity={0.35} roughness={0.15} metalness={0.1} />
        </mesh>
        <mesh position={[0.1, 0.52, 0]} castShadow>
          <boxGeometry args={[0.5, 0.08, 7.6]} />
          <meshStandardMaterial color="#4a3222" roughness={0.7} />
        </mesh>
      </group>
      {/* Taxi rank: a bay line and a sign. */}
      <mesh
        position={[K.taxiRank.across, GROUND + MARK_TOP,
          (K.taxiRank.alongFrom + K.taxiRank.alongTo) / 2]}
      >
        <boxGeometry args={[0.16, 0.01, K.taxiRank.alongTo - K.taxiRank.alongFrom]} />
        <meshStandardMaterial color="#e2b22a" roughness={0.8} />
      </mesh>
      <group position={[K.taxiRank.across + 3.4, GROUND + FOOTWAY_TOP, K.taxiRank.alongFrom - 3]}>
        <mesh position={[0, 1.2, 0]} castShadow>
          <boxGeometry args={[0.09, 2.4, 0.09]} />
          <meshStandardMaterial color="#7d8288" metalness={0.5} roughness={0.5} />
        </mesh>
        <mesh position={[0, 2.5, 0]} castShadow>
          <boxGeometry args={[0.04, 0.4, 1.1]} />
          <meshStandardMaterial color="#14243a" roughness={0.6} />
        </mesh>
      </group>
      {K.benches.map((b, i) => (
        <group key={`b${i}`} position={[b.across, GROUND + FOOTWAY_TOP, b.along]}>
          <mesh position={[0, 0.45, 0]} castShadow>
            <boxGeometry args={[0.5, 0.07, 1.9]} />
            <meshStandardMaterial color="#4a3222" roughness={0.75} />
          </mesh>
          <mesh position={[0.24, 0.75, 0]} castShadow>
            <boxGeometry args={[0.06, 0.45, 1.9]} />
            <meshStandardMaterial color="#4a3222" roughness={0.75} />
          </mesh>
          {[-0.75, 0.75].map((z) => (
            <mesh key={z} position={[0, 0.22, z]}>
              <boxGeometry args={[0.42, 0.44, 0.08]} />
              <meshStandardMaterial color="#24402c" metalness={0.3} roughness={0.6} />
            </mesh>
          ))}
        </group>
      ))}
      {K.bins.map((b, i) => (
        <mesh key={`n${i}`} position={[b.across, GROUND + FOOTWAY_TOP + 0.5, b.along]} castShadow>
          <cylinderGeometry args={[0.31, 0.29, 1.0, 14]} />
          <meshStandardMaterial color="#1c2a20" roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ whole */

export function IslandTown() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);
  const site = TOWN_SITE;

  const parts = useMemo(() => collectCityParts(
    scene as unknown as Object3D,
    [...new Set([...TOWN_BUILDINGS.map((b) => b.part), TOWN_TREE_PART, TOWN_PROP_PART])],
  ), [scene]);

  const built = useMemo(() => ({
    ring: buildRing(),
    streets: buildStreets(STREETS),
    paving: buildPaving(),
    fence: site ? buildFence(site) : null,
    lamps: buildLamps(),
    tarmac: makeTarmac(),
    paved: makePaving(),
    scatter: scatterPoints(),
  }), [site]);

  useEffect(() => () => {
    built.ring?.road.geometry.dispose();
    built.ring?.shoulder.geometry.dispose();
    built.tarmac.dispose();
    built.paved.dispose();
    for (const g of [built.streets.road, built.streets.foot, built.streets.kerb, built.streets.mark,
      built.paving.road, built.paving.foot, built.paving.mark,
      built.fence, built.lamps.posts, built.lamps.heads]) g?.dispose();
  }, [built]);

  if (!site) return null;
  // Rail head over the crown, at the crossing. `trainPointAt` is the rail base.
  const crossingArc = STATION_SITE ? STATION_SITE.arc + CROSSING.along : 0;
  const railTop = trainPointAt(trainWrap(crossingArc))[1] + RAIL_HEAD_LIFT - site.ground;

  const road = built.streets.road;
  const foot = built.streets.foot;

  return (
    <group position={[site.centre[0], site.ground, site.centre[2]]} rotation={[0, site.heading, 0]}>
      {/* The ring road, first, so where the grid meets it the grid's own
          junction slab is the one on top. Its shoulder is drawn in the same
          grass as the island so the batter at each level crossing reads as
          made ground rather than as a kerb. */}
      {built.ring && (
        <>
          <mesh geometry={built.ring.shoulder.geometry} receiveShadow>
            <meshStandardMaterial color={TOWN_PALETTE.paving} roughness={0.95} side={DoubleSide} />
          </mesh>
          <mesh geometry={built.ring.road.geometry} receiveShadow>
            <meshStandardMaterial map={built.tarmac} color={TOWN_PALETTE.tarmac} roughness={0.96} />
          </mesh>
          <RingDashes />
          {/* No collider, for the same reason the streets have none: the ring
              is a 6 cm slab laid on an island crown that is already solid. It
              had one while it humped over the railway at the tips; it does not
              cross the railway any more. */}
        </>
      )}

      {/* Carriageways and the car park share one material, footways and the
          forecourt another: four draw calls for the whole network. */}
      {road && (
        <mesh geometry={road} receiveShadow>
          <meshStandardMaterial map={built.tarmac} color={TOWN_PALETTE.tarmac} roughness={0.96} />
        </mesh>
      )}
      {built.paving.road && (
        <mesh geometry={built.paving.road} receiveShadow>
          <meshStandardMaterial map={built.tarmac} color={TOWN_PALETTE.tarmac} roughness={0.96} />
        </mesh>
      )}
      {foot && (
        <mesh geometry={foot} receiveShadow castShadow>
          <meshStandardMaterial map={built.paved} color={TOWN_PALETTE.paving} roughness={0.92} />
        </mesh>
      )}
      {built.paving.foot && (
        <mesh geometry={built.paving.foot} receiveShadow castShadow>
          <meshStandardMaterial map={built.paved} color={TOWN_PALETTE.paving} roughness={0.92} />
        </mesh>
      )}
      {built.streets.kerb && (
        <mesh geometry={built.streets.kerb} receiveShadow castShadow>
          <meshStandardMaterial color={TOWN_PALETTE.kerb} roughness={0.85} />
        </mesh>
      )}
      {[built.streets.mark, built.paving.mark].map((g, i) => g && (
        <mesh key={i} geometry={g}>
          <meshStandardMaterial color={TOWN_PALETTE.mark} roughness={0.8} />
        </mesh>
      ))}

      {/* The buildings: the city's own blocks, each one draw call, standing on
          the crown and carrying the city's colliders with them. */}
      {TOWN_BUILDINGS.map((b, i) => {
        const part = parts.get(b.part);
        if (!part) return null;
        return (
          <group key={i} position={[b.across, GROUND, b.along]} rotation={[0, b.turn, 0]}>
            <group position={part.offset}>
              <mesh geometry={part.geometry} material={part.material} castShadow receiveShadow />
            </group>
          </group>
        );
      })}

      {/* The lineside fence, and the street lamps with their lit heads. */}
      {built.fence && (
        <mesh geometry={built.fence} castShadow receiveShadow>
          <meshStandardMaterial color="#9a958c" roughness={0.9} />
        </mesh>
      )}
      {built.lamps.posts && (
        <mesh geometry={built.lamps.posts} castShadow>
          <meshStandardMaterial color="#5f6266" metalness={0.5} roughness={0.5} />
        </mesh>
      )}
      {built.lamps.heads && (
        <mesh geometry={built.lamps.heads}>
          <meshStandardMaterial color="#f4f0e2" emissive="#f4f0e2" emissiveIntensity={0.5} roughness={0.4} />
        </mesh>
      )}

      <Scatter part={parts.get(TOWN_TREE_PART)} items={built.scatter.trees} />
      <Scatter part={parts.get(TOWN_PROP_PART)} items={built.scatter.props} />
      <ParkedCars slots={built.scatter.cars} />
      <Forecourt />

      <LevelCrossing railTop={railTop} />

      {/* Solid: the buildings only. The streets are 6 cm slabs on an island
          crown that is already a collider, so a car drives on them anyway, and
          a trimesh per street would be a hundred colliders for no change. */}
      <RigidBody type="fixed" colliders={false}>
        {TOWN_BUILDINGS.map((b, i) => {
          const part = parts.get(b.part);
          if (!part) return null;
          return <BuildingCollider key={i} part={part} across={b.across} along={b.along} turn={b.turn} />;
        })}
      </RigidBody>
    </group>
  );
}

/**
 * A building's collider: a box round its footprint rather than its trimesh.
 *
 * The chunks are 3,000 to 5,000 triangles of frontage, and a trimesh of each
 * would cost more to build than the whole town's geometry. A car cannot get
 * inside a terrace anyway, so what it needs is the wall, and the wall is the
 * footprint.
 */
function BuildingCollider({ part, across, along, turn }: {
  part: CityPart; across: number; along: number; turn: number;
}) {
  const [w, h, d] = part.size;
  return (
    <group position={[across, GROUND + h / 2, along]} rotation={[0, turn, 0]}>
      <TrimeshCollider args={boxTrimesh(w, h, d)} />
    </group>
  );
}

/** A box as a trimesh, so it can go under a `TrimeshCollider` like the rest. */
function boxTrimesh(w: number, h: number, d: number): [Float32Array, Uint32Array] {
  const g = new BoxGeometry(w, h, d);
  const position = g.getAttribute('position');
  const index = g.getIndex();
  const vertices = new Float32Array(position.array);
  const indices = index ? new Uint32Array(index.array) : new Uint32Array(0);
  g.dispose();
  return [vertices, indices];
}
