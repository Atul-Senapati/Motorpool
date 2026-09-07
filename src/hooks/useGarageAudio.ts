'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'motorpool.audioMuted';

const readMuted = (): boolean => {
  try { return window.localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
};

/** Nothing external ever changes the stored value out from under us, so this
 *  store has no real subscription — same shape as `subscribeNever` in
 *  `GarageScreen`, kept local here so this hook has no import-order coupling
 *  to the component that happens to use it first. */
const subscribeNever = () => () => {};

/**
 * Menu music and UI sound effects for the garage screen.
 *
 * Three kinds of playback, all plain `<audio>` elements rather than the Web
 * Audio graph `useEngineSound` builds — there is no pitch-shifting or mixing
 * to do here, just "start this clip," so the simpler API is the honest tool.
 *
 *  - **Music** loops quietly in the background. Autoplay is blocked before a
 *    user gesture, so it starts lazily on the first pointerdown/keydown on
 *    the page, the same pattern `useEngineSound` uses for the engine note.
 *  - **Click** is pooled four ways. A single shared `<audio>` restarted on
 *    every click would cut itself off mid-decay when the driver browses fast
 *    (arrow-key repeats faster than the clip's own length) — a pool gives
 *    each rapid click its own voice instead of stealing the last one's tail.
 *  - **Confirm** is its own single clip for the DRIVE/RIDE button, which is
 *    never pressed rapidly enough to need pooling.
 *
 * Muting is one switch for all three, remembered in `localStorage` the same
 * way the last-driven vehicle is.
 */
export function useGarageAudio() {
  /*
   * Hydration-safe read, same pattern `GarageScreen` uses for the remembered
   * vehicle: `useSyncExternalStore`'s server snapshot is "nothing stored", so
   * the server and the client's first paint agree, and the real value arrives
   * on the client's next render rather than through a `useEffect` that reads
   * localStorage and calls `setState` — which is the cascading-render shape
   * this project's lint forbids. `chosen` is the driver's own toggle, held
   * separately and layered on top so flipping it doesn't need an effect either.
   */
  const remembered = useSyncExternalStore(subscribeNever, readMuted, () => false);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const muted = chosen ?? remembered;

  const musicRef = useRef<HTMLAudioElement | null>(null);
  const clickPoolRef = useRef<HTMLAudioElement[]>([]);
  const clickCursor = useRef(0);
  const confirmRef = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const music = new Audio('/audio/menu-music.mp3');
    music.loop = true;
    music.volume = 0.32;
    musicRef.current = music;

    const confirm = new Audio('/audio/ui-confirm.mp3');
    confirm.volume = 0.7;
    confirmRef.current = confirm;

    clickPoolRef.current = Array.from({ length: 4 }, () => {
      const a = new Audio('/audio/ui-click.mp3');
      a.volume = 0.45;
      return a;
    });

    const start = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      if (!readMuted()) music.play().catch(() => {});
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);

    return () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      music.pause();
      confirm.pause();
      for (const a of clickPoolRef.current) a.pause();
      musicRef.current = null;
      confirmRef.current = null;
      clickPoolRef.current = [];
    };
  }, []);

  // Reflect a mute toggle onto the music that is already playing (or about
  // to start), and persist it for the next visit.
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
    const music = musicRef.current;
    if (!music) return;
    if (muted) music.pause();
    else if (startedRef.current) music.play().catch(() => {});
  }, [muted]);

  const playClick = useCallback(() => {
    if (muted) return;
    const pool = clickPoolRef.current;
    if (!pool.length) return;
    const a = pool[clickCursor.current];
    clickCursor.current = (clickCursor.current + 1) % pool.length;
    a.currentTime = 0;
    a.play().catch(() => {});
  }, [muted]);

  const playConfirm = useCallback(() => {
    if (muted) return;
    const a = confirmRef.current;
    if (!a) return;
    a.currentTime = 0;
    a.play().catch(() => {});
  }, [muted]);

  const toggleMuted = useCallback(() => setChosen((prev) => !(prev ?? remembered)), [remembered]);

  return { muted, toggleMuted, playClick, playConfirm };
}
