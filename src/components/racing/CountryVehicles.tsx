'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Euler, Group, Mesh, Object3D, Quaternion } from 'three';
import { CuboidCollider, RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { DRACO_PATH } from '@/config/cityConfig';
import countryModels from '@/config/countryModelData.json';
import { PARKED, groundAt } from '@/config/countryConfig';
import { WORK_LOOPS, type WorkLoop } from '@/config/countryFields';

/**
 * The island's vehicles: twelve parked, and two at work.
 *
 * Every one is a part of the country kit, baked facing −Z and standing on
 * y = 0 (`prepare-country.mjs`), so placing one is a position, the ground
 * under it and a heading. `PARKED` has already searched out ground level
 * enough for each footprint; the two working machines drive a loop inside a
 * field's own boundary (`WORK_LOOPS`), which is how a tractor works a field —
 * round it, in from the headland — and is also what keeps them off the hedges.
 *
 * The moving pair carry kinematic colliders, written in the before-step
 * callback rather than the frame loop, which is the rule everything that
 * touches Rapier in this project follows: writing to a body from `useFrame`
 * races the step's borrow of the world and aborts.
 */

const KIT = '/models/country.glb';
useGLTF.preload(KIT, DRACO_PATH);

const sizeOf = (part: string): [number, number, number] => {
  const s = (countryModels.parts as Record<string, { size: number[] }>)[part]?.size ?? [2, 2, 4];
  return [s[0], s[1], s[2]];
};

/* ------------------------------------------------------------- parked */

function Parked() {
  const { scene: kit } = useGLTF(KIT, DRACO_PATH);
  const placed = useMemo(() => PARKED.map((v) => {
    const node = kit.getObjectByName(v.part);
    if (!node) return null;
    const object = node.clone(true);
    object.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return { ...v, object, size: sizeOf(v.part), y: groundAt(v.x, v.z) };
  }).filter((v): v is NonNullable<typeof v> => v !== null), [kit]);

  return (
    <>
      {placed.map((v) => (
        <primitive key={v.label} object={v.object} position={[v.x, v.y, v.z]} rotation={[0, v.turn, 0]} />
      ))}
      <RigidBody type="fixed" colliders={false}>
        {placed.map((v) => (
          <CuboidCollider
            key={v.label}
            args={[v.size[0] / 2, v.size[1] / 2, v.size[2] / 2]}
            position={[v.x, v.y + v.size[1] / 2, v.z]}
            rotation={[0, v.turn, 0]}
          />
        ))}
      </RigidBody>
    </>
  );
}

/* ------------------------------------------------------------ at work */

/** Where a loop is at `arc`, interpolated between its two-metre samples. */
function poseOn(loop: WorkLoop, arc: number) {
  const n = loop.samples.length;
  const t = ((arc % loop.length) + loop.length) / loop.length * n;
  const i = Math.floor(t) % n;
  const f = t - Math.floor(t);
  const a = loop.samples[i];
  const b = loop.samples[(i + 1) % n];
  const mix = (p: number, q: number) => p + (q - p) * f;
  const tx = mix(a.tx, b.tx);
  const tz = mix(a.tz, b.tz);
  const len = Math.hypot(tx, tz) || 1;
  return { x: mix(a.x, b.x), z: mix(a.z, b.z), y: mix(a.y, b.y), tx: tx / len, tz: tz / len };
}

/**
 * One machine working a field: round and round its loop at a working pace.
 *
 * Pitched to the ground it is on, not just placed on it — a combine nose-down
 * into a hollow is the difference between a machine working and a model
 * standing on a lawn. The pitch comes from the ground a bogie-length ahead
 * and behind, which is the same chord the locomotives use.
 */
function Working({ part, loop, speed, phase, label }: {
  part: string;
  loop: WorkLoop;
  /** Metres a second: a tractor works at about 2.4, a combine slower. */
  speed: number;
  /** Where it starts, as a fraction of the lap. */
  phase: number;
  label: string;
}) {
  const { scene: kit } = useGLTF(KIT, DRACO_PATH);
  const object = useMemo(() => {
    const node = kit.getObjectByName(part);
    if (!node) return null;
    const copy = node.clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return copy;
  }, [kit, part]);
  const size = useMemo(() => sizeOf(part), [part]);
  const carrier = useRef<Group>(null);
  const body = useRef<RapierRigidBody | null>(null);
  const arc = useRef(loop.length * phase);
  const scratch = useMemo(() => ({ quaternion: new Quaternion(), euler: new Euler(0, 0, 0, 'YXZ') }), []);

  /** Position and attitude at the current arc. */
  const place = () => {
    const at = poseOn(loop, arc.current);
    // The chord under it: half its own length ahead and behind.
    const half = size[2] / 2;
    const front = poseOn(loop, arc.current + half);
    const back = poseOn(loop, arc.current - half);
    const rise = groundAt(front.x, front.z) - groundAt(back.x, back.z);
    const pitch = Math.atan2(rise, size[2]);
    const yaw = Math.atan2(-at.tx, -at.tz);
    const y = (groundAt(front.x, front.z) + groundAt(back.x, back.z)) / 2;
    return { x: at.x, y, z: at.z, yaw, pitch };
  };

  useBeforePhysicsStep(() => {
    const at = place();
    scratch.euler.set(at.pitch, at.yaw, 0);
    scratch.quaternion.setFromEuler(scratch.euler);
    body.current?.setNextKinematicTranslation({ x: at.x, y: at.y + size[1] / 2, z: at.z });
    body.current?.setNextKinematicRotation(scratch.quaternion);
  });

  useFrame((_, dt) => {
    arc.current += speed * Math.min(dt, 0.1);
    const group = carrier.current;
    if (!group) return;
    const at = place();
    group.position.set(at.x, at.y, at.z);
    scratch.euler.set(at.pitch, at.yaw, 0);
    group.quaternion.setFromEuler(scratch.euler);
  });

  if (!object) return null;
  return (
    <>
      <group ref={carrier}>
        <primitive object={object} />
      </group>
      <RigidBody
        ref={body}
        type="kinematicPosition"
        colliders="cuboid"
        position={[0, -500, 0]}
      >
        {/* Invisible: the visible machine is the model above, which Rapier
            never sees. This only sizes the collider. */}
        <mesh visible={false} name={label}>
          <boxGeometry args={[size[0], size[1], size[2]]} />
        </mesh>
      </RigidBody>
    </>
  );
}

export function CountryVehicles() {
  useEffect(() => {
    console.info(`[country] ${PARKED.length} vehicles parked, ${WORK_LOOPS.length} at work: `
      + WORK_LOOPS.map((l) => `${l.label} ${Math.round(l.length)} m`).join(', '));
  }, []);

  return (
    <>
      <Parked />
      {WORK_LOOPS[0] && (
        <Working part="tractor" loop={WORK_LOOPS[0]} speed={2.4} phase={0} label="working tractor" />
      )}
      {WORK_LOOPS[1] && (
        <Working part="harvester" loop={WORK_LOOPS[1]} speed={1.5} phase={0.4} label="working combine" />
      )}
    </>
  );
}
