/**
 * Street-level tram loop through the city.
 *
 * An earlier version of this ran an elevated ellipse over the rooftops. That
 * had to go: measured against `cityNav.png`, more than half of any ellipse
 * large enough to ring the city fell on void — the raster covers far more
 * ground than the map develops, and there is simply nothing out there to build
 * over. The ground has no such freedom, so the route is not a shape imposed on
 * the city; it is four of the city's own streets.
 *
 * The route is no longer a rectangle but a **figure-eight**: it crosses itself
 * once, at ninety degrees, and the tram runs straight through that crossing
 * twice a lap — once westbound, once northbound. `scripts/find-tram-route.mjs`
 * searches the road mask for one and writes `tramRoute.json`; every metre of
 * what it emits is verified pavement and flat to within a metre, the same bar
 * the old rectangle had to clear. Re-run it for a different loop.
 *
 * The shape is a closed rectilinear polyline with rounded corners, so arc
 * length is still closed-form — straights and circular arcs, nothing else.
 * The loop is therefore parametrised by distance travelled (`s`, metres from
 * the first corner) rather than by an angle, so the tram runs at exactly
 * constant speed without any numerical integration, exactly as before.
 *
 * A crossing is not free: two trams can be metres apart in space while being
 * half a lap apart in `s`, which is the one thing the follow logic in
 * `physics/tramTraffic.ts` cannot see by looking at gaps alone. `CROSSING`
 * below is exported for it.
 */
import tramData from './tramData.json';
import route from './tramRoute.json';

/**
 * Corner radius is deliberately tight: at 10 m the arcs stay inside a
 * junction's own tarmac, and every metre wider puts more of the outer rail
 * over the kerb. Tram-tight beats geometrically graceful. It lives in the
 * generated route file so the search and the runtime cannot disagree about it.
 */
export const RAIL = {
  cornerRadius: route.cornerRadius,

  /**
   * Closest two trams may get, centre to centre, and the distance over which
   * one is slowed to it. The vehicles are 43.5 m long, so anything under that
   * is already a collision; the rest is a coupling gap. Both numbers are in
   * metres and both are tied to the vehicle — `prepare-tram.mjs` prints the
   * figures its own measurements suggest whenever the model changes.
   */
  minTramGap: 50,
  tramFollowZone: 50,
  /** Service brake, m/s^2. A Flexity stops from line speed in about 150 m. */
  tramBrake: 1.8,

  /** Distance between the two rail centrelines — standard gauge. */
  gauge: 1.44,
  railWidth: 0.14,
  /**
   * Rails sit a few centimetres over the measured road height — proud enough
   * to catch the light, low enough to read as embedded tram rail. They carry
   * no collider on purpose: a kerb-height lip across four city streets would
   * trip the car every time it crossed one.
   *
   * There are deliberately no sleepers. Street-running track is bedded into
   * the carriageway, so all that shows is the steel; modelling sleepers put
   * dark bars across the tarmac that read as speed bumps and buried the rails
   * they were meant to support. What sells it instead is `bed` — the paved
   * channel between the rails, a shade off the surrounding asphalt.
   */
  railLift: 0.04,
  bedLift: 0.012,

  /**
   * ~50 km/h. A G:link Flexity runs at up to 70 on reserved track and much
   * slower in the street sections; this is street running.
   */
  trainSpeed: 14,
} as const;

/** Model, dimensions and articulated sections, from `prepare-tram.mjs`. */
export const TRAM = {
  /**
   * Trams running the loop, spaced evenly around it. Five on a 2.2 km circuit
   * puts one every 441 m, so at line speed one passes any given stop about
   * every 31 seconds — frequent enough that the line reads as a service
   * rather than as scenery.
   *
   * It was three while the tram was a Melbourne C-class, whose model cost
   * 391 k triangles even after `prepare-tram.mjs` had stripped everything
   * invisible out of it, and five of those would have been nearly 2 M against
   * a city of 250 k. The G:link Flexity is 61 k, so the whole service is
   * 303 k — cheaper than three of the old ones by a factor of six. **This is
   * the one number to change** if the frame rate on your machine says it can
   * take more, or fewer; nothing else depends on it.
   */
  count: 5,
  model: tramData.model,
  /** Width (X), height (Y), length (Z), metres. */
  size: tramData.size as [number, number, number],
  sections: tramData.sections,
  /**
   * Length of each section's collider. The seven bodies are 5.7 m apart in the
   * middle of the tram and 6.7 m apart at the two cabs, so this covers the
   * widest of those gaps and overlaps everywhere else, rather than leaving
   * slots between modules that a car could nose into.
   */
  sectionCollider: 7.1,
} as const;

/**
 * The tram's camera rig.
 *
 * It needed one of its own. The tram was being offered the main line's six
 * views — `RAIL_CAMERA_MODES` is chosen for any vehicle with a `rail` — but
 * `updateRailCamera` only ever ran for the main-line train, so five of those
 * six fell through to the *car's* chase rig and were the same shot under five
 * different names. Pressing C changed the label and nothing else.
 *
 * The main line's numbers would not have suited it anyway. That rig is built
 * round a 147 m rake at 300 km/h in open country: it stands 30 m back, 12 m to
 * the side and 10 m up, and plants lineside shots 21 m off the track. A tram is
 * 43.5 m long, does 60 km/h, and runs down a street with buildings 8 m either
 * side — at those distances the camera is inside the shopfronts and the tram is
 * a speck. Everything here is pulled in to the street's scale, and the planted
 * shot is at eye level on the pavement rather than up on an embankment,
 * because that is where you would actually stand to watch a tram go past.
 */
export const TRAM_CAMERA = {
  /**
   * The default shot: behind the whole tram, barely off the centreline.
   *
   * `back` is measured from the cab anchor, and the cab is at the FRONT of a
   * 43.5 m vehicle, so anything under about 40 here puts the camera inside the
   * tram. The main line answers that by standing 12 m out to the side, because
   * 30 m behind the cab of a 147 m rake is hopeless either way. A tram is short
   * enough to get behind properly: 50 m back clears the tail by ten and frames
   * the whole vehicle, and then the side offset can come down to 2.5 m — a
   * three-quarter view that is still within the tram's own lane.
   *
   * That last number is the one that matters in a street. At the 6 m this
   * started on, the rig rode along the kerb and spent half the loop inside the
   * street trees, which are planted on the footway and are the one thing at
   * camera height out there.
   */
  chase: { back: 50, up: 8.5, side: 2.5, look: -8, fov: 62, fovBoost: 6 },
  /**
   * The driver's eye. `inset` is measured back from the nose tip, `ahead` is
   * how far up the street the eye is aimed — shorter than the train's 70 m
   * because a tram's next decision is a junction one block away, not a signal
   * at the end of a mile of straight.
   */
  cab: { eye: 2.1, side: 0.45, ahead: 38, inset: 1.2 },
  /** Just outside the nose, low, for street running. */
  nose: { eye: 1.15, ahead: 30, clear: 0.5 },
  /**
   * Straight over the tram, high enough to hold all 43.5 m of it and the
   * junction it is crossing. `look` is 18 m back from the nose, which is about
   * the middle of the vehicle, so it sits centred rather than hanging off the
   * bottom of the frame.
   */
  top: { up: 26, back: 10, look: 18, fov: 52 },
  /**
   * High and slowly orbiting, and deliberately STEEP.
   *
   * The main line's drone hangs back and looks along the train, which is right
   * over open ground. This street is lined with trees, and from 18 m back the
   * shot was through one canopy after another. Higher and closer in plan means
   * the camera looks down between them rather than through them; the lateral
   * swing is what still reads as a drone rather than as the overhead view.
   */
  drone: { up: 33, back: 14, look: 16, orbit: 0.22, swing: 11, fov: 55 },
  /**
   * The planted shot, standing on the pavement.
   *
   * `side` is 7.5 m — across the neighbouring lane and onto the kerb, and no
   * further, because the buildings here come right down to the footway and a
   * camera planted inside one films the back of its walls. `up` is 2.2 m: head
   * height on the pavement, not a crane.
   */
  cinematic: {
    leadBase: 55, leadPerSpeed: 5.5, leadMin: 35, leadMax: 190,
    holdBase: 1.1, holdPerSpeed: 0.05, holdFormation: true,
    side: 7.5, up: 2.2, look: 10, fov: 48,
  },
  /**
   * Half the tram's length: the distance from the cab anchor (which sits at the
   * leading section's centre) to the nose tip. The outermost section centres
   * are 18.05 m from the middle of a 43.5 m vehicle, so 3.7 m of it overhangs.
   */
  noseHalf: 3.7,
} as const;

const R = RAIL.cornerRadius;

/**
 * The route's vertices, in travel order, from the generated file. JSON gives
 * these back as `number[][]`, which TypeScript will not narrow to pairs on its
 * own, so the shape is asserted here once rather than at every use.
 */
const POINTS = route.points.map((p) => [p[0], p[1]] as [number, number]);

/** Where the route crosses itself. Read by `tramTraffic` — see the header. */
export const CROSSING: readonly [number, number] = [route.crossing[0], route.crossing[1]];

type Segment =
  | { kind: 'straight'; length: number; x: number; z: number; dx: number; dz: number }
  | { kind: 'arc'; length: number; cx: number; cz: number; from: number; sweep: number };

const norm2 = (x: number, z: number): [number, number] => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};

/**
 * Builds the loop as alternating arcs and straights: one arc per vertex, then
 * the straight that leaves it.
 *
 * Written for a general turn rather than only for right angles — the tangent
 * length is `R · tan(θ/2)`, which collapses to `R` for the ninety-degree
 * corners a street grid actually produces. Costing a few lines now means a
 * later route that cuts a diagonal does not silently come out with its corners
 * in the wrong place.
 */
function buildSegments(): Segment[] {
  const segments: Segment[] = [];
  const n = POINTS.length;

  const corners = POINTS.map((here, i) => {
    const prev = POINTS[(i - 1 + n) % n];
    const next = POINTS[(i + 1) % n];
    const inDir = norm2(here[0] - prev[0], here[1] - prev[1]);
    const outDir = norm2(next[0] - here[0], next[1] - here[1]);

    const cross = inDir[0] * outDir[1] - inDir[1] * outDir[0];
    const dot = inDir[0] * outDir[0] + inDir[1] * outDir[1];
    const theta = Math.atan2(Math.abs(cross), dot);
    const tangent = R * Math.tan(theta / 2);

    const startPoint: [number, number] = [here[0] - inDir[0] * tangent, here[1] - inDir[1] * tangent];
    const endPoint: [number, number] = [here[0] + outDir[0] * tangent, here[1] + outDir[1] * tangent];

    // The centre sits one radius off the entry tangent, on the inside of the turn.
    const side = cross >= 0 ? 1 : -1;
    const cx = startPoint[0] - inDir[1] * R * side;
    const cz = startPoint[1] + inDir[0] * R * side;
    const from = Math.atan2(startPoint[1] - cz, startPoint[0] - cx);

    return { startPoint, endPoint, cx, cz, from, sweep: theta * side, length: theta * R };
  });

  for (let i = 0; i < n; i++) {
    const corner = corners[i];
    const next = corners[(i + 1) % n];
    segments.push({
      kind: 'arc',
      length: corner.length,
      cx: corner.cx,
      cz: corner.cz,
      from: corner.from,
      sweep: corner.sweep,
    });
    const [dx, dz] = norm2(
      next.startPoint[0] - corner.endPoint[0],
      next.startPoint[1] - corner.endPoint[1],
    );
    segments.push({
      kind: 'straight',
      length: Math.hypot(
        next.startPoint[0] - corner.endPoint[0],
        next.startPoint[1] - corner.endPoint[1],
      ),
      x: corner.endPoint[0],
      z: corner.endPoint[1],
      dx,
      dz,
    });
  }
  return segments;
}

const SEGMENTS = buildSegments();

const STARTS: number[] = [];
{
  let acc = 0;
  for (const segment of SEGMENTS) {
    STARTS.push(acc);
    acc += segment.length;
  }
}

/** Total loop length, metres. */
export const RAIL_LENGTH = STARTS[STARTS.length - 1] + SEGMENTS[SEGMENTS.length - 1].length;

/** Wraps a distance into [0, RAIL_LENGTH). */
export const railWrap = (s: number) => ((s % RAIL_LENGTH) + RAIL_LENGTH) % RAIL_LENGTH;

function segmentAt(s: number): number {
  // Binary search: a figure-eight has three times the pieces a rectangle had,
  // and this is called for every section of every tram, every step.
  let lo = 0;
  let hi = SEGMENTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (STARTS[mid] <= s) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Centreline position at arc length `s`, on the ground plane. */
export function railPointAt(s: number): [number, number] {
  const d = railWrap(s);
  const i = segmentAt(d);
  const segment = SEGMENTS[i];
  const local = d - STARTS[i];

  if (segment.kind === 'straight') {
    return [segment.x + segment.dx * local, segment.z + segment.dz * local];
  }
  const angle = segment.from + (segment.sweep * local) / segment.length;
  return [segment.cx + R * Math.cos(angle), segment.cz + R * Math.sin(angle)];
}

/**
 * The two arc lengths at which the loop passes through `CROSSING`.
 *
 * Found by walking the finished route rather than derived from the polyline,
 * because the crossing sits in the *middle* of two legs, not at a vertex —
 * there is no corner to read it off. Two passes is the whole point of a
 * figure-eight; if this ever returns some other number the route is not the
 * shape this module thinks it is, and the tram spacing that depends on it
 * would silently do nothing.
 */
function findCrossingArcs(): [number, number] {
  const hits: number[] = [];
  const step = 0.5;
  let wasNear = false;
  let bestS = 0;
  let bestD = Infinity;
  for (let s = 0; s < RAIL_LENGTH; s += step) {
    const [x, z] = railPointAt(s);
    const d = Math.hypot(x - CROSSING[0], z - CROSSING[1]);
    const near = d < R;
    if (near) {
      if (d < bestD) { bestD = d; bestS = s; }
    } else if (wasNear) {
      hits.push(bestS);
      bestD = Infinity;
    }
    wasNear = near;
  }
  if (wasNear) hits.push(bestS);
  if (hits.length !== 2) {
    throw new Error(`tram route: expected 2 passes through the crossing, found ${hits.length}`);
  }
  return [hits[0], hits[1]];
}

export const CROSSING_ARCS = findCrossingArcs();

/** Unit tangent (direction of travel) at arc length `s`. */
export function railTangentAt(s: number): [number, number] {
  const d = railWrap(s);
  const i = segmentAt(d);
  const segment = SEGMENTS[i];

  if (segment.kind === 'straight') {
    return [segment.dx, segment.dz];
  }
  const local = d - STARTS[i];
  const angle = segment.from + (segment.sweep * local) / segment.length;
  const way = segment.sweep >= 0 ? 1 : -1;
  return [-Math.sin(angle) * way, Math.cos(angle) * way];
}

/**
 * Left-hand normal at arc length `s` — the axis the two rails are offset
 * along. Sign convention matches `trackConfig.trackNormal`.
 */
export function railNormalAt(s: number): [number, number] {
  const [tx, tz] = railTangentAt(s);
  return [tz, -tx];
}
