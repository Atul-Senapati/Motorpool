/**
 * Builds the Motorpool mark: an extruded, italic "M".
 *
 *   node scripts/make-logo.mjs        # or: npm run logo
 *
 * The mark is generated rather than drawn by hand because it is one solid
 * swept from one outline — the letter, the italic lean, the depth and the lit
 * edges all fall out of the same twelve points. Nudging the lean or the
 * extrusion by hand would mean re-deriving thirteen quads and the highlight
 * every time; here it is two constants.
 *
 * Emits:
 *   src/app/icon.svg                  favicon (Next's `icon` file convention)
 *   src/app/favicon.ico               32+48 px fallback for older browsers
 *   src/app/apple-icon.png            180 px home-screen icon
 *   src/app/opengraph-image.png       1200x630 link preview
 *   public/logo.svg                   bare mark, transparent
 *   src/components/racing/logoPaths.ts  the same geometry for <Logo>
 *
 * Nothing here runs at build time. The outputs are committed; this script is
 * how you change them.
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

/* ---------------------------------------------------------------- letterform */

/**
 * The M, upright, traced clockwise from the bottom-left.
 *
 * Blocky and closed rather than a stroked path, so the extrusion has a real
 * outline to sweep. The numbers are picked so the diagonals come out 49 units
 * thick against the 50-unit stems — a letter whose strokes visibly disagree
 * reads as a mistake at every size.
 */
const GLYPH = [
  [0, 200], [0, 0], [56, 0], [120, 86], [184, 0], [240, 0],
  [240, 200], [190, 200], [190, 74], [120, 168], [50, 74], [50, 200],
];
const HEIGHT = 200;

/** Italic lean, degrees. Matches the garage's italic display face. */
const LEAN = 12;
/** Extrusion, in glyph units: down and to the right, so the light is upper-left. */
const DEPTH = [18, 20];

/* -------------------------------------------------------------------- palette */

/**
 * One accent, three tones per surface — the same logic as the garage's raised
 * controls: lit on top, the accent in the middle, the dark stop on the extruded
 * edge below.
 */
const PALETTES = {
  /** Blue mark on the game's near-black. For the icon tile. */
  onDark: {
    faceHi: '#8fbcff', face: '#3d86ff', faceLo: '#1157ff',
    bodyHi: '#0e3ba6', bodyLo: '#061c56', edge: '#e6f0ff',
  },
  /** White mark, blue depth. For the garage header's blue plate. */
  onAccent: {
    faceHi: '#ffffff', face: '#ffffff', faceLo: '#dde8ff',
    bodyHi: '#0b3fc4', bodyLo: '#082a8c', edge: '#ffffff',
  },
  /** Blue mark on a light ground. For light UI and the bare logo file. */
  onLight: {
    faceHi: '#5f9bff', face: '#1157ff', faceLo: '#0b3fc4',
    bodyHi: '#0b3fc4', bodyLo: '#06216b', edge: '#d6e5ff',
  },
};

/* ------------------------------------------------------------------- geometry */

const TAN = Math.tan((LEAN * Math.PI) / 180);
/** Leans the glyph about its baseline, so the feet stay put and the top swings right. */
const lean = ([x, y]) => [x + (HEIGHT - y) * TAN, y];
const shift = ([x, y]) => [x + DEPTH[0], y + DEPTH[1]];

const FACE = GLYPH.map(lean);
const BACK = FACE.map(shift);

const signedArea = (poly) => poly.reduce((sum, [x, y], i) => {
  const [nx, ny] = poly[(i + 1) % poly.length];
  return sum + (x * ny - nx * y);
}, 0) / 2;

/** Winds a polygon the same way as every other, so a nonzero fill unions them. */
const wind = (poly) => (signedArea(poly) < 0 ? [...poly].reverse() : poly);

const round = (n) => Math.round(n * 100) / 100;
const toPath = (poly) => `M${poly.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`;

/**
 * The solid: front face, back face, and a quad bridging every edge between
 * them. Quads whose edge faces away are hidden under the front face, so there
 * is no need to work out which edges are on the silhouette — but every piece
 * must wind the same way, or `fill-rule: nonzero` punches the overlaps out as
 * holes instead of merging them.
 */
const BODY = [
  wind(FACE),
  wind(BACK),
  ...FACE.map((p, i) => {
    const q = FACE[(i + 1) % FACE.length];
    return wind([p, q, shift(q), shift(p)]);
  }),
];

/**
 * The lit edges: front-face arrises that genuinely face upward.
 *
 * Drawn as a stroke and clipped to the face, so half the width falls inside the
 * letter and none of it fattens the silhouette. This is what stops the face
 * reading as a flat blue shape — a real extrusion catches light on its top
 * arrises, and at favicon size this highlight is most of what says "3D".
 *
 * The threshold is not `normal.y < 0`. The lean tips the stems off vertical, so
 * their side faces pick up a little upward tilt and a bare sign test lights
 * them too — which put a full-strength highlight down the inside of the right
 * stem, a face that is nearly edge-on to the light. Requiring a real upward
 * component keeps the four top arrises and drops the sides.
 */
const UPWARD = 0.35;
const LIT = FACE.flatMap((p, i) => {
  const q = FACE[(i + 1) % FACE.length];
  // FACE is wound so that (dy, -dx) is the outward normal.
  const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
  const ny = -dx / Math.hypot(dx, dy);
  return ny < -UPWARD ? [`M${round(p[0])} ${round(p[1])}L${round(q[0])} ${round(q[1])}`] : [];
});

const xs = BODY.flat().map(([x]) => x);
const ys = BODY.flat().map(([, y]) => y);
const BOX = {
  x: Math.min(...xs), y: Math.min(...ys),
  w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
};

const PATHS = {
  body: BODY.map(toPath).join(''),
  face: toPath(FACE),
  lit: LIT.join(''),
};

/* --------------------------------------------------------------------- render */

/** Gradients and the clip the highlight rides in. Ids are suffixed per-use. */
function defs(id, palette, { glow = false } = {}) {
  const span = (x1, y1, x2, y2) =>
    `gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`;
  return `
    <linearGradient id="${id}-face" ${span(BOX.x, BOX.y, BOX.x, BOX.y + BOX.h)}>
      <stop offset="0" stop-color="${palette.faceHi}"/>
      <stop offset="0.55" stop-color="${palette.face}"/>
      <stop offset="1" stop-color="${palette.faceLo}"/>
    </linearGradient>
    <linearGradient id="${id}-body" ${span(BOX.x, BOX.y, BOX.x, BOX.y + BOX.h)}>
      <stop offset="0" stop-color="${palette.bodyHi}"/>
      <stop offset="1" stop-color="${palette.bodyLo}"/>
    </linearGradient>
    <clipPath id="${id}-face-clip"><path d="${PATHS.face}"/></clipPath>
    ${glow ? `<filter id="${id}-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="18" result="b"/>
      <feColorMatrix in="b" values="0 0 0 0 0.067 0 0 0 0 0.341 0 0 0 0 1 0 0 0 0.55 0"/>
      <feBlend in="SourceGraphic"/>
    </filter>` : ''}`;
}

/** The mark itself, in glyph coordinates. Wrap it in a transform to place it. */
function mark(id, palette) {
  return `
    <path d="${PATHS.body}" fill="url(#${id}-body)"/>
    <path d="${PATHS.face}" fill="url(#${id}-face)"/>
    <g clip-path="url(#${id}-face-clip)">
      <path d="${PATHS.lit}" fill="none" stroke="${palette.edge}" stroke-width="10" stroke-linecap="butt"/>
    </g>`;
}

/**
 * Places the mark centred in a square of `size`, filling `fill` of the width.
 * Optical rather than arithmetic centring: an italic mark's top-right corner
 * juts past its feet, so geometric centring leaves it visibly heavy on the
 * right.
 */
function placed(id, palette, size, fill, { nudge = [-0.012, 0] } = {}) {
  const scale = (size * fill) / BOX.w;
  const x = (size - BOX.w * scale) / 2 - BOX.x * scale + size * nudge[0];
  const y = (size - BOX.h * scale) / 2 - BOX.y * scale + size * nudge[1];
  return `<g transform="translate(${round(x)} ${round(y)}) scale(${round(scale)})">${mark(id, palette)}</g>`;
}

/**
 * The icon tile: the mark on the game's own near-black, in a rounded square.
 *
 * A tile rather than a bare mark because the extrusion is read from its tones,
 * and a bare mark loses its dark side against a dark browser tab strip. The
 * tile also gives the favicon the same ground the game has.
 */
function tile(size = 512) {
  const r = size * 0.22;
  const p = PALETTES.onDark;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="tile-bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${size}">
      <stop offset="0" stop-color="#171c24"/><stop offset="1" stop-color="#0b0d10"/>
    </linearGradient>
        ${defs('t', p)}
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#tile-bg)"/>
  <rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" rx="${r - 1.5}" ry="${r - 1.5}"
        fill="none" stroke="#1157ff" stroke-opacity="0.32" stroke-width="3"/>
  ${placed('t', p, size, 0.68)}
</svg>
`;
}

/** The bare mark on transparent, for anywhere a ground already exists. */
function bare() {
  const p = PALETTES.onLight;
  const pad = 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(BOX.x - pad)} ${round(BOX.y - pad)} ${round(BOX.w + pad * 2)} ${round(BOX.h + pad * 2)}" width="${Math.round(BOX.w + pad * 2)}" height="${Math.round(BOX.h + pad * 2)}">
  <defs>${defs('m', p)}</defs>
  ${mark('m', p)}
</svg>
`;
}

/**
 * Link preview: the mark, the wordmark, one rule.
 *
 * The type here is a system face rather than the garage's Barlow — this file is
 * rasterised now and shipped as pixels, so it only has to look right on the
 * machine that generates it, and pulling a webfont through librsvg to gain a
 * closer condensed cut is not worth the build dependency.
 */
function ogImage(w = 1200, h = 630) {
  const p = PALETTES.onDark;
  const scale = (h * 0.42) / BOX.h;
  const markW = BOX.w * scale;

  /**
   * Width of the wordmark at `TYPE` px, measured off a render rather than
   * computed — librsvg gives no metrics back, and the alternative is a lockup
   * that drifts to one side as the type changes. Re-measure if either changes.
   */
  const TYPE = 70;
  const WORD_W = 476;
  const GAP = 56;

  const left = (w - (markW + GAP + WORD_W)) / 2;
  const textX = left + markW + GAP;
  const mid = h / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <defs>
    <linearGradient id="og-bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${h}">
      <stop offset="0" stop-color="#12161d"/><stop offset="1" stop-color="#0a0c10"/>
    </linearGradient>
    <radialGradient id="og-pool" gradientUnits="userSpaceOnUse" cx="${round(left + markW / 2)}" cy="${mid}" r="${w * 0.42}">
      <stop offset="0" stop-color="#1157ff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#1157ff" stop-opacity="0"/>
    </radialGradient>
    ${defs('o', p, { glow: true })}
  </defs>
  <rect width="${w}" height="${h}" fill="url(#og-bg)"/>
  <rect width="${w}" height="${h}" fill="url(#og-pool)"/>
  <g filter="url(#o-glow)" transform="translate(${round(left)} ${round((h - BOX.h * scale) / 2 - BOX.y * scale)}) scale(${round(scale)})">
    ${mark('o', p)}
  </g>
  <g transform="translate(${round(textX)} 0)" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <text x="0" y="${mid - 16}" font-size="${TYPE}" font-weight="800" font-style="italic"
          letter-spacing="2" fill="#ffffff">MOTORPOOL</text>
    <rect x="2" y="${mid + 6}" width="86" height="5" fill="#1157ff"/>
    <text x="0" y="${mid + 62}" font-size="22" font-weight="600" letter-spacing="7" fill="#7f8ea6">
      DRIVING EXPERIENCE
    </text>
  </g>
</svg>
`;
}

/* ---------------------------------------------------------------------- write */

/**
 * A minimal ICO wrapping PNGs. The format allows a PNG payload per entry
 * verbatim, which every browser still asking for a .ico understands, so there
 * is no need for a BMP encoder.
 */
async function ico(sizes) {
  const images = await Promise.all(
    sizes.map((s) => sharp(Buffer.from(tile(512))).resize(s, s).png().toBuffer()),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(s >= 256 ? 0 : s, 0);
    entry.writeUInt8(s >= 256 ? 0 : s, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

const svg = (s) => Buffer.from(s);

writeFileSync('src/app/icon.svg', tile(512));
writeFileSync('public/logo.svg', bare());

await sharp(svg(tile(512))).resize(180, 180).png().toFile('src/app/apple-icon.png');
await sharp(svg(ogImage())).png().toFile('src/app/opengraph-image.png');
writeFileSync('src/app/favicon.ico', await ico([32, 48]));

writeFileSync(
  'src/components/racing/logoPaths.ts',
  `/* Generated by scripts/make-logo.mjs — do not edit. */

/** The mark's bounding box, in the coordinates the paths below use. */
export const LOGO_BOX = { x: ${round(BOX.x)}, y: ${round(BOX.y)}, w: ${round(BOX.w)}, h: ${round(BOX.h)} } as const;

/** The extruded solid: front face, back face and the quads bridging them. */
export const LOGO_BODY = '${PATHS.body}';

/** The front face alone, drawn over the solid. */
export const LOGO_FACE = '${PATHS.face}';

/** Front-face edges that face upward, stroked to catch the light. */
export const LOGO_LIT = '${PATHS.lit}';
`,
);

console.log(`mark ${round(BOX.w)} x ${round(BOX.h)} · lean ${LEAN}° · depth ${DEPTH.join(',')}`);
console.log('wrote icon.svg, favicon.ico, apple-icon.png, opengraph-image.png, logo.svg, logoPaths.ts');
