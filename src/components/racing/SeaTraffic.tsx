'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  BoxGeometry, BufferGeometry, Euler, Group, Mesh, MeshStandardMaterial, Object3D, type Object3DEventMap,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { BOAT_MODEL, HULLS, SEA_ROUTES, rideLift, type SeaRoute } from '@/config/boatConfig';
import { seaHeightAt } from '@/config/seaConfig';
import { HARBOUR_SHIP, harbourLive } from '@/config/harbourConfig';

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


/**
 * The harbour ship's timetable: alongside, ahead out to sea, lying off, and
 * astern back in — all on one straight line (`HARBOUR_SHIP`).
 *
 * Each run is a trapezoid of speed: gathering way at `accel`, holding its
 * speed, and losing it again to stop dead at the end. The heading never
 * changes: the bow points out to sea the whole time, and coming back in the
 * ship simply runs astern.
 */
function harbourTimetable() {
  const S = HARBOUR_SHIP;
  const [bx, bz] = S.berth;
  const [ox, oz] = S.out;
  const length = Math.hypot(ox - bx, oz - bz);
  const dx = (ox - bx) / length;
  const dz = (oz - bz) / length;
  const heading = Math.atan2(-dx, -dz);
  /** Distance covered `t` seconds into a run of `length` at top speed `v`, and the run's duration. */
  const run = (v: number) => {
    const ramp = Math.min(v / S.accel, Math.sqrt(length / S.accel));
    const top = S.accel * ramp;
    const cruise = (length - S.accel * ramp * ramp) / top;
    return {
      time: ramp * 2 + cruise,
      at: (t: number) => {
        if (t < ramp) return 0.5 * S.accel * t * t;
        if (t < ramp + cruise) return 0.5 * S.accel * ramp * ramp + top * (t - ramp);
        const r = Math.max(0, ramp * 2 + cruise - t);
        return length - 0.5 * S.accel * r * r;
      },
    };
  };
  const out = run(S.ahead);
  const back = run(S.astern);
  const cycle = S.dwell + out.time + S.lieOff + back.time;
  return {
    cycle,
    place(time: number): { x: number; z: number; heading: number; berthed: boolean } {
      let t = time % cycle;
      let s = 0;
      let berthed = false;
      if (t < S.dwell) berthed = true;
      else if ((t -= S.dwell) < out.time) s = out.at(t);
      else if ((t -= out.time) < S.lieOff) s = length;
      else s = length - back.at(t - S.lieOff);
      return { x: bx + dx * s, z: bz + dz * s, heading, berthed };
    },
  };
}

/** Container liveries for the deck cargo. */
const DECK_LIVERIES = ['#1f5f8b', '#b3372c', '#2f6b3a', '#d38a1c', '#6d6f73', '#e4e1d8'];

/**
 * A deck cargo of containers for the bulk carrier, which makes it the
 * container ship that calls at the harbour. In the hull's own frame (bow −z):
 * two rows each side outboard of the hatch coamings on the 6.37 m main deck,
 * and blocks on the hatch covers fore and aft where the ship's cranes and
 * their booms are not. Measured off the hull, not guessed.
 */
function deckCargo(): Group {
  const L = 12.19; const W = 2.44; const H = 2.59;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const lists: BufferGeometry[][] = DECK_LIVERIES.map(() => []);
  const put = (x: number, y: number, z: number) => {
    lists[Math.floor(rnd() * DECK_LIVERIES.length)].push(new BoxGeometry(W - 0.06, H - 0.04, L - 0.1).translate(x, y + H / 2, z));
  };
  for (const x of [-9.35, -6.9, 6.9, 9.35]) {
    for (let z = -50; z <= 40; z += 12.5) {
      const tiers = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < tiers; k++) put(x, 6.37 + k * H, z);
    }
  }
  for (const z of [-55, 36]) {
    for (const x of [-3.66, -1.22, 1.22, 3.66]) {
      const tiers = 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < tiers; k++) put(x, 7.47 + k * H, z);
    }
  }
  const group = new Group();
  lists.forEach((list, i) => {
    if (!list.length) return;
    const geometry = mergeGeometries(list, false);
    if (!geometry) return;
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: DECK_LIVERIES[i], roughness: 0.65, metalness: 0.25 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
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

  /** The harbour's own ship: the cargo hull with a deck cargo, on its loop. */
  const harbour = useMemo(() => {
    const parts: Object3D[] = [];
    (scene as unknown as Object3D).traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const owner = (child.userData as { boat?: string }).boat
        ?? (child.parent?.userData as { boat?: string } | undefined)?.boat;
      if (owner === HARBOUR_SHIP.hull) parts.push(child);
    });
    if (!parts.length) return null;
    const group = new Group();
    for (const part of parts) {
      const clone = part.clone();
      clone.castShadow = true;
      clone.receiveShadow = true;
      group.add(clone);
    }
    group.add(deckCargo());
    return { group, timetable: harbourTimetable() };
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

    if (harbour) {
      const hull = HULLS[HARBOUR_SHIP.hull];
      const { x, z, heading, berthed } = harbour.timetable.place(time);
      harbourLive.berthed = berthed;
      const forwardX = -Math.sin(heading);
      const forwardZ = -Math.cos(heading);
      const half = hull.size[2] / 2;
      const beam = hull.size[0] / 2;
      const bow = seaHeightAt(x + forwardX * half, z + forwardZ * half, time);
      const stern = seaHeightAt(x - forwardX * half, z - forwardZ * half, time);
      const port = seaHeightAt(x + forwardZ * beam, z - forwardX * beam, time);
      const starboard = seaHeightAt(x - forwardZ * beam, z + forwardX * beam, time);
      euler.current.set(-Math.atan2(bow - stern, hull.size[2]), heading, Math.atan2(starboard - port, hull.size[0]));
      harbour.group.position.set(x, (bow + stern + port + starboard) / 4 + rideLift(hull), z);
      harbour.group.quaternion.setFromEuler(euler.current);
    }
  });

  if (!ships.length && !harbour) return null;
  return (
    <group>
      {harbour && <primitive object={harbour.group} />}
      {ships.map((ship, i) => (
        <primitive key={i} object={ship.group} />
      ))}
    </group>
  );
}
