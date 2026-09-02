'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { VEHICLE } from '@/config/vehicleConfig';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * Synthesised engine note — no audio files.
 *
 * Two detuned sawtooth oscillators plus a sub, through a low-pass filter whose
 * cutoff opens with load. Frequency tracks the firing rate of a V12 (six
 * cylinders firing per revolution), which is what makes it read as this kind of
 * engine rather than a generic drone.
 *
 * Browsers block audio until a user gesture, so the graph is created lazily on
 * the first key press or tap.
 */

/** V12: six power strokes per revolution -> rpm/60 * 6 Hz. Scaled down an octave. */
const firingHz = (rpm: number) => (rpm / 60) * 3;

export function useEngineSound(telemetry: RefObject<VehicleTelemetry>, enabled = true) {
  const mutedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    interface Graph {
      ctx: AudioContext;
      osc: OscillatorNode[];
      sub: OscillatorNode;
      filter: BiquadFilterNode;
      master: GainNode;
      raf: number;
    }
    let graph: Graph | null = null;
    let disposed = false;

    const build = () => {
      if (graph || disposed) return;
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();

      const master = ctx.createGain();
      master.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 700;
      filter.Q.value = 1.1;
      filter.connect(master);
      master.connect(ctx.destination);

      // Two slightly detuned saws give the note body; a square sub adds weight.
      const osc = [0, 1].map((i) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = i === 0 ? -8 : 9;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        o.connect(g);
        g.connect(filter);
        o.start();
        return o;
      });

      const sub = ctx.createOscillator();
      sub.type = 'square';
      const subGain = ctx.createGain();
      subGain.gain.value = 0.22;
      sub.connect(subGain);
      subGain.connect(filter);
      sub.start();

      const tick = () => {
        const g = graph;
        if (!g) return;
        g.raf = requestAnimationFrame(tick);
        const t = telemetry.current;
        if (!t) return;

        const now = g.ctx.currentTime;
        const ramp = 0.06; // smooths steps so the note glides instead of clicking
        const base = firingHz(t.rpm);

        for (const o of g.osc) o.frequency.setTargetAtTime(base, now, ramp);
        g.sub.frequency.setTargetAtTime(base * 0.5, now, ramp);

        // Load proxy: how far up the rev range we are, plus a floor at idle.
        const load = Math.min(
          1,
          (t.rpm - VEHICLE.engine.idleRpm) / (VEHICLE.engine.maxRpm - VEHICLE.engine.idleRpm),
        );
        g.filter.frequency.setTargetAtTime(600 + load * 3200, now, ramp);
        const target = mutedRef.current ? 0 : 0.05 + load * 0.11;
        g.master.gain.setTargetAtTime(target, now, ramp);
      };

      graph = { ctx, osc, sub, filter, master, raf: 0 };
      graph.raf = requestAnimationFrame(tick);
    };

    const onGesture = () => {
      build();
      // Chrome may create the context suspended even after a gesture.
      graph?.ctx.resume().catch(() => {});
    };
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
        for (const o of graph.osc) o.stop();
        graph.sub.stop();
        graph.ctx.close().catch(() => {});
        graph = null;
      }
    };
  }, [telemetry, enabled]);

  return mutedRef;
}
