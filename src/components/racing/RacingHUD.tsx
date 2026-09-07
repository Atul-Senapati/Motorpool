'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import { WORLD_ID } from '@/config/world';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import { Minimap } from './Minimap';
import { PauseMenu, type MenuPage } from './PauseMenu';
import { barlowCondensed } from './garageFonts';
import type { GameSettings } from './gameSettings';
import { RacingTacho } from './RacingTacho';
import { hudNumerals } from './hudFonts';
import { HUD, INK, NUM } from './hudTheme';

/**
 * Brand over model. Every label here is "Make Model ...", so the first word is
 * the make; a one-word label has no brand line and is shown as the model.
 */
const [BRAND_WORD, ...MODEL_WORDS] = SELECTED.label.toUpperCase().split(' ');
const BRAND = MODEL_WORDS.length ? BRAND_WORD : '';
const MODEL = MODEL_WORDS.length ? MODEL_WORDS.join(' ') : BRAND_WORD;

const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: 'CHASE',
  close: 'CLOSE',
  cockpit: 'COCKPIT',
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
      {/* ---------------------------------------------- identity, top-left ---
          A banner, not a plate. It bleeds in from the screen edge and fades to
          nothing on the right, so there is no box to look at — just a dark
          ground under the type where the type is. The name is split into brand
          over model, which is how every game's car card sets it: the brand is
          the small tracked line that tells you what you are looking at, the
          model is the big line that is the actual identity.

          Three plates came before this. Each was a shape with edges, and the
          eye kept reading the shape instead of the name. */}
      <div className="absolute left-0 top-6 flex max-w-[60%] items-stretch">
        <span
          aria-hidden
          className="w-[3px] shrink-0"
          style={{ background: HUD.cyan, boxShadow: '0 0 12px rgba(79,219,232,0.65)' }}
        />
        <div
          className="min-w-0 py-2.5 pl-5 pr-20"
          style={{
            background: 'linear-gradient(90deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.36) 55%, rgba(0,0,0,0) 100%)',
          }}
        >
          {BRAND && (
            <div
              className="leading-none"
              style={{
                fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.36em',
                color: HUD.cyan, ...INK,
              }}
            >
              {BRAND}
            </div>
          )}
          <div
            className="mt-1 truncate italic leading-[0.94]"
            style={{
              fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, letterSpacing: '0.005em',
              color: '#ffffff', textShadow: '0 2px 3px rgba(0,0,0,0.95), 0 0 14px rgba(0,0,0,0.6)',
            }}
          >
            {MODEL}
          </div>
          <div
            className="mt-2 flex items-center gap-2.5 leading-none"
            style={{ fontSize: 9, letterSpacing: '0.24em', color: HUD.muted, fontWeight: 700, ...INK }}
          >
            <span style={NUM}>{SELECTED.year}</span>
            <span style={{ color: HUD.faint }}>·</span>
            <span>{SELECTED.drive.toUpperCase()}</span>
            <span style={{ color: HUD.faint }}>·</span>
            <span style={{ color: HUD.cyan }}>{CAMERA_LABEL[cameraMode]}</span>
          </div>

          {/* The McLaren asset is CC BY-NC 4.0, which requires attribution
              wherever the work is used. Kept quiet but kept. */}
          {SELECTED.id === 'mclaren' && (
            <div className="mt-2" style={{ fontSize: 8.5, letterSpacing: '0.08em', color: HUD.muted, ...INK }}>
              Model by Alex.Ka. · CC BY-NC 4.0
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- pause, top-right ---
          On its own. It used to head a column with the trip figures under it,
          which stacked three unrelated things into one tall slab; the figures
          have gone to live under the speedometer, where an odometer belongs. */}
      <PauseButton onClick={() => onMenu('menu')} />

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
 * The one clickable thing on the HUD while driving.
 *
 * A hexagon with the pause glyph, outlined in the accent with a glow on hover.
 * Everything else — settings, controls, leaving — lives in the menu behind it,
 * the way it does in every racing game, so the HUD carries one control instead
 * of a toolbar. The hexagon is a `clip-path`, and the outline is the trick
 * that shape forces: the accent is the outer background and the dark face is an
 * inset child clipped to the same polygon.
 */
function PauseButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const cut = 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)';
  return (
    <button
      type="button"
      title="Pause (Esc)"
      aria-label="Pause"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="pointer-events-auto absolute right-6 top-6 h-[40px] w-[40px] p-px transition-[filter,transform] duration-150"
      style={{
        clipPath: cut,
        background: hover ? HUD.cyan : 'rgba(79,219,232,0.5)',
        filter: hover ? 'drop-shadow(0 0 10px rgba(79,219,232,0.6))' : 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))',
        transform: hover ? 'scale(1.06)' : 'none',
      }}
    >
      <span
        className="flex h-full w-full items-center justify-center"
        style={{ clipPath: cut, background: hover ? 'rgba(79,219,232,0.18)' : 'rgba(0,0,0,0.5)' }}
      >
        <svg width="13" height="14" viewBox="0 0 12 14" fill={hover ? '#dffbff' : HUD.cyan}>
          <rect x="1" y="1" width="3.6" height="12" rx="0.7" />
          <rect x="7.4" y="1" width="3.6" height="12" rx="0.7" />
        </svg>
      </span>
    </button>
  );
}
