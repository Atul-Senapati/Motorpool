'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ROUTE_LOCK, ROUTE_WINDOW, liveRouteChoice, type RoadInfo } from '@/physics/railRoute';
import { useUi } from '@/hooks/useUiSound';
import type { VehicleTelemetry } from '@/types/vehicle';
import { HUD } from './hudTheme';

/**
 * The road choice at the next set of points: the two roads side by side where
 * they go, each with its key — A for the left-hand road, D for the right-hand
 * one — and what it leads to: its speed, the next station on it, and whether
 * there is a train on it. Your road is bright, the other dim.
 *
 * It comes in `ROUTE_WINDOW` out. A thin bar counts down to `ROUTE_LOCK`, where
 * the route locks: the other road fades and yours reads LOCKED, and a key
 * pressed after that shakes the panel. Past the points, ROUTE SET names where
 * the train went.
 *
 * The panels are React state, keyed on rounded values so they re-render only
 * when something the driver can see has changed; the countdown is written
 * through refs every frame.
 */

const INK = '#e9f1f8';
const GREEN = '#3cf08a';
const PANEL = 'rgba(4,9,15,0.78)';
const PANEL_SOFT = 'rgba(4,9,15,0.55)';
const CUT = 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)';
const DISPLAY = 'var(--font-display)';
const NUMERALS = 'var(--font-hud)';
/** How long ROUTE SET and TOO LATE stay up, ms. */
const STAMP_MS = 1600;
const LATE_MS = 1400;
/** Passing points this close counts as having taken them. */
const TAKEN_WITHIN = 120;

interface View {
  arc: number;
  hand: -1 | 0 | 1;
  forced: boolean;
  diverge: boolean;
  locked: boolean;
  straight: RoadInfo;
  branch: RoadInfo;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} KM`;
/** Distances to a tenth of a kilometre: what the panels show, and so what they re-render on. */
const roadKey = (r: RoadInfo) => `${r.name}|${r.kph}|${r.station?.name}|${r.station ? Math.round(r.station.m / 100) : ''}|${r.trainM === null ? 'n' : r.trainM < 0 ? 'c' : Math.round(r.trainM / 100)}`;

export function RouteChoice({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const [view, setView] = useState<View | null>(null);
  const [stamp, setStamp] = useState<{ name: string; seq: number } | null>(null);
  const ui = useUi();
  const uiRef = useRef(ui);
  useEffect(() => { uiRef.current = ui; }, [ui]);

  const rowRef = useRef<HTMLDivElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const lateRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    let shownKey = '';
    let shown: View | null = null;
    let lastD = Infinity;
    let refused = liveRouteChoice.refused;
    let lateTimer = 0;
    let stampTimer = 0;
    let seq = 0;
    let lastCaption = '';

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      const R = liveRouteChoice;
      // Forced points (a crossover's far end) are no choice, and get no panel.
      const live = R.active && !R.forced && R.straight && R.branch;

      // The points just went under the train: name where it went.
      if (shown && (!live || R.arc !== shown.arc) && lastD < TAKEN_WITHIN) {
        const went = shown.diverge ? shown.branch.name : shown.straight.name;
        seq += 1;
        setStamp({ name: went, seq });
        uiRef.current('toggleUp');
        window.clearTimeout(stampTimer);
        stampTimer = window.setTimeout(() => setStamp(null), STAMP_MS);
      }

      if (live && R.straight && R.branch) {
        const locked = R.forced || R.d <= ROUTE_LOCK;
        const key = `${R.arc}|${R.hand}|${R.forced}|${R.diverge}|${locked}|${roadKey(R.straight)}|${roadKey(R.branch)}`;
        if (key !== shownKey) {
          // Same points, the other road: the driver picked it.
          if (shown && shown.arc === R.arc && shown.diverge !== R.diverge) uiRef.current(R.diverge ? 'toggleUp' : 'toggleDown');
          shown = {
            arc: R.arc, hand: R.hand, forced: R.forced, diverge: R.diverge, locked,
            straight: { ...R.straight }, branch: { ...R.branch },
          };
          setView(shown);
          shownKey = key;
        }
        lastD = R.d;
      } else {
        if (shownKey) { setView(null); shownKey = ''; }
        shown = null;
        lastD = Infinity;
      }

      // A key after the lock: shake, and say why.
      if (R.refused !== refused) {
        refused = R.refused;
        lateRef.current = true;
        const row = rowRef.current;
        if (row) { row.style.animation = 'none'; void row.offsetWidth; row.style.animation = 'route-shake 360ms ease-out'; }
        window.clearTimeout(lateTimer);
        lateTimer = window.setTimeout(() => { lateRef.current = false; }, LATE_MS);
      }

      if (!live || !t) return;
      // The countdown to the lock.
      if (distRef.current) {
        distRef.current.textContent = `${Math.round(R.d / 10) * 10} M`;
        distRef.current.style.color = R.d > 250 ? INK : HUD.hot;
      }
      if (fillRef.current) {
        const f = Math.max(0, Math.min(1, (ROUTE_WINDOW - R.d) / (ROUTE_WINDOW - ROUTE_LOCK)));
        fillRef.current.style.transform = `scaleX(${f})`;
        fillRef.current.style.background = R.d > 250 ? INK : HUD.hot;
      }
      const kph = R.branch?.kph ?? 0;
      const tooFast = R.diverge && kph > 0 && t.speedKph > kph + 2 && R.d < 600;
      const caption = lateRef.current ? 'TOO LATE · ROUTE ALREADY LOCKED'
        : tooFast ? `BRAKE TO ${kph} FOR ${R.branch?.name}`
          : R.forced ? 'ROAD ENDS · ONLY ONE WAY ON'
            : R.d > ROUTE_LOCK ? `ROUTE LOCKS IN ${Math.round((R.d - ROUTE_LOCK) / 10) * 10} M`
              : 'ROUTE LOCKED';
      if (caption !== lastCaption && captionRef.current) {
        captionRef.current.textContent = caption;
        captionRef.current.style.color = lateRef.current || tooFast ? HUD.hot : R.d > ROUTE_LOCK && !R.forced ? HUD.muted : INK;
        lastCaption = caption;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(lateTimer);
      window.clearTimeout(stampTimer);
    };
  }, [telemetry]);

  // The left-hand road on the left: the diverging road when it turns left.
  const sides = view
    ? (view.hand < 0
      ? [{ road: view.branch, on: view.diverge, letter: 'A', arrow: 'left' as const }, { road: view.straight, on: !view.diverge, letter: 'D', arrow: 'up' as const }]
      : [{ road: view.straight, on: !view.diverge, letter: 'A', arrow: 'up' as const }, { road: view.branch, on: view.diverge, letter: 'D', arrow: view.hand > 0 ? 'right' as const : 'up' as const }])
    : [];

  return (
    <div className="pointer-events-none absolute left-1/2 top-[84px] grid -translate-x-1/2 justify-items-center gap-1">
      {stamp && !view && (
        <div
          key={stamp.seq}
          className="flex items-baseline gap-2.5 px-[22px] py-[7px]"
          style={{ background: PANEL, clipPath: CUT, animation: `route-stamp ${STAMP_MS}ms cubic-bezier(.2,.7,.2,1) both` }}
        >
          <b style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 12, letterSpacing: '0.14em', color: HUD.muted }}>ROUTE SET</b>
          <span className="italic leading-none" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, color: INK }}>{stamp.name}</span>
        </div>
      )}
      {view && (
        <>
          <div ref={rowRef} key={view.arc} className="flex items-stretch gap-1.5" style={{ animation: 'hud-in 260ms ease both' }}>
            {(view.forced ? sides.filter((s) => s.on) : [sides[0]]).map((s) => (
              <Road key={s.letter} {...s} locked={view.locked} forced={view.forced} />
            ))}
            <div className="grid w-[66px] content-center justify-items-center gap-0.5" style={{ background: PANEL, clipPath: CUT }}>
              <Fork hand={view.hand} diverge={view.diverge} />
              <span ref={distRef} className="leading-none" style={{ fontFamily: NUMERALS, fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: INK }}>—</span>
            </div>
            {!view.forced && <Road {...sides[1]} locked={view.locked} forced={false} />}
          </div>
          <div className="relative h-[2px] w-[538px]" style={{ background: 'rgba(255,255,255,0.12)' }}>
            <i ref={fillRef} className="absolute inset-0 block origin-left" style={{ transform: 'scaleX(0)', background: INK }} />
          </div>
          <div ref={captionRef} style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 9.5, letterSpacing: '0.16em', color: HUD.muted }}>&nbsp;</div>
        </>
      )}
    </div>
  );
}

const ARROWS = {
  left: 'M10 6H2M5 2.5L1.5 6 5 9.5',
  right: 'M2 6h8M7 2.5L10.5 6 7 9.5',
  up: 'M6 10.5V2M2.5 5L6 1.5 9.5 5',
};

function Road({ road, on, letter, arrow, locked, forced }: {
  road: RoadInfo; on: boolean; letter: string; arrow: keyof typeof ARROWS; locked: boolean; forced: boolean;
}) {
  const gone = locked && !on;
  return (
    <div
      className="relative grid w-[236px] grid-cols-[auto_1fr] items-center gap-x-2 py-1.5 pl-[11px] pr-[14px] transition-[opacity,transform,background] duration-150"
      style={{
        background: on ? PANEL : PANEL_SOFT, clipPath: CUT,
        opacity: gone ? 0 : on ? 1 : 0.55, transform: gone ? 'scale(0.92)' : 'none',
        boxShadow: on ? `inset 0 -2px 0 ${INK}` : 'none',
      }}
    >
      <span
        className="row-span-2 grid h-[21px] w-[21px] place-items-center rounded-[3px]"
        style={{
          background: on ? INK : 'rgba(255,255,255,0.14)', color: on ? '#08111a' : INK,
          fontFamily: DISPLAY, fontWeight: 800, fontSize: 12, opacity: forced ? 0 : 1,
        }}
      >
        {letter}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap leading-[1.1]" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 16, letterSpacing: '0.04em', color: INK }}>
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden>
          <path d={ARROWS[arrow]} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate">{road.name}</span>
      </span>
      <span className="flex gap-2 overflow-hidden whitespace-nowrap leading-[1.3]" style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 10, letterSpacing: '0.06em', color: HUD.muted }}>
        <span>{road.kph ? `${road.kph} KM/H` : 'LINE SPEED'}</span>
        {road.station && <span>{road.station.name} {km(road.station.m)}</span>}
        {road.trainM !== null && (
          <span>
            <i className="mr-1 inline-block h-[5px] w-[5px] rounded-full align-[1px]" style={{ background: road.trainM < 0 ? GREEN : HUD.way }} />
            {road.trainM < 0 ? 'CLEAR' : `TRAIN ${km(road.trainM)}`}
          </span>
        )}
      </span>
      {locked && on && (
        <span className="absolute right-3.5 top-1.5" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 9, letterSpacing: '0.16em', color: INK }}>LOCKED</span>
      )}
    </div>
  );
}

/** A small white sketch of the fork: your road bright with arrows running up it, the other faint. */
function Fork({ hand, diverge }: { hand: -1 | 0 | 1; diverge: boolean }) {
  const side = hand === 0 ? 1 : hand;
  const straight = 'M22 27V3';
  const branch = `M22 27V18C22 11 ${22 + side * 10} 9 ${22 + side * 16} 4`;
  return (
    <svg viewBox="0 0 44 28" width="44" height="27" fill="none" aria-hidden>
      <path d={diverge ? straight : branch} stroke="rgba(255,255,255,0.22)" strokeWidth="1.4" />
      <path d={diverge ? branch : straight} stroke={INK} strokeWidth="2" strokeLinecap="round" />
      <path
        d={diverge ? branch : straight}
        stroke="#08111a" strokeWidth="2.2" strokeDasharray="2 6"
        style={{ animation: 'route-flow 700ms linear infinite' }}
      />
    </svg>
  );
}
