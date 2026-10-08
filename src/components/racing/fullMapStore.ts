import { useSyncExternalStore } from 'react';

/**
 * Whether the full map is open — one switch shared by the two ways in: the M
 * key on the HUD (`Minimap`), and MAP in the pause menu (`PauseMenu`, wired
 * in `RacingHUD`), where the world stays paused while you read it.
 */
let open = false;
const listeners = new Set<() => void>();

export function setFullMapOpen(next: boolean | ((was: boolean) => boolean)) {
  const value = typeof next === 'function' ? next(open) : next;
  if (value === open) return;
  open = value;
  for (const l of listeners) l();
}

export function isFullMapOpen() {
  return open;
}

export function subscribeFullMap(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFullMapOpen() {
  return useSyncExternalStore(subscribeFullMap, isFullMapOpen, () => false);
}
