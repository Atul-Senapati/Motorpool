'use client';

import { useEffect, useState } from 'react';
import type { RawInput } from '@/hooks/useKeyboardControls';
import type { RefObject } from 'react';

interface TouchControlsProps {
  input: RefObject<RawInput>;
  onCamera: () => void;
}

/**
 * Minimal touch layer for phones and tablets.
 *
 * Desktop keyboard driving is the priority, so this only mounts when the
 * primary pointer is coarse — it never sits on top of a mouse-driven session.
 * Buttons write straight into the same input ref the keyboard uses, so the
 * physics has no idea which one produced a given frame.
 */
export function TouchControls({ input, onCamera }: TouchControlsProps) {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setIsTouch(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  if (!isTouch) return null;

  const hold = (apply: (i: RawInput, active: boolean) => void) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      if (input.current) apply(input.current, true);
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (input.current) apply(input.current, false);
    },
    onPointerCancel: () => {
      if (input.current) apply(input.current, false);
    },
  });

  const buttonClass =
    'pointer-events-auto flex h-16 w-16 select-none items-center justify-center rounded-full ' +
    'border border-white/15 bg-black/35 text-lg font-medium text-white/85 backdrop-blur-md active:bg-white/25';

  return (
    <div className="pointer-events-none absolute inset-0 sm:hidden">
      {/* Steering, bottom left. */}
      <div className="absolute bottom-10 left-6 flex gap-3">
        <button className={buttonClass} aria-label="Steer left" {...hold((i, on) => (i.steerAxis = on ? -1 : 0))}>
          ←
        </button>
        <button className={buttonClass} aria-label="Steer right" {...hold((i, on) => (i.steerAxis = on ? 1 : 0))}>
          →
        </button>
      </div>

      {/* Pedals, bottom right. */}
      <div className="absolute bottom-10 right-6 flex flex-col items-end gap-3">
        {/* Boost, above the throttle rather than beside it: it is only ever
            used with the throttle already down, so the thumb should be able to
            roll up onto it without leaving the pedal. Violet, matching the
            reserve arc on the dial, because nothing else here is. */}
        <button
          className={`${buttonClass} border-[#a06bff]/50 text-[11px] tracking-[0.14em] text-[#cbb0ff]`}
          aria-label="Boost"
          {...hold((i, on) => (i.boost = on))}
        >
          BOOST
        </button>
        <button className={buttonClass} aria-label="Accelerate" {...hold((i, on) => (i.throttle = on ? 1 : 0))}>
          ▲
        </button>
        <div className="flex gap-3">
          <button className={buttonClass} aria-label="Handbrake" {...hold((i, on) => (i.handbrake = on))}>
            ⌷
          </button>
          <button className={buttonClass} aria-label="Brake or reverse" {...hold((i, on) => (i.brake = on ? 1 : 0))}>
            ▼
          </button>
        </div>
      </div>

      {/* Camera and reset, top right. */}
      <div className="absolute right-6 top-6 flex gap-3">
        <button
          className="pointer-events-auto rounded-full border border-white/15 bg-black/35 px-4 py-2 text-[11px] tracking-[0.2em] text-white/80 backdrop-blur-md active:bg-white/25"
          onClick={onCamera}
        >
          CAM
        </button>
        <button
          className="pointer-events-auto rounded-full border border-white/15 bg-black/35 px-4 py-2 text-[11px] tracking-[0.2em] text-white/80 backdrop-blur-md active:bg-white/25"
          onClick={() => {
            if (input.current) input.current.resetRequested = true;
          }}
        >
          RESET
        </button>
      </div>
    </div>
  );
}
