'use client';

import { useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import { barlowCondensed } from './garageFonts';
import { HUD, INK, NUM } from './hudTheme';
import { SettingsForm } from './SettingsPanel';
import { ControlsList } from './HelpPanel';
import type { GameSettings } from './gameSettings';

export type MenuPage = 'menu' | 'settings' | 'controls';

const ITEMS = [
  { id: 'resume', label: 'RESUME' },
  { id: 'settings', label: 'SETTINGS' },
  { id: 'controls', label: 'CONTROLS' },
  { id: 'garage', label: 'GARAGE' },
] as const;
type ItemId = (typeof ITEMS)[number]['id'];

const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

/**
 * The pause menu.
 *
 * This replaced three labelled buttons on the HUD, after three attempts at
 * styling them. The styling was never the problem: a row of text buttons is a
 * toolbar, and a toolbar is not what a racing game puts over the road. Every
 * game in the genre does the same thing instead — one pause control, and a
 * full-screen menu behind it where the graphics get to be graphics. The world
 * actually pauses while it is open; that is what makes a pause menu feel like
 * one rather than like a dialog.
 *
 * Set in the garage's display face, so the menu and the showroom read as the
 * same product. The HUD's own numeral face carries the trip figures.
 */
export function PauseMenu({
  page, onPage, onResume, onGarage, settings, onSettingsChange,
  distanceRef, unitRef, bestRef,
}: {
  page: MenuPage;
  onPage: (page: MenuPage) => void;
  onResume: () => void;
  onGarage: () => void;
  settings: GameSettings;
  onSettingsChange: (next: Partial<GameSettings>) => void;
  /** The trip readouts, written by the HUD's frame loop. Same numbers, second home. */
  distanceRef: RefObject<HTMLSpanElement | null>;
  unitRef: RefObject<HTMLSpanElement | null>;
  bestRef: RefObject<HTMLSpanElement | null>;
}) {
  const [cursor, setCursor] = useState(0);

  const activate = useCallback((id: ItemId) => {
    if (id === 'resume') onResume();
    else if (id === 'garage') onGarage();
    else onPage(id);
  }, [onResume, onGarage, onPage]);

  // Arrow keys (or W/S) and Enter on the main page, Backspace out of a
  // sub-page. The arrows also steer the car, but the world is paused, so
  // nothing moves.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // One move per press. W is also the throttle, and a player who pauses
      // with it still held would otherwise watch the cursor spin at the key
      // repeat rate until they let go.
      if (event.repeat) return;
      if (page !== 'menu') {
        if (event.code === 'Backspace') onPage('menu');
        return;
      }
      if (event.code === 'ArrowDown' || event.code === 'KeyS') {
        setCursor((c) => (c + 1) % ITEMS.length);
      } else if (event.code === 'ArrowUp' || event.code === 'KeyW') {
        setCursor((c) => (c + ITEMS.length - 1) % ITEMS.length);
      } else if (event.code === 'Enter' || event.code === 'Space') {
        event.preventDefault();
        activate(ITEMS[cursor].id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page, cursor, activate, onPage]);

  return (
    <div
      className={`${barlowCondensed.variable} pointer-events-auto absolute inset-0 z-40 select-none overflow-hidden`}
      style={{
        background:
          'linear-gradient(105deg, rgba(3,7,11,0.9) 0%, rgba(4,9,14,0.78) 55%, rgba(4,9,14,0.62) 100%)',
        backdropFilter: 'blur(7px)',
      }}
    >
      {/* Hatching behind the header — the same diagonal band the garage uses,
          in the HUD's colour, faint enough to be texture rather than pattern. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[34%]"
        style={{
          backgroundImage: 'repeating-linear-gradient(-55deg, rgba(79,219,232,0.07) 0 1px, transparent 1px 13px)',
          maskImage: 'linear-gradient(180deg, #000 30%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(180deg, #000 30%, transparent 100%)',
        }}
      />
      {/* A slanted cyan rule along the bottom, going nowhere in particular. */}
      <div
        aria-hidden
        className="absolute bottom-[14%] left-0 h-px w-[46%]"
        style={{ background: `linear-gradient(90deg, ${HUD.cyan}, transparent)`, opacity: 0.55 }}
      />

      <div
        className="relative flex h-full flex-col justify-between px-[7vw] py-[6vh]"
        style={{ animation: 'pause-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1) both' }}
      >
        {page === 'menu' ? (
          <MainPage
            cursor={cursor}
            onCursor={setCursor}
            onActivate={activate}
            distanceRef={distanceRef}
            unitRef={unitRef}
            bestRef={bestRef}
          />
        ) : (
          <SubPage
            title={page === 'settings' ? 'SETTINGS' : 'CONTROLS'}
            onBack={() => onPage('menu')}
          >
            {page === 'settings'
              ? <SettingsForm settings={settings} onChange={onSettingsChange} />
              : <ControlsList />}
          </SubPage>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- main page */

function MainPage({
  cursor, onCursor, onActivate, distanceRef, unitRef, bestRef,
}: {
  cursor: number;
  onCursor: (index: number) => void;
  onActivate: (id: ItemId) => void;
  distanceRef: RefObject<HTMLSpanElement | null>;
  unitRef: RefObject<HTMLSpanElement | null>;
  bestRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <>
      <header>
        <div style={{ fontSize: 10, letterSpacing: '0.36em', color: HUD.cyan, fontWeight: 700, ...INK }}>
          MOTORPOOL
        </div>
        <div className="mt-2 flex items-end gap-4">
          {/* The slash: a skewed bar, the one bit of pure decoration here. */}
          <span
            aria-hidden
            className="mb-2 inline-block w-[10px] shrink-0"
            style={{ height: 'clamp(38px, 6.6vw, 58px)', background: HUD.cyan, transform: 'skewX(-16deg)' }}
          />
          <h1
            className="leading-[0.92] italic"
            style={{
              ...DISPLAY, ...INK,
              fontSize: 'clamp(52px, 9.2vw, 84px)', fontWeight: 800, letterSpacing: '0.01em', color: '#ffffff',
            }}
          >
            PAUSED
          </h1>
        </div>
        <div className="mt-3" style={{ fontSize: 11, letterSpacing: '0.24em', color: HUD.muted, fontWeight: 600, ...INK }}>
          {SELECTED.label.toUpperCase()}
          <span style={{ color: HUD.faint }}> · </span>
          <span style={NUM}>{SELECTED.year}</span>
        </div>
      </header>

      <div className="flex items-end justify-between gap-10">
        {/* The menu. */}
        <nav className="flex flex-col gap-1">
          {ITEMS.map((item, index) => (
            <MenuItem
              key={item.id}
              index={index}
              label={item.label}
              active={index === cursor}
              onHover={() => onCursor(index)}
              onActivate={() => onActivate(item.id)}
            />
          ))}
        </nav>

        {/* The trip so far, since the numbers were on screen a moment ago and
            this is where you look back at them. */}
        <div className="hidden flex-col items-end gap-6 sm:flex">
          <Figure label="TRIP">
            <span ref={distanceRef} style={{ ...NUM, color: HUD.cyan }}>0</span>
            <span ref={unitRef} style={{ fontSize: 15, fontWeight: 700, color: HUD.cyan, letterSpacing: '0.08em' }}>M</span>
          </Figure>
          <Figure label="BEST">
            <span ref={bestRef} style={{ ...NUM, color: HUD.text }}>0</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: HUD.muted, letterSpacing: '0.12em' }}>KM/H</span>
          </Figure>
        </div>
      </div>

      <footer className="flex flex-wrap gap-x-5 gap-y-2">
        <Hint keys="ESC">RESUME</Hint>
        <Hint keys="↑ ↓">NAVIGATE</Hint>
        <Hint keys="ENTER">SELECT</Hint>
      </footer>
    </>
  );
}

/**
 * One menu row.
 *
 * Active state is a band that is cut on a slant, a left bar, a lit label and a
 * small slide to the right — the vocabulary of every racing-game menu, which is
 * exactly the point. Hover and the keyboard cursor are the same state, so the
 * mouse and the arrows never disagree about which row is live.
 */
function MenuItem({
  index, label, active, onHover, onActivate,
}: {
  index: number;
  label: string;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onPointerEnter={onHover}
      onClick={onActivate}
      className="relative flex h-[56px] w-[min(430px,64vw)] items-center gap-5 pl-7 text-left transition-transform duration-150"
      style={{ transform: active ? 'translateX(14px)' : 'none' }}
    >
      <span
        aria-hidden
        className="absolute inset-0 transition-opacity duration-150"
        style={{
          opacity: active ? 1 : 0,
          clipPath: 'polygon(0 0, 100% 0, calc(100% - 28px) 100%, 0 100%)',
          background: 'linear-gradient(90deg, rgba(79,219,232,0.30) 0%, rgba(79,219,232,0.08) 55%, transparent 100%)',
          borderLeft: `4px solid ${HUD.cyan}`,
        }}
      />
      <span
        className="relative w-[26px]"
        style={{ ...NUM, fontSize: 11, letterSpacing: '0.2em', fontWeight: 700, color: active ? HUD.cyan : HUD.faint }}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <span
        className="relative italic leading-none"
        style={{
          ...DISPLAY, ...INK,
          fontSize: 'clamp(26px, 3.6vw, 32px)', fontWeight: 800, letterSpacing: '0.04em',
          color: active ? '#e6fdff' : 'rgba(255,255,255,0.78)',
        }}
      >
        {label}
      </span>
      <svg
        aria-hidden
        width="12" height="20" viewBox="0 0 12 20" fill="none"
        stroke={HUD.cyan} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className="relative ml-1 transition-opacity duration-150"
        style={{ opacity: active ? 1 : 0 }}
      >
        <path d="M3 3l6 7-6 7" />
      </svg>
    </button>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-baseline gap-2 leading-none" style={{ fontSize: 'clamp(34px, 4.6vw, 48px)', fontWeight: 700, ...INK }}>
        {children}
      </div>
      <div style={{ fontSize: 9.5, letterSpacing: '0.3em', color: HUD.faint, fontWeight: 700 }}>{label}</div>
    </div>
  );
}

function Hint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="px-1.5 py-1"
        style={{
          ...NUM, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', color: HUD.cyan,
          border: `1px solid rgba(79,219,232,0.4)`,
          clipPath: 'polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)',
        }}
      >
        {keys}
      </span>
      <span style={{ fontSize: 9.5, letterSpacing: '0.22em', color: HUD.muted, fontWeight: 600 }}>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ sub-pages */

function SubPage({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <>
      <header className="flex items-center gap-5">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onBack}
          aria-label="Back to the menu"
          className="flex h-10 w-10 items-center justify-center transition-colors hover:bg-white/10"
          style={{
            border: `1px solid rgba(79,219,232,0.45)`, color: HUD.cyan,
            clipPath: 'polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.5 8H4M7.5 4.5L4 8l3.5 3.5" />
          </svg>
        </button>
        <h1
          className="italic leading-none"
          style={{ ...DISPLAY, ...INK, fontSize: 'clamp(38px, 6vw, 56px)', fontWeight: 800, letterSpacing: '0.02em', color: '#ffffff' }}
        >
          {title}
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-6">
        <div className="w-[min(560px,100%)]">{children}</div>
      </div>

      <footer className="flex gap-5">
        <Hint keys="BACKSPACE">MENU</Hint>
        <Hint keys="ESC">RESUME</Hint>
      </footer>
    </>
  );
}
