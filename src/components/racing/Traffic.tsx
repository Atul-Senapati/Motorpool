'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
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
 * Collision is a pool of *kinematic* bodies. The cars are scripted, so they must
 * not be pushed around by the physics they take part in; kinematic bodies collide
 * with the player without responding. The practical consequence is that hitting
 * a traffic car is like hitting a wall — it does not get shunted. Making traffic
 * shovable means giving each NPC a dynamic body and a driver model to keep it on
 * the road afterwards, which is a much larger change.
 */
export function Traffic({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const { scene } = useGLTF(MODEL, DRACO_PATH);
  const npcs = useMemo(() => createTraffic(VEHICLES.length), []);
  const bodyRefs = useRef<(RapierRigidBody | null)[]>([]);

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
    updateTraffic(npcs, PHYSICS_TIMESTEP, t.x, t.z, t.x, t.z);

    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      const body = bodyRefs.current[i];
      if (!body) continue;
      if (!npc.active) {
        // Parked far below the map rather than destroyed, so the pool is stable.
        body.setNextKinematicTranslation({ x: npc.x, y: -500, z: npc.z });
        continue;
      }
      scratch.euler.set(0, npc.heading, 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      body.setNextKinematicTranslation({
        x: npc.x, y: npc.y + VEHICLES[npc.type].size[1] / 2, z: npc.z,
      });
      body.setNextKinematicRotation(scratch.quaternion);
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

      scratch.euler.set(0, npc.heading, 0);
      scratch.quaternion.setFromEuler(scratch.euler);

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
          the library own creation is the only safe way in.

          Bodies are kinematic: the cars are scripted, so they collide with the
          player without being pushed by him. Hitting traffic is therefore like
          hitting a wall — the car does not get shunted aside. */}
      {npcs.map((npc, i) => {
        const [w, h, l] = VEHICLES[npc.type].size;
        return (
          <RigidBody
            key={i}
            ref={(instance) => { bodyRefs.current[i] = instance; }}
            type="kinematicPosition"
            colliders="cuboid"
            position={[0, -500, 0]}
          >
            {/* Invisible: the visible car is drawn by the instanced batches
                above, which Rapier never sees. This only sizes the collider. */}
            <mesh visible={false}>
              <boxGeometry args={[w, h, l]} />
            </mesh>
          </RigidBody>
        );
      })}

    </group>
  );
}
