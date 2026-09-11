'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  DoubleSide, Euler, InstancedMesh, Matrix4, Quaternion, Vector3,
} from 'three';
import {
  RAIL_HEAD_LIFT, TRAIN, trainNormalAt, trainPointAt, trainTangentAt, trainWrap,
} from '@/config/trainConfig';
import { CROSSOVER, CROSSOVER_ROADS, TURNOUTS, roadOf } from '@/config/pointwork';
import { STATION, secondTrackGap } from '@/config/stationConfig';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { SLEEPER_GEOMETRY } from './sleeper';

/**
 * The connecting tracks, and the machines that work them.
 *
 * Only the crossovers are drawn here. The station's loop lines are laid by
 * `IslandStation` — they are its roads, and its ladder is what joins them to
 * the down line — so what is left is the diagonals: two at each site, crossing
 * in the middle, which is what a scissors crossover is.
 *
 * A crossover needs nothing under it. It runs between two tracks that are
 * already carried, so the deck, the invert or the shared ballast crown that
 * holds them holds this too, and every height here is measured down from the
 * rail head exactly as the running line's is. That is why 84 m of track can be
 * laid on a viaduct, in a bore and on an embankment from one sample loop with
 * no structure-specific work at all — and it is why there is no ballast
 * profile: between two banks 4.6 m apart the two crowns already meet.
 */

const STEP = 3;
/** Rail centres, either side of the road's own centreline. */
const GAUGE = TRAIN.gauge / 2;
const SLEEPER_TOP = -TRAIN.railHeight;
const SLEEPER_BOTTOM = SLEEPER_TOP - TRAIN.sleeperHeight;
/** Texture repeat along the line, shared with `TrainLine` so the rails match. */
const V_SCALE = 6;

interface Diagonal extends LoftSample {
  /** Which connecting track this sample belongs to. */
  road: number;
  /**
   * Far enough from both running lines to be drawn as its own track.
   *
   * A crossover meets each line *tangentially* — that is the whole point of the
   * smoothstep, and it is why the train can cross without a step — so its rails
   * lie within a few centimetres of the ones they are joining for the first and
   * last twenty metres. Drawn anyway, that reads as one smeared rail rather than
   * as pointwork, so the diagonal is only laid where it has separated by
   * `STATION.bladeGap`. What is left is the part of a real crossover you can
   * actually see: the middle, between two sets of blades.
   */
  blade: boolean;
}

/** One rail: a box section standing on the sleepers, as `TrainLine` builds it. */
const railProfile = (centre: number): ProfileVertex<Diagonal>[] => [
  { off: centre - TRAIN.railWidth / 2, rise: 0 },
  { off: centre + TRAIN.railWidth / 2, rise: 0 },
  { off: centre + TRAIN.railWidth / 2, rise: SLEEPER_TOP },
  { off: centre - TRAIN.railWidth / 2, rise: SLEEPER_TOP },
];

/**
 * Every connecting track's samples, end to end in one array.
 *
 * One array and one geometry per rail rather than one per crossover: twelve
 * diagonals is twelve draw calls for 1 km of track, and the loft's `filter`
 * already exists to break a sweep where it should not join. The segment
 * between two roads is simply dropped.
 *
 * The normal is taken from the road's *own* polyline, not the running line's.
 * A diagonal is 3° off the line it leaves, and borrowing the line's normal
 * there would shear the section by that much — 4 cm of gauge error on a 1.435 m
 * track, which is visible as rails that do not sit under the wheels.
 */
function sampleDiagonals(): Diagonal[] {
  const samples: Diagonal[] = [];
  for (const road of CROSSOVER_ROADS) {
    const count = Math.max(2, Math.round(road.length / STEP));
    const points: Array<[number, number, number, number]> = [];
    for (let i = 0; i <= count; i++) {
      const s = trainWrap(road.from + (road.length * i) / count);
      const [x, y, z] = trainPointAt(s);
      const off = road.offset(s);
      // The offset is measured left of the running line, so the point is the
      // line's own normal times the offset. Taken from the route rather than
      // recomputed: the two have to agree exactly at the turnout, which is the
      // whole basis of being able to cross there.
      const [nx, nz] = trainNormalAt(s);
      // Separation from whichever running line is nearer here.
      const gap = secondTrackGap(s);
      const clear = Math.min(Math.abs(off), Math.abs(gap - off)) >= STATION.bladeGap;
      points.push([x + nx * off, y + RAIL_HEAD_LIFT, z + nz * off, clear ? 1 : 0]);
    }
    let arc = 0;
    for (let i = 0; i < points.length; i++) {
      const [x, y, z] = points[i];
      if (i > 0) arc += Math.hypot(x - points[i - 1][0], z - points[i - 1][2]);
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      const tx = b[0] - a[0];
      const tz = b[2] - a[2];
      const length = Math.hypot(tx, tz) || 1;
      // Left-hand normal, the sign the rest of the railway uses.
      samples.push({
        x, y, z, arc, road: road.id, blade: points[i][3] === 1,
        nx: tz / length, nz: -tx / length,
      });
    }
  }
  return samples;
}

/** Sleepers under the diagonals, one instanced box for all of them. */
function Sleepers({ samples }: { samples: Diagonal[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const count = useMemo(
    () => CROSSOVER_ROADS.length * Math.ceil(CROSSOVER.lead / TRAIN.sleeperSpacing) + 4,
    [],
  );

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    // The shared monobloc geometry (`sleeper.ts`): unit scale, origin at the underside.
    const scale = new Vector3(1, 1, 1);
    let placed = 0;
    // Walked per road, along the road's own arc length, so the pitch is the
    // line's 0.7 m on the diagonal as well as on the straight.
    for (const road of CROSSOVER_ROADS) {
      const own = samples.filter((s) => s.road === road.id);
      if (own.length < 2) continue;
      const length = own[own.length - 1].arc;
      const steps = Math.floor(length / TRAIN.sleeperSpacing);
      for (let i = 0; i < steps && placed < count; i++) {
        const at = i * TRAIN.sleeperSpacing;
        const k = Math.min(own.length - 2, Math.floor((at / length) * (own.length - 1)));
        const a = own[k];
        const b = own[k + 1];
        // Not under the blades: the running line's own sleepers are there.
        if (!a.blade || !b.blade) continue;
        const t = (at - a.arc) / Math.max(b.arc - a.arc, 1e-3);
        euler.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
        quaternion.setFromEuler(euler);
        position.set(
          a.x + (b.x - a.x) * t,
          a.y + SLEEPER_BOTTOM + (b.y - a.y) * t,
          a.z + (b.z - a.z) * t,
        );
        instanced.setMatrixAt(placed++, matrix.compose(position, quaternion, scale));
      }
    }
    instanced.count = placed;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [count, samples]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} receiveShadow geometry={SLEEPER_GEOMETRY}>
      <meshStandardMaterial vertexColors roughness={0.9} metalness={0.05} />
    </instancedMesh>
  );
}

/**
 * A point machine beside every turnout.
 *
 * The one piece of lineside equipment this needs. Without it a set of points is
 * two rails converging, which from a cab at speed is indistinguishable from the
 * track simply being there — and the driver has to be able to *see* where a
 * decision is, not only read its distance off the HUD. A grey box on the cess
 * is what a modern turnout actually looks like from the front.
 *
 * Placed on the outside of whichever of the two roads is nearer the running
 * line, which is the one hand that is clear on every structure the line has:
 * the viaduct's deck edge, the bore's walkway and the ballast shoulder all sit
 * further out than this.
 */
function Machines() {
  const mesh = useRef<InstancedMesh>(null);
  const count = TURNOUTS.length;

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3(1.1, 0.55, 0.6);
    TURNOUTS.forEach((turnout, i) => {
      const [x, y, z] = trainPointAt(turnout.arc);
      const [nx, nz] = trainNormalAt(turnout.arc);
      const inner = Math.min(
        roadOf(turnout.a).offset(turnout.arc), roadOf(turnout.b).offset(turnout.arc),
      );
      const off = inner - 2.6;
      const [tx, tz] = trainTangentAt(turnout.arc);
      euler.set(0, Math.atan2(tx, tz), 0);
      quaternion.setFromEuler(euler);
      position.set(
        x + nx * off,
        y + RAIL_HEAD_LIFT + SLEEPER_BOTTOM + 0.55 / 2,
        z + nz * off,
      );
      instanced.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [count]);

  if (!count) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#8b8f93" roughness={0.7} metalness={0.2} />
    </instancedMesh>
  );
}

export function Pointwork() {
  const built = useMemo(() => {
    const samples = sampleDiagonals();
    // Never across the joint between two roads — they are laid end to end in one
    // array and are not continuous with each other — and never where the
    // diagonal has closed on a running line. See `Diagonal.blade`.
    const same = (a: Diagonal, b: Diagonal) => a.road === b.road && a.blade && b.blade;
    return {
      samples,
      railLeft: buildLoft(samples, railProfile(-GAUGE),
        { vScale: V_SCALE, closed: true, filter: same }),
      railRight: buildLoft(samples, railProfile(GAUGE),
        { vScale: V_SCALE, closed: true, filter: same }),
    };
  }, []);

  useEffect(() => () => {
    built.railLeft.geometry.dispose();
    built.railRight.geometry.dispose();
  }, [built]);

  if (!CROSSOVER_ROADS.length) return null;

  return (
    <group>
      <Sleepers samples={built.samples} />
      <Machines />
      {/* The same steel as the running line's, and DoubleSide for the same
          reason: a 13 cm section whose winding depends on which way the loop
          travels. */}
      {[built.railLeft, built.railRight].map((rail, i) => (
        <mesh key={i} geometry={rail.geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color="#8e949c" roughness={0.35} metalness={0.85} side={DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
