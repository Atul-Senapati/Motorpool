'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACO_PATH } from '@/config/cityConfig';
import { BEACH_STAGE } from '@/config/kestrelBeach';
import stageData from '@/config/beachStageData.json';

/**
 * The beach stage — the user's `stage_4.glb` (`npm run prepare:beach-stage`)
 * at `BEACH_STAGE`, its back to the sea, dressed so it reads as a show:
 *
 *  - the stage's own light strips lit (front edge white, riser amber);
 *  - its screen panel an **LED wall**: a moving gradient under equaliser bars,
 *    drawn in the shader, no texture;
 *  - a **box truss** over it — four towers and a frame — with six **moving
 *    heads** hung from the front beam, their beams soft additive cones that
 *    sweep and change colour;
 *  - **speaker stacks** at the front corners and a **crowd barrier** across
 *    the front.
 *
 * Everything is a handful of merged meshes — the truss is one, the speakers
 * one, the barrier one, the six beams six — and only the beams and the
 * screen's time move each frame. Solid where it stands: the deck, the
 * backdrop, the towers, the stacks and the barrier.
 *
 * Local frame: x across the stage, +z its front (inland), y up from the pad.
 */

const MODEL = '/models/beachStage.glb';
useGLTF.preload(MODEL, DRACO_PATH);

const FRONT = stageData.front;
const BACK = stageData.back;
const HALF_W = stageData.size[0] / 2;
/** The deck's top, and the truss: towers just outside the backdrop, a frame at `TRUSS_Y`. */
const DECK = 1.19;
const TOWER_X = HALF_W + 1.2;
const TOWER_Z: readonly number[] = [BACK + 1, FRONT - 0.4];
const TRUSS_Y = 9.6;
const TRUSS_W = 0.5;
/** Moving heads across the front beam. */
const HEADS: readonly number[] = [-8, -4.8, -1.6, 1.6, 4.8, 8];
const BEAM_LENGTH = 15;
const BEAM_COLOURS = ['#ff3b6b', '#3bc6ff', '#b45bff', '#ffd23b', '#3bff9a', '#ff7a2f'].map((c) => new Color(c));

/** A square lattice truss between two points along one axis: four chords and rungs. */
function truss(from: [number, number, number], to: [number, number, number], width = TRUSS_W): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const axis = d[1] !== 0 ? 'y' : d[0] !== 0 ? 'x' : 'z';
  const h = width / 2;
  const corners: Array<[number, number]> = [[-h, -h], [h, -h], [h, h], [-h, h]];
  const place = (g: BufferGeometry, t: number, a: number, b: number) => {
    // g is built along +y; turn it onto the axis, then offset.
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    const s = Math.sign(axis === 'y' ? d[1] : axis === 'x' ? d[0] : d[2]);
    const base = [from[0], from[1], from[2]];
    const along = s * t;
    if (axis === 'y') g.translate(base[0] + a, base[1] + along, base[2] + b);
    if (axis === 'x') g.translate(base[0] + along, base[1] + a, base[2] + b);
    if (axis === 'z') g.translate(base[0] + a, base[1] + b, base[2] + along);
    return g;
  };
  for (const [a, b] of corners) out.push(place(new CylinderGeometry(0.035, 0.035, len, 6).translate(0, len / 2, 0), 0, a, b));
  for (let t = 0.5; t < len; t += 0.6) {
    for (let k = 0; k < 4; k++) {
      const [a0, b0] = corners[k];
      const [a1, b1] = corners[(k + 1) % 4];
      const rung = new CylinderGeometry(0.018, 0.018, width, 4);
      // A rung across one face: along a or b.
      if (a0 !== a1) rung.rotateZ(Math.PI / 2); else rung.rotateX(Math.PI / 2);
      out.push(place(rung, t, (a0 + a1) / 2, (b0 + b1) / 2));
    }
  }
  return out;
}

export function KestrelStage() {
  const site = BEACH_STAGE;
  const { scene } = useGLTF(MODEL, DRACO_PATH);

  /** The stage, with its lights lit and its screen turned into an LED wall. */
  const { stage, screen } = useMemo(() => {
    const root = scene.clone(true);
    const screenUniforms = { uTime: { value: 0 } };
    root.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const m = (mesh.material as MeshStandardMaterial).clone();
      if (m.name === 'light') { m.emissive.set('#ffffff'); m.emissiveIntensity = 2.2; }
      if (m.name === 'light_yellow') { m.emissive.set('#ffb340'); m.emissiveIntensity = 1.8; }
      if (m.name === 'Material') {
        // The screen panel (and the slab under the stage, which shares the
        // material — the wall is only drawn above the deck).
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = screenUniforms.uTime;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vStagePos;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStagePos = position;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vStagePos;')
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (vStagePos.y > 3.0) {
    // The LED wall: a slow colour wash, equaliser bars rising over it, and the pixel grid.
    vec2 p = vec2(vStagePos.x / 6.6 + 0.5, (vStagePos.y - 4.78) / 2.9);
    vec3 wash = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + p.x * 0.6 + uTime * 0.12));
    float bar = floor(p.x * 18.0);
    float level = 0.25 + 0.7 * abs(sin(uTime * (1.3 + mod(bar, 5.0) * 0.37) + bar * 1.7));
    float lit = step(p.y, level);
    vec2 cell = fract(vec2(p.x * 72.0, p.y * 32.0));
    float pixel = step(0.12, cell.x) * step(0.12, cell.y);
    vec3 led = mix(wash * 0.35, wash * 1.6 + 0.15, lit) * pixel;
    diffuseColor.rgb = vec3(0.02);
    totalEmissiveRadiance = led * 1.4;
  }`);
        };
        m.customProgramCacheKey = () => 'beach-stage-led';
      }
      mesh.material = m;
    });
    return { stage: root, screen: screenUniforms };
  }, [scene]);

  /** The truss, the speaker stacks and the barrier, merged. */
  const rig = useMemo(() => {
    const parts: BufferGeometry[] = [];
    for (const z of TOWER_Z) for (const x of [-TOWER_X, TOWER_X]) parts.push(...truss([x, 0, z], [x, TRUSS_Y, z]));
    for (const z of TOWER_Z) parts.push(...truss([-TOWER_X, TRUSS_Y, z], [TOWER_X, TRUSS_Y, z]));
    for (const x of [-TOWER_X, TOWER_X]) parts.push(...truss([x, TRUSS_Y, TOWER_Z[0]], [x, TRUSS_Y, TOWER_Z[1]]));
    const truss3 = mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
    parts.forEach((g) => g.dispose());

    const boxes: BufferGeometry[] = [];
    // Speakers: three cabinets a side at the front corners, the top one angled down.
    for (const side of [-1, 1]) {
      const x = side * (HALF_W + 1.4);
      boxes.push(new BoxGeometry(1.5, 1.2, 1.1).translate(x, 0.6, FRONT + 0.8));
      boxes.push(new BoxGeometry(1.4, 1.1, 1.0).translate(x, 1.75, FRONT + 0.8));
      boxes.push(new BoxGeometry(1.3, 0.9, 0.9).rotateX(0.18).translate(x, 2.8, FRONT + 0.8));
    }
    const speakers = mergeGeometries(boxes.map((g) => g.toNonIndexed()))!;
    boxes.forEach((g) => g.dispose());

    // The crowd barrier: steel sections across the front, three metres out.
    const rails: BufferGeometry[] = [];
    const bz = FRONT + 3;
    const span = HALF_W + 2;
    for (let x = -span; x <= span + 1e-6; x += 2) {
      rails.push(new BoxGeometry(0.06, 1.1, 0.06).translate(x, 0.55, bz));
      rails.push(new BoxGeometry(0.06, 0.06, 0.7).translate(x, 0.03, bz + 0.3));
    }
    for (const y of [0.25, 1.05]) rails.push(new BoxGeometry(span * 2, 0.05, 0.05).translate(0, y, bz));
    for (let x = -span + 0.2; x < span; x += 0.25) rails.push(new BoxGeometry(0.02, 0.8, 0.02).translate(x, 0.65, bz));
    const barrier = mergeGeometries(rails.map((g) => g.toNonIndexed()))!;
    rails.forEach((g) => g.dispose());
    return { truss: truss3, speakers, barrier, barrierZ: bz, barrierSpan: span };
  }, []);

  const mats = useMemo(() => ({
    truss: new MeshStandardMaterial({ color: '#c9ccd1', roughness: 0.35, metalness: 0.85 }),
    speaker: new MeshStandardMaterial({ color: '#141416', roughness: 0.8 }),
    barrier: new MeshStandardMaterial({ color: '#9aa0a6', roughness: 0.4, metalness: 0.7 }),
    head: new MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.4 }),
  }), []);

  /** The moving heads' beams: soft cones from the lamp, opening downward. */
  const beam = useMemo(() => {
    // Built pointing down -y from its tip at the origin.
    const g = new ConeGeometry(1.7, BEAM_LENGTH, 20, 1, true).translate(0, -BEAM_LENGTH / 2, 0);
    return g;
  }, []);
  const beamMats = useMemo(() => HEADS.map((_, i) => new MeshBasicMaterial({
    color: BEAM_COLOURS[i % BEAM_COLOURS.length], transparent: true, opacity: 0.16, blending: AdditiveBlending,
    depthWrite: false, side: DoubleSide,
  })), []);
  const headGeometry = useMemo(() => new BoxGeometry(0.45, 0.5, 0.45), []);
  useEffect(() => () => {
    [rig.truss, rig.speakers, rig.barrier, beam, headGeometry].forEach((g) => g.dispose());
    Object.values(mats).forEach((m) => m.dispose());
    beamMats.forEach((m) => m.dispose());
  }, [rig, beam, beamMats, headGeometry, mats]);

  const heads = useRef<Array<Group | null>>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    screen.uTime.value = t;
    HEADS.forEach((_, i) => {
      const h = heads.current[i];
      if (!h) return;
      // Sweep out over the crowd and back, mirrored pairs, colours stepping on.
      const phase = t * 0.7 + i * 0.9;
      h.rotation.set(-0.35 - 0.35 * Math.sin(phase), 0, 0.45 * Math.sin(t * 0.5 + (i % 2 ? Math.PI : 0)));
      const mat = beamMats[i];
      mat.color.copy(BEAM_COLOURS[(i + Math.floor(t / 4)) % BEAM_COLOURS.length]);
    });
  });

  if (!site) return null;
  return (
    <group position={[site.x, site.y, site.z]} rotation={[0, site.heading, 0]}>
      <primitive object={stage} />
      <mesh geometry={rig.truss} material={mats.truss} castShadow />
      <mesh geometry={rig.speakers} material={mats.speaker} castShadow receiveShadow />
      <mesh geometry={rig.barrier} material={mats.barrier} castShadow />
      {HEADS.map((x, i) => (
        <group key={i} position={[x, TRUSS_Y - 0.45, TOWER_Z[1]]} ref={(g) => { heads.current[i] = g; }}>
          <mesh geometry={headGeometry} material={mats.head} />
          <mesh geometry={beam} material={beamMats[i]} position={[0, -0.25, 0]} renderOrder={2} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        {/* The deck, the backdrop, the towers, the stacks and the barrier. */}
        <CuboidCollider args={[8.08, DECK / 2, (FRONT + 6) / 2]} position={[0, DECK / 2, (FRONT - 6) / 2]} />
        <CuboidCollider args={[HALF_W, 4, 1.3]} position={[0, 4, -4.5]} />
        {TOWER_Z.flatMap((z) => [-TOWER_X, TOWER_X].map((x) => (
          <CuboidCollider key={`t${x}${z}`} args={[TRUSS_W / 2, TRUSS_Y / 2, TRUSS_W / 2]} position={[x, TRUSS_Y / 2, z]} />
        )))}
        {[-1, 1].map((s) => (
          <CuboidCollider key={`s${s}`} args={[0.75, 1.6, 0.55]} position={[s * (HALF_W + 1.4), 1.6, FRONT + 0.8]} />
        ))}
        <CuboidCollider args={[rig.barrierSpan, 0.55, 0.2]} position={[0, 0.55, rig.barrierZ]} />
      </RigidBody>
    </group>
  );
}
