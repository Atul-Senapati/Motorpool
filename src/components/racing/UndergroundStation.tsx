'use client';

import { useEffect, useMemo } from 'react';
import { AdditiveBlending, BackSide, CanvasTexture, DoubleSide, RepeatWrapping, SRGBColorSpace } from 'three';
import {
  RAIL_HEAD_LIFT, TRAIN, trainNormalAt, trainPointAt,
} from '@/config/trainConfig';
import { pairCentreAt } from '@/config/trackPair';
import { UNDERGROUND, UNDERGROUND_SITE, undergroundStationAt } from '@/config/stationConfig';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';
import {
  BORE_INVERT, BORE_V_SCALE, LINING_MATERIAL, LINING_PITCH, LINING_PROFILE,
  makeGlowTexture, makeLampTexture, makeLiningTexture,
} from './boreProfile';

/**
 * The underground station: a twin-platform subway hall cut into the long tunnel.
 *
 * ## The room
 *
 * Two side platforms, one for each track — the right-hand one serves the
 * running (up) line, the left-hand one the down line — each under a low flat
 * ceiling on a row of green steel columns along its edge, with a tall bay over
 * the two tracks between them. Fluorescent tubes under the low ceilings, light
 * troughs along the bay, conduit the length of it, small white tiles on the
 * back walls under a name frieze and a dark border band, big square tiles on
 * the platforms with a concrete coping and a yellow tactile strip at the edge,
 * hanging direction signs, framed posters, exit portals with a lit lintel and
 * the green sign, benches, bins, fire points, camera domes, a sign plate and a
 * speaker on every column. The look is a city subway station, dim and a little
 * grimy, not a hall.
 *
 * ## Coordinates: the pair centre
 *
 * Every lateral number here is metres LEFT of the centre of the track pair,
 * `pairCentreAt(arc)` — the running line is at -gap/2 and the down line at
 * +gap/2 — because the hall is symmetric about that centre and so is the bore
 * it grows out of. The samples are placed on the pair centre, so a profile
 * `off` of 0 is the middle of the hall and the bore's horseshoe needs no shift
 * to hand over to the lining, which `TrainLine` centres the same way.
 *
 * ## Why the track bay is tall
 *
 * The chase camera rides high over the rail. A ceiling at 4.8 m — the room's
 * height — puts it on the roof, looking down through it. So the low ceilings
 * stop `stepInset` behind each platform face and the bay over the tracks runs
 * up to 8.9 m, which is the bore's own height and a little over.
 *
 * ## The section is the bore, reshaped
 *
 * Every section vertex is an interpolation between the bore's section and the
 * room's. The bore's is `LINING_PROFILE` itself — walkways and all, the very
 * vertices the lining is lofted from — and the room is resampled to the same
 * count at the same perimeter fractions, so each bore vertex has a room vertex
 * to travel to and the walkways flatten into the floor as the platforms
 * begin. Over the platforms the blend is 1; over `ease` metres at each end it
 * runs to 0.
 *
 * ## Meeting the lining
 *
 * The lining stops one sample SHORT of the hall (`isBore` in `TrainLine`
 * excludes any segment with an end in the cavern), and the hall carries the
 * bare bore section out to exactly that sample — its `margin` — in the
 * lining's own texture and colours. Ending the lining one sample INTO the
 * ease, as it did, left its last ring standing free inside a room already
 * wider than it, with a gap all round and the walkways ending on a bare face.
 *
 * ## Two sides, one description
 *
 * Each platform and everything on it is described once, left-positive, and
 * built twice through `sided(s, …)` with s = +1 (left, down line) and s = -1
 * (right, up line). `buildLoft` orients its triangles from the profile's
 * signed area, so the mirrored copy keeps its faces the right way out. Wall
 * fittings and the exit portals sit `s` * a little proud of the wall, INTO the
 * room, because the room is one continuous loft and anything behind its wall
 * is invisible from inside. The name frieze reads left-to-right from either
 * platform because the right-hand wall gets a texture drawn the other way.
 */

const U = UNDERGROUND;
const GAP = TRAIN.elevated.trackGap;
const INVERT = BORE_INVERT;

const H = U.hallHalf;
const TOP = U.platformRise;
const LOW = U.lowCeiling;
const BAY = U.bayCeiling;
/** Platform face and back wall, metres from the pair centre. */
const FACE = GAP / 2 + U.platformSetback;
const BACK = H - 0.2;
/** Where each low ceiling steps up into the bay. */
const STEP = FACE - U.stepInset;

interface Sample extends LoftSample {
  along: number;
  /** 0 = the bore's section, 1 = the room's. */
  t: number;
}
type Side = 1 | -1;
type Pt = [number, number];

const smooth = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

/** The bore's section: the lining's own vertices. */
const BORE_PTS: Pt[] = LINING_PROFILE.map((v) => [v.off, v.rise]);
/**
 * The room, as a polygon in the same sense and from the same corner: along
 * the floor from the left wall's foot, up the right wall, along the right low
 * ceiling to its step, up into the bay, across, down the left step, along the
 * left low ceiling, down the left wall.
 */
const ROOM_POLY: Pt[] = [
  [-H, INVERT], [H, INVERT], [H, LOW], [STEP, LOW], [STEP, BAY],
  [-STEP, BAY], [-STEP, LOW], [-H, LOW],
];
/** Each vertex's fraction of the way round a closed polygon. */
function fractionsOf(poly: Pt[]): number[] {
  const n = poly.length;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    lengths.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    total += lengths[i];
  }
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) { out.push(run / total); run += lengths[i]; }
  return out;
}
/** The point `f` of the way round a closed polygon. */
function alongPoly(poly: Pt[], f: number): Pt {
  const n = poly.length;
  let total = 0;
  const lengths = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += l;
    return l;
  });
  let want = Math.min(0.999999, Math.max(0, f)) * total;
  for (let i = 0; i < n; i++) {
    if (want <= lengths[i]) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const u = lengths[i] ? want / lengths[i] : 0;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    want -= lengths[i];
  }
  return poly[0];
}
/** The room resampled onto the bore's vertex count, vertex for vertex. */
const ROOM_PTS: Pt[] = fractionsOf(BORE_PTS).map((f) => alongPoly(ROOM_POLY, f));
const SECTION_COUNT = BORE_PTS.length;
function sectionVertex(k: number, t: number): Pt {
  const a = BORE_PTS[k];
  const b = ROOM_PTS[k];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/**
 * The throat lamps: the bore's strip carried on down each wall of the ease and
 * margin, riding the blended section so it follows the wall out from the bore
 * to the hall, in the same lens texture on the same absolute V — so the lamps
 * neither stop nor change pitch at the seam. The bore's lamps stop where the
 * cavern starts and the hall's fittings stop at the platform; unlit, the
 * eighteen metres between were a black void round a lit box.
 */
const throatLight = (side: 1 | -1): ProfileVertex<Sample>[] => {
  // The bore vertex at the top of the wall, this side: (±W, boreWall).
  const k = BORE_PTS.findIndex(([off, rise]) => Math.abs(rise - TRAIN.boreWall) < 1e-6
    && Math.sign(off) === side && Math.abs(Math.abs(off) - TRAIN.boreHalf) < 1e-6);
  const at = (s: Sample) => sectionVertex(k, s.t);
  return [
    { off: (s) => at(s)[0] - side * 0.07, rise: (s) => at(s)[1] - 0.17 },
    { off: (s) => at(s)[0] - side * 0.07, rise: (s) => at(s)[1] + 0.17 },
  ];
};
const ROOM_PROFILE: ProfileVertex<Sample>[] = Array.from({ length: SECTION_COUNT }, (_, k) => ({
  off: (s) => sectionVertex(k, s.t)[0],
  rise: (s) => sectionVertex(k, s.t)[1],
}));

const onPlatform = (a: Sample, b: Sample) => a.t >= 1 && b.t >= 1;

/** A profile described left-positive, built for side `s`. */
const sided = (s: Side, pts: Pt[]): ProfileVertex<Sample>[] => pts.map(([off, rise]) => ({ off: s * off, rise }));

/** The platform slab, face to back wall, down to the invert. */
const PLATFORM: Pt[] = [
  [FACE, TOP], [BACK - 0.02, TOP], [BACK - 0.02, INVERT], [FACE, INVERT],
];
/** Concrete coping along the edge, then the yellow tactile strip behind it. */
const COPING: Pt[] = [[FACE - 0.01, TOP + 0.012], [FACE + 0.45, TOP + 0.012]];
const EDGE_LINE: Pt[] = [[FACE + 0.45, TOP + 0.016], [FACE + 1.05, TOP + 0.016]];
/** Cable trunking along the platform face, over the track. */
const TRUNKING: Pt[] = [
  [FACE - 0.16, INVERT + 0.5], [FACE - 0.16, INVERT + 0.72], [FACE + 0.01, INVERT + 0.72], [FACE + 0.01, INVERT + 0.5],
];
/** The tiled back wall, platform to the border band; the frieze and band sit proud of it. */
const TILES: Pt[] = [[BACK - 0.03, TOP], [BACK - 0.03, LOW - 0.55]];
const FRIEZE: Pt[] = [[BACK - 0.05, TOP + 2.0], [BACK - 0.05, TOP + 2.5]];
const BORDER: Pt[] = [[BACK - 0.04, LOW - 0.55], [BACK - 0.04, LOW - 0.12]];
/** Suspended ceiling panels over the platform, wall to step. */
const CEILING: Pt[] = [[H - 0.05, LOW - 0.03], [STEP + 0.05, LOW - 0.03]];
/** Green fascia on the step face, where the low ceiling meets the bay. */
const FASCIA: Pt[] = [[STEP + 0.02, LOW], [STEP + 0.02, LOW + 0.55]];
/**
 * The bay's lamps: the bore's own strip — lens texture at `BORE_V_SCALE` pitch,
 * on the same absolute V so the lamps run on from the tunnel at the same
 * spacing and phase — on each step face, just above the fascia, with the same
 * glow pools on the step face, the bay ceiling and the invert. The hall is lit
 * in the bore's language; the platforms keep their tubes.
 */
const LAMP_RISE = LOW + 1.05;
const BAY_LAMP: Pt[] = [[STEP - 0.07, LAMP_RISE - 0.17], [STEP - 0.07, LAMP_RISE + 0.17]];
const STEP_GLOW: Pt[] = [[STEP - 0.045, LOW + 0.05], [STEP - 0.045, BAY - 0.15]];
const BAY_GLOW: Pt[] = [[STEP - 0.1, BAY - 0.03], [STEP - 3.1, BAY - 0.03]];
const INVERT_GLOW: Pt[] = [[STEP - 0.15, INVERT + 0.02], [STEP - 2.6, INVERT + 0.02]];
/** Two conduits along each low ceiling. */
const conduit = (off: number): Pt[] => [
  [off - 0.06, LOW - 0.16], [off - 0.06, LOW - 0.04], [off + 0.06, LOW - 0.04], [off + 0.06, LOW - 0.16],
];
/** Drainage channel down the middle of the track bed. */
const DRAIN: ProfileVertex<Sample>[] = [{ off: -0.3, rise: INVERT + 0.015 }, { off: 0.3, rise: INVERT + 0.015 }];

const STATION_NAME = 'MOTORPOOL CENTRAL';

function canvas2d(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}
function lcg(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}
function finish(canvas: HTMLCanvasElement, repeatU: number, repeatV: number): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.repeat.set(repeatU, repeatV);
  return texture;
}
/** Small white wall tiles: 0.1 m, twelve to a texture, so 1.2 m per repeat. */
function makeWallTiles(): CanvasTexture {
  const size = 256;
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = '#8d877b';
  ctx.fillRect(0, 0, size, size);
  const per = 12;
  const tile = size / per;
  const random = lcg(11);
  for (let j = 0; j < per; j++) {
    for (let i = 0; i < per; i++) {
      const shade = 214 + Math.floor(random() * 22);
      ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 14})`;
      ctx.fillRect(i * tile + 1.5, j * tile + 1.5, tile - 3, tile - 3);
    }
  }
  return finish(canvas, 1 / 1.2, 1);
}
/** Platform floor: 0.6 m square tiles, two to a texture, 1.2 m per repeat. */
function makeFloorTiles(): CanvasTexture {
  const size = 256;
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = '#5e5a52';
  ctx.fillRect(0, 0, size, size);
  const tile = size / 2;
  const random = lcg(23);
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const shade = 168 + Math.floor(random() * 18);
      ctx.fillStyle = `rgb(${shade}, ${shade - 5}, ${shade - 16})`;
      ctx.fillRect(i * tile + 3, j * tile + 3, tile - 6, tile - 6);
      ctx.fillStyle = 'rgba(40,36,30,0.18)';
      ctx.fillRect(i * tile + 3, j * tile + 3, tile - 6, 10);
    }
  }
  return finish(canvas, 1 / 1.2, 1);
}
/** Suspended ceiling: 0.6 m panels with a dark grid, two to a texture. */
function makeCeilingPanels(): CanvasTexture {
  const size = 256;
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, size, size);
  const tile = size / 2;
  const random = lcg(41);
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const shade = 196 + Math.floor(random() * 14);
      ctx.fillStyle = `rgb(${shade}, ${shade - 2}, ${shade - 10})`;
      ctx.fillRect(i * tile + 2, j * tile + 2, tile - 4, tile - 4);
      // Perforations, faintly.
      ctx.fillStyle = 'rgba(60,60,60,0.25)';
      for (let n = 0; n < 24; n++) ctx.fillRect(i * tile + 8 + (n % 6) * 20, j * tile + 8 + Math.floor(n / 6) * 30, 3, 3);
    }
  }
  return finish(canvas, 1 / 1.2, 1);
}
/**
 * The name frieze: a dark green band with the station name in white, running
 * along the wall. U is across the band (0.5 m, up the wall), V along the line
 * (8 m per name, +arc up the canvas because of `flipY`), so the text is drawn
 * down the canvas.
 *
 * The two walls are not the same transform. A reader on the right-hand
 * platform faces -normal, with +arc to their left: their view of the canvas
 * is a +90° rotation, so rotating the text +90° reads upright and forward. A
 * reader on the left faces +normal, with +arc to their right — their view is
 * the canvas seen from its BACK, a reflection, and no rotation makes a
 * reflected canvas read forward and upright at once. So the left wall gets the
 * reflection (text baseline → canvas -y, text up → canvas +x).
 */
function makeFrieze(dir: Side): CanvasTexture {
  const w = 128;
  const h = 1024;
  const { canvas, ctx } = canvas2d(w, h);
  ctx.fillStyle = '#1e3a2a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e8e6da';
  ctx.fillRect(0, 0, w, 6);
  ctx.fillRect(0, h - 6, w, 6);
  ctx.fillRect(6, 0, 4, h);
  ctx.fillRect(w - 10, 0, 4, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  if (dir === 1) ctx.transform(0, -1, -1, 0, 0, 0);
  else ctx.rotate(Math.PI / 2);
  ctx.font = 'bold 74px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f2f0e6';
  ctx.fillText(STATION_NAME, 0, 0);
  ctx.restore();
  return finish(canvas, 2, 1);
}
/** Metres of arc per texture repeat along the line, for the tile lofts. */
const TILE_V = 1.2;
const FRIEZE_V = 8;

const GREEN = {
  color: '#24402c', emissive: '#24402c', emissiveIntensity: 0.55, roughness: 0.55, metalness: 0.35,
} as const;
const POSTER_COLOURS = ['#b8412e', '#2f5d8a', '#d8a92a', '#3c7a4e', '#7a3c8a', '#d86a2a'];

interface Spot { x: number; y: number; z: number; angle: number; side: Side }

export function UndergroundStation() {
  const site = UNDERGROUND_SITE;

  const built = useMemo(() => {
    if (!site) return null;
    const half = U.length / 2 + U.ease;
    const pitch = 2;
    // The margin: from the end of the ease out to the first line sample that
    // is NOT in the cavern — where the lining's first segment starts. The hall
    // carries the bare bore section that far, so the two meet exactly.
    const stepArc = LINING_PITCH;
    const margin = (sign: 1 | -1) => {
      let k = sign > 0 ? Math.ceil((site.arc + half) / stepArc) : Math.floor((site.arc - half) / stepArc);
      while (undergroundStationAt(k * stepArc)) k += sign;
      return Math.abs(k * stepArc - site.arc);
    };
    const outerPlus = margin(1);
    const outerMinus = margin(-1);
    const alongs: number[] = [-outerMinus];
    for (let a = Math.ceil(-outerMinus / pitch) * pitch; a < outerPlus - 1e-6; a += pitch) {
      if (a - alongs[alongs.length - 1] > 0.5) alongs.push(a);
    }
    alongs.push(outerPlus);
    const samples: Sample[] = [];
    for (const along of alongs) {
      const arc = site.arc + along;
      const [x, y, z] = trainPointAt(arc);
      const [nx, nz] = trainNormalAt(arc);
      const centre = pairCentreAt(arc);
      const beyond = Math.abs(along) - U.length / 2;
      samples.push({
        x: x + nx * centre, z: z + nz * centre, nx, nz, arc, y: y + RAIL_HEAD_LIFT, along,
        t: beyond <= 0 ? 1 : 1 - smooth(beyond / U.ease),
      });
    }
    /** A fixture: `along` metres from the centre, `off` metres left of the pair centre. */
    const at = (along: number, off: number, side: Side): Spot => {
      let i = 0;
      for (let j = 1; j < samples.length; j++) {
        if (Math.abs(samples[j].along - along) < Math.abs(samples[i].along - along)) i = j;
      }
      const s = samples[i];
      const next = samples[Math.min(samples.length - 1, i + 1)];
      const prev = samples[Math.max(0, i - 1)];
      return {
        x: s.x + s.nx * off, z: s.z + s.nz * off, y: s.y,
        angle: Math.atan2(next.x - prev.x, next.z - prev.z), side,
      };
    };
    const spots = (spacing: number, phase: number) => {
      const out: number[] = [];
      for (let a = -U.length / 2 + phase; a <= U.length / 2 - phase + 1e-6; a += spacing) out.push(a);
      return out;
    };
    /** Drop positions within `clearance` of any in `avoid` — posters off the exits. */
    const clear = (list: number[], avoid: number[], clearance: number) => (
      list.filter((a) => avoid.every((b) => Math.abs(a - b) > clearance))
    );
    const exitAlongs = spots(U.exitSpacing, 26);
    const both = <T,>(f: (s: Side) => T): T[] => [f(1), f(-1)];
    const fixtures = (alongs: number[], off: number) => both((s) => alongs.map((a) => at(a, s * off, s))).flat();
    const loft = (pts: Pt[], closed = false, vScale?: number) => both((s) => (
      buildLoft(samples, sided(s, pts), { closed, filter: onPlatform, vScale })
    ));

    return {
      liningTexture: makeLiningTexture(),
      lampTexture: makeLampTexture(),
      glowTexture: makeGlowTexture(),
      wallTiles: makeWallTiles(),
      floorTiles: makeFloorTiles(),
      ceilingPanels: makeCeilingPanels(),
      friezes: both((s) => makeFrieze(s)),
      // One profile, two finishes: the platform length is the station's own
      // concrete, the eases and margins at each end are the lining's — the same
      // texture and colours as the bore they hand over to, so the only seam is
      // the one a real station has, where the hall's finish stops.
      room: buildLoft(samples, ROOM_PROFILE, { closed: true, vScale: BORE_V_SCALE, filter: onPlatform }),
      throats: buildLoft(samples, ROOM_PROFILE, {
        closed: true, vScale: BORE_V_SCALE, filter: (a, b) => !onPlatform(a, b),
      }),
      throatLights: ([1, -1] as Side[]).map((side) => (
        buildLoft(samples, throatLight(side), { vScale: BORE_V_SCALE, filter: (a, b) => !onPlatform(a, b) })
      )),
      drain: buildLoft(samples, DRAIN, { filter: onPlatform }),
      platforms: loft(PLATFORM, true, TILE_V),
      copings: loft(COPING),
      edges: loft(EDGE_LINE),
      trunkings: loft(TRUNKING, true),
      tiles: loft(TILES, false, TILE_V),
      friezeBands: loft(FRIEZE, false, FRIEZE_V),
      borders: loft(BORDER),
      ceilings: loft(CEILING, false, TILE_V),
      fascias: loft(FASCIA),
      bayLamps: loft(BAY_LAMP, false, BORE_V_SCALE),
      glows: [STEP_GLOW, BAY_GLOW, INVERT_GLOW].flatMap((band) => loft(band, false, BORE_V_SCALE)),
      conduits: [FACE + 1.7, FACE + 3.7].map((off) => loft(conduit(off), true)).flat(),
      columns: fixtures(spots(U.columnSpacing, 2.5), FACE + U.columnInset),
      lamps: fixtures(spots(U.lampSpacing, 2), FACE + U.platformWidth / 2 + 0.2),
      bins: fixtures(spots(U.binSpacing, 9), FACE + U.columnInset + 0.9),
      cameras: fixtures(spots(U.cameraSpacing, 14), FACE + 1.0),
      benches: fixtures(spots(U.benchSpacing, 7), BACK - 0.75),
      exits: fixtures(exitAlongs, BACK),
      signs: fixtures(spots(U.signSpacing, 12), FACE + 1.25),
      posters: fixtures(clear(spots(U.adSpacing, 4), exitAlongs, 2.8), BACK),
      firePoints: fixtures(clear(spots(U.firePointSpacing, 2), exitAlongs, 2.0), BACK),
    };
  }, [site]);

  useEffect(() => () => {
    if (!built) return;
    built.liningTexture.dispose();
    built.lampTexture.dispose();
    built.glowTexture.dispose();
    built.wallTiles.dispose();
    built.floorTiles.dispose();
    built.ceilingPanels.dispose();
    for (const f of built.friezes) f.dispose();
    for (const r of [built.room, built.throats, ...built.throatLights, built.drain, ...built.platforms, ...built.copings, ...built.edges,
      ...built.trunkings, ...built.tiles, ...built.friezeBands, ...built.borders, ...built.ceilings,
      ...built.fascias, ...built.bayLamps, ...built.glows, ...built.conduits]) r.geometry.dispose();
  }, [built]);

  if (!site || !built) return null;

  return (
    <group>
      {/* The room, from the inside. Dim, dark concrete, carried by a low
          emissive: the sun reaches underground in this scene, and this is the
          only way a ceiling stays a ceiling. */}
      {/* The vault, in the lining's own concrete: the hall is the bore, widened,
          and the same texture, colours and ring joints carry straight through
          the throats from the tunnel. The platforms, tiles and tubes are what
          say "station"; the structure says "tunnel". */}
      <mesh geometry={built.room.geometry}>
        <meshStandardMaterial
          map={built.liningTexture} emissiveMap={built.liningTexture}
          color={LINING_MATERIAL.color} emissive={LINING_MATERIAL.emissive}
          emissiveIntensity={LINING_MATERIAL.emissiveIntensity} roughness={1} side={BackSide}
        />
      </mesh>
      {built.throatLights.map((l, i) => (
        <mesh key={`tl${i}`} geometry={l.geometry}>
          <meshBasicMaterial map={built.lampTexture} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}
      {/* The throats flare from the bore to the hall in the lining's finish,
          under the bore's lamps carried on at the same pitch, so there is no
          seam at all: bore, throat and vault are one structure. */}
      <mesh geometry={built.throats.geometry}>
        <meshStandardMaterial
          map={built.liningTexture} emissiveMap={built.liningTexture}
          color={LINING_MATERIAL.color} emissive={LINING_MATERIAL.emissive}
          emissiveIntensity={LINING_MATERIAL.emissiveIntensity} roughness={1} side={BackSide}
        />
      </mesh>
      <mesh geometry={built.drain.geometry}>
        <meshStandardMaterial color="#141416" emissive="#1c1c20" emissiveIntensity={0.5} roughness={1} side={DoubleSide} />
      </mesh>

      {/* Platforms: big tiles, a concrete coping, the yellow tactile strip,
          trunking along the face. */}
      {built.platforms.map((p, i) => (
        <mesh key={`p${i}`} geometry={p.geometry}>
          <meshStandardMaterial
            map={built.floorTiles} color="#4a4742" emissive="#ffffff" emissiveMap={built.floorTiles}
            emissiveIntensity={0.42} roughness={0.7} side={DoubleSide}
          />
        </mesh>
      ))}
      {built.copings.map((c, i) => (
        <mesh key={`k${i}`} geometry={c.geometry}>
          <meshStandardMaterial color="#8f8a80" emissive="#8f8a80" emissiveIntensity={0.45} roughness={0.9} side={DoubleSide} />
        </mesh>
      ))}
      {built.edges.map((e, i) => (
        <mesh key={`y${i}`} geometry={e.geometry}>
          <meshStandardMaterial color="#c9a21c" emissive="#c9a21c" emissiveIntensity={0.5} roughness={0.85} side={DoubleSide} />
        </mesh>
      ))}
      {built.trunkings.map((t, i) => (
        <mesh key={`t${i}`} geometry={t.geometry}>
          <meshStandardMaterial color="#4a4a4c" emissive="#3a3a3c" emissiveIntensity={0.5} roughness={0.7} metalness={0.4} side={DoubleSide} />
        </mesh>
      ))}

      {/* Back walls: small white tiles, the name frieze, a dark border band. */}
      {built.tiles.map((t, i) => (
        <mesh key={`w${i}`} geometry={t.geometry}>
          <meshStandardMaterial
            map={built.wallTiles} color="#5f5c55" emissive="#ffffff" emissiveMap={built.wallTiles}
            emissiveIntensity={0.55} roughness={0.35} side={DoubleSide}
          />
        </mesh>
      ))}
      {built.friezeBands.map((f, i) => (
        <mesh key={`f${i}`} geometry={f.geometry}>
          <meshStandardMaterial
            map={built.friezes[i]} color="#7a7a72" emissive="#ffffff" emissiveMap={built.friezes[i]}
            emissiveIntensity={0.6} roughness={0.5} side={DoubleSide}
          />
        </mesh>
      ))}
      {built.borders.map((b, i) => (
        <mesh key={`d${i}`} geometry={b.geometry}>
          <meshStandardMaterial color="#1f2f24" emissive="#1f2f24" emissiveIntensity={0.6} roughness={0.5} side={DoubleSide} />
        </mesh>
      ))}

      {/* Ceilings: suspended panels over the platforms, a green fascia on the
          step, light troughs along the bay, conduit. */}
      {built.ceilings.map((c, i) => (
        <mesh key={`g${i}`} geometry={c.geometry}>
          <meshStandardMaterial
            map={built.ceilingPanels} color="#6a6a66" emissive="#ffffff" emissiveMap={built.ceilingPanels}
            emissiveIntensity={0.5} roughness={0.9} side={DoubleSide}
          />
        </mesh>
      ))}
      {built.fascias.map((f, i) => (
        <mesh key={`a${i}`} geometry={f.geometry}>
          <meshStandardMaterial {...GREEN} side={DoubleSide} />
        </mesh>
      ))}
      {built.bayLamps.map((l, i) => (
        <mesh key={`bl${i}`} geometry={l.geometry}>
          <meshBasicMaterial map={built.lampTexture} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}
      {built.glows.map((g, i) => (
        <mesh key={`gw${i}`} geometry={g.geometry}>
          <meshBasicMaterial
            map={built.glowTexture} transparent opacity={i < 2 ? 0.7 : 0.5} blending={AdditiveBlending}
            depthWrite={false} side={DoubleSide} toneMapped={false}
          />
        </mesh>
      ))}
      {built.conduits.map((c, i) => (
        <mesh key={`n${i}`} geometry={c.geometry}>
          <meshStandardMaterial color="#3a3a3c" emissive="#3a3a3c" emissiveIntensity={0.5} roughness={0.6} metalness={0.5} side={DoubleSide} />
        </mesh>
      ))}

      {/* Columns down each platform edge: green steel, a sign plate, a speaker. */}
      {built.columns.map((c, i) => (
        <group key={`c${i}`} position={[c.x, c.y, c.z]} rotation={[0, c.angle, 0]}>
          <mesh position={[0, (TOP + LOW) / 2, 0]}>
            <boxGeometry args={[0.34, LOW - TOP, 0.34]} />
            <meshStandardMaterial {...GREEN} />
          </mesh>
          <mesh position={[0, TOP + 0.05, 0]}>
            <boxGeometry args={[0.5, 0.1, 0.5]} />
            <meshStandardMaterial color="#2a2a2c" emissive="#2a2a2c" emissiveIntensity={0.5} roughness={0.8} />
          </mesh>
          {/* The plate: black, with a white bar for the name. */}
          <mesh position={[0, TOP + 2.35, 0]}>
            <boxGeometry args={[0.38, 0.62, 0.38]} />
            <meshStandardMaterial color="#111214" emissive="#111214" emissiveIntensity={0.6} roughness={0.6} />
          </mesh>
          {[-1, 1].map((f) => (
            <mesh key={f} position={[0, TOP + 2.42, f * 0.196]}>
              <boxGeometry args={[0.26, 0.09, 0.01]} />
              <meshBasicMaterial color="#e9e9e4" toneMapped={false} />
            </mesh>
          ))}
          {/* Speaker horn, high on the track side. */}
          <mesh position={[-c.side * 0.26, LOW - 0.45, 0]} rotation={[0, 0, c.side * 0.35]}>
            <boxGeometry args={[0.18, 0.2, 0.3]} />
            <meshStandardMaterial color="#8a8a86" emissive="#8a8a86" emissiveIntensity={0.35} roughness={0.6} metalness={0.4} />
          </mesh>
        </group>
      ))}

      {/* Fluorescent tubes in a row under each low ceiling. */}
      {built.lamps.map((l, i) => (
        <group key={`l${i}`} position={[l.x, l.y + LOW - 0.22, l.z]} rotation={[0, l.angle, 0]}>
          <mesh>
            <boxGeometry args={[0.32, 0.12, 1.3]} />
            <meshStandardMaterial color="#8f8f8a" emissive="#8f8f8a" emissiveIntensity={0.4} roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[0, -0.07, 0]}>
            <boxGeometry args={[0.2, 0.03, 1.2]} />
            <meshBasicMaterial color="#f4f1e2" toneMapped={false} />
          </mesh>
        </group>
      ))}

      {/* Hanging direction signs over each platform edge. */}
      {built.signs.map((s, i) => (
        <group key={`h${i}`} position={[s.x, s.y + LOW, s.z]} rotation={[0, s.angle, 0]}>
          {[-0.7, 0.7].map((x) => (
            <mesh key={x} position={[x, -0.22, 0]}>
              <boxGeometry args={[0.04, 0.44, 0.04]} />
              <meshStandardMaterial color="#5a5a5c" emissive="#5a5a5c" emissiveIntensity={0.4} metalness={0.5} roughness={0.5} />
            </mesh>
          ))}
          <mesh position={[0, -0.64, 0]}>
            <boxGeometry args={[1.9, 0.42, 0.07]} />
            <meshStandardMaterial color="#14243a" emissive="#14243a" emissiveIntensity={0.7} roughness={0.5} />
          </mesh>
          {[-1, 1].map((f) => (
            <group key={f}>
              <mesh position={[-0.3, -0.64, f * 0.04]}>
                <boxGeometry args={[1.0, 0.1, 0.01]} />
                <meshBasicMaterial color="#f0efe8" toneMapped={false} />
              </mesh>
              <mesh position={[0.6, -0.64, f * 0.04]}>
                <boxGeometry args={[0.3, 0.22, 0.01]} />
                <meshBasicMaterial color="#e2b22a" toneMapped={false} />
              </mesh>
            </group>
          ))}
        </group>
      ))}

      {/* Bins by the columns, camera domes on the ceiling, benches at the wall. */}
      {built.bins.map((b, i) => (
        <mesh key={`b${i}`} position={[b.x, b.y + TOP + 0.5, b.z]}>
          <cylinderGeometry args={[0.32, 0.3, 1.0, 14]} />
          <meshStandardMaterial color="#15161a" emissive="#2a2b30" emissiveIntensity={0.5} roughness={0.7} />
        </mesh>
      ))}
      {built.cameras.map((c, i) => (
        <mesh key={`v${i}`} position={[c.x, c.y + LOW - 0.14, c.z]}>
          <sphereGeometry args={[0.13, 12, 8]} />
          <meshStandardMaterial color="#e8e8e4" emissive="#e8e8e4" emissiveIntensity={0.45} roughness={0.4} />
        </mesh>
      ))}
      {built.benches.map((b, i) => (
        <group key={`s${i}`} position={[b.x, b.y + TOP, b.z]} rotation={[0, b.angle, 0]}>
          <mesh position={[0, 0.24, 0]}>
            <boxGeometry args={[0.45, 0.06, 1.9]} />
            <meshStandardMaterial color="#4a3222" emissive="#4a3222" emissiveIntensity={0.5} roughness={0.7} />
          </mesh>
          {/* Backrest against the wall side. */}
          <mesh position={[b.side * 0.2, 0.55, 0]}>
            <boxGeometry args={[0.05, 0.4, 1.9]} />
            <meshStandardMaterial color="#4a3222" emissive="#4a3222" emissiveIntensity={0.5} roughness={0.7} />
          </mesh>
          {[-0.75, 0.75].map((z) => (
            <mesh key={z} position={[0, 0.11, z]}>
              <boxGeometry args={[0.38, 0.22, 0.08]} />
              <meshStandardMaterial {...GREEN} />
            </mesh>
          ))}
        </group>
      ))}

      {/* Framed posters and fire points on the back walls, proud of the tiles. */}
      {built.posters.map((p, i) => (
        <group key={`ad${i}`} position={[p.x, p.y + TOP + 1.55, p.z]} rotation={[0, p.angle, 0]}>
          <mesh position={[-p.side * 0.05, 0, 0]}>
            <boxGeometry args={[0.06, 1.62, 2.32]} />
            <meshStandardMaterial color="#2a2a2c" emissive="#2a2a2c" emissiveIntensity={0.5} roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[-p.side * 0.09, 0, 0]}>
            <boxGeometry args={[0.01, 1.45, 2.15]} />
            <meshBasicMaterial color={POSTER_COLOURS[i % POSTER_COLOURS.length]} toneMapped={false} />
          </mesh>
          <mesh position={[-p.side * 0.1, 0.25, -0.3]}>
            <boxGeometry args={[0.01, 0.16, 1.2]} />
            <meshBasicMaterial color="#f4f2ea" toneMapped={false} />
          </mesh>
          <mesh position={[-p.side * 0.1, -0.35, 0.2]}>
            <boxGeometry args={[0.01, 0.08, 1.5]} />
            <meshBasicMaterial color="#f4f2ea" toneMapped={false} />
          </mesh>
        </group>
      ))}
      {built.firePoints.map((f, i) => (
        <group key={`fp${i}`} position={[f.x, f.y + TOP + 1.3, f.z]} rotation={[0, f.angle, 0]}>
          <mesh position={[-f.side * 0.12, 0, 0]}>
            <boxGeometry args={[0.2, 0.7, 0.36]} />
            <meshStandardMaterial color="#b2261c" emissive="#b2261c" emissiveIntensity={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[-f.side * 0.23, 0.05, 0]}>
            <boxGeometry args={[0.01, 0.3, 0.2]} />
            <meshBasicMaterial color="#f4f2ea" toneMapped={false} />
          </mesh>
        </group>
      ))}

      {/* Exit portals in the back walls: a concrete surround proud of the tiles,
          a black opening you cannot see the end of, a lit lintel and the
          green sign. (The room is one loft, so a real alcove behind its wall
          would be invisible from inside — the portal stands in the room.) */}
      {built.exits.map((e, i) => (
        <group key={`e${i}`} position={[e.x, e.y + TOP, e.z]} rotation={[0, e.angle, 0]}>
          <mesh position={[-e.side * 0.14, 1.45, 0]}>
            <boxGeometry args={[0.28, 2.9, 3.0]} />
            <meshStandardMaterial color="#7d7970" emissive="#7d7970" emissiveIntensity={0.45} roughness={0.9} />
          </mesh>
          <mesh position={[-e.side * 0.285, 1.3, 0]}>
            <boxGeometry args={[0.01, 2.6, 2.4]} />
            <meshBasicMaterial color="#05060a" toneMapped={false} />
          </mesh>
          <mesh position={[-e.side * 0.29, 2.5, 0]}>
            <boxGeometry args={[0.01, 0.12, 2.3]} />
            <meshBasicMaterial color="#fff1cf" toneMapped={false} />
          </mesh>
          <mesh position={[-e.side * 0.34, 2.85, 0]}>
            <boxGeometry args={[0.06, 0.28, 1.1]} />
            <meshBasicMaterial color="#2ecc71" toneMapped={false} />
          </mesh>
          {/* Threshold plate. */}
          <mesh position={[-e.side * 0.5, 0.01, 0]}>
            <boxGeometry args={[0.7, 0.02, 2.4]} />
            <meshStandardMaterial color="#8f8a80" emissive="#8f8a80" emissiveIntensity={0.45} roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
