'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CuboidCollider, RigidBody, useBeforePhysicsStep, type RapierRigidBody,
} from '@react-three/rapier';
import { Euler, Mesh, Object3D, Quaternion, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import {
  BOATS, BOAT_MODEL, BOAT_SPAWN, HULLS, HYDRO, type BoatSpec,
} from '@/config/boatConfig';
import { SEA_LEVEL, seaHeightAt } from '@/config/seaConfig';
import { afloatAt } from '@/physics/seaNav';
import { BoatWake } from './BoatWake';
import type { RawInput } from '@/hooks/useKeyboardControls';
import type { VehicleTelemetry } from '@/types/vehicle';

useGLTF.preload(BOAT_MODEL, DRACO_PATH);

/**
 * Driving a boat.
 *
 * A car is a chassis on four springs and the road holds it up. A boat is held
 * up by the water, and the water is moving — so instead of the raycast vehicle
 * this is a plain Rapier body with four forces on it, and everything that
 * makes it feel like a boat is in how those four are balanced (`HYDRO`).
 *
 * ## The water is sampled at four points, and that is where the motion is
 *
 * The wave height is read under the bow, the stern and each beam. Their mean
 * is what the hull heaves toward — through a damped spring stiffened by the
 * boat's own waterplane, so the bob has the boat's real period and a light
 * hull answers a wave faster than a heavy one. Their *differences* are the
 * pitch and the roll: bow minus stern along the hull, starboard minus port
 * across it.
 *
 * Both attitudes are second-order — the hull accelerates toward the angle the
 * water is asking for and overshoots it — which is the whole difference
 * between a boat and a decal. The first version simply set the hull to the
 * wave's own slope each frame; it looks right in a screenshot and wrong in
 * motion, because nothing with mass tracks a ripple exactly.
 *
 * ## Drag is anisotropic, and that is what a keel is
 *
 * Velocity is split into "along the hull" and "across the hull", and the
 * across component is dragged `HYDRO.lateralRatio` times harder. A boat can
 * therefore be pointing somewhere other than where it is going, which is what
 * makes a turn a *slide into a new heading* rather than a car's pivot, and
 * what makes throttling through a turn feel like anything at all.
 *
 * ## The helm needs water moving past it
 *
 * Rudder authority ramps from nothing at `helmStall` to full at `helmFull`,
 * and reverses when going astern. A stopped boat cannot steer; that is not a
 * limitation to work around, it is the thing that makes coming alongside
 * something you have to think about.
 */

interface BoatRideProps {
  /**
   * The RAW input, not `VehicleInput`.
   *
   * The distinction cost this boat its steering: `steer` on the shared
   * interface is an *output* — the smoothed rack position that `CarPhysics`
   * writes back each step (`i.steer = v.update(...)`) — while what the
   * keyboard and the touch pad actually set is `steerAxis`. With no car
   * physics mounted, nothing ever wrote `steer`, so the helm read zero for
   * ever and the boat would not turn.
   */
  input: RefObject<RawInput>;
  telemetry: RefObject<VehicleTelemetry>;
  chassisRef: RefObject<Group | null>;
  /** Which hull. Comes from the garage's selection. */
  boat: string;
}

/** How the throttle maps to a note for the engine sound and the tacho. */
const IDLE_RPM = 700;
const MAX_RPM = 3400;

/**
 * The boat's own state, integrated here rather than by the solver.
 *
 * Position and heading are the boat's; `heave`, `pitch` and `roll` are its
 * attitude relative to the water, and they are separate because they are
 * driven by different things and settle at different rates — heave by
 * buoyancy against the wave under the hull, pitch by the wave's slope along
 * it plus the thrust trimming the bow up, roll by the wave across it plus the
 * heel of a turn.
 */
interface BoatState {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Velocity in world XZ, m/s. */
  vx: number;
  vz: number;
  /** Vertical velocity, m/s — the heave. */
  vy: number;
  yawRate: number;
  pitch: number;
  pitchRate: number;
  roll: number;
  rollRate: number;
}

export function BoatRide({ input, telemetry, chassisRef, boat }: BoatRideProps) {
  const { scene } = useGLTF(BOAT_MODEL, DRACO_PATH);
  const clock = useThree((state) => state.clock);
  const body = useRef<RapierRigidBody>(null);
  const spec: BoatSpec = BOATS[boat] ?? BOATS.yacht;
  const hull = HULLS[boat] ?? HULLS.yacht;

  /** The hull, lifted out of the fleet file by name. */
  const model = useMemo(() => {
    const found: Object3D[] = [];
    (scene as unknown as Object3D).traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const owner = (child.userData as { boat?: string }).boat
        ?? (child.parent?.userData as { boat?: string } | undefined)?.boat;
      if (owner === boat) found.push(child.clone());
    });
    for (const mesh of found) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    return found;
  }, [scene, boat]);

  const state = useRef<BoatState>({
    x: BOAT_SPAWN.position[0],
    y: SEA_LEVEL,
    z: BOAT_SPAWN.position[2],
    heading: BOAT_SPAWN.heading,
    vx: 0, vz: 0, vy: 0, yawRate: 0,
    pitch: 0, pitchRate: 0, roll: 0, rollRate: 0,
  });

  /** Where the wheel is, −1 to 1. Eased toward the key rather than snapped. */
  const helm = useRef(0);

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
    const time = clock.elapsedTime;

    if (i.resetRequested) {
      i.resetRequested = false;
      s.x = BOAT_SPAWN.position[0];
      s.z = BOAT_SPAWN.position[2];
      s.y = SEA_LEVEL;
      s.heading = BOAT_SPAWN.heading;
      s.vx = 0; s.vz = 0; s.vy = 0; s.yawRate = 0;
      s.pitch = 0; s.pitchRate = 0; s.roll = 0; s.rollRate = 0;
      helm.current = 0;
    }

    /* ------------------------------------------------- along and across */

    const forwardX = -Math.sin(s.heading);
    const forwardZ = -Math.cos(s.heading);
    // Right of forward, the convention `trafficAI` uses too.
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const ahead = s.vx * forwardX + s.vz * forwardZ;
    const sideways = s.vx * rightX + s.vz * rightZ;

    /* ------------------------------------------------------ the water */

    // The wave under the bow and under the stern, which is what the hull
    // actually rides: a boat as long as this one spans a good part of a
    // wavelength, and sampling the middle alone loses the pitch entirely.
    const half = hull.size[2] / 2;
    const bowX = s.x + forwardX * half;
    const bowZ = s.z + forwardZ * half;
    const sternX = s.x - forwardX * half;
    const sternZ = s.z - forwardZ * half;
    const portX = s.x - rightX * hull.size[0] / 2;
    const portZ = s.z - rightZ * hull.size[0] / 2;
    const starX = s.x + rightX * hull.size[0] / 2;
    const starZ = s.z + rightZ * hull.size[0] / 2;

    const bow = seaHeightAt(bowX, bowZ, time);
    const stern = seaHeightAt(sternX, sternZ, time);
    const port = seaHeightAt(portX, portZ, time);
    const starboard = seaHeightAt(starX, starZ, time);
    const surface = (bow + stern + port + starboard) / 4;

    /* ---------------------------------------------------------- heave */

    // Buoyancy as a damped spring toward the water's own level. The
    // stiffness is Archimedes' — the hull's waterplane times ρg — so the
    // period of the bob is the boat's real one, and a heavy hull answers a
    // wave more slowly than a light one without that being written anywhere.
    const waterplane = hull.size[0] * hull.size[2] * 0.66;
    const stiffness = HYDRO.stiffness * waterplane;
    const critical = 2 * Math.sqrt(stiffness * spec.mass);
    const displacement = surface - s.y;
    const heaveForce = stiffness * displacement - critical * HYDRO.damping * s.vy;
    s.vy += (heaveForce / spec.mass) * dt;
    s.y += s.vy * dt;

    /* -------------------------------------------------- thrust and drag */

    const drive = i.throttle > 0 ? i.throttle * spec.thrust : -i.brake * spec.astern;
    const wetted = hull.size[0] * hull.draught;
    const top = spec.topKph / 3.6;
    // The drag coefficient that makes full thrust balance at the stated top
    // speed, so the two numbers in `BOATS` cannot disagree with each other.
    const cAhead = spec.thrust / (top * top * wetted * HYDRO.dragAhead);
    const dragAhead = -Math.sign(ahead) * cAhead * wetted * HYDRO.dragAhead * ahead * ahead;
    const dragSide = -Math.sign(sideways) * cAhead * wetted * HYDRO.dragAhead
      * HYDRO.lateralRatio * sideways * sideways;

    const alongAccel = (drive + dragAhead) / spec.mass;
    const acrossAccel = dragSide / spec.mass;
    s.vx += (forwardX * alongAccel + rightX * acrossAccel) * dt;
    s.vz += (forwardZ * alongAccel + rightZ * acrossAccel) * dt;

    /* ----------------------------------------------------------- helm */

    // A rudder is a wing: no flow, no force. Ramped from stall to full and
    // reversed going astern, which is what makes going backwards awkward in
    // exactly the way going backwards in a boat is awkward.
    // Water over the rudder: from the boat's own way through the water, and
    // from the propeller throwing it there even at rest. See `HYDRO.propWash`.
    const way = Math.min(1, Math.max(0,
      (Math.abs(ahead) - HYDRO.helmStall) / (HYDRO.helmFull - HYDRO.helmStall)));
    const wash = Math.max(i.throttle, i.brake) * HYDRO.propWash;
    const flow = Math.min(1, Math.max(way, wash));
    // Astern, the rudder works the other way round. With the boat stopped and
    // the screw turning ahead, it does not — the wash is going the right way.
    const sense = ahead < -0.3 ? -1 : 1;
    // The helm itself moves at a finite rate — a wheel is turned, not flicked
    // — and the boat's own response is slow enough that an instant hard-over
    // would be lost in it anyway. `CarPhysics` smooths its rack the same way;
    // for a boat this is the wheel, not the rudder.
    const wantedHelm = i.steerAxis;
    helm.current += (wantedHelm - helm.current)
      * Math.min(1, dt * (wantedHelm === 0 ? HYDRO.helmReturn : HYDRO.helmRate));
    const wantedYaw = -helm.current * spec.helm * flow * sense;
    s.yawRate += (wantedYaw - s.yawRate) * Math.min(1, HYDRO.yawDamping * dt);
    s.heading += s.yawRate * dt;

    /* ------------------------------------------------- attitude on the sea */

    // Pitch follows the wave along the hull, plus a bow-up trim under power:
    // a planing boat squats on its stern before it gets up and runs.
    const wavePitch = Math.atan2(bow - stern, hull.size[2]) * HYDRO.waveFollow;
    const trim = (i.throttle - i.brake) * 0.055 * Math.min(1, Math.abs(ahead) / Math.max(top, 1));
    const wantedPitch = -wavePitch + trim;
    // Roll follows the wave across the hull, plus the heel of a turn.
    const waveRoll = Math.atan2(starboard - port, hull.size[0]) * HYDRO.waveFollow;
    const wantedRoll = waveRoll - helm.current * spec.heel * flow * sense;

    // Both are second order — a hull rolls TOWARD where the water wants it and
    // overshoots, which is the difference between a boat and a decal.
    const settle = (angle: number, rate: number, want: number, stiff: number) => {
      const accel = (want - angle) * stiff - rate * 2 * Math.sqrt(stiff) * HYDRO.attitudeDamping;
      return rate + accel * dt;
    };
    s.pitchRate = settle(s.pitch, s.pitchRate, wantedPitch, 9);
    s.pitch += s.pitchRate * dt;
    s.rollRate = settle(s.roll, s.rollRate, wantedRoll, 6);
    s.roll += s.rollRate * dt;

    /* ------------------------------------------------------- integrate */

    const nextX = s.x + s.vx * dt;
    const nextZ = s.z + s.vz * dt;
    if (afloatAt(nextX, nextZ, hull.size[0])) {
      s.x = nextX;
      s.z = nextZ;
    } else {
      // Aground. Stop rather than climb the beach: the hull has no wheels and
      // the shore is not a kerb to bounce off. Same discipline as the traffic
      // refusing a step that would leave the tarmac.
      s.vx *= -0.2;
      s.vz *= -0.2;
    }

    /* ------------------------------------------------------------ pose */

    scratch.euler.set(s.pitch, s.heading, s.roll);
    scratch.quaternion.setFromEuler(scratch.euler);
    b.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
    b.setNextKinematicRotation(scratch.quaternion);

    /* --------------------------------------------------------- telemetry */

    const speed = Math.hypot(s.vx, s.vz);
    t.x = s.x;
    t.y = s.y;
    t.z = s.z;
    t.heading = s.heading;
    t.speedKph = speed * 3.6;
    t.forwardSpeed = ahead;
    t.braking = i.brake > 0.05 && ahead > 0.5;
    t.reversing = ahead < -0.2;
    t.handbrake = false;
    t.gear = 1;
    t.rpm = IDLE_RPM + (MAX_RPM - IDLE_RPM)
      * Math.min(1, Math.max(Math.abs(ahead) / top, i.throttle * 0.6));
    // A boat's "slip" is how far sideways it is going, which is exactly what
    // the camera shake and the tacho's slip light already read.
    t.slip = Math.min(1, Math.abs(sideways) / Math.max(2, Math.abs(ahead) + 2));
    for (const wheel of [t.wheels.FL, t.wheels.FR, t.wheels.RL, t.wheels.RR]) {
      wheel.inContact = true;
    }
  });

  // The drawn hull follows the body; the camera follows the drawn hull.
  useFrame(() => {
    const s = state.current;
    const group = chassisRef.current;
    if (!group) return;
    group.position.set(s.x, s.y, s.z);
    scratch.euler.set(s.pitch, s.heading, s.roll);
    group.quaternion.setFromEuler(scratch.euler);
  });

  return (
    <>
      {/*
        Kinematic, and driven by the integration above rather than by the
        solver.
        
        Every other vehicle in this game that is not a car is the same —
        the tram, the train and the NPC traffic are all posed by their own
        code — and for a boat there is a particular reason beyond consistency:
        what holds a boat up is a force field, not a contact, and a dynamic
        body spends its time arguing with the solver about a surface that is
        not there. Integrating it here also means the model can be run outside
        the browser and checked, which is how the draught and the top speed
        below were confirmed.

        The collider still earns its place: a kinematic body pushes dynamic
        ones, so the boats shoulder the traffic's cars off a slipway and each
        other around, and the hull is a solid thing in the world rather than a
        hologram.
      */}
      <RigidBody
        ref={body}
        type="kinematicPosition"
        colliders={false}
        position={[BOAT_SPAWN.position[0], SEA_LEVEL, BOAT_SPAWN.position[2]]}
      >
        <CuboidCollider
          args={[hull.size[0] / 2, (hull.draught + hull.size[1] * 0.35) / 2, hull.size[2] / 2]}
          position={[0, (hull.size[1] * 0.35 - hull.draught) / 2, 0]}
          friction={0.2}
          restitution={0.05}
        />
      </RigidBody>

      <group ref={chassisRef}>
        {model.map((mesh, i) => (
          <primitive key={i} object={mesh} />
        ))}
      </group>

      {/* The mark the hull leaves on the water. Outside the boat's own group,
          because a wake is laid down in the world and stays there while the
          boat goes on. */}
      <BoatWake telemetry={telemetry} hull={hull} />
    </>
  );
}

