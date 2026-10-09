'use client';

import { useEffect, useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, CylinderGeometry, DoubleSide, Float32BufferAttribute, Matrix4,
  MeshStandardMaterial, PlaneGeometry, RepeatWrapping, RingGeometry, SRGBColorSpace, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  HELI_DECK, HELI_DECK_TOP, HELI_FORECOURT, HELI_GROUND, HELI_ROOF, HELI_TOWER,
} from '@/config/heliportConfig';

/**
 * Halcyon Heliport: a glass tower with the pad on its roof.
 *
 * A double-height glazed lobby set back behind slim concrete columns, an
 * entrance canopy cantilevered out over the forecourt on tie rods, and four
 * office floors over it in a blue curtain wall with aluminium fins and
 * concrete slab edges, framed by two concrete piers at the front corners. On
 * the roof, a steel helideck on short legs — touchdown circle, H, yellow edge,
 * green edge lights, safety netting round it — with the stair-and-lift
 * housing beside it and a windsock on that.
 *
 * **Light to draw.** Every piece is built once, in the tower's own frame, and
 * merged into ONE geometry per material — a dozen meshes for the whole
 * building rather than one per fin, light, leg and step. Textures are mapped
 * in metres by box projection, so one small texture per material serves
 * every face at any size, with no per-face copies.
 *
 * Drawn inside `AirportIsland`'s group, so x is `along` (the front, with the
 * doors, faces +x — the road) and z is `across`. The boarding ring on the
 * forecourt is `HeliportBoarding`'s.
 */

/* ------------------------------------------------------------- textures */

function canvas(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** One office floor of curtain wall, 3 m wide × 4 m tall: two panes, a mullion, a spandrel. */
function curtainTexture() {
  return canvas(128, 170, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 140);
    sky.addColorStop(0, '#a9d0ec');
    sky.addColorStop(0.45, '#5f93bf');
    sky.addColorStop(1, '#2b5379');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 128, 140);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(20, 0); ctx.lineTo(60, 0); ctx.lineTo(5, 140); ctx.lineTo(-35, 140);
    ctx.fill();
    // The spandrel, at the foot of each floor.
    ctx.fillStyle = '#26323e';
    ctx.fillRect(0, 140, 128, 30);
    ctx.fillStyle = '#c8ced4';
    for (const x of [0, 63, 125]) ctx.fillRect(x, 0, 3, 170);
    ctx.fillRect(0, 138, 128, 3);
  });
}

/** The lobby's full-height glazing, 3 m wide: clearer, warm-lit behind. */
function lobbyTexture() {
  return canvas(64, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#7fa8c8');
    g.addColorStop(0.5, '#4c7192');
    g.addColorStop(1, '#3a5068');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 128);
    // The lit interior, low down (canvas bottom is the glass's foot).
    ctx.fillStyle = 'rgba(255,214,150,0.24)';
    ctx.fillRect(0, 80, 64, 48);
    ctx.fillStyle = '#d3d8dd';
    ctx.fillRect(0, 0, 2, 128);
    ctx.fillRect(62, 0, 2, 128);
    ctx.fillRect(0, 22, 64, 2);
  });
}

/** Board-marked concrete, pale and warm, 4 m square. */
function concreteTexture() {
  return canvas(128, 128, (ctx) => {
    ctx.fillStyle = '#d7d3ca';
    ctx.fillRect(0, 0, 128, 128);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 700; i++) {
      const v = 190 + Math.floor(rnd() * 40);
      ctx.fillStyle = `rgba(${v},${v - 4},${v - 10},0.35)`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    ctx.fillStyle = 'rgba(120,115,105,0.25)';
    for (const y of [0, 64]) ctx.fillRect(0, y, 128, 1);
    ctx.fillRect(0, 0, 1, 128);
  });
}

/** The plain blue board: white name, thin white border — see the signage rule. */
function signTexture(text: string) {
  const tex = canvas(512, 106, (ctx) => {
    ctx.fillStyle = '#1d3f73';
    ctx.fillRect(0, 0, 512, 106);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 8, 496, 90);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 57);
  });
  // A board is one face, not a tile.
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  return tex;
}

/** The helideck's netting: a dark mesh with see-through holes, 0.5 m a tile. */
function netTexture() {
  return canvas(32, 32, (ctx) => {
    ctx.clearRect(0, 0, 32, 32);
    ctx.strokeStyle = 'rgba(30,34,38,1)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(1, 0); ctx.lineTo(1, 32); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(32, 1); ctx.stroke();
  });
}

/* --------------------------------------------------------------- builder */

type Mat = 'concrete' | 'curtain' | 'lobby' | 'core' | 'ceiling' | 'fin' | 'steel' | 'door' | 'white' | 'glow'
  | 'deck' | 'yellow' | 'paint' | 'green' | 'net' | 'sign' | 'orange' | 'paving';

/**
 * Box-projected UVs in metres, divided by the material's tile and offset by
 * its origin — so a curtain wall's floor bands land on the floors whatever
 * the face's size, and concrete reads at the same grain everywhere.
 */
const TILE: Partial<Record<Mat, [number, number, number]>> = {
  // [tile width, tile height, vertical origin]
  concrete: [4, 4, 0],
  // Floors start over the lobby, so the bands are counted from there.
  curtain: [3, 4, HELI_TOWER.lobby],
  lobby: [3, 5.6, 0.3],
  net: [0.5, 0.5, 0],
};

class Kit {
  parts = new Map<Mat, BufferGeometry[]>();
  private m = new Matrix4();

  /** Adds a geometry already placed in the tower's frame. */
  add(mat: Mat, g: BufferGeometry, keepUv = false) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    const tile = TILE[mat];
    if (tile && !keepUv) {
      const pos = geo.getAttribute('position');
      const nor = geo.getAttribute('normal');
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        const nx = Math.abs(nor.getX(i));
        const ny = Math.abs(nor.getY(i));
        const nz = Math.abs(nor.getZ(i));
        const x = pos.getX(i);
        const y = pos.getY(i) - tile[2];
        const z = pos.getZ(i);
        if (ny >= nx && ny >= nz) { uv[i * 2] = x / tile[0]; uv[i * 2 + 1] = z / tile[0]; }
        else if (nx >= nz) { uv[i * 2] = z / tile[0]; uv[i * 2 + 1] = y / tile[1]; }
        else { uv[i * 2] = x / tile[0]; uv[i * 2 + 1] = y / tile[1]; }
      }
      geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    }
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat)!.push(geo);
  }

  box(mat: Mat, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rz = 0) {
    const g = new BoxGeometry(w, h, d);
    this.m.makeRotationZ(rz);
    g.applyMatrix4(this.m);
    this.m.makeRotationY(ry);
    g.applyMatrix4(this.m);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  /** A vertical plane facing `ry` (0 faces +z). */
  plane(mat: Mat, w: number, h: number, x: number, y: number, z: number, ry: number, keepUv = false) {
    const g = new PlaneGeometry(w, h);
    g.rotateY(ry);
    g.translate(x, y, z);
    this.add(mat, g, keepUv);
  }

  /** A horizontal plane facing up, `w` along x and `d` along z. */
  flat(mat: Mat, w: number, d: number, x: number, y: number, z: number, down = false) {
    const g = new PlaneGeometry(w, d);
    g.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  cylinder(mat: Mat, r0: number, r1: number, h: number, x: number, y: number, z: number, seg = 8) {
    const g = new CylinderGeometry(r0, r1, h, seg);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  ring(mat: Mat, inner: number, outer: number, x: number, y: number, z: number) {
    const g = new RingGeometry(inner, outer, 64);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  merged(): Array<{ mat: Mat; geometry: BufferGeometry }> {
    const out: Array<{ mat: Mat; geometry: BufferGeometry }> = [];
    for (const [mat, list] of this.parts) {
      const geometry = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!geometry) continue;
      geometry.computeBoundingSphere();
      out.push({ mat, geometry });
    }
    return out;
  }
}

/* ---------------------------------------------------------------- tower */

const T = HELI_TOWER;
const W = T.w;
const D = T.d;
const L = T.lobby;
const R = HELI_ROOF;
const UPPER = R - L;
/** How far the lobby's glass is set back under the floors over it. */
const INSET = 1.4;
/** The canopy's reach out over the forecourt. */
const CANOPY_DEPTH = 6.2;
const DECK_X = HELI_DECK.along;
const DECK_HALF = HELI_DECK.size / 2;
const DECK_Y = HELI_DECK_TOP;

/** Lobby columns, under the slab edge: every ~7.5 m round the outline. */
const COLUMNS: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [];
  const along = Math.max(2, Math.round(D / 7.5));
  for (let k = 0; k <= along; k++) {
    const z = -D / 2 + 0.5 + ((D - 1) * k) / along;
    out.push([W / 2 - 0.5, z], [-W / 2 + 0.5, z]);
  }
  for (const x of [-W / 2 + 8, W / 2 - 8]) out.push([x, -D / 2 + 0.5], [x, D / 2 - 0.5]);
  return out;
})();

function buildTower() {
  const k = new Kit();

  // Plinth.
  k.box('concrete', W + 1.2, 0.3, D + 1.2, 0, 0.15, 0);

  // The lobby: glass set back behind the columns, its ceiling, and the doors.
  k.plane('lobby', D - INSET * 2, L - 0.3, W / 2 - INSET, 0.3 + (L - 0.3) / 2, 0, Math.PI / 2);
  k.plane('lobby', D - INSET * 2, L - 0.3, -W / 2 + INSET, 0.3 + (L - 0.3) / 2, 0, -Math.PI / 2);
  k.plane('lobby', W - INSET * 2, L - 0.3, 0, 0.3 + (L - 0.3) / 2, D / 2 - INSET, 0);
  k.plane('lobby', W - INSET * 2, L - 0.3, 0, 0.3 + (L - 0.3) / 2, -D / 2 + INSET, Math.PI);
  k.flat('ceiling', W, D, 0, L - 0.05, 0, true);
  for (const z of [-D / 4, 0, D / 4]) {
    // Three entrances along the wide front, each a dark double door in a steel frame.
    k.plane('door', 3.6, 3, W / 2 - INSET + 0.04, 1.8, z, Math.PI / 2);
    for (const [dz, y, w, h] of [[-1.85, 1.9, 0.14, 3.3], [1.85, 1.9, 0.14, 3.3], [0, 3.4, 3.84, 0.16], [0, 1.8, 0.08, 3]]) {
      k.box('steel', 0.1, h, w, W / 2 - INSET + 0.08, y, z + dz);
    }
  }
  for (const [x, z] of COLUMNS) k.box('concrete', 0.6, L - 0.3, 0.6, x, 0.3 + (L - 0.3) / 2, z);

  // The office floors: curtain wall all round, over a dark core.
  k.plane('curtain', D - 6, UPPER, W / 2, L + UPPER / 2, 0, Math.PI / 2);
  k.plane('curtain', D, UPPER, -W / 2, L + UPPER / 2, 0, -Math.PI / 2);
  k.plane('curtain', W, UPPER, 0, L + UPPER / 2, D / 2, 0);
  k.plane('curtain', W, UPPER, 0, L + UPPER / 2, -D / 2, Math.PI);
  k.box('core', W - 0.2, UPPER - 0.1, D - 0.2, 0, L + UPPER / 2, 0);
  // Slab edges at every floor, the roof slab thicker.
  for (let f = 0; f <= T.floors; f++) {
    const y = L + f * T.floor;
    const roof = f === T.floors;
    k.box('concrete', W + 0.6, roof ? 0.6 : 0.4, D + 0.6, 0, y - (roof ? 0.3 : 0.2), 0);
  }
  // Aluminium fins, front and back, every 3 m between the corner piers.
  for (let z = -D / 2 + 4.5; z <= D / 2 - 4.5 + 0.01; z += 3) {
    for (const x of [W / 2 + 0.3, -W / 2 - 0.3]) k.box('fin', 0.6, UPPER, 0.12, x, L + UPPER / 2, z);
  }
  // The corner piers framing the front, full height and through the parapet.
  for (const side of [-1, 1]) k.box('concrete', 1.2, R + T.parapet, 3.2, W / 2 - 0.4, (R + T.parapet) / 2, side * (D / 2 - 1.5));
  // The parapet.
  k.box('concrete', W, T.parapet, 0.3, 0, R + T.parapet / 2, D / 2);
  k.box('concrete', W, T.parapet, 0.3, 0, R + T.parapet / 2, -D / 2);
  k.box('concrete', 0.3, T.parapet, D, W / 2, R + T.parapet / 2, 0);
  k.box('concrete', 0.3, T.parapet, D, -W / 2, R + T.parapet / 2, 0);

  // The entrance canopy, the whole width of the middle bay, on tie rods.
  const canopy = Math.min(24, D - 10);
  k.box('white', CANOPY_DEPTH, 0.3, canopy, W / 2 + CANOPY_DEPTH / 2, 4.6, 0);
  k.box('glow', 0.2, 0.04, canopy - 0.6, W / 2 + CANOPY_DEPTH - 0.3, 4.43, 0);
  for (const z of [-canopy / 2 + 1, -canopy / 6, canopy / 6, canopy / 2 - 1]) {
    const dx = CANOPY_DEPTH - 0.6;
    const dy = L + 1.4 - 4.6;
    const g = new CylinderGeometry(0.045, 0.045, Math.hypot(dx, dy), 6);
    g.rotateZ(Math.atan2(dx, dy));
    g.translate(W / 2 + dx / 2 + 0.3, 4.6 + dy / 2, z);
    k.add('steel', g);
  }
  // The name, on the first floor over the canopy.
  k.plane('sign', 10, 2.1, W / 2 + 0.65, L + 2, 0, Math.PI / 2, true);

  // ---- the roof ----
  // Stair-and-lift housing beside the deck, with a windsock on it.
  const hz = D / 2 - 1.8;
  k.box('concrete', 8, 3.6, 3, -5, R + 1.8, hz);
  k.plane('door', 1.1, 2.3, -0.98, R + 1.2, hz, Math.PI / 2);
  k.cylinder('steel', 0.05, 0.07, 4.4, -8, R + 5.8, hz + 0.6);
  for (let s = 0; s < 3; s++) {
    const g = new CylinderGeometry(0.34 - s * 0.08, 0.42 - s * 0.08, 0.6, 12, 1, true);
    g.rotateZ(-Math.PI / 2 + 0.15);
    g.translate(-8 + 0.4 + s * 0.6, R + 7.8, hz + 0.6);
    k.add(s % 2 ? 'white' : 'orange', g);
  }
  // Plant on the roof's far corner, low, clear of the deck.
  for (const z of [-D / 2 + 3, -D / 2 + 6.3]) k.box('fin', 2.2, 1, 2.6, -W / 2 + 1.5, R + 0.5, z);

  // The helideck: a steel deck on legs, markings, lights and nets.
  k.box('deck', HELI_DECK.size, 0.36, HELI_DECK.size, DECK_X, DECK_Y - 0.18, 0);
  for (const a of [-7, 0, 7]) for (const b of [-7, 0, 7]) {
    k.box('steel', 0.3, HELI_DECK.lift - 0.36, 0.3, DECK_X + a, R + (HELI_DECK.lift - 0.36) / 2, b);
  }
  const top = DECK_Y + 0.004;
  const band = HELI_DECK.size - 0.6;
  k.flat('yellow', band, 0.5, DECK_X, top, DECK_HALF - 0.55);
  k.flat('yellow', band, 0.5, DECK_X, top, -DECK_HALF + 0.55);
  k.flat('yellow', 0.5, band, DECK_X + DECK_HALF - 0.55, top, 0);
  k.flat('yellow', 0.5, band, DECK_X - DECK_HALF + 0.55, top, 0);
  k.ring('yellow', HELI_DECK.ring - 0.6, HELI_DECK.ring, DECK_X, top, 0);
  // The H, upright to someone coming from the road.
  k.flat('paint', 6.2, 0.9, DECK_X, top + 0.002, -1.7);
  k.flat('paint', 6.2, 0.9, DECK_X, top + 0.002, 1.7);
  k.flat('paint', 0.9, 2.5, DECK_X, top + 0.002, 0);
  for (let s = -DECK_HALF + 1; s <= DECK_HALF - 1 + 0.01; s += 3) {
    for (const [x, z] of [[DECK_X + s, -DECK_HALF + 0.3], [DECK_X + s, DECK_HALF - 0.3], [DECK_X - DECK_HALF + 0.3, s], [DECK_X + DECK_HALF - 0.3, s]]) {
      k.cylinder('green', 0.1, 0.12, 0.14, x, DECK_Y + 0.07, z, 6);
    }
  }
  // Nets, sloping out and down from every edge; the back one leaves the stair's gap.
  const net = (w: number, x: number, z: number, ry: number) => {
    const g = new PlaneGeometry(w, 1.5);
    g.rotateX(-Math.PI / 2 + 0.22);
    g.rotateY(ry);
    g.translate(x, DECK_Y - 0.25, z);
    k.add('net', g);
  };
  net(HELI_DECK.size, DECK_X, DECK_HALF + 0.7, 0);
  net(HELI_DECK.size, DECK_X, -DECK_HALF - 0.7, Math.PI);
  net(HELI_DECK.size, DECK_X + DECK_HALF + 0.7, 0, Math.PI / 2);
  net(HELI_DECK.size - 5, DECK_X - DECK_HALF - 0.7, -2.5, -Math.PI / 2);
  // The stair up to the deck, through that gap.
  for (let s = 0; s < 5; s++) k.box('steel', 0.34, 0.08, 1.4, DECK_X - DECK_HALF - 0.3 - (4 - s) * 0.32, R + 0.16 + s * 0.29, 7);

  return k.merged();
}

function materials(): Record<Mat, Material> {
  const curtain = curtainTexture();
  const lobby = lobbyTexture();
  const concrete = concreteTexture();
  const ds = { side: DoubleSide };
  return {
    concrete: new MeshStandardMaterial({ map: concrete, roughness: 0.85 }),
    curtain: new MeshStandardMaterial({ map: curtain, roughness: 0.08, metalness: 0.55 }),
    lobby: new MeshStandardMaterial({ map: lobby, roughness: 0.12, metalness: 0.4, emissive: '#ffcf8a', emissiveIntensity: 0.08 }),
    core: new MeshStandardMaterial({ color: '#26323e', roughness: 0.9 }),
    ceiling: new MeshStandardMaterial({ color: '#e9e6df', roughness: 0.8, ...ds }),
    fin: new MeshStandardMaterial({ color: '#c3cad1', metalness: 0.65, roughness: 0.3 }),
    steel: new MeshStandardMaterial({ color: '#9ea6ae', metalness: 0.7, roughness: 0.35 }),
    door: new MeshStandardMaterial({ color: '#1e2a35', roughness: 0.1, metalness: 0.6 }),
    white: new MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.5, ...ds }),
    glow: new MeshStandardMaterial({ color: '#fff4dc', emissive: '#ffe9c0', emissiveIntensity: 1.2, toneMapped: false }),
    deck: new MeshStandardMaterial({ color: '#3d4146', roughness: 0.75, metalness: 0.3 }),
    yellow: new MeshStandardMaterial({ color: '#efbd1d', roughness: 0.55, ...ds }),
    paint: new MeshStandardMaterial({ color: '#f4f4ef', roughness: 0.6, ...ds }),
    green: new MeshStandardMaterial({ color: '#3bff7a', emissive: '#2bff6a', emissiveIntensity: 1.5, toneMapped: false }),
    net: new MeshStandardMaterial({ map: netTexture(), transparent: true, alphaTest: 0.4, roughness: 0.8, ...ds }),
    sign: new MeshStandardMaterial({ map: signTexture('HELIPORT'), roughness: 0.6 }),
    orange: new MeshStandardMaterial({ color: '#ff6a1a', roughness: 0.8, ...ds }),
    paving: new MeshStandardMaterial({ color: '#b3afa6', roughness: 0.9 }),
  };
}

/** What casts a shadow: the solid shell. The glass, paint and lights do not need to. */
const CASTS: ReadonlySet<Mat> = new Set(['concrete', 'core', 'fin', 'white', 'deck']);

export function Heliport() {
  const parts = useMemo(() => buildTower(), []);
  const mats = useMemo(() => materials(), []);
  useEffect(() => () => {
    for (const p of parts) p.geometry.dispose();
    for (const m of Object.values(mats)) {
      (m as MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  }, [parts, mats]);

  const F = HELI_FORECOURT;
  return (
    <group>
      {/* Forecourt paving, from the tower's front to the road. */}
      <mesh
        position={[(F.alongFrom + F.alongTo) / 2, HELI_GROUND + 0.03, (F.acrossFrom + F.acrossTo) / 2]}
        material={mats.paving}
        receiveShadow
      >
        <boxGeometry args={[F.alongTo - F.alongFrom, 0.06, F.acrossTo - F.acrossFrom]} />
      </mesh>

      <group position={[T.along, HELI_GROUND, T.across]}>
        {parts.map(({ mat, geometry }) => (
          <mesh key={mat} geometry={geometry} material={mats[mat]} castShadow={CASTS.has(mat)} receiveShadow />
        ))}
      </group>

      {/* Solid: the lobby behind its glass, the floors over it, the columns
          and piers — not one box to the outline, which would be an invisible
          wall under the overhang — the canopy, the roof housing, and the
          helideck, which is what a helicopter's ground ray finds. */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[W / 2 - INSET, L / 2, D / 2 - INSET]} position={[T.along, HELI_GROUND + L / 2, T.across]} />
        <CuboidCollider args={[W / 2 + 0.3, UPPER / 2, D / 2 + 0.3]} position={[T.along, HELI_GROUND + L + UPPER / 2, T.across]} />
        {COLUMNS.map(([x, z], i) => (
          <CuboidCollider key={i} args={[0.3, L / 2, 0.3]} position={[T.along + x, HELI_GROUND + L / 2, T.across + z]} />
        ))}
        {[-1, 1].map((side) => (
          <CuboidCollider
            key={`pier${side}`}
            args={[0.6, L / 2, 1.6]}
            position={[T.along + W / 2 - 0.4, HELI_GROUND + L / 2, T.across + side * (D / 2 - 1.5)]}
          />
        ))}
        <CuboidCollider args={[CANOPY_DEPTH / 2, 0.15, Math.min(24, D - 10) / 2]} position={[T.along + W / 2 + CANOPY_DEPTH / 2, HELI_GROUND + 4.6, T.across]} />
        <CuboidCollider args={[4, 1.8, 1.5]} position={[T.along - 5, HELI_GROUND + R + 1.8, T.across + D / 2 - 1.8]} />
        <CuboidCollider
          args={[DECK_HALF, 0.18, DECK_HALF]}
          position={[T.along + DECK_X, HELI_GROUND + DECK_Y - 0.18, T.across]}
        />
      </RigidBody>
    </group>
  );
}
