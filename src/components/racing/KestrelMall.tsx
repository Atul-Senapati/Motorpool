'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody } from '@react-three/rapier';
import { Mesh, Object3D } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_TOP } from '@/config/roadConfig';
import { MALL_SITE, MALL } from '@/config/kestrelMall';
import { STATION_SITE } from '@/config/stationConfig';
import { partColliders } from './partColliders';

useGLTF.preload(MALL.model, DRACO_PATH);

/**
 * The mall, inside the ring road at the west end of the island.
 *
 * Which ground and why, and where the 0.396 comes from, is in `kestrelMall`;
 * this is the placing, and there is very little of it. The mall arrives out of
 * `prepare-mall.mjs` centred on its own footprint and standing on its deck, so
 * a placement is a position, a turn and the scale the half disc solved for —
 * there is no offset to work out and no ground to build, because a mall
 * standing in grass is standing in grass.
 *
 * It sits `ROAD_TOP` over the crown, the same 72 mm the road kit's slabs and
 * everything else on this island take, and its slab reaches 1.5 m below that
 * (`MALL.skirt`), so the lift buries itself instead of leaving a step.
 *
 * Solid, from boxes measured off the geometry by `prepare-colliders.mjs` rather
 * than a box round its bounds. That matters more here than anywhere: the model
 * is six separate ranges with gaps between them, and one box round the lot
 * would make 157 m of service yard into a wall.
 */
export function KestrelMall() {
  const site = STATION_SITE;
  const mall = MALL_SITE;
  const { scene } = useGLTF(MALL.model, DRACO_PATH);

  /**
   * Cloned, for the reason every prop on this island clones: drei caches one
   * scene per URL, and re-parenting it into this group takes it away from
   * anything else asking for the same file — including this component's own
   * next mount after a hot reload.
   */
  const hall = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return copy;
  }, [scene]);

  useEffect(() => {
    if (!mall) return;
    console.info(`[mall] inside the ring road: a ${mall.disc[0].toFixed(0)} x `
      + `${mall.disc[1].toFixed(0)} m half disc holding `
      + `${mall.footprint.map((v) => v.toFixed(0)).join(' x ')} m of mall `
      + `${mall.height.toFixed(1)} m tall at ${(mall.scale * 100).toFixed(0)}%, `
      + `at across ${mall.across.toFixed(0)}, along ${mall.along.toFixed(0)}; `
      + `${MALL.triangles.toLocaleString()} tris`);
  }, [mall]);

  if (!site || !mall) return null;

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      <group
        position={[mall.across, ROAD_TOP, mall.along]}
        rotation={[0, mall.turn, 0]}
        scale={mall.scale}
      >
        <primitive object={hall} />
      </group>

      <RigidBody type="fixed" colliders={false}>
        {partColliders(
          'mall',
          mall.across,
          mall.along,
          mall.turn,
          MALL.size,
          'mall',
          mall.scale,
        )}
      </RigidBody>
    </group>
  );
}
