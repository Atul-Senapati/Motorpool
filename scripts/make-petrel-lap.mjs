/**
 * Petrel's racing lap, traced off the tarmac.
 *
 *     npm run lap:petrel
 *
 * The circuit island's track is not in the road graph as a lap: the graph
 * was skeletonised off the nav raster, and round Petrel it is a tangle of
 * junction-to-junction pieces — the outer road, the infield roads, the
 * bridge approaches — none of which is "the circuit". The racers want the
 * circuit: the whole perimeter, the long east road, the S-bends and the
 * south-east loop, the bottom straight, the big south-west loop, up the
 * west side and the long diagonal, and the hairpin back onto the east road.
 *
 * So the lap is drawn: a hand-placed line of points round that loop (`ROUGH`,
 * read off the raster), then each point is pulled to the middle of the road
 * it is on — scanned square to the line for the run of street pixels nearest
 * it — smoothed, and resampled every `STEP` metres.
 *
 * Emits `src/config/petrelLap.json`: `[[x, z], ...]`, a closed loop in the
 * direction of racing (the last point is not repeated).
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const NAV = 'public/models/cityNav.png';
const CITY = 'src/config/cityData.json';
const OUT = 'src/config/petrelLap.json';
const STEP = 4;
/** How far either side of the rough line a road's middle is looked for, metres. */
const SCAN = 16;

/** The loop, roughly, in racing order — from the hairpin, south down the east road. */
const ROUGH = [
  [-1537, 315], [-1531, 400], [-1528, 500], [-1528, 600], [-1534, 640], [-1556, 656], [-1570, 676],
  [-1564, 705], [-1540, 742], [-1516, 782], [-1510, 822], [-1522, 862], [-1552, 896], [-1602, 928],
  [-1652, 944], [-1702, 953], [-1760, 960], [-1800, 966], [-1828, 988], [-1845, 1018], [-1880, 1040],
  [-1935, 1056], [-1966, 1040], [-1981, 1000], [-1985, 950], [-1978, 900], [-1952, 870], [-1910, 840],
  [-1880, 800], [-1856, 742], [-1830, 702], [-1790, 672], [-1758, 640], [-1745, 600], [-1742, 560],
  [-1730, 522], [-1705, 482], [-1675, 442], [-1640, 397], [-1610, 357], [-1586, 322], [-1566, 292],
  [-1552, 282], [-1542, 292],
];

const nav = JSON.parse(readFileSync(CITY, 'utf8')).nav;
const { data, info } = await sharp(NAV).raw().toBuffer({ resolveWithObject: true });
const isStreet = (x, z) => {
  const i = Math.floor((x - nav.originX) / nav.metresPerPixel);
  const j = Math.floor((z - nav.originZ) / nav.metresPerPixel);
  if (i < 0 || j < 0 || i >= info.width || j >= info.height) return false;
  const o = (j * info.width + i) * 4;
  return data[o + 3] > 0 && data[o] > 191;
};

/** A closed polyline resampled every `step` metres. */
function resample(points, step) {
  const out = [];
  const n = points.length;
  let carry = 0;
  for (let k = 0; k < n; k++) {
    const [ax, az] = points[k];
    const [bx, bz] = points[(k + 1) % n];
    const len = Math.hypot(bx - ax, bz - az);
    let t = carry;
    while (t < len) {
      out.push([ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len]);
      t += step;
    }
    carry = t - len;
  }
  return out;
}

/** Each point to the middle of the street run it is on, scanned square to the line. */
function centre(points) {
  const n = points.length;
  let moved = 0;
  const out = points.map(([x, z], k) => {
    const [px, pz] = points[(k - 1 + n) % n];
    const [qx, qz] = points[(k + 1) % n];
    const len = Math.hypot(qx - px, qz - pz) || 1;
    const nx = -(qz - pz) / len;
    const nz = (qx - px) / len;
    // The street run nearest the line: walk out both ways to its edges.
    let s0 = null;
    for (let d = 0; d <= SCAN; d += 0.5) {
      if (isStreet(x + nx * d, z + nz * d)) { s0 = d; break; }
      if (isStreet(x - nx * d, z - nz * d)) { s0 = -d; break; }
    }
    if (s0 === null) return [x, z];
    let lo = s0;
    let hi = s0;
    while (lo > s0 - 30 && isStreet(x + nx * (lo - 0.5), z + nz * (lo - 0.5))) lo -= 0.5;
    while (hi < s0 + 30 && isStreet(x + nx * (hi + 0.5), z + nz * (hi + 0.5))) hi += 0.5;
    // A run much wider than a track is a junction: keep the line, don't chase its middle.
    if (hi - lo > 34) return [x, z];
    const mid = (lo + hi) / 2;
    moved = Math.max(moved, Math.abs(mid));
    return [x + nx * mid, z + nz * mid];
  });
  return { out, moved };
}

/** Moving average round the loop. */
function smooth(points, reach) {
  const n = points.length;
  return points.map((_, k) => {
    let sx = 0;
    let sz = 0;
    for (let d = -reach; d <= reach; d++) {
      const [x, z] = points[(k + d + n) % n];
      sx += x;
      sz += z;
    }
    return [sx / (2 * reach + 1), sz / (2 * reach + 1)];
  });
}

let lap = resample(ROUGH, STEP);
for (let pass = 0; pass < 3; pass++) {
  const { out, moved } = centre(lap);
  lap = resample(smooth(out, 2), STEP);
  console.log(`pass ${pass + 1}: largest pull to the road's middle ${moved.toFixed(1)} m`);
}
lap = resample(smooth(lap, 3), STEP);

// How much of the lap is on the street, as a check.
const on = lap.filter(([x, z]) => isStreet(x, z)).length;
let length = 0;
for (let k = 0; k < lap.length; k++) {
  const [ax, az] = lap[k];
  const [bx, bz] = lap[(k + 1) % lap.length];
  length += Math.hypot(bx - ax, bz - az);
}
writeFileSync(OUT, `${JSON.stringify(lap.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]))}\n`);
console.log(`${OUT}: ${lap.length} points, ${(length / 1000).toFixed(2)} km, ${((on / lap.length) * 100).toFixed(1)}% on the street`);
