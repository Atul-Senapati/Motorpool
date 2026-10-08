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
  shoulderP: [0.2, 1.41, Z] as V3, shoulderN: [-0.2, 1.41, Z] as V3,
  elbowP: [0.47, 1.41, Z] as V3, elbowN: [-0.47, 1.41, Z] as V3,
  wristP: [0.76, 1.41, Z] as V3, wristN: [-0.76, 1.41, Z] as V3,
  hipP: [0.09, 0.92, Z] as V3, hipN: [-0.09, 0.92, Z] as V3,
  kneeP: [0.1, 0.49, Z] as V3, kneeN: [-0.1, 0.49, Z] as V3,
  ankleP: [0.1, 0.1, Z] as V3, ankleN: [-0.1, 0.1, Z] as V3,
};
type Joint = keyof typeof BIND;
const PARENT: Record<Joint, Joint | null> = {
  pelvis: null, chest: 'pelvis', head: 'chest',
  shoulderP: 'chest', shoulderN: 'chest', elbowP: 'shoulderP', elbowN: 'shoulderN', wristP: 'elbowP', wristN: 'elbowN',
  hipP: 'pelvis', hipN: 'pelvis', kneeP: 'hipP', kneeN: 'hipN', ankleP: 'kneeP', ankleN: 'kneeN',
};
const JOINTS = Object.keys(BIND) as Joint[];

/* ---------------------------------------------------------- where he sits */

/** The bike's touch points, from its own geometry (`prepare-motorbike`). */
const SEAT: V3 = [0, 0.93, 0.27];
const GRIP: V3 = [0.31, 0.95, -0.37];
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
};

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
}

const _gripP = new Vector3();
const _gripN = new Vector3();
const _rot = new Quaternion();
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

  // The pelvis on the seat, moved across to the inside of the corner.
  bones.pelvis.position.set(SEAT[0] - hang * r.hangOff, SEAT[1] - Math.abs(hang) * 0.02, SEAT[2]);
  const tuck = r.tuck + r.tuckAtSpeed * s.pace - r.brakeLift * s.braking;
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
  bones.pelvis.updateMatrixWorld(true);

  // The grips turn with the bars, about the steering axis through the head.
  _rot.setFromAxisAngle(STEER_AXIS, s.bars);
  _gripP.set(...GRIP).sub(HEAD).applyQuaternion(_rot).add(HEAD);
  _gripN.set(-GRIP[0], GRIP[1], GRIP[2]).sub(HEAD).applyQuaternion(_rot).add(HEAD);
  frame.localToWorld(_gripP);
  frame.localToWorld(_gripN);
  // Elbows out and a little down.
  reach(bones.shoulderP, bones.elbowP, bones.wristP, _gripP, frame.localToWorld(_c.set(0.9, 0.7, 0.1)));
  reach(bones.shoulderN, bones.elbowN, bones.wristN, _gripN, frame.localToWorld(_c.set(-0.9, 0.7, 0.1)));

  // Feet on the pegs; knees forward against the tank — and the inside knee out.
  const kneeOutP = hang < 0 ? -hang : 0;
  const kneeOutN = hang > 0 ? hang : 0;
  reach(bones.hipP, bones.kneeP, bones.ankleP, frame.localToWorld(_target.set(PEG[0], PEG[1], PEG[2])),
    frame.localToWorld(_c.set(0.25 + kneeOutP * 1.2, 0.5, -1)));
  reach(bones.hipN, bones.kneeN, bones.ankleN, frame.localToWorld(_target.set(-PEG[0], PEG[1], PEG[2])),
    frame.localToWorld(_c.set(-0.25 - kneeOutN * 1.2, 0.5, -1)));
}
