'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { TRAIN_BODY } from '@/physics/trainImpact';
import { Euler, Object3D, Quaternion } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  FREIGHT_LOCOS, FREIGHT_WAGONS, TRAIN, freightFormation, freightLength,
  locomotivePose, trainDarknessAt, trainSpeedLimitAt, trainWrap,
  type FreightLocoId, type FreightUnit, type FreightWagonId,
} from '@/config/trainConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { SELECTED } from '@/config/garage';
import { DOWN, UP, ahead } from '@/config/pointwork';
import { playerRoad, runsAlongArc } from '@/config/railSpawn';
import { ROADS, STATION_SITE, roadOffset, secondTrackGap, upLoopOffset } from '@/config/stationConfig';
import { forgetTrain, reportTrain } from '@/physics/trainRegistry';
import { blockLimit } from '@/physics/trainSignalling';
import { Headlamps } from './Headlamps';
import { ShadowProxy } from './shadowProxy';

/**
 * Every freight model, preloaded and loaded as one fixed list.
 *
 * A fixed list and not the rake's own models, because `useGLTF` is a hook and
 * a hook cannot be called a different number of times for a six-wagon train
 * than for a four-wagon one. Loading all five costs nothing that the two rakes
 * do not already cost between them — the running service uses the Class 37 and
 * all three wagons, the stabled one the Class 08 and three of them — so the
 * list is the union either way, and indexing it by path keeps the formation
 * free to name whatever it likes.
 */
const FREIGHT_MODELS = [
  ...Object.values(FREIGHT_LOCOS).map((l) => l.vehicle.model),
  ...Object.values(FREIGHT_WAGONS).map((w) => w.vehicle.model),
];
for (const model of FREIGHT_MODELS) useGLTF.preload(model, DRACO_PATH);

/**
 * How far ahead a goods train looks for the train in front, metres.
 *
 * The passenger services' own `BLOCK`, and the same number on purpose: a block
 * is a property of the *railway*, not of whatever happens to be standing in it,
 * and a train given a block of its own would be a train that obeys a different
 * signal from the one beside it.
 */
const BLOCK = (TRAIN.speed * TRAIN.speed) / (2 * TRAIN.brake) + 120;

/*
 * There is no freight speed factor, and there was.
 *
 * A goods train ran at 45 % of the passenger limit, on the reasoning that a
 * loaded freight is not a 300 km/h express and should not look like one — true
 * of a real railway, and it is what a real one would do. On this line it cost
 * more than it bought. A single slow train on a 9.2 km loop with no passing
 * loops in section is a train the expresses spend their whole circuit queued
 * behind: once the block working was honest (`blockLimit`) they stopped driving
 * through it and started following it instead, which turned four 300 km/h
 * services into a convoy running at 68 and made the goods train the only thing
 * that sets the timetable.
 *
 * So freight now runs the same profile as everything else: `TRAIN.speed`
 * capped by `trainSpeedLimitAt`, exactly as `Service` does. Every AI train on
 * the line is on one profile again, which is the state in which an evenly
 * spaced set stays evenly spaced and nothing ever closes on the train in front
 * — the property the services were written to rely on, now true of the goods
 * trains as well. `blockLimit` stays, because the ridden train is still on the
 * line and is still the one train that does not run to a profile.
 */

/**
 * True when the player's own train is on this road, and so no service may be.
 * The same rule `TrainLine`'s passenger services follow, and for the same
 * reason: nothing worth meeting shares a road with the player.
 */
const mine = (road: number) => SELECTED.rail === 'main' && playerRoad() === road;

/**
 * The two roads a train can be put away on, and which running line each is a
 * loop off.
 *
 * Neither needs geometry of its own. Both are *lateral offsets off a running
 * line* for the length of the station and nothing at all outside it, which is
 * exactly what `upLoopOffset` and `roadOffset` return — so a stabled train sits
 * on its running line's arc, displaced, and `locomotivePose` offsets each bogie
 * before taking the chord as it does for every other vehicle on the railway.
 *
 * - **`relief`** is the goods loop off the UP line, on the town side. It has no
 *   platform face, which is what makes it the natural place to leave something:
 *   a road with a face is a road a passenger expects a train to call at.
 * - **`goods`** is the outermost of the four station roads, a loop off the DOWN
 *   line on the platform side. `ROADS[ROADS.length - 1]` rather than the index,
 *   because it is "the outermost road" that matters and not "road 3" — it is
 *   the one the station's own formation is sized from (`STATION_YARD`), so
 *   anything standing on it is standing on ballast that already exists.
 *
 * One either side of the running lines, which is the other reason to use these
 * two: the station reads as a place that handles goods from both directions,
 * and neither rake hides the other.
 */
const STABLING = {
  relief: { line: UP, offsetAt: upLoopOffset },
  goods: {
    line: DOWN,
    offsetAt: (along: number) => roadOffset(ROADS[ROADS.length - 1], along),
  },
} as const;

export type StablingRoad = keyof typeof STABLING;

/**
 * A goods train: a locomotive and a rake of wagons, either working the loop or
 * put away in one of the station's two loops.
 *
 * Its own component rather than another `stock` for `TrainLine`'s `Service`,
 * because a freight formation is not the shape a passenger one is. A service
 * is a count of one repeated coach and resolves every unit to one of two
 * GLTFs; here each unit carries its own model path, its own length and its own
 * bogie centres, which is what lets a 10.4 m hopper, an 11.6 m van and a
 * 12.0 m tank couple up in one rake and each sit correctly on the curve.
 *
 * The two modes are one component because they differ in exactly three things
 * — whether the arc advances, which lateral offset the wheels follow, and
 * whether the train is reported to the signalling — and every other line of
 * this, the per-unit posing, the colliders, the shadow proxies, the lamps, is
 * shared. Splitting it would have been two copies of the posing loop.
 */
export function FreightTrain({
  loco, wagons, phase = 0, track = 0, stabled,
}: {
  loco: FreightLocoId;
  wagons: readonly FreightWagonId[];
  /** Arc length of the leading locomotive at load. Ignored when `stabled`. */
  phase?: number;
  /** 0 = the running (up) line, 1 = the down line. Ignored when `stabled`. */
  track?: 0 | 1;
  /**
   * Which station loop this train is put away in, if it is. Undefined means it
   * works the line. See `STABLING` and `stabledArc`.
   */
  stabled?: StablingRoad;
}) {
  const formation = useMemo(() => freightFormation(loco, wagons), [loco, wagons]);
  const length = useMemo(() => freightLength(formation), [formation]);
  const yard = stabled ? STABLING[stabled] : null;

  /**
   * Where the stabled rake stands: centred on the station's midpoint.
   *
   * Centred, and over buffers rather than over `freightLength` — which is the
   * distance from the locomotive's *centre* to the rear buffer, so half the
   * engine is missing from it. `total` adds that half back, and the lead arc
   * is then however far forward of the midpoint the front buffer has to be for
   * the two ends to hang off it equally.
   *
   * The whole train is 57 m over buffers and the loop's straight is 107 m
   * either side of the midpoint (`halfPlatform + approach`), so a centred rake
   * stands 79 m clear of the nearer set of blades at each end. It is standing
   * in the loop, not fouling the turnout — which is the difference between a
   * train that has been put away and one that has been abandoned.
   */
  const stabledArc = useMemo(() => {
    const site = STATION_SITE;
    if (!site || !yard) return 0;
    const total = length + formation[0].length / 2;
    return trainWrap(
      site.arc + runsAlongArc(yard.line) * (total / 2 - formation[0].length / 2),
    );
  }, [formation, length, yard]);

  // A stabled train faces the way the line its loop comes off is worked, and a
  // running one faces the way its own road is. Either way `runsAlongArc` says
  // which that is, rather than anything here naming a sign of its own.
  const direction: 1 | -1 = runsAlongArc(yard ? yard.line : (track === 0 ? UP : DOWN));

  /**
   * Which road the wheels follow, as metres left of the running line.
   *
   * `ahead` turns this train's arc into the station-relative `along` that the
   * stabling offsets are written in, the short way round the loop. Outside the
   * station both of those return their road's merged offset, which is why a
   * stabled train needs no geometry and no guard: it is on a running line's
   * arc, displaced.
   */
  const lateral = useMemo(() => {
    const site = STATION_SITE;
    if (yard) {
      return site ? (arc: number) => yard.offsetAt(ahead(site.arc, arc)) : () => 0;
    }
    return track === 1 ? secondTrackGap : () => 0;
  }, [yard, track]);

  const models = useGLTF(FREIGHT_MODELS, DRACO_PATH);
  const byModel = useMemo(
    () => new Map(FREIGHT_MODELS.map((path, i) => [path, models[i].scene])),
    [models],
  );

  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  const carriers = useRef<(Object3D | null)[]>([]);
  const travelled = useRef(yard ? stabledArc : phase);
  const speed = useRef(0);
  /** How dark it is where this train is — see `Headlamps`. */
  const darkness = useRef(trainDarknessAt(yard ? stabledArc : phase));

  const registryId = `freight-${loco}-${stabled ?? track}-${phase.toFixed(0)}`;
  useEffect(() => () => forgetTrain(registryId), [registryId]);

  // Cloned for the same reason the passenger services clone: drei caches one
  // scene per URL, and re-parenting it here would empty it out from under the
  // next mount. Clones share geometry and material, so the second hopper in a
  // rake is a draw call and a matrix. Cloned per UNIT and not per model, since
  // the same hopper appears twice in the running rake and one Object3D cannot
  // stand in two places.
  const clones = useMemo(
    () => formation.map((unit) => byModel.get(unit.model)!.clone(true)),
    [formation, byModel],
  );

  useEffect(() => {
    for (const model of clones) {
      model.traverse((child) => {
        // NOT a caster — see `ShadowProxy`, and the note on the passenger
        // service. A wagon is a hundred primitives and every one of them was
        // its own shadow submission.
        child.castShadow = false;
        child.receiveShadow = true;
      });
    }
  }, [clones]);

  const scratch = useMemo(() => ({
    quaternion: new Quaternion(), euler: new Euler(0, 0, 0, 'YXZ'),
  }), []);

  /** Where one unit sits. The passenger service's `unitPose`, unit for unit. */
  const unitPose = (leadArc: number, unit: FreightUnit) => {
    const arc = trainWrap(leadArc - direction * unit.offset);
    const at = locomotivePose(arc, direction, lateral, unit.bogieCentres);
    return unit.flip ? { ...at, yaw: at.yaw + Math.PI, pitch: -at.pitch } : at;
  };

  const place = () => {
    for (let i = 0; i < formation.length; i++) {
      const at = unitPose(travelled.current, formation[i]);
      scratch.euler.set(at.pitch, at.yaw, 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      bodies.current[i]?.setNextKinematicTranslation({
        x: at.x, y: at.y + formation[i].box[1] / 2, z: at.z,
      });
      bodies.current[i]?.setNextKinematicRotation(scratch.quaternion);
    }
  };

  // Rapier writes go in the before-step callback, never in useFrame — the same
  // rule CarPhysics, the tram and the passenger services follow.
  useBeforePhysicsStep(() => {
    if (!yard) {
      // Reported before the block is read, so this train is in the registry
      // when it asks what is on its road — the same order `Service` uses, and
      // the same reason: `blockLimit` skips the caller by id.
      const self = {
        id: registryId, arc: travelled.current, track, direction, length,
        speed: speed.current,
      };
      reportTrain(registryId, self);
      // The passenger services' own profile, line for line — see the note above
      // on why there is no longer a freight factor here.
      const limit = Math.min(TRAIN.speed, trainSpeedLimitAt(travelled.current));
      const target = Math.min(limit, blockLimit(self, BLOCK));
      const step = TRAIN.brake * PHYSICS_TIMESTEP;
      speed.current += Math.max(-step, Math.min(step, target - speed.current));
      travelled.current = trainWrap(
        travelled.current + direction * speed.current * PHYSICS_TIMESTEP,
      );
      darkness.current = trainDarknessAt(travelled.current);
    }
    // A stabled train is never reported, and that is the whole reason one is
    // safe to leave in a loop. `trainRegistry` is what the signals and the
    // level crossing's barriers read, and they read it BY ROAD: in arc terms a
    // train in a station loop is a train parked on the running line for ever,
    // so reporting it would hold the block ahead at red and the barriers down,
    // permanently, for a train that is not on the running line at all — and
    // now that the AI trains read each other too (`blockLimit`), it would stop
    // every service on that road dead as well. A loop exists precisely so that
    // what stands in it does not occupy the line.
    place();
  });

  useFrame(() => {
    for (let i = 0; i < formation.length; i++) {
      const group = carriers.current[i];
      if (!group) continue;
      const at = unitPose(travelled.current, formation[i]);
      group.position.set(at.x, at.y, at.z);
      scratch.euler.set(at.pitch, at.yaw, 0);
      group.quaternion.setFromEuler(scratch.euler);
    }
  });

  return (
    <>
      {clones.map((model, i) => (
        <group key={i} ref={(group) => { carriers.current[i] = group; }}>
          <primitive object={model} />
          <ShadowProxy size={formation[i].box as [number, number, number]} />
          {i === 0 && (
            <Headlamps dark={darkness} speed={speed} length={formation[0].length} />
          )}
        </group>
      ))}
      {formation.map((unit, i) => (
        <RigidBody
          key={i}
          ref={(body) => { bodies.current[i] = body; }}
          type="kinematicPosition"
          colliders={false}
          userData={TRAIN_BODY}
          position={[0, -500, 0]}
        >
          {/* The visible vehicle is the model above, which Rapier never sees.
              An explicit box, not an invisible mesh for `colliders="cuboid"` to
              size: the auto-collider walks only VISIBLE meshes, so a hidden box
              gave the wagon no collider at all. */}
          <CuboidCollider args={[unit.box[0] / 2, unit.box[1] / 2, unit.box[2] / 2]} friction={0.6} />
        </RigidBody>
      ))}
    </>
  );
}

/** True when a goods train may work `road` — see `mine`. */
export const freightCanWork = (road: number) => !mine(road);
