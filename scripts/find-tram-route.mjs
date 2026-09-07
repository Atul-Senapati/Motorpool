/**
 * Finds a self-crossing tram route on the city's real streets.
 *
 * The first tram loop was a rounded rectangle over four hand-picked streets.
 * This searches for something more interesting — a **figure-eight**, which
 * crosses itself once — and, like the rectangle before it, refuses to invent
 * anything: every candidate is checked metre by metre against `cityNav.png`,
 * the same road/height raster the car's reset and the traffic AI use, and a
 * route is only accepted if the whole thing is on pavement and flat enough to
 * lay rail on.
 *
 * The shape, as a closed rectilinear polyline over three streets each way:
 *
 *        x0      x1      x2
 *   z0    .──────┬───────.        travel order: (x1,z0) → (x2,z0) → (x2,z1)
 *         │      │       │                    → (x0,z1) → (x0,z2) → (x1,z2)
 *   z1    .──────┼───────'                    → back to (x1,z0)
 *         │      │
 *   z2    '──────'
 *
 * The two legs along `z1` and along `x1` cross at (x1, z1) — a real level
 * crossing, at ninety degrees, which is the point of the exercise. The
 * crossing is deliberately *not* a vertex: the tram runs straight through it
 * twice per lap, once westbound and once northbound.
 *
 * "Random" means the search shuffles its candidates and takes the first route
 * that passes, so re-running gives a different loop. The seed is printed and
 * can be passed back in to reproduce one exactly:
 *
 *   npm run route:tram              # a new random route
 *   npm run route:tram -- 12345     # that exact route again
 *
 * Emits `src/config/tramRoute.json`, which `railConfig.ts` reads. Nothing is
 * generated at runtime — a route that wandered onto a building on some page
 * loads and not others would be the worst of both worlds.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const NAV_IMAGE = 'public/models/cityNav.png';
const CITY_DATA = 'src/config/cityData.json';
const OUT = 'src/config/tramRoute.json';

/** Corner radius the rails are laid to, and what `railConfig` will use. */
const CORNER_RADIUS = 10;
/**
 * Half-width of pavement the route needs either side of its centreline. The
 * tram is 2.65 m wide; this leaves a little either side without demanding a
 * boulevard, since the rails only have to clear the kerb, not a lane.
 */
const CORRIDOR = 1.8;
/** Metres between samples when validating. Finer than the raster's 1.5 m. */
const STEP = 1.0;
/** Rail cannot be laid over a hill: the whole route must sit within this band. */
const MAX_RELIEF = 1.2;

/** A leg shorter than this cannot hold two corner arcs and a straight. */
const MIN_LEG = CORNER_RADIUS * 2 + 40;
/** Keeps the loop city-sized rather than a lap of the whole map. */
const MAX_LEG = 900;
/**
 * Lap length to aim for, metres. The rectangle this replaces was 2.2 km, which
 * at line speed puts a tram past any given stop often enough to feel like a
 * service. The first search accepted whatever passed first and produced a
 * 7.7 km lap — nine minutes a circuit, so you would essentially never meet a
 * tram. Candidates outside this window are discarded however clear they are.
 */
const TARGET_LAP = [1300, 3600];
/** Stop once this many valid routes are in hand, then pick one at random. */
const WANT = 24;
/** A hard ceiling on the search, so a bad seed cannot run for ever. */
const MAX_TRIES = 40000;

const seed = Number(process.argv[2] ?? Math.floor(Math.random() * 1e9));
let rngState = seed >>> 0;
/** xorshift32 — small, seeded, and reproducible across runs. */
function rng() {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 0x100000000;
}
const shuffle = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ---------------------------------------------------------------------------
// The raster.
// ---------------------------------------------------------------------------
const city = JSON.parse(readFileSync(CITY_DATA, 'utf8'));
const { originX, originZ, metresPerPixel, minY, maxY } = city.nav;

const { data, info } = await sharp(NAV_IMAGE).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const CH = info.channels;
console.log(`nav raster ${W}x${H} at ${metresPerPixel} m/px, origin (${originX}, ${originZ})`);

const px = (x) => Math.round((x - originX) / metresPerPixel);
const pz = (z) => Math.round((z - originZ) / metresPerPixel);

function isRoad(x, z) {
  const i = px(x); const j = pz(z);
  if (i < 0 || j < 0 || i >= W || j >= H) return false;
  return data[(j * W + i) * CH] > 127;
}

function groundHeight(x, z) {
  const i = px(x); const j = pz(z);
  if (i < 0 || j < 0 || i >= W || j >= H) return null;
  const o = (j * W + i) * CH;
  const u16 = (data[o + 1] << 8) | data[o + 2];
  return minY + (u16 / 65535) * (maxY - minY);
}

/** Road, and road far enough either side to take a tram. */
function corridorClear(x, z, alongX) {
  if (!isRoad(x, z)) return false;
  for (const d of [-CORRIDOR, CORRIDOR]) {
    if (alongX ? !isRoad(x, z + d) : !isRoad(x + d, z)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Candidate streets: long unbroken paved runs, axis-aligned.
// ---------------------------------------------------------------------------
function longestRun(fixed, alongX) {
  // Walk the whole map on this line and keep the longest clear stretch.
  const from = alongX ? originX : originZ;
  const to = alongX ? originX + W * metresPerPixel : originZ + H * metresPerPixel;
  let best = null; let start = null;
  for (let v = from; v <= to; v += STEP * 2) {
    const clear = alongX ? corridorClear(v, fixed, true) : corridorClear(fixed, v, false);
    if (clear) {
      if (start === null) start = v;
    } else if (start !== null) {
      const length = v - STEP * 2 - start;
      if (!best || length > best.length) best = { from: start, to: v - STEP * 2, length };
      start = null;
    }
  }
  if (start !== null) {
    const length = to - start;
    if (!best || length > best.length) best = { from: start, to, length };
  }
  return best;
}

console.log('scanning for streets…');
const horizontals = [];   // constant z, running along x
const verticals = [];     // constant x, running along z
for (let z = originZ; z < originZ + H * metresPerPixel; z += 6) {
  const run = longestRun(z, true);
  if (run && run.length >= MIN_LEG) horizontals.push({ at: z, ...run });
}
for (let x = originX; x < originX + W * metresPerPixel; x += 6) {
  const run = longestRun(x, false);
  if (run && run.length >= MIN_LEG) verticals.push({ at: x, ...run });
}
console.log(`  ${horizontals.length} horizontal streets, ${verticals.length} vertical`);

/** Thin out near-duplicates: adjacent scan lines on one wide street. */
function thin(list) {
  const out = [];
  for (const s of list.sort((a, b) => a.at - b.at)) {
    if (!out.length || s.at - out[out.length - 1].at > 24) out.push(s);
    else if (s.length > out[out.length - 1].length) out[out.length - 1] = s;
  }
  return out;
}
const HS = thin(horizontals);
const VS = thin(verticals);
console.log(`  thinned to ${HS.length} horizontal, ${VS.length} vertical`);

// ---------------------------------------------------------------------------
// Validation: walk the finished route and check every metre.
// ---------------------------------------------------------------------------
/** Straights and quarter-turns for a closed rectilinear polyline. */
function buildPath(points, radius) {
  const n = points.length;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const here = points[i];
    const next = points[(i + 1) % n];
    const inDir = norm([here[0] - prev[0], here[1] - prev[1]]);
    const outDir = norm([next[0] - here[0], next[1] - here[1]]);
    const start = [here[0] - inDir[0] * radius, here[1] - inDir[1] * radius];
    const end = [here[0] + outDir[0] * radius, here[1] + outDir[1] * radius];
    segs.push({ kind: 'corner', start, end, here, inDir, outDir });
  }
  return segs;
}
const norm = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

function routeSamples(points, radius) {
  const corners = buildPath(points, radius);
  const out = [];
  /*
   * Arc first, then the straight that leaves it. Emitting them the other way
   * round still validates the same points — every metre of the route is
   * checked either way — but consecutive samples then jump backwards between
   * pieces, and summing the gaps to measure the lap inflated it by about two
   * and a half times. The first run of this search reported a 2.28 km lap for
   * a route that is really 850 m, which is exactly the kind of number a
   * length filter must not be fed.
   */
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    const nextC = corners[(i + 1) % corners.length];

    // The quarter turn, swept about the corner's centre.
    const cx = c.here[0] - c.inDir[0] * radius + c.outDir[0] * radius;
    const cz = c.here[1] - c.inDir[1] * radius + c.outDir[1] * radius;
    const a0 = Math.atan2(c.start[1] - cz, c.start[0] - cx);
    const a1 = Math.atan2(c.end[1] - cz, c.end[0] - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const steps = Math.max(4, Math.ceil((Math.abs(sweep) * radius) / STEP));
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + sweep * (k / steps);
      out.push([cx + radius * Math.cos(ang), cz + radius * Math.sin(ang)]);
    }

    // Then the straight from this corner's exit to the next corner's entry.
    const a = c.end; const b = nextC.start;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 0) return null;
    for (let t = STEP; t <= len; t += STEP) {
      out.push([a[0] + (b[0] - a[0]) * (t / len), a[1] + (b[1] - a[1]) * (t / len)]);
    }
  }
  return out;
}

function validate(points) {
  const samples = routeSamples(points, CORNER_RADIUS);
  if (!samples) return null;
  let lo = Infinity; let hi = -Infinity;
  for (const [x, z] of samples) {
    if (!isRoad(x, z)) return null;
    const h = groundHeight(x, z);
    if (h === null) return null;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (hi - lo > MAX_RELIEF) return null;
  let length = 0;
  for (let i = 1; i < samples.length; i++) {
    length += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
  }
  return { relief: hi - lo, length, samples: samples.length };
}

// ---------------------------------------------------------------------------
// The search.
// ---------------------------------------------------------------------------
const within = (street, a, b) => street.from <= Math.min(a, b) && street.to >= Math.max(a, b);
const legOk = (a, b) => {
  const d = Math.abs(a - b);
  return d >= MIN_LEG && d <= MAX_LEG;
};

console.log(`searching (seed ${seed})…`);
const valid = [];
let tried = 0;

outer:
for (const z0 of shuffle(HS)) {
  for (const z1 of shuffle(HS)) {
    if (!legOk(z0.at, z1.at) || z1.at <= z0.at) continue;
    for (const z2 of shuffle(HS)) {
      if (!legOk(z1.at, z2.at) || z2.at <= z1.at) continue;
      for (const x0 of shuffle(VS)) {
        for (const x1 of shuffle(VS)) {
          if (!legOk(x0.at, x1.at) || x1.at <= x0.at) continue;
          for (const x2 of shuffle(VS)) {
            if (!legOk(x1.at, x2.at) || x2.at <= x1.at) continue;

            // Every leg has to lie inside its street's own paved run.
            if (!within(z0, x1.at, x2.at)) continue;
            if (!within(z1, x0.at, x2.at)) continue;
            if (!within(z2, x0.at, x1.at)) continue;
            if (!within(x2, z0.at, z1.at)) continue;
            if (!within(x0, z1.at, z2.at)) continue;
            if (!within(x1, z0.at, z2.at)) continue;

            if (++tried > MAX_TRIES) break outer;
            const points = [
              [x1.at, z0.at], [x2.at, z0.at], [x2.at, z1.at],
              [x0.at, z1.at], [x0.at, z2.at], [x1.at, z2.at],
            ];
            const check = validate(points);
            if (!check) continue;
            if (check.length < TARGET_LAP[0] || check.length > TARGET_LAP[1]) continue;
            valid.push({ points, crossing: [x1.at, z1.at], ...check });
            if (valid.length >= WANT) break outer;
          }
        }
      }
    }
  }
}

if (!valid.length) {
  console.error(`no valid figure-eight found in ${tried} candidates (seed ${seed}).`);
  console.error('Try another seed, or relax TARGET_LAP / MIN_LEG / CORRIDOR / MAX_RELIEF.');
  process.exit(1);
}
const found = valid[Math.floor(rng() * valid.length)];

writeFileSync(OUT, `${JSON.stringify({
  seed,
  cornerRadius: CORNER_RADIUS,
  /** Closed rectilinear polyline, in travel order. */
  points: found.points.map((p) => p.map((v) => +v.toFixed(2))),
  /** Where the route crosses itself, which the tram passes through twice a lap. */
  crossing: found.crossing.map((v) => +v.toFixed(2)),
  lengthMetres: +found.length.toFixed(1),
  reliefMetres: +found.relief.toFixed(2),
}, null, 2)}\n`);

console.log(`\n--- tram route ---`);
console.log(`  seed ${seed} · ${tried} candidates tried · ${valid.length} valid, one picked`);
console.log(`  ${found.length.toFixed(0)} m lap, relief ${found.relief.toFixed(2)} m, `
  + `${found.samples} samples all on pavement`);
console.log(`  crossing at (${found.crossing[0].toFixed(0)}, ${found.crossing[1].toFixed(0)})`);
console.log(`  points ${found.points.map((p) => `(${p[0].toFixed(0)},${p[1].toFixed(0)})`).join(' -> ')}`);
console.log(`  wrote ${OUT}\n`);
