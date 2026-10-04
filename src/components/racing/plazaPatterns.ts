import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * Paving patterns for the civic plazas, drawn on a canvas.
 *
 * Each draws one seamless tile and says how many metres of ground it covers,
 * so `KestrelPlazas` can lay it at true size. A little per-stone tone and grain
 * keeps a big plaza from reading as a printed sheet.
 */

export type PlazaPattern = 'herringbone' | 'granite' | 'bond' | 'hex';

export const PLAZA_PATTERNS: readonly PlazaPattern[] = ['herringbone', 'granite', 'bond', 'hex'];

interface Drawn { texture: CanvasTexture; metres: number }

/** Deterministic noise, so a stone's tone does not change between loads. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shade(base: [number, number, number], k: number) {
  return `rgb(${base.map((c) => Math.max(0, Math.min(255, Math.round(c * k)))).join(',')})`;
}

/** Fine grain over everything: speckle and a few darker pores. */
function grain(ctx: CanvasRenderingContext2D, size: number, rand: () => number, amount: number) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function finish(canvas: HTMLCanvasElement, metres: number, anisotropy: number): Drawn {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = anisotropy;
  return { texture, metres };
}

/** Herringbone clay pavers, 200 × 100 mm, warm grey. One repeat is 0.8 m. */
function herringbone(size: number, rand: () => number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const joint: [number, number, number] = [92, 88, 82];
  ctx.fillStyle = shade(joint, 1);
  ctx.fillRect(0, 0, size, size);
  const unit = size / 8; // a paver is 2 × 1 units; the tile is 8 × 8
  const g = unit * 0.07;
  const tones: Array<[number, number, number]> = [[176, 160, 140], [162, 146, 128], [186, 172, 152], [150, 138, 124]];
  const brick = (x: number, y: number, w: number, h: number) => {
    const t = tones[Math.floor(rand() * tones.length)];
    ctx.fillStyle = shade(t, 0.92 + rand() * 0.14);
    // Drawn with wrap so the tile is seamless.
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      ctx.fillRect(x + ox + g, y + oy + g, w - g * 2, h - g * 2);
    }
  };
  // 45° herringbone laid as a 90° one: alternate horizontal and vertical pairs
  // stepping one unit each row — the classic staircase.
  for (let row = -2; row < 10; row++) {
    for (let k = -2; k < 6; k++) {
      const x = (k * 2 + row) * unit;
      const y = (row - k * 2) * unit;
      brick(x, y, unit * 2, unit);
      brick(x + unit, y + unit, unit, unit * 2);
    }
  }
  grain(ctx, size, rand, 14);
  return { canvas: c, metres: 0.8 };
}

/** Large sawn granite, 600 mm squares, light silver-grey with a dark band every 3 m. */
function granite(size: number, rand: () => number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const n = 5; // 5 × 0.6 m = 3 m tile
  const cell = size / n;
  const g = Math.max(1, cell * 0.012);
  ctx.fillStyle = 'rgb(120,120,122)';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const band = i === 0 || j === 0; // a darker banding course round each 3 m square
    const base: [number, number, number] = band ? [118, 120, 126] : [196, 196, 192];
    ctx.fillStyle = shade(base, 0.94 + rand() * 0.1);
    ctx.fillRect(i * cell + g, j * cell + g, cell - g * 2, cell - g * 2);
    // Flecks, the way granite has them.
    for (let f = 0; f < 260; f++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(40,40,45,0.35)' : 'rgba(255,255,255,0.35)';
      const r = rand() * cell * 0.012 + 0.5;
      ctx.fillRect(i * cell + g + rand() * (cell - g * 2), j * cell + g + rand() * (cell - g * 2), r, r);
    }
  }
  grain(ctx, size, rand, 8);
  return { canvas: c, metres: 3 };
}

/** Stretcher-bond concrete setts, 300 × 150 mm, two tones. One repeat is 1.2 m. */
function bond(size: number, rand: () => number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(86,86,86)';
  ctx.fillRect(0, 0, size, size);
  const rows = 8;
  const cols = 4;
  const h = size / rows;
  const w = size / cols;
  const g = h * 0.06;
  for (let r = 0; r < rows; r++) {
    const shift = r % 2 ? w / 2 : 0;
    for (let k = -1; k <= cols; k++) {
      const dark = rand() < 0.25;
      const base: [number, number, number] = dark ? [128, 126, 122] : [178, 175, 168];
      ctx.fillStyle = shade(base, 0.93 + rand() * 0.12);
      ctx.fillRect(k * w + shift + g, r * h + g, w - g * 2, h - g * 2);
    }
  }
  grain(ctx, size, rand, 12);
  return { canvas: c, metres: 1.2 };
}

/** Hexagonal concrete pavers, 250 mm across flats, sandy grey. */
function hex(size: number, rand: () => number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(96,92,86)';
  ctx.fillRect(0, 0, size, size);
  // Tile fits 4 hexes across and a whole number of rows (flat-topped, rows offset).
  const across = 4;
  const r = size / across / Math.sqrt(3); // circumradius from the across-flats width
  const dx = Math.sqrt(3) * r;
  const dy = 1.5 * r;
  const rowsN = Math.round(size / dy);
  const sy = size / rowsN;
  const inset = 0.92;
  for (let row = -1; row <= rowsN; row++) {
    for (let col = -1; col <= across; col++) {
      const cx = col * dx + (row % 2 ? dx / 2 : 0);
      const cy = row * sy;
      const base: [number, number, number] = [184, 176, 160];
      ctx.fillStyle = shade(base, 0.9 + rand() * 0.16);
      for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          const px = cx + ox + Math.cos(a) * r * inset;
          const py = cy + oy + Math.sin(a) * r * inset * (sy / dy);
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  grain(ctx, size, rand, 12);
  return { canvas: c, metres: across * 0.25 };
}

export function drawPlazaPattern(pattern: PlazaPattern, anisotropy: number): Drawn {
  const rand = rng(0xc1a5 + pattern.length * 977);
  const size = 1024;
  const made = pattern === 'herringbone' ? herringbone(size, rand)
    : pattern === 'granite' ? granite(size, rand)
      : pattern === 'bond' ? bond(size, rand)
        : hex(size, rand);
  return finish(made.canvas, made.metres, anisotropy);
}
