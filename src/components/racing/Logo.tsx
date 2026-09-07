import { useId } from 'react';
import { LOGO_BODY, LOGO_BOX, LOGO_FACE, LOGO_LIT } from './logoPaths';
import { THEME } from './garageTheme';

/**
 * Where the mark is sitting, which is all it needs to know to tone itself.
 *
 * `accent` is the white cut for the header's blue plate; `light` the blue cut
 * for a white ground; `dark` the blue cut for the game's near-black. Same
 * geometry every time — only the six stops change.
 */
export type LogoTone = 'accent' | 'light' | 'dark';

const TONES: Record<LogoTone, {
  faceHi: string; face: string; faceLo: string; bodyHi: string; bodyLo: string; edge: string;
}> = {
  accent: {
    faceHi: '#ffffff', face: '#ffffff', faceLo: '#dde8ff',
    bodyHi: THEME.accentLo, bodyLo: '#082a8c', edge: '#ffffff',
  },
  light: {
    faceHi: '#5f9bff', face: THEME.accent, faceLo: THEME.accentLo,
    bodyHi: THEME.accentLo, bodyLo: '#06216b', edge: '#d6e5ff',
  },
  dark: {
    faceHi: '#8fbcff', face: '#3d86ff', faceLo: THEME.accent,
    bodyHi: '#0e3ba6', bodyLo: '#061c56', edge: '#e6f0ff',
  },
};

/**
 * The Motorpool mark: an extruded, italic M.
 *
 * Geometry comes from `logoPaths.ts`, which `scripts/make-logo.mjs` writes
 * alongside the favicon and the link preview — so the mark in the header and
 * the mark in the browser tab are the same solid, and stay that way. Edit the
 * script, not this file, to change the letterform.
 *
 * Sized by height, since it is always set against a line of type.
 */
export function Logo({ height = 30, tone = 'accent', className }: {
  height?: number;
  tone?: LogoTone;
  className?: string;
}) {
  // Gradient ids must be unique per instance: two marks on one page with the
  // same ids means the second silently paints with the first's stops.
  const id = useId().replace(/:/g, '');
  const palette = TONES[tone];

  return (
    <svg
      className={className}
      height={height}
      width={(height * LOGO_BOX.w) / LOGO_BOX.h}
      viewBox={`${LOGO_BOX.x} ${LOGO_BOX.y} ${LOGO_BOX.w} ${LOGO_BOX.h}`}
      role="img"
      aria-label="Motorpool"
    >
      <defs>
        <linearGradient
          id={`${id}-face`} x1={LOGO_BOX.x} y1={LOGO_BOX.y} x2={LOGO_BOX.x} y2={LOGO_BOX.y + LOGO_BOX.h}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor={palette.faceHi} />
          <stop offset="0.55" stopColor={palette.face} />
          <stop offset="1" stopColor={palette.faceLo} />
        </linearGradient>
        <linearGradient
          id={`${id}-body`} x1={LOGO_BOX.x} y1={LOGO_BOX.y} x2={LOGO_BOX.x} y2={LOGO_BOX.y + LOGO_BOX.h}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor={palette.bodyHi} />
          <stop offset="1" stopColor={palette.bodyLo} />
        </linearGradient>
        {/* The highlight is stroked, so half its width would spill past the
            silhouette and fatten the letter; the clip keeps it inside. */}
        <clipPath id={`${id}-clip`}><path d={LOGO_FACE} /></clipPath>
      </defs>

      <path d={LOGO_BODY} fill={`url(#${id}-body)`} />
      <path d={LOGO_FACE} fill={`url(#${id}-face)`} />
      <g clipPath={`url(#${id}-clip)`}>
        <path d={LOGO_LIT} fill="none" stroke={palette.edge} strokeWidth={10} />
      </g>
    </svg>
  );
}
