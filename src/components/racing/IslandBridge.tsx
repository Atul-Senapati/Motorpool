'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  DoubleSide, InstancedMesh, Matrix4, Mesh, Quaternion, Raycaster, Vector3,
} from 'three';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import { BRIDGE } from '@/config/stationConfig';
import { setCausewayDeck } from '@/physics/townNav';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * The road causeway out to the island.
 *
 * A reclaimed bank with the road on top of it, swept by `buildLoft` from a
 * *sampled* profile. It began as a single tilted box on piers, and both halves
 * of that were wrong: the box is what made it undrivable, and the piers are
 * what made it read as an elevated road for its whole length. The railway does
 * not cross to these islands on stilts either — it reclaims land
 * (`TRAIN.causewayCrownHalf`) — so this is now the same kind of structure, and
 * there is nothing raised about it but the 3.2 m it has to gain to meet the
 * island's crown.
 *
 * ## Why the profile is measured rather than stated
 *
 * The old deck ran dead straight from height zero in the city to 3.2 m on the
 * island. Both ends were right and everything between them was wrong, because
 * the city's waterfront is not at zero: along this street the paving runs north
 * to z -417, steps up a 16 cm kerb, and then stands a 0.76 m sea-wall face
 * whose top is at 0.92 m. A deck whose top was 0.3 m up where the wall is
 * 0.92 m high does not cross the wall — the wall crosses the *deck*, and since
 * it is a `col_` chunk it is solid. What you met driving north was a step you
 * could not climb, with the bridge visible beyond it.
 *
 * So the deck now reads the ground it is crossing and lifts itself to clear
 * whatever is there. The straight grade is the floor, not the answer.
 *
 * It reads it by *raycasting the city's own collision geometry*, which is worth
 * explaining because the obvious source is wrong. The nav raster
 * (`groundHeightAt`) is 3 m to the pixel and, where a chunk is paved, records
 * the paving's height rather than the terrain's — so along this street it
 * reports a flat 0.15 m and the sea wall does not exist as far as it is
 * concerned. Built to the raster, the deck rose to 0.58 m at the wall and the
 * car still met a wall. The `col_` chunks are the truth, because they are what
 * Rapier is given; the cost is bounded by only ever testing the handful of
 * chunks whose bounding boxes straddle the centreline.
 *
 * The wall itself is *gone* — `TERRAIN_CUTS` takes the twelve metres of it the
 * bridge lands on out of the city's shell and its collider, which is what a
 * highway authority would do rather than ramp a road over its own parapet. So
 * in practice the profile now finds flat street, agrees with the straight
 * grade, and the approach is flat. The machinery is still here and still
 * earning its place: it is what guarantees that, and it is what will cope with
 * the next kerb somebody leaves in the way.
 *
 * ## The grade limit, and the cone that enforces it
 *
 * A clearance requirement on its own would give a deck that jumps. Two passes
 * over the samples fix that: each sample is raised to at least its neighbour's
 * height less `maxGrade * step`, once walking north and once walking south.
 * That is a cone filter, and the useful property is that it only ever *raises*
 * the deck — so no amount of smoothing can undo a clearance, and the result has
 * no step steeper than the limit anywhere.
 *
 * ## Landing flush
 *
 * The clearance tapers away over the last `landing` metres at each end, and
 * past zero to a 4 cm *sink*, because at the ends the deck is not crossing the
 * ground, it is joining it — the street at one end and the island crown at the
 * other. Held to the very end, a 25 cm clearance would put a 25 cm step at both
 * joints, which is the other half of what was wrong here; stopping at exactly
 * flush would leave two coplanar surfaces meeting under a wheel, which is a lip
 * you can catch. Sunk, the road wins at the joint and the deck comes out from
 * under it.
 */

/** Dashes down the centre line, in metres: mark, then gap. */
const DASH = 3.2;
const DASH_GAP = 3.4;

interface Deck extends LoftSample {
  /** The city's own ground beside the road, or null over water. */
  ground: number | null;
}

export function IslandBridge() {
  // Hoisted so the narrowing survives into the callbacks below: TypeScript
  // discards it for an imported binding the moment it is read inside a closure.
  const bridge = BRIDGE;
  const dashes = useRef<InstancedMesh>(null);

  // The city, for the ground under the approach. Already loaded and cached by
  // `CityMap`, so this is a lookup rather than a fetch.
  const { scene: city } = useGLTF(CITY_MODEL, DRACO_PATH);

  const built = useMemo(() => {
    if (!bridge) return null;
    const B = bridge;
    // South (in the street) to north (on the island): the deck's own direction.
    const run = B.cityZ - B.islandZ;
    const count = Math.max(4, Math.round(run / B.step));

    /**
     * The city's solid chunks that could be under the bridge.
     *
     * Filtered by bounding box before any ray is cast: the city is 1.9 M
     * triangles across 33 chunks and three-way brute-force raycasting all of it
     * per sample would take seconds. What straddles this centreline is the
     * street, two terrain shells and a building — about 5,000 triangles, which
     * is thirty-five rays of nothing.
     */
    const under: Mesh[] = [];
    const north = Math.min(B.cityZ, B.islandZ) - 10;
    const south = Math.max(B.cityZ, B.islandZ) + 10;
    city.traverse((object) => {
      if (!(object instanceof Mesh) || !object.name.startsWith('col_')) return;
      const geometry = object.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box) return;
      if (box.max.x < B.x - 20 || box.min.x > B.x + 20) return;
      if (box.max.z < north || box.min.z > south) return;
      object.updateWorldMatrix(true, false);
      under.push(object);
    });

    /**
     * The highest solid surface within a window of a point, or null where there
     * is nothing but water.
     *
     * The maximum over the window, not a single ray: a kerb or a wall a metre
     * off the centreline still has to be cleared, because the deck is 13 m wide
     * and the car can be anywhere on it.
     */
    const raycaster = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const from = new Vector3();
    const groundNear = (x: number, z: number): number | null => {
      if (!under.length) return null;
      let highest: number | null = null;
      for (let dx = -B.probe; dx <= B.probe; dx += B.probe) {
        for (let dz = -B.probe; dz <= B.probe; dz += B.probe) {
          from.set(x + dx, 80, z + dz);
          raycaster.set(from, down);
          for (const hit of raycaster.intersectObjects(under, false)) {
            // Anything below the sea is the seabed shell, not ground.
            if (hit.point.y < -1) continue;
            if (highest === null || hit.point.y > highest) highest = hit.point.y;
            break;
          }
        }
      }
      return highest;
    };

    const zs: number[] = [];
    const ground: Array<number | null> = [];
    for (let i = 0; i <= count; i++) {
      const z = B.cityZ - (run * i) / count;
      zs.push(z);
      ground.push(groundNear(B.x, z));
    }

    // The straight grade, which is the floor the profile is never below.
    const line = zs.map((_, i) => B.cityY + (B.islandY - B.cityY) * (i / count));
    const top = line.slice();
    const step = run / count;
    for (let i = 0; i <= count; i++) {
      const g = ground[i];
      if (g === null) continue;
      // Tapered at the ends, where the deck lands rather than crosses — and
      // tapered past zero to a slight sink, so the road wins at the joint. See
      // `BRIDGE.endSink`.
      const fromEnd = Math.min(i, count - i) * step;
      const t = Math.min(1, fromEnd / B.landing);
      const clear = -B.endSink + (B.clearance + B.endSink) * t;
      top[i] = Math.max(top[i], g + clear);
    }
    // The cone: two passes, each raising a sample to its neighbour's height less
    // what the grade allows. Only ever raises, so clearances survive it.
    for (let i = 1; i <= count; i++) top[i] = Math.max(top[i], top[i - 1] - B.maxGrade * step);
    for (let i = count - 1; i >= 0; i--) top[i] = Math.max(top[i], top[i + 1] - B.maxGrade * step);

    let arc = 0;
    const samples: Deck[] = [];
    for (let i = 0; i <= count; i++) {
      if (i > 0) arc += Math.hypot(step, top[i] - top[i - 1]);
      const g = ground[i];
      samples.push({
        x: B.x,
        z: zs[i],
        y: top[i],
        // The road runs along z, so its section is swept across world X.
        nx: 1,
        nz: 0,
        arc,
        ground: g,
      });
    }

    const crown = B.crownHalf;
    /**
     * The bank: a flat crown with a battered flank each side, down to a toe
     * just under the water.
     *
     * `rise` is measured from the sampled road height, so the flank gets deeper
     * and therefore wider as the causeway climbs — which is what an embankment
     * does, and what makes it read as ground rather than as a wall.
     */
    const drop = (s: Deck) => s.y - B.toe;
    const bankProfile: ProfileVertex<Deck>[] = [
      { off: (s) => -(crown + B.slope * drop(s)), rise: (s) => -drop(s) },
      { off: -crown, rise: 0 },
      { off: crown, rise: 0 },
      { off: (s) => crown + B.slope * drop(s), rise: (s) => -drop(s) },
    ];
    /** The carriageway, laid on the crown and standing a little proud of it. */
    const roadProfile: ProfileVertex<Deck>[] = [
      { off: -B.halfWidth, rise: B.surface },
      { off: B.halfWidth, rise: B.surface },
      { off: B.halfWidth, rise: 0 },
      { off: -B.halfWidth, rise: 0 },
    ];

    return {
      samples,
      length: arc,
      bank: buildLoft(samples, bankProfile, { vScale: 10 }),
      road: buildLoft(samples, roadProfile, { closed: true, vScale: 8 }),
      dashCount: Math.max(1, Math.floor(arc / (DASH + DASH_GAP))),
    };
  }, [bridge, city]);

  useEffect(() => {
    if (!built) return;
    return () => {
      built.bank.geometry.dispose();
      built.road.geometry.dispose();
    };
  }, [built]);

  /**
   * Tell the traffic where the road is.
   *
   * The causeway is the only way onto the island by road, and its height is
   * not something any config knows: it is the cone-filtered profile worked out
   * just above, from raycasts against whatever the city left standing. So the
   * samples are handed to `townNav`, which paints them into the patch the NPC
   * steering reads — without this the island's whole street network is an
   * island for the traffic as well, reachable only by the player.
   */
  useEffect(() => {
    if (!built) return;
    setCausewayDeck(built.samples.map((s) => ({ z: s.z, y: s.y })));
  }, [built]);

  useEffect(() => {
    const mesh = dashes.current;
    if (!mesh || !built || !bridge) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(bridge.laneWidth, 0.04, DASH);
    const pitch = built.length / built.dashCount;
    for (let i = 0; i < built.dashCount; i++) {
      // Walked along the deck's own arc length and looked up in the samples, so
      // the dashes sit on the road however it rises.
      const at = pitch * (i + 0.5);
      const k = Math.min(built.samples.length - 2,
        Math.max(0, built.samples.findIndex((s) => s.arc >= at) - 1));
      const a = built.samples[k];
      const b = built.samples[k + 1];
      const t = (at - a.arc) / Math.max(b.arc - a.arc, 1e-3);
      position.set(bridge.x, a.y + (b.y - a.y) * t + 0.02, a.z + (b.z - a.z) * t);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [built, bridge]);

  if (!bridge || !built) return null;

  return (
    <group>
      {/* The bank. Sand, like the railway's own causeways and the islands'
          beaches, so the three read as the same made ground. DoubleSide because
          the flanks are seen from the water side as well as from the road. */}
      <mesh geometry={built.bank.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#b3a37c" roughness={0.95} side={DoubleSide} />
      </mesh>
      {/* The carriageway on top of it. */}
      <mesh geometry={built.road.geometry} receiveShadow castShadow>
        <meshStandardMaterial color="#4a4b4d" roughness={0.95} />
      </mesh>

      <instancedMesh ref={dashes} args={[undefined, undefined, built.dashCount]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#d8d4c6" roughness={0.85} />
      </instancedMesh>

      {/* Solid, and a trimesh rather than boxes: the road is a ramp now, and a
          box collider cannot be a ramp. The bank is solid too, so a car that
          leaves the carriageway slides down it instead of falling through the
          world. Friction 1 on the road, because it is a road. */}
      <RigidBody type="fixed" colliders={false} friction={1}>
        {built.road.indices.length > 0 && (
          <TrimeshCollider args={[built.road.vertices, built.road.indices]} friction={1} />
        )}
        {built.bank.indices.length > 0 && (
          <TrimeshCollider args={[built.bank.vertices, built.bank.indices]} friction={0.9} />
        )}
      </RigidBody>
    </group>
  );
}
