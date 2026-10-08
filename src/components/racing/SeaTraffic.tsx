'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
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
import { NPC_BUDGET, seaLimit, seaShare } from '@/physics/npcBudget';
import type { VehicleTelemetry } from '@/types/vehicle';

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
 *
 * ## Small craft are traffic; ships are scenery
 *
 * The tugs, sailing boats, cruisers and yachts are no longer a fixed fleet
 * that exists everywhere at once. They are NPC traffic, the way the cars are:
 * a pool of `PER_HULL` of each hull, spawned onto a ring that passes within
 * `SPAWN_MAX` of the player — never closer than `SPAWN_MIN`, so nobody pops
 * up alongside — sailing it while they are near, and retired past
 * `DESPAWN`. How many may be out at once is the sea's part of the one NPC
 * budget the cars share (`npcBudget`); each ring still holds no more than its
 * own `count`. Out of range a boat is not drawn and costs nothing.
 *
 * The ferry, the harbour's cargo ship (and the cruise liners, in their own
 * components) stay scripted and always there: they are landmarks, seen from
 * kilometres away, and sized like buildings.
 */

/** Hulls that are traffic: pooled, spawned round the player. */
const SMALL_CRAFT = ['tug', 'sail', 'cruiser', 'yacht'];
/** Pool slots per small-craft hull. */
const PER_HULL = 3;
/** The spawn ring, metres from the player, and how far away a boat is retired. */
// 90, not more: the rings off Kestrel Beach run 40-150 m off the sand, and a
// minimum any larger would never let a boat appear on them while the player
// stands on the beach. A small craft popping in at 90 m goes unnoticed.
const SPAWN_MIN = 90;
const SPAWN_MAX = 600;
const DESPAWN = 750;
/** The first fill may put boats closer: there is nobody watching yet. */
const FIRST_MIN = 40;
/** Past this a boat over the cap may be retired: out of sight. */
const POLITE_RETIRE = 300;
/** Boats on the same ring keep at least this far apart along it, metres. */
const RING_GAP = 50;

const SMALL_ROUTES = SEA_ROUTES.filter((r) => SMALL_CRAFT.includes(r.boat));
const SCRIPTED_ROUTES = SEA_ROUTES.filter((r) => !SMALL_CRAFT.includes(r.boat));

/** One boat always on its route: the ferry. */
interface Ship {
  route: SeaRoute;
  /** Where it starts round the ring, radians. */
  phase: number;
  group: Group;
}

/** One pooled small craft. */
interface Craft {
  hull: string;
  group: Group;
  active: boolean;
  route: SeaRoute | null;
  /** Where it is round its ring, radians. */
  angle: number;
}

/** Where a pooled craft is, from its ring and angle. */
const boatX = (c: Craft) => (c.route ? c.route.centre[0] + Math.cos(c.angle) * c.route.radius : 0);
const boatZ = (c: Craft) => (c.route ? c.route.centre[1] + Math.sin(c.angle) * c.route.radius : 0);
function retire(c: Craft) {
  c.active = false;
  c.route = null;
  c.group.visible = false;
}

/** A ring's nearest approach to a point. */
const ringDistance = (r: SeaRoute, x: number, z: number) => Math.abs(Math.hypot(x - r.centre[0], z - r.centre[1]) - r.radius);


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

export function SeaTraffic({ telemetry }: { telemetry?: RefObject<VehicleTelemetry> }) {
  const { scene } = useGLTF(BOAT_MODEL, DRACO_PATH);

  /**
   * One group per boat, each holding a clone of its hull: the scripted ships,
   * and the small-craft pool — `PER_HULL` of each hull, hidden until spawned.
   *
   * Cloned rather than instanced: only the boats near the player are ever
   * drawn, a handful at a time, so instancing would save a few draw calls, and
   * a clone carries its own pitch and roll without a per-boat matrix rebuild.
   * A hidden clone is skipped by the renderer outright.
   */
  const { ships, crafts } = useMemo(() => {
    const source = new Map<string, Object3D<Object3DEventMap>[]>();
    (scene as unknown as Object3D).traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const owner = (child.userData as { boat?: string }).boat
        ?? (child.parent?.userData as { boat?: string } | undefined)?.boat;
      if (!owner) return;
      source.set(owner, [...(source.get(owner) ?? []), child]);
    });
    const hullGroup = (parts: Object3D[]) => {
      const group = new Group();
      for (const part of parts) {
        const clone = part.clone();
        clone.castShadow = true;
        clone.receiveShadow = true;
        group.add(clone);
      }
      return group;
    };

    const ships: Ship[] = [];
    for (const route of SCRIPTED_ROUTES) {
      const parts = source.get(route.boat);
      if (!parts?.length) continue;
      for (let i = 0; i < route.count; i++) {
        ships.push({ route, phase: (i / route.count) * Math.PI * 2, group: hullGroup(parts) });
      }
    }
    const crafts: Craft[] = [];
    for (let i = 0; i < PER_HULL; i++) {
      for (const hull of SMALL_CRAFT) {
        const parts = source.get(hull);
        if (!parts?.length) continue;
        const group = hullGroup(parts);
        group.visible = false;
        crafts.push({ hull, group, active: false, route: null, angle: 0 });
      }
    }
    return { ships, crafts };
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
    const missing = SEA_ROUTES.filter((r) => !ships.some((s) => s.route === r) && !crafts.some((c) => c.hull === r.boat));
    console.info(`[sea] ${ships.length} scripted ships, ${crafts.length} pooled small craft on ${SMALL_ROUTES.length} routes`
      + (missing.length ? ` — MISSING: ${missing.map((m) => m.boat).join(', ')}` : ''));
  }, [ships, crafts]);
  useEffect(() => () => { NPC_BUDGET.boats = 0; NPC_BUDGET.boatWant = 0; }, []);

  const euler = useRef(new Euler(0, 0, 0, 'YXZ'));
  const spawnClock = useRef(0);
  const firstFill = useRef(true);

  /** Retire, ask for, and spawn small craft round the player. Twice a second. */
  const manage = (px: number, pz: number) => {
    let live = 0;
    for (const c of crafts) {
      if (!c.active) continue;
      if (!c.route || Math.hypot(boatX(c) - px, boatZ(c) - pz) > DESPAWN) retire(c);
      else live++;
    }
    // What the sea would like: each ring in range brings its own count.
    let want = 0;
    for (const r of SMALL_ROUTES) if (ringDistance(r, px, pz) < SPAWN_MAX) want += r.count;
    NPC_BUDGET.boatWant = Math.min(want, seaShare());
    const cap = seaLimit();
    // Over the cap (the roads got busy, or the setting dropped): out of sight first.
    for (const c of crafts) {
      if (live <= cap) break;
      if (c.active && Math.hypot(boatX(c) - px, boatZ(c) - pz) > POLITE_RETIRE) { retire(c); live--; }
    }
    const near = firstFill.current ? FIRST_MIN : SPAWN_MIN;
    firstFill.current = false;
    for (const c of crafts) {
      if (live >= cap) break;
      if (c.active) continue;
      const routes = SMALL_ROUTES.filter((r) => r.boat === c.hull && ringDistance(r, px, pz) < SPAWN_MAX
        && crafts.filter((o) => o.active && o.route === r).length < r.count);
      if (!routes.length) continue;
      const route = routes[Math.floor(Math.random() * routes.length)];
      for (let attempt = 0; attempt < 8; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const x = route.centre[0] + Math.cos(angle) * route.radius;
        const z = route.centre[1] + Math.sin(angle) * route.radius;
        const d = Math.hypot(x - px, z - pz);
        if (d < near || d > SPAWN_MAX) continue;
        const crowded = crafts.some((o) => o.active && o.route === route
          && Math.abs(Math.atan2(Math.sin(o.angle - angle), Math.cos(o.angle - angle))) * route.radius < RING_GAP);
        if (crowded) continue;
        c.active = true;
        c.route = route;
        c.angle = angle;
        c.group.visible = true;
        live++;
        break;
      }
    }
    NPC_BUDGET.boats = live;
  };

  /** Pose a hull on the sea: heave, pitch and roll off the swell, heeled into its turn. */
  const ride = (group: Group, hullName: string, route: SeaRoute, angle: number, time: number) => {
    const hull = HULLS[hullName];
    const sense = route.clockwise ? 1 : -1;
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
    group.position.set(x, (bow + stern + port + starboard) / 4 + rideLift(hull), z);
    group.quaternion.setFromEuler(euler.current);
  };

  useFrame((state, rawDt) => {
    const time = state.clock.elapsedTime;
    const dt = Math.min(rawDt, 1 / 15);

    // The landmarks: on their rings by the clock, always there.
    for (const ship of ships) {
      // Angle round the ring: distance covered over the radius, which keeps
      // the SPEED honest — a big ring at the same angular rate would have the
      // ferry doing eighty knots.
      const sense = ship.route.clockwise ? 1 : -1;
      ride(ship.group, ship.route.boat, ship.route, ship.phase + sense * (time * ship.route.speed) / ship.route.radius, time);
    }

    // The small craft: managed round the player, sailed while they are out.
    const t = telemetry?.current;
    if (t) {
      spawnClock.current -= dt;
      if (spawnClock.current <= 0) {
        spawnClock.current = 0.5;
        manage(t.x, t.z);
      }
    }
    for (const c of crafts) {
      if (!c.active || !c.route) continue;
      c.angle += ((c.route.clockwise ? 1 : -1) * c.route.speed * dt) / c.route.radius;
      ride(c.group, c.hull, c.route, c.angle, time);
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

  if (!ships.length && !crafts.length && !harbour) return null;
  return (
    <group>
      {harbour && <primitive object={harbour.group} />}
      {ships.map((ship, i) => (
        <primitive key={i} object={ship.group} />
      ))}
      {crafts.map((c, i) => (
        <primitive key={`c${i}`} object={c.group} />
      ))}
    </group>
  );
}
