'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  AnimationMixer, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3,
  type AnimationAction, type Material,
} from 'three';
import crowdData from '@/config/crowdData.json';
import catalogue from '@/config/vehicleCatalogue.json';
import { STREET_WALKERS, type StreetWalker } from '@/physics/kestrelStreet';
import { liveTraffic } from '@/physics/trafficAI';
import { groundHeightAt, isDrivableAt } from '@/physics/cityNav';
import {
  CLIP_SPEED, CROSS_CHANCE, DESPAWN, GROUP_SHARE, JUNCTION_INSET, PEOPLE_AREAS, PEOPLE_EDGES,
  PEOPLE_GROUND, PEOPLE_MAX, PEOPLE_NODES, ROAD_DIP, RUN_SPEED, SPAWN_FAR, SPAWN_NEAR, WALK_SPEED,
} from '@/config/kestrelPeople';
import { audienceSpot, BEACH, beachGroundAt, beachPoint, volleyballCourt } from '@/config/kestrelBeach';
import { TRAIN } from '@/config/trainConfig';
import { beachMaterials, beachOutfitFor, SKIRTED } from './beachWear';
import { liveBeachRiders } from './BeachRiders';

/**
 * Kestrel's pedestrians: up to `PEOPLE_MAX` people from the animated crowd,
 * kept in a ring round the player while the player is on the island.
 *
 * Light by design. There are no physics bodies: a person is a pooled clone of
 * one crowd figure, a mixer playing the shared walk, and a few numbers. The car
 * is read off `chassisRef` — position, heading, and a speed differenced from
 * frame to frame — which is all it takes to decide that someone should get out
 * of the way, or that they did not.
 *
 * What they do:
 *
 *  - **walk** the pavements (`kestrelPeople`), turning at junctions and now and
 *    then crossing the road there;
 *  - **stand** in twos and threes, facing each other, shifting about;
 *  - **flee** when a vehicle comes at them fast — a run to the side, out of its
 *    line — then walk back to the pavement;
 *  - **go under** when one hits them: knocked flat in a quarter of a second,
 *    a short slide, a few seconds on the ground, and back up and walking.
 *
 * **On Kestrel Beach** the same pool turns out in swimwear (`beachWear`):
 * a pooled person spawned on the sand has its materials swapped for trunks or
 * a bikini and a holiday skin tone, and back again when it is next used on a
 * pavement — no second set of bodies, mixers or skeletons, and `PEOPLE_MAX`
 * is the cap for the town and the beach together. On the sand they wander
 * from spot to spot and linger looking out to sea, stand about in twos and
 * threes, or play volleyball on the court, and they scatter and go under just
 * as they do in the street.
 *
 * The walk is the only clip the pack has. Standing is that clip held on the
 * frame where the feet are together, swaying a little; running is
 * it played fast with a lean.
 */

const MODEL = '/models/crowd.glb';
useGLTF.preload(MODEL);

/** Height of the body's turning point — about the hips — above the feet. */
const PIVOT = 0.95;
/** Car footprint half-extents for a hit, padded by a body's half-width. */
const HIT_HALF_LENGTH = 2.6;
const HIT_HALF_WIDTH = 1.3;
/** How long the topple takes, how low the body lies, and how long it stays down. */
const FALL_TIME = 0.28;
const LIE_HEIGHT = 0.14;
const LIE_TIME = 3;
/** Only people this close cast shadows: at 40 people, the far ones are not worth a shadow pass. */
const SHADOW_RANGE = 40;

/** Anything on wheels a person has to mind. */
interface Threat {
  x: number;
  z: number;
  vx: number;
  vz: number;
  fx: number;
  fz: number;
  speed: number;
  halfLength: number;
  halfWidth: number;
  /** How close its line must pass to make someone jump. */
  miss: number;
}

type Mode = 'walk' | 'stand' | 'startle' | 'flee' | 'down' | 'getup' | 'return' | 'wander' | 'linger';

/** Share of spawn attempts made on the beach rather than the pavements. */
const BEACH_SHARE = 0.5;
/** Of those on the beach, the share who come for the stage and stand watching it. */
const AUDIENCE_SHARE = 0.35;
/** How far a beach wanderer goes for its next spot, and how long it stays there. */
const WANDER_REACH = 14;
const LINGER: readonly [number, number] = [4, 12];

/** The beach's bounding box grown by the spawn range: where the pool runs for the beach. */
const BEACH_AREA = (() => {
  if (!BEACH) return null;
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const c of BEACH.columns) {
    for (const d of [0, c.depth + c.out]) {
      const [x, , z] = beachPoint(c, d);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
  }
  return { x0: x0 - SPAWN_FAR, x1: x1 + SPAWN_FAR, z0: z0 - SPAWN_FAR, z1: z1 + SPAWN_FAR };
})();
const COURT = volleyballCourt();
/** Above this the beach is still the island's grass: wanderers keep below it. */
const SAND_TOP = (BEACH ? beachPoint(BEACH.columns[0], 0)[1] : 0) - 0.3;

/** A spot on the dry sand: column `k` (random if omitted), facing the sea. */
function sandSpot(k = 3 + Math.floor(Math.random() * Math.max(1, (BEACH?.columns.length ?? 7) - 6))) {
  const c = BEACH!.columns[k];
  const land = c.depth + c.out;
  if (c.depth < 20) return null;
  const d = rand(Math.min(10, land * 0.15), land - 2);
  const [x, y, z] = beachPoint(c, d);
  return { x, y, z, k, face: Math.atan2(-c.inward[0], -c.inward[1]) };
}

interface Person {
  slot: number;
  active: boolean;
  body: Group;
  mixer: AnimationMixer;
  action: AnimationAction;
  mode: Mode;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  /** Walking: the edge, which end we left from, metres along it, and our side of the pavement. */
  edge: number;
  from: number;
  t: number;
  lane: number;
  /** Flee and tumble. */
  vx: number;
  vz: number;
  vy: number;
  cy: number;
  axis: Vector3;
  angle: number;
  timer: number;
  /** Lying face down (+1) or on the back (−1), then standing back up from it. */
  lie: number;
  seed: number;
  /** Whether the meshes currently cast shadows. */
  shadow: boolean;
  /** How far below the pavement top the feet are: the road's depth, mid-crossing. */
  dip: number;
  /** On the beach (in swimwear, on the sand) rather than the pavements. */
  beach: boolean;
  /** Each mesh, its street material and its swimwear (none for those who stay off the beach). */
  meshes: Mesh[];
  street: Material[];
  swim: Material[] | null;
  /** The sand's height under the feet, kept as they move. */
  groundY: number;
  /** On the beach: 0 roaming, −1 / +1 for a side of the volleyball court, 2 in the stage's audience. */
  plan: number;
  /** Wandering: where to, and which way to face on arrival. Returning to the footway: the point on it. */
  tx: number;
  tz: number;
  face: number;
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const _q = new Quaternion();
const _yaw = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _carPos = new Vector3();
const _carQuat = new Quaternion();
const _fwd = new Vector3();
const _side = new Vector3();

/** How far below the footway the feet are, `t` metres along `e`: 0 up on it, the road's depth off it. */
function edgeDip(e: (typeof PEOPLE_EDGES)[number], t: number) {
  const inset = e.inset ?? JUNCTION_INSET;
  return e.raised && t >= inset && t <= e.length - inset ? 0 : e.dip ?? ROAD_DIP;
}

function nodePoint(n: number) {
  return PEOPLE_NODES[n];
}

/** A point on an edge, `t` metres from `from`, pushed `lane` metres to its right. */
function edgePoint(edge: number, from: number, t: number, lane: number) {
  const e = PEOPLE_EDGES[edge];
  const a = nodePoint(from);
  const b = nodePoint(e.a === from ? e.b : e.a);
  const k = e.length > 0 ? t / e.length : 0;
  const dx = (b.x - a.x) / (e.length || 1);
  const dz = (b.z - a.z) / (e.length || 1);
  return {
    x: a.x + (b.x - a.x) * k - dz * lane,
    z: a.z + (b.z - a.z) * k + dx * lane,
    yaw: Math.atan2(dx, dz),
  };
}

/** Next edge out of `node`, not straight back along `came` unless that is all there is. */
function nextEdge(node: number, came: number) {
  const out = PEOPLE_NODES[node].edges.filter((e) => e !== came);
  if (!out.length) return came;
  const along = out.filter((e) => !PEOPLE_EDGES[e].crossing);
  const over = out.filter((e) => PEOPLE_EDGES[e].crossing);
  if (over.length && (!along.length || Math.random() < CROSS_CHANCE)) return pick(over);
  return pick(along.length ? along : out);
}

function nearestNode(x: number, z: number) {
  let best = 0;
  let bestD = Infinity;
  PEOPLE_NODES.forEach((n, i) => {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

export function KestrelPeople({ chassisRef }: { chassisRef: RefObject<Group | null> }) {
  const { scene, animations } = useGLTF(MODEL);
  const root = useRef<Group>(null);

  const people = useMemo<Person[]>(() => {
    const clip = animations.find((a) => a.name === crowdData.clip) ?? animations[0];
    // Brighter than the atlas alone: a little of the texture as emission lifts
    // the dark clothes out of shadow, so a pavement full of them reads as
    // people in daylight rather than silhouettes.
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
    return Array.from({ length: PEOPLE_MAX }, (_, slot) => {
      const info = crowdData.figures[(slot * 7) % crowdData.figures.length];
      const figure = clone(scene.getObjectByName(info.name)!);
      figure.position.set(0, -PIVOT, 0);
      figure.traverse((o) => {
        if ((o as { isBone?: boolean }).isBone) {
          o.name = o.name.replace(/_\d+$/, '');
        }
        if ((o as Mesh).isMesh) {
          const mesh = o as Mesh;
          mesh.castShadow = true;
          mesh.material = lift(mesh.material as MeshStandardMaterial);
        }
      });
      // Swimwear for the beach, made now and swapped in when needed.
      const meshes: Mesh[] = [];
      figure.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
      const fig = crowdData.figures.indexOf(info);
      let swim: Material[] | null = null;
      if (BEACH && !SKIRTED.has(fig)) {
        const made = beachMaterials(figure, beachOutfitFor(fig), (m) => m);
        swim = meshes.map((m) => made.get(m) ?? (m.material as Material));
      }
      const body = new Group();
      body.add(figure);
      body.visible = false;
      const mixer = new AnimationMixer(figure);
      const action = mixer.clipAction(clip);
      action.play();
      return {
        slot, active: false, body, mixer, action,
        mode: 'walk', x: 0, z: 0, yaw: 0, speed: 1.4,
        edge: 0, from: 0, t: 0, lane: 0,
        vx: 0, vz: 0, vy: 0, cy: PIVOT, axis: new Vector3(1, 0, 0), angle: 0, timer: 0, lie: 1,
        seed: slot * 13.7,
        shadow: true,
        dip: 0,
        beach: false, meshes, street: meshes.map((m) => m.material as Material), swim,
        groundY: 0, plan: 0, tx: 0, tz: 0, face: 0,
      } satisfies Person;
    });
  }, [scene, animations]);


  useEffect(() => {
    const g = root.current;
    if (!g) return;
    for (const p of people) g.add(p.body);
    return () => { for (const p of people) g.remove(p.body); };
  }, [people]);

  const car = useRef({ x: 0, y: 0, z: 0, vx: 0, vz: 0, ok: false });
  const spawnClock = useRef(0);
  const threats = useMemo<Threat[]>(() => [], []);
  const walkers = useMemo<StreetWalker[]>(() => people.map(() => ({ x: 0, z: 0, onRoad: false })), [people]);
  useEffect(() => () => { STREET_WALKERS.length = 0; }, []);
  const firstFill = useRef(true);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    const chassis = chassisRef.current;
    if (!chassis || dt <= 0) return;

    // ---- The player: where, which way, how fast.
    chassis.getWorldPosition(_carPos);
    chassis.getWorldQuaternion(_carQuat);
    const c = car.current;
    if (c.ok) {
      const k = Math.min(1, dt * 8);
      c.vx += ((_carPos.x - c.x) / dt - c.vx) * k;
      c.vz += ((_carPos.z - c.z) / dt - c.vz) * k;
    }
    c.x = _carPos.x; c.y = _carPos.y; c.z = _carPos.z; c.ok = true;
    const carSpeed = Math.hypot(c.vx, c.vz);
    // Which island's streets the player is among, if any — Kestrel's or Halcyon's.
    const area = PEOPLE_AREAS.find((a) => c.x > a.x0 && c.x < a.x1 && c.z > a.z0 && c.z < a.z1);
    // Down among the people, not on a bridge or a viaduct over them. The city's
    // ground rolls, so there it is the ground under the car, not one height.
    const groundHere = area ? area.ground ?? groundHeightAt(c.x, c.z) ?? c.y : PEOPLE_GROUND;
    const carLow = Math.abs(c.y - groundHere) < 3;
    _fwd.set(0, 0, 1).applyQuaternion(_carQuat);
    const fx = _fwd.x;
    const fz = _fwd.z;
    const fl = Math.hypot(fx, fz) || 1;

    const onBeach = BEACH_AREA !== null
      && c.x > BEACH_AREA.x0 && c.x < BEACH_AREA.x1 && c.z > BEACH_AREA.z0 && c.z < BEACH_AREA.z1;
    const here = onBeach || area !== undefined;

    // ---- Spawning and clearing, a couple of times a second.
    spawnClock.current -= dt;
    if (spawnClock.current <= 0) {
      spawnClock.current = 0.4;
      for (const p of people) {
        if (!p.active) continue;
        if (!here || Math.hypot(p.x - c.x, p.z - c.z) > DESPAWN) {
          p.active = false;
          p.body.visible = false;
        }
      }
      if (here) {
        const near = firstFill.current ? 12 : SPAWN_NEAR;
        firstFill.current = false;
        let free = people.filter((p) => !p.active);
        // The volleyball court, when it comes into range and nobody is on it.
        if (onBeach && COURT) {
          const d = Math.hypot(COURT.x - c.x, COURT.z - c.z);
          const playing = people.filter((p) => p.active && p.beach && (p.plan === 1 || p.plan === -1)).length;
          if (playing === 0 && d > near && d < SPAWN_FAR) {
            for (const side of [-1, 1]) {
              const p = free.find((q) => q.swim);
              if (!p) break;
              const [x, z] = courtSpot(side);
              activate(p, x, z, true);
              p.plan = side;
              linger(p);
              p.face = courtFace(side);
              p.yaw = p.face;
              free = free.filter((q) => q !== p);
            }
          }
        }
        // Only the pavements in reach: with two islands' networks in one list,
        // a random pick across all of it would mostly land on the other one.
        const reach = SPAWN_FAR + 30;
        const nearby: number[] = [];
        PEOPLE_EDGES.forEach((e, i) => {
          const n = PEOPLE_NODES[e.a];
          if (!e.crossing && Math.abs(n.x - c.x) < reach && Math.abs(n.z - c.z) < reach) nearby.push(i);
        });
        let tries = 0;
        while (free.length && tries++ < 40) {
          // Now and then, a spot on the sand instead.
          if (onBeach && Math.random() < BEACH_SHARE) {
            const swimmers = free.filter((q) => q.swim);
            const watching = Math.random() < AUDIENCE_SHARE;
            const at = !swimmers.length ? null : watching ? audienceSpot() : sandSpot();
            if (!at) continue;
            const d = Math.hypot(at.x - c.x, at.z - c.z);
            if (d < near || d > SPAWN_FAR) continue;
            if (swimmers.length >= 2 && Math.random() < GROUP_SHARE) {
              // Two or three standing together, facing the middle.
              const n = Math.min(swimmers.length, Math.random() < 0.6 ? 2 : 3);
              const spin = Math.random() * Math.PI * 2;
              for (let i = 0; i < n; i++) {
                const p = swimmers[i];
                const a = spin + (i / n) * Math.PI * 2;
                const r = n === 2 ? 0.45 : 0.6;
                activate(p, at.x + Math.sin(a) * r, at.z + Math.cos(a) * r, true);
                p.mode = 'stand';
                p.yaw = a + Math.PI;
              }
            } else {
              const p = swimmers[0];
              activate(p, at.x, at.z, true);
              if (watching) p.plan = 2;
              linger(p);
              p.face = at.face + rand(-0.6, 0.6);
              p.yaw = p.face;
            }
            free = people.filter((q) => !q.active);
            continue;
          }
          // A point somewhere on the pavements at the right sort of distance.
          if (!nearby.length) break;
          const edge = nearby[Math.floor(Math.random() * nearby.length)];
          const e = PEOPLE_EDGES[edge];
          const t = Math.random() * e.length;
          // The city's footways are often a metre or two of paving with lawn
          // behind: keep to its middle there, and a group bunched up on it.
          const narrow = e.inset === 0;
          const lane = narrow ? rand(-0.3, 0.3) : rand(-0.7, 0.7);
          const at = edgePoint(edge, e.a, t, narrow ? 0 : lane);
          const d = Math.hypot(at.x - c.x, at.z - c.z);
          if (d < near || d > SPAWN_FAR) continue;
          if (free.length >= 2 && Math.random() < GROUP_SHARE) {
            const n = Math.min(free.length, Math.random() < 0.5 ? 2 : 3);
            const spin = Math.random() * Math.PI * 2;
            for (let i = 0; i < n; i++) {
              const p = free[i];
              const a = spin + (i / n) * Math.PI * 2;
              const r = (n === 2 ? 0.45 : 0.6) * (narrow ? 0.8 : 1);
              activate(p, at.x + Math.sin(a) * r, at.z + Math.cos(a) * r, false);
              p.mode = 'stand';
              // Where on the network they are, for when they move off.
              p.edge = edge;
              p.from = e.a;
              p.t = t;
              p.yaw = a + Math.PI; // face the middle
              p.dip = edgeDip(e, t);
            }
          } else {
            const p = free[0];
            activate(p, at.x, at.z, false);
            p.mode = 'walk';
            p.edge = edge;
            p.from = Math.random() < 0.5 ? e.a : e.b;
            p.t = p.from === e.a ? t : e.length - t;
            p.lane = p.from === e.a ? lane : -lane;
          }
          free = people.filter((q) => !q.active);
        }
      }
    }

    // ---- What can hit them: the player's car, and the NPC traffic.
    threats.length = 0;
    if (carLow) {
      threats.push({
        x: c.x, z: c.z, vx: c.vx, vz: c.vz, fx: fx / fl, fz: fz / fl, speed: carSpeed,
        halfLength: HIT_HALF_LENGTH, halfWidth: HIT_HALF_WIDTH, miss: 3.2,
      });
    }
    // The city's NPC traffic, which drives Kestrel too (`roadGraph`). Its
    // forward is (−sin h, −cos h), the convention every vehicle here uses.
    for (const car of liveTraffic()) {
      const fx = -Math.sin(car.heading);
      const fz = -Math.cos(car.heading);
      const halfWidth = (catalogue.vehicles[car.type]?.size[0] ?? 2) / 2;
      threats.push({
        x: car.x, z: car.z, vx: fx * car.speed, vz: fz * car.speed, fx, fz, speed: car.speed,
        halfLength: car.length / 2 + 0.3, halfWidth: halfWidth + 0.3,
        // Traffic keeps to its lane: only someone actually in its path flinches,
        // not everyone on the pavement it passes.
        miss: halfWidth + 0.8,
      });
    }
    // The beach's quads and monster truck (`BeachRiders`): they wander the
    // sand rather than keep a lane, so anyone near their line jumps.
    for (const r of liveBeachRiders()) {
      const fx = -Math.sin(r.heading);
      const fz = -Math.cos(r.heading);
      threats.push({
        x: r.x, z: r.z, vx: fx * r.speed, vz: fz * r.speed, fx, fz, speed: r.speed,
        halfLength: r.length / 2 + 0.3, halfWidth: r.width / 2 + 0.3, miss: r.width / 2 + 2,
      });
    }

    // ---- Each person.
    STREET_WALKERS.length = 0;
    for (const p of people) {
      if (!p.active) continue;
      const dist = Math.hypot(p.x - c.x, p.z - c.z);
      for (const t of threats) {
        const upright = p.mode === 'walk' || p.mode === 'stand' || p.mode === 'return'
          || p.mode === 'flee' || p.mode === 'startle' || p.mode === 'wander' || p.mode === 'linger';
        if (!upright) break;
        const dx = p.x - t.x;
        const dz = p.z - t.z;
        const d = Math.hypot(dx, dz);
        // Hit: inside the vehicle's footprint, and it is moving.
        if (t.speed > 2.5 && d < t.halfLength + 1) {
          const lx = dx * t.fz - dz * t.fx;
          const lz = dx * t.fx + dz * t.fz;
          if (Math.abs(lz) < t.halfLength && Math.abs(lx) < t.halfWidth) {
            knockDown(p, t.vx, t.vz, t.speed);
            break;
          }
        }
        // Get out of the way: closing fast, and its line passes near.
        const calm = p.mode === 'walk' || p.mode === 'stand' || p.mode === 'return'
          || p.mode === 'wander' || p.mode === 'linger';
        if (calm && t.speed > 3 && d < 22) {
          const tc = (dx * t.vx + dz * t.vz) / (t.speed * t.speed);
          const miss = Math.hypot(dx - t.vx * tc, dz - t.vz * tc);
          if ((tc > 0 && tc < 1.6 && miss < t.miss) || d < t.halfLength + 2) {
            // Off its line, to whichever side we are already on — after a beat
            // of surprise, frozen and turning to look, so a fast car still
            // catches people and a slow one never does.
            const side = Math.sign(t.vx * dz - t.vz * dx) || 1;
            const px = (-t.vz / t.speed) * side;
            const pz = (t.vx / t.speed) * side;
            p.mode = 'startle';
            p.timer = rand(0.25, 0.6);
            p.vx = (px * 0.9 + (dx / (d || 1)) * 0.3) * RUN_SPEED;
            p.vz = (pz * 0.9 + (dz / (d || 1)) * 0.3) * RUN_SPEED;
            break;
          }
        }
      }

      step(p, dt);
      pose(p, dt, dist);
      // Published for the traffic: anyone at carriageway level, or off their
      // feet, or running about, is someone a car should stop for.
      const w = walkers[p.slot];
      w.x = p.x;
      w.z = p.z;
      w.onRoad = !p.beach && (p.dip > 0 || (p.mode !== 'walk' && p.mode !== 'stand' && p.mode !== 'return'));
      STREET_WALKERS.push(w);
    }

    function activate(p: Person, x: number, z: number, beach: boolean) {
      p.active = true;
      p.body.visible = true;
      p.x = x; p.z = z;
      p.plan = 0;
      p.dip = 0;
      // Into swimwear for the sand, back into street clothes for the pavements.
      if (p.beach !== beach) {
        p.beach = beach;
        const mats = beach && p.swim ? p.swim : p.street;
        p.meshes.forEach((m, i) => { m.material = mats[i]; });
      }
      // The sand's height, or the footway's on whichever island this is.
      p.groundY = beach ? beachGroundAt(x, z) ?? TRAIN.seaLevel : PEOPLE_NODES[nearestNode(x, z)].y;
      p.cy = PIVOT; p.angle = 0; p.vy = 0;
      p.speed = rand(WALK_SPEED[0], WALK_SPEED[1]);
      p.action.paused = false;
      p.action.time = Math.random() * crowdData.duration;
    }
  });

  return <group ref={root} />;
}

/**
 * Run over: knocked flat under the car, not thrown. A short shove in the
 * car's direction, a topple that takes a quarter of a second, and they are on
 * the ground with the car going over them — head first the way it was going,
 * which is the way the bumper takes the legs out.
 */
function knockDown(p: Person, cvx: number, cvz: number, carSpeed: number) {
  const shove = Math.min(4, carSpeed * 0.25);
  const ux = cvx / carSpeed;
  const uz = cvz / carSpeed;
  p.vx = ux * shove;
  p.vz = uz * shove;
  p.vy = 0;
  // Topple over the axis square to the car's travel.
  p.axis.set(uz, 0, -ux);
  p.angle = 0;
  p.mode = 'down';
  p.timer = 0;
  p.action.paused = true;
  p.action.time = 0.0;
}

/** A spot in one half of the volleyball court. */
function courtSpot(side: number): [number, number] {
  return COURT ? COURT.at(rand(-3.2, 3.2), side * rand(1.6, 3.4)) : [0, 0];
}
/** Facing the net from side `side`. */
function courtFace(side: number) {
  return COURT ? Math.atan2(-COURT.sea[0] * side, -COURT.sea[1] * side) : 0;
}

/** Stand where they are a while: on the beach, before wandering on. */
function linger(p: Person) {
  p.mode = 'linger';
  p.timer = p.plan === 2 ? rand(10, 25) : p.plan !== 0 ? rand(1.2, 3.5) : rand(...LINGER);
  p.face = p.yaw;
}

/** Off to the next spot on the sand: nearby, or about their half of the court. */
function wander(p: Person) {
  if (p.plan === 2) {
    // The audience shuffles about, still facing the stage.
    const a = audienceSpot();
    if (!a) { p.plan = 0; return; }
    p.tx = a.x; p.tz = a.z; p.face = a.face;
  } else if (p.plan !== 0) {
    const [x, z] = courtSpot(p.plan);
    p.tx = x; p.tz = z; p.face = courtFace(p.plan);
  } else {
    const a = Math.random() * Math.PI * 2;
    const r = rand(3, WANDER_REACH);
    const x = p.x + Math.sin(a) * r;
    const z = p.z + Math.cos(a) * r;
    const y = beachGroundAt(x, z);
    // Stay on the dry sand: not up on the grass, not in the sea.
    if (y === null || y > SAND_TOP || y < TRAIN.seaLevel + 0.15) {
      p.mode = 'linger';
      p.timer = rand(1, 3);
      return;
    }
    p.tx = x; p.tz = z; p.face = a + rand(-1, 1);
  }
  p.mode = 'wander';
}

function step(p: Person, dt: number) {
  switch (p.mode) {
    case 'wander': {
      const dx = p.tx - p.x;
      const dz = p.tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.2) { linger(p); break; }
      const s = Math.min(d, p.speed * dt);
      p.x += (dx / d) * s;
      p.z += (dz / d) * s;
      p.yaw += wrapAngle(Math.atan2(dx, dz) - p.yaw) * Math.min(1, dt * 6);
      break;
    }
    case 'linger': {
      p.yaw += wrapAngle(p.face - p.yaw) * Math.min(1, dt * 4);
      p.timer -= dt;
      if (p.timer <= 0) wander(p);
      break;
    }
    case 'walk': {
      p.t += p.speed * dt;
      let e = PEOPLE_EDGES[p.edge];
      while (p.t >= e.length) {
        p.t -= e.length;
        const node = e.a === p.from ? e.b : e.a;
        p.edge = nextEdge(node, p.edge);
        p.from = node;
        e = PEOPLE_EDGES[p.edge];
      }
      const at = edgePoint(p.edge, p.from, p.t, p.lane);
      p.x = at.x; p.z = at.z;
      // Up on a street's raised footway; down on a junction tile, which the
      // kit paints flat — corners, the side of a T, and every crossing.
      p.dip = edgeDip(e, p.t);
      // And the footway's own height along the way: the city's goes up and
      // down hills (the islands' is one height, so this changes nothing there).
      const ya = PEOPLE_NODES[p.from].y;
      const yb = PEOPLE_NODES[e.a === p.from ? e.b : e.a].y;
      p.groundY = ya + (yb - ya) * (e.length > 0 ? p.t / e.length : 0);
      p.yaw += wrapAngle(at.yaw - p.yaw) * Math.min(1, dt * 6);
      break;
    }
    case 'stand':
      break;
    case 'startle': {
      // Look at the danger, then go.
      p.yaw += wrapAngle(Math.atan2(-p.vx, -p.vz) - p.yaw) * Math.min(1, dt * 5);
      p.timer -= dt;
      if (p.timer <= 0) {
        p.mode = 'flee';
        p.timer = rand(1.0, 1.6);
      }
      break;
    }
    case 'flee': {
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      if (!p.beach) leash(p);
      p.yaw += wrapAngle(Math.atan2(p.vx, p.vz) - p.yaw) * Math.min(1, dt * 10);
      p.timer -= dt;
      if (p.timer <= 0) startReturn(p);
      break;
    }
    case 'return': {
      // Back to the footway they left, at the nearest point of it, and on
      // along it from there — not to whichever walk point is nearest, which
      // can be across a lawn on another street.
      const dx = p.tx - p.x;
      const dz = p.tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3) {
        p.mode = 'walk';
        p.lane = 0;
        break;
      }
      const s = Math.min(d, p.speed * dt);
      p.x += (dx / d) * s;
      p.z += (dz / d) * s;
      p.yaw += wrapAngle(Math.atan2(dx, dz) - p.yaw) * Math.min(1, dt * 6);
      break;
    }
    case 'down': {
      p.timer += dt;
      // Topple: pivot down to the ground and over onto the back, quickly.
      const k = Math.min(1, p.timer / FALL_TIME);
      const ease = 1 - (1 - k) * (1 - k);
      p.angle = (Math.PI / 2) * ease;
      p.cy = PIVOT + (LIE_HEIGHT - PIVOT) * ease;
      // Then a short slide to a stop.
      const f = Math.max(0, 1 - dt * 5);
      p.vx *= f;
      p.vz *= f;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      if (!p.beach) leash(p);
      if (p.timer > LIE_TIME) {
        p.mode = 'getup';
        p.timer = 0;
        p.lie = Math.PI / 2;
      }
      break;
    }
    case 'getup': {
      p.timer += dt;
      const k = Math.min(1, p.timer / 0.9);
      const ease = k * k * (3 - 2 * k);
      // Back to upright: the nearest whole turn from where we lie.
      const upright = Math.round(p.lie / (Math.PI * 2)) * Math.PI * 2;
      p.angle = p.lie + (upright - p.lie) * ease;
      p.cy = LIE_HEIGHT + (PIVOT - LIE_HEIGHT) * ease;
      if (k >= 1) {
        p.angle = 0;
        p.cy = PIVOT;
        p.action.paused = false;
        startReturn(p);
      }
      break;
    }
  }
}

function startReturn(p: Person) {
  // On the beach there is no pavement to get back to: just carry on.
  if (p.beach) { linger(p); return; }
  p.mode = 'return';
  const near = onEdge(p.edge, p.x, p.z);
  p.from = PEOPLE_EDGES[p.edge].a;
  p.t = near.t;
  p.tx = near.x;
  p.tz = near.z;
}

/** The point of `edge` nearest (x, z), and how far along it from its `a` end. */
function onEdge(edge: number, x: number, z: number) {
  const e = PEOPLE_EDGES[edge];
  const a = PEOPLE_NODES[e.a];
  const b = PEOPLE_NODES[e.b];
  const lx = b.x - a.x;
  const lz = b.z - a.z;
  const k = e.length > 0 ? Math.max(0, Math.min(1, ((x - a.x) * lx + (z - a.z) * lz) / (e.length * e.length))) : 0;
  return { x: a.x + lx * k, z: a.z + lz * k, t: k * e.length };
}

/**
 * How far off their footway's line someone dodging a car (or knocked down
 * and sliding) may go — unless it is out onto the road. The city's
 * footways are narrow, with lawns, walls and benches beside them, and
 * people belong on the footway or the road and nowhere else.
 */
const LEASH = 1.2;
function leash(p: Person) {
  if (isDrivableAt(p.x, p.z)) return;
  const near = onEdge(p.edge, p.x, p.z);
  const dx = p.x - near.x;
  const dz = p.z - near.z;
  const d = Math.hypot(dx, dz);
  if (d <= LEASH) return;
  p.x = near.x + (dx / d) * LEASH;
  p.z = near.z + (dz / d) * LEASH;
}

function pose(p: Person, dt: number, dist: number) {
  const a = p.action;
  if (p.mode === 'walk' || p.mode === 'return' || p.mode === 'wander') {
    a.paused = false;
    a.timeScale = p.speed / CLIP_SPEED;
  } else if (p.mode === 'flee') {
    a.paused = false;
    a.timeScale = RUN_SPEED / CLIP_SPEED;
  } else if (p.mode === 'stand' || p.mode === 'startle' || p.mode === 'linger') {
    // Held on the frame with the feet together.
    a.paused = true;
    a.time = 0;
  }
  // Far ones animate at half rate: nobody can see the difference at 60 m.
  if (dist < 60 || (p.slot + Math.floor(performance.now() / 16)) % 2 === 0) {
    p.mixer.update(dist < 60 ? dt : dt * 2);
  }


  const b = p.body;
  const shadow = dist < SHADOW_RANGE;
  if (p.shadow !== shadow) {
    p.shadow = shadow;
    b.traverse((o) => { if ((o as Mesh).isMesh) o.castShadow = shadow; });
  }
  // The sand's height only changes when they move: looked up then, not every frame.
  if (p.beach && p.mode !== 'stand' && p.mode !== 'linger') {
    p.groundY = beachGroundAt(p.x, p.z) ?? p.groundY;
  }
  b.position.set(p.x, (p.beach ? p.groundY : p.groundY - p.dip) + p.cy, p.z);
  const sway = p.mode === 'stand' || p.mode === 'linger';
  _yaw.setFromAxisAngle(_up, p.yaw + (sway ? Math.sin(performance.now() / 1000 * 0.4 + p.seed) * 0.08 : 0));
  if (p.angle !== 0) {
    _q.setFromAxisAngle(p.axis, p.angle);
    b.quaternion.multiplyQuaternions(_q, _yaw);
  } else if (p.mode === 'flee') {
    // Lean into the run.
    _q.setFromAxisAngle(_side.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)), 0.18);
    b.quaternion.multiplyQuaternions(_q, _yaw);
  } else {
    b.quaternion.copy(_yaw);
  }
}
