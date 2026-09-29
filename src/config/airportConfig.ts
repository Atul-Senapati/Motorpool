/**
 * Halcyon Field: a made island east of the city, and the airport on it.
 *
 * ## Why it is its own island, and its own file
 *
 * The two islands the map already has belong to the railway. They are drawn in
 * `trainSketch.json`, they exist because the line has to cross the northern
 * bay, and three separate modules pick one of them **by area** — the station
 * takes the largest (`stationConfig`), the village the smallest
 * (`villageConfig`), the town the largest again (`townConfig`). Adding a third
 * island to `TRAIN_ISLANDS` that is bigger than either would therefore not add
 * an island; it would silently move the railway station onto it. So this one
 * is declared here, rendered by `AirportIsland`, and never enters that array.
 *
 * ## Where
 *
 * In the open water off the **west coast**, level with the city, 260 m from
 * the mainland shore — the spot you get if you draw an oval on the map west of
 * the racing circuit. It went east first, then into the northern bay beside
 * the railway's islands; this is the third home and the one that was actually
 * asked for.
 *
 * Two things had to give, and both are the sort that only show up when
 * measured.
 *
 * **The map had a fixed margin.** The city map is the nav raster inset into a
 * larger canvas, and that inset was a constant 110 px — 165 m. This island
 * reaches 590 m past the raster's west edge, so with a fixed margin it was
 * simply not drawn: it existed in the world and was missing from the map. The
 * margin is now measured per side from whatever sticks out (`mapPad`), so only
 * the west side grows and the canvas is 14% larger rather than double.
 *
 * **The west-coast shipping lane is close.** `SEA_ROUTES` runs two yachts
 * round a 240 m ring at (-2150, 150), and that ring is what stops the island
 * coming any further inshore. It passes 83 m off, which is the same margin the
 * coastal lanes were themselves drawn to, so nothing had to move.
 *
 * What it clears, all measured on the outline below rather than on a circle
 * round it:
 *
 * ```
 *   mainland shore   260 m        nearest sea lane   83 m
 *   railway          > 260 m      Kestrel          1,081 m
 * ```
 *
 * ## How big, and what shape
 *
 * "Double the station island" is meant literally. Kestrel is traced at
 * 115,524 m² and grown by `ISLAND_GROWTH` (1.08 across, 1.9 deep), so the land
 * that is actually there is 115,524 x 2.052 = 237,055 m². This comes out at
 * **474,110 m²** — 2.000x — and that is after the roughening below, not before
 * it: `halfLength` was solved for so the finished coast has the right area.
 *
 * The base is a stadium, a rectangle with semicircular ends, because an
 * airport wants one long axis. What is drawn is that stadium with its radius
 * bent about the centre by three sine harmonics, so the coast wanders in and
 * out by up to 13% and no two stretches of it are alike. A perfect ellipse
 * reads as a game object; a reclamation reads as a place. The harmonics are
 * smooth and periodic, which is what keeps the outline star-shaped about the
 * centre — the crown's triangle fan and the sea wall's extrusion both need
 * that, and a random per-point jitter would break it.
 *
 * ## No beach: a sea wall
 *
 * The railway's islands shelve into the water on a sand batter. This one does
 * not. It is a reclamation with an airfield on it, and what holds that kind of
 * ground up is a vertical concrete revetment — Kansai, Chek Lap Kok — so the
 * land simply stops, 7 m of wall stands above the water, and the wall goes on
 * down to the seabed so there is no seam at the waterline.
 *
 * ## The frame
 *
 * Same discipline as the station's town: **nothing below is a world
 * coordinate**. `AirportIsland` draws the lot inside one group at
 * `SITE.centre`, turned to `SITE.heading`, in which local **+X runs down the
 * runway** and local **+Z is north of it** — landside. Move the island by
 * editing `SITE` and everything on it moves with it.
 *
 * How much land there is at each station along the runway, measured off the
 * stadium rather than guessed, as half-width in metres either side of the axis:
 *
 * ```
 *   |x|      0    252    300    350    400    420    450    480
 *   half   260    260  255.5  240.8  213.8  198.4  168.5  125.0
 * ```
 *
 * The runway ends at |x| = 420, where there is still 198 m of half-width for a
 * strip that needs 142.5, and 62 m of land beyond each threshold for the
 * stopway. Nothing here is closer than 20 m to the beach.
 */

import serviceRoutes from './serviceRoutes.json';
import roadModels from './roadModelData.json';
import paradeModels from './paradeModelData.json';

const TAU = Math.PI * 2;

/** Whether the island and its airport are part of the world at all. */
export const AIRPORT_ENABLED = true;

/**
 * Where the island is and which way its runway points.
 *
 * The heading is not chosen for looks; it is the one that fitted. Position and
 * heading were searched together, and 2.945 rad is what came out — which also
 * happens to lay the runway along the bay rather than pointing it at the
 * city.
 *
 * `ground` is the crown height, and it is sea level — 3.6 m of freeboard over
 * `TRAIN.seaLevel` and no more, which is lower than the railway islands' 3.2 m
 * rather than the shade higher it used to be.
 *
 * It was 3.4, on the argument that an airfield is graded and theirs are not.
 * What changed is the bridge. The crossing has to clear the island railway
 * that now runs under its arch, and the railway stands on this crown — so the
 * deck's crest is pinned at the crown plus the railway's build-up plus the
 * clearance, and every metre of crown is a metre the deck must climb from the
 * city street at the far end. At 3.4 the climb was 13.31 m, which no approach
 * short enough to fit the city could do at a believable grade: it was being
 * done at 11.5%, up a ramp that ran through three quarters of the arch.
 *
 * Dropping the crown to 0 takes 3.4 m straight off that climb and nothing
 * else: the island end of the deck drops with it, so the seaward grade is
 * untouched. Everything on the island is drawn in the island's own frame and
 * hangs off this number — the crown mesh, the perimeter wall (whose toe is
 * `TRAIN.seabed - SITE.ground` and simply gets 3.4 m deeper), the runway, the
 * park, the freight yard and its railway — so the whole thing moves down
 * together and nothing inside it has to be re-measured.
 *
 * A made airfield sitting barely above its own sea is not a compromise, it is
 * what reclaimed airports look like; the ones built on fill are within a
 * couple of metres of the water all round.
 */
export const SITE = {
  centre: [-2700, 0] as [number, number],
  heading: 1.2708,
  ground: 0,
} as const;

/**
 * The base stadium, how hard the coast is bent, and how deep the wall goes.
 *
 * `halfLength` is 510.8 and not a round number because it was solved for: the
 * roughening below changes the area, so the length was iterated until the
 * finished outline measured exactly twice Kestrel's.
 *
 * That solve is now one term of two. `eastward` stretches the east half by
 * 16% on top of it, for the bridge, and the island is correspondingly bigger
 * than the figure the length was iterated to. The length is left where the
 * solve put it rather than re-solved downwards, because shrinking the stadium
 * to pay for the headland would pull the west end and both sides in under an
 * airfield that has been laid out against them.
 */
export const ISLAND = {
  halfLength: 510.8,
  radius: 320,
  /**
   * How much further the LANDSIDE half reaches than the seaward half.
   *
   * The island is a stadium, and a stadium is symmetric; this one is not. The
   * runway sits on the seaward side and everything else — apron, terminal,
   * road, car park — is landside, so the two halves want different amounts of
   * room, and the landside is also the side facing the city, which is the side
   * there was room to grow into. 1.35 puts the east shore 432 m from the
   * centre against 320 m to the west.
   *
   * Applied to z after the roughening and only where z is positive, which
   * keeps the outline star-shaped about the centre: scaling one half-plane
   * maps rays from the origin to rays from the origin, so the crown's triangle
   * fan and the sea wall's extrusion are both still valid.
   */
  landside: 1.35,
  /**
   * How much further the EAST end reaches, and it is the bridge that asked.
   *
   * The crossing arrives on a curve, because the city's coast road and the
   * island's outer road are 65° apart and something has to take the turn. The
   * question is only ever WHERE it is taken, and a curve carried on piers
   * over open water is the worst answer available: you cannot see it from the
   * deck, it reads as a bend in a bridge rather than a bend in a road, and it
   * costs 90 m of structure to do what a verge and a kerb do for nothing.
   *
   * So the land comes out to meet it — but only just, because how MUCH land
   * is a trade against how sharp the turn is, and the turn is allowed to be
   * sharp. A tighter radius is a shorter arc, a shorter arc starts later, and
   * a bend that starts later needs less island under it. Swept against the
   * deck's own edges, which is what runs out of shore first:
   *
   *     radius 79 m   90 m of arc   needs 1.160   +87 m of headland
   *     radius 66 m   73 m of arc   needs 1.100   +54 m
   *     radius 52 m   55 m of arc   needs 1.050   +27 m
   *     radius 45 m   46 m of arc   needs 1.025   +14 m
   *     radius 37 m   37 m of arc   needs 1.000   none at all
   *
   * 1.05 is the settled point: a 52 m radius is a firm corner rather than a
   * hairpin, and 27 m is a bulge in a coastline rather than a pier of
   * reclaimed land sticking out to sea. The east shore goes from 543 m off
   * the centre to 570, landfall moves from 205 m along the crossing to 184,
   * and the whole 55 m turn is on grass: the bend starts 4.6 m after the deck
   * reaches dry land and never comes back out over the water.
   *
   * What is left over water is a dead-straight 184 m span, which is what the
   * arch is for and all the arch has to be.
   *
   * It is the same trick as `landside` in the same place for the same reason:
   * applied to x after the roughening and only where x is positive, so the
   * outline stays star-shaped about the centre and the east end stretches
   * without the west end or either side moving at all.
   */
  eastward: 1.05,
  /**
   * How far the coast wanders from the stadium, as a fraction of the radius.
   * 0.13 is enough to read as a real shoreline from a boat and little enough
   * that the airfield still fits inside the envelope with metres to spare.
   */
  roughness: 0.13,
  /** Points round each rounded end, and along each straight side. */
  endSteps: 22,
  sideSteps: 16,
} as const;



/**
 * The outline, in the island's own frame.
 *
 * Generated rather than traced, because this island is a described shape and
 * not a drawn one — and because the beach skirt and the crown fan both need it
 * to stay star-shaped about the centre, which a formula guarantees and a hand
 * trace does not. 24 points round each end is a 7.5 degree step: at a 260 m
 * radius that is a 34 m chord, which from a boat is a curve.
 *
 * **Wound so that a fan over it faces UP**, which is the same trap
 * `trainConfig` documents for the drawn islands and which this fell into
 * anyway. In the XZ plane with Y up, a triangle's normal is +Y only when the
 * shoelace sum is negative; generated the obvious way — sweeping the angle
 * upward — it comes out positive, the crown's every triangle faces the seabed,
 * and with a front-facing material the island is simply not drawn. What you
 * get is a car apparently parked on the sea, with the buildings and the
 * runway floating above it, which is precisely what the first build looked
 * like. Reversing the sweep is the whole fix; the assertion below is so it can
 * never come back.
 */
/**
 * The reclaimed headland on the east shore, under the road bridge.
 *
 * A railway had to get under the bridge where the deck is high enough to clear
 * a train, and on this coast that is thirty to forty metres out from the bank.
 * Rather than dig the railway down to meet a low bridge — which on a shore
 * this close to the water is a canal, not a cutting — the land comes out to
 * meet it.
 *
 * ## Why it is a radial bump and not a drawn bulge
 *
 * Because the outline has to stay STAR-SHAPED about the centre. The crown fan
 * and the perimeter wall both assume it: the fan triangulates from the centre
 * outward, and a shape that doubles back on any ray folds the fan over itself.
 * Scaling the radius at an angle cannot do that, whatever the amplitude. It is
 * the same reason `roughness` bends the radius rather than nudging the points.
 *
 * ## The numbers
 *
 * Peak 46 m at 25 degrees, dying to nothing 11 degrees either side, which
 * covers the junction, the approach to the bridge and a 15 m shoulder round
 * both. North of it the line is on viaduct and needs no ground at all, which
 * is why the bump stops rather than following the track out to the open end.
 */
export const RECLAIM = {
  /** Where the headland is thickest, in degrees about the island's centre. */
  at: 30,
  /** How far it reaches, in degrees each side. Zero at the edges, so no seam. */
  spread: 16,
  /** Metres of new shore at the peak. */
  amplitude: 84,
} as const;

/** How far the shore is pushed out at this bearing, in the island's frame. */
export function reclaimAt(radians: number): number {
  const deg = (radians * 180) / Math.PI;
  const off = Math.abs(((deg - RECLAIM.at + 540) % 360) - 180);
  if (off >= RECLAIM.spread) return 0;
  return RECLAIM.amplitude * 0.5 * (1 + Math.cos((Math.PI * off) / RECLAIM.spread));
}

export const OUTLINE: ReadonlyArray<readonly [number, number]> = (() => {
  const { halfLength, radius, roughness, landside, eastward, endSteps, sideSteps } = ISLAND;
  const straight = halfLength - radius;
  const pts: Array<[number, number]> = [];
  // Round the stadium once, anticlockwise-in-screen-terms: east end, south
  // side, west end, north side. Wound so a fan over it faces UP — see below.
  for (let i = 0; i < endSteps; i++) {
    const a = TAU / 4 - (i / endSteps) * (TAU / 2);
    pts.push([straight + Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  for (let i = 0; i < sideSteps; i++) pts.push([straight - (i / sideSteps) * 2 * straight, -radius]);
  for (let i = 0; i < endSteps; i++) {
    const a = -TAU / 4 - (i / endSteps) * (TAU / 2);
    pts.push([-straight + Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  for (let i = 0; i < sideSteps; i++) pts.push([-straight + (i / sideSteps) * 2 * straight, radius]);
  // Bend the radius about the centre. Three harmonics at fixed phases: smooth,
  // periodic in the angle, and therefore closing on itself without a corner.
  // Scaling the radius rather than nudging each point keeps the shape
  // star-shaped about the centre, which the crown fan and the wall both need.
  /*
   * Extra points across the reclaimed arc, spliced in before the bump.
   *
   * The stadium is walked at `endSteps` per half turn — 8.2 degrees — and
   * `RECLAIM` spans twenty-two of them. Three samples across a headland draws
   * a triangle, so the arc is re-walked at a degree a step and the fine points
   * take the place of the coarse ones. Everything outside the arc keeps the
   * points it always had, so nothing else in the island moves by a millimetre.
   */
  const shaped = pts.map(([x, z]) => {
    const th = Math.atan2(z, x);
    const bend = 0.52 * Math.sin(3 * th + 0.9)
      + 0.31 * Math.sin(5 * th + 2.3)
      + 0.17 * Math.sin(8 * th + 5.1);
    const k = 1 + roughness * bend;
    // The landside half and the east end both reach further — see
    // `ISLAND.landside` and `ISLAND.eastward`.
    const xx = x * k;
    const zz = z * k;
    return [
      xx > 0 ? xx * eastward : xx,
      zz > 0 ? zz * landside : zz,
    ] as [number, number];
  });
  /*
   * Radius as a function of bearing, read off the shape above so the infill
   * follows the same coast the coarse points do.
   *
   * INTERPOLATED between the two coarse points either side, not snapped to the
   * nearer of them. Snapping made the infill a staircase: a degree of new
   * bearing every step but the radius only changing every eight, so the new
   * shore came out as a row of facets with the headland's curve faceted into
   * it. Reading between the two neighbours costs nothing and gives a coast
   * that curves.
   */
  const bearings = shaped.map(([x, z]) => Math.atan2(z, x));
  const wrap = (a: number) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const radiusAt = (want: number) => {
    let before = -1;
    let after = -1;
    let beforeOff = Infinity;
    let afterOff = Infinity;
    for (let i = 0; i < shaped.length; i++) {
      const off = wrap(bearings[i] - want);
      if (off >= 0 && off < afterOff) { afterOff = off; after = i; }
      if (off <= 0 && -off < beforeOff) { beforeOff = -off; before = i; }
    }
    if (before < 0) return Math.hypot(shaped[after][0], shaped[after][1]);
    if (after < 0) return Math.hypot(shaped[before][0], shaped[before][1]);
    const span = beforeOff + afterOff;
    const t = span < 1e-9 ? 0 : beforeOff / span;
    const rb = Math.hypot(shaped[before][0], shaped[before][1]);
    const ra = Math.hypot(shaped[after][0], shaped[after][1]);
    // Smoothstep rather than straight: the coarse points are 8 degrees apart,
    // and a linear blend between them leaves a crease at each one.
    const e = t * t * (3 - 2 * t);
    return rb + (ra - rb) * e;
  };
  const lo = ((RECLAIM.at - RECLAIM.spread) * Math.PI) / 180;
  const hi = ((RECLAIM.at + RECLAIM.spread) * Math.PI) / 180;
  const inArc = (b: number) => b > lo && b < hi;
  const out: Array<[number, number]> = [];
  let filled = false;
  for (let i = 0; i < shaped.length; i++) {
    if (!inArc(bearings[i])) { out.push(shaped[i]); continue; }
    if (filled) continue;
    filled = true;
    // HIGH bearing first: the stadium is walked with the bearing DECREASING,
    // and infill that ran the other way reversed the winding over the arc —
    // twenty-two reversals in a loop that still totalled −360°, which is a
    // shape that folds back on itself rather than an island.
    const steps = Math.ceil(((hi - lo) * 360) / Math.PI);
    for (let k2 = 0; k2 <= steps; k2++) {
      const b = hi - ((hi - lo) * k2) / steps;
      const r = radiusAt(b);
      out.push([Math.cos(b) * r, Math.sin(b) * r]);
    }
  }
  // And finally the headland itself, pushed straight out along each bearing.
  return out.map(([x, z]) => {
    const r = Math.hypot(x, z) || 1;
    const grow = reclaimAt(Math.atan2(z, x));
    return [x * (1 + grow / r), z * (1 + grow / r)] as [number, number];
  });
})();

/**
 * Where the shore is on each side of the runway at station `x`, as
 * `[south, north]` — or null off the ends of the island.
 *
 * Read off the outline itself rather than from the stadium it started as,
 * because the roughening moves it by up to 34 m and the scatter has to stay
 * behind the real coast, not the ideal one.
 */
export function shoreAt(x: number): [number, number] | null {
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < OUTLINE.length; i++) {
    const a = OUTLINE[i];
    const b = OUTLINE[(i + 1) % OUTLINE.length];
    if (a[0] === b[0]) continue;
    if ((a[0] - x) * (b[0] - x) > 0) continue;
    const z = a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    south = Math.min(south, z);
    north = Math.max(north, z);
  }
  return north > south ? [south, north] : null;
}

/** Twice the signed area. Negative means a fan over the outline faces up. */
export const outlineShoelace = (): number => OUTLINE.reduce((sum, [x, z], i) => {
  const [nx, nz] = OUTLINE[(i + 1) % OUTLINE.length];
  return sum + (x * nz - nx * z);
}, 0);

/** The same outline in world XZ, for the minimap and anything else outside the group. */
export function outlineWorld(): Array<[number, number]> {
  const c = Math.cos(SITE.heading);
  const s = Math.sin(SITE.heading);
  // The group is rotated about +Y by `heading`, which takes local (x, z) to
  // (x cos + z sin, -x sin + z cos) in world — the same convention three uses.
  return OUTLINE.map(([x, z]) => [
    SITE.centre[0] + x * c + z * s,
    SITE.centre[1] - x * s + z * c,
  ] as [number, number]);
}

/* -------------------------------------------------------------- the airfield */

/**
 * The runway.
 *
 * 840 x 45 m. Short for an airliner and right for this island: a real 45 m
 * runway is a code-4 strip 2 km long, and 2 km of anything does not fit on a
 * kilometre of land. What it is sized to instead is what it has to *look*
 * like from a boat passing the end of it, and 840 m of tarmac with the correct
 * markings on it reads as a runway at any distance you can see it from.
 *
 * Offset to the south side (`centre` -120) so the whole of the landside — the
 * apron, the terminal, the road and the car park — has the wide part of the
 * island to sit in, rather than being spread along both sides of a strip up
 * the middle.
 */
export const RUNWAY = {
  centre: -120,
  half: 420,
  width: 45,
  /** The graded strip either side of the paving: grass, no markings. */
  strip: 70,
} as const;

/** The parallel taxiway, and the three links that join it to the runway. */
export const TAXIWAY = {
  centre: -55,
  half: 380,
  width: 18,
  /** Links at these stations along the runway. */
  links: [-380, 0, 380] as readonly number[],
} as const;

/**
 * Every paved surface, as plain rectangles in the island's frame:
 * `[fromX, toX, fromZ, toZ]`.
 *
 * ## They tile; they never overlap
 *
 * All of it is laid at the same height, so two rectangles that overlap are two
 * coplanar surfaces fighting for the same pixels. Touching along an edge is
 * fine and is how the whole field is joined; sharing area is not. The taxiway
 * links are trimmed edge-to-edge for exactly this reason, and the terminal's
 * forecourt stops where the road starts.
 *
 * ## Airside is paved all the way to the back of the buildings
 *
 * The apron used to stop at the terminal's front face, which meant the
 * terminal — and the hangars, and the tower — stood on grass, and an airliner
 * at a gate had its wheels in a field. An airport's building line stands on
 * hard standing: `frontage` is that, one slab from the west end of the hangars
 * to the east end of freight, and the aircraft stands are the apron in front
 * of it.
 */
/**
 * The road kit's carriageway half-width, and where the airport entrance is.
 *
 * Both are hoisted above `PAVING` because a paving edge is set from them:
 * the landside road ends on the entrance's junction tile. `ENTRY` below is
 * built from `ENTRY_ALONG` for the same reason — the road, the junction and
 * the gate cannot be allowed to disagree about where the way in is.
 */
const ROAD_HALF = roadModels.parts.straight1.size[2] / 2;
/*
 * The entrance moved WEST, from 157 to 120, and everything on the landside
 * strip moved with it.
 *
 * It sat at 157 because that was the middle of the only gap there was — the
 * car park ended at 120 and the amusement park began at 200. The park wanted
 * the ground and there was nowhere else for it to grow: the outer road closes
 * it to the north, the cargo apron to the south, and the island's east coast
 * to the east. West is the only direction, and this road was in it.
 *
 * So the whole strip shifted: the surface car park gives up its last twelve
 * metres, the deck and its forecourt go twenty metres west, and the way in
 * lands at 120 against the deck rather than at 157 against nothing. The park's
 * west edge follows it to 134. Nothing here is closer to anything than it was.
 */
const ENTRY_ALONG = 120;

export const PAVING = {
  /**
   * The aircraft stands. Its south edge is the taxiway's north edge, exactly:
   * a plan of the first version had six metres of grass between the two, which
   * is an apron nothing can taxi onto.
   *
   * 86 m deep, down from 108. That is one 747 length nose-in at a gate plus
   * fifteen metres, so it is a stand rather than a stand with a taxilane
   * behind it — and it is the only lever there is for bringing the buildings
   * nearer the strip. The rest of the chain is already as tight as an airfield
   * gets: 33 m of runway strip, 18 m of taxiway, and the stands. Runway edge
   * to terminal face is 137 m now, which is at the near end of what real
   * airports do.
   */
  apron: [-230, 230, -46, 40] as const,
  /**
   * The sheds' own stands, running west from the main apron and joined to it.
   *
   * It reaches to -430 rather than -390 because the general-aviation corner
   * went in at the west end and there was nowhere else to put it. The row of
   * buildings was already shoulder to shoulder from the hangars to the
   * terminal — the widest hole in it was the 34 m between the fire station
   * and the terminal's west end — so a club hangar had to have ground made
   * for it, and this is the end of the field where a club hangar belongs.
   *
   * 40 m is what it costs: the hangar is 30.5 m across its door with 25 m to
   * spare either side of it. The island has the land — the half-width at
   * |x| = 430 is about 190 m seaward and 257 landside, against the 98 m the
   * frontage reaches — and nothing else was out here. The turn pad at the
   * threshold is the nearest thing and it is 100 m south, on the far side of
   * the runway strip.
   */
  hangarApron: [-430, -230, -46, 40] as const,
  /** The hard standing the whole building row stands on, apron edge to back. */
  frontage: [-430, 260, 40, 98] as const,
  /**
   * The terminal's back half, its kerb, and the ground the offices are on.
   *
   * It ends at 122, which is two metres past the terminal itself — and that is
   * the point. It ran to 175 once and to 152 after that, so at its longest it
   * was fifty-five metres of apron east of the end of the building it belongs
   * to: nothing parked on it, nothing was built on it, and the only thing that
   * used it was one service route's turning loop.
   *
   * That route has no vehicles on it any more (see `FLEET`), so the last
   * reason to keep the apron out here went with them — and what wanted the
   * ground is the amusement park, which needed this band clear to be a
   * rectangle rather than an L. An apron that wraps its building by two metres
   * is an apron; one that runs thirty past it is a field with a kerb.
   *
   * The terminal itself did not move, and moving it would not have helped: it
   * ends at 120 and is already clear, and what sets the park's west edge is
   * the airport entrance at 120, which is held off by the car park deck. None
   * of that chain touches this building.
   */
  forecourt: [-120, ENTRY_ALONG - ROAD_HALF, 98, 150] as const,
  /**
   * The ground under the gate road, from the frontage apron up to the
   * landside road, so the west of the field is not reached only by driving
   * the length of the terminal.
   *
   * It was a 9 m slab at along -390..-381 and it is 19 m at -404..-386 now,
   * because a carriageway runs on it: the corner at the west end became a
   * T-junction with an arm coming down here. See `AIRPORT_GATE`. The kit road
   * covers it, so what this paves is the joint where the carriageway meets
   * the apron.
   */
  hangarGate: [-404.5, -385.5, 98, 146] as const,
  /**
   * The main gate road: the straight entry, from the crossroads to the apron.
   *
   * The same thing as `hangarGate` at the other end of the field and built the
   * same way — a strip of paving the width of the carriageway, from the
   * frontage apron up to the junction tile, with the kit road laid over it.
   *
   * What is different is that this one is the way IN. The entrance used to
   * stop dead on the landside road, so arriving at the airport meant coming
   * off the bridge, turning south, turning again at a T and then driving the
   * length of the terminal to find a way onto the field. It is one straight
   * line now: outer road, crossroads, fence, apron.
   */
  terminalGate: [ENTRY_ALONG - ROAD_HALF, ENTRY_ALONG + ROAD_HALF, 98, 146] as const,
  /**
   * The landside road, across the back of the forecourt.
   *
   * It ends ON THE AIRPORT ENTRANCE'S JUNCTION, which is the second time it
   * has been shortened and the first time it has been shortened to something
   * rather than away from something.
   *
   * It ran to 230, then to 198 when the amusement park wanted the ground. Both
   * of those left it finishing in grass: the landside service route turns at
   * along 151 and the entrance is the last junction on the road, so every
   * metre past the entrance was carriageway nothing has ever driven. A road
   * that ends thirty metres past its own last turning is a road with a stub on
   * it; one that ends at the junction is just a road.
   *
   * `ENTRY_ALONG + ROAD_HALF` is the entrance tile's east face, so the kit's
   * last straight stops exactly where the junction begins and the two meet
   * without a gap or an overlap. It also hands the park another 31 m at its
   * west end — see `PARK.bounds` in `parkConfig`, which now reaches 176.
   */
  road: [-375, ENTRY_ALONG + ROAD_HALF, 150, 159] as const,
  /** Straight out of the back of the terminal, exactly as wide as it, and
   *  against the road rather than six metres of grass away from it. */
  carPark: [-90, 108, 159, 194] as const,
  /**
   * The cargo apron, off the east end of the frontage and joined to it along
   * x = 260. Freight is the half of an airport that is all shed and container
   * and no glass, and it is what the island's new east ground is for.
   */
  cargo: [260, 430, -46, 98] as const,
  /**
   * The fillet on the east side of the middle link.
   *
   * A link is 18 m wide and an aeroplane leaving the runway at 36 km/h turns
   * in rather more than that: the exit curve ran 30 m east of the link and
   * therefore across the grass. Real airports widen the exit, or build an
   * angled rapid-exit taxiway; this is the widening. It butts the link's east
   * edge and reaches the taxiway.
   *
   * It reaches to 62 rather than 40 because of what happens on it. The ATR
   * lands going east and parks going west, so it turns round here, and a half
   * circle between two centrelines 65 m apart has a radius of 32.5 whether you
   * like it or not. That swings the aeroplane 49.5 m east of the link's
   * centreline and its outer wheels 7 m further — so the pavement goes to 62,
   * which is the turn plus its track plus a little, and not a round number
   * chosen first and checked afterwards.
   */
  exitFillet: [9, 62, -97.5, -64] as const,
  /**
   * The cargo end's exit, and it was missing.
   *
   * There are links between the runway and the taxiway at three stations —
   * −380, 0 and +380 — and the freighter turns off at about +270, which is
   * between two of them. It was taxiing across 30 m of grass to reach the
   * taxiway, which a plan check catches in one line and a fly-past does not.
   * A long-bodied freighter wants its own exit at the end it uses rather than
   * a detour to a link 110 m further on, so it has one.
   *
   * It butts the runway's edge at −97.5 and the taxiway's at −64 without
   * overlapping either: paving here tiles, it never stacks.
   *
   * It sits at 294..339 rather than 240..300 because the exit it serves was
   * rebuilt as a single 100 m arc from the centreline to the stand, and an arc
   * crosses the gap where its radius says it does — island x 303 to 330, plus
   * the wheel track either side. The throat follows the path; the path does
   * not bend to reach the throat.
   */
  cargoExit: [294, 339, -97.5, -64] as const,
  /** The same widening on the threshold link, where it turns off to back-taxi. */
  lineUpFillet: [-371, -340, -97.5, -64] as const,
  /**
   * The turn pad at the threshold.
   *
   * A runway an aeroplane has to back-taxi down needs somewhere to turn round
   * at the end of it, and a 747's minimum turning radius is about 45 m — more
   * than the 18 m width of a taxiway link. Real runways get a widened pad for
   * exactly this. It butts against the south edge of the runway paving, on the
   * graded strip where there was nothing.
   */
  turnPad: [-435, -300, -165, -142.5] as const,
  /* ------------------------------------------------------- the way in ---- */
  /*
   * The airport approach is NOT here any more, and that is the point.
   *
   * It used to be three rectangles of slab — a flare onto the terminal road,
   * the straight run, and a flare onto the back road — with its lane lines,
   * its kerbs and its central reservation all drawn by hand on top. That was
   * the right way to build it when it was the only road on the island that
   * was not a slab; it is the wrong way now that every other road here comes
   * out of `modular_roads_pack`, because a hand-painted road next to a kit one
   * reads as a different kind of surface, which is exactly what it is.
   *
   * It is a kit road like the west link and the two parade links: a junction
   * tile on each of the two long roads and a run between them. `roadConfig`
   * builds it from `ENTRY.centre` and nothing needs a slab here at all.
   *
   * What makes it the way IN rather than a fourth link is the site on it —
   * the gate, the gatehouse, the sign gantry and the avenue. See `ENTRY`.
   */
  /**
   * The road across the back of the island.
   *
   * It ends at 330 and it is staying there. It was stretched 18 m east once,
   * to reach out and catch the bridge, which is the wrong way round: these
   * roads were here first and a crossing arriving late does not get to move
   * them. The bridge now stops where this road already ended.
   *
   * **It is the last made ground behind the car park.** Two more slabs used to
   * lie out here — a `landside` strip at across 194..252 and an `outerBlock` of
   * 730 x 64 m behind this road — carrying seven chunks of lifted city frontage
   * and three airport blocks between them. From the air that was a black field
   * with a row of offices standing on it. It is all grass now. The road itself
   * is not decoration and stays: the bridge lands on it and `parkConfig` hangs
   * Halcyon Pier's gate off its south edge.
   */
  /**
   * Four lanes, 14 m, widened from the 9 m two-laner it opened as.
   *
   * 14 and not 18 because the lane is not a free choice: this road runs
   * straight onto the bridge, the deck's lane was 3.5 m, and a road whose
   * lanes are wider than the deck's would step in width at the joint. Four
   * times 3.5 it is, and `buildMarks` paints the lines to the deck's own
   * `dash` and `lineWidth` for the same reason.
   *
   * It grew NORTH, and the south edge staying at 252 is not incidental —
   * `parkConfig` hangs the pier's gate off `PAVING.outerRoad[2]` and lays its
   * gateway apron up to a hardcoded 252 to meet it. Move this edge and the
   * gate apron overlaps the road by however far it moved, which is two
   * coplanar surfaces and therefore a z-fight across the park entrance.
   *
   * Growing north cost the block behind it 5 m and moved two of its
   * buildings: `deco_Building_-3_2` sat 1 m off the old kerb and
   * `deco_Building_-4_-2` 4 m off it, so both were under the new carriageway
   * until they were nudged back. See `DECO`.
   */
  /**
   * The outer road. Its EAST END is where the bridge aims — `AirportBridge`
   * reads this to find its landing — and it is 410 now rather than 330,
   * because that is where the cargo road leaves it.
   *
   * The three used to meet nowhere: the bridge came down at 331, the cargo
   * turn was at 410, and 79 m of road ran between them, so you crossed, drove
   * on, and turned off somewhere else. They are one junction now.
   *
   * 420 and not 410, which is the junction's CENTRE: the deck ends exactly
   * here, and aiming it at the centre laid the last 9.5 m of bridge on top of
   * the junction tile — parapets and all — hiding half the crossings and
   * leaving the T with a slab of deck for an east arm. 420 is half a metre
   * past the tile's east face, so the two meet instead of stacking.
   *
   * The junction itself is at 410 and cannot move west. The park occupies
   * along 200..396 up to across 248 and this road's south kerb is at 249.5 —
   * a metre and a half of gap — so anything leaving the road between 200 and
   * 396 would run through the fairground.
   */
  outerRoad: [-400, 420, 252, 266] as const,
  /**
   * The car park's forecourt: the tarmac between the road and its ramp.
   *
   * Deliberately small. The last attempt at a landside strip was pulled out
   * because its hard standing "read from the air as a black field with
   * offices on it", and the cure for that is not to have less building, it is
   * to have less tarmac: everything else in the parade stands on grass and
   * meets the footway directly. This is the one piece that has to be paved,
   * because a car park you reach across a lawn is not a car park.
   */
  paradeYard: [43, 107, 238, 250] as const,
} as const;

/**
 * How many lanes the outer road is marked out as.
 *
 * Here rather than inline in the paint, because it is the one number the
 * rectangle above does not carry: a width of 14 m is four lanes or two fat
 * ones depending only on what you draw on it.
 */
export const OUTER_ROAD_LANES = 4;

/**
 * What is built, and out of what.
 *
 * Every one of these is a mesh out of `public/models/airport.glb`, which
 * `prepare-airport.mjs` builds from two dropped exports: a general-aviation
 * airfield kit and one 273 m terminal concourse. Before those arrived the
 * airfield was made of city chunks — a terminal was a row of high-street
 * frontage, a hangar was a wide two-storey block — which was the right answer
 * with no airport assets and is not the right answer now.
 *
 * | part       | size (m)          | used as                     |
 * | ---------- | ----------------- | --------------------------- |
 * | `terminal` | 108 x 24 x 210    | the terminal                |
 * | `tower`    | 18 x 45 x 15      | control tower               |
 * | `hangar`   | 60 x 21 x 45      | the two sheds               |
 * | `shed`     | 15 x 11 x 60      | maintenance shed            |
 * | `freight`  | 28 x 23 x 76      | freight                     |
 * | `admin`    | 31 x 28 x 17      | landside offices            |
 * | `fire`     | 23 x 11 x 43      | fire station                |
 * | `clubHangar` | 25 x 10 x 30    | the general-aviation hangar |
 * | `antenna`  | 14 x 17 x 14      | the surveillance dish       |
 *
 * Sizes are measured at build time and written to `airportModelData.json`;
 * nothing here restates them, and the colliders read them from there too.
 *
 * `turn` is radians about +Y in the island's frame. 0 leaves a part's own axes
 * as they are modelled, so a part whose long side is its Z — the terminal, the
 * shed, the freight building, the fire station — needs a quarter turn to lie
 * along the runway.
 */
export interface AirportBuilding {
  /** A mesh name in `airport.glb`. */
  part: string;
  x: number;
  z: number;
  turn: number;
  label: string;
}

const QUARTER = Math.PI / 2;

/**
 * The entrance canopy on the landside forecourt, beside the terminal.
 *
 * `mersin_otogar_kapi.glb` — a bus terminal's gate, 161 m of curved canopy on
 * columns, prepared by `prepare-entry-gate.mjs`. It was tried at Kestrel
 * station first and the strip there is twelve metres deep, which shrank it to
 * 42%; the airport's forecourt is 52, so here it stands at its own size.
 *
 * Every number below is read off `PAVING` rather than typed, so the canopy
 * follows the forecourt if the forecourt ever moves:
 *
 * - its EAST end lands on `terminalGate`'s west edge, which is the main way in
 *   off the outer road — so you drive in at the gate and the canopy starts
 *   there and runs away from you down the front of the terminal;
 * - it is centred across the forecourt's depth, which leaves about eleven
 *   metres of drop-off between it and the road and the same again behind it;
 * - `turn` is 0. The model's long axis is its own X and the island's X runs
 *   along the frontage, so no turn is needed — which happens about once.
 */
export const ENTRY_GATE = {
  model: '/models/entrygate.glb',
  part: 'entryGate',
  /** Width (X), height (Y), depth (Z), metres, as the prepare script measured. */
  size: [161.332, 20.384, 30.096] as [number, number, number],
  turn: 0,
  get x() {
    return PAVING.terminalGate[0] - this.size[0] / 2;
  },
  get z() {
    return (PAVING.forecourt[2] + PAVING.forecourt[3]) / 2;
  },
};

/**
 * The terminal's own skew, and why it needs taking out.
 *
 * The concourse is **not modelled along its own axes**. Its 210 m bounding box
 * is 4% solid (`colliderBoxes`), and the 93 boxes that cover what is actually
 * there fall on a straight line whose gradient is 0.3044 — the building runs at
 * **16.93° across its own box**, which is why it looked bent however it was
 * turned: a quarter turn put the box square with the runway and left the
 * building 17° off it.
 *
 * Fitted rather than eyeballed: a least-squares line through those 93 box
 * centres, `dx/dz = 0.3044`. The perpendicular spread about it is 39.6 m, which
 * is the concourse's width, and the length along it is 213 m.
 *
 * Taking it out is one extra rotation. A part's local `(cx, cz)` maps to
 * `(cx cos T + cz sin T, −cx sin T + cz cos T)` — see `partColliders` — so the
 * concourse lies along the island's X when the Z component of its own direction
 * vanishes, which is at `T = −QUARTER − SKEW`. The other root is 73°, which
 * would turn the building end for end and put its gates over the car park.
 */
const TERMINAL_SKEW = Math.atan(0.3044);

export const BUILDINGS: readonly AirportBuilding[] = [
  // The terminal, lying along the runway with its gates on the apron's north
  // edge — so aircraft park at the building rather than near it. 210 m long by
  // 108 m deep once turned, which is x -90..120, z 62..170.
  //
  // MINUS a quarter, not plus. The concourse is not symmetric across its
  // depth: measured in slices, its -X third is a 9 m single-storey gate pier
  // and the rest is 20-23 m of terminal, so -X is the airside. A rotation of
  // +Q sends local +X to island -Z, which put the frontage on the runway and
  // the gates out over the car park — the building facing backwards.
  //
  // It sits at -5 rather than 15, twenty metres further south, and it moved to
  // let a road past its east end. The way in is now a STRAIGHT run — off the
  // outer road, across the landside road at a crossroads, and on through the
  // fence onto the frontage apron — and that run wants along 110.5..129.5. The
  // terminal ended at 120, which is nine and a half metres inside it. At -5 it
  // ends at 100 and the road has ten metres of verge to it.
  //
  // The turn carries the skew correction: MINUS a quarter minus 16.93°, for
  // the reason set out at `TERMINAL_SKEW`. Straightened, the concourse lies
  // along X in a 213 by 40 m band — which is also tidier across the island than
  // the diagonal was.
  //
  // And it moved 22 m TOWARDS THE AIRCRAFT, from z 94 to 72. At 94 its band
  // ran z 74..114, which put twenty metres of terminal out past the frontage
  // strip (`PAVING.frontage`, z 40..98) and into the landside forecourt, and
  // left its airside face 34 m back from the apron edge — an air bridge's
  // length of empty tarmac between the building and the stands. At 72 the band
  // is z 52..92: the whole building is on the frontage it was built for, it
  // lines up with the tower, the freight shed and the fire station at z 66..72,
  // its gates are twelve metres off the apron, and the forecourt in front of it
  // is clear from end to end.
  { part: 'terminal', x: -5, z: 72, turn: -QUARTER - TERMINAL_SKEW, label: 'terminal' },
  // Everything else is gathered along the north edge of the two aprons, in
  // one 50 m band from z 62 to z 114. Nothing is out on the open island: a
  // building 300 m from the tarmac is not an airport building, it is scenery.
  //
  // The tower, east of the terminal and off the apron's corner: clear of the
  // service gate, which the old one stood squarely on, and with both
  // thresholds in sight down the length of the field.
  // Everything else is one unbroken row along the north edge of the aprons,
  // west to east, nothing more than about 30 m from its neighbour. Spread out
  // with 60 m holes in it, the same eight buildings read as scenery dotted
  // about an island rather than as an airport.
  //
  // The tower, just past the terminal's east end and off the apron's corner:
  // clear of the service gate, which the old one stood squarely on, and with
  // both thresholds in sight down the length of the field.
  { part: 'tower', x: 155, z: 70, turn: 0, label: 'control tower' },
  // Freight, on its own hardstanding at the east end of the row.
  { part: 'freight', x: 205, z: 72, turn: QUARTER, label: 'freight' },
  // The two sheds, doors facing south onto their own apron.
  { part: 'hangar', x: -330, z: 66, turn: 0, label: 'hangar two' },
  { part: 'hangar', x: -265, z: 66, turn: 0, label: 'hangar one' },
  // Maintenance, then fire cover, closing the gap between the sheds and the
  // terminal's west end.
  { part: 'shed', x: -200, z: 66, turn: QUARTER, label: 'maintenance' },
  { part: 'fire', x: -146, z: 70, turn: QUARTER, label: 'fire station' },
  // --- the cargo apron, east ---
  // The same two meshes again rather than two more models: an airport's
  // freight side is a row of identical sheds, so reuse is what it looks like.
  { part: 'freight', x: 300, z: 72, turn: QUARTER, label: 'cargo shed' },
  /*
   * 368, not 390.
   *
   * At 390 the annexe spanned along 360..420 and the cargo road comes down at
   * 400.5..419.5 — so it stood in the road's own width, and a lorry through
   * the gate met a shed end-on where the apron should have opened out. Moved
   * 22 m west it spans 338..398: butted against the cargo shed, which is what
   * a row of freight sheds looks like anyway, and clear of the carriageway.
   *
   * West and not east because there is nowhere east to go — the apron ends at
   * 430 — and not north or south because the apron is where aircraft park.
   */
  { part: 'shed', x: 368, z: 72, turn: QUARTER, label: 'cargo annexe' },
  /*
   * The crane over the container rows: a rail-mounted KB-572, rails included.
   *
   * It replaced a dozen boxes. There was no crane in `source-models` and the
   * city's own port gantries are merged into its building chunks by material
   * and cell — not separable — so this was built out of cuboids until the
   * model arrived. A tower crane has a lattice mast, a slewing ring and a
   * counterjib, and none of those are things a box does.
   *
   * 35 m to the top of the mast, a 65 m jib, and 42 m of its own track. Left
   * at the size it arrives at: those are the real machine's figures.
   *
   * Standing east of the container rows with the jib reaching back over them,
   * which is where every number comes from:
   *
   * ```
   *   along 418.1..427.9   6.1 m clear of the east row, which ends at 412
   *                        2.1 m clear of the apron's own edge at 430
   *                       54 m clear of the freighter's wingtip at the stand
   *   rails  -42.8..94.8   3.2 m inside the apron at one end and 3.2 m short
   *                        of the cargo road's kerb at the other
   *   jib    -15.5..49.4   over the container rows, and 8.6 m short of the
   *                        annexe at 58
   * ```
   *
   * `turn: 0` leaves the jib on the island's `across`, which is the way the
   * container rows run — a jib square across them would reach over one row
   * and nothing else.
   *
   * **`across 26` is set by the rails, not by the jib.** The track is tiled to
   * 137.5 m in `prepare-airport`, and the apron is 144 m deep, so there is
   * exactly 6.5 m of freedom in where the run can sit. 26 is the middle of it.
   * The crane's own mast sits 9 m back from the part's centre, which is why
   * the jib comes out centred on the containers rather than on 26.
   */
  /*
   * The crane, ten metres west of where it stood.
   *
   * Its gantry rails are 9.8 m apart in `along` and 137.6 m long in `across`,
   * so they run straight through the line the yard road takes. At 423 the
   * east rail was at 427.9 and the crossing's deck starts at 433.6 — 5.7 m,
   * which is a 1 in 7 ramp, and anything longer buried twenty-two metres of
   * gantry rail under tarmac. At 413 the rail ends at 417.9 and the ramp has
   * its full twelve metres with four to spare. The crane is still over the
   * same containers; nothing else about it moved.
   */
  { part: 'crane', x: 413, z: 26, turn: 0, label: 'freight crane' },
  // --- the rail freight terminal, east ---
  // The transit shed, and it is `shed` a third time: 14.7 x 10.9 x 60 m, long
  // and narrow, which is what a goods shed is and why the same mesh already
  // serves as the maintenance shed and the cargo annexe. Standing off the east
  // side of the hardstanding with its 60 m down the yard. See `YARD`.
  { part: 'shed', x: 534, z: 80, turn: 0, label: 'transit shed' },
  /*
   * There is no freight warehouse any more, and that is the point.
   *
   * It was tried at (500, 180), which the up main runs through; at (507, 82),
   * which put it in the middle of the hardstanding; and on the north apron,
   * where 60 m of shed does not fit in ground that tapers to 24. The real
   * problem was never where to stand it: the hardstanding is 46 m wide and
   * was being asked to hold a 60 m shed, two container bays, the transit
   * shed, the offices and a lane wide enough to get a lorry through. One of
   * them had to go, and it is the one the terminal already has a building
   * for — the transit shed does this job.
   */
  /*
   * The terminal offices, at the head of the lorry park.
   *
   * Every yard has one two-storey block with the traffic office, the mess and
   * the weighbridge clerk in it, and it stands where the lorries come in
   * rather than out among the stacks. East of the aisle, with the rest of the
   * buildings: everything along 496 to 514 is kept clear for the route.
   */
  { part: 'admin', x: 533, z: 22, turn: QUARTER, label: 'terminal offices' },
  // --- the general-aviation corner, west of the sheds ---
  //
  // The arched club hangar, on the ground the hangar apron was widened to
  // make. 30.5 m across the door and 25 m deep once turned, so it stands
  // x -415..-385 with its front face on z 43.5 — the same building line as
  // the two big sheds — and 25 m of clear apron between it and hangar two.
  //
  // A QUARTER, and this one matters more than most. `clubHangar` is the only
  // part here with a front: its +X end wall carries the signed facade and its
  // -X end is plain corrugated sheet. A quarter turn about +Y sends local +X
  // to island -Z, which is the apron — so the sign faces the aeroplanes. Zero
  // would point it down the runway at nothing and show the field a blank wall.
  { part: 'clubHangar', x: -400, z: 56, turn: QUARTER, label: 'club hangar' },
  // --- the surveillance dish ---
  //
  // Airside, on the seaward grass beside helipad north and square with it,
  // 25 m off the deck's west edge. It stood landside first, on the grass by
  // the offices; out here with the pad is where it was wanted.
  //
  // The gap is what there is to give: the graded strip reaches to z -212.5
  // and a 17.4 m mast has no business inside it, the coast is 68 m further
  // south, and a pad wants its own room. Level with the pad rather than
  // behind it, so the dish and the deck read as one installation from the air
  // instead of a mast that wandered off across the grass.
  //
  // The quarter turn is a small thing, stated because it is easy to get
  // backwards. Measured by fitting the bowl, the dish stands 18.7 degrees off
  // vertical and leans along the part's own +Z, so the turn swings a lean and
  // not a beam: 0 leans it north across the runway at the field, a quarter
  // leans it east up the runway, and a half would lean it out to sea, which
  // is the one bearing here with nothing under it. A quarter, then.
  //
  // It gets a box round its whole bounding box like every other building,
  // which is generous at the foot: the lattice pedestal is 9.5 m across and
  // the box is 13.5, because the dish overhangs. The 4 m of difference is
  // 12 m up, over grass nothing drives on.
  { part: 'antenna', x: -215, z: -250, turn: QUARTER, label: 'surveillance radar' },
  /**
   * The offices, rehomed to the heliport.
   *
   * This is `admin`, and it used to stand at (150, 116) on the forecourt,
   * where 30 m of it blocked the only line the approach road could take — see
   * the note at the end of this list. It is a good building and the airport
   * wants one; it was only ever in the wrong place.
   *
   * Here it has a job. The seaward strip carries the two helipads and the
   * radar, and its south end had nothing on it at all: the north pad has the
   * radar 45 m to its west, the south pad stood alone in a field. So the
   * offices go beside the south pad and the strip reads as a heliport with
   * something to serve it rather than two decks dropped on the grass.
   *
   * At along 210 its west face is 32 m from the pad's edge, which is lateral
   * clearance for something that lands vertically — and it is the far side of
   * the pad from the radar, so the two tall things on this strip are 425 m
   * apart instead of adjacent. Turn 0 lays its 30 m frontage along the strip,
   * the way the row on the north side is laid.
   */
  { part: 'admin', x: 210, z: -250, turn: 0, label: 'heliport offices' },
  // **Nothing on the forecourt's east end either.** `admin` stood at (150, 116)
  // as `offices`: 30 m wide and **28 m tall**, planted square across the one
  // gap between the terminal's east wall and the car park — which is the only
  // line the approach road can take. Driving in, the first thing you met was
  // the back of an office block and the terminal was behind it. An airport's
  // entrance is the view of its terminal; nothing stands in it. The building
  // itself was not the problem and is still here — it is at the heliport now,
  // where the south pad had nothing beside it.
  //
  // **Nothing behind the car park.** Offices, a car-hire block and a
  // ground-services shed stood out here at across 220 on a slab of their own.
  // They were airport buildings rather than lifted city, which is why they
  // survived the first clear-out — and keeping them meant keeping the slab
  // under them, which put the black field straight back. The island reads
  // better without either: the airport ends at its car park, and what is
  // behind it is the island.
] as const;

/**
 * The aeroplanes standing on the apron.
 *
 * Separate from `BUILDINGS` for one reason: the collider. A building gets a box
 * round its whole bounding box, and a box round an aeroplane is a 59 x 70 m
 * wall across the stand that you cannot see and cannot drive under. These get a
 * box round the FUSELAGE only, so the wings are what they look like — something
 * to drive under.
 *
 * `turn` is radians about +Y, 0 pointing the nose at the terminal. The model
 * arrives nose at +Z and +Z is the landside here, so a jet parked nose-in at a
 * gate needs no rotation at all.
 */
export interface ParkedAircraft {
  part: string;
  x: number;
  z: number;
  turn: number;
  label: string;
  /**
   * Half-extents of this one's fuselage box, when `FUSELAGE` is the wrong
   * aeroplane. The shared figure is an airliner's — 6.8 m across and 9.4 m
   * tall — and the business jet is 15.9 m long and 4.6 m to the top of its
   * fin, so the shared box would be twice as tall as the aeroplane inside it.
   */
  fuselage?: { halfWidth: number; halfHeight: number };
}

export const PARKED: readonly ParkedAircraft[] = [
  // The stands either side of the one the flying 747 uses. It parks at the
  // middle stand — `flightConfig`'s stand fix is along 464, which is this
  // frame's x 44 — so these two leave it free and the apron still looks like
  // an apron when the flying one is away on its circuit.
  //
  // The parked aeroplanes are the Qantas A330, which stands on its own gear —
  // once levelled. It is modelled with its main bogies 0.9 m below its nose
  // wheel, so `prepare-airport` measures the difference and pitches it 1.9
  // degrees nose-down before grounding, or it parks with its nose in the air.
  //
  // Stand 2 (x -112) and stand 4 (x 44) are left free: those are the two the
  // FLYING aeroplanes taxi to. See `flightConfig`'s `SCHEDULE`.
  { part: 'qantas', x: -34, z: 4, turn: 0, label: 'stand 3' },
  { part: 'qantas', x: 102, z: 4, turn: 0, label: 'stand 5' },
  // No A400M parked here any more. It used to stand on the cargo apron; it
  // now FLIES the cargo circuit — lands, runs the runway out past the exit
  // the airliners take, turns off at the far end, taxis to that same stand,
  // waits, is pushed back and takes off again. Its stand is `flightConfig`'s
  // cargo `stand` fix, at along 760 across 130, which is this frame's
  // (340, 10). Leaving a second one parked there would have it taxi into
  // itself. See `SCHEDULE`.
  // The business jet, nose-in on the general-aviation apron with its airstair
  // down — the stair is part of the model, which is why there is one of these
  // and not three. It stands 7.5 m off the club hangar's door, which is where
  // an aeroplane waiting to be put away for the night stands.
  //
  // Nose at +Z like the rest, though it took the other quarter turn to get
  // there: the Phenom is modelled nose at -X. See `prepare-airport`.
  //
  // 1.1 x 1.6 rather than the airliners' 3.4 x 4.7. The real fuselage is
  // 1.75 m across and the cabin roof is 2.8 m off the ground, so this is the
  // tube and its gear, and the wings and the tailplane stay open the way
  // every other aeroplane's here do.
  {
    part: 'jet',
    x: -400,
    z: 28,
    turn: 0,
    label: 'club stand',
    fuselage: { halfWidth: 1.1, halfHeight: 1.6 },
  },
] as const;

/** Half-extents of the box round a parked aeroplane's fuselage, metres. */
export const FUSELAGE = { halfWidth: 3.4, halfHeight: 4.7 } as const;

/**
 * The crossing: the island's road link to the mainland.
 *
 * Halcyon Field was somewhere you sailed to and looked at. It is now somewhere
 * you drive to, at the one place the two coasts come near each other — the
 * mainland's west shore bulges to x -2140 around z -400, and the island's
 * east shore reaches back to meet it. The landing was found by scanning the
 * nav raster for the westernmost drivable pixel on each row rather than
 * picked by eye.
 *
 * The water is 157 m wide on the line the deck takes, and it used to be 205.
 * The difference is `ISLAND.eastward`: the island's east end was grown out
 * under the approach so that the bend onto the outer road happens on the
 * ground instead of on piers. See it there — it is the reason this crossing
 * is the length it is.
 *
 * ## A steel bridge, not a causeway
 *
 * The railway's island is reached by a reclaimed bank with a road on its crown
 * — `IslandBridge` — and this was built that way first. It is wrong here. That
 * crossing is a 130 m hop to a low island where a bank reads as ground; this
 * is 300 m of open water to an airfield, where what belongs is a structure:
 * a three-lane deck on plate girders, carried on twin-column piers standing on
 * the seabed, with a steel parapet either side. The difference is what you see
 * from underneath — a bank has nothing under it.
 *
 * ## Why the deck runs past the shore
 *
 * The island's paving is axis-aligned rectangles in the island's own frame and
 * this crossing is a diagonal in the world's, so a link road between the two
 * could be expressed as neither. The deck runs the last 100 m over the
 * island's crown instead and lands ON the east end of the outer road, which is
 * a joint both sides agree about. Over that stretch it is on the ground and
 * the piers stop.
 */
/**
 * Half the bridge deck, which half the structure is proportioned against.
 *
 * It is the road kit's own carriageway, because the deck has to arrive the
 * width of the road it lands on — and everything that has to clear the
 * carriageway (the arch ribs, the hangers under them, the plate girders) is
 * written below as a fraction of it rather than as a number tuned against
 * the 14 m deck this used to be.
 */
const DECK_HALF = roadModels.parts.straight1.size[2] / 2;

/**
 * The parapet's thickness, hoisted for the same reason.
 *
 * The arch ribs stand on the parapet's centreline, so the one number has to
 * be readable from outside the object literal that holds it. It is repeated
 * as `CROSSING.edgeWidth` below, where the parapet is actually described.
 */
const EDGE_WIDTH = 0.42;

/**
 * Where the cargo road leaves the outer road, in the island's along.
 *
 * It lives here rather than in `roadConfig` because the BRIDGE needs it:
 * everything about the crossing's last two hundred metres is set by the
 * junction it has to arrive at, so the junction cannot be a number the road
 * layout knows and the bridge does not. `roadConfig` imports it back.
 *
 * 410 is set by the amusement park. The park's hedge runs down along 396 and
 * the coaster stands hard against it — its 55 m width is centred on 368, so
 * it reaches 395.6 — which means there is no road south to the freight apron
 * anywhere west of 396. A 19 m junction centred at 410 keeps its west kerb
 * 4.5 m clear of the hedge, and that 4.5 m is the entire margin: this is the
 * only place on the island where the cargo road can leave.
 */
export const CARGO_JUNCTION = 410;

/**
 * Where the airfield is entered from the landside road, in the island's along.
 *
 * The west end of both roads, and the one place three carriageways meet at
 * this end of the island: the link north to the outer road, the landside road
 * east along the terminal, and the gate road south onto the frontage apron.
 * `roadConfig` puts a T here and `PERIMETER` puts its gap here, both off this
 * number, because a wall and a road that are written down separately drift —
 * and had: a 16 m gap centred on -385 against a 19 m carriageway centred on
 * -395 left eleven metres of wall standing across the road.
 */
export const AIRPORT_GATE = -395;

/** The junction's east edge — where the bridge deck has to stop. */
export const CARGO_JUNCTION_EAST = CARGO_JUNCTION + roadModels.parts.junctionT.size[0] / 2;

export const CROSSING = {
  /** Both ends, in world XZ: the city's coast road, and the outer road's east end. */
  city: [-2106, -400] as const,
  /**
   * The island end, and it is an AIM POINT rather than a landfall.
   *
   * The deck does not stop here. It runs straight from the city to within a
   * tangent length of here, then swings an arc that finishes tangent to the
   * outer road at `CARGO_JUNCTION_EAST` — so this point is where the two
   * centrelines CROSS, and the deck's own end is short of it by the tangent.
   * `AirportBridge` builds exactly that and nothing here needs to know how
   * long the tangent is.
   *
   * What matters is that it sits ON the outer road's centreline — at along
   * 450, thirty metres out past where the island's east shore used to be.
   * That is the whole fix for a junction that never worked, and how far out
   * it goes is the dial that sets the radius: further east is a longer
   * tangent and a gentler curve, and a gentler curve wants more island under
   * it. See `ISLAND.eastward` for the table the two were settled from.
   *
   * It used to be local (421, 258) — the shoreline, a metre short of the
   * road's end. Aiming there made the two centrelines cross at along 421.6,
   * and a 60 m radius then backed the deck's end 31 m WEST of the crossing,
   * to along 390.9. The junction is at 400.5 to 419.5. So the deck finished
   * ten metres past the junction's far side, having run over the whole tile
   * on the way: the crossings, the kerbs and the cargo road's mouth were all
   * underneath a bridge deck, and what you drove at was a curve that ended
   * in grass beside the intersection rather than in it.
   *
   * Moving the aim point out to 470 moves the crossing of the two lines out
   * with it, and the tangent then lands the deck exactly on the junction's
   * east edge. The cost is a slightly more oblique approach — 65.3° of
   * deflection rather than 54.5 — and the gain is that the whole curve now
   * happens OVER THE WATER, where a bridge's curve belongs, and the deck
   * arrives at the junction dead straight and square.
   */
  island: [-2319.59, -353.36] as const,
  /**
   * How far past each end the deck runs, and it is zero because both ends
   * were overlapping something they should not.
   *
   * Probing the nav raster straight down the crossing's line settles what is
   * actually there. Measured along the deck from the anchor: −24 to −16 m is
   * carriageway, −14 to −10 is footpath, −8 to −2 is carriageway again, 0 to 2
   * is the seaward footpath, and by 4 the ground has fallen to −0.26 on its
   * way to the beach. The anchor is on the footpath already — so an overlap of
   * 10 put the deck's first ten metres flat across a live traffic lane. The
   * bridge starts at the footpath, where it should, and a car reaches it the
   * way it reaches any seafront: over the kerb.
   */
  overlap: 0,
  /** Deck height at the island end: its crown. The city end is read from the map. */
  islandY: SITE.ground,
  /**
   * How high the deck's crest stands over the water, and it is not about the
   * water any more.
   *
   * It began as 6 m, which is what makes a crossing a bridge you can see under
   * rather than a road laid on the sea. It is now set by the island railway,
   * which runs under the arch: the crest has to clear the railhead by enough
   * for a train and the overhead line above it, and the railway stands on
   * `SITE.ground`. So this number is the crown plus the track's build-up plus
   * that clearance plus the deck's own structural depth, expressed — because
   * `AirportBridge` caps the climb against it — as a height over the sea.
   *
   * It moves with `SITE.ground`, one for one. When the crown dropped from 3.4
   * to 0 this came down from 17.0 by the same 3.4, which is the whole reason
   * the crown was dropped: the clearance under the arch is unchanged and the
   * city approach has 3.4 m less to climb.
   */
  freeboard: 13.6,
  /* ---------------------------------------------------------- the deck ---- */
  /**
   * Half the deck, and it is the KIT's road now rather than a number.
   *
   * The island's roads are laid from `modular_roads_pack` and are 18.96 m
   * across. The deck was 14, so the bridge arrived five metres narrower than
   * the road it lands on — the same failure the taper below exists to
   * prevent, in the other direction. Read off the model so the two cannot
   * drift apart again.
   */
  halfWidth: DECK_HALF,
  /** Structural depth of the slab under the running surface. */
  deck: 0.75,
  /** The painted lines between lanes: width, dash and gap. */
  lineWidth: 0.22,
  dash: 5,
  dashGap: 7,
  /* -------------------------------------------------------- the steel ---- */
  /** Two plate girders under the deck: how far out, how deep, how thick. */
  /** Scaled with the deck: 4.6 was right for a 14 m one, and it is 19 now. */
  girderOffset: DECK_HALF * (4.6 / 7),
  girderDepth: 1.9,
  girderWidth: 0.5,
  /** Cross beams between them, and how often. */
  crossDepth: 1.1,
  crossWidth: 0.4,
  crossEvery: 12,
  /**
   * Where the piers stand, named rather than spaced.
   *
   * A tied arch has two supports and no more. The arch carries its own span
   * and hands two vertical reactions down at its springings; a pier in the
   * middle of it would be a column holding up something already holding
   * itself up, which is the giveaway that a model was drawn rather than
   * understood. These two are the arch's feet. What is either side of them is
   * short approach and needs nothing.
   */
  piers: [28, 175] as const,
  /**
   * The pier under all that, which the same widening had quietly broken.
   *
   * A column stands under a girder and a cap reaches past both, and those two
   * relationships are the pier. With the girders scaled out to 6.23 and these
   * three left at their 14 m values, the columns stood 1.6 m inboard of the
   * girders they carry and the cap — half-width 6 — ended INSIDE the girders
   * at 6.48, so the deck's main beams overhung their own support. Writing
   * them against the girder keeps the pier a pier at any deck width.
   */
  columnHalf: DECK_HALF * (0.85 / 7),
  columnSpread: DECK_HALF * (4.6 / 7),
  capDepth: 1.2,
  capHalf: DECK_HALF * (6 / 7),
  /**
   * The parapet, and it is an edge beam rather than a railing.
   *
   * It was a 1.15 m post-and-rail fence — a post every three metres and a rail
   * across their tops — and from inside a car that is a picket fence sliding
   * past at eye height on both sides for three hundred metres, chopping the
   * view into slices. So it came off, and 42 cm of kerb went in instead, which
   * solved the flicker and created a worse problem: a bridge seven metres over
   * open water with nothing at its edge does not read as a bridge at all, and
   * it will not hold a vehicle on the deck.
   *
   * What was wrong was never the height. It was the *repetition*. A solid
   * parapet wall at a proper 1.05 m, with a steel capping band along the top,
   * is a continuous edge: it has a boundary you can see and be held by, and
   * nothing in it ticks past the window. You look over it, not through it.
   */
  edgeHeight: 1.05,
  edgeWidth: EDGE_WIDTH,
  /** The capping band along the parapet's top, and how far it oversails. */
  capHeight: 0.15,
  capOver: 0.06,
  /**
   * Where the parapet starts and stops, and it stops short of both ends. A
   * parapet is a thing you have where there is a drop: run it to the abutment
   * and it is a wall laid across the junction, and run it over the island
   * approach — which is at grade on grass — it is a wall along a road that has
   * nowhere to fall off. 6 m clears the city footpath, and the far end is a
   * few metres past `landfall` — which moved in with the shore, so this moved
   * with it. Everything beyond is the bend, and the bend is on grass.
   */
  edgeFrom: 6,
  edgeTo: 188,
  /**
   * The tied arch, which is what this crossing is.
   *
   * A tied arch carries its deck from an arch above it rather than on girders
   * below it, and the thing that makes it *tied* is that the deck is the
   * bowstring: the arch's outward thrust at the springings is taken by the
   * deck in tension instead of by the foundations. That is why it can stand on
   * two slender piers in the sea rather than on the pair of massive thrust
   * blocks a true arch needs, and it is why the plate girders under the deck
   * matter structurally here — they are the tie.
   *
   * It springs from the two piers, so the arch's span is the main span, which
   * is the whole point and not a coincidence — and the piers have moved out to
   * the two waterlines so that the arch clears the channel in ONE span. 147 m
   * of the 243 is arch, and every metre of open water is under it. An arch
   * sitting well inside the water it crosses is an arch that has been placed
   * on a bridge; this one is the bridge.
   *
   * It is 147 m and not 168 because the channel is 184 m and not 205 — the
   * island was grown out to take the bend (`ISLAND.eastward`), which shortened
   * the water, which shortened the arch. The relationship is the point: the
   * arch is sized by the crossing rather than the crossing by the arch.
   *
   * The springings are at different deck heights — 0.4 m at the city side,
   * 3.4 m at the island — because the deck is still climbing where the arch
   * starts. The rise is measured off the chord between them rather than off
   * one end, which is what keeps the rib above the deck for the whole span
   * instead of diving under it at the high end.
   *
   * `rise` is the crown above the deck. A fifth of the span is the usual
   * proportion, and 29 over 147 is almost exactly that — shallower and it reads as a
   * hump, steeper and it reads as a McDonald's sign. It was 34 over a 168 m
   * span, which is the same fifth, and it came down with the span rather than
   * being left behind to tower over a shorter arch.
   *
   * The ribs lean IN over the crown (`ribLean`), which is what a real pair of
   * arch ribs does: the two are braced against each other, and bringing their
   * tops together shortens the bracing and stiffens the pair sideways. It is
   * also the detail that most makes a bowstring look like one rather than like
   * two separate arches that happen to be parallel.
   */
  arch: {
    from: 28,
    to: 175,
    rise: 29,
    /**
     * Each rib's offset from the centreline at the springing, and how far the
     * pair lean in by the crown.
     *
     * `ribOffset` is the parapet's centreline, DERIVED — and that it is
     * derived is the whole fix. It used to be the literal 6.78, which was the
     * parapet's centreline back when the deck was 14 m across. Widening the
     * deck to the road's 18.96 moved the parapet out to 9.06 and left the
     * arch where it was, so both ribs — and every hanger hanging off them —
     * came down 1.7 m INSIDE a carriageway that now reaches 9.06. That is a
     * line of steel posts standing in the nearside lane of each direction,
     * and it is what "the steel structure is over the road" was.
     *
     * The rule it has always been obeying is that the ribs and their hangers
     * stand OUTSIDE the carriageway. There is exactly one place on this deck
     * that satisfies it, the 0.42 m of parapet at each edge, and the middle
     * of that is where a real bowstring's hangers come down. Written as
     * `DECK_HALF - EDGE_WIDTH / 2` it cannot fall behind the deck again: at
     * 14 m it reproduces 6.79, and it tracks any future width on its own.
     *
     * The margin is thin enough to be worth stating. A 0.22 m hanger on that
     * centreline reaches 8.85, and the carriageway ends at 9.06 — 21 cm of
     * clearance, all of it over concrete that was never driveable. An earlier
     * attempt at 6.35 on the old deck left 6 cm the wrong way: a steel post in
     * the lane, thin enough to miss in a screenshot and solid enough to find
     * at 60 km/h.
     *
     * `ribLean` stays a fraction of the deck. It is proportion rather than
     * clearance — how far the pair close up by the crown — so it has no edge
     * to be pinned to and simply scales.
     */
    ribOffset: DECK_HALF - EDGE_WIDTH / 2,
    ribLean: DECK_HALF * (2.6 / 7),
    ribWidth: 0.82,
    ribDepth: 1.95,
    /** How finely the curve is faceted. 56 is smooth at any distance you see it. */
    segments: 56,
    /** Hangers: spacing, thickness, and the shortest one worth drawing. */
    hangerEvery: 9,
    hangerHalf: 0.11,
    hangerMin: 3,
    /** Cross bracing between the ribs: the braced portion, and its members. */
    braceFrom: 0.17,
    braceTo: 0.83,
    braceBays: 7,
    braceHalf: 0.27,
    /** The knee braces that stiffen each springing against the deck. */
    kneeRun: 13,
    kneeHalf: 0.34,
  },
  /**
   * How far BELOW the ground the very ends sit, and the sign is the point.
   *
   * Flush would leave the deck's running surface coplanar with the street's,
   * and two coplanar surfaces meeting under a wheel is a lip you can catch on.
   * Sunk, the street wins at the joint and the bridge comes out from under it.
   * `IslandBridge` sinks its ends 4 cm for the same reason.
   */
  endSink: 0.06,
  /**
   * How far ABOVE the island the island end sits — the opposite sign to
   * `endSink`, and deliberately.
   *
   * Sinking works at the city end because the street is drawn there and should
   * win the joint. Over the island the deck crosses open grass, and a deck
   * sunk into grass is a deck you cannot see and cannot drive on. Proud by
   * 5 cm it is the surface you are on, it still is not coplanar with anything,
   * and the drop back onto the outer road at the far end is a kerb's worth.
   */
  endLift: 0.05,
  /**
   * How far the deck stays AT STREET LEVEL before it starts to climb, and the
   * reason the bridge no longer lies across the coast road.
   *
   * The climb used to begin at the anchor, so by the time the deck had crossed
   * the carriageway it was half a metre up and by the end of the promenade it
   * was over a metre — a slab on legs laid diagonally across a street that was
   * supposed to feed it, with its own edge walls running out over the traffic.
   * A ramp that starts before the road it joins is a flyover, and nobody asked
   * for a flyover.
   *
   * The sea wall sits at x −2110..−2123, which is 5 to 21 m along, so 24 m of
   * level approach carries the deck over the carriageway and the promenade
   * before a single centimetre of rise. It is at grade the whole way, which
   * means it is buried in the ground it is crossing and what you drive on
   * there is the street itself. The bridge begins where the land stops, which
   * is where a bridge begins.
   */
  landing: 24,
  /**
   * Where the deck makes landfall, measured along the crossing — and it is a
   * position, not a distance back from the end.
   *
   * It used to be `islandLanding`, the length of level deck at the far end,
   * which was the same thing while the centreline was a straight line of known
   * length. The moment the island end grew a curve the run got longer and the
   * level stretch grew backwards with it, pushing the end of the climb out to
   * sea. A shore does not move because a bridge changed shape at the other
   * end of it. It is where the deck crosses the island's outline, measured —
   * 197 while the east shore was where it was, 184 now that `ISLAND.eastward`
   * has brought the shore out to meet the bend — and from there to the end it
   * is flat at island height.
   */
  landfall: 184,
  /**
   * The curve that takes the deck onto the island's outer road.
   *
   * It arrived at 40° to that road and simply stopped, which meant driving off
   * the bridge was a stop and a turn rather than a road going somewhere. A
   * crossing that ends in a kink is a crossing nobody uses twice.
   *
   * So the centreline is no longer a straight line: it runs straight to the
   * tangent point and then swings through a 60 m circular arc that leaves it
   * pointing exactly down the outer road, ON that road's centreline. The two
   * are tangent at the joint, which is what "smooth" means when you can
   * measure it — the heading matches to four decimal places rather than
   * nearly. 60 m is a 47 km/h curve, right for a junction approach and tight
   * enough to keep the arc off the block behind the road.
   *
   * The deck also TAPERS through it, to whatever the outer road happens to be,
   * because a deck landing on a narrower road either spills over its edges or
   * stops dead at them. Narrowing over the approach means the bridge arrives
   * exactly the width of the thing it is joining, and the few metres it is
   * still wider through the curve read as a junction mouth, which is what a
   * junction mouth is.
   */
  curve: {
    /**
     * The radius is SOLVED, not set, so there is nothing here to set.
     *
     * A tangent-arc has three degrees of freedom and this one has no spare
     * ones: the deck's line is fixed at both ends, the outer road's line is
     * fixed, and the deck has to finish exactly on the junction's east edge.
     * That determines the tangent length, and the tangent length determines
     * the radius. `AirportBridge` divides one by the other.
     *
     * Writing a radius here instead is what broke the junction. 60 was a
     * number that looked like a reasonable curve, and the arc it produced
     * finished 31 m short of where the road needed it — which nothing checked,
     * because the construction is happy to land the deck anywhere on the road
     * line and only the eye knows the junction is somewhere else. The solved
     * radius comes out near 52 m on the present alignment, and it moves on its
     * own if the junction or either end ever moves again.
     */
    /** Where the narrowing starts, before the arc. */
    taperRun: 28,
    /**
     * The half-width it ends at: the outer road's, MEASURED rather than
     * restated.
     *
     * This was 4.5 — half of the 9 m two-lane road that used to be there —
     * and when the road went to four lanes the deck went on arriving 5 m
     * narrower than the thing it lands on, which is exactly the failure the
     * paragraph above is about. `AirportBridge` already reads the road's
     * centreline off `PAVING.outerRoad` for this reason and says so; the
     * width had simply been written down twice. Now it is not, and the deck
     * lands flush at any road width.
     *
     * Both ends now read the same kit part, so this comes out equal to
     * `halfWidth` and there is no taper at all: the deck runs full width onto
     * the road. The machinery stays because narrowing the road again should
     * bring it back.
     */
    roadHalf: DECK_HALF,
  },
  /** The steepest the road may be, and how finely it is sampled. */
  maxGrade: 0.115,
  /**
   * How steeply the ISLAND approach may fall, and it is not the city's.
   *
   * The deck has to be at its crest where the railway passes beneath it and on
   * the cargo junction at the end, and there are 94 m between the two — the
   * junction is pinned by the amusement park (see `CARGO_JUNCTION`) and the
   * crest by the railway, so the run is what it is and 10.6% is what fits in
   * it. The city end climbs at its own rate over its own distance.
   *
   * Dropping `SITE.ground` does not touch this. The crest and the island end
   * of the deck fall together, so the difference between them is unchanged;
   * that lowering buys the city side and only the city side.
   */
  islandGrade: 0.106,
  step: 4,
  colours: {
    deck: '#8d9299',
    road: '#3b3d40',
    line: '#e9e6dc',
    steel: '#5d6a74',
    pier: '#9a9791',
  },
} as const;

/**
 * The bit of the city the bridge knocks down.
 *
 * The waterfront here carries a sea wall: `col_Blocks_-6_-3` stands from the
 * pavement to 0.93 m along x -2123 to -2110, which is exactly where the deck
 * leaves the street. A wall is a `col_` chunk and therefore solid, so what you
 * met driving west was a kerb you could not climb with the bridge visible
 * beyond it — the crossing existed and could not be got onto.
 *
 * `IslandBridge` has the same problem on its own street and solves it the same
 * way: take the wall out, of the mesh AND the collider, which is what a highway
 * authority would do rather than ramp a road over its own parapet. The shape is
 * `stationConfig`'s `TerrainCut` and `CityMap` applies both lists.
 *
 * The box is wider than the 14 m deck because the crossing meets the coast at
 * an angle — a diagonal deck through an axis-aligned box needs the box to be
 * as wide as the deck's shadow on each axis, not as wide as the deck.
 *
 * `overlap` matters: the wall is tiled in triangles far coarser than this box,
 * so a centroid test leaves its coping lying across the new road. The y band
 * does the discriminating instead, which is why the cut starts above the
 * pavement the wall stands on rather than at the ground.
 */
export const CROSSING_CUTS = [
  {
    x: [-2128, -2104] as const,
    y: [0.35, 4] as const,
    z: [-418, -392] as const,
    only: 'Blocks',
    overlap: true,
  },
] as const;

/**
 * Two elevated helipads on the grass south of the runway.
 *
 * Elevated and grated, which is what a made pad on reclaimed ground is: a
 * steel deck on legs with an open grille, rather than a concrete circle
 * poured on the land. The grille is the point of it — a solid deck at this
 * size is a grey square, and the thing that says "structure" is being able to
 * see the grass through it.
 *
 * Placed outside the runway strip (70 m either side of the paving) and clear
 * of the approach, so they are beside the airfield rather than on it.
 */
export const HELIPAD = {
  /** Half-width of the square deck, metres. */
  half: 13,
  /** Top of the deck above the island crown. */
  height: 6.5,
  /** Depth of the deck structure below its top face. */
  deck: 0.8,
  /** The grille: bar width and the gap between bars. */
  slat: 0.34,
  gap: 1.15,
  /** The legs. */
  legWidth: 1.2,
  /** The painted H, and the safety rim round the edge. */
  markWidth: 1.5,
  rimDepth: 1.1,
  colours: {
    rim: '#f2a01e',
    frame: '#46525c',
    grille: '#59656e',
    mark: '#eef2f2',
    light: '#37ff6a',
  },
} as const;

/**
 * The airfield boundary: a concrete perimeter wall.
 *
 * An airport is a place you cannot walk into, and until now this one had no
 * edge at all — the grass simply ran from the runway to the sea. This is the
 * line between airside and everywhere else.
 *
 * ## Where it runs, and why it is derived rather than drawn
 *
 * Seaward it is `OUTLINE` pulled `inset` metres in along the ray from the
 * island's centre. That works, and only works, because the outline is
 * star-shaped about the centre — the same property the crown's triangle fan
 * and the sea wall's extrusion depend on. Pulling in along the ray therefore
 * cannot fold the shape over itself, and the wall follows every bend of the
 * coast for free rather than being traced and re-traced whenever the island
 * changes shape.
 *
 * Landside it is a straight run at `landsideAt`, which is 99: one metre north
 * of where the frontage and the cargo apron stop. That number is what keeps
 * the whole thing honest — checked, it leaves the runway, both helipads and
 * the radar inside, the car park, the hotel strip and the outer road outside,
 * and it does not cut a single one of the five service loops in half.
 *
 * ## Gates
 *
 * Three, because the wall has to be crossed three times and no more. The
 * hangar gate is on `PAVING.hangarGate`, which was built as a gate and had
 * nothing to be a gate in. The main gate is where the straight entry crosses,
 * and it is the only one of the three a car arrives at on purpose. The third
 * is not a gate at all: the terminal STANDS on the line, and a building on a
 * boundary is the boundary.
 *
 * There was a fourth, an "airside gate" at along 140 sitting east of the
 * terminal forecourt in open apron. The forecourt has since come back to its
 * building and the main gate has opened twenty metres west of it, and the two
 * gaps overlapped — 109..131 against 127..153, which is not two gates, it is
 * one forty-four metre hole with a pier in the middle of it. The one that
 * has a road through it stayed.
 *
 * Each gate is a gap with a pier either side — a wall that simply stops looks
 * broken, and a wall with two posts and a gap looks like a way in.
 */
export const PERIMETER = {
  /** How far inside the shore the seaward run sits. */
  inset: 20,
  /** The landside line: one metre clear of the frontage and the cargo apron. */
  landsideAt: 99,
  /** How finely the landside run is stepped, so gates can be cut out of it. */
  step: 6,
  height: 3.2,
  thickness: 0.55,
  /** The coping along the top, which is what stops it reading as a fence. */
  coping: { over: 0.16, deep: 0.22 },
  pier: { half: 0.75, height: 4, over: 0.12 },
  gates: [
    /*
     * The gap for the gate road, sized off the road rather than guessed.
     *
     * It was 16 m centred on -385, from when the way in was a 9 m slab. The
     * carriageway runs -404 to -386 now, so eleven metres of wall stood
     * across it. 11 either side of `AIRPORT_GATE` clears the 18.96 m road
     * with 1.5 m of verge.
     */
    { at: AIRPORT_GATE, half: 11, label: 'hangar gate' },
    { at: 5, half: 9, label: 'terminal' },
    /*
     * The main gate, where the straight entry crosses the fence.
     *
     * It is the one opening a car actually drives through: the way in runs
     * from the outer road to here without a turn in it. Half the carriageway
     * plus a metre and a half, so the wall stops clear of the kerb rather than
     * against it.
     */
    { at: ENTRY_ALONG, half: ROAD_HALF + 1.5, label: 'main gate' },
    /*
     * The freight side's gate, on the cargo road.
     *
     * The road was already there — `roadConfig`'s `cargo road` run comes off
     * the outer road at `CARGO_JUNCTION` and goes south to the apron's north
     * edge — and it arrived at an unbroken wall. Between the airside gate at
     * 140 and the island's east end there was no way through at all, so the
     * freighter on the cargo stand was something you could see and not reach.
     *
     * Sized off the kit rather than written down: the modular straight is
     * 18.96 m wide, so half of that and a metre and a half either side puts
     * the piers clear of the kerbs. Re-lay the road in a different piece and
     * the gate follows it instead of going stale.
     */
    {
      at: CARGO_JUNCTION,
      half: roadModels.parts.straight1.size[2] / 2 + 1.5,
      label: 'cargo gate',
    },
    /*
     * The freight terminal's frontage, and it is ONE opening rather than two.
     *
     * Two things cross the landside line here: the five freight roads,
     * spanning 434 to 491 with their ballast shoulders, and the container
     * hardstanding, which runs 496 to 546 and is the way every lorry reaches
     * the stacks. Cut as separate gates they leave a five-metre stub of wall
     * between them, which is not a pier — it is a mistake you can see from
     * the air.
     *
     * So the wall stands back for the whole terminal instead, 420 to 544, and
     * the boundary is carried round the north and east of the yard by
     * `PERIMETER.spur` — the same masonry, because the terminal is part of
     * this airfield and fencing it in something else said it was not.
     */
    { at: 482, half: 62, label: 'freight terminal gate' },
  ],
  /**
   * The spur round the freight terminal, in the same masonry as the rest.
   *
   * A palisade fence was drawn here first and taken down again. The terminal
   * is part of this airfield — it is reached across the cargo apron and it is
   * inside the same gate — so it is closed by the same 3.2 m rendered wall
   * with the same coping, and a second kind of boundary beside the first only
   * ever said the two halves were different places.
   *
   * ## Where it runs, and what it deliberately leaves out
   *
   * North up the cargo road's east kerb at `along` 420 to `across` 152, east
   * along that line — broken for the rail gate at 455..485 — to the square
   * corner at (545, 152), and then down the sea bank and all the way round
   * the container end — east face, tip and south face — until it meets the
   * seaward ring again at (476, −171).
   *
   * ## It went the wrong way twice, and this is the correction
   *
   * First it was pushed north to 247 — toward the bridge — on a misreading of
   * which way "north" pointed. It points along `+along`: the island's frame
   * is rotated 72.8 degrees, so `+along` is world −Z and the container yard
   * at 496–542 is the island's NORTHERN end. The bridge corner is a different
   * direction, and it is now open ground rather than a walled-in pocket:
   * nothing goes past `across` 152, and the nearest masonry to the road
   * bridge is 107 m away.
   *
   * Then, coming back off the bridge, the corner itself was fudged — three
   * vertices smearing a 79° turn over eighty metres along a diagonal that was
   * neither the coast nor the yard, and a chamfer after that. See the run
   * below for the right angle that replaced them.
   *
   * ## Where the ground actually was
   *
   * Two places, and neither needed the bridge corner:
   *
   * - **A wedge the spur was cutting off.** It used to run (534, 178) →
   *   (543.9, 150) → (543.9, 99), chording across the corner and handing the
   *   tip back to the ring. It now follows the coast the whole way.
   * - **The ring's own 20 m setback.** That is the airfield's standard and it
   *   stays the airfield's standard everywhere else; round the container end
   *   it was twenty metres of grass between the yard and the sea. `replaces`
   *   below is how the spur takes that stretch over at twelve.
      */
  spur: {
    runs: [
      /*
       * The north face, in two pieces with the rail gate between them.
       *
       * It used to go north to 200, poke out to (497, 240) — nineteen metres
       * from the road bridge's own abutment — and wall that corner in on
       * three sides, when it is the only way onto the island from the city.
       * The face now stops at `across` 152 and the whole bridge side is open
       * ground: the nearest masonry to the bridge is 107 m away.
       *
       * 152 is where it has to be. Four metres clear of the silo road's head
       * at 148, seven clear of the railheads at 145, and the yard needs all
       * of that: it is the strip a shunter stands in.
       *
       * Dead straight, too. It drifted 420→152 to 505→148 for no reason
       * anyone could give — four metres of slope over eighty-five, which is
       * not a wall following anything, it is a wall that was drawn twice.
       */
      [[420, 99], [420, 152], [455, 152]],
      /*
       * East of the gate, and then the corner — ONE corner, square.
       *
       * What was here first was three vertices — (505, 148), (520, 138),
       * (548, 128) — cutting a diagonal across the corner and then picking
       * the coast back up at (557, 64). That diagonal was not the coast and
       * was not the yard either: it softened a turn by smearing it over
       * eighty metres, and from the air it read as a wall that had sagged.
       * It was chamfered next, which was tidier and still not a corner.
       *
       * It is a right angle now, at (545, 152), and the 90° is exact.
       *
       * ## Why the corner sits at along 545, six metres off the water
       *
       * The two faces do not naturally make a right angle. The north face is
       * at constant `across` 152; the shore runs about 10.6° off the `across`
       * axis — (540.3, 150) to (557.1, 60) — so a wall that hugs the shore
       * meets the north face at 79.4°, not 90. Something has to give, and the
       * only question is what.
       *
       * The yard decides it. `YARD.hardstanding` is a rectangle, 496 to 542
       * and 12 to 152, and its own north-east corner is already 9.7 m from
       * the water. A square corner three metres outboard of that — the wall's
       * own standing room — is at (545, 152), 6.9 m off. That is a sea wall,
       * which is what a container yard built out to the water has, and it is
       * the tightest point on the whole boundary by some way.
       *
       * Everything else was worse. Squaring it at the 12 m line instead puts
       * the corner at (540, 152), and a face running due south from there
       * leaves the hardstanding's last two metres OUTSIDE its own wall.
       * Rotating the north face to meet the shore square drops it to `across`
       * 130 at the cargo road, straight through the railheads at 145.
       *
       * ## And then it rejoins the shore
       *
       * Twenty-four metres due south, to (545, 128), which is where the 12 m
       * line catches the wall up. From there it is the shore at twelve,
       * vertex and chord alike, with nothing bending more than 15° until the
       * tip — see `replaces` below for why twelve and not the ring's twenty.
       */
      [[485, 152], [545, 152], [545, 128], [551.5, 103], [555.5, 72], [558, 30],
        [558, 0], [552, -47], [538, -93], [516, -136], [484, -173], [476, -171]],
    ] as ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
    /**
     * Where the seaward ring stops, because this spur replaces it.
     *
     * The ring is pulled 20 m inside the shore — `PERIMETER.inset`, and right
     * for an airfield boundary nobody is trying to get the last metre out of.
     * Round the container end it costs the terminal a 20 m strip it could be
     * using, so past `along` 490 the ring is not drawn and the spur takes
     * over at 12 m instead. Every vertex and every chord of it is between 9.9
     * and 12 m from the water, measured perpendicular rather than radially,
     * which is the difference between standing on the crown and standing on
     * the beach.
     *
     * `perimeterRuns` breaks the ring here exactly the way it breaks it at a
     * gate, and the spur's last point is the ring's last kept vertex, so the
     * two meet rather than nearly meeting.
     */
    replaces: 490,
    /**
     * The mains' gate: a pier each side of the two roads that go north.
     *
     * The wall is left open here because a railway is going to come through
     * it. The two mains stop at `across` 145, inside the wall, and the line
     * that reaches them has not been drawn yet — so the gate is sized off the
     * railway rather than off a route: 455 to 485, thirty metres, centred on
     * 470, which is midway between the down main at 464 and the up main at
     * 476. Their ballast shoulders reach 461.1 and 478.9, so each pier stands
     * 6.1 m clear of the nearest ballast — enough for the structure gauge on
     * a curve, which is what a line arriving at an angle will be on.
     *
     * Cut it wider only if the drawn route needs it. Thirty metres is already
     * a double-track dock gate; forty would read as a hole in the wall.
     */
    piers: [[455, 152], [485, 152]] as ReadonlyArray<readonly [number, number]>,
  },
  colours: { wall: '#b4b0a7', coping: '#9a968d', pier: '#8d897f' },
} as const;

/**
 * The wall as runs of polyline, already broken at the gates.
 *
 * One closed ring, cut into pieces. The ring is the inset outline clipped to
 * the landside line and closed along it; the landside part is stepped finely
 * so a gate can be taken out of it without leaving a wall sticking into the
 * gap. A run of one point is dropped — two points make a wall, one makes
 * nothing.
 */
export function perimeterRuns(): Array<Array<readonly [number, number]>> {
  const { inset, landsideAt, step, gates } = PERIMETER;
  const pulled = OUTLINE.map(([x, z]) => {
    const r = Math.hypot(x, z) || 1;
    return [x * (1 - inset / r), z * (1 - inset / r)] as [number, number];
  });
  // Keep the seaward half, and note where it crosses the landside line.
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < pulled.length; i++) {
    const a = pulled[i], b = pulled[(i + 1) % pulled.length];
    if (a[1] <= landsideAt) ring.push(a);
    if ((a[1] <= landsideAt) !== (b[1] <= landsideAt)) {
      const t = (landsideAt - a[1]) / (b[1] - a[1]);
      ring.push([a[0] + (b[0] - a[0]) * t, landsideAt]);
    }
  }
  // Step the landside run, which is the long straight closing the ring.
  const dense: Array<readonly [number, number]> = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    dense.push(a);
    if (a[1] === landsideAt && b[1] === landsideAt) {
      const n = Math.ceil(Math.abs(b[0] - a[0]) / step);
      for (let k = 1; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, landsideAt]);
    }
  }
  const inGate = (a: readonly [number, number], b: readonly [number, number]) => {
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    return mz >= landsideAt - 0.5
      && gates.some((g) => Math.abs(mx - g.at) <= g.half);
  };
  // Past the container end the spur runs closer to the water than the ring
  // does, so the ring stops rather than being drawn inside it — see
  // `PERIMETER.spur.replaces`. Broken the same way a gate breaks it.
  const replaced = (a: readonly [number, number], b: readonly [number, number]) => (
    (a[0] + b[0]) / 2 > PERIMETER.spur.replaces
  );
  const runs: Array<Array<readonly [number, number]>> = [];
  let run: Array<readonly [number, number]> = [];
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i], b = dense[(i + 1) % dense.length];
    if (inGate(a, b) || replaced(a, b)) {
      if (run.length > 1) runs.push([...run, a]);
      run = [];
    } else {
      run.push(a);
    }
  }
  if (run.length > 1) runs.push(run);
  // ...and the freight terminal's spur, which is already broken at its one
  // opening and needs none of the clipping above — see `PERIMETER.spur`.
  for (const spur of PERIMETER.spur.runs) runs.push([...spur]);
  return runs;
}

export const HELIPADS: readonly { x: number; z: number; label: string }[] = [
  { x: -170, z: -250, label: 'helipad north' },
  { x: 150, z: -250, label: 'helipad south' },
];

/**
 * The service roads the ground fleet drives, as closed polylines in the
 * island's frame.
 *
 * They are not written here any more. `scripts/prepare-service-routes.ts`
 * builds the airport's driveable space as a grid — paved, clear of every
 * structure's REAL footprint by five metres, clear of the lines the three
 * aeroplanes taxi down by fourteen — routes each loop through it, smooths it
 * and checks it, and writes `serviceRoutes.json`.
 *
 * ## Why they were not good enough by hand
 *
 * The four rectangles this replaces were drawn against the buildings' bounding
 * boxes, and a bounding box is not a building: the terminal is a 200 m
 * concourse laid diagonally across a 108 x 210 m bound. Measured against the
 * footprints `colliderBoxes.json` now carries, the apron loop ran 1.6 m INSIDE
 * the terminal and the cargo loop ran 1 m from the freighter's lead-in.
 *
 * ## Why the file is dense and not a handful of corners
 *
 * A point every five metres, because the smoothing happens at build time and
 * the game drives what was checked. Splining a dozen control points at runtime
 * looks the same and is not: a spline does not pass through its control
 * points, and twice a control polygon that cleared a building by five metres
 * produced a CURVE that went through it.
 *
 * ## The shape of the place
 *
 * Airside is a tree, not a graph. The band in front of the stands is the only
 * way east to west, and the two aircraft lead-ins cut the apron behind the
 * stands into pockets that do not join up — so the airside loop turns round in
 * the east apron and in the hangar apron, which are the two places with room
 * for a turn rather than a cusp.
 */
export interface ServiceRoute {
  name: string;
  points: ReadonlyArray<readonly [number, number]>;
}

export const SERVICE_ROUTES: readonly ServiceRoute[] = Object.entries(
  serviceRoutes as Record<string, { note: string; points: number[][] }>,
).map(([name, route]) => ({
  name,
  points: route.points.map((p) => [p[0], p[1]] as const),
}));

/**
 * What drives where.
 *
 * `spin` is the half turn some models need: everything out of `airport.glb` is
 * prepared facing +Z, and a yaw of `atan2(dx, dz)` aims +Z along travel, so
 * those need none. The city's own `vehicles.glb` faces -Z — `Traffic` drives
 * them with a velocity of `(-sin h, -cos h)` — so those need a half turn. Get
 * it wrong and the fire engine reverses round the apron all day.
 */
export interface ServiceVehicle {
  /** A mesh in `airport.glb`, or a name in `vehicles.glb` when `city` is set. */
  part: string;
  city?: boolean;
  route: string;
  /** Where it starts, as a fraction of the lap. */
  at: number;
  /** Metres per second. */
  speed: number;
}

export const FLEET: readonly ServiceVehicle[] = [
  // --- the apron: the stands, and the airfield's own services ---
  { part: 'pushback', route: 'apron', at: 0.05, speed: 6.5 },
  { part: 'cart', route: 'apron', at: 0.38, speed: 7.5 },
  { part: 'fire_truck', city: true, route: 'apron', at: 0.62, speed: 9 },
  { part: 'rdservtruck', city: true, route: 'apron', at: 0.83, speed: 8 },
  { part: 'ambulance', city: true, route: 'apron', at: 0.22, speed: 10 },
  { part: 'minivan_body', city: true, route: 'apron', at: 0.49, speed: 9 },
  { part: 'bus', route: 'apron', at: 0.72, speed: 8 },
  // The catering hi-loader, which is the one ground vehicle a stand actually
  // has to have and the apron had none of. Slow, because a loaded one is.
  { part: 'cateringTruck', route: 'apron', at: 0.15, speed: 5.5 },
  { part: 'cateringTruck', route: 'apron', at: 0.91, speed: 6 },
  // --- the hangar apron, which had nobody on it and is the biggest piece of
  //     open concrete on the field ---
  { part: 'cart', route: 'hangar', at: 0.1, speed: 6 },
  { part: 'pushback', route: 'hangar', at: 0.55, speed: 5 },
  { part: 'rdservtruck', city: true, route: 'hangar', at: 0.8, speed: 7 },
  // --- cargo ---
  { part: 'pushback', route: 'cargo', at: 0.2, speed: 5.5 },
  { part: 'cart', route: 'cargo', at: 0.7, speed: 6.5 },
  { part: 'garbage_truck', city: true, route: 'cargo', at: 0.45, speed: 7 },
  { part: 'Pickup_Body', city: true, route: 'cargo', at: 0.9, speed: 9 },
  { part: 'cateringTruck', route: 'cargo', at: 0.32, speed: 5.5 },
  /*
   * --- landside: nothing, and that is the whole of it now ---
   *
   * Seven vehicles ran out here — two buses, a taxi, a city bus, a postvan, a
   * tow truck and an SUV — on the one route that leaves the airfield. They are
   * gone. Everything left in this fleet is INSIDE the fence: the stands, the
   * hangar apron and the freight yard, which is ground service driving on
   * ground service's own roads, and is the only traffic an airfield actually
   * has that a player never gets among.
   *
   * The landside strip is a public road with a fairground on one side of it.
   * What belongs there is the city's own traffic or nothing, and a handful of
   * airport-liveried vans lapping a fixed polyline past the shops was neither.
   *
   * The route went with them. It is generated data, checked at build time
   * against the real footprints, and the ground it was drawn on has moved out
   * from under it — the entrance is at 120 now with no reservation, the
   * forecourt has come back to its building and the car park has shifted west,
   * so it regenerated with fifteen points off tarmac. See the note where it
   * used to be in `prepare-service-routes.ts`.
   */
  // --- and nothing on the back road ---
  // Four city cars used to lap it, on the argument that the block it served
  // should not be a dead end. There is no block any more, and the traffic on
  // this island is meant to be the airport's own: ground handling on the
  // apron, the sheds and the freight yard, and the buses and taxis on the
  // terminal frontage. A police car and a school bus driving a loop round the
  // back of an airfield were the city leaking onto it.
] as const;

/**
 * The island's grass, and it is the mainland's own figure.
 *
 * `#4b6020` is the city's `Auxiliar` material — its verges and, more to the
 * point, its hills, sampled out of the map in `TOWN_PALETTE`'s note. The
 * railway islands use the town's green (`#4a5c2c`), which is the middle of
 * three city greens and half a step cooler; against the big land across the
 * water that read as a different kind of ground.
 */
export const GRASS = '#4b6020';


/**
 * City chunks placed on the airfield, beyond the scattered planting.
 *
 * The brief for this island was to lean on the city, and the city has things
 * an airport wants that the airfield kit does not: shipping containers for a
 * freight yard, service vehicles for an apron, and blocks of ordinary building
 * for the landside strip where the hotel and the car hire go. None of it is
 * new geometry — every one of these is a `deco_` chunk lifted whole, the same
 * trick the island's village and the station's town are built with.
 *
 * | part                    | size (m)        | used as              |
 * | ----------------------- | --------------- | -------------------- |
 * | `deco_container1_-1_0`  | 16 x 3 x 55     | a row of containers  |
 * | `deco_special_vehicles…`| 3 x 4 x 15      | ground service unit  |
 *
 * Both of these are airside kit. The blocks of ordinary building that used to
 * stand on the landside strip are gone — see the end of the list.
 */
export interface AirportDeco {
  part: string;
  x: number;
  z: number;
  turn: number;
  /** Whether a car should bounce off it. Trees and small props do not. */
  solid?: boolean;
}

const CONTAINER_ROW = 'deco_container1_-1_0';
const SERVICE_UNIT = 'deco_special_vehicles_texture_0_-2';

const AIRFIELD_DECO: AirportDeco[] = [
  // The freight yard: rows of containers either side of the cargo stand, and a
  // stack behind them. Kept clear of the stand itself — the first placement
  // put two rows under the parked freighter's wing, which a plan view catches
  // and a walk round does not.
  { part: CONTAINER_ROW, x: 272, z: 20, turn: 0, solid: true },
  { part: CONTAINER_ROW, x: 382, z: 5, turn: 0, solid: true },
  { part: CONTAINER_ROW, x: 396, z: 5, turn: 0, solid: true },
  // No stack at (280, -31) any more. It measured 4.9 m from the freighter's
  // taxi line, which with a 42.4 m span is the wing sixteen metres INSIDE it.
  // It was placed when the A400M was parked scenery and nothing moved through
  // there; the moment the aeroplane started taxiing, the yard had to give way.

  // Ground service units, drawn up at the stands the way they are in life:
  // one at each terminal gate and two on the cargo apron.
  { part: SERVICE_UNIT, x: -76, z: 30, turn: 0 },
  { part: SERVICE_UNIT, x: 2, z: 30, turn: 0 },
  { part: SERVICE_UNIT, x: 80, z: 30, turn: 0 },
  { part: SERVICE_UNIT, x: 292, z: 18, turn: Math.PI / 2 },
  { part: SERVICE_UNIT, x: 292, z: 30, turn: Math.PI / 2 },
  // And a few in the car park, because an empty car park reads as a closed
  // airport however well it is painted.
  { part: SERVICE_UNIT, x: -70, z: 166, turn: Math.PI / 2 },
  { part: SERVICE_UNIT, x: -40, z: 188, turn: Math.PI / 2 },
  { part: SERVICE_UNIT, x: 30, z: 166, turn: Math.PI / 2 },
  { part: SERVICE_UNIT, x: 86, z: 188, turn: Math.PI / 2 },
  // Landside frontage used to be attempted out here and was pulled out again:
  // seven chunks on bare tarmac, which read from the air as a black field with
  // offices on it. The reason it failed is written into `PARADE` below, and so
  // is what changed.
];

/* ------------------------------------------------------- Halcyon Parade ---- */

/**
 * The landside strip, north of the outer road.
 *
 * ## Why there is anything here at all, having taken it away once
 *
 * There were seven chunks of mainland frontage on this ground and they were
 * removed, on the finding that they were "high-street blocks with no street in
 * front of them" standing on bare tarmac. That was right, and the important
 * half of it is the first clause rather than the second. A high street is not
 * a row of buildings; it is a row of buildings ON a street, and at the time
 * the outer road was a painted slab that stopped 300 m short of here.
 *
 * It is not that now. The outer road is laid from the modular kit, the full
 * length of the island, with kerbs, footways, lane markings and crossings in
 * its texture — and both its footways ran past half a kilometre of empty
 * grass. That is a street with nothing on either side of it, which is the
 * same defect from the other direction. So the frontage comes back, and this
 * time it is built against the kerb line rather than floating on a field.
 *
 * ## And the buildings are EXTRACTED, one at a time
 *
 * The first rebuild after that was still wrong, in a way that is worth
 * writing down because the name lies. It used `deco_Building_*` chunks out of
 * the processed `city.glb`, and a chunk is not a building: it is every mesh of
 * one material inside a 250 m cell of the city. `cityChunks.ts` describes
 * `deco_Building_-4_-1` in prose as "a row of shops", and standing in front of
 * it on this island it is a two-storey suburban house with a porch and dormer
 * windows. Three more cells placed alongside it carried pitched-roof housing
 * behind their commercial frontage. You cannot pick one building out of a
 * merged cell after the fact, and a street of houses is not what an airport's
 * landside is.
 *
 * So every part here is picked ONE NODE AT A TIME out of the raw
 * `drive_for_speed_-_map.glb` by `prepare-parade.mjs`, the same targeted
 * picking `prepare-park.mjs` uses for the fairground's rides. Twelve
 * buildings, 8,686 triangles, half a megabyte: a supermarket, a four-unit
 * retail parade, five separate shop units, two hotels, two offices and a
 * depot. Every one is commercial by choice, and every one was searched for
 * among 26,779 nodes rather than hoped for.
 *
 * ## The rule the layout obeys
 *
 * Buildings meet the footway. `FRONT` is the across at which a front wall
 * stands, four and a half metres back from the road's south kerb, and every
 * building in the front rank has its face on it — so the parade reads as a
 * continuous street wall with gaps, not as objects scattered near a road.
 * What is set back is set back deliberately: the car park behind its
 * forecourt, and the depot, the hotel annexe and the office block in the back
 * yards where the service side is.
 *
 * ## The car park is NOT a city chunk, and that was checked
 *
 * The city has no multi-storey car park that can be lifted. Its garage
 * materials are all in the map preprocessor's DRIVABLE set, so every scrap of
 * garage geometry came out on the `col_` side, and the 22 `col_Parking_*`
 * chunks are flat paint at y = 0.2 with no height at all. The one candidate
 * with the right footprint and height, `col_Street_1_0_0` at 62 m square and
 * 30 m tall, was tried in place: it renders as a five-storey red-brick civic
 * building with corner turrets, because a chunk is everything of one material
 * in a 250 m cell and that cell's "Street" material happens to carry a
 * building. It is a handsome thing and it is not a car park.
 *
 * So the car park is built from boxes, which is how the gantry crane, the
 * perimeter wall, the level crossing and the entrance gantry on this island
 * are all built. See `CAR_PARK_DECK`.
 */

/**
 * The multi-storey car park, built rather than borrowed.
 *
 * It closes the east end of the parade, directly behind the airport's own
 * surface car park — so the two are one parking area with a deck over half of
 * it, which is how an airport car park grows in life. It is set back behind
 * its own forecourt (`PAVING.paradeYard`), because that is what the entrance
 * to a car park is: a piece of tarmac you queue on, not a door on a footway.
 * East of it is the fairground's entrance road at along 129 to 185, which is
 * where the parade has to stop.
 *
 * ## Built, and that was checked before building it
 *
 * Neither source has a multi-storey car park that can be lifted. In
 * `city.glb` the garage materials are all in the map preprocessor's DRIVABLE
 * set, so the 22 `col_Parking_*` chunks are flat paint at y = 0.2 with no
 * height; the one chunk with the right footprint and height renders as a
 * five-storey red-brick civic building with corner turrets. In the raw
 * `drive_for_speed_-_map.glb` the only true open-deck garage geometry is
 * SUNKEN — two decks at -8 m and -2.5 m, an undercroft — and the
 * above-ground look-alikes are commercial blocks at 2.2 m floor-to-floor,
 * which is too tight for a car.
 *
 * So it is boxes, which is how the gantry crane, the perimeter wall, the
 * level crossing and the entrance gantry on this island are all built.
 *
 * ## What makes it read as one
 *
 * Four things, and none of them is the shape. A rectangular block 60 x 40 m
 * and 15 m tall is an office. What says CAR PARK from a moving car is:
 *
 *   1. the decks, stacked and visibly SEPARATE, with daylight between them;
 *   2. an upstand band at each deck edge, continuous, at knee height to the
 *      cars behind it — the one detail every deck park in the world has;
 *   3. columns standing in the daylight, on a grid you can count;
 *   4. a stair core running past the top deck, because the stairs have to get
 *      to the roof and then have somewhere to stop.
 *
 * `storey` is 3.1 m, which is the real figure: a deck park is built to the
 * minimum headroom that clears a van and not a centimetre more, and it is why
 * they look squat next to a building of the same height.
 */
export const CAR_PARK_DECK = {
  /**
   * Centre, in the island's frame, and twenty metres west of where it was.
   *
   * It stood at 95, spanning along 65 to 125, and the airport entrance moved
   * to 120 — so it had to give way or be driven through. West is the only
   * room, and the parade is what stops it there: Row A's last unit reached
   * along 63 at across 234..245, which is inside this deck's own 198..238, so
   * the two would have been in each other. That unit went to the parade's west
   * end (see `PARADE_BUILDINGS`), the row finishes at 41 now, and this sits at
   * 45..105 with four metres to the shops and five to the road.
   */
  along: 75,
  across: 218,
  /**
   * Footprint: the long side lies along the road.
   *
   * 60 and not 66, because the fairground's entrance road comes down at along
   * 129 and the deck has to stop clear of it.
   */
  length: 60,
  depth: 40,
  /** Five levels, ground included, at a real deck-park floor-to-floor. */
  decks: 5,
  storey: 3.1,
  /** Deck slab thickness, and the upstand band along each deck's edge. */
  slab: 0.34,
  band: 0.95,
  bandThick: 0.28,
  /** Columns: half-section, and how many bays each way. */
  column: 0.24,
  bays: { length: 8, depth: 4 },
  /** The stair and lift core, at the west end, and how far it runs past the roof. */
  core: { length: 9, depth: 8, over: 3.4 },
  /** The external ramp at the east end: its width and how far it projects. */
  ramp: { width: 7.5, reach: 16 },
  colours: {
    concrete: '#b9b5ac',
    band: '#cfcbc1',
    core: '#9d988e',
    deck: '#6e6a64',
  },
} as const;

/**
 * Halcyon Parade's buildings, and every one is its OWN building.
 *
 * Not a city chunk. A `deco_Building_*` chunk is every mesh of one material
 * inside a 250 m cell of `city.glb`, so what lands on the island is whatever
 * that cell happened to contain — `cityChunks.ts` calls `deco_Building_-4_-1`
 * "a row of shops" and from the pavement it is a two-storey suburban house
 * with a porch and dormer windows. Three more cells that stood here carried
 * pitched-roof housing behind their commercial frontage. You cannot pick one
 * building out of a merged cell after the fact, and a street of houses is not
 * what an airport's landside strip is.
 *
 * So these are EXTRACTED, one node at a time, out of the raw
 * `drive_for_speed_-_map.glb` by `prepare-parade.mjs` — the same targeted
 * picking `prepare-park.mjs` uses for the fairground's rides. Every part is a
 * single commercial building chosen by what it is: a supermarket, a retail
 * parade, four shop units, a hotel and an office. No houses, and nothing that
 * could be hiding one.
 *
 * Sizes are measured at build time into `paradeModelData.json`; nothing here
 * restates them, and the colliders read them from there too.
 */
export interface ParadeBuilding {
  /** A mesh name in `parade.glb`. */
  part: string;
  x: number;
  z: number;
  turn: number;
  label: string;
}

/**
 * The frontage line: four and a half metres back from the road's SOUTH kerb.
 *
 * South, and that is a correction. Which side of the outer road is west is
 * not a matter of opinion: the minimap's own compass has `E = world +x`, the
 * island is turned 1.2708 rad, and `-across` comes out at world (-0.955,
 * -0.296), which is west by 0.955. The parade was built on `+across` first —
 * east — on the strength of the HUD's heading READOUT saying "W" when the
 * camera faced that way. That readout is mirrored and disagrees with the
 * compass rose drawn directly above it: face world +x, which the rose labels
 * E, and the text says W. It is a real bug and it cost this parade a rebuild.
 *
 * West is also the better ground. It is the strip between the outer road and
 * the airport's surface car park: 51 m deep at its narrowest, six hundred
 * metres long, with a made road on BOTH sides — the outer road in front and
 * the landside road behind. A high street wants exactly that, which is what
 * the previous attempt at frontage on this island never had.
 */
const FRONT = 245;

/**
 * Which way each building faces, MEASURED off its own walls.
 *
 * A pick arrives at whatever rotation it had in the city, and nine of these
 * twelve had their backs or their flanks to the road — which is what "the
 * buildings are not aligned" looks like from a car, even with every front
 * wall on the same line. Placing them all at turn 0 lines up a row of blank
 * gable ends.
 *
 * So the front is found rather than guessed. Every wall triangle is binned by
 * which of the four horizontal directions its normal points, and each side is
 * scored by triangles per square metre: a shopfront is glazed, signed and
 * recessed and comes out dense, a back wall is one quad and comes out at
 * almost nothing. The spread is not subtle — `officeSlim` is 0.54 on its -x
 * face against 0.05 on +x, a factor of ten — so the winner is never in doubt.
 *
 * The number here is the turn that brings that face round to +across, which
 * is the road. Three were already right and are 0.
 */
export const FACE_THE_ROAD: Record<string, number> = {
  store: 0,                 // +z, 0.16
  parade: QUARTER,          // -x, 0.44 against 0.24
  shopUnit: 0,              // +z and -z tie at 3.13; either is a front
  retailBox: QUARTER,       // -x, 0.98
  shopTall: QUARTER,        // -x, 1.21 against 0.65
  shopDuo: 0,               // +z, 3.09 against 0.52
  shopFlat: Math.PI,        // -z, 0.51 against 0.22
  hotelTower: Math.PI,      // -z, 0.49 against 0.38
  officeSlim: QUARTER,      // -x, 0.54 against 0.08
  hotel: QUARTER,           // -x, 1.62 against 0.62 — the strongest of the lot
  office: QUARTER,          // -x, 0.34 against 0.27
  depot: Math.PI,           // four near-blank walls; a shed has no front
  shopCorner: -QUARTER,     // +x, 0.90 against 0.23
  shopNarrow: QUARTER,      // -x, 1.45 against 0.36
  shopPair: 0,              // +z, 0.32 against 0.13
  blockTall: Math.PI,       // -z, 0.47 against 0.28
  blockMid: QUARTER,        // -x, 0.65 against 0.37
  officeMid: 0,             // +z, 0.61 against 0.52
  officeSquare: Math.PI,    // -z, 0.36 against 0.34
  cornerBlock: 0,           // +z, 0.55 against 0.36
  hotelBig: -QUARTER,       // +x, 0.48 against 0.42
};

/** A part's own measured size, from the pipeline rather than from memory. */
const paradeSize = (part: string): number[] => {
  const entry = (paradeModels.parts as Record<string, { size: number[] }>)[part];
  if (!entry) throw new Error(`parade.glb has no part "${part}"`);
  return entry.size;
};

/** Its extent along the road, and its depth back from it, at a given turn. */
const paradeSpan = (part: string, turn: number): [number, number] => {
  const size = paradeSize(part);
  const turned = Math.abs(Math.cos(turn)) < 0.5;
  return turned ? [size[2], size[0]] : [size[0], size[2]];
};

/**
 * Lays a terrace from west to east: faces on one line, a fixed gap between.
 *
 * Both numbers that matter are read rather than written down — the turn from
 * `FACE_THE_ROAD`, the extents from the model — so a building that is
 * re-picked at a different size or rotation still lands with its shopfront on
 * the street and its neighbours still clear of it. Adding one to the list
 * shuffles the rest along instead of needing every centre recomputed, which
 * is the whole reason this is a loop and not a table of coordinates.
 */
const terrace = (
  face: number, from: number, gap: number, items: ReadonlyArray<readonly [string, string]>,
): ParadeBuilding[] => {
  const out: ParadeBuilding[] = [];
  let cursor = from;
  for (const [part, label] of items) {
    const turn = FACE_THE_ROAD[part] ?? 0;
    const [along, depth] = paradeSpan(part, turn);
    out.push({ part, x: cursor + along / 2, z: face - depth / 2, turn, label });
    cursor += along + gap;
  }
  return out;
};

/**
 * Where the two long roads are joined, in the island's along.
 *
 * The landside road and the outer road run parallel for 573 m, ninety-three
 * metres apart, and until now they met in exactly two places: the west link at
 * `AIRPORT_GATE`, and the terminal entry at 157. Everything between was a pair
 * of one-way-in dead runs — to get from the back of the terminal to the
 * seafront you drove to one end of the island or the other.
 *
 * Two crossings, not three, and not because three would not have helped. The
 * parade FILLS its frontage: Row A is 298 m of building in 363 m of ground, so
 * every crossing is paid for out of shopfront. Two cost 48 m and are absorbed
 * by moving two units to the west corner (see Row A's `west end` below); three
 * cost 72 and would have meant deleting one. Two links put a junction every
 * 130 to 150 m along a road that had one every 550, which is the whole of what
 * was wrong with it.
 *
 * `roadConfig` reads these to place the junction tiles and the runs between
 * them, and the terraces below are laid in segments AROUND them, so the shops
 * and the roads cannot drift apart. `LINK_CLEAR` is half the kit's carriageway
 * plus two and a half metres of verge — the gap a building keeps from the
 * tarmac, not from the centreline.
 */
export const PARADE_LINKS = [-236, -104] as const;
const LINK_CLEAR = 12;

export const PARADE_BUILDINGS: readonly ParadeBuilding[] = [
  /*
   * ## Row A: the high street, facing the outer road
   *
   * Faces on 245, in four runs broken by the two link roads. It used to be one
   * unbroken terrace of nine from -300 to 54; the links take 48 m out of the
   * middle of that, and rather than lose two units they moved west.
   *
   * ### The west end, -383 to -319
   *
   * The band between the roads west of the parade was empty above across 220,
   * which is the top of the corner block standing in it. Three shallow units
   * fit there with room to spare — the deepest is `shopNarrow` at 13.1 m
   * against 25 m of clearance — and nothing deep would, which is why these
   * three and not the ones they replaced. It reads as the parade's west end
   * rather than as shops in a field, because the outer road runs past their
   * fronts the whole way.
   *
   * `shopNarrow` came out of Row B, which needed the room more, and
   * `officeSlim` came off the east end when the car park deck moved west into
   * where it stood.
   */
  ...terrace(FRONT, -383, 8, [
    ['shopTall', 'two-storey shop'],
    ['shopNarrow', 'narrow shop'],
    ['officeSlim', 'high street offices'],
  ]),
  /*
   * ### -301 to the first link: the supermarket alone
   *
   * It is 52.3 m and the segment is 53, which is the tightest fit on the
   * parade and the reason the run starts at -301 rather than -300: at -300 it
   * finished 30 cm inside the link's verge.
   */
  ...terrace(FRONT, -301, 6, [
    ['store', 'supermarket'],
  ]),
  /*
   * ### Between the links, -224 to -119
   *
   * The hotel anchors the west side of the block where the ground is deepest —
   * it is 49 m back and only here is there room for that — and two small units
   * run out to the second crossing.
   */
  ...terrace(FRONT, PARADE_LINKS[0] + LINK_CLEAR, 6, [
    ['hotelBig', 'seafront hotel'],
    ['retailBox', 'retail box'],
    // The shop with canopy that ended this run has moved to the island
    // station's car park, at the user's word — see `STATION_SHOPS` in
    // `islandRailConfig`. It was last in its run, so nothing else shifted.
  ]),
  /*
   * ### East of the second link, -92 to 41
   *
   * The longest run and the busiest, and it ends hard against the car park's
   * forecourt — which is the same wall it always ended against, twenty-two
   * metres further west. `PAVING.paradeYard` starts at 43 and the deck at 45,
   * because the whole landside strip shifted west when the airport entrance
   * did (see `ENTRY_ALONG`), and `officeSlim` went to the parade's west end to
   * pay for it. Three buildings here rather than four.
   */
  ...terrace(FRONT, PARADE_LINKS[1] + LINK_CLEAR, 6, [
    ['parade', 'retail parade'],
    ['shopDuo', 'shop over shop'],
    ['hotelTower', 'airport hotel'],
  ]),

  /*
   * ## Row B: the back lane, behind Row A
   *
   * Faces on 186, which is below the deepest thing in front of it and 22 m
   * clear of the landside road's kerb. Everything here is shallow by
   * selection — nothing over 19.5 m — because that is all the band allows,
   * and a back lane of small units is what is behind a high street anyway.
   *
   * Two runs now rather than one, broken by the same two links. It ran -300 to
   * -97 and both ends were set: west, the corner block between the two roads
   * reaches along -307; east, the airport's own surface car park starts at
   * along -90 and across 159, so a back lane at 166 would be parked on. Taking
   * 48 m out of the middle of a 210 m band with 143 m of building in it left
   * nothing, so `shopNarrow` went to Row A's west end and the gaps came in
   * from ten metres to eight. Six units at eight is still a back lane.
   *
   * Nothing goes east of the second link: there are two metres between it and
   * the car park.
   */
  ...terrace(186, -301, 9, [
    ['blockTall', 'flats over shops'],
    ['office', 'office block'],
  ]),
  ...terrace(186, PARADE_LINKS[0] + LINK_CLEAR, 8, [
    ['shopCorner', 'corner shop'],
    ['shopFlat', 'corner unit'],
    ['blockMid', 'mid-rise block'],
    ['shopPair', 'pair of units'],
  ]),

  /*
   * ## Row C: the other side of the landside road
   *
   * The band between that road and the airport's own frontage apron is 47 m
   * deep and ran two hundred metres empty. A row here gives the landside road
   * two built sides instead of one, which is the same argument that put the
   * parade on the outer road in the first place.
   *
   * Faces on 140.5, four and a half metres back from the road's south kerb,
   * and the deepest of them reaches 106 against an apron edge at 98.
   *
   * Untouched by the links: they run NORTH off the landside road, and the
   * junction tiles reach across 164 against this row's face at 140.5.
   */
  ...terrace(140.5, -300, 8, [
    ['hotel', 'hotel annexe'],
    ['depot', 'depot'],
    ['officeMid', 'back street offices'],
    ['officeSquare', 'civic block'],
    ['cornerBlock', 'corner block'],
  ]),
];
/**
 * The corner: four blocks of ordinary town at the island's west end.
 *
 * These are the `city.glb` cells that were taken out of the parade, and they
 * are back for what they are rather than for what they were being used as.
 * A merged 250 m cell is the wrong thing to line a high street with, because
 * you cannot choose what is in it and two of these four carry pitched-roof
 * housing behind their commercial frontage. It is the right thing to make a
 * CORNER of: a cell is a piece of town, mixed the way town is mixed, and the
 * one place on this island that wants a piece of town is the far west end,
 * where the outer road turns south and the airfield stops.
 *
 * So the rule is the one their name has: in the corner only. Nothing here is
 * on the parade, nothing is on the frontage line, and the whole cluster sits
 * west of the outer road's own west end at along -400.
 *
 * They fill the band between the airport's frontage apron, which ends at
 * across 98, and the landside road, which starts at 150 — plus the quadrant
 * inside the road's turn. `hangarGate` cuts through that band at along -390
 * to -381 and nothing stands on it.
 */
export const CORNER_BLOCKS: readonly AirportDeco[] = [
  /*
   * In the block between the landside road and the outer road, west of the
   * parade's supermarket. 76 x 50 m in an 86 m band, so it has six metres of
   * verge to the landside road and thirty to the outer one.
   */
  { part: 'deco_Building_1_2', x: -345, z: 195, turn: 0, solid: true },
  /*
   * In the band between the frontage apron and the landside road, turned to
   * put its 52 m side along.
   *
   * That band is 47 m deep and this is 45.6, which is the tightest fit in the
   * cluster and is meant to be: a block that fills the ground between two
   * frontages is what a city block is, and the 70 cm either side is verge
   * rather than a mistake.
   */
  { part: 'deco_Building_-3_2', x: -340, z: 121.5, turn: QUARTER, solid: true },
  /*
   * The 30 m tower, west of the gate junction and south of the landside
   * road's corner, where it marks the end of the island from the runway.
   */
  { part: 'deco_Building_-2_-3', x: -430, z: 121.5, turn: 0, solid: true },
  /*
   * `deco_Buildings_texture_1024_2_-1` is NOT here, and it is the one thing
   * asked for that could not be done.
   *
   * It is 91 x 94 m. The west side of the island has exactly three pieces of
   * ground clear of a carriageway — 47 m between the apron and the landside
   * road, 86 m between the landside road and the outer road, and 61 m of
   * along west of the link — and the largest square that fits in any of them
   * is 86. It was placed at the corner first and it straddled the west link
   * for 85 m of its length, which is what "structures are overlapping the
   * road" was. There is no version of the west side where it fits, so rather
   * than shave it into a road it is left out.
   */
];
/**
 * The ground the parade stands on, as one rectangle.
 *
 * Only the airfield's tree scatter reads it, and only to stay out: the
 * planting is laid in long rows that cross the whole island, and its first
 * landside band sits at across 208 to 222 — which is the middle of these
 * shops. Without this it would put palms through them the same way it used to
 * put them inside the fairground.
 *
 * The verge row at across 165 is deliberately OUTSIDE it. That row runs
 * behind the back rank, between the yards and the landside road, where a line
 * of palms is a tree-lined back street rather than an obstruction. Trees come
 * out where they are in the way and stay where they are not.
 */
export const PARADE_BOUNDS = [-383, 135, 172, 252] as const;

/* --------------------------------------------------------------- the sidings */

/**
 * Freight sidings on the grass east of the cargo apron.
 *
 * Three roads of track running the way the crane's rails do — `across` — laid
 * on the green beyond the apron's east edge at 430. They come in through the
 * boundary rather than starting inside it: a siding that begins in the middle
 * of a field is a model railway; one that comes from off the island is a
 * railhead.
 *
 * **They connect to nothing, deliberately.** The main line is on Kestrel, two
 * and a half kilometres away across open water, and `trainRoute.json` never
 * comes near this island. What is here is the airport's own freight railhead
 * as scenery: rails, sleepers and ballast, and no pointwork pretending to lead
 * anywhere.
 *
 * ## The numbers
 *
 * Track centres 8 m apart. Real sidings sit at 4.5 to 6, and at that spacing
 * the three roads read as one wide grey band from any height worth looking
 * from; 8 leaves grass showing between the ballast shoulders, which is what
 * says "three tracks" rather than "a yard".
 *
 * They run `across` 12 to 176. The perimeter wall crosses at 99, so each road
 * has 87 m inside the boundary and 77 outside it — and `PERIMETER.gates`
 * carries the opening, because a track that runs up to a wall is worse than
 * no track at all.
 *
 * Everything about the track itself is `TRAIN`'s: the same 1.435 m gauge, the
 * same 0.65 m sleeper spacing, the same monobloc sleeper the main line and the
 * station roads instance. Track built to its own figures is the first thing
 * anyone who knows railways would see.
 */
export const SIDINGS = {
  /**
   * The neck: the one road that carries on north, and the line the others
   * join. Everything about the throat is measured off it.
   */
  neck: 464,
  /**
   * How far north the two mains run before they stop.
   *
   * 145: seven metres short of the perimeter wall's north face at `across`
   * 152, and not one metre more.
   *
   * They ran to 268 once, and that was the last thing standing in the
   * bridge's ground. Measured against the deck's own centreline — level along
   * across 259 from the junction at 419.5 to the aim point at 450, then away
   * to the city — the down main's head at (464, 268) was **8 m** from it and
   * the up main's at (476, 268) was 18. Nothing else in the terminal was
   * inside 50.
   *
   * Then they ran to 206, six metres out through a gate in a wall that stood
   * at 200. The wall has since come south to 152 and off the bridge corner
   * altogether, so the stubs came with it.
   *
   * They stop INSIDE the wall on purpose. The gate at 455..485 is left open
   * for a line that has not been drawn yet — see `PERIMETER.spur.piers` — and
   * a stub poking through an opening nothing connects to yet is a guess about
   * where the connection lands. Seven metres of standing ground at the
   * railhead is what a yard has anyway.
   */
  neckEnd: 145,
  /**
   * The five roads, and the ladder they make.
   *
   * `at` is each road's own `along` where it runs straight; `from` is where
   * it starts at the south end; `merge` is the `across` at which it starts
   * easing onto the neck, and it ends 40 m later ON the neck. The neck's own
   * entry has no merge — it IS the line.
   *
   * **Each road ENDS at its turnout, it does not continue.** That is the
   * difference between a ladder and a mistake: five roads carried north on
   * the same alignment would be five coincident tracks z-fighting down the
   * neck. Only one line leaves a terminal; everything else peels off it.
   *
   * Staggered so no two turnouts sit opposite each other, which is both how a
   * ladder is built and what makes it read as one from above. It was 24 m
   * when there were three of them and the wall was at 200; it is 8 m and two
   * of them now, on opposite mains — see the throat, below.
   *
   * ## Two roads leave this yard, not one
   *
   * 464 and 476 both run the whole length to the railheads at `across` 145,
   * facing the gate together: a **down main and an up main**, 12 m apart,
   * which is what a yard this
   * size is connected by and what a single neck never looked like. The other
   * three are sidings and each ends at its own turnout — 437 and 447 onto the
   * down main, 488 onto the up — so no two roads are ever coincident.
   *
   * `onto` is which of the two a siding joins. It was implicit before,
   * because there was only ever one thing to join.
   *
   * ## Why the last turnout finishes at 144
   *
   * Two things set the throat. Below it, the goods dock stands between roads
   * 447 and 464 from `across` 18 to 110, and a road that starts easing toward
   * the main before 110 eases straight through it. Above it, the railheads
   * are at 145 — seven metres short of the perimeter wall at 152, see
   * `PERIMETER.spur`. A 40 m transition has to fit between the two, so the
   * last turnout can start no earlier than 110 and no later than 105.
   *
   * There is exactly one place to put it. Yard 2 leaves the dock at 104 and
   * reaches the down main at 144; yard 3 comes off the other side at 96 and
   * reaches the up main at 136. Eight metres of stagger, which would be tight
   * on one main and is nothing across two.
   *
   * Yard 1 has no turnout at all any more. Its merge finished at 196 — fifty
   * metres beyond the wall — and rather than cram a third transition into the
   * same forty metres it became what its stock says it already was: a
   * dead-end stabling road.
   *
   * It used to be stacked at 96, 132 and 156 against a wall at 200. The wall
   * came south twice — to 212, then to 152 and off the bridge corner
   * altogether — and each time the ladder came with it, because a turnout
   * that finishes past the railhead is a turnout onto nothing.
   *
   * Everything north of the wall is left empty on purpose. That is the corner
   * the road bridge lands in, and the ground a connection off the head of the
   * mains would need.
   *
   * ## Why they stop at -48, and not one metre further
   *
   * South of here is the end of the runway. `RUNWAY` is centred on across
   * -120 and runs to along 420, so the ground beyond the buffer stops is the
   * strip off the eastern threshold — the approach, and the one piece of an
   * airfield that nothing at all stands on. A yard laid across it would be
   * the first thing wrong with this island from the air.
   *
   * So the roads grow NORTHWARD instead. -48 is twelve metres of ballast
   * south of the yard apron, which is what a buffer stop needs to stand on
   * and nothing more; the neck goes twelve further, to -60, because past the
   * last turnout it is a **headshunt** — the stub a shunter draws into to run
   * round its train, and a yard without one cannot actually be worked.
   */
  roads: [
    /*
   * A dead end now, and properly so.
   *
   * It merged onto the down main at 156, which put its heads at 196 — fifty
   * metres past the wall's new line. A stabling road does not have to go
   * anywhere: it holds wagons, and it holds them just as well against a
   * buffer stop. Everything on it is south of 140, so nothing moved.
   */
  { at: 437, from: -48, merge: null, onto: null, label: 'yard 1 · stabling' },
    // 104 and not 132: the transition is 40 m, so merging at 132 finished at
  // 172 and the wall is at 148. 104 finishes at 144, and the curve is still
  // west of the platform's edge where it passes it.
  { at: 447, from: -48, merge: 104, onto: 464, label: 'yard 2 · dock' },
    { at: 464, from: -60, merge: null, onto: null, label: 'down main' },
    { at: 476, from: -48, merge: null, onto: null, label: 'up main' },
    { at: 488, from: -48, merge: 96, onto: 476, label: 'yard 3 · arrivals' },
  ] as ReadonlyArray<{
    at: number; from: number; merge: number | null; onto: number | null; label: string;
  }>,
  /** How long a road takes to ease from its own line onto the main it joins. */
  transition: 40,
  /**
   * Ballast: shallower than the main line's 0.62 m, because this is track
   * dropped on made ground rather than a formation carried across a bay.
   */
  ballast: { depth: 0.4, crownHalf: 2.3, slope: 1.5 },
  /** Buffer stops at the south end, which is what makes each road a siding. */
  stop: { height: 1.05, width: 2.5, thick: 0.5 },
  /**
   * The goods platform: an island dock between the two loading roads.
   *
   * 1.2 m is lorry-bed height, not passenger-platform height — the whole
   * reason this is here is that things come off a wagon on one side and go
   * onto a lorry on the other. A 915 mm passenger platform would be a step
   * down into every van that backed up to it.
   *
   * Ramped at both ends rather than walled, so a forklift can get onto it.
   * Open, with no canopy: this one is worked from above.
   */
  platform: {
    from: 449.5,
    to: 461.5,
    across: [18, 110] as readonly [number, number],
    height: 1.2,
    edge: 0.5,
    ramp: 9,
  },
  colours: {
    ballast: '#5a544d',
    stop: '#8a3a2c',
    deck: '#9e9a92',
    edge: '#c8c3b6',
  },
} as const;

/**
 * The centreline of one freight road, in the island's frame.
 *
 * It lives here rather than in the component that lofts it because the minimap
 * draws these roads too, and a map that eases its turnouts differently from
 * the ground is a map of a different railway. `AirportIsland.roadSamples`
 * wraps this and adds the arc length and normals a loft needs; nothing else
 * should be working out where a siding goes.
 *
 * The shape is the whole of a turnout at this scale: straight at `at` until
 * `merge`, then a smoothstep over `transition` metres onto `onto` — or, for a
 * road that merges with nothing, straight to `neckEnd` and a buffer stop.
 */
export function sidingCentre(
  road: { at: number; from: number; merge: number | null; onto: number | null },
  step = 2,
): Array<[number, number]> {
  const end = road.merge === null ? SIDINGS.neckEnd : road.merge + SIDINGS.transition;
  const onto = road.onto ?? SIDINGS.neck;
  const out: Array<[number, number]> = [];
  for (let z = road.from; z <= end + 0.001; z += step) {
    let x = road.at;
    if (road.merge !== null && z > road.merge) {
      const t = Math.min(1, (z - road.merge) / SIDINGS.transition);
      x = road.at + (onto - road.at) * (t * t * (3 - 2 * t));
    }
    out.push([x, z]);
  }
  return out;
}

/**
 * Where the rail actually is at a given `across`, and which way it points.
 *
 * `sidingCentre` gives the whole polyline, which is what a loft wants; this
 * gives one pose, which is what anything STANDING on the road wants. They run
 * the same easing so the two cannot disagree.
 *
 * It exists because stabled stock used to be placed at `road.at` — the road's
 * straight `along` — and a road does not stay on its straight. Past `merge` it
 * eases onto the main, and two vans parked in that ease sat 3.3 m and 10.9 m
 * off their own rails, floating over the ballast beside the track they were
 * supposed to be on. Anything that asks for a position on a road asks here.
 */
export function railPose(
  road: { at: number; merge: number | null; onto: number | null },
  across: number,
): { along: number; turn: number } {
  const at = (z: number) => {
    if (road.merge === null || z <= road.merge) return road.at;
    const t = Math.min(1, (z - road.merge) / SIDINGS.transition);
    return road.at + ((road.onto ?? SIDINGS.neck) - road.at) * (t * t * (3 - 2 * t));
  };
  // Central difference over a metre: the ease is a cubic, so this is exact
  // enough that a 12 m wagon's ends sit within a centimetre of the rail.
  const d = 0.5;
  return { along: at(across), turn: Math.atan2(at(across + d) - at(across - d), 2 * d) };
}

/**
 * The freight terminal around the track.
 *
 * A real railhead is four things in this order: **track you can work, ground
 * you can stand a lorry on, light you can work under, and stock standing
 * about.** Those are what is here. No office block and no ornament — a
 * terminal is a yard, and a yard is mostly surface.
 */
export const YARD = {
  /**
   * The paved container yard, east of the last road.
   *
   * A railhead is a strip of ballast beside a slab of concrete: boxes come off
   * the wagon, cross a few metres of hardstanding and go on a lorry, and the
   * concrete is most of the site's area. 46 m deep, which is a reach-stacker's
   * working width plus two rows of boxes and an aisle.
   */
  hardstanding: [496, 542, 12, 152] as const,
  /**
   * The yard apron: the road across the terminal, and it IS an apron.
   *
   * The modular road kit was laid here and taken up again. A 19 m carriageway
   * with kerbs, pavements and a double-yellow median is a town street, and a
   * town street through an airfield freight terminal looks like one — the
   * ground on both sides of it is airport tarmac with airport paint on it,
   * and the join was the only thing you could see. So this is tarmac too,
   * marked out the way the rest of the field is marked out.
   *
   * 48 m deep and the full length of the terminal, from the cargo apron's
   * east edge to the island's east side. It carries everything: lorries off
   * the freight stand, the fuel bowsers, the fitters' vans — and it crosses
   * all five freight roads on the level, which is the whole point of putting
   * it here rather than at the head of them. See `CROSSINGS` for the decks.
   */
  headland: [430, 496, -30, -8] as const,
  /**
   * The wide end of the apron, east of the last freight road.
   *
   * The yard road used to be 48 m deep for its whole length, which made the
   * level crossing 48 m deep as well — a plateau you drove onto rather than a
   * crossing, and 48 m of track that no wagon could stand on without sitting
   * in the road. The road is now 22 m, and the parking it used to hold is
   * here instead, in the one stretch of the apron no train crosses.
   */
  lorryPark: [496, 542, -36, 12] as const,
  /**
   * The silo road: the strip between the perimeter wall and road 437.
   *
   * Thirteen metres wide and a hundred long, and until now it was grass with
   * three silos and an elevator standing on it — which is what a bulk plant
   * looks like before anyone surfaces the ground a lorry has to back onto.
   * It is bounded by things that cannot move: the wall at 420 and the first
   * road's ballast shoulder at 434.1.
   *
   * It only starts at `across` 98 because south of that the cargo apron is
   * already there, out to along 430 — paving two surfaces over the same
   * ground is how you get a strip of z-fighting a hundred metres long. It
   * runs on to 196, where the north yard takes over, because this is now the
   * WEST SIDE of the terminal's lorry circuit rather than a dead end at the
   * silos.
   */
  // Stops at the wall's new line rather than running 48 m outside it.
  siloRoad: [421, 434, 98, 148] as const,
  /*
   * There is no north apron any more.
   *
   * It stood at across 152..192, and the boundary now turns at (520, 138), so
   * all of it was outside the wall — a lorry turning circle in a field. The
   * turn it existed for is still there: the lorry route is yard road, lorry
   * park, up the aisle and round the head of the hardstanding, which is
   * inside.
   */
  /**
   * The tip: the last hundred metres of the island, past the stacks.
   *
   * It is enclosed now — the spur goes round it at twelve metres from the
   * water instead of the ring's twenty — and it is the only piece of the
   * terminal that is wider than it is long. Overflow stacking: two bays and a
   * mast, reached straight off the hardstanding's north edge.
   */
  northTip: [542, 552, -34, 94] as const,

  /**
   * Floodlight masts.
   *
   * The single most useful thing in a yard at this scale. A rail terminal is
   * flat and grey and reads as nothing from the air; six 22 m masts give it a
   * skyline and say this is worked at night, which is when freight moves.
   */
  masts: {
    height: 22,
    /** Column half-section at the foot and at the head — it tapers. */
    foot: 0.55,
    head: 0.3,
    /** The lamp gantry on top: how wide, how deep, how many heads. */
    rig: { width: 4.6, deep: 1.1, lamps: 5 },
    at: [
      // Along the yard road's south verge, lighting the crossing and the
      // lorry park. Clear of the carriageway, which runs across -30 to -8.
      [431, -38], [470, -38], [494, -38], [524, -40],
      // Over the container stacks, the offices and the transit shed.
      [524, 100], [482, 140], [538, 130], [545, 40],
      // The throat where five roads become one, and the silo road's west side.
      // The north apron, and the head of the mains.
      [510, 180], [482, 190], [430, 176],
      // And the dock's own two, off its east side.
      [469, 40], [469, 100],
    ] as ReadonlyArray<readonly [number, number]>,
  },

  colours: {
    hardstanding: '#8f929a',
    mast: '#6a7078',
    lamp: '#f6efd8',
  },
} as const;

/**
 * What is stabled in the yard, road by road.
 *
 * Every vehicle is one the railway already ships — the Class 08 that shunts
 * the main line, and the four wagons its goods trains are made of. The two
 * container flats arrive **already loaded** (`wagonFlat40` carries a blue
 * 40 ft box, `wagonFlat20` a red and a green), which is why nothing has to be
 * craned onto them here.
 *
 * Every model is built with its length down its own +Z and these roads run
 * down the island's +Z, so a wagon needs no rotation at all — the one piece of
 * luck in the whole layout.
 *
 * `at` is the `across` of the vehicle's centre, pitched at 12.6 m: a 12.04 m
 * wagon and a coupling.
 */
export interface StabledVehicle {
  model: string;
  road: number;
  at: number;
}

const RAKE = (model: string, road: number, from: number, n: number, pitch = 12.6) =>
  Array.from({ length: n }, (_, i) => ({ model, road, at: from + i * pitch }));

export const STABLED: readonly StabledVehicle[] = [
  /*
   * Two rules, and between them they place everything.
   *
   * **Nothing on a main.** 464 and 476 run the length of the yard and out
   * through the wall, so the only thing standing on either is the spare loco
   * on the headshunt at the blunt south end of the down main, and a brake van
   * on the up main's stub. Everything else is on a siding.
   *
   * **Nothing on the crossing.** The yard road runs `across` -30 to -8 over
   * every road, and a wagon left across it blocks the only way from the cargo
   * apron to the container yard. So every vehicle is either SOUTH of -30 —
   * eighteen metres between the buffer stops and the road, which is exactly
   * one wagon — or NORTH of -8.
   */

  /* ------------------------------------------------------------ yard 1, 437 */
  { model: '/models/wagonBoxcar.glb', road: 437, at: -38 },
  { model: '/models/train08.glb', road: 437, at: -2 },
  ...RAKE('/models/wagonBoxcar.glb', 437, 14, 3),
  ...RAKE('/models/wagonFlat20.glb', 437, 58, 2),
  // Five hoppers standing over the silos' discharge pit, which is the whole
  // reason the pit is where it is.
  // At 96 the last of the five ended at 145.2 and the rail's last sleeper is at
  // 144, so a metre of hopper hung off the end of its own road. Two metres back
  // puts it at 143.2, and eleven metres of spacing still clears the 10.374 m
  // body, so the rake did not have to be re-cut to fix an overhang.
  ...RAKE('/models/wagonHopper.glb', 437, 94, 5, 11),

  /* -------------------------------------------------- yard 2, 447: the dock */
  { model: '/models/wagonFlat40.glb', road: 447, at: -38 },
  ...RAKE('/models/wagonFlat40.glb', 447, 0, 7),
  // And it ends there. 447's turnout starts at `across` 104, and two vans used
  // to stand at 110 and 122.6 — ON the ease, which is a road bending 17 m
  // sideways over 40. Placed at the road's straight they sat 3.3 m and 10.9 m
  // out in the ballast; placed on the rail by `railPose` they would sit ON it
  // but with an 11.6 m rigid body cutting 0.8 m inside the curve, because the
  // smoothstep is at its sharpest where it leaves the straight. Nothing stands
  // on a turnout. They moved to 488, which had the only room left.
  { model: '/models/train08.glb', road: 447, at: 96 },

  /* --------------------------------------------------- 464 and 476: the mains */
  { model: '/models/train37.glb', road: 464, at: -47 },
  { model: '/models/wagonBoxcar.glb', road: 476, at: -38 },

  /* --------------------------------------------- yard 3, 488: the shed road */
  // Through the running shed, which straddles the up main and this one: the
  // main is left clear and everything stands on the siding beside it.
  //
  // Re-spaced to take yard 2's two vans as well: eight vehicles between the
  // buffer stops and the turnout at 96 rather than six, which is 0.8 m of gap
  // at the tightest coupling and is what a full yard road looks like. The two
  // locomotives keep the middle of the shed; the vans stand either side.
  { model: '/models/wagonTank.glb', road: 488, at: -38 },
  ...RAKE('/models/wagonTank.glb', 488, 0, 2),
  { model: '/models/train37.glb', road: 488, at: 34 },
  { model: '/models/train08.glb', road: 488, at: 51 },
  { model: '/models/wagonBoxcar.glb', road: 488, at: 63 },
  { model: '/models/wagonBoxcar.glb', road: 488, at: 75.6 },
  { model: '/models/wagonBoxcar.glb', road: 488, at: 88 },
];

/* ------------------------------------------------------- the running shed */

/**
 * The motive power depot, over roads 476 and 488.
 *
 * A yard with locomotives in it and nowhere to put them is a car park. Every
 * real railhead this size has one shed with two roads through it, and that is
 * exactly this — no more, because a depot is a working building and working
 * buildings are plain.
 *
 * It is sheeted in the airfield's own grey rather than in depot brick, and it
 * is the airfield's own proportions: a low eaves, a shallow pitch and a long
 * plain flank, which is what every other building on this island is. A
 * blackened brick roundhouse would be a better shed and a worse airport.
 *
 * **Open at both ends.** The point of drawing a shed rather than dropping a
 * box on the track is that you can see the locomotive standing inside it, and
 * a closed gable turns the whole thing into scenery with a train buried in
 * it. Doors are a head beam and a gable above, and the opening under them is
 * the full width of both roads.
 */
export const DEPOT = {
  /** The two roads it stands over, and how far past the outer ones it reaches. */
  roads: [476, 488] as const,
  margin: 5.5,
  /**
   * The `across` it spans: 60 m, which is two locomotives and a walkway.
   *
   * 30 to 90 and not further south, for the same reason the roads stop at
   * -48: everything past the yard apron is the runway's approach. This is the
   * one stretch of roads 476 and 488 that is straight, clear of the apron and
   * clear of the turnouts, and it happens to be exactly long enough.
   */
  from: 30,
  to: 90,
  /** Sheeted to the eaves, and a shallow pitch over that. */
  eaves: 7.2,
  ridge: 9.4,
  /** The portal frames: how often, and how thick. */
  bay: 10,
  column: 0.42,
  /** The door opening: how high the head beam sits. */
  head: 5.6,
  /** A continuous roof light down each pitch, as a fraction of the slope. */
  roofLight: 0.34,
  /** The lean-to along the east flank: stores, mess and the fitters' shop. */
  annexe: { deep: 5, height: 4.2 },
  colours: {
    plinth: '#7c7f84',
    sheet: '#9aa0a6',
    roof: '#6b7278',
    light: '#cfe3ea',
    frame: '#4a525a',
  },
} as const;

/* --------------------------------------------------------- the bulk terminal */

/**
 * Three silos at the head of the neck, and what they are for.
 *
 * The hopper wagons stabled in this yard have to be going somewhere. A
 * railhead that handles containers and nothing else needs no hoppers at all,
 * so either they are wrong or there is a bulk terminal — and a bulk terminal
 * is three cylinders, a pit under the track and a conveyor between them,
 * which is about forty metres of ground and the tallest thing for half a
 * kilometre.
 *
 * It sits in the only pocket the island has left: west of the neck, north of
 * where road 437's turnout finishes at `across` 232, and south of the estate
 * fence at 278. Twenty-one metres between the two ballast shoulders, which
 * a nine-metre silo fits in with six metres either side.
 */
export const SILOS = {
  /**
   * Down the terminal's WEST edge, in the 14.6 m between the cargo road's
   * east kerb at 419.5 and road 437's ballast shoulder at 434.1.
   *
   * They stood at the head of the neck, at along 450 across 240 to 270, and
   * that was straight through the bridge. `CROSSING.island` puts the deck's
   * aim point at (450, 259) and the curve onto the outer road runs from there
   * back to (419.5, 259) — so three 28 m silos and a conveyor at 26 m were
   * standing in the approach to the island's only road crossing, and in the
   * one piece of ground a rail connection to the mainland would have to use.
   *
   * Here they are hard against the cargo road, inside the wall, four metres
   * off the road they are loaded from and as far from the bridge as the
   * terminal goes. A bulk store belongs at the road end of a yard anyway.
   */
  along: 426.8,
  at: [104, 120, 136] as readonly number[],
  radius: 4.4,
  /** The barrel, the cone under it and the legs under that. */
  height: 16,
  cone: 4.5,
  roof: 1.2,
  legs: { height: 5, count: 6, half: 0.22 },
  /**
   * The elevator leg, in line with the row at its south end.
   *
   * In line, and not beside the track where it was: there are 14.6 m between
   * the cargo road and the ballast and the silos take nine of them, so a
   * tower alongside would have had to stand either in the road or on the
   * shoulder. At the end of the row it has the whole width.
   */
  tower: { along: 426.8, across: 92, half: 2.6 },
  /** The covered intake from the pit to the foot of the leg. */
  intake: { from: 426.8, to: 437, across: 98, height: 4.4, width: 2.2 },
  /** The conveyor along the silo tops, off the head of the leg. */
  conveyor: { width: 2.3, deep: 1.9, from: 92, to: 142 },
  /** The discharge pit: the grating between the rails the hoppers drop into. */
  pit: { road: 437, from: 92, to: 146, half: 1.9 },
  colours: {
    barrel: '#c3c7cb',
    cone: '#9aa0a6',
    leg: '#6f767c',
    gantry: '#7f868c',
    grate: '#4d5358',
  },
} as const;

/* -------------------------------------------------------- the level crossings */

/**
 * Where the yard apron crosses the freight roads.
 *
 * Five crossings in fifty metres, which is what a road down a yard is: you do
 * not bridge a siding, you drive over it. Each one is a deck flush with the
 * railhead — a panel outside each rail and one between them — plus a light on
 * each approach. No barriers: a yard crossing is worked by sight at walking
 * pace, and a lowered barrier on all five would fence the road off from
 * itself.
 */
export const CROSSINGS = {
  /**
   * The bands the terminal's roads cross the track in.
   *
   * One, and the terminal is laid out so that it stays one: the yard road
   * crosses all five roads at the south end and nothing else crosses the
   * railway anywhere. `roads` is null for "every one of them", and a second
   * band here would be decked and ramped on its own — see `buildYardTrack`.
   */
  lanes: [
    { from: -30, to: -8, roads: null, label: 'yard road' },
  ] as ReadonlyArray<{
    from: number; to: number; roads: readonly number[] | null; label: string;
  }>,
  /** How far past the outer roads' centres the deck reaches. */
  panel: 3.4,
  /**
   * The approach ramps, and why they have to exist.
   *
   * The deck is flush with the railhead, and the railhead is 0.78 m above the
   * ground: 0.4 of ballast, 0.22 of sleeper and 0.16 of rail. Laid as a bare
   * slab that is a 780 mm kerb across the road, twice — a wall to drive at,
   * not a crossing. 12 m of ramp at each end is 1 in 15, which is a gradient
   * a loaded lorry takes without noticing.
   *
   * ## One deck a band, not one a road
   *
   * The five roads are 10 to 12 m apart and their ballast shoulders eat 5.8 m
   * of every gap, so a separately ramped crossing per road would need to rise
   * and fall 780 mm inside 4 m — a 1 in 5 hump, five times in seventy metres.
   * Real multi-track crossings are one continuous deck from the first rail to
   * the last, ramped only at the two ends, and so are these.
   */
  ramp: 12,
  /** The stop line and the lamp on each approach, this far out from the toe. */
  lamp: { out: 1.6, height: 3.1, post: 0.16 },
  /**
   * The lorry park, at the east end past the last road.
   *
   * Bays across the apron rather than down it, which is how a yard parks a
   * lorry: you reverse onto the stack and drive off forwards. Held east of
   * 508 so that nothing stands on the crossing's east ramp, which runs out to
   * 503.4.
   */
  park: { from: 508, to: 540, bay: 3.6, deep: 19, at: -34 },
  colours: { post: '#41484f', lamp: '#e8503a' },
} as const;

/* ------------------------------------------------------------- the container yard */

/**
 * Stacked containers on the freight apron.
 *
 * The apron had three `deco_container1` chunks on it — 24 triangles apiece,
 * a single row one box high, all the same colour, because that is what a city
 * chunk is. A freight yard is not that: it is boxes stacked three high in
 * bays, in every livery that ever called there, and the colour is most of what
 * makes it read as one.
 *
 * So these are drawn rather than lifted: one `BoxGeometry` instanced per box
 * with a per-instance colour, which is 150-odd containers in a single draw
 * call. `instanceColor` multiplies the material, so the corrugated texture is
 * painted once in greyscale and every box tints it.
 *
 * ## Where the bays are, and why only three
 *
 * Rasterising the apron against everything already on it — the sheds, the
 * crane and its 137 m of rail, the existing chunks, the freighter's stand and
 * the wingspan it needs, the cargo service loop and the road's mouth — leaves
 * less free ground than it looks. These are the three rectangles that are
 * genuinely clear:
 *
 * ```
 *   bay      along        across      what it fits between
 *   north    292..359     44..56      the existing rows and the annexe
 *   west     264..305     -44..-32    the west chunk and the stand's wingtip
 *   east     366..407     50..56      the annexe's east end and the crane
 * ```
 */
export const CONTAINERS = {
  /**
   * The box, measured off the city chunk rather than stated from a spec.
   *
   * `deco_container1_-1_0` is not a block of scenery: cut into connected
   * pieces it is individual 12.28 x 2.60 x 2.80 m boxes, which is a 40 ft ISO
   * container to a few centimetres. That is what is instanced here — see
   * `extractContainer`. Nothing about a container is modelled by us.
   */
  part: 'deco_container1_-1_0',
  box: { long: 12.28, wide: 2.80, high: 2.60 },
  /** Gaps: end to end down a row, side to side between rows, and stack to stack. */
  gap: { end: 1.1, side: 0.5, tier: 0.03 },
  /**
   * The liveries, weathered.
   *
   * The city's texture is a photograph of a BLUE container, and
   * `instanceColor` multiplies — so a blue skin tinted red comes out nearly
   * black. `neutralise` takes the luminance of it once, at load, which keeps
   * every corrugation, door bar and scuff in the photograph and lets these
   * multiply cleanly over it.
   *
   * Each is its line's colour taken down in value and saturation, because
   * straight off the paint chart looks like it. The spread matters more than
   * any one of them.
   */
  colours: [
    '#9c5443', // oxide red, the commonest box in any yard
    '#35618a', // the blue it started as
    '#456f58', // green
    '#a08f6b', // tan
    '#6f4a2e', // brown
    '#5f6a72', // grey
  ],
  /**
   * The bays. `rows` is boxes side by side across, `long` end to end along,
   * `high` the stack, `base` the height it stands on — 0 on the apron, the
   * deck's own height for the bay standing on the goods platform. A bay is
   * laid from its own (along, across) corner.
   *
   * Two small ones. The first pass put three bays and seventy-nine boxes on
   * the apron, which buried it — a freight stand is mostly empty tarmac with
   * a few stacks on it, because the empty tarmac is what the aeroplanes and
   * the loaders need.
   */
  bays: [
    { along: 302, across: 46, long: 3, rows: 2, high: 2, seed: 7, base: 0, turn: 0 },
    { along: 268, across: -42, long: 2, rows: 2, high: 2, seed: 23, base: 0, turn: 0 },
    /*
     * On the goods platform, standing on the deck rather than the ground:
     * three boxes mid-transfer, which is what says the dock is in use.
     *
     * TURNED, and it has to be. The dock is 12 m wide and a 40 ft box is
     * 12.28 long, so one laid across it hangs off both faces and a second
     * would be standing on the far road. A quarter turn lays them down the
     * platform's length instead, which is where they would actually be —
     * craned off a wagon and set down beside it.
     */
    { along: 452, across: 24, long: 3, rows: 1, high: 1, seed: 61, base: 1.2, turn: Math.PI / 2 },
    // The railhead's own stacks, on the hardstanding east of the roads. Turned
    // down the yard so a reach-stacker works them off the aisle rather than
    // over the top of its neighbour.
    /*
     * The railhead's own stacks, on the hardstanding.
     *
     * All of them turned, so a reach-stacker works a bay off the aisle beside
     * it rather than over the top of its neighbour; all of them north of
     * `across` 12, because south of that is the apron the lorries cross; and
     * and both of them east of 516, because `along` 496 to 514 is the aisle
     * the lorries run up to reach the north apron. There were three; the
     * third stood square in that route, and a stack of boxes in a roadway is
     * a stack of boxes nobody can reach.
     */
    { along: 516, across: 18, long: 5, rows: 2, high: 3, seed: 83, base: 0, turn: Math.PI / 2 },
    { along: 516, across: 96, long: 3, rows: 2, high: 2, seed: 131, base: 0, turn: Math.PI / 2 },
    // ...and two on the tip, which the boundary only reached this week.
    { along: 544, across: -20, long: 4, rows: 2, high: 2, seed: 167, base: 0, turn: Math.PI / 2 },
    { along: 544, across: 46, long: 3, rows: 2, high: 2, seed: 199, base: 0, turn: Math.PI / 2 },
  ],
} as const;

/** One box of a bay: where it sits and which livery it wears. */
export interface ContainerBox {
  x: number;
  z: number;
  y: number;
  /** Radians about +Y. A quarter turn lays the box's length down `across`. */
  turn: number;
  colour: string;
}

/**
 * Every box in every bay, with a stable livery each.
 *
 * Generated rather than listed — a hundred and fifty placements written out by
 * hand is a hundred and fifty chances to put one through a shed — and seeded
 * per bay so the yard looks the same every time you fly over it.
 *
 * A stack is not always full: `high` is the tallest it goes and a tier is
 * dropped now and then, because a yard with every stack at exactly three reads
 * as a wall rather than as boxes someone is working through.
 */
export const CONTAINER_BOXES: readonly ContainerBox[] = CONTAINERS.bays.flatMap((bay) => {
  const B = CONTAINERS.box;
  const G = CONTAINERS.gap;
  let seed = bay.seed;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const out: ContainerBox[] = [];
  // A turned bay runs its length down `across` instead of `along`, so which
  // way `long` and `rows` step swaps with it.
  const turned = bay.turn !== 0;
  const stepLong = turned ? [0, B.long + G.end] : [B.long + G.end, 0];
  const stepRow = turned ? [B.wide + G.side, 0] : [0, B.wide + G.side];
  const half = turned ? [B.wide / 2, B.long / 2] : [B.long / 2, B.wide / 2];
  for (let r = 0; r < bay.rows; r++) {
    for (let c = 0; c < bay.long; c++) {
      // One or two off the top, so the skyline of the yard is not flat.
      const tiers = Math.max(1, bay.high - (rnd() < 0.3 ? 1 : 0));
      for (let t = 0; t < tiers; t++) {
        out.push({
          x: bay.along + c * stepLong[0] + r * stepRow[0] + half[0],
          z: bay.across + c * stepLong[1] + r * stepRow[1] + half[1],
          y: bay.base + t * (B.high + G.tier) + B.high / 2,
          turn: bay.turn,
          colour: CONTAINERS.colours[Math.floor(rnd() * CONTAINERS.colours.length)],
        });
      }
    }
  }
  return out;
});

/** One tree, one piece of street furniture, one car — the city's own. */
export const TREE_PART = 'deco_Vegetation_-3_-3';

/* ------------------------------------------------------------- the entrance */

/**
 * The entrance: a kerbed avenue, a gate and a sign.
 *
 * An approach road on its own is a strip of tarmac in a field. What makes an
 * airport entrance read as one is the sequence you pass through — a sign that
 * names the place, an avenue with something planted down the middle of it, a
 * gate with a hut and two barriers, and a stop line — and all of that is small
 * kit, which is why it is built out of boxes and the city's own street
 * furniture rather than needing a model of its own.
 *
 * Everything is in the island's frame and measured off `centre` and the kit's
 * own carriageway width, so moving the road moves the site with it.
 */
export const ENTRY = {
  /** Centreline of the approach, and what `roadConfig` builds the road from. */
  centre: ENTRY_ALONG,
  /**
   * Half the carriageway, read off the kit rather than written down.
   *
   * The approach was a 20 m slab and is a 18.96 m kit road, and every piece of
   * furniture on it is placed off its kerbs — the barrier pivots, the verge
   * rails, the avenue. Reading the width from the model is what stops them
   * drifting into the road the next time the kit changes.
   */
  half: ROAD_HALF,
  /**
   * The gate, and the barriers are UP.
   *
   * A working barrier that is down is a wall across the only road onto the
   * airport, and the player is the one who would meet it. These are raised,
   * which is also what a barrier looks like for all but ten seconds of its
   * life; the stop line and the hut carry the reading on their own.
   *
   * There were two arms on a central reservation, each reaching out over its
   * own 8 m carriageway. The reservation is gone — it existed to divide a
   * blank slab into two lanes, and the kit paints its own — so the arms have
   * swapped ends: one on each KERB, reaching in to meet over the crown. That
   * is the arrangement a single carriageway gate actually has, and it is also
   * the one that leaves the middle of the road clear.
   */
  gate: {
    at: 214,
    /** The stop line, a car's length before the arms, on the arriving side. */
    stopLine: 220,
    /**
     * Barrier arms: pivot `clear` outside the kerb, reaching to the crown.
     *
     * `length` is the half-width plus the setback, so the two arms meet in the
     * middle whatever the road is; lowered they would close it exactly.
     */
    arm: { thick: 0.17, pivot: 1.05, clear: 0.9 },
    /**
     * The gatehouse, on the east verge rather than in the road.
     *
     * It stood on the reservation, which was the only place a hut could go on
     * a road with no verges. With the reservation gone it moves to the side
     * the arriving carriageway passes — arrivals run up the WEST half, so the
     * hut on the east looks across both lanes and the barrier at once.
     */
    hut: { off: 13.5, at: 224, width: 4.2, depth: 3.4, height: 3.4 },
  },
  /**
   * The sign gantry over the mouth: two posts and a beam with a board on it.
   *
   * At across 238, between the back road and the gate, so it frames the road
   * from the moment you turn off. Its span is set from the carriageway rather
   * than guessed: posts stand a metre and a half outside each kerb.
   */
  gantry: { at: 238, clear: 1.5, height: 6.8, post: 0.42, beam: 0.9, board: { width: 12, height: 2 } },
  colours: {
    kerb: '#a8a49a',
    post: '#6d7176',
    arm: '#e8e4d2',
    band: '#d8402f',
    hut: '#e4e1d8',
    glass: '#9fc0cf',
    board: '#15406b',
  },
} as const;

/**
 * The city kit along the approach, generated rather than listed.
 *
 * An avenue is a repeating thing and writing out twelve trees by hand is how
 * one of them ends up in the carriageway. All of it is `deco_` chunks lifted
 * from the city exactly as the containers and the service units are — the
 * difference being that these are street furniture and planting, not blocks of
 * high street, which is what the island had too much of.
 *
 * | part                        | size (m)          | used as            |
 * | --------------------------- | ----------------- | ------------------ |
 * | `deco_Vegetation_-3_-3`     | 6.1 x 10.2 x 6.2  | the avenue's trees |
 * | `deco_Obstacles_0_-2`       | 41.8 x 3.6 x 0.6  | the verge rails    |
 * | `deco_BillboardBlack_-3_-1` | 15.1 x 11.4 x 18  | the entrance sign  |
 */
const ENTRY_BARRIER = 'deco_Obstacles_0_-2';
const ENTRY_SIGN = 'deco_BillboardBlack_-3_-1';

const ENTRY_KIT: AirportDeco[] = (() => {
  const out: AirportDeco[] = [];
  const verge = ENTRY.half + 4;
  /*
   * The avenue, and it stops at the gate now instead of running through it.
   *
   * It used to step every 14 m from across 176 all the way to 232, which put
   * two pairs of palms in the gate zone — one pair level with the barriers and
   * one under the sign gantry. That reads as a park with a checkpoint in it.
   * An avenue's job here is to lead you TO the gate, so it runs from the
   * terminal road up to the stop line and then stops, leaving the barriers,
   * the gatehouse and the gantry standing in open ground where they are the
   * only things to look at.
   *
   * Four metres clear of the kerbs, which are read off the kit rather than
   * assumed — see `ENTRY.half`.
   */
  for (let z = 176; z <= 204; z += 14) {
    out.push({ part: TREE_PART, x: ENTRY.centre - verge, z, turn: 0 });
    out.push({ part: TREE_PART, x: ENTRY.centre + verge, z, turn: 0 });
  }
  // And one pair at the mouth, between the gantry and the back road, framing
  // the turn in. Clear of the junction tile, which starts at across 249.5.
  for (const side of [-1, 1] as const) {
    out.push({ part: TREE_PART, x: ENTRY.centre + side * verge, z: 245, turn: 0 });
  }
  // A verge rail each side, the city's own. Its 41.8 m run is its X, so a
  // quarter turn lays it along the road rather than across it. Set just
  // outside the kerb line.
  for (const side of [-1, 1] as const) {
    out.push({
      part: ENTRY_BARRIER, x: ENTRY.centre + side * (ENTRY.half + 2.2), z: 200,
      turn: Math.PI / 2, solid: true,
    });
  }
  // The sign, off the west shoulder of the mouth, turned to face a car coming
  // down the back road from the bridge.
  out.push({ part: ENTRY_SIGN, x: 112, z: 243, turn: -Math.PI / 2, solid: true });
  return out;
})();

/**
 * Halcyon East's own kit: what is parked on the yard apron.
 *
 * An apron with nothing on it reads as a car park at four in the morning, and
 * this one is 116 m by 48 — the largest single piece of empty tarmac on the
 * island now that the landside slab is gone. So the lorry park at its east
 * end is actually used, the gate end has units drawn up on it, and there is a
 * row of boxes waiting on the hardstanding's edge.
 *
 * Same two chunks the rest of the airfield is dressed with, because a
 * terminal that borrows a different set of props stops looking like the same
 * airport. See `AIRFIELD_DECO`.
 */
const TERMINAL_KIT: AirportDeco[] = (() => {
  const out: AirportDeco[] = [];
  // In the marked bays at the east end of the apron — see `buildYardPaint`.
  for (const x of [513, 524, 535]) out.push({ part: SERVICE_UNIT, x, z: -25, turn: 0 });
  /*
   * And that is all that stands on the apron.
   *
   * Two more were drawn up along its north edge at along 456 and 496 and are
   * not any more. The gaps between the freight roads are 4 to 11 m wide — the
   * ballast shoulders eat 5.8 of every 12 — so a chunk parked in one of them
   * sits on somebody's track however carefully it is centred, and one of them
   * did: a unit at 456 stood across the neck's own crossing deck. The lorry
   * park east of road 488 is the only part of this apron with real room on
   * it, so everything parks there.
   */
  return out;
})();

export const PROP_PART = 'deco_Accesories_-4_-2';

/** Everything the island borrows from the city: the airfield's kit, and the entrance's. */
export const DECO: readonly AirportDeco[] = [
  ...AIRFIELD_DECO, ...CORNER_BLOCKS, ...ENTRY_KIT, ...TERMINAL_KIT,
];

/**
 * The lights, which are most of what makes this read as an airfield.
 *
 * A runway in daylight is a grey strip with paint on it. What says *airport*,
 * and says it from a kilometre away across water, is the lighting pattern:
 * white edges in two dead-straight lines, green at the approach end, red at
 * the stop end, and blue down the taxiway. They are 0.5 m emissive boxes, one
 * instanced mesh per colour, so the whole airfield's lighting is four draw
 * calls.
 */
export const LIGHTS = {
  edgeSpacing: 60,
  approachLength: 220,
  approachSpacing: 30,
  colours: {
    edge: '#f3efe0',
    threshold: '#35e06a',
    stop: '#e0402f',
    taxi: '#3aa0ff',
  },
} as const;

/** The paint. Widths in metres; everything is drawn a centimetre over the tarmac. */
export const MARKS = {
  colour: '#e9e6dc',
  taxiColour: '#e0c23a',
  centreDash: 30,
  centreGap: 20,
  centreWidth: 0.9,
  edgeWidth: 0.9,
  /** The piano keys: how many stripes a side, how long and how wide. */
  thresholdBars: 6,
  thresholdLength: 40,
  thresholdWidth: 2.4,
  thresholdGap: 1.8,
  /** The aiming point blocks, this far in from each threshold. */
  aimingAt: 250,
  aimingLength: 45,
  aimingWidth: 6,
} as const;
