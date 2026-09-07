import { Chakra_Petch } from 'next/font/google';

/**
 * The HUD's numeral face, self-hosted.
 *
 * `globals.css` argues for the system stack on the grounds that it costs no
 * build-time fetch and that tabular numerals read better in a UI face than a
 * display one. The first half of that stopped being true when the garage
 * adopted Barlow — the build already fetches fonts — and the second half only
 * holds for small type set in rows. A speedometer is the opposite case: a few
 * very large digits whose job is to be read at a glance and to look like an
 * instrument, which is exactly what a display face is for.
 *
 * Chakra Petch rather than Orbitron, which was the first choice and had to go:
 * its zero is slashed and nearly square, so a speed reading at rest came out as
 * a row of crossed boxes. This one is angular enough to read as a game face and
 * keeps a plain oval zero.
 *
 * Numerals only. Words stay in the UI stack — a display face's caps are wide
 * enough that a label set in one stops being a label and becomes a title.
 */
export const hudNumerals = Chakra_Petch({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
  variable: '--font-hud',
});
