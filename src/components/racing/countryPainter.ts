import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import {
  ANCHOR, BEACH, BOUNDS, BRIDGE, MINE, POULTRY, ROAD_BRIDGES, CAMPSITE, CASTLE_HILL, CHAPEL, CHURCH, COTTAGES, FORT_CARPARK, GREEN,
  HAMLET, HARBOUR, HILL_FARM, HOME_FARM, INN, JUNCTIONS, LAKE, LAKE_OUTLINE, LANES, LANE_WIDTH,
  LIGHTHOUSE, MINI_ROADS, ORCHARD, PADDOCK, PONDS, RAIL, RAIL_FLAT, RAIL_MARKS, SHAPE, STONE_CIRCLE,
  STREAM, SUMMIT, TURBINES, VIEWPOINT, VINEYARD, WATERMILL, armDirection, coastPoint, coastRadius,
  inIsland, lakeRadius, makeRandom, reliefAt, toLocal,
} from '@/config/countryConfig';
import {
  FIELDS, HEDGES, ROADSIDE, TRACKS, WOOD_OUTLINE, type Crop, type Field, type Pt,
} from '@/config/countryFields';

/**
 * The ground, painted.
 *
 * The other islands are one colour: a runway island is grass with things on
 * it. Farmland IS its ground — what makes a countryside read from a hilltop or
 * an aircraft is the patchwork, and a patchwork is a texture. So the whole
 * island's surface is drawn once into a canvas, in metres, and laid over the
 * terrain as its colour map: every field in its crop, the rows a field is
 * drilled in, the tramlines a sprayer leaves, the darker margin inside every
 * hedge, the verges, the tracks, the yards, the mown stripes on the green.
 *
 * ## Resolution
 *
 * 3.2 texels a metre — a 3072 × 2432 canvas over a 960 × 760 m box. Enough
 * that a 1 m drill row is three texels and a tramline is a line rather than a
 * smudge; small enough to upload in a few tens of milliseconds. From the car
 * the texel is 31 cm, which is soft but the vertex-colour shading on the mesh
 * carries the large-scale variation and the 3D hedges carry the edges, so
 * what the texture has to do is colour rather than detail.
 *
 * ## In metres
 *
 * One `setTransform` maps island metres onto the canvas, so every call below
 * draws in the frame everything else on the island is built in: a lane's own
 * samples, a field's own polygon, a cottage's own footprint. Canvas `y` is
 * island `z`, and the texture is laid with `v = 1 − (z − z0)/depth` so that
 * row 0 of the canvas is the island's northern edge.
 */

/** Texels per metre. 2.6 over the 1,220 × 1,000 m box the lobe needs: 3172 × 2600. */
export const PAINT_SCALE = 3.2;
export const PAINT_WIDTH = Math.round((BOUNDS.x1 - BOUNDS.x0) * PAINT_SCALE);
export const PAINT_HEIGHT = Math.round((BOUNDS.z1 - BOUNDS.z0) * PAINT_SCALE);

/** Texture coordinates for an island point, matching the transform below. */
export const paintUV = (x: number, z: number): [number, number] => [
  (x - BOUNDS.x0) / (BOUNDS.x1 - BOUNDS.x0),
  1 - (z - BOUNDS.z0) / (BOUNDS.z1 - BOUNDS.z0),
];

type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;

/** The palette: sRGB, as a farmer would name them. */
const TONE = {
  grass: '#587c36',
  pasture: '#5a8038',
  meadow: '#7a9440',
  wheat: '#c9a44c',
  wheatRow: '#b08e3c',
  barley: '#bfa65c',
  barleyRow: '#a48e48',
  rape: '#d8c22a',
  rapeDark: '#b7a626',
  maize: '#4c7a2c',
  maizeRow: '#3c6423',
  plough: '#6a4a30',
  ploughRow: '#54391f',
  stubble: '#c6b47a',
  stubbleRow: '#b09f66',
  roots: '#4f7d38',
  rootsRow: '#3f6a2c',
  wildflower: '#6f9042',
  downs: '#8ea356',
  rough: '#5f7a35',
  marsh: '#5b6e33',
  woodFloor: '#3d4a28',
  margin: '#476a2c',
  hedgeLine: '#2f4a22',
  wallLine: '#77726a',
  tramline: '#7f7040',
  verge: '#6a8c3c',
  tarmac: '#474745',
  track: '#a49a80',
  trackGrass: '#6e8c3e',
  gravel: '#a39a86',
  concrete: '#8f8c84',
  mud: '#725e3f',
  path: '#b7ab8b',
  gorse: '#d9c62e',
  rock: '#8c8a84',
  bay: '#e6e2d6',
  mown: '#77a04a',
  mownDark: '#6f9845',
  square: '#93b25c',
  garden: '#6f9a44',
  straw: '#c5aa60',
  miniTarmac: '#4e4e4c',
  gravelRoad: '#a0977f',
  rut: '#8a8068',
  water: '#4a6a72',
  sand: '#d8c9a0',
  wetSand: '#bfae86',
  setts: '#77726a',
  settsDark: '#5c5850',
  chalk: '#cdc7ab',
  vineEarth: '#7d7a58',
  vine: '#3f6a2c',
  scramble: '#6b5230',
} as const;

function polygon(ctx: Ctx, pts: ReadonlyArray<readonly [number, number]>) {
  ctx.beginPath();
  pts.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
  ctx.closePath();
}

function polyline(ctx: Ctx, pts: ReadonlyArray<readonly [number, number]>) {
  ctx.beginPath();
  pts.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
}

function disc(ctx: Ctx, x: number, z: number, r: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, z, r, 0, TAU);
  ctx.fill();
}

/** A turned rectangle, centred. */
function rect(ctx: Ctx, x: number, z: number, w: number, d: number, turn: number, colour: string) {
  ctx.save();
  ctx.translate(x, z);
  ctx.rotate(-turn);
  ctx.fillStyle = colour;
  ctx.fillRect(-w / 2, -d / 2, w, d);
  ctx.restore();
}

/** Soft blotches of a colour over an area, for ground that is not one flat tone. */
function mottle(
  ctx: Ctx, rnd: () => number, count: number, colour: string, alpha: number,
  radius: [number, number], within: () => Pt | null,
) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  for (let i = 0; i < count; i++) {
    const p = within();
    if (!p) continue;
    const r = radius[0] + rnd() * (radius[1] - radius[0]);
    ctx.beginPath();
    ctx.ellipse(p[0], p[1], r, r * (0.6 + rnd() * 0.5), rnd() * Math.PI, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function bbox(pts: ReadonlyArray<Pt>) {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { x0, z0, x1, z1 };
}

/**
 * Parallel lines across a polygon, along `angle`, `pitch` apart — the rows a
 * field is drilled or ploughed in. Clipped to the field, and every `tramEvery`
 * metres a darker pair where the sprayer runs.
 */
function rows(
  ctx: Ctx, field: Field, pitch: number, colour: string, width: number,
  tram: { every: number; colour: string } | null,
) {
  const { x0, z0, x1, z1 } = bbox(field.polygon);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const span = Math.hypot(x1 - x0, z1 - z0);
  const a = field.rowAngle;
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  // Across the rows.
  const px = -dz;
  const pz = dx;
  ctx.save();
  polygon(ctx, field.polygon);
  ctx.clip();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  const n = Math.ceil(span / pitch);
  for (let i = -n; i <= n; i++) {
    const ox = cx + px * i * pitch;
    const oz = cz + pz * i * pitch;
    ctx.moveTo(ox - dx * span, oz - dz * span);
    ctx.lineTo(ox + dx * span, oz + dz * span);
  }
  ctx.stroke();
  if (tram) {
    ctx.strokeStyle = tram.colour;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    const m = Math.ceil(span / tram.every);
    for (let i = -m; i <= m; i++) {
      for (const k of [-0.9, 0.9]) {
        const ox = cx + px * (i * tram.every + k);
        const oz = cz + pz * (i * tram.every + k);
        ctx.moveTo(ox - dx * span, oz - dz * span);
        ctx.lineTo(ox + dx * span, oz + dz * span);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** A random point inside a polygon, by rejection against its box. */
function insidePolygon(rnd: () => number, poly: ReadonlyArray<Pt>): () => Pt | null {
  const { x0, z0, x1, z1 } = bbox(poly);
  const inside = (x: number, z: number) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i];
      const [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  return () => {
    for (let t = 0; t < 8; t++) {
      const x = x0 + rnd() * (x1 - x0);
      const z = z0 + rnd() * (z1 - z0);
      if (inside(x, z)) return [x, z];
    }
    return null;
  };
}

function paintField(ctx: Ctx, rnd: () => number, field: Field) {
  const crop: Crop = field.crop;
  const fill = (colour: string) => {
    polygon(ctx, field.polygon);
    ctx.fillStyle = colour;
    ctx.fill();
  };
  const within = insidePolygon(rnd, field.polygon);
  const speckle = (count: number, colours: string[], r: number) => {
    ctx.save();
    polygon(ctx, field.polygon);
    ctx.clip();
    for (let i = 0; i < count; i++) {
      const p = within();
      if (!p) continue;
      disc(ctx, p[0], p[1], r * (0.6 + rnd() * 0.8), colours[Math.floor(rnd() * colours.length)]);
    }
    ctx.restore();
  };
  switch (crop) {
    case 'pasture':
      fill(TONE.pasture);
      mottle(ctx, rnd, 40, '#4f7530', 0.5, [4, 14], within);
      mottle(ctx, rnd, 25, '#6c9040', 0.45, [3, 10], within);
      break;
    case 'meadow':
      fill(TONE.meadow);
      mottle(ctx, rnd, 30, '#8ba04a', 0.5, [4, 12], within);
      mottle(ctx, rnd, 20, '#6a8a3a', 0.4, [4, 12], within);
      break;
    case 'wheat':
      fill(TONE.wheat);
      rows(ctx, field, 1.0, TONE.wheatRow, 0.35, { every: 24, colour: TONE.tramline });
      break;
    case 'barley':
      fill(TONE.barley);
      rows(ctx, field, 1.0, TONE.barleyRow, 0.35, { every: 24, colour: TONE.tramline });
      break;
    case 'rape':
      fill(TONE.rape);
      mottle(ctx, rnd, 40, TONE.rapeDark, 0.5, [3, 9], within);
      rows(ctx, field, 1.2, TONE.rapeDark, 0.25, { every: 24, colour: '#8f8a3a' });
      break;
    case 'maize':
      fill(TONE.maize);
      rows(ctx, field, 0.8, TONE.maizeRow, 0.35, null);
      break;
    case 'plough':
      fill(TONE.plough);
      rows(ctx, field, 0.7, TONE.ploughRow, 0.3, null);
      break;
    case 'stubble':
      fill(TONE.stubble);
      rows(ctx, field, 1.0, TONE.stubbleRow, 0.3, { every: 24, colour: '#9a8a58' });
      break;
    case 'roots':
      fill(TONE.roots);
      rows(ctx, field, 0.9, TONE.rootsRow, 0.4, null);
      break;
    case 'wildflower':
      fill(TONE.wildflower);
      mottle(ctx, rnd, 30, '#86a24c', 0.5, [3, 9], within);
      speckle(900, ['#d63b3b', '#f2f0e6', '#f0d040', '#c86bb0'], 0.32);
      break;
    case 'downs':
      fill(TONE.downs);
      mottle(ctx, rnd, 50, '#a3b463', 0.45, [4, 16], within);
      mottle(ctx, rnd, 30, '#7e9648', 0.4, [4, 12], within);
      break;
    case 'rough':
      fill(TONE.rough);
      mottle(ctx, rnd, 40, '#4e6a2c', 0.5, [3, 12], within);
      speckle(80, [TONE.gorse], 1.1);
      break;
    case 'water':
      fill(TONE.marsh);
      mottle(ctx, rnd, 30, '#4d6230', 0.5, [3, 10], within);
      break;
    case 'wood':
      fill(TONE.rough);
      break;
  }
  // The margin: a strip inside the boundary that the drill does not reach.
  if (crop !== 'downs' && crop !== 'rough' && crop !== 'wood' && crop !== 'water') {
    ctx.save();
    polygon(ctx, field.polygon);
    ctx.clip();
    ctx.strokeStyle = crop === 'pasture' || crop === 'meadow' || crop === 'wildflower'
      ? TONE.margin : '#6f8a3e';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.8;
    polygon(ctx, field.polygon);
    ctx.stroke();
    ctx.restore();
  }
}

/** The hedges' shadow lines on the ground, so a boundary reads from the air. */
function paintHedgeLines(ctx: Ctx) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Walls only. The hedges' own line went with the hedges — it was their
  // shadow on the ground, and a shadow under nothing is a green stripe
  // across a field.
  for (const set of [HEDGES, ROADSIDE]) {
    for (const run of set) {
      if (run.kind !== 'wall') continue;
      ctx.strokeStyle = TONE.wallLine;
      ctx.lineWidth = 0.9;
      polyline(ctx, run.pts);
      ctx.stroke();
    }
  }
}

function paintLanes(ctx: Ctx) {
  // Butt ends, not round: a round cap painted a half-width disc of tarmac
  // past a lane's end, which on the quay was a grey blob beyond the road.
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  const paths = LANES.map((r) => r.samples.map((s) => [s.x, s.z] as Pt));
  // Mown verge either side, then the tarmac the loft sits over.
  for (const [colour, width] of [
    [TONE.verge, LANE_WIDTH + 7.5], [TONE.tarmac, LANE_WIDTH - 0.6],
  ] as const) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    for (const path of paths) {
      polyline(ctx, path);
      ctx.stroke();
    }
  }
  for (const j of Object.values(JUNCTIONS)) {
    rect(ctx, j.x, j.z, LANE_WIDTH + 7, LANE_WIDTH + 7, j.turn, TONE.verge);
    rect(ctx, j.x, j.z, LANE_WIDTH - 0.6, LANE_WIDTH - 0.6, j.turn, TONE.tarmac);
  }
  // The decks' island ends, where a bridge becomes a lane.
  for (const B of ROAD_BRIDGES) {
    const onIsland = B === BRIDGE ? B.end : B.start;
    const dir = B === BRIDGE ? B.dir : [-B.dir[0], -B.dir[1]];
    const [ex, ez] = toLocal(onIsland[0], onIsland[1]);
    ctx.strokeStyle = TONE.verge;
    ctx.lineWidth = LANE_WIDTH + 7.5;
    ctx.beginPath();
    ctx.moveTo(ex - dir[0] * 30, ez - dir[1] * 30);
    ctx.lineTo(ex + dir[0] * 4, ez + dir[1] * 4);
    ctx.stroke();
  }
  // The single-tracks: a narrow verge and the surface, tarmac or gravel with
  // its ruts. Under the lofts, like the lanes; what shows is the verge.
  for (const road of MINI_ROADS) {
    const path = road.samples.map((sm) => [sm.x, sm.z] as Pt);
    ctx.lineCap = road.closed ? 'butt' : 'round';
    ctx.strokeStyle = TONE.verge;
    ctx.lineWidth = road.width + 2.6;
    polyline(ctx, path);
    ctx.stroke();
    ctx.strokeStyle = road.surface === 'gravel' ? TONE.gravelRoad : TONE.miniTarmac;
    ctx.lineWidth = road.width - 0.3;
    polyline(ctx, path);
    ctx.stroke();
  }
}

/** The brook: mud banks and the water line, under the swept water. */
function paintStream(ctx: Ctx) {
  const path = STREAM.map((sm) => [sm.x, sm.z] as Pt);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = TONE.mud;
  ctx.lineWidth = 5.6;
  polyline(ctx, path);
  ctx.stroke();
  ctx.strokeStyle = TONE.water;
  ctx.lineWidth = 2.8;
  polyline(ctx, path);
  ctx.stroke();
}

/** The strand: sand from the fields down to the water, wetter at the bottom. */
function paintBeach(ctx: Ctx, rnd: () => number) {
  const band = (inset: number): Pt[] => {
    const out: Pt[] = [];
    for (let k = 0; k <= 24; k++) {
      const t = BEACH.theta - BEACH.halfAngle - 0.05 + ((BEACH.halfAngle + 0.05) * 2 * k) / 24;
      out.push(coastPoint(t, inset));
    }
    return out;
  };
  const outer = band(-6);
  const inner = band(BEACH.strand + 4).reverse();
  polygon(ctx, [...outer, ...inner]);
  ctx.fillStyle = TONE.sand;
  ctx.fill();
  polygon(ctx, [...band(-6), ...band(16).reverse()]);
  ctx.fillStyle = TONE.wetSand;
  ctx.fill();
  ctx.save();
  polygon(ctx, [...outer, ...inner]);
  ctx.clip();
  for (let i = 0; i < 260; i++) {
    const t = BEACH.theta + (rnd() - 0.5) * BEACH.halfAngle * 2;
    const [x, z] = coastPoint(t, rnd() * BEACH.strand);
    disc(ctx, x, z, 0.25 + rnd() * 0.5, rnd() < 0.5 ? '#b3a385' : '#e6dcc0');
  }
  ctx.restore();
}

/** The harbour's quay in setts, the pier's root, the fort's chalk ramparts, and the rest of the lobe's ground. */
function paintLobe(ctx: Ctx, rnd: () => number) {
  // The quay: a rectangular apron of granite flags along the front, laid in
  // courses, with grass behind it — not a disc of grey.
  {
    const along: [number, number] = [-HARBOUR.out[1], HARBOUR.out[0]];
    const turn = Math.atan2(along[1], along[0]);
    const cx = HARBOUR.x + HARBOUR.out[0] * 24;
    const cz = HARBOUR.z + HARBOUR.out[1] * 24;
    rect(ctx, cx, cz, 96, 44, -turn, TONE.setts);
    ctx.save();
    ctx.translate(cx, cz);
    ctx.rotate(turn);
    for (let v = -22; v < 22; v += 0.7) {
      for (let u = -48 + ((Math.round(v / 0.7) % 2) * 0.6); u < 48; u += 1.2) {
        const tone = 120 + Math.floor((rnd() - 0.5) * 34);
        ctx.fillStyle = `rgb(${tone + 4},${tone + 2},${tone - 4})`;
        ctx.fillRect(u + 0.05, v + 0.05, 1.1, 0.6);
      }
    }
    ctx.restore();
  }
  rect(ctx, ANCHOR.x, ANCHOR.z, ANCHOR.w + 10, ANCHOR.d + 8, ANCHOR.turn, TONE.gravel);
  // The campsite: mown, with the pitches worn.
  rect(ctx, CAMPSITE.x, CAMPSITE.z, CAMPSITE.w, CAMPSITE.d, CAMPSITE.turn, TONE.mown);
  mottle(ctx, rnd, 18, '#8a9a58', 0.5, [2, 4], () => {
    const c = Math.cos(CAMPSITE.turn);
    const sn = Math.sin(CAMPSITE.turn);
    const u = (rnd() - 0.5) * CAMPSITE.w * 0.85;
    const v = (rnd() - 0.5) * CAMPSITE.d * 0.85;
    return [CAMPSITE.x + u * c + v * sn, CAMPSITE.z - u * sn + v * c];
  });
  // The vineyard: bare earth between rows of vines along the long axis.
  rect(ctx, VINEYARD.x, VINEYARD.z, VINEYARD.w, VINEYARD.d, VINEYARD.turn, TONE.vineEarth);
  ctx.save();
  ctx.translate(VINEYARD.x, VINEYARD.z);
  ctx.rotate(-VINEYARD.turn);
  ctx.strokeStyle = TONE.vine;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < VINEYARD.rows; i++) {
    const v = -VINEYARD.d / 2 + ((i + 0.5) * VINEYARD.d) / VINEYARD.rows;
    ctx.moveTo(-VINEYARD.w / 2 + 2, v);
    ctx.lineTo(VINEYARD.w / 2 - 2, v);
  }
  ctx.stroke();
  ctx.restore();
  // The fort: chalk showing on the bank tops, and the gap at the gate.
  ctx.strokeStyle = TONE.chalk;
  ctx.lineWidth = 3.2;
  ctx.globalAlpha = 0.75;
  for (const ring of CASTLE_HILL.ramparts) {
    ctx.beginPath();
    ctx.arc(CASTLE_HILL.x, CASTLE_HILL.z, ring.r, CASTLE_HILL.gate + 0.16, CASTLE_HILL.gate - 0.16 + TAU);
    ctx.stroke();
    ctx.strokeStyle = '#5f7a38';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(CASTLE_HILL.x, CASTLE_HILL.z, ring.r + 9, CASTLE_HILL.gate + 0.16, CASTLE_HILL.gate - 0.16 + TAU);
    ctx.stroke();
    ctx.strokeStyle = TONE.chalk;
    ctx.lineWidth = 3.2;
  }
  ctx.globalAlpha = 1;
  disc(ctx, FORT_CARPARK.x, FORT_CARPARK.z, FORT_CARPARK.r, TONE.gravel);
  disc(ctx, SUMMIT.x, SUMMIT.z, SUMMIT.r, TONE.gravel);
  // The scramble course's mud, wider than the track, churned.
  const loop = MINI_ROADS.find((r) => r.name === 'scrambleLoop');
  if (loop) {
    ctx.strokeStyle = TONE.scramble;
    ctx.lineWidth = loop.width + 4;
    ctx.lineJoin = 'round';
    polygon(ctx, loop.samples.map((sm) => [sm.x, sm.z] as Pt));
    ctx.stroke();
  }
  disc(ctx, CHAPEL.x, CHAPEL.z, 16, '#5c7a3a');
  disc(ctx, WATERMILL.x, WATERMILL.z, 9, TONE.gravel);
  disc(ctx, STONE_CIRCLE.x, STONE_CIRCLE.z, STONE_CIRCLE.r + 4, '#8aa056');
}

/** The formation: bare ground under the ballast, and a cess either side. */
function paintRailway(ctx: Ctx) {
  const path = RAIL
    .filter((sm) => sm.arc >= RAIL_MARKS.westDeckEnd - 30 && sm.arc <= RAIL_MARKS.eastDeckStart + 30)
    .map((sm) => [sm.x, sm.z] as Pt);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  for (const [colour, width] of [['#6f7358', RAIL_FLAT * 2 + 1], ['#7d7a70', RAIL_FLAT * 2 - 3]] as const) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    polyline(ctx, path);
    ctx.stroke();
  }
}

/**
 * Grain over everything green: tens of thousands of grass-blade specks in
 * a lighter and a darker green, and the odd tuft, so the ground has texture
 * at a walker's scale and not only at a field's. Drawn in island metres over
 * the whole box; the water and roads are painted after it and cover it.
 */
function paintGrain(ctx: Ctx) {
  const rnd = makeRandom(41);
  const w = BOUNDS.x1 - BOUNDS.x0;
  const h = BOUNDS.z1 - BOUNDS.z0;
  for (let i = 0; i < 260000; i++) {
    const x = BOUNDS.x0 + rnd() * w;
    const z = BOUNDS.z0 + rnd() * h;
    if (!inIsland(x, z)) continue;
    const dark = rnd() < 0.5;
    ctx.fillStyle = dark ? 'rgba(52,84,34,0.35)' : 'rgba(132,166,84,0.30)';
    ctx.fillRect(x, z, 0.3 + rnd() * 0.5, 0.3 + rnd() * 0.9);
  }
  for (let i = 0; i < 9000; i++) {
    const x = BOUNDS.x0 + rnd() * w;
    const z = BOUNDS.z0 + rnd() * h;
    if (!inIsland(x, z)) continue;
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(150,170,80,0.28)' : 'rgba(80,110,50,0.3)';
    ctx.beginPath();
    ctx.ellipse(x, z, 0.8 + rnd() * 1.4, 0.5 + rnd() * 0.9, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintTracks(ctx: Ctx) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [colour, width] of [[TONE.track, 3.4], [TONE.trackGrass, 0.8]] as const) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    for (const t of TRACKS) {
      polyline(ctx, t.pts);
      ctx.stroke();
    }
  }
}

function paintCoast(ctx: Ctx, rnd: () => number) {
  // The rough band outside the fields, with gorse and outcrops in it, and
  // the cliff path round the whole island a little inside the edge.
  const band = (fraction: number): Pt[] => Array.from({ length: SHAPE.steps }, (_, i) => {
    const t = (i / SHAPE.steps) * TAU;
    const r = coastRadius(t) * fraction;
    return [r * Math.cos(t), r * Math.sin(t)];
  });
  ctx.save();
  polygon(ctx, band(1.0));
  polygon(ctx, band(0.925));
  ctx.clip('evenodd');
  ctx.fillStyle = TONE.rough;
  ctx.fillRect(BOUNDS.x0, BOUNDS.z0, BOUNDS.x1 - BOUNDS.x0, BOUNDS.z1 - BOUNDS.z0);
  const within = (): Pt => {
    const t = rnd() * TAU;
    const r = coastRadius(t) * (0.93 + rnd() * 0.065);
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  mottle(ctx, rnd, 220, '#4d6a2c', 0.5, [3, 9], within);
  mottle(ctx, rnd, 160, TONE.gorse, 0.85, [0.8, 2.2], within);
  mottle(ctx, rnd, 120, TONE.rock, 0.8, [0.6, 1.8], within);
  ctx.restore();
  ctx.strokeStyle = TONE.path;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  polygon(ctx, band(0.955));
  ctx.stroke();
}

function paintWater(ctx: Ctx, rnd: () => number) {
  // The marsh, the mud at the edge, and the bed.
  const ring = (f: number): Pt[] => Array.from({ length: 96 }, (_, i) => {
    const t = (i / 96) * TAU;
    const r = lakeRadius(t) * f;
    return [LAKE.x + r * Math.cos(t), LAKE.z + r * Math.sin(t)];
  });
  ctx.lineJoin = 'round';
  ctx.strokeStyle = TONE.marsh;
  ctx.lineWidth = 12;
  polygon(ctx, ring(1.1));
  ctx.stroke();
  ctx.strokeStyle = TONE.mud;
  ctx.lineWidth = 3.5;
  polygon(ctx, ring(1.0));
  ctx.stroke();
  polygon(ctx, LAKE_OUTLINE);
  ctx.fillStyle = '#4a5a3c';
  ctx.fill();
  mottle(ctx, rnd, 40, '#3e4d34', 0.5, [4, 12], () => {
    const t = rnd() * TAU;
    const r = lakeRadius(t) * rnd() * 0.9;
    return [LAKE.x + r * Math.cos(t), LAKE.z + r * Math.sin(t)];
  });
  for (const pond of PONDS) {
    disc(ctx, pond.x, pond.z, pond.r + 2.2, TONE.mud);
    disc(ctx, pond.x, pond.z, pond.r, '#4a5a3c');
  }
}

function paintHamlet(ctx: Ctx, rnd: () => number) {
  // The green: mown in stripes along the crossroads' own grain.
  const j = JUNCTIONS.cross;
  // Mown ground is the green itself and the cricket outfield, not the whole
  // graded pad: the first cut striped a 110 m disc and it read as a golf
  // course from the air.
  const [cx, cz] = GREEN.cricket;
  for (const [mx, mz, mr] of [[HAMLET.x, HAMLET.z, 62], [cx, cz, 46]] as const) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, mz, mr, 0, TAU);
    ctx.clip();
    ctx.fillStyle = TONE.mown;
    ctx.fillRect(mx - mr, mz - mr, mr * 2, mr * 2);
    ctx.translate(j.x, j.z);
    ctx.rotate(-j.turn);
    ctx.fillStyle = TONE.mownDark;
    for (let u = -HAMLET.r - 60; u < HAMLET.r + 60; u += 8) {
      ctx.fillRect(u, -HAMLET.r - 60, 4, (HAMLET.r + 60) * 2);
    }
    ctx.restore();
  }
  // The cricket ground: a rope round the outfield, the square in the middle.
  ctx.strokeStyle = TONE.bay;
  ctx.lineWidth = 0.25;
  ctx.beginPath();
  ctx.arc(cx, cz, 40, 0, TAU);
  ctx.stroke();
  rect(ctx, cx, cz, 26, 22, j.turn, TONE.square);
  rect(ctx, cx, cz, 3.2, 20.2, j.turn, '#b9c98a');
  // Gardens: a lawn behind each house and a path to its door.
  for (const c of COTTAGES) {
    const s = Math.sin(c.turn);
    const co = Math.cos(c.turn);
    rect(ctx, c.x - s * (c.d / 2 + 7), c.z - co * (c.d / 2 + 7), c.w + 8, 14, c.turn, TONE.garden);
    rect(ctx, c.x + s * (c.d / 2 + 3), c.z + co * (c.d / 2 + 3), c.w + 6, 6, c.turn, TONE.garden);
    rect(ctx, c.x + s * (c.d / 2 + 5), c.z + co * (c.d / 2 + 5), 1.2, 10, c.turn, TONE.path);
  }
  rect(ctx, INN.x, INN.z, INN.w + 12, INN.d + 10, INN.turn, TONE.gravel);
  // The churchyard, with the path up to the porch.
  disc(ctx, CHURCH.x, CHURCH.z, CHURCH.yard, '#587c38');
  mottle(ctx, rnd, 16, '#4f7030', 0.5, [3, 7], () => {
    const t = rnd() * TAU;
    const r = rnd() * CHURCH.yard;
    return [CHURCH.x + r * Math.cos(t), CHURCH.z + r * Math.sin(t)];
  });
  ctx.strokeStyle = TONE.path;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(CHURCH.x - Math.sin(CHURCH.turn) * CHURCH.yard, CHURCH.z - Math.cos(CHURCH.turn) * CHURCH.yard);
  ctx.lineTo(CHURCH.x - Math.sin(CHURCH.turn) * 6, CHURCH.z - Math.cos(CHURCH.turn) * 6);
  ctx.stroke();
  // The paddock. Horses do not graze a field evenly: they crop the middle
  // bare and leave rough tussocks where they dung, and they walk the fence
  // line until it is mud. So it is grazed turf, a worn track all the way
  // round just inside the rails, a bald patch at the gate and by the
  // trough, and rough clumps through the middle.
  {
    const P = PADDOCK;
    const c = Math.cos(P.turn);
    const sn = Math.sin(P.turn);
    const at = (u: number, v: number): Pt => [P.x + u * c + v * sn, P.z - u * sn + v * c];
    rect(ctx, P.x, P.z, P.w, P.d, P.turn, '#86a052');
    // Cropped close over most of it, with the sward broken up.
    mottle(ctx, rnd, 36, '#7a9448', 0.55, [3, 9], () => at(
      (rnd() - 0.5) * P.w * 0.92, (rnd() - 0.5) * P.d * 0.92,
    ));
    mottle(ctx, rnd, 20, '#93a85e', 0.45, [2, 7], () => at(
      (rnd() - 0.5) * P.w * 0.92, (rnd() - 0.5) * P.d * 0.92,
    ));
    // The track round the rails: a worn ring two metres inside them.
    ctx.save();
    ctx.translate(P.x, P.z);
    ctx.rotate(-P.turn);
    ctx.strokeStyle = '#9c8a60';
    ctx.lineWidth = 2.6;
    ctx.globalAlpha = 0.75;
    ctx.lineJoin = 'round';
    ctx.strokeRect(-P.w / 2 + 2.4, -P.d / 2 + 2.4, P.w - 4.8, P.d - 4.8);
    ctx.globalAlpha = 1;
    ctx.restore();
    // Rough tussocks the horses leave standing.
    mottle(ctx, rnd, 22, '#6d8a3c', 0.5, [1.5, 4], () => at(
      (rnd() - 0.5) * P.w * 0.8, (rnd() - 0.5) * P.d * 0.8,
    ));
    // Poached bare ground at the gate and round the water trough.
    disc(ctx, ...at(0, -P.d / 2 + 3), 4.5, '#8d7a52');
    disc(ctx, ...at(P.w / 2 - 6, P.d / 2 - 6), 3.2, '#8d7a52');
    mottle(ctx, rnd, 12, '#7a6842', 0.6, [1, 3], () => at(
      (rnd() - 0.5) * 9, -P.d / 2 + 3 + (rnd() - 0.5) * 7,
    ));
  }
}

/**
 * The poultry run: grass a flock has been on, which is not grass for long.
 * Scratched bare in bands by the sheds and round the arks, thin and yellowed
 * between, and a hard standing in front of the shed doors.
 */
function paintPoultry(ctx: Ctx, rnd: () => number) {
  const P = POULTRY;
  const c = Math.cos(P.turn);
  const sn = Math.sin(P.turn);
  const at = (u: number, v: number): Pt => [P.x + u * c + v * sn, P.z - u * sn + v * c];
  rect(ctx, P.x, P.z, P.w, P.d, P.turn, '#9a9a62');
  mottle(ctx, rnd, 30, '#8a8352', 0.55, [2, 7], () => at(
    (rnd() - 0.5) * P.w * 0.92, (rnd() - 0.5) * P.d * 0.92,
  ));
  // Scratched right out along the shed fronts, where they crowd.
  ctx.save();
  ctx.translate(P.x, P.z);
  ctx.rotate(-P.turn);
  ctx.fillStyle = '#8d7a52';
  ctx.fillRect(-P.w / 2 + 3, -P.d / 2 + 7, P.w - 6, 6);
  ctx.fillStyle = TONE.concrete;
  ctx.fillRect(-P.w / 2 + 5.5, -P.d / 2 + 9, 30, 5);
  ctx.restore();
  // Bare patches under the arks and round the feeders.
  for (const [ax, az] of [[-14, 6], [-5, 8], [2, 5], [12, 7], [-9, 10.5], [7, 10], [-7, 4], [1, 8], [9, 3]] as const) {
    disc(ctx, ...at(ax, az), 2.1 + rnd() * 1.1, '#8d7a52');
  }
  mottle(ctx, rnd, 26, '#7d6d48', 0.5, [1, 3], () => at(
    (rnd() - 0.5) * P.w * 0.86, (rnd() - 0.5) * P.d * 0.86,
  ));
}

/**
 * The quarry: crushed stone and rock, not a field.
 *
 * Pale broken rock over the pit and its yard, scuffed grey where the plant
 * stands and the lorries turn, the benches picked out by a paler line along
 * each rim so the steps read from the air, and the tip a raw grey-brown cone
 * with runnels down it.
 */
function paintMine(ctx: Ctx, rnd: () => number) {
  const P = MINE.pit;
  const T = MINE.terrace;
  const S = MINE.spoil;
  const L = MINE.lagoon;
  // The works terrace: hard standing, darker where the lorries run.
  rect(ctx, T.x, T.z, T.w, T.d, 0, '#8f897c');
  mottle(ctx, rnd, 90, '#837c6f', 0.5, [2, 9], () => [
    T.x + (rnd() - 0.5) * T.w, T.z + (rnd() - 0.5) * T.d,
  ]);
  // The internal roads: the works road from the gate west through the plant,
  // and the haul road north from it across the rail loop into the pit.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#726b5f';
  ctx.lineWidth = 10;
  polyline(ctx, [[MINE.gate.x + 6, MINE.gate.z], [-446, MINE.gate.z]]);
  ctx.stroke();
  polyline(ctx, [[-370, MINE.gate.z], [-370, 84], [-378, 100]]);
  ctx.stroke();
  // The pit: pale broken rock inside the rim, a line along every bench edge.
  disc(ctx, P.x, P.z, P.rim, '#a39a88');
  mottle(ctx, rnd, 110, '#b0a894', 0.5, [2, 7], () => {
    const t = rnd() * TAU;
    const r = rnd() * P.rim;
    return [P.x + r * Math.cos(t), P.z + r * Math.sin(t)];
  });
  mottle(ctx, rnd, 70, '#8e8676', 0.45, [1.5, 5], () => {
    const t = rnd() * TAU;
    const r = rnd() * P.rim;
    return [P.x + r * Math.cos(t), P.z + r * Math.sin(t)];
  });
  for (let k = 1; k <= P.benches; k++) {
    const r = P.floor + ((P.rim - P.floor) * k) / P.benches;
    ctx.strokeStyle = '#b8b0a0';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(P.x, P.z, r, 0, TAU);
    ctx.stroke();
  }
  // The floor, worked over, and the bench road up the east face.
  disc(ctx, P.x, P.z, P.floor + 7, '#8a8272');
  ctx.strokeStyle = '#968e80';
  ctx.lineWidth = 10;
  polyline(ctx, MINE.bench.path);
  ctx.stroke();
  // Where the stone is stacked: pale rings under the stockpiles.
  for (const [x, z, r] of [[-404, -22, 11], [-382, -22, 9], [-424, -22, 9]]) disc(ctx, x, z, r, '#a8a08f');
  // The lagoon.
  disc(ctx, L.x, L.z, L.r, '#55625f');
  // The tip: raw waste, with runnels off it.
  disc(ctx, S.x, S.z, S.r, '#8b8172');
  mottle(ctx, rnd, 50, '#7a7162', 0.5, [2, 7], () => {
    const t = rnd() * TAU;
    const r = rnd() * S.r;
    return [S.x + r * Math.cos(t), S.z + r * Math.sin(t)];
  });
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = '#6f6759';
  for (let i = 0; i < 14; i++) {
    const t = rnd() * TAU;
    ctx.beginPath();
    ctx.moveTo(S.x + S.r * 0.25 * Math.cos(t), S.z + S.r * 0.25 * Math.sin(t));
    ctx.lineTo(S.x + S.r * 1.02 * Math.cos(t), S.z + S.r * 1.02 * Math.sin(t));
    ctx.stroke();
  }
}

function paintYards(ctx: Ctx, rnd: () => number) {
  // Home Farm: concrete in the yard, straw and muck where the cattle are.
  const H = HOME_FARM;
  rect(ctx, H.x, H.z, 58, 44, H.turn, TONE.concrete);
  mottle(ctx, rnd, 30, '#7d7a72', 0.5, [2, 7], () => [
    H.x + (rnd() - 0.5) * 50, H.z + (rnd() - 0.5) * 36,
  ]);
  mottle(ctx, rnd, 14, TONE.straw, 0.6, [1.5, 4], () => [
    H.x + (rnd() - 0.5) * 50, H.z + (rnd() - 0.5) * 36,
  ]);
  const c = Math.cos(H.turn);
  const s = Math.sin(H.turn);
  disc(ctx, H.x + 24 * c + 2 * s, H.z - 24 * s + 2 * c, 6, '#5a4028');
  // The orchard: mown between the rows.
  rect(ctx, ORCHARD.x, ORCHARD.z, ORCHARD.w + 6, ORCHARD.d + 6, ORCHARD.turn, TONE.mown);
  // Hill Farm: gravel, and the sheep have the yard bare.
  rect(ctx, HILL_FARM.x, HILL_FARM.z, 40, 32, HILL_FARM.turn, TONE.gravel);
  mottle(ctx, rnd, 16, '#8f866f', 0.5, [2, 6], () => [
    HILL_FARM.x + (rnd() - 0.5) * 34, HILL_FARM.z + (rnd() - 0.5) * 26,
  ]);
  // The car park at the viewpoint, with its bays marked.
  disc(ctx, VIEWPOINT.x, VIEWPOINT.z, VIEWPOINT.r, TONE.tarmac);
  ctx.save();
  ctx.translate(VIEWPOINT.x, VIEWPOINT.z);
  ctx.rotate(-VIEWPOINT.turn);
  ctx.strokeStyle = TONE.bay;
  ctx.lineWidth = 0.15;
  ctx.beginPath();
  for (let i = -3; i <= 3; i++) {
    ctx.moveTo(i * 2.6, -12);
    ctx.lineTo(i * 2.6, -6.5);
  }
  ctx.stroke();
  ctx.restore();
  for (const t of TURBINES) disc(ctx, t.x, t.z, 7, TONE.gravel);
  disc(ctx, LIGHTHOUSE.x, LIGHTHOUSE.z, 9, TONE.concrete);
  // The bridge landing: the deck is the road here, and the ground under its
  // shoulders is verge.
  const [ex, ez] = toLocal(BRIDGE.end[0], BRIDGE.end[1]);
  ctx.strokeStyle = TONE.verge;
  ctx.lineWidth = LANE_WIDTH + 12;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(ex - BRIDGE.dir[0] * 34, ez - BRIDGE.dir[1] * 34);
  ctx.lineTo(ex, ez);
  ctx.stroke();
}

/** The whole island, painted, as a texture ready to lay on the crown. */
export function paintCountry(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PAINT_WIDTH;
  canvas.height = PAINT_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const rnd = makeRandom(11);
  ctx.setTransform(PAINT_SCALE, 0, 0, PAINT_SCALE, -BOUNDS.x0 * PAINT_SCALE, -BOUNDS.z0 * PAINT_SCALE);

  // The whole box in grass — the cliff face samples the edge of this, so it
  // is never a hard colour.
  ctx.fillStyle = TONE.grass;
  ctx.fillRect(BOUNDS.x0, BOUNDS.z0, BOUNDS.x1 - BOUNDS.x0, BOUNDS.z1 - BOUNDS.z0);
  const anywhere = (): Pt => {
    const t = rnd() * TAU;
    const r = coastRadius(t) * Math.sqrt(rnd());
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  mottle(ctx, rnd, 260, '#4a6c2e', 0.35, [10, 40], anywhere);
  mottle(ctx, rnd, 200, '#6a9040', 0.3, [8, 30], anywhere);

  for (const field of FIELDS) paintField(ctx, rnd, field);
  paintCoast(ctx, rnd);

  // Where the hills are chalk the grass thins: a wash over the tops.
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < 1400; i++) {
    const p = anywhere();
    const h = reliefAt(p[0], p[1]);
    if (h < 24) continue;
    const r = 3 + rnd() * 8;
    ctx.fillStyle = h > 36 ? '#b6c27a' : '#9fb264';
    ctx.beginPath();
    ctx.ellipse(p[0], p[1], r, r * 0.5, rnd() * Math.PI, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  polygon(ctx, WOOD_OUTLINE);
  ctx.fillStyle = TONE.woodFloor;
  ctx.fill();
  mottle(ctx, rnd, 60, '#33402a', 0.5, [4, 12], () => {
    const t = rnd() * TAU;
    const r = Math.sqrt(rnd());
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const u = 118 * r * Math.cos(t);
    const v = 86 * r * Math.sin(t);
    return [262 + u * c - v * s, -152 + u * s + v * c];
  });

  paintWater(ctx, rnd);
  paintBeach(ctx, rnd);
  paintHamlet(ctx, rnd);
  paintYards(ctx, rnd);
  paintPoultry(ctx, rnd);
  paintMine(ctx, rnd);
  paintLobe(ctx, rnd);
  paintTracks(ctx);
  paintGrain(ctx);
  paintHedgeLines(ctx);
  paintRailway(ctx);
  paintStream(ctx);
  paintLanes(ctx);
  // The lane-side verges over the hedge lines, so the shadow line stops at
  // the verge — the hedge itself stands in 3D from there.
  for (const j of Object.values(JUNCTIONS)) {
    for (const arm of ['px', 'nx', 'pz', 'nz'] as const) {
      const [dx, dz] = armDirection(j, arm);
      ctx.strokeStyle = TONE.tarmac;
      ctx.lineWidth = LANE_WIDTH - 0.6;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(j.x, j.z);
      ctx.lineTo(j.x + dx * (LANE_WIDTH / 2 + 1), j.z + dz * (LANE_WIDTH / 2 + 1));
      ctx.stroke();
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
