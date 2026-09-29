'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import type { VehicleTelemetry } from '@/types/vehicle';
import { ACCENT, HATCH, HUD, LABEL, NUM, PANEL, PANEL_CUT, accentAlpha } from './hudTheme';
import { useUi } from '@/hooks/useUiSound';

/**
 * Where you are, in world metres, as a tab under the compass.
 *
 * Every other readout on this HUD is for the driver. This one is for the
 * person editing the world: the whole project is laid out in world
 * coordinates — `AIRFIELD_DECO` places a container at an (x, z), `STATION_SITE`
 * is a point on the map, a spawn is `?at=x,z,y,heading` — and until now the
 * only way to answer "what are the coordinates of the thing I am looking at"
 * was to fly a drone there and read them out of a console probe. Driving to a
 * spot and reading the number off the glass is the same answer in one step.
 *
 * So it is a navigation instrument and it is placed as one, in the map's own
 * column, in the map's own panel and cut. The two facts it adds are the two
 * the compass tab does not have: which point of the map you are standing on,
 * and — on the main line, where the railway is measured in arc length and not
 * in x and z — how far along the line you are.
 *
 * **Click it and the spawn is on your clipboard**, as the `?at=` query the
 * config parses (`pickCitySpawn`, `pickAirSpawn`): position, height and
 * heading, so the URL puts a camera back exactly where the reading was taken
 * rather than approximately near it. That is the half of this that makes it
 * worth the pixels — a number you can read is a number you then have to type
 * without a typo, and a four-part one you will.
 *
 * Written from a rAF loop into DOM nodes, like every other live figure here.
 * Nothing in it is React state except the copy flash, which is an event.
 */

/** How long the tab confirms a copy before going back to the numbers, ms. */
const FLASH_MS = 1400;

/** A world metre, rounded the way a config file states one. */
const metre = (v: number) => Math.round(v).toString();

export function PositionFix({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const xRef = useRef<HTMLSpanElement>(null);
  const zRef = useRef<HTMLSpanElement>(null);
  const altRef = useRef<HTMLSpanElement>(null);
  const arcRef = useRef<HTMLSpanElement>(null);
  /**
   * The `?at=` string for wherever the vehicle is *now*.
   *
   * Held in a ref and rewritten by the same loop that writes the spans, so the
   * click handler never has to read telemetry itself and the thing copied is
   * exactly the thing displayed at the moment of the click.
   */
  const fix = useRef('');
  const [flash, setFlash] = useState(false);
  const [hover, setHover] = useState(false);
  const ui = useUi();

  /** Altitude on an aircraft, arc on the main line; neither on anything else. */
  const showAlt = Boolean(SELECTED.air);
  const showArc = SELECTED.rail === 'main';

  useEffect(() => {
    let frame = 0;
    let lastX = '';
    let lastZ = '';
    let lastAlt = '';
    let lastArc = '';

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;

      const x = metre(t.x);
      const z = metre(t.z);
      if (x !== lastX) {
        if (xRef.current) xRef.current.textContent = x;
        lastX = x;
      }
      if (z !== lastZ) {
        if (zRef.current) zRef.current.textContent = z;
        lastZ = z;
      }
      if (showAlt) {
        // Height over the sea, not over the ground: `y` is what `?at=` takes,
        // and a drone that reads 45 m AGL over a 60 m hill does not spawn
        // where a 45 in the URL would put it. The tacho already shows AGL,
        // which is the pilot's figure; this one is the map's.
        const alt = metre(t.y);
        if (alt !== lastAlt) {
          if (altRef.current) altRef.current.textContent = alt;
          lastAlt = alt;
        }
      }
      if (showArc) {
        const arc = metre(t.railArc);
        if (arc !== lastArc) {
          if (arcRef.current) arcRef.current.textContent = arc;
          lastArc = arc;
        }
      }

      // Degrees, because that is what the parser reads — see `pickCitySpawn`,
      // which multiplies by π/180. Normalised the way the compass label is,
      // for the reason given there: the drone's yaw accumulates past a turn.
      const heading = Math.round(((((t.heading * 180) / Math.PI) % 360) + 360) % 360);
      fix.current = `?at=${x},${z},${Math.round(t.y)},${heading}`;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry, showAlt, showArc]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const copy = () => {
    ui('select');
    // `writeText` rejects outside a secure context and wherever the permission
    // is refused. The tab says so rather than pretending: the numbers are on
    // the glass either way, and a silent no-op is the one outcome that wastes
    // somebody's time.
    navigator.clipboard?.writeText(fix.current)
      .then(() => setFlash(true))
      .catch(() => {});
  };

  return (
    <button
      type="button"
      title="Copy this position as ?at=x,z,y,heading"
      onMouseDown={(event) => event.preventDefault()}
      onClick={copy}
      onPointerEnter={() => { setHover(true); ui('hover'); }}
      onPointerLeave={() => setHover(false)}
      className="pointer-events-auto -mt-1 flex items-center gap-3 px-4 py-1.5 transition-colors duration-150"
      style={{
        ...PANEL,
        clipPath: PANEL_CUT,
        borderBottom: `2px solid ${accentAlpha(hover ? 0.7 : 0.35)}`,
      }}
    >
      {/* The surveyor's mark: a ringed crosshair, which is what this tab is —
          a fix, not a direction. The compass above it has the arrow. */}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden
        stroke={flash ? HUD.text : ACCENT} strokeWidth="1.3"
      >
        <circle cx="6" cy="6" r="3.2" />
        <path d="M6 0v2.2M6 9.8V12M0 6h2.2M9.8 6H12" />
      </svg>

      {flash ? (
        <span style={{ ...LABEL, fontSize: 12, color: ACCENT }}>SPAWN COPIED</span>
      ) : (
        <span className="flex items-center gap-3">
          <Axis label="X" valueRef={xRef} />
          <Axis label="Z" valueRef={zRef} />
          {showAlt && <Axis label="Y" valueRef={altRef} />}
          {/* The railway's own coordinate. A train is placed on this line by
              arc length — every station, signal and gradient in `trainConfig`
              is written as one — so on the main line the metre along the line
              is the number worth reading, and x and z are where that lands. */}
          {showArc && <Axis label="ARC" valueRef={arcRef} />}
        </span>
      )}

      <span aria-hidden className="-mr-2 h-4 w-[10px] shrink-0" style={HATCH} />
    </button>
  );
}

/** One labelled figure: a faint axis letter and the metre beside it. */
function Axis({ label, valueRef }: { label: string; valueRef: RefObject<HTMLSpanElement | null> }) {
  return (
    <span className="flex items-baseline gap-1">
      <span style={{ ...LABEL, fontSize: 10, color: HUD.faint }}>{label}</span>
      <span
        ref={valueRef}
        // A fixed floor rather than a natural width: the figures are tabular,
        // but "-1006" and "-84" are not the same number of them, and a tab
        // that resizes as you drive across the map is a tab that twitches.
        className="min-w-[38px] text-right"
        style={{ ...NUM, fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', color: HUD.text }}
      >
        0
      </span>
    </span>
  );
}
