'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CarFront, Gauge, Ship, TrainFront, Truck, type LucideIcon } from 'lucide-react';
import { SELECTED, type VehicleCategory } from '@/config/garage';
import { POINTWORK_ENABLED } from '@/config/pointwork';
import { STATION_NAME, STATION_SITE } from '@/config/stationConfig';
import { WORLD_ID } from '@/config/world';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { Minimap } from './Minimap';
import { PauseMenu, type MenuPage } from './PauseMenu';
import { barlowCondensed } from './garageFonts';
import type { GameSettings } from './gameSettings';
import { RacingTacho } from './RacingTacho';
import { RailPoints } from './RailPoints';
import { HudStrip } from './HudStrip';
import { driveHintsFeed, railAheadFeed } from './hudFeeds';
import { hudNumerals } from './hudFonts';
import { ACCENT, HATCH, HUD, LABEL, ON_ACCENT, PANEL, PANEL_CUT, accentAlpha } from './hudTheme';
import { useUi } from '@/hooks/useUiSound';
import { CATEGORIES } from '@/config/garage';

/** The category tag on the card — the garage's own word for it. */
const CATEGORY = (CATEGORIES.find((c) => c.id === SELECTED.category)?.label ?? SELECTED.category).toUpperCase();

const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: 'CHASE',
  close: 'CLOSE',
  cockpit: 'COCKPIT',
  // The rail vehicle's own views — see `RailCamera`.
  cab: 'CAB',
  nose: 'NOSE',
  top: 'TOP',
  cinematic: 'CINEMATIC',
  drone: 'DRONE',
};

/** Ignore a position jump larger than this, in metres per frame — that is a reset, not driving. */
const TELEPORT_M = 20;

interface RacingHUDProps {
  telemetry: RefObject<VehicleTelemetry>;
  cameraMode: CameraMode;
  settings: GameSettings;
  onSettingsChange: (next: Partial<GameSettings>) => void;
  /** Back to the garage. Shares its implementation with the G key. */
  onExit: () => void;
  /** Which pause-menu page is open, or null while driving. Owned by the scene. */
  menu: MenuPage | null;
  onMenu: (page: MenuPage | null) => void;
}

/**
 * Racing HUD: marks on glass, four corners, no panels.
 *
 * Laid out after the genre's convention — identity top-left, trip top-right,
 * map bottom-left, instruments bottom-right — but the two slots a race game
 * fills with a position board and a lap counter are given real numbers instead.
 * There are no opponents to rank and no laps to count here, and a HUD that
 * displays a standings table nobody is competing in is a decoration, not an
 * instrument. See `RacingTacho` for the same reasoning about the nitrous gauge.
 *
 * There is deliberately no clock. A timer running in the corner of a free-roam
 * drive is a scoreboard for a game nobody is playing — it invites you to beat
 * a number that measures nothing, and it is the one element on a HUD that never
 * stops demanding attention. Distance and best speed are records of what you
 * did; a stopwatch is a demand.
 *
 * Telemetry changes every frame, so none of it goes through React state — one
 * rAF loop writes into DOM nodes through refs. Only the camera label and the
 * controls panel, which change on a keypress, are React-driven.
 */
export function RacingHUD({
  telemetry, cameraMode, settings, onSettingsChange, onExit, menu, onMenu,
}: RacingHUDProps) {
  const distanceRef = useRef<HTMLSpanElement>(null);
  const distanceUnitRef = useRef<HTMLSpanElement>(null);
  const topSpeedRef = useRef<HTMLSpanElement>(null);
  // The pause menu shows the same three figures. Its spans are written by the
  // same loop, so there is one source of truth and nothing to snapshot; while
  // the menu is closed the refs are null and the writes are skipped. They are
  // guarded on the text they hold rather than on the loop's last value, because
  // the menu mounts fresh each time it opens and would otherwise keep its 0.
  /**
   * Which feeder the centre strip is reading, built once.
   *
   * A feeder holds its own edges and timers, so it must not be rebuilt on a
   * render or the boost notice would re-arm and the air timer restart.
   */
  const strip = useMemo(
    () => (SELECTED.rail === 'main'
      ? railAheadFeed(STATION_SITE ? { name: STATION_NAME, arc: STATION_SITE.arc } : null)
      : driveHintsFeed()),
    [],
  );
  const menuDistanceRef = useRef<HTMLSpanElement>(null);
  const menuUnitRef = useRef<HTMLSpanElement>(null);
  const menuBestRef = useRef<HTMLSpanElement>(null);
  /**
   * The trip: distance driven and the best speed seen.
   *
   * Accumulated here rather than in the physics step, because none of it is
   * physics — nothing reads these numbers back, and the step has no business
   * carrying state only a readout wants.
   */
  useEffect(() => {
    let frame = 0;
    let lastX = NaN;
    let lastZ = NaN;
    let metres = 0;
    let top = 0;
    let shownDistance = -1;
    let shownTop = -1;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;

      if (Number.isFinite(lastX)) {
        const step = Math.hypot(t.x - lastX, t.z - lastZ);
        // R teleports the car back to the road; that is not distance driven.
        if (step < TELEPORT_M) metres += step;
      }
      lastX = t.x;
      lastZ = t.z;

      if (t.speedKph > top) top = t.speedKph;

      const km = metres >= 1000;
      const value = km ? Math.round(metres / 100) / 10 : Math.round(metres);
      const text = km ? value.toFixed(1) : String(value);
      const unit = km ? 'KM' : 'M';
      if (value !== shownDistance) {
        if (distanceRef.current) distanceRef.current.textContent = text;
        if (distanceUnitRef.current) distanceUnitRef.current.textContent = unit;
        shownDistance = value;
      }
      const menuDistance = menuDistanceRef.current;
      if (menuDistance && menuDistance.textContent !== text) menuDistance.textContent = text;
      const menuUnit = menuUnitRef.current;
      if (menuUnit && menuUnit.textContent !== unit) menuUnit.textContent = unit;

      const best = Math.round(top);
      const bestText = String(best);
      if (best !== shownTop) {
        if (topSpeedRef.current) topSpeedRef.current.textContent = bestText;
        shownTop = best;
      }
      const menuBest = menuBestRef.current;
      if (menuBest && menuBest.textContent !== bestText) menuBest.textContent = bestText;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry]);

  return (
    // The numeral face is declared here and inherited by every cluster below,
    // including the dial's SVG numerals.
    <div
      className={`${hudNumerals.variable} ${barlowCondensed.variable} pointer-events-none absolute inset-0 select-none font-sans`}
    >
      {/* ------------------------------------------------- identity, top-left ---
          One bar, not a stack. Tag, name, and the metre-line all on a single
          row of one panel — the way a broadcast graphic sets a driver's name —
          so the corner is a header rather than a paragraph. The route indicator
          on the main-line train hangs off the same column below it, on a panel
          of its own with the same chamfer. */}
      {/* The top row is ONE flex row — identity, strip, pause — not three
          absolutely positioned things that have to be kept apart with width
          caps. The identity bar shrinks (its name truncates) before anything
          overlaps; the strip takes the middle and centres itself in whatever
          is left; the pause control never shrinks. */}
      <div
        className="absolute inset-x-7 top-7 flex items-start gap-4"
        style={{ animation: 'hud-in 520ms cubic-bezier(0.2, 0.7, 0.2, 1) both' }}
      >
      {/* `relative` so the route indicator can hang below the bar without
          taking part in the row: it is wider than the bar and would otherwise
          squeeze the strip out of the middle. */}
      <div className="relative flex shrink flex-col items-start">
        <div className="relative flex max-w-full items-stretch" style={{ ...PANEL, clipPath: PANEL_CUT }}>
          {/* The category as a glyph on the accent slab — a chequered flag, a
              coupe, a pickup, a locomotive, a hull — rather than as a word.
              The word was the one label on the bar nobody needed to read. */}
          <span
            className="flex w-[52px] shrink-0 items-center justify-center"
            style={{ background: ACCENT, color: ON_ACCENT }}
            title={CATEGORY}
            aria-label={CATEGORY}
          >
            <CategoryGlyph />
          </span>
          {/* A hatched sliver off the end of the tag — the livery stripe every
              racing game paints on its cards. Decoration, and deliberately the
              only decoration on the bar. */}
          <span aria-hidden className="w-[14px] shrink-0" style={HATCH} />
          {/* No `min-w-0` here: the row must respect the name's 120 px floor
              rather than shrink past it and let the clip-path eat the name. */}
          <div className="flex items-center gap-4 py-2.5 pl-4 pr-7">
            {/* The name never gives way; the camera label drops below `lg`, which
                is what keeps the centre strip whole on a narrow window.
                The year and drive that used to follow the name are gone — they
                are garage facts, and the garage already states them. */}
            <span
              // Shrinkable, but never below 120 px: on a narrow window the bar
              // gives the strip room by clipping the *end* of a long name with
              // an ellipsis rather than by pushing the strip off the row.
              className="min-w-[120px] truncate italic leading-none"
              style={{
                fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800, letterSpacing: '0.01em',
                color: HUD.text,
              }}
            >
              {SELECTED.label.toUpperCase()}
            </span>
            <span aria-hidden className="hidden h-6 w-px shrink-0 lg:block" style={{ background: 'rgba(255,255,255,0.18)' }} />
            <span
              className="hidden shrink-0 items-center gap-1.5 leading-none lg:flex"
              style={{ ...LABEL, fontSize: 14, color: ACCENT }}
            >
              <svg width="13" height="11" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <rect x="0.7" y="2.2" width="7.6" height="6.6" rx="0.8" />
                <path d="M8.3 4.4l3-1.6v4.4l-3-1.6" />
              </svg>
              {CAMERA_LABEL[cameraMode]}
            </span>
          </div>
        </div>
        {/* The speed line: a two-pixel accent rule that runs out from under the
            bar and fades — the streak every racing-game card trails. */}
        <span
          aria-hidden
          className="mt-1 h-[2px] w-[130%]"
          style={{ background: `linear-gradient(90deg, ${ACCENT} 0%, ${accentAlpha(0.5)} 45%, transparent 100%)` }}
        />

        {/* The route indicator. Only the main-line train has roads to choose
            between — see `pointwork`. */}
        {SELECTED.rail === 'main' && POINTWORK_ENABLED && (
          <div
            className="absolute left-0 top-full mt-2"
            style={{ animation: 'hud-in 520ms cubic-bezier(0.2, 0.7, 0.2, 1) 120ms both' }}
          >
            <RailPoints telemetry={telemetry} />
          </div>
        )}
      </div>

      {/* --------------------------------------------------- the strip, centre ---
          One shape, one message, and the content is whatever this vehicle has
          to say: the line ahead on the main-line train, the driving hints on
          anything with wheels. Transient either way — see `HudStrip`. */}
      <div className="flex min-w-[260px] flex-1 justify-center">
        <HudStrip telemetry={telemetry} read={strip} />
      </div>

      {/* ------------------------------------------------- pause, top-right ---
          On its own. It used to head a column with the trip figures under it,
          which stacked three unrelated things into one tall slab; the figures
          have gone to live under the speedometer, where an odometer belongs. */}
      <PauseButton onClick={() => onMenu('menu')} />
      </div>

      {/* --------------------------------------------------- map, bottom-left ---
          City only; the procedural circuit has no street network to navigate. */}
      {WORLD_ID === 'city' && <Minimap telemetry={telemetry} />}

      {/* ------------------------------------- instruments, bottom-right --- */}
      <RacingTacho
        telemetry={telemetry}
        distanceRef={distanceRef}
        unitRef={distanceUnitRef}
        bestRef={topSpeedRef}
      />

      {menu && (
        <PauseMenu
          page={menu}
          onPage={onMenu}
          onResume={() => onMenu(null)}
          onGarage={onExit}
          settings={settings}
          onSettingsChange={onSettingsChange}
          distanceRef={menuDistanceRef}
          unitRef={menuUnitRef}
          bestRef={menuBestRef}
        />
      )}

    </div>
  );
}

/**
 * The one clickable thing on the HUD while driving: the pause glyph on a panel
 * of the same cut as every other panel, with the accent as its leading edge.
 * Icon only, no hexagon — the control should look like a piece of the dash,
 * not a badge pinned to it.
 */
function PauseButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const ui = useUi();
  return (
    <button
      type="button"
      title="Pause (Esc)"
      aria-label="Pause"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      // The press itself is heard through the menu opening — see `RacingScene`.
      onPointerEnter={() => { setHover(true); ui('hover'); }}
      onPointerLeave={() => setHover(false)}
      className="pointer-events-auto flex h-[46px] shrink-0 items-stretch transition-transform duration-150"
      style={{ ...PANEL, clipPath: PANEL_CUT, transform: hover ? 'scale(1.05)' : 'none' }}
    >
      <span aria-hidden className="w-[4px]" style={{ background: ACCENT }} />
      <span
        className="flex w-[50px] items-center justify-center"
        style={{ background: hover ? accentAlpha(0.22) : 'transparent' }}
      >
        <svg width="14" height="16" viewBox="0 0 12 14" fill={hover ? '#ffffff' : ACCENT} aria-hidden>
          <rect x="1" y="1" width="3.6" height="12" />
          <rect x="7.4" y="1" width="3.6" height="12" />
        </svg>
      </span>
      <span aria-hidden className="w-[10px]" style={HATCH} />
    </button>
  );
}

/**
 * One icon per garage category, on the accent slab — Lucide's set, so the five
 * share one stroke weight, one corner radius and one optical size, which is
 * what hand-drawn glyphs never quite manage. 2.4 stroke at 26 px reads as a
 * badge rather than a wire drawing.
 */
const CATEGORY_ICON: Record<VehicleCategory, LucideIcon> = {
  performance: Gauge,
  street: CarFront,
  utility: Truck,
  rail: TrainFront,
  marine: Ship,
};

function CategoryGlyph() {
  const Icon = CATEGORY_ICON[SELECTED.category];
  return <Icon size={26} strokeWidth={2.4} absoluteStrokeWidth aria-hidden />;
}
