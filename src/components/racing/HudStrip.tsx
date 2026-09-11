'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { Flame, Gauge, Info, MapPin, RotateCcw, TrainFront, TriangleAlert, Wind, type LucideIcon } from 'lucide-react';
import { HATCH, HUD, INK, LABEL, NUM, PANEL, PANEL_CUT } from './hudTheme';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * The transient strip in the HUD's top centre, and the one shape every category
 * says its piece through.
 *
 * Presentation only. What to say is a **feeder** — a function of the telemetry
 * and the frame's delta that returns one message or nothing — so a category is
 * added by writing a function rather than by writing another strip. The rail
 * line's forward view (`railAheadFeed`) and the car's driving hints
 * (`driveHintsFeed`) are the two so far; a G-meter or an attitude readout would
 * be a third and a fourth without touching anything here.
 *
 * The strip is **transient**: it fades in when the feeder has something and out
 * when it does not. That is the design, not a saving. A readout that is always
 * on screen becomes wallpaper and stops being read exactly when it starts to
 * matter, so the strip's *presence* is the first piece of information — the same
 * rule the rest of this HUD follows.
 *
 * Same discipline too: no React state, one rAF loop, text and opacity written
 * through refs, and nothing rewritten that has not changed.
 */

export type StripLevel = 'note' | 'warn' | 'danger';

/**
 * What the message is about, as a picture. Contextual rather than a generic
 * "info" mark: a game's notice card shows a lightning bolt for boost and a
 * station pin for a station, and the driver reads the icon before the words.
 */
export type StripIcon = 'info' | 'warn' | 'station' | 'train' | 'limit' | 'boost' | 'air' | 'flip';

export interface StripMessage {
  level: StripLevel;
  /** Defaults to the level's own mark. */
  icon?: StripIcon;
  /** The thing being said. Short — it is read at a glance or not at all. */
  label: string;
  /** A key to press, drawn as a cap. The affordance, where there is one. */
  cap?: string;
  /** The number, if the message has one, with its unit beside it. */
  figure?: string;
  unit?: string;
  /** The qualifier, in the quiet type at the end. */
  note?: string;
}

/**
 * A feeder holds its own state — edges, timers, whether a hint has been shown —
 * so it is built once and called every frame.
 */
export type StripFeed = (t: VehicleTelemetry, dt: number) => StripMessage | null;

const INK_FOR: Record<StripLevel, string> = {
  note: HUD.cyan,
  warn: HUD.way,
  danger: HUD.hot,
};

/** Seconds of fade. Long enough not to blink, short enough to read as an alert. */
const FADE = 0.22;

/** The glyph in the level square: information, caution, danger. */
/** Every icon the square can show, in DOM order; the current one is displayed, the rest hidden. */
const ICONS: [StripIcon, LucideIcon][] = [
  ['info', Info], ['warn', TriangleAlert], ['station', MapPin], ['train', TrainFront],
  ['limit', Gauge], ['boost', Flame], ['air', Wind], ['flip', RotateCcw],
];
const LEVEL_ICON: Record<StripLevel, StripIcon> = { note: 'info', warn: 'warn', danger: 'warn' };

export function HudStrip({ telemetry, read }: {
  telemetry: RefObject<VehicleTelemetry>;
  read: StripFeed;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const cap = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const unit = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const dot = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    let shown = 0;
    let last = '';
    let clock = performance.now();

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t || !wrap.current) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - clock) / 1000);
      clock = now;

      const message = read(t, dt);
      const want = message ? 1 : 0;
      shown += (want - shown) * (1 - Math.pow(0.5, dt / FADE));
      const gone = shown < 0.01;
      wrap.current.style.opacity = gone ? '0' : shown.toFixed(3);
      // Out of the compositor's work entirely once it has faded.
      wrap.current.style.visibility = gone ? 'hidden' : 'visible';
      if (!message) return;

      const key = `${message.level}|${message.icon ?? ''}|${message.cap ?? ''}|${message.label}`
        + `|${message.figure ?? ''}|${message.unit ?? ''}|${message.note ?? ''}`;
      if (key === last) return;
      last = key;
      const colour = INK_FOR[message.level];
      if (bar.current) {
        bar.current.style.background = colour;
        // Three icons live in the square; show the one for this level.
        const want = message.icon ?? LEVEL_ICON[message.level];
        const icons = bar.current.children;
        for (let i = 0; i < icons.length; i++) {
          (icons[i] as HTMLElement).style.display = ICONS[i][0] === want ? 'block' : 'none';
        }
      }
      if (cap.current) {
        cap.current.textContent = message.cap ?? '';
        cap.current.hidden = !message.cap;
      }
      if (label.current) {
        label.current.textContent = message.label;
        label.current.style.color = colour;
      }
      if (value.current) {
        value.current.textContent = message.figure ?? '';
        value.current.style.color = colour;
        value.current.hidden = !message.figure;
      }
      if (unit.current) {
        unit.current.textContent = message.unit ?? '';
        unit.current.hidden = !message.unit;
      }
      if (dot.current) dot.current.hidden = !message.note;
      if (note.current) {
        note.current.textContent = message.note ?? '';
        note.current.hidden = !message.note;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry, read]);

  return (
    <div
      ref={wrap}
      // Centred on the screen and capped so it can reach neither the name
      // banner on its left nor the pause hexagon on its right — see the note in
      // `RacingHUD`.
      className="min-w-0 max-w-[520px]"
      style={{ opacity: 0, visibility: 'hidden' }}
    >
      <div
        className="flex items-stretch"
        style={{ ...PANEL, clipPath: PANEL_CUT }}
      >
        {/* The accent edge, which is the level. Same device as the name plate's. */}
        {/* The badge: a slab in the level colour, the icon in dark ink, and a
            hatched tail — the same livery the identity bar wears. */}
        <span
          ref={bar}
          aria-hidden
          className="flex w-[44px] shrink-0 items-center justify-center"
          style={{ color: '#08111a', background: HUD.cyan }}
        >
          {ICONS.map(([name, Icon], i) => (
            <Icon key={name} size={24} strokeWidth={2.4} absoluteStrokeWidth style={{ display: i === 0 ? 'block' : 'none' }} />
          ))}
        </span>
        <span aria-hidden className="w-[10px] shrink-0" style={HATCH} />
        <div className="flex items-center gap-3 py-3 pl-5 pr-7">
          {/* The key to press, where the message is an affordance rather than a
              statement. Same cap the route indicator draws for `T`. */}
          <span
            ref={cap}
            aria-hidden
            hidden
            className="px-2 py-[4px] leading-none"
            style={{
              ...LABEL, fontSize: 12, letterSpacing: '0.08em', color: HUD.text,
              border: `1px solid rgba(255,255,255,0.45)`, background: 'rgba(0,0,0,0.45)',
              clipPath: 'polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px)',
            }}
          />
          {/* NOT `whitespace-nowrap`. The label is the variable part — a
              station name, not a fixed word — and holding it on one line made
              the strip wider than its own cap, so "KESTREL ISLAND" overflowed
              into the pause hexagon. Wrapping is what keeps the box inside the
              width it was given; a two-line strip is fine and a strip that
              runs under a button is not. */}
          <span
            ref={label}
            className="leading-tight"
            style={{ ...LABEL, fontSize: 16, ...INK }}
          />
          <span
            ref={value}
            hidden
            className="leading-none"
            style={{ ...NUM, fontSize: 28, fontWeight: 700, letterSpacing: '0.02em', ...INK }}
          />
          <span
            ref={unit}
            hidden
            className="leading-none"
            style={{ ...LABEL, fontSize: 12, color: HUD.muted, ...INK }}
          />
          {/* The qualifier is the first thing to go on a narrow window — below
              `lg` the strip has to share the top row with a full name bar. */}
          <span ref={dot} aria-hidden hidden className="max-lg:!hidden" style={{ color: HUD.faint }}>·</span>
          <span
            ref={note}
            hidden
            className="whitespace-nowrap leading-none max-lg:!hidden"
            style={{ ...LABEL, fontSize: 12, color: HUD.muted, ...INK }}
          />
        </div>
      </div>
    </div>
  );
}
