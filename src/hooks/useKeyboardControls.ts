'use client';

import { useEffect, useRef } from 'react';
import type { VehicleInput } from '@/types/vehicle';

/** Physical key -> control. Uses `event.code` so the layout doesn't matter. */
const BINDINGS = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
} as const;

type Action = (typeof BINDINGS)[keyof typeof BINDINGS];

export interface RawInput extends VehicleInput {
  /** Unsmoothed steering axis, -1..1. `steer` holds the smoothed value. */
  steerAxis: number;
}

const createInput = (): RawInput => ({
  throttle: 0, brake: 0, steer: 0, steerAxis: 0,
  handbrake: false, resetRequested: false, flipRequested: false, cameraCycleRequested: false,
});

/**
 * Tracks the keyboard into a ref. Deliberately does not use React state: these
 * values are read every physics tick and must never cause a re-render.
 */
export function useKeyboardControls() {
  const input = useRef<RawInput>(createInput());
  const held = useRef(new Set<Action>());

  useEffect(() => {
    const apply = () => {
      const h = held.current;
      const i = input.current;
      i.throttle = h.has('throttle') ? 1 : 0;
      i.brake = h.has('brake') ? 1 : 0;
      i.handbrake = h.has('handbrake');
      i.steerAxis = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'KeyR') { input.current.resetRequested = true; return; }
      if (e.code === 'KeyF') { input.current.flipRequested = true; return; }
      if (e.code === 'KeyC') { input.current.cameraCycleRequested = true; return; }
      const action = BINDINGS[e.code as keyof typeof BINDINGS];
      if (!action) return;
      e.preventDefault(); // stop Space/arrows scrolling the page
      held.current.add(action);
      apply();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const action = BINDINGS[e.code as keyof typeof BINDINGS];
      if (!action) return;
      held.current.delete(action);
      apply();
    };

    // Releasing focus mid-corner would otherwise leave the throttle stuck on.
    const onBlur = () => { held.current.clear(); apply(); };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return input;
}
