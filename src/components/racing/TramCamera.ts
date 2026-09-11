import type { Vector3 } from 'three';
import {
  RAIL_LENGTH, TRAM, TRAM_CAMERA, railNormalAt, railPointAt, railWrap,
} from '@/config/railConfig';
import { groundHeightAt } from '@/physics/cityNav';
import type { VehicleTelemetry } from '@/types/vehicle';
import type { RailShot, RailState } from './RailCamera';

/**
 * The tram's camera rig.
 *
 * Structurally this is the main line's (`RailCamera`) — the same six shots, the
 * same way of working in arc length rather than in world space — but it is a
 * separate module because almost nothing in the other one is about the *camera*
 * and almost all of it is about the *railway*. That rig reads `trainPointAt`,
 * the pointwork's live road, the rake's formation and whether the line is in a
 * bore. The tram has none of those: one loop, no turnouts, no second road, no
 * tunnels, and a fixed seven-section body. Parameterising `RailCamera` over
 * both lines would have meant an adapter for every one of those, to share about
 * fifteen lines of vector arithmetic.
 *
 * Two things are genuinely different, and they are the reason the shots feel
 * like a tram's rather than a train's shrunk down:
 *
 *   the ground    the main line has its own rail height at every arc, because
 *                 it is carried on structures the generator graded for it. A
 *                 tram is laid in a street, so its height IS the street's, read
 *                 from the nav grid at the centreline. Reading it at the
 *                 camera's own offset instead would drop the rig into a kerb or
 *                 lift it onto a roof every time it passed one
 *   the distances everything is at street scale — see `TRAM_CAMERA`
 */

/** Where the tram's own arc reaches, so a shot can be planted relative to it. */
const HALF_TRAM = TRAM.size[2] / 2;

/** Signed distance from `from` to `to` round the loop, shortest way. */
function ahead(from: number, to: number): number {
  let d = railWrap(to - from);
  if (d > RAIL_LENGTH / 2) d -= RAIL_LENGTH;
  return d;
}

/**
 * A point beside the tram's own track: `side` metres off the centreline at
 * `arc`, `up` metres over the street.
 *
 * The height is the street's at the CENTRELINE, not at the offset point. A
 * planted shot stands 11 m out, which on this route can be pavement, a kerb, a
 * central reservation or the corner of a building plot, and sampling the nav
 * grid there makes the camera hop by whatever those differ by. The tram's own
 * ground is smooth along the route because the route was laid on it.
 */
function beside(arc: number, side: number, up: number, out: Vector3) {
  const s = railWrap(arc);
  const [x, z] = railPointAt(s);
  const ground = groundHeightAt(x, z) ?? 0;
  if (!side) { out.set(x, ground + up, z); return; }
  const [nx, nz] = railNormalAt(s);
  out.set(x + nx * side, ground + up, z + nz * side);
}

/** True for the shots this module owns — the same names the main line uses. */
export const isTramShot = (mode: string) => mode === 'chase' || mode === 'cab'
  || mode === 'nose' || mode === 'top' || mode === 'cinematic' || mode === 'drone';

/**
 * Place the tram camera for `mode`.
 *
 * `telemetry.railArc` is the LEADING CAB's arc, which is what `TramRide` anchors
 * everything else to as well, so a shot measured from it is measured from where
 * the driver sits. `way` is which end is leading: a tram shunts backwards on the
 * brake like the car does, and when it is the rig has to move to the other end
 * rather than film the tram driving away from it.
 */
export function updateTramCamera(
  mode: string,
  state: RailState,
  delta: number,
  telemetry: VehicleTelemetry,
  outPosition: Vector3,
  outTarget: Vector3,
  eye: Vector3,
  aim: Vector3,
): RailShot {
  const arc = telemetry.railArc;
  const way: 1 | -1 = telemetry.forwardSpeed < -0.2 ? -1 : 1;
  /** The nose tip, and the far end of the body, in arc terms. */
  const nose = arc + TRAM_CAMERA.noseHalf * way;

  /** A point `down` metres back along the tram from its leading end. */
  const along = (down: number) => {
    const s = railWrap(nose - down * way);
    const [x, z] = railPointAt(s);
    return { x, y: (groundHeightAt(x, z) ?? 0) + 2, z };
  };

  if (mode === 'chase') {
    const C = TRAM_CAMERA.chase;
    beside(arc - C.back * way, C.side * way, C.up, eye);
    outPosition.copy(eye);
    const focus = along(C.look);
    outTarget.set(focus.x, focus.y, focus.z);
    return { fov: C.fov, fovBoost: C.fovBoost, positionHalfLife: 0.16, targetHalfLife: 0.12 };
  }

  if (mode === 'cab' || mode === 'nose') {
    const cab = mode === 'cab';
    const C = cab ? TRAM_CAMERA.cab : TRAM_CAMERA.nose;
    // Into the body for the cab, a little past the coupler for the nose.
    const from = cab ? -TRAM_CAMERA.cab.inset : TRAM_CAMERA.nose.clear;
    const side = cab ? TRAM_CAMERA.cab.side * way : 0;
    beside(nose + from * way, side, C.eye, eye);
    outPosition.copy(eye);
    // Aimed up the street rather than along the body: on a corner the two
    // differ by several degrees and the street is what a driver watches.
    beside(nose + (from + C.ahead) * way, 0, C.eye * 0.6, aim);
    outTarget.copy(aim);
    return {
      fov: cab ? 64 : 70,
      fovBoost: cab ? 6 : 9,
      positionHalfLife: 0.02,
      targetHalfLife: 0.07,
    };
  }

  if (mode === 'top') {
    const C = TRAM_CAMERA.top;
    beside(arc - C.back * way, 0, C.up, eye);
    outPosition.copy(eye);
    const focus = along(C.look);
    outTarget.set(focus.x, focus.y, focus.z);
    return { fov: C.fov, fovBoost: 3, positionHalfLife: 0.08, targetHalfLife: 0.08 };
  }

  if (mode === 'cinematic') {
    const C = TRAM_CAMERA.cinematic;
    const pace = Math.abs(telemetry.forwardSpeed);
    const lead = Math.min(C.leadMax, Math.max(C.leadMin, C.leadBase + pace * C.leadPerSpeed));
    const hold = C.holdBase + pace * C.holdPerSpeed;
    // The whole tram has to clear the camera before cutting, or the shot ends
    // with the back half still in frame.
    const clear = hold + (C.holdFormation ? TRAM.size[2] : 0);
    const past = state.shotArc === null ? Infinity : -ahead(arc, state.shotArc) * state.shotWay;
    if (state.shotArc === null || state.shotWay !== way || past > clear) {
      state.shotArc = railWrap(arc + lead * way);
      // Alternate sides, so a run of shots is not a run of the same shot.
      state.shotSide = state.shotSide === 1 ? -1 : 1;
      state.shotWay = way;
    }
    beside(state.shotArc, C.side * state.shotSide, C.up, eye);
    outPosition.copy(eye);
    const focus = along(C.look);
    outTarget.set(focus.x, focus.y, focus.z);
    return {
      fov: C.fov,
      fovBoost: 0,
      // The position must not slide between shots: a cut is a cut.
      positionHalfLife: 0.001,
      targetHalfLife: 0.06,
    };
  }

  // Drone. High and slowly orbiting, kept inside the block.
  const C = TRAM_CAMERA.drone;
  state.orbit += C.orbit * delta;
  const swing = Math.sin(state.orbit);
  beside(arc - C.back * way, C.swing * swing, C.up, eye);
  outPosition.copy(eye);
  const focus = along(Math.min(C.look, HALF_TRAM));
  outTarget.set(focus.x, focus.y, focus.z);
  return { fov: C.fov, fovBoost: 4, positionHalfLife: 0.28, targetHalfLife: 0.2 };
}
