import {
  Bone, BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute,
  Vector3, type Material, type Object3D,
} from 'three';
import bikeData from '@/config/motorbikeData.json';

/**
 * The Firehawk's rider, rigged and ridden.
 *
 * The bike's file brings its own rider — leathers, back hump, helmet — but
 * stood beside it in a T-pose and unskinned: one rigid mesh. So he is rigged
 * here, at load. A T-pose is the one pose where the body's regions separate
 * cleanly by position: arms are whatever is out past the shoulders at
 * shoulder height, legs are below the crotch split by side, and the rest is
 * a torso in two parts. Each vertex is weighted to its region's bone, and
 * across each joint — shoulder, elbow, hip, knee, waist, neck — the weight
 * blends over a few centimetres, so a bent knee creases rather than shears.
 * The helmet is a separate mesh and simply rides the head bone.
 *
 * Every frame (`pose`) he is sat on the bike and ridden:
 *
 *   seat     the pelvis on the seat, tucked forward over the tank — more
 *            tucked the faster he goes, sitting up under hard braking.
 *   hands    on the clip-ons, by two-bone IK, elbows out; the grips turn
 *            with the bars, so the hands follow the steering.
 *   feet     on the rear-sets, by two-bone IK, knees in against the tank.
 *   corners  he hangs off: hips shifted to the inside, the inside knee out
 *            toward the tarmac, the upper body dropped in, and the head
 *            counter-rolled so his eyes stay level with the horizon — what
 *            a racer does, and what makes a leaning bike read as ridden.
 *
 * All positions here are the bike's frame (forward −Z, up Y, ground y = 0),
 * which is also the rider mesh's own frame as the prepare script wrote it.
 */

type V3 = [number, number, number];

/** The rider's joints in the T-pose he was modelled in, measured off the mesh. */
const Z = 0.068; // the torso's middle, front to back
const BIND = {
  pelvis: [0, 0.95, Z] as V3,
  chest: [0, 1.16, Z] as V3,
  head: [0, 1.5, Z] as V3,
  // The arms, on their own centreline — it is not the torso's: the sleeve
  // runs 10 cm behind the body's middle and the hand comes forward of it,
  // and the wrist (the narrowest point) is at 0.68, the glove beyond it.
  // Joints guessed straight out along the torso's line put the bones 5–8 cm
  // off the glove, which then hung beside whatever its wrist was aimed at.
  shoulderP: [0.2, 1.43, 0.105] as V3, shoulderN: [-0.2, 1.43, 0.105] as V3,
  elbowP: [0.48, 1.4, 0.1] as V3, elbowN: [-0.48, 1.4, 0.1] as V3,
  wristP: [0.68, 1.445, 0.04] as V3, wristN: [-0.68, 1.445, 0.04] as V3,
  // The glove is a mitten: four fingers as one, 8 cm across, from the
  // knuckles at 0.815 to the tips at 0.89; the thumb hangs straight down
  // under the palm (x 0.73–0.80, below y 1.42). The fingers bend at the
  // knuckles and again halfway along — enough to close them round a grip.
  knuckleP: [0.815, 1.465, -0.004] as V3, knuckleN: [-0.815, 1.465, -0.004] as V3,
  fingerP: [0.852, 1.462, -0.006] as V3, fingerN: [-0.852, 1.462, -0.006] as V3,
  hipP: [0.09, 0.92, Z] as V3, hipN: [-0.09, 0.92, Z] as V3,
  kneeP: [0.1, 0.49, Z] as V3, kneeN: [-0.1, 0.49, Z] as V3,
  ankleP: [0.1, 0.1, Z] as V3, ankleN: [-0.1, 0.1, Z] as V3,
};
type Joint = keyof typeof BIND;
const PARENT: Record<Joint, Joint | null> = {
  pelvis: null, chest: 'pelvis', head: 'chest',
  shoulderP: 'chest', shoulderN: 'chest', elbowP: 'shoulderP', elbowN: 'shoulderN', wristP: 'elbowP', wristN: 'elbowN',
  knuckleP: 'wristP', knuckleN: 'wristN', fingerP: 'knuckleP', fingerN: 'knuckleN',
  hipP: 'pelvis', hipN: 'pelvis', kneeP: 'hipP', kneeN: 'hipN', ankleP: 'kneeP', ankleN: 'kneeN',
};
const JOINTS = Object.keys(BIND) as Joint[];

/* ---------------------------------------------------------- where he sits */

/** The bike's touch points, from its own geometry (`prepare-motorbike`). */
const SEAT: V3 = [0, 0.93, 0.27];
/**
 * How each hand holds its grip, the right one (the left is its mirror).
 * Measured off the bars: the rubber runs from the switchgear, (0.22, 0.975,
 * −0.40), out to the bar-end cap, (0.33, 0.94, −0.32) — a clip-on, swept
 * back 36°.
 *
 * As a racer holds one: the rubber lies across the root of the fingers,
 * just outboard of its middle, with the knuckles on top of it and a touch
 * forward; the hand comes down onto it from behind and above, near enough
 * in line with the forearm that the wrist stays straight; the palm faces
 * the grip (turned so the knuckles run along it), and the fingers close
 * round its front and underneath, the thumb under it from behind.
 */
const GRIP_AT: V3 = [0.2805, 0.9558, -0.356];
const KNUCKLES: V3 = [0.286, 0.984, -0.364];
/** Wrist to knuckles, its direction (forward, down, a little out) and length in the T-pose. */
const HAND_DIR = new Vector3(0.3, -0.45, -0.84).normalize();
const HAND_LEN = 0.135;
const GRIP: V3 = KNUCKLES.map((v, i) => v - HAND_DIR.getComponent(i) * HAND_LEN) as V3;
/** The fingers' curl at the knuckles and halfway along, radians: closed round the rubber, and open. */
const CURL = { grip: [1.25, 1.1], open: [0.15, 0.1] };
const PEG: V3 = [0.25, 0.37, 0.3];
const HEAD = new Vector3(...(bikeData.steerHead as V3));
const STEER_AXIS = new Vector3(...(bikeData.steerAxis as V3)).normalize();

/** How a pose responds to riding, all in radians and metres. */
export const RIDING = {
  /** Upper body forward of vertical at a standstill, and how much more at speed. */
  tuck: 1.0,
  tuckAtSpeed: 0.3,
  /** Sitting up under hard braking. */
  brakeLift: 0.3,
  /** Hips across the seat at full lean, and the upper body's extra drop in. */
  hangOff: 0.15,
  hangRoll: 0.32,
  /** Of the bike's lean, how much the head takes back to stay level. */
  headLevel: 0.75,
  /** The lean at which a rider is fully hung off. */
  fullLean: 0.85,
  /** Of the bike's pitch, how much he takes back — over the bars up a wheelie, sat back in a stoppie. */
  pitchCounter: 0.7,
  /**
   * Nose down, he takes back more than the bike gives — braced on straight
   * arms, leaning back against it — as far as his arms let him: up a 60°
   * stoppie that is near flat along the tank, not thrown over the screen.
   */
  stoppieCounter: 1.45,
  /** Stood on the pegs: how far the pelvis comes up off the seat, and back. */
  standLift: 0.2,
  standBack: 0.06,
  /**
   * The shoulders rolled forward and a little down, metres off the T-pose:
   * reaching for low bars hunches a rider, and square shoulders above
   * outstretched arms read as a mannequin sat on a bike.
   */
  shoulderForward: 0.045,
  shoulderDrop: 0.02,
};

/** Arms up in a V, no hands: the wrists, knuckles and elbow pull, right side. */
const HANDS_UP = { wrist: [0.42, 1.82, 0.3] as V3, tip: [0.47, 1.94, 0.28] as V3, pole: [1.2, 1.2, 0.4] as V3 };
const GRIP_POLE: V3 = [0.9, 0.7, 0.1];

/* --------------------------------------------------------------- rigging */

/** Smooth 0→1 across `a..b`. */
const ramp = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Weights for one vertex: up to two bones and how much of the second. */
function weigh(x: number, y: number): [Joint, Joint, number] {
  const ax = Math.abs(x);
  const side = x >= 0 ? 'P' : 'N';
  // Arms: out past the shoulder, at shoulder height.
  if (ax > 0.17 && y > 1.25) {
    const shoulder = `shoulder${side}` as Joint;
    const elbow = `elbow${side}` as Joint;
    if (ax < 0.3) return ['chest', shoulder, ramp(ax, 0.17, 0.27)];
    const wrist = `wrist${side}` as Joint;
    const knuckle = `knuckle${side}` as Joint;
    // The fingers (not the thumb, which hangs below them) bend at the knuckles and halfway.
    if (ax > 0.835 && y > 1.42) return [knuckle, `finger${side}` as Joint, ramp(ax, 0.84, 0.86)];
    if (ax > 0.79 && y > 1.42) return [wrist, knuckle, ramp(ax, 0.8, 0.825)];
    // The hand bends at the wrist: the glove's cuff is the crease.
    if (ax > 0.6) return [elbow, wrist, ramp(ax, 0.645, 0.7)];
    return [shoulder, elbow, ramp(ax, 0.43, 0.51)];
  }
  // Head and neck.
  if (y > 1.42) return ['chest', 'head', ramp(y, 1.44, 1.53)];
  // Legs: below the crotch, by side.
  if (y < 0.98) {
    const hip = `hip${side}` as Joint;
    const knee = `knee${side}` as Joint;
    if (y > 0.86) return ['pelvis', hip, 1 - ramp(y, 0.86, 0.98)];
    return [hip, knee, 1 - ramp(y, 0.43, 0.55)];
  }
  // The torso, in two.
  return ['pelvis', 'chest', ramp(y, 1.06, 1.22)];
}

export interface RiderRig {
  mesh: SkinnedMesh;
  bones: Record<Joint, Bone>;
}

/**
 * Rig the T-posed rider mesh and hang the helmet on his head. `riderMesh`
 * and `helmet` are the GLB's own nodes, in the bike's frame; the rider is
 * hidden and a skinned copy put in his place, under the same parent.
 */
export function rigRider(riderMesh: Mesh, helmet: Object3D | undefined): RiderRig {
  const geometry = (riderMesh.geometry as BufferGeometry).clone();
  const pos = geometry.getAttribute('position');
  const index = new Uint16Array(pos.count * 4);
  const weight = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const [a, b, t] = weigh(pos.getX(i), pos.getY(i));
    index[i * 4] = JOINTS.indexOf(a);
    index[i * 4 + 1] = JOINTS.indexOf(b);
    weight[i * 4] = 1 - t;
    weight[i * 4 + 1] = t;
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weight, 4));

  const bones = {} as Record<Joint, Bone>;
  for (const j of JOINTS) {
    const bone = new Bone();
    bone.name = j;
    bones[j] = bone;
  }
  for (const j of JOINTS) {
    const parent = PARENT[j];
    const at = BIND[j];
    if (parent) {
      const p = BIND[parent];
      bones[j].position.set(at[0] - p[0], at[1] - p[1], at[2] - p[2]);
      bones[parent].add(bones[j]);
    } else {
      bones[j].position.set(...at);
    }
  }
  const mesh = new SkinnedMesh(geometry, riderMesh.material as Material);
  mesh.name = 'riderSkinned';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Skinned vertices go wherever the bones take them; the bind-pose bounds
  // would cull him as soon as he leaned out of them.
  mesh.frustumCulled = false;
  mesh.add(bones.pelvis);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(JOINTS.map((j) => bones[j])), new Matrix4());
  riderMesh.parent?.add(mesh);
  riderMesh.visible = false;

  if (helmet) {
    // In the bike's frame like the rider: parented to the head bone at bind,
    // it is offset by minus the head joint and rides wherever the head goes.
    helmet.removeFromParent();
    helmet.position.set(-BIND.head[0], -BIND.head[1], -BIND.head[2]);
    helmet.castShadow = true;
    bones.head.add(helmet);
  }
  return { mesh, bones };
}

/* ------------------------------------------------------------------ pose */

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _target = new Vector3();
const _pole = new Vector3();

/** Turn `bone` (in world) so the direction to `child` points at `toward`. */
function aim(bone: Bone, child: Bone, toward: Vector3) {
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  _c.subVectors(_b, _a).normalize();
  _d.subVectors(toward, _a).normalize();
  if (_c.lengthSq() < 1e-8 || _d.lengthSq() < 1e-8) return;
  _q.setFromUnitVectors(_c, _d);
  bone.getWorldQuaternion(_q2);
  _q2.premultiply(_q);
  // Back to the parent's frame.
  bone.parent!.getWorldQuaternion(_q).invert();
  bone.quaternion.copy(_q.multiply(_q2));
  bone.updateMatrixWorld(true);
}

/** Two-bone IK: `upper`→`lower`→`end` reaching `target`, the middle joint bending toward `pole`. */
function reach(upper: Bone, lower: Bone, end: Bone, goal: Vector3, pole: Vector3) {
  // Copies: the callers pass scratch vectors, and `aim` uses scratch of its own.
  const target = goal.clone();
  const toward = pole.clone();
  const root = upper.getWorldPosition(new Vector3());
  const a = lower.getWorldPosition(new Vector3()).distanceTo(root);
  const b = end.getWorldPosition(new Vector3()).distanceTo(lower.getWorldPosition(new Vector3()));
  const toT = _target.copy(target).sub(root);
  const d = Math.min(Math.max(toT.length(), 1e-3), (a + b) * 0.999);
  const n = toT.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const m = _pole.copy(toward).sub(root);
  m.addScaledVector(n, -m.dot(n)).normalize();
  const mid = root.clone().addScaledVector(n, x).addScaledVector(m, h);
  aim(upper, lower, mid);
  aim(lower, end, target);
}

export interface RidingState {
  /** The bike's own lean, radians, + to its left (−X) — what the rider counter-rolls against. */
  lean: number;
  /** Steering angle at the bars, radians, about the steering axis. */
  bars: number;
  /** 0..1, how fast: tucks the rider in. */
  pace: number;
  /** 0..1, how hard the brakes are on: sits him up. */
  braking: number;
  /** The bike's pitch, radians, + nose up: a wheelie, − a stoppie. */
  pitch?: number;
  /** 0..1, stood up on the pegs. */
  stand?: number;
  /** 0..1, hands off the bars and up. */
  noHands?: number;
}

const _gripP = new Vector3();
const _gripN = new Vector3();
const _tipP = new Vector3();
const _tipN = new Vector3();
const _poleP = new Vector3();
const _poleN = new Vector3();
const _up = new Vector3();
const _atP = new Vector3();
const _atN = new Vector3();
const _face = new Vector3();
const _fwd = new Vector3();
const _palm = new Vector3();
const _axis = new Vector3();
const _w = new Vector3();

/**
 * Roll `wrist` about its own hand (wrist → `tip`, already aimed) so the
 * palm — −Y in the T-pose — faces `face`, as near as it can square to the hand.
 */
function palmTo(wrist: Bone, tip: Vector3, face: Vector3) {
  wrist.getWorldPosition(_w);
  _axis.subVectors(tip, _w).normalize();
  const want = face.addScaledVector(_axis, -face.dot(_axis));
  if (want.lengthSq() < 1e-8) return;
  want.normalize();
  wrist.getWorldQuaternion(_q2);
  _palm.set(0, -1, 0).applyQuaternion(_q2);
  _palm.addScaledVector(_axis, -_palm.dot(_axis));
  if (_palm.lengthSq() < 1e-8) return;
  _palm.normalize();
  const angle = Math.atan2(_c.crossVectors(_palm, want).dot(_axis), _palm.dot(want));
  _q.setFromAxisAngle(_axis, angle);
  _q2.premultiply(_q);
  wrist.parent!.getWorldQuaternion(_q).invert();
  wrist.quaternion.copy(_q.multiply(_q2));
  wrist.updateMatrixWorld(true);
}
const _rot = new Quaternion();
const span = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Shoulder to wrist with the arm straight — a touch short of it, so the elbow is never locked solid. */
const ARM_REACH = (span(BIND.shoulderP, BIND.elbowP) + span(BIND.elbowP, BIND.wristP)) * 0.97;
const _e = new Vector3();

/** Sit the rider on the bike for this frame. `frame` is the object the bike is drawn in (the mesh's parent). */
export function pose(rig: RiderRig, frame: Object3D, s: RidingState) {
  const { bones } = rig;
  const r = RIDING;
  // How far hung off, −1..1, + to the bike's left.
  const hang = Math.max(-1, Math.min(1, s.lean / r.fullLean));

  // This frame's lean and pitch, not last frame's: the IK works in world space.
  frame.updateWorldMatrix(true, false);
  rig.mesh.updateWorldMatrix(true, false);
  // Everything back to the T-pose first: IK aims from wherever the bones are.
  for (const j of JOINTS) bones[j].quaternion.identity();

  const stand = s.stand ?? 0;
  const free = s.noHands ?? 0;
  // The pelvis on the seat, moved across to the inside of the corner — or
  // stood up off it on the pegs.
  bones.pelvis.position.set(
    SEAT[0] - hang * r.hangOff,
    SEAT[1] - Math.abs(hang) * 0.02 + stand * r.standLift,
    SEAT[2] + stand * r.standBack,
  );
  const pitch = s.pitch ?? 0;
  let tuck = r.tuck + r.tuckAtSpeed * s.pace - r.brakeLift * s.braking
    + pitch * (pitch > 0 ? r.pitchCounter : r.stoppieCounter);
  // Stood up he folds at the hips less; hands off, he sits up straight.
  tuck += (0.75 - tuck) * stand * 0.6;
  tuck += (0.15 - tuck) * free;
  // Where the wrists go: on the grips, which turn with the bars about the
  // steering axis — or, hands off, up in a V, by however far `free` has got.
  _rot.setFromAxisAngle(STEER_AXIS, s.bars);
  const onBars = (out: Vector3, at: V3, side: 1 | -1, up: V3) => {
    out.set(at[0] * side, at[1], at[2]).sub(HEAD).applyQuaternion(_rot).add(HEAD);
    out.lerp(_up.set(up[0] * side, up[1], up[2]), free);
    return frame.localToWorld(out);
  };
  onBars(_gripP, GRIP, 1, HANDS_UP.wrist);
  onBars(_gripN, GRIP, -1, HANDS_UP.wrist);

  // Sat back as far as asked, but never out of reach of the bars: leaning
  // back off a stoppie (or stood up), straight arms are the limit, so if
  // the shoulders have gone past it he comes forward again until they
  // haven't. Hands off, there is nothing to reach.
  const body = (t: number) => placeBody(rig, s, hang, free, t);
  for (let tries = 0; tries < 8; tries++) {
    body(tuck);
    if (free > 0.5) break;
    const far = Math.max(
      bones.shoulderP.getWorldPosition(_a).distanceTo(_gripP),
      bones.shoulderN.getWorldPosition(_b).distanceTo(_gripN),
    );
    if (far <= ARM_REACH) break;
    tuck += Math.min(0.3, (far - ARM_REACH) * 2 + 0.04);
  }
  placeLimbs(rig, frame, s, hang, free);
}

/** The upper body for a given tuck: pelvis, chest, head, shoulders. */
function placeBody(rig: RiderRig, s: RidingState, hang: number, free: number, tuck: number) {
  const { bones } = rig;
  const r = RIDING;
  // Forward is −Z, so a forward lean is a negative turn about X. The pelvis
  // takes most of it, the chest the rest; both drop toward the inside.
  _e.set(-tuck * 0.65, 0, hang * r.hangRoll * 0.5);
  bones.pelvis.quaternion.setFromAxisAngle(_a.set(1, 0, 0), _e.x)
    .multiply(_q.setFromAxisAngle(_b.set(0, 0, 1), _e.z));
  bones.chest.quaternion.setFromAxisAngle(_a.set(1, 0, 0), -tuck * 0.35)
    .multiply(_q.setFromAxisAngle(_b.set(0, 0, 1), hang * r.hangRoll * 0.5));
  // The head up to look down the road, and rolled back against the lean.
  bones.head.quaternion.setFromAxisAngle(_a.set(1, 0, 0), tuck * 0.9)
    .multiply(_q.setFromAxisAngle(_b.set(0, 0, 1), -(s.lean * r.headLevel + hang * r.hangRoll)));
  // Shoulders rolled forward and down — less so with the arms up.
  for (const [bone, x] of [[bones.shoulderP, 1], [bones.shoulderN, -1]] as const) {
    const at = BIND[x > 0 ? 'shoulderP' : 'shoulderN'];
    bone.position.set(at[0] - BIND.chest[0], at[1] - BIND.chest[1] - r.shoulderDrop * (1 - free),
      at[2] - BIND.chest[2] - r.shoulderForward * (1 - free));
  }
  bones.pelvis.updateMatrixWorld(true);
}

/** The arms, the hands and the legs, once the body is placed. */
function placeLimbs(rig: RiderRig, frame: Object3D, s: RidingState, hang: number, free: number) {
  const { bones } = rig;
  const onBars = (out: Vector3, at: V3, side: 1 | -1, up: V3) => {
    out.set(at[0] * side, at[1], at[2]).sub(HEAD).applyQuaternion(_rot).add(HEAD);
    out.lerp(_up.set(up[0] * side, up[1], up[2]), free);
    return frame.localToWorld(out);
  };
  onBars(_tipP, KNUCKLES, 1, HANDS_UP.tip);
  onBars(_tipN, KNUCKLES, -1, HANDS_UP.tip);
  onBars(_atP, GRIP_AT, 1, HANDS_UP.tip);
  onBars(_atN, GRIP_AT, -1, HANDS_UP.tip);
  // Elbows out and a little down — wide, as a racer holds them.
  const elbow = (out: Vector3, side: 1 | -1) => frame.localToWorld(
    out.set(GRIP_POLE[0] * side, GRIP_POLE[1], GRIP_POLE[2]).lerp(_up.set(HANDS_UP.pole[0] * side, HANDS_UP.pole[1], HANDS_UP.pole[2]), free));
  reach(bones.shoulderP, bones.elbowP, bones.wristP, _gripP, elbow(_poleP, 1));
  reach(bones.shoulderN, bones.elbowN, bones.wristN, _gripN, elbow(_poleN, -1));
  // The hands down onto the grips, palms turned to face them, fingers
  // closed round them. Hands up, the palms face forward, fingers open.
  const fwd = frame.localToWorld(_fwd.set(0, 0, -1)).sub(frame.localToWorld(_up.set(0, 0, 0))).normalize();
  for (const [side, wrist, knuckle, finger, tip, at] of [
    [1, bones.wristP, bones.knuckleP, bones.fingerP, _tipP, _atP],
    [-1, bones.wristN, bones.knuckleN, bones.fingerN, _tipN, _atN],
  ] as const) {
    aim(wrist, knuckle, tip);
    // Toward the grip from the knuckles, square to the hand — or forward.
    const face = _face.subVectors(at, tip).lerp(fwd, free);
    palmTo(wrist, tip, face);
    const c0 = CURL.grip[0] + (CURL.open[0] - CURL.grip[0]) * free;
    const c1 = CURL.grip[1] + (CURL.open[1] - CURL.grip[1]) * free;
    // In the T-pose the fingers point out along ±X, palm down: curling them
    // is a turn about Z, toward −Y.
    knuckle.quaternion.setFromAxisAngle(_b.set(0, 0, 1), -side * c0);
    finger.quaternion.setFromAxisAngle(_b.set(0, 0, 1), -side * c1);
    wrist.updateMatrixWorld(true);
  }

  // Feet on the pegs; knees forward against the tank — and the inside knee out.
  const kneeOutP = hang < 0 ? -hang : 0;
  const kneeOutN = hang > 0 ? hang : 0;
  reach(bones.hipP, bones.kneeP, bones.ankleP, frame.localToWorld(_target.set(PEG[0], PEG[1], PEG[2])),
    frame.localToWorld(_c.set(0.25 + kneeOutP * 1.2, 0.5, -1)));
  reach(bones.hipN, bones.kneeN, bones.ankleN, frame.localToWorld(_target.set(-PEG[0], PEG[1], PEG[2])),
    frame.localToWorld(_c.set(-0.25 - kneeOutN * 1.2, 0.5, -1)));
}
