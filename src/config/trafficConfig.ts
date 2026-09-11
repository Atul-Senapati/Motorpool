/**
 * NPC traffic tuning. See `physics/trafficAI.ts` for how these are used and
 * `physics/roadGraph.ts` for the network the cars drive on.
 *
 * Distances are metres, speeds m/s, angles radians, times seconds.
 *
 * The first traffic model steered off the nav raster directly and most of its
 * constants were about suppressing the noise that produced — deadbands, yaw
 * filters, kerb-panic angles. Cars now follow lanes on a road graph, so those
 * are gone: a car is parallel to the kerb because the lane is. What is left is
 * what a driver actually decides — how fast, how close, who goes first.
 */
export const TRAFFIC = {
  /**
   * Cars per vehicle type. 20 types x 2 = 40 slots, which is the ceiling the
   * density setting works under; MEDIUM is 60% of it.
   */
  perType: 2,

  /**
   * Which side of the road to drive on. One switch, read in exactly one place
   * (`roadGraph.laneAt`), so the city can be made left-hand by flipping it —
   * priority at junctions flips with it (see `trafficAI`).
   */
  driveOnRight: true,

  // --- the lane -----------------------------------------------------------
  /**
   * Lane centre's offset from the centreline: a quarter of the width, clamped.
   * The upper clamp has to let a boulevard's lane clear its median — a 24 m
   * dual carriageway with a 1.5 m island down the middle wants the car well
   * out, and at 3.4 it drove along the kerb of the island. Not further than
   * this, though: a street the skeleton measured wide because a car park
   * opens off one side of it is only as wide as the street on the other.
   */
  laneOffsetMin: 1.6,
  laneOffsetMax: 4.5,
  /**
   * Endpoints this close to another street are joined to it when the island's
   * streets are turned into a graph. The town's cross streets are drawn to
   * stop three metres past the ring's centreline, so this has to exceed that.
   */
  graphSnap: 6,
  /** Two junctions closer than this along a stub are one junction. */
  clusterLength: 16,

  // --- speed --------------------------------------------------------------
  /** Cruise caps by road class, m/s. 14 is 50 km/h. */
  speed: { boulevard: 14, street: 11, lane: 8, town: 9 },
  /** Personal variation around the cap: a car cruises at cap x [min, max]. */
  cruiseVary: [0.85, 1.05] as const,
  accel: 2.8,
  brake: 6.5,
  /** Hard stop when something appears inside the stopping distance. */
  brakeHard: 9,
  /** Cornering budget, m/s^2: sets the speed through a bend of a given radius. */
  lateralAccel: 3.2,
  /** Speed through a junction turn, m/s, by how sharp the turn is. */
  turnSpeed: { gentle: 9, normal: 5.5, sharp: 3.5 },
  /** Never slower than this while moving through a bend. */
  crawl: 2.5,

  // --- spacing ------------------------------------------------------------
  /** Standing gap bumper to bumper. */
  gapStopped: 2.5,
  /** Plus this many seconds of travel at the current speed. */
  headway: 1.4,
  /** How far ahead a car looks for the one in front, along its own lane. */
  lookAhead: 45,
  /** Half-width of "in my lane" for things that are not on the graph. */
  laneHalfWidth: 1.7,
  /** Hold back this far from something moving slower ahead; close at low speed. */
  closingMargin: 1.5,
  /** How far the off-graph check for cars on adjacent lanes looks. */
  eyesRange: 14,

  // --- junctions ----------------------------------------------------------
  /**
   * Distance from the node at which a car starts thinking about the junction:
   * looks at who else is coming, slows for the turn.
   */
  approach: 22,
  /** Where the stop line is, back from the node. */
  stopLine: 6,
  /** A car this far out of the node along its exit is still IN the junction. */
  inside: 8,
  /**
   * Priority: give way to traffic from the driving side's opposite — from the
   * right when driving on the right — and to anything already in the box.
   * A car that has waited longer than this goes anyway: two cars that each
   * think the other has priority would otherwise sit there for ever.
   */
  patience: 3,
  /** Cars approaching from the priority side within this many seconds are yielded to. */
  arrivalWindow: 1.5,
  /**
   * Blend from one lane into the next over this many metres after a node.
   * Lanes on different streets meet at different points around the node (each
   * is offset to its own driving side), so a car changing streets has to be
   * carried across the difference rather than jump it.
   */
  blend: 10,
  /** Prefer to carry straight on: weight for exits within 30 degrees. */
  straightBias: 3,

  // --- population ---------------------------------------------------------
  /** Spawn ring around the player. Beyond the fog's near edge so cars are not born in view. */
  spawnMin: 55,
  spawnMax: 130,
  /** Recycled past this. */
  despawn: 175,
  /** Minimum lane distance to any car already on the lane when spawning. */
  spawnClearance: 14,
  /** Cap per frame so a long drive never stalls on one big refill. */
  spawnsPerFrame: 2,
  /**
   * A car that has not moved with nothing in front of it for this long is
   * wedged on something the graph does not know about. Recycled.
   */
  stuckGrace: 6,

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
