/**
 * The town around the island station.
 *
 * The bigger island carries a four-road station, a transplanted block and a
 * road bridge to the city, and around all that it had 200 m of empty grass on
 * each side of the railway. This lays a town on it: a ring of streets with
 * footways on each side of the railway, a station forecourt, a car park, a
 * waterfront park, a level crossing where the town's link road meets the
 * railway, and rows of the city's own buildings along them, with the city's
 * trees, street furniture and parked cars scattered between.
 *
 * ## Everything is in the station's frame
 *
 * Same discipline as `stationConfig` and `villageConfig`: nothing here is a
 * world coordinate. `along` is metres up the line from the station's midpoint
 * and `across` is metres to its left, and `IslandTown` renders the whole town
 * inside ONE group at the station's centre turned to the line's heading — in
 * which local +Z is `along` and local +X is `across`. Redraw the sketch or
 * regenerate the route and the town moves with the station.
 *
 * Sign convention, worth stating because every number below depends on it:
 * **+across is the platform side** (which happens to be north), and **−across
 * is the side the road bridge lands on** (south), where the station's own
 * transplanted block already stands.
 *
 * ## No street ends in a field
 *
 * The first version was a grid of straight streets whose ends simply stopped:
 * two through streets that ran out at ±250, a back lane 60 m shorter than the
 * street beside it, cross streets that overshot into the grass, and a shore
 * street whose west end was 100 m past anything it connected to. Driven, that
 * reads as a film set — every route out of the town is a three-point turn.
 *
 * So the layout is now **two rings and a spine**, and the rule it is built to
 * is that every street's two ends are junctions with other streets:
 *
 * ```
 *   north ring   station-road (across 66) + back-lane (134), tied by cross
 *                streets at along -250, -112, -4, 108, 200, and closed round
 *                the east end by east-avenue (104) between along 200 and 264
 *   south ring   shore-street (-100) + quay-street (-152), tied by cross
 *                streets at along -130, 40 and 200
 *   the spine    the bridge approach (from the causeway at across -186 to the
 *                shore street) and the crossing link (from the shore street,
 *                over the railway at along 255, to the station road)
 * ```
 *
 * The two rings are joined only at the level crossing, which is what gives the
 * crossing something to be, and the whole thing is joined to the city only by
 * the causeway — so a car can leave the city, cross the bridge, drive every
 * street on the island and come back without ever reversing.
 *
 * That claim was checked rather than asserted, and it is worth knowing how, in
 * case a street is ever moved: `townNav` rasterises exactly these streets for
 * the traffic, so flood-filling its driveable cells answers "is this network
 * connected" directly. It comes back as ONE component of 23,100 m², causeway
 * included — a second component would mean a street that only looks joined.
 *
 * ## What the land allows
 *
 * Measured off the grown outline (`ISLAND_GROWTH`) in the station's own frame,
 * metres of island either side of the line before the beach:
 *
 * ```
 *  along   -250  -200  -150   -100    -50      0    +50   +100   +150   +200   +250
 *  +across  241   250   247    242    239    224    214    200    183    166    139
 *  -across  109   140   152    178    189    194    199    196    186    176    141
 * ```
 *
 * Every street below has both its footways inside that envelope with metres to
 * spare, which is why the north ring closes early (the island narrows to 123 m
 * on the platform side by along 264) and why the quay street stops at along
 * 200. There is a further 26 m of beach outside the outline, so the margin is
 * larger than it looks — but a street on the beach reads as a mistake.
 *
 * ## What is already there, and must be built around
 *
 * - The station's four roads and two platforms, `across` 0 to 31, tapering out
 *   to nothing by `along` ±237.
 * - The station's own transplanted block (`TOWN` in `stationConfig`), `across`
 *   −5 to −74, `along` ±143.
 * - The causeway from the city, which lands on the island crown at across
 *   −187, along +7 (measured, not chosen — see `BRIDGE_APPROACH`).
 */
import { BRIDGE, STATION_SITE, stationTracks } from './stationConfig';
import { TRAIN, TRAIN_ISLANDS, TRAIN_LENGTH, trainPointAt } from './trainConfig';

/** Where the town is, and which way it faces. Null when there is no station. */
export const TOWN_SITE = STATION_SITE ? {
  centre: STATION_SITE.centre,
  heading: STATION_SITE.heading,
  ground: STATION_SITE.ground,
} : null;

export const TOWN_ENABLED = TOWN_SITE !== null;

/**
 * A straight street.
 *
 * `axis` is which of the two frame coordinates it runs along; `at` is the other
 * one, at the carriageway's centreline. Footways are outside the carriageway on
 * both sides unless `footway` says otherwise — a road with no pavement is a
 * road in a field, and it is the pavement more than the tarmac that makes a
 * street read as a street.
 */
export interface Street {
  name: string;
  axis: 'along' | 'across';
  at: number;
  from: number;
  to: number;
  /** Carriageway width, kerb to kerb. */
  width: number;
  /** Footway width each side; 0 for none. */
  footway: number;
  /** Dashed centre line down the middle. Off for the narrow lanes. */
  centreLine?: boolean;
  /**
   * Cars park at this street's kerbs, so the middle is all that is driveable.
   *
   * It is not decoration: `scatterPoints` stands parked cars a metre and a half
   * off the kerb on any street with a wide footway, and those cars have no
   * colliders (`ParkedCars`) — they are instanced bodies. If the nav patch
   * called the full carriageway driveable, NPC traffic would drive straight
   * through a parked car every time. `townNav` narrows the driveable strip by
   * `PARKING_STRIP` on each side of these instead, which is also simply true:
   * a street with both kerbs parked up is two lanes wide, not four.
   */
  parking?: boolean;
}

/** Carriageway widths: a two-lane street and a lane. */
const STREET = 12;
const LANE = 9;
/**
 * Footway widths.
 *
 * Both went up by half again — 3.2 to 5 on the through streets and 2.6 to 3.6
 * on the lanes. A 3.2 m footway is correct for a back street and too mean for
 * the one road past a station: it is the surface the lamps, the trees, the
 * benches and the bins all stand on, and at 3.2 m a lamp column and a street
 * tree between them left nothing to walk on, so the town read as a road with
 * kerbs rather than as streets. At 5 m the furniture sits in the outer half and
 * the inner half is clear, which is what a station approach looks like.
 */
const FOOTWAY = 5;
const LANE_FOOTWAY = 3.6;

/**
 * Surface heights above the island crown, shared by what DRAWS the town and
 * what the traffic DRIVES on.
 *
 * `IslandTown` lays every carriageway as a 6 cm slab and every footway as a
 * 20 cm one, and `townNav` has to report the same heights to the NPC steering
 * or the cars sit in the road rather than on it. Two copies of 0.06 in two
 * files is exactly the sort of number that drifts, so it lives here.
 */
export const SURFACE = { road: 0.06, footway: 0.2 } as const;

/**
 * The town's palette, taken off the city rather than chosen.
 *
 * The island used to be painted in colours picked to look right on their own,
 * and next to the mainland they did not: a brighter, greener grass and a
 * bluer-grey tarmac, so the island read as a different place built by someone
 * else. These are measured instead — every triangle of the city's own ground
 * and street shells sampled at its UV centroid and averaged by area, which is
 * the colour those surfaces actually show:
 *
 * ```
 *   city verges and hills (Auxiliar)   #4b6020
 *   city parkland (MaterialPiso)       #285230
 *   city blocks' grass                 #445930
 *   city carriageways (Street)         #675b52
 * ```
 *
 * The grass here is the middle of those three greens and the tarmac is the
 * street figure, so the island's ground and roads are the mainland's.
 */
export const TOWN_PALETTE = {
  grass: '#4a5c2c',
  tarmac: '#6b6058',
  paving: '#8b867b',
  kerb: '#a8a49a',
  mark: '#e8e4d2',
} as const;

/** How much of each kerb of a `parking` street is taken up by parked cars. */
export const PARKING_STRIP = 2.4;

/**
 * Where the level crossing sits — and why it is at the EAST end.
 *
 * It has to clear the station throat, which ends at ±237, so it is one end or
 * the other. It was at −265, and it was wrong: **this frame is a straight line
 * and the railway is not.** `stationPoint` projects `along` down the tangent at
 * the station's midpoint, and the line is dead straight from −100 all the way
 * past +320, but west of −100 it curves away — 14.8 m of drift at −200 and
 * **32.6 m at −265**. A crossing laid in the frame at −265 therefore crossed
 * open grass with the railway passing 33 m to one side: not on the main line at
 * all, which is exactly what it looked like.
 *
 * At +255 the drift is zero, so the frame is the alignment and a deck laid in
 * frame coordinates sits on the rails by construction. Anything else that must
 * touch the railway far from the middle has the same problem — see `FENCE`,
 * which is built on the true alignment instead.
 */
const CROSSING_ALONG = 255;

/**
 * The deck at rail level, and the ramps that climb to it from the crown.
 *
 * The deck's edges are **derived from what is under it**. They were -9 and 14,
 * written down when the crossing spanned two tracks; it spans four here (see
 * `stationTracks`), and a hardcoded edge cannot know that. Now it reaches an
 * apron clear of the outermost rail on each side, so every track is crossed by
 * road rather than petering out into ballast a metre past the last panel — and
 * the two literals survive as a *floor*, so the crossing can only ever get
 * longer than it was, never shorter.
 */
const CROSSING_APRON = 6;
const CROSSING_RAILS = stationTracks(CROSSING_ALONG);
const CROSSING_DECK_S = Math.min(
  -9, CROSSING_RAILS[0] - TRAIN.gauge / 2 - CROSSING_APRON,
);
const CROSSING_DECK_N = Math.max(
  14, CROSSING_RAILS[CROSSING_RAILS.length - 1] + TRAIN.gauge / 2 + CROSSING_APRON,
);
/**
 * How far each approach takes to climb from the crown to the deck.
 *
 * 16 m for the metre the rail head stands above the island is 1 in 16, which is
 * a road gradient rather than a kerb — it was 14, and 14 was chosen when
 * nothing had to drive up it. See `crossingHeight`, which is the same climb the
 * car's wheels actually stand on.
 */
const CROSSING_RAMP = 16;
const CROSSING_RAMP_S = CROSSING_DECK_S - CROSSING_RAMP;
const CROSSING_RAMP_N = CROSSING_DECK_N + CROSSING_RAMP;

/**
 * Where the causeway lands, in the town's own frame.
 *
 * Measured off `BRIDGE` rather than stated, because the bridge's island end is
 * itself measured — a ray walked south out of the island until it leaves the
 * outline — so the number moves if the island is ever grown again. This is the
 * projection `stationPoint` inverts: `across` is the component along the
 * station's normal, `along` the component along its tangent.
 *
 * The causeway runs down world Z and the frame's `across` axis is 2.5° off
 * that, so the approach street (laid on the frame, like everything else here)
 * and the causeway's centreline diverge by about 2.4 m over the 90 m of
 * approach. That is inside the causeway's own 13 m width, so the two still meet
 * squarely; a street bent to follow it exactly would be 90 m of special case
 * for a discrepancy narrower than a lane.
 */
const BRIDGE_APPROACH = (() => {
  const site = STATION_SITE;
  if (!site || !BRIDGE) return null;
  const [cx, , cz] = site.centre;
  const [tx, tz] = site.tangent;
  const [nx, nz] = site.normal;
  const dx = BRIDGE.x - cx;
  const dz = BRIDGE.islandZ - cz;
  return { across: dx * nx + dz * nz, along: dx * tx + dz * tz };
})();

/** The along at which the bridge approach crosses the town, and its shore end. */
const APPROACH_ALONG = BRIDGE_APPROACH ? BRIDGE_APPROACH.along : 7;
const APPROACH_FROM = BRIDGE_APPROACH ? BRIDGE_APPROACH.across + 1 : -186;

/* ------------------------------------------------------------- the ring road */

/**
 * The coast road: one continuous lap of the island.
 *
 * The grid streets are a town and the two rings inside it are a couple of
 * blocks long; what the island did not have is a *drive* — somewhere to open a
 * car up and keep going without arriving at a junction every ninety metres.
 * This is that road, and the shape of it is not designed: it is the island's
 * own shoreline, walked inward.
 *
 * ## Measured off the outline, not drawn
 *
 * Each vertex of the traced outline is moved inward along its own corner
 * normal, the result is smoothed and then resampled at a fixed pitch. Two
 * consequences worth stating. The ring follows the coast, so from the car it
 * reads as a coast road rather than as a circuit painted on a field. And it
 * moves with the island: grow `ISLAND_GROWTH` again and the road grows with it,
 * the same property the bridge's island end has and for the same reason.
 *
 * The smoothing matters more than it sounds. A traced outline has a metre of
 * wobble in it, and a road that reproduces that wobble is one the NPC steering
 * fights all the way round — it reads every wiggle as a corner and slows for
 * it. It is also what sets the tightest corner on the lap, and that was
 * measured rather than eyeballed: over 8 m samples, 12 passes of a [1,2,1]
 * kernel leave an 18 m radius at the headlands (a hairpin), 24 passes 26 m, and
 * 60 passes 46 m — a corner a car can hold at speed. Sixty passes cost 25 m of
 * the 1,617 m lap, which is the whole price of it.
 *
 * ## It does NOT cross the railway — it is cut where it would
 *
 * The railway runs the length of the island and out to sea at both ends, so a
 * full lap of the shore has to cross it twice, and the first version did:
 * it humped up to rail level wherever it came near the line. The places it
 * chose were the two tips, at along −314 and +315 — and the ballast ends at
 * ±312. **Both crossings were on the viaduct approach**, where the line is
 * already up on a deck and where no railway would ever put a level crossing.
 *
 * So the ring is CUT wherever it comes within `RING.railClear` of the line,
 * which leaves two open shore roads, and each of them is tied into the grid at
 * both ends (`RING_TIES`). Crossing between the two halves of the island is
 * then what it should always have been: the worked level crossing at along
 * +255, with its deck panels, its barriers and its lights. The loop is still
 * endless — the north shore road and the station road make one circuit, the
 * south shore road and the shore street another, and the level crossing joins
 * the two into a figure of eight — but every metre of it is on a road that
 * would exist.
 *
 * The cut is a rule rather than a pair of numbers, which matters because the
 * island has already been regrown once: move the shore or the line and the
 * ring still stops clear of the rails.
 */
export const RING = {
  /** How far inside the drawn outline the road's centreline runs. */
  inset: 16,
  /** Sample pitch along the ring, metres. */
  pitch: 8,
  /** Smoothing passes over the offset outline. */
  smoothing: 60,
  /** Carriageway width, kerb to kerb, and the verge outside each kerb. */
  width: 11,
  verge: 3,
  /**
   * The ring is cut where it comes this close to the running line.
   *
   * Generous — the width of the formation, its ballast shoulder and a verge —
   * because what is being avoided is not a collision but a road that arrives
   * at a railway with nowhere to go.
   */
  railClear: 45,
} as const;

/**
 * Where the grid meets the ring, per side, as `along` values.
 *
 * These are the junctions the cross streets make on their way out to the shore
 * road — and they are also what decides how much of the ring survives the cut:
 * a chain is clipped to the range its own ties span, so it always ends AT a
 * junction rather than in the grass a hundred metres past one. The last tie on
 * each side is the level crossing's link road, which is the whole point of the
 * layout: follow the shore road to its end and you are at the crossing.
 */
const RING_TIES = {
  north: [-250, -112, -4, 108, 200, CROSSING_ALONG],
  south: [-130, 40, 200, CROSSING_ALONG],
} as const;

/** The host island: the one the station is on, which is the biggest by area. */
const RING_HOST = (() => {
  const area = (outline: ReadonlyArray<readonly [number, number]>) => {
    let sum = 0;
    for (let i = 0; i < outline.length; i++) {
      const [x, z] = outline[i];
      const [nx, nz] = outline[(i + 1) % outline.length];
      sum += x * nz - nx * z;
    }
    return Math.abs(sum / 2);
  };
  return TRAIN_ISLANDS.length
    ? [...TRAIN_ISLANDS].sort((a, b) => area(b.outline) - area(a.outline))[0]
    : null;
})();

/**
 * No street but the level crossing comes closer than this to a running rail.
 *
 * Measured to the street's KERB, not its centreline, which is the correction
 * that mattered: the station road run out to the ring stopped with its centre
 * 17 m from the line and its nearside kerb six.
 */
const RAIL_CLEAR = 14;

/**
 * The running line through the island, in the town's frame.
 *
 * Sampled off the route rather than assumed to be `across 0`, which it only is
 * near the station's midpoint: this frame is straight and the railway is not.
 */
const RAIL_IN_FRAME: ReadonlyArray<[number, number]> = (() => {
  const site = STATION_SITE;
  if (!site) return [];
  const [cx, , cz] = site.centre;
  const [tx, tz] = site.tangent;
  const [nx, nz] = site.normal;
  const out: Array<[number, number]> = [];
  for (let d = -420; d <= 420; d += 3) {
    const arc = ((site.arc + d) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
    const [x, , z] = trainPointAt(arc);
    const dx = x - cx;
    const dz = z - cz;
    out.push([dx * nx + dz * nz, dx * tx + dz * tz]);
  }
  return out;
})();

/** Metres from a frame point to the nearest running rail. */
export function railGap(across: number, along: number): number {
  let best = Infinity;
  for (const [a, l] of RAIL_IN_FRAME) {
    const d = Math.hypot(a - across, l - along);
    if (d < best) best = d;
  }
  return best;
}

/** A point in the town's frame: `[across, along]`. */
export type FramePoint = readonly [number, number];

/**
 * The ring's centreline, in frame coordinates, as a closed polyline.
 *
 * Closed means the last point joins the first; nothing repeats the first point
 * at the end, so a consumer that wants a closed sweep has to wrap the index —
 * which is also what stops the join showing as a seam in the smoothing.
 */
export const RING_PATH: ReadonlyArray<FramePoint> = (() => {
  const site = STATION_SITE;
  const host = RING_HOST;
  if (!site || !host) return [];
  const [cx, , cz] = site.centre;
  const [tx, tz] = site.tangent;
  const [nx, nz] = site.normal;
  /** World to frame; the inverse of `stationPoint`. */
  const toFrame = ([x, z]: readonly [number, number]): [number, number] => {
    const dx = x - cx;
    const dz = z - cz;
    return [dx * nx + dz * nz, dx * tx + dz * tz];
  };

  const outline = host.outline.map(toFrame);
  const n = outline.length;
  if (n < 8) return [];

  // Which way round the outline is wound, so "inward" is not a guess: a
  // positive shoelace sum in this frame means the left-hand normal points in.
  let shoelace = 0;
  for (let i = 0; i < n; i++) {
    const [a0, l0] = outline[i];
    const [a1, l1] = outline[(i + 1) % n];
    shoelace += a0 * l1 - a1 * l0;
  }
  const hand = shoelace > 0 ? 1 : -1;

  /** Walk a closed polyline and drop a point every `pitch` metres. */
  const resample = (ring: ReadonlyArray<[number, number]>, pitch: number) => {
    const out: Array<[number, number]> = [];
    let carry = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let d = carry; d < span; d += pitch) {
        const t = d / span;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      carry = ((carry - span) % pitch + pitch) % pitch;
    }
    return out;
  };

  // **Resample first, then smooth, then offset** — and the order is the whole
  // trick. Smoothing a closed polyline shrinks it (Laplacian smoothing always
  // does, toward the centroid, by an amount that goes with the square of the
  // spacing between points), and the traced outline's points are tens of metres
  // apart: twelve passes over THOSE pulled the ring in by a hundred metres and
  // produced an 884 m lap in the middle of a field. Over 8 m samples the same
  // twelve passes move the line by centimetres, because each point's neighbours
  // are already almost where it is.
  let ring = resample(outline, RING.pitch);
  for (let pass = 0; pass < RING.smoothing; pass++) {
    const previous = ring;
    ring = previous.map((p, i) => {
      const a = previous[(i - 1 + previous.length) % previous.length];
      const b = previous[(i + 1) % previous.length];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
  }

  // Inward, along the smoothed line's own normal.
  const path = ring.map((p, i) => {
    const a = ring[(i - 1 + ring.length) % ring.length];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [
      p[0] + (-dz / len) * hand * RING.inset,
      p[1] + (dx / len) * hand * RING.inset,
    ] as [number, number];
  });

  // A concave stretch can fold the offset back on itself; one more smoothing
  // pass at this spacing costs nothing and takes the kinks out.
  return resample(path, RING.pitch).map((p, i, all) => {
    const a = all[(i - 1 + all.length) % all.length];
    const b = all[(i + 1) % all.length];
    return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4] as FramePoint;
  });
})();

export const RING_ENABLED = RING_PATH.length > 16;

/** One point on the ring: where it is, and how far it stands over the crown. */
export interface RingSample {
  across: number;
  along: number;
  /** Height above the island crown. The road's own slab, everywhere. */
  rise: number;
  /** Distance to the nearest running rail, for anything that has to know. */
  rail: number;
}

/**
 * The ring as it is actually built: two open shore roads, west end first.
 *
 * The closed offset path is cut where it nears the railway and each surviving
 * run is then clipped to the span of its own ties, so both ends of both chains
 * are junctions with the grid. Everything downstream — the geometry, the
 * traffic's raster, the minimap — walks these rather than `RING_PATH`, which
 * survives only as the un-cut shape they are taken from.
 */
export const RING_CHAINS: ReadonlyArray<ReadonlyArray<RingSample>> = (() => {
  if (!RING_ENABLED) return [];
  const n = RING_PATH.length;
  const clear = RING_PATH.map(([across, along]) => railGap(across, along) > RING.railClear);

  // Runs of clear samples, walked as a ring so a run that straddles the array's
  // start is one run rather than two. There is no meaningful "first" sample —
  // the path is a loop and where its array happens to begin is an accident of
  // the outline's tracing.
  const runs: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> | null = null;
  let opened = false;
  for (let k = 0; k < n * 2; k++) {
    const i = k % n;
    if (!clear[i]) {
      if (current) runs.push(current);
      current = null;
      opened = true;
      continue;
    }
    if (!opened) continue; // still in the first, possibly partial, run
    if (!current) current = [];
    if (k >= n && runs.length && runs[0][0] === RING_PATH[i]) break;
    current.push(RING_PATH[i] as [number, number]);
    if (k >= n) break;
  }
  if (current) runs.push(current);
  if (!runs.length) return [];

  const chains: RingSample[][] = [];
  for (const run of runs) {
    if (run.length < 4) continue;
    const side = run.reduce((sum, [across]) => sum + across, 0) > 0 ? 'north' : 'south';
    const ties = RING_TIES[side];
    const lo = Math.min(...ties);
    const hi = Math.max(...ties);
    // The longest stretch of this run inside its ties' span. Longest rather
    // than first, because a shore that doubles back can dip in and out of the
    // range and the road wants the main stretch, not a stub at the tip.
    let best: Array<[number, number]> = [];
    let take: Array<[number, number]> = [];
    for (const point of run) {
      if (point[1] >= lo && point[1] <= hi) take.push(point);
      else {
        if (take.length > best.length) best = take;
        take = [];
      }
    }
    if (take.length > best.length) best = take;
    if (best.length < 4) continue;
    // West to east, so a chain reads the same way round whichever way the
    // outline was traced.
    if (best[0][1] > best[best.length - 1][1]) best.reverse();
    chains.push(best.map(([across, along]) => ({
      across,
      along,
      rise: SURFACE.road,
      rail: railGap(across, along),
    })));
  }
  return chains;
})();

/** Every ring sample, both chains, for anything that does not care which. */
export const RING_SAMPLES: ReadonlyArray<RingSample> = RING_CHAINS.flat();

/**
 * Where the ring runs at a given `along`, on one side of the line.
 *
 * What the connecting streets are built against: a cross street has to reach
 * the ring and stop, and the ring is a curve, so the number is looked up rather
 * than stated. `side` is +1 for the platform side and −1 for the shore side.
 * Returns null where the ring does not reach that far along, which is how the
 * tips are excluded — out there the ring is crossing the railway and there is
 * nothing to join it to.
 */
export function ringAcross(along: number, side: 1 | -1): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  // The CHAINS, not the path: a street must not be run out to a stretch of
  // ring that the railway cut away.
  for (const sample of RING_SAMPLES) {
    if (Math.sign(sample.across) !== side) continue;
    const gap = Math.abs(sample.along - along);
    if (gap < bestGap) {
      bestGap = gap;
      best = sample.across;
    }
  }
  return bestGap <= RING.pitch * 2 ? best : null;
}

/** Centrelines of the four long streets, for anything that needs to sit between them. */
export const STATION_ROAD_AT = 66;
export const BACK_LANE_AT = 134;
export const SHORE_STREET_AT = -100;
export const QUAY_STREET_AT = -152;

/**
 * How far a street can run before it reaches the ring road's kerb.
 *
 * The grid used to be closed off by its own end streets — an avenue and a
 * cross street at the east tip — and once the ring existed those were both
 * redundant and in the way: the ring passes straight through where they were,
 * and two carriageways laid over each other z-fight and read as a mess. So the
 * long streets simply STOP at the ring, and where they stop is measured by
 * walking out from the middle until the ring is a kerb away, rather than by a
 * number that has to be re-guessed every time the island or the inset moves.
 */
function ringEnd(across: number, along: number, dAcross: number, dAlong: number, limit: number, halfWidth = STREET / 2 + FOOTWAY) {
  const clear = RING.width / 2 + RING.verge;
  for (let d = 0; d <= limit; d += 2) {
    const a = across + dAcross * d;
    const l = along + dAlong * d;
    // The railway stops a street as surely as the ring does, and out at the
    // tips it is the one that comes first: the line curves away from this flat
    // frame by 30 m past along −250 (see `CROSSING_ALONG`), so the station road
    // run out to the ring passed within 5 m of a running rail. Only the level
    // crossing is allowed near the line, and it is not built this way.
    if (railGap(a, l) <= RAIL_CLEAR + halfWidth) return Math.max(0, d - 2);
    for (const [ra, rl] of RING_PATH) {
      if (Math.hypot(ra - a, rl - l) <= clear) return d;
    }
  }
  return limit;
}

/**
 * Where a cross street should stop when it is run out to the ring road.
 *
 * Three metres past the ring's centreline, so the junction is a junction and
 * not a road that arrives alongside another one. `ringAcross` returns null
 * where the ring has curved away past the tips; there the street keeps the end
 * it had.
 */
const toRing = (along: number, side: 1 | -1, fallback: number) => {
  const at = ringAcross(along, side);
  return at === null ? fallback : at + side * 3;
};

export const STREETS: readonly Street[] = [
  // --- the north ring ------------------------------------------------------
  // The station approach and the back lane, tied together by five cross
  // streets and closed round the east end by the avenue: the back lane cannot
  // simply carry on to meet the station road, because at along 264 the island
  // is only 123 m wide on this side and a lane at across 134 would be on the
  // beach. So the ring steps in to across 104 for its last 64 m.
  { name: 'station-road', axis: 'along', at: STATION_ROAD_AT, from: -ringEnd(STATION_ROAD_AT, 0, 0, -1, 300), to: ringEnd(STATION_ROAD_AT, 0, 0, 1, 300), width: STREET, footway: FOOTWAY, centreLine: true, parking: true },
  { name: 'back-lane', axis: 'along', at: BACK_LANE_AT, from: -ringEnd(BACK_LANE_AT, 0, 0, -1, 280), to: ringEnd(BACK_LANE_AT, 0, 0, 1, 280), width: LANE, footway: LANE_FOOTWAY },
  // Each cross street runs from the station road's centreline out past the
  // back lane to the ring road — two metres past each thing it meets, so the
  // footway gaps at the junction are unambiguous (see `buildStreets`, which
  // cuts a footway where another street's span covers its centreline). Running
  // them all the way out is what turns the ring from a bypass into part of the
  // town: every block has a way onto it.
  { name: 'north-cross-w', axis: 'across', at: -250, from: 64, to: toRing(-250, 1, 136), width: LANE, footway: LANE_FOOTWAY },
  { name: 'north-cross-a', axis: 'across', at: -112, from: 64, to: toRing(-112, 1, 136), width: LANE, footway: LANE_FOOTWAY },
  { name: 'north-cross-b', axis: 'across', at: -4, from: 64, to: toRing(-4, 1, 136), width: LANE, footway: LANE_FOOTWAY },
  { name: 'north-cross-c', axis: 'across', at: 108, from: 64, to: toRing(108, 1, 136), width: LANE, footway: LANE_FOOTWAY },
  { name: 'north-cross-d', axis: 'across', at: 200, from: 64, to: toRing(200, 1, 136), width: LANE, footway: LANE_FOOTWAY },

  // --- the south ring ------------------------------------------------------
  // The shore street and the quay street, 52 m apart, which is what leaves a
  // block deep enough for the city's own 27 m terraces between them: at 45 m
  // the band between the two footways was 26 m and every terrace overhung the
  // quay street's pavement by a metre. The shore
  // street runs on east of the ring to the level crossing; that is the spine,
  // not a spur, because the crossing carries it over to the north ring.
  { name: 'shore-street', axis: 'along', at: SHORE_STREET_AT, from: -130, to: ringEnd(SHORE_STREET_AT, 0, 0, 1, 300), width: STREET, footway: FOOTWAY, centreLine: true, parking: true },
  { name: 'quay-street', axis: 'along', at: QUAY_STREET_AT, from: -ringEnd(QUAY_STREET_AT, 0, 0, -1, 260), to: ringEnd(QUAY_STREET_AT, 0, 0, 1, 260), width: LANE, footway: LANE_FOOTWAY },
  { name: 'south-cross-w', axis: 'across', at: -130, from: toRing(-130, -1, -154), to: -98, width: LANE, footway: LANE_FOOTWAY },
  { name: 'south-cross-m', axis: 'across', at: 40, from: toRing(40, -1, -154), to: -98, width: LANE, footway: LANE_FOOTWAY },
  { name: 'south-cross-e', axis: 'across', at: 200, from: toRing(200, -1, -154), to: -98, width: LANE, footway: LANE_FOOTWAY },

  // --- the spine -----------------------------------------------------------
  // The bridge approach: from the causeway's own crown, across the quay street
  // and up to the shore street. It stops there rather than carrying on to the
  // transplanted block's face, which is where the first version ended — the
  // block has its own paving (`ISLAND_LINK`) and a street that ran up to a wall
  // would be the one dead end left in the town.
  { name: 'bridge-approach', axis: 'across', at: APPROACH_ALONG, from: APPROACH_FROM, to: -98, width: STREET, footway: FOOTWAY },
  // The crossing link: from the south shore road, over the railway, to the
  // north one — through the station road and the shore street on its way. The
  // ONLY road connection between the two halves of the island, which is what
  // gives the level crossing something to be, and why both ends of it are run
  // out to the ring rather than stopping at the through streets: the shore
  // roads have to arrive at the crossing, or the lap has nowhere to go.
  //
  // Two streets and not one, with the railway's width missing from the middle.
  // A single street would lay its tarmac and — worse — its footways straight
  // through the railway at crown level, a metre under the rails; the crossing
  // itself is not a street slab but a ramped deck at rail height, built by
  // `IslandTown`. These stop where its ramps begin.
  { name: 'crossing-link-s', axis: 'across', at: CROSSING_ALONG, from: toRing(CROSSING_ALONG, -1, -102), to: CROSSING_RAMP_S, width: STREET, footway: FOOTWAY },
  { name: 'crossing-link-n', axis: 'across', at: CROSSING_ALONG, from: CROSSING_RAMP_N, to: toRing(CROSSING_ALONG, 1, 68), width: STREET, footway: FOOTWAY },
];

export const CROSSING = {
  along: CROSSING_ALONG,
  /** Half the width of the road deck over the tracks. */
  halfWidth: STREET / 2 + FOOTWAY,
  /** The deck reaches this far either side of the running line, covering both tracks. */
  fromAcross: CROSSING_DECK_S,
  toAcross: CROSSING_DECK_N,
  /** Length of each approach ramp, crown to deck. */
  ramp: CROSSING_RAMP,
  /**
   * Barrier pivots, just outside the **deck** and on OPPOSITE edges of the road
   * — the diagonal pair a half-barrier crossing has, each boom reaching across
   * its own carriageway rather than the whole width.
   *
   * They used to stand outside the *ramps*, which put them 18 m clear of the
   * deck edge and 27 m from the nearest rail: two standards with booms, out in
   * the town with an empty ramp between them and the railway, reading as a
   * second crossing beside the real one. A barrier belongs at the edge of the
   * surface it protects, which is where a driver stops and where the boom
   * actually blocks the road.
   */
  barrierAcross: [CROSSING_DECK_S - 2.5, CROSSING_DECK_N + 2.5] as const,
  /** How far off a train has to be for the barriers to come down. */
  warnDistance: 320,
} as const;

/**
 * The railway corridor, in `across`: nothing is scattered into it.
 *
 * A tree is placed by walking a street's footway, and the crossing link's
 * footway used to run over the rails — which planted a palm between the tracks.
 * The link is split now so no footway crosses, but the guard stays: it is one
 * comparison, and the failure it prevents is a tree in front of a train.
 */
export const RAIL_CORRIDOR = { from: -14, to: 34 } as const;

/**
 * The buildings, as rows of the city's own chunks.
 *
 * `part` is the merged chunk's name; `along`/`across` its CENTRE in the frame;
 * `turn` its rotation, 0 laying the chunk's own +X across the line and −90°
 * laying it along. Chosen by height and by triangles per square metre, the way
 * the village's were: two to five storeys, and dense enough that the triangles
 * are being spent on windows and doors rather than on a shed.
 *
 * | chunk                 | size        | eaves | what it is            |
 * | --------------------- | ----------- | ----- | --------------------- |
 * | `deco_Building_0_-3`  | 186 x 40    | 15.1  | five-storey town block|
 * | `deco_Building_-5_-1` | 189 x 27    | 10.0  | long three-storey row |
 * | `deco_Building_-4_-1` | 80 x 27     |  8.8  | two-storey shops      |
 * | `deco_Building_-4_-2` | 94 x 62     |  8.8  | two-storey block      |
 * | `deco_Building_1_2`   | 76 x 50     | 12.3  | four-storey block     |
 * | `deco_Building_-3_2`  | 46 x 52     |  8.8  | corner block          |
 *
 * Every one of them is placed in a BLOCK — the land between two parallel
 * streets and two cross streets — and that is a constraint the first version
 * broke: a 186 m row at along −7 had the cross street at along 8 running
 * straight through it. So each row below is short enough to sit between its two
 * cross streets, and the deep chunks (62 m and 50 m across) only go in the
 * outer bands, where the block is the whole width of the island.
 */
export interface TownBuilding {
  part: string;
  along: number;
  across: number;
  turn: number;
}

/**
 * The footprint of each transplanted chunk, in metres: `[its own X, its own Z]`.
 *
 * Measured off `city.glb` rather than stated, and here rather than only in the
 * table above because two things now need it as DATA: the layout check, and
 * the minimap — which draws these buildings and has no way to ask the model,
 * since it runs off the nav raster and never loads the city at all.
 *
 * `col_Building_-4_-1` is the low outbuilding cell the village uses; it is 3 m
 * tall against the others' nine, which is why it reads as a shed.
 */
export const CHUNK_FOOTPRINT: Record<string, readonly [number, number]> = {
  'deco_Building_0_-3': [186.4, 40.3],
  'deco_Building_-5_-1': [189.1, 27.3],
  'deco_Building_-4_-1': [79.6, 27.3],
  'deco_Building_-4_-2': [93.5, 62.3],
  'deco_Building_1_2': [76.0, 49.9],
  'deco_Building_-3_2': [45.6, 52.1],
  'col_Building_-4_-1': [55.1, 17.0],
};

const ALONG_AXIS = -Math.PI / 2;

export const TOWN_BUILDINGS: readonly TownBuilding[] = [
  // North side, in the 49 m band between the station road and the back lane.
  // Blocks run along -250..-112 (the car park), -112..-4, -4..108, 108..200,
  // and each row is short enough to sit inside its own block with the cross
  // streets' footways clear. The corner block is the one laid the other way up
  // (`turn: 0`), because 46 m across fits the band and 52 m does not.
  { part: 'deco_Building_-4_-1', along: -58, across: 100, turn: ALONG_AXIS },
  { part: 'deco_Building_-4_-1', along: 52, across: 100, turn: ALONG_AXIS },
  { part: 'deco_Building_-3_2', along: 154, across: 101, turn: 0 },
  // North side, in the 70 m band between the back lane and the ring road. The
  // blocks here are the ones the cross streets make on their way out to the
  // ring, and the row sits at across 168 the whole way: far enough off the lane
  // to leave it a frontage, far enough inside the ring to leave that one a
  // verge. The deep chunks are gone from this side — 62 m of building in a
  // 70 m band is a wall, not a street.
  { part: 'deco_Building_-4_-1', along: -180, across: 168, turn: ALONG_AXIS },
  { part: 'deco_Building_-4_-1', along: -58, across: 168, turn: ALONG_AXIS },
  { part: 'deco_Building_-4_-1', along: -170, across: 200, turn: ALONG_AXIS },
  // South side, in the 33 m band between the shore street and the quay street.
  // The gap at along -4..18 is the bridge approach and is left clear.
  { part: 'deco_Building_-4_-1', along: -60, across: -127, turn: ALONG_AXIS },
  { part: 'deco_Building_-4_-1', along: 120, across: -127, turn: ALONG_AXIS },
  // Two more against the railway, filling the gap between the station's own
  // block and the west end of the shore street.
  { part: 'deco_Building_-4_-1', along: -200, across: -40, turn: ALONG_AXIS },
  { part: 'deco_Building_-3_2', along: 195, across: -46, turn: ALONG_AXIS },
];

/** The station forecourt: paving outside the platform ramp. */
export const FORECOURT = {
  fromAcross: 34, toAcross: 58, fromAlong: -95, toAlong: 95,
} as const;

/**
 * The car park, in the west block of the north ring, with its bays and cars.
 *
 * Its along end moved from −245 to −236 when the ring closed: the cross street
 * at along −250 is 9 m of carriageway with a 3.6 m footway either side, and the
 * car park's slab is laid at exactly the same height as a street's, so the two
 * overlapping was 4 m of z-fighting across the full width of the park.
 */
export const CAR_PARK = {
  fromAcross: 80, toAcross: 118, fromAlong: -236, toAlong: -128,
  /** Bay pitch along the rows, and how many rows. */
  bayPitch: 2.7,
  rows: 2,
} as const;

/**
 * The waterfront park: grass kept clear, trees scattered.
 *
 * In the north band, in the one block between the back lane and the ring that
 * has no terrace in it. It was on the south shore, outside the quay street,
 * until the ring road was laid down the same strip — a park with a main road
 * through it is not a park, and there is no other 40 m of clear ground on that
 * side. Here it faces the ring across a verge and backs onto the lane.
 */
export const PARK = {
  fromAcross: 146, toAcross: 174, fromAlong: 12, toAlong: 92,
} as const;

/** Chunks scattered rather than placed: one tree, one piece of street furniture. */
export const TOWN_TREE_PART = 'deco_Vegetation_-3_-3';
export const TOWN_PROP_PART = 'deco_Accesories_-4_-2';

/**
 * What is parked in the town, by catalogue name — the game's OWN vehicles, the
 * ones `Traffic` drives, standing still.
 *
 * The first version parked a chunk of the city called
 * `deco_special_vehicles_texture_-1_-1`, which is not a car: it is an 8 m
 * cluster of trucks, and instancing it twenty times filled the town with
 * identical lorries. These are single vehicles with their own wheels, so a car
 * park is twenty DIFFERENT cars, and the mix is what a station car park has —
 * mostly saloons and hatchbacks, a taxi, a van, one police car.
 */
export const TOWN_PARKED: readonly string[] = [
  'Compact_Body', 'Hatchback_Body', 'Sedan_Body', 'Wagon_Body', 'SUV_Body',
  'Coupe_Body', 'Offroad_Body', 'minivan_body', 'Pickup_Body', 'taxi',
  'postvan', 'police_sedan',
];

/**
 * The lineside fence, as SEGMENTS rather than one long line.
 *
 * The first version was a single run 33 m off the running line, on the platform
 * side. 33 is outside the outermost station road (30.8) and inside the
 * forecourt (34) — correct in principle, and unusable in practice: it put a
 * post-and-rail fence 1.5 m from a running rail, which from any low angle reads
 * as a fence standing IN the track, and is closer than a fence is ever built.
 * There is no room on that side; four roads and two platforms fill it out to
 * 30.8 and the forecourt starts at 34.
 *
 * So the fence goes where a fence goes: along the OPEN stretches, on the south
 * side, 14 m off the line — west and east of the transplanted block, which is
 * its own boundary for the 286 m it occupies. A row of buildings backing onto
 * the railway needs no fence in front of it, and platforms need none behind
 * them; what needs fencing is the grass between the railway and the town's
 * shore street, and that is what these two runs do.
 *
 * `across` is measured from the RUNNING LINE and the posts are found on the
 * true alignment (`IslandTown.buildFence`) — the one thing here not laid in the
 * flat frame, because west of along −100 the line curves up to 30 m away from
 * it and a fixed frame offset would end up on the track.
 */
export const FENCE = {
  runs: [
    // West of the block, between the railway and the shore street.
    { across: -14, from: -250, to: -152 },
    // East of the block, stopping well short of the level crossing.
    { across: -14, from: 152, to: 229 },
  ] as ReadonlyArray<{ across: number; from: number; to: number }>,
  postPitch: 3.0,
  height: 1.3,
} as const;

/** Street lamps: pitch along each through street, and the arm's reach. */
export const LAMPS = { pitch: 32, height: 7.4, reach: 1.5 } as const;

/**
 * The forecourt's furniture: a bus shelter, a taxi rank and benches, all in the
 * paved area outside the platform ramp. `turn` faces the station.
 */
export const FORECOURT_KIT = {
  shelter: { across: 52, along: -34 },
  taxiRank: { across: 44, alongFrom: 10, alongTo: 74 },
  benches: [-72, -56, 20, 40, 62].map((along) => ({ across: 40, along })),
  bins: [-64, 8, 52].map((along) => ({ across: 37.5, along })),
} as const;
