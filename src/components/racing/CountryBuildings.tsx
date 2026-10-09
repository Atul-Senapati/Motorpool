'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  AnimationMixer, BoxGeometry, BufferGeometry, CanvasTexture, ConeGeometry, CylinderGeometry,
  DoubleSide, Float32BufferAttribute, Group, Matrix4, Mesh, MeshStandardMaterial, RepeatWrapping,
  SRGBColorSpace, SphereGeometry, TorusGeometry, type Material, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import countryModels from '@/config/countryModelData.json';
import { DRACO_PATH } from '@/config/cityConfig';
import { BOAT_MODEL } from '@/config/boatConfig';
import { TRAIN } from '@/config/trainConfig';
import { ROAD_TOP } from '@/config/roadConfig';
import {
  ANCHOR, BEACH, BOATHOUSE, CAMPSITE, CHAPEL, CHURCH, COTTAGES, CROSSINGS, FORT_CARPARK,
  GREEN, HARBOUR, HILL_FARM, HOME_FARM, HOUSES, INN, JUNCTIONS, LAKE_Y, LIGHTHOUSE, MILL, PIER, POULTRY, STONE_CIRCLE,
  STREAM, SUMMIT, TRIG, TURBINES, VIEWPOINT, WATERMILL, armDirection, coastPoint, groundAt,
  makeRandom, roadByName, type Junction,
} from '@/config/countryConfig';

/**
 * What is built on Skylark.
 *
 * All of it is boxes, prisms and cylinders — the same procedural approach as
 * the station, the town and the airport's own fittings — because the brief
 * allowed nothing new to be downloaded and the city's houses are suburban
 * blocks that would not pass for a cottage. What makes a farmhouse read as a
 * farmhouse is not its polygons: it is a steep roof with the right pitch, a
 * chimney at the gable, small windows, and a stone garden wall with a gap
 * for the gate. Those are all here, and they are cheap.
 *
 * Every building is described in its own frame (x along, z across, the front
 * at +z) and placed with one matrix, so a cottage on a slope is placed at
 * the ground under its centre and the pad it stands on is graded flat in
 * `countryConfig`. One merged mesh per material, so the whole hamlet is a
 * dozen draw calls; the four turbines, the mill's sails and nothing else
 * move.
 */

const TAU = Math.PI * 2;

type Mat =
  | 'stone' | 'paleStone' | 'white' | 'cream' | 'brick' | 'timber' | 'wood' | 'thatch' | 'tile'
  | 'slate' | 'steel' | 'steelGreen' | 'glass' | 'door' | 'red' | 'black' | 'concrete' | 'straw'
  | 'muck' | 'lantern' | 'boat' | 'sarsen' | 'tentOrange' | 'tentBlue' | 'tentGreen' | 'caravan';

const MATERIALS: Record<Mat, MeshStandardMaterial> = {
  stone: new MeshStandardMaterial({ color: '#a89a86', roughness: 0.96 }),
  paleStone: new MeshStandardMaterial({ color: '#c9c2b4', roughness: 0.92 }),
  white: new MeshStandardMaterial({ color: '#ece7dc', roughness: 0.9 }),
  cream: new MeshStandardMaterial({ color: '#e7d9b0', roughness: 0.9 }),
  brick: new MeshStandardMaterial({ color: '#8f5a44', roughness: 0.93 }),
  timber: new MeshStandardMaterial({ color: '#5b4632', roughness: 0.9 }),
  wood: new MeshStandardMaterial({ color: '#8b7355', roughness: 0.85 }),
  thatch: new MeshStandardMaterial({ color: '#b09a62', roughness: 1, side: DoubleSide }),
  tile: new MeshStandardMaterial({ color: '#9a5f48', roughness: 0.9, side: DoubleSide }),
  slate: new MeshStandardMaterial({ color: '#4d5257', roughness: 0.7, side: DoubleSide }),
  steel: new MeshStandardMaterial({ color: '#8d9399', roughness: 0.55, metalness: 0.5, side: DoubleSide }),
  steelGreen: new MeshStandardMaterial({ color: '#4a6a4c', roughness: 0.6, metalness: 0.3, side: DoubleSide }),
  glass: new MeshStandardMaterial({ color: '#3e4a56', roughness: 0.25, metalness: 0.3 }),
  door: new MeshStandardMaterial({ color: '#3f5a3a', roughness: 0.8 }),
  red: new MeshStandardMaterial({ color: '#c8102e', roughness: 0.6 }),
  black: new MeshStandardMaterial({ color: '#222426', roughness: 0.7 }),
  concrete: new MeshStandardMaterial({ color: '#8f8c84', roughness: 0.9 }),
  straw: new MeshStandardMaterial({ color: '#c9a962', roughness: 0.95 }),
  muck: new MeshStandardMaterial({ color: '#4a3322', roughness: 1 }),
  lantern: new MeshStandardMaterial({ color: '#fff2c0', emissive: '#fff0b0', emissiveIntensity: 1.4, roughness: 0.4 }),
  boat: new MeshStandardMaterial({ color: '#e6e2d6', roughness: 0.7 }),
  sarsen: new MeshStandardMaterial({ color: '#7d7a72', roughness: 0.98 }),
  tentOrange: new MeshStandardMaterial({ color: '#e0762e', roughness: 0.85, side: DoubleSide }),
  tentBlue: new MeshStandardMaterial({ color: '#3a6fb0', roughness: 0.85, side: DoubleSide }),
  tentGreen: new MeshStandardMaterial({ color: '#5a8a3a', roughness: 0.85, side: DoubleSide }),
  caravan: new MeshStandardMaterial({ color: '#e9e7e0', roughness: 0.6 }),
};

/**
 * Surfaces for the yard's materials, painted once on the client — the
 * materials are module singletons, and a canvas needs a document — and
 * mapped in metres by `Yard.add`'s box UVs. Each is one tile of the size
 * given, repeated.
 */
type Surface = 'stone' | 'render' | 'brick' | 'timber' | 'planks' | 'slate' | 'tile' | 'thatch' | 'concrete';

function surfaceTile(kind: Surface): { texture: CanvasTexture; metres: number } {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  let seed = 9000 + kind.length * 131;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const shade = (base: [number, number, number], v: number) => `rgb(${base[0] + v},${base[1] + v},${base[2] + v})`;
  let metres = 2;
  switch (kind) {
    case 'stone': {
      // Rubble stone: courses of uneven blocks in a warm grey, dark mortar.
      ctx.fillStyle = '#6a6259';
      ctx.fillRect(0, 0, size, size);
      for (let row = 0, y = 0; y < size; row++) {
        const h = 22 + rnd() * 16;
        for (let x = -rnd() * 30; x < size; ) {
          const w = 28 + rnd() * 40;
          ctx.fillStyle = shade([164, 150, 130], Math.floor((rnd() - 0.5) * 44));
          ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
          x += w;
        }
        y += h;
      }
      metres = 2.6;
      break;
    }
    case 'brick': {
      ctx.fillStyle = '#b9ab98';
      ctx.fillRect(0, 0, size, size);
      for (let row = 0, y = 0; y < size; row++, y += 16) {
        for (let x = (row % 2) * -16; x < size; x += 34) {
          ctx.fillStyle = shade([146, 88, 66], Math.floor((rnd() - 0.5) * 40));
          ctx.fillRect(x + 1.5, y + 1.5, 31, 13);
        }
      }
      metres = 2.2;
      break;
    }
    case 'render': {
      ctx.fillStyle = '#e9e4d8';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 6000; i++) {
        const v = Math.floor((rnd() - 0.5) * 26);
        ctx.fillStyle = `rgba(${210 + v},${205 + v},${192 + v},0.6)`;
        ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      metres = 3;
      break;
    }
    case 'timber':
    case 'planks': {
      const dark = kind === 'timber';
      ctx.fillStyle = dark ? '#3f3123' : '#7a6448';
      ctx.fillRect(0, 0, size, size);
      for (let x = 0; x < size; x += 22) {
        ctx.fillStyle = dark ? shade([88, 68, 48], Math.floor((rnd() - 0.5) * 30)) : shade([142, 116, 84], Math.floor((rnd() - 0.5) * 34));
        ctx.fillRect(x + 1, 0, 20, size);
        for (let k = 0; k < 40; k++) {
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.fillRect(x + 2 + rnd() * 17, rnd() * size, 1, 6 + rnd() * 20);
        }
      }
      metres = 2.4;
      break;
    }
    case 'slate':
    case 'tile': {
      const slate = kind === 'slate';
      ctx.fillStyle = slate ? '#2e3236' : '#6e3f2e';
      ctx.fillRect(0, 0, size, size);
      for (let row = 0, y = 0; y < size; row++, y += 24) {
        for (let x = (row % 2) * -14; x < size; x += 28) {
          ctx.fillStyle = slate ? shade([84, 90, 96], Math.floor((rnd() - 0.5) * 28)) : shade([160, 100, 74], Math.floor((rnd() - 0.5) * 34));
          ctx.fillRect(x + 1, y + 1, 26, 22);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x + 1, y + 20, 26, 3);
        }
      }
      metres = 1.6;
      break;
    }
    case 'thatch': {
      ctx.fillStyle = '#9c8656';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 5000; i++) {
        ctx.fillStyle = shade([176, 154, 98], Math.floor((rnd() - 0.5) * 60));
        ctx.fillRect(rnd() * size, rnd() * size, 1, 6 + rnd() * 18);
      }
      metres = 2;
      break;
    }
    case 'concrete': {
      ctx.fillStyle = '#8f8c84';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 5000; i++) {
        const v = Math.floor((rnd() - 0.5) * 30);
        ctx.fillStyle = `rgba(${140 + v},${137 + v},${130 + v},0.7)`;
        ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      metres = 2.5;
      break;
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1 / metres, 1 / metres);
  texture.anisotropy = 4;
  return { texture, metres };
}

const SURFACE_OF: Partial<Record<Mat, Surface>> = {
  stone: 'stone', paleStone: 'stone', sarsen: 'stone', white: 'render', cream: 'render', brick: 'brick',
  timber: 'timber', wood: 'planks', slate: 'slate', tile: 'tile', thatch: 'thatch', concrete: 'concrete',
};

let surfacesApplied = false;
/** Paints the tiles and hangs them on the shared materials, once. */
function applySurfaces() {
  if (surfacesApplied || typeof document === 'undefined') return;
  surfacesApplied = true;
  const made = new Map<Surface, CanvasTexture>();
  for (const [mat, kind] of Object.entries(SURFACE_OF) as Array<[Mat, Surface]>) {
    if (!made.has(kind)) made.set(kind, surfaceTile(kind).texture);
    const m = MATERIALS[mat];
    m.map = made.get(kind)!;
    // The texture carries the tone now; the colour only tints it.
    m.color.set(mat === 'paleStone' ? '#d8d2c6' : mat === 'cream' ? '#f0e2b8' : mat === 'sarsen' ? '#a6a29a' : '#ffffff');
    m.needsUpdate = true;
  }
}

interface Box { x: number; y: number; z: number; turn: number; w: number; h: number; d: number }

/** Everything a scene of buildings is: geometry by material, and its solid boxes. */
class Yard {
  parts = new Map<Mat, BufferGeometry[]>();
  boxes: Box[] = [];
  private frame = new Matrix4();
  private origin = { x: 0, y: 0, z: 0, turn: 0 };

  /** All later pieces are in this frame until the next `at`. */
  at(x: number, z: number, turn: number, y = groundAt(x, z)) {
    this.origin = { x, y, z, turn };
    this.frame.makeRotationY(turn).setPosition(x, y, z);
    return this;
  }

  add(mat: Mat, source: BufferGeometry) {
    // Everything non-indexed with the same three attributes, or the merge
    // refuses: three's primitives are indexed and the roofs are not.
    const g = source.index ? source.toNonIndexed() : source;
    if (g !== source) source.dispose();
    g.applyMatrix4(this.frame);
    // World-scale box mapping, so a texture reads in metres on every face
    // whatever the box's size: each vertex takes the two world coordinates
    // across its face's normal. A 14 m wall gets fourteen metres of stone,
    // not one stretched stone.
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nor.getX(i));
      const ny = Math.abs(nor.getY(i));
      const nz = Math.abs(nor.getZ(i));
      const x = pos.getX(i);
      const yy = pos.getY(i);
      const z = pos.getZ(i);
      if (ny >= nx && ny >= nz) { uv[i * 2] = x; uv[i * 2 + 1] = z; }
      else if (nx >= nz) { uv[i * 2] = z; uv[i * 2 + 1] = yy; }
      else { uv[i * 2] = x; uv[i * 2 + 1] = yy; }
    }
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat)!.push(g);
  }

  box(mat: Mat, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) {
    const g = new BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  cylinder(mat: Mat, rTop: number, rBottom: number, h: number, x: number, y: number, z: number, seg = 16) {
    const g = new CylinderGeometry(rTop, rBottom, h, seg);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  /** A pitched roof, ridge along x, eaves at y = 0, with an overhang. */
  gable(mat: Mat, w: number, d: number, rise: number, x: number, y: number, z: number, over = 0.35, ry = 0) {
    const hw = w / 2 + over;
    const hd = d / 2 + over;
    // The eaves drop below the wall top by the overhang's share of the pitch,
    // so the roof reads as sitting on the walls rather than floating.
    const drop = (over / (d / 2)) * rise;
    const p: number[] = [];
    const tri = (a: number[], b: number[], c: number[]) => p.push(...a, ...b, ...c);
    const e0 = [-hw, -drop, -hd]; const e1 = [hw, -drop, -hd];
    const e2 = [hw, -drop, hd]; const e3 = [-hw, -drop, hd];
    const r0 = [-hw, rise, 0]; const r1 = [hw, rise, 0];
    tri(e0, e1, r1); tri(e0, r1, r0);
    tri(e3, r0, r1); tri(e3, r1, e2);
    // The gable ends, in the wall's own material would be better; the roof
    // material is used so the roof is one geometry.
    const g0 = [-w / 2, -drop, -d / 2]; const g1 = [-w / 2, -drop, d / 2]; const gr0 = [-w / 2, rise, 0];
    const h0 = [w / 2, -drop, -d / 2]; const h1 = [w / 2, -drop, d / 2]; const hr0 = [w / 2, rise, 0];
    tri(g0, gr0, g1); tri(h0, h1, hr0);
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(p, 3));
    g.computeVertexNormals();
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  solid(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) {
    const o = this.origin;
    const c = Math.cos(o.turn);
    const s = Math.sin(o.turn);
    this.boxes.push({
      x: o.x + x * c + z * s, y: o.y + y, z: o.z - x * s + z * c, turn: o.turn + ry, w, h, d,
    });
  }

  /** A house: walls, roof, chimneys, windows, a door. Front at +z. */
  house(opts: {
    w: number; d: number; storeys: number; wall: Mat; roof: Mat; x?: number; z?: number; ry?: number;
    chimneys?: number; pitch?: number;
  }) {
    const { w, d, storeys, wall, roof, x = 0, z = 0, ry = 0 } = opts;
    const h = storeys * 2.8 + 0.5;
    const rise = d * (opts.pitch ?? (roof === 'thatch' ? 0.62 : 0.5));
    const frameX = (lx: number, lz: number) => x + lx * Math.cos(ry) + lz * Math.sin(ry);
    const frameZ = (lx: number, lz: number) => z - lx * Math.sin(ry) + lz * Math.cos(ry);
    this.box(wall, w, h, d, x, h / 2, z, ry);
    this.gable(roof, w, d, rise, x, h, z, roof === 'thatch' ? 0.55 : 0.35, ry);
    for (let i = 0; i < (opts.chimneys ?? 1); i++) {
      const cx = (i ? -1 : 1) * (w / 2 - 1.0);
      this.box('brick', 0.9, 1.9, 0.9, frameX(cx, 0), h + rise - 0.3 + 0.6, frameZ(cx, 0), ry);
    }
    // Windows and the door on the front, windows on the back.
    const count = Math.max(2, Math.floor(w / 2.6));
    for (let s = 0; s < storeys; s++) {
      for (let i = 0; i < count; i++) {
        const wx = -w / 2 + (i + 0.5) * (w / count);
        const wy = 1.45 + s * 2.8;
        const isDoor = s === 0 && i === Math.floor(count / 2);
        if (isDoor) {
          this.box('door', 1.0, 2.1, 0.12, frameX(wx, d / 2), 1.05, frameZ(wx, d / 2), ry);
          this.box('timber', 1.4, 0.14, 0.7, frameX(wx, d / 2 + 0.3), 2.2, frameZ(wx, d / 2 + 0.3), ry);
        } else {
          this.box('glass', 1.0, 1.15, 0.1, frameX(wx, d / 2), wy, frameZ(wx, d / 2), ry);
        }
        this.box('glass', 1.0, 1.15, 0.1, frameX(wx, -d / 2), wy, frameZ(wx, -d / 2), ry);
      }
    }
    this.solid(w, h, d, x, h / 2, z, ry);
    return h + rise;
  }

  /** A barn: bigger, plainer, with a big door. `open` leaves the front off. */
  barn(opts: { w: number; d: number; h: number; wall: Mat; roof: Mat; x?: number; z?: number; ry?: number; open?: boolean }) {
    const { w, d, h, wall, roof, x = 0, z = 0, ry = 0 } = opts;
    const rise = d * 0.38;
    if (opts.open) {
      // Back and ends, and a row of posts along the open front.
      const fx = (lx: number, lz: number) => x + lx * Math.cos(ry) + lz * Math.sin(ry);
      const fz = (lx: number, lz: number) => z - lx * Math.sin(ry) + lz * Math.cos(ry);
      this.box(wall, w, h, 0.25, fx(0, -d / 2), h / 2, fz(0, -d / 2), ry);
      this.box(wall, 0.25, h, d, fx(-w / 2, 0), h / 2, fz(-w / 2, 0), ry);
      this.box(wall, 0.25, h, d, fx(w / 2, 0), h / 2, fz(w / 2, 0), ry);
      const posts = Math.floor(w / 4.5);
      for (let i = 0; i <= posts; i++) {
        const px = -w / 2 + (i * w) / posts;
        this.box('timber', 0.3, h, 0.3, fx(px, d / 2 - 0.2), h / 2, fz(px, d / 2 - 0.2), ry);
      }
      this.solid(w, h, 0.3, 0, h / 2, -d / 2, ry);
    } else {
      this.box(wall, w, h, d, x, h / 2, z, ry);
      const fx = x + (d / 2) * Math.sin(ry);
      const fz = z + (d / 2) * Math.cos(ry);
      this.box('timber', Math.min(5, w * 0.35), h * 0.8, 0.14, fx, h * 0.4, fz, ry);
      this.solid(w, h, d, x, h / 2, z, ry);
    }
    this.gable(roof, w, d, rise, x, h, z, 0.5, ry);
  }

  /** A low wall round a rectangle, with a gap in the front. */
  garden(w: number, d: number, x: number, z: number, ry: number, gap = 1.4) {
    const fx = (lx: number, lz: number) => x + lx * Math.cos(ry) + lz * Math.sin(ry);
    const fz = (lx: number, lz: number) => z - lx * Math.sin(ry) + lz * Math.cos(ry);
    const t = 0.32;
    const h = 0.95;
    this.box('stone', w, h, t, fx(0, -d / 2), h / 2, fz(0, -d / 2), ry);
    this.box('stone', t, h, d, fx(-w / 2, 0), h / 2, fz(-w / 2, 0), ry);
    this.box('stone', t, h, d, fx(w / 2, 0), h / 2, fz(w / 2, 0), ry);
    const side = (w - gap) / 2;
    this.box('stone', side, h, t, fx(-w / 2 + side / 2, d / 2), h / 2, fz(-w / 2 + side / 2, d / 2), ry);
    this.box('stone', side, h, t, fx(w / 2 - side / 2, d / 2), h / 2, fz(w / 2 - side / 2, d / 2), ry);
  }

  bench(x: number, z: number, ry: number) {
    this.box('wood', 1.7, 0.06, 0.45, x, 0.45, z, ry);
    this.box('wood', 1.7, 0.42, 0.06, x - Math.sin(ry) * 0.22, 0.72, z - Math.cos(ry) * 0.22, ry);
    for (const s of [-0.7, 0.7]) {
      this.box('black', 0.06, 0.45, 0.45, x + Math.cos(ry) * s, 0.22, z - Math.sin(ry) * s, ry);
    }
  }

  merged(): Array<{ mat: Mat; geometry: BufferGeometry }> {
    const out: Array<{ mat: Mat; geometry: BufferGeometry }> = [];
    for (const [mat, list] of this.parts) {
      const geometry = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      geometry.computeBoundingSphere();
      out.push({ mat, geometry });
    }
    return out;
  }
}

/* ---------------------------------------------------------- text boards */

function textBoard(text: string, w: number, h: number, bg: string, fg: string, size = 46): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = fg;
  ctx.font = `700 ${size}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function Board({ text, w, h, x, y, z, turn, bg = '#f4efe2', fg = '#1c1c1c', size }: {
  text: string; w: number; h: number; x: number; y: number; z: number; turn: number;
  bg?: string; fg?: string; size?: number;
}) {
  const tex = useMemo(() => textBoard(text, w, h, bg, fg, size), [text, w, h, bg, fg, size]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[x, y, z]} rotation={[0, turn, 0]} castShadow>
      <boxGeometry args={[w, h, 0.05]} />
      <meshStandardMaterial map={tex} roughness={0.7} />
    </mesh>
  );
}

/** A white fingerpost with an arm per destination. */
function Fingerpost({ j, arms, corner }: {
  j: Junction;
  arms: Array<{ arm: 'px' | 'nx' | 'pz' | 'nz'; text: string }>;
  corner: ['px' | 'nx', 'pz' | 'nz'];
}) {
  const [ax, az] = armDirection(j, corner[0]);
  const [bx, bz] = armDirection(j, corner[1]);
  const x = j.x + (ax + bx) * 12.5;
  const z = j.z + (az + bz) * 12.5;
  const y = groundAt(x, z);
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, 1.6, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.1, 3.2, 8]} />
        <meshStandardMaterial color="#f0ede4" roughness={0.6} />
      </mesh>
      {arms.map(({ arm, text }, i) => {
        const [dx, dz] = armDirection(j, arm);
        const turn = Math.atan2(dx, dz) + Math.PI / 2;
        return (
          <Board
            key={arm}
            text={text}
            w={1.35}
            h={0.2}
            x={dx * 0.72}
            y={2.75 - i * 0.28}
            z={dz * 0.72}
            turn={turn}
            size={54}
          />
        );
      })}
    </group>
  );
}

/* ---------------------------------------------------------- the places */

/** Home Farm's wall: its radius, and the gaps in it — `[angle, half-width]`, radians, in the farm's frame. */
const HOME_FARM_WALL = 49;
const HOME_FARM_GAPS: Array<[number, number]> = [
  // The farm lane, 19 m wide plus its verges, coming in along (0.88, 0.47).
  [Math.atan2(0.47, 0.88), 0.27],
  // The back lane, going out to the south-west.
  [Math.atan2(39, -33), 0.11],
];

function buildAll() {
  const rnd = makeRandom(41);
  const y = new Yard();

  /*
   * Home Farm: a farmstead round a yard.
   *
   * The farm lane — a full 19 m kit road — comes in from the east-south-east
   * and ends in the middle, and the back lane leaves the same spot for the
   * south-west; everything is laid round those two and the clear courtyard
   * where they meet, with room between: the farmhouse and its garden to the
   * north-west, the big barn to the north-east and its silos behind it, the
   * hay barn east of the yard, the old stone byre west, the machinery shed
   * across the south between the two roads, the silage clamp off the yard's
   * south-west corner, and a stone wall round the lot with gaps for both
   * roads. It used to be packed into half the space, with the yard wall
   * running through the big barn and the hay barn, the clamp into the byre,
   * the muck heap inside the open barn and the farm lane through all of it.
   * Frame: the farm's own (`HOME_FARM.turn`); the lane leaves along
   * (0.88, 0.47), the back lane along (−0.8, 0.6).
   */
  {
    const H = HOME_FARM;
    y.at(H.x, H.z, H.turn);
    // The farmhouse, its garden round it, and the hen house beside that.
    y.house({ w: 14, d: 8, storeys: 2, wall: 'stone', roof: 'slate', x: -20, z: -26, ry: 0, chimneys: 2 });
    y.garden(20, 13, -20, -28, 0);
    // The big barn, the one the farm is worked from, with its silos behind it.
    y.barn({ w: 30, d: 15, h: 5.5, wall: 'steelGreen', roof: 'steel', x: 14, z: -30, ry: 0 });
    for (const sx of [-6, -1]) {
      y.cylinder('steel', 2.2, 2.2, 9, sx, 4.5, -43, 18);
      const cone = new ConeGeometry(2.35, 1.8, 18);
      cone.translate(sx, 9.9, -43);
      y.add('steel', cone);
      y.solid(4.4, 9, 4.4, sx, 4.5, -43);
    }
    // The old stone byre, end on to the yard on the west.
    y.barn({ w: 16, d: 7, h: 4.5, wall: 'stone', roof: 'tile', x: -38, z: -12, ry: Math.PI / 2 });
    // The machinery shed across the south, its open front to the yard.
    y.barn({ w: 22, d: 10, h: 4.2, wall: 'timber', roof: 'steel', x: -6, z: 40, ry: Math.PI, open: true });

    // The Dutch barn east of the yard: a roof on posts with the hay under it.
    {
      const dx = 36;
      const dz = -12;
      for (const px of [-8, 0, 8]) {
        for (const pz of [-4, 4]) y.box('steel', 0.25, 6, 0.25, dx + px, 3, dz + pz);
      }
      y.gable('steel', 18, 9, 2.2, dx, 6, dz, 0.6);
      for (let i = 0; i < 3; i++) {
        for (let k = 0; k < 4; k++) {
          const bale = new CylinderGeometry(0.78, 0.78, 1.25, 12);
          bale.rotateZ(Math.PI / 2);
          bale.translate(dx - 6 + k * 1.4 + (i % 2) * 0.7, 0.78 + i * 1.5, dz + (i % 2 ? 0.6 : -0.6));
          y.add('straw', bale);
        }
      }
    }
    // A water trough against the byre's yard side.
    y.box('concrete', 0.9, 0.7, 2.2, -33.4, 0.35, -12);
    y.box('concrete', 0.7, 0.08, 2.0, -33.4, 0.75, -12);

    /*
     * The silage clamp, and it is the thing that makes a farm read as a farm
     * from the air: three concrete walls open at one end, a black-sheeted
     * heap inside them, and old tyres all over the sheet holding it down.
     * Nothing else on an island of green and stone is a black rectangle.
     */
    {
      const w = 16;
      const d = 11;
      const h = 2.6;
      const cx = -22;
      const cz = 6;
      y.box('concrete', 0.6, h, d, cx - w / 2, h / 2, cz);
      y.box('concrete', 0.6, h, d, cx + w / 2, h / 2, cz);
      y.box('concrete', w + 0.6, h, 0.6, cx, h / 2, cz - d / 2);
      y.box('concrete', w - 0.6, 0.12, d - 0.6, cx, 0.06, cz);
      // The clamp itself: a long heap under its sheet, shoulders sloped.
      const sheet = new BoxGeometry(w - 1.4, h * 0.82, d - 1.2);
      sheet.translate(cx, h * 0.41 + 0.1, cz);
      y.add('black', sheet);
      const crown = new BoxGeometry(w - 3.4, 0.5, d - 3.2);
      crown.translate(cx, h * 0.82 + 0.3, cz);
      y.add('black', crown);
      for (let i = 0; i < 26; i++) {
        const t = new TorusGeometry(0.34, 0.11, 6, 10);
        t.rotateX(Math.PI / 2);
        t.translate(
          cx + ((i % 6) - 2.5) * 2.2,
          h * 0.82 + 0.58,
          cz + (Math.floor(i / 6) - 2) * 1.9,
        );
        y.add('black', t);
      }
      y.solid(w + 1, h, d + 1, cx, h / 2, cz);
    }

    /*
     * The wall round the farmstead: dry stone on a circle just inside the
     * yard's level ground, with gaps where the farm lane comes in and the
     * back lane goes out, and gate piers at the lane's.
     */
    {
      const R = HOME_FARM_WALL;
      const gaps = HOME_FARM_GAPS;
      const steps = Math.round((2 * Math.PI * R) / 1.6);
      const inGap = (a: number) => gaps.some(([g, half]) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < half);
      for (let i = 0; i < steps; i++) {
        const a = ((i + 0.5) / steps) * Math.PI * 2;
        if (inGap(a)) continue;
        const x = Math.cos(a) * R;
        const z = Math.sin(a) * R;
        y.box('stone', (2 * Math.PI * R) / steps + 0.1, 1.25, 0.55, x, 0.62, z, -a - Math.PI / 2);
      }
      const [lane, half] = gaps[0];
      for (const k of [-1, 1]) {
        const a = lane + k * half;
        y.box('paleStone', 0.7, 1.7, 0.7, Math.cos(a) * R, 0.85, Math.sin(a) * R);
      }
    }

    /* The hen house, by the garden, with a pop-hole and a ramp. */
    {
      const hx = -36;
      const hz = -28;
      y.box('wood', 3.2, 1.5, 2.4, hx, 0.85, hz);
      y.gable('tile', 3.6, 2.8, 0.7, hx, 1.6, hz, 0.22);
      y.box('black', 0.5, 0.6, 0.06, hx + 0.8, 0.45, hz + 1.22);
      const ramp = new BoxGeometry(0.55, 0.06, 1.5);
      ramp.rotateX(-0.45);
      ramp.translate(hx + 0.8, 0.28, hz + 1.9);
      y.add('wood', ramp);
      for (const k of [-1.2, 1.2]) y.box('wood', 0.12, 0.85, 0.12, hx + k, 0.42, hz);
      y.solid(3.4, 2.4, 2.6, hx, 1.2, hz);
    }
  }

  /*
   * The poultry farm, beside the paddock.
   *
   * Two deep-litter sheds in a row with a feed bin between them, a hard
   * standing in front, and half a dozen free-range arks out in the run — the
   * arks are the thing that makes it read as a poultry unit rather than two
   * more barns, because they are the one farm building that is small, moved
   * about and scattered rather than lined up.
   */
  {
    const P = POULTRY;
    y.at(P.x, P.z, P.turn);
    // The two sheds, low and long, down the run's back edge.
    for (const sx of [-9.5, 4.5]) {
      const w = 12;
      const d = 6.5;
      y.box('white', w, 2.5, d, sx, 1.25, -P.d / 2 + 5.5);
      y.gable('steel', w, d, 1.1, sx, 3.75, -P.d / 2 + 5.5, 0.4);
      // The pop-holes along the front, and a ramp down from each.
      for (const k of [-3.5, 0, 3.5]) {
        y.box('black', 0.55, 0.65, 0.07, sx + k, 0.5, -P.d / 2 + 5.5 + d / 2);
        const ramp = new BoxGeometry(0.6, 0.07, 1.6);
        ramp.rotateX(-0.42);
        ramp.translate(sx + k, 0.3, -P.d / 2 + 5.5 + d / 2 + 0.85);
        y.add('wood', ramp);
      }
      // A door at the near end, and a vent ridge.
      y.box('door', 0.1, 1.9, 1.1, sx + w / 2, 0.95, -P.d / 2 + 5.5);
      y.solid(w, 3.8, d, sx, 1.9, -P.d / 2 + 5.5);
    }
    // The feed bin between them: a hopper on four legs with a cone below.
    {
      const bx = -2.5;
      const bz = -P.d / 2 + 5;
      y.cylinder('steel', 1.35, 1.35, 2.6, bx, 3.6, bz, 14);
      const cone = new ConeGeometry(1.35, 1.5, 14);
      cone.rotateZ(Math.PI);
      cone.translate(bx, 1.7, bz);
      y.add('steel', cone);
      const lid = new ConeGeometry(1.42, 0.5, 14);
      lid.translate(bx, 5.1, bz);
      y.add('steel', lid);
      for (const [lx, lz] of [[-0.95, -0.95], [0.95, -0.95], [0.95, 0.95], [-0.95, 0.95]] as const) {
        y.box('steel', 0.12, 1.1, 0.12, bx + lx, 0.55, bz + lz);
      }
      y.solid(2.8, 5.4, 2.8, bx, 2.7, bz);
    }
    // The hard standing in front of the sheds.
    y.box('concrete', 30, 0.1, 5, -2.5, 0.05, -P.d / 2 + 11.5);
    // Free-range arks out in the run: a gable on skids, each turned its own way.
    const arkRnd = makeRandom(19);
    for (const [ax, az] of [[-14, 6], [-5, 8], [2, 5], [12, 7], [-9, 10.5], [7, 10]] as const) {
      const turn = arkRnd() * Math.PI;
      y.box('wood', 2.1, 0.6, 1.5, ax, 0.42, az, turn);
      y.gable('tile', 2.3, 1.7, 0.55, ax, 0.72, az, 0.15, turn);
      // The skids it is dragged about on.
      for (const k of [-0.62, 0.62]) {
        const skid = new BoxGeometry(2.5, 0.14, 0.16);
        skid.rotateY(turn);
        skid.translate(ax + Math.sin(turn + Math.PI / 2) * k, 0.07, az + Math.cos(turn + Math.PI / 2) * k);
        y.add('wood', skid);
      }
      y.solid(2.4, 1.3, 1.8, ax, 0.65, az, turn);
    }
    // A water trough and a scatter of feeders.
    y.box('concrete', 2.4, 0.5, 0.8, 13, 0.25, -2);
    y.box('concrete', 2.2, 0.06, 0.6, 13, 0.55, -2);
    for (const [fx, fz] of [[-7, 4], [1, 8], [9, 3]] as const) {
      y.cylinder('steel', 0.42, 0.28, 0.75, fx, 0.37, fz, 10);
      const hat = new ConeGeometry(0.5, 0.35, 10);
      hat.translate(fx, 0.9, fz);
      y.add('steel', hat);
    }
  }

  /* Hill Farm */
  {
    const H = HILL_FARM;
    y.at(H.x, H.z, H.turn);
    y.house({ w: 11, d: 7, storeys: 2, wall: 'stone', roof: 'slate', x: -8, z: -6, chimneys: 2 });
    y.barn({ w: 18, d: 9, h: 4.6, wall: 'stone', roof: 'tile', x: 6, z: 9, ry: 0 });
    y.barn({ w: 12, d: 7, h: 3.6, wall: 'timber', roof: 'steel', x: 12, z: -8, ry: Math.PI / 2, open: true });
    y.garden(15, 10, -8, -7, 0);
    // Sheep pens: rails round two squares.
    for (const [px, pz] of [[-12, 10], [-3, 12]] as const) {
      for (let i = 0; i <= 4; i++) {
        for (const [ex, ez] of [[-4 + i * 2, -4], [-4 + i * 2, 4], [-4, -4 + i * 2], [4, -4 + i * 2]] as const) {
          y.box('wood', 0.12, 1.1, 0.12, px + ex, 0.55, pz + ez);
        }
      }
      for (const rise of [0.45, 0.85]) {
        y.box('wood', 8, 0.08, 0.05, px, rise, pz - 4);
        y.box('wood', 8, 0.08, 0.05, px, rise, pz + 4);
        y.box('wood', 0.05, 0.08, 8, px - 4, rise, pz);
        y.box('wood', 0.05, 0.08, 8, px + 4, rise, pz);
      }
    }
  }

  /* The hamlet's houses, the pub, the hall */
  // The cottages themselves are the city's houses now — see `Houses` — so
  // the yard only lays each one's garden.
  for (const c of COTTAGES) {
    y.at(c.x, c.z, c.turn);
    y.garden(c.w + 7, c.d + 9, 0, 2.5, 0);
    if (rnd() < 0.5) y.bench(c.w / 2 + 1.5, c.d / 2 + 1.5, 0.3);
  }
  {
    y.at(INN.x, INN.z, INN.turn);
    // Tables out front.
    for (const bx of [-5, 0, 5]) {
      y.box('wood', 1.8, 0.06, 0.8, bx, 0.75, INN.d / 2 + 4);
      y.box('wood', 1.8, 0.06, 0.35, bx, 0.45, INN.d / 2 + 3.2);
      y.box('wood', 1.8, 0.06, 0.35, bx, 0.45, INN.d / 2 + 4.8);
      y.box('black', 0.1, 0.72, 0.6, bx, 0.36, INN.d / 2 + 4);
    }
    y.cylinder('black', 0.07, 0.09, 3.6, INN.w / 2 + 3, 1.8, INN.d / 2 + 2, 8);
  }

  /* The church */
  {
    const C = CHURCH;
    y.at(C.x, C.z, C.turn);
    // The church itself is the download, placed by `Church` below; what is
    // built here is its yard: the wall, the lychgate and the stones.
    // The yard wall, with the lychgate on the lane side.
    const segs = 36;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * TAU;
      const a1 = ((i + 1) / segs) * TAU;
      const mid = (a0 + a1) / 2;
      // The gap faces the lane: the yard's local +z is toward it.
      if (Math.abs(Math.atan2(Math.sin(mid - Math.PI / 2), Math.cos(mid - Math.PI / 2))) < 0.12) continue;
      const len = (TAU * C.yard) / segs;
      y.box('stone', len + 0.2, 1.1, 0.4, Math.cos(mid) * C.yard, 0.55, Math.sin(mid) * C.yard, -mid);
    }
    y.box('timber', 0.25, 2.8, 0.25, -1.6, 1.4, C.yard);
    y.box('timber', 0.25, 2.8, 0.25, 1.6, 1.4, C.yard);
    y.gable('tile', 3.8, 2.2, 1.0, 0, 2.8, C.yard, 0.2);
    // Gravestones, leaning as old stones do.
    for (let i = 0; i < 34; i++) {
      const a = rnd() * TAU;
      const r = 8 + rnd() * (C.yard - 11);
      const gx = Math.cos(a) * r;
      const gz = Math.sin(a) * r;
      if (Math.abs(gx) < 6.5 && Math.abs(gz) < 10.5) continue;
      if (gz > 6 && Math.abs(gx) < 3) continue;
      const g = new BoxGeometry(0.55 + rnd() * 0.3, 0.8 + rnd() * 0.5, 0.1);
      g.rotateZ((rnd() - 0.5) * 0.25);
      g.rotateY(rnd() * 0.5);
      g.translate(gx, 0.4, gz);
      y.add('paleStone', g);
    }
  }

  /* The green: the memorial, the phone box, the post box, the shelter, the cricket pavilion. */
  {
    const j = JUNCTIONS.cross;
    y.at(GREEN.memorial[0], GREEN.memorial[1], j.turn);
    y.box('paleStone', 2.6, 0.25, 2.6, 0, 0.125, 0);
    y.box('paleStone', 1.8, 0.6, 1.8, 0, 0.55, 0);
    y.box('paleStone', 0.55, 3.4, 0.55, 0, 2.5, 0);
    y.box('paleStone', 0.32, 1.5, 0.32, 0, 4.9, 0);
    y.box('paleStone', 1.1, 0.3, 0.3, 0, 5.2, 0);
    y.solid(1.8, 5.6, 1.8, 0, 2.8, 0);
    const [ex, ez] = armDirection(j, 'px');
    const [nx, nz] = armDirection(j, 'nz');
    const [sx, sz] = armDirection(j, 'pz');
    const [wx, wz] = armDirection(j, 'nx');
    // The phone box and the post box on the north-east corner.
    y.at(j.x + (ex + nx) * 13.5, j.z + (ez + nz) * 13.5, j.turn);
    y.box('red', 1.0, 2.5, 1.0, 0, 1.25, 0);
    y.box('red', 1.08, 0.22, 1.08, 0, 2.6, 0);
    y.box('glass', 0.7, 1.7, 1.03, 0, 1.45, 0);
    y.box('glass', 1.03, 1.7, 0.7, 0, 1.45, 0);
    y.solid(1.0, 2.6, 1.0, 0, 1.3, 0);
    y.cylinder('red', 0.28, 0.28, 1.5, 2.2, 0.75, 0.3, 12);
    y.cylinder('black', 0.32, 0.3, 0.12, 2.2, 1.55, 0.3, 12);
    // The bus shelter on the south-west corner, facing the road.
    y.at(j.x + (wx + sx) * 13.5, j.z + (wz + sz) * 13.5, j.turn + Math.PI);
    y.box('timber', 3.2, 2.3, 0.1, 0, 1.15, -0.75);
    y.box('timber', 0.1, 2.3, 1.6, -1.55, 1.15, 0);
    y.box('timber', 0.1, 2.3, 1.6, 1.55, 1.15, 0);
    y.box('slate', 3.6, 0.12, 2.0, 0, 2.36, 0.1);
    y.box('wood', 3.0, 0.06, 0.4, 0, 0.48, -0.5);
    y.solid(3.2, 2.3, 1.6, 0, 1.15, 0);
    // The pavilion, at the edge of the outfield.
    const [cx, cz] = GREEN.cricket;
    y.at(cx - nx * 44, cz - nz * 44, j.turn);
    y.box('white', 9, 3, 4.5, 0, 1.5, 0);
    y.gable('slate', 9, 4.5, 1.6, 0, 3, 0, 0.5);
    y.box('white', 9.5, 0.1, 2.4, 0, 2.8, 3.2);
    for (const px of [-4.4, 0, 4.4]) y.box('white', 0.12, 2.8, 0.12, px, 1.4, 4.3);
    y.solid(9, 3, 4.5, 0, 1.5, 0);
    // The sight screen behind the bowler's arm.
    y.at(cx + nx * 42, cz + nz * 42, j.turn);
    y.box('white', 4.5, 3.2, 0.12, 0, 2.4, 0);
    for (const px of [-2, 2]) y.box('white', 0.15, 0.9, 0.15, px, 0.45, 0);
  }

  /* The lighthouse, and the keeper's cottage. */
  {
    y.at(LIGHTHOUSE.x, LIGHTHOUSE.z, 0.4);
    y.cylinder('white', 2.2, 3.0, 14, 0, 7, 0, 22);
    y.cylinder('red', 2.65, 2.78, 2.6, 0, 7.6, 0, 22);
    y.cylinder('concrete', 3.2, 3.2, 0.35, 0, 14.1, 0, 22);
    const rail = new TorusGeometry(3.05, 0.05, 6, 32);
    rail.rotateX(Math.PI / 2);
    rail.translate(0, 15.2, 0);
    y.add('black', rail);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      y.box('black', 0.05, 1.0, 0.05, Math.cos(a) * 3.05, 14.75, Math.sin(a) * 3.05);
    }
    y.cylinder('glass', 1.9, 1.9, 2.6, 0, 15.6, 0, 14);
    const lamp = new SphereGeometry(0.55, 10, 8);
    lamp.translate(0, 15.7, 0);
    y.add('lantern', lamp);
    const dome = new SphereGeometry(2.05, 16, 8, 0, TAU, 0, Math.PI / 2);
    dome.scale(1, 0.7, 1);
    dome.translate(0, 16.9, 0);
    y.add('black', dome);
    y.box('door', 1.0, 2.1, 0.12, 0, 1.05, 3.0);
    y.solid(6, 14, 6, 0, 7, 0);
    y.house({ w: 9, d: 6, storeys: 1, wall: 'white', roof: 'slate', x: 8.5, z: 0, ry: 0 });
    y.garden(22, 16, 4, 1, 0, 2);
  }

  /* The trig point and its cairn on the summit. */
  {
    y.at(TRIG.x, TRIG.z, 0);
    y.cylinder('concrete', 0.3, 0.4, 1.25, 0, 0.62, 0, 8);
    y.box('black', 0.34, 0.06, 0.34, 0, 1.27, 0);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU;
      const s = new SphereGeometry(0.3 + (i % 3) * 0.1, 6, 5);
      s.translate(Math.cos(a) * 1.3, 0.2, Math.sin(a) * 1.3);
      y.add('paleStone', s);
    }
  }

  /* The viewpoint: a bench, a board, a rail along the cliff. */
  {
    const V = VIEWPOINT;
    y.at(V.x, V.z, V.turn);
    y.bench(0, -V.r - 5, Math.PI);
    y.bench(4, -V.r - 5.5, Math.PI + 0.2);
    for (let i = -6; i <= 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * 0.9;
      const r = V.r + 9;
      y.box('wood', 0.12, 1.1, 0.12, Math.cos(a) * r, 0.5, Math.sin(a) * r);
    }
    for (let i = -6; i < 6; i++) {
      const a0 = -Math.PI / 2 + (i / 6) * 0.9;
      const a1 = -Math.PI / 2 + ((i + 1) / 6) * 0.9;
      const r = V.r + 9;
      const x0 = Math.cos(a0) * r; const z0 = Math.sin(a0) * r;
      const x1 = Math.cos(a1) * r; const z1 = Math.sin(a1) * r;
      const len = Math.hypot(x1 - x0, z1 - z0);
      y.box('wood', len, 0.08, 0.05, (x0 + x1) / 2, 0.95, (z0 + z1) / 2, Math.atan2(-(z1 - z0), x1 - x0));
    }
  }

  /* The boathouse, its jetty and the boat. */
  {
    const B = BOATHOUSE;
    y.at(B.x, B.z, B.turn);
    y.box('timber', 7, 3.6, 5, 0, 1.8, 0);
    y.gable('tile', 7, 5, 2.0, 0, 3.6, 0, 0.4);
    y.box('door', 2.6, 2.6, 0.12, 0, 1.3, 2.55);
    y.solid(7, 3.6, 5, 0, 1.8, 0);
    const deckY = LAKE_Y + 0.5 - groundAt(B.x, B.z);
    y.box('wood', 1.8, 0.14, 16, 6, deckY, 8);
    for (let k = 0; k < 4; k++) {
      for (const px of [5.3, 6.7]) y.box('timber', 0.22, 2.4, 0.22, px, deckY - 1.0, 3 + k * 3.6);
    }
    const hull = new BoxGeometry(1.4, 0.55, 3.6);
    hull.translate(8.2, deckY - 0.25, 12);
    y.add('boat', hull);
    const inner = new BoxGeometry(1.0, 0.4, 3.0);
    inner.translate(8.2, deckY - 0.1, 12);
    y.add('timber', inner);
  }

  /* The harbour: the quay's furniture, its sheds, the pub, the slipway, the light. */
  {
    const H = HARBOUR;
    y.at(H.x, H.z, H.turn, H.quayY);
    // Along the front: bollards every eight metres a couple of metres in
    // from the wall, which is 44 m out from the quay's centre.
    for (let u = -40; u <= 40; u += 8) {
      y.cylinder('black', 0.22, 0.28, 0.9, u, 0.45, 41.5, 10);
      y.cylinder('black', 0.3, 0.26, 0.16, u, 0.95, 41.5, 10);
    }
    // Two stone stores with slate roofs along the back of the quay — the
    // harbourmaster's and the fish store — and nothing else on the apron
    // but the bollards, two benches and a slipway. It had a timber barn, a
    // crane, lobster pots and dinghies, and read as a builder's yard.
    y.house({ w: 9, d: 6, storeys: 1, wall: 'stone', roof: 'slate', x: 20, z: 22, ry: 0, chimneys: 1 });
    y.house({ w: 13, d: 6.5, storeys: 1, wall: 'stone', roof: 'slate', x: -18, z: 21, ry: 0, chimneys: 0 });
    // The quay wall's coping and a rope rail between the bollards.
    y.box('paleStone', 88, 0.22, 0.9, 0, 0.11, 43.7);
    y.bench(-10, 34, Math.PI);
    y.bench(10, 34, Math.PI);
    // The slipway, at the cove end of the quay: concrete running down into the water.
    const slip = new BoxGeometry(6, 0.5, 18);
    slip.rotateX(0.34);
    slip.translate(36, -2.6, 46);
    y.add('concrete', slip);
    y.solid(6, 0.5, 18, 36, -2.6, 46);
  }
  {
    y.at(ANCHOR.x, ANCHOR.z, ANCHOR.turn);
    y.house({ w: ANCHOR.w, d: ANCHOR.d, storeys: 2, wall: 'white', roof: 'slate', chimneys: 2 });
    for (const bx of [-4, 1]) {
      y.box('wood', 1.8, 0.06, 0.8, bx, 0.75, ANCHOR.d / 2 + 3.5);
      y.box('wood', 1.8, 0.06, 0.35, bx, 0.45, ANCHOR.d / 2 + 2.7);
      y.box('wood', 1.8, 0.06, 0.35, bx, 0.45, ANCHOR.d / 2 + 4.3);
      y.box('black', 0.1, 0.72, 0.6, bx, 0.36, ANCHOR.d / 2 + 3.5);
    }
    y.cylinder('black', 0.07, 0.09, 3.6, ANCHOR.w / 2 + 2.5, 1.8, ANCHOR.d / 2 + 1.5, 8);
  }
  // The harbour light at the pier's end.
  {
    const tip = PIER.pts[PIER.pts.length - 1];
    y.at(tip[0], tip[1], 0, PIER.top);
    y.cylinder('white', 0.55, 0.7, 4.6, 0, 2.3, 0, 12);
    y.cylinder('red', 0.62, 0.62, 0.9, 0, 3.4, 0, 12);
    const lamp = new SphereGeometry(0.32, 8, 6);
    lamp.translate(0, 4.95, 0);
    y.add('lantern', lamp);
    y.cylinder('black', 0.7, 0.55, 0.3, 0, 5.3, 0, 12);
    y.solid(1.4, 5, 1.4, 0, 2.5, 0);
  }

  /* The stone bridge over the brook, and the ford's sign. */
  for (const c of CROSSINGS) {
    const road = roadByName(c.road);
    y.at(c.x, c.z, Math.atan2(c.tx, c.tz), c.y + ROAD_TOP);
    if (c.kind === 'bridge') {
      const half = road.width / 2;
      const drop = c.y + ROAD_TOP - c.bed + 0.9;
      // Parapets either side of the carriageway, and the abutments down to
      // the bed on each bank, with an arch of voussoirs over the water.
      for (const side of [-1, 1] as const) {
        y.box('stone', 0.45, 1.05, 13, side * (half + 0.4), 0.5, 0);
        y.box('paleStone', 0.55, 0.12, 13.2, side * (half + 0.4), 1.08, 0);
        y.solid(0.45, 1.05, 13, side * (half + 0.4), 0.5, 0);
      }
      for (const along of [-3.2, 3.2] as const) {
        y.box('stone', road.width + 1.7, drop, 0.7, 0, -drop / 2 - 0.07, along);
        y.solid(road.width + 1.7, drop, 0.7, 0, -drop / 2 - 0.07, along);
      }
      for (const face of [-1, 1] as const) {
        for (let k = 0; k < 7; k++) {
          const a = Math.PI * (k / 6);
          const rx = Math.cos(a) * 3.0;
          const ry = -0.2 - Math.sin(a) * 2.2;
          y.box('paleStone', 0.5, 0.5, 0.35, face * (half + 0.9), ry - drop + 3.2, rx, a);
        }
      }
    } else {
      // "FORD": a post either side, and a depth gauge.
      y.box('white', 0.12, 2.2, 0.12, road.width / 2 + 1.4, 1.1, -7);
      y.box('white', 0.12, 2.2, 0.12, -road.width / 2 - 1.4, 1.1, 7);
      y.box('white', 0.16, 1.4, 0.05, -road.width / 2 - 0.9, 0.7, 0);
      for (let k = 0; k < 5; k++) y.box('black', 0.16, 0.04, 0.06, -road.width / 2 - 0.9, 0.2 + k * 0.28, 0);
    }
  }

  /* The watermill: its wheel is animated; here the house, the leat wall and the bank. */
  {
    const M = WATERMILL;
    y.at(M.x, M.z, M.turn);
    y.house({ w: 9, d: 7, storeys: 1, wall: 'stone', roof: 'tile', chimneys: 1, pitch: 0.6 });
    y.box('stone', 3.5, 4.5, 0.4, -3, 2.2, -5.5);
    y.box('stone', 0.4, 4.5, 6, -4.8, 2.2, -2.5);
  }

  /* The chapel ruin: a gable with its window, two walls, no roof. */
  {
    y.at(CHAPEL.x, CHAPEL.z, CHAPEL.turn);
    y.box('stone', 7, 6, 0.7, 0, 3, -5.5);
    y.box('stone', 1.8, 6, 0.7, -2.6, 3, -5.5);
    const gable = new BoxGeometry(7.2, 2.2, 0.7);
    gable.translate(0, 6.6, -5.5);
    y.add('stone', gable);
    y.box('stone', 0.7, 2.4, 11, -3.5, 1.2, 0);
    y.box('stone', 0.7, 3.6, 4, -3.5, 1.8, -3.2);
    y.box('stone', 0.7, 1.6, 7, 3.5, 0.8, -1.5);
    y.box('stone', 2.2, 4.5, 0.7, 2.4, 2.25, 5.5);
    y.solid(7, 6, 0.7, 0, 3, -5.5);
    y.solid(0.7, 2.4, 11, -3.5, 1.2, 0);
    for (let i = 0; i < 7; i++) {
      const g = new BoxGeometry(0.5, 0.7 + (i % 3) * 0.2, 0.1);
      g.rotateZ((i % 2 ? 1 : -1) * 0.15);
      g.translate(6 + (i % 3) * 1.6, 0.35, -3 + i * 1.4);
      y.add('paleStone', g);
    }
  }

  /* The stone circle. */
  {
    const C = STONE_CIRCLE;
    y.at(C.x, C.z, 0);
    for (let i = 0; i < C.count; i++) {
      const a = (i / C.count) * TAU;
      const h = 1.8 + ((i * 7) % 5) * 0.2;
      const g = new BoxGeometry(0.9 + (i % 2) * 0.3, h, 0.55);
      g.rotateZ(((i % 3) - 1) * 0.08);
      g.rotateY(a + 0.3);
      g.translate(Math.cos(a) * C.r, h / 2 - 0.15, Math.sin(a) * C.r);
      y.add('sarsen', g);
      y.solid(1.0, h, 0.6, Math.cos(a) * C.r, h / 2, Math.sin(a) * C.r, -(a + 0.3));
    }
    const fallen = new BoxGeometry(2.4, 0.5, 0.9);
    fallen.rotateY(0.6);
    fallen.translate(2, 0.2, -1);
    y.add('sarsen', fallen);
  }

  /* The summit: the toposcope, a bench, the trig point is already there. */
  {
    y.at(SUMMIT.x, SUMMIT.z, SUMMIT.turn);
    y.cylinder('paleStone', 0.42, 0.5, 1.15, 0, 0.58, -8, 10);
    y.cylinder('paleStone', 0.62, 0.62, 0.12, 0, 1.2, -8, 14);
    y.box('black', 0.9, 0.03, 0.9, 0, 1.28, -8);
    y.bench(-4, -9, 0.4);
    y.bench(4, -9, -0.4);
  }

  /* The campsite: tents, caravans, the shower block. */
  {
    const C = CAMPSITE;
    y.at(C.x, C.z, C.turn);
    const tents: Mat[] = ['tentOrange', 'tentBlue', 'tentGreen'];
    for (let i = 0; i < 11; i++) {
      const u = -C.w / 2 + 8 + (i % 4) * 14 + ((i * 5) % 3);
      const v = -C.d / 2 + 8 + Math.floor(i / 4) * 12 + ((i * 3) % 4);
      const ry = ((i * 37) % 10) * 0.2;
      y.gable(tents[i % 3], 2.6 + (i % 2) * 0.8, 2.2, 1.35, u, 0.02, v, 0.1, ry);
    }
    for (let i = 0; i < 4; i++) {
      const u = -C.w / 2 + 10 + i * 15;
      const v = C.d / 2 - 6;
      y.box('caravan', 5.8, 2.1, 2.3, u, 1.4, v, 0.15);
      y.box('slate', 6.0, 0.2, 2.5, u, 2.55, v, 0.15);
      y.box('glass', 1.6, 0.8, 0.08, u - 1, 1.7, v + 1.18, 0.15);
      y.box('black', 0.6, 0.6, 0.25, u, 0.3, v, 0.15);
      y.solid(5.8, 2.6, 2.3, u, 1.3, v, 0.15);
    }
    y.house({ w: 8, d: 4.5, storeys: 1, wall: 'timber', roof: 'steel', x: C.w / 2 - 6, z: -C.d / 2 + 4, chimneys: 0, pitch: 0.35 });
    for (let i = 0; i < 3; i++) {
      const u = -C.w / 2 + 12 + i * 20;
      const v = 0;
      y.box('wood', 1.8, 0.06, 0.8, u, 0.75, v);
      y.box('wood', 1.8, 0.06, 0.35, u, 0.45, v - 0.8);
      y.box('wood', 1.8, 0.06, 0.35, u, 0.45, v + 0.8);
      y.box('black', 0.1, 0.72, 0.6, u, 0.36, v);
    }
  }

  /* The fort's car park: a board, and the beach: a lifebuoy post and an upturned boat. */
  {
    y.at(FORT_CARPARK.x, FORT_CARPARK.z, 0);
    y.box('timber', 0.12, 2.2, 0.12, -4, 1.1, 6);
    y.box('timber', 0.12, 2.2, 0.12, -2.6, 1.1, 6);
    const [bx, bz] = coastPoint(BEACH.theta, 40);
    y.at(bx, bz, 0);
    y.box('white', 0.12, 2.4, 0.12, 0, 1.2, 0);
    const ring = new TorusGeometry(0.4, 0.09, 6, 16);
    ring.rotateY(Math.PI / 2);
    ring.translate(0, 1.8, 0);
    y.add('red', ring);
    const hull = new BoxGeometry(1.6, 0.5, 4.2);
    hull.rotateY(0.7);
    hull.translate(6, 0.25, 4);
    y.add('boat', hull);
  }

  return y;
}

/* ---------------------------------------------------------- the movers */

/** The island's own kit and its animated models — see `prepare-country.mjs`. */
const COUNTRY_KIT = '/models/country.glb';
const WINDMILL_MODEL = '/models/country/windmill.glb';
useGLTF.preload(COUNTRY_KIT, DRACO_PATH);
useGLTF.preload(WINDMILL_MODEL, DRACO_PATH);

/** A kit part's meshes, as geometry and material pairs to draw in place. */
function kitPairs(kit: Object3D, name: string): Array<{ geometry: BufferGeometry; material: Material }> {
  const out: Array<{ geometry: BufferGeometry; material: Material }> = [];
  kit.getObjectByName(name)?.traverse((child) => {
    if (child instanceof Mesh) out.push({ geometry: child.geometry, material: child.material as Material });
  });
  return out;
}

/**
 * The windmill, out of the download: a tower mill whose sails are skinned to
 * two bones and driven by the file's own clip. Cloned through SkeletonUtils
 * so the skeleton is its own, and played by a mixer of its own.
 */
function Windmill() {
  const { scene, animations } = useGLTF(WINDMILL_MODEL, DRACO_PATH);
  const object = useMemo(() => {
    const copy = skeletonClone(scene);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; child.frustumCulled = false; }
    });
    return copy;
  }, [scene]);
  const mixer = useMemo(() => new AnimationMixer(object), [object]);
  useEffect(() => {
    const clip = animations.find((a) => a.name === countryModels.life.windmill.clip) ?? animations[0];
    if (clip) mixer.clipAction(clip).play();
    return () => { mixer.stopAllAction(); };
  }, [mixer, animations]);
  useFrame((_, dt) => mixer.update(Math.min(0.05, dt)));
  const y = groundAt(MILL.x, MILL.z);
  return <primitive object={object} position={[MILL.x, y, MILL.z]} rotation={[0, MILL.turn, 0]} />;
}

/**
 * The turbines, out of the kit: the tower with its nacelle, and the rotor as
 * a separate part pivoted on its hub so that turning it turns it. The wind is
 * from the south-west; every rotor faces it, near enough.
 */
function Turbines() {
  const { scene: kit } = useGLTF(COUNTRY_KIT, DRACO_PATH);
  const parts = useMemo(() => ({ tower: kitPairs(kit, 'turbineTower'), blades: kitPairs(kit, 'turbineBlades') }), [kit]);
  const rotors = useRef<Array<Group | null>>([]);
  useFrame((_, dt) => {
    const step = Math.min(0.05, dt);
    rotors.current.forEach((r, i) => {
      if (r) r.rotation.z -= step * (0.72 + i * 0.05);
    });
  });
  const [hx, hy, hz] = countryModels.turbineHub;
  return (
    <>
      {TURBINES.map((t, i) => {
        const y = groundAt(t.x, t.z);
        const turn = -0.78 + (i - 1.5) * 0.04;
        return (
          <group key={i} position={[t.x, y, t.z]} rotation={[0, turn, 0]}>
            {parts.tower.map((p, k) => (
              <mesh key={`t${k}`} geometry={p.geometry} material={p.material} castShadow receiveShadow />
            ))}
            <mesh position={[0, 0.4, 0]} receiveShadow>
              <cylinderGeometry args={[3.2, 3.4, 0.8, 14]} />
              <meshStandardMaterial color="#8f8c84" roughness={0.9} />
            </mesh>
            <group position={[hx, hy, hz]} ref={(el) => { rotors.current[i] = el; }}>
              {parts.blades.map((p, k) => (
                <mesh key={`b${k}`} geometry={p.geometry} material={p.material} castShadow />
              ))}
            </group>
          </group>
        );
      })}
    </>
  );
}

/**
 * The church, out of the download: a chapel at one and a half times, in the
 * middle of the yard the procedural one stood in. Its long axis runs along
 * the yard's local z, which is toward the lane, so the door end faces it.
 */
function Church() {
  const { scene: kit } = useGLTF(COUNTRY_KIT, DRACO_PATH);
  const object = useMemo(() => {
    const node = kit.getObjectByName('church');
    if (!node) return null;
    const copy = node.clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return copy;
  }, [kit]);
  if (!object) return null;
  return (
    <primitive object={object} position={[CHURCH.x, groundAt(CHURCH.x, CHURCH.z), CHURCH.z]} rotation={[0, CHURCH.turn, 0]} />
  );
}

/**
 * Every house on the island is the city's: the three placed by hand, and
 * the hamlet's cottages and the inn, which were procedural boxes until the
 * user asked for the city's houses instead. A cottage picks the kit part
 * whose plan is nearest its own footprint's shape and is scaled down to
 * fit it — the city's houses are suburban and twice a cottage's size — but
 * never below 0.55, where a door stops being a door.
 */
const HOUSE_PARTS = ['houseSmall', 'houseWide', 'houseLong', 'house01', 'house02', 'house06', 'house09', 'house10', 'house12', 'house13'] as const;

function fitHouse(w: number, d: number, seed: number): { part: string; scale: number } {
  const parts = countryModels.parts as Record<string, { size: number[] }>;
  const want = w / d;
  let best = HOUSE_PARTS[0] as string;
  let bestScore = Infinity;
  HOUSE_PARTS.forEach((name, i) => {
    const size = parts[name]?.size;
    if (!size) return;
    const have = size[0] / size[2];
    const score = Math.abs(Math.log(have / want)) + ((i * 7 + seed) % 5) * 0.06;
    if (score < bestScore) { bestScore = score; best = name; }
  });
  const size = parts[best].size;
  // Scaled to FIT the footprint, never past it: a house that overhung its
  // plot by a fifth put its wall in the lane.
  const scale = Math.min(1, Math.max(0.45, Math.min(w / size[0], d / size[2])));
  return { part: best, scale };
}

export const KIT_HOUSES: ReadonlyArray<{ part: string; x: number; z: number; turn: number; label: string; scale: number }> = [
  ...HOUSES.map((h) => ({ part: h.part, x: h.x, z: h.z, turn: h.turn, label: h.label, scale: 'scale' in h ? h.scale : 1 })),
  ...COTTAGES.map((c, i) => ({ ...fitHouse(c.w, c.d, i), x: c.x, z: c.z, turn: c.turn, label: c.label })),
  { ...fitHouse(INN.w, INN.d, 3), x: INN.x, z: INN.z, turn: INN.turn, label: 'the inn' },
];

function Houses() {
  const { scene: kit } = useGLTF(COUNTRY_KIT, DRACO_PATH);
  const placed = useMemo(() => KIT_HOUSES.map((h) => {
    const node = kit.getObjectByName(h.part);
    if (!node) return null;
    const copy = node.clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return { ...h, object: copy };
  }).filter((h): h is NonNullable<typeof h> => h !== null), [kit]);
  return (
    <>
      {placed.map((h) => (
        <primitive
          key={h.label}
          object={h.object}
          position={[h.x, groundAt(h.x, h.z), h.z]}
          rotation={[0, h.turn, 0]}
          scale={[h.scale, h.scale, h.scale]}
        />
      ))}
    </>
  );
}

/**
 * The mill wheel, in the brook: an undershot wheel two and a half metres
 * across, its rim dipping into the channel, turning at the water's pace.
 */
function MillWheel() {
  const wheel = useRef<Group>(null);
  useFrame((_, dt) => {
    if (wheel.current) wheel.current.rotation.x -= Math.min(0.05, dt) * 0.6;
  });
  // The stream sample nearest the mill, and the mill's side of it.
  let best = STREAM[0];
  let bestD = Infinity;
  for (const sm of STREAM) {
    const d = Math.hypot(sm.x - WATERMILL.x, sm.z - WATERMILL.z);
    if (d < bestD) { bestD = d; best = sm; }
  }
  const side = (WATERMILL.x - best.x) * best.nx + (WATERMILL.z - best.z) * best.nz >= 0 ? 1 : -1;
  const x = best.x + best.nx * 2.3 * side;
  const z = best.z + best.nz * 2.3 * side;
  const turn = Math.atan2(best.nx, best.nz) + (side > 0 ? 0 : Math.PI);
  return (
    <group position={[x, best.bed + 2.1, z]} rotation={[0, turn, 0]}>
      {/* The axle, back to the mill's wall. */}
      <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.16, 0.16, 5.6, 8]} />
        <meshStandardMaterial color="#3a3028" roughness={0.8} />
      </mesh>
      <group ref={wheel}>
        {[-0.6, 0.6].map((off) => (
          <mesh key={off} position={[off, 0, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
            <torusGeometry args={[2.4, 0.14, 8, 28]} />
            <meshStandardMaterial color="#5b4632" roughness={0.9} />
          </mesh>
        ))}
        {Array.from({ length: 14 }, (_, i) => (
          <group key={i} rotation={[(i * TAU) / 14, 0, 0]}>
            <mesh position={[0, 2.3, 0]} castShadow>
              <boxGeometry args={[1.3, 0.55, 0.08]} />
              <meshStandardMaterial color="#6b5540" roughness={0.9} />
            </mesh>
            <mesh position={[0, 1.15, 0]}>
              <boxGeometry args={[0.1, 2.3, 0.1]} />
              <meshStandardMaterial color="#5b4632" roughness={0.9} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

/**
 * Boats at their moorings in the cove: the game's own hulls, cloned, riding
 * the same water the sea traffic does and bobbing on it.
 */
function Moorings() {
  const { scene } = useGLTF(BOAT_MODEL, DRACO_PATH);
  const group = useRef<Group>(null);
  const boats = useMemo(() => {
    const out: Array<{ object: Object3D; x: number; z: number; turn: number; phase: number }> = [];
    const H = HARBOUR;
    const along: [number, number] = [-H.out[1], H.out[0]];
    const at = (a: number, o: number): [number, number] => [
      H.x + along[0] * a + H.out[0] * o, H.z + along[1] * a + H.out[1] * o,
    ];
    const spots: Array<[string, number, number, number]> = [
      ['cruiser', -22, 62, 0.4], ['sail', 6, 70, 1.1], ['cruiser', 30, 60, -0.3], ['tug', -4, 86, 2.2],
    ];
    spots.forEach(([id, a, o, turn], i) => {
      const source = scene.getObjectByName(id);
      if (!source) return;
      const object = source.clone(true);
      object.traverse((child) => {
        if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      const [x, z] = at(a, o);
      out.push({ object, x, z, turn: Math.atan2(H.out[0], H.out[1]) + turn, phase: i * 1.7 });
    });
    return out;
  }, [scene]);
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    g.children.forEach((child, i) => {
      const boat = boats[i];
      if (!boat) return;
      child.position.y = TRAIN.seaLevel + 0.12 + Math.sin(t * 0.9 + boat.phase) * 0.08;
      child.rotation.z = Math.sin(t * 0.7 + boat.phase) * 0.025;
      child.rotation.x = Math.sin(t * 1.1 + boat.phase * 2) * 0.015;
    });
  });
  return (
    <group ref={group}>
      {boats.map((boat, i) => (
        <primitive key={i} object={boat.object} position={[boat.x, TRAIN.seaLevel, boat.z]} rotation={[0, boat.turn, 0]} />
      ))}
    </group>
  );
}

export function CountryBuildings() {
  useMemo(() => applySurfaces(), []);
  const yard = useMemo(() => buildAll(), []);
  const merged = useMemo(() => yard.merged(), [yard]);
  useEffect(() => () => { for (const m of merged) m.geometry.dispose(); }, [merged]);

  const lane = roadByName('laneEnd');
  const signAt = lane.samples[Math.min(lane.samples.length - 1, Math.round(150 / 3))];
  const signX = signAt.x + signAt.nx * -13.5;
  const signZ = signAt.z + signAt.nz * -13.5;

  return (
    <group>
      {merged.map(({ mat, geometry }) => (
        <mesh key={mat} geometry={geometry} material={MATERIALS[mat]} castShadow receiveShadow />
      ))}
      <Windmill />
      <Turbines />
      <Church />
      <Houses />
      <MillWheel />
      <Moorings />

      {/* The signs: the village name where the lane enters it, the inn's
          board, and a fingerpost at each junction. */}
      <group position={[signX, groundAt(signX, signZ), signZ]} rotation={[0, Math.atan2(-signAt.nx, -signAt.nz), 0]}>
        <mesh position={[0, 1.4, 0]} castShadow>
          <boxGeometry args={[0.14, 2.8, 0.14]} />
          <meshStandardMaterial color="#2b2b2b" roughness={0.7} />
        </mesh>
        <Board text="SKYLARK" w={2.2} h={0.6} x={0} y={2.35} z={0} turn={0} bg="#1e3d2b" fg="#f4efe2" size={90} />
        <Board text="please drive carefully" w={2.2} h={0.3} x={0} y={1.85} z={0} turn={0} bg="#f4efe2" fg="#1e3d2b" size={44} />
      </group>
      <Board
        text="The Skylark"
        w={1.3}
        h={0.85}
        x={INN.x + Math.cos(INN.turn) * (INN.w / 2 + 3) + Math.sin(INN.turn) * (INN.d / 2 + 2)}
        y={groundAt(INN.x, INN.z) + 3.0}
        z={INN.z - Math.sin(INN.turn) * (INN.w / 2 + 3) + Math.cos(INN.turn) * (INN.d / 2 + 2)}
        turn={INN.turn}
        bg="#1e3d2b"
        fg="#e8d9a0"
        size={80}
      />
      <Fingerpost
        j={JUNCTIONS.bridgeHead}
        corner={['nx', 'nz']}
        arms={[
          { arm: 'px', text: 'HALCYON FIELD' },
          { arm: 'nx', text: 'SKYLARK ½' },
          { arm: 'nz', text: 'HOME FARM' },
        ]}
      />
      <Fingerpost
        j={JUNCTIONS.cross}
        corner={['nx', 'pz']}
        arms={[
          { arm: 'nz', text: 'CHURCH · VIEWPOINT' },
          { arm: 'px', text: 'SKYLARK WATER' },
          { arm: 'pz', text: 'THE DOWNS · HARBOUR' },
          { arm: 'nx', text: 'HALCYON FIELD 1' },
        ]}
      />
      <Fingerpost
        j={JUNCTIONS.coombe}
        corner={['nx', 'nz']}
        arms={[
          { arm: 'nx', text: 'SKYLARK 1' },
          { arm: 'px', text: 'HILL FARM · THE DOWNS' },
          { arm: 'nz', text: 'HARBOUR ½ · CAMPSITE' },
        ]}
      />
      <Board text="CASTLE HILL FORT" w={1.6} h={0.5} x={FORT_CARPARK.x - 3.3} y={groundAt(FORT_CARPARK.x, FORT_CARPARK.z) + 1.7} z={FORT_CARPARK.z + 6} turn={0} bg="#4b3a2a" fg="#f4efe2" size={62} />
      <Board text="THE DOWNS · 45 m" w={1.4} h={0.4} x={SUMMIT.x} y={groundAt(SUMMIT.x, SUMMIT.z) + 1.6} z={SUMMIT.z - 4} turn={SUMMIT.turn} bg="#4b3a2a" fg="#f4efe2" size={60} />

      <RigidBody type="fixed" colliders={false}>
        {yard.boxes.map((b, i) => (
          <CuboidCollider
            key={i}
            args={[b.w / 2, b.h / 2, b.d / 2]}
            position={[b.x, b.y, b.z]}
            rotation={[0, b.turn, 0]}
            friction={0.5}
          />
        ))}
        {TURBINES.map((t, i) => (
          <CuboidCollider key={`tb${i}`} args={[1.6, 19, 1.8]} position={[t.x, groundAt(t.x, t.z) + 19, t.z]} />
        ))}
        <CuboidCollider args={[3.4, 7, 3.4]} position={[MILL.x, groundAt(MILL.x, MILL.z) + 7, MILL.z]} />
        {(() => {
          const size = (countryModels.parts as Record<string, { size: number[] }>).church?.size ?? [9, 16, 18];
          return (
            <CuboidCollider
              args={[size[0] / 2, size[1] / 2, size[2] / 2]}
              position={[CHURCH.x, groundAt(CHURCH.x, CHURCH.z) + size[1] / 2, CHURCH.z]}
              rotation={[0, CHURCH.turn, 0]}
            />
          );
        })()}
        {KIT_HOUSES.map((h) => {
          const raw = (countryModels.parts as Record<string, { size: number[] }>)[h.part]?.size ?? [10, 6, 10];
          const size = raw.map((v) => v * h.scale);
          return (
            <CuboidCollider
              key={h.label}
              args={[size[0] / 2, size[1] / 2, size[2] / 2]}
              position={[h.x, groundAt(h.x, h.z) + size[1] / 2, h.z]}
              rotation={[0, h.turn, 0]}
            />
          );
        })}
      </RigidBody>
    </group>
  );
}
