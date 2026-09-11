'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import { TERRAIN_CUTS } from '@/config/stationConfig';
import {
  BufferAttribute, Material, Mesh, Vector3, type WebGLProgramParametersWithUniforms,
} from 'three';
import { CITY, CITY_MODEL, CITY_NAV_IMAGE, DRACO_PATH } from '@/config/cityConfig';
import { TRAIN, TRAIN_LINE_ENABLED, cuttingSegments, trainNormalAt, tunnelSegments } from '@/config/trainConfig';
import { pairCentreAt } from '@/config/trackPair';
import { loadCityNav } from '@/physics/cityNav';

useGLTF.preload(CITY_MODEL, DRACO_PATH);

/**
 * Chunk role comes from glTF `extras`, which GLTFLoader copies to `userData`.
 *
 * It deliberately does NOT come from the node name: three runs every name
 * through `PropertyBinding.sanitizeNodeName`, which strips ".:/[]" characters,
 * so any structured name is quietly mangled on load and prefix tests match
 * nothing at all (symptom: zero colliders, and the car falls through the city).
 */
interface ChunkData {
  /** Solid — hand this geometry to Rapier as a trimesh. */
  collides?: boolean;
  /** Source material name, e.g. `Street`. */
  surface?: string;
}

/**
 * Terrain and ground shells are the largest meshes in the file and lie flat, so
 * they have nothing to cast onto anything. Excluding them from the shadow pass
 * keeps the map out of the depth-only render without changing what you see.
 */
const NON_CASTING = new Set(['Street', 'Street_1', 'Street_texture', 'Parking', 'MaterialPiso']);

interface Chunk {
  name: string;
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Cuts the railway's tunnels out of the terrain.
 *
 * The map is a fixed mesh and every material in it is double-sided, so a
 * tunnel lining drawn inside a hill is sliced through by the hill's own surface
 * wherever the cover is shallower than the bore — the first fifty metres in
 * from each portal, seen from inside as a green ceiling cutting across the
 * arch. There is no way to hide that with more geometry. The terrain has to
 * *not be there*, and the only tool for that on a mesh nobody can edit is the
 * fragment shader: every terrain fragment inside the bore is discarded.
 *
 * The bore is a horseshoe swept along `tunnelSegments()` — walls `uHalf` either
 * side of the rail, vertical to `uWall`, and a semicircle of radius `uHalf`
 * over that — tested per fragment against every segment. A fixed-size uniform
 * array because GLSL has no other kind; `MAX_TUNNEL_SEGMENTS` is well over
 * what the loop needs and the shader breaks out at `uCount`.
 *
 * Applied to the terrain shell (`Blocks`) and to the **sea**. The sea needs it
 * because the line now goes under the city, and the water surface is one flat
 * plane at -3.6 m stretching under the whole map: a bore at -8.8 m passes
 * straight through it, and the driver gets the underside of the sea filling the
 * lower half of the bore. Cut there, the hole is under the city and invisible
 * from above. Streets and buildings are never cut, and the loop costs every
 * fragment of whatever it is applied to.
 */
const MAX_TUNNEL_SEGMENTS = 220;
const TERRAIN_SURFACES = new Set(['Blocks']);

export function cutTunnels(material: Material) {
  // No railway, no holes in the world. Returning before the patch leaves the
  // stock material alone rather than compiling a shader whose loop would run
  // over every fragment of the terrain and the sea to find nothing.
  if (!TRAIN_LINE_ENABLED) return;
  const segments = [...tunnelSegments(), ...cuttingSegments()];
  const bores = tunnelSegments().length;
  if (segments.length > MAX_TUNNEL_SEGMENTS) {
    console.error(`[city] ${segments.length} tunnel segments exceeds the shader's `
      + `${MAX_TUNNEL_SEGMENTS}; the tunnels past that are NOT cut out of the terrain. `
      + 'Raise MAX_TUNNEL_SEGMENTS or loosen CHORD_TOLERANCE in trainConfig.');
  }
  const a = Array.from({ length: MAX_TUNNEL_SEGMENTS }, () => new Vector3());
  const b = Array.from({ length: MAX_TUNNEL_SEGMENTS }, () => new Vector3());
  // Each endpoint is moved to the centre of the track PAIR, not the running
  // line. Where there are two tracks the running line is 2.3 m off the middle
  // of the railway, and a horseshoe swept along it would leave the second
  // track hard against the lining on one side and a metre of dead room on the
  // other. `TrainLine` centres the lining, the lights and the portals on the
  // same function, so the hole and what fills it agree.
  segments.slice(0, MAX_TUNNEL_SEGMENTS).forEach((seg, i) => {
    const [ax, az] = trainNormalAt(seg[6]);
    const [bx, bz] = trainNormalAt(seg[7]);
    const ao = pairCentreAt(seg[6]);
    const bo = pairCentreAt(seg[7]);
    a[i].set(seg[0] + ax * ao, seg[1], seg[2] + az * ao);
    b[i].set(seg[3] + bx * bo, seg[4], seg[5] + bz * bo);
  });
  const count = Math.min(segments.length, MAX_TUNNEL_SEGMENTS);

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uTunnelA = { value: a };
    shader.uniforms.uTunnelB = { value: b };
    shader.uniforms.uTunnelCount = { value: count };
    // Segments before this index are bores and are cut as a horseshoe; the
    // rest are open cuttings and everything above the rail between their walls
    // goes, so the line emerges through an excavation rather than driving into
    // a slope. Without them a bore with too little cover to bury put its portal
    // in the middle of a flat field, with the "hill" a metre high behind it.
    shader.uniforms.uBoreCount = { value: Math.min(bores, MAX_TUNNEL_SEGMENTS) };
    shader.uniforms.uCuttingHalf = { value: TRAIN.cuttingHalf };
    shader.uniforms.uCuttingBatter = { value: TRAIN.cuttingBatter };
    // How far above the rail a cutting is allowed to carve. THE important
    // number for whether the terrain survives this.
    //
    // The cutting test had no upper bound, so it removed everything above the
    // rail between its battered walls — for ever upward. At a genuine cutting
    // point that is a 10 m trench and fine, but the segments are chords, and a
    // chord between two shallow points can pass through a 40 m hill: at 40 m
    // the battered half-width is 31 m, so it took a 62 m-wide V out of the
    // hillside, top to bottom. That is the grey funnel either side of every
    // portal and the reason the terrain "breaks" around a tunnel mouth.
    //
    // Cuttings only exist where the ground is within `BORE_COVER` of the rail —
    // deeper than that and it is a bore — so nothing genuine needs more than
    // this, and everything above it is hill that should have been left alone.
    shader.uniforms.uCuttingTop = { value: TRAIN.cuttingMaxDepth };
    // Clear of the lining, so no sliver of hill survives between the cut and the
    // concrete. 0.25 m was not enough: the lining is a chorded tube and the cut
    // is a chorded sweep, and where the two chords disagree the hill won.
    shader.uniforms.uTunnelHalf = { value: TRAIN.boreHalf + 0.6 };
    shader.uniforms.uTunnelWall = { value: TRAIN.boreWall };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTunnelWorld;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvTunnelWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vTunnelWorld;
uniform vec3 uTunnelA[${MAX_TUNNEL_SEGMENTS}];
uniform vec3 uTunnelB[${MAX_TUNNEL_SEGMENTS}];
uniform int uTunnelCount;
uniform int uBoreCount;
uniform float uTunnelHalf;
uniform float uTunnelWall;
uniform float uCuttingHalf;
uniform float uCuttingBatter;
uniform float uCuttingTop;
bool insideTunnel(vec3 p) {
  for (int i = 0; i < ${MAX_TUNNEL_SEGMENTS}; i++) {
    if (i >= uTunnelCount) break;
    vec3 a = uTunnelA[i];
    vec3 ab = uTunnelB[i] - a;
    float len = max(length(ab.xz), 1e-3);
    vec2 fwd = ab.xz / len;
    vec2 ap = p.xz - a.xz;
    float along = dot(ap, fwd);
    // Only the segment itself, with an overlap so consecutive segments meet on a
    // curve. Without this bound every segment cut an endless channel along its
    // own line through every hill on the map — but too small an overlap is its
    // own bug: on a curve two chords meet at an angle, and 0.6 m left slivers of
    // uncut hillside standing inside the bore, visible from the cab as flakes of
    // grass hanging in the tunnel. 2.5 m closes them at the radii this line
    // uses, and over-cutting costs nothing: the extra is behind the lining.
    if (along < -2.5 || along > len + 2.5) continue;
    float t = clamp(along / len, 0.0, 1.0);
    float u = dot(ap, vec2(-fwd.y, fwd.x));
    float v = p.y - (a.y + ab.y * t);
    if (i >= uBoreCount) {
      // Open cutting: a battered trench, bounded above by uCuttingTop so a
      // chord across a hill cannot take the whole hill with it.
      if (v > -0.8 && v < uCuttingTop
        && abs(u) < uCuttingHalf + max(0.0, v) * uCuttingBatter) return true;
      continue;
    }
    if (abs(u) < uTunnelHalf && v > -0.8 && v < uTunnelWall) return true;
    if (v >= uTunnelWall && length(vec2(u, v - uTunnelWall)) < uTunnelHalf) return true;
  }
  return false;
}`)
      .replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (insideTunnel(vTunnelWorld)) discard;');
  };
  // Distinct from the unpatched program, or three reuses the cached one.
  material.customProgramCacheKey = () => 'tunnel-cut';
  material.needsUpdate = true;
}

/**
 * Drops the triangles of one chunk that fall inside a `TERRAIN_CUTS` box.
 *
 * Returns a new index array, or null when the chunk is untouched — which is the
 * common case and the reason for the bounding-box early-out: this runs over
 * every solid chunk in the city, and all but one or two of them are nowhere
 * near a cut.
 *
 * ## Two tests, and why a centroid is not enough
 *
 * By default a triangle goes if its *centroid* is inside the box, so a thing
 * standing in the box loses its faces while the surface running out of it keeps
 * the triangles that only clip the edge. That is right for anything tiled
 * finely compared with the cut — the trees, whose leaves are centimetres
 * across.
 *
 * It is useless against anything tiled *coarser* than the cut, and the sea wall
 * at the bridge mouth is the case that proved it, twice. The wall is drawn in
 * 13 m triangles: two of them span the whole crossing, and each is split into
 * two faces whose centroids sit at x −997.3 and −980.0 — one either side of a
 * 15 m box, both a metre outside it. Neither centroid was ever in the box, so
 * both faces stayed, and both reach right across the road: a 0.9 m coping in a
 * 0.3 m carriageway, which drew as a thin line and stopped the car dead on it.
 * Widening the box cannot fix that in general — a centroid test can never
 * remove a triangle larger than the box, and making the box larger than the
 * triangle would demolish the whole waterfront.
 *
 * So `overlap` cuts ask the honest question instead: does any part of this
 * triangle lie in the box. It removes whole triangles that merely pass through,
 * which is exactly what is wanted for a wall spanning a road and exactly what
 * is NOT wanted for the ground the road sits on — hence the y band, which for
 * the wall starts above the pavement it stands on.
 */
function trim(object: Mesh, vertices: Float32Array, indices: Uint32Array): Uint32Array | null {
  if (!TERRAIN_CUTS.length) return null;
  const geometry = object.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const boxes = TERRAIN_CUTS.filter((cut) => (
    (!cut.only || object.name.includes(cut.only))
    && (!box || (
      box.max.x >= cut.x[0] && box.min.x <= cut.x[1]
      && box.max.y >= cut.y[0] && box.min.y <= cut.y[1]
      && box.max.z >= cut.z[0] && box.min.z <= cut.z[1]
    ))
  ));
  if (!boxes.length) return null;

  const kept: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    // The triangle's own extent, for the overlap test.
    let lox = Infinity;
    let loy = Infinity;
    let loz = Infinity;
    let hix = -Infinity;
    let hiy = -Infinity;
    let hiz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k] * 3;
      const x = vertices[v];
      const y = vertices[v + 1];
      const z = vertices[v + 2];
      cx += x;
      cy += y;
      cz += z;
      if (x < lox) lox = x;
      if (y < loy) loy = y;
      if (z < loz) loz = z;
      if (x > hix) hix = x;
      if (y > hiy) hiy = y;
      if (z > hiz) hiz = z;
    }
    cx /= 3;
    cy /= 3;
    cz /= 3;
    const gone = boxes.some((cut) => (cut.overlap
      ? hix >= cut.x[0] && lox <= cut.x[1]
        && hiy >= cut.y[0] && loy <= cut.y[1]
        && hiz >= cut.z[0] && loz <= cut.z[1]
      : cx >= cut.x[0] && cx <= cut.x[1]
        && cy >= cut.y[0] && cy <= cut.y[1]
        && cz >= cut.z[0] && cz <= cut.z[1]));
    if (gone) continue;
    kept.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  if (kept.length === indices.length) return null;
  return new Uint32Array(kept);
}

export function CityMap() {
  const { scene } = useGLTF(CITY_MODEL, DRACO_PATH);

  const chunks = useMemo(() => {
    const solid: Chunk[] = [];

    const cut = new Set<Material>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;

      const chunk = object.userData as ChunkData;
      object.receiveShadow = true;
      object.castShadow = !NON_CASTING.has(chunk.surface ?? '');

      // Materials are shared between chunks; each is patched once.
      if (TERRAIN_SURFACES.has(chunk.surface ?? '') && !Array.isArray(object.material)
        && !cut.has(object.material)) {
        cut.add(object.material);
        cutTunnels(object.material);
      }

      const position = object.geometry.getAttribute('position');
      const index = object.geometry.getIndex();
      if (!position || !index) return;

      // The preprocessor bakes every node transform into the vertices and
      // leaves the chunk nodes at the identity, so these are already world
      // coordinates and need no further transform before Rapier sees them.
      const vertices = position.array as Float32Array;
      // Draco hands back whichever index width it chose; Rapier wants u32.
      let indices = index.array instanceof Uint32Array
        ? index.array
        : new Uint32Array(index.array);

      // Anything the world has been told to demolish. See `TERRAIN_CUTS`. Done
      // for *every* chunk, not only the solid ones: the sea wall needs cutting
      // out of the collider, and the trees in the road need cutting out of the
      // drawing — they never had a collider to begin with. And it has to happen
      // before the trimesh is handed over, because Rapier copies the arrays and
      // a later edit would leave a wall you can see through and still crash
      // into.
      const trimmed = trim(object, vertices, indices);
      if (trimmed) {
        indices = trimmed;
        object.geometry.setIndex(new BufferAttribute(trimmed, 1));
        object.geometry.computeBoundingSphere();
      }

      if (!chunk.collides) return;
      solid.push({ name: object.name, vertices, indices });
    });

    return solid;
  }, [scene]);

  // The nav raster drives the minimap, the compass and reset-onto-road. It is
  // fetched alongside the model rather than suspended on: the city is fully
  // playable without it, and the reset handler falls back to the fixed spawn
  // until it lands.
  useEffect(() => {
    loadCityNav(CITY_NAV_IMAGE).catch((error) => {
      console.warn('[city] navigation raster failed to load; minimap disabled', error);
    });
  }, []);

  useEffect(() => {
    const triangles = chunks.reduce((n, c) => n + c.indices.length / 3, 0);
    console.info(
      `[city] ${chunks.length} solid chunks (${triangles.toLocaleString()} triangles) + ${CITY.boxes.length} box colliders`,
    );
  }, [chunks]);

  return (
    <group>
      <primitive object={scene} />

      {/* One fixed body holds the whole map. Rapier's broad-phase copes with a
          few thousand static colliders far better than a few thousand bodies,
          and none of this ever moves. */}
      <RigidBody type="fixed" colliders={false} friction={1}>
        {chunks.map((chunk) => (
          <TrimeshCollider
            key={chunk.name}
            args={[chunk.vertices, chunk.indices]}
            friction={1}
          />
        ))}

        {/* Buildings. A per-primitive AABB is tighter than a per-building one
            and needs no clustering; the oversized primitives that boxed badly
            were routed into the trimesh above instead. */}
        {CITY.boxes.map((box, i) => (
          <CuboidCollider
            key={i}
            args={[box.h[0], box.h[1], box.h[2]]}
            position={[box.p[0], box.p[1], box.p[2]]}
            friction={0.4}
            restitution={0.1}
          />
        ))}
      </RigidBody>
    </group>
  );
}
