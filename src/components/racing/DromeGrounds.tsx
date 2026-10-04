'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, Group, Mesh, Object3D, PlaneGeometry, SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { PARK_COLOURS } from '@/config/parkConfig';
import { AQUA_SITE } from '@/config/aquaParkConfig';
import { COURIER_HUB } from '@/config/islandRailConfig';
import {
  APRON, DROME_SHAPE, FURNITURE, GALLERY, PARKED_CARS, PORTAL, STAIRS, WOD_SITE,
} from '@/config/wallOfDeathConfig';
import { flagTexture } from './AquaPark';
import { trafficMachine } from './WallOfDeath';

const PARK_MODEL = '/models/park.glb';
const VEHICLES_MODEL = '/models/vehicles.glb';
useGLTF.preload(PARK_MODEL, DRACO_PATH);
useGLTF.preload(VEHICLES_MODEL, DRACO_PATH);

/**
 * The Wall of Death's grounds: a clean plaza round the drome and its gate.
 *
 * The plot — the parcel hub's edge to the aqua park, the road to the railway
 * hedge — is paved in Halcyon Pier's flagstones, so the drome, the aqua park
 * and the fairground across the road read as one park. On it, kept sparse:
 * benches, park lamps, corner trees, a low hedge along the railway.
 *
 * The way in is designed in the drum's own teal, cream and gold:
 *
 * - **the gate** at the road's edge — two tapered teal pylons on cream
 *   plinths, a gold line of light up each, and a lit header reading WALL OF
 *   DEATH both ways, with the stunt team's red car hung nose-down beneath it,
 *   swaying a little, high enough to drive under;
 * - **planter beds** lining the way in from the gate to the drum, hedged;
 * - **a medallion** set in the paving round the entry halo, teal with a
 *   cream ring.
 *
 * Drawn inside `AirportIsland`'s group.
 */

const C = { x: WOD_SITE.along, z: WOD_SITE.across };
/** The plot: hub's east edge to the aqua park, the road's kerb to the railway hedge. */
const PLOT = { x0: COURIER_HUB.east, x1: AQUA_SITE.plaza.x0 - 1, z0: APRON.path.to, z1: 330 } as const;
const PAVE = 0.05;

type Placed = { part: string; x: number; z: number; turn: number; scale?: number; y?: number };

/** A stunt car: which traffic body, its paint, where its origin goes, and how it is turned (XYZ Euler). */
interface StuntCar { name: string; tint: string; x: number; y: number; z: number; rx: number; ry: number; rz: number; hang: boolean }

/** The gate's header sign: cream capitals on the drome's teal, a gold rule under them. */
function gateSign(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1f6b73';
  g.fillRect(0, 0, 1024, 128);
  g.fillStyle = '#f3ecdc';
  g.font = 'bold 76px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('WALL  OF  DEATH', 512, 58);
  g.fillStyle = '#f2c766';
  g.fillRect(212, 104, 600, 5);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Inside the plot and clear of the drum, its stairs, the way in and the things already there. */
function clear(x: number, z: number, r: number): boolean {
  if (x - r < PLOT.x0 + 0.5 || x + r > PLOT.x1 - 0.5 || z - r < PLOT.z0 + 0.5 || z + r > PLOT.z1 - 0.5) return false;
  // The drum and its gallery's stairs, which run down both sides.
  if (Math.hypot(x - C.x, z - C.z) < DROME_SHAPE.topRadius + GALLERY.width + r + 0.5) return false;
  for (const phi of STAIRS.at) {
    const sx = C.x + Math.sin(phi) * (DROME_SHAPE.topRadius + 2);
    if (Math.abs(x - sx) < r + 3 && Math.abs(z - C.z) < 18) return false;
  }
  // The way in from the road, and the halo.
  if (Math.abs(x - C.x) < APRON.path.half + 3 + r && z < C.z + PORTAL.entry.dz + 6) return false;
  // The totem, the kiosk and the parked cars and bike.
  const taken: Array<[number, number, number]> = [
    [FURNITURE.pylon.dx, FURNITURE.pylon.dz, 2], [FURNITURE.kiosk.dx, FURNITURE.kiosk.dz, 3],
    ...PARKED_CARS.filter((c) => Math.hypot(c.dx, c.dz) > 15).map((c) => [c.dx, c.dz, 3.5] as [number, number, number]),
    [13, -27, 2], [PORTAL.exit.dx, PORTAL.exit.dz, PORTAL.radius],
  ];
  return taken.every(([dx, dz, rr]) => Math.hypot(x - (C.x + dx), z - (C.z + dz)) > rr + r);
}

function layout() {
  let seed = 17;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const parts: Placed[] = [];
  const steel: BufferGeometry[] = [];
  const teal: BufferGeometry[] = [];
  const cream: BufferGeometry[] = [];
  const gold: BufferGeometry[] = [];
  const chain: BufferGeometry[] = [];
  const signs: Array<{ x: number; y: number; z: number; w: number; h: number; turn: number }> = [];
  const inlay: Array<{ x: number; z: number; r: number }> = [];
  const box = (list: BufferGeometry[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => {
    list.push(new BoxGeometry(sx, sy, sz).translate(cx, cy, cz));
  };
  const colliders: Array<{ half: [number, number, number]; centre: [number, number, number] }> = [];
  const solid = (x: number, z: number, hx: number, hy: number, hz: number) => colliders.push({ half: [hx, hy, hz], centre: [x, hy, z] });

  /* ----- the paving: one slab over the whole plot, under the drum's own plinth ----- */
  const paving = new PlaneGeometry(PLOT.x1 - PLOT.x0, PLOT.z1 - PLOT.z0).rotateX(-Math.PI / 2)
    .translate((PLOT.x0 + PLOT.x1) / 2, PAVE, (PLOT.z0 + PLOT.z1) / 2);
  {
    const pos = paving.getAttribute('position');
    const uv = paving.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / PARK_COLOURS.slab, pos.getZ(i) / PARK_COLOURS.slab);
  }

  /* ----- the stunt pieces ----- */
  const cars: StuntCar[] = [];

  // The entrance gate, at the road's edge, framing the way in.
  const GATE = { z: PLOT.z0 + 2.2, half: 9.2, height: 12, pylon: 1.5 };
  for (const side of [-1, 1]) {
    const x = C.x + side * GATE.half;
    // A tapered teal pylon on a plinth, with a cream cap and a gold line of light up its inner face.
    const shaft = new CylinderGeometry(GATE.pylon * 0.48, GATE.pylon * 0.68, GATE.height, 4, 1);
    shaft.rotateY(Math.PI / 4);
    teal.push(shaft.translate(x, GATE.height / 2 + 0.4, GATE.z));
    box(cream, x, 0.2, GATE.z, GATE.pylon + 1.2, 0.4, GATE.pylon + 1.2);
    box(cream, x, GATE.height + 0.55, GATE.z, GATE.pylon + 0.3, 0.3, GATE.pylon + 0.3);
    box(gold, x - side * 0.62, GATE.height / 2 + 0.6, GATE.z, 0.06, GATE.height - 2.2, 0.5);
    solid(x, GATE.z, 1.3, GATE.height / 2, 1.3);
  }
  // The header: cream beam, teal sign panel both faces, gold strip under it.
  const headY = GATE.height - 0.6;
  box(cream, C.x, headY + 1.3, GATE.z, GATE.half * 2 + 1.2, 0.35, 1.3);
  box(teal, C.x, headY, GATE.z, GATE.half * 2 - 1.2, 2.3, 0.9);
  box(gold, C.x, headY - 1.2, GATE.z, GATE.half * 2 - 1.2, 0.1, 1.0);
  signs.push({ x: C.x, y: headY, z: GATE.z - 0.47, w: GATE.half * 2 - 2.4, h: 1.9, turn: Math.PI });
  signs.push({ x: C.x, y: headY, z: GATE.z + 0.47, w: GATE.half * 2 - 2.4, h: 1.9, turn: 0 });
  // The red sports car hung nose-down from the header, tail a metre under it.
  cars.push({
    name: 'Sport_body', tint: '#d4161c', x: C.x, y: headY - 1.25 - 1.0 - 2.25, z: GATE.z + 0.2,
    rx: -Math.PI / 2, ry: 0.3, rz: 0, hang: true,
  });
  for (const dx of [-0.6, 0.6]) box(chain, C.x + dx, headY - 1.25 - 0.5, GATE.z + 0.2, 0.05, 1.0, 0.05);

  // Planter beds lining the way in, between the gate and the drum, hedged on top.
  for (const side of [-1, 1]) {
    const x = C.x + side * (APRON.path.half + 2.6);
    const z0 = GATE.z + 2;
    const z1 = C.z - DROME_SHAPE.topRadius - GALLERY.width - 1;
    box(cream, x, 0.3, (z0 + z1) / 2, 1.6, 0.6, z1 - z0);
    solid(x, (z0 + z1) / 2, 0.8, 0.3, (z1 - z0) / 2);
    for (let z = z0 + 1; z < z1 - 0.5; z += 1.6) parts.push({ part: 'bushLow', x, z, turn: Math.PI / 2, y: 0.6 });
  }
  // The medallion: a teal disc with a cream ring, set in the paving under the entry halo.
  inlay.push({ x: C.x, z: C.z + PORTAL.entry.dz, r: PORTAL.radius + 2.2 });

  // Benches, back to the drum, round the ring where there is room; bins between.
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 + 0.13;
    const r = DROME_SHAPE.topRadius + GALLERY.width + 3.4;
    const x = C.x + Math.sin(a) * r;
    const z = C.z - Math.cos(a) * r;
    if (!clear(x, z, 1.2)) continue;
    parts.push({ part: k % 3 === 2 ? 'bin' : 'bench', x, z, turn: -a + Math.PI / 2 });
    solid(x, z, 0.5, 0.4, 0.5);
  }
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + 0.2;
    const r = 33;
    const x = C.x + Math.sin(a) * r;
    const z = C.z - Math.cos(a) * r;
    if (!clear(x, z, 0.6)) continue;
    parts.push({ part: 'lamp', x, z, turn: 0 });
    solid(x, z, 0.2, 1.4, 0.2);
  }
  /* ----- trees in the corners, and a hedge screening the railway ----- */
  for (const [x, z, part] of [
    [PLOT.x0 + 5, 327, 'treeBroad'], [PLOT.x1 - 4.5, 326, 'treeBroad'],
    [PLOT.x1 - 4, 271, 'treeSlim'], [PLOT.x1 - 3, 312, 'treeTall'],
  ] as Array<[number, number, string]>) {
    if (!clear(x, z, 1.5)) continue;
    parts.push({ part: 'planter', x, z, turn: 0 });
    parts.push({ part, x, z, turn: rnd() * Math.PI * 2, scale: 0.75 });
    solid(x, z, 0.6, 3, 0.6);
  }
  for (let x = PLOT.x0 + 1.5; x < PLOT.x1 - 1; x += 2.2) {
    const z = PLOT.z1 - 0.9;
    if (Math.hypot(x - C.x, z - C.z) < DROME_SHAPE.topRadius + 1) continue;
    parts.push({ part: 'bushLow', x, z, turn: 0 });
  }

  const merge = (list: BufferGeometry[]) => (list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null);
  return {
    paving,
    steel: merge(steel), teal: merge(teal), cream: merge(cream), gold: merge(gold), chain: merge(chain),
    parts, colliders, cars, signs, inlay,
  };
}

/** The hung car sways, very slightly, on its chains. */
function HangingCar({ object, car }: { object: Object3D; car: StuntCar }) {
  const pivot = useRef<Group>(null);
  useFrame((state) => {
    if (!pivot.current) return;
    const t = state.clock.elapsedTime;
    pivot.current.rotation.z = Math.sin(t * 0.7) * 0.035;
    pivot.current.rotation.x = Math.sin(t * 0.45 + 1) * 0.02;
  });
  return (
    <group ref={pivot} position={[car.x, car.y + 1.6, car.z]}>
      <group position={[0, -1.6, 0]} rotation={[car.rx, car.ry, car.rz, 'YXZ']}>
        <primitive object={object} />
      </group>
    </group>
  );
}

export function DromeGrounds() {
  const built = useMemo(() => layout(), []);
  const flags = useMemo(() => flagTexture(), []);
  const sign = useMemo(() => gateSign(), []);
  const park = useGLTF(PARK_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const vehicles = useGLTF(VEHICLES_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const cars = useMemo(() => built.cars.map((c) => {
    const root = trafficMachine(vehicles, c.name, c.tint).root;
    root.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return root;
  }), [built.cars, vehicles]);
  const objects = useMemo(() => built.parts.map((p) => {
    const node = park.getObjectByName(p.part);
    if (!node) return null;
    const group = new Group();
    // Meshes only, not the node: the node's own transform is where it stood in the park.
    node.updateWorldMatrix(true, true);
    const inverse = node.matrixWorld.clone().invert();
    node.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const m = new Mesh(o.geometry, o.material);
      m.applyMatrix4(inverse.clone().multiply(o.matrixWorld));
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    });
    return group;
  }), [built.parts, park]);

  return (
    <group>
      <mesh geometry={built.paving} receiveShadow>
        <meshStandardMaterial map={flags} color={PARK_COLOURS.paving} roughness={0.9} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      {built.steel && (
        <mesh geometry={built.steel} castShadow>
          <meshStandardMaterial color="#2c4f57" roughness={0.5} metalness={0.4} />
        </mesh>
      )}
      {built.teal && (
        <mesh geometry={built.teal} castShadow receiveShadow>
          <meshStandardMaterial color="#1f6b73" roughness={0.6} metalness={0.1} />
        </mesh>
      )}
      {built.cream && (
        <mesh geometry={built.cream} castShadow receiveShadow>
          <meshStandardMaterial color="#f3ecdc" roughness={0.75} />
        </mesh>
      )}
      {built.gold && (
        <mesh geometry={built.gold}>
          <meshStandardMaterial color="#f2c766" emissive="#f2c766" emissiveIntensity={1.3} roughness={0.4} />
        </mesh>
      )}
      {built.chain && (
        <mesh geometry={built.chain}>
          <meshStandardMaterial color="#8a8f95" roughness={0.4} metalness={0.8} />
        </mesh>
      )}
      {built.signs.map((sg, i) => (
        <mesh key={`sign${i}`} position={[sg.x, sg.y, sg.z]} rotation={[0, sg.turn, 0]}>
          <planeGeometry args={[sg.w, sg.h]} />
          <meshStandardMaterial map={sign} emissive="#ffffff" emissiveMap={sign} emissiveIntensity={0.6} roughness={0.5} />
        </mesh>
      ))}
      {built.inlay.map((d, i) => (
        <group key={`inlay${i}`} position={[d.x, PAVE + 0.004, d.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh>
            <circleGeometry args={[d.r, 48]} />
            <meshStandardMaterial color="#1f6b73" roughness={0.85} polygonOffset polygonOffsetFactor={-2} />
          </mesh>
          <mesh position={[0, 0, 0.002]}>
            <ringGeometry args={[d.r - 0.6, d.r - 0.25, 64]} />
            <meshStandardMaterial color="#f3ecdc" roughness={0.8} polygonOffset polygonOffsetFactor={-3} />
          </mesh>
        </group>
      ))}
      {built.cars.map((car, i) => (car.hang
        ? <HangingCar key={`car${i}`} object={cars[i]} car={car} />
        : (
          <group key={`car${i}`} position={[car.x, car.y, car.z]} rotation={[car.rx, car.ry, car.rz, 'YXZ']}>
            <primitive object={cars[i]} />
          </group>
        )))}
      {built.parts.map((p, i) => objects[i] && (
        <group key={i} position={[p.x, p.y ?? PAVE, p.z]} rotation={[0, p.turn, 0]} scale={p.scale ?? 1}>
          <primitive object={objects[i]!} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {built.colliders.map((c, i) => <CuboidCollider key={i} args={c.half} position={c.centre} />)}
      </RigidBody>
    </group>
  );
}
