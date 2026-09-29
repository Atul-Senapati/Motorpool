'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Mesh, Object3D, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import catalogue from '@/config/vehicleCatalogue.json';
import { FLEET, SERVICE_ROUTES } from '@/config/airportConfig';

/**
 * The ground fleet, driving the airfield's service roads.
 *
 * Twenty-five vehicles on five closed loops: the stands, the hangar apron, the
 * freight yard, the landside strip and the outer road. `SERVICE_ROUTES` owns
 * where they go — and owns it as DATA, built and checked by
 * `scripts/prepare-service-routes.ts` against the buildings' real footprints
 * and the lines the aeroplanes taxi down — `FLEET` owns what goes where, and
 * this file is only the driving.
 *
 * The routes arrive as a point every five metres rather than as corners,
 * because the curve is computed and verified at build time. `buildTrack` below
 * resamples them again at two, which costs nothing and keeps the heading
 * steady through a turn.
 *
 * ## Why polylines and not physics
 *
 * These are scenery that moves. Giving them the traffic AI would mean giving
 * them a nav raster the island does not have, and giving them Rapier bodies
 * would mean ten more dynamic actors for something nobody can crash into on
 * purpose. A closed polyline walked at constant speed is what the boats do
 * and it is enough: the heading is the direction of travel, so a vehicle
 * turns its corners, and the corners are where the eye looks anyway.
 *
 * ## Two model conventions, and they disagree
 *
 * Everything out of `airport.glb` is prepared facing +Z — `prepare-airport`
 * turns the Scania a quarter to get it there — and a yaw of `atan2(dx, dz)`
 * aims +Z along travel, so those need nothing. The city's own `vehicles.glb`
 * faces −Z: `Traffic` drives those with a velocity of `(-sin h, -cos h)`.
 * Hence `spin`, and hence the fire engine not reversing round the apron.
 */

const AIRPORT_MODEL = '/models/airport.glb';
const CITY_VEHICLES = '/models/vehicles.glb';

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
  // Walk the polyline, dropping a sample every `step` metres.
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
  // Over a few samples, so a vehicle does not snap round a corner in one step.
  const a = at(i - 2);
  const b = at(i + 3);
  return { x, z, heading: Math.atan2(track.xs[b] - track.xs[a], track.zs[b] - track.zs[a]) };
}

/**
 * One vehicle, built out of whichever model it comes from.
 *
 * The city's vehicles are a body and ONE wheel placed at each of the
 * catalogue's four hubs — the same composition `Traffic` and `ParkedCars` do,
 * and the same reason: the model ships that way. The airport's own three are
 * whole models and are simply cloned.
 */
/**
 * Build one vehicle. Exported because the bridge drives the same fleet down
 * the deck and there is no reason for two copies of the array-not-mesh rule.
 */
export function buildVehicle(
  part: string,
  city: boolean | undefined,
  airport: Object3D,
  cityScene: Object3D,
): Object3D | null {
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

export function AirportTraffic() {
  const { scene: airport } = useGLTF(AIRPORT_MODEL, DRACO_PATH);
  const { scene: city } = useGLTF(CITY_VEHICLES, DRACO_PATH);

  const tracks = useMemo(() => new Map(
    SERVICE_ROUTES.map((r) => [r.name, buildTrack(r.points)] as const),
  ), []);

  const fleet = useMemo(() => FLEET.map((v, i) => {
    const track = tracks.get(v.route);
    const object = buildVehicle(v.part, v.city, airport, city);
    if (!track || !object) return null;
    return {
      key: `${v.part}-${i}`,
      object,
      track,
      speed: v.speed,
      spin: v.city ? Math.PI : 0,
      distance: v.at * track.total,
    };
  }).filter((v): v is NonNullable<typeof v> => v !== null), [airport, city, tracks]);

  const group = useRef<Group>(null);

  useEffect(() => {
    const missing = FLEET.length - fleet.length;
    const kinds = new Set(FLEET.map((v) => v.part)).size;
    console.info(`[traffic] ${fleet.length} airport service vehicles, ${kinds} kinds, `
      + `${SERVICE_ROUTES.length} routes`
      + (missing > 0 ? ` — ${missing} DID NOT RESOLVE` : ''));
    return () => {
      for (const v of fleet) v.object.traverse((child) => {
        if (child instanceof Mesh) child.geometry.dispose();
      });
    };
  }, [fleet]);

  useFrame((_, rawDelta) => {
    // Clamped like the airliner's: a tab returning from the background hands
    // us a multi-second delta, which would teleport a bus down the road.
    const dt = Math.min(rawDelta, 1 / 20);
    for (const v of fleet) {
      v.distance = (v.distance + v.speed * dt) % v.track.total;
      const at = sample(v.track, v.distance);
      v.object.position.set(at.x, 0, at.z);
      v.object.rotation.set(0, at.heading + v.spin, 0);
    }
  });

  return (
    <group ref={group}>
      {fleet.map((v) => <primitive key={v.key} object={v.object} />)}
    </group>
  );
}
