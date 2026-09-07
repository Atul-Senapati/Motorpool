'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CITY_NAV_IMAGE } from '@/config/cityConfig';
import { RAIL_LENGTH, railPointAt } from '@/config/railConfig';
import {
  loadCityNav, toPixelX, toPixelZ, toWorldX, toWorldZ, type NavRaster,
} from '@/physics/cityNav';
import type { VehicleTelemetry } from '@/types/vehicle';
import { HUD, INK, NUM, PLATE, PLATE_CUT } from './hudTheme';

/** Minimap diameter in CSS pixels. */
const SIZE = 176;
/** How much world the minimap shows across its diameter, in metres. */
const SPAN_METRES = 260;
/** Minimap redraws per second. The map only needs to feel live, not be smooth. */
const HZ = 30;

const COMPASS = [
  { label: 'N', x: 0, z: -1 },
  { label: 'E', x: 1, z: 0 },
  { label: 'S', x: 0, z: 1 },
  { label: 'W', x: -1, z: 0 },
];

/** Cardinal name for a heading, for the readout under the compass. */
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

interface Waypoint {
  x: number;
  z: number;
}

/**
 * Paint the whole nav raster into an offscreen canvas, once.
 *
 * Roads are drawn bright and everything else recedes, so at minimap size the
 * street grid is the only thing that reads. Terrain keeps a faint height ramp
 * so the hills and the coastline stay legible on the full map.
 */
function paintFullMap(nav: NavRaster): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = nav.width;
  canvas.height = nav.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  const image = ctx.createImageData(nav.width, nav.height);
  const out = image.data;
  const src = nav.data;

  for (let i = 0; i < nav.width * nav.height; i++) {
    const road = src[i * 4];
    const has = src[i * 4 + 3];
    const o = i * 4;
    // Pale streets on dark ground: a plain, legible road map, which is what a
    // minimap in this genre is. A cyan holographic version was tried and read
    // as a radar screen rather than as somewhere you are driving.
    if (road > 127) {
      out[o] = 226; out[o + 1] = 232; out[o + 2] = 240; out[o + 3] = 255;
    } else if (has > 127) {
      // Faint height ramp: low ground dark, hilltops slightly lifted.
      const h = ((src[o + 1] << 8) | src[o + 2]) / 65535;
      const v = 26 + h * 42;
      out[o] = v * 0.62; out[o + 1] = v; out[o + 2] = v * 0.66; out[o + 3] = 255;
    } else {
      out[o] = 12; out[o + 1] = 16; out[o + 2] = 26; out[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  paintRailLoop(ctx, nav);
  return canvas;
}

/** Tram line colour, shared by the map line and the legend swatch. */
export const RAIL_COLOUR = '#5ad1c8';

/**
 * Strokes the tram loop over the painted map.
 *
 * Baked into the prepainted canvas rather than drawn per frame, so it costs
 * nothing at runtime and comes along for free in both the minimap blit (where
 * it rotates with the world) and the M-key full map.
 *
 * Two passes: a solid line for the route, then a dashed overlay on top so it
 * reads as rail rather than as one more street — which matters more now the
 * loop runs down streets that are themselves drawn on the map.
 */
function paintRailLoop(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  const steps = 512;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const [x, z] = railPointAt((i / steps) * RAIL_LENGTH);
    const px = toPixelX(nav, x);
    const pz = toPixelZ(nav, z);
    if (i === 0) ctx.moveTo(px, pz);
    else ctx.lineTo(px, pz);
  }
  ctx.closePath();

  ctx.lineJoin = 'round';
  ctx.strokeStyle = RAIL_COLOUR;
  ctx.lineWidth = 6;
  ctx.stroke();

  // Sleeper hatching.
  ctx.strokeStyle = 'rgba(8,14,20,0.7)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([4, 9]);
  ctx.stroke();
  ctx.restore();
}

interface MinimapProps {
  telemetry: RefObject<VehicleTelemetry>;
}

export function Minimap({ telemetry }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waypointRef = useRef<Waypoint | null>(null);
  const headingLabelRef = useRef<HTMLDivElement>(null);
  const distanceLabelRef = useRef<HTMLDivElement>(null);
  /** The pin sits beside the reading, so the row hides as a unit when unset. */
  const distanceRowRef = useRef<HTMLDivElement>(null);

  // The raster and its prepainted canvas are state, not refs: they are read
  // during render to decide what to mount, and they settle exactly once.
  const [nav, setNav] = useState<NavRaster | null>(null);
  const [fullMap, setFullMap] = useState<HTMLCanvasElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Mirrors waypointRef purely so the header can re-render when it changes;
  // the draw loop always reads the ref.
  const [hasWaypoint, setHasWaypoint] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadCityNav(CITY_NAV_IMAGE)
      .then((raster) => {
        if (cancelled) return;
        setNav(raster);
        setFullMap(paintFullMap(raster));
      })
      .catch((error) => console.error('[minimap] failed to build map', error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'KeyM') setExpanded((open) => !open);
      if (event.code === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // --- the live minimap -----------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const full = fullMap;
    if (!canvas || !nav || !full) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const centre = SIZE / 2;
    const radius = centre - 3;
    // Device pixels per raster pixel.
    const zoom = SIZE / (SPAN_METRES / nav.metresPerPixel);

    let frame = 0;
    let last = 0;
    let lastCardinal = '';
    let lastDistance = '';

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / HZ) return;
      last = now;

      const t = telemetry.current;
      if (!t) return;

      const px = toPixelX(nav, t.x);
      const pz = toPixelZ(nav, t.z);
      // Rotating the map by +heading puts the car's forward direction at screen
      // up: forward is (-sin h, -cos h) in map space, which rotates to (0, -1).
      const rot = t.heading;

      ctx.save();
      ctx.beginPath();
      ctx.arc(centre, centre, radius, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = '#0c1019';
      ctx.fillRect(0, 0, SIZE, SIZE);

      ctx.translate(centre, centre);
      ctx.rotate(rot);
      // Only the rotated square that can cover the disc is sampled, rather than
      // transforming the whole 2931x1467 map every frame.
      const half = (centre / zoom) * Math.SQRT2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        full,
        px - half, pz - half, half * 2, half * 2,
        -half * zoom, -half * zoom, half * 2 * zoom, half * 2 * zoom,
      );

      // Waypoint, drawn in map space so it rotates with the world.
      const wp = waypointRef.current;
      if (wp) {
        const wx = (toPixelX(nav, wp.x) - px) * zoom;
        const wz = (toPixelZ(nav, wp.z) - pz) * zoom;
        const dist = Math.hypot(wx, wz);
        const clamped = dist > radius - 8 ? (radius - 8) / dist : 1;
        ctx.save();
        ctx.translate(wx * clamped, wz * clamped);
        ctx.rotate(-rot); // keep the marker upright regardless of map rotation
        ctx.fillStyle = '#ffb020';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-4.5, -9);
        ctx.lineTo(4.5, -9);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -10.5, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      // --- overlays that do not rotate ---
      ctx.save();
      ctx.translate(centre, centre);

      // Player chevron, always pointing up.
      ctx.fillStyle = '#4da3ff';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -8.5);
      ctx.lineTo(6, 7);
      ctx.lineTo(0, 3.5);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Compass letters ride the rim, so N really points north.
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const c of COMPASS) {
        const dx = c.x * Math.cos(rot) - c.z * Math.sin(rot);
        const dz = c.x * Math.sin(rot) + c.z * Math.cos(rot);
        ctx.fillStyle = c.label === 'N' ? '#ff6b5e' : 'rgba(255,255,255,0.5)';
        ctx.fillText(c.label, dx * (radius - 9), dz * (radius - 9));
      }
      ctx.restore();

      // Ring.
      ctx.beginPath();
      ctx.arc(centre, centre, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // --- text readouts, only touched when they change ---
      const degrees = ((t.heading * 180) / Math.PI + 360) % 360;
      const cardinal = `${CARDINALS[Math.round(degrees / 45) % 8]} ${Math.round(degrees).toString().padStart(3, '0')}°`;
      if (cardinal !== lastCardinal && headingLabelRef.current) {
        headingLabelRef.current.textContent = cardinal;
        lastCardinal = cardinal;
      }

      let distanceText = '';
      if (wp) {
        const metres = Math.hypot(wp.x - t.x, wp.z - t.z);
        distanceText = metres >= 1000 ? `${(metres / 1000).toFixed(2)} KM` : `${Math.round(metres)} M`;
      }
      if (distanceText !== lastDistance) {
        if (distanceLabelRef.current) distanceLabelRef.current.textContent = distanceText;
        if (distanceRowRef.current) distanceRowRef.current.style.opacity = distanceText ? '1' : '0';
        lastDistance = distanceText;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [nav, fullMap, telemetry]);

  const setWaypointFromEvent = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!nav) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * nav.width;
    const pz = ((event.clientY - rect.top) / rect.height) * nav.height;
    waypointRef.current = { x: toWorldX(nav, px), z: toWorldZ(nav, pz) };
    setHasWaypoint(true);
  }, [nav]);

  const clearWaypoint = useCallback(() => {
    waypointRef.current = null;
    setHasWaypoint(false);
  }, []);

  if (!nav || !fullMap) return null;

  return (
    <>
      <div className="absolute bottom-6 left-6 flex flex-col items-center gap-2">
        {/* A ring, not a frame: one hairline and nothing behind it. */}
        <div
          className="relative rounded-full p-[3px]"
          style={{ border: `1px solid ${HUD.line}` }}
        >
          {/* With every panel gone from the rest of the HUD, an opaque disc was
              the heaviest thing on screen. Held at 70% and feathered further in
              so the map sits in the scene rather than on it — the roads are
              near-white and survive it; the ground was only ever a backdrop.
              The feather still stops short of the compass letters, which the
              canvas draws 9 px inside the edge. */}
          <canvas
            ref={canvasRef}
            style={{
              width: SIZE,
              height: SIZE,
              opacity: 0.82,
              maskImage: 'radial-gradient(circle, #000 88%, transparent 100%)',
              WebkitMaskImage: 'radial-gradient(circle, #000 88%, transparent 100%)',
            }}
            className="rounded-full"
          />
        </div>

        {/* Heading and waypoint distance in one angled tab under the disc. The
            "M · MAP" hint that used to sit here is on the controls page; a
            hint that never goes away is furniture. */}
        <div className="-mt-3 flex items-center gap-3 px-3.5 py-1.5" style={{ ...PLATE, clipPath: PLATE_CUT }}>
          <div
            ref={headingLabelRef}
            style={{ ...NUM, ...INK, fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: HUD.text }}
          >
            N 000°
          </div>

          {/* Distance to the waypoint, with the reference's map pin. Hidden
              rather than unmounted, so the tab never changes width. */}
          <div
            ref={distanceRowRef}
            className="flex items-center gap-1.5 pr-2 transition-opacity duration-200"
            style={{ opacity: 0 }}
          >
            <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden>
              <path
                d="M4.5 0C2 0 0 2 0 4.5C0 7.5 4.5 12 4.5 12S9 7.5 9 4.5C9 2 7 0 4.5 0Z"
                fill={HUD.way}
              />
              <circle cx="4.5" cy="4.4" r="1.6" fill="rgba(7,13,20,0.85)" />
            </svg>
            <div
              ref={distanceLabelRef}
              className="tabular-nums"
              style={{ ...NUM, ...INK, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: HUD.way }}
            />
          </div>
        </div>
      </div>

      {expanded && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm p-6">
          <div className="flex w-full max-w-[1100px] items-center justify-between text-[10px] tracking-[0.22em] text-white/50">
            <span className="flex items-center gap-4">
              CITY MAP · CLICK TO SET WAYPOINT
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-5 rounded-full" style={{ background: RAIL_COLOUR }} />
                RAIL LOOP
              </span>
            </span>
            <span className="flex gap-4">
              {hasWaypoint && (
                <button onClick={clearWaypoint} className="tracking-[0.22em] text-[#ffb020] hover:text-white">
                  CLEAR
                </button>
              )}
              <button onClick={() => setExpanded(false)} className="tracking-[0.22em] hover:text-white">
                CLOSE · ESC
              </button>
            </span>
          </div>
          <FullMap
            fullMap={fullMap}
            nav={nav}
            telemetry={telemetry}
            waypointRef={waypointRef}
            onPick={setWaypointFromEvent}
          />
        </div>
      )}
    </>
  );
}

/**
 * The M-key map. Redrawn on its own rAF loop while open so the player marker
 * tracks the car; the base map is a single blit of the prepainted canvas.
 */
function FullMap({
  fullMap, nav, telemetry, waypointRef, onPick,
}: {
  fullMap: HTMLCanvasElement | null;
  nav: NavRaster | null;
  telemetry: RefObject<VehicleTelemetry>;
  waypointRef: RefObject<Waypoint | null>;
  onPick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !nav || !fullMap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = nav.width;
    canvas.height = nav.height;

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;

      ctx.drawImage(fullMap, 0, 0);

      const px = toPixelX(nav, t.x);
      const pz = toPixelZ(nav, t.z);

      const wp = waypointRef.current;
      if (wp) {
        const wx = toPixelX(nav, wp.x);
        const wz = toPixelZ(nav, wp.z);
        ctx.strokeStyle = 'rgba(255,176,32,0.85)';
        ctx.lineWidth = 4;
        ctx.setLineDash([14, 10]);
        ctx.beginPath();
        ctx.moveTo(px, pz);
        ctx.lineTo(wx, wz);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffb020';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(wx, wz, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Player: a chevron pointing along the heading.
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(-t.heading);
      ctx.fillStyle = '#4da3ff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -19);
      ctx.lineTo(13, 15);
      ctx.lineTo(0, 8);
      ctx.lineTo(-13, 15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fullMap, nav, telemetry, waypointRef]);

  return (
    // No `object-contain`: it would letterbox the bitmap inside the element,
    // and the click-to-waypoint mapping reads the element's bounding rect, so
    // any letterboxing would silently offset every waypoint. Constraining the
    // aspect ratio instead keeps the bitmap filling the box undistorted.
    <canvas
      ref={ref}
      onClick={onPick}
      style={{ aspectRatio: nav ? nav.width / nav.height : 2 }}
      className="max-h-[78vh] w-full max-w-[1100px] cursor-crosshair rounded-lg border border-white/10"
    />
  );
}
