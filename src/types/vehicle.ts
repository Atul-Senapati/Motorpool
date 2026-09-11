import type { Object3D } from 'three';

/** The four wheel corners, in the order they are registered with Rapier. */
export const CORNERS = ['FL', 'FR', 'RL', 'RR'] as const;
export type Corner = (typeof CORNERS)[number];

export type Vec3 = readonly [number, number, number];

/** Raw keyboard/touch input, normalised. Mutated in place — never stored in React state. */
export interface VehicleInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right), already smoothed */
  steer: number;
  handbrake: boolean;
  /** Held, not edge-triggered: boost lasts as long as the key is down. */
  boost: boolean;
  /** Edge-triggered, consumed and cleared by whoever handles it. */
  resetRequested: boolean;
  /** Right the car in place, without moving it. */
  flipRequested: boolean;
  /**
   * The emergency brake was struck.
   *
   * Edge-triggered, and deliberately not the held `handbrake` it shares a key
   * with. A level input is only seen if it is still down when the physics step
   * next runs, so a quick jab at the plunger between two frames is simply lost
   * — which is acceptable for a handbrake and is not acceptable for the control
   * whose whole purpose is being hit in a hurry.
   */
  emergencyRequested: boolean;
  cameraCycleRequested: boolean;
  /**
   * Toggle the standing call for the diverging route at the next set of points.
   * Rail only, and consumed like the others — the call it flips belongs to the
   * train, because it has to survive being reached. See `pointwork`.
   */
  pointsRequested: boolean;
}

/** Per-wheel state read back from the physics step, consumed by the renderer. */
export interface WheelState {
  /** Distance from the suspension hard point down to the wheel centre, in metres. */
  suspensionLength: number;
  /** Accumulated roll angle about the axle, in radians. */
  rotation: number;
  /** Steering angle about the vertical axis, in radians. */
  steering: number;
  inContact: boolean;
  /** Lateral slip magnitude, used to drive skid marks and smoke. */
  sideSlip: number;
  /**
   * Longitudinal slip, 0..1: wheelspin under power on a driven wheel, or lockup
   * under heavy braking on any wheel. Separate from `sideSlip` because a car
   * lays very different marks sliding sideways and spinning its rears up, and
   * only the lateral case was being drawn.
   */
  longSlip: number;
}

/**
 * Everything the renderer needs from the physics step. Lives in a ref and is
 * mutated in place every frame; nothing here ever triggers a React render.
 */
export interface VehicleTelemetry {
  speedKph: number;
  /** Signed forward speed in m/s; negative when reversing. */
  forwardSpeed: number;
  rpm: number;
  gear: number;
  braking: boolean;
  reversing: boolean;
  handbrake: boolean;
  /**
   * Boost reserve remaining, 0..1. Owned by the physics step because the drain
   * is spent in newtons there; everything else only reads it.
   */
  boost: number;
  /** True only on the frames the reserve is actually being spent. */
  boosting: boolean;
  /** 0..1, how far the rear axle is sliding. Drives smoke and camera shake. */
  slip: number;
  /**
   * 0..1, how far inside a tunnel the vehicle is. Only a rail vehicle ever sets
   * it; the chase rig reins itself in as it rises, because its open-air offset
   * — fifteen metres back, nearly eight up, and swinging wide through a corner
   * — puts the eye through the tunnel wall. See `ChaseCamera`.
   */
  enclosed: number;
  /**
   * Arc length along the rail line, metres. Only a rail vehicle writes it, and
   * only the rail cameras read it: filming a train needs the *line*, not just
   * the vehicle's pose, so that the shot can be planted somewhere the train has
   * not reached yet. Zero on anything with wheels.
   */
  railArc: number;
  /**
   * Which way round the train stands on the line: +1 when its cab faces
   * increasing arc, -1 when it faces the other way.
   *
   * The spawn picks a running line at random and turns the train round on the
   * down one, because the services run down it (`TrainRide`'s `FACING`). That
   * makes `forwardSpeed` the DRIVER's frame and no longer the line's, and the
   * rail cameras need both: which end of the rake leads is the driver's
   * question, but every shot is planted at an arc, which is the line's. They
   * multiply the two. Without this the chase rig on the down line stood in
   * front of the train and looked away from it.
   *
   * +1 on anything with wheels, where it is meaningless and harmless.
   */
  railFacing: 1 | -1;
  /**
   * Which road the train is on, how far the next usable points are (metres, or
   * -1 when there are none ahead), and whether the driver has called for the
   * diverging route there. Written by `TrainRide` from `pointwork`; read by the
   * HUD, and by the rail cameras, which have to stand beside whichever road the
   * train is actually on.
   */
  railRoad: number;
  railPoints: number;
  railArmed: boolean;
  /**
   * The route lever was pressed with the blades already under the leading
   * wheels, so it was refused. A flash, not a state — see `LOCK_FLASH`.
   */
  railLocked: boolean;
  /**
   * Where the diverging route at those points leads, and how fast it is signed
   * for in km/h. -1 and 0 when there are no points ahead. The pair is what
   * makes the indicator a decision rather than a label: a throat crossover into
   * a platform loop is 65 km/h, a crossover out on the plain is 108.
   */
  railNextRoad: number;
  railNextKph: number;
  /**
   * Which way the diverging route turns from the driver's seat — -1 left,
   * +1 right, 0 when the roads do not separate — and whether it is taken
   * whether or not the driver asked, because the current road ends there.
   */
  railHand: number;
  railForced: boolean;
  /**
   * The emergency brake is applied and latched. Distinct from `braking`, which
   * is any retardation — this one is the plunger, and it cannot be released
   * until the train is at a stand.
   */
  railEmergency: boolean;
  /**
   * The line ahead, for the driver's alert strip (`RailAhead`).
   *
   * `railLineKph` is what is permitted here, capped at what the train can do —
   * the raw restriction is `UNRESTRICTED` on a straight, and a readout saying
   * 720 km/h is not a readout. `railRestrictKph`/`railRestrictM` are the lowest
   * restriction the overspeed guard can see and how far off it is, -1 when
   * nothing binds; `railAheadM` is the distance to the next train on this road,
   * -1 when the road is clear. All of it comes out of the guard's own lookahead
   * rather than being computed again, so the strip cannot disagree with the
   * thing that is actually braking the train.
   */
  railLineKph: number;
  railRestrictKph: number;
  railRestrictM: number;
  railAheadM: number;
  /** Metres left of the running line: zero on the up line. See `pointwork`. */
  railLateral: number;
  /**
   * How upright the vehicle is: the world-Y component of its own up axis. 1 is
   * level, 0 on its side, -1 on its roof. Read by the driving hints to offer
   * `F` when the car is somewhere it cannot drive out of.
   */
  upright: number;
  /** World position of the chassis. Read by the minimap. */
  x: number;
  y: number;
  z: number;
  /**
   * Chassis heading in radians, matching the spawn convention: forward is
   * (-sin h, -cos h), i.e. h = 0 faces -Z. Drives the compass and the minimap
   * rotation.
   */
  heading: number;
  wheels: Record<Corner, WheelState>;
}

export interface WheelConfig {
  corner: Corner;
  /** Suspension hard point in chassis space. */
  connection: Vec3;
  radius: number;
  steered: boolean;
  powered: boolean;
}

/**
 * Camera modes. `chase`, `close` and `cockpit` are the car's; the rest belong
 * to a rail vehicle, which has a driving cab, a line to be filmed from and no
 * steering wheel — see `RailCamera` and `RAIL_CAMERA_MODES`.
 */
export type CameraMode = 'chase' | 'close' | 'cockpit'
  | 'cab' | 'nose' | 'top' | 'cinematic' | 'drone';

/** Named nodes the Car component pulls out of the processed GLB. */
export interface CarNodes {
  wheels: Record<Corner, Object3D>;
  uprights: Record<Corner, Object3D>;
}
