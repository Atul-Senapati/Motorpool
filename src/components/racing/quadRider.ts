import { Euler, Quaternion, type Object3D } from 'three';
import propsData from '@/config/beachPropsData.json';

/**
 * A crowd figure (`crowd.glb`) sat astride a quad bike.
 *
 * The crowd's only clip is a walk, so a rider is posed by hand: each joint
 * turned from its rest pose by a fixed amount (`SEAT_POSE`, degrees, applied
 * after the rest rotation in the joint's own frame) — thighs forward, knees
 * bent, a lean over the bars, arms reaching to the grips. No mixer runs on a
 * rider: the pose is set once and the figure is a static skinned mesh.
 *
 * `SEAT` is where the figure's feet-origin goes in the quad's frame (forward
 * −Z): over the seat behind the handlebar, low enough that the thighs sit on
 * it. Tuned in the lab at `/quad`, where `?pose=` overrides any joint.
 */

export type JointPose = Partial<Record<'x' | 'y' | 'z', number>>;

export const SEAT_POSE: Record<string, JointPose> = {
  // In this rig +x swings a thigh forward and −x bends a knee back.
  Spine2: { x: 18 },
  Neck: { x: -12 },
  LeftUpLeg: { x: 80 },
  RightUpLeg: { x: 80 },
  LeftLeg: { x: -90 },
  RightLeg: { x: -90 },
  LeftFoot: { x: 10 },
  RightFoot: { x: 10 },
  LeftArm: { x: -30, z: 15 },
  RightArm: { x: -30, z: -15 },
  LeftForeArm: { x: -25 },
  RightForeArm: { x: -25 },
};

/** Where the rider's feet-origin sits in the quad's frame, metres. */
export const SEAT: [number, number, number] = [0, -0.04, 0.12];

/** The handlebar, from the quad's data, for the reach. */
export const HANDLEBAR = propsData.quadHandle;

const _q = new Quaternion();
const _e = new Euler();
const DEG = Math.PI / 180;

/** Read `?pose=LeftUpLeg:x:-80,LeftLeg:x:90` — the lab's overrides. */
export function poseFromQuery(search: string): Record<string, JointPose> {
  const out: Record<string, JointPose> = {};
  const raw = new URLSearchParams(search).get('pose');
  if (!raw) return out;
  for (const item of raw.split(',')) {
    const [joint, axis, value] = item.split(':');
    if (!joint || !axis || value === undefined) continue;
    (out[joint] ??= {})[axis as 'x' | 'y' | 'z'] = Number(value);
  }
  return out;
}

/**
 * Pose a freshly cloned crowd figure for the seat. Joint names may carry
 * GLTFLoader's de-duplicating suffix (`Hips_3`); it is ignored.
 */
export function seatRider(figure: Object3D, overrides: Record<string, JointPose> = {}) {
  figure.traverse((o) => {
    if (!(o as { isBone?: boolean }).isBone) return;
    const name = o.name.replace(/_\d+$/, '');
    const pose = { ...SEAT_POSE[name], ...overrides[name] };
    if (!pose.x && !pose.y && !pose.z) return;
    _e.set((pose.x ?? 0) * DEG, (pose.y ?? 0) * DEG, (pose.z ?? 0) * DEG, 'XYZ');
    o.quaternion.multiply(_q.setFromEuler(_e));
  });
  figure.updateMatrixWorld(true);
}
