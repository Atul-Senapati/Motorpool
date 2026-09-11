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
/**
 * The structural accent: one colour, every vehicle.
 *
 * It tints the HUD's chrome — the card's edge, the menu's bands and slash, the
 * key caps, the pause hexagon, the map's ring. It was briefly the selected
 * category's garage colour (red for performance, blue for rail…), which made
 * the same interface look like five interfaces and, worse, let a fast car's red
 * collide with `hot`. One cyan, the same as the readouts, is calmer and reads
 * as one instrument. `accentAlpha` gives it at an alpha for washes and glows.
 */
export const ACCENT = '#4fdbe8';

/** The accent at an alpha, for washes, bands and glows. */
export function accentAlpha(alpha: number): string {
  const hex = ACCENT.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Dark ink to set on top of an accent fill, chosen so it reads on any of the five. */
export const ON_ACCENT = '#08111a';

export const HUD = {
  /** The accent. Every live value is this colour. */
  cyan: '#4fdbe8',
  /**
   * Live information — a distance, a road name, a countdown. The same value as
   * `cyan`, named for what it means: a readout is information regardless of
   * which vehicle's colour the structure around it is wearing. See `ACCENT`.
   */
  info: '#4fdbe8',
  /** Mid zone of a dial — approaching the limit. */
  warm: '#ffd44d',
  /** Redline, and anything that means "at the limit". */
  hot: '#ff2f6e',
  /** Waypoint and navigation, kept distinct from the accent. */
  way: '#ffb020',
  /**
   * Boost, and only boost.
   *
   * A fifth hue is a cost, and this one earns it: the reserve has to be
   * readable at a glance as *not* a live measurement of the car — cyan is every
   * value the car currently has, amber and magenta are the rev range. Violet is
   * the colour a driving game has used for injected thrust since the first
   * nitrous bottle, and it is the one hue on this palette that survives being
   * drawn over both a dusk sky and a lit road without being confused for a
   * warning.
   */
  boost: '#a06bff',

  text: '#ffffff',
  /**
   * Solid cool greys rather than translucent whites. Every readout now sits on
   * a `PANEL`, so the secondary type no longer has to survive an unknown
   * background — it can be a real colour, and a real colour has a real
   * contrast ratio: `muted` is 9:1 on the panel, `faint` 5.5:1.
   */
  muted: '#b9c9da',
  faint: '#7f93a9',
  /** Hairlines: a rule, a dial track, a panel's inner edge. */
  line: 'rgba(255,255,255,0.12)',
} as const;

/**
 * The shadow that replaces the panels.
 *
 * Three layers on purpose: a tight, nearly opaque one that gives the glyph its
 * edge; a close halo that carries the contrast over a bright sky; and a wide
 * soft one that settles it into a dark road. Any one alone fails — the tight
 * shadow vanishes against pale dusk, the wide one turns to mud at night.
 */
export const INK = {} as const;

/**
 * No shadow, no filter. The HUD's third design: contrast comes from `PANEL`
 * under every cluster, and type is set clean on it. The shadow-under-every-
 * glyph approach kept the glass metaphor and paid for it with type that looked
 * smeared over bright scenes and muddy over dark ones. Both tokens are kept as
 * no-ops so a component that spreads them still compiles; new code should not
 * reach for them.
 */
export const INK_FILTER = 'none';

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
export const PANEL = {
  // Darkest where the type is — the left, where every panel starts its text —
  // easing off to the right so the panel never reads as a slab. No blur.
  background: 'linear-gradient(90deg, rgba(3,7,12,0.80) 0%, rgba(3,7,12,0.66) 60%, rgba(3,7,12,0.52) 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10)',
} as const;

/**
 * The panel's shape: a parallelogram — both ends sheared 12 px the same way,
 * so the panels lean forward like every racing game's since Burnout. One cut,
 * everywhere, is the whole visual language.
 */
export const PANEL_CUT = 'polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%)';

/**
 * Labels: the display face (Barlow Condensed), bold, mildly tracked. The old
 * labels were 9–10 px system caps at 0.24em tracking, which is a watermark, not
 * a label. Condensed bold at 13 px covers the same width and can be read.
 */
export const LABEL = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  letterSpacing: '0.12em',
} as const;

/**
 * The livery hatch: a sliver of diagonal accent stripes, closing the end of a
 * panel. One motif, repeated exactly, is what turns separate panels into a set.
 */
export const HATCH = {
  background: `repeating-linear-gradient(-55deg, ${ACCENT} 0 3px, transparent 3px 8px)`,
  opacity: 0.7,
} as const;

/** @deprecated aliases from the second design; both now resolve to the panel. */
export const PLATE = PANEL;

/**
 * The plate's shape: a slant on the right edge, straight everywhere else. The
 * same cut the garage header and the pause menu's active row use. Rounded
 * corners were tried first and turned every cluster into a web card; one
 * shared slant turns them into parts of one instrument.
 */
export const PLATE_CUT = PANEL_CUT;

/**
 * The pause menu's ground.
 *
 * Two layers, and both are there for legibility rather than mood. The dark
 * gradient is what makes white type readable over whatever the scene was doing
 * when you paused — it used to thin to 62% on the right, which over a sunlit
 * road left the inactive rows muddy. The faint accent glow beneath it is the
 * one place the menu says which vehicle it belongs to without saying it in
 * words.
 */
export const SCRIM = {
  background: [
    'linear-gradient(105deg, rgba(3,7,11,0.94) 0%, rgba(4,9,14,0.86) 55%, rgba(4,9,14,0.78) 100%)',
  ].join(','),
  backdropFilter: 'blur(9px)',
} as const;
