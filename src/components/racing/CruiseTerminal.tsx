'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, Object3D,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { BOAT_MODEL, HULLS } from '@/config/boatConfig';
import { CRUISE, CRUISE_BERTH, STATION_SITE } from '@/config/stationConfig';
import { TRAIN } from '@/config/trainConfig';

useGLTF.preload(BOAT_MODEL, DRACO_PATH);

/** Which hull lies here. Tagged onto her meshes by `prepare-boats`. */
const SHIP = 'viking';

/** Concrete, the island's own — see `ISLAND_COPING` and `AirportIsland`. */
const CONCRETE = '#9a9791';
/** The coping band and the bollards, a shade off the apron so the edge reads. */
const COPING = '#b4b0a8';
const FITTING = '#3f4348';

/**
 * How far the ship's side stands off the quay face: a fender, and no more.
 *
 * She is *moored*, not manoeuvring, so this is the thickness of what is between
 * the hull and the concrete rather than any kind of clearance. Her own beam is
 * added to it in `CruiseTerminal`, because the model is centred on its
 * centreline and what has to clear the wall is her side.
 */
const FENDER_GAP = 1.6;

/**
 * The reclamation: the apron's top surface, and the wall round its wet edges.
 *
 * Two pieces because they are two different surfaces and want two materials,
 * but one construction — the apron is a strip between the measured shore and
 * the straight face, and the wall is that same face and the two ends carried
 * down to the seabed.
 *
 * The shore samples are pulled `KEY` metres *inland* of where the coast was
 * found, so the slab keys into the island rather than meeting its grass along a
 * seam. There is nothing clever about the overlap: the crown is flat here and
 * the apron is at the same height, so a few metres of concrete over grass is
 * invisible where an exact butt joint would z-fight the whole length of the
 * berth.
 */
const KEY = 5;

/**
 * How far the apron stands over the island crown, metres.
 *
 * Not decoration: the slab overlaps the grass by `KEY` metres and the crown is
 * flat here, so at the same height the two are *coplanar* over a 5 m band the
 * whole length of the berth — which is not an invisible join, it is 240 m of
 * z-fighting. 5 cm is the same trick `SURFACE.road` uses to lay the town's
 * streets on the same crown, and it is under the depth buffer's noise at any
 * distance you would see the quay from.
 */
const APRON_TOP = 0.05;

function buildQuay() {
  const berth = CRUISE_BERTH;
  if (!berth) return null;
  const n = berth.shore.length;

  const apron: number[] = [];
  const apronIndex: number[] = [];
  const wall: number[] = [];
  const wallIndex: number[] = [];

  for (let i = 0; i < n; i++) {
    const along = berth.from + i * CRUISE.step;
    const inner = Math.max(0, berth.shore[i] - KEY);
    // Local frame: X across, Y up from the island crown, Z along. Same frame
    // `IslandTown` builds in, and for the same reason — everything here is
    // stated in the station's own coordinates and the group does the turning.
    apron.push(inner, APRON_TOP, along);
    apron.push(berth.face, APRON_TOP, along);
  }
  // Wound so the deck faces UP. It did not: with X across and Z along, both
  // increasing, `(a, a+1, b+1)` puts the normal at −Y, and a front-facing
  // material on a downward slab draws nothing at all — you looked through the
  // quay to the sea, with the bollards and the ship standing on open water.
  // The same trap `TRAIN_ISLANDS` documents for the island fan, one dimension
  // up: getting it wrong does not warn, it just builds nothing you can see.
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    apronIndex.push(a, b + 1, a + 1, a, b, b + 1);
  }

  // The wet edge: down the face from end to end, then back along each end wall
  // to the shore. Carried to the seabed rather than to the waterline, for the
  // reason the island's own wall gives — two flat surfaces meeting at exactly
  // one height is a ring of z-fighting, and under the water the sea plane
  // simply cuts it.
  const foot = TRAIN.seabed;
  const edge: Array<[number, number]> = [];
  edge.push([Math.max(0, berth.shore[0] - KEY), berth.from]);
  for (let i = 0; i < n; i++) edge.push([berth.face, berth.from + i * CRUISE.step]);
  edge.push([Math.max(0, berth.shore[n - 1] - KEY), berth.to]);
  // Top ring at the apron's own height, not at the crown, or the wall stands
  // 5 cm short of the deck it is holding up and the sea shows through the gap.
  for (const [across, along] of edge) {
    wall.push(across, APRON_TOP, along);
    wall.push(across, foot - STATION_SITE!.ground, along);
  }
  for (let i = 0; i < edge.length - 1; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    wallIndex.push(a, a + 1, b + 1, a, b + 1, b);
  }

  const make = (positions: number[], indices: number[]) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return {
      geometry,
      vertices: new Float32Array(positions),
      indices: new Uint32Array(indices),
    };
  };
  return { apron: make(apron, apronIndex), wall: make(wall, wallIndex) };
}

/**
 * Kestrel's cruise berth: a reclaimed quay on the north shore, and the ship
 * lying at it.
 *
 * She never moves and has no route. That is the point of her — `SeaTraffic`
 * already has six hulls going round in rings, and what an island station with a
 * town cleared off it was short of was something *arrived*. A 191 m ferry tied
 * up alongside is a hundred metres of white superstructure standing over the
 * platforms, visible from the train two kilometres out, and it costs one draw
 * call's worth of clone and no per-frame work at all.
 *
 * She comes out of `boats.glb` like every other hull, by the `boat` tag
 * `prepare-boats` writes into her meshes' `userData`. A second model file for
 * one ship that happens to be stationary would have been a second pipeline.
 */
export function CruiseTerminal() {
  const site = STATION_SITE;
  const berth = CRUISE_BERTH;
  const { scene } = useGLTF(BOAT_MODEL, DRACO_PATH);
  const built = useMemo(() => buildQuay(), []);

  /**
   * Her hull, cloned out of the fleet.
   *
   * Cloned for the reason `SeaTraffic` clones: drei caches one scene per URL,
   * and re-parenting the fleet's own meshes into this group would take them
   * away from the boats that are using them.
   */
  const ship = useMemo(() => {
    const group = new Group();
    (scene as unknown as Object3D).traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const owner = (child.userData as { boat?: string }).boat
        ?? (child.parent?.userData as { boat?: string } | undefined)?.boat;
      if (owner !== SHIP) return;
      const clone = child.clone();
      clone.castShadow = true;
      clone.receiveShadow = true;
      group.add(clone);
    });
    return group.children.length ? group : null;
  }, [scene]);

  useEffect(() => {
    if (!ship) console.warn(`[cruise] no hull tagged "${SHIP}" in ${BOAT_MODEL}`);
  }, [ship]);

  useEffect(() => () => {
    built?.apron.geometry.dispose();
    built?.wall.geometry.dispose();
  }, [built]);

  if (!site || !berth || !built) return null;

  const hull = HULLS[SHIP];
  const beam = hull?.size[0] ?? 34;
  // Her centreline: the face, a fender, and half her beam. The model is centred
  // on its own centreline and its origin sits at the waterline (`prepare-boats`
  // drops the keel `draught` below it), so this is the whole placement — she
  // needs no lift and no trim.
  const shipAcross = berth.face + FENDER_GAP + beam / 2;
  const shipY = TRAIN.seaLevel - site.ground;

  const bollards: number[] = [];
  for (let at = berth.from + CRUISE.bollardPitch / 2; at < berth.to; at += CRUISE.bollardPitch) {
    bollards.push(at);
  }
  const fenders: number[] = [];
  for (let at = berth.from + CRUISE.fenderPitch / 2; at < berth.to; at += CRUISE.fenderPitch) {
    fenders.push(at);
  }

  return (
    <group
      position={[site.centre[0], site.ground, site.centre[2]]}
      rotation={[0, site.heading, 0]}
    >
      <mesh geometry={built.apron.geometry} receiveShadow>
        <meshStandardMaterial color={CONCRETE} roughness={0.95} />
      </mesh>
      <mesh geometry={built.wall.geometry} receiveShadow castShadow>
        <meshStandardMaterial color={CONCRETE} roughness={0.9} side={DoubleSide} />
      </mesh>

      {/* The coping: a band along the face, set inboard and stood a little
          proud, exactly as the island's sea wall has one. It is what stops the
          quay edge reading as the place the apron happens to stop. */}
      <mesh
        position={[berth.face - CRUISE.coping / 2, APRON_TOP + 0.06, CRUISE.along]}
        receiveShadow
      >
        <boxGeometry args={[CRUISE.coping, 0.12, berth.to - berth.from]} />
        <meshStandardMaterial color={COPING} roughness={0.9} />
      </mesh>

      {/* Bollards, inboard of the coping so a line leads fair over the edge. */}
      {bollards.map((at) => (
        <mesh key={`b${at}`} position={[berth.face - 2.6, APRON_TOP + 0.45, at]} castShadow>
          <cylinderGeometry args={[0.3, 0.42, 0.9, 10]} />
          <meshStandardMaterial color={FITTING} roughness={0.7} metalness={0.3} />
        </mesh>
      ))}

      {/* Fenders on the face, hung at the waterline where the hull touches. */}
      {fenders.map((at) => (
        <mesh key={`f${at}`} position={[berth.face + 0.45, shipY + 1.2, at]} castShadow>
          <boxGeometry args={[0.9, 2.4, 1.6]} />
          <meshStandardMaterial color="#2b2b2c" roughness={0.95} />
        </mesh>
      ))}

      {/* The ship. Bow to −Z out of `prepare-boats`, which in this frame is
          bow toward the west end of the berth — she lies head out, the way a
          ship is left when she has to sail without turning in the basin. */}
      {ship && (
        <group position={[shipAcross, shipY, CRUISE.along]}>
          <primitive object={ship} />
        </group>
      )}

      {/* Solid: the apron only. It is the one part anything can get onto, and
          the island crown it stands on is already a collider — but the crown
          stops at the outline and this reaches past it, so without this the
          quay is a slab a car drives through into the sea. The wall needs
          none: nothing can reach its face that is not already in the water. */}
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider
          args={[built.apron.vertices, built.apron.indices]}
          friction={1}
        />
      </RigidBody>
    </group>
  );
}
