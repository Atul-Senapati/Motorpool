'use client';

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';
import { TRAIN, TRAIN_LENGTH } from '@/config/trainConfig';

/**
 * The bore's cross-section and finish, shared by the tunnel lining in
 * `TrainLine` and the underground station's hall in `UndergroundStation`.
 *
 * The hall's ends are this section, blended into the room over its ease, and
 * the lining ends where the hall begins: for the two to meet without a seam,
 * a step or a change of concrete, they must be built from the same profile
 * and the same texture. So both live here, and neither component owns them.
 */

/** Metres of arc per texture repeat along a bore. */
export const BORE_V_SCALE = 9;

/**
 * The lining's sample pitch along the line: `TrainLine` samples the loop at
 * about 5 m, exactly `TRAIN_LENGTH / round(TRAIN_LENGTH / 5)` so the samples
 * close on themselves. The hall's margins walk THIS grid to find where the
 * lining's last segment ends, so the two meet on the same sample; the route
 * file's own ~6 m grid is a different pitch and a margin computed on it missed
 * by up to a sample.
 */
export const LINING_STEP = 5;
export const LINING_PITCH = TRAIN_LENGTH / Math.round(TRAIN_LENGTH / LINING_STEP);

export const WALKWAY_WIDTH = 1.1;
export const WALKWAY_HEIGHT = 0.75;
/** The invert: a little under the sleepers. */
export const BORE_INVERT = -(TRAIN.railHeight + TRAIN.sleeperHeight) - TRAIN.boreFloorDrop;

export interface BoreVertex { off: number; rise: number }

/**
 * The tunnel lining: a horseshoe with its invert, as one closed section,
 * starting at the left foot of the invert and going round clockwise as seen
 * from behind the train — along the floor, up the right walkway and wall, over
 * the arch, down the left.
 *
 * A maintenance walkway either side, stepped up off the invert. Cheap, and it
 * is what makes the bore read as a tunnel rather than a pipe: the eye needs a
 * horizontal line at a known height to judge the size of the thing it is
 * travelling through, and a bare horseshoe gives it none.
 */
export const LINING_PROFILE: BoreVertex[] = (() => {
  const W = TRAIN.boreHalf;
  const INVERT = BORE_INVERT;
  const profile: BoreVertex[] = [
    { off: -W, rise: INVERT },
    { off: W, rise: INVERT },
    { off: W - WALKWAY_WIDTH, rise: INVERT },
    { off: W - WALKWAY_WIDTH, rise: INVERT + WALKWAY_HEIGHT },
    { off: W, rise: INVERT + WALKWAY_HEIGHT },
    { off: W, rise: TRAIN.boreWall },
  ];
  const arcSteps = 12;
  for (let k = 1; k < arcSteps; k++) {
    const a = (k / arcSteps) * Math.PI;
    profile.push({ off: W * Math.cos(a), rise: TRAIN.boreWall + W * Math.sin(a) });
  }
  profile.push({ off: -W, rise: TRAIN.boreWall });
  profile.push({ off: -W, rise: INVERT + WALKWAY_HEIGHT });
  profile.push({ off: -W + WALKWAY_WIDTH, rise: INVERT + WALKWAY_HEIGHT });
  profile.push({ off: -W + WALKWAY_WIDTH, rise: INVERT });
  return profile;
})();

/**
 * The lining's finish. Dim: the world itself goes dark underground and the
 * strips are lamps, so this is concrete in a badly lit tunnel, read by the
 * lamps and the ring joints, not a glowing surface.
 */
export const LINING_MATERIAL = {
  // Not near-black any more: the world goes dark underground, so the sun no
  // longer needs starving out, and a diffuse this light is what lets the
  // headlamps' pool show on the concrete.
  color: '#57534c',
  emissive: '#757068',
  emissiveIntensity: 0.58,
} as const;

/**
 * Tunnel lining, as a texture: shuttered concrete — pale grey with faint
 * horizontal pour lines and a little grime. Without it the bore is one flat
 * dark colour from wall to arch and reads as unlit void rather than as a
 * structure the train is inside.
 */
export function makeLiningTexture(): CanvasTexture {
  // Tall rather than square: the V axis runs along the tunnel and carries the
  // ring joints, which want to be crisp, while the U axis wraps the arch and is
  // almost featureless. 256x512 spends the pixels where they show.
  const w = 256;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  let seed = 7331;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  ctx.fillStyle = '#6e6b65';
  ctx.fillRect(0, 0, w, h);

  // Segment rings. A bored tunnel is built from precast rings, and the joint
  // between them is the one feature that tells you it is a tunnel and not a
  // pipe — and the only thing in here that moves past at a readable rate.
  // Each is a dark recess with a lit lip below it, which is what a shadowed
  // groove looks like when the light is inside the tube.
  const RING = 64;
  for (let y = 0; y < h; y += RING) {
    ctx.fillStyle = 'rgba(28, 26, 24, 0.62)';
    ctx.fillRect(0, y, w, 3);
    ctx.fillStyle = 'rgba(168, 164, 156, 0.30)';
    ctx.fillRect(0, y + 3, w, 1);
    // Bolt pockets, staggered ring to ring.
    const offset = (y / RING) % 2 ? RING / 2 : 0;
    for (let x = 12 + offset; x < w; x += 64) {
      ctx.fillStyle = 'rgba(38, 36, 33, 0.5)';
      ctx.beginPath();
      ctx.arc(x, y + 22, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Shutter marks and staining, over the rings so the joints look cast in
  // rather than drawn on.
  for (let i = 0; i < 2200; i++) {
    const shade = 96 + Math.floor(random() * 46);
    ctx.fillStyle = `rgba(${shade}, ${shade - 3}, ${shade - 9}, ${0.18 + random() * 0.3})`;
    ctx.fillRect(random() * w, random() * h, 3 + random() * 22, 1 + random() * 3);
  }
  // Damp streaks running down the arch: vertical in U, since U wraps it.
  for (let i = 0; i < 60; i++) {
    const x = random() * w;
    ctx.fillStyle = `rgba(52, 54, 50, ${0.05 + random() * 0.13})`;
    ctx.fillRect(x, random() * h, 1 + random() * 3, 40 + random() * 160);
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(0.5, BORE_V_SCALE / 2);
  texture.anisotropy = 8;
  return texture;
}

/**
 * The strip is not one continuous tube of light any more: a texture along it
 * makes a lamp every `BORE_V_SCALE` metres — a bright lens on a dark housing — so the
 * walls are lit in pools that go past at a readable rate, and between them the
 * bore is as dark as a bore is.
 */
export function makeLampTexture(): CanvasTexture {
  const w = 16;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#2e2d2a';
  ctx.fillRect(0, 0, w, h);
  // The housing's seam, so the dark part reads as a fitting and not a gap.
  ctx.fillStyle = '#3d3c38';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#23221f';
  ctx.fillRect(6, 0, 4, h);
  // The lens: 18 % of the pitch, with a soft edge.
  const lens = Math.round(h * 0.18);
  const y0 = Math.round(h * 0.41);
  ctx.fillStyle = '#fff3d6';
  ctx.fillRect(1, y0, w - 2, lens);
  ctx.fillStyle = 'rgba(255, 243, 214, 0.45)';
  ctx.fillRect(1, y0 - 3, w - 2, 3);
  ctx.fillRect(1, y0 + lens, w - 2, 3);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1, 1);
  return texture;
}

/**
 * The pool of light each lamp throws. There are no real lights in the bore (see
 * the strips), so the lining beside a lamp would be as black as the lining
 * between lamps — and a lamp that lights nothing is a sticker. This is a soft
 * blob, additive, on the same V pitch as the lamps and centred on the lens, laid
 * as translucent bands on the wall round each strip, on the walkway tops and on
 * the invert's edges: the light falls where a lamp on that wall would throw it.
 */
export function makeGlowTexture(): CanvasTexture {
  const w = 64;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, h * 0.36);
  g.addColorStop(0, 'rgba(255, 226, 176, 0.95)');
  g.addColorStop(0.35, 'rgba(255, 226, 176, 0.45)');
  g.addColorStop(1, 'rgba(255, 226, 176, 0)');
  ctx.save();
  // Squash across so the pool is longer along the wall than it is tall.
  ctx.translate(w / 2, h / 2);
  ctx.scale(w / h * 1.6, 1);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = g;
  ctx.fillRect(-w, 0, w * 3, h);
  ctx.restore();
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.repeat.set(1, 1);
  return texture;
}
