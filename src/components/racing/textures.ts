/**
 * Procedural textures, generated once into canvases at runtime.
 *
 * Keeps the payload small (no image files ship) and keeps every texture at a
 * modest resolution, which matters more for GPU bandwidth than for download.
 */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

const cache = new Map<string, Texture>();

function make(key: string, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true) {
  const existing = cache.get(key);
  if (existing) return existing;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  draw(ctx);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  cache.set(key, texture);
  return texture;
}

/** Deterministic value noise so the look is stable across reloads. */
function noise(ctx: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], spread: number, seed: number) {
  const image = ctx.createImageData(w, h);
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  for (let i = 0; i < w * h; i++) {
    const n = (random() - 0.5) * spread;
    image.data[i * 4] = Math.max(0, Math.min(255, base[0] + n));
    image.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + n));
    image.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + n));
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export const asphaltTexture = () =>
  make('asphalt', 512, 512, (ctx) => {
    noise(ctx, 512, 512, [56, 57, 60], 34, 12345);
    // A few darker patches so the surface isn't uniformly flat.
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = i % 2 ? '#2c2d30' : '#6a6b70';
      const x = (i * 97) % 512;
      const y = (i * 211) % 512;
      ctx.beginPath();
      ctx.ellipse(x, y, 30 + (i % 7) * 12, 18 + (i % 5) * 9, i, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

/** Roughness map for the asphalt — slightly polished in patches, like a racing line. */
export const asphaltRoughness = () =>
  make('asphalt-rough', 256, 256, (ctx) => noise(ctx, 256, 256, [205, 205, 205], 60, 777), false);

export const curbTexture = () =>
  make('curb', 32, 128, (ctx) => {
    // Stripes run along v, which the geometry maps to arc length.
    ctx.fillStyle = '#d81f26';
    ctx.fillRect(0, 0, 32, 128);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 64, 32, 64);
  });

export const grassTexture = () =>
  make('grass', 512, 512, (ctx) => {
    noise(ctx, 512, 512, [58, 92, 44], 40, 4242);
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = i % 2 ? '#33512a' : '#6d9c4e';
      const x = (i * 137) % 512;
      const y = (i * 89) % 512;
      ctx.beginPath();
      ctx.ellipse(x, y, 40 + (i % 6) * 20, 26 + (i % 4) * 14, i * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

export const barrierTexture = () =>
  make('barrier', 256, 64, (ctx) => {
    ctx.fillStyle = '#e8e8ea';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#c8202a';
    ctx.fillRect(0, 0, 128, 64);
    // Grime along the bottom edge so the wall doesn't read as plastic.
    const gradient = ctx.createLinearGradient(0, 40, 0, 64);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 40, 256, 24);
  });

export function disposeTextures() {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
