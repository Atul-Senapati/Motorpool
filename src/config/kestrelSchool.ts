import { ROAD_WIDTH } from './roadConfig';
import { avenue, CROSS } from './kestrelRoads';
import { STATION_SITE } from './stationConfig';
import schoolData from './schoolData.json';
import parkModels from './parkModelData.json';
import workshopData from './workshopData.json';
import colliderBoxes from './colliderBoxes.json';

/**
 * St. Anjali High School: the school campus at the west end of the island.
 *
 * The island is a station, a freight yard, a cruise berth, a stage, a viaduct
 * and a street grid — and the grid's blocks are deliberately empty
 * (`kestrelRoads`), which reads as a town that has not been built yet. Kestrel
 * Water took one of them and made it a park. This takes the whole west end and
 * makes it the thing the park is opposite: somewhere the island's own people go
 * every morning, which is the other half of what stops a place reading as
 * infrastructure.
 *
 * ## Where, and why it is a superblock
 *
 * The campus is `american_high_school.glb` and it is a whole American high
 * school — building, parking lot, running track, baseball diamond — **156 m by
 * 113**. Kestrel's blocks were 140 by 89 at their biggest, so there was never
 * a block for it. The choice was to shrink the school to a model village or to
 * give it a superblock, and a superblock is what a real school gets: the grid
 * drops one bay of one cross street (`CROSSES`, and the note on the skipped bay
 * there), and the middle avenue that used to halve this ground is gone
 * altogether (`AVENUES`).
 *
 * What that leaves is a site bounded by four streets that all run through:
 *
 * - **south**, the station avenue, which is the way back to the station;
 * - **north**, the dock road, and the quay beyond it;
 * - **west**, the cross street at −190, with the ring road past it;
 * - **east**, the park's cross street at −12 — so the school looks straight
 *   across it at Kestrel Water, which is the best thing on the island to put
 *   opposite a school. The stage avenue runs east out of that junction on the
 *   campus's own centreline.
 *
 * 167 m by 159 between the kerbs, which is a good deal more than the campus
 * needs across: see `VERGE`. The railway is one block south of the near kerb
 * and nothing here touches it.
 *
 * ## Which way round
 *
 * The campus is longer than it is deep, the island is longer than it is wide,
 * and the block is longer along the island than across it — so the school lies
 * down the island, a quarter turn from the frame the model was authored in.
 * Its front (`schoolData.front`, measured by `prepare-school.mjs` as the end
 * the playing fields are NOT on) faces the station avenue, which is the street
 * the station is on; the track and the diamond back onto the dock road, where
 * there is nothing but the quay to overlook them.
 */

/** Half the kit's carriageway: how far a kerb stands off an avenue's centre. */
const HALF = ROAD_WIDTH / 2;

/**
 * The superblock, as the four kerb lines round it.
 *
 * The streets by name and not by number, the same as `PARK_BLOCK`, so the
 * campus moves with the grid instead of being left in the road if an avenue
 * ever shifts — and so that deleting one, as the middle avenue was, cannot
 * quietly renumber this into somebody else's block.
 */
export const SCHOOL_BLOCK = {
  /** Between the station avenue and the dock road. */
  acrossFrom: avenue('station avenue') + HALF,
  acrossTo: avenue('dock road') - HALF,
  /** From the west end to the park's cross street: two bays, not one. */
  alongFrom: CROSS[0] + HALF,
  alongTo: CROSS[2] - HALF,
} as const;

/**
 * Where the school building's front wall is, in the model's own frame.
 *
 * Measured, not typed: `prepare-colliders.mjs` rasterises the campus and covers
 * its solid mass with boxes, and the face of the box that reaches furthest
 * toward the front IS the front wall. Taken from that, the plaza knows how far
 * to run without anybody writing down a number that the model could change out
 * from under.
 *
 * `boxes` are `[centreAcross, centreAlong, halfAcross, halfAlong]` in the
 * part's own frame — see `partColliders` — and the campus is turned a quarter,
 * so it is the second pair that faces the plaza.
 */
const SCHOOL_BOXES = (colliderBoxes as Record<string, { boxes: number[][] }>).school;

/**
 * The front wall ON THE PLAZA'S OWN LINE, which is not the same thing.
 *
 * Taking the frontmost face of the whole campus gives whatever sticks out
 * furthest anywhere along 147 m of building — a canopy at one end stops the
 * paving 12 m short at the other. The plaza is 24 m wide and arrives at the
 * middle, so only the boxes it actually runs into count.
 *
 * A box is `[centreAcross, centreAlong, halfAcross, halfAlong]` in the part's
 * own frame (see `partColliders`), and the campus is turned a quarter, so it is
 * the FIRST pair that lands on `along` and the second on `across`.
 */
function buildingFace(width: number, scale: number): number {
  if (!SCHOOL_BOXES) return 0;
  const onAxis = SCHOOL_BOXES.boxes
    .filter(([cx, , hx]) => Math.abs(cx * scale) < width / 2 + hx * scale);
  if (!onAxis.length) return 0;
  /*
   * The BIGGEST box on the axis, not the frontmost one.
   *
   * Frontmost gave a pair of 20 m by 2 fence panels standing twelve metres out
   * in front of the school, and the paving stopped at them — at a fence, in the
   * middle of the campus's own ground, with the doors still twelve metres
   * further on. The building is the 152 m by 24 box; nothing else on this
   * campus is within an order of magnitude of it, so "the big one" picks it out
   * without having to name it.
   */
  const [, cz, , hz] = onAxis.reduce(
    (best, box) => (box[2] * box[3] > best[2] * best[3] ? box : best),
  );
  return cz + hz;
}

/** The workshop block, as `prepare-workshop.mjs` measured it. */
export const WORKSHOP = {
  model: workshopData.model,
  /** Width (X), height (Y), depth (Z), metres. */
  size: workshopData.size as [number, number, number],
  triangles: workshopData.triangles,
};

/** The play frame's own size, from the park kit's measurements. */
const PLAY_SIZE = (parkModels.parts as Record<string, { size: number[] }>).playground.size;

/** The campus, as `prepare-school.mjs` measured it. */
export const SCHOOL = {
  model: schoolData.model,
  /** Width (X), height (Y), depth (Z), metres, at the model's own size. */
  size: schoolData.size as [number, number, number],
  /** How far the lot's slab reaches below its deck. Buried, not stood on. */
  skirt: schoolData.skirt,
  triangles: schoolData.triangles,
};

/**
 * Grass between the campus edge and the kerb, metres.
 *
 * Six, and it is the one number here chosen by eye rather than derived. It is
 * a MINIMUM, not the answer: the fit below solves for the tighter of the two
 * axes and the other gets whatever is left.
 *
 * Along the island the block is 159 m against a 156 m campus, so six metres of
 * verge is bought with about five per cent of the school's size — a 12.5 m
 * building becomes 11.8, which nothing can see.
 */
const VERGE = 6;

/**
 * The grounds: what the rest of the block is, and why the campus is not in the
 * middle of it.
 *
 * Across the island the block is 167 m and the campus is 107, which leaves 60 m
 * of ground the model does not fill. Centred, that came out as **30 m of plain
 * lawn on each side** — and 30 m of mown nothing is not grounds, it is a school
 * that did not fit its site, twice.
 *
 * So the campus is pushed to the BACK. The playing fields sit `back` metres off
 * the dock road, where a strip of grass behind an outfield is exactly what
 * belongs, and the whole 52 m of slack ends up at the FRONT, on the station
 * avenue, where a school's ground actually gets used.
 *
 * ## The frontage is three YARDS, not a strip
 *
 * The first two attempts ran everything the full 147 m: a lot the whole length,
 * then a lane with cars on one side and buses on the other. Both were wrong in
 * the same way — a school's front is not one thing 147 m long, it is **three
 * separate places** with grass between them, and putting them end to end is
 * what makes the result read as a retail park rather than as a school.
 *
 * Along the island, west to east:
 *
 * ```
 *   |<--- park --->|  gap  |<-- entrance -->|  gap  |<--- bus --->|
 *      car park            the doors, the           the buses,
 *      and, behind         forecourt and            their apron
 *      it, the play        the drop-off             and shelter
 *      area
 * ```
 *
 * And across it, avenue to building:
 *
 * ```
 *   station avenue kerb
 *     walk    7.5   verge, the perimeter path, street trees
 *     yard   20.8   whichever of the three this stretch is
 *     gap     2.0
 *     lawn   22.3   the play area's sand, the forecourt, or trees
 *   campus front
 * ```
 *
 * The **lawn** band is whatever is left over, which is the one dimension here
 * that is not chosen — and it is checked rather than assumed (`SCHOOL_GROUNDS`
 * returns null if it ever comes out too thin to hold the play frame).
 *
 * ## The entrance is in the middle because the doors are
 *
 * The building's own entrance is at the middle of its length, which is the
 * middle of the block, so the middle yard is the drop-off and the lawn behind
 * it is paved right up to the doors. The car park and the buses are the two
 * ends, which is where a school puts them — nobody walks past a bus lane to get
 * to the front door, and nobody reverses out of a bay into one.
 *
 * ## One play area, on sand
 *
 * One, not two, and it stands on a **sand oval** rather than on the lawn: a
 * play frame on mown grass is a frame somebody left there, and every playground
 * that has ever been built has a surface under it. `playground` is the
 * amusement park's own part — frame, slide, see-saw — reused rather than
 * reinvented, which is the rule the whole island is planted by. The oval is
 * sized from the frame rather than typed, so it contains it whatever the frame
 * is scaled to.
 */
export const GROUNDS = {
  /** Grass behind the playing fields, to the dock road's kerb. */
  back: 8,
  /** The avenue's kerb to the front of the yards: verge, path, street trees. */
  walk: 7.5,
  /**
   * The plaza on the building's centreline: how wide, and the grass either side.
   *
   * This is the site's one axis. The gateway stands on the end of it at the
   * avenue and the school's doors are at the other, and everything else —
   * the car park, the buses, the play area, the court — is arranged about it
   * rather than strung along the front in a line.
   *
   * 24 m, which is the gateway's own span and a bit: narrower and the arch
   * stands on a path, wider and it is a car park with nothing parked on it.
   */
  plaza: 24,
  plazaGap: 9,
  /** Grass between a yard's back edge and the lawn. */
  lawnGap: 3,
  /** The gap in the car park's near row that you turn in through. */
  mouth: 9,

  /** A bay's depth, the lane two rows of them share, and the pitch along a row. */
  bay: 5.4,
  aisle: 7,
  bayPitch: 2.7,
  /** Margin from a yard's own edge to the first bay. */
  yardMargin: 1.5,
  /** A kerbed, planted island every this many bays. */
  islandEvery: 9,

  /**
   * The bus stand: how wide the buses' strip is, and the pitch they lie at.
   *
   * A `school_bus` is 8.3 m long and 2.7 wide (`vehicleCatalogue`), so 4.2 m of
   * strip is the bus and a door's width of hardstanding beside it, and 11 m of
   * pitch is the bus and enough behind it to pull out without shunting. They
   * lie ALONG the stand rather than nosing in: a stand deep enough to take an
   * 8.3 m bus nose-in would be deeper than the car park.
   */
  busLane: 4.2,
  busPitch: 11,

  /** Width of a drive in off the avenue, and of the drop-off lane. */
  drive: 9,
  dropLane: 7,
  /**
   * The paving that joins everything up.
   *
   * The plaza ran from the gateway to the edge of the campus deck and stopped
   * there, which left sixteen metres of the school's own ground between the end
   * of the paving and its front door — so the floor arrived near the gate and
   * nowhere else, and the car park, the bus yard and the workshop each stood on
   * their own island of surface in the middle of a lawn.
   *
   * Two things fix it. The plaza now runs **to the building's front wall**,
   * which is found from the school's own measured colliders rather than typed
   * (`BUILDING_FRONT`), and a `link` strip runs the length of the site along the
   * front of the lawn, overlapping the yards behind and throwing a spur to the
   * play area and to the workshop. Every piece of ground anybody stands on is
   * now reachable on paving.
   *
   * The link is deliberately narrower than the plaza and set against the yards
   * rather than out in the grass: a wide strip down the middle of a lawn is the
   * road this site spent three rounds getting rid of.
   */
  link: 3.6,
  spur: 3,
  /**
   * How far the paving stands over the campus's own deck where they overlap.
   *
   * 15 mm. Both are at `ROAD_TOP` over the crown, which is two coplanar
   * surfaces and therefore z-fighting; lifting one of them by less than a
   * paving joint settles it and nothing can see the step.
   */
  plazaLift: 0.015,

  /** The tree avenue down the plaza: how far off its centre, and the pitch. */
  plazaTrees: { offset: 9.5, pitch: 11 },
  /** The flagpole at the head of the plaza. */
  flag: {
    height: 11,
    radius: 0.13,
    cloth: [2.6, 1.6] as const,
    back: 6,
    /** Two octagonal steps under it: a pole out of bare paving is a pole. */
    base: { radius: 1.35, inset: 0.3, step: 0.24 },
  },

  /**
   * The boundary wall along the avenue, either side of the gateway.
   *
   * Low, and stone, and the same stone as the gate. It is not a fence — the
   * user ruled those out and they were right, a fence round a school is a
   * compound — it is the thing a gate is a gap IN, without which the arch
   * stands on a lawn with grass running past it on both sides. It stops where
   * each yard starts, because a wall across a car park entrance is a wall.
   */
  wall: { height: 0.95, thickness: 0.5, coping: 0.12, copingOver: 0.09 },

  /**
   * The bed along the building's own frontage, and what is planted in it.
   *
   * It was a continuous line of low bushes at 5.5 m, and it read as exactly
   * that: a row of green blobs stuck to a wall. A façade does not have a hedge
   * along it, it has a BED — a kerbed strip of planting with clumps in it and
   * bare ground between them — so this is the strip, and `clumpPitch` is how
   * far apart the clumps in it actually stand, which is far enough that each is
   * a shrub rather than a link in a chain.
   */
  bed: { depth: 2.4, kerb: 0.1, clumpPitch: 11, clumpSpread: 2.6 },

  /**
   * The workshop block, and the four attempts that came before it.
   *
   * A school of this size is never one building. `parade.glb` gave a black
   * glass tower and a teal one (`blockMid`), then a shopfront with a canopy
   * (`shopUnit`) — that kit is shops, offices and hotels, and you can see it in
   * the file, where its `block*` and `office*` parts are one masonry primitive
   * plus four identical curtain-wall faces. Drawing them instead, in the
   * school's own sampled colours, got boxes. The European pack's townhouses
   * (`prepare-euro.mjs`, which is still here and still works) came closest and
   * were still houses.
   *
   * What is built is the one the user picked: the vacuum tube factory, as the
   * school's **workshop** — the tech and engineering block. Which is not a
   * stretch. A shed with a saw-tooth roof and a silo on the end of it is what a
   * school's workshop actually looks like, it is the one building type on a
   * campus that is allowed to be industrial, and at 57 m by 36 it is a real
   * second building rather than an outhouse.
   *
   * It stands in the east lawn, where the basketball court was: the court was
   * 28 m by 15 and there is not room for both, and of the two a building is
   * what the site was short of.
   */
  workshop: {
    /** Grass it keeps to the plaza on one side and the site's end on the other. */
    clear: 2,
    /** Which way round: a quarter turn puts its long side down the island. */
    turn: Math.PI / 2,
  },

  annexeBack: 2.5,
  annexeClear: 1,

  /**
   * How far the sand and the court are nudged off their own zone's centre.
   *
   * Both WEST, and by different amounts, and the reason is the annexes. The
   * lawn's three gaps came out at 18.4 m, 21.3 and 12.3 against blocks that
   * want 19.1, 19.1 and 12.3 — so two of the three were refused by about half a
   * metre, and the third by four centimetres. Four centimetres is not a
   * clearance failing, it is a layout that has not been composed.
   *
   * Moving the sand 2.5 m west and the court 1.5 m west makes the three gaps
   * 20.9, 19.8 and 13.8, and every block fits with its metre of grass. Neither
   * piece cares where it is to that precision — a play area is wherever the
   * play area is — and the alternative was to shave the clearance until the
   * arithmetic passed, which is an assertion pretending to be a margin.
   */
  sandShift: -2.5,


  /**
   * The gate on the station avenue, at the middle of the frontage.
   *
   * A school has a front door to its GROUNDS as well as to its building, and
   * without one the site is three yards and a hedge-less boundary that anybody
   * walks over anywhere. Two piers, a header across them and the school's name
   * on it, on the line of the entrance walk — with railings running each way
   * along the boundary so the gate is the way in rather than a decoration
   * standing on a lawn.
   */
  gate: {
    /**
     * A gateway, and its proportions.
     *
     * It started as two head-height posts with a beam across, which is a garden
     * gate: from the avenue you could not tell it was there, and what it read
     * as was something at the end of a drive. This is the other kind — the one
     * an old school has, an ARCH: two piers with plinths and cornices, a
     * semicircular ring between them, an entablature over that with the name on
     * it, and a finial at each end.
     *
     * The numbers are a stack, bottom to top, and every one of them is a height
     * rather than a size so they can be read down the list. A semicircular arch
     * rises half its span, so the crown is `springing + opening / 2` and
     * everything above it follows from that rather than being typed twice.
     */
    opening: 18,
    pier: 3.4,
    /** The plinth the pier stands on, and how far it oversails the shaft. */
    plinth: 1,
    plinthOver: 0.35,
    /** The cornice under the arch's springing, and its oversail. */
    springing: 5,
    cornice: 0.55,
    corniceOver: 0.3,
    /** The arch ring: how thick, and how deep through the gateway. */
    ringDepth: 0.9,
    ringWidth: 0.72,
    ringSegments: 18,
    /** The entablature over the arch, and the board that stands on it. */
    entablature: 0.9,
    entablatureOver: 0.45,
    board: 1.4,
    /** A finial at each end of the entablature. */
    finial: 1.6,
  },
  /**
   * The entrance walk is the whole gateway's width, not a footpath's.
   *
   * A 16 m arch standing on a 3 m path is an arch in a field. Paved to its full
   * span, the piers stand on the ground they belong to and the approach reads
   * as the way in rather than as a shortcut over the grass.
   */
  entranceWalk: 21,

  /**
   * The play frame and its sand.
   *
   * `playground` is 24 m by 16.9 at its own size, which is a fairground's idea
   * of one. 0.85 is a school's: 20.4 by 14.4, which leaves the oval room to be
   * an oval inside a 22 m lawn. `sandMargin` is how far the sand reaches past
   * the frame's own corners — the oval is SOLVED to contain them, so this is
   * the one number about it that is chosen.
   */
  playScale: 0.85,
  sandMargin: 3.4,

  /** The narrowest lawn the layout will accept before it refuses to build. */
  lawnMin: 18,

  /** Street trees along the frontage, and lamp columns down the car park. */
  treePitch: 13,
  lampPitch: 26,
  /** Specimen trees and benches on the lawn. */
  greenTreePitch: 18,
  benchPitch: 24,
  /** How full the car park is. A full one reads as a showroom. */
  occupancy: 0.55,
} as const;

/**
 * The campus, placed: where its middle is, how far round, and how big.
 *
 * The scale is **solved from the block** rather than written down, so the
 * school keeps its verge if the grid is ever re-spaced — and is capped at 1,
 * because a block that grew would give a wider verge and not a bigger school.
 *
 * Note which of the model's axes go where. A quarter turn puts the model's X —
 * its long axis, the one the building runs down — onto the island's `along`,
 * and its Z onto `across`. So the width available to `size[2]` is the block's
 * across, and the depth available to `size[0]` is its along.
 */
export const SCHOOL_SITE = (() => {
  if (!STATION_SITE) return null;
  const width = SCHOOL_BLOCK.acrossTo - SCHOOL_BLOCK.acrossFrom;
  const length = SCHOOL_BLOCK.alongTo - SCHOOL_BLOCK.alongFrom;
  const scale = Math.min(
    1,
    (width - VERGE * 2) / SCHOOL.size[2],
    (length - VERGE * 2) / SCHOOL.size[0],
  );
  if (scale <= 0) return null;
  const depth = SCHOOL.size[2] * scale;
  const run = SCHOOL.size[0] * scale;
  // Pushed to the back: the fields stand `GROUNDS.back` off the dock road and
  // everything left over is frontage. See `GROUNDS`.
  const back = SCHOOL_BLOCK.acrossTo - GROUNDS.back;
  return {
    /** The middle of the campus, which is NOT the middle of the block. */
    across: back - depth / 2,
    along: (SCHOOL_BLOCK.alongFrom + SCHOOL_BLOCK.alongTo) / 2,
    scale,
    /** The campus's own edges, which the grounds are laid up to. */
    front: back - depth,
    back,
    alongFrom: (SCHOOL_BLOCK.alongFrom + SCHOOL_BLOCK.alongTo) / 2 - run / 2,
    alongTo: (SCHOOL_BLOCK.alongFrom + SCHOOL_BLOCK.alongTo) / 2 + run / 2,
    /**
     * The quarter turn, and its sign.
     *
     * In the station's frame the group's local X is `across` and its local Z is
     * `along`. A turn of θ about Y sends the model's +Z to
     * (sin θ, −cos θ) in (across, along), so θ = −π/2 sends the front to
     * −across — the station avenue, the town side — and the model's +X to
     * +along. `front` is +1 out of the prepare script; if it ever measures the
     * other way the turn flips with it rather than the school turning its back
     * on the street.
     */
    turn: (schoolData.front >= 0 ? -1 : 1) * (Math.PI / 2),
    /** What the verge came out as, along the island. Reported. */
    verge: (length - run) / 2,
    /** The block, for anything that wants to know what was given up for it. */
    block: [width, length] as [number, number],
  };
})();

/**
 * The grounds, solved: the footway, the lot with its rows and islands, the
 * drives in off the avenue, and the apron between the lot and the campus.
 *
 * All of it in the station's own (across, along), like everything else on this
 * island, and all of it derived from `GROUNDS` and the campus's own front edge
 * rather than written down — so a change to the block, the verge or the scale
 * moves the car park with the school instead of leaving it in the road.
 *
 * Null when the arithmetic does not leave an apron worth the name. That is a
 * real possibility rather than a formality: the frontage is whatever the block
 * has left after the campus takes its depth, and the campus's depth is solved
 * against the block too.
 */
export const SCHOOL_GROUNDS = (() => {
  const site = SCHOOL_SITE;
  if (!site) return null;

  const kerb = SCHOOL_BLOCK.acrossFrom;
  const alongFrom = site.alongFrom;
  const alongTo = site.alongTo;
  const middle = (alongFrom + alongTo) / 2;

  /*
   * Across: the yards stand ON the avenue, and the lawn is everything behind.
   *
   * There is no verge band and no drives. Every earlier version put the yards a
   * few metres back and ran a tarmac strip out to the street for each one, and
   * those strips are what read as ROADS THROUGH THE SCHOOL from the air — four
   * of them, plus a ring round the site and two spurs across it. A car park
   * whose own edge is the kerb needs no drive: you turn off the avenue into it.
   */
  const yardTo = kerb + GROUNDS.bay * 2 + GROUNDS.aisle + GROUNDS.yardMargin * 2;
  const lawnFrom = yardTo + GROUNDS.lawnGap;
  const lawnTo = site.front;
  if (lawnTo - lawnFrom < GROUNDS.lawnMin) return null;

  /*
   * Along: the plaza in the middle, a yard either side of it.
   *
   * The plaza is the only thing on this site whose position is not negotiable —
   * it is on the building's own centreline, because that is where the doors
   * are, and the gateway stands on the end of it at the avenue. Everything else
   * is arranged about it. The yards take what is left after a margin of grass.
   */
  /*
   * The plaza runs past the campus's own edge and up to the building's wall,
   * so the floor arrives at the door rather than at the boundary. See
   * `BUILDING_FACE` and `GROUNDS.link`.
   */
  const doorstep = site.across - buildingFace(GROUNDS.plaza, site.scale) * site.scale;
  const plaza = {
    acrossFrom: kerb, acrossTo: Math.max(lawnTo, doorstep),
    alongFrom: middle - GROUNDS.plaza / 2, alongTo: middle + GROUNDS.plaza / 2,
  };
  const park = { from: alongFrom, to: plaza.alongFrom - GROUNDS.plazaGap };
  const bus = { from: plaza.alongTo + GROUNDS.plazaGap, to: alongTo };

  /*
   * The car park: two rows nose to nose across one lane, its south edge on the
   * avenue, with a gap in the near row for the way in.
   *
   * The gap is a missing bay and not a slab of tarmac laid across the grass,
   * which is the whole difference between a car park you turn into and a road
   * through a school.
   */
  const rows = [
    { from: kerb + GROUNDS.yardMargin, faces: 1 },
    { from: yardTo - GROUNDS.yardMargin - GROUNDS.bay, faces: -1 },
  ].map((r) => ({ ...r, to: r.from + GROUNDS.bay }));
  const mouth = (park.from + park.to) / 2;
  const bays: Array<{ across: number; along: number; turn: number }> = [];
  const islands: Array<{ acrossFrom: number; acrossTo: number; along: number }> = [];
  const marks: Array<{ acrossFrom: number; acrossTo: number; along: number }> = [];
  const count = Math.floor((park.to - park.from - 2) / GROUNDS.bayPitch);
  const first = park.from + ((park.to - park.from) - count * GROUNDS.bayPitch) / 2;
  for (const row of rows) {
    for (let i = 0; i < count; i++) {
      const along = first + (i + 0.5) * GROUNDS.bayPitch;
      // The near row opens for the way in; the far row is past the lane.
      if (row.faces > 0 && Math.abs(along - mouth) < GROUNDS.mouth / 2) continue;
      if (i % GROUNDS.islandEvery === GROUNDS.islandEvery - 1) {
        islands.push({ acrossFrom: row.from, acrossTo: row.to, along });
        continue;
      }
      bays.push({
        across: (row.from + row.to) / 2,
        along,
        // Nose in: the car points across its bay, into the lane.
        turn: row.faces > 0 ? Math.PI / 2 : -Math.PI / 2,
      });
      marks.push({
        acrossFrom: row.from + 0.5,
        acrossTo: row.to - 0.5,
        along: along - GROUNDS.bayPitch / 2,
      });
    }
  }
  const carPark = {
    acrossFrom: kerb, acrossTo: yardTo, alongFrom: park.from, alongTo: park.to,
  };
  /** The lane down the middle of it, for the lamp columns. */
  const aisle = kerb + GROUNDS.yardMargin + GROUNDS.bay + GROUNDS.aisle / 2;

  /*
   * The bus yard: an apron on the avenue with the buses drawn up along the back
   * of it.
   *
   * Back of it, not front: a bus standing against the street would be a wall
   * along the avenue, and what a school's bus apron looks like from the road is
   * an empty pull-in with the buses behind.
   */
  const busYard = {
    acrossFrom: kerb, acrossTo: yardTo - GROUNDS.yardMargin,
    alongFrom: bus.from, alongTo: bus.to,
  };
  const stand = {
    from: busYard.acrossTo - GROUNDS.busLane - GROUNDS.yardMargin,
    to: busYard.acrossTo - GROUNDS.yardMargin,
  };
  const buses: Array<{ across: number; along: number; turn: number }> = [];
  const busCount = Math.max(1, Math.floor((bus.to - bus.from) / GROUNDS.busPitch));
  const busFirst = bus.from + ((bus.to - bus.from) - busCount * GROUNDS.busPitch) / 2;
  for (let i = 0; i < busCount; i++) {
    buses.push({
      across: (stand.from + stand.to) / 2,
      along: busFirst + (i + 0.5) * GROUNDS.busPitch,
      turn: 0,
    });
  }
  /*
   * The appliance, at the head of the line: a school keeps one where it can get
   * out first, so it takes the end pitch rather than standing somewhere of its
   * own. Kept apart from `buses` because it draws from a different list.
   */
  const appliance = buses.length > 1 ? [buses.shift()!] : [];

  /** Where the gateway stands: on the block's kerb, on the plaza's axis. */
  const gate = { along: middle, across: kerb + GROUNDS.gate.pier / 2 };

  /*
   * The play area, in the lawn behind the car park, on a sand oval.
   *
   * The oval is SOLVED to contain the frame rather than typed. Across is the
   * binding axis — the lawn has to keep grass round the sand — so that radius
   * is taken first and the other is solved to put the frame's corner ON the
   * rim: an ellipse through (a, b) with a known semi-axis `rb` has
   * `ra = a / sqrt(1 - (b / rb)^2)`. So the sand follows the frame if the frame
   * is ever rescaled, instead of being a number that used to be right.
   */
  const frame = {
    along: PLAY_SIZE[0] * GROUNDS.playScale, across: PLAY_SIZE[2] * GROUNDS.playScale,
  };
  const lawnMid = (lawnFrom + lawnTo) / 2;
  const radiusAcross = Math.min(
    (frame.across / 2) * Math.SQRT2 + GROUNDS.sandMargin,
    (lawnTo - lawnFrom) / 2 - GROUNDS.sandMargin,
  );
  const room = 1 - (frame.across / 2 / radiusAcross) ** 2;
  if (room <= 0.02) return null;
  const sand = {
    across: lawnMid,
    along: (park.from + park.to) / 2 + GROUNDS.sandShift,
    radiusAcross,
    radiusAlong: (frame.along / 2) / Math.sqrt(room) + GROUNDS.sandMargin,
  };
  const play = { across: sand.across, along: sand.along, scale: GROUNDS.playScale };

  /*
   * The boundary wall: two runs, from each side of the gateway out to the yard
   * that ends it. Nothing else on the frontage is a wall.
   */
  const gateHalf = GROUNDS.gate.opening / 2 + GROUNDS.gate.pier;
  const walls = [
    { alongFrom: park.to, alongTo: middle - gateHalf },
    { alongFrom: middle + gateHalf, alongTo: bus.from },
  ].filter((w) => w.alongTo - w.alongFrom > 1);

  /**
   * The stretches of lawn left between the sand, the plaza and the court.
   *
   * Measured rather than typed, and kept even though nothing stands in them
   * yet: they are what a school building has to fit, and the shifts above
   * (`sandShift`, `courtShift`) exist to make them the sizes they are. See the
   * note on `GROUNDS.annexes`.
   */
  const gaps = {
    west: { from: sand.along + sand.radiusAlong, to: plaza.alongFrom },
    east: { from: plaza.alongTo, to: alongTo },
  };

  /*
   * The workshop, in the east lawn.
   *
   * Turned so its long side runs down the island, then **fitted**: the lawn is
   * 28.8 m deep and the block is 36.2, so it takes the largest scale that keeps
   * `workshop.clear` of grass on every side of it. That comes out around 0.74,
   * which also brings its 18.8 m down to about 14 — nearer the school's 11.8
   * than the full size would be, and the better proportion of the two.
   *
   * Solved rather than typed, so it follows the lawn if the lawn ever changes.
   */
  const workshop = (() => {
    const W = GROUNDS.workshop;
    const gap = { from: plaza.alongTo, to: alongTo };
    const across = W.turn ? WORKSHOP.size[2] : WORKSHOP.size[0];
    const along = W.turn ? WORKSHOP.size[0] : WORKSHOP.size[2];
    const scale = Math.min(
      1,
      (lawnTo - lawnFrom - W.clear * 2) / across,
      (gap.to - gap.from - W.clear * 2) / along,
    );
    if (scale <= 0) return null;
    return {
      across: lawnTo - GROUNDS.annexeBack - (across * scale) / 2,
      along: (gap.from + gap.to) / 2,
      turn: W.turn,
      scale,
      footprint: [across * scale, along * scale] as [number, number],
    };
  })();

  /*
   * The link, and the spurs off it.
   *
   * One strip down the front of the lawn, overlapping the yards behind it so
   * they are joined rather than adjacent, and a spur from it to the play area's
   * sand and to the workshop's door. With the plaza that makes every surface on
   * this site one connected floor.
   */
  const link = {
    acrossFrom: lawnFrom - GROUNDS.link,
    acrossTo: lawnFrom,
    alongFrom,
    alongTo,
  };
  const spurs = [
    { along: sand.along, acrossFrom: link.acrossTo, acrossTo: sand.across - sand.radiusAcross },
    ...(workshop ? [{
      along: workshop.along,
      acrossFrom: link.acrossTo,
      acrossTo: workshop.across - workshop.footprint[0] / 2,
    }] : []),
  ].filter((sp) => sp.acrossTo - sp.acrossFrom > 1);

  return {
    zones: { park, bus },
    gaps,
    workshop,
    link,
    spurs,
    walls,
    bands: { yardTo, lawnFrom, lawnTo },
    plaza,
    gate,
    carPark,
    rows,
    bays,
    islands,
    marks,
    aisle,
    busYard,
    stand,
    buses,
    appliance,
    sand,
    play,
    /** The lawn band, for anything that plants in what is left of it. */
    lawn: { acrossFrom: lawnFrom, acrossTo: lawnTo, alongFrom, alongTo },
  };
})();


export const SCHOOL_ENABLED = SCHOOL_SITE !== null;
