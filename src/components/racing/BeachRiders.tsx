'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { Group, LinearSRGBColorSpace, Mesh, MeshStandardMaterial, Object3D, Quaternion, Euler, Vector3, type Material } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { TRAIN } from '@/config/trainConfig';
import crowdData from '@/config/crowdData.json';
import propsData from '@/config/beachPropsData.json';
import garageData from '@/config/garageData.json';
import {
  BEACH, BEACH_STAGE, beachGroundAt, beachPoint, onFoodCourt, onStage, VOLLEYBALL, volleyballCourt,
} from '@/config/kestrelBeach';
import { beachLimit, NPC_BUDGET } from '@/physics/npcBudget';
import type { VehicleTelemetry } from '@/types/vehicle';
import { beachOutfitFor, dressForBeach } from './beachWear';
import { SEAT, seatRider } from './quadRider';

/**
 * Kestrel Beach's riders: three quad bikes, each with a man in swim trunks on
 * it, and two of the garage's monster trucks — its own livery and one
 * repainted red — NPCs that ride the beach and nowhere else. Three more quads
 * stand parked (`PARKED`): two at the end of the volleyball court, one by the
 * stage.
 *
 * They are NPC traffic by the same rules as the cars and the boats: spawned
 * round the player only while the player is near the beach, retired when the
 * player is far, and drawn from the one shared NPC budget (`npcBudget` —
 * `beachWant` / `beachLimit`), so they cost nothing anywhere else and never
 * push the world over its cap.
 *
 * ## Where they ride
 *
 * The wet half of the sand, `BAND` of the way down to the waterline and a
 * little into the shallows — the hard sand a quad would actually ride on, and
 * clear of everything the beach has put on the dry half: the umbrellas and
 * loungers, the volleyball court, the tower and the boardwalks. Each picks a
 * point further along the shore in that band, drives at it with a turning
 * limit, and picks another on arrival; it steers clear of the stage and the
 * food courts, of the other riders, and stops for the player.
 *
 * ## What they are made of
 *
 * The quad is the beach pack's (`quadBike.glb`): body, and one wheel drawn at
 * its four hubs and spun by distance. Its rider is one of the crowd's men,
 * changed into trunks (`beachWear`) and sat on it by hand (`quadRider`) — a
 * static pose, no mixer. The monster truck is the garage's own model, its
 * wheels on their pivots, spun, the fronts steered. Each is a kinematic body,
 * so the player's car stops against one rather than through it; the beach's
 * people get out of their way (`liveBeachRiders`).
 */

const QUAD_MODEL = '/models/quadBike.glb';
const CROWD_MODEL = '/models/crowd.glb';
const MONSTER_ENTRY = (garageData.vehicles as Array<{
  id: string; model: string; size: number[]; radii?: Record<string, number>;
}>).find((c) => c.id === 'monster');
const MONSTER_MODEL = MONSTER_ENTRY?.model ?? '/models/garage/monster.glb';
useGLTF.preload(QUAD_MODEL, DRACO_PATH);
useGLTF.preload(MONSTER_MODEL, DRACO_PATH);

/** Quad riders, and the monster truck. */
const QUADS = 3;
/**
 * The monster trucks: the garage's own livery (red, baked by
 * `prepare-garage`), and one in the export's original cream — a linear
 * colour, as it was in the file.
 */
const MONSTER_TINTS: ReadonlyArray<readonly [number, number, number] | null> = [null, [1, 0.934, 0.699]];
/** The monster's bodywork material — the one a repaint changes. */
const MONSTER_PAINT = 'HOTROD_33B_Body';
/** The crowd's men, for the riders. */
const MEN = [0, 2, 13, 1, 11, 14, 16, 17];
/** Where on a column they ride: this fraction of the way down to the waterline, to just past it. */
const BAND: readonly [number, number] = [0.62, 1.02];
/** Spawn and retire distances from the player, metres. */
const NEAR_BEACH = 320;
const SPAWN_MIN = 45;
const DESPAWN = 480;
/** How far along the shore the next target is, in columns. */
const NEXT_COLUMNS: readonly [number, number] = [4, 12];

interface Kind {
  name: 'quad' | 'monster';
  /** Cruising speed, m/s, and the most it turns, rad/s. */
  speed: number;
  turn: number;
  /** Footprint, metres: width, height, length. */
  size: [number, number, number];
  wheelRadius: number;
}

const QUAD_KIND: Kind = {
  name: 'quad', speed: 8.5, turn: 1.1, size: propsData.quad as [number, number, number], wheelRadius: propsData.quadWheel.radius,
};
const MONSTER_KIND: Kind = {
  name: 'monster', speed: 6.5, turn: 0.55,
  size: (MONSTER_ENTRY?.size ?? [3.9, 3.26, 4.35]) as [number, number, number],
  wheelRadius: MONSTER_ENTRY?.radii?.FL ?? 0.84,
};

interface Rider {
  kind: Kind;
  root: Group;
  /** Wheels to spin (and, at the front of the truck, to steer). */
  wheels: Object3D[];
  steer: Object3D[];
  active: boolean;
  x: number;
  z: number;
  heading: number;
  speed: number;
  steerAngle: number;
  /** Where it is heading for, and on which column. */
  tx: number;
  tz: number;
  column: number;
  odometer: number;
}

/** What the beach's people need to know to get out of the way. */
export interface BeachRiderThreat { x: number; z: number; heading: number; speed: number; length: number; width: number }
const LIVE: BeachRiderThreat[] = [];
/** The riders out right now, for `KestrelPeople`. Forward is (−sin h, −cos h). */
export const liveBeachRiders = (): readonly BeachRiderThreat[] => LIVE;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A point in the riding band on column `k`, or null where the beach is too narrow to ride. */
function bandPoint(k: number): [number, number] | null {
  const c = BEACH?.columns[k];
  if (!c || c.depth < 20) return null;
  const land = c.depth + c.out;
  const [x, , z] = beachPoint(c, land * rand(BAND[0], BAND[1]));
  return [x, z];
}

/** Somewhere a rider must not drive. */
const blocked = (x: number, z: number) => onStage(x, z, 6) || onFoodCourt(x, z, 3);

export function BeachRiders({ telemetry }: { telemetry?: RefObject<VehicleTelemetry> }) {
  const { scene: quad } = useGLTF(QUAD_MODEL, DRACO_PATH);
  const { scene: crowd } = useGLTF(CROWD_MODEL);
  const { scene: monster } = useGLTF(MONSTER_MODEL, DRACO_PATH);

  const riders = useMemo<Rider[]>(() => {
    const out: Rider[] = [];
    // The daylight lift the town's people have, so the riders match them.
    const lifted = new Map<unknown, MeshStandardMaterial>();
    const lift = (m: MeshStandardMaterial) => {
      if (!lifted.has(m)) {
        const c = m.clone();
        c.color.setScalar(1.15);
        c.emissive.set('#ffffff');
        c.emissiveMap = c.map;
        c.emissiveIntensity = 0.22;
        c.roughness = 0.85;
        c.metalness = 0;
        lifted.set(m, c);
      }
      return lifted.get(m)!;
    };
    for (let i = 0; i < QUADS; i++) {
      const root = new Group();
      const body = quad.getObjectByName('quad')?.clone(true);
      if (body) root.add(body);
      const wheels: Object3D[] = [];
      const wheel = quad.getObjectByName('quadWheel');
      if (wheel) {
        for (const hub of propsData.quadWheel.hubs) {
          const w = wheel.clone(true);
          w.position.set(hub[0], hub[1], hub[2]);
          root.add(w);
          wheels.push(w);
        }
      }
      // The rider: one of the crowd's men, in trunks, sat on it.
      const figureIndex = MEN[i % MEN.length];
      const figure = clone(crowd.getObjectByName(crowdData.figures[figureIndex].name)!);
      figure.traverse((o) => {
        if ((o as { isBone?: boolean }).isBone) o.name = o.name.replace(/_\d+$/, '');
      });
      dressForBeach(figure, beachOutfitFor(figureIndex), lift);
      seatRider(figure);
      figure.position.set(SEAT[0], SEAT[1], SEAT[2]);
      // The crowd faces +Z; the quad, like every vehicle here, −Z.
      figure.rotation.y = Math.PI;
      root.add(figure);
      root.traverse((o) => { if ((o as Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      root.visible = false;
      out.push({
        kind: QUAD_KIND, root, wheels, steer: [], active: false, x: 0, z: 0, heading: 0, speed: 0,
        steerAngle: 0, tx: 0, tz: 0, column: 0, odometer: 0,
      });
    }
    for (const tint of MONSTER_TINTS) {
      const root = monster.clone(true) as unknown as Group;
      // A repaint: the bodywork's material cloned and recoloured; tyres,
      // glass, trims and graffiti keep their own.
      if (tint) {
        const paint = new Map<Material, Material>();
        root.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          const recolour = (m: Material) => {
            if (m.name !== MONSTER_PAINT) return m;
            if (!paint.has(m)) {
              const c = (m as MeshStandardMaterial).clone();
              c.color.setRGB(tint[0], tint[1], tint[2], LinearSRGBColorSpace);
              paint.set(m, c);
            }
            return paint.get(m)!;
          };
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(recolour) : recolour(mesh.material);
        });
      }
      const wheels = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']
        .map((n) => root.getObjectByName(n)).filter((o): o is Object3D => !!o);
      const steer = wheels.filter((w) => /_F[LR]$/.test(w.name));
      root.traverse((o) => { if ((o as Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      root.visible = false;
      out.push({
        kind: MONSTER_KIND, root, wheels, steer, active: false, x: 0, z: 0, heading: 0, speed: 0,
        steerAngle: 0, tx: 0, tz: 0, column: 0, odometer: 0,
      });
    }
    return out;
  }, [quad, crowd, monster]);

  /**
   * The parked quads: no rider, standing still, solid. Two nosed in at the
   * end of the volleyball court, one beside the stage's speaker stack.
   */
  const parked = useMemo(() => {
    const spots: Array<{ x: number; z: number; heading: number }> = [];
    /** Heading to point a −Z-forward vehicle along (dx, dz). */
    const facing = (dx: number, dz: number) => Math.atan2(-dx, -dz);
    const court = volleyballCourt();
    if (court) {
      for (const [b, turn] of [[-1.4, 0.2], [1.4, -0.15]] as const) {
        const [x, z] = court.at(VOLLEYBALL.length / 2 + 5, b);
        spots.push({ x, z, heading: facing(-court.shore[0], -court.shore[1]) + turn });
      }
    }
    if (BEACH_STAGE) {
      const st = BEACH_STAGE;
      const out = st.halfU + 2.5;
      spots.push({
        x: st.x + st.across[0] * out + st.front[0] * 3,
        z: st.z + st.across[1] * out + st.front[1] * 3,
        heading: facing(st.front[0], st.front[1]) + 0.5,
      });
    }
    return spots.map((spot) => {
      const root = new Group();
      const body = quad.getObjectByName('quad')?.clone(true);
      if (body) root.add(body);
      const wheel = quad.getObjectByName('quadWheel');
      if (wheel) {
        for (const hub of propsData.quadWheel.hubs) {
          const w = wheel.clone(true);
          w.position.set(hub[0], hub[1], hub[2]);
          root.add(w);
        }
      }
      root.traverse((o) => { if ((o as Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      // Stood on the sand, pitched to its slope.
      const [w, h, l] = QUAD_KIND.size;
      const fx = -Math.sin(spot.heading);
      const fz = -Math.cos(spot.heading);
      const g = (x: number, z: number) => beachGroundAt(x, z) ?? TRAIN.seaLevel;
      const front = g(spot.x + fx * l / 2, spot.z + fz * l / 2);
      const back = g(spot.x - fx * l / 2, spot.z - fz * l / 2);
      const y = (front + back) / 2;
      root.position.set(spot.x, y, spot.z);
      root.rotation.set(Math.atan2(front - back, l), spot.heading, 0, 'YXZ');
      return { root, collider: { at: [spot.x, y + h / 2, spot.z] as [number, number, number], heading: spot.heading, half: [w / 2, h / 2, l / 2] as [number, number, number] } };
    });
  }, [quad]);

  useEffect(() => () => { NPC_BUDGET.beach = 0; NPC_BUDGET.beachWant = 0; LIVE.length = 0; }, []);
  useEffect(() => {
    console.info(`[beach riders] ${riders.filter((r) => r.kind === QUAD_KIND).length} quads with riders, `
      + `${riders.filter((r) => r.kind === MONSTER_KIND).length} monster trucks, ${parked.length} quads parked`);
  }, [riders, parked]);

  const bodies = useRef<Array<RapierRigidBody | null>>([]);
  const clock = useRef(0);
  const firstFill = useRef(true);
  const scratch = useMemo(() => ({ q: new Quaternion(), e: new Euler(0, 0, 0, 'YXZ'), v: new Vector3() }), []);

  /** A new target further along the shore, in the band, clear of the stage and food courts. */
  const retarget = (r: Rider) => {
    const n = BEACH?.columns.length ?? 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const step = Math.round(rand(NEXT_COLUMNS[0], NEXT_COLUMNS[1])) * (Math.random() < 0.5 ? -1 : 1);
      const k = Math.max(3, Math.min(n - 4, r.column + step));
      const p = bandPoint(k);
      if (!p || blocked(p[0], p[1])) continue;
      r.tx = p[0];
      r.tz = p[1];
      r.column = k;
      return;
    }
  };

  /** Retire, ask for and spawn riders round the player. */
  const manage = (px: number, pz: number) => {
    if (!BEACH) return;
    // Near the beach at all? The nearest column's shore point will do.
    let nearest = Infinity;
    for (const c of BEACH.columns) nearest = Math.min(nearest, Math.hypot(c.shore[0] - px, c.shore[1] - pz));
    NPC_BUDGET.beachWant = nearest < NEAR_BEACH && NPC_BUDGET.total > 0 ? riders.length : 0;
    let live = 0;
    for (const r of riders) {
      if (!r.active) continue;
      if (Math.hypot(r.x - px, r.z - pz) > DESPAWN || NPC_BUDGET.beachWant === 0) {
        r.active = false;
        r.root.visible = false;
      } else live++;
    }
    const cap = beachLimit();
    const near = firstFill.current ? 0 : SPAWN_MIN;
    for (const r of riders) {
      if (live >= cap) break;
      if (r.active) continue;
      for (let attempt = 0; attempt < 10; attempt++) {
        const k = 4 + Math.floor(Math.random() * (BEACH.columns.length - 8));
        const p = bandPoint(k);
        if (!p || blocked(p[0], p[1])) continue;
        const d = Math.hypot(p[0] - px, p[1] - pz);
        if (d < near || d > DESPAWN * 0.8) continue;
        if (riders.some((o) => o.active && Math.hypot(o.x - p[0], o.z - p[1]) < 25)) continue;
        r.active = true;
        r.root.visible = true;
        r.x = p[0];
        r.z = p[1];
        r.column = k;
        r.speed = 0;
        retarget(r);
        r.heading = Math.atan2(-(r.tx - r.x), -(r.tz - r.z));
        live++;
        break;
      }
    }
    if (live > 0) firstFill.current = false;
    NPC_BUDGET.beach = live;
  };

  // Driving, and every Rapier write, in the before-step — as `Traffic` does.
  useBeforePhysicsStep(() => {
    const dt = PHYSICS_TIMESTEP;
    const t = telemetry?.current;
    if (t) {
      clock.current -= dt;
      if (clock.current <= 0) {
        clock.current = 0.5;
        manage(t.x, t.z);
      }
    }
    LIVE.length = 0;
    riders.forEach((r, i) => {
      const body = bodies.current[i];
      if (!r.active) {
        body?.setNextKinematicTranslation({ x: r.x, y: -500, z: r.z });
        return;
      }
      // Arrived: on to the next stretch of shore.
      if (Math.hypot(r.tx - r.x, r.tz - r.z) < 6) retarget(r);
      let want = Math.atan2(-(r.tx - r.x), -(r.tz - r.z));
      let target = r.kind.speed;
      const fx = -Math.sin(r.heading);
      const fz = -Math.cos(r.heading);
      // Something in the way ahead — the stage, a food court, or the water too
      // deep: swing away from it, and find somewhere else to go.
      const ax = r.x + fx * 10;
      const az = r.z + fz * 10;
      const ahead = beachGroundAt(ax, az);
      if (blocked(ax, az) || ahead === null || ahead < TRAIN.seaLevel - 0.6) {
        want = r.heading + Math.PI / 2;
        target *= 0.5;
        retarget(r);
      }
      // Another rider close in front: bear off it.
      for (const o of riders) {
        if (o === r || !o.active) continue;
        const dx = o.x - r.x;
        const dz = o.z - r.z;
        const d = Math.hypot(dx, dz);
        if (d < 12 && dx * fx + dz * fz > 0) {
          want += Math.sign(dx * fz - dz * fx || 1) * 0.6;
          target = Math.min(target, Math.max(2, d - 4));
        }
      }
      // The player close in front: stop for them.
      if (t) {
        const dx = t.x - r.x;
        const dz = t.z - r.z;
        const d = Math.hypot(dx, dz);
        if (d < 14 && dx * fx + dz * fz > 0) target = Math.min(target, Math.max(0, d - 7));
      }
      // Steer with a turning limit, slower through a sharp turn.
      const err = wrap(want - r.heading);
      const yaw = Math.max(-r.kind.turn, Math.min(r.kind.turn, err * 2)) * dt;
      r.heading = wrap(r.heading + yaw);
      r.steerAngle = Math.max(-0.5, Math.min(0.5, err));
      target *= 1 - Math.min(0.6, Math.abs(err) / Math.PI);
      r.speed += Math.max(-6 * dt, Math.min(2.5 * dt, target - r.speed));
      const step = r.speed * dt;
      r.x += -Math.sin(r.heading) * step;
      r.z += -Math.cos(r.heading) * step;
      r.odometer += step;

      const y = beachGroundAt(r.x, r.z) ?? TRAIN.seaLevel;
      body?.setNextKinematicTranslation({ x: r.x, y: y + r.kind.size[1] / 2, z: r.z });
      body?.setNextKinematicRotation(scratch.q.setFromAxisAngle(scratch.v.set(0, 1, 0), r.heading));
      LIVE.push({ x: r.x, z: r.z, heading: r.heading, speed: r.speed, length: r.kind.size[2], width: r.kind.size[0] });
    });
  });

  // Drawing: pose each on the sand, wheels spun.
  useFrame(() => {
    for (const r of riders) {
      if (!r.active) continue;
      const [w, , l] = r.kind.size;
      const fx = -Math.sin(r.heading);
      const fz = -Math.cos(r.heading);
      const g = (x: number, z: number) => beachGroundAt(x, z) ?? TRAIN.seaLevel;
      const front = g(r.x + fx * l / 2, r.z + fz * l / 2);
      const back = g(r.x - fx * l / 2, r.z - fz * l / 2);
      const left = g(r.x + fz * w / 2, r.z - fx * w / 2);
      const right = g(r.x - fz * w / 2, r.z + fx * w / 2);
      scratch.e.set(Math.atan2(front - back, l), r.heading, Math.atan2(left - right, w), 'YXZ');
      r.root.position.set(r.x, (front + back + left + right) / 4, r.z);
      r.root.quaternion.setFromEuler(scratch.e);
      const spin = -r.odometer / r.kind.wheelRadius;
      for (const wheel of r.wheels) wheel.rotation.x = spin;
      for (const wheel of r.steer) wheel.rotation.set(spin, r.steerAngle, 0, 'YXZ');
    }
  });

  return (
    <group>
      {riders.map((r, i) => <primitive key={`r${i}`} object={r.root} />)}
      {parked.map((p, i) => <primitive key={`p${i}`} object={p.root} />)}
      <RigidBody type="fixed" colliders={false}>
        {parked.map((p, i) => (
          <CuboidCollider key={`pc${i}`} args={p.collider.half} position={p.collider.at} rotation={[0, p.collider.heading, 0]} />
        ))}
      </RigidBody>
      {riders.map((r, i) => (
        <RigidBody
          key={`b${i}`}
          ref={(b) => { bodies.current[i] = b; }}
          type="kinematicPosition"
          colliders={false}
          position={[0, -500, 0]}
        >
          <CuboidCollider args={[r.kind.size[0] / 2, r.kind.size[1] / 2, r.kind.size[2] / 2]} />
        </RigidBody>
      ))}
    </group>
  );
}
