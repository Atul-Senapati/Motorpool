/**
 * NPC traffic tuning. See `physics/trafficAI.ts` for how these are used.
 *
 * Distances are metres, speeds m/s, angles radians.
 *
 * Every distance here is a *world* distance and therefore tied to the city's
 * UNIT_SCALE in `scripts/prepare-map.mjs`. When that changed from 160 to 100 all
 * of them were scaled by 0.625 to match; `laneGain` went the other way, being
 * radians per metre of error. Speeds, accelerations, angles and times are real
 * properties of a car and did not move.
 */
export const TRAFFIC = {
  /**
   * Cars per vehicle type. 20 types x 2 = 40 on the road at once, which fills a
   * city block's worth of view without the spawn ring visibly churning.
   */
  perType: 2,

  // --- steering ------------------------------------------------------------
  /** How far ahead the road probe looks. */
  probeMax: 16,
  /** Probe granularity, about half a raster pixel. Finer than the turn penalty
   *  below, so quantisation can never outweigh the cost of turning. */
  probeStep: 1,
  /**
   * Candidate heading offsets, in radians. Symmetric, straight-on included.
   *
   * This has to reach past 60 deg. A junction turn is most of a right angle, and
   * a fan that stops at 35 deg simply cannot see the road it is supposed to turn
   * into — the car drives straight across the junction and off the tarmac.
   */
  fan: [
    -1.05, -0.79, -0.59, -0.42, -0.26, -0.13, 0, 0.13, 0.26, 0.42, 0.59, 0.79, 1.05,
  ] as const,
  /**
   * Metres of "reach" a radian of turning has to be worth before it is taken.
   *
   * This is a *route* choice only. It must not be used to buy smoothness: at 24
   * a 60 deg turn cost 25 m of credit, more than the probe can ever see, so cars
   * refused every junction and left the road. Smoothness is `steerSmoothing`
   * and the cornering budget below, which is where it belongs.
   */
  turnPenalty: 6,
  /**
   * Metres from the right-hand kerb the car aims to sit — an upper bound only.
   *
   * The actual aim is a quarter of the measured corridor width, so each stream
   * sits in the middle of its own half. A fixed 3.2 m put both streams within
   * 1.6 m of each other on an 8 m street — inside the obstacle cone below — so
   * oncoming cars saw each other, both braked to a stop and deadlocked. Streets
   * that narrow are over half the city.
   */
  laneOffset: 2,
  /** Never hug the kerb closer than this, however narrow the street. */
  laneOffsetMin: 1,
  /**
   * Where in the street to sit, as a fraction of the measured corridor width.
   *
   * A quarter is the middle of the car's own half, which is where it belongs.
   * A third was measured as an alternative, on the theory that it would keep more
   * room from the kerb: it bought nothing on speed and more than doubled the
   * steering direction changes, so a quarter it is.
   */
  laneFraction: 1 / 4,
  /** Radians of heading correction per metre of lane error. */
  laneGain: 0.14,
  /** Lane error below this is ignored. The raster is 2 m per pixel, so anything
   *  under about a pixel is measurement noise, and chasing it made cars hunt. */
  laneDeadband: 0.75,
  /**
   * Hard cap on the lane term. Generous on purpose: at 0.12 rad (7 deg) a car
   * drifting at a kerb could not steer away from it, so it drove into the kerb,
   * had its step refused, stopped dead and was eventually recycled. The deadband
   * above is what suppresses noise; this only needs to stop a *swerve*.
   */
  laneClamp: 0.45,
  /** Granularity of the sideways kerb probe, metres. */
  kerbStep: 0.25,
  /**
   * Kerb this close, in metres, is an emergency: turn away firmly and ignore the
   * deadband. Without it the only thing keeping a car on the road was refusing
   * to move, which is a stall, not steering.
   *
   * **Must stay above `kerbStep`**, or the threshold is unreachable and this is
   * silently dead code — which is exactly what happened when the city was
   * rescaled: the probe could never report closer than 0.5 m and the threshold
   * was 0.5, so no car ever noticed a kerb and they all drove into them.
   */
  kerbPanic: 1.2,
  /**
   * Radians of turn-away when a kerb is inside `kerbPanic`.
   *
   * Measured, not guessed: 0.45 and 0.20 both cost roughly a metre per second of
   * average speed — the first because a hard turn-away trips the corner-speed
   * limit, the second because a timid one lets cars reach the kerb and stall.
   */
  kerbPanicTurn: 0.3,
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
  /**
   * Floor for the corner-speed limit, m/s. A car slows until the turn it is
   * asking for fits `lateralAccel`, but must still creep through a hairpin
   * rather than stopping dead in the junction.
   */
  turnSpeedMin: 4,
  /** Metres of road a car keeps in hand beyond its braking distance. */
  sightMargin: 3,
  /** Start slowing for something this far ahead. */
  followDistance: 10,
  /** Be stopped by the time it is this close. */
  stopDistance: 3.5,
  /** Half-width of the "my lane" test for obstacles. */
  laneHalfWidth: 1.4,

  // --- population ----------------------------------------------------------
  /** Spawn ring around the player. Beyond `probeMax` so cars are not born in view. */
  spawnMin: 44,
  spawnMax: 119,
  /** Recycled past this. Comfortably beyond the fog, so there is no pop-out. */
  despawn: 163,
  /** Minimum gap to an existing car when spawning. */
  spawnClearance: 7.5,
  /** Cap per frame so a long drive never stalls on one big refill. */
  spawnsPerFrame: 2,

  // --- staying on the road -------------------------------------------------
  /**
   * Seconds a car may be off the tarmac before it is recycled.
   *
   * There must be a hard limit, not just a steering preference. Off the raster
   * every probe reads zero, so the scorer sees no reason to prefer any heading
   * and the car drives dead straight for ever — through buildings, over cliffs,
   * off the map. That is a failure to recover, not a failure to steer.
   */
  offRoadGrace: 2.5,
  /**
   * Seconds a car may sit still with nothing in front of it before it is
   * recycled. Refusing a step that would leave the tarmac means a car facing a
   * dead end can stop and, with a fan only 60 deg wide, never turn far enough to
   * escape. Queuing behind traffic is excluded, so this never eats a car that is
   * legitimately waiting.
   */
  stuckGrace: 4,
  /** How far to look for a way back when a car strays. */
  recoverSearch: 38,
  /** Speed while recovering, m/s. Slow enough to turn sharply. */
  recoverSpeed: 4,
  /**
   * Largest single-step rise the ground may take, metres, before it is read as
   * a wall rather than a slope. Stops cars climbing kerbs onto raised decks and
   * appearing to jump off buildings.
   */
  maxClimb: 1,

  /**
   * Getting hit.
   *
   * Traffic is dynamic but driven by the AI, which teleports each body into
   * place with its velocity every step (see `Traffic.tsx`). On a hard enough
   * contact from the player the AI lets go, and the car is shoved, spun and
   * rolled by the impact the solver has already worked out. It is left where
   * it comes to rest and recycled once the player has driven away.
   */
  impact: {
    /**
     * Closing speed, m/s (~14 km/h), below which a car is being leaned on in
     * traffic rather than struck. Wrecking anything below this would make the
     * city fall apart around a careful driver.
     *
     * The gate is on speed rather than on contact force because force scales
     * with the mass doing the hitting: measured in the city, a solid shunt
     * reports 2-9 MN, and any fixed newton figure that a 1,140 kg McLaren has
     * to work for is one a four-tonne SUV exceeds at a crawl.
     */
    speed: 4,
    /**
     * Contact force floor, newtons. Nothing to do with how hard a hit is —
     * this only discards the constant light contact of a car resting on the
     * road, so the speed test above is all that decides a wreck.
     */
    force: 40_000,
  },
} as const;
