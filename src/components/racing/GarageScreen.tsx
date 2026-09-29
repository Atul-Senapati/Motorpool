'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  CAR_PARAM, CATEGORIES, GARAGE, classFor, lastVehicleId, ratingsFor, rememberVehicle,
  type GarageVehicle, type VehicleCategory,
} from '@/config/garage';
import { useGarageAudio } from '@/hooks/useGarageAudio';
import { UiSoundProvider, useUi, useUiSound } from '@/hooks/useUiSound';
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
  /**
   * Hovers and toggles for the showroom.
   *
   * The garage already had a click and a confirm, as recorded clips
   * (`useGarageAudio`); what it had no sound for at all was moving the cursor
   * over something. Those come from the synthesised bank the pause menu uses,
   * so the two screens tick alike, and both follow the one mute switch that is
   * already on this page.
   */
  const ui = useUiSound(!muted);

  // Un-muting cannot announce itself from the button that does it — the bank
  // is still silent at the moment it is clicked — so it is announced here, on
  // the way out. Muting is heard the other way round, on the click itself.
  const wasMuted = useRef(muted);
  useEffect(() => {
    if (!muted && wasMuted.current) ui('toggleUp');
    wasMuted.current = muted;
  }, [muted, ui]);

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
  const cls = classFor(focused);
  const catLabel = CATEGORIES.find((c) => c.id === focused.category)?.label ?? '';
  const honours = honoursFor(focused);
  const pad2 = (n: number) => String(n).padStart(2, '0');

  return (
    <UiSoundProvider value={ui}>
    <div
      className={`${barlow.variable} ${barlowCondensed.variable} grid h-dvh w-full grid-cols-[minmax(0,1fr)] grid-rows-[76px_1fr_176px] overflow-hidden select-none`}
      style={{ fontFamily: 'var(--font-ui)', color: THEME.text, background: THEME.ink }}
    >
      {/* Shoots only the focused vehicle, and only if it has no cached
          picture — so a thumbnail never costs a download that the stage was
          not making anyway. See `GarageThumbs`. */}
      <GarageThumbs vehicles={GARAGE} focusedId={focused.id} onShot={onShot} />

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

        {/* Counter: fixed width so 01/08 and 01/01 occupy identical space, with
            the roster as a progress strip under it. */}
        <div className="relative ml-auto flex shrink-0 items-center gap-2 pr-6 sm:gap-3 sm:pr-8">
          <MuteButton muted={muted} onClick={() => { ui('toggleDown'); toggleMuted(); }} />
          <div className="relative flex h-10 w-[124px] flex-col items-center justify-center rounded-sm" style={RAISED}>
            <span className="text-[20px] font-bold tabular-nums leading-none tracking-[0.1em]" style={DISPLAY}>
              <span>{pad2(index + 1)}</span><span className="mx-1.5" style={{ color: THEME.muted }}>/</span><span style={{ color: THEME.muted }}>{pad2(roster.length)}</span>
            </span>
            <div className="mt-1.5 flex h-[3px] w-[88px] gap-[2px]">
              {roster.map((v, i) => (
                <span key={v.id} className="h-full flex-1 rounded-[1px]" style={{ background: i <= index ? THEME.accent : 'rgba(11,18,32,0.10)' }} />
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* ================= stage ================= */}
      {/*
        `overflow-hidden`, and it is load-bearing rather than tidiness.

        `.garage-grain` is deliberately `inset: -8%` so its drifting animation
        never slides an edge into view — 116% of this box, which without a clip
        here overflowed the *grid*. The grid is `overflow-hidden`, and an
        `overflow: hidden` box is still a scrollport: it cannot be scrolled by
        hand, and it has no scrollbar to show it has been, but anything that
        scrolls programmatically can move it and nothing can move it back. The
        rail's `scrollIntoView` did exactly that — selecting a vehicle near the
        end of the roster walked up the ancestor chain and shifted the entire
        screen a couple of hundred pixels left, wordmark and all, for the rest
        of the session. Clipping here keeps the grain's bleed and takes the
        grid's scrollWidth back down to its clientWidth; `Rail` no longer asks
        an ancestor to scroll either.
      */}
      <div className="relative min-h-0 overflow-hidden">
        <GarageStage vehicle={focused} onReady={setReadyId} />
        <div className="garage-grain" aria-hidden />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 90% 75% at 50% 48%, transparent 55%, rgba(11,18,32,0.10) 100%)' }} />

        {/*
          Name plate — type on the stage, no surface behind it.

          It was a frosted card for one revision and came straight back off:
          a box that size reads as a dialog sitting on the showroom, not as a
          showroom. What made the type unreadable was never the lack of a box,
          it was grey secondary text over a white flank — so the blurb is set
          in the text colour, and everything carries a faint white halo that
          lifts it off a dark car without showing on a light one. Fixed rows,
          so a longer name or blurb changes nothing but the letters; starts
          92 px in, which is the cycle arrow's lane.
        */}
        <div key={focused.id} className="garage-enter pointer-events-none absolute left-[92px] top-8 w-[min(40vw,480px)]" style={HALO}>
          <div className="flex h-[24px] items-center gap-2">
            <Chip label={String(focused.year)} />
            <Chip label={catLabel} />
            <Chip label={`CLASS ${cls}`} solid />
          </div>
          <h2
            className="mt-2 h-[2.1em] overflow-hidden font-extrabold italic leading-[1.0] tracking-[-0.01em]"
            style={{ ...DISPLAY, fontSize: 'clamp(38px, 4.8vw, 72px)' }}
          >
            {focused.label}
          </h2>
          <p className="mt-2 h-[44px] overflow-hidden text-[13.5px] font-medium leading-[22px]" style={{ color: THEME.text, opacity: 0.9, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {focused.blurb}
          </p>
          {/*
            Honours: what this one is best at, across the whole garage. A fixed
            row — empty for a vehicle that holds no record, which is most of
            them, and that emptiness is the information.
          */}
          <div className="mt-3 flex h-[26px] items-center gap-2 overflow-hidden">
            <Chip label={DRIVE_LABEL[focused.drive]} />
            {honours.map((h) => <Chip key={h} label={h} solid />)}
          </div>
        </div>

        <Shield letter={cls} />

        {/*
          Spec sheet — fixed width, fixed row heights, tabular numerals, and
          no card behind it either: the rows sit on the stage with a hairline
          between them. Each carries a grade and a rank as well as the bar —
          the bar says how much, the grade whether that is good, the rank
          against what.
        */}
        <aside
          key={`spec-${focused.id}`}
          className="garage-enter pointer-events-none absolute right-[92px] top-8 w-[220px] sm:w-[240px]"
          style={HALO}
        >
          <div className="mb-3 flex h-[18px] items-center justify-between border-b pb-2" style={{ borderColor: THEME.line }}>
            <span className="text-[10px] font-bold tracking-[0.3em]" style={{ color: THEME.muted }}>SPEC SHEET</span>
            <span className="text-[10px] font-bold tabular-nums tracking-[0.2em]" style={{ color: THEME.muted }}>{focused.triangles.toLocaleString()} TRIS</span>
          </div>
          <Stat label="TOP SPEED" value={String(focused.topSpeedKph)} unit="KM/H" fill={r.speed} rank={rankOf(focused, (v) => v.topSpeedKph)} />
          <Stat label="ACCELERATION" value={focused.accel >= 1 ? '1.00' : focused.accel.toFixed(2)} unit="× F1" fill={r.accel} rank={rankOf(focused, (v) => v.accel)} />
          <Stat label="MASS" value={focused.mass.toLocaleString()} unit="KG" fill={r.heft} rank={rankOf(focused, (v) => v.mass)} neutral />
          <Stat label="LENGTH" value={focused.size[2].toFixed(2)} unit="M" fill={r.footprint} rank={rankOf(focused, (v) => v.size[2])} neutral />
          <div className="mt-2 flex h-8 items-center justify-between border-t pt-3" style={{ borderColor: THEME.line }}>
            <span className="text-[10px] font-bold tracking-[0.28em]" style={{ color: THEME.muted }}>DRIVETRAIN</span>
            <span className="text-right text-[16px] font-bold tracking-[0.1em]" style={DISPLAY}>{focused.drive.toUpperCase()}</span>
          </div>
        </aside>

        {roster.length > 1 && (<><Arrow side="left" onClick={() => step(-1)} /><Arrow side="right" onClick={() => step(1)} /></>)}

        {/* Loading: a hairline, never a box over the vehicle.
            It used to be a third-width stripe sliding past on a loop, which
            says "busy" and nothing else. It now fills and keeps a shimmer
            running over it — see `garage-creep` for why that fill is a creep
            rather than a percentage, and why it stops at 92%: a bar that
            reaches 100% and then sits there is how you get "it's frozen". */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] overflow-hidden"
          style={{ background: loading ? `${THEME.accent}1f` : 'transparent' }}>
          {loading && (
            <div key={focused.id} className="garage-shimmer garage-creep h-full" style={{ background: THEME.accent }} />
          )}
        </div>
      </div>

      {/* ================= footer: pictures + the button ================= */}
      <footer className="relative z-20 flex items-center gap-6 px-8" style={{ background: 'linear-gradient(180deg, #ffffff 0%, #eef2f7 100%)', boxShadow: 'inset 0 1px 0 rgba(11,18,32,0.06), 0 -10px 28px rgba(11,18,32,0.08)' }}>
        <Rail roster={roster} focusedId={focused.id} thumbs={thumbs} onPick={pickVehicle} />
        <div className="ml-auto flex shrink-0 flex-col items-end gap-2">
          <DriveButton onClick={() => launch(focused)} label={focused.rail ? 'RIDE IT' : focused.sea ? 'TAKE THE HELM' : 'DRIVE IT'} />
          <div className="flex h-[22px] items-center gap-2 text-[10px] font-bold tracking-[0.24em]" style={{ color: THEME.muted }}>
            <Key label="←" /><Key label="→" /><span>BROWSE</span>
            <span className="mx-1 h-3 w-px" style={{ background: THEME.line }} />
            <Key label="ENTER" wide /><span>GO</span>
          </div>
        </div>
      </footer>
    </div>
    </UiSoundProvider>
  );
}

/* ---------------------------------------------------------------------------- */

/** A faint white halo under stage type: lifts it off a dark car, invisible on a light one. */
const HALO = { textShadow: '0 1px 0 rgba(255,255,255,0.95), 0 0 14px rgba(255,255,255,0.95), 0 0 2px rgba(255,255,255,1)' } as const;

const DRIVE_LABEL: Record<GarageVehicle['drive'], string> = {
  rwd: 'REAR DRIVE', awd: 'ALL WHEEL', rail: 'ON RAILS', screw: 'TWIN SCREW', rotor: 'QUAD ROTOR',
};

/** Position in the whole garage on a stat, 1 being the most. */
function rankOf(vehicle: GarageVehicle, by: (v: GarageVehicle) => number): number {
  const mine = by(vehicle);
  return 1 + GARAGE.filter((v) => by(v) > mine).length;
}

/**
 * Records this vehicle holds across the garage. Speed and pull are the ones
 * a driver cares about; the heaviest and the longest are there because a
 * garage that only rewards the fast has nothing to say about a tractor.
 */
function honoursFor(vehicle: GarageVehicle): string[] {
  const out: string[] = [];
  if (rankOf(vehicle, (v) => v.topSpeedKph) === 1) out.push('FASTEST');
  if (rankOf(vehicle, (v) => v.accel) === 1) out.push('QUICKEST');
  if (rankOf(vehicle, (v) => v.mass) === 1) out.push('HEAVIEST');
  if (rankOf(vehicle, (v) => -v.mass) === 1) out.push('LIGHTEST');
  if (rankOf(vehicle, (v) => v.size[2]) === 1) out.push('LONGEST');
  return out.slice(0, 3);
}

/** Grade for a normalised figure — the same cut-offs `classFor` uses. */
function gradeFor(fill: number): string {
  if (fill >= 0.85) return 'S';
  if (fill >= 0.66) return 'A';
  if (fill >= 0.46) return 'B';
  if (fill >= 0.3) return 'C';
  return 'D';
}

/** A small label: outlined by default, filled blue when `solid`. Fixed height. */
function Chip({ label, solid = false }: { label: string; solid?: boolean }) {
  return (
    <span
      className="inline-flex h-[20px] shrink-0 items-center whitespace-nowrap rounded-[3px] px-2 text-[9.5px] font-extrabold tracking-[0.22em]"
      style={solid
        ? { background: `linear-gradient(180deg, ${THEME.accentHi}, ${THEME.accent})`, color: '#ffffff', boxShadow: `0 4px 12px ${THEME.accent}55, inset 0 1px 0 rgba(255,255,255,0.35)` }
        : { border: `1px solid ${THEME.line}`, color: THEME.muted, background: 'rgba(255,255,255,0.6)' }}
    >
      {label}
    </span>
  );
}

/** A keycap, for the hints. */
function Key({ label, wide = false }: { label: string; wide?: boolean }) {
  return (
    <span
      className={`inline-grid h-[20px] place-items-center rounded-[3px] px-1.5 text-[9.5px] font-extrabold tracking-[0.1em] ${wide ? 'min-w-[44px]' : 'min-w-[20px]'}`}
      style={{ ...DISPLAY, color: THEME.text, background: 'linear-gradient(180deg, #ffffff, #e9eef5)', boxShadow: 'inset 0 1px 0 #ffffff, inset 0 -2px 0 rgba(11,18,32,0.14), 0 1px 2px rgba(11,18,32,0.12)', border: '1px solid rgba(11,18,32,0.10)' }}
    >
      {label}
    </span>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const hi = THEME.accentHi;
  const mid = THEME.accent;
  const ui = useUi();
  return (
    <button
      type="button"
      onPointerEnter={() => { if (!active) ui('hover'); }}
      onClick={onClick}
      aria-pressed={active}
      className="relative h-10 shrink-0 px-4 text-[11px] font-extrabold tracking-[0.2em] transition-transform hover:-translate-y-px active:translate-y-px sm:px-5"
      style={{
        ...DISPLAY,
        clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
        background: active ? `linear-gradient(180deg, ${hi}, ${mid})` : 'linear-gradient(180deg, #ffffff, #eaeff6)',
        color: active ? '#ffffff' : THEME.muted,
        boxShadow: active ? `inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -3px 0 ${THEME.accentLo}, 0 6px 18px ${mid}55` : 'inset 0 1px 0 #ffffff, inset 0 -2px 0 rgba(11,18,32,0.10), 0 2px 6px rgba(11,18,32,0.08)',
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
    <div key={letter} className="garage-enter pointer-events-none absolute left-8 bottom-6 grid h-[92px] w-[80px] place-items-center">
      <svg className="absolute inset-0" viewBox="0 0 80 92" aria-hidden>
        <defs>
          <linearGradient id="shieldFace" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={THEME.accentHi} /><stop offset="0.55" stopColor={THEME.accent} /><stop offset="1" stopColor={THEME.accentLo} />
          </linearGradient>
        </defs>
        <polygon points="40,2 76,22 76,70 40,90 4,70 4,22" fill="#ffffff" />
        <polygon points="40,8 71,25 71,67 40,84 9,67 9,25" fill="url(#shieldFace)" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" />
        <polygon points="40,8 71,25 40,42 9,25" fill="rgba(255,255,255,0.16)" />
      </svg>
      <div className="relative text-center">
        <div className="text-[40px] font-extrabold italic leading-none" style={{ ...DISPLAY, color: '#ffffff', textShadow: '0 2px 8px rgba(0,0,0,0.25)' }}>{letter}</div>
        <div className="mt-0.5 text-[8px] font-extrabold tracking-[0.3em]" style={{ color: 'rgba(255,255,255,0.85)' }}>CLASS</div>
      </div>
    </div>
  );
}

/**
 * A spec row: label, grade, big numeral, unit, a bar that fills, and where
 * this stands in the garage. Fixed height. `neutral` is for mass and length,
 * where more is not better, so there is no grade — an "S" for being the
 * heaviest thing here would be a joke at the tractor's expense.
 */
function Stat({ label, value, unit, fill, rank, neutral = false }: {
  label: string; value: string; unit: string; fill: number; rank: number; neutral?: boolean;
}) {
  const grade = gradeFor(fill);
  const colour = { hi: THEME.accentHi, mid: THEME.accent };
  const pct = Math.max(4, Math.round(Math.min(1, fill) * 100));
  return (
    <div className="mb-2.5 h-[58px]">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold tracking-[0.28em]" style={{ color: THEME.muted }}>{label}</span>
          {!neutral && (
            <span className="inline-grid h-[14px] w-[14px] place-items-center rounded-[2px] text-[9px] font-extrabold" style={{ ...DISPLAY, color: '#ffffff', background: colour.mid }}>{grade}</span>
          )}
        </span>
        <span className="flex items-baseline justify-end gap-1"><span className="text-[22px] font-bold tabular-nums leading-none" style={DISPLAY}>{value}</span><span className="w-[30px] text-[9px] font-bold tracking-[0.1em]" style={{ color: THEME.muted }}>{unit}</span></span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {/* The bar: a track with ticks, and a fill that animates in. */}
        <div className="relative h-[8px] flex-1 overflow-hidden rounded-[2px]" style={{ background: 'rgba(11,18,32,0.08)', boxShadow: 'inset 0 1px 0 rgba(11,18,32,0.04)' }}>
          <div className="garage-bar absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${colour.mid}, ${colour.hi})`, boxShadow: `0 0 8px ${colour.mid}66, inset 0 1px 0 rgba(255,255,255,0.45)` }} />
          <div className="pointer-events-none absolute inset-0 flex justify-between px-[10%]" aria-hidden>
            {Array.from({ length: 4 }, (_, i) => <span key={i} className="h-full w-px" style={{ background: 'rgba(255,255,255,0.55)' }} />)}
          </div>
        </div>
        <span className="w-[34px] text-right text-[9px] font-bold tabular-nums tracking-[0.1em]" style={{ color: THEME.muted }}>#{rank}<span style={{ opacity: 0.6 }}>/{GARAGE.length}</span></span>
      </div>
    </div>
  );
}

/** The button: a raised slab with a real edge under it, and a passing sheen. */
function DriveButton({ label, onClick }: { label: string; onClick: () => void }) {
  const ui = useUi();
  return (
    <button
      type="button"
      onPointerEnter={() => ui('hover')}
      onClick={onClick}
      className="garage-sheen group relative h-[64px] w-[260px] overflow-hidden text-[24px] font-extrabold italic tracking-[0.1em] transition-all duration-150 hover:-translate-y-[2px] active:translate-y-[3px]"
      style={{
        ...DISPLAY, color: '#ffffff',
        clipPath: 'polygon(16px 0, 100% 0, calc(100% - 16px) 100%, 0 100%)',
        background: `linear-gradient(180deg, ${THEME.accentHi} 0%, ${THEME.accent} 60%, ${THEME.accentLo} 100%)`,
        boxShadow: `inset 0 2px 0 rgba(255,255,255,0.55), inset 0 -6px 0 ${THEME.accentLo}, 0 12px 28px ${THEME.accent}66`,
      }}
    >
      <span className="relative z-10 flex items-center justify-center gap-3 whitespace-nowrap">
        {label}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="3.4" aria-hidden><path d="M5 12h13M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    </button>
  );
}

/**
 * Cycle arrow: a plain raised disc — the same lit-top/shadowed-bottom
 * chrome every other control on this screen uses — with one bold chevron.
 */
function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const ui = useUi();
  const flip = side === 'left';
  return (
    <button
      type="button"
      onPointerEnter={() => ui('hover')}
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
  /*
   * Scrolls the strip itself rather than calling `scrollIntoView` on the tile.
   *
   * `scrollIntoView` does not stop at the nearest scrollable box: it walks
   * every scrollport up to the viewport, `overflow: hidden` ones included,
   * and those cannot be scrolled back — there is no scrollbar and no wheel
   * target. One 8% overflow anywhere above meant picking the fifteenth
   * vehicle dragged the whole screen sideways. Moving `scrollLeft` on this
   * one element cannot reach anything else, whatever the layout does next.
   *
   * Measured through `getBoundingClientRect` rather than `offsetLeft`, whose
   * frame of reference is the nearest positioned ancestor — the footer here,
   * not the strip.
   */
  useEffect(() => {
    const box = strip.current;
    const active = box?.querySelector<HTMLElement>('[data-active="true"]');
    if (!box || !active) return;
    const stripRect = box.getBoundingClientRect();
    const tile = active.getBoundingClientRect();
    const delta = (tile.left + tile.width / 2) - (stripRect.left + stripRect.width / 2);
    if (Math.abs(delta) < 1) return;
    // `scrollTo` clamps to the scrollable range, so the ends need no special case.
    box.scrollTo({ left: box.scrollLeft + delta, behavior: 'smooth' });
  }, [focusedId]);
  const ui = useUi();
  return (
    <div ref={strip} className="flex min-w-0 flex-1 gap-3 overflow-x-auto py-3 [scrollbar-width:none]">
      {roster.map((v) => {
        const active = v.id === focusedId;
        const src = thumbs[v.id];
        const cls = classFor(v);
        return (
          <button key={v.id} type="button" data-active={active} onClick={() => onPick(v.id)}
            onPointerEnter={() => { if (!active) ui('hover'); }}
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
              // Not `animate-pulse`: a card fading in and out looks like a
              // card that has finished and is empty. A band travelling across
              // it reads as work, and it is the same shimmer the stage's own
              // progress bar uses, so the two agree about what waiting is.
              : <div className="garage-shimmer absolute inset-0" style={{ background: THEME.panel }} />}
            {/* Class as a small hex in the corner. */}
            <span
              className="absolute right-2 top-2 grid h-[22px] w-[20px] place-items-center text-[11px] font-extrabold"
              style={{ ...DISPLAY, color: '#ffffff', background: `linear-gradient(180deg, ${THEME.accentHi}, ${THEME.accentLo})`, clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)', textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
            >
              {cls}
            </span>
            <div className="absolute inset-x-0 bottom-0 flex h-[30px] items-center justify-between px-2.5" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.94) 40%)' }}>
              <span className="truncate text-[13px] font-bold tracking-[0.02em]" style={DISPLAY}>{v.label}</span>
              <span className="ml-2 text-[9px] font-bold tabular-nums tracking-[0.1em]" style={{ color: THEME.muted }}>{v.year}</span>
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
