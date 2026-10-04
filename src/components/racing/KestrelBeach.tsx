'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF, useTexture } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Float32BufferAttribute, InstancedMesh, Mesh, MeshStandardMaterial, Object3D, RepeatWrapping,
  SRGBColorSpace, type Material, type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { TRAIN } from '@/config/trainConfig';
import {
  BEACH, beachHeight, beachPoint, profileSamples, type BeachColumn,
} from '@/config/kestrelBeach';
import { GRASS_REPEAT, GRASS_TILE, prepareGrassTile } from './islandGrass';

/** Five palms cut from one grove (`npm run prepare:palms`), planted as variants. */
const PALM_MODEL = '/models/beachPalms.glb';
const PALM_VARIANTS = 5;
useGLTF.preload(PALM_MODEL, DRACO_PATH);

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
 * On it: palms (five real ones, `beachPalms.glb`) along the grass's edge, striped umbrellas each with
 * two loungers facing the sea, a lifeguard tower on the nose, and two wooden
 * boardwalks from the grass down onto the sand. All scenery except the tower,
 * which is solid.
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

export function KestrelBeach() {
  const beach = BEACH;
  const anisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  const { scene: palmScene } = useGLTF(PALM_MODEL, DRACO_PATH);
  const palmParts = useMemo(() => Array.from({ length: PALM_VARIANTS }, (_, i) => {
    const node = palmScene.getObjectByName(`palm${i}`);
    return node instanceof Mesh ? node : null;
  }).filter((m): m is Mesh => m !== null), [palmScene]);
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
    const palms: Array<{ x: number; y: number; z: number; turn: number; scale: number; variant: number }> = [];
    const umbrellas: Array<{ x: number; y: number; z: number; yaw: number; colour: number }> = [];
    const loungers: Array<{ x: number; y: number; z: number; yaw: number }> = [];
    for (let k = 3; k < cols.length - 3; k++) {
      const c = cols[k];
      if (c.depth < 20) continue;
      // Palms along the grass's ragged edge, in clumps of one to three.
      if (k % 2 === 0) {
        const clump = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < clump; j++) {
          const p = spot(cols, k, grassReach(k) * (0.5 + rnd() * 0.6));
          const x = p.x + (rnd() - 0.5) * 6;
          const z = p.z + (rnd() - 0.5) * 6;
          palms.push({
            x, y: p.y, z, turn: rnd() * Math.PI * 2, scale: 0.85 + rnd() * 0.3, variant: Math.floor(rnd() * PALM_VARIANTS),
          });
        }
      }
      // An umbrella with two loungers every other column, in three loose rows.
      if (k % 2 === 1) {
        const [near, far] = sandBand(c);
        for (const row of [0.15, 0.5, 0.85]) {
          if (rnd() < 0.25) continue;
          const d = near + (far - near) * (row + (rnd() - 0.5) * 0.2);
          const u = spot(cols, k, d);
          umbrellas.push({ x: u.x, y: u.y, z: u.z, yaw: u.yaw, colour: Math.floor(rnd() * 4) });
          // Two loungers either side of the pole, facing the sea.
          const sx = Math.cos(u.yaw);
          const sz = -Math.sin(u.yaw);
          for (const side of [-1, 1]) {
            const lx = u.x + sx * side * 1.1;
            const lz = u.z + sz * side * 1.1;
            loungers.push({ x: lx, y: u.y, z: lz, yaw: u.yaw });
          }
        }
      }
    }
    // The lifeguard tower: a third of the way round, high on the sand.
    const towerCol = Math.round(cols.length * 0.3);
    const [tn, tf] = sandBand(cols[towerCol]);
    const tower = spot(cols, towerCol, (tn + tf) / 2 + 3);
    // Boardwalks: one on the nose, one on the north shore.
    const walks = [Math.round(cols.length * 0.2), Math.round(cols.length * 0.68)];
    return { palms, umbrellas, loungers, tower, walks };
  }, [beach]);

  /* ------------------------------------------------------------ dressing */

  const parts = useMemo(() => {
    // Umbrella: a pole and a canopy (eight panels, coloured per instance).
    const pole = new CylinderGeometry(0.04, 0.04, 2.3, 6).translate(0, 1.15, 0);
    const canopy = new ConeGeometry(1.5, 0.55, 8, 1, true).translate(0, 2.3, 0);
    // Lounger: a slatted bed and a raised back, +Z toward the feet (the sea).
    const bed = new BoxGeometry(0.62, 0.08, 1.35).translate(0, 0.32, 0.25);
    const back = new BoxGeometry(0.62, 0.08, 0.7).rotateX(-0.75).translate(0, 0.52, -0.62);
    const legs = new BoxGeometry(0.56, 0.3, 0.06).translate(0, 0.15, 0.8);
    const legs2 = new BoxGeometry(0.56, 0.3, 0.06).translate(0, 0.15, -0.4);
    const lounger = mergeGeometries([bed, back, legs, legs2])!;
    [bed, back, legs, legs2].forEach((g) => g.dispose());
    return { pole, canopy, lounger };
  }, []);
  const mats = useMemo(() => ({
    pole: new MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.6 }),
    canopy: new MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, side: DoubleSide }),
    lounger: new MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.7 }),
    wood: new MeshStandardMaterial({ color: '#9a7350', roughness: 0.9 }),
    red: new MeshStandardMaterial({ color: '#c8352c', roughness: 0.7 }),
    white: new MeshStandardMaterial({ color: '#f1efe8', roughness: 0.7 }),
  }), []);
  useEffect(() => () => {
    Object.values(parts).forEach((g) => g.dispose());
    Object.values(mats).forEach((m) => m.dispose());
  }, [parts, mats]);

  const palmRefs = useRef<Array<InstancedMesh | null>>([]);
  const palmGroups = useMemo(() => {
    const groups = palmParts.map(() => [] as NonNullable<typeof layout>['palms']);
    layout?.palms.forEach((p) => groups[p.variant % Math.max(1, palmParts.length)]?.push(p));
    return groups;
  }, [layout, palmParts]);
  const poleRef = useRef<InstancedMesh>(null);
  const canopyRef = useRef<InstancedMesh>(null);
  const loungerRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    if (!layout) return;
    const o = new Object3D();
    palmGroups.forEach((group, v) => {
      const mesh = palmRefs.current[v];
      if (!mesh) return;
      group.forEach((p, i) => {
        // Foot sunk a little, so a trunk on the slope has no daylight under it.
        o.position.set(p.x, p.y - 0.25, p.z);
        o.rotation.set(0, p.turn, 0);
        o.scale.setScalar(p.scale);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
    o.scale.setScalar(1);
    const colours = ['#d6402f', '#2d6fb6', '#f0c33c', '#f4f1ea'].map((c) => new Color(c));
    layout.umbrellas.forEach((u, i) => {
      o.position.set(u.x, u.y - 0.15, u.z);
      o.rotation.set(0.06, u.yaw, 0);
      o.updateMatrix();
      poleRef.current?.setMatrixAt(i, o.matrix);
      canopyRef.current?.setMatrixAt(i, o.matrix);
      canopyRef.current?.setColorAt(i, colours[u.colour]);
    });
    layout.loungers.forEach((l, i) => {
      o.position.set(l.x, l.y, l.z);
      o.rotation.set(0, l.yaw, 0);
      o.updateMatrix();
      loungerRef.current?.setMatrixAt(i, o.matrix);
    });
    for (const ref of [poleRef, canopyRef, loungerRef]) {
      if (!ref.current) continue;
      ref.current.instanceMatrix.needsUpdate = true;
      if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
      ref.current.computeBoundingSphere();
    }
  }, [layout, palmGroups, poleRef, canopyRef, loungerRef]);

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
      + `${layout.umbrellas.length} umbrellas, ${layout.loungers.length} loungers`);
  }, [beach, layout]);

  if (!beach || !ground || !layout || !collider) return null;
  return (
    <group>
      <mesh geometry={ground} material={groundMaterial} receiveShadow />
      <RigidBody type="fixed" colliders={false} friction={0.9}>
        <TrimeshCollider args={collider} />
      </RigidBody>

      {palmParts.map((part, v) => palmGroups[v]?.length ? (
        <instancedMesh
          key={part.name}
          ref={(m) => { palmRefs.current[v] = m; }}
          args={[part.geometry, part.material as Material, palmGroups[v].length]}
          castShadow
          receiveShadow
        />
      ) : null)}
      {layout.umbrellas.length > 0 && (
        <>
          <instancedMesh ref={poleRef} args={[parts.pole, mats.pole, layout.umbrellas.length]} castShadow />
          <instancedMesh ref={canopyRef} args={[parts.canopy, mats.canopy, layout.umbrellas.length]} castShadow />
        </>
      )}
      {layout.loungers.length > 0 && (
        <instancedMesh ref={loungerRef} args={[parts.lounger, mats.lounger, layout.loungers.length]} castShadow receiveShadow />
      )}
      {boardwalk && <mesh geometry={boardwalk} material={mats.wood} castShadow receiveShadow />}

      <group position={[layout.tower.x, layout.tower.y - 0.1, layout.tower.z]} rotation={[0, layout.tower.yaw, 0]}>
        <mesh geometry={tower.wood} material={mats.wood} castShadow />
        <mesh geometry={tower.white} material={mats.white} castShadow />
        <mesh geometry={tower.red} material={mats.red} castShadow />
      </group>
    </group>
  );
}
