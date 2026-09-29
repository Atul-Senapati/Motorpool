'use client';

import { CanvasTexture } from 'three';

/**
 * A spinning rotor, as a texture.
 *
 * Neither aircraft here can show a rotor honestly. A quadcopter's props turn
 * at ten thousand rpm and a helicopter's main rotor at four hundred, and at
 * sixty frames a second both of those alias into a slow backwards crawl — the
 * wagon-wheel effect, which reads as broken rather than as fast. What a camera
 * sees instead is a *disc*: a smear with the ghosts of blades in it. So the
 * geometry turns at a rate chosen to look right, and this is laid over it,
 * fading in as the rotor picks up.
 *
 * Drawn once and shared: it is the same picture at any size.
 */
export function propBlurTexture(blades = 2): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;

  // The disc itself, fading out toward the rim.
  const disc = ctx.createRadialGradient(c, c, 0, c, c, c);
  disc.addColorStop(0, 'rgba(20,22,26,0.75)');
  disc.addColorStop(0.35, 'rgba(20,22,26,0.42)');
  disc.addColorStop(0.9, 'rgba(30,32,36,0.22)');
  disc.addColorStop(1, 'rgba(30,32,36,0)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();

  // Blade ghosts: wide, soft, and thinning toward the tip.
  for (let i = 0; i < blades; i++) {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((i * Math.PI * 2) / blades);
    const blade = ctx.createLinearGradient(0, 0, c, 0);
    blade.addColorStop(0, 'rgba(0,0,0,0.55)');
    blade.addColorStop(1, 'rgba(60,64,70,0.05)');
    ctx.fillStyle = blade;
    ctx.beginPath();
    ctx.moveTo(0, -c * 0.06);
    ctx.quadraticCurveTo(c * 0.6, -c * 0.16, c * 0.98, -c * 0.04);
    ctx.lineTo(c * 0.98, c * 0.04);
    ctx.quadraticCurveTo(c * 0.6, c * 0.16, 0, c * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // The tip ring, which is the part of a turning rotor the eye actually finds.
  ctx.strokeStyle = 'rgba(200,210,220,0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, c - 3, 0, Math.PI * 2);
  ctx.stroke();

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}
