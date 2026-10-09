'use client';

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CuboidCollider, RigidBody, interactionGroups, useBeforePhysicsStep,
  type ContactForcePayload, type RapierRigidBody,
} from '@react-three/rapier';
import {
  Color, DynamicDrawUsage, Euler, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh,
  Quaternion, Source, Vector3, type BufferGeometry, type Material, type MeshStandardMaterial, type Object3D,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { RACE, TRAFFIC } from '@/config/trafficConfig';
import catalogue from '@/config/vehicleCatalogue.json';
import bikerData from '@/config/bikerData.json';
import countryModels from '@/config/countryModelData.json';
import { COUNTRY_ENABLED } from '@/config/countryConfig';
import { AIRPORT_ENABLED } from '@/config/airportConfig';
import airportModels from '@/config/airportModelData.json';
import truckData from '@/config/truckData.json';
import farmsetData from '@/config/farmsetData.json';
import { ANY_REGION, REGION, createTraffic, updateTraffic, type TrafficKind } from '@/physics/trafficAI';
import { NPC_BUDGET, NPC_TOTAL, roadLimit } from '@/physics/npcBudget';
import { BRAKE_COLOUR, brakeLampMaterial, rampBrake, rearLampGeometry } from './brakeLamps';
import type { VehicleTelemetry } from '@/types/vehicle';

const MODEL = '/models/vehicles.glb';
/** The Wall of Death's two riders (`prepare-bikers.mjs`), who also ride the roads. */
const BIKERS_MODEL = '/models/bikers.glb';
useGLTF.preload(MODEL, DRACO_PATH);
useGLTF.preload(BIKERS_MODEL, DRACO_PATH);

interface CatalogueEntry {
  name: string;
  label: string;
  kind: string;
  size: number[];
  wheelMesh: string | null;
  wheelRadius: number;
  hubs: number[][];
}

/**
 * Every type the traffic drives: the city's twenty from the catalogue, then
 * the two bikers — one of each, from `bikers.glb`, drawn and driven exactly
 * like a car (a body batch and a wheel batch, forward −Z, origin at the tyre
 * contact) except that they lean into their turns and weigh what a bike does.
 */
const BIKERS = (['male', 'female'] as const).map((who): CatalogueEntry => ({
  name: who,
  label: `${who} biker`,
  kind: 'bike',
  size: bikerData[who].size,
  wheelMesh: 'wheel',
  wheelRadius: bikerData[who].wheelRadius,
  hubs: [bikerData[who].wheels.front, bikerData[who].wheels.rear],
}));
/**
 * Kit vehicles: whole models out of the islands' own files rather than the
 * city's catalogue, each one baked mesh with its wheels in it (a body batch,
 * no wheel batch) — bar the farm set, whose wheels are nodes of their own and
 * spin — and each with its own top speed in m/s.
 *
 * - **Skylark** gets its working vehicles, the ones parked in its yards and on
 *   its verges (`countryConfig.PARKED`): tractors, combines, lorries.
 * - **Halcyon**, the airport island, gets heavy, airport and courier traffic:
 *   the city's box truck and artic and the Skylark lorries (freight for the
 *   cargo terminal and the harbour), the apron bus as the terminal shuttle,
 *   the catering high-loader and a pushback tug from the airport's own set,
 *   and — from the city's catalogue, below — the post vans of the parcel hub.
 *   No saloons or hatchbacks: those read as town.
 *
 * `turn` is for models that face +Z (`trucks.glb`, and `prepare-airport`
 * turns everything nose to +Z); traffic drives nose to −Z.
 */
interface KitType {
  model: 'country' | 'trucks' | 'airport' | 'farmset';
  part: string;
  count: number;
  top: number;
  regions: number;
  turn?: boolean;
}
const KIT_MODELS = {
  country: '/models/country.glb',
  trucks: '/models/trucks.glb',
  airport: '/models/airport.glb',
  farmset: '/models/country/farmset.glb',
} as const;
const KIT_SIZES: Record<KitType['model'], Record<string, { size: number[] }>> = {
  country: countryModels.parts as Record<string, { size: number[] }>,
  trucks: truckData as Record<string, { size: number[] }>,
  airport: airportModels.parts as Record<string, { size: number[] }>,
  farmset: farmsetData.parts as Record<string, { size: number[] }>,
};
/** Tractors and combines: Skylark's lanes and its farm roads. */
const FARM_MACHINE = REGION.country | REGION.farm;
const KIT_TYPES: readonly KitType[] = [
  ...(COUNTRY_ENABLED ? [
    // No orange pickup (the user threw it out), and the country kit's own
    // tractor and combine only stand parked: they are one baked mesh each,
    // wheels and all, so their wheels could not turn. The farm machines that
    // drive are the farm set's, whose wheels spin. They also work the
    // single-track farm roads (`FARM_MINIS`), which nothing else turns down.
    { model: 'country', part: 'artic', count: 1, top: 11, regions: REGION.country },
    // The user's farm set (`prepare-farmset.mjs`), baked facing −Z like the
    // rest: three MTZ-80s and a compact tractor at a tractor's pace, three
    // GAZ-52 trucks, and two Niva combines crawling between fields.
    { model: 'farmset', part: 'mtz80', count: 3, top: 7, regions: FARM_MACHINE },
    { model: 'farmset', part: 'tractorSmall', count: 1, top: 6, regions: FARM_MACHINE },
    { model: 'farmset', part: 'gaz52', count: 3, top: 13, regions: REGION.country },
    { model: 'farmset', part: 'niva', count: 2, top: 5, regions: FARM_MACHINE },
  ] as KitType[] : []),
  // Lorries both islands use: one set of slots, spawned wherever the player is.
  // The old chrome tractor unit stays on Skylark — the user did not want it at the airport.
  { model: 'country', part: 'lorryCab', count: 1, top: 13, regions: REGION.country },
  ...(AIRPORT_ENABLED ? [
    { model: 'trucks', part: 'boxTruck', count: 3, top: 14, regions: REGION.halcyon, turn: true },
    { model: 'trucks', part: 'artic', count: 2, top: 12, regions: REGION.halcyon, turn: true },
    { model: 'airport', part: 'bus', count: 2, top: 12, regions: REGION.halcyon, turn: true },
    { model: 'airport', part: 'cateringTruck', count: 1, top: 10, regions: REGION.halcyon, turn: true },
    { model: 'airport', part: 'pushback', count: 1, top: 7, regions: REGION.halcyon, turn: true },
    // The little open parcel carts the courier hub has parked in a row.
    { model: 'airport', part: 'cart', count: 2, top: 4.5, regions: REGION.halcyon, turn: true },
  ] as KitType[] : []),
];
const kitName = (k: KitType) => `${k.model}:${k.part}`;
const KIT: CatalogueEntry[] = KIT_TYPES.map((k) => ({
  name: kitName(k),
  label: k.part,
  kind: 'kit',
  size: KIT_SIZES[k.model][k.part]?.size ?? [2.4, 2.5, 6],
  wheelMesh: null,
  wheelRadius: 0.5,
  hubs: [],
}));
const kitOf = (name: string) => KIT_TYPES.find((k) => kitName(k) === name)!;
/**
 * The racers on Petrel's circuit: the pack's one red car — the sports car,
 * `Sport_body` — cloned five times, one car in each colour: its own red and
 * four repaints. The paint is baked at load from the body's texture (`repaint`):
 * its red turned to the colour's hue — or, for white, its colour taken out
 * and its lightness lifted — with the shading and the black trim kept.
 */
const RACE_CAR = 'Sport_body';
/** A repaint: the hue (degrees), how much of the red's saturation to keep, and the lightness as `l * light + lift`. */
interface Paint { hue: number; sat?: number; light?: number; lift?: number }
const RACERS: Array<{ colour: string; paint: Paint | null }> = [
  { colour: 'red', paint: null },
  { colour: 'blue', paint: { hue: 215 } },
  { colour: 'yellow', paint: { hue: 50, light: 1.05 } },
  { colour: 'green', paint: { hue: 135, light: 0.85 } },
  { colour: 'white', paint: { hue: 0, sat: 0, light: 1.1, lift: 0.33 } },
];
const raceOf = (name: string) => RACERS.find((r) => `race:${r.colour}` === name)!;
const RACE_TYPES: CatalogueEntry[] = RACERS.map((r) => ({
  ...(catalogue.vehicles as CatalogueEntry[]).find((v) => v.name === RACE_CAR)!,
  name: `race:${r.colour}`,
  label: `${r.colour} racer`,
  kind: 'race',
}));
const VEHICLES: CatalogueEntry[] = [...(catalogue.vehicles as CatalogueEntry[]), ...BIKERS, ...KIT, ...RACE_TYPES];
/** Slots per type: `TRAFFIC.perType` cars of each kind, one of each biker and racer, the kit's own counts. */
const COUNTS = VEHICLES.map((v) => (v.kind === 'bike' || v.kind === 'race' ? 1
  : v.kind === 'kit' ? kitOf(v.name).count : TRAFFIC.perType));
/**
 * The city's types that also drive Halcyon: the parcel hub's post vans, the
 * orange road-service truck, the bus, ambulances, and a few cars — saloons,
 * hatchbacks and taxis for the terminal. Not the rest of the town's cars.
 */
const HALCYON_TYPES = new Set([
  'postvan', 'rdservtruck', 'citybus', 'ambulance', 'Sedan_Body', 'Hatchback_Body', 'taxi',
]);
/** Where each type drives (`REGION` bits): bikes anywhere, kit vehicles where listed, the rest in town. */
const KINDS: TrafficKind[] = VEHICLES.map((v) => (v.kind === 'bike' ? { regions: ANY_REGION }
  : v.kind === 'race' ? { regions: REGION.circuit, top: RACE.top, race: true }
  : v.kind === 'kit' ? { regions: kitOf(v.name).regions, top: kitOf(v.name).top }
    : { regions: REGION.town | (HALCYON_TYPES.has(v.name) ? REGION.halcyon : 0) }));
const isBike = (type: number) => VEHICLES[type]?.kind === 'bike';

/**
 * A copy of a car's paint in another colour: every strongly red pixel of its
 * texture turned to the paint's hue, its saturation and lightness carried
 * over (scaled as the paint says) — so the baked shading comes across — and
 * everything else (black trim, grey vents) left alone. On a canvas, once, at load.
 */
function repaint(material: MeshStandardMaterial, paint: Paint): MeshStandardMaterial {
  const out = material.clone();
  const map = material.map;
  const image = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!map || !image?.width) return out;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return out;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  const h = paint.hue / 360;
  const keepSat = paint.sat ?? 1;
  const light = paint.light ?? 1;
  const lift = paint.lift ?? 0;
  const channel = (p: number, q: number, t: number) => {
    const k = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (k < 1 / 6) return p + (q - p) * 6 * k;
    if (k < 1 / 2) return q;
    if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
    return p;
  };
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const c = max - min;
    if (c < 0.12 || max !== r) continue; // not red: grey, black, or another colour
    const s0 = c / (1 - Math.abs(2 * l - 1) || 1);
    if (s0 < 0.35) continue;
    const sat = s0 * keepSat;
    const l2 = Math.min(0.95, l * light + lift);
    const q = l2 < 0.5 ? l2 * (1 + sat) : l2 + sat - l2 * sat;
    const p = 2 * l2 - q;
    d[i] = Math.round(channel(p, q, h + 1 / 3) * 255);
    d[i + 1] = Math.round(channel(p, q, h) * 255);
    d[i + 2] = Math.round(channel(p, q, h - 1 / 3) * 255);
  }
  ctx.putImageData(pixels, 0, 0);
  // A clone shares its source with the original; this one needs its own.
  const texture = map.clone();
  texture.source = new Source(canvas);
  texture.needsUpdate = true;
  out.map = texture;
  return out;
}
/** The steepest a biker leans into a turn, radians. */
const MAX_LEAN = 0.6;

/** One instanced draw per (vehicle, primitive). */
interface Batch {
  mesh: InstancedMesh;
  /** Which vehicle type this batch draws. */
  type: number;
  /** Hub offsets when this batch is a wheel, empty for a body. */
  hubs: number[][];
  wheelRadius: number;
  /**
   * A brake-light overlay rather than part of the car.
   *
   * It is drawn at the car's own transform like any body batch, but its
   * instance COLOUR carries the lamp: black while the car is rolling, red
   * while the driver is on the brakes. See `brakeLamps`.
   */
  lamp?: boolean;
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
/** A bike and its rider. */
const BIKE_MASS = 260;

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
  const { scene: bikers } = useGLTF(BIKERS_MODEL, DRACO_PATH);
  const { scene: countryKit } = useGLTF(KIT_MODELS.country, DRACO_PATH);
  const { scene: trucksKit } = useGLTF(KIT_MODELS.trucks, DRACO_PATH);
  const { scene: airportKit } = useGLTF(KIT_MODELS.airport, DRACO_PATH);
  const { scene: farmsetKit } = useGLTF(KIT_MODELS.farmset, DRACO_PATH);
  const kitScenes = useMemo(
    () => ({ country: countryKit, trucks: trucksKit, airport: airportKit, farmset: farmsetKit }),
    [countryKit, trucksKit, airportKit, farmsetKit],
  );
  const npcs = useMemo(() => createTraffic(VEHICLES.map((v) => v.size[2]), COUNTS, KINDS), []);
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
      const make = (source: Mesh, hubs: number[][], geometry?: BufferGeometry, radius = vehicle.wheelRadius) => {
        const count = COUNTS[type] * Math.max(1, hubs.length || 1);
        const mesh = new InstancedMesh(
          geometry ?? source.geometry as BufferGeometry,
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
        out.push({ mesh, type, hubs, wheelRadius: radius });
      };

      if (vehicle.kind === 'kit') {
        // One node of its model, every mesh under it baked into the node's
        // frame — and turned nose to −Z if the model faces the other way.
        const kit = kitOf(vehicle.name);
        const root = kitScenes[kit.model].getObjectByName(kit.part);
        if (!root) return;
        root.updateMatrixWorld(true);
        const toRoot = new Matrix4().copy(root.matrixWorld).invert();
        if (kit.turn) toRoot.premultiply(new Matrix4().makeRotationY(Math.PI));
        // A node marked `extras.wheel` (the farm set's) is a wheel centred on
        // its axle: drawn at its hub and spun like a car's, at its own radius.
        const wheelOf = (o: Object3D) => {
          for (let n: Object3D | null = o; n && n !== root; n = n.parent)
            if ((n.userData as { wheel?: boolean }).wheel) return n;
          return null;
        };
        root.traverse((o) => {
          if (!(o instanceof Mesh)) return;
          const wheel = wheelOf(o);
          if (!wheel) {
            make(o, [], (o.geometry as BufferGeometry).clone()
              .applyMatrix4(new Matrix4().multiplyMatrices(toRoot, o.matrixWorld)));
            return;
          }
          const toWheel = new Matrix4().copy(wheel.matrixWorld).invert();
          const hub = new Vector3().setFromMatrixPosition(
            new Matrix4().multiplyMatrices(toRoot, wheel.matrixWorld),
          );
          make(o, [hub.toArray()], (o.geometry as BufferGeometry).clone()
            .applyMatrix4(new Matrix4().multiplyMatrices(toWheel, o.matrixWorld)),
          (wheel.userData as { radius?: number }).radius);
        });
        return;
      }

      if (vehicle.kind === 'bike') {
        // A biker: the rider-and-bike body baked into the biker's own frame,
        // and one wheel (centred on its axle) instanced at both hubs.
        const root = bikers.getObjectByName(vehicle.name);
        if (!root) return;
        root.updateMatrixWorld(true);
        const toRoot = new Matrix4().copy(root.matrixWorld).invert();
        const local = (o: Mesh, frame: Matrix4) => (o.geometry as BufferGeometry).clone()
          .applyMatrix4(new Matrix4().multiplyMatrices(frame, o.matrixWorld));
        // By name less GLTFLoader's de-duplicating suffix: both bikers have a
        // `body` and a `wheelFront`, so the second one's arrive as `body_1`.
        const part = (name: string) => root.children.find((c) => c.name.replace(/_\d+$/, '') === name);
        part('body')?.traverse((o) => {
          if (o instanceof Mesh) make(o, [], local(o, toRoot));
        });
        const wheel = part('wheelFront');
        if (wheel) {
          const toWheel = new Matrix4().copy(wheel.matrixWorld).invert();
          wheel.traverse((o) => { if (o instanceof Mesh) make(o, vehicle.hubs, local(o, toWheel)); });
        }
        return;
      }

      // A racer is the sports car's own meshes, its paint baked to its colour.
      const source = vehicle.kind === 'race' ? RACE_CAR : vehicle.name;
      const paint = vehicle.kind === 'race' ? raceOf(vehicle.name).paint : null;
      const bodyParts = byPart.get(`${source}|body`) ?? [];
      for (const m of bodyParts) {
        make(m, []);
        const material = m.material as MeshStandardMaterial;
        if (paint && /^Body/.test(material.name)) {
          // A paint that will not bake (no canvas, an image it cannot read)
          // leaves the car red rather than the whole traffic unbuilt.
          try { out[out.length - 1].mesh.material = repaint(material, paint); } catch { /* stays red */ }
        }
      }
      if (vehicle.wheelMesh)
        for (const m of byPart.get(`${source}|wheel`) ?? []) make(m, vehicle.hubs);

      // The brake lights, taken off the lamp lenses this vehicle already has.
      // None of the twenty carries a material the name-based path in `Car`
      // could find, so without this the entire city brakes in the dark — see
      // `brakeLamps` for how the rear lenses are picked out.
      for (const source of bodyParts) {
        const material = Array.isArray(source.material) ? source.material[0] : source.material;
        if (!/optic/i.test(material?.name ?? '')) continue;
        const geometry = rearLampGeometry(source);
        if (!geometry) continue;
        const mesh = new InstancedMesh(geometry, brakeLampMaterial(), COUNTS[type]);
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        // Allocated up front so `setColorAt` never has to create the buffer
        // mid-frame, and started black: a lamp that has not been told
        // otherwise is off, not white.
        mesh.instanceColor = new InstancedBufferAttribute(
          new Float32Array(COUNTS[type] * 3), 3,
        );
        mesh.instanceColor.setUsage(DynamicDrawUsage);
        out.push({ mesh, type, hubs: [], wheelRadius: vehicle.wheelRadius, lamp: true });
      }
    });
    return out;
  }, [scene, bikers, kitScenes]);

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

  /** Lamp brightness per slot, 0 to 1. Ramped in the draw loop. */
  const brakes = useMemo(() => new Float32Array(npcs.length), [npcs.length]);

  const scratch = useMemo(() => ({
    lamp: new Color(),
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
    // The density setting, within what the shared NPC budget leaves the roads
    // once the boats near the player have theirs (`npcBudget`).
    NPC_BUDGET.total = Math.min(NPC_TOTAL, limitRef.current ?? NPC_TOTAL);
    const limit = roadLimit();
    updateTraffic(npcs, PHYSICS_TIMESTEP, t.x, t.z, t.heading, t.forwardSpeed, limit);
    let live = 0;
    for (const npc of npcs) if (npc.active) live++;
    NPC_BUDGET.cars = live;

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
      // Yaw, then nose-up pitch about the car's own cross axis (forward is −Z,
      // so +X pitch lifts the nose): it follows the road over the viaduct's hump.
      // A biker leans into the turn: tan(lean) = v ω / g.
      const lean = isBike(npc.type)
        ? Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.atan((npc.speed * npc.yawRate) / 9.81)))
        : 0;
      scratch.euler.set(npc.pitch, npc.heading, lean, 'YXZ');
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
  useFrame((_, rawDelta) => {
    // Brake lamps ramp here rather than in the AI: how fast a filament comes
    // up is a property of the lamp, not of the driving, and the AI runs on a
    // fixed timestep that has nothing to do with how often this draws.
    const delta = Math.min(rawDelta, 1 / 15);
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      // A wreck's lights are out. It has no driver.
      const on = npc.active && npc.wreck === 0 && npc.slowing;
      brakes[i] = rampBrake(brakes[i], on, delta);
    }

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
          if (b.lamp) {
            scratch.lamp.copy(BRAKE_COLOUR).multiplyScalar(brakes[i]);
            b.mesh.setColorAt(n, scratch.lamp);
          }
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
      if (b.lamp && b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
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
              mass={isBike(npc.type) ? BIKE_MASS : massFor(l)}
              friction={0.8}
              restitution={0.15}
            />
          </RigidBody>
        );
      })}

    </group>
  );
}
