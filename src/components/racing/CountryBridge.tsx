'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import {
  BoxGeometry, BufferGeometry, ClampToEdgeWrapping, DoubleSide, Mesh, RepeatWrapping,
  type Material, type Texture,
} from 'three';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_PAVEMENT, ROAD_REPEAT } from '@/config/roadConfig';
import { type RoadBridge } from '@/config/countryConfig';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * The viaduct from Halcyon Field to Skylark.
 *
 * A concrete beam bridge: a deck slab on twin box girders, carried on
 * hammerhead piers every 46 m across 300 m of water, with a low parapet
 * either side. Plainer than the tied arch to the airport on purpose — that
 * crossing is the way into an airport and wants to be looked at; this one is
 * the way out to a farm, and what you look at from it is the island ahead.
 *
 * Straight, because `roadConfig`'s T points it straight at the island, so
 * every sample has the same normal and there is no curve to solve. The
 * profile is `BRIDGE.topAt`: the chord between the airport crown and the
 * landing with a `sin²` hump over the water, 6.5 m at mid-span — 14 m of air
 * under the deck for a yacht, and a crest you can see the whole island from.
 *
 * The same `buildLoft` sweeps as the airport bridge for the slab, the
 * carriageway, the girders and the parapets, and the same road-kit texture
 * on the running surface, cropped to its four lanes so the deck's own
 * parapets are the only footway.
 */

function part(
  x: number, z: number, y: number, turn: number, w: number, h: number, d: number,
): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  g.rotateY(turn);
  g.translate(x, y, z);
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry | null {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

function useRoadSurface(): Material | undefined {
  const { scene } = useGLTF('/models/roads.glb', DRACO_PATH);
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

function buildBridge(B: RoadBridge) {
  const [ux, uz] = B.dir;
  const nx = -uz;
  const nz = ux;
  const turn = Math.atan2(ux, uz);
  const count = Math.round(B.endS / B.step);
  const samples: LoftSample[] = [];
  let arc = 0;
  let prevY = B.topAt(0);
  for (let i = 0; i <= count; i++) {
    const s = (i / count) * B.endS;
    const [x, z] = B.pointAt(s);
    const y = B.topAt(s);
    if (i > 0) arc += Math.hypot(B.endS / count, y - prevY);
    prevY = y;
    samples.push({ x, z, y, nx, nz, arc });
  }
  const half = B.halfWidth;
  const shoulder = half - 0.7;
  const slab: ProfileVertex[] = [
    { off: -half, rise: 0 }, { off: half, rise: 0 }, { off: half, rise: -B.deck }, { off: -half, rise: -B.deck },
  ];
  const road: ProfileVertex[] = [
    { off: -shoulder, rise: 0.06 }, { off: shoulder, rise: 0.06 },
    { off: shoulder, rise: 0 }, { off: -shoulder, rise: 0 },
  ];
  const girder = (side: 1 | -1): ProfileVertex[] => {
    const o = side * B.girder.offset;
    const h = B.girder.width / 2;
    return [
      { off: o - h, rise: -B.deck }, { off: o + h, rise: -B.deck },
      { off: o + h, rise: -B.deck - B.girder.depth }, { off: o - h, rise: -B.deck - B.girder.depth },
    ];
  };
  const edge = (side: 1 | -1): ProfileVertex[] => {
    const outer = side * half;
    const inner = side * (half - B.edgeWidth);
    return [
      { off: inner, rise: B.edgeHeight }, { off: outer, rise: B.edgeHeight },
      { off: outer, rise: 0 }, { off: inner, rise: 0 },
    ];
  };
  const cap = (side: 1 | -1): ProfileVertex[] => {
    const outer = side * (half + B.capOver);
    const inner = side * (half - B.edgeWidth - B.capOver);
    return [
      { off: inner, rise: B.edgeHeight + B.capHeight }, { off: outer, rise: B.edgeHeight + B.capHeight },
      { off: outer, rise: B.edgeHeight }, { off: inner, rise: B.edgeHeight },
    ];
  };
  // The parapet runs over the water and a little onto each shore; on the
  // airport's crown and the island's landing the deck is a road and has a
  // verge instead.
  const edgeRun = samples.filter((s) => s.arc >= B.airportShoreS - 10 && s.arc <= B.landfallS + 12);

  const steel: BufferGeometry[] = [];
  const piers: BufferGeometry[] = [];
  const girderBottom = (s: number) => B.topAt(s) - B.deck - B.girder.depth;
  // Cross beams between the girders, over the water.
  for (let s = B.airportShoreS + 6; s < B.landfallS - 4; s += 12) {
    const [x, z] = B.pointAt(s);
    steel.push(part(x, z, girderBottom(s) + B.girder.depth / 2, turn, B.girder.offset * 2, 0.6, 0.5));
  }
  for (const s of B.piers) {
    const [x, z] = B.pointAt(s);
    const capY = girderBottom(s) - B.pier.capDepth / 2;
    piers.push(part(x, z, capY, turn, B.pier.capHalf * 2, B.pier.capDepth, B.pier.half * 2.6));
    const footY = B.seabed;
    const height = capY - B.pier.capDepth / 2 - footY;
    if (height <= 0) continue;
    for (const side of [-1, 1] as const) {
      const off = side * B.pier.spread;
      piers.push(part(
        x + nx * off, z + nz * off, footY + height / 2, turn,
        B.pier.half * 2, height, B.pier.half * 2,
      ));
    }
  }

  const roadLoft = (() => {
    const loft = buildLoft(samples, road, { closed: true, vScale: 8 });
    const uv = loft.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      const t = Math.min(1, Math.max(0, uv.getX(i)));
      const across = ROAD_PAVEMENT + t * (1 - 2 * ROAD_PAVEMENT);
      uv.setXY(i, (uv.getY(i) * 8) / ROAD_REPEAT, across);
    }
    uv.needsUpdate = true;
    return loft;
  })();

  let crest = -Infinity;
  for (const s of samples) crest = Math.max(crest, s.y);
  return {
    length: arc,
    crest,
    slab: buildLoft(samples, slab, { closed: true, vScale: 8 }),
    road: roadLoft,
    girders: [
      buildLoft(samples, girder(-1), { closed: true, vScale: 8 }),
      buildLoft(samples, girder(1), { closed: true, vScale: 8 }),
    ],
    edges: [
      buildLoft(edgeRun, edge(-1), { closed: true, vScale: 8 }),
      buildLoft(edgeRun, edge(1), { closed: true, vScale: 8 }),
    ],
    caps: [
      buildLoft(edgeRun, cap(-1), { closed: true, vScale: 8 }),
      buildLoft(edgeRun, cap(1), { closed: true, vScale: 8 }),
    ],
    steel: merge(steel),
    piers: merge(piers),
  };
}

export function CountryBridge({ bridge }: { bridge: RoadBridge }) {
  const roadSurface = useRoadSurface();
  const built = useMemo(() => buildBridge(bridge), [bridge]);

  useEffect(() => {
    console.info(`[bridge] ${Math.round(built.length)} m to ${bridge.label} on ${bridge.piers.length} piers; deck `
      + `${bridge.airportTop.toFixed(2)} m at the start, ${built.crest.toFixed(2)} m at the crest `
      + `(${(built.crest - bridge.seaLevel).toFixed(1)} m over the water), `
      + `${bridge.landingTop.toFixed(2)} m at the landing`);
    return () => {
      built.slab.geometry.dispose();
      built.road.geometry.dispose();
      for (const g of [...built.girders, ...built.edges, ...built.caps]) g.geometry.dispose();
      built.steel?.dispose();
      built.piers?.dispose();
    };
  }, [built, bridge]);

  const C = bridge.colours;
  return (
    <group>
      <mesh geometry={built.slab.geometry} castShadow receiveShadow>
        <meshStandardMaterial color={C.deck} roughness={0.9} side={DoubleSide} />
      </mesh>
      <mesh geometry={built.road.geometry} receiveShadow material={roadSurface} />
      {built.edges.map((g, i) => (
        <mesh key={`edge${i}`} geometry={g.geometry} castShadow receiveShadow>
          <meshStandardMaterial color={C.deck} roughness={0.9} side={DoubleSide} />
        </mesh>
      ))}
      {built.caps.map((g, i) => (
        <mesh key={`cap${i}`} geometry={g.geometry} castShadow receiveShadow>
          <meshStandardMaterial color={C.steel} roughness={0.6} metalness={0.5} side={DoubleSide} />
        </mesh>
      ))}
      {built.girders.map((g, i) => (
        <mesh key={`girder${i}`} geometry={g.geometry} castShadow receiveShadow>
          <meshStandardMaterial color={C.deck} roughness={0.85} side={DoubleSide} />
        </mesh>
      ))}
      {built.steel && (
        <mesh geometry={built.steel} castShadow receiveShadow>
          <meshStandardMaterial color={C.steel} roughness={0.55} metalness={0.6} />
        </mesh>
      )}
      {built.piers && (
        <mesh geometry={built.piers} castShadow receiveShadow>
          <meshStandardMaterial color={C.pier} roughness={0.92} />
        </mesh>
      )}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[built.road.vertices, built.road.indices]} friction={1} />
      </RigidBody>
    </group>
  );
}
