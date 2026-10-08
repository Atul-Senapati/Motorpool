'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Bike, CarFront, Drone, Gauge, Helicopter, Ship, TrainFront, Truck, type LucideIcon,
} from 'lucide-react';
import { CATEGORIES, SELECTED, SWITCHABLE, type GarageVehicle, type VehicleCategory } from '@/config/garage';
import { barlowCondensed } from './garageFonts';
import { cachedThumb } from './GarageThumbs';
import { ACCENT, HUD, NUM, ON_ACCENT, PANEL_CUT, accentAlpha } from './hudTheme';
import { useUi } from '@/hooks/useUiSound';

const GarageThumbs = dynamic(() => import('./GarageThumbs'), { ssr: false });

/**
 * The vehicle wheel: switch vehicle mid-drive, the way GTA V switches weapons.
 *
 * **One gesture.** Hold Tab, point at a vehicle, let go. Every switchable
 * vehicle has its own slice of the ring — grouped by the garage's shelves,
 * which are named round the outside — so the direction of the mouse is the
 * whole choice. No shelf-then-vehicle step, no keys to learn: an earlier
 * version put one shelf per segment and turned through it with Q / E, and that
 * second step was the part nobody found. The scroll wheel and the arrow keys
 * (or A / D) step one slice either way, for a keyboard or a trackpad. A click
 * takes a slice at once; Esc, or letting go on the vehicle you already have,
 * changes nothing.
 *
 * Each slice wears the vehicle's garage photo in a disc (`GarageThumbs`,
 * cached per browser), or its shelf's icon until it has one; a vehicle with no
 * photo is shot once the pointer rests on it, which loads that model — the one
 * you are about to switch to anyway. Beside the ring a card gives the
 * pointed-at vehicle's photo and figures.
 *
 * One colour: the HUD's cyan `ACCENT`, as everywhere else in the drive.
 *
 * Trains, the tram and the boats are not on it (`isSwitchable`): they need a
 * track or water under them.
 */

/** The ring's own drawing units; the element scales to fit the screen. */
const SIZE = 540;
const R_OUT = 222;
const R_IN = 104;
/** Where the photo discs sit, and how big. */
const R_DISC = (R_OUT + R_IN) / 2;
const DISC = 50;
/** How far the pointed-at slice stands out from the ring. */
const LIFT = 10;
/** Pointer must rest this long on a vehicle with no photo before it is shot. */
const SETTLE_MS = 260;

const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const SHELF_ICON: Record<VehicleCategory, LucideIcon> = {
  performance: Gauge,
  street: CarFront,
  utility: Truck,
  bike: Bike,
  rail: TrainFront,
  marine: Ship,
  air: Drone,
};
const iconFor = (v: GarageVehicle): LucideIcon => (v.air === 'helicopter' ? Helicopter : SHELF_ICON[v.category]);

/** Every vehicle on the wheel, shelf by shelf in the garage's order. */
const ITEMS: GarageVehicle[] = CATEGORIES.flatMap((c) => SWITCHABLE.filter((v) => v.category === c.id));
/** The shelves, as runs of `ITEMS`. */
const SHELVES = CATEGORIES
  .map((c) => {
    const first = ITEMS.findIndex((v) => v.category === c.id);
    const count = ITEMS.filter((v) => v.category === c.id).length;
    return { id: c.id, label: c.label, first, count };
  })
  .filter((s) => s.count > 0);

/** The roster's spread, for the card's bars. */
const SPREAD = (() => {
  const of = (f: (v: GarageVehicle) => number) => {
    const xs = SWITCHABLE.map(f).filter((x) => x > 0);
    return [Math.min(...xs), Math.max(...xs)] as const;
  };
  return { speed: of((v) => v.topSpeedKph), accel: of((v) => v.accel), mass: of((v) => Math.log(v.mass)) };
})();
const bar = (x: number, [lo, hi]: readonly [number, number]) =>
  (hi > lo ? 0.08 + 0.92 * Math.max(0, Math.min(1, (x - lo) / (hi - lo))) : 1);

const DRIVE: Record<GarageVehicle['drive'], string> = {
  rwd: 'REAR-WHEEL', awd: 'ALL-WHEEL', rail: 'RAIL', screw: 'PROPELLER', rotor: 'ROTOR',
};

const KEYFRAMES = `
@keyframes vw-in { from { opacity: 0; transform: scale(0.9) rotate(-6deg); } to { opacity: 1; transform: none; } }
@keyframes vw-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes vw-card { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
@keyframes vw-spin { to { transform: rotate(360deg); } }
@keyframes vw-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
`;

export function VehicleWheel({
  enabled, onOpenChange, onPick,
}: {
  /** False while a menu is up, or in a vehicle that cannot be switched out of. */
  enabled: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (vehicle: GarageVehicle) => void;
}) {
  const ui = useUi();
  const n = ITEMS.length;

  const [open, setOpen] = useState(false);
  /** The pointed-at slice, an index into `ITEMS`. */
  const [hover, setHover] = useState(0);
  const state = useRef({ open, hover });
  useEffect(() => { state.current = { open, hover }; }, [open, hover]);
  const ring = useRef<HTMLDivElement>(null);

  /** Photos known so far, by vehicle id. */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const onShot = useCallback((id: string, url: string) => {
    setThumbs((t) => (t[id] === url ? t : { ...t, [id]: url }));
  }, []);
  /** The vehicle the pointer has rested on, for shooting a missing photo. */
  const [settled, setSettled] = useState<GarageVehicle | null>(null);

  const show = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange(next);
    if (!next) setSettled(null);
  }, [onOpenChange]);

  /** Open pointing at the vehicle you are driving. */
  const openWheel = useCallback(() => {
    setHover(Math.max(0, ITEMS.findIndex((v) => v.id === SELECTED.id)));
    // Every photo already in the cache, at once — no flash of placeholders.
    const known: Record<string, string> = {};
    for (const v of ITEMS) {
      const url = cachedThumb(v.id);
      if (url) known[v.id] = url;
    }
    setThumbs((t) => ({ ...known, ...t }));
    ui('select');
    show(true);
  }, [show, ui]);

  /** Close, switching to the pointed-at vehicle if it is not the current one. */
  const commit = useCallback((index?: number) => {
    const pick = ITEMS[index ?? state.current.hover];
    show(false);
    if (pick && pick.id !== SELECTED.id) {
      ui('select');
      onPick(pick);
    } else {
      ui('back');
    }
  }, [show, onPick, ui]);

  const point = useCallback((index: number) => {
    const i = ((index % n) + n) % n;
    if (i === state.current.hover) return;
    ui('hover');
    setHover(i);
  }, [n, ui]);

  useEffect(() => {
    if (!enabled) {
      if (state.current.open) show(false);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        if (!e.repeat && !state.current.open) openWheel();
        return;
      }
      if (!state.current.open) return;
      // While the wheel is up its keys are its own: an arrow pressed to step
      // round must not also be a held brake when the drive resumes.
      e.stopPropagation();
      if (e.code === 'Escape') { show(false); ui('back'); return; }
      const step = { ArrowRight: 1, KeyD: 1, ArrowDown: 1, KeyS: 1, ArrowLeft: -1, KeyA: -1, ArrowUp: -1, KeyW: -1 }[e.code];
      if (step) point(state.current.hover + step);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Tab' && state.current.open) { e.preventDefault(); commit(); }
    };
    const onMove = (e: MouseEvent) => {
      const box = ring.current?.getBoundingClientRect();
      if (!state.current.open || !box) return;
      const dx = e.clientX - (box.left + box.width / 2);
      const dy = e.clientY - (box.top + box.height / 2);
      // Resting in the hub keeps the last choice, so the hand can relax.
      if (Math.hypot(dx, dy) < (R_IN * 0.7 * box.width) / SIZE) return;
      // Clockwise from straight up, each slice centred on its direction.
      const seg = (Math.PI * 2) / n;
      const angle = (Math.atan2(dx, -dy) + Math.PI * 2 + seg / 2) % (Math.PI * 2);
      point(Math.floor(angle / seg));
    };
    const onWheel = (e: WheelEvent) => {
      if (!state.current.open || Math.abs(e.deltaY) < 4) return;
      point(state.current.hover + (e.deltaY > 0 ? 1 : -1));
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('wheel', onWheel);
    };
  }, [enabled, n, openWheel, commit, point, show, ui]);

  const pick = ITEMS[hover];

  // A vehicle with no photo yet is shot once the pointer rests on it.
  useEffect(() => {
    if (!open || !pick || thumbs[pick.id]) return;
    const timer = window.setTimeout(() => setSettled(pick), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open, pick, thumbs]);

  if (!open || !pick) return null;

  const seg = (Math.PI * 2) / n;
  const c = SIZE / 2;
  const at = (a: number, r: number) => [c + Math.sin(a) * r, c - Math.cos(a) * r] as const;
  const arc = (a0: number, a1: number, r0: number, r1: number) => {
    const [x0, y0] = at(a0, r1);
    const [x1, y1] = at(a1, r1);
    const [x2, y2] = at(a1, r0);
    const [x3, y3] = at(a0, r0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`;
  };
  const gap = 0.012;
  const slice = (i: number) => arc(i * seg - seg / 2 + gap, i * seg + seg / 2 - gap, R_IN, R_OUT);
  /** The lit band along the pointed-at slice's outer edge. */
  const rim = (i: number) => arc(i * seg - seg / 2 + gap, i * seg + seg / 2 - gap, R_OUT + 5, R_OUT + 10);
  const pct = (v: number) => `${(v / SIZE) * 100}%`;
  const lift = (i: number) => (i === hover ? [Math.sin(i * seg) * LIFT, -Math.cos(i * seg) * LIFT] : [0, 0]);
  const driving = pick.id === SELECTED.id;
  const picture = thumbs[pick.id];
  const shelfOfPick = pick.category;

  return (
    <div
      className={`${barlowCondensed.variable} pointer-events-auto absolute inset-0 z-30 flex select-none items-center justify-center gap-10 px-4`}
      style={{
        background: 'radial-gradient(circle at 50% 50%, rgba(4,8,13,0.42), rgba(4,8,13,0.86) 70%)',
        animation: 'vw-fade 160ms ease-out',
      }}
    >
      <style>{KEYFRAMES}</style>

      {/* The ring. */}
      <div
        ref={ring}
        className="relative shrink-0"
        style={{ width: `min(${SIZE}px, 92vw, 78vh)`, aspectRatio: '1', animation: 'vw-in 220ms cubic-bezier(.2,.9,.3,1.2)' }}
      >
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 h-full w-full overflow-visible">
          <defs>
            <radialGradient id="vw-seg" cx={c} cy={c} r={R_OUT} gradientUnits="userSpaceOnUse">
              <stop offset={R_IN / R_OUT} stopColor="rgba(10,16,24,0.92)" />
              <stop offset="1" stopColor="rgba(16,24,34,0.82)" />
            </radialGradient>
            <radialGradient id="vw-on" cx={c} cy={c} r={R_OUT} gradientUnits="userSpaceOnUse">
              <stop offset={R_IN / R_OUT} stopColor={accentAlpha(0.06)} />
              <stop offset="1" stopColor={accentAlpha(0.36)} />
            </radialGradient>
            <filter id="vw-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Each shelf's band round the outside: lit when the pointer is on it. */}
          {SHELVES.map((s) => {
            const a0 = s.first * seg - seg / 2 + 0.03;
            const a1 = (s.first + s.count) * seg - seg / 2 - 0.03;
            const on = s.id === shelfOfPick;
            return (
              <path
                key={s.id}
                d={arc(a0, a1, R_OUT + 16, R_OUT + 19)}
                fill={on ? accentAlpha(0.85) : 'rgba(255,255,255,0.18)'}
                style={{ transition: 'fill 140ms' }}
              />
            );
          })}

          {ITEMS.map((v, i) => {
            const active = i === hover;
            const [dx, dy] = lift(i);
            return (
              <g
                key={v.id}
                style={{
                  transform: `translate(${dx}px, ${dy}px)`,
                  transition: 'transform 140ms cubic-bezier(.2,.9,.3,1.3)',
                }}
              >
                <path
                  d={slice(i)}
                  fill={active ? 'url(#vw-on)' : 'url(#vw-seg)'}
                  stroke={active ? ACCENT : 'rgba(255,255,255,0.08)'}
                  strokeWidth={active ? 1.5 : 1}
                  style={{ cursor: 'pointer', transition: 'fill 120ms, stroke 120ms' }}
                  onMouseEnter={() => point(i)}
                  onClick={() => commit(i)}
                />
                {active && <path d={rim(i)} fill={ACCENT} filter="url(#vw-glow)" pointerEvents="none" />}
              </g>
            );
          })}

          {/* The hub: a slow turning scale inside a hairline. */}
          <circle cx={c} cy={c} r={R_IN - 8} fill="rgba(5,9,14,0.94)" stroke={accentAlpha(0.35)} strokeWidth={1} />
          <g style={{ transformOrigin: `${c}px ${c}px`, animation: 'vw-spin 14s linear infinite' }}>
            <circle
              cx={c} cy={c} r={R_IN - 15} fill="none" stroke={accentAlpha(0.5)} strokeWidth={2}
              strokeDasharray="2 9"
            />
          </g>
          {/* A pointer from the hub towards the chosen slice. */}
          <g transform={`rotate(${(hover * 360) / n} ${c} ${c})`}>
            <path
              d={`M${c - 7},${c - (R_IN - 22)} L${c},${c - (R_IN - 11)} L${c + 7},${c - (R_IN - 22)} Z`}
              fill={ACCENT} filter="url(#vw-glow)"
            />
          </g>
        </svg>

        {/* Shelf names, outside the ring at the middle of each shelf. */}
        {SHELVES.map((s) => {
          const mid = (s.first + (s.count - 1) / 2) * seg;
          const [x, y] = at(mid, R_OUT + 36);
          const on = s.id === shelfOfPick;
          return (
            <span
              key={s.id}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
              style={{
                left: pct(x), top: pct(y), ...DISPLAY, fontSize: 11, fontWeight: 800, letterSpacing: '0.26em',
                color: on ? ACCENT : HUD.faint, transition: 'color 140ms',
              }}
            >
              {s.label}
            </span>
          );
        })}

        {/* A photo disc on every slice. */}
        {ITEMS.map((v, i) => {
          const active = i === hover;
          const [dx, dy] = lift(i);
          const [x, y] = at(i * seg, R_DISC);
          const url = thumbs[v.id];
          const Icon = iconFor(v);
          return (
            <div
              key={v.id}
              className="pointer-events-none absolute flex items-center justify-center overflow-hidden rounded-full"
              style={{
                left: pct(x + dx), top: pct(y + dy), width: pct(DISC), height: pct(DISC),
                transform: `translate(-50%, -50%) scale(${active ? 1.22 : 1})`,
                transition: 'transform 140ms cubic-bezier(.2,.9,.3,1.3), left 140ms, top 140ms, box-shadow 140ms',
                background: url ? '#eef1f5' : 'rgba(255,255,255,0.04)',
                boxShadow: active
                  ? `0 0 0 2px ${ACCENT}, 0 0 18px ${accentAlpha(0.6)}`
                  : `0 0 0 1px ${v.id === SELECTED.id ? accentAlpha(0.7) : 'rgba(255,255,255,0.16)'}`,
                opacity: active ? 1 : 0.82,
              }}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data URL from the thumbnail cache
                <img src={url} alt="" className="h-full w-full object-cover" style={{ transform: 'scale(1.6)' }} />
              ) : (
                <Icon size={20} strokeWidth={2.2} absoluteStrokeWidth color={active ? ACCENT : HUD.faint} aria-hidden />
              )}
            </div>
          );
        })}

        {/* The hub: what letting go of Tab would put you in. */}
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center"
          style={{ width: pct(R_IN * 1.55) }}
        >
          <span
            style={{
              ...DISPLAY, fontSize: 10, letterSpacing: '0.32em', fontWeight: 700,
              color: driving ? HUD.faint : ACCENT,
              animation: driving ? 'none' : 'vw-pulse 1.4s ease-in-out infinite',
            }}
          >
            {driving ? 'DRIVING' : 'SWITCH TO'}
          </span>
          <span style={{ ...DISPLAY, fontSize: 20, fontWeight: 800, fontStyle: 'italic', color: '#fff', lineHeight: 1, marginTop: 3 }}>
            {pick.label.toUpperCase()}
          </span>
          <span style={{ ...NUM, fontSize: 11, color: HUD.muted, marginTop: 4 }}>
            {pick.year}
          </span>
        </div>
      </div>

      {/* The card: the pointed-at vehicle's photo and figures. Wide screens only. */}
      <div
        key={pick.id}
        className="hidden shrink-0 md:block"
        style={{ width: 300, animation: 'vw-card 200ms ease-out' }}
      >
        <div
          className="relative overflow-hidden"
          style={{
            height: 169, clipPath: PANEL_CUT,
            background: picture ? '#f4f6fa' : 'linear-gradient(135deg, rgba(16,24,34,0.95), rgba(8,12,18,0.95))',
          }}
        >
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL from the thumbnail cache
            <img src={picture} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              {(() => {
                const Icon = iconFor(pick);
                return (
                  <Icon
                    size={54} strokeWidth={1.6} absoluteStrokeWidth color={accentAlpha(0.45)}
                    style={{ animation: 'vw-pulse 1.2s ease-in-out infinite' }} aria-hidden
                  />
                );
              })()}
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-1" style={{ background: ACCENT, boxShadow: `0 0 14px ${ACCENT}` }} />
        </div>

        <div
          className="mt-2 px-5 py-4"
          style={{
            clipPath: PANEL_CUT,
            background: 'linear-gradient(90deg, rgba(3,7,12,0.88), rgba(3,7,12,0.7))',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span style={{ ...DISPLAY, fontSize: 22, fontWeight: 800, fontStyle: 'italic', color: '#fff', lineHeight: 1 }}>
              {pick.label.toUpperCase()}
            </span>
            {driving && (
              <span
                style={{
                  ...DISPLAY, fontSize: 10, fontWeight: 800, letterSpacing: '0.2em', padding: '2px 6px',
                  background: ACCENT, color: ON_ACCENT,
                }}
              >
                CURRENT
              </span>
            )}
          </div>
          {pick.blurb && (
            <p style={{ fontSize: 12, lineHeight: 1.35, color: HUD.muted, marginTop: 6 }}>{pick.blurb}</p>
          )}
          <div className="mt-3 flex flex-col gap-2">
            <Stat label="TOP SPEED" value={`${pick.topSpeedKph} KM/H`} fill={bar(pick.topSpeedKph, SPREAD.speed)} />
            <Stat label="ACCELERATION" value={`${Math.round(pick.accel * 100)}`} fill={bar(pick.accel, SPREAD.accel)} />
            <Stat
              label="WEIGHT" value={`${(pick.mass / 1000).toFixed(pick.mass < 10000 ? 2 : 1)} T`}
              fill={bar(Math.log(pick.mass), SPREAD.mass)}
            />
          </div>
          <div className="mt-3 flex justify-between" style={{ ...DISPLAY, fontSize: 11, letterSpacing: '0.18em', fontWeight: 700 }}>
            <span style={{ color: HUD.faint }}>DRIVE</span>
            <span style={{ color: HUD.muted }}>{DRIVE[pick.drive]}</span>
          </div>
        </div>
      </div>

      <div
        className="absolute bottom-[6vh] left-1/2 flex -translate-x-1/2 flex-wrap justify-center gap-x-6 gap-y-2"
        style={{ ...DISPLAY, fontSize: 11, letterSpacing: '0.2em', color: HUD.muted, fontWeight: 700 }}
      >
        <Hint keys="MOUSE" text="POINT AT A VEHICLE" />
        <Hint keys="TAB" text="LET GO TO DRIVE IT" />
        <Hint keys="ESC" text="CANCEL" />
      </div>

      {/* Shoots the rested-on vehicle's photo, if it had none. Off screen. */}
      {settled && !thumbs[settled.id] && (
        <GarageThumbs key={settled.id} vehicles={[settled]} focusedId={settled.id} onShot={onShot} />
      )}
    </div>
  );
}

function Stat({ label, value, fill }: { label: string; value: string; fill: number }) {
  return (
    <div>
      <div className="flex justify-between" style={{ ...DISPLAY, fontSize: 11, letterSpacing: '0.18em', fontWeight: 700 }}>
        <span style={{ color: HUD.faint }}>{label}</span>
        <span style={{ ...NUM, color: '#fff', letterSpacing: '0.06em' }}>{value}</span>
      </div>
      <div className="mt-1 h-[3px] w-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
        <div
          className="h-full"
          style={{
            width: `${fill * 100}%`, background: ACCENT, boxShadow: `0 0 8px ${accentAlpha(0.6)}`,
            transition: 'width 220ms cubic-bezier(.2,.9,.3,1)',
          }}
        />
      </div>
    </div>
  );
}

function Hint({ keys, text }: { keys: string; text: string }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span
        style={{
          padding: '1px 6px', border: `1px solid ${accentAlpha(0.6)}`, color: ACCENT, fontSize: 10, letterSpacing: '0.12em',
        }}
      >
        {keys}
      </span>
      {text}
    </span>
  );
}
