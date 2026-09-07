'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  CAR_PARAM, CATEGORIES, GARAGE, classFor, lastVehicleId, ratingsFor, rememberVehicle,
  type GarageVehicle, type VehicleCategory,
} from '@/config/garage';
import { useGarageAudio } from '@/hooks/useGarageAudio';
import { Logo } from './Logo';
import { barlow, barlowCondensed } from './garageFonts';
import { DISPLAY, RAISED, THEME } from './garageTheme';

/** Both touch WebGL during render, so neither may run on the server. */
const GarageStage = dynamic(() => import('./GarageStage').then((m) => m.GarageStage), { ssr: false });
const GarageThumbs = dynamic(() => import('./GarageThumbs'), { ssr: false });

const subscribeNever = () => () => {};

/**
 * Vehicle picker.
 *
 * Choosing a vehicle sets `?car=<id>` and reloads rather than handing the id down
 * as state — `vehicleConfig` freezes one vehicle's numbers into module constants
 * that the physics, cameras and HUD read directly (see `garage.ts`), so a fresh
 * page is the honest way to swap them.
 *
 * Laid out as a **fixed grid**: a 76 px header, the stage, a 176 px footer, and
 * every overlay box given explicit dimensions. That is not fussiness — the
 * previous version was absolutely positioned and content-sized, and switching
 * vehicle moved the whole screen: a longer blurb pushed the title up, a shorter
 * name changed a card's height, a conditional row appeared and vanished. Nothing
 * here can change size when the data does.
 */
export function GarageScreen({ onPick }: { onPick: (vehicle: GarageVehicle) => void }) {
  const remembered = useSyncExternalStore(subscribeNever, lastVehicleId, () => null);
  const opening = useMemo(() => GARAGE.find((v) => v.id === remembered) ?? GARAGE[0], [remembered]);

  const [chosenCategory, setChosenCategory] = useState<VehicleCategory | 'all'>('all');
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [readyId, setReadyId] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const { muted, toggleMuted, playClick, playConfirm } = useGarageAudio();

  const shelves = useMemo(() => CATEGORIES.filter((c) => GARAGE.some((v) => v.category === c.id)), []);
  const roster = useMemo(
    () => (chosenCategory === 'all' ? GARAGE : GARAGE.filter((v) => v.category === chosenCategory)),
    [chosenCategory],
  );
  const focused = roster.find((v) => v.id === (chosenId ?? opening.id)) ?? roster[0] ?? GARAGE[0];
  const loading = readyId !== focused.id;
  const index = Math.max(0, roster.findIndex((v) => v.id === focused.id));

  const step = useCallback((by: number) => {
    if (roster.length < 2) return;
    playClick();
    setChosenId(roster[(index + by + roster.length) % roster.length].id);
  }, [index, playClick, roster]);

  const openShelf = useCallback((id: VehicleCategory | 'all') => {
    playClick();
    setChosenCategory(id);
    const first = id === 'all' ? GARAGE[0] : GARAGE.find((v) => v.category === id);
    if (first && !(id === 'all' || focused.category === id)) setChosenId(first.id);
  }, [focused.category, playClick]);

  const pickVehicle = useCallback((id: string) => { playClick(); setChosenId(id); }, [playClick]);

  const launch = useCallback((v: GarageVehicle) => {
    playConfirm();
    rememberVehicle(v.id);
    onPick(v);
  }, [onPick, playConfirm]);

  const onShot = useCallback((id: string, url: string) => {
    setThumbs((t) => (t[id] === url ? t : { ...t, [id]: url }));
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.code === 'Enter') { e.preventDefault(); launch(focused); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused, launch, step]);

  const r = ratingsFor(focused);
  const pad2 = (n: number) => String(n).padStart(2, '0');

  return (
    <div
      className={`${barlow.variable} ${barlowCondensed.variable} grid h-dvh w-full grid-cols-[minmax(0,1fr)] grid-rows-[76px_1fr_176px] overflow-hidden select-none`}
      style={{ fontFamily: 'var(--font-ui)', color: THEME.text, background: THEME.ink }}
    >
      <GarageThumbs vehicles={GARAGE} onShot={onShot} />

      {/* ================= header ================= */}
      {/* `min-w-0` everywhere it matters: a flex row of non-wrapping labels
          otherwise reports an intrinsic width wider than the viewport, and with
          an unconstrained grid column that width became the page's — which is
          how the spec panel and the right arrow ended up off-screen and the
          turntable drifted right. */}
      <header className="relative z-20 flex min-w-0 items-stretch overflow-hidden" style={{ background: 'linear-gradient(180deg, #ffffff, #f2f5f9)', boxShadow: '0 1px 0 rgba(11,18,32,0.08), 0 10px 28px rgba(11,18,32,0.10)' }}>
        <div className="garage-stripes absolute inset-0 opacity-[0.06]" aria-hidden />
        {/* Wordmark plate, cut at an angle. */}
        <div
          className="relative flex shrink-0 items-center gap-4 pl-6 pr-12 sm:pl-8 sm:pr-14"
          style={{ background: `linear-gradient(180deg, ${THEME.accentHi}, ${THEME.accent})`, clipPath: 'polygon(0 0, 100% 0, calc(100% - 28px) 100%, 0 100%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45)' }}
        >
          <Logo height={30} tone="accent" className="shrink-0 drop-shadow-[0_2px_6px_rgba(6,26,90,0.45)]" />
          <span className="text-[26px] font-extrabold italic leading-none tracking-[0.04em]" style={{ ...DISPLAY, color: '#ffffff' }}>MOTORPOOL</span>
          <span className="h-6 w-px" style={{ background: 'rgba(255,255,255,0.45)' }} />
          <span className="text-[12px] font-bold tracking-[0.34em]" style={{ color: 'rgba(255,255,255,0.85)' }}>GARAGE</span>
        </div>

        {/* Category tabs: raised, skewed, one lit. */}
        <nav className="relative ml-4 flex min-w-0 items-center gap-1.5 overflow-x-auto pr-2 [scrollbar-width:none] sm:ml-6">
          <Tab label="ALL" active={chosenCategory === 'all'} onClick={() => openShelf('all')} />
          {shelves.map((s) => (
            <Tab key={s.id} label={s.label} active={chosenCategory === s.id} onClick={() => openShelf(s.id)} />
          ))}
        </nav>

        {/* Counter: fixed width so 01/08 and 01/01 occupy identical space. */}
        <div className="relative ml-auto flex shrink-0 items-center gap-2 pr-6 sm:gap-3 sm:pr-8">
          <MuteButton muted={muted} onClick={toggleMuted} />
          <div className="flex h-10 w-[112px] items-center justify-center rounded-sm" style={RAISED}>
            <span className="text-[20px] font-bold tabular-nums tracking-[0.1em]" style={DISPLAY}>
              <span>{pad2(index + 1)}</span><span className="mx-1.5" style={{ color: THEME.muted }}>/</span><span style={{ color: THEME.muted }}>{pad2(roster.length)}</span>
            </span>
          </div>
        </div>
      </header>

      {/* ================= stage ================= */}
      <div className="relative min-h-0">
        <GarageStage vehicle={focused} onReady={setReadyId} />
        <div className="garage-grain" aria-hidden />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 90% 75% at 50% 48%, transparent 55%, rgba(11,18,32,0.10) 100%)' }} />

        {/* Name plate — fixed box, two lines reserved, text scaled to fit. */}
        <div className="pointer-events-none absolute left-8 top-6 w-[min(46vw,520px)]">
          <div className="flex h-[22px] items-center gap-3 text-[11px] font-bold tracking-[0.3em]" style={{ color: THEME.muted }}>
            <span className="tabular-nums">{focused.year}</span>
            <span className="h-px w-6" style={{ background: THEME.line }} />
            <span style={{ color: THEME.accent }}>{CATEGORIES.find((c) => c.id === focused.category)?.label}</span>
          </div>
          <h2
            className="mt-1 h-[2.1em] overflow-hidden font-extrabold italic leading-[1.0] tracking-[-0.01em] drop-shadow-[0_4px_14px_rgba(11,18,32,0.18)]"
            style={{ ...DISPLAY, fontSize: 'clamp(40px, 5.2vw, 76px)' }}
          >
            {focused.label}
          </h2>
          <p className="mt-2 h-[44px] overflow-hidden text-[13px] leading-[22px]" style={{ color: THEME.muted, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {focused.blurb}
          </p>
        </div>

        {/* Class shield. */}
        <Shield letter={classFor(focused)} />

        {/*
          Spec panel — fixed width, fixed row heights, tabular numerals.

          Frosted rather than solid: the camera now frames every vehicle at
          the same fraction of frame width (see garageStudio.ts), so which
          vehicles the panel overlaps is no longer arbitrary — it is roughly
          the same right-hand sliver for all of them. A translucent panel
          with the stage blurred behind it reads as a HUD sitting over the
          scene, which is the honest description of what it is; a solid card
          read as a wall the vehicle was hiding behind.
        */}
        <aside
          className="pointer-events-none absolute right-6 top-6 w-[200px] rounded-sm p-3.5 backdrop-blur-md sm:right-8 sm:w-[220px] sm:p-4"
          style={{ ...RAISED, background: 'rgba(255,255,255,0.72)' }}
        >
          <Stat label="TOP SPEED" value={String(focused.topSpeedKph)} unit="KM/H" fill={r.speed} />
          <Stat label="ACCELERATION" value={focused.accel >= 1 ? '1.00' : focused.accel.toFixed(2)} unit="× F1" fill={r.accel} />
          <Stat label="MASS" value={focused.mass.toLocaleString()} unit="KG" fill={r.heft} />
          <Stat label="LENGTH" value={focused.size[2].toFixed(2)} unit="M" fill={r.footprint} />
          <div className="mt-3 flex h-8 items-center justify-between border-t pt-3" style={{ borderColor: THEME.line }}>
            <span className="text-[10px] font-bold tracking-[0.28em]" style={{ color: THEME.muted }}>DRIVETRAIN</span>
            <span className="w-[56px] text-right text-[16px] font-bold tracking-[0.1em]" style={DISPLAY}>{focused.drive.toUpperCase()}</span>
          </div>
        </aside>

        {roster.length > 1 && (<><Arrow side="left" onClick={() => step(-1)} /><Arrow side="right" onClick={() => step(1)} /></>)}

        {/* Loading: a hairline, never a box over the vehicle. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] overflow-hidden">
          {loading && <div className="h-full w-1/3 animate-[garage-sheen_1.2s_linear_infinite]" style={{ background: THEME.accent }} />}
        </div>
      </div>

      {/* ================= footer: pictures + the button ================= */}
      <footer className="relative z-20 flex items-center gap-6 px-8" style={{ background: 'linear-gradient(180deg, #ffffff 0%, #eef2f7 100%)', boxShadow: 'inset 0 1px 0 rgba(11,18,32,0.06), 0 -10px 28px rgba(11,18,32,0.08)' }}>
        <Rail roster={roster} focusedId={focused.id} thumbs={thumbs} onPick={pickVehicle} />
        <div className="ml-auto flex shrink-0 flex-col items-end gap-2">
          <DriveButton onClick={() => launch(focused)} label={focused.rail ? 'RIDE IT' : 'DRIVE IT'} />
          <span className="h-[14px] text-[10px] font-bold tracking-[0.28em]" style={{ color: THEME.muted }}>← → BROWSE · ENTER</span>
        </div>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------------------- */

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="relative h-10 shrink-0 px-4 text-[11px] font-extrabold tracking-[0.2em] transition-transform hover:-translate-y-px active:translate-y-px sm:px-5"
      style={{
        ...DISPLAY,
        clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
        background: active ? `linear-gradient(180deg, ${THEME.accentHi}, ${THEME.accent})` : 'linear-gradient(180deg, #ffffff, #eaeff6)',
        color: active ? '#ffffff' : THEME.muted,
        boxShadow: active ? `inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -3px 0 ${THEME.accentLo}, 0 6px 18px ${THEME.accent}55` : 'inset 0 1px 0 #ffffff, inset 0 -2px 0 rgba(11,18,32,0.10), 0 2px 6px rgba(11,18,32,0.08)',
      }}
    >
      {label}
    </button>
  );
}

/** Music + click SFX toggle. One switch for both — see `useGarageAudio`. */
function MuteButton({ muted, onClick }: { muted: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={muted ? 'Unmute music and sound' : 'Mute music and sound'}
      aria-pressed={muted}
      className="grid h-10 w-10 shrink-0 place-items-center rounded-sm transition-transform hover:-translate-y-px active:translate-y-px"
      style={RAISED}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={muted ? THEME.muted : THEME.accent} strokeWidth="2.2" aria-hidden>
        <path d="M4 9v6h4l5 4V5L8 9H4z" strokeLinejoin="round" />
        {muted
          ? <path d="M16 9l5 6M21 9l-5 6" strokeLinecap="round" />
          : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" strokeLinecap="round" />}
      </svg>
    </button>
  );
}

/** Hexagonal class badge with a metallic face. */
function Shield({ letter }: { letter: string }) {
  return (
    <div className="pointer-events-none absolute left-8 bottom-6 grid h-[92px] w-[80px] place-items-center">
      <svg className="absolute inset-0" viewBox="0 0 80 92" aria-hidden>
        <defs>
          <linearGradient id="shieldFace" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={THEME.accentHi} /><stop offset="0.55" stopColor={THEME.accent} /><stop offset="1" stopColor={THEME.accentLo} />
          </linearGradient>
        </defs>
        <polygon points="40,2 76,22 76,70 40,90 4,70 4,22" fill="#ffffff" />
        <polygon points="40,8 71,25 71,67 40,84 9,67 9,25" fill="url(#shieldFace)" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" />
        <polygon points="40,8 71,25 40,42 9,25" fill="rgba(255,255,255,0.14)" />
      </svg>
      <div className="relative text-center">
        <div className="text-[40px] font-extrabold italic leading-none" style={{ ...DISPLAY, color: '#ffffff' }}>{letter}</div>
        <div className="mt-0.5 text-[8px] font-extrabold tracking-[0.3em]" style={{ color: 'rgba(255,255,255,0.8)' }}>CLASS</div>
      </div>
    </div>
  );
}

/** A spec row: big numeral, unit, chunky segmented bar. Fixed height. */
function Stat({ label, value, unit, fill }: { label: string; value: string; unit: string; fill: number }) {
  const segs = 10;
  const lit = Math.max(1, Math.round(fill * segs));
  return (
    <div className="mb-3 h-[58px]">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-bold tracking-[0.28em]" style={{ color: THEME.muted }}>{label}</span>
        <span className="flex items-baseline justify-end gap-1"><span className="text-[22px] font-bold tabular-nums leading-none" style={DISPLAY}>{value}</span><span className="w-[30px] text-[9px] font-bold tracking-[0.1em]" style={{ color: THEME.muted }}>{unit}</span></span>
      </div>
      <div className="mt-2 flex gap-[3px]">
        {Array.from({ length: segs }, (_, i) => (
          <span key={i} className="h-[8px] flex-1 rounded-[2px]" style={{
            background: i < lit ? `linear-gradient(180deg, ${THEME.accentHi}, ${THEME.accent})` : 'rgba(11,18,32,0.08)',
            boxShadow: i < lit ? `0 0 8px ${THEME.accent}66, inset 0 1px 0 rgba(255,255,255,0.45)` : 'inset 0 1px 0 rgba(11,18,32,0.04)',
          }} />
        ))}
      </div>
    </div>
  );
}

/** The button: a raised slab with a real edge under it, and a passing sheen. */
function DriveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="garage-sheen group relative h-[64px] w-[240px] overflow-hidden text-[26px] font-extrabold italic tracking-[0.1em] transition-all duration-150 hover:-translate-y-[2px] active:translate-y-[3px]"
      style={{
        ...DISPLAY, color: '#ffffff',
        clipPath: 'polygon(16px 0, 100% 0, calc(100% - 16px) 100%, 0 100%)',
        background: `linear-gradient(180deg, ${THEME.accentHi} 0%, ${THEME.accent} 60%, ${THEME.accentLo} 100%)`,
        boxShadow: `inset 0 2px 0 rgba(255,255,255,0.55), inset 0 -6px 0 ${THEME.accentLo}, 0 12px 28px ${THEME.accent}66`,
      }}
    >
      <span className="relative z-10 flex items-center justify-center gap-3">
        {label}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="3.4" aria-hidden><path d="M5 12h13M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    </button>
  );
}

/**
 * Cycle arrow: a plain raised disc — the same lit-top/shadowed-bottom
 * chrome every other control on this screen uses — with one bold chevron.
 * The earlier version (a metallic ring with a tick-mark rim and a stacked
 * double chevron) borrowed too much from the turntable decal to read
 * cleanly at 64px; this drops back to the same simple language as the
 * rest of the chrome instead of being its own separate motif.
 */
function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const flip = side === 'left';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={flip ? 'Previous vehicle' : 'Next vehicle'}
      className={`group absolute top-1/2 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full transition-all hover:scale-110 active:scale-95 ${flip ? 'left-5' : 'right-5'}`}
      style={RAISED}
    >
      <svg width="18" height="22" viewBox="0 0 18 22" fill="none" className="transition-transform group-hover:scale-110">
        <path d={flip ? 'M14 2 L4 11 L14 20' : 'M4 2 L14 11 L4 20'}
          stroke={THEME.accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Pictures of the vehicles, rendered once by GarageThumbs and cached. */
function Rail({ roster, focusedId, thumbs, onPick }: { roster: GarageVehicle[]; focusedId: string; thumbs: Record<string, string>; onPick: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [focusedId]);
  return (
    <div ref={strip} className="flex min-w-0 flex-1 gap-3 overflow-x-auto py-3">
      {roster.map((v) => {
        const active = v.id === focusedId;
        const src = thumbs[v.id];
        return (
          <button key={v.id} type="button" data-active={active} onClick={() => onPick(v.id)}
            className={`relative h-[112px] w-[184px] shrink-0 overflow-hidden rounded-sm transition-transform ${active ? 'scale-[1.04]' : 'hover:scale-[1.02]'}`}
            style={{
              ...RAISED,
              border: `2px solid ${active ? THEME.accent : 'rgba(11,18,32,0.08)'}`,
              boxShadow: active ? `${RAISED.boxShadow}, 0 0 0 4px ${THEME.accent}22, 0 0 26px ${THEME.accent}55` : RAISED.boxShadow,
            }}>
            {src
              // Data URLs rendered by GarageThumbs: nothing for next/image to fetch or resize.
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={src} alt={v.label} className="absolute inset-0 h-full w-full object-cover" draggable={false} />
              : <div className="absolute inset-0 animate-pulse" style={{ background: THEME.panel }} />}
            <div className="absolute inset-x-0 bottom-0 flex h-[30px] items-center justify-between px-2.5" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.94) 40%)' }}>
              <span className="truncate text-[13px] font-bold tracking-[0.02em]" style={DISPLAY}>{v.label}</span>
              <span className="ml-2 text-[11px] font-extrabold" style={{ ...DISPLAY, color: THEME.accent }}>{classFor(v)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Builds the URL for a vehicle, preserving any other parameters already set. */
export function urlForVehicle(id: string): string {
  const params = new URLSearchParams(window.location.search);
  params.set(CAR_PARAM, id);
  return `${window.location.pathname}?${params.toString()}`;
}
