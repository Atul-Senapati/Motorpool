'use client';

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BufferGeometry, CanvasTexture, Float32BufferAttribute, MeshStandardMaterial, SRGBColorSpace,
} from 'three';
import { ROAD_TOP } from '@/config/roadConfig';
import { STATION_SITE } from '@/config/stationConfig';
import { PARKED_CARS, PARKING_LOTS } from '@/config/kestrelHalls';
import { DRACO_PATH } from '@/config/cityConfig';
import catalogue from '@/config/vehicleCatalogue.json';
import { buildVehicle } from './AirportTraffic';

const CITY_VEHICLES = '/models/vehicles.glb';

/**
 * The shops' car park beside the station (`PARKING_LOTS`).
 *
 * Deliberately plain: an asphalt slab at the road's own height with its bays
 * painted on, solid underneath so a car sits on it rather than in it. Each lot
 * is one canvas — asphalt, a little grain, white bay lines — laid over its
 * rectangle, so a lot is two triangles and one texture.
 *
 * Each lot lists its own bay rows across it; the bays are 2.6 m wide, running
 * along (`along`).
 */

const PX_PER_M = 16;
const BAY_WIDTH = 2.6;
function paintLot(width: number, length: number, rows: ReadonlyArray<[number, number]>, anisotropy: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * PX_PER_M);
  canvas.height = Math.round(length * PX_PER_M);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#4a4c4f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Grain, so 2,000 m² of one grey is not a flat sheet.
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let seed = 0x5eed;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = ((seed / 4294967296) - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // Bay lines: across each row at every bay boundary, and the row's back line.
  ctx.fillStyle = '#e9e7e0';
  const line = 0.12 * PX_PER_M;
  for (const [start, depth] of rows) {
    const x0 = start * PX_PER_M;
    const w = depth * PX_PER_M;
    for (let along = 1; along + BAY_WIDTH <= length - 1 + 1e-6; along += BAY_WIDTH) {
      ctx.fillRect(x0, along * PX_PER_M, w, line);
    }
    const last = 1 + Math.floor((length - 2) / BAY_WIDTH) * BAY_WIDTH;
    ctx.fillRect(x0, last * PX_PER_M, w, line);
  }
  // Each row's head line, where the bumpers stop.
  for (const [start, depth] of rows) {
    ctx.fillRect((start + depth) * PX_PER_M - line, PX_PER_M, line, (length - 2) * PX_PER_M);
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  // Row 0 at v = 0, so the canvas is drawn in (across, along) as it reads.
  tex.flipY = false;
  tex.anisotropy = anisotropy;
  return tex;
}

export function KestrelParking() {
  const site = STATION_SITE;
  const anisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  const { scene: city } = useGLTF(CITY_VEHICLES, DRACO_PATH);

  /**
   * The parked cars, in their bays: the city's own models (`buildVehicle`),
   * which face −Z, so a nose to +across is a quarter turn the other way.
   */
  const parked = useMemo(() => PARKED_CARS.flatMap((p, i) => {
    const lot = PARKING_LOTS[p.lot];
    const row = lot?.rows[p.row];
    const object = row ? buildVehicle(p.part, true, city, city) : null;
    if (!lot || !row || !object) return [];
    const size = catalogue.vehicles.find((v) => v.name === p.part)?.size ?? [2, 1.5, 4.6];
    const across = lot.acrossFrom + row[0] + row[1] / 2;
    const along = lot.alongFrom + 1 + (p.bay + 0.5) * BAY_WIDTH;
    return [{ key: `${p.part}-${i}`, object, across, along, turn: p.nose > 0 ? -Math.PI / 2 : Math.PI / 2, size }];
  }), [city]);

  const lots = useMemo(() => PARKING_LOTS.map((lot) => {
    const width = lot.acrossTo - lot.acrossFrom;
    const length = lot.alongTo - lot.alongFrom;
    const y = ROAD_TOP + 0.004;
    // A strip of quads along the lot, so the road edge can follow a curve. The
    // texture is laid in the lot's full rectangle, so the bays stay square to
    // it wherever the edge cuts them.
    const steps = lot.edge ? Math.max(1, Math.ceil(length / 2)) : 1;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k <= steps; k++) {
      const along = lot.alongFrom + (length * k) / steps;
      const from = lot.edge ? lot.edge(along) : lot.acrossFrom;
      for (const across of [from, lot.acrossTo]) {
        pos.push(across, y, along);
        uv.push((across - lot.acrossFrom) / width, (along - lot.alongFrom) / length);
      }
      if (k > 0) {
        const b = (k - 1) * 2;
        idx.push(b, b + 3, b + 1, b, b + 2, b + 3);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const material = new MeshStandardMaterial({ map: paintLot(width, length, lot.rows, anisotropy), roughness: 0.95 });
    // Solid: the same surface, as a trimesh, at the road's height.
    const collider = [new Float32Array(pos), new Uint32Array(idx)] as [Float32Array, Uint32Array];
    return { lot, geometry: g, material, collider };
  }), [anisotropy]);
  useEffect(() => () => {
    for (const l of lots) { l.geometry.dispose(); l.material.map?.dispose(); l.material.dispose(); }
  }, [lots]);

  if (!site) return null;
  return (
    <group position={[site.centre[0], site.ground, site.centre[2]]} rotation={[0, site.heading, 0]}>
      {lots.map((l, i) => <mesh key={i} geometry={l.geometry} material={l.material} receiveShadow />)}
      {parked.map((c) => (
        <primitive
          key={c.key}
          object={c.object}
          position={[c.across, ROAD_TOP + 0.004, c.along]}
          rotation={[0, c.turn, 0]}
        />
      ))}
      <RigidBody type="fixed" colliders={false}>
        {lots.map((l, i) => <TrimeshCollider key={i} args={l.collider} />)}
        {/* The parked cars are solid: a box each, length across the bay. */}
        {parked.map((c) => (
          <CuboidCollider
            key={c.key}
            args={[c.size[2] / 2, c.size[1] / 2, c.size[0] / 2]}
            position={[c.across, ROAD_TOP + c.size[1] / 2, c.along]}
          />
        ))}
      </RigidBody>
    </group>
  );
}
