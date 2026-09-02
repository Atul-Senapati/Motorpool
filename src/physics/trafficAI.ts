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
      npcs.push({ active: false, type, x: 0, y: 0, z: 0, heading: 0, speed: 0, cruise: 0, yawRate: 0, odometer: 0 });
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
  for (let d = 0.5; d <= max; d += 0.5) {
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

  // --- pick a heading: the most open direction, biased toward straight on ---
  let bestHeading = npc.heading;
  let bestScore = -Infinity;
  let straightReach = 0;
  for (const offset of fan) {
    const h = npc.heading + offset;
    const reach = roadReach(npc.x, npc.z, h, probeMax);
    if (offset === 0) straightReach = reach;
    // Turning is penalised so a car does not weave across a wide junction just
    // because the diagonal happens to be a metre longer. The penalty must also
    // exceed one probe step, or quantisation alone flips the choice every frame.
    const score = reach - Math.abs(offset) * TRAFFIC.turnPenalty;
    if (score > bestScore) { bestScore = score; bestHeading = h; }
  }

  // --- keep right ---
  //
  // Only when BOTH kerbs are within reach, i.e. the car is actually in a street.
  // Correcting on one kerb alone is what made traffic swerve: in a junction or a
  // car park the off side returns the probe limit, the error reads as several
  // metres, and the car cranks in a full correction every single step.
  const maxKerb = laneOffset * 3;
  const right = kerbDistance(npc.x, npc.z, bestHeading, 1, maxKerb);
  const left = kerbDistance(npc.x, npc.z, bestHeading, -1, maxKerb);
  if (right < maxKerb && left < maxKerb) {
    const error = right - laneOffset;
    // A deadband keeps the raster's 3 m per pixel from being chased: without it
    // the measurement jitters by a whole pixel and the car hunts around it.
    if (Math.abs(error) > TRAFFIC.laneDeadband) {
      const trimmed = Math.max(-2, Math.min(2, error));
      bestHeading += Math.max(-TRAFFIC.laneClamp, Math.min(TRAFFIC.laneClamp,
        trimmed * TRAFFIC.laneGain));
    }
  }

  // --- rotate toward it, with inertia ---
  //
  // Yaw is a damped rate rather than a hard snap. Every input above is quantised
  // (reach to the probe step, kerbs to half a metre, both on a 3 m raster), so
  // steering straight at the target reproduces that noise as visible wiggle.
  // The rate is also capped by a lateral-acceleration budget, so a car doing
  // 12 m/s cannot pivot like one doing 3 — a constant cap is why they twitched
  // most at speed.
  const maxYaw = Math.min(TRAFFIC.turnRate, TRAFFIC.lateralAccel / Math.max(npc.speed, 2));
  const delta = angleDelta(npc.heading, bestHeading);
  const desired = Math.max(-maxYaw, Math.min(maxYaw, delta / TRAFFIC.steerResponse));
  npc.yawRate = desired + (npc.yawRate - desired) * Math.pow(2, -dt / TRAFFIC.steerSmoothing);
  npc.heading += npc.yawRate * dt;

  // --- speed ---
  // Slow for what is ahead: a short probe means a bend or a dead end, and
  // `blocked` is the car in front.
  const corner = Math.min(1, straightReach / probeMax);
  let target = npc.cruise * (0.35 + 0.65 * corner);
  if (blocked < TRAFFIC.followDistance) {
    target = Math.min(target, npc.cruise * Math.max(0, (blocked - TRAFFIC.stopDistance) /
      (TRAFFIC.followDistance - TRAFFIC.stopDistance)));
  }
  npc.speed += Math.max(-brake * dt, Math.min(accel * dt, target - npc.speed));
  if (npc.speed < 0) npc.speed = 0;

  // --- integrate ---
  const step = npc.speed * dt;
  npc.x += -Math.sin(npc.heading) * step;
  npc.z += -Math.cos(npc.heading) * step;
  npc.odometer += step;

  const ground = groundHeightAt(npc.x, npc.z);
  if (ground !== null) {
    // Ease onto the sampled height; the raster is 3 m per pixel, so stepping
    // straight to it makes cars twitch vertically on slopes.
    npc.y += (ground - npc.y) * Math.min(1, dt * 6);
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
export function updateTraffic(
  npcs: Npc[], dt: number, px: number, pz: number, playerX: number, playerZ: number,
) {
  if (!getNav()) return; // raster still loading; traffic simply has not started

  const { despawn } = TRAFFIC;
  let live = 0;

  for (const npc of npcs) {
    if (!npc.active) continue;
    if (Math.hypot(npc.x - px, npc.z - pz) > despawn) { npc.active = false; continue; }
    live++;
  }

  // Top up, a few per frame, so a long drive does not stall on one big refill.
  let budget = TRAFFIC.spawnsPerFrame;
  if (live < npcs.length) {
    for (const npc of npcs) {
      if (budget <= 0) break;
      if (npc.active) continue;
      if (spawn(npc, px, pz, npcs)) budget--;
    }
  }

  for (const npc of npcs) {
    if (!npc.active) continue;

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
      consider(o.x, o.z);
    }
    consider(playerX, playerZ);

    driveOne(npc, dt, blocked);
  }
}
