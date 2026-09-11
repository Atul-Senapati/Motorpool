/**
 * The main-line railway: a 10 km loop around the whole map.
 *
 * The tram (`railConfig.ts`) is street furniture — four city streets, embedded
 * rail, right-angle corners. This is the other kind of railway: it keeps out of
 * the city, runs on ballast across the open ground, bridges the water to reach
 * the two western districts and bores through the one headland in the south
 * that a closed loop cannot go round.
 *
 * `scripts/find-train-route.mjs` searches for it and writes `trainRoute.json`:
 * a dense polyline at 6 m carrying, per point, the rail height, the ground
 * height under it and which of ballast / structure / tunnel it is. Everything
 * about *where* the line goes and *how high* it sits is decided there, once, so
 * nothing here has to search or sample the world at runtime.
 *
 * The points arrive already smooth — the generator fillets every corner with a
 * circular arc and resamples the result — so this module does no geometry of
 * its own beyond tabulating arc length. (An earlier version smoothed a
 * grid-staircase here with a Gaussian; that gave thirty-metre corners with no
 * say in where, and it moved the line off the ground the generator had graded
 * it for. Doing it in the generator means the radius is chosen, the ground is
 * re-read where the line actually is, and the runtime just draws.)
 *
 * Arc length is tabulated rather than closed-form as the tram's is: the tram's
 * route is straights and circular arcs it knows about, this one arrives as a
 * dense polyline, and a cumulative table with a binary search over it is both
 * simpler and exact for what it describes.
 */
import route from './trainRoute.json';
import trainData from './trainData.json';
import carriageData from './carriageData.json';
import train91Data from './train91Data.json';
import carriage91Data from './carriage91Data.json';

/**
 * Whether the main-line railway is part of the world at all.
 *
 * Off: the track, its structures, the locomotive and the minimap trace are not
 * drawn, the train is not offered in the garage, and the terrain and sea keep
 * their own surfaces instead of having the bores cut out of them. Everything
 * below still loads and every measurement still holds — the route file, the
 * generator, the geometry and `TrainRide` are all intact and untouched — so
 * turning this back on restores the line exactly as it was.
 *
 * It is a flag rather than deleted code because the route is the expensive
 * part: `scripts/find-train-route.mjs` is a graded, filleted, obstacle-aware
 * search whose output was tuned over many passes, and none of that should have
 * to be recovered from git to put the railway back.
 */
export const TRAIN_LINE_ENABLED = true;

import sketch from './trainSketch.json';

/**
 * The two islands created for the northern crossing.
 *
 * The drawn route runs 2.4 km straight over open water on the north side, and
 * a single span that long is not a bridge — it is a causeway with ideas. Two
 * islands break it into four crossings, none of them over a kilometre, and give
 * the line somewhere to come down to sea level between them.
 *
 * They are the shapes the user drew, read out of `trainSketch.json` in its own
 * pixel coordinates and georeferenced here by the transform that file carries.
 * `find-train-route.mjs` reads exactly the same numbers and treats the interior
 * as ground, so the route generator and the renderer cannot disagree about
 * where the land is.
 */
const ISLAND_CROWN = 3.2;
/** Metres of beach outside the drawn outline. Matches ISLAND_SHORE in the finder. */
const ISLAND_SHORE = 26;

/**
 * Growth applied to a drawn island, about its own centre, as [across X, across Z].
 *
 * The sketch is left alone deliberately — it is the record of what was drawn,
 * and this is a later decision about how much land that shape should carry. The
 * bigger island has a four-road station, two platforms and a transplanted town
 * on it, and at the traced size the town's far corners overhung the beach.
 *
 * Uneven on purpose, because the island is boxed in and the measurements say
 * so: eastward it has the smaller island to stay clear of (its beach begins at
 * x -583) and westward the west district (its edge is near x -1500), which
 * leaves about 725 m of open water for a 637 m island — so 1.08 across, and no
 * more. North and south there is nothing but sea for hundreds of metres, and
 * depth is what the station actually needed.
 *
 * Depth went 1.45 → 1.9 when the station got a town round it (`townConfig`).
 * At 1.45 there were 180 m of island on the platform side and 142 m on the
 * bridge side, and the station's own block took 70 of those: enough for one
 * street, not for a town. At 1.9 it is 226 and 196, which carries two through
 * streets, a back lane, a forecourt, a car park and thirteen blocks with 25 m
 * to spare at the shore.
 *
 * 1.9 and not more, and the limit is the bridge rather than the sea: the road
 * bridge runs from the island's south shore to the coast road at z -412, and
 * every metre of growth is a metre off the bridge. At 1.45 it spanned 170 m, at
 * 1.9 it spans 120, and at 2.2 it would be 90 — at which point the crossing the
 * island is reached by stops reading as a bridge at all.
 *
 * Growing an island only ever *adds* land under a line that already crosses it,
 * so the route stays valid and does not need regenerating. `find-train-route.mjs`
 * reads the sketch directly and therefore still sees the traced size, which is
 * the conservative direction: it will not route over ground that is not there.
 */
const ISLAND_GROWTH: Record<string, readonly [number, number]> = {
  kestrel: [1.08, 1.9],
};

export const TRAIN_ISLANDS: ReadonlyArray<{
  name: string;
  /** Closed outline, world XZ, anticlockwise or clockwise as drawn. */
  outline: ReadonlyArray<[number, number]>;
  centre: [number, number];
  crown: number;
  shore: number;
}> = sketch.islands.map((island) => {
  const { ox, oz, scale } = sketch.transform;
  const traced = island.outline.map(([sx, sy]) =>
    [ox + scale * sx, oz + scale * sy] as [number, number]);
  // Wound so that a fan over it faces UP. Which way the outline was drawn is an
  // accident of tracing, and getting it wrong does not warn — the island is
  // built, its normals point at the seabed, and with a front-facing material it
  // is simply not there, which is exactly how it first shipped. In the XZ plane
  // with Y up, a triangle's normal is +Y when the shoelace sum is negative, so
  // a positive sum means the trace runs the other way and is reversed here.
  // Same lesson as `buildLoft`'s signed-area test, one dimension down.
  const shoelace = traced.reduce((sum, [x, z], i) => {
    const [nx, nz] = traced[(i + 1) % traced.length];
    return sum + (x * nz - nx * z);
  }, 0);
  const wound = shoelace > 0 ? [...traced].reverse() : traced;
  const centre: [number, number] = [
    wound.reduce((n, p) => n + p[0], 0) / wound.length,
    wound.reduce((n, p) => n + p[1], 0) / wound.length,
  ];
  // Grown about the centroid, after winding and after the centroid is known —
  // scaling about the origin would move the island across the map.
  const [gx, gz] = ISLAND_GROWTH[island.name] ?? [1, 1];
  const outline = gx === 1 && gz === 1 ? wound : wound.map(([x, z]) => [
    centre[0] + (x - centre[0]) * gx,
    centre[1] + (z - centre[1]) * gz,
  ] as [number, number]);
  return { name: island.name, outline, centre, crown: ISLAND_CROWN, shore: ISLAND_SHORE };
});

/** What the line is standing on at a given point. Matches the route file. */
export const BALLAST = 0;
export const VIADUCT = 1;
export const TUNNEL = 2;
/**
 * An open excavation, not a roofed one: the ground is above the rail but not by
 * enough to bury a bore in. Every tunnel has one at each end, and it is what
 * puts the portal where the hillside is actually deep enough to drive into.
 */
export const CUTTING = 3;

export const TRAIN = {
  /** Standard gauge, rail centre to rail centre. */
  gauge: 1.435,
  railWidth: 0.13,
  railHeight: 0.16,

  /**
   * Sleeper pitch. Real main line is 0.6-0.65 m; 0.7 on a 4.9 km loop is seven
   * thousand instances in one draw call, and from the cab it reads as track
   * rather than as a row of planks, which 1.8 m did.
   */
  /** Concrete monobloc pitch: 0.65 m is the standard. */
  sleeperSpacing: 0.65,
  sleeperHalfWidth: 1.35,
  sleeperHeight: 0.22,
  sleeperLength: 0.3,

  /** Ballast: a trapezium, crown to formation, with 1:1.5 side slopes. */
  ballastCrownHalf: 2.3,
  ballastDepth: 0.62,
  ballastSlope: 1.5,

  /** Bridge and viaduct deck, and the parapet up each side of it. */
  deckHalf: 3.1,
  deckThickness: 0.9,
  parapetHeight: 1.1,
  parapetWidth: 0.32,
  /** Piers, and how far apart they stand. */
  pierSpacing: 34,
  pierHalf: 1.15,
  /** Piers are sunk this far into the ground (or the sea) rather than resting on it. */
  pierEmbed: 2.5,

  /**
   * The elevated line: the double-track concrete viaduct that carries the line
   * down the west district's street and on round the northern leg to the
   * station (`TrainPoint.street`, `doubleTrackAt`).
   *
   * Modelled on the Portland El in GTA III: a fixed-width concrete deck with a
   * low parapet each side, two tracks on it, and a single rectangular pier on
   * the deck's centreline every span with a cap beam across the top. One
   * central pier rather than a pair on the footpaths, and a fixed width rather
   * than one read off the kerbs — the first version did both, and a deck whose
   * edges followed a noisy kerb measurement wobbled, while columns that had to
   * find a footpath could not stand over water or open ground. A pier on the
   * centreline stands anywhere the line goes, which is what lets the same
   * structure run from the street straight out over the sea.
   */
  elevated: {
    /** Centre-to-centre spacing of the two tracks. */
    trackGap: 4.6,
    /** Deck half-width, about the midpoint between the two tracks. */
    deckHalf: 5.3,
    deckDepth: 1.3,
    /** Chamfer on the soffit's edges: a box girder, not a slab. */
    chamfer: 0.55,
    /** The parapet kerb along each edge. */
    parapetHeight: 0.6,
    parapetWidth: 0.35,
    /** Piers: spacing along the line, section (across x along the line). */
    pierSpacing: 20,
    pierAcross: 1.8,
    pierAlong: 1.1,
    /** The cap beam under the deck: half-width across, depth, and thickness along. */
    capHalf: 4.4,
    capDepth: 1.0,
    capAlong: 1.5,
  },

  /**
   * The tunnel lining: a horseshoe, `boreHalf` wide, with vertical walls to
   * `boreWall` and a semicircular arch of radius `boreHalf` above that — so the
   * apex is at `boreWall + boreHalf`, 8.5 m over the rail. Big for a single
   * track, deliberately: the chase camera rides 7.7 m up, and a bore it did
   * not fit inside would put the camera in the hillside every time the train
   * went underground.
   */
  // 6 m for two tracks. The pair sit 4.6 m apart, centred in the bore, so each
  // rail centre is 2.3 m off the middle; a Class 43 is 2.74 m wide and wants
  // ~0.8 m of structure gauge beyond that, which is 4.4 m from the middle to
  // the wall — plus the 1.1 m maintenance walkway each side. Five did not fit
  // that; the second track ran 0.4 m from the lining.
  boreHalf: 6.0,
  boreWall: 3.5,
  /**
   * The invert slab sits this far under the sleepers: just clear of them. The
   * bore is slab track — no ballast — so the sleepers bed straight onto it.
   */
  boreFloorDrop: 0.02,
  /**
   * The open cutting on a bore's approaches: half-width at rail level, and how
   * far the sides batter back per metre of depth. See `CUTTING`.
   */
  // A retained cutting, not an earth one. 7 m of half-width battering out at
  // 0.6 per metre gave a 27 m-wide funnel at a 10 m depth, and since the shader
  // carves the terrain to exactly that shape it took a gash out of the hillside
  // either side of every portal — which is what "huge cutouts, breaks the
  // environment" was. Walls hold the ground back, so they can stand nearly
  // vertical: this is a 13 m slot instead, and roughly a quarter of the terrain
  // removed.
  cuttingHalf: 5.5,
  cuttingBatter: 0.14,
  /**
   * How deep an excavation may be — and therefore where cutting stops and
   * tunnel starts. One number, because the two have to be the same one.
   *
   * The shader carves a cutting only up to this height over the rail. Below it,
   * a trench reaches daylight and is a cutting. Above it, the ground has to be
   * roofed, and the roof is a bore — which the shader carves as an arch
   * standing 9.1 m over the rail, so anything classed as a bore this way has
   * 3.9 m of ground left over the excavation.
   *
   * Split the two and both halves fail. At a cut cap of 9.9 and a tunnel bar of
   * 10.6 there was a 0.7 m band where a cutting could not reach the surface —
   * an unlined slot buried in the hill — and bores with as little as 1.1 m over
   * the arch, which on undulating ground between 6 m route points broke out as
   * a horseshoe hole in the middle of a grass slope.
   *
   * The rule is `cuttingMaxDepth >= TUNNEL_MIN_COVER` (13), not equality — the
   * cap only has to be deep enough that anything classed a cutting can reach
   * daylight. But it must not be much MORE than that either, and this shipped
   * at 24 for a round: the cutting carve overlaps 2.5 m into the bore at every
   * portal, and the hill over the rail there is 13.5-15.2 m, so a 24 m carve
   * took the hilltop off above every headwall and left a notch of raw terrain
   * edges around the mouth. The deepest real cutting on the line is 12.8 m;
   * 13 reaches daylight for all of them and stops at the portal's crown.
   */
  cuttingMaxDepth: 14,
  /**
   * Portal headwall: a slab with the horseshoe cut through it, and only a
   * little larger than the horseshoe.
   *
   * It was half as big again, with a coping along the top and a splayed wing
   * wall each side — which is what a portal in a deep cut face looks like, and
   * which is not what most of these are. Set into a gentle slope, the headwall
   * buries itself and the coping and wings do not: they hang in the air in
   * front of the arch and lie about on the grass either side of it as detached
   * slabs. A plain ring reads correctly whatever it is set into.
   */
  // Wider and taller than the bore it fronts, so the mouth reads as a built
  // thing standing in the hillside rather than a hole that happens to be there.
  // It also has to be at least as wide as the cutting it meets, or the wall
  // ends in mid-air beside it.
  // Follows the bore: 6.0 lining + 0.6 carve = 6.6, and the headwall wants a
  // shoulder past that. Height clears the wider arch (3.5 + 6.0 = 9.5 apex).
  portalHalf: 8.6,
  portalHeight: 12.5,
  portalThickness: 1.8,

  /**
   * The causeway the line builds for itself over water: how wide its crown is,
   * how far its flanks batter out, and where the seabed is taken to be. See
   * `CAUSEWAY_FREEBOARD` in the route finder for why there is one at all.
   */
  causewayCrownHalf: 13,
  causewaySlope: 3.5,
  seabed: -9,

  /**
   * Sea level.
   *
   * The map has no water in it at all: `prepare-map.mjs` rasterises only
   * drivable surfaces, and everything off the coast comes back as void, so
   * three quarters of the nav raster is nothing. That was invisible while the
   * game stayed on the roads, and stops being invisible the moment a railway
   * bridges a bay — a viaduct over an abyss reads as a bug. Measured against
   * the shoreline, the commonest height where land meets void is -3.5 m, and a
   * surface at -3.6 sits just under those beaches while flooding 0.14% of the
   * land — the handful of cells that were already below the foreshore.
   */
  seaLevel: -3.6,

  /** ~150 km/h for the service. Main line, not street running. */
  speed: 42,
  /**
   * Service brake, m/s². A locomotive is not a car: 2 takes 440 m to stop
   * from line speed, which is why the speed restrictions have to be seen
   * coming rather than reacted to.
   */
  brake: 2,

  /**
   * Services on *each* line, spaced evenly round the loop.
   *
   * This was one, on the grounds that the power car is 192 k triangles — most
   * than the whole city — and `prepare-train.mjs` will not get it lower (see
   * its `TRIANGLE_BUDGET`). That reasoning counted the wrong thing. The cost
   * that matters is not how many services exist but how many are **on screen
   * at once**, and three.js frustum-culls per mesh: a service on the far side
   * of a 9.2 km loop is a matrix update and nothing else. Spaced evenly, the
   * nearest one is always about `TRAIN_LENGTH / count` away, so co-visibility
   * barely moves as the count rises — what rises is how often you meet one.
   *
   * Four is what makes the line feel worked rather than empty. It puts a
   * service every 2.3 km on each road, so at 150 km/h you meet a down-line
   * train about once a minute and there is usually one somewhere in view on a
   * long straight. One up-line service stands down when the player takes a
   * locomotive out, so the line never gains a vehicle: three up, four down.
   *
   * They keep station rather than signal each other — all four run to the same
   * speed profile, so an evenly spaced set stays evenly spaced and none ever
   * closes on the one ahead. The player is the exception and is not protected
   * from them.
   */
  count: 4,
} as const;

/**
 * The train, as a formation: a locomotive, six coaches, and a locomotive at the
 * back facing the other way.
 *
 * Top and tail rather than both engines at the front, for three reasons. It is
 * what an **HST is**: a Class 43 power car at each end of a rake of Mark 3s.
 * That is the formation this already built before the models matched it — the
 * Class 91 it used to carry ran with a driving trailer at the far end, so
 * top-and-tail was an approximation and is now the real thing. It keeps a cab
 * at each end, which is what makes this line's full-speed
 * reverse honest rather than blind, and what the `cab` camera swaps to when the
 * train runs the other way. And it puts the second engine where it can be seen
 * — down the outside of a curve from the cab — instead of hidden eleven metres
 * behind the driver.
 *
 * `offset` is metres back along the line from the leading locomotive's centre,
 * `flip` turns a unit end for end, and `bogieCentres` is that unit's own. The
 * offsets are computed from the two measured models rather than written down,
 * so they cannot drift when either is re-exported.
 */
/* --------------------------------------------------------------- rail stock */

/**
 * The two rail sets the main line can be driven with, and which one is loaded.
 *
 * Both are kept because both were built: replacing the Class 91 with the HST
 * threw away a working vehicle, and there is no reason a railway cannot own two
 * classes. What there IS a reason for is loading only one of them — an unused
 * power car and coach are 370 k triangles and 2 MB of GLB that never appear —
 * so the pair is chosen here, once, and `LOCOMOTIVE` and `CARRIAGE` resolve to
 * it. Everything downstream (`formationFor`, `TrainRide`, the AI services, the
 * rail cameras) reads those and needs to know nothing about the choice.
 *
 * `bodyHeight` is the one figure that is not measured, and it is per set for the
 * reason its own note gives: the measurement takes in whatever stands proudest,
 * which on a Class 91 is a raised pantograph and on a Class 43 is roof aerials.
 */
const RAIL_SETS = {
  /** Grand Central HST: a Class 43 at each end of a rake of Mark 3s. */
  train: {
    label: 'BR Class 43',
    loco: trainData,
    coach: carriageData,
    /** Over the roof. A Class 43 has no pantograph; the measured 4.01 is aerials. */
    bodyHeight: 3.9,
  },
  /** InterCity 225: a Class 91 and APT-derived trailers. */
  train91: {
    label: 'BR Class 91',
    loco: train91Data,
    coach: carriage91Data,
    /** Over the roof. The measured 4.76 is the raised pantograph, a few thin rods. */
    bodyHeight: 3.8,
  },
} as const;

export type RailSetId = keyof typeof RAIL_SETS;
export const RAIL_SET_IDS = Object.keys(RAIL_SETS) as RailSetId[];
/** Both sets' measurements, for the garage — which has to describe what it is not showing. */
export const RAIL_SETS_ALL = RAIL_SETS;

/**
 * Which set is loaded, from the same `?car=` the garage selects with.
 *
 * Read here rather than passed down from `garage`, which imports this module —
 * the dependency only goes one way. The cost is that the ids in `RAIL_SETS`
 * have to match the garage's rail vehicle ids, and the type does not enforce
 * it; `garage.ts` builds its two rail entries FROM this table so a mismatch
 * shows up as a missing vehicle rather than as the wrong train.
 *
 * `page.tsx` renders the scene with `ssr: false`, so this only ever runs in the
 * browser; the guard is for module evaluation during the server pass.
 */
export const RAIL_SET_ID: RailSetId = (() => {
  if (typeof window === 'undefined') return 'train';
  const requested = new URLSearchParams(window.location.search).get('car');
  return requested && requested in RAIL_SETS ? requested as RailSetId : 'train';
})();

export const RAIL_SET = RAIL_SETS[RAIL_SET_ID];

const COUPLING_GAP = 0.9;
/**
 * Coaches when nothing has said otherwise — matches `DEFAULT_SETTINGS`.
 *
 * Five, because the coach got longer. A Mark 3 is 23.4 m against the 18.7 m of
 * the APT trailer it replaced, so six of them put the rake at 182 m against a
 * 170 m platform (`STATION.platformLength`) — six metres hanging off each end.
 * Five comes to 158 m and fits with room either side, and it is also how Grand
 * Central actually formed these sets: two power cars and five Mark 3s. The
 * slider still runs to `CARRIAGE_RANGE.max` for anyone who wants the overhang.
 */
export const DEFAULT_CARRIAGES = 5;

export interface FormationUnit {
  model: 'loco' | 'carriage';
  offset: number;
  flip: boolean;
  length: number;
  bogieCentres: number;
}

/**
 * The formation for a given number of coaches, memoised.
 *
 * Memoised because it is read per frame by the rail cameras, which need to know
 * where the rear cab is and how long the train is, and rebuilding an array of
 * a dozen objects sixty times a second to answer that would be silly. Eleven
 * possible answers, each built once.
 */
const formations = new Map<string, ReadonlyArray<FormationUnit>>();

function formation(
  count: number, tailEngine: boolean, setId: RailSetId,
): ReadonlyArray<FormationUnit> {
  const key = `${setId}:${count}:${tailEngine}`;
  const cached = formations.get(key);
  if (cached) return cached;
  // From the SET, not from `trainData` — which is the HST's file whatever is
  // selected. Reading it directly meant a Class 91 rake got its own models at
  // the HST's spacing: a 19.4 m power car placed as though it were 17.79, and
  // 18.66 m coaches on 23.365 m centres, which is 4.7 m of daylight between
  // every pair of them. The offsets and the models have to come from one place.
  const set = RAIL_SETS_ALL[setId];
  const loco = {
    model: 'loco' as const,
    length: set.loco.size[2],
    bogieCentres: set.loco.bogieCentres,
  };
  const coach = {
    model: 'carriage' as const,
    length: set.coach.size[2],
    bogieCentres: set.coach.bogieCentres,
  };
  const units: FormationUnit[] = [{ ...loco, offset: 0, flip: false }];
  // Walked back from the leading locomotive, buffer to buffer.
  let tail = loco.length / 2;
  for (let i = 0; i < count; i++) {
    const offset = tail + COUPLING_GAP + coach.length / 2;
    units.push({ ...coach, offset, flip: false });
    tail = offset + coach.length / 2;
  }
  if (tailEngine) {
    units.push({ ...loco, offset: tail + COUPLING_GAP + loco.length / 2, flip: true });
  }
  formations.set(key, units);
  return units;
}

export function formationFor(
  carriages: number, setId: RailSetId = RAIL_SET_ID,
): ReadonlyArray<FormationUnit> {
  return formation(Math.max(0, Math.round(carriages)), true, setId);
}

/** Overall length over the couplers, metres, for a given number of coaches. */
export function formationLength(carriages: number, setId: RailSetId = RAIL_SET_ID): number {
  const units = formationFor(carriages, setId);
  const last = units[units.length - 1];
  return last.offset + last.length / 2;
}

/**
 * The scripted service on the down line: one locomotive and its coaches.
 *
 * One engine, not two. The player's train has a cab at each end because it has
 * to be able to run the other way (`RAIL_HIDE_LEAD`, and the reverse that runs
 * at line speed); a service that only ever goes one way round the loop has no
 * use for a second engine and would spend 95 k triangles saying so.
 *
 * Five coaches rather than the player's six for the same reason it exists at
 * all — it is scenery, and it is on screen at the same time as the player's
 * own rake on the neighbouring track, so it wants to look like a *different*
 * train rather than a copy of theirs.
 */
export const SERVICE_CARRIAGES = 5;

export function serviceFormationFor(
  coaches: number, setId: RailSetId = RAIL_SET_ID,
): ReadonlyArray<FormationUnit> {
  return formation(Math.max(0, Math.round(coaches)), false, setId);
}

export const SERVICE_FORMATION = serviceFormationFor(SERVICE_CARRIAGES);

/** The default formation, for anything that has no settings to read. */
export const FORMATION = formationFor(DEFAULT_CARRIAGES);
export const FORMATION_LENGTH = formationLength(DEFAULT_CARRIAGES);

/** The coach, measured by `prepare-carriage.mjs`. */
export const CARRIAGE = {
  model: RAIL_SET.coach.model,
  /** Width (X), height (Y), length (Z), metres. */
  size: RAIL_SET.coach.size as [number, number, number],
  bogieCentres: RAIL_SET.coach.bogieCentres,
  /** No pantograph on a coach, so the body is the whole height. */
  bodyHeight: RAIL_SET.coach.size[1],
} as const;

/**
 * The rail cameras' geometry. See `RailCamera` for what each one does.
 *
 * Heights are over the rail head, and lengths in metres. The cab figures are
 * the real ones as near as the model allows: a Class 43 driver's eye is about
 * 2.9 m up, sitting a little left of the centreline.
 */
/**
 * The cab view hides the leading locomotive's body.
 *
 * The eye belongs in the cab — measured, it lands 8.3 m forward of the body
 * centre and 2.9 m over the rail, which is where a Class 43 driver sits. The
 * trouble is that the model has no cab interior: it is a single-sided shell, so
 * from inside it you see straight through the skin and the only things drawn
 * are the underframe and the bogies, apparently floating below you. Hiding the
 * unit you are sitting in is what every sim without a modelled cab does, and it
 * leaves the view the driver actually has — the line ahead, and the rest of the
 * formation behind.
 */
export const RAIL_HIDE_LEAD = true;

export const RAIL_CAMERA = {
  /**
   * The trailing three-quarter shot that replaces the car's chase rig on rails.
   *
   * The car's rig sits `5.9 x length / 4.287` behind the vehicle it is framing,
   * which for a locomotive is fifteen metres — and fifteen metres behind the
   * leading locomotive is *inside the first coach*. It was inside the second
   * engine even before the coaches arrived. So the rail chase stands off to one
   * side instead: far enough out to clear a 2.9 m body, high enough to look
   * along the roofs, and far enough back to hold the loco and the first few
   * coaches as the train works through a curve.
   */
  /**
   * `look` is metres down the train from the leading end, and **negative means
   * ahead of it** — which is the whole trick. Aimed 24 m down the train from a
   * camera 27 m back, the target sits three metres from the camera's own
   * position along the line and the shot comes out broadside: a coach flank
   * filling the frame. Aiming just in front of the locomotive instead puts it
   * centre-frame with the line ahead of it and the rake trailing off to one
   * side, which is what a chase camera is for.
   */
  chase: {
    back: 30, up: 10, side: 12, look: -8, fov: 58, fovBoost: 7,
    /**
     * Tucked into the tube where the line is enclosed — a 12 m offset is solid
     * rock inside a 6 m bore, looking through back-faced walls at a station
     * floating in the void. Close behind, low, just off the running line so the
     * loco does not fill the frame, blended on `telemetry.enclosed` like the
     * top and drone rigs.
     */
    boreBack: 17, boreUp: 4.4, boreSide: 1.6, boreLook: -4,
  },
  cab: { eye: 2.9, side: 0.55, ahead: 70, inset: 1.4 },
  /**
   * The plan view over the engine.
   *
   * Not *quite* straight down: a camera looking exactly along -Y has no way to
   * decide which way is up in frame, and `lookAt` gives a degenerate basis at
   * that point — the picture rolls or flips. Six metres back from twenty-six up
   * is a 13 degree tilt, which is enough to fix the roll and still reads as a
   * plan. It tucks into the tube underground for the reason the drone does:
   * twenty-six metres up is rock down there.
   */
  top: { up: 26, back: 6, look: 8, boreUp: 3.2, boreBack: 13, fov: 50 },
  /**
   * The nose shot sits just *outside* the coupler rather than inside it. The
   * model is a single-sided shell with no interior, so an eye a few centimetres
   * inside sees through its own skin — which is exactly what went wrong with
   * the cab eye. See `RAIL_HIDE_LEAD`.
   */
  nose: { eye: 1.15, ahead: 55, clear: 0.4 },
  cinematic: {
    /**
     * How far ahead of the train a shot is planted, and how far past the camera
     * the train runs before cutting — both scaled by speed, so a shot lasts
     * about the same time whatever the train is doing.
     *
     * A fixed lead cannot work at both ends of this train's range. 230 m is
     * right at 300 km/h and absurd at a standstill: the subject is a white
     * speck 230 m down a telephoto lens and it never gets closer. Scaling by
     * speed picks the train up at 80 m when it is stopped and 300 m when it is
     * flying, and holds each shot for roughly three and a half seconds.
     */
    leadPerSpeed: 3.2,
    leadBase: 70,
    leadMin: 80,
    leadMax: 300,
    holdPerSpeed: 0.9,
    /**
     * Plus the length of the train: the cut cannot come until the rake has
     * actually cleared the camera, or the shot ends with coaches still in it.
     */
    holdBase: 25,
    holdFormation: true,
    /** How far down the train a planted shot looks: the loco and its first coach. */
    look: 22,
    /** Where the camera stands, by what the line is doing there. */
    open: { side: 21, up: 7.5 },
    /** Over a city street the line is elevated: a rooftop shot, clear of the blocks. */
    street: { side: 13, up: 23 },
    /** Inside a bore there is nowhere to stand but the tube itself. */
    bore: { side: 3.1, up: 2.3 },
    fov: 40,
  },
  drone: {
    /**
     * Framed on the leading half rather than the whole train. A 147 m rake
     * needs about 170 m of standoff to fit in a 46 degree lens, at which point
     * it is a line of dots in a landscape; 60 m back holds the locomotive and
     * four coaches sweeping through, which is the shot worth having.
     */
    back: 70,
    up: 30,
    /**
     * How far down the train the shot looks. Well forward of the camera's own
     * position along the line, so the rake runs away diagonally rather than
     * across the frame — the same mistake the chase shot made first time.
     */
    look: 18,
    /** Radians per second the shot drifts round the train. */
    orbit: 0.055,
    /** Where it tucks to when the line goes underground and 28 m up is rock. */
    boreBack: 17,
    boreUp: 2.6,
    fov: 46,
  },
} as const;

/** Model, dimensions and bogie spacing, from `prepare-train.mjs`. */
export const LOCOMOTIVE = {
  model: RAIL_SET.loco.model,
  /** Width (X), height (Y), length (Z), metres. */
  size: RAIL_SET.loco.size as [number, number, number],
  /**
   * Distance between bogie centres. The locomotive is stood on the curve at
   * these two points rather than at one, and takes its heading and its pitch
   * from the chord between them — which is how a bogied vehicle actually sits
   * on track. On one point a 19.4 m body swings both ends off the rails
   * through every corner, and this line has 30 m radii in it.
   */
  bogieCentres: RAIL_SET.loco.bogieCentres,
  /**
   * Collider height, and NOT the measured one.
   *
   * The measurement takes in whatever stands proudest — a raised pantograph on
   * the Class 91, roof aerials on the Class 43 — and a box that tall would stop
   * a car two metres short of the body. Per set, from `RAIL_SETS`.
   */
  bodyHeight: RAIL_SET.bodyHeight,
} as const;

/**
 * How far the rail head stands above the formation the route file describes.
 *
 * The route's height is the *rail* height — that is what has to be graded, and
 * what a train's wheels sit on. Everything under it hangs off this: sleepers
 * below the rail, ballast below the sleepers, and the ground at the bottom. So
 * the route's ground height and its rail height differ by this much wherever
 * the fill is nominally zero, and the ballast comes out exactly resting on the
 * ground rather than buried in it or hovering over it.
 */
export const RAIL_HEAD_LIFT = TRAIN.ballastDepth + TRAIN.sleeperHeight + TRAIN.railHeight;

type RawPoint = [number, number, number, number, number | null, number, number, number, number?, number?, number?];
const RAW = route.points as RawPoint[];

/** Widens a flag by `radius` samples, so a structure covers its own transition. */
function dilate(flags: boolean[], radius: number): boolean[] {
  const n = flags.length;
  return flags.map((_, i) => {
    for (let d = -radius; d <= radius; d++) if (flags[(i + d + n) % n]) return true;
    return false;
  });
}

// A deck reaches one sample past the water or the deep fill that called for
// it, so the abutment lands on the bank; a tunnel does not, because the
// generator has already carried each bore out to where the ground meets the
// rail and its portal has to stand exactly there.
const isViaduct = dilate(RAW.map((p) => p[3] === VIADUCT), 1);
const isTunnel = RAW.map((p) => p[3] === TUNNEL);
const isCutting = RAW.map((p) => p[3] === CUTTING);
const overWater = dilate(RAW.map((p) => p[4] === null), 1);
const onRoad = RAW.map((p) => p[5] === 1);
const isEnclosed = RAW.map((p) => p[6] === 1);
// Reclaimed land the renderer has to build. Widened by one sample so the
// landform reaches the shore it abuts rather than stopping a step short.
const isMade = dilate(RAW.map((p) => p[7] === 1), 1);
// Carried over a street inside a drawn elevated span — see `ELEVATED` in the
// route finder. Not dilated: the structure must start and stop exactly where
// the street does, or its columns stand in the building at each end.
const isStreet = RAW.map((p) => p[8] === 1);

export interface TrainPoint {
  x: number;
  y: number;
  z: number;
  /** Ground under the rail, or sea level where the line is over water. */
  ground: number;
  structure: typeof BALLAST | typeof VIADUCT | typeof TUNNEL | typeof CUTTING;
  /**
   * Inside a tunnel *or* inside a gallery joining two of them — everything the
   * driver experiences as one continuous bore. `structure` still says what is
   * underneath, so a gallery keeps the deck and piers carrying it.
   */
  enclosed: boolean;
  /** Standing on causeway the railway reclaimed for itself — see `TrainLine`. */
  made: boolean;
  overWater: boolean;
  onRoad: boolean;
  /** Over a street inside a drawn elevated span: the street viaduct is built here. */
  street: boolean;
  /**
   * Distance from the line to the kerb on each hand, metres, on a `street`
   * point; 0 elsewhere. Carried in the route file and kept here, though the
   * renderer no longer builds from them: the elevated deck is a fixed width on
   * a centre pier now (see `TRAIN.elevated`).
   */
  kerbLeft: number;
  kerbRight: number;
  /** Cumulative arc length from the first point, metres. */
  arc: number;
}

export const TRAIN_POINTS: TrainPoint[] = RAW.map((p, i) => ({
  x: p[0],
  y: p[1],
  z: p[2],
  // Over water there is no ground, and what a pier stands in there is the sea.
  ground: p[4] ?? TRAIN.seaLevel,
  structure: isTunnel[i] ? TUNNEL
    : isViaduct[i] ? VIADUCT
      : isCutting[i] ? CUTTING : BALLAST,
  enclosed: isEnclosed[i],
  made: isMade[i],
  overWater: overWater[i],
  onRoad: onRoad[i],
  street: isStreet[i],
  kerbLeft: p[9] ?? 0,
  kerbRight: p[10] ?? 0,
  arc: 0,
}));

/** Total loop length, metres. Filled in alongside the per-point arc lengths. */
export const TRAIN_LENGTH: number = (() => {
  let acc = 0;
  for (let i = 0; i < TRAIN_POINTS.length; i++) {
    TRAIN_POINTS[i].arc = acc;
    const next = TRAIN_POINTS[(i + 1) % TRAIN_POINTS.length];
    acc += Math.hypot(next.x - TRAIN_POINTS[i].x, next.z - TRAIN_POINTS[i].z);
  }
  return acc;
})();

/** Wraps a distance into [0, TRAIN_LENGTH). */
export const trainWrap = (s: number) => ((s % TRAIN_LENGTH) + TRAIN_LENGTH) % TRAIN_LENGTH;

/** Index of the point at or before arc length `s`, and how far past it we are. */
function locate(s: number): { i: number; t: number } {
  const d = trainWrap(s);
  let lo = 0;
  let hi = TRAIN_POINTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (TRAIN_POINTS[mid].arc <= d) lo = mid; else hi = mid - 1;
  }
  const next = TRAIN_POINTS[(lo + 1) % TRAIN_POINTS.length];
  const span = (lo + 1 === TRAIN_POINTS.length ? TRAIN_LENGTH : next.arc) - TRAIN_POINTS[lo].arc;
  return { i: lo, t: span > 0 ? (d - TRAIN_POINTS[lo].arc) / span : 0 };
}

/** Rail-head position at arc length `s`. */
export function trainPointAt(s: number): [number, number, number] {
  const { i, t } = locate(s);
  const a = TRAIN_POINTS[i];
  const b = TRAIN_POINTS[(i + 1) % TRAIN_POINTS.length];
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t];
}

/**
 * Unit tangent in plan at arc length `s`.
 *
 * Taken as a central difference across the straddling points rather than along
 * the one segment `s` falls in, so a vehicle's heading changes continuously
 * instead of snapping at every vertex of the polyline.
 */
export function trainTangentAt(s: number): [number, number] {
  const { i } = locate(s);
  const n = TRAIN_POINTS.length;
  const a = TRAIN_POINTS[(i - 1 + n) % n];
  const b = TRAIN_POINTS[(i + 2) % n];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  return [dx / length, dz / length];
}

/**
 * Speed limit along the line, from its own curvature.
 *
 * The route is a searched path smoothed into a curve, not a surveyed alignment,
 * so what comes out has 30 m radii in places — tram corners, not main-line
 * ones. A locomotive taken round one of those at line speed does not look fast,
 * it looks broken: 25 m/s through a 30 m radius is 20 m/s² sideways, and the
 * body visibly snaps round rather than sweeping. Real railways answer this with
 * permanent speed restrictions, and so does this.
 *
 * The radius comes from the circle through three points either side, and the
 * limit from `sqrt(a * r)`. `LATERAL` is a game figure and not a small one: a
 * real line holds lateral acceleration to about 1 m/s², which would put the
 * tightest corner here at 10 km/h and the median at 38, and make the loop a
 * chore. At 12 the median is about 130 km/h and only the genuinely tram-tight
 * corners bind, which is what lets a 250 km/h ceiling mean anything. **This is
 * the number to change** if the line feels too loose or too restrictive; the
 * shape is right either way — slow for the corners, run on the straights, and
 * see it coming.
 */
const LATERAL = 12;
const CURVE_SPAN = 3;

/**
 * What a dead-straight stretch reports, m/s.
 *
 * Not `Infinity`, though that is the honest answer to "how tight is this
 * corner" when three samples are collinear. The table is **interpolated**, and
 * `SPEED_LIMIT[i] + (next - SPEED_LIMIT[i]) * t` between two infinities is
 * `Infinity + (Infinity - Infinity) * t`, which is NaN.
 *
 * One NaN is permanent and total. `Math.min(TRAIN.speed, NaN)` is NaN, so it
 * goes into a service's target speed, out into its arc, and every lookup from
 * that arc returns NaN in turn — the train stops existing at a position and
 * never recovers. It stayed hidden while there was one service on each road,
 * because neither happened to be seeded on a straight; raising `TRAIN.count`
 * to four put one at arc 5794 and it was dead on arrival.
 *
 * 200 m/s is 720 km/h — far above anything this line can do, so it means the
 * same thing as no restriction, and it survives being subtracted from itself.
 */
const UNRESTRICTED = 200;

const SPEED_LIMIT: number[] = (() => {
  const n = TRAIN_POINTS.length;
  const raw = TRAIN_POINTS.map((_, i) => {
    const a = TRAIN_POINTS[(i - CURVE_SPAN + n) % n];
    const b = TRAIN_POINTS[i];
    const c = TRAIN_POINTS[(i + CURVE_SPAN) % n];
    // Circumradius from the triangle's sides and area.
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area = Math.abs(
      (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z),
    ) / 2;
    // Three points in a line have no circle and no restriction.
    const radius = area < 1e-6 ? Infinity : (ab * bc * ca) / (4 * area);
    return Math.min(UNRESTRICTED, Math.sqrt(LATERAL * radius));
  });
  // Smoothed so the limit eases rather than stepping, and taken as a running
  // minimum first so a single tight sample is not averaged away by its
  // neighbours — the restriction has to cover the corner, not approximate it.
  const floor = raw.map((_, i) => {
    let lowest = Infinity;
    for (let d = -CURVE_SPAN; d <= CURVE_SPAN; d++) {
      lowest = Math.min(lowest, raw[(i + d + n) % n]);
    }
    return lowest;
  });
  // Eased with a small kernel so the restriction changes over tens of metres
  // rather than stepping at a sample boundary.
  let eased = floor;
  for (let pass = 0; pass < 4; pass++) {
    eased = eased.map((_, i) => (
      eased[(i - 2 + n) % n] + 4 * eased[(i - 1 + n) % n] + 6 * eased[i]
      + 4 * eased[(i + 1) % n] + eased[(i + 2) % n]
    ) / 16);
  }
  return eased;
})();

/**
 * The overhead line's dimensions, shared.
 *
 * These lived in `Lineside`, which was fine while the only wired tracks were
 * the two the running line carries. The station wires its loops too, from a
 * different file, and a contact wire that meets the line's at a different
 * height is a wire that steps in mid-air where the loop joins — so the numbers
 * have to be one set rather than two copies.
 */
export const CATENARY = {
  /** Spacing of masts, and of the portals that replace them in the station. */
  mastPitch: 54,
  /** Contact wire over the rail, a metre clear of a 3.9 m roof. */
  contact: 4.95,
  messenger: 6.35,
  /** How far the messenger sags at mid-bay. */
  sag: 0.5,
  /** The contact wire's lateral zigzag, so the pantograph head wears evenly. */
  stagger: 0.22,
  mastTop: 7.9,
  /** How far a mast stands off the centre of the track it registers. */
  mastOff: 3.3,
  dropperPitch: 9,
} as const;

/**
 * Where a locomotive sits and how it is turned, for a given distance travelled.
 *
 * Taken from **two** points of the curve, the bogie centres, not one. That is
 * not a refinement: the line has 30 m radii and the body is 19.4 m, so a
 * single-point placement swings both ends a metre and a half clear of the
 * rails through every corner. The chord between the bogies is what the real
 * vehicle sits on, and it supplies the pitch for nothing extra — which matters
 * on a line allowed 6%.
 *
 * Angles rather than a matrix, so this module stays free of three.js and both
 * the scripted locomotive and the driven one build their transform the same
 * way. The models face -Z, so a direction `(fx, fy, fz)` is yaw
 * `atan2(-fx, -fz)` and pitch `asin(fy)`, applied in that order — Euler `YXZ`.
 */
export function locomotivePose(
  travelled: number, direction: 1 | -1 = 1,
  lateral: number | ((arc: number) => number) = 0,
  bogieCentres = LOCOMOTIVE.bogieCentres,
) {
  // `bogieCentres` is the vehicle's own: a coach is 18.7 m long on 14.5 m
  // centres against the locomotive's 19.4 on 10.5, and standing one on the
  // other's figure would leave its ends off the rails through every corner.
  const half = bogieCentres / 2;
  const offsetAt = typeof lateral === 'function' ? lateral : () => lateral;

  /**
   * Where one bogie stands: on the running line at `arc`, moved out by the
   * lateral offset OF THAT ARC.
   *
   * Per bogie, and that is what makes a train on a loop stop drifting. This
   * used to take both bogie points off the running line, read the yaw from the
   * chord between them, and only then shift the whole body sideways by the
   * offset at its centre — so on a diverging road the vehicle kept the MAIN
   * LINE's heading while translating along the loop. At 1 in 6.7 on the outer
   * loop that is a crab of eight and a half degrees: the body visibly slides
   * across the rails instead of turning onto them, which is the drift.
   *
   * Offsetting each bogie first and taking the chord afterwards gives both the
   * position and the heading of the road actually under the wheels, and it
   * costs one extra normal lookup. It also chords the curve the way a rigid
   * two-bogie vehicle really does, rather than tracking the centreline exactly.
   */
  const bogie = (arc: number): readonly [number, number, number] => {
    const [x, y, z] = trainPointAt(arc);
    const off = offsetAt(arc);
    if (!off) return [x, y, z] as const;
    const [nx, nz] = trainNormalAt(arc);
    return [x + nx * off, y, z + nz * off] as const;
  };

  // `direction` -1 runs the loop the other way: the front bogie is then at the
  // lower arc, so the yaw comes out facing the way the vehicle is going rather
  // than the way the arc increases.
  const [fx, fy, fz] = bogie(travelled + direction * half);
  const [rx, ry, rz] = bogie(travelled - direction * half);
  const dx = fx - rx;
  const dy = fy - ry;
  const dz = fz - rz;
  const length = Math.hypot(dx, dy, dz) || 1;
  return {
    x: (fx + rx) / 2,
    y: (fy + ry) / 2 + RAIL_HEAD_LIFT,
    z: (fz + rz) / 2,
    yaw: Math.atan2(-dx / length, -dz / length),
    pitch: Math.asin(Math.max(-1, Math.min(1, dy / length))),
  };
}

/** Line speed limit at arc length `s`, m/s, before the vehicle's own ceiling. */
export function trainSpeedLimitAt(s: number): number {
  const { i, t } = locate(s);
  const next = SPEED_LIMIT[(i + 1) % SPEED_LIMIT.length];
  return SPEED_LIMIT[i] + (next - SPEED_LIMIT[i]) * t;
}

/** Left-hand normal at arc length `s`. Sign convention matches `railNormalAt`. */
export function trainNormalAt(s: number): [number, number] {
  const [tx, tz] = trainTangentAt(s);
  return [tz, -tx];
}

/** What the line is standing on at arc length `s`. */
export function trainStructureAt(s: number) {
  return TRAIN_POINTS[locate(s).i].structure;
}

/** Whether arc length `s` is inside a bore or a gallery joining two of them. */
export function trainEnclosedAt(s: number): boolean {
  return TRAIN_POINTS[locate(s).i].enclosed;
}

/** Whether arc length `s` is carried over a city street — see `TrainPoint.street`. */
export function trainStreetAt(s: number): boolean {
  return TRAIN_POINTS[locate(s).i].street;
}

/**
 * The bores as a chain of straight segments, for cutting the terrain.
 *
 * `CityMap` discards every terrain fragment inside a horseshoe swept along
 * these, which is what makes a tunnel a hole in the hill rather than a lining
 * drawn inside solid ground. The Y is the rail head, which is what the lining
 * is built off.
 *
 * Split adaptively rather than every N points. A fixed pitch has to be short
 * enough for the tightest curve on the line, and at 12 m ten bores came to 147
 * segments — over the shader's limit, so the last tunnels were not cut at all
 * and the hillside showed through the floor of the bore. Here a segment runs
 * as far as it can while every point it skips stays within `CHORD_TOLERANCE`
 * of the chord, so a straight bore is one segment and a curved one is only as
 * finely divided as it has to be.
 */
const CHORD_TOLERANCE = 0.35;

/** Perpendicular distance from `p` to the segment a-b, in plan. */
function deviation(a: TrainPoint, b: TrainPoint, p: TrainPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return Math.abs((p.x - a.x) * (dz / len) - (p.z - a.z) * (dx / len));
}

/**
 * Runs of one structure, chained into as few straight segments as the curve
 * allows — a segment runs on while every point it skips stays within
 * `CHORD_TOLERANCE` of the chord.
 *
 * A fixed pitch has to be short enough for the tightest curve on the line, and
 * at 12 m ten bores came to 147 segments: over the shader's limit, so the last
 * tunnels were not cut at all and the hillside showed through the floor of the
 * bore.
 */
/** A carve segment: two endpoints, plus each endpoint's arc length so the consumer can offset it. */
export type CarveSegment = [number, number, number, number, number, number, number, number];

function chainOf(
  want: (p: TrainPoint) => boolean,
  pad: number,
): CarveSegment[] {
  const out: CarveSegment[] = [];
  const n = TRAIN_POINTS.length;
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && want(TRAIN_POINTS[i]);
    if (on && start < 0) start = i;
    if (on || start < 0) continue;

    // Padded a sample either way, so a cut meets its neighbour rather than
    // leaving a rib of terrain at the joint.
    const first = Math.max(0, start - pad);
    const last = Math.min(n - 1, i - 1 + pad);
    let from = first;
    while (from < last) {
      let to = from + 1;
      while (to < last) {
        let worst = 0;
        for (let k = from + 1; k < to + 1; k++) {
          worst = Math.max(worst, deviation(TRAIN_POINTS[from], TRAIN_POINTS[to + 1], TRAIN_POINTS[k]));
        }
        if (worst > CHORD_TOLERANCE) break;
        to++;
      }
      const a = TRAIN_POINTS[from];
      const b = TRAIN_POINTS[to];
      out.push([a.x, a.y + RAIL_HEAD_LIFT, a.z, b.x, b.y + RAIL_HEAD_LIFT, b.z, a.arc, b.arc]);
      from = to;
    }
    start = -1;
  }
  return out;
}

/**
 * The bores, for cutting the terrain. `CityMap` discards every terrain fragment
 * inside a horseshoe swept along these, which is what makes a tunnel a hole in
 * the hill rather than a lining drawn inside solid ground.
 */
export const tunnelSegments = () => chainOf((p) => p.structure === TUNNEL, 1);

/** Rail below the ground it passes through, by enough to matter. */
const BURIED = (p: TrainPoint) => p.structure !== TUNNEL
  && p.ground > p.y + CUTTING_COVER;
const CUTTING_COVER = 0.3;

/**
 * The open approaches, cut as a trench rather than a horseshoe: everything
 * above the rail between its walls is removed, so the line emerges from the
 * hillside through an excavation instead of driving straight into a slope.
 */
export const cuttingSegments = () => chainOf(BURIED, 1);

/**
 * Anything the ground closes over, whatever the generator called it.
 *
 * Keyed on where the rail actually is rather than on the structure, because the
 * structure can be right about what carries the line and still wrong about
 * whether it is buried. A viaduct is the case that bit: the classifier makes a
 * point VIADUCT whenever it crosses a road or water, without asking what the
 * ground beside it does, and one deck ended up 3.5 m inside a bank. It was
 * built correctly, it just had a hillside in front of it — from the cab, grass
 * growing over the rails.
 *
 * Cut it as a trench, like a cutting, since that is what it is.
 */

/** Summary from the generator, for the docs and the HUD. */
export const TRAIN_ROUTE_STATS = {
  lengthMetres: route.lengthMetres,
  minRadiusMetres: route.minRadiusMetres,
  bridgeCount: route.bridgeCount,
  bridgeSpansMetres: route.bridgeSpansMetres,
  tunnelCount: route.tunnelCount,
  tunnelLengthsMetres: route.tunnelLengthsMetres,
  enclosedCount: route.enclosedCount,
  enclosedLengthsMetres: route.enclosedLengthsMetres,
} as const;

/**
 * How far into an enclosed stretch arc length `s` is: the distance along the
 * line to the nearest point that is open to the sky, in either direction. Zero
 * anywhere in the open, and at a portal; growing linearly into a bore.
 *
 * This, not `trainEnclosedAt`, is what daylight does: it does not stop at the
 * portal, it fades over the first fifty or a hundred metres. Two passes round
 * the ring each way seed the distances across the wrap.
 */
const OPEN_DISTANCE = (() => {
  const n = TRAIN_POINTS.length;
  const step = n ? TRAIN_LENGTH / n : 1;
  const ahead = new Float32Array(n);
  const behind = new Float32Array(n);
  let d = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n - 1; k >= 0; k--) {
      d = TRAIN_POINTS[k].enclosed ? d + step : 0;
      ahead[k] = d;
    }
  }
  d = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      d = TRAIN_POINTS[k].enclosed ? d + step : 0;
      behind[k] = d;
    }
  }
  return { ahead, behind, step };
})();

/** Metres of cover along the line from arc `s` to the nearest open point; 0 in the open. */
export function trainDepthAt(s: number): number {
  if (!TRAIN_POINTS.length) return 0;
  const { i, t } = locate(s);
  const { ahead, behind, step } = OPEN_DISTANCE;
  const forward = ahead[i] - t * step;
  const backward = behind[i] + t * step;
  return Math.max(0, Math.min(forward, ahead[i] === 0 ? 0 : backward));
}

/** Metres into a bore over which daylight gives out. */
export const DARK_FADE = 95;

/**
 * How dark it is at arc `s`, 0 in the open to 1 deep underground: a smoothstep
 * of `trainDepthAt` over `DARK_FADE`. The one curve the world lights
 * (`Environment`), the headlamps and anything else that cares about daylight
 * underground all read, so they agree.
 */
export function trainDarknessAt(s: number): number {
  const u = Math.min(1, Math.max(0, trainDepthAt(s) / DARK_FADE));
  return u * u * (3 - 2 * u);
}
