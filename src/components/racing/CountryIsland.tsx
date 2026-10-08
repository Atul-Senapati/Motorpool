'use client';

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Color, DoubleSide, Float32BufferAttribute, Vector2,
  Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, type Material, type Object3D,
  type Texture,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_PAVEMENT, ROAD_REPEAT, ROAD_TOP, pieceBase } from '@/config/roadConfig';
import { TRAIN } from '@/config/trainConfig';
import {
  BEACH, CROSSINGS, HARBOUR, JUNCTIONS, LAKE, LAKE_OUTLINE, LAKE_Y, LANES, LANE_WIDTH, MINI_ROADS,
  OUTLINE, PIER, PONDS, SHAPE, SITE, STREAM, coastRadius, describeCountry, groundAt, makeRandom,
  pondLevel, reliefAt, roadByName, roadLevelAt, cutRoadSamples, inRailCut, armDirection, armMouth, type Arm, type Road,
} from '@/config/countryConfig';
import { describeFields } from '@/config/countryFields';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import { paintCountry, paintUV } from './countryPainter';
import { CountryPlanting } from './CountryPlanting';
import { CountryBuildings } from './CountryBuildings';
import { CountryLife } from './CountryLife';
import { CountryWater } from './CountryWater';
import { CountryVehicles } from './CountryVehicles';
import { CountryMine } from './CountryMine';

/**
 * Skylark — see `countryConfig` for what it is and why.
 *
 * This file is the ground: the crown, the cliffs, the lanes, the water, and
 * the colliders for all of it. What stands on the ground is three more files
 * — `CountryPlanting` (hedges, walls, trees, gates, bales, poles),
 * `CountryBuildings` (the farms, the hamlet, the church, the mill, the
 * turbines, the lighthouse) and `CountryLife` (the animals) — all mounted
 * inside this one group so every number they use is the island's own.
 *
 * ## The crown is a polar grid
 *
 * Every other island's crown is a fan: one vertex at the centre, one at each
 * outline point, flat. A fan cannot carry a hill. This crown is `RINGS` rings
 * of `SHAPE.steps` vertices, every vertex at `groundAt`, and its outer ring
 * IS `OUTLINE` — the same points, so the cliff extruded from the outline and
 * the crown meeting it share an edge exactly. About 45,000 vertices and
 * 90,000 triangles, which is one draw call and one trimesh, and less than a
 * single city block.
 *
 * Vertex colours multiply the painted map: the map carries what grows where,
 * the colours carry the light — the chalk tops paler and yellower, the slopes
 * a shade darker where they face away — so the relief reads even where the
 * crop is one colour.
 *
 * ## The cliffs
 *
 * The same vertical face to the seabed the other islands have, coloured as
 * rock rather than rendered as concrete: an earth band under the turf, grey
 * strata down the face, a dark wet band at the tideline. Its top ring is the
 * crown's rim, so where a hill runs into the sea the cliff is as high as the
 * hill.
 *
 * ## The lanes are lofts
 *
 * `buildLoft` along each lane's samples at `ROAD_TOP` over its profile,
 * wearing the road kit's carriageway texture the way Kestrel's crescent and
 * both bridge decks do. Each is also a collider, so a wheel rides the lane's
 * own surface rather than the ground carved under it. The junctions are the
 * kit's own T and X, cloned onto their pads, with a box collider each at the
 * same height so the road is one level surface through them.
 */

const ROAD_MODEL = '/models/roads.glb';
useGLTF.preload(ROAD_MODEL, DRACO_PATH);

const TAU = Math.PI * 2;
/** Rings of the crown, centre to rim. */
const RINGS = 150;

/* ---------------------------------------------------------- the crown */

function buildCrown() {
  const A = SHAPE.steps;
  const count = 1 + RINGS * A;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const put = (v: number, x: number, y: number, z: number) => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    const [u, w] = paintUV(x, z);
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = w;
  };
  put(0, 0, groundAt(0, 0), 0);
  const at = (i: number, j: number) => 1 + (i - 1) * A + (j % A);
  for (let i = 1; i <= RINGS; i++) {
    // A little more of the rings near the rim, where the coast and the
    // fields want the detail, and fewer round the centre, where a ring is a
    // few metres round anyway.
    const t = (i / RINGS) ** 0.85;
    for (let j = 0; j < A; j++) {
      const theta = -(j / A) * TAU;
      const r = coastRadius(theta) * t;
      const x = r * Math.cos(theta);
      const z = r * Math.sin(theta);
      put(at(i, j), x, groundAt(x, z), z);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < A; j++) indices.push(0, at(1, j), at(1, j + 1));
  for (let i = 1; i < RINGS; i++) {
    for (let j = 0; j < A; j++) {
      const a = at(i, j);
      const b = at(i, j + 1);
      const c = at(i + 1, j + 1);
      const d = at(i + 1, j);
      indices.push(a, d, c, a, c, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // The light: chalk on the tops, shade on the slopes, and a little grain.
  const normals = geometry.getAttribute('normal');
  const colors = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const up = normals.getY(v);
    const chalk = Math.min(1, Math.max(0, (y - 18) / 26));
    const grain = ((Math.sin(x * 0.37 + z * 0.61) + Math.sin(x * 0.11 - z * 0.23)) * 0.02);
    const shade = 1 + 0.12 * chalk - 0.28 * (1 - up) + grain;
    colors[v * 3] = shade * (1 + 0.05 * chalk);
    colors[v * 3 + 1] = shade;
    colors[v * 3 + 2] = shade * (1 - 0.1 * chalk);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const rim = new Float32Array(A);
  for (let j = 0; j < A; j++) rim[j] = positions[at(RINGS, j) * 3 + 1];
  return { geometry, vertices: positions, indices: new Uint32Array(indices), rim };
}

/* ---------------------------------------------------------- the cliffs */

function buildCliff(rim: Float32Array) {
  const n = OUTLINE.length;
  const turf = new Color('#5c4a35');
  const earth = new Color('#6b5540');
  const rockA = new Color('#7d776c');
  const rockB = new Color('#66615a');
  const wet = new Color('#45484a');
  const deep = new Color('#33373a');
  const tide = TRAIN.seaLevel + 0.4;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const RING = 5;
  const setts = new Color('#857f75');
  const settsWet = new Color('#5e5c57');
  const sand = new Color('#c9b993');
  const harbourTheta = Math.atan2(HARBOUR.out[1], HARBOUR.out[0]);
  for (let j = 0; j < n; j++) {
    const [x, z] = OUTLINE[j];
    const top = rim[j];
    const mid = (top - 0.8 + tide) / 2;
    const grain = 0.5 + 0.5 * Math.sin(j * 0.73) * Math.sin(j * 0.31 + x * 0.01);
    const rock = rockA.clone().lerp(rockB, grain);
    const theta = Math.atan2(z, x);
    const off = (a: number) => Math.abs(Math.atan2(Math.sin(theta - a), Math.cos(theta - a)));
    // The quay's face is a built wall, and the strand's is sand: the same
    // extrusion, coloured for what it is.
    const quay = off(harbourTheta) < 0.11;
    const strand = off(BEACH.theta) < BEACH.halfAngle + 0.05;
    const levels: Array<[number, Color]> = quay
      ? [[top, setts], [top - 0.8, setts], [mid, setts], [tide, settsWet], [TRAIN.seabed, deep]]
      : strand
        ? [[top, sand], [top - 0.8, sand], [mid, sand], [tide, sand], [TRAIN.seabed, deep]]
        : [[top, turf], [top - 0.8, earth], [mid, rock], [tide, wet], [TRAIN.seabed, deep]];
    for (const [y, c] of levels) {
      positions.push(x, y, z);
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < n; j++) {
    const a = j * RING;
    const b = ((j + 1) % n) * RING;
    for (let k = 0; k < RING - 1; k++) {
      // Outward, the way the airport's wall winds its face.
      indices.push(a + k, a + k + 1, b + k + 1, a + k, b + k + 1, b + k);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------------------------------------------------- the lanes */

/**
 * A road's surface stops at a level crossing's panels and starts again past
 * them — cut exactly at the panels' edges, on samples `cutRoadSamples` adds
 * there — and `CountryRail` fills the gap with the crossing's own surface and
 * lets the rails through it.
 */
const offCrossing = (road: Road) => (a: LoftSample, b: LoftSample) => !inRailCut(road.name, (a.arc + b.arc) / 2);

/** Every junction arm's mouth and direction, for squaring lane ends to the tiles. */
const ARM_MOUTHS = Object.values(JUNCTIONS).flatMap((j) => (['px', 'nx', 'pz', 'nz'] as Arm[])
  .map((arm) => ({ mouth: armMouth(j, arm), dir: armDirection(j, arm) })));
/** How many sections at a lane's end turn to meet a tile square: ~9 m of road. */
const SQUARE_SECTIONS = 4;

/**
 * Turn a lane's last few cross-sections square to the junction arm it runs
 * into, so the loft's end lies exactly along the tile's edge.
 *
 * The lane's centreline arrives at the arm's mouth but still bending — up to
 * 16° off the arm — and a section is cut square to the LANE, so its end met
 * the tile's square edge in a wedge: grass showing on one side, the lane's
 * tarmac and markings lapping over the tile's footway corner on the other.
 * Only the sections turn, blended in over `SQUARE_SECTIONS`; the centreline,
 * which everything else on the island is placed against, does not move.
 * Kestrel's swept roads had the same fault and the same fix.
 */
function squareToJunctions(samples: LoftSample[]) {
  const n = samples.length;
  for (const [end, step] of [[0, 1], [n - 1, -1]] as const) {
    const p = samples[end];
    const arm = ARM_MOUTHS.find(({ mouth }) => Math.hypot(mouth[0] - p.x, mouth[1] - p.z) < 1);
    if (!arm) continue;
    // The tile edge's direction, signed to agree with the lane's own normal.
    let tx = -arm.dir[1];
    let tz = arm.dir[0];
    if (tx * p.nx + tz * p.nz < 0) { tx = -tx; tz = -tz; }
    for (let k = 0; k < SQUARE_SECTIONS && k < n; k++) {
      const q = samples[end + step * k];
      const w = 1 - k / SQUARE_SECTIONS;
      const mx = q.nx + (tx - q.nx) * w;
      const mz = q.nz + (tz - q.nz) * w;
      const len = Math.hypot(mx, mz) || 1;
      q.nx = mx / len;
      q.nz = mz / len;
    }
  }
}

function buildLanes() {
  return LANES.map((road) => {
    const samples: LoftSample[] = cutRoadSamples(road).map((s) => ({
      x: s.x, z: s.z, y: s.y + ROAD_TOP, nx: s.nx, nz: s.nz, arc: s.arc,
    }));
    squareToJunctions(samples);
    // Right edge first — see `KestrelRoads` for why the order decides which
    // way a flat section faces.
    const profile: ProfileVertex[] = [
      { off: LANE_WIDTH / 2, rise: 0 },
      { off: -LANE_WIDTH / 2, rise: 0 },
    ];
    const loft = buildLoft(samples, profile, { vScale: 8, filter: offCrossing(road) });
    // Cropped to the CARRIAGEWAY. The kit's texture runs pavement, edge line,
    // two lanes, median, two lanes, edge line, pavement — so a lane mapped
    // across its whole width carries a drawn footway down each side, which
    // a country lane between two fields does not have. Sampling
    // `ROAD_PAVEMENT .. 1 − ROAD_PAVEMENT` puts the four lanes across the
    // full width and leaves the footways off, which is exactly what the two
    // bridges have always done with the same texture.
    const uv = loft.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      const t = Math.min(1, Math.max(0, uv.getX(i)));
      uv.setXY(i, (uv.getY(i) * 8) / ROAD_REPEAT, ROAD_PAVEMENT + t * (1 - 2 * ROAD_PAVEMENT));
    }
    uv.needsUpdate = true;
    loft.geometry.computeBoundingSphere();
    return { name: road.name, loft };
  });
}

/* --------------------------------------------------- the single-tracks */

/**
 * A single-track road's surface, painted rather than photographed: the kit
 * has no piece this narrow. Tarmac is a dark grey with a worn paler strip
 * down the middle and grass creeping in at the edges; gravel is pale with
 * two darker ruts where the wheels go. 256 texels over four metres, tiled
 * along the road.
 */
/**
 * The single-tracks' surfaces, generated as a HEIGHT FIELD first and colour,
 * normal and roughness maps derived from it, so the lane is lit like a
 * surface and not painted like one: aggregate catches the light, cracks and
 * potholes sit in shadow, the gravel edge is rough where the asphalt is
 * smoother. Value noise at four scales, not random dots. Tarmac is an aged
 * country lane — a mid grey that leans warm, with lighter worn wheel paths,
 * a mossy crown, patched repairs and a ragged edge of gravel and grass;
 * gravel is a stony farm track with two ruts and a grassy centre. The tile
 * is eight metres along the lane.
 */
interface LaneSurface { map: CanvasTexture; normalMap: CanvasTexture; roughnessMap: CanvasTexture }

function laneSurface(surface: 'tarmac' | 'gravel'): LaneSurface {
  const size = 512;
  const rnd = makeRandom(surface === 'tarmac' ? 5 : 6);
  // Periodic value noise on a lattice, so the tile wraps along the lane.
  const lattice = (cells: number) => {
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = rnd();
    return (x: number, y: number) => {
      const gx = ((x * cells) % cells + cells) % cells;
      const gy = ((y * cells) % cells + cells) % cells;
      const x0 = Math.floor(gx); const y0 = Math.floor(gy);
      const fx = gx - x0; const fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
      const at = (i: number, j: number) => v[((j % cells) * cells) + (i % cells)];
      const a = at(x0, y0); const b = at(x0 + 1, y0); const c = at(x0, y0 + 1); const d = at(x0 + 1, y0 + 1);
      return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    };
  };
  const n1 = lattice(6); const n2 = lattice(18); const n3 = lattice(64); const n4 = lattice(180);
  const tarmac = surface === 'tarmac';
  // Potholes and patches: a few discs, cut in or laid over.
  const holes = Array.from({ length: tarmac ? 5 : 8 }, () => ({ x: rnd(), y: rnd(), r: 0.015 + rnd() * 0.03, d: rnd() < 0.5 ? -1 : 1 }));

  const height = new Float32Array(size * size);
  const colour = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / size; const v = py / size;
      const i = py * size + px;
      const across = Math.abs(u - 0.5) * 2; // 0 crown, 1 edge
      const big = n1(u, v); const mid = n2(u, v); const fine = n3(u, v); const grain = n4(u, v);
      // The edge: where asphalt gives way to gravel, ragged along the lane.
      const edgeAt = tarmac ? 0.78 + (mid - 0.5) * 0.16 : 0.9 + (mid - 0.5) * 0.1;
      const onEdge = Math.max(0, Math.min(1, (across - edgeAt) / 0.12));
      let h = 0.5 + (fine - 0.5) * 0.35 + (grain - 0.5) * (tarmac ? 0.25 : 0.55) + (big - 0.5) * 0.15;
      let r = 0; let g = 0; let b = 0;
      if (tarmac) {
        // Asphalt: mid grey leaning warm, darker in the fresh patches and
        // the wet-looking hollows, lighter where the wheels polish it.
        const wheel = Math.exp(-((across - 0.5) ** 2) / 0.02);
        const tone = 108 + (big - 0.5) * 34 + (mid - 0.5) * 18 + (fine - 0.5) * 28 + wheel * 16 - (1 - wheel) * (across < 0.25 ? 6 : 0);
        r = tone + 4; g = tone + 2; b = tone - 4;
        // The crown: a faint mossy green where wheels never run.
        const moss = Math.max(0, 1 - across / 0.14) * Math.max(0, mid - 0.45) * 1.6;
        r -= moss * 26; g += moss * 6; b -= moss * 30;
        h += wheel * 0.02;
      } else {
        // Stone and earth: tan, two ruts, a grass centre.
        const rut = Math.exp(-((across - 0.5) ** 2) / 0.012);
        const tone = 150 + (big - 0.5) * 30 + (fine - 0.5) * 40 + (grain - 0.5) * 30;
        r = tone + 10; g = tone - 6; b = tone - 40;
        r -= rut * 22; g -= rut * 18; b -= rut * 14; h -= rut * 0.12;
        const centre = Math.max(0, 1 - across / 0.22) * (0.5 + big * 0.5);
        r -= centre * 55; g -= centre * 10; b -= centre * 60;
      }
      for (const hole of holes) {
        const dx = (u - hole.x); const dy = (v - hole.y) * 1.0;
        const d = Math.hypot(dx, dy);
        if (d < hole.r) {
          const k = 1 - d / hole.r;
          if (hole.d < 0) { h -= k * 0.35; r -= k * 40; g -= k * 40; b -= k * 36; } else { h += 0.06; r -= 14; g -= 14; b -= 12; }
        }
      }
      // Gravel and grass at the edge.
      if (onEdge > 0) {
        const gravelTone = 140 + (grain - 0.5) * 70 + (fine - 0.5) * 30;
        const gr = gravelTone + 14; const gg = gravelTone; const gb = gravelTone - 30;
        const grass = Math.max(0, Math.min(1, (across - edgeAt - 0.07) / 0.06)) * (0.4 + mid * 0.6);
        const er = gr * (1 - grass) + 92 * grass; const eg = gg * (1 - grass) + 122 * grass; const eb = gb * (1 - grass) + 58 * grass;
        r = r * (1 - onEdge) + er * onEdge; g = g * (1 - onEdge) + eg * onEdge; b = b * (1 - onEdge) + eb * onEdge;
        h = h * (1 - onEdge) + (0.45 + (grain - 0.5) * 0.7) * onEdge;
      }
      height[i] = h;
      colour[i * 4] = r; colour[i * 4 + 1] = g; colour[i * 4 + 2] = b; colour[i * 4 + 3] = 255;
      const rough0 = tarmac ? 0.82 + (0.5 - fine) * 0.2 + onEdge * 0.15 : 0.97;
      const rv = Math.round(Math.max(0.5, Math.min(1, rough0)) * 255);
      rough[i * 4] = rv; rough[i * 4 + 1] = rv; rough[i * 4 + 2] = rv; rough[i * 4 + 3] = 255;
    }
  }
  // The normal map from the height field, wrapping along the lane.
  const normal = new Uint8ClampedArray(size * size * 4);
  const strength = tarmac ? 2.2 : 3.2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const hl = height[py * size + Math.max(0, px - 1)];
      const hr = height[py * size + Math.min(size - 1, px + 1)];
      const hu = height[((py - 1 + size) % size) * size + px];
      const hd = height[((py + 1) % size) * size + px];
      let nx = (hl - hr) * strength; let ny = (hu - hd) * strength; let nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      normal[i * 4] = (nx * 0.5 + 0.5) * 255; normal[i * 4 + 1] = (ny * 0.5 + 0.5) * 255; normal[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; normal[i * 4 + 3] = 255;
    }
  }
  const toTexture = (data: Uint8ClampedArray, srgb: boolean) => {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    image.data.set(data);
    ctx.putImageData(image, 0, 0);
    const tex = new CanvasTexture(canvas);
    if (srgb) tex.colorSpace = SRGBColorSpace;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = RepeatWrapping;
    return tex;
  };
  return { map: toTexture(colour, true), normalMap: toTexture(normal, false), roughnessMap: toTexture(rough, false) };
}

/**
 * A tint per vertex along a lane — long slow changes of tone from a noise of
 * the world position — so the eight-metre tile never reads as a tile, and
 * the lane is a shade darker toward its edges where it stays damp.
 */
function tintLane(geometry: BufferGeometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); const z = pos.getZ(i);
    const slow = 0.5 + 0.5 * Math.sin(x * 0.031 + z * 0.017) * Math.cos(z * 0.023 - x * 0.011);
    const edge = Math.abs(uv.getX(i) - 0.5) * 2;
    const t = (0.88 + slow * 0.22) * (1 - Math.max(0, edge - 0.7) * 0.25);
    out[i * 3] = t; out[i * 3 + 1] = t; out[i * 3 + 2] = t;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(out, 3));
}

/** Every single-track, swept at its own width with u across and v every four metres. */
function buildMiniRoads() {
  return MINI_ROADS.map((road) => {
    const samples: LoftSample[] = cutRoadSamples(road).map((sm) => ({
      x: sm.x, z: sm.z, y: sm.y + ROAD_TOP, nx: sm.nx, nz: sm.nz, arc: sm.arc,
    }));
    const profile: ProfileVertex[] = [
      { off: road.width / 2, rise: 0 },
      { off: -road.width / 2, rise: 0 },
    ];
    const loft = buildLoft(samples, profile, { vScale: 8, filter: offCrossing(road) });
    // The loft's U is metres across the section; the surface wants 0..1
    // across the lane, edge to edge.
    const uv = loft.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, Math.min(1, Math.max(0, uv.getX(i) / road.width)), uv.getY(i));
    uv.needsUpdate = true;
    tintLane(loft.geometry);
    loft.geometry.computeBoundingSphere();
    return { name: road.name, surface: road.surface === 'gravel' ? 'gravel' as const : 'tarmac' as const, loft };
  });
}

/* ------------------------------------------------------------ the brook */

/**
 * The water in the channel, a ribbon swept along the bed a little below the
 * bank, and the ford's pool laid over the road where the coombe lane goes
 * through it.
 */
function buildBrook() {
  const samples: LoftSample[] = STREAM.map((sm) => ({
    x: sm.x, z: sm.z, y: sm.bed - 0.22, nx: sm.nx, nz: sm.nz, arc: sm.arc,
  }));
  // The water widens with the channel toward the mouth.
  const total = STREAM[STREAM.length - 1].arc || 1;
  const width = (s: LoftSample) => 1.8 * (1 + 1.6 * Math.max(0, Math.min(1, (s.arc / total - 0.62) / 0.38)) ** 2 * (3 - 2 * Math.max(0, Math.min(1, (s.arc / total - 0.62) / 0.38))));
  const profile: ProfileVertex[] = [{ off: (s) => width(s), rise: 0 }, { off: (s) => -width(s), rise: 0 }];
  const water = buildLoft(samples, profile, { vScale: 6 });
  water.geometry.computeBoundingSphere();
  const fords = CROSSINGS.filter((c) => c.kind === 'ford').map((c) => {
    const road = roadByName(c.road);
    return { x: c.x, z: c.z, y: c.y + ROAD_TOP + 0.03, turn: Math.atan2(c.tx, c.tz), width: road.width + 1.2 };
  });
  return { water, fords };
}

/* ------------------------------------------------------------- the pier */

/**
 * The breakwater: a stone box swept along its line from the quay's height
 * down to the seabed, with a parapet along its seaward side. Outside the
 * outline, so it is its own geometry and its own collider — the one piece of
 * the island a car can drive onto that the crown does not carry.
 */
function buildPier() {
  const fine: Array<[number, number]> = [];
  const pts = PIER.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, bz - az) / 3));
    for (let k = 0; k < n; k++) fine.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  fine.push(pts[pts.length - 1]);
  const samples: LoftSample[] = [];
  let arc = 0;
  for (let i = 0; i < fine.length; i++) {
    const a = fine[Math.max(0, i - 1)];
    const b = fine[Math.min(fine.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    if (i > 0) arc += Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]);
    samples.push({ x: fine[i][0], z: fine[i][1], y: PIER.top, nx: -dz / len, nz: dx / len, arc });
  }
  const w = PIER.width / 2;
  const depth = TRAIN.seabed - PIER.top;
  const body: ProfileVertex[] = [
    { off: -w, rise: 0 }, { off: w, rise: 0 }, { off: w, rise: depth }, { off: -w, rise: depth },
  ];
  // The parapet stands on the side away from the harbour: the left of the
  // sweep, which runs out from the headland with the cove on its right.
  const parapet: ProfileVertex[] = [
    { off: -w, rise: 0 }, { off: -w + 0.6, rise: 0 }, { off: -w + 0.6, rise: 0.95 }, { off: -w, rise: 0.95 },
  ];
  const stone = buildLoft(samples, body, { closed: true, vScale: 6 });
  const wall = buildLoft(samples, parapet, { closed: true, vScale: 6 });
  stone.geometry.computeBoundingSphere();
  wall.geometry.computeBoundingSphere();
  const end = samples[samples.length - 1];
  return { stone, wall, end: { x: end.x, z: end.z } };
}

/* ---------------------------------------------------------- the water */

function buildWater() {
  const lake = new BufferGeometry();
  const pts: number[] = [LAKE.x, LAKE_Y, LAKE.z];
  const idx: number[] = [];
  const n = LAKE_OUTLINE.length;
  for (const [x, z] of LAKE_OUTLINE) pts.push(x, LAKE_Y, z);
  for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
  lake.setAttribute('position', new Float32BufferAttribute(pts, 3));
  lake.setIndex(idx);
  lake.computeVertexNormals();
  lake.computeBoundingSphere();
  return { lake };
}

/** The kit's carriageway material, wrapped for a sweep. See `KestrelRoads`. */
function useLaneSurface(scene: Object3D): Material | undefined {
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  return useMemo(() => {
    let found: Material | undefined;
    scene.getObjectByName('straight2')?.traverse((child) => {
      if (!found && child instanceof Mesh) found = child.material as Material;
    });
    if (!found) return undefined;
    const clone = found.clone() as Material & { map?: Texture | null };
    const map = (found as Material & { map?: Texture | null }).map;
    if (map) {
      const tex = map.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.anisotropy = maxAnisotropy;
      tex.needsUpdate = true;
      clone.map = tex;
    }
    return clone;
  }, [scene, maxAnisotropy]);
}

/** One kit junction, cloned onto its pad. */
function JunctionTile({ scene, piece, x, z, turn }: {
  scene: Object3D; piece: string; x: number; z: number; turn: number;
}) {
  const object = useMemo(() => {
    const source = scene.getObjectByName(piece);
    if (!source) return null;
    const copy = source.clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.receiveShadow = true; child.castShadow = false; }
    });
    return copy;
  }, [scene, piece]);
  if (!object) return null;
  return (
    // `pieceBase`, as Kestrel's and the airfield's tiles: a kit junction is a
    // flat slab whose carriageway is a kerb's height up, so laid at `ROAD_TOP`
    // like the lanes it stood 10 cm proud of every lane running into it.
    <primitive object={object} position={[x, (roadLevelAt(x, z) ?? groundAt(x, z)) + pieceBase(piece), z]} rotation={[0, turn, 0]} />
  );
}

export function CountryIsland() {
  const { scene } = useGLTF(ROAD_MODEL, DRACO_PATH);
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  const surface = useLaneSurface(scene);

  const crown = useMemo(() => buildCrown(), []);
  const cliff = useMemo(() => buildCliff(crown.rim), [crown]);
  const lanes = useMemo(() => buildLanes(), []);
  const minis = useMemo(() => buildMiniRoads(), []);
  const brook = useMemo(() => buildBrook(), []);
  const pier = useMemo(() => buildPier(), []);
  const water = useMemo(() => buildWater(), []);
  const surfaces = useMemo(() => {
    const make = (surface: 'tarmac' | 'gravel') => {
      const { map, normalMap, roughnessMap } = laneSurface(surface);
      for (const t of [map, normalMap, roughnessMap]) t.anisotropy = maxAnisotropy;
      return new MeshStandardMaterial({
        map, normalMap, roughnessMap, vertexColors: true, roughness: 1,
        normalScale: new Vector2(surface === 'gravel' ? 0.7 : 0.45, surface === 'gravel' ? 0.7 : 0.45),
      });
    };
    return { tarmac: make('tarmac'), gravel: make('gravel') };
  }, [maxAnisotropy]);
  const waterMaterial = useMemo(() => new MeshStandardMaterial({
    color: '#3a6470', roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.86, side: DoubleSide,
  }), []);
  const stoneMaterial = useMemo(() => new MeshStandardMaterial({ color: '#8d877b', roughness: 0.95 }), []);
  const map = useMemo(() => {
    const texture = paintCountry();
    texture.anisotropy = maxAnisotropy;
    return texture;
  }, [maxAnisotropy]);

  useEffect(() => {
    console.info(`[country] ${describeCountry()}; ${describeFields()}; `
      + `crown ${(crown.indices.length / 3).toLocaleString()} triangles`);
    return () => {
      crown.geometry.dispose();
      cliff.dispose();
      for (const lane of lanes) lane.loft.geometry.dispose();
      for (const mini of minis) mini.loft.geometry.dispose();
      brook.water.geometry.dispose();
      pier.stone.geometry.dispose();
      pier.wall.geometry.dispose();
      water.lake.dispose();
      map.dispose();
      for (const m of Object.values(surfaces)) { m.map?.dispose(); m.normalMap?.dispose(); m.roughnessMap?.dispose(); m.dispose(); }
      waterMaterial.dispose();
      stoneMaterial.dispose();
    };
  }, [crown, cliff, lanes, minis, brook, pier, water, map, surfaces, waterMaterial, stoneMaterial]);

  return (
    <group position={[SITE.centre[0], 0, SITE.centre[1]]}>
      <mesh geometry={crown.geometry} receiveShadow castShadow>
        <meshStandardMaterial map={map} vertexColors roughness={0.97} />
      </mesh>
      <mesh geometry={cliff} receiveShadow castShadow>
        <meshStandardMaterial vertexColors roughness={0.94} side={DoubleSide} />
      </mesh>

      {lanes.map((lane) => (
        <mesh key={lane.name} geometry={lane.loft.geometry} material={surface} receiveShadow />
      ))}
      {minis.map((mini) => (
        <mesh key={mini.name} geometry={mini.loft.geometry} material={surfaces[mini.surface]} receiveShadow />
      ))}

      {/* The brook, and the pool where the coombe lane fords it. */}
      <mesh geometry={brook.water.geometry} material={waterMaterial} receiveShadow />
      {brook.fords.map((ford, i) => (
        <mesh
          key={`ford${i}`}
          position={[ford.x, ford.y, ford.z]}
          rotation={[-Math.PI / 2, 0, -ford.turn]}
          material={waterMaterial}
        >
          <planeGeometry args={[ford.width, 11]} />
        </mesh>
      ))}

      {/* The pier, out from the headland across the harbour mouth. */}
      <mesh geometry={pier.stone.geometry} material={stoneMaterial} castShadow receiveShadow />
      <mesh geometry={pier.wall.geometry} material={stoneMaterial} castShadow receiveShadow />
      {Object.entries(JUNCTIONS).map(([key, j]) => (
        <JunctionTile key={key} scene={scene} piece={j.piece} x={j.x} z={j.z} turn={j.turn} />
      ))}

      {/* Skylark Water, and the two ponds. Still water: what moves on this
          island is the animals, the mill and the turbines. */}
      <mesh geometry={water.lake} receiveShadow>
        <meshStandardMaterial
          color="#2a5660"
          roughness={0.1}
          metalness={0.25}
          transparent
          opacity={0.88}
        />
      </mesh>
      {PONDS.map((pond) => (
        <mesh
          key={pond.label}
          position={[pond.x, pondLevel(pond), pond.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <circleGeometry args={[pond.r, 32]} />
          <meshStandardMaterial color="#35595a" roughness={0.12} metalness={0.2} transparent opacity={0.9} />
        </mesh>
      ))}

      <CountryPlanting />
      <CountryBuildings />
      <CountryLife />
      <CountryWater />
      <CountryVehicles />
      <CountryMine />

      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[crown.vertices, crown.indices]} friction={1} />
        {lanes.map((lane) => (
          <TrimeshCollider key={lane.name} args={[lane.loft.vertices, lane.loft.indices]} friction={1} />
        ))}
        {minis.map((mini) => (
          <TrimeshCollider
            key={mini.name}
            args={[mini.loft.vertices, mini.loft.indices]}
            friction={mini.surface === 'gravel' ? 0.8 : 1}
          />
        ))}
        <TrimeshCollider args={[pier.stone.vertices, pier.stone.indices]} friction={1} />
        <TrimeshCollider args={[pier.wall.vertices, pier.wall.indices]} friction={1} />
        {Object.entries(JUNCTIONS).map(([key, j]) => (
          <CuboidCollider
            key={key}
            args={[LANE_WIDTH / 2, 0.06, LANE_WIDTH / 2]}
            position={[j.x, (roadLevelAt(j.x, j.z) ?? groundAt(j.x, j.z)) + ROAD_TOP - 0.06, j.z]}
            rotation={[0, j.turn, 0]}
            friction={1}
          />
        ))}
      </RigidBody>
    </group>
  );
}

/** For anything outside the group that wants to know how high the island is. */
export const countryRelief = reliefAt;
