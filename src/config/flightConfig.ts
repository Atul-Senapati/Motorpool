/**
 * The airliner's circuit: one lap of the city every two minutes, with a
 * landing and a take-off in the middle of it.
 *
 * ## What it is
 *
 * A 747 flies a standard left-hand traffic pattern round Halcyon Field —
 * climb-out, crosswind, downwind, base, final — except that the downwind leg
 * is thrown three kilometres east so that it crosses the whole city instead of
 * sitting politely beside the runway. That is the point of it: from a street
 * in the middle of town the aeroplane goes over at 340 m every two minutes,
 * and if you are on the island when it comes round you get the landing.
 *
 * It touches down near the south threshold, rolls the length of the runway
 * shedding speed, and gets airborne again off the north end — so it lands at
 * one end and leaves from the other without ever turning round, which is both
 * what was asked for and what a touch-and-go actually looks like.
 *
 * ## How it is described
 *
 * **Nothing here is a world coordinate.** Every point is `along` metres up the
 * runway from its south threshold and `across` metres to the right of it, so
 * the whole circuit is bolted to the runway: move the island (`SITE`) or turn
 * it, and the pattern goes with it. The same discipline the station's town and
 * the airfield itself are built to.
 *
 * `across` is positive toward the CITY, square to the runway. The runway
 * points north-north-east and the city is off its left shoulder, so the
 * pattern is left-handed: a right-hand circuit here would fly its downwind leg
 * out over empty water, which is what it did until the direction was measured
 * rather than assumed.
 *
 * ## The shape of the numbers
 *
 * Three profiles, all read off distance travelled rather than off a clock, so
 * the aeroplane's attitude comes out of its path instead of being animated:
 *
 *   the path    a closed Catmull-Rom through the points below, resampled at a
 *               fixed step into an arc-length table. Heading is the tangent
 *               and BANK is the curvature — `atan(v^2 / g R)`, the coordinated
 *               turn — so it leans into its turns by the amount the turn
 *               actually needs, and rolls level on the straights for free
 *   altitude    its own curve, NOT part of the spline. A spline through the
 *               runway points and a climb-out would sag below the tarmac on
 *               the way in; a separate monotone curve cannot. PITCH is its
 *               gradient, which gives nose-up on rotation and nose-down on
 *               the descent without a keyframe anywhere
 *   speed       72 m/s over the threshold, 45 in the roll-out, 120 downwind.
 *               Real numbers for a 747 at low weight, give or take
 *
 * ## Two minutes
 *
 * The lap is about 12.4 km and the speed profile flies it in roughly that, but
 * "roughly" is not what was asked for. `SPEED_TRIM` is solved at load: the
 * natural lap time is integrated, and every speed is scaled by whatever single
 * factor makes it exactly `LAP_SECONDS`. The shape of the profile — fast
 * downwind, slow over the fence, slowest in the roll-out — is preserved; only
 * the overall pace moves, and by a few percent.
 */
import { RUNWAY, SITE } from './airportConfig';

const TAU = Math.PI * 2;
const G = 9.81;
/**
 * The most the aeroplane will lean, radians. 31 degrees.
 *
 * It was 0.64 — 36.7 degrees — which is exactly what the 747's half circle
 * needs at its written speed, and that is where the number came from. The
 * other two then leaned the same amount, and they should not have: the A400M's
 * turn needs 30 degrees and the ATR's 26. What put them on the limit was
 * `TRIM`, the factor that speeds a circuit up so three aeroplanes can share
 * one cycle — the freighter flies its turn 30% faster than its fixes say, and
 * bank goes as the SQUARE of speed, so 30 degrees became 44 and hit the stop.
 *
 * That extra lean is an artefact of the timetable, not something the aeroplane
 * means, so the stop comes down to 31: the standard maximum for a transport
 * aeroplane in normal handling, and within half a degree of what the A400M's
 * own geometry asks for. The 747 is held just under what its turn wants, which
 * costs it about six degrees of lean and is not visible; being leaned over
 * like a fighter on climb-out was.
 */
const BANK_LIMIT = 0.54;
/** How far the nose sits above and below the flight path, radians. */
const AOA_CLIMB = 0.05;
const AOA_CRUISE = 0.02;
/** And how far it is allowed to get from level either way. */
const PITCH_UP = 0.26;
const PITCH_DOWN = -0.11;
/** How fast the wings can roll, radians a second. */
const ROLL_RATE = 0.105;
/** Over how many metres the bank fades in and out of the ground phase. */
const BANK_FADE = 260;

/** One lap, seconds. */
export const LAP_SECONDS = 120;

/**
 * Where the wheels sit when they are on the runway.
 *
 * `SITE.ground` is the island crown and the paving is laid 60 mm over it
 * (`TARMAC_TOP` in `AirportIsland`), so this is the top of the tarmac. The
 * model is grounded on its tyres — `prepare-plane.mjs` puts y = 0 at the
 * bottom of the wheels — which is what makes this one number rather than a
 * measured offset from the belly.
 */
export const RUNWAY_TOP = SITE.ground + 0.06;

/**
 * A point in the circuit.
 *
 * `along` is metres from the south threshold up the runway; `across` is metres
 * right of the centreline. `alt` is the height of the wheels above sea level,
 * `speed` metres per second.
 */
interface Fix {
  name: string;
  along: number;
  across: number;
  alt: number;
  speed: number;
  /**
   * The path has a sharp point here and the spline is not carried across it.
   *
   * There are exactly two, and both are real: an aeroplane arrives at a stand
   * nose-first and leaves it backwards, and it is pushed back and then taxis
   * forward. At each the aeroplane stops dead and sets off the other way, so
   * a smooth curve through the point would be a lie — and a Catmull-Rom asked
   * to draw one puts a loop there instead.
   */
  corner?: boolean;
  /**
   * This leg is flown BACKWARDS: the nose stays where it is pointing and the
   * aeroplane travels the other way. That is a pushback, and it is the only
   * way to leave a nose-in stand.
   */
  reverse?: boolean;
  /** Seconds to stand still on reaching this fix. */
  hold?: number;
}

/**
 * The circuit, in order, starting at the touchdown point.
 *
 * It is an oval: the runway and its extensions are one straight, a 2 km leg
 * over the city is the other, and two 900 m half-circles join them. The turns
 * carry a fix every 30 degrees and each straight carries four, which is more
 * than it takes to draw the shape and exactly what it takes to draw it
 * *smoothly* — bank is the curvature of this curve, so a spline that merely
 * passes near the right places still rocks the wings. Sparser fixes bowed the
 * downwind leg by 25 m in 2 km, which is nothing in plan and twenty degrees of
 * roll in the air.
 *
 * Collinear fixes on the straights also mean the roll-out and the final
 * approach are dead straight and dead flat without being a special case.
 */
/**
 * The threshold end, which all three aeroplanes do identically.
 *
 * Every departure ends up here: west along the taxiway, down the link onto the
 * runway, round the turn pad and back out facing the way it landed. It was
 * written out three times, in three circuits, with the same eight numbers —
 * and a corner that is wrong is then wrong in three places, which is how the
 * one below survived as long as it did.
 *
 * ## The corner
 *
 * Turning off a westbound taxiway onto a southbound link is a right angle, and
 * `link in` used to be the corner itself: the aeroplane ran to (40, 45) and
 * the next fix was straight down the link. A spline through a right angle with
 * 33 m of spacing is not a turn, it is a kink — measured at 26 deg/s, the
 * sharpest thing left on the field.
 *
 * It is a fillet now. The two centrelines meet at (40, 65), so a circle of
 * radius R tangent to both is centred at (40 + R, 65 − R) and touches them at
 * (40 + R, 65) and (40, 65 − R); R = 32 is the largest that keeps the whole
 * sweep, wheel track included, on the link, the taxiway and `lineUpFillet`
 * between them. That is 10.7 deg/s at 6 m/s.
 *
 * The turn pad beyond it is unchanged: 45 m radius, which is what a 747 turns
 * in, and why the pad is there at all — a link is 18 m wide.
 */
const THRESHOLD_TURNAROUND: readonly Fix[] = [
  { name: 'link in', along: 72, across: 65, alt: RUNWAY_TOP, speed: 6 },
  { name: 'link arc', along: 49.4, across: 55.6, alt: RUNWAY_TOP, speed: 5.5 },
  { name: 'link out', along: 40, across: 33, alt: RUNWAY_TOP, speed: 5 },
  { name: 'link end', along: 40, across: 12, alt: RUNWAY_TOP, speed: 5 },
  { name: 'pad turn', along: 35, across: -18, alt: RUNWAY_TOP, speed: 4 },
  { name: 'pad apex', along: 58, across: -38, alt: RUNWAY_TOP, speed: 4 },
  { name: 'pad out', along: 98, across: -33, alt: RUNWAY_TOP, speed: 5 },
  { name: 'line up', along: 128, across: -13, alt: RUNWAY_TOP, speed: 7 },
];

const JET_FIXES: readonly Fix[] = [
  // ======================= ON THE GROUND =======================
  // Touchdown, then the roll-out, braking to a taxi speed by the middle of
  // the runway so it can take the mid-field exit rather than run the full
  // 840 m and taxi all the way back.
  { name: 'touchdown', along: 70, across: 0, alt: RUNWAY_TOP, speed: 72 },
  { name: 'rollout', along: 250, across: 0, alt: RUNWAY_TOP, speed: 50 },
  { name: 'brake', along: 370, across: 0, alt: RUNWAY_TOP, speed: 20 },
  // Off at the middle link — `TAXIWAY.links` puts one at along 420 — and onto
  // the parallel taxiway, which is `across` 65.
  { name: 'exit', along: 415, across: 8, alt: RUNWAY_TOP, speed: 10 },
  { name: 'exit turn', along: 445, across: 38, alt: RUNWAY_TOP, speed: 8 },
  { name: 'taxiway', along: 455, across: 65, alt: RUNWAY_TOP, speed: 11 },
  // Onto the stand. The last leg is dead square to the terminal so the nose
  // ends up pointing at the building rather than 30 degrees off it.
  { name: 'stand line', along: 464, across: 96, alt: RUNWAY_TOP, speed: 6 },
  { name: 'stand', along: 464, across: 124, alt: RUNWAY_TOP, speed: 3.2, corner: true, hold: 18, reverse: true },
  // Pushback: straight back off the stand, then swung round to face the way
  // it will taxi. Flown in reverse, so the nose stays on the terminal while
  // the aeroplane moves away from it.
  { name: 'push', along: 464, across: 92, alt: RUNWAY_TOP, speed: 3.4, reverse: true },
  { name: 'push turn', along: 498, across: 68, alt: RUNWAY_TOP, speed: 3.6, reverse: true },
  { name: 'push end', along: 520, across: 66, alt: RUNWAY_TOP, speed: 3, corner: true, hold: 3 },
  // Taxi out, down the length of the terminal to the threshold end.
  { name: 'taxi out', along: 380, across: 65, alt: RUNWAY_TOP, speed: 15 },
  { name: 'taxi hold', along: 150, across: 65, alt: RUNWAY_TOP, speed: 15 },
  // Down the threshold link onto the runway, round the pad, and back out.
  ...THRESHOLD_TURNAROUND,
  // Rolling.
  { name: 'roll start', along: 180, across: 0, alt: RUNWAY_TOP, speed: 16 },
  { name: 'roll', along: 450, across: 0, alt: RUNWAY_TOP, speed: 50 },
  { name: 'rotate', along: 720, across: 0, alt: RUNWAY_TOP, speed: 84 },
  // ======================= IN THE AIR =======================
  //
  // Two half-circles of 750 m joined by two straights: 1,500 m wide, and as
  // tight as a pattern gets. The turning is the floor on how long the sky
  // part can be — a 180 at a 37 degree bank takes pi*sqrt(R / g tan 37)
  // whatever the speed, because flying it faster needs a bigger radius to
  // hold the bank. Two of them is a minute on its own.
  //
  // Both arcs carry a fix every 30 degrees, on the circle, with the tangent
  // points included. Getting that wrong is not subtle: an earlier cut had the
  // inbound arc's points off the circle and the aeroplane yawed at 39 degrees
  // a second going round it, which is a 110 m turn, not a 750 m one.
  //
  /*
   * --- outbound half-circle, centre (1350, 750) ---
   *
   * The centre used to be at 1050, and where the centre is decides how high
   * the aeroplane is when it starts to lean. The half circle is tangent to the
   * runway centreline at the fix directly abeam its centre, so `climb` IS the
   * point the turn begins — and it sat at 74 m. Measured, the wings were
   * through 15 degrees at 50 m and pinned at the 36.7 degree limit by 100.
   * Nothing is wrong with the roll or the turn; the turn simply started while
   * the aeroplane was still over the far end of its own runway.
   *
   * A real departure climbs straight ahead to 400 ft and turns there. Moving
   * the centre out to 1350 puts the tangent point 630 m past rotation, and
   * 122 m up that straight is an 11 degree gradient — so the lean arrives with
   * the height instead of 250 ft before it.
   *
   * 11 degrees and not 14. Climbing to the same 400 ft in the 560 m of a
   * smaller shift needs 14, and 14 plus the climb angle of attack is 16.9,
   * which is past `PITCH_UP`: the nose then sits ON the clamp for the whole
   * climb, dead flat at 14.9 degrees, which is its own kind of wrong. The
   * gradient has to leave room for the angle of attack, so the length of the
   * straight is what buys the height, not the steepness of it.
   */
  { name: 'climb', along: 1350, across: 0, alt: 122, speed: 92 },
  { name: 'crosswind turn', along: 1725, across: 100, alt: 190, speed: 82 },
  { name: 'crosswind', along: 2000, across: 375, alt: 245, speed: 76 },
  { name: 'crosswind top', along: 2100, across: 750, alt: 285, speed: 74 },
  { name: 'downwind turn', along: 2000, across: 1125, alt: 302, speed: 76 },
  { name: 'downwind roll', along: 1725, across: 1400, alt: 308, speed: 82 },
  { name: 'downwind entry', along: 1350, across: 1500, alt: 310, speed: 90 },
  // --- downwind: 1.7 km over the western city, and the fastest part of the
  // lap, which is what buys back the time the turns cost ---
  { name: 'downwind', along: 200, across: 1500, alt: 310, speed: 108 },
  { name: 'downwind exit', along: -650, across: 1500, alt: 300, speed: 88 },
  // --- inbound half-circle, centre (-650, 750) ---
  { name: 'base turn', along: -1025, across: 1400, alt: 280, speed: 80 },
  { name: 'base entry', along: -1300, across: 1125, alt: 240, speed: 76 },
  { name: 'base', along: -1400, across: 750, alt: 190, speed: 74 },
  { name: 'base exit', along: -1300, across: 375, alt: 140, speed: 76 },
  { name: 'final turn', along: -1025, across: 100, alt: 100, speed: 78 },
  { name: 'final', along: -650, across: 0, alt: 78, speed: 76 },
  { name: 'short final', along: -300, across: 0, alt: 26, speed: 72 },
];

/* ------------------------------------------------------------- the runway */

/**
 * The runway's own frame in the world: its south threshold, the unit vector up
 * it, and the unit vector to its right.
 *
 * Derived from the airport's site and its runway offset rather than written
 * down, so the circuit cannot drift from the tarmac it is flown to.
 */
const cosH = Math.cos(SITE.heading);
const sinH = Math.sin(SITE.heading);
/** Local airfield coordinates to world XZ — the same mapping `AirportIsland` draws in. */
const toWorld = (x: number, z: number): [number, number] => [
  SITE.centre[0] + x * cosH + z * sinH,
  SITE.centre[1] - x * sinH + z * cosH,
];

export const THRESHOLD = toWorld(-RUNWAY.half, RUNWAY.centre);
const FAR_END = toWorld(RUNWAY.half, RUNWAY.centre);
const runLen = Math.hypot(FAR_END[0] - THRESHOLD[0], FAR_END[1] - THRESHOLD[1]);
/** Unit vector up the runway, in the landing direction. */
export const RUN_DIR: [number, number] = [
  (FAR_END[0] - THRESHOLD[0]) / runLen,
  (FAR_END[1] - THRESHOLD[1]) / runLen,
];
/**
 * Unit vector from the runway toward the city, square to it.
 *
 * The runway points north-north-east and the city is off its LEFT shoulder —
 * everything to the right of it is open water. So the pattern is left-handed,
 * and this, not the geometric right, is what `across` is measured along. Get
 * this the wrong way round and the whole circuit is flown over empty sea,
 * which is exactly what it did before it was measured.
 */
export const RUN_CITY: [number, number] = [-RUN_DIR[1], RUN_DIR[0]];

const fixWorld = (f: Fix): [number, number] => [
  THRESHOLD[0] + RUN_DIR[0] * f.along + RUN_CITY[0] * f.across,
  THRESHOLD[1] + RUN_DIR[1] * f.along + RUN_CITY[1] * f.across,
];

/* --------------------------------------------------------------- the path */

/** How finely the spline is resampled, metres. */
const STEP = 5;

export interface FlightSample {
  x: number;
  z: number;
  /** Height of the wheels above sea level. */
  y: number;
  /** Heading, radians, as `atan2(dx, dz)` of the direction of travel. */
  heading: number;
  /** Positive is right wing down, radians. */
  bank: number;
  /** Positive is nose up, radians. */
  pitch: number;
  speed: number;
  gearDown: boolean;
  onGround: boolean;
  /** Being pushed back off the stand — travelling tail-first. */
  reverse: boolean;
}

/**
 * Centripetal Catmull-Rom through four points, at parameter `t` in [0, 1] of
 * the middle span.
 *
 * Centripetal — knots spaced by the square root of the chord — rather than the
 * uniform form, because the fixes are not evenly spaced: the 370 m from
 * rotation to the start of the turn sits next to 700 m arcs, and uniform
 * Catmull-Rom answers that by bulging out of the short span. The bulge is
 * invisible in plan and glaring in the air, because bank is the curvature of
 * this curve — the aeroplane rocks its wings on what should be a steady turn.
 */
const spline = (
  p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], t: number,
): [number, number] => {
  const knot = (t0: number, a: [number, number], b: [number, number]) =>
    t0 + Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || t0 + 1e-4;
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const t12 = t1 + (t2 - t1) * t;
  const lerp = (a: [number, number], b: [number, number], ta: number, tb: number, at: number):
    [number, number] => {
    const f = (at - ta) / (tb - ta || 1);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const a1 = lerp(p0, p1, t0, t1, t12);
  const a2 = lerp(p1, p2, t1, t2, t12);
  const a3 = lerp(p2, p3, t2, t3, t12);
  const b1 = lerp(a1, a2, t0, t2, t12);
  const b2 = lerp(a2, a3, t1, t3, t12);
  return lerp(b1, b2, t1, t2, t12);
};

/**
 * The circuit, resampled at a fixed step with its arc length tabulated.
 *
 * Built once at module load. The plan is splined; the altitude and speed are
 * NOT — they are interpolated along the finished arc length, which is what
 * keeps the runway flat and the descent monotone.
 */
/**
 * The legs flown backwards, and the places the aeroplane stands still.
 *
 * Both are read off the fixes rather than written down again: a leg is in
 * reverse when the fix that starts it says so, and a hold sits at the fix's
 * own distance. `HOLDS` is what turns a path into a schedule — without it the
 * aeroplane would glide through its stand at 1.5 m/s and never actually park.
 */
interface Hold {
  at: number;
  seconds: number;
  name: string;
}

/**
 * The ATR 42's circuit.
 *
 * The same airfield, a different aeroplane: it lands shorter, taxis to the
 * stand two along from the jet's, and flies a 1,200 m pattern at turboprop
 * speeds rather than a 1,500 m one at jet speeds. Only the runway is shared,
 * and `SCHEDULE` below is what keeps them off it at the same moment.
 */
const ATR_FIXES: readonly Fix[] = [
  // ======================= ON THE GROUND =======================
  { name: 'touchdown', along: 70, across: 0, alt: RUNWAY_TOP, speed: 50 },
  { name: 'rollout', along: 210, across: 0, alt: RUNWAY_TOP, speed: 32 },
  { name: 'brake', along: 330, across: 0, alt: RUNWAY_TOP, speed: 14 },
  { name: 'turn off', along: 400, across: 0, alt: RUNWAY_TOP, speed: 7 },
  /*
   * It lands going east and parks to the WEST, so it has to turn round — and
   * the old fixes turned it round on the spot. It left the runway heading
   * north-east, reached the taxiway, and then the very next fix was 95 m due
   * west: a 110 degree reversal with ten metres to do it in, measured at
   * 60 deg/s, the sharpest rotation anywhere in the sim.
   *
   * A turnaround between two parallel lines is not a free shape. The runway
   * centreline and the taxiway centreline are 65 m apart, so a half circle
   * joining them has radius 32.5 — that number is the geometry's, not a
   * preference — and the only choice left is how fast to take it. At 5 m/s it
   * is 8.8 deg/s, and the aeroplane rolls out of the exit already pointing the
   * way it is going to taxi.
   *
   * It swings out to along 469, which is why `PAVING.exitFillet` now reaches
   * that far: the turn is on tarmac including the wheel track, not over it.
   */
  { name: 'exit', along: 437, across: 0, alt: RUNWAY_TOP, speed: 5 },
  { name: 'exit arc', along: 453.3, across: 4.4, alt: RUNWAY_TOP, speed: 5 },
  { name: 'exit cross', along: 465.1, across: 16.2, alt: RUNWAY_TOP, speed: 5 },
  { name: 'exit apex', along: 469.5, across: 32.5, alt: RUNWAY_TOP, speed: 5 },
  { name: 'exit back', along: 465.1, across: 48.7, alt: RUNWAY_TOP, speed: 5 },
  { name: 'exit join', along: 453.3, across: 60.6, alt: RUNWAY_TOP, speed: 5.5 },
  // West along the taxiway to its own stand — two lead-in lines along from
  // the jet's, so neither aeroplane is ever parked where the other is going.
  { name: 'taxiway', along: 437, across: 65, alt: RUNWAY_TOP, speed: 8 },
  // A 30 m fillet onto the lead-in, for the reason the exit got one: the
  // corner it replaces was 40 deg/s.
  { name: 'stand approach', along: 338, across: 65, alt: RUNWAY_TOP, speed: 5 },
  { name: 'stand fillet', along: 323, across: 69, alt: RUNWAY_TOP, speed: 4 },
  { name: 'stand turn', along: 312, across: 80, alt: RUNWAY_TOP, speed: 3.5 },
  { name: 'stand line', along: 308, across: 95, alt: RUNWAY_TOP, speed: 3 },
  { name: 'stand', along: 308, across: 124, alt: RUNWAY_TOP, speed: 2.6, corner: true, hold: 20, reverse: true },
  /*
   * Pushed back and swung EAST, so it ends up facing the way it taxis.
   *
   * This used to curve west, which is the way it is going — and reversing
   * keeps the nose where it is pointing, so an aeroplane pushed backwards to
   * the west ends up facing east and then spins on the spot to leave.
   * Measured, 102 deg/s at six knots. The freighter had the same fault and
   * the same cure: the tug swings the tail, not the nose.
   */
  { name: 'push', along: 308, across: 96, alt: RUNWAY_TOP, speed: 2.8, reverse: true },
  { name: 'push swing', along: 316, across: 82, alt: RUNWAY_TOP, speed: 3, reverse: true },
  { name: 'push turn', along: 328, across: 71, alt: RUNWAY_TOP, speed: 3, reverse: true },
  { name: 'push end', along: 346, across: 67, alt: RUNWAY_TOP, speed: 2.6, corner: true, hold: 3 },
  { name: 'taxi back', along: 250, across: 65, alt: RUNWAY_TOP, speed: 11 },
  { name: 'taxi out', along: 150, across: 65, alt: RUNWAY_TOP, speed: 13 },
  ...THRESHOLD_TURNAROUND,
  { name: 'roll start', along: 170, across: 0, alt: RUNWAY_TOP, speed: 12 },
  { name: 'roll', along: 380, across: 0, alt: RUNWAY_TOP, speed: 34 },
  // A turboprop is off in well under half the runway.
  { name: 'rotate', along: 560, across: 0, alt: RUNWAY_TOP, speed: 52 },
  // ======================= IN THE AIR =======================
  // 1,200 m wide on a 600 m radius: tighter than the jet's, which a slower
  // aeroplane can hold at the same bank.
  // Centre 1190, for the reason the jet's is 1350: the turn starts where the
  // half circle touches the centreline, and that wants to be at 400 ft.
  { name: 'climb', along: 1190, across: 0, alt: 122, speed: 60 },
  { name: 'crosswind turn', along: 1490, across: 80, alt: 160, speed: 58 },
  { name: 'crosswind', along: 1710, across: 300, alt: 188, speed: 55 },
  { name: 'crosswind top', along: 1790, across: 600, alt: 207, speed: 54 },
  { name: 'downwind turn', along: 1710, across: 900, alt: 218, speed: 55 },
  { name: 'downwind roll', along: 1490, across: 1120, alt: 223, speed: 58 },
  { name: 'downwind entry', along: 1190, across: 1200, alt: 225, speed: 62 },
  { name: 'downwind', along: 150, across: 1200, alt: 225, speed: 74 },
  { name: 'downwind exit', along: -600, across: 1200, alt: 218, speed: 62 },
  { name: 'base turn', along: -900, across: 1120, alt: 200, speed: 58 },
  { name: 'base entry', along: -1120, across: 900, alt: 170, speed: 55 },
  { name: 'base', along: -1200, across: 600, alt: 135, speed: 54 },
  { name: 'base exit', along: -1120, across: 300, alt: 100, speed: 55 },
  { name: 'final turn', along: -900, across: 80, alt: 72, speed: 56 },
  { name: 'final', along: -600, across: 0, alt: 56, speed: 54 },
  { name: 'short final', along: -280, across: 0, alt: 20, speed: 51 },
];

/**
 * The A400M's circuit: the cargo apron, and the far end of the runway.
 *
 * It does not go where the other two go, and that is the point of having it.
 * The airliners land, take the mid-field exit and taxi to the terminal gates;
 * a freighter lands, runs most of the runway out, turns off at the FAR end and
 * taxis a hundred metres to the cargo apron by the freight sheds — which is
 * where the east end of this field was built to be used and, until now, was
 * only ever looked at.
 *
 * `along` is metres from the threshold and `across` is metres from the runway
 * centreline toward the landside, the same frame the other two use; the cargo
 * stand at island (340, 10) is `along` 760, `across` 130.
 *
 * Its speeds sit between the other two throughout — heavier and slower than
 * the ATR, lighter and more agile than the 747 — and its circuit is wider than
 * the turboprop's and tighter than the jet's, for the same reason.
 */
const CARGO_FIXES: readonly Fix[] = [
  // ======================= ON THE GROUND =======================
  { name: 'touchdown', along: 80, across: 0, alt: RUNWAY_TOP, speed: 58 },
  { name: 'rollout', along: 260, across: 0, alt: RUNWAY_TOP, speed: 40 },
  { name: 'brake', along: 440, across: 0, alt: RUNWAY_TOP, speed: 18 },
  // Past the mid-field exit the other two take, and off at the end.
  { name: 'run out', along: 600, across: 0, alt: RUNWAY_TOP, speed: 11 },
  /*
   * ONE seventy-metre arc from the centreline to the stand.
   *
   * This used to be a corner and then another corner: off the runway heading
   * north, a right angle onto the cargo taxilane, forty-five metres east, and
   * a second right angle onto the stand lead-in. Each of those turns had about
   * thirty metres of fix spacing to happen in, and a curve through three
   * points that far apart cannot be gentler than the points are — measured,
   * 45 deg/s and 33 deg/s at taxi speed, where the 747 never exceeds 19.
   *
   * The cure is not more fixes in the same place; it is a bigger turn. The
   * runway centreline and the stand lead-in are at right angles, so ONE arc
   * tangent to both joins them, and the only free number is its radius. At 70 m
   * the whole exit is a single continuous sweep at 6.5 deg/s, which is what a
   * loaded freighter turning off at the end of the runway actually looks like.
   *
   * The radius is 100 m because that is the one that lands on the stand that
   * already existed. An arc tangent to across 0 at along 660 leaves heading
   * north at along 660 + R, and the cargo stand is at along 760 — so R = 100
   * puts the exit on the stand's lead-in line without moving the stand, the
   * freight yard or the service vehicles drawn up beside it. Choosing 70
   * instead would have dragged all of them 30 m west to chase the path.
   *
   * `PAVING.cargoExit` is the throat this crosses, and it was sized from the
   * arc: the sweep is between the runway and the taxiway from island x 303 to
   * 330, and the pavement is that plus the wheel track either side.
   */
  { name: 'exit', along: 660, across: 0, alt: RUNWAY_TOP, speed: 8 },
  { name: 'exit arc', along: 694.2, across: 6, alt: RUNWAY_TOP, speed: 8 },
  { name: 'ramp throat', along: 724.3, across: 23.4, alt: RUNWAY_TOP, speed: 7.5 },
  { name: 'ramp cross', along: 741.9, across: 42.6, alt: RUNWAY_TOP, speed: 7 },
  { name: 'ramp', along: 754, across: 65.8, alt: RUNWAY_TOP, speed: 6.5 },
  { name: 'ramp turn', along: 758.5, across: 82.6, alt: RUNWAY_TOP, speed: 6 },
  // Out of the arc heading north, and straight up the lead-in to the stand.
  { name: 'stand approach', along: 760, across: 100, alt: RUNWAY_TOP, speed: 5 },
  { name: 'stand line', along: 760, across: 115, alt: RUNWAY_TOP, speed: 4 },
  { name: 'stand', along: 760, across: 130, alt: RUNWAY_TOP, speed: 2.5, corner: true, hold: 26, reverse: true },
  /*
   * Pushed back off the stand, and pushed back the RIGHT WAY.
   *
   * Reversing means the nose stays where it is pointing while the aeroplane
   * travels the other way — so an aeroplane pushed backwards to the west ends
   * up facing east, and then has to spin 162 degrees on the spot to taxi west.
   * Measured, that snap was 116 deg/s at seven knots, which is the sort of
   * thing you see once and cannot unsee.
   *
   * A tug does not do that. It pushes the aeroplane back and swings the tail
   * so that it ends up facing the way it is about to go. So the push curves
   * EAST: the last reverse leg travels east-north-east, which leaves the nose
   * pointing west-north-west, and the turn onto the taxiway is a few degrees
   * rather than most of a half circle.
   *
   * There are three reverse legs rather than two because the nose has about
   * ninety degrees to come round and the legs are what spread it. On two legs
   * the last step was still 28 degrees, and it lands at `push end`, which is a
   * corner — so the whole of it arrives at once, measured at 31 deg/s. Four
   * bearings (south, south-south-east, south-east, east-south-east) take the
   * nose round in steps of about 23 degrees over 6 to 11 seconds each, and
   * leave 15 for the corner.
   */
  { name: 'push', along: 760, across: 98, alt: RUNWAY_TOP, speed: 2.8, reverse: true },
  { name: 'push swing', along: 766, across: 84, alt: RUNWAY_TOP, speed: 3, reverse: true },
  { name: 'push turn', along: 772, across: 72, alt: RUNWAY_TOP, speed: 3, reverse: true },
  { name: 'push end', along: 790, across: 68, alt: RUNWAY_TOP, speed: 2.6, corner: true, hold: 3 },
  { name: 'taxi west', along: 700, across: 65, alt: RUNWAY_TOP, speed: 11 },
  // The long taxi back: the whole length of the field to the threshold end.
  { name: 'taxi long', along: 540, across: 65, alt: RUNWAY_TOP, speed: 15 },
  { name: 'taxi mid', along: 330, across: 65, alt: RUNWAY_TOP, speed: 15 },
  { name: 'taxi out', along: 150, across: 65, alt: RUNWAY_TOP, speed: 13 },
  ...THRESHOLD_TURNAROUND,
  { name: 'roll start', along: 170, across: 0, alt: RUNWAY_TOP, speed: 12 },
  { name: 'roll', along: 420, across: 0, alt: RUNWAY_TOP, speed: 42 },
  // A loaded freighter uses more runway than a turboprop and less than a 747.
  { name: 'rotate', along: 640, across: 0, alt: RUNWAY_TOP, speed: 60 },
  // ======================= IN THE AIR =======================
  // 1,400 m wide on a 700 m radius, between the other two.
  // Centre 1270, so the lean arrives with the height — see the jet's.
  { name: 'climb', along: 1270, across: 0, alt: 122, speed: 68 },
  { name: 'crosswind turn', along: 1590, across: 95, alt: 165, speed: 66 },
  { name: 'crosswind', along: 1830, across: 350, alt: 198, speed: 64 },
  { name: 'crosswind top', along: 1920, across: 700, alt: 220, speed: 63 },
  { name: 'downwind turn', along: 1830, across: 1050, alt: 235, speed: 64 },
  { name: 'downwind roll', along: 1590, across: 1305, alt: 242, speed: 66 },
  { name: 'downwind entry', along: 1270, across: 1400, alt: 244, speed: 70 },
  { name: 'downwind', along: 150, across: 1400, alt: 244, speed: 82 },
  { name: 'downwind exit', along: -700, across: 1400, alt: 236, speed: 70 },
  { name: 'base turn', along: -1000, across: 1305, alt: 216, speed: 66 },
  { name: 'base entry', along: -1240, across: 1050, alt: 184, speed: 64 },
  { name: 'base', along: -1330, across: 700, alt: 148, speed: 63 },
  { name: 'base exit', along: -1240, across: 350, alt: 110, speed: 64 },
  { name: 'final turn', along: -1000, across: 95, alt: 78, speed: 65 },
  { name: 'final', along: -700, across: 0, alt: 60, speed: 63 },
  { name: 'short final', along: -320, across: 0, alt: 22, speed: 60 },
];

/* ------------------------------------------------------- one whole circuit */

/**
 * Everything one aeroplane needs, built from one list of fixes.
 *
 * There are two aeroplanes on this airfield and they are not the same shape,
 * not the same speed and must not want the runway at the same moment, so the
 * circuit is a THING rather than a module: `makeCircuit` is called twice and
 * each caller gets its own track, attitude tables, holds and `flightAt`.
 *
 * Everything above this line is shared — the runway frame, the spline, the
 * limits an aeroplane obeys. Everything below is per-circuit.
 */
export interface Circuit {
  name: string;
  lapLength: number;
  holds: readonly Hold[];
  cycleSeconds: number;
  rollingSeconds: number;
  holdSeconds: number;
  groundFrom: number;
  groundTo: number;
  fixes: number;
  at: (distance: number) => FlightSample;
}

export function makeCircuit(
  name: string, FIXES: readonly Fix[], targetSeconds?: number,
): Circuit {
  const TRACK = (() => {
    const n = FIXES.length;
    const plan = FIXES.map(fixWorld);
    /** Dense samples of the closed spline, and the fix-parameter at each. */
    const dense: Array<{ x: number; z: number; u: number }> = [];
    // Fine enough that the polyline is smoother than the STEP resampling that
    // follows it. Coarse dense sampling leaves a kink at every node, and bank is
    // the second derivative of this curve — the kinks come back as a wing-rock
    // of twenty degrees on a leg that is straight to within 25 m in 2 km.
    const PER = 400;
    for (let i = 0; i < n; i++) {
      const here = FIXES[i];
      const next = FIXES[(i + 1) % n];
      const p1 = plan[i];
      const p2 = plan[(i + 1) % n];
      // A span that touches a corner is drawn STRAIGHT. Splining across one puts
      // a loop where the aeroplane is supposed to stop and set off backwards —
      // Catmull-Rom cannot draw a cusp and will draw a curl instead.
      if (here.corner || next.corner) {
        for (let k = 0; k < PER; k++) {
          const t = k / PER;
          dense.push({ x: p1[0] + (p2[0] - p1[0]) * t, z: p1[1] + (p2[1] - p1[1]) * t, u: i + t });
        }
        continue;
      }
      // Neighbours are clamped at a corner, so the curve either side of one is
      // shaped by the straight leg rather than by whatever is beyond it.
      const p0 = FIXES[(i - 1 + n) % n].corner ? p1 : plan[(i - 1 + n) % n];
      const p3 = FIXES[(i + 2) % n].corner ? p2 : plan[(i + 2) % n];
      for (let k = 0; k < PER; k++) {
        const t = k / PER;
        const [x, z] = spline(p0, p1, p2, p3, t);
        dense.push({ x, z, u: i + t });
      }
    }
    // Arc length along the dense samples, then resample at STEP.
    const cum = [0];
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1];
      const b = dense[i % dense.length];
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const total = cum[dense.length];
    const count = Math.max(64, Math.round(total / STEP));
    const step = total / count;
    const xs = new Float64Array(count);
    const zs = new Float64Array(count);
    const us = new Float64Array(count);
    let j = 0;
    for (let i = 0; i < count; i++) {
      const s = i * step;
      while (j < dense.length - 1 && cum[j + 1] < s) j++;
      const span = cum[j + 1] - cum[j] || 1;
      const t = (s - cum[j]) / span;
      const a = dense[j];
      const b = dense[(j + 1) % dense.length];
      xs[i] = a.x + (b.x - a.x) * t;
      zs[i] = a.z + (b.z - a.z) * t;
      us[i] = a.u + (b.u - a.u < 0 ? (b.u + n - a.u) : (b.u - a.u)) * t;
    }
    return { xs, zs, us, step, count, total };
  })();

  /** The lap, metres. */
  const LAP_LENGTH = TRACK.total;

  /** Smooth step, so a profile changes without a corner in it. */
  const ease = (t: number) => t * t * (3 - 2 * t);

  /**
   * Altitude and speed at a fix-parameter, eased between neighbouring fixes.
   *
   * Along the arc rather than along the spline parameter, and eased rather than
   * linear: a linear altitude ramp gives a kink in the pitch at every fix, which
   * on an aeroplane reads as a twitch.
   */
  function profileAt(u: number, key: 'alt' | 'speed'): number {
    const n = FIXES.length;
    const i = Math.floor(u) % n;
    const t = u - Math.floor(u);
    const a = FIXES[i][key];
    const b = FIXES[(i + 1) % n][key];
    return a + (b - a) * ease(t);
  }

  /**
   * The whole lap integrated, to find the factor that makes it `LAP_SECONDS`.
   *
   * The profile above is written in honest aeroplane speeds and comes out a few
   * percent off two minutes; rather than nudge fourteen numbers until the clock
   * agrees, one factor is solved for here and the shape is left alone.
   */
  const SPEED_TRIM = (() => {
    let seconds = 0;
    for (let i = 0; i < TRACK.count; i++) {
      seconds += TRACK.step / Math.max(1, profileAt(TRACK.us[i], 'speed'));
    }
    return seconds / LAP_SECONDS;
  })();

  /* ------------------------------------------------------------ gear timing */

  /**
   * Where the wheels come down and go up, as distance along the lap.
   *
   * Measured from the fixes rather than from an altitude test, because an
   * altitude test cannot tell a descent from a climb and would put the gear down
   * on the way out. The wheels come down on the base leg and come up ten seconds
   * after lift-off, which is about what a 747 does.
   */
  /** The track sample a fix falls on. */
  const cornerSample = (index: number): number => {
    for (let i = 0; i < TRACK.count; i++) if (TRACK.us[i] >= index) return i;
    return 0;
  };

  const fixDistance = (name: string): number => {
    const index = FIXES.findIndex((f) => f.name === name);
    for (let i = 0; i < TRACK.count; i++) if (TRACK.us[i] >= index) return i * TRACK.step;
    return 0;
  };
  const GEAR_DOWN_AT = fixDistance('base turn');
  const GEAR_UP_AT = fixDistance('climb') * 0.55 + fixDistance('rotate') * 0.45;

  const HOLDS: readonly Hold[] = FIXES
    .filter((f) => f.hold)
    .map((f) => ({ at: fixDistance(f.name), seconds: f.hold ?? 0, name: f.name }));

  /**
   * How long one cycle takes: the rolling part, plus the standing part.
   *
   * `SPEED_TRIM` is computed and deliberately NOT applied — taxi speeds want to
   * be the speeds a 747 actually taxis at, not scaled so that a clock comes out
   * round. The cycle is as long as it is and the startup line says so.
   */
  /**
   * One factor on every speed, so two aeroplanes can share a period.
   *
   * Left at 1 the speeds are the ones written down, which is what a single
   * circuit wants. Given a target it is solved for instead — because the only
   * way to keep two aeroplanes off one runway FOREVER is to give them the same
   * cycle and a fixed offset. Unequal periods drift, and drifting periods
   * eventually coincide.
   */
  const HOLD_SECONDS = HOLDS.reduce((n, h) => n + h.seconds, 0);
  const TRIM = targetSeconds
    ? (LAP_SECONDS * SPEED_TRIM) / (targetSeconds - HOLD_SECONDS)
    : 1;
  const ROLLING_SECONDS = (LAP_SECONDS * SPEED_TRIM) / TRIM;
  const CYCLE_SECONDS = ROLLING_SECONDS + HOLD_SECONDS;

  const REVERSE_SPANS = FIXES.flatMap((f, i) => {
    if (!f.reverse) return [];
    const from = fixDistance(f.name);
    const to = fixDistance(FIXES[(i + 1) % FIXES.length].name);
    return [[from, to] as const];
  });
  const inReverse = (s: number) => REVERSE_SPANS.some(([from, to]) => s >= from && s < to);
  /** On the tarmac between these two, which is what the roll-out is. */
  /**
   * On the tarmac from the moment the wheels touch to the moment they leave.
   *
   * That is now most of the cycle — roll-out, exit, taxi in, the stand, the
   * pushback, the taxi out, the back-taxi turn and the take-off roll — rather
   * than the 710 m of runway it used to be.
   */
  const GROUND_FROM = fixDistance('touchdown');
  const GROUND_TO = fixDistance('rotate');

  /**
   * Heading and bank at every track sample, built once and smoothed.
   *
   * Differencing the path per frame is what a first cut does, and it rocks the
   * wings on the straights: a Catmull-Rom through hand-placed fixes is never
   * quite straight, and over a 30 m window that residual curve is the same size
   * as the real one. So the curvature is measured over a wide window and then
   * box-filtered twice round the loop, which is a roll-rate limit in all but
   * name — the aeroplane rolls into a turn over a couple of seconds and sits
   * level in between, instead of twitching.
   */
  const ATTITUDE = (() => {
    const { xs, zs, us, count, step } = TRACK;
    const wrap = (i: number) => ((i % count) + count) % count;
    /**
     * Half-width of the tangent window, samples — and it is not one number.
     *
     * 40 m either side is right in the air, where it stops the heading chasing
     * sampling noise. On the ground it is far too wide: the leg that takes the
     * aeroplane onto its stand is 28 m long, so a 40 m window reached back past
     * it into the taxiway and had the 747 parked along the runway heading
     * instead of square to the terminal. Taxiing, 8 m is plenty and the turns
     * come out crisper for it.
     */
    const SPAN_AIR = Math.max(2, Math.round(40 / step));
    const SPAN_GROUND = Math.max(1, Math.round(8 / step));
    const spanAt = (i: number) => {
      const d = i * step;
      return d >= GROUND_FROM && d <= GROUND_TO ? SPAN_GROUND : SPAN_AIR;
    };
    const SPAN = SPAN_AIR;
    const heading = new Float64Array(count);
    const curve = new Float64Array(count);
    const norm = (a: number) => {
      while (a > Math.PI) a -= TAU;
      while (a < -Math.PI) a += TAU;
      return a;
    };
    /**
     * The tangent window is CLAMPED at a corner, never taken across one.
     *
     * A corner is where the aeroplane stops and sets off the other way, so the
     * path either side of it points in opposite directions. Averaging across it
     * gives the average of two opposite vectors, which is a heading pointing at
     * neither: the first cut had the 747 sitting on its stand at 64 degrees to
     * the terminal it was supposed to be nose-in against.
     */
    const corners = FIXES
      .map((f, i) => (f.corner ? cornerSample(i) : -1))
      .filter((i) => i >= 0);
    const clampLow = (i: number, span: number) => {
      let lo = i - span;
      for (const c of corners) if (c <= i && c > lo) lo = c;
      return lo;
    };
    const clampHigh = (i: number, span: number) => {
      let hi = i + span;
      for (const c of corners) if (c >= i && c < hi) hi = c;
      return hi;
    };
    for (let i = 0; i < count; i++) {
      const span = spanAt(i);
      const lo = clampLow(i, span);
      const hi = clampHigh(i, span);
      // At a corner itself the window collapses on one side; use the other.
      const a = lo === i ? i : wrap(lo);
      const b = hi === i ? i : wrap(hi);
      const [fx, fz] = a === b
        ? [xs[wrap(i + 1)] - xs[i], zs[wrap(i + 1)] - zs[i]]
        : [xs[b] - xs[a], zs[b] - zs[a]];
      // The reverse flip is baked in HERE, not applied later.
      //
      // At a corner the stored tangent is the OUTGOING one, and the sample
      // before it holds the incoming one — opposite directions. Flipping after
      // the table is read means `flightAt` interpolates between two headings
      // 180 degrees apart and the aeroplane spins through half a turn in the
      // five metres either side of its own stand, at 850 degrees a second.
      // Flipped here, the table reads 73 degrees on both samples and there is
      // nothing to interpolate.
      heading[i] = Math.atan2(fx, fz) + (inReverse(i * step) ? Math.PI : 0);
    }
    for (let i = 0; i < count; i++) {
      const turn = norm(heading[wrap(i + SPAN)] - heading[wrap(i - SPAN)]);
      curve[i] = turn / (2 * SPAN * step);
    }
    /** Circular box filter, run twice — one pass still leaves corners. */
    const smooth = (src: Float64Array, halfWidth: number) => {
      let out = src;
      for (let pass = 0; pass < 2; pass++) {
        const next = new Float64Array(count);
        for (let i = 0; i < count; i++) {
          let sum = 0;
          for (let k = -halfWidth; k <= halfWidth; k++) sum += out[wrap(i + k)];
          next[i] = sum / (halfWidth * 2 + 1);
        }
        out = next;
      }
      return out;
    };
    const eased = smooth(curve, Math.max(3, Math.round(240 / step)));
    const want = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const v = profileAt(us[i], 'speed') * TRIM;
      want[i] = Math.max(-BANK_LIMIT, Math.min(BANK_LIMIT, Math.atan(v * v * eased[i] / G)));
    }
    /**
     * Roll-rate limit, run round the loop until it settles.
     *
     * The wings cannot snap from level to thirty degrees, and more to the point
     * the curvature they are computed from cannot be made clean enough to ask
     * them to: a 13 m bow in a 2 km straight is geometrically nothing and eight
     * degrees of roll. Chasing the bank through a rate limit answers both — the
     * aeroplane rolls in over three or four seconds like an aeroplane, and a
     * bump too brief to roll into simply never arrives at the wings.
     */
    const bank = new Float64Array(count);
    bank.set(want);
    for (let pass = 0; pass < 6; pass++) {
      for (let k = 0; k < count; k++) {
        const i = wrap(k);
        const v = Math.max(20, profileAt(us[i], 'speed') * TRIM);
        /** Radians of roll per metre travelled, from 6 degrees a second. */
        const rate = ROLL_RATE / v;
        const prev = bank[wrap(i - 1)];
        const step2 = Math.max(-rate * step, Math.min(rate * step, want[i] - prev));
        bank[i] = prev + step2;
      }
    }

    /**
     * Pitch, the same way: the gradient of the altitude curve, smoothed.
     *
     * Raw, the gradient peaks halfway between two fixes, because the eased
     * profile's slope is 1.5 times its average there — which turned a perfectly
     * reasonable 11-degree climb into 19 degrees of nose. Smoothing puts the
     * peak back where the average is, and the clamp catches the rest.
     */
    const grade = new Float64Array(count);
    const GRADE = Math.max(1, Math.round(50 / step));
    for (let i = 0; i < count; i++) {
      const up = profileAt(us[wrap(i + GRADE)], 'alt') - profileAt(us[wrap(i - GRADE)], 'alt');
      grade[i] = Math.atan2(up, 2 * GRADE * step);
    }
    const gradeEased = smooth(grade, Math.max(2, Math.round(160 / step)));
    const pitch = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const s = i * step;
      const ground = s >= GROUND_FROM && s <= GROUND_TO;
      /**
       * Angle of attack, BLENDED with the climb rather than switched by it.
       *
       * `climbing ? AOA_CLIMB : AOA_CRUISE` is a step of 1.75 degrees taken the
       * instant the gradient crosses a threshold, and levelling off at the top
       * of the climb crosses it: the nose dropped 1.8 degrees in ten metres,
       * which at 110 m/s is 32 degrees a second. A smoothstep over the same
       * range costs nothing and cannot do that.
       */
      const g = Math.min(1, Math.max(0, gradeEased[i] / 0.05));
      const aoa = AOA_CRUISE + (AOA_CLIMB - AOA_CRUISE) * g * g * (3 - 2 * g);
      // Nose-wheel on the tarmac through the roll-out, then it rotates as the
      // altitude curve starts to lift at the far end.
      const raw = ground
        ? Math.max(0, gradeEased[i] * 1.6)
        : gradeEased[i] + aoa;
      pitch[i] = Math.max(PITCH_DOWN, Math.min(PITCH_UP, raw));
    }
    return { heading, bank, pitch };
  })();

  /* -------------------------------------------------------------- sampling */

  const at = (i: number, arr: Float64Array) => arr[((i % TRACK.count) + TRACK.count) % TRACK.count];

  /**
   * Where the aeroplane is, and how it is sitting, `distance` metres into the lap.
   *
   * Heading, bank and pitch all come out of the path itself:
   *
   *   heading  the tangent, from the samples either side
   *   bank     `atan(v^2 / gR)` from the curvature — the angle a coordinated
   *            turn at that speed and radius actually needs, capped at 33
   *            degrees, which is more than an airliner ever uses
   *   pitch    the altitude gradient, plus a little angle of attack on the climb
   *            and a flare held off the runway. On the roll-out the gradient is
   *            zero, so it sits level on its gear, which is right
   */
  function flightAt(distance: number): FlightSample {
    const s = ((distance % LAP_LENGTH) + LAP_LENGTH) % LAP_LENGTH;
    const i = s / TRACK.step;
    const i0 = Math.floor(i);
    const t = i - i0;
    const x = at(i0, TRACK.xs) + (at(i0 + 1, TRACK.xs) - at(i0, TRACK.xs)) * t;
    const z = at(i0, TRACK.zs) + (at(i0 + 1, TRACK.zs) - at(i0, TRACK.zs)) * t;
    const u = at(i0, TRACK.us);

    // Heading and bank come off the smoothed tables, interpolated the short way
    // round so the wrap at due south is not a full rotation of the aeroplane.
    const shortWay = (a: number, b: number, f: number) => {
      let d = b - a;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      return a + d * f;
    };
    // Already carries the pushback's half turn — see `ATTITUDE`.
    const heading = shortWay(at(i0, ATTITUDE.heading), at(i0 + 1, ATTITUDE.heading), t);
    const reverse = inReverse(s);
    const onGround = s >= GROUND_FROM && s <= GROUND_TO;
    /**
     * Nothing leans on its wheels — but it cannot snap upright either.
     *
     * Taxi turns are tighter than any turn in the air, so left to the curvature
     * formula a 747 would round the apron with a wing on the tarmac. Switching
     * the bank off flat at the wheels-up point is no better: it put a 431
     * degree-a-second roll on the aeroplane at rotation. So it fades over
     * `BANK_FADE` metres either side of the ground phase.
     */
    const fade = Math.min(
      Math.max(0, (GROUND_FROM - s) / BANK_FADE),
      Math.max(0, (s - GROUND_TO) / BANK_FADE),
    );
    const lean = Math.min(1, s < GROUND_FROM || s > GROUND_TO ? Math.max(
      Math.min(1, (GROUND_FROM - s) / BANK_FADE),
      Math.min(1, (s - GROUND_TO) / BANK_FADE),
    ) : 0);
    void fade;
    const bank = lean * (at(i0, ATTITUDE.bank)
      + (at(i0 + 1, ATTITUDE.bank) - at(i0, ATTITUDE.bank)) * t);

    const speed = profileAt(u, 'speed') * TRIM;

    // Altitude off the eased profile, but the wheels are pinned to the tarmac
    // for the whole roll-out — a smoothed height would float them above it.
    const y = onGround ? RUNWAY_TOP : profileAt(u, 'alt');
    const pitch = at(i0, ATTITUDE.pitch) + (at(i0 + 1, ATTITUDE.pitch) - at(i0, ATTITUDE.pitch)) * t;

    const gearDown = onGround || s > GEAR_DOWN_AT || s < GEAR_UP_AT;

    return { x, z, y, heading, bank, pitch, speed, gearDown, onGround, reverse };
  }

;

  return {
    name,
    lapLength: LAP_LENGTH,
    holds: HOLDS,
    cycleSeconds: CYCLE_SECONDS,
    rollingSeconds: ROLLING_SECONDS,
    holdSeconds: HOLD_SECONDS,
    groundFrom: GROUND_FROM,
    groundTo: GROUND_TO,
    fixes: FIXES.length,
    at: flightAt,
  };
}

/* ----------------------------------------------------- the two aeroplanes */

/**
 * The 747 sets the period; the ATR is trimmed to match it.
 *
 * Two aeroplanes sharing one runway can only be kept apart forever by giving
 * them the SAME cycle and a fixed offset — unequal periods drift, and drifting
 * periods eventually coincide, which is to say that one day they would both be
 * on the runway. The ATR's speeds come out a few per cent off its written
 * ones, which nobody can see; a collision, everybody would.
 */
export const JET = makeCircuit('747', JET_FIXES);
export const TURBOPROP = makeCircuit('ATR 42', ATR_FIXES, JET.cycleSeconds);
export const FREIGHTER = makeCircuit('A400M', CARGO_FIXES, JET.cycleSeconds);

/**
 * Where each aeroplane starts, as a fraction of the shared cycle.
 *
 * Measured, and the measurement changed when the third aeroplane arrived —
 * not just the numbers but what was being measured.
 *
 * With two, the test was "never both on the runway", and 0.25 was the roomiest
 * of the thirty offsets that passed. With three it cannot be satisfied at all:
 * every arrangement of the 1,076 quarter-second steps leaves at least 5.3
 * seconds of the cycle with two aeroplanes inside the runway strip. So the
 * strip was the wrong test. Every one of those 5.3 seconds turns out to be the
 * 747 rotating while the A400M rolls out FIVE HUNDRED METRES away at the far
 * end, which is not a conflict, it is an airport. A 900 m rectangle cannot
 * tell the two apart.
 *
 * What matters is how close they ever get, so that is what is searched now:
 * the minimum WINGTIP clearance — centre-to-centre distance less both
 * half-spans, over every pair, over the whole cycle, ignoring pairs more than
 * 40 m apart in height because one at 200 m and one on the ground are not
 * close however they look in plan. All 1,076 x 1,076 arrangements were walked.
 *
 * The best is 31.8 m of clearance, and it is a real improvement rather than a
 * different way of saying the same thing: the arrangement the runway-box test
 * liked best left the 747 and the ATR 56 m apart centre to centre on the
 * taxiway, which with a 32 m and a 12.5 m half-span is eleven metres of
 * wingtip. This one is three times that.
 */
export const SCHEDULE: ReadonlyArray<{ circuit: Circuit; phase: number }> = [
  { circuit: JET, phase: 0 },
  { circuit: TURBOPROP, phase: 0.0729 },
  { circuit: FREIGHTER, phase: 0.8415 },
];
