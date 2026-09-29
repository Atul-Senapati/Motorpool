/**
 * The island line: the railway that reaches Halcyon Field's freight terminal.
 *
 * ## Where the alignment came from
 *
 * It was drawn by hand on a plan of the island and read back off the image —
 * the two gate piers and the 50 m grid gave an exact pixel-to-world transform,
 * both piers checking to within half a metre — then smoothed until it held a
 * radius a train could take. `trunk` below is that line, simplified to nine
 * vertices that reproduce the smoothed one to within 1.4 m.
 *
 * ## Both ends are open, on purpose
 *
 * The trunk starts 111 m out over the water off the island's north-east corner
 * and ends on the east shore, and neither end joins anything yet. There are no
 * buffer stops: a stop says "this is where the railway finishes", and this is
 * a railway that has not been finished. Where it goes at each end is still to
 * be drawn, and until it is, the line simply stops.
 *
 * ## Why the junction faces north-east
 *
 * The yard's mains run out of the gate pointing `across`; the trunk crosses
 * the island west-south-west. Those two directions do not meet at an angle any
 * arc can absorb on the west side, and the reason is not the railway — it is
 * what stands between them. The amusement park fills `along` 134..396 up to
 * `across` 248, the outer road runs the width of the island at 252..266 with
 * the bridge's cargo junction occupying its last twenty metres, and east of
 * that the bridge's own approach comes down at 10.6% to meet it. Measured: a
 * connection curving west onto the trunk's straight run — the tangential
 * junction, 0.4 degrees, 144 m radius — crosses that approach 30 m from its
 * landfall, where the soffit is BELOW ground. There is no corridor there.
 *
 * So the connection goes the other way. It runs straight out of the gate,
 * swings east through a little over 120 degrees, and joins the trunk heading
 * north-east — toward the open end over the water where the link to the
 * mainland is reserved. That is a trailing connection: a train arriving from
 * the mainland runs past and sets back into the yard, which is how a freight
 * terminal is entered anyway. Everything about it is east of the bridge, so it
 * crosses no road and passes nothing.
 *
 * The price is radius. Turning that much between the gate and the trunk's
 * landfall allows about 64 m, against 144 for the junction that cannot be
 * built — but 64 m is the yard's OWN turnout: the ladder throws 12 m in 40,
 * which is 67. The connection is laid to the same standard as the roads it
 * comes off, and it meets the main line at nothing.
 */
import { ENTRY, FACE_THE_ROAD, PARADE_LINKS, PAVING, SIDINGS, SITE, sidingCentre } from './airportConfig';
import paradeModels from './paradeModelData.json';
import roadModels from './roadModelData.json';
import stationBuilding from './stationBuildingData.json';
import { TRAIN } from './trainConfig';

export type Pt = readonly [number, number];

/**
 * The drawn line, island frame, north-east end first.
 *
 * Swept as a centripetal Catmull-Rom below. Centripetal rather than uniform
 * because a uniform spline overshoots on the unevenly spaced vertices a traced
 * line has — the same overshoot that once put a curve inside a container while
 * its control polygon cleared by five metres.
 *
 * ## The south-west end: down the island and onto the Skylark line
 *
 * The traced line stopped at (286.3, 331.4), heading a little north of west
 * and straight at the Wall of Death, whose canopy reaches 32.6 m from its
 * centre at (245, 304). From (354.9, 336.5) it now does four things, all
 * solved in `SOUTH_WEST` below rather than drawn:
 *
 * 1. **A little curve east**, a reverse pair on 400 m, which lifts the line
 *    onto `STRIP` and past the drome with 43 m between its centre and ours.
 * 2. **Straight down the island** along `STRIP`, 82 m from the outer road's
 *    kerb and at least 44 m from the coast where the island pinches in.
 * 3. **An S on 160 m curves** — the Skylark line's own ruling radius — that
 *    crosses the Skylark road ON ITS DECK at the island's west tip, where the
 *    deck is still level on the airfield, at about sixty degrees. The west
 *    link runs south from the junction at `AIRPORT_GATE`, so the crossing has
 *    to be west of it; the parade fills everything south of the road to the
 *    east, so it cannot be anywhere else.
 * 4. **It ends ON the Skylark line**, on that line's own straight over the
 *    water, heading the way it heads. `countryConfig` starts the Skylark line
 *    at `TRUNK_RAILHEAD`, so the two are one railway meeting at a single
 *    cross-section: same place, same heading, same 4.6 m pair, same rail
 *    head. There are no points and no buffer stops at the joint.
 */
export const TRACED_TRUNK: readonly Pt[] = [
  [648.4, 230.4], [619.8, 244.6], [597.1, 257.2], [576.6, 269.8],
  [533.0, 298.1], [512.2, 310.2], [488.8, 321.3], [466.1, 329.2],
  [450.6, 332.9], [434.8, 335.5], [416.8, 337.2], [398.9, 337.8],
  [354.9, 336.5],
];

/**
 * The Skylark line's offset from the outer road's centreline, in `across`.
 *
 * It runs 70 m on the west side of the Skylark road — see `RAIL_OFFSET` in
 * `countryConfig`, which reads this — and the trunk has to arrive on it.
 */
export const SKYLARK_OFFSET = -70;

/**
 * The south-west end's parameters. Everything else about it is derived.
 *
 * `strip` is the straight's `across`; `ease` the radius of the little curve
 * east; `s` the S's radius and `mid` the `along` of its inflection, which puts
 * the road crossing on the deck's level stretch between the junction's west
 * edge at -404.5 and the shore at -460.5. `lead` is the straight the S hands
 * over on, so the joint is on a tangent and not at the end of a chord.
 */
export const SOUTH_WEST = { strip: 348, ease: 400, s: 160, mid: -425, lead: 24, step: 8 } as const;

const southWest = (): Pt[] => {
  const start = TRACED_TRUNK[TRACED_TRUNK.length - 1];
  const before = TRACED_TRUNK[TRACED_TRUNK.length - 2];
  const target = (PAVING.outerRoad[2] + PAVING.outerRoad[3]) / 2 + SKYLARK_OFFSET;
  const W = -Math.PI / 2;                      // due -along: down the island
  const out: Pt[] = [];
  let x = start[0];
  let z = start[1];
  let h = Math.atan2(start[0] - before[0], start[1] - before[1]);
  // Integrated in half-steps of heading, so an arc's chord error is nil.
  const arc = (r: number, turn: number) => {
    const n = Math.max(1, Math.ceil((Math.abs(turn) * r) / SOUTH_WEST.step));
    for (let i = 0; i < n; i++) {
      h += turn / n / 2;
      x += Math.sin(h) * (Math.abs(turn) * r) / n;
      z += Math.cos(h) * (Math.abs(turn) * r) / n;
      h += turn / n / 2;
      out.push([x, z]);
    }
  };
  const straight = (len: number) => {
    const n = Math.max(1, Math.ceil(len / (SOUTH_WEST.step * 4)));
    for (let i = 0; i < n; i++) { x += Math.sin(h) * len / n; z += Math.cos(h) * len / n; out.push([x, z]); }
  };
  // 1. The little curve east: +a then -(a - residual), solved for `strip`.
  const residual = W - h;
  const lift = (a: number) => {
    let hh = h, zz = z;
    const step = (r: number, turn: number) => {
      const n = 200;
      for (let i = 0; i < n; i++) { hh += turn / n / 2; zz += Math.cos(hh) * (Math.abs(turn) * r) / n; hh += turn / n / 2; }
    };
    step(SOUTH_WEST.ease, a); step(SOUTH_WEST.ease, residual - a);
    return zz;
  };
  let lo = 0, hi = 0.6;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (lift(mid) < SOUTH_WEST.strip) lo = mid; else hi = mid; }
  const a = (lo + hi) / 2;
  arc(SOUTH_WEST.ease, a);
  arc(SOUTH_WEST.ease, residual - a);
  h = W;
  // 3. The S, sized to drop the line from `strip` to the Skylark line.
  const theta = Math.acos(1 - (z - target) / (2 * SOUTH_WEST.s));
  const half = SOUTH_WEST.s * Math.sin(theta);
  // 2. Straight down the island to where the S begins.
  straight(x - (SOUTH_WEST.mid + half));
  arc(SOUTH_WEST.s, -theta);
  arc(SOUTH_WEST.s, theta);
  // 4. A short straight onto the joint. The arc's last vertex is a chord's
  // length from the end of the curve and its chord is 1.4 degrees off the
  // tangent; ending on a straight makes the last segment — the one the
  // Skylark line continues — exactly along it.
  h = W;
  z = target;
  straight(SOUTH_WEST.lead);
  return out;
};

export const TRUNK: readonly Pt[] = [...TRACED_TRUNK, ...southWest()];

/** Where the trunk ends: the joint with the Skylark line, heading `-along`. */
export const TRUNK_RAILHEAD: Pt = TRUNK[TRUNK.length - 1];

/** How finely everything here is sampled. Two metres holds a 137 m arc to 4 mm. */
export const STEP = 2;

/**
 * The running line's ballast, and the yard's, because the connection is both.
 *
 * A running line stands on the main line's section — 0.62 m deep — and the
 * yard's roads stand on 0.4. That is a 22 cm step in rail head height, and the
 * connection is the thing that has to absorb it: it leaves the railhead on the
 * yard's section and is on the line's by the time it is clear of the gate.
 * `RAMP` is how long it takes over, and 40 m of it is a 0.55% grade.
 */
export const BALLAST = {
  line: { depth: TRAIN.ballastDepth, crownHalf: TRAIN.ballastCrownHalf, slope: TRAIN.ballastSlope },
  yard: SIDINGS.ballast,
  ramp: 40,
} as const;

/**
 * Which of the two mains carries straight on, and it is the DOWN one.
 *
 * The connection now curves toward `+along`, so the road it leaves wants to be
 * the WESTERN of the two: every metre further west is a metre more room to turn
 * in before the trunk, and the radius is (trunk.x - main) / (1 - cos turn), so
 * it comes straight off that difference. Leaving from 476 allows 57 m; leaving
 * from 464 allows 64. Same yard, same two roads, 12 % of radius for nothing but
 * the choice — and 464 is `SIDINGS.neck`, the road already described as the one
 * that carries on north, so it is the one that should.
 */
export const THROUGH_MAIN = 464;
export const LINK_MAIN = 476;
/** Where the mains stop, and so where the connection starts. */
export const RAILHEAD = SIDINGS.neckEnd - 1;

/* -------------------------------------------------------------- the trunk -- */

export interface Sample {
  x: number;
  z: number;
  /** The height the cross-section hangs off: the island's crown, everywhere. */
  y: number;
  /** Arc length from the start of this track. */
  arc: number;
  /** Left-hand normal, the sign the rest of the railway uses. */
  nx: number;
  nz: number;
  /** Ballast depth here — the connection ramps, everything else is constant. */
  depth: number;
  /** 0 where this track has merged into another, 1 where it stands alone. */
  blade: number;
}

/** Centripetal Catmull-Rom through the vertices, at roughly `step` metres. */
function spline(pts: readonly Pt[], step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const d = (a: Pt, b: Pt) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-6;
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => [
        ((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta),
        ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta),
      ];
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2) as [number, number]);
    }
  }
  out.push([...pts[pts.length - 1]] as [number, number]);
  return out;
}

/** Arc length, normals and a constant depth — what a loft needs. */
function dress(pts: Array<[number, number]>, depth: number | ((arc: number) => number)): Sample[] {
  const out: Sample[] = [];
  let arc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) arc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.push({
      x: pts[i][0], z: pts[i][1], y: 0, arc, nx: 1, nz: 0, blade: 1,
      depth: typeof depth === 'number' ? depth : depth(arc),
    });
  }
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    out[i].nx = (b.z - a.z) / len;
    out[i].nz = -(b.x - a.x) / len;
  }
  return out;
}

/**
 * How far apart the two trunk roads stand.
 *
 * The main line's own double-track gap, because this is the same railway and
 * a pair of lines that measured differently here would read as one. At 4.6 m
 * the sleeper ends reach 3.65 m out and the two ballast shoulders overlap, so
 * the pair stands on ONE formation 9.2 m across rather than two crowns with a
 * ditch between them — which is what double track on ballast actually is.
 */
export const TRACK_GAP = TRAIN.elevated.trackGap;

/** The drawn line itself, which is the centre of the pair rather than a rail. */
export const trunkCentre = (): Sample[] => dress(spline(TRUNK, STEP), BALLAST.line.depth);

/**
 * Which side of the centreline faces the terminal, and so which road the
 * connection joins. Measured rather than written down: the two candidates are
 * 2.8 m apart at the junction and the sign of that is not something to guess.
 */
export const YARD_SIDE: -1 | 1 = (() => {
  const centre = trunkCentre();
  const near = (side: -1 | 1) => Math.min(...centre.map((s) => Math.hypot(
    s.x + s.nx * side * TRACK_GAP / 2 - THROUGH_MAIN,
    s.z + s.nz * side * TRACK_GAP / 2 - RAILHEAD,
  )));
  return near(-1) <= near(1) ? -1 : 1;
})();

/**
 * One of the two trunk roads.
 *
 * Offset from the centreline along its normal and then dressed again, so the
 * road carries ITS OWN arc length and normals rather than borrowing the
 * centre's. On a 148 m curve the inner road is 2.3 m shorter over every
 * quadrant, and sleepers spaced off the wrong arc walk out of square.
 */
export const trunkSamples = (side: -1 | 1): Sample[] => dress(
  trunkCentre().map((s) => [s.x + s.nx * side * TRACK_GAP / 2, s.z + s.nz * side * TRACK_GAP / 2] as [number, number]),
  BALLAST.line.depth,
);

/**
 * How far apart two tracks have to be before each gets its own rail section.
 *
 * Inside this, the joining track's rail is drawn as a switch blade lying
 * against the stock rail — `switchBlade` does the shaping. Wider than the
 * station's 0.6 m because this turnout is a ladder's, taken at a shallower
 * angle, so the blade is longer.
 */
export const BLADE_GAP = 1.2;

/* ----------------------------------------------------------- the junction -- */

/**
 * How far inland the point of tangency has to be, in trunk arc.
 *
 * The trunk reaches land at arc 89 — north of that it is on viaduct. A turnout
 * belongs on ballast and not on a structure, so the junction is held ten metres
 * past the landfall. It costs radius: every metre further along the trunk is a
 * metre the connection has to have turned in already, and the sweep below runs
 * from 89 to 99 at 69 m of radius down to 64. Ten metres of ballast under the
 * blades is worth five of radius.
 */
const JUNCTION_INLAND = 99;

/**
 * The junction, solved: a straight out of the gate and ONE arc onto the trunk.
 *
 * Both ends are fixed by things that already exist, which is why there is
 * nothing to draw. The near end is the neck's railhead, and the connection
 * leaves it along the neck — straight, because the mains are straight and a
 * curve that starts inside a yard starts inside its ladder. The far end is a
 * point on the trunk, and the arc must arrive there travelling along it: same
 * place AND same direction, which is what makes it a junction rather than two
 * tracks touching.
 *
 * That leaves one degree of freedom — WHERE on the trunk — and one equation.
 * An arc leaving a straight at `along = THROUGH_MAIN` and turning right through
 * `turn` ends `R · (1 - cos turn)` further east, so
 *
 *   R = (trunk.x - THROUGH_MAIN) / (1 - cos turn)
 *
 * with `turn` the heading of the trunk at that point, taken toward its open
 * north-east end. Sweep the trunk, keep the biggest radius that is far enough
 * inland. Nothing here is a dial: move the yard, the gate or the trunk and the
 * junction re-solves itself, which is the point — the last one was a drawn line
 * whose two ends had drifted 1.5 and 6.8 m off the things it joined.
 */
export const TURNOUT = (() => {
  // Against the ROAD the yard joins, not the centreline between the two. They
  // are 2.3 m apart, which is the difference between a blade lying on a stock
  // rail and one lying in the four-foot.
  const trunk = trunkSamples(YARD_SIDE);
  let best: { radius: number; turn: number; straightTo: number; at: Pt; arc: number } | null = null;
  for (let i = 3; i < trunk.length - 3; i++) {
    if (trunk[i].arc < JUNCTION_INLAND) continue;
    const a = trunk[i - 3], b = trunk[i + 3];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    // North-east bound: up the trunk toward the open end, against its arc.
    const turn = Math.atan2(-dx / len, -dz / len);
    if (!(turn > 0.1)) continue;
    const radius = (trunk[i].x - THROUGH_MAIN) / (1 - Math.cos(turn));
    const straightTo = trunk[i].z - radius * Math.sin(turn);
    // The straight has to be a straight: the arc cannot start behind the
    // railhead, and it must be clear of the wall the gate is in at 152.
    if (!(radius > 20) || straightTo < 158) continue;
    if (!best || radius > best.radius) {
      best = { radius, turn, straightTo, at: [trunk[i].x, trunk[i].z] as Pt, arc: trunk[i].arc };
    }
  }
  if (!best) throw new Error('islandRailConfig: no junction fits between the gate and the trunk');
  return best;
})();

/** The connection, from the neck's railhead to the trunk. */
export function connectionSamples(): Sample[] {
  const T = TURNOUT;
  const pts: Array<[number, number]> = [];
  for (let z = RAILHEAD; z < T.straightTo; z += STEP) pts.push([THROUGH_MAIN, z]);
  // The arc, swung about a centre due east of where the straight ends. It
  // starts at pi — the railhead's side of the circle — and closes on the trunk.
  const cx = THROUGH_MAIN + T.radius;
  const steps = Math.max(2, Math.ceil((T.turn * T.radius) / STEP));
  for (let k = 0; k <= steps; k++) {
    const a = Math.PI - (T.turn * k) / steps;
    pts.push([cx + T.radius * Math.cos(a), T.straightTo + T.radius * Math.sin(a)]);
  }
  const ramp = (arc: number) => {
    const t = Math.min(1, Math.max(0, arc / BALLAST.ramp));
    const e = t * t * (3 - 2 * t);
    return BALLAST.yard.depth + (BALLAST.line.depth - BALLAST.yard.depth) * e;
  };
  const out = dress(pts, ramp);
  // How far this stands from the road it is joining, so the last few metres are
  // drawn as a switch blade against the stock rail rather than as a second rail
  // crossing it. `standsAlone` reads this.
  const road = trunkSamples(YARD_SIDE);
  for (const q of out) {
    let near = Infinity;
    for (const t of road) near = Math.min(near, Math.hypot(t.x - q.x, t.z - q.z));
    q.blade = Math.min(1, near / BLADE_GAP);
  }
  return out;
}

/**
 * What the junction actually came out as, measured off the swept samples.
 *
 * Reported rather than set, and `angle` is the one that matters: it is how far
 * the connection's heading is from the trunk's where they meet. The drawn
 * connection this replaced read 90.8 degrees there — two tracks crossing, which
 * is why the yard was left unconnected rather than have blades laid into it.
 */
export const JUNCTION = (() => {
  const conn = connectionSamples();
  const trunk = trunkSamples(YARD_SIDE);
  const end = conn[conn.length - 1];
  let at: Sample = trunk[0];
  let best = Infinity;
  for (const t of trunk) {
    const d = Math.hypot(t.x - end.x, t.z - end.z);
    if (d < best) { best = d; at = t; }
  }
  const heading = (line: Sample[], i: number) => {
    const a = line[Math.max(0, i - 3)], b = line[Math.min(line.length - 1, i + 3)];
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  const ci = conn.length - 1;
  const ti = trunk.indexOf(at);
  // The trunk's heading taken north-east bound, which is the way the connection
  // is going once it has joined.
  let d = heading(conn, ci) - (heading(trunk, ti) + Math.PI);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const curvature = (line: Sample[]) => {
    let min = Infinity;
    for (let i = 8; i < line.length - 8; i++) {
      const a2 = line[i - 8], b2 = line[i], c2 = line[i + 8];
      const A = Math.hypot(b2.x - a2.x, b2.z - a2.z);
      const B = Math.hypot(c2.x - b2.x, c2.z - b2.z);
      const C = Math.hypot(c2.x - a2.x, c2.z - a2.z);
      const area = Math.abs((b2.x - a2.x) * (c2.z - a2.z) - (b2.z - a2.z) * (c2.x - a2.x)) / 2;
      if (area > 1e-9) min = Math.min(min, (A * B * C) / (4 * area));
    }
    return min;
  };
  return {
    at: [at.x, at.z] as Pt,
    gap: best,
    arc: at.arc,
    angle: Math.abs((d * 180) / Math.PI),
    radius: curvature(conn),
    trunkRadius: curvature(trunk),
  };
})();

/**
 * The down main's link, and it is the yard's own idiom carried onto a curve.
 *
 * A road that joins another in this terminal eases across on a smoothstep over
 * `SIDINGS.transition` and stops — see `sidingCentre`. This does the same, only
 * the thing it eases onto is curved, so the offset is measured along the
 * connection's normal rather than in `along`. Twelve metres in over forty is
 * the same turnout the ladder uses, which is the point: a yard should not have
 * two kinds of turnout in it.
 */
export const LINK = { offset: LINK_MAIN - THROUGH_MAIN, transition: 80, from: 6 } as const;

export function downLinkSamples(): Sample[] {
  const spine = connectionSamples();
  const pts: Array<[number, number]> = [];
  const seps: number[] = [];
  for (const s of spine) {
    const t = Math.min(1, Math.max(0, (s.arc - LINK.from) / LINK.transition));
    const e = 1 - t * t * (3 - 2 * t);
    const off = LINK.offset * e;
    pts.push([s.x + s.nx * off, s.z + s.nz * off]);
    seps.push(Math.abs(off));
    if (s.arc > LINK.from && t >= 1) break;
  }
  const out = dress(pts, (arc) => {
    const at = spine.find((s) => s.arc >= arc + LINK.from) ?? spine[spine.length - 1];
    return at.depth;
  });
  for (let i = 0; i < out.length; i++) out[i].blade = Math.min(1, seps[i] / BLADE_GAP);
  return out;
}

/**
 * The crossover, so the terminal can reach both roads.
 *
 * The connection lands on ONE road — an arc has one point of tangency and that
 * is all it can have — and it is a trailing connection, joining the trunk
 * north-east bound. So a train arriving from the mainland runs PAST the
 * junction and sets back into it, and to do that off either road it has to be
 * able to change roads south of the junction. Without this the yard is reachable
 * from one of the two lines and nothing else, which is why every double-track
 * junction in the world has a crossover beside it.
 *
 * ## Where it fits
 *
 * The trunk is on viaduct for its first 89 m and the junction's point of
 * tangency is at 99, so everything north of 99 is either a structure or the
 * turnout itself. South of it the trunk is clear to the end. 135 to 203 is 68 m
 * — at 4.6 m of throw a 168 m radius, the same turnout as the ladder — and it
 * starts 36 m past the junction, which is clear of its blades.
 *
 * ## Why it has no ballast of its own
 *
 * Because it does not need any. It runs between two roads standing 4.6 m apart
 * on one shared formation, so the crown that carries them carries this too —
 * the same reason `Pointwork` lays the main line's crossovers on a viaduct, in
 * a bore and on an embankment without a structure-specific line of code.
 */
export const CROSSOVER = { from: 135, to: 203 } as const;

export function crossoverSamples(): Sample[] {
  const centre = trunkCentre();
  const pts: Array<[number, number]> = [];
  const seps: number[] = [];
  const half = TRACK_GAP / 2;
  for (const s of centre) {
    if (s.arc < CROSSOVER.from || s.arc > CROSSOVER.to) continue;
    const t = (s.arc - CROSSOVER.from) / (CROSSOVER.to - CROSSOVER.from);
    const e = t * t * (3 - 2 * t);
    const off = YARD_SIDE * half * (1 - 2 * e);
    pts.push([s.x + s.nx * off, s.z + s.nz * off]);
    // How far it stands from whichever road is nearer — a diagonal has a blade
    // at BOTH ends, because it leaves one road and joins the other.
    seps.push(Math.min(Math.abs(off - half), Math.abs(off + half)));
  }
  const out = dress(pts, BALLAST.line.depth);
  for (let i = 0; i < out.length; i++) out[i].blade = Math.min(1, seps[i] / BLADE_GAP);
  return out;
}

/* ------------------------------------------------------------ the station -- */

/**
 * A station on the long straight down the island, laid out the Indian way: the
 * up and down mains through the middle, a loop off each of them outside it,
 * and four platforms so every track has a face.
 *
 * The user is building the station itself; this is the railway's half — the
 * loops, their pointwork and the platforms. PF1 is on the road side, where
 * the building goes, with the open ground between it and the outer road.
 *
 * ## Layout, across the line from the road to the coast
 *
 *   PF1        side platform, `side` wide — the station building's side
 *   down loop  `edge + island + edge` = 10.1 m out from the down main
 *   PF2        island, `island` wide
 *   down main  the trunk's road-side road, across 345.7
 *   up main    the trunk's coast-side road, across 350.3
 *   PF3        island
 *   up loop    10.1 m out from the up main
 *   PF4        side platform
 *
 * Every face is `edge` (1.55 m) off its track centre — `CountryRail`'s figure —
 * 0.92 m over the rail head, with the same coping, yellow line and 7 m end
 * ramps, so the two railways' stations read as one.
 *
 * ## The throats
 *
 * Each loop leaves its main on a smoothstep offset over `lead`, the idiom the
 * yard's ladder and the down main's link use. A smoothstep's tightest radius
 * is `lead² / (6 · offset)`: 165 m. Where a loop is closing on its main its
 * rail is drawn as a switch blade (`blade`, read by `switchBlade`). All four
 * tracks stand on one bed — see `trunkFormation`.
 *
 * ## Where
 *
 * The straight between the curve round the Wall of Death (ends at `along` 202)
 * and the S down to the Skylark road (starts at −287) is 489 m; the station is
 * 420 m toe to toe and centred on the straight's middle at −42.
 */
export const STATION = {
  centre: -42,
  lead: 100,
  platform: { length: 200, island: 7, side: 6, edge: 1.55, top: 0.92, coping: 0.55, ramp: 7 },
  /** Each loop runs this far past each end of the platforms before it starts to close. */
  margin: 10,
} as const;

/** Which way from its main each loop steps: the down loop toward the road, the up toward the coast. */
export const LOOP_SIDE = { down: -1, up: 1 } as const;
export type StationLoop = keyof typeof LOOP_SIDE;

const LOOP = (() => {
  const full = STATION.platform.length / 2 + STATION.margin;
  return { full, out: full + STATION.lead, gap: STATION.platform.edge * 2 + STATION.platform.island };
})();
export const STATION_EXTENT = LOOP.out;
export const STATION_PLATFORM = {
  from: STATION.centre - STATION.platform.length / 2,
  to: STATION.centre + STATION.platform.length / 2,
};

/**
 * The platform canopies: one over each platform's middle 122 m, stopping
 * short of the footbridge so its stairs come down in the open — on all four
 * platforms (PF1's was taken off once and the user wanted it back).
 *
 * Each is a thin curved shell, metal on top and cedar underneath. On an
 * island it arches over a centre row of tapered columns, with Y arms up to
 * two purlins and a glazed rooflight along the crown; on the side platform
 * it springs from columns along the back and sweeps down to the track edge.
 *
 * `height` is the underside at its lowest, at the edges, over the platform
 * surface; `rise` the crown above that. A train body is about 3.4 m over the
 * platform and the canopy stays inside the platform's own footprint, so the
 * two never meet.
 */
export const STATION_CANOPY = {
  from: STATION.centre - 72,
  to: STATION.centre + 50,
  height: 4.0,
  rise: 0.9,
  bay: 12,
  platforms: ['PF1', 'PF2', 'PF3', 'PF4'] as readonly string[],
  /** The rooflight along an island canopy's crown, and where the Y arms meet the shell (from the crown). */
  rooflight: 1.6,
  arms: 1.9,
} as const;

/**
 * The footbridge: across all four platforms and tracks just east of the
 * canopies, with a stair down onto each platform running east along it,
 * away from the canopy. The deck's floor is `deck` over the rail head —
 * clear of any train here by a couple of metres — and the stairs take
 * 175 mm risers with a landing halfway.
 */
export const STATION_FOOTBRIDGE = {
  x: STATION.centre + 56,
  width: 3.2,
  deck: 6.3,
  stair: { width: 2.0, rise: 0.175, going: 0.28, landing: 1.6 },
} as const;

/** A loop's step out from its main at `u` metres from the centre. */
const stepOut = (u: number) => {
  const d = Math.abs(u);
  if (d <= LOOP.full) return LOOP.gap;
  if (d >= LOOP.out) return 0;
  const t = 1 - (d - LOOP.full) / STATION.lead;
  return LOOP.gap * t * t * (3 - 2 * t);
};

/**
 * One of the two loops, built off its main's own samples, offset along their
 * normal and dressed again so it carries its own arc and normals. `blade` is
 * how far it stands from its main, over `BLADE_GAP`.
 */
export function stationLoop(which: StationLoop): Sample[] {
  const side = LOOP_SIDE[which];
  const main = trunkSamples(side);
  const pts: Array<[number, number]> = [];
  const seps: number[] = [];
  for (const q of main) {
    const u = q.x - STATION.centre;
    if (Math.abs(u) > LOOP.out) continue;
    const off = side * stepOut(u);
    pts.push([q.x + q.nx * off, q.z + q.nz * off]);
    seps.push(stepOut(u));
  }
  const out = dress(pts, BALLAST.line.depth);
  for (let i = 0; i < out.length; i++) out[i].blade = Math.min(1, seps[i] / BLADE_GAP);
  return out;
}

/**
 * The four platforms, as the line each is laid off and the span across it:
 * `from`..`to` metres from that line's centre, toward `dir`. PF1 is the
 * building's side.
 */
/**
 * PF1's own line north: it carries straight on where the down loop turns
 * back to its main, and then JOINS the main ahead rather than stopping.
 *
 * The loop is straight to `from` (along 68, `LOOP.full` past the centre) and
 * then eases in to the down main; this line leaves it there on the same
 * straight, so the loop is untouched — a turnout whose curved route is the
 * loop. North of the station the down main curves in toward this straight
 * and crosses it, four degrees off, at about along 307. So from `blendFrom`
 * the line eases off its straight onto the main, reaching it tangentially at
 * `join` (along 335): an S no tighter than 200 m radius — gentler than the
 * Skylark line's own 160 m — and from there on they are one track. The
 * standing train's front (`COURIER_HUB.train.frontAt`) stays south of
 * `blendFrom`, on the straight. There was a buffer stop at 264 until the user asked
 * for the line to "merge with the main track ahead".
 *
 * Platform 1 goes along it — only PF1: the user wants PF1's floor to carry
 * on, and PF2 and PF3 to stay as they are — to `platformTo`, laid off this
 * line's straight rather than the loop's bend, which would carry its face
 * over the spur.
 */
export const PF1_SPUR = { from: STATION.centre + LOOP.full, blendFrom: 236, join: 335, platformTo: 214, step: 2 } as const;

/** Where the down main is across at `x`, read off its samples. */
const downMainAt = (x: number): number => {
  const main = trunkSamples(LOOP_SIDE.down);
  for (let i = 1; i < main.length; i++) {
    const a = main[i - 1];
    const b = main[i];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) return a.z + ((x - a.x) / (b.x - a.x)) * (b.z - a.z);
  }
  return main[0].z;
};

/**
 * The spur's samples, from the join with the main back to `from`: the same
 * way round as the loop and the mains, which run north to south. It matters —
 * `dress` takes the LEFT-hand normal, so a line built the other way has its
 * normals flipped, and platform 1 laid off it came out on the wrong side of
 * the track, between the spur and the loop. `blade` is its separation from
 * whichever track it is sharing the road with — the loop at the south end,
 * the main at the north — over `BLADE_GAP`, so no sleeper is laid twice.
 */
export function pf1Spur(): Sample[] {
  const loop = stationLoop('down');
  const a = loop.reduce((m, q) => (Math.abs(q.x - (PF1_SPUR.from - 40)) < Math.abs(m.x - (PF1_SPUR.from - 40)) ? q : m));
  const b = loop.reduce((m, q) => (Math.abs(q.x - PF1_SPUR.from) < Math.abs(m.x - PF1_SPUR.from) ? q : m));
  const slope = (b.z - a.z) / (b.x - a.x);
  const straightAt = (x: number) => b.z + slope * (x - b.x);
  const pts: Array<[number, number]> = [];
  for (let x = b.x; x <= PF1_SPUR.join + 0.01; x += PF1_SPUR.step) {
    const t = Math.min(1, Math.max(0, (x - PF1_SPUR.blendFrom) / (PF1_SPUR.join - PF1_SPUR.blendFrom)));
    const ease = t * t * (3 - 2 * t);
    pts.push([x, straightAt(x) + (downMainAt(x) - straightAt(x)) * ease]);
  }
  pts.reverse();
  const out = dress(pts, BALLAST.line.depth);
  for (const q of out) {
    const fromLoop = LOOP.gap - stepOut(q.x - STATION.centre);
    const fromMain = Math.abs(downMainAt(q.x) - q.z);
    q.blade = Math.min(1, Math.min(fromLoop, fromMain) / BLADE_GAP);
  }
  return out;
}

/** The line platform 1 is laid off: the spur, then the down loop's straight — north to south, as the loop runs. */
export function pf1Line(): Sample[] {
  const loop = stationLoop('down').filter((q) => q.x < PF1_SPUR.from - 0.5);
  const pts: Array<[number, number]> = [...pf1Spur().map((q) => [q.x, q.z] as [number, number]), ...loop.map((q) => [q.x, q.z] as [number, number])];
  return dress(pts, BALLAST.line.depth);
}

/**
 * Platform 1's north end, lengthened for the parcel hub (`COURIER_HUB`) —
 * the courier section, on the open ground north of the building.
 *
 * `extend` metres past the others' north end, straight along PF1's own spur
 * (`PF1_SPUR`), which carries on where the loop turns back to its main.
 *
 * Where it meets the hub the platform is broadened into a drive-on `deck`
 * reaching back toward the road — room for a van to turn and pass a parcel
 * cart — and a wide, gentle vehicle ramp comes down off the deck's back
 * edge into the yard, at about 1 in 15; a second comes down off the
 * platform's own back edge further north (`ramps`). Both surfaced dark, so they read as
 * roadway rather than as more platform; the ramp carries no paint.
 */
export const PF1_NORTH = {
  /** To `PF1_SPUR.platformTo`, most of the way along the spur. */
  extend: PF1_SPUR.platformTo - STATION_PLATFORM.to,
  deck: { from: STATION_PLATFORM.to, to: STATION_PLATFORM.to + 30, back: 318 },
  /**
   * Every vehicle ramp down off PF1 into the yard: the deck's, and a second
   * off the platform's own back edge further north, so a van can get on at
   * one end of the parcel stretch and off at the other. `onDeck` says which
   * edge a ramp hangs off.
   */
  ramps: [
    { from: STATION_PLATFORM.to + 6, to: STATION_PLATFORM.to + 24, length: 24, onDeck: true },
    { from: 178, to: 196, length: 24, onDeck: false },
  ],
} as const;

export function stationPlatforms(): Array<{
  label: string; line: Sample[]; dir: -1 | 1; from: number; to: number; island: boolean;
  /** Its ends, along. */
  x0: number; x1: number;
}> {
  const P = STATION.platform;
  const d = LOOP_SIDE.down;
  const u = LOOP_SIDE.up;
  const x0 = STATION_PLATFORM.from;
  const x1 = STATION_PLATFORM.to;
  return [
    { label: 'PF1', line: pf1Line(), dir: d, from: P.edge, to: P.edge + P.side, island: false, x0, x1: x1 + PF1_NORTH.extend },
    { label: 'PF2', line: trunkSamples(d), dir: d, from: P.edge, to: P.edge + P.island, island: true, x0, x1 },
    { label: 'PF3', line: trunkSamples(u), dir: u, from: P.edge, to: P.edge + P.island, island: true, x0, x1 },
    { label: 'PF4', line: stationLoop('up'), dir: u, from: P.edge, to: P.edge + P.side, island: false, x0, x1 },
  ];
}

/**
 * The station building: the user's model, `public/models/station.glb`, baked
 * by `npm run prepare:station` with the "store" lettering taken off its front.
 *
 * It stands behind PF1 — the road side — its platform side `gap` metres off
 * PF1's back edge, with the ground between it and the road left as its
 * forecourt. The model's lettered front (`front` in the data, the sign of its
 * Z) faces the road — see `turn` — and it is doubled with a mirrored copy
 * (`copies`), the pair centred on the platforms.
 */
export const STATION_BUILDING = (() => {
  /**
   * Scaled up from the model's own 67 m: at 1.25 the pair is 164 m long and
   * 11.3 m tall, which fills the 200 m platforms the way a London terminus
   * frontage does, instead of a 131 m block with the field showing past it.
   */
  const scale = 1.25;
  const [length, height, depth] = stationBuilding.size.map((v) => v * scale);
  const wall0 = stationBuilding.walls[0] * scale;
  const P = STATION.platform;
  // PF1's back edge: the down loop, then the face offset and the platform's width.
  const loopZ = trunkSamples(LOOP_SIDE.down).reduce(
    (m, q) => (Math.abs(q.x - STATION.centre) < Math.abs(m.x - STATION.centre) ? q : m),
  ).z + LOOP_SIDE.down * LOOP.gap;
  const back = loopZ + LOOP_SIDE.down * (P.edge + P.side);
  // Hard up against PF1: the platform's back edge IS the building's wall line.
  const gap = 0;
  return {
    model: '/models/station.glb',
    scale,
    length, height, depth,
    along: STATION.centre,
    across: back + LOOP_SIDE.down * (gap + depth / 2),
    /** The lettered front faces the road: a -Z front faces -across unturned. */
    turn: stationBuilding.front < 0 ? 0 : Math.PI,
    /**
     * Two of it, end to end: one as modelled and one mirrored about their
     * shared end wall, so the pair reads as one symmetrical 134 m building
     * rather than a 67 m one lost against 200 m of platform. `dx` is along the
     * line from `along`; `mirror` flips the copy's length.
     */
    /*
     * Wall to wall. The model's −X end — its portal end — is the one that
     * meets its mirror in the middle, and its wall there stands `walls[0]`
     * from its centre, 1.1 m inside the box the portal frame sets. Placing
     * each copy that far from the join rather than half a box length closes
     * the 2.2 m gap the box-to-box placement left between the two walls.
     */
    copies: [
      { dx: -wall0, mirror: false },
      { dx: wall0, mirror: true },
    ],
    /** The pair's overall length along the line, wall to far end. */
    span: 2 * (length / 2 - wall0),
  };
})();

/**
 * The station's name, on the building's two fascias — generic modern
 * signage, slate blue and teal, not London's. One place to change it.
 */
export const STATION_NAME = 'Halcyon Junction';

/**
 * How far west the car park runs: to along −300, 55 m further than it did,
 * with shops standing across its northern half. The trunk is still on its straight at
 * across 348 there — the S down to the Skylark road starts at −287 and has
 * dropped half a metre by −300 — so the lot's top edge at 327 is 20 m clear.
 */
const PARK_WEST = -300;

/**
 * The ground in front of the building, and the car park past its west end.
 *
 * ## The station road: all kit, so every joint is kit to kit
 *
 * A road of the modular kit runs along the station front, parallel to the
 * outer road and a road's width north of it, so the junction tiles of the two
 * meet mouth to mouth and there is no hand-made piece anywhere between them:
 *
 *   west   the parade's west link crossroads on the outer road (along −104),
 *          whose north arm meets a `junctionT` on the station road — arms
 *          south (that crossroads), east (the station road) and west (the
 *          car park)
 *   along  the station road, a kit run, past the door
 *   east   a `cornerL` turning south into a `junctionT` on the outer road
 *          (`exit`), stem north
 *
 * So the loop is: in at the crossroads, along the front, out at the east T —
 * and every kerb, pavement and line on it is the kit's own. The first attempt
 * was a hand-built ring 7 m wide meeting the kit's 19 m junction arms, and
 * every one of those joints was a mismatch of kerbs and pavements.
 *
 * Between the station road's north pavement and the building is the set-down
 * pavement (`plaza`).
 *
 * ## The car park: one, big, west
 *
 * Past the building's west end, from the outer road's pavement right up to
 * platform 1: entered from the station road's west T, three aisles along the
 * line with rows of bays either side, a cross aisle at each end, and a
 * footpath along its top edge to the platform. Where it runs alongside the
 * building it stops short of the building's west wall.
 */
export const STATION_FORECOURT = (() => {
  const kitHalf = roadModels.parts.straight1.size[2] / 2;
  const outerZ = (PAVING.outerRoad[2] + PAVING.outerRoad[3]) / 2;
  const roadEdge = outerZ + kitHalf;
  /** The station road's centreline: its tiles' south mouths ON the outer road tiles' north mouths. */
  const road = roadEdge + kitHalf;
  const front = STATION_BUILDING.across - STATION_BUILDING.depth / 2;
  const half = STATION_BUILDING.span / 2;
  const west = PARADE_LINKS[1];
  const exit = STATION_BUILDING.along + half - 10;
  const bay = { width: 2.8, depth: 5.8 };
  const aisle = 7;
  /*
   * The car park's bands, from the road upward. The first aisle is on the
   * west T's axis, slid north by `slide` (1.6 m) so a verge opens between the outer
   * road's pavement and the south row, and the hedge stands on that — not on
   * the pavement. The T's arm is a 19 m mouth, so a 7 m aisle 1.6 m off its
   * axis is still well inside it.
   */
  // `bushLow` is 1.49 deep and 1.55 tall; the verge leaves it 15 cm each side.
  const hedge = { width: 1.5, height: 1.55, verge: 1.8 };
  const band = (from: number, size: number): [number, number] => [from, from + size];
  const slide = roadEdge + hedge.verge - (road - aisle / 2 - bay.depth);
  const a1: [number, number] = [road - aisle / 2 + slide, road + aisle / 2 + slide];
  const rowS = band(a1[0] - bay.depth, bay.depth);
  const r1 = band(a1[1], bay.depth);
  const r2 = band(r1[1], bay.depth);
  const a2 = band(r2[1], aisle);
  const r3 = band(a2[1], bay.depth);
  const r4 = band(r3[1], bay.depth);
  const a3 = band(r4[1], aisle);
  const r5 = band(a3[1], bay.depth);
  const path: [number, number] = [r5[1], r5[1] + 3];
  const buildingWest = STATION_BUILDING.along - half;
  const gate = PARADE_LINKS[0];
  return {
    road, roadEdge, kitHalf, front, bay, aisle,
    /** The station road's two ends, which are the two junction tiles' centres. */
    west, exit,
    /** The set-down pavement, from the station road's north edge to the building. */
    plaza: [road + kitHalf, front] as [number, number],
    park: {
      /** West end, and east ends: the south rows reach the west T, the north ones stop short of the building. */
      from: PARK_WEST,
      southTo: west - kitHalf,
      northTo: buildingWest - 2,
      /** Rows below this `across` are clear of the building and may run to `southTo`. */
      clearOfBuilding: front,
      aisles: [a1, a2, a3],
      rows: [
        { z: rowS, nose: -1 }, { z: r1, nose: 1 }, { z: r2, nose: -1 },
        { z: r3, nose: 1 }, { z: r4, nose: -1 }, { z: r5, nose: 1 },
      ] as Array<{ z: [number, number]; nose: 1 | -1 }>,
      bottom: rowS[0],
      top: r5[1],
      path,
      /** Cross aisles at the two ends. */
      ends: [[PARK_WEST, PARK_WEST + aisle], [buildingWest - 2 - aisle, buildingWest - 2]] as Array<[number, number]>,
      /**
       * Where the bigger vehicles go, as runs of `along` on a row: the
       * south row's west end is a bus and coach bay — long vehicles parked
       * along the kerb, not nose in — the first row north of the first aisle
       * is the taxi rank, nearest the station. The lorry park and the shops'
       * loading bays are `STATION_SHOPS`'s.
       */
      busBay: { row: 0, from: PARK_WEST + 8, to: gate - kitHalf - 2 },
      /**
       * The car park's own way in off the outer road: parade link 1's
       * crossroads, whose north arm's mouth is the lot's south edge. The
       * hedge stops and the south row has no bays across its width, so you
       * drive straight through onto the first aisle.
       */
      gate: [gate - kitHalf, gate + kitHalf] as [number, number],
      /**
       * The hedge between the road and the car park, the park's own
       * (`bushLow`, as round the amusement park): on the verge between the
       * outer road's pavement and the south row's kerb, clear of both.
       */
      hedge: { z: roadEdge + hedge.verge / 2, ...hedge },
      taxiRank: { row: 1, from: buildingWest - 2 - aisle - 30, to: buildingWest - 2 - aisle - 1 },
    },
    /** How many bays have a car in them, and the seed that picks which. */
    occupancy: 0.22,
    seed: 11,
    treeEvery: 11,
  };
})();

/**
 * Shops spread across the car park rather than lined up at its end: three
 * pads standing in its northern half, each a shop with its front on the
 * middle aisle (`aisles[1]`) across a strip of pavement, so you park in the
 * rows south of that aisle and walk over. The parade's "shop with canopy",
 * moved here at the user's word, and two more of its units.
 *
 * Beside each pad:
 *
 * - west, a cross aisle from the middle aisle to the footpath, which is how
 *   the rows behind the pads are reached now that the pads cut the north
 *   aisle into pieces;
 * - east, a loading bay across the two rows the pad stands on, with its
 *   delivery lorry nose-out to the aisle.
 *
 * No base under any of them — the user asked for none — so a shop stands
 * straight on the car park's asphalt; `pad` is only the room it keeps.
 *
 * And at the west end of the same half, a lorry park: long bays across the
 * rows, nose-out, for the commercial vehicles. `FACE_THE_ROAD` brings each
 * part's shopfront to +across; a further half turn takes it to −across, onto
 * the aisle. `shopUnit` is 24 m deep and at the others' 1.15 it would stand on
 * the footpath, so it keeps its own size.
 */
export const STATION_SHOPS = (() => {
  const lot = STATION_FORECOURT.park;
  const aisle = STATION_FORECOURT.aisle;
  const pavement = 2;
  const loading = 4.6;
  const front = lot.aisles[1][1] + pavement;
  const items = [
    { part: 'shopUnit', label: 'shop with canopy', at: -254, scale: 1, delivery: 'boxTruck' },
    { part: 'shopPair', label: 'station shops', at: -202, scale: 1.15, delivery: 'boxTruck' },
    { part: 'shopNarrow', label: 'station shop, east', at: -155, scale: 1.15, delivery: 'postvan' },
  ];
  const parts = paradeModels.parts as Record<string, { size: number[] }>;
  const buildings = items.map(({ part, label, at, scale, delivery }) => {
    const base = FACE_THE_ROAD[part] ?? 0;
    const size = parts[part].size;
    // At `base` the front faces +z, so the frontage is its x extent and the
    // depth its z; a quarter-turned part swaps the two. The half turn after
    // swaps nothing.
    const quarter = Math.abs(Math.sin(base)) > 0.5;
    const width = (quarter ? size[2] : size[0]) * scale;
    const depth = (quarter ? size[0] : size[2]) * scale;
    const pad: [number, number] = [at - width / 2 - pavement, at + width / 2 + pavement];
    return {
      part, label, scale, x: at, z: front + depth / 2, turn: base + Math.PI, width, depth, height: size[1] * scale,
      /** The pavement round it, along and across. */
      pad, padZ: [lot.aisles[1][1], Math.min(front + depth + pavement, lot.path[0])] as [number, number],
      /** Its cross aisle (west) and loading bay (east), along. */
      crossAisle: [pad[0] - aisle, pad[0]] as [number, number],
      loadingBay: [pad[1], pad[1] + loading] as [number, number],
      delivery,
    };
  });
  const west = buildings[0].crossAisle[0];
  const bays = 6;
  return {
    front,
    /** Everything here stands north of the middle aisle; its bays are not painted. */
    northOf: lot.aisles[1][1],
    buildings,
    /** Along the rows from the west cross aisle to the first pad's; bays 18 m deep from the middle aisle. */
    lorryPark: {
      from: lot.ends[0][1], to: west, bays, width: (west - lot.ends[0][1]) / bays,
      z: [lot.aisles[1][1], lot.aisles[1][1] + 18] as [number, number],
      /**
       * West to east; '' leaves a bay empty. `country:` parts are the
       * Skylark island's own lorries, out of `country.glb`; the rest are the
       * city's (`trucks.glb`, `vehicles.glb`).
       */
      fleet: ['country:artic', '', 'artic', '', 'country:lorryCab', ''],
    },
    /** Along ranges where the northern rows have no bays. */
    reserved: [
      [lot.ends[0][1], west],
      ...buildings.map((b) => [b.crossAisle[0], b.loadingBay[1]]),
    ] as Array<[number, number]>,
  };
})();

/**
 * The parcel hub — the courier section the user asked for, on the open ground
 * north of the station building, between the outer road and platform 1's
 * lengthened north end (`PF1_NORTH`), where parcels come off the trains.
 *
 * Built from what the game already has rather than new models: the airport's
 * 60 m cargo shed (`shed`, turned to lie along the line) as the sorting shed,
 * the Skylark island's site office and floodlight masts, the airport's
 * baggage carts as parcel carts, the city's box truck and the traffic's post
 * vans. The shipping containers are the only thing made here — the city's
 * `deco_container1` is every container in the city in one mesh.
 *
 * - **Way in** off the outer road through the airport entrance's crossroads
 *   (`ENTRY.centre`), whose north arm opens straight into the yard. The yard
 *   stands a verge back from the road, like the car park, with its fence on
 *   the verge and the verge paved across the gate.
 * - **Shed and dock.** The shed's long side faces the gate across the truck
 *   apron, with a raised loading dock along it and `dockBays` of it marked
 *   out; lorries and vans back onto it.
 * - **Van park** west of the gate, nose in to the fence; **office** east of
 *   it; **containers** east of the shed; a **distribution centre** — a
 *   building cut out of the city's industrial estate — at the north end,
 *   with a **lorry park** and a **fuel canopy** before it.
 * - **Seamless with the station**: no fence on the west, where the yard runs
 *   from the station road's east T up to the building's end and PF1's back;
 *   none on the east either, toward the Wall of Death. Only the road side and
 *   the tracks are fenced.
 * - **Carts** on PF1's new stretch, waiting for a train, and the PF1 vehicle
 *   ramp lands in the yard's west end, so a van can go from dock to platform.
 */
export const COURIER_HUB = (() => {
  const roadEdge = STATION_FORECOURT.roadEdge;
  const verge = 1.8;
  // From the station road's east T — whose east arm opens into the yard —
  // north to short of the Wall of Death, whose site starts at along 294;
  // that end is left open, so you can drive straight on to the drome.
  const west = STATION_FORECOURT.exit + STATION_FORECOURT.kitHalf;
  const east = 290;
  const bottom = roadEdge + verge;
  // Up to PF1's back edge, so the yard meets the platform with no strip of grass between.
  const top = 328;
  const gate = ENTRY.centre;
  /** The second way in, off its own T on the outer road, clear of the containers and the lorry park. */
  const gate2 = 205;
  const kitHalf = STATION_FORECOURT.kitHalf;
  const shed = { part: 'shed', x: gate, z: 316.2, width: 14.65, length: 60, height: 10.89 };
  const dock = { height: 1.2, depth: 3.6, z1: shed.z - shed.width / 2, from: shed.x - 28, to: shed.x + 28 };
  return {
    west, east, bottom, top, gate: [gate - kitHalf, gate + kitHalf] as [number, number],
    gate2: [gate2 - kitHalf, gate2 + kitHalf] as [number, number],
    gate2Centre: gate2,
    fence: { z: roadEdge + verge / 2, height: 2.4, post: 2.5 },
    shed,
    dock: { ...dock, z0: dock.z1 - dock.depth },
    dockBays: { width: 4, count: 14, depth: 16 },
    /** Which dock bays have something backed onto them, west to east; '' is an empty bay. */
    // Six of fourteen, no two alike side by side — the user asked for fewer and less repetitive.
    // `airport:` parts are the airport's (its catering high-loader, a box body on a lorry chassis).
    fleet: ['', 'boxTruck', 'country:siteLorry', '', 'country:artic', '', 'postvan', 'airport:cateringTruck', '', 'country:lorryCab', '', 'rdservtruck', 'towtruck', 'artic'],
    vans: { from: west + 4, to: gate - kitHalf - 3, z: [bottom + 0.5, bottom + 6.3] as [number, number], width: 3, fill: 0.35 },
    office: { part: 'indOffice', x: gate + kitHalf + 12, z: bottom + 5, turn: 0 },
    containers: { x: 162, z0: 292, length: 12.19, width: 2.44, height: 2.59, rows: 5, gap: 0.5 },
    /** The Skylark island's warehouse, and the lorry park on the apron in front of it. */
    /*
     * The hub's two buildings of its own, both in the one modern style the
     * station set — ribbed silver cladding over a slate plinth, a teal line
     * under a flat parapet, a glazed office at one end, roller shutters along
     * the front — built by `CourierHub` rather than lifted from a kit. The
     * city's brick depot and the Skylark island's shed were here first and
     * the user found both "too old".
     *
     * `width` is along, `depth` across; the doors are on the −across face,
     * toward the yard and the road, and `office` says which end is glazed.
     */
    depot: { x: 258, z: 313.5, width: 46.5, depth: 23.5, height: 10, doors: 6, office: 'east' as const, sign: 'Distribution Centre' },
    /** The workshop in the open west end, between the station and PF1's first ramp, its short side to the yard. */
    workshop: { x: west + 12, z: 304, width: 15, depth: 27.8, height: 8, doors: 2, office: null, sign: 'Fleet Workshop' },
    /**
     * What stands on PF1's floor: parcel vans, and the small open platform
     * vehicles — the airport's tug and its baggage carts, low, open and on
     * little wheels. Nothing else; the user wants no cars on the platform.
     * Lengthwise, clear of the second ramp's mouth (along 178–196); `z` 0
     * means on the platform strip, otherwise on the deck at that `z`.
     */
    // Fewer, at the user's word, and no tug.
    platformParked: [
      ['postvan', 70, 324, 1], ['airport:cart', 132, 0, 1], ['postvan', 160, 0, -1], ['airport:cart', 204, 0, -1],
    ] as Array<[string, number, number, 1 | -1]>,
    /**
     * A container train standing on PF1's spur, for the parcel traffic,
     * top-and-tailed: a Class 37 at each end — the front one facing north,
     * the rear one facing back down the line — and between them
     * container flats only, no vans: 40 ft boxes alternating with pairs of
     * 20 ft boxes in mixed colours. The two flats share one underframe, so
     * the length is the same either way. Ten flats is
     * what fits on the straight: 158 m over the couplers, from `frontAt` —
     * along 239, where the buffer stop's 25 m clear run used to begin — back
     * to along 81, just north of where the spur leaves the loop at 68.
     */
    train: {
      loco: 'class37' as const,
      wagons: Array.from({ length: 10 }, (_, i) => (i % 2 ? 'flat20' : 'flat40') as 'flat20' | 'flat40'),
      tail: true,
      frontAt: 234,
    },
    // Between PF1's second ramp (along 178–196) and the depot, nose out to the north gate's lane.
    lorries: { from: 198, to: 228, z: [290, 308] as [number, number], fleet: ['country:artic', '', 'towtruck', '', 'boxTruck', ''] },
    /** A second site office, for the north end. */
    office2: { part: 'indOffice', x: 278, z: bottom + 5, turn: 0 },
    // Clear of the PF1 ramp and its foot (along 64–82), of the lanes, and of the warehouse door.
    /** A second van row along the fence between the office and the north gate, with a few staff cars. */
    vans2: { from: gate + kitHalf + 30, to: gate2 - kitHalf - 3, z: [bottom + 0.5, bottom + 6.3] as [number, number], width: 3, fill: 0.5 },
    /** A fuel and charging canopy past the north gate, two pump islands under it. */
    fuel: { from: 254, to: 268, z: [bottom + 2, bottom + 13] as [number, number], height: 5.2 },
    /** No more than two towers on the site — the user's limit. */
    // One by the station end, one in the far corner past the depot — none out in the yard.
    masts: [[west + 5, 322], [east - 3, 326]] as Array<[number, number]>,
    /** A bus shelter for the staff by the main gate's office, and bins by the doors. */
    shelter: { x: gate + kitHalf + 22, z: bottom + 3.2, turn: Math.PI / 2 },
    bins: [[gate + kitHalf + 18, bottom + 1.2], [shed.x - 32, shed.z + 0.6], [236, 293], [282, 293]] as Array<[number, number]>,
    /** Parcel carts on PF1's new stretch, clear of its ramp and its end slope. */
    carts: { from: STATION_PLATFORM.to + 18, count: 2, pitch: 4.4 },
    sign: { x: gate - kitHalf - 1.5, z: bottom + 2.5, text: 'Halcyon Parcel Hub' },
  };
})();

/* --------------------------------------------------------- the formation -- */

/**
 * The ground the track stands on, and there is ONE bed per corridor.
 *
 * Every track used to carry its own trapezium and that is wrong twice over,
 * for the same two reasons the island station's throat records. Where the
 * roads are far apart the beds do not meet and a wedge of GRASS shows between
 * two running lines, which no railway has. Where they converge the beds
 * overlap, and since they are at the same depth the overlaps are coplanar and
 * z-fight — a grey mess of criss-crossing edges that flickers as you move.
 * Measured here before the rewrite: the connection's bed lay inside the
 * trunk's for 56 m, and the link's inside the connection's for 18 samples.
 *
 * So a bed is laid along a corridor rather than along a track, and its two
 * edges follow the outermost and innermost thing standing on it. `lo` and `hi`
 * are those, as offsets along the corridor's own normal.
 */
export interface Formation extends Sample {
  /** Offset of the leftmost track carried here. */
  lo: number;
  /** Offset of the rightmost. */
  hi: number;
}

/**
 * When a bed takes another track over, and it is not a matter of taste.
 *
 * Two beds should meet EXACTLY where their shoulders touch. Sooner and they
 * overlap — coplanar, z-fighting, the grey mess the station's throat records.
 * Later and the bed jumps outward in one cross-section, which is a 13 m step
 * in the edge of the ground.
 *
 * So the threshold is the touching distance, and it depends on what is already
 * on the corridor: `outer` is how far out the corridor's own outermost track
 * sits, and a shoulder reaches `crownHalf` past a track, so the two edges meet
 * when the newcomer is `outer + 2 · crownHalf` away. The trunk's pair gives
 * 2.3 + 4.6 = 6.9 m; a single-track corridor gives 4.6.
 *
 * Past that they are two beds with GRASS between them, which is what the land
 * inside a pair of diverging lines actually is. Filling it makes a junction
 * look like a car park.
 */
export const touchAt = (outer: number) => outer + 2 * BALLAST.line.crownHalf;

/** Signed offset of the nearest point of `line` from `at`, along `at`'s normal. */
function offsetOf(at: Sample, line: Sample[], within: number): number | null {
  let best = Infinity;
  let off = 0;
  for (const q of line) {
    const d = Math.hypot(q.x - at.x, q.z - at.z);
    if (d < best) { best = d; off = (q.x - at.x) * at.nx + (q.z - at.z) * at.nz; }
  }
  return best <= within ? off : null;
}

/** Widen a corridor's edges to take in a track at `off`, if it is close enough. */
function take(edges: { lo: number; hi: number }, off: number | null, outer: number) {
  if (off === null || Math.abs(off) > touchAt(outer)) return edges;
  return { lo: Math.min(edges.lo, off), hi: Math.max(edges.hi, off) };
}

/**
 * The trunk's corridor: two roads, the crossover between them, and — for the
 * last stretch — the connection as well, which is what makes it a junction.
 */
export function trunkFormation(): Formation[] {
  const connection = connectionSamples();
  // The spur rides on the same bed — it is inside `reach` of the trunk the whole way.
  const loops = [stationLoop('down'), stationLoop('up'), pf1Spur()];
  const half = TRACK_GAP / 2;
  /*
   * The station is ONE bed, under all four tracks, for the loops' whole length.
   *
   * It was a corridor that carried each loop until it was two crown halves out
   * and then handed it to a bed of its own, as the junction does. The corridor
   * edge snaps back to the mains in one 2 m sample at a handover, and between
   * that diagonal and the start of the loop's own bed there was a triangle of
   * grass — four of them, one at each toe. A station yard is ballasted right
   * across between its roads anyway, so the bed simply takes each loop all the
   * way out: no handover, nothing to leave a gap, and the island platforms
   * stand on it.
   */
  const reach = LOOP.gap + half + 1;
  return trunkCentre().map((s) => {
    let e = take({ lo: -half, hi: half }, offsetOf(s, connection, touchAt(half)), half);
    for (const loop of loops) {
      const off = offsetOf(s, loop, reach);
      if (off !== null) e = { lo: Math.min(e.lo, off), hi: Math.max(e.hi, off) };
    }
    return { ...s, ...e };
  });
}

/** Where the trunk's bed takes the connection over, in the connection's arc. */
export const ABSORB_AT = (() => {
  const trunk = trunkCentre();
  const limit = touchAt(TRACK_GAP / 2);
  for (const q of connectionSamples()) {
    let best = Infinity;
    for (const t of trunk) best = Math.min(best, Math.hypot(t.x - q.x, t.z - q.z));
    if (best <= limit) return q.arc;
  }
  return Infinity;
})();

/** And where the connection's bed takes the link over, in the link's own arc. */
export const LINK_ABSORB_AT = (() => {
  const connection = connectionSamples();
  const limit = touchAt(0);
  for (const q of downLinkSamples()) {
    let best = Infinity;
    for (const t of connection) best = Math.min(best, Math.hypot(t.x - q.x, t.z - q.z));
    if (best <= limit) return q.arc;
  }
  return Infinity;
})();

/**
 * The connection's corridor: itself, and the link once the link has closed in.
 *
 * It stops where `ABSORB_AT` says the trunk's bed has taken over, and the two
 * abut there rather than overlapping — at the touching distance the trunk's
 * new edge and this one's are the same line, so the handover is seamless in
 * both directions.
 */
/**
 * How far a branch's own bed runs on past the handover, and how far under
 * the bed that takes it over it sits.
 *
 * At a handover the carrying bed's edge snaps back in one sample, and a bed
 * that stopped exactly there left a triangle of grass between that diagonal
 * and itself. Running on one sample and a hair lower covers the triangle,
 * and the 5 mm keeps the overlap from z-fighting: the carrying bed is the
 * one on top where both are.
 */
const HANDOVER = { past: STEP * 1.5, under: 0.005 } as const;

export function connectionFormation(): Formation[] {
  const link = downLinkSamples();
  return connectionSamples()
    .filter((s) => s.arc <= ABSORB_AT + HANDOVER.past)
    .map((s) => ({ ...s, depth: s.depth - HANDOVER.under, ...take({ lo: 0, hi: 0 }, offsetOf(s, link, touchAt(0)), 0) }));
}

/** The link's own bed, for as long as it is its own track. */
export function linkFormation(): Formation[] {
  return downLinkSamples()
    .filter((s) => s.arc <= LINK_ABSORB_AT + HANDOVER.past)
    .map((s) => ({ ...s, depth: s.depth - 2 * HANDOVER.under, lo: 0, hi: 0 }));
}

/**
 * The level crossing's edges, which take in EVERY track on the road.
 *
 * Not the formation's, and this is the one place the two part company. A bed
 * stops at the touching distance and leaves grass in the V; a road does not —
 * you surface the whole carriageway, between the tracks included, or you have
 * left a trench in it. The connection is 5 to 10 m off the trunk where it
 * crosses, which is past the touching distance, so a deck built off the
 * formation would have ended between the two sets of rails.
 */
export function crossingEdges(): Formation[] {
  const onRoad = (q: Sample) => q.z >= CROSSING_SPAN.from && q.z <= CROSSING_SPAN.to;
  // Only the part of each track that is ITSELF on the road. Searching the whole
  // of it instead reached 20 m sideways for a rail that crosses ten metres
  // away, and surfaced the field beside the carriageway.
  const tracks = [connectionSamples().filter(onRoad), downLinkSamples().filter(onRoad)];
  const half = TRACK_GAP / 2;
  return trunkFormation().filter(onRoad).map((s) => {
    let lo = -half;
    let hi = half;
    for (const t of tracks) {
      if (!t.length) continue;
      const off = offsetOf(s, t, CROSSING_SPAN.to - CROSSING_SPAN.from);
      if (off === null) continue;
      lo = Math.min(lo, off);
      hi = Math.max(hi, off);
    }
    return { ...s, lo, hi };
  });
}



/* --------------------------------------------------------- what carries it -- */

/**
 * Where the trunk leaves the island, in `along`.
 *
 * North of this it is over water and stands on a viaduct; south of it the
 * ground is the island's own crown and it stands on ballast. Taken from the
 * shoreline rather than guessed — `AirportIsland` passes the test in.
 */
export const VIADUCT = {
  /**
   * Deck, parapet and piers: the main line's, so the two read as one railway.
   *
   * The ELEVATED deck, not the single-track one — 5.3 m of half-width for a
   * pair standing 4.6 m apart, which leaves 1.65 m outside the sleeper ends
   * for the walkway a two-road viaduct has. `TRAIN.deckHalf` is 3.1 and would
   * have had the outer sleepers hanging over the parapet.
   */
  deckHalf: TRAIN.elevated.deckHalf,
  deckThickness: TRAIN.deckThickness,
  parapetHeight: TRAIN.parapetHeight,
  parapetWidth: TRAIN.parapetWidth,
  pierSpacing: TRAIN.pierSpacing,
  pierHalf: TRAIN.pierHalf,
  /**
   * Local y of the seabed and the water, measured down from the island crown.
   *
   * From `SITE.ground`, not a literal: the crown was 3.4 when these were
   * written and is 0 now, and a hard-coded 3.4 stood every pier 3.4 m into
   * the seabed.
   */
  seabed: TRAIN.seabed - SITE.ground,
  water: TRAIN.seaLevel - SITE.ground,
} as const;

/**
 * The level crossing: one crossing, two tracks.
 *
 * The bridge road runs along `across` 252 to 266 and BOTH the trunk and the
 * connection cross it — that is the price of putting the turnout on the far
 * side, and it is the right price. Drawn as one crossing spanning both rather
 * than two beside each other, the same way the yard's five roads share a
 * crossing rather than having one each.
 */
export const CROSSING_SPAN = {
  /**
   * The band of `across` the carriageway occupies, and no more.
   *
   * The bridge road runs at 252 to 266, so 250 to 268 is the tarmac plus a
   * metre of verge at each kerb. It was tried at 232 to 268 first, on a
   * misreading of how far each track is inside the road: they cross at an
   * angle, so each is in the band for fifteen to twenty metres of ITS OWN
   * length while the road stays eighteen wide. Widening the band widened the
   * deck instead, and what it drew was a 27 m grey apron lying across the
   * grass on both sides of the road.
   */
  from: 250,
  to: 268,
  /**
   * How far the tarmac ramps out either side of the sleeper ends.
   *
   * The rail head stands 0.62 + 0.22 + 0.16 m over the road, and a metre-high
   * step across a carriageway is not a level crossing, it is a kerb. The road
   * comes UP to the rail instead: eight metres for 0.84 m of rise, which is
   * 10% — steep for a road and normal for the approach to a crossing, where
   * you are slowing anyway. The yard's own crossings ramp over twelve, but
   * they have a forty-metre apron to do it on and this has a verge.
   */
  ramp: 8,
} as const;

/** The yard roads' railheads, so the connection can be checked against them. */
export const railheadOf = (at: number): Pt => {
  const road = SIDINGS.roads.find((r) => r.at === at);
  if (!road) throw new Error(`islandRailConfig: no yard road at ${at}`);
  const pts = sidingCentre(road, 1);
  return pts[pts.length - 1] as Pt;
};
