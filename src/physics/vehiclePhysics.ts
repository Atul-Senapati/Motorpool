/**
 * Rapier raycast-vehicle wrapper.
 *
 * All driving forces go through Rapier's `DynamicRayCastVehicleController`,
 * which raycasts a spring per wheel and applies engine/brake/friction impulses
 * to the chassis rigid body. Nothing here moves the car by writing to its
 * position — the chassis is a real dynamic body in the physics world.
 *
 * This module is the ONLY place that knows about the -Z/+Z forward-axis
 * mismatch between the model and Rapier (see `FORWARD_SIGN`).
 */
import type { World, RigidBody } from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { FORWARD_SIGN, VEHICLE } from '@/config/vehicleConfig';
import { CORNERS, type Corner, type VehicleTelemetry, type WheelState } from '@/types/vehicle';
import { gripAt } from './surfaceGrip';

const SUSPENSION_DIR = { x: 0, y: -1, z: 0 };
/** Wheels spin about the chassis X axis. */
const AXLE = { x: -1, y: 0, z: 0 };

/**
 * Rapier's steering sign, relative to ours.
 *
 * We define positive steering as "turn right" (matching the D key). With the
 * axle registered as -X, a positive `setWheelSteering` value turns the car LEFT
 * — verified by driving with full lock and measuring the yaw rate. Negating on
 * the way in keeps the rest of the codebase in the intuitive convention, and
 * the value read back for the wheel visuals then already carries the right sign
 * for a three.js Y rotation.
 */
const STEER_SIGN = -1;

const KPH = 3.6;

/** Below this forward speed (m/s) the car is treated as stationary for readouts. */
const SPEED_DEADZONE = 0.35;

const emptyWheelState = (): WheelState => ({
  suspensionLength: VEHICLE.suspension.restLength,
  rotation: 0,
  steering: 0,
  inContact: false,
  sideSlip: 0,
});

export const createTelemetry = (): VehicleTelemetry => ({
  speedKph: 0,
  forwardSpeed: 0,
  rpm: VEHICLE.engine.idleRpm,
  gear: 1,
  braking: false,
  reversing: false,
  handbrake: false,
  slip: 0,
  x: VEHICLE.spawn.position[0],
  y: VEHICLE.spawn.position[1],
  z: VEHICLE.spawn.position[2],
  heading: VEHICLE.spawn.heading,
  wheels: {
    FL: emptyWheelState(), FR: emptyWheelState(),
    RL: emptyWheelState(), RR: emptyWheelState(),
  },
});

/** Frame-rate independent exponential smoothing. */
export const damp = (current: number, target: number, halfLife: number, dt: number) =>
  target + (current - target) * Math.pow(2, -dt / Math.max(halfLife, 1e-4));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface VehicleCommand {
  throttle: number;
  brake: number;
  /** Raw steering axis, -1..1. Smoothing happens inside the controller. */
  steerAxis: number;
  handbrake: boolean;
}

export class Vehicle {
  private readonly controller: ReturnType<World['createVehicleController']>;
  private readonly chassis: RigidBody;
  /** Current steering rack position, radians. Persisted across frames for smoothing. */
  private steer = 0;
  /** Scratch objects — allocated once, reused every frame. */
  private readonly tmpQuat = new Quaternion();
  private readonly tmpVec = new Vector3();
  private readonly tmpVec2 = new Vector3();
  private readonly tmpChassisPos = new Vector3();

  constructor(world: World, chassis: RigidBody) {
    this.chassis = chassis;
    this.controller = world.createVehicleController(chassis);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;

    const s = VEHICLE.suspension;
    VEHICLE.wheels.forEach((w, i) => {
      this.controller.addWheel(
        { x: w.connection[0], y: w.connection[1], z: w.connection[2] },
        SUSPENSION_DIR,
        AXLE,
        s.restLength,
        w.radius,
      );
      this.controller.setWheelSuspensionStiffness(i, s.stiffness);
      this.controller.setWheelSuspensionCompression(i, s.compression);
      this.controller.setWheelSuspensionRelaxation(i, s.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.controller.setWheelMaxSuspensionForce(i, s.maxForce);
      this.controller.setWheelFrictionSlip(i, VEHICLE.tyres.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(
        i,
        w.steered ? VEHICLE.tyres.sideFrictionFront : VEHICLE.tyres.sideFrictionRear,
      );
    });
  }

  /** Signed forward speed in m/s. Positive means the nose is leading. */
  get forwardSpeed() {
    return this.controller.currentVehicleSpeed() * FORWARD_SIGN;
  }

  update(cmd: VehicleCommand, dt: number, out: VehicleTelemetry) {
    // Rapier reports up to ~0.35 m/s of noise while the car is genuinely at
    // rest, which would show as a creeping speed and a phantom reverse gear.
    const rawSpeed = this.forwardSpeed;
    const speed = Math.abs(rawSpeed) < SPEED_DEADZONE ? 0 : rawSpeed;
    const speedKph = Math.abs(speed) * KPH;

    // --- Steering -----------------------------------------------------------
    // Authority falls off with speed so the car doesn't spin at 250 km/h, and
    // the rack is interpolated rather than snapped so inputs feel analogue.
    const authority = 1 - clamp(speedKph / VEHICLE.steering.speedForMinAngle, 0, 1);
    const maxAngle =
      VEHICLE.steering.minAngle +
      (VEHICLE.steering.maxAngle - VEHICLE.steering.minAngle) * authority;
    const targetSteer = cmd.steerAxis * maxAngle;
    // Self-centring is quicker than turn-in, which is how a real rack behaves.
    const rate = cmd.steerAxis === 0 ? VEHICLE.steering.returnRate : VEHICLE.steering.rate;
    const maxDelta = rate * maxAngle * dt;
    this.steer += clamp(targetSteer - this.steer, -maxDelta, maxDelta);

    // Chassis transform, read once per step and reused for wheel positions and
    // for the aero force below.
    const q = this.chassis.rotation();
    this.tmpQuat.set(q.x, q.y, q.z, q.w);
    const t0 = this.chassis.translation();
    this.tmpChassisPos.set(t0.x, t0.y, t0.z);

    // --- Throttle / brake ---------------------------------------------------
    // S is brake while moving forward, and reverse once effectively stopped.
    const reversing = speed < 0.6 && cmd.brake > 0 && cmd.throttle === 0;
    const brakingForward = speed > 0.6 && cmd.brake > 0;

    // Taper engine force toward the speed cap instead of hard-clamping velocity.
    const topSpeed = VEHICLE.engine.maxSpeedKph / KPH;
    const taper = clamp(1 - Math.abs(speed) / topSpeed, 0, 1);

    let engineForce = 0;
    if (cmd.throttle > 0) engineForce = cmd.throttle * VEHICLE.engine.maxForce * taper;
    else if (reversing) engineForce = -VEHICLE.engine.reverseForce * taper;

    let brakeForce = 0;
    if (brakingForward) brakeForce = VEHICLE.brake.force * cmd.brake;
    else if (cmd.throttle === 0 && cmd.brake === 0) brakeForce = VEHICLE.brake.engineBraking;

    VEHICLE.wheels.forEach((w, i) => {
      // Each wheel only gets the grip of whatever it is standing on, so running
      // wide onto the grass costs traction per-corner rather than all at once.
      // The wheel's world position is derived from the chassis transform rather
      // than queried from Rapier — see physics/surfaceGrip.ts for why.
      const wp = this.tmpVec2
        .set(w.connection[0], w.connection[1], w.connection[2])
        .applyQuaternion(this.tmpQuat)
        .add(this.tmpChassisPos);
      const grip = gripAt(wp.x, wp.z);

      // FORWARD_SIGN converts "push the car nose-first" into Rapier's axis sign.
      this.controller.setWheelEngineForce(i, w.powered ? engineForce * FORWARD_SIGN : 0);

      const handbrakeHere = cmd.handbrake && !w.steered;
      this.controller.setWheelBrake(i, handbrakeHere ? VEHICLE.brake.handbrake : brakeForce);
      this.controller.setWheelFrictionSlip(i, VEHICLE.tyres.frictionSlip * grip);

      // Dropping rear lateral grip under handbrake is what produces the slide.
      const sideStiffness = w.steered
        ? VEHICLE.tyres.sideFrictionFront
        : cmd.handbrake
          ? VEHICLE.tyres.sideFrictionHandbrake
          : VEHICLE.tyres.sideFrictionRear;
      this.controller.setWheelSideFrictionStiffness(i, sideStiffness * grip);
      this.controller.setWheelSteering(i, w.steered ? this.steer * STEER_SIGN : 0);
    });

    // --- Aero ---------------------------------------------------------------
    // Downforce scales with v^2 and is applied along the chassis' own up axis,
    // so it still presses the car into the road while cornering or cresting.
    const down = this.tmpVec.set(0, -1, 0).applyQuaternion(this.tmpQuat);
    const load = VEHICLE.aero.downforce * speed * speed;
    // Rapier force accumulators PERSIST across timesteps until reset, so this
    // must be cleared each step. Without it the downforce compounds every frame
    // into an unbounded downward force that crushes the suspension flat and
    // grinds the chassis along the road.
    this.chassis.resetForces(false);
    this.chassis.addForce({ x: down.x * load, y: down.y * load, z: down.z * load }, true);

    this.controller.updateVehicle(dt);

    // --- Read back ----------------------------------------------------------
    // Slip is derived kinematically, from how far sideways the chassis is
    // actually travelling relative to its own speed (i.e. tan of the slip
    // angle). Rapier's `wheelSideImpulse` / `wheelSuspensionForce` readbacks are
    // in unreliable internal units, which made impulse-based slip jump between
    // 0 and 1 rather than tracking the slide.
    const lateral = Math.abs(this.lateralSpeed());
    const bodySlip = clamp(lateral / Math.max(Math.abs(speed), 4), 0, 1);

    let slipSum = 0;
    let contacts = 0;
    for (let i = 0; i < CORNERS.length; i++) {
      const corner: Corner = CORNERS[i];
      const w = VEHICLE.wheels[i];
      const ws = out.wheels[corner];
      ws.suspensionLength = this.controller.wheelSuspensionLength(i) ?? VEHICLE.suspension.restLength;
      ws.rotation = this.controller.wheelRotation(i) ?? 0;
      ws.steering = this.controller.wheelSteering(i) ?? 0;
      ws.inContact = this.controller.wheelIsInContact(i);
      // A locked rear axle under handbrake is sliding by definition, even before
      // the chassis has started to rotate.
      const locked = cmd.handbrake && !w.steered ? 0.75 : 0;
      ws.sideSlip = clamp(Math.max(bodySlip, locked), 0, 1);
      if (ws.inContact) { slipSum += ws.sideSlip; contacts++; }
    }

    // --- Telemetry ----------------------------------------------------------
    out.forwardSpeed = speed;
    out.speedKph = speedKph;
    out.braking = brakingForward || cmd.handbrake;
    out.reversing = speed < -0.4;
    out.handbrake = cmd.handbrake;
    out.slip = contacts ? slipSum / contacts : 0;

    // Pose, for the minimap and compass. `tmpChassisPos`/`tmpQuat` were filled
    // at the top of this step, so this is free.
    out.x = this.tmpChassisPos.x;
    out.y = this.tmpChassisPos.y;
    out.z = this.tmpChassisPos.z;
    // Forward is -Z in chassis space; the spawn convention is
    // forward = (-sin h, -cos h), which inverts to the expression below.
    const fwd = this.tmpVec.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    out.heading = Math.atan2(-fwd.x, -fwd.z);

    const gears = VEHICLE.engine.gearSpeedsKph;
    let gear = 1;
    while (gear < gears.length - 1 && speedKph > gears[gear]) gear++;
    out.gear = gear;
    const lo = gears[gear - 1];
    const hi = gears[gear];
    const through = hi > lo ? clamp((speedKph - lo) / (hi - lo), 0, 1) : 0;
    const idle = VEHICLE.engine.idleRpm;
    // RPM is presentational: sweep from ~idle to redline across each gear band.
    // At a standstill it sits at idle and only lifts with throttle.
    out.rpm = speedKph < 1
      ? idle + (VEHICLE.engine.maxRpm - idle) * 0.22 * cmd.throttle
      : idle + (VEHICLE.engine.maxRpm - idle) * (0.28 + 0.72 * through);

    return this.steer;
  }

  /** Lateral velocity of the chassis in its own frame — used for skid detection. */
  lateralSpeed() {
    const lv = this.chassis.linvel();
    const q = this.chassis.rotation();
    this.tmpQuat.set(q.x, q.y, q.z, q.w);
    const right = this.tmpVec2.set(1, 0, 0).applyQuaternion(this.tmpQuat);
    return lv.x * right.x + lv.y * right.y + lv.z * right.z;
  }

  reset(position: readonly [number, number, number], heading: number) {
    this.steer = 0;
    this.tmpQuat.set(0, 0, 0, 1);
    this.tmpQuat.setFromAxisAngle(this.tmpVec.set(0, 1, 0), heading);
    this.chassis.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
    this.chassis.setRotation(this.tmpQuat, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (let i = 0; i < CORNERS.length; i++) {
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, 0);
      this.controller.setWheelSteering(i, 0);
    }
  }

  /**
   * Right the car where it stands, keeping its heading and position.
   *
   * Distinct from `reset()`, which relocates: rolling onto your roof against a
   * kerb should cost you your momentum, not your place in the city. The lift is
   * just enough to clear the ground as the body rotates upright — landing a
   * half-metre drop is what settles the suspension.
   */
  flipUpright(lift = 0.6) {
    const p = this.chassis.translation();
    const q = this.chassis.rotation();
    this.tmpQuat.set(q.x, q.y, q.z, q.w);
    // Heading is read BEFORE reset(), which reuses both scratch objects.
    const forward = this.tmpVec.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    const heading = Math.atan2(-forward.x, -forward.z);
    this.reset([p.x, p.y + lift, p.z], heading);
  }

  dispose(world: World) {
    world.removeVehicleController(this.controller);
  }
}
