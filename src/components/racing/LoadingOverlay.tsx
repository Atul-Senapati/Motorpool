'use client';

import { useProgress } from '@react-three/drei';
import { SELECTED } from '@/config/garage';
import { Logo } from './Logo';

/**
 * Full-bleed loading curtain. Rendered as DOM rather than inside the Canvas so
 * it covers the first frames while the GLB decodes and the shaders compile.
 *
 * It used to lift on drei's `useProgress().active` alone, and that was wrong in
 * both directions. `active` is false until the first loader *starts*, so the
 * curtain was measured going away **1.2 seconds** in — before a single model
 * had arrived — dropping the player into an empty world. And it goes true again
 * the moment the last byte lands, which is well before the scene can be drawn:
 * on that same measurement all 114 of the scene's shader programs were compiled
 * *after* the curtain had gone. `ready` is the honest signal, and it comes from
 * `Warmup` inside the canvas.
 */
export function LoadingOverlay({ ready = false }: {
  /** True once models are loaded *and* the scene has been compiled and warmed. */
  ready?: boolean;
}) {
  const { active, progress } = useProgress();
  // Downloading is most of the wait but not all of it, so the bar is scaled to
  // leave the last tenth for the compile — a bar that sits at 100% while the
  // machine is visibly still working is how you get "it's frozen".
  const shown = active || progress < 100 ? progress * 0.9 : 90;

  return (
    <div
      className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#0b0d10] transition-opacity duration-700 ${
        ready ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {/* The mark carries the wait; the vehicle name says what is arriving. */}
      <Logo height={54} tone="dark" className="mb-7 opacity-95" />
      <div className="text-[11px] font-medium tracking-[0.4em] text-white/80">
        {SELECTED.label.toUpperCase()}
      </div>
      <div className="mt-6 h-px w-56 overflow-hidden bg-white/15">
        <div
          className="h-full bg-white/85 transition-[width] duration-200"
          style={{ width: `${ready ? 100 : Math.round(shown)}%` }}
        />
      </div>
      <div className="mt-4 text-[10px] tabular-nums tracking-[0.3em] text-white/40">
        {shown >= 90 && !ready ? 'PREPARING' : `${Math.round(shown)}%`}
      </div>
    </div>
  );
}
