'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { SELECTED } from '@/config/garage';
import {
  BALLAST, CUTTING, TUNNEL, VIADUCT, formationFor, trainStructureAt, trainTangentAt, trainWrap,
} from '@/config/trainConfig';
import { settingsSnapshot } from '@/components/racing/gameSettings';
import type { CameraMode, VehicleTelemetry } from '@/types/vehicle';
import type { RawInput } from './useKeyboardControls';

/**
 * The sound of riding a train.
 *
 * The rail vehicles had none: `useEngineSound` is switched off on rails, and
 * rightly — a V12 note on a locomotive would be absurd. What replaces it is a
 * separate worklet, `public/audio/train-processor.js`, whose header explains
 * the layers and what the rail sims got right about them. This hook owns the
 * graph around it and the handful of numbers it is fed each frame:
 *
 *   speed      m/s, from telemetry — the wheel on the rail is most of the sound
 *   load       the notch: throttle, cut to nothing while braking. A diesel's
 *              engine follows THIS with a lag, not the wheels
 *   brake      the handle
 *   curve      how tight the line is under the leading bogie, for the flange
 *              squeal — measured off the route, because the driver cannot
 *              feel it and the telemetry does not carry it
 *   surface    ballast, viaduct, tunnel or cutting, from the route: a deck
 *              rings, a bore echoes
 *   enclosed   the damped in-a-tunnel figure the cameras already use
 *   cockpit    the cab view, for the muffle
 *   horn       N, held — H is the controls panel
 *
 * Two events go over the port rather than as parameters, because they are
 * moments: the leading axle reaching a set of points, and the brake handle
 * coming off.
 *
 * After the worklet: a lowpass, a limiter, and a master well under unity —
 * the same chain as the cars, so the two share a level. Volume is the
 * settings toggle and the K key, through `mutedRef`, like the engine.
 */

interface TrainVoice {
  kind: 'diesel' | 'electric' | 'tram';
  cylinders?: number;
  idleRpm?: number;
  maxRpm?: number;
  /** Seconds from idle to full notch. */
  spoolSec?: number;
  hornHz: [number, number];
}

const VOICES: Record<string, TrainVoice> = {
  // Class 43: an MTU 16V4000 — a V16 that idles at 600 and works at 1,500,
  // and takes its time between them. British two-tone horn.
  // A big V12 turning slowly: 450 rpm at idle is a throb you can count, and
  // 1000 at full power is still a locomotive, not a car. Spools up in four
  // seconds — the notch is asked for, then the engine gets there.
  train: { kind: 'diesel', cylinders: 12, idleRpm: 450, maxRpm: 1000, spoolSec: 4.2, hornHz: [311, 415] },
  // Class 91: electric. Transformer, blowers, traction motors and the inverter.
  train91: { kind: 'electric', hornHz: [349, 466] },
  // The tram: electric too, geared lower, a higher whine for the same speed.
  tram: { kind: 'tram', hornHz: [523, 659] },
};
const DEFAULT_VOICE: TrainVoice = VOICES.train;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Overall level, matching the cars' so switching vehicle does not jump. */
const MASTER = 0.55;

/** Distance between the two axles of one bogie, metres. */
const AXLE_HALF = 1.3;

/**
 * Every axle of the rake, as metres behind the leading axle.
 *
 * This is what makes the joint clack a *rhythm* rather than a metronome: a
 * bogie is two axles 2.6 m apart, a vehicle is two bogies, a rake is a dozen
 * vehicles — so one rail joint is struck in that pattern, spread over the
 * train's length divided by its speed. It is the sound every rail game builds
 * its sense of speed on, and it comes for free from geometry the formation
 * already has.
 */
function axleOffsets(): number[] {
  const units = formationFor(settingsSnapshot().carriages);
  const out: number[] = [];
  for (const unit of units) {
    for (const bogie of [-unit.bogieCentres / 2, unit.bogieCentres / 2]) {
      for (const axle of [-AXLE_HALF, AXLE_HALF]) out.push(unit.offset + bogie + axle);
    }
  }
  const lead = Math.min(...out);
  return out.map((o) => o - lead).sort((a, b) => a - b);
}

/**
 * How tight the line is at an arc, 0 on the straight to 1 on a curve tight
 * enough to squeal — under about 150 m radius, easing in from 450.
 *
 * Curvature from the heading change over 20 m of route, which is exactly the
 * measure `trainSpeedLimitAt` derives its speed restrictions from.
 */
function curveAt(arc: number): number {
  const [ax, az] = trainTangentAt(trainWrap(arc - 10));
  const [bx, bz] = trainTangentAt(trainWrap(arc + 10));
  const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
  const kappa = turn / 20;
  return clamp((kappa - 1 / 450) / (1 / 150 - 1 / 450), 0, 1);
}

const surfaceCode = (arc: number): number => {
  const s = trainStructureAt(arc);
  return s === VIADUCT ? 1 : s === TUNNEL ? 2 : s === CUTTING ? 3 : s === BALLAST ? 0 : 0;
};

interface Drive {
  speed: number; load: number; brake: number; curve: number;
  enclosed: number; cockpit: number; horn: number; surface: number;
  emergency: number;
}

interface Voice {
  output: AudioNode;
  update(d: Drive): void;
  points(): void;
  release(): void;
  emergency(): void;
  dispose(): void;
}

function buildWorkletVoice(ctx: AudioContext, voice: TrainVoice): Voice {
  const node = new AudioWorkletNode(ctx, 'train', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { ...voice, axles: axleOffsets() },
  });
  const param = (name: string) => node.parameters.get(name)!;
  const p = {
    speed: param('speed'), load: param('load'), brake: param('brake'), curve: param('curve'),
    enclosed: param('enclosed'), cockpit: param('cockpit'), horn: param('horn'), surface: param('surface'),
    emergency: param('emergency'),
  };
  return {
    output: node,
    update(d) {
      const t = ctx.currentTime;
      p.speed.setTargetAtTime(d.speed, t, 0.08);
      p.load.setTargetAtTime(d.load, t, 0.12);
      p.brake.setTargetAtTime(d.brake, t, 0.1);
      p.curve.setTargetAtTime(d.curve, t, 0.3);
      p.enclosed.setTargetAtTime(d.enclosed, t, 0.15);
      p.cockpit.setTargetAtTime(d.cockpit, t, 0.15);
      p.horn.setValueAtTime(d.horn, t);
      p.surface.setValueAtTime(d.surface, t);
      p.emergency.setValueAtTime(d.emergency, t);
    },
    points() { node.port.postMessage({ points: true }); },
    release() { node.port.postMessage({ release: true }); },
    emergency() { node.port.postMessage({ emergency: true }); },
    dispose() { node.disconnect(); },
  };
}

/** If the worklet cannot load: a quiet rolling hiss that rises with speed. */
function buildFallbackVoice(ctx: AudioContext): Voice {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = new AudioBufferSourceNode(ctx, { buffer, loop: true });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 300, Q: 0.5 });
  const gain = new GainNode(ctx, { gain: 0 });
  noise.connect(filter).connect(gain);
  noise.start();
  return {
    output: gain,
    update({ speed }) { gain.gain.setTargetAtTime(Math.min(0.12, speed * 0.003), ctx.currentTime, 0.1); },
    points() {}, release() {}, emergency() {},
    dispose() { noise.stop(); noise.disconnect(); filter.disconnect(); gain.disconnect(); },
  };
}

export function useTrainSound(
  telemetry: RefObject<VehicleTelemetry>, enabled = true, input?: RefObject<RawInput>,
  cameraMode?: RefObject<CameraMode>,
) {
  const mutedRef = useRef(false);
  const hornRef = useRef(false);

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

      const trainVoice = VOICES[SELECTED.id] ?? DEFAULT_VOICE;

      const smooth = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: 0.4 });
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
        console.info(`[train] ${kind} voice for ${SELECTED.id}: ${trainVoice.kind}, ${axleOffsets().length} axles`);
      };
      if (ctx.audioWorklet) {
        ctx.audioWorklet.addModule('/audio/train-processor.js')
          .then(() => attach(buildWorkletVoice(ctx, trainVoice), 'worklet'))
          .catch((error: unknown) => {
            console.warn('[train] worklet failed to load, using fallback voice', error);
            attach(buildFallbackVoice(ctx), 'fallback');
          });
      } else {
        attach(buildFallbackVoice(ctx), 'fallback');
      }

      let lastBrake = 0;
      let lastPoints = -1;
      let lastEmergency = false;
      const tick = () => {
        if (graph !== g) return;
        g.raf = requestAnimationFrame(tick);
        const t = telemetry.current;
        if (!t) return;
        const throttle = input?.current?.throttle ?? 0;
        const brake = Math.max(input?.current?.brake ?? 0, t.railEmergency ? 1 : 0);

        // The brake handle coming off, with the train moving: the release hiss.
        if (lastBrake > 0.5 && brake < 0.5 && t.speedKph > 3) g.voice?.release();
        lastBrake = brake;
        // The plunger going in: the pipe dumps, the rake bunches. Coming off
        // (which it only does at a stand) is a release like any other.
        if (t.railEmergency && !lastEmergency) g.voice?.emergency();
        if (!t.railEmergency && lastEmergency) g.voice?.release();
        lastEmergency = t.railEmergency;

        // The leading axle reaching the points: the countdown was small and
        // has now either jumped to the next set or gone.
        const pts = t.railPoints;
        if (lastPoints >= 0 && lastPoints < 8 && (pts < 0 || pts > lastPoints + 15) && t.speedKph > 3) g.voice?.points();
        lastPoints = pts;

        const arc = t.railArc;
        g.voice?.update({
          speed: t.speedKph / 3.6,
          // The notch. Braking cuts power, as it does on the real thing.
          load: brake > 0.05 ? 0 : clamp(throttle, 0, 1),
          brake,
          curve: curveAt(arc),
          enclosed: clamp(t.enclosed, 0, 1),
          cockpit: cameraMode?.current === 'cab' ? 1 : 0,
          horn: hornRef.current ? 1 : 0,
          surface: surfaceCode(arc),
          emergency: t.railEmergency ? 1 : 0,
        });
        g.master.gain.setTargetAtTime(mutedRef.current ? 0 : MASTER, ctx.currentTime, 0.05);
      };
      g.raf = requestAnimationFrame(tick);
    };

    const onGesture = () => build();
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'KeyK') mutedRef.current = !mutedRef.current;
      // The horn: held, not toggled. A press that repeats is still one hold.
      // N, because H is already the controls panel and the horn kept opening it.
      if (event.code === 'KeyN') hornRef.current = true;
      onGesture();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'KeyN') hornRef.current = false;
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onGesture);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
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
