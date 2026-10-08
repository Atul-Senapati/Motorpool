'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import {
  BoxGeometry, BufferGeometry, ClampToEdgeWrapping, DoubleSide, Mesh, Quaternion,
  RepeatWrapping, Vector3, type Material, type Texture,
} from 'three';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TRAIN } from '@/config/trainConfig';
import {
  CARGO_JUNCTION_EAST, CROSSING, OUTER_ROAD_LANES, PAVING, SITE,
} from '@/config/airportConfig';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_PAVEMENT, ROAD_REPEAT } from '@/config/roadConfig';
import { groundHeightAt } from '@/physics/cityNav';
import { buildLoft, type ProfileVertex } from './railGeometry';

/**
 * The bridge out to Halcyon Field.
 *
 * Three lanes on a tied-arch main span: a pair of steel ribs leaning together
 * over the water, the deck hung from them on vertical hangers, and the deck's
 * own plate girders acting as the tie that takes the arch's thrust. 297 m of
 * it, a 123 m arch between the two piers, the rest short approach.
 *
 * The parapet is a low concrete edge beam and nothing else: see `edgeHeight`
 * for the railing that used to be there and why it went. What is above the
 * deck is the arch, which you are meant to look at, and not a fence, which you
 * were meant to look through.
 *
 * ## Why it is not the causeway
 *
 * The railway's island is reached by a reclaimed bank with a road on its crown
 * (`IslandBridge`), and this crossing was built that way first. It was wrong.
 * That one is a 130 m hop to a low island, where a bank reads as ground; this
 * is 300 m to an airfield across open water, where what belongs is a
 * structure. The difference is the whole of what you see from underneath: a
 * bank has nothing under it, and this has girders, cross beams, pier caps and
 * columns going down into the sea.
 *
 * What is still shared with the causeway is `buildLoft` — the deck, the
 * girders and the edge beams are all swept sections along the same
 * centreline, which is exactly what that builder is for, and it already sweeps
 * along an arbitrary direction rather than a fixed axis.
 *
 * ## The grade
 *
 * Three heights decide it: the street it leaves — read from the nav raster,
 * because that landing is a coast road and not sea level — the island crown it
 * must meet, and the 6 m of air it must keep over the water. The freeboard is
 * a CEILING on the climb rather than a floor under the deck — see the profile
 * below for why that distinction is the difference between a bridge and a
 * bridge that starts in mid-air. Both ends are level runs, `landing` over the
 * coast road and `islandLanding` over the island, and the grade lives only
 * between them. It comes out 0.09 m at the footpath, 3.45 m from landfall on,
 * steepest 5.5% on the ramp off the seafront.
 *
 * ## Where the piers are, and are not
 *
 * Between `pierFrom` and `pierTo` along the deck, which is the water. Past
 * that the deck is running over the island's own crown on its way to the outer
 * road, and a pier there would be a column buried in the ground.
 */

/** One point along the deck, which is what every swept section runs over. */
interface Deck {
  x: number;
  z: number;
  y: number;
  nx: number;
  nz: number;
  arc: number;
  /** Distance along the centreline, which is what the taper is a function of. */
  s: number;
}

/** A box placed and turned in world XZ — every piece of steel is one of these. */
function part(
  x: number, z: number, y: number, turn: number,
  w: number, h: number, d: number,
): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  g.rotateY(turn);
  g.translate(x, y, z);
  return g;
}

/**
 * A box drawn BETWEEN two points in space, which is what the arch needs and
 * `part` cannot give it.
 *
 * `part` turns about Y only, because until now every piece of steel here was
 * either upright or flat. An arch rib is neither: each of its facets is tilted
 * in the vertical plane, steeply at the springings and hardly at all over the
 * crown, and the hangers and cross bracing want the same freedom. Rotating the
 * unit +Z onto the segment's own direction places any of them, and the section
 * stays square to the member rather than square to the world.
 */
const FORWARD = new Vector3(0, 0, 1);
function strut(
  a: Vector3, b: Vector3, w: number, h: number,
): BufferGeometry {
  const span = new Vector3().subVectors(b, a);
  const length = span.length();
  const g = new BoxGeometry(w, h, length);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(FORWARD, span.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry | null {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/*
 * Nothing drives across it.
 *
 * Ten city cars used to run the deck on a track of their own — see the history
 * of `CROSSING`, which carried their fleet — because the deck already is a
 * track and the city's own AI could not have been taught a road 3.4 m over
 * open water. That worked and it is gone anyway: the island is Halcyon Field,
 * and the traffic on it is meant to be the airport's own. A stream of taxis
 * and school buses crossing to an airfield with a runway on it was the city
 * leaking out to sea.
 */

/**
 * The road kit's carriageway material, for the deck to wear.
 *
 * Borrowed from `roads.glb` rather than rebuilt: drei caches the loaded
 * scene, so this costs no second fetch, and sharing the material means the
 * bridge and the road it lands on are the same asphalt by construction.
 *
 * Cloned, though, because the deck needs its own texture WRAPPING — its UVs
 * run to many repeats along a 300 m span — and mutating the shared one would
 * change every road on the island too.
 */
function useRoadSurface(): Material | undefined {
  const { scene } = useGLTF('/models/roads.glb', DRACO_PATH);
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  return useMemo(() => {
    let found: Material | undefined;
    scene.getObjectByName('straight2')?.traverse((child) => {
      if (!found && child instanceof Mesh) found = child.material as Material;
    });
    if (!found) return undefined;
    const clone = found.clone() as Material & { map?: Texture | null };
    const map = (found as Material & { map?: Texture | null }).map;
    if (map) {
      const tex = map.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.anisotropy = maxAnisotropy;
      tex.needsUpdate = true;
      clone.map = tex;
    }
    return clone;
  }, [scene, maxAnisotropy]);
}

export function AirportBridge() {
  const roadSurface = useRoadSurface();
  const built = useMemo(() => {
    const C = CROSSING;
    const [cx, cz] = C.city;
    const [ix, iz] = C.island;
    const straightRun = Math.hypot(ix - cx, iz - cz);
    const ux = (ix - cx) / straightRun;
    const uz = (iz - cz) / straightRun;

    /* ------------------------------------------- the centreline, with a curve */

    /**
     * Where the outer road is, in the world, and which way it runs.
     *
     * Read off `PAVING.outerRoad` rather than written down again: the road is
     * a rectangle in the island's frame, its centreline is the middle of its
     * two across values, and turning two points on it into world coordinates
     * gives the line the deck has to end up tangent to. Restating those
     * numbers here would mean the bridge quietly stops meeting the road the
     * first time anyone edits it.
     */
    const site = (a: number, across: number): [number, number] => {
      const ch = Math.cos(SITE.heading);
      const sh = Math.sin(SITE.heading);
      return [SITE.centre[0] + a * ch + across * sh, SITE.centre[1] - a * sh + across * ch];
    };
    const [, roadEndA, roadZ0, roadZ1] = PAVING.outerRoad;
    const roadEnd = site(roadEndA, (roadZ0 + roadZ1) / 2);
    const roadBack = site(roadEndA - 50, (roadZ0 + roadZ1) / 2);
    const wx = (roadBack[0] - roadEnd[0]) / 50;
    const wz = (roadBack[1] - roadEnd[1]) / 50;

    /*
     * The classic tangent-arc construction: where the two centrelines cross,
     * back off by the tangent length on each, and swing the arc between.
     *
     * The tangent length is not free here, and that is the whole point. The
     * deck has to FINISH on the junction's east edge, because the junction is
     * the thing it is arriving at — so the distance from the crossing of the
     * two centrelines back to that edge IS the tangent, and the radius falls
     * out of it. Setting a radius by hand instead is what put the deck ten
     * metres past the junction with the entire tile underneath it.
     *
     * Both points are on the outer road's centreline, so the distance between
     * them is a distance along that line and nothing has to be projected.
     */
    const deflect = Math.acos(Math.min(1, Math.max(-1, ux * wx + uz * wz)));
    const det = ux * -wz - uz * -wx;
    const pivot = ((roadEnd[0] - cx) * -wz - (roadEnd[1] - cz) * -wx) / det;
    const cross: [number, number] = [cx + ux * pivot, cz + uz * pivot];
    const landing = site(CARGO_JUNCTION_EAST, (roadZ0 + roadZ1) / 2);
    const tangent = Math.hypot(landing[0] - cross[0], landing[1] - cross[1]);
    const radius = tangent / Math.tan(deflect / 2);
    const curveFrom = pivot - tangent;
    const arcLength = radius * deflect;
    const spin = ux * wz - uz * wx >= 0 ? 1 : -1;
    const foot: [number, number] = [cx + ux * curveFrom, cz + uz * curveFrom];
    const hub: [number, number] = [
      foot[0] + -uz * spin * radius,
      foot[1] + ux * spin * radius,
    ];
    /** A point on the centreline and the unit direction of travel there. */
    const centreAt = (s: number): [number, number, number, number] => {
      if (s <= curveFrom) return [cx + ux * s, cz + uz * s, ux, uz];
      const a = spin * Math.min(s - curveFrom, arcLength) / radius;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const vx = foot[0] - hub[0];
      const vz = foot[1] - hub[1];
      return [
        hub[0] + vx * ca - vz * sa,
        hub[1] + vx * sa + vz * ca,
        ux * ca - uz * sa,
        ux * sa + uz * ca,
      ];
    };
    const run = curveFrom + arcLength;

    /**
     * Half the deck, as a function of distance — the taper. See `CROSSING.curve`.
     * Smoothstepped so the edge has no corner where the narrowing begins.
     */
    const taperFrom = curveFrom - C.curve.taperRun;
    const taperTo = run - tangent;
    const halfAt = (s: number) => {
      const t = Math.min(1, Math.max(0, (s - taperFrom) / (taperTo - taperFrom)));
      return C.halfWidth + (C.curve.roadHalf - C.halfWidth) * (t * t * (3 - 2 * t));
    };
    const half = (d: Deck) => halfAt(d.s);
    const scale = (d: Deck) => halfAt(d.s) / C.halfWidth;

    const from = -C.overlap;
    // The city end overlaps into the street; the island end stops dead on the
    // outer road rather than running across it. See `CROSSING.overlap`.
    const to = run;
    const count = Math.max(8, Math.round((to - from) / C.step));
    const step = (to - from) / count;

    const cityY = groundHeightAt(cx, cz) ?? 0;
    const high = TRAIN.seaLevel + C.freeboard;
    /** Where the deck stops climbing: the island's shore, measured. */
    const landfall = C.landfall;
    /** The height it holds from there to the end. See `endLift`. */
    const islandTop = C.islandY + C.endLift;

    /**
     * The profile, and the freeboard is a CEILING on the climb, not a floor
     * under the whole deck.
     *
     * Asking for 6 m over the water everywhere the water is, then running a
     * cone that only ever raises, gets the ends raised too: the deck needed
     * 2.4 m five metres off the abutment, the cone could not do that inside
     * the grade, so it lifted the abutment instead and the bridge started two
     * metres above the street it was supposed to join. The end pins were being
     * overridden by the very filter meant to respect them.
     *
     * So the height is bounded by how far the deck has climbed from each end
     * at no more than `maxGrade`, capped at the freeboard. Both abutments stay
     * on their ground by construction, the deck rises as fast as it is allowed
     * to, and it reaches the freeboard if and only if there is room.
     */
    const along: number[] = [];
    const top: number[] = [];
    for (let i = 0; i <= count; i++) {
      const s = from + i * step;
      along.push(s);
      // The climb runs between the two level ends: it starts where the coast
      // road has been crossed and finishes at landfall, not at the anchor.
      // See `landing` and `landfall`.
      const climb = Math.max(0, s - C.landing);
      const t = Math.min(1, Math.max(0, (s - C.landing) / (landfall - C.landing)));
      const straight = cityY + (islandTop - cityY) * t;
      const climbed = Math.min(
        cityY + C.maxGrade * climb,
        // The island side falls at its own grade — see `CROSSING.islandGrade`.
        islandTop + C.islandGrade * Math.max(0, to - s),
      );
      top.push(Math.max(straight, Math.min(high, climbed)));
    }
    // The city end lands a little under the footpath it meets (`endSink`); the
    // island end stands a little proud of the grass it crosses (`endLift`),
    // which the profile above has already given it.
    top[0] = cityY - C.endSink;
    // A light smoothing pass, so the corner where the climb meets the
    // freeboard is a curve rather than a crease. It moves nothing at the ends.
    for (let pass = 0; pass < 3; pass++) {
      const copy = [...top];
      for (let i = 1; i < count; i++) top[i] = (copy[i - 1] + copy[i] * 2 + copy[i + 1]) / 4;
    }
    // Reported, because "the bridge is too high" is a number, not an opinion.
    let grade = 0;
    for (let i = 1; i <= count; i++) grade = Math.max(grade, Math.abs(top[i] - top[i - 1]) / step);
    const profile = {
      city: top[0], crest: Math.max(...top), island: top[count],
      clearance: Math.max(...top) - TRAIN.seaLevel, grade,
    };

    let arc = 0;
    const samples: Deck[] = [];
    for (let i = 0; i <= count; i++) {
      if (i > 0) arc += Math.hypot(step, top[i] - top[i - 1]);
      const [x, z, dx, dz] = centreAt(along[i]);
      samples.push({
        x,
        z,
        y: top[i],
        // The section is swept across the deck: the bearing turned a quarter.
        // Per sample now, because the bearing changes through the curve.
        nx: -dz,
        nz: dx,
        arc,
        s: along[i],
      });
    }
    /** The deck height at a distance along the crossing. */
    const heightAt = (s: number) => {
      const t = Math.min(count, Math.max(0, (s - from) / step));
      const i = Math.floor(t);
      const f = t - i;
      return top[i] + ((top[Math.min(count, i + 1)] ?? top[i]) - top[i]) * f;
    };
    const pointAt = (s: number) => {
      const [x, z] = centreAt(s);
      return [x, z] as const;
    };
    /** The bearing at a distance, for turning a box to match the deck there. */
    const turnAt = (s: number) => {
      const [, , dx, dz] = centreAt(s);
      return Math.atan2(dx, dz);
    };
    /**
     * The deck's OWN sideways direction at a distance, and it has to be the
     * deck's rather than the chord's.
     *
     * Everything that stands beside the carriageway — the arch ribs, their
     * hangers, the knee braces, the pier columns — is placed by stepping out
     * from the centreline by an offset. Stepping out along the straight
     * chord's normal is correct only while the deck IS the chord. It used to
     * be, because the arch and both piers sat inside the straight portion and
     * the curve was 30 m of tail beyond them. The curve is 90 m now and the
     * arch's last stretch and the island pier are both on it, so a chord
     * normal would walk the steel off the side of its own deck — by 4 m at
     * the far springing, which is a rib standing in the sea.
     */
    const sideAt = (s: number): [number, number] => {
      const [, , dx, dz] = centreAt(s);
      return [-dz, dx];
    };

    /**
     * The stretch the edge beams are swept over — the samples between
     * `edgeFrom` and `edgeTo`, not the whole deck. See `edgeFrom`.
     */
    /*
     * The island end of the parapet: not `edgeTo` alone but on down the slope
     * past landfall to where the deck actually reaches the island's level.
     * Stopping at landfall left the last of the descent — still a metre and
     * more over the grass and the shoreline beside it — with no edge at all,
     * and a rider who drifted wide there went straight off into the sea.
     */
    let edgeEnd: number = C.edgeTo;
    for (let i = 0; i <= count; i++) {
      if (along[i] <= C.edgeTo) continue;
      edgeEnd = along[i];
      if (top[i] <= islandTop + 0.25) break;
    }
    const edgeRun = samples.filter((_, i) => along[i] >= C.edgeFrom && along[i] <= edgeEnd);

    /* ------------------------------------------------------ swept pieces */

    // Every offset is a function of the sample, not a number, because the deck
    // narrows through the curve — see `CROSSING.curve`. `buildLoft` evaluates
    // a profile per sample precisely so a section can change along the line.
    const shoulder = (d: Deck) => half(d) - 0.7;
    const slab: ProfileVertex<Deck>[] = [
      { off: (d) => -half(d), rise: 0 },
      { off: half, rise: 0 },
      { off: half, rise: -C.deck },
      { off: (d) => -half(d), rise: -C.deck },
    ];
    const road: ProfileVertex<Deck>[] = [
      { off: (d) => -shoulder(d), rise: 0.06 },
      { off: shoulder, rise: 0.06 },
      { off: shoulder, rise: 0 },
      { off: (d) => -shoulder(d), rise: 0 },
    ];
    /** One plate girder, mirrored. */
    const girder = (side: 1 | -1): ProfileVertex<Deck>[] => {
      const o = (d: Deck) => side * C.girderOffset * scale(d);
      const h = C.girderWidth / 2;
      return [
        { off: (d) => o(d) - h, rise: -C.deck },
        { off: (d) => o(d) + h, rise: -C.deck },
        { off: (d) => o(d) + h, rise: -C.deck - C.girderDepth },
        { off: (d) => o(d) - h, rise: -C.deck - C.girderDepth },
      ];
    };
    /** The parapet wall, mirrored: solid and continuous. See `edgeHeight`. */
    const edge = (side: 1 | -1): ProfileVertex<Deck>[] => {
      const outer = (d: Deck) => side * half(d);
      const inner = (d: Deck) => side * (half(d) - C.edgeWidth);
      return [
        { off: inner, rise: C.edgeHeight },
        { off: outer, rise: C.edgeHeight },
        { off: outer, rise: 0 },
        { off: inner, rise: 0 },
      ];
    };
    /**
     * The capping band along the parapet's top, mirrored.
     *
     * It oversails the wall by 6 cm each side, which is the entire job: the
     * overhang throws a continuous shadow line down the face, and that line is
     * what stops a metre of unbroken concrete reading as a blank slab. It is
     * the detail a real parapet has, and the reason this one needs no posts to
     * look like one.
     */
    const cap = (side: 1 | -1): ProfileVertex<Deck>[] => {
      const outer = (d: Deck) => side * (half(d) + C.capOver);
      const inner = (d: Deck) => side * (half(d) - C.edgeWidth - C.capOver);
      return [
        { off: inner, rise: C.edgeHeight + C.capHeight },
        { off: outer, rise: C.edgeHeight + C.capHeight },
        { off: outer, rise: C.edgeHeight },
        { off: inner, rise: C.edgeHeight },
      ];
    };

    /* ------------------------------------------------ boxed pieces ------ */

    const steel: BufferGeometry[] = [];
    const piers: BufferGeometry[] = [];

    // Cross beams between the girders.
    for (let s = 6; s < taperFrom; s += C.crossEvery) {
      const [x, z] = pointAt(s);
      const y = heightAt(s) - C.deck - C.girderDepth / 2;
      steel.push(part(x, z, y, turnAt(s), C.girderOffset * 2, C.crossDepth, C.crossWidth));
    }
    // Piers: two columns from the seabed and a cap across them.
    for (const s of C.piers) {
      const [x, z] = pointAt(s);
      const turn = turnAt(s);
      const deckY = heightAt(s) - C.deck - C.girderDepth;
      const capY = deckY - C.capDepth / 2;
      piers.push(part(x, z, capY, turn, C.capHalf * 2, C.capDepth, C.columnHalf * 2.4));
      const footY = TRAIN.seabed;
      const height = capY - C.capDepth / 2 - footY;
      if (height <= 0) continue;
      const [sx, sz] = sideAt(s);
      for (const side of [-1, 1] as const) {
        const off = side * C.columnSpread;
        piers.push(part(
          x + sx * off, z + sz * off, footY + height / 2, turn,
          C.columnHalf * 2, height, C.columnHalf * 2,
        ));
      }
    }
    /* --------------------------------------------------------- the arch */

    /**
     * The tied arch, and everything hanging off it. See `CROSSING.arch`.
     *
     * The curve is a parabola in the fraction `u` of the span, which is the
     * shape an arch loaded uniformly along its DECK takes — a catenary is the
     * shape for load along the arch itself, and on a bowstring the deck is
     * where the load is. The two differ by a few centimetres at this size, but
     * the parabola is also the one you can write down.
     *
     * `archAt` is the only piece of geometry here: give it a side and a
     * fraction of the span and it returns a point on that rib, and the ribs,
     * the hangers, the bracing and the knees are all just pairs of those.
     */
    const A = C.arch;
    const archSpan = A.to - A.from;
    // The chord, not one springing. The deck is still climbing where the arch
    // starts, so its two feet are three metres apart in height; measuring the
    // rise off a single end would drop the rib below the deck at the high one.
    const springFrom = heightAt(A.from);
    const springTo = heightAt(A.to);
    const archAt = (side: -1 | 1, u: number): Vector3 => {
      const s = A.from + u * archSpan;
      const [x, z] = pointAt(s);
      const [sx, sz] = sideAt(s);
      // Parabolic rise off the chord, and the ribs lean together as they climb.
      const lift = 4 * A.rise * u * (1 - u);
      const chord = springFrom + (springTo - springFrom) * u;
      const off = side * (A.ribOffset - A.ribLean * (lift / A.rise));
      return new Vector3(x + sx * off, chord + lift, z + sz * off);
    };

    for (const side of [-1, 1] as const) {
      // The rib: one chain of facets from springing to springing.
      let prev = archAt(side, 0);
      for (let i = 1; i <= A.segments; i++) {
        const next = archAt(side, i / A.segments);
        steel.push(strut(prev, next, A.ribWidth, A.ribDepth));
        prev = next;
      }
      /*
       * Hangers, from the rib down to the DECK EDGE — not straight down.
       *
       * Straight down is what a hanger does on an arch whose ribs are
       * vertical, and these lean: `ribLean` pulls them from 6.78 m off the
       * centreline at the springings to 4.18 at the crown. A vertical drop
       * from there lands at 4.18, and the carriageway edge is at 6.3, so every
       * hanger over the middle of the span came down in the nearside lane —
       * hanging the deck from the middle of the road rather than from its
       * edge, which is both wrong and in the way.
       *
       * The foot is pinned to the parapet line at `ribOffset` and the hanger
       * leans out to reach it: 2.6 m of lateral run over 33 m of drop at the
       * crown, about 4.5°. That is what an inclined-rib bowstring actually
       * does, and it is the reason its hangers splay when you look along it.
       *
       * The short ones near the springings are left out: below `hangerMin`
       * they are stubs, and a real bridge stops hanging the deck where the
       * arch has already come down to it.
       */
      for (let s = A.from; s <= A.to; s += A.hangerEvery) {
        const u = (s - A.from) / archSpan;
        const top = archAt(side, u);
        const [fx, fz] = pointAt(s);
        const [sx, sz] = sideAt(s);
        const off = side * A.ribOffset;
        const foot = new Vector3(fx + sx * off, heightAt(s), fz + sz * off);
        if (top.y - foot.y < A.hangerMin) continue;
        steel.push(strut(foot, top, A.hangerHalf * 2, A.hangerHalf * 2));
      }
      // Knee braces: each springing tied back to the deck, which is the
      // detail that stops a bowstring looking like it is balanced on a point.
      for (const [u, run2] of [[0, A.kneeRun], [1, -A.kneeRun]] as const) {
        const foot = archAt(side, u);
        const s = A.from + u * archSpan + run2;
        const [kx, kz] = pointAt(s);
        const [sx, sz] = sideAt(s);
        const off = side * A.ribOffset;
        steel.push(strut(
          foot,
          new Vector3(kx + sx * off, heightAt(s), kz + sz * off),
          A.kneeHalf * 2, A.kneeHalf * 2,
        ));
      }
    }
    // Cross bracing over the crown: transverse struts with an X between each
    // pair, which is how the two ribs are held against each other.
    for (let bay = 0; bay <= A.braceBays; bay++) {
      const u = A.braceFrom + (A.braceTo - A.braceFrom) * (bay / A.braceBays);
      steel.push(strut(archAt(-1, u), archAt(1, u), A.braceHalf * 2, A.braceHalf * 2));
      if (bay === A.braceBays) continue;
      const next = A.braceFrom + (A.braceTo - A.braceFrom) * ((bay + 1) / A.braceBays);
      steel.push(strut(archAt(-1, u), archAt(1, next), A.braceHalf * 1.4, A.braceHalf * 1.4));
      steel.push(strut(archAt(1, u), archAt(-1, next), A.braceHalf * 1.4, A.braceHalf * 1.4));
    }

    return {
      length: arc,
      piers: C.piers.length,
      /**
       * The deck as a track: one distance in, a point on the carriageway and
       * the bearing there out. The bearing has to come back with it now that
       * the island end curves — a car holding the straight run's heading would
       * drive off the side of the arc.
       */
      deckAt: (s: number, offset: number) => {
        const [x, z, dx, dz] = centreAt(s);
        return {
          x: x + -dz * offset,
          y: heightAt(s),
          z: z + dx * offset,
          heading: Math.atan2(dx, dz),
        };
      },
      run,
      curve: {
        radius,
        arc: arcLength,
        /** How far off the road's own bearing the deck ends. Should be zero. */
        error: Math.abs(Math.acos(Math.min(1, Math.max(-1,
          centreAt(run)[2] * wx + centreAt(run)[3] * wz)))),
      },
      crown: (springFrom + springTo) / 2 + A.rise,
      profile,
      edgeEnd,
      slab: buildLoft(samples, slab, { closed: true, vScale: 8 }),
      /*
       * The running surface, textured with the road kit rather than painted.
       *
       * `buildLoft` gives u ACROSS the profile and v along the arc, which is
       * the opposite of what the kit wants — its texture runs along u and is
       * one repeat across v. So the two are swapped afterwards: the new u is
       * the arc in texture repeats, and the new v is the old u clamped to
       * 0..1, which lands the carriageway exactly across the deck and leaves
       * the profile's side faces showing the edge pixel, where nothing looks.
       */
      road: (() => {
        const loft = buildLoft(samples, road, { closed: true, vScale: 8 });
        const uv = loft.geometry.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) {
          // Across the CARRIAGEWAY only: the deck carries its own parapets,
          // so the kit's painted footways are cropped off both edges and the
          // four lanes are stretched over the full width. See ROAD_PAVEMENT.
          const t = Math.min(1, Math.max(0, uv.getX(i)));
          const across = ROAD_PAVEMENT + t * (1 - 2 * ROAD_PAVEMENT);
          const along = (uv.getY(i) * 8) / ROAD_REPEAT;
          uv.setXY(i, along, across);
        }
        uv.needsUpdate = true;
        return loft;
      })(),
      girders: [
        buildLoft(samples, girder(-1), { closed: true, vScale: 8 }),
        buildLoft(samples, girder(1), { closed: true, vScale: 8 }),
      ],
      edges: [
        buildLoft(edgeRun, edge(-1), { closed: true, vScale: 8 }),
        buildLoft(edgeRun, edge(1), { closed: true, vScale: 8 }),
      ],
      caps: [
        buildLoft(edgeRun, cap(-1), { closed: true, vScale: 8 }),
        buildLoft(edgeRun, cap(1), { closed: true, vScale: 8 }),
      ],
      steel: merge(steel),
      pierGeometry: merge(piers),
    };
  }, []);

  useEffect(() => {
    /*
     * The deck's width and the road's are both `DECK_HALF` — the deck arrives
     * the width of the kit's carriageway and stays it — so there is no taper
     * to report. Say there is one only if the two are ever pulled apart again.
     */
    const deckWidth = (CROSSING.halfWidth * 2).toFixed(2);
    const roadWidth = (CROSSING.curve.roadHalf * 2).toFixed(2);
    const width = deckWidth === roadWidth
      ? `deck ${deckWidth} m`
      : `deck tapering ${deckWidth} m to ${roadWidth} m`;
    console.info(`[bridge] ${Math.round(built.length)} m to Halcyon Field, `
      + `${OUTER_ROAD_LANES} lanes on ${Math.round(built.piers)} piers; deck `
      + `${built.profile.city.toFixed(2)} m at the city, ${built.profile.crest.toFixed(2)} m at the `
      + `crest (${built.profile.clearance.toFixed(1)} m over the water), `
      + `${built.profile.island.toFixed(2)} m at the island, parapet to ${Math.round(built.edgeEnd)} of ${Math.round(built.length)} m, `
      + `${(built.profile.grade * 100).toFixed(1)}% steepest; tied arch `
      + `${CROSSING.arch.to - CROSSING.arch.from} m spanning both piers, crown `
      + `${built.crown.toFixed(1)} m; ${built.curve.arc.toFixed(0)} m curve on a `
      + `${built.curve.radius.toFixed(0)} m radius onto the outer road, ${width}, `
      + `joint out by ${(built.curve.error * 180 / Math.PI).toFixed(3)}°`);
    return () => {
      built.slab.geometry.dispose();
      built.road.geometry.dispose();
      for (const g of [...built.girders, ...built.edges, ...built.caps]) g.geometry.dispose();
      built.steel?.dispose();
      built.pierGeometry?.dispose();
    };
  }, [built]);

  const C = CROSSING;
  return (
    <group>
      <mesh geometry={built.slab.geometry} castShadow receiveShadow>
        <meshStandardMaterial color={C.colours.deck} roughness={0.9} side={DoubleSide} />
      </mesh>
      <mesh geometry={built.road.geometry} receiveShadow material={roadSurface} />
      {/* No painted lane lines. The deck wears the road kit's own texture
          now, which carries its markings, its kerbs and its crossings — a
          second set drawn over the top would be two roads' worth of paint. */}
      {/* The parapet, in the deck's own concrete — it is part of the slab, and
          painting it steel made it read as the fence it replaced. */}
      {built.edges.map((g, i) => (
        <mesh key={`edge${i}`} geometry={g.geometry} castShadow receiveShadow>
          <meshStandardMaterial color={C.colours.deck} roughness={0.9} side={DoubleSide} />
        </mesh>
      ))}
      {/* Its capping band, in steel, for the shadow line. See `cap`. */}
      {built.caps.map((g, i) => (
        <mesh key={`cap${i}`} geometry={g.geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color={C.colours.steel}
            roughness={0.6}
            metalness={0.5}
            side={DoubleSide}
          />
        </mesh>
      ))}
      {/* The steel: girders under the deck, the arch above it. */}
      {built.girders.map((g, i) => (
        <mesh key={`girder${i}`} geometry={g.geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color={C.colours.steel}
            roughness={0.55}
            metalness={0.6}
            side={DoubleSide}
          />
        </mesh>
      ))}
      {built.steel && (
        <mesh geometry={built.steel} castShadow receiveShadow>
          <meshStandardMaterial color={C.colours.steel} roughness={0.55} metalness={0.6} />
        </mesh>
      )}
      {built.pierGeometry && (
        <mesh geometry={built.pierGeometry} castShadow receiveShadow>
          <meshStandardMaterial color={C.colours.pier} roughness={0.92} />
        </mesh>
      )}
      {/* The running surface, and the parapet walls: solid, so the edge you
          see is an edge that holds you. They were visual only, from when the
          edge was a 42 cm kerb — a bike drifting wide went through them into
          the sea. */}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[built.road.vertices, built.road.indices]} friction={1} />
        {built.edges.map((g, i) => (
          <TrimeshCollider key={`edgeCollider${i}`} args={[g.vertices, g.indices]} friction={0.3} />
        ))}
      </RigidBody>
    </group>
  );
}
