'use client';

import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

/**
 * The interface's own voice: the menu clicks, the hovers and the toggles.
 *
 * Synthesised, like the engine and the train, and for the same reason rather
 * than out of habit. A UI sound has to be **short** — 30 ms for a hover — and
 * it has to be able to fire again before the last one has finished, which an
 * `<audio>` element cannot do without a pool of them (`useGarageAudio` keeps
 * four just for its click). Web Audio gives every blip its own voice for the
 * cost of an oscillator, so a driver dragging the cursor down a list gets a
 * run of separate ticks rather than one stuttering clip. It also means no new
 * files: the whole bank below is about a kilobyte of arithmetic.
 *
 * ## Kept deliberately quiet and dull
 *
 * These play over a game, potentially several times a second, and every one of
 * them is a sound the player did not ask for. So:
 *
 *   soft edges    every blip fades in over 6 ms and out on an exponential. A
 *                 square-edged envelope on a sine is a click in the literal
 *                 sense — a step in the waveform — and that is what makes cheap
 *                 UI audio sting
 *   low           nothing here has a fundamental over 900 Hz, and the master
 *                 runs through a 2.2 kHz lowpass. The ear's sore spot is 2-5
 *                 kHz, which is exactly where a bright UI "tick" sits
 *   hover softest of all, at a fifth of the click's level: it fires on
 *                 movement rather than on intent, so it is a texture, not an
 *                 event
 *
 * ## Autoplay
 *
 * The context is built on the first sound rather than on mount, because a
 * context created before a user gesture starts suspended and stays that way.
 * Every call here comes from a click, a key or a pointer entering something,
 * so by construction the first one is inside a gesture — and `resume()` covers
 * the case where the browser suspended it again while the tab was hidden.
 */

/** One note: a sine that slides from `from` to `to` while it fades. */
interface Blip {
  from: number;
  to?: number;
  /** Seconds. */
  length: number;
  gain: number;
  /** Seconds from the start of the sound. */
  at?: number;
}

const SOUNDS = {
  /** The cursor moving over something. Barely there. */
  hover: [{ from: 760, to: 720, length: 0.045, gain: 0.045 }],
  /** Something chosen: a firm, low tap with a little body under it. */
  select: [
    { from: 520, to: 400, length: 0.075, gain: 0.16 },
    { from: 260, to: 200, length: 0.11, gain: 0.10 },
  ],
  /** A setting turned up, or on: two notes, rising. */
  toggleUp: [
    { from: 420, length: 0.05, gain: 0.11 },
    { from: 630, length: 0.075, gain: 0.11, at: 0.045 },
  ],
  /** Turned down, or off: the same figure, falling. */
  toggleDown: [
    { from: 560, length: 0.05, gain: 0.11 },
    { from: 380, length: 0.075, gain: 0.11, at: 0.045 },
  ],
  /** One step of a slider. Shorter and quieter than a toggle: there are many. */
  tick: [{ from: 880, to: 860, length: 0.03, gain: 0.05 }],
  /** The world stopping. Low, two notes, falling — a door closing on the game. */
  open: [
    { from: 340, to: 320, length: 0.16, gain: 0.15 },
    { from: 226, to: 214, length: 0.30, gain: 0.13, at: 0.055 },
  ],
  /** And starting again: the same two the other way up. */
  close: [
    { from: 226, to: 240, length: 0.12, gain: 0.12 },
    { from: 340, to: 360, length: 0.20, gain: 0.13, at: 0.05 },
  ],
  /** Back out of a page. A single low note, going nowhere. */
  back: [{ from: 300, to: 250, length: 0.10, gain: 0.11 }],
} as const satisfies Record<string, readonly Blip[]>;

export type UiSound = keyof typeof SOUNDS;

/** Master level for the whole bank, under the lowpass. */
const MASTER = 0.5;

export function useUiSound(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const busRef = useRef<GainNode | null>(null);

  useEffect(() => () => {
    // Closed rather than left suspended: a context is a real audio device, and
    // a hot reload that leaks one every save runs the browser out of them.
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    busRef.current = null;
  }, []);

  return useCallback((sound: UiSound) => {
    if (!enabled) return;
    try {
      if (!ctxRef.current) {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        // The one filter the whole bank shares: it is what keeps a blip a blip
        // rather than a bleep. See the note on 2-5 kHz above.
        const soft = ctx.createBiquadFilter();
        soft.type = 'lowpass';
        soft.frequency.value = 2200;
        const bus = ctx.createGain();
        bus.gain.value = MASTER;
        bus.connect(soft);
        soft.connect(ctx.destination);
        ctxRef.current = ctx;
        busRef.current = bus;
      }
      const ctx = ctxRef.current;
      const bus = busRef.current;
      if (!ctx || !bus) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const now = ctx.currentTime;
      for (const note of SOUNDS[sound] as readonly Blip[]) {
        const start = now + (note.at ?? 0);
        const end = start + note.length;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.from, start);
        if (note.to && note.to !== note.from) {
          osc.frequency.exponentialRampToValueAtTime(note.to, end);
        }
        const env = ctx.createGain();
        // Up over 6 ms, then an exponential tail to silence. `exponential`
        // cannot reach zero, so it stops just above it and the node ends.
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(note.gain, start + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(env);
        env.connect(bus);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    } catch {
      // No audio device, or a context the browser refused. The menu still works.
    }
  }, [enabled]);
}

/**
 * The bank, shared with everything drawn inside it.
 *
 * A context rather than a prop, because the things that want to make a noise
 * are the small shared controls — a row, a segmented button, a slider — and
 * they are three levels down from the component that knows whether sound is
 * on. Threading a callback through `SettingsForm` to `Row` to `Segmented` to
 * say "tick" is the kind of plumbing that gets dropped the next time one of
 * them is touched.
 *
 * The default is a no-op, so a control used outside a provider is silent
 * rather than broken — which is what the garage's own screens want.
 */
const UiSoundContext = createContext<(sound: UiSound) => void>(() => {});

export const UiSoundProvider = UiSoundContext.Provider;

/** Play a UI sound from anywhere inside a `UiSoundProvider`. */
export const useUi = () => useContext(UiSoundContext);
