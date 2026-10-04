'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute, BufferGeometry, Color, RingGeometry, ShaderMaterial, Vector3, type Mesh,
} from 'three';
import { VEHICLE } from '@/config/vehicleConfig';
import { damp } from '@/physics/vehiclePhysics';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * What sells speed on screen, without a post-processing pass.
 *
 * The game used to route the scene through an `EffectComposer` and took it out
 * (see the grade comment in `RacingScene`): a full-screen render target on a
 * 3 M triangle scene, and it threw away the canvas's MSAA. A real motion blur
 * would need exactly that again, so this does two cheap, physical things:
 *
 *  - DUST. Specks of grit hanging in the air just over the road. They are
 *    still in the WORLD — it is the car that moves through them — so their
 *    parallax is the real thing: the near ones flick past, the far ones barely
 *    drift. Each is smeared along the car's velocity by a camera shutter's
 *    worth of travel, which is what a real lens does to a speck at speed. The
 *    field is a box that wraps around the car, so a few hundred specks are
 *    enough for any distance driven; all the placing is in the vertex shader.
 *  - EDGES. A soft darkening of the frame's corners, as a real lens has,
 *    deepening a little with speed. A ring in clip space rather than a
 *    full-screen quad, so the middle of the screen is never shaded.
 *
 * Cost: two draw calls and ~1,900 triangles, both skipped below the speed
 * they start at.
 */

const SPECKS = 900;
/** Side of the square the dust wraps in, metres, and how far ahead of the car it is centred. */
const BOX = 40;
const AHEAD = 10;
/** Seconds of travel a speck is smeared over: a 1/150 s shutter. */
const SHUTTER = 1 / 150;
/** km/h at which the dust begins to show, and is full. */
const DUST_FROM = 50;
const DUST_FULL = 200;
/** And the same for the corners. */
const EDGE_FROM = 110;
const EDGE_FULL = 300;

const smoothstep = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function buildDust(): BufferGeometry {
  const seed4 = new Float32Array(SPECKS * 4 * 4);
  const corner = new Float32Array(SPECKS * 4 * 2);
  const index = new Uint16Array(SPECKS * 6);
  // A fixed seed: the same dust every load.
  let seed = 0x2f6b9a1d;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let i = 0; i < SPECKS; i++) {
    const values = [rnd(), rnd(), rnd(), 0.25 + rnd() * 0.75];
    for (let v = 0; v < 4; v++) {
      seed4.set(values, (i * 4 + v) * 4);
      corner.set([v >> 1, (v & 1) * 2 - 1], (i * 4 + v) * 2);
    }
    const b = i * 4;
    index.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
  }
  const geometry = new BufferGeometry();
  // Three needs a position to count vertices; the shader never reads it.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(SPECKS * 4 * 3), 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seed4, 4));
  geometry.setAttribute('aCorner', new BufferAttribute(corner, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

const DUST_VERTEX = /* glsl */ `
  uniform vec3 uAnchor;
  uniform vec3 uVel;
  uniform float uTime;
  attribute vec4 aSeed;
  attribute vec2 aCorner;
  varying float vAlpha;
  varying float vSide;
  const float BOX = ${BOX.toFixed(1)};
  void main() {
    // Fixed in the world, drifting a little on the air, wrapped into the box
    // around the car so the field never runs out.
    vec2 origin = uAnchor.xz - BOX * 0.5;
    vec2 drift = vec2(sin(uTime * 0.31 + aSeed.z * 40.0), cos(uTime * 0.23 + aSeed.x * 40.0)) * 0.4;
    vec2 local = mod(aSeed.xy * BOX + drift - origin, BOX);
    // Most of it hugs the road; a little is thrown up to wheel-arch height.
    float height = 0.03 + aSeed.z * aSeed.z * aSeed.z * 1.3;
    vec3 world = vec3(origin + local, uAnchor.y + height).xzy;

    // The shutter smear: where the speck sat, relative to the lens, a moment ago.
    vec3 a = (viewMatrix * vec4(world, 1.0)).xyz;
    vec3 b = (viewMatrix * vec4(world + uVel * ${SHUTTER.toFixed(5)}, 1.0)).xyz;
    vec3 along = b - a;
    float len = length(along);
    vec3 dir = len > 1e-4 ? along / len : vec3(1.0, 0.0, 0.0);
    b = a + dir * max(len, 0.012);
    vec3 eye = mix(a, b, aCorner.x);
    vec3 side = normalize(cross(dir, normalize(eye)));
    float dist = length(a);
    // A grain of grit, thickened a touch with distance so it does not
    // sparkle in and out as a sub-pixel line.
    eye += side * aCorner.y * (0.007 + dist * 0.0009);

    vec2 edge = min(local, BOX - local) / (BOX * 0.08);
    vAlpha = aSeed.w
      * smoothstep(1.2, 3.0, dist) * (1.0 - smoothstep(12.0, 24.0, dist))
      * clamp(min(edge.x, edge.y), 0.0, 1.0);
    vSide = aCorner.y;
    gl_Position = projectionMatrix * vec4(eye, 1.0);
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vSide;
  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vAlpha * (1.0 - vSide * vSide));
  }
`;

const EDGE_VERTEX = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  uniform float uStrength;
  uniform float uInner;
  uniform vec3 uTint;
  varying vec2 vNdc;
  void main() {
    // In clip space the ring is the screen's own ellipse, so the darkening
    // follows the frame's shape rather than a circle cropped by it.
    float r = length(vNdc);
    float a = smoothstep(uInner, 1.45, r);
    gl_FragColor = vec4(uTint, a * a * uStrength);
  }
`;

interface SpeedFxProps {
  telemetry: RefObject<VehicleTelemetry>;
  /** 0..1 from the SPEED FX setting. */
  scale: number;
}

export function SpeedFx({ telemetry, scale }: SpeedFxProps) {
  const dustRef = useRef<Mesh>(null);
  const edgeRef = useRef<Mesh>(null);
  const dustLevel = useRef(0);
  const edgeLevel = useRef(0);

  const dustGeometry = useMemo(() => buildDust(), []);
  const dustMaterial = useMemo(() => new ShaderMaterial({
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    uniforms: {
      uAnchor: { value: new Vector3() },
      uVel: { value: new Vector3() },
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      // Sunlit grit: a pale warm sand. It has to be lighter than the tarmac
      // it is seen against — a grey speck over a grey road is not there.
      uColor: { value: new Color(0.78, 0.73, 0.64) },
    },
    transparent: true,
    depthWrite: false,
  }), []);

  const edgeGeometry = useMemo(() => new RingGeometry(0.6, 1.5, 48, 1), []);
  const edgeMaterial = useMemo(() => new ShaderMaterial({
    vertexShader: EDGE_VERTEX,
    fragmentShader: EDGE_FRAGMENT,
    uniforms: {
      uStrength: { value: 0 },
      uInner: { value: 0.85 },
      uTint: { value: new Color(0.01, 0.012, 0.018) },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }), []);

  useFrame((state, rawDelta) => {
    const t = telemetry.current;
    const dust = dustRef.current;
    const edge = edgeRef.current;
    if (!t || !dust || !edge) return;
    const delta = Math.min(rawDelta, 1 / 20);

    // Damped, so a shunt or a kerb does not flick the effect on and off.
    dustLevel.current = damp(dustLevel.current, smoothstep(DUST_FROM, DUST_FULL, t.speedKph), 0.25, delta);
    edgeLevel.current = damp(edgeLevel.current, smoothstep(EDGE_FROM, EDGE_FULL, t.speedKph), 0.4, delta);

    const dustAmount = dustLevel.current * scale;
    dust.visible = dustAmount > 0.01;
    if (dust.visible) {
      const u = dustMaterial.uniforms;
      // The road under the car: the chassis, down its front-left strut to the
      // contact patch. Good enough on a slope; the dust is only 40 m across.
      const wheel = VEHICLE.wheels[0];
      const ground = t.y + wheel.connection[1] - t.wheels[wheel.corner].suspensionLength - wheel.radius;
      const fx = -Math.sin(t.heading);
      const fz = -Math.cos(t.heading);
      (u.uAnchor.value as Vector3).set(t.x + fx * AHEAD, ground, t.z + fz * AHEAD);
      (u.uVel.value as Vector3).set(fx * t.forwardSpeed, 0, fz * t.forwardSpeed);
      u.uTime.value = state.clock.elapsedTime;
      u.uOpacity.value = dustAmount * 0.75;
    }

    const edgeAmount = edgeLevel.current * scale;
    edge.visible = edgeAmount > 0.01;
    if (edge.visible) {
      const u = edgeMaterial.uniforms;
      u.uStrength.value = edgeAmount * 0.4;
      u.uInner.value = 0.85 - edgeAmount * 0.1;
    }
  });

  return (
    <>
      <mesh
        ref={dustRef}
        geometry={dustGeometry}
        material={dustMaterial}
        frustumCulled={false}
        renderOrder={9998}
        visible={false}
      />
      <mesh
        ref={edgeRef}
        geometry={edgeGeometry}
        material={edgeMaterial}
        frustumCulled={false}
        renderOrder={9999}
        visible={false}
      />
    </>
  );
}
