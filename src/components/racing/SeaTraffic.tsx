'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Euler, Group, Mesh, Object3D, type Object3DEventMap } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { BOAT_MODEL, HULLS, SEA_ROUTES, rideLift, type SeaRoute } from '@/config/boatConfig';
import { seaHeightAt } from '@/config/seaConfig';

useGLTF.preload(BOAT_MODEL, DRACO_PATH);

/**
 * Shipping.
 *
 * Three quarters of this world is water and until now nothing crossed it. A
 * bay with a ferry standing out of it, a tug working the roads and a couple
 * of yachts in the channel is a different place from the same bay empty —
 * and the difference costs one draw call per hull and no thought at all,
 * because none of these boats is driven.
 *
 * ## Scripted, and unapologetically so
 *
 * `SEA_ROUTES` is a handful of rings. A boat's position is its angle round
 * one; its heading is the tangent. That is the whole navigation, and the
 * reason it is enough is the reason the trams are scripted too: nobody is
 * ever going to inspect a ship's pilotage from a mile away, and what they
 * WILL notice is a ferry driving through a headland — which a ring measured
 * against the land cannot do (see the clearances in `SEA_ROUTES`).
 *
 * ## They ride the same sea the player does
 *
 * Height, pitch and roll come from `seaHeightAt`, sampled at each hull's own
 * bow, stern and beams, exactly as `BoatRide` does it. So a ferry a kilometre
 * out is on the same swell as the yacht you are driving, and when the two
 * pass they move together instead of one of them ignoring the water. It is
 * the cheapest possible way to buy that: four sine sums per boat per frame.
 *
 * What they do NOT have is inertia — no heave spring, no second-order roll.
 * A scripted boat that lags the wave gains nothing at this distance, and the
 * one thing it would cost is the guarantee that a hull never dips through its
 * own waterline where you can see it.
 */

/** One boat on a route. */
interface Ship {
  route: SeaRoute;
  /** Where it starts round the ring, radians. */
  phase: number;
  group: Group;
}

export function SeaTraffic() {
  const { scene } = useGLTF(BOAT_MODEL, DRACO_PATH);

  /**
   * One group per boat, each holding a clone of its hull.
   *
   * Cloned rather than instanced: there are nine boats in five kinds, so
   * instancing would save at most four draw calls, and a clone can carry its
   * own pitch and roll — which an `InstancedMesh` can too, but only through a
   * matrix rebuild per boat per frame, which is the same work in a less
   * readable place.
   */
  const ships = useMemo(() => {
    const source = new Map<string, Object3D<Object3DEventMap>[]>();
    (scene as unknown as Object3D).traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const owner = (child.userData as { boat?: string }).boat
        ?? (child.parent?.userData as { boat?: string } | undefined)?.boat;
      if (!owner) return;
      source.set(owner, [...(source.get(owner) ?? []), child]);
    });

    const out: Ship[] = [];
    for (const route of SEA_ROUTES) {
      const parts = source.get(route.boat);
      if (!parts?.length) continue;
      for (let i = 0; i < route.count; i++) {
        const group = new Group();
        for (const part of parts) {
          const clone = part.clone();
          clone.castShadow = true;
          clone.receiveShadow = true;
          group.add(clone);
        }
        out.push({ route, phase: (i / route.count) * Math.PI * 2, group });
      }
    }
    return out;
  }, [scene]);

  // The same one-line inventory `Traffic` prints, and for the same reason: a
  // hull whose name has drifted out of the fleet file fails silently, as
  // nothing on an empty sea.
  useEffect(() => {
    const missing = SEA_ROUTES.filter((r) => !ships.some((s) => s.route === r));
    console.info(`[sea] ${ships.length} boats on ${SEA_ROUTES.length} routes`
      + (missing.length ? ` — MISSING: ${missing.map((m) => m.boat).join(', ')}` : ''));
  }, [ships]);

  const euler = useRef(new Euler(0, 0, 0, 'YXZ'));

  useFrame((state) => {
    const time = state.clock.elapsedTime;
    for (const ship of ships) {
      const { route } = ship;
      const hull = HULLS[route.boat];
      // Angle round the ring: distance covered over the radius, which keeps
      // the SPEED honest — a big ring at the same angular rate would have the
      // ferry doing eighty knots.
      const sense = route.clockwise ? 1 : -1;
      const angle = ship.phase + sense * (time * route.speed) / route.radius;
      const x = route.centre[0] + Math.cos(angle) * route.radius;
      const z = route.centre[1] + Math.sin(angle) * route.radius;
      // The tangent, which is where the bow points.
      const heading = Math.atan2(
        -(-Math.sin(angle) * sense),
        -(Math.cos(angle) * sense),
      );

      const forwardX = -Math.sin(heading);
      const forwardZ = -Math.cos(heading);
      const rightX = -forwardZ;
      const rightZ = forwardX;
      const half = hull.size[2] / 2;
      const beam = hull.size[0] / 2;
      const bow = seaHeightAt(x + forwardX * half, z + forwardZ * half, time);
      const stern = seaHeightAt(x - forwardX * half, z - forwardZ * half, time);
      const port = seaHeightAt(x - rightX * beam, z - rightZ * beam, time);
      const starboard = seaHeightAt(x + rightX * beam, z + rightZ * beam, time);

      // Heel into the turn, as `BoatRide` does — a boat on a ring is always
      // turning, and a ship dead upright through a bend is the tell.
      const heel = (hull.size[2] > 100 ? 0.01 : 0.05) * sense;
      euler.current.set(
        -Math.atan2(bow - stern, hull.size[2]),
        heading,
        Math.atan2(starboard - port, hull.size[0]) + heel,
      );
      // Lifted the same way the driven boat is, so the fleet floats like it —
      // see `HYDRO.freeboard`.
      ship.group.position.set(x, (bow + stern + port + starboard) / 4 + rideLift(hull), z);
      ship.group.quaternion.setFromEuler(euler.current);
    }
  });

  if (!ships.length) return null;
  return (
    <group>
      {ships.map((ship, i) => (
        <primitive key={i} object={ship.group} />
      ))}
    </group>
  );
}
