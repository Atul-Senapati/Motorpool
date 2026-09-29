'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Euler, Mesh, Object3D, Quaternion, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import airportModels from '@/config/airportModelData.json';
import { SCHEDULE, type Circuit } from '@/config/flightConfig';

/**
 * The aeroplanes that fly, land, park and take off again.
 *
 * `flightConfig` owns both circuits: where each aeroplane is, which way it
 * points, how far over it is leaning, whether its wheels are out and whether
 * it is standing still, all as functions of one number — how far round its
 * cycle it has gone. This file turns that into a transform, spins the ATR's
 * propellers, and stays out of the way. There is no state machine and no
 * animation clip; the attitude falls out of the path, which is why an
 * aeroplane banks into its turns by the right amount, rotates on the runway at
 * the right moment and points its nose at the terminal while being pushed
 * backwards off it, without any of the three being keyframed.
 *
 * ## Two aeroplanes, one runway
 *
 * A 747 and an ATR 42 run the same airfield on the same period, half a cycle
 * apart — see `SCHEDULE`. They park at different stands and are never on the
 * runway together.
 *
 * ## No navigation lights
 *
 * There were six emissive marbles on each aeroplane — red to port, green to
 * starboard, strobes on the tips and tail, a beacon under the belly — and they
 * came off. Two reasons. They read as coloured dots stuck to the wings rather
 * than as lights, which is what happens when an unlit sphere is big enough to
 * see from the ground. And their positions were written for a 747 and then
 * handed to a 25 m turboprop as well, which put its tail strobe eight metres
 * above the fin and its wing lamps past the wingtips. Sizing them per aircraft
 * would fix the second; only dropping them fixes the first.
 *
 * ## Models
 *
 * The 747 is `plane.glb`, which `prepare-plane.mjs` splits into body, gear and
 * the gear doors in both positions, so retraction is two visibility flags
 * rather than a rig. The ATR is a mesh in `airport.glb` with its two
 * propellers split out and recentred on their hubs, so spinning them is a
 * rotation about Z and nothing else.
 */

const JET_MODEL = '/models/plane.glb';
const AIRPORT_MODEL = '/models/airport.glb';
useGLTF.preload(JET_MODEL, DRACO_PATH);
useGLTF.preload(AIRPORT_MODEL, DRACO_PATH);

/**
 * The half turn the 747 needs and the ATR does not.
 *
 * A yaw of `heading` aims an object's own +Z along its direction of travel.
 * `prepare-plane` leaves the VC-25A's nose at −Z; `prepare-airport` turns the
 * ATR to +Z on the way in, the same quarter turn the bus gets.
 */
const JET_SPIN = Math.PI;

/**
 * What each circuit flies, and how its model is put together.
 *
 * A table rather than two branches, because there are three aeroplanes now and
 * the branches were `name === '747' ? jet : turboprop` — which is fine for two
 * and is a bug waiting for a third, since the A400M is a turboprop that is not
 * the ATR and would have been handed the ATR's mesh and the ATR's two
 * propeller names.
 *
 * `spin` is the half turn a model needs when its nose is at −Z. `props` are
 * the parts `prepare-airport` split out and recentred on their own hubs, so
 * each is placed at its hub and turned about Z and nothing else.
 */
const FLEET: Record<string, {
  fromJet?: true;
  part?: string;
  spin: number;
  props?: readonly string[];
}> = {
  '747': { fromJet: true, spin: JET_SPIN },
  'ATR 42': { part: 'atr', spin: 0, props: ['atrPropLeft', 'atrPropRight'] },
  // Four propellers, outer and inner, both sides.
  'A400M': {
    part: 'c400',
    spin: 0,
    props: ['c400PropOuterL', 'c400PropInnerL', 'c400PropInnerR', 'c400PropOuterR'],
  },
};

/** Propeller speed, radians a second, at rest and running. */
const PROP_IDLE = 2.2;
const PROP_RUN = 62;

/** A propeller hub as `prepare-airport` measured it. */
const hubOf = (part: string): [number, number, number] | null => {
  const entry = (airportModels.parts as Record<string, { hub?: number[] }>)[part];
  return entry?.hub ? [entry.hub[0], entry.hub[1], entry.hub[2]] : null;
};

/**
 * One aeroplane on one circuit.
 *
 * Cloned rather than re-parented for the reason every model here is: drei
 * caches the loaded scene, and moving the cached nodes into this group means a
 * hot reload remounts into an emptied scene and draws nothing.
 */
function Aircraft({ circuit, phase }: { circuit: Circuit; phase: number }) {
  const { scene: jetScene } = useGLTF(JET_MODEL, DRACO_PATH);
  const { scene: airportScene } = useGLTF(AIRPORT_MODEL, DRACO_PATH);

  const built = useMemo(() => {
    const spec = FLEET[circuit.name];
    if (!spec) return null;
    const source = spec.fromJet ? jetScene : airportScene.getObjectByName(spec.part!);
    if (!source) return null;
    const copy = source.clone(true);
    for (const object of copy.children) object.frustumCulled = false;
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    const props: Object3D[] = [];
    if (spec.props) {
      // The propellers are separate meshes, recentred on their hubs by the
      // prepare script — so they are placed AT the hub and spun about Z, and
      // there is no rig and no offset to work out.
      for (const name of spec.props) {
        const mesh = airportScene.getObjectByName(name);
        const hub = hubOf(name);
        if (!mesh || !hub) continue;
        const blade = mesh.clone(true);
        blade.position.set(hub[0], hub[1], hub[2]);
        blade.traverse((child) => {
          if (child instanceof Mesh) { child.castShadow = false; child.receiveShadow = false; }
        });
        copy.add(blade);
        props.push(blade);
      }
    }
    // Retractable gear is the 747's alone: `prepare-plane` splits it out and
    // both positions of its doors, so retraction is two visibility flags.
    const find = (name: string) => (spec.fromJet ? copy.getObjectByName(name) ?? null : null);
    return {
      root: copy,
      props,
      gear: find('gear'),
      doorsOpen: find('doorsOpen'),
      doorsShut: find('doorsShut'),
      spin: spec.spin,
    };
  }, [jetScene, airportScene, circuit.name]);

  const body = useRef<Group>(null);
  /**
   * How far round the cycle, metres. Off React state because it changes every
   * frame, and started at this aeroplane's own scheduled phase so the two do
   * not want the runway at once.
   */
  const [start] = useState(() => phase * circuit.lapLength);
  const travelled = useRef(start);
  /**
   * The hold being served, and how much of it is left.
   *
   * A stand is not a slow bit of path, it is a stop, and a path has no way to
   * say so: at 3 m/s the aeroplane would glide through its own stand in ten
   * seconds and never park. `served` keeps it to once a cycle — without it the
   * aeroplane waits, creeps a metre, and finds itself back inside the window.
   */
  const holding = useRef({ left: 0, served: -1 });
  const propAngle = useRef(0);
  const scratch = useMemo(() => ({
    euler: new Euler(0, 0, 0, 'YXZ'), quaternion: new Quaternion(),
  }), []);

  useFrame((_, rawDelta) => {
    const group = body.current;
    if (!group || !built) return;
    // Clamped: a tab coming back from the background hands us a multi-second
    // delta, which would teleport an aeroplane a kilometre down the circuit.
    const dt = Math.min(rawDelta, 1 / 20);
    const here = circuit.at(travelled.current);

    const hold = holding.current;
    let moving = true;
    if (hold.left > 0) {
      hold.left -= dt;
      moving = false;
    } else {
      const reached = circuit.holds.findIndex((h, i) => i !== hold.served
        && travelled.current >= h.at && travelled.current < h.at + 12);
      if (reached >= 0) {
        hold.left = circuit.holds[reached].seconds;
        hold.served = reached;
        moving = false;
      } else {
        const next = (travelled.current + here.speed * dt) % circuit.lapLength;
        // Round the end of the cycle every hold is due again.
        if (next < travelled.current) hold.served = -1;
        travelled.current = next;
      }
    }

    const now = circuit.at(travelled.current);
    group.position.set(now.x, now.y, now.z);
    // YXZ: yaw first, then pitch, then roll — the order an aircraft's attitude
    // is actually built in, and the only one where bank stays about the
    // fuselage axis after the nose has come up.
    scratch.euler.set(now.pitch, now.heading + built.spin, -now.bank);
    group.quaternion.setFromEuler(scratch.euler);

    if (built.gear) built.gear.visible = now.gearDown;
    if (built.doorsOpen) built.doorsOpen.visible = now.gearDown;
    if (built.doorsShut) built.doorsShut.visible = !now.gearDown;

    // Propellers: ticking over on the stand, running everywhere else. The
    // angle is integrated rather than set from the clock so that changing the
    // rate does not make the blades jump.
    if (built.props.length) {
      propAngle.current += (moving ? PROP_RUN : PROP_IDLE) * dt;
      for (const blade of built.props) blade.rotation.z = propAngle.current;
    }
  });

  if (!built) return null;
  return (
    <group ref={body}>
      <primitive object={built.root} />
    </group>
  );
}

export function Airliner() {
  useEffect(() => {
    for (const { circuit, phase } of SCHEDULE) {
      console.info(`[flight] ${circuit.name}: ${Math.round(circuit.lapLength)} m, `
        + `${circuit.fixes} fixes, ${Math.round(circuit.cycleSeconds)} s a cycle `
        + `(${Math.round(circuit.rollingSeconds)} s moving, ${circuit.holdSeconds} s standing), `
        + `starting ${Math.round(phase * 100)}% round`);
    }
  }, []);

  return (
    <>
      {SCHEDULE.map(({ circuit, phase }) => (
        <Aircraft key={circuit.name} circuit={circuit} phase={phase} />
      ))}
    </>
  );
}
