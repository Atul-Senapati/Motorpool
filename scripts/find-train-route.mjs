/**
 * Lays a main-line railway around the city: on grass where it can, on
 * structures where it must, and never on a street.
 *
 * The tram's route (`find-tram-route.mjs`) runs down city streets and is made
 * of straights and right-angle corners. A railway is a different animal: it
 * wants open ground, it goes *around* the city rather than through it, it will
 * not tolerate a sharp corner, and to ring the outlying districts in the west it
 * has to cross water.
 *
 * How it works:
 *
 *  1. **Classify the world** from `cityNav.png` and `cityData.json` into grass,
 *     road, water and building. Grass is land with no road and no building on
 *     it. Water is anywhere the height raster holds its floor value — what the
 *     map uses for "nothing here" — *and* any land below `SHORE_LEVEL`: the
 *     raster carries the foreshore down to -3.6 m, and a line laid along it runs
 *     through the map's own lagoons.
 *  2. **Hang the tour off a coastal ring.** For each of several bearings out
 *     from the landmass centroid, take the furthest land on that ray — the outer
 *     coast, past any bay — step back inland, and settle on the lowest patch of
 *     grass nearby. A ring like that goes round the city *and* the outlying
 *     districts by construction. (The first version hung it off the road
 *     network's connected components. Those areas are joined by road causeways,
 *     so flood-filling the roads returned one blob and the anchors from it were
 *     nonsense.)
 *  3. **A\* between consecutive anchors, with heading as part of the state.**
 *     Each cell is eight states — one per direction of arrival — so a change of
 *     heading can be charged for. That is what keeps the plan from zig-zagging:
 *     a plain grid search is free to turn 45° at every cell, and its output is a
 *     staircase that no amount of smoothing turns into track. Turns cost, sharp
 *     turns cost more, and anything over 90° is not allowed at all. Grass is
 *     cheap, road dear, water a large fixed cost to start a bridge plus a modest
 *     one per metre; climb is charged by the metre and height above the plain
 *     directly.
 *  4. **Fillet every corner with a circular arc**, at the largest radius the
 *     adjacent straights allow, up to `R_MAX`. This is what railway geometry
 *     actually is — straights and arcs — and it is why the finished line can be
 *     described honestly by a minimum curve radius. An arc that would cut
 *     through a building is retried tighter.
 *  5. **Resample at a uniform pitch and classify again** from the raster at the
 *     new positions, because the fillets have moved the line.
 *  6. **Grade the profile** between a slope-limited envelope at or above the
 *     ground and one at or below it, biased towards cut. Water and road both
 *     impose a hard floor — the deck must clear the sea, and it must clear the
 *     traffic — taken as a maximum so the grade guarantee survives.
 *  7. **Assign structures**: viaduct where the fill is deep, tunnel where the
 *     cover is, and viaduct over every road and every water cell whatever the
 *     fill, so the line never touches a street. Flicker is tidied into real
 *     structures, and each tunnel is carried outward to where the ground meets
 *     the rail, so its portal stands at the foot of the hill and not inside it.
 *
 * Emits `src/config/trainRoute.json`: a dense closed polyline, already smooth,
 * carrying rail height, ground height and a structure flag per point. Nothing
 * is generated at runtime.
 *
 * Run with: npm run route:train  (optionally with a seed)
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const SKETCH = 'src/config/trainSketch.json';
const NAV_IMAGE = 'public/models/cityNav.png';
const OBSTACLE_IMAGE = 'public/models/cityObstacles.png';
const CITY_DATA = 'src/config/cityData.json';
const OUT = 'src/config/trainRoute.json';
/** A picture of the result, because a route is otherwise ten thousand numbers. */
const PREVIEW = process.env.ROUTE_PREVIEW ?? 'route-preview.png';

/** Pathfinding grid pitch, metres. The raster is 1.5 m; this is plenty fine. */
const CELL = 6;
/** Output pitch along the finished curve, metres. */
const STEP = 6;
/**
 * Longest water span that counts as a bridge rather than a land reclamation.
 *
 * Generous, and deliberately. Ashore the only ground left after the buildings
 * and the trees have taken their clearance is a set of narrow winding
 * corridors, and a line threaded through those is all corners — 83 of them at a
 * 17 m median radius, which is a fairground ride, not a railway. The sea is the
 * only open ground on this map. Letting the loop run offshore buys the long
 * straights and the big radii, and it is what a coastal main line does.
 */
const MAX_BRIDGE = 4000;
/**
 * Clearance kept from the two kinds of obstacle, metres — see
 * `make-obstacle-map.mjs`, which writes solid in red and vegetation in green.
 *
 * Different numbers because they are different things: eight metres from a
 * building is the structure gauge and then some, where a railway fells the
 * trees in its way and clips the canopies of the rest. Given the same eight
 * metres the lineside trees close every corridor in the green hinterland, and
 * the only loop left is five kilometres of viaduct on forty-metre embankments.
 *
 * Six is the floor for either, though, whatever the reasoning: the tunnel bore
 * is 5.25 m to the outside of the lining, so anything nearer than that stands
 * *inside* the tunnel. At three, a tree did — it hung in the bore at the 2.4 km
 * mark like a stalactite. Nothing may be closer than the widest structure the
 * line is built from.
 *
 * Both replace a margin round `cityData.boxes`, which was the wrong data
 * entirely: those are collider boxes capped at a 40 m footprint, so every
 * larger building was missing from them, and vegetation was never in them at
 * all. The line went through both.
 */
// Raised from 8. The grid is 6 m, so a clearance measured from cell centres can
// come out 4 m short of what it says, and the west leg was running viaduct
// within 6 m of the district's facades in three places — a 10 m deck 6 m from a
// wall is through the building as far as anyone looking at it is concerned.
const SOLID_CLEARANCE = 14;
const TREE_CLEARANCE = 6;
/**
 * Land at or below this is treated as water. The nav raster carries the beach
 * and the seabed down to -3.6 m, and the map draws its own shallow water over
 * the top of it; a line laid on the foreshore therefore ran *through* the
 * lagoons. The streets sit at exactly 0.0-0.2 m — 70% of all land cells — the
 * dry sand runs down to about -1, and the wet sand and the map's own water
 * surface sit at -1.5 and below, so the line goes between. (Set at +0.3 on the
 * assumption that streets were above it, this drowned the city; at -0.5 it
 * took the whole beach and put the western half of the loop on a viaduct.)
 */
const SHORE_LEVEL = -1.2;

/** Per-cell traversal costs. Grass is the unit; everything else is a multiple. */
/**
 * Road at 200 is nearly a wall, and is meant to be: at 30 and 60 the search
 * happily ran the eastern leg straight down the city's street edge, crossing a
 * road every hundred metres, because that was fewer *turns* than following the
 * coast round the green hinterland. A street crossing has to cost more than a
 * long way round, or the line never leaves the city.
 */
const COST = { grass: 1, road: 200, water: 40 };
/**
 * What it costs to *start* a bridge, on top of the per-cell water price.
 *
 * A flat per-cell water price cannot express what an engineer weighs: price
 * water high and the line walks round every bay however long the detour, price
 * it low and it nibbles across every puddle. A large fixed cost plus a modest
 * per-metre one takes a crossing exactly when it saves more ground than it
 * costs. Higher than it was, so the line crosses where the loop needs it —
 * out to the western districts and back — and not for a short cut.
 */
const BRIDGE_ENTRY = 25;
/**
 * What a change of heading costs, per 45° step, in grass-cell units.
 *
 * This is the single most important number for how the line *looks*. At zero
 * the search turns whenever it is fractionally shorter to, and the plan is a
 * staircase. At 40 a 45° turn costs the same as 240 m of extra grass, so the
 * search takes one long diagonal instead of twenty short ones, and the corners
 * that remain are far enough apart to be filleted at a real radius.
 */
const TURN_COST = 250;
/** What a metre of climb costs, in grass-cell units. See the header. */
const GRADE_COST = 12;
/**
 * Height above the coastal plain, charged per metre per cell. Low, so the line
 * is willing to go *through* a hill rather than round it — that is where the
 * tunnels come from.
 */
const PLAIN_TOP = 6;
const HEIGHT_COST = 0.1;
/**
 * Steepest the finished track may be, as a fraction — see `gradeProfile()`.
 * Main line holds 1-2.5%; 4% is a steep but real main-line figure, and the
 * cost of it against 6% is longer tunnels and longer viaducts, which is wanted.
 */
// 2%, down from 4%. The line went up and down with the ground it crossed — a
// 25.6 m height span and 67 m of climbing round a 6.6 km loop — and a railway
// does not: it holds a level and lets the structures take the difference. At
// 2% with longer vertical curves the span is 13.5 m and the climb 32 m, with
// the horizontal alignment, the bores and the viaducts unchanged. Measured on
// scratch copies before it was made live; see HANDOFF.
const RULING_GRADE = 0.02;
/** Fill deeper than this is not an embankment any more; it is a viaduct. */
const VIADUCT_FILL = 2.2;
/**
 * Cover needed over the rail before a bore is really a bore, metres.
 *
 * The tunnel arch stands 8.5 m over the rail, so with less than that above it
 * the hill does not enclose the bore — it clips the top off it. Set at 2.5,
 * every tunnel mouth ended up as a free-standing concrete arch in a flat field
 * with the "hill" a metre high behind it. Nine metres is the arch plus a little.
 */
// Must clear the CARVED arch, not the lining.
//
// The lining's apex is `boreWall + boreHalf` = 8.5 m over the rail, and the
// shader carves half a metre proud of that, so the hole taken out of the
// terrain reaches 9.1 m. At a cover of 9 the hole came out 10 cm below the
// surface — and on any undulation, above it: a horseshoe-shaped opening
// hovering in the middle of a flat grass field, looking down into the tunnel,
// with no portal because it is nowhere near the end of the bore. Thirteen
// leaves four metres of ground over the crown of the excavation.
const BORE_COVER = 14;

/**
 * Cover at which the line stops being a trench and becomes a bore.
 *
 * Separate from `BORE_COVER`, which is what the *grading* aims for when it
 * dives under something. This is what the *classifier* uses, and conflating the
 * two put an open cutting under thirty metres of hill: with 11.6 m of cover the
 * point missed the 13 m bar, came out CUTTING, and the shader carved it as a
 * trench — bounded at `uCuttingTop`, so it never reached daylight and left an
 * unlined slot buried inside the hill with the underside of the hill for a
 * roof. Nothing about that is visible from outside, which is why it survived.
 *
 * The real question is not "is there a lot of ground above" but "would an open
 * trench here reach the surface". The carved arch stands 9.1 m over the rail,
 * so anything with more cover than that plus a margin has to be roofed.
 */
// Must equal `TRAIN.cuttingMaxDepth`, which is how deep the shader will carve a
// cutting. Below it a trench reaches daylight; above it the ground has to be
// roofed. Setting the two independently leaves either a band where a cutting
// cannot reach the surface — an unlined slot buried in the hill — or bores with
// barely a metre over the carved arch, which break out as a hole in the grass.
const TUNNEL_MIN_COVER = 14;
/**
 * Between a bore and daylight the line runs in an open **cutting**: the ground
 * is above the rail but not by enough to bury a tunnel. It is excavated rather
 * than roofed, which is what puts the portal at the point where the hillside is
 * actually deep enough to drive a tunnel into.
 */
const CUTTING_COVER = 0.3;

/**
 * Where the sea surface sits, and how much air a bridge must leave under it.
 * SEA_LEVEL is duplicated in `trainConfig.TRAIN.seaLevel`; the two must agree.
 */
const SEA_LEVEL = -3.6;
const BRIDGE_CLEARANCE = 6;
/** Air a deck must leave over a street it crosses. Trucks are 4.5 m. */
const ROAD_CLEARANCE = 5.5;
/**
 * How the alignment splits the difference between embankment and tunnel. 0 is
 * as low as the grade allows (all tunnel), 1 as high (all fill). Biased hard
 * towards cut, because tunnels are what is wanted here: the line should go
 * *through* the rises rather than be carried over the dips.
 */
const CUT_FILL_BALANCE = 0.1;
/** Passes of profile smoothing — see `gradeProfile()`. Thirty is about 110 m. */
const PROFILE_SMOOTHING = 80;
/**
 * How far the plan may be straightened from the searched cells, metres. Large,
 * because it is bounded by buildings rather than by fidelity to the search: the
 * search's cells are a means to an alignment, not the alignment, and any run
 * of them that a clear straight can replace should be. At 7 m the one-cell
 * jogs round building margins survived and came out as 2 m corners.
 */
const SIMPLIFY_TOLERANCE = 45;
/** Corner radii: the most the fillet will ask for, and the least it will accept quietly. */
const R_MAX = 620;
const R_MIN = 60;
/**
 * Corners tighter than this are candidates for having their vertex dropped, so
 * their neighbours can take the turn between them at a decent radius. Set above
 * `R_MIN`, not at it: aiming only at what is already unacceptable leaves a
 * crowd of corners sitting just the right side of the line.
 */
const DROP_BELOW = 250;
/** Longest a single straight may stay underground, metres. */
const MAX_BORE_RUN = 650;
/**
 * Land the line builds for itself where it would otherwise be on an endless
 * viaduct over the sea.
 *
 * The map only has one piece of open ground with room for real railway
 * geometry, and it is the water. Ashore, the corridors left between the
 * buildings and the trees are narrow and winding: the best loop that stays on
 * land is 5.2 km with a 72 m median curve radius. Offshore it is 8.6 km at
 * 180 m — but six and a half kilometres of that is bridge, which reads as a
 * pier, not a railway.
 *
 * Sparing. Anything shorter than `MIN_CAUSEWAY` is bridged, which is what a
 * bridge is for; only the long crossings get a little land built under them,
 * broken by bridged channels every `CHANNEL_EVERY` so the result is a chain of
 * embankments and spans. Built at scale — two thirds of a loop — it looked like
 * exactly what it was, land invented in the middle of open water; used for the
 * odd long gap it reads as reclamation, which is a thing that happens.
 */
const CAUSEWAY_FREEBOARD = 2.2;
/** A channel this long is left open roughly this often along a causeway. */
const CHANNEL_EVERY = 420;
const CHANNEL_LENGTH = 132;
/** Runs of water shorter than this are simply bridged; not worth reclaiming. */
// Infinity: no reclamation. Every water crossing is bridged, however long.
// Making land is the one thing this is not allowed to do — asked for directly,
// and right anyway: a causeway across a bay reads as a dam, and the two islands
// are the only ground the line is permitted to invent.
const MIN_CAUSEWAY = Infinity;

/** Largest sub-loop, as a fraction of the whole, that counts as a spur to cut. */
const DESPUR_MAX = 0.12;

/** Structures shorter than this are not worth building; gaps shorter than this merge. */
const MIN_STRUCTURE = 30;
const MIN_GAP = 48;
/**
 * Two bores closer together than this are one stretch, and the gap between them
 * is enclosed rather than left open.
 *
 * Where the gap is a saddle the enclosure is a covered way over the cutting;
 * where it is a gorge it is a gallery on the piers that were carrying it
 * anyway. Both are real structures, and both are why this is a *join* rather
 * than simply calling the gap tunnel: a bore drawn across open water has no
 * hill to be cut out of and would hang over the sea.
 *
 * 400 m rather than 260, because at 260 short lengths of open viaduct were
 * still left standing between bores a couple of hundred metres apart, which is
 * the thing this is for. Not much more, either: at 1200 the joins chain, and
 * the loop comes back as one 4.8 km enclosed run out of 5.6 — a railway that
 * never sees daylight.
 *
 * Raised from 140 to 450 on request, to close the 402 m gap between T2 and T3
 * across the southern bay. That gap is open water, so the joined stretch is a
 * tube spanning it with no deck and no piers under it — the join now converts
 * the structure to TUNNEL, and TUNNEL has neither. Which pairs this catches is
 * worth checking after any reroute: at 450 the only gap in range is that one
 * (the others are 876 m and 4,741 m), and the value wants re-examining rather
 * than inheriting if those change.
 */
const TUNNEL_JOIN = 450;
/** Retry with water this much dearer each time a span comes out too long. */
const WATER_ESCALATION = 2;
const MAX_ATTEMPTS = 4;
/**
 * Nothing west of this is routed over.
 *
 * Off. The two outlying western districts are street grids down to the beach,
 * so the line cannot cross them on the surface — but it can now go *under*
 * them, which is what `BORE_COST` is for, so there is no reason to shut them
 * out of the loop. Set it to a number to exclude everything west of it again.
 */
const WEST_LIMIT = -Infinity;

/**
 * How far either side of the drawn line the search may wander, metres.
 *
 * The route is no longer chosen — it is traced from a sketch (`trainSketch.json`)
 * and this is the width of the corridor A* is allowed to use inside it. It is
 * not zero, because the trace is only good to about +/- 40 m and because the
 * search is what keeps the line out of buildings and off the roads where the
 * corridor touches land. It is not wide either: the whole point of a drawn
 * route is that the line goes where it was drawn, and a corridor much wider
 * than this lets the search cut its own corners across the bays.
 */
const CORRIDOR_HALF = 150;

/**
 * Crown height of the two islands that are created for the northern crossing.
 *
 * They exist because the sketch runs the line straight across open water for
 * 2.4 km, and a single span that long is not a bridge, it is a causeway with
 * ideas. Two islands break it into four crossings none of which is over a
 * kilometre. Height is freeboard over `SEA_LEVEL` plus enough to bury the
 * formation, and matches what `TrainLine` builds them at.
 */
const ISLAND_HEIGHT = 3.2;

/**
 * Kept for the output header and the CLI, though nothing random is left: the
 * anchors used to be a ring of bearings jittered by a seeded RNG, and are now
 * a deterministic farthest-point sample. Passing a seed changes nothing today.
 */
const seed = Number(process.argv[2] ?? 1);

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------------------------------------------------------------------------
// 1. Classify the world.
// ---------------------------------------------------------------------------
const sketch = JSON.parse(readFileSync(SKETCH, 'utf8'));
const { ox: SK_OX, oz: SK_OZ, scale: SK_SCALE } = sketch.transform;
/** Sketch pixels -> world metres. */
const fromSketch = ([sx, sy]) => [SK_OX + SK_SCALE * sx, SK_OZ + SK_SCALE * sy];
const DRAWN = sketch.route.map(fromSketch);
/**
 * Spans the drawing marks as open cut, whatever the cover works out at.
 *
 * The classifier decides tunnel-versus-surface from cover alone, which is right
 * almost everywhere and wrong at the end of a headland: the bore stops where
 * the hill stops, so T1 daylighted flush in a sea cliff and threw the line
 * straight out onto a viaduct. Carrying it on is a decision about how the
 * railway should read, not something cover can answer, so it is said here
 * instead, per location — and over water it becomes a covered way, the same
 * structure the tunnel joiner builds across a gap.
 */
const FORCED_BORES = (sketch.bores ?? []).map((c) => ({
  from: fromSketch(c.from),
  to: fromSketch(c.to),
}));
const FORCED_HALF = 30;
const onSpan = (spans, x, z) => spans.some((c) =>
  Math.sqrt(segDist2(x, z, c.from[0], c.from[1], c.to[0], c.to[1])) <= FORCED_HALF);
const ISLANDS = sketch.islands.map((i) => ({
  name: i.name,
  outline: i.outline.map(fromSketch),
}));
/**
 * Drawn spans the line is to be carried down the middle of a street.
 *
 * Everywhere else the search keeps off the roads — a 12 m street costs
 * `COST.road`, which is a refusal — and where a drawn vertex lands on built
 * ground it is nudged back to the shore. An elevated span says the opposite
 * about one street: this is the corridor, stay over it. Inside the span the
 * carriageway is priced as grass and the ground beside it as road, so A* runs
 * down the street rather than threading the yards behind it; the vertices are
 * left where they were drawn; and every route point over the street is flagged
 * so the renderer can build it as what it is — a viaduct over a road, with its
 * columns on the footpaths — instead of the standard deck.
 */
const ELEVATED = (sketch.elevated ?? []).map((e) => ({
  a: fromSketch(e.from),
  b: fromSketch(e.to),
  half: e.halfWidthMetres ?? 22,
}));
function insideElevated(x, z) {
  for (const e of ELEVATED) {
    if (segDist2(x, z, e.a[0], e.a[1], e.b[0], e.b[1]) <= e.half * e.half) return true;
  }
  return false;
}
/**
 * Strictly alongside a span — within its half-width of the segment *and*
 * between its ends. `insideElevated` is a capsule and reaches past the mouths,
 * which is right for exempting the junction cells from the building mask but
 * wrong for the refusal price: with the caps refused, the grass directly in
 * front of each mouth cost 200 a cell, so the search sidestepped onto the cheap
 * junction cells and hooked into the street from the side — an 81 degree corner
 * no fillet could round. The refusal only means anything beside the street.
 */
function alongElevated(x, z) {
  for (const e of ELEVATED) {
    const dx = e.b[0] - e.a[0]; const dz = e.b[1] - e.a[1];
    const len2 = dx * dx + dz * dz;
    if (!len2) continue;
    const t = ((x - e.a[0]) * dx + (z - e.a[1]) * dz) / len2;
    if (t < 0 || t > 1) continue;
    if (segDist2(x, z, e.a[0], e.a[1], e.b[0], e.b[1]) <= e.half * e.half) return true;
  }
  return false;
}

/** Squared distance from a point to a segment. */
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax; const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  const qx = ax + dx * t; const qz = az + dz * t;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

/** Distance from a world point to the drawn line, metres. */
function toDrawn(x, z) {
  let best = Infinity;
  for (let i = 0; i < DRAWN.length; i++) {
    const a = DRAWN[i]; const b = DRAWN[(i + 1) % DRAWN.length];
    const d = segDist2(x, z, a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Even-odd point-in-polygon. */
function inPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]; const [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Is this world position on a created island's crown? */
function onIsland(x, z) {
  for (const island of ISLANDS) if (inPolygon(x, z, island.outline)) return true;
  return false;
}

/** Ground the created islands add, or null where they add none. */
function islandHeight(x, z) {
  // The crown only. The beach outside the outline is the renderer's dressing,
  // dropping away to the seabed; treating it as land here made the two disagree
  // about where the ground was, and the line ran onto ground that visually was
  // not there.
  return onIsland(x, z) ? ISLAND_HEIGHT : null;
}

const city = JSON.parse(readFileSync(CITY_DATA, 'utf8'));
const nav = city.nav;
const { data, info } = await sharp(NAV_IMAGE).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const RW = info.width;
const RH = info.height;
const RCH = info.channels;
const VOID_H = nav.minY + 0.05;

/**
 * The obstacle mask, dilated by `OBSTACLE_CLEARANCE`.
 *
 * Dilated separably — a sliding-window maximum across, then down — because a
 * disc of radius six cells tested per cell over five million cells is an hour,
 * and two linear passes are a moment. Square rather than round clearance, which
 * costs a corner's worth of extra margin on the diagonal and nothing else.
 */
const { data: obstacleRaw, info: obstacleInfo } = await sharp(OBSTACLE_IMAGE).raw()
  .toBuffer({ resolveWithObject: true });
const OW = obstacleInfo.width;
const OH = obstacleInfo.height;
const OCH = obstacleInfo.channels;
function dilate(src, metres) {
  const radius = Math.round(metres / nav.metresPerPixel);
  const across = new Uint8Array(OW * OH);
  for (let j = 0; j < OH; j++) {
    for (let i = 0; i < OW; i++) {
      let hit = 0;
      for (let d = -radius; d <= radius && !hit; d++) {
        const k = i + d;
        if (k >= 0 && k < OW && src[j * OW + k]) hit = 1;
      }
      across[j * OW + i] = hit;
    }
  }
  const out = new Uint8Array(OW * OH);
  for (let j = 0; j < OH; j++) {
    for (let i = 0; i < OW; i++) {
      let hit = 0;
      for (let d = -radius; d <= radius && !hit; d++) {
        const k = j + d;
        if (k >= 0 && k < OH && across[k * OW + i]) hit = 1;
      }
      out[j * OW + i] = hit;
    }
  }
  return out;
}

/** The buildings themselves, undilated. Kept for the elevated spans — see `classify`. */
let solidMask = null;
const blockedMask = (() => {
  const solid = new Uint8Array(OW * OH);
  solidMask = solid;
  const trees = new Uint8Array(OW * OH);
  for (let i = 0; i < OW * OH; i++) {
    solid[i] = obstacleRaw[i * OCH] > 127 ? 1 : 0;
    trees[i] = obstacleRaw[i * OCH + 1] > 127 ? 1 : 0;
  }
  const a = dilate(solid, SOLID_CLEARANCE);
  const b = dilate(trees, TREE_CLEARANCE);
  const out = new Uint8Array(OW * OH);
  for (let i = 0; i < OW * OH; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
})();

/** Is this world position on a building itself — no clearance margin? */
const onSolid = (x, z) => {
  const i = Math.round((x - nav.originX) / nav.metresPerPixel);
  const j = Math.round((z - nav.originZ) / nav.metresPerPixel);
  if (i < 0 || j < 0 || i >= OW || j >= OH) return false;
  return solidMask !== null && solidMask[j * OW + i] === 1;
};

/** Is this world position within the clearance of anything solid? */
const obstructed = (x, z) => {
  // Inside a drawn elevated span the clearance margin does not apply — a
  // street is by definition within 14 m of its own buildings — so this is the
  // building itself or nothing. The simplifier and the fillet both ask this
  // question about their chords and arcs, and with the margin in force every
  // chord along a street was "obstructed": the search's 6 m grid staircase was
  // never straightened, and a staircase is a run of corners no fillet can round.
  if (ELEVATED.length && insideElevated(x, z)) return onSolid(x, z);
  const i = Math.round((x - nav.originX) / nav.metresPerPixel);
  const j = Math.round((z - nav.originZ) / nav.metresPerPixel);
  if (i < 0 || j < 0 || i >= OW || j >= OH) return false;
  return blockedMask[j * OW + i] === 1;
};

/**
 * Is *any part* of a `half`-metre square around this position obstructed?
 *
 * Used for the arcs and chords, which leave the grid and have to be checked
 * where they actually run. The *grid* does not need it: the mask is already
 * dilated by the clearance, so a cell whose centre is clear has that clearance
 * round the centreline, which is what the clearance is for. Applying both —
 * tried, on the theory that a cell might be three-quarters inside a building —
 * compounds to nine metres and walls the map off: two thirds of the land came
 * back blocked and no loop existed at all.
 */
const obstructedArea = (x, z, half) => {
  const step = nav.metresPerPixel;
  for (let dz = -half; dz <= half; dz += step) {
    for (let dx = -half; dx <= half; dx += step) {
      if (obstructed(x + dx, z + dz)) return true;
    }
  }
  return false;
};

const rasterAt = (x, z) => {
  const i = Math.round((x - nav.originX) / nav.metresPerPixel);
  const j = Math.round((z - nav.originZ) / nav.metresPerPixel);
  if (i < 0 || j < 0 || i >= RW || j >= RH) return null;
  const o = (j * RW + i) * RCH;
  const u16 = (data[o + 1] << 8) | data[o + 2];
  return { road: data[o] > 127, h: nav.minY + (u16 / 65535) * (nav.maxY - nav.minY) };
};

const worldMinX = nav.originX;
const worldMinZ = nav.originZ;
const GW = Math.floor((RW * nav.metresPerPixel) / CELL);
const GH = Math.floor((RH * nav.metresPerPixel) / CELL);
const cx = (gx) => worldMinX + (gx + 0.5) * CELL;
const cz = (gz) => worldMinZ + (gz + 0.5) * CELL;

const GRASS = 0; const ROAD = 1; const WATER = 2; const BLOCKED = 3;
const kind = new Uint8Array(GW * GH);
const height = new Float32Array(GW * GH);

/** Classifies one world position straight from the raster. */
function classify(x, z) {
  // Created land comes first: it is new ground where the raster has none, and
  // nothing that follows knows about it.
  const made = islandHeight(x, z);
  if (made !== null && made > SHORE_LEVEL) return { kind: GRASS, h: made };
  // A drawn elevated span is exempt from the building clearance. The mask is
  // dilated `SOLID_CLEARANCE` (14 m) out from every facade, which on a 12 m
  // street swallows every carriageway cell between the junctions — and a
  // BLOCKED cell with less than `BORE_MIN_GROUND` over it prices at infinity, so
  // the street the line was drawn down did not exist as far as the search was
  // concerned. Over a street the line is *above* the buildings' problem, not
  // beside it: the deck runs at road clearance and the columns stand on the
  // footpaths, a metre or two off the facades, which is what the span asks for.
  if (ELEVATED.length && insideElevated(x, z)) {
    const over = rasterAt(x, z);
    if (over && over.road) return { kind: ROAD, h: over.h };
    // Land inside the span that is not road — the shore in front of a mouth,
    // the yards beside the street — keeps the buildings but drops their
    // clearance margin: a building is still a building, the ground next to it
    // is just ground. Without this the 25 m shore strip in front of the
    // southern mouth sat wholly inside the corner buildings' 14 m dilation and
    // the only way onto the street was a hook in from the side.
    if (over && over.h > VOID_H && over.h > SHORE_LEVEL) {
      return { kind: onSolid(x, z) ? BLOCKED : GRASS, h: over.h };
    }
  }
  const s = rasterAt(x, z);
  const wet = !s || s.h <= VOID_H || s.h <= SHORE_LEVEL;
  // Obstacles are tested *before* the water check, not after. After, anything
  // standing in the sea — the port cranes, a jetty — was invisible to the
  // search, because a water cell was returned before the question was asked,
  // and the viaduct ran through them.
  if (obstructed(x, z)) return { kind: BLOCKED, h: wet ? 0 : s.h };
  // Excluded ground is BLOCKED, not water. Called water — which it was at
  // first — the search treats it as bridgeable and runs a viaduct straight
  // down the boundary through the districts' buildings, which is how a
  // kilometre and a half of the line ended up inside them. The *sea* west of
  // the limit stays water, or the loop could not run offshore on that side.
  if (x < WEST_LIMIT && !wet) return { kind: BLOCKED, h: s.h };
  if (wet) return { kind: WATER, h: null };
  return { kind: s.road ? ROAD : GRASS, h: s.h };
}



for (let gz = 0; gz < GH; gz++) {
  for (let gx = 0; gx < GW; gx++) {
    const c = classify(cx(gx), cz(gz));
    const p = gz * GW + gx;
    kind[p] = c.kind;
    height[p] = c.h ?? 0;
  }
}

/**
 * How broad the carriageway is under each road cell, in metres.
 *
 * Measured on the nav raster rather than the search grid: the grid is 6 m and a
 * street is often only two cells across, which cannot tell an avenue from a
 * lane. Only road cells are measured, and there are 5,294 of them, so the ring
 * search is cheap.
 *
 * It exists so the line can be carried *over* a road instead of round it. The
 * flat price of `COST.road` says only "do not cross a street", which is right
 * for a lane and wrong for a boulevard: near the city the broadest road is the
 * one clear corridor through the blocks, and a viaduct down the middle of it is
 * what a railway would actually do. Narrow streets keep the old flat price.
 */
const ROAD_PROBE = 46;
const roadHalf = new Float32Array(GW * GH);
{
  let broadest = 0;
  for (let p = 0; p < GW * GH; p++) {
    if (kind[p] !== ROAD) continue;
    const x = cx(p % GW); const z = cz((p - (p % GW)) / GW);
    let half = ROAD_PROBE;
    for (let r = 3; r <= ROAD_PROBE; r += 3) {
      let open = true;
      for (let a = 0; a < 16 && open; a++) {
        const th = (a / 16) * Math.PI * 2;
        const s2 = rasterAt(x + Math.cos(th) * r, z + Math.sin(th) * r);
        if (!s2 || !s2.road) open = false;
      }
      if (!open) { half = r - 3; break; }
    }
    roadHalf[p] = half;
    if (half > broadest) broadest = half;
  }
  step(`road half-widths measured; broadest carriageway ${broadest} m`);
}

/**
 * What a road cell costs, by how broad the road is.
 *
 * Anything under `ROAD_BROAD` of half-width keeps `COST.road`, which is a
 * refusal. Above it the price falls, so the broadest boulevard reads as a
 * corridor the line can be carried down — on a viaduct, since `ROAD_CLEARANCE`
 * holds the deck above the street and a road cell is always classified VIADUCT.
 * That is the one way through a built-up block that neither demolishes
 * something nor invents ground.
 *
 * `ROAD_FLOOR` is the important number and it is set *at* the water price, not
 * below it. Priced cheaper than open ground the search stops treating streets
 * as a way through the city and starts treating them as the preferred route
 * everywhere: at a floor of 3 the loop came back 13.6 km long with 37 corners,
 * four of them sharper than 60 m, weaving down the street grid inside its own
 * corridor. A boulevard has to be the last resort that beats the alternatives
 * in a built-up block, and nothing more than that.
 */
const ROAD_BROAD = 20;
const ROAD_RELIEF = 12;
const ROAD_FLOOR = 36;
const roadPrice = (p) => (roadHalf[p] < ROAD_BROAD ? COST.road
  : Math.max(ROAD_FLOOR, COST.road - (roadHalf[p] - ROAD_BROAD) * ROAD_RELIEF));

const tally = [0, 0, 0, 0];
for (const k of kind) tally[k]++;
step(`grid ${GW}x${GH} at ${CELL} m — grass ${tally[GRASS]}, road ${tally[ROAD]}, `
  + `water ${tally[WATER]}, blocked ${tally[BLOCKED]} `
  + `(solid dilated ${SOLID_CLEARANCE} m, vegetation ${TREE_CLEARANCE} m)`);

// ---------------------------------------------------------------------------
// 2. Anchors: the vertices of the drawn line.
// ---------------------------------------------------------------------------
/**
 * Nudge the drawn line off anything built on, before anything is searched.
 *
 * A line traced by hand over a map is accurate to a few tens of metres, and on
 * the north-west corner that was enough to put it *inside* the west district
 * rather than along its shore. Nothing downstream could recover from that: A\*
 * threaded between the buildings, the simplifier straightened the thread back
 * through them, and 640 m of railway ran through the district at grade.
 *
 * Widening the corridor does not help — it lets the search cut the bay instead.
 * Refusing to cross buildings does not help either: with the corridor pinned
 * over the district the only paths left are the gaps between the blocks, and
 * the loop came back at 13.7 km with 38 corners and a 52 m minimum radius.
 *
 * The fix is to move the drawing, which is the honest thing to do: the intent
 * was plainly "round the outside", so each vertex that lands on built-up ground
 * is walked outward to the nearest spot with `SHORE_MARGIN` of clear ground —
 * onto the bank, in the direction that moves it least.
 */
const SHORE_MARGIN = 30;
/** On a carriageway broad enough to carry a viaduct down the middle of it. */
const onBroadRoad = (x, z) => {
  const gx = Math.floor((x - worldMinX) / CELL);
  const gz = Math.floor((z - worldMinZ) / CELL);
  if (gx < 0 || gz < 0 || gx >= GW || gz >= GH) return false;
  return roadHalf[gz * GW + gx] >= ROAD_BROAD;
};
/**
 * Distance from a point to the kerb, walking the raster along one direction.
 *
 * For the street viaduct's columns, which stand on the footpaths: they need the
 * carriageway's edge on *each side of the line*, not a half-width. `roadHalf`
 * cannot give it — its 3 m ring probe is built for boulevards, and on a 12 m
 * street a cell centre 3 m off the crown fails the first ring and reads zero.
 * This walks outward in raster steps until the road ends, capped so a point in
 * the middle of a junction does not report the cross street as its width.
 */
// Capped at what a street this is built for can be: at a junction the walk runs
// out along the cross street, and 9 m stops a 12 m street reading as 48.
const KERB_REACH = 9;
const kerbDistance = (x, z, dx, dz) => {
  const step = nav.metresPerPixel / 2;
  for (let d = step; d <= KERB_REACH; d += step) {
    const s = rasterAt(x + dx * d, z + dz * d);
    if (!s || !s.road) return +(d - step).toFixed(1);
  }
  return KERB_REACH;
};
{
  let moved = 0;
  let furthest = 0;
  for (let i = 0; i < DRAWN.length; i++) {
    const [x, z] = DRAWN[i];
    // A vertex sitting on a broad road is exactly where it should be — that is
    // the corridor through the blocks — so it is left alone even though the
    // buildings either side are inside the margin.
    // ...and so is one drawn inside an elevated span: it is meant to be over
    // the street, and moving it to the shore would undo the drawing.
    if (onBroadRoad(x, z) || insideElevated(x, z) || !obstructedArea(x, z, SHORE_MARGIN)) continue;
    let best = null;
    for (let r = 6; r <= 300 && !best; r += 6) {
      for (let a = 0; a < 32; a++) {
        const th = (a / 32) * Math.PI * 2;
        const nx = x + Math.cos(th) * r;
        const nz = z + Math.sin(th) * r;
        if (!onBroadRoad(nx, nz) && obstructedArea(nx, nz, SHORE_MARGIN)) continue;
        best = [nx, nz];
        furthest = Math.max(furthest, r);
        break;
      }
    }
    if (!best) {
      console.warn(`  ! drawn vertex ${i} at (${x.toFixed(0)}, ${z.toFixed(0)}) is built on `
        + 'and has no clear ground within 300 m — left where it was');
      continue;
    }
    DRAWN[i] = best;
    moved++;
  }
  step(`nudged ${moved} of ${DRAWN.length} drawn vertices onto clear ground `
    + `(furthest ${furthest} m)`);
}

// The route is drawn, not chosen. `trainSketch.json` holds the line the user
// traced over the city map; these are its vertices, in order, as the anchors
// A* runs between, and `CORRIDOR` is the band around it the search may use.
//
// Everything the old chooser did — farthest-point sampling for spread, a 2-opt
// tour for order, a coastal band to keep it a perimeter loop — existed to guess
// at a route. There is no guessing left to do, so it is gone. What survives is
// the part that was always the point: A* between consecutive anchors, which is
// what keeps the line off the roads, out of the buildings and under the hills
// rather than through them.
const CORRIDOR = new Uint8Array(GW * GH);
{
  let inside = 0;
  for (let gz = 0; gz < GH; gz++) {
    for (let gx = 0; gx < GW; gx++) {
      if (toDrawn(cx(gx), cz(gz)) > CORRIDOR_HALF) continue;
      CORRIDOR[gz * GW + gx] = 1;
      inside++;
    }
  }
  step(`corridor ${inside.toLocaleString()} cells (+/-${CORRIDOR_HALF} m round the drawn line)`);
}

const anchors = [];
{
  /** Nearest cell to a drawn vertex that the line could actually stand on. */
  const snap = (x, z) => {
    const gx0 = Math.round((x - worldMinX) / CELL - 0.5);
    const gz0 = Math.round((z - worldMinZ) / CELL - 0.5);
    let best = null; let bestD = Infinity;
    for (let r = 0; r <= 24; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const gx = gx0 + dx; const gz = gz0 + dz;
          if (gx < 1 || gz < 1 || gx >= GW - 1 || gz >= GH - 1) continue;
          const p = gz * GW + gx;
          if (kind[p] === BLOCKED) continue;
          const d = Math.hypot(dx, dz);
          if (d < bestD) { bestD = d; best = { gx, gz, h: Math.max(0, height[p]) }; }
        }
      }
      if (best) break;
    }
    return best;
  };

  DRAWN.forEach((point, i) => {
    const cell = snap(point[0], point[1]);
    if (!cell) {
      console.warn(`  ! drawn vertex ${i} at (${point[0].toFixed(0)}, ${point[1].toFixed(0)}) `
        + 'has no buildable cell within 144 m — skipped');
      return;
    }
    // A vertex that snapped onto the previous one adds nothing and gives A* a
    // zero-length leg to solve.
    const last = anchors[anchors.length - 1];
    if (last && last.gx === cell.gx && last.gz === cell.gz) return;
    cell.name = `drawn ${i}`;
    anchors.push(cell);
  });
}
for (const a of anchors) {
  console.log(`    ${a.name.padEnd(10)} (${cx(a.gx).toFixed(0)}, ${cz(a.gz).toFixed(0)}) `
    + `ground ${a.h.toFixed(0)} m`);
}
step(`${anchors.length} anchors traced from the sketch`);

// ---------------------------------------------------------------------------
// 3. A* between consecutive anchors, with heading in the state.
// ---------------------------------------------------------------------------
const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_LENGTH = DIRS.map(([dx, dz]) => Math.hypot(dx, dz));
/** The "no heading yet" state, for the very first cell of the loop. */
const ANY = 8;
const STATES = 9;

/** Heap of {s, f}, keyed on f. */
function makeHeap() {
  const heap = [];
  return {
    get size() { return heap.length; },
    push(item) {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].f <= heap[i].f) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    },
    pop() {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1; const r = l + 1;
          let s = i;
          if (l < heap.length && heap[l].f < heap[s].f) s = l;
          if (r < heap.length && heap[r].f < heap[s].f) s = r;
          if (s === i) break;
          [heap[s], heap[i]] = [heap[i], heap[s]];
          i = s;
        }
      }
      return top;
    },
  };
}

// Allocated once and reused per leg: 2.8 M states is too much to churn.
const N_CELLS = GW * GH;
const gScore = new Float64Array(N_CELLS * STATES);
const cameFrom = new Int32Array(N_CELLS * STATES);
const closed = new Uint8Array(N_CELLS * STATES);

/**
 * Shortest path from `from` (arriving with heading `fromDir`) to `to`, ending
 * with any heading. Returns the cells and the heading it arrived with, so the
 * next leg can carry it on and the joint is not a free kink.
 */
/**
 * Cells already used by an earlier leg of this loop, and what it costs to use
 * one again.
 *
 * Without this the legs share corridors: where the land is narrow there is one
 * sensible way through, both the leg out and the leg back take it, and the loop
 * doubles back on itself. `despur` then cuts the overlap out — and what is left
 * can be a third of the intended circuit, which is how raising the water price
 * to bring the line ashore kept producing a 3 km loop instead of an 8 km one.
 * Charging for reuse keeps the legs apart, so the ring stays a ring. Dear —
 * a leg would rather go 400 cells out of its way than share a corridor —
 * because the alternative is `despur` amputating the overlap afterwards, and
 * that cost 40% of one loop's length in a single cut.
 */
const used = new Uint8Array(GW * GH);
const REVISIT_COST = 400;
const REVISIT_RADIUS = 2;

/**
 * What it costs to drive a tunnel through ground the line cannot cross, and how
 * high that ground has to be before boring it is an option.
 *
 * Without this every hill and every block of buildings is a wall, and the only
 * way round is a corridor between them — which is what made the ashore routes
 * wind, and what pushed the good alignments out to sea on kilometres of
 * viaduct. A railway does not go round a hill that size; it goes through it.
 *
 * The height bar is now zero — the line will go under the city as readily as
 * through a hill. The worry was that this map has nothing modelled beneath its
 * streets, so a bore under them would hang in the void; in fact it cannot be
 * seen. The lining is drawn `BackSide`, so from outside it draws nothing at
 * all, and the terrain above it is untouched because the cut only applies to
 * the bores that actually reach a hillside. A tunnel under the city is simply
 * invisible from the city.
 */
const BORE_COST = 50;
/**
 * A chord or an arc may only cross something solid where the ground is at least
 * this high — because that is the only place a bore can actually be buried.
 *
 * The permission to cross exists so the simplifier can draw a straight line
 * through a hill instead of jinking round every building on it; the premise is
 * that the grading will dive under. In the flat western districts the premise
 * is false: the ground is street level, a bore there would sit below the sea
 * beside it, and the grading cannot get down. It came out as 640 m of line
 * running *through* the district's buildings at grade, hidden only because
 * `bored` used to force the label TUNNEL on it.
 *
 * Ten metres is above the districts (0-2 m) and well below the hills the line
 * genuinely bores through (10-43 m of cover), so it separates the two cases
 * without touching the tunnels that work.
 */
const BORE_MIN_GROUND = 10;


/**
 * How far out to sea each water cell is, in cells, and what that costs.
 *
 * One flat water price cannot express what is wanted here. Cheap, and the line
 * strikes out to sea and rings the whole map on a viaduct — 6.8 km of the 8.5
 * over water. Dear, and it will not cross the bays at all, so the loop cannot
 * get round the west side where the city meets the shore, and it collapses to a
 * thin oval in the eastern hinterland. There is no value in between: the two
 * behaviours swap over within a factor of two.
 *
 * Distance from land is the missing term. Crossing a bay stays affordable
 * because the far shore is close; running parallel to the coast a kilometre out
 * does not, because every cell of it is charged for being out there.
 */
const OFFSHORE_COST = 3;
const offshore = (() => {
  const dist = new Uint16Array(GW * GH).fill(9999);
  let frontier = [];
  for (let p = 0; p < GW * GH; p++) if (kind[p] !== WATER) { dist[p] = 0; frontier.push(p); }
  for (let d = 1; frontier.length; d++) {
    const next = [];
    for (const p of frontier) {
      const gx = p % GW; const gz = (p - gx) / GW;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx; const nz = gz + dz;
        if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue;
        const np = nz * GW + nx;
        if (dist[np] !== 9999) continue;
        dist[np] = d;
        next.push(np);
      }
    }
    frontier = next;
  }
  return dist;
})();

function astar(from, fromDir, to, waterCost) {
  gScore.fill(Infinity);
  cameFrom.fill(-1);
  closed.fill(0);

  const startCell = from.gz * GW + from.gx;
  const goalCell = to.gz * GW + to.gx;
  const startState = startCell * STATES + fromDir;
  gScore[startState] = 0;
  const heap = makeHeap();
  heap.push({ s: startState, f: 0 });

  const cellCost = (p) => {
    const k = kind[p];
    if (k === BLOCKED) {
      if (height[p] < BORE_MIN_GROUND) return Infinity;
      return BORE_COST + (used[p] ? REVISIT_COST : 0);
    }
    if (k === WATER) {
      return waterCost + offshore[p] * OFFSHORE_COST + (used[p] ? REVISIT_COST : 0);
    }
    // Inside a drawn elevated span the street's price is inverted — see
    // `ELEVATED`. Checked after BLOCKED so a building beside the street keeps
    // its bore price rather than becoming merely expensive open ground.
    if (ELEVATED.length) {
      const gx = p % GW;
      const x = cx(gx); const z = cz((p - gx) / GW);
      if (insideElevated(x, z)) {
        if (k === ROAD) return COST.grass + (used[p] ? REVISIT_COST : 0);
        // Refused only alongside the street, never past its ends — see
        // `alongElevated`. Beyond a mouth the ground is priced as it always is.
        if (alongElevated(x, z)) return COST.road + (used[p] ? REVISIT_COST : 0);
      }
    }
    return (k === ROAD ? roadPrice(p) : COST.grass)
      + Math.max(0, height[p] - PLAIN_TOP) * HEIGHT_COST
      + (used[p] ? REVISIT_COST : 0);
  };

  let endState = -1;
  while (heap.size) {
    const { s } = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const cell = (s - (s % STATES)) / STATES;
    const dir = s % STATES;
    if (cell === goalCell) { endState = s; break; }
    const gx = cell % GW; const gz = (cell - gx) / GW;

    for (let d = 0; d < 8; d++) {
      // Turn: 0, 1 or 2 steps of 45°, charged per step, and nothing sharper —
      // it is not a railway otherwise. A right angle in one cell is allowed
      // because forbidding it sealed the search out of every narrow gap
      // between buildings, and there was no loop at all.
      let turn = 0;
      if (dir !== ANY) {
        turn = Math.abs(d - dir);
        if (turn > 4) turn = 8 - turn;
        if (turn > 2) continue;
      }
      const [dx, dz] = DIRS[d];
      const nx = gx + dx; const nz = gz + dz;
      if (nx < 1 || nz < 1 || nx >= GW - 1 || nz >= GH - 1) continue;
      const np = nz * GW + nx;
      // Outside the drawn corridor is simply not the route. Enforced here
      // rather than by pricing, because a cost the search can pay is a cost the
      // search will pay: over open water, where nothing else charges anything,
      // a priced corridor just gets cut across the bays.
      if (!CORRIDOR[np]) continue;
      const ns = np * STATES + d;
      if (closed[ns]) continue;
      const c = cellCost(np);
      if (!Number.isFinite(c)) continue;
      // Diagonal moves may not cut a building corner.
      if (dx && dz && (kind[gz * GW + nx] === BLOCKED || kind[nz * GW + gx] === BLOCKED)) continue;

      const w = DIR_LENGTH[d];
      const entry = kind[np] === WATER && kind[cell] !== WATER ? BRIDGE_ENTRY : 0;
      const climb = kind[cell] === WATER || kind[np] === WATER
        ? 0 : Math.abs(height[np] - height[cell]);
      const tentative = gScore[s] + c * w + entry + climb * GRADE_COST + turn * TURN_COST;
      if (tentative >= gScore[ns]) continue;
      gScore[ns] = tentative;
      cameFrom[ns] = s;
      const hEst = Math.hypot(nx - to.gx, nz - to.gz) * COST.grass;
      heap.push({ s: ns, f: tentative + hEst });
    }
  }
  if (endState < 0) return null;

  const path = [];
  for (let s = endState; s >= 0; s = cameFrom[s]) {
    const cell = (s - (s % STATES)) / STATES;
    const gx = cell % GW;
    path.push({ gx, gz: (cell - gx) / GW });
    if (s === startState) break;
  }
  return { cells: path.reverse(), dir: endState % STATES };
}

/**
 * Links the anchors in order. An anchor the search cannot reach — the lowest
 * grass near a bearing can be a courtyard sealed off by the building margins —
 * is dropped and reported rather than failing the whole loop.
 */
function buildRoute(waterCost) {
  const cells = [];
  used.fill(0);
  let dir = ANY;
  const ring = anchors.slice();
  let i = 0;
  while (i < ring.length) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const leg = astar(a, dir, b, waterCost);
    if (!leg) {
      if (ring.length <= 3) return null;
      step(`  anchor ${b.name} at (${cx(b.gx).toFixed(0)}, ${cz(b.gz).toFixed(0)}) is unreachable; dropped`);
      ring.splice((i + 1) % ring.length, 1);
      if (i + 1 >= ring.length) i = 0; // Wrapped: the dropped one was the first.
      continue;
    }
    cells.push(...(cells.length === 0 ? leg.cells : leg.cells.slice(1)));
    // Mark the leg, and a couple of cells either side of it, as spent.
    for (const c of leg.cells) {
      for (let dz = -REVISIT_RADIUS; dz <= REVISIT_RADIUS; dz++) {
        for (let dx = -REVISIT_RADIUS; dx <= REVISIT_RADIUS; dx++) {
          const nx = c.gx + dx; const nz = c.gz + dz;
          if (nx >= 0 && nz >= 0 && nx < GW && nz < GH) used[nz * GW + nx] = 1;
        }
      }
    }
    dir = leg.dir;
    i++;
  }
  cells.pop(); // The last cell is the first anchor again.
  anchors.length = 0; anchors.push(...ring);
  return cells;
}

// ---------------------------------------------------------------------------
// 4. Fillets: straights and circular arcs.
// ---------------------------------------------------------------------------

/**
 * Removes spurs and self-crossings, leaving a simple closed curve.
 *
 * A\* is run leg by leg round a ring of anchors, and nothing stops one leg
 * doubling back along another: the path reaches out to a peninsula anchor and
 * returns the way it came, or clips its own earlier leg and carries on. What
 * that leaves in the finished alignment is unmistakable — a 180-degree corner
 * where the line reverses, and clusters of six-metre squares where it circles a
 * cell. No radius fillets those; they came out as the sharp corners.
 *
 * Any cell visited twice bounds a sub-loop, and the shorter side of it is the
 * spur. Only small ones are cut, though: excising *any* revisit took 40% off
 * one loop in a single pass, which is a far worse outcome than the flat
 * crossing it was tidying away. A big one is left alone — the line crosses
 * itself there, which the tram loop does deliberately.
 */
function despur(cells) {
  for (let guard = 0; guard < 200; guard++) {
    const seen = new Map();
    let cut = null;
    for (let i = 0; i < cells.length; i++) {
      const key = cells[i].gz * GW + cells[i].gx;
      const first = seen.get(key);
      if (first !== undefined) { cut = [first, i]; break; }
      seen.set(key, i);
    }
    if (!cut) return cells;
    const [from, to] = cut;
    const inner = to - from;
    const outer = cells.length - inner;
    const smaller = Math.min(inner, outer);
    if (smaller > cells.length * DESPUR_MAX) return cells;
    if (inner <= outer) cells.splice(from, inner);
    else cells = cells.slice(from, to);
  }
  return cells;
}

/** Collapses runs of equal heading to their end points. */
function toVertices(cells) {
  const vertices = [];
  const n = cells.length;
  for (let i = 0; i < n; i++) {
    const prev = cells[(i - 1 + n) % n];
    const here = cells[i];
    const next = cells[(i + 1) % n];
    const inDx = here.gx - prev.gx; const inDz = here.gz - prev.gz;
    const outDx = next.gx - here.gx; const outDz = next.gz - here.gz;
    if (inDx !== outDx || inDz !== outDz) vertices.push([cx(here.gx), cz(here.gz)]);
  }
  return vertices;
}

const norm2 = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };

/**
 * Is the straight between two points buildable?
 *
 * Used by the simplifier, when it wants to replace a run of vertices with a
 * chord, and by the tight-corner pass, when it wants to drop a vertex.
 *
 * Crossing something solid is *allowed*, because the line goes under it: any
 * point of the finished route that lands inside an obstacle is marked bored,
 * and the grading holds it `BORE_COVER` below the ground there. What is not
 * allowed is boring further than `MAX_BORE_RUN` in one go — without that limit
 * the simplifier draws one enormous chord across the whole city and the loop
 * becomes a single five-kilometre tunnel with nothing to look at.
 *
 * Refusing to cross obstacles at all, which is what this did first, is what
 * made the geometry so bad once boring was allowed: the search could tunnel but
 * the simplifier could not straighten what it had tunnelled, so every jog
 * between two buildings survived into the alignment as an 11 m corner.
 */
/** Is the ground here high enough that a bore under it could be buried? */
function borable(x, z) {
  const s = rasterAt(x, z);
  return !!s && s.h >= BORE_MIN_GROUND;
}

function chordClear(q, r) {
  const len = Math.hypot(r[0] - q[0], r[1] - q[1]);
  const samples = Math.max(2, Math.ceil(len / 3));
  let run = 0;
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const x = q[0] + (r[0] - q[0]) * t;
    const z = q[1] + (r[1] - q[1]) * t;
    // Over water a chord is fine — it becomes a bridge. On land, inside an
    // obstacle, it becomes a bore — but only where there is ground enough to
    // bury one; see `borable`. Elsewhere crossing a building means running
    // through it, and the chord is refused.
    if (!obstructedArea(x, z, 1.5)) { run = 0; continue; }
    if (!borable(x, z)) return false;
    run += len / samples;
    if (run > MAX_BORE_RUN) return false;
  }
  return true;
}

/**
 * Straightens the plan before it is filleted.
 *
 * Even with turns charged for, a leg that wants to run at, say, 30° has to be
 * made of 0° and 45° steps, and the search alternates between them where it is
 * cheapest to — which leaves a run of near-collinear vertices a few metres
 * either side of the line they are approximating. Filleting those as they are
 * gives a string of tiny opposite-handed arcs. Douglas-Peucker with a tolerance
 * of about a cell replaces each such run with the single straight it was
 * always trying to be, and the corners left are the real ones. A chord is
 * only accepted if it clears every building; nothing else is protected, and a
 * straight that crosses a street the search avoided simply becomes a bridge.
 */
function simplify(vertices, tolerance) {
  const n = vertices.length;
  // A closed loop is split at its two most distant vertices into two open
  // chains, each simplified in the usual recursive way.
  let a = 0; let b = 0; let far = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(vertices[i][0] - vertices[j][0], vertices[i][1] - vertices[j][1]);
      if (d > far) { far = d; a = i; b = j; }
    }
  }
  const keep = new Uint8Array(n);
  keep[a] = 1; keep[b] = 1;
  const distance = (p, q, r) => {
    const dx = r[0] - q[0]; const dz = r[1] - q[1];
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dz) / len2));
    return Math.hypot(p[0] - (q[0] + dx * t), p[1] - (q[1] + dz * t));
  };

  const dp = (indices) => {
    if (indices.length < 3) return;
    const first = vertices[indices[0]]; const last = vertices[indices[indices.length - 1]];
    let worst = 0; let at = -1;
    for (let k = 1; k < indices.length - 1; k++) {
      const d = distance(vertices[indices[k]], first, last);
      if (d > worst) { worst = d; at = k; }
    }
    if (worst <= tolerance && chordClear(first, last)) return;
    keep[indices[at]] = 1;
    dp(indices.slice(0, at + 1));
    dp(indices.slice(at));
  };
  const chain = [];
  for (let i = a; i !== b; i = (i + 1) % n) chain.push(i);
  chain.push(b);
  dp(chain);
  const other = [];
  for (let i = b; i !== a; i = (i + 1) % n) other.push(i);
  other.push(a);
  dp(other);
  return vertices.filter((_, i) => keep[i]);
}

/**
 * Rounds every vertex of the closed polyline with a circular arc and returns a
 * dense sample of the result, together with the radius actually used at each
 * corner.
 *
 * The tangent length a corner of angle θ needs at radius R is R·tan(θ/2), and
 * each straight has to give up that much at both ends. So the radius at a
 * vertex is the largest that fits in the shorter of its two straights — up to
 * R_MAX — shared fairly with the neighbouring corner. If the arc would pass
 * through a building it is tightened and tried again; the search kept the
 * *cells* clear of buildings, but an arc cuts inside the corner they turned at.
 */
function fillet(vertices) {
  const n = vertices.length;
  let squeezed = 0;
  const corner = vertices.map((here, i) => {
    const prev = vertices[(i - 1 + n) % n];
    const next = vertices[(i + 1) % n];
    const inDir = norm2(here[0] - prev[0], here[1] - prev[1]);
    const outDir = norm2(next[0] - here[0], next[1] - here[1]);
    const cross = inDir[0] * outDir[1] - inDir[1] * outDir[0];
    const dot = inDir[0] * outDir[0] + inDir[1] * outDir[1];
    const theta = Math.atan2(Math.abs(cross), dot);
    return {
      here, inDir, outDir, theta, side: cross >= 0 ? 1 : -1,
      lenIn: Math.hypot(here[0] - prev[0], here[1] - prev[1]),
      lenOut: Math.hypot(next[0] - here[0], next[1] - here[1]),
      radius: 0, tangent: 0,
    };
  });

  // Each straight is split between the two corners at its ends in proportion
  // to what they need, so neither can starve the other.
  for (let i = 0; i < n; i++) {
    const c = corner[i];
    const need = (r) => r * Math.tan(c.theta / 2);
    const prevTheta = corner[(i - 1 + n) % n].theta;
    const nextTheta = corner[(i + 1) % n].theta;
    const mine = Math.tan(c.theta / 2);
    const shareIn = c.lenIn * (mine / (mine + Math.tan(prevTheta / 2) + 1e-9));
    const shareOut = c.lenOut * (mine / (mine + Math.tan(nextTheta / 2) + 1e-9));
    const room = Math.min(shareIn, shareOut) * 0.98;
    let radius = c.theta < 1e-4 ? 0 : Math.min(R_MAX, room / mine);
    // Tighten until the arc is clear of everything solid. If nothing fits, the
    // radius goes to zero: the line then takes the corner as the search laid
    // it, which is sharp but is guaranteed clear, where an arc that ran out of
    // attempts was simply left clipping whatever it clipped.
    // Enough attempts to shrink from R_MAX to a few metres. Fourteen was not:
    // 400 m at three quarters a step only reaches 7 m in fourteen, so corners
    // in tight spots ran out of tries and fell back to sharp when a small arc
    // would have fitted. The vertex itself always has the full clearance round
    // it, so a small enough arc is clear by construction.
    let clear = radius === 0;
    for (let attempt = 0; attempt < 32 && radius > 2; attempt++) {
      const tangent = need(radius);
      const startX = c.here[0] - c.inDir[0] * tangent;
      const startZ = c.here[1] - c.inDir[1] * tangent;
      const centreX = startX - c.inDir[1] * radius * c.side;
      const centreZ = startZ + c.inDir[0] * radius * c.side;
      const from = Math.atan2(startZ - centreZ, startX - centreX);
      clear = true;
      const samples = Math.max(3, Math.ceil((c.theta * radius) / 4));
      let bored = 0;
      for (let k = 0; k <= samples && clear; k++) {
        const a = from + (c.theta * c.side * k) / samples;
        // As `chordClear`: an arc may pass under something, within limits.
        const ax = centreX + radius * Math.cos(a);
        const az = centreZ + radius * Math.sin(a);
        if (obstructedArea(ax, az, 1.5)) {
          if (!borable(ax, az)) { clear = false; break; }
          bored += (c.theta * radius) / samples;
          if (bored > MAX_BORE_RUN) clear = false;
        } else bored = 0;
      }
      if (clear) break;
      radius *= 0.75;
    }
    if (!clear) { radius = 0; squeezed++; }
    c.radius = radius;
    c.tangent = need(radius);
  }

  // Emit: for each corner, its arc, then the straight to the next corner.
  const points = [];
  for (let i = 0; i < n; i++) {
    const c = corner[i];
    const nextC = corner[(i + 1) % n];
    const start = [c.here[0] - c.inDir[0] * c.tangent, c.here[1] - c.inDir[1] * c.tangent];
    const end = [c.here[0] + c.outDir[0] * c.tangent, c.here[1] + c.outDir[1] * c.tangent];
    if (c.radius > 0 && c.theta > 1e-4) {
      const centreX = start[0] - c.inDir[1] * c.radius * c.side;
      const centreZ = start[1] + c.inDir[0] * c.radius * c.side;
      const from = Math.atan2(start[1] - centreZ, start[0] - centreX);
      const samples = Math.max(2, Math.ceil((c.theta * c.radius) / 3));
      for (let k = 0; k < samples; k++) {
        const a = from + (c.theta * c.side * k) / samples;
        points.push([centreX + c.radius * Math.cos(a), centreZ + c.radius * Math.sin(a)]);
      }
    } else {
      points.push(start);
    }
    const nextStart = [
      nextC.here[0] - nextC.inDir[0] * nextC.tangent,
      nextC.here[1] - nextC.inDir[1] * nextC.tangent,
    ];
    const run = Math.hypot(nextStart[0] - end[0], nextStart[1] - end[1]);
    const samples = Math.max(1, Math.ceil(run / STEP));
    for (let k = 0; k < samples; k++) {
      const t = k / samples;
      points.push([end[0] + (nextStart[0] - end[0]) * t, end[1] + (nextStart[1] - end[1]) * t]);
    }
  }
  if (squeezed) step(`  ${squeezed} corner(s) had no clear radius and were left sharp`);
  const real = [];
  const cornerIndex = [];
  corner.forEach((c, i) => { if (c.theta > 0.02) { real.push(c); cornerIndex.push(i); } });
  for (const c of real) {
    if (c.radius < R_MIN) {
      console.log(`    tight corner: R ${c.radius.toFixed(0)} m, ${(c.theta * 180 / Math.PI).toFixed(0)}deg `
        + `at (${c.here[0].toFixed(0)}, ${c.here[1].toFixed(0)}); straights ${c.lenIn.toFixed(0)}/${c.lenOut.toFixed(0)} m`);
    }
  }
  return { points, radii: real.map((c) => c.radius), cornerIndex };
}

/** Resamples a closed polyline at a uniform pitch. */
function resample(points, pitch) {
  const n = points.length;
  let total = 0;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const a = points[i]; const b = points[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum.push(total);
  }
  const count = Math.round(total / pitch);
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / count) * total;
    while (cum[seg + 1] < d) seg++;
    const a = points[seg % n]; const b = points[(seg + 1) % n];
    const t = (d - cum[seg]) / ((cum[seg + 1] - cum[seg]) || 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Run the search, fillet, resample, reclassify; retry if a span is too long.
// ---------------------------------------------------------------------------
let points = null;
let radii = null;
let waterCost = COST.water;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const cells = buildRoute(waterCost);
  if (!cells) { step(`no route at water cost ${waterCost.toFixed(1)}`); break; }
  const trimmed = despur(cells);
  if (trimmed.length !== cells.length) {
    step(`  despurred ${cells.length} -> ${trimmed.length} cells`);
  }
  if (trimmed.length < cells.length * 0.5) {
    step('  more than half the loop was spur — the anchor ring is degenerate');
  }
  let vertices = simplify(toVertices(trimmed), SIMPLIFY_TOLERANCE);
  let smooth = fillet(vertices);
  // Any corner the fillet could not open out to R_MIN is a vertex with too
  // little straight either side of it. Dropping it and filleting again lets
  // its neighbours take the turn between them at a radius that is worth
  // having — provided the straight that replaces it is clear, which is the
  // same test `simplify` uses. Repeated, because removing one vertex changes
  // what its neighbours can do.
  for (let pass = 0; pass < 14; pass++) {
    const tight = smooth.radii
      .map((r, k) => ({ r, k }))
      .filter(({ r }) => r < DROP_BELOW)
      .sort((a, b) => a.r - b.r);
    if (!tight.length || vertices.length <= 6) break;
    const drop = new Set();
    for (const { k } of tight) {
      const index = smooth.cornerIndex[k];
      const before = vertices[(index - 1 + vertices.length) % vertices.length];
      const after = vertices[(index + 1) % vertices.length];
      // Never drop two neighbours in one pass: the chord test only knows about
      // the vertices still present.
      if (drop.has((index - 1 + vertices.length) % vertices.length)
        || drop.has((index + 1) % vertices.length)) continue;
      if (chordClear(before, after)) drop.add(index);
    }
    if (!drop.size) break;
    vertices = vertices.filter((_, i) => !drop.has(i));
    smooth = fillet(vertices);
  }
  const sampled = resample(smooth.points, STEP);
  const classified = sampled.map(([x, z], i) => {
    const c = classify(x, z);
    const street = c.kind === ROAD && insideElevated(x, z);
    // Left-hand normal, the same sign the runtime's `trainNormalAt` uses.
    let kerbLeft = 0; let kerbRight = 0;
    if (street) {
      const prev = sampled[(i - 1 + sampled.length) % sampled.length];
      const next = sampled[(i + 1) % sampled.length];
      const tx = next[0] - prev[0]; const tz = next[1] - prev[1];
      const len = Math.hypot(tx, tz) || 1;
      const nx = tz / len; const nz = -tx / len;
      kerbLeft = kerbDistance(x, z, nx, nz);
      kerbRight = kerbDistance(x, z, -nx, -nz);
    }
    return {
      x: +x.toFixed(2), z: +z.toFixed(2), kind: c.kind, ground: c.h,
      // Under ground the line could not cross on the surface: it is in a bore
      // here whatever the cover works out at.
      bored: c.kind === BLOCKED,
      blocked: c.kind === BLOCKED ? false : obstructed(x, z),
      // Over a street inside a drawn elevated span: the renderer builds the
      // street viaduct here, and stands its columns `roadHalf` out from the line.
      street,
      kerbLeft,
      kerbRight,
    };
  });
  // A short run of unflagged points between two street points is a junction
  // the path cut the corner of — still the street. Left alone it puts a length
  // of concrete deck and a centre pier in the middle of the steel viaduct, and
  // splits the column run in two. Up to `STREET_GAP` samples are filled, with
  // the kerbs interpolated across the gap so the deck's width eases through it.
  // 16 samples is 96 m. At the north end of the west district's street the
  // simplifier straightens the line across the inside of the bend — 78 m over
  // the open ground of the corner block, which nothing forbids — and the deck
  // has to be one structure across it rather than steel, then concrete on a
  // centre pier, then steel again. Making the simplifier hug the road instead
  // was tried and brings back the grid staircase on the diagonal.
  const STREET_GAP = 16;
  {
    const n = classified.length;
    for (let i = 0; i < n; i++) {
      if (classified[i].street || !classified[(i - 1 + n) % n].street) continue;
      let run = 0;
      while (run < STREET_GAP && !classified[(i + run) % n].street) run++;
      if (run >= STREET_GAP || !classified[(i + run) % n].street) continue;
      const a = classified[(i - 1 + n) % n];
      const b = classified[(i + run) % n];
      for (let k = 0; k < run; k++) {
        const p = classified[(i + k) % n];
        const t = (k + 1) / (run + 1);
        p.street = true;
        p.kerbLeft = +(a.kerbLeft + (b.kerbLeft - a.kerbLeft) * t).toFixed(1);
        p.kerbRight = +(a.kerbRight + (b.kerbRight - a.kerbRight) * t).toFixed(1);
      }
    }
  }
  let span = 0; let worst = 0;
  for (const p of classified) {
    if (p.kind === WATER) { span += STEP; worst = Math.max(worst, span); } else span = 0;
  }
  const hits = classified.filter((p) => p.blocked).length;
  if (process.env.ROUTE_DEBUG && hits) {
    const runs = [];
    let run = null;
    classified.forEach((p, i) => {
      if (p.blocked) { if (!run) { run = { from: i, to: i }; runs.push(run); } else run.to = i; }
      else run = null;
    });
    console.log(`    ${runs.length} blocked runs:`);
    for (const r of runs.slice(0, 12)) {
      const a = classified[r.from];
      console.log(`      idx ${r.from}-${r.to} (${(r.to - r.from + 1) * STEP} m) at `
        + `(${a.x.toFixed(0)}, ${a.z.toFixed(0)}) kind ${a.kind}`);
    }
  }
  step(`water ${waterCost.toFixed(1)}: ${trimmed.length} cells -> ${vertices.length} corners -> `
    + `${classified.length} points; longest water span ${worst.toFixed(0)} m (limit ${MAX_BRIDGE}); `
    + `${hits} points inside the clearance`);
  if (worst <= MAX_BRIDGE) { points = classified; radii = smooth.radii; break; }
  waterCost *= WATER_ESCALATION;
}
if (!points) {
  console.error('could not find a route whose water spans are all bridgeable.');
  process.exit(1);
}
const N = points.length;
const spanTo = (i, j) => Math.hypot(points[j].x - points[i].x, points[j].z - points[i].z);

// ---------------------------------------------------------------------------
// 5b. Reclaim the long water crossings as causeway, keeping channels open.
// ---------------------------------------------------------------------------
for (const p of points) p.made = 0;
{
  const runs = [];
  let start = -1;
  for (let i = 0; i <= N; i++) {
    const wet = i < N && points[i].kind === WATER;
    if (wet && start < 0) start = i;
    if (!wet && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  let reclaimed = 0; let channels = 0;
  for (const [from, to] of runs) {
    const length = (to - from + 1) * STEP;
    if (length < MIN_CAUSEWAY) continue;
    // Channels spaced along the run, and never at its very ends, where the
    // causeway has to meet the shore.
    const gaps = Math.max(0, Math.round(length / CHANNEL_EVERY) - 1);
    const open = new Set();
    for (let g = 1; g <= gaps; g++) {
      const centre = from + Math.round(((to - from) * g) / (gaps + 1));
      const half = Math.round(CHANNEL_LENGTH / STEP / 2);
      for (let k = centre - half; k <= centre + half; k++) if (k > from && k < to) open.add(k);
    }
    for (let k = from; k <= to; k++) {
      if (open.has(k)) continue;
      points[k].kind = GRASS;
      points[k].ground = SEA_LEVEL + CAUSEWAY_FREEBOARD;
      points[k].made = 1;
      reclaimed += STEP;
    }
    channels += gaps;
  }
  step(`reclaimed ${(reclaimed / 1000).toFixed(2)} km of water as causeway, `
    + `with ${channels} channel${channels === 1 ? '' : 's'} left open`);
}

// ---------------------------------------------------------------------------
// 6. Vertical alignment.
//
// Two envelopes bracket it. `upper` is the lowest slope-limited surface that
// stays at or above the ground — an all-embankment line. `lower` is the highest
// one at or below it — an all-tunnel line. Any blend of the two is still
// slope-limited, because |dy| <= g*d survives a convex combination, so
// CUT_FILL_BALANCE can pick anywhere between them without losing the grade
// guarantee. A third envelope carries the clearances — over the sea, and over
// every street — and is imposed as a hard floor by taking the maximum, which
// also preserves the guarantee: the greater of two functions with a bounded
// slope has one too. Folding it into `upper` does not work; the blend averages
// it away against `lower`, and the first crossing came out with its soffit a
// metre under the waterline.
// ---------------------------------------------------------------------------
function gradeProfile() {
  const upper = new Float64Array(N);
  const lower = new Float64Array(N);
  const clearance = new Float64Array(N);
  /** Lowest slope-limited surface that keeps a bore buried where it must be. */
  const ceiling = new Float64Array(N).fill(Infinity);
  for (let i = 0; i < N; i++) {
    const p = points[i];
    if (p.bored) ceiling[i] = p.ground - BORE_COVER;
    upper[i] = p.ground ?? -Infinity;
    lower[i] = p.ground ?? Infinity;
    if (p.kind === WATER) clearance[i] = SEA_LEVEL + BRIDGE_CLEARANCE;
    else if (p.kind === ROAD) clearance[i] = p.ground + ROAD_CLEARANCE;
    else clearance[i] = -Infinity;
    // A created island is 3.2 m of made ground in open sea, and the line has to
    // sit ON it. Left to the blend the profile dipped up to 2.2 m below the
    // crown and 60 of the 133 island points came out as cutting — but an island
    // is not the terrain mesh, so nothing carved the trench, and the train ran
    // buried inside the grass with slab track instead of ballast. There is
    // nothing to gain by cutting into an island anyway: it was built to be
    // exactly as high as the railway needed.
    if (onIsland(p.x, p.z)) clearance[i] = Math.max(clearance[i], p.ground);
  }
  for (let lap = 0; lap < 2; lap++) {
    for (let k = 0; k < N; k++) {
      const prev = (k - 1 + N) % N;
      const d = RULING_GRADE * spanTo(prev, k);
      upper[k] = Math.max(upper[k], upper[prev] - d);
      lower[k] = Math.min(lower[k], lower[prev] + d);
      clearance[k] = Math.max(clearance[k], clearance[prev] - d);
      ceiling[k] = Math.min(ceiling[k], ceiling[prev] + d);
    }
    for (let k = N - 1; k >= 0; k--) {
      const next = (k + 1) % N;
      const d = RULING_GRADE * spanTo(k, next);
      upper[k] = Math.max(upper[k], upper[next] - d);
      lower[k] = Math.min(lower[k], lower[next] + d);
      clearance[k] = Math.max(clearance[k], clearance[next] - d);
      ceiling[k] = Math.min(ceiling[k], ceiling[next] + d);
    }
  }
  // The blend of two cone envelopes is a sawtooth: it runs at the ruling grade
  // almost everywhere, because a cone does. Real vertical alignments have long
  // vertical curves and long level stretches, and smoothing gives both. A
  // [1 4 6 4 1] kernel is a convex combination, so it cannot exceed the grade;
  // it can dip under a clearance, so that floor is imposed again afterwards —
  // and the maximum of two slope-limited surfaces is slope-limited too.
  let rail = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    rail[i] = upper[i] * CUT_FILL_BALANCE + lower[i] * (1 - CUT_FILL_BALANCE);
  }
  for (let pass = 0; pass < PROFILE_SMOOTHING; pass++) {
    const next = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      next[i] = (rail[(i - 2 + N) % N] + 4 * rail[(i - 1 + N) % N] + 6 * rail[i]
        + 4 * rail[(i + 1) % N] + rail[(i + 2) % N]) / 16;
    }
    rail = next;
  }
  // Where a bore's ceiling and a clearance disagree, the clearance wins.
  //
  // They disagree at a portal that opens straight onto water. The ceiling cone
  // carries the bore's cover requirement outward at the ruling grade, so a few
  // hundred metres of open sea past the mouth are still told to stay deep,
  // while the water underneath asks for six metres of air. `min(max(rail,
  // clearance), ceiling)` let the ceiling have the last word and put 58 points
  // of deck *under the sea* — a train doing 300 km/h through the water, which
  // is exactly the sort of thing that reads as a broken game.
  //
  // Raising the ceiling to meet the clearance is the honest resolution: cover
  // is a preference, air over a shipping lane is not. Where it bites, the line
  // simply comes up early and stops being a bore there — the structure pass
  // reads the finished profile against the ground, so it reclassifies itself as
  // a cutting without being told. Both surfaces are slope-limited and the
  // maximum of two slope-limited surfaces is slope-limited, so this costs the
  // grade guarantee nothing.
  for (let i = 0; i < N; i++) ceiling[i] = Math.max(ceiling[i], clearance[i]);
  for (let i = 0; i < N; i++) rail[i] = Math.min(Math.max(rail[i], clearance[i]), ceiling[i]);
  return rail;
}

const BALLAST = 0; const VIADUCT = 1; const TUNNEL = 2; const CUTTING = 3;
const rail = gradeProfile();
for (let i = 0; i < N; i++) {
  const p = points[i];
  p.y = +rail[i].toFixed(2);
  // Reclaimed land is built to whatever height the alignment wants: the
  // causeway simply rises with the line where it ramps up to meet a shore.
  // Left at a fixed freeboard, the grading saw metres of fill over it and
  // called two thirds of the causeway a viaduct — a pier on top of an
  // embankment, which is neither one thing nor the other.
  if (p.made) p.ground = rail[i];
  p.fill = p.ground === null ? null : +(rail[i] - p.ground).toFixed(2);
  // What this *is* is decided by where the rail ended up against the ground,
  // never by where it was hoped to go.
  //
  // `bored` used to force TUNNEL on its own, and it does not mean "there is a
  // hill over me" — it means the cell was inside a building's clearance and the
  // simplifier drew a chord through it, expecting the grading to dive under.
  // The grading does not always get to: over water and over roads the clearance
  // floor outranks the bore ceiling, and the smoothing rounds off the rest. So
  // 135 of 260 bore points had under nine metres of cover and the shallowest
  // was 5.5 m *above* the ground — a concrete tube standing in the open air,
  // with the terrain shader dutifully carving a hole in the hillside around it.
  // That is the "tunnel over buildings" and half the "huge cutouts".
  //
  // Cover decides now. A point that wanted to bore and did not get deep enough
  // comes out as a cutting or an embankment, which is what it looks like.
  // A drawn cut outranks the cover test — but only on land, and only where the
  // rail is actually under the ground; over water there is nothing to cut.
  if (onSpan(FORCED_BORES, p.x, p.z)) {
    // A drawn bore gets a real bore where one can exist — over water, where the
    // tube carries itself, or under cover deep enough to keep the carved arch
    // buried. Where the ground is there but too thin, boring anyway punches the
    // arch out through the hillside; the buildable answer is cut and cover, so
    // the point stays an excavation and is roofed instead.
    if (p.ground === null || p.ground - rail[i] >= TUNNEL_MIN_COVER) p.structure = TUNNEL;
    else { p.structure = CUTTING; p.covered = 1; }
  } else if (p.kind === WATER || p.kind === ROAD) p.structure = VIADUCT;
  else if (p.fill > VIADUCT_FILL) p.structure = VIADUCT;
  else if (p.fill < -TUNNEL_MIN_COVER) p.structure = TUNNEL;
  else if (p.fill < -CUTTING_COVER) p.structure = CUTTING;
  else p.structure = BALLAST;
}

/** Runs of one structure, as [first, last] index pairs. */
function runsOf(structure) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= N; i++) {
    const on = i < N && points[i].structure === structure;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  return runs;
}

/**
 * Cleans up what the thresholds produced: undulating ground flickers in and
 * out of them, so one crossing comes out as five viaducts with four
 * embankments between. Gaps are absorbed first, then short runs dropped —
 * unless they carry the line over water or a road, which must stay structure.
 */
function tidyStructures(structure) {
  const runs = runsOf(structure);
  for (let i = runs.length - 1; i > 0; i--) {
    const gap = (runs[i][0] - runs[i - 1][1] - 1) * STEP;
    if (gap >= MIN_GAP) continue;
    for (let k = runs[i - 1][1] + 1; k < runs[i][0]; k++) points[k].structure = structure;
    runs[i - 1][1] = runs[i][1];
    runs.splice(i, 1);
  }
  for (const [from, to] of runs) {
    if ((to - from + 1) * STEP >= MIN_STRUCTURE) continue;
    if (points.slice(from, to + 1).some((p) => p.kind !== GRASS)) continue;
    // Never tidy away an excavation the line is actually inside. BALLAST is the
    // one structure the terrain shader does not carve at all, so calling a
    // buried point ballast does not remove the earthworks — it removes the hole
    // and leaves the railway inside the hill. A 1-point cutting with 11.5 m of
    // ground over the rail went this way and the bore ran headlong into a wall
    // of uncut grass, seen from the cab as the tunnel simply stopping.
    if (points.slice(from, to + 1).some((p) => p.fill !== null && p.fill < -CUTTING_COVER)) continue;
    for (let k = from; k <= to; k++) points[k].structure = BALLAST;
  }
}
tidyStructures(VIADUCT);
tidyStructures(TUNNEL);
tidyStructures(CUTTING);

// Join bores that are close together — and join them properly.
//
// Marking the gap `enclosed` and leaving the structure alone was half a job: it
// put the shell over the gap but kept the VIADUCT underneath, so a deck and its
// piers were still drawn and what you saw between two bores was a bridge with a
// lid. The gap becomes TUNNEL outright, so `isDeck` stops matching, the deck
// and piers go, and the lining runs unbroken from one bore into the other.
//
// Over water that is a tube spanning the gap on its own, which is what a
// covered way across a narrow inlet is. It is only ever done over gaps up to
// `TUNNEL_JOIN`, so the span stays short enough to read as one.
for (const p of points) p.enclosed = (p.structure === TUNNEL || p.covered) ? 1 : 0;
{
  const bores = runsOf(TUNNEL);
  let joined = 0;
  for (let i = 0; i < bores.length - 1; i++) {
    const gap = (bores[i + 1][0] - bores[i][1] - 1) * STEP;
    if (gap > TUNNEL_JOIN) continue;
    for (let k = bores[i][1] + 1; k < bores[i + 1][0]; k++) {
      const p = points[k];
      p.enclosed = 1;
      // Only make it a bore where a bore could actually exist: over water,
      // where the tube carries itself and there is no terrain to break out of,
      // or under cover deep enough to keep the carved arch buried. Converting
      // regardless put four points of "tunnel" under 1.1 m of ground, and the
      // arch came out through the hillside as a horseshoe hole in the grass.
      // A shallow gap stays a cutting and simply gets the shell over it.
      if (p.ground === null || p.ground - rail[k] >= TUNNEL_MIN_COVER) {
        p.structure = TUNNEL;
      }
    }
    joined++;
    step(`joined tunnels ${i + 1} and ${i + 2}: ${gap.toFixed(0)} m gap enclosed`);
  }
  if (!joined) step('no two bores close enough to join');
}

// ---------------------------------------------------------------------------
// 7. Report and write.
// ---------------------------------------------------------------------------
let length = 0;
for (let i = 0; i < N; i++) length += spanTo(i, (i + 1) % N);
const spans = runsOf(VIADUCT).map(([a, b]) => (b - a + 1) * STEP);
const cuttings = runsOf(CUTTING).map(([a, b]) => (b - a + 1) * STEP);
const bores = runsOf(TUNNEL).map(([a, b]) => (b - a + 1) * STEP);
const enclosedRuns = (() => {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= N; i++) {
    const on = i < N && points[i].enclosed === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push((i - start) * STEP); start = -1; }
  }
  return runs;
})();
const grades = points.map((p, i) => Math.abs(points[(i + 1) % N].y - p.y) / (spanTo(i, (i + 1) % N) || 1))
  .sort((a, b) => a - b);
const fills = points.filter((p) => p.fill !== null).map((p) => p.fill);
const sortedRadii = radii.slice().sort((a, b) => a - b);
const made = points.filter((p) => p.made).length;

writeFileSync(OUT, `${JSON.stringify({
  seed,
  step: STEP,
  lengthMetres: +length.toFixed(1),
  minRadiusMetres: +sortedRadii[0].toFixed(0),
  bridgeCount: spans.length,
  bridgeSpansMetres: spans.slice().sort((a, b) => b - a),
  causewayMetres: made * STEP,
  tunnelCount: bores.length,
  tunnelLengthsMetres: bores.slice().sort((a, b) => b - a),
  /** Bores plus the galleries joining them: what the driver runs through. */
  enclosedCount: enclosedRuns.length,
  enclosedLengthsMetres: enclosedRuns.slice().sort((a, b) => b - a),
  /**
   * `[x, railY, z, structure, groundY, onRoad, enclosed, made, street, kerbLeft, kerbRight]`, where structure is
   * 0 ballast / 1 viaduct or bridge / 2 tunnel / 3 open cutting. `groundY` is null over water
   * and is what the renderer stands piers on where it is not; `onRoad` marks a
   * street the line bridges; `enclosed` covers every bore *and* any short gap
   * joining two of them, which is what the driver sees as one tunnel; `made`
   * marks reclaimed causeway, which the renderer has to build the land for;
   * `street` marks a point carried over a road inside a drawn elevated span
   * (see `ELEVATED`), and `kerbLeft`/`kerbRight` are the measured distances
   * from the line to the carriageway's edge on each hand, which is where the
   * renderer stands that span's columns.
   */
  cuttingCount: cuttings.length,
  cuttingLengthsMetres: cuttings.slice().sort((a, b) => b - a),
  points: points.map((p) => [p.x, p.y, p.z, p.structure,
    p.ground === null ? null : +p.ground.toFixed(2), p.kind === ROAD ? 1 : 0, p.enclosed,
    p.made, p.street ? 1 : 0, p.kerbLeft ?? 0, p.kerbRight ?? 0]),
}, null, 1)}\n`);

// Preview PNG: the only way to know whether the route goes where it was meant to.
{
  const scale = 3;
  const PW = Math.floor(RW / scale);
  const PH = Math.floor(RH / scale);
  const img = Buffer.alloc(PW * PH * 3);
  for (let j = 0; j < PH; j++) {
    for (let i = 0; i < PW; i++) {
      const o = (j * PW + i) * 3;
      const s = rasterAt(nav.originX + i * scale * nav.metresPerPixel,
        nav.originZ + j * scale * nav.metresPerPixel);
      if (!s || s.h <= VOID_H) { img[o] = 10; img[o + 1] = 20; img[o + 2] = 40; }
      else if (s.h <= SHORE_LEVEL) { img[o] = 40; img[o + 1] = 70; img[o + 2] = 90; }
      else if (s.road) { img[o] = 90; img[o + 1] = 90; img[o + 2] = 95; }
      else { img[o] = 28; img[o + 1] = 74; img[o + 2] = 34; }
    }
  }
  const plot = (x, z, r, g, b, rad) => {
    const i0 = Math.round((x - nav.originX) / nav.metresPerPixel / scale);
    const j0 = Math.round((z - nav.originZ) / nav.metresPerPixel / scale);
    for (let dj = -rad; dj <= rad; dj++) {
      for (let di = -rad; di <= rad; di++) {
        const i = i0 + di; const j = j0 + dj;
        if (i < 0 || j < 0 || i >= PW || j >= PH) continue;
        const o = (j * PW + i) * 3;
        img[o] = r; img[o + 1] = g; img[o + 2] = b;
      }
    }
  };
  // Ballast in amber, decks on piers in red, tunnels in violet, anchors white.
  for (const pt of points) {
    if (pt.street) plot(pt.x, pt.z, 60, 200, 235, 2);
    else if (pt.structure === VIADUCT) plot(pt.x, pt.z, 235, 70, 60, 2);
    else if (pt.structure === TUNNEL) plot(pt.x, pt.z, 140, 110, 235, 2);
    else if (pt.structure === CUTTING) plot(pt.x, pt.z, 120, 170, 210, 1);
    else plot(pt.x, pt.z, 250, 190, 60, 1);
  }
  for (const a of anchors) plot(cx(a.gx), cz(a.gz), 255, 255, 255, 2);
  await sharp(img, { raw: { width: PW, height: PH, channels: 3 } }).png().toFile(PREVIEW);
  console.log(`  preview ${PREVIEW}`);
}

const onWater = points.filter((p) => p.kind === WATER).length;
const onRoad = points.filter((p) => p.kind === ROAD).length;
const elevated = points.filter((p) => p.structure === VIADUCT).length;
const bored = points.filter((p) => p.structure === TUNNEL).length;
const cut = points.filter((p) => p.structure === CUTTING).length;
console.log('\n--- train route ---');
console.log(`  ${(length / 1000).toFixed(2)} km loop, ${N} points at ${STEP} m`);
console.log(`  ${radii.length} corners; radius min ${sortedRadii[0].toFixed(0)} m, `
  + `median ${sortedRadii[sortedRadii.length >> 1].toFixed(0)} m, `
  + `${sortedRadii.filter((r) => r < R_MIN).length} tighter than ${R_MIN} m`);
console.log(`  ${spans.length} structures over ${((elevated * STEP) / 1000).toFixed(2)} km, `
  + `longest ${Math.max(...spans, 0)} m — ${((onWater * STEP) / 1000).toFixed(2)} km over water, `
  + `${(onRoad * STEP).toFixed(0)} m over streets (all bridged)`);
console.log(`  ${((made * STEP) / 1000).toFixed(2)} km on reclaimed causeway`);
console.log(`  ${bores.length} bore${bores.length === 1 ? '' : 's'} over `
  + `${((bored * STEP) / 1000).toFixed(2)} km, longest ${Math.max(...bores, 0)} m`);
console.log(`  ${cuttings.length} cutting${cuttings.length === 1 ? '' : 's'} over `
  + `${((cut * STEP) / 1000).toFixed(2)} km (the open approaches to the bores)`);
console.log(`  ${enclosedRuns.length} enclosed stretch${enclosedRuns.length === 1 ? '' : 'es'} `
  + `(bores plus the galleries joining them), longest ${Math.max(...enclosedRuns, 0)} m`);
console.log(`  grade: median ${(grades[N >> 1] * 100).toFixed(1)}%, `
  + `90th ${(grades[Math.floor(N * 0.9)] * 100).toFixed(1)}%, `
  + `worst ${(grades[N - 1] * 100).toFixed(1)}% (ruling ${(RULING_GRADE * 100).toFixed(0)}%)`);
console.log(`  earthworks: deepest fill ${Math.max(...fills).toFixed(1)} m, `
  + `deepest cover ${(-Math.min(...fills)).toFixed(1)} m`);
console.log(`  wrote ${OUT}\n`);
