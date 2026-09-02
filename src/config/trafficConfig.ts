/**
 * NPC traffic tuning. See `physics/trafficAI.ts` for how these are used.
 *
 * Distances are metres, speeds m/s, angles radians.
 */
export const TRAFFIC = {
  /**
   * Cars per vehicle type. 20 types x 2 = 40 on the road at once, which fills a
   * city block's worth of view without the spawn ring visibly churning.
   */
  perType: 2,

  // --- steering ------------------------------------------------------------
  /** How far ahead the road probe looks. */
  probeMax: 26,
  /** Probe granularity. Finer than the turn penalty below, so quantisation in
   *  the reach measurement can never outweigh the cost of turning. */
  probeStep: 1.5,
  /** Candidate heading offsets, in radians. Symmetric, straight-on included. */
  fan: [-0.62, -0.42, -0.26, -0.13, 0, 0.13, 0.26, 0.42, 0.62] as const,
  /**
   * Metres of "reach" a radian of turning has to be worth before it is taken.
   * Too low and cars weave across open junctions chasing a marginally longer
   * diagonal; too high and they drive into kerbs rather than follow a bend.
   */
  turnPenalty: 24,
  /** Metres from the right-hand kerb the car aims to sit. */
  laneOffset: 3.2,
  /** Radians of heading correction per metre of lane error. */
  laneGain: 0.05,
  /** Lane error below this is ignored — the raster is only 3 m per pixel, and
   *  chasing sub-pixel noise is what made cars hunt around their lane. */
  laneDeadband: 0.9,
  /** Hard cap on the lane term, so it trims rather than swerves. */
  laneClamp: 0.12,
  /** Absolute yaw ceiling, rad/s — only reached at very low speed. */
  turnRate: 1.1,
  /**
   * Cornering budget, m/s^2. The real yaw limit is this divided by speed, so a
   * car at 12 m/s turns far more gently than one crawling. A flat cap let fast
   * cars pivot on the spot, which read as twitching.
   */
  lateralAccel: 4.5,
  /** Seconds to null a heading error. Larger is lazier and smoother. */
  steerResponse: 0.55,
  /** Half-life of the yaw-rate filter, seconds. This is what kills the wiggle. */
  steerSmoothing: 0.18,

  // --- speed ---------------------------------------------------------------
  /** Cruise speed range, m/s (≈29–47 km/h). */
  cruiseMin: 8,
  cruiseMax: 13,
  accel: 3.2,
  brake: 7.5,
  /** Start slowing for something this far ahead. */
  followDistance: 22,
  /** Be stopped by the time it is this close. */
  stopDistance: 6.5,
  /** Half-width of the "my lane" test for obstacles. */
  laneHalfWidth: 2.2,

  // --- population ----------------------------------------------------------
  /** Spawn ring around the player. Beyond `probeMax` so cars are not born in view. */
  spawnMin: 70,
  spawnMax: 190,
  /** Recycled past this. Comfortably beyond the 780 m fog, no pop-out. */
  despawn: 260,
  /** Minimum gap to an existing car when spawning. */
  spawnClearance: 12,
  /** Cap per frame so a long drive never stalls on one big refill. */
  spawnsPerFrame: 2,
} as const;
