import type { Bone, Object3D } from 'three';
import civiliansData from '@/config/civiliansData.json';

/**
 * Procedural gait for the civilians that `prepare-civilians.mjs` rigged.
 *
 * The pack came with no animation at all, and an auto-rigged PSX figure would
 * not carry a mocap clip well anyway, so the walk is a few sine waves. That
 * suits the look: a stiff, slightly puppet-like walk is what these figures
 * would have had on the console they are imitating.
 *
 * Every bone's rest rotation is identity and world-aligned (see the prepare
 * script), so the conventions are plain:
 *
 *  - rotation.x **negative** swings a hanging limb **forward** (+Z), positive
 *    back. That holds for thighs, upper arms, and — bent the other way —
 *    shins (positive = foot kicks back) and forearms (negative = hand up).
 *  - rotation.z on an upper arm opens it out (+ on the left, − on the right).
 *  - rotation.x positive on the spine leans the figure forward.
 */

export const CIVILIAN_BONES = civiliansData.bones;
export const CIVILIANS = civiliansData.figures;

export interface CivilianRig {
  bones: Record<string, Bone>;
  /** Rest height of the hips bone, so the bob is relative to it. */
  hipsY: number;
  /** Ground distance one full cycle (two steps) covers, metres. */
  cycleLength: number;
}

export function bindRig(figure: Object3D, hipHeight: number): CivilianRig {
  // GLTFLoader keeps node names unique, so every figure after the first has
  // `hips_1`, `thigh_L_3` and so on: match with the suffix taken off.
  const bones: Record<string, Bone> = {};
  figure.traverse((o) => {
    const name = o.name.replace(/_\d+$/, '');
    if (CIVILIAN_BONES.includes(name) && !bones[name]) bones[name] = o as Bone;
  });
  return {
    bones,
    hipsY: bones.hips.position.y,
    // A walking step is about 0.85 × leg length; a cycle is two of them.
    cycleLength: 2 * 0.85 * hipHeight,
  };
}

export interface Gait {
  /** Cycle phase, radians. Advance it with `advancePhase`. */
  phase: number;
  /** 0 standing, 1 walking. */
  move: number;
  /** 0 walking, 1 running. Only meaningful when `move` is up. */
  run: number;
  /** Seconds, for the idle sway. */
  time: number;
}

/** Steps the phase for a figure covering `speed` m/s over `dt`. */
export function advancePhase(rig: CivilianRig, phase: number, speed: number, dt: number, run: number) {
  // Running takes longer strides, so the legs turn over less than speed alone says.
  const cycle = rig.cycleLength * (1 + 0.6 * run);
  return (phase + (speed * dt / cycle) * Math.PI * 2) % (Math.PI * 2);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function poseRig(rig: CivilianRig, g: Gait) {
  const b = rig.bones;
  const s = Math.sin(g.phase);
  const c = Math.cos(g.phase);
  const m = g.move;
  const r = g.run;

  // Idle: a slow breath and a weight shift, faded out as the figure walks.
  const idle = 1 - m;
  const breath = Math.sin(g.time * 1.7);
  const shift = Math.sin(g.time * 0.45);

  // Legs. Thighs swing opposite; a knee bends while its leg swings through
  // (when that thigh is moving forward), which is the cos term.
  const thigh = lerp(0.42, 0.8, r) * m;
  const knee = lerp(0.9, 1.6, r) * m;
  b.thigh_L.rotation.x = -s * thigh;
  b.thigh_R.rotation.x = s * thigh;
  b.shin_L.rotation.x = 0.08 * m + knee * Math.max(0, c) ** 1.5;
  b.shin_R.rotation.x = 0.08 * m + knee * Math.max(0, -c) ** 1.5;
  // Keep the foot roughly flat through the stride.
  b.foot_L.rotation.x = -0.5 * (b.thigh_L.rotation.x + b.shin_L.rotation.x);
  b.foot_R.rotation.x = -0.5 * (b.thigh_R.rotation.x + b.shin_R.rotation.x);

  // Arms swing against the legs; the A-pose is pulled in so they hang closer.
  const arm = lerp(0.35, 0.75, r) * m;
  const tuck = 0.12 + 0.04 * idle * breath;
  b.upperArm_L.rotation.set(s * arm, 0, -tuck);
  b.upperArm_R.rotation.set(-s * arm, 0, tuck);
  const elbow = -lerp(0.15, 1.5, r * m) - 0.1 * m;
  b.foreArm_L.rotation.x = elbow - Math.max(0, -s) * 0.25 * m;
  b.foreArm_R.rotation.x = elbow - Math.max(0, s) * 0.25 * m;

  // Body: bob (highest as the legs pass), twist and counter-twist, lean into a run.
  const bob = lerp(0.035, 0.07, r) * m;
  b.hips.position.y = rig.hipsY + bob * (Math.abs(c) - 0.6) - 0.012 * r * m;
  b.hips.rotation.set(0, s * 0.1 * m, shift * 0.02 * idle + c * 0.03 * m);
  b.spine.rotation.set(lerp(0.03, 0.2, r) * m + 0.015 * idle * breath, -s * 0.14 * m, -shift * 0.015 * idle);
  b.head.rotation.set(-0.5 * b.spine.rotation.x + 0.02, s * 0.06 * m, 0);
}
