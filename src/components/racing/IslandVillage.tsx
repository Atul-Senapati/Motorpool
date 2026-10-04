'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useGLTF } from '@react-three/drei';
import {
  AnimationMixer, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, DoubleSide, Euler, Group,
  IcosahedronGeometry, InstancedMesh, Material, Matrix4, Mesh, Object3D,
  Quaternion, RepeatWrapping, SRGBColorSpace, Vector3, type Texture,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { TRAIN } from '@/config/trainConfig';
import {
  RELIEF, VILLAGE, VILLAGE_BUILDINGS, VILLAGE_CARS, VILLAGE_CAR_KINDS, VILLAGE_FURNITURE,
  FAR_ROAD, VILLAGE_KIT, VILLAGE_PASTURE, VILLAGE_ROAD, VILLAGE_ROCKS, VILLAGE_SITE, VILLAGE_TREES, facingTurn, harbourInner, roadSpur,
  harbourOuter, villageGround, villagePoint, villageRelief, villageShore, type VillageKitPart,
} from '@/config/villageConfig';
import { InstancedField } from './instancedField';
import { ParkedCars } from './parkedCars';
import { BOAT_MODEL } from '@/config/boatConfig';
import COUNTRY_MODELS from '@/config/countryModelData.json';

const COUNTRY_LIFE = COUNTRY_MODELS.life;
import { ROAD_REPEAT } from '@/config/roadConfig';
import { buildLoft, type LoftSample } from './railGeometry';

/**
 * Gannet Harbour — see `villageConfig` for the theme and the layout.
 *
 * Everything is drawn inside one group at the frame's origin, turned by the
 * line's heading, so a point is just (across, y, along): across signed, the
 * village's side being `hand`. Everything is reused: the houses and church
 * are Skylark's (the city's own), the boats the game's, the lane the road
 * kit's surface, the trees and lamps the park kit's.
 *
 * ## No colliders
 *
 * Nothing can drive here: the road bridge goes to the other island, and the
 * railway passes through the middle 16 m clear of everything built.
 */

const PARK_MODEL = '/models/park.glb';
/** Skylark's kit — the city's houses and the church — and the road kit. */
const COUNTRY_KIT = '/models/country.glb';
const ROAD_MODEL = '/models/roads.glb';
useGLTF.preload(COUNTRY_KIT, DRACO_PATH);
useGLTF.preload(ROAD_MODEL, DRACO_PATH);
useGLTF.preload(PARK_MODEL, DRACO_PATH);

/** The setts' surface height over the island crown. */
const PAVE = 0.05;

/**
 * Granite setts: small grey-buff blocks in courses, a few lighter and darker,
 * with dark joints. Drawn once on a canvas and repeated over the paving in
 * world metres, so a sett is the same size everywhere.
 */
function makeSettTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3e3b36';
  ctx.fillRect(0, 0, 256, 256);
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const rows = 8;
  const h = 256 / rows;
  for (let r = 0; r < rows; r++) {
    const w = 256 / 6;
    const offset = r % 2 ? w / 2 : 0;
    for (let c = -1; c < 7; c++) {
      // Weathered granite: grey with a warm cast, no two setts alike.
      const tone = 96 + Math.floor(rnd() * 40);
      const warm = Math.floor(rnd() * 10);
      ctx.fillStyle = `rgb(${tone + warm},${tone - 2},${tone - 10})`;
      ctx.fillRect(c * w + offset + 2, r * h + 2, w - 4, h - 4);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Metres per repeat of the sett texture: six setts of 0.33 m a course. */
const SETT_REPEAT = 2;

/**
 * The harbour square, as one flat mesh of setts.
 *
 * The front is cut to the shore: sampled every few metres along it, from its
 * landward edge (`harbourInner`, which steps back to make the square) out to
 * the stone edge just inside the outline. A step in the inner edge gets two
 * samples a hair apart, so it comes out as a square corner rather than a
 * wedge.
 */
function buildPaving(hand: 1 | -1) {
  const H = VILLAGE.harbour;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    const base = positions.length / 3;
    for (const [across, along] of [a, b, c, d]) {
      positions.push(across * hand, PAVE, along);
      uvs.push(across / SETT_REPEAT, along / SETT_REPEAT);
    }
    // Wound for +Y whichever hand the village is on.
    if (hand > 0) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const stops = new Set<number>();
  for (let a = H.from; a <= H.to; a += H.step) stops.add(a);
  for (const edge of [H.squareFrom, H.squareTo]) { stops.add(edge - 0.01); stops.add(edge + 0.01); }
  stops.add(H.to);
  const along = [...stops].sort((x, y) => x - y);
  for (let i = 0; i < along.length - 1; i++) {
    const a0 = along[i];
    const a1 = along[i + 1];
    const i0 = harbourInner(a0) ?? 0;
    const i1 = harbourInner(a1) ?? 0;
    quad([i0, a0], [harbourOuter(a0), a0], [harbourOuter(a1), a1], [i1, a1]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** The jetty: a timber deck on piles out past the square, with mooring posts. */
function Jetty() {
  const site = VILLAGE_SITE;
  const Q = VILLAGE.quay;
  if (!site) return null;
  const hand = site.hand;
  const shore = villageShore(Q.along);
  const from = harbourOuter(Q.along) - Q.inland;
  const to = shore + Q.overWater;
  const length = to - from;
  const centre = (from + to) / 2;
  const deckTop = site.ground + Q.deckRise;
  const piles = Math.max(2, Math.floor(length / Q.pileSpacing));
  return (
    <group>
      <mesh position={[centre * hand, deckTop, Q.along]} castShadow receiveShadow>
        <boxGeometry args={[length, 0.24, Q.width]} />
        <meshStandardMaterial color="#7c6a55" roughness={0.95} />
      </mesh>
      {Array.from({ length: piles }, (_, i) => {
        const at = (from + Q.pileSpacing * (i + 0.5)) * hand;
        const foot = TRAIN.seaLevel - 1.2;
        const height = deckTop - foot;
        return [-1, 1].map((side) => (
          <mesh key={`${i}:${side}`} position={[at, foot + height / 2, Q.along + side * (Q.width / 2 - Q.pile)]} castShadow>
            <boxGeometry args={[Q.pile, height, Q.pile]} />
            <meshStandardMaterial color="#5f5142" roughness={0.95} />
          </mesh>
        ));
      })}
      {[0.55, 0.8, 1].map((t, i) => (
        <mesh key={`m${i}`} position={[(from + length * t - 0.4) * hand, deckTop + 0.45, Q.along + (i % 2 ? -1 : 1) * (Q.width / 2 - 0.25)]} castShadow>
          <cylinderGeometry args={[0.13, 0.15, 0.7, 8]} />
          <meshStandardMaterial color="#3f4348" roughness={0.7} metalness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Boats at the jetty: the game's own hulls out of `boats.glb`, cloned and
 * bobbing on the swell, the way Skylark's cove keeps its moorings.
 */
function Moorings() {
  const site = VILLAGE_SITE;
  const { scene } = useGLTF(BOAT_MODEL, DRACO_PATH);
  const group = useRef<Group>(null);
  const boats = useMemo(() => {
    if (!site) return [];
    const Q = VILLAGE.quay;
    const shore = villageShore(Q.along);
    const spots: Array<[string, number, number, number]> = [
      // id, how far out past the shore, which side of the jetty, extra turn
      ['tug', Q.overWater * 0.7, 1, 0.1],
      ['sail', Q.overWater * 0.45, -1, -0.2],
      ['cruiser', Q.overWater + 9, -1, 0.5],
    ];
    return spots.map(([id, out, side, turn], i) => {
      const source = (scene as unknown as Object3D).getObjectByName(id);
      if (!source) return null;
      const object = source.clone(true);
      object.traverse((child) => {
        if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      return {
        object,
        across: (shore + out) * site.hand,
        along: Q.along + side * (Q.width / 2 + 3.2),
        turn: Math.PI / 2 * site.hand + turn,
        phase: i * 1.9,
      };
    }).filter((b): b is NonNullable<typeof b> => b !== null);
  }, [scene, site]);
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    g.children.forEach((child, i) => {
      const boat = boats[i];
      if (!boat) return;
      child.position.y = TRAIN.seaLevel + 0.12 + Math.sin(t * 0.9 + boat.phase) * 0.08;
      child.rotation.z = Math.sin(t * 0.7 + boat.phase) * 0.025;
      child.rotation.x = Math.sin(t * 1.1 + boat.phase * 2) * 0.015;
    });
  });
  return (
    <group ref={group}>
      {boats.map((b, i) => (
        <primitive key={i} object={b.object} position={[b.across, TRAIN.seaLevel, b.along]} rotation={[0, b.turn, 0]} />
      ))}
    </group>
  );
}

/**
 * The lane, swept along its centreline in the city road kit's own surface —
 * the same trick as Kestrel's bends and crescent, at a village's width — and
 * the spur down to the square as a short straight sweep.
 */
function Lane({ surface }: { surface: Material | undefined }) {
  const site = VILLAGE_SITE;
  const geometry = useMemo(() => {
    if (!site) return null;
    const hand = site.hand;
    const sweep = (
      pts: ReadonlyArray<readonly [number, number]>,
      lift: number | ((across: number) => number),
      width: number = VILLAGE.road.width,
    ) => {
      const samples: LoftSample[] = [];
      let arc = 0;
      for (let k = 0; k < pts.length; k++) {
        const [along, across] = pts[k];
        const [pa, pc] = pts[Math.max(0, k - 1)];
        const [qa, qc] = pts[Math.min(pts.length - 1, k + 1)];
        const dx = (qc - pc) * hand;
        const dz = qa - pa;
        const len = Math.hypot(dx, dz) || 1;
        if (k > 0) arc += Math.hypot(across * hand - pts[k - 1][1] * hand, along - pts[k - 1][0]);
        const y = typeof lift === 'number' ? site.ground + lift : lift(across);
        samples.push({ x: across * hand, z: along, y, nx: -dz / len, nz: dx / len, arc });
      }
      const half = width / 2;
      const loft = buildLoft(samples, [{ off: half, rise: 0 }, { off: -half, rise: 0 }], { vScale: 8 });
      const uv = loft.geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (uv.getY(i) * 8) / (ROAD_REPEAT * 0.6), Math.min(1, Math.max(0, uv.getX(i))));
      }
      uv.needsUpdate = true;
      return loft.geometry;
    };
    const [sa, s0, s1] = roadSpur();
    const spur: Array<[number, number]> = [];
    for (let c = s0; c <= s1 + 1e-6; c += (s1 - s0) / 6) spur.push([sa, c]);
    const main = sweep(VILLAGE_ROAD, 0.07);
    const branch = sweep(spur, 0.08);
    const far = sweep(FAR_ROAD, 0.07, VILLAGE.farRoad.width);
    // A loft's normals face whichever way its winding says; the lanes are seen
    // from above only, so one material drawn double-sided covers either hand.
    return [main, branch, far];
  }, [site]);
  useEffect(() => () => geometry?.forEach((g) => g.dispose()), [geometry]);
  if (!geometry || !surface) return null;
  return (
    <>
      {geometry.map((g, i) => <mesh key={i} geometry={g} material={surface} receiveShadow />)}
    </>
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

/**
 * The village's houses and church: the city's own, out of the same
 * `country.glb` Skylark's are drawn from, cloned, turned and scaled.
 */
function Buildings({ kit }: { kit: Object3D }) {
  const site = VILLAGE_SITE;
  const placed = useMemo(() => VILLAGE_BUILDINGS.map((b) => {
    const node = kit.getObjectByName(b.part);
    if (!node) return null;
    const copy = node.clone(true);
    copy.position.set(0, 0, 0);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return { b, copy };
  }).filter((h): h is NonNullable<typeof h> => h !== null), [kit]);
  if (!site) return null;
  return (
    <>
      {placed.map(({ b, copy }) => (
        <group
          key={`${b.part}${b.along}`}
          position={[b.across * site.hand, site.ground, b.along]}
          rotation={[0, facingTurn(b.facing, site.hand), 0]}
          scale={b.scale}
        >
          <primitive object={copy} />
        </group>
      ))}
    </>
  );
}

/**
 * The country across the line: Skylark's windmill turning on the meadow, and
 * its sheep and horses grazing. Standing still — a grazing animal is head-down
 * for minutes at a time, and still costs nothing to keep in that pose.
 */
const WINDMILL_MODEL = '/models/country/windmill.glb';
const SHEEP_MODEL = '/models/country/sheep.glb';
const HORSE_MODEL = '/models/country/horse.glb';
for (const m of [WINDMILL_MODEL, SHEEP_MODEL, HORSE_MODEL]) useGLTF.preload(m, DRACO_PATH);

function Windmill() {
  const site = VILLAGE_SITE;
  const { scene, animations } = useGLTF(WINDMILL_MODEL, DRACO_PATH);
  const object = useMemo(() => {
    const copy = skeletonClone(scene);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; child.frustumCulled = false; }
    });
    return copy;
  }, [scene]);
  const mixer = useMemo(() => new AnimationMixer(object), [object]);
  useEffect(() => {
    const clip = animations.find((a) => a.name === COUNTRY_LIFE.windmill.clip) ?? animations[0];
    if (clip) mixer.clipAction(clip).play();
    return () => { mixer.stopAllAction(); };
  }, [mixer, animations]);
  useFrame((_, dt) => mixer.update(Math.min(0.05, dt)));
  const mill = VILLAGE_PASTURE.mill;
  if (!site || !mill) return null;
  return (
    <primitive
      object={object}
      position={[mill.across, villageGround(mill.along, mill.across), mill.along]}
      rotation={[0, mill.turn, 0]}
    />
  );
}

function Grazing({ model, at, scale }: {
  model: string;
  at: ReadonlyArray<{ along: number; across: number; turn: number }>;
  scale: number;
}) {
  const { scene } = useGLTF(model, DRACO_PATH);
  const animals = useMemo(() => at.map(() => {
    const copy = skeletonClone(scene);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return copy;
  }), [scene, at]);
  return (
    <>
      {animals.map((object, i) => (
        <primitive
          key={i}
          object={object}
          position={[at[i].across, villageGround(at[i].along, at[i].across), at[i].along]}
          rotation={[0, at[i].turn, 0]}
          scale={scale}
        />
      ))}
    </>
  );
}

/** One park-kit part, instanced at every place the village planted it. */
function Kit({ pairs, at, castShadow }: {
  pairs: Array<{ geometry: BufferGeometry; material: Material }> | undefined;
  at: ReadonlyArray<{ along: number; across: number; turn: number; scale: number; y: number }>;
  castShadow: boolean;
}) {
  const matrices = useMemo(() => {
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    return at.map((a) => {
      q.setFromAxisAngle(up, a.turn);
      return new Matrix4().compose(new Vector3(a.across, a.y, a.along), q.clone(), new Vector3().setScalar(a.scale));
    });
  }, [at]);
  if (!pairs?.length || !matrices.length) return null;
  return (
    <>
      {pairs.map((pair, i) => (
        <InstancedField key={i} matrices={matrices} geometry={pair.geometry} material={pair.material} castShadow={castShadow} />
      ))}
    </>
  );
}

export function IslandVillage() {
  const site = VILLAGE_SITE;
  const { scene: park } = useGLTF(PARK_MODEL, DRACO_PATH);
  const { scene: countryKit } = useGLTF(COUNTRY_KIT, DRACO_PATH);
  const { scene: roads } = useGLTF(ROAD_MODEL, DRACO_PATH);
  /** The road kit's surface, cloned so the lane can wrap it — see `KestrelRoads`. */
  const roadSurface = useMemo(() => {
    let found: Material | undefined;
    (roads as unknown as Object3D).getObjectByName('straight2')?.traverse((child) => {
      if (!found && child instanceof Mesh) found = child.material as Material;
    });
    if (!found) return undefined;
    const clone = found.clone() as Material & { map?: Texture | null };
    const map = (found as Material & { map?: Texture | null }).map;
    if (map) {
      const tex = map.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      clone.map = tex;
    }
    clone.side = DoubleSide;
    return clone;
  }, [roads]);

  const kit = useMemo(() => {
    const out = new Map<VillageKitPart, Array<{ geometry: BufferGeometry; material: Material }>>();
    for (const name of VILLAGE_KIT) {
      const node = (park as unknown as Object3D).getObjectByName(name);
      if (!node) continue;
      const pairs: Array<{ geometry: BufferGeometry; material: Material }> = [];
      node.traverse((child) => {
        if (child instanceof Mesh) pairs.push({ geometry: child.geometry, material: child.material as Material });
      });
      if (pairs.length) out.set(name, pairs);
    }
    return out;
  }, [park]);

  /** Every tree and piece of furniture, grouped by part, with its height. */
  const placed = useMemo(() => {
    const by = new Map<VillageKitPart, Array<{ along: number; across: number; turn: number; scale: number; y: number }>>();
    if (!site) return by;
    for (const t of VILLAGE_TREES) {
      const list = by.get(t.part) ?? [];
      list.push({ ...t, y: villageGround(t.along, t.across) });
      by.set(t.part, list);
    }
    for (const f of VILLAGE_FURNITURE) {
      const list = by.get(f.part) ?? [];
      list.push({ ...f, y: site.ground + PAVE });
      by.set(f.part, list);
    }
    return by;
  }, [site]);

  const paving = useMemo(() => (site ? buildPaving(site.hand) : null), [site]);
  const setts = useMemo(() => makeSettTexture(), []);
  useEffect(() => () => { paving?.dispose(); setts.dispose(); }, [paving, setts]);

  if (!site || !paving) return null;
  const [ox, , oz] = villagePoint(0, 0);

  return (
    <group>
      {/* World-space pieces: the ground and everything that samples it. */}
      <Relief />
      <Rocks />
      <Beacon />

      {/* Everything else in the village's own frame. */}
      <group position={[ox, 0, oz]} rotation={[0, site.heading, 0]}>
        <mesh geometry={paving} position={[0, site.ground, 0]} receiveShadow>
          <meshStandardMaterial map={setts} roughness={0.92} />
        </mesh>
        <Buildings kit={countryKit as unknown as Object3D} />
        <Lane surface={roadSurface} />
        {VILLAGE_KIT.map((part) => (
          <Kit key={part} pairs={kit.get(part)} at={placed.get(part) ?? []} castShadow={part !== 'bin' && part !== 'bush' && part !== 'bushLow' && part !== 'planter'} />
        ))}
        <ParkedCars slots={VILLAGE_CARS} kinds={VILLAGE_CAR_KINDS} y={site.ground + PAVE} />
        <Jetty />
        <Moorings />
        <Windmill />
        <Grazing model={SHEEP_MODEL} at={VILLAGE_PASTURE.sheep} scale={COUNTRY_LIFE.sheep.scale} />
        <Grazing model={HORSE_MODEL} at={VILLAGE_PASTURE.horses} scale={COUNTRY_LIFE.horse.scale} />
      </group>
    </group>
  );
}
