/**
 * Light studio, one accent.
 *
 * Bright rather than dark, because a car studio is white: the paint is lit by
 * what it reflects, and a dark room gives it nothing. Everything that is not a
 * neutral is the same electric blue — the wordmark plate, the tabs, the bars,
 * the shield, the button, the turntable ring, the frame around the chosen
 * picture. One accent reads as designed; four read as a dashboard. Blue on
 * white is also the configurator language every premium marque speaks.
 */
export const THEME = {
  accent: '#1157ff',
  /** Lit stop for gradients, so a surface reads as lit from above. */
  accentHi: '#4d8dff',
  /** The extruded edge under a raised control. */
  accentLo: '#0b3fc4',
  /** Page ground: warm white, never grey. */
  ink: '#f4f6fa',
  /** Card surfaces. */
  panel: '#ffffff',
  panelHi: '#ffffff',
  line: 'rgba(11,18,32,0.10)',
  /** Type: deep navy, not black — black on white is harsh at display sizes. */
  text: '#0b1220',
  muted: '#5a6b85',
} as const;

/** A raised white card: soft lift, hairline edge, faint warm top highlight. */
export const RAISED = {
  background: 'linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%)',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,1), 0 1px 0 rgba(11,18,32,0.06), 0 12px 30px rgba(11,18,32,0.14), 0 2px 6px rgba(11,18,32,0.08)',
  border: '1px solid rgba(11,18,32,0.08)',
} as const;

/** Display face for names and numerals; the UI face for everything else. */
export const DISPLAY = { fontFamily: 'var(--font-display)' } as const;
