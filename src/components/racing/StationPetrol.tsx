'use client';

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  HARBOUR_KERB_X, PETROL, PETROL_PAVING, PETROL_SITE, RAMP_FOOT_Z, pavingTop,
} from '@/config/petrolConfig';
import { partColliders } from './partColliders';
import { trafficMachine, vehicleSize } from './WallOfDeath';

const VEHICLES_MODEL = '/models/vehicles.glb';
useGLTF.preload(PETROL.model, DRACO_PATH);

/** The car park's own asphalt height and colour, so the two read as one surface. */
const PAVE = 0.06;
const BAY = { width: 2.8, depth: 5.8 };
const CARS = ['Hatchback_Body', 'Sedan_Body', 'SUV_Body', 'Compact_Body', 'Wagon_Body', 'Pickup_Body', 'minivan_body', 'Coupe_Body'];
const PAINT = ['#e9e9e6', '#c7c9cc', '#2b2d30', '#7b1f24', '#1f3b6e', '#5d6468', '#9ea2a6'];

/** A flat strip from x0 to x1 between z0 and a top edge that follows `top(x)`, in 2 m steps. */
function strip(x0: number, x1: number, z0: number, top: (x: number) => number): BufferGeometry | null {
  const pos: number[] = [];
  const steps = Math.max(1, Math.ceil((x1 - x0) / 2));
  for (let i = 0; i < steps; i++) {
    const a = x0 + ((x1 - x0) * i) / steps;
    const b = x0 + ((x1 - x0) * (i + 1)) / steps;
    const ta = top(a);
    const tb = top(b);
    if (ta <= z0 + 0.2 && tb <= z0 + 0.2) continue;
    const za = Math.max(z0, ta);
    const zb = Math.max(z0, tb);
    // Two triangles, wound to face up.
    pos.push(a, PAVE, z0, a, PAVE, za, b, PAVE, zb, a, PAVE, z0, b, PAVE, zb, b, PAVE, z0);
  }
  if (!pos.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function layout() {
  let seed = 61;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const P = PETROL_PAVING;
  const S = PETROL_SITE;
  const fenceTop = (x: number) => pavingTop(x) - 0.4;
  const asphalt = [
    // One sheet from the harbour road to the car park, under the station too:
    // the station's own floor was taken off (`prepare-petrol.mjs`).
    strip(P.x0, P.x1, P.z0, fenceTop),
  ].filter((g): g is BufferGeometry => g !== null);

  const white: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const mesh: BufferGeometry[] = [];
  const kerb: BufferGeometry[] = [];
  const lamps: BufferGeometry[] = [];
  const colliders: Array<{ half: [number, number, number]; centre: [number, number, number]; turn: number }> = [];
  const cars: Array<{ name: string; tint: string; x: number; z: number; turn: number }> = [];

  /* The railway fence along the paving's top edge, from the harbour road to the car park. */
  for (let x = P.x0; x < P.x1 - 0.5; x += 3) {
    const xb = Math.min(P.x1, x + 3);
    const za = fenceTop(x) + 0.2;
    const zb = fenceTop(xb) + 0.2;
    const len = Math.hypot(xb - x, zb - za);
    const turn = -Math.atan2(zb - za, xb - x);
    mesh.push(new BoxGeometry(len, 1.8, 0.04).rotateY(turn).translate((x + xb) / 2, 0.9, (za + zb) / 2));
    steel.push(new BoxGeometry(len, 0.06, 0.06).rotateY(turn).translate((x + xb) / 2, 1.78, (za + zb) / 2));
    steel.push(new BoxGeometry(0.08, 1.8, 0.08).translate(x, 0.9, za));
    colliders.push({ half: [len / 2, 0.9, 0.1], centre: [(x + xb) / 2, 0.9, (za + zb) / 2], turn });
  }

  /*
   * The harbour road side. Open where the road is on the level, so you drive
   * straight in off it; north of where it starts to lift for the crossing, a
   * kerb and the fence, because there the road is above the paving.
   */
  const rampTop = fenceTop(HARBOUR_KERB_X);
  if (rampTop > RAMP_FOOT_Z) {
    kerb.push(new BoxGeometry(0.3, 0.2, rampTop - RAMP_FOOT_Z).translate(HARBOUR_KERB_X + 0.4, PAVE + 0.1, (RAMP_FOOT_Z + rampTop) / 2));
    mesh.push(new BoxGeometry(0.04, 1.8, rampTop - RAMP_FOOT_Z).translate(HARBOUR_KERB_X + 0.6, 0.9, (RAMP_FOOT_Z + rampTop) / 2));
    colliders.push({ half: [0.15, 0.9, (rampTop - RAMP_FOOT_Z) / 2], centre: [HARBOUR_KERB_X + 0.6, 0.9, (RAMP_FOOT_Z + rampTop) / 2], turn: 0 });
  }

  /* Bays along the fence behind the station, nose to the railway, where there is room for a row. */
  const row = (x0: number, x1: number, z0: number, nose: 1 | -1, fill: number) => {
    for (let x = x0; x + BAY.width <= x1; x += BAY.width) {
      const back = nose > 0 ? z0 : z0 - BAY.depth;
      white.push(new BoxGeometry(0.12, 0.02, BAY.depth).translate(x, PAVE + 0.01, back + BAY.depth / 2));
      if (rnd() > fill) continue;
      const name = CARS[Math.floor(rnd() * CARS.length)];
      const length = vehicleSize(name)[2];
      const reversed = rnd() < 0.3;
      cars.push({
        name, tint: PAINT[Math.floor(rnd() * PAINT.length)],
        x: x + BAY.width / 2 + (rnd() - 0.5) * 0.3,
        z: nose > 0 ? z0 + BAY.depth - length / 2 - 0.4 : z0 - BAY.depth + length / 2 + 0.4,
        // Nose at −z for a traffic car at turn 0.
        turn: ((nose > 0) !== reversed ? Math.PI : 0) + (rnd() - 0.5) * 0.08,
      });
    }
    white.push(new BoxGeometry(0.12, 0.02, BAY.depth).translate(x0 + Math.floor((x1 - x0) / BAY.width) * BAY.width, PAVE + 0.01, (nose > 0 ? z0 : z0 - BAY.depth) + BAY.depth / 2));
  };
  {
    // Behind the station: as far west as the fence leaves a bay's depth plus an aisle's width.
    let from = S.x1 - 1;
    while (from > S.x0 && fenceTop(from - 3) - S.z1 > BAY.depth + 6.5) from -= BAY.width;
    const z0 = S.z1 + 6.5;
    if (S.x1 - 1 - from > BAY.width * 2) row(from, S.x1 - 1, z0, 1, 0.45);
    // The open apron off the harbour road: a short row along its north edge.
    const west = HARBOUR_KERB_X + 2;
    const z1 = Math.min(fenceTop(west), fenceTop(S.x0)) - 0.6;
    row(west, S.x0 - 2, z1, -1, 0.5);
  }

  /* Lamps on the apron and behind the station. */
  for (const [x, z] of [[HARBOUR_KERB_X + 9, 281], [S.x0 - 6, S.z1 - 4], [(S.x0 + S.x1) / 2, S.z1 + 4], [S.x1 - 6, S.z1 + 4]] as Array<[number, number]>) {
    steel.push(new BoxGeometry(0.16, 8, 0.16).translate(x, 4, z));
    lamps.push(new BoxGeometry(0.6, 0.12, 0.6).translate(x, 7.9, z));
    colliders.push({ half: [0.15, 4, 0.15], centre: [x, 4, z], turn: 0 });
  }

  const merge = (list: BufferGeometry[]) => (
    list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
  );
  return {
    asphalt: merge(asphalt), white: merge(white), steel: merge(steel), mesh: merge(mesh), kerb: merge(kerb),
    lamps: merge(lamps), colliders, cars,
  };
}

/**
 * The petrol station at the west end of the car park — see `petrolConfig`.
 * Drawn inside `IslandRail`, x along the line and z across it.
 */
export default function StationPetrol() {
  const built = useMemo(() => layout(), []);
  const { scene } = useGLTF(PETROL.model, DRACO_PATH);
  const vehicles = useGLTF(VEHICLES_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const station = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }, [scene]);
  const cars = useMemo(() => built.cars.map((c) => trafficMachine(vehicles, c.name, c.tint).root), [built.cars, vehicles]);
  const S = PETROL_SITE;

  return (
    <group>
      <group position={[S.x, PAVE, S.z]} rotation={[0, S.turn, 0]}>
        <primitive object={station} />
      </group>
      {built.asphalt && (
        <mesh geometry={built.asphalt} receiveShadow>
          <meshStandardMaterial color="#3a3c40" roughness={0.95} />
        </mesh>
      )}
      {built.white && (
        <mesh geometry={built.white}>
          <meshStandardMaterial color="#e8e8e2" roughness={0.7} />
        </mesh>
      )}
      {built.kerb && (
        <mesh geometry={built.kerb} castShadow receiveShadow>
          <meshStandardMaterial color="#b5b2aa" roughness={0.9} />
        </mesh>
      )}
      {built.steel && (
        <mesh geometry={built.steel} castShadow>
          <meshStandardMaterial color="#3e4a52" roughness={0.45} metalness={0.5} />
        </mesh>
      )}
      {built.mesh && (
        <mesh geometry={built.mesh}>
          <meshStandardMaterial color="#2c3238" roughness={0.6} metalness={0.4} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      )}
      {built.lamps && (
        <mesh geometry={built.lamps}>
          <meshStandardMaterial color="#fff6dc" emissive="#ffe7b0" emissiveIntensity={0.9} />
        </mesh>
      )}
      {built.cars.map((c, i) => (
        <group key={i} position={[c.x, PAVE, c.z]} rotation={[0, c.turn, 0]}>
          <primitive object={cars[i]} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {partColliders('petrol', S.x, S.z, S.turn, PETROL.size, 'petrol')}
        {built.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.centre} rotation={[0, c.turn, 0]} />
        ))}
        {built.cars.map((c, i) => {
          const size = vehicleSize(c.name);
          return (
            <CuboidCollider
              key={`car-${i}`}
              args={[size[0] / 2, size[1] / 2, size[2] / 2]}
              position={[c.x, PAVE + size[1] / 2, c.z]}
              rotation={[0, c.turn, 0]}
            />
          );
        })}
      </RigidBody>
    </group>
  );
}
