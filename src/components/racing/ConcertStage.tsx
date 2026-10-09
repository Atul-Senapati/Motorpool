'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { Mesh, Object3D } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  CONCERT, CONCERT_SITE, STAGE, STATION_SITE,
} from '@/config/stationConfig';

useGLTF.preload(STAGE.model, DRACO_PATH);

/**
 * The concert stage on Kestrel's north shore.
 *
 * The island lost its town (`TOWN_BUILT`) and got a railway station, a freight
 * yard, a cruise berth and a road viaduct, all of which are infrastructure —
 * things that carry people somewhere else. This is the first thing on it that
 * is a *destination*, which is the argument for it: an island you arrive at by
 * train, by road and by sea, and then have no reason to stay on, is a junction
 * with scenery.
 *
 * Positioned entirely from `CONCERT_SITE`, which measures the shore rather than
 * trusting a number — see the note there for why nothing on this island may be
 * pinned to a constant any more.
 *
 * ## Which way it faces
 *
 * Backing onto the sea, facing inland, because a stage faces its crowd and the
 * crowd needs ground. The model's own open side is turned to −Z by
 * `prepare-stage.mjs` (measured there, by counting triangles either side of the
 * deck), and the station's local frame has X across and Z along — so a quarter
 * turn about Y sends the open side to −X, which is inland.
 */
export function ConcertStage() {
  const site = STATION_SITE;
  const concert = CONCERT_SITE;
  const { scene } = useGLTF(STAGE.model, DRACO_PATH);

  /**
   * Cloned, for the reason every other prop here clones: drei caches one scene
   * per URL, and re-parenting it into this group takes it away from anything
   * else that asks for the same file — and from this component's own next
   * mount after a hot reload.
   */
  const stage = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return copy;
  }, [scene]);

  useEffect(() => {
    if (!concert) {
      console.warn('[concert] no room on the island for the stage and its clearance');
      return;
    }
    console.info(`[concert] stage at along ${CONCERT.along}, `
      + `back ${concert.back.toFixed(0)} m across, clear to ${concert.clearTo.toFixed(0)} m, `
      + `${STAGE.triangles.toLocaleString()} tris`);
  }, [concert]);

  if (!site || !concert) return null;

  // The stage's own middle, between its back and its front.
  const stageAcross = concert.back - STAGE.size[2] / 2;

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      {/* The ground in front is the island's own grass and nothing else. A slab
          of beaten earth was drawn here and it read as a brown carpet — see
          `CONCERT.clear`, which is what is left of it: a clearance the stage is
          checked against, not a surface. */}

      {/* A quarter turn about Y: the model's open side is −Z and inland is −X.
          See the note on the component. */}
      <group position={[stageAcross, 0, CONCERT.along]} rotation={[0, Math.PI / 2, 0]}>
        <primitive object={stage} />
      </group>

      {/* Solid, as one box round the structure rather than a trimesh of 79 k
          triangles. Nothing drives onto a stage and nothing needs to walk round
          its trusses; what a collider is for here is stopping a car driven
          across the grass from going through it. */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[STAGE.size[2] / 2, STAGE.size[1] / 2, STAGE.size[0] / 2]}
          position={[stageAcross, STAGE.size[1] / 2, CONCERT.along]}
        />
      </RigidBody>
    </group>
  );
}
