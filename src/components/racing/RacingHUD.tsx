'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { VEHICLE } from '@/config/vehicleConfig';
import { WORLD_ID } from '@/config/world';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { Minimap } from './Minimap';

const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: 'CHASE',
  close: 'CLOSE',
  cockpit: 'COCKPIT',
};

/** Number of segments in the RPM bar. */
const RPM_SEGMENTS = 28;
/** Segments from this index up are redline. */
const REDLINE_FROM = Math.floor(RPM_SEGMENTS * 0.78);

interface RacingHUDProps {
  telemetry: RefObject<VehicleTelemetry>;
  cameraMode: CameraMode;
}

/**
 * Racing HUD.
 *
 * Telemetry changes every frame, so nothing here goes through React state —
 * a single rAF loop writes straight into DOM nodes via refs. Only the camera
 * label and the help panel, which change on user action, are React-driven.
 */
export function RacingHUD({ telemetry, cameraMode }: RacingHUDProps) {
  const speedRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLDivElement>(null);
  const rpmRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<HTMLSpanElement[]>([]);
  const [showHelp, setShowHelp] = useState(true);

  // Auto-hide the controls panel; H brings it back.
  useEffect(() => {
    if (!showHelp) return;
    const timer = window.setTimeout(() => setShowHelp(false), 7000);
    return () => window.clearTimeout(timer);
  }, [showHelp]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'KeyH') setShowHelp((visible) => !visible);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let frame = 0;
    let lastSpeed = -1;
    let lastGear = -1;
    let lastLit = -1;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;

      // Only touch the DOM when the displayed value actually changes.
      const speed = Math.round(t.speedKph);
      if (speed !== lastSpeed && speedRef.current) {
        speedRef.current.textContent = String(speed);
        lastSpeed = speed;
      }

      const gear = t.reversing ? 0 : t.gear;
      if (gear !== lastGear && gearRef.current) {
        gearRef.current.textContent = gear === 0 ? 'R' : String(gear);
        lastGear = gear;
      }

      const ratio = Math.min(1, Math.max(0, (t.rpm - VEHICLE.engine.idleRpm) / (VEHICLE.engine.maxRpm - VEHICLE.engine.idleRpm)));
      const lit = Math.round(ratio * RPM_SEGMENTS);
      if (lit !== lastLit) {
        for (let i = 0; i < RPM_SEGMENTS; i++) {
          const segment = segmentRefs.current[i];
          if (!segment) continue;
          const on = i < lit;
          segment.style.opacity = on ? '1' : '0.13';
          segment.style.background = !on
            ? '#ffffff'
            : i >= REDLINE_FROM
              ? '#ff3b30'
              : i >= REDLINE_FROM - 5
                ? '#ffb020'
                : '#ffffff';
        }
        lastLit = lit;
        if (rpmRef.current) rpmRef.current.style.opacity = ratio > 0.9 ? '1' : '0.55';
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry]);

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-sans text-white">
      {/* Speed + gear cluster, bottom centre. */}
      <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
        <div className="flex items-baseline gap-2">
          <div
            ref={speedRef}
            className="text-7xl font-light leading-none tabular-nums tracking-tight drop-shadow-[0_2px_12px_rgba(0,0,0,0.65)] sm:text-8xl"
          >
            0
          </div>
          <div className="mb-2 text-xs font-medium tracking-[0.28em] text-white/60">KM/H</div>
        </div>

        <div
          ref={gearRef}
          className="text-3xl font-light leading-none tabular-nums text-white/85 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
        >
          1
        </div>

        <div ref={rpmRef} className="flex items-end gap-[3px] opacity-55 transition-opacity duration-150">
          {Array.from({ length: RPM_SEGMENTS }, (_, i) => (
            <span
              key={i}
              ref={(element) => {
                if (element) segmentRefs.current[i] = element;
              }}
              className="w-[5px] rounded-[1px] bg-white"
              style={{ height: `${9 + i * 0.42}px`, opacity: 0.13 }}
            />
          ))}
        </div>
        <div className="text-[10px] font-medium tracking-[0.34em] text-white/40">RPM</div>
      </div>

      {/* Minimap + compass, top right. City only — the procedural circuit has
          no street network to navigate. */}
      {WORLD_ID === 'city' && <Minimap telemetry={telemetry} />}

      {/* Camera mode + help, bottom right. */}
      <div className="absolute bottom-8 right-8 flex flex-col items-end gap-3 text-right">
        <div className="rounded-md border border-white/10 bg-black/25 px-3 py-1.5 backdrop-blur-md">
          <span className="text-[10px] tracking-[0.24em] text-white/45">CAMERA</span>
          <span className="ml-3 text-xs font-medium tracking-[0.16em]">{CAMERA_LABEL[cameraMode]}</span>
        </div>

        <div
          className={`rounded-md border border-white/10 bg-black/25 px-4 py-3 backdrop-blur-md transition-opacity duration-500 ${
            showHelp ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <dl className="space-y-1.5 text-[11px] leading-none text-white/70">
            {[
              ['W / ↑', 'Accelerate'],
              ['S / ↓', 'Brake · Reverse'],
              ['A D / ← →', 'Steer'],
              ['SPACE', 'Handbrake'],
              ['C', 'Camera'],
              ['R', 'Reset to road'],
              ['F', 'Flip upright'],
              ...(WORLD_ID === 'city' ? [['M', 'Map · waypoint']] : []),
              ['K', 'Mute'],
              ['H', 'Toggle help'],
            ].map(([key, label]) => (
              <div key={key} className="flex items-center justify-end gap-4">
                <dd className="text-white/50">{label}</dd>
                <dt className="min-w-[68px] text-left font-medium tracking-wider text-white/90">{key}</dt>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {/* Title and model credit, top left. The McLaren asset is CC BY-NC 4.0,
          which requires attribution wherever the work is used. Kept here rather
          than bottom-left so it cannot collide with the speed cluster on narrow
          or portrait viewports. */}
      <div className="absolute left-8 top-7 max-w-[60%]">
        <div className="text-[11px] font-medium tracking-[0.34em] text-white/85">McLAREN F1</div>
        <div className="mt-1 text-[10px] tracking-[0.2em] text-white/35">1993</div>
        <div className="mt-3 text-[9px] leading-relaxed tracking-[0.06em] text-white/25">
          Model by Alex.Ka. · CC BY-NC 4.0
        </div>
      </div>


    </div>
  );
}
