'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import { VEHICLE } from '@/config/vehicleConfig';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import type { RawInput } from './useKeyboardControls';

/**
 * Engine note, synthesised live from the RPM signal.
 *
 * The sound itself is made in an AudioWorklet — `public/audio/engine-processor.js`
 * — which fires exhaust pulses off a modelled crank and rings them through a
 * pipe. Read that file for why: the short version is that the previous voice
 * was three raw oscillators (a square wave among them) into a lowpass, and a
 * square wave at a V12's 700 Hz firing frequency puts its harmonics exactly
 * where the ear hurts. This hook only owns the graph around the worklet and
 * the two numbers it is fed each frame:
 *
 *   rpm    from telemetry, as before
 *   load   how hard the engine is working: the throttle, plus boost, plus a
 *          little for climbing revs — and nothing on the overrun, which is
 *          what lets the worklet do its pops
 *
 * After the worklet: a lowpass at 4 kHz so nothing sharp gets through, a
 * compressor as a safety limiter, and a master gain well under unity. Volume
 * is a settings toggle (`audio`) and the K key; both drive `mutedRef`.
 *
 * Browsers block audio until a user gesture, so the graph is built lazily on
 * the first key press or tap. If the worklet fails to load (an old browser, a
 * blocked fetch) there is a plain fallback voice — a single soft triangle
 * wave, quiet, rather than the old buzz.
 */

interface EngineVoice {
  /** Cylinders. Sets the firing frequency for a given rpm and how the pulses stack. */
  cylinders: number;
  /** Exhaust pipe resonance, Hz. Big lazy pipe low; race exhaust high. */
  pipeHz: number;
  /** 0 = metronome-even firing; 1 = lumpy cross-plane V8. */
  uneven: number;
  /** Mechanical and intake noise under the note, 0..1. */
  grit: number;
  /** How far the tone opens under load. */
  brightness: number;
  /** Muffler: 0 is an open race pipe, 1 a saloon you can talk over. */
  muffle: number;
  /** Overrun pops and post-shift crackle, 0..1. */
  pops: number;
  /** Supercharger whine, 0..1. */
  blower?: number;
  /** Turbo spool, whistle and blow-off, 0..1. */
  turbo?: number;
  /** Loose tinware, 0..1. */
  rattle?: number;
  diesel?: boolean;
}

const DEFAULT_VOICE: EngineVoice = {
  cylinders: 8, pipeHz: 110, uneven: 0.35, grit: 0.35, brightness: 0.55, muffle: 0.5, pops: 0.3,
};

/**
 * One voice per vehicle. Everything here is a property a real engine has —
 * see the worklet's header for what each does to the sound — so the garage
 * is a garage of different engines rather than one engine at twelve pitches.
 */
const VOICES: Record<string, EngineVoice> = {
  // BMW S70/2 V12: even, high, smooth, a quiet clean tailpipe that opens up.
  mclaren: { cylinders: 12, pipeHz: 165, uneven: 0.05, grit: 0.15, brightness: 0.9, muffle: 0.25, pops: 0.45 },
  // Flat-six race car: rasp, an open pipe, and a crackle every time it lifts.
  porsche: { cylinders: 6, pipeHz: 150, uneven: 0.15, grit: 0.35, brightness: 0.85, muffle: 0.12, pops: 0.9 },
  // Small-block V8 with a cross-plane crank: the lump, through a proper muffler.
  camaro: { cylinders: 8, pipeHz: 95, uneven: 0.6, grit: 0.35, brightness: 0.6, muffle: 0.5, pops: 0.4 },
  // Pickup with a turbo six: muffled, a whistle under load, a sigh when it lifts.
  canyon: { cylinders: 6, pipeHz: 85, uneven: 0.15, grit: 0.4, brightness: 0.4, muffle: 0.7, pops: 0.1, turbo: 0.6 },
  // P60B40 flat-plane V8 on a race exhaust: even, hard, loud on the overrun.
  bmw: { cylinders: 8, pipeHz: 140, uneven: 0.2, grit: 0.3, brightness: 0.85, muffle: 0.1, pops: 0.8 },
  // Blown big-block: the lumpiest crank in the garage and a supercharger over it.
  monster: { cylinders: 8, pipeHz: 70, uneven: 0.75, grit: 0.55, brightness: 0.7, muffle: 0.2, pops: 0.6, blower: 1 },
  // F1 V6 turbo hybrid: very high, very even, all turbo.
  w14: { cylinders: 6, pipeHz: 300, uneven: 0.03, grit: 0.2, brightness: 1, muffle: 0.05, pops: 0.3, turbo: 1 },
  // Stock-car V8: open pipes, a lumpy crank, crackle.
  mcqueen: { cylinders: 8, pipeHz: 110, uneven: 0.5, grit: 0.4, brightness: 0.8, muffle: 0.1, pops: 0.7 },
  // A tired six: more rattle than note, and a silencer full of holes.
  mater: { cylinders: 6, pipeHz: 75, uneven: 0.7, grit: 0.7, brightness: 0.2, muffle: 0.6, pops: 0.3, rattle: 1 },
  // Flathead six: side-valve mutter, well muffled.
  dodge: { cylinders: 6, pipeHz: 80, uneven: 0.3, grit: 0.35, brightness: 0.3, muffle: 0.8, pops: 0.1 },
  // Agricultural diesel, literally: knock, clatter, a low slow pipe.
  tractor: { cylinders: 4, pipeHz: 55, uneven: 0.4, grit: 0.9, brightness: 0.2, muffle: 0.6, pops: 0, diesel: true },
  // Marine diesels: a twin-screw yacht is a big muffled inline six under the
  // deck; the cruiser's is smaller and nearer.
  'boat-yacht': { cylinders: 6, pipeHz: 60, uneven: 0.1, grit: 0.6, brightness: 0.25, muffle: 0.85, pops: 0, diesel: true },
  'boat-cruiser': { cylinders: 4, pipeHz: 90, uneven: 0.2, grit: 0.6, brightness: 0.35, muffle: 0.6, pops: 0, diesel: true },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Overall level. Well under unity: the engine sits beside the UI and the music, not over them. */
const MASTER = 0.5;

/** What the voice is told each frame. */
interface Drive {
  rpm: number;
  load: number;
  /** m/s. */
  speed: number;
  slip: number;
  /** 0 outside the car, 1 in the cockpit view. */
  cockpit: number;
  /** Brake pedal down. */
  brake: number;
}

interface Voice {
  output: AudioNode;
  update(d: Drive): void;
  shift(): void;
  dispose(): void;
}

/** The real voice: the worklet, once its module has loaded. */
function buildWorkletVoice(ctx: AudioContext, voice: EngineVoice): Voice {
  const node = new AudioWorkletNode(ctx, 'engine', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      ...voice,
      idleRpm: VEHICLE.engine.idleRpm,
      topSpeed: Math.max(SELECTED.topSpeedKph, 1) / 3.6,
    },
  });
  const param = (name: string) => node.parameters.get(name)!;
  const rpm = param('rpm'), load = param('load'), speed = param('speed'), slip = param('slip'), cockpit = param('cockpit');
  const brake = param('brake');
  return {
    output: node,
    update(d) {
      const t = ctx.currentTime;
      rpm.setTargetAtTime(d.rpm, t, 0.04);
      load.setTargetAtTime(d.load, t, 0.07);
      speed.setTargetAtTime(d.speed, t, 0.1);
      slip.setTargetAtTime(d.slip, t, 0.05);
      cockpit.setTargetAtTime(d.cockpit, t, 0.15);
      brake.setTargetAtTime(d.brake, t, 0.06);
    },
    shift() { node.port.postMessage({ shift: true }); },
    dispose() { node.disconnect(); },
  };
}

/**
 * If the worklet cannot load: one soft triangle, low and quiet. Deliberately
 * dull — the point is that a missing module degrades to "faint engine", not to
 * the buzz this replaced.
 */
function buildFallbackVoice(ctx: AudioContext, voice: EngineVoice): Voice {
  const osc = new OscillatorNode(ctx, { type: 'triangle' });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 500, Q: 0.5 });
  const gain = new GainNode(ctx, { gain: 0 });
  osc.connect(filter).connect(gain);
  osc.start();
  return {
    output: gain,
    update({ rpm, load }) {
      const t = ctx.currentTime;
      osc.frequency.setTargetAtTime((rpm / 60) * (voice.cylinders / 2), t, 0.06);
      filter.frequency.setTargetAtTime(300 + load * 700, t, 0.08);
      gain.gain.setTargetAtTime(0.06 + load * 0.1, t, 0.05);
    },
    shift() {},
    dispose() { osc.stop(); osc.disconnect(); filter.disconnect(); gain.disconnect(); },
  };
}

export function useEngineSound(
  telemetry: RefObject<VehicleTelemetry>, enabled = true, input?: RefObject<RawInput>,
  cameraMode?: RefObject<CameraMode>,
) {
  const mutedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    interface Graph { ctx: AudioContext; master: GainNode; voice: Voice | null; raf: number }
    let graph: Graph | null = null;
    let disposed = false;

    const build = () => {
      if (graph || disposed) return;
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const engineVoice = VOICES[SELECTED.id] ?? DEFAULT_VOICE;

      // Nothing sharp, nothing loud: a lowpass, then a limiter, then a gain
      // that leaves headroom for the menu music and the tyre noise.
      const smooth = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4500, Q: 0.4 });
      const limiter = new DynamicsCompressorNode(ctx, {
        threshold: -16, knee: 10, ratio: 6, attack: 0.004, release: 0.12,
      });
      const master = new GainNode(ctx, { gain: MASTER });
      smooth.connect(limiter).connect(master).connect(ctx.destination);

      graph = { ctx, master, voice: null, raf: 0 };
      const g = graph;

      const attach = (voice: Voice, kind: string) => {
        if (disposed || graph !== g) { voice.dispose(); return; }
        voice.output.connect(smooth);
        g.voice = voice;
        // The same one-line inventory the traffic and the sea print: a voice
        // that silently fell back is otherwise indistinguishable from one that
        // is simply quiet.
        console.info(`[engine] ${kind} voice for ${SELECTED.id}: ${engineVoice.cylinders} cylinders, pipe ${engineVoice.pipeHz} Hz`);
      };
      if (ctx.audioWorklet) {
        ctx.audioWorklet.addModule('/audio/engine-processor.js')
          .then(() => attach(buildWorkletVoice(ctx, engineVoice), 'worklet'))
          .catch((error: unknown) => {
            console.warn('[engine] worklet failed to load, using fallback voice', error);
            attach(buildFallbackVoice(ctx, engineVoice), 'fallback');
          });
      } else {
        attach(buildFallbackVoice(ctx, engineVoice), 'fallback');
      }

      let lastRpm = 0;
      let lastGear = 0;
      let shiftCut = 0;
      let lastTime = performance.now();
      const tick = () => {
        if (graph !== g) return;
        g.raf = requestAnimationFrame(tick);
        const t = telemetry.current;
        if (!t) return;
        const now = performance.now();
        const dt = Math.max(1e-3, (now - lastTime) / 1000);
        const rpmRate = (t.rpm - lastRpm) / dt;
        lastRpm = t.rpm; lastTime = now;

        // A gear change: the throttle is cut for a moment and the box clunks.
        // The rpm signal already drops; this is the sound of why.
        if (t.gear !== lastGear) {
          if (lastGear !== 0 && t.gear > 0) { shiftCut = 0.14; g.voice?.shift(); }
          lastGear = t.gear;
        }
        shiftCut = Math.max(0, shiftCut - dt);

        // Load is what the driver is asking for, not where the revs happen
        // to be: throttle first, boost on top, a little more while the revs
        // are climbing, and nothing when coasting — the overrun is a sound of
        // its own and the worklet makes it from the absence of load.
        const throttle = shiftCut > 0 ? 0
          : input?.current?.throttle ?? (t.rpm > VEHICLE.engine.idleRpm + 200 ? 0.5 : 0);
        const climbing = clamp(rpmRate / 4000, 0, 0.25);
        const revs = (t.rpm - VEHICLE.engine.idleRpm) / (VEHICLE.engine.maxRpm - VEHICLE.engine.idleRpm);
        const load = clamp(throttle * (0.55 + 0.45 * clamp(revs, 0, 1)) + (t.boosting ? 0.25 : 0) + climbing, 0, 1);

        g.voice?.update({
          rpm: t.rpm,
          load,
          speed: t.speedKph / 3.6,
          slip: clamp(t.slip, 0, 1),
          cockpit: cameraMode?.current === 'cockpit' ? 1 : 0,
          // Harder on a locked wheel: the wheels' `longSlip` is the lock-up.
          brake: t.braking
            ? clamp(0.55 + 0.45 * Math.max(t.wheels.FL.longSlip, t.wheels.FR.longSlip, t.wheels.RL.longSlip, t.wheels.RR.longSlip), 0, 1)
            : 0,
        });
        g.master.gain.setTargetAtTime(mutedRef.current ? 0 : MASTER, ctx.currentTime, 0.05);
      };
      g.raf = requestAnimationFrame(tick);
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
        graph.voice?.dispose();
        graph.master.disconnect();
        graph.ctx.close().catch(() => {});
        graph = null;
      }
    };
  }, [telemetry, enabled, input, cameraMode]);

  return mutedRef;
}
