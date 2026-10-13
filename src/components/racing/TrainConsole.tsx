'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { VEHICLE } from '@/config/vehicleConfig';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { RAIL_CAMERA_MODES } from './RailCamera';
import { HUD } from './hudTheme';

/**
 * The main-line train's driver console: one slim row at the foot of the screen.
 *
 *  - **Controller**: a ladder from P5 down through N to EB, filled from N to
 *    the notch held, with the notch named beside it.
 *  - **Speed**: the number, the acceleration, the permitted speed (the
 *    overspeed guard's ceiling) and a state chip, over a meter of 5 km/h
 *    segments. The green band is the last 15 km/h under what is permitted —
 *    sitting in it is driving as fast as the line allows — and above it is red.
 *  - **Next limit**: the board, how far, and a countdown to the brake point.
 *  - **Horn and view**: N and C, as buttons as well as keys.
 *
 * Telemetry changes every frame, so the numbers are written through refs by one
 * rAF loop, as everywhere else in the HUD.
 */

/** Width of the green band under the permitted speed, km/h. */
const PACE = 15;
/** Meter segments; each is `top / SEGS` km/h. */
const SEGS = 60;
/** How far out the brake countdown starts filling, metres. */
const CUE_FROM = 800;
/** Ladder rungs top to bottom: P5 … P1, N, B1 … B7, EB. */
const RUNGS = [5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8];
const POWER_NOTCHES = 5;
const BRAKE_STEPS = 7;

const VIEW_NAME: Partial<Record<CameraMode, string>> = {
  chase: 'CHASE', cab: 'CAB', nose: 'NOSE', top: 'TOP', cinematic: 'CINEMATIC', drone: 'DRONE',
};

const INK = '#e9f1f8';
const GREEN = '#3cf08a';
const PANEL = 'rgba(4,9,15,0.78)';
const LINE = 'rgba(255,255,255,0.14)';
const DISPLAY = 'var(--font-display)';
const NUMERALS = 'var(--font-hud)';

/** Sends a key to the game as if it were pressed, so a button and its key are one control. */
function key(type: 'keydown' | 'keyup', code: string, k: string) {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: k, bubbles: true }));
}

export function TrainConsole({
  telemetry, cameraMode,
}: {
  telemetry: RefObject<VehicleTelemetry>;
  cameraMode: CameraMode;
}) {
  const top = useMemo(() => Math.max(100, Math.ceil(VEHICLE.engine.maxSpeedKph / 50) * 50), []);
  const scale = useMemo(() => Array.from({ length: top / 50 + 1 }, (_, i) => i * 50), [top]);

  const rungRefs = useRef<(HTMLElement | null)[]>([]);
  const notchRef = useRef<HTMLSpanElement>(null);
  const notchLabelRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const trendRef = useRef<HTMLSpanElement>(null);
  const permitRef = useRef<HTMLElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const segRefs = useRef<(HTMLElement | null)[]>([]);
  const permitMarkRef = useRef<HTMLSpanElement>(null);
  const targetMarkRef = useRef<HTMLSpanElement>(null);
  const boardRef = useRef<HTMLSpanElement>(null);
  const nextDistRef = useRef<HTMLSpanElement>(null);
  const cueFillRef = useRef<HTMLElement>(null);
  const cueTextRef = useRef<HTMLSpanElement>(null);
  const ebRef = useRef<HTMLDivElement>(null);
  const crossRef = useRef<HTMLDivElement>(null);
  const crossDistRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let lastV = NaN;
    let accel = 0;
    const was: Record<string, string> = {};
    /** Writes only when the value changed: most frames touch nothing. */
    const put = (id: string, value: string, write: () => void) => {
      if (was[id] === value) return;
      was[id] = value;
      write();
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;
      const now = performance.now();
      const dt = Math.max(1e-3, (now - last) / 1000);
      last = now;
      // Acceleration from the speed itself, smoothed so it reads as a trend.
      const v = Math.abs(t.forwardSpeed);
      if (Number.isFinite(lastV)) accel += ((v - lastV) / dt - accel) * Math.min(1, dt * 4);
      lastV = v;

      const speed = t.speedKph;
      const permit = Math.min(top, t.railTargetKph || top);
      const over = speed > permit + 0.5;
      const due = t.railBrakeM >= 0 && t.railBrakeM <= 0.5;
      const pace = !over && speed > 20 && speed >= permit - PACE;

      // ---- controller
      const eb = t.railControl <= -1.5;
      const notch = eb ? -8 : t.railControl > 0 ? Math.max(1, Math.ceil(t.railControl * POWER_NOTCHES - 0.01))
        : t.railControl < 0 ? -Math.max(1, Math.ceil(-t.railControl * BRAKE_STEPS - 0.01)) : 0;
      const tint = eb ? HUD.hot : notch > 0 ? HUD.cyan : notch < 0 ? HUD.way : HUD.muted;
      put('notch', String(notch), () => {
        RUNGS.forEach((r, i) => {
          const el = rungRefs.current[i];
          if (!el) return;
          const lit = notch === 0 ? r === 0 : notch > 0 ? r > 0 && r <= notch : r < 0 && r >= notch;
          el.style.background = lit ? tint : 'rgba(255,255,255,0.14)';
        });
        if (notchRef.current) {
          notchRef.current.textContent = eb ? 'EB' : notch > 0 ? `P${notch}` : notch < 0 ? `B${-notch}` : 'N';
          notchRef.current.style.color = tint;
        }
        if (notchLabelRef.current) {
          notchLabelRef.current.textContent = eb ? 'EMERGENCY' : notch > 0 ? 'POWER' : notch < 0 ? 'BRAKE' : 'NEUTRAL';
        }
        if (ebRef.current) ebRef.current.style.display = eb ? 'grid' : 'none';
      });

      // ---- speed
      const ink = over ? HUD.hot : due ? HUD.way : pace ? GREEN : INK;
      put('speed', `${Math.round(speed)}|${ink}|${over}`, () => {
        if (!speedRef.current) return;
        speedRef.current.textContent = String(Math.round(speed));
        speedRef.current.style.color = ink;
        speedRef.current.style.animation = over ? 'hud-jitter 90ms steps(2) infinite' : 'none';
      });
      const a = Math.round(accel * 10) / 10;
      put('trend', String(a), () => {
        if (!trendRef.current) return;
        trendRef.current.textContent = `${a > 0.05 ? '▲' : a < -0.05 ? '▼' : '■'} ${a >= 0 ? '+' : ''}${a.toFixed(1)} M/S²`;
        trendRef.current.style.color = a > 0.05 ? HUD.cyan : a < -0.05 ? HUD.way : HUD.faint;
      });
      put('permit', String(Math.round(permit)), () => {
        if (permitRef.current) permitRef.current.textContent = String(Math.round(permit));
        if (permitMarkRef.current) permitMarkRef.current.style.left = `${(permit / top) * 100}%`;
      });
      const state: [string, string, string] = t.railGuard ? ['OVERSPEED · BRAKING', HUD.hot, '#ffffff']
        : over ? ['OVERSPEED', HUD.hot, '#ffffff']
          : due ? ['BRAKE NOW', HUD.way, '#08111a']
            : pace ? ['ON PACE', GREEN, '#08111a']
              : notch === 0 ? ['COASTING', 'rgba(255,255,255,0.12)', HUD.muted]
                : notch > 0 ? ['POWER', 'rgba(79,219,232,0.18)', HUD.cyan]
                  : ['BRAKING', 'rgba(255,176,32,0.18)', HUD.way];
      put('chip', state[0], () => {
        if (!chipRef.current) return;
        chipRef.current.textContent = state[0];
        chipRef.current.style.background = state[1];
        chipRef.current.style.color = state[2];
      });

      // ---- the meter
      const step = top / SEGS;
      const head = Math.floor(speed / step);
      put('meter', `${head}|${Math.round(permit)}|${due}`, () => {
        segRefs.current.forEach((seg, i) => {
          if (!seg) return;
          const k = (i + 0.5) * step;
          const lit = k <= speed;
          const zone = k > permit ? 'red' : k >= permit - PACE ? 'pace' : 'base';
          seg.style.background = lit
            ? (zone === 'red' ? HUD.hot : zone === 'pace' ? GREEN : due ? HUD.way : HUD.cyan)
            : (zone === 'red' ? 'rgba(255,47,110,0.22)' : zone === 'pace' ? 'rgba(60,240,138,0.16)' : 'rgba(255,255,255,0.08)');
          seg.style.boxShadow = lit && i === head ? '0 0 8px #fff' : 'none';
        });
      });
      const target = t.railLimitAheadKph >= 0 && t.railLimitAheadKph < permit ? t.railLimitAheadKph : -1;
      put('target', String(target), () => {
        if (!targetMarkRef.current) return;
        targetMarkRef.current.style.display = target < 0 ? 'none' : 'block';
        targetMarkRef.current.style.left = `${(Math.max(0, target) / top) * 100}%`;
      });

      // ---- a level crossing ahead: the cue for the horn
      const cross = t.railCrossingM >= 0 && t.speedKph > 5 ? Math.round(t.railCrossingM / 10) * 10 : -1;
      put('cross', String(cross), () => {
        if (crossRef.current) crossRef.current.style.display = cross < 0 ? 'none' : 'flex';
        if (crossDistRef.current) crossDistRef.current.textContent = `${cross} M`;
      });

      // ---- next limit and the brake countdown
      const board = t.railLimitAheadKph >= 0 ? t.railLimitAheadKph : Math.floor(t.railLineKph / 5) * 5;
      put('board', String(board), () => {
        if (!boardRef.current) return;
        boardRef.current.textContent = String(board);
        boardRef.current.style.fontSize = board >= 100 ? '11px' : '13px';
      });
      const nextM = t.railLimitAheadM >= 0 ? `${Math.round(t.railLimitAheadM / 10) * 10} M` : 'LINE SPEED';
      put('nextM', nextM, () => { if (nextDistRef.current) nextDistRef.current.textContent = nextM; });
      const brake = t.railBrakeM;
      const cue = brake < 0 ? 'NO BRAKING NEEDED' : brake <= 0.5 ? 'BRAKE NOW' : `BRAKE IN ${Math.round(brake / 10) * 10} M`;
      put('cue', cue, () => {
        const fill = cueFillRef.current;
        const text = cueTextRef.current;
        if (!fill || !text) return;
        text.textContent = cue;
        const colour = brake < 0 ? HUD.faint : brake <= 0.5 ? HUD.hot : HUD.way;
        text.style.color = colour;
        fill.style.background = colour;
        fill.style.transform = `scaleX(${brake < 0 ? 0 : brake <= 0.5 ? 1 : Math.max(0.03, 1 - brake / CUE_FROM)})`;
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry, top]);

  return (
    <div
      className="pointer-events-none absolute bottom-6 left-1/2 origin-bottom -translate-x-1/2 scale-[0.72] md:scale-[0.86] xl:scale-100"
      style={{ animation: 'hud-in 520ms cubic-bezier(0.2, 0.7, 0.2, 1) 280ms both' }}
    >
      {/* Approaching a level crossing: sound the horn. */}
      <div
        ref={crossRef}
        className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 items-center gap-2 whitespace-nowrap px-4 py-[5px]"
        style={{
          background: PANEL, clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
          fontFamily: DISPLAY, fontWeight: 800, fontSize: 13, letterSpacing: '0.14em', color: INK,
        }}
      >
        <span>LEVEL CROSSING</span>
        <span ref={crossDistRef} style={{ fontFamily: NUMERALS, letterSpacing: 0 }}>0 M</span>
        <Key on>N</Key>
        <span>HORN</span>
      </div>
      <div
        className="relative grid h-[84px] w-[720px] items-center"
        style={{
          gridTemplateColumns: '100px 1fr 150px 84px',
          background: PANEL,
          clipPath: 'polygon(13px 0, calc(100% - 13px) 0, 100% 100%, 0 100%)',
        }}
      >
        {/* Controller */}
        <div className="flex h-full min-w-0 items-center gap-[7px] overflow-hidden pl-[22px]">
          <span className="flex flex-none flex-col gap-[1.5px]">
            {RUNGS.map((r, i) => (
              <i
                key={r}
                ref={(el) => { rungRefs.current[i] = el; }}
                className="block h-[2.5px]"
                style={{ width: r === 0 || r === -8 ? 12 : 8, background: 'rgba(255,255,255,0.14)' }}
              />
            ))}
          </span>
          <span className="grid min-w-0 gap-[3px]">
            <span ref={notchRef} className="italic leading-[0.9]" style={{ fontFamily: NUMERALS, fontWeight: 700, fontSize: 21, color: HUD.muted }}>N</span>
            <span ref={notchLabelRef} className="leading-none" style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 8, letterSpacing: '0.14em', color: HUD.faint }}>NEUTRAL</span>
          </span>
        </div>

        {/* Speed */}
        <div className="grid h-full min-w-0 content-center gap-1 px-[13px] pb-[5px] pt-[9px]" style={{ borderInline: `1px solid ${LINE}` }}>
          <div className="flex items-center gap-2">
            <span
              ref={speedRef}
              className="min-w-[3ch] text-right italic leading-[0.85]"
              style={{ fontFamily: NUMERALS, fontWeight: 700, fontSize: 42, fontVariantNumeric: 'tabular-nums', color: INK }}
            >
              0
            </span>
            <span className="grid gap-[3px]">
              <span className="leading-none" style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 9.5, letterSpacing: '0.2em', color: HUD.muted }}>KM/H</span>
              <span ref={trendRef} className="whitespace-nowrap leading-none" style={{ fontFamily: NUMERALS, fontWeight: 600, fontSize: 10, fontVariantNumeric: 'tabular-nums', color: HUD.faint }}>■ +0.0 M/S²</span>
            </span>
            <span className="ml-auto grid justify-items-end gap-[3px]">
              <span className="leading-none" style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 8.5, letterSpacing: '0.12em', color: HUD.faint }}>
                MAX<b ref={permitRef} className="ml-1" style={{ fontFamily: NUMERALS, fontSize: 14, color: INK, letterSpacing: 0 }}>0</b>
              </span>
              <span
                ref={chipRef}
                className="whitespace-nowrap rounded-[2px] leading-none"
                style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 9, letterSpacing: '0.14em', padding: '2px 6px' }}
              >
                COASTING
              </span>
            </span>
          </div>
          <div className="relative pt-[7px]">
            <div className="flex h-[8px] gap-px">
              {Array.from({ length: SEGS }, (_, i) => (
                <i
                  key={i}
                  ref={(el) => { segRefs.current[i] = el; }}
                  className="block flex-1"
                  style={{ transform: 'skewX(-18deg)', background: 'rgba(255,255,255,0.08)' }}
                />
              ))}
            </div>
            <span
              ref={targetMarkRef}
              className="absolute top-0 hidden h-0 w-0 -translate-x-1/2"
              style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `6px solid ${HUD.way}` }}
            />
            <span
              ref={permitMarkRef}
              className="absolute top-[3px] h-[15px] w-[2px] -translate-x-1/2"
              style={{ left: '100%', background: INK, boxShadow: '0 0 6px rgba(255,255,255,0.7)', transition: 'left 160ms linear' }}
            />
          </div>
          <div className="flex justify-between leading-none" style={{ fontFamily: NUMERALS, fontSize: 7.5, fontWeight: 600, color: HUD.faint }}>
            {scale.map((k) => <span key={k}>{k}</span>)}
          </div>
        </div>

        {/* Next limit */}
        <div className="flex h-full min-w-0 items-center gap-2 pl-[11px] pr-[14px]">
          <span
            ref={boardRef}
            className="grid h-8 w-8 flex-none place-items-center rounded-full"
            style={{ background: '#fff', border: '3.5px solid #e8183c', color: '#0a0d12', fontFamily: NUMERALS, fontWeight: 700, fontSize: 12 }}
          >
            0
          </span>
          <span className="grid min-w-0 flex-1 gap-1">
            <span ref={nextDistRef} className="leading-none" style={{ fontFamily: NUMERALS, fontSize: 15, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>—</span>
            <span className="relative h-[3px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.12)' }}>
              <i ref={cueFillRef} className="absolute inset-0 block origin-left" style={{ transform: 'scaleX(0)' }} />
            </span>
            <span ref={cueTextRef} className="whitespace-nowrap leading-none" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 9, letterSpacing: '0.08em', color: HUD.faint }}>
              NO BRAKING NEEDED
            </span>
          </span>
        </div>

        {/* Horn and view */}
        <HornAndView cameraMode={cameraMode} />

        <div
          ref={ebRef}
          className="absolute inset-0 hidden place-items-center"
          style={{
            background: 'rgba(255,47,110,0.9)', fontFamily: DISPLAY, fontWeight: 800, fontSize: 18, letterSpacing: '0.24em', color: '#fff',
            animation: 'hud-eb 600ms steps(2) infinite',
          }}
        >
          EMERGENCY BRAKE
        </div>
      </div>
    </div>
  );
}

/** Two rows: the horn (N, held) and the view (C), each an icon and its key. */
function HornAndView({ cameraMode }: { cameraMode: CameraMode }) {
  const [horn, setHorn] = useState(false);
  const index = RAIL_CAMERA_MODES.indexOf(cameraMode);

  // Lit while N is down, whichever way it was pressed.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'KeyN') setHorn(true); };
    const up = (e: KeyboardEvent) => { if (e.code === 'KeyN') setHorn(false); };
    const blur = () => setHorn(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const release = () => { if (horn) key('keyup', 'KeyN', 'n'); };
  const row = 'pointer-events-auto relative grid h-full grid-cols-[1fr_auto] items-center gap-1.5 overflow-hidden rounded-[3px] pl-2 pr-[3px] transition-colors';
  return (
    <div className="grid h-full grid-rows-2 gap-[3px] py-[18px] pl-[7px] pr-[18px]" style={{ borderLeft: `1px solid ${LINE}` }}>
        <button
          type="button"
          title="Horn · hold N"
          aria-label="Horn, hold N"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={() => key('keydown', 'KeyN', 'n')}
          onPointerUp={release}
          onPointerLeave={release}
          onPointerCancel={release}
          className={row}
          style={{
            background: horn ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)',
            boxShadow: `inset 0 0 0 1px ${horn ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.07)'}`,
            color: horn ? INK : HUD.muted,
          }}
        >
          <svg viewBox="0 0 24 16" width="21" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
            <path d="M1.5 6.6h4.2C9.4 6.6 12.6 4.6 15.2 2.4v11.2C12.6 11.4 9.4 9.4 5.7 9.4H1.5z" fill="currentColor" fillOpacity="0.3" />
            <ellipse cx="15.2" cy="8" rx="1.4" ry="5.6" fill="currentColor" fillOpacity="0.15" />
            <path d="M5 9.4v3.2M3 12.6h4.2" />
            <path d="M18.6 5.6a3.6 3.6 0 0 1 0 4.8" style={{ opacity: horn ? 1 : 0, animation: horn ? 'hud-ring 520ms ease-out infinite' : 'none' }} />
            <path d="M20.8 3.6a6.6 6.6 0 0 1 0 8.8" style={{ opacity: horn ? 1 : 0, animation: horn ? 'hud-ring 520ms ease-out 260ms infinite' : 'none' }} />
          </svg>
          <Key on={horn}>N</Key>
        </button>
        <button
          type="button"
          title={`View · ${VIEW_NAME[cameraMode] ?? cameraMode.toUpperCase()} · C`}
          aria-label="Change view, C"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { key('keydown', 'KeyC', 'c'); key('keyup', 'KeyC', 'c'); }}
          className={`${row} hover:bg-white/10`}
          style={{ background: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)', color: HUD.muted }}
        >
          <svg viewBox="0 0 24 16" width="21" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3.5" width="12" height="9" rx="1.5" fill="currentColor" fillOpacity="0.15" />
            <path d="M15 7l5.5-2.8v7.6L15 9" />
          </svg>
          <Key on={false}>C</Key>
          {/* Where this view is in the cycle. */}
          <span className="absolute inset-x-1.5 bottom-[2px] flex gap-0.5">
            {RAIL_CAMERA_MODES.map((m, i) => (
              <i key={m} className="block h-[1.5px] flex-1" style={{ background: i === index ? INK : 'rgba(255,255,255,0.12)' }} />
            ))}
          </span>
        </button>
    </div>
  );
}

function Key({ on, children }: { on: boolean; children: string }) {
  return (
    <span
      className="grid h-[15px] min-w-[15px] place-items-center rounded-[3px]"
      style={{
        background: on ? INK : 'rgba(255,255,255,0.12)', color: on ? '#08111a' : INK,
        fontFamily: DISPLAY, fontWeight: 800, fontSize: 10, transform: on ? 'translateY(1px)' : 'none',
      }}
    >
      {children}
    </span>
  );
}

/**
 * The new view's name, in the middle of the screen for a moment after C. Its
 * own component at the HUD's root, because inside the scaled console a fixed
 * element is fixed to the console, not the screen.
 */
export function ViewToast({ cameraMode }: { cameraMode: CameraMode }) {
  const [toast, setToast] = useState<{ name: string; seq: number } | null>(null);
  const shown = useRef(cameraMode);
  const seq = useRef(0);
  // A new view is named in the middle of the screen for a moment.
  useEffect(() => {
    if (shown.current === cameraMode) return;
    shown.current = cameraMode;
    seq.current += 1;
    const name = VIEW_NAME[cameraMode] ?? cameraMode.toUpperCase();
    // Deferred a frame: the toast is a reaction to the change, not part of it.
    const raf = requestAnimationFrame(() => setToast({ name, seq: seq.current }));
    const timer = window.setTimeout(() => setToast(null), 1000);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [cameraMode]);

  if (!toast) return null;
  return (
        <div
          key={toast.seq}
          className="pointer-events-none absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 italic"
          style={{
            fontFamily: DISPLAY, fontWeight: 800, fontSize: 34, letterSpacing: '0.06em', color: INK,
            textShadow: '0 2px 12px rgba(0,0,0,0.6)', animation: 'hud-toast 900ms ease-out both',
          }}
        >
          {toast.name}
        </div>
  );
}
