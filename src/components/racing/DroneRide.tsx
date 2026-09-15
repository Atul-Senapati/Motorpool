'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CuboidCollider, RigidBody, useBeforePhysicsStep, useRapier, type RapierRigidBody,
} from '@react-three/rapier';
import {
  CanvasTexture, DoubleSide, Euler, Mesh, MeshBasicMaterial, Object3D, Quaternion, type Group,
} from 'three';
import { DRACO_PATH, CITY } from '@/config/cityConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { DRONE, DRONE_MODEL, FLIGHT, pickDroneSpawn } from '@/config/droneConfig';
import type { RawInput } from '@/hooks/useKeyboardControls';
import type { VehicleTelemetry } from '@/types/vehicle';

useGLTF.preload(DRONE_MODEL, DRACO_PATH);

/**
 * Flying the drone.
 *
 * Four sticks, each a velocity you ask for — see `FLIGHT` for the model. Like
 * the boat and the trains, the airframe is a kinematic body integrated here
 * rather than a dynamic one pushed about by the solver: what holds a quad up
 * is its motors, not a contact, and a dynamic body would spend its life
 * falling. The collider still shoulders traffic aside if you fly into it.
 *
 *   W / S      forward and back          ↑ / ↓    climb and descend
 *   A / D      slide left and right      ← / →    turn (yaw)
 *   SHIFT      sport — double the caps   SPACE    brake to a hover
 *   R          back to the launch point
 *
 * The body tilts into its own acceleration (pitch for forward, roll for a
 * slide), which is the one thing that makes a quad read as flying rather than
 * as a camera on rails. Over the skids it will not go below `clearance`
 * metres from whatever is under it — a ray finds the roof, the road or the
 * sea — and it stops at `ceiling`.
 */

interface DroneRideProps {
  input: RefObject<RawInput>;
  telemetry: RefObject<VehicleTelemetry>;
  chassisRef: RefObject<Group | null>;
}

interface DroneState {
  x: number; y: number; z: number;
  heading: number;
  vx: number; vy: number; vz: number;
  yawRate: number;
  /** Visual attitude, radians, eased toward the asked-for tilt. */
  pitch: number; roll: number;
  /** Prop-blur angle and rate. */
  spin: number; spinRate: number;
  /** Ground under the skids on the last step, world y. */
  ground: number;
}

const SPAWN = pickDroneSpawn();
const WORLD_MIN_X = CITY.bounds.min[0] - FLIGHT.margin;
const WORLD_MAX_X = CITY.bounds.max[0] + FLIGHT.margin;
const WORLD_MIN_Z = CITY.bounds.min[2] - FLIGHT.margin;
const WORLD_MAX_Z = CITY.bounds.max[2] + FLIGHT.margin;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const approach = (v: number, target: number, maxStep: number) =>
  v + clamp(target - v, -maxStep, maxStep);

/**
 * A prop-blur disc: what a spinning propeller looks like to a camera. Radial
 * streaks, dense near the hub and fading out, a little brighter where the
 * blade tips catch the light. Drawn once, shared by all four.
 */
function propBlur(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  // The disc, fading toward the rim.
  const disc = ctx.createRadialGradient(c, c, 0, c, c, c);
  disc.addColorStop(0, 'rgba(20,22,26,0.75)');
  disc.addColorStop(0.35, 'rgba(20,22,26,0.42)');
  disc.addColorStop(0.9, 'rgba(30,32,36,0.22)');
  disc.addColorStop(1, 'rgba(30,32,36,0)');
  ctx.fillStyle = disc;
  ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
  // Two blade ghosts, wide and soft.
  for (let i = 0; i < 2; i++) {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(i * Math.PI);
    const blade = ctx.createLinearGradient(0, 0, c, 0);
    blade.addColorStop(0, 'rgba(0,0,0,0.55)');
    blade.addColorStop(1, 'rgba(60,64,70,0.05)');
    ctx.fillStyle = blade;
    ctx.beginPath();
    ctx.moveTo(0, -c * 0.06);
    ctx.quadraticCurveTo(c * 0.6, -c * 0.16, c * 0.98, -c * 0.04);
    ctx.lineTo(c * 0.98, c * 0.04);
    ctx.quadraticCurveTo(c * 0.6, c * 0.16, 0, c * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // The tip ring.
  ctx.strokeStyle = 'rgba(200,210,220,0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(c, c, c - 3, 0, Math.PI * 2); ctx.stroke();
  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

export function DroneRide({ input, telemetry, chassisRef }: DroneRideProps) {
  const { scene } = useGLTF(DRONE_MODEL, DRACO_PATH);
  const body = useRef<RapierRigidBody>(null);
  const rotorRefs = useRef<(Mesh | null)[]>([]);

  const model = useMemo(() => {
    const copy = (scene as unknown as Object3D).clone(true);
    copy.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    return copy;
  }, [scene]);

  const blur = useMemo(() => {
    const material = new MeshBasicMaterial({
      map: propBlur(), transparent: true, depthWrite: false, side: DoubleSide,
    });
    return material;
  }, []);

  const state = useRef<DroneState>({
    x: SPAWN.position[0], y: SPAWN.position[1], z: SPAWN.position[2],
    heading: SPAWN.heading,
    vx: 0, vy: 0, vz: 0, yawRate: 0,
    pitch: 0, roll: 0, spin: 0, spinRate: FLIGHT.spinIdle,
    ground: -Infinity,
  });

  const { world, rapier } = useRapier();
  const ray = useMemo(() => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }), [rapier]);
  /** World y of the first fixed surface under (x, z), cast from just over the skids. */
  const groundAt = (x: number, y: number, z: number): number => {
    ray.origin.x = x; ray.origin.y = y + 0.5; ray.origin.z = z;
    const hit = world.castRay(ray, FLIGHT.ceiling + 100, true, undefined, undefined, undefined,
      body.current ?? undefined, (collider) => collider.parent()?.isFixed() ?? false);
    return hit ? ray.origin.y - hit.timeOfImpact : -Infinity;
  };

  const scratch = useMemo(() => ({
    quaternion: new Quaternion(),
    euler: new Euler(0, 0, 0, 'YXZ'),
  }), []);

  useBeforePhysicsStep(() => {
    const b = body.current;
    const i = input.current;
    const t = telemetry.current;
    if (!b || !i || !t) return;
    const s = state.current;
    const dt = PHYSICS_TIMESTEP;

    if (i.resetRequested) {
      i.resetRequested = false;
      s.x = SPAWN.position[0]; s.y = SPAWN.position[1]; s.z = SPAWN.position[2];
      s.heading = SPAWN.heading;
      s.vx = 0; s.vy = 0; s.vz = 0; s.yawRate = 0; s.pitch = 0; s.roll = 0;
    }

    const sport = i.boost;
    const hold = i.handbrake;
    const cap = sport ? FLIGHT.sport : FLIGHT.cruise;
    const climbCap = sport ? FLIGHT.climb * 2 : FLIGHT.climb;

    /* --------------------------------------------------------- yaw */
    const wantedYaw = -i.yawAxis * FLIGHT.yawRate;
    s.yawRate = approach(s.yawRate, wantedYaw, FLIGHT.yawAccel * dt);
    s.heading += s.yawRate * dt;

    /* ------------------------------------------- horizontal velocity */
    const fx = -Math.sin(s.heading);
    const fz = -Math.cos(s.heading);
    const rx = -fz;
    const rz = fx;
    // The asked-for velocity, in the body frame, then in the world.
    const wantAhead = hold ? 0 : i.moveAxis * cap;
    const wantSide = hold ? 0 : i.strafeAxis * cap;
    const wantVx = fx * wantAhead + rx * wantSide;
    const wantVz = fz * wantAhead + rz * wantSide;
    const asking = i.moveAxis !== 0 || i.strafeAxis !== 0;
    // Accelerate toward it, capped; coast (drag) when nothing is asked; brake
    // hard when SPACE is held.
    const accel = hold ? FLIGHT.brake : asking ? FLIGHT.accel : FLIGHT.accel * 0.6;
    let dvx = wantVx - s.vx;
    let dvz = wantVz - s.vz;
    const dv = Math.hypot(dvx, dvz);
    const step = accel * dt;
    if (dv > step) { dvx *= step / dv; dvz *= step / dv; }
    const ax = dvx / dt;
    const az = dvz / dt;
    s.vx += dvx;
    s.vz += dvz;
    if (!asking && !hold) {
      const keep = Math.pow(FLIGHT.drag, dt);
      s.vx *= keep; s.vz *= keep;
    }

    /* -------------------------------------------------- vertical */
    const wantVy = hold ? 0 : i.climbAxis * climbCap;
    s.vy = approach(s.vy, wantVy, FLIGHT.climbAccel * dt);

    /* -------------------------------------------------- integrate */
    s.x = clamp(s.x + s.vx * dt, WORLD_MIN_X, WORLD_MAX_X);
    s.z = clamp(s.z + s.vz * dt, WORLD_MIN_Z, WORLD_MAX_Z);
    s.y += s.vy * dt;
    // The floor: whatever is under the skids, plus clearance. Cast every step
    // — it is one ray, and a roof edge is exactly where a stale reading hurts.
    s.ground = groundAt(s.x, s.y, s.z);
    const floor = (Number.isFinite(s.ground) ? s.ground : -Infinity) + FLIGHT.clearance;
    if (s.y < floor) { s.y = floor; if (s.vy < 0) s.vy = 0; }
    if (s.y > FLIGHT.ceiling) { s.y = FLIGHT.ceiling; if (s.vy > 0) s.vy = 0; }

    /* --------------------------------------------------- attitude */
    // Tilt into the acceleration: forward accel pitches the nose down,
    // a slide to the right rolls right. Body-frame components of (ax, az).
    const aAhead = ax * fx + az * fz;
    const aSide = ax * rx + az * rz;
    const wantPitch = clamp(-aAhead * FLIGHT.tiltPerAccel, -FLIGHT.tiltMax, FLIGHT.tiltMax);
    const wantRoll = clamp(-aSide * FLIGHT.tiltPerAccel, -FLIGHT.tiltMax, FLIGHT.tiltMax);
    const k = 1 - Math.pow(0.5, dt / FLIGHT.tiltHalfLife);
    s.pitch += (wantPitch - s.pitch) * k;
    s.roll += (wantRoll - s.roll) * k;

    /* ------------------------------------------------------ motors */
    const effort = clamp(
      Math.hypot(s.vx, s.vz) / FLIGHT.sport * 0.6 + Math.abs(s.vy) / FLIGHT.climb * 0.3
        + (asking || i.climbAxis !== 0 ? 0.25 : 0), 0, 1);
    s.spinRate += ((FLIGHT.spinIdle + (FLIGHT.spinFull - FLIGHT.spinIdle) * effort) - s.spinRate) * Math.min(1, dt * 4);
    s.spin += s.spinRate * dt;

    /* -------------------------------------------------------- pose */
    scratch.euler.set(s.pitch, s.heading, s.roll);
    scratch.quaternion.setFromEuler(scratch.euler);
    b.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
    b.setNextKinematicRotation(scratch.quaternion);

    /* --------------------------------------------------- telemetry */
    const horizontal = Math.hypot(s.vx, s.vz);
    t.x = s.x; t.y = s.y; t.z = s.z;
    t.heading = s.heading;
    t.speedKph = Math.hypot(horizontal, s.vy) * 3.6;
    t.forwardSpeed = s.vx * fx + s.vz * fz;
    t.braking = hold;
    t.reversing = false;
    t.handbrake = hold;
    t.gear = 1;
    t.rpm = FLIGHT.idleRpm + (FLIGHT.maxRpm - FLIGHT.idleRpm) * effort;
    t.boost = 1;
    t.boosting = sport && asking;
    t.slip = 0;
    t.upright = 1;
    t.agl = Number.isFinite(s.ground) ? s.y - s.ground : s.y;
    for (const wheel of [t.wheels.FL, t.wheels.FR, t.wheels.RL, t.wheels.RR]) wheel.inContact = true;
  });

  useFrame(() => {
    const s = state.current;
    const group = chassisRef.current;
    if (!group) return;
    group.position.set(s.x, s.y, s.z);
    scratch.euler.set(s.pitch, s.heading, s.roll);
    group.quaternion.setFromEuler(scratch.euler);
    for (let k = 0; k < rotorRefs.current.length; k++) {
      const rotor = rotorRefs.current[k];
      if (rotor) rotor.rotation.z = (k % 2 === 0 ? 1 : -1) * s.spin;
    }
  });

  const half = DRONE.size.map((v) => v / 2);

  return (
    <>
      <RigidBody
        ref={body}
        type="kinematicPosition"
        colliders={false}
        position={[SPAWN.position[0], SPAWN.position[1], SPAWN.position[2]]}
      >
        <CuboidCollider
          args={[half[0] * 0.8, half[1], half[2] * 0.8]}
          position={[0, half[1], 0]}
          friction={0.3}
          restitution={0.1}
        />
      </RigidBody>

      <group ref={chassisRef}>
        <primitive object={model} />
        {/* The prop discs, flat over each motor hub. `rotation.x` lays the
            circle flat; the spin goes on `rotation.z`. */}
        {DRONE.rotors.map((p, k) => (
          <mesh
            key={k}
            ref={(el) => { rotorRefs.current[k] = el; }}
            position={[p[0], p[1], p[2]]}
            rotation={[-Math.PI / 2, 0, 0]}
            material={blur}
          >
            <circleGeometry args={[DRONE.rotorRadius, 40]} />
          </mesh>
        ))}
      </group>
    </>
  );
}
