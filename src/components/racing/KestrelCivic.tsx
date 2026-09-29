'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody } from '@react-three/rapier';
import { Mesh, Object3D } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { ROAD_TOP } from '@/config/roadConfig';
import { CIVIC_SITE, JUSTICE } from '@/config/kestrelCivic';
import { STATION_SITE } from '@/config/stationConfig';
import { partColliders } from './partColliders';

useGLTF.preload(JUSTICE.model, DRACO_PATH);

/**
 * The Hall of Justice, in the block opposite Kestrel Water.
 *
 * Which block and why is in `kestrelCivic`; this is the placing, and there is
 * very little of it. The hall arrives out of `prepare-justice.mjs` centred on
 * its own footprint and standing on its deck, so a placement is a position, a
 * turn and the scale the block solved for — there is no offset to work out and
 * no ground to build, because a civic building standing in grass is standing in
 * grass.
 *
 * It sits `ROAD_TOP` over the crown, the same 72 mm the road kit's slabs and
 * the school's campus take, and its plinth reaches nearly a metre below that
 * (`JUSTICE.skirt`), so the lift buries itself instead of leaving a step.
 *
 * Solid, from boxes measured off the geometry by `prepare-colliders.mjs` rather
 * than a box round its bounds — the same treatment the airport's terminal gets,
 * and for the same reason: this one is a colonnade round a hall, and a bounding
 * box would make the portico you can walk through into a wall you cannot.
 */
export function KestrelCivic() {
  const site = STATION_SITE;
  const civic = CIVIC_SITE;
  const { scene } = useGLTF(JUSTICE.model, DRACO_PATH);

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
    if (!civic) return;
    console.info(`[civic] Hall of Justice in a ${civic.block[0].toFixed(0)} x `
      + `${civic.block[1].toFixed(0)} m block at across ${civic.across.toFixed(0)}, `
      + `along ${civic.along.toFixed(0)}: ${civic.footprint.map((v) => v.toFixed(0)).join(' x ')} m `
      + `and ${civic.height.toFixed(1)} m tall at ${(civic.scale * 100).toFixed(0)}%, `
      + `verge ${civic.verge.map((v) => v.toFixed(1)).join(' / ')} m, `
      + `${JUSTICE.triangles.toLocaleString()} tris`);
  }, [civic]);

  if (!site || !civic) return null;

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      <group
        position={[civic.across, ROAD_TOP, civic.along]}
        rotation={[0, civic.turn, 0]}
        scale={civic.scale}
      >
        <primitive object={hall} />
      </group>

      <RigidBody type="fixed" colliders={false}>
        {partColliders(
          'justice',
          civic.across,
          civic.along,
          civic.turn,
          JUSTICE.size,
          'justice',
          civic.scale,
        )}
      </RigidBody>
    </group>
  );
}
