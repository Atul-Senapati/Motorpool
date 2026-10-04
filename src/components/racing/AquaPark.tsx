'use client';

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, Group, Mesh, Object3D, PlaneGeometry, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { PAVING } from '@/config/airportConfig';
import { ROAD_TOP, ROAD_WIDTH } from '@/config/roadConfig';
import { AQUA, AQUA_SITE } from '@/config/aquaParkConfig';
import { PARK_COLOURS } from '@/config/parkConfig';
import { partColliders } from './partColliders';
import { type Board, Boards } from './StationForecourt';

const PARK_MODEL = '/models/park.glb';
useGLTF.preload(AQUA.model, DRACO_PATH);
useGLTF.preload(PARK_MODEL, DRACO_PATH);

const PAVE = 0.06;

/** Halcyon Pier's flagstones, so the plaza is plainly part of the same park. */
export function flagTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  let seed = 5;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const v = 214 + Math.floor(rnd() * 22);
      g.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
      const off = row % 2 ? 43 : 0;
      g.fillRect(col * 86 + off - 86, row * 128, 86, 128);
      g.fillRect(col * 86 + off, row * 128, 86, 128);
    }
  }
  for (let k = 0; k < 3000; k++) {
    const v = 170 + Math.floor(rnd() * 70);
    g.fillStyle = `rgba(${v},${v - 4},${v - 10},0.35)`;
    g.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
  }
  g.fillStyle = '#9b9488';
  g.fillRect(0, 0, 256, 3);
  g.fillRect(0, 127, 256, 3);
  for (let col = 0; col < 3; col++) {
    g.fillRect(col * 86, 0, 3, 128);
    g.fillRect(col * 86 + 43, 128, 3, 128);
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const FLAG_COLOURS = ['#1fa3c9', '#f4f1e8', '#f2c14e', '#1fa3c9', '#e8603c', '#f4f1e8', '#2fb38a'];

function layout() {
  const S = AQUA_SITE;
  const P = S.plaza;
  const steel: BufferGeometry[] = [];
  const kerb: BufferGeometry[] = [];
  const white: BufferGeometry[] = [];
  const lamps: BufferGeometry[] = [];
  const flags: BufferGeometry[][] = FLAG_COLOURS.map(() => []);
  const colliders: Array<{ half: [number, number, number]; centre: [number, number, number] }> = [];
  const box = (list: BufferGeometry[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => {
    list.push(new BoxGeometry(sx, sy, sz).translate(cx, cy, cz));
  };

  // The plaza: flags from the kerb to the fence, the park's width, and a kerb along its back.
  const plaza = new PlaneGeometry(P.x1 - P.x0, P.z1 - P.z0 + 1).rotateX(-Math.PI / 2)
    .translate((P.x0 + P.x1) / 2, PAVE, (P.z0 + P.z1 + 1) / 2);
  const pos = plaza.getAttribute('position');
  const uv = plaza.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / PARK_COLOURS.slab, pos.getZ(i) / PARK_COLOURS.slab);

  // Lamps along the front, and flagpoles in a row either side of the gate.
  for (let x = P.x0 + 4; x <= P.x1 - 2; x += 13) {
    if (Math.abs(x - S.gateAlong) < 9) continue;
    box(steel, x, 2.6, P.z0 + 1.2, 0.14, 5.2, 0.14);
    box(steel, x, 5.2, P.z0 + 1.6, 0.1, 0.1, 0.9);
    box(lamps, x, 5.12, P.z0 + 2.0, 0.42, 0.12, 0.42);
    colliders.push({ half: [0.12, 2.6, 0.12], centre: [x, 2.6, P.z0 + 1.2] });
  }
  let f = 0;
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x = S.gateAlong + side * (11 + k * 4.5);
      const z = P.z1 - 1.2;
      box(steel, x, 4, z, 0.1, 8, 0.1);
      box(flags[f % FLAG_COLOURS.length], x + 0.85, 7.2, z, 1.6, 1.0, 0.03);
      colliders.push({ half: [0.1, 4, 0.1], centre: [x, 4, z] });
      f++;
    }
  }

  // A zebra crossing over the outer road to Halcyon Pier, square to the gate.
  const roadZ = (PAVING.outerRoad[2] + PAVING.outerRoad[3]) / 2;
  const carriage = ROAD_WIDTH * (1 - 2 * 0.143);
  for (let z = roadZ - carriage / 2 + 0.6; z < roadZ + carriage / 2 - 0.3; z += 1.2) {
    box(white, S.gateAlong, ROAD_TOP + 0.012, z, 4, 0.02, 0.6);
  }
  // Belisha-style beacons each side: a striped post and an amber globe.
  for (const z of [roadZ - ROAD_WIDTH / 2 + 1.2, roadZ + ROAD_WIDTH / 2 - 1.2]) {
    for (const dx of [-2.6, 2.6]) {
      for (let h = 0; h < 6; h++) box(h % 2 ? white : kerb, S.gateAlong + dx, 0.25 + h * 0.5, z, 0.12, 0.5, 0.12);
      box(lamps, S.gateAlong + dx, 3.2, z, 0.38, 0.38, 0.38);
    }
  }

  const merge = (list: BufferGeometry[]) => (list.length ? mergeGeometries(list, false) : null);
  const boards: Board[] = [
    { kind: 'fascia', x: S.gateAlong, y: 6.2, z: P.z0 + 2.4, turn: Math.PI, w: 12, h: 1.8, text: 'Halcyon Aqua Park' },
  ];
  for (const k of [-1, 1]) box(steel, S.gateAlong + k * 5.6, 3.3, P.z0 + 2.45, 0.22, 6.6, 0.22);
  for (const k of [-1, 1]) colliders.push({ half: [0.15, 3.3, 0.15], centre: [S.gateAlong + k * 5.6, 3.3, P.z0 + 2.45] });

  // Trees from the park's kit at the plaza's two ends.
  const trees: Array<{ part: string; x: number; z: number; scale: number }> = [
    { part: 'treeBroad', x: P.x0 + 1.5, z: P.z1 - 2, scale: 0.75 },
    { part: 'treeSlim', x: P.x1 - 1.5, z: P.z1 - 2, scale: 0.7 },
  ];

  return {
    plaza, steel: merge(steel), kerb: merge(kerb), white: merge(white), lamps: merge(lamps),
    flags: flags.map(merge), boards, colliders, trees,
  };
}

/**
 * Halcyon Aqua Park, beside the Wall of Death — see `aquaParkConfig` for the
 * ground and why it is this size. Drawn inside `AirportIsland`'s group, so x
 * is along and z across. The park itself is the model; what is built here is
 * its entrance plaza in Halcyon Pier's own flagstones, the sign, lamps and
 * flags, and a zebra crossing over the outer road to the fairground.
 */
export function AquaPark() {
  const S = AQUA_SITE;
  const built = useMemo(() => layout(), []);
  const flagMap = useMemo(() => flagTexture(), []);
  const { scene } = useGLTF(AQUA.model, DRACO_PATH);
  const park = useGLTF(PARK_MODEL, DRACO_PATH).scene as unknown as Object3D;
  const model = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }, [scene]);
  const trees = useMemo(() => built.trees.map((tr) => {
    const node = park.getObjectByName(tr.part);
    if (!node) return null;
    const group = new Group();
    node.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const m = new Mesh(o.geometry, o.material);
      m.castShadow = true;
      group.add(m);
    });
    return group;
  }), [built.trees, park]);

  return (
    <group>
      <group position={[S.along, PAVE, S.across]} rotation={[0, S.turn, 0]} scale={S.scale}>
        <primitive object={model} />
      </group>
      <mesh geometry={built.plaza} receiveShadow>
        <meshStandardMaterial map={flagMap} color={PARK_COLOURS.paving} roughness={0.9} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      {built.steel && (
        <mesh geometry={built.steel} castShadow>
          <meshStandardMaterial color="#5a6670" roughness={0.45} metalness={0.5} />
        </mesh>
      )}
      {built.kerb && (
        <mesh geometry={built.kerb}>
          <meshStandardMaterial color="#1b1b1b" roughness={0.8} />
        </mesh>
      )}
      {built.white && (
        <mesh geometry={built.white}>
          <meshStandardMaterial color="#f2f2ee" roughness={0.7} polygonOffset polygonOffsetFactor={-4} />
        </mesh>
      )}
      {built.lamps && (
        <mesh geometry={built.lamps}>
          <meshStandardMaterial color="#ffe9b8" emissive="#ffc861" emissiveIntensity={0.8} />
        </mesh>
      )}
      {built.flags.map((g, i) => g && (
        <mesh key={i} geometry={g} castShadow>
          <meshStandardMaterial color={FLAG_COLOURS[i]} roughness={0.8} />
        </mesh>
      ))}
      <Boards boards={built.boards} />
      {built.trees.map((tr, i) => trees[i] && (
        <group key={i} position={[tr.x, PAVE, tr.z]} scale={tr.scale}>
          <primitive object={trees[i]!} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {partColliders('aquaPark', S.along, S.across, S.turn, AQUA.size, 'aquaPark', S.scale)}
        {built.colliders.map((c, i) => <CuboidCollider key={i} args={c.half} position={c.centre} />)}
      </RigidBody>
    </group>
  );
}
