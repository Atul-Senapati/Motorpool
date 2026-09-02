/**
 * Procedural circuit definition.
 *
 * The centreline is a closed radial curve r(theta) built from three harmonics.
 * Because r stays strictly positive the curve is star-shaped about the origin,
 * which guarantees it never self-intersects — something hand-placed control
 * points cannot promise. Varying the harmonics gives a mix of long sweepers,
 * tighter corners and a couple of near-straights, i.e. a circuit worth driving.
 */

export const TRACK = {
  /** Base radius, metres. */
  radius: 210,
  /**
   * [amplitude, frequency, phase] per harmonic. Amplitudes sum to 0.52, so
   * r stays in [105, 266] m and the curve cannot fold through itself.
   * Tuned for a 1.44 km lap whose tightest corner is an 18 m hairpin (~50 km/h)
   * and whose fastest is a 266 m sweeper — i.e. real braking zones.
   */
  harmonics: [
    [0.2, 1, 0.4],
    [0.13, 2, 1.7],
    [0.12, 3, 3.1],
    [0.07, 5, 0.9],
  ] as const,
  /** Half the drivable width. */
  halfWidth: 7,
  /** Curb width, outside the drivable surface. */
  curbWidth: 1.1,
  /** Distance from centreline to the barrier wall. */
  barrierOffset: 13,
  barrierHeight: 1.05,
  /** Samples around the lap. Also the resolution of the road collider. */
  segments: 720,
  /** Grass sits slightly below the asphalt so leaving the track is felt. */
  grassDrop: 0.06,
  /** Curbs are only laid where the corner is tighter than this radius. */
  curbCurvatureRadius: 150,
} as const;

const TAU = Math.PI * 2;

/** Centreline radius at angle theta. */
export function trackRadius(theta: number): number {
  let r = 1;
  for (const [amplitude, frequency, phase] of TRACK.harmonics) {
    r += amplitude * Math.sin(frequency * theta + phase);
  }
  return TRACK.radius * r;
}

/** Centreline point on the ground plane. */
export function trackPoint(theta: number, out: [number, number] = [0, 0]): [number, number] {
  const r = trackRadius(theta);
  out[0] = r * Math.cos(theta);
  out[1] = r * Math.sin(theta);
  return out;
}

/**
 * Unit tangent, from the analytic derivative of the polar curve:
 *   dx/dtheta = r' cos(theta) - r sin(theta)
 *   dz/dtheta = r' sin(theta) + r cos(theta)
 */
export function trackTangent(theta: number, out: [number, number] = [0, 0]): [number, number] {
  const r = trackRadius(theta);
  let dr = 0;
  for (const [amplitude, frequency, phase] of TRACK.harmonics) {
    dr += amplitude * frequency * Math.cos(frequency * theta + phase);
  }
  dr *= TRACK.radius;

  const dx = dr * Math.cos(theta) - r * Math.sin(theta);
  const dz = dr * Math.sin(theta) + r * Math.cos(theta);
  const length = Math.hypot(dx, dz) || 1;
  out[0] = dx / length;
  out[1] = dz / length;
  return out;
}

/**
 * Outward normal — points away from the circuit's interior.
 *
 * For this curve theta increases counter-clockwise, so rotating the tangent by
 * -90 degrees is what faces outward: (tz, -tx). The opposite convention points
 * into the infield, which silently inverts every ribbon's winding (the road ends
 * up single-sided facing DOWN, i.e. invisible) and puts the grandstands inside
 * the track.
 */
export function trackNormal(theta: number, out: [number, number] = [0, 0]): [number, number] {
  const [tx, tz] = trackTangent(theta);
  out[0] = tz;
  out[1] = -tx;
  return out;
}

/** Approximate lap length, by sampling. */
export function trackLength(samples = 720): number {
  let total = 0;
  const previous = trackPoint(0);
  let px = previous[0];
  let pz = previous[1];
  for (let i = 1; i <= samples; i++) {
    const [x, z] = trackPoint((i / samples) * TAU);
    total += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return total;
}

/**
 * Radius of curvature at theta, by finite difference on the tangent angle.
 * Used to decide where curbs belong.
 */
export function curvatureRadius(theta: number): number {
  const h = 1e-3;
  const [ax, az] = trackTangent(theta - h);
  const [bx, bz] = trackTangent(theta + h);
  const angle = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
  const [px, pz] = trackPoint(theta - h);
  const [qx, qz] = trackPoint(theta + h);
  const arc = Math.hypot(qx - px, qz - pz);
  return angle < 1e-6 ? Infinity : arc / angle;
}

/**
 * Grid slot: on the centreline at theta = 0, facing along the direction of travel.
 * The car model faces -Z, so a heading h maps forward to (-sin h, 0, -cos h);
 * solving that against the tangent gives the expression below.
 */
export function trackSpawn() {
  const [x, z] = trackPoint(0);
  const [tx, tz] = trackTangent(0);
  return {
    position: [x, 0.6, z] as [number, number, number],
    heading: Math.atan2(-tx, -tz),
  };
}
