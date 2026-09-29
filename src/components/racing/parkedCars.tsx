'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import {
  InstancedMesh, Matrix4, Mesh, type Object3D, Quaternion, Vector3,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import catalogue from '@/config/vehicleCatalogue.json';

/** The game's own vehicles, parked. */
export const VEHICLE_MODEL = '/models/vehicles.glb';
useGLTF.preload(VEHICLE_MODEL, DRACO_PATH);

/** Where one car stands, in whatever local frame its group is drawn in. */
export interface CarSlot { across: number; along: number; turn: number }

interface CatalogueEntry {
  name: string;
  wheelRadius: number;
  hubs: number[][];
}
const VEHICLES = catalogue.vehicles as CatalogueEntry[];

/**
 * Cars standing still: the game's own vehicles, the ones `Traffic` drives,
 * parked.
 *
 * Shared, because two places want it — the town's car park and kerbs, and the
 * school's lot on Kestrel (`KestrelSchool`). It was the town's private
 * function; the only things that were ever town-specific about it were the
 * list of kinds and the height of the ground, so both are arguments now.
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
export function ParkedCars({ slots, kinds: wanted, y = 0 }: {
  slots: ReadonlyArray<CarSlot>;
  /** Catalogue names to draw from, in the order a fixed shuffle walks them. */
  kinds: readonly string[];
  /** Height of the surface they stand on, in the group's own frame. */
  y?: number;
}) {
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
    const kinds = wanted.filter((name) => byPart.has(`${name}|body`));
    if (!kinds.length) return [];
    const pick = slots.map((_, i) => kinds[(i * 7 + (i % 3) * 5) % kinds.length]);
    return kinds.map((name) => {
      const entry = VEHICLES.find((v) => v.name === name);
      const mine = slots.filter((_, i) => pick[i] === name);
      const body = byPart.get(`${name}|body`)?.[0];
      const wheel = byPart.get(`${name}|wheel`)?.[0];
      return { name, entry, mine, body, wheel };
    }).filter((b) => b.body && b.mine.length);
  }, [scene, slots, wanted]);

  return (
    <group>
      {batches.map((b) => (
        <CarBatch key={b.name} batch={b} y={y} />
      ))}
    </group>
  );
}

function CarBatch({ batch, y }: {
  batch: {
    entry?: CatalogueEntry;
    mine: ReadonlyArray<CarSlot>;
    body?: Mesh;
    wheel?: Mesh;
  };
  y: number;
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
      position.set(slot.across, y, slot.along);
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
  }, [batch, hubs, y]);

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
