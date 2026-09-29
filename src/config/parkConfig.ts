import { SITE } from './airportConfig';

/**
 * Halcyon Pier: the amusement park on the airport island.
 *
 * It sits on the strip of island between the outer road and the cargo apron,
 * which is the first thing on your right as you come off the bridge — 160 m by
 * 144, and empty until now. Everything here is in the ISLAND's frame, the same
 * `along` / `across` that `airportConfig` uses, because the park is drawn
 * inside the island's group and shares its crown. `along` is +x down the
 * runway, `across` is +z toward the landside.
 *
 * ## What is imported and what is borrowed
 *
 * The five rides come from `park.glb` — see `prepare-park.mjs`, which is where
 * a 760,000-triangle roller coaster turns into something shippable. Everything
 * that makes it a *park* rather than a row of rides is borrowed from the city:
 * the shop parade, the trees, the copses and the street furniture are city
 * chunks placed a second time, exactly as the island's village and the
 * station's town are built. The fountain is the one thing drawn from nothing,
 * because a city that has no fountain cannot lend you one.
 *
 * ## The layout
 *
 * A single promenade from the gate on the outer road, running the depth of the
 * site, with a fountain plaza on it and the rides either side — the coaster
 * turned across the site on the east, the wheel and the smaller rides west. It
 * is arranged that way for one reason: the wheel and the coaster are what you
 * see from the bridge while you are still over the water, so they go where the
 * bridge points, and the promenade lines up with the gate so that the fountain
 * is dead ahead when you walk in.
 */

/** The site, as [alongFrom, alongTo, acrossFrom, acrossTo] in the island's frame. */
export const PARK = {
  /**
   * 220 x 144 m, grown WEST twice: from 160 when the circus and the
   * playground arrived, and from 196 for the show ground at the far end.
   *
   * It went east first and that was wrong: the east end is the island's
   * coast, so the park was reaching out along a narrowing spit toward the
   * shore with the sea on three sides of it, away from everything.
   *
   * West it joins the rest of the island instead, and what was in the way was
   * only ever airport housekeeping: the landside road ran on to along 230
   * carrying nothing — its traffic turns at 151 — and the airport's own tree
   * scatter was planting straight through the site. The road is trimmed to
   * 198 and the trees now stop at the hedge, which leaves the park a clean
   * edge at 200 and 36 m of new ground.
   *
   * 171 is the west edge now, and 200 was never the limit it was written up
   * as. What actually stood in the way was the landside road, which ran on to
   * along 198 at across 150..159 — thirty metres past its own last junction,
   * carrying nothing. It ends on that junction now (see `PAVING.road`), and
   * the ground it was sitting on is the show plaza's.
   *
   * ## A rectangle, and it took the forecourt to make it one
   *
   * 262 x 144 m, along 134..396 and across 104..248, hedged the whole way
   * round with one opening.
   *
   * It was briefly an L. The notch was the terminal's forecourt, which ran
   * thirty metres east of the end of the terminal and sat across the band the
   * park's south-west corner needed — and the reason it could not be cut back
   * was that a service route turned on it. That route has no vehicles on it
   * now, so the apron came back to its building (see `PAVING.forecourt`), and
   * the notch went with it.
   *
   * 134 is the west edge and the entrance road sets it, not the terminal: the
   * road's east kerb is at 129.48 and the hedge is 0.9 m deep, so there are
   * 3.6 m of grass between the carriageway and the fairground. Moving the
   * terminal would not shift this line by a metre — the terminal ends at 120
   * and is clear already, and what holds the entrance road where it is is the
   * car park deck behind it.
   */
  bounds: [134, 396, 104, 248] as const,
  /**
   * The boundary, anticlockwise, as the hedge walks it.
   *
   * A rectangle again, but kept as a ring rather than folded back into four
   * sides of `bounds`: the park has been an L once and the walk that handles
   * one is no harder to read than the walk that cannot.
   */
  outline: [
    [134, 104], [396, 104], [396, 248], [134, 248],
  ] as ReadonlyArray<readonly [number, number]>,
  /**
   * The ways in, and there are two of them now.
   *
   * Each is an opening in one EDGE of the outline, so it carries which edge it
   * is in rather than leaving `parkBoundaryRuns` to work it out from a
   * coordinate that two edges share. `edge` is the axis the edge runs at a
   * constant value of: 'across' is the north edge, 'along' is the west one.
   *
   * ## The main gate
   *
   * On the outer road, and it MUST agree with `PARK_PAVING.entryApron`: this
   * is where the hedge's gap comes from and the apron is where the tiles are.
   * They drifted apart once — the gate stayed at 306 +/- 11 long after the
   * entrance had been widened and recentred to 288 +/- 23, so the hedge ran to
   * 293.6, straight across the threshold, which is exactly what it looked
   * like. The component checks the two still match and says so if they do not.
   *
   * ## The west gate
   *
   * On the airport's crossroads, which is the whole reason it exists. The way
   * into the airfield is a straight line from the outer road through a
   * four-armed junction, and the junction's east arm pointed at a hedge. Now
   * it points at a gate: you arrive at the crossroads and can go straight on
   * to the aeroplanes, right to the terminal, or left into the fairground.
   *
   * Centred on 154.5, which is the landside road's own centreline, so the
   * opening is square to the arm that arrives at it. 22 m against the
   * junction's 19 m carriageway, so it flares slightly rather than pinching.
   */
  gates: [
    { edge: 'across', at: 248, centre: 288, half: 23, label: 'main gate' },
    { edge: 'along', at: 134, centre: 154.5, half: 11, label: 'west gate' },
  ] as ReadonlyArray<{
    readonly edge: 'along' | 'across';
    readonly at: number; readonly centre: number; readonly half: number;
    readonly label: string;
  }>,
  /** Everything is drawn this far over the island crown, as the paving is. */
  ground: SITE.ground,
} as const;

/**
 * The paved ground, as [alongFrom, alongTo, acrossFrom, acrossTo].
 *
 * Rectangles that tile and never overlap, for the reason the airfield's do:
 * two coplanar surfaces at one height is a z-fight the length of whatever they
 * share. The promenade and the cross walk meet at the plaza, which is drawn as
 * a disc and is the only piece here that is not a box.
 */
export const PARK_PAVING = {
  /* ------------------------------------------------------------ the walks */
  /**
   * The promenade: 26 m wide, from the gate south to the big top's door.
   * It is exactly the gate's own opening — `PARK.gate` is 26 m at along 288 —
   * so the gap in the hedge and this rectangle are the same 26 m by
   * construction rather than by agreement.
   */
  promenade: [275, 301, 146, 240] as const,
  /**
   * The threshold: 46 m of tiles from the road to the head of the promenade.
   *
   * The entrance used to be the promenade's own 26 m running straight into
   * the kerb, which from the road read as a footpath rather than as a way
   * into anywhere. This flares it — wider than the walk it feeds, reaching
   * the road's own edge at across 252 — and the gap in the hedge is opened
   * to match, so what you see driving past is an opening and not a slot.
   */
  entryApron: [265, 311, 240, 252] as const,
  /** The two pieces that keep the paving unbroken either side of the flare. */
  nwFill: [253, 265, 240, 248] as const,
  neFill: [311, 340, 240, 248] as const,
  /** The cross walk, in two arms with the promenade as their junction. */
  crossWest: [207, 275, 190, 210] as const,
  crossEast: [301, 340, 190, 210] as const,

  /* ------------------------------------------------------- hard standing --
   *
   * A ride standing on mown grass is the thing that made this park read as
   * models dropped on a lawn, and no amount of realigning the walks was ever
   * going to fix it: the walks were the only paving there was, so everything
   * that was not a walk was a field. Every ride and every building now stands
   * on its own apron, sized to its footprint with about four metres of margin
   * — measured, not eyed: the check is that a grid over each object's
   * footprint lands on paving at every sample.
   *
   * The aprons tile with the walks and with each other, never overlapping,
   * and every one of them touches the network, so there is a paved route from
   * the gate to the door of everything. That is what the playground did not
   * have; you had to cross forty metres of grass to reach it.
   *
   * Grass is 27% of the site and it is all at the EDGES — the boundary band
   * the hedge stands in, and the gaps between aprons. Which is where grass
   * belongs in a fairground: round it, not under it.
   */
  bigTopApron: [268.7, 301, 108, 146] as const,
  playYard: [216, 248, 128, 150.4] as const,
  playLink: [222, 240, 150.4, 162.3] as const,
  pondApron: [248, 268.7, 127.4, 152.6] as const,
  pondLink: [252, 262, 152.6, 163.8] as const,
  dropApron: [207, 231.2, 162.3, 190] as const,
  swingsApron: [238.8, 261.2, 163.8, 190] as const,
  wheelApron: [208.1, 253, 210, 248] as const,
  shopAApron: [253, 275, 210, 240] as const,
  pavilionApron: [301, 340, 210, 240] as const,
  southEast: [301, 339.7, 112, 190] as const,
  /**
   * The speedway's ground: the whole west end of the park. See `SPEEDWAY`.
   *
   * 32 x 100 m, which is every metre there is between the hedge on 171 and the
   * drop tower's apron on 204.8, and it is all one surface because what stands
   * on it is a circuit — a track wants continuous ground under it and its
   * verges, not a tile per object.
   *
   * The track itself is drawn 1 cm over this rather than cut out of it, the
   * way the pond is: a closed loop is not a rectangle and no amount of tiling
   * would have made it one.
   */
  speedwayGround: [173, 207, 143.5, 244] as const,
  /**
   * The circuit's southern half, which is the ground the park grew into.
   *
   * The track is no longer a dog-bone in a box — it runs out into the band
   * across 107..138 that ran the length of the park as mown grass, so the
   * ground under it has to follow.
   *
   * THREE rectangles rather than one, because the west gate's walk sits in the
   * middle of what would otherwise be a single slab. West of along 173 this
   * runs right up to that walk on 143.5, which is what the return leg needs —
   * it crests at across 139.4 on its way back to the pits, and a version that
   * stopped at 138 left eighteen samples of kerb hanging over grass. East of
   * 173 it stops at 138 and `speedwayGround` picks up from there.
   */
  speedwaySouth: [136, 173, 107, 143.5] as const,
  speedwayApron: [173, 207, 107, 143.5] as const,
  /**
   * The west gate's threshold and the walk in from it.
   *
   * It reaches OUT of the park, to along 129.48, which is the airport
   * crossroads' own east face — so the junction's east arm and this are the
   * same surface and you drive off one onto the other. `entryApron` does the
   * same thing at the main gate, where it runs out to the outer road's kerb;
   * a threshold that stops on the boundary leaves a strip of grass in the
   * gateway.
   *
   * Its across is exactly the gate's opening (143.5..165.5), and it runs east
   * to the speedway's ground, tiling with the paddock on 165.5 along the way.
   * So the west gate does not open into a field: it opens onto a walk that
   * goes somewhere, which is the circuit.
   */
  westApron: [129.48, 173, 143.5, 165.5] as const,
  /**
   * The circuit's western lobe, on the ground the pit row stood on.
   *
   * This was the paddock: six garages and a yard, 35 x 72 m of it. The circuit
   * took it — see `SPEEDWAY.points` — so the ground is track and verge now
   * rather than a yard with a building in it.
   *
   * It stops at across 165.5, which is the west gate's walk, and the walk is
   * why the west end needs three rectangles instead of one: the way in from
   * the airport crossroads runs straight through the middle of what would
   * otherwise be a single slab, and it is not allowed to be driven over.
   */
  speedwayWest: [136, 173, 165.5, 244] as const,
  /**
   * The coaster's ground. It is paved right across the ride rather than just
   * at the station, because 100 m of track on grass was the single worst
   * offender — and its own collider is measured at 4% solid, so what stands
   * on this is a lattice of supports, not a wall.
   */
  coasterYard: [340, 396, 128, 226] as const,
  /* The two southern rides, each on its own hard standing. */
  swansApron: [215.5, 240.5, 105.5, 128] as const,
  bounceApron: [248, 268.7, 106, 124] as const,
} as const;

/**
 * The hub, and the statue that stands in it.
 *
 * `FOUNTAIN` is what the plaza is still drawn around — the disc, the four
 * planters on `plazaRing`, the paths that meet here — and it keeps its name
 * because the fountain was here for a long time and every one of those
 * measurements was taken off it. What stands in the middle now is `STATUE`:
 * the cute panda with its bamboo, dropped in the repo and baked by
 * `prepare-panda.mjs`, on a low round plinth. A statue reads as *park* the
 * way a fountain did, and it is the thing the gate points at.
 */
export const FOUNTAIN = {
  /**
   * The hub, where the promenade crosses the cross walk. The disc is 20 m
   * against a 26 m walk, so it bulges seven metres onto the grass either
   * side — which is what makes it read as a plaza rather than as a wide bit.
   */
  along: 288,
  across: 200,
  /** The radius the plaza disc and the hub's clear zone are still measured from. */
  basin: 12,
} as const;

export const STATUE = {
  /** Where the panda stands: the hub's centre. */
  along: FOUNTAIN.along,
  across: FOUNTAIN.across,
  /**
   * Which way it faces: down the promenade toward the gate, which is −across.
   * The model's front is on +Z, so no turn is what points it that way — at π
   * it showed the gate its back.
   */
  turn: 0,
  /**
   * The plinth: a low stone disc, its radius and height. Just wider than
   * the statue's bamboo so nothing overhangs, and low enough to step onto.
   * It is also the statue's ONE collider, a cylinder, sized to the disc —
   * the fountain's was a 24 m box round a 12 m basin, and its four corners
   * were the invisible walls you hit on the plaza.
   */
  plinth: { radius: 2.4, height: 0.45 },
  colours: { stone: '#cfc9bd', edge: '#b9b2a4' },
} as const;

/**
 * The rides, and where they stand.
 *
 * Sizes are not here: they are measured at build time by `prepare-park.mjs`
 * and written to `parkModelData.json`, which is also where the colliders read
 * them from. Nothing in this file restates a number the model already knows.
 *
 * `turn` is radians about +Y in the island's frame, and the coaster's quarter
 * turn is the whole reason the layout works: 100 m long it would cross the
 * promenade, and turned across the site it fits the 144 m of depth with room
 * either end.
 */
/**
 * Where everything in the park stands. ONE place, because three tables need
 * it — `RIDES` draws them, `MOTION` turns their moving parts, and the
 * planting has to keep off them.
 *
 * ## The plan is an axis with the big top at the head of it
 *
 * The gate is on the road at across 252. From it the promenade runs SOUTH
 * down the middle of the site, through a round plaza with the fountain in
 * it, and ends 100 m later at the big top — which therefore faces back up
 * the walk, north, at the gate and at the road beyond it. The tent's entrance
 * is modelled on its +Z face (its sign is there, measured), so `turn: 0` is
 * what aims it, and standing it at the foot of the axis is what makes that
 * mean something. Before this it stood side-on in a back corner.
 *
 * ## The coaster sets the shape, again
 *
 * It is 100 x 55 m and there is no arrangement in which it is not the first
 * thing placed. Laid ACROSS the site it needs 100 of the 144 there are, and
 * the east end is the only place with both that and the 55 m of length — so
 * it takes the far east outright, and the cross walk runs east to meet it.
 * Everything else is laid in the 140 m that leaves.
 *
 * ## Which quarter each thing is in
 *
 *   SOUTH-WEST  the family corner: playground, pond, and the two spinning
 *               rides, all off the west cross walk
 *   NORTH-WEST  the wheel, which is the thing you see from the road, and a
 *               shop beside the gate
 *   NORTH-EAST  bumper cars, and the gate's other shop
 *   SOUTH-EAST  the arcade and a third shop, on the walk out to the coaster
 */
const AT = {
  /* --- the axis --- */
  circus: { along: 288, across: 130, turn: 0 },
  /* --- east: the coaster takes the whole end --- */
  coaster: { along: 368, across: 176, turn: Math.PI / 2 },
  /* --- south-west, the family corner --- */
  drop: { along: 218, across: 175, turn: 0 },
  swings: { along: 250, across: 175, turn: 0 },
  playground: { along: 232, across: 138, turn: 0 },
  pond: { along: 258, across: 140, turn: 0 },
  /* --- north-west --- */
  wheel: { along: 232, across: 228, turn: 0 },
  shopA: { along: 264, across: 228, turn: Math.PI / 2 },
  /* --- north-east --- */
  pavilion: { along: 323, across: 231, turn: 0 },
  /* --- the south edge, which ran empty the length of the park --- */
  /*
   * Two rides along the bottom, and the reason they are both there is that
   * the band across 104..140 was the last open ground in the park — everything
   * built so far sits in the middle and the north, and the southern hedge had
   * a hundred and fifty metres of mown grass behind it.
   *
   * `swans` is a roundabout and wants ground nothing else does — a circle,
   * with room to walk round all of it. It was 25 m across and stood south of
   * the speedway, and the circuit wanted that ground when it stopped being a
   * dog-bone and went out into the southern band. So it is 18 m now and sits
   * between the playground and the bounce house, which is the one pocket in
   * the south band deep enough for it: 23 m between the hedge and the
   * playground's yard, against 18 plus a margin.
   *
   * Re-scaled rather than squeezed. A 25 m ride with a 2 m margin is a ride
   * you cannot walk round; an 18 m one with four is a ride. The model is the
   * same and `prepare-park.mjs` simply asks it for a smaller number.
   *
   * `bounce` goes between the pond and the big top, which is where the
   * families already are.
   */
  swans: { along: 228, across: 116.5, turn: 0 },
  bounce: { along: 259, across: 115, turn: 0 },
  /* --- south-east, the walk out to the coaster --- */
  arcade: { along: 320, across: 140, turn: 0 },
  shopB: { along: 320, across: 173, turn: Math.PI / 2 },
} as const;

export const RIDES = [
  { part: 'coaster', ...AT.coaster, label: 'coaster' },
  { part: 'wheelBase', ...AT.wheel, label: 'wheel base' },
  { part: 'dropTower', ...AT.drop, label: 'drop tower' },
  { part: 'swingsBase', ...AT.swings, label: 'swings' },
  { part: 'pavilion', ...AT.pavilion, label: 'bumper cars' },
  { part: 'circus', ...AT.circus, label: 'big top' },
  { part: 'playground', ...AT.playground, label: 'playground' },
  { part: 'swans', ...AT.swans, label: 'swan roundabout' },
  { part: 'bounce', ...AT.bounce, label: 'bounce house' },
] as const;

/**
 * The pieces that move, and how.
 *
 * Three of the five rides have something that turns or falls, and all three
 * are cheap: a wheel is a rotation about Z, a carousel is a rotation about Y,
 * and a drop tower is a position on a line. None of them needs a rig, an
 * animation clip or a physics body, and between them they are the difference
 * between a park and a photograph of one.
 */
export const MOTION = {
  /**
   * The wheel. Where the axle is does NOT appear here: it is measured off the
   * A-frame's apex at build time and written to `parkModelData.json`, because
   * the value guessed here was 23.2 m and the real one is 27.5 — four metres
   * low and 1.7 m out in Z, which hung the rim in front of the towers that
   * were supposed to be holding it up.
   */
  wheel: { ...AT.wheel, rate: 0.085 },
  /** The swing carousel's top, about its own axis. The base does not move. */
  swings: { ...AT.swings, rate: 0.55 },
  /**
   * The swan roundabout, whole, about its own axis.
   *
   * Whole and not top-and-base, which is the difference from the carousel
   * above: that ride arrives as two pieces because turning its foundation with
   * it was visibly wrong, and this one arrives as a hundred and twenty-seven
   * nodes with no seam worth finding between platform and plinth. Its steps go
   * round with it, which on a swan roundabout is what they do.
   *
   * Slower than the carousel — 0.22 against 0.55 — because it is twice the
   * diameter, and a rim speed that reads as a fairground ride on an 11 m
   * carousel reads as a hazard on a 25 m one.
   */
  swans: { ...AT.swans, rate: 0.22 },
  /*
   * There is no swing claw here.
   *
   * It stood 35 m tall in the west pocket for about an hour. What sank it was
   * that it could not be made to work: a claw is two motions at once — the
   * gondola spinning while the arm swings as a pendulum — and the export could
   * express neither. It arrives grouped by MATERIAL rather than by object, so
   * every node in it spans the whole ride and there is nothing to turn; and
   * welded at a quarter-unit grid it comes back as ONE connected shell of
   * 185,000 triangles running the full height, so mast and arm are the same
   * geometry and anything that swung it would lift its own footings off the
   * apron.
   *
   * It got a yaw instead, which is half the motion, and half the motion on a
   * pendulum ride reads as a ride that is broken rather than a ride that is
   * running. A still fairground ride is scenery; a wrongly-moving one is worse
   * than scenery. So it went, and the pocket is grass again.
   *
   * `swing_claw_ride.glb` is still in the repo. Nothing here reads it.
   */
  /**
   * The drop tower's gondola: the two heights it runs between and the shape of
   * the cycle. It climbs slowly, waits at the top, falls, and waits at the
   * bottom — which is four numbers and reads as the real thing because the
   * asymmetry IS the ride. A sine wave up and down would read as a lift.
   */
  drop: {
    ...AT.drop,
    /**
     * The travel, measured from the tower's own boarding deck rather than
     * from the ground.
     *
     * `low` was 3.4, which sounds like "just above the platform" and is not:
     * the gondola is centred on its own middle and is 4.5 m tall, so at 3.4 m
     * its floor was at 1.15 — a metre INSIDE the deck it is supposed to be
     * sitting on. It is read off the measured deck now and rests on it.
     *
     * `high` was 24 and had the same shape of error at the other end. Sliced
     * by height, the tower is a slim 4.0 x 3.1 m mast from 2 m to 19, and then
     * a headframe of 9.0 x 7.6 from 20 to 25 — so a gondola whose roof reaches
     * 26.25 m was being driven up through the crown. 16.5 puts that roof at
     * 18.75, which is just under it, which is where a drop tower parks.
     */
    high: 16.5,
    climb: 9,
    hold: 2.5,
    fall: 1.6,
    rest: 3,
  },
  /**
   * The coaster's three trains, which are not animated here at all.
   *
   * They run the model's own 45-second clip, sampled at 20 fps into
   * `parkModelData.json` by `prepare-park.mjs` — 343 m of circuit between 0.8
   * and 35 m up, which is the track the modeller actually drew the train
   * round. Nothing in this file could describe that better than the clip does,
   * so the only numbers here are which ride it belongs to and how fast to play
   * it. `rate` 1 is the clip's own speed.
   */
  coaster: {
    ...AT.coaster,
    rate: 1,
    /**
     * Cars per train, and how many keys apart they ride.
     *
     * The clip drives ONE car — the modeller's `Dummy` holds a single body,
     * its seats and two lap bars — and one 1.9 m car on a 100 m ride is a
     * speck you cannot find from anywhere the whole coaster is in frame. A
     * train is four of them nose to tail, which is the same table sampled four
     * times at a fixed offset, so they follow each other exactly rather than
     * approximately.
     *
     * The cars trail the head by a fixed DISTANCE, not a fixed number of keys,
     * and that distinction is the whole of it. The clip's speed varies the way
     * a coaster's does — it crawls out of the station and hits the bottom of
     * the drop flat out — so keys are bunched where it is slow and strung out
     * where it is fast. Offsetting by keys gives a train whose cars sit on top
     * of each other at the station and yards apart on the drop. Measured at
     * the station a five-key offset was 1.36 m; the same offset on the drop
     * would be several times that.
     *
     * 1.9 m is the length of a car, so the cars run nose to tail.
     */
    cars: 4,
    carLength: 1.9,
  },
  /**
   * The bumper cars, circling under their pavilion — ON its floor.
   *
   * The floor is 2.25 m up, on a platform that reaches the ground, and the
   * cars were riding at 0: under the deck, inside the structure, invisible.
   * The height is not written here either — `prepare-park.mjs` measures the
   * pavilion's deck and the component reads it.
   */
  bumpers: {
    ...AT.pavilion,
    radius: 8.5,
    rate: 0.42,
    /** A yaw added to the tangent, for whichever way the model faces. */
    spin: 0,
    cars: [
      { part: 'bumperA', phase: 0, lane: 1 },
      { part: 'bumperB', phase: 0.38, lane: 0.72 },
      { part: 'bumperA', phase: 0.66, lane: 1.18 },
      { part: 'bumperB', phase: 0.85, lane: 0.55 },
    ],
  },
} as const;

/*
 * NO buildings in the park.
 *
 * There was one: `deco_Building_-4_-1` stood on end along the parade walk, a
 * shop parade borrowed from the same city cell the island's village is built
 * from. Borrowed is what it looked like — a terrace of houses inside a
 * fairground — so it is gone, and the parade walk is a path through planting
 * now. `scatter()` fills that ground by itself, because the only thing that
 * was keeping trees off it was the parade.
 */

/**
 * The boundary, and the one way in.
 *
 * A park with rides in it and no edge is rides standing in a field; what makes
 * it a park is a line you cross to get in. So the site gets a boundary round
 * all four sides and exactly one gap — the gate, on the outer road.
 *
 * ## A hedge, not a fence
 *
 * This was a post-and-rail fence borrowed from `townConfig`'s `FENCE`, and it
 * is now the shrub that used to be planted just inside it, run shoulder to
 * shoulder the whole way round. A fence is the right edge for a field and the
 * wrong one for a park: it is a line you see through, and what it enclosed
 * still read as open ground with railings across it. A hedge is a wall you
 * cannot see past, which is what makes the inside feel like somewhere.
 *
 * ## A hedge is ALIGNED, and that is the whole of it
 *
 * `bushLow` is 2.3 m long and 1.49 m deep — a loaf, not a cube. The first
 * version turned every shrub at a random angle, which sounds like variety and
 * is in fact the reason the line did not read as a boundary: end-on, a shrub
 * presents 1.49 m of its 2.3, so at a 2.2 m pitch every second plant left
 * three quarters of a metre of daylight. Fifty-odd holes in 600 m of hedge,
 * and what you saw was a row of separate bushes.
 *
 * So each shrub is turned to lie ALONG its run — long axis down the hedge,
 * short axis across it — and `wobble` is the few degrees of slop left on top.
 * At 0.12 rad the projected length is still 2.28 m, so a 2.0 m pitch overlaps
 * by a quarter of a metre everywhere and nothing shows through.
 *
 * `jitter` is what survives of the old scatter: 0.12 m across the line, which
 * is enough to stop the face being a machined plane and far too little to
 * open a gap. A clipped hedge IS straight — that straightness is exactly what
 * makes it read as something built rather than something grown.
 *
 * That is about 300 shrubs. They are one instanced mesh and therefore one
 * draw call, which is the only reason a hedge this dense is affordable.
 */
export const PARK_HEDGE = {
  /** The shrub, and how often. Under its own length, so the run is solid. */
  pitch: 2.0,
  /**
   * How far each run is pulled back from the gate jambs.
   *
   * A shrub is 2.3 m long and lies ALONG its run, so one centred on the jamb
   * hangs 1.15 m into the opening — which is why the hedge was standing on
   * the entrance paving. Half a shrub plus a little keeps it clear of the
   * tiles, and the gap reads as 26 m because that is what it now is.
   */
  gateInset: 1.4,
  /** How far it strays across the line, and how far off square it sits. */
  jitter: 0.12,
  wobble: 0.12,
  /**
   * The box that stops a car, per run rather than per shrub: 270 colliders
   * would be 270 colliders, and a hedge is a wall whatever it is made of.
   * Half-depth and half-height, measured off `bushLow` — 2.3 x 1.55 x 1.49.
   */
  halfDepth: 0.9,
  halfHeight: 0.78,
} as const;

/**
 * The boundary, as straight runs: the site's four sides, less the gate.
 *
 * Derived rather than written down, and here rather than in the component
 * because three things need it — the hedge, its colliders and the minimap —
 * and a boundary the map disagrees with about where the way in is would be
 * worse than no boundary at all.
 *
 * The gate sits on the across-max side, the one the outer road runs along,
 * and its width comes out of that side, which leaves five runs. Only the
 * gate's `along` matters here: its own `across` is the ROAD's edge, four
 * metres beyond the site, because the gateway apron crosses the boundary and
 * this is the hole it crosses through.
 */
export function parkBoundaryRuns(): Array<readonly [number, number, number, number]> {
  const runs: Array<readonly [number, number, number, number]> = [];
  const ring = PARK.outline;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    /*
     * Which gates are in THIS edge.
     *
     * An edge runs at a constant along or a constant across; a gate names
     * which of those it is in and at what value, so the test is an equality
     * and not a guess. It used to be a guess — the first version matched on
     * `gate.across`, which is the OUTER ROAD's kerb at 252 and not the hedge
     * line at 248, so the opening belonged to no edge at all and the park was
     * walled in with no way through.
     */
    const vertical = x0 === x1;
    const line = vertical ? x0 : z0;
    const lo = vertical ? Math.min(z0, z1) : Math.min(x0, x1);
    const hi = vertical ? Math.max(z0, z1) : Math.max(x0, x1);
    const here = PARK.gates
      .filter((g) => (g.edge === 'along') === vertical && g.at === line
        && g.centre - g.half > lo && g.centre + g.half < hi)
      .sort((a, b) => a.centre - b.centre);
    // Walk the edge low to high, stopping short of each opening and starting
    // again past it. Pulled back from both jambs, so no shrub overhangs one.
    let cursor = lo;
    const at = (v: number): readonly [number, number] => (vertical ? [line, v] : [v, line]);
    for (const g of here) {
      const [ax, az] = at(cursor);
      const [bx, bz] = at(g.centre - g.half - PARK_HEDGE.gateInset);
      runs.push([ax, az, bx, bz]);
      cursor = g.centre + g.half + PARK_HEDGE.gateInset;
    }
    const [ax, az] = at(cursor);
    const [bx, bz] = at(hi);
    runs.push([ax, az, bx, bz]);
  }
  return runs;
}

/**
 * The park kit, by the names `prepare-park.mjs` gives the pieces.
 *
 * These replace the three city CHUNKS the park was planted with — a
 * vegetation cell, a copse cell and a street-furniture cell, lifted whole out
 * of `city.glb` and stamped down. A chunk is a hundred things welded into one
 * mesh, which is the right unit for a row of buildings and the wrong one for
 * a park: you cannot put a tree beside a path with it, only a block of trees
 * somewhere near one. Every piece here is a single object out of the same
 * city map, recentred and grounded, so the park is planted one tree at a time.
 *
 * Four trees and two shrubs is the whole palette, which is enough that no two
 * neighbours are the same object and few enough that the park still reads as
 * one place.
 */
export const KIT = {
  bench: 'bench',
  benchSlat: 'benchSlat',
  /** A flat soil ring, for a tree standing in paving rather than in grass. */
  planter: 'planter',
  arcade: 'arcade',
  shopA: 'shopA',
  shopB: 'shopB',
  /** Avenue trees, alternating, and the two big ones for specimens. */
  avenue: ['treeSlim', 'treeTall'] as readonly string[],
  specimen: ['treeBroad', 'treeBig'] as readonly string[],
  shrub: 'bush',
  hedge: 'bushLow',
  /** The small stuff a midway is made of, both off the mainland. */
  stall: 'stall',
  barrier: 'barrier',
  /** The water, and the furniture a park has and a fairground does not. */
  pond: 'pond',
  bin: 'bin',
  lamp: 'lamp',
  iceCart: 'iceCart',
  candyStall: 'candyStall',
  sign: 'sign',
  shelter: 'shelter',
} as const;

/** Every kit part, which is what the component has to find in `park.glb`. */
export const KIT_PARTS: readonly string[] = [
  KIT.bench, KIT.benchSlat, KIT.planter, KIT.arcade, KIT.shopA, KIT.shopB,
  ...KIT.avenue, ...KIT.specimen, KIT.shrub, KIT.hedge,
  KIT.pond, KIT.bin, KIT.lamp, KIT.sign, KIT.shelter, KIT.iceCart,
  KIT.stall, KIT.barrier, KIT.candyStall,
];

/**
 * The flat parts, and how far over the island crown each one floats.
 *
 * The pond is a single quad with no thickness, so it needs telling where it
 * sits or it fights the crown for the same pixels.
 */
export const FLAT_LIFT: Record<string, number> = {
  [KIT.pond]: 0.03,
};

/** Where the pond goes: the one pocket of open ground big enough for it. */
export const POND = AT.pond;

/**
 * The ice carts, down the promenade kerbs.
 *
 * Four now. They fall BETWEEN the walk's furniture stations, which stand
 * every 14 m from across 170, so each is a good five metres clear of the
 * nearest bench or lamp.
 */
export const ICE_CARTS = [
  { along: 277.6, across: 191, turn: -Math.PI / 2 },
  { along: 298.4, across: 163, turn: Math.PI / 2 },
  { along: 277.6, across: 233, turn: -Math.PI / 2 },
  { along: 298.4, across: 219, turn: Math.PI / 2 },
] as const;

/**
 * Radiator Springs Speedway: the west end of the park, and the one attraction
 * here you watch rather than queue for.
 *
 * ## What was here, and why it was not enough
 *
 * Two plinths with a car turning on each. It was correct and it was dull: a
 * turntable is what a motor show does with a car it cannot start, and these
 * two cars are ones you can actually drive. Standing them still was solving
 * the wrong problem. What a fairground does with a character vehicle is give
 * it somewhere to BE the thing it is — so McQueen gets a circuit, and Mater
 * gets to follow him round it at a tow truck's idea of racing.
 *
 * ## The circuit
 *
 * A dog-bone: two straights joined by two half-circles. It is the shape a
 * short oval takes when the ground is long and narrow, and the ground here is
 * 32 m by 100 — the whole west end, between the hedge and the drop tower's
 * apron, which is every metre the park has to give.
 *
 * `east` and `west` are the two straights' centrelines in the island's along,
 * so the turn radius is half the gap between them and is not written down
 * separately — a radius and two lanes that disagree is a track that does not
 * close. 8 m is tight, and deliberately: this is a show circuit at a fast
 * walking pace, not a racetrack, and a hairpin at each end is what puts both
 * cars broadside to the grandstand twice a lap.
 *
 * ## What stands on it
 *
 * What stands on it:
 *
 *   `gantry`     start and finish, over the east straight where the walk
 *                arrives, with a chequered band across it
 *   `stand`      the grandstand, stepped, facing west over that straight
 *   `masts`      four floodlight pylons, which are what make a small oval read
 *                as a stadium rather than as a path
 *
 * ## The motion
 *
 * Both cars run the same arc-length clock at the same speed, offset by a
 * fixed gap, so the distance between them never changes and neither can ever
 * catch the other — which is the only way two objects on one loop stay honest
 * without collision code. They drift through the turns and run straight down
 * the straights; see `drift` for why that is the only thing they do.
 *
 * The garage exports face -Z and sit on y = 0 (`prepare-garage.mjs`), so
 * aiming one along the path is `atan2(dx, dz) + PI` and lifting it is nothing
 * at all.
 */
export const SPEEDWAY = {
  /**
   * The circuit, as control points for a closed centripetal Catmull-Rom.
   *
   * It was a dog-bone: two straights and two hairpins, 202 m, drawn by hand
   * from four numbers. It closed and it was dull — a shape with two radii in
   * it has two corners however long you make the straights, and both cars did
   * the same thing twice a lap forever.
   *
   * This one was DRAWN rather than solved, and it is better for it. The line
   * came back on a scale map of the park and these are its points, traced off
   * the image against the four fiducials that were printed on it for exactly
   * that purpose.
   *
   * 336 m, twenty-eight control points, and the radius runs from 11.1 m at the
   * tightest corner to a median of 125. No hairpins at all — one long open
   * loop with a squeeze at each end, which is what somebody drawing a racing
   * line freehand produces and what an algorithm fitting corners to a
   * footprint does not.
   *
   * ## The east side is ruled, and it is the one place the drawing was not kept
   *
   * The traced line wandered between along 194.9 and 202.5 down that side —
   * the wobble of a hand moving a pen a hundred and twenty metres, not a
   * decision. Held at a constant 202 it is a proper main straight, it gives
   * the infield eight metres it did not have, and it still clears the drop
   * tower's apron on 207 by 1.8 m at the kerb. Everything else is as drawn.
   *
   * ## The jump is over the ENTRANCE, and that was the drawing's idea
   *
   * The west gate's walk runs east on across 154.5 and the track has to cross
   * it. Every version before this went round: a lobe north of the walk, a
   * straight east of it, a hairpin south of it — the walk was a wall and the
   * circuit was shaped by it.
   *
   * The drawn line simply stops at across 170.6 and starts again at 137.0,
   * with nothing in between. That is not a gap in the track, it is the whole
   * point of the track: the cars LEAVE THE GROUND at one side of the park's
   * front door and land on the other, and you walk in underneath them. See
   * `jump`.
   *
   * It is 391 m rather than 324 because the pit row went. Six garages and
   * their yard held 35 x 72 m at the west end and read, from any distance, as
   * a car park; the circuit wanted the ground more than the site wanted the
   * building, so the whole west lobe is track now.
   *
   * ## What it is not allowed to touch
   *
   * The west gate's walk, which is the way in from the airport crossroads. The
   * track passes within 1.9 m of the cross walk at its closest and clears
   * everything else by more; it is checked rather than eyeballed, because a
   * spline through nineteen points does not go where you think it does.
   *
   * Centripetal rather than uniform Catmull-Rom: the points are unevenly
   * spaced by design — 8 m apart round a hairpin and 30 down a straight — and
   * uniform parameterisation overshoots on exactly that, which on a race track
   * means a corner that bulges through the fence between two control points.
   */
  points: [
    [143.1, 137.0], [143.6, 131.1], [146.1, 122.7], [150.3, 116.8],
    [156.2, 113.0], [165.5, 111.0], [175.5, 113.5], [187.3, 117.7],
    [195.0, 121.8], [200.0, 128.0],
    // The east side, ruled rather than traced — see below.
    [202, 138], [202, 155], [202, 172], [202, 189], [202, 206], [202, 221],
    [199.0, 231.5], [193.0, 237.0], [185.0, 239.5], [172.0, 240.0],
    [160.0, 239.5], [150.5, 237.0], [145.5, 230.0], [143.3, 220.0],
    [142.0, 205.0], [141.6, 191.6], [141.4, 179.8], [141.6, 170.6],
  ] as ReadonlyArray<readonly [number, number]>,
  /**
   * The carriageway, and the kerb round its outside.
   *
   * 6.5 rather than 5. Five was enough for two cars nose to tail and not
   * enough for anything else: a five-car field needs somewhere to go past, and
   * a car drifting at fifty degrees uses about four metres of road by itself.
   */
  width: 6.5,
  kerb: 0.45,
  /** How far the asphalt sits over the ground it is drawn on. */
  lift: 0.012,
  /**
   * How the cars drive it, which is the difference between a circuit and a
   * conveyor.
   *
   * They do NOT run at a constant speed. `grip` is the lateral acceleration a
   * cartoon race car is allowed — 3.4 m/s^2, about a third of a real one — and
   * the speed at any point is `sqrt(grip * radius)` clamped between `slow` and
   * `quick`. So they brake for the hairpins and stretch their legs down the
   * straights, which is what makes two cars on one line read as a chase.
   *
   * `behind` is how far back each car runs in TIME, not in metres. A fixed
   * distance keeps the gap the same everywhere; a fixed time means it opens
   * down the straights and closes in the corners, because that is what
   * following someone does — and because all three read the same table, none
   * can ever catch another however long they run.
   *
   * The numbers are the closing gaps rather than taste. 1.7 s puts Chick on
   * McQueen's tail at about fifteen metres at the slowest corner, which is two
   * car lengths and a fight; 8.5 s puts Mater the better part of half a lap
   * back, which is a tow truck's idea of racing.
   */
  grip: 7.6,
  slow: 7,
  quick: 21,
  /**
   * How far the tail steps out, in radians of yaw beyond the direction of
   * travel.
   *
   * A car that is always pointing exactly where it is going is on rails. This
   * turns the nose INTO the corner by up to `drift` — opposite lock, seen from
   * outside — scaled by how hard the corner is being taken, so the cars are
   * straight down the straights and properly sideways through the turns.
   *
   * 0.85 rad, which is fifty degrees at the tightest corner, and it is that
   * large because it is now the ONLY thing the cars do in a turn. They used to
   * roll as well, and that had to go: a car does not lean into a corner the
   * way a motorcycle does, and this circuit has no banking anywhere for a lean
   * to be answering. Flat track, so the movement is a slide.
   *
   * It is a lie about the physics and the right lie: nothing here is
   * simulated, and a drift is what the eye reads as speed.
   */
  drift: 0.85,
  /**
   * How far the front wheels can be turned, which is a steering rack's limit.
   *
   * The front pair counter-steers by the negative of the drift — that is what
   * holding a slide is — but a rack runs out at about 35 degrees and a wheel
   * turned further than that reads as a broken model. 0.62 rad is 35.5.
   */
  lock: 0.62,
  /**
   * The jump, and it is a real gap in the track.
   *
   * `at` and `gap` are MEASURED off the walk the cars are jumping over. The
   * west gate's apron runs across 143.5 to 165.5; walking the circuit and
   * asking where it crosses those two lines gives 307.2 m and 329.3 m round
   * the lap, so the gap is 22.1 m and it starts at 307.2 — the unpaved span is
   * exactly the width of the path underneath it, to a decimetre.
   *
   * ## The ramp is a curve, not a wedge
   *
   * The deck rises as `rise * u^2` over `climb`, so it leaves the ground at
   * ZERO slope and reaches the lip at `2 * rise / climb`. A straight ramp has
   * a crease at the bottom that a car would launch off rather than drive up,
   * and in profile it is a triangle. This is the shape a ramp is actually
   * built as.
   *
   * With 3.2 m over 10 the lip slope is 0.64, which is a launch angle of 32.6
   * degrees. It was 2.0 m and 21.8, and that was too flat: the arc cleared the
   * path by a couple of metres and read as a car going over a hump rather than
   * as a jump.
   *
   * Raising the take-off raises everything else with it, because everything
   * else is derived — a steeper lip needs LESS speed to cover the same gap
   * (15.5 m/s against 17.7) and throws the car far higher doing it. The apex
   * went from 4.2 m to 6.7 and the hang time from 1.34 s to 1.70.
   *
   * The landing ramp is the same curve mirrored and the same height, and that
   * is not decoration: with both lips level the descent angle equals the
   * launch angle exactly, so the car meets the landing deck at precisely the
   * angle the deck is built at. Make one taller than the other and it arrives
   * nose-first into a slope that does not match.
   *
   * ## Everything else falls out of gravity
   *
   * Nothing about the flight is chosen. Given the angle and a 22.1 m gap
   * between two lips at the same height, there is exactly ONE launch speed
   * that lands the car on the far lip — `sqrt(g * range / sin 2θ)`, which here
   * is 17.7 m/s — and the cars are driven at it on the approach rather than at
   * whatever the corner behind allowed. The arc through the air is then the
   * real parabola: horizontal speed constant at `v cos θ`, height
   * `rise + x tan θ - g x^2 / (2 v^2 cos^2 θ)`.
   *
   * That puts the apex 2.2 m over the lip, 4.2 m over the ground, and the
   * flight takes 1.34 s. An earlier version had a hand-picked 4 m `peak` on
   * top of an arbitrary parabola, which looked like a stunt and was not one:
   * the car left the ramp at one speed, flew as though it had another, and
   * arrived at the far side going down at an angle the landing ramp did not
   * share.
   */
  jump: { at: 297.2, climb: 10, rise: 3.2, gap: 22.1, land: 3.6, drop: 10 },
  /**
   * The wall down each side of a ramp, and how far it stands over the deck.
   *
   * `width` is the shoulder it sits on, outside the kerb; `rise` is how proud
   * of the running surface it is. 34 cm is about waist height on these cars —
   * enough to read as an edge from the grandstand and from the air, low enough
   * that it is plainly a parapet and not a tunnel.
   */
  parapet: { width: 0.34, rise: 0.34 },
  /**
   * The ramps are PAINTED, in blocks `block` metres long.
   *
   * A stunt ramp is not a piece of civil engineering that happens to be in a
   * theme park, it is a piece of the show, and grey concrete with a stone cap
   * read as a flyover. The parapet — outer wall, cap and inner face together —
   * is dealt from `livery` a block at a time, so each block is one solid
   * colour top to bottom and the ramp stripes as it climbs.
   *
   * `band` is the chevron laid across the deck at each block's start: the same
   * colour, so the stripe carries across the running surface instead of
   * stopping at the kerb. Keep it well under `block` or the deck stops being
   * asphalt and becomes a rainbow.
   *
   * `block` is sized so the ramp divides into an ODD number of them: with two
   * colours and an even count the first and last block match, and a stripe
   * pattern that starts and ends on the same colour reads as a mistake at the
   * lip. 10 m of climb at 2.15 gives five.
   */
  paint: { block: 2.15, band: 0.42 },
  cars: [
    { model: '/models/garage/mcqueen.glb', label: 'mcqueen', behind: 0 },
    /*
     * Doc Hudson, 1.7 s back, which is a battle rather than a procession.
     *
     * Chick Hicks had this seat for about ten minutes and gave it up for a
     * reason that is entirely mechanical: run through `prepare-garage`, Doc
     * comes back with `Wheel_FL` and friends and Chick comes back "body only",
     * his wheels merged into his shell and unseparable. All three cars out
     * here spin and steer their wheels; a fourth that could not would be the
     * one thing you looked at. So Doc races and Chick watches from the verge.
     */
    { model: '/models/garage/doc.glb', label: 'doc', behind: 1.7 },
    /*
     * The King, who has wheel pivots off `prepare-garage` and so can race.
     *
     * Sally had the seat after him and is off the circuit now — she is not a
     * racer and was only ever here because her export happened to allow it.
     * The gap behind The King is left long on purpose: it is what Mater is
     * trundling around in, and closing it up would only crowd the field.
     */
    { model: '/models/garage/king.glb', label: 'king', behind: 3.4 },
    { model: '/models/garage/mater.glb', label: 'mater', behind: 11 },
  ],
  /*
   * There is no Cozy Cone Motel.
   *
   * Four traffic cones at three times life size stood down the infield. They
   * were the one piece of Radiator Springs that could be DRAWN rather than
   * modelled — a cone, a stripe and nothing else — and that was the whole of
   * their case. Next to a real circuit with kerbing, tyre walls, a grandstand
   * and a jump they read as a joke told twice, and the infield is better empty.
   */
  /** Flo's, in the south infield where the sweeper wraps round it. */
  /** Start and finish, over the pit straight. */
  /**
   * Start and finish, placed by ARC rather than by position.
   *
   * It used to be written down as (198.3, 213.5) and the start line was found
   * by searching for the nearest arc to it. Two things wrong with that. The
   * line chased the gantry, so the gantry had to be right; and the gantry was
   * not — the track's centreline at that across is along 202.2, so a structure
   * centred on 198.3 with its legs 4.45 m out put one of them at 202.75, four
   * metres INSIDE a track that runs from 198.5 to 205.9. A gantry leg on the
   * racing line.
   *
   * An arc cannot be off-centre. The component takes the point and the
   * direction from the circuit and squares the gantry to it, so the legs are
   * `clear` metres outside the kerb on each side by construction, and the
   * start line is this arc and not a search for it.
   *
   * Moved down the straight to 116 as well — away from the stand, which now
   * looks over the pit lane and the east turn instead. Plenty of circuits put
   * their main stand at the corner where the overtaking is rather than at the
   * line, and here it is what the geometry allows: the infield loop takes the
   * corridor the stand would otherwise need.
   */
  gantry: { arc: 116, height: 6.4, post: 0.4, beam: 0.85, band: 1.1, clear: 1.5 },
  /**
   * The start line itself, drawn rather than implied.
   *
   * It was two courses of eight dark squares and nothing else, which on dark
   * asphalt is a chequerboard you have to be told is there: the black squares
   * were drawn and the white ones were "the road showing through", and the
   * road is #33363b against a chequer of #22242a. Both halves are painted now,
   * and finer — 12 across instead of 8, 4 courses instead of 2 — with a solid
   * white edge line either side, which is the part that actually reads as a
   * line from the grandstand and from the air.
   */
  line: { cells: 12, courses: 4, cell: 0.52, edge: 0.24, gap: 0.16 },
  /**
   * The grandstand, in the infield facing west over the pit straight.
   *
   * Inside the circuit rather than outside it, and not as a compromise: the
   * outside of the pit straight is the pit row and the outside of the back
   * straight is the drop tower's apron, so there is no outside left. A short
   * circuit hemmed in on both sides puts its stand on the infield, and plenty
   * of real ones do.
   */
  stand: {
    /**
     * The arc range of the circuit it wraps, and how far inboard it starts.
     *
     * The stand was a straight staircase of five boxes at a fixed `along`,
     * parked beside a track that curves — so at one end it hugged the kerb
     * and at the other it wandered off into the infield. Built on an arc
     * range instead, every row follows the circuit at a constant offset and
     * the whole thing bends with the turn it overlooks.
     *
     * 144 to 181 is the top of the east straight and the first part of the
     * turn, which is the only corridor left for it: the infield loop runs at
     * along 199-202 below across 204, and the pit apron's back is at along
     * 181. Front row 11 m off the centreline, eight rows deep at 0.78, so the
     * back is at 17.2 — along 184.8 at the straight, 3.8 m clear of the pit.
     */
    from: 144, to: 181,
    offset: 11,
    rows: 8, rise: 0.42, tread: 0.78,
    /** The seat on each tread: how much of it, and how tall the backrest. */
    seat: { inset: 0.13, depth: 0.46, rest: 0.4 },
    /**
     * Gaps in the seating where the stairs come up, as arc ranges.
     *
     * A block of seating 37 m long with no way into it is a wall with stripes
     * on. Two vomitories break it into three blocks and give the steps
     * somewhere to be.
     */
    vomitory: [[155.5, 158.5], [168, 171]] as const,
    /** How many colour blocks the seating is dealt into along the arc. */
    sections: 6,
    /** The roof: on columns at the back, oversailing the front row. */
    roof: { height: 7.4, over: 1.8, thick: 0.26, fascia: 0.55, columns: 7, post: 0.34 },
    /** The wall closing the back of it. */
    back: { thick: 0.35, height: 3.1 },
  },
  /**
   * The rumble strips, and where they go.
   *
   * Red-and-white blocks on the kerb, but only at the corners that need them:
   * anywhere the radius is under `rumbleUnder`, which on this circuit is the
   * the four corners that turn hardest. A circuit kerbed in red and white all
   * the way round is a go-kart track — on a real one the stripes mark the
   * places you are allowed to run wide, and everywhere else the kerb is plain.
   *
   * 42 rather than 26, because the drawn circuit has no hairpins in it: its
   * tightest corner is 10.5 m and its median is 104, so a threshold set for a
   * track with 7 m hairpins would have kerbed almost none of it.
   */
  rumbleUnder: 42,
  rumbleBlock: 2.2,
  /**
   * Tyre stacks, on the OUTSIDE of anything tighter than this.
   *
   * Two courses high, every four metres, set back a metre from the kerb. They
   * are what a corner has behind it, and without them the track just stops
   * and the grass begins.
   */
  tyresUnder: 30,
  /**
   * `bulge` is what makes them tyres.
   *
   * A cylinder is a drum. A tyre seen from outside is widest at its middle and
   * pinched at the rim, so each course is drawn as a barrel — narrow top and
   * bottom, `bulge` wider in the band between — which at three courses high is
   * the difference between a stack of tyres and a stack of buckets.
   */
  tyre: { radius: 0.58, bulge: 0.1, height: 0.3, courses: 3, pitch: 3.4, back: 1.2 },
  /** Floodlights, in the infield at the four ends. */
  masts: [
    { at: 168, across: 190 }, { at: 152, across: 205 },
    { at: 186, across: 130 }, { at: 156, across: 124 },
  ],
  mast: { height: 14, post: 0.42, head: { width: 3.2, height: 1.1, depth: 0.5 } },
  colours: {
    asphalt: '#33363b',
    kerb: '#d8d5cc',
    steel: '#5d6a74',
    concrete: '#b5b1a7',
    lamp: '#eef3ff',
    chequer: '#22242a',
    /** The red half of the rumble strip; the white half is the kerb itself. */
    rumble: '#c0392b',
    /**
     * The ramp's paint, dealt a block at a time — see `SPEEDWAY.paint`.
     *
     * TWO, alternating: Piston Cup red and the same cream as the circuit's
     * kerbs. It ran to four — red, blue, yellow, cream — on the argument that
     * a longer cycle stops the eye reading the stripes as a repeating texture.
     * It does, and it also stops them reading as anything: four colours on a
     * ten-metre ramp is a paint chart, and the one thing a take-off ramp has
     * to do from a distance is read as a single object with an edge you can
     * see. Red and cream alternating is a barrier pattern, which is what this
     * is, and the contrast between them is the highest of the four.
     */
    livery: ['#d8382c', '#e9e5db'] as const,
    /** The pit box: its apron, its barrier, and the fuel drum. */
    pitFloor: '#97958d',
    /**
     * A colour per pit box — see `PIT.boxes.inset`.
     *
     * Three, because there are three boxes and each belongs to somebody. Red,
     * blue and yellow: the same three the ramp used before it went to two, and
     * they work here for the reason they did not there — these are three
     * separate objects a few metres apart, not one object striped.
     */
    pitTeam: ['#b8362c', '#2f6fd0', '#e0a91f'] as const,
    /** The darker working pad inside the apron. */
    pitPad: '#6f6e69',
    pitWall: '#c9c5ba',
    pitRig: '#c0392b',
    /**
     * Tyre stacks, and the second colour is per STACK, not per course.
     *
     * It used to alternate up the stack — a dark course, a pale course, a dark
     * course — on the theory that banding would stop a pile of cylinders
     * reading as a bollard. It did stop that, and made them read as biscuits
     * instead: three discs, dark, cream, dark, at eye height beside a
     * fairground.
     *
     * A real tyre wall is all black rubber with the occasional whole stack
     * painted so marshals can count along it. So every fourth stack is painted
     * and the rest are rubber, and what separates the courses is the pinch
     * between two barrels rather than a change of colour.
     */
    tyre: '#24242a',
    tyrePaint: '#c4442f',
    seat: '#e2632a',
    /**
     * The seating blocks, dealt along the stand — see `SPEEDWAY.stand.sections`.
     *
     * Four, so six sections do not repeat evenly and the blocks read as a
     * pattern somebody chose rather than as a stripe. Piston Cup red and a
     * sponsor yellow against two greys, which is how a real stand looks when
     * half of it is empty: the dark seats read as the crowd that is not there.
     */
    seatBlocks: ['#c0392b', '#3c4149', '#e0a91f', '#59606b'] as const,
    /** The stand's roof, and the fascia hanging off its front edge. */
    standRoof: '#4a5058',
  },
} as const;

/**
 * The circuit, resampled: where it goes, how fast, and when.
 *
 * Built once at module load. Three tables come out of it and the component
 * reads all three every frame, so none of them may be a search.
 *
 * `point` is arc length to position. `speedAt` is arc length to metres a
 * second, from the local radius. `arcAt` is TIME to arc length — the integral
 * of ds/v, inverted — and it is the one that matters: two cars offset in time
 * along the same table are a chase, and neither can ever catch the other,
 * because both are reading the same function.
 */
export const LAP = (() => {
  const P = SPEEDWAY.points;
  const n = P.length;
  const at = (i: number) => P[((i % n) + n) % n];
  // Centripetal knots, then the Barry-Goldman pyramid per segment.
  const segs = Array.from({ length: n }, (_, i) => {
    const p = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const gap = (a: readonly number[], b: readonly number[]) =>
      Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5 || 1e-4;
    const t = [0, 0, 0, 0];
    for (let k = 1; k < 4; k++) t[k] = t[k - 1] + gap(p[k - 1], p[k]);
    return { p, t };
  });
  const evalSeg = (s: typeof segs[number], u: number): [number, number] => {
    const t = s.t[1] + u * (s.t[2] - s.t[1]);
    const mix = (a: readonly number[], b: readonly number[], ta: number, tb: number) => [
      ((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta),
      ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta),
    ];
    const A1 = mix(s.p[0], s.p[1], s.t[0], s.t[1]);
    const A2 = mix(s.p[1], s.p[2], s.t[1], s.t[2]);
    const A3 = mix(s.p[2], s.p[3], s.t[2], s.t[3]);
    const B1 = mix(A1, A2, s.t[0], s.t[2]);
    const B2 = mix(A2, A3, s.t[1], s.t[3]);
    return mix(B1, B2, s.t[1], s.t[2]) as [number, number];
  };
  const STEP = 60;
  const raw: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < STEP; k++) raw.push(evalSeg(segs[i], k / STEP));
  const cum = [0];
  for (let i = 1; i <= raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i % raw.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[raw.length];
  const point = (dist: number): [number, number] => {
    let d = dist % length;
    if (d < 0) d += length;
    /*
     * Binary search the arc table, and it has to be a search.
     *
     * This used to index straight in — `(d / length) * raw.length` — on the
     * argument that the dense samples were near enough uniform in arc. They
     * are not, and the reason is worth writing down: `raw` holds a fixed 60
     * samples per SEGMENT, and a segment is the span between two control
     * points. When the points were evenly spaced that was near enough true and
     * the error hid; the moment one segment became the 34 m jump among others
     * of 5, one step of arc length moved anywhere between 0.32 m and 3.90 m on
     * the ground — a twelvefold spread, on a function whose whole job is that
     * the two are the same number.
     *
     * Everything downstream believed it: the cars' speed profile, the ribbon's
     * sample spacing, the gap between the two cars, and where the jump's ramps
     * landed. All of it was wrong wherever the control points were uneven.
     */
    let lo = 0;
    let hi = raw.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const a = raw[lo];
    const b = raw[(lo + 1) % raw.length];
    const k = (d - cum[lo]) / Math.max(1e-6, cum[lo + 1] - cum[lo]);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  /** Radius, by the circle through three points six metres apart. */
  const radiusAt = (d: number) => {
    const a = point(d - 6);
    const b = point(d);
    const c = point(d + 6);
    const A = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const B = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const C = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const s = (A + B + C) / 2;
    const area = Math.max(1e-6, Math.sqrt(Math.max(0, s * (s - A) * (s - B) * (s - C))));
    return (A * B * C) / (4 * area);
  };
  /*
   * The jump: a curved ramp, a real parabola, and a hole in the track.
   *
   * `heightAt` is the profile and `onTrack` says where there is no deck under
   * the car. The numbers in between are not free — see `SPEEDWAY.jump`:
   *
   *   theta    the lip angle, which is the slope of `rise * u^2` at u = 1
   *   launch   the ONE speed that lands a car on the far lip from that angle
   *   cruise   its horizontal component, which is what the arc advances at
   *
   * The flight is then `x tan θ - g x^2 / (2 v^2 cos^2 θ)` above the lip, in
   * the horizontal distance travelled — projectile motion, written out.
   */
  const J = SPEEDWAY.jump;
  const a0 = J.at;
  const a1 = a0 + J.climb;
  const a2 = a1 + J.gap;
  const a3 = a2 + J.drop;
  const G = 9.81;
  const theta = Math.atan((2 * J.rise) / J.climb);
  /*
   * The flight is aimed PAST the landing lip, not at it.
   *
   * Solving for a car that touches down exactly on the far lip is the tidy
   * answer and the wrong one: it is the shortest jump that clears the gap, so
   * every metre of slope beyond the edge goes unused and the landing reads as
   * a car catching the corner of a wall. A real car lands a little way down
   * the ramp, where the deck has already turned to meet it.
   *
   * So the target is `J.land` metres along the landing ramp. The deck there is
   * `hLand` (its own quadratic, not the lip height), the flight covers
   * `flight` horizontally, and the launch speed is whatever makes the parabola
   * pass through that point:
   *
   *   rise + x·tanθ − g·x² / (2·v²·cos²θ) = hLand   solved for v
   */
  const flight = J.gap + J.land;
  const uLand = (J.drop - J.land) / J.drop;
  const hLand = J.rise * uLand * uLand;
  const cos2 = Math.cos(theta) * Math.cos(theta);
  const fall = J.rise + flight * Math.tan(theta) - hLand;
  const launch = Math.sqrt((G * flight * flight) / (2 * cos2 * fall));
  const cruise = launch * Math.cos(theta);
  const wrap = (d: number) => { const x = d % length; return x < 0 ? x + length : x; };
  /**
   * How far into the jump an arc distance is — and it has to be measured this
   * way, because the jump crosses the start line.
   *
   * `a0` is 297.2 and the whole jump is 42.1 m long on a 336.25 m lap, so it
   * finishes at 339.3 — which is 3.05, on the far side of the line. Every one
   * of these profiles used to test `x < a0 || x > a3` against a wrapped `x`,
   * and for the last three metres of the landing ramp that test says "not on
   * the jump": the deck fell to the ground a step short of its own foot, the
   * car dropped with it, and the run-up window `x >= a0 - 22` silently covered
   * the wrong 22 metres.
   *
   * Measuring forward from `a0` and wrapping THAT makes the whole jump one
   * unbroken interval [0, span] again, wherever on the lap it happens to sit.
   */
  const span = J.climb + J.gap + J.drop;
  const into = (d: number) => wrap(d - a0);
  const heightAt = (d: number) => {
    const x = into(d);
    if (x > span) return 0;
    // Up the take-off: quadratic, flat at the foot and steepest at the lip.
    if (x < J.climb) { const u = x / J.climb; return J.rise * u * u; }
    // Airborne, from the lip until the wheels meet the landing ramp — which
    // is `J.land` past its lip, so the last stretch of this arc is over deck.
    if (x < J.climb + flight) {
      const run = x - J.climb;
      return J.rise + run * Math.tan(theta)
        - (G * run * run) / (2 * launch * launch * cos2);
    }
    // Down the landing: the same curve mirrored, so the deck is steepest where
    // the car meets it and flattens out underneath.
    const u = (span - x) / J.drop;
    return J.rise * u * u;
  };
  /**
   * The height of the DECK, which past the landing lip is not the car's.
   *
   * `heightAt` follows the car, and the car is still in the air for the first
   * `J.land` metres of the landing ramp. Build the ramp from that and its
   * surface bulges up into the flight path. Everything drawn or collided —
   * deck, kerbs, walls, end caps — uses this instead; only the car uses
   * `heightAt`.
   */
  const deckAt = (d: number) => {
    const x = into(d);
    if (x > span) return 0;
    // `<=` on purpose: the take-off's last vertex sits exactly on the lip, and
    // `<` would drop it to the ground and fold the ramp flat at its own edge.
    if (x <= J.climb) { const u = x / J.climb; return J.rise * u * u; }
    if (x < J.climb + J.gap) return 0;
    const u = (span - x) / J.drop;
    return J.rise * u * u;
  };
  const onTrack = (d: number) => {
    const x = into(d);
    return x <= J.climb || x >= J.climb + J.gap;
  };
  /**
   * The speed the jump imposes, or null where it imposes none.
   *
   * On the run-up the car is brought to `launch`, because a car that arrives
   * at a ramp doing whatever the last corner allowed lands somewhere other
   * than the ramp. Through the air the arc advances at `cruise`, the
   * horizontal component — which is right because the track is straight there,
   * so distance along it IS horizontal distance.
   */
  const jumpSpeed = (d: number) => {
    const x = into(d);
    if (x >= J.climb && x < J.climb + flight) return cruise;
    // The last 22 m of run-up, eased in so it is a driver setting up rather
    // than a car changing speed instantly. Measured backwards from the ramp
    // foot, which is the only way that survives the start line falling inside
    // the jump — see `into`.
    const togo = length - x;
    if (x > span && togo <= 22) return { blend: 1 - togo / 22, to: launch };
    return null;
  };
  const S = SPEEDWAY;
  /**
   * How fast a car is going at a point, and the jump overrules the corner.
   *
   * Everywhere else it is grip-limited: `sqrt(grip * radius)`, clamped. Near
   * the ramp it is whatever the jump needs — eased in over the run-up, held
   * exactly through the air — because the arc has to be the one gravity draws
   * and gravity does not negotiate with the corner before it.
   */
  const speedAt = (d: number): number => {
    const corner = Math.min(S.quick, Math.max(S.slow, Math.sqrt(S.grip * radiusAt(d))));
    const forced = jumpSpeed(d);
    if (forced === null) return corner;
    if (typeof forced === 'number') return forced;
    return corner + (forced.to - corner) * forced.blend;
  };
  // Integrate ds/v round the lap, then invert it to a table uniform in time.
  const METRE = 1;
  const times = [0];
  for (let d = METRE; d <= length; d += METRE) {
    times.push(times[times.length - 1] + METRE / speedAt(d - METRE / 2));
  }
  const lapTime = times[times.length - 1];
  const SLOTS = 720;
  const arcTable = new Float64Array(SLOTS);
  let cursor = 0;
  for (let i = 0; i < SLOTS; i++) {
    const want = (i / SLOTS) * lapTime;
    while (cursor + 1 < times.length && times[cursor + 1] < want) cursor++;
    const span = Math.max(1e-9, times[cursor + 1] - times[cursor]);
    arcTable[i] = (cursor + (want - times[cursor]) / span) * METRE;
  }
  const arcAt = (t: number) => {
    let u = (t % lapTime) / lapTime;
    if (u < 0) u += 1;
    const f = u * SLOTS;
    const i = Math.floor(f) % SLOTS;
    const a = arcTable[i];
    let b = arcTable[(i + 1) % SLOTS];
    // The table wraps once a lap; unwrap so the interpolation does not run
    // backwards across the join.
    if (b < a) b += length;
    return a + (b - a) * (f - Math.floor(f));
  };
  const paved = { from: a2, to: a1 + length };
  const ramps = [{ from: a0, to: a1 }, { from: a2, to: a3 }];

  return {
    length, lapTime, point, radiusAt, speedAt, arcAt, heightAt,
    deckAt, onTrack, paved, ramps,
  };
})();

/*
 * There is no pit row, and no paddock behind it.
 *
 * Six open garages and a yard stood at the west end on 35 x 72 m of the park.
 * They were the right idea — a circuit with nothing behind it is a loop of
 * tarmac in a field — and the wrong object: six bays in a row with their
 * mouths open reads, from anywhere except directly in front, as a multi-storey
 * car park. There was already a real one four hundred metres away and the
 * resemblance was not flattering.
 *
 * The circuit has the ground now, and it is a better use of it: the whole
 * western lobe of `SPEEDWAY.points` runs through where the garages were, which
 * is sixty-seven metres of lap the track did not have. What stands in for the
 * paddock is the pit LANE — the track's own west side, with the grandstand
 * inside it.
 */

/**
 * The cotton candy stalls, three of them, down the walk to the coaster.
 *
 * One stall stood on the speedway and then in the paddock, and both times it
 * was somewhere nobody walks: the circuit is a thing you watch from outside,
 * so a stall beside it is a stall behind a fence. The queue for the coaster is
 * the busiest ground in the park and had nothing on it at all.
 *
 * Three at twenty-three metre spacing down `southEast`, the apron between the
 * arcade and the coaster's own yard, facing west at the people walking out to
 * the ride.
 */
export const CANDY = [
  { along: 334, across: 135, turn: -Math.PI / 2 },
  { along: 334, across: 158, turn: -Math.PI / 2 },
  { along: 334, across: 181, turn: -Math.PI / 2 },
] as const;

/**
 * The rest of Radiator Springs, watching from the infield.
 *
 * Doc, Luigi and Guido stood in the pit bays until the pit row went. Trackside
 * is the better place for them anyway: they are three characters, not three
 * exhibits, and what three characters do at a race is watch it.
 *
 * So they bounce. `hop` is how far each lifts on its springs and `rate` how
 * often, and the three are deliberately out of step — a matched pair of cars
 * bobbing in time is a mechanism, and three at different rates and phases is a
 * crowd. Guido is the quickest and bounces highest, which is both the joke and
 * the smallest of the three.
 *
 * `turn` faces each one at the track rather than at the camera.
 */
export const CAST = [
  /*
   * THE CAST, dotted about the INFIELD.
   *
   * They were a row of four behind the pit barrier, and before that a row of
   * four on the verge, and a row is what they always ended up as because they
   * were placed as a group. Parked one at a time in six different parts of the
   * infield they stop being a crowd and become things you come across.
   *
   * Inside the circuit and nowhere else. They were briefly scattered over the
   * whole park — by the big top, out past the coaster — and that is the wrong
   * place for them twice over: it is a long way from anything they have to do
   * with, and a car standing alone on a promenade two hundred metres from the
   * track reads as something that was dropped rather than parked.
   *
   * The spots come from a sweep of the ground enclosed by the circuit, tested
   * point-in-polygon against the circuit's own ring: paved, at least 5 m off
   * the main kerbs, the infield loop, the pit apron, the grandstand, the
   * trophy's plinth, Flo's, the gantry and every floodlight mast. Picked
   * greedily for spread; no two are closer than 20 m and the tightest gap to
   * anything is 6 m.
   *
   * That sweep tests a CENTRE, though, and a car is 3 to 5 m long, so every
   * one is checked again on all four corners of its turned footprint — which
   * is the check that matters when the heading is 2.1 radians and the box is
   * not square to the paving's edge.
   *
   * Headings are all different on purpose. A model faces `(-sin turn, -cos
   * turn)` in (along, across), so these are bearings, chosen so nothing lines
   * up with its neighbour or with the axes.
   *
   * `lift` is zero for all of them and is here because the pit crew share this
   * shape and Chick is up on jacks. See `PIT.crew`.
   */
  { part: 'fillmore', along: 160, across: 156, turn: 0.7, lift: 0, hop: 0.05, rate: 1.7, phase: 0.8 },
  { part: 'sarge', along: 156, across: 136, turn: -2.1, lift: 0, hop: 0.07, rate: 2.4, phase: 2.6 },
  { part: 'sally', along: 180, across: 182, turn: 2.6, lift: 0, hop: 0.08, rate: 4.8, phase: 2.2 },
  { part: 'luigi', along: 188, across: 156, turn: -0.5, lift: 0, hop: 0.04, rate: 2.2, phase: 2.7 },
  { part: 'giovanni', along: 192, across: 136, turn: 1.9, lift: 0, hop: 0, rate: 1, phase: 1.4 },
  /*
   * Sheriff, and FACING THE OTHER WAY from before.
   *
   * He was at turn 0, which points a model at -across, and came back reported
   * as "faced reverse". It was a deliberate choice — a police car on duty
   * rather than watching — and it read as a mistake, which for a layout is the
   * same thing as being one. He faces +across now, back up the infield.
   */
  { part: 'sheriff', along: 172, across: 202, turn: Math.PI, lift: 0, hop: 0.03, rate: 1.4, phase: 1.5 },
] as const;

/**
 * THE PIT LANE, in the paddock inside the east turn.
 *
 * This is the third go at it and the first that is a pit rather than a car
 * park. The two before were an apron with things standing on it: a bay, some
 * tyres, a fuel drum. What was missing is the thing that makes a pit a pit —
 * a LANE. Cars come off the circuit into a lane, stop in a marked box off that
 * lane, and leave by the same lane. Without it you have a yard.
 *
 * So the layout, from the track inwards:
 *
 *   wall      a low pit wall on the track side, which is what a pit lane is
 *             separated from the circuit by. Not crowd barriers: those are for
 *             holding people back and they go on the far side, facing the
 *             paddock, where people actually stand.
 *   lane      5.5 m of running surface, hatched at both ends where it would
 *             meet the circuit, with a solid white line down its inner edge.
 *   boxes     three marked bays off the lane, 8 m by 10, numbered west to
 *             east. Three because one is a diorama and three is a pit lane:
 *             the eye reads a repeated unit as a system.
 *   paddock   the strip behind the boxes where the spares and the crowd go.
 *
 * ## Why here
 *
 * The infield loop now cuts the infield in two, and this is the half that is
 * enclosed by track on the outside and the loop on the inside — a paddock in
 * the real sense, an area you reach from the circuit and from nowhere else.
 * It is also the only pocket left with 28 x 18 m in it: the grandstand's back
 * is at along 183.6 and the east turn's kerb comes down to across 232, and the
 * apron is sized to the 3.6 m and 2 m those leave.
 *
 * `across` runs the length of the lane, `along` is depth back from the track,
 * so a car standing in a box points at the lane — turn PI, facing +across —
 * and the crew face the car.
 */
export const PIT = {
  /** The apron, as [alongFrom, alongTo, acrossFrom, acrossTo]. */
  floor: [153, 181, 212, 230] as const,
  /**
   * The lane: where it runs, and the line down its inner edge.
   *
   * `from`/`to` are the across bounds — it is the full depth of the apron on
   * the track side. Nothing is ever parked in here; that is the point of it.
   */
  lane: { from: 224.5, to: 230, line: 0.16 },
  /** Hatched at both ends, where the lane would run out onto the circuit. */
  hatch: { ends: [[153.4, 158], [176, 180.6]] as const, pitch: 1.3, bar: 0.3 },
  /** The pit wall: low, capped, on the track side of the lane. */
  wall: { across: 230.6, from: 154, to: 180, height: 1.0, thick: 0.4, cap: 0.12 },
  /**
   * The three boxes, as [alongFrom, alongTo], all sharing the same across.
   *
   * 8 m of frontage each with a metre and a half between, which is what makes
   * them read as three bays rather than one long shelf.
   */
  boxes: {
    at: [[154, 162], [163.5, 171.5], [173, 181]] as const,
    from: 214, to: 224, line: 0.14,
    /**
     * A coloured floor inside each box, inset from its markings.
     *
     * The apron was three greys — floor, lane, paint — which is honest and
     * dull. Every real pit lane is the most colourful thing on the site
     * because each box belongs to somebody, so each of these gets a panel in
     * its own colour. Inset so the white markings still read as markings
     * rather than as the edge of a coloured rectangle.
     */
    inset: 0.55,
  },
  /**
   * The jacks under Chick, and how far off the ground they put him.
   *
   * `reach` is measured along the CAR, which in a box is the `across` axis —
   * a car pointing out at the lane lies that way.
   *
   * `rise` is used twice and must be: the pads are drawn at it and the car is
   * lifted by it, so if they disagree he either floats or sinks into them.
   */
  jack: { rise: 0.46, pad: 0.5, post: 0.16, reach: 1.7 },
  /** The fuel rig: a drum on a stand with a hose loop, at the back of box 1. */
  rig: { along: 155, across: 215.4, radius: 0.52, height: 2.3, stand: 0.55 },
  /** The tool trolley, at the back of box 1. */
  trolley: { along: 160.5, across: 215.2, width: 1.5, depth: 0.7, height: 0.95 },
  /** Spare tyres, as stacks of `courses`, staged at the back of box 3. */
  spares: [
    { along: 174.2, across: 215.3, courses: 4 },
    { along: 176.4, across: 215.3, courses: 3 },
    { along: 178.6, across: 215.3, courses: 4 },
  ] as const,
  /** The pit board, hung out over the wall on a pole. */
  board: { along: 165, across: 229.7, height: 2.4, width: 0.9, tall: 1.2, post: 0.09 },
  /** Lamps and a bin, from the park's own kit, along the paddock edge. */
  lamps: [
    { along: 153.9, across: 212.9 },
    { along: 180.1, across: 212.9 },
  ] as const,
  bin: { along: 167, across: 212.9 },
  /**
   * Crowd barriers on the PADDOCK side only, facing the people.
   *
   * The track side gets a pit wall instead. Using the two for what they are
   * actually for is the whole difference between this and the last attempt,
   * where a run of plastic barriers was doing a concrete wall's job.
   */
  barrier: { across: 211.6, from: 157, to: 177, pitch: 2.1 },
  /**
   * Who is in the lane, and what they are doing.
   *
   * Box 1 is a live stop: Chick up on the jacks, Guido at his flank, the rig
   * and the trolley behind him. Boxes 2 and 3 are empty, and that is not an
   * oversight — the rest of the cast is dotted round the park now (see `CAST`)
   * rather than queued up in here, and a pit lane with one stop running and
   * two bays standing ready reads as a working pit. Three cars parked in three
   * boxes read as a showroom.
   *
   * `lift` is why this is a separate list from `CAST`: a car standing about sits on
   * the ground and a car on jacks does not. Chick is perfectly still — a car
   * being worked on does not bounce — and the others keep a bob scaled to how
   * busy they are.
   */
  crew: [
    { part: 'chick', along: 158, across: 219.4, turn: Math.PI, lift: 0.46, hop: 0, rate: 1, phase: 0 },
    { part: 'guido', along: 161, across: 219.4, turn: Math.PI / 2, lift: 0, hop: 0.07, rate: 6.4, phase: 1.1 },
  ] as const,
} as const;

/**
 * THE INFIELD LOOP: a branch off the main circuit that rejoins it.
 *
 * Not a second track somewhere else in the park — there is nowhere left to put
 * one, and a circuit fifty metres from another circuit reads as two
 * half-finished things rather than one of each. This starts on the speedway,
 * cuts across the infield and comes back onto the speedway, which is how
 * every real alternative layout works: Silverstone's national loop and the
 * Nurburgring's sprint course are both this and nothing more.
 *
 * NOTHING RUNS ON IT. There is no `cars` list here and none are drawn. The
 * field stays on the oval; this is a line to look at and to drive yourself.
 *
 * ## The two mouths
 *
 * `leave` and `join` are arc distances on the main circuit, and the order is
 * the direction of travel: a car is on the main line from `join` forward to
 * `leave` and could be on this for the rest. 255 is on the west straight and
 * 159 on the east one, so the loop cuts off the whole low-`across` end — the
 * far hairpin, the start line and the jump.
 *
 * Leaving at 255 rather than later is the jump's doing. A branch leaves
 * tangentially, so for the first twenty metres it is still within a few of
 * the straight; turning off at 275 put it 2.9 m from the take-off ramp's
 * parapet, which fused the two into one lumpy surface. 255 gives it 42 m of
 * straight to peel away in and it clears the jump by 14.4 m.
 *
 * ## What moved for it
 *
 * A floodlight mast stood at (188, 175), dead on the loop's line at the
 * bottom of the arc, and three of the crowd — Fillmore, Sally and Sheriff —
 * sat at across 168, which is where the loop's kerb now runs. The mast went to
 * (168, 190), inside the loop where it lights both routes, and the three of
 * them went back to across 157. Check that before moving anything else into
 * the infield: the loop takes a band of it that used to be empty.
 */
export const LOOP = {
  leave: 255,
  join: 159,
  /** A little narrower than the speedway's 6.5 — it is the slower way round. */
  width: 5.5,
  kerb: 0.42,
  lift: 0.012,
  /** Rumble strips anywhere the radius is under this. */
  rumbleUnder: 30,
  rumbleBlock: 1.8,
  /**
   * How much of each end is JUNCTION rather than road, in metres.
   *
   * A branch meets a straight tangentially, so for the first twenty-odd
   * metres it is not beside the circuit, it is on it. Asphalt can overlap
   * there and reads as a flared mouth; kerbs cannot, because a kerb drawn
   * across those metres is a white line running over the racing line. So the
   * kerbs start after this and stop before it.
   *
   * Two numbers, not one, for the same reason `kerbGap` needs two: measured,
   * the loop's kerb is still inside the main track for 25.5 m after the leave
   * and 32.5 m before the join. A single 26 left seven metres of it lying
   * across the circuit at the join end.
   */
  mouth: { leave: 27, join: 34 },
  /**
   * How much of the MAIN circuit's inside kerb to leave out at each mouth.
   *
   * This is the fix for the white line that ran straight across the loop where
   * it branched. The speedway's kerb is drawn as one unbroken ribbon round the
   * whole lap, and the loop's asphalt is laid 2 mm under the speedway's so the
   * two do not fight — but the KERB sits a centimetre above both, so it went
   * right over the new road: a white stripe across a junction, which is the
   * one place a road never has one.
   *
   * A real junction has no kerb through it. Each entry is [before, after] in
   * arc distance on the main circuit, and the kerb is simply not drawn between
   * them — on the inside edge only, which is the side the loop leaves from at
   * BOTH mouths.
   *
   * The two are not mirror images and it matters. Measuring where the main
   * kerb line actually comes within a loop half-width of the loop's asphalt:
   * the leave mouth needs 24.5 m AFTER it and nothing before, and the join
   * needs 32 m BEFORE it and nothing after. One symmetric number big enough
   * for the join left ten metres of kerb missing for no reason at the leave;
   * one big enough for the leave left the white line lying across the loop for
   * the last eleven metres of the join. These are those two spans, rounded up.
   */
  kerbGap: { leave: [3, 27] as const, join: [35, 4] as const },
  points: [
    [143.5, 208], [147, 198], [152, 188], [158, 179], [165, 172], [173, 168],
    [181, 167.5], [189, 171], [195, 177.5], [199.6, 186], [201.6, 196], [202, 204],
  ] as const,
} as const;

/**
 * The loop, resampled: arc length to position, and the local radius.
 *
 * Half of what `LAP` is, and only half on purpose — no speed profile and no
 * time table, because nothing drives round this one. See `LOOP`.
 *
 * It is an OPEN spline, not a closed ring, and its first and last three
 * control points are taken off the main circuit rather than written down.
 * That is what makes the mouths tangent: Catmull-Rom through a point aims at
 * its neighbours, so seeding it with where the main line was 16 m and 8 m
 * earlier hands it the main line's own direction to leave on. The seeded ends
 * are then trimmed back off — they are guidance, not road.
 */
export const LOOP_LAP = (() => {
  const ctrl: Array<[number, number]> = [
    LAP.point(LOOP.leave - 16), LAP.point(LOOP.leave - 8), LAP.point(LOOP.leave),
    ...LOOP.points.map((q) => [q[0], q[1]] as [number, number]),
    LAP.point(LOOP.join), LAP.point(LOOP.join + 8), LAP.point(LOOP.join + 16),
  ];
  const m = ctrl.length;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < m - 1; i++) {
    const q = [ctrl[Math.max(0, i - 1)], ctrl[i], ctrl[i + 1], ctrl[Math.min(m - 1, i + 2)]];
    const gap = (a: readonly number[], b: readonly number[]) =>
      Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5 || 1e-4;
    const t = [0, 0, 0, 0];
    for (let k = 1; k < 4; k++) t[k] = t[k - 1] + gap(q[k - 1], q[k]);
    for (let s = 0; s < 60; s++) {
      const tt = t[1] + ((t[2] - t[1]) * s) / 60;
      const L = (a: readonly number[], b: readonly number[], ta: number, tb: number) => [
        ((tb - tt) * a[0] + (tt - ta) * b[0]) / (tb - ta),
        ((tb - tt) * a[1] + (tt - ta) * b[1]) / (tb - ta),
      ];
      const A1 = L(q[0], q[1], t[0], t[1]);
      const A2 = L(q[1], q[2], t[1], t[2]);
      const A3 = L(q[2], q[3], t[2], t[3]);
      pts.push(L(L(A1, A2, t[0], t[2]), L(A2, A3, t[1], t[3]), t[1], t[2]) as [number, number]);
    }
  }
  pts.push(ctrl[m - 1]);
  const nearest = (target: readonly number[]) => {
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.hypot(pts[i][0] - target[0], pts[i][1] - target[1])
        < Math.hypot(pts[best][0] - target[0], pts[best][1] - target[1])) best = i;
    }
    return best;
  };
  const body = pts.slice(nearest(LAP.point(LOOP.leave)), nearest(LAP.point(LOOP.join)) + 1);
  const cum = [0];
  for (let i = 1; i < body.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(body[i][0] - body[i - 1][0], body[i][1] - body[i - 1][1]));
  }
  const length = cum[cum.length - 1];
  const point = (dist: number): [number, number] => {
    const d = Math.min(length, Math.max(0, dist));
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const k = (d - cum[lo]) / Math.max(1e-6, cum[lo + 1] - cum[lo]);
    return [body[lo][0] + (body[lo + 1][0] - body[lo][0]) * k,
      body[lo][1] + (body[lo + 1][1] - body[lo][1]) * k];
  };
  /** Radius, by the circle through three points four metres apart. */
  const radiusAt = (d: number) => {
    const a = point(d - 4);
    const b = point(d);
    const c = point(d + 4);
    const A = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const B = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const C = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const h = (A + B + C) / 2;
    const area = Math.max(1e-6, Math.sqrt(Math.max(0, h * (h - A) * (h - B) * (h - C))));
    return (A * B * C) / (4 * area);
  };
  return { length, point, radiusAt };
})();

/**
 * THE PISTON CUP, and you cannot get to it.
 *
 * It stood at (153, 137) on a knee-high drum beside the way in, which is a
 * trophy on a doorstep: you drove past it, and a car could have driven onto
 * its plinth. A Piston Cup is the thing everything else on this site is for,
 * and the way you say that in a layout is to put it somewhere that takes
 * work to reach and then stop anyone reaching it.
 *
 * So it moved to the middle of the ground the infield loop encloses — the low
 * end of the oval, ringed by the main circuit on three sides and the loop on
 * the fourth. There is no way in that does not cross a kerb.
 *
 * And the plinth grew. It is three drums now, each narrower than the one
 * under it, 3.6 m to the base of the cup: too tall to drive onto and too
 * steep to climb, which is the honest way to make something unreachable
 * rather than fencing it. It reads from the grandstand, from the loop and
 * from the air, which is the other half of the job.
 */
export const TROPHY = {
  along: 176, across: 148, turn: 0,
  /**
   * A trophy plinth, which is a SHAPE and not a stack.
   *
   * It was three drums each a bit narrower than the last — a taper, which
   * from any distance is one cone and reads as a wedding cake. A plinth that
   * looks like a plinth has three distinct jobs in it: a broad base you could
   * stand on, a slim shaft that lifts the thing clear, and a cap that FLARES
   * back out so the cup sits on an overhang rather than balancing on a pole.
   * The flare is the detail that does most of the work.
   *
   * `rise` is the total and the cup is placed at it, so the two cannot drift
   * apart. The tiers must add up to it.
   */
  plinth: {
    rise: 3.6,
    radius: 4.2,
    tiers: [
      { radius: 4.2, rise: 0.45, tread: true },
      { radius: 3.25, rise: 0.45, tread: true },
      { radius: 1.75, rise: 2.2, tread: false },
      { radius: 2.35, rise: 0.5, tread: false },
    ] as const,
    /** A Piston Cup band round the shaft, proud of it. */
    band: { at: 1.55, height: 0.38, over: 0.1 },
  },
} as const;

/** The two extra shops, which the layout table places like everything else. */
export const SHOPS = [
  { part: 'shopA', ...AT.shopA },
  { part: 'shopB', ...AT.shopB },
] as const;

export const PLANTING = {
  /**
   * The rhythm every walk is dressed to: one station every 14 m.
   *
   * Each station gets a tree on both verges and one piece of furniture inside
   * each kerb, dealt from a six-step cycle — bench, lamp, slatted bench,
   * stall, lamp, bin — with the two kerbs three steps out of phase so you are
   * never looking at a matching pair across the avenue. Any one kind repeats
   * every 84 m, which at walking pace is far enough not to read as wallpaper
   * and close enough to read as a place somebody laid out.
   *
   * This replaces five separate rows running at five separate pitches, which
   * is what the last version was and most of why nothing lined up.
   */
  walkPitch: 14,
  /** Furniture stands this far inside a kerb; trees this far outside one. */
  kerbSetback: 2.6,
  vergeSetback: 3.5,
  /** The hub: how far out the planters stand, and the clearance round it. */
  plazaRing: 26,
  plazaClear: 3,
  /**
   * How far back from the road the entrance is kept clear of EVERYTHING.
   *
   * The walk's furniture marches at a fixed pitch from one end to the other,
   * which put two whole stations — benches, lamps, stalls, bins, and a tree
   * on each verge — inside the last twenty metres, plus a sign and an ice
   * cart. You arrived at a gate and had to pick your way through the street
   * furniture. Nothing is placed above this line now; the threshold is bare
   * tiles, which is what a threshold is.
   */
  entryClear: 226,
  /** The loose fill that takes the corners the midway does not reach. */
  fillTrees: 30,
  fillShrubs: 40,
  /** A third pass at three metres, to fill the thin strips between aprons. */
  fillEdging: 90,
  fillSpacing: 9,
  /** Margins a scattered plant keeps off paving and off a ride. */
  offPaving: 2,
  offRide: 4,
} as const;

/**
 * The arcade, fronting the parade walk — the one building in the park.
 *
 * 150 and not 170. At 170 it stood squarely on the cross walk's outer arm,
 * which did not exist when it was placed and now runs from the parade walk to
 * the big top: the route to the tent went through the building. 150 drops it
 * into the pocket between the play spur and that walk, where it fits exactly
 * — its faces land on across 134 and 166, which are the two kerbs.
 */
export const ARCADE = AT.arcade;

/** Every paved rectangle, for the greenery to avoid and the map to draw. */
export const PARK_SURFACES = Object.values(PARK_PAVING);

export const PARK_COLOURS = {
  /**
   * Warmer and paler than the airfield's tarmac: this is a promenade.
   *
   * It multiplies into the flagstone texture now rather than being the
   * surface on its own, so it is near-white: the slab colour lives in the
   * drawing, and a tint darker than this would take it down twice.
   */
  paving: '#efece6',
  /**
   * How many metres one repeat of the paving texture covers.
   *
   * 2.5 m over two courses is a 1.25 m flag, which is a big municipal slab —
   * the right size for a promenade, and coarse enough that the pattern does
   * not turn to noise at the distance most of the park is seen from.
   */
  slab: 2.5,
  kerb: '#8f8a7c',
  grass: '#6f9b52',
} as const;
