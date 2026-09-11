'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import {
  BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Euler, ExtrudeGeometry,
  IcosahedronGeometry, InstancedMesh, Material, Matrix4, Mesh, Object3D, Quaternion,
  SRGBColorSpace, Shape, Vector3,
} from 'three';
import { CITY_MODEL, DRACO_PATH } from '@/config/cityConfig';
import { TRAIN } from '@/config/trainConfig';
import {
  RELIEF, VILLAGE, VILLAGE_BUILDINGS, VILLAGE_COPSES, VILLAGE_COPSE_PART, VILLAGE_PROPS,
  VILLAGE_PROP_PART, VILLAGE_ROCKS, VILLAGE_SITE, VILLAGE_TREES, VILLAGE_TREE_PART,
  villageGround, villagePoint, villageRelief, villageShore, type Placement,
} from '@/config/villageConfig';

/**
 * The hamlet on the smaller island: two rows of cottages, a lane, a quay and a
 * halt.
 *
 * The buildings and the trees are the city's own meshes, drawn a second time
 * out at sea — see `villageConfig` for which chunks and why those. This file
 * places them, and builds the four things the city has none of: the lane, the
 * dry-stone walls, the quay with its boats, and the halt.
 *
 * ## What a transplant costs
 *
 * Nothing but a matrix. `prepare-map.mjs` merges the city into chunks of
 * (material, 250 m cell) with every node transform baked into the vertices, so
 * a chunk is a plain world-space mesh sharing one material: drawing it again
 * somewhere else is one draw call against geometry and textures that are
 * already resident. Nine cottages therefore cost 276 triangles and one call,
 * and the same row laid twice costs a second call and nothing else.
 *
 * The consequence to keep in mind is that the geometry is in *city* coordinates.
 * Every placement is therefore a group at the target, holding an inner group
 * that shifts the chunk back by its own centre — which is exactly what the
 * station's town does, and the reason both need the chunk's bounding box before
 * they can place it.
 *
 * ## No colliders
 *
 * Deliberately none, on the transplants or on anything else here. The island is
 * reached only by rail — the road bridge goes to the *other* island — so the
 * only vehicle that can arrive is on rails that pass 14 m clear of the nearest
 * wall. The town has colliders because a car can drive into it; nothing can
 * drive into this.
 */

const SLEEPER_BOTTOM = -(TRAIN.railHeight + TRAIN.sleeperHeight);

/**
 * One city chunk, ready to be placed: its geometry, its material, and the
 * offset that brings its own centre to the origin.
 *
 * The offset stands it on its own lowest point rather than centring it in Y,
 * so a building placed at the island's crown has its footings at the crown
 * instead of half-buried or hovering.
 */
interface Part {
  geometry: BufferGeometry;
  material: Material | Material[];
  offset: [number, number, number];
  /** Footprint, for anything that has to reason about where it reaches. */
  size: [number, number];
}

function collectParts(scene: Object3D | null, names: Iterable<string>): Map<string, Part> {
  const wanted = new Set(names);
  const found = new Map<string, Part>();
  if (!scene) return found;
  scene.traverse((object) => {
    if (!(object instanceof Mesh) || !wanted.has(object.name) || found.has(object.name)) return;
    const geometry = object.geometry as BufferGeometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return;
    found.set(object.name, {
      geometry,
      material: object.material,
      offset: [-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2],
      size: [box.max.x - box.min.x, box.max.z - box.min.z],
    });
  });
  return found;
}

/** A boat's plan, extruded downward into a hull: pointed at the bow, square at the stern. */
function hullGeometry(length: number, beam: number, depth: number) {
  const shape = new Shape();
  shape.moveTo(0, length / 2);
  shape.lineTo(beam / 2, length / 6);
  shape.lineTo(beam / 2, -length / 2);
  shape.lineTo(-beam / 2, -length / 2);
  shape.lineTo(-beam / 2, length / 6);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // Built in plan (XY) and extruded in Z, so it has to be laid flat.
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** The halt's name board: the island's name, white on green. */
function makeBoardTexture(name: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1d4632';
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = '#f2efe6';
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, 492, 108);
  ctx.fillStyle = '#f2efe6';
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 256, 68);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** One transplanted chunk, at its place in the village. */
function Transplant({ part, at }: { part: Part; at: Placement }) {
  const site = VILLAGE_SITE;
  if (!site) return null;
  const [x, , z] = villagePoint(at.along, at.across * site.hand);
  return (
    <group position={[x, site.ground, z]} rotation={[0, site.heading + at.turn, 0]}>
      <group position={part.offset}>
        <mesh geometry={part.geometry} material={part.material} castShadow receiveShadow />
      </group>
    </group>
  );
}

/**
 * Many placements of one chunk, in a single draw call.
 *
 * Instanced rather than repeated as meshes because the trees are the one thing
 * here there are dozens of. The matrix has to carry the recentring offset as
 * well as the placement, which is why it is composed and then multiplied rather
 * than composed in one go: the offset is in the chunk's own space and has to be
 * applied *before* the rotation that turns it.
 */
function Scatter({
  part, places,
}: {
  part: Part;
  places: ReadonlyArray<{ along: number; across: number; turn: number; scale?: number }>;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const site = VILLAGE_SITE;
  const count = places.length;

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !site) return;
    const matrix = new Matrix4();
    const recentre = new Matrix4().makeTranslation(...part.offset);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3();
    places.forEach((place, i) => {
      const [x, , z] = villagePoint(place.along, place.across);
      // On the ground, not on the crown: the island has relief now, and a tree
      // standing at the crown height on a knoll is a tree buried to its knees.
      position.set(x, villageGround(place.along, place.across), z);
      euler.set(0, site.heading + place.turn, 0);
      quaternion.setFromEuler(euler);
      scale.setScalar(place.scale ?? 1);
      matrix.compose(position, quaternion, scale);
      matrix.multiply(recentre);
      instanced.setMatrixAt(i, matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [part, places, site]);

  if (!count) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[part.geometry, part.material as Material, count]}
      castShadow
      receiveShadow
    />
  );
}

/**
 * The lane, and the footpath from the halt to it.
 *
 * Flat slabs a few centimetres over the island crown rather than a carved
 * surface: the island is dead level (`ISLAND_CROWN`), so a road on it is a
 * rectangle, and the only thing that has to be got right is that it is *not*
 * coplanar with the ground it sits on — see the station's paving.
 *
 * Not a city street chunk, though everything built on it is. A city street
 * brings its own kerbs, markings and 250 m of network, and a lane between nine
 * cottages on an island wants none of that.
 */
function Lane() {
  const site = VILLAGE_SITE;
  if (!site) return null;
  const across = VILLAGE.laneAcross * site.hand;
  const [x, , z] = villagePoint(0, 0);
  /** From the halt's back edge out to the lane's near kerb. */
  const from = (VILLAGE.halt.setback + VILLAGE.halt.width) * site.hand;
  const to = (VILLAGE.laneAcross - VILLAGE.laneWidth / 2) * site.hand;

  return (
    <group position={[x, site.ground + 0.03, z]} rotation={[0, site.heading, 0]}>
      <mesh position={[across, 0, VILLAGE.laneAlong]} receiveShadow>
        <boxGeometry args={[VILLAGE.laneWidth, 0.06, VILLAGE.laneHalfLength * 2]} />
        <meshStandardMaterial color="#8b8377" roughness={0.97} />
      </mesh>
      <mesh position={[(from + to) / 2, 0, 0]} receiveShadow>
        <boxGeometry args={[Math.abs(to - from), 0.05, VILLAGE.pathWidth]} />
        <meshStandardMaterial color="#93897a" roughness={0.97} />
      </mesh>
    </group>
  );
}

/**
 * The quay, and two boats tied up at it.
 *
 * Reaches out past the beach on piles, because that is the one structure that
 * makes an island read as *inhabited* rather than merely built on: a village
 * with no way to arrive by sea is a diorama. Its length is measured from the
 * shore the config found (`villageShore`), so it always ends over water however
 * the outline is redrawn.
 */
function Quay() {
  const site = VILLAGE_SITE;
  const Q = VILLAGE.quay;
  const hulls = useMemo(() => [hullGeometry(5.6, 2.0, 1.1), hullGeometry(4.4, 1.7, 0.95)], []);
  useEffect(() => () => hulls.forEach((h) => h.dispose()), [hulls]);
  if (!site) return null;

  const shore = villageShore(Q.along);
  const inland = 8;
  const length = inland + Q.overWater;
  const centre = (shore - inland / 2 + Q.overWater / 2) * site.hand;
  const [x, , z] = villagePoint(Q.along, 0);
  const deckTop = site.ground + Q.deckRise;
  const piles = Math.max(2, Math.floor(length / Q.pileSpacing));

  return (
    <group position={[x, 0, z]} rotation={[0, site.heading, 0]}>
      <mesh position={[centre, deckTop, 0]} castShadow receiveShadow>
        <boxGeometry args={[length, 0.28, Q.width]} />
        <meshStandardMaterial color="#7c6a55" roughness={0.95} />
      </mesh>
      {/* Piles, in pairs across the deck, sunk from the deck to below sea level
          so the ones out over the water stand in it rather than on it. */}
      {Array.from({ length: piles }, (_, i) => {
        const at = (shore - inland + Q.pileSpacing * (i + 0.5)) * site.hand;
        const foot = TRAIN.seaLevel - 1.2;
        const height = deckTop - foot;
        return [-1, 1].map((side) => (
          <mesh
            key={`${i}:${side}`}
            position={[at, foot + height / 2, side * (Q.width / 2 - Q.pile)]}
            castShadow
          >
            <boxGeometry args={[Q.pile, height, Q.pile]} />
            <meshStandardMaterial color="#5f5142" roughness={0.95} />
          </mesh>
        ));
      })}
      {[-1, 0, 1].map((i) => (
        <mesh
          key={`b${i}`}
          position={[centre + i * (length / 3), deckTop + 0.4, Q.width / 2 - 0.35]}
          castShadow
        >
          <boxGeometry args={[0.22, 0.6, 0.22]} />
          <meshStandardMaterial color="#3f4348" roughness={0.7} metalness={0.3} />
        </mesh>
      ))}

      {/* Two boats, moored on the seaward side. Sitting *in* the water: the
          hull is dropped so most of its depth is under sea level, which is the
          difference between a boat and a boat left on the grass. */}
      {hulls.map((hull, i) => {
        const at = (shore + Q.overWater * (i ? 0.35 : 0.7)) * site.hand;
        const offset = (i ? -1 : 1) * (Q.width / 2 + 2.4);
        return (
          <group
            key={i}
            position={[at, TRAIN.seaLevel + 0.42, offset]}
            rotation={[0, i ? 0.2 : -0.12, 0]}
          >
            <mesh geometry={hull} castShadow receiveShadow>
              <meshStandardMaterial
                color={i ? '#b8452f' : '#2f5d8a'} roughness={0.7} side={DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0.62, -0.4]} castShadow>
              <boxGeometry args={[1.1, 0.85, 1.6]} />
              <meshStandardMaterial color="#e2ded1" roughness={0.85} />
            </mesh>
            <mesh position={[0, 2.1, 0.4]} castShadow>
              <boxGeometry args={[0.12, 3.4, 0.12]} />
              <meshStandardMaterial color="#7d6a52" roughness={0.9} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/**
 * The island's relief: a grid laid over the flat crown.
 *
 * `TrainLine` draws both islands as a level crown at `ISLAND_CROWN` with a
 * beach ring outside it, which is what the route was graded to and what the
 * station stands on. Rather than change that — the big island's four-road
 * station and transplanted town both depend on it being flat — this lays a
 * second surface over the small one, two centimetres up, and lets
 * `villageRelief` decide how high it stands at each vertex.
 *
 * Where the mask is zero the patch is flush with the crown and invisible; where
 * it is not, the ground rolls. Everything else on the island samples the same
 * function, so a tree, a rock, a wall segment and the ground under them cannot
 * disagree.
 *
 * Vertex-coloured rather than textured: the grass wants to lighten on the tops
 * and darken in the hollows, which is a two-line calculation here and a
 * splat-map anywhere else.
 */
function Relief() {
  const site = VILLAGE_SITE;
  const built = useMemo(() => {
    if (!site) return null;
    const step = 4;
    const halfAlong = site.crossing / 2 + 30;
    const halfAcross = Math.max(site.reach.left, site.reach.right) + 4;
    const nAlong = Math.ceil((halfAlong * 2) / step);
    const nAcross = Math.ceil((halfAcross * 2) / step);
    const positions: number[] = [];
    const colours: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= nAlong; i++) {
      const along = -halfAlong + i * step;
      for (let j = 0; j <= nAcross; j++) {
        const across = -halfAcross + j * step;
        const [x, , z] = villagePoint(along, across);
        const rise = villageRelief(along, across);
        positions.push(x, site.ground + 0.02 + rise, z);
        // Lighter and drier on the tops, deeper green in the hollows.
        const t = rise / RELIEF.amplitude;
        colours.push(0.29 + t * 0.14, 0.41 + t * 0.10, 0.22 + t * 0.06);
      }
    }
    const row = nAcross + 1;
    for (let i = 0; i < nAlong; i++) {
      for (let j = 0; j < nAcross; j++) {
        const a = i * row + j;
        indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }, [site]);

  useEffect(() => () => built?.dispose(), [built]);
  if (!built) return null;
  return (
    <mesh geometry={built} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.95} />
    </mesh>
  );
}

/**
 * Rocks: one icosahedron, instanced, squashed and turned.
 *
 * Not a city mesh, because the city has no rock — and one low-poly sphere is
 * all a rock needs. What sells it is that no two instances share a matrix: each
 * is scaled unevenly, tipped a little off vertical and spun, so fifty-four
 * copies of twenty triangles read as fifty-four rocks. Sunk a fifth of their
 * height into the ground, which is what stops them looking dropped.
 */
function Rocks() {
  const mesh = useRef<InstancedMesh>(null);
  const site = VILLAGE_SITE;
  const count = VILLAGE_ROCKS.length;
  const geometry = useMemo(() => new IcosahedronGeometry(0.5, 0), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced || !site) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3();
    VILLAGE_ROCKS.forEach((rock, i) => {
      const [x, , z] = villagePoint(rock.along, rock.across);
      const height = rock.size * rock.squash;
      position.set(x, villageGround(rock.along, rock.across) + height * 0.3, z);
      euler.set(rock.tilt, site.heading + rock.turn, rock.tilt * 0.6);
      quaternion.setFromEuler(euler);
      scale.set(rock.size, height, rock.size * (0.7 + rock.squash * 0.5));
      instanced.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [count, site]);

  if (!count) return null;
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, count]} castShadow receiveShadow>
      <meshStandardMaterial color="#8a8781" roughness={0.96} flatShading />
    </instancedMesh>
  );
}

/**
 * The beacon on the seaward tip: a tapered tower, a gallery and a light.
 *
 * Sited by walking in from the measured shore, so it stands on land whatever
 * the outline does, and stood on `villageGround` like everything else — the tip
 * is outside the relief's mask, so in practice that is the crown.
 */
function Beacon() {
  const site = VILLAGE_SITE;
  if (!site) return null;
  const B = VILLAGE.beacon;
  const across = Math.max(6, villageShore(B.along) - B.inset) * site.hand;
  const [x, , z] = villagePoint(B.along, across);
  const base = villageGround(B.along, across);

  return (
    <group position={[x, base, z]} rotation={[0, site.heading, 0]}>
      {/* The tower. A cylinder with a smaller top radius is a lighthouse; a
          cylinder with the same radius is a chimney. */}
      <mesh position={[0, B.height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[B.topRadius, B.baseRadius, B.height, 12]} />
        <meshStandardMaterial color="#eae5da" roughness={0.9} />
      </mesh>
      {/* One red band, at the height every real one has it. */}
      <mesh position={[0, B.height * 0.62, 0]} castShadow>
        <cylinderGeometry args={[B.topRadius * 1.06, B.baseRadius * 0.94, B.height * 0.16, 12]} />
        <meshStandardMaterial color="#b23a2c" roughness={0.85} />
      </mesh>
      <mesh position={[0, B.height + B.galleryHeight / 2, 0]} castShadow>
        <cylinderGeometry args={[B.topRadius * 1.5, B.topRadius * 1.5, B.galleryHeight, 12]} />
        <meshStandardMaterial color="#3f4348" roughness={0.7} metalness={0.3} />
      </mesh>
      {/* The lamp room: unlit and self-coloured, like every other light in this
          world — a real one would be a shadow-casting point light in a scene
          that already has a sun. */}
      <mesh position={[0, B.height + B.galleryHeight + B.lampHeight / 2, 0]}>
        <cylinderGeometry args={[B.topRadius * 0.85, B.topRadius * 0.85, B.lampHeight, 10]} />
        <meshBasicMaterial color="#fff1c9" toneMapped={false} />
      </mesh>
      <mesh position={[0, B.height + B.galleryHeight + B.lampHeight + 0.2, 0]} castShadow>
        <coneGeometry args={[B.topRadius * 1.1, 0.7, 10]} />
        <meshStandardMaterial color="#33383d" roughness={0.7} metalness={0.3} />
      </mesh>
    </group>
  );
}

/** Upturned dinghies and stacks of pots along the tide line by the quay. */
function ShoreClutter() {
  const site = VILLAGE_SITE;
  const hull = useMemo(() => hullGeometry(3.6, 1.5, 0.75), []);
  useEffect(() => () => hull.dispose(), [hull]);
  if (!site) return null;

  return (
    <group>
      {Array.from({ length: VILLAGE.clutter.count }, (_, i) => {
        const along = VILLAGE.quay.along - 26 + i * 8;
        const across = Math.max(8, villageShore(along) - 6 - (i % 3) * 2.5) * site.hand;
        const [x, , z] = villagePoint(along, across);
        const y = villageGround(along, across);
        const boat = i % 3 === 0;
        return (
          <group
            key={i}
            position={[x, y, z]}
            rotation={[0, site.heading + (i * 1.7) % Math.PI, 0]}
          >
            {boat ? (
              // Upturned: rolled over so the hull is a dome on the shingle.
              <mesh geometry={hull} position={[0, 0.72, 0]} rotation={[Math.PI, 0, 0]} castShadow>
                <meshStandardMaterial color={i % 2 ? '#4a6b52' : '#7c4a3a'} roughness={0.85} side={DoubleSide} />
              </mesh>
            ) : (
              // A stack of pots: three boxes, each smaller and turned.
              [0, 1, 2].map((k) => (
                <mesh
                  key={k}
                  position={[0, 0.28 + k * 0.42, 0]}
                  rotation={[0, k * 0.5, 0]}
                  castShadow
                >
                  <boxGeometry args={[1.05 - k * 0.12, 0.4, 0.8 - k * 0.08]} />
                  <meshStandardMaterial color="#6d5a44" roughness={0.95} />
                </mesh>
              ))
            )}
          </group>
        );
      })}
    </group>
  );
}

/**
 * Dry-stone field walls, in segments that step over the ground.
 *
 * One run along the railway boundary and three more out in the open, dividing
 * the seaward end into paddocks. Each run is broken into two-metre segments,
 * each set on `villageGround` where it stands, so a wall crossing a knoll steps
 * up it — which is what a dry-stone wall does, and what one long box cannot:
 * over 3.4 m of relief a single box buries one end and leaves the other in the
 * air.
 *
 * Instanced, so four runs of stepped segments are two draw calls rather than a
 * hundred and forty.
 */
function Walls() {
  const stones = useRef<InstancedMesh>(null);
  const caps = useRef<InstancedMesh>(null);
  const site = VILLAGE_SITE;
  const W = VILLAGE.wall;

  /** Every segment of every run, as a point in the village's frame. */
  const segments = useMemo(() => {
    if (!site) return [];
    const runs = [
      { across: VILLAGE.laneAcross - VILLAGE.laneWidth / 2 - 2, half: VILLAGE.laneHalfLength },
      { across: 66, half: 46 },
      { across: 76, half: 26 },
      { across: 54, half: 88 },
    ];
    const out: Array<{ along: number; across: number }> = [];
    for (const { across, half } of runs) {
      for (let along = -half; along <= half; along += W.pitch) {
        // Only where the island still reaches this far out, and not across the
        // village's own frontage.
        if (villageShore(along) < across + 4) continue;
        if (across > 40 && Math.abs(along) < 8) continue;
        out.push({ along, across: across * site.hand });
      }
    }
    return out;
  }, [site, W.pitch]);

  useEffect(() => {
    const stone = stones.current;
    const cap = caps.current;
    if (!stone || !cap || !site) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler(0, site.heading, 0);
    quaternion.setFromEuler(euler);
    const scale = new Vector3();
    segments.forEach((seg, i) => {
      const [x, , z] = villagePoint(seg.along, seg.across);
      const ground = villageGround(seg.along, seg.across);
      position.set(x, ground + W.height / 2, z);
      scale.set(W.thickness, W.height, W.pitch);
      stone.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      position.set(x, ground + W.height + 0.05, z);
      scale.set(W.thickness + 0.14, 0.1, W.pitch);
      cap.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    stone.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate = true;
    stone.computeBoundingSphere();
    cap.computeBoundingSphere();
  }, [segments, site, W]);

  if (!site || !segments.length) return null;
  return (
    <>
      <instancedMesh
        ref={stones}
        args={[undefined, undefined, segments.length]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#9c9384" roughness={0.97} />
      </instancedMesh>
      <instancedMesh ref={caps} args={[undefined, undefined, segments.length]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#b1a795" roughness={0.95} />
      </instancedMesh>
    </>
  );
}

/**
 * The halt: a short low platform, a shelter, a nameboard and one lamp.
 *
 * Half a metre over the rail rather than the station's 915 mm, and thirty
 * metres long rather than a hundred and seventy. Both figures are the point:
 * what tells you this is a halt and not a station is that the train is longer
 * than the platform.
 */
function Halt({ board }: { board: CanvasTexture }) {
  const site = VILLAGE_SITE;
  if (!site) return null;
  const H = VILLAGE.halt;
  const railHead = site.railHead;
  const top = railHead + H.rise;
  const height = top - site.ground;
  const centre = (H.setback + H.width / 2) * site.hand;
  const [x, , z] = villagePoint(0, 0);
  /** The face is the edge nearest the track. */
  const face = H.setback * site.hand;

  return (
    <group position={[x, 0, z]} rotation={[0, site.heading, 0]}>
      <mesh position={[centre, site.ground + height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[H.width, height, H.length]} />
        <meshStandardMaterial color="#a09a90" roughness={0.94} />
      </mesh>
      {/* Coping and the yellow line, as the station has them — the same
          markings, because it is the same railway. */}
      <mesh position={[face + 0.375 * site.hand, top + 0.015, 0]} receiveShadow>
        <boxGeometry args={[0.75, 0.03, H.length]} />
        <meshStandardMaterial color="#cfc9bd" roughness={0.85} />
      </mesh>
      <mesh position={[face + 1.05 * site.hand, top + 0.02, 0]} receiveShadow>
        <boxGeometry args={[0.4, 0.02, H.length]} />
        <meshStandardMaterial color="#e8b52a" roughness={0.8} />
      </mesh>
      {[-1, 1].map((end) => (
        <mesh
          key={end}
          position={[centre, top - height / 4, end * (H.length / 2 + H.rampLength / 2)]}
          rotation={[end * Math.atan2(height, H.rampLength * 2), 0, 0]}
          receiveShadow
        >
          <boxGeometry args={[H.width, 0.24, Math.hypot(H.rampLength, height / 2) * 2]} />
          <meshStandardMaterial color="#948e85" roughness={0.95} />
        </mesh>
      ))}

      {/* The shelter: three walls, a bench and a lid, open toward the track so
          you can see the train coming — which is what a halt shelter is for. */}
      <group position={[centre + 0.35 * site.hand, top, -4]}>
        <mesh
          position={[-0.35 * site.hand * (H.shelter[0] / 2), H.shelterHeight / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.12, H.shelterHeight, H.shelter[1]]} />
          <meshStandardMaterial color="#d8d2c4" roughness={0.9} />
        </mesh>
        {[-1, 1].map((end) => (
          <mesh
            key={end}
            position={[0, H.shelterHeight / 2, end * (H.shelter[1] / 2)]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[H.shelter[0], H.shelterHeight, 0.12]} />
            <meshStandardMaterial color="#d8d2c4" roughness={0.9} />
          </mesh>
        ))}
        <mesh position={[0, H.shelterHeight + 0.1, 0]} castShadow>
          <boxGeometry args={[H.shelter[0] + 0.5, 0.18, H.shelter[1] + 0.5]} />
          <meshStandardMaterial color="#4a4a4e" roughness={0.85} />
        </mesh>
        <mesh position={[-0.2 * site.hand, 0.45, 0]} castShadow>
          <boxGeometry args={[0.5, 0.08, H.shelter[1] - 0.5]} />
          <meshStandardMaterial color="#6b4b32" roughness={0.9} />
        </mesh>
      </group>

      {/* The nameboard, facing the train, and a lamp. */}
      <group position={[centre, top, 7]}>
        {[-1, 1].map((post) => (
          <mesh key={post} position={[0, H.boardHeight / 2, post * 0.9]} castShadow>
            <boxGeometry args={[0.08, H.boardHeight, 0.08]} />
            <meshStandardMaterial color="#4f5761" roughness={0.6} metalness={0.35} />
          </mesh>
        ))}
        <mesh position={[0, H.boardHeight, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
          <boxGeometry args={[2.4, 0.56, 0.05]} />
          <meshStandardMaterial map={board} roughness={0.8} side={DoubleSide} />
        </mesh>
      </group>
      <group position={[centre, top, -12]}>
        <mesh position={[0, H.lampHeight / 2, 0]} castShadow>
          <boxGeometry args={[0.12, H.lampHeight, 0.12]} />
          <meshStandardMaterial color="#4f5761" roughness={0.6} metalness={0.35} />
        </mesh>
        <mesh position={[0, H.lampHeight, 0]}>
          <boxGeometry args={[0.5, 0.12, 0.36]} />
          <meshBasicMaterial color="#fff2cf" toneMapped={false} />
        </mesh>
      </group>

      {/* A foot crossing over the ballast, level with the sleeper tops: the
          only way off the island is the train, so the path has to cross the
          line to reach the far side. */}
      <mesh position={[0, railHead + SLEEPER_BOTTOM + 0.09, H.length / 2 + 8]} receiveShadow>
        <boxGeometry args={[TRAIN.ballastCrownHalf * 2 + 6, 0.18, VILLAGE.pathWidth]} />
        <meshStandardMaterial color="#8b8377" roughness={0.96} />
      </mesh>
    </group>
  );
}

export function IslandVillage() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);
  const site = VILLAGE_SITE;

  const parts = useMemo(() => collectParts(scene, [
    ...VILLAGE_BUILDINGS.map((b) => b.part),
    VILLAGE_TREE_PART, VILLAGE_COPSE_PART, VILLAGE_PROP_PART,
  ]), [scene]);

  const board = useMemo(() => (site ? makeBoardTexture(site.name) : null), [site]);
  useEffect(() => () => board?.dispose(), [board]);

  if (!site || !board) return null;

  const tree = parts.get(VILLAGE_TREE_PART);
  const copse = parts.get(VILLAGE_COPSE_PART);
  const prop = parts.get(VILLAGE_PROP_PART);

  return (
    <group>
      {/* The ground first: everything below stands on it. */}
      <Relief />
      <Lane />
      <Walls />
      <Rocks />
      {/* The cottage rows and the building at the head of the lane. A chunk
          that is missing — a map prepared from a different source, say — simply
          is not drawn, rather than throwing. */}
      {VILLAGE_BUILDINGS.map((at, i) => {
        const part = parts.get(at.part);
        return part ? <Transplant key={i} part={part} at={at} /> : null;
      })}
      {tree && <Scatter part={tree} places={VILLAGE_TREES} />}
      {copse && <Scatter part={copse} places={VILLAGE_COPSES} />}
      {prop && <Scatter part={prop} places={VILLAGE_PROPS} />}
      <Quay />
      <ShoreClutter />
      <Beacon />
      <Halt board={board} />
    </group>
  );
}
