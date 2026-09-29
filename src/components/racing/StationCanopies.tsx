'use client';

import { useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, type BufferGeometry, CanvasTexture, CylinderGeometry, ExtrudeGeometry, RepeatWrapping, Shape, SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  PF1_NORTH, STATION, STATION_CANOPY as C, STATION_FOOTBRIDGE as FB, STATION_PLATFORM, stationPlatforms,
} from '@/config/islandRailConfig';
import { TRAIN } from '@/config/trainConfig';

/**
 * What stands on the island station's platforms, in the airport island's
 * frame (`x` along the line, `z` across it), drawn inside `IslandRail`:
 *
 * - **Paving.** The platforms' flat run is paved in 600 mm slabs, a warm
 *   light grey, over the concrete body; the coping stays a pale band at the
 *   edge and the yellow line sits on top of both. The ramps are left as the
 *   body's concrete, which is what a ramp is.
 * - **Canopies** (`STATION_CANOPY`), on all four platforms. Thin
 *   curved shells, grey metal on top and cedar underneath to match the
 *   building's slats: an arch on tapered Y columns with a glazed rooflight
 *   along the crown over each island, a sweep from columns along the back
 *   over the side platform. Slate-blue steel and fascia with a teal line, and
 *   light strips under the purlins.
 * - **Footbridge** (`STATION_FOOTBRIDGE`). A glazed, roofed deck over all four
 *   platforms and tracks, on a column on each platform, with a stair down
 *   onto each one, running east — away from the canopies.
 *
 * Nothing here is taller than it needs to be for a train to pass: the
 * canopies stay inside their platforms' footprints, and the bridge deck is
 * 6.3 m over the rail head.
 */

/*
 * One colour each, a step deeper than it would be picked on paper: in this
 * scene's bright sun a mid slate blue reads as pale grey, and the first set
 * washed out. Slate-blue steel and a deep fascia with a teal line tie to the
 * building's accents; a cedar soffit to its slats; warm sandstone-grey slabs
 * underfoot against the mid-grey platform faces and pale coping; blue-grey
 * glass on the bridge so it reads as glazed.
 */
const PAVING = '#bdb3a0';
const JOINT = '#948b7a';
const STEEL = '#3e5566';
const FASCIA = '#2f4a5e';
const ACCENT = '#14a39a';
const SOFFIT = '#a86a3f';
const ROOF = '#5a6268';
const TREAD = '#7f878c';
const GLASS = '#7fb3c0';
const RAIL = '#c9cdd0';

/** Metres per paving texture repeat: four 600 mm slabs. */
const SLAB_TILE = 2.4;

function pavingTexture(): CanvasTexture {
  const n = 4;
  const size = 512;
  const cell = size / n;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = JOINT;
  g.fillRect(0, 0, size, size);
  let seed = 5;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const base = [1, 3, 5].map((i) => parseInt(PAVING.slice(i, i + 2), 16));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = 0.95 + rnd() * 0.08;
      g.fillStyle = `rgb(${base.map((c) => Math.min(255, Math.round(c * k))).join(',')})`;
      g.fillRect(i * cell + 2, j * cell + 2, cell - 4, cell - 4);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A box whose top-face UVs are world metres over `SLAB_TILE`, so one texture tiles every platform alike. */
function pavedSlab(x0: number, x1: number, z0: number, z1: number, y: number, thick: number): BufferGeometry {
  const g = new BoxGeometry(x1 - x0, thick, z1 - z0).translate((x0 + x1) / 2, y - thick / 2, (z0 + z1) / 2);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / SLAB_TILE, pos.getZ(i) / SLAB_TILE);
  uv.needsUpdate = true;
  return g;
}

/** A thin box from (x0, y0) to (x1, y1) in the x–y plane, `w` wide in z at `z`: a stringer or a handrail. */
function incline(x0: number, y0: number, x1: number, y1: number, z: number, h: number, w: number): BufferGeometry {
  const len = Math.hypot(x1 - x0, y1 - y0);
  return new BoxGeometry(len, h, w).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, z);
}

/**
 * A curved layer of a canopy: the cross-section between `top(z)` and
 * `bottom(z)` from `za` to `zb`, extruded along the canopy's length. The
 * shape is drawn with x = −z because `rotateY(π/2)` takes the extrusion's
 * local z to world x and its local x to world −z.
 */
function shell(za: number, zb: number, top: (z: number) => number, bottom: (z: number) => number): BufferGeometry {
  const n = 16;
  const shape = new Shape();
  for (let i = 0; i <= n; i++) {
    const z = za + ((zb - za) * i) / n;
    if (i === 0) shape.moveTo(-z, top(z)); else shape.lineTo(-z, top(z));
  }
  for (let i = n; i >= 0; i--) {
    const z = za + ((zb - za) * i) / n;
    shape.lineTo(-z, bottom(z));
  }
  return new ExtrudeGeometry(shape, { depth: C.to - C.from, bevelEnabled: false, steps: 1 })
    .rotateY(Math.PI / 2).translate(C.from, 0, 0);
}

interface Plat { label: string; island: boolean; z0: number; z1: number; mid: number; back: number; top: number; x0: number; x1: number }

function platforms(): Plat[] {
  const P = STATION.platform;
  return stationPlatforms().map((p) => {
    const ref = p.line.reduce((m, q) => (Math.abs(q.x - STATION.centre) < Math.abs(m.x - STATION.centre) ? q : m));
    const s = ref.nz * p.dir;
    const near = ref.z + s * p.from;
    const far = ref.z + s * p.to;
    return {
      label: p.label, island: p.island, x0: p.x0, x1: p.x1,
      z0: Math.min(near, far), z1: Math.max(near, far), mid: (near + far) / 2, back: far,
      top: ref.depth + TRAIN.sleeperHeight + TRAIN.railHeight + P.top,
    };
  });
}

function layout() {
  const P = STATION.platform;
  const plats = platforms();
  const paving: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const fascia: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const soffit: BufferGeometry[] = [];
  const roof: BufferGeometry[] = [];
  const lights: BufferGeometry[] = [];
  const treads: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const rails: BufferGeometry[] = [];
  const nosing: BufferGeometry[] = [];
  const colliders: Array<{ centre: [number, number, number]; half: [number, number, number] }> = [];
  const len = C.to - C.from;
  const cx = (C.from + C.to) / 2;
  /** Column x positions: a bay apart, centred on the canopy. */
  const bays = Math.round(len / C.bay);
  const columnXs = Array.from({ length: bays + 1 }, (_, i) => C.from + (len * i) / bays);

  for (const pl of plats) {
    /* ----- paving: the flat run, inside the copings ----- */
    // A side platform's coping is on its track side only; its back runs to the wall.
    const [pz0, pz1] = pl.island ? [pl.z0 + P.coping, pl.z1 - P.coping]
      : pl.back > pl.mid ? [pl.z0 + P.coping, pl.z1 - 0.02] : [pl.z0 + 0.02, pl.z1 - P.coping];
    // To the others' north end; PF1's parcel deck past that is surfaced dark by `IslandRail`.
    const straightTo = STATION.centre + P.length / 2 + STATION.margin;
    const paveTo = pl.x1 > straightTo ? STATION_PLATFORM.to : pl.x1 - P.ramp;
    paving.push(pavedSlab(pl.x0 + P.ramp, paveTo, pz0, pz1, pl.top + 0.012, 0.05));
    // PF1 carries on along its spur: paved again past the dark parcel deck, to its own end slope.
    if (pl.label === 'PF1') paving.push(pavedSlab(PF1_NORTH.deck.to, pl.x1 - P.ramp, pz0, pz1, pl.top + 0.012, 0.05));

    /* ----- the canopy ----- */
    if (!C.platforms.includes(pl.label)) continue;
    const under = pl.top + C.height;
    const r0 = pl.z0 + 0.15;
    const r1 = pl.z1 - 0.15;
    /** Lays a curved layer of the shell `[lo, hi]` over the soffit line, from `za` to `zb`, into `list`. */
    const layer = (list: BufferGeometry[], soffitAt: (z: number) => number, za: number, zb: number, lo: number, hi: number) => {
      list.push(shell(za, zb, (z) => soffitAt(z) + hi, (z) => soffitAt(z) + lo));
    };
    /** Fascia along an edge: a slate band with the teal line. */
    const fasciaAt = (z: number, y: number) => {
      fascia.push(new BoxGeometry(len + 0.2, 0.34, 0.1).translate(cx, y + 0.02, z));
      accent.push(new BoxGeometry(len + 0.2, 0.05, 0.105).translate(cx, y - 0.08, z));
    };
    /** A straight member from (za, ya) to (zb, yb) in the plane `x`. */
    const strut = (x: number, za: number, ya: number, zb: number, yb: number, r: number) => {
      const l = Math.hypot(zb - za, yb - ya);
      steel.push(new CylinderGeometry(r, r, l, 8).rotateX(Math.atan2(zb - za, yb - ya)).translate(x, (ya + yb) / 2, (za + zb) / 2));
    };
    if (pl.island) {
      // An arch over the platform: lowest at the edges, `rise` higher at the crown.
      const h = (r1 - r0) / 2;
      const soffitAt = (z: number) => under + C.rise * (1 - ((z - pl.mid) / h) ** 2);
      const gap = C.rooflight / 2;
      for (const [za, zb] of [[r0, pl.mid - gap], [pl.mid + gap, r1]] as Array<[number, number]>) {
        layer(soffit, soffitAt, za, zb, 0, 0.04);
        layer(roof, soffitAt, za, zb, 0.04, 0.16);
      }
      layer(glass, soffitAt, pl.mid - gap, pl.mid + gap, 0.06, 0.1);
      for (const z of [r0, r1]) fasciaAt(z, under);
      // Purlins where the arms meet the shell, with the light strips under them.
      for (const k of [-1, 1]) {
        const z = pl.mid + k * C.arms;
        steel.push(new BoxGeometry(len, 0.24, 0.2).translate(cx, soffitAt(z) - 0.12, z));
        lights.push(new BoxGeometry(len - 2, 0.04, 0.12).translate(cx, soffitAt(z) - 0.26, z));
      }
      // Tapered columns down the middle, forking into a Y.
      const fork = under - 0.8;
      for (const x of columnXs) {
        steel.push(new CylinderGeometry(0.11, 0.17, fork - pl.top, 14).translate(x, pl.top + (fork - pl.top) / 2, pl.mid));
        for (const k of [-1, 1]) strut(x, pl.mid, fork - 0.05, pl.mid + k * C.arms, soffitAt(pl.mid + k * C.arms) - 0.22, 0.08);
        colliders.push({ centre: [x, pl.top + (fork - pl.top) / 2, pl.mid], half: [0.17, (fork - pl.top) / 2, 0.17] });
      }
    } else {
      // Springs from columns along the back and sweeps down to the track edge.
      const outward = pl.back > pl.mid ? 1 : -1;
      const front = outward > 0 ? r0 : r1;
      const rear = outward > 0 ? r1 : r0;
      const colZ = rear - outward * 0.6;
      const reach = Math.abs(front - colZ);
      const soffitAt = (z: number) => under + C.rise * (1 - Math.min(1, ((z - colZ) / reach) ** 2));
      const [za, zb] = front < rear ? [front, rear] : [rear, front];
      layer(soffit, soffitAt, za, zb, 0, 0.04);
      layer(roof, soffitAt, za, zb, 0.04, 0.16);
      fasciaAt(front, under);
      fascia.push(new BoxGeometry(len + 0.2, 0.3, 0.1).translate(cx, soffitAt(rear) + 0.05, rear));
      const head = colZ + (front - colZ) * 0.6;
      steel.push(new BoxGeometry(len, 0.26, 0.22).translate(cx, soffitAt(colZ) - 0.13, colZ));
      steel.push(new BoxGeometry(len, 0.22, 0.18).translate(cx, soffitAt(head) - 0.11, head));
      lights.push(new BoxGeometry(len - 2, 0.04, 0.12).translate(cx, soffitAt(head) - 0.24, head));
      for (const x of columnXs) {
        const topY = soffitAt(colZ) - 0.26;
        steel.push(new CylinderGeometry(0.11, 0.16, topY - pl.top, 14).translate(x, pl.top + (topY - pl.top) / 2, colZ));
        strut(x, colZ, topY - 1.1, head, soffitAt(head) - 0.22, 0.07);
        colliders.push({ centre: [x, pl.top + (topY - pl.top) / 2, colZ], half: [0.16, (topY - pl.top) / 2, 0.16] });
      }
    }
  }

  /* ----- the footbridge ----- */
  const railHead = plats[0].top - P.top;
  const floor = railHead + FB.deck;
  const z0 = Math.min(...plats.map((p) => p.mid)) - FB.stair.width / 2 - 0.6;
  const z1 = Math.max(...plats.map((p) => p.mid)) + FB.stair.width / 2 + 0.6;
  const bx = FB.x;
  const half = FB.width / 2;
  const span = z1 - z0;
  const bz = (z0 + z1) / 2;
  const wall = 2.5;
  treads.push(new BoxGeometry(FB.width, 0.1, span).translate(bx, floor - 0.05, bz));
  steel.push(new BoxGeometry(FB.width + 0.3, 0.7, span).translate(bx, floor - 0.45, bz));
  for (const k of [-1, 1]) {
    accent.push(new BoxGeometry(0.02, 0.06, span).translate(bx + k * (half + 0.16), floor - 0.3, bz));
    glass.push(new BoxGeometry(0.03, wall, span).translate(bx + k * half, floor + wall / 2, bz));
    steel.push(new BoxGeometry(0.12, 0.14, span).translate(bx + k * half, floor + wall, bz));
    rails.push(new BoxGeometry(0.06, 0.06, span).translate(bx + k * (half - 0.1), floor + 1.0, bz));
    for (let z = z0; z <= z1 + 0.01; z += span / Math.round(span / 3)) {
      steel.push(new BoxGeometry(0.12, wall, 0.12).translate(bx + k * half, floor + wall / 2, z));
    }
  }
  roof.push(new BoxGeometry(FB.width + 0.6, 0.14, span + 0.6).translate(bx, floor + wall + 0.12, bz));
  fascia.push(new BoxGeometry(FB.width + 0.64, 0.28, span + 0.64).translate(bx, floor + wall + 0.02, bz));
  // End walls, glazed.
  for (const z of [z0, z1]) glass.push(new BoxGeometry(FB.width, wall, 0.03).translate(bx, floor + wall / 2, z));
  colliders.push({ centre: [bx, floor + wall / 2 - 0.4, bz], half: [half + 0.15, wall / 2 + 0.4, span / 2] });

  const S = FB.stair;
  for (const pl of plats) {
    // The column under the deck, then the stair: from the deck's east edge down onto the platform.
    const colH = floor - 0.8 - pl.top;
    steel.push(new BoxGeometry(0.45, colH, 0.45).translate(bx, pl.top + colH / 2, pl.mid));
    colliders.push({ centre: [bx, pl.top + colH / 2, pl.mid], half: [0.23, colH / 2, 0.23] });
    const total = floor - pl.top;
    const risers = Math.round(total / S.rise);
    const rise = total / risers;
    const firstFlight = Math.floor(risers / 2);
    let x = bx + half;
    let y = floor;
    const zA = pl.mid - S.width / 2;
    const zB = pl.mid + S.width / 2;
    const profile: Array<[number, number]> = [[x, y]];
    for (let i = 0; i < risers; i++) {
      if (i === firstFlight) {
        // The landing.
        treads.push(new BoxGeometry(S.landing, 0.25, S.width).translate(x + S.landing / 2, y - 0.125, pl.mid));
        x += S.landing;
        profile.push([x, y]);
      }
      y -= rise;
      // Each step a solid block from the platform up — a closed stair, which is what a platform stair is.
      const h = y - pl.top;
      if (h > 0.001) {
        treads.push(new BoxGeometry(S.going, Math.min(h, 0.3), S.width).translate(x + S.going / 2, y - Math.min(h, 0.3) / 2, pl.mid));
        nosing.push(new BoxGeometry(0.05, 0.012, S.width).translate(x + S.going - 0.03, y + 0.006, pl.mid));
      }
      x += S.going;
      profile.push([x, y]);
    }
    // Stringers — slate-blue side panels — glass balustrades and handrails, flight by flight.
    for (let i = 1; i < profile.length; i++) {
      const [xa, ya] = profile[i - 1];
      const [xb, yb] = profile[i];
      for (const z of [zA - 0.08, zB + 0.08]) {
        steel.push(incline(xa, ya - 0.25, xb, yb - 0.25, z, 0.55, 0.14));
        glass.push(incline(xa, ya + 0.55, xb, yb + 0.55, z, 1.0, 0.025));
        rails.push(incline(xa, ya + 1.05, xb, yb + 1.05, z, 0.05, 0.06));
      }
    }
    const run = x - (bx + half);
    colliders.push({
      centre: [bx + half + run / 2, pl.top + total / 4, pl.mid],
      half: [run / 2, total / 4, S.width / 2 + 0.15],
    });
  }

  const merge = (list: BufferGeometry[]) => (
    list.length ? mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null
  );
  return {
    paving: merge(paving), steel: merge(steel), fascia: merge(fascia), accent: merge(accent), soffit: merge(soffit),
    roof: merge(roof), lights: merge(lights), treads: merge(treads), glass: merge(glass), rails: merge(rails),
    nosing: merge(nosing), colliders,
  };
}

export default function StationCanopies() {
  const built = useMemo(() => layout(), []);
  const slabs = useMemo(() => pavingTexture(), []);
  return (
    <group>
      {built.paving && (
        <mesh geometry={built.paving} receiveShadow>
          <meshStandardMaterial map={slabs} roughness={0.88} />
        </mesh>
      )}
      {built.steel && (
        <mesh geometry={built.steel} castShadow receiveShadow>
          <meshStandardMaterial color={STEEL} roughness={0.45} metalness={0.45} />
        </mesh>
      )}
      {built.fascia && (
        <mesh geometry={built.fascia} castShadow>
          <meshStandardMaterial color={FASCIA} roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      {built.accent && (
        <mesh geometry={built.accent}>
          <meshStandardMaterial color={ACCENT} roughness={0.5} />
        </mesh>
      )}
      {built.soffit && (
        <mesh geometry={built.soffit} receiveShadow>
          <meshStandardMaterial color={SOFFIT} roughness={0.7} />
        </mesh>
      )}
      {built.roof && (
        <mesh geometry={built.roof} castShadow receiveShadow>
          <meshStandardMaterial color={ROOF} roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {built.lights && (
        <mesh geometry={built.lights}>
          <meshStandardMaterial color="#fff6e2" emissive="#ffeccc" emissiveIntensity={0.8} />
        </mesh>
      )}
      {built.treads && (
        <mesh geometry={built.treads} castShadow receiveShadow>
          <meshStandardMaterial color={TREAD} roughness={0.85} />
        </mesh>
      )}
      {built.nosing && (
        <mesh geometry={built.nosing}>
          <meshStandardMaterial color="#e6c227" roughness={0.6} />
        </mesh>
      )}
      {built.glass && (
        <mesh geometry={built.glass}>
          <meshStandardMaterial color={GLASS} roughness={0.05} metalness={0.2} transparent opacity={0.45} depthWrite={false} />
        </mesh>
      )}
      {built.rails && (
        <mesh geometry={built.rails}>
          <meshStandardMaterial color={RAIL} roughness={0.3} metalness={0.8} />
        </mesh>
      )}
      <RigidBody type="fixed" colliders={false}>
        {built.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.centre} />
        ))}
      </RigidBody>
    </group>
  );
}
