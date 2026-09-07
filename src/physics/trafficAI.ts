/**
 * NPC traffic.
 *
 * The cars are *scripted*, not simulated: each one is a position, a heading and
 * a speed, integrated by hand. They are not Rapier vehicles. Twenty raycast
 * vehicle controllers would cost more than the player's car and buy nothing —
 * nobody watches an NPC's suspension — and a scripted car can be made to stay in
 * its lane, which a simulated one cannot without a full driver model.
 *
 * Steering has no route graph behind it. Instead each car reads the same road
 * raster the minimap draws (`cityNav.ts`), the way a line-following robot reads
 * a track: probe a fan of candidate headings, keep the one with the most tarmac
 * ahead, then trim sideways to sit a lane's width from the right-hand kerb. That
 * gets junction turns, bends and roundabouts for free, because they are all just
 * "where the tarmac goes", and it degrades into a straight line rather than a
 * crash when the raster is missing.
 */
import { TRAFFIC } from '@/config/trafficConfig';
import { getNav, groundHeightAt, isRoadAt, nearestRoad } from './cityNav';

export interface Npc {
  /** Slot is live. Inactive slots keep their `type` — see the pool note below. */
  active: boolean;
  /** Index into the vehicle catalogue. Fixed for the life of the slot. */
  type: number;
  x: number;
  y: number;
  z: number;
  /** Forward is (-sin h, -cos h), matching the player's convention. */
  heading: number;
  /** m/s. */
  speed: number;
  /** m/s the car is trying to reach. */
  cruise: number;
  /** Current yaw rate, rad/s. Carried between steps so steering has inertia. */
  yawRate: number;
  /** Metres travelled, for wheel spin. */
  odometer: number;
  /** Seconds spent off the tarmac. Recycled once this passes `offRoadGrace`. */
  offRoad: number;
  /** Seconds spent stationary with a clear road ahead, i.e. wedged on geometry. */
  stuck: number;
  /**
   * Seconds since this car was hit hard enough to be handed to the physics
   * engine, or 0 while it is driving normally. A wrecked car is not steered:
   * Rapier owns its position, and `Traffic` reads the body back into `x`/`y`/
   * `z`/`heading` so the drawn car follows the one that is being thrown around.
   */
  wreck: number;
}

/**
 * Slots are allocated per vehicle type and never change type.
 *
 * Each NPC owns a Rapier collider sized to its body, and resizing a collider
 * means tearing it down and rebuilding it. Pinning the type to the slot means a
 * respawn only moves a car, so the collider set is built once.
 */
export function createTraffic(typeCount: number): Npc[] {
  const npcs: Npc[] = [];
  for (let i = 0; i < TRAFFIC.perType; i++)
    for (let type = 0; type < typeCount; type++)
      npcs.push({
        active: false, type, x: 0, y: 0, z: 0, heading: 0,
        speed: 0, cruise: 0, yawRate: 0, odometer: 0, offRoad: 0, stuck: 0,
        wreck: 0,
      });
  return npcs;
}

const TAU = Math.PI * 2;
/** Shortest signed angle from `a` to `b`. */
const angleDelta = (a: number, b: number) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/** How far the road continues along `heading`, up to `max` metres. */
function roadReach(x: number, z: number, heading: number, max: number): number {
  const dx = -Math.sin(heading);
  const dz = -Math.cos(heading);
  let d = TRAFFIC.probeStep;
  for (; d <= max; d += TRAFFIC.probeStep) {
    if (!isRoadAt(x + dx * d, z + dz * d)) return d - TRAFFIC.probeStep;
  }
  return max;
}

/** Distance to the kerb on one side (+1 right, -1 left), up to `max`. */
function kerbDistance(x: number, z: number, heading: number, side: number, max: number): number {
  // Right of forward (-sin h, -cos h) is (-cos h, sin h).
  const dx = -Math.cos(heading) * side;
  const dz = Math.sin(heading) * side;
  // The first sample is also the smallest distance this can ever report, so it
  // bounds any threshold compared against the result — see `kerbPanic`.
  for (let d = TRAFFIC.kerbStep; d <= max; d += TRAFFIC.kerbStep) {
    if (!isRoadAt(x + dx * d, z + dz * d)) return d;
  }
  return max;
}

/**
 * Steer, accelerate and move one car.
 *
 * `blocked` is the distance to the nearest thing in front (another NPC or the
 * player), or Infinity. It is computed by the caller because it needs the whole
 * set, and doing it here would make this O(n²) per car rather than per frame.
 */
function driveOne(npc: Npc, dt: number, blocked: number) {
  const { probeMax, fan, laneOffset, accel, brake } = TRAFFIC;

  // --- am I still on the road? ---------------------------------------------
  //
  // This has to be asked first, and answered separately, because the steering
  // below is *only* meaningful on tarmac. Off the raster every probe reads zero,
  // so every heading scores the same and straight-on wins by default: a car that
  // strays does not wander back, it drives in a straight line for ever, through
  // buildings and off the map. It also stops receiving a ground height, so it
  // keeps whatever y it had and appears to fly.
  const ground = groundHeightAt(npc.x, npc.z);
  const onRoad = isRoadAt(npc.x, npc.z) && ground !== null;
  npc.offRoad = onRoad ? 0 : npc.offRoad + dt;
  if (npc.offRoad > TRAFFIC.offRoadGrace) {
    // Recycled rather than nudged: a car this lost is usually inside something.
    npc.active = false;
    return;
  }

  let bestHeading = npc.heading;
  let straightReach = 0;
  let target: number;

  if (!onRoad) {
    // --- recovery: head for the nearest tarmac, slowly ---------------------
    const fix = nearestRoad(npc.x, npc.z, npc.heading, TRAFFIC.recoverSearch);
    if (!fix) { npc.active = false; return; }
    // Bearing to the fix, in the same convention as `heading`.
    bestHeading = Math.atan2(-(fix.position[0] - npc.x), -(fix.position[2] - npc.z));
    target = TRAFFIC.recoverSpeed;
  } else {
    // --- pick a heading: the most open direction, biased toward straight on -
    let bestScore = -Infinity;
    for (const offset of fan) {
      const h = npc.heading + offset;
      const reach = roadReach(npc.x, npc.z, h, probeMax);
      if (offset === 0) straightReach = reach;
      // Turning is penalised so a car does not weave across a wide junction
      // just because the diagonal happens to be a metre longer. The penalty is
      // route choice only — it must stay small enough that a real junction turn
      // can still win, or cars refuse to corner and leave the road.
      const score = reach - Math.abs(offset) * TRAFFIC.turnPenalty;
      if (score > bestScore) { bestScore = score; bestHeading = h; }
    }

    // --- keep right ---
    //
    // Only when BOTH kerbs are within reach, i.e. the car is actually in a
    // street. Correcting on one kerb alone is what made traffic swerve: in a
    // junction or a car park the off side returns the probe limit, the error
    // reads as several metres, and the car cranks in a full correction every
    // single step.
    const maxKerb = laneOffset * 3;
    const right = kerbDistance(npc.x, npc.z, bestHeading, 1, maxKerb);
    const left = kerbDistance(npc.x, npc.z, bestHeading, -1, maxKerb);
    if (right < maxKerb && left < maxKerb) {
      // Aim for the middle of our own half, not a fixed distance from the kerb:
      // on a narrow street a fixed offset puts both directions of travel in the
      // same strip of tarmac.
      const aim = Math.max(TRAFFIC.laneOffsetMin,
        Math.min(laneOffset, (right + left) * TRAFFIC.laneFraction));
      const error = right - aim;
      // A deadband keeps the raster's 3 m per pixel from being chased: without
      // it the measurement jitters by a whole pixel and the car hunts.
      if (Math.abs(error) > TRAFFIC.laneDeadband) {
        bestHeading += Math.max(-TRAFFIC.laneClamp, Math.min(TRAFFIC.laneClamp,
          error * TRAFFIC.laneGain));
      }
    }

    // Kerb emergency, checked whatever the lane logic decided (including in
    // junctions, where it declines to act at all). Steering away is the only
    // real way to stay on the road; refusing to move is a stall.
    if (right < TRAFFIC.kerbPanic && left > right) bestHeading -= TRAFFIC.kerbPanicTurn;
    else if (left < TRAFFIC.kerbPanic && right > left) bestHeading += TRAFFIC.kerbPanicTurn;

    // --- speed ---
    //
    // Two physical limits, both of which a driver actually obeys, and the lack
    // of the first is why cars used to plough straight on at junctions:
    //
    //   corner  The yaw needed to follow the chosen heading costs v * yaw of
    //           lateral acceleration. If that exceeds the budget the car cannot
    //           make the turn at this speed, so it must slow until it can —
    //           rather than understeer off the road, which is what it did.
    //   sight   Never travel faster than you can stop in the road you can see.
    target = npc.cruise;

    const needYaw = Math.abs(angleDelta(npc.heading, bestHeading)) / TRAFFIC.steerResponse;
    if (needYaw > 1e-3) {
      target = Math.min(target,
        Math.max(TRAFFIC.turnSpeedMin, TRAFFIC.lateralAccel / needYaw));
    }
    target = Math.min(target, Math.max(TRAFFIC.turnSpeedMin,
      Math.sqrt(2 * brake * Math.max(0, straightReach - TRAFFIC.sightMargin))));
  }

  // --- rotate toward it, with inertia ---
  //
  // Yaw is a damped rate rather than a hard snap. Every input above is quantised
  // (reach to the probe step, kerbs to half a metre, both on a 3 m raster), so
  // steering straight at the target reproduces that noise as visible wiggle.
  // The rate is also capped by a lateral-acceleration budget, so a car doing
  // 12 m/s cannot pivot like one doing 3 — a constant cap is why they twitched
  // most at speed. The corner-speed limit above is the other half of this: the
  // cap is only survivable because the car slows down to earn the turn.
  const maxYaw = Math.min(TRAFFIC.turnRate, TRAFFIC.lateralAccel / Math.max(npc.speed, 2));
  const delta = angleDelta(npc.heading, bestHeading);
  const desired = Math.max(-maxYaw, Math.min(maxYaw, delta / TRAFFIC.steerResponse));
  npc.yawRate = desired + (npc.yawRate - desired) * Math.pow(2, -dt / TRAFFIC.steerSmoothing);
  npc.heading += npc.yawRate * dt;

  // Hold back for whatever is in the lane ahead, player included.
  if (blocked < TRAFFIC.followDistance) {
    target = Math.min(target, npc.cruise * Math.max(0, (blocked - TRAFFIC.stopDistance) /
      (TRAFFIC.followDistance - TRAFFIC.stopDistance)));
  }
  npc.speed += Math.max(-brake * dt, Math.min(accel * dt, target - npc.speed));
  if (npc.speed < 0) npc.speed = 0;

  // --- integrate ---
  //
  // Refuse the step if it would put the car somewhere it cannot be. Steering is
  // a preference; this is the guarantee, and without it a car that clips a kerb
  // mid-turn is gone for good.
  const step = npc.speed * dt;
  const nx = npc.x + -Math.sin(npc.heading) * step;
  const nz = npc.z + -Math.cos(npc.heading) * step;
  const nextGround = groundHeightAt(nx, nz);

  if (onRoad && (nextGround === null || !isRoadAt(nx, nz))) {
    // About to leave the tarmac: stop at the kerb and turn on the spot instead.
    npc.speed = 0;
  } else if (onRoad && nextGround !== null && nextGround - npc.y > TRAFFIC.maxClimb) {
    // A step up this large is a wall or a raised deck, not a slope. Climbing it
    // is what let cars end up on top of things and drop off them.
    npc.speed = 0;
  } else {
    npc.x = nx;
    npc.z = nz;
    npc.odometer += step;
  }

  // Wedged on geometry, as opposed to queuing: nothing ahead, yet not moving.
  npc.stuck = (npc.speed < 0.5 && blocked === Infinity) ? npc.stuck + dt : 0;
  if (npc.stuck > TRAFFIC.stuckGrace) { npc.active = false; return; }

  const settle = groundHeightAt(npc.x, npc.z);
  if (settle !== null) {
    // Ease onto the sampled height; the raster is 3 m per pixel, so stepping
    // straight to it makes cars twitch vertically on slopes.
    npc.y += (settle - npc.y) * Math.min(1, dt * 6);
  }
}

/** Deterministic PRNG, so traffic is identical run to run. */
let seed = 0x2545f491;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** Put an inactive car on a road near the player, facing along it. */
function spawn(npc: Npc, px: number, pz: number, others: Npc[]): boolean {
  const { spawnMin, spawnMax } = TRAFFIC;
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = random() * TAU;
    const dist = spawnMin + random() * (spawnMax - spawnMin);
    const x = px + Math.cos(angle) * dist;
    const z = pz + Math.sin(angle) * dist;

    const fix = nearestRoad(x, z, random() * TAU, 40);
    if (!fix) continue;

    // Never spawn on top of another car.
    let clear = true;
    for (const o of others) {
      if (!o.active) continue;
      if (Math.hypot(o.x - fix.position[0], o.z - fix.position[2]) < TRAFFIC.spawnClearance) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;

    npc.x = fix.position[0];
    npc.z = fix.position[2];
    npc.y = fix.position[1] - 0.6; // nearestRoad lifts for the player's chassis
    npc.heading = fix.heading;
    npc.speed = 0;
    npc.yawRate = 0;
    npc.cruise = TRAFFIC.cruiseMin + random() * (TRAFFIC.cruiseMax - TRAFFIC.cruiseMin);
    npc.odometer = random() * 100;
    npc.offRoad = 0;
    npc.stuck = 0;
    npc.wreck = 0;
    npc.active = true;
    return true;
  }
  return false;
}

/**
 * Advance the whole traffic set one frame.
 *
 * `px`/`pz` is the player, who is both the centre of the spawn ring and an
 * obstacle: NPCs brake for the player's car as they would for each other.
 */
/**
 * Cars beyond the density cap are only retired once they are this far away, so
 * turning traffic down never makes a car vanish in front of the player. The
 * count settles over the next few seconds instead of popping.
 */
const POLITE_RETIRE = 60;

/**
 * `limit` caps how many cars may be live at once — the traffic density setting.
 *
 * A cap rather than a smaller pool: the pool is a fixed set of Rapier bodies
 * mounted by `Traffic`, and rebuilding it to change density would mean adding
 * and removing rigid bodies at runtime. Capping how many are *active* changes
 * the density on the next frame and never touches the physics world.
 */
export function updateTraffic(
  npcs: Npc[], dt: number, px: number, pz: number, playerX: number, playerZ: number,
  limit: number = npcs.length,
) {
  if (!getNav()) return; // raster still loading; traffic simply has not started

  const { despawn } = TRAFFIC;
  let live = 0;

  for (const npc of npcs) {
    if (!npc.active) continue;
    if (Math.hypot(npc.x - px, npc.z - pz) > despawn) {
      npc.active = false;
      // Clear the wreck flag with the slot, so the body is handed back to
      // kinematic control before it is reused rather than being respawned
      // still carrying the momentum of whatever hit it.
      npc.wreck = 0;
      continue;
    }

    if (npc.wreck > 0) {
      // A wreck is Rapier's to move, and it is left exactly where it came to
      // rest. It is recycled by the distance test above like any other car —
      // an earlier version retired it a couple of seconds after it stopped
      // moving, which made cars pop out of existence in front of the player
      // moments after being hit.
      npc.wreck += dt;
      live++;
      continue;
    }
    live++;
  }

  // Over the cap: retire the excess, furthest first, and only out of sight.
  if (live > limit) {
    let excess = live - limit;
    for (const npc of npcs) {
      if (excess <= 0) break;
      if (!npc.active) continue;
      if (Math.hypot(npc.x - px, npc.z - pz) < POLITE_RETIRE) continue;
      npc.active = false;
      npc.wreck = 0;
      live--;
      excess--;
    }
  }

  // Top up, a few per frame, so a long drive does not stall on one big refill.
  let budget = TRAFFIC.spawnsPerFrame;
  if (live < limit) {
    for (const npc of npcs) {
      if (budget <= 0) break;
      if (npc.active) continue;
      if (spawn(npc, px, pz, npcs)) budget--;
    }
  }

  for (const npc of npcs) {
    if (!npc.active || npc.wreck > 0) continue;

    // Nearest obstacle in this car's forward cone.
    const fx = -Math.sin(npc.heading);
    const fz = -Math.cos(npc.heading);
    let blocked = Infinity;
    const consider = (ox: number, oz: number) => {
      const dx = ox - npc.x;
      const dz = oz - npc.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > TRAFFIC.followDistance) return;
      // Reject anything not roughly in our lane.
      const lateral = Math.abs(dx * -fz + dz * fx);
      if (lateral > TRAFFIC.laneHalfWidth) return;
      if (ahead < blocked) blocked = ahead;
    };
    for (const o of npcs) {
      if (o === npc || !o.active) continue;
      // Queue behind traffic going our way; do not brake for oncoming traffic.
      // A car we are closing on head-on is one we pass, and treating it as an
      // obstacle deadlocks both of them: each stops for the other and neither
      // ever moves again. Spawn headings are random along the street, so half of
      // all encounters are head-on.
      //
      // A wreck is the exception. Its heading is whatever angle it landed at, so
      // half of all wrecks read as "oncoming" and were driven straight through —
      // and a driven car is teleported into place every step, so it ploughed
      // into the wreck with what the solver saw as infinite momentum and threw
      // it across the street. A wreck is never something to pass through.
      if (o.wreck === 0 && Math.cos(o.heading - npc.heading) <= 0) continue;
      consider(o.x, o.z);
    }
    // The player is a hazard whichever way he is pointing.
    consider(playerX, playerZ);

    driveOne(npc, dt, blocked);
  }
}
