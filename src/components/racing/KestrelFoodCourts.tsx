'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import { FOOD_COURT_SITES } from '@/config/kestrelBeach';
import { cropCity } from './cityCrop';

/**
 * Kestrel Beach's food courts — see `FOOD_COURTS` in `kestrelBeach` for which
 * and where. Each is cut out of the city that is already loaded
 * (`cropCity`), so it is the city's own deck, tables, kiosk and stalls with
 * the city's own textures: no new download and no new texture memory, only
 * the cut triangles. Roads, car parks and cones are left behind.
 *
 * Solid: the cut geometry is its own trimesh, so a car stops at a stall and
 * drives up onto the deck.
 */

/** Materials not brought along: the streets, the parking and the traffic cones. The trees come, so the square's planters are not empty pits. */
const LEAVE = new Set(['Street', 'Parking', 'Obstacles']);

export function KestrelFoodCourts() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);

  const courts = useMemo(() => FOOD_COURT_SITES.map((site) => {
    const pieces = cropCity(scene, site.box, (m) => LEAVE.has(m));
    const colliders = pieces.map(({ geometry }) => {
      const p = geometry.getAttribute('position').array as Float32Array;
      return [new Float32Array(p), Uint32Array.from({ length: p.length / 3 }, (_, i) => i)] as [Float32Array, Uint32Array];
    });
    return { site, pieces, colliders };
  }), [scene]);
  useEffect(() => () => {
    for (const c of courts) for (const p of c.pieces) p.geometry.dispose();
  }, [courts]);
  useEffect(() => {
    console.info(`[food courts] ${courts.map((c) => `${c.site.name}: ${c.pieces.reduce(
      (n, p) => n + p.geometry.getAttribute('position').count / 3, 0)} tris in ${c.pieces.length} materials`).join(', ')}`);
  }, [courts]);

  return (
    <>
      {courts.map(({ site, pieces, colliders }) => (
        <group key={site.name} position={[site.x, site.y, site.z]} rotation={[0, site.heading, 0]}>
          {pieces.map((p, i) => (
            <mesh key={i} geometry={p.geometry} material={p.material} castShadow receiveShadow />
          ))}
          <RigidBody type="fixed" colliders={false}>
            {colliders.map((args, i) => <TrimeshCollider key={i} args={args} />)}
          </RigidBody>
        </group>
      ))}
    </>
  );
}
