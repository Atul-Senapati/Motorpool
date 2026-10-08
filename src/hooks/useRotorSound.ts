'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import { AIRFRAME } from '@/config/airframe';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import type { RawInput } from './useKeyboardControls';

/**
 * The sound of an aircraft — the helicopter's, and the drone's.
 *
 * Neither has an engine note to fake, so `useEngineSound` is off in the air
 * and this replaces it. The layers live in `public/audio/rotor-processor.js`,
 * whose header explains what a helicopter actually sounds like (the blades,
 * not the engines); this hook owns the graph around it and the six numbers it
 * is fed each frame:
 *
 *   effort    how hard the machine is working, off the tacho's rpm — the
 *             flight model's own figure, so the slap heavies as the disc loads
 *   speed     airspeed, m/s, for the wind
 *   rate      rotor speed as a share of flight rpm, for the wind-up on the
 *             first frames: the aircraft spawns turning, but a fresh graph
 *             starts silent and comes up over a second rather than snapping
 *   bite      blade-vortex interaction — how hard the aircraft is banking or
 *             descending. Not in the telemetry, so it is read off what the
 *             telemetry is *doing*: the rate of change of speed and of height
 *   agl       metres over the ground, for the slap coming back off a roof
 *   cockpit   the goggles view
 *
 * After the worklet: a lowpass, a limiter, and a master a little above the
 * cars' — the same chain, so switching vehicle does not jump; the helicopter
 * earns a touch more because its whole character is in the bottom octave.
 * Volume is the settings toggle and the K key, through `mutedRef`.
 */

interface Voice {
  output: AudioNode;
  update(d: Drive): void;
  dispose(): void;
}

interface Drive {
  effort: number; speed: number; rate: number; bite: number; agl: number; cockpit: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Master level: the helicopter is louder. Read at use — the aircraft can be switched mid-flight. */
const masterLevel = () => (SELECTED.air === 'helicopter' ? 0.85 : 0.55);

/** Seconds for a fresh graph to come up to flight rpm. */
const WIND_UP = 1.4;

function buildWorkletVoice(ctx: AudioContext): Voice {
  const node = new AudioWorkletNode(ctx, 'rotor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { kind: SELECTED.air === 'helicopter' ? 'helicopter' : 'drone' },
  });
  const param = (name: string) => node.parameters.get(name)!;
  const p = {
    effort: param('effort'), speed: param('speed'), rate: param('rate'),
    bite: param('bite'), agl: param('agl'), cockpit: param('cockpit'),
  };
  return {
    output: node,
    update(d) {
      const t = ctx.currentTime;
      p.effort.setTargetAtTime(d.effort, t, 0.1);
      p.speed.setTargetAtTime(d.speed, t, 0.1);
      p.rate.setTargetAtTime(d.rate, t, 0.05);
      p.bite.setTargetAtTime(d.bite, t, 0.15);
      p.agl.setTargetAtTime(d.agl, t, 0.2);
      p.cockpit.setTargetAtTime(d.cockpit, t, 0.15);
    },
    dispose() { node.disconnect(); },
  };
}

/** If the worklet cannot load: a low pulsing hum that rises with effort. */
function buildFallbackVoice(ctx: AudioContext): Voice {
  const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 52 });
  const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 6.6 });
  const depth = new GainNode(ctx, { gain: 0.5 });
  const gain = new GainNode(ctx, { gain: 0 });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 180, Q: 0.7 });
  lfo.connect(depth).connect(gain.gain);
  osc.connect(filter).connect(gain);
  osc.start(); lfo.start();
  return {
    output: gain,
    update({ effort }) { gain.gain.setTargetAtTime(0.06 + effort * 0.08, ctx.currentTime, 0.1); },
    dispose() { osc.stop(); lfo.stop(); osc.disconnect(); lfo.disconnect(); gain.disconnect(); },
  };
}

export function useRotorSound(
  telemetry: RefObject<VehicleTelemetry>, enabled = true, input?: RefObject<RawInput>,
  cameraMode?: RefObject<CameraMode>,
  /** The vehicle's id: the voice is rebuilt when it changes (a switch mid-drive). */
  vehicleId?: string,
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

      const smooth = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5200, Q: 0.4 });
      const limiter = new DynamicsCompressorNode(ctx, {
        threshold: -14, knee: 10, ratio: 6, attack: 0.004, release: 0.12,
      });
      const master = new GainNode(ctx, { gain: masterLevel() });
      smooth.connect(limiter).connect(master).connect(ctx.destination);

      graph = { ctx, master, voice: null, raf: 0 };
      const g = graph;
      const born = performance.now();

      const attach = (voice: Voice, kind: string) => {
        if (disposed || graph !== g) { voice.dispose(); return; }
        voice.output.connect(smooth);
        g.voice = voice;
        console.info(`[rotor] ${kind} voice for ${SELECTED.id}`);
      };
      if (ctx.audioWorklet) {
        ctx.audioWorklet.addModule('/audio/rotor-processor.js')
          .then(() => attach(buildWorkletVoice(ctx), 'worklet'))
          .catch((error: unknown) => {
            console.warn('[rotor] worklet failed to load, using fallback voice', error);
            attach(buildFallbackVoice(ctx), 'fallback');
          });
      } else {
        attach(buildFallbackVoice(ctx), 'fallback');
      }

      // For the bite: what the aircraft did last frame.
      let lastSpeed = 0;
      let lastY = NaN;
      let lastAt = performance.now();
      let bite = 0;
      const tick = () => {
        if (graph !== g) return;
        g.raf = requestAnimationFrame(tick);
        const t = telemetry.current;
        if (!t) return;
        const now = performance.now();
        const dt = clamp((now - lastAt) / 1000, 1 / 240, 0.1);
        lastAt = now;

        const speed = t.speedKph / 3.6;
        // Blade-vortex interaction: a hard speed change is a bank or a brake,
        // a descent is a descent. Both put the blades through their own wake.
        const accel = Math.abs(speed - lastSpeed) / dt;
        const sink = Number.isFinite(lastY) ? Math.max(0, (lastY - t.y) / dt) : 0;
        const wantBite = clamp(accel / 9 + sink / 6, 0, 1);
        // Attacks fast, releases slow — the chop hangs on after the manoeuvre.
        bite += (wantBite - bite) * (wantBite > bite ? 0.35 : 0.06);
        lastSpeed = speed;
        lastY = t.y;

        const effort = clamp((t.rpm - AIRFRAME.idleRpm) / (AIRFRAME.maxRpm - AIRFRAME.idleRpm), 0, 1);
        const mode = cameraMode?.current;
        g.voice?.update({
          effort,
          speed,
          rate: clamp((now - born) / 1000 / WIND_UP, 0, 1),
          bite,
          agl: t.agl,
          cockpit: mode === 'fpv' ? 1 : 0,
        });
        g.master.gain.setTargetAtTime(mutedRef.current ? 0 : masterLevel(), ctx.currentTime, 0.05);
      };
      g.raf = requestAnimationFrame(tick);
    };

    const onGesture = () => build();
    const onKey = (event: KeyboardEvent) => {
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
  }, [telemetry, enabled, input, cameraMode, vehicleId]);

  return mutedRef;
}
