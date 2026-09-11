'use client';

import { Vector3 } from 'three';
import {
  LOCOMOTIVE, RAIL_CAMERA, TRAIN_LENGTH,
  formationFor, formationLength, locomotivePose, trainEnclosedAt, trainNormalAt, trainPointAt,
  trainStreetAt, trainWrap,
} from '@/config/trainConfig';
import { lateralAt, livePoints } from '@/config/pointwork';
import { settingsSnapshot } from './gameSettings';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';

/**
 * The rail vehicle's cameras.
 *
 * A train is filmed differently from a car, and the reason is the line. A car
 * can only be shot relative to itself, because nobody knows where it will go;
 * a train's whole future is a number, so the camera can be *planted* somewhere
 * it has not reached yet and left there to watch it pass. That is what
 * `cinematic` does, and it is the one shot a chase rig can never give you.
 *
 * All four modes work in arc length rather than in world space, reading
 * `telemetry.railArc` — the train's position along the line, which `TrainRide`
 * publishes for exactly this.
 *
 * - `cab`     the driver's eye, in the leading cab. Swaps to the trailing
 *             engine's cab when the train reverses, because that is the cab
 *             that is leading then — see `FORMATION`.
 * - `nose`    just over the front coupler, a metre above the rail. The rail-fan
 *             shot, and the one that makes a bore feel like a bore.
 * - `cinematic` a lineside camera the train sweeps past, cutting to a new one
 *             ahead each time. Where it stands depends on what the line is
 *             doing: a field, a rooftop over the elevated street, or the tube
 *             itself underground.
 * - `drone`   a high shot orbiting slowly behind, which is the only view that
 *             shows the whole 41 m formation and the country it is crossing.
 */

/** What the rig needs back: the same shape the car's camera configs have. */
export interface RailShot {
  fov: number;
  fovBoost: number;
  positionHalfLife: number;
  targetHalfLife: number;
}

export interface RailState {
  /** Arc length the current cinematic shot is planted at, or null between shots. */
  shotArc: number | null;
  /** Which side of the line it stands on: +1 left of travel, -1 right. */
  shotSide: 1 | -1;
  /** Which way the train was going when the shot was planted. */
  shotWay: 1 | -1;
  /** Drone orbit angle, radians. */
  orbit: number;
}

export const createRailState = (): RailState => ({
  shotArc: null, shotSide: 1, shotWay: 1, orbit: 0,
});

export const RAIL_CAMERA_MODES: readonly CameraMode[] = [
  'chase', 'cab', 'nose', 'top', 'cinematic', 'drone',
] as const;

/**
 * True for the modes this module owns — including `chase`, which on rails is a
 * different shot from the car's. See `RAIL_CAMERA.chase`. The caller gates this
 * on the vehicle actually being the main-line train.
 */
export const isRailShot = (mode: CameraMode) => mode === 'chase' || mode === 'cab'
  || mode === 'nose' || mode === 'top' || mode === 'cinematic' || mode === 'drone';

const eye = new Vector3();
const aim = new Vector3();

/** Signed distance from `from` to `to` round the loop, shortest way. */
function ahead(from: number, to: number): number {
  let d = ((to - from) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  if (d > TRAIN_LENGTH / 2) d -= TRAIN_LENGTH;
  return d;
}

/**
 * A point beside the train's own road: `side` metres left of it at `arc`, `up`
 * metres over the rail.
 *
 * Beside the *road*, not the running line. Once the train can change track
 * (`pointwork`) every offset here has to be measured from the rails it is
 * actually on, or crossing to the down line slides the whole rig 4.6 m off the
 * train — and a cab camera ends up hanging outside the cab.
 */
function beside(arc: number, side: number, up: number, out: Vector3) {
  const s = trainWrap(arc);
  const [x, y, z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  const off = side + lateralAt(livePoints, s);
  out.set(x + nx * off, y + up, z + nz * off);
}

export function updateRailCamera(
  mode: CameraMode,
  state: RailState,
  delta: number,
  telemetry: VehicleTelemetry,
  outPosition: Vector3,
  outTarget: Vector3,
): RailShot {
  const arc = telemetry.railArc;
  /*
   * Two directions, and every shot here needs the right one.
   *
   *   drive   the DRIVER's: is the train going the way the cab faces? That is
   *           what decides which end of the rake leads, and so which cab the
   *           cab shot sits in. Stopped counts as forwards — a parked train
   *           still has a front.
   *   way     the LINE's: is the train moving up the arc or down it? Every
   *           camera position in this file is an arc (`beside`, `along`), so
   *           this is what places them.
   *
   * They were the same number until the train started spawning on either
   * running line — the down one turns it round (`telemetry.railFacing`), and
   * from then on a rig that used the driver's direction to pick an arc stood
   * in FRONT of the train and looked away from it.
   */
  const drive: 1 | -1 = telemetry.forwardSpeed < -0.2 ? -1 : 1;
  const facing: 1 | -1 = telemetry.railFacing < 0 ? -1 : 1;
  const way: 1 | -1 = drive * facing > 0 ? 1 : -1;
  const enclosed = Math.min(1, Math.max(0, telemetry.enclosed));
  // The rake length is a setting now, and two of these shots depend on it: the
  // cab has to find the rear cab, and a planted shot has to hold until the
  // whole train has gone by. `formationFor` is memoised per count.
  const carriages = settingsSnapshot().carriages;
  const formation = formationFor(carriages);
  const rake = formationLength(carriages);

  /**
   * A point `down` metres along the train from its leading end, as something to
   * look at. On a 147 m rake the true middle is 74 m back, which for a lineside
   * shot means staring at coach four while the locomotive goes by — so each
   * shot names how far down the train it wants to hold.
   */
  const along = (down: number) => {
    const s = trainWrap(arc - down * way);
    const at = locomotivePose(s, 1, (a) => lateralAt(livePoints, a));
    return { x: at.x, y: at.y + 2, z: at.z };
  };

  if (mode === 'chase') {
    const C = RAIL_CAMERA.chase;
    // Off to one side, clear of the bodies — a rig directly behind the leading
    // locomotive is inside the first coach.
    //
    // The side is multiplied by `way`, exactly as the cab's is, and that is not
    // cosmetic. `beside` measures its offset LEFT OF THE ARC, so an unsigned
    // side is a fixed side of the *line*, not of the driver: running up it sat
    // on the driver's left, and running down — which is half of all spawns,
    // since the train starts on either road — it sat on his right. The shot
    // mirrored between the two, and with it the whole scene: the second track,
    // which is always on the driver's left because this railway runs on the
    // right, appeared on the far side of the train on a down-line spawn and the
    // ride read as wrong-line running. It was never the train; it was the rig.
    // Underground it tucks into the tube (see `RAIL_CAMERA.chase.bore*`): the
    // open-air offset is in the rock inside a bore, and from there the walls
    // are back-faced and invisible, so the station read as floating in a void.
    const mix = (open: number, bore: number) => open + (bore - open) * enclosed;
    beside(arc - mix(C.back, C.boreBack) * way, mix(C.side, C.boreSide) * way, mix(C.up, C.boreUp), eye);
    outPosition.copy(eye);
    const focus = along(mix(C.look, C.boreLook));
    outTarget.set(focus.x, focus.y, focus.z);
    return {
      fov: C.fov, fovBoost: C.fovBoost, positionHalfLife: 0.16, targetHalfLife: 0.12,
    };
  }

  if (mode === 'cab' || mode === 'nose') {
    const C = RAIL_CAMERA;
    // Which unit's cab is leading, and where its nose points. Running the
    // other way, the trailing engine is at the front and faces backward, so
    // its cab is that much further back down the line.
    const unit = drive > 0 ? formation[0] : formation[formation.length - 1];
    const nose = LOCOMOTIVE.size[2] / 2;
    // Distance from the driving locomotive's centre to this cab, signed along
    // the line in the direction the train is travelling.
    // Into the body for the cab, a little past the coupler for the nose.
    const from = mode === 'cab' ? nose - C.cab.inset : nose + C.nose.clear;
    // Signed along the LINE: the distance is measured in the train's own frame
    // (forward is `from`, propelling is back past the whole rake) and then
    // turned into arc by the facing.
    const toCab = facing * (drive > 0 ? from : -(unit.offset + from));
    const cabArc = trainWrap(arc + toCab);
    const at = locomotivePose(cabArc, 1, (a) => lateralAt(livePoints, a));
    const height = mode === 'cab' ? C.cab.eye : C.nose.eye;
    const reach = mode === 'cab' ? C.cab.ahead : C.nose.ahead;
    // Sat on the line and lifted, rather than offset in body space: the pose is
    // already on the curve, and a body-space offset would swing the eye out of
    // the cab through every corner.
    const side = mode === 'cab' ? C.cab.side * way : 0;
    const [nx, nz] = trainNormalAt(cabArc);
    outPosition.set(at.x + nx * side, at.y + height, at.z + nz * side);
    // Look up the line the way the train is going, not along the body: on a
    // curve the two differ by a degree or two and the line is what a driver
    // watches.
    beside(arc + toCab + reach * way, 0, height * 0.55, aim);
    outTarget.copy(aim);
    return {
      fov: mode === 'cab' ? 62 : 68,
      fovBoost: mode === 'cab' ? 6 : 10,
      positionHalfLife: 0.02,
      targetHalfLife: 0.07,
    };
  }

  if (mode === 'top') {
    const C = RAIL_CAMERA.top;
    // Straight over the engine, tucking down into the tube underground.
    const up = C.up + (C.boreUp - C.up) * enclosed;
    const back = C.back + (C.boreBack - C.back) * enclosed;
    beside(arc - back * way, 0, up, eye);
    outPosition.copy(eye);
    const focus = along(C.look);
    outTarget.set(focus.x, focus.y, focus.z);
    return { fov: C.fov, fovBoost: 3, positionHalfLife: 0.08, targetHalfLife: 0.08 };
  }

  if (mode === 'cinematic') {
    const C = RAIL_CAMERA.cinematic;
    const pace = Math.abs(telemetry.forwardSpeed);
    const lead = Math.min(C.leadMax, Math.max(C.leadMin, C.leadBase + pace * C.leadPerSpeed));
    const hold = C.holdBase + pace * C.holdPerSpeed;
    // Cut when the train has run `hold` past the shot, when it turns round, or
    // when there is no shot yet.
    // The whole train has to clear the camera before cutting, or the shot ends
    // with coaches still in frame.
    const clear = hold + (C.holdFormation ? rake : 0);
    const past = state.shotArc === null ? Infinity : -ahead(arc, state.shotArc) * state.shotWay;
    if (state.shotArc === null || state.shotWay !== way || past > clear) {
      state.shotArc = trainWrap(arc + lead * way);
      // Alternate sides, so a run of shots is not a run of the same shot.
      state.shotSide = state.shotSide === 1 ? -1 : 1;
      state.shotWay = way;
    }
    const shot = state.shotArc;
    // Where the camera can stand depends on what the line is doing there. This
    // is the whole difficulty of a planted shot: a field is 21 m of clear
    // ground, a bore is a 5 m tube, and over a city street the only clear air
    // is above the roofs.
    const place = trainEnclosedAt(shot) ? C.bore : trainStreetAt(shot) ? C.street : C.open;
    beside(shot, place.side * state.shotSide, place.up, eye);
    outPosition.copy(eye);
    // Hold the locomotive and its first coach, not the middle of the rake.
    const focus = along(C.look);
    outTarget.set(focus.x, focus.y, focus.z);
    return {
      fov: C.fov,
      fovBoost: 0,
      // The position must not slide between shots: a cut is a cut. Only the
      // pan is smoothed, and that comes from the target.
      positionHalfLife: 0.001,
      targetHalfLife: 0.06,
    };
  }

  // Drone. High and slowly orbiting, tucking into the tube where the line goes
  // under — 21 m up is solid rock down there, and `telemetry.enclosed` is
  // already the damped answer to that question.
  const C = RAIL_CAMERA.drone;
  state.orbit += C.orbit * delta;
  const back = C.back + (C.boreBack - C.back) * enclosed;
  const up = C.up + (C.boreUp - C.up) * enclosed;
  // The orbit is a lateral swing rather than a full circle: the shot stays
  // behind the train, which is where a following drone would be.
  const swing = Math.sin(state.orbit) * (1 - enclosed);
  beside(arc - back * way, back * 0.55 * swing, up, eye);
  outPosition.copy(eye);
  const focus = along(C.look * (1 - enclosed) + 12 * enclosed);
  outTarget.set(focus.x, focus.y, focus.z);
  return { fov: C.fov, fovBoost: 4, positionHalfLife: 0.28, targetHalfLife: 0.2 };
}
