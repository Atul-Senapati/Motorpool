'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { Box3, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import catalogue from '@/config/vehicleCatalogue.json';
import { FLEET, SERVICE_ROUTES, SITE } from '@/config/airportConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { crossingHeightAt } from '@/config/yardCrossing';
import { AIRPORT_MAX, NPC_BUDGET, airportLimit } from '@/physics/npcBudget';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * The ground fleet, driving the airfield's service roads — as NPC traffic.
 *
 * `SERVICE_ROUTES` owns where they go — DATA, built and checked by
 * `scripts/prepare-service-routes.ts` against the buildings' real footprints
 * and the lines the aeroplanes taxi down — `FLEET` owns what goes where, and
 * this file is the driving.
 *
 * ## The road traffic's rules, on the airfield
 *
 * The same bargain as the cars, the boats and the beach riders (`npcBudget`):
 *
 *  - **Only round the player.** A vehicle is live — drawn, solid, driving with
 *    its wits about it — only within `RANGE` of the player, and never more
 *    than `AIRPORT_MAX` of them, nearest first; the rest keep lapping their
 *    loops undrawn, so when one comes into range it is where it would be.
 *  - **One shared cap.** It asks for what is in range (`airportWant`) and
 *    lives in whatever the road cars leave (`airportLimit`), so the world's
 *    moving-thing count is the same here as in town.
 *  - **Not at your bumper.** Nothing comes alive within `SPAWN_MIN` of the
 *    player once the first fill is done.
 *  - **Solid, and careful.** Each live vehicle is a kinematic body the size of
 *    its model — a car that hits one stops — and it brakes for what is in
 *    front of it: another vehicle going its way, and the player, for whom it
 *    stops dead. Crossing traffic gives way by a fixed priority, so two at a
 *    junction never both wait.
 *
 * Every Rapier write is in the before-step, as `Traffic`'s are.
 *
 * ## Three model conventions
 *
 * `airport.glb` and `trucks.glb` face +Z — a yaw of `atan2(dx, dz)` aims them
 * along travel. The city's own `vehicles.glb` faces −Z, hence `spin`.
 */

const AIRPORT_MODEL = '/models/airport.glb';
const CITY_VEHICLES = '/models/vehicles.glb';
const TRUCKS_MODEL = '/models/trucks.glb';

/** Live within this of the player, metres; retired past `DESPAWN`. */
const RANGE = 220;
const DESPAWN = 260;
/** Nothing comes alive closer than this once the first fill is done. */
const SPAWN_MIN = 35;
/** Braking and pulling away, m/s². */
const BRAKE = 6;
const ACCEL = 2;
/** Gap kept to whatever is ahead, past both their half-lengths. */
const GAP = 5;
/** Stopping distance for the player, past the vehicle's own nose. */
const PLAYER_STOP = 7;

interface CatalogueEntry {
  name: string;
  hubs: number[][];
}
const VEHICLES = catalogue.vehicles as CatalogueEntry[];

/** A route resampled into a table of points and the total length. */
interface Track {
  xs: Float64Array;
  zs: Float64Array;
  step: number;
  count: number;
  total: number;
}

const STEP = 2;

function buildTrack(points: ReadonlyArray<readonly [number, number]>): Track {
  const legs: Array<{ x: number; z: number }> = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const count = Math.max(8, Math.round(total / STEP));
  const step = total / count;
  let leg = 0;
  let along = 0;
  for (let i = 0; i < count; i++) {
    const want = i * step;
    for (;;) {
      const a = points[leg % points.length];
      const b = points[(leg + 1) % points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (along + len >= want || leg >= points.length) {
        const t = len ? (want - along) / len : 0;
        legs.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t });
        break;
      }
      along += len;
      leg++;
    }
  }
  return {
    xs: Float64Array.from(legs, (p) => p.x),
    zs: Float64Array.from(legs, (p) => p.z),
    step,
    count,
    total,
  };
}

/** Where a track is `d` metres in, and which way it is going there. */
function sample(track: Track, d: number) {
  const s = ((d % track.total) + track.total) % track.total;
  const i = Math.floor(s / track.step);
  const t = s / track.step - i;
  const at = (k: number) => ((k % track.count) + track.count) % track.count;
  const i0 = at(i);
  const i1 = at(i + 1);
  const x = track.xs[i0] + (track.xs[i1] - track.xs[i0]) * t;
  const z = track.zs[i0] + (track.zs[i1] - track.zs[i0]) * t;
  const a = at(i - 2);
  const b = at(i + 3);
  return { x, z, heading: Math.atan2(track.xs[b] - track.xs[a], track.zs[b] - track.zs[a]) };
}

/**
 * Build one vehicle. Exported because the parking lots place the same city
 * cars and there is no reason for two copies of the array-not-mesh rule.
 */
export function buildVehicle(
  part: string,
  city: boolean | undefined,
  airport: Object3D,
  cityScene: Object3D,
  trucks?: Object3D,
  truck?: boolean,
): Object3D | null {
  if (truck) {
    const node = trucks?.getObjectByName(part);
    if (!node) return null;
    const copy = node.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    const holder = new Object3D();
    holder.add(copy);
    return holder;
  }
  if (!city) {
    const mesh = airport.getObjectByName(part);
    if (!mesh) return null;
    const copy = mesh.clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    return copy;
  }
  // ARRAYS, not one mesh each. The loader splits a multi-primitive mesh into
  // one child Mesh per material and tags them all the same, and every one of
  // these vehicles has a four- or five-primitive body: paint, glass, decals,
  // lights. Keeping a single mesh per part kept whichever happened to come
  // last — the fire engine drove round the apron as four wheels and its
  // indicator lenses.
  const byPart = new Map<string, Mesh[]>();
  cityScene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const tag = o.userData as { vehicle?: string; part?: string };
    if (tag.vehicle !== part || !tag.part) return;
    byPart.set(tag.part, [...(byPart.get(tag.part) ?? []), o]);
  });
  const body = byPart.get('body') ?? [];
  if (!body.length) return null;
  const group = new Object3D();
  for (const piece of body) {
    const shell = piece.clone(true);
    shell.castShadow = true;
    group.add(shell);
  }
  const wheel = byPart.get('wheel') ?? [];
  const hubs = VEHICLES.find((v) => v.name === part)?.hubs ?? [];
  for (const h of hubs) {
    for (const piece of wheel) {
      const w = piece.clone(true);
      w.position.set(h[0], h[1], h[2]);
      w.castShadow = true;
      group.add(w);
    }
  }
  return group;
}

interface Unit {
  key: string;
  object: Object3D;
  track: Track;
  route: string;
  cruise: number;
  speed: number;
  spin: number;
  distance: number;
  active: boolean;
  /** The model's footprint in its own frame: half sizes and the box centre. */
  half: [number, number, number];
  centre: [number, number, number];
  /** Island-frame pose, written in the step and drawn in the frame. */
  x: number;
  z: number;
  heading: number;
}

/** World XZ of an island point, and the island's own yaw. */
const COS = Math.cos(SITE.heading);
const SIN = Math.sin(SITE.heading);
const toWorld = (x: number, z: number): [number, number] => [SITE.centre[0] + x * COS + z * SIN, SITE.centre[1] - x * SIN + z * COS];
const toIsland = (wx: number, wz: number): [number, number] => {
  const dx = wx - SITE.centre[0];
  const dz = wz - SITE.centre[1];
  return [dx * COS - dz * SIN, dx * SIN + dz * COS];
};

export function AirportTraffic({ telemetry }: { telemetry?: RefObject<VehicleTelemetry> }) {
  const { scene: airport } = useGLTF(AIRPORT_MODEL, DRACO_PATH);
  const { scene: city } = useGLTF(CITY_VEHICLES, DRACO_PATH);
  const { scene: trucks } = useGLTF(TRUCKS_MODEL, DRACO_PATH);

  const tracks = useMemo(() => new Map(
    SERVICE_ROUTES.map((r) => [r.name, buildTrack(r.points)] as const),
  ), []);

  const fleet = useMemo<Unit[]>(() => FLEET.map((v, i): Unit | null => {
    const track = tracks.get(v.route);
    const object = buildVehicle(v.part, v.city, airport, city, trucks, v.truck);
    if (!track || !object) return null;
    const spin = v.city ? Math.PI : 0;
    // The footprint, measured off the model as it will be drawn (spun).
    object.rotation.set(0, spin, 0);
    object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(object);
    object.rotation.set(0, 0, 0);
    const size = box.getSize(new Vector3());
    const mid = box.getCenter(new Vector3());
    object.visible = false;
    const at = sample(track, v.at * track.total);
    return {
      key: `${v.part}-${i}`, object, track, route: v.route, cruise: v.speed, speed: v.speed, spin,
      distance: v.at * track.total, active: false,
      half: [Math.max(0.5, size.x / 2), Math.max(0.5, size.y / 2), Math.max(0.5, size.z / 2)],
      centre: [mid.x, mid.y, mid.z],
      x: at.x, z: at.z, heading: at.heading,
    };
  }).filter((v): v is Unit => v !== null), [airport, city, trucks, tracks]);

  useEffect(() => {
    const missing = FLEET.length - fleet.length;
    const kinds = new Set(FLEET.map((v) => v.part)).size;
    console.info(`[traffic] ${fleet.length} airport service vehicles, ${kinds} kinds, `
      + `${SERVICE_ROUTES.length} routes, at most ${AIRPORT_MAX} live round the player`
      + (missing > 0 ? ` — ${missing} DID NOT RESOLVE` : ''));
    return () => {
      NPC_BUDGET.airport = 0;
      NPC_BUDGET.airportWant = 0;
      for (const v of fleet) v.object.traverse((child) => {
        if (child instanceof Mesh) child.geometry.dispose();
      });
    };
  }, [fleet]);

  const bodies = useRef<Array<RapierRigidBody | null>>([]);
  const clock = useRef(0);
  const firstFill = useRef(true);
  const scratch = useMemo(() => ({ q: new Quaternion(), v: new Vector3(0, 1, 0) }), []);

  /** Retire, ask for and bring alive the vehicles round the player. */
  const manage = (px: number, pz: number) => {
    const near = fleet
      .map((u) => ({ u, d: Math.hypot(u.x - px, u.z - pz) }))
      .filter((e) => e.d < RANGE)
      .sort((a, b) => a.d - b.d);
    NPC_BUDGET.airportWant = NPC_BUDGET.total > 0 ? Math.min(AIRPORT_MAX, near.length) : 0;
    const cap = Math.min(AIRPORT_MAX, airportLimit());
    let live = 0;
    // Retire the far ones, and any past the cap — furthest first.
    const byFar = fleet.filter((u) => u.active)
      .sort((a, b) => Math.hypot(b.x - px, b.z - pz) - Math.hypot(a.x - px, a.z - pz));
    const keep = byFar.length - cap;
    byFar.forEach((u, i) => {
      if (Math.hypot(u.x - px, u.z - pz) > DESPAWN || i < keep || NPC_BUDGET.airportWant === 0) {
        u.active = false;
        u.object.visible = false;
      } else live++;
    });
    const min = firstFill.current ? 0 : SPAWN_MIN;
    for (const { u, d } of near) {
      if (live >= cap) break;
      if (u.active || d < min) continue;
      u.active = true;
      u.object.visible = true;
      u.speed = u.cruise * 0.5;
      live++;
    }
    if (live > 0) firstFill.current = false;
    NPC_BUDGET.airport = live;
  };

  useBeforePhysicsStep(() => {
    const dt = PHYSICS_TIMESTEP;
    const t = telemetry?.current;
    const player = t ? toIsland(t.x, t.z) : null;
    if (player) {
      clock.current -= dt;
      if (clock.current <= 0) {
        clock.current = 0.5;
        manage(player[0], player[1]);
      }
    }
    fleet.forEach((u, i) => {
      const body = bodies.current[i];
      if (!u.active) {
        // Undrawn: lap the loop at its own pace, so it is somewhere sensible
        // when it comes into range — and park the body out of the world.
        u.distance = (u.distance + u.cruise * dt) % u.track.total;
        const at = sample(u.track, u.distance);
        u.x = at.x; u.z = at.z; u.heading = at.heading;
        body?.setNextKinematicTranslation({ x: 0, y: -500 - i * 4, z: 0 });
        return;
      }
      const fx = Math.sin(u.heading);
      const fz = Math.cos(u.heading);
      let target = u.cruise;
      // Whatever is in front: a vehicle going this way, or one crossing that
      // this one gives way to by priority (the lower index goes first).
      fleet.forEach((o, j) => {
        if (o === u || !o.active) return;
        const dx = o.x - u.x;
        const dz = o.z - u.z;
        const ahead = dx * fx + dz * fz;
        if (ahead <= 0) return;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (lateral > u.half[0] + o.half[0] + 1.5) return;
        const sameWay = Math.sin(o.heading) * fx + Math.cos(o.heading) * fz > 0.3;
        if (!sameWay && j > i) return;
        const room = ahead - u.half[2] - o.half[2] - GAP;
        target = Math.min(target, Math.max(0, room * 0.8));
      });
      // The player, close in front and on the ground (not flying over): stop for them.
      if (player && t && t.y - SITE.ground < 4) {
        const dx = player[0] - u.x;
        const dz = player[1] - u.z;
        const ahead = dx * fx + dz * fz;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && lateral < u.half[0] + 2.5) {
          target = Math.min(target, Math.max(0, (ahead - u.half[2] - PLAYER_STOP) * 0.9));
        }
      }
      u.speed += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - u.speed));
      u.distance = (u.distance + Math.max(0, u.speed) * dt) % u.track.total;
      const at = sample(u.track, u.distance);
      u.x = at.x; u.z = at.z; u.heading = at.heading;

      // The body, in the world: the island point turned onto the world, the
      // footprint's own centre turned with the vehicle. The footprint was
      // measured with the spin already on, so it turns by the heading alone.
      const yaw = at.heading;
      const cx = u.centre[0] * Math.cos(yaw) + u.centre[2] * Math.sin(yaw);
      const cz = -u.centre[0] * Math.sin(yaw) + u.centre[2] * Math.cos(yaw);
      const [wx, wz] = toWorld(at.x + cx, at.z + cz);
      const y = SITE.ground + crossingHeightAt(at.x, at.z) + u.centre[1];
      body?.setNextKinematicTranslation({ x: wx, y, z: wz });
      body?.setNextKinematicRotation(scratch.q.setFromAxisAngle(scratch.v, yaw + SITE.heading));
    });
  });

  useFrame(() => {
    for (const u of fleet) {
      if (!u.active) continue;
      // Up and over the freight yard's level crossing; flat ground everywhere else.
      u.object.position.set(u.x, crossingHeightAt(u.x, u.z), u.z);
      u.object.rotation.set(0, u.heading + u.spin, 0);
    }
  });

  return (
    <group>
      {fleet.map((u) => <primitive key={u.key} object={u.object} />)}
      {fleet.map((u, i) => (
        <RigidBody
          key={`body-${u.key}`}
          ref={(b) => { bodies.current[i] = b; }}
          type="kinematicPosition"
          colliders={false}
          position={[0, -500 - i * 4, 0]}
        >
          <CuboidCollider args={u.half} />
        </RigidBody>
      ))}
    </group>
  );
}
