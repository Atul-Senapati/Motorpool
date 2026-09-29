'use client';

import { Vector3 } from 'three';
import { SITE } from '@/config/airportConfig';
import { DROME_SHAPE, WOD_SITE } from '@/config/wallOfDeathConfig';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import type { RailShot } from './RailCamera';

/**
 * The Wall of Death's cameras, offered while the car is inside the drum.
 *
 * The chase rig is the wrong tool in a drome: it sits behind and above the
 * car, and behind-and-above a car that is on its side halfway up a wall is
 * inside the timber. These four are the shots the real show is watched and
 * filmed from, and every one of them is planted in the DRUM's frame rather
 * than the car's:
 *
 * - `gallery`  a spectator at the rail, a quarter of the drum behind the
 *              car, turning to follow it. The view the crowd pays for.
 * - `well`     the photographer standing in the middle of the floor, looking
 *              up and out at the car going round. The one that shows the lean.
 * - `top`      from the canopy's centre, looking down at the car: the whole
 *              wall and the circle it is drawing on it.
 * - `wall`     low on the wall itself, ten metres behind the car along its
 *              line, riding round with it. The onboard-camera shot.
 *
 * `insideDrome` is what the scene reads to decide whether to offer them; the
 * shots themselves keep working if the car leaves, because they are world
 * points, and the next press of C drops them from the cycle.
 */

export const DROME_CAMERA_MODES: readonly CameraMode[] = ['gallery', 'well', 'top', 'wall'] as const;

export const isDromeShot = (mode: CameraMode) =>
  mode === 'gallery' || mode === 'well' || mode === 'top' || mode === 'wall';

const SHOT: Record<'gallery' | 'well' | 'top' | 'wall', RailShot> = {
  gallery: { fov: 58, fovBoost: 0, positionHalfLife: 0.45, targetHalfLife: 0.12 },
  well: { fov: 72, fovBoost: 0, positionHalfLife: 0.3, targetHalfLife: 0.1 },
  top: { fov: 62, fovBoost: 0, positionHalfLife: 0.5, targetHalfLife: 0.15 },
  wall: { fov: 70, fovBoost: 6, positionHalfLife: 0.12, targetHalfLife: 0.06 },
};

/** The drum's centre in world, and the island's rotation, worked out once. */
const H = SITE.heading;
const CENTRE = new Vector3(
  SITE.centre[0] + WOD_SITE.along * Math.cos(H) + WOD_SITE.across * Math.sin(H),
  SITE.ground,
  SITE.centre[1] - WOD_SITE.along * Math.sin(H) + WOD_SITE.across * Math.cos(H),
);

/** A point in the drum's frame — `x`, `y` up, `z` — to world. */
function toWorld(x: number, y: number, z: number, out: Vector3): Vector3 {
  const turn = WOD_SITE.turn;
  const ax = x * Math.cos(turn) + z * Math.sin(turn);
  const az = -x * Math.sin(turn) + z * Math.cos(turn);
  return out.set(
    CENTRE.x + ax * Math.cos(H) + az * Math.sin(H),
    CENTRE.y + y,
    CENTRE.z - ax * Math.sin(H) + az * Math.cos(H),
  );
}

/** The car, in the drum's frame. */
const local = new Vector3();
function toLocal(t: VehicleTelemetry): Vector3 {
  const dx = t.x - CENTRE.x;
  const dz = t.z - CENTRE.z;
  const ax = dx * Math.cos(H) - dz * Math.sin(H);
  const az = dx * Math.sin(H) + dz * Math.cos(H);
  const turn = WOD_SITE.turn;
  return local.set(
    ax * Math.cos(turn) - az * Math.sin(turn),
    t.y - CENTRE.y,
    ax * Math.sin(turn) + az * Math.cos(turn),
  );
}

/** Whether the car is in the drum: inside its top radius and under its gallery. */
export function insideDrome(t: VehicleTelemetry | null | undefined): boolean {
  if (!t) return false;
  const p = toLocal(t);
  return Math.hypot(p.x, p.z) < DROME_SHAPE.topRadius + 1 && p.y < DROME_SHAPE.top;
}

const car = new Vector3();

export function updateDromeCamera(
  mode: CameraMode,
  t: VehicleTelemetry,
  outPosition: Vector3,
  outTarget: Vector3,
): RailShot {
  const p = toLocal(t);
  // The car's angle round the drum, in the drum's own convention (theta = 0 on +z).
  const theta = Math.atan2(p.x, p.z);
  const radius = Math.hypot(p.x, p.z);
  toWorld(p.x, p.y + 0.6, p.z, car);
  const S = DROME_SHAPE;

  switch (mode) {
    case 'gallery': {
      // A quarter of the drum behind the car, at the rail, eye height.
      const a = theta - Math.PI / 2;
      const r = S.topRadius + 1.2;
      toWorld(r * Math.sin(a), S.top + 1.7, r * Math.cos(a), outPosition);
      outTarget.copy(car);
      return SHOT.gallery;
    }
    case 'well': {
      // Standing in the middle, a step back from the car's side of the floor.
      const back = Math.min(3, radius * 0.2);
      toWorld(-Math.sin(theta) * back, 1.7, -Math.cos(theta) * back, outPosition);
      outTarget.copy(car);
      return SHOT.well;
    }
    case 'top': {
      toWorld(0, S.top + 4, 0, outPosition);
      outTarget.copy(car);
      return SHOT.top;
    }
    case 'wall':
    default: {
      // Ten metres back along the car's line, at its height, pulled two
      // metres off the timber so the lens is never inside it.
      const r = Math.max(S.rideAt(p.y) - 2.2, Math.min(radius, S.floorRadius - 2));
      const a = theta - 10 / Math.max(r, 1);
      toWorld(r * Math.sin(a), Math.max(p.y, 0) + 1.4, r * Math.cos(a), outPosition);
      outTarget.copy(car);
      return SHOT.wall;
    }
  }
}
