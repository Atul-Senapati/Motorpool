import {
  CanvasTexture, EquirectangularReflectionMapping, Group, MathUtils, SRGBColorSpace,
} from 'three';
import type { GarageVehicle } from '@/config/garage';
import { THEME } from './garageTheme';

/**
 * Shared between the stage and the thumbnail renderer, so a fix made to how a
 * vehicle is lit or framed applies in both places. Splitting this out is what
 * stopped the two from drifting apart — before this, the stage got a real
 * studio and the thumbnails didn't, and the thumbnails picked their own camera
 * angle that nobody had checked against the tram.
 */

/**
 * Lays an articulated vehicle out. The tram's sections all sit at the origin
 * in the GLB — the file carries the shapes, `sections` on the garage entry
 * carries the layout — so rendering the scene as it comes stacks them all on
 * top of one another, and the vehicle measures one section long instead of its
 * full length. Laid out along -Z, the way every vehicle here faces.
 */
export function layOut(scene: Group, vehicle: GarageVehicle): Group {
  const copy = scene.clone(true);
  if (!vehicle.sections?.length) return copy;
  const laid = new Group();
  for (const { name, offset } of vehicle.sections) {
    const part = copy.getObjectByName(name);
    if (!part) continue;
    const carrier = new Group();
    carrier.position.z = -offset;
    carrier.add(part);
    laid.add(carrier);
  }
  return laid.children.length ? laid : copy;
}

export interface Framing {
  distance: number;
  /** Radians, measured from the -Z axis around Y. */
  azimuth: number;
  /** Radians of camera elevation. */
  pitch: number;
}

/**
 * How to look at a vehicle: which way, and how far back to stand.
 *
 * A fixed "3/4" angle plus a bounding-sphere fit is the right answer for
 * every car and truck in this garage — they all sit within a 2.1-3.3
 * length-to-width ratio. It breaks down for the tram, at 15.8: viewed from a
 * 3/4 angle, a train-length vehicle is seen almost end-on, so its silhouette
 * collapses to a sliver and perspective stretches the near end while the far
 * end recedes to a point. That is what made it look like it was floating and
 * shrinking rather than sitting on the turntable.
 *
 * Two changes, both gated on elongation (length / width) so every car and
 * truck here — none of which reaches even half the threshold — renders
 * exactly as before, and only the tram is affected:
 *
 *  - The azimuth eases from the 3/4 angle toward broadside. A transit
 *    agency's own press photos are broadside, not 3/4, for the same reason:
 *    it shows the full length at a consistent distance from the camera,
 *    instead of foreshortening it into depth.
 *  - Distance is fit to the vehicle's actual silhouette at that azimuth —
 *    `w·|cos θ| + l·|sin θ|`, the exact width of a box's orthographic
 *    projection — rather than to a bounding sphere. A sphere fit is generous
 *    to a boxy car (most of the sphere is close to the body) and wildly
 *    wrong for a thin, elongated one: nearly all of the sphere's volume is
 *    empty air around the body, so the fit distance is dictated by the
 *    short axis and the vehicle renders small in the middle of unused frame.
 *
 * `marginMul` scales the fitted distance beyond its own 1.16 base margin, for
 * a caller that wants more air around the vehicle than a tight fit gives —
 * the stage backs off further than the thumbnail renderer does, because a
 * small tile wants to fill itself but a large hero shot wants breathing room.
 *
 * That extra margin is **tapered out as elongation rises**, fading to no
 * effect at all by the time a vehicle reaches the tram's own broadside
 * regime. The tram's fit distance is already large because it is fitting a
 * 24 m length rather than a 4.3 m one; multiplying an already-large
 * distance by the same factor a compact car gets pushes it far enough back
 * that it shrinks to a sliver in the middle of the frame. A car close to
 * elongation 3 gets the full `marginMul`; a vehicle at the broadside end of
 * the range (`t = 1`) gets none, because its own framing was tuned against
 * the tight fit and already reads correctly.
 */
export function frameVehicle(
  vehicle: GarageVehicle, fovDeg: number, aspect: number, marginMul = 1,
): Framing {
  const [w, h, l] = vehicle.size;
  const elongation = l / Math.max(w, 0.5);
  const t = MathUtils.clamp((elongation - 3) / 11, 0, 1);
  const azimuth = MathUtils.lerp(0.9, 1.48, t);
  const pitch = MathUtils.degToRad(MathUtils.lerp(11, 6, t));
  const effectiveMargin = MathUtils.lerp(marginMul, 1, t);

  const vHalf = MathUtils.degToRad(fovDeg) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);

  const apparentWidth = w * Math.abs(Math.cos(azimuth)) + l * Math.abs(Math.sin(azimuth));
  const apparentHeight = h / Math.cos(pitch);

  const distForWidth = (apparentWidth / 2) / Math.tan(hHalf);
  const distForHeight = (apparentHeight / 2) / Math.tan(vHalf);
  const distance = Math.max(distForWidth, distForHeight) * 1.16 * effectiveMargin;

  return { distance, azimuth, pitch };
}

/** Camera position and look-at point for a `Framing`. Always centred at x=0. */
export function cameraPose(vehicle: GarageVehicle, framing: Framing) {
  const { distance, azimuth, pitch } = framing;
  const h = vehicle.size[1];
  return {
    position: [
      Math.sin(azimuth) * distance * Math.cos(pitch),
      h * 0.38 + distance * Math.sin(pitch),
      -Math.cos(azimuth) * distance * Math.cos(pitch),
    ] as const,
    lookAt: [0, h * 0.46, 0] as const,
  };
}

/**
 * Studio reflection map: white above, a dark false horizon, soft banks.
 *
 * This is what the paint reflects, and it is the difference between a car
 * that looks lit and one that looks pasted on — a PBR body with no
 * environment map has no specular contribution beyond direct lights and
 * reads as flat plastic regardless of how many lights are pointed at it. The
 * dark band just above the horizon is the "blacks" a real car studio hangs:
 * without one, white-studio paint has nothing to put a shadow line across
 * and washes out.
 */
export function studioEnvMap(): CanvasTexture {
  const w = 1024, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;

  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0.00, '#ffffff');
  wall.addColorStop(0.42, '#eef2f7');
  wall.addColorStop(0.50, '#dfe5ee');
  wall.addColorStop(0.54, '#c7ceda');
  wall.addColorStop(0.58, '#3a4354');
  wall.addColorStop(0.64, '#5e6878');
  wall.addColorStop(0.72, '#aeb7c4');
  wall.addColorStop(1.00, '#8f99a8');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);

  const bank = (x: number, y: number, rx: number, ry: number, a: number) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(rx / ry, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${a * 0.6})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(-ry * 1.3, -ry, ry * 2.6, ry * 2); ctx.restore();
  };
  bank(w * 0.22, h * 0.20, 260, 56, 1);
  bank(w * 0.78, h * 0.22, 220, 48, 0.9);
  bank(w * 0.50, h * 0.08, 340, 40, 0.8);

  const t = new CanvasTexture(c);
  t.mapping = EquirectangularReflectionMapping;
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Turntable decal: pale disc, accent keyline, fine tick ring. */
export function padTexture(): CanvasTexture {
  const s = 1024;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  const cx = s / 2, cy = s / 2;
  ctx.clearRect(0, 0, s, s);

  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.47);
  disc.addColorStop(0, '#e6ebf2');
  disc.addColorStop(1, '#d3dae4');
  ctx.fillStyle = disc;
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.47, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = THEME.accent;
  ctx.lineWidth = 9;
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.455, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(11,18,32,0.10)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const r0 = s * 0.415, r1 = i % 8 === 0 ? s * 0.39 : s * 0.40;
    ctx.strokeStyle = i % 8 === 0 ? THEME.accent : 'rgba(11,18,32,0.18)';
    ctx.lineWidth = i % 8 === 0 ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * A soft dark blob for the thumbnail floor, standing in for a real shadow.
 *
 * The thumbnail canvas renders exactly one frame and is thrown away, so a
 * shadow map (which needs `shadows` enabled on the Canvas and a render or two
 * to settle) is not worth its own cost there. A radial gradient baked once
 * and reused for every vehicle gives the same "grounded, not floating" cue
 * for a fraction of the price.
 */
export function groundBlobTexture(): CanvasTexture {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(11,18,32,0.34)');
  g.addColorStop(0.55, 'rgba(11,18,32,0.16)');
  g.addColorStop(1, 'rgba(11,18,32,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
