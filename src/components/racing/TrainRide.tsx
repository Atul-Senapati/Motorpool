'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { RigidBody, useBeforePhysicsStep, type RapierRigidBody } from '@react-three/rapier';
import { Euler, Quaternion, type Group } from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import {
  CARRIAGE, DEFAULT_CARRIAGES, LOCOMOTIVE, RAIL_HIDE_LEAD, formationFor, formationLength, locomotivePose,
  trainEnclosedAt, trainWrap, trainDarknessAt,
} from '@/config/trainConfig';
import {
  ahead, bufferAhead, lateralAt, liftAt, livePlayerRoute, railLimitAt, railOffLineAt, railPointOf, roadS, leadEnd, leverLocked, livePoints, occupiedTrack, pointsAhead,
  diamondAhead, pointsCeiling, resetPoints, roadAt, roadOf, routeHandover, settlePoints, stepPoints, trainSpaces,
  type Rake,
} from '@/config/pointwork';
import { playerRoad, runsAlongArc } from '@/config/railSpawn';
import { STATION, STATION_SITE } from '@/config/stationConfig';
import { branchStart, requestedTrainStart } from '@/config/trainStations';
import { PHYSICS_TIMESTEP, VEHICLE } from '@/config/vehicleConfig';
import { damp } from '@/physics/vehiclePhysics';
import { Headlamps } from './Headlamps';
import { ShadowProxy } from './shadowProxy';
import { forgetTrain, reportTrain, trainsOnTrack } from '@/physics/trainRegistry';
import type { useKeyboardControls } from '@/hooks/useKeyboardControls';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';

useGLTF.preload(LOCOMOTIVE.model, DRACO_PATH);
useGLTF.preload(CARRIAGE.model, DRACO_PATH);

/** The branch's own profile under the player's train — see `Road.rise`. */
const liftOf = (a: number) => liftAt(livePoints, a);
/**
 * Where the player's train's road is — the running line plus an offset, or the
 * branch's own route out to Skylark and the trunk. See `railPlaceAt`.
 */
const placeOf = (a: number) => railPointOf(livePoints, a);

/** Metres between the samples that find which running lines the rake fouls. */
const FOUL_STEP = 4;
/**
 * How far either side of a junction the ridden train is filed on both
 * railways: a service's own block and then some, so one about to cross from
 * the loop to the running line or back sees it in time.
 */
const JOIN_WINDOW = 700;

/**
 * Top speed, m/s, from the garage entry's stated ceiling. A function, read at
 * use: the train can be boarded mid-drive (`StationBoarding`), and the vehicle
 * config is rebuilt for it then, after this module has loaded.
 */
const topSpeed = () => VEHICLE.engine.maxSpeedKph / 3.6;
/**
 * Backwards is as fast as forwards.
 *
 * `TramRide` holds its reverse to a 4 m/s shunt, on the grounds that you cannot
 * see where you are going. A locomotive has a cab at one end only and would
 * have even less excuse — but it was asked for, and it is defensible: this is
 * not a shunt, it is running long-hood-first, which real locomotives do at line
 * speed. The vehicle is not turned round to do it; the blunt end simply leads.
 *
 * The consequence is that the overspeed guard below has to work in **both**
 * directions. Looking only forward while doing 250 backwards would leave the
 * whole line unrestricted in reverse.
 */
const reverseSpeed = topSpeed;

/**
 * Acceleration and braking, m/s². Deliberately not a real locomotive's.
 *
 * A Class 43 pulls away at about 0.9 m/s² and stops at 1.6, and those
 * were the first figures here. They are honest and they are no fun on a 9.2 km
 * loop: 0.9 takes seventy seconds and two and a half kilometres to reach a
 * 250 km/h ceiling, so the ceiling is never seen, and 1.6 makes the overspeed
 * lookahead a kilometre and a half long, so the train brakes for corners it
 * cannot yet see and never gets going at all.
 *
 * 3.2 and 4.2 are what the game wants instead: still unmistakably a train —
 * twenty-six seconds and 1.1 km to a 300 km/h ceiling, 830 m to stop from it —
 * but the whole loop is drivable rather than one long brake application.
 * Braking has to rise with acceleration, not just because stopping distance
 * would otherwise be absurd, but because the lookahead below is derived from
 * it.
 */
const ACCEL = 3.2;
const BRAKE = 4.2;
/**
 * The emergency application, m/s².
 *
 * A real emergency brake is not a harder press of the same pedal — it dumps the
 * brake pipe, which is why it cannot be feathered and cannot be released until
 * the train has stopped. Both of those are modelled below (`emergency`), and
 * they are what make this a control rather than a stronger `S`.
 *
 * 9.0 against the service 4.2 is a little over double, which is roughly the
 * real ratio between a full service application and an emergency one. In this
 * game's numbers that is 830 m to stop from 300 km/h on the service brake and
 * **386 m** on the emergency — a difference big enough to be worth reaching for
 * and small enough that it is still a train stopping, not a wall.
 */
const EMERGENCY_BRAKE = 9.0;
/** Coasting drag with neither pedal, m/s². Rolling resistance on steel is tiny. */
const COAST = 0.09;

/**
 * How far past the braking distance the overspeed system looks, and how finely.
 *
 * A restriction has to be picked up far enough out that the brake can take the
 * train down to it; anything less and the limit could only be enforced by
 * snapping the speed down at the board, which is not braking, it is teleporting.
 */
const LOOKAHEAD_MARGIN = 30;

/**
 * How long the indicator holds its refusal, seconds.
 *
 * A lever that will not move needs to say so for long enough to be read but not
 * long enough to be mistaken for a state — this is a flash, like the brake
 * telltale, not a mode.
 */
const LOCK_FLASH = 0.9;
const LOOKAHEAD_STEP = 12;

/**
 * Where the driving end is, as an offset along the body from its centre.
 *
 * Everything downstream — the camera rig, the minimap arrow, the compass, the
 * reported position — hangs off this rather than off the body centre, because
 * that is where a driver sits. Two metres inside the nose rather than on the
 * tip, so the arrow is on the cab and not on the coupler.
 */
const CAB_OFFSET = LOCOMOTIVE.size[2] / 2 - 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How far either side of the locomotive the tunnel test looks, and how quickly
 * the camera answer follows it.
 *
 * The chase rig sits about fifteen metres behind and the reverse rig the same
 * in front, so the eye reaches a portal well before or after the vehicle does;
 * testing both ends means the rig is already tucked in by the time it matters,
 * and stays tucked until the eye is clear. The half-life is short — ten metres
 * of travel at line speed — because a tunnel mouth is a hard edge and a slow
 * blend would have the rig still unwinding halfway through a short bore.
 *
 * Sixteen was not enough on the way *out*. The shader carves a hole for the
 * bore and nothing else, so the hillside a portal is cut into is solid rock
 * everywhere except that horseshoe — and the moment the locomotive clears the
 * mouth the rig swings back and up, out of the carved arch and into the hill.
 * What you get is the terrain's back faces filling the frame: two green wedges
 * either side of the cab converging over the roof, apparently grass hanging in
 * the air above the track. Thirty-six covers the rig at full extension plus the
 * swing, so it stays tucked until it is genuinely clear of the portal.
 */
const CAMERA_REACH = 36;
const ENCLOSED_HALF_LIFE = 0.12;

/**
 * `?arc=<metres>` starts the locomotive that far round the loop instead of at
 * zero — the railway's equivalent of the car's `?spawn=<n>`, and for the same
 * reason: to reproduce a report about one particular stretch, or to put the
 * camera in a tunnel without driving three kilometres to it first. Read once at
 * mount, client-side only, like `pickCitySpawn`.
 */
const ARC_PARAM = 'arc';
/**
 * Where the ride starts: at the station, always — standing at the platform,
 * the lead cab near its far end so the whole rake is alongside it (the user:
 * "the train should start from the station only"). `?arc=` still overrides,
 * for testing a particular stretch.
 */
function startingArc(facing: 1 | -1): number {
  if (typeof window !== 'undefined') {
    const requested = Number(new URLSearchParams(window.location.search).get(ARC_PARAM));
    if (Number.isFinite(requested) && requested > 0) return trainWrap(requested);
  }
  if (!STATION_SITE) return 0;
  return trainWrap(STATION_SITE.arc + facing * (STATION.platformLength / 2 - 12));
}


/**
 * The player's locomotive.
 *
 * Like `TramRide`, this replaces `CarPhysics` rather than configuring it: a
 * railway vehicle has no steering and no suspension worth simulating, and
 * `trainConfig` already parametrises the line by arc length — so driving one is
 * a single scalar pushed along by a throttle and a brake. The rails steer.
 *
 * It is two locomotives, not one — see `FORMATION`. They are coupled back to
 * back, so the formation has a cab at each end, and each unit is posed on the
 * curve from its own arc length rather than hung off the leader: at 41 m over a
 * 106 m radius the pair is visibly not straight, and one rigid body could not
 * bend. The second engine is dead weight as far as the physics is concerned —
 * nothing here models tractive effort per unit — but it is what the line looks
 * like it needs, and it is what makes running the other way sensible.
 *
 * What makes it a *train* rather than a long tram is the two numbers above and
 * the speed restrictions below. It takes a kilometre to stop, and the line it
 * runs on was searched rather than surveyed, so it has 30 m corners in it that
 * no locomotive can take at speed. Both together mean the interesting part of
 * driving it happens well before the corner arrives.
 */
export function TrainRide({
  input,
  telemetry,
  chassisRef,
  cameraModeRef,
  carriages = DEFAULT_CARRIAGES,
}: {
  input: ReturnType<typeof useKeyboardControls>;
  telemetry: RefObject<VehicleTelemetry>;
  chassisRef: RefObject<Group | null>;
  /**
   * Read only to hide the body the cab camera is sitting inside — see
   * `RAIL_HIDE_LEAD`. Nothing about the driving depends on it.
   */
  cameraModeRef?: RefObject<CameraMode>;
  /**
   * Coaches between the two locomotives, from the settings panel. Changing it
   * re-renders this component, which remounts the clones and their bodies —
   * cheap, because both scenes are already loaded and the geometry is shared.
   */
  carriages?: number;
}) {
  const { scene } = useGLTF(LOCOMOTIVE.model, DRACO_PATH);
  const { scene: coachScene } = useGLTF(CARRIAGE.model, DRACO_PATH);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  const carriers = useRef<(Group | null)[]>([]);

  /**
   * This turn's spawn, resolved once.
   *
   * A lazy `useState` initialiser rather than an effect: it has to be settled
   * before the first physics step, and an effect and the frame loop both run
   * off the same commit with no ordering between them. It also puts the
   * module-level `livePoints` on the chosen road as it goes — `TrainRide` is
   * that state's only writer (see `livePoints`), so this is where it is
   * initialised as well as where it is reset.
   */
  const [spawn] = useState(() => {
    // Which line, and which way it is worked: both come from `railSpawn`, which
    // is also what `TrainLine` asks, so the player and the services can never
    // end up on the same road going the same way. `?road=up|down` pins it, for
    // the same reason `?arc=` exists.
    // Boarded at a branch station (Halcyon Junction, Skylark): on that
    // station's road, standing at its platform. Otherwise the main line.
    const branch = branchStart(requestedTrainStart());
    const road = branch?.road ?? playerRoad();
    resetPoints(livePoints, road);
    const facing = branch?.facing ?? runsAlongArc(road);
    return { arc: branch?.arc ?? startingArc(facing), road, facing };
  });
  /**
   * Which way round the train stands on the line, in arc terms.
   *
   * Everything the driver does stays in the driver's own frame — `speed` is
   * positive when the train is going the way the cab faces, whichever line it
   * is on — and this is the one number that converts that frame into the
   * line's. Arc advances by `FACING * speed`, the models are posed along
   * `FACING`, and `way` (which end of the rake reaches the points first, which
   * direction the signals are told about) is `FACING * sign(speed)`.
   *
   * Doing it this way rather than flipping the controls means nothing
   * downstream of here needs to know: the pointwork, the speed guard and the
   * registry all keep talking in arc, and the throttle keeps meaning forward.
   */
  const FACING = spawn.facing;

  const travelled = useRef(spawn.arc);
  const speed = useRef(0);
  /** Seconds left of the "points locked" flash — see `LOCK_FLASH`. */
  const locked = useRef(0);
  /**
   * The emergency brake, latched.
   *
   * Latched because that is the whole character of the control: once the pipe
   * is dumped the train stops, and the driver does not get to change their mind
   * half way. It clears only when the train is at a stand *and* the key is
   * back up, so releasing early leaves it applied and holding the key at a
   * stand keeps it applied.
   */
  const emergency = useRef(false);
  /** How dark it is where the train is — see `Headlamps`. */
  const darkness = useRef(0);

  const scratch = useMemo(() => ({
    quaternion: new Quaternion(), euler: new Euler(0, 0, 0, 'YXZ'),
  }), []);

  // One clone per unit. Cloned so drei's cached GLTF scene is never re-parented
  // out from under it; clones share geometry and materials, so a second engine
  // costs a draw call and a matrix rather than a second download. Same
  // reasoning as the scripted locomotive in `TrainLine`.
  const formation = useMemo(() => formationFor(carriages), [carriages]);

  /**
   * How far the train reaches either side of the arc that is integrated.
   *
   * `formationLength` measures from the leading locomotive's *centre* back to
   * the last vehicle's tail, so the reach forward is the other half of that
   * locomotive. The pointwork needs both because it is worked by whichever end
   * is leading — see `leadEnd`.
   */
  const rake = useMemo<Rake>(() => {
    const nose = formation[0].length / 2;
    const tail = formationLength(carriages);
    // `front`/`back` are metres of train either side of `arc` measured in ARC,
    // not in the train's own frame — so a rake facing down the line reaches
    // forward where one facing up it reaches back.
    return FACING > 0
      ? { arc: 0, front: nose, back: tail }
      : { arc: 0, front: tail, back: nose };
  }, [formation, carriages, FACING]);

  const models = useMemo(
    () => formation.map((unit) => (unit.model === 'loco' ? scene : coachScene).clone(true)),
    [formation, scene, coachScene],
  );

  // Off the registry when the ride ends, fouling reports included, or the
  // services keep stopping for a train that is no longer there.
  useEffect(() => () => {
    for (const id of ['player', 'player-foul-0', 'player-foul-1', 'player-loop', 'player-join', 'player-diamond']) forgetTrain(id);
    livePlayerRoute.active = false;
  }, []);

  // Shrinking the rake leaves refs from the units that have gone; React
  // unmounts their bodies, and trimming keeps the arrays honest about length.
  useEffect(() => {
    bodies.current.length = formation.length;
    carriers.current.length = formation.length;
  }, [formation]);

  useEffect(() => {
    for (const model of models) {
      model.traverse((child) => {
        // NOT a caster: a box does that for the whole vehicle, for one draw
        // call instead of a hundred. See `ShadowProxy`.
        child.castShadow = false;
        child.receiveShadow = true;
      });
    }
  }, [models]);

  /**
   * Where one unit sits, from the driving locomotive's arc length.
   *
   * `offset` is metres back down the line and `flip` turns the unit end for
   * end — which negates the pitch as well as turning the yaw, or a flipped
   * engine on a gradient tips the wrong way.
   */
  const unitPose = (leadArc: number, index: number) => {
    const unit = formation[index];
    // Each unit stands on its own bogie centres — see `locomotivePose` — and on
    // whichever road *its own* arc is on, which is what lets the rake straddle a
    // set of points with its ends on two different tracks. See `pointwork`.
    const arc = trainWrap(leadArc - FACING * unit.offset);
    const at = locomotivePose(arc, FACING, (a) => lateralAt(livePoints, a), unit.bogieCentres, liftOf, placeOf);
    return unit.flip
      ? { ...at, yaw: at.yaw + Math.PI, pitch: -at.pitch }
      : at;
  };

  /**
   * The lowest speed restriction between here and the point the brake could
   * bring the train down from `v`, looking whichever way it is travelling.
   *
   * This is what stops the locomotive arriving at a 30 m corner at line speed.
   * It is deliberately an *overspeed* system and not an autopilot: it will not
   * open the throttle, it only refuses to let the train be faster than the line
   * ahead allows, which is what real train protection does. The driver still
   * has to brake for anything they want to take gently, and still has to open
   * up again afterwards.
   *
   * `way` is +1 or -1. Since reverse runs at line speed too, the same guard has
   * to look back down the line when the train is going that way — the corners
   * are exactly as tight from the other side.
   */
  const limitAhead = (from: number, v: number, way: number) => {
    const distance = (v * v) / (2 * BRAKE) + LOOKAHEAD_MARGIN;
    let lowest = railLimitAt(livePoints, from);
    for (let d = LOOKAHEAD_STEP; d <= distance; d += LOOKAHEAD_STEP) {
      // A restriction `d` away only binds now if the brake could not take the
      // train down to it in that distance, so each one is relaxed by what the
      // brake can shed on the way to it.
      // v² = L² + 2·B·d — see `pointsCeiling`. Adding the two speeds instead
      // relaxed every restriction by more than the brake can take off.
      const limit = railLimitAt(livePoints, trainWrap(from + way * d));
      lowest = Math.min(lowest, Math.sqrt(limit * limit + 2 * BRAKE * d));
    }
    return lowest;
  };

  // Integration and every Rapier write happen in the before-step callback, not
  // in useFrame: touching a body from the render loop races the physics step's
  // borrow of the World and throws the "recursive use of an object" abort.
  useBeforePhysicsStep(() => {
    const cmd = input.current;
    const dt = PHYSICS_TIMESTEP;
    if (!cmd) return;

    if (cmd.resetRequested) {
      cmd.resetRequested = false;
      travelled.current = spawn.arc;
      speed.current = 0;
      // Back on the road this turn started on, with no route called: a reset
      // that left the train remembering a crossover it had taken would put it
      // on the other line's offset at an arc where nothing had been crossed.
      // The road has to be the SPAWN road and not the up line, or a reset on
      // the down line would face the train one way and offset it the other.
      resetPoints(livePoints, spawn.road);
    }
    // The route lever. A press toggles the standing call, and the call stands
    // until it is put back — see `PointsState.armed`. Refused, not ignored,
    // when the blades are already under the leading wheels: `leverLocked`.
    if (cmd.pointsRequested) {
      cmd.pointsRequested = false;
      rake.arc = travelled.current;
      const heading: 1 | -1 = speed.current < -0.2 ? (-FACING as 1 | -1) : FACING;
      if (leverLocked(livePoints, rake, heading, Math.abs(speed.current) > 0.2)) {
        locked.current = LOCK_FLASH;
      } else {
        livePoints.armed = !livePoints.armed;
      }
    }
    // Righting a locomotive is meaningless; swallow the key rather than queue it.
    cmd.flipRequested = false;

    const v = speed.current;
    // The emergency brake. Applied by a strike of the key or by holding it,
    // released only by coming to a stand with it up — see `emergency`.
    if (cmd.emergencyRequested || cmd.handbrake) emergency.current = true;
    else if (Math.abs(v) < 0.05) emergency.current = false;
    cmd.emergencyRequested = false;

    let accel: number;
    if (emergency.current) {
      // Nothing else can be asked for while it is applied: no power, and no
      // choosing a gentler rate.
      accel = -Math.sign(v) * EMERGENCY_BRAKE;
    } else if (cmd.brake > 0) {
      // Brake to a stop, then pull away backwards — the car's convention, and
      // backwards accelerates on the same 3.0 m/s² as forwards.
      if (v > 0.2) accel = -BRAKE * cmd.brake;
      else accel = v > -reverseSpeed() ? -ACCEL * cmd.brake : 0;
    } else if (cmd.throttle > 0) {
      // Throttle while running backwards brakes first, however fast that is.
      accel = v < -0.2 ? BRAKE * cmd.throttle : ACCEL * cmd.throttle;
    } else {
      accel = -Math.sign(v) * COAST;
    }

    let next = v + accel * dt;
    // Coasting must settle at a standstill rather than buzzing around zero, and
    // so must the emergency brake — at 9 m/s² it would otherwise overshoot into
    // reverse and oscillate there, which is the one thing an emergency brake
    // must never look like.
    if (emergency.current && Math.abs(next) < EMERGENCY_BRAKE * dt * 1.5) next = 0;
    else if (cmd.brake === 0 && cmd.throttle === 0 && Math.abs(next) < COAST * dt * 1.5) next = 0;
    next = clamp(next, -reverseSpeed(), topSpeed());

    // The guard is symmetric because the speeds are: it caps the *magnitude*
    // in whichever direction the train is actually moving.
    const way: 1 | -1 = next < 0 ? (-FACING as 1 | -1) : FACING;
    // Everything the pointwork is asked is asked about the end that gets there
    // first, which propelling is the far end of the rake. See `leadEnd`.
    rake.arc = travelled.current;
    const lead = leadEnd(rake, way);
    // The line's own restrictions, and the pointwork's. A crossover is signed
    // for 110 km/h and the guard already knows how to brake for a number ahead,
    // so the diverging route is handed to it as one more restriction rather
    // than being enforced at the blades.
    const ceiling = Math.min(
      topSpeed(),
      limitAhead(lead, Math.abs(next), way),
      pointsCeiling(livePoints, lead, way, BRAKE),
    );
    // Over the ceiling the guard takes power off and brakes from the speed the
    // train is actually doing — not from `next`, which already has this step's
    // throttle in it. Braking from `next` left a driver holding the throttle
    // shedding only BRAKE − ACCEL, 1 m/s², while every braking curve above is
    // drawn for 4.2: the train reached a restriction, or the junction's buffer
    // stop, at several times the speed it was meant to be down to.
    if (next > ceiling) next = Math.max(ceiling, Math.min(next, v - BRAKE * dt));
    if (next < -ceiling) next = Math.min(-ceiling, Math.max(next, v + BRAKE * dt));

    speed.current = next;
    if (locked.current > 0) locked.current = Math.max(0, locked.current - dt);
    const previous = travelled.current;
    travelled.current = trainWrap(previous + FACING * next * dt);
    // Run the points with the leading end's movement. Nothing happens unless a
    // turnout was crossed this step, and what happens then depends on whether a
    // route was called for — or whether the road simply ends there.
    if (next !== 0) {
      rake.arc = travelled.current;
      stepPoints(livePoints, lead, leadEnd(rake, way), way);
      settlePoints(livePoints, rake, way);
      // The buffer stop. `pointsCeiling` has already braked the train onto a
      // stand short of it, so this only catches what the brake could not —
      // a frame's overshoot, or a train put onto the branch faster than its
      // stopping distance. It is a wall, not a limit: the leading end goes back
      // to the stand and the train stops dead, the way it would against a real
      // one, instead of the rake running on along an offset that has no rails.
      const front = leadEnd(rake, way);
      const over = -bufferAhead(roadOf(roadAt(livePoints, front)), front, way);
      if (over > 0) {
        travelled.current = trainWrap(travelled.current - way * over);
        speed.current = 0;
        emergency.current = false;
      }
      // Half way round the loop, onto the view of the road whose toe the train
      // is heading for — see `routeHandover`. Nothing moves; the arc it is
      // counted in does.
      rake.arc = travelled.current;
      const shift = routeHandover(livePoints, rake, way);
      if (shift) travelled.current = trainWrap(travelled.current + shift);
    }

    for (let i = 0; i < formation.length; i++) {
      const at = unitPose(travelled.current, i);
      scratch.euler.set(at.pitch, at.yaw, 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      const unit = bodies.current[i];
      const height = formation[i].model === 'loco' ? LOCOMOTIVE.bodyHeight : CARRIAGE.bodyHeight;
      unit?.setNextKinematicTranslation({
        x: at.x, y: at.y + height / 2, z: at.z,
      });
      unit?.setNextKinematicRotation(scratch.quaternion);
    }
  });

  // Visuals, telemetry and the camera anchor all track the same arc length.
  useFrame(() => {

    const at = locomotivePose(travelled.current, FACING, (a) => lateralAt(livePoints, a), undefined, liftOf, placeOf);
    // Which unit the cab camera is in, if any: the leading one, which is the
    // trailing engine when the train is running the other way.
    const inCab = RAIL_HIDE_LEAD && cameraModeRef?.current === 'cab';
    const occupied = speed.current < -0.2 ? formation.length - 1 : 0;
    for (let i = 0; i < formation.length; i++) {
      const group = carriers.current[i];
      if (!group) continue;
      const pose = i === 0 ? at : unitPose(travelled.current, i);
      group.position.set(pose.x, pose.y, pose.z);
      scratch.euler.set(pose.pitch, pose.yaw, 0);
      group.quaternion.setFromEuler(scratch.euler);
      group.visible = !(inCab && i === occupied);
    }

    // The camera rig hangs off the **body centre**, not the cab.
    //
    // `TramRide` anchors it at the leading cab, and has to: at 43.5 m a rig
    // framed on the whole vehicle sits 34 m back among the traffic. A single
    // 19.4 m locomotive is the opposite problem — anchor at the cab and the
    // chase offset, which is measured back from the anchor, lands *on the
    // roof* with fifteen metres of locomotive stretching towards the camera.
    // From the centre it comes out where a chase camera belongs: a few metres
    // behind the tail, looking down the line over the whole vehicle.
    const anchor = chassisRef.current;
    if (anchor) {
      anchor.position.set(at.x, at.y, at.z);
      scratch.euler.set(0, at.yaw, 0);
      anchor.quaternion.setFromEuler(scratch.euler);
    }

    // The map arrow, the compass and the reported position stay on the cab,
    // which is where the driver is and what a route is followed from.
    const cabArc = trainWrap(travelled.current + FACING * CAB_OFFSET);
    // Out on the branch there are no bores, whatever the running line does at
    // the same arc.
    darkness.current = railOffLineAt(livePoints, travelled.current) ? 0 : trainDarknessAt(travelled.current);
    // Where the ridden train is, for the signals, the level crossing and the AI
    // services that have to keep off the driver's road.
    //
    // All three of these were wrong before, and wrong in the same way: the
    // track was hardcoded to the up line and the direction to forwards, from
    // when the ridden train could only be on one road going one way. It can now
    // cross over, take a loop and run backwards, so the report is derived.
    // `arc` is the LEADING end, because that is what `Lineside` measures the
    // rake back from.
    rake.arc = travelled.current;
    const way: 1 | -1 = speed.current < -0.2 ? (-FACING as 1 | -1) : FACING;
    const head = leadEnd(rake, way);
    const track = occupiedTrack(livePoints, head);
    // Standing in a loop is not standing on the line. Reporting nothing is what
    // lets a service run past the platform the player is sitting at.
    if (track === 0 || track === 1) {
      reportTrain('player', {
        arc: head, track, direction: way, length: rake.front + rake.back,
        // Along the driver's own direction of travel, which `way` already is —
        // so this is a magnitude, and a train reversing reports the speed it
        // is doing on the heading it reports. See `blockLimit`.
        speed: Math.abs(speed.current),
      });
    } else forgetTrain('player');
    // Out on the junction branch's route — for the Skylark line's crossings,
    // which count along that route rather than round the running line.
    const leadRoad = roadOf(roadAt(livePoints, head));
    livePlayerRoute.active = !!leadRoad.place;
    if (leadRoad.place) {
      livePlayerRoute.head = leadRoad.routeB ? leadRoad.routeB(head) : roadS(leadRoad, head);
      livePlayerRoute.dir = way;
      livePlayerRoute.length = rake.front + rake.back;
      livePlayerRoute.speed = Math.abs(speed.current);
    }
    // Out on the branch loop, for the services running it — and near either
    // junction, on the running line too, so a service does not run through
    // the ridden train coming off the loop or wait for nothing when it is
    // not. See `trainSpaces`.
    {
      const spaces = trainSpaces(livePoints, rake, way, livePoints.armed, JOIN_WINDOW);
      const body = rake.front + rake.back;
      const onLoop = spaces.find((p) => p.line === 'loop');
      if (onLoop) {
        reportTrain('player-loop', {
          arc: onLoop.arc, track: onLoop.track, direction: way, length: body,
          speed: Math.abs(speed.current), line: 'loop', owner: 'player',
        });
      } else forgetTrain('player-loop');
      // A junction's diamond ahead on the ridden train's road: held for it, so
      // a down service stops short rather than meet it on the crossing. The
      // driver is not interlocked — the claim is simply always granted.
      const diamond = diamondAhead(livePoints, rake, way, livePoints.armed, JOIN_WINDOW);
      if (diamond) {
        reportTrain('player-diamond', {
          arc: diamond.arc + 8, track: 1, direction: 1, length: 16, speed: 0, owner: 'player',
        });
      } else forgetTrain('player-diamond');
      const joining = spaces.find((p) => p.line === 'main');
      if (joining && track === -1) {
        reportTrain('player-join', {
          arc: joining.arc, track: joining.track, direction: way, length: body,
          speed: Math.abs(speed.current), owner: 'player',
        });
      } else forgetTrain('player-join');
    }
    // The rest of the rake. The report above is the LEADING end's road, and a
    // train is longer than a junction: with the nose in the branch or a loop,
    // the coaches behind can still be standing on the up line, or across the
    // down line on the diamond. Each running line the body fouls, other than
    // the one already reported, gets a report of its own covering just the
    // stretch that fouls it, so the services stop short of the coaches rather
    // than running through them.
    for (const line of [0, 1] as const) {
      const id = `player-foul-${line}`;
      if (line === track) { forgetTrain(id); continue; }
      const body = rake.front + rake.back;
      let first = -1;
      let last = -1;
      for (let d = 0; d <= body; d += FOUL_STEP) {
        if (occupiedTrack(livePoints, trainWrap(head - way * d)) !== line) continue;
        if (first < 0) first = d;
        last = d;
      }
      if (first < 0) { forgetTrain(id); continue; }
      reportTrain(id, {
        arc: trainWrap(head - way * first), track: line, direction: way,
        length: last - first + FOUL_STEP, speed: Math.abs(speed.current),
      });
    }
    const cab = locomotivePose(cabArc, FACING, (a) => lateralAt(livePoints, a), undefined, liftOf, placeOf);

    const t = telemetry.current;
    if (t) {
      const v = speed.current;
      t.forwardSpeed = v;
      t.speedKph = Math.abs(v) * 3.6;
      t.braking = ((input.current?.brake ?? 0) > 0 || emergency.current) && Math.abs(v) > 0.2;
      t.reversing = v < -0.4;
      // The plunger is the nearest thing this vehicle has to a handbrake, and
      // reporting it keeps anything generic that reads the flag honest.
      t.handbrake = emergency.current;
      t.railEmergency = emergency.current;
      // No engine note and no gearbox to report. The dial is fed the tractive
      // load instead, so it says something true about the vehicle rather than
      // sitting dead at idle — the same substitution `TramRide` makes.
      const load = Math.min(Math.abs(v) / topSpeed(), 1);
      t.rpm = VEHICLE.engine.idleRpm
        + (VEHICLE.engine.maxRpm - VEHICLE.engine.idleRpm) * load;
      t.gear = 1;
      t.slip = 0;
      // Enclosed if the vehicle *or* either end of the camera's reach is: see
      // CAMERA_REACH. Damped, so a portal is a quick tuck rather than a jump.
      const enclosed = (a: number) => !railOffLineAt(livePoints, a) && trainEnclosedAt(a);
      const inside = enclosed(travelled.current)
        || enclosed(trainWrap(travelled.current - CAMERA_REACH))
        || enclosed(trainWrap(travelled.current + CAMERA_REACH));
      t.enclosed = damp(t.enclosed, inside ? 1 : 0, ENCLOSED_HALF_LIFE, 1 / 60);
      // The rail cameras work in arc length, not in world space — see
      // `RailCamera`. This is the only channel they have to the line.
      t.railArc = travelled.current;
      t.railFacing = FACING;
      // The pointwork, for the HUD and the cameras. `railPoints` is -1 rather
      // than Infinity so the HUD can test it with one comparison.
      // From the leading end, for the same reason the points are worked from
      // it: propelling, the distance to the blades is a train length shorter
      // than the locomotive's own, and a countdown that ran out 30 m after the
      // train had already taken the points is worse than no countdown.
      // In the LINE's frame, like everything the pointwork is asked: which end
      // of the rake gets to the blades first, and which way to look for them.
      const heading: 1 | -1 = v < -0.2 ? (-FACING as 1 | -1) : FACING;
      rake.arc = travelled.current;
      const lead = leadEnd(rake, heading);
      const road = roadAt(livePoints, lead);
      const next = pointsAhead(road, lead, heading);
      t.railRoad = road;
      t.railPoints = next ? next.distance : -1;
      t.railNextRoad = next ? next.other : -1;
      t.railNextKph = next && Number.isFinite(roadOf(next.other).limit)
        ? Math.round(roadOf(next.other).limit * 3.6) : 0;
      // The line ahead, out of the same lookahead the overspeed guard uses.
      //
      // Capped at what the train can do: `trainSpeedLimitAt` returns
      // `UNRESTRICTED` — 200 m/s — wherever the line is straight, and a readout
      // saying 720 KM/H is not a readout. What the driver wants to know is what
      // is permitted, which on a clear stretch is simply line speed.
      const lineLimit = Math.min(topSpeed(), railLimitAt(livePoints, head));
      t.railLineKph = Math.round(lineLimit * 3.6);
      // The lowest restriction ahead, and how far off it is. Reported whether or
      // not it currently binds — the strip decides when it is worth saying,
      // which is not the physics' business.
      //
      // Scanned **twice** as far as the guard looks, plus a floor. The guard's
      // reach is exactly the distance the brake needs, so a restriction only
      // enters its view at the moment it has to be acted on — which would make
      // the strip flick straight to red with no warning first. Twice that gives
      // the driver an amber phase to shut off in, and the floor keeps a
      // restriction visible when the train is slow enough that braking distance
      // is nearly nothing.
      const reach = Math.max(400, ((v * v) / (2 * BRAKE) + LOOKAHEAD_MARGIN) * 2);
      let worst = lineLimit;
      let worstAt = -1;
      for (let d = LOOKAHEAD_STEP; d <= reach; d += LOOKAHEAD_STEP) {
        const at = Math.min(topSpeed(), railLimitAt(livePoints, trainWrap(head + way * d)));
        if (at < worst - 0.3) { worst = at; worstAt = d; }
      }
      t.railRestrictKph = worstAt < 0 ? -1 : Math.round(worst * 3.6);
      t.railRestrictM = worstAt;
      // The next train on this road, walked the way we are going. `track` is
      // -1 in a loop, where nothing on the running line can be in the way.
      let aheadM = -1;
      if (track === 0 || track === 1) {
        for (const other of trainsOnTrack(track)) {
          if (other === undefined) continue;
          const gap = ahead(head, other.arc) * way;
          if (gap <= 0.5) continue;
          if (aheadM < 0 || gap < aheadM) aheadM = gap;
        }
      }
      t.railAheadM = aheadM;
      t.railHand = next ? next.hand : 0;
      t.railForced = next ? next.compulsory : false;
      t.railArmed = livePoints.armed;
      t.railLocked = locked.current > 0;
      t.railLateral = lateralAt(livePoints, travelled.current);
      t.x = cab.x;
      t.y = cab.y;
      t.z = cab.z;
      t.heading = cab.yaw;
    }
  });

  return (
    <>
      {/* Camera/minimap anchor. Kept outside the carrier so it is not dragged
          around by the normalising transform the model holds. */}
      <group ref={chassisRef} />

      {models.map((model, i) => (
        <group key={i} ref={(group) => { carriers.current[i] = group; }}>
          <primitive object={model} />
          <ShadowProxy size={formation[i].model === 'loco'
            ? [LOCOMOTIVE.size[0], LOCOMOTIVE.bodyHeight, LOCOMOTIVE.size[2]]
            : [CARRIAGE.size[0], CARRIAGE.bodyHeight, CARRIAGE.size[2]]} />
          {formation[i].model === 'loco' && (
            <Headlamps dark={darkness} speed={speed} tail={i === models.length - 1} length={LOCOMOTIVE.size[2]} />
          )}
        </group>
      ))}

      {/* Kinematic, declarative for the same reason Traffic's colliders are:
          creating bodies imperatively from an effect calls into Rapier while
          the World is already borrowed and aborts the step. The consequence of
          kinematic is that the player's locomotive is immovable, which is
          correct — a car that hits it comes off worse. */}
      {formation.map((unit, i) => {
        const box = unit.model === 'loco'
          ? [LOCOMOTIVE.size[0], LOCOMOTIVE.bodyHeight, LOCOMOTIVE.size[2]] as const
          : [CARRIAGE.size[0], CARRIAGE.bodyHeight, CARRIAGE.size[2]] as const;
        return (
          <RigidBody
            key={i}
            ref={(body) => { bodies.current[i] = body; }}
            type="kinematicPosition"
            colliders="cuboid"
            position={[0, -500, 0]}
          >
            <mesh visible={false}>
              <boxGeometry args={[box[0], box[1], box[2]]} />
            </mesh>
          </RigidBody>
        );
      })}
    </>
  );
}
