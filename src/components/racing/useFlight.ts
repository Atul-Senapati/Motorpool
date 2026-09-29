'use client';

import { useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useBeforePhysicsStep, useRapier, type RapierRigidBody } from '@react-three/rapier';
import { Euler, Quaternion, type Group } from 'three';
import { PHYSICS_TIMESTEP } from '@/config/vehicleConfig';
import { AIRFRAME, airspace, pickAirSpawn, type AirSpawn } from '@/config/airframe';
import { stepFlight, type FlightState } from '@/physics/flightModel';
import type { RawInput } from '@/hooks/useKeyboardControls';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * Everything both aircraft do identically: hold the state, find the ground,
 * step the flight model, pose the body and the drawn airframe, and publish the
 * telemetry. What is left for the ride components is the part that genuinely
 * differs — a quadcopter's four blur discs against a helicopter's two real
 * rotors — which is a dozen lines each rather than a second copy of the flying.
 *
 * Kinematic, and integrated in `useBeforePhysicsStep` rather than solved, for
 * the reason `BoatRide` gives: what holds an aircraft up is a force field, not
 * a contact. The collider still earns its place — a kinematic body shoulders
 * dynamic ones, so flying into the traffic scatters it.
 */
export interface FlightHandle {
  body: RefObject<RapierRigidBody | null>;
  spawn: AirSpawn;
  /** Rotor angle and rate, rad and rad/s, and how hard the machine is working. */
  rotor: RefObject<{ angle: number; rate: number; effort: number }>;
}

export function useFlight(
  input: RefObject<RawInput>,
  telemetry: RefObject<VehicleTelemetry>,
  chassisRef: RefObject<Group | null>,
): FlightHandle {
  const body = useRef<RapierRigidBody | null>(null);
  const spawn = useMemo(() => pickAirSpawn(AIRFRAME.launchHeight), []);
  const bounds = useMemo(() => airspace(AIRFRAME.margin), []);

  const state = useRef<FlightState>({
    x: spawn.position[0], y: spawn.position[1], z: spawn.position[2],
    heading: spawn.heading,
    vx: 0, vy: 0, vz: 0, yawRate: 0,
    pitch: 0, roll: 0,
    ground: -Infinity,
    effort: 0, clock: 0,
  });
  const rotor = useRef({ angle: 0, rate: AIRFRAME.rotorIdle, effort: 0 });

  const { world, rapier } = useRapier();
  const ray = useMemo(() => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }), [rapier]);
  /**
   * World height of the first fixed surface under the aircraft.
   *
   * Fixed bodies only: a ray dropped from a hundred metres would otherwise
   * land on the roof of a passing lorry and call it the ground, and the
   * aircraft would bob up as the traffic went by underneath.
   */
  const groundAt = useMemo(() => (x: number, y: number, z: number): number => {
    ray.origin.x = x;
    ray.origin.y = y + 0.5;
    ray.origin.z = z;
    const hit = world.castRay(
      ray, AIRFRAME.spec.ceiling + 100, true, undefined, undefined, undefined,
      body.current ?? undefined, (collider) => collider.parent()?.isFixed() ?? false,
    );
    return hit ? ray.origin.y - hit.timeOfImpact : -Infinity;
  }, [world, ray]);

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
      [s.x, s.y, s.z] = spawn.position;
      s.heading = spawn.heading;
      s.vx = 0; s.vy = 0; s.vz = 0; s.yawRate = 0; s.pitch = 0; s.roll = 0;
    }

    const sport = i.boost;
    const hold = i.handbrake;
    const flight = stepFlight(
      s, AIRFRAME.spec,
      { move: i.moveAxis, strafe: i.strafeAxis, climb: i.climbAxis, yaw: i.yawAxis, sport, hold },
      dt, bounds, groundAt,
    );

    // The rotor chases the effort rather than tracking it: a disc with that
    // much inertia does not change speed the instant a stick moves, and the
    // lag is most of what makes it read as a rotor.
    const wanted = AIRFRAME.rotorIdle + (AIRFRAME.rotorFull - AIRFRAME.rotorIdle) * flight.effort;
    const r = rotor.current;
    r.rate += (wanted - r.rate) * Math.min(1, dt * 1.6);
    r.angle += r.rate * dt;
    r.effort = flight.effort;

    scratch.euler.set(s.pitch, s.heading, s.roll);
    scratch.quaternion.setFromEuler(scratch.euler);
    b.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
    b.setNextKinematicRotation(scratch.quaternion);

    t.x = s.x; t.y = s.y; t.z = s.z;
    t.heading = s.heading;
    t.speedKph = Math.hypot(flight.horizontal, s.vy) * 3.6;
    t.forwardSpeed = flight.ahead;
    t.braking = hold;
    t.reversing = false;
    t.handbrake = hold;
    t.gear = 1;
    t.rpm = AIRFRAME.idleRpm + (AIRFRAME.maxRpm - AIRFRAME.idleRpm) * flight.effort;
    // Nothing to ration: the reserve reads full so the cluster's arc is not a
    // permanently empty gauge, and `boosting` is what widens the lens.
    t.boost = 1;
    t.boosting = sport && flight.asking;
    // The camera reads `slip` as shake. A rotor disc hums through the whole
    // airframe, harder as it works; the quad barely does.
    t.slip = AIRFRAME.spec.vibration * (0.4 + 0.6 * flight.effort);
    t.upright = 1;
    t.agl = Number.isFinite(s.ground) ? s.y - s.ground : s.y;
    for (const wheel of [t.wheels.FL, t.wheels.FR, t.wheels.RL, t.wheels.RR]) wheel.inContact = true;
  });

  // The drawn airframe follows the body; the camera follows the drawn airframe.
  useFrame(() => {
    const s = state.current;
    const group = chassisRef.current;
    if (!group) return;
    group.position.set(s.x, s.y, s.z);
    scratch.euler.set(s.pitch, s.heading, s.roll);
    group.quaternion.setFromEuler(scratch.euler);
  });

  return { body, spawn, rotor };
}
