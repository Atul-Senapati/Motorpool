'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CITY_NAV_IMAGE } from '@/config/cityConfig';
import {
  loadCityNav, toPixelX, toPixelZ, toWorldX, toWorldZ, type NavRaster,
} from '@/physics/cityNav';
import type { VehicleTelemetry } from '@/types/vehicle';

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
  return canvas;
}

interface MinimapProps {
  telemetry: RefObject<VehicleTelemetry>;
}

export function Minimap({ telemetry }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waypointRef = useRef<Waypoint | null>(null);
  const headingLabelRef = useRef<HTMLDivElement>(null);
  const distanceLabelRef = useRef<HTMLDivElement>(null);

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
      if (distanceText !== lastDistance && distanceLabelRef.current) {
        distanceLabelRef.current.textContent = distanceText;
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
      <div className="absolute right-8 top-7 flex flex-col items-center gap-2">
        <div className="relative rounded-full border border-white/10 bg-black/30 p-[3px] backdrop-blur-md">
          <canvas
            ref={canvasRef}
            style={{ width: SIZE, height: SIZE }}
            className="rounded-full"
          />
        </div>

        <div className="flex flex-col items-center gap-1">
          <div
            ref={headingLabelRef}
            className="rounded bg-black/30 px-2 py-0.5 text-[10px] font-medium tracking-[0.18em] text-white/75 tabular-nums backdrop-blur-md"
          >
            N 000°
          </div>
          <div
            ref={distanceLabelRef}
            className="text-[10px] font-medium tracking-[0.18em] text-[#ffb020] tabular-nums"
          />
          <div className="text-[9px] tracking-[0.22em] text-white/30">M · MAP</div>
        </div>
      </div>

      {expanded && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm p-6">
          <div className="flex w-full max-w-[1100px] items-center justify-between text-[10px] tracking-[0.22em] text-white/50">
            <span>CITY MAP · CLICK TO SET WAYPOINT</span>
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
