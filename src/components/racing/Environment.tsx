'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment as DreiEnvironment, useTexture } from '@react-three/drei';
import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight, DoubleSide,
  EquirectangularReflectionMapping, Euler, InstancedMesh, Matrix4, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, Quaternion, SRGBColorSpace, Vector3,
  type AmbientLight, type Fog, type Group, type HemisphereLight,
} from 'three';
import type { VehicleTelemetry } from '@/types/vehicle';
import { TRACK, trackNormal, trackPoint, trackRadius } from '@/config/trackConfig';
import { WORLD_ID } from '@/config/world';
import { TRAIN, TRAIN_ISLANDS, TRAIN_LINE_ENABLED, trainDarknessAt } from '@/config/trainConfig';
import { seaWaveGLSL } from '@/config/seaConfig';
import { cutTunnels } from './CityMap';
import SKY from '@/config/skyData.json';

/**
 * Sun position — measured off the sky photograph, not chosen.
 *
 * `scripts/prepare-sky.mjs` finds the sun in the panorama and writes its angles
 * to `skyData.json`; the shadow-casting light, the environment map's sun disc
 * and the sky the player sees are therefore the same sun. Picking these by hand
 * while a photographed sun sat somewhere else was the one thing guaranteed to
 * look wrong no matter how good the sky was, because every shadow in the city
 * would disagree with it.
 *
 * It comes out at 48 degrees, which is high and bright — the asset is named
 * `kloofendal_48d`, so the measurement lands within 0.2 degrees of what its
 * author called it.
 */
const SUN_AZIMUTH = SKY.sun.azimuth;
const SUN_ELEVATION = SKY.sun.elevation;

const SUN_DIRECTION = new Vector3(
  Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
);

/**
 * Equirectangular environment map, drawn procedurally.
 *
 * drei's `Environment preset=` would fetch an HDRI from a CDN — an external
 * runtime dependency for something the scene can generate locally in a few ms.
 * This gives the McLaren's clearcoat a real gradient to reflect (sky above,
 * ground below, a hot sun) without any network request.
 */
function useProceduralEnvMap() {
  return useMemo(() => {
    const width = 512;
    const height = 256;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');

    // Sky: deep blue at the zenith easing to a warm haze at the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, height / 2);
    sky.addColorStop(0, '#2f6ec4');
    sky.addColorStop(0.65, '#8fc0e8');
    sky.addColorStop(1, '#e6ddc9');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height / 2);

    // Ground half: dark enough that the car's lower panels don't glow.
    const ground = ctx.createLinearGradient(0, height / 2, 0, height);
    ground.addColorStop(0, '#8b8f76');
    ground.addColorStop(1, '#2a2c25');
    ctx.fillStyle = ground;
    ctx.fillRect(0, height / 2, width, height / 2);

    // Sun disc, positioned to match SUN_DIRECTION so highlights line up.
    const u = ((SUN_AZIMUTH / (Math.PI * 2)) % 1) * width;
    const v = (0.5 - SUN_ELEVATION / Math.PI) * height;
    const glow = ctx.createRadialGradient(u, v, 0, u, v, 46);
    glow.addColorStop(0, 'rgba(255,252,235,1)');
    glow.addColorStop(0.18, 'rgba(255,240,200,0.85)');
    glow.addColorStop(1, 'rgba(255,235,190,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(u, v, 46, 0, Math.PI * 2);
    ctx.fill();

    const texture = new CanvasTexture(canvas);
    texture.mapping = EquirectangularReflectionMapping;
    return texture;
  }, []);
}

/**
 * The sky: an equirectangular photograph on `scene.background`.
 *
 * A photograph rather than a gradient, and equirectangular rather than flat —
 * a flat image used as a backdrop stays pinned to the screen, so the clouds
 * would turn with the car instead of staying put in the world. Handing three
 * an equirect texture as the background lets it do the projection, which costs
 * no geometry and cannot clip against the camera's far plane.
 */
function SkyBackground() {
  const texture = useTexture(SKY.image);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    texture.mapping = EquirectangularReflectionMapping;
    texture.colorSpace = SRGBColorSpace;

    const previous = scene.background;
    const previousIntensity = scene.backgroundIntensity;
    scene.background = texture;
    // The background is tone mapped along with everything else, and ACES pulls
    // a JPG's whites down; this puts the photograph back where it was shot.
    scene.backgroundIntensity = 1.25;

    return () => {
      scene.background = previous;
      scene.backgroundIntensity = previousIntensity;
    };
  }, [scene, texture]);

  return null;
}

/**
 * Shadow-casting sun that follows the car.
 *
 * A single shadow map cannot cover a 1.4 km circuit at usable resolution, so
 * the light rig is translated to stay centred on the car and the map only ever
 * covers the ~70 m the player can actually see.
 */
/** How dark the world is right now, 0 (open air) to 1 (deep in a bore). See `Darkness`. */
type Dim = { current: number };
const SUN_INTENSITY = 3.1;

function SunLight({ chassisRef, dim }: { chassisRef: RefObject<Group | null>; dim: Dim }) {
  const lightRef = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const carPosition = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const light = lightRef.current;
    const chassis = chassisRef.current;
    if (!light || !chassis) return;

    chassis.getWorldPosition(carPosition);
    // Snap to a 2 m grid: moving the shadow camera continuously makes the
    // texel grid crawl, which reads as shimmering shadow edges.
    const sx = Math.round(carPosition.x / 2) * 2;
    const sz = Math.round(carPosition.z / 2) * 2;

    target.position.set(sx, 0, sz);
    target.updateMatrixWorld();
    light.position.set(sx + SUN_DIRECTION.x * 90, SUN_DIRECTION.y * 90, sz + SUN_DIRECTION.z * 90);
    // Nothing in this scene occludes the sun, so inside a hill it is switched
    // off instead — almost: a trace stays so the shadow map does not vanish
    // and reappear at every portal.
    light.intensity = SUN_INTENSITY * (1 - 0.96 * dim.current);
  });

  useEffect(() => {
    const light = lightRef.current;
    if (light) light.target = target;
  }, [target]);

  return (
    <directionalLight
      ref={lightRef}
      castShadow
      intensity={SUN_INTENSITY}
      color="#fff4e0"
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
      shadow-camera-left={-38}
      shadow-camera-right={38}
      shadow-camera-top={38}
      shadow-camera-bottom={-38}
      shadow-camera-near={1}
      shadow-camera-far={220}
    />
  );
}

/**
 * Trees, as two instanced meshes (trunks + canopies).
 *
 * Placement uses the analytic centreline: for any point, theta = atan2(z, x)
 * gives the nearest centreline angle, so `|r - trackRadius(theta)|` is a cheap
 * and accurate distance-to-track. Anything too close to the circuit is rejected
 * so trees never grow through the barriers.
 */
function Trees({ count = 420 }: { count?: number }) {
  const trunks = useRef<InstancedMesh>(null);
  const canopies = useRef<InstancedMesh>(null);

  const placements = useMemo(() => {
    const result: Array<{ x: number; z: number; scale: number; rotation: number }> = [];
    // Deterministic PRNG so the treeline is identical every load.
    let seed = 987654321;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    let attempts = 0;
    while (result.length < count && attempts < count * 40) {
      attempts++;
      const angle = random() * Math.PI * 2;
      const radius = 90 + random() * 320;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const distanceToTrack = Math.abs(radius - trackRadius(Math.atan2(z, x)));
      if (distanceToTrack < TRACK.barrierOffset + 9) continue;
      result.push({ x, z, scale: 0.75 + random() * 0.9, rotation: random() * Math.PI * 2 });
    }
    return result;
  }, [count]);

  useEffect(() => {
    const trunkMesh = trunks.current;
    const canopyMesh = canopies.current;
    if (!trunkMesh || !canopyMesh) return;

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Euler();

    placements.forEach((tree, i) => {
      euler.set(0, tree.rotation, 0);
      quaternion.setFromEuler(euler);

      position.set(tree.x, 1.8 * tree.scale, tree.z);
      scale.set(tree.scale, tree.scale, tree.scale);
      trunkMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));

      position.set(tree.x, 5.4 * tree.scale, tree.z);
      canopyMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });

    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    trunkMesh.computeBoundingSphere();
    canopyMesh.computeBoundingSphere();
  }, [placements]);

  return (
    <group>
      <instancedMesh ref={trunks} args={[undefined, undefined, placements.length]} castShadow>
        <cylinderGeometry args={[0.22, 0.32, 3.6, 6]} />
        <meshStandardMaterial color="#4a3728" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={canopies} args={[undefined, undefined, placements.length]} castShadow>
        <coneGeometry args={[2.5, 6.4, 8]} />
        <meshStandardMaterial color="#315a2c" roughness={0.85} flatShading />
      </instancedMesh>
    </group>
  );
}

/** A tiered grandstand, oriented to face the track. */
function Grandstand({ theta }: { theta: number }) {
  const { position, rotation } = useMemo(() => {
    const [cx, cz] = trackPoint(theta);
    const [nx, nz] = trackNormal(theta);
    const distance = TRACK.barrierOffset + 11;
    return {
      position: [cx + nx * distance, 0, cz + nz * distance] as [number, number, number],
      // Face back down the outward normal, i.e. toward the circuit.
      rotation: [0, Math.atan2(-nx, -nz), 0] as [number, number, number],
    };
  }, [theta]);

  const tiers = 7;

  return (
    <group position={position} rotation={rotation}>
      {/* Seating tiers, stepping up and back away from the track. */}
      {Array.from({ length: tiers }, (_, i) => (
        <mesh key={i} position={[0, 0.7 + i * 0.75, i * 1.25]} castShadow receiveShadow>
          <boxGeometry args={[38, 0.75, 1.3]} />
          <meshStandardMaterial color={i % 2 ? '#c9ccd2' : '#9aa2ad'} roughness={0.8} />
        </mesh>
      ))}
      {/* Back wall and roof. */}
      <mesh position={[0, 4.2, tiers * 1.25 + 0.6]} castShadow receiveShadow>
        <boxGeometry args={[38, 8.4, 0.6]} />
        <meshStandardMaterial color="#6f7681" roughness={0.85} />
      </mesh>
      <mesh position={[0, 8.6, tiers * 0.62]} castShadow>
        <boxGeometry args={[39.5, 0.35, tiers * 1.5]} />
        <meshStandardMaterial color="#3d434d" roughness={0.7} metalness={0.25} />
      </mesh>
      {/* Roof supports. */}
      {[-17.5, 0, 17.5].map((x) => (
        <mesh key={x} position={[x, 4.4, tiers * 1.25 + 0.2]} castShadow>
          <boxGeometry args={[0.4, 8.8, 0.4]} />
          <meshStandardMaterial color="#4a505a" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * The sea. Drawn only with the railway — see `TRAIN_LINE_ENABLED`.
 *
 * Not scenery for its own sake — the map genuinely has no water in it, and
 * three quarters of the world is void that the game never showed anyone
 * because the roads never reach it. A railway that bridges the bays does reach
 * it, and a bridge over an abyss reads as a broken game. See `TRAIN.seaLevel`
 * for where the surface sits and how that was measured.
 *
 * It comes and goes with the railway because it is not free: one flat plane at
 * -3.6 m stretching 12 km cuts through everything the map puts below that line,
 * and the map puts plenty there — 4,406 cells of drivable ground, 2,281 of them
 * paved, down to -11.9 m, which is the ramps into the underground car parks and
 * the low ground at the map's edge. Without a railway crossing the bays there is
 * nothing to pay that with, so the water goes and the map is as it was.
 *
 * One plane, big enough that the fog swallows its edge long before the camera
 * does: the far plane is 815 m and the map is 3.3 km across, so 12 km centred
 * on the map is far more than enough from anywhere a car can be.
 */
function Sea() {
  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ color: '#1c4a5e', roughness: 0.14, metalness: 0.1 });
    // The same cut the terrain gets: a bore under the city runs below the water
    // surface, and this plane stretches under the whole map.
    cutTunnels(m);
    animateWater(m);
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state) => {
    const shader = material.userData.water as { uniforms: { uTime: { value: number } } } | undefined;
    if (shader) shader.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return (
    <>
      <mesh
        material={material}
        position={[-950, TRAIN.seaLevel, 240]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[12000, 12000]} />
      </mesh>
      <Surf />
    </>
  );
}

/**
 * Makes the sea move, without moving a single vertex.
 *
 * A 12 km plane cannot be displaced: it is two triangles, and subdividing it
 * finely enough to carry a wave anywhere near the camera would be millions of
 * vertices spent almost entirely on water the fog has already swallowed. What
 * actually reads as moving water at this distance is not the shape of the
 * surface but the **light coming off it** — so the geometry stays flat and the
 * NORMAL is what waves.
 *
 * Four directional waves in world XZ, summed. Their heights are never used;
 * only the slopes are, which is the whole trick — the analytic derivative of
 * the same sum gives the surface tilt directly, and a normal built from it
 * lights exactly as a displaced surface would. Two long swells set the motion,
 * a shorter cross-swell keeps it from reading as a corrugated roof, and a fine
 * chop supplies the glitter that makes a sun on water look like a sun on
 * water.
 *
 * The roughness moves with it too, a little rougher in the troughs than on the
 * crests, because a perfectly even gloss over a moving normal reads as
 * polished metal rather than as water.
 *
 * `onBeforeCompile` rather than a `ShaderMaterial`, so the sea keeps
 * everything `MeshStandardMaterial` gives it: the scene's lights, the
 * environment map, fog, tone mapping, shadows — and `cutTunnels`, which is
 * already patched into this same material and which a bespoke shader would
 * have to reimplement.
 */
function animateWater(material: MeshStandardMaterial) {
  const existing = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    existing?.call(material, shader, renderer);
    shader.uniforms.uTime = { value: 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSeaPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSeaPos = (modelMatrix * vec4(position, 1.0)).xyz;`);

    // The wave sum is GENERATED from `SEA_WAVES`, which is also what the boats
    // float on. Two copies of four wavelengths — one here and one in the
    // physics — is a boat riding a swell it is not standing in.
    const waves = seaWaveGLSL();
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec3 vSeaPos;

        // One wave's contribution to the surface SLOPE at a point. The wave
        // itself is A sin(k . x - w t); this is its derivative, which is all a
        // normal needs.
        vec2 waveSlope(vec2 p, vec2 dir, float len, float speed, float amp) {
          float k = 6.2831853 / len;
          float phase = dot(dir, p) * k - uTime * speed * k;
          return dir * (amp * k * cos(phase));
        }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec2 p = vSeaPos.xz;
          vec2 slope = vec2(0.0);
${waves.slope}
          // The plane faces +Y, so the slopes are the X and Z tilts of it.
          normal = normalize(normal + vec3(-slope.x, 0.0, -slope.y));
        }`)
      // Crests catch the sky and troughs hold the depth colour; the same
      // swell, sampled for height this time rather than slope.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          vec2 p = vSeaPos.xz;
          float h = 0.0;
${waves.height}
          roughnessFactor = clamp(roughnessFactor + h * 0.09, 0.05, 0.9);
          diffuseColor.rgb *= 1.0 + h * 0.1;
        }`);

    material.userData.water = shader;
  };
  // A material that has already been compiled once will not be recompiled just
  // because its callback changed; this is what tells three to.
  material.customProgramCacheKey = () => 'sea-waves';
  material.needsUpdate = true;
}

/**
 * Surf: the line where the sea meets each made island.
 *
 * The waves above are a lighting effect and stop being convincing exactly
 * where the water meets something, because a real waterline is the one place
 * on the sea with an edge. This draws that edge — a band of foam following
 * each island's own shoreline, breathing in and out.
 *
 * Where the line goes is measured rather than guessed. Each island is a crown
 * at `island.crown` with a beach battered out `island.shore` metres to
 * `TRAIN.seabed`, so the water cuts that slope at a fixed fraction of the way
 * out, and the foam band sits astride it. Grow an island or move the sea and
 * the surf follows, because both numbers come from the same place the beach
 * does.
 *
 * One geometry for every island, two triangles per outline segment, drawn with
 * a soft alpha that pulses along the shore — cheap enough that it costs a
 * single draw call for the whole archipelago.
 */
/** Half the width of the surf band, in metres. */
const SURF_HALF = 7.0;

/**
 * Builds the surf band. A plain function rather than a body inside `useMemo`
 * because the React Compiler cannot preserve a memo this size, and the loop
 * that walks every island's outline has no business being re-read as a hook.
 */
function buildSurf() {
  if (!TRAIN_LINE_ENABLED || !TRAIN_ISLANDS.length) return null;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const island of TRAIN_ISLANDS) {
    // How far down the beach the water reaches, as a fraction of the batter.
    const fall = island.crown - TRAIN.seabed;
    const t = fall <= 0 ? 0 : (island.crown - TRAIN.seaLevel) / fall;
    if (t <= 0 || t >= 1) continue;
    const outline = island.outline;
    const n = outline.length;
    const base = positions.length / 3;

    for (let i = 0; i < n; i++) {
      const [x, z] = outline[i];
      const [px, pz] = outline[(i - 1 + n) % n];
      const [nx2, nz2] = outline[(i + 1) % n];
      // Outward normal at this vertex: the average of its two edge normals.
      // Which hand is outward comes from the island's own winding, which
      // `TRAIN_ISLANDS` fixes so a fan over it faces up.
      let ox = 0;
      let oz = 0;
      for (const [from, to] of [[[px, pz], [x, z]], [[x, z], [nx2, nz2]]] as const) {
        const dx = to[0] - from[0];
        const dz = to[1] - from[1];
        const len = Math.hypot(dx, dz) || 1;
        ox += dz / len;
        oz += -dx / len;
      }
      const len = Math.hypot(ox, oz) || 1;
      ox /= len;
      oz /= len;
      const reach = island.shore * t;
      for (const [side, u] of [[reach - SURF_HALF, 0], [reach + SURF_HALF, 1]] as const) {
        // Laid ON the beach, not at sea level. The band straddles the
        // waterline and the beach is a 26 m batter falling 12 m, so a flat
        // ribbon buries its whole landward half three metres inside the sand:
        // the wash has to climb the slope with the sand. The seaward half is
        // then held a few centimetres proud of the water instead, because the
        // sea is opaque and anything under it is simply gone.
        const wash = island.crown - (side / island.shore) * (island.crown - TRAIN.seabed);
        positions.push(
          x + ox * side,
          Math.max(wash + 0.05, TRAIN.seaLevel + 0.05),
          z + oz * side,
        );
        uvs.push(u, i / n);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      const b = base + ((i + 1) % n) * 2;
      indices.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
  if (!indices.length) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new MeshBasicMaterial({
    color: '#eef4f2',
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    // Its own varying rather than three's `vMapUv`: that one is only declared
    // on a material that HAS a texture, and this band is painted entirely in
    // the shader. The `uv` attribute is always there to read.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec2 vSurfUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurfUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec2 vSurfUv;`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        // Across the band: nothing at the sea edge, most at the sand edge.
        float band = smoothstep(0.0, 0.45, vSurfUv.x) * (1.0 - smoothstep(0.55, 1.0, vSurfUv.x));
        // Along the shore: a slow swell so the foam runs rather than sits,
        // plus a shorter beat so no two bays break together.
        float run = 0.55
          + 0.45 * sin(vSurfUv.y * 240.0 - uTime * 1.7)
          * (0.6 + 0.4 * sin(vSurfUv.y * 61.0 + uTime * 0.9));
        diffuseColor.a *= band * run;`);
    material.userData.surf = shader;
  };
  material.customProgramCacheKey = () => 'surf';
  return { geometry, material };
}

function Surf() {
  const built = useMemo(() => buildSurf(), []);

  useEffect(() => () => {
    built?.geometry.dispose();
    built?.material.dispose();
  }, [built]);

  useFrame((state) => {
    const shader = built?.material.userData.surf as
      { uniforms: { uTime: { value: number } } } | undefined;
    if (shader) shader.uniforms.uTime.value = state.clock.elapsedTime;
  });

  if (!built) return null;
  return <mesh geometry={built.geometry} material={built.material} renderOrder={1} />;
}

/**
 * Darkness underground.
 *
 * Nothing in the scene occludes light, so the sun, the sky dome and the
 * environment map all reach inside a hill, and a bore lit by them is a grey
 * pipe in daylight. So the world's lights follow how deep underground the train
 * is: the sun and sky die away, a trace of ambient stays, the environment map
 * dims, and the fog goes short and black so the far end of the tunnel is a
 * hole rather than a lit disc. What is left to see is what the bore lights
 * itself: the lamp strips, the signs, the emissive lining.
 *
 * Depth, not a switch. The first version keyed this to `telemetry.enclosed`, a
 * boolean damped over a tenth of a second, and the world snapped dark forty
 * metres before every portal — a light switch, not a tunnel. Daylight does not
 * stop at a portal; it reaches in and fades over the first hundred metres, and
 * on the way out the mouth brightens the same way. `trainDepthAt` is the
 * distance along the line to the nearest open point, and `trainDarknessAt` is a
 * smoothstep of that over `DARK_FADE` (both in `trainConfig`), so the transition is a hundred metres
 * long and continuous both ways, then damped a little so a camera cut cannot
 * make it jump. Only the main-line train publishes a `railArc`, so `active`
 * gates it: cars and the tram never go underground.
 */
const OPEN_FOG = { near: 260, far: 815 };
const BORE_FOG = { near: 18, far: 150 };
const BORE_FOG_COLOUR = new Color('#050507');
const DARK_HALF_LIFE = 0.3;

function Darkness({ telemetry, active, dim, hemi, ambient, fog, openFog }: {
  telemetry?: RefObject<VehicleTelemetry>;
  active: boolean;
  dim: Dim;
  hemi: RefObject<HemisphereLight | null>;
  ambient: RefObject<AmbientLight | null>;
  fog: RefObject<Fog | null>;
  openFog: Color;
}) {
  const scene = useThree((state) => state.scene);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const target = active && telemetry ? trainDarknessAt(telemetry.current.railArc) : 0;
    dim.current += (target - dim.current) * (1 - Math.pow(0.5, delta / DARK_HALF_LIFE));
    const e = dim.current;
    if (hemi.current) hemi.current.intensity = 0.5 * (1 - 0.92 * e);
    if (ambient.current) ambient.current.intensity = 0.18 * (1 - 0.55 * e);
    scene.environmentIntensity = 0.85 * (1 - 0.9 * e);
    const f = fog.current;
    if (f) {
      f.color.lerpColors(openFog, BORE_FOG_COLOUR, e);
      f.near = OPEN_FOG.near + (BORE_FOG.near - OPEN_FOG.near) * e;
      f.far = OPEN_FOG.far + (BORE_FOG.far - OPEN_FOG.far) * e;
    }
  });
  return null;
}

export function RacingEnvironment({ chassisRef, telemetry, dark = false }: {
  chassisRef: RefObject<Group | null>;
  telemetry?: RefObject<VehicleTelemetry>;
  /** Whether the vehicle can go underground at all — the main-line train. */
  dark?: boolean;
}) {
  const envMap = useProceduralEnvMap();
  useEffect(() => () => envMap.dispose(), [envMap]);
  const dim = useRef(0);
  const hemi = useRef<HemisphereLight>(null);
  const ambient = useRef<AmbientLight>(null);
  const fog = useRef<Fog>(null);
  const openFog = useMemo(() => new Color(SKY.horizon), []);

  return (
    <>
      <SkyBackground />
      <Darkness telemetry={telemetry} active={dark} dim={dim} hemi={hemi} ambient={ambient} fog={fog} openFog={openFog} />
      {/* Reflections stay on the procedural map. The panorama is a "pure sky",
          which mirrors itself below the horizon — used as the environment it
          would light the cars from underneath, and the procedural map's dark
          lower half is exactly what stops the McLaren's sills from glowing. */}
      <DreiEnvironment map={envMap} background={false} environmentIntensity={0.85} />

      <hemisphereLight ref={hemi} args={[new Color('#bcd7f2'), new Color('#5d6446'), 0.5]} />
      <ambientLight ref={ambient} intensity={0.18} />
      <SunLight chassisRef={chassisRef} dim={dim} />

      {/* Haze hides the world edge — but it was doing far more than that.
          Saturating at 490 m against a camera that sees to 820 m meant the far
          third of the view was solid fog colour: the skyline, the hills and the
          horizon were all one flat band, which is most of why the scene read as
          having no sky. Ending the ramp at the far plane instead keeps the clip
          edge hidden while giving everything nearer its contrast back — a
          building 400 m out is now a quarter fogged rather than three quarters.

          The colour is the sky's own horizon band, so the world dissolves into
          the sky rather than into a grey that never appears in it. */}
      <fog ref={fog} attach="fog" args={[SKY.horizon, OPEN_FOG.near, OPEN_FOG.far]} />

      {WORLD_ID === 'city' && TRAIN_LINE_ENABLED && <Sea />}

      {/* Circuit dressing only. Both are placed off the analytic centreline, so
          in the city they would land in the sea — and the city brings its own
          40,000-odd trees anyway. */}
      {WORLD_ID === 'track' && (
        <>
          <Trees />
          {[0.35, 2.4, 4.6].map((theta) => (
            <Grandstand key={theta} theta={theta} />
          ))}
        </>
      )}
    </>
  );
}
