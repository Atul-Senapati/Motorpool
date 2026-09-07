'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import { VEHICLE } from '@/config/vehicleConfig';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * Engine note, synthesized live from the actual RPM signal — not a recording
 * pitch-shifted to fit.
 *
 * The previous version crossfaded two real recordings (an idling car, a car
 * at speed) and pitch-shifted each with `playbackRate` to cover the gap
 * between them. That is audibly wrong in two ways: `playbackRate` speeds up
 * or slows down the *whole* recording, including its own baked-in transients,
 * so a sample nudged 1.6x sounds sped-up rather than higher-revving; and the
 * two source recordings were different real cars, so the "engine" changed
 * character at the crossfade point instead of sweeping continuously. Worse,
 * every vehicle in the garage played the exact same pair — a 4-tonne
 * **electric** SUV got the same V12/muscle-car note as everything else.
 *
 * This generates the note directly from telemetry instead, with a Web Audio
 * oscillator graph re-tuned every frame:
 *
 *   firing frequency = (rpm / 60) * engine order
 *
 * "Engine order" is firing pulses per crank revolution — cylinders/2 for a
 * four-stroke — so the fundamental tracks RPM exactly, continuously, with no
 * sample boundary to cross and no stretched transients. A fundamental plus a
 * couple of harmonics through a load-dependent lowpass filter, and a little
 * broadband noise for mechanical grit, gives each vehicle a distinct voice
 * (`VOICES` below) instead of one borrowed recording for the whole garage.
 * `electric` is **currently unreachable**: the garage has had no EV since the
 * Hummer went, so nothing selects that type. The code is kept rather than
 * deleted because it is the interesting half — `buildElectricVoice` pitches a
 * clean motor whine from *road speed* instead of the fake per-gear RPM sweep,
 * since a single-speed reduction drive has no gearshift to dip for and no
 * combustion harmonics to fake. Put an EV back in `VOICES` and it works again.
 *
 * Browsers block audio until a user gesture, so playback starts lazily on the
 * first key press or tap, exactly like the mute key does.
 */

interface EngineVoice {
  type: 'gas' | 'diesel' | 'electric';
  /** Firing pulses per crank revolution (cylinders / 2, four-stroke). Unused by 'electric'. */
  order: number;
  /** How far the tone filter opens under load — rowdier and brighter at 1, muffled near 0. */
  brightness: number;
  /** How much broadband mechanical noise is mixed under the tone, 0..1. */
  grit: number;
}

const DEFAULT_VOICE: EngineVoice = { type: 'gas', order: 4, brightness: 0.55, grit: 0.35 };

/** One voice per car in the garage — see the file doc comment for why this exists at all.
 *  The tractor is the only `diesel`; nothing is `electric` at the moment. */
const VOICES: Record<string, EngineVoice> = {
  mclaren: { type: 'gas', order: 6, brightness: 0.85, grit: 0.2 }, // BMW S70/2 V12
  porsche: { type: 'gas', order: 3, brightness: 0.8, grit: 0.4 }, // flat-6 race car, open exhaust
  camaro: { type: 'gas', order: 4, brightness: 0.6, grit: 0.4 }, // small-block V8
  canyon: { type: 'gas', order: 3, brightness: 0.5, grit: 0.45 }, // pickup, turbo six
  bmw: { type: 'gas', order: 4, brightness: 0.82, grit: 0.35 }, // P60B40 V8, race exhaust
  monster: { type: 'gas', order: 4, brightness: 0.72, grit: 0.6 }, // blown big-block, all of it
  w14: { type: 'gas', order: 3, brightness: 0.95, grit: 0.22 }, // V6 turbo hybrid, screaming
  mcqueen: { type: 'gas', order: 4, brightness: 0.75, grit: 0.45 }, // stock-car V8
  mater: { type: 'gas', order: 3, brightness: 0.2, grit: 0.7 }, // tired six, more rattle than note
  dodge: { type: 'gas', order: 3, brightness: 0.28, grit: 0.4 }, // flathead six, side-valve mutter
  tractor: { type: 'diesel', order: 3, brightness: 0.22, grit: 0.85 }, // agricultural, literally
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A one-second loop of white noise, built once per AudioContext and shared by every noise tap. */
function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Combustion voice: fundamental + two harmonics through a load-brightened lowpass, plus grit. */
function buildCombustionVoice(ctx: AudioContext, noiseBuffer: AudioBuffer, voice: EngineVoice) {
  const fundamental = new OscillatorNode(ctx, { type: 'sawtooth' });
  const secondHarmonic = new OscillatorNode(ctx, { type: 'square' });
  const subHarmonic = new OscillatorNode(ctx, { type: 'sine' });
  const gFundamental = new GainNode(ctx, { gain: 0.55 });
  const gSecond = new GainNode(ctx, { gain: 0.2 + voice.brightness * 0.3 });
  const gSub = new GainNode(ctx, { gain: 0.5 + (1 - voice.brightness) * 0.3 });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 400, Q: 0.6 });

  const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer, loop: true });
  const noiseFilter = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 900, Q: 0.7 });
  const gNoise = new GainNode(ctx, { gain: 0 });

  fundamental.connect(gFundamental).connect(filter);
  secondHarmonic.connect(gSecond).connect(filter);
  subHarmonic.connect(gSub).connect(filter);
  noise.connect(noiseFilter).connect(gNoise);

  fundamental.start(); secondHarmonic.start(); subHarmonic.start(); noise.start();

  const envelope = new GainNode(ctx, { gain: 0 });
  filter.connect(envelope);
  gNoise.connect(envelope);

  return {
    output: envelope,
    update(rpm: number, load: number) {
      const t = ctx.currentTime;
      const firing = (rpm / 60) * voice.order;
      fundamental.frequency.setTargetAtTime(firing, t, 0.06);
      secondHarmonic.frequency.setTargetAtTime(firing * 2, t, 0.06);
      subHarmonic.frequency.setTargetAtTime(firing / 2, t, 0.06);
      filter.frequency.setTargetAtTime(300 + load * voice.brightness * 3200, t, 0.08);
      noiseFilter.frequency.setTargetAtTime(firing * 4, t, 0.08);
      gNoise.gain.setTargetAtTime(voice.grit * (0.12 + load * 0.35), t, 0.08);
      envelope.gain.setTargetAtTime(0.16 + load * 0.34, t, 0.05);
    },
    dispose() {
      for (const n of [fundamental, secondHarmonic, subHarmonic, noise]) n.stop();
      for (const n of [fundamental, secondHarmonic, subHarmonic, gFundamental, gSecond, gSub,
        filter, noise, noiseFilter, gNoise, envelope]) n.disconnect();
    },
  };
}

/**
 * Electric voice: a clean motor whine pitched from **road speed**, not the
 * fake per-gear RPM sweep every combustion car uses — a single-speed
 * reduction drive has no gearshift to dip for, so the pitch should climb
 * smoothly with the car rather than sawtooth with it.
 */
function buildElectricVoice(ctx: AudioContext) {
  const motor = new OscillatorNode(ctx, { type: 'triangle' });
  const whine = new OscillatorNode(ctx, { type: 'sine' });
  const gMotor = new GainNode(ctx, { gain: 0.8 });
  const gWhine = new GainNode(ctx, { gain: 0.05 });
  const envelope = new GainNode(ctx, { gain: 0 });

  motor.connect(gMotor).connect(envelope);
  whine.connect(gWhine).connect(envelope);
  motor.start(); whine.start();

  const topSpeed = Math.max(SELECTED.topSpeedKph, 1);
  return {
    output: envelope,
    update(rpm: number, load: number, speedKph: number) {
      const t = ctx.currentTime;
      const speedRatio = clamp(speedKph / topSpeed, 0, 1);
      const motorFreq = 40 + speedRatio * 560;
      motor.frequency.setTargetAtTime(motorFreq, t, 0.12);
      whine.frequency.setTargetAtTime(motorFreq * 4.7, t, 0.12);
      envelope.gain.setTargetAtTime(0.05 + load * 0.14, t, 0.05);
    },
    dispose() {
      motor.stop(); whine.stop();
      for (const n of [motor, whine, gMotor, gWhine, envelope]) n.disconnect();
    },
  };
}

export function useEngineSound(telemetry: RefObject<VehicleTelemetry>, enabled = true) {
  const mutedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    type Voice =
      | ReturnType<typeof buildCombustionVoice>
      | ReturnType<typeof buildElectricVoice>;
    interface Graph { ctx: AudioContext; master: GainNode; voice: Voice; raf: number }
    let graph: Graph | null = null;
    let disposed = false;

    const build = () => {
      if (graph || disposed) return;
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const engineVoice = VOICES[SELECTED.id] ?? DEFAULT_VOICE;
      const voice = engineVoice.type === 'electric'
        ? buildElectricVoice(ctx)
        : buildCombustionVoice(ctx, buildNoiseBuffer(ctx), engineVoice);

      const master = new GainNode(ctx, { gain: 1 });
      voice.output.connect(master).connect(ctx.destination);

      const tick = () => {
        const g = graph;
        if (!g) return;
        g.raf = requestAnimationFrame(tick);
        const t = telemetry.current;
        if (!t) return;

        const load = clamp(
          (t.rpm - VEHICLE.engine.idleRpm) / (VEHICLE.engine.maxRpm - VEHICLE.engine.idleRpm),
          0, 1,
        );
        voice.update(t.rpm, load, t.speedKph);
        master.gain.setTargetAtTime(mutedRef.current ? 0 : 1, ctx.currentTime, 0.05);
      };

      graph = { ctx, master, voice, raf: 0 };
      graph.raf = requestAnimationFrame(tick);
    };

    const onGesture = () => build();
    const onKey = (event: KeyboardEvent) => {
      // K, not M: M opens the city map, which is the more prominent binding and
      // the conventional one for it. Both fired on M before this moved.
      if (event.code === 'KeyK') mutedRef.current = !mutedRef.current;
      onGesture();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onGesture);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onGesture);
      if (graph) {
        cancelAnimationFrame(graph.raf);
        graph.voice.dispose();
        graph.master.disconnect();
        graph.ctx.close().catch(() => {});
        graph = null;
      }
    };
  }, [telemetry, enabled]);

  return mutedRef;
}
