'use client';

import { useRef, type ReactNode } from 'react';
import { useUi } from '@/hooks/useUiSound';
import { ACCENT, HUD, NUM, ON_ACCENT, accentAlpha } from './hudTheme';

/**
 * The form controls the pause menu's pages are built from.
 *
 * These used to be a small web form under a cinematic header: 10 px labels,
 * rounded pills, a native range input, hints at 56% white. Read over a live
 * scene that is not a settings page, it is a dialog. What a game's options
 * screen is instead is **rows** — the full width of the column, tall enough to
 * hit, the name large, the value on the right, and a selection band on the one
 * you are on. The same band, cut on the same slant, as the main menu's items,
 * so the two pages read as one menu rather than a menu and a form.
 */

/** The slant every band and cap in this menu is cut on. */
const CUT = 'polygon(0 0, 100% 0, calc(100% - 18px) 100%, 0 100%)';

/** A labelled row: name and hint on the left, control on the right, band on hover. */
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const ui = useUi();
  return (
    <div
      className="group relative flex min-h-[58px] items-center justify-between gap-6 py-2.5 pl-5 pr-4"
      // The band lights on hover, so the row makes the sound rather than the
      // control inside it: crossing from the label to the buttons is one row,
      // and should be one tick.
      onPointerEnter={() => ui('hover')}
    >
      {/* The band. Opacity rather than mount, so it fades instead of popping. */}
      <span
        aria-hidden
        className="absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
        style={{
          clipPath: CUT,
          background: `linear-gradient(90deg, ${accentAlpha(0.22)} 0%, ${accentAlpha(0.06)} 60%, transparent 100%)`,
          borderLeft: `3px solid ${ACCENT}`,
        }}
      />
      <div className="relative min-w-0">
        <div style={{ fontSize: 12.5, letterSpacing: '0.22em', color: HUD.text, fontWeight: 700 }}>
          {label}
        </div>
        {hint && (
          <div className="mt-1" style={{ fontSize: 10.5, letterSpacing: '0.02em', color: HUD.muted }}>
            {hint}
          </div>
        )}
      </div>
      <div className="relative shrink-0">{children}</div>
    </div>
  );
}

/**
 * A segmented control, for anything with a small fixed set of choices.
 *
 * `onMouseDown` preventDefault keeps focus off the button. Otherwise the button
 * keeps focus after a click and SPACE — the handbrake — activates it again
 * instead of reaching the car.
 */
export function Segmented<T extends string | number | boolean>({
  options, value, onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const ui = useUi();
  const chosen = options.findIndex((option) => option.value === value);
  return (
    <div
      className="flex overflow-hidden"
      style={{
        border: `1px solid ${accentAlpha(0.45)}`,
        clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)',
      }}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              // Which way the setting went, so the toggle can rise or fall.
              //
              // Position was the first rule — right is up — and it is right
              // for TRAFFIC, whose options run OFF, LOW, MEDIUM, FULL. It is
              // backwards for every ON/OFF row, because `ON_OFF` puts ON
              // first, so turning something off moved RIGHT and chimed upward.
              // A boolean knows its own direction and does not need the
              // layout's opinion; everything else still reads it off the row.
              const rising = typeof option.value === 'boolean' ? option.value : index > chosen;
              if (active) ui('select');
              else ui(rising ? 'toggleUp' : 'toggleDown');
              onChange(option.value);
            }}
            className="min-w-[52px] px-3.5 py-2 transition-colors hover:bg-white/10"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.16em',
              fontWeight: 700,
              color: active ? ON_ACCENT : HUD.muted,
              background: active ? ACCENT : 'transparent',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A slider with its value shown, for the continuous settings. */
export function Slider({
  value, min, max, step, onChange, format,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}) {
  const ui = useUi();
  const lastTick = useRef(0);
  return (
    <div className="flex items-center gap-4">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onMouseDown={(event) => event.currentTarget.focus({ preventScroll: true })}
        onChange={(event) => {
          // A brightness slider is 50 steps wide and a drag across it fires
          // every one of them; at 40 ms apart that is a ratchet you can hear
          // rather than a swarm. The carriage slider's 11 steps all tick.
          const now = performance.now();
          if (now - lastTick.current > 40) { lastTick.current = now; ui('tick'); }
          onChange(Number(event.target.value));
        }}
        className="w-[168px]"
        style={{ accentColor: ACCENT }}
      />
      <span
        className="w-[52px] text-right"
        style={{ ...NUM, fontSize: 13, color: HUD.text, fontWeight: 700 }}
      >
        {format(value)}
      </span>
    </div>
  );
}
