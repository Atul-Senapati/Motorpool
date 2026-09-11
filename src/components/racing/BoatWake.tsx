'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide,
  DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Points,
  Quaternion, ShaderMaterial, Vector3,
} from 'three';
import { seaHeightAt, seaSlopeAt } from '@/config/seaConfig';
import type { BoatHull } from '@/config/boatConfig';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * What a boat leaves behind it: wake, ripples and spray.
 *
 * A hull moving through water with no mark on it is the single biggest tell
 * that the sea is a painted plane — more than the wave shape, more than the
 * lighting, because the eye reads *disturbance* as the proof that the two
 * things are touching. Three effects, each of which is doing a different job:
 *
 *   wake     a flattened, foamy path down the boat's track. The one that
 *            matters most: it is what makes the water look like a substance
 *            the boat is displacing rather than a floor it is sliding on.
 *   ripples  rings shed from the hull, expanding and fading. These carry the
 *            LOW-speed case — a boat idling in a marina throws no spray and
 *            leaves no wake worth the name, and without rings it sits in the
 *            water like an ornament.
 *   spray    thrown up at the bow, and only when the boat is really moving.
 *            The high-speed case, and the one that reads as effort.
 *
 * ## How they are drawn
 *
 * The wake and the ripples are flat quads lying on the surface, both in one
 * instanced mesh each, with `AdditiveBlending` — so a fading instance is one
 * that goes to black, and one colour write per instance per frame is the
 * whole animation. That is the same trick the brake lamps use, and it is why
 * this costs two draw calls no matter how long the wake is.
 *
 * They lie on the wave surface — at `seaHeightAt`, tilted to `seaSlopeAt`.
 *
 * This has flipped once and the reason is worth keeping. When the sea was a
 * flat plane whose normal waved (`Environment`), foam laid at `seaHeightAt`
 * was up to half a metre off the drawn surface, so half the wake was under
 * an opaque sea and the rest hovered, and the rule became "anything ON the
 * water goes on the plane". Now the water round the camera is real, displaced
 * geometry (`SeaSurface`) driven by the very same wave table, so the drawn
 * surface IS `seaHeightAt`, and foam on the flat plane would be the thing
 * buried in every crest. The quads are re-laid every frame — the waves move
 * under a wake that does not — and tilted to the local slope, because a 5 m
 * quad lying level across a 4° face still shows a corner through the water.
 *
 * The spray is a `Points` pool, the same shape as `TyreSmoke` — a fixed
 * ring buffer, recycled round-robin, integrated only where alive.
 */

/** Quads in the foam trail, and how long each lasts. */
const WAKE_QUADS = 140;
const WAKE_LIFE = 5.5;
/**
 * Metres of travel between one quad and the next.
 *
 * With the quads as long as they are, this is about a third of a quad's
 * length — enough overlap that the trail is continuous, little enough that
 * three of them are not stacked on the same water. Additive blending makes
 * over-lapping expensive to look at: the first version shed every 2.4 m and
 * the wake came out as a white field rather than a track.
 */
const WAKE_PITCH = 3.4;

/** Expanding rings, and their life. */
const RINGS = 28;
const RING_LIFE = 2.8;

/** Spray droplets. */
const DROPS = 200;
const DROP_LIFE = 0.9;
/** Below this there is no spray at all — a boat has to be working for it. */
const SPRAY_KPH = 18;

/** A soft foam blob: bright in the middle, gone by the edge. */
function makeFoamTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.62)');
  gradient.addColorStop(0.45, 'rgba(240,250,255,0.30)');
  gradient.addColorStop(1, 'rgba(230,245,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  // A little mottle, so a big quad does not read as an airbrushed disc.
  let seed = 31;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  for (let i = 0; i < 400; i++) {
    const r = random() * size * 0.45;
    const a = random() * Math.PI * 2;
    ctx.fillStyle = `rgba(255,255,255,${0.05 + random() * 0.12})`;
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, 1 + random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return new CanvasTexture(canvas);
}

/** A ring: nothing in the middle, a bright rim, nothing outside. */
function makeRingTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.62, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.78, 'rgba(245,252,255,0.5)');
  gradient.addColorStop(0.9, 'rgba(240,250,255,0.16)');
  gradient.addColorStop(1, 'rgba(240,250,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

/** A flat quad on the water: a unit plane laid down, so scale is metres. */
function surfaceQuad(): PlaneGeometry {
  const plane = new PlaneGeometry(1, 1);
  plane.rotateX(-Math.PI / 2);
  return plane;
}

interface Slot {
  age: number;
  x: number;
  z: number;
  /** Radians about Y — the wake's quads lie along the track. */
  turn: number;
  /** Metres, at birth. */
  size: number;
  /** How bright this one starts, which is how hard the boat was working. */
  strength: number;
}

export function BoatWake({
  telemetry,
  hull,
}: {
  telemetry: RefObject<VehicleTelemetry>;
  hull: BoatHull;
}) {
  const wakeRef = useRef<InstancedMesh>(null);
  const ringRef = useRef<InstancedMesh>(null);
  const dropRef = useRef<Points>(null);

  const built = useMemo(() => {
    const surface = (texture: CanvasTexture) => new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      side: DoubleSide,
    });

    // --- spray ---------------------------------------------------------
    const positions = new Float32Array(DROPS * 3);
    const sizes = new Float32Array(DROPS);
    const alphas = new Float32Array(DROPS);
    const ages = new Float32Array(DROPS).fill(DROP_LIFE * 2);
    const velocities = new Float32Array(DROPS * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('size', new BufferAttribute(sizes, 1));
    geometry.setAttribute('alpha', new BufferAttribute(alphas, 1));
    geometry.boundingSphere = null;
    const dropMaterial = new ShaderMaterial({
      uniforms: { uMap: { value: makeFoamTexture() } },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 300.0 / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.002) discard;
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(tex.rgb, tex.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    return {
      wakeGeometry: surfaceQuad(),
      wakeMaterial: surface(makeFoamTexture()),
      ringGeometry: surfaceQuad(),
      ringMaterial: surface(makeRingTexture()),
      drops: { geometry, material: dropMaterial, positions, sizes, alphas, ages, velocities },
      wake: Array.from({ length: WAKE_QUADS }, (): Slot => (
        { age: WAKE_LIFE * 2, x: 0, z: 0, turn: 0, size: 1, strength: 0 })),
      rings: Array.from({ length: RINGS }, (): Slot => (
        { age: RING_LIFE * 2, x: 0, z: 0, turn: 0, size: 1, strength: 0 })),
    };
  }, []);

  const scratch = useMemo(() => ({
    matrix: new Matrix4(),
    position: new Vector3(),
    quaternion: new Quaternion(),
    tilt: new Quaternion(),
    normal: new Vector3(),
    scale: new Vector3(1, 1, 1),
    colour: new Color(),
    cursor: 0,
    ringCursor: 0,
    dropCursor: 0,
    /** Metres since the last wake quad, and seconds since the last ring. */
    sinceQuad: 0,
    sinceRing: 0,
    seed: 7,
  }), []);

  useFrame((frame, rawDelta) => {
    const t = telemetry.current;
    const wakeMesh = wakeRef.current;
    const ringMesh = ringRef.current;
    if (!t || !wakeMesh || !ringMesh) return;
    const delta = Math.min(rawDelta, 1 / 20);
    // The same clock the sea shader and the hull physics read, so the foam is
    // on the wave that is drawn, not one a frame away from it.
    const time = frame.clock.elapsedTime;
    /** Lay a quad on the water at (x, z): on the wave, tilted along it. */
    const onWater = (x: number, z: number, turn: number, lift: number) => {
      scratch.position.set(x, seaHeightAt(x, z, time) + lift, z);
      const [sx, sz] = seaSlopeAt(x, z, time);
      // A surface with slope (sx, sz) has normal (-sx, 1, -sz); the quad's
      // own up is +Y, so this is the rotation from one to the other, with the
      // quad's heading applied first so the wake still lies along the track.
      scratch.normal.set(-sx, 1, -sz).normalize();
      scratch.tilt.setFromUnitVectors(UP, scratch.normal);
      scratch.quaternion.setFromAxisAngle(UP, turn).premultiply(scratch.tilt);
    };
    const random = () => {
      scratch.seed = (scratch.seed * 16807) % 2147483647;
      return scratch.seed / 2147483647;
    };

    const speed = t.speedKph / 3.6;
    const forwardX = -Math.sin(t.heading);
    const forwardZ = -Math.cos(t.heading);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const half = hull.size[2] / 2;
    const beam = hull.size[0];

    /* ------------------------------------------------------------- wake */

    // Shed by DISTANCE, not by time: a boat crawling astern should leave the
    // same trail per metre as one at speed, or the wake bunches up at the
    // quay and thins out at sea.
    scratch.sinceQuad += speed * delta;
    if (speed > 0.4 && scratch.sinceQuad >= WAKE_PITCH) {
      scratch.sinceQuad = 0;
      const slot = built.wake[scratch.cursor];
      scratch.cursor = (scratch.cursor + 1) % WAKE_QUADS;
      slot.age = 0;
      // Laid at the stern, where the water closes back in behind the hull.
      slot.x = t.x - forwardX * half + (random() - 0.5) * beam * 0.3;
      slot.z = t.z - forwardZ * half + (random() - 0.5) * beam * 0.3;
      slot.turn = t.heading;
      // A wake is a couple of beams wide behind the boat and spreads slowly.
      // It is NOT the width of the disturbance you see from a helicopter,
      // which is what a quad scaled on speed alone turns into.
      slot.size = beam * (0.7 + Math.min(0.5, speed / 30));
      slot.strength = Math.min(0.7, 0.16 + speed / 42);
    }

    /* ------------------------------------------------------------ rings */

    // Rings come off the hull whatever it is doing, a little faster when it
    // is moving. They are what the boat has instead of a wake at idle.
    scratch.sinceRing += delta;
    const ringEvery = speed > 1 ? 0.32 : 0.7;
    if (scratch.sinceRing >= ringEvery) {
      scratch.sinceRing = 0;
      const slot = built.rings[scratch.ringCursor];
      scratch.ringCursor = (scratch.ringCursor + 1) % RINGS;
      slot.age = 0;
      // Off one bow or the other, so the pair reads as a V rather than as a
      // target painted round the boat.
      const side = random() < 0.5 ? -1 : 1;
      const along = (random() * 0.7) * half;
      slot.x = t.x + forwardX * along + rightX * side * beam * 0.5;
      slot.z = t.z + forwardZ * along + rightZ * side * beam * 0.5;
      slot.turn = 0;
      slot.size = beam * 0.55;
      slot.strength = Math.min(0.75, 0.28 + speed / 30);
    }

    /* ------------------------------------------------------------ spray */

    const { positions, sizes, alphas, ages, velocities } = built.drops;
    if (t.speedKph > SPRAY_KPH) {
      // More of it the faster you go, and thrown wider.
      const rate = Math.min(9, (t.speedKph - SPRAY_KPH) / 6);
      const wanted = Math.floor(rate) + (random() < rate % 1 ? 1 : 0);
      for (let n = 0; n < wanted; n++) {
        const p = scratch.dropCursor;
        scratch.dropCursor = (scratch.dropCursor + 1) % DROPS;
        const side = random() < 0.5 ? -1 : 1;
        // At the bow shoulder, where a hull actually throws water.
        const along = half * (0.55 + random() * 0.4);
        positions[p * 3] = t.x + forwardX * along + rightX * side * beam * 0.45;
        positions[p * 3 + 1] = t.y + 0.2 + random() * 0.3;
        positions[p * 3 + 2] = t.z + forwardZ * along + rightZ * side * beam * 0.45;
        // Out to the side and up, plus a little of the boat's own way.
        const throwOut = 1.6 + speed * 0.16;
        velocities[p * 3] = rightX * side * throwOut + forwardX * speed * 0.25;
        velocities[p * 3 + 1] = 1.4 + random() * 1.8;
        velocities[p * 3 + 2] = rightZ * side * throwOut + forwardZ * speed * 0.25;
        ages[p] = 0;
      }
    }

    /* --------------------------------------------------------- integrate */

    let live = 0;
    for (const slot of built.wake) {
      if (slot.age >= WAKE_LIFE) continue;
      slot.age += delta;
      const life = slot.age / WAKE_LIFE;
      // The foam spreads and thins, as a wake does.
      const size = slot.size * (1 + life * 1.1);
      onWater(slot.x, slot.z, slot.turn, 0.06);
      scratch.scale.set(size, 1, size * 1.35);
      wakeMesh.setMatrixAt(live, scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale));
      const fade = slot.strength * Math.max(0, 1 - life) * (life < 0.08 ? life / 0.08 : 1);
      wakeMesh.setColorAt(live, scratch.colour.setScalar(fade));
      live++;
    }
    wakeMesh.count = live;
    wakeMesh.instanceMatrix.needsUpdate = true;
    if (wakeMesh.instanceColor) wakeMesh.instanceColor.needsUpdate = true;

    let rings = 0;
    for (const slot of built.rings) {
      if (slot.age >= RING_LIFE) continue;
      slot.age += delta;
      const life = slot.age / RING_LIFE;
      const size = slot.size * (1 + life * 5);
      onWater(slot.x, slot.z, 0, 0.05);
      scratch.scale.set(size, 1, size);
      ringMesh.setMatrixAt(rings, scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale));
      // Rings fade fast at the end: a ripple dies by spreading out, so the
      // last of it should be very faint rather than blinking off.
      ringMesh.setColorAt(rings, scratch.colour.setScalar(slot.strength * Math.max(0, 1 - life) ** 1.6));
      rings++;
    }
    ringMesh.count = rings;
    ringMesh.instanceMatrix.needsUpdate = true;
    if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;

    const { geometry } = built.drops;
    for (let p = 0; p < DROPS; p++) {
      if (ages[p] >= DROP_LIFE) {
        sizes[p] = 0;
        alphas[p] = 0;
        continue;
      }
      ages[p] += delta;
      velocities[p * 3 + 1] -= 9.8 * delta;
      positions[p * 3] += velocities[p * 3] * delta;
      positions[p * 3 + 1] += velocities[p * 3 + 1] * delta;
      positions[p * 3 + 2] += velocities[p * 3 + 2] * delta;
      const life = ages[p] / DROP_LIFE;
      sizes[p] = 0.35 + life * 1.1;
      alphas[p] = 0.75 * Math.max(0, 1 - life * life);
      // Gone the moment it lands: spray that keeps falling through the sea
      // is the thing you cannot unsee.
      if (positions[p * 3 + 1] < seaHeightAt(positions[p * 3], positions[p * 3 + 2], time)) {
        ages[p] = DROP_LIFE;
      }
    }
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('size').needsUpdate = true;
    geometry.getAttribute('alpha').needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={wakeRef}
        args={[built.wakeGeometry, built.wakeMaterial, WAKE_QUADS]}
        frustumCulled={false}
        renderOrder={2}
      >
        <instancedBufferAttribute
          attach="instanceColor"
          args={[new Float32Array(WAKE_QUADS * 3), 3]}
          usage={DynamicDrawUsage}
        />
      </instancedMesh>
      <instancedMesh
        ref={ringRef}
        args={[built.ringGeometry, built.ringMaterial, RINGS]}
        frustumCulled={false}
        renderOrder={2}
      >
        <instancedBufferAttribute
          attach="instanceColor"
          args={[new Float32Array(RINGS * 3), 3]}
          usage={DynamicDrawUsage}
        />
      </instancedMesh>
      <points
        ref={dropRef}
        geometry={built.drops.geometry}
        material={built.drops.material}
        frustumCulled={false}
      />
    </>
  );
}

/** Y axis, for laying a quad down flat. */
const UP = new Vector3(0, 1, 0);
