/**
 * NPC traffic.
 *
 * The cars are *scripted*, not simulated: each one is a lane, a distance along
 * it and a speed, integrated by hand. They are not Rapier vehicles. Twenty
 * raycast vehicle controllers would cost more than the player's car and buy
 * nothing — nobody watches an NPC's suspension — and a scripted car can be
 * made to keep its lane, which a simulated one cannot without a driver model.
 *
 * ## Lanes, not probes
 *
 * The first version of this read the nav raster directly, the way a
 * line-following robot reads a track: probe a fan of headings, keep the one
 * with the most tarmac, trim sideways off the kerb. Every input it had was
 * quantised to a 1.5 m pixel, so every correction was a visible wiggle, and a
 * car in a wide junction had no idea which of four exits was "straight on".
 * Half its constants were filters for the noise it made itself.
 *
 * Now a car is a point on a lane of the road graph (`roadGraph.ts`). Its
 * position is `s`, metres along the lane; its heading is the lane's; it is a
 * lane's width from the centreline because the lane is. The questions a
 * driver asks are all arithmetic on `s`:
 *
 *   who is in front     the next car on the same lane, or the first on the
 *                       lane I am about to join — distance, not a cone test
 *   how fast can I go   the road's own cap, the bend ahead's radius, and the
 *                       turn at the next junction
 *   who goes first      at a node: anyone already in the box, then anyone
 *                       arriving from the priority side about the same time
 *
 * Spawning is onto a lane, so a car is never born anywhere but a road, facing
 * the way the road goes.
 *
 * ## What still comes from elsewhere
 *
 * The player is not on the graph, so they are projected onto the nearest lane
 * each step and treated as a car there — traffic queues behind them and stops
 * for them across a junction. A wreck is wherever Rapier left it, and is
 * avoided by a plain forward-cone check. Ground height is read from the nav
 * raster, as before; the graph is flat.
 */
import { RACE, TRAFFIC } from '@/config/trafficConfig';
import { groundHeightAt } from './cityNav';
import { isCrossingClear } from './townNav';
import { STREET_WALKERS } from './kestrelStreet';
import {
  arriveHeading, dirFrom, edgesNear, exitHeading, getRoadGraph, laneAt, laneEnd, nearestLane,
  wrapAngle, type LanePose, type RoadGraph,
} from './roadGraph';

export interface Npc {
  /** Slot index. Breaks ties when two cars each think the other is in front. */
  id: number;
  /** Slot is live. Inactive slots keep their `type` — see the pool note below. */
  active: boolean;
  /** Index into the vehicle catalogue. Fixed for the life of the slot. */
  type: number;
  /** Body length, for headway. Fixed with the type. */
  length: number;
  /**
   * Which roads this type is driven on, as `REGION` bits: the town's,
   * Skylark's country lanes, Halcyon's — or several. Fixed with the type.
   * See `RoadEdge.region`.
   */
  regions: number;
  /** The fastest this type goes, m/s, whatever the road allows — a tractor's 25 km/h. */
  top: number;
  /**
   * A racer on Petrel (`RACE`): race car grip, power and brakes, a long
   * reach, and its own line across the track (`line`, metres right of the
   * centre) — which is also why racers never queue behind one another: on
   * different lines they pass instead.
   */
  race: boolean;
  line: number;
  x: number;
  y: number;
  z: number;
  /** Forward is (-sin h, -cos h), matching the player's convention. */
  heading: number;
  /** m/s. */
  speed: number;
  /** m/s the car would like to do on an open road. */
  cruise: number;
  /** Current yaw rate, rad/s — for the physics body's angular velocity. */
  yawRate: number;
  /**
   * Nose-up pitch, radians: the slope of the road between the axles. Without
   * it a car climbing the viaduct's hump stood level and buried its bonnet in
   * the rising deck.
   */
  pitch: number;
  /** Metres travelled, for wheel spin. */
  odometer: number;
  /** Seconds spent stationary with a clear road ahead, i.e. wedged on geometry. */
  stuck: number;
  /**
   * Asking to slow down — the brake lights, as a fact about the driving.
   * `Traffic` ramps this into a lamp brightness; the AI only says whether the
   * driver's foot is on the pedal.
   */
  slowing: boolean;
  /**
   * Seconds since this car was hit hard enough to be handed to the physics
   * engine, or 0 while it is driving normally. A wrecked car is not steered:
   * Rapier owns its position, and `Traffic` reads the body back into `x`/`y`/
   * `z`/`heading` so the drawn car follows the one that is being thrown around.
   */
  wreck: number;

  /* ---- where it is on the graph ---- */
  edge: number;
  dir: 1 | -1;
  /** Metres along the lane in the direction of travel. */
  s: number;
  /** The exit already chosen for the node ahead, or -1 for a dead end. */
  next: number;
  /** Seconds waiting at a junction, for the patience rule. */
  wait: number;
  /**
   * Carry-over from the previous lane, blended out over `TRAFFIC.blend`.
   * Lanes on different streets meet at different points around a node, and
   * this is what carries the car across the difference instead of jumping it.
   */
  blendX: number;
  blendZ: number;
  blendH: number;
}

/**
 * Slots are allocated per vehicle type and never change type.
 *
 * Each NPC owns a Rapier collider sized to its body, and resizing a collider
 * means tearing it down and rebuilding it. Pinning the type to the slot means a
 * respawn only moves a car, so the collider set is built once.
 */
/** A road's region as a bit, so a type can be allowed on several. */
export const REGION = { town: 1, country: 2, halcyon: 4, circuit: 8, paddock: 16, farm: 32 } as const;
export const ANY_REGION = REGION.town | REGION.country | REGION.halcyon;
/**
 * Regions nothing enters without being of them: the circuit is the racers'
 * and the paddock nobody's. The others are open — a town car may follow a
 * road out onto Skylark, as it always could.
 */
const CLOSED = REGION.circuit | REGION.paddock;
/**
 * Regions only their own types enter, but which those types may leave: the
 * farm roads, Skylark's single-tracks, are the tractors' and combines' —
 * which drive the country lanes too — and no pickup or lorry turns down one.
 */
const PRIVATE = REGION.farm;

/** Per type: where it drives (`REGION` bits) and how fast it can, and whether it races. Town, unlimited, when not given. */
export interface TrafficKind { regions: number; top?: number; race?: boolean }

export function createTraffic(
  lengths: readonly number[], counts?: readonly number[], kinds?: readonly TrafficKind[],
): Npc[] {
  const npcs: Npc[] = [];
  // Round-robin over the types, so the first slots tried are a mix rather
  // than every car of type 0 first. `counts` gives a type fewer (or more)
  // slots than `TRAFFIC.perType` — the bikers have one each.
  const most = Math.max(TRAFFIC.perType, ...(counts ?? []));
  let racers = 0;
  for (let i = 0; i < most; i++)
    for (let type = 0; type < lengths.length; type++) {
      if (i >= (counts?.[type] ?? TRAFFIC.perType)) continue;
      npcs.push({
        id: npcs.length, active: false, type, length: lengths[type],
        regions: kinds?.[type]?.regions ?? REGION.town, top: kinds?.[type]?.top ?? Infinity,
        race: !!kinds?.[type]?.race,
        line: kinds?.[type]?.race ? RACE.lines[racers++ % RACE.lines.length] : 0,
        x: 0, y: 0, z: 0, heading: 0,
        speed: 0, cruise: 0, yawRate: 0, pitch: 0, odometer: 0, stuck: 0, slowing: false, wreck: 0,
        edge: 0, dir: 1, s: 0, next: -1, wait: 0, blendX: 0, blendZ: 0, blendH: 0,
      });
    }
  return npcs;
}

/** Deterministic PRNG, so traffic is identical run to run. */
let seed = 0x2545f491;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

const pose: LanePose = { x: 0, z: 0, heading: 0 };
const pose2: LanePose = { x: 0, z: 0, heading: 0 };

/* ------------------------------------------------------------ routing */

/**
 * Choose where to go at the node a lane arrives at.
 *
 * Straight on is preferred, so a car on a through street mostly stays on it
 * and the traffic reads as flow rather than as a random walk; but every exit
 * has a chance, so every street gets used. Never straight back the way it
 * came unless that is all there is.
 */
function chooseExit(g: RoadGraph, edge: number, dir: 1 | -1, regions: number): number {
  const node = laneEnd(g, edge, dir);
  const here = arriveHeading(g, edge, dir);
  const options = g.nodes[node].edges;
  let total = 0;
  const weights: number[] = [];
  for (const candidate of options) {
    if (candidate === edge) { weights.push(0); continue; }
    // A one-way edge is only an exit in its own direction.
    const ce = g.edges[candidate];
    if (ce.oneWay && dirFrom(g, candidate, node) !== ce.oneWay) { weights.push(0); continue; }
    // Nor into a closed region this type is not of: town cars stay off the
    // circuit, and the racers stay on it.
    const r = REGION[ce.region];
    if ((r & CLOSED) && !(regions & r)) { weights.push(0); continue; }
    if ((regions & CLOSED) && !(regions & r)) { weights.push(0); continue; }
    if ((r & PRIVATE) && !(regions & r)) { weights.push(0); continue; }
    const turn = Math.abs(wrapAngle(exitHeading(g, candidate, node) - here));
    // A gated edge (the level crossing) is a legitimate route; the AI waits at
    // it when the barriers are down rather than avoiding it.
    // Never a U-turn at a junction: an exit pointing back the way the car
    // came is a parallel road out of a knot, and taking it swings the car
    // through 180 degrees in a car's length.
    const w = turn < Math.PI / 6 ? TRAFFIC.straightBias : turn < Math.PI * 0.6 ? 1 : turn < Math.PI * 0.75 ? 0.15 : 0;
    weights.push(w);
    total += w;
  }
  if (total <= 0) return -1;
  let pick = random() * total;
  for (let i = 0; i < options.length; i++) {
    pick -= weights[i];
    if (pick <= 0 && weights[i] > 0) return options[i];
  }
  return options.find((e, i) => weights[i] > 0) ?? -1;
}

/** Turn angle from the end of one lane onto the start of the next. */
function turnAngle(g: RoadGraph, edge: number, dir: 1 | -1, next: number): number {
  const node = laneEnd(g, edge, dir);
  return Math.abs(wrapAngle(exitHeading(g, next, node) - arriveHeading(g, edge, dir)));
}

/** Speed a turn of this sharpness is taken at. */
function turnSpeedFor(turn: number): number {
  if (turn < Math.PI / 8) return Infinity;
  if (turn < Math.PI / 4) return TRAFFIC.turnSpeed.gentle;
  if (turn < Math.PI * 0.65) return TRAFFIC.turnSpeed.normal;
  return TRAFFIC.turnSpeed.sharp;
}

/* ----------------------------------------------------------- spawning */

const nearEdges: number[] = [];

/** Put an inactive car on a lane near the player, facing along it. */
function spawn(g: RoadGraph, npc: Npc, px: number, pz: number, lanes: Map<number, Npc[]>): boolean {
  const { spawnMin } = TRAFFIC;
  const spawnMax = npc.race ? RACE.range : TRAFFIC.spawnMax;
  edgesNear(g, px, pz, spawnMax, nearEdges);
  if (!nearEdges.length) return false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const edge = nearEdges[Math.floor(random() * nearEdges.length)];
    const e = g.edges[edge];
    if (e.length < 12 || e.gate) continue;
    // Tractors on the lanes, buses in town: a type only goes where it belongs.
    if (!(npc.regions & REGION[e.region])) continue;
    const dir: 1 | -1 = e.oneWay ? e.oneWay : random() < 0.5 ? 1 : -1;
    const s = 4 + random() * (e.length - 8);
    // A racer never starts on another racer — they do not queue, so the
    // lane check below would not keep them apart.
    if (npc.race && lanes.get(edge * 2 + (dir > 0 ? 0 : 1))?.some((o) => o.race && Math.abs(o.s - s) < 40)) continue;
    laneAt(g, edge, dir, s, pose);
    const d = Math.hypot(pose.x - px, pose.z - pz);
    if (d < spawnMin || d > spawnMax) continue;

    // Never onto another car's bumper.
    const key = edge * 2 + (dir > 0 ? 0 : 1);
    const onLane = lanes.get(key);
    let clear = true;
    if (onLane) for (const o of onLane) {
      if (Math.abs(o.s - s) < TRAFFIC.spawnClearance + (o.length + npc.length) / 2) { clear = false; break; }
    }
    if (!clear) continue;
    // Nor across a junction from one on the opposite lane's tail (wrecks etc.).
    for (const list of lanes.values()) for (const o of list) {
      if (Math.hypot(o.x - pose.x, o.z - pose.z) < 6) { clear = false; break; }
    }
    if (!clear) continue;

    npc.edge = edge;
    npc.dir = dir;
    npc.s = s;
    npc.next = chooseExit(g, edge, dir, npc.regions);
    if (npc.race) offsetLine(npc, pose);
    npc.x = pose.x;
    npc.z = pose.z;
    npc.y = e.heightAt?.(pose.x, pose.z) ?? groundHeightAt(pose.x, pose.z) ?? 0;
    npc.heading = pose.heading;
    npc.speed = 0;
    npc.yawRate = 0;
    npc.pitch = 0;
    const [lo, hi] = TRAFFIC.cruiseVary;
    npc.cruise = e.speed * (lo + random() * (hi - lo));
    npc.odometer = random() * 100;
    npc.stuck = 0;
    npc.wait = 0;
    npc.slowing = false;
    npc.wreck = 0;
    npc.blendX = npc.blendZ = npc.blendH = 0;
    npc.active = true;
    (lanes.get(key) ?? lanes.set(key, []).get(key)!).push(npc);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------ driving */

/**
 * The player, as the traffic sees them: a car on a lane. Refreshed once per
 * step; `-1` when they are off the network (in a car park, at sea, on the
 * rails).
 */
const player = { edge: -1, dir: 1 as 1 | -1, s: 0, x: 0, z: 0, heading: 0, speed: 0 };
/**
 * The player's car as a queue sees it: its 4.5 m plus room for the chase
 * camera, which rides about 6 m back. With only the car's own length a bus
 * that rolled up behind a player standing still — on a fresh spawn, say —
 * stopped 2.5 m off the bumper, and the camera sat inside it.
 */
const PLAYER_QUEUE = { length: 4.5 + 2 * 8 };

/** Distance along my lane to the car in front, and its speed. */
function carAhead(
  g: RoadGraph, npc: Npc, lanes: Map<number, Npc[]>,
): { gap: number; speed: number } {
  const e = g.edges[npc.edge];
  let gap = Infinity;
  let speed = 0;
  const consider = (ds: number, other: { length: number; speed: number; race?: boolean }) => {
    // Racers each hold their own line, so another racer is never the car in front.
    if (npc.race && other.race) return;
    const bumper = ds - (npc.length + other.length) / 2;
    if (bumper < gap) { gap = bumper; speed = other.speed; }
  };

  const mine = lanes.get(npc.edge * 2 + (npc.dir > 0 ? 0 : 1));
  if (mine) for (const o of mine) {
    if (o === npc) continue;
    const ds = o.s - npc.s;
    if (ds > 0 && ds < TRAFFIC.lookAhead) consider(ds, o);
  }
  if (player.edge === npc.edge && player.dir === npc.dir) {
    const ds = player.s - npc.s;
    if (ds > 0 && ds < TRAFFIC.lookAhead) consider(ds, { length: PLAYER_QUEUE.length, speed: player.speed });
  }

  // Past the node, onto the lane I am about to join.
  const remaining = e.length - npc.s;
  if (npc.next >= 0 && remaining < TRAFFIC.lookAhead) {
    const node = laneEnd(g, npc.edge, npc.dir);
    const nd = dirFrom(g, npc.next, node);
    const list = lanes.get(npc.next * 2 + (nd > 0 ? 0 : 1));
    if (list) for (const o of list) {
      const ds = remaining + o.s;
      if (ds < TRAFFIC.lookAhead) consider(ds, o);
    }
    if (player.edge === npc.next && player.dir === nd) {
      const ds = remaining + player.s;
      if (ds < TRAFFIC.lookAhead) consider(ds, { length: PLAYER_QUEUE.length, speed: player.speed });
    }
  }
  return { gap, speed };
}

/** Anything not on the graph in my forward cone: the player off-road, a wreck. */
function coneAhead(npc: Npc, ox: number, oz: number, olen: number): number {
  const fx = -Math.sin(npc.heading), fz = -Math.cos(npc.heading);
  const dx = ox - npc.x, dz = oz - npc.z;
  const ahead = dx * fx + dz * fz;
  if (ahead <= 0 || ahead > TRAFFIC.lookAhead) return Infinity;
  const lateral = Math.abs(dx * -fz + dz * fx);
  if (lateral > TRAFFIC.laneHalfWidth + olen * 0.25) return Infinity;
  return ahead - (npc.length + olen) / 2;
}

/**
 * Should this car hold at the stop line?
 *
 * Two rules, and both are what a driver does at an unmarked junction:
 *
 *   the box      anyone already inside the junction goes first, whatever
 *                direction they came from — you do not pull out into a car
 *   the side     anyone arriving from the priority side (the right, when
 *                driving on the right) about as soon as you are goes first
 *
 * Cars on my own edge are never a reason to wait — the one in front is
 * handled by headway, the one behind is not my problem. Neither is the car
 * that is leaving the box along the very lane I am about to take: that is
 * following, not conflict.
 */
function mustYield(g: RoadGraph, npc: Npc, lanes: Map<number, Npc[]>, remaining: number): boolean {
  if (npc.next < 0) return false;
  const node = laneEnd(g, npc.edge, npc.dir);
  const n = g.nodes[node];
  if (n.edges.length < 3) return false;
  const myArrival = remaining / Math.max(npc.speed, 1.5);
  const myHeading = arriveHeading(g, npc.edge, npc.dir);
  const side = TRAFFIC.driveOnRight ? 1 : -1;

  const myTurn = wrapAngle(exitHeading(g, npc.next, node) - myHeading);
  // Joining a roundabout: the ring has priority, whichever side it comes from.
  const joiningRing = g.edges[npc.next].oneWay !== 0 && g.edges[npc.edge].oneWay === 0;
  // Patience only overrides the give-way rule for cars still approaching;
  // nobody drives into a car that is already in the box.
  const patient = npc.wait >= TRAFFIC.patience;

  const check = (
    o: { x: number; z: number; speed: number; edge: number; dir: 1 | -1; s: number; next?: number }, isPlayer: boolean,
  ) => {
    if (o.edge === npc.edge) return false;
    const oe = g.edges[o.edge];
    const arriving = laneEnd(g, o.edge, o.dir) === node;
    const leaving = !arriving && (oe.a === node || oe.b === node);
    if (!arriving && !leaving) return false;
    const theirRemaining = oe.length - o.s;
    // In the box: past its own stop line on the way in, or not yet clear of
    // the node on the way out. A car waiting AT the line is not in the box —
    // counting it was what made every car yield to every other.
    // A car that has stopped on its way OUT is the car in front for whoever
    // follows it, not a box blocker: counting it gridlocked whole junctions
    // whenever a queue backed up into one.
    const inBox = arriving ? theirRemaining < TRAFFIC.stopLine - 1 : (o.s < TRAFFIC.inside && o.speed > 0.5);
    if (inBox) {
      // Leaving along my chosen exit is the car in front, not a conflict.
      if (leaving && o.edge === npc.next) return false;
      return true;
    }
    if (!arriving || patient) return false;
    if (theirRemaining > TRAFFIC.approach) return false;
    if (joiningRing && oe.oneWay !== 0) return o.speed > 0.5 || isPlayer;
    // A car standing at its line is waiting on someone; if that someone is
    // me, one of us has to go, and patience decides. The player is never
    // assumed to be waiting.
    if (!isPlayer && o.speed < 0.5) return false;
    const theirArrival = theirRemaining / Math.max(o.speed, 1.5);
    if (theirArrival > myArrival + TRAFFIC.arrivalWindow) return false;
    // Where are they, relative to my heading? Forward is (-sin h, -cos h) and
    // right is (cos h, -sin h); `side` flips it for left-hand traffic. A
    // positive heading change is a turn to the LEFT.
    const fx = -Math.sin(myHeading), fz = -Math.cos(myHeading);
    const rx = Math.cos(myHeading) * side, rz = -Math.sin(myHeading) * side;
    const dx = o.x - npc.x, dz = o.z - npc.z;
    const toSide = dx * rx + dz * rz;
    const toFront = dx * fx + dz * fz;
    if (toSide > Math.abs(toFront) * 0.4) {
      // From my priority side. Not a conflict if they are turning away
      // from me — toward their own priority side — before our paths meet.
      if (o.next !== undefined && o.next >= 0) {
        const theirTurn = wrapAngle(exitHeading(g, o.next, node) - arriveHeading(g, o.edge, o.dir));
        // Toward their own driving side is a turn away from me: negative
        // (right) in right-hand traffic.
        if (theirTurn * side < -Math.PI / 4) return false;
      }
      return true;
    }
    if (toFront > 0 && Math.abs(toSide) < toFront * 0.4) {
      // Oncoming. They have priority when I turn across their path — the
      // left turn, in right-hand traffic — and only if they are not turning
      // across mine at the same time, which two opposed turns do not (each
      // passes in front of the other).
      if (myTurn * side <= Math.PI / 6) return false;
      if (o.next !== undefined && o.next >= 0) {
        const theirTurn = wrapAngle(exitHeading(g, o.next, node) - arriveHeading(g, o.edge, o.dir));
        if (theirTurn * side > Math.PI / 6) return false;
      }
      return true;
    }
    return false;
  };

  for (const ei of n.edges) {
    for (const d of [0, 1]) {
      const list = lanes.get(ei * 2 + d);
      if (!list) continue;
      for (const o of list) if (o !== npc && check(o, false)) return true;
    }
  }
  if (player.edge >= 0 && check(player, true)) return true;
  return false;
}

/**
 * Speed limit from the curvature of the lane over the next stretch.
 *
 * Heading change over a distance gives a radius; the cornering budget gives
 * the speed that radius allows. Looked at over the next few car lengths so
 * a car slows into a bend rather than in it.
 */
function bendSpeed(g: RoadGraph, npc: Npc): number {
  const e = g.edges[npc.edge];
  const look = Math.min(18, e.length - npc.s);
  if (look < 4) return Infinity;
  laneAt(g, npc.edge, npc.dir, npc.s, pose);
  laneAt(g, npc.edge, npc.dir, npc.s + look, pose2);
  const turn = Math.abs(wrapAngle(pose2.heading - pose.heading));
  if (turn < 0.02) return Infinity;
  const radius = look / turn;
  return Math.max(TRAFFIC.crawl, Math.sqrt(TRAFFIC.lateralAccel * radius));
}

/**
 * A racer's bend limit: every bend in the next `RACE.lookAhead` metres of the
 * lane, each one's cornering speed plus the braking distance to it — so it
 * is on the brakes before the corner, from 260 km/h, not in it.
 */
function raceBendSpeed(g: RoadGraph, npc: Npc): number {
  const e = g.edges[npc.edge];
  let limit = Infinity;
  for (let d = 0; d < RACE.lookAhead; d += 10) {
    const s = npc.s + d;
    if (s + 18 > e.length) break;
    laneAt(g, npc.edge, npc.dir, s, pose);
    laneAt(g, npc.edge, npc.dir, s + 18, pose2);
    const turn = Math.abs(wrapAngle(pose2.heading - pose.heading));
    if (turn < 0.02) continue;
    const vBend = Math.sqrt(RACE.lateral * (18 / turn));
    limit = Math.min(limit, Math.sqrt(vBend * vBend + 2 * RACE.brake * d));
  }
  return limit;
}

/** Off the lane onto a racer's own line across the track. */
function offsetLine(npc: Npc, p: LanePose) {
  p.x += Math.cos(p.heading) * npc.line;
  p.z += -Math.sin(p.heading) * npc.line;
}

/** Steer, accelerate and move one car. */
function driveOne(g: RoadGraph, npc: Npc, dt: number, lanes: Map<number, Npc[]>, wrecks: Npc[], others: Npc[]) {
  const e = g.edges[npc.edge];
  const remaining = e.length - npc.s;

  // --- how fast may I go -----------------------------------------------
  let target = Math.min(npc.cruise, e.speed * TRAFFIC.cruiseVary[1], npc.top);
  target = Math.min(target, npc.race ? raceBendSpeed(g, npc) : bendSpeed(g, npc));
  const brakeRate = npc.race ? RACE.brake : TRAFFIC.brake;

  // The turn at the node ahead: slow so as to arrive at the turn's speed.
  if (npc.next >= 0) {
    const turn = turnAngle(g, npc.edge, npc.dir, npc.next);
    // A racer takes a junction corner as an arc, at what its grip allows.
    const vTurn = npc.race
      ? (turn < Math.PI / 12 ? Infinity : Math.sqrt(RACE.lateral * RACE.cornerRadius * (Math.PI / 2) / turn))
      : turnSpeedFor(turn);
    if (vTurn < Infinity) {
      target = Math.min(target, Math.sqrt(vTurn * vTurn + 2 * brakeRate * Math.max(0, remaining)));
    }
    // Onto a slower road: arrive at its speed.
    const nextSpeed = g.edges[npc.next].speed * TRAFFIC.cruiseVary[1];
    target = Math.min(target, Math.sqrt(nextSpeed * nextSpeed + 2 * brakeRate * Math.max(0, remaining)));
  }

  // --- who is in front ---------------------------------------------------
  const { gap, speed: leadSpeed } = carAhead(g, npc, lanes);
  let obstacle = gap;
  let obstacleSpeed = leadSpeed;
  if (player.edge < 0) {
    const d = coneAhead(npc, player.x, player.z, 4.5);
    if (d < obstacle) { obstacle = d; obstacleSpeed = player.speed; }
  }
  for (const w of wrecks) {
    const d = coneAhead(npc, w.x, w.z, w.length);
    if (d < obstacle) { obstacle = d; obstacleSpeed = 0; }
  }
  // People in the road — crossing, knocked down, running about (published by
  // `KestrelPeople`). Someone standing, as far as a driver is concerned.
  for (const w of STREET_WALKERS) {
    if (!w.onRoad) continue;
    const d = coneAhead(npc, w.x, w.z, 0.6);
    if (d < obstacle) { obstacle = d; obstacleSpeed = 0; }
  }
  // And any car going my way that the lanes did not account for — one on a
  // parallel edge a knot in the skeleton left a lane's width away, one cutting
  // in across a junction. The graph is the plan; this is the eyes. Short
  // range and near-parallel only, and never mutual: if we each see the other
  // ahead (two lanes merging), the higher slot gives way.
  for (const o of others) {
    if (o === npc || (o.edge === npc.edge && o.dir === npc.dir)) continue;
    if (npc.race && o.race) continue;
    if (Math.cos(o.heading - npc.heading) < 0.8) continue;
    const d = coneAhead(npc, o.x, o.z, o.length);
    if (d > TRAFFIC.eyesRange) continue;
    const back = coneAhead(o, npc.x, npc.z, npc.length);
    if (back < TRAFFIC.eyesRange && o.id < npc.id) continue; // they see me too; they yield
    if (d < obstacle) { obstacle = d; obstacleSpeed = o.speed; }
  }
  let holding = false;
  if (obstacle < TRAFFIC.lookAhead) {
    // Close to a standing gap plus a time headway on the lead's speed: what
    // a car following another does, which is match its speed at a distance
    // that grows with speed.
    const want = TRAFFIC.gapStopped + TRAFFIC.headway * Math.max(0, obstacleSpeed);
    const room = obstacle - want;
    // Speed that stops within `room` from the lead's speed, never negative.
    const vFollow = room <= 0
      ? Math.max(0, obstacleSpeed - TRAFFIC.closingMargin)
      : Math.sqrt(Math.max(0, obstacleSpeed * obstacleSpeed + 2 * TRAFFIC.brake * room));
    if (vFollow < target) { target = vFollow; holding = true; }
  }

  // --- the junction --------------------------------------------------------
  let atLine = false;
  // Past the stop line, a car is committed: it clears the box whatever
  // arrives, because a car that stops INSIDE a junction is what a gridlock
  // is made of. The one exception is the level crossing, whose barriers
  // are a hard stop wherever the car is short of the deck.
  if (remaining < TRAFFIC.approach) {
    const line = Math.max(0, remaining - TRAFFIC.stopLine);
    const gate = npc.next >= 0 ? g.edges[npc.next].gate : null;
    const gated = gate !== null && !isCrossingClear(gate);
    const committed = remaining < TRAFFIC.stopLine - 0.5;
    // A racer has the track to itself: no give-way at its own corners.
    const yielding = !gated && !committed && !npc.race && mustYield(g, npc, lanes, remaining);
    if (gated || yielding) {
      // Stop at the line — the speed that reaches zero exactly there.
      const vStop = Math.sqrt(2 * TRAFFIC.brake * line);
      target = Math.min(target, vStop);
      atLine = line < 0.5;
      npc.wait += yielding && npc.speed < 0.5 ? dt : 0;
      holding = true;
    } else if (remaining > TRAFFIC.stopLine) {
      npc.wait = 0;
    }
  } else {
    npc.wait = 0;
  }
  if (atLine) target = 0;

  // --- accelerate / brake --------------------------------------------------
  const before = npc.speed;
  const brake = npc.race ? RACE.brake : obstacle < TRAFFIC.gapStopped + 1 ? TRAFFIC.brakeHard : TRAFFIC.brake;
  const accel = npc.race ? RACE.accel : TRAFFIC.accel;
  npc.speed += Math.max(-brake * dt, Math.min(accel * dt, target - npc.speed));
  if (npc.speed < 0) npc.speed = 0;
  // On the pedal: losing speed, or standing on it behind something.
  npc.slowing = npc.speed < before - dt * 0.4 || (holding && npc.speed < 1.5 && (obstacle < 8 || atLine));

  // --- advance along the lane ----------------------------------------------
  const step = npc.speed * dt;
  npc.odometer += step;
  npc.s += step;
  if (npc.s >= e.length) {
    if (npc.next < 0) {
      // Dead end: turn round. The lane on the other side is a few metres
      // over; the blend below carries the car across it.
      laneAt(g, npc.edge, npc.dir, e.length, pose);
      npc.dir = npc.dir > 0 ? -1 : 1;
      npc.s = Math.max(0, npc.s - e.length);
      npc.speed = Math.min(npc.speed, TRAFFIC.turnSpeed.sharp);
    } else {
      laneAt(g, npc.edge, npc.dir, e.length, pose);
      const node = laneEnd(g, npc.edge, npc.dir);
      const over = npc.s - e.length;
      npc.edge = npc.next;
      npc.dir = dirFrom(g, npc.edge, node);
      npc.s = Math.min(over, g.edges[npc.edge].length);
      const ne = g.edges[npc.edge];
      npc.cruise = ne.speed * (TRAFFIC.cruiseVary[0] + random() * (TRAFFIC.cruiseVary[1] - TRAFFIC.cruiseVary[0]));
    }
    // Where the old lane put me against where the new one starts: the
    // difference is blended away over the next few metres.
    laneAt(g, npc.edge, npc.dir, 0, pose2);
    npc.blendX = pose.x - pose2.x;
    npc.blendZ = pose.z - pose2.z;
    npc.blendH = wrapAngle(pose.heading - pose2.heading);
    npc.next = chooseExit(g, npc.edge, npc.dir, npc.regions);
    npc.wait = 0;
  }

  // --- pose ------------------------------------------------------------------
  laneAt(g, npc.edge, npc.dir, npc.s, pose);
  if (npc.race) offsetLine(npc, pose);
  const f = npc.s < TRAFFIC.blend ? 1 - npc.s / TRAFFIC.blend : 0;
  const ease = f * f * (3 - 2 * f);
  const heading = wrapAngle(pose.heading + npc.blendH * ease);
  npc.yawRate = wrapAngle(heading - npc.heading) / dt;
  npc.heading = heading;
  npc.x = pose.x + npc.blendX * ease;
  npc.z = pose.z + npc.blendZ * ease;

  // Wedged: nothing ahead, not at a line, yet not moving.
  npc.stuck = (npc.speed < 0.3 && !holding) ? npc.stuck + dt : 0;
  if (npc.stuck > TRAFFIC.stuckGrace) { npc.active = false; return; }

  // A road whose height is known exactly (Halcyon's, off the nav raster): on
  // it, and pitched to it — the harbour road ramps over its level crossing.
  const known = g.edges[npc.edge].heightAt;
  if (known) {
    npc.y = known(npc.x, npc.z);
    const reach = npc.length * 0.35;
    const hx = -Math.sin(npc.heading) * reach;
    const hz = -Math.cos(npc.heading) * reach;
    const slope = Math.atan2(known(npc.x + hx, npc.z + hz) - known(npc.x - hx, npc.z - hz), reach * 2);
    npc.pitch += (Math.max(-0.35, Math.min(0.35, slope)) - npc.pitch) * Math.min(1, dt * 6);
    return;
  }
  const settle = groundHeightAt(npc.x, npc.z);
  if (settle !== null) {
    // Ease onto the sampled height; the raster is 1.5 m per pixel, so stepping
    // straight to it makes cars twitch vertically on slopes.
    npc.y += (settle - npc.y) * Math.min(1, dt * 8);
  }
  // Pitch to the road: the height under the front axle against the rear one,
  // eased for the same 1.5 m-pixel reason.
  const axle = npc.length * 0.35;
  const fx = -Math.sin(npc.heading);
  const fz = -Math.cos(npc.heading);
  const front = groundHeightAt(npc.x + fx * axle, npc.z + fz * axle);
  const back = groundHeightAt(npc.x - fx * axle, npc.z - fz * axle);
  if (front !== null && back !== null) {
    const slope = Math.atan2(front - back, axle * 2);
    npc.pitch += (Math.max(-0.35, Math.min(0.35, slope)) - npc.pitch) * Math.min(1, dt * 6);
  }
}

/* -------------------------------------------------------------- the step */

/**
 * Cars beyond the density cap are only retired once they are this far away, so
 * turning traffic down never makes a car vanish in front of the player. The
 * count settles over the next few seconds instead of popping.
 */
const POLITE_RETIRE = 60;

const lanes = new Map<number, Npc[]>();
const wrecks: Npc[] = [];
const driving: Npc[] = [];

/**
 * The cars being driven right now (not wrecks), as of the last update. Read by
 * `KestrelPeople`, whose pedestrians get out of their way — or do not.
 */
export const liveTraffic = (): readonly Npc[] => driving;

/**
 * Advance the whole traffic set one frame.
 *
 * `px`/`pz` is the player, who is both the centre of the spawn ring and an
 * obstacle: NPCs brake for the player's car as they would for each other.
 * `limit` caps how many cars may be live at once — the traffic density
 * setting. A cap rather than a smaller pool: the pool is a fixed set of Rapier
 * bodies mounted by `Traffic`, and capping how many are *active* changes the
 * density on the next frame without touching the physics world.
 */
export function updateTraffic(
  npcs: Npc[], dt: number, px: number, pz: number, playerHeading: number, playerSpeed: number,
  limit: number = npcs.length,
) {
  const g = getRoadGraph();
  if (groundHeightAt(px, pz) === null && groundHeightAt(0, 0) === null) return; // raster not loaded yet

  const { despawn } = TRAFFIC;
  let live = 0;
  for (const npc of npcs) {
    if (!npc.active) continue;
    if (Math.hypot(npc.x - px, npc.z - pz) > (npc.race ? RACE.range + 100 : despawn)) {
      npc.active = false;
      npc.wreck = 0;
      continue;
    }
    if (npc.wreck > 0) npc.wreck += dt;
    live++;
  }

  // Over the cap: retire the excess, and only out of sight.
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

  // Lane occupancy, sorted along each lane. Everything below is a lookup in it.
  for (const list of lanes.values()) list.length = 0;
  wrecks.length = 0;
  driving.length = 0;
  for (const npc of npcs) {
    if (!npc.active) continue;
    if (npc.wreck > 0) { wrecks.push(npc); continue; }
    driving.push(npc);
    const key = npc.edge * 2 + (npc.dir > 0 ? 0 : 1);
    (lanes.get(key) ?? lanes.set(key, []).get(key)!).push(npc);
  }
  for (const list of lanes.values()) if (list.length > 1) list.sort((a, b) => a.s - b.s);

  // The player, onto the graph.
  player.x = px; player.z = pz; player.heading = playerHeading; player.speed = Math.max(0, playerSpeed);
  const fix = nearestLane(g, px, pz, playerHeading, 5);
  if (fix) { player.edge = fix.edge; player.dir = fix.dir; player.s = fix.s; } else { player.edge = -1; }

  // Top up, a few per frame, so a long drive does not stall on one big refill.
  let budget = TRAFFIC.spawnsPerFrame;
  if (live < limit) {
    // Which kinds of road are in reach at all, so a slot that cannot spawn
    // here — a tractor in town, a bus on Skylark — is not tried every step.
    edgesNear(g, px, pz, TRAFFIC.spawnMax, nearEdges);
    let present = 0;
    for (const k of nearEdges) present |= REGION[g.edges[k].region];
    // The circuit within a racer's (much longer) reach — looked for only
    // while a racer is waiting to go out.
    if (npcs.some((n) => n.race && !n.active)) {
      edgesNear(g, px, pz, RACE.range, nearEdges);
      for (const k of nearEdges) present |= REGION[g.edges[k].region] & REGION.circuit;
    }
    // Racers first: near the circuit they are what the cap is for.
    for (const pass of [true, false]) {
      for (const npc of npcs) {
        if (budget <= 0 || live >= limit) break;
        if (npc.active || npc.race !== pass) continue;
        if (!(npc.regions & present)) continue;
        if (spawn(g, npc, px, pz, lanes)) { budget--; live++; }
      }
    }
  }

  for (const npc of npcs) {
    if (!npc.active || npc.wreck > 0) continue;
    driveOne(g, npc, dt, lanes, wrecks, driving);
  }
}
