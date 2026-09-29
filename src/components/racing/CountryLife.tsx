'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  AnimationMixer, BufferGeometry, DoubleSide, Float32BufferAttribute, InstancedMesh, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, Vector3, type AnimationAction, type Object3D,
} from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import countryModels from '@/config/countryModelData.json';
import {
  HARBOUR, HILL_FARM, HOME_FARM, POULTRY, WOOD, coastClearance, groundAt, lakeFraction, makeRandom,
  railEdgeAt, roadEdgeAt, streamDistanceAt,
} from '@/config/countryConfig';
import {
  FIELDS, PADDOCK_FENCE, POULTRY_FENCE, inBeach, inBuiltZone, inWood, nearTrack, pointInPolygon, type Field,
  type Pt,
} from '@/config/countryFields';

/**
 * What lives on Skylark.
 *
 * Cattle in the pastures by Home Farm, sheep on the downs, horses in the
 * paddock, chickens in the farmyards and rooks over the wood.
 *
 * Every animal is a DOWNLOADED model now. They began as boxes and spheres
 * with vertex colours, because the first brief let nothing new be downloaded
 * and an animal at fifty metres is a shape and a colour; as the user added
 * models the boxes were replaced one at a time, and the last of them — the
 * Herefords, the horses and the pond's ducks — went when the chicken and the
 * horse arrived. Nothing here is procedural any more but the rooks and gulls
 * wheeling overhead, which no download covers, and the pond's ducks, which
 * `CountryWater` places out of the pond pack.
 *
 * A herd is a `useFrame` over a plain array: pick a spot in its own field,
 * walk to it, graze, repeat, and never onto the lane. What sells it is that
 * they move like animals — head down for a long time, walk somewhere slowly,
 * stop — and the clip plays only while one is actually walking.
 */

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

/** The downloaded animals — see `prepare-country.mjs` for what was done to them. */
const SHEEP_MODEL = '/models/country/sheep.glb';
const COW_MODEL = '/models/country/cow.glb';
const CHICKEN_MODEL = '/models/country/chicken.glb';
const HORSE_MODEL = '/models/country/horse.glb';
for (const model of [SHEEP_MODEL, COW_MODEL, CHICKEN_MODEL, HORSE_MODEL]) useGLTF.preload(model, DRACO_PATH);
/**
 * Which way each model faces, added to the animal's heading. They arrive with
 * the head down −Z, which is the convention the herds walk in; flip one here
 * if a model ever turns up walking backwards.
 */
const SHEEP_FACING = 0;
const COW_FACING = 0;
const CHICKEN_FACING = 0;
const HORSE_FACING = 0;

/* ------------------------------------------------------------ shapes */

function rookGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([
    -0.75, 0.12, -0.12, 0, 0, 0.35, 0, 0, -0.22,
    0, 0, 0.35, 0.75, 0.12, -0.12, 0, 0, -0.22,
  ], 3));
  g.computeVertexNormals();
  return g;
}

/* --------------------------------------------------------- the herds */

interface Animal {
  x: number;
  z: number;
  y: number;
  heading: number;
  targetX: number;
  targetZ: number;
  state: 'graze' | 'walk';
  timer: number;
  speed: number;
  pitch: number;
  phase: number;
}

interface SkinnedSpec {
  key: string;
  model: string;
  /**
   * `walk` steps the animal about its field and plays its clip only while it
   * is moving; `idle` leaves it where it was put and plays an idle; `still`
   * is for a model that arrived with no clip at all — the horse — which
   * stands, because a model sliding across a field with its legs locked is
   * worse than one standing in it.
   */
  mode: 'walk' | 'idle' | 'still';
  facing: number;
  /** The clip to walk on, when the file names it something of its own. */
  clip?: string;
  animals: Animal[];
  home: (x: number, z: number) => boolean;
  scale?: number;
}

const okGround = (x: number, z: number) => (
  roadEdgeAt(x, z) > 5.5
  && !inBuiltZone(x, z, 5)
  && lakeFraction(x, z) > 1.3
  && !nearTrack(x, z, 3)
  && coastClearance(x, z) > 30
  && !inWood(x, z, 1.05)
  && !inBeach(x, z, 6)
  && streamDistanceAt(x, z) > 5
  && railEdgeAt(x, z) > 5
);

const fieldHome = (f: Field) => (x: number, z: number) => pointInPolygon(f.polygon, x, z) && okGround(x, z);

function spot(rnd: () => number, f: ReadonlyArray<Pt>, home: (x: number, z: number) => boolean): Pt | null {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const [x, z] of f) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  for (let t = 0; t < 30; t++) {
    const x = x0 + rnd() * (x1 - x0);
    const z = z0 + rnd() * (z1 - z0);
    if (home(x, z)) return [x, z];
  }
  return null;
}

function populate(rnd: () => number, poly: ReadonlyArray<Pt>, home: (x: number, z: number) => boolean, count: number, speed: number): Animal[] {
  const out: Animal[] = [];
  for (let i = 0; i < count; i++) {
    const p = spot(rnd, poly, home);
    if (!p) continue;
    out.push({
      x: p[0], z: p[1], y: groundAt(p[0], p[1]), heading: rnd() * TAU, targetX: p[0], targetZ: p[1],
      state: 'graze', timer: 2 + rnd() * 12, speed, pitch: -1, phase: rnd() * TAU,
    });
  }
  return out;
}

function buildHerds(): SkinnedSpec[] {
  const rnd = makeRandom(53);
  const skinned: SkinnedSpec[] = [];
  // Dairy cattle in the four pastures nearest Home Farm. The fourth used to
  // be a box herd of Herefords, to give the parish a second breed; it is the
  // same model as the rest now, a shade smaller, because the user asked for
  // the downloads and against a real cow a box is a box.
  const pastures = FIELDS
    .filter((f) => f.crop === 'pasture' && f.area > 8000)
    .sort((a, b) => Math.hypot(a.seed[0] - HOME_FARM.x, a.seed[1] - HOME_FARM.z)
      - Math.hypot(b.seed[0] - HOME_FARM.x, b.seed[1] - HOME_FARM.z));
  pastures.slice(0, 4).forEach((f, i) => {
    skinned.push({
      key: `dairy${i}`, model: COW_MODEL, mode: 'idle', facing: COW_FACING,
      animals: populate(rnd, f.polygon, fieldHome(f), i === 3 ? 10 : 8, 0), home: fieldHome(f),
      scale: i === 3 ? 0.92 : 1,
    });
  });
  const downs = FIELDS.filter((f) => f.crop === 'downs' || f.crop === 'rough');
  downs.forEach((f, i) => {
    skinned.push({
      key: `sheep${i}`, model: SHEEP_MODEL, mode: 'walk', facing: SHEEP_FACING,
      clip: countryModels.life.sheep.clip ?? undefined,
      animals: populate(rnd, f.polygon, fieldHome(f), f.crop === 'downs' ? 6 : 3, 0.7), home: fieldHome(f),
    });
  });
  // The paddock: four horses, standing. The model carries no clip.
  const paddockHome = (x: number, z: number) => pointInPolygon(PADDOCK_FENCE, x, z) && roadEdgeAt(x, z) > 2.5;
  skinned.push({
    key: 'horses', model: HORSE_MODEL, mode: 'still', facing: HORSE_FACING,
    animals: populate(rnd, PADDOCK_FENCE, paddockHome, 4, 0), home: paddockHome,
  });
  // The poultry farm beside the paddock: the flock proper, out in its run.
  // Kept a metre inside the netting so a bird never stands in the wire.
  {
    const run: Pt[] = POULTRY_FENCE;
    const home = (x: number, z: number) => pointInPolygon(run, x, z)
      && roadEdgeAt(x, z) > 2 && Math.hypot(x - POULTRY.x, z - POULTRY.z) < POULTRY.w / 2 - 1;
    skinned.push({
      key: 'poultry', model: CHICKEN_MODEL, mode: 'walk', facing: CHICKEN_FACING,
      clip: countryModels.life.chicken.clip ?? undefined,
      animals: populate(rnd, run, home, 34, 0.45), home,
    });
  }
  // Chickens loose in both farmyards too, pecking about. They keep to a
  // circle round the yard rather than a field: a hen does not cross a parish.
  for (const [i, farm] of [HOME_FARM, HILL_FARM].entries()) {
    const r = Math.min(24, farm.r - 8);
    const yard: Pt[] = Array.from({ length: 12 }, (_, k) => {
      const t = (k / 12) * TAU;
      return [farm.x + r * Math.cos(t), farm.z + r * Math.sin(t)] as Pt;
    });
    const home = (x: number, z: number) => (
      Math.hypot(x - farm.x, z - farm.z) < r && roadEdgeAt(x, z) > 3 && railEdgeAt(x, z) > 3
    );
    skinned.push({
      key: `hens${i}`, model: CHICKEN_MODEL, mode: 'walk', facing: CHICKEN_FACING,
      clip: countryModels.life.chicken.clip ?? undefined,
      animals: populate(rnd, yard, home, 9, 0.45), home,
    });
  }
  return skinned;
}

/* -------------------------------------------------------------- birds */

interface Bird { radius: number; angle: number; rate: number; height: number; phase: number }

/** A flock wheeling over a point: rooks over the wood, gulls over the harbour. */
function Flock({ cx, cz, base, colour, count, radius, height, seed, scale = 1 }: {
  cx: number; cz: number; base: number; colour: string; count: number;
  radius: [number, number]; height: [number, number]; seed: number; scale?: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const rooks = useMemo<Bird[]>(() => {
    const rnd = makeRandom(seed);
    return Array.from({ length: count }, () => ({
      radius: radius[0] + rnd() * (radius[1] - radius[0]), angle: rnd() * TAU,
      rate: (0.22 + rnd() * 0.12) * (rnd() < 0.8 ? 1 : -1),
      height: height[0] + rnd() * (height[1] - height[0]), phase: rnd() * TAU,
    }));
  }, [count, radius, height, seed]);
  const geometry = useMemo(() => rookGeometry(), []);
  const material = useMemo(() => new MeshStandardMaterial({ color: colour, side: DoubleSide, roughness: 1 }), [colour]);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  const m = useMemo(() => new Matrix4(), []);
  const q = useMemo(() => new Quaternion(), []);
  const q2 = useMemo(() => new Quaternion(), []);
  const p = useMemo(() => new Vector3(), []);
  const s = useMemo(() => new Vector3(scale, scale, scale), [scale]);
  useFrame((state, dt) => {
    const inst = mesh.current;
    if (!inst) return;
    const step = Math.min(0.05, dt);
    const t = state.clock.elapsedTime;
    rooks.forEach((r, i) => {
      r.angle += r.rate * step;
      const x = cx + Math.cos(r.angle) * r.radius;
      const z = cz + Math.sin(r.angle) * r.radius;
      const y = base + r.height + Math.sin(t * 0.7 + r.phase) * 4;
      // Along the circle: the tangent, which way round it goes.
      const heading = Math.atan2(-Math.sin(r.angle) * r.rate, Math.cos(r.angle) * r.rate);
      q.setFromAxisAngle(UP, heading);
      q2.setFromAxisAngle(new Vector3(0, 0, 1), Math.sin(t * 7 + r.phase) * 0.55);
      q.multiply(q2);
      p.set(x, y, z);
      inst.setMatrixAt(i, m.compose(p, q, s));
    });
    inst.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[geometry, material, rooks.length]} frustumCulled={false} />
  );
}

/* -------------------------------------------------------------- herds */

/**
 * One animal's step: grazing for a while, then a walk to somewhere in its own
 * field that does not cross a lane, then grazing again. Shared by the box
 * herds and the skinned ones, which differ only in what is drawn.
 */
function stepAnimal(a: Animal, home: (x: number, z: number) => boolean, rnd: () => number, step: number) {
  if (a.state === 'graze') {
    a.timer -= step;
    if (a.timer <= 0) {
      let found = false;
      for (let k = 0; k < 6 && !found; k++) {
        const d = 6 + rnd() * 30;
        const ang = rnd() * TAU;
        const tx = a.x + Math.cos(ang) * d;
        const tz = a.z + Math.sin(ang) * d;
        if (!home(tx, tz)) continue;
        let crosses = false;
        for (let u = 0.25; u < 1 && !crosses; u += 0.25) {
          if (!home(a.x + (tx - a.x) * u, a.z + (tz - a.z) * u)) crosses = true;
        }
        if (crosses) continue;
        a.targetX = tx;
        a.targetZ = tz;
        a.state = 'walk';
        found = true;
      }
      if (!found) a.timer = 3 + rnd() * 6;
    }
  } else {
    const dx = a.targetX - a.x;
    const dz = a.targetZ - a.z;
    const dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    let diff = want - a.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    a.heading += Math.max(-1.6 * step, Math.min(1.6 * step, diff));
    if (Math.abs(diff) < 0.6) {
      a.x += Math.sin(a.heading) * a.speed * step;
      a.z += Math.cos(a.heading) * a.speed * step;
    }
    if (dist < 0.7) {
      a.state = 'graze';
      a.timer = 5 + rnd() * 16;
    }
  }
}

/**
 * A herd of the downloaded animals: one skinned clone and one mixer each.
 *
 * The sheep have a walk cycle and walk the same way the boxes did, the clip
 * running while they move and held at its first frame while they graze. The
 * cow's file has no walk in it — idles and, being a game asset, two attacks
 * and a death — so the cows stand where they were put, in one idle or the
 * other, and turn their heads; a cow that slid across a field to a walk it
 * did not have would be worse than one that stands still.
 */
function SkinnedHerd({ model, animals, home, mode, facing, clip: clipName, scale = 1, seed }: {
  model: string;
  animals: Animal[];
  home: (x: number, z: number) => boolean;
  mode: 'walk' | 'idle' | 'still';
  facing: number;
  clip?: string;
  scale?: number;
  seed: number;
}) {
  const { scene, animations } = useGLTF(model, DRACO_PATH);
  const rnd = useMemo(() => makeRandom(seed), [seed]);
  const clones = useMemo(() => animals.map((a, i) => {
    const object = skeletonClone(scene);
    object.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    const mixer = new AnimationMixer(object);
    let action: AnimationAction | null = null;
    if (mode === 'walk') {
      const clip = animations.find((c) => c.name === clipName) ?? animations[0];
      if (clip) {
        action = mixer.clipAction(clip);
        action.play();
        action.time = (i * 0.37) % clip.duration;
        action.paused = true;
      }
    } else {
      const idles = animations.filter((c) => /idle/i.test(c.name));
      const clip = idles[i % Math.max(1, idles.length)] ?? animations[0];
      if (clip) {
        action = mixer.clipAction(clip);
        action.play();
        action.time = (i * 0.61) % clip.duration;
      }
    }
    if (scale !== 1) object.scale.setScalar(scale);
    mixer.update(0);
    return { object, mixer, action, walking: false };
  }), [scene, animations, animals, mode, clipName, scale]);

  useEffect(() => () => { for (const c of clones) c.mixer.stopAllAction(); }, [clones]);

  useFrame((_, dt) => {
    const step = Math.min(0.05, dt);
    animals.forEach((a, i) => {
      const c = clones[i];
      if (!c) return;
      if (mode === 'walk') {
        stepAnimal(a, home, rnd, step);
        const walking = a.state === 'walk';
        if (walking !== c.walking && c.action) {
          c.action.paused = !walking;
          if (!walking) { c.action.time = 0; c.mixer.update(0); }
          c.walking = walking;
        }
      }
      a.y = groundAt(a.x, a.z);
      c.object.position.set(a.x, a.y, a.z);
      c.object.rotation.y = a.heading + facing;
      c.mixer.update(step);
    });
  });

  return <>{clones.map((c, i) => <primitive key={i} object={c.object as Object3D} />)}</>;
}

export function CountryLife() {
  const skinned = useMemo(() => buildHerds(), []);
  useEffect(() => {
    const total = skinned.reduce((n, h) => n + h.animals.length, 0);
    console.info(`[country] ${total} animals in ${skinned.length} herds, all modelled`);
  }, [skinned]);
  return (
    <group>
      {skinned.map((h, i) => (
        <SkinnedHerd
          key={h.key}
          model={h.model}
          animals={h.animals}
          home={h.home}
          mode={h.mode}
          facing={h.facing}
          clip={h.clip}
          scale={h.scale}
          seed={101 + i}
        />
      ))}
      <Flock
        cx={WOOD.x - 12} cz={WOOD.z + 8} base={groundAt(WOOD.x - 12, WOOD.z + 8)} colour="#141312"
        count={24} radius={[40, 90]} height={[34, 56]} seed={67}
      />
      <Flock
        cx={HARBOUR.x + HARBOUR.out[0] * 50} cz={HARBOUR.z + HARBOUR.out[1] * 50} base={HARBOUR.quayY}
        colour="#ecece8" count={18} radius={[16, 70]} height={[6, 30]} seed={71} scale={0.8}
      />
    </group>
  );
}
