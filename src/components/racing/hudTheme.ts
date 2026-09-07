/**
 * In-car HUD: no panels, no plates — marks on glass.
 *
 * Deliberately not the garage's palette or its materials. The garage is a lit
 * white showroom whose controls are solid raised plastic; the HUD is a
 * projection on a windscreen, and the way it stays out of the way is to own no
 * pixels at all. Nothing here has a background.
 *
 * An earlier version blurred and tinted a panel behind every cluster. That is
 * the safe way to guarantee contrast, and it looked like software laid on top
 * of the game rather than part of the car. With the panels gone, contrast is
 * carried entirely by `INK` — a tight dark shadow under every glyph, which is
 * how real head-up displays stay legible against both a night road and a
 * bright sky, and which costs no rectangle.
 *
 * Cyan rather than the garage's blue because the accent must survive being
 * drawn over blue-grey dusk and orange sodium light. `#1157ff` disappears into
 * the former; a light cyan separates from both.
 */
export const HUD = {
  /** The accent. Every live value is this colour. */
  cyan: '#4fdbe8',
  /** Mid zone of a dial — approaching the limit. */
  warm: '#ffd44d',
  /** Redline, and anything that means "at the limit". */
  hot: '#ff2f6e',
  /** Waypoint and navigation, kept distinct from the accent. */
  way: '#ffb020',

  text: 'rgba(255,255,255,0.96)',
  /**
   * Both of these sit higher than they would behind a panel. With nothing
   * underneath, small grey type over a pale dusk sky is the first thing to
   * disappear — measured against the game's own brightest sky, not a mockup.
   */
  muted: 'rgba(255,255,255,0.80)',
  faint: 'rgba(255,255,255,0.56)',
  /** The one hairline still allowed: a rule or a dial track, never a border. */
  line: 'rgba(255,255,255,0.16)',
} as const;

/**
 * The shadow that replaces the panels.
 *
 * Three layers on purpose: a tight, nearly opaque one that gives the glyph its
 * edge; a close halo that carries the contrast over a bright sky; and a wide
 * soft one that settles it into a dark road. Any one alone fails — the tight
 * shadow vanishes against pale dusk, the wide one turns to mud at night.
 */
export const INK = {
  textShadow:
    '0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85), 0 0 18px rgba(0,0,0,0.55)',
} as const;

/** The same trick for strokes and shapes, which take no text-shadow. */
export const INK_FILTER = 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))';

/** Numerals: the display face, tabular so a reading never shuffles sideways. */
export const NUM = {
  fontFamily: 'var(--font-hud)',
  fontVariantNumeric: 'tabular-nums',
} as const;

/**
 * A translucent black plate, behind one cluster.
 *
 * A reversal of this file's own no-backgrounds rule, and a deliberate one. Ink
 * alone carries a glyph over a bright sky, but it cannot lift a whole cluster
 * off a sunlit road — the name plate and the trip figures were legible rather
 * than comfortable.
 *
 * Plain black at low opacity: no blur, no border, no gradient. Not frosted
 * glass, which this HUD has already rejected once, and not a screen-corner
 * vignette either — that darkens the game to light the interface, which is the
 * wrong way round. Each plate is only as big as the thing it sits behind.
 */
export const PLATE = {
  background: 'rgba(0,0,0,0.36)',
} as const;

/**
 * The plate's shape: a slant on the right edge, straight everywhere else. The
 * same cut the garage header and the pause menu's active row use. Rounded
 * corners were tried first and turned every cluster into a web card; one
 * shared slant turns them into parts of one instrument.
 */
export const PLATE_CUT = 'polygon(0 0, 100% 0, calc(100% - 14px) 100%, 0 100%)';
