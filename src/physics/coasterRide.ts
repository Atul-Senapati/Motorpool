import { Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { damp } from './vehiclePhysics';

/**
 * Riding Halcyon Pier's roller coaster.
 *
 * The seam between the halo you board from (`CoasterBoarding`), the park that
 * runs the trains (`AmusementPark`) and the camera that sits you in the front
 * car (`RacingCamera`). Module-level for the same reason `portals` is: every
 * reader is a frame callback, and none of them wants a React subscription.
 *
 * Your own vehicle never moves. It stays parked in the halo while the camera
 * rides, and it is where you are when you get off.
 */
/** The ride's views, cycled with C while riding. */
export const COASTER_VIEWS = ['front', 'back', 'chase', 'trackside', 'aerial'] as const;
export type CoasterView = (typeof COASTER_VIEWS)[number];
export const COASTER_VIEW_NAMES: Record<CoasterView, string> = {
  front: 'FRONT SEAT', back: 'BACK SEAT', chase: 'CHASE', trackside: 'TRACKSIDE', aerial: 'AERIAL',
};

export const coasterRide = {
  /** The camera is on the coaster. */
  riding: false,
  /**
   * Set on boarding; the park answers it on its next frame by winding its
   * clock to the front train sitting in the station just before it leaves, so
   * a ride always starts at the platform rather than halfway down the drop.
   */
  boardRequested: false,
  /** The first train's cars, front to back, as the park last placed them. */
  cars: [] as Array<Object3D | null>,
  view: 'front' as CoasterView,
};

/** Get on: front seat, and the park winds the train back to the platform. */
export function boardCoaster() {
  coasterRide.boardRequested = true;
  coasterRide.view = 'front';
  rig.snap = true;
  coasterRide.riding = true;
}

/** Next view; the camera snaps rather than flying between them. */
export function cycleCoasterView(): CoasterView {
  coasterRide.view = COASTER_VIEWS[(COASTER_VIEWS.indexOf(coasterRide.view) + 1) % COASTER_VIEWS.length];
  rig.snap = true;
  return coasterRide.view;
}

const WORLD_UP = new Vector3(0, 1, 0);
const ahead = new Vector3();
const side = new Vector3();
const up = new Vector3();
const eye = new Vector3();
const aim = new Vector3();
const head = new Vector3();
const tail = new Vector3();
const spot = new Vector3();
const rig = {
  snap: true,
  eye: new Vector3(),
  aim: new Vector3(),
  lastHead: new Vector3(),
  speed: 0,
  orbit: 0,
  time: 0,
};

/** Head height over a car's floor, and how far down the track you look. */
const EYE_UP = 1.25;
const LOOK_DROP = 0.12;
/** Lens per view: the seats wide, the long shots tight. */
const FOV: Record<CoasterView, number> = { front: 72, back: 70, chase: 62, trackside: 38, aerial: 42 };
/** A wide lens: a coaster is all peripheral vision. */
export const COASTER_FOV = FOV.front;

/**
 * Trackside cameras, in the coaster's own frame (the trains' parent): round
 * the yard at eye height, and two up on poles. The one nearest the train has
 * the shot. The circuit spans x −45..44 and z −17..26 in this frame.
 */
const SPOTS: ReadonlyArray<readonly [number, number, number]> = [
  [-56, 1.7, -28], [0, 1.7, -30], [56, 1.7, -28],
  [-56, 1.7, 36], [0, 1.7, 38], [56, 1.7, 36],
  [-62, 9, 4], [62, 9, 4],
];
/** The aerial orbit, in the same frame: round the ride's middle. */
const ORBIT = { centre: [0, 14, 4] as const, radius: 95, height: 52, rate: 0.06 };

/** A car's frame. The clip's cars are Z-up and face −X. */
function frameOf(car: Object3D, pos: Vector3) {
  car.updateWorldMatrix(true, false);
  car.matrixWorld.extractBasis(side, aim, up);
  ahead.copy(side).normalize().negate();
  up.normalize();
  car.getWorldPosition(pos);
}

/**
 * Place the camera for the current view. Called by the park straight after it
 * has placed the trains, so the train and the camera are always the same
 * frame — the camera rig stands aside while `riding` (see `RacingCamera`).
 *
 * The clip's cars are Z-up and face −X — measured off the circuit, where the
 * direction of travel is −X at every key and +Z is square to it — so the
 * seats are built in that frame and the horizon rolls and inverts with the
 * car through the loops. The outside views keep the world's up.
 */
export function seatCamera(camera: PerspectiveCamera, delta: number) {
  const { cars, view } = coasterRide;
  const front = cars[0];
  const back = cars[cars.length - 1] ?? front;
  if (!front || !back) return;
  rig.time += delta;

  back.getWorldPosition(tail);
  frameOf(front, head);
  // Speed off the head's travel, for the rattle.
  if (delta > 0) rig.speed = damp(rig.speed, head.distanceTo(rig.lastHead) / delta, 0.15, delta);
  rig.lastHead.copy(head);
  if (rig.snap) rig.speed = 0;

  const snap = rig.snap;
  rig.snap = false;

  if (view === 'front' || view === 'back') {
    if (view === 'back') frameOf(back, tail);
    const seat = view === 'back' ? tail : head;
    eye.copy(seat).addScaledVector(up, view === 'back' ? EYE_UP + 0.1 : EYE_UP);
    camera.position.copy(eye);
    camera.up.copy(up);
    camera.lookAt(aim.copy(eye).add(ahead).addScaledVector(up, -LOOK_DROP));
    // The rattle: wheels on steel, quickening and growing with speed.
    const k = Math.min(rig.speed / 25, 1.4);
    const a = 0.0045 * k * k;
    if (a > 1e-5) {
      const t = rig.time;
      camera.rotateX((Math.sin(t * 41.3) + Math.sin(t * 67.1) * 0.5) * a);
      camera.rotateY((Math.sin(t * 37.7) + Math.sin(t * 59.3) * 0.4) * a * 0.7);
      camera.rotateZ(Math.sin(t * 29.9) * a * 0.6);
    }
  } else {
    const frame = front.parent;
    frame?.updateWorldMatrix(true, false);
    if (view === 'chase') {
      // Behind the last car and above it, looking up the train.
      frameOf(back, tail);
      eye.copy(tail).addScaledVector(ahead, -9).addScaledVector(WORLD_UP, 4.5);
      aim.copy(head).addScaledVector(WORLD_UP, 1);
    } else if (view === 'trackside') {
      let best = Infinity;
      for (const s of SPOTS) {
        spot.set(s[0], s[1], s[2]);
        if (frame) spot.applyMatrix4(frame.matrixWorld);
        const d = spot.distanceToSquared(head);
        if (d < best) { best = d; eye.copy(spot); }
      }
      aim.copy(head);
    } else {
      rig.orbit += delta * ORBIT.rate;
      eye.set(
        ORBIT.centre[0] + Math.cos(rig.orbit) * ORBIT.radius,
        ORBIT.height,
        ORBIT.centre[2] + Math.sin(rig.orbit) * ORBIT.radius,
      );
      if (frame) eye.applyMatrix4(frame.matrixWorld);
      aim.copy(head);
    }
    if (snap) {
      rig.eye.copy(eye);
      rig.aim.copy(aim);
    } else {
      // The chase is eased so the loops do not throw it about; the planted
      // shots cut between spots and only the aim is eased.
      const eyeLife = view === 'chase' ? 0.22 : 0;
      rig.eye.set(
        damp(rig.eye.x, eye.x, eyeLife, delta), damp(rig.eye.y, eye.y, eyeLife, delta), damp(rig.eye.z, eye.z, eyeLife, delta),
      );
      if (view !== 'chase') rig.eye.copy(eye);
      rig.aim.set(
        damp(rig.aim.x, aim.x, 0.08, delta), damp(rig.aim.y, aim.y, 0.08, delta), damp(rig.aim.z, aim.z, 0.08, delta),
      );
    }
    camera.position.copy(rig.eye);
    camera.up.copy(WORLD_UP);
    camera.lookAt(rig.aim);
  }

  if (camera.fov !== FOV[view]) {
    camera.fov = FOV[view];
    camera.updateProjectionMatrix();
  }
}
