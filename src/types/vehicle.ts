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
  /** Edge-triggered, consumed and cleared by whoever handles it. */
  resetRequested: boolean;
  /** Right the car in place, without moving it. */
  flipRequested: boolean;
  cameraCycleRequested: boolean;
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
  /** 0..1, how far the rear axle is sliding. Drives smoke and camera shake. */
  slip: number;
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

export type CameraMode = 'chase' | 'close' | 'cockpit';

/** Named nodes the Car component pulls out of the processed GLB. */
export interface CarNodes {
  wheels: Record<Corner, Object3D>;
  uprights: Record<Corner, Object3D>;
}
