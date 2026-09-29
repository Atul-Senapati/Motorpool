'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import {
  CanvasTexture, ClampToEdgeWrapping, DoubleSide, ExtrudeGeometry, InstancedMesh, Matrix4,
  Mesh, Quaternion, RepeatWrapping, Shape, SRGBColorSpace, Vector3,
  type Material, type Texture,
} from 'three';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { BRIDGE } from '@/config/stationConfig';
import { ROAD_PAVEMENT, ROAD_REPEAT } from '@/config/roadConfig';
import { DRACO_PATH } from '@/config/cityConfig';
import { setCausewayDeck } from '@/physics/townNav';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * The road viaduct out to Kestrel.
 *
 * A masonry arch bridge: nine openings on eight piers, humped over a 48 m
 * navigation arch in the middle, with the sea running straight through it.
 *
 * ## Why it is not the causeway any more
 *
 * It was a reclaimed bank with the road on its crown, and for the 130 m hop
 * that used to be here that was right — a bank reads as ground, and the
 * railway builds its own crossings to these islands the same way. Then the
 * island was trimmed back 106 m (`ISLAND_TRIM`) and the crossing became 226 m,
 * at which point the bank stopped being a crossing and started being a dam:
 * ground is opaque, and nothing sails through it. What the span wants is a
 * structure, and what you can see under a structure is the whole point of
 * building one.
 *
 * ## How the arches are built
 *
 * Not as nine separate arches. The masonry is **one extruded elevation** — a
 * `Shape` drawn in the (along, height) plane, from the seabed up to the deck
 * soffit, with an arch-shaped `Path` hole punched through it for every
 * opening, extruded across the bridge's width. Piers, spandrels, abutments and
 * the arch rings themselves are not modelled: they are what is left of the
 * block once the holes are taken out of it, which is also what they are in a
 * real viaduct.
 *
 * One consequence worth knowing: the shape is drawn with x = along and
 * y = height, and the extrusion runs along its own +Z. The group therefore
 * carries a quarter turn about Y, which sends the shape's +X to world −Z (the
 * run, city to island) and its +Z to world +X (the width).
 *
 * ## The hump
 *
 * A **raised sine**, `sin²(πt)`, over the straight grade between the two
 * landings. Raised rather than a plain half-sine because `sin²` has zero
 * derivative at both ends: a plain one arrives at the city street already
 * climbing at 11 %, which is a step you can feel at the joint. This one leaves
 * both ends at the straight grade's own 1.4 % and puts its steepest 8.2 % at
 * the quarter points, out over the water where nobody is parking.
 *
 * ## The deck
 *
 * Swept with `buildLoft` over the same samples, and surfaced with the modular
 * road kit's own material rather than a painted slab — see `useRoadSurface`,
 * which is `AirportBridge`'s, and the UV swap under `road`, which is also its.
 * Two bridges wanting a kit road on a curved deck is two bridges, not two
 * techniques.
 */

/** Dashes down the centre line, in metres: mark, then gap. */
const DASH = 3.2;
const DASH_GAP = 3.4;

/**
 * Masonry, and the colour is the material's rather than the texture's.
 *
 * It was a warm tan over a mid-grey texture, and both halves of that were
 * wrong. `meshStandardMaterial` *multiplies* the map by the colour, so a map
 * averaging mid-grey halves whatever colour you give it — the wall came out
 * both muddier and browner than either number reads. The map is near-white
 * now (see `makeStone`) and does nothing but modulate, which leaves this the
 * only place the stone's colour is set. Weathered grey granite, very slightly
 * warm, and deliberately a step darker than the island's own concrete sea wall
 * (`#9a9791`) so the two do not read as the same material.
 */
const STONE = '#86857e';
/** The coping along the parapet tops, a shade lighter as dressed stone is. */
const COPING = '#97968e';
/** Metres of wall one tile of the stone texture covers. */
const STONE_TILE = 6;

/**
 * Coursed rubble, drawn rather than downloaded — and drawn *faintly*.
 *
 * A flat colour reads as concrete however warm it is: what makes stone read as
 * stone is the coursing. But the first cut of this drew the coursing at full
 * contrast — mortar two shades off black, blocks varying ±23, a lit and a
 * shaded edge on every one and five thousand speckles over the top — and 226 m
 * of that is not a wall, it is a pattern. Everything here is now a **near-white
 * modulation**: the map averages about 0.88, so it tints the material by a few
 * percent either way and the colour above does the rest. Coursing you notice
 * when you look for it and not before, which is what coursing does at fifty
 * metres.
 *
 * Drawn on a canvas for the same reason `IslandTown` draws its tarmac, its deck
 * panels and its paving: a few hundred bytes of code against an asset to
 * download, prepare, ship and keep in step with the colour above.
 *
 * Four courses to a tile and six blocks to a course, so at `STONE_TILE` a block
 * is about 1 m by 1.5 m — squared rubble, which is what a nineteenth-century
 * road viaduct is built of. Alternate courses are staggered half a block.
 */
function makeStone(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const courses = 4;
  const blocks = 6;
  const h = size / courses;
  const w = size / blocks;
  // The mortar: everything is drawn on top of it, so the joints are simply
  // where it still shows. Two shades under the blocks, not twenty.
  ctx.fillStyle = 'rgb(205,204,201)';
  ctx.fillRect(0, 0, size, size);

  // Deterministic, because a texture that changes every reload is a texture
  // nobody can judge a colour against.
  let seed = 9781;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const joint = 2.5;
  for (let row = 0; row < courses; row++) {
    // Half-block stagger on alternate courses, wrapped so the tile still meets
    // itself at the seam.
    const shift = (row % 2) * (w / 2);
    for (let col = -1; col <= blocks; col++) {
      const x = col * w + shift;
      const y = row * h;
      const tone = 226 + Math.round(rand() * 14 - 7);
      ctx.fillStyle = `rgb(${tone}, ${tone - 1}, ${tone - 3})`;
      ctx.fillRect(x + joint / 2, y + joint / 2, w - joint, h - joint);
      // A lit top edge and a shaded bottom one: the blocks are not flush, and
      // two faint lines is the whole of the relief they need at this size.
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x + joint / 2, y + joint / 2, w - joint, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.05)';
      ctx.fillRect(x + joint / 2, y + h - joint / 2 - 2, w - joint, 2);
    }
  }

  // A light speckle, so no two square metres are quite identical.
  for (let i = 0; i < 1200; i++) {
    const g = rand();
    ctx.fillStyle = g > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.035)';
    ctx.fillRect(rand() * size, rand() * size, 2, 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  // `ExtrudeGeometry`'s own UV generator lays the shape's coordinates down as
  // UVs unchanged, and this shape is drawn in metres — so one unit of UV is one
  // metre of wall and the repeat is simply the tile size inverted. The lofted
  // parapets get the same treatment through their own vScale.
  texture.repeat.set(1 / STONE_TILE, 1 / STONE_TILE);
  texture.anisotropy = 4;
  return texture;
}

interface Deck extends LoftSample {
  /** Height of the deck's top surface here. */
  top: number;
}

/**
 * The road kit's surface material, cloned so this deck can wrap it.
 *
 * `AirportBridge`'s, verbatim in intent: the kit's own texture is what makes a
 * bridge deck read as the same road as the streets either end of it, and the
 * clone is because the UVs here run to many repeats along a 226 m span while
 * the island's own straights want one repeat a piece.
 */
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

/** One opening in the elevation, in along-coordinates from the city end. */
interface Opening { from: number; to: number }

/**
 * Where the openings go: the navigation arch in the middle, then side arches
 * marching outward from it until they run out of viaduct.
 *
 * Laid out from the centre rather than from the ends, because the one span
 * whose position matters is the main one — it has to be over the middle of the
 * channel — and a layout that starts at an abutment puts whatever rounding is
 * left over right there.
 */
function layOpenings(run: number): Opening[] {
  const A = BRIDGE!.arch;
  const mid = run / 2;
  const out: Opening[] = [
    { from: mid - A.mainSpan / 2, to: mid + A.mainSpan / 2 },
  ];
  const pitch = A.sideSpan + A.pier;
  for (let side = -1 as -1 | 1; ; side = 1) {
    for (let i = 0; i < A.sides; i++) {
      const outer = mid + side * (A.mainSpan / 2 + A.pier + i * pitch);
      const from = side < 0 ? outer - A.sideSpan : outer;
      const to = side < 0 ? outer : outer + A.sideSpan;
      // An opening that would run off the end is an opening that is not there.
      if (from < A.pier || to > run - A.pier) break;
      out.push({ from, to });
    }
    if (side === 1) break;
  }
  return out.sort((a, b) => a.from - b.from);
}

export function IslandBridge() {
  // Hoisted so the narrowing survives into the callbacks below: TypeScript
  // discards it for an imported binding the moment it is read inside a closure.
  const bridge = BRIDGE;
  const roadSurface = useRoadSurface();
  const dashes = useRef<InstancedMesh>(null);

  const built = useMemo(() => {
    if (!bridge) return null;
    const B = bridge;
    const A = B.arch;
    // City end to island end: the deck's own direction, and the shape's +X.
    const run = Math.abs(B.cityZ - B.islandZ);
    const count = Math.max(8, Math.round(run / B.step));

    /**
     * The deck's top surface at `t` along the run.
     *
     * The straight grade between the two landings, plus the hump. The hump's
     * height is measured from the grade's own midpoint, so raising either
     * landing does not raise the summit with it — the summit is set by the
     * headroom the channel needs and by nothing else.
     */
    const grade = (t: number) => B.cityY + (B.islandY - B.cityY) * t;
    const lift = A.crown - grade(0.5);
    const deckTop = (t: number) => {
      const hump = Math.sin(Math.PI * t) ** 2;
      // Sunk a little at the very ends, so the street and the island crown win
      // at the joints rather than meeting the deck coplanar. See `endSink`.
      const sink = B.endSink * (1 - Math.min(1, t * 8)) + B.endSink * (1 - Math.min(1, (1 - t) * 8));
      return grade(t) + lift * hump - sink;
    };

    let arc = 0;
    const samples: Deck[] = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const y = deckTop(t);
      // `cityZ` is the southern end and `islandZ` the northern, so the run goes
      // the way z decreases.
      const z = B.cityZ - run * t;
      if (i > 0) arc += Math.hypot(run / count, y - samples[i - 1].y);
      samples.push({ x: B.x, z, y, nx: 1, nz: 0, arc, top: y });
    }

    /* ------------------------------------------------- the masonry elevation */

    const openings = layOpenings(run);
    const soffitAt = (along: number) => deckTop(along / run) - A.deck;

    /*
     * The elevation, as ONE contour with no holes in it.
     *
     * The openings are cut from the **seabed up**, not from the springing up,
     * so they are notches in the bottom edge rather than holes in the middle of
     * the wall — which means the piers stand on the sea floor individually with
     * water between them. Punched as holes above the springing instead (which
     * is what the first cut of this did) everything below springing level stays
     * solid, and what that builds is a 226 m dam with nine windows near the top
     * of it. It read exactly as what it was: a slab of concrete lying across the
     * whole sea floor.
     *
     * So the walk is: along the base from the city end, dipping up over every
     * opening and back down to the seabed on its far side; up the island end;
     * back along the soffit; and down to close. No holes at all, because
     * nothing here is enclosed.
     */
    const shape = new Shape();
    shape.moveTo(0, A.base);
    for (const opening of openings) {
      const span = opening.to - opening.from;
      const centre = (opening.from + opening.to) / 2;
      // The crown of the ring sits a keystone's depth under the soffit, and the
      // ring is as round as the height allows: a semicircle where there is room
      // for one, squashed into a segmental arch where there is not. This is
      // what makes the middle of the viaduct read differently from the ends
      // without either being a different structure.
      const head = soffitAt(centre) - 0.4 - A.springing;
      const rise = Math.min(span / 2, head);
      if (rise < A.minRise) continue;
      shape.lineTo(opening.from, A.base);
      shape.lineTo(opening.from, A.springing);
      // Absolute, not relative: `ellipse` is measured from the current point and
      // `absellipse` from the shape's own origin, and only the second one puts
      // the springing where the pier face actually is. π to 0 clockwise sweeps
      // over the top, which is the way round an arch goes.
      shape.absellipse(centre, A.springing, span / 2, rise, Math.PI, 0, true);
      shape.lineTo(opening.to, A.base);
    }
    shape.lineTo(run, A.base);
    shape.lineTo(run, soffitAt(run));
    for (let i = count; i >= 0; i--) {
      const along = (run * i) / count;
      shape.lineTo(along, soffitAt(along));
    }
    shape.lineTo(0, A.base);

    const masonry = new ExtrudeGeometry(shape, {
      depth: B.crownHalf * 2,
      bevelEnabled: false,
      curveSegments: 24,
    });
    masonry.computeVertexNormals();

    /* ------------------------------------------------------- deck and parapets */

    /** The carriageway, laid on the deck and standing a little proud of it. */
    const roadProfile: ProfileVertex<Deck>[] = [
      { off: -B.halfWidth, rise: B.surface },
      { off: B.halfWidth, rise: B.surface },
      { off: B.halfWidth, rise: 0 },
      { off: -B.halfWidth, rise: 0 },
    ];
    /** The deck slab itself, out to the masonry's own edge. */
    const slabProfile: ProfileVertex<Deck>[] = [
      { off: -B.crownHalf, rise: 0 },
      { off: B.crownHalf, rise: 0 },
      { off: B.crownHalf, rise: -A.deck },
      { off: -B.crownHalf, rise: -A.deck },
    ];
    const parapet = (side: -1 | 1): ProfileVertex<Deck>[] => {
      const outer = side * B.crownHalf;
      const inner = side * (B.crownHalf - A.parapetWidth);
      return [
        { off: outer, rise: 0 },
        { off: inner, rise: 0 },
        { off: inner, rise: A.parapet },
        { off: outer, rise: A.parapet },
      ];
    };
    const coping = (side: -1 | 1): ProfileVertex<Deck>[] => {
      const outer = side * (B.crownHalf + 0.1);
      const inner = side * (B.crownHalf - A.parapetWidth - 0.1);
      return [
        { off: outer, rise: A.parapet },
        { off: inner, rise: A.parapet },
        { off: inner, rise: A.parapet + 0.16 },
        { off: outer, rise: A.parapet + 0.16 },
      ];
    };

    return {
      samples,
      length: arc,
      stone: makeStone(),
      openings: openings.length,
      crown: Math.max(...samples.map((v) => v.y)),
      masonry,
      slab: buildLoft(samples, slabProfile, { closed: true, vScale: 8 }),
      /*
       * The running surface, textured with the road kit rather than painted.
       *
       * `buildLoft` gives u ACROSS the profile and v along the arc, which is the
       * opposite of what the kit wants — its texture runs along u and is one
       * repeat across v. So the two are swapped: the new u is the arc in
       * texture repeats, and the new v is the old u clamped, cropped past the
       * kit's own painted footways because this deck carries stone parapets
       * instead. `AirportBridge` does the same and says the same.
       */
      road: (() => {
        const loft = buildLoft(samples, roadProfile, { closed: true, vScale: 8 });
        const uv = loft.geometry.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) {
          const t = Math.min(1, Math.max(0, uv.getX(i)));
          const across = ROAD_PAVEMENT + t * (1 - 2 * ROAD_PAVEMENT);
          const along = (uv.getY(i) * 8) / ROAD_REPEAT;
          uv.setXY(i, along, across);
        }
        uv.needsUpdate = true;
        return loft;
      })(),
      parapets: [
        buildLoft(samples, parapet(-1), { closed: true, vScale: 8 }),
        buildLoft(samples, parapet(1), { closed: true, vScale: 8 }),
      ],
      copings: [
        buildLoft(samples, coping(-1), { closed: true, vScale: 8 }),
        buildLoft(samples, coping(1), { closed: true, vScale: 8 }),
      ],
      dashCount: Math.max(1, Math.floor(arc / (DASH + DASH_GAP))),
    };
  }, [bridge]);

  /**
   * One line of inventory, like `[sea]` and `[city]` print.
   *
   * A viaduct that comes out empty — a malformed shape, a hole wound the wrong
   * way, an extrusion that triangulates to nothing — renders as open water, and
   * open water where a bridge should be is indistinguishable from a bridge you
   * are not looking at. The counts say which.
   */
  useEffect(() => {
    if (!built) return;
    console.info(`[bridge] ${built.openings} arches, `
      + `${(built.masonry.getAttribute('position')?.count ?? 0).toLocaleString()} masonry verts, `
      + `deck ${built.length.toFixed(0)} m, crown ${built.crown.toFixed(1)} m`);
  }, [built]);

  useEffect(() => {
    if (!built) return;
    return () => {
      built.stone.dispose();
      built.masonry.dispose();
      built.slab.geometry.dispose();
      built.road.geometry.dispose();
      for (const p of [...built.parapets, ...built.copings]) p.geometry.dispose();
    };
  }, [built]);

  /**
   * Tell the traffic where the road is.
   *
   * The viaduct is the only way onto the island by road and its height is a
   * curve, not a constant, so the samples are handed to `townNav` for the patch
   * the NPC steering reads. It matters more than it did: a bank was ground the
   * whole way across and a car that wandered off it slid down a slope, where
   * this is a deck with a 10 m drop either side of the parapets.
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
      // the dashes sit on the road however it humps.
      const at = pitch * (i + 0.5);
      const k = Math.min(built.samples.length - 2,
        Math.max(0, built.samples.findIndex((s) => s.arc >= at) - 1));
      const a = built.samples[k];
      const b = built.samples[k + 1];
      const t = (at - a.arc) / Math.max(b.arc - a.arc, 1e-3);
      position.set(bridge.x, a.y + (b.y - a.y) * t + bridge.surface + 0.02,
        a.z + (b.z - a.z) * t);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [built, bridge]);

  if (!bridge || !built) return null;

  return (
    <group>
      {/* The masonry, turned into place: the shape's +X becomes world −Z, which
          is the run from the city out to the island, and its extrusion becomes
          the width. Offset half the width in −X so the group's own meridian is
          the bridge's centreline. */}
      <group
        position={[bridge.x - bridge.crownHalf, 0, bridge.cityZ]}
        rotation={[0, Math.PI / 2, 0]}
      >
        <mesh geometry={built.masonry} receiveShadow castShadow>
          <meshStandardMaterial map={built.stone} color={STONE} roughness={0.96} side={DoubleSide} />
        </mesh>
      </group>

      <mesh geometry={built.slab.geometry} receiveShadow castShadow>
        <meshStandardMaterial map={built.stone} color={STONE} roughness={0.96} side={DoubleSide} />
      </mesh>
      {built.parapets.map((p, i) => (
        <mesh key={`p${i}`} geometry={p.geometry} receiveShadow castShadow>
          <meshStandardMaterial map={built.stone} color={STONE} roughness={0.96} />
        </mesh>
      ))}
      {built.copings.map((c, i) => (
        <mesh key={`c${i}`} geometry={c.geometry} receiveShadow castShadow>
          <meshStandardMaterial color={COPING} roughness={0.9} />
        </mesh>
      ))}

      {/* The carriageway, in the kit's own surface. */}
      <mesh geometry={built.road.geometry} material={roadSurface} receiveShadow castShadow />

      <instancedMesh ref={dashes} args={[undefined, undefined, built.dashCount]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#d8d4c6" roughness={0.85} />
      </instancedMesh>

      {/* Solid: the carriageway and the parapets. A trimesh because the deck is
          a curve and a box collider cannot be one, and the parapets because
          they are now the only thing between a car and a ten-metre drop — the
          bank used to catch anything that left the road, and there is no bank. */}
      <RigidBody type="fixed" colliders={false} friction={1}>
        {built.road.indices.length > 0 && (
          <TrimeshCollider args={[built.road.vertices, built.road.indices]} friction={1} />
        )}
        {built.parapets.map((p, i) => p.indices.length > 0 && (
          <TrimeshCollider key={i} args={[p.vertices, p.indices]} friction={0.6} />
        ))}
      </RigidBody>
    </group>
  );
}
