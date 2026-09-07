'use client';

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CuboidCollider, RigidBody, interactionGroups, useBeforePhysicsStep,
  type ContactForcePayload, type RapierRigidBody,
} from '@react-three/rapier';
import {
  DynamicDrawUsage, Euler, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3,
  type BufferGeometry, type Material,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { TRAFFIC } from '@/config/trafficConfig';
import catalogue from '@/config/vehicleCatalogue.json';
import { createTraffic, updateTraffic } from '@/physics/trafficAI';
import type { VehicleTelemetry } from '@/types/vehicle';

const MODEL = '/models/vehicles.glb';
useGLTF.preload(MODEL, DRACO_PATH);

interface CatalogueEntry {
  name: string;
  label: string;
  kind: string;
  size: number[];
  wheelMesh: string | null;
  wheelRadius: number;
  hubs: number[][];
}

const VEHICLES = catalogue.vehicles as CatalogueEntry[];

/** One instanced draw per (vehicle, primitive). */
interface Batch {
  mesh: InstancedMesh;
  /** Which vehicle type this batch draws. */
  type: number;
  /** Hub offsets when this batch is a wheel, empty for a body. */
  hubs: number[][];
  wheelRadius: number;
}

/**
 * NPC traffic.
 *
 * Rendering is instanced: every car of a given type shares one `InstancedMesh`
 * per primitive, so 40 cars cost about 80 draw calls total rather than 40 scene
 * graphs. Wheels, where the source pack kept them separate, are a second batch
 * at four instances per car and spin off the car's odometer.
 *
 * Collision is a pool of *dynamic* bodies that the AI drives by teleporting them
 * into place every step, velocity and all. That is a deliberate choice over the
 * obvious kinematic pool. A kinematic body is immovable, so hitting one is
 * hitting a wall; and switching a body to dynamic at the moment of impact — the
 * first version of this — fails in three ways at once. The switch goes through
 * React, so it lands a commit late and the car draws at the wrong orientation
 * for a frame; an impulse applied to the still-kinematic body is silently
 * dropped; and the first frame of contact resolves against infinite mass, so
 * the player gets a hard stop before the other car moves. Teleporting a dynamic
 * body instead means the solver sees a real mass with a real velocity on the
 * frame of the hit, both cars share the impulse the way they should, and the AI
 * just stops teleporting once a hit registers.
 */
interface TrafficProps {
  telemetry: RefObject<VehicleTelemetry>;
  /** The player's chassis, for telling their hits apart from everything else. */
  playerBodyRef?: RefObject<RapierRigidBody | null>;
  /**
   * Cap on live cars — the traffic density setting.
   *
   * The body pool is fixed at mount, so this throttles how many of those slots
   * the AI is allowed to fill rather than changing how many exist. Read through
   * a ref inside the frame loop so changing it never re-runs the effect that
   * owns the physics step.
   */
  activeLimit?: number;
}

/** Rough kerb weight from length — enough that a shunt looks like metal. */
const massFor = (length: number) => Math.round(length * 320);

/**
 * Collision groups. Rapier collides a pair only when each body's membership
 * intersects the other's filter.
 *
 *   DRIVING  member 1, filter everything but 1
 *   WRECK    member 2, filter everything
 *
 * So two driven cars never collide. They never did — the AI passes oncoming
 * traffic head-on and relies on that — and as dynamic bodies they were
 * generating a contact for every such pass, each of which the solver resolved
 * and the teleport then threw away. A driven car does still collide with the
 * player and with the world (both on the default groups, member and filter
 * all), and with a wreck. That last pairing is the reason the groups exist at
 * all: see `onImpact`.
 */
const DRIVING_GROUPS = interactionGroups(1, [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const WRECK_GROUPS = interactionGroups(2);

/** What a body's `userData` carries when it is one of ours. */
interface NpcTag { npc?: number }

export function Traffic({ telemetry, playerBodyRef, activeLimit }: TrafficProps) {
  const { scene } = useGLTF(MODEL, DRACO_PATH);
  const npcs = useMemo(() => createTraffic(VEHICLES.length), []);
  const bodyRefs = useRef<(RapierRigidBody | null)[]>([]);

  /**
   * Full orientation of every car. While the AI drives, this is just its
   * heading; once a car is a wreck it is whatever Rapier says, pitch and roll
   * included. Kept current for driving cars too, so the frame a hit registers
   * has a correct orientation to draw rather than an identity quaternion.
   */
  const orientations = useMemo(() => npcs.map(() => new Quaternion()), [npcs]);

  /**
   * A hard enough contact hands the car to the solver.
   *
   * There is nothing to apply here: the body is already dynamic with the AI's
   * velocity on it, so Rapier has already worked out the momentum exchange in
   * the step that produced this event. All that changes is that the AI stops
   * overwriting the result.
   *
   * Exactly two things can do this to a driven car: the player, and a wreck.
   * Not the world — the AI scrapes kerbs, and its stuck-recovery exists because
   * it drives into geometry. And not another driven car, which the collision
   * groups rule out anyway. The wreck case is what stops a bus flying: a driven
   * car is teleported into place every step, so left to itself it ploughs into
   * a stationary wreck with what the solver sees as infinite momentum. Wrecking
   * it on the first hard contact means it rams for one step — an ordinary
   * impulse — and then it is a wreck too, with real inertia, in a pile-up.
   */
  const onImpact = useCallback((index: number, payload: ContactForcePayload) => {
    // Ordered cheapest-first on purpose: this binding exposes no contact-force
    // event threshold, so every contact a traffic car makes — including simply
    // resting on the road — arrives here.
    if (payload.totalForceMagnitude < TRAFFIC.impact.force) return;
    const npc = npcs[index];
    if (!npc.active || npc.wreck > 0) return;

    const other = payload.other.rigidBody;
    if (!other) return;
    const otherNpc = (other.userData as NpcTag | undefined)?.npc;
    const isPlayer = other === playerBodyRef?.current;
    const isWreck = otherNpc !== undefined && npcs[otherNpc]?.wreck > 0;
    if (!isPlayer && !isWreck) return;

    // Closing speed is relative: this car's own velocity against the other
    // body's, so a wreck sliding into a slow car counts as much as the reverse.
    const v = other.linvel();
    const sx = -Math.sin(npc.heading) * npc.speed;
    const sz = -Math.cos(npc.heading) * npc.speed;
    const closing = Math.hypot(sx - v.x, v.y, sz - v.z);
    if (closing < TRAFFIC.impact.speed) return;

    npc.wreck = Number.EPSILON; // non-zero: the AI stops steering from here
  }, [npcs, playerBodyRef]);

  /**
   * Which bodies currently carry WRECK_GROUPS, so the switch is made exactly
   * once per transition rather than every step for forty bodies.
   */
  const wreckFlags = useMemo(() => new Uint8Array(npcs.length), [npcs]);

  // --- build one instanced batch per (vehicle, primitive) -------------------
  const batches = useMemo(() => {
    const out: Batch[] = [];
    // Keyed on `extras` (-> userData), not on names. GLTFLoader splits a
    // multi-primitive mesh into children renamed `<name>_1`, `<name>_2`..., so
    // the mesh's own name never appears in the loaded scene.
    const byPart = new Map<string, Mesh[]>();
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const { vehicle, part } = o.userData as { vehicle?: string; part?: string };
      if (!vehicle || !part) return;
      const key = `${vehicle}|${part}`;
      const list = byPart.get(key) ?? [];
      list.push(o);
      byPart.set(key, list);
    });

    VEHICLES.forEach((vehicle, type) => {
      const make = (source: Mesh, hubs: number[][]) => {
        const count = TRAFFIC.perType * Math.max(1, hubs.length || 1);
        const mesh = new InstancedMesh(
          source.geometry as BufferGeometry,
          source.material as Material,
          count,
        );
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // The cars move every frame and are scattered across the city, so a
        // shared bounding volume would cull them all at once, wrongly.
        mesh.frustumCulled = false;
        mesh.count = 0;
        out.push({ mesh, type, hubs, wheelRadius: vehicle.wheelRadius });
      };

      for (const m of byPart.get(`${vehicle.name}|body`) ?? []) make(m, []);
      if (vehicle.wheelMesh)
        for (const m of byPart.get(`${vehicle.name}|wheel`) ?? []) make(m, vehicle.hubs);
    });
    return out;
  }, [scene]);

  useEffect(() => {
    const missing = VEHICLES.filter((v) => !batches.some((b) => b.type === VEHICLES.indexOf(v)));
    console.info(
      `[traffic] ${VEHICLES.length} vehicle types, ${batches.length} instanced batches, ` +
      `${npcs.length} slots` + (missing.length ? ` — MISSING: ${missing.map((m) => m.name).join(', ')}` : ''),
    );
  }, [batches, npcs.length]);

  // Mirrored into a ref: the frame loop must not close over a prop, and making
  // it a dependency would tear down and rebuild the loop on every change. The
  // copy happens in an effect, not in render — a ref written during render is
  // exactly the case the rules-of-react lint rejects.
  const limitRef = useRef(activeLimit);
  useEffect(() => {
    limitRef.current = activeLimit;
  }, [activeLimit]);

  const scratch = useMemo(() => ({
    matrix: new Matrix4(),
    wheelMatrix: new Matrix4(),
    position: new Vector3(),
    quaternion: new Quaternion(),
    euler: new Euler(),
    scale: new Vector3(1, 1, 1),
  }), []);

  // Simulation and every Rapier write happen in the before-step callback, NOT
  // in useFrame. Touching a body from the render loop races the physics step's
  // borrow of the World and throws "recursive use of an object detected which
  // would lead to unsafe aliasing in rust" — which kills the step, spams the
  // console and eventually loses the WebGL context. Same rule as CarPhysics.
  // The fixed timestep is also the honest dt for a scripted simulation.
  useBeforePhysicsStep(() => {
    const t = telemetry.current;
    if (!t) return;
    updateTraffic(npcs, PHYSICS_TIMESTEP, t.x, t.z, t.x, t.z, limitRef.current ?? npcs.length);

    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      const body = bodyRefs.current[i];
      if (!body) continue;

      if (npc.wreck > 0) {
        if (!wreckFlags[i]) {
          // First step as a wreck: open its collision groups so driven cars
          // (and other wrecks) can hit it. Done here, not in the event handler,
          // to keep every Rapier write inside the before-step callback.
          wreckFlags[i] = 1;
          for (let c = 0; c < body.numColliders(); c++) body.collider(c).setCollisionGroups(WRECK_GROUPS);
        }
        // Rapier owns this one. Read it back so the drawn car — and the
        // obstacle every other NPC steers around — is wherever the impact put
        // it, rather than where the AI last left it.
        const t = body.translation();
        const r = body.rotation();
        const v = body.linvel();
        npc.x = t.x;
        npc.y = t.y - VEHICLES[npc.type].size[1] / 2;
        npc.z = t.z;
        npc.speed = Math.hypot(v.x, v.y, v.z);
        // Yaw only, for the AI's sake; the full rotation is kept for drawing.
        npc.heading = Math.atan2(
          2 * (r.w * r.y + r.x * r.z),
          1 - 2 * (r.y * r.y + r.x * r.x),
        );
        orientations[i].set(r.x, r.y, r.z, r.w);
        continue;
      }

      if (wreckFlags[i]) {
        // Recycled after a wreck: back to a driven car's groups before its
        // next life, or it would spend it colliding with other traffic.
        wreckFlags[i] = 0;
        for (let c = 0; c < body.numColliders(); c++) body.collider(c).setCollisionGroups(DRIVING_GROUPS);
      }

      if (!npc.active) {
        // Parked far below the map rather than destroyed, so the pool is
        // stable. Velocity is zeroed too, or a recycled wreck would arrive in
        // its next life still carrying the momentum of whatever hit it.
        body.setTranslation({ x: npc.x, y: -500, z: npc.z }, false);
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        continue;
      }

      // Driving: the AI is authoritative, so the body is put exactly where the
      // AI says, carrying the AI's velocity. Teleporting a dynamic body every
      // step looks like a hack and is the whole point — see the note at the top.
      // The velocity matters as much as the position: it is what the solver
      // uses to work out how hard this car hits back.
      scratch.euler.set(0, npc.heading, 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      orientations[i].copy(scratch.quaternion);
      body.setTranslation({
        x: npc.x, y: npc.y + VEHICLES[npc.type].size[1] / 2, z: npc.z,
      }, true);
      body.setRotation(scratch.quaternion, true);
      body.setLinvel({
        x: -Math.sin(npc.heading) * npc.speed, y: 0, z: -Math.cos(npc.heading) * npc.speed,
      }, true);
      body.setAngvel({ x: 0, y: npc.yawRate, z: 0 }, true);
    }
  });

  // Rendering only — reads the NPC state, never Rapier.
  useFrame(() => {
    // --- write instance matrices ---
    const cursor = new Map<Batch, number>();
    for (const b of batches) cursor.set(b, 0);

    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      if (!npc.active) continue;

      // Wrecks pitch and roll, and a yaw-only matrix would stand them
      // stubbornly upright while they are meant to be tumbling — so the
      // physics step keeps a full orientation for every car and this reads it.
      scratch.quaternion.copy(orientations[i]);

      for (const b of batches) {
        if (b.type !== npc.type) continue;
        const n = cursor.get(b) ?? 0;

        if (!b.hubs.length) {
          scratch.position.set(npc.x, npc.y, npc.z);
          scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
          b.mesh.setMatrixAt(n, scratch.matrix);
          cursor.set(b, n + 1);
          continue;
        }

        // Wheels: car transform, then the hub offset, then roll about X.
        scratch.position.set(npc.x, npc.y, npc.z);
        scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
        const spin = -npc.odometer / (b.wheelRadius || 0.35);
        for (let w = 0; w < b.hubs.length; w++) {
          const hub = b.hubs[w];
          scratch.wheelMatrix.makeRotationX(spin);
          scratch.wheelMatrix.setPosition(hub[0], hub[1], hub[2]);
          scratch.wheelMatrix.premultiply(scratch.matrix);
          b.mesh.setMatrixAt(n + w, scratch.wheelMatrix);
        }
        cursor.set(b, n + b.hubs.length);
      }
    }

    for (const b of batches) {
      b.mesh.count = cursor.get(b) ?? 0;
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  });

  useEffect(() => () => {
    for (const b of batches) b.mesh.dispose();
  }, [batches]);

  return (
    <group>
      {batches.map((b, i) => (
        <primitive key={i} object={b.mesh} />
      ))}

      {/* Collider pool. Declarative on purpose: creating bodies imperatively
          from an effect calls `world.createRigidBody` at a moment when the
          World is already borrowed, and Rapier throws "recursive use of an
          object detected which would lead to unsafe aliasing in rust" — the
          same trap as reading `world.timestep` mid-step (HANDOFF §4.1). Letting
          the library own creation is the only safe way in. */}
      {npcs.map((npc, i) => {
        const [w, h, l] = VEHICLES[npc.type].size;
        return (
          <RigidBody
            key={i}
            ref={(instance) => { bodyRefs.current[i] = instance; }}
            /* Always dynamic — the AI drives it by teleport (see the note at
               the top), so the solver always has a real mass to push against.
               `canSleep` is off because a body that is teleported every step
               is never at rest by Rapier's definition anyway, and a sleeping
               one would miss a hit. */
            type="dynamic"
            colliders={false}
            position={[0, -500, 0]}
            /* Read back in onImpact to recognise a hit from another NPC. */
            userData={{ npc: i } satisfies NpcTag}
            onContactForce={(payload) => onImpact(i, payload)}
            linearDamping={0.2}
            angularDamping={0.5}
            canSleep={false}
          >
            {/* Explicit collider, not `colliders="cuboid"`: mass has to be set
                on the COLLIDER (the same trap CarPhysics documents), and an
                auto-generated one would leave a car weighing what its own
                volume implies — about 13 kg, which flies like a crisp packet
                when hit. */}
            <CuboidCollider
              args={[w / 2, h / 2, l / 2]}
              collisionGroups={DRIVING_GROUPS}
              mass={massFor(l)}
              friction={0.8}
              restitution={0.15}
            />
          </RigidBody>
        );
      })}

    </group>
  );
}
