import { Barlow, Barlow_Condensed } from 'next/font/google';

/**
 * The garage's typefaces, self-hosted.
 *
 * `next/font` downloads the files once at build time and serves them from the
 * app's own origin, so the running page makes no request to Google — which is
 * the principle the rest of the project keeps (procedural textures, procedural
 * environment map, vendored Draco decoder). The cost is a build-time fetch; the
 * HUD keeps the system stack, which `globals.css` chose for its numerals.
 *
 * Barlow is a motorsport face — the condensed cut carries the vehicle names and
 * the big numerals, the text cut everything else, and being one family they sit
 * together without a seam.
 */
export const barlow = Barlow({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-ui',
});

export const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-display',
});
