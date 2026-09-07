'use client';

import { useProgress } from '@react-three/drei';
import { SELECTED } from '@/config/garage';
import { Logo } from './Logo';

/**
 * Full-bleed loading curtain. Rendered as DOM rather than inside the Canvas so
 * it covers the first frames while the GLB decodes and the shaders compile.
 */
export function LoadingOverlay() {
  const { active, progress } = useProgress();

  return (
    <div
      className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#0b0d10] transition-opacity duration-700 ${
        active ? 'opacity-100' : 'opacity-0'
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
          style={{ width: `${Math.round(progress)}%` }}
        />
      </div>
      <div className="mt-4 text-[10px] tabular-nums tracking-[0.3em] text-white/40">
        {Math.round(progress)}%
      </div>
    </div>
  );
}
