'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF, useTexture } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, PlaneGeometry,
  Float32BufferAttribute, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, RepeatWrapping,
  SRGBColorSpace, type Material, type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import { TOWN_TREE_PART } from '@/config/townConfig';
import { TRAIN } from '@/config/trainConfig';
import { onStationIsland, STATION_SITE, stationFrameOf } from '@/config/stationConfig';
import {
  BEACH, beachGroundAt, beachHeight, beachPoint, FOOD_COURT_SITES, onFoodCourt, onStage, profileSamples, VOLLEYBALL, type BeachColumn,
} from '@/config/kestrelBeach';
import { cityPartMatrix, collectCityParts } from './cityChunks';
import { GRASS_REPEAT, GRASS_TILE, prepareGrassTile } from './islandGrass';

/** The beach pack (`npm run prepare:beach-props`). */
const PACK_MODEL = '/models/beachPack.glb';
useGLTF.preload(PACK_MODEL, DRACO_PATH);

/**
 * How far the island's grass reaches down onto the sand, metres from a
 * column's top edge, before the sand has it all. Varies along the shore
 * (`grassReach`) so the line is not ruled, and the shader breaks it up further
 * with noise so it ends in patches and tufts rather than a stripe.
 */
const GRASS_REACH = 16;

/**
 * Kestrel Beach — see `kestrelBeach` for where it is and why it is shaped so.
 *
 * The ground: one mesh, the beach's columns crossed with its profile, coloured
 * by what each part of the profile is — the island's own turf at the top,
 * thinning into the sand in patches, then loose sand, dry sand,
 * the darker wet band at the waterline, and sand going dark under the water —
 * over a fine sand texture laid in world space. Solid, as a trimesh of itself,
 * so a car drives down the slope and along the sand (`beachGrip` makes the sand
 * give less grip than tarmac).
 *
 * On it: the city's own palm (`TOWN_TREE_PART`, already loaded with the
 * city, so the beach adds no tree download) along the grass's edge, and
 * the user's beach pack (`beachPack.glb`) scattered over the sand — umbrellas
 * over a lounger or two facing the sea, spaced out, towels and balls, lunch tables,
 * swimming rings at the waterline and afloat, coconuts, a few small palms —
 * plus a lifeguard tower with a buoy on the nose, two wooden boardwalks, and
 * a beach volleyball court on the north shore (`VOLLEYBALL`). The quad bikes
 * and the monster truck riding the shore are NPCs (`BeachRiders`). Scenery
 * except the tower and the court's posts, which are solid.
 */

const LOOSE = new Color('#ead7a8');
const DRY = new Color('#e2cc9a');
const WET = new Color('#b39a6c');
const UNDER = new Color('#8c7a57');
const DEEP = new Color('#4f5848');

/** Fine sand: grain and faint wind ripples, near-white so the vertex colours tint it. */
function sandTexture(anisotropy: number) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  let seed = 0xbeac4;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Ripples: a slow wave across, wobbling; tiles because both are whole periods.
      const ripple = Math.sin((x / size) * Math.PI * 2 * 14 + Math.sin((y / size) * Math.PI * 2 * 3) * 2.2);
      const v = 228 + ripple * 7 + (rnd() - 0.5) * 34;
      const i = (y * size + x) * 4;
      img.data[i] = v; img.data[i + 1] = v * 0.98; img.data[i + 2] = v * 0.94; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

/**
 * What colour the ground is at `d` metres seaward of a column's top edge.
 *
 * Sand from the grass's edge down: a touch paler and warmer where it is dry
 * and loose near the top, the darker wet band at the waterline, and sand going
 * dark under the water. No grass tint — the island's own grass ends where the
 * sand begins.
 */
function groundColour(d: number, c: BeachColumn, out: Color) {
  const y = beachHeight(d, c.depth, c.out);
  const sea = TRAIN.seaLevel;
  if (y > sea + 0.7) return out.copy(LOOSE).lerp(DRY, Math.min(1, d / 14));
  if (y > sea) return out.copy(WET).lerp(DRY, (y - sea) / 0.7);
  return out.copy(UNDER).lerp(DEEP, Math.min(1, (sea - y) / 3));
}

/**
 * The beach's material: the sand texture under the vertex colours, with the
 * island's grass tile laid over the top in world metres (the same tile and
 * repeat as the crown, so the two meet without a seam) and faded out by the
 * `grassy` attribute. Two octaves of value noise break the fade into patches,
 * and where it is thin the grass is drawn drier and sandier — the way dune
 * grass gives out — rather than cross-faded into a green haze.
 */
function sandMaterial(sand: Texture, grass: Texture) {
  const material = new MeshStandardMaterial({ map: sand, vertexColors: true, roughness: 0.96, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrass = { value: grass };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float grassy;\nvarying float vGrassy;\nvarying vec2 vGroundXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrassy = grassy;\nvGroundXZ = transformed.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uGrass;
varying float vGrassy;
varying vec2 vGroundXZ;
float beachHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float beachNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(beachHash(i), beachHash(i + vec2(1.0, 0.0)), f.x),
             mix(beachHash(i + vec2(0.0, 1.0)), beachHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float n = beachNoise(vGroundXZ * 0.12) * 0.5 + beachNoise(vGroundXZ * 0.55) * 0.3
    + beachNoise(vGroundXZ * 2.4) * 0.2;
  float g = smoothstep(0.18, 0.82, vGrassy + (n - 0.5) * 1.0);
  vec3 turf = texture2D(uGrass, vGroundXZ / ${GRASS_REPEAT.toFixed(1)}).rgb;
  // Thin grass is dry: toward straw where sand shows through it.
  vec3 dry = mix(turf, vec3(0.62, 0.56, 0.36) * dot(turf, vec3(0.6)) * 2.2, 0.55);
  vec3 grassC = mix(dry, turf, smoothstep(0.55, 1.0, g));
  diffuseColor.rgb = mix(diffuseColor.rgb, grassC, g);
}`);
  };
  material.customProgramCacheKey = () => 'kestrel-beach-sand';
  return material;
}

/** How far down column `k` the grass reaches: a slow wander along the shore. */
function grassReach(k: number) {
  return GRASS_REACH * (1 + 0.35 * Math.sin(k * 0.37) + 0.2 * Math.sin(k * 1.13 + 1.7));
}

function buildGround(columns: readonly BeachColumn[]) {
  const pos: number[] = [];
  const col: number[] = [];
  const grassy: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  const rows = profileSamples(1, 1).length;
  columns.forEach((column, k) => {
    const reach = grassReach(k) * Math.min(1, column.depth / 20);
    for (const d of profileSamples(column.depth, column.out)) {
      const [x, y, z] = beachPoint(column, d);
      pos.push(x, y, z);
      // 1 at the top edge (all grass, meeting the crown), 0 at the reach.
      // Linear in d, so it interpolates exactly; the shader shapes it.
      grassy.push(Math.max(0, 1 - d / Math.max(1, reach)));
      groundColour(d, column, c);
      col.push(c.r, c.g, c.b);
      uv.push(x / 7, z / 7);
    }
  });
  for (let k = 0; k + 1 < columns.length; k++) {
    for (let r = 0; r + 1 < rows; r++) {
      const a = k * rows + r;
      const b = (k + 1) * rows + r;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('grassy', new Float32BufferAttribute(grassy, 1));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Which way the triangles face is checked, not assumed: up is +y.
  const n = g.getAttribute('normal');
  let up = 0;
  for (let i = 0; i < n.count; i++) up += n.getY(i);
  if (up < 0) {
    const index = g.getIndex()!;
    for (let i = 0; i < index.count; i += 3) {
      const t = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, t);
    }
    g.computeVertexNormals();
  }
  return g;
}

/** Turn a non-indexed surface to face up, whichever way it was wound. */
function faceUpGeometry(g: BufferGeometry) {
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  let up = 0;
  for (let i = 0; i < n.count; i++) up += n.getY(i);
  if (up < 0) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const x = p.getX(i + 1); const y = p.getY(i + 1); const z = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, x, y, z);
    }
    g.computeVertexNormals();
  }
  return g;
}

/** Whether a world point is on the station island's crown. */
function onStationIslandWorld(x: number, z: number) {
  const [along, across] = stationFrameOf(x, z);
  return onStationIsland(along, across);
}

/** A point `d` metres seaward of column `k`'s top edge, with the seaward heading. */
function spot(columns: readonly BeachColumn[], k: number, d: number) {
  const c = columns[Math.max(0, Math.min(columns.length - 1, k))];
  const [x, y, z] = beachPoint(c, d);
  // Facing the sea: the outward normal, as a yaw for a +Z-forward object.
  return { x, y, z, yaw: Math.atan2(-c.inward[0], -c.inward[1]), c };
}

/** The dry-sand band of a column: below the top, short of the wet. */
function sandBand(c: BeachColumn) {
  const land = c.depth + c.out;
  return [Math.min(12, land * 0.2), land * 0.6] as const;
}

/** One placed prop: which pack node, where, which way, how big, and any tilt. */
interface Placed { node: PackNode; x: number; y: number; z: number; yaw: number; scale?: number; roll?: number; pitch?: number }

/**
 * The beach pack's nodes (`npm run prepare:beach-props`): each centred, foot
 * on y = 0. `LOUNGER_SCALE` because the pack's loungers are small for people.
 */
type PackNode = 'umbrella1' | 'umbrella2' | 'lounger1' | 'lounger2' | 'towel' | 'ball' | 'ring' | 'lifebuoy'
  | 'coconut' | 'table' | 'palm1' | 'palm2';
const PACK_NODES: readonly PackNode[] = [
  'umbrella1', 'umbrella2', 'lounger1', 'lounger2', 'towel', 'ball', 'ring', 'lifebuoy', 'coconut', 'table', 'palm1', 'palm2',
];
const LOUNGER_SCALE = 1.45;
/** The pack's loungers face +Z (backrest at −Z), as the sea-facing yaw expects. */
const LOUNGER_TURN = 0;

/** A volleyball net's mesh: square cells, a white top band, see-through between. */
function netTexture() {
  const w = 512;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#1b1b1b';
  ctx.lineWidth = 1.5;
  const cell = 5;
  for (let x = 0; x <= w; x += cell) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += cell) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.fillStyle = '#f4f4f0';
  ctx.fillRect(0, 0, w, 5);
  ctx.fillRect(0, h - 3, w, 3);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** All of one node's meshes, instanced at the same matrices. */
function PackInstances({ meshes, items }: { meshes: Mesh[]; items: readonly Placed[] }) {
  const refs = useRef<Array<InstancedMesh | null>>([]);
  useEffect(() => {
    const o = new Object3D();
    for (const mesh of refs.current) {
      if (!mesh) continue;
      items.forEach((p, i) => {
        o.position.set(p.x, p.y, p.z);
        o.rotation.set(p.pitch ?? 0, p.yaw, p.roll ?? 0, 'YXZ');
        o.scale.setScalar(p.scale ?? 1);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }, [items, meshes]);
  if (items.length === 0) return null;
  return (
    <>
      {meshes.map((m, i) => (
        <instancedMesh
          key={m.uuid}
          ref={(r) => { refs.current[i] = r; }}
          args={[m.geometry, m.material as Material, items.length]}
          castShadow
          receiveShadow
        />
      ))}
    </>
  );
}

export function KestrelBeach() {
  const beach = BEACH;
  const anisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  const { scene: city } = useGLTF(CITY_MODEL, DRACO_PATH);
  const palmPart = useMemo(() => collectCityParts(city, [TOWN_TREE_PART]).get(TOWN_TREE_PART), [city]);
  const { scene: packScene } = useGLTF(PACK_MODEL, DRACO_PATH);
  /** Each pack node's meshes (a node with several materials is several meshes). */
  const packMeshes = useMemo(() => {
    const out = new Map<PackNode, Mesh[]>();
    for (const name of PACK_NODES) {
      const meshes: Mesh[] = [];
      packScene.getObjectByName(name)?.traverse((o) => { if (o instanceof Mesh) meshes.push(o); });
      out.set(name, meshes);
    }
    return out;
  }, [packScene]);
  const grassTile = useTexture(GRASS_TILE);

  const ground = useMemo(() => (beach ? buildGround(beach.columns) : null), [beach]);
  const groundMaterial = useMemo(
    () => sandMaterial(sandTexture(anisotropy), prepareGrassTile(grassTile)),
    [anisotropy, grassTile],
  );
  useEffect(() => () => { ground?.dispose(); groundMaterial.map?.dispose(); groundMaterial.dispose(); }, [ground, groundMaterial]);
  const collider = useMemo(() => (ground ? [
    new Float32Array(ground.getAttribute('position').array),
    new Uint32Array(ground.getIndex()!.array),
  ] as [Float32Array, Uint32Array] : null), [ground]);

  /** Where everything stands. Deterministic: the same beach every load. */
  const layout = useMemo(() => {
    if (!beach) return null;
    const cols = beach.columns;
    let seed = 0x5a11d;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const palms: Array<{ x: number; y: number; z: number; turn: number }> = [];
    const props: Placed[] = [];
    // The court's frame: centre, along the shore (a), and seaward (b).
    const courtC = spot(cols, VOLLEYBALL.column, VOLLEYBALL.d);
    const sea: [number, number] = [-courtC.c.inward[0], -courtC.c.inward[1]];
    const shore: [number, number] = [sea[1], -sea[0]];
    const courtAt = (a: number, b: number): [number, number] => [
      courtC.x + shore[0] * a + sea[0] * b, courtC.z + shore[1] * a + sea[1] * b,
    ];
    const onCourt = (x: number, z: number, margin: number) => {
      const dx = x - courtC.x;
      const dz = z - courtC.z;
      return Math.abs(dx * shore[0] + dz * shore[1]) < VOLLEYBALL.length / 2 + margin
        && Math.abs(dx * sea[0] + dz * sea[1]) < VOLLEYBALL.width / 2 + VOLLEYBALL.postOut + margin;
    };
    // Off the court, the food courts, and the stage with the sand in front of
    // it where the audience stands.
    const clear = (x: number, z: number, margin = 3) => !onCourt(x, z, margin) && !onFoodCourt(x, z, margin)
      && !onStage(x, z, margin + 20);
    /** Stand a prop on the sand at (x, z), if the sand is there and the court is not. */
    const put = (node: PackNode, x: number, z: number, yaw: number, extra: Partial<Placed> = {}) => {
      if (!clear(x, z)) return false;
      const y = beachGroundAt(x, z);
      if (y === null) return false;
      props.push({ node, x, y: y - 0.02, z, yaw, ...extra });
      return true;
    };
    for (let k = 3; k < cols.length - 3; k++) {
      const c = cols[k];
      if (c.depth < 20) continue;
      const land = c.depth + c.out;
      // Palms along the grass's ragged edge, in clumps of one to three, with
      // the odd small pack palm among them and coconuts fallen at their feet.
      if (k % 2 === 0) {
        const clump = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < clump; j++) {
          const p = spot(cols, k, grassReach(k) * (0.5 + rnd() * 0.6));
          const x = p.x + (rnd() - 0.5) * 6;
          const z = p.z + (rnd() - 0.5) * 6;
          if (!clear(x, z, 4)) continue;
          if (rnd() < 0.2) {
            put(rnd() < 0.5 ? 'palm1' : 'palm2', x, z, rnd() * Math.PI * 2, { scale: 1.1 + rnd() * 0.4 });
          } else {
            palms.push({ x, y: p.y, z, turn: rnd() * Math.PI * 2 });
          }
          if (rnd() < 0.5) put('coconut', x + (rnd() - 0.5) * 3, z + (rnd() - 0.5) * 3, rnd() * 6);
        }
      }
      // Sets every fourth column, in two loose rows, with gaps: an umbrella
      // over a lounger or two facing the sea, sometimes a towel and a ball in
      // front, and now and then a table with lunch on it.
      if (k % 4 === 1) {
        const [near, far] = sandBand(c);
        for (const row of [0.22, 0.68]) {
          if (rnd() < 0.4) continue;
          const d = near + (far - near) * (row + (rnd() - 0.5) * 0.2);
          const u = spot(cols, k, d);
          const ux = u.x + (rnd() - 0.5) * 2;
          const uz = u.z + (rnd() - 0.5) * 2;
          if (!put(rnd() < 0.5 ? 'umbrella1' : 'umbrella2', ux, uz, rnd() * Math.PI * 2, { roll: (rnd() - 0.5) * 0.12 })) continue;
          // Across the beach (along the shore) and toward the sea.
          const sx = Math.cos(u.yaw);
          const sz = -Math.sin(u.yaw);
          const fx = Math.sin(u.yaw);
          const fz = Math.cos(u.yaw);
          const pair = rnd();
          for (const side of pair < 0.45 ? [-1, 1] : pair < 0.85 ? [rnd() < 0.5 ? -1 : 1] : []) {
            put(side < 0 ? 'lounger1' : 'lounger2', ux + sx * side * 0.75, uz + sz * side * 0.75,
              u.yaw + LOUNGER_TURN + (rnd() - 0.5) * 0.2, { scale: LOUNGER_SCALE });
          }
          if (rnd() < 0.35) {
            const tx = ux + fx * 2.4 + sx * (rnd() - 0.5) * 2;
            const tz = uz + fz * 2.4 + sz * (rnd() - 0.5) * 2;
            put('towel', tx, tz, u.yaw + Math.PI / 2 + (rnd() - 0.5) * 0.5);
            if (rnd() < 0.5) put('ball', tx + sx * 1.4, tz + sz * 1.4, rnd() * 6);
          }
          if (rnd() < 0.18) put('table', ux - sx * 1.9, uz - sz * 1.9, u.yaw + (rnd() - 0.5) * 0.6);
        }
      }
      // Swimming rings: lying on the wet sand, and a few out on the water.
      if (k % 4 === 2) {
        const w = spot(cols, k, land - 3 - rnd() * 5);
        put('ring', w.x + (rnd() - 0.5) * 4, w.z + (rnd() - 0.5) * 4, rnd() * 6, { pitch: (rnd() - 0.5) * 0.1 });
      }
      if (k % 6 === 3) {
        const f = spot(cols, k, land + 5 + rnd() * 8);
        if (clear(f.x, f.z)) {
          props.push({ node: 'ring', x: f.x, y: TRAIN.seaLevel - 0.12, z: f.z, yaw: rnd() * 6 });
        }
      }
    }
    // The lodge's terrace: three tables with lunch on them under umbrellas on
    // the lawn on whichever side of the lodge faces the water.
    const lodge = FOOD_COURT_SITES.find((f) => f.name === 'lodge');
    if (lodge) {
      const crown = STATION_SITE?.ground ?? 3.2;
      const sides = [
        { dir: lodge.shore, half: lodge.halfU, along: lodge.sea },
        { dir: [-lodge.shore[0], -lodge.shore[1]] as [number, number], half: lodge.halfU, along: lodge.sea },
        { dir: lodge.sea, half: lodge.halfV, along: lodge.shore },
        { dir: [-lodge.sea[0], -lodge.sea[1]] as [number, number], half: lodge.halfV, along: lodge.shore },
      ];
      // The water side: the one whose ground 30 m out is lowest (sea, then sand).
      const lowAt = (d: [number, number]) => beachGroundAt(lodge.x + d[0] * 30, lodge.z + d[1] * 30)
        ?? (onStationIslandWorld(lodge.x + d[0] * 30, lodge.z + d[1] * 30) ? crown : -10);
      const side = sides.reduce((a, b) => (lowAt(b.dir) < lowAt(a.dir) ? b : a));
      const face = Math.atan2(side.dir[0], side.dir[1]);
      for (const k of [-1, 0, 1]) {
        const out = side.half + 3.5;
        const x = lodge.x + side.dir[0] * out + side.along[0] * k * 6.5;
        const z = lodge.z + side.dir[1] * out + side.along[1] * k * 6.5;
        const y = beachGroundAt(x, z) ?? crown;
        props.push({ node: 'table', x, y, z, yaw: face + k * 0.15 });
        props.push({ node: k === 0 ? 'umbrella2' : 'umbrella1', x: x + side.along[0] * 1.6, y, z: z + side.along[1] * 1.6, yaw: rnd() * 6 });
      }
    }

    // The lifeguard tower: a third of the way round, high on the sand.
    const towerCol = Math.round(cols.length * 0.3);
    const [tn, tf] = sandBand(cols[towerCol]);
    const tower = spot(cols, towerCol, (tn + tf) / 2 + 3);
    // Boardwalks: one on the nose, one on the north shore clear of the market.
    const walks = [Math.round(cols.length * 0.2), Math.round(cols.length * 0.64)];

    // The court: tape round it draped on the sand, posts at the net's ends,
    // and a ball near the net.
    const tape: Array<[number, number, number]> = [];
    const halfL = VOLLEYBALL.length / 2;
    const halfW = VOLLEYBALL.width / 2;
    const corners: Array<[number, number]> = [[-halfL, -halfW], [halfL, -halfW], [halfL, halfW], [-halfL, halfW], [-halfL, -halfW]];
    for (let e = 0; e < 4; e++) {
      const [a0, b0] = corners[e];
      const [a1, b1] = corners[e + 1];
      const n = Math.ceil(Math.hypot(a1 - a0, b1 - b0) / 0.5);
      for (let i = 0; i <= n; i++) {
        const [x, z] = courtAt(a0 + ((a1 - a0) * i) / n, b0 + ((b1 - b0) * i) / n);
        tape.push([x, (beachGroundAt(x, z) ?? courtC.y) + 0.025, z]);
      }
    }
    const netY = courtC.y + VOLLEYBALL.netTop;
    const posts = [-1, 1].map((side) => {
      const [x, z] = courtAt(0, side * (halfW + VOLLEYBALL.postOut));
      const foot = beachGroundAt(x, z) ?? courtC.y;
      return { x, z, foot, height: netY + 0.12 - foot };
    });
    const court = {
      tape, posts, netY, centre: [courtC.x, courtC.z] as [number, number],
      netYaw: Math.atan2(-sea[1], sea[0]),
      netWidth: VOLLEYBALL.width + VOLLEYBALL.postOut * 2,
    };
    {
      const [bx, bz] = courtAt(-1.6, 1.2);
      props.push({ node: 'ball', x: bx, y: (beachGroundAt(bx, bz) ?? courtC.y) - 0.02, z: bz, yaw: 0.7, scale: 0.75 });
    }

    return { palms, props, tower, walks, court };
  }, [beach]);

  const propsByNode = useMemo(() => {
    const m = new Map<PackNode, Placed[]>();
    for (const name of PACK_NODES) m.set(name, []);
    layout?.props.forEach((p) => m.get(p.node)?.push(p));
    return m;
  }, [layout]);

  /* ------------------------------------------------------------ dressing */

  const mats = useMemo(() => ({
    wood: new MeshStandardMaterial({ color: '#9a7350', roughness: 0.9 }),
    red: new MeshStandardMaterial({ color: '#c8352c', roughness: 0.7 }),
    white: new MeshStandardMaterial({ color: '#f1efe8', roughness: 0.7 }),
  }), []);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const palmRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = palmRef.current;
    if (!mesh || !palmPart || !layout) return;
    const m = new Matrix4();
    // Foot sunk a little, so a trunk on the slope has no daylight under it.
    layout.palms.forEach((p, i) => mesh.setMatrixAt(i, cityPartMatrix(palmPart, p.x, p.y - 0.3, p.z, p.turn, m)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [layout, palmPart]);

  /** The volleyball court: tape ribbon on the sand, two posts, the net. */
  const courtParts = useMemo(() => {
    if (!layout) return null;
    const { tape, posts, netY, netWidth } = layout.court;
    const pos: number[] = [];
    const half = 0.05;
    for (let i = 0; i + 1 < tape.length; i++) {
      const [x0, y0, z0] = tape[i];
      const [x1, y1, z1] = tape[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-3) continue;
      const nx = (-(z1 - z0) / len) * half;
      const nz = ((x1 - x0) / len) * half;
      pos.push(
        x0 - nx, y0, z0 - nz, x0 + nx, y0, z0 + nz, x1 + nx, y1, z1 + nz,
        x0 - nx, y0, z0 - nz, x1 + nx, y1, z1 + nz, x1 - nx, y1, z1 - nz,
      );
    }
    const tapeGeometry = faceUpGeometry(new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pos, 3)));
    const postGeometry = mergeGeometries(posts.map((p) => new CylinderGeometry(0.05, 0.05, p.height, 10)
      .translate(p.x, p.foot + p.height / 2, p.z)))!;
    const net = new PlaneGeometry(netWidth, VOLLEYBALL.netDepth);
    return { tapeGeometry, postGeometry, net, netY };
  }, [layout]);
  const courtMats = useMemo(() => ({
    tape: new MeshStandardMaterial({ color: '#2160c4', roughness: 0.6 }),
    post: new MeshStandardMaterial({ color: '#e8e6e0', roughness: 0.4, metalness: 0.5 }),
    net: new MeshStandardMaterial({ map: netTexture(), transparent: true, alphaTest: 0.3, side: DoubleSide, roughness: 0.9 }),
  }), []);
  useEffect(() => () => {
    courtMats.net.map?.dispose();
    Object.values(courtMats).forEach((m) => m.dispose());
  }, [courtMats]);
  useEffect(() => () => {
    if (courtParts) [courtParts.tapeGeometry, courtParts.postGeometry, courtParts.net].forEach((g) => g.dispose());
  }, [courtParts]);

  /** The lifeguard's buoy, hung on the front of the hut. */
  const buoy = useMemo(() => {
    const node = packScene.getObjectByName('lifebuoy');
    return node ? node.clone() : null;
  }, [packScene]);
  /** The boardwalks: planks following the ground from the grass onto the sand. */
  const boardwalk = useMemo(() => {
    if (!beach || !layout) return null;
    const pieces: BufferGeometry[] = [];
    for (const k of layout.walks) {
      const c = beach.columns[k];
      const yaw = Math.atan2(-c.inward[0], -c.inward[1]);
      for (let d = -4; d <= 18; d += 0.55) {
        const [x, y, z] = beachPoint(c, Math.max(0, d));
        // On the crown inland of the top edge: carry the line back along the normal.
        const back = Math.min(0, d);
        const px = x + c.inward[0] * -back;
        const pz = z + c.inward[1] * -back;
        const plank = new BoxGeometry(3, 0.06, 0.48);
        plank.rotateY(yaw);
        plank.translate(px, y + 0.22, pz);
        pieces.push(plank);
        // Posts every few metres down the slope, where it stands off the ground.
        if (d > 0 && Math.round(d / 0.55) % 5 === 0) {
          for (const side of [-1.4, 1.4]) {
            const post = new BoxGeometry(0.12, 0.6, 0.12);
            post.translate(px + Math.cos(yaw) * side, y - 0.08, pz - Math.sin(yaw) * side);
            pieces.push(post);
          }
        }
      }
    }
    const merged = mergeGeometries(pieces);
    pieces.forEach((g) => g.dispose());
    return merged;
  }, [beach, layout]);
  useEffect(() => () => boardwalk?.dispose(), [boardwalk]);

  /** The lifeguard tower: stilts, a deck, a hut with a red roof, a ladder. */
  const tower = useMemo(() => {
    const wood: BufferGeometry[] = [];
    const white: BufferGeometry[] = [];
    const red: BufferGeometry[] = [];
    for (const [x, z] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) {
      wood.push(new BoxGeometry(0.18, 3.2, 0.18).translate(x, 1.6, z));
    }
    wood.push(new BoxGeometry(3, 0.15, 3.4).translate(0, 3.2, 0.2));
    white.push(new BoxGeometry(2.2, 1.9, 2.2).translate(0, 4.25, -0.2));
    red.push(new BoxGeometry(2.8, 0.18, 2.8).rotateX(0.12).translate(0, 5.35, -0.2));
    red.push(new BoxGeometry(2.3, 0.35, 0.05).translate(0, 4.6, 0.92));
    for (let r = 0; r < 7; r++) wood.push(new BoxGeometry(0.9, 0.08, 0.12).translate(0, 0.4 + r * 0.42, 2.4 - r * 0.12));
    wood.push(new BoxGeometry(0.08, 3.4, 0.08).rotateX(0.28).translate(-0.45, 1.6, 2.05));
    wood.push(new BoxGeometry(0.08, 3.4, 0.08).rotateX(0.28).translate(0.45, 1.6, 2.05));
    const out = { wood: mergeGeometries(wood)!, white: mergeGeometries(white)!, red: mergeGeometries(red)! };
    [...wood, ...white, ...red].forEach((g) => g.dispose());
    return out;
  }, []);
  useEffect(() => () => Object.values(tower).forEach((g) => g.dispose()), [tower]);

  useEffect(() => {
    if (!beach || !layout) return;
    console.info(`[beach] Kestrel: ${beach.columns.length} columns, ${layout.palms.length} palms, `
      + `${layout.props.length} beach props`);
  }, [beach, layout]);

  if (!beach || !ground || !layout || !collider) return null;
  return (
    <group>
      <mesh geometry={ground} material={groundMaterial} receiveShadow />
      <RigidBody type="fixed" colliders={false} friction={0.9}>
        <TrimeshCollider args={collider} />
        {/* The court's posts. */}
        {layout.court.posts.map((p, i) => (
          <CuboidCollider key={`post${i}`} args={[0.06, p.height / 2, 0.06]} position={[p.x, p.foot + p.height / 2, p.z]} />
        ))}
      </RigidBody>

      {PACK_NODES.map((name) => (
        <PackInstances key={name} meshes={packMeshes.get(name) ?? []} items={propsByNode.get(name) ?? []} />
      ))}
      {courtParts && (
        <>
          <mesh geometry={courtParts.tapeGeometry} material={courtMats.tape} receiveShadow />
          <mesh geometry={courtParts.postGeometry} material={courtMats.post} castShadow />
          <mesh
            geometry={courtParts.net}
            material={courtMats.net}
            position={[layout.court.centre[0], courtParts.netY - VOLLEYBALL.netDepth / 2, layout.court.centre[1]]}
            rotation={[0, layout.court.netYaw, 0]}
            castShadow
          />
        </>
      )}
      {palmPart && layout.palms.length > 0 && (
        <instancedMesh
          ref={palmRef}
          args={[palmPart.geometry, palmPart.material as Material, layout.palms.length]}
          castShadow
          receiveShadow
        />
      )}
      {boardwalk && <mesh geometry={boardwalk} material={mats.wood} castShadow receiveShadow />}

      <group position={[layout.tower.x, layout.tower.y - 0.1, layout.tower.z]} rotation={[0, layout.tower.yaw, 0]}>
        <mesh geometry={tower.wood} material={mats.wood} castShadow />
        <mesh geometry={tower.white} material={mats.white} castShadow />
        <mesh geometry={tower.red} material={mats.red} castShadow />
        {buoy && <primitive object={buoy} position={[0.65, 3.85, 0.92]} rotation={[Math.PI / 2, 0, 0]} />}
      </group>
    </group>
  );
}
