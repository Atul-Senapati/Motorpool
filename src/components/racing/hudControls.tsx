'use client';

import type { ReactNode } from 'react';
import { HUD } from './hudTheme';

/**
 * The form controls the pause menu's pages are built from.
 *
 * These used to sit alongside a modal shell. The shell went when the three
 * HUD buttons became a single pause menu — one overlay with pages, rather than
 * separate pop-ups — and only the controls were worth keeping.
 */

/** A labelled row: name on the left, control on the right. */
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div style={{ fontSize: 10, letterSpacing: '0.2em', color: HUD.text, fontWeight: 600 }}>
          {label}
        </div>
        {hint && (
          <div className="mt-1" style={{ fontSize: 9.5, letterSpacing: '0.02em', color: HUD.faint }}>
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * A segmented control. Used for anything with a small fixed set of choices,
 * which is every setting here except the two sliders.
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
  return (
    <div className="flex overflow-hidden rounded" style={{ border: `1px solid ${HUD.line}` }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(option.value)}
            className="px-2.5 py-1.5 transition-colors"
            style={{
              fontSize: 9.5,
              letterSpacing: '0.14em',
              fontWeight: 700,
              color: active ? '#04222b' : HUD.muted,
              background: active ? HUD.cyan : 'transparent',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A slider with its value shown, for the two continuous settings. */
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
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onMouseDown={(event) => event.currentTarget.focus({ preventScroll: true })}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-[128px]"
        style={{ accentColor: HUD.cyan }}
      />
      <span
        className="w-[44px] text-right tabular-nums"
        style={{ fontSize: 10, color: HUD.text, fontWeight: 600 }}
      >
        {format(value)}
      </span>
    </div>
  );
}
