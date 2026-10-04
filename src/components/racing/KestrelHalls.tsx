'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody } from '@react-three/rapier';
import { Mesh, Object3D } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { PLAZA_FLOOR, ROAD_TOP } from '@/config/roadConfig';
import {
  ASSEMBLY_HALL, ASSEMBLY_SITE, SHOP_MODELS, SHOP_SITES, SPORTS_HALL, SPORTS_SITE,
} from '@/config/kestrelHalls';
import { STATION_SITE } from '@/config/stationConfig';
import { partColliders } from './partColliders';

useGLTF.preload(SPORTS_HALL.model, DRACO_PATH);
useGLTF.preload(ASSEMBLY_HALL.model, DRACO_PATH);
for (const shop of Object.values(SHOP_MODELS)) useGLTF.preload(shop.model, DRACO_PATH);

type Site = NonNullable<typeof SPORTS_SITE>;

/**
 * One hall, placed. Same recipe as `KestrelCivic`: the model arrives centred on
 * its footprint and standing on its deck, so a placement is a position, a turn
 * and the scale the block solved for. Solid from boxes measured off the
 * geometry (`prepare-colliders.mjs`), not a box round its bounds.
 */
function Hall({ url, name, site, size, floor = ROAD_TOP }: {
  url: string;
  name: string;
  site: Site;
  size: readonly [number, number, number];
  /** What it stands on: the crown's road level, or a paved plaza's (`PLAZA_FLOOR`). */
  floor?: number;
}) {
  const { scene } = useGLTF(url, DRACO_PATH);
  // Cloned, like every prop on this island: drei caches one scene per URL.
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
    console.info(`[halls] ${name} in a ${site.block[0].toFixed(0)} x ${site.block[1].toFixed(0)} m `
      + `plot at across ${site.across.toFixed(0)}, along ${site.along.toFixed(0)}: `
      + `${site.footprint.map((v) => v.toFixed(0)).join(' x ')} m, ${site.height.toFixed(1)} m tall `
      + `at ${(site.scale * 100).toFixed(0)}%`);
  }, [name, site]);

  return (
    <>
      <group
        position={[site.across, floor, site.along]}
        rotation={[0, site.turn, 0]}
        scale={site.scale}
      >
        <primitive object={hall} />
      </group>
      <RigidBody type="fixed" colliders={false}>
        {partColliders(name, site.across, site.along, site.turn, size, name, site.scale)}
      </RigidBody>
    </>
  );
}

/** The two halls and the three shops, on Kestrel's grid. */
export function KestrelHalls() {
  const station = STATION_SITE;
  if (!station) return null;
  return (
    <group
      position={[station.centre[0], station.ground, station.centre[2]]}
      rotation={[0, station.heading, 0]}
    >
      {SPORTS_SITE && (
        <Hall url={SPORTS_HALL.model} name="sportsHall" site={SPORTS_SITE} size={SPORTS_HALL.size} floor={PLAZA_FLOOR} />
      )}
      {ASSEMBLY_SITE && (
        <Hall url={ASSEMBLY_HALL.model} name="assemblyHall" site={ASSEMBLY_SITE} size={ASSEMBLY_HALL.size} floor={PLAZA_FLOOR} />
      )}
      {SHOP_SITES.map((shop) => (
        <Hall
          key={shop.name}
          url={SHOP_MODELS[shop.name].model}
          name={shop.name}
          site={shop}
          size={SHOP_MODELS[shop.name].size}
          floor={ROAD_TOP + 0.015}
        />
      ))}
    </group>
  );
}
